// packages/jinn/src/engines/hermes-protocol.ts
import type { StreamDelta } from "../shared/types.js";

export function encodeModelChoice(provider: string | undefined, model: string): string {
  const m = (model || "").trim();
  const p = (provider || "").trim().toLowerCase();
  if (!m) return "";
  return p ? `${p}:${m}` : m;
}

export function splitModelChoice(choiceId: string): { provider?: string; model: string } {
  const idx = (choiceId || "").indexOf(":");
  if (idx <= 0) return { provider: undefined, model: choiceId };
  return { provider: choiceId.slice(0, idx), model: choiceId.slice(idx + 1) };
}

export function rpcRequest(id: number, method: string, params: object): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
}
export function rpcNotification(method: string, params: object): string {
  return JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
}

export interface HermesUpdate {
  deltas: StreamDelta[];
  contextTokens?: number;
  commands?: string[];
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (content && typeof content === "object") {
    const c = content as Record<string, unknown>;
    if (typeof c.text === "string") return c.text;
  }
  return "";
}

export function mapSessionUpdate(update: Record<string, unknown>): HermesUpdate {
  const kind = String(update.sessionUpdate ?? update.type ?? "");
  const deltas: StreamDelta[] = [];
  switch (kind) {
    case "agent_message_chunk":
    case "agent_message_text": {
      const t = textOf(update.content ?? update.text);
      if (t) deltas.push({ type: "text", content: t });
      return { deltas };
    }
    case "agent_thought_chunk":
    case "agent_thought_text":
      // Reasoning — never emit as answer text. (Optionally a status delta.)
      return { deltas };
    case "tool_call": {
      const id = String(update.toolCallId ?? update.toolId ?? "");
      const name = String(update.title ?? update.kind ?? update.name ?? "tool");
      const input = update.rawInput ?? update.input;
      deltas.push({
        type: "tool_use", content: name, toolId: id, toolName: name,
        input: input !== undefined ? JSON.stringify(input).slice(0, 200) : undefined,
      });
      return { deltas };
    }
    case "tool_call_update": {
      const id = String(update.toolCallId ?? update.toolId ?? "");
      const status = String(update.status ?? "");
      if (status === "completed" || status === "failed") {
        deltas.push({ type: "tool_result", content: status, toolId: id });
      }
      return { deltas };
    }
    case "usage_update": {
      const used = typeof update.used === "number" ? update.used : undefined;
      if (used !== undefined) deltas.push({ type: "context", content: String(used) });
      return { deltas, contextTokens: used };
    }
    case "available_commands_update": {
      const cmds = Array.isArray(update.availableCommands)
        ? (update.availableCommands as Array<{ name?: string }>).map((c) => String(c.name ?? "")).filter(Boolean)
        : [];
      return { deltas, commands: cmds };
    }
    default:
      return { deltas };
  }
}

export function extractPromptText(prompt: string): { type: "text"; text: string }[] {
  return [{ type: "text", text: prompt }];
}
