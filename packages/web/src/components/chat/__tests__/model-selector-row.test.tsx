import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import type { EnginesResponse } from '@/lib/api'

// ModelSelectorRow calls useQueryClient() (for refreshModels), so renders must
// be wrapped in a QueryClientProvider — otherwise the hook throws on mount.
function renderRow(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

const REG: EnginesResponse = {
  default: 'claude',
  engines: {
    claude: {
      name: 'claude', available: true, defaultModel: 'opus', effortMechanism: 'claude-flag',
      models: [
        { id: 'opus', label: 'Opus 4.8', supportsEffort: true, effortLevels: ['low', 'medium', 'high'] },
        { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', supportsEffort: true, effortLevels: ['low', 'medium', 'high'] },
      ],
    },
    antigravity: {
      name: 'antigravity', available: true, defaultModel: 'gemini-3-flash-preview', effortMechanism: 'none',
      models: [{ id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash', supportsEffort: false, effortLevels: [] }],
    },
    codex: {
      name: 'codex', available: true, defaultModel: 'gpt-5.5', effortMechanism: 'codex-config',
      models: [{ id: 'gpt-5.5', label: 'GPT-5.5', supportsEffort: true, effortLevels: ['low', 'medium', 'high', 'xhigh'], contextWindow: 258400 }],
    },
  },
}

// Mock only the query hook; keep the real pure helpers.
vi.mock('@/hooks/use-model-registry', async (importActual) => {
  const actual = await importActual<typeof import('@/hooks/use-model-registry')>()
  return { ...actual, useModelRegistry: () => ({ data: REG, isLoading: false }) }
})

import { ModelSelectorRow } from '../model-selector-row'

describe('ModelSelectorRow chip', () => {
  it('renders a single chip trigger labelled with the model + effort', () => {
    renderRow(<ModelSelectorRow mode="new" value={{ engine: 'claude', model: 'opus', effortLevel: 'high' }} onChange={() => {}} />)
    const chip = screen.getByRole('button', { name: /model and effort/i })
    expect(chip).toBeTruthy()
    // Model label is always visible on the chip surface (effort is responsive).
    expect(screen.getByText('Opus 4.8')).toBeTruthy()
    expect(chip.getAttribute('aria-label')).toContain('Opus 4.8')
    expect(chip.getAttribute('aria-label')).toContain('High')
  })

  it('reflects the selected model on the chip', () => {
    renderRow(<ModelSelectorRow mode="new" value={{ engine: 'claude', model: 'claude-sonnet-4-6', effortLevel: 'medium' }} onChange={() => {}} />)
    expect(screen.getByText('Sonnet 4.6')).toBeTruthy()
  })

  it('omits effort from the chip label for effort-less engines (antigravity)', () => {
    renderRow(<ModelSelectorRow mode="new" value={{ engine: 'antigravity', model: 'gemini-3-flash-preview' }} onChange={() => {}} />)
    const chip = screen.getByRole('button', { name: /model and effort/i })
    expect(chip.getAttribute('aria-label')).toBe('Model and effort: Gemini 3 Flash')
  })

  it('renders nothing extra (one trigger) — engine/model/effort all live in one dropdown', () => {
    renderRow(<ModelSelectorRow mode="existing" value={{ engine: 'claude', model: 'opus' }} onChange={() => {}} />)
    // The old inline Engine/Model/Effort buttons are gone; just the chip remains.
    expect(screen.queryByRole('button', { name: 'Engine' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Model' })).toBeNull()
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })
})
