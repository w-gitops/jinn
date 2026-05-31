import { describe, it, expect, beforeEach } from "vitest";
import type { JinnConfig } from "../types.js";
import { getModelRegistry, invalidateModelRegistry, synthesizeFromEngineConfig } from "../models.js";

function cfg(partial: Partial<JinnConfig["engines"]>, models?: JinnConfig["models"]): JinnConfig {
  return {
    gateway: { port: 7777, host: "127.0.0.1" },
    engines: {
      default: "claude",
      claude: { bin: "claude", model: "opus" },
      codex: { bin: "codex", model: "gpt-5.3-codex" },
      ...partial,
    },
    models,
    connectors: {},
  } as JinnConfig;
}

beforeEach(() => invalidateModelRegistry());

describe("synthesizeFromEngineConfig (backward-compat fallback)", () => {
  it("builds an entry per engine from engines.<name>.model", () => {
    const reg = synthesizeFromEngineConfig(cfg({}));
    expect(reg.claude.models[0].id).toBe("opus");
    expect(reg.claude.defaultModel).toBe("opus");
    expect(reg.codex.models[0].id).toBe("gpt-5.3-codex");
    expect(reg.antigravity.models[0].id).toBe("gemini-3-flash-preview");
  });

  it("uses per-engine effort semantics: claude flag (low/med/high), codex config (incl xhigh), antigravity none", () => {
    const reg = synthesizeFromEngineConfig(cfg({}));
    expect(reg.claude.effortMechanism).toBe("claude-flag");
    expect(reg.claude.models[0].effortLevels).toEqual(["low", "medium", "high"]);
    expect(reg.codex.effortMechanism).toBe("codex-config");
    expect(reg.codex.models[0].effortLevels).toContain("xhigh");
    expect(reg.antigravity.effortMechanism).toBe("none");
    expect(reg.antigravity.models[0].supportsEffort).toBe(false);
    expect(reg.antigravity.models[0].effortLevels).toEqual([]);
  });
});

describe("getModelRegistry with a models: block", () => {
  const models: JinnConfig["models"] = {
    claude: {
      default: "claude-opus-4-8",
      effortMechanism: "claude-flag",
      models: [
        { id: "claude-opus-4-8", label: "Opus 4.8", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
        { id: "claude-sonnet-4-6", label: "Sonnet 4.6", supportsEffort: true, effortLevels: ["low", "medium", "high"] },
      ],
    },
    codex: {
      default: "gpt-5.3-codex",
      models: [{ id: "gpt-5.3-codex", label: "GPT-5.3 Codex", supportsEffort: true, effortLevels: ["low", "medium", "high", "xhigh"] }],
    },
    antigravity: {
      models: [{ id: "gemini-3-flash-preview", label: "Gemini 3 Flash", supportsEffort: false, effortLevels: [] }],
    },
  };

  it("honors the configured models, labels, and effort levels", () => {
    const reg = getModelRegistry(cfg({}, models));
    expect(reg.claude.models.map((m) => m.id)).toEqual(["claude-opus-4-8", "claude-sonnet-4-6"]);
    expect(reg.claude.models[0].label).toBe("Opus 4.8");
    expect(reg.codex.models[0].effortLevels).toContain("xhigh");
    expect(reg.antigravity.models[0].supportsEffort).toBe(false);
  });

  it("resolves defaultModel from block.default, else the first model", () => {
    const reg = getModelRegistry(cfg({}, models));
    expect(reg.claude.defaultModel).toBe("claude-opus-4-8");
    expect(reg.antigravity.defaultModel).toBe("gemini-3-flash-preview"); // no default → first
  });
});

describe("cache + invalidate", () => {
  it("caches across calls and refreshes only after invalidate", () => {
    const a = getModelRegistry(cfg({}));
    const b = getModelRegistry(cfg({ claude: { bin: "claude", model: "CHANGED" } }));
    expect(b).toBe(a); // cached — ignores the new config until invalidated
    invalidateModelRegistry();
    const c = getModelRegistry(cfg({ claude: { bin: "claude", model: "CHANGED" } }));
    expect(c.claude.models[0].id).toBe("CHANGED");
  });
});
