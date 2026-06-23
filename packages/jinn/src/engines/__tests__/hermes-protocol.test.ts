// packages/jinn/src/engines/__tests__/hermes-protocol.test.ts
import { describe, it, expect } from "vitest";
import {
  encodeModelChoice, splitModelChoice, rpcRequest, mapSessionUpdate,
} from "../hermes-protocol.js";

describe("model choice encoding", () => {
  it("encodes provider:model and splits back", () => {
    expect(encodeModelChoice("openai-codex", "gpt-5.5")).toBe("openai-codex:gpt-5.5");
    expect(splitModelChoice("openai-codex:gpt-5.5")).toEqual({ provider: "openai-codex", model: "gpt-5.5" });
    expect(splitModelChoice("gpt-5.5")).toEqual({ provider: undefined, model: "gpt-5.5" });
  });
});

describe("rpcRequest", () => {
  it("produces a newline-terminated JSON-RPC 2.0 line", () => {
    const line = rpcRequest(1, "initialize", { protocolVersion: 1 });
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toEqual({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
  });
});

describe("mapSessionUpdate", () => {
  it("maps an answer chunk to a text delta", () => {
    const r = mapSessionUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } });
    expect(r.deltas).toEqual([{ type: "text", content: "hi" }]);
  });
  it("drops reasoning chunks from text (no leak)", () => {
    const r = mapSessionUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "secret reasoning" } });
    expect(r.deltas.filter((d) => d.type === "text")).toEqual([]);
  });
  it("maps usage_update to contextTokens", () => {
    const r = mapSessionUpdate({ sessionUpdate: "usage_update", size: 272000, used: 11833 });
    expect(r.contextTokens).toBe(11833);
    expect(r.deltas).toContainEqual({ type: "context", content: "11833" });
  });
  it("maps a tool_call to a tool_use delta", () => {
    const r = mapSessionUpdate({ sessionUpdate: "tool_call", toolCallId: "t1", title: "bash", rawInput: { cmd: "ls" } });
    expect(r.deltas[0]).toMatchObject({ type: "tool_use", toolId: "t1", toolName: "bash" });
  });
});
