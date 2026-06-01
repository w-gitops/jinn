import { spawn } from "node:child_process";
import { logger } from "../shared/logger.js";
import type { Classifier, ResolvedScope } from "./command-gate.js";

/**
 * Tier-3 classifier: a fast, cheap Claude (haiku) call that judges an AMBIGUOUS,
 * in-scope, non-read-only command per the command-safety verdict rules. Only
 * reached after Tier-1 (no hit) and Tier-2 (in scope) — see command-gate.ts.
 *
 * Spawned WITHOUT --settings so it does not itself wire the relay (no gate
 * recursion), and with no tools. Fails to "deny" on any error/timeout — the gate
 * also wraps this in a hard timeout (failClosed.gatewayTimeoutMs).
 */
const CLASSIFIER_PROMPT = (command: string, scope: ResolvedScope) => `You are the command-safety Tier-3 classifier for an infra automation gateway. \
Tier-1 (catastrophic regex denylist) and Tier-2 (scope) have already passed. Judge ONLY this single shell command.

Session declared scope: ${JSON.stringify(scope)}

Command:
${command}

Rules:
- DENY if it is destructive/irreversible (data loss, service down, prod impact) or clearly out of an infra dev task's intent.
- ASK if it is mutating but reversible and intent is unclear (a human should confirm).
- ALLOW if it is safe, read-only, or a routine in-scope dev/build/test operation.

Respond with EXACTLY one word and nothing else: ALLOW or ASK or DENY.`;

export function makeClaudeClassifier(bin = "claude"): Classifier {
  return async (command: string, scope: ResolvedScope): Promise<"allow" | "ask" | "deny"> => {
    return new Promise((resolve) => {
      let stdout = "";
      let settled = false;
      const done = (d: "allow" | "ask" | "deny") => { if (!settled) { settled = true; resolve(d); } };
      let proc;
      try {
        proc = spawn(bin, [
          "-p",
          "--model", "claude-haiku-4-5-20251001",
          "--output-format", "text",
          CLASSIFIER_PROMPT(command, scope),
        ], { stdio: ["ignore", "pipe", "ignore"] });
      } catch (err) {
        logger.warn(`command-classifier: spawn failed: ${err instanceof Error ? err.message : err}; deny`);
        return done("deny");
      }
      proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.on("error", (err) => { logger.warn(`command-classifier: ${err.message}; deny`); done("deny"); });
      proc.on("close", () => {
        const t = stdout.toUpperCase();
        // Order matters: a clear DENY/ASK wins over an incidental ALLOW substring.
        if (/\bDENY\b/.test(t)) return done("deny");
        if (/\bASK\b/.test(t)) return done("ask");
        if (/\bALLOW\b/.test(t)) return done("allow");
        logger.warn(`command-classifier: unparseable output '${stdout.slice(0, 80)}'; deny`);
        done("deny");
      });
    });
  };
}
