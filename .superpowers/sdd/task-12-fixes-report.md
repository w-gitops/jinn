# Task 12 — Hermes Engine Correctness Fixes

## Fix 1: honor `opts.systemPrompt` (Important)

**Files changed:**
- `packages/jinn/src/engines/hermes-acp.ts` — in `run()`, build `rawPrompt` before `session/prompt`:
  ```ts
  const rawPrompt =
    opts.systemPrompt && !opts.resumeSessionId
      ? `${opts.systemPrompt}\n\n${opts.prompt}`
      : opts.prompt;
  ```
  Then pass `extractPromptText(rawPrompt)` instead of `extractPromptText(opts.prompt)`.

**Tests added:**
- `"prepends systemPrompt to prompt on a fresh (non-resume) session"` — captures `session/prompt` params in a spy server, asserts `capturedPromptText` contains `"PERSONA-XYZ"` and `"user question"`.  RED before fix → GREEN after.
- `"does NOT prepend systemPrompt when resumeSessionId is set"` — same spy, asserts `capturedPromptText` does NOT contain `"PERSONA-XYZ"`.  RED → GREEN.

---

## Fix 2: never let `run()` hang on spawn/handshake failure (Important)

### 2(a) — spawn error surface

**Files changed:**
- `packages/jinn/src/engines/hermes-acp.ts`:
  - `ProcHandle` interface: added `onError: (cb: (err: Error) => void) => void`
  - `spawnProc` real impl: added `onError: (cb) => child.on("error", cb)`
  - `getOrSpawn`: registers handler that sets `entry.alive = false` and calls `handle.rpc.rejectAll(new Error("hermes acp spawn/process error: " + err.message))`

**Tests:** all fake `spawnProc` overrides updated to return `onError: (_cb) => {}` (no-op stub) — existing test stays GREEN, new tests compile cleanly.

### 2(b) — handshake timeout

**Files changed:**
- `packages/jinn/src/engines/hermes-acp.ts`:
  - Added `const HANDSHAKE_TIMEOUT_MS = 60_000`
  - Added `protected handshakeTimeoutMs = HANDSHAKE_TIMEOUT_MS` (test seam)
  - Wrapped pre-prompt phase (` await p.initialized` + session setup + set_mode + set_model) in `Promise.race([..., timeoutReject])` with `handshakeWatchdog.unref?.()` and `clearTimeout` in `finally`
  - Catch block returns `{ sessionId: "", result: "", error: msg }` — `run()` always resolves, never rejects

**Test added:**
- `"resolves with error (not hangs) when handshake times out"` — `HangEngine` overrides `handshakeTimeoutMs = 50` and returns a passthrough fake server that never writes `initialize` response.  Asserts `r.error` matches `/handshake timeout/`, `r.sessionId === ""`, `r.result === ""`.  RED (would hang forever) → GREEN in ~50ms.

---

## Fix 3: `session/load` failure falls back to `session/new` (Important)

**Files changed:**
- `packages/jinn/src/engines/hermes-acp.ts` — inside the handshake IIFE, wrapped `rpc.request("session/load", ...)` in `try/catch`; on failure logs a warning, falls through to `session/new`, sets `p.hermesSessionId` to the new session's id, and sets `p.currentModelId` from its models.

**Test added:**
- `"falls back to session/new when session/load fails, returning the new session id"` — `fakeServerLoadFail()` rejects `session/load` with JSON-RPC error `{ code: -32000, message: "session not found" }`, answers `session/new` with `sessionId: "NEW-1"`, streams `"fallback ok"`.  Run with `resumeSessionId: "stale-id"`.  Asserts `r.error` is undefined, `r.sessionId === "NEW-1"`, `r.result === "fallback ok"`.  RED (errored and left sessionId stale) → GREEN.

---

## Fix 4: discriminate auto-approve callback by method (Minor)

**Files changed:**
- `packages/jinn/src/engines/hermes-acp.ts` — `getOrSpawn`: changed
  ```ts
  handle.rpc.onServerRequest(() => ALLOW_ALWAYS);
  ```
  to
  ```ts
  handle.rpc.onServerRequest((method) =>
    method === "session/request_permission" ? ALLOW_ALWAYS : {},
  );
  ```

**Tests:** no dedicated test (the fake server never sends server→client requests in the test suite — behavior only observable with a live Hermes binary). Existing tests unaffected (GREEN).

---

## Full-suite results

```
hermes-acp test file: 5 passed (5)  [was 1 before this task]
npm run typecheck: clean (0 errors, 0 warnings)
Full suite (npx vitest run): 1163 passed | 93 failed | 1 skipped
  — pre-existing failures: same 93 failures present on the unmodified branch
  — my changes add exactly 4 new passing tests (+4 from 1159 baseline)
```

All pre-existing failures are in unrelated packages (e.g. `packages/web` card-stack / JSDOM environment issues) and were present before this task.

---

## Commit

`fix(hermes): honor systemPrompt; guard spawn/handshake hangs; session/load fallback; scope auto-approve`
