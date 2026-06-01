# Changelog

## [Unreleased]

> Engine & model-selection sprint. All of the below ships under a **single version
> bump** at release (no version change in these commits).

### ✨ Features
- **Antigravity (`agy`) engine** — Google Antigravity replaces the removed Gemini slot as a PTY-interactive engine. agy has no headless/`--print` mode and no hook system, so turns are driven through a PTY (one instance both runs turns and backs the xterm view) and completion is detected by tailing agy's per-conversation transcript (`~/.gemini/antigravity-cli/brain/<convId>/.system_generated/logs/transcript.jsonl`) for a `MODEL/PLANNER_RESPONSE/status:DONE` line. The conversation id becomes the engine session id; resume uses `agy --conversation <id>`. The binary is resolved **dynamically** (PATH + common dirs incl. `~/.local/bin`, optional `engines.antigravity.bin` override) — no hardcoded paths. Workspace trust is pre-seeded by realpath before spawn so the interactive trust gate never blocks; the cached Google credential is reused (no re-auth). Default model Gemini 3 Flash (agy ignores model flags today; `/model` injection deferred). Verified end-to-end against agy v1.0.x (May 2026).
- **Dynamic model + capability registry** — `models:` block in `config.yaml` (per-model `{id,label,supportsEffort,effortLevels}`, per-engine `effortMechanism`) is the single source of truth for which engines/models exist and what they support. New `GET /api/engines` exposes the resolved registry. When the block is absent it's **synthesized** from `engines.<name>.model`, so existing configs keep working. **Adding a new model is a config edit — zero code change.** Cache invalidates on config reload and `PUT /api/config`.
- **Mid-chat model & effort switching** — `PUT|PATCH /api/sessions/:id` accepts `{ model?, effortLevel? }`, validated against the registry for the session's engine, and applies **from the next turn** (in place — a resume spike confirmed `claude -p --resume --model <new>` honors the new model while preserving history, so no fork is needed). Engine is **new-chat-only** (not mutable mid-chat). Antigravity model changes persist but are a logged runtime no-op (agy ignores model flags).
- **Web composer selector row** — a compact **Engine · Model · Effort** pill row above the chat input, fully registry-driven (no hardcoded lists). Engine is editable on a new chat / read-only chip in an existing chat; Model + Effort editable in both; Effort is filtered to the model's levels and hidden for effort-less engines (antigravity). Pre-fills from the chosen employee's config (new chat) or the loaded session; in-chat changes PATCH the session with an "applies to next message" note. Settings-page model/effort dropdowns are now registry-driven too (kills stale `opus-4-6` labels).

### 🐛 Fixes / Changed
- **Effort validation is registry-driven** — replaced the hardcoded `VALID_EFFORTS` set with per-engine+model `effortLevels` from the registry. This fixes the silent **`xhigh` rejection** for codex (now valid and passed through). Unknown/unsupported levels are dropped with a logged warning (graceful degradation), never a silent pass or a throw; effort-less engines default cleanly with no noise.

### 💥 Removed / Not supported
- **Removed the Gemini CLI engine.** Google is sunsetting Gemini CLI for individual/free and AI Pro/Ultra users on **2026-06-18**, directing them to Antigravity. The `gemini` engine option (`engines.gemini`, `engine: gemini`) is gone. **Gemini *API* usage is unaffected** — `GEMINI_API_KEY` features (deep-research, nano-banana) still work. Historical migration notes left intact.
- **Fast mode is explicitly NOT supported** (any engine). The real `claude` CLI has no `--fast` flag — `/fast` is an interactive, stateful TUI toggle (resets on model switch, org-disablable) with no headless/flag equivalent, and Jinn runs turns headless. Rather than carry dead infra, the concept was dropped end-to-end (no `supportsFast` in the registry, no UI control).

## [0.17.1] - 2026-05-31

