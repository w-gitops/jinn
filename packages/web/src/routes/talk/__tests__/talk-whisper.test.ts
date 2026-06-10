/**
 * Jinn Talk — thinking-whisper mapping (Task 13).
 *
 * `whisperFor` maps an orchestrator tool_use delta to a short hint shown under
 * the orb while the turn is running. Pure (no React/DOM) so the mapping contract
 * is unit-tested here. The wiring (use-talk) feeds it the live session:delta
 * tool_use payload (toolName + content).
 */
import { describe, it, expect } from "vitest"
import { whisperFor } from "../talk-whisper"

describe("whisperFor", () => {
  it("maps a /api/talk/delegate call to 'routing…'", () => {
    expect(whisperFor({ content: "curl -X POST http://x/api/talk/delegate" })).toBe("routing…")
    expect(whisperFor({ toolName: "/api/talk/delegate" })).toBe("routing…")
  })

  it("maps a /api/talk/search call to 'searching…'", () => {
    expect(whisperFor({ content: "GET /api/talk/search?q=foo" })).toBe("searching…")
  })

  it("maps a /api/talk/card call to 'preparing a card…'", () => {
    expect(whisperFor({ content: "POST /api/talk/card" })).toBe("preparing a card…")
    // card sub-routes (update/dismiss/clear) still read as card prep.
    expect(whisperFor({ content: "POST /api/talk/card/update" })).toBe("preparing a card…")
  })

  it("maps a bare Bash/exec tool to 'working…'", () => {
    expect(whisperFor({ toolName: "Bash", content: "Bash" })).toBe("working…")
  })

  it("falls back to 'working…' for any unrecognized tool (default)", () => {
    expect(whisperFor({ toolName: "Read" })).toBe("working…")
    expect(whisperFor({})).toBe("working…")
    expect(whisperFor({ content: 42 })).toBe("working…")
  })

  it("matches the endpoint case-insensitively", () => {
    expect(whisperFor({ content: "/API/TALK/DELEGATE" })).toBe("routing…")
  })
})
