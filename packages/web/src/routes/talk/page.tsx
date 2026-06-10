/**
 * Jinn Talk — /talk route (AURA voice surface).
 *
 * Mobile-first. The orchestrator orb sits center; when it spawns COO child
 * sessions they appear as chips in the WorkDock rail (right edge). One big mic
 * button drives the loop (tap to talk, tap to send). TTS is browser
 * SpeechSynthesis by default, so it speaks aloud on the phone with no server deps.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { ArrowLeft, Mic, Square, Sun, Moon, Keyboard, Volume2, VolumeX, Send, Search } from "lucide-react"
import { cn } from "@/lib/utils"
import { mainButtonMode } from "./main-button"
import { useTheme } from "@/routes/providers"
import { AuraAvatar } from "./aura-avatar"
import { ConversationStream } from "./conversation-stream"
import { PinnedCards, selectInlineCards, selectPinnedCards } from "./cards/card-stack"
import { ErrorBoundary } from "@/components/error-boundary"
import { WorkDock } from "./work-dock"
import { SessionPeek } from "./session-peek"
import { SessionSearchSheet } from "./session-search-sheet"
import { AttachBanner } from "./attach-banner"
import { hasEngageAttachment } from "./session-search"
import { TalkEnginePicker } from "./talk-engine-picker"
import { TalkVoiceIndicator } from "./talk-voice-indicator"
import { WhisperDownloadModal } from "@/components/stt/whisper-download-modal"
import { useTalkContext } from "./talk-provider"
import { useStageMode } from "./stage"
import "./talk-tokens.css"
import "./talk-layout.css"

export default function TalkPage() {
  const { theme, setTheme } = useTheme()
  // State lives in TalkProvider (above the router) so it survives navigation;
  // activate() kicks off the (gated) bootstrap the first time Talk is opened.
  const talk = useTalkContext()
  const { activate } = talk
  useEffect(() => { activate() }, [activate])
  // Partition cards: blocking approval/choice (unresolved) pin to the bottom
  // strip; everything else renders inline at its anchored turn in the stream.
  const inlineCards = useMemo(
    () => selectInlineCards(talk.cards, talk.resolvedCardIds),
    [talk.cards, talk.resolvedCardIds],
  )
  const pinnedCards = useMemo(
    () => selectPinnedCards(talk.cards, talk.resolvedCardIds),
    [talk.cards, talk.resolvedCardIds],
  )
  // Stage mode — who owns the centre: orb (hero), transcript (conversing), or
  // a blocking card (content). Drives the grid via data-stage + the orb dock.
  const stage = useStageMode({
    state: talk.state,
    hasRows: talk.rows.length > 0,
    pinnedCount: pinnedCards.length,
  })
  // Which session's chat the peek popup is showing (null → closed).
  const [chatSessionId, setChatSessionId] = useState<string | null>(null)
  // Session-search sheet (opened from the top-bar search icon).
  const [searchOpen, setSearchOpen] = useState(false)
  const showAttachBanner = useMemo(() => hasEngageAttachment(talk.graph), [talk.graph])
  // Type-to-talk: a tucked-away text input for when you can't (or don't want to)
  // speak. Sends via the same path as a voice turn. Works without the mic/STT.
  const [typing, setTyping] = useState(false)
  const [draft, setDraft] = useState("")
  const submitText = useCallback(() => {
    const t = draft.trim()
    if (!t) return
    talk.sendText(t)
    setDraft("")
  }, [draft, talk])

  const isRecording = talk.listening
  // The text input has content → the main mic button morphs into a Send button.
  const hasText = typing && draft.trim().length > 0
  const mode = mainButtonMode({ listening: isRecording, hasText })

  const onMic = useCallback(() => {
    if (talk.listening) talk.stop()
    else talk.startListening()
  }, [talk])

  // One action-aware button: send the draft when there's text, otherwise drive
  // the mic (start, or stop-and-send while recording).
  const onMainButton = useCallback(() => {
    if (mode === "send") submitText()
    else onMic()
  }, [mode, submitText, onMic])

  // Transient "Switched to <engine>" marker — switching the engine re-bootstraps
  // the talk session (new chat), so a quiet note confirms the change landed.
  const [engineNotice, setEngineNotice] = useState<string | null>(null)
  const onSwitchEngine = useCallback((engine: string) => {
    talk.switchEngine(engine)
    const label = engine.charAt(0).toUpperCase() + engine.slice(1)
    setEngineNotice(`Switched to ${label}`)
  }, [talk])
  useEffect(() => {
    if (!engineNotice) return
    const t = window.setTimeout(() => setEngineNotice(null), 2600)
    return () => window.clearTimeout(t)
  }, [engineNotice])

  // No installed engine for the orchestrator → the loop can't run; surface an
  // actionable message instead of letting the mic silently fail.
  const noEngine = talk.engineInfo.loaded && talk.engineInfo.available.length === 0

  const hint = (() => {
    if (!talk.connected) return "Connecting"
    if (noEngine) return "No voice engine — open settings ⚙"
    if (talk.listening) return "Listening"
    if (talk.state === "thinking") return "Thinking"
    if (talk.state === "speaking") return "Speaking"
    // Errors get an actionable sentence (not a one-word state): tapping the mic
    // clears the error and retries, so the mic button doubles as Retry.
    if (talk.sttError) return "Didn't catch that — tap to retry"
    if (talk.ttsStatus.kind === "error") return talk.ttsStatus.message || "No voice output"
    if (talk.sttAvailable === false) return "Mic only"
    return "Tap to talk"
  })()

  return (
    <div
      data-state={talk.state}
      data-stage={stage}
      className="talk-root relative select-none"
      style={{
        background:
          "radial-gradient(125% 125% at 50% 34%, var(--bg-tertiary) 0%, var(--bg) 60%, var(--bg) 100%)",
        color: "var(--text-primary)",
      }}
    >
      {/* row 1: top bar */}
      <div className="talk-topbar">
        <Link
          to="/"
          aria-label="Back to Jinn"
          className="inline-flex h-9 items-center gap-1.5 rounded-full border border-[var(--separator)] bg-[var(--material-regular)] px-3 text-footnote text-[var(--text-secondary)] backdrop-blur-md transition-colors active:bg-[var(--fill-secondary)]"
        >
          <ArrowLeft size={15} /> Dock
        </Link>
        <span className="pointer-events-none select-none font-[family-name:var(--font-code)] text-[10px] uppercase tracking-[0.28em] text-[var(--text-tertiary)]">
          Jinn · Talk <span className="text-[var(--accent)]">// AURA</span>
        </span>
        <div className="flex items-center gap-2">
          {/* Session search — opens the search sheet (title + message FTS). */}
          <button
            onClick={() => setSearchOpen(true)}
            aria-label="Search sessions"
            title="Search sessions"
            className="inline-flex size-9 items-center justify-center rounded-full border border-[var(--separator)] bg-[var(--material-regular)] text-[var(--text-secondary)] backdrop-blur-md transition-colors active:bg-[var(--fill-secondary)]"
          >
            <Search size={16} />
          </button>
          {/* Engine/model picker — tiny gear, tucked beside the theme toggle. */}
          <TalkEnginePicker
            engineInfo={talk.engineInfo}
            onSwitchEngine={onSwitchEngine}
            onSwitchModel={talk.switchModel}
          />
          {/* Mute (silent/read mode) — icon-only, matches the gear + theme buttons. */}
          <button
            onClick={talk.toggleMute}
            aria-pressed={talk.muted}
            aria-label={talk.muted ? "Unmute" : "Mute"}
            title={talk.muted ? "Muted — replies are read, not spoken" : "Mute — silent/read mode"}
            className={cn(
              "inline-flex size-9 items-center justify-center rounded-full border backdrop-blur-md transition-colors",
              talk.muted
                ? "border-[var(--accent)] bg-[var(--accent-fill)] text-[var(--accent)]"
                : "border-[var(--separator)] bg-[var(--material-regular)] text-[var(--text-secondary)] active:bg-[var(--fill-secondary)]",
            )}
          >
            {talk.muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </button>
          <button
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
            aria-label="Toggle theme"
            className="inline-flex size-9 items-center justify-center rounded-full border border-[var(--separator)] bg-[var(--material-regular)] text-[var(--text-secondary)] backdrop-blur-md transition-colors active:bg-[var(--fill-secondary)]"
          >
            {theme === "light" ? <Moon size={16} /> : <Sun size={16} />}
          </button>
        </div>
      </div>

      {/* row 2: engage-attachment banner(s) — one slim strip per live engage
          soft link. The row collapses to zero height when empty. */}
      <div className="talk-banner-row">
        {showAttachBanner && (
          <AttachBanner graph={talk.graph} orchestratorId={talk.orchestratorId} />
        )}
      </div>

      {/* row 3: orb dock — reserves the docked orb's space; anchor + whisper.
          The orb itself is still the absolute CenteredOrb until Task 4. */}
      <div className="talk-orbdock" data-active={stage !== "hero"}>
        <div className="talk-orbdock__anchor" aria-hidden />
        {stage !== "hero" && talk.state === "thinking" && talk.whisper && (
          <p className="talk-whisper text-caption1 text-[var(--text-quaternary)]">{talk.whisper}</p>
        )}
      </div>

      {/* row 4: main — transcript stage + WorkDock rail */}
      <div className="talk-main">
        <div className="talk-stage">
          {/* Persistent conversation — user lines, AURA karaoke replies,
              delegation chips. Fills the stage cell; the wrapper is
              pointer-events:none and the scroll viewport + links/chips
              re-enable pointer-events. */}
          <ConversationStream
            rows={talk.rows}
            state={talk.state}
            onOpenThread={setChatSessionId}
            inlineCards={inlineCards}
            cardAnchorFor={talk.cardAnchorFor}
            onCardAction={talk.cardAction}
          />
        </div>
        <div className="talk-rail">
          {/* WorkDock — the single graph-driven work rail: one chip per depth-1
              node, mini-dots for employees, ⋯ menu for rename/dismiss/pin. */}
          <WorkDock
            graph={talk.graph}
            sideState={talk.sideState}
            targetThreadId={talk.targetThreadId}
            onOpenThread={setChatSessionId}
            onSelectTarget={talk.selectThread}
            onRename={talk.renameThread}
            onDismiss={talk.dismissThread}
            idle={talk.state === "idle"}
          />
        </div>
      </div>

      {/* row 5: pinned blocking cards — ONLY unresolved approval/choice cards,
          always reachable without scrolling the transcript. All other cards
          render INLINE in the stream. Row collapses when empty. */}
      {pinnedCards.length > 0 && (
        <div className="talk-pinned">
          {/* Fence the deck: a malformed card degrades to a small "card failed"
              note instead of unmounting the whole Talk app. Resets when the card
              set changes (orchestrator re-push / clear). */}
          <ErrorBoundary
            label="talk-cards"
            resetKey={pinnedCards.map((c) => c.id).join(",")}
            fallback={
              <div className="pointer-events-none rounded-[var(--radius-lg)] border border-[var(--separator)] bg-[var(--material-regular)] px-4 py-2 text-caption1 text-[var(--text-tertiary)] backdrop-blur-md">
                A card couldn’t be displayed.
              </div>
            }
          >
            <PinnedCards cards={pinnedCards} onAction={talk.cardAction} />
          </ErrorBoundary>
        </div>
      )}

      {/* row 6: bottom controls — a single big mic button + status hint */}
      <div className="talk-controls">
        {talk.state === "speaking" && !talk.muted && (
          <button
            onClick={talk.stopSpeaking}
            aria-label="Stop speaking"
            className="inline-flex h-8 items-center gap-1.5 rounded-full border border-[var(--separator)] bg-[var(--material-regular)] px-3 text-footnote text-[var(--text-secondary)] backdrop-blur-md transition-colors active:bg-[var(--fill-secondary)]"
          >
            <Square size={11} className="fill-current" /> Stop
          </button>
        )}
        {/* Transient "Switched to <engine>" marker after an engine re-bootstrap. */}
        {engineNotice && (
          <div className="rounded-full border border-[var(--separator)] bg-[var(--material-regular)] px-3 py-1 text-caption2 text-[var(--text-secondary)] backdrop-blur-md">
            {engineNotice}
          </div>
        )}
        <div className="flex items-center gap-2">
          <p className="text-caption1 text-[var(--text-quaternary)]">{hint}</p>
          {/* Neural-vs-fallback voice indicator (no "Muted" — the active top-right
              mute button already conveys silent mode). */}
          <TalkVoiceIndicator voiceMode={talk.voiceMode} />
        </div>

        {/* Type-to-talk: compact text input, revealed by the keyboard toggle.
            No separate send button — the main button below morphs into Send when
            this has text; Enter also sends. */}
        {typing && (
          <form
            onSubmit={(e) => { e.preventDefault(); submitText() }}
            className="w-full max-w-sm px-4"
          >
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Type a message to AURA…"
              aria-label="Type a message to AURA"
              className="h-10 w-full rounded-full border border-[var(--separator)] bg-[var(--material-regular)] px-4 text-footnote text-[var(--text-primary)] outline-none backdrop-blur-md placeholder:text-[var(--text-quaternary)] focus:border-[var(--accent)]"
            />
          </form>
        )}

        {/* One action-aware button: Mic ↔ Send ↔ Stop by context (see mainButtonMode). */}
        <button
          onClick={onMainButton}
          aria-label={mode === "send" ? "Send message" : mode === "stop" ? "Stop and send" : "Start talking"}
          className={cn(
            "inline-flex size-16 touch-manipulation items-center justify-center rounded-full shadow-[var(--shadow-overlay)] transition-all duration-200 active:scale-95",
            mode === "stop"
              ? "bg-[var(--system-red)] text-white"
              : "bg-[var(--accent)] text-[var(--accent-contrast)]",
          )}
        >
          {mode === "stop" ? (
            <Square size={22} className="fill-current" />
          ) : mode === "send" ? (
            <Send size={24} />
          ) : (
            <Mic size={26} />
          )}
        </button>

        {/* Secondary control: type-to-talk toggle (mute now lives in the top bar). */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setTyping((v) => !v)}
            aria-pressed={typing}
            aria-label="Type a message instead of talking"
            title="Type instead of talk"
            className={cn(
              "inline-flex size-8 items-center justify-center rounded-full border backdrop-blur-md transition-colors",
              typing
                ? "border-[var(--accent)] bg-[var(--accent-fill)] text-[var(--accent)]"
                : "border-[var(--separator)] bg-[var(--material-regular)] text-[var(--text-secondary)] active:bg-[var(--fill-secondary)]",
            )}
          >
            <Keyboard size={15} />
          </button>
        </div>
      </div>

      {/* The orchestrator orb — still the absolute overlay until Task 4 replaces
          it with the morphing OrbLayer. Whisper is null here: the dock-row
          whisper (row 3) replaces it in the thinking state. */}
      <CenteredOrb
        state={talk.state}
        level={talk.level}
        channelHue={talk.focusHue}
        whisper={null}
        conversing={talk.rows.length > 0 || talk.state !== "idle"}
      />

      {/* Peek popup for a tapped session (chip, orb, or search row) — now with
          attach controls + engage composer. */}
      <SessionPeek
        sessionId={chatSessionId}
        open={!!chatSessionId}
        onClose={() => setChatSessionId(null)}
      />

      {/* Session-search sheet (title + message FTS), opened from the top bar. */}
      <SessionSearchSheet
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onPeek={setChatSessionId}
      />

      {/* Whisper STT model-download — shown when the mic is tapped on a fresh
          install with no local model (same flow /chat uses). */}
      <WhisperDownloadModal
        open={talk.sttState === "no-model"}
        progress={talk.sttDownloadProgress}
        onDownload={talk.startSttDownload}
        onCancel={talk.dismissSttDownload}
      />
    </div>
  )
}

