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
