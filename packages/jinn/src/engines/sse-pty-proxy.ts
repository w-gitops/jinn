import http from "node:http";
import https from "node:https";
import { logger } from "../shared/logger.js";

/** A parsed Anthropic SSE event's `data:` JSON payload (already JSON.parsed). */
export interface SseDataEvent {
  type?: string;
  [k: string]: unknown;
}

/**
 * Per-PTY forward proxy. The genuine `claude` CLI is pointed at this proxy via
 * ANTHROPIC_BASE_URL; every request is forwarded UNCHANGED to api.anthropic.com
 * (same method/path/headers/body, subscription OAuth token preserved → still
 * cc_entrypoint=cli, subsidy-safe — verified in Item A) and the response is
 * streamed back to the client byte-for-byte. The ONLY mutation is stripping the
 * client's `accept-encoding` so the SSE body comes back as plaintext we can
 * parse; the (now-uncompressed) response headers are forwarded as-is.
 *
 * When the upstream response is text/event-stream we tee a parsed copy of each
 * SSE `data:` event to `onEvent` — this is the live streaming source for the web
 * chat pane (word-by-word text, tool markers in true order, live context tokens).
 *
 * One proxy per PTY: concurrent turns per session are forbidden, so every SSE
 * event seen during an active turn belongs to that turn — no request→turn
 * correlation needed.
 */
export class SsePtyProxy {
  private server: http.Server;
  /** Resolved listening port (0 until start() completes). */
  port = 0;

  constructor(
    private readonly label: string,
    private readonly onEvent: (e: SseDataEvent) => void,
  ) {
    this.server = http.createServer((req, res) => this.handle(req, res));
    // node http servers throw on unhandled 'clientError'; swallow so a flaky
    // client socket can never crash the daemon.
    this.server.on("clientError", (err, socket) => {
      logger.warn(`SsePtyProxy[${this.label}] clientError: ${err.message}`);
      try { socket.destroy(); } catch { /* already gone */ }
    });
  }

  /** Bind to an ephemeral 127.0.0.1 port; resolves with the chosen port. */
  start(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const onErr = (err: Error) => reject(err);
      this.server.once("error", onErr);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", onErr);
        const addr = this.server.address();
        this.port = typeof addr === "object" && addr ? addr.port : 0;
        resolve(this.port);
      });
    });
  }

  /** Tear down the proxy. Safe to call multiple times. */
  stop(): void {
    try { this.server.close(); } catch { /* already closed */ }
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("error", () => { try { res.destroy(); } catch { /* ignore */ } });
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const headers: Record<string, unknown> = { ...req.headers, host: "api.anthropic.com" };
      // Plaintext SSE so we can parse it; we then forward the (uncompressed)
      // upstream response headers as-is, so the client sees consistent framing.
      delete headers["accept-encoding"];

      const upstream = https.request(
        {
          hostname: "api.anthropic.com",
          port: 443,
          path: req.url,
          method: req.method,
          headers: headers as http.OutgoingHttpHeaders,
        },
        (uRes) => {
          res.writeHead(uRes.statusCode || 502, uRes.headers);
          const isSSE = String(uRes.headers["content-type"] || "").includes("text/event-stream");
          let sseBuf = "";
          uRes.on("data", (chunk: Buffer) => {
            // Forward UNCHANGED to the client first (never let parsing affect the stream).
            try { res.write(chunk); } catch { /* client gone */ }
            if (isSSE) sseBuf = this.parseSse(sseBuf + chunk.toString("utf-8"));
          });
          uRes.on("end", () => { try { res.end(); } catch { /* already ended */ } });
          uRes.on("error", () => { try { res.end(); } catch { /* ignore */ } });
        },
      );
      upstream.on("error", (err) => {
        logger.warn(`SsePtyProxy[${this.label}] upstream error: ${err.message}`);
        try { if (!res.headersSent) res.writeHead(502); res.end(); } catch { /* ignore */ }
      });
      if (body.length) upstream.write(body);
      upstream.end();
    });
  }

  /** Consume complete SSE frames (separated by a blank line) from `buf`,
   *  JSON.parse each event's `data:` payload, fire onEvent, and return the
   *  trailing incomplete remainder for the next chunk. */
  private parseSse(buf: string): string {
    let idx: number;
    // Frames are delimited by a blank line. Handle both \n\n and \r\n\r\n.
    while ((idx = indexOfFrameEnd(buf)) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + frameDelimLen(buf, idx));
      let dataStr = "";
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith("data:")) dataStr += line.slice(5).trimStart();
      }
      if (!dataStr || dataStr === "[DONE]") continue;
      let parsed: SseDataEvent;
      try { parsed = JSON.parse(dataStr) as SseDataEvent; } catch { continue; }
      try { this.onEvent(parsed); } catch (err) {
        logger.warn(`SsePtyProxy[${this.label}] onEvent threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return buf;
  }
}

/** Index of the first blank-line frame delimiter (\n\n or \r\n\r\n), or -1. */
function indexOfFrameEnd(buf: string): number {
  const a = buf.indexOf("\n\n");
  const b = buf.indexOf("\r\n\r\n");
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

function frameDelimLen(buf: string, idx: number): number {
  return buf.startsWith("\r\n\r\n", idx) ? 4 : 2;
}
