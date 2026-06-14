import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from '@/components/ui/dropdown-menu'
import { CheckIcon } from 'lucide-react'
import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { useModelRegistry, engineList, effortLevelsFor, findModel, defaultEffort, clampEffort, contextWindowFor } from '@/hooks/use-model-registry'

/** Round a token count to a compact `k` string (e.g. 23148 → "23k", 980 → "980"). */
export function fmtK(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

export interface ContextUsage {
  /** Tokens used on the most recent turn (0 for a fresh chat). */
  tokens: number
  /** The model's context window in tokens. */
  window: number
  /** Fraction full, clamped to [0,1] for the bar. */
  pct: number
  /** Raw (un-clamped) fraction, for the tooltip percentage. */
  rawPct: number
  /** True when the turn exceeded the window. */
  over: boolean
  /** Threshold colour (orange ≥75%, red ≥90%/over), else undefined. */
  color?: string
  /** Compact "23k / 200k" label (">200k / 200k" when over). */
  label: string
}

/**
 * Pure formatting for the in-dropdown context meter. Returns null only when the
 * window is unknown; a null/0 token count is a valid fresh-chat state (tokens 0).
 */
export function formatContextUsage(
  contextTokens: number | null | undefined,
  window: number | undefined,
): ContextUsage | null {
  if (!window || window <= 0) return null
  const tokens = contextTokens && contextTokens > 0 ? contextTokens : 0
  const rawPct = tokens / window
  const pct = Math.min(rawPct, 1)
  const over = tokens > window
  const color = pct >= 0.9 ? 'var(--system-red)' : pct >= 0.75 ? 'var(--system-orange)' : undefined
  const label = over ? `>${fmtK(window)} / ${fmtK(window)}` : `${fmtK(tokens)} / ${fmtK(window)}`
  return { tokens, window, pct, rawPct, over, color, label }
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
   *  for the in-dropdown context meter. Omitted/0 → fresh chat (window-only). */
  contextTokens?: number | null
  /** Start-a-new-chat handler — offered for the locked-engine (existing-chat) case. */
  onNewChat?: () => void
}

const engineLabelOf = (e: string) => (e ? e.charAt(0).toUpperCase() + e.slice(1) : '')
const effortLabelOf = (lvl: string) => lvl.charAt(0).toUpperCase() + lvl.slice(1)

/**
 * Engine / Model / Effort selector for the chat composer, rendered as a single
 * "chip" trigger (`✦ Opus 4.8 · High ▾`) that opens one consolidated dropdown:
 * engine header, model radio list, effort pill row, a context-usage footer, and
 * a "Switch engine" affordance. All options come from the live registry
 * (GET /api/engines); nothing is hardcoded.
 *  - Engine: editable on a NEW chat only; locked (explainer) in an existing chat.
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
  const effort = value.effortLevel ?? defaultEffort(efforts)

  const modelLabel = models.find((m) => m.id === modelId)?.label ?? modelId ?? 'Model'
  const usage = formatContextUsage(contextTokens, contextWindowFor(registry, engine, modelId))

  // Other installed engines, for the "Switch engine" subtext / submenu.
  const otherEngines = engines.filter((e) => e.name !== engine)

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
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          disabled={disabled}
          aria-label={`Model and effort: ${modelLabel}${effort ? ` · ${effortLabelOf(effort)}` : ''}`}
          className="group inline-flex max-w-full items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--fill-tertiary)] py-1 pl-2.5 pr-2 text-[length:var(--text-footnote)] transition-colors hover:bg-[var(--fill-secondary)] disabled:cursor-default disabled:opacity-60 cursor-pointer"
        >
          <span aria-hidden className="shrink-0 text-[var(--accent)] text-[11px] leading-none">✦</span>
          <span className="truncate font-[var(--weight-semibold)] tracking-[-0.2px] text-[var(--text-primary)]">{modelLabel}</span>
          {effort && (
            // Effort is the first thing to drop on a narrow composer.
            <span className="hidden shrink-0 text-[var(--text-tertiary)] sm:inline">· {effortLabelOf(effort)}</span>
          )}
          <span aria-hidden className="shrink-0 text-[8px] leading-none text-[var(--text-quaternary)] group-hover:text-[var(--text-tertiary)]">▾</span>
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-64 max-w-[calc(100vw-2rem)] rounded-[var(--radius-lg)] border-[var(--border)] bg-[var(--bg-tertiary)] p-1.5 shadow-[var(--shadow-overlay)]"
      >
        {/* Engine header — current engine; locked label in an existing chat. */}
        <div className="px-2 pt-1 pb-1.5 text-[length:var(--text-caption2)] font-[var(--weight-bold)] uppercase tracking-[0.4px] text-[var(--text-quaternary)]">
          Engine · {engineLabelOf(engine)}
          {mode === 'existing' && <span className="ml-1 normal-case tracking-normal opacity-80">(locked)</span>}
        </div>

        {/* Model radio list — label left, accent ✓ on the selected (right). */}
        {models.length === 0 ? (
          <div className="px-2 py-1.5 text-[length:var(--text-caption1)] leading-snug text-[var(--text-secondary)]">
            No models discovered yet.
          </div>
        ) : (
          <DropdownMenuRadioGroup value={modelId} onValueChange={pickModel}>
            {models.map((m) => (
              <DropdownMenuRadioItem
                key={m.id}
                value={m.id}
                className="justify-between rounded-[9px] py-1.5 pl-2 pr-2 text-[length:var(--text-footnote)] text-[var(--text-secondary)] data-[state=checked]:font-[var(--weight-semibold)] data-[state=checked]:text-[var(--text-primary)] [&>span:first-child]:hidden"
              >
                <span className="truncate">{m.label}</span>
                {m.id === modelId && <CheckIcon className="size-3.5 shrink-0 text-[var(--accent)]" />}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        )}

        {/* Effort — pill row; hidden when the model has no effort levels. */}
        {efforts.length > 0 && (
          <>
            <DropdownMenuSeparator className="bg-[var(--separator)]" />
            <div className="px-2 pt-0.5 pb-1 text-[length:var(--text-caption2)] font-[var(--weight-bold)] uppercase tracking-[0.4px] text-[var(--text-quaternary)]">
              Effort
            </div>
            <div className="flex gap-1 px-1 pb-1">
              {efforts.map((lvl) => {
                const on = lvl === effort
                return (
                  <button
                    key={lvl}
                    type="button"
                    onClick={() => pickEffort(lvl)}
                    aria-pressed={on}
                    className={`flex-1 rounded-[8px] py-1.5 text-center text-[length:var(--text-caption1)] capitalize transition-colors ${
                      on
                        ? 'bg-[var(--accent-fill)] font-[var(--weight-semibold)] text-[var(--accent)]'
                        : 'bg-[var(--fill-tertiary)] text-[var(--text-tertiary)] hover:bg-[var(--fill-secondary)] hover:text-[var(--text-secondary)]'
                    }`}
                  >
                    {lvl}
                  </button>
                )
              })}
            </div>
            {mode === 'existing' && pendingNote && (
              <div className="px-2 pb-1 text-[length:var(--text-caption2)] italic text-[var(--text-quaternary)]">
                Applies to your next message
              </div>
            )}
          </>
        )}

        {/* Context usage — how full the window is on the most recent turn.
            Fresh chat (no tokens yet) shows just the window size, no bar. */}
        {usage && (
          <>
            <DropdownMenuSeparator className="bg-[var(--separator)]" />
            <div className="px-2 pt-0.5 pb-1.5">
              <div className="flex items-center justify-between text-[length:var(--text-caption1)]">
                <span className="text-[var(--text-tertiary)]">Context</span>
                {usage.tokens > 0 ? (
                  <span
                    className="font-[family-name:var(--font-mono)] tabular-nums text-[var(--text-secondary)]"
                    style={usage.color ? { color: usage.color } : undefined}
                    title={`${usage.tokens.toLocaleString()} / ${usage.window.toLocaleString()} tokens (${Math.round(usage.rawPct * 100)}%)`}
                  >
                    {usage.label}
                  </span>
                ) : (
                  <span className="font-[family-name:var(--font-mono)] tabular-nums text-[var(--text-quaternary)]">
                    {fmtK(usage.window)} window
                  </span>
                )}
              </div>
              {usage.tokens > 0 && (
                <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--fill-tertiary)]">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${Math.max(usage.pct * 100, 2)}%`, background: usage.color ?? 'var(--accent)' }}
                  />
                </div>
              )}
            </div>
          </>
        )}

        {/* Engine switch — editable on a new chat only; locked mid-chat. */}
        <DropdownMenuSeparator className="bg-[var(--separator)]" />
        {mode === 'new' && otherEngines.length > 0 ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="rounded-[9px] py-1.5 pl-2 pr-2 text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
              <span className="flex-1">Switch engine…</span>
              <span className="mr-1 text-[length:var(--text-caption2)] text-[var(--text-quaternary)]">
                {otherEngines.map((e) => engineLabelOf(e.name)).join(' · ')}
              </span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="rounded-[var(--radius-lg)] border-[var(--border)] bg-[var(--bg-tertiary)] p-1.5 shadow-[var(--shadow-overlay)]">
              <DropdownMenuRadioGroup value={engine} onValueChange={pickEngine}>
                {engines.map((e) => (
                  <DropdownMenuRadioItem
                    key={e.name}
                    value={e.name}
                    className="justify-between rounded-[9px] py-1.5 pl-2 pr-2 text-[length:var(--text-footnote)] text-[var(--text-secondary)] data-[state=checked]:font-[var(--weight-semibold)] data-[state=checked]:text-[var(--text-primary)] [&>span:first-child]:hidden"
                  >
                    <span>{engineLabelOf(e.name)}</span>
                    {e.name === engine && <CheckIcon className="size-3.5 shrink-0 text-[var(--accent)]" />}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator className="bg-[var(--separator)]" />
              <DropdownMenuItem
                onSelect={(e) => { e.preventDefault(); void refreshModels() }}
                className="rounded-[9px] py-1.5 px-2 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]"
              >
                ↻ Refresh models
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : mode === 'existing' ? (
          onNewChat ? (
            <DropdownMenuItem
              onSelect={onNewChat}
              className="rounded-[9px] py-1.5 px-2 text-[length:var(--text-footnote)] text-[var(--text-secondary)]"
            >
              <span className="flex-1">Start a new chat to switch engine</span>
            </DropdownMenuItem>
          ) : (
            <div className="px-2 py-1.5 text-[length:var(--text-caption1)] leading-snug text-[var(--text-quaternary)]">
              Engine is locked for this chat.
            </div>
          )
        ) : (
          <DropdownMenuItem
            onSelect={(e) => { e.preventDefault(); void refreshModels() }}
            className="rounded-[9px] py-1.5 px-2 text-[length:var(--text-caption1)] text-[var(--text-tertiary)]"
          >
            ↻ Refresh models
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
