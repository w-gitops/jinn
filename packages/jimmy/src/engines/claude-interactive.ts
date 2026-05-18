import * as pty from "node-pty";
import type { InterruptibleEngine, EngineRunOpts, EngineResult } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { JINN_HOME, CLAUDE_SETTINGS_DIR, HOOK_RELAY_SCRIPT } from "../shared/paths.js";
import { writeSessionSettings } from "../shared/claude-settings.js";
import { buildInteractiveArgs } from "./interactive-args.js";
import { tailTranscript, type TranscriptTailer } from "./transcript-tail.js";
import { PtyLifecycleManager, type PtyHandle } from "./pty-lifecycle.js";
import type { HookRegistry, HookPayload } from "../gateway/hook-registry.js";
import { computeInteractiveCost } from "./interactive-cost.js";
import { rateLimitFromStopFailure } from "./interactive-ratelimit.js";

export interface TurnResolverOpts {
  turnTimeoutMs: number;
  fallbackSessionId: string | undefined;
  /** When true (warm-PTY reuse / post-idle-spawn), the resolver skips waiting for
   *  SessionStart (it already fired once at process start) and pre-fills the
   *  Claude session id from fallbackSessionId. */
  assumeStarted?: boolean;
}

/** State machine for one interactive turn: resolves after BOTH SessionStart + Stop, or on StopFailure/interrupt/timeout. */
export class TurnResolver {
  readonly promise: Promise<EngineResult>;
  private resolve!: (r: EngineResult) => void;
  private settled = false;
  private claudeSessionId: string | undefined;
  private gotSessionStart = false;
  private stopPayload: HookPayload | undefined;
  private stopFailurePayload: HookPayload | undefined;
  private timer: NodeJS.Timeout;

  constructor(private opts: TurnResolverOpts) {
    this.promise = new Promise((res) => { this.resolve = res; });
    this.timer = setTimeout(() => this.settle({
      sessionId: opts.fallbackSessionId ?? "",
      result: "",
      error: "Interactive turn timed out (watchdog)",
    }), opts.turnTimeoutMs);
    if (opts.assumeStarted) {
      this.gotSessionStart = true;
      this.claudeSessionId = opts.fallbackSessionId;
    }
  }

  onHook(h: HookPayload): void {
    if (this.settled) return;
    if (h.hook_event_name === "SessionStart") {
      this.gotSessionStart = true;
      if (typeof h.session_id === "string") this.claudeSessionId = h.session_id;
      this.maybeComplete();
    } else if (h.hook_event_name === "Stop") {
      this.stopPayload = h;
      if (typeof h.session_id === "string" && !this.claudeSessionId) this.claudeSessionId = h.session_id;
      this.maybeComplete();
    } else if (h.hook_event_name === "StopFailure") {
      // API error ended the turn (rate_limit, billing_error, …). Settle immediately
      // with an error — do NOT wait for SessionStart (an early failure may never
      // produce one). numTurns:1 keeps isDeadSessionError from false-positiving.
      this.stopFailurePayload = h;
      if (typeof h.session_id === "string" && !this.claudeSessionId) this.claudeSessionId = h.session_id;
      this.settle({
        sessionId: this.claudeSessionId ?? this.opts.fallbackSessionId ?? "",
        result: "",
        error: `Interactive turn failed: ${h.error ?? "unknown"}`,
        numTurns: 1,
      });
    }
  }

  /** Claude session id learned so far (for engineSessionId persistence on warm-PTY turns). */
  get sessionId(): string | undefined { return this.claudeSessionId; }
  /** The StopFailure payload, if the turn ended in an API error (Task 5.3 maps it to rateLimit). */
  get stopFailure(): HookPayload | undefined { return this.stopFailurePayload; }
  /** transcript_path from whichever hook carried it. */
  get transcriptPath(): string | undefined {
    const p = this.stopPayload?.transcript_path ?? this.stopFailurePayload?.transcript_path;
    return typeof p === "string" ? p : undefined;
  }

  private maybeComplete(): void {
    if (!this.gotSessionStart || !this.stopPayload) return;
    const sid = this.claudeSessionId ?? this.opts.fallbackSessionId;
    if (!sid) {
      this.settle({ sessionId: "", result: "", error: "Interactive turn produced no Claude session id" });
      return;
    }
    const text = String(this.stopPayload.last_assistant_message ?? "");
    this.settle({ sessionId: sid, result: text, error: undefined, numTurns: 1 });
  }

  interrupt(reason: string): void {
    this.settle({ sessionId: this.claudeSessionId ?? this.opts.fallbackSessionId ?? "", result: "", error: reason });
  }

