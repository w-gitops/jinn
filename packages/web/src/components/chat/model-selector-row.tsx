import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
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
  /** Start-a-new-chat handler — offered inside the locked-engine explainer popover. */
  onNewChat?: () => void
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
export function ModelSelectorRow({ mode, value, onChange, pendingNote, disabled, contextTokens, onNewChat }: ModelSelectorRowProps) {
  const { data: registry, isLoading } = useModelRegistry()
  const queryClient = useQueryClient()

  // Resolve the engine to display. Keep the chosen/default one, unless it's an
  // uninstalled engine on a NEW chat — then fall back to the first installed one.
  // Existing chats stay pinned to their (possibly hidden) engine.
  const engines = engineList(registry)
  const preferred = value.engine ?? registry?.default
  const engine =
    mode === 'new' && engines.length > 0 && !engines.some((e) => e.name === preferred)
      ? engines[0].name
      : (preferred ?? '')

  // If a NEW chat's selection resolved to a different (installed) engine because
  // the chosen one is unavailable, sync that back so the created session is valid.
  useEffect(() => {
    if (mode !== 'new' || !registry) return
    const pref = value.engine ?? registry.default
    if (engines.length === 0 || engines.some((e) => e.name === pref)) return
    const ne = registry.engines[engine]
    if (!ne) return
    onChange({
      engine,
      model: ne.defaultModel,
      effortLevel: defaultEffort(effortLevelsFor(registry, engine, ne.defaultModel)),
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry, mode, engine, value.engine])

  if (isLoading || !registry) return null

  const entry = registry.engines[engine]
  const models = entry?.models ?? []
  const currentModel = findModel(registry, engine, value.model)
  const modelId = value.model ?? currentModel?.id ?? entry?.defaultModel ?? ''
  const efforts = effortLevelsFor(registry, engine, modelId)

  const engineLabel = (e: string) => e.charAt(0).toUpperCase() + e.slice(1)
  const modelLabel = (id: string) => models.find((m) => m.id === id)?.label ?? id

  // Re-discover dynamic (pi) models without a restart, then update the cache.
  const refreshModels = async () => {
    try {
      const fresh = await api.refreshEngines()
      queryClient.setQueryData(queryKeys.engines.all, fresh)
    } catch {
      void queryClient.invalidateQueries({ queryKey: queryKeys.engines.all })
    }
  }

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
    <div className="flex items-center gap-1 min-w-0 whitespace-nowrap text-[length:var(--text-caption2)] text-[var(--text-quaternary)]">
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
        // Existing chat: engine is locked, but render as a clickable trigger
        // identical to model/effort. Clicking explains-and-stops (no engine list).
        <InlineTrigger label="Engine (locked)" value={engineLabel(engine)} disabled={disabled}>
          <div className="max-w-[230px] px-2 py-1.5 text-[length:var(--text-caption1)] leading-snug text-[var(--text-secondary)]">
            Engine is locked for this chat. Start a new chat to use a different engine.
          </div>
          {onNewChat && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onNewChat}>+ New chat</DropdownMenuItem>
            </>
          )}
        </InlineTrigger>
      )}

      <Sep />

      {/* Model — always editable. Empty list (e.g. pi still discovering) shows a
          loading hint but stays openable so Refresh is reachable. */}
      <InlineTrigger label="Model" value={models.length === 0 ? 'Loading…' : modelLabel(modelId)} disabled={disabled}>
        {models.length === 0 ? (
          <div className="max-w-[230px] px-2 py-1.5 text-[length:var(--text-caption1)] leading-snug text-[var(--text-secondary)]">
            No models discovered yet.
          </div>
        ) : (
          <DropdownMenuRadioGroup value={modelId} onValueChange={pickModel}>
            {models.map((m) => (
              <DropdownMenuRadioItem key={m.id} value={m.id}>
                {m.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void refreshModels()}>↻ Refresh models</DropdownMenuItem>
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
        const rawPct = contextTokens / cw
        const pct = Math.min(rawPct, 1)
        const color = pct >= 0.9 ? 'var(--system-red)' : pct >= 0.75 ? 'var(--system-orange)' : undefined
        const label = contextTokens > cw ? `>${fmtK(cw)}/${fmtK(cw)}` : `${fmtK(contextTokens)}/${fmtK(cw)}`
        return (
          <>
            <Sep />
            <span
              title={`Context: ${contextTokens.toLocaleString()} / ${cw.toLocaleString()} tokens (${Math.round(rawPct * 100)}%)`}
              style={color ? { color } : undefined}
            >
              {label}
            </span>
          </>
        )
      })()}

      {mode === 'existing' && pendingNote && (
        // Hidden on mobile (clutters the narrow strip / forces wrap); shown ≥sm.
        <span className="ml-1 italic opacity-70 hidden sm:inline">· applies next message</span>
      )}
    </div>
  )
}
