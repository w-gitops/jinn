import { timingSafeEqual } from "node:crypto";
import type { HookRegistry, HookPayload } from "./hook-registry.js";
import type { CommandGate, GateVerdict } from "./command-gate.js";

export interface HookEndpointCtx {
  reg: HookRegistry;
  secret: string;
  remoteAddress: string | undefined;
  /** Command gate — when present, PreToolUse events get a synchronous verdict. */
  gate?: CommandGate;
  /** Whether this session is an interactive PTY (can render an "ask") vs headless. */
  interactive?: boolean;
}

export const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export interface HookEndpointResult {
  status: number;
  body: string;
  /** For PreToolUse: the gate verdict the relay must emit to Claude Code. */
  verdict?: GateVerdict;
}

export async function handleHookPost(
  ctx: HookEndpointCtx,
  providedSecret: string | undefined,
  body: { jinnSessionId?: string; hook?: HookPayload },
): Promise<HookEndpointResult> {
  // Loopback check first — defense-in-depth alongside any upstream check.
  if (!ctx.remoteAddress || !LOOPBACK.has(ctx.remoteAddress)) {
    return { status: 403, body: "forbidden" };
  }
  // Defense-in-depth: an empty server secret would allow any client (including one
  // sending no header) to pass timingSafeEqual against an empty buffer.
  if (!ctx.secret || ctx.secret.length === 0) {
    return { status: 401, body: "unauthorized" };
  }
  const a = Buffer.from(providedSecret ?? "", "utf-8");
  const b = Buffer.from(ctx.secret, "utf-8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { status: 403, body: "forbidden" };
  }
  if (!body.jinnSessionId || !body.hook?.hook_event_name) {
    return { status: 400, body: "bad request" };
  }

  // Always deliver to the registry for observability + interactive streaming
  // (this is unchanged behavior for every event, including PreToolUse).
  ctx.reg.deliver(body.jinnSessionId, body.hook);

  // PreToolUse is GATED: compute a verdict synchronously and return it so the
  // relay can emit a Claude Code permissionDecision. Other events stay
  // fire-and-forget (the deliver() above is all they need).
  if (body.hook.hook_event_name === "PreToolUse" && ctx.gate) {
    try {
      const verdict = await ctx.gate.evaluate(body.jinnSessionId, body.hook, { interactive: !!ctx.interactive });
      return { status: 200, body: "ok", verdict };
    } catch (err) {
      // Gate threw — fail closed with a deny verdict (never an implicit allow).
      const reason = `command gate error: ${err instanceof Error ? err.message : String(err)}; denying (fail-closed)`;
      return { status: 200, body: "ok", verdict: { permissionDecision: "deny", permissionDecisionReason: reason } };
    }
  }

  return { status: 200, body: "ok" };
}
