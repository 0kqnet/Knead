export interface AudioBufferSamples {
  length: number
  sampleRate: number
  numberOfChannels: number
  getChannelData: (channel: number) => Float32Array
}

/** Interleaved minimum/maximum pairs for fixed-size source-sample buckets. */
export interface WaveformPeakLevel {
  samplesPerPeak: number
  peaks: Float32Array
  peakCount: number
}

export interface WaveformPeaks {
  length: number
  sampleRate: number
  duration: number
  numberOfChannels: number
  levels: WaveformPeakLevel[]
}

export interface WaveformPeakOptions {
  baseSamplesPerPeak?: number
  scale?: number
  maxLevels?: number
}

export interface WaveformViewport {
  sourceSampleEnd: number
  activeFraction: number
}

export const DEFAULT_WAVEFORM_SAMPLES_PER_PEAK = 32
export const DEFAULT_WAVEFORM_LEVEL_SCALE = 4
export const DEFAULT_WAVEFORM_MAX_LEVELS = 12

function positiveInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 1) throw new RangeError(`${name} must be at least 1`)
  return Math.floor(value)
}

/**
 * Extracts one peak-envelope level. Channels are combined so the preview never
 * hides a transient that only exists on one side of a stereo asset.
 */
export function extractWaveformPeakLevel(
  buffer: AudioBufferSamples,
  samplesPerPeak: number,
): WaveformPeakLevel {
  const bucketSize = positiveInteger(samplesPerPeak, 'samplesPerPeak')
  const length = Math.max(0, Math.floor(buffer.length))
  const channelCount = Math.max(0, Math.floor(buffer.numberOfChannels))
  const peakCount = length === 0 ? 0 : Math.ceil(length / bucketSize)
  const peaks = new Float32Array(peakCount * 2)
  if (peakCount === 0 || channelCount === 0) {
    return { samplesPerPeak: bucketSize, peaks, peakCount }
  }

  const channels = Array.from(
    { length: channelCount },
    (_, channel) => buffer.getChannelData(channel),
  )

  for (let peakIndex = 0; peakIndex < peakCount; peakIndex++) {
    const start = peakIndex * bucketSize
    const end = Math.min(length, start + bucketSize)
    // Including zero gives a stable centre line for entirely positive/negative buckets.
    let minimum = 0
    let maximum = 0
    for (const channel of channels) {
      const channelEnd = Math.min(end, channel.length)
      for (let sampleIndex = start; sampleIndex < channelEnd; sampleIndex++) {
        const sample = channel[sampleIndex]
        if (!Number.isFinite(sample)) continue
        minimum = Math.min(minimum, sample)
        maximum = Math.max(maximum, sample)
      }
    }
    peaks[peakIndex * 2] = minimum
    peaks[peakIndex * 2 + 1] = maximum
  }

  return { samplesPerPeak: bucketSize, peaks, peakCount }
}

/** Builds a coarser level from an existing level without touching AudioBuffer again. */
export function aggregateWaveformPeakLevel(
  source: WaveformPeakLevel,
  scale: number,
): WaveformPeakLevel {
  const levelScale = positiveInteger(scale, 'scale')
  if (levelScale < 2) throw new RangeError('scale must be at least 2')
  const peakCount = source.peakCount === 0 ? 0 : Math.ceil(source.peakCount / levelScale)
  const peaks = new Float32Array(peakCount * 2)

  for (let peakIndex = 0; peakIndex < peakCount; peakIndex++) {
    const start = peakIndex * levelScale
    const end = Math.min(source.peakCount, start + levelScale)
    let minimum = 0
    let maximum = 0
    for (let sourceIndex = start; sourceIndex < end; sourceIndex++) {
      minimum = Math.min(minimum, source.peaks[sourceIndex * 2])
      maximum = Math.max(maximum, source.peaks[sourceIndex * 2 + 1])
    }
    peaks[peakIndex * 2] = minimum
    peaks[peakIndex * 2 + 1] = maximum
  }

  return {
    samplesPerPeak: source.samplesPerPeak * levelScale,
    peaks,
    peakCount,
  }
}

/** Creates a compact, multi-resolution peak pyramid suitable for zoomable canvases. */
export function buildWaveformPeaks(
  buffer: AudioBufferSamples,
  options: WaveformPeakOptions = {},
): WaveformPeaks {
  const baseSamplesPerPeak = positiveInteger(
    options.baseSamplesPerPeak ?? DEFAULT_WAVEFORM_SAMPLES_PER_PEAK,
    'baseSamplesPerPeak',
  )
  const scale = positiveInteger(options.scale ?? DEFAULT_WAVEFORM_LEVEL_SCALE, 'scale')
  if (scale < 2) throw new RangeError('scale must be at least 2')
  const maxLevels = positiveInteger(options.maxLevels ?? DEFAULT_WAVEFORM_MAX_LEVELS, 'maxLevels')
  const length = Math.max(0, Math.floor(buffer.length))
  const sampleRate = Number.isFinite(buffer.sampleRate) && buffer.sampleRate > 0
    ? buffer.sampleRate
    : 1
  const levels = [extractWaveformPeakLevel(buffer, baseSamplesPerPeak)]

  while (levels.length < maxLevels && levels.at(-1)!.peakCount > 1) {
    levels.push(aggregateWaveformPeakLevel(levels.at(-1)!, scale))
  }

  return {
    length,
    sampleRate,
    duration: length / sampleRate,
    numberOfChannels: Math.max(0, Math.floor(buffer.numberOfChannels)),
    levels,
  }
}

/** Selects the finest cached level that does not oversample the visible pixels. */
export function chooseWaveformPeakLevel(
  waveform: WaveformPeaks,
  sourceSampleCount: number,
  pixelWidth: number,
): WaveformPeakLevel {
  const first = waveform.levels[0]
  if (!first) return { samplesPerPeak: 1, peaks: new Float32Array(), peakCount: 0 }
  const targetSamplesPerPixel = Math.max(1, sourceSampleCount) / Math.max(1, pixelWidth)
  let selected = first
  for (const level of waveform.levels) {
    if (level.samplesPerPeak > targetSamplesPerPixel) break
    selected = level
  }
  return selected
}

/** Maps timeline duration through playback-rate/pitch into the decoded source. */
export function getWaveformViewport(
  waveform: Pick<WaveformPeaks, 'duration' | 'length' | 'sampleRate'>,
  timelineDurationSeconds: number,
  playbackRate: number,
): WaveformViewport {
  if (
    !Number.isFinite(timelineDurationSeconds)
    || timelineDurationSeconds <= 0
    || waveform.length <= 0
  ) {
    return { sourceSampleEnd: 0, activeFraction: 0 }
  }
  if (!Number.isFinite(playbackRate) || playbackRate <= 0) {
    return { sourceSampleEnd: 0, activeFraction: 0 }
  }
  const sourceDuration = Number.isFinite(waveform.duration) && waveform.duration >= 0
    ? waveform.duration
    : waveform.length / Math.max(1, waveform.sampleRate)
  const audibleTimelineDuration = sourceDuration / playbackRate
  const visibleTimelineDuration = Math.min(timelineDurationSeconds, audibleTimelineDuration)
  const sourceSampleEnd = Math.min(
    waveform.length,
    Math.ceil(visibleTimelineDuration * playbackRate * waveform.sampleRate),
  )
  return {
    sourceSampleEnd,
    activeFraction: Math.max(0, Math.min(1, visibleTimelineDuration / timelineDurationSeconds)),
  }
}
