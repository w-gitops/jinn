import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { InterruptibleEngine, EngineRunOpts, EngineResult, StreamDelta } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { resolveBin } from "../shared/resolve-bin.js";
import { tailTranscriptLines, type TranscriptTailer } from "./transcript-tailer.js";

export const GROK_DEFAULT_MODEL = "grok-build";
export const GROK_SESSIONS_DIR = path.join(os.homedir(), ".grok", "sessions");

const STDERR_MAX = 10 * 1024;
const TRANSCRIPT_TAIL_POLL_MS = 250;
const TRANSCRIPT_DISCOVER_POLL_MS = 200;

interface LiveProcess {
  proc: ChildProcess;
  terminationReason: string | null;
}

export interface GrokParsedLine {
  deltas: StreamDelta[];
  sessionId?: string;
  doneText?: string;
  error?: string;
  terminal?: boolean;
  contextTokens?: number;
}

export function grokCliFlags(flags: string[] | undefined): string[] {
  // `--chrome` is a Claude Code flag. Shared employee config can carry it; Grok
  // rejects unknown flags before a session starts.
  return (flags ?? []).filter((flag) => flag !== "--chrome");
}

export function buildGrokHeadlessArgs(opts: EngineRunOpts, prompt: string, sessionId: string): string[] {
  const args = ["--no-auto-update"];
  if (opts.model) args.push("--model", opts.model);
  if (opts.effortLevel && opts.effortLevel !== "default") args.push("--effort", opts.effortLevel);
  if (opts.cwd) args.push("--cwd", opts.cwd);
  if (opts.resumeSessionId) args.push("--resume", sessionId);
  args.push("--always-approve", "--output-format", "streaming-json");
  args.push(...grokCliFlags(opts.cliFlags));
  args.push("-p", prompt);
  return args;
}

interface TranscriptStat {
  mtimeMs: number;
  size: number;
}

