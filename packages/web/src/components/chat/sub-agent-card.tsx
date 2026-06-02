import { useState } from 'react'

/* ── Sub-agent live cards ───────────────────────────────────
 * Claude Code runs Task sub-agents in-process; their nested API streams flow
 * through the per-PTY SSE proxy tagged with a stable `subAgent.id` (see
 * sse-pty-proxy.ts). The chat pane routes those tagged deltas here instead of the
 * main transcript, so each sub-agent shows as a collapsed card you can expand to
 * watch live — like the Task blocks in the Claude Code CLI. Live-only: cards reflect
 * the current/most-recent turn and reset on the next send (no reload persistence). */

export type SubAgentEntry =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string }

export interface SubAgentState {
  id: string
  label?: string
  status: 'running' | 'done'
  entries: SubAgentEntry[]
  startedAt: number
}

/** Fold a single tagged delta into the sub-agent list (pure; returns a new array). */
export function routeSubAgentDelta(
  prev: SubAgentState[],
  sa: { id: string; label?: string },
  deltaType: string,
  content: string,
  toolName?: string,
): SubAgentState[] {
  const idx = prev.findIndex((a) => a.id === sa.id)
  const cur: SubAgentState = idx >= 0
    ? prev[idx]
    : { id: sa.id, label: sa.label, status: 'running', entries: [], startedAt: Date.now() }

  let entries = cur.entries
  if (deltaType === 'text' && content) {
    const last = entries[entries.length - 1]
    if (last && last.kind === 'text') {
      entries = [...entries.slice(0, -1), { kind: 'text', text: last.text + content }]
    } else {
      entries = [...entries, { kind: 'text', text: content }]
    }
  } else if (deltaType === 'tool_use') {
    entries = [...entries, { kind: 'tool', name: toolName || 'tool' }]
  } else {
    return prev // context / tool_result / unknown — nothing to render in the card
  }

  const next: SubAgentState = { ...cur, label: cur.label || sa.label, status: 'running', entries }
  if (idx >= 0) {
    const copy = [...prev]
    copy[idx] = next
    return copy
  }
  return [...prev, next]
}

function SubAgentCard({ agent }: { agent: SubAgentState }) {
  const [expanded, setExpanded] = useState(false)
  const running = agent.status === 'running'
  const toolCount = agent.entries.filter((e) => e.kind === 'tool').length
  const title = agent.label || 'Sub-agent'

  return (
    <div className="px-[var(--space-4)] mb-[var(--space-1)]">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-[var(--space-2)] max-w-full py-[5px] px-[var(--space-3)] rounded-full bg-[var(--fill-secondary)] border border-[var(--separator)] text-[length:var(--text-caption1)] text-[var(--text-secondary)] cursor-pointer transition-[background] duration-150 ease-in-out hover:bg-[var(--fill-tertiary)]"
      >
        {/* sub-agent / branching icon */}
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="opacity-60 shrink-0">
          <circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" />
          <path d="M6 21V9a9 9 0 0 0 9 9" />
        </svg>
        <span className="truncate max-w-[260px]">{title}</span>
        {toolCount > 0 && (
          <span className="shrink-0 text-[var(--text-tertiary)]">· {toolCount} tool{toolCount !== 1 ? 's' : ''}</span>
        )}
        {running ? (
          <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-[var(--system-blue)] animate-[jinn-pulse_1.4s_infinite]" />
        ) : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--system-green,#34c759)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        )}
        <svg
          width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          className={`shrink-0 ml-auto transition-transform duration-150 ease-in-out opacity-50 ${expanded ? 'rotate-180' : 'rotate-0'}`}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {expanded && (
        <div className="mt-[var(--space-1)] ml-[var(--space-1)] max-h-72 overflow-y-auto rounded-[10px] border border-[var(--separator)] bg-[var(--fill-tertiary)] p-[var(--space-3)] flex flex-col gap-[var(--space-1)]">
          {agent.entries.length === 0 ? (
            <span className="text-[length:var(--text-caption2)] text-[var(--text-quaternary)]">Waiting for output…</span>
          ) : (
            agent.entries.map((e, i) =>
              e.kind === 'text' ? (
                <div key={i} className="whitespace-pre-wrap break-words text-[length:var(--text-caption1)] leading-[var(--leading-relaxed)] text-[var(--text-secondary)]">
                  {e.text}
                </div>
              ) : (
                <span key={i} className="self-start inline-flex items-center gap-1 py-0.5 px-2 rounded-full bg-[var(--fill-secondary)] border border-[var(--separator)] text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">
                  {e.name}
                </span>
              )
            )
          )}
        </div>
      )}
    </div>
  )
}

export function SubAgentStack({ agents }: { agents: SubAgentState[] }) {
  if (!agents.length) return null
  return (
    <div className="mt-[var(--space-1)]">
      {agents.map((a) => (
        <SubAgentCard key={a.id} agent={a} />
      ))}
    </div>
  )
}
