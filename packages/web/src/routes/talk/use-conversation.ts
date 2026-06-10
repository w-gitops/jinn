/**
 * Jinn Talk — ConversationStream model (Task 9).
 *
 * A persistent, scrollable conversation replaces the old single-exchange
 * transcript + hidden history rail. This module is the pure reducer behind it
 * plus a thin `useConversation` hook of stable action creators.
 *
 * Row model:
 *   - user   — one spoken/typed line (optionally `pending` while STT finalizes).
 *   - aura   — ONE row per assistant turn that ACCUMULATES every sentence; the
 *              spoken sentence (`liveIdx`) is the karaoke head. `partial` is true
 *              while the turn streams/speaks, false once finalized.
 *   - system — a delegation chip (delegated / reported / attached / detached /
 *              error / info) that narrates what just happened. A new chip is
 *              inserted BEFORE the in-progress aura row so it reads in causal
 *              order ("…I'll delegate" → ⟶ delegated → child → narration).
 *
 * Sentence splitting reuses `splitSentences` (use-speak) verbatim so the stream
 * segments text exactly like the spoken pass — one source of truth.
 */
import { useCallback, useMemo, useReducer } from "react"
import { splitSentences } from "./use-speak"
import type { TranscriptEntry, SystemEntry } from "./types"

export type StreamRow =
  | { kind: "user"; id: string; text: string; pending?: boolean }
  | { kind: "aura"; id: string; sentences: string[]; liveIdx: number | null; partial: boolean }
  | {
      kind: "system"
      id: string
      event: "delegated" | "reported" | "attached" | "detached" | "error" | "info"
      threadId?: string
      label: string
      hue?: number
      ts: number
    }

export type SystemEvent = Extract<StreamRow, { kind: "system" }>["event"]

/** Hard cap on retained rows — the stream is bottom-anchored, old rows age out. */
export const MAX_ROWS = 200

export type ConversationAction =
  | { type: "user"; id: string; text: string; pending?: boolean }
  | { type: "finalizeUser"; id: string; text?: string }
  /** `text` is the FULL accumulated, markdown-stripped reply text for the turn. */
  | { type: "assistant"; id: string; text: string }
  | { type: "markSpoken"; id: string; idx: number }
  | { type: "finalizeAssistant"; id: string }
  | {
      type: "system"
      id: string
      event: SystemEvent
      label: string
      threadId?: string
      hue?: number
      ts?: number
    }
  | { type: "rehydrate"; entries: Array<TranscriptEntry | SystemEntry> }
  | { type: "reset" }

/** Keep at most MAX_ROWS, dropping the oldest (front of the list). */
function cap(rows: StreamRow[]): StreamRow[] {
  return rows.length > MAX_ROWS ? rows.slice(rows.length - MAX_ROWS) : rows
}

/** Map a rehydrated (finalized) entry to a stream row. */
function entryToRow(e: TranscriptEntry | SystemEntry): StreamRow {
  if ("kind" in e && e.kind === "system") {
    return { kind: "system", id: e.id, event: e.event, label: e.label, ts: 0 }
  }
  const te = e as TranscriptEntry
  if (te.role === "user") return { kind: "user", id: te.id, text: te.text }
  return {
    kind: "aura",
    id: te.id,
    sentences: splitSentences(te.full ?? te.text),
    liveIdx: null,
    partial: false,
  }
}

