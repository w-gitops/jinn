/**
 * Jinn Talk — HTTP route dispatcher (Path 1).
 *
 * Single entry point `handleTalkApi(req, res, context)` for everything under
 * `/api/talk/*`. Registered from gateway/api.ts near the STT routes. Returns
 * `true` when it owns the path (so api.ts can early-return), `false` otherwise.
 *
 * Path 1 — the voice orchestrator is a REAL gateway session, not an in-process
 * Agent-SDK loop. So this dispatcher is thin: it only bootstraps/returns the
 * orchestrator session and exposes Kokoro TTS readiness/download. Actual voice
 * turns go through the normal POST /api/sessions/:id/message; the orchestrator's
 * spoken reply is synthesized server-side (see talk/tts-stream.ts, driven from
 * the run loop in api.ts) and streamed as talk:audio over the WebSocket.
 */
import type { IncomingMessage as HttpRequest, ServerResponse } from "node:http";
import type { ApiContext } from "../gateway/api.js";
import { createSession, getSessionBySessionKey } from "../sessions/registry.js";
import { validateCard, validateCardPatch } from "./card-validate.js";
import { TALK_EVENTS } from "./protocol.js";
import { getTalkTts } from "./tts-stream.js";

/** Stable session key for the single hands-free orchestrator surface. */
const TALK_SESSION_KEY = "talk:main";

/**
 * Dispatch any `/api/talk/*` request. Returns `true` if handled (caller should
 * early-return), `false` if the path is not a talk route.
 */
