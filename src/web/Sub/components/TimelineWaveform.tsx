import React, { memo } from 'react'
import { useAudioWaveform } from '../hooks/useAudioBufferCache'
import { resolveMarkerPlaybackRate } from '../hooks/useTimelinePlayback'
import { WaveformCanvas } from './WaveformCanvas'

interface Props {
  soundId: string
  variantIndex: number
  pitch: number
  durationTicks: number
  retriggerIntervalTicks?: number
  width: number
  height: number
  color: string
  selected: boolean
  muted: boolean
}

const TICK_SECONDS = 0.05

export const TimelineWaveform = memo(function TimelineWaveform({
  soundId,
  variantIndex,
  pitch,
  durationTicks,
  retriggerIntervalTicks,
  width,
  height,
  color,
  selected,
  muted,
}: Props) {
  const cached = useAudioWaveform(soundId, variantIndex)
  if (!cached || durationTicks <= 0 || width <= 0) return null
  const playbackRate = resolveMarkerPlaybackRate(pitch, cached.basePitch)
  if (playbackRate === null) return null

  return (
    <WaveformCanvas
      waveform={cached.waveform}
      width={width}
      height={height}
      durationSeconds={durationTicks * TICK_SECONDS}
      playbackRate={playbackRate}
      retriggerEverySeconds={retriggerIntervalTicks
        ? retriggerIntervalTicks * TICK_SECONDS
        : undefined}
      color={color}
      selected={selected}
      muted={muted}
    />
  )
})
