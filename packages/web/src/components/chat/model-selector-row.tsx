import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@/components/ui/dropdown-menu'
import { useModelRegistry, engineList, effortLevelsFor, findModel, defaultEffort, clampEffort } from '@/hooks/use-model-registry'

export interface SelectorValue {
  engine?: string
  model?: string
  effortLevel?: string
}

interface ModelSelectorRowProps {
  /** 'new' = engine editable; 'existing' = engine is a read-only chip. */
  mode: 'new' | 'existing'
  value: SelectorValue
  onChange: (next: SelectorValue) => void
  /** Shown in 'existing' mode to hint the change applies on the next message. */
  pendingNote?: boolean
  disabled?: boolean
}

const ENGINE_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  antigravity: 'Antigravity',
}

function Pill({ label, value, disabled, children }: { label: string; value: string; disabled?: boolean; children: React.ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          disabled={disabled}
          className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-[var(--space-2)] py-[2px] text-[var(--text-xs)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)] disabled:opacity-50"
          aria-label={label}
        >
          <span className="text-[var(--text-muted)]">{label}</span>
          <span className="font-medium text-[var(--text-primary)]">{value}</span>
          <span aria-hidden className="text-[var(--text-muted)]">▾</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">{children}</DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Engine / Model / Effort selector for the chat composer. All options come from
 * the live registry (GET /api/engines) — nothing hardcoded.
 *  - Engine: editable on a NEW chat only; a read-only chip in an existing chat.
 *  - Model: editable always.
 *  - Effort: editable always; hidden entirely for models with no effort levels.
 * Cascading: changing engine resets model to that engine's default; changing model
 * clamps effort to a level valid for the new model.
 */
export function ModelSelectorRow({ mode, value, onChange, pendingNote, disabled }: ModelSelectorRowProps) {
  const { data: registry, isLoading } = useModelRegistry()
  if (isLoading || !registry) return null

  const engines = engineList(registry)
  const engine = value.engine ?? registry.default
  const entry = registry.engines[engine]
  const models = entry?.models ?? []
  const currentModel = findModel(registry, engine, value.model)
  const modelId = value.model ?? currentModel?.id ?? entry?.defaultModel ?? ''
  const efforts = effortLevelsFor(registry, engine, modelId)

  const engineLabel = (e: string) => ENGINE_LABELS[e] ?? e
  const modelLabel = (id: string) => models.find((m) => m.id === id)?.label ?? id

  const pickEngine = (nextEngine: string) => {
    const ne = registry.engines[nextEngine]
    const nextModel = ne?.defaultModel ?? ne?.models[0]?.id
    onChange({
      engine: nextEngine,
      model: nextModel,
      effortLevel: defaultEffort(effortLevelsFor(registry, nextEngine, nextModel)),
    })
  }

  const pickModel = (nextModel: string) => {
    // Clamp effort to a level valid for the new model.
    const nextEffort = clampEffort(effortLevelsFor(registry, engine, nextModel), value.effortLevel)
    onChange({ engine, model: nextModel, effortLevel: nextEffort })
  }

  const pickEffort = (nextEffort: string) => {
    onChange({ engine, model: modelId, effortLevel: nextEffort })
  }

  return (
    <div className="flex flex-wrap items-center gap-[var(--space-2)]">
      {/* Engine — editable on new chat, read-only chip in existing chat */}
      {mode === 'new' ? (
        <Pill label="Engine" value={engineLabel(engine)} disabled={disabled}>
          <DropdownMenuRadioGroup value={engine} onValueChange={pickEngine}>
            {engines.map((e) => (
              <DropdownMenuRadioItem key={e.name} value={e.name}>
                {engineLabel(e.name)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </Pill>
      ) : (
        <span
          className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--surface-1)] px-[var(--space-2)] py-[2px] text-[var(--text-xs)] text-[var(--text-muted)]"
          title="Engine can't be changed mid-chat — start a new chat to switch engines"
        >
          <span className="text-[var(--text-muted)]">Engine</span>
          <span className="font-medium text-[var(--text-secondary)]">{engineLabel(engine)}</span>
        </span>
      )}

      {/* Model — always editable */}
      <Pill label="Model" value={modelLabel(modelId)} disabled={disabled || models.length === 0}>
        <DropdownMenuRadioGroup value={modelId} onValueChange={pickModel}>
          {models.map((m) => (
            <DropdownMenuRadioItem key={m.id} value={m.id}>
              {m.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </Pill>

      {/* Effort — hidden when the model has no effort levels */}
      {efforts.length > 0 && (
        <Pill label="Effort" value={value.effortLevel ?? 'medium'} disabled={disabled}>
          <DropdownMenuRadioGroup value={value.effortLevel ?? 'medium'} onValueChange={pickEffort}>
            {efforts.map((lvl) => (
              <DropdownMenuRadioItem key={lvl} value={lvl}>
                {lvl}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </Pill>
      )}

      {mode === 'existing' && pendingNote && (
        <span className="text-[var(--text-xs)] text-[var(--text-muted)]">· applies to next message</span>
      )}
    </div>
  )
}
