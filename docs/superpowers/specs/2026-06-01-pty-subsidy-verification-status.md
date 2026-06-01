# PTY subsidy verification — honest status (deductive: yes; empirical: incomplete)

Date: 2026-06-01. No code change this pass. Question: does the live interactive-PTY
Claude path run as cc_entrypoint=cli (Max-subsidized)?

## FACTS (solid)
- The migration is LIVE (committed 1d36d75, deployed PID 30275). The work-turn path
  is the REAL PTY engine (claude-interactive.ts uses node-pty `pty.spawn`), NOT a
  stream-json pipe. Routing log: "Claude work turns: INTERACTIVE PTY".
- buildInteractiveArgs passes NO -p, NO --output-format stream-json, NO --sdk-url.
- This is strictly better than before regardless of the open question (we are off
  `claude -p`, the definitely-de-subsidized path).

## DEDUCTIVE proof of cli (free-code source)
- node-pty child → process.stdout.isTTY === true.
- main.tsx:803  isNonInteractive = hasPrintFlag || hasInitOnlyFlag || hasSdkUrl || !isTTY
  → all four FALSE under our spawn.
- main.tsx:539  CLAUDE_CODE_ENTRYPOINT = isNonInteractive ? 'sdk-cli' : 'cli' → 'cli'.
- main.tsx:519  if (process.env.CLAUDE_CODE_ENTRYPOINT) it is used verbatim (no recompute).
  ⇒ the child must NOT inherit an entrypoint. buildPtyEnv strips CLAUDECODE + all
  CLAUDE_CODE_* → child recomputes fresh → 'cli'.

## CRITICAL FINDING (real, must note)
The LIVE gateway's OWN env contains CLAUDE_CODE_ENTRYPOINT=sdk-cli and CLAUDECODE=1.
Source: the gateway was launched by the deploy script running inside this jinn-dev
AGENT's shell (itself a claude-code process), so it inherited sdk-cli. If the engine
spawned the child WITHOUT stripping, every turn would inherit sdk-cli (DE-SUBSIDIZED)
via the main.tsx:519 early-return. buildPtyEnv's strip is exactly what prevents this
→ child recomputes 'cli'. So: defensive code already correct, but the contamination
is real and the strip is load-bearing. (A gateway started from a clean shell wouldn't
have the leak; started from an agent it does — the strip handles both.)

## EMPIRICAL: INCOMPLETE this pass — NOT claiming verified subsidy
- Could not get a clean attributable assistant-line entrypoint reading:
  (a) transcript attribution is polluted (~/.claude/projects/-Users-jimmyenglish--jinn/
      is written by ANY claude with cwd ~/.jinn incl. this agent + children);
  (b) a forced-session-id PTY repro returned "transcript NOT FOUND" (positional-prompt
      cold spawn may not persist the way the engine's warm/inject path does);
  (c) the bash output channel degraded mid-investigation (mangled/garbled output).
- Per CEO directive I do NOT claim verified subsidy from this.

## CLEAN test to run when tooling is stable (recommended)
Add ONE diagnostic log in claude-interactive.ts spawn(): after SessionStart, read the
just-written transcript's ASSISTANT line `entrypoint` for THAT exact jinn session id
(attributable, no pollution) and logger.info it. Fire one fresh (non-resumed) gateway
turn; read the single attributable value. cli → subsidy confirmed; sdk-cli → the strip
isn't taking effect and we must fix before trusting subsidy.

## Verdict
Deductively subsidized (cli). Empirically UNPROVEN this pass. Migration is live and at
worst neutral (off -p), at best (per source + the env-strip) the subsidized path. One
attributable log line is the remaining proof.
