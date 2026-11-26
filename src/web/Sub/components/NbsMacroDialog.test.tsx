// @vitest-environment jsdom

import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { UIProvider } from '@yamada-ui/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_MASTER, DEFAULT_SETTINGS, createDefaultTrack, type TimelineState } from '../types/timeline'
import { NbsMacroDialog } from './NbsMacroDialog'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      if (key === 'studio.nbs_macro_applied') {
        return `${values?.name} applied to ${values?.count} marker(s).`
      }
      if (key === 'studio.nbs_macro_preview_summary') {
        return `Changed ${values?.changed} · Added ${values?.added} · Deleted ${values?.deleted}`
      }
      if (key === 'studio.nbs_macro_preview_error') return `Preview unavailable: ${values?.error}`
      return ({
        'studio.nbs_macros_title': 'Note Block Studio macros',
        'studio.nbs_macro_label': 'Macro',
        'studio.nbs_macro_tremolo': 'Tremolo',
        'studio.nbs_macro_volume_lfo': 'Volume LFO',
        'studio.nbs_macro_set_velocity': 'Set velocity',
        'studio.nbs_macro_set_panning': 'Set panning',
        'studio.nbs_macro_set_pitch': 'Set pitch',
        'studio.nbs_macro_reset': 'Reset all properties',
        'studio.nbs_macro_preview_title': 'Preview',
        'studio.nbs_macro_preview_empty': 'Select markers to preview.',
        'studio.nbs_macro_preview_no_changes': 'No changes.',
        'studio.nbs_macro_apply': 'Apply macro',
        'studio.close': 'Close',
      }[key] ?? key)
    },
  }),
}))

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: vi.fn(),
  })
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
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

function project(): TimelineState {
  const track = createDefaultTrack('track')
  return {
    projectId: 'macros', randomSeed: 1, targetVersion: '1.21.4', lengthTicks: 200,
    settings: structuredClone(DEFAULT_SETTINGS), master: { ...DEFAULT_MASTER }, tracks: [track],
    markers: [{
      id: 'marker', trackId: track.id, tick: 10, soundId: 'block.note_block.harp',
      variantIndex: -1, volume: 0.8, pitch: 1, pan: 0,
    }],
  }
}

interface RenderDialogOptions {
  source?: TimelineState
  selectedIds?: ReadonlySet<string> | readonly string[]
  onApply?: (state: TimelineState, selectedIds: readonly string[]) => void | Promise<void>
  onClose?: () => void
}

function renderDialog(options: RenderDialogOptions = {}) {
  const source = options.source ?? project()
  const selectedIds = options.selectedIds ?? new Set(['marker'])
  const onApply = vi.fn(options.onApply ?? (() => undefined))
  const onClose = vi.fn(options.onClose ?? (() => undefined))
  render(
    <UIProvider>
      <NbsMacroDialog
        open project={source} selectedIds={selectedIds}
        onApply={onApply} onClose={onClose}
      />
    </UIProvider>,
  )
  return { source, selectedIds, onApply, onClose }
}

describe('NbsMacroDialog', () => {
  it('applies the default tremolo as one host update', async () => {
    const { onApply } = renderDialog()
    expect(onApply).not.toHaveBeenCalled()
    expect(screen.getByText('Changed 1 · Added 0 · Deleted 0')).toBeTruthy()
    expect(screen.getByText(/marker: .*duration — → 1.*retriggerInterval — → 1/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Apply macro' }))
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1))
    const [state, selected] = onApply.mock.calls[0] as [TimelineState, readonly string[]]
    expect(state.markers[0]).toMatchObject({ duration: 1, retriggerInterval: 1 })
    expect(selected).toEqual(['marker'])
    expect(screen.getByText(/Tremolo applied to 1 marker/)).toBeTruthy()
  })

  it('shows the complete 15-action selector and disables apply without a selection', async () => {
    renderDialog({ selectedIds: new Set() })
    fireEvent.click(screen.getByRole('combobox', { name: 'Macro' }))
    expect(await screen.findByRole('option', { name: 'Reset all properties' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Volume LFO' })).toBeTruthy()
    expect(screen.getAllByRole('option')).toHaveLength(15)
    expect(screen.getByText('Select markers to preview.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Apply macro' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('cancels and closes with Escape without changing the project', () => {
    const source = project()
    const before = structuredClone(source)
    const { onApply, onClose } = renderDialog({ source })

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onApply).not.toHaveBeenCalled()
    expect(source).toEqual(before)
  })

  it('uses Ctrl+Enter and an in-flight lock to invoke onApply only once', async () => {
    let release: (() => void) | undefined
    const onApply = vi.fn(() => new Promise<void>((resolve) => {
      release = resolve
    }))
    const onClose = vi.fn()
    renderDialog({ onApply, onClose })

    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true })
    fireEvent.click(screen.getByRole('button', { name: 'Apply macro' }))
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true })
    expect(onApply).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()

    await act(async () => release?.())
    await waitFor(() => expect(screen.getByText(/Tremolo applied to 1 marker/)).toBeTruthy())
  })

  it('applies the final option after consecutive macro changes', async () => {
    const { onApply } = renderDialog()
    const selector = screen.getByRole('combobox', { name: 'Macro' })
    fireEvent.click(selector)
    fireEvent.click(screen.getByText('Set panning'))
    fireEvent.click(selector)
    fireEvent.click(screen.getByText('Set pitch'))
    fireEvent.click(selector)
    fireEvent.click(screen.getByText('Set velocity'))

    expect(screen.getByText('Changed 1 · Added 0 · Deleted 0')).toBeTruthy()
    expect(screen.getByText(/marker: .*volume 0.8 → 1/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Apply macro' }))
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1))
    const [state] = onApply.mock.calls[0] as [TimelineState, readonly string[]]
    expect(state.markers[0]).toMatchObject({ volume: 1, pitch: 1, pan: 0 })
  })

  it('previews and applies only editable markers when locked markers are selected', async () => {
    const source = project()
    const lockedTrack = createDefaultTrack('locked-track', 1)
    lockedTrack.locked = true
    source.tracks.push(lockedTrack)
    source.markers.push({
      ...source.markers[0], id: 'locked-marker', trackId: lockedTrack.id, tick: 20,
    })
    const lockedBefore = structuredClone(source.markers[1])
    const { onApply } = renderDialog({
      source,
      selectedIds: new Set(['marker', 'locked-marker']),
    })

    expect(screen.getByText('Changed 1 · Added 0 · Deleted 0')).toBeTruthy()
    expect(screen.getByText(/locked tracks were skipped/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Apply macro' }))
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1))
    const [state, affected] = onApply.mock.calls[0] as [TimelineState, readonly string[]]
    expect(affected).toEqual(['marker'])
    expect(state.markers[1]).toEqual(lockedBefore)
  })

  it('disables Apply when the selection exceeds the processing bound', () => {
    const selectedIds = Array.from({ length: 10_001 }, (_, index) => `marker-${index}`)
    renderDialog({ selectedIds })

    expect(screen.getByRole('alert').textContent).toContain('at most 10000')
    expect((screen.getByRole('button', { name: 'Apply macro' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
