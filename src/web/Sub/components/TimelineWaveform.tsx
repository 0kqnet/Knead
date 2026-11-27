import React, { memo } from 'react'
import { useAudioWaveform } from '../hooks/useAudioBufferCache'
import { resolveMarkerPlaybackRate } from '../hooks/useTimelinePlayback'
import { tickRangeToSeconds, type TempoMapModel } from '../utils/tempoMap'
import { WaveformCanvas } from './WaveformCanvas'

interface Props {
  soundId: string
  variantIndex: number
  pitch: number
  durationTicks: number
  startTick?: number
  tempoModel?: TempoMapModel
  retriggerIntervalTicks?: number
  width: number
  height: number
  color: string
  selected: boolean
  muted: boolean
}

export const TimelineWaveform = memo(function TimelineWaveform({
  soundId,
  variantIndex,
  pitch,
  durationTicks,
  startTick = 0,
  tempoModel,
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
      durationSeconds={tickRangeToSeconds(startTick, startTick + durationTicks, tempoModel)}
      playbackRate={playbackRate}
      retriggerEverySeconds={retriggerIntervalTicks
        ? tickRangeToSeconds(startTick, startTick + retriggerIntervalTicks, tempoModel)
        : undefined}
      color={color}
      selected={selected}
      muted={muted}
    />
  )
})
