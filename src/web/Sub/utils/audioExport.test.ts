import { describe, expect, it } from 'vitest'
import type { AudioExportOptions } from '../../../../@types/global'
import {
  compatibleSampleRatePresets,
  formatSampleRate,
  isCodecSampleRateSupported,
  isValidMp3RateBitrate,
  restoreAudioExportOptions,
  validateAudioExportOptions,
} from './audioExport'

const options = (patch: Partial<AudioExportOptions> = {}): AudioExportOptions => ({
  format: 'wav',
  targets: ['mix'],
  sampleRate: 48_000,
  channels: 2,
  wavBitDepth: 24,
  oggQuality: 5,
  mp3Bitrate: 192,
  range: 'project',
  includeTails: true,
  includeMutedTracks: false,
  ...patch,
})

describe('audio export options', () => {
  it('accepts the requested lossless sample-rate boundaries', () => {
    for (const format of ['wav', 'aiff', 'flac'] as const) {
      expect(validateAudioExportOptions(options({ format, sampleRate: 8_000 }))).toBeNull()
      expect(validateAudioExportOptions(options({ format, sampleRate: 384_000 }))).toBeNull()
    }
  })

  it('strictly rejects fractional and out-of-range rates', () => {
    expect(validateAudioExportOptions(options({ sampleRate: 7_999 }))).toBe('sample-rate-range')
    expect(validateAudioExportOptions(options({ sampleRate: 384_001 }))).toBe('sample-rate-range')
    expect(validateAudioExportOptions(options({ sampleRate: 44_100.5 }))).toBe('sample-rate-range')
  })

  it('applies Ogg and MP3 codec limits', () => {
    expect(validateAudioExportOptions(options({ format: 'ogg', sampleRate: 200_000 }))).toBeNull()
    expect(validateAudioExportOptions(options({ format: 'ogg', sampleRate: 200_001 }))).toBe('ogg-sample-rate')
    expect(isValidMp3RateBitrate(8_000, 64)).toBe(true)
    expect(isValidMp3RateBitrate(8_000, 128)).toBe(false)
    expect(isValidMp3RateBitrate(48_000, 320)).toBe(true)
    expect(validateAudioExportOptions(options({
      format: 'mp3', sampleRate: 8_000, mp3Bitrate: 128,
    }))).toBe('mp3-rate-bitrate')
  })

  it('only offers practical presets supported by the selected codec settings', () => {
    expect(compatibleSampleRatePresets(options({ format: 'flac' }))).toContain(384_000)
    expect(compatibleSampleRatePresets(options({ format: 'ogg' }))).not.toContain(384_000)
    expect(compatibleSampleRatePresets(options({ format: 'mp3', mp3Bitrate: 320 })))
      .toEqual([32_000, 44_100, 48_000])
    expect(isCodecSampleRateSupported('mp3', 96_000, 320)).toBe(false)
  })

  it('formats integer and fractional-kHz labels without misleading rounding', () => {
    expect(formatSampleRate(48_000)).toBe('48 kHz')
    expect(formatSampleRate(44_100)).toBe('44.1 kHz')
    expect(formatSampleRate(11_025)).toBe('11.025 kHz')
  })

  it('restores only bounded, correctly typed local preferences', () => {
    expect(restoreAudioExportOptions(options(), {
      format: 'flac',
      targets: null,
      sampleRate: 384_000,
      channels: '2',
      wavBitDepth: 24,
      mp3Bitrate: 999,
      includeTails: false,
    })).toEqual(options({
      format: 'flac',
      sampleRate: 384_000,
      wavBitDepth: 24,
      includeTails: false,
    }))
    expect(restoreAudioExportOptions(options(), {
      format: 'mp3', sampleRate: 96_000, mp3Bitrate: 192,
    }).sampleRate).toBe(48_000)
  })
})
