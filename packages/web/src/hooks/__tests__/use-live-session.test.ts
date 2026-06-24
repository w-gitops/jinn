/**
 * useLiveSession — read-only live pipeline (the Talk child-session modal path).
 *
 * Verifies the behaviours the modal relies on and that the old refetch-only hook
 * never had: live token streaming, live media, and a running-state spinner.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderHook, act } from "@testing-library/react"

// Mock the API module the hook loads sessions through.
const getSession = vi.fn()
vi.mock("@/lib/api", () => ({ api: { getSession: (id: string) => getSession(id) } }))

import { useLiveSession } from "../use-live-session"

type Listener = (event: string, payload: unknown) => void

/** A manual gateway subscribe that lets the test emit WS events. */
function makeBus() {
  let listener: Listener | null = null
  const subscribe = (fn: Listener) => {
    listener = fn
    return () => { listener = null }
  }
  const emit = (event: string, payload: unknown) => listener?.(event, payload)
  return { subscribe, emit }
}

beforeEach(() => {
  getSession.mockReset()
})

describe("useLiveSession (read-only)", () => {
  it("loads history and seeds loading from running state", async () => {
    getSession.mockResolvedValue({
      status: "running",
      messages: [{ id: "m1", role: "user", content: "hi" }],
    })
    const { subscribe } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )
    await act(async () => { await Promise.resolve() })
    expect(result.current.messages.map((m) => m.content)).toEqual(["hi"])
    expect(result.current.loading).toBe(true) // running → spinner
  })

  it("accumulates streaming text and clears it on completion", async () => {
    getSession.mockResolvedValue({ status: "running", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )
    await act(async () => { await Promise.resolve() })

    act(() => {
      emit("session:delta", { sessionId: "s1", type: "text", content: "Hel" })
      emit("session:delta", { sessionId: "s1", type: "text", content: "lo" })
    })
    expect(result.current.streamingText).toBe("Hello")
    expect(result.current.loading).toBe(true)

    await act(async () => {
      emit("session:completed", { sessionId: "s1", result: "Hello there." })
      await Promise.resolve()
    })
    expect(result.current.streamingText).toBe("")
    expect(result.current.loading).toBe(false)
    expect(result.current.messages.at(-1)?.content).toBe("Hello there.")
  })

  it("does not duplicate the answer when a late tool_use froze the streamed text (grok dedup)", async () => {
    // Reproduces the grok duplicate: answer text streams live, then a transcript
    // tool_use lands LATE and freezes that streamed text into a permanent assistant
    // bubble. Completion then delivers the identical canonical result — which must
    // be reconciled by identity, NOT appended a second time.
    getSession.mockResolvedValue({ status: "running", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )
    await act(async () => { await Promise.resolve() })

    act(() => {
      emit("session:delta", { sessionId: "s1", type: "text", content: "The answer is 42." })
      // Late transcript tool_use → flushes the streamed text into a permanent bubble.
      emit("session:delta", { sessionId: "s1", type: "tool_use", content: "Using read", toolName: "read" })
    })
    // After the flush: one frozen answer bubble + one tool card, nothing streaming.
    expect(result.current.streamingText).toBe("")
    expect(result.current.messages.filter((m) => m.content === "The answer is 42." && !m.toolCall)).toHaveLength(1)

    await act(async () => {
      emit("session:completed", { sessionId: "s1", result: "The answer is 42." })
      await Promise.resolve()
    })
    // Exactly ONE copy of the answer survives (no duplicate), plus the tool card.
    expect(result.current.messages.filter((m) => m.content === "The answer is 42." && !m.toolCall)).toHaveLength(1)
    expect(result.current.messages.filter((m) => m.toolCall === "read")).toHaveLength(1)
  })

  it("keeps visible progress around a tool call instead of collapsing to only the final answer", async () => {
    getSession.mockResolvedValue({ status: "running", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )
    await act(async () => { await Promise.resolve() })

    act(() => {
      emit("session:delta", { sessionId: "s1", type: "text", content: "PROGRESS-FIRST" })
      emit("session:delta", { sessionId: "s1", type: "tool_use", content: "Using Bash", toolName: "Bash" })
      emit("session:delta", { sessionId: "s1", type: "tool_result", content: "TOOL-CALL-OK", toolName: "Bash" })
      emit("session:delta", { sessionId: "s1", type: "text", content: "PROGRESS-FINAL" })
    })

    await act(async () => {
      emit("session:completed", { sessionId: "s1", result: "PROGRESS-FINAL" })
      await Promise.resolve()
    })

    expect(result.current.messages.map((m) => m.content)).toEqual([
      "PROGRESS-FIRST",
      "Used Bash",
      "PROGRESS-FINAL",
    ])
    expect(result.current.messages[1]?.toolCall).toBe("Bash")
  })

  it("shows transient status deltas and clears them when real output arrives", async () => {
    getSession.mockResolvedValue({ status: "running", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )
    await act(async () => { await Promise.resolve() })

    act(() => {
      emit("session:delta", { sessionId: "s1", type: "status", content: "checking" })
      emit("session:delta", { sessionId: "s1", type: "status", content: "files" })
    })
    expect(result.current.messages.map((m) => m.content)).toEqual(["Thinking: checking files"])

    act(() => {
      emit("session:delta", { sessionId: "s1", type: "status", content: "Plan: patch parser" })
    })
    expect(result.current.messages.map((m) => m.content)).toEqual(["Plan: patch parser"])
    expect(result.current.messages[0]?.role).toBe("notification")

    act(() => {
      emit("session:delta", { sessionId: "s1", type: "text", content: "Done" })
    })
    expect(result.current.messages).toEqual([])
    expect(result.current.streamingText).toBe("Done")

    await act(async () => {
      emit("session:completed", { sessionId: "s1", result: "Done." })
      await Promise.resolve()
    })
    expect(result.current.messages.map((m) => m.content)).toEqual(["Done."])
  })

  it("appends a live media attachment", async () => {
    getSession.mockResolvedValue({ status: "running", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )
    await act(async () => { await Promise.resolve() })

    act(() => {
      emit("session:attachment", {
        sessionId: "s1",
        id: "att1",
        content: "chart",
        media: [{ type: "image", url: "https://x/y.png" }],
      })
    })
    const last = result.current.messages.at(-1)
    expect(last?.media?.[0]?.url).toBe("https://x/y.png")
    // Idempotent on a duplicate event (same id).
    act(() => {
      emit("session:attachment", {
        sessionId: "s1",
        id: "att1",
        content: "chart",
        media: [{ type: "image", url: "https://x/y.png" }],
      })
    })
    expect(result.current.messages.filter((m) => m.id === "att1").length).toBe(1)
  })

  it("ignores events for a different session", async () => {
    getSession.mockResolvedValue({ status: "running", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )
    await act(async () => { await Promise.resolve() })
    act(() => {
      emit("session:delta", { sessionId: "OTHER", type: "text", content: "nope" })
    })
    expect(result.current.streamingText).toBe("")
  })

  it("surfaces a load error instead of hanging (modal anti-hang)", async () => {
    getSession.mockRejectedValue(new Error("boom"))
    const { subscribe } = makeBus()
    const { result } = renderHook(() =>
      useLiveSession("s1", { subscribe, readOnly: true }),
    )
    await act(async () => { await Promise.resolve() })
    expect(result.current.error).toBeInstanceOf(Error)
    expect(result.current.messages).toEqual([])
    expect(result.current.session).toBeNull()
  })
})

describe("useLiveSession (editable write path)", () => {
  it("seeds loading from a running session after reload or tab switch", async () => {
    getSession.mockResolvedValue({ status: "running", messages: [{ id: "m1", role: "user", content: "hi" }] })
    const { subscribe } = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe }))
    await act(async () => { await Promise.resolve() })
    expect(result.current.loading).toBe(true)
  })

  it("sets loading true when a queued turn starts", async () => {
    getSession.mockResolvedValue({ status: "idle", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe }))
    await act(async () => { await Promise.resolve() })
    expect(result.current.loading).toBe(false)

    act(() => {
      emit("session:started", { sessionId: "s1" })
    })
    expect(result.current.loading).toBe(true)
  })

  it("optimistic send → delta accumulation → completion replaces with result", async () => {
    getSession.mockResolvedValue({ status: "idle", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe }))
    await act(async () => { await Promise.resolve() })

    act(() => {
      result.current.beginSend({
        id: "u1",
        role: "user",
        content: "do it",
        timestamp: 1,
      })
    })
    expect(result.current.messages.at(-1)?.content).toBe("do it")
    expect(result.current.loading).toBe(true)

    act(() => {
      emit("session:delta", { sessionId: "s1", type: "text", content: "work" })
      emit("session:delta", { sessionId: "s1", type: "text", content: "ing" })
    })
    expect(result.current.streamingText).toBe("working")

    await act(async () => {
      emit("session:completed", { sessionId: "s1", result: "Done." })
      await Promise.resolve()
    })
    expect(result.current.loading).toBe(false)
    expect(result.current.streamingText).toBe("")
    expect(result.current.messages.map((m) => m.content)).toEqual(["do it", "Done."])
  })

  it("does not remove an older identical assistant answer when a later turn completes", async () => {
    getSession.mockResolvedValue({
      status: "idle",
      messages: [
        { id: "u-old", role: "user", content: "old question", timestamp: 1 },
        { id: "a-old", role: "assistant", content: "Done.", timestamp: 2 },
      ],
    })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe }))
    await act(async () => { await Promise.resolve() })

    act(() => {
      result.current.beginSend({
        id: "u-new",
        role: "user",
        content: "new question",
        timestamp: 3,
      })
    })

    await act(async () => {
      emit("session:completed", { sessionId: "s1", result: "Done." })
      await Promise.resolve()
    })

    expect(result.current.messages.map((m) => m.content)).toEqual([
      "old question",
      "Done.",
      "new question",
      "Done.",
    ])
  })

  it("seeds backgroundActivity from the session fetch and clears it on session switch", async () => {
    getSession.mockResolvedValue({
      status: "idle",
      messages: [],
      backgroundActivity: { activeStreams: 2, lastActivityAt: "2026-06-10T00:00:00Z" },
    })
    const { subscribe } = makeBus()
    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useLiveSession(id, { subscribe }),
      { initialProps: { id: "s1" as string | null } },
    )
    await act(async () => { await Promise.resolve() })
    expect(result.current.backgroundActivity).toEqual({
      activeStreams: 2,
      lastActivityAt: "2026-06-10T00:00:00Z",
    })

    // Switching away must not leak the previous session's indicator.
    getSession.mockResolvedValue({ status: "idle", messages: [] })
    rerender({ id: "s2" })
    await act(async () => { await Promise.resolve() })
    expect(result.current.backgroundActivity).toBeNull()
  })

  it("updates backgroundActivity on session:background and clears on null", async () => {
    getSession.mockResolvedValue({ status: "idle", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe }))
    await act(async () => { await Promise.resolve() })
    expect(result.current.backgroundActivity).toBeNull()

    act(() => {
      emit("session:background", {
        sessionId: "s1",
        backgroundActivity: { activeStreams: 3, lastActivityAt: "2026-06-10T01:00:00Z" },
      })
    })
    expect(result.current.backgroundActivity?.activeStreams).toBe(3)

    // The cleared case is an explicit event with backgroundActivity: null.
    act(() => {
      emit("session:background", { sessionId: "s1", backgroundActivity: null })
    })
    expect(result.current.backgroundActivity).toBeNull()
  })

  it("ignores session:background for a different session", async () => {
    getSession.mockResolvedValue({ status: "idle", messages: [] })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe }))
    await act(async () => { await Promise.resolve() })

    act(() => {
      emit("session:background", {
        sessionId: "OTHER",
        backgroundActivity: { activeStreams: 9, lastActivityAt: "2026-06-10T01:00:00Z" },
      })
    })
    expect(result.current.backgroundActivity).toBeNull()
  })

  it("reconciles messages from the server on session:external-turn", async () => {
    getSession.mockResolvedValue({
      status: "idle",
      messages: [{ id: "m1", role: "user", content: "hi" }],
    })
    const { subscribe, emit } = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe }))
    await act(async () => { await Promise.resolve() })
    expect(result.current.messages.map((m) => m.content)).toEqual(["hi"])

    // The gateway persisted a CLI-typed turn — the event must trigger a refetch.
    getSession.mockResolvedValue({
      status: "idle",
      messages: [
        { id: "m1", role: "user", content: "hi" },
        { id: "m2", role: "user", content: "typed in CLI" },
        { id: "m3", role: "assistant", content: "answered in CLI" },
      ],
    })
    await act(async () => {
      emit("session:external-turn", { sessionId: "s1" })
      await Promise.resolve()
    })
    expect(getSession).toHaveBeenCalledTimes(2)
    expect(result.current.messages.map((m) => m.content)).toEqual([
      "hi",
      "typed in CLI",
      "answered in CLI",
    ])
  })

  it("ignores session:external-turn for a different session", async () => {
    getSession.mockResolvedValue({ status: "idle", messages: [] })
    const { subscribe, emit } = makeBus()
    renderHook(() => useLiveSession("s1", { subscribe }))
    await act(async () => { await Promise.resolve() })
    expect(getSession).toHaveBeenCalledTimes(1)

    await act(async () => {
      emit("session:external-turn", { sessionId: "OTHER" })
      await Promise.resolve()
    })
    expect(getSession).toHaveBeenCalledTimes(1)
  })

  it("failSend clears loading and appends the error bubble", async () => {
    getSession.mockResolvedValue({ status: "idle", messages: [] })
    const { subscribe } = makeBus()
    const { result } = renderHook(() => useLiveSession("s1", { subscribe }))
    await act(async () => { await Promise.resolve() })

    act(() => {
      result.current.beginSend({ id: "u1", role: "user", content: "x", timestamp: 1 })
    })
    expect(result.current.loading).toBe(true)

    act(() => { result.current.failSend("Error: nope") })
    expect(result.current.loading).toBe(false)
    expect(result.current.messages.at(-1)?.content).toBe("Error: nope")
  })
})
