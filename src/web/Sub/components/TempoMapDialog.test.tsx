// @vitest-environment jsdom

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { UIProvider } from '@yamada-ui/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../types/timeline'
import { TempoMapDialog, type TempoMapDialogProps } from './TempoMapDialog'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => ({
      'studio.tempo_map_title': 'Tempo Map',
      'studio.tempo_map_add': 'Add event',
      'studio.tempo_map_delete': 'Delete',
      'studio.tempo_map_apply': 'Apply tempo map',
      'studio.tempo_map_error': `Tempo map error: ${values?.error}`,
      'studio.tempo_map_duplicate_tick': `Duplicate tick ${values?.tick}`,
      'studio.tempo_map_tick_zero_required': 'Tick zero required',
      'studio.tempo_map_tick_index': `Tick ${values?.index}`,
      'studio.tempo_map_bpm_index': `BPM ${values?.index}`,
      'studio.tempo_map_meter_index': `Beat unit ${values?.index}`,
      'studio.tempo_map_numerator_index': `Beats per bar ${values?.index}`,
      'studio.tempo_map_delete_index': `Delete tempo event ${values?.index}`,
      'studio.close': 'Close',
    }[key] ?? key),
  }),
}))

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
})

afterEach(cleanup)

function renderDialog(overrides: Partial<TempoMapDialogProps> = {}) {
  const props: TempoMapDialogProps = {
    open: true,
    settings: structuredClone(DEFAULT_SETTINGS),
    lengthTicks: 200,
    currentTick: 25,
    onApply: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
  return {
    props,
    ...render(<UIProvider><TempoMapDialog {...props} /></UIProvider>),
  }
}

describe('TempoMapDialog', () => {
  it('adds and edits an event, then calls the host exactly once', async () => {
    const onApply = vi.fn()
    const onClose = vi.fn()
    renderDialog({ onApply, onClose })
    fireEvent.click(screen.getByRole('button', { name: 'Add event' }))
    fireEvent.change(screen.getByLabelText('BPM 2'), { target: { value: '90' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply tempo map' }))

    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1))
    expect(onApply).toHaveBeenCalledWith([
      { tick: 0, bpm: 120, meter: { numerator: 4, denominator: 4 } },
      { tick: 25, bpm: 90 },
    ])
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('deletes a non-initial event without exposing unrelated project state', async () => {
    const onApply = vi.fn()
    renderDialog({
      events: [
        { tick: 0, bpm: 120, meter: { numerator: 4, denominator: 4 } },
        { tick: 40, bpm: 80 },
      ],
      onApply,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Delete tempo event 2' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply tempo map' }))
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1))
    expect(onApply).toHaveBeenCalledWith([
      { tick: 0, bpm: 120, meter: { numerator: 4, denominator: 4 } },
    ])
  })

  it('blocks duplicate ticks and keeps the required tick-zero event locked', () => {
    renderDialog({
      events: [
        { tick: 0, bpm: 120, meter: { numerator: 4, denominator: 4 } },
        { tick: 40, bpm: 80 },
      ],
    })
    expect((screen.getByLabelText('Tick 1') as HTMLInputElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Tick 2'), { target: { value: '0' } })
    expect(screen.getByRole('alert').textContent).toMatch(/Duplicate tick 0/)
    expect((screen.getByRole('button', { name: 'Apply tempo map' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('keeps focus while continuously editing tick/BPM values and closes on Escape', () => {
    const onClose = vi.fn()
    renderDialog({
      events: [
        { tick: 0, bpm: 120, meter: { numerator: 4, denominator: 4 } },
        { tick: 40, bpm: 80 },
      ],
      onClose,
    })
    const tick = screen.getByLabelText('Tick 2') as HTMLInputElement
    tick.focus()
    fireEvent.change(tick, { target: { value: '45' } })
    expect(document.activeElement).toBe(tick)
    fireEvent.change(tick, { target: { value: '46' } })
    expect(tick.value).toBe('46')
    expect(document.activeElement).toBe(tick)

    const bpm = screen.getByLabelText('BPM 2') as HTMLInputElement
    bpm.focus()
    fireEvent.change(bpm, { target: { value: '95.5' } })
    expect(document.activeElement).toBe(bpm)
    expect(bpm.value).toBe('95.5')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
