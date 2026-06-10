import { useEffect, useRef, useState } from 'react'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CornerDownLeft, Keyboard, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { LucideIcon } from 'lucide-react'

type CliKey = {
  label: string
  aria: string
  data: string
  icon?: LucideIcon
}

export const CLI_KEYS: readonly CliKey[] = [
  { label: 'Enter', aria: 'Enter', data: '\r', icon: CornerDownLeft },
  { label: 'Esc', aria: 'Escape', data: '\x1b' },
  { label: 'Tab', aria: 'Tab', data: '\t' },
  { label: 'Up', aria: 'Arrow up', data: '\x1b[A', icon: ArrowUp },
  { label: 'Down', aria: 'Arrow down', data: '\x1b[B', icon: ArrowDown },
  { label: 'Left', aria: 'Arrow left', data: '\x1b[D', icon: ArrowLeft },
  { label: 'Right', aria: 'Arrow right', data: '\x1b[C', icon: ArrowRight },
  { label: '^C', aria: 'Ctrl-C', data: '\x03', icon: X },
] as const

export function CliKeybar({ onKey, disabled = false }: { onKey: (data: string) => void; disabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return

    function handleMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  return (
    <div ref={ref} className="relative flex justify-end">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onPointerDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        title="Terminal keys"
        aria-label="Terminal keys"
        aria-expanded={open}
        className="text-[var(--text-quaternary)] hover:text-[var(--text-tertiary)]"
      >
        <Keyboard className="size-3.5" />
      </Button>

      {open && (
        <div
          role="toolbar"
          aria-label="Terminal keys"
          className="absolute bottom-full right-0 z-30 mb-2 flex w-max max-w-[min(92vw,280px)] flex-wrap items-center justify-end gap-1 rounded-[var(--radius-md)] border border-[var(--separator)] bg-[var(--material-regular)] p-1.5 shadow-lg backdrop-blur-md"
        >
          {CLI_KEYS.map((key) => {
            const Icon = key.icon
            return (
              <Button
                key={key.label}
                type="button"
                variant="ghost"
                size={Icon ? 'icon-xs' : 'xs'}
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => { if (!disabled) onKey(key.data) }}
                disabled={disabled}
                title={key.aria}
                aria-label={key.aria}
                className="font-mono text-[length:var(--text-caption2)] text-[var(--text-secondary)]"
              >
                {Icon ? <Icon className="size-3.5" /> : key.label}
              </Button>
            )
          })}
        </div>
      )}
    </div>
  )
}
