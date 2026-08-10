import type { AudioExportOptions } from '../../../../@types/global'

export const MIN_AUDIO_EXPORT_SAMPLE_RATE = 8_000
export const MAX_AUDIO_EXPORT_SAMPLE_RATE = 384_000
export const MAX_OGG_SAMPLE_RATE = 200_000

export const PRACTICAL_AUDIO_EXPORT_SAMPLE_RATES = [
  8_000,
  11_025,
  12_000,
  16_000,
  22_050,
  24_000,
  32_000,
  44_100,
  48_000,
  88_200,
  96_000,
  176_400,
  192_000,
  352_800,
  384_000,
] as const

export const MP3_BITRATES = [
  8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 192, 224, 256, 320,
] as const satisfies readonly AudioExportOptions['mp3Bitrate'][]

const MP3_SAMPLE_RATES = new Set([8_000, 11_025, 12_000, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000])
const LOSSLESS_FORMATS = new Set<AudioExportOptions['format']>(['wav', 'aiff', 'flac'])
const EXPORT_FORMATS = new Set<AudioExportOptions['format']>(['wav', 'aiff', 'flac', 'ogg', 'mp3'])

export type AudioExportValidationError =
  | 'sample-rate-range'
  | 'ogg-sample-rate'
  | 'mp3-sample-rate'
  | 'mp3-bitrate'
  | 'mp3-rate-bitrate'
  | 'channels'
  | 'bit-depth'
  | 'ogg-quality'
  | 'targets'
  | 'range'

export function isLosslessExportFormat(format: AudioExportOptions['format']): boolean {
  return LOSSLESS_FORMATS.has(format)
}

export function isValidMp3RateBitrate(sampleRate: number, bitrate: number): boolean {
  if (!MP3_SAMPLE_RATES.has(sampleRate) || !MP3_BITRATES.some(value => value === bitrate)) {
    return false
  }
  if (sampleRate <= 12_000) return bitrate <= 64
  if (sampleRate <= 24_000) return bitrate <= 160
  return bitrate >= 32
}

export function isCodecSampleRateSupported(
  format: AudioExportOptions['format'],
  sampleRate: number,
  mp3Bitrate: number,
): boolean {
  if (!Number.isInteger(sampleRate)
    || sampleRate < MIN_AUDIO_EXPORT_SAMPLE_RATE
    || sampleRate > MAX_AUDIO_EXPORT_SAMPLE_RATE) {
    return false
  }
  if (format === 'ogg') return sampleRate <= MAX_OGG_SAMPLE_RATE
  if (format === 'mp3') return isValidMp3RateBitrate(sampleRate, mp3Bitrate)
  return true
}

export function compatibleSampleRatePresets(options: Pick<AudioExportOptions, 'format' | 'mp3Bitrate'>): number[] {
  return PRACTICAL_AUDIO_EXPORT_SAMPLE_RATES.filter(sampleRate => (
    isCodecSampleRateSupported(options.format, sampleRate, options.mp3Bitrate)
  ))
}

export function validateAudioExportOptions(options: AudioExportOptions): AudioExportValidationError | null {
  if (!Number.isInteger(options.sampleRate)
    || options.sampleRate < MIN_AUDIO_EXPORT_SAMPLE_RATE
    || options.sampleRate > MAX_AUDIO_EXPORT_SAMPLE_RATE) {
    return 'sample-rate-range'
  }
  if (options.format === 'ogg' && options.sampleRate > MAX_OGG_SAMPLE_RATE) {
    return 'ogg-sample-rate'
  }
  if (options.format === 'mp3') {
    if (!MP3_SAMPLE_RATES.has(options.sampleRate)) return 'mp3-sample-rate'
    if (!MP3_BITRATES.some(value => value === options.mp3Bitrate)) return 'mp3-bitrate'
    if (!isValidMp3RateBitrate(options.sampleRate, options.mp3Bitrate)) return 'mp3-rate-bitrate'
  }
  if (options.channels !== 1 && options.channels !== 2) return 'channels'
  if (![16, 24, 32].includes(options.wavBitDepth)) return 'bit-depth'
  if (!Number.isFinite(options.oggQuality)
    || options.oggQuality < 0
    || options.oggQuality > 10) {
    return 'ogg-quality'
  }
  if (options.targets.length === 0
    || options.targets.some(target => target !== 'mix' && target !== 'stems')) {
    return 'targets'
  }
  if (options.range !== 'project' && options.range !== 'loop') return 'range'
  return null
}

export function formatSampleRate(sampleRate: number): string {
  const khz = sampleRate / 1000
  return `${Number.isInteger(khz) ? khz.toFixed(0) : khz.toFixed(3).replace(/0+$/, '')} kHz`
}

export function restoreAudioExportOptions(
  defaults: AudioExportOptions,
  stored: unknown,
): AudioExportOptions {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return { ...defaults }
  const value = stored as Record<string, unknown>
  const result = { ...defaults }
  if (typeof value.format === 'string'
    && EXPORT_FORMATS.has(value.format as AudioExportOptions['format'])) {
    result.format = value.format as AudioExportOptions['format']
  }
  if (Array.isArray(value.targets)) {
    const targets = Array.from(new Set(value.targets.filter(
      (target): target is 'mix' | 'stems' => target === 'mix' || target === 'stems',
    )))
    if (targets.length > 0) result.targets = targets
  }
  if (typeof value.sampleRate === 'number' && Number.isFinite(value.sampleRate)) {
    result.sampleRate = value.sampleRate
  }
  if (value.channels === 1 || value.channels === 2) result.channels = value.channels
  if (value.wavBitDepth === 16 || value.wavBitDepth === 24 || value.wavBitDepth === 32) {
    result.wavBitDepth = value.wavBitDepth
  }
  if (typeof value.oggQuality === 'number' && Number.isFinite(value.oggQuality)) {
    result.oggQuality = value.oggQuality
  }
  if (typeof value.mp3Bitrate === 'number'
    && MP3_BITRATES.some(bitrate => bitrate === value.mp3Bitrate)) {
    result.mp3Bitrate = value.mp3Bitrate as AudioExportOptions['mp3Bitrate']
  }
  if (value.range === 'project' || value.range === 'loop') result.range = value.range
  if (typeof value.includeTails === 'boolean') result.includeTails = value.includeTails
  if (typeof value.includeMutedTracks === 'boolean') {
    result.includeMutedTracks = value.includeMutedTracks
  }
  if (!isCodecSampleRateSupported(result.format, result.sampleRate, result.mp3Bitrate)) {
    const presets = compatibleSampleRatePresets(result)
    result.sampleRate = presets.includes(48_000) ? 48_000 : (presets[0] ?? defaults.sampleRate)
  }
  return result
}
