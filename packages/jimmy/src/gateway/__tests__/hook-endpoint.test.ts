import { describe, it, expect } from "vitest";
import { handleHookPost } from "../hook-endpoint.js";
import { HookRegistry } from "../hook-registry.js";

describe("handleHookPost", () => {
  it("rejects a wrong secret with 403", () => {
    const reg = new HookRegistry();
    const res = handleHookPost({ reg, secret: "sek", remoteAddress: "127.0.0.1" },
      "nope", { jinnSessionId: "s1", hook: { hook_event_name: "Stop" } });
    expect(res.status).toBe(403);
  });

  it("rejects a non-loopback remote with 403", () => {
    const reg = new HookRegistry();
    const res = handleHookPost({ reg, secret: "sek", remoteAddress: "10.0.0.5" },
      "sek", { jinnSessionId: "s1", hook: { hook_event_name: "Stop" } });
    expect(res.status).toBe(403);
  });

  it("delivers a valid hook to the registry and returns 200", () => {
    const reg = new HookRegistry();
    const seen: string[] = [];
    reg.register("s1", (h) => seen.push(h.hook_event_name));
    const res = handleHookPost({ reg, secret: "sek", remoteAddress: "127.0.0.1" },
      "sek", { jinnSessionId: "s1", hook: { hook_event_name: "Stop", last_assistant_message: "hi" } });
    expect(res.status).toBe(200);
    expect(seen).toEqual(["Stop"]);
  });

  it("returns 400 for a malformed body", () => {
    const reg = new HookRegistry();
    const res = handleHookPost({ reg, secret: "sek", remoteAddress: "127.0.0.1" }, "sek", {});
    expect(res.status).toBe(400);
  });
});
