// @vitest-environment jsdom

import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { UIProvider } from '@yamada-ui/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createDefaultTrack, type Marker } from '../types/timeline'
import { TimelinePropertyPanel } from './TimelinePropertyPanel'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'studio.sound_stopper_title': 'Sound Stopper',
      'studio.sound_stopper_start_track': 'Sound Stopper start track',
      'studio.sound_stopper_end_track': 'Sound Stopper end track',
      'studio.sound_stopper_scope': 'Sound Stopper scope',
      'studio.sound_stopper_mixed': 'Mixed',
      'studio.marker_gate_ticks': 'Marker gate ticks',
      'studio.marker_gate_sample_tail': '0 = Sample tail',
    } as Record<string, string>)[key] ?? key,
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
  Object.defineProperty(window, 'ResizeObserver', {
    configurable: true,
    value: class ResizeObserver {
      observe() { /* noop */ }
      unobserve() { /* noop */ }
      disconnect() { /* noop */ }
    },
  })
})

afterEach(cleanup)

describe('TimelinePropertyPanel Sound Stopper inspector', () => {
  it('edits a one-based inclusive stop range without exposing audio controls', () => {
    const tracks = [createDefaultTrack('a'), createDefaultTrack('b'), createDefaultTrack('c')]
    const marker: Marker = {
      id: 'stop',
      trackId: 'b',
      tick: 12,
      soundId: '',
      variantIndex: -1,
      volume: 1,
      pitch: 1,
      pan: 0,
      action: { type: 'sound-stop', scope: 'track-range', startTrack: 1, endTrack: 3 },
    }
    const onChange = vi.fn()
    render(
      <UIProvider disableEnvironment disableGlobalStyle disableResetStyle>
        <TimelinePropertyPanel
          marker={marker}
          selectionCount={1}
          selectedMarkers={[marker]}
          tracks={tracks}
          soundIdList={['block.note_block.harp']}
          variants={[]}
          onChange={onChange}
          onShiftTick={vi.fn()}
          onBeginEdit={vi.fn()}
          onEndEdit={vi.fn()}
          soundFocusRequest={0}
          onSoundFocusHandled={vi.fn()}
        />
      </UIProvider>,
    )

    expect(screen.getByText('Sound Stopper')).toBeTruthy()
    expect(screen.queryByText('Volume')).toBeNull()
    expect(screen.queryByLabelText('Marker gate ticks')).toBeNull()
    fireEvent.change(screen.getByLabelText('Sound Stopper start track'), {
      target: { value: '2' },
    })
    expect(onChange).toHaveBeenLastCalledWith({
      action: {
        type: 'sound-stop',
        scope: 'track-range',
        startTrack: 2,
        endTrack: 3,
      },
    })
  })

  it('shows an exact extended pitch input without mutating it through the Minecraft slider', () => {
    const track = createDefaultTrack('track')
    const marker: Marker = {
      id: 'extended', trackId: track.id, tick: 0,
      soundId: 'block.note_block.harp', variantIndex: -1,
      volume: 1, pitch: 64,
    }
    const onChange = vi.fn()
    render(
      <UIProvider disableEnvironment disableGlobalStyle disableResetStyle>
        <TimelinePropertyPanel
          marker={marker} selectionCount={1} selectedMarkers={[marker]} tracks={[track]}
          soundIdList={['block.note_block.harp']} variants={[]} onChange={onChange}
          onShiftTick={vi.fn()} onBeginEdit={vi.fn()} onEndEdit={vi.fn()}
          soundFocusRequest={0} onSoundFocusHandled={vi.fn()}
        />
      </UIProvider>,
    )

    expect((screen.getByLabelText('Marker pitch') as HTMLInputElement).value).toBe('64')
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Marker pitch'), { target: { value: '128' } })
    expect(onChange).toHaveBeenLastCalledWith({ pitch: 128 })
  })

  it('emits one multi-marker gate patch and maps zero back to sample tail', () => {
    const track = createDefaultTrack('track')
    const first: Marker = {
      id: 'first', trackId: track.id, tick: 1,
      soundId: 'block.note_block.harp', variantIndex: -1,
      volume: 1, pitch: 1, gateTicks: 4,
    }
    const second: Marker = { ...first, id: 'second', tick: 2, gateTicks: 8 }
    const onChange = vi.fn()
    render(
      <UIProvider disableEnvironment disableGlobalStyle disableResetStyle>
        <TimelinePropertyPanel
          marker={first}
          selectionCount={2}
          selectedMarkers={[first, second]}
          tracks={[track]}
          soundIdList={['block.note_block.harp']}
          variants={[]}
          onChange={onChange}
          onShiftTick={vi.fn()}
          onBeginEdit={vi.fn()}
          onEndEdit={vi.fn()}
          soundFocusRequest={0}
          onSoundFocusHandled={vi.fn()}
        />
      </UIProvider>,
    )

    const gate = screen.getByLabelText('Marker gate ticks')
    fireEvent.change(gate, { target: { value: '12' } })
    expect(onChange).toHaveBeenLastCalledWith({ gateTicks: 12 })
    fireEvent.change(gate, { target: { value: '0' } })
    expect(onChange).toHaveBeenLastCalledWith({ gateTicks: undefined })
    expect(screen.getByText('0 = Sample tail')).toBeTruthy()
  })
})
