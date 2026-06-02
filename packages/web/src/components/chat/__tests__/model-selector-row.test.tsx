import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { EnginesResponse } from '@/lib/api'

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
    render(<ModelSelectorRow mode="new" value={{}} onChange={() => {}} />)
    expect(screen.getByRole('button', { name: 'Engine' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Model' })).toBeTruthy()
  })

  it('shows the engine + model labels from the registry', () => {
    render(<ModelSelectorRow mode="new" value={{ engine: 'claude', model: 'opus' }} onChange={() => {}} />)
    expect(screen.getByText('Claude')).toBeTruthy()
    expect(screen.getByText('Opus 4.8')).toBeTruthy()
  })

  it('existing-chat mode: Engine is a locked trigger (explainer popover), not an engine list; model stays editable', () => {
    render(<ModelSelectorRow mode="existing" value={{ engine: 'claude', model: 'opus' }} onChange={() => {}} />)
    // The locked engine is a clickable trigger labelled "Engine (locked)", not a plain "Engine" dropdown.
    expect(screen.queryByRole('button', { name: 'Engine' })).toBeNull()
    expect(screen.getByRole('button', { name: /engine \(locked\)/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Model' })).toBeTruthy()
  })

  it('shows an Effort control for effort-capable models', () => {
    render(<ModelSelectorRow mode="new" value={{ engine: 'claude', model: 'opus', effortLevel: 'high' }} onChange={() => {}} />)
    expect(screen.getByRole('button', { name: 'Effort' })).toBeTruthy()
  })

  it('hides Effort entirely for effort-less engines (antigravity)', () => {
    render(<ModelSelectorRow mode="new" value={{ engine: 'antigravity', model: 'gemini-3-flash-preview' }} onChange={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Effort' })).toBeNull()
  })

  it('shows the "applies next message" note in existing mode when pending', () => {
    render(<ModelSelectorRow mode="existing" value={{ engine: 'claude', model: 'opus' }} onChange={() => {}} pendingNote />)
    expect(screen.getByText(/applies next message/i)).toBeTruthy()
  })
})
