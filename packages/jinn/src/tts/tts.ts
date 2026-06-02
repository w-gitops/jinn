import type { WebSocket } from "ws";
import type { JinnConfig, StreamDelta } from "../shared/types.js";
import { logger } from "../shared/logger.js";

/* ── Sentence segmentation ───────────────────────────────────────────────────
 *
 * Upstream rebase note: the headless -p engine was deleted; the interactive
 * SSE-intercept path only emits incremental `text` deltas (no text_snapshot).
 * Segmentation is therefore purely accumulative — append text deltas, scan for
 * the last sentence boundary, extract the settled prefix, hold the partial tail.
 *
 * Guard: don't emit text inside an open code fence (odd ``` count).
 * ─────────────────────────────────────────────────────────────────────────── */

function extractSettledSentences(buffer: string): { settled: string; remainder: string } {
  const fences = (buffer.match(/```/g) ?? []).length;
  if (fences % 2 === 1) return { settled: "", remainder: buffer };

  // Scan backwards for the last sentence boundary (.!?\n).
  for (let i = buffer.length - 1; i >= 0; i--) {
    const ch = buffer[i];
    if (ch === "." || ch === "!" || ch === "?" || ch === "\n") {
      return {
        settled: buffer.slice(0, i + 1).trim(),
        remainder: buffer.slice(i + 1),
      };
    }
  }
  return { settled: "", remainder: buffer };
}

// Chatterbox is ~70ms/char; cap at 250 chars per synthesis request (≈17s worst-case).
const MAX_SEGMENT_CHARS = 250;

function chunkText(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  while (text.length > MAX_SEGMENT_CHARS) {
    let cut = text.lastIndexOf(",", MAX_SEGMENT_CHARS);
    if (cut < 60) cut = MAX_SEGMENT_CHARS;
    out.push(text.slice(0, cut).trim());
    text = text.slice(cut).trim();
  }
  if (text) out.push(text);
  return out;
}

/* ── Markdown stripper ───────────────────────────────────────────────────────
 * Applied server-side before sending text to Chatterbox so the TTS voice
 * never reads markdown syntax aloud.
 * ─────────────────────────────────────────────────────────────────────────── */

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")            // fenced code blocks
    .replace(/`[^`]+`/g, " ")                   // inline code
    .replace(/\*\*(.+?)\*\*/g, "$1")            // bold
    .replace(/\*(.+?)\*/g, "$1")                // italic
    .replace(/^#{1,6} /gm, "")                  // heading markers
    .replace(/!?\[([^\]]*)\]\([^)]+\)/g, "$1")  // links/images → label only
    .replace(/\s+/g, " ")
    .trim();
}

/* ── Per-session TTS state ───────────────────────────────────────────────────
 * One entry per open /ws/tts/:sessionId connection.
 * ─────────────────────────────────────────────────────────────────────────── */

interface TtsSession {
  ws: WebSocket;
  autoRead: boolean;
  /** Accumulated text not yet extracted as a complete sentence. */
  buffer: string;
  /** AbortController for the synthesis request currently in flight. */
  abortController: AbortController | null;
}

/* ── Global synthesis queue ──────────────────────────────────────────────────
 * Chatterbox serializes globally (~70ms/char). One synthesis runs at a time
 * across ALL sessions. Barge-in aborts the in-flight request for a specific
 * session; other sessions continue draining the queue.
 * ─────────────────────────────────────────────────────────────────────────── */

interface QueueItem {
  sessionId: string;
  text: string;
}

/* ── WS open state constant ──────────────────────────────────────────────────
 * Avoids relying on the `ws` import for the OPEN constant (ws.OPEN works on
 * instances but the numeric value 1 is stable across all versions).
 * ─────────────────────────────────────────────────────────────────────────── */
const WS_OPEN = 1;

/* ── TtsManager ─────────────────────────────────────────────────────────────── */

export class TtsManager {
  private sessions = new Map<string, TtsSession>();
  private synthesizing = false;
  private queue: QueueItem[] = [];
  private config: JinnConfig;

  constructor(config: JinnConfig) {
    this.config = config;
  }

  /** Called when config.yaml is reloaded. */
  updateConfig(config: JinnConfig): void {
    this.config = config;
  }

  /* ── Session registration ─────────────────────────────────────────────── */

  register(sessionId: string, ws: WebSocket, prefs: { autoRead: boolean }): void {
    const existing = this.sessions.get(sessionId);
    if (existing && existing.ws !== ws) {
      // Old socket replaced (re-connect) — cancel its in-flight synthesis.
      existing.abortController?.abort();
    }
    this.sessions.set(sessionId, {
      ws,
      autoRead: prefs.autoRead,
      buffer: "",
      abortController: null,
    });
    logger.info(`TTS: session ${sessionId} registered (autoRead=${prefs.autoRead})`);
  }

  deregister(sessionId: string, ws: WebSocket): void {
    const sess = this.sessions.get(sessionId);
    if (!sess || sess.ws !== ws) return; // stale reference from a reconnect
    sess.abortController?.abort();
    this.sessions.delete(sessionId);
    this.queue = this.queue.filter((item) => item.sessionId !== sessionId);
    logger.info(`TTS: session ${sessionId} deregistered`);
  }

  setAutoRead(sessionId: string, autoRead: boolean): void {
    const sess = this.sessions.get(sessionId);
    if (!sess) return;
    sess.autoRead = autoRead;
    if (!autoRead) this.barge(sessionId);
  }

  /* ── Public commands from WS client ──────────────────────────────────── */

  /** Speak specific text on demand (manual read-aloud button). */
  speak(sessionId: string, text: string): void {
    const sess = this.sessions.get(sessionId);
    if (!sess) return;
    const clean = stripMarkdown(text);
    if (!clean) return;
    this.barge(sessionId); // clear any current audio for this session
    for (const chunk of chunkText(clean)) {
      this.queue.push({ sessionId, text: chunk });
    }
    void this.drain();
  }

  /** Cancel in-flight synthesis and clear the queue for a session. */
  barge(sessionId: string): void {
    const sess = this.sessions.get(sessionId);
    if (!sess) return;
    sess.abortController?.abort();
    sess.abortController = null;
    sess.buffer = "";
    this.queue = this.queue.filter((item) => item.sessionId !== sessionId);
    if (sess.ws.readyState === WS_OPEN) {
      sess.ws.send(JSON.stringify({ type: "tts:barged" }));
    }
  }

  /* ── Gateway event hook ───────────────────────────────────────────────── */

  /**
   * Called from server.ts `emit()` for every gateway event.
   * Feeds text deltas into the per-session accumulative buffer and enqueues
   * synthesis when a complete sentence boundary is detected.
   */
  handleGatewayEvent(event: string, payload: unknown): void {
    if (!this.config.tts?.enabled) return;

    const p = payload as Record<string, unknown>;
    const sessionId = String(p.sessionId ?? "");

    if (event === "session:delta") {
      const sess = this.sessions.get(sessionId);
      if (!sess?.autoRead) return;

      const delta = {
        type: String(p.type ?? ""),
        content: String(p.content ?? ""),
        subAgent: p.subAgent as { id: string } | undefined,
      };

      // Only main-agent text deltas feed the TTS pipeline.
      // context deltas carry token counts; subAgent deltas belong to sub-agent cards.
      if (delta.type !== "text" || delta.subAgent?.id) return;
      if (!delta.content) return;

      sess.buffer += delta.content;
      const { settled, remainder } = extractSettledSentences(sess.buffer);
      sess.buffer = remainder;
      if (!settled) return;

      const clean = stripMarkdown(settled);
      for (const chunk of chunkText(clean)) {
        this.queue.push({ sessionId, text: chunk });
      }
      void this.drain();
    }

    // Flush the trailing partial sentence when a turn ends.
    if (event === "session:completed" || event === "session:stopped") {
      const sess = this.sessions.get(sessionId);
      if (!sess?.autoRead) return;
      const trailing = sess.buffer.trim();
      sess.buffer = "";
      if (!trailing) return;
      const clean = stripMarkdown(trailing);
      for (const chunk of chunkText(clean)) {
        this.queue.push({ sessionId, text: chunk });
      }
      void this.drain();
    }
  }

  /* ── Synthesis engine ────────────────────────────────────────────────── */

  private async drain(): Promise<void> {
    if (this.synthesizing) return;
    this.synthesizing = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        const sess = this.sessions.get(item.sessionId);
        if (!sess || sess.ws.readyState !== WS_OPEN) continue; // skip dead sessions

        const controller = new AbortController();
        sess.abortController = controller;
        try {
          const mp3 = await this.callChatterbox(item.text, controller.signal);
          if (sess.ws.readyState === WS_OPEN) {
            sess.ws.send(mp3);
          }
        } catch (err) {
          if ((err as Error)?.name !== "AbortError") {
            logger.warn(
              `TTS synthesis failed for session ${item.sessionId}: ` +
              `${err instanceof Error ? err.message : String(err)}`,
            );
          }
        } finally {
          if (sess.abortController === controller) sess.abortController = null;
        }
      }
    } finally {
      this.synthesizing = false;
      // Restart if items arrived while the last synthesis was in-flight.
      if (this.queue.length > 0) void this.drain();
    }
  }

  private async callChatterbox(text: string, signal: AbortSignal): Promise<Buffer> {
    const tts = this.config.tts;
    const baseUrl = (tts?.url ?? "http://192.168.200.42:9004/v1").replace(/\/+$/, "");
    const voice = tts?.voice ?? "default";
    const format = tts?.format ?? "mp3";

    const response = await fetch(`${baseUrl}/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: text,
        model: "chatterbox",
        voice,
        response_format: format,
      }),
      signal,
    });

    if (!response.ok) {
      throw new Error(`Chatterbox returned HTTP ${response.status}`);
    }

    return Buffer.from(await response.arrayBuffer());
  }
}
