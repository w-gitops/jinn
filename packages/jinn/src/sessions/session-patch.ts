import type { JinnConfig } from "../shared/types.js";
import { getModelRegistry, effortLevelsForModel } from "../shared/models.js";

/**
 * Validate a mid-chat model/effort change for an existing session.
 *
 * Engine is NOT switchable mid-chat (new-chat only), so this only handles
 * `model` and `effortLevel`, validated against the registry for the session's
 * (fixed) engine. The change applies from the NEXT turn — the SessionManager
 * reads session.model / session.effortLevel fresh on every turn and passes them
 * (with resumeSessionId) to the engine, which our spike confirmed honors a
 * changed --model in place (no fork needed). Antigravity ignores model/effort
 * flags today, so the values are persisted but are a runtime no-op there.
 */

export interface SessionPatchResult {
  ok: boolean;
  updates?: { model?: string; effortLevel?: string };
  error?: string;
}

export function validateSessionPatch(
  config: JinnConfig,
  engine: string,
  currentModel: string | null | undefined,
  body: { model?: unknown; effortLevel?: unknown },
): SessionPatchResult {
  const updates: { model?: string; effortLevel?: string } = {};

  const entry = getModelRegistry(config)[engine];

  // --- model ---
  if (body.model !== undefined) {
    if (typeof body.model !== "string" || !body.model.trim()) {
      return { ok: false, error: "model must be a non-empty string" };
    }
    const modelId = body.model.trim();
    if (entry && !entry.models.some((m) => m.id === modelId)) {
      const known = entry.models.map((m) => m.id).join(", ");
      return { ok: false, error: `unknown model "${modelId}" for engine "${engine}" (known: ${known || "none"})` };
    }
    updates.model = modelId;
  }

  // --- effortLevel (validated against the *resulting* model) ---
  if (body.effortLevel !== undefined) {
    if (typeof body.effortLevel !== "string" || !body.effortLevel.trim()) {
      return { ok: false, error: "effortLevel must be a non-empty string" };
    }
    const level = body.effortLevel.trim();
    const effectiveModel = updates.model ?? currentModel ?? undefined;
    const valid = effortLevelsForModel(config, engine, effectiveModel);
    if (valid.length === 0) {
      return { ok: false, error: `engine "${engine}"${effectiveModel ? ` model "${effectiveModel}"` : ""} does not support effort levels` };
    }
    if (!valid.includes(level)) {
      return { ok: false, error: `invalid effortLevel "${level}" (valid: ${valid.join(", ")})` };
    }
    updates.effortLevel = level;
  }

  if (updates.model === undefined && updates.effortLevel === undefined) {
    return { ok: false, error: "no valid fields to update (expected model and/or effortLevel)" };
  }
  return { ok: true, updates };
}
