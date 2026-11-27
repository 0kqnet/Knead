import React, { useEffect, useMemo, useRef } from 'react'
import { Box, Button, Flex, Input, Slider, Text } from '@yamada-ui/react'
import {
  REFERENCE_AUDIO_TRACK_HEIGHT,
  REFERENCE_AUDIO_TRACK_HEIGHT_COLLAPSED,
  TIMELINE_LEADING_PADDING_PX,
  TRACK_HEADER_WIDTH,
  type ReferenceAudioTrack,
  type TempoMapEvent,
  type TimelineSettings,
} from '../types/timeline'
import type { WaveformPeaks } from '../utils/waveformPeaks'
import { tickToPx } from '../utils/tickPixel'
import { buildTempoMap, referenceAudioEndTick, snapTickToTempoMap, type TempoMapModel } from '../utils/tempoMap'
import { CommitNumberInput } from '../../components/CommitNumberInput'
import { WaveformCanvas } from './WaveformCanvas'

interface MeterValue {
  peak: number
  rms: number
}

interface Props {
  track: ReferenceAudioTrack
  waveform?: WaveformPeaks
  error?: string
  meter?: MeterValue
  lengthTicks: number
  pxPerTick: number
  settings: TimelineSettings
  tempoMap?: readonly TempoMapEvent[]
  tempoModel?: TempoMapModel
  onChange: (patch: Partial<ReferenceAudioTrack>) => void
  onRemove: () => void
  onBeginEdit: () => void
  onEndEdit: () => void
  onSeek: (tick: number) => void
}

const COLOR_HEX: Record<ReferenceAudioTrack['color'], string> = {
  blue: '#3b82f6', cyan: '#06b6d4', green: '#22c55e', yellow: '#eab308',
  orange: '#f97316', red: '#ef4444', pink: '#ec4899', purple: '#a855f7',
}

