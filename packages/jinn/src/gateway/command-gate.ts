import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { logger } from "../shared/logger.js";
import type { HookPayload } from "./hook-registry.js";

// ===========================================================================
// COMMAND GATE — DOCUMENTED LIMITATIONS (honest threat model; reviewed by Knox)
// ---------------------------------------------------------------------------
// 1. COVERAGE BOUNDARY: only the `Bash` tool (shell commands) and the file-write
//    tools (Write/Edit/MultiEdit/NotebookEdit) are gated. Every OTHER tool — including
//    MCP tools that can perform mutations (e.g. a SQL-exec tool running DROP TABLE) —
//    is allowed. The gate is a SHELL/FILE command gate, NOT a universal action gate.
//    Do not assume it covers all destructive actions.
// 2. SYMLINK: scratch path checks are string-prefix only (no realpath). A symlink
//    like /tmp/link -> /etc reads as scratch-safe. Acceptable under the single-uid v2
//    limitation (a hostile same-uid agent is out of scope); it stops well-intentioned
//    mistakes, not deliberate symlink obfuscation.
// 3. SINGLE-UID TRUST BOUNDARY: this gate stops MISTAKES and OUT-OF-SCOPE actions by
//    well-intentioned agents. A malicious same-uid agent could in principle edit its
//    own settings/relay; the gate-tamper denylist + 0600 file perms raise the bar but
//    do not make it un-bypassable. True isolation (separate uid) is a documented v2.
// ===========================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Shared Tier-1 matcher (single source of matching logic, shared with the relay).
// Loaded dynamically from the assets/command-tier1.mjs file so patterns + logic
// are never duplicated in TypeScript.
// ---------------------------------------------------------------------------
export interface Tier1Result {
  matched: boolean;
  id?: string;
  decision?: "deny" | "ask";
  requiresToken?: boolean;
  reason?: string;
  /** A recursive rm matched the denylist but every target was inside the scratch allowlist. */
  scratchSafe?: boolean;
}
interface Tier1Module {
  normalize(cmd: string): string;
  segments(cmd: string): string[];
  evaluateTier1(cmd: string, policy: unknown): Tier1Result;
  matchesReadOnly(cmd: string, policy: unknown): boolean;
  classifyLocal(cmd: string, policy: unknown): string;
}

