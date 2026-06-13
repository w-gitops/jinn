import { useCallback, useEffect, useMemo, useState } from "react"
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Database,
  Gauge,
  RefreshCw,
  Server,
  WalletCards,
} from "lucide-react"
import { api } from "@/lib/api"
import type {
  EngineLimitBucket,
  EngineLimitEngineSnapshot,
  EngineLimitsResponse,
  EngineLimitWindow,
} from "@/lib/api"
import { PageLayout, ToolbarActions } from "@/components/page-layout"

function formatDate(value?: string) {
  if (!value) return "Not exposed"
  return new Date(value).toLocaleString()
}

function formatPercent(value?: number) {
  return value === undefined ? "Not exposed" : `${value}%`
}

function formatDuration(minutes?: number) {
  if (!minutes) return ""
  if (minutes % 1440 === 0) return `${minutes / 1440}d`
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}

function engineTone(engine: EngineLimitEngineSnapshot) {
  if (engine.status === "error") return "var(--system-red)"
  if (!engine.available) return "var(--text-tertiary)"
  if (engine.stale) return "var(--system-orange)"
  if (engine.status === "live") return "var(--system-green)"
  if (engine.status === "snapshot") return "var(--accent)"
  return "var(--system-blue)"
}

function engineStatusLabel(engine: EngineLimitEngineSnapshot) {
  if (!engine.available) return "Unavailable"
  if (engine.status === "live") return "Live"
  if (engine.status === "snapshot") return "Captured"
  if (engine.status === "static") return "Plan metadata"
  if (engine.status === "error") return "Error"
  return "Limited"
}

function engineIcon(engine: EngineLimitEngineSnapshot) {
  if (engine.status === "error") return AlertTriangle
  if (!engine.available) return Database
  if (engine.status === "live") return CheckCircle2
  if (engine.status === "snapshot") return Gauge
  return Clock3
}

function SummaryMetric({ label, value, icon: Icon }: { label: string; value: string; icon: typeof Gauge }) {
  return (
    <div className="border border-[var(--separator)] rounded-[var(--radius-md)] bg-[var(--material-regular)] p-[var(--space-4)] min-w-0">
      <div className="flex items-center gap-[var(--space-2)] text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
        <Icon size={14} />
        <span>{label}</span>
      </div>
      <div className="mt-[var(--space-2)] text-[length:var(--text-title3)] font-[var(--weight-bold)] text-[var(--text-primary)] truncate">
        {value}
      </div>
    </div>
  )
}

function LimitTile({ window }: { window: EngineLimitWindow }) {
  const observed = window.usedPercent !== undefined
  const used = Math.max(0, Math.min(100, window.usedPercent ?? 0))
  const fill =
    used >= 90
      ? "var(--system-red)"
      : used >= 70
        ? "var(--system-orange)"
        : "var(--system-green)"

  return (
    <div className="border border-[var(--separator)] rounded-[var(--radius-md)] bg-[var(--material-thin)] p-[var(--space-4)] min-w-0">
      <div className="flex items-start justify-between gap-[var(--space-3)]">
        <div>
          <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
            {window.windowDurationMins ? formatDuration(window.windowDurationMins) : window.name}
          </div>
          <div className="mt-1 text-[length:var(--text-title2)] font-[var(--weight-bold)] text-[var(--text-primary)]">
            {formatPercent(window.usedPercent)}
          </div>
        </div>
        <span className="text-[length:var(--text-caption1)] px-2 py-1 rounded-[var(--radius-sm)] bg-[var(--material-regular)] text-[var(--text-secondary)]">
          {window.name}
        </span>
      </div>

      <div className="mt-[var(--space-3)] h-2 rounded-full bg-[var(--material-regular)] overflow-hidden">
        {observed ? (
          <div className="h-full rounded-full transition-all duration-300" style={{ width: `${used}%`, background: fill }} />
        ) : (
          <div
            className="h-full opacity-60"
            style={{
              background:
                "repeating-linear-gradient(90deg, var(--text-quaternary) 0 8px, transparent 8px 14px)",
            }}
          />
        )}
      </div>

      <div className="mt-[var(--space-2)] text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
        {observed ? `Resets ${formatDate(window.resetsAtIso)}` : "Usage and reset are not exposed by this source"}
      </div>
    </div>
  )
}