export function conversationReducer(
  rows: StreamRow[],
  action: ConversationAction,
): StreamRow[] {
  switch (action.type) {
    case "user":
      return cap([...rows, { kind: "user", id: action.id, text: action.text, ...(action.pending ? { pending: true } : {}) }])

    case "finalizeUser": {
      const i = rows.findIndex((r) => r.id === action.id && r.kind === "user")
      if (i === -1) return rows
      const next = rows.slice()
      const prev = next[i] as Extract<StreamRow, { kind: "user" }>
      next[i] = { kind: "user", id: prev.id, text: action.text ?? prev.text }
      return next
    }

    case "assistant": {
      const sentences = splitSentences(action.text)
      const i = rows.findIndex((r) => r.id === action.id && r.kind === "aura")
      if (i === -1) {
        return cap([...rows, { kind: "aura", id: action.id, sentences, liveIdx: null, partial: true }])
      }
      const next = rows.slice()
      const prev = next[i] as Extract<StreamRow, { kind: "aura" }>
      next[i] = { ...prev, sentences, partial: true }
      return next
    }

    case "markSpoken": {
      const i = rows.findIndex((r) => r.id === action.id && r.kind === "aura")
      if (i === -1) return rows
      const next = rows.slice()
      const prev = next[i] as Extract<StreamRow, { kind: "aura" }>
      if (prev.liveIdx === action.idx) return rows
      next[i] = { ...prev, liveIdx: action.idx }
      return next
    }

    case "finalizeAssistant": {
      const i = rows.findIndex((r) => r.id === action.id && r.kind === "aura")
      if (i === -1) return rows
      const next = rows.slice()
      const prev = next[i] as Extract<StreamRow, { kind: "aura" }>
      next[i] = { ...prev, partial: false, liveIdx: null }
      return next
    }

    case "system": {
      if (rows.some((r) => r.id === action.id)) return rows
      const chip: StreamRow = {
        kind: "system",
        id: action.id,
        event: action.event,
        label: action.label,
        ts: action.ts ?? Date.now(),
        ...(action.threadId ? { threadId: action.threadId } : {}),
        ...(action.hue != null ? { hue: action.hue } : {}),
      }
      // A chip narrates what just happened, so it belongs BEFORE the reply that
      // is still streaming. Insert ahead of the in-progress (partial) aura row;
      // otherwise append at the end.
      const partialIdx = rows.findIndex((r) => r.kind === "aura" && r.partial)
      if (partialIdx === -1) return cap([...rows, chip])
      const next = rows.slice()
      next.splice(partialIdx, 0, chip)
      return cap(next)
    }

    case "rehydrate":
      return cap(action.entries.map(entryToRow))

    case "reset":
      return []
  }
}

export interface UseConversationReturn {
  rows: StreamRow[]
  /** Add a user line (typed/STT). `pending` keeps it editable until finalized. */
  appendUser: (id: string, text: string, pending?: boolean) => void
  /** Finalize a pending user line (optionally replacing its text). */
  finalizeUser: (id: string, text?: string) => void
  /** Stream assistant text: pass the FULL accumulated, stripped reply text. */
  appendAssistant: (id: string, text: string) => void
  /** Advance the karaoke head to a spoken sentence index. */
  markSpoken: (id: string, idx: number) => void
  /** End the turn: stop highlighting, settle the row to history. */
  finalizeAssistant: (id: string) => void
  /** Insert a delegation chip (before the in-progress aura row if any). */
  addSystem: (chip: {
    id: string
    event: SystemEvent
    label: string
    threadId?: string
    hue?: number
    ts?: number
  }) => void
  /** Seed the stream from a server snapshot (replaces current rows). */
  rehydrate: (entries: Array<TranscriptEntry | SystemEntry>) => void
  /** Available for future use — engine switch currently preserves the conversation intentionally, matching the old entries behavior. */
  reset: () => void
}

export function useConversation(): UseConversationReturn {
  const [rows, dispatch] = useReducer(conversationReducer, [])

  const appendUser = useCallback(
    (id: string, text: string, pending?: boolean) => dispatch({ type: "user", id, text, pending }),
    [],
  )
  const finalizeUser = useCallback(
    (id: string, text?: string) => dispatch({ type: "finalizeUser", id, text }),
    [],
  )
  const appendAssistant = useCallback(
    (id: string, text: string) => dispatch({ type: "assistant", id, text }),
    [],
  )
  const markSpoken = useCallback(
    (id: string, idx: number) => dispatch({ type: "markSpoken", id, idx }),
    [],
  )
  const finalizeAssistant = useCallback(
    (id: string) => dispatch({ type: "finalizeAssistant", id }),
    [],
  )
  const addSystem = useCallback<UseConversationReturn["addSystem"]>(
    (chip) => dispatch({ type: "system", ...chip }),
    [],
  )
  const rehydrate = useCallback(
    (entries: Array<TranscriptEntry | SystemEntry>) => dispatch({ type: "rehydrate", entries }),
    [],
  )
  const reset = useCallback(() => dispatch({ type: "reset" }), [])

  return useMemo(
    () => ({
      rows,
      appendUser,
      finalizeUser,
      appendAssistant,
      markSpoken,
      finalizeAssistant,
      addSystem,
      rehydrate,
      reset,
    }),
    [rows, appendUser, finalizeUser, appendAssistant, markSpoken, finalizeAssistant, addSystem, rehydrate, reset],
  )
}
