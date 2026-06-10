import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The PTY is mocked. `spawn()` records the (bin, args) it was called with into
 * `spawnCalls` and returns a controllable fake IPty, so the effort/model arg
 * plumbing and the respawn-on-param-change behaviour can be asserted without a
 * real codex process.
 */
interface FakePty {
  pid: number;
  _exitCode: number | null;
  onData: (cb: (d: string) => void) => void;
  onExit: (cb: (e: { exitCode: number }) => void) => void;
  on: (event: string, cb: (...a: any[]) => void) => void;
  kill: (sig?: string) => void;
  resize: (cols: number, rows: number) => void;
  write: (data: string) => void;
  _exit: (code?: number) => void;
}

interface SpawnCall { bin: string; args: string[]; proc: FakePty }

const spawnCalls: SpawnCall[] = [];

function makeFakePty(): FakePty {
  let exitCb: ((e: { exitCode: number }) => void) | undefined;
  const p: FakePty = {
    pid: 5252,
    _exitCode: null,
    onData: () => {},
    onExit: (cb) => { exitCb = cb; },
    on: () => {},
    kill: () => {},
    resize: () => {},
    write: () => {},
    _exit: (code = 0) => { p._exitCode = code; exitCb?.({ exitCode: code }); },
  };
  return p;
}

vi.mock("node-pty", () => ({
  spawn: vi.fn((bin: string, args: string[]) => {
    const proc = makeFakePty();
    spawnCalls.push({ bin, args, proc });
    return proc as unknown as import("node-pty").IPty;
  }),
}));

import { codexTranscriptLineToDeltas, CodexInteractiveEngine } from "../codex-interactive.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";

/** Find the `-c model_reasoning_effort="..."` value in a codex arg list, if present. */
function reasoningEffortArg(args: string[]): string | undefined {
  const i = args.indexOf("-c");
  if (i < 0) return undefined;
  const m = /^model_reasoning_effort="(.*)"$/.exec(args[i + 1] ?? "");
  return m?.[1];
}

beforeEach(() => {
  spawnCalls.length = 0;
});

describe("CodexInteractiveEngine transcript parsing", () => {
  it("extracts the session id from session_meta", () => {
    const parsed = codexTranscriptLineToDeltas(JSON.stringify({
      type: "session_meta",
      payload: { id: "codex-session-1" },
    }));
    expect(parsed.sessionId).toBe("codex-session-1");
    expect(parsed.deltas).toEqual([]);
  });

  it("maps assistant messages to text deltas and doneText", () => {
    const parsed = codexTranscriptLineToDeltas(JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "done" }],
      },
    }));
    expect(parsed.doneText).toBe("done");
    expect(parsed.deltas).toEqual([{ type: "text", content: "done" }]);
  });

  it("maps function calls to tool deltas", () => {
    expect(codexTranscriptLineToDeltas(JSON.stringify({
      type: "response_item",
      payload: { type: "function_call", name: "exec_command", call_id: "call-1" },
    })).deltas).toEqual([{
      type: "tool_use",
      content: "Using exec_command",
      toolName: "exec_command",
      toolId: "call-1",
    }]);

    expect(codexTranscriptLineToDeltas(JSON.stringify({
      type: "response_item",
      payload: { type: "function_call_output", call_id: "call-1" },
    })).deltas).toEqual([{
      type: "tool_result",
      content: "Done",
      toolId: "call-1",
    }]);
  });

  it("uses last_token_usage for context deltas", () => {
    const parsed = codexTranscriptLineToDeltas(JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: 9_282_000 },
          last_token_usage: { input_tokens: 42_000 },
        },
      },
    }));
    expect(parsed.contextTokens).toBe(42_000);
    expect(parsed.deltas).toEqual([{ type: "context", content: "42000" }]);
  });

  it("omits the context update when only cumulative total_token_usage is present (no impossible meter)", () => {
    // A long codex session: total_token_usage is the running cumulative input
    // billed across ALL turns (here below the 1M guard, but still NOT the context
    // window fill). With no last_token_usage we must emit nothing rather than
    // surface the cumulative figure as the meter value.
    const parsed = codexTranscriptLineToDeltas(JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: { input_tokens: 800_000 } },
      },
    }));
    expect(parsed.contextTokens).toBeUndefined();
    expect(parsed.deltas).toEqual([]);
  });

  it("omits the context update when last_token_usage input_tokens is zero/missing", () => {
    const parsed = codexTranscriptLineToDeltas(JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: { input_tokens: 500_000 },
          last_token_usage: { output_tokens: 10 },
        },
      },
    }));
    expect(parsed.contextTokens).toBeUndefined();
    expect(parsed.deltas).toEqual([]);
  });
});

