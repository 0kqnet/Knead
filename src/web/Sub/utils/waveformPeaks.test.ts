import { describe, expect, it } from 'vitest'
import {
  aggregateWaveformPeakLevel,
  buildWaveformPeaks,
  chooseWaveformPeakLevel,
  extractWaveformPeakLevel,
  getWaveformViewport,
  type AudioBufferSamples,
} from './waveformPeaks'

function audioBuffer(...channels: number[][]): AudioBufferSamples {
  const data = channels.map(channel => Float32Array.from(channel))
  return {
    length: Math.max(0, ...data.map(channel => channel.length)),
    sampleRate: 100,
    numberOfChannels: data.length,
    getChannelData: channel => data[channel],
  }
}

function expectPeaks(actual: Float32Array, expected: number[]): void {
  expect(actual).toHaveLength(expected.length)
  expected.forEach((value, index) => expect(actual[index]).toBeCloseTo(value))
}

describe('waveform peak extraction', () => {
  it('extracts interleaved minimum and maximum buckets from mono audio', () => {
    const level = extractWaveformPeakLevel(
      audioBuffer([0.25, -0.5, 0.75, 1, -0.25]),
      2,
    )

    expect(level.samplesPerPeak).toBe(2)
    expect(level.peakCount).toBe(3)
    expectPeaks(level.peaks, [-0.5, 0.25, 0, 1, -0.25, 0])
  })

  it('combines channels and preserves a transient from either stereo side', () => {
    const level = extractWaveformPeakLevel(audioBuffer(
      [-0.25, 0.1, 0.2, 0.3],
      [-0.8, 0.4, 1.2, -0.1],
    ), 4)

    expect(level.peakCount).toBe(1)
    expectPeaks(level.peaks, [-0.8, 1.2])
  })

  it('aggregates cached peaks into a multi-resolution pyramid', () => {
    const waveform = buildWaveformPeaks(
      audioBuffer([-1, 0.2, -0.3, 0.8, -0.7, 0.1, -0.2, 1]),
      { baseSamplesPerPeak: 2, scale: 2 },
    )

    expect(waveform.levels.map(level => level.samplesPerPeak)).toEqual([2, 4, 8])
    expect(waveform.levels.map(level => level.peakCount)).toEqual([4, 2, 1])
    expectPeaks(waveform.levels[1].peaks, [-1, 0.8, -0.7, 1])
    expectPeaks(waveform.levels[2].peaks, [-1, 1])
  })

  it('aggregates a partial final group', () => {
    const source = extractWaveformPeakLevel(audioBuffer([-0.5, 0.2, -0.1]), 1)
    const aggregated = aggregateWaveformPeakLevel(source, 2)

    expect(aggregated.peakCount).toBe(2)
    expectPeaks(aggregated.peaks, [-0.5, 0.2, -0.1, 0])
  })

  it('chooses a peak level that matches the visible pixel density', () => {
    const waveform = buildWaveformPeaks(
      audioBuffer(Array.from({ length: 256 }, (_, index) => Math.sin(index))),
      { baseSamplesPerPeak: 2, scale: 4 },
    )

    expect(chooseWaveformPeakLevel(waveform, 256, 128).samplesPerPeak).toBe(2)
    expect(chooseWaveformPeakLevel(waveform, 256, 16).samplesPerPeak).toBe(8)
    expect(chooseWaveformPeakLevel(waveform, 256, 2).samplesPerPeak).toBe(128)
  })
})

describe('waveform timeline scaling', () => {
  const waveform = {
    duration: 2,
    length: 200,
    sampleRate: 100,
  }

  it('crops source samples when the marker is shorter than the pitched clip', () => {
    expect(getWaveformViewport(waveform, 0.5, 0.5)).toEqual({
      sourceSampleEnd: 25,
      activeFraction: 1,
    })
  })

  it('compresses a high-pitch clip and leaves silence after its natural end', () => {
    expect(getWaveformViewport(waveform, 2, 2)).toEqual({
      sourceSampleEnd: 200,
      activeFraction: 0.5,
    })
  })

  it('keeps extended low/high rates exact and rejects invalid duration inputs', () => {
    expect(getWaveformViewport(waveform, 10, 1 / 512)).toEqual({
      sourceSampleEnd: 2,
      activeFraction: 1,
    })
    expect(getWaveformViewport(waveform, 2, 256)).toEqual({
      sourceSampleEnd: 200,
      activeFraction: 1 / 256,
    })
    expect(getWaveformViewport(waveform, 2, 0)).toEqual({
      sourceSampleEnd: 0,
      activeFraction: 0,
    })
  })
})
