/**
 * Jinn Talk — COO thread panel.
 *
 * A compact, collapsible list of the orchestrator's COO threads as colour-coded
 * chips (hue matches the satellite orb + the main-orb morph). Lets the operator SEE
 * the threads, switch the routing target (so the next dispatch continues that
 * COO session), rename a topic inline, and dismiss a finished one. Voice stays
 * the primary path; this is visibility + manual override. Ledger-themed, works
 * light + dark, and sits top-left so it never fights the orb, mic, or cards.
 */
import { useState } from "react"
import { Plus, X, Pencil, ChevronDown, Layers } from "lucide-react"
import type { TalkThread } from "./use-talk"
import "./thread-panel.css"

export interface ThreadPanelProps {
  threads: TalkThread[]
  /** The thread the next dispatch continues (null → new thread). */
  targetThreadId: string | null
  onSelect: (id: string | null) => void
  onRename: (id: string, label: string) => void
  onDismiss: (id: string) => void
}

export function ThreadPanel({ threads, targetThreadId, onSelect, onRename, onDismiss }: ThreadPanelProps) {
  const [open, setOpen] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState("")

  if (threads.length === 0) return null

  // Newest first so the freshest thread is at the top.
  const ordered = [...threads].sort((a, b) => b.ts - a.ts)

  const startEdit = (t: TalkThread) => { setEditingId(t.id); setDraft(t.label) }
  const commitEdit = () => {
    if (editingId && draft.trim()) onRename(editingId, draft.trim())
    setEditingId(null)
  }

  return (
    <div className="tp">
      <button className="tp__head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Layers size={13} />
        <span className="tp__title">Threads</span>
        <span className="tp__count">{threads.length}</span>
        <ChevronDown size={14} className={`tp__chev${open ? " tp__chev--open" : ""}`} />
      </button>

      {open && (
        <div className="tp__list">
          <button
            className="tp__new"
            data-active={targetThreadId === null}
            onClick={() => onSelect(null)}
          >
            <Plus size={13} /> New thread
          </button>

          {ordered.map((t) => {
            const selected = t.id === targetThreadId
            const running = t.state !== "idle"
            return (
              <div
                key={t.id}
                className="tp__chip"
                data-selected={selected}
                data-parked={!t.orbiting}
                style={{ ["--tp-hue" as string]: String(t.hue) }}
              >
                <span className={`tp__dot${running ? " tp__dot--running" : ""}`} />

                {editingId === t.id ? (
                  <input
                    className="tp__edit"
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitEdit()
                      else if (e.key === "Escape") setEditingId(null)
                    }}
                  />
                ) : (
                  <button
                    className="tp__label"
                    onClick={() => onSelect(selected ? null : t.id)}
                    onDoubleClick={() => startEdit(t)}
                    title={selected ? "Routing here — tap to unset" : "Route next message here"}
                  >
                    {t.label}
                  </button>
                )}

                <span className={`tp__status tp__status--${running ? "run" : "done"}`}>
                  {running ? "Running" : "Done"}
                </span>

                <button className="tp__icon" aria-label="Rename thread" onClick={() => startEdit(t)}>
                  <Pencil size={12} />
                </button>
                <button className="tp__icon" aria-label="Dismiss thread" onClick={() => onDismiss(t.id)}>
                  <X size={13} />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
