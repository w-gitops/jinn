// Shared Tier-1 command-safety matcher. Pure ESM JS, NO dependencies, so it can be
// imported by BOTH the gateway (TypeScript, via dynamic import of this .mjs) AND the
// hook-relay (plain .mjs running standalone in JINN_HOME). The denylist PATTERNS live
// in policy/command-safety.json (single source of truth); this file is the single
// source of the MATCHING LOGIC. Patterns + logic therefore live in exactly one place each.
//
// Owner of patterns: Knox (policy JSON). Owner of this matcher: Pike.

const GLOB_CHARS = /[*?\[\]{}]/;

/**
 * Normalize a candidate command before matching. Conservative on purpose:
 *  - strip a leading/trailing whitespace
 *  - collapse runs of horizontal whitespace to a single space (defeats `rm    -rf`)
 * We deliberately do NOT strip quotes or unescape — doing so would change semantics
 * and could create false matches. Known limitation: intra-token quoting like
 * rm -r''f or r"m" is NOT normalized away (reported as a documented regex gap).
 */
export function normalize(command) {
  if (typeof command !== "string") return "";
  return command.replace(/[ \t]+/g, " ").trim();
}

/**
 * Split a command into statement segments so a deny on ANY segment denies the whole
 * command (no smuggling via chaining/substitution). Splits on ; | & && || newline
 * and on command-substitution openers ` and $( and subshell (.
 */
/**
 * Real statement segments only — split on shell control operators and substitution
 * openers, no full-string fallback. Use this for ALLOW decisions (read-only), where
 * over-matching the full string would let a single read-only token whitelist a chained
 * mutating/out-of-scope command.
 */
