# Interactive TUI Engine — Design Spec

**Date**: 2026-05-14
**Author**: jimmy-dev
**Status**: Draft — pending review

## Summary

Starting **June 15, 2026**, `claude -p` and the Claude Agent SDK on subscription
plans draw from a separate, small monthly "Agent SDK credit" (Pro $20 / Max 5x
$100 / Max 20x $200) instead of the generous interactive usage limits. Jinn today
spawns `claude -p` per message, so all of Jinn's usage — web chat, connectors,
cron, the agent org — would land in that small credit pool.

The **interactive Claude Code TUI keeps using normal subscription limits,
unchanged**. This spec adds an `InteractiveClaudeEngine` that drives the real
interactive `claude` binary inside a pseudo-terminal (PTY) so Jinn's usage bills
as `cli` (interactive) rather than `sdk-cli` (headless credit).

Jinn stays a bus, not a brain. No connectors, no org logic, no cron logic
changes. Only the Claude engine's process model changes, plus a new hook-relay
endpoint and an optional embedded-TUI web chat.

## Goals

- Drive Claude such that it bills against **interactive** subscription limits.
- Keep every existing surface working: web chat, Slack/Discord/Telegram, cron, org.
- Preserve structured turn data (final message, tool calls, session id).
- Optionally give web chat the native streaming TUI experience.

## Non-Goals

- Replacing the Codex or Gemini engines.
- Removing the existing `claude -p` engine (kept as a fallback / API-billing path).
- Token-by-token streaming on headless surfaces (not available in interactive mode).
- Shipping a modified `claude` binary (breaks the billing integrity check — see Risks).

## Key Findings (validated)

Validated against the Claude Code v2.1.87 source snapshot at `~/Projects/free-code`
and a working POC (`claude` v2.1.141, PTY via `script`).

1. **Billing bucket** is decided server-side from a `cc_entrypoint` value the
   binary injects. It is `cli` when `isNonInteractive` is false, where
   `isNonInteractive = hasPrintFlag || hasInitOnlyFlag || hasSdkUrl || !process.stdout.isTTY`.
   **POC confirmed**: interactive `claude` in a PTY (no `-p`) →
   `CLAUDE_CODE_ENTRYPOINT=cli`.
2. **Prompt injection**: a positional-arg prompt becomes `initialState.initialMessage`
   and is auto-submitted on startup, bypassing paste/menu/readiness hazards. For
   follow-up turns in a live process, the only input channel is PTY stdin
   (bracketed-paste `\e[200~`…`\e[201~` + `\r`). The CCR "remote control" bridge
   exists but is Anthropic-cloud-gated and not locally addressable — unusable.
3. **All required flags work in interactive mode**: `--resume`,
   `--append-system-prompt`, `--mcp-config`, `--model`,
   `--dangerously-skip-permissions`, `--settings`.
4. **Turn-end signal**: the `Stop` hook fires reliably at turn end and carries
   `{ session_id, transcript_path, cwd, last_assistant_message, ... }` on stdin.
   **POC confirmed.** No screen-scraping needed.
5. **Transcript**: the interactive TUI writes `~/.claude/projects/<cwd-hash>/<session-id>.jsonl`,
   appended ~every 100ms, **one line per completed content block** (not token
   deltas). Tailable for block-level progress.
6. **Folder trust**: a first run in an untrusted directory blocks on a trust
   prompt even with `--dangerously-skip-permissions`. Trust is stored in
   `~/.claude.json` under `projects[<realpath>].hasTrustDialogAccepted`.
   **POC confirmed** — note the `/tmp` → `/private/tmp` realpath gotcha.
7. **Hiding the TUI input box** (for embedded web chat): no config switch exists;
   fixed-row cropping is unreliable. A **CSS overlay** (native textarea painted
   over the bottom region) is the robust approach.

## Architecture

One engine core, two output consumers.

```
                    ┌─────────────────────────────────────────┐
                    │         InteractiveClaudeEngine         │
                    │  spawn real `claude` in a PTY (no -p)    │
                    │  → bills as cc_entrypoint=cli            │
                    └────────────┬──────────────┬─────────────┘
                                 │              │
              headless surfaces  │              │  web chat
        (connectors, cron, org)  │              │
                                 ▼              ▼
                    ┌─────────────────┐  ┌──────────────────────┐
                    │ Stop hook +     │  │ xterm.js (PTY stdout) │
                    │ transcript tail │  │ + CSS-overlay textarea│
                    │ → Jinn's own UI │  │ → native streaming TUI│
                    └─────────────────┘  └──────────────────────┘
                                 │              │
                                 └──────┬───────┘
                                        ▼
                        Stop hook → POST /api/internal/hook
                        (turn-end + final message, both surfaces)
```

### Component: `InteractiveClaudeEngine`

New file `packages/jimmy/src/engines/claude-interactive.ts`. Implements
`InterruptibleEngine` — same interface as today's `ClaudeEngine`.

**Spawn model.** Uses `node-pty` instead of `child_process.spawn`. The PTY gives
the binary a TTY on **both stdin and stdout** (required for `cc_entrypoint=cli`).

