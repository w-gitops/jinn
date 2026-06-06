/**
 * Jinn Talk — thread store tests (pure reducer + label deriver).
 */
import { describe, it, expect } from "vitest"
import { threadReducer, deriveLabel, MAX_THREADS, type TalkThread } from "../thread-store"
import { channelHue } from "../channel-identity"

/** Shorthand: apply a focus action. */
const f = (threads: TalkThread[], id: string, label: string, ts = 1) =>
  threadReducer(threads, { type: "focus", id, label, ts })

describe("deriveLabel", () => {
  it("collapses whitespace and trims", () => {
    expect(deriveLabel("  pravko   blog  ")).toBe("pravko blog")
  })
  it("falls back for empty input", () => {
    expect(deriveLabel("")).toBe("Thread")
    expect(deriveLabel("   ")).toBe("Thread")
  })
  it("caps long labels with an ellipsis", () => {
    const out = deriveLabel("research the entire bulgarian tax code end to end")
    expect(out.length).toBeLessThanOrEqual(32)
    expect(out.endsWith("…")).toBe(true)
  })
})

describe("threadReducer", () => {
  it("creates a thread on first focus with a stable hue + thinking/orbiting", () => {
    const ts = f([], "coo1", "pravko-lead", 10)
    expect(ts).toHaveLength(1)
    expect(ts[0]).toMatchObject({
      id: "coo1",
      label: "pravko-lead",
      hue: channelHue("pravko-lead"),
      state: "thinking",
      orbiting: true,
      ts: 10,
    })
  })

  it("re-focusing the same id reactivates without changing hue/label", () => {
    let ts = f([], "coo1", "pravko-lead", 10)
    ts = threadReducer(ts, { type: "done", id: "coo1", ts: 20 })
    ts = threadReducer(ts, { type: "park", id: "coo1" })
    expect(ts[0]).toMatchObject({ state: "idle", orbiting: false })
    ts = threadReducer(ts, { type: "focus", id: "coo1", label: "ignored-on-existing", ts: 30 })
    expect(ts).toHaveLength(1)
    expect(ts[0]).toMatchObject({ state: "thinking", orbiting: true, ts: 30, label: "pravko-lead" })
  })

  it("done marks idle but keeps the thread; park stops orbiting", () => {
    let ts = f([], "coo1", "homy-lead", 1)
    ts = threadReducer(ts, { type: "done", id: "coo1", ts: 2 })
    expect(ts[0].state).toBe("idle")
    expect(ts[0].orbiting).toBe(true)
    ts = threadReducer(ts, { type: "park", id: "coo1" })
    expect(ts[0].orbiting).toBe(false)
    expect(ts).toHaveLength(1)
  })

  it("label renames without touching hue", () => {
    let ts = f([], "coo1", "pravko-lead", 1)
    const hue = ts[0].hue
    ts = threadReducer(ts, { type: "label", id: "coo1", label: "Tax research" })
    expect(ts[0].label).toBe("Tax research")
    expect(ts[0].hue).toBe(hue)
  })

  it("dismiss removes the thread", () => {
    let ts = f([], "coo1", "a", 1)
    ts = threadReducer(ts, { type: "dismiss", id: "coo1" })
    expect(ts).toHaveLength(0)
  })

  it("completing many threads then focusing new ones never drops finished ones", () => {
    // Real talk sessions create well under the runaway cap. Finishing (done) and
    // parking a thread must NEVER remove it — only dismiss does.
    const N = 20
    let ts: TalkThread[] = []
    for (let i = 0; i < N; i++) {
      ts = f(ts, `coo${i}`, `t${i}`, i)
      ts = threadReducer(ts, { type: "done", id: `coo${i}`, ts: i })
      ts = threadReducer(ts, { type: "park", id: `coo${i}` })
    }
    // Focus a few brand-new threads on top.
    ts = f(ts, "new1", "fresh1", 1000)
    ts = f(ts, "new2", "fresh2", 1001)
    expect(ts.length).toBe(N + 2)
    // Every finished+parked thread is still present.
    for (let i = 0; i < N; i++) {
      const t = ts.find((x) => x.id === `coo${i}`)
      expect(t).toBeDefined()
      expect(t!.state).toBe("idle")
      expect(t!.orbiting).toBe(false)
    }
  })

  it("a done+parked thread still exists in the list", () => {
    let ts = f([], "coo1", "homy-lead", 1)
    ts = threadReducer(ts, { type: "done", id: "coo1", ts: 2 })
    ts = threadReducer(ts, { type: "park", id: "coo1" })
    expect(ts).toHaveLength(1)
    expect(ts[0]).toMatchObject({ id: "coo1", state: "idle", orbiting: false })
  })

  it("only dismiss removes a thread — done and park never do", () => {
    let ts = f([], "coo1", "a", 1)
    ts = threadReducer(ts, { type: "done", id: "coo1", ts: 2 })
    expect(ts).toHaveLength(1)
    ts = threadReducer(ts, { type: "park", id: "coo1" })
    expect(ts).toHaveLength(1)
    ts = threadReducer(ts, { type: "dismiss", id: "coo1" })
    expect(ts).toHaveLength(0)
  })

  it("runaway guard still bounds the list at the large cap", () => {
    let ts: TalkThread[] = []
    // Create far more than the cap, all parked (the age-out victims).
    for (let i = 0; i < MAX_THREADS + 5; i++) {
      ts = f(ts, `coo${i}`, `t${i}`, i)
      ts = threadReducer(ts, { type: "done", id: `coo${i}`, ts: i })
      if (i < MAX_THREADS + 4) ts = threadReducer(ts, { type: "park", id: `coo${i}` })
    }
    expect(ts).toHaveLength(MAX_THREADS)
    // The oldest parked one (coo0) was aged out by the runaway guard.
    expect(ts.find((t) => t.id === "coo0")).toBeUndefined()
  })

  it("ignores actions for unknown ids", () => {
    const ts = f([], "coo1", "a", 1)
    expect(threadReducer(ts, { type: "done", id: "nope", ts: 2 })).toBe(ts)
    expect(threadReducer(ts, { type: "label", id: "nope", label: "x" })).toBe(ts)
  })
})
