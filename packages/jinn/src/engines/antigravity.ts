import fs from "node:fs";
import fsp from "node:fs/promises";
import * as pty from "node-pty";
import type { InterruptibleEngine, EngineRunOpts, EngineResult, StreamDelta } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { JINN_HOME } from "../shared/paths.js";
import { resolveBin } from "../shared/resolve-bin.js";
import { PtyLifecycleManager, type PtyHandle } from "./pty-lifecycle.js";
import type { PtyControlEvent, PtyViewEngine, PtyIdleSpawnOpts } from "./pty-view-engine.js";
import {
  transcriptPathFor,
  transcriptLineToDeltas,
  estimateContextTokens,
  ensureWorkspaceTrusted,
  listConvDirs,
} from "./antigravity-protocol.js";
import { neutralizeForPaste } from "../shared/skill-commands.js";

/**
 * Antigravity (`agy`) engine — PTY-interactive, modeled on InteractiveClaudeEngine.
 *
 * Why interactive-only: `agy` has no working headless/`--print` mode, so every
 * turn is driven through a real PTY (the same instance also backs the dashboard
 * xterm view). `agy` has no hook system either, so unlike the Claude engine we
 * detect turn boundaries by tailing agy's own per-conversation transcript:
 *   ~/.gemini/antigravity-cli/brain/<convId>/.system_generated/logs/transcript.jsonl
 * A turn completes when a new MODEL/PLANNER_RESPONSE/status:DONE line appears.
 *
 * Auth: `agy` reuses its cached Google credential (Keychain + on-disk token) on
 * a headless spawn — no re-auth prompt. Workspace trust is pre-seeded before
 * spawn so the interactive "trust this folder?" gate never blocks us.
 */

const SCROLLBACK_CAP_BYTES = 262144;
/** agy ignores model selection flags today (no `--model` / settings effect), so this
 *  is informational/forward-looking; selection is deferred to /model injection. */
export const ANTIGRAVITY_DEFAULT_MODEL = "gemini-3-flash-preview";
const TURN_TIMEOUT_MS = 5 * 60 * 1000; // matches agy's --print-timeout default
const DONE_DEBOUNCE_MS = 1200;         // collapse multi-step planning to the final DONE
const CONV_DISCOVER_TIMEOUT_MS = 30 * 1000;
const CONV_POLL_MS = 150;
/** Accepted by agy without a startup error (verified); harmless in chat mode,
 *  bypasses approvals in agent mode. */
const SKIP_PERMISSIONS_FLAG = "--dangerously-skip-permissions";

interface TranscriptTailer { stop(): void; }

/** Bracketed-paste `text` into the agy PTY and submit. The paste markers and the
 *  submit CR MUST go in a single write — empirically, sending the CR as a separate
 *  delayed write through node-pty is dropped and agy never submits the turn.
 *  neutralizeForPaste() prepends a space for mentions, bash-mode, and jinn-skill
 *  slash commands, while letting engine-native /commands pass through raw.
 *  Shared by injectPromptToProc() and writeStdin(). */
function pasteAndSubmit(proc: pty.IPty, text: string): void {
  const payload = neutralizeForPaste(text);
  proc.write(`\x1b[200~${payload}\x1b[201~\r`);
}

/**
 * Tail a transcript JSONL from `startOffset`, emitting StreamDeltas for appended
 * lines and invoking onDone(content) for each new MODEL/PLANNER_RESPONSE/DONE.
 * Starting at the file's current EOF means a resumed conversation's history is
 * NOT replayed as fresh deltas.
 */