export function statementSegments(command) {
  const norm = normalize(command);
  // Split on shell control operators. A BARE `&` is a statement separator (backgrounding),
  // BUT a `&` that is part of a redirection idiom (`2>&1`, `>&2`, `&>file`, `2>&-`) must NOT
  // split — otherwise `2>&1` is torn into `2>` (a dangling redirect) + `1`, which the
  // redirection guard then false-flags as a write. So we split `&` only when it is neither
  // `&&` nor adjacent to `>`/`&`.
  const parts = norm.split(/(?:&&|\|\||[;|\n`]|\$\(|\(|(?<![>&])&(?![>&]))/g);
  const out = [];
  for (const p of parts) {
    const t = p.trim();
    if (t) out.push(t);
  }
  return out;
}

/**
 * Segments for DENY decisions: statement segments PLUS the full normalized string,
 * so patterns that span the whole line (e.g. redirections) still match even if the
 * split was over-eager. Over-matching is safe for deny; it is NOT safe for allow.
 */
export function segments(command) {
  const norm = normalize(command);
  const out = statementSegments(command);
  if (norm && !out.includes(norm)) out.push(norm);
  return out;
}

/** Stable hash of the normalized command — used for token binding + classifier cache. */
export async function commandHash(command) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(normalize(command)).digest("hex");
}

// --- path extraction for pathCheck (scratch / system) ---------------------------

/** Pull non-flag argument tokens out of a single segment (after the first word). */
function argTokens(segment) {
  // crude tokenizer: split on spaces (command is already whitespace-normalized).
  const toks = segment.split(" ").slice(1);
  return toks.filter((t) => t.length > 0 && !t.startsWith("-"));
}

function isUnsafeScratchTarget(tok, allowPrefixes) {
  // Globs, parent refs, unresolved vars, or relative paths cannot be statically
  // proven safe -> treat as unsafe (deny). Tilde also unresolved.
  if (GLOB_CHARS.test(tok)) return true;
  if (tok.includes("..")) return true;
  if (tok.includes("$") || tok.includes("~")) return true;
  // strip surrounding quotes for the prefix check only
  const bare = tok.replace(/^['"]|['"]$/g, "");
  if (!bare.startsWith("/")) return true; // relative -> can't verify
  return !allowPrefixes.some((p) => bare === p || bare.startsWith(p) || (p.endsWith("/") && bare + "/" === p));
}

/** scratch: deny unless EVERY target resolves under an allowed scratch prefix. */
function scratchIsDangerous(segment, pathClasses) {
  const allow = pathClasses?.scratch?.allowPrefixes ?? [];
  const targets = argTokens(segment);
  if (targets.length === 0) return true; // recursive rm with no explicit path -> deny
  return targets.some((t) => isUnsafeScratchTarget(t, allow));
}

/** system: dangerous if ANY target is a protected system prefix (or '/'). */
function systemIsDangerous(segment, pathClasses) {
  const protectedPrefixes = pathClasses?.system?.protectedPrefixes ?? [];
  const targets = argTokens(segment);
  if (targets.length === 0) return true; // no explicit target -> assume cwd/system
  return targets.some((tok) => {
    const bare = tok.replace(/^['"]|['"]$/g, "");
    if (bare === "/") return true;
    if (!bare.startsWith("/")) return true; // relative under cwd — be safe, deny
    return protectedPrefixes.some((p) => bare === p || bare.startsWith(p.endsWith("/") ? p : p + "/") || bare === p);
  });
}

// --- Tier-1 evaluation -----------------------------------------------------------

/**
 * Evaluate the Tier-1 denylist against a command.
 * Returns the STRONGEST matching verdict:
 *   { matched:true, id, decision:'deny'|'ask', requiresToken:bool, reason } | { matched:false }
 * Precedence among matches: a hard-deny (decision=deny && requiresToken=false) outranks a
 * token-deny (deny && requiresToken=true) which outranks an ask.
 */
export function evaluateTier1(command, policy) {
  const denylist = policy?.tier1?.denylist ?? [];
  const pathClasses = policy?.tier1?.pathClasses ?? {};
  const segs = segments(command);
  let best = null;
  let scratchSafe = false; // a recursive-rm matched but EVERY target was inside the scratch allowlist
  const rank = (m) => (m.decision === "deny" && !m.requiresToken ? 3 : m.decision === "deny" ? 2 : 1);
  for (const entry of denylist) {
    let re;
    try { re = new RegExp(entry.pattern, entry.flags || ""); } catch { continue; }
    for (const seg of segs) {
      if (!re.test(seg)) continue;
      // pathCheck can NEGATE a match (e.g. recursive rm strictly inside scratch).
      if (entry.pathCheck === "scratch" && !scratchIsDangerous(seg, pathClasses)) { scratchSafe = true; continue; }
      if (entry.pathCheck === "system" && !systemIsDangerous(seg, pathClasses)) continue;
      const m = {
        matched: true,
        id: entry.id,
        decision: entry.decision,
        requiresToken: !!entry.requiresToken,
        reason: entry.reason,
      };
      if (!best || rank(m) > rank(best)) best = m;
      break; // this entry already matched on some segment
    }
  }
  if (best) return best;
  // A scratch-safe recursive rm with NO real deny is explicitly PERMITTED by policy —
  // surface it so the gate can fast-allow instead of escalating to the classifier.
  return { matched: false, scratchSafe };
}

function matchesAnyReadOnlyPattern(seg, patterns) {
  for (const p of patterns) {
    let re;
    try { re = new RegExp(p.pattern); } catch { continue; }
    if (re.test(seg)) return true;
  }
  return false;
}

// Allowed redirection sinks — these do NOT write a real file, so they don't make an
// otherwise read-only command a write. Everything else (a path target) is a write.
const REDIR_SINK = /^(\/dev\/null|\/dev\/stdout|\/dev\/stderr|&[0-9]+|&-)$/;

/**
 * True if a statement segment contains an OUTPUT REDIRECTION to a real target (not a
 * sink). A read-only verb (echo/cat/head/…) weaponized with `> /opt/jinn/x` writes a
 * file while still matching the read-only leading-word patterns — which would skip the
 * Tier-2 scope check (Knox BLOCKER 3). We keep `>/dev/null`, `2>/dev/null`, `2>&1`
 * allowed so innocent `ls 2>/dev/null` stays read-only.
 */
export function hasUnsafeRedirection(seg) {
  // Match each redirection operator ([fd]> or [fd]>> or &>) and the target that follows.
  const re = /(?:[0-9]|&)*>>?\s*(&[0-9-]+|[^\s|;&<>()]+)?/g;
  let m;
  while ((m = re.exec(seg)) !== null) {
    // Guard against zero-width matches looping forever.
    if (m.index === re.lastIndex) re.lastIndex++;
    if (!m[0].includes(">")) continue;
    const tgt = m[1];
    if (tgt === undefined) return true;     // a bare '>' with no captured target — treat as a write
    if (!REDIR_SINK.test(tgt)) return true; // writes to a real path/file
  }
  return false;
}

/**
 * True only if the command is read-only. A command is read-only ONLY if EVERY statement
 * segment independently matches a read-only pattern. The previous full-string match let a
 * single read-only token anywhere (e.g. `git status && curl :7777`) whitelist a chained
 * mutating/out-of-scope command, skipping the Tier-2 scope check — a real scope bypass.
 * We use statementSegments (NOT the full-string fallback) so chaining cannot smuggle.
 */
export function matchesReadOnly(command, policy) {
  const patterns = policy?.readOnlyAllowlist?.patterns ?? [];
  if (patterns.length === 0) return false;
  const segs = statementSegments(command);
  if (segs.length === 0) return false;
  // A segment is read-only ONLY if it matches a read-only pattern AND does not
  // redirect output to a real target (a `> file` write weaponizes a read-only verb).
  return segs.every((seg) => matchesAnyReadOnlyPattern(seg, patterns) && !hasUnsafeRedirection(seg));
}

/**
 * Local relay classification used for the fail-closed path:
 * returns 'hard-deny' | 'token-deny' | 'ask' | 'readonly' | 'unknown'.
 */
export function classifyLocal(command, policy) {
  const t1 = evaluateTier1(command, policy);
  if (t1.matched) {
    if (t1.decision === "deny" && !t1.requiresToken) return "hard-deny";
    if (t1.decision === "deny") return "token-deny";
    return "ask";
  }
  if (matchesReadOnly(command, policy)) return "readonly";
  return "unknown";
}
