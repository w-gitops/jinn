import { describe, it, expect, beforeEach } from "vitest";
import type { JinnConfig } from "../../shared/types.js";
import { validateSessionPatch } from "../session-patch.js";
import { invalidateModelRegistry } from "../../shared/models.js";

function cfg(): JinnConfig {
  return {
    gateway: { port: 7777, host: "127.0.0.1" },
    engines: {
      default: "claude",
      claude: { bin: "claude", model: "opus" },
      codex: { bin: "codex", model: "gpt-5.4" },
      antigravity: { model: "gemini-3-flash-preview" },
    },
    models: {
      claude: {
        default: "opus",
        models: [
          { id: "opus", label: "Opus 4.8", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
          { id: "claude-sonnet-4-6", label: "Sonnet 4.6", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
        ],
      },
      codex: { default: "gpt-5.4", models: [{ id: "gpt-5.4", supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh"] }] },
      antigravity: { models: [{ id: "gemini-3-flash-preview", supportsEffort: false, effortLevels: [] }] },
    },
    connectors: {},
  } as unknown as JinnConfig;
}

beforeEach(() => invalidateModelRegistry());

describe("validateSessionPatch", () => {
  it("accepts a valid model switch for the engine", () => {
    const r = validateSessionPatch(cfg(), "claude", "opus", { model: "claude-sonnet-4-6" });
    expect(r.ok).toBe(true);
    expect(r.updates).toEqual({ model: "claude-sonnet-4-6" });
  });

  it("accepts a valid effort switch", () => {
    const r = validateSessionPatch(cfg(), "codex", "gpt-5.4", { effortLevel: "xhigh" });
    expect(r.ok).toBe(true);
    expect(r.updates).toEqual({ effortLevel: "xhigh" });
  });

  it("accepts model + effort together, validating effort against the NEW model", () => {
    const r = validateSessionPatch(cfg(), "claude", "opus", { model: "claude-sonnet-4-6", effortLevel: "high" });
    expect(r.ok).toBe(true);
    expect(r.updates).toEqual({ model: "claude-sonnet-4-6", effortLevel: "high" });
  });

  it("rejects an unknown model for the engine", () => {
    const r = validateSessionPatch(cfg(), "claude", "opus", { model: "gpt-4o" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unknown model/i);
  });

  it("rejects an effort level not valid for the model", () => {
    const r = validateSessionPatch(cfg(), "claude", "opus", { effortLevel: "xhigh" }); // claude has no xhigh
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/invalid effortLevel/i);
  });

  it("rejects effort for a model that doesn't support effort (antigravity)", () => {
    const r = validateSessionPatch(cfg(), "antigravity", "gemini-3-flash-preview", { effortLevel: "high" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/does not support effort/i);
  });

  it("allows switching antigravity model (persisted; runtime no-op handled at engine layer)", () => {
    const c = cfg();
    c.models!.antigravity!.models.push({ id: "gemini-3-pro-preview", supportsEffort: false, effortLevels: [] });
    invalidateModelRegistry();
    const r = validateSessionPatch(c, "antigravity", "gemini-3-flash-preview", { model: "gemini-3-pro-preview" });
    expect(r.ok).toBe(true);
    expect(r.updates).toEqual({ model: "gemini-3-pro-preview" });
  });

  it("rejects empty/typeless input", () => {
    expect(validateSessionPatch(cfg(), "claude", "opus", {}).ok).toBe(false);
    expect(validateSessionPatch(cfg(), "claude", "opus", { model: 123 as unknown }).ok).toBe(false);
    expect(validateSessionPatch(cfg(), "claude", "opus", { effortLevel: "" }).ok).toBe(false);
  });
});
