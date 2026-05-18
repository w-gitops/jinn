import type { WebSocket } from "ws";
import type { InteractiveClaudeEngine } from "../engines/claude-interactive.js";
import { getSession } from "../sessions/registry.js";
import { JINN_HOME } from "../shared/paths.js";

/**
 * Attach a /ws/pty/:sessionId WebSocket to a session's interactive PTY stream.
 * - replays the scrollback buffer on connect
 * - streams live PTY output as binary frames
 * - accepts upstream {type:"stdin",data} and {type:"resize",cols,rows} JSON messages
 * - on close, just unsubscribes — it does NOT kill the PTY (the lifecycle manager owns that)
 */
export function attachPtyWebSocket(ws: WebSocket, sessionId: string, engine: InteractiveClaudeEngine): void {
  // If nothing is happening for this session yet (no warm PTY, empty scrollback),
  // and we know the Claude session id from the DB, spawn an idle TUI so the user sees
  // the conversation history immediately instead of a blank "Waiting" screen.
  const initialScrollback = engine.getScrollback(sessionId);
  if (!initialScrollback) {
    const session = getSession(sessionId);
    if (session?.engineSessionId) {
      engine.ensureIdleSpawn(sessionId, {
        claudeSessionId: session.engineSessionId,
        model: session.model ?? undefined,
        cwd: JINN_HOME,
      });
    }
  }

  // replay scrollback (may now include the idle-spawn's first bytes)
  const scrollback = engine.getScrollback(sessionId);
  if (scrollback && ws.readyState === ws.OPEN) ws.send(Buffer.from(scrollback, "utf-8"));

  // live output
  const unsubscribe = engine.subscribeOutput(sessionId, (data) => {
    if (ws.readyState === ws.OPEN) ws.send(Buffer.from(data, "utf-8"));
  });

  ws.on("message", (raw) => {
    let msg: any;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg?.type === "stdin" && typeof msg.data === "string") {
      engine.writeStdin(sessionId, msg.data);
    } else if (msg?.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
      engine.resizePty(sessionId, msg.cols, msg.rows);
    }
  });

  ws.on("close", () => { unsubscribe(); });
  ws.on("error", () => { unsubscribe(); });
}
