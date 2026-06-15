import { describe, it, expect, beforeAll, vi } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

// Throwaway DB before importing the registry (SESSIONS_DB resolves from JINN_HOME).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-partial-"));
process.env.JINN_HOME = tmp;

type Reg = typeof import("../registry.js");
let reg: Reg;

function newSession(id: string): void {
  reg.initDb().prepare(
    "INSERT INTO sessions (id, engine, source, source_ref, status, created_at, last_activity) VALUES (?, 'claude','web',?, 'running','t','t')",
  ).run(id, `web:${id}`);
}

beforeAll(async () => {
  reg = await import("../registry.js");
});

describe("messages partial (mid-turn streaming) blocks", () => {
  it("adds nullable partial/seq/tool_call columns on init", () => {
    const db = reg.initDb();
    const cols = (db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("partial");
    expect(cols).toContain("seq");
    expect(cols).toContain("tool_call");
  });

  it("persists partial blocks in seq order with tool metadata, then wipes them", () => {
    newSession("p1");
    // Simulate a turn: text block, tool call, text block.
    const t1 = reg.insertPartialMessage("p1", "assistant", "Let me check", 0);
    reg.insertPartialMessage("p1", "assistant", "Using Bash", 1, "Bash");
    reg.insertPartialMessage("p1", "assistant", "Found it", 2);

    let msgs = reg.getMessages("p1");
    expect(msgs.map((m) => m.content)).toEqual(["Let me check", "Using Bash", "Found it"]);
    expect(msgs.every((m) => m.partial === true)).toBe(true);
    expect(msgs[1].toolCall).toBe("Bash");
    expect(msgs[0].toolCall).toBeUndefined();

    // Growing the current text block in place (debounced streaming).
    reg.updatePartialMessage(t1, "Let me check the logs");
    expect(reg.getMessages("p1")[0].content).toBe("Let me check the logs");

    // Turn end: wipe partials, insert the single consolidated final message.
    const removed = reg.deletePartialMessages("p1");
    expect(removed).toBe(3);
    reg.insertMessage("p1", "assistant", "Done — found the bug in logs.");

    msgs = reg.getMessages("p1");
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("Done — found the bug in logs.");
    expect(msgs[0].partial).toBeUndefined();
  });

  it("orders blocks by seq even when timestamps collide", () => {
    newSession("p2");
    const now = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    // Insert out of seq order; getMessages must return them seq-ascending.
    try {
      reg.insertPartialMessage("p2", "assistant", "third", 2);
      reg.insertPartialMessage("p2", "assistant", "first", 0);
      reg.insertPartialMessage("p2", "assistant", "second", 1);
      expect(reg.getMessages("p2").map((m) => m.content)).toEqual(["first", "second", "third"]);
    } finally {
      now.mockRestore();
    }
  });

  it("deletePartialMessages leaves final (non-partial) rows untouched", () => {
    newSession("p3");
    reg.insertMessage("p3", "user", "hi");
    reg.insertMessage("p3", "assistant", "a real prior answer");
    reg.insertPartialMessage("p3", "assistant", "streaming...", 0);

    expect(reg.deletePartialMessages("p3")).toBe(1);
    const msgs = reg.getMessages("p3");
    expect(msgs.map((m) => m.content)).toEqual(["hi", "a real prior answer"]);
  });

  it("can finalize partial blocks into canonical history", () => {
    newSession("p3b");
    reg.insertPartialMessage("p3b", "assistant", "Using run_command", 0, "run_command");
    reg.insertPartialMessage("p3b", "assistant", "Done", 1);

    expect(reg.finalizePartialMessages("p3b")).toBe(2);
    const msgs = reg.getMessages("p3b");
    expect(msgs.map((m) => m.content)).toEqual(["Using run_command", "Done"]);
    expect(msgs.some((m) => m.partial)).toBe(false);
    expect(msgs[0].toolCall).toBe("run_command");
  });

  it("clearAllPartialMessages sweeps strays across sessions (boot recovery)", () => {
    newSession("p4");
    newSession("p5");
    reg.insertPartialMessage("p4", "assistant", "stray a", 0);
    reg.insertPartialMessage("p5", "assistant", "stray b", 0);
    reg.insertMessage("p4", "assistant", "kept");

    const swept = reg.clearAllPartialMessages();
    expect(swept).toBeGreaterThanOrEqual(2);
    expect(reg.getMessages("p4").map((m) => m.content)).toEqual(["kept"]);
    expect(reg.getMessages("p5")).toHaveLength(0);
  });

  it("migrates a legacy message DB lacking the new columns", () => {
    const legacyPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jinn-legacy-p-")), "legacy.db");
    const legacy = new Database(legacyPath);
    legacy.exec(
      "CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, timestamp INTEGER NOT NULL)",
    );
    legacy.prepare("INSERT INTO messages (id, session_id, role, content, timestamp) VALUES ('m1','s','user','old',1)").run();

    reg.migrateMessagesSchema(legacy);

    const cols = (legacy.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain("partial");
    expect(cols).toContain("seq");
    expect(cols).toContain("tool_call");
    const row = legacy.prepare("SELECT content, partial, seq, tool_call FROM messages WHERE id='m1'").get() as Record<string, unknown>;
    expect(row.content).toBe("old");
    expect(row.partial).toBeNull();
    legacy.close();
  });
});
