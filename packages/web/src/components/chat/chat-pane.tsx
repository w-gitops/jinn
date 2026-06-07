
import { lazy, Suspense, useState, useCallback, useEffect, useRef } from 'react'
import { api } from '@/lib/api'
import { useOrg } from '@/hooks/use-employees'
import { ChatMessages } from '@/components/chat/chat-messages'
import { ChatInput } from '@/components/chat/chat-input'
import { ChatEmployeePicker } from '@/components/chat/chat-employee-picker'
import { QueuePanel } from '@/components/chat/queue-panel'
import { ModelSelectorRow, type SelectorValue } from '@/components/chat/model-selector-row'
import { useLiveSession } from '@/hooks/use-live-session'

const CliTerminal = lazy(() => import('@/components/cli-terminal').then(m => ({ default: m.CliTerminal })))
import { buildNewSessionParams } from '@/components/chat/new-chat-helpers'
import type { Employee } from '@/lib/api'
import type { Message, MediaAttachment } from '@/lib/conversations'

// The live read pipeline (load/WS/reconnect/watchdog) now lives in
// useLiveSession; shouldRecoverStuckTurn moved there too. Re-export it so the
// existing completion-watchdog test (imports from this module) keeps working.
export { shouldRecoverStuckTurn } from '@/hooks/use-live-session'

type Listener = (event: string, payload: unknown) => void

interface ChatPaneProps {
  sessionId: string | null
  isActive: boolean
  onFocus: () => void
  /** Notify parent when a new session is created (e.g. first message in new chat) */
  onSessionCreated?: (sessionId: string, pendingUserMessage?: Message) => void
  /** If set on mount, used as the initial user message before loadSession resolves — for the just-created-from-new-chat case. */
  pendingUserMessage?: Message
  /** Notify parent when session meta changes */
  onSessionMetaChange?: (meta: { title?: string; employee?: string; engine?: string; engineSessionId?: string; model?: string }) => void
  /** Notify parent to refresh sidebar */
  onRefresh?: () => void
  /** Portal name from settings */
  portalName?: string
  /** Gateway subscribe function for WS events */
  subscribe: (fn: Listener) => () => void
  /** Gateway connection seq number - triggers reload on reconnect */
  connectionSeq?: number
  /** Gateway skills version */
  skillsVersion?: number
  /** Gateway events array */
  events: Array<{ event: string; payload: unknown }>
  /** View mode: chat or cli transcript */
  viewMode?: 'chat' | 'cli'
  /** Incrementing counter that triggers input focus */
  focusTrigger?: number
  /** Callback to open keyboard shortcuts overlay */
  onShortcutsClick?: () => void
}