  private settle(r: EngineResult): void {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this.timer);
    this.resolve(r);
  }
}

/** Cap for the per-session PTY scrollback ring buffer (xterm.js reconnect replay). */
const SCROLLBACK_CAP_BYTES = 262144;

export class InteractiveClaudeEngine implements InterruptibleEngine {
  name = "claude" as const;
  /** Active turn resolvers keyed by Jinn session id. */
  private active = new Map<string, { resolver: TurnResolver; tailer?: TranscriptTailer }>();
  /** Per-session PTY output streams: scrollback ring buffer + live subscribers. Survives PTY respawn. */
  private streams = new Map<string, { buffer: string; subscribers: Set<(d: string) => void> }>();

  constructor(
    private lifecycle: PtyLifecycleManager,
    private hookRegistry: HookRegistry,
    private cfg: { turnTimeoutMs: number },
  ) {}

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    const jinnSessionId = opts.sessionId;
    if (!jinnSessionId) throw new Error("InteractiveClaudeEngine.run requires opts.sessionId");

    // Guard: refuse a second concurrent turn for the same session.
    if (this.active.has(jinnSessionId)) {
      return { sessionId: opts.resumeSessionId ?? "", result: "", error: "Interactive engine: a turn is already running for this session" };
    }

    const settingsPath = writeSessionSettings(CLAUDE_SETTINGS_DIR, jinnSessionId, {
      sessionId: jinnSessionId,
      relayScript: HOOK_RELAY_SCRIPT,
      appendSystemPrompt: opts.systemPrompt,
    });

    const warm = this.lifecycle.getWarm(jinnSessionId);
    const resolver = new TurnResolver({
      turnTimeoutMs: this.cfg.turnTimeoutMs,
      fallbackSessionId: opts.resumeSessionId,
      assumeStarted: !!warm, // warm PTY = SessionStart already fired (turn 1 or idle spawn)
    });
    const entry: { resolver: TurnResolver; tailer?: TranscriptTailer } = { resolver };
    this.active.set(jinnSessionId, entry);

    // Register BEFORE spawning so a fast SessionStart is buffered+drained, not lost.
    this.hookRegistry.register(jinnSessionId, (h) => {
      resolver.onHook(h);
      if (h.hook_event_name === "SessionStart" && typeof h.transcript_path === "string" && !entry.tailer) {
        entry.tailer = tailTranscript(h.transcript_path, (d) => opts.onStream?.(d));
      }
      if ((h.hook_event_name === "PreToolUse" || h.hook_event_name === "PostToolUse") && opts.onStream) {
        opts.onStream({
          type: h.hook_event_name === "PreToolUse" ? "tool_use" : "tool_result",
          content: String(h.tool_name ?? ""),
          toolName: typeof h.tool_name === "string" ? h.tool_name : undefined,
        });
      }
    });

    if (warm) {
      this.injectPrompt(warm, opts);
      this.lifecycle.turnStarted(jinnSessionId);
    } else {
      const handle = this.spawn(jinnSessionId, opts, settingsPath);
      this.lifecycle.adopt(jinnSessionId, handle, { cronOrigin: opts.source === "cron" });
      this.lifecycle.turnStarted(jinnSessionId);
    }

    let result: EngineResult;
    try {
      result = await resolver.promise;
    } finally {
      entry.tailer?.stop();
      this.hookRegistry.unregister(jinnSessionId);
      this.active.delete(jinnSessionId);
      this.lifecycle.turnEnded(jinnSessionId); // manager decides kill vs keep-warm
    }

