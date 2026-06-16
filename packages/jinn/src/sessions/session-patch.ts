import type { JinnConfig } from "../shared/types.js";
import { getModelRegistry, effortLevelsForModel } from "../shared/models.js";
import { logger } from "../shared/logger.js";

/**
 * Validate a mid-chat model/effort change for an existing session.
 *
 * Engine is NOT switchable mid-chat (new-chat only), so this only handles
 * `model` and `effortLevel`, validated against the registry for the session's
 * (fixed) engine. The change applies from the NEXT turn — the SessionManager
 * reads session.model / session.effortLevel fresh on every turn and passes them
 * (with resumeSessionId) to the engine, which our spike confirmed honors a
 * changed --model in place (no fork needed). Antigravity supports --model; if
 * its CLI is already warm, the new model applies on the next cold spawn/resume.
 */

export interface SessionPatchResult {
  ok: boolean;
  updates?: { model?: string; effortLevel?: string };
  error?: string;
}

export interface NewSessionSelectionResult {
  ok: boolean;
  engine?: string;
  model?: string;
  effortLevel?: string;
  error?: string;
}

export interface SessionPatchContext {
  engineSessionId?: string | null;
  defaultModel?: string | null;
}

export function validateNewSessionSelection(
  config: JinnConfig,
  body: { engine?: unknown; model?: unknown; effortLevel?: unknown },
): NewSessionSelectionResult {
  const registry = getModelRegistry(config);
  let engine: string = config.engines.default;

  if (body.engine !== undefined) {
    if (typeof body.engine !== "string" || !body.engine.trim()) {
      return { ok: false, error: "engine must be a non-empty string" };
    }
    engine = body.engine.trim();
  }

  const entry = registry[engine];
  if (!entry) return { ok: false, error: `unknown engine "${engine}"` };

  let model: string | undefined;
  if (body.model !== undefined) {
    if (typeof body.model !== "string" || !body.model.trim()) {
      return { ok: false, error: "model must be a non-empty string" };
    }
    model = body.model.trim();
    if (!entry.models.some((m) => m.id === model)) {
      if (engine === "pi") {
        // Pi models are discovered dynamically; tolerate an id the snapshot hasn't
        // caught yet (e.g. just after a restart, before discovery completes).
        logger.warn(`pi model "${model}" not in discovered set yet — allowing`);
      } else {
        const known = entry.models.map((m) => m.id).join(", ");
        return { ok: false, error: `unknown model "${model}" for engine "${engine}" (known: ${known || "none"})` };
      }
    }
  }

  let effortLevel: string | undefined;
  if (body.effortLevel !== undefined) {
    if (typeof body.effortLevel !== "string" || !body.effortLevel.trim()) {
      return { ok: false, error: "effortLevel must be a non-empty string" };
    }
    effortLevel = body.effortLevel.trim();
    const effectiveModel = model ?? undefined;
    const valid = effortLevelsForModel(config, engine, effectiveModel);
    if (valid.length === 0) {
      return { ok: false, error: `engine "${engine}"${effectiveModel ? ` model "${effectiveModel}"` : ""} does not support effort levels` };
    }
    if (!valid.includes(effortLevel)) {
      return { ok: false, error: `invalid effortLevel "${effortLevel}" (valid: ${valid.join(", ")})` };
    }
  }

  return { ok: true, engine, model, effortLevel };
}

export function validateSessionPatch(
  config: JinnConfig,
  engine: string,
  currentModel: string | null | undefined,
  body: { model?: unknown; effortLevel?: unknown },
  context: SessionPatchContext = {},
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
      if (engine === "pi") {
        // Pi models are discovered dynamically; tolerate an id the snapshot hasn't
        // caught yet (e.g. just after a restart, before discovery completes).
        logger.warn(`pi model "${modelId}" not in discovered set yet — allowing`);
      } else {
        const known = entry.models.map((m) => m.id).join(", ");
        return { ok: false, error: `unknown model "${modelId}" for engine "${engine}" (known: ${known || "none"})` };
      }
    }
    const effectiveCurrentModel = currentModel ?? context.defaultModel ?? undefined;
    if (engine === "grok" && context.engineSessionId && effectiveCurrentModel && modelId !== effectiveCurrentModel) {
      return {
        ok: false,
        error: "Grok model changes require a new session because Grok binds existing transcripts to a model-specific agent.",
      };
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
