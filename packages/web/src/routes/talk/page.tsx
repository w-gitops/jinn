/**
 * Jinn Talk — /talk route (AURA voice surface).
 *
 * Mobile-first. The orchestrator orb sits center; when it spawns COO child
 * sessions they appear as satellite orbs (see Constellation). One big mic button
 * drives the loop (tap to talk, tap to send). TTS is browser SpeechSynthesis by
 * default, so it speaks aloud on the phone with no server deps.
 */
import { useCallback, useEffect, useState } from "react"
import { Link } from "react-router-dom"
import { ArrowLeft, Mic, Square, Sun, Moon, Keyboard, Volume2, VolumeX, Send } from "lucide-react"
import { cn } from "@/lib/utils"
import { mainButtonMode } from "./main-button"
import { useTheme } from "@/routes/providers"
import { Constellation } from "./constellation"
import { ConversationStream } from "./conversation-stream"
import { CardStack } from "./cards/card-stack"
import { ErrorBoundary } from "@/components/error-boundary"
import { ThreadPanel } from "./thread-panel"
import { ChildSessionModal } from "./child-session-modal"
import { TalkEnginePicker } from "./talk-engine-picker"
import { TalkVoiceIndicator } from "./talk-voice-indicator"
import { WhisperDownloadModal } from "@/components/stt/whisper-download-modal"
import { useTalkContext } from "./talk-provider"

export default function TalkPage() {
  const { theme, setTheme } = useTheme()
  // State lives in TalkProvider (above the router) so it survives navigation;
  // activate() kicks off the (gated) bootstrap the first time Talk is opened.
  const talk = useTalkContext()
  const { activate } = talk
  useEffect(() => { activate() }, [activate])
  // Which COO child session's chat the modal is showing (null → closed).
  const [chatSessionId, setChatSessionId] = useState<string | null>(null)
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
      className="relative h-dvh w-full select-none overflow-hidden"
      style={{
        background:
          "radial-gradient(125% 125% at 50% 34%, var(--bg-tertiary) 0%, var(--bg) 60%, var(--bg) 100%)",
        color: "var(--text-primary)",
      }}
    >
      {/* Top bar */}
      <div
        className="absolute inset-x-0 top-0 z-30 flex items-center justify-between px-4"
        style={{ paddingTop: "max(env(safe-area-inset-top), 14px)" }}
      >
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

      {/* Persistent conversation — user lines, AURA karaoke replies, delegation
          chips. Replaces the old single-exchange transcript + hidden history rail.
          Container is pointer-events:none; its scroll viewport + links/chips
          re-enable pointer-events so the orb stays tappable through the margins. */}
      <ConversationStream
        rows={talk.rows}
        state={talk.state}
        onOpenThread={setChatSessionId}
      />

      {/* The constellation fills the surface: orchestrator + COO satellites */}
      <Constellation
        state={talk.state}
        level={talk.level}
        threads={talk.threads}
        graph={talk.graph}
        onOpenSession={setChatSessionId}
      />

      {/* COO thread panel — visibility + manual switch/rename/dismiss. Top-left,
          below the bar, so it never fights the orb, mic, or cards. */}
      <div
        className="absolute left-3 z-20"
        style={{ top: "calc(max(env(safe-area-inset-top), 14px) + 46px)" }}
      >
        <ThreadPanel
          threads={talk.threads}
          targetThreadId={talk.targetThreadId}
          onSelect={talk.selectThread}
          onRename={talk.renameThread}
          onDismiss={talk.dismissThread}
          onOpenSession={setChatSessionId}
        />
      </div>

      {/* Detail cards — a lower band that sits below the orb centre and above the
          mic so it never covers the avatar or the control on mobile. The deck is
          pointer-events:none (links re-enable themselves); cards drift in/out. */}
      {talk.cards.length > 0 && (
        <div
          className="pointer-events-none absolute inset-x-0 z-20 flex items-end justify-center overflow-hidden px-4"
          style={{
            bottom: "calc(max(env(safe-area-inset-bottom), 22px) + 96px)",
            maxHeight: "46dvh",
          }}
        >
          {/* Fence the deck: a malformed card degrades to a small "card failed"
              note instead of unmounting the whole Talk app. Resets when the card
              set changes (orchestrator re-push / clear). */}
          <ErrorBoundary
            label="talk-cards"
            resetKey={talk.cards.map((c) => c.id).join(",")}
            fallback={
              <div className="pointer-events-none rounded-[var(--radius-lg)] border border-[var(--separator)] bg-[var(--material-regular)] px-4 py-2 text-caption1 text-[var(--text-tertiary)] backdrop-blur-md">
                A card couldn’t be displayed.
              </div>
            }
          >
            <CardStack cards={talk.cards} onAction={talk.cardAction} />
          </ErrorBoundary>
        </div>
      )}

      {/* Bottom control: a single big mic button + status hint */}
      <div
        className="absolute inset-x-0 bottom-0 z-30 flex flex-col items-center gap-3"
        style={{ paddingBottom: "max(env(safe-area-inset-bottom), 22px)" }}
      >
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

      {/* Read-only chat popup for a tapped COO child session (chip or orb). */}
      <ChildSessionModal
        sessionId={chatSessionId}
        open={!!chatSessionId}
        onClose={() => setChatSessionId(null)}
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