export const ReferenceAudioTrackRow: React.FC<Props> = ({
  track,
  waveform,
  error,
  meter,
  lengthTicks,
  pxPerTick,
  settings,
  tempoMap,
  tempoModel: suppliedTempoModel,
  onChange,
  onRemove,
  onBeginEdit,
  onEndEdit,
  onSeek,
}) => {
  const height = track.collapsed
    ? REFERENCE_AUDIO_TRACK_HEIGHT_COLLAPSED
    : REFERENCE_AUDIO_TRACK_HEIGHT
  const clipBorderColor = error
    ? 'red.400'
    : track.solo
      ? 'yellow.300'
      : 'cyan.300'
  const dragCleanupRef = useRef<(() => void) | null>(null)
  const tempoModel = useMemo(
    () => suppliedTempoModel ?? buildTempoMap(tempoMap, settings, Math.max(0, lengthTicks - 1)),
    [lengthTicks, settings, suppliedTempoModel, tempoMap],
  )
  const clipDurationTicks = referenceAudioEndTick(track, tempoModel) - track.offsetTicks
  const clipWidth = Math.max(4, tickToPx(clipDurationTicks, pxPerTick))

  useEffect(() => () => dragCleanupRef.current?.(), [])

  const beginOffsetDrag = (event: React.PointerEvent) => {
    if (track.locked || event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    dragCleanupRef.current?.()
    const startX = event.clientX
    const initialOffset = track.offsetTicks
    onBeginEdit()
    const move = (moveEvent: PointerEvent) => {
      const raw = initialOffset + (moveEvent.clientX - startX) / pxPerTick
      onChange({ offsetTicks: snapTickToTempoMap(raw, settings, tempoModel, moveEvent.altKey) })
    }
    const finish = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      dragCleanupRef.current = null
      onEndEdit()
    }
    dragCleanupRef.current = finish
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish, { once: true })
    window.addEventListener('pointercancel', finish, { once: true })
  }

  return (
    <Flex data-reference-audio-track={track.id} h={`${height}px`}>
      <Box
        className="studio-track-header"
        position="sticky"
        left="0"
        zIndex="13"
        w={`${TRACK_HEADER_WIDTH}px`}
        minW={`${TRACK_HEADER_WIDTH}px`}
        h={`${height}px`}
        bg="var(--studio-panel)"
        borderRight="1px solid"
        borderBottom="1px solid"
        borderColor="var(--studio-line)"
        overflow="hidden"
      >
        <Flex align="center" gap="1">
          <Box w="7px" h="20px" borderRadius="sm" bg={COLOR_HEX[track.color]} />
          <Input
            aria-label="Reference audio name"
            size="xs"
            h="22px"
            value={track.name}
            title={track.sourcePath}
            onChange={event => onChange({ name: event.target.value })}
          />
          <Button size="xs" minW="22px" p="0" onClick={() => onChange({ collapsed: !track.collapsed })}>
            {track.collapsed ? '▸' : '▾'}
          </Button>
          <Button size="xs" minW="22px" p="0" colorScheme="red" onClick={onRemove} title="Remove reference audio">
            ×
          </Button>
        </Flex>
        {!track.collapsed && (
          <>
            <Flex align="center" gap="1">
              <Button title="Mute reference audio" size="xs" minW="24px" p="0" variant={track.muted ? 'solid' : 'outline'} colorScheme={track.muted ? 'red' : 'gray'} onClick={() => onChange({ muted: !track.muted })}>M</Button>
              <Button title="Solo reference audio" size="xs" minW="24px" p="0" variant={track.solo ? 'solid' : 'outline'} colorScheme={track.solo ? 'yellow' : 'gray'} onClick={() => onChange({ solo: !track.solo })}>S</Button>
              <Button size="xs" minW="24px" p="0" colorScheme={track.locked ? 'primary' : 'gray'} onClick={() => onChange({ locked: !track.locked })}>
                {track.locked ? '🔒' : '🔓'}
              </Button>
              <Text fontSize="9px">Offset</Text>
              <CommitNumberInput
                aria-label="Reference audio offset"
                size="xs"
                w="70px"
                value={track.offsetTicks}
                min={0}
                max={Math.max(lengthTicks, track.offsetTicks)}
                step={1}
                precision={0}
                disabled={track.locked}
                onCommit={offsetTicks => onChange({
                  offsetTicks: snapTickToTempoMap(offsetTicks, settings, tempoModel),
                })}
              />
              <Box flex="1" h="4px" bg="var(--studio-canvas)" borderRadius="full" overflow="hidden">
                <Box h="100%" w={`${Math.min(100, (meter?.peak ?? 0) * 100)}%`} bg={(meter?.peak ?? 0) > 0.9 ? 'red.400' : 'cyan.400'} />
              </Box>
            </Flex>
            <Flex align="center" gap="1">
              <Text fontSize="9px" minW="38px">
                G
                {' '}
                {track.gainDb.toFixed(1)}
              </Text>
              <Slider.Root
                size="sm" colorScheme="primary"
                thumbProps={{ 'aria-label': 'Reference audio gain' }}
                value={track.gainDb}
                min={-60}
                max={12}
                step={0.5}
                onPointerDown={onBeginEdit}
                onPointerUp={onEndEdit}
                onChange={gainDb => onChange({ gainDb })}
              />
              <Text fontSize="9px" minW="34px">
                P
                {' '}
                {track.pan.toFixed(1)}
              </Text>
              <Slider.Root
                size="sm" colorScheme="primary"
                thumbProps={{ 'aria-label': 'Reference audio pan' }}
                value={track.pan}
                min={-1}
                max={1}
                step={0.05}
                onPointerDown={onBeginEdit}
                onPointerUp={onEndEdit}
                onChange={pan => onChange({ pan })}
              />
            </Flex>
          </>
        )}
      </Box>
      <Box
        position="relative"
        h={`${height}px`}
        w={`${TIMELINE_LEADING_PADDING_PX + tickToPx(lengthTicks, pxPerTick)}px`}
        minW="100%"
        bg="var(--studio-frame)"
        borderBottom="1px solid"
        borderColor="var(--studio-line)"
        onDoubleClick={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect()
          onSeek(Math.max(0, (event.clientX - bounds.left - TIMELINE_LEADING_PADDING_PX) / pxPerTick))
        }}
      >
        <Box
          data-reference-audio-clip={track.id}
          data-reference-audio-left={TIMELINE_LEADING_PADDING_PX + tickToPx(track.offsetTicks, pxPerTick)}
          position="absolute"
          left={`${TIMELINE_LEADING_PADDING_PX + tickToPx(track.offsetTicks, pxPerTick)}px`}
          top="4px"
          w={`${clipWidth}px`}
          h={`${Math.max(24, height - 8)}px`}
          overflow="hidden"
          border="1px solid"
          borderColor={clipBorderColor}
          bg="rgba(6,182,212,.12)"
          borderRadius="sm"
          cursor={track.locked ? 'not-allowed' : 'grab'}
          title={error ?? `${track.fileName} · ${track.durationSeconds.toFixed(2)} s · drag to offset`}
          onPointerDown={beginOffsetDrag}
        >
          {waveform
            ? (
                <WaveformCanvas
                  waveform={waveform}
                  width={clipWidth}
                  height={Math.max(22, height - 10)}
                  durationSeconds={track.durationSeconds}
                  playbackRate={1}
                  color={COLOR_HEX[track.color]}
                  muted={track.muted}
                  selected={track.solo}
                />
              )
            : (
                <Flex h="100%" align="center" px="2">
                  <Text
                    fontSize="xs"
                    color={error ? 'var(--studio-error)' : 'var(--studio-text)'}
                    whiteSpace="nowrap"
                    overflow="hidden"
                    textOverflow="ellipsis"
                  >
                    {error ?? 'Decoding waveform…'}
                  </Text>
                </Flex>
              )}
        </Box>
      </Box>
    </Flex>
  )
}
