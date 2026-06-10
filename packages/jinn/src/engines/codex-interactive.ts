import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import * as pty from "node-pty";
import type { InterruptibleEngine, EngineRunOpts, EngineResult, StreamDelta } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { JINN_HOME } from "../shared/paths.js";
import { resolveBin } from "../shared/resolve-bin.js";
import { neutralizeForPaste } from "../shared/skill-commands.js";
import { PtyLifecycleManager, type PtyHandle } from "./pty-lifecycle.js";
import type { PtyControlEvent, PtyIdleSpawnOpts, PtyViewEngine } from "./pty-view-engine.js";
import { codexCliFlags, extractCodexContextTokens } from "./codex.js";

const SCROLLBACK_CAP_BYTES = 262144;
const CODEX_SESSIONS_DIR = path.join(os.homedir(), ".codex", "sessions");
const TURN_TIMEOUT_MS = 10 * 60 * 1000;
// FALLBACK ONLY: task_complete (below) is the primary completion signal; this
// quiet-window debounce settles turns whose transcript misses the marker.
const DONE_DEBOUNCE_MS = 3000;
const DISCOVER_POLL_MS = 200;
const DISCOVER_TIMEOUT_MS = 30 * 1000;

interface TranscriptTailer { stop(): void }

interface StreamEntry {
  chunks: Buffer[];
  totalBytes: number;
  subscribers: Set<{ data: (d: Buffer) => void; control?: (e: PtyControlEvent) => void }>;
  hasSeenPty: boolean;
}

interface ActiveTurn {
  interrupt: (reason: string) => void;
  tailer?: TranscriptTailer;
  discover?: { stop: () => void };
  doneTimer?: NodeJS.Timeout;
  hardTimeout?: NodeJS.Timeout;
  boundProc?: pty.IPty;
}

function pasteAndSubmit(proc: pty.IPty, text: string): void {
  const payload = neutralizeForPaste(text);
  proc.write(`\x1b[200~${payload}\x1b[201~\r`);
}