Fresh session:
```
claude "<prompt>" --append-system-prompt <sys> --mcp-config <path> \
  --model <model> --dangerously-skip-permissions --settings <jinn-settings>
```
Resume:
```
claude --resume <session-id> "<prompt>" --append-system-prompt <sys> ... --settings <jinn-settings>
```

Environment: clean env (filter `CLAUDE_CODE_*` / `CLAUDECODE` as today), **do not
set `CLAUDE_CODE_ENTRYPOINT`** (the binary sets it). Set `CLAUDE_CODE_NO_FLICKER`
for fullscreen-mode rendering when the consumer is web chat (gives a discrete
bottom slot — see web chat below).

**Per-turn lifecycle (headless surfaces):** spawn → binary auto-submits the
positional-arg prompt → engine waits for the `Stop` hook callback → extract
`last_assistant_message` → kill the PTY. Stateless, mirrors today's `claude -p`
lifecycle 1:1.

**`run()` resolution.** The `run()` promise resolves when the gateway receives the
`Stop` hook POST for this Jinn session. Correlation: each Jinn session gets a
per-session `--settings` file whose hook commands embed the Jinn session id (same
pattern as today's per-session `mcpConfigPath` temp file). The engine registers a
pending resolver keyed by Jinn session id; the hook endpoint resolves it.

**`kill()` / `isAlive()` / `killAll()`:** identical to today's `ClaudeEngine` —
SIGTERM then SIGKILL the PTY process group.

**Retry / rate-limit / dead-session handling:** reuse the existing logic in
`engines/claude.ts` unchanged (transient-error retry, `isDeadSessionError`). Rate
limits surface differently in interactive mode — see Open Questions.

### Component: hook relay + endpoint

**Settings file.** Jinn writes a per-session settings JSON (to `JINN_HOME`,
cleaned up like `mcpConfigPath`) registering hooks:
- `SessionStart` → learn Claude's `session_id` + `transcript_path`.
- `Stop` → turn-end + `last_assistant_message`.
- `PreToolUse` / `PostToolUse` → optional progress deltas.

Each hook `command` is the **Jinn hook-relay script** (written once to
`JINN_HOME`), invoked with the Jinn session id, the gateway port, and a shared
secret as args.

**Relay script.** A tiny script: reads the hook JSON from stdin, wraps it with
the Jinn session id, `POST`s to `http://localhost:<gatewayPort>/api/internal/hook`
with the shared secret header. Exits 0.

**Endpoint.** New internal route in `gateway/api.ts`: `POST /api/internal/hook`.
Localhost-only + shared-secret guarded. Routes by `hook_event_name`:
- `Stop` → resolve the pending `run()` promise for that Jinn session.
- `SessionStart` → record Claude session id + transcript path.
- `Pre/PostToolUse` → emit `StreamDelta` progress to the session's WS subscribers.

### Component: transcript tailer

`packages/jimmy/src/engines/transcript-tail.ts`. Given a `transcript_path` (from
the `SessionStart` hook), tails the JSONL and maps appended lines to `StreamDelta`:
- `assistant` message text block → `{ type: "text", content }`
- `tool_use` block → `{ type: "tool_use", toolName }`
- `user` message `tool_result` block → `{ type: "tool_result" }`

Block-level granularity. Used by **headless surfaces** to drive Jinn's existing
"thinking…" / tool-use UI and reactions. Stops on the `Stop` hook. Web chat does
not need it for rendering (xterm.js shows the TUI directly) but may use it as a
non-xterm fallback view.

### Component: web chat — embedded TUI

For the web chat surface only. A human is actively present, so the native
streaming TUI is worth showing.

This is a **separate code path from `engine.run()`** — a persistent
`InteractiveSession` manager (gateway-side) that reuses the engine's primitives
(PTY spawn, trust seeding, settings/hook wiring) but is driven by WS events
rather than a single `run()` call/resolve cycle.

**Gateway side.** A persistent `node-pty` `claude` process per open web chat
session (spawned with `--resume <id>` and no prompt arg → opens the TUI idle on
that session). `CLAUDE_CODE_NO_FLICKER` enabled (fullscreen mode → discrete
bottom slot). PTY stdout streamed over the existing WebSocket to the browser. An
xterm `serialize`-addon buffer is kept gateway-side for reconnect replay.
Idle-timeout kills the process; the SessionQueue still serializes turns.

**Browser side.** `xterm.js` renders PTY stdout. A native `<textarea>` is
absolutely positioned over the bottom region of the terminal (CSS overlay),
covering the TUI's own input box. The user types in the textarea (instant, local
— no per-keystroke round-trip, which was the lag problem). On send, the message
goes over the WS; the gateway injects it into PTY stdin as bracketed-paste + `\r`.

**Sizing.** The browser reports viewport cols/rows; the gateway `pty.resize()`s.
The PTY is sized a few rows **taller** than the visible xterm viewport so the
bottom slot sits just below the fold — belt-and-suspenders with the CSS overlay.

**Why overlay, not crop:** the input box height varies (multiline, paste refs,
attachments) and there is no `<Static>` seam in v2.1.87, so fixed-row cropping
over- or under-crops. The overlay treats the terminal as an opaque black box,
which is what survives Claude Code version churn.

