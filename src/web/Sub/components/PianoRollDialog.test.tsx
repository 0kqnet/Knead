// @vitest-environment jsdom

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { UIProvider } from '@yamada-ui/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MASTER,
  DEFAULT_SETTINGS,
  createDefaultTrack,
  type Marker,
  type TimelineState,
} from '../types/timeline'
import { PianoRollDialog } from './PianoRollDialog'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => ({
      'studio.piano_roll_title': 'Piano Roll',
      'studio.piano_roll_description': 'Edit timing and pitch.',
      'studio.piano_roll_filter': 'Piano roll filter',
      'studio.piano_roll_filter_selected': 'Selected markers',
      'studio.piano_roll_filter_track': `Current track: ${String(values?.name)}`,
      'studio.piano_roll_zoom_out': 'X−',
      'studio.piano_roll_zoom_in': 'X＋',
      'studio.piano_roll_fit': 'Fit',
      'studio.piano_roll_visible_count': `${String(values?.count)} visible`,
      'studio.piano_roll_selected_count': `${String(values?.count)} selected`,
      'studio.piano_roll_changed_count': `${String(values?.count)} changed`,
      'studio.piano_roll_grid_step': `Grid ${String(values?.count)}t`,
      'studio.piano_roll_locked_hint': 'Locked notes are read-only.',
      'studio.piano_roll_audition_key': `Audition ${String(values?.note)}`,
      'studio.piano_roll_grid': 'Piano roll note grid',
      'studio.piano_roll_note_label': `${String(values?.sound)}, ${String(values?.note)}, tick ${String(values?.tick)}, velocity ${String(values?.velocity)}, pan ${String(values?.pan)}`,
      'studio.piano_roll_inspector_count': `Edit ${String(values?.count)} notes`,
      'studio.piano_roll_inspector_empty': 'Select a note',
      'studio.piano_roll_velocity': 'Velocity',
      'studio.piano_roll_pan': 'Pan',
      'studio.piano_roll_duration': 'Duration',
      'studio.piano_roll_retrigger': 'Retrigger',
      'studio.piano_roll_error': `Failed: ${String(values?.error)}`,
      'studio.piano_roll_apply': `Apply ${String(values?.count)} changes`,
      'studio.cancel': 'Cancel',
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

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function marker(id: string, trackId: string, tick: number, pitch = 1): Marker {
  return {
    id,
    trackId,
    tick,
    soundId: `custom:${id}`,
    variantIndex: 4,
    volume: 0.75,
    pitch,
    pan: id === 'free' ? -0.4 : 0.5,
    duration: 8,
    retriggerInterval: 2,
  }
}

function project(): TimelineState {
  const freeTrack = { ...createDefaultTrack('free-track'), name: 'Free' }
  const lockedTrack = { ...createDefaultTrack('locked-track', 1), name: 'Locked', locked: true }
  return {
    projectId: 'piano-roll-project',
    randomSeed: 1,
    targetVersion: '1.21.4',
    lengthTicks: 200,
    settings: structuredClone(DEFAULT_SETTINGS),
    master: { ...DEFAULT_MASTER },
    tracks: [freeTrack, lockedTrack],
    markers: [
      marker('free', freeTrack.id, 10),
      marker('second', freeTrack.id, 30, 2 ** (4 / 12)),
      marker('locked', lockedTrack.id, 10),
    ],
    referenceAudio: [],
    customAudio: [],
  }
}

function renderDialog(overrides: Partial<React.ComponentProps<typeof PianoRollDialog>> = {}) {
  const onApply = vi.fn<React.ComponentProps<typeof PianoRollDialog>['onApply']>()
    .mockResolvedValue(undefined)
  const props: React.ComponentProps<typeof PianoRollDialog> = {
    open: true,
    project: project(),
    selectedIds: new Set(['free', 'locked']),
    currentTrackId: 'free-track',
    onApply,
    onClose: vi.fn(),
    ...overrides,
  }
  return {
    props,
    onApply,
    ...render(<UIProvider><PianoRollDialog {...props} /></UIProvider>),
  }
}

describe('PianoRollDialog editing', () => {
  it('drags timing/pitch, protects locked notes, and applies all edits in one callback', async () => {
    const { onApply } = renderDialog()
    const free = document.querySelector<HTMLElement>('[data-piano-roll-note="free"]')!
    const locked = document.querySelector<HTMLElement>('[data-piano-roll-note="locked"]')!
    expect(locked.getAttribute('aria-disabled')).toBe('true')

    fireEvent.pointerDown(free, { pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(free, { pointerId: 1, clientX: 160, clientY: 76 })
    fireEvent.pointerUp(free, { pointerId: 1, clientX: 160, clientY: 76 })

    const apply = await screen.findByRole('button', { name: 'Apply 1 changes' })
    fireEvent.click(apply)
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1))
    const [state, affected] = onApply.mock.calls[0]
    expect(affected).toEqual(['free'])
    expect(state.markers.find(item => item.id === 'free')).toMatchObject({
      tick: 15,
      pitch: 2 ** (1 / 12),
      soundId: 'custom:free',
      variantIndex: 4,
    })
    expect(state.markers.find(item => item.id === 'locked')).toEqual(project().markers[2])
  }, 10_000)

  it('uses tempo-aware beat steps for accessible arrow-key edits', async () => {
    const tempoProject = project()
    tempoProject.settings.snap.mode = 'beat'
    tempoProject.settings.snap.beatDivision = 4
    tempoProject.tempoMap = [
      { tick: 0, bpm: 120, meter: { numerator: 4, denominator: 4 } },
      { tick: 40, bpm: 60 },
    ]
    tempoProject.markers[0].tick = 40
    const { onApply } = renderDialog({
      project: tempoProject,
      tempoMap: tempoProject.tempoMap,
      selectedIds: new Set(['free']),
    })
    let free = document.querySelector<HTMLElement>('[data-piano-roll-note="free"]')!
    fireEvent.keyDown(free, { key: 'ArrowUp' })
    free = document.querySelector<HTMLElement>('[data-piano-roll-note="free"]')!
    fireEvent.keyDown(free, { key: 'ArrowRight' })

    fireEvent.click(await screen.findByRole('button', { name: 'Apply 1 changes' }))
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1))
    const changed = onApply.mock.calls[0][0].markers.find(item => item.id === 'free')!
    expect(changed).toMatchObject({ tick: 60, soundId: 'custom:free', variantIndex: 4 })
    expect(changed.pitch).toBeCloseTo(2 ** (1 / 12))
  })

  it('rectangle-selects notes on the current track', async () => {
    renderDialog({ selectedIds: new Set() })
    const grid = await screen.findByTestId('piano-roll-grid')
    fireEvent.pointerDown(grid, { pointerId: 2, clientX: 115, clientY: 285 })
    fireEvent.pointerMove(grid, { pointerId: 2, clientX: 135, clientY: 318 })
    expect(screen.getByTestId('piano-roll-selection-rectangle')).not.toBeNull()
    fireEvent.pointerUp(grid, { pointerId: 2, clientX: 135, clientY: 318 })

    await waitFor(() => {
      const free = document.querySelector<HTMLElement>('[data-piano-roll-note="free"]')!
      expect(free.getAttribute('aria-pressed')).toBe('true')
    })
  })

  it('keeps an additive selection through a click and discards a canceled group drag', async () => {
    const { onApply } = renderDialog({ selectedIds: new Set() })
    const grid = screen.getByTestId('piano-roll-grid')
    const free = grid.querySelector<HTMLElement>('[data-piano-roll-note="free"]')!
    const second = grid.querySelector<HTMLElement>('[data-piano-roll-note="second"]')!
    fireEvent.pointerDown(free, { pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerUp(grid, { pointerId: 1, clientX: 100, clientY: 100 })
    fireEvent.pointerDown(second, { ctrlKey: true, pointerId: 2, clientX: 160, clientY: 100 })
    fireEvent.pointerUp(grid, { pointerId: 2, clientX: 160, clientY: 100 })
    fireEvent.click(second, { ctrlKey: true })
    expect(screen.getByText('2 selected')).toBeTruthy()
    fireEvent.pointerDown(free, { pointerId: 3, clientX: 100, clientY: 100 })
    fireEvent.pointerMove(grid, { pointerId: 3, clientX: 160, clientY: 100 })
    fireEvent.pointerCancel(grid, { pointerId: 3 })
    expect(screen.getByRole('button', { name: 'Apply 0 changes' }).hasAttribute('disabled')).toBe(true)
    fireEvent.keyDown(free, { key: 'ArrowUp' })
    fireEvent.click(screen.getByRole('button', { name: 'Apply 2 changes' }))
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1))
    expect(onApply.mock.calls[0][1]).toEqual(['free', 'second'])
  })

  it('delegates keyboard audition without mutating the draft', async () => {
    const onAudition = vi.fn<NonNullable<React.ComponentProps<typeof PianoRollDialog>['onAudition']>>()
      .mockResolvedValue(undefined)
    const { onApply } = renderDialog({ selectedIds: new Set(['free']), onAudition })

    fireEvent.click(await screen.findByRole('button', { name: 'Audition C4' }))
    await waitFor(() => expect(onAudition).toHaveBeenCalledTimes(1))
    expect(onAudition.mock.calls[0][0]).toMatchObject({ soundId: 'custom:free', pitch: 1 })
    expect(screen.getByRole('button', { name: 'Apply 0 changes' }).hasAttribute('disabled')).toBe(true)
    expect(onApply).not.toHaveBeenCalled()
  })
})
