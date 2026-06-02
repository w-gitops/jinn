import { describe, it, expect } from 'vitest'
import { isFilePath } from '../chat-messages'

// Pins the file-path detection behaviour so the shared FILE_PATH_CORE regex
// (used both for isFilePath and the inline-formatter's bare-path alternative)
// cannot silently drift. Rule: optional ~/ or / prefix, ≥1 slash-separated
// segment, ending in a short extension.
describe('isFilePath', () => {
  const shouldLink = [
    'docs/superpowers/specs/2026-05-31-movekit-support-design.md',
    '~/Projects/jinn/packages/web/src/main.tsx',
    '/etc/hosts.conf',
    'skills/foo/SKILL.md',
  ]

  const shouldNotLink = [
    'text/markdown',             // mime type: slash but no extension
    'feat/clickable-file-paths', // branch name: slash but no extension
    '0.16.1',                    // version number: no slash
    'v0.16.1',                   // version number: no slash
    'and/or',                    // prose: slash but no extension
    'config.yaml',               // bare filename: extension but NO slash (slash is required)
    'https://example.com/x.md',  // URL: handled by the URL branch, not the path branch
  ]

  it.each(shouldLink)('treats %s as a file path', (s) => {
    expect(isFilePath(s)).toBe(true)
  })

  it.each(shouldNotLink)('does NOT treat %s as a file path', (s) => {
    expect(isFilePath(s)).toBe(false)
  })
})