/**
 * The orchestrator orb, centered on the surface and sized to the viewport. Its
 * own container is pointer-events:none so taps fall through to the controls; the
 * orb morphs toward `channelHue` (the focused COO channel) and eases back to
 * AURA's amber when nothing is running.
 *
 * Choreography (Task 13): idle = large + centered; `conversing` = compact +
 * lifted (the shell eases up and the orb is sized smaller) so the conversation
 * stream and dock have room. While `thinking`, a short muted whisper of the
 * orchestrator's current tool_use sits just under the orb.
 */
function CenteredOrb({
  state,
  level,
  channelHue,
  whisper,
  conversing,
}: {
  state: ReturnType<typeof useTalkContext>["state"]
  level: number | undefined
  channelHue: number | undefined
  whisper: string | null
  conversing: boolean
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState(280)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const w = el.clientWidth
      const h = el.clientHeight
      const base = Math.min(w, h || w)
      // Compact while conversing so the orb reads as a calm presence behind the
      // stream rather than dominating; large + central when idle.
      const size = conversing
        ? Math.max(120, Math.min(base * 0.4, 210))
        : Math.max(160, Math.min(base * 0.6, 360))
      setSize(size)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [conversing])
  return (
    <div
      ref={ref}
      className={cn(
        "talk-orb-shell pointer-events-none absolute inset-0 z-0 grid place-items-center",
        conversing && "talk-orb-shell--conversing",
      )}
    >
      <div className="flex flex-col items-center gap-2">
        <AuraAvatar state={state} level={level} size={Math.round(size)} channelHue={channelHue} />
        {state === "thinking" && whisper && (
          <p className="talk-whisper text-caption1 text-[var(--text-quaternary)]">{whisper}</p>
        )}
      </div>
    </div>
  )
}
