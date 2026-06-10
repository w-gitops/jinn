import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CornerDownLeft, X } from 'lucide-react'
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
  return (
    <div role="toolbar" aria-label="Terminal keys" className="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-[var(--border)] bg-[var(--bg)] px-2 py-1.5">
      {CLI_KEYS.map((key) => {
        const Icon = key.icon
        return (
          <Button
            key={key.label}
            type="button"
            variant="ghost"
            size={Icon ? 'icon-sm' : 'sm'}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => { if (!disabled) onKey(key.data) }}
            disabled={disabled}
            title={key.aria}
            aria-label={key.aria}
            className="shrink-0 font-mono text-[length:var(--text-caption1)]"
          >
            {Icon ? <Icon className="size-4" /> : key.label}
          </Button>
        )
      })}
    </div>
  )
}
