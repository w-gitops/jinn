import { useCallback, useEffect, useRef, useState } from 'react'

/* ── AudioContext singleton ──────────────────────────────────────────────────
 * One context per page, created lazily on the first user gesture.
 * Suspended contexts are resumed on every acquire (Safari post-focus).
 * ─────────────────────────────────────────────────────────────────────────── */

let _sharedCtx: AudioContext | null = null

function acquireAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  if (!_sharedCtx) {
    try { _sharedCtx = new Ctor() } catch { return null }
  }
  if (_sharedCtx.state === 'suspended') _sharedCtx.resume().catch(() => {})
  return _sharedCtx
}

/* ── Markdown stripper ───────────────────────────────────────────────────────
 * Strip markup that should not be spoken. Applied client-side before sending
 * manual-read requests so the TTS backend receives clean prose.
 * ─────────────────────────────────────────────────────────────────────────── */

export function stripForTts(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')            // fenced code blocks
    .replace(/`[^`]+`/g, ' ')                   // inline code
    .replace(/\*\*(.+?)\*\*/g, '$1')            // bold → keep text
    .replace(/\*(.+?)\*/g, '$1')                // italic → keep text
    .replace(/^#{1,6} /gm, '')                  // heading markers
    .replace(/!?\[([^\]]*)\]\([^)]+\)/g, '$1')  // links / images → label only
    .replace(/\s+/g, ' ')
    .trim()
}

/* ── Gateway WebSocket contract ──────────────────────────────────────────────
 *
 * Endpoint: /ws/tts/:sessionId
 *
 * Client → Server (JSON):
 *   {type:"tts:prefs",  autoRead:boolean}  — sent on connect and on toggle
 *   {type:"tts:speak",  text:string}        — manual one-shot synthesis
 *   {type:"tts:barge"}                      — cancel in-flight synthesis
 *
 * Server → Client:
 *   ArrayBuffer                             — one MP3 per completed sentence
 *   {type:"tts:done"}                       — utterance synthesis complete
 *   {type:"tts:barged"}                     — server confirmed cancellation
 *
 * The WS being open signals the session has an active TTS listener. The server
 * auto-synthesizes the stream only when the latest tts:prefs has autoRead:true.
 * ─────────────────────────────────────────────────────────────────────────── */

/* ── Public API ─────────────────────────────────────────────────────────────── */

export interface UseTtsReturn {
  speaking: boolean
  speakingId: string | null
  autoRead: boolean
  connected: boolean
  readMessage: (text: string, messageId: string) => void
  stopSpeaking: () => void
  toggleAutoRead: () => void
}

const AUTO_READ_KEY = 'jinn-tts-auto-read'

export function useTts(sessionId: string | null): UseTtsReturn {
  const [speaking, setSpeaking]     = useState(false)
  const [speakingId, setSpeakingId] = useState<string | null>(null)
  const [connected, setConnected]   = useState(false)
  const [autoRead, setAutoRead]     = useState(() => {
    try { return localStorage.getItem(AUTO_READ_KEY) === 'true' } catch { return false }
  })

  // All mutable playback state in refs so callbacks don't grow stale.
  const wsRef         = useRef<WebSocket | null>(null)
  const audioQRef     = useRef<AudioBuffer[]>([])
  const activeSrcRef  = useRef<AudioBufferSourceNode | null>(null)
  const playingRef    = useRef(false)
  const cancelRef     = useRef(false)
  const autoReadRef   = useRef(autoRead)
  const sessionIdRef  = useRef(sessionId)
  const speakingIdRef = useRef<string | null>(null)

  useEffect(() => { autoReadRef.current  = autoRead  }, [autoRead])
  useEffect(() => { sessionIdRef.current = sessionId }, [sessionId])

  /* ── Consumer ───────────────────────────────────────────────────────────── */
  // useCallback with [] is stable: all mutable reads go through refs;
  // setSpeaking/setSpeakingId are stable dispatch functions.
  const consume = useCallback(() => {
    if (cancelRef.current) return
    const ctx = acquireAudioContext()
    if (!ctx || audioQRef.current.length === 0) {
      playingRef.current = false
      setSpeaking(false)
      speakingIdRef.current = null
      setSpeakingId(null)
      return
    }
    const buf = audioQRef.current.shift()!
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.connect(ctx.destination)
    activeSrcRef.current = src
    setSpeaking(true)
    playingRef.current = true
    src.onended = () => {
      activeSrcRef.current = null
      consume()
    }
    try { src.start() } catch { consume() }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ── Producer: decode MP3 frame and wake consumer ────────────────────────── */
  const enqueue = useCallback(async (raw: ArrayBuffer) => {
    const ctx = acquireAudioContext()
    if (!ctx || cancelRef.current) return
    try {
      const buf = await ctx.decodeAudioData(raw.slice(0))
      audioQRef.current.push(buf)
      if (!playingRef.current) consume()
    } catch { /* partial or corrupted frame — skip silently */ }
  }, [consume])

  /* ── Stop / barge-in ────────────────────────────────────────────────────── */
  const stopSpeaking = useCallback(() => {
    cancelRef.current = true
    audioQRef.current = []
    if (activeSrcRef.current) {
      try { activeSrcRef.current.stop() } catch {}
      activeSrcRef.current = null
    }
    playingRef.current = false
    setSpeaking(false)
    speakingIdRef.current = null
    setSpeakingId(null)
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'tts:barge' }))
    }
    // Reset after a tick so audio arriving immediately after the barge can play.
    setTimeout(() => { cancelRef.current = false }, 50)
  }, [])

  /* ── WebSocket factory ──────────────────────────────────────────────────── */
  const openWs = useCallback((sid: string, onReady?: (ws: WebSocket) => void) => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${window.location.host}/ws/tts/${encodeURIComponent(sid)}`)
    ws.binaryType = 'arraybuffer'

    ws.onopen = () => {
      setConnected(true)
      ws.send(JSON.stringify({ type: 'tts:prefs', autoRead: autoReadRef.current }))
      onReady?.(ws)
    }
    ws.onclose = () => {
      setConnected(false)
      if (wsRef.current === ws) wsRef.current = null
    }
    ws.onerror = () => ws.close()
    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer && event.data.byteLength > 0) {
        enqueue(event.data)
      }
      // JSON control frames (tts:done, tts:barged) require no client action —
      // local state is already correct from stopSpeaking() or consumer draining.
    }

    return ws
  }, [enqueue])

  /* ── Persistent WS lifecycle ────────────────────────────────────────────── */
  useEffect(() => {
    if (!sessionId) {
      wsRef.current?.close()
      wsRef.current = null
      return
    }
    const ws = openWs(sessionId)
    wsRef.current = ws
    return () => { ws.close() }
  }, [sessionId, openWs])

  // Push updated autoRead preference to the server without reconnecting.
  useEffect(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'tts:prefs', autoRead }))
    }
  }, [autoRead])

  /* ── Manual read ────────────────────────────────────────────────────────── */
  const readMessage = useCallback((text: string, messageId: string) => {
    // Unlock AudioContext on the gesture that triggered this call.
    acquireAudioContext()

    if (playingRef.current || speakingIdRef.current) stopSpeaking()

    const clean = stripForTts(text)
    if (!clean) return

    speakingIdRef.current = messageId
    setSpeakingId(messageId)

    const send = (ws: WebSocket) =>
      ws.send(JSON.stringify({ type: 'tts:speak', text: clean }))

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      send(wsRef.current)
    } else {
      const sid = sessionIdRef.current
      if (!sid) return
      // WS not yet open (race on mount or autoRead was off) — open on-demand.
      const ws = openWs(sid, send)
      wsRef.current = ws
    }
  }, [stopSpeaking, openWs])

  /* ── Toggle autoRead ────────────────────────────────────────────────────── */
  const toggleAutoRead = useCallback(() => {
    setAutoRead((prev) => {
      const next = !prev
      try { localStorage.setItem(AUTO_READ_KEY, String(next)) } catch {}
      if (!next) stopSpeaking()
      return next
    })
  }, [stopSpeaking])

  return { speaking, speakingId, autoRead, connected, readMessage, stopSpeaking, toggleAutoRead }
}
