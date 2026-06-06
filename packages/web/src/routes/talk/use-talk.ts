/**
 * Jinn Talk — real voice-loop hook (Path 1).
 *
 * The voice orchestrator is a REAL gateway session (source:"talk"). Loop:
 *   mic → useStt → POST /api/sessions/{orchestratorId}/message
 *        → the orchestrator streams its reply as session:delta `text` (caption)
 *          and is spoken aloud. TTS is browser SpeechSynthesis by default (works
 *          on iOS/Android, no server deps); if the gateway ever streams Kokoro
 *          audio (talk:audio) we prefer that instead.
 *        → when it delegates to a COO child, the gateway emits talk:focus; we
 *          track that child so the UI can render it as a satellite orb.
 *        → when a COO child finishes, the orchestrator is woken (📩) and narrates
 *          — another session:delta + spoken turn.
 *
 * Mic control is plain tap-to-talk: tap the mic to start listening, tap again to
 * send. After a reply is spoken the loop returns to idle and waits for the next tap.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useGateway } from "@/hooks/use-gateway"
import { useStt } from "@/hooks/use-stt"
import { useSpeak } from "./use-speak"
import { api } from "@/lib/api"
import { TalkAudioPlayer } from "./audio-player"
import {
  TALK_EVENTS,
  type TalkAudioEvent,
  type TalkFocusEvent,
  type TalkThreadLabelEvent,
  type TalkCardEvent,
  type TalkCardUpdateEvent,
  type TalkCardDismissEvent,
  type SessionDeltaEvent,
  type SessionCompletedEvent,
} from "./protocol"
import type { TranscriptEntry } from "./transcript"
import type { AvatarState, Card } from "./types"
import { threadReducer, type TalkThread, type ThreadAction } from "./thread-store"

export type { TalkThread } from "./thread-store"

/** Most recent cards kept on the surface at once (older ones drift out). */
const MAX_CARDS = 4

/** How long a finished COO thread keeps orbiting (as a satellite) before parking. */
const THREAD_PARK_MS = 4500

export type TtsStatus =
  | { kind: "idle" }
  | { kind: "downloading"; progress: number }
  | { kind: "ready" }
  | { kind: "error"; message: string }

export interface UseTalkReturn {
  state: AvatarState
  entries: TranscriptEntry[]
  /** Persistent COO threads (satellite orbs + the thread panel). */
  threads: TalkThread[]
  /** The thread the next dispatch is routed to continue (null → new thread). */
  targetThreadId: string | null
  /** Detail cards the orchestrator pushed for the current answer(s). */
  cards: Card[]
  /** 0..1 while listening/speaking (server audio), undefined → orb self-animates. */
  level: number | undefined
  connected: boolean
  listening: boolean
  sttAvailable: boolean | null
  ttsStatus: TtsStatus
  /** Route the next dispatch to continue an existing thread (null → new). */
  selectThread: (id: string | null) => void
  /** Rename a thread's topic label (UI-only). */
  renameThread: (id: string, label: string) => void
  /** Remove a thread chip (does not kill the gateway session). */
  dismissThread: (id: string) => void
  startListening: () => void
  stop: () => void
}

