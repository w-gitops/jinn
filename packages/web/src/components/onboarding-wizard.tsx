
import { useCallback, useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import {
  MessageSquare,
  Users,
  Columns3,
  Clock,
  DollarSign,
  Activity,
  Check,
  ArrowLeft,
  ArrowRight,
  Rocket,
} from "lucide-react"
import { useSettings } from "@/routes/settings-provider"
import { useTheme } from "@/routes/providers"
import { THEMES } from "@/lib/themes"
import { api, type ModelInfo } from "@/lib/api"
import { buildNewSessionParams } from "@/components/chat/new-chat-helpers"

// ---------------------------------------------------------------------------
// Accent color presets
// ---------------------------------------------------------------------------

const ACCENT_PRESETS = [
  { label: "Red", value: "#EF4444" },
  { label: "Orange", value: "#F97316" },
  { label: "Amber", value: "#F59E0B" },
  { label: "Yellow", value: "#EAB308" },
  { label: "Lime", value: "#84CC16" },
  { label: "Green", value: "#22C55E" },
  { label: "Emerald", value: "#10B981" },
  { label: "Cyan", value: "#06B6D4" },
  { label: "Blue", value: "#3B82F6" },
  { label: "Indigo", value: "#6366F1" },
  { label: "Violet", value: "#8B5CF6" },
  { label: "Pink", value: "#EC4899" },
]

// ---------------------------------------------------------------------------
// Feature cards for overview step
// ---------------------------------------------------------------------------

const FEATURES = [
  { icon: MessageSquare, name: "Chat", desc: "Direct conversations with any employee" },
  { icon: Users, name: "Organization", desc: "Visual org chart of your AI team" },
  { icon: Columns3, name: "Kanban", desc: "Task boards for work management" },
  { icon: Clock, name: "Cron", desc: "Scheduled jobs with status monitoring" },
  { icon: DollarSign, name: "Costs", desc: "Token usage and cost tracking" },
  { icon: Activity, name: "Activity", desc: "Real-time logs and event stream" },
]

// ---------------------------------------------------------------------------
// Engine / model tiers — eyebrow labels for Claude only
// ---------------------------------------------------------------------------

/** Plain-language eyebrow labels shown only when the default engine is Claude
 *  and all three known model IDs are present in the registry. */
const CLAUDE_EYEBROW: Record<string, string> = {
  opus:                "Smartest",
  "claude-sonnet-4-6": "Balanced",
  "claude-haiku-4-5":  "Fastest",
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface OnboardingWizardProps {
  forceOpen?: boolean
  onClose?: () => void
}

export function OnboardingWizard({ forceOpen, onClose }: OnboardingWizardProps) {
  const {
    settings,
    setPortalName,
    setOperatorName,
    setAccentColor,
    setLanguage,
  } = useSettings()
  const { theme, setTheme } = useTheme()
  const navigate = useNavigate()

  const [visible, setVisible] = useState(false)
  const [step, setStep] = useState(0)
  const [direction, setDirection] = useState<"forward" | "back">("forward")

  // Local input values
  const [localName, setLocalName] = useState("")
  const [localOperator, setLocalOperator] = useState("")
  const [localLanguage, setLocalLanguage] = useState(settings.language ?? "English")
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  /** Models for the default engine, loaded from the registry on mount.
   *  null = still loading; [] = load failed / no models (fallback mode). */
  const [engineOptions, setEngineOptions] = useState<ModelInfo[] | null>(null)
  const [engineChoice, setEngineChoice] = useState<{
    engine: string | undefined
    model: string | undefined
    effortLevel: string
  }>({
    engine: undefined,
    model: undefined,
    effortLevel: "medium",
  })

  const TOTAL_STEPS = 5

  // First-run detection — check server-side flag, not just localStorage
  useEffect(() => {
    if (forceOpen) {
      setLocalName(settings.portalName ?? "")
      setLocalOperator(settings.operatorName ?? "")
      setVisible(true)
      return
    }
    // If localStorage says onboarded, trust it (fast path)
    if (typeof window !== "undefined" && localStorage.getItem("jinn-onboarded")) {
      return
    }
    // Otherwise check server — the onboarded flag persists across browsers
    api.getOnboarding().then((data) => {
      if (data.onboarded) {
        localStorage.setItem("jinn-onboarded", "true")
      } else if (data.needed) {
        setVisible(true)
      }
    }).catch(() => {
      // Fallback: show wizard if we can't reach the server and no localStorage flag
      if (!localStorage.getItem("jinn-onboarded")) {
        setVisible(true)
      }
    })
  }, [forceOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  // Load the engine registry so step 3 cards are driven by config, not hardcoded Claude IDs.
  useEffect(() => {
    api.getEngines().then((data) => {
      const eng = data.default
      const entry = data.engines?.[eng]
      const models: ModelInfo[] = entry?.models ?? []
      setEngineOptions(models)
      if (models.length > 0) {
        const defaultModel = entry?.defaultModel ?? models[0]?.id
        setEngineChoice({ engine: eng, model: defaultModel, effortLevel: "medium" })
      } else {
        // No models in registry for the default engine — fallback mode.
        setEngineOptions([])
      }
    }).catch(() => {
      // API unreachable or registry empty — leave engine undefined so
      // applyEngineChoice will no-op and the server default is preserved.
      setEngineOptions([])
    })
  }, []) // run once on mount

  const handleNext = useCallback(async () => {
    // Commit name/operator/language on step 0
    if (step === 0) {
      setPortalName(localName || null)
      setOperatorName(localOperator || null)
      setLanguage(localLanguage || "English")
    }

    if (step < TOTAL_STEPS - 1) {
      setDirection("forward")
      setStep(step + 1)
    } else {
      // Complete — persist to backend, then close ONLY on a confirmed save.
      // Setting the localStorage flag before the POST succeeds would hide the
      // wizard while the server still thinks onboarding is pending (it would
      // reappear on another device, and the name/language would be lost).
      setSubmitting(true)
      setSubmitError(null)
      try {
        await api.completeOnboarding({
          portalName: localName || undefined,
          operatorName: localOperator || undefined,
          language: localLanguage || undefined,
          engine: engineChoice.engine,
          model: engineChoice.model,
          effortLevel: engineChoice.effortLevel,
        })
        if (!forceOpen) {
          localStorage.setItem("jinn-onboarded", "true")
        }
        setVisible(false)
        onClose?.()
        // Launch the COO setup conversation (no employee = COO).
        try {
          const seed = "Hi! I just finished setup — let's get started. 👋"
          const params = buildNewSessionParams({
            message: seed,
            selectedEmployee: null,
            engine: engineChoice.engine,
            model: engineChoice.model,
            effortLevel: engineChoice.effortLevel,
          })
          const session = (await api.createSession(params)) as { id?: string }
          if (session?.id) {
            navigate(`/chat?sessionId=${session.id}`)
            return
          }
        } catch {
          // fall through to home
        }
        navigate("/")
      } catch {
        setSubmitError("Couldn't save your setup — check that the gateway is running, then try again.")
      } finally {
        setSubmitting(false)
      }
    }
  }, [
    step,
    localName,
    localOperator,
    localLanguage,
    forceOpen,
    onClose,
    setPortalName,
    setOperatorName,
    setLanguage,
    navigate,
    engineChoice,
  ])

  const handleBack = useCallback(() => {
    if (step > 0) {
      setDirection("back")
      setStep(step - 1)
      setSubmitError(null)
    }
  }, [step])

  if (!visible) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{
        background: "color-mix(in srgb, var(--bg) 35%, rgba(0,0,0,0.60))",
        backdropFilter: "blur(40px) saturate(160%)",
        WebkitBackdropFilter: "blur(40px) saturate(160%)",
      }}
    >
      <div
        className="animate-fade-in w-full max-w-[520px] mx-[var(--space-4)] bg-[var(--material-regular)] rounded-[var(--radius-xl)] border border-[var(--separator)] overflow-hidden flex flex-col max-h-[90vh]"
        style={{
          boxShadow: "var(--shadow-overlay)",
        }}
      >
        {/* Step indicator — frosted header strip */}
        <div className="flex flex-col items-center pt-[var(--space-5)] px-[var(--space-5)] pb-[var(--space-4)] border-b border-[var(--separator)]">
          <div className="flex justify-center gap-[var(--space-2)]">
            {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
              <div
                key={i}
                className="h-1.5 rounded-full transition-all duration-300"
                style={{
                  width: i === step ? 28 : 8,
                  background: i <= step ? "var(--accent)" : "var(--fill-tertiary)",
                  opacity: i < step ? 0.45 : 1,
                }}
              />
            ))}
          </div>
          <p className="text-[length:var(--text-caption1)] text-[var(--text-quaternary)] mt-[var(--space-2)] font-[var(--weight-medium)] tracking-[var(--tracking-wide)] uppercase">
            Step {step + 1} of {TOTAL_STEPS}
          </p>
        </div>

        {/* Step content */}
        <div className="px-[var(--space-6)] pt-[var(--space-5)] pb-[var(--space-4)] overflow-y-auto flex-1">
          {/* Step 0: Welcome */}
          {step === 0 && (
            <div
              key="step-0"
              className="animate-fade-in text-center"
            >
              <div className="mx-auto mb-[var(--space-4)] w-[72px] h-[72px] rounded-full bg-[var(--accent-fill)] flex items-center justify-center">
                <span className="text-[44px] leading-none">{"🧞"}</span>
              </div>
              <h2 className="text-[length:var(--text-title1)] font-[var(--weight-bold)] tracking-[var(--tracking-tight)] text-[var(--text-primary)] mb-[var(--space-2)]">
                Welcome to {localName || "Jinn"}
              </h2>
              <p className="text-[length:var(--text-subheadline)] text-[var(--text-secondary)] leading-[var(--leading-relaxed)] max-w-[380px] mx-auto mb-[var(--space-5)]">
                Your AI team management portal. Let&apos;s get you set up.
              </p>

              <div className="flex flex-col gap-[var(--space-3)] text-left">
                <div>
                  <label className="block text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-tertiary)] mb-[var(--space-1)]">
                    Portal Name
                  </label>
                  <input
                    type="text"
                    className="apple-input w-full bg-[var(--fill-tertiary)] rounded-[var(--radius-md)] px-3 py-2 text-[length:var(--text-subheadline)] text-[var(--text-primary)] outline-none border border-transparent focus:border-[var(--accent)] transition-colors placeholder:text-[var(--text-quaternary)]"
                    placeholder="Jinn"
                    value={localName}
                    onChange={(e) => setLocalName(e.target.value)}
                    autoFocus
                  />
                </div>

                <div>
                  <label className="block text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-tertiary)] mb-[var(--space-1)]">
                    What should we call you?
                  </label>
                  <input
                    type="text"
                    className="apple-input w-full bg-[var(--fill-tertiary)] rounded-[var(--radius-md)] px-3 py-2 text-[length:var(--text-subheadline)] text-[var(--text-primary)] outline-none border border-transparent focus:border-[var(--accent)] transition-colors placeholder:text-[var(--text-quaternary)]"
                    placeholder="Your Name"
                    value={localOperator}
                    onChange={(e) => setLocalOperator(e.target.value)}
                  />
                </div>

                <div>
                  <label className="block text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-tertiary)] mb-[var(--space-1)]">
                    Preferred Language
                  </label>
                  <select
                    value={localLanguage}
                    onChange={(e) => setLocalLanguage(e.target.value)}
                    className="w-full bg-[var(--fill-tertiary)] rounded-[var(--radius-md)] px-3 py-2 text-[length:var(--text-subheadline)] text-[var(--text-primary)] outline-none border border-transparent focus:border-[var(--accent)] transition-colors cursor-pointer"
                  >
                    <option value="English">English</option>
                    <option value="Spanish">Spanish</option>
                    <option value="French">French</option>
                    <option value="German">German</option>
                    <option value="Portuguese">Portuguese</option>
                    <option value="Italian">Italian</option>
                    <option value="Dutch">Dutch</option>
                    <option value="Russian">Russian</option>
                    <option value="Chinese">Chinese</option>
                    <option value="Japanese">Japanese</option>
                    <option value="Korean">Korean</option>
                    <option value="Arabic">Arabic</option>
                    <option value="Hindi">Hindi</option>
                    <option value="Bulgarian">Bulgarian</option>
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* Step 1: Theme */}
          {step === 1 && (
            <div key="step-1" className="animate-fade-in">
              <h2 className="text-[length:var(--text-title1)] font-[var(--weight-bold)] tracking-[var(--tracking-tight)] text-[var(--text-primary)] mb-[var(--space-1)]">
                Choose your theme
              </h2>
              <p className="text-[length:var(--text-subheadline)] text-[var(--text-tertiary)] mb-[var(--space-4)]">
                Pick the look that suits you. This applies live.
              </p>

              <div className="grid grid-cols-[repeat(auto-fill,minmax(130px,1fr))] gap-[var(--space-3)]">
                {THEMES.map((t) => {
                  const isActive = theme === t.id
                  return (
                    <button
                      key={t.id}
                      onClick={() => setTheme(t.id)}
                      className="flex flex-col items-center gap-[var(--space-2)] px-[var(--space-3)] py-[var(--space-4)] rounded-[var(--radius-md)] cursor-pointer transition-all duration-150"
                      style={{
                        background: isActive
                          ? "color-mix(in srgb, var(--accent) 8%, var(--fill-quaternary))"
                          : "var(--fill-quaternary)",
                        border: isActive
                          ? "1.5px solid var(--accent)"
                          : "1.5px solid var(--separator)",
                      }}
                    >
                      <span className="text-[28px]">{t.emoji}</span>
                      <span
                        className="text-[length:var(--text-footnote)]"
                        style={{
                          fontWeight: isActive
                            ? "var(--weight-semibold)"
                            : "var(--weight-medium)",
                          color: isActive
                            ? "var(--accent)"
                            : "var(--text-secondary)",
                        }}
                      >
                        {t.label}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Step 2: Accent Color */}
          {step === 2 && (
            <div key="step-2" className="animate-fade-in">
              <h2 className="text-[length:var(--text-title1)] font-[var(--weight-bold)] tracking-[var(--tracking-tight)] text-[var(--text-primary)] mb-[var(--space-1)]">
                Pick an accent color
              </h2>
              <p className="text-[length:var(--text-subheadline)] text-[var(--text-tertiary)] mb-[var(--space-4)]">
                Personalize with your favorite color.
              </p>

              <div className="bg-[var(--fill-quaternary)] rounded-[var(--radius-md)] p-[var(--space-5)]">
                <div className="grid grid-cols-6 gap-[var(--space-4)] justify-items-center">
                  {ACCENT_PRESETS.map((preset) => {
                    const isActive = settings.accentColor === preset.value
                    return (
                      <button
                        key={preset.value}
                        onClick={() => setAccentColor(preset.value)}
                        aria-label={preset.label}
                        title={preset.label}
                        className="w-10 h-10 rounded-full border-none cursor-pointer flex items-center justify-center transition-all duration-150"
                        style={{
                          background: preset.value,
                          transform: isActive ? "scale(1.12)" : "scale(1)",
                          outline: isActive
                            ? `3px solid ${preset.value}`
                            : "none",
                          outlineOffset: 3,
                          boxShadow: isActive ? `0 2px 8px ${preset.value}55` : "none",
                        }}
                      >
                        {isActive && (
                          <Check size={18} color="var(--accent-contrast)" strokeWidth={3} />
                        )}
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>
          )}

          {/* Step 3: Engine / Model — registry-driven, no hardcoded engine */}
          {step === 3 && (
            <div key="step-3" className="animate-fade-in">
              <h2 className="text-[length:var(--text-title1)] font-[var(--weight-bold)] tracking-[var(--tracking-tight)] text-[var(--text-primary)] mb-[var(--space-1)]">
                Choose your AI tier
              </h2>
              <p className="text-[length:var(--text-subheadline)] text-[var(--text-tertiary)] mb-[var(--space-4)]">
                Pick how your team thinks. You can change this anytime.
              </p>

              {engineOptions === null ? (
                /* Still loading from registry */
                <div className="text-[length:var(--text-subheadline)] text-[var(--text-tertiary)] py-[var(--space-4)] text-center">
                  Loading engine options…
                </div>
              ) : engineOptions.length === 0 ? (
                /* Registry fetch failed or no models available — safe fallback */
                <div className="px-[var(--space-4)] py-[var(--space-3)] rounded-[var(--radius-md)] bg-[var(--fill-quaternary)] border border-[var(--separator)] text-[length:var(--text-subheadline)] text-[var(--text-secondary)]">
                  Using your default engine — you can configure models in Settings anytime.
                </div>
              ) : (
                <div className="flex flex-col gap-[var(--space-2)]">
                  {engineOptions.map((m) => {
                    const isActive = engineChoice.model === m.id
                    // Show plain-language eyebrow labels only on Claude when all three
                    // known tier IDs are present in the registry.
                    const useEyebrow =
                      engineChoice.engine === "claude" &&
                      ["opus", "claude-sonnet-4-6", "claude-haiku-4-5"].every(
                        id => engineOptions.some(om => om.id === id)
                      )
                    const eyebrow = useEyebrow ? CLAUDE_EYEBROW[m.id] : undefined
                    return (
                      <button
                        key={m.id}
                        onClick={() =>
                          setEngineChoice({ engine: engineChoice.engine, model: m.id, effortLevel: "medium" })
                        }
                        className="flex items-center gap-[var(--space-3)] px-[var(--space-4)] py-[var(--space-3)] rounded-[var(--radius-md)] cursor-pointer transition-all duration-150 text-left"
                        style={{
                          background: isActive
                            ? "color-mix(in srgb, var(--accent) 8%, var(--fill-quaternary))"
                            : "var(--fill-quaternary)",
                          border: isActive
                            ? "1.5px solid var(--accent)"
                            : "1.5px solid var(--separator)",
                        }}
                      >
                        <div className="flex-1 min-w-0">
                          {eyebrow && (
                            <div className="text-[length:var(--text-caption1)] font-[var(--weight-medium)] text-[var(--text-tertiary)] uppercase tracking-[var(--tracking-wide)] mb-0.5">
                              {eyebrow}
                            </div>
                          )}
                          <div
                            className="text-[length:var(--text-subheadline)]"
                            style={{
                              fontWeight: "var(--weight-semibold)",
                              color: isActive ? "var(--accent)" : "var(--text-primary)",
                            }}
                          >
                            {m.label}
                          </div>
                          <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)] mt-0.5">
                            {m.id}
                          </div>
                        </div>
                        {isActive && (
                          <div className="w-5 h-5 rounded-full bg-[var(--accent)] flex items-center justify-center shrink-0">
                            <Check size={11} color="var(--accent-contrast)" strokeWidth={3} />
                          </div>
                        )}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {/* Step 4: Overview */}
          {step === 4 && (
            <div key="step-3" className="animate-fade-in">
              <h2 className="text-[length:var(--text-title1)] font-[var(--weight-bold)] tracking-[var(--tracking-tight)] text-[var(--text-primary)] mb-[var(--space-1)]">
                You&apos;re all set!
              </h2>
              <p className="text-[length:var(--text-subheadline)] text-[var(--text-tertiary)] mb-[var(--space-4)]">
                Here&apos;s what you can do.
              </p>

              <div className="flex flex-col gap-[var(--space-2)]">
                {FEATURES.map((f) => {
                  const Icon = f.icon
                  return (
                    <div
                      key={f.name}
                      className="flex items-center gap-[var(--space-3)] px-[var(--space-3)] py-[var(--space-3)] rounded-[var(--radius-md)] bg-[var(--fill-quaternary)]"
                    >
                      <div className="w-9 h-9 rounded-[var(--radius-md)] bg-[var(--accent-fill)] flex items-center justify-center shrink-0">
                        <Icon
                          size={18}
                          className="text-[var(--accent)]"
                        />
                      </div>
                      <div className="min-w-0">
                        <div className="text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] text-[var(--text-primary)]">
                          {f.name}
                        </div>
                        <div className="text-[length:var(--text-caption1)] text-[var(--text-tertiary)]">
                          {f.desc}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        {submitError ? (
          <p
            role="alert"
            className="px-[var(--space-6)] pt-[var(--space-2)] text-[length:var(--text-footnote)] text-[var(--system-red)]"
          >
            {submitError}
          </p>
        ) : null}

        {/* Navigation footer */}
        <div className="flex justify-between items-center px-[var(--space-6)] pb-[var(--space-5)] pt-[var(--space-3)] gap-[var(--space-3)] border-t border-[var(--separator)]">
          {step > 0 ? (
            <button
              onClick={handleBack}
              className="px-[var(--space-4)] py-[var(--space-2)] rounded-[var(--radius-md)] bg-transparent hover:bg-[var(--fill-secondary)] text-[var(--text-secondary)] border-none cursor-pointer text-[length:var(--text-subheadline)] font-[var(--weight-medium)] transition-all duration-150 inline-flex items-center gap-1.5"
            >
              <ArrowLeft size={16} />
              Back
            </button>
          ) : (
            <div />
          )}
          <button
            onClick={handleNext}
            disabled={submitting}
            className="px-[var(--space-6)] py-[var(--space-2)] rounded-[var(--radius-md)] bg-[var(--accent)] text-[var(--accent-contrast)] border-none cursor-pointer text-[length:var(--text-subheadline)] font-[var(--weight-semibold)] transition-all duration-150 inline-flex items-center gap-1.5 disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {step === 0
              ? "Next"
              : step === TOTAL_STEPS - 1
                ? (submitting ? "Saving…" : "Get Started")
                : "Next"}
            {step === TOTAL_STEPS - 1 ? (
              <Rocket size={16} />
            ) : (
              <ArrowRight size={16} />
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