describe("codexTranscriptLineToDeltas — terminal markers", () => {
  it("parses task_complete with last_agent_message", () => {
    const line = JSON.stringify({
      timestamp: "2026-06-10T06:19:26.649Z",
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "t-1", last_agent_message: "All done." },
    });
    const parsed = codexTranscriptLineToDeltas(line);
    expect(parsed.taskComplete).toEqual({ lastAgentMessage: "All done." });
    expect(parsed.deltas).toEqual([]);
  });

  it("parses task_complete without last_agent_message", () => {
    const line = JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "t-2" } });
    expect(codexTranscriptLineToDeltas(line).taskComplete).toEqual({ lastAgentMessage: undefined });
  });

  it("parses turn_aborted", () => {
    const line = JSON.stringify({ type: "event_msg", payload: { type: "turn_aborted", turn_id: "t-3" } });
    expect(codexTranscriptLineToDeltas(line).turnAborted).toBe(true);
  });

  it("other event_msg payloads carry no terminal markers", () => {
    const line = JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "t-4" } });
    const parsed = codexTranscriptLineToDeltas(line);
    expect(parsed.taskComplete).toBeUndefined();
    expect(parsed.turnAborted).toBeUndefined();
  });
});

describe("CodexInteractiveEngine — effort/model PTY args + respawn", () => {
  let lifecycle: PtyLifecycleManager;
  let engine: CodexInteractiveEngine;

  beforeEach(() => {
    lifecycle = new PtyLifecycleManager({ maxLivePtys: 8 });
    engine = new CodexInteractiveEngine(lifecycle);
  });

  function lastArgs(): string[] {
    return spawnCalls[spawnCalls.length - 1]!.args;
  }

  it("forwards model and effortLevel into the idle-spawned codex CLI args", () => {
    engine.ensureIdleSpawn("sess-1", {
      model: "gpt-5.5",
      effortLevel: "high",
      cwd: "/tmp",
      cols: 100,
      rows: 40,
    });
    const args = lastArgs();
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-5.5");
    expect(reasoningEffortArg(args)).toBe("high");
    lifecycle.dispose();
  });

  it("drops Claude-only --chrome cliFlags before spawning the interactive codex PTY", async () => {
    const run = engine.run({
      prompt: "hello",
      sessionId: "sess-flags",
      cwd: "/tmp",
      model: "gpt-5.5",
      cliFlags: ["--chrome", "--some-codex-flag"],
    } as any);
    const args = lastArgs();
    expect(args).not.toContain("--chrome");
    expect(args).toContain("--some-codex-flag");
    spawnCalls[spawnCalls.length - 1]!.proc._exit(0);
    await run;
    lifecycle.dispose();
  });

  it('omits the reasoning-effort flag when effortLevel is "default" or absent', () => {
    engine.ensureIdleSpawn("sess-default", { model: "gpt-5.5", effortLevel: "default" });
    expect(reasoningEffortArg(lastArgs())).toBeUndefined();

    engine.ensureIdleSpawn("sess-none", { model: "gpt-5.5" });
    expect(reasoningEffortArg(lastArgs())).toBeUndefined();
    lifecycle.dispose();
  });

  it("does NOT respawn the idle PTY when model/effort are unchanged", () => {
    engine.ensureIdleSpawn("sess-2", { model: "gpt-5.5", effortLevel: "low" });
    expect(spawnCalls).toHaveLength(1);
    // Same params again (e.g. a reconnecting viewer) — reuse the warm PTY.
    engine.ensureIdleSpawn("sess-2", { model: "gpt-5.5", effortLevel: "low" });
    expect(spawnCalls).toHaveLength(1);
    lifecycle.dispose();
  });

  it("respawns the idle PTY when effortLevel changes (CLI binds effort at spawn)", () => {
    engine.ensureIdleSpawn("sess-3", { model: "gpt-5.5", effortLevel: "low" });
    expect(spawnCalls).toHaveLength(1);
    engine.ensureIdleSpawn("sess-3", { model: "gpt-5.5", effortLevel: "high" });
    expect(spawnCalls).toHaveLength(2);
    expect(reasoningEffortArg(lastArgs())).toBe("high");
    lifecycle.dispose();
  });

  it("respawns the idle PTY when the model changes", () => {
    engine.ensureIdleSpawn("sess-4", { model: "gpt-5.5", effortLevel: "medium" });
    expect(spawnCalls).toHaveLength(1);
    engine.ensureIdleSpawn("sess-4", { model: "gpt-5.5-codex", effortLevel: "medium" });
    expect(spawnCalls).toHaveLength(2);
    const args = lastArgs();
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-5.5-codex");
    lifecycle.dispose();
  });
});
