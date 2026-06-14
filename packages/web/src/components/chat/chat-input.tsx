import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { api } from '@/lib/api'
import type { MediaAttachment } from '@/lib/conversations'
import { MediaPreview } from './media-preview'
import { useStt } from '@/hooks/use-stt'
import { WhisperDownloadModal } from '@/components/stt/whisper-download-modal'
import { MicWaveform } from './mic-waveform'
import { EmployeeAvatar } from '@/components/ui/employee-avatar'

/** Hold threshold (ms) that separates a quick tap from a tap-and-hold. */
export const MIC_HOLD_THRESHOLD_MS = 250

export type MicGesture = 'hold' | 'tap'

/**
 * Pure classifier for the mic button gesture. A press held for at least
 * `threshold` ms is a push-to-talk hold; anything shorter is a quick tap.
 * Exported for unit testing.
 */
export function classifyMicGesture(
  downAt: number,
  upAt: number,
  threshold: number = MIC_HOLD_THRESHOLD_MS,
): MicGesture {
  return upAt - downAt >= threshold ? 'hold' : 'tap'
}

interface Employee {
  name: string
  displayName?: string
  department?: string
  rank?: string
  engine?: string
}

interface SlashCommand {
  name: string
  description: string
  /** Whether this command needs an @employee argument */
  needsEmployee?: boolean
}

/** Built-in commands handled client-side (not sent to engine) */
const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: 'new', description: 'Start a new chat session' },
  { name: 'status', description: 'Show current session info' },
]

interface ChatInputProps {
  disabled: boolean
  loading: boolean
  onSend: (message: string, media?: MediaAttachment[], interrupt?: boolean) => void
  onInterrupt?: () => void
  onNewSession: () => void
  onStatusRequest: () => void
  /** Incremented when skills change on the gateway, triggers re-fetch */
  skillsVersion?: number
  /** WebSocket events from useGateway — needed for STT download progress */
  events?: Array<{ event: string; payload: unknown }>
  /** Files dropped onto the chat area (from parent drag & drop) */
  droppedFiles?: File[]
  /** Called after droppedFiles have been consumed as pending attachments */
  onDroppedFilesConsumed?: () => void
  /** Incrementing counter that triggers textarea focus when changed */
  focusTrigger?: number
  /** Callback to open keyboard shortcuts overlay */
  onShortcutsClick?: () => void
  /** Optional Engine/Model/Effort selector row, rendered just above the input. */
  selectorSlot?: React.ReactNode
  /** Optional compact terminal controls rendered with the helper hints on desktop. */
  terminalActionsSlot?: React.ReactNode
  /** Optional compact terminal controls rendered as a tucked icon on mobile. */
  mobileTerminalActionsSlot?: React.ReactNode
  /** Keeps the terminal hint footprint reserved when inactive to avoid mode-switch shifts. */
  reserveTerminalActions?: boolean
}

/* ── File to MediaAttachment ─────────────────────────────── */

function resizeImage(file: File, maxPx: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      let { width, height } = img
      if (width > maxPx || height > maxPx) {
        const scale = maxPx / Math.max(width, height)
        width = Math.round(width * scale)
        height = Math.round(height * scale)
      }
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) { reject(new Error('no canvas context')); return }
      ctx.drawImage(img, 0, 0, width, height)
      const mimeType = file.size > 50000 ? 'image/jpeg' : 'image/png'
      const quality = mimeType === 'image/jpeg' ? 0.85 : undefined
      resolve(canvas.toDataURL(mimeType, quality))
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image load failed')) }
    img.src = url
  })
}

async function fileToAttachment(file: File): Promise<MediaAttachment> {
  const isImage = file.type.startsWith('image/')
  const isAudio = file.type.startsWith('audio/')

  let dataUrl: string
  if (isImage) {
    dataUrl = await resizeImage(file, 1200)
  } else {
    dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onloadend = () => resolve(reader.result as string)
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }

  return {
    type: isImage ? 'image' : isAudio ? 'audio' : 'file',
    url: dataUrl,
    name: file.name,
    mimeType: file.type,
    size: file.size,
    file,
  }
}