function ContextStrip({ engine }: { engine: EngineLimitEngineSnapshot }) {
  if (!engine.context && !engine.credits && engine.costUsd === undefined) return null
  return (
    <div className="grid gap-[var(--space-3)] md:grid-cols-3">
      {engine.context && (
        <MiniStat
          label="Context"
          value={
            engine.context.usedPercent === undefined
              ? "Not exposed"
              : `${engine.context.usedPercent}% of ${(engine.context.contextWindowSize || 0).toLocaleString()}`
          }
        />
      )}
      {engine.credits && (
        <MiniStat
          label="Credits"
          value={
            engine.credits.unlimited
              ? "Unlimited"
              : engine.credits.balance
                ? `Balance ${engine.credits.balance}`
                : engine.credits.hasCredits === false
                  ? "No credits"
                  : "Unknown"
          }
        />
      )}
      {engine.costUsd !== undefined && <MiniStat label="Session cost" value={`$${engine.costUsd.toFixed(4)}`} />}
    </div>
  )
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-[var(--separator)] rounded-[var(--radius-md)] p-[var(--space-3)] bg-[var(--material-thin)] min-w-0">
      <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{label}</div>
      <div className="mt-1 text-[length:var(--text-callout)] font-[var(--weight-semibold)] text-[var(--text-primary)] truncate">
        {value}
      </div>
    </div>
  )
}

