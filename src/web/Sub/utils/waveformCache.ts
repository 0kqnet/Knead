import { buildWaveformPeaks, type AudioBufferSamples, type WaveformPeaks } from './waveformPeaks'

export interface CachedAudioWaveform {
  hash: string
  variantIndex: number
  basePitch: number
  waveform: WaveformPeaks
}

const waveformsByHash = new Map<string, WaveformPeaks>()
const variants = new Map<string, CachedAudioWaveform>()
const listeners = new Set<() => void>()

function variantKey(soundId: string, variantIndex: number): string {
  return `${soundId}\u0000${variantIndex}`
}

function emitChange(): void {
  for (const listener of listeners) listener()
}

export function subscribeAudioWaveforms(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function cacheDecodedAudioWaveform(
  soundId: string,
  variantIndex: number,
  hash: string,
  basePitch: number,
  buffer: AudioBufferSamples,
): CachedAudioWaveform {
  let waveform = waveformsByHash.get(hash)
  if (!waveform) {
    waveform = buildWaveformPeaks(buffer)
    waveformsByHash.set(hash, waveform)
  }
  const key = variantKey(soundId, variantIndex)
  const current = variants.get(key)
  if (
    current
    && current.hash === hash
    && current.basePitch === basePitch
    && current.waveform === waveform
  ) return current

  const cached = { hash, variantIndex, basePitch, waveform }
  variants.set(key, cached)
  emitChange()
  return cached
}

/** Random markers use variant zero as a deterministic visual representative. */
export function getCachedAudioWaveform(
  soundId: string,
  variantIndex: number,
): CachedAudioWaveform | undefined {
  return variants.get(variantKey(soundId, variantIndex < 0 ? 0 : variantIndex))
}

export function clearCachedAudioWaveforms(): void {
  if (variants.size === 0 && waveformsByHash.size === 0) return
  variants.clear()
  waveformsByHash.clear()
  emitChange()
}
