import { afterEach, describe, expect, it, vi } from 'vitest'
import { hasBackgroundActivity, isDirectSession, resolveRowIdentity } from '../chat-sidebar'

afterEach(() => {
  vi.useRealTimers()
})

describe('chat sidebar grouping helpers', () => {
  it('treats only employee-less, non-cron sessions as direct', () => {
    expect(isDirectSession({ source: 'web', sourceRef: 'web:1' })).toBe(true)
    expect(isDirectSession({ source: 'web', sourceRef: 'web:2', employee: 'jinn' })).toBe(false)
    expect(isDirectSession({ source: 'cron', sourceRef: 'cron:daily' })).toBe(false)
    expect(isDirectSession({ source: 'web', sourceRef: 'cron:daily' })).toBe(false)
  })

  it('treats a session tagged with the portal slug as direct (case-insensitive)', () => {
    // ~30 child sessions were created with employee === portal slug; there is no
    // org employee by that name, so they must bucket into the direct/COO group
    // rather than spawn a phantom duplicate group.
    expect(isDirectSession({ source: 'web', sourceRef: 'web:3', employee: 'jimbo' }, 'jimbo')).toBe(true)
    expect(isDirectSession({ source: 'web', sourceRef: 'web:4', employee: 'Jimbo' }, 'jimbo')).toBe(true)
    // a real org employee is never folded into direct
    expect(isDirectSession({ source: 'web', sourceRef: 'web:5', employee: 'jinn' }, 'jimbo')).toBe(false)
    // a portal-slug row is still a separate group when no slug is supplied
    expect(isDirectSession({ source: 'web', sourceRef: 'web:6', employee: 'jimbo' })).toBe(false)
  })
})

describe('chat sidebar background activity', () => {
  it('ignores stale cached background activity', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-10T10:10:00Z'))

    expect(
      hasBackgroundActivity({
        status: 'idle',
        backgroundActivity: {
          activeStreams: 1,
          lastActivityAt: '2026-06-10T10:00:00Z',
        },
      }),
    ).toBe(false)
  })

  it('keeps fresh idle background activity visible', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-10T10:01:00Z'))

    expect(
      hasBackgroundActivity({
        status: 'idle',
        backgroundActivity: {
          activeStreams: 1,
          lastActivityAt: '2026-06-10T10:00:00Z',
        },
      }),
    ).toBe(true)
  })
})

describe('chat sidebar search row identity', () => {
  const opts = {
    portalSlug: 'jimbo',
    portalName: 'Jimbo',
    employeeData: new Map([
      [
        'jinn',
        {
          name: 'jinn',
          displayName: 'Jinn Dev',
          department: 'platform',
          rank: 'employee' as const,
          engine: 'claude',
          model: 'opus',
          persona: '',
        },
      ],
    ]),
  }

  // The API types employee as `string | null`, but the local Session interface
  // narrows it to `string | undefined`; the server can still send null at
  // runtime. Cast to reproduce that real-world shape in the test.
  const cron = { source: 'cron', sourceRef: 'cron:nightly', employee: null } as unknown as Parameters<
    typeof resolveRowIdentity
  >[0]

  // Regression: search flattens cron rows (which the grouped view renders in a
  // separate cron section). isDirectSession returns false for cron sessions, so
  // the old `s.employee!` assertion fed `null` to titleCase → `null.split('-')`
  // → "Cannot read properties of null (reading 'split')". Must not throw.
  it('does not crash on a cron session with a null employee', () => {
    expect(() => resolveRowIdentity(cron, opts)).not.toThrow()
    expect(resolveRowIdentity(cron, opts)).toEqual({ avatarName: 'jimbo', displayName: 'Jimbo' })
  })

  it('does not crash on a session with an undefined employee', () => {
    expect(() => resolveRowIdentity({ source: 'web', sourceRef: 'web:1' }, opts)).not.toThrow()
    expect(resolveRowIdentity({ source: 'web', sourceRef: 'web:1' }, opts)).toEqual({
      avatarName: 'jimbo',
      displayName: 'Jimbo',
    })
  })

  it('resolves a real employee to its org display name', () => {
    expect(
      resolveRowIdentity({ source: 'web', sourceRef: 'web:2', employee: 'jinn' }, opts),
    ).toEqual({ avatarName: 'jinn', displayName: 'Jinn Dev' })
  })

  it('title-cases an employee with no org profile rather than crashing', () => {
    expect(
      resolveRowIdentity({ source: 'web', sourceRef: 'web:3', employee: 'magic-switch-lead' }, opts),
    ).toEqual({ avatarName: 'magic-switch-lead', displayName: 'Magic Switch Lead' })
  })
})
