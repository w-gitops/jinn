import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useGateway } from '@/hooks/use-gateway'
import type { Message, MediaAttachment } from '@/lib/conversations'

/**
 * Read-only conversation loader for a single (child) session, used by the Talk
 * UI's child-session modal. Mirrors the server→Message normalization that
 * chat-pane.tsx applies on load (same id/role/content/timestamp/media mapping)
 * so the messages render identically to the main chat. Unlike chat-pane this
 * hook never mutates the session — it only fetches + (optionally) refetches.
 */

export interface SessionMeta {
  id?: string
  title?: string
  employee?: string
  engine?: string
  model?: string
  status?: string
}

interface SessionChatResult {
  messages: Message[]
  session: Record<string, unknown> | undefined
  isLoading: boolean
  error: Error | null
  refetch: () => void
}

/** Same shape chat-pane builds from `session.messages`/`session.history`. */
function normalizeMessages(session: Record<string, unknown> | undefined): Message[] {
  if (!session) return []
  const history = session.messages || session.history || []
  if (!Array.isArray(history)) return []
  return history.map((m: Record<string, unknown>) => ({
    id: typeof m.id === 'string' ? m.id : crypto.randomUUID(),
    role: (m.role as 'user' | 'assistant' | 'notification') || 'assistant',
    content: String(m.content || m.text || ''),
    timestamp: m.timestamp ? Number(m.timestamp) : Date.now(),
    ...(Array.isArray(m.media) && m.media.length > 0
      ? { media: m.media as MediaAttachment[] }
      : {}),
  }))
}

export function useSessionChat(sessionId: string | null): SessionChatResult {
  const { subscribe } = useGateway()

  const query = useQuery({
    queryKey: ['session-chat', sessionId],
    queryFn: () => api.getSession(sessionId as string),
    enabled: sessionId != null,
  })

  // BONUS live-update: the gateway emits session:delta (per-token) and
  // session:completed / session:updated (terminal) carrying { sessionId }.
  // getSession only returns persisted messages, so refetch on the terminal
  // events (cheap, no per-token spam) to pull in the finished turn.
  const { refetch } = query
  useEffect(() => {
    if (sessionId == null) return
    const unsub = subscribe((event: string, payload: unknown) => {
      const sid = (payload as { sessionId?: string } | null)?.sessionId
      if (sid !== sessionId) return
      if (
        event === 'session:completed' ||
        event === 'session:updated' ||
        event === 'session:stopped'
      ) {
        refetch()
      }
    })
    return unsub
  }, [sessionId, subscribe, refetch])

  return {
    messages: normalizeMessages(query.data),
    session: query.data,
    isLoading: query.isLoading,
    error: (query.error as Error | null) ?? null,
    refetch: () => { refetch() },
  }
}