function walkFiles(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const p = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walkFiles(p, out);
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

function isGrokTranscriptFile(file: string): boolean {
  return file.endsWith("/updates.jsonl") || file.endsWith("/chat_history.jsonl") || file.endsWith("/events.jsonl");
}

function sortGrokTranscriptFiles(files: string[]): string[] {
  const rank = (file: string) => {
    if (file.endsWith("/updates.jsonl")) return 0;
    if (file.endsWith("/chat_history.jsonl")) return 1;
    if (file.endsWith("/events.jsonl")) return 2;
    return 3;
  };
  return files.filter(isGrokTranscriptFile).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

function listTranscriptStats(root = GROK_SESSIONS_DIR): Map<string, TranscriptStat> {
  const files = new Map<string, TranscriptStat>();
  for (const file of sortGrokTranscriptFiles(walkFiles(root))) {
    try {
      const stat = fs.statSync(file);
      files.set(file, { mtimeMs: stat.mtimeMs, size: stat.size });
    } catch {
      // gone
    }
  }
  return files;
}

function parseSessionIdFromFile(filePath: string): string | undefined {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(64 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      for (const line of buf.subarray(0, n).toString("utf-8").split("\n")) {
        const parsed = parseGrokJsonLine(line);
        if (parsed?.sessionId) return parsed.sessionId;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function transcriptMatchesSession(filePath: string, sessionId: string): boolean {
  return filePath.includes(sessionId) || parseSessionIdFromFile(filePath) === sessionId;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringField(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((block) => {
      if (typeof block === "string") return block;
      const b = asRecord(block);
      if (!b) return "";
      const direct = stringField(b, ["text", "content", "value", "output"]);
      if (direct) return direct;
      const nested = asRecord(b.content);
      if (nested) return stringField(nested, ["text", "content", "value", "output"]) ?? textFromContent(nested.content);
      return Array.isArray(b.content) ? textFromContent(b.content) : "";
    })
    .join("");
}

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return textFromContent(value);
  const obj = asRecord(value);
  if (!obj) return "";
  return stringField(obj, ["text", "content", "value", "output", "message"]) ?? textFromContent(obj.content);
}

function compactText(text: string, max = 500): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function safeJsonSnippet(value: unknown, max = 200): string | undefined {
  if (value === undefined) return undefined;
  try {
    return compactText(JSON.stringify(value), max);
  } catch {
    return undefined;
  }
}

function normalizeGrokToolName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  if (/^[A-Z][A-Za-z0-9]*$/.test(name)) {
    return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  }
  return name;
}

function toolNameFromGrokUpdate(update: Record<string, unknown>): string | undefined {
  const rawInput = asRecord(update.rawInput);
  const rawOutput = asRecord(update.rawOutput);
  return normalizeGrokToolName(
    stringField(rawInput ?? {}, ["variant", "tool", "toolName", "name"]) ??
    stringField(rawOutput ?? {}, ["type", "variant", "tool", "toolName", "name"]) ??
    stringField(update, ["toolName", "tool_name", "name", "title", "kind"]),
  );
}

function toolResultTextFromGrokUpdate(update: Record<string, unknown>): string {
  const contentText = textFromUnknown(update.content);
  if (contentText) return compactText(contentText);
  const rawOutputText = textFromUnknown(update.rawOutput);
  if (rawOutputText) return compactText(rawOutputText);
  const status = stringField(update, ["status", "type", "outcome"]);
  return status ? compactText(status) : "Done";
}

function planStatusFromGrokUpdate(update: Record<string, unknown>): string | undefined {
  const entries = Array.isArray(update.entries) ? update.entries : [];
  const parsed = entries
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));
  const active =
    parsed.find((entry) => String(entry.status ?? "").toLowerCase() === "in_progress") ??
    parsed.find((entry) => String(entry.status ?? "").toLowerCase() === "pending") ??
    parsed[parsed.length - 1];
  const text = active ? stringField(active, ["content", "title", "task"]) : undefined;
  return text ? `Plan: ${compactText(text, 240)}` : undefined;
}

function extractText(obj: Record<string, unknown>, eventType: string, terminal: boolean): { text: string; snapshot: boolean } {
  const message = asRecord(obj.message);
  const role = String(obj.role ?? message?.role ?? "").toLowerCase();
  if (role === "user" || role === "system" || eventType === "user" || eventType === "system") {
    return { text: "", snapshot: true };
  }

  const deltaText = textFromUnknown(obj.delta);
  if (deltaText) return { text: deltaText, snapshot: false };

  const messageText = message ? textFromContent(message.content) || textFromUnknown(message.text) : "";
  if (messageText) return { text: messageText, snapshot: true };

  const contentText = textFromContent(obj.content);
  if (contentText) return { text: contentText, snapshot: !eventType.includes("delta") && !eventType.includes("chunk") };

  const directText = terminal
    ? stringField(obj, ["result", "final", "answer", "output", "text", "content"])
    : stringField(obj, ["text", "content"]);
  if (!directText) return { text: "", snapshot: true };
  return { text: directText, snapshot: !eventType.includes("delta") && !eventType.includes("chunk") };
}

function extractError(obj: Record<string, unknown>): string | undefined {
  const err = obj.error;
  if (typeof err === "string" && err.trim()) return err;
  const errObj = asRecord(err);
  if (errObj) {
    const msg = stringField(errObj, ["message", "error", "detail"]);
    if (msg) return msg;
  }
  return stringField(obj, ["errorMessage", "message", "detail"]);
}

function extractContextTokens(obj: Record<string, unknown>): number | undefined {
  const usage = asRecord(obj.usage) ?? asRecord(obj.token_usage) ?? asRecord(obj.tokens);
  const meta = asRecord(obj._meta);
  const candidate =
    usage?.input_tokens ??
    usage?.inputTokens ??
    usage?.context_tokens ??
    usage?.contextTokens ??
    obj.context_tokens ??
    obj.contextTokens ??
    meta?.totalTokens ??
    meta?.contextTokens;
  const n = Number(candidate ?? 0);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function parseGrokJsonLine(line: string): GrokParsedLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let obj: Record<string, unknown>;
  try {
    const parsed = JSON.parse(trimmed);
    const record = asRecord(parsed);
    if (!record) return null;
    obj = record;
  } catch {
    logger.debug(`[grok stream] unparseable line: ${trimmed.slice(0, 100)}`);
    return null;
  }

  const method = String(obj.method ?? "");
  if (method === "session/update") {
    const params = asRecord(obj.params);
    const update = asRecord(params?.update);
    const updateType = String(update?.sessionUpdate ?? "").toLowerCase();
    const nestedSessionId = params ? stringField(params, ["sessionId", "session_id"]) : undefined;
    const contextTokens = (update ? extractContextTokens(update) : undefined) ??
      (params ? extractContextTokens(params) : undefined) ??
      extractContextTokens(obj);
    const deltas: StreamDelta[] = [];
    if (contextTokens) deltas.push({ type: "context", content: String(contextTokens) });
    if (updateType === "agent_message_chunk") {
      const content = asRecord(update?.content);
      const text = textFromUnknown(content?.text ?? update?.content);
      return {
        deltas: text ? [...deltas, { type: "text", content: text }] : deltas,
        sessionId: nestedSessionId,
        terminal: false,
        contextTokens,
      };
    }
    if (updateType === "agent_thought_chunk") {
      const content = asRecord(update?.content);
      const text = compactText(textFromUnknown(content?.text ?? update?.content));
      return {
        deltas: text ? [...deltas, { type: "status", content: text }] : deltas,
        sessionId: nestedSessionId,
        terminal: false,
        contextTokens,
      };
    }
    if (updateType === "tool_call") {
      const toolName = update ? toolNameFromGrokUpdate(update) : undefined;
      return {
        deltas: [
          ...deltas,
          {
            type: "tool_use",
            content: toolName ? `Using ${toolName}` : "Using tool",
            toolName,
            toolId: update ? stringField(update, ["toolCallId", "tool_call_id", "id"]) : undefined,
            input: update ? safeJsonSnippet(update.rawInput) : undefined,
          },
        ],
        sessionId: nestedSessionId,
        terminal: false,
        contextTokens,
      };
    }
    if (updateType === "tool_call_update") {
      const status = String(update?.status ?? update?.type ?? "").toLowerCase();
      const completed = ["completed", "complete", "done", "success", "failed", "failure", "error"].includes(status);
      if (!completed) return { deltas, sessionId: nestedSessionId, terminal: false, contextTokens };
      const toolName = update ? toolNameFromGrokUpdate(update) : undefined;
      return {
        deltas: [
          ...deltas,
          {
            type: "tool_result",
            content: update ? toolResultTextFromGrokUpdate(update) : "Done",
            toolName,
            toolId: update ? stringField(update, ["toolCallId", "tool_call_id", "id"]) : undefined,
          },
        ],
        sessionId: nestedSessionId,
        terminal: false,
        contextTokens,
      };
    }
    if (updateType === "plan") {
      const status = update ? planStatusFromGrokUpdate(update) : undefined;
      return {
        deltas: status ? [...deltas, { type: "status", content: status }] : deltas,
        sessionId: nestedSessionId,
        terminal: false,
        contextTokens,
      };
    }
    if (updateType === "retry_state") {
      const attempt = update?.attempt;
      const max = update?.max_retries;
      const attemptText = typeof attempt === "string" || typeof attempt === "number" ? String(attempt) : "";
      const maxText = typeof max === "string" || typeof max === "number" ? String(max) : "";
      const reason = update ? stringField(update, ["reason", "message", "error"]) : undefined;
      const label = `Grok retrying${attemptText ? ` (${attemptText}${maxText ? `/${maxText}` : ""})` : ""}${reason ? `: ${compactText(reason, 180)}` : ""}`;
      return {
        deltas: [...deltas, { type: "status", content: label }],
        sessionId: nestedSessionId,
        terminal: false,
        contextTokens,
      };
    }
    return { deltas, sessionId: nestedSessionId, terminal: false, contextTokens };
  }

  const rawType = String(obj.type ?? obj.event ?? obj.kind ?? "");
  const eventType = rawType.toLowerCase();
  const terminal =
    Boolean(obj.done || obj.is_final || obj.final) ||
    /complete|completed|done|result|final|agent_end|turn_end/.test(eventType) ||
    eventType === "end";
  const deltas: StreamDelta[] = [];

  const sessionId = stringField(obj, ["session_id", "sessionId", "conversation_id", "conversationId"]);
  const contextTokens = extractContextTokens(obj);
  if (contextTokens) deltas.push({ type: "context", content: String(contextTokens) });

  if (eventType.includes("error") || eventType.includes("failed") || obj.error !== undefined) {
    const error = extractError(obj) ?? "Grok reported an error";
    return { deltas: [{ type: "error", content: error }, ...deltas], sessionId, error, terminal: true };
  }

  if (eventType === "thought") {
    const text = compactText(textFromUnknown(obj.data) || textFromUnknown(obj.content));
    if (text) deltas.push({ type: "status", content: text });
    return { deltas, sessionId, terminal, contextTokens };
  }

  if (eventType === "text") {
    const text = textFromUnknown(obj.data);
    if (text) deltas.push({ type: "text", content: text });
    return { deltas, sessionId, terminal, contextTokens };
  }

  const toolName = stringField(obj, ["toolName", "tool_name", "name"]) ?? stringField(asRecord(obj.tool) ?? {}, ["name"]);
  if (eventType.includes("tool") && (eventType.includes("start") || eventType.includes("call") || eventType.includes("use"))) {
    const content = toolName ? `Using ${toolName}` : "Using tool";
    return {
      deltas: [{ type: "tool_use", content, toolName, toolId: stringField(obj, ["toolCallId", "tool_call_id", "id"]) }, ...deltas],
      sessionId,
      terminal: false,
      contextTokens,
    };
  }
  if (eventType.includes("tool") && (eventType.includes("end") || eventType.includes("result") || eventType.includes("complete"))) {
    const content = textFromUnknown(obj.result) || stringField(obj, ["output", "content"]) || "Done";
    return {
      deltas: [{ type: "tool_result", content: content.slice(0, 500), toolName, toolId: stringField(obj, ["toolCallId", "tool_call_id", "id"]) }, ...deltas],
      sessionId,
      terminal: false,
      contextTokens,
    };
  }

  const { text, snapshot } = extractText(obj, eventType, terminal);
  let doneText: string | undefined;
  if (text) {
    const deltaType: StreamDelta["type"] = snapshot ? "text_snapshot" : "text";
    deltas.push({ type: deltaType, content: text });
    if (terminal || snapshot) doneText = text;
  }

  return { deltas, sessionId, doneText, terminal, contextTokens };
}

export class GrokEngine implements InterruptibleEngine {
  name = "grok" as const;
  private liveProcesses = new Map<string, LiveProcess>();

  kill(sessionId: string, reason = "Interrupted"): void {
    const live = this.liveProcesses.get(sessionId);
    if (!live) return;
    live.terminationReason = reason;
    logger.info(`Killing Grok process for session ${sessionId}`);
    this.signalProcess(live.proc, "SIGTERM");
    setTimeout(() => {
      if (live.proc.exitCode === null) this.signalProcess(live.proc, "SIGKILL");
    }, 2000);
  }

  killAll(): void {
    for (const sessionId of this.liveProcesses.keys()) this.kill(sessionId, "Interrupted: gateway shutting down");
  }

  /** Batch engine: no warm-PTY reuse, every live process is an in-flight turn.
   *  Nothing idle to recycle on org-reload — no-op. */
  killIdle(): void {
    /* no-op */
  }

  isAlive(sessionId: string): boolean {
    const live = this.liveProcesses.get(sessionId);
    return !!live && !live.proc.killed && live.proc.exitCode === null;
  }

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    const trackingId = opts.sessionId || `grok-${Date.now()}`;
    const grokSessionId = opts.resumeSessionId || trackingId;

    let prompt = opts.prompt;
    if (opts.systemPrompt && !opts.resumeSessionId) prompt = `${opts.systemPrompt}\n\n---\n\n${prompt}`;
    if (opts.attachments?.length) {
      prompt += "\n\nAttached files:\n" + opts.attachments.map((a) => `- ${a}`).join("\n");
    }

    const bin = resolveBin("grok", opts.bin);
    const args = buildGrokHeadlessArgs(opts, prompt, grokSessionId);
    logger.info(`Grok engine starting: ${bin} --model ${opts.model || "default"} (session: ${grokSessionId})`);
    const transcriptBaseline = listTranscriptStats();

    return new Promise((resolve, reject) => {
      const proc = spawn(bin, args, {
        cwd: opts.cwd,
        env: this.buildCleanEnv(),
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });

      this.liveProcesses.set(trackingId, { proc, terminationReason: null });

      let stderr = "";
      let lineBuf = "";
      let resultText = "";
      let turnError: string | null = null;
      let lastContextTokens: number | undefined;
      let settled = false;
      let resolvedSessionId = grokSessionId;
      let resolvedSessionFromStdout = Boolean(opts.resumeSessionId);
      let transcriptTailer: TranscriptTailer | undefined;
      let transcriptDiscover: NodeJS.Timeout | undefined;

      const expectedTranscriptSessionId = () =>
        opts.resumeSessionId || (resolvedSessionFromStdout ? resolvedSessionId : undefined);

      const stopTranscriptWatch = () => {
        if (transcriptDiscover) {
          clearInterval(transcriptDiscover);
          transcriptDiscover = undefined;
        }
        transcriptTailer?.stop();
        transcriptTailer = undefined;
      };

      const handleParsed = (parsed: GrokParsedLine | null) => {
        if (!parsed) return;
        if (parsed.sessionId) {
          resolvedSessionId = parsed.sessionId;
          resolvedSessionFromStdout = true;
        }
        if (parsed.contextTokens) lastContextTokens = parsed.contextTokens;
        if (parsed.error) turnError = parsed.error;
        for (const delta of parsed.deltas) {
          if (delta.type === "text") resultText += delta.content;
          if (delta.type === "text_snapshot") resultText = delta.content;
          opts.onStream?.(delta);
        }
        if (parsed.doneText) resultText = parsed.doneText;
      };

      const handleTranscriptParsed = (parsed: GrokParsedLine | null) => {
        if (!parsed) return;
        const expected = expectedTranscriptSessionId();
        if (parsed.sessionId && expected && parsed.sessionId !== expected) {
          logger.warn(`Ignoring Grok transcript event for session ${parsed.sessionId}; expected ${expected}`);
          return;
        }
        if (parsed.sessionId && !expected) return;
        if (parsed.contextTokens) lastContextTokens = parsed.contextTokens;
        for (const delta of parsed.deltas) {
          // Grok headless stdout currently carries thought/text chunks, but tool
          // lifecycle updates only appear in updates.jsonl. Mirror the structural
          // deltas from the transcript and leave answer text to stdout to avoid
          // duplicate assistant content.
          if (delta.type === "tool_use" || delta.type === "tool_result" || delta.type === "context") {
            opts.onStream?.(delta);
          }
        }
      };

      const attachTranscriptTail = (filePath: string, offset: number) => {
        if (transcriptTailer) return;
        transcriptTailer = tailTranscriptLines(
          filePath,
          offset,
          (line) => handleTranscriptParsed(parseGrokJsonLine(line)),
          { pollMs: TRANSCRIPT_TAIL_POLL_MS, label: "Grok headless transcript" },
        );
      };

      transcriptDiscover = setInterval(() => {
        if (transcriptTailer) return;
        const expected = expectedTranscriptSessionId();
        if (!expected) return;
        const current = listTranscriptStats();
        const candidates = sortGrokTranscriptFiles(
          [...current.entries()]
            .filter(([file, stat]) => {
              const prev = transcriptBaseline.get(file);
              return (!prev || stat.mtimeMs > prev.mtimeMs || stat.size > prev.size) &&
                transcriptMatchesSession(file, expected);
            })
            .map(([file]) => file),
        );
        const first = candidates[0];
        if (!first) return;
        const prev = transcriptBaseline.get(first);
        attachTranscriptTail(first, prev?.size ?? 0);
        if (transcriptDiscover) {
          clearInterval(transcriptDiscover);
          transcriptDiscover = undefined;
        }
      }, TRANSCRIPT_DISCOVER_POLL_MS);
      transcriptDiscover.unref?.();

      proc.stdout.on("data", (d: Buffer) => {
        lineBuf += d.toString();
        const lines = lineBuf.split("\n");
        lineBuf = lines.pop() || "";
        for (const line of lines) handleParsed(parseGrokJsonLine(line));
      });

      proc.stderr.on("data", (d: Buffer) => {
        const chunk = d.toString();
        stderr = (stderr + chunk).slice(-STDERR_MAX);
        for (const line of chunk.trim().split("\n").filter(Boolean)) logger.debug(`[grok stderr] ${line}`);
      });

      proc.stdin.end();

      proc.on("close", (code) => {
        if (settled) return;
        settled = true;
        stopTranscriptWatch();
        handleParsed(parseGrokJsonLine(lineBuf));
        const terminationReason = this.liveProcesses.get(trackingId)?.terminationReason ?? null;
        this.liveProcesses.delete(trackingId);

        if (terminationReason) {
          resolve({
            sessionId: resolvedSessionId,
            result: resultText,
            error: terminationReason,
            ...(typeof lastContextTokens === "number" ? { contextTokens: lastContextTokens } : {}),
          });
          return;
        }

        if (code === 0 || resultText.trim()) {
          resolve({
            sessionId: resolvedSessionId,
            result: resultText,
            error: resultText.trim() ? undefined : (turnError ?? undefined),
            numTurns: 1,
            ...(typeof lastContextTokens === "number" ? { contextTokens: lastContextTokens } : {}),
          });
          return;
        }

        const errMsg = turnError || `Grok exited with code ${code}: ${stderr.slice(0, 500)}`;
        logger.error(errMsg);
        resolve({
          sessionId: resolvedSessionId,
          result: resultText,
          error: errMsg,
          ...(typeof lastContextTokens === "number" ? { contextTokens: lastContextTokens } : {}),
        });
      });

      proc.on("error", (err) => {
        if (settled) return;
        settled = true;
        stopTranscriptWatch();
        this.liveProcesses.delete(trackingId);
        reject(new Error(`Failed to spawn Grok CLI: ${err.message}`));
      });
    });
  }

  private buildCleanEnv(): Record<string, string> {
    const cleanEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) continue;
      if (k === "CODEX" || k.startsWith("CODEX_")) continue;
      if (v !== undefined) cleanEnv[k] = v;
    }
    cleanEnv.GROK_CLAUDE_MCPS_ENABLED = "false";
    cleanEnv.GROK_CURSOR_MCPS_ENABLED = "false";
    return cleanEnv;
  }

  private signalProcess(proc: ChildProcess, signal: NodeJS.Signals): void {
    if (proc.exitCode !== null) return;
    try {
      if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, signal);
      else proc.kill(signal);
    } catch (err) {
      logger.debug(`Failed to send ${signal} to Grok process: ${err instanceof Error ? err.message : err}`);
    }
  }
}
