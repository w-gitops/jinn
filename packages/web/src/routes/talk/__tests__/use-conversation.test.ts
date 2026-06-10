/**
 * Jinn Talk — ConversationStream reducer (Task 9).
 *
 * The reducer is the persistent conversation model: user lines, a per-turn AURA
 * row that accumulates every sentence (karaoke), and system delegation chips.
 * Pure (no React/DOM) so every contract bullet is unit-tested here.
 */
import { describe, it, expect } from "vitest"
import { conversationReducer, MAX_ROWS, type StreamRow } from "../use-conversation"
import type { TranscriptEntry, SystemEntry } from "../types"

function auraRow(rows: StreamRow[], id: string) {
  const r = rows.find((x) => x.id === id)
  if (r && r.kind === "aura") return r
  throw new Error(`no aura row ${id}`)
}

describe("conversationReducer — user rows", () => {
  it("appends a user row", () => {
    const rows = conversationReducer([], { type: "user", id: "u1", text: "hello" })
    expect(rows).toEqual([{ kind: "user", id: "u1", text: "hello" }])
  })

  it("appends a pending user row then finalizes/replaces it", () => {
    let rows = conversationReducer([], { type: "user", id: "u1", text: "hel", pending: true })
    expect(rows[0]).toEqual({ kind: "user", id: "u1", text: "hel", pending: true })
    rows = conversationReducer(rows, { type: "finalizeUser", id: "u1", text: "hello there" })
    expect(rows).toEqual([{ kind: "user", id: "u1", text: "hello there" }])
  })

  it("finalizeUser keeps existing text when no override is given", () => {
    let rows = conversationReducer([], { type: "user", id: "u1", text: "draft", pending: true })
    rows = conversationReducer(rows, { type: "finalizeUser", id: "u1" })
    expect(rows).toEqual([{ kind: "user", id: "u1", text: "draft" }])
  })
})

describe("conversationReducer — assistant streaming", () => {
  it("accumulates ALL sentences into ONE aura row per turn (partial)", () => {
    let rows = conversationReducer([], { type: "assistant", id: "a1", text: "First sentence." })
    rows = conversationReducer(rows, {
      type: "assistant",
      id: "a1",
      text: "First sentence. Second one!",
    })
    expect(rows).toHaveLength(1)
    expect(auraRow(rows, "a1")).toEqual({
      kind: "aura",
      id: "a1",
      sentences: ["First sentence.", "Second one!"],
      liveIdx: null,
      partial: true,
    })
  })

  it("markSpoken moves liveIdx on the aura row", () => {
    let rows = conversationReducer([], {
      type: "assistant",
      id: "a1",
      text: "One. Two. Three.",
    })
    rows = conversationReducer(rows, { type: "markSpoken", id: "a1", idx: 1 })
    expect(auraRow(rows, "a1").liveIdx).toBe(1)
  })

  it("finalizeAssistant clears partial + liveIdx", () => {
    let rows = conversationReducer([], { type: "assistant", id: "a1", text: "Done now." })
    rows = conversationReducer(rows, { type: "markSpoken", id: "a1", idx: 0 })
    rows = conversationReducer(rows, { type: "finalizeAssistant", id: "a1" })
    expect(auraRow(rows, "a1")).toMatchObject({ partial: false, liveIdx: null })
  })

  it("markSpoken/finalize on an unknown id is a no-op", () => {
    const rows = conversationReducer([], { type: "markSpoken", id: "ghost", idx: 2 })
    expect(rows).toEqual([])
  })
})

