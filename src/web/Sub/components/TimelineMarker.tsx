import React from 'react'
import { Box, Text } from '@yamada-ui/react'
import {
  TIMELINE_LEADING_PADDING_PX,
  TIMELINE_MARKER_HEIGHT,
  type Marker,
  type Track,
} from '../types/timeline'
import { tickToPx } from '../utils/tickPixel'
import type { MarkerVisualIcon } from '../../../../@types/global'

export type ResizeEdge = 'start' | 'end'

interface Props {
  marker: Marker
  track: Track
  pxPerTick: number
  selected: boolean
  invalidSound: boolean
  markerIcon?: MarkerVisualIcon
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
  markerIcon,
}) => {
  const size = TIMELINE_MARKER_HEIGHT
  const durationPx = marker.duration && marker.duration > 0
    ? tickToPx(marker.duration, pxPerTick)
    : 0
  const left = TIMELINE_LEADING_PADDING_PX + tickToPx(marker.tick, pxPerTick) - size / 2
  const color = invalidSound ? '#dc2626' : COLOR_MAP[track.color]
  const endpointBorder = selected ? '#f8fafc' : 'rgba(255,255,255,.45)'
  const lineColor = invalidSound ? '#7f1d1d' : selected ? '#93c5fd' : color
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
      {iconLayout && markerIcon
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
      data-marker-visual={markerIcon?.kind ?? 'default'}
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
      title={`${track.name} · t=${marker.tick} · ${marker.soundId || '(no sound)'}`}
    >
      {durationPx > 0 && (
        <Box
          position="absolute"
          left={`${size / 2}px`}
          top="50%"
          transform="translateY(-50%)"
          w={`${durationPx}px`}
          h="10px"
          bg={lineColor}
          borderY={selected ? '1px solid white' : undefined}
          pointerEvents="none"
        />
      )}
      {endpoint(durationPx > 0 ? 'start' : 'end', 0)}
      {durationPx > 0 && endpoint('end', durationPx)}
      {invalidSound && (
        <Text position="absolute" top="-12px" left="0" fontSize="9px" color="red.300">!</Text>
      )}
    </Box>
  )
}
