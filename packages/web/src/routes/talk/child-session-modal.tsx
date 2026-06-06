import { useSessionChat } from '@/routes/talk/use-session-chat'
import { ChatMessages } from '@/components/chat/chat-messages'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

/**
 * Read-only popup that shows a COO child session's full conversation, reusing
 * the main chat's <ChatMessages> renderer so bubbles, tool groups, markdown,
 * file links and media all look identical to the primary chat view.
 *
 * Self-contained: pass a sessionId + open flag. Wiring (which child to show,
 * when to open) is the caller's job.
 */

interface ChildSessionModalProps {
  sessionId: string | null
  open: boolean
  onClose: () => void
}

/** Human label for the modal header: session title → employee → short id. */
function headerLabel(
  session: Record<string, unknown> | undefined,
  sessionId: string | null,
): string {
  const title = typeof session?.title === 'string' ? session.title.trim() : ''
  if (title) return title
  const employee = typeof session?.employee === 'string' ? session.employee.trim() : ''
  if (employee) return employee
  if (sessionId) return `Session ${sessionId.slice(0, 8)}`
  return 'Conversation'
}

export function ChildSessionModal({ sessionId, open, onClose }: ChildSessionModalProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="flex max-h-[80vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        {open && sessionId ? (
          <ChildSessionBody sessionId={sessionId} />
        ) : (
          // Keep a title mounted for a11y even before a session is selected.
          <DialogHeader className="border-b border-[var(--separator)] px-[var(--space-4)] py-[var(--space-3)] text-left">
            <DialogTitle className="text-[length:var(--text-subheadline)] text-[var(--text-primary)]">
              Conversation
            </DialogTitle>
          </DialogHeader>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** Body is split out so useSessionChat only runs while the modal is open. */
function ChildSessionBody({ sessionId }: { sessionId: string }) {
  const { messages, session, isLoading } = useSessionChat(sessionId)
  const label = headerLabel(session, sessionId)

  return (
    <>
      <DialogHeader className="border-b border-[var(--separator)] px-[var(--space-4)] py-[var(--space-3)] pr-[var(--space-10)] text-left">
        <DialogTitle className="truncate text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
          {label}
        </DialogTitle>
      </DialogHeader>

      <div className="flex min-h-0 flex-1 flex-col bg-[var(--bg)]">
        {isLoading ? (
          <div className="flex flex-1 items-center justify-center px-[var(--space-4)] py-[var(--space-8)] text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">
            Loading conversation…
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-1 items-center justify-center px-[var(--space-4)] py-[var(--space-8)] text-[length:var(--text-footnote)] text-[var(--text-tertiary)]">
            No messages yet
          </div>
        ) : (
          // Reuse the main chat renderer verbatim — groupMessages + per-message
          // bubbles + markdown/file-links live inside ChatMessages.
          <ChatMessages messages={messages} loading={false} />
        )}
      </div>
    </>
  )
}
