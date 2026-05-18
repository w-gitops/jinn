import { describe, it, expect } from "vitest";
import { normalizeClaudeEngineConfig } from "../config.js";

describe("normalizeClaudeEngineConfig", () => {
  it("applies the maxLivePtys default", () => {
    const out = normalizeClaudeEngineConfig({ bin: "claude", model: "opus" });
    expect(out.maxLivePtys).toBe(8);
  });

  it("preserves a configured maxLivePtys", () => {
    const out = normalizeClaudeEngineConfig({ bin: "claude", model: "opus", maxLivePtys: 16 });
    expect(out.maxLivePtys).toBe(16);
  });
});
