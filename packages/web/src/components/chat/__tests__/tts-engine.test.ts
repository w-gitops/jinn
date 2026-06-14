/**
 * createTtsStart — gesture-time audio priming, Kokoro-vs-browser fallback
 * selection, and markdown stripping.
 */
import { describe, it, expect, vi } from "vitest"
import { createTtsStart, type TtsEngineDeps } from "../tts-engine"

function cbs() {
  return { onPlaying: vi.fn(), onEnd: vi.fn(), onError: vi.fn() }
}

function deps(over: Partial<TtsEngineDeps> = {}): TtsEngineDeps {
  return {
    checkAvailable: vi.fn().mockResolvedValue(true),
    fetchAudio: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
    playAudio: vi.fn().mockResolvedValue(() => {}),
    speak: vi.fn(() => () => {}),
    primeAudio: vi.fn(),
    ...over,
  } as TtsEngineDeps
}

describe("createTtsStart", () => {
  it("primes audio SYNCHRONOUSLY before any await (keeps the gesture window)", () => {
    const d = deps()
    const start = createTtsStart(d)
    void start("hello", cbs()) // intentionally NOT awaited
    // primeAudio must already have run in the synchronous (gesture) prefix.
    expect(d.primeAudio).toHaveBeenCalledTimes(1)
  })

  it("uses Kokoro (fetch + playAudio) when available, NOT the browser fallback", async () => {
    const d = deps()
    const start = createTtsStart(d)
    const c = cbs()
    await start("hello", c)
    expect(d.fetchAudio).toHaveBeenCalledTimes(1)
    expect(d.playAudio).toHaveBeenCalledTimes(1)
    expect(d.speak).not.toHaveBeenCalled()
  })

  it("strips markdown before sending text to synth", async () => {
    const d = deps()
    const start = createTtsStart(d)
    await start("**Bold** and `code` and [link](http://x)", cbs())
    expect(d.fetchAudio).toHaveBeenCalledWith("Bold and code and link")
  })

  it("falls back to Web Speech when Kokoro is unavailable — no failed POST", async () => {
    const d = deps({ checkAvailable: vi.fn().mockResolvedValue(false) })
    const start = createTtsStart(d)
    await start("hello", cbs())
    expect(d.fetchAudio).not.toHaveBeenCalled()
    expect(d.speak).toHaveBeenCalledTimes(1)
  })

  it("falls back to Web Speech when the synth request fails at call time", async () => {
    const d = deps({ fetchAudio: vi.fn().mockRejectedValue(new Error("503")) })
    const start = createTtsStart(d)
    await start("hello", cbs())
    expect(d.fetchAudio).toHaveBeenCalledTimes(1)
    expect(d.playAudio).not.toHaveBeenCalled()
    expect(d.speak).toHaveBeenCalledTimes(1)
  })

  it("falls back to Web Speech when WAV playback fails (e.g. autoplay blocked / decode error)", async () => {
    const d = deps({ playAudio: vi.fn().mockRejectedValue(new Error("NotAllowedError")) })
    const start = createTtsStart(d)
    await start("hello", cbs())
    expect(d.playAudio).toHaveBeenCalledTimes(1)
    expect(d.speak).toHaveBeenCalledTimes(1)
  })

  it("falls back to Web Speech when the availability probe throws", async () => {
    const d = deps({ checkAvailable: vi.fn().mockRejectedValue(new Error("net")) })
    const start = createTtsStart(d)
    await start("hello", cbs())
    expect(d.fetchAudio).not.toHaveBeenCalled()
    expect(d.speak).toHaveBeenCalledTimes(1)
  })

  it("ends cleanly (no fetch / no speak) when there's nothing speakable", async () => {
    const d = deps()
    const start = createTtsStart(d)
    const c = cbs()
    await start("   \n  ", c)
    expect(c.onEnd).toHaveBeenCalledTimes(1)
    expect(d.fetchAudio).not.toHaveBeenCalled()
    expect(d.speak).not.toHaveBeenCalled()
  })
})