export async function handleTalkApi(
  req: HttpRequest,
  res: ServerResponse,
  context: ApiContext,
): Promise<boolean> {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;
  const method = req.method || "GET";

  if (!pathname.startsWith("/api/talk/")) return false;

  try {
    // POST /api/talk/session — bootstrap (or reuse) the orchestrator session.
    // The orchestrator is a normal idle gateway session with source:"talk";
    // buildContext() layers the AURA voice persona on it. Reuses the existing
    // talk session across reloads unless { fresh:true } is sent.
    if (method === "POST" && pathname === "/api/talk/session") {
      const parsed = await readJsonBody(req, res, { allowEmpty: true });
      if (!parsed.ok) return true;
      const body = (parsed.body ?? {}) as { fresh?: boolean };
      const config = context.getConfig();

      if (!body.fresh) {
        const existing = getSessionBySessionKey(TALK_SESSION_KEY);
        if (existing && existing.source === "talk") {
          json(res, { sessionId: existing.id, reused: true });
          return true;
        }
      }

      const session = createSession({
        engine: "claude",
        source: "talk",
        sourceRef: TALK_SESSION_KEY,
        connector: "web",
        sessionKey: TALK_SESSION_KEY,
        replyContext: { source: "talk" },
        model: config.talk?.orchestratorModel ?? "haiku",
        title: "Talk",
        portalName: config.portal?.portalName,
      });
      json(res, { sessionId: session.id, reused: false });
      return true;
    }

    // GET /api/talk/status — TTS engine readiness.
    if (method === "GET" && pathname === "/api/talk/status") {
      const s = getTalkTts(context.getConfig().talk?.kokoro).status();
      json(res, {
        ttsAvailable: s.available,
        ttsDownloading: s.downloading,
        progress: s.progress,
        voice: s.voice,
        ready: s.ready,
      });
      return true;
    }

    // POST /api/talk/tts/download — kick Kokoro weight download in the
    // background (progress streams over talk:tts:download:* WS events).
    if (method === "POST" && pathname === "/api/talk/tts/download") {
      getTalkTts(context.getConfig().talk?.kokoro)
        .download(context.emit)
        .catch((err) => {
          context.emit("talk:tts:download:error", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      json(res, { status: "downloading" });
      return true;
    }

    // ── Cards surface ───────────────────────────────────────────────────
    // The orchestrator (or any process acting on its behalf) pushes structured
    // content to the /talk UI by POSTing cards here. Each route validates the
    // untrusted body, then broadcasts the canonical talk:card* WS event so every
    // connected client mirrors the change. Cards are addressed by sessionId
    // (which talk surface) and, for update/dismiss, by cardId.

    // POST /api/talk/card — push a new card onto the surface.
    if (method === "POST" && pathname === "/api/talk/card") {
      const parsed = await readJsonBody(req, res);
      if (!parsed.ok) return true;
      const body = (parsed.body ?? {}) as { sessionId?: unknown; card?: unknown };
      if (typeof body.sessionId !== "string" || body.sessionId.length === 0) {
        badRequest(res, "sessionId must be a non-empty string");
        return true;
      }
      const validated = validateCard(body.card);
      if (!validated.ok) {
        badRequest(res, validated.error);
        return true;
      }
      context.emit(TALK_EVENTS.card, { sessionId: body.sessionId, card: validated.card });
      json(res, { ok: true });
      return true;
    }

    // POST /api/talk/card/update — patch an existing card by id.
    if (method === "POST" && pathname === "/api/talk/card/update") {
      const parsed = await readJsonBody(req, res);
      if (!parsed.ok) return true;
      const body = (parsed.body ?? {}) as {
        sessionId?: unknown;
        cardId?: unknown;
        patch?: unknown;
      };
      if (typeof body.sessionId !== "string" || body.sessionId.length === 0) {
        badRequest(res, "sessionId must be a non-empty string");
        return true;
      }
      if (typeof body.cardId !== "string" || body.cardId.length === 0) {
        badRequest(res, "cardId must be a non-empty string");
        return true;
      }
      if (typeof body.patch !== "object" || body.patch === null || Array.isArray(body.patch)) {
        badRequest(res, "patch must be a non-null object");
        return true;
      }
      // Field-validate the patch with the same rigor as a full card, so a patch
      // can't inject a malformed details/options/hunks/rows after the initial
      // card passed and crash the renderer.
      const patchCheck = validateCardPatch(body.patch);
      if (!patchCheck.ok) {
        badRequest(res, patchCheck.error);
        return true;
      }
      context.emit(TALK_EVENTS.cardUpdate, {
        sessionId: body.sessionId,
        cardId: body.cardId,
        patch: body.patch,
      });
      json(res, { ok: true });
      return true;
    }

    // POST /api/talk/card/dismiss — remove a single card by id.
    if (method === "POST" && pathname === "/api/talk/card/dismiss") {
      const parsed = await readJsonBody(req, res);
      if (!parsed.ok) return true;
      const body = (parsed.body ?? {}) as { sessionId?: unknown; cardId?: unknown };
      if (typeof body.sessionId !== "string" || body.sessionId.length === 0) {
        badRequest(res, "sessionId must be a non-empty string");
        return true;
      }
      if (typeof body.cardId !== "string" || body.cardId.length === 0) {
        badRequest(res, "cardId must be a non-empty string");
        return true;
      }
      context.emit(TALK_EVENTS.cardDismiss, {
        sessionId: body.sessionId,
        cardId: body.cardId,
      });
      json(res, { ok: true });
      return true;
    }

    // POST /api/talk/card/clear — wipe all cards for a surface.
    if (method === "POST" && pathname === "/api/talk/card/clear") {
      const parsed = await readJsonBody(req, res);
      if (!parsed.ok) return true;
      const body = (parsed.body ?? {}) as { sessionId?: unknown };
      if (typeof body.sessionId !== "string" || body.sessionId.length === 0) {
        badRequest(res, "sessionId must be a non-empty string");
        return true;
      }
      context.emit(TALK_EVENTS.cardClear, { sessionId: body.sessionId });
      json(res, { ok: true });
      return true;
    }

    // POST /api/talk/thread/label — set/refine a COO thread's topic label.
    // The orchestrator calls this so a thread shows a clean human topic in the
    // thread panel instead of the raw dispatch text. sessionId = the talk surface,
    // threadId = the COO child session id.
    if (method === "POST" && pathname === "/api/talk/thread/label") {
      const parsed = await readJsonBody(req, res);
      if (!parsed.ok) return true;
      const body = (parsed.body ?? {}) as { sessionId?: unknown; threadId?: unknown; label?: unknown };
      if (typeof body.sessionId !== "string" || body.sessionId.length === 0) {
        badRequest(res, "sessionId must be a non-empty string");
        return true;
      }
      if (typeof body.threadId !== "string" || body.threadId.length === 0) {
        badRequest(res, "threadId must be a non-empty string");
        return true;
      }
      if (typeof body.label !== "string" || body.label.trim().length === 0) {
        badRequest(res, "label must be a non-empty string");
        return true;
      }
      context.emit(TALK_EVENTS.threadLabel, {
        sessionId: body.sessionId,
        threadId: body.threadId,
        label: body.label.trim(),
      });
      json(res, { ok: true });
      return true;
    }

    // Unknown /api/talk/* path — let api.ts fall through to its 404.
    return false;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    json(res, { ok: false, error }, 500);
    return true;
  }
}

// ── Local copies of api.ts response helpers ─────────────────────────────
async function readJsonBody(
  req: HttpRequest,
  res: ServerResponse,
  opts?: { allowEmpty?: boolean },
): Promise<{ ok: true; body: unknown } | { ok: false }> {
  let raw: string;
  try {
    raw = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", reject);
    });
  } catch {
    badRequest(res, "Failed to read request body");
    return { ok: false };
  }
  if (!raw.trim()) {
    if (opts?.allowEmpty) return { ok: true, body: null };
    badRequest(res, "Empty request body");
    return { ok: false };
  }
  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    badRequest(res, "Invalid JSON in request body");
    return { ok: false };
  }
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function badRequest(res: ServerResponse, message: string): void {
  json(res, { error: message }, 400);
}
