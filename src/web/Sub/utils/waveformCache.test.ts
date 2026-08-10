import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cacheDecodedAudioWaveform,
  clearCachedAudioWaveforms,
  getCachedAudioWaveform,
  subscribeAudioWaveforms,
} from './waveformCache'

const buffer = {
  length: 4,
  sampleRate: 4,
  numberOfChannels: 1,
  getChannelData: () => Float32Array.from([-1, -0.5, 0.5, 1]),
}

afterEach(clearCachedAudioWaveforms)

describe('decoded waveform cache', () => {
  it('shares peak storage for variants with the same asset hash', () => {
    const first = cacheDecodedAudioWaveform('first', 0, 'shared', 1, buffer)
    const second = cacheDecodedAudioWaveform('second', 2, 'shared', 1.25, buffer)

    expect(second.waveform).toBe(first.waveform)
    expect(getCachedAudioWaveform('second', 2)?.basePitch).toBe(1.25)
  })

  it('uses variant zero as the stable preview for a random marker', () => {
    const cached = cacheDecodedAudioWaveform('sound', 0, 'hash', 1, buffer)

    expect(getCachedAudioWaveform('sound', -1)).toBe(cached)
  })

  it('notifies subscribers when a decoded waveform becomes available', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeAudioWaveforms(listener)

    cacheDecodedAudioWaveform('sound', 0, 'hash', 1, buffer)
    expect(listener).toHaveBeenCalledOnce()
    unsubscribe()
  })
})
