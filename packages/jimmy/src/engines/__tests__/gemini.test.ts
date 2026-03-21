import { describe, it, expect, vi, beforeEach } from "vitest";
import { GeminiEngine } from "../gemini.js";
import type { EngineRunOpts } from "../../shared/types.js";

describe("GeminiEngine", () => {
  let engine: GeminiEngine;

  beforeEach(() => {
    engine = new GeminiEngine();
  });

  describe("constructor and identity", () => {
    it("should have name 'gemini'", () => {
      expect(engine.name).toBe("gemini");
    });

    it("should implement InterruptibleEngine interface", () => {
      expect(typeof engine.kill).toBe("function");
      expect(typeof engine.isAlive).toBe("function");
      expect(typeof engine.killAll).toBe("function");
      expect(typeof engine.run).toBe("function");
    });
  });

  describe("buildArgs", () => {
    const baseOpts: EngineRunOpts = { prompt: "test prompt", cwd: "/tmp" };

    it("should build fresh args with streaming", () => {
      const args = engine.buildArgs(baseOpts, "test prompt", true);
      expect(args).toEqual(["-p", "--output-format", "stream-json", "--sandbox", "false", "test prompt"]);
    });

    it("should build fresh args without streaming (json mode)", () => {
      const args = engine.buildArgs(baseOpts, "test prompt", false);
      expect(args).toEqual(["-p", "--output-format", "json", "--sandbox", "false", "test prompt"]);
    });

    it("should include --model when specified", () => {
      const opts = { ...baseOpts, model: "gemini-2.5-pro" };
      const args = engine.buildArgs(opts, "test prompt", true);
      expect(args).toContain("--model");
      expect(args).toContain("gemini-2.5-pro");
    });

    it("should include --resume when resumeSessionId is set", () => {
      const opts = { ...baseOpts, resumeSessionId: "abc-123" };
      const args = engine.buildArgs(opts, "test prompt", true);
      expect(args).toContain("--resume");
      expect(args).toContain("abc-123");
    });

    it("should append cliFlags", () => {
      const opts = { ...baseOpts, cliFlags: ["--debug", "--verbose"] };
      const args = engine.buildArgs(opts, "test prompt", true);
      expect(args).toContain("--debug");
      expect(args).toContain("--verbose");
    });

    it("should put prompt as the last argument", () => {
      const opts = { ...baseOpts, model: "gemini-2.5-pro", resumeSessionId: "abc-123" };
      const args = engine.buildArgs(opts, "my prompt here", true);
      expect(args[args.length - 1]).toBe("my prompt here");
    });
  });

  describe("processStreamLine", () => {
    it("should return null for empty lines", () => {
      expect(engine.processStreamLine("")).toBeNull();
      expect(engine.processStreamLine("   ")).toBeNull();
    });

    it("should return null for unparseable JSON", () => {
      expect(engine.processStreamLine("not json")).toBeNull();
    });

    it("should parse session.start event", () => {
      const line = JSON.stringify({ type: "session.start", session_id: "gem-abc-123" });
      const result = engine.processStreamLine(line);
      expect(result).toEqual({ type: "session_id", sessionId: "gem-abc-123" });
    });

    it("should parse session.started event (alternative name)", () => {
      const line = JSON.stringify({ type: "session.started", sessionId: "gem-xyz-789" });
      const result = engine.processStreamLine(line);
      expect(result).toEqual({ type: "session_id", sessionId: "gem-xyz-789" });
    });

    it("should parse text events", () => {
      const line = JSON.stringify({ type: "text", text: "Hello world" });
      const result = engine.processStreamLine(line);
      expect(result).toEqual({
        type: "text",
        delta: { type: "text", content: "Hello world" },
      });
    });

    it("should parse content.text events", () => {
      const line = JSON.stringify({ type: "content.text", content: "Some text" });
      const result = engine.processStreamLine(line);
      expect(result).toEqual({
        type: "text",
        delta: { type: "text", content: "Some text" },
      });
    });

    it("should parse text_delta events", () => {
      const line = JSON.stringify({ type: "text_delta", delta: "chunk" });
      const result = engine.processStreamLine(line);
      expect(result).toEqual({
        type: "text",
        delta: { type: "text", content: "chunk" },
      });
    });

    it("should parse tool.start events", () => {
      const line = JSON.stringify({ type: "tool.start", name: "read_file", id: "t-1" });
      const result = engine.processStreamLine(line);
      expect(result).toEqual({
        type: "tool_start",
        delta: { type: "tool_use", content: "Using read_file", toolName: "read_file", toolId: "t-1" },
      });
    });

    it("should parse tool_use events", () => {
      const line = JSON.stringify({ type: "tool_use", tool_name: "shell", tool_id: "t-2" });
      const result = engine.processStreamLine(line);
      expect(result).toEqual({
        type: "tool_start",
        delta: { type: "tool_use", content: "Using shell", toolName: "shell", toolId: "t-2" },
      });
    });

    it("should parse tool.end events", () => {
      const line = JSON.stringify({ type: "tool.end", output: "file contents here" });
      const result = engine.processStreamLine(line);
      expect(result).toEqual({
        type: "tool_end",
        delta: { type: "tool_result", content: "file contents here" },
      });
    });

    it("should parse tool_result events", () => {
      const line = JSON.stringify({ type: "tool_result", result: "command output" });
      const result = engine.processStreamLine(line);
      expect(result).toEqual({
        type: "tool_end",
        delta: { type: "tool_result", content: "command output" },
      });
    });

    it("should parse turn.complete events", () => {
      const line = JSON.stringify({ type: "turn.complete" });
      expect(engine.processStreamLine(line)).toEqual({ type: "turn_complete" });
    });

    it("should parse turn.completed events (alternative name)", () => {
      const line = JSON.stringify({ type: "turn.completed" });
      expect(engine.processStreamLine(line)).toEqual({ type: "turn_complete" });
    });

    it("should parse error events", () => {
      const line = JSON.stringify({ type: "error", message: "Something went wrong" });
      const result = engine.processStreamLine(line);
      expect(result).toEqual({ type: "error", message: "Something went wrong" });
    });

    it("should parse result events as text", () => {
      const line = JSON.stringify({ type: "result", result: "Final answer here" });
      const result = engine.processStreamLine(line);
      expect(result).toEqual({
        type: "text",
        delta: { type: "text", content: "Final answer here" },
      });
    });

    it("should return null for unrecognized event types", () => {
      const line = JSON.stringify({ type: "some_future_event", data: "whatever" });
      expect(engine.processStreamLine(line)).toBeNull();
    });
  });

  describe("system prompt handling", () => {
    it("should prepend system prompt to user prompt in run()", async () => {
      // We test this by verifying buildArgs receives the combined prompt
      // The actual prepending happens in run() before buildArgs is called
      const opts: EngineRunOpts = {
        prompt: "user task",
        systemPrompt: "You are a helpful assistant.",
        cwd: "/tmp",
      };

      // Spy on buildArgs to capture the prompt it receives
      const buildArgsSpy = vi.spyOn(engine, "buildArgs");

      // run() will fail because gemini binary doesn't exist, but that's OK —
      // we just need to verify the prompt was combined before buildArgs is called
      try {
        await engine.run(opts);
      } catch {
        // Expected: spawn will fail
      }

      expect(buildArgsSpy).toHaveBeenCalledWith(
        opts,
        "You are a helpful assistant.\n\n---\n\nuser task",
        expect.any(Boolean),
      );
    });

    it("should append attachments to prompt", async () => {
      const opts: EngineRunOpts = {
        prompt: "review this",
        attachments: ["/path/to/file.ts", "/path/to/other.ts"],
        cwd: "/tmp",
      };

      const buildArgsSpy = vi.spyOn(engine, "buildArgs");

      try {
        await engine.run(opts);
      } catch {
        // Expected
      }

      expect(buildArgsSpy).toHaveBeenCalledWith(
        opts,
        "review this\n\nAttached files:\n- /path/to/file.ts\n- /path/to/other.ts",
        expect.any(Boolean),
      );
    });
  });

  describe("lifecycle (kill/isAlive/killAll)", () => {
    it("isAlive should return false for unknown session", () => {
      expect(engine.isAlive("nonexistent")).toBe(false);
    });

    it("kill should not throw for unknown session", () => {
      expect(() => engine.kill("nonexistent")).not.toThrow();
    });

    it("killAll should not throw when no processes", () => {
      expect(() => engine.killAll()).not.toThrow();
    });
  });
});
