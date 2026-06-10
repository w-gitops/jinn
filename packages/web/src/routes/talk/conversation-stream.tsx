/**
 * Jinn Talk — ConversationStream (Task 9).
 *
 * The persistent conversation: every user line, every AURA reply (with a
 * karaoke highlight tracking the spoken sentence), and the delegation chips that
 * narrate what the orchestrator did. Replaces the old single-exchange transcript
 * AND the hidden history rail.
 *
 * Layout follows the same non-blocking pattern as the transcript/cards overlay:
 * the positioning wrapper is pointer-events:none (taps fall through to the orb),
 * and the interactive children (the scroll viewport, links, chips, the jump
 * pill) re-enable pointer-events on themselves. Auto-scrolls to the live edge
 * unless the user scrolls up, in which case a "jump to live" pill appears.
 *
 * Themed entirely from Ledger tokens (light + dark). Honors reduced motion.
 */
import { useEffect, useMemo, useRef, useState } from "react"
import type { CSSProperties, JSX } from "react"
import type { AvatarState } from "./types"
import type { StreamRow, SystemEvent } from "./use-conversation"
import { Linkified } from "./linkify"
import { EASING } from "./motion"
import "./conversation-stream.css"

export interface ConversationStreamProps {
  rows: StreamRow[]
  /** Avatar state — at "idle" the stream dims (only recent content matters). */
  state: AvatarState
  /** Open a child session's chat (clicking a chip that carries a threadId). */
  onOpenThread?: (sessionId: string) => void
  className?: string
}

const EASE_VARS: CSSProperties = {
  ["--ease-spring" as string]: EASING.spring,
  ["--ease-smooth" as string]: EASING.smooth,
}

/**
 * Reveal a sentence word-by-word with a blur-in (ported from the old
 * transcript). Keyed by the parent on a stable id so only newly-arrived words
 * mount/animate; already-revealed words stay settled.
 */
function WordReveal({ text }: { text: string }) {
  const words = useMemo(() => text.split(/\s+/).filter(Boolean), [text])
  return (
    <>
      {words.map((word, i) => (
        // The trailing space MUST be a sibling text node: the word span is
        // inline-block and browsers trim whitespace inside an inline-block box.
        // eslint-disable-next-line react/no-array-index-key
        <span key={i}>
          <span className="cstream__word">{word}</span>
          {i < words.length - 1 ? " " : ""}
        </span>
      ))}
    </>
  )
}

/** Phrasing + glyph for each delegation-chip event. */
function chipContent(event: SystemEvent, label: string): { glyph: string; text: string } {
  switch (event) {
    case "delegated":
      return { glyph: "⟶", text: `delegated → ${label}` }
    case "reported":
      return { glyph: "⟵", text: `${label} reported back` }
    case "attached":
      return { glyph: "⇄", text: `attached to ${label}` }
    case "detached":
      return { glyph: "⇄", text: `detached from ${label}` }
    case "error":
      return { glyph: "⚠", text: label }
    case "info":
    default:
      return { glyph: "·", text: label }
  }
}

function SystemChip({
  row,
  onOpenThread,
}: {
  row: Extract<StreamRow, { kind: "system" }>
  onOpenThread?: (sessionId: string) => void
}) {
  const { glyph, text } = chipContent(row.event, row.label)
  const clickable = !!(row.threadId && onOpenThread)
  const dotStyle = row.hue != null ? ({ ["--chip-hue" as string]: String(row.hue) } as CSSProperties) : undefined
  return (
    <div className={`cstream__row cstream__row--system cstream__row--${row.event}`}>
      <button
        type="button"
        className="cstream__chip"
        data-clickable={clickable ? "true" : undefined}
        disabled={!clickable}
        onClick={clickable ? () => onOpenThread!(row.threadId!) : undefined}
      >
        <span className="cstream__chip-dot" style={dotStyle} aria-hidden="true" />
        <span className="cstream__chip-glyph" aria-hidden="true">
          {glyph}
        </span>
        <span className="cstream__chip-text">{text}</span>
      </button>
    </div>
  )
}

function AuraRow({ row }: { row: Extract<StreamRow, { kind: "aura" }> }) {
  // Finalized rows read as plain history (full opacity). While partial, the
  // spoken sentence (liveIdx) is the karaoke head; earlier sentences are settled
  // and later (streamed-ahead) sentences are dimmed. liveIdx null while partial
  // → nothing spoken yet → treat all as streamed-ahead.
  const head = row.partial ? (row.liveIdx ?? -1) : Number.MAX_SAFE_INTEGER
  return (
    <div className="cstream__row cstream__row--aura">
      <span className="cstream__eyebrow cstream__eyebrow--aura">AURA</span>
      <p className="cstream__reply">
        {row.sentences.map((sentence, i) => {
          const cls =
            !row.partial || i < head
              ? "cstream__sentence cstream__sentence--spoken"
              : i === head
                ? "cstream__sentence cstream__sentence--live"
                : "cstream__sentence cstream__sentence--ahead"
          return (
            // eslint-disable-next-line react/no-array-index-key
            <span key={i} className={cls}>
              {i === head && row.partial ? <WordReveal text={sentence} /> : <Linkified text={sentence} />}
              {i < row.sentences.length - 1 ? " " : ""}
            </span>
          )
        })}
        {row.partial ? <span className="cstream__cursor" aria-hidden="true" /> : null}
      </p>
    </div>
  )
}

function UserRow({ row }: { row: Extract<StreamRow, { kind: "user" }> }) {
  return (
    <div className={`cstream__row cstream__row--user${row.pending ? " cstream__row--pending" : ""}`}>
      <span className="cstream__eyebrow cstream__eyebrow--user">you</span>
      <p className="cstream__caption">
        <Linkified text={row.text} />
      </p>
    </div>
  )
}

export function ConversationStream({
  rows,
  state,
  onOpenThread,
  className,
}: ConversationStreamProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const endRef = useRef<HTMLDivElement | null>(null)
  // Pinned to the live edge unless the user scrolls up. A scroll listener flips
  // `pinned`; while pinned, new rows keep the view glued to the bottom.
  const [pinned, setPinned] = useState(true)

  useEffect(() => {
    if (pinned) endRef.current?.scrollIntoView({ block: "end" })
  }, [rows, pinned])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    setPinned(dist < 48)
  }

  const jumpToLive = () => {
    setPinned(true)
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" })
  }

  return (
    <div
      className={`cstream${className ? ` ${className}` : ""}`}
      data-state={state}
      style={EASE_VARS}
    >
      <div
        ref={scrollRef}
        className="cstream__scroll"
        onScroll={onScroll}
        role="log"
        aria-label="Conversation"
        aria-live="polite"
      >
        {rows.map((row) =>
          row.kind === "user" ? (
            <UserRow key={row.id} row={row} />
          ) : row.kind === "aura" ? (
            <AuraRow key={row.id} row={row} />
          ) : (
            <SystemChip key={row.id} row={row} onOpenThread={onOpenThread} />
          ),
        )}
        <div ref={endRef} />
      </div>

      {!pinned && (
        <button type="button" className="cstream__jump" onClick={jumpToLive}>
          Jump to live ↓
        </button>
      )}
    </div>
  )
}
