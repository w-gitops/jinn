import { timingSafeEqual } from "node:crypto";
import type { HookRegistry, HookPayload } from "./hook-registry.js";

export interface HookEndpointCtx {
  reg: HookRegistry;
  secret: string;
  remoteAddress: string | undefined;
}

export const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * True if `addr` is a loopback address. Normalizes before comparing: lowercase,
 * strips the IPv4-mapped `::ffff:` prefix, and accepts `::1` plus the whole
 * 127.0.0.0/8 range (not just 127.0.0.1).
 */
export function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  let a = addr.trim().toLowerCase();
  if (a.startsWith("::ffff:")) a = a.slice("::ffff:".length);
  if (a === "::1") return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  return m !== null && m.slice(1).every((o) => Number(o) <= 255);
}

export function handleHookPost(
  ctx: HookEndpointCtx,
  providedSecret: string | undefined,
  body: { jinnSessionId?: string; hook?: HookPayload },
): { status: number; body: string } {
  // Loopback check first — defense-in-depth alongside any upstream check.
  if (!isLoopback(ctx.remoteAddress)) {
    return { status: 403, body: "forbidden" };
  }
  // Defense-in-depth: an empty server secret would allow any client (including one
  // sending no header) to pass timingSafeEqual against an empty buffer. The daemon
  // guards against this upstream in api.ts, but make the endpoint safe standalone.
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
  ctx.reg.deliver(body.jinnSessionId, body.hook);
  return { status: 200, body: "ok" };
}