export function ChatPane({
  sessionId,
  isActive,
  onFocus,
  onSessionCreated,
  onSessionMetaChange,
  onRefresh,
  portalName = 'Jinn',
  subscribe,
  connectionSeq,
  skillsVersion,
  events,
  viewMode = 'chat',
  focusTrigger,
  onShortcutsClick,
  pendingUserMessage,
}: ChatPaneProps) {
  // Live read pipeline (messages, streaming, loading, session, reconnect/watchdog)
  // is owned by useLiveSession; this pane keeps the composer + send on top and
  // drives optimistic writes through the hook's write API.
  const live = useLiveSession(sessionId, {
    subscribe,
    connectionSeq,
    pendingUserMessage,
    onMeta: onSessionMetaChange,
    onRefresh,
  })
  const {
    messages,
    streamingText,
    loading,
    session: currentSession,
    liveContextTokens,
    beginSend,
    failSend,
    appendLocal,
    reset: resetPane,
  } = live

  // Kept local for handleSelectorChange so it stays a stable ([]) callback that
  // reads the current session id at call time (mirrors the previous behaviour).
  const sessionIdRef = useRef(sessionId)
  useEffect(() => { sessionIdRef.current = sessionId }, [sessionId])

  // Employee picker state for new chat
  const [selectedEmployee, setSelectedEmployee] = useState<string | null>(null)
  const { data: orgData } = useOrg()
  const pickerEmployees = Array.isArray(orgData?.employees)
    ? orgData.employees.map((emp) => ({
        name: emp.name,
        displayName: emp.displayName,
        department: emp.department,
        rank: emp.rank,
      }))
    : []
  // Clear the employee picker when there is no session (the live read pipeline
  // clears its own state on a null sessionId; this is the pane-local part).
  useEffect(() => { if (!sessionId) setSelectedEmployee(null) }, [sessionId])

  // Engine/Model/Effort selector state (composer). Engine is editable on a new
  // chat only; model + effort are editable in existing chats too.
  const [selector, setSelector] = useState<SelectorValue>({})
  const [effortPendingNote, setEffortPendingNote] = useState(false)

  // Pre-fill for a NEW chat from the chosen employee's config (engine/model);
  // COO / no employee → empty so the row shows the global default.
  useEffect(() => {
    if (sessionId) return
    const emp = selectedEmployee && Array.isArray(orgData?.employees)
      ? orgData.employees.find((e) => e.name === selectedEmployee)
      : undefined
    setSelector(emp ? { engine: emp.engine, model: emp.model } : {})
    setEffortPendingNote(false)
  }, [selectedEmployee, sessionId, orgData])

  // Pre-fill for an EXISTING chat from the loaded session.
  useEffect(() => {
    if (!sessionId || !currentSession) return
    setSelector({
      engine: currentSession.engine as string | undefined,
      model: currentSession.model as string | undefined,
      effortLevel: (currentSession.effortLevel ?? currentSession.effort_level) as string | undefined,
    })
    setEffortPendingNote(false)
  }, [sessionId, currentSession])

  // Apply a selector change. New chat: just track it (sent on first message).
  // Existing chat: persist model/effort via PATCH (engine is fixed mid-chat).
  const handleSelectorChange = useCallback((next: SelectorValue) => {
    setSelector(next)
    if (sessionIdRef.current) {
      api.updateSession(sessionIdRef.current, { model: next.model, effortLevel: next.effortLevel }).catch(() => {})
      setEffortPendingNote(true)
    }
  }, [])


  const handleInterrupt = useCallback(async () => {
    if (!sessionId) return
    try {
      await api.stopSession(sessionId)
    } catch {
      // ignore
    }
  }, [sessionId])

  const handleSend = useCallback(
    async (message: string, media?: MediaAttachment[], interrupt?: boolean) => {
      const userMsg: Message = {
        id: crypto.randomUUID(),
        role: 'user',
        content: message,
        timestamp: Date.now(),
        media,
      }
      // Optimistic append + arm loading + mark activity (for the watchdog).
      beginSend(userMsg)

      try {
        // Upload any attached files to the server in parallel and collect file IDs
        let attachmentIds: string[] | undefined
        if (media && media.length > 0) {
          const uploadPromises = media
            .filter((att) => att.file)
            .map((att) => api.uploadFile(att.file!, sessionIdRef.current || undefined))
          if (uploadPromises.length > 0) {
            const uploaded = await Promise.all(uploadPromises)
            attachmentIds = uploaded.map((u) => u.id)
          }
        }

        let sid = sessionId

        if (!sid) {
          const params = buildNewSessionParams({
            message,
            selectedEmployee,
            attachmentIds,
            engine: selector.engine,
            model: selector.model,
            effortLevel: selector.effortLevel,
          })
          if (viewMode === 'cli') (params as Record<string, unknown>).mode = 'interactive'
          const session = (await api.createSession(params)) as Record<string, unknown>
          sid = String(session.id)
          onSessionCreated?.(sid, userMsg)
          onRefresh?.()
        } else {
          // CLI view → route to the interactive PTY engine so the user sees the prompt
          // get injected into the live xterm + claude's streaming response.
          const mode = viewMode === 'cli' ? 'interactive' : undefined
          await api.sendMessage(sid, { message, interrupt: interrupt || undefined, attachments: attachmentIds, mode })
          onRefresh?.()
        }
      } catch (err) {
        failSend(`Error: ${err instanceof Error ? err.message : 'Failed to send message'}`)
      }
    },
    // viewMode MUST be in deps — without it, toggling chat↔CLI keeps the stale
    // closure value and routes CLI sends to the headless engine, which is
    // exactly what made "the xterm shows stale content" reproducible.
    [sessionId, selectedEmployee, onSessionCreated, onRefresh, viewMode, selector, beginSend, failSend]
  )

  const handleStatusRequest = useCallback(async () => {
    if (!sessionId) {
      appendLocal({
        id: crypto.randomUUID(),
        role: 'assistant',
        content: 'No active session. Send a message to start one.',
        timestamp: Date.now(),
      })
      return
    }

    try {
      const session = (await api.getSession(sessionId)) as Record<string, unknown>
      const info = [
        '**Session Info**',
        `ID: \`${session.id}\``,
        `Status: ${session.status || 'unknown'}`,
        session.employee ? `Employee: ${session.employee}` : null,
        session.engine ? `Engine: ${session.engine}` : null,
        session.model ? `Model: ${session.model}` : null,
        session.createdAt ? `Created: ${session.createdAt}` : null,
      ]
        .filter(Boolean)
        .join('\n')

      appendLocal({
        id: crypto.randomUUID(),
        role: 'assistant',
        content: info,
        timestamp: Date.now(),
      })
    } catch {
      appendLocal({
        id: crypto.randomUUID(),
        role: 'assistant',
        content: 'Failed to fetch session status.',
        timestamp: Date.now(),
      })
    }
  }, [sessionId, appendLocal])

  const handleNewSession = useCallback(() => {
    // This just clears the pane state — parent handles actual new session flow
    resetPane()
  }, [resetPane])

  // Drag & drop state
  const [dragOver, setDragOver] = useState(false)
  const [droppedFiles, setDroppedFiles] = useState<File[]>()
  const dragCounter = useRef(0)

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current++
    if (e.dataTransfer.types.includes('Files')) {
      setDragOver(true)
    }
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current--
    if (dragCounter.current === 0) {
      setDragOver(false)
    }
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current = 0
    setDragOver(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) {
      setDroppedFiles(files)
    }
  }, [])

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        overflow: 'hidden',
        background: 'var(--bg)',
        position: 'relative',
      }}
      onClick={onFocus}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Drop zone overlay */}
      {dragOver && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 50,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'color-mix(in srgb, var(--bg) 85%, transparent)',
            backdropFilter: 'blur(4px)',
            transition: 'opacity 150ms ease-in-out',
          }}
        >
          <div
            style={{
              border: '2px dashed var(--accent)',
              borderRadius: 'var(--radius-lg)',
              padding: '48px 64px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: '12px',
            }}
          >
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-body)' }}>
              Drop files here
            </span>
          </div>
        </div>
      )}
      {/* Employee picker for new chat (any view mode — the CLI terminal mounts after first message creates the session) */}
      {!sessionId && messages.length === 0 && (
        <div className="flex flex-1 items-center justify-center">
          <ChatEmployeePicker
            employees={pickerEmployees}
            selectedEmployee={selectedEmployee}
            onSelect={setSelectedEmployee}
            portalName={portalName}
          />
        </div>
      )}

      {/* Messages / CLI transcript — CliTerminal is display-only; ChatInput below sends. */}
      {viewMode === 'cli' && sessionId ? (
        // Reserve flex space during lazy-chunk load so the ChatInput below stays
        // pinned to the bottom instead of flashing to the top for a frame.
        <Suspense fallback={<div style={{ flex: 1, minHeight: 0, background: 'var(--bg)' }} />}>
          <CliTerminal sessionId={sessionId} />
        </Suspense>
      ) : (sessionId || messages.length > 0) ? (
        <ChatMessages messages={messages} loading={loading} streamingText={streamingText} />
      ) : null}

      {/* Queue panel — hidden in the live xterm view (noise on top of the PTY). */}
      {!(viewMode === 'cli' && sessionId) && (
        <QueuePanel
          sessionId={sessionId}
          events={events}
          paused={currentSession?.paused as boolean ?? false}
        />
      )}

      {/* Input — chat-style composer for every view, including CLI (the PTY engine
          accepts attachments + the prompt is injected into xterm via bracketed-paste). */}
      <ChatInput
        disabled={false}
        loading={loading}
        onSend={handleSend}
        onInterrupt={handleInterrupt}
        onNewSession={handleNewSession}
        onStatusRequest={handleStatusRequest}
        skillsVersion={skillsVersion}
        events={events}
        droppedFiles={droppedFiles}
        onDroppedFilesConsumed={() => setDroppedFiles(undefined)}
        focusTrigger={focusTrigger}
        onShortcutsClick={onShortcutsClick}
        selectorSlot={
          <ModelSelectorRow
            mode={sessionId ? 'existing' : 'new'}
            value={selector}
            onChange={handleSelectorChange}
            pendingNote={effortPendingNote}
            disabled={loading}
            contextTokens={liveContextTokens ?? (currentSession?.lastContextTokens as number | null | undefined) ?? undefined}
            onNewChat={handleNewSession}
          />
        }
      />
    </div>
  )
}