export function useTalk(): UseTalkReturn {
  const gateway = useGateway()

  const [state, setState] = useState<AvatarState>("idle")
  const [entries, setEntries] = useState<TranscriptEntry[]>([])
  const [threads, setThreads] = useState<TalkThread[]>([])
  const [targetThreadId, setTargetThreadId] = useState<string | null>(null)
  const [cards, setCards] = useState<Card[]>([])
  const [level, setLevel] = useState<number | undefined>(undefined)
  const [ttsStatus, setTtsStatus] = useState<TtsStatus>({ kind: "idle" })

  const [orchestratorId, setOrchestratorId] = useState<string | null>(null)
  const orchestratorIdRef = useRef<string | null>(null)
  orchestratorIdRef.current = orchestratorId

  const playerRef = useRef<TalkAudioPlayer | null>(null)
  if (!playerRef.current) playerRef.current = new TalkAudioPlayer()

  const speak = useSpeak()
  const speakRef = useRef(speak)
  speakRef.current = speak

  const levelRafRef = useRef<number>(0)
  const levelModeRef = useRef<"mic" | "output" | null>(null)
  const turnSeqRef = useRef(0)

  // Per-turn assistant bubble + accumulated text (for Web Speech on completion).
  const asstIdRef = useRef<string | null>(null)
  const turnTextRef = useRef("")
  const turnCounterRef = useRef(0)
  // Did the gateway stream Kokoro audio this turn? If so we DON'T also Web-Speak.
  const audioThisTurnRef = useRef(false)
  // Known COO thread (child) session ids so we can route their stream events.
  // Synced from `threads` each render AND added immediately on focus (so a child
  // delta arriving the same tick as focus still routes).
  const threadIdsRef = useRef<Set<string>>(new Set())
  threadIdsRef.current = new Set(threads.map((t) => t.id))
  // Pending park timers (finished thread keeps orbiting briefly, then parks).
  const parkTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  // Live mirrors for WS-callback / send closures.
  const threadsRef = useRef<TalkThread[]>(threads)
  threadsRef.current = threads
  const targetThreadIdRef = useRef<string | null>(targetThreadId)
  targetThreadIdRef.current = targetThreadId

  const stt = useStt()
  const sttRef = useRef(stt)
  sttRef.current = stt

  // ---- Level rAF loop (mic listening OR server-audio output) ---------------
  const stopLevelLoop = useCallback(() => {
    if (levelRafRef.current) {
      cancelAnimationFrame(levelRafRef.current)
      levelRafRef.current = 0
    }
    levelModeRef.current = null
    setLevel(undefined)
  }, [])

  const startLevelLoop = useCallback((mode: "mic" | "output") => {
    if (levelRafRef.current && levelModeRef.current === mode) return
    if (levelRafRef.current) cancelAnimationFrame(levelRafRef.current)
    levelModeRef.current = mode
    const tick = () => {
      if (mode === "mic") {
        const analyser = sttRef.current.analyser
        if (analyser) {
          const buf = new Uint8Array(analyser.fftSize)
          analyser.getByteTimeDomainData(buf)
          let sum = 0
          for (let i = 0; i < buf.length; i++) {
            const v = (buf[i] - 128) / 128
            sum += v * v
          }
          const rms = Math.sqrt(sum / buf.length)
          setLevel(Math.min(1, rms * 3.2))
        } else setLevel(undefined)
      } else {
        const player = playerRef.current
        setLevel(player && player.playing ? player.level : undefined)
      }
      levelRafRef.current = requestAnimationFrame(tick)
    }
    levelRafRef.current = requestAnimationFrame(tick)
  }, [])

  // ---- Transcript helpers --------------------------------------------------
  const appendAssistantText = useCallback((fragment: string) => {
    setEntries((prev) => {
      if (!asstIdRef.current) {
        turnCounterRef.current += 1
        asstIdRef.current = `a${turnCounterRef.current}`
        turnTextRef.current = ""
      }
      const id = asstIdRef.current
      turnTextRef.current += fragment
      const existing = prev.find((e) => e.id === id)
      const merged = existing ? existing.text + fragment : fragment
      return [...prev.filter((e) => e.id !== id), { id, role: "assistant", text: merged, partial: true }]
    })
  }, [])

  // ---- COO thread bookkeeping ----------------------------------------------
  // Threads persist (the panel + switching surface). A finished thread keeps
  // orbiting as a satellite for THREAD_PARK_MS, then parks (drops from the orb
  // constellation but STAYS in the thread list).
  const dispatchThread = useCallback((a: ThreadAction) => {
    setThreads((prev) => threadReducer(prev, a))
  }, [])

  const schedulePark = useCallback((id: string) => {
    const existing = parkTimers.current.get(id)
    if (existing) clearTimeout(existing)
    const t = setTimeout(() => {
      parkTimers.current.delete(id)
      setThreads((prev) => threadReducer(prev, { type: "park", id }))
    }, THREAD_PARK_MS)
    parkTimers.current.set(id, t)
  }, [])

  // ---- Thread controls (panel) ---------------------------------------------
  const selectThread = useCallback((id: string | null) => setTargetThreadId(id), [])
  const renameThread = useCallback((id: string, label: string) => {
    if (label.trim()) dispatchThread({ type: "label", id, label })
  }, [dispatchThread])
  const dismissThread = useCallback((id: string) => {
    const tmr = parkTimers.current.get(id)
    if (tmr) { clearTimeout(tmr); parkTimers.current.delete(id) }
    dispatchThread({ type: "dismiss", id })
    setTargetThreadId((cur) => (cur === id ? null : cur))
  }, [dispatchThread])

  // ---- Detail-card surface (orchestrator pushes via POST /api/talk/card) ----
  // talk:card upserts by id (re-posting the same id updates it in place);
  // talk:card:update patches one card; :dismiss drops one; :clear wipes all.
  const upsertCard = useCallback((card: Card) => {
    setCards((prev) => {
      const i = prev.findIndex((c) => c.id === card.id)
      if (i !== -1) {
        const next = prev.slice()
        next[i] = card
        return next
      }
      const next = [...prev, card]
      return next.length > MAX_CARDS ? next.slice(next.length - MAX_CARDS) : next
    })
  }, [])

  const patchCard = useCallback((id: string, patch: Partial<Card>) => {
    setCards((prev) => prev.map((c) => (c.id === id ? ({ ...c, ...patch } as Card) : c)))
  }, [])

  const dismissCard = useCallback((id: string) => {
    setCards((prev) => prev.filter((c) => c.id !== id))
  }, [])

  const clearCards = useCallback(() => setCards([]), [])

  // ---- WS subscription -----------------------------------------------------
  useEffect(() => {
    const player = playerRef.current!
    player.onIdle(() => {
      setState((s) => (s === "speaking" ? "idle" : s))
      stopLevelLoop()
    })

    const sid = (p: unknown): string | undefined =>
      typeof p === "object" && p !== null ? (p as { sessionId?: string }).sessionId : undefined

    const GLOBAL_TTS = new Set<string>([
      TALK_EVENTS.ttsDownloadProgress,
      TALK_EVENTS.ttsDownloadComplete,
      TALK_EVENTS.ttsDownloadError,
    ])

    const speakReplyIfNeeded = () => {
      const text = turnTextRef.current.trim()
      if (audioThisTurnRef.current) {
        // Kokoro audio is playing; player.onIdle will settle.
        setState("speaking")
      } else if (text && speakRef.current.supported) {
        setState("speaking")
        speakRef.current
          .speak(text)
          .then(() => { setState((s) => (s === "speaking" ? "idle" : s)) })
          .catch(() => { setState((s) => (s === "speaking" ? "idle" : s)) })
      } else {
        setState("idle")
        stopLevelLoop()
      }
      audioThisTurnRef.current = false
    }

    const unsub = gateway.subscribe((event: string, payload: unknown) => {
      if (GLOBAL_TTS.has(event)) {
        if (event === TALK_EVENTS.ttsDownloadProgress) setTtsStatus({ kind: "downloading", progress: (payload as { progress?: number }).progress ?? 0 })
        else if (event === TALK_EVENTS.ttsDownloadComplete) setTtsStatus({ kind: "ready" })
        else setTtsStatus({ kind: "error", message: (payload as { error?: string }).error ?? "TTS error" })
        return
      }

      if (event === TALK_EVENTS.focus) {
        const ev = payload as TalkFocusEvent
        if (ev.parentId === orchestratorIdRef.current) {
          threadIdsRef.current.add(ev.cooId) // route this child's stream immediately
          const t = parkTimers.current.get(ev.cooId)
          if (t) { clearTimeout(t); parkTimers.current.delete(ev.cooId) }
          dispatchThread({ type: "focus", id: ev.cooId, label: ev.label, ts: Date.now() })
        }
        return
      }

      if (event === TALK_EVENTS.threadLabel) {
        const ev = payload as TalkThreadLabelEvent
        if (ev.sessionId === orchestratorIdRef.current) {
          dispatchThread({ type: "label", id: ev.threadId, label: ev.label })
        }
        return
      }

      const s = sid(payload)
      const isOrch = s === orchestratorIdRef.current
      const isChild = s !== undefined && threadIdsRef.current.has(s)

      switch (event) {
        case "session:delta": {
          const ev = payload as SessionDeltaEvent
          if (isOrch) {
            if (ev.type === "text" && typeof ev.content === "string" && ev.content) {
              appendAssistantText(ev.content)
              setState((st) => (st === "speaking" ? st : "thinking"))
            }
          } else if (isChild && s) {
            dispatchThread({ type: "activity", id: s, ts: Date.now() }) // keep alive/working
          }
          break
        }
        case TALK_EVENTS.audio: {
          if (!isOrch) break
          const ev = payload as TalkAudioEvent
          audioThisTurnRef.current = true
          player.enqueue(ev.seq, ev.mime, ev.dataBase64)
          setState("speaking")
          startLevelLoop("output")
          break
        }
        case TALK_EVENTS.card: {
          if (!isOrch) break
          upsertCard((payload as TalkCardEvent).card)
          break
        }
        case TALK_EVENTS.cardUpdate: {
          if (!isOrch) break
          const ev = payload as TalkCardUpdateEvent
          patchCard(ev.cardId, ev.patch)
          break
        }
        case TALK_EVENTS.cardDismiss: {
          if (!isOrch) break
          dismissCard((payload as TalkCardDismissEvent).cardId)
          break
        }
        case TALK_EVENTS.cardClear: {
          if (!isOrch) break
          clearCards()
          break
        }
        case "session:completed": {
          void (payload as SessionCompletedEvent)
          if (isOrch) {
            setEntries((prev) => prev.map((e) => (e.id === asstIdRef.current ? { ...e, partial: false } : e)))
            asstIdRef.current = null
            speakReplyIfNeeded()
          } else if (isChild && s) {
            dispatchThread({ type: "done", id: s, ts: Date.now() })
            schedulePark(s)
          }
          break
        }
      }
    })

    return () => { unsub() }
  }, [gateway, appendAssistantText, dispatchThread, schedulePark, startLevelLoop, stopLevelLoop, upsertCard, patchCard, dismissCard, clearCards])

  // ---- Bootstrap orchestrator + probe TTS ----------------------------------
  useEffect(() => {
    let alive = true
    api.talkCreateSession()
      .then((r) => { if (alive) setOrchestratorId(r.sessionId) })
      .catch(() => { /* surfaced via connection hint */ })
    api.talkStatus()
      .then((s) => {
        if (!alive) return
        if (s.downloading) setTtsStatus({ kind: "downloading", progress: s.progress ?? 0 })
        else if (s.ttsAvailable) setTtsStatus({ kind: "ready" })
        else setTtsStatus({ kind: "idle" })
      })
      .catch(() => {})
    return () => { alive = false }
  }, [])

  // ---- Mic control (plain tap-to-talk) -------------------------------------
  const startListening = useCallback(() => {
    playerRef.current?.resume()
    // Unlock browser TTS within the user gesture (iOS Safari requires this, or
    // the post-network reply is silently blocked).
    try { speakRef.current.prime() } catch { /* noop */ }
    setState("listening")
    startLevelLoop("mic")
    void sttRef.current.handleMicClick()
  }, [startLevelLoop])

  const stop = useCallback(async () => {
    turnSeqRef.current++
    const seq = turnSeqRef.current
    const s = sttRef.current
    if (s.state === "recording") {
      setState("thinking")
      const text = await s.stopRecording()
      if (turnSeqRef.current !== seq) return
      const orch = orchestratorIdRef.current
      if (text && text.trim() && orch) {
        setEntries((prev) => [...prev, { id: `u${Date.now()}`, role: "user", text }])
        // Switch override: if a thread is selected, prepend a machine route hint so
        // the orchestrator CONTINUES that COO session instead of spawning a new one.
        // The transcript keeps the clean text; only the engine sees the hint.
        const target = targetThreadIdRef.current
          ? threadsRef.current.find((t) => t.id === targetThreadIdRef.current)
          : null
        const outbound = target
          ? `[Route this to the existing "${target.label}" COO thread: session ${target.id}. Continue that thread instead of spawning a new one.]\n${text}`
          : text
        try {
          await api.sendMessage(orch, { message: outbound })
        } catch {
          setState("idle"); stopLevelLoop()
        }
      } else {
        // Empty/failed transcription — return to idle and wait for the next tap.
        setState("idle"); stopLevelLoop()
      }
    } else {
      s.cancelRecording()
      playerRef.current?.reset()
      setState("idle"); stopLevelLoop()
    }
  }, [stopLevelLoop])

  // ---- Cleanup -------------------------------------------------------------
  useEffect(() => {
    return () => {
      if (levelRafRef.current) cancelAnimationFrame(levelRafRef.current)
      for (const t of parkTimers.current.values()) clearTimeout(t)
      parkTimers.current.clear()
      try { speakRef.current.cancel() } catch { /* noop */ }
      playerRef.current?.dispose()
      playerRef.current = null
    }
  }, [])

  const listening = stt.state === "recording"

  return useMemo(
    () => ({
      state, entries, threads, targetThreadId, cards, level,
      connected: gateway.connected,
      listening,
      sttAvailable: stt.available,
      ttsStatus,
      selectThread, renameThread, dismissThread,
      startListening, stop,
    }),
    [state, entries, threads, targetThreadId, cards, level, gateway.connected, listening, stt.available, ttsStatus, selectThread, renameThread, dismissThread, startListening, stop],
  )
}
