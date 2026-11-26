// @vitest-environment jsdom

import React from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type ReferenceAudioTrack } from '../types/timeline'
import { buildWaveformPeaks } from '../utils/waveformPeaks'
import { ReferenceAudioTrackRow } from './ReferenceAudioTrackRow'

beforeEach(() => {
  vi.stubGlobal('matchMedia', (media: string) => ({
    media, matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(),
  }))
})

afterEach(() => vi.unstubAllGlobals())

const track: ReferenceAudioTrack = {
  id: 'reference',
  name: 'Guide',
  color: 'cyan',
  fileName: 'guide.wav',
  sourcePath: 'guide.wav',
  mimeType: 'audio/wav',
  byteLength: 12,
  fingerprint: '1234abcd',
  dataBase64: 'UklGRgAAAABXQVZF',
  durationSeconds: 4,
  offsetTicks: 20,
  gainDb: 0,
  pan: 0,
  muted: false,
  solo: false,
  locked: false,
  collapsed: false,
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function renderRow(overrides: Partial<React.ComponentProps<typeof ReferenceAudioTrackRow>> = {}) {
  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverMock)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    clearRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
    closePath: vi.fn(), fill: vi.fn(), stroke: vi.fn(), globalAlpha: 1,
    fillStyle: '', strokeStyle: '', lineWidth: 1,
  } as unknown as CanvasRenderingContext2D)
  const callbacks = {
    onChange: vi.fn(),
    onRemove: vi.fn(),
    onBeginEdit: vi.fn(),
    onEndEdit: vi.fn(),
    onSeek: vi.fn(),
  }
  const waveform = buildWaveformPeaks({
    length: 8,
    sampleRate: 2,
    numberOfChannels: 1,
    getChannelData: () => Float32Array.from([-1, 0, 1, 0, -1, 0, 1, 0]),
  })
  const view = render(
    <ReferenceAudioTrackRow
      track={track}
      waveform={waveform}
      lengthTicks={200}
      pxPerTick={4}
      settings={structuredClone(DEFAULT_SETTINGS)}
      {...callbacks}
      {...overrides}
    />,
  )
  return { ...view, callbacks }
}

describe('ReferenceAudioTrackRow', () => {
  it('renders a cached waveform at the saved offset', () => {
    const { container } = renderRow()
    const clip = container.querySelector<HTMLElement>('[data-reference-audio-clip="reference"]')
    const canvas = container.querySelector<HTMLCanvasElement>('[data-waveform-canvas]')
    expect(clip?.dataset.referenceAudioLeft).toBe('92')
    expect(canvas?.dataset.waveformPlaybackRate).toBe('1')
  })

  it('moves offset as one transactional drag and exposes mute/solo controls', () => {
    const { container, getByTitle, callbacks } = renderRow()
    const clip = container.querySelector<HTMLElement>('[data-reference-audio-clip="reference"]')
    if (!clip) throw new Error('reference clip missing')
    fireEvent.pointerDown(clip, { button: 0, clientX: 100 })
    fireEvent.pointerMove(window, { clientX: 120 })
    fireEvent.pointerUp(window, { clientX: 120 })
    expect(callbacks.onBeginEdit).toHaveBeenCalledOnce()
    expect(callbacks.onChange).toHaveBeenCalledWith({ offsetTicks: 25 })
    expect(callbacks.onEndEdit).toHaveBeenCalledOnce()

    fireEvent.click(getByTitle('Mute reference audio'))
    fireEvent.click(getByTitle('Solo reference audio'))
    expect(callbacks.onChange).toHaveBeenCalledWith({ muted: true })
    expect(callbacks.onChange).toHaveBeenCalledWith({ solo: true })
  })

  it('snaps offset dragging to the active tempo-map beat grid', () => {
    const settings = structuredClone(DEFAULT_SETTINGS)
    settings.snap = { mode: 'beat', tickStep: 1, beatDivision: 4 }
    const { container, callbacks } = renderRow({
      settings,
      tempoMap: [
        { tick: 0, bpm: 120, meter: { numerator: 4, denominator: 4 } },
        { tick: 25, bpm: 120, meter: { numerator: 3, denominator: 4 } },
      ],
    })
    const clip = container.querySelector<HTMLElement>('[data-reference-audio-clip="reference"]')
    if (!clip) throw new Error('reference clip missing')
    fireEvent.pointerDown(clip, { button: 0, clientX: 100 })
    fireEvent.pointerMove(window, { clientX: 124 })
    fireEvent.pointerUp(window, { clientX: 124 })
    expect(callbacks.onChange).toHaveBeenCalledWith({ offsetTicks: 25 })
  })
})