describe("conversationReducer — system chips", () => {
  it("appends a system chip when no aura row is in progress", () => {
    const rows = conversationReducer([{ kind: "user", id: "u1", text: "hi" }], {
      type: "system",
      id: "s1",
      event: "delegated",
      label: "content-lead",
      threadId: "c1",
      hue: 120,
      ts: 5,
    })
    expect(rows[1]).toEqual({
      kind: "system",
      id: "s1",
      event: "delegated",
      label: "content-lead",
      threadId: "c1",
      hue: 120,
      ts: 5,
    })
  })

  it("inserts the chip BEFORE the in-progress (partial) aura row", () => {
    let rows: StreamRow[] = [{ kind: "user", id: "u1", text: "hi" }]
    rows = conversationReducer(rows, { type: "assistant", id: "a1", text: "I'll delegate this." })
    rows = conversationReducer(rows, {
      type: "system",
      id: "s1",
      event: "delegated",
      label: "content-lead",
      ts: 9,
    })
    // order: user, system chip, partial aura
    expect(rows.map((r) => r.kind)).toEqual(["user", "system", "aura"])
    expect(rows[1].id).toBe("s1")
    expect(rows[2].id).toBe("a1")
  })

  it("deduplicates chips with the same id (second dispatch is a no-op)", () => {
    const chip = { type: "system" as const, id: "s1", event: "delegated" as const, label: "content-lead", ts: 1 }
    let rows = conversationReducer([], chip)
    rows = conversationReducer(rows, chip)
    expect(rows.filter((r) => r.id === "s1")).toHaveLength(1)
  })

  it("appends the chip after a FINALIZED aura row (not in progress)", () => {
    let rows = conversationReducer([], { type: "assistant", id: "a1", text: "Done." })
    rows = conversationReducer(rows, { type: "finalizeAssistant", id: "a1" })
    rows = conversationReducer(rows, {
      type: "system",
      id: "s1",
      event: "reported",
      label: "content-lead",
      ts: 9,
    })
    expect(rows.map((r) => r.kind)).toEqual(["aura", "system"])
  })
})

describe("conversationReducer — cap", () => {
  it("caps total rows at MAX_ROWS, dropping the oldest", () => {
    let rows: StreamRow[] = []
    for (let i = 0; i < MAX_ROWS + 25; i++) {
      rows = conversationReducer(rows, { type: "user", id: `u${i}`, text: `m${i}` })
    }
    expect(rows).toHaveLength(MAX_ROWS)
    expect(rows[0].id).toBe("u25") // oldest 25 dropped
    expect(rows[rows.length - 1].id).toBe(`u${MAX_ROWS + 24}`)
  })
})

describe("conversationReducer — rehydrate", () => {
  it("seeds the stream from mapped transcript + system entries", () => {
    const entries: Array<TranscriptEntry | SystemEntry> = [
      { id: "u1", role: "user", text: "hello", partial: false, full: "hello" },
      { id: "n1", kind: "system", event: "reported", label: "Pravko blog" },
      {
        id: "a1",
        role: "assistant",
        text: "Hi there.",
        partial: false,
        full: "Hi there. All set.",
      },
    ]
    const rows = conversationReducer([], { type: "rehydrate", entries })
    expect(rows[0]).toEqual({ kind: "user", id: "u1", text: "hello" })
    expect(rows[1]).toMatchObject({ kind: "system", id: "n1", event: "reported", label: "Pravko blog" })
    // assistant seeded from `full`, re-split into sentences, finalized
    expect(rows[2]).toEqual({
      kind: "aura",
      id: "a1",
      sentences: ["Hi there.", "All set."],
      liveIdx: null,
      partial: false,
    })
  })

  it("rehydrate replaces existing rows (seed) and respects the cap", () => {
    const big: Array<TranscriptEntry | SystemEntry> = []
    for (let i = 0; i < MAX_ROWS + 10; i++) {
      big.push({ id: `u${i}`, role: "user", text: `m${i}`, partial: false })
    }
    const rows = conversationReducer([{ kind: "user", id: "old", text: "x" }], {
      type: "rehydrate",
      entries: big,
    })
    expect(rows).toHaveLength(MAX_ROWS)
    expect(rows.some((r) => r.id === "old")).toBe(false)
  })
})

describe("conversationReducer — reset", () => {
  it("clears the stream", () => {
    const rows = conversationReducer([{ kind: "user", id: "u1", text: "hi" }], { type: "reset" })
    expect(rows).toEqual([])
  })
})
