// packages/jinn/src/engines/__tests__/hermes-acp.test.ts
import { describe, it, expect } from "vitest";
import { PassThrough } from "node:stream";
import { HermesRpc } from "../hermes-jsonrpc.js";
import { HermesAcpEngine } from "../hermes-acp.js";

// A fake Hermes server: answers initialize/session.new/set_mode/prompt and
// streams one answer chunk + a usage_update before the prompt result.
function fakeServer() {
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  const rpc = new HermesRpc(toServer, fromServer);
  toServer.on("data", (b: Buffer) => {
    for (const line of b.toString().split("\n")) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      const reply = (result: unknown) => fromServer.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
      const note = (params: unknown) => fromServer.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params }) + "\n");
      if (msg.method === "initialize") reply({ protocolVersion: 1 });
      else if (msg.method === "session/new") reply({ sessionId: "S1", models: { currentModelId: "openai-codex:gpt-5.5", availableModels: [] } });
      else if (msg.method === "session/set_mode") reply({});
      else if (msg.method === "session/prompt") {
        note({ sessionId: "S1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } });
        note({ sessionId: "S1", update: { sessionUpdate: "usage_update", size: 1000, used: 42 } });
        reply({ stopReason: "end_turn" });
      }
    }
  });
  return rpc;
}

class TestEngine extends HermesAcpEngine {
  protected spawnProc() {
    const rpc = fakeServer();
    return { rpc, killProc: () => {}, isAliveProc: () => true, onExit: (_cb: () => void) => {} };
  }
}

describe("HermesAcpEngine.run", () => {
  it("streams text + context and returns the hermes session id", async () => {
    const eng = new TestEngine();
    const deltas: any[] = [];
    const r = await eng.run({ prompt: "hi", cwd: "/tmp", sessionId: "jinn-1", onStream: (d) => deltas.push(d) });
    expect(r.sessionId).toBe("S1");
    expect(r.result).toBe("ok");
    expect(r.contextTokens).toBe(42);
    expect(deltas).toContainEqual({ type: "text", content: "ok" });
    expect(eng.isAlive("jinn-1")).toBe(true);
  });
});
