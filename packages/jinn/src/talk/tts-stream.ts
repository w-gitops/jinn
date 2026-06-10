/**
 * Jinn Talk — server-side TTS streaming (Mission Control: per-sentence).
 *
 * As the orchestrator streams its reply, the run loop (api.ts) feeds each text
 * delta via feedTalkText(); complete sentences are synthesized IMMEDIATELY
 * (killing the old whole-turn dead air) on a per-session serial chain that
 * keeps talk:audio `seq` monotonic across the turn. flushTalkSpeech() speaks
 * the remainder with `final:true` (the only chunk allowed to carry last:true).
 * Calling feedTalkText without an emitter falls back to the legacy
 * buffer-everything behavior (everything speaks on flush).
 *
 * The Kokoro engine is a process-wide singleton shared with routes.ts (status /
 * download endpoints) so there is exactly one sidecar.
 */
import { createKokoroTts } from "./kokoro.js";
import type { Tts, Emit } from "./protocol.js";
import { logger } from "../shared/logger.js";

type KokoroOpts = Parameters<typeof createKokoroTts>[0];

let engine: Tts | null = null;

/** The shared Kokoro engine (lazily constructed with the live config). */
export function getTalkTts(opts?: KokoroOpts): Tts {
  if (!engine) engine = createKokoroTts(opts);
  return engine;
}

/** Test seam: swap the singleton for a mock. */
export function __setTalkTtsForTest(tts: Tts | null): void {
  engine = tts;
}

interface TurnState {
  buffer: string;
  seq: number;
  /** Serial synth chain — keeps chunk order while sentences stream in. */
  chain: Promise<void>;
  /** Bumped by discard; queued-but-unstarted sentences check it and drop. */
  epoch: number;
  /** A synth failure stops mid-turn streaming for the rest of the turn. */
  failed: boolean;
}

const turns = new Map<string, TurnState>();

function getTurn(sessionId: string): TurnState {
  let t = turns.get(sessionId);
  if (!t) {
    t = { buffer: "", seq: 0, chain: Promise.resolve(), epoch: 0, failed: false };
    turns.set(sessionId, t);
  }
  return t;
}

/**
 * Pull complete sentences off the front of `buffer` (terminator + whitespace),
 * returning them plus the incomplete remainder. "3.14" never splits (no
 * whitespace after the dot).
 */
export function extractSentences(buffer: string): { complete: string[]; rest: string } {
  const complete: string[] = [];
  let rest = buffer;
  for (;;) {
    const m = rest.match(/^([\s\S]*?[.!?…])(\s+)/);
    if (!m) break;
    const sentence = m[1].trim();
    if (sentence) complete.push(sentence);
    rest = rest.slice(m[0].length);
  }
  return { complete, rest };
}

function queueSentence(sessionId: string, t: TurnState, text: string, opts: KokoroOpts | undefined, emit: Emit, final: boolean): void {
  const epoch = t.epoch;
  t.chain = t.chain.then(async () => {
    if (t.epoch !== epoch || t.failed) return;
    try {
      const n = await getTalkTts(opts).speak(sessionId, text, emit, { seqStart: t.seq, final });
      t.seq += n;
    } catch (err) {
      t.failed = true;
      logger.warn(
        `[talk] TTS speak failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
}

/**
 * Append a streamed text delta. With an emitter, complete sentences are
 * synthesized immediately (per-sentence streaming); without one, text only
 * accumulates and flushTalkSpeech speaks it all (legacy single-call path).
 */
export function feedTalkText(sessionId: string, text: string, opts?: KokoroOpts, emit?: Emit): void {
  if (!text) return;
  const t = getTurn(sessionId);
  t.buffer += text;
  if (!emit || t.failed) return;
  const { complete, rest } = extractSentences(t.buffer);
  if (complete.length === 0) return;
  t.buffer = rest;
  for (const sentence of complete) queueSentence(sessionId, t, sentence, opts, emit, false);
}

/**
 * Speak whatever remains for this turn (final chunk carries last:true), then
 * clear the per-session state. Awaitable; safe to fire-and-forget.
 */
export async function flushTalkSpeech(
  sessionId: string,
  opts: KokoroOpts | undefined,
  emit: Emit,
): Promise<void> {
  const t = turns.get(sessionId);
  if (!t) return;
  const rest = t.buffer.trim();
  t.buffer = "";
  if (rest && !t.failed) queueSentence(sessionId, t, rest, opts, emit, true);
  const chain = t.chain;
  turns.delete(sessionId);
  await chain;
}

/** Drop any buffered/queued text for a session without speaking (interrupt). */
export function discardTalkSpeech(sessionId: string): void {
  const t = turns.get(sessionId);
  if (!t) return;
  t.epoch++;
  t.buffer = "";
  turns.delete(sessionId);
}
