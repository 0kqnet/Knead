import React, { useMemo, useRef } from 'react'
import { Box, Text } from '@yamada-ui/react'
import {
  TIMELINE_LEADING_PADDING_PX,
  snapTick,
  ticksPerBar,
  ticksPerBeat,
  type TimelineSettings,
} from '../types/timeline'
import { pxToTick, tickToPx } from '../utils/tickPixel'

interface Props {
  lengthTicks: number
  pxPerTick: number
  settings: TimelineSettings
  onSeek: (tick: number) => void
  onLoopChange: (startTick: number, endTick: number) => void
}

function formatLabel(tick: number, settings: TimelineSettings): string {
  if (settings.timeDisplay === 'seconds') return `${(tick / 20).toFixed(1)}s`
  if (settings.timeDisplay === 'bars') {
    const beat = ticksPerBeat(settings)
    const bar = Math.floor(tick / (beat * settings.timeSignature.numerator)) + 1
    const beatInBar = Math.floor((tick / beat) % settings.timeSignature.numerator) + 1
    return `${bar}.${beatInBar}`
  }
  return `${Math.round(tick)}`
}

export const TimelineRuler: React.FC<Props> = ({
  lengthTicks, pxPerTick, settings, onSeek, onLoopChange,
}) => {
  const rulerRef = useRef<HTMLDivElement | null>(null)
  const beatTicks = ticksPerBeat(settings)
  const barTicks = ticksPerBar(settings)
  const marks = useMemo(() => {
    const values: { tick: number, major: boolean }[] = []
    const step = settings.timeDisplay === 'bars'
      ? beatTicks
      : Math.max(1, pxPerTick < 3 ? 20 : pxPerTick < 6 ? 10 : 5)
    for (let tick = 0; tick <= lengthTicks + 0.001; tick += step) {
      const barRatio = tick / barTicks
      values.push({ tick, major: Math.abs(barRatio - Math.round(barRatio)) < 0.001 })
    }
    return values
  }, [barTicks, beatTicks, lengthTicks, pxPerTick, settings.timeDisplay])

  const startHandleDrag = (edge: 'start' | 'end', event: React.PointerEvent) => {
    event.stopPropagation()
    const element = event.currentTarget as HTMLElement
    element.setPointerCapture(event.pointerId)
    const onMove = (move: PointerEvent) => {
      const rect = rulerRef.current?.getBoundingClientRect()
      if (!rect) return
      const tick = snapTick(
        pxToTick(move.clientX - rect.left - TIMELINE_LEADING_PADDING_PX, pxPerTick),
        settings,
        move.altKey,
      )
      const loop = settings.loop
      if (edge === 'start') onLoopChange(Math.min(tick, loop.endTick - 1), loop.endTick)
      else onLoopChange(loop.startTick, Math.max(loop.startTick + 1, Math.min(lengthTicks, tick)))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <Box
      ref={rulerRef}
      position="relative"
      h="32px"
      minW="100%"
      w={`${TIMELINE_LEADING_PADDING_PX + tickToPx(lengthTicks, pxPerTick)}px`}
      bg="gray.800"
      borderBottom="1px solid"
      borderColor="gray.600"
      userSelect="none"
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect()
        onSeek(Math.max(0, Math.min(
          lengthTicks,
          pxToTick(event.clientX - rect.left - TIMELINE_LEADING_PADDING_PX, pxPerTick),
        )))
      }}
    >
      {marks.map(mark => (
        <Box
          key={mark.tick}
          position="absolute"
          left={`${TIMELINE_LEADING_PADDING_PX + tickToPx(mark.tick, pxPerTick)}px`}
          top={mark.major ? '0' : '15px'}
          bottom="0"
          borderLeft="1px solid"
          borderColor={mark.major ? 'gray.300' : 'gray.500'}
        >
          {(mark.major || pxPerTick >= 6) && (
            <Text
              position="absolute"
              left="3px"
              top="1px"
              fontSize="9px"
              color={mark.major ? 'gray.100' : 'gray.400'}
              whiteSpace="nowrap"
            >
              {formatLabel(mark.tick, settings)}
            </Text>
          )}
        </Box>
      ))}
      {settings.loop.enabled && (
        <>
          <Box
            position="absolute"
            left={`${TIMELINE_LEADING_PADDING_PX + tickToPx(settings.loop.startTick, pxPerTick)}px`}
            top="0"
            bottom="0"
            w={`${tickToPx(settings.loop.endTick - settings.loop.startTick, pxPerTick)}px`}
            bg="rgba(34,197,94,.16)"
            borderX="1px solid #4ade80"
            pointerEvents="none"
          />
          {(['start', 'end'] as const).map(edge => (
            <Box
              key={edge}
              position="absolute"
              left={`${TIMELINE_LEADING_PADDING_PX + tickToPx(edge === 'start' ? settings.loop.startTick : settings.loop.endTick, pxPerTick) - 5}px`}
              top="0"
              w="10px"
              h="18px"
              bg="green.400"
              clipPath={edge === 'start' ? 'polygon(0 0,100% 0,100% 100%,0 60%)' : 'polygon(0 0,100% 0,100% 60%,0 100%)'}
              cursor="ew-resize"
              zIndex="5"
              onPointerDown={event => startHandleDrag(edge, event)}
            />
          ))}
        </>
      )}
    </Box>
  )
}
