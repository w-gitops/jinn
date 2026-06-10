/**
 * Jinn Talk — thinking-whisper mapping (Task 13).
 *
 * While the orchestrator turn runs, its tool_use deltas are surfaced as a short,
 * muted hint under the orb ("routing…", "searching…", "preparing a card…",
 * otherwise "working…"). This is the pure mapping; the wiring lives in use-talk.
 *
 * The live session:delta for a tool_use carries the tool NAME (e.g. "Bash") in
 * both `toolName` and `content` — the command/input (the talk endpoint URL) is
 * not surfaced on the wire. So in practice a curl-driven delegate reads as the
 * generic "working…"; the endpoint-specific whispers fire when a tool name or
 * payload string does contain the path (future-proof + honest about the data).
 */
export interface WhisperDeltaLike {
  toolName?: string
  content?: string | number
}

/** Map a tool_use delta to its short under-orb whisper. */
export function whisperFor(delta: WhisperDeltaLike): string {
  const name = typeof delta.toolName === "string" ? delta.toolName : ""
  const content = typeof delta.content === "string" ? delta.content : ""
  const hay = `${name} ${content}`.toLowerCase()
  if (hay.includes("/api/talk/delegate")) return "routing…"
  if (hay.includes("/api/talk/search")) return "searching…"
  if (hay.includes("/api/talk/card")) return "preparing a card…"
  // A bare shell/exec tool (or anything else) → generic progress.
  return "working…"
}
