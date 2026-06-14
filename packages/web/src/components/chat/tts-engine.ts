/**
 * Read-aloud playback engine — the real `TtsStart` for the chat TTS controller.
 *
 * Strategy per message:
 *   1. Prime audio SYNCHRONOUSLY (resume the shared AudioContext) — this runs in
 *      the click gesture's call stack, which is what lets the browser's autoplay
 *      policy permit playback after the (async) fetch resolves. Skipping this is
 *      the classic "click play → stuck loading, no sound" bug: play() invoked
 *      after `await fetch()` is outside the gesture window → NotAllowedError.
 *   2. Strip markdown so we speak clean prose, not asterisks/backticks.
 *   3. Prefer our custom server TTS (Kokoro) via POST /api/tts → decode the WAV in
 *      the (gesture-unlocked) AudioContext and play it. Availability is probed once
 *      (GET /api/tts, cached) so we pick the browser fallback WITHOUT a failed POST.
 *   4. Fall back to the browser Web Speech API (speechSynthesis) when Kokoro is
 *      unavailable OR the synth request / WAV playback fails.
 *
 * All browser touchpoints (fetch / AudioContext / speechSynthesis) are injected so
 * the selection + gesture logic is unit-testable without a DOM or network.
 */
import { stripMarkdown } from "@/lib/strip-markdown"
import type { TtsStart, TtsStartCallbacks } from "./tts-controller"

export interface TtsEngineDeps {
  /** Probe whether the custom (Kokoro) TTS is available. Cached by the caller. */
  checkAvailable: () => Promise<boolean>
  /** POST the text to the custom TTS; resolve with the WAV bytes, reject on failure. */
  fetchAudio: (text: string) => Promise<ArrayBuffer>
  /** Decode + play synthesized WAV bytes; resolve with stop(), reject if it can't play. */
  playAudio: (audio: ArrayBuffer, cbs: TtsStartCallbacks) => Promise<() => void>
  /** Browser Web Speech fallback; returns a stop() handle. */
  speak: (text: string, cbs: TtsStartCallbacks) => () => void
  /** Synchronous gesture-time unlock (resume the shared AudioContext). */
  primeAudio?: () => void
}

const NOOP = () => {}

/** Build a `TtsStart` from injected playback dependencies. */
export function createTtsStart(deps: TtsEngineDeps): TtsStart {
  return async (raw, cbs) => {
    // MUST be the first thing we do — runs in the click gesture's synchronous
    // stack so the browser unlocks audio for the post-fetch play() below.
    deps.primeAudio?.()

    const text = stripMarkdown(raw).trim()
    if (!text) {
      // Nothing speakable (e.g. a media-only / code-only message) — end cleanly.
      cbs.onEnd()
      return NOOP
    }

    let available = false
    try {
      available = await deps.checkAvailable()
    } catch {
      available = false
    }

    if (available) {
      try {
        const audio = await deps.fetchAudio(text)
        return await deps.playAudio(audio, cbs)
      } catch {
        // Kokoro was advertised available but the request OR playback failed —
        // degrade to the browser Web Speech voice.
      }
    }

    return deps.speak(text, cbs)
  }
}

/* ── Default browser-backed dependencies ─────────────────────────────────── */

let availabilityPromise: Promise<boolean> | null = null

/** GET /api/tts once and cache the answer for the page lifetime. */
function checkAvailable(): Promise<boolean> {
  if (!availabilityPromise) {
    availabilityPromise = fetch("/api/tts")
      .then((r) => (r.ok ? (r.json() as Promise<{ available?: boolean }>) : { available: false }))
      .then((d) => !!d.available)
      .catch(() => false)
  }
  return availabilityPromise
}

async function fetchAudio(text: string): Promise<ArrayBuffer> {
  const r = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  })
  if (!r.ok) throw new Error(`tts ${r.status}`)
  return r.arrayBuffer()
}

/* A single shared AudioContext so priming on one message unlocks playback for all. */
type AudioCtor = typeof AudioContext
let sharedCtx: AudioContext | null = null

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null
  const Ctor: AudioCtor | undefined =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext
  if (!Ctor) return null
  if (!sharedCtx) sharedCtx = new Ctor()
  return sharedCtx
}

/** Resume the AudioContext from within the user gesture (autoplay unlock). */
function primeAudio(): void {
  const ctx = getAudioContext()
  if (ctx && ctx.state === "suspended") void ctx.resume()
}

async function playAudio(
  audio: ArrayBuffer,
  { onPlaying, onEnd }: TtsStartCallbacks,
): Promise<() => void> {
  const ctx = getAudioContext()
  if (!ctx) throw new Error("AudioContext unavailable") // → caller falls back to Web Speech
  if (ctx.state === "suspended") {
    try {
      await ctx.resume()
    } catch {
      /* primed in-gesture already; best effort */
    }
  }
  // decodeAudioData detaches the input buffer — decode a copy so a retry/fallback
  // still has the original bytes.
  const buffer = await ctx.decodeAudioData(audio.slice(0))
  const source = ctx.createBufferSource()
  source.buffer = buffer
  source.connect(ctx.destination)
  let done = false
  source.onended = () => {
    if (!done) {
      done = true
      onEnd()
    }
  }
  source.start(0)
  onPlaying() // playback has begun (loading → playing)
  return () => {
    done = true
    try {
      source.stop()
    } catch {
      /* already stopped */
    }
    source.disconnect()
  }
}

function speak(text: string, { onPlaying, onEnd, onError }: TtsStartCallbacks): () => void {
  const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined
  if (!synth || typeof SpeechSynthesisUtterance === "undefined") {
    onError()
    return NOOP
  }
  const utt = new SpeechSynthesisUtterance(text)
  utt.onstart = () => onPlaying()
  utt.onend = () => onEnd()
  utt.onerror = () => onError()
  synth.cancel() // clear any queued/leftover speech first
  synth.speak(utt)
  return () => {
    // cancel() may fire a late onend/onerror — the controller's generation guard
    // ignores those, so stop() is safe to call here.
    synth.cancel()
  }
}

/** Production dependencies (browser fetch + AudioContext + Web Speech). */
export function defaultTtsDeps(): TtsEngineDeps {
  return { checkAvailable, fetchAudio, playAudio, speak, primeAudio }
}
