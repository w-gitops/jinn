import type { WebSocket } from "ws";
import type { TtsManager } from "./tts.js";

/**
 * Attach a /ws/tts/:sessionId WebSocket to the TTS manager.
 *
 * Protocol (client → server JSON):
 *   {type:"tts:prefs",  autoRead:boolean}  — sent on connect, announces preference
 *   {type:"tts:speak",  text:string}        — manual one-shot synthesis request
 *   {type:"tts:barge"}                      — cancel in-flight synthesis + clear queue
 *
 * Protocol (server → client):
 *   binary frame (Buffer)                   — one synthesized MP3 per sentence
 *   {type:"tts:barged"}                     — server confirmed cancellation
 */
export function attachTtsWebSocket(
  ws: WebSocket,
  sessionId: string,
  ttsManager: TtsManager,
): void {
  // Register with autoRead=false until the client announces its preference.
  ttsManager.register(sessionId, ws, { autoRead: false });

  ws.on("message", (raw) => {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(String(raw)); } catch { return; }

    if (msg.type === "tts:prefs" && typeof msg.autoRead === "boolean") {
      ttsManager.setAutoRead(sessionId, msg.autoRead);
    } else if (msg.type === "tts:speak" && typeof msg.text === "string" && msg.text.trim()) {
      ttsManager.speak(sessionId, msg.text);
    } else if (msg.type === "tts:barge") {
      ttsManager.barge(sessionId);
    }
  });

  const onDisconnect = () => { ttsManager.deregister(sessionId, ws); };
  ws.on("close", onDisconnect);
  ws.on("error", onDisconnect);
}
