import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@/components/ui/dropdown-menu'
import { useModelRegistry, engineList, effortLevelsFor, findModel, defaultEffort, clampEffort, contextWindowFor } from '@/hooks/use-model-registry'

/** Round a token count to a compact `k` string (e.g. 23148 → "23k", 980 → "980"). */
function fmtK(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

export interface SelectorValue {
  engine?: string
  model?: string
  effortLevel?: string
}

interface ModelSelectorRowProps {
  /** 'new' = engine editable; 'existing' = engine is read-only (locked mid-chat). */
  mode: 'new' | 'existing'
  value: SelectorValue
  onChange: (next: SelectorValue) => void
  /** Shown in 'existing' mode to hint the change applies on the next message. */
  pendingNote?: boolean
  disabled?: boolean
  /** Most recent turn's input-context token count (session.lastContextTokens),
   *  for the inline context meter. Omitted/0 → meter hidden (e.g. fresh chat). */
  contextTokens?: number | null
}

const ENGINE_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  antigravity: 'Antigravity',
}

// Inline metadata trigger — matches the composer hint strip exactly (caption2 +
// text-quaternary, no border/background), brightens to tertiary on hover with a
// faint chevron only on hover/focus. Reads as quiet metadata, not a button.
function InlineTrigger({ label, value, disabled, children }: { label: string; value: string; disabled?: boolean; children: React.ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          disabled={disabled}
          aria-label={label}
          className="group inline-flex items-center gap-0.5 bg-transparent border-none p-0 font-[inherit] text-[var(--text-quaternary)] hover:text-[var(--text-tertiary)] focus-visible:text-[var(--text-tertiary)] transition-colors cursor-pointer disabled:cursor-default"
        >
          <span>{value}</span>
          <span aria-hidden className="opacity-0 group-hover:opacity-60 group-focus-visible:opacity-60 transition-opacity text-[8px] leading-none">▾</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">{children}</DropdownMenuContent>
    </DropdownMenu>
  )
}

const Sep = () => <span aria-hidden className="opacity-40 select-none">·</span>

/**
 * Engine / Model / Effort selector for the chat composer — rendered as quiet
 * inline metadata on the hint strip below the input (e.g. `Claude · Opus 4.8 · medium`).
 * All options come from the live registry (GET /api/engines); nothing hardcoded.
 *  - Engine: editable on a NEW chat only; plain locked text in an existing chat.
 *  - Model: editable always.
 *  - Effort: editable always; hidden entirely for models with no effort levels.
 * Cascading: changing engine resets model to that engine's default; changing model
 * clamps effort to a level valid for the new model.
 */
export function ModelSelectorRow({ mode, value, onChange, pendingNote, disabled, contextTokens }: ModelSelectorRowProps) {
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
    const nextEffort = clampEffort(effortLevelsFor(registry, engine, nextModel), value.effortLevel)
    onChange({ engine, model: nextModel, effortLevel: nextEffort })
  }

  const pickEffort = (nextEffort: string) => {
    onChange({ engine, model: modelId, effortLevel: nextEffort })
  }

  return (
    <div className="flex items-center gap-1 min-w-0 text-[length:var(--text-caption2)] text-[var(--text-quaternary)]">
      {/* Engine — editable on new chat, plain locked text in an existing chat */}
      {mode === 'new' ? (
        <InlineTrigger label="Engine" value={engineLabel(engine)} disabled={disabled}>
          <DropdownMenuRadioGroup value={engine} onValueChange={pickEngine}>
            {engines.map((e) => (
              <DropdownMenuRadioItem key={e.name} value={e.name}>
                {engineLabel(e.name)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </InlineTrigger>
      ) : (
        <span title="Engine can't be changed mid-chat — start a new chat to switch engines">
          {engineLabel(engine)}
        </span>
      )}

      <Sep />

      {/* Model — always editable */}
      <InlineTrigger label="Model" value={modelLabel(modelId)} disabled={disabled || models.length === 0}>
        <DropdownMenuRadioGroup value={modelId} onValueChange={pickModel}>
          {models.map((m) => (
            <DropdownMenuRadioItem key={m.id} value={m.id}>
              {m.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </InlineTrigger>

      {/* Effort — hidden when the model has no effort levels */}
      {efforts.length > 0 && (
        <>
          <Sep />
          <InlineTrigger label="Effort" value={value.effortLevel ?? 'medium'} disabled={disabled}>
            <DropdownMenuRadioGroup value={value.effortLevel ?? 'medium'} onValueChange={pickEffort}>
              {efforts.map((lvl) => (
                <DropdownMenuRadioItem key={lvl} value={lvl}>
                  {lvl}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </InlineTrigger>
        </>
      )}

      {/* Context meter — how full the window is on the most recent turn.
          Hidden when there's no usage yet (fresh chat) or no known window. */}
      {(() => {
        const cw = contextWindowFor(registry, engine, modelId)
        if (!cw || !contextTokens || contextTokens <= 0) return null
        const pct = contextTokens / cw
        const color = pct >= 0.9 ? 'var(--system-red)' : pct >= 0.75 ? 'var(--system-orange)' : undefined
        return (
          <>
            <Sep />
            <span
              title={`Context: ${contextTokens.toLocaleString()} / ${cw.toLocaleString()} tokens (${Math.round(pct * 100)}%)`}
              style={color ? { color } : undefined}
            >
              {fmtK(contextTokens)}/{fmtK(cw)}
            </span>
          </>
        )
      })()}

      {mode === 'existing' && pendingNote && (
        <span className="ml-1 italic opacity-70">· applies next message</span>
      )}
    </div>
  )
}
