import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Point the DB at a throwaway dir BEFORE importing the registry (SESSIONS_DB is
// resolved from JINN_HOME at module load).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-external-turns-"));
process.env.JINN_HOME = tmp;

type Reg = typeof import("../../sessions/registry.js");
type Ext = typeof import("../external-turns.js");
let reg: Reg;
let ext: Ext;

beforeAll(async () => {
  reg = await import("../../sessions/registry.js");
  ext = await import("../external-turns.js");
  reg.initDb();
});

let seq = 0;
function makeSession(overrides: Partial<{ engineSessionId: string }> = {}): string {
  seq += 1;
  const s = reg.createSession({
    engine: "claude",
    source: "web",
    sourceRef: `web:ext-${seq}`,
    prompt: "test",
  });
  if (overrides.engineSessionId) reg.updateSession(s.id, { engineSessionId: overrides.engineSessionId });
  return s.id;
}

/** Write a transcript jsonl of [role, text, isoTs, extra] tuples. */
function writeTranscript(
  entries: Array<{
    type: string;
    text?: string;
    ts: string;
    sidechain?: boolean;
    meta?: boolean;
    toolResult?: boolean;
    promptSource?: string;
    sourceTool?: boolean;
    originKind?: string;
    synthetic?: boolean;
  }>,
): string {
  const file = path.join(tmp, `transcript-${++seq}.jsonl`);
  const lines = entries.map((e) =>
    JSON.stringify({
      type: e.type,
      timestamp: e.ts,
      isSidechain: e.sidechain ?? false,
      ...(e.meta ? { isMeta: true } : {}),
      ...(e.promptSource ? { promptSource: e.promptSource } : {}),
      ...(e.sourceTool ? { sourceToolAssistantUUID: "assistant-tool", toolUseResult: { ok: true } } : {}),
      ...(e.originKind ? { origin: { kind: e.originKind } } : {}),
      message: {
        role: e.type,
        ...(e.synthetic ? { model: "<synthetic>" } : {}),
        content: e.toolResult
          ? [{ type: "tool_result", content: "tool output" }]
          : [{ type: "text", text: e.text ?? "" }],
      },
    }),
  );
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

describe("readTranscriptTail", () => {
  it("returns user/assistant text entries newer than the anchor, skipping sidechain/meta/tool-result entries", () => {
    const file = writeTranscript([
      { type: "user", text: "old prompt", ts: iso(60_000) },
      { type: "user", text: "hello", ts: iso(10_000) },
      { type: "assistant", text: "sub-agent text", ts: iso(9_000), sidechain: true },
      { type: "user", ts: iso(8_000), toolResult: true },
      { type: "user", text: "meta entry", ts: iso(7_000), meta: true },
      { type: "assistant", text: "the answer", ts: iso(5_000) },
    ]);
    const tail = ext.readTranscriptTail(file, Date.now() - 30_000);
    expect(tail).not.toBeNull();
    expect(tail!.map((e) => [e.role, e.content])).toEqual([
      ["user", "hello"],
      ["assistant", "the answer"],
    ]);
  });

  it("skips Claude control, compaction, task-notification, and tool-result transcript entries", () => {
    const file = writeTranscript([
      { type: "user", text: "typed prompt", ts: iso(14_000), promptSource: "typed" },
      { type: "user", text: "This session is being continued from a previous conversation that ran out of context.", ts: iso(13_000) },
      { type: "user", text: "<command-name>/compact</command-name>", ts: iso(12_000) },
      { type: "user", text: "<local-command-stdout>Compacted</local-command-stdout>", ts: iso(11_000) },
      { type: "user", text: "<task-notification><result>done</result></task-notification>", ts: iso(10_000), originKind: "task-notification" },
      { type: "user", text: "tool result text", ts: iso(9_000), sourceTool: true },
      { type: "user", text: "system continuation", ts: iso(8_000), promptSource: "system" },
      { type: "assistant", text: "No response requested.", ts: iso(7_000), synthetic: true },
      { type: "assistant", text: "real answer", ts: iso(6_000) },
    ]);
    const tail = ext.readTranscriptTail(file, Date.now() - 30_000);
    expect(tail!.map((e) => [e.role, e.content])).toEqual([
      ["user", "typed prompt"],
      ["assistant", "real answer"],
    ]);
  });

  it("returns null (not []) when the file is unreadable", () => {
    expect(ext.readTranscriptTail(path.join(tmp, "nope.jsonl"), 0)).toBeNull();
  });
});

describe("syncExternalTurn", () => {
  let events: Array<{ event: string; payload: unknown }>;
  const emit = (event: string, payload: unknown) => events.push({ event, payload });
  beforeEach(() => { events = []; });

  it("persists the transcript tail in order, advances the anchor, adopts the engine session id, and emits", () => {
    const id = makeSession();
    const file = writeTranscript([
      { type: "user", text: "cli prompt", ts: iso(10_000) },
      { type: "assistant", text: "cli answer", ts: iso(5_000) },
    ]);
    const n = ext.syncExternalTurn(id, emit, {
      hook_event_name: "Stop",
      session_id: "eng-abc",
      transcript_path: file,
      last_assistant_message: "cli answer",
    });
    expect(n).toBe(2);
    expect(reg.getMessages(id).map((m) => [m.role, m.content])).toEqual([
      ["user", "cli prompt"],
      ["assistant", "cli answer"],
    ]);
    const session = reg.getSession(id)!;
    expect(session.engineSessionId).toBe("eng-abc");
    expect((session.transportMeta as any)?.[ext.TRANSCRIPT_SYNC_META_KEY]).toBeTruthy();
    expect(events).toEqual([{ event: "session:external-turn", payload: { sessionId: id } }]);
  });

  it("is idempotent — a repeated Stop for the same turn inserts nothing (anchor dedup)", () => {
    const id = makeSession();
    const file = writeTranscript([
      { type: "user", text: "once", ts: iso(10_000) },
      { type: "assistant", text: "only once", ts: iso(5_000) },
    ]);
    const payload = { hook_event_name: "Stop", transcript_path: file, last_assistant_message: "only once" };
    expect(ext.syncExternalTurn(id, emit, payload)).toBe(2);
    expect(ext.syncExternalTurn(id, emit, payload)).toBe(0);
    expect(ext.syncExternalTurn(id, emit, payload)).toBe(0);
    expect(reg.getMessages(id)).toHaveLength(2);
    expect(events).toHaveLength(1); // emitted only for the real insert
  });

  it("a later turn appended to the same transcript syncs incrementally", () => {
    const id = makeSession();
    const file = writeTranscript([
      { type: "user", text: "turn one", ts: iso(20_000) },
      { type: "assistant", text: "answer one", ts: iso(15_000) },
    ]);
    const payload = { hook_event_name: "Stop", transcript_path: file, last_assistant_message: "answer one" };
    expect(ext.syncExternalTurn(id, emit, payload)).toBe(2);

    fs.appendFileSync(file, [
      JSON.stringify({ type: "user", timestamp: iso(8_000), isSidechain: false, message: { role: "user", content: [{ type: "text", text: "turn two" }] } }),
      JSON.stringify({ type: "assistant", timestamp: iso(4_000), isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: "answer two" }] } }),
    ].join("\n") + "\n");
    expect(ext.syncExternalTurn(id, emit, payload)).toBe(2);
    expect(reg.getMessages(id).map((m) => m.content)).toEqual(["turn one", "answer one", "turn two", "answer two"]);
  });

  it("without an anchor, entries older than the newest DB message are never re-inserted", () => {
    const id = makeSession();
    // A gateway-run turn already persisted its messages (DB insert time = now).
    reg.insertMessage(id, "user", "gateway prompt");
    reg.insertMessage(id, "assistant", "gateway answer");
    // The transcript holds that same (older) turn plus nothing new.
    const file = writeTranscript([
      { type: "user", text: "gateway prompt", ts: iso(10_000) },
      { type: "assistant", text: "gateway answer", ts: iso(5_000) },
    ]);
    const n = ext.syncExternalTurn(id, emit, { hook_event_name: "Stop", transcript_path: file, last_assistant_message: "gateway answer" });
    expect(n).toBe(0);
    expect(reg.getMessages(id)).toHaveLength(2);
  });

  it("skips a session whose run() is in flight (status running)", () => {
    const id = makeSession();
    reg.updateSession(id, { status: "running" });
    const file = writeTranscript([{ type: "assistant", text: "mid-turn", ts: iso(1_000) }]);
    expect(ext.syncExternalTurn(id, emit, { hook_event_name: "Stop", transcript_path: file, last_assistant_message: "mid-turn" })).toBe(0);
    expect(reg.getMessages(id)).toHaveLength(0);
  });

  it("falls back to the hook payload text when the transcript is unreadable — once", () => {
    const id = makeSession({ engineSessionId: "no-such-claude-session" });
    const payload = {
      hook_event_name: "Stop",
      transcript_path: path.join(tmp, "missing.jsonl"),
      last_assistant_message: "answer from hook",
    };
    expect(ext.syncExternalTurn(id, emit, payload)).toBe(1);
    expect(reg.getMessages(id).map((m) => [m.role, m.content])).toEqual([["assistant", "answer from hook"]]);
    // Redelivered Stop with the same text → deduped against the newest message.
    expect(ext.syncExternalTurn(id, emit, payload)).toBe(0);
    expect(reg.getMessages(id)).toHaveLength(1);
  });
});