function BucketList({ buckets }: { buckets: EngineLimitBucket[] }) {
  const extra = buckets.filter((bucket) => bucket.id !== "codex")
  if (extra.length === 0) return null
  return (
    <div className="grid gap-[var(--space-2)]">
      <div className="text-[length:var(--text-caption1)] font-[var(--weight-semibold)] text-[var(--text-tertiary)]">
        Additional quota buckets
      </div>
      {extra.map((bucket) => (
        <div key={bucket.id} className="border border-[var(--separator)] rounded-[var(--radius-md)] bg-[var(--material-thin)] p-[var(--space-3)]">
          <div className="flex flex-wrap items-center gap-[var(--space-2)] mb-[var(--space-3)]">
            <span className="font-[var(--weight-semibold)] text-[var(--text-primary)]">{bucket.name || bucket.id}</span>
            {bucket.planType && <span className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">{bucket.planType}</span>}
          </div>
          <div className="grid gap-[var(--space-3)] md:grid-cols-2">
            {bucket.primary && <LimitTile window={bucket.primary} />}
            {bucket.secondary && <LimitTile window={bucket.secondary} />}
          </div>
        </div>
      ))}
    </div>
  )
}

function EnginePanel({ engine }: { engine: EngineLimitEngineSnapshot }) {
  const Icon = engineIcon(engine)
  const tone = engineTone(engine)
  const windows = engine.windows || []
  const note = engine.error || engine.unsupportedReason || (engine.stale ? "Latest snapshot is older than 30 minutes." : null)

  return (
    <section className="border border-[var(--separator)] rounded-[var(--radius-md)] bg-[var(--material-regular)] overflow-hidden">
      <div className="grid gap-[var(--space-4)] lg:grid-cols-[280px_1fr]">
        <aside className="p-[var(--space-4)] border-b lg:border-b-0 lg:border-r border-[var(--separator)]">
          <div className="flex items-start gap-[var(--space-3)]">
            <div className="w-9 h-9 rounded-[var(--radius-sm)] flex items-center justify-center shrink-0" style={{ color: tone, background: "color-mix(in srgb, currentColor 10%, transparent)" }}>
              <Icon size={18} />
            </div>
            <div className="min-w-0">
              <h2 className="text-[length:var(--text-title3)] font-[var(--weight-bold)] text-[var(--text-primary)] capitalize">
                {engine.name}
              </h2>
              <div className="mt-2 inline-flex items-center rounded-[var(--radius-sm)] px-2 py-1 text-[length:var(--text-caption1)] font-[var(--weight-semibold)]" style={{ color: tone, background: "color-mix(in srgb, currentColor 10%, transparent)" }}>
                {engineStatusLabel(engine)}
              </div>
            </div>
          </div>

          <div className="mt-[var(--space-4)] grid gap-[var(--space-2)] text-[length:var(--text-caption1)] text-[var(--text-secondary)]">
            <div className="flex items-start gap-2">
              <Server size={13} className="mt-0.5 shrink-0" />
              <span>{engine.source}</span>
            </div>
            {engine.accountPlan && (
              <div className="flex items-center gap-2">
                <WalletCards size={13} className="shrink-0" />
                <span>{engine.accountPlan}</span>
              </div>
            )}
            <div>Updated {formatDate(engine.refreshedAt)}</div>
          </div>
        </aside>

        <div className="p-[var(--space-4)] grid gap-[var(--space-4)] min-w-0">
          {windows.length > 0 ? (
            <div className="grid gap-[var(--space-3)] md:grid-cols-2">
              {windows.map((window) => (
                <LimitTile key={`${window.name}-${window.windowDurationMins}`} window={window} />
              ))}
            </div>
          ) : (
            <div className="border border-[var(--separator)] rounded-[var(--radius-md)] bg-[var(--material-thin)] p-[var(--space-4)] text-[length:var(--text-footnote)] text-[var(--text-secondary)]">
              No quota windows are exposed yet for this engine.
            </div>
          )}

          <ContextStrip engine={engine} />
          <BucketList buckets={engine.buckets || []} />

          {engine.models.length > 0 && (
            <div className="flex flex-wrap gap-[var(--space-2)]">
              {engine.models.map((model) => (
                <span
                  key={model.id}
                  className="text-[length:var(--text-caption1)] px-2 py-1 rounded-[var(--radius-sm)] bg-[var(--material-thin)] text-[var(--text-secondary)] border border-[var(--separator)]"
                >
                  {model.label || model.id}
                  {model.contextWindow ? ` · ${model.contextWindow.toLocaleString()}` : ""}
                </span>
              ))}
            </div>
          )}

          {note && (
            <div className="text-[length:var(--text-footnote)] text-[var(--text-secondary)] border border-[var(--separator)] rounded-[var(--radius-md)] p-[var(--space-3)] bg-[var(--material-thin)]">
              {note}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

export default function LimitsPage() {
  const [data, setData] = useState<EngineLimitsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(() => {
    setRefreshing(true)
    setError(null)
    api
      .refreshEngineLimits()
      .then(setData)
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load engine limits"))
      .finally(() => {
        setLoading(false)
        setRefreshing(false)
      })
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const engines = useMemo(() => Object.values(data?.engines || {}), [data])
  const observed = engines.filter((engine) => engine.windows?.some((window) => window.usedPercent !== undefined)).length
  const planOnly = engines.filter((engine) => engine.windows?.length && !engine.windows.some((window) => window.usedPercent !== undefined)).length
  const errors = engines.filter((engine) => engine.status === "error").length
  const nextReset = engines
    .flatMap((engine) => engine.windows || [])
    .map((window) => window.resetsAtIso)
    .filter(Boolean)
    .sort()[0]

  return (
    <PageLayout>
      <div className="h-full flex flex-col overflow-hidden animate-fade-in bg-[var(--bg)]">
        <header
          className="sticky top-0 z-10 flex-shrink-0 bg-[var(--material-regular)] border-b border-[var(--separator)]"
          style={{
            backdropFilter: "blur(40px) saturate(180%)",
            WebkitBackdropFilter: "blur(40px) saturate(180%)",
          }}
        >
          <div className="flex items-center justify-between px-[var(--space-6)] py-[var(--space-4)]">
            <div className="min-w-0">
              <h1 className="text-[length:var(--text-title1)] font-[var(--weight-bold)] text-[var(--text-primary)] leading-[var(--leading-tight)]">
                Engine Limits
              </h1>
              <p className="text-[length:var(--text-footnote)] text-[var(--text-secondary)] mt-[var(--space-1)]">
                {data ? `Generated ${formatDate(data.generatedAt)}` : "Loading engine telemetry"}
              </p>
            </div>
            <ToolbarActions>
              <button
                onClick={refresh}
                className="focus-ring w-8 h-8 flex items-center justify-center rounded-[var(--radius-sm)] border-none bg-transparent text-[var(--text-tertiary)] cursor-pointer transition-colors duration-150 ease-[var(--ease-smooth)]"
                aria-label="Refresh engine limits"
              >
                <RefreshCw size={16} className={refreshing ? "animate-spin" : ""} />
              </button>
            </ToolbarActions>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto px-[var(--space-6)] pt-[var(--space-4)] pb-[var(--space-6)]">
          {error && (
            <div className="mb-[var(--space-4)] px-[var(--space-4)] py-[var(--space-3)] rounded-[var(--radius-md)] border border-[var(--system-red)] text-[length:var(--text-footnote)] text-[var(--system-red)]">
              {error}
            </div>
          )}

          {loading ? (
            <div className="h-[200px] flex items-center justify-center text-[var(--text-tertiary)]">Loading...</div>
          ) : (
            <div className="grid gap-[var(--space-4)]">
              <div className="grid grid-cols-2 xl:grid-cols-4 gap-[var(--space-3)]">
                <SummaryMetric label="Engines" value={String(engines.length)} icon={Database} />
                <SummaryMetric label="Observed quota" value={String(observed)} icon={CheckCircle2} />
                <SummaryMetric label="Plan only" value={String(planOnly)} icon={Clock3} />
                <SummaryMetric label={errors ? "Errors" : "Next reset"} value={errors ? String(errors) : formatDate(nextReset)} icon={errors ? AlertTriangle : Gauge} />
              </div>

              {engines.map((engine) => (
                <EnginePanel key={engine.name} engine={engine} />
              ))}

              {engines.length === 0 && (
                <div className="h-[200px] flex flex-col items-center justify-center text-[var(--text-tertiary)] gap-[var(--space-2)]">
                  <Gauge size={22} />
                  <span>No engines found</span>
                </div>
              )}
            </div>
          )}
        </main>
      </div>
    </PageLayout>
  )
}
