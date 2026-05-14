import type { HookRegistry, HookPayload } from "./hook-registry.js";

export interface HookEndpointCtx {
  reg: HookRegistry;
  secret: string;
  remoteAddress: string | undefined;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function handleHookPost(
  ctx: HookEndpointCtx,
  providedSecret: string | undefined,
  body: { jinnSessionId?: string; hook?: HookPayload },
): { status: number; body: string } {
  if (!ctx.remoteAddress || !LOOPBACK.has(ctx.remoteAddress)) {
    return { status: 403, body: "forbidden" };
  }
  if (providedSecret !== ctx.secret) {
    return { status: 403, body: "forbidden" };
  }
  if (!body.jinnSessionId || !body.hook?.hook_event_name) {
    return { status: 400, body: "bad request" };
  }
  ctx.reg.deliver(body.jinnSessionId, body.hook);
  return { status: 200, body: "ok" };
}
