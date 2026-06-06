/**
 * Jinn Talk — /talk route (AURA voice surface).
 *
 * Mobile-first. The orchestrator orb sits center; when it spawns COO child
 * sessions they appear as satellite orbs (see Constellation). One big mic button
 * drives the loop (tap to talk, tap to send). TTS is browser SpeechSynthesis by
 * default, so it speaks aloud on the phone with no server deps.
 */
import { useCallback } from "react"
import { Link } from "react-router-dom"
import { ArrowLeft, Mic, Square, Sun, Moon } from "lucide-react"
import { cn } from "@/lib/utils"
import { useTheme } from "@/routes/providers"
import { Constellation } from "./constellation"
import { Transcript } from "./transcript"
import { CardStack } from "./cards/card-stack"
import { ThreadPanel } from "./thread-panel"
import { useTalk } from "./use-talk"

export default function TalkPage() {
  const { theme, setTheme } = useTheme()
  const talk = useTalk()

  const isRecording = talk.listening

  const onMic = useCallback(() => {
    if (talk.listening) talk.stop()
    else talk.startListening()
  }, [talk])

  const hint = (() => {
    if (!talk.connected) return "Connecting to Jinn…"
    if (talk.listening) return "Listening… tap to send"
    if (talk.state === "thinking") return "Thinking…"
    if (talk.state === "speaking") return "Speaking…"
    if (talk.ttsStatus.kind === "error") return "Voice output unavailable on this device"
    if (talk.sttAvailable === false) return "Speech-to-text not installed — mic shows visual only"
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
        <button
          onClick={() => setTheme(theme === "light" ? "dark" : "light")}
          aria-label="Toggle theme"
          className="inline-flex size-9 items-center justify-center rounded-full border border-[var(--separator)] bg-[var(--material-regular)] text-[var(--text-secondary)] backdrop-blur-md transition-colors active:bg-[var(--fill-secondary)]"
        >
          {theme === "light" ? <Moon size={16} /> : <Sun size={16} />}
        </button>
      </div>

      {/* Transcript overlay (upper area) */}
      <div className="pointer-events-none absolute inset-x-0 top-[12%] z-20 flex justify-center px-5">
        <Transcript entries={talk.entries} />
      </div>

      {/* The constellation fills the surface: orchestrator + COO satellites */}
      <Constellation state={talk.state} level={talk.level} threads={talk.threads} />

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
          <CardStack cards={talk.cards} />
        </div>
      )}

      {/* Bottom control: a single big mic button + status hint */}
      <div
        className="absolute inset-x-0 bottom-0 z-30 flex flex-col items-center gap-3"
        style={{ paddingBottom: "max(env(safe-area-inset-bottom), 22px)" }}
      >
        <p className="text-caption1 text-[var(--text-quaternary)]">{hint}</p>
        <button
          onClick={onMic}
          aria-label={isRecording ? "Stop and send" : "Start talking"}
          className={cn(
            "inline-flex size-16 touch-manipulation items-center justify-center rounded-full shadow-[var(--shadow-overlay)] transition-all duration-200 active:scale-95",
            isRecording
              ? "bg-[var(--system-red)] text-white"
              : "bg-[var(--accent)] text-[var(--accent-contrast)]",
          )}
        >
          {isRecording ? <Square size={22} className="fill-current" /> : <Mic size={26} />}
        </button>
      </div>
    </div>
  )
}
