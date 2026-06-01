#!/usr/bin/env node
// Jinn hook relay. Invoked by Claude Code hooks as: node hook-relay.mjs <jinnSessionId>
// Reads hook JSON on stdin, POSTs to the gateway's /api/internal/hook.
//
// PreToolUse events are GATED: the relay runs the Tier-1 deterministic denylist
// LOCALLY (so catastrophic commands are blocked even if the gateway is down), then
// POSTs and AWAITS a verdict, and emits Claude Code decision JSON on stdout:
//   {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny|ask|allow","permissionDecisionReason":"..."}}
// Claude Code honors "deny" even under --dangerously-skip-permissions.
//
// All OTHER hook events stay fire-and-forget (POST, ignore response, exit 0) — unchanged.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const jinnSessionId = process.argv[2];
// Track gate state so the crash handler can fail closed correctly without
// double-emitting or emitting PreToolUse JSON for a non-PreToolUse event.
let GATE = { isPreTool: false, emitted: false };
const JINN_HOME = process.env.JINN_HOME || path.join(os.homedir(), `.${process.env.JINN_INSTANCE || "jinn"}`);
const POLICY_PATH = path.join(JINN_HOME, "policy", "command-safety.json");
const MATCHER_PATH = path.join(JINN_HOME, "command-tier1.mjs");
const GATEWAY_TIMEOUT_MS = 5000;

function logBestEffort(err) {
  try {
    const line = `${new Date().toISOString()} ${err?.message ?? err}\n`;
    fs.appendFileSync(path.join(JINN_HOME, "hook-relay.log"), line);
  } catch {}
}

/** Emit a Claude Code PreToolUse decision on stdout. */
function emitDecision(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  }));
  GATE.emitted = true;
}

function loadPolicy() {
  try { return JSON.parse(fs.readFileSync(POLICY_PATH, "utf-8")); } catch (err) { logBestEffort(`policy load: ${err?.message ?? err}`); return null; }
}

/** Extract the gateable command/file from a PreToolUse payload. */
function extractCandidate(payload) {
  const tool = payload?.tool_name ?? "";
  const input = payload?.tool_input ?? {};
  if (tool === "Bash") return { kind: "bash", command: String(input.command ?? "") };
  if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
    return { kind: "file", filePath: String(input.file_path ?? input.notebook_path ?? "") };
  }
  return { kind: "other" };
}

async function postToGateway(info, body, awaitVerdict) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GATEWAY_TIMEOUT_MS);
  try {
    const resp = await fetch(`http://127.0.0.1:${info.port}/api/internal/hook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-jinn-hook-secret": info.secret },
      body,
      signal: ctrl.signal,
    });
    if (!awaitVerdict) return null;
    const data = await resp.json().catch(() => null);
    return data?.verdict ?? null;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let payload;
  try { payload = JSON.parse(raw); } catch (err) { logBestEffort(err); return; }

  let info;
  try { info = JSON.parse(fs.readFileSync(path.join(JINN_HOME, "gateway.json"), "utf-8")); } catch (err) { logBestEffort(err); /* fall through: PreToolUse must still fail-closed */ }

  const isPreTool = payload?.hook_event_name === "PreToolUse";
  GATE.isPreTool = isPreTool;
  const body = JSON.stringify({ jinnSessionId, hook: payload });

  // ---- Non-PreToolUse: fire-and-forget, exactly as before -----------------
  if (!isPreTool) {
    if (info) await postToGateway(info, body, false).catch((err) => logBestEffort(err));
    return;
  }

  // ---- PreToolUse: GATED -------------------------------------------------
  const candidate = extractCandidate(payload);

  // Load the shared Tier-1 matcher + policy for the local floor.
  let matcher = null;
  let policy = null;
  try { matcher = await import(MATCHER_PATH); } catch (err) { logBestEffort(`matcher import: ${err?.message ?? err}`); }
  if (matcher) policy = loadPolicy();
  // ALARM: a missing/corrupt matcher or policy silently removes the LOCAL Tier-1 floor
  // (the "blocks even when gateway is down" guarantee). Log it loudly so a degraded asset
  // doesn't pass unnoticed. We still fail closed below (non-readonly denied when gw-down).
  if (candidate.kind === "bash" && (!matcher || !policy)) {
    logBestEffort(`ALERT: local Tier-1 floor UNAVAILABLE (matcher=${!!matcher} policy=${!!policy}); relying on gateway. Asset path: ${MATCHER_PATH}`);
  }

  // 1. Local Tier-1 for Bash — a HARD deny short-circuits before we even POST,
  //    so catastrophic patterns are blocked regardless of gateway reachability.
  let localClass = "unknown";
  if (candidate.kind === "bash" && matcher && policy) {
    const t1 = matcher.evaluateTier1(candidate.command, policy);
    if (t1.matched && t1.decision === "deny" && !t1.requiresToken) {
      emitDecision("deny", `Tier-1 [${t1.id}] (local): ${t1.reason}`);
      return;
    }
    localClass = matcher.classifyLocal(candidate.command, policy);
    // A local Tier-1 deny/ask is the floor: if the gateway is unreachable we
    // must NOT allow it. (Gateway, if up, may still consume a one-time token.)
  } else if (candidate.kind === "other") {
    localClass = "readonly"; // non-mutating tools
  }

  // 2. If the gateway is unreachable from the start, fail closed locally.
  if (!info) {
    if (localClass === "readonly") { emitDecision("allow", "gateway unreachable; read-only command permitted (fail-closed)"); return; }
    emitDecision("deny", "Command gate unavailable (no gateway info). Non-read-only blocked — retry shortly.");
    return;
  }

  // 3. POST and AWAIT the gateway verdict (Tier-2 scope + Tier-3 classifier + token).
  let verdict = null;
  try {
    verdict = await postToGateway(info, body, true);
  } catch (err) {
    logBestEffort(`gateway verdict: ${err?.message ?? err}`);
  }

  if (verdict && verdict.permissionDecision) {
    emitDecision(verdict.permissionDecision, verdict.permissionDecisionReason || "gate verdict");
    return;
  }

  // 4. Fail-closed: gateway timed out / errored. Tier-1 already ran locally.
  //    Allow ONLY if locally read-only-classified AND no Tier-1 hit; else deny.
  if (localClass === "readonly") { emitDecision("allow", "Gateway timeout; read-only command permitted (fail-closed)."); return; }
  emitDecision("deny", "Command gate unavailable (gateway timeout). Read-only commands proceed; everything else is blocked — retry shortly.");
}

main().catch((err) => {
  logBestEffort(err);
  // If we crashed while handling a PreToolUse and haven't emitted a decision yet,
  // fail closed with a deny so a relay bug can never become an implicit allow.
  if (GATE.isPreTool && !GATE.emitted) {
    try { emitDecision("deny", "Command gate relay error; denying (fail-closed)."); } catch {}
  }
}).finally(() => {
  // IMPORTANT: do NOT call process.exit(0) here. process.exit() can terminate before
  // stdout (a pipe) is flushed, truncating the decision JSON — Claude Code would then
  // see EMPTY hook output and fall back to ALLOW (silent fail-open, the worst failure
  // for this gate). Set exitCode and let the loop drain once stdin is consumed and the
  // fetch settled; stdout flushes first. A 10s unref'd watchdog guarantees termination
  // if some handle lingers (it won't keep the process alive on its own).
  process.exitCode = 0;
  const wd = setTimeout(() => process.exit(process.exitCode ?? 0), 10000);
  wd.unref?.();
});
