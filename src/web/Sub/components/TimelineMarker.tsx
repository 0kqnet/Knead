import React from 'react'
import { Box, Text } from '@yamada-ui/react'
import {
  TIMELINE_LEADING_PADDING_PX,
  TIMELINE_MARKER_HEIGHT,
  isSoundStopMarker,
  type Marker,
  type Track,
} from '../types/timeline'
import { tickToPx } from '../utils/tickPixel'
import type { MarkerVisualIcon } from '../../../../@types/global'
import { TimelineWaveform } from './TimelineWaveform'

export type ResizeEdge = 'start' | 'end'

interface Props {
  marker: Marker
  track: Track
  pxPerTick: number
  selected: boolean
  invalidSound: boolean
  markerIcon?: MarkerVisualIcon
  soundStopTitle?: string
  resizeCursor: boolean
  topPx: number
  onPointerDown: (edge: ResizeEdge | null, event: React.PointerEvent) => void
}

const COLOR_MAP: Record<Track['color'], string> = {
  blue: '#3b82f6',
  cyan: '#06b6d4',
  green: '#22c55e',
  yellow: '#eab308',
  orange: '#f97316',
  red: '#ef4444',
  pink: '#ec4899',
  purple: '#a855f7',
}

export const TimelineMarker: React.FC<Props> = ({
  marker, track, pxPerTick, selected, invalidSound, resizeCursor, topPx, onPointerDown,
  markerIcon, soundStopTitle,
}) => {
  const size = TIMELINE_MARKER_HEIGHT
  const soundStop = isSoundStopMarker(marker)
  const durationPx = !soundStop && marker.duration && marker.duration > 0
    ? tickToPx(marker.duration, pxPerTick)
    : 0
  const left = TIMELINE_LEADING_PADDING_PX + tickToPx(marker.tick, pxPerTick) - size / 2
  const color = soundStop ? '#f43f5e' : invalidSound ? '#dc2626' : track.muted ? '#64748b' : COLOR_MAP[track.color]
  const endpointBorder = selected ? '#f8fafc' : 'rgba(255,255,255,.45)'
  const lineColor = invalidSound ? '#7f1d1d' : selected ? '#93c5fd' : color
  const waveformColor = selected ? '#e0f2fe' : color
  const iconScale = markerIcon && markerIcon.cropWidth > 0 && markerIcon.cropHeight > 0
    ? Math.min(size / markerIcon.cropWidth, size / markerIcon.cropHeight)
    : 0
  const iconLayout = markerIcon && iconScale > 0
    ? {
        width: markerIcon.imageWidth * iconScale,
        height: markerIcon.imageHeight * iconScale,
        left: (size - markerIcon.cropWidth * iconScale) / 2 - markerIcon.cropX * iconScale,
        top: (size - markerIcon.cropHeight * iconScale) / 2 - markerIcon.cropY * iconScale,
      }
    : null
  const actionTitle = soundStop
    ? soundStopTitle ?? 'Sound Stopper'
    : marker.soundId || '(no sound)'

  const endpoint = (edge: ResizeEdge, offset: number) => (
    <Box
      data-marker-edge={edge}
      position="absolute"
      left={`${offset}px`}
      top="0"
      w={`${size}px`}
      h={`${size}px`}
      cursor={resizeCursor ? 'ew-resize' : 'grab'}
      _active={{ cursor: resizeCursor ? 'ew-resize' : 'grabbing' }}
      onPointerDown={event => onPointerDown(edge, event)}
    >
      {soundStop
        ? (
            <Box
              position="absolute"
              inset="0"
              borderRadius="3px"
              bg="#881337"
              border="2px solid"
              borderColor={endpointBorder}
              boxShadow={selected ? '0 0 0 2px #fb7185' : '0 2px 5px rgba(0,0,0,.4)'}
              display="flex"
              alignItems="center"
              justifyContent="center"
              pointerEvents="none"
            >
              <Text color="white" fontSize="10px" fontWeight="bold" lineHeight="1">■</Text>
            </Box>
          )
        : iconLayout && markerIcon
          ? (
              <div
                data-marker-icon-viewport
                style={{
                  position: 'absolute',
                  inset: 0,
                  borderRadius: '2px',
                  background: '#030712',
                  outlineWidth: '1px',
                  outlineStyle: 'solid',
                  outlineColor: endpointBorder,
                  boxShadow: selected ? '0 0 0 2px #2563eb' : '0 2px 5px rgba(0,0,0,.4)',
                  overflow: 'hidden',
                  pointerEvents: 'none',
                }}
              >
                <img
                  data-marker-icon-image
                  src={markerIcon.dataUrl}
                  alt=""
                  draggable={false}
                  style={{
                    position: 'absolute',
                    width: `${iconLayout.width}px`,
                    height: `${iconLayout.height}px`,
                    maxWidth: 'none',
                    left: `${iconLayout.left}px`,
                    top: `${iconLayout.top}px`,
                    imageRendering: 'pixelated',
                    pointerEvents: 'none',
                  }}
                />
              </div>
            )
          : (
              <Box
                position="absolute"
                inset="0"
                transform="rotate(45deg) scale(.68)"
                borderRadius="3px"
                bg={color}
                border="2px solid"
                borderColor={endpointBorder}
                boxShadow={selected ? '0 0 0 2px #2563eb' : '0 2px 5px rgba(0,0,0,.4)'}
                pointerEvents="none"
              />
            )}
    </Box>
  )

  return (
    <Box
      data-marker-id={marker.id}
      data-marker-left={left}
      data-marker-top={topPx}
      data-marker-visual={soundStop ? 'sound-stop' : markerIcon?.kind ?? 'default'}
      data-marker-action={soundStop ? 'sound-stop' : 'play-sound'}
      data-marker-muted={track.muted ? 'true' : 'false'}
      position="absolute"
      left={`${left}px`}
      top={`${topPx}px`}
      transform="translateY(-50%)"
      w={`${size + durationPx}px`}
      h={`${size}px`}
      cursor="grab"
      _active={{ cursor: 'grabbing' }}
      userSelect="none"
      zIndex={selected ? 4 : 2}
      onPointerDown={event => onPointerDown(null, event)}
      title={`${track.name} · t=${marker.tick} · ${actionTitle}`}
    >
      {durationPx > 0 && (
        <Box
          data-marker-duration
          position="absolute"
          left={`${size / 2}px`}
          top="50%"
          transform="translateY(-50%)"
          w={`${durationPx}px`}
          h={`${size - 2}px`}
          display="flex"
          alignItems="center"
          overflow="hidden"
          bg={invalidSound ? lineColor : 'rgba(15,23,42,.88)'}
          borderY="1px solid"
          borderColor={selected ? '#f8fafc' : lineColor}
          opacity={track.muted ? 0.72 : 1}
          pointerEvents="none"
        >
          {!invalidSound && (
            <TimelineWaveform
              soundId={marker.soundId}
              variantIndex={marker.variantIndex}
              pitch={marker.pitch}
              durationTicks={marker.duration ?? 0}
              retriggerIntervalTicks={marker.retriggerInterval}
              width={durationPx}
              height={size - 4}
              color={waveformColor}
              selected={selected}
              muted={track.muted}
            />
          )}
        </Box>
      )}
      {endpoint(durationPx > 0 ? 'start' : 'end', 0)}
      {durationPx > 0 && endpoint('end', durationPx)}
      {invalidSound && (
        <Text position="absolute" top="-12px" left="0" fontSize="9px" color="red.300">!</Text>
      )}
    </Box>
  )
}
