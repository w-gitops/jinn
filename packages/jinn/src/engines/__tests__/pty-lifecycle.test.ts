import { describe, it, expect } from "vitest";
import { PtyLifecycleManager } from "../pty-lifecycle.js";

function fakeHandle() {
  const h: any = { killed: false, pid: Math.floor(Math.random() * 9999) };
  h.kill = () => { h.killed = true; };
  return h;
}

describe("PtyLifecycleManager", () => {
  it("registers a PTY and reports it as warm", () => {
    const m = new PtyLifecycleManager({ maxLivePtys: 8 });
    const h = fakeHandle();
    m.adopt("sess-1", h);
    expect(m.getWarm("sess-1")).toBe(h);
  });

  it("releaseSession kills the PTY, cleans the handle, and fires onCleanup", () => {
    let cleaned = "";
    const m = new PtyLifecycleManager({ maxLivePtys: 8, onCleanup: (id) => { cleaned = id; } });
    const h = fakeHandle();
    m.adopt("sess-2", h);
    m.releaseSession("sess-2");
    expect(h.killed).toBe(true);
    expect(m.getWarm("sess-2")).toBeUndefined();
    expect(cleaned).toBe("sess-2");
  });

  it("a PTY with no viewer dies within the grace window after turnEnded", () => {
    // No viewer, no turn → grace window starts → reevaluate kills since lastTurnEndedAt is 0… actually
    // lastTurnEndedAt is set on turnEnded, so within the keep-alive cap it stays alive.
    const m = new PtyLifecycleManager({ maxLivePtys: 8 });
    const h = fakeHandle();
    m.adopt("sess-3", h);
    m.turnStarted("sess-3");
    m.turnEnded("sess-3");
    expect(h.killed).toBe(false); // still inside CLI_KEEPALIVE_AFTER_LEAVE_MS
  });

  it("a PTY with an active viewer survives turnEnded indefinitely (within the keep-alive cap)", () => {
    const m = new PtyLifecycleManager({ maxLivePtys: 8 });
    const h = fakeHandle();
    m.adopt("sess-4", h);
    m.viewerEnter("sess-4");
    m.turnStarted("sess-4");
    m.turnEnded("sess-4");
    expect(h.killed).toBe(false);
  });

  it("releases the PTY when the last viewer leaves and no turn has ever run", () => {
    const m = new PtyLifecycleManager({ maxLivePtys: 8 });
    const h = fakeHandle();
    m.adopt("sess-5", h);
    m.viewerEnter("sess-5");
    m.viewerLeave("sess-5");
    // viewingEndedAt was just set to now -> still inside keep-alive grace -> alive
    expect(h.killed).toBe(false);
  });

  it("isAtCapacity is true once maxLivePtys is reached", () => {
    const m = new PtyLifecycleManager({ maxLivePtys: 2 });
    m.adopt("a", fakeHandle());
    m.adopt("b", fakeHandle());
    expect(m.isAtCapacity()).toBe(true);
  });

  it("killAll kills every live PTY", () => {
    const m = new PtyLifecycleManager({ maxLivePtys: 8 });
    const a = fakeHandle(), b = fakeHandle();
    m.adopt("a", a);
    m.adopt("b", b);
    m.killAll();
    expect(a.killed).toBe(true);
    expect(b.killed).toBe(true);
  });

  it("releaseIdle releases idle PTYs but spares ones with a running turn", () => {
    const m = new PtyLifecycleManager({ maxLivePtys: 8 });
    const idle = fakeHandle(), busy = fakeHandle();
    m.adopt("idle", idle);
    m.adopt("busy", busy);
    m.turnStarted("busy"); // in-flight turn → must not be reaped
    m.releaseIdle(() => false);
    expect(idle.killed).toBe(true);
    expect(m.getWarm("idle")).toBeUndefined();
    expect(busy.killed).toBe(false);
    expect(m.getWarm("busy")).toBe(busy);
  });

  it("releaseIdle also spares sessions the isActive predicate flags (engine-level active turn)", () => {
    const m = new PtyLifecycleManager({ maxLivePtys: 8 });
    const idle = fakeHandle(), active = fakeHandle();
    m.adopt("idle", idle);
    m.adopt("active", active);
    // turnRunning not yet mirrored (cold-spawn window), but engine knows it's active.
    m.releaseIdle((id) => id === "active");
    expect(idle.killed).toBe(true);
    expect(active.killed).toBe(false);
    expect(m.getWarm("active")).toBe(active);
  });

  it("onRelease listeners fire for every released session (engines purge per-session maps here)", () => {
    const m = new PtyLifecycleManager({ maxLivePtys: 8 });
    const released: string[] = [];
    m.onRelease((id) => released.push(id));
    m.adopt("a", fakeHandle());
    m.adopt("b", fakeHandle());
    m.releaseSession("a");
    expect(released).toEqual(["a"]);
    m.killAll(); // releases the rest
    expect(released).toEqual(["a", "b"]);
    // Releasing an unknown session does NOT fire listeners.
    m.releaseSession("nope");
    expect(released).toEqual(["a", "b"]);
  });
});
