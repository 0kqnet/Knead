// @vitest-environment jsdom

import React from 'react'
import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearCachedAudioWaveforms, cacheDecodedAudioWaveform } from '../utils/waveformCache'
import { TimelineWaveform } from './TimelineWaveform'

afterEach(() => {
  clearCachedAudioWaveforms()
  vi.restoreAllMocks()
})

describe('TimelineWaveform', () => {
  it('renders the cached variant with pitch and visual state applied', () => {
    const context = {
      clearRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      closePath: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      globalAlpha: 1,
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
    }
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(context as unknown as CanvasRenderingContext2D)
    cacheDecodedAudioWaveform('sound', 0, 'hash', 1.25, {
      length: 8,
      sampleRate: 8,
      numberOfChannels: 1,
      getChannelData: () => Float32Array.from([-1, -0.5, 0, 0.5, 1, 0.5, 0, -0.5]),
    })

    const { container } = render(
      <TimelineWaveform
        soundId="sound"
        variantIndex={0}
        pitch={2}
        durationTicks={20}
        retriggerIntervalTicks={5}
        width={120}
        height={12}
        color="#38bdf8"
        selected
        muted
      />,
    )
    const canvas = container.querySelector<HTMLCanvasElement>('[data-waveform-canvas]')

    expect(canvas?.dataset.waveformPlaybackRate).toBe('2.5')
    expect(canvas?.dataset.waveformSelected).toBe('true')
    expect(canvas?.dataset.waveformMuted).toBe('true')
    expect(canvas?.style.width).toBe('120px')
    expect(context.fill).toHaveBeenCalledOnce()
  })

  it('uses an extended marker pitch times the cached variant base pitch without clamping', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      clearRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(),
      closePath: vi.fn(), fill: vi.fn(), stroke: vi.fn(), globalAlpha: 1,
      fillStyle: '', strokeStyle: '', lineWidth: 1,
    } as unknown as CanvasRenderingContext2D)
    cacheDecodedAudioWaveform('extended', 0, 'extended-hash', 1.25, {
      length: 8, sampleRate: 8, numberOfChannels: 1,
      getChannelData: () => Float32Array.from([0, 1, 0, -1, 0, 1, 0, -1]),
    })
    const { container } = render(
      <TimelineWaveform
        soundId="extended" variantIndex={0} pitch={64} durationTicks={20}
        width={120} height={12} color="#38bdf8" selected={false} muted={false}
      />,
    )
    expect(container.querySelector<HTMLCanvasElement>('[data-waveform-canvas]')
      ?.dataset.waveformPlaybackRate).toBe('80')
  })
})
