import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { StreamDelta } from "../shared/types.js";
import { logger } from "../shared/logger.js";

/**
 * Pure protocol helpers for the Antigravity (`agy`) engine — no PTY, no I/O
 * orchestration, so they're unit-testable in isolation.
 *
 * `agy` has no headless/`--print` mode and no hook system. The only machine-
 * readable surface is the per-conversation transcript it writes to disk:
 *   ~/.gemini/antigravity-cli/brain/<convId>/.system_generated/logs/transcript.jsonl
 *
 * Each line is a JSON object: { step_index, source, type, status, content }.
 *   - source "USER_EXPLICIT" / type "USER_INPUT"      → our prompt
 *   - source "SYSTEM"        / type "CONVERSATION_HISTORY"
 *   - source "MODEL"         / type "PLANNER_RESPONSE" → assistant turn;
 *       status "DONE" marks turn completion, `content` is the answer.
 */

/** agy's on-disk state dir (shared with Gemini account dir). */
export const ANTIGRAVITY_HOME = path.join(os.homedir(), ".gemini", "antigravity-cli");
export const ANTIGRAVITY_BRAIN_DIR = path.join(ANTIGRAVITY_HOME, "brain");
export const ANTIGRAVITY_SETTINGS_PATH = path.join(ANTIGRAVITY_HOME, "settings.json");

/** Absolute path to a conversation's streaming transcript. */
export function transcriptPathFor(convId: string, brainDir: string = ANTIGRAVITY_BRAIN_DIR): string {
  return path.join(brainDir, convId, ".system_generated", "logs", "transcript.jsonl");
}

/** Absolute path to a conversation's FULL transcript (history + tool calls) —
 *  the closest on-disk proxy for what the model carries as context. */
export function fullTranscriptPathFor(convId: string, brainDir: string = ANTIGRAVITY_BRAIN_DIR): string {
  return path.join(brainDir, convId, ".system_generated", "logs", "transcript_full.jsonl");
}

/** Estimate context tokens for an agy conversation. agy exposes NO usage data, so
 *  this is an APPROXIMATION: bytes of the full transcript / 4 (the standard rough
 *  chars-per-token ratio). Good enough for a "how full is the window" gauge against
 *  a 1M-token model; not an exact count. Returns 0 if the transcript is unreadable. */
export function estimateContextTokens(convId: string, brainDir: string = ANTIGRAVITY_BRAIN_DIR): number {
  try {
    const size = fs.statSync(fullTranscriptPathFor(convId, brainDir)).size;
    return Math.round(size / 4);
  } catch {
    return 0;
  }
}

interface TranscriptRow {
  source?: string;
  type?: string;
  status?: string;
  content?: string;
}

function parseRow(line: string): TranscriptRow | null {
  const t = line.trim();
  if (!t) return null;
  try {
    return JSON.parse(t) as TranscriptRow;
  } catch {
    return null;
  }
}

function isModelDone(row: TranscriptRow): boolean {
  return row.source === "MODEL" && row.type === "PLANNER_RESPONSE" && row.status === "DONE";
}

/** All completed assistant responses (content of MODEL/PLANNER_RESPONSE/DONE rows), in order. */
export function extractDoneResponses(transcript: string): string[] {
  const out: string[] = [];
  for (const line of transcript.split("\n")) {
    const row = parseRow(line);
    if (row && isModelDone(row) && typeof row.content === "string") {
      out.push(row.content);
    }
  }
  return out;
}

/** Map one transcript line to StreamDeltas for the parsed (Chat-view) stream. */
export function transcriptLineToDeltas(line: string): StreamDelta[] {
  const row = parseRow(line);
  if (!row) return [];
  if (isModelDone(row) && typeof row.content === "string" && row.content) {
    return [{ type: "text", content: row.content }];
  }
  return [];
}

/**
 * Pre-seed agy's workspace trust so a headless PTY spawn in `workspacePath`
 * doesn't block on the interactive "do you trust this folder?" prompt.
 * agy stores trust as realpath'd entries in settings.json → trustedWorkspaces.
 * Idempotent; tolerant of a missing or malformed existing file.
 */
export function ensureWorkspaceTrusted(workspacePath: string, settingsPath: string = ANTIGRAVITY_SETTINGS_PATH): void {
  let real = workspacePath;
  try {
    real = fs.realpathSync(workspacePath);
  } catch {
    /* dir may not exist yet — fall back to the given path */
  }

  let settings: Record<string, unknown> = {};
  try {
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    }
  } catch {
    logger.warn(`antigravity: settings.json at ${settingsPath} was unreadable/malformed — recreating`);
    settings = {};
  }

  const list = Array.isArray(settings.trustedWorkspaces)
    ? (settings.trustedWorkspaces as string[]).filter((w) => typeof w === "string")
    : [];
  if (!list.includes(real)) list.push(real);
  settings.trustedWorkspaces = list;

  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch (err) {
    logger.warn(`antigravity: failed to seed workspace trust: ${err instanceof Error ? err.message : err}`);
  }
}

/** Snapshot of existing conversation directory names under brain/ (for new-conv detection). */
export function listConvDirs(brainDir: string = ANTIGRAVITY_BRAIN_DIR): Set<string> {
  try {
    return new Set(
      fs.readdirSync(brainDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name),
    );
  } catch {
    return new Set();
  }
}
