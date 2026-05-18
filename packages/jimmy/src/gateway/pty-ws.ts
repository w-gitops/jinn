import type { WebSocket } from "ws";
import type { InteractiveClaudeEngine } from "../engines/claude-interactive.js";
import { getSession } from "../sessions/registry.js";
import { JINN_HOME } from "../shared/paths.js";

/**
 * Attach a /ws/pty/:sessionId WebSocket to a session's interactive PTY stream.
 *
 * Lifecycle:
 *   - On connect: eager-spawn the PTY if no warm one exists (resumes the conversation
 *     when an engineSessionId is known, otherwise spawns fresh — so a brand-new CLI-mode
 *     session shows the TUI before the user types anything).
 *   - The frontend sends `{type:"viewing", viewing:true|false}` on mount, unmount, and
 *     Page Visibility changes. Each enter is ref-counted; when the count reaches zero
 *     (and no turn is running), the 10-min keep-alive grace window starts.
 *   - On `viewing:true` after a reap, re-spawns to auto-resume transparently.
 *   - On `ws.close`, decrements the viewer count if this socket reported viewing.
 *     Does NOT directly kill the PTY — the lifecycle manager owns that.
 */
export function attachPtyWebSocket(ws: WebSocket, sessionId: string, engine: InteractiveClaudeEngine): void {
  const spawnIfNeeded = () => {
    if (engine.hasWarmPty(sessionId)) return;
    const session = getSession(sessionId);
    engine.ensureIdleSpawn(sessionId, {
      claudeSessionId: session?.engineSessionId ?? undefined,
      model: session?.model ?? undefined,
      cwd: JINN_HOME,
    });
  };

  // Eager spawn so the terminal shows the TUI immediately on session open.
  spawnIfNeeded();

  // Subscribe FIRST, then replay scrollback. Reverse order had a race window
  // between snapshot and subscribe where PTY bytes could be lost — the snapshot
  // was already captured (so the replay didn't have them) and the subscriber
  // wasn't attached yet (so the live forward missed them too). With this order
  // those bytes arrive via the subscriber, slightly out of order vs. scrollback
  // but never missing.
  const unsubscribe = engine.subscribeOutput(
    sessionId,
    (data) => { if (ws.readyState === ws.OPEN) ws.send(data); },
    (event) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event)); },
  );

  // Replay scrollback (may now include the idle-spawn's first bytes).
  const scrollback = engine.getScrollback(sessionId);
  if (scrollback.length > 0 && ws.readyState === ws.OPEN) ws.send(scrollback);

  // Track whether this socket has reported viewing:true so close-cleanup can
  // decrement only if it actually incremented. Guards against double-decrement
  // on flaky reconnects.
  let didEnter = false;

  ws.on("message", (raw) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg?.type === "stdin" && typeof msg.data === "string") {
      engine.writeStdin(sessionId, msg.data);
    } else if (msg?.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
      engine.resizePty(sessionId, msg.cols, msg.rows);
    } else if (msg?.type === "viewing" && typeof msg.viewing === "boolean") {
      if (msg.viewing) {
        // If the PTY was reaped during a hidden tab, respawn before counting the viewer.
        spawnIfNeeded();
        if (!didEnter) {
          engine.setViewing(sessionId, true);
          didEnter = true;
        }
      } else {
        if (didEnter) {
          engine.setViewing(sessionId, false);
          didEnter = false;
        }
      }
    }
  });

  const onDisconnect = () => {
    unsubscribe();
    if (didEnter) {
      engine.setViewing(sessionId, false);
      didEnter = false;
    }
  };
  ws.on("close", onDisconnect);
  ws.on("error", onDisconnect);
}