function tailTranscript(
  filePath: string,
  startOffset: number,
  onDelta: (d: StreamDelta) => void,
  onDone: (content: string) => void,
): TranscriptTailer {
  let offset = startOffset;
  let buf = "";
  let stopped = false;
  let fh: fsp.FileHandle | undefined;
  let reading = false;
  let pending = false;

  const processLine = (line: string) => {
    const deltas = transcriptLineToDeltas(line);
    for (const d of deltas) onDelta(d);
    // A model-DONE line yields exactly one text delta; treat that as turn output.
    if (deltas.length && deltas[0].type === "text") onDone(deltas[0].content);
  };

  const readNew = async (): Promise<void> => {
    if (stopped) return;
    if (reading) { pending = true; return; }
    reading = true;
    try {
      do {
        pending = false;
        let stat: fs.Stats;
        try { stat = await fsp.stat(filePath); } catch { return; }
        if (stat.size <= offset) return;
        if (!fh) {
          try { fh = await fsp.open(filePath, "r"); } catch { return; }
        }
        if (stopped) return;
        const size = stat.size - offset;
        const chunk = Buffer.alloc(size);
        let bytesRead: number;
        try {
          ({ bytesRead } = await fh.read(chunk, 0, size, offset));
        } catch (err) {
          try { await fh.close(); } catch { /* gone */ }
          fh = undefined;
          logger.warn(`antigravity tailTranscript read failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        offset += bytesRead;
        buf += chunk.subarray(0, bytesRead).toString("utf-8");
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const l of lines) processLine(l);
      } while (pending && !stopped);
    } finally {
      reading = false;
    }
  };

  let watcher: fs.FSWatcher | undefined;
  try { watcher = fs.watch(filePath, () => { void readNew(); }); } catch { /* file may not exist yet */ }
  // Poll fallback: fs.watch on freshly-created files can miss the first appends,
  // and the file often doesn't exist when we attach. Cheap interval until stopped.
  const poll = setInterval(() => { void readNew(); }, 200);
  poll.unref();
  const initialDrain = setTimeout(() => { void readNew(); }, 30);
  initialDrain.unref();

  return {
    stop() {
      stopped = true;
      watcher?.close();
      clearInterval(poll);
      clearTimeout(initialDrain);
      void fh?.close().catch(() => { /* ignore */ });
      fh = undefined;
    },
  };
}

interface ActiveTurn {
  interrupt: (reason: string) => void;
  tailer?: TranscriptTailer;
  convWatch?: { stop: () => void };
  doneTimer?: NodeJS.Timeout;
  hardTimeout?: NodeJS.Timeout;
  /** The PTY serving this turn. A stale PTY's onExit (after a kill->respawn race)
   *  must NOT interrupt the active turn unless it owns this exact proc. */
  boundProc?: pty.IPty;
}

interface StreamEntry {
  chunks: Buffer[];
  totalBytes: number;
  subscribers: Set<{ data: (d: Buffer) => void; control?: (e: PtyControlEvent) => void }>;
  hasSeenPty: boolean;
}

export class AntigravityEngine implements InterruptibleEngine, PtyViewEngine {
  name = "antigravity" as const;
  private active = new Map<string, ActiveTurn>();
  private streams = new Map<string, StreamEntry>();
  private lastGeom = new Map<string, { cols: number; rows: number }>();

  constructor(private lifecycle: PtyLifecycleManager) {}

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    const jinnSessionId = opts.sessionId;
    if (!jinnSessionId) throw new Error("AntigravityEngine.run requires opts.sessionId");
    if (this.active.has(jinnSessionId)) {
      return { sessionId: opts.resumeSessionId ?? "", result: "", error: "Antigravity engine: a turn is already running for this session" };
    }

    // Use the realpath as cwd: agy records workspace trust by realpath, and on
    // macOS /tmp→/private/tmp, so spawning with the raw path while trusting the
    // realpath leaves agy stuck on the trust prompt (swallowing our input).
    let cwd = opts.cwd || JINN_HOME;
    try { cwd = fs.realpathSync(cwd); } catch { /* dir may not exist — use as-is */ }
    ensureWorkspaceTrusted(cwd); // pre-trust so the interactive trust gate never blocks the spawn

    let convId = opts.resumeSessionId; // known iff resuming an existing conversation
    let latestAnswer: string | undefined;
    let lastContextEstimate = 0; // est. context tokens (chars/4 of the running transcript)
    let settled = false;

    let resolveFn!: (r: EngineResult) => void;
    const promise = new Promise<EngineResult>((res) => { resolveFn = res; });

    const turn: ActiveTurn = { interrupt: () => { /* set below */ } };

    const cleanup = () => {
      if (turn.doneTimer) clearTimeout(turn.doneTimer);
      if (turn.hardTimeout) clearTimeout(turn.hardTimeout);
      turn.tailer?.stop();
      turn.convWatch?.stop();
      this.active.delete(jinnSessionId);
      this.lifecycle.turnEnded(jinnSessionId); // lifecycle decides keep-warm vs reap
    };
    const finish = (r: EngineResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolveFn(r);
    };
    turn.interrupt = (reason: string) =>
      finish({ sessionId: convId ?? opts.resumeSessionId ?? "", result: latestAnswer ?? "", error: reason });

    const onDone = (content: string) => {
      latestAnswer = content;
      // agy exposes NO token usage anywhere in its transcript, so an exact context
      // meter isn't possible. Emit an ESTIMATE from the running conversation size
      // (chars/4) so the chat pane gets an approximate "how full" gauge; the model's
      // 1M window makes small inaccuracy immaterial as a percentage.
      if (convId) {
        const est = estimateContextTokens(convId);
        if (est > 0) {
          lastContextEstimate = est;
          opts.onStream?.({ type: "context", content: String(est) });
        }
      }
      // Debounce so multi-step planning (several DONE lines) collapses to the last one.
      if (turn.doneTimer) clearTimeout(turn.doneTimer);
      turn.doneTimer = setTimeout(
        () => finish({ sessionId: convId ?? "", result: latestAnswer ?? "", numTurns: 1, contextTokens: lastContextEstimate || undefined }),
        DONE_DEBOUNCE_MS,
      );
      turn.doneTimer.unref?.();
    };

    const attachTail = (cid: string) => {
      if (turn.tailer) return;
      const tp = transcriptPathFor(cid);
      let startOffset = 0;
      try { startOffset = fs.statSync(tp).size; } catch { /* not created yet → 0 */ }
      turn.tailer = tailTranscript(tp, startOffset, (d) => opts.onStream?.(d), onDone);
    };

    this.active.set(jinnSessionId, turn);

    turn.hardTimeout = setTimeout(
      () => finish(
        latestAnswer
          ? { sessionId: convId ?? "", result: latestAnswer, numTurns: 1 }
          : { sessionId: convId ?? opts.resumeSessionId ?? "", result: "", error: "Antigravity turn timed out" },
      ),
      TURN_TIMEOUT_MS,
    );
    turn.hardTimeout.unref?.();

    if (convId) {
      attachTail(convId);
    } else {
      // Fresh conversation: agy mints a new brain/<convId> dir after the first
      // prompt. Discover it by diffing the brain dir, then tail its transcript.
      const before = listConvDirs();
      const startedAt = Date.now();
      const interval = setInterval(() => {
        if (settled) { clearInterval(interval); return; }
        const fresh = [...listConvDirs()].filter((d) => !before.has(d));
        if (fresh.length > 0) {
          clearInterval(interval);
          convId = fresh.sort()[0];
          logger.info(`AntigravityEngine discovered conversation ${convId} for session ${jinnSessionId}`);
          attachTail(convId);
        } else if (Date.now() - startedAt > CONV_DISCOVER_TIMEOUT_MS) {
          clearInterval(interval);
          finish({ sessionId: "", result: "", error: "Antigravity: no conversation transcript appeared" });
        }
      }, CONV_POLL_MS);
      interval.unref?.();
      turn.convWatch = { stop: () => clearInterval(interval) };
    }

    // Spawn (cold) or inject (warm). Independent of conv-id discovery above.
    const warm = this.lifecycle.getWarm(jinnSessionId);
    if (warm) {
      turn.boundProc = (warm as any)._proc as pty.IPty | undefined;
      this.lifecycle.turnStarted(jinnSessionId);
      this.injectPrompt(warm, opts);
    } else {
      const handle = this.spawn(jinnSessionId, opts, cwd, convId);
      turn.boundProc = (handle as any)._proc as pty.IPty | undefined;
      this.lifecycle.adopt(jinnSessionId, handle);
      this.lifecycle.turnStarted(jinnSessionId);
    }

    return promise;
  }

  /** env for the agy PTY: inherit, force a real TERM. Do NOT strip GEMINI_*
   *  (agy shares the ~/.gemini account dir for its cached credential). */
  private buildPtyEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    env.TERM = "xterm-256color";
    return env;
  }

  private buildArgs(resumeConvId: string | undefined): string[] {
    const args: string[] = [];
    if (resumeConvId) args.push("--conversation", resumeConvId);
    args.push(SKIP_PERMISSIONS_FLAG);
    return args;
  }

  private spawn(jinnSessionId: string, opts: EngineRunOpts, cwd: string, resumeConvId: string | undefined): PtyHandle {
    const bin = resolveBin("agy", opts.bin);
    const args = this.buildArgs(resumeConvId);
    const geom = this.lastGeom.get(jinnSessionId);
    logger.info(`AntigravityEngine spawning ${bin} (resume: ${resumeConvId || "none"}, geom: ${geom ? `${geom.cols}×${geom.rows}` : "default"})`);
    const proc = pty.spawn(bin, args, {
      name: "xterm-256color",
      cols: geom?.cols ?? 120,
      rows: geom?.rows ?? 40,
      cwd,
      env: this.buildPtyEnv(),
    });
    // Inject once the TUI is ready. A fixed delay is unreliable — agy needs a
    // few seconds to render and start accepting input. Gate on output quiescence:
    // inject after the PTY has emitted something and then gone quiet (TUI settled),
    // with a hard cap so we never wait forever.
    this.scheduleColdInject(proc, opts);
    return this.wireProcToStream(jinnSessionId, proc, () => {
      this.active.get(jinnSessionId)?.interrupt("Interrupted: agy process exited");
    });
  }

  /** Wait for agy's TUI to settle (first output, then ~1.2s quiet) before sending
   *  the prompt; fall back to a hard cap. Prevents dropping the prompt into a
   *  not-yet-ready terminal (the cause of "no conversation transcript appeared"). */
  private scheduleColdInject(proc: pty.IPty, opts: EngineRunOpts): void {
    const QUIET_MS = 1200;
    const HARD_CAP_MS = 12000;
    const startedAt = Date.now();
    let lastData = Date.now();
    let sawData = false;
    let injected = false;
    const sub = proc.onData(() => { lastData = Date.now(); sawData = true; });
    const timer = setInterval(() => {
      if (injected) return;
      const idleFor = Date.now() - lastData;
      const elapsed = Date.now() - startedAt;
      if ((sawData && idleFor > QUIET_MS) || elapsed > HARD_CAP_MS) {
        injected = true;
        clearInterval(timer);
        try { sub.dispose(); } catch { /* ignore */ }
        this.injectPromptToProc(proc, opts);
      }
    }, 250);
    timer.unref?.();
  }

  private injectPromptToProc(proc: pty.IPty, opts: EngineRunOpts): void {
    let text = opts.prompt;
    // Inject the system prompt only on the FIRST turn of a conversation. agy
    // persists the conversation (resume via --conversation retains it), so on a
    // resume / warm follow-up re-sending it just re-logs the whole Jinn system
    // prompt as a fresh USER_INPUT step every turn (context bloat).
    if (opts.systemPrompt && !opts.resumeSessionId) text = `${opts.systemPrompt}\n\n---\n\n${text}`;
    if (opts.attachments?.length) {
      text += "\n\nAttached files:\n" + opts.attachments.map((a) => `- ${a}`).join("\n");
    }
    pasteAndSubmit(proc, text);
  }

  private injectPrompt(handle: PtyHandle, opts: EngineRunOpts): void {
    const proc = (handle as any)._proc as pty.IPty | undefined;
    if (proc) this.injectPromptToProc(proc, opts);
  }

  // --- PTY stream plumbing (mirrors InteractiveClaudeEngine) ---

  private streamFor(sessionId: string): StreamEntry {
    let stream = this.streams.get(sessionId);
    if (!stream) {
      stream = { chunks: [], totalBytes: 0, subscribers: new Set(), hasSeenPty: false };
      this.streams.set(sessionId, stream);
    }
    return stream;
  }

  private wireProcToStream(jinnSessionId: string, proc: pty.IPty, onExitExtra?: () => void): PtyHandle {
    const handle = {
      pid: proc.pid,
      get killed() { return (proc as any)._exitCode != null; },
      kill: (signal?: string) => { try { proc.kill(signal); } catch { /* gone */ } },
    } as PtyHandle;
    const stream = this.streamFor(jinnSessionId);
    if (!stream.hasSeenPty) {
      stream.hasSeenPty = true;
    } else if (stream.subscribers.size > 0) {
      for (const sub of stream.subscribers) {
        try { sub.control?.({ type: "reset" }); } catch { /* ignore */ }
      }
    }
    (proc as any).on?.("error", (err: Error) => {
      logger.warn(`Antigravity PTY socket error for session ${jinnSessionId}: ${err.message}`);
    });

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
        const sliced = only.subarray(only.length - SCROLLBACK_CAP_BYTES);
        stream.chunks[0] = sliced;
        stream.totalBytes = sliced.length;
      }
      for (const sub of stream.subscribers) {
        try { sub.data(chunk); } catch { /* ignore */ }
      }
    });
    proc.onExit(() => {
      // Identity-gate session cleanup. In a kill->respawn race the lifecycle/stream
      // entries already point at the NEW PTY by the time THIS (old, killed) PTY's exit
      // fires; releaseSession is keyed by sessionId, so an unguarded call would kill the
      // freshly-adopted PTY. Only clean up if this PTY is still the session's warm handle.
      const isCurrent = this.lifecycle.getWarm(jinnSessionId) === handle;
      if (isCurrent) {
        const s = this.streams.get(jinnSessionId);
        if (s) {
          s.chunks = [];
          s.totalBytes = 0;
          if (s.subscribers.size === 0) this.streams.delete(jinnSessionId);
        }
        this.lifecycle.releaseSession(jinnSessionId);
      }
      // Settle the active turn as interrupted ONLY if this dying proc is the one bound
      // to it — after a kill->respawn race the active entry holds the NEW turn's proc and
      // this old proc must not poison it.
      const e = this.active.get(jinnSessionId);
      if (e && e.boundProc === proc) onExitExtra?.();
    });
    (handle as any)._proc = proc;
    return handle;
  }

  /** Spawn an idle PTY for the xterm view (before the user sends a message).
   *  Resumes `engineSessionId` if given, else a fresh agy TUI. */
  ensureIdleSpawn(jinnSessionId: string, opts: PtyIdleSpawnOpts): void {
    if (this.lifecycle.getWarm(jinnSessionId)) return;
    if (this.active.has(jinnSessionId)) return; // a turn is starting — let run() spawn
    const bin = resolveBin("agy", opts.bin);
    const args = this.buildArgs(opts.engineSessionId);
    const cols = opts.cols ?? this.lastGeom.get(jinnSessionId)?.cols ?? 120;
    const rows = opts.rows ?? this.lastGeom.get(jinnSessionId)?.rows ?? 40;
    if (opts.cols && opts.rows) this.lastGeom.set(jinnSessionId, { cols: opts.cols, rows: opts.rows });
    logger.info(`AntigravityEngine ensureIdleSpawn for session ${jinnSessionId} (resume ${opts.engineSessionId || "none — fresh"}, geom ${cols}×${rows})`);
    const proc = pty.spawn(bin, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: opts.cwd || JINN_HOME,
      env: this.buildPtyEnv(),
    });
    const handle = this.wireProcToStream(jinnSessionId, proc);
    this.lifecycle.adopt(jinnSessionId, handle);
  }

  getScrollback(sessionId: string): Buffer {
    const s = this.streams.get(sessionId);
    if (!s || s.chunks.length === 0) return Buffer.alloc(0);
    return Buffer.concat(s.chunks, s.totalBytes);
  }

  subscribeOutput(
    sessionId: string,
    cb: (data: Buffer) => void,
    onControl?: (event: PtyControlEvent) => void,
  ): () => void {
    const stream = this.streamFor(sessionId);
    const sub = { data: cb, control: onControl };
    stream.subscribers.add(sub);
    return () => {
      stream.subscribers.delete(sub);
      if (stream.subscribers.size === 0 && !this.lifecycle.getWarm(sessionId)) {
        this.streams.delete(sessionId);
      }
    };
  }

  writeStdin(sessionId: string, text: string): void {
    const handle = this.lifecycle.getWarm(sessionId);
    const proc = handle ? ((handle as any)._proc as pty.IPty | undefined) : undefined;
    if (!proc) return;
    pasteAndSubmit(proc, text);
  }

  resizePty(sessionId: string, cols: number, rows: number): void {
    this.lastGeom.set(sessionId, { cols, rows });
    const handle = this.lifecycle.getWarm(sessionId);
    const proc = handle ? ((handle as any)._proc as pty.IPty | undefined) : undefined;
    if (!proc) return;
    try { proc.resize(cols, rows); } catch { /* gone */ }
  }

  setViewing(sessionId: string, viewing: boolean): void {
    if (viewing) this.lifecycle.viewerEnter(sessionId);
    else this.lifecycle.viewerLeave(sessionId);
  }

  hasWarmPty(sessionId: string): boolean {
    return this.lifecycle.getWarm(sessionId) !== undefined;
  }

  // --- InterruptibleEngine ---

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