/* ── Component ──────────────────────────────────────────── */

export function ChatInput({
  disabled,
  loading,
  onSend,
  onInterrupt,
  onNewSession,
  onStatusRequest,
  skillsVersion,
  events,
  droppedFiles,
  onDroppedFilesConsumed,
  focusTrigger,
  onShortcutsClick,
  selectorSlot,
  terminalActionsSlot,
  mobileTerminalActionsSlot,
  reserveTerminalActions,
}: ChatInputProps) {
  const [value, setValue] = useState('')
  const [employees, setEmployees] = useState<Employee[]>([])
  const [showMentions, setShowMentions] = useState(false)
  const [mentionFilter, setMentionFilter] = useState('')
  const [mentionIndex, setMentionIndex] = useState(0)
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>(BUILTIN_COMMANDS)
  const [showCommands, setShowCommands] = useState(false)
  const [commandFilter, setCommandFilter] = useState('')
  const [commandIndex, setCommandIndex] = useState(0)
  const [pendingAttachments, setPendingAttachments] = useState<MediaAttachment[]>([])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const rafRef = useRef<number | null>(null)

  const resize = useCallback((el: HTMLTextAreaElement) => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    rafRef.current = requestAnimationFrame(() => {
      el.style.height = 'auto'
      el.style.height = Math.min(el.scrollHeight, 120) + 'px'
    })
  }, [])

  useEffect(() => {
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  // Focus textarea when focusTrigger changes (session select / "+ New").
  // Skip on mobile — auto-focus pops the on-screen keyboard, which is jarring
  // when the trigger is a session switch the user did with their thumb.
  // Defer with requestAnimationFrame so the textarea has finished mounting
  // after ChatPane's key-driven remount.
  useEffect(() => {
    if (!focusTrigger || focusTrigger <= 0) return
    if (window.innerWidth < 768) return
    const raf = requestAnimationFrame(() => textareaRef.current?.focus())
    return () => cancelAnimationFrame(raf)
  }, [focusTrigger])
  const mentionItemRefs = useRef<Map<number, HTMLButtonElement>>(new Map())

  const stt = useStt(events, (text) => {
    // Called when timeout auto-stops recording and transcription completes
    if (text) {
      setValue((prev) => prev ? prev + ' ' + text : text)
    }
  })

  // Consume files dropped onto the chat area by the parent
  const consumedRef = useRef<File[] | undefined>(undefined)
  useEffect(() => {
    if (!droppedFiles || droppedFiles.length === 0) return
    // Guard against React Strict Mode double-firing the effect
    if (consumedRef.current === droppedFiles) return
    consumedRef.current = droppedFiles
    ;(async () => {
      const newAttachments: MediaAttachment[] = []
      for (const file of droppedFiles) {
        newAttachments.push(await fileToAttachment(file))
      }
      setPendingAttachments((prev) => [...prev, ...newAttachments])
      onDroppedFilesConsumed?.()
    })()
  }, [droppedFiles, onDroppedFilesConsumed])

  // Load employees for @mention (with full details)
  useEffect(() => {
    api
      .getOrg()
      .then((data) => {
        if (!Array.isArray(data.employees)) return
        setEmployees(data.employees.map((emp) => ({
          name: emp.name,
          displayName: emp.displayName,
          department: emp.department,
          rank: emp.rank,
          engine: emp.engine,
        })))
      })
      .catch(() => {})
  }, [])

  // Load skills as slash commands (re-fetches when skills change on gateway)
  useEffect(() => {
    api.getSkills()
      .then((skills) => {
        if (!Array.isArray(skills)) return
        const skillCommands: SlashCommand[] = skills
          .filter((s) => !BUILTIN_COMMANDS.some((b) => b.name === s.name))
          .map((s) => ({
            name: s.name as string,
            description: (s.description as string) || '',
            needsEmployee: s.name === 'sync',
          }))
        setSlashCommands([...BUILTIN_COMMANDS, ...skillCommands])
      })
      .catch(() => {})
  }, [skillsVersion])


  const handleMentionSelect = useCallback(
    (name: string) => {
      const atIdx = value.lastIndexOf('@')
      if (atIdx !== -1) {
        const before = value.slice(0, atIdx)
        setValue(before + '@' + name + ' ')
      }
      setShowMentions(false)
      textareaRef.current?.focus()
    },
    [value]
  )

  const handleCommandSelect = useCallback(
    (cmd: SlashCommand) => {
      if (cmd.needsEmployee) {
        // Insert command + @ to trigger mention autocomplete
        setValue('/' + cmd.name + ' @')
        setShowCommands(false)
        // Trigger mention dropdown
        setMentionFilter('')
        setMentionIndex(0)
        setShowMentions(true)
      } else {
        setValue('/' + cmd.name)
        setShowCommands(false)
      }
      textareaRef.current?.focus()
    },
    []
  )

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const val = e.target.value
    setValue(val)

    // Detect slash commands: text starts with / and has no space yet (still typing the command name)
    if (val.startsWith('/') && !val.includes(' ')) {
      const filter = val.slice(1).toLowerCase()
      setCommandFilter(filter)
      setCommandIndex(0)
      setShowCommands(true)
      setShowMentions(false)
      return
    }
    setShowCommands(false)

    // Detect @mentions
    const atIdx = val.lastIndexOf('@')
    if (atIdx !== -1) {
      const afterAt = val.slice(atIdx + 1)
      if (!afterAt.includes(' ') && !afterAt.includes('\n')) {
        setMentionFilter(afterAt.toLowerCase())
        setMentionIndex(0)
        setShowMentions(true)
        return
      }
    }
    setShowMentions(false)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Command autocomplete navigation
    if (showCommands && filteredCommands.length > 0) {
      const max = filteredCommands.length
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setCommandIndex((prev) => (prev + 1) % max)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setCommandIndex((prev) => (prev - 1 + max) % max)
        return
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault()
        handleCommandSelect(filteredCommands[commandIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setShowCommands(false)
        return
      }
    }

    // Mention autocomplete navigation
    if (showMentions && filteredEmployees.length > 0) {
      const max = Math.min(filteredEmployees.length, 8)
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionIndex((prev) => (prev + 1) % max)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionIndex((prev) => (prev - 1 + max) % max)
        return
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault()
        handleMentionSelect(filteredEmployees[mentionIndex].name)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setShowMentions(false)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  function handleSubmit() {
    const trimmed = value.trim()
    const hasMedia = pendingAttachments.length > 0

    if ((!trimmed && !hasMedia) || disabled) return

    // Handle commands
    if (trimmed === '/new') {
      setValue('')
      onNewSession()
      return
    }
    if (trimmed === '/status') {
      setValue('')
      onStatusRequest()
      return
    }

    const mediaToSend = hasMedia ? [...pendingAttachments] : undefined
    setValue('')
    setPendingAttachments([])
    setShowMentions(false)
    setShowCommands(false)

    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }

    onSend(trimmed, mediaToSend, false)
  }

  async function handleFileAttach(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files
    if (!files || files.length === 0) return

    const newAttachments: MediaAttachment[] = []
    for (let i = 0; i < files.length; i++) {
      newAttachments.push(await fileToAttachment(files[i]))
    }
    setPendingAttachments((prev) => [...prev, ...newAttachments])
    e.target.value = ''
  }

  function removePendingAttachment(index: number) {
    setPendingAttachments((prev) => prev.filter((_, i) => i !== index))
  }

  async function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items
    if (!items) return

    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        e.preventDefault()
        const file = items[i].getAsFile()
        if (file) {
          const att = await fileToAttachment(file)
          setPendingAttachments((prev) => [...prev, att])
        }
        return
      }
    }
  }

  /* ── Speech-to-text (offline whisper.cpp) ─────────────── */

  const fillTextarea = useCallback((text: string) => {
    if (!text) return
    setValue((prev) => prev ? prev + ' ' + text : text)
  }, [])

  // Auto-resize textarea when value changes programmatically (e.g., from STT)
  useEffect(() => {
    if (textareaRef.current) {
      resize(textareaRef.current)
    }
  }, [value, resize])

  // Stop the current recording, transcribe, and drop the text into the input.
  const transcribeAndFill = useCallback(async () => {
    const text = await stt.stopRecording()
    fillTextarea(text ?? '')
    textareaRef.current?.focus()
  }, [stt, fillTextarea])

  /* ── Mic gestures: tap-and-hold (push-to-talk) + quick-tap (toggle) ──── */
  // Refs avoid stale-closure races between pointerdown and pointerup.
  const micDownAtRef = useRef<number | null>(null)   // timestamp of an active press
  const micHoldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const micToggleActiveRef = useRef(false)           // recording left on by a quick tap

  useEffect(() => {
    return () => {
      if (micHoldTimerRef.current) clearTimeout(micHoldTimerRef.current)
    }
  }, [])

  function handleMicPointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    // Keep the card click-to-focus handler from also firing.
    e.stopPropagation()
    if (stt.state === 'transcribing') return

    // Already recording from a previous quick tap → this press toggles it off.
    if (micToggleActiveRef.current || stt.state === 'recording') {
      micToggleActiveRef.current = false
      micDownAtRef.current = null
      if (micHoldTimerRef.current) { clearTimeout(micHoldTimerRef.current); micHoldTimerRef.current = null }
      void transcribeAndFill()
      return
    }

    // Begin a fresh press: start recording and arm the hold detector.
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* noop */ }
    micDownAtRef.current = Date.now()
    if (micHoldTimerRef.current) clearTimeout(micHoldTimerRef.current)
    micHoldTimerRef.current = setTimeout(() => { micHoldTimerRef.current = null }, MIC_HOLD_THRESHOLD_MS)
    // handleMicClick() starts recording, or opens the download modal if no model.
    stt.handleMicClick()
  }

  function handleMicPointerUp() {
    const downAt = micDownAtRef.current
    if (downAt == null) return // no active press (e.g. toggle-off already handled)
    micDownAtRef.current = null
    if (micHoldTimerRef.current) { clearTimeout(micHoldTimerRef.current); micHoldTimerRef.current = null }

    // If the model wasn't ready, recording never started — leave the modal alone.
    if (stt.state === 'no-model' || stt.state === 'transcribing') return

    const gesture = classifyMicGesture(downAt, Date.now())
    if (gesture === 'hold') {
      // Push-to-talk release → stop + transcribe.
      void transcribeAndFill()
    } else {
      // Quick tap that started recording → leave it running; next tap stops it.
      micToggleActiveRef.current = true
    }
  }

  const filteredCommands = useMemo(
    () => slashCommands.filter((c) => c.name?.toLowerCase().startsWith(commandFilter)),
    [slashCommands, commandFilter]
  )

  const filteredEmployees = useMemo(
    () => employees.filter((e) => e.name?.toLowerCase().includes(mentionFilter)),
    [employees, mentionFilter]
  )

  const hasContent = value.trim().length > 0 || pendingAttachments.length > 0

  return (
    <div className="px-3 sm:px-4 pt-[var(--space-3)] pb-[var(--space-3)] bg-[var(--bg)] shrink-0 relative">
      {/* Soft top scrim — fades scrolling content into the composer instead of a
          hard 1px divider. Borderless, readable over the thread in both themes. */}
      <div aria-hidden className="pointer-events-none absolute -top-5 left-0 right-0 h-5 bg-gradient-to-b from-transparent to-[var(--bg)]" />
      {/* Slash command autocomplete */}
      {showCommands && filteredCommands.length > 0 && (
        <div className="absolute bottom-full left-[var(--space-4)] right-[var(--space-4)] mb-1 bg-[var(--bg)] border border-[var(--separator)] rounded-[var(--radius-md)] shadow-[var(--shadow-lg)] max-h-60 overflow-y-auto z-10">
          {filteredCommands.map((cmd, idx) => {
            const isHighlighted = idx === commandIndex
            return (
              <button
                key={cmd.name}
                ref={(el) => {
                  if (isHighlighted && el) el.scrollIntoView({ block: 'nearest' })
                }}
                onClick={() => handleCommandSelect(cmd)}
                className={`w-full text-left py-[var(--space-2)] px-[var(--space-3)] text-[length:var(--text-footnote)] ${isHighlighted ? 'bg-[var(--fill-secondary)]' : 'bg-transparent'} border-none cursor-pointer flex items-center gap-[var(--space-2)] text-[var(--text-primary)]`}
              >
                <span className="font-[family-name:var(--font-mono)] font-[var(--weight-semibold)] text-[var(--accent)] text-[length:var(--text-footnote)]">/{cmd.name}</span>
                <span className="text-[var(--text-tertiary)] text-[length:var(--text-caption1)]">{cmd.description}</span>
              </button>
            )
          })}
        </div>
      )}

      {/* Mention autocomplete */}
      {showMentions && filteredEmployees.length > 0 && (
        <div className="absolute bottom-full left-[var(--space-4)] right-[var(--space-4)] mb-1 bg-[var(--bg)] border border-[var(--separator)] rounded-[var(--radius-md)] shadow-[var(--shadow-lg)] max-h-40 overflow-y-auto z-10">
          {filteredEmployees.slice(0, 8).map((emp, idx) => {
            const isHighlighted = idx === mentionIndex
            return (
              <button
                key={emp.name}
                ref={(el) => {
                  if (el) mentionItemRefs.current.set(idx, el)
                  else mentionItemRefs.current.delete(idx)
                  if (isHighlighted && el) el.scrollIntoView({ block: 'nearest' })
                }}
                onClick={() => handleMentionSelect(emp.name)}
                className={`w-full text-left py-[var(--space-2)] px-[var(--space-3)] text-[length:var(--text-footnote)] ${isHighlighted ? 'bg-[var(--fill-secondary)]' : 'bg-transparent'} border-none cursor-pointer flex items-center gap-[var(--space-2)] text-[var(--text-primary)]`}
              >
                <EmployeeAvatar name={emp.name} size={20} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-[var(--space-2)]">
                    <span className="font-[var(--weight-semibold)]">{emp.displayName || emp.name}</span>
                    <span className="font-[family-name:var(--font-mono)] text-[length:var(--text-caption2)] text-[var(--text-tertiary)]">@{emp.name}</span>
                  </div>
                  {emp.department && (
                    <div className="text-[length:var(--text-caption2)] text-[var(--text-quaternary)] flex gap-[var(--space-2)] mt-px">
                      <span>{emp.department}</span>
                      {emp.engine && (
                        <span className="text-[var(--accent)] font-[var(--weight-medium)]">{emp.engine}</span>
                      )}
                    </div>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      )}

      {/* Pending attachments preview */}
      {pendingAttachments.length > 0 && (
        <div className="mb-[var(--space-2)]">
          <MediaPreview
            attachments={pendingAttachments}
            onRemove={removePendingAttachment}
          />
        </div>
      )}

      {/* Composer card — borderless: soft fill + shadow do the separating, no
          hairline at rest. A low-opacity accent ring (not a 1px border) marks
          the streaming state. */}
      <div
        className="rounded-[22px] bg-[var(--bg-secondary)] px-[var(--space-4)] pt-[var(--space-3)] pb-[var(--space-2)] transition-shadow duration-200 ease-in-out"
        style={{
          boxShadow: loading
            ? 'var(--shadow-card), 0 0 0 1.5px color-mix(in srgb, var(--accent) 38%, transparent)'
            : 'var(--shadow-card)',
        }}
        onPointerDown={(e) => {
          // Click-to-focus: tapping anywhere in the card (including the gaps
          // between toolbar buttons) lands the caret in the textarea. Real
          // controls stopPropagation so this never fires for them.
          if (disabled) return
          e.preventDefault() // don't steal/blur an existing selection
          textareaRef.current?.focus()
        }}
      >
        {/* Textarea */}
        <textarea
          id="chat-textarea"
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onPointerDown={(e) => e.stopPropagation()}
          placeholder={
            disabled
              ? 'Waiting for response...'
              : 'Type a message...'
          }
          rows={1}
          disabled={disabled}
          className={`block w-full bg-transparent border-none outline-none resize-none text-[var(--text-primary)] text-[length:var(--text-subheadline)] leading-6 max-h-30 min-h-6 px-1 pt-1 pb-2 m-0 ${disabled ? 'opacity-50' : 'opacity-100'}`}
          onInput={(e) => {
            resize(e.target as HTMLTextAreaElement)
          }}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,audio/*,.pdf,.doc,.docx,.txt,.csv,.json,.zip"
          multiple
          className="hidden"
          onChange={handleFileAttach}
        />

        {/* Toolbar: [+ attach] · [model chip] · spacer · [mic] · [send] */}
        <div className="flex items-center gap-[var(--space-2)]">
          {/* Attach */}
          <button
            aria-label="Attach file"
            title="Attach file"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => fileInputRef.current?.click()}
            className="w-[34px] h-[34px] shrink-0 rounded-full flex items-center justify-center bg-transparent border-none cursor-pointer text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)] transition-colors"
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>

          {/* Model chip — the restyled selector trigger. Wrapped so clicks on
              the trigger (and its inline popover) don't re-trigger card focus,
              while the trigger's own behavior is preserved. */}
          {selectorSlot && (
            <div
              className="min-w-0 flex items-center overflow-hidden"
              onPointerDown={(e) => e.stopPropagation()}
            >
              {selectorSlot}
            </div>
          )}

          <div className="flex-1" />

          {/* Language picker — only shown when multiple STT languages configured */}
          {stt.languages.length > 1 && (
            <button
              aria-label={`STT language: ${stt.selectedLanguage.toUpperCase()}. Click to switch.`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={stt.cycleLanguage}
              className="h-7 px-2 shrink-0 rounded-full flex items-center justify-center bg-[var(--fill-tertiary)] border-none cursor-pointer text-[var(--text-secondary)] text-[11px] font-semibold font-[family-name:var(--font-mono)] tracking-[0.5px] uppercase hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)] transition-all duration-150 ease-in-out"
              title={`Transcription language: ${stt.selectedLanguage.toUpperCase()}. Click to cycle.`}
            >
              {stt.selectedLanguage}
            </button>
          )}

          {/* Voice input / STT button — tap-and-hold = push-to-talk, quick tap =
              toggle. While recording the button morphs into a compact waveform. */}
          <button
            aria-label={
              stt.state === 'recording' ? 'Stop recording'
              : stt.state === 'transcribing' ? 'Transcribing…'
              : 'Voice input'
            }
            onPointerDown={handleMicPointerDown}
            onPointerUp={handleMicPointerUp}
            onPointerCancel={handleMicPointerUp}
            disabled={stt.state === 'transcribing'}
            className={`w-[34px] h-[34px] shrink-0 flex items-center justify-center border-none transition-all duration-150 ease-in-out touch-none select-none ${stt.state === 'recording' ? 'rounded-full bg-[var(--system-red)] text-white cursor-pointer' : `rounded-full bg-transparent text-[var(--text-secondary)] hover:bg-[var(--fill-secondary)] hover:text-[var(--text-primary)] ${stt.state === 'transcribing' ? 'cursor-wait' : 'cursor-pointer'}`}`}
            title={
              stt.state === 'recording' ? 'Stop recording'
              : stt.state === 'transcribing' ? 'Transcribing…'
              : 'Voice input'
            }
          >
            {stt.state === 'recording' && stt.analyser ? (
              <MicWaveform analyser={stt.analyser} />
            ) : stt.state === 'transcribing' ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="animate-[stt-spin_1s_linear_infinite]">
                <path d="M12 2a10 10 0 0 1 10 10" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="23" />
                <line x1="8" y1="23" x2="16" y2="23" />
              </svg>
            )}
          </button>

          {/* Stop button — shown when a turn is streaming (interrupts). */}
          {loading && onInterrupt ? (
            <button
              onPointerDown={(e) => e.stopPropagation()}
              onClick={onInterrupt}
              aria-label="Stop"
              className="w-[38px] h-[38px] rounded-full bg-[var(--system-red)] text-white border-none cursor-pointer flex items-center justify-center shrink-0 transition-all duration-150 ease-in-out"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                <rect x="4" y="4" width="16" height="16" rx="2" />
              </svg>
            </button>
          ) : (
            /* Send button — accent circle */
            <button
              onPointerDown={(e) => e.stopPropagation()}
              onClick={handleSubmit}
              disabled={!hasContent || disabled}
              aria-label="Send message"
              className={`w-[38px] h-[38px] rounded-full border-none flex items-center justify-center shrink-0 transition-all duration-150 ease-in-out ${hasContent ? 'bg-[var(--accent)] text-[var(--accent-contrast)] cursor-pointer' : 'bg-[var(--fill-tertiary)] text-[var(--text-quaternary)] cursor-default'}`}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="19" x2="12" y2="5" />
                <polyline points="5 12 12 5 19 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Slim helper row — shortcuts + terminal access (CLI view). Quiet; the
          command/mention hints were dropped (discoverable by typing / or @). */}
      {(onShortcutsClick || terminalActionsSlot || reserveTerminalActions || mobileTerminalActionsSlot) && (
        <div className="flex items-center justify-end gap-[var(--space-3)] mt-1.5 px-1.5 min-w-0">
          {onShortcutsClick && (
            <button
              onClick={onShortcutsClick}
              className="hidden sm:flex items-center gap-1 text-[length:var(--text-caption2)] text-[var(--text-quaternary)] hover:text-[var(--text-tertiary)] transition-colors bg-transparent border-none cursor-pointer p-0 font-[inherit]"
            >
              <kbd className="font-mono text-[10px] leading-none not-italic">?</kbd>
              <span>shortcuts</span>
            </button>
          )}
          {(terminalActionsSlot || reserveTerminalActions) && (
            <span
              className={`hidden sm:flex items-center text-[length:var(--text-caption2)] text-[var(--text-quaternary)] ${terminalActionsSlot ? '' : 'invisible pointer-events-none'}`}
              aria-hidden={!terminalActionsSlot}
            >
              {terminalActionsSlot ?? (
                <span className="flex items-center gap-1">
                  <kbd className="flex size-4 items-center justify-center text-[10px] leading-none not-italic">⌨</kbd>
                  <span>terminal</span>
                </span>
              )}
            </span>
          )}
          {mobileTerminalActionsSlot && (
            <div className="flex items-center sm:hidden">{mobileTerminalActionsSlot}</div>
          )}
        </div>
      )}

      {/* STT error banner */}
      {stt.state === 'error' && stt.error && (
        <div className="flex items-center gap-[var(--space-2)] mt-[var(--space-2)] py-[var(--space-2)] px-[var(--space-3)] rounded-[var(--radius-sm)] text-[length:var(--text-caption1)] text-[var(--system-red)]" style={{ background: 'color-mix(in srgb, var(--system-red) 12%, transparent)' }}>
          <span className="flex-1">Voice input error: {stt.error}</span>
          <button
            onClick={stt.dismissError}
            className="bg-none border-none cursor-pointer text-[var(--system-red)] text-[length:var(--text-caption1)] font-semibold py-0.5 px-1.5"
          >Dismiss</button>
        </div>
      )}

      {/* STT model download modal */}
      <WhisperDownloadModal
        open={stt.state === 'no-model'}
        progress={stt.downloadProgress}
        onDownload={stt.startDownload}
        onCancel={stt.dismissDownload}
      />

      <style>{`
        @keyframes stt-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  )
}
