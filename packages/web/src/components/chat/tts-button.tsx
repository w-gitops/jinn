import type { UseTtsReturn } from '@/hooks/use-tts'

/* ── Speaker icon ─────────────────────────────────────────────────────────── */

function IconSpeaker({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    </svg>
  )
}

function IconStop({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
    >
      <rect x="4" y="4" width="16" height="16" rx="2" />
    </svg>
  )
}

/* ── Component ─────────────────────────────────────────────────────────────── */

interface TtsButtonProps {
  messageId: string
  text: string
  tts: UseTtsReturn
}

/**
 * Read-aloud button shown on completed assistant messages.
 * Active while this message's audio is playing; click stops it.
 */
export function TtsButton({ messageId, text, tts }: TtsButtonProps) {
  const isActive = tts.speakingId === messageId && tts.speaking

  function handleClick(e: React.MouseEvent) {
    e.stopPropagation()
    if (isActive) {
      tts.stopSpeaking()
    } else {
      tts.readMessage(text, messageId)
    }
  }

  return (
    <button
      onClick={handleClick}
      aria-label={isActive ? 'Stop reading' : 'Read aloud'}
      title={isActive ? 'Stop' : 'Read aloud'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 24,
        height: 24,
        borderRadius: 'var(--radius-sm)',
        border: 'none',
        background: isActive ? 'var(--fill-secondary)' : 'transparent',
        color: isActive ? 'var(--accent)' : 'var(--text-tertiary)',
        cursor: 'pointer',
        opacity: isActive ? 1 : 0,
        transition: 'opacity 120ms ease, color 120ms ease, background 120ms ease',
        flexShrink: 0,
      }}
      // Show on row hover via CSS (parent sets .tts-btn-show class on hover)
      className="tts-btn"
    >
      {isActive ? <IconStop /> : <IconSpeaker />}
    </button>
  )
}

/* ── Auto-read toggle ──────────────────────────────────────────────────────── */

interface AutoReadToggleProps {
  tts: UseTtsReturn
}

/**
 * Floating toggle that enables/disables continuous auto-read mode.
 * Positioned in the bottom-right of the message area.
 */
export function AutoReadToggle({ tts }: AutoReadToggleProps) {
  return (
    <button
      onClick={tts.toggleAutoRead}
      aria-label={tts.autoRead ? 'Disable auto-read' : 'Enable auto-read'}
      title={tts.autoRead ? 'Auto-read on' : 'Auto-read off'}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        padding: '4px 10px',
        borderRadius: 'var(--radius-full, 9999px)',
        border: '1px solid var(--separator)',
        background: tts.autoRead
          ? 'color-mix(in srgb, var(--accent) 12%, var(--material-thick))'
          : 'var(--material-thick)',
        color: tts.autoRead ? 'var(--accent)' : 'var(--text-secondary)',
        fontSize: 'var(--text-caption1)',
        cursor: 'pointer',
        boxShadow: 'var(--shadow-elevated)',
        transition: 'background 150ms ease, color 150ms ease',
        whiteSpace: 'nowrap',
      }}
    >
      <IconSpeaker size={11} />
      <span>{tts.autoRead ? 'Auto-read on' : 'Auto-read'}</span>
      {tts.speaking && (
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: 'var(--accent)',
            animation: 'tts-pulse 1.4s infinite',
            display: 'inline-block',
          }}
        />
      )}
    </button>
  )
}