    // Reconstruct cost from the transcript (the Stop hook carries no cost).
    const transcriptPath = resolver.transcriptPath;
    if (transcriptPath && !result.error) {
      const cost = computeInteractiveCost(transcriptPath, opts.model);
      if (cost) { result.cost = cost.cost; result.numTurns = cost.turns; }
    }
    // Map a StopFailure rate-limit into result.rateLimit so manager.ts's
    // wait/retry/fallback machinery engages exactly as it does for `claude -p`.
    const rl = rateLimitFromStopFailure(resolver.stopFailure);
    if (rl) result.rateLimit = rl;
    return result;
  }

  /** Build the env passed to the claude PTY: inherits process.env but strips
   *  CLAUDECODE / CLAUDE_CODE_* so the child doesn't think it's nested, then
   *  enables fullscreen rendering. Shared by spawn() and ensureIdleSpawn(). */
  private buildPtyEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) continue;
      if (v !== undefined) env[k] = v;
    }
    env.CLAUDE_CODE_NO_FLICKER = "1"; // fullscreen mode — discrete bottom slot for CLI rendering
    return env;
  }

  /** Wrap a freshly-spawned pty.IPty in a PtyHandle and wire its output into
   *  the session's scrollback ring buffer + live subscribers. Optional onExitExtra
   *  runs on PTY exit (spawn() uses this to interrupt the active resolver). */
  private wireProcToStream(jinnSessionId: string, proc: pty.IPty, onExitExtra?: () => void): PtyHandle {
    const handle: PtyHandle = {
      pid: proc.pid,
      get killed() { return (proc as any)._exitCode != null; },
      kill: (signal?: string) => { try { proc.kill(signal); } catch { /* already gone */ } },
    } as PtyHandle;
    const stream = this.streamFor(jinnSessionId);
    proc.onData((d) => {
      stream.buffer = (stream.buffer + d).slice(-SCROLLBACK_CAP_BYTES);
      for (const cb of stream.subscribers) {
        try { cb(d); } catch { /* ignore subscriber errors */ }
      }
    });
    proc.onExit(() => {
      // Clear scrollback so a stale farewell (Claude's "Resume this session…" hint
      // printed on SIGHUP shutdown) doesn't persist into the next PTY incarnation.
      const s = this.streams.get(jinnSessionId);
      if (s) s.buffer = "";
      // Release the lifecycle entry so the dead handle isn't picked up by a future
      // run() as "warm" — that would inject into a corpse.
      this.lifecycle.releaseSession(jinnSessionId);
      onExitExtra?.();
    });
    (handle as any)._proc = proc;
    return handle;
  }

  /** node-pty spawn of the genuine claude binary (no -p → cc_entrypoint=cli). */
  private spawn(jinnSessionId: string, opts: EngineRunOpts, settingsPath: string): PtyHandle {
    const args = buildInteractiveArgs({
      prompt: opts.prompt,
      settingsPath,
      resumeSessionId: opts.resumeSessionId,
      model: opts.model,
      effortLevel: opts.effortLevel,
      mcpConfigPath: opts.mcpConfigPath,
      cliFlags: opts.cliFlags,
      attachments: opts.attachments,
    });
    const env = this.buildPtyEnv();
    const bin = opts.bin || "claude";
    logger.info(`InteractiveClaudeEngine spawning ${bin} (resume: ${opts.resumeSessionId || "none"})`);
    const proc = pty.spawn(bin, args, {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: opts.cwd || JINN_HOME,
      env,
    });
    return this.wireProcToStream(jinnSessionId, proc, () => {
      // PTY exited without a Stop hook (crash / early exit) — settle as interrupted.
      const e = this.active.get(jinnSessionId);
      e?.resolver.interrupt("Interrupted: claude process exited");
    });
  }

  /** Spawn an idle PTY that just loads the TUI on an existing Claude session id (no prompt → no turn).
   *  Used by /ws/pty/:sessionId so opening a CLI-mode chat shows the conversation history.
   *  Does NOTHING if a warm PTY already exists for the session. Does NOTHING if claudeSessionId is empty. */
  ensureIdleSpawn(jinnSessionId: string, opts: { claudeSessionId: string; cwd?: string; model?: string; bin?: string }): void {
    if (!opts.claudeSessionId) return;
    if (this.lifecycle.getWarm(jinnSessionId)) return;
    if (this.active.has(jinnSessionId)) return; // a turn is starting/running — let run() spawn
    // Spawn claude in PTY with --resume <id>, no prompt. Include --settings so hooks fire for future turns.
    const settingsPath = writeSessionSettings(CLAUDE_SETTINGS_DIR, jinnSessionId, {
      sessionId: jinnSessionId,
      relayScript: HOOK_RELAY_SCRIPT,
    });
    const args: string[] = [
      "--resume", opts.claudeSessionId,
      "--chrome",
      "--dangerously-skip-permissions",
      "--settings", settingsPath,
    ];
    if (opts.model) args.push("--model", opts.model);
    const env = this.buildPtyEnv();
    const bin = opts.bin || "claude";
    logger.info(`InteractiveClaudeEngine ensureIdleSpawn for session ${jinnSessionId} (resume ${opts.claudeSessionId})`);
    const proc = pty.spawn(bin, args, {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: opts.cwd || JINN_HOME,
      env,
    });
    const handle = this.wireProcToStream(jinnSessionId, proc);
    this.lifecycle.adopt(jinnSessionId, handle, { cronOrigin: false });
    this.lifecycle.markViewed(jinnSessionId); // grace-period applies — keeps it warm while user views
  }

  /** Inject a follow-up prompt into a warm PTY via bracketed-paste + CR. */
  private injectPrompt(handle: PtyHandle, opts: EngineRunOpts): void {
    const proc = (handle as any)._proc as pty.IPty | undefined;
    if (!proc) return;
    let text = opts.prompt;
    if (opts.attachments?.length) {
      text += "\n\nAttached files:\n" + opts.attachments.map((a) => `- ${a}`).join("\n");
    }
    // Phase 0 finding: bracketed-paste does NOT neutralize a leading /, @, or ! —
    // they still trigger the slash-command / mention / bash-mode handlers and the
    // turn is never submitted. Prepend a space so it's treated as a literal message.
    if (/^[/@!]/.test(text)) text = " " + text;
    proc.write(`\x1b[200~${text}\x1b[201~`);
    setTimeout(() => proc.write("\r"), 50); // small delay before submit — see Task 0.1
  }

  /** Lazily create (or fetch) the output stream entry for a Jinn session id. */
  private streamFor(sessionId: string): { buffer: string; subscribers: Set<(d: string) => void> } {
    let stream = this.streams.get(sessionId);
    if (!stream) {
      stream = { buffer: "", subscribers: new Set() };
      this.streams.set(sessionId, stream);
    }
    return stream;
  }

  /** Append-only capped output buffer for the session's current/most-recent PTY (for xterm.js reconnect replay). */
  getScrollback(sessionId: string): string {
    return this.streams.get(sessionId)?.buffer ?? "";
  }

  /** Subscribe to live PTY output for a session. Returns an unsubscribe fn. Survives PTY respawn within the session. */
  subscribeOutput(sessionId: string, cb: (data: string) => void): () => void {
    const stream = this.streamFor(sessionId);
    stream.subscribers.add(cb);
    return () => { stream.subscribers.delete(cb); };
  }

  /** Write raw text to the warm PTY as a bracketed-paste + CR (same /@!-guard as injectPrompt). No-op if no warm PTY. */
  writeStdin(sessionId: string, text: string): void {
    const handle = this.lifecycle.getWarm(sessionId);
    if (!handle) return;
    const proc = (handle as any)._proc as pty.IPty | undefined;
    if (!proc) return;
    let payload = text;
    // Bracketed-paste does NOT neutralize a leading /, @, or ! — prepend a space so
    // they're treated as a literal message (see injectPrompt).
    if (/^[/@!]/.test(payload)) payload = " " + payload;
    proc.write(`\x1b[200~${payload}\x1b[201~`);
    setTimeout(() => proc.write("\r"), 50);
  }

  /** Resize the warm PTY. No-op if no warm PTY. */
  resizePty(sessionId: string, cols: number, rows: number): void {
    const handle = this.lifecycle.getWarm(sessionId);
    if (!handle) return;
    const proc = (handle as any)._proc as pty.IPty | undefined;
    if (!proc) return;
    try { proc.resize(cols, rows); } catch { /* PTY gone */ }
  }

  kill(sessionId: string, reason = "Interrupted"): void {
    const e = this.active.get(sessionId);
    e?.resolver.interrupt(reason.startsWith("Interrupted") ? reason : `Interrupted: ${reason}`);
    this.lifecycle.releaseSession(sessionId);
  }

  killAll(): void {
    for (const id of [...this.active.keys()]) this.kill(id, "Interrupted: gateway shutting down");
    this.lifecycle.killAll();
  }

  /** True only while a turn is in flight (distinct from "PTY is warm"). */
  isTurnRunning(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  /** Toggle KEEP ALIVE for a session — forwards to the PTY lifecycle manager. */
  setKeepAlive(sessionId: string, on: boolean): void {
    this.lifecycle.setKeepAlive(sessionId, on);
  }

  /** True iff a warm PTY exists for this session (in the lifecycle manager). */
  hasWarmPty(sessionId: string): boolean {
    return this.lifecycle.getWarm(sessionId) !== undefined;
  }

  /** Refresh the lifecycle's lastViewedAt for the session (called when a browser tab
   *  views/interacts with the CLI terminal — keeps the warm PTY in the grace window). */
  markViewed(sessionId: string): void {
    this.lifecycle.markViewed(sessionId);
  }

  /** InterruptibleEngine.isAlive — true if a turn OR a warm PTY exists. */
  isAlive(sessionId: string): boolean {
    return this.active.has(sessionId) || this.lifecycle.getWarm(sessionId) !== undefined;
  }
}
