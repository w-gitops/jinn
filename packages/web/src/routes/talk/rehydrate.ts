/**
 * Jinn Talk — pure rehydration transforms (server snapshot → UI state).
 *
 * On mount/reload the reused orchestrator session is fetched and replayed so the
 * transcript and COO thread chips survive a full reload or mobile tab-discard.
 * These transforms are pure (no React/DOM) so they can be unit-tested; use-talk
 * wires them into its bootstrap effect with non-clobbering setState guards.
 */
import type { TalkThread } from "./thread-store"
import type { TranscriptEntry, SystemEntry } from "./types"
import { deriveLabel } from "./thread-store"
import { channelHue } from "./channel-identity"
import { stripMarkdown } from "@/lib/strip-markdown"

/**
 * Map a persisted session's messages to FINALIZED transcript entries.
 * User/assistant roles become TranscriptEntry objects (markdown-stripped).
 * Notification rows become SystemEntry objects so delegation history survives
 * a page reload — the ConversationStream component (Task 9) renders them;
 * empty bodies are dropped for user/assistant but never for notifications.
 */
export function messagesToEntries(
  session: Record<string, unknown> | undefined,
): Array<TranscriptEntry | SystemEntry> {
  if (!session) return []
  const history = (session.messages ?? session.history) as unknown
  if (!Array.isArray(history)) return []
  const out: Array<TranscriptEntry | SystemEntry> = []
  for (const raw of history) {
    const m = raw as Record<string, unknown>
    if (m.role === "notification") {
      const content = String(m.content ?? m.text ?? "")
      const id = typeof m.id === "string" && m.id ? m.id : `notification-${out.length}`
      out.push(_parseNotification(id, content))
      continue
    }
    const role = m.role === "user" ? "user" : m.role === "assistant" ? "assistant" : null
    if (!role) continue
    const text = stripMarkdown(String(m.content ?? m.text ?? "")).trim()
    if (!text) continue
    const id = typeof m.id === "string" && m.id ? m.id : `${role}-${out.length}`
    out.push({ id, role, text, partial: false, full: text })
  }
  return out
}

/**
 * Parse a notification content string into a SystemEntry.
 * Classifies by leading emoji: 📩/🔄 → "reported", ⚠️ → "error", other → "info".
 * Extracts the label from the first quoted segment, falling back to first 60 chars.
 */
function _parseNotification(id: string, content: string): SystemEntry {
  const emojiMatch = content.match(/^(📩|⚠️|🔄)/)
  const quotedMatch = content.match(/"([^"]+)"/)
  const label = quotedMatch ? quotedMatch[1] : content.slice(0, 60)
  let event: SystemEntry["event"] = "info"
  if (emojiMatch) {
    event = emojiMatch[1] === "⚠️" ? "error" : "reported"
  }
  return { id, kind: "system", event, label }
}

/**
 * Rebuild parked COO thread chips from the orchestrator's child sessions. Each
 * is idle + not orbiting (parked); a manual label override (if any) wins over
 * the server title. Dismissed-thread ids are filtered out so a chip the user
 * removed doesn't resurrect on reload/reconnect (dismiss hides the chip but
 * never kills the gateway child, so the child still comes back in this list).
 */
export function childrenToThreads(
  children: Array<Record<string, unknown>> | undefined,
  labelOverrides: Record<string, string> = {},
  dismissed: Iterable<string> = [],
): TalkThread[] {
  if (!Array.isArray(children)) return []
  const tombstones = new Set(dismissed)
  const out: TalkThread[] = []
  for (const raw of children) {
    const c = raw as Record<string, unknown>
    const id = c.id != null ? String(c.id) : ""
    if (!id || tombstones.has(id)) continue
    const title = typeof c.title === "string" ? c.title.trim() : ""
    const override = labelOverrides[id]
    const label = override ? deriveLabel(override) : deriveLabel(title || id)
    const tsRaw = c.lastActivity ?? c.createdAt
    const ts =
      typeof tsRaw === "string"
        ? Date.parse(tsRaw) || 0
        : typeof tsRaw === "number"
          ? tsRaw
          : 0
    out.push({
      id,
      label,
      hue: channelHue(title || id),
      state: "idle",
      orbiting: false,
      ts,
    })
  }
  return out
}
