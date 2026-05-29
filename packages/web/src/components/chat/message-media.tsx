import React, { useState, useEffect, useCallback } from 'react'
import type { MediaAttachment } from '@/lib/conversations'
import { FileAttachment } from './file-attachment'
import { VoiceMessage } from './voice-message'

/* Full-screen image viewer with close + download. Closes on backdrop click or Esc. */
function ImageLightbox({
  url,
  name,
  onClose,
}: {
  url: string
  name?: string
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={name || 'Image preview'}
      onClick={onClose}
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/80 p-[var(--space-6)]"
    >
      {/* Controls */}
      <div className="absolute top-[var(--space-4)] right-[var(--space-4)] flex gap-[var(--space-2)]">
        <a
          href={url}
          download={name || 'image'}
          aria-label="Download image"
          onClick={(e) => e.stopPropagation()}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/25"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </a>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/25"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={name || 'Image'}
        onClick={(e) => e.stopPropagation()}
        className="max-h-full max-w-full rounded-[var(--radius-md)] object-contain"
      />
    </div>
  )
}

/**
 * Render a message's media. Images go in a responsive grid (single image stays
 * large; multiples tile 2-up) and open a full-screen lightbox on click. Audio
 * uses the voice player; every other type is a downloadable file chip.
 * Handles single AND multiple attachments without clobbering.
 */
export function MessageMedia({ media, isUser }: { media: MediaAttachment[]; isUser: boolean }) {
  const [lightbox, setLightbox] = useState<{ url: string; name?: string } | null>(null)
  const close = useCallback(() => setLightbox(null), [])

  const images = media.filter((m) => m.type === 'image')
  const audio = media.filter((m) => m.type === 'audio')
  const files = media.filter((m) => m.type === 'file')

  return (
    <>
      {images.length > 0 && (
        <div
          className={
            images.length > 1
              ? 'mt-[var(--space-2)] grid grid-cols-2 gap-[var(--space-2)] max-w-[280px]'
              : 'mt-[var(--space-2)] max-w-[280px]'
          }
        >
          {images.map((m, mi) => (
            <button
              key={`img-${mi}`}
              type="button"
              onClick={() => setLightbox({ url: m.url, name: m.name })}
              aria-label={`Open ${m.name || 'image'}`}
              className="block overflow-hidden rounded-[var(--radius-lg)] p-0 border-0 bg-transparent cursor-pointer"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={m.url}
                alt={m.name || 'Image'}
                className={
                  images.length > 1
                    ? 'block h-[130px] w-full rounded-[var(--radius-lg)] object-cover'
                    : 'block w-full rounded-[var(--radius-lg)]'
                }
              />
            </button>
          ))}
        </div>
      )}

      {audio.map((m, mi) => (
        <div key={`audio-${mi}`} className="mt-[var(--space-2)]">
          <VoiceMessage src={m.url} duration={m.duration || 0} waveform={m.waveform || []} isUser={isUser} />
        </div>
      ))}

      {files.length > 0 && (
        <div className="mt-[var(--space-2)] flex flex-col gap-[var(--space-2)]">
          {files.map((m, mi) => (
            <FileAttachment
              key={`file-${mi}`}
              name={m.name || 'File'}
              size={m.size}
              mimeType={m.mimeType}
              url={m.url}
              isUser={isUser}
            />
          ))}
        </div>
      )}

      {lightbox && <ImageLightbox url={lightbox.url} name={lightbox.name} onClose={close} />}
    </>
  )
}
