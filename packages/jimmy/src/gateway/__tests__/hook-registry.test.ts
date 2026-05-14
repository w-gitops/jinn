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
  });
});