function walkJsonl(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJsonl(p, out);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

function listTranscriptFiles(root = CODEX_SESSIONS_DIR): Map<string, number> {
  const files = new Map<string, number>();
  for (const file of walkJsonl(root)) {
    try { files.set(file, fs.statSync(file).mtimeMs); } catch { /* gone */ }
  }
  return files;
}

function parseSessionIdFromFile(filePath: string): string | undefined {
  try {
    const first = fs.readFileSync(filePath, "utf-8").split("\n", 1)[0];
    const msg = JSON.parse(first);
    const id = msg?.payload?.id;
    return typeof id === "string" && id ? id : undefined;
  } catch {
    return undefined;
  }
}

export function codexTranscriptLineToDeltas(line: string): {
  deltas: StreamDelta[];
  doneText?: string;
  sessionId?: string;
  contextTokens?: number;
  /** event_msg task_complete — the turn's deterministic end marker. */
  taskComplete?: { lastAgentMessage?: string };
  /** event_msg turn_aborted — the turn was interrupted CLI-side. */
  turnAborted?: boolean;
} {
  const trimmed = line.trim();
  if (!trimmed) return { deltas: [] };
  let msg: any;
  try { msg = JSON.parse(trimmed); } catch { return { deltas: [] }; }

  if (msg.type === "session_meta") {
    const id = msg?.payload?.id;
    return { deltas: [], sessionId: typeof id === "string" ? id : undefined };
  }

  if (msg.type === "event_msg" && msg?.payload?.type === "token_count") {
    // Context-meter fill = the LAST turn's input tokens (≈ the whole conversation
    // fed back to the model). NEVER fall back to total_token_usage: that's the
    // cumulative tokens billed across every turn, so on a long session it climbs
    // far past the window and renders impossible meter values like 9282k/272k.
    // When last_token_usage is absent we simply omit the update rather than show
    // a cumulative figure.
    const ctx = extractCodexContextTokens(msg.payload.info?.last_token_usage);
    return ctx ? { deltas: [{ type: "context", content: String(ctx) }], contextTokens: ctx } : { deltas: [] };
  }

  if (msg.type === "event_msg" && msg?.payload?.type === "task_complete") {
    const lam = msg.payload.last_agent_message;
    return { deltas: [], taskComplete: { lastAgentMessage: typeof lam === "string" ? lam : undefined } };
  }

  if (msg.type === "event_msg" && msg?.payload?.type === "turn_aborted") {
    return { deltas: [], turnAborted: true };
  }

  if (msg.type !== "response_item") return { deltas: [] };
  const payload = msg.payload;
  if (!payload || typeof payload !== "object") return { deltas: [] };

  if (payload.type === "function_call") {
    const name = String(payload.name || "tool");
    return {
      deltas: [{
        type: "tool_use",
        content: `Using ${name}`,
        toolName: name,
        toolId: String(payload.call_id || ""),
      }],
    };
  }

  if (payload.type === "function_call_output") {
    return {
      deltas: [{
        type: "tool_result",
        content: "Done",
        toolId: String(payload.call_id || ""),
      }],
    };
  }

  if (payload.type === "message" && payload.role === "assistant" && Array.isArray(payload.content)) {
    const text = payload.content
      .filter((b: any) => b?.type === "output_text" && typeof b.text === "string")
      .map((b: any) => b.text)
      .join("");
    if (text.trim()) return { deltas: [{ type: "text", content: text }], doneText: text };
  }

  return { deltas: [] };
}

function tailTranscript(
  filePath: string,
  startOffset: number,
  onLine: (parsed: ReturnType<typeof codexTranscriptLineToDeltas>) => void,
): TranscriptTailer {
  let offset = startOffset;
  let buf = "";
  let stopped = false;
  let fh: fsp.FileHandle | undefined;
  let reading = false;

  const readNew = async (): Promise<void> => {
    if (stopped || reading) return;
    reading = true;
    try {
      let stat: fs.Stats;
      try { stat = await fsp.stat(filePath); } catch { return; }
      if (stat.size <= offset) return;
      if (!fh) {
        try { fh = await fsp.open(filePath, "r"); } catch { return; }
      }
      const chunk = Buffer.alloc(stat.size - offset);
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, offset);
      offset += bytesRead;
      buf += chunk.subarray(0, bytesRead).toString("utf-8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) onLine(codexTranscriptLineToDeltas(line));
    } catch (err) {
      logger.warn(`Codex transcript tail failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
      try { await fh?.close(); } catch { /* ignore */ }
      fh = undefined;
    } finally {
      reading = false;
    }
  };

  let watcher: fs.FSWatcher | undefined;
  try { watcher = fs.watch(filePath, () => { void readNew(); }); } catch { /* file may not exist yet */ }
  const poll = setInterval(() => { void readNew(); }, 250);
  poll.unref?.();
  const initialDrain = setTimeout(() => { void readNew(); }, 30);
  initialDrain.unref?.();

  return {
    stop() {
      stopped = true;
      watcher?.close();
      clearInterval(poll);
      clearTimeout(initialDrain);
      void fh?.close().catch(() => {});
      fh = undefined;
    },
  };
}

export class CodexInteractiveEngine implements InterruptibleEngine, PtyViewEngine {
  name = "codex" as const;
  private active = new Map<string, ActiveTurn>();
  private streams = new Map<string, StreamEntry>();
  private lastGeom = new Map<string, { cols: number; rows: number }>();
  private spawnParams = new Map<string, { model?: string; effortLevel?: string }>();

  constructor(private lifecycle: PtyLifecycleManager) {}

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    const jinnSessionId = opts.sessionId;
    if (!jinnSessionId) throw new Error("CodexInteractiveEngine.run requires opts.sessionId");
    if (this.active.has(jinnSessionId)) {
      return { sessionId: opts.resumeSessionId ?? "", result: "", error: "Codex interactive engine: a turn is already running for this session" };
    }

    let prompt = opts.prompt;
    if (opts.systemPrompt && !opts.resumeSessionId) prompt = `${opts.systemPrompt}\n\n---\n\n${prompt}`;
    if (opts.attachments?.length) prompt += "\n\nAttached files:\n" + opts.attachments.map((a) => `- ${a}`).join("\n");

    let codexSessionId = opts.resumeSessionId;
    let latestAnswer = "";
    let lastContextTokens: number | undefined;
    let settled = false;
    let resolveFn!: (r: EngineResult) => void;
    const promise = new Promise<EngineResult>((res) => { resolveFn = res; });
    const turn: ActiveTurn = { interrupt: () => {} };

    const cleanup = () => {
      if (turn.doneTimer) clearTimeout(turn.doneTimer);
      if (turn.hardTimeout) clearTimeout(turn.hardTimeout);
      turn.tailer?.stop();
      turn.discover?.stop();
      this.active.delete(jinnSessionId);
      this.lifecycle.turnEnded(jinnSessionId);
    };
    const finish = (r: EngineResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveFn(r);
    };
    turn.interrupt = (reason: string) =>
      finish({ sessionId: codexSessionId ?? opts.resumeSessionId ?? "", result: latestAnswer, error: reason });

    const onParsed = (parsed: ReturnType<typeof codexTranscriptLineToDeltas>) => {
      if (parsed.sessionId && !codexSessionId) codexSessionId = parsed.sessionId;
      if (parsed.contextTokens) lastContextTokens = parsed.contextTokens;
      for (const d of parsed.deltas) opts.onStream?.(d);
      if (parsed.taskComplete) {
        // Deterministic end-of-turn marker — settle now (no quiet window).
        const text = parsed.taskComplete.lastAgentMessage?.trim()
          ? parsed.taskComplete.lastAgentMessage
          : latestAnswer;
        finish({ sessionId: codexSessionId ?? "", result: text, numTurns: 1, contextTokens: lastContextTokens });
        return;
      }
      if (parsed.turnAborted) {
        finish({ sessionId: codexSessionId ?? opts.resumeSessionId ?? "", result: latestAnswer, error: "Interrupted: codex turn aborted" });
        return;
      }
      if (parsed.doneText) {
        latestAnswer = parsed.doneText;
        if (turn.doneTimer) clearTimeout(turn.doneTimer);
        turn.doneTimer = setTimeout(
          () => finish({ sessionId: codexSessionId ?? "", result: latestAnswer, numTurns: 1, contextTokens: lastContextTokens }),
          DONE_DEBOUNCE_MS,
        );
        turn.doneTimer.unref?.();
      }
    };

    const attachTail = (filePath: string, fromBeginning = false) => {
      if (turn.tailer) return;
      codexSessionId ||= parseSessionIdFromFile(filePath);
      let offset = 0;
      if (!fromBeginning) {
        try { offset = fs.statSync(filePath).size; } catch { /* not created yet */ }
      }
      turn.tailer = tailTranscript(filePath, offset, onParsed);
    };

    this.active.set(jinnSessionId, turn);
    turn.hardTimeout = setTimeout(() => {
      finish(
        latestAnswer
          ? { sessionId: codexSessionId ?? "", result: latestAnswer, numTurns: 1, contextTokens: lastContextTokens }
          : { sessionId: codexSessionId ?? opts.resumeSessionId ?? "", result: "", error: "Codex interactive turn timed out" },
      );
    }, TURN_TIMEOUT_MS);
    turn.hardTimeout.unref?.();

    let warm = this.lifecycle.getWarm(jinnSessionId);
    if (warm && this.spawnParamsChanged(jinnSessionId, opts)) {
      this.lifecycle.releaseSession(jinnSessionId);
      this.spawnParams.delete(jinnSessionId);
      warm = undefined;
    }
    if (codexSessionId) {
      const file = this.findTranscriptById(codexSessionId);
      if (file) attachTail(file);
    } else {
      const before = listTranscriptFiles();
      const startedAt = Date.now();
      const discover = setInterval(() => {
        const after = listTranscriptFiles();
        const fresh = [...after.entries()]
          .filter(([file, mtime]) => !before.has(file) || mtime > (before.get(file) ?? 0))
          .sort((a, b) => b[1] - a[1]);
        if (fresh.length > 0) {
          clearInterval(discover);
          attachTail(fresh[0][0], true);
        } else if (Date.now() - startedAt > DISCOVER_TIMEOUT_MS) {
          clearInterval(discover);
          finish({ sessionId: "", result: "", error: "Codex interactive: no session transcript appeared" });
        }
      }, DISCOVER_POLL_MS);
      discover.unref?.();
      turn.discover = { stop: () => clearInterval(discover) };
    }

    if (warm) {
      turn.boundProc = (warm as any)._proc as pty.IPty | undefined;
      this.lifecycle.turnStarted(jinnSessionId);
      if (turn.boundProc) pasteAndSubmit(turn.boundProc, prompt);
      else turn.interrupt("Interrupted: codex PTY unavailable");
    } else {
      const handle = this.spawn(jinnSessionId, opts, prompt, codexSessionId);
      turn.boundProc = (handle as any)._proc as pty.IPty | undefined;
      this.lifecycle.adopt(jinnSessionId, handle);
      this.lifecycle.turnStarted(jinnSessionId);
    }

    return promise;
  }

  private findTranscriptById(sessionId: string): string | undefined {
    for (const file of walkJsonl(CODEX_SESSIONS_DIR)) {
      if (parseSessionIdFromFile(file) === sessionId) return file;
    }
    return undefined;
  }

  private buildEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) continue;
      if (v !== undefined) env[k] = v;
    }
    env.TERM = "xterm-256color";
    return env;
  }

  private buildArgs(opts: EngineRunOpts, prompt?: string, resumeSessionId?: string): string[] {
    const args: string[] = [];
    if (resumeSessionId) args.push("resume");
    args.push("--no-alt-screen", "--dangerously-bypass-approvals-and-sandbox");
    if (opts.model) args.push("--model", opts.model);
    if (opts.effortLevel && opts.effortLevel !== "default") args.push("-c", `model_reasoning_effort="${opts.effortLevel}"`);
    if (opts.cwd) args.push("-C", opts.cwd);
    args.push(...codexCliFlags(opts.cliFlags));
    if (resumeSessionId) args.push(resumeSessionId);
    if (prompt) args.push(prompt);
    return args;
  }

  private spawnParamsChanged(jinnSessionId: string, opts: EngineRunOpts): boolean {
    const prev = this.spawnParams.get(jinnSessionId);
    if (!prev) return false;
    const norm = (v: string | undefined) => v && v !== "default" ? v : undefined;
    return norm(prev.model) !== norm(opts.model) || norm(prev.effortLevel) !== norm(opts.effortLevel);
  }

  private spawn(jinnSessionId: string, opts: EngineRunOpts, prompt: string | undefined, resumeSessionId: string | undefined): PtyHandle {
    const bin = resolveBin("codex", opts.bin);
    const args = this.buildArgs(opts, prompt, resumeSessionId);
    const geom = this.lastGeom.get(jinnSessionId);
    logger.info(`CodexInteractiveEngine spawning ${bin} (resume: ${resumeSessionId || "none"}, geom: ${geom ? `${geom.cols}x${geom.rows}` : "default"})`);
    const proc = pty.spawn(bin, args, {
      name: "xterm-256color",
      cols: geom?.cols ?? 120,
      rows: geom?.rows ?? 40,
      cwd: opts.cwd || JINN_HOME,
      env: this.buildEnv(),
    });
    this.spawnParams.set(jinnSessionId, { model: opts.model, effortLevel: opts.effortLevel });
    return this.wireProcToStream(jinnSessionId, proc);
  }

  private streamFor(sessionId: string): StreamEntry {
    let stream = this.streams.get(sessionId);
    if (!stream) {
      stream = { chunks: [], totalBytes: 0, subscribers: new Set(), hasSeenPty: false };
      this.streams.set(sessionId, stream);
    }
    return stream;
  }

  private wireProcToStream(jinnSessionId: string, proc: pty.IPty): PtyHandle {
    const handle = {
      pid: proc.pid,
      get killed() { return (proc as any)._exitCode != null; },
      kill: (signal?: string) => { try { proc.kill(signal); } catch { /* gone */ } },
    } as PtyHandle;
    const stream = this.streamFor(jinnSessionId);
    if (!stream.hasSeenPty) stream.hasSeenPty = true;
    else if (stream.subscribers.size > 0) {
      for (const sub of stream.subscribers) {
        try { sub.control?.({ type: "reset" }); } catch { /* ignore */ }
      }
    }
    (proc as any).on?.("error", (err: Error) => logger.warn(`Codex PTY socket error for session ${jinnSessionId}: ${err.message}`));
    proc.onData((d) => {
      const chunk = Buffer.from(d, "utf-8");
      stream.chunks.push(chunk);
      stream.totalBytes += chunk.length;
      while (stream.totalBytes > SCROLLBACK_CAP_BYTES && stream.chunks.length > 1) {
        const head = stream.chunks.shift()!;
        stream.totalBytes -= head.length;
      }
      if (stream.totalBytes > SCROLLBACK_CAP_BYTES && stream.chunks.length === 1) {
        const only = stream.chunks[0]!;
        stream.chunks[0] = only.subarray(only.length - SCROLLBACK_CAP_BYTES);
        stream.totalBytes = stream.chunks[0]!.length;
      }
      for (const sub of stream.subscribers) {
        try { sub.data(chunk); } catch { /* ignore */ }
      }
    });
    proc.onExit(() => {
      const isCurrent = this.lifecycle.getWarm(jinnSessionId) === handle;
      if (isCurrent) {
        const s = this.streams.get(jinnSessionId);
        if (s) {
          s.chunks = [];
          s.totalBytes = 0;
          if (s.subscribers.size === 0) this.streams.delete(jinnSessionId);
        }
        this.lifecycle.releaseSession(jinnSessionId);
        this.spawnParams.delete(jinnSessionId);
      }
      const e = this.active.get(jinnSessionId);
      if (e && e.boundProc === proc) e.interrupt("Interrupted: codex process exited");
    });
    (handle as any)._proc = proc;
    return handle;
  }

  ensureIdleSpawn(jinnSessionId: string, opts: PtyIdleSpawnOpts): void {
    if (this.active.has(jinnSessionId)) return;
    if (opts.cols && opts.rows) this.lastGeom.set(jinnSessionId, { cols: opts.cols, rows: opts.rows });
    const warm = this.lifecycle.getWarm(jinnSessionId);
    const nextOpts: EngineRunOpts = {
      prompt: "",
      sessionId: jinnSessionId,
      resumeSessionId: opts.engineSessionId,
      cwd: opts.cwd || JINN_HOME,
      model: opts.model,
      effortLevel: opts.effortLevel,
      bin: opts.bin,
    };
    if (warm && !this.spawnParamsChanged(jinnSessionId, nextOpts)) return;
    if (warm) this.lifecycle.releaseSession(jinnSessionId);
    const handle = this.spawn(jinnSessionId, {
      ...nextOpts,
    }, undefined, opts.engineSessionId);
    this.lifecycle.adopt(jinnSessionId, handle);
  }

  getScrollback(sessionId: string): Buffer {
    const s = this.streams.get(sessionId);
    if (!s || s.chunks.length === 0) return Buffer.alloc(0);
    return Buffer.concat(s.chunks, s.totalBytes);
  }

  subscribeOutput(sessionId: string, cb: (data: Buffer) => void, onControl?: (event: PtyControlEvent) => void): () => void {
    const stream = this.streamFor(sessionId);
    const sub = { data: cb, control: onControl };
    stream.subscribers.add(sub);
    return () => {
      stream.subscribers.delete(sub);
      if (stream.subscribers.size === 0 && !this.lifecycle.getWarm(sessionId)) this.streams.delete(sessionId);
    };
  }

  writeStdin(sessionId: string, text: string): void {
    const proc = (this.lifecycle.getWarm(sessionId) as any)?._proc as pty.IPty | undefined;
    if (proc) pasteAndSubmit(proc, text);
  }

  writeRaw(sessionId: string, data: string): void {
    const proc = (this.lifecycle.getWarm(sessionId) as any)?._proc as pty.IPty | undefined;
    if (proc) proc.write(data);
  }

  resizePty(sessionId: string, cols: number, rows: number): void {
    this.lastGeom.set(sessionId, { cols, rows });
    const proc = (this.lifecycle.getWarm(sessionId) as any)?._proc as pty.IPty | undefined;
    try { proc?.resize(cols, rows); } catch { /* gone */ }
  }

  setViewing(sessionId: string, viewing: boolean): void {
    if (viewing) this.lifecycle.viewerEnter(sessionId);
    else this.lifecycle.viewerLeave(sessionId);
  }

  hasWarmPty(sessionId: string): boolean {
    return this.lifecycle.getWarm(sessionId) !== undefined;
  }

  isTurnRunning(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  kill(sessionId: string, reason = "Interrupted"): void {
    this.active.get(sessionId)?.interrupt(reason.startsWith("Interrupted") ? reason : `Interrupted: ${reason}`);
    this.lifecycle.releaseSession(sessionId);
  }

  killAll(): void {
    for (const id of [...this.active.keys()]) this.kill(id, "Interrupted: gateway shutting down");
    this.lifecycle.killAll();
  }

  isAlive(sessionId: string): boolean {
    return this.active.has(sessionId) || this.lifecycle.getWarm(sessionId) !== undefined;
  }
}
