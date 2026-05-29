import { describe, it, expect } from 'vitest'
import { reconcileMessages } from '@/lib/conversations'
import type { Message } from '@/lib/conversations'

const userMsg: Message = { id: 'u1', role: 'user', content: 'make a chart', timestamp: 1000 }
const attachment: Message = {
  id: 'a1',
  role: 'assistant',
  content: 'chart',
  timestamp: 1500,
  media: [{ type: 'image', url: '/api/files/x', name: 'chart.png' }],
}
const resultMsg: Message = { id: 'r1', role: 'assistant', content: 'done', timestamp: 2000 }

describe('reconcileMessages — attachment disappear regression', () => {
  it('keeps a live-pushed attachment when the refreshed snapshot lacks it', () => {
    // Local state after the WS session:attachment append.
    const current = [userMsg, attachment]
    // History refetch races ahead of the DB commit → snapshot has no attachment yet.
    const staleSnapshot = [userMsg]

    const merged = reconcileMessages(current, staleSnapshot)

    expect(merged.map((m) => m.id)).toEqual(['u1', 'a1'])
    expect(merged.find((m) => m.id === 'a1')?.media?.[0].url).toBe('/api/files/x')
  })

  it('does NOT duplicate the attachment once the snapshot catches up', () => {
    const current = [userMsg, attachment]
    // Snapshot now includes the persisted attachment (same id) plus the final result.
    const freshSnapshot = [userMsg, attachment, resultMsg]

    const merged = reconcileMessages(current, freshSnapshot)

    const attachmentCount = merged.filter((m) => m.id === 'a1').length
    expect(attachmentCount).toBe(1)
    expect(merged.map((m) => m.id)).toEqual(['u1', 'a1', 'r1'])
  })

  it('re-sorts preserved attachments by timestamp', () => {
    const current = [attachment] // pushed at t=1500
    const snapshot = [userMsg, resultMsg] // t=1000, t=2000, no attachment
    const merged = reconcileMessages(current, snapshot)
    expect(merged.map((m) => m.id)).toEqual(['u1', 'a1', 'r1']) // attachment slots between by ts
  })

  it('returns the snapshot untouched when there are no media messages to preserve', () => {
    const current = [userMsg]
    const snapshot = [userMsg, resultMsg]
    expect(reconcileMessages(current, snapshot)).toBe(snapshot)
  })

  it('does not resurrect transient non-media messages missing from the snapshot', () => {
    const streamingBubble: Message = { id: 's1', role: 'assistant', content: 'thinking…', timestamp: 1200 }
    const current = [userMsg, streamingBubble]
    const snapshot = [userMsg, resultMsg]
    const merged = reconcileMessages(current, snapshot)
    expect(merged.find((m) => m.id === 's1')).toBeUndefined()
  })
})

describe('reconcileMessages — inbound user-message duplicate regression (v0.16.0)', () => {
  // Optimistic user message with image + video, appended with a CLIENT random id
  // and base64 preview urls.
  const optimisticUserMsg: Message = {
    id: 'client-random-uuid',
    role: 'user',
    content: 'what you see here?',
    timestamp: 5000,
    media: [
      { type: 'image', url: 'data:image/jpeg;base64,AAAA', name: 'chest-front.jpg' },
      { type: 'file', url: 'data:video/mp4;base64,BBBB', name: 'clip.mp4' },
    ],
  }
  // Server-persisted twin: DIFFERENT (canonical) id, /api/files urls, same names.
  const serverUserMsg: Message = {
    id: 'server-canonical-id',
    role: 'user',
    content: 'what you see here?',
    timestamp: 5001,
    media: [
      { type: 'image', url: '/api/files/img-id', name: 'chest-front.jpg' },
      { type: 'file', url: '/api/files/vid-id', name: 'clip.mp4' },
    ],
  }

  it('shows the user message with 2 media (incl. video) EXACTLY once, not twice', () => {
    const merged = reconcileMessages([optimisticUserMsg], [serverUserMsg])
    const userMsgs = merged.filter((m) => m.role === 'user' && m.content === 'what you see here?')
    expect(userMsgs).toHaveLength(1)
    // the surviving copy is the server one (canonical /api/files urls)
    expect(userMsgs[0].id).toBe('server-canonical-id')
    expect(userMsgs[0].media).toHaveLength(2)
  })

  it('still preserves an outbound agent attachment that the snapshot lacks (no regression)', () => {
    const merged = reconcileMessages([attachment], [userMsg])
    expect(merged.map((m) => m.id)).toEqual(['u1', 'a1'])
  })

  it('does not collapse two genuinely different files with empty captions', () => {
    const a: Message = { id: 's-a', role: 'assistant', content: '', timestamp: 10, media: [{ type: 'file', url: '/api/files/a', name: 'a.zip' }] }
    const b: Message = { id: 'local-b', role: 'assistant', content: '', timestamp: 11, media: [{ type: 'file', url: '/api/files/b', name: 'b.zip' }] }
    // snapshot has only A; B is a distinct local attachment not yet in snapshot → preserved
    const merged = reconcileMessages([a, b], [a])
    expect(merged.map((m) => m.id)).toEqual(['s-a', 'local-b'])
  })
})
