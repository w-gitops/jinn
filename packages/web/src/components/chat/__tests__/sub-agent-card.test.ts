import { describe, it, expect } from 'vitest'
import { routeSubAgentDelta, type SubAgentState } from '@/components/chat/sub-agent-card'

describe('routeSubAgentDelta', () => {
  it('creates a new card on first delta with label', () => {
    const next = routeSubAgentDelta([], { id: 'a1', label: 'review engines' }, 'text', 'Hello')
    expect(next).toHaveLength(1)
    expect(next[0]).toMatchObject({ id: 'a1', label: 'review engines', status: 'running' })
    expect(next[0].entries).toEqual([{ kind: 'text', text: 'Hello' }])
  })

  it('coalesces consecutive text deltas into one entry', () => {
    let s: SubAgentState[] = []
    s = routeSubAgentDelta(s, { id: 'a1' }, 'text', 'foo ')
    s = routeSubAgentDelta(s, { id: 'a1' }, 'text', 'bar')
    expect(s[0].entries).toEqual([{ kind: 'text', text: 'foo bar' }])
  })

  it('appends tool entries as separate items, splitting text runs', () => {
    let s: SubAgentState[] = []
    s = routeSubAgentDelta(s, { id: 'a1' }, 'text', 'reading')
    s = routeSubAgentDelta(s, { id: 'a1' }, 'tool_use', '', 'Read')
    s = routeSubAgentDelta(s, { id: 'a1' }, 'text', 'done')
    expect(s[0].entries).toEqual([
      { kind: 'text', text: 'reading' },
      { kind: 'tool', name: 'Read' },
      { kind: 'text', text: 'done' },
    ])
  })

  it('keeps parallel sub-agents separate by id', () => {
    let s: SubAgentState[] = []
    s = routeSubAgentDelta(s, { id: 'a1', label: 'one' }, 'text', 'A')
    s = routeSubAgentDelta(s, { id: 'a2', label: 'two' }, 'text', 'B')
    expect(s).toHaveLength(2)
    expect(s.map((a) => a.id)).toEqual(['a1', 'a2'])
  })

  it('ignores context / tool_result deltas (nothing renderable)', () => {
    const s = routeSubAgentDelta([], { id: 'a1' }, 'context', '12345')
    expect(s).toEqual([])
  })
})
