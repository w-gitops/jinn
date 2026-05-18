import { describe, it, expect } from "vitest";
import { HookRegistry } from "../hook-registry.js";

describe("HookRegistry", () => {
  it("delivers a hook that arrives AFTER registration", () => {
    const reg = new HookRegistry();
    const seen: string[] = [];
    reg.register("s1", (h) => seen.push(h.hook_event_name));
    reg.deliver("s1", { hook_event_name: "SessionStart" } as any);
    expect(seen).toEqual(["SessionStart"]);
  });

  it("buffers a hook that arrives BEFORE registration and drains on register", () => {
    const reg = new HookRegistry();
    const seen: string[] = [];
    reg.deliver("s2", { hook_event_name: "SessionStart" } as any);
    expect(seen).toEqual([]);
    reg.register("s2", (h) => seen.push(h.hook_event_name));
    expect(seen).toEqual(["SessionStart"]);
  });

  it("unregister stops delivery and clears buffer", () => {
    const reg = new HookRegistry();
    const seen: string[] = [];
    reg.register("s3", (h) => seen.push(h.hook_event_name));
    reg.unregister("s3");
    reg.deliver("s3", { hook_event_name: "Stop" } as any);
    expect(seen).toEqual([]);
  });

  it("drops buffered hooks past TTL", async () => {
    const reg = new HookRegistry(20); // 20ms TTL
    reg.deliver("s4", { hook_event_name: "SessionStart" } as any);
    await new Promise((r) => setTimeout(r, 40));
    const seen: string[] = [];
    reg.register("s4", (h) => seen.push(h.hook_event_name));
    expect(seen).toEqual([]);
    reg.dispose();
  });

  it("periodic sweep evicts buffered entries past TTL even without register", async () => {
    const reg = new HookRegistry(20, 10); // 20ms TTL, 10ms sweep
    reg.deliver("s5", { hook_event_name: "SessionStart" } as any);
    // Access internal buffer for assertion — keep registry visibility minimal.
    const buf = (reg as unknown as { buffer: Map<string, unknown[]> }).buffer;
    expect(buf.has("s5")).toBe(true);
    await new Promise((r) => setTimeout(r, 80));
    expect(buf.has("s5")).toBe(false);
    reg.dispose();
  });
});
