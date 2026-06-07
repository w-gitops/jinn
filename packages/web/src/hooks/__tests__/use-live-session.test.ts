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
})
