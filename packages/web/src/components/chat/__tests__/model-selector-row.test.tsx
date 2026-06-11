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

describe('ModelSelectorRow', () => {
  it('new-chat mode: Engine is an editable dropdown button', () => {
    renderRow(<ModelSelectorRow mode="new" value={{}} onChange={() => {}} />)
    expect(screen.getByRole('button', { name: 'Engine' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Model' })).toBeTruthy()
  })

  it('shows the engine + model labels from the registry', () => {
    renderRow(<ModelSelectorRow mode="new" value={{ engine: 'claude', model: 'opus' }} onChange={() => {}} />)
    expect(screen.getByText('Claude')).toBeTruthy()
    expect(screen.getByText('Opus 4.8')).toBeTruthy()
  })

  it('existing-chat mode: Engine is a locked trigger (explainer popover), not an engine list; model stays editable', () => {
    renderRow(<ModelSelectorRow mode="existing" value={{ engine: 'claude', model: 'opus' }} onChange={() => {}} />)
    // The locked engine is a clickable trigger labelled "Engine (locked)", not a plain "Engine" dropdown.
    expect(screen.queryByRole('button', { name: 'Engine' })).toBeNull()
    expect(screen.getByRole('button', { name: /engine \(locked\)/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Model' })).toBeTruthy()
  })

  it('shows an Effort control for effort-capable models', () => {
    renderRow(<ModelSelectorRow mode="new" value={{ engine: 'claude', model: 'opus', effortLevel: 'high' }} onChange={() => {}} />)
    expect(screen.getByRole('button', { name: 'Effort' })).toBeTruthy()
  })

  it('hides Effort entirely for effort-less engines (antigravity)', () => {
    renderRow(<ModelSelectorRow mode="new" value={{ engine: 'antigravity', model: 'gemini-3-flash-preview' }} onChange={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Effort' })).toBeNull()
  })

  it('shows the "applies next message" note in existing mode when pending', () => {
    renderRow(<ModelSelectorRow mode="existing" value={{ engine: 'claude', model: 'opus' }} onChange={() => {}} pendingNote />)
    expect(screen.getByText(/applies next message/i)).toBeTruthy()
  })

  it('renders context tokens when a context window is known', () => {
    renderRow(<ModelSelectorRow mode="existing" value={{ engine: 'codex', model: 'gpt-5.5' }} onChange={() => {}} contextTokens={50000} />)
    expect(screen.getByText('50k/258k')).toBeTruthy()
  })

  it('shows over-window context as capped instead of hiding it', () => {
    renderRow(<ModelSelectorRow mode="existing" value={{ engine: 'codex', model: 'gpt-5.5' }} onChange={() => {}} contextTokens={494290} />)
    expect(screen.getByText('>258k/258k')).toBeTruthy()
  })
})