### 🐛 Fixes
- **Slack reaction approvals work again on older messages.** The `reaction_added` handler gated on the *reacted-to message's* age via `ignoreOldMessagesOnBoot`, so any reaction on a message posted before the gateway's last boot was silently dropped. This broke human-in-the-loop approval flows where a card waits hours for a ✅ (and every gateway restart made all pending cards un-reactable). The boot-replay guard now checks the **reaction event's own `event_ts`**, so a fresh reaction on an old message is always honored while genuinely replayed-on-boot reactions are still skipped.
- **Instant `:eyes:` ack on reactions.** The connector now adds an `:eyes:` reaction the moment it accepts a user reaction, giving immediate visual confirmation the gateway heard it.

## [0.17.0] - 2026-05-31

### ✨ Features
- **Clickable file paths → in-app file viewer.** File paths mentioned in chat messages (e.g. `docs/superpowers/specs/2026-05-31-movekit-support-design.md`) are now auto-detected and rendered as links — including the common case where agents wrap them in backticks. Clicking opens the file as a new **in-app tab** (the same VS Code-style tab bar as chats, labelled with the basename), rendering markdown via `react-markdown` + `remark-gfm` and code with Prism syntax highlighting. Lets you read any referenced artifact without leaving the dashboard — ideal over Tailscale where the file isn't directly reachable.
- **Standalone `/file?path=` route** — the same viewer as a full page, for opening files in a real browser tab (a subtle ⧉ button inside the in-app viewer pops it out) and for direct/remote access.
- **File-read endpoint** `GET /api/files/read?path=` — reads any file on disk (single-user/Tailscale threat model, no allowlist) with a 5 MB size cap and binary detection. Relative paths resolve `~/.jinn` first, then `~/Projects`, then gateway cwd, then literal; absolute/`~` paths used verbatim.
- **Mobile back button** in the embedded viewer that returns to the chat the link was opened from; sticky frosted control chips (back + pop-out) that stay reachable while scrolling.

### 🐛 Fixes
- File-viewer content wraps to the available width — no more horizontal scrollbar on long code lines or unbroken tokens (prose wraps, code blocks contain their own overflow).

## [0.16.1] - 2026-05-30

### 🐛 Fixes
- **User messages with attachments no longer render twice.** The v0.16.0 outbound-vanishing fix deduped reconciled history by message id only. A sent user message is appended optimistically with a client-side random id while the server persists it under a different canonical id, so on the next history refresh the optimistic copy was kept *alongside* the server copy — duplicating the whole message (text + every image/video). `reconcileMessages` now also matches on a content-identity key (role + content + media filenames, media-type-agnostic so videos work), collapsing the optimistic message into its server twin while still preserving genuinely-live agent attachments missing from a racing snapshot.

## [0.16.0] - 2026-05-30

