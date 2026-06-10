import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

// Point the DB at a throwaway dir BEFORE importing the registry (SESSIONS_DB is
// resolved from JINN_HOME at module load).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jinn-reconciler-"));
process.env.JINN_HOME = tmp;

type Reg = typeof import("../../sessions/registry.js");
type Rec = typeof import("../status-reconciler.js");
let reg: Reg;
let rec: Rec;
let db: import("better-sqlite3").Database;

function insert(id: string, status: string, lastActivity: string, engine = "claude") {
  db.prepare(
    `INSERT INTO sessions (id, engine, source, source_ref, status, created_at, last_activity)
     VALUES (?, ?, 'web', ?, ?, ?, ?)`,
  ).run(id, engine, `web:${id}`, status, lastActivity, lastActivity);
}

const NOW = new Date("2026-06-10T12:00:00.000Z").getTime();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function fakeEngine(turnRunning: boolean) {
  return { name: "claude", run: async () => ({ sessionId: "", result: "" }), isTurnRunning: () => turnRunning } as any;
}

beforeAll(async () => {
  reg = await import("../../sessions/registry.js");
  rec = await import("../status-reconciler.js");
  db = reg.initDb();
});

beforeEach(() => {
  db.prepare("DELETE FROM sessions").run();
});

describe("status reconciler sweepOnce", () => {
  it("resets a stale running session whose engine reports no turn", () => {
    insert("stuck-1", "running", iso(120_000));
    const events: any[] = [];
    const fixed = rec.sweepOnce({
      engines: new Map([["claude", fakeEngine(false)]]),
      emit: (event, payload) => events.push({ event, payload }),
      now: () => NOW,
    });
    expect(fixed).toBe(1);
    expect(reg.getSession("stuck-1")?.status).toBe("idle");
    expect(events).toEqual([
      { event: "session:completed", payload: expect.objectContaining({ sessionId: "stuck-1" }) },
    ]);
  });

  it("leaves a running session with a FRESH heartbeat alone", () => {
    insert("live-1", "running", iso(10_000)); // heartbeat 10s ago — turn in flight
    const fixed = rec.sweepOnce({ engines: new Map([["claude", fakeEngine(false)]]), emit: () => {}, now: () => NOW });
    expect(fixed).toBe(0);
    expect(reg.getSession("live-1")?.status).toBe("running");
  });

  it("leaves a stale running session alone when the engine still reports a turn", () => {
    insert("working-1", "running", iso(120_000));
    const fixed = rec.sweepOnce({ engines: new Map([["claude", fakeEngine(true)]]), emit: () => {}, now: () => NOW });
    expect(fixed).toBe(0);
    expect(reg.getSession("working-1")?.status).toBe("running");
  });

  it("ignores idle sessions and unknown engines", () => {
    insert("idle-1", "idle", iso(999_000));
    insert("ghost-1", "running", iso(120_000), "no-such-engine");
    const fixed = rec.sweepOnce({ engines: new Map(), emit: () => {}, now: () => NOW });
    // Unknown engine → no live turn possible → unstick it too.
    expect(fixed).toBe(1);
    expect(reg.getSession("idle-1")?.status).toBe("idle");
    expect(reg.getSession("ghost-1")?.status).toBe("idle");
  });
});
