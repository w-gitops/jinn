import http from "node:http";
import https from "node:https";
import { createHash } from "node:crypto";
import { logger } from "../shared/logger.js";

/** Shared keep-alive agent so concurrent turns (and sub-agent fan-out) reuse a
 *  small TLS socket pool instead of opening a fresh handshake per request — the
 *  per-request TLS churn was the likely source of intermittent "bad record mac"
 *  errors under sub-agent concurrency. */
const upstreamAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });

/** Kill an upstream connection that goes silent this long (no bytes). Generous so
 *  long extended-thinking pauses and slow first-token never trip it; only a truly
 *  hung/half-open socket is reaped. */
const UPSTREAM_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

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
 * Sub-agent suppression: Claude Code runs Task sub-agents IN-PROCESS, so their
 * nested /v1/messages streams inherit ANTHROPIC_BASE_URL and flow through this
 * same proxy — teeing them would flood the chat pane with every sub-agent's
 * token-by-token output (4 parallel agents => 4× noise). We distinguish the main
 * agent from sub-agents by the request's `system` prompt: Claude Code keeps the
 * top-level agent's system prompt byte-stable across the whole session (required
 * for prompt-cache hits), while each sub-agent carries its own distinct system
 * prompt. We fingerprint the first request's system as "main" and tee ONLY
 * streams whose system matches it; sub-agent streams are still forwarded to the
 * CLI byte-for-byte (so they work) but never teed to the chat. Fail-open: an
 * unparseable body or missing system prompt is treated as main (teed).
 */
export class SsePtyProxy {
  private server: http.Server;
  /** Resolved listening port (0 until start() completes). */
  port = 0;
  /** Fingerprint of the top-level (main) agent's system prompt, captured from the
   *  first classifiable request. Streams whose system prompt differs are sub-agents. */
  private mainSystemFp: string | null = null;

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
    let upstream: http.ClientRequest | undefined;
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("error", () => { try { res.destroy(); } catch { /* ignore */ } });
    // Client (the claude CLI) hung up — abort the in-flight upstream so we don't
    // keep streaming to a dead socket (resource leak per interrupted turn).
    req.on("close", () => { try { upstream?.destroy(); } catch { /* ignore */ } });
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      // A sub-agent stream is still forwarded to the CLI byte-for-byte, but NOT
      // teed to the chat pane. Decided once per request from the body's system prompt.
      const tee = !this.isSubagentRequest(body);
      const headers: Record<string, unknown> = { ...req.headers, host: "api.anthropic.com" };
      // Plaintext SSE so we can parse it; we then forward the (uncompressed)
      // upstream response headers as-is, so the client sees consistent framing.
      delete headers["accept-encoding"];

      upstream = https.request(
        {
          hostname: "api.anthropic.com",
          port: 443,
          path: req.url,
          method: req.method,
          headers: headers as http.OutgoingHttpHeaders,
          agent: upstreamAgent,
        },
        (uRes) => {
          res.writeHead(uRes.statusCode || 502, uRes.headers);
          const isSSE = tee && String(uRes.headers["content-type"] || "").includes("text/event-stream");
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
      upstream.setTimeout(UPSTREAM_IDLE_TIMEOUT_MS, () => {
        logger.warn(`SsePtyProxy[${this.label}] upstream idle-timeout — destroying`);
        try { upstream?.destroy(new Error("upstream idle timeout")); } catch { /* ignore */ }
      });
      if (body.length) upstream.write(body);
      upstream.end();
    });
  }

  /** Classify a request as a sub-agent stream (true => don't tee to chat) by
   *  comparing its system-prompt fingerprint to the first-seen (main) one.
   *  Fail-open: unparseable body / no system prompt => false (treated as main). */
  private isSubagentRequest(body: Buffer): boolean {
    let fp: string | null = null;
    try {
      const json = JSON.parse(body.toString("utf-8")) as { system?: unknown };
      if (json && json.system != null) {
        const sys = typeof json.system === "string" ? json.system : JSON.stringify(json.system);
        fp = createHash("sha1").update(sys).digest("hex");
      }
    } catch { /* not JSON / no body — fail open */ }
    if (fp == null) return false;                       // can't classify → treat as main
    if (this.mainSystemFp == null) { this.mainSystemFp = fp; return false; } // first = main
    return fp !== this.mainSystemFp;                    // different system = sub-agent
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