### ✨ Features
- **File & image attachments in the web chat, both directions.** Attach any file type (images, PDFs, zip, docs, anything) from the composer via drag-drop, click, or paste — the bytes are stored locally under `~/.jinn/uploads/YYYY-MM-DD/<sessionId>/` and **only the file path** is injected into the engine prompt, so Claude/Codex/Gemini read it with their own tools instead of being fed raw bytes. First-message uploads are re-homed into the session bucket once it's created (no orphans).
- **Outbound attachments API** — a running session can push files/images back **into** the chat via `POST /api/sessions/:id/attachments` (accepts `multipart`, or JSON `{path|content|url}`), exactly like agents already curl `POST /api/sessions` to spawn children. Renders in the web chat view (documented limitation: the raw CLI/xterm stream can't render inline). Messages now persist a `media` column.
- **Rich file UX** — images render as inline thumbnails that open a full-screen lightbox (Esc/click to close, with download); non-image files render as download chips with name + size; multiple files in one message are handled without clobbering. Image loading uses a skeleton shimmer that cross-fades to the image (no layout shift) with a graceful broken-image fallback.

### ⚡ Performance
- **Immutable browser caching for file responses** — `GET /api/files/:id` now sends `Cache-Control: public, max-age=31536000, immutable` plus a strong `ETag` and `Last-Modified`, and answers conditional `If-None-Match`/`If-Modified-Since` requests with `304 Not Modified`. Re-opening a chat no longer re-downloads every image — a big win on slow connections.

### 🐛 Fixes
- **Pushed attachments no longer vanish from the chat** — the `session:completed` handler was popping the last assistant bubble (to swap the optimistic streaming text), which also ate a freshly-pushed attachment message until a page reload. It now never pops a message carrying `media`, uses the server's canonical message id, and merges (rather than replaces) on history refresh so the attachment shows exactly once.

## [0.15.1] - 2026-05-22

### 🐛 Fixes
- **`jinn --version` reported the wrong version** — the CLI reads its version from `dist/package.json` (emitted by tsc from the `import pkg from "../package.json"` in `bin/jinn.ts`). v0.15.0 was published with a stale `dist/` built before the version bump, so it reported `0.14.0` and the Homebrew formula's `--version` test would mismatch. Rebuilt after the bump; `dist/package.json` and `jinn --version` now match the package version.

## [0.15.0] - 2026-05-22

### ♻️ Refactor
- **Kill the "jimmy" naming soup** — the repo, home dir, npm package, and binary all converged on **jinn**, but the project folder (`~/Projects/jimmy`) and the inner package (`packages/jimmy`) were the lone holdouts. Renamed the project root to `~/Projects/jinn`, `packages/jimmy` → `packages/jinn`, and the CLI entry `bin/jimmy.ts` → `bin/jinn.ts`. The published npm package (`jinn-cli`), the `jinn` binary, and the `~/.jinn` workspace are unchanged — no action needed for existing installs. All workspace/build/Formula/workflow/release-skill path references updated to match.

## [0.14.0] - 2026-05-21

### ✨ Features
- **Telegram voice/audio transcription** (#59) — `voice`, `audio`, and `video_note` messages are transcribed through the bundled `stt/stt.ts` (whisper.cpp) before reaching the engine, fixing the empty-`text` session-resume crash. Multi-language config → `auto`; concurrent voice notes are serialized to avoid OOM on small hosts, with a one-line "queued" ack. If STT is unavailable/empty, the message is dropped with a user-facing explanation instead of forwarding empty text.
- **Telegram file attachments** (#60) — documents, photos, videos, animations, and stickers are downloaded and surfaced via `msg.attachments` (UUID-named in `TMP_DIR` to avoid collisions), so the engine actually receives files instead of silently dropping them. `video_note` is routed to transcription (above), not attached, to avoid double-handling.

## [0.13.3] - 2026-05-20

### ✨ Features
- **Child-reply notification banner is back in the web UI** — when an employee (child) session replies, the parent session's chat shows a centered system banner again (live via the `session:notification` WS event, and on history reload). It was removed by the v0.13.0 "nuke notifications" cleanup along with the bell.

### 🪄 Polish
- **Dual-audience callback messages** — the child-reply notification is now decoupled: the parent **engine** (e.g. the COO) receives a full-context message with the child session id and API pointers to follow up, while the **web UI** shows a clean, simplified banner (`📩 <employee> replied` + a tidy preview) instead of the old noisy `GET /api/sessions/…?last=N` / `Preview:` blob. The gateway persists + emits the clean version for display and runs the engine on the full one.

## [0.13.2] - 2026-05-20

### 🪄 Docs
- **Align delegation guidance with restored callbacks** — the `template/CLAUDE.md`, `template/AGENTS.md`, and the runtime-injected delegation protocol (`context.ts`) disagreed about whether the gateway notifies a parent session: the templates still said "auto-notify, never poll" while `context.ts` (post-nuke) said "no callback, poll." Now that v0.13.1 restored the callback, all three describe the same **hybrid** model: the gateway wakes you on a child reply, with polling as a fallback so a missed callback never leaves a parent idle.

## [0.13.1] - 2026-05-20

### 🐛 Fixes
- **Restore parent-session callbacks** — the "nuke notifications" cleanup (v0.13.0) was meant to remove only the web notification bell, but it also stripped the backend mechanism that wakes a parent session when a child session replies. Child/employee sessions were finishing without ever notifying their parent/COO session, so delegated work returned silently and had to be polled for manually. Restores `notifyParentSession` and the `role:"notification"` message path (including the "don't interrupt a running parent turn" guard), `Employee.alwaysNotify`, `JinnConfig.notifications`, and the `PATCH /api/org/employees/:name` endpoint. The web bell UI stays removed.

## [0.11.0] - 2026-05-18

### ✨ Features
- **Interactive Claude engine** — every Claude turn (cron, connectors, web Chat, web CLI) now runs the real interactive `claude` TUI inside a node-pty pseudo-terminal. Bills as `cc_entrypoint=cli`, preserving Max subscription past Anthropic's June 15, 2026 cutoff that ends `claude -p` subsidy.
- **Hook-driven turn boundaries** — per-session `--settings` file registers Claude Code's SessionStart/Stop/StopFailure/PreToolUse/PostToolUse hooks; a tiny `hook-relay.mjs` POSTs each event back to the daemon over loopback so turn lifecycle is detected without screen-scraping.
- **Per-session KEEP ALIVE control** — toggle in web UI decides whether a PTY survives across turns (snappy follow-ups, warm context) or is reaped after the grace window. Orphan PTYs reaped on daemon restart.
- **Web Chat ↔ CLI toggle per session** — `xterm.js` view of the live PTY (CLI mode) or parsed delta stream (Chat mode), persisted per session. One process, one billing event for either view.
- **Recently-viewed chat keep-alive cache** — chats stay mounted in the web UI for instant switching.
- **GatewayProvider consolidation** — single WebSocket replaces 5–7 per page in the web UI.

### ⚡ Performance
- **8–20s daemon GET latency → <100ms** during active turns. Root causes fixed:
  - Ring-buffer PTY scrollback (was O(N) string realloc per data chunk → O(1) chunk-list ring)
  - Transcript backfill made async + transactional (was sync `readFileSync` + N inserts per GET)
  - Async transcript tail with long-lived `FileHandle` (was sync `statSync`+`openSync`+`readSync` per file-watch event)
- **Web event-storm fix** — `events` array narrowed to frames consumers actually filter on; high-frequency consumers migrated to direct `subscribe()` callbacks.
- **rAF-coalesced xterm window resize**, `hasOutput` short-circuit, static-import for hook endpoint.

### 🐛 Fixes
- **Tab status no longer goes stale** — chat tabs subscribe to session lifecycle events; blue "in progress" dot clears on completion and survives reload.
- **No more title flash on tab click** — `sessionMeta` now tagged with its owning sessionId; effect refuses to write stale meta onto the newly-selected tab.
- **Orphan tabs after sidebar delete** — `session:deleted` events now close matching tabs.
- **Reconcile persisted tabs on load** — drops orphans, normalizes stale `running` status against authoritative server state.
- **Rate-limit wait cancels on user stop** — was only catching `"error"` status, missed the `"idle"` user-initiated stop case.
- **Heartbeat clears after session delete** — no more `status:"running"` writes against deleted rows.
- **Hook endpoint hardening** — loopback check moved ahead of body read, 64 KB body cap, `crypto.timingSafeEqual` secret comparison, empty-secret bypass guard.
- **File-mode 0o600 on `gateway.json`, `--settings`, and `~/.claude.json`** — hook secret no longer world-readable on shared machines.
- **HookRegistry buffer GC** — periodic sweep evicts entries whose TTL expired; closes long-running memory leak.
- **`streams` map cleanup on PTY exit**, **kill-mid-paste race closed** (`turnStarted` before `injectPrompt`), **PTY-reset control frame** sent to xterm on respawn, **async-tailer fd nulled on read error**.

### 🪄 Docs
- New README section: **"How the Claude engine works under the hood"** — PTY, hooks, transcript tail, KEEP ALIVE, Chat/CLI duality, and why we moved off `claude -p` before the subscription cutoff.

## [0.10.0] - 2026-04-28

### ✨ Features
- **Full Telegram connector** — web UI configuration, employee routing, typing indicators, media support
- **`/models` command + Opus 4.7 support** in Telegram (#50)
- **Cron job latency alerting** — Slack warning when scheduled jobs exceed threshold

### 🐛 Fixes
- **Slack `app_mention` handler** — bot now responds to `@Bot` mentions in channels; root channel messages without mention are correctly ignored (#46, thanks @lisovet)
- **`crypto.randomUUID` polyfill** — web UI no longer crashes when accessed over plain HTTP on LAN/Tailscale (#47, thanks @lisovet)
- **`body.model` honored** in `POST /api/sessions` and `/stub` — per-employee model routing now works for MCP and API clients (#45, thanks @papajade55-debug, closes #38)
- **Slack unfurl crash** — skip unfurl events that crashed the Claude engine (#44, thanks @MarockNRoll)

## [0.7.0] - 2026-03-19

### ✨ Features — Project Phoenix
- **Chat tabs** — Cmd+W close, Cmd+Shift+[/] switch, draft persistence, status indicators
- **Command palette** — cmdk-powered Cmd+K with actions, recents, sessions, skills search
- **Breadcrumb navigation** — context-aware breadcrumbs on all pages
- **ChatPane extraction** — reusable chat component decoupled from page
- **Enhanced sidebar** — expandable employee groups, pin/unpin, context menu, hover actions
- **React Query data layer** — query key factory, hooks for all resources, WS→cache invalidation bridge

### 🔧 Improvements
- **Tailwind migration** — 640→120 inline styles (81% reduction), shadcn token system
- **Header consolidation** — single 40px tab bar replaces 3 stacked headers on chat
- **Mobile UX** — more menu in top header, clean tab bar, responsive sidebar
- **Session state sync** — tabs and selected session stay in sync
- **Instant tab switching** — no scroll flash, useLayoutEffect for immediate scroll

### 🏗️ Infrastructure
- Goals CRUD API + SQLite table (backend, for future use)
- Cost aggregation API + budget enforcement system
- Mock engine for E2E tests
- Vitest setup (api + web), Playwright config, GitHub Actions CI workflow

### 🧹 Cleanup
- Removed: split view, goals/costs pages (no backend yet), 14 unused shadcn components
- Fixed: dual-fetch anti-pattern in sidebar, session delete via mutations
- Net: 81 files changed, +5,608 / -8,723 lines

## [0.3.0] - 2026-03-10

### 🔧 Improvements
- Codex engine now runs with `--dangerously-bypass-approvals-and-sandbox` — prevents Jimmy-managed Codex sessions from being constrained by CLI sandbox/approval defaults

## [0.2.0] - 2026-03-10

### ✨ Features
- Connector abstraction layer — connectors declare capabilities (threading, reactions, edits, attachments) and health status
- `replyMessage()` vs `sendMessage()` split — proper thread-aware message routing
- CronConnector — cron jobs are now message sources routed through SessionManager (unified flow)
- Slack config options — `shareSessionInChannel`, `allowFrom` whitelist, `ignoreOldMessagesOnBoot`
- Transport state tracking — new `transportState` field + queue depth visibility
- In-chat slash commands — `/cron list|run|enable|disable`, `/model <name>`, `/doctor`
- Runtime cron control — trigger/enable/disable jobs without restart
- Web UI: Slack settings toggles for new config options
- Web UI: Transport visibility — connector name, queue depth, transport state badges

### 🔧 Improvements
- Unified message routing — all sources flow through `SessionManager.route()` with uniform `IncomingMessage`
- Cron runner simplified — ~35% code reduction by delegating to SessionManager
- Capability-aware decorations — reactions/edits conditional on connector capabilities
- Config token masking — Slack tokens masked in `GET /api/config`
- Session queue monitoring — `getPendingCount()` and `getTransportState()`

### 🏗️ Infrastructure
- Build pipeline — web UI bundled into gateway dist
- Test suite — threads, queue, and registry tests using Node.js native test runner
- DB migration — auto-adds connector/transport columns, backfills from legacy fields

### 💥 Breaking Changes
- `Connector` interface expanded with new required methods: `replyMessage()`, `getCapabilities()`, `getHealth()`, `reconstructTarget()`
- `IncomingMessage` and `Session` types have new required fields
- `GET /api/connectors` response shape changed from `string[]` to objects with capabilities
- `startScheduler()` now takes `SessionManager` instead of engine map
- `sendMessage()` no longer posts to threads — use `replyMessage()`

## [0.1.1] - 2026-03-09

### 🐛 Bug Fixes
- Remove `@jinn/web` workspace dependency from published package — was causing `unsupported URL type "workspace:"` error on `npm i -g jinn-cli` (web UI is embedded as static files during build, not a runtime dependency)

### 🔧 Improvements
- Claude engine now runs with `--dangerously-skip-permissions` — prevents sessions from hanging on tool approval prompts in headless mode

## [0.1.0] - 2026-03-09

First release of the Jinn AI gateway platform.

### ✨ Core Platform
- Gateway server with HTTP REST API + WebSocket real-time events
- Session manager with context builder (32K char budget, progressive trimming)
- SQLite session registry with WAL mode
- Per-session serial execution queue
- File watchers for hot-reload (config, cron, org, skills)
- Daemon lifecycle management (start/stop/status as background process)
- Multi-instance support with dynamic home directory resolution

### ✨ Engines
- Claude Code CLI engine wrapper (spawn, JSON streaming, session resume)
- Codex SDK engine wrapper (in-process, streaming)
- Model/effort level passthrough and configuration

### ✨ CLI
- `jinn setup` — bootstrap ~/.jinn/ from templates
- `jinn start` / `stop` / `status` — daemon management
- `jinn create` / `list` / `remove` — instance management
- `jinn nuke` — permanent instance deletion with safety prompts
- `jinn migrate` — AI-assisted template migrations
- `jinn skills` — skill discovery + skills.sh integration
- `--port` flag for custom port binding

### ✨ Connectors
- Slack connector (Socket Mode via @slack/bolt)
- Thread/DM/channel source-ref mapping
- Reaction workflow (👀 → ✅/❌)
- Message splitting for long responses
- Attachment download support

### ✨ Organization System
- Employee personas (YAML) with departments, ranks, engine assignment
- Org scanner with @mention routing
- Department boards for inter-agent task tracking
- Rich employee identity + generic connector context
- Dynamic COO naming via onboarding

### ✨ Skills System
- Markdown-based skill playbooks (SKILL.md with YAML frontmatter)
- 10 built-in skills: management, cron-manager, skill-creator, self-heal, onboarding, migrate, sync, status, new, find-and-install
- Skill symlink syncing to .claude/skills/ and .agents/skills/
- skills.sh marketplace integration
- Skills directory watcher with WebSocket change events

### ✨ Cron System
- node-cron scheduler with hot-reloadable jobs.json
- Run logging to JSONL files
- Delegation pattern (cron → COO → employee → review → deliver)
- Optional delivery to connectors

### ✨ Web UI
- Full Next.js 15 static dashboard
- Chat interface with voice recording, file attachments, rich markdown
- Session browser with detail view
- Org map (React Flow) with grid/feed views + employee detail panels
- Kanban board with drag-drop, tickets, employee assignment
- Cron visualizations — weekly schedule heatmap, pipeline grid
- Cost dashboard with charts, anomaly detection, WoW comparison
- Activity console with log browser + floating live stream widget
- Global search (Cmd+K)
- Settings page + onboarding wizard
- 5-theme CSS system with accent color support
- shadcn/ui components

### ✨ Session Context
- Rich context injection (identity, CLAUDE.md, config, org, skills, cron, connectors, API reference)
- Local environment awareness
- Lazy onboarding (stub session)

### 🏗️ Infrastructure
- pnpm + Turborepo monorepo
- TypeScript throughout
- Web UI bundled into CLI package
- CI workflow (GitHub Actions)
- README, CONTRIBUTING guide, LICENSE
