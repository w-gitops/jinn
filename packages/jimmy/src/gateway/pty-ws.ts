import type { WebSocket } from "ws";
import type { InteractiveClaudeEngine } from "../engines/claude-interactive.js";

/**
 * Attach a /ws/pty/:sessionId WebSocket to a session's interactive PTY stream.
 * - replays the scrollback buffer on connect
 * - streams live PTY output as binary frames
 * - accepts upstream {type:"stdin",data} and {type:"resize",cols,rows} JSON messages
 * - on close, just unsubscribes — it does NOT kill the PTY (the lifecycle manager owns that)
 */
export function attachPtyWebSocket(ws: WebSocket, sessionId: string, engine: InteractiveClaudeEngine): void {
  // replay scrollback
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