### Component: trust pre-seeding

On gateway startup, ensure `~/.claude.json` →
`projects[realpath(JINN_HOME)].hasTrustDialogAccepted = true` (and
`hasCompletedProjectOnboarding = true`). Idempotent. `realpath` is mandatory
(the `/tmp` → `/private/tmp` gotcha). Jinn runs all engine processes with
`cwd: JINN_HOME` today, so this is a single path.

## Data Flow

**Headless turn (e.g. a Slack message):**
1. `SessionManager.runSession` calls `engine.run(opts)` (unchanged call site).
2. `InteractiveClaudeEngine` seeds trust, writes the per-session settings file,
   spawns `claude --resume <id> "<prompt>" … --settings <file>` in a PTY.
3. `SessionStart` hook → gateway records transcript path → transcript tailer starts.
4. Tailer emits `tool_use` / `text` deltas → `onStream` → existing reaction/typing UI.
5. `Stop` hook → gateway resolves `run()` with `last_assistant_message`.
6. Engine kills the PTY, returns `EngineResult`. Rest of `runSession` unchanged.

**Web chat turn:**
1. Persistent PTY already running for the open tab; xterm.js attached.
2. User sends from the overlay textarea → WS → gateway injects bracketed-paste to stdin.
3. xterm.js streams the turn live. `Stop` hook → persist `last_assistant_message`
   to Jinn's DB, update session status.

## Tradeoffs Accepted

- **No token-level streaming on headless surfaces** — block-level only. Slack/
  Discord/cron post whole messages anyway, so impact is minimal. Web chat keeps
  full streaming via xterm.js.
- **Heavier process model** — a persistent PTY per open web chat tab; per-turn
  spawn for headless (same weight as today).
- **Native dependency** — `node-pty` (has prebuilds; falls back to node-gyp).
- **Branding** — showing the verbatim TUI in web chat leans on Anthropic's SDK
  branding guidance ("don't mimic Claude Code visual elements"). Grey for a
  self-hosted OSS tool; the headless path renders in Jinn's own UI and is clean.

## Risks

- **Server-side heuristics.** Anthropic could, post-June-15, detect automated
  interactive sessions server-side — unknowable from source. The POC proves it
  works *today*. Treat as a monitored risk, not a blocker.
- **ToS.** Anthropic discourages third-party tools leveraging subscription rate
  limits. Self-hosted, user's own subscription, user's own logged-in `claude` is
  a grey area; the user has accepted this.
- **Binary integrity.** The billing header carries an integrity hash over the
  genuine binary. We must run the unmodified `claude` — PTY-wrapping is fine,
  patching `free-code` and shipping it is **not** (would flip to a non-`cli`
  bucket or fail attestation).
- **Version drift.** Hook payloads, flag behavior, and TUI layout can change
  across `claude` versions. Mitigations: black-box the terminal (overlay, not
  crop); pin a tested `claude` version range; smoke-test on upgrade.
- **"Review hooks" prompt.** `--settings` with hooks *could* trigger a review
  prompt that blocks a non-interactive driver. The POC did not hit it with
  `--dangerously-skip-permissions` — but validate across versions.

## Migration Path

1. Add `InteractiveClaudeEngine` alongside `ClaudeEngine`. New config key
   `engines.claude.mode: "headless" | "interactive"` (default stays `headless`
   until validated).
2. Land the hook relay script, `/api/internal/hook` endpoint, settings-file
   writer, and trust pre-seeding.
3. Switch **headless surfaces** (connectors, cron) to `interactive` — the
   straightforward `run()` replacement. Validate billing on the Anthropic usage
   dashboard.
4. Build the **web chat** embedded-TUI path (persistent PTY, xterm.js, overlay).
5. Keep `ClaudeEngine` (`claude -p`) as a selectable fallback for users who
   prefer API-key billing or if interactive mode regresses.

## Open Questions / Validation Steps

These need a POC or live check before or during implementation:

- Confirm `claude --resume <id> "<prompt>"` auto-submits the prompt in
  interactive mode (POC tested fresh sessions only).
- Confirm bracketed-paste injection reliably submits follow-up turns in a
  persistent process (paste-mode neutralizes `/`,`@`,`!` prefixes — verify).
- Confirm `--settings` hooks never trigger a blocking "review hooks" prompt
  under `--dangerously-skip-permissions`.
- Confirm `CLAUDE_CODE_NO_FLICKER` fullscreen output renders cleanly in xterm.js.
- **Cost tracking gap.** `claude -p --output-format json` returns
  `total_cost_usd`; the `Stop` hook payload does not. Determine where per-turn
  cost/usage comes from in interactive mode (transcript `usage` fields?
  `~/.claude.json` `lastCost` / `lastModelUsage`?) — `accumulateSessionCost`
  depends on it.
- Confirm the `Stop` hook fires on user-interrupted turns (`kill()` path).
- Measure transcript-tail visibility latency (100ms batched appends + fs flush).
- `node-pty` prebuild availability on the gateway's target platforms.
