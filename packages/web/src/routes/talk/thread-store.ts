/**
 * Jinn Talk — COO thread store (pure, testable).
 *
 * The orchestrator can run several COO sessions ("threads") and switch between
 * them. This module is the persistent model behind the satellite orbs and the
 * thread panel: a reducer over a list of threads plus a label deriver. It is
 * pure (no React, no DOM) so the transitions can be unit-tested.
 *
 * A thread is created on the first `talk:focus` for a COO child and then KEPT
 * (unlike the old transient satellites that were deleted ~4.5s after finishing).
 * It only leaves on explicit dismiss or when capped out. `orbiting` controls
 * whether it currently shows as a satellite orb; the panel lists all threads.
 * Each thread's `hue` is the stable channel-identity hue so its colour matches
 * the satellite and the main-orb morph.
 */
import { channelHue } from "./channel-identity"
import type { AvatarState } from "./types"

export interface TalkThread {
  /** COO session id. */
  id: string
  /** Human topic label (derived from the dispatch, renamable, persona-settable). */
  label: string
  /** Stable channel hue (0..360) — matches the satellite + orb morph. */
  hue: number
  /** "thinking" while the COO runs, "idle" once it has reported. */
  state: AvatarState
  /** Whether it currently shows as a satellite orb (false once parked). */
  orbiting: boolean
  /** Last-activity timestamp (ms) for ordering + age-out. */
  ts: number
}

/**
 * Runaway guard only. Real talk sessions never approach this — completing a COO
 * child must NEVER age a thread out, so the cap sits far above realistic usage
 * and only bounds a truly pathological list. The normal removal path is the
 * explicit `dismiss` action.
 */
export const MAX_THREADS = 50

/** Clean a raw dispatch string into a compact topic label. */
export function deriveLabel(raw: string): string {
  const s = (raw || "").replace(/\s+/g, " ").trim().replace(/^[>*\-\s]+/, "")
  if (!s) return "Thread"
  return s.length > 32 ? s.slice(0, 31).trimEnd() + "…" : s
}

export type ThreadAction =
  | { type: "focus"; id: string; label: string; ts: number }
  | { type: "activity"; id: string; ts: number }
  | { type: "done"; id: string; ts: number }
  | { type: "park"; id: string }
  | { type: "label"; id: string; label: string }
  | { type: "dismiss"; id: string }

export function threadReducer(threads: TalkThread[], action: ThreadAction): TalkThread[] {
  const idx = "id" in action ? threads.findIndex((t) => t.id === action.id) : -1

  switch (action.type) {
    case "focus": {
      if (idx === -1) {
        const next = [
          ...threads,
          {
            id: action.id,
            label: deriveLabel(action.label),
            hue: channelHue(action.label || action.id),
            state: "thinking" as AvatarState,
            orbiting: true,
            ts: action.ts,
          },
        ]
        return cap(next)
      }
      const next = threads.slice()
      next[idx] = { ...next[idx], state: "thinking", orbiting: true, ts: action.ts }
      return next
    }
    case "activity": {
      if (idx === -1) return threads
      const next = threads.slice()
      next[idx] = { ...next[idx], state: "thinking", orbiting: true, ts: action.ts }
      return next
    }
    case "done": {
      if (idx === -1) return threads
      const next = threads.slice()
      next[idx] = { ...next[idx], state: "idle", ts: action.ts }
      return next
    }
    case "park": {
      if (idx === -1) return threads
      const next = threads.slice()
      next[idx] = { ...next[idx], orbiting: false }
      return next
    }
    case "label": {
      if (idx === -1) return threads
      const label = deriveLabel(action.label)
      const next = threads.slice()
      next[idx] = { ...next[idx], label }
      return next
    }
    case "dismiss":
      return threads.filter((t) => t.id !== action.id)
  }
}

/**
 * Runaway guard: keep at most MAX_THREADS, aging out the oldest parked (else
 * oldest) thread. This only fires in pathological cases — normal completion
 * (done + park) keeps every thread; the user removes one via `dismiss`.
 */
function cap(threads: TalkThread[]): TalkThread[] {
  if (threads.length <= MAX_THREADS) return threads
  const byAge = [...threads].sort((a, b) => a.ts - b.ts)
  const victim = byAge.find((t) => !t.orbiting) ?? byAge[0]
  return threads.filter((t) => t.id !== victim.id)
}