let _matcher: Tier1Module | null = null;
async function matcher(): Promise<Tier1Module> {
  if (_matcher) return _matcher;
  const candidates = [
    path.join(__dirname, "..", "..", "assets", "command-tier1.mjs"), // src/gateway -> assets
    path.join(__dirname, "..", "..", "..", "assets", "command-tier1.mjs"), // dist/src/gateway -> assets
    path.join(__dirname, "..", "assets", "command-tier1.mjs"),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error("command-tier1.mjs matcher asset not found");
  _matcher = (await import(pathToFileURL(found).href)) as Tier1Module;
  return _matcher;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface ResolvedScope {
  ctids: number[];
  repos: string[];
  ports: number[];
  paths: string[];
  hosts: string[];
}
export interface GateVerdict {
  permissionDecision: "allow" | "ask" | "deny";
  permissionDecisionReason: string;
  tier?: string;
}
export interface GateEvalCtx {
  /** Interactive (COO/web) sessions can render an "ask"; headless (-p employee) cannot. */
  interactive: boolean;
}
/** Async classifier injected for Tier-3 (so it can be stubbed in tests / swapped). */
export type Classifier = (command: string, scope: ResolvedScope) => Promise<"allow" | "ask" | "deny">;

interface TokenEntry { expiresAt: number; used: boolean; }
interface CacheEntry { decision: "allow" | "ask" | "deny"; expiresAt: number; }

const GATE_PROTECTED_FILE = /(hook-relay\.mjs|command-tier1\.mjs|command-safety\.json|command-gate\.(ts|js)|claude-settings|\.claude\/settings|\.agents\/settings)/;
const FILE_WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// Module singleton so engines / session orchestration can reach the gate without
// threading it through every constructor. Initialized once at gateway boot.
let _gate: CommandGate | null = null;
export function initCommandGate(gate: CommandGate): void { _gate = gate; }
export function getCommandGate(): CommandGate | null { return _gate; }

// ---------------------------------------------------------------------------
// CommandGate
// ---------------------------------------------------------------------------
export class CommandGate {
  private policy: any = null;
  private scopes = new Map<string, ResolvedScope>();
  private tokens = new Map<string, TokenEntry>();
  private cache = new Map<string, CacheEntry>();
  private now: () => number;

  constructor(
    private policyPath: string,
    private classifier?: Classifier,
    private notifyOutOfScope?: (sessionId: string, command: string, detail: string) => void,
    now?: () => number,
  ) {
    this.now = now ?? (() => Date.now());
    this.reload();
  }

  /** Hot-reload the policy JSON. Safe to call from a file watcher. */
  reload(): void {
    try {
      const raw = fs.readFileSync(this.policyPath, "utf-8");
      this.policy = JSON.parse(raw);
      logger.info(`command-gate: loaded policy ${this.policyPath} (v${this.policy?.version ?? "?"})`);
    } catch (err) {
      // Fail-closed config: if the policy can't load, keep any previously loaded
      // policy; if none, leave null and evaluate() will deny everything non-readonly.
      logger.error(`command-gate: failed to load policy ${this.policyPath}: ${err instanceof Error ? err.message : err}`);
    }
  }

  hasPolicy(): boolean { return !!this.policy; }
  getPolicy(): any { return this.policy; }

  // --- per-session scope ---------------------------------------------------
  /** Resolve declared scope for an employee: byEmployee > byDepartment > default. */
  resolveScope(employeeName?: string, department?: string): ResolvedScope {
    const s = this.policy?.scope ?? {};
    const empty: ResolvedScope = { ctids: [], repos: [], ports: [], paths: [], hosts: [] };
    const pick = (o: any): ResolvedScope | null => o ? {
      ctids: o.ctids ?? [], repos: o.repos ?? [], ports: o.ports ?? [], paths: o.paths ?? [], hosts: o.hosts ?? [],
    } : null;
    if (employeeName && s.byEmployee?.[employeeName]) return pick(s.byEmployee[employeeName])!;
    if (department && s.byDepartment?.[department]) return pick(s.byDepartment[department])!;
    return pick(s.default) ?? empty;
  }

  setScope(sessionId: string, scope: ResolvedScope): void { this.scopes.set(sessionId, scope); }
  getScope(sessionId: string): ResolvedScope | undefined { return this.scopes.get(sessionId); }
  clearScope(sessionId: string): void { this.scopes.delete(sessionId); }

  /** The exact hash the gate binds tokens to (sha256 of the normalized command). */
  async normalizedHash(command: string): Promise<string> {
    const m = await matcher();
    return sha256(m.normalize(command));
  }

  // --- one-time scope token ------------------------------------------------
  /** Issue a single-use token bound to (sessionId, normalized-command hash). */
  issueToken(sessionId: string, normalizedCommandHash: string): { key: string; expiresAt: number } {
    const ttl = (this.policy?.token?.ttlSeconds ?? 300) * 1000;
    const key = `${sessionId}:${normalizedCommandHash}`;
    const expiresAt = this.now() + ttl;
    this.tokens.set(key, { expiresAt, used: false });
    logger.warn(`command-gate: scope token ISSUED for session ${sessionId} hash ${normalizedCommandHash.slice(0, 12)} ttl ${ttl}ms`);
    return { key, expiresAt };
  }

  /**
   * Atomically consume a token. Single-threaded JS guarantees no await happens
   * between the check and the mark, so this is a true single-use consume.
   */
  private consumeToken(sessionId: string, normalizedCommandHash: string): boolean {
    const key = `${sessionId}:${normalizedCommandHash}`;
    const t = this.tokens.get(key);
    if (!t) return false;
    if (t.used) return false;
    if (this.now() > t.expiresAt) { this.tokens.delete(key); return false; }
    t.used = true;            // burn immediately
    this.tokens.delete(key);  // and remove so it can never be reused
    logger.warn(`command-gate: scope token CONSUMED for session ${sessionId} hash ${normalizedCommandHash.slice(0, 12)}`);
    return true;
  }

  // --- evaluation ----------------------------------------------------------
  async evaluate(sessionId: string, hook: HookPayload, ctx: GateEvalCtx): Promise<GateVerdict> {
    if (!this.policy) {
      // No policy loaded -> fail closed (deny everything; relay's local Tier-1 is the floor).
      return { permissionDecision: "deny", permissionDecisionReason: "command gate policy not loaded; denying (fail-closed)", tier: "no-policy" };
    }
    const m = await matcher();
    const toolName = String(hook.tool_name ?? "");
    const toolInput = (hook.tool_input ?? {}) as Record<string, unknown>;

    // --- non-Bash tools ----------------------------------------------------
    if (toolName !== "Bash") {
      if (FILE_WRITE_TOOLS.has(toolName)) {
        return this.evaluateFileWrite(sessionId, String(toolInput.file_path ?? toolInput.notebook_path ?? ""), ctx);
      }
      // Read/search/other tools are not shell mutations -> allow.
      return { permissionDecision: "allow", permissionDecisionReason: `non-mutating tool ${toolName || "unknown"}`, tier: "non-bash" };
    }

    const command = String(toolInput.command ?? "");
    if (!command.trim()) return { permissionDecision: "allow", permissionDecisionReason: "empty command", tier: "bash" };

    const t1: Tier1Result = m.evaluateTier1(command, this.policy);
    const hash = sha256(m.normalize(command));

    // 1. Tier-1 HARD deny (requiresToken=false) — NEVER token-overridable, highest precedence.
    if (t1.matched && t1.decision === "deny" && !t1.requiresToken) {
      return { permissionDecision: "deny", permissionDecisionReason: `Tier-1 [${t1.id}]: ${t1.reason}`, tier: "tier1-hard" };
    }

    // 2. Valid one-time token consume (only when the command would otherwise be blocked by Tier-1).
    const blockedByT1 = t1.matched && (t1.decision === "deny" || t1.decision === "ask");
    if (blockedByT1 && this.consumeToken(sessionId, hash)) {
      return { permissionDecision: "allow", permissionDecisionReason: `one-time scope token consumed (overrides Tier-1 [${t1.id}])`, tier: "token" };
    }

    // 3. Tier-1 token-deny (requiresToken=true).
    if (t1.matched && t1.decision === "deny") {
      return { permissionDecision: "deny", permissionDecisionReason: `Tier-1 [${t1.id}]: ${t1.reason} — blocked; requires a one-time scope token (Jinn+operator double-confirm).`, tier: "tier1-token" };
    }

    // Tier-1 ask: interactive -> ask; headless -> deny-until-token.
    if (t1.matched && t1.decision === "ask") {
      if (ctx.interactive) return { permissionDecision: "ask", permissionDecisionReason: `Tier-1 [${t1.id}]: ${t1.reason}`, tier: "tier1-ask" };
      return { permissionDecision: "deny", permissionDecisionReason: `Tier-1 [${t1.id}]: ${t1.reason} — 'ask' not possible headless; needs one-time scope token.`, tier: "tier1-ask-headless" };
    }

    // 3b. Scratch-safe recursive rm is explicitly permitted by policy (every target
    //     inside the scratch allowlist) — fast-allow it rather than escalating.
    if (!t1.matched && t1.scratchSafe) {
      return { permissionDecision: "allow", permissionDecisionReason: "recursive rm confined to the scratch allowlist (policy-permitted)", tier: "scratch" };
    }

    // 4. read-only allowlist fast-path.
    if (m.matchesReadOnly(command, this.policy)) {
      return { permissionDecision: "allow", permissionDecisionReason: "read-only allowlist", tier: "readonly" };
    }

    // 5. Tier-2 scope check.
    const scope = this.scopes.get(sessionId);
    const scopeRes = this.checkScope(command, scope);
    if (!scopeRes.ok) {
      this.notifyOutOfScope?.(sessionId, command, scopeRes.detail);
      return { permissionDecision: "deny", permissionDecisionReason: `Tier-2 scope: ${scopeRes.detail}`, tier: "tier2" };
    }

    // 6. Tier-3 classifier (ambiguous, in-scope, not read-only).
    const decision = await this.classify(command, scope ?? { ctids: [], repos: [], ports: [], paths: [], hosts: [] });
    if (decision === "allow") return { permissionDecision: "allow", permissionDecisionReason: "Tier-3 classifier: allow", tier: "tier3" };
    if (decision === "ask") {
      if (ctx.interactive) return { permissionDecision: "ask", permissionDecisionReason: "Tier-3 classifier: ask", tier: "tier3" };
      return { permissionDecision: "deny", permissionDecisionReason: "Tier-3 classifier: ask collapsed to deny (headless); needs one-time scope token.", tier: "tier3-headless" };
    }
    return { permissionDecision: "deny", permissionDecisionReason: "Tier-3 classifier: deny", tier: "tier3" };
  }

  private evaluateFileWrite(sessionId: string, filePath: string, _ctx: GateEvalCtx): GateVerdict {
    if (!filePath) return { permissionDecision: "ask", permissionDecisionReason: "file-write tool with no path", tier: "file" };
    // Gate self-protection: cannot modify the relay, policy, gate code, or session settings.
    if (GATE_PROTECTED_FILE.test(filePath)) {
      return { permissionDecision: "deny", permissionDecisionReason: "gate self-protection: modifying the gate/relay/policy/settings is blocked.", tier: "file-gate-tamper" };
    }
    // prod path protection.
    const prodPaths: string[] = this.policy?.tier2?.prodProtected?.paths ?? [];
    if (prodPaths.some((p) => filePath === p || filePath.startsWith(p.endsWith("/") ? p : p + "/"))) {
      this.notifyOutOfScope?.(sessionId, `write ${filePath}`, `prod-protected path ${filePath}`);
      return { permissionDecision: "deny", permissionDecisionReason: `Tier-2 scope: write to prod-protected path ${filePath}`, tier: "file-prod" };
    }
    // scope path check.
    const scope = this.scopes.get(sessionId);
    if (scope && scope.paths.length > 0) {
      const ok = scope.paths.some((p) => filePath === p || filePath.startsWith(p.endsWith("/") ? p : p + "/"));
      if (!ok) {
        this.notifyOutOfScope?.(sessionId, `write ${filePath}`, `path ${filePath} outside session scope`);
        return { permissionDecision: "deny", permissionDecisionReason: `Tier-2 scope: file path ${filePath} outside session scope`, tier: "file-scope" };
      }
    }
    return { permissionDecision: "allow", permissionDecisionReason: "file write in scope", tier: "file" };
  }

  // --- Tier-2 scope extraction + comparison --------------------------------
  private checkScope(command: string, scope?: ResolvedScope): { ok: boolean; detail: string } {
    const prod = this.policy?.tier2?.prodProtected ?? {};
    const ex = this.policy?.tier2?.extraction ?? {};

    const allMatches = (patternStr: string | undefined): string[] => {
      if (!patternStr) return [];
      const out: string[] = [];
      let re: RegExp;
      try { re = new RegExp(patternStr, "gi"); } catch { return []; }
      let mm: RegExpExecArray | null;
      while ((mm = re.exec(command)) !== null) {
        for (let i = 1; i < mm.length; i++) if (mm[i]) out.push(mm[i]);
        if (mm.index === re.lastIndex) re.lastIndex++;
      }
      return out;
    };

    // CTIDs
    const ctids = allMatches(ex.ctidPattern).map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n));
    for (const c of ctids) {
      if ((prod.ctids ?? []).includes(c)) return { ok: false, detail: `references prod-protected CTID ${c}` };
      if (scope && scope.ctids.length > 0 && !scope.ctids.includes(c)) return { ok: false, detail: `CTID ${c} not in session scope [${scope.ctids.join(",")}]` };
    }
    // Ports
    const ports = allMatches(ex.portPattern).map((n) => parseInt(n, 10)).filter((n) => Number.isFinite(n));
    for (const p of ports) {
      if ((prod.ports ?? []).includes(p)) return { ok: false, detail: `references prod-protected port ${p}` };
      if (scope && scope.ports.length > 0 && !scope.ports.includes(p)) return { ok: false, detail: `port ${p} not in session scope [${scope.ports.join(",")}]` };
    }
    // Hosts
    const hosts = allMatches(ex.hostPattern);
    for (const h of hosts) {
      if ((prod.hosts ?? []).includes(h)) return { ok: false, detail: `references prod-protected host ${h}` };
      if (scope && scope.hosts.length > 0 && !scope.hosts.includes(h)) return { ok: false, detail: `host ${h} not in session scope [${scope.hosts.join(",")}]` };
    }
    // Repos. The policy's repoPattern also captures /opt/<name> filesystem refs, so a
    // path under an in-scope path (e.g. /opt/jinn-dev) must NOT be flagged as an
    // out-of-scope repo just because its basename ("jinn-dev") isn't in scope.repos.
    const repos = allMatches(ex.repoPattern);
    for (const r of repos) {
      if (!scope || scope.repos.length === 0) continue;
      if (scope.repos.includes(r)) continue;
      const asPath = `/opt/${r}`;
      const pathCovered = scope.paths.some((p) => asPath === p || asPath.startsWith(p.endsWith("/") ? p : p + "/") || p.startsWith(asPath + "/"));
      if (pathCovered) continue;
      return { ok: false, detail: `repo ${r} not in session scope [${scope.repos.join(",")}]` };
    }
    // Prod DB names + prod paths (substring scan).
    for (const db of (prod.dbNames ?? [])) {
      if (command.includes(db)) return { ok: false, detail: `references prod database ${db}` };
    }
    for (const pp of (prod.paths ?? [])) {
      // word-ish boundary so /opt/jinn-dev is NOT flagged by prod path /opt/jinn.
      const re = new RegExp(`(^|\\s|=|:)${pp.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/|\\s|$|['"])`);
      if (re.test(command)) return { ok: false, detail: `references prod-protected path ${pp}` };
    }
    return { ok: true, detail: "in scope" };
  }

  // --- Tier-3 classifier (cached) ------------------------------------------
  private async classify(command: string, scope: ResolvedScope): Promise<"allow" | "ask" | "deny"> {
    const cfg = this.policy?.tier3?.classifier ?? {};
    if (cfg.enabled === false) {
      // classifier off -> in-scope, non-readonly mutating command: be safe, ask (headless->deny).
      return "ask";
    }
    const key = sha256(command + " " + JSON.stringify(scope));
    const hit = this.cache.get(key);
    if (hit && this.now() < hit.expiresAt) return hit.decision;

    let decision: "allow" | "ask" | "deny";
    try {
      if (!this.classifier) {
        decision = "ask"; // no classifier wired -> conservative
      } else {
        const timeoutMs = cfg.timeoutMs ?? 5000;
        decision = await Promise.race([
          this.classifier(command, scope),
          new Promise<"deny">((resolve) => setTimeout(() => resolve("deny"), timeoutMs)),
        ]);
      }
    } catch (err) {
      logger.warn(`command-gate: classifier error: ${err instanceof Error ? err.message : err}; defaulting to deny`);
      decision = "deny";
    }
    const ttlS = decision === "allow" ? (cfg.cache?.ttlSeconds ?? 3600) : (cfg.cache?.negativeCacheTtlSeconds ?? 900);
    this.cache.set(key, { decision, expiresAt: this.now() + ttlS * 1000 });
    return decision;
  }
}
