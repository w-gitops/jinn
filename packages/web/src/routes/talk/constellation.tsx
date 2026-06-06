/**
 * Jinn Talk — orchestrator constellation.
 *
 * The big orb is the orchestrator. When it spawns COO child sessions, it lifts
 * up and shrinks, and each child appears as a satellite orb in a row below it,
 * with an animated link conveying knowledge flowing down (main → child) and
 * results returning (child → main). Children spread out as their count grows and
 * fade out shortly after they finish.
 */
import { useLayoutEffect, useRef, useState } from "react"
import { AuraAvatar } from "./aura-avatar"
import { channelIdentity } from "./channel-identity"
import type { AvatarState } from "./types"
import type { TalkChild } from "./use-talk"
import "./constellation.css"

/** A channel's stable key — its label when known, else its session id. */
const channelKey = (c: TalkChild) => c.label || c.id

interface ConstellationProps {
  state: AvatarState
  level: number | undefined
  children: TalkChild[]
}

interface Pt { x: number; y: number }

export function Constellation({ state, level, children }: ConstellationProps) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [dims, setDims] = useState<{ w: number; h: number }>({ w: 0, h: 0 })
  // Track which child ids have already mounted, so only NEW ones pop in.
  const mountedRef = useRef<Set<string>>(new Set())

  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el) return
    const measure = () => setDims({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const { w, h } = dims
  const ready = w > 0 && h > 0
  const hasKids = children.length > 0

  // The channel currently in focus = the most recently spawned child still
  // working (non-idle). The main orb morphs toward its hue; its satellite +
  // link are highlighted, the others recede. Null → pure AURA identity.
  const activeChild = [...children].reverse().find((c) => c.state !== "idle") ?? null
  const activeId = activeChild?.id ?? null
  const mainHue = activeChild ? channelIdentity(channelKey(activeChild)).hue : undefined

  // Orb sizing scales with the smaller viewport dimension (mobile-first).
  const base = Math.max(160, Math.min(Math.min(w, h || w) * 0.62, 340))
  const mainSize = hasKids ? base * 0.72 : base
  const childSize = Math.max(58, Math.min(base * 0.34, 116))

  const mainCenter: Pt = { x: w / 2, y: hasKids ? h * 0.36 : h * 0.5 }

  // Lay children out in a centered row below the orchestrator.
  const n = children.length
  const rowY = h * 0.7
  const gap = n > 0 ? Math.min((w * 0.84) / n, childSize * 1.75) : 0
  const childCenter = (i: number): Pt => ({
    x: w / 2 + (i - (n - 1) / 2) * gap,
    y: rowY,
  })

  // A gently curved link path from a→b (slight downward bow).
  const linkPath = (a: Pt, b: Pt) => {
    const mx = (a.x + b.x) / 2
    const my = (a.y + b.y) / 2 + 14
    return `M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`
  }

  return (
    <div ref={rootRef} className="cst-root">
      {ready && hasKids && (
        <svg className="cst-links" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
          {children.map((c, i) => {
            const from: Pt = { x: mainCenter.x, y: mainCenter.y + mainSize * 0.42 }
            const to: Pt = { x: childCenter(i).x, y: childCenter(i).y - childSize * 0.5 }
            const d = linkPath(from, to)
            const flowing = c.state !== "idle"
            const isFocused = c.id === activeId
            // The focused channel's tether wears that channel's hue (a shared-
            // colour link making "the main orb is talking to THIS one" legible).
            const stroke = isFocused ? `hsl(${channelIdentity(channelKey(c)).hue} 72% 58%)` : undefined
            const opacity = c.state === "idle" ? 0.3 : isFocused ? 1 : 0.5
            return (
              <g key={c.id} style={{ opacity, transition: "opacity 450ms ease" }}>
                <path className="cst-link-base" d={d} style={stroke ? { stroke } : undefined} />
                {flowing && <path className="cst-link-flow" d={d} style={stroke ? { stroke } : undefined} />}
                {flowing && <path className="cst-link-return" d={d} style={stroke ? { stroke } : undefined} />}
              </g>
            )
          })}
        </svg>
      )}

      {/* Orchestrator (main) orb — morphs toward the focused channel's hue. */}
      {ready && (
        <div
          className="cst-orb"
          style={{ left: mainCenter.x, top: mainCenter.y, zIndex: 2 }}
        >
          <AuraAvatar state={state} level={level} size={Math.round(mainSize)} channelHue={mainHue} />
        </div>
      )}

      {/* Satellite (COO child) orbs — each painted with its own channel hue. */}
      {ready && children.map((c, i) => {
        const center = childCenter(i)
        const isNew = !mountedRef.current.has(c.id)
        if (isNew) mountedRef.current.add(c.id)
        const isFocused = c.id === activeId
        const hue = channelIdentity(channelKey(c)).hue
        return (
          <div
            key={c.id}
            className={`cst-orb ${isNew ? "cst-orb-enter" : ""} ${c.state === "idle" ? "cst-orb-leaving" : ""}`}
            style={{
              left: center.x,
              top: center.y,
              zIndex: isFocused ? 4 : 3,
              ...(c.state === "idle" ? {} : { opacity: isFocused ? 1 : 0.55 }),
            }}
          >
            {/* Inner scaler: the focused satellite swells, the others recede —
                a transform-only highlight that never re-inits the orb canvas. */}
            <div className="cst-orb-scale" data-active={isFocused}>
              <AuraAvatar state={c.state === "idle" ? "idle" : "thinking"} size={Math.round(childSize)} channelHue={hue} />
            </div>
            {c.label && <span className="cst-orb-label">{c.label}</span>}
          </div>
        )
      })}
    </div>
  )
}
