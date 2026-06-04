# `jinn restart` — detached, in-session-safe gateway restart

**Date:** 2026-06-04
**Status:** Approved (design)
**Scope:** Small. One new CLI command + one detached-helper entry point. No architecture changes.

## Problem

Restarting the gateway from *inside* a Jinn chat session (the normal workflow:
"rebuild the web UI and restart the gateway") breaks. Root cause:

- The gateway runs as a daemon. Every chat session is a `claude` PTY **child of
  that daemon**.
- An agent running `jinn stop && jinn start` runs it as a subprocess of its own
  session.
- `jinn stop` sends `SIGTERM` to the daemon (`lifecycle.ts` `stop()`).
- The daemon's shutdown calls `interactiveClaudeEngine.killAll()`
  (`server.ts`), which kills **every** PTY — including the session running the
  command.
- The session dies → the `&& jinn start` half never runs → the gateway stays
  down.

"Sawing off the branch you're sitting on": the restarter is a descendant of the
thing it kills, so `stop` takes the restarter down with it.

## Solution (KISS)

Add a single `jinn restart` command that performs the stop→start from a
**detached, reparented helper process** that is *not* owned by the gateway, so
the gateway's `killAll()` cannot kill it.

This reuses two patterns already in the codebase:
- `startDaemon()`'s detached-fork pattern (`fork(entry, [], {detached:true,
  stdio:"ignore"}); child.disconnect(); child.unref()`) — the helper is
  reparented to launchd and survives its parent's death.
- The gateway's existing **interrupted-session resume** (sessions are marked
  `interrupted` on shutdown; the web client cold-respawns them with `--resume`
  when the gateway returns). This keeps the chat conversation intact across the
  restart — a brief blip, full history preserved.

**No changes to existing `start`/`stop` behavior.** No env detection, no
lockfile. Habit: use `jinn restart` instead of `jinn stop && jinn start`.

## Components

### 1. `restart-entry.ts` (new) — `packages/jinn/src/gateway/restart-entry.ts`

The detached helper's entry point, modeled on `daemon-entry.ts`. Runs in its own
reparented process:

1. `uncaughtException` / `unhandledRejection` guards (same as `daemon-entry.ts`).
2. `loadConfig()`.
3. `stop()` — SIGTERM the running gateway (best-effort; no-op if already down).
4. Poll until the port is free **or** a timeout (~10s) elapses, using the
   existing `findPidOnPort` / `getStatus` logic. Short sleep between polls
   (~200ms).
5. `startDaemon(config)` — bring up a fresh daemon.
6. Exit 0.

Compiled to `dist/src/gateway/restart-entry.js` (tsc picks it up automatically).

### 2. `restartDetached()` (new) — in `packages/jinn/src/gateway/lifecycle.ts`

Mirrors `startDaemon()`: resolves `restart-entry.js` via the same
candidate-path lookup, forks it detached with `stdio:"ignore"`,
`disconnect()` + `unref()`, passing `JINN_HOME` through the env. Returns
immediately.

### 3. `runRestart()` (new) — `packages/jinn/src/cli/restart.ts`

```
export async function runRestart(opts: { port?: number }): Promise<void> {
  // optional --port override on config, like runStart
  restartDetached(config);
  console.log("Gateway restarting in background (detached). It will be back in a few seconds.");
}
```

### 4. Command registration — `packages/jinn/bin/jinn.ts`

Add alongside `start`/`stop`:

```
program
  .command("restart")
  .description("Restart the gateway (detached — safe to run from inside a session)")
  .option("-p, --port <port>", "Port to start on")
  .action(async (opts) => {
    const { runRestart } = await import("../src/cli/restart.js");
    await runRestart({ port: opts.port ? parseInt(opts.port, 10) : undefined });
  });
```

## Flow after the change

1. Agent (inside a session) runs `jinn restart`.
2. `runRestart` forks the detached helper and exits immediately (0).
3. The gateway tears down sessions, killing the agent's PTY and the `jinn
   restart` foreground process — **but the helper is already reparented and
   unref'd, so it keeps running.**
4. Helper: `stop()` → wait for port free → `startDaemon()` → exit.
5. New gateway boots, resumes interrupted sessions; the web client reconnects
   and the conversation continues.

## Error handling / edge cases

- **Gateway already down:** `stop()` is a no-op (already handles stale PID /
  nothing-on-port); helper proceeds straight to start.
- **Port never frees (timeout):** after ~10s the helper attempts `startDaemon()`
  anyway; if the port is still bound, `startGateway` fails to bind and the
  helper logs + exits non-zero (visible in `~/.jinn/logs`). No worse than today.
- **Helper crashes:** logged via the uncaught-exception guards to the gateway
  log file; the user can re-run `jinn restart` or `jinn start`.

## Out of scope (explicitly not doing)

- Env-var (`JINN_IN_SESSION`) detection to auto-harden naive `stop && start`.
- Lockfile coordination between `stop` and `start`.
- Web rebuild folded into the command (`redeploy`).
- Literal PTY survival across restart (PTY-broker architecture).

These were considered and dropped as over-engineering for a dev-convenience fix.

## Replication note

Per ops reality: the live daemon runs from `~/Projects/jinn-sprint` (branch
`integration/engine-sprint-and-file-viewer`), while `~/Projects/jinn` (`main`)
is canonical. The change must be applied to **both** repos, then the daemon
rebuilt + restarted to take effect.

## Testing

- Unit: `restartDetached` forks the expected entry path (mirror any existing
  `startDaemon` test pattern).
- Manual: from inside a session, run `jinn restart`; confirm the gateway goes
  down and comes back and the web UI reconnects/resumes the conversation.
- Manual (terminal): run `jinn restart` from a plain terminal; confirm it
  restarts cleanly with no session attached.
