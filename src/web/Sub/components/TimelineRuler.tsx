import React, { useMemo, useRef } from 'react'
import { Box, Text } from '@yamada-ui/react'
import {
  TIMELINE_LEADING_PADDING_PX,
  type TempoMapEvent,
  type TimelineSettings,
} from '../types/timeline'
import { pxToTick, tickToPx } from '../utils/tickPixel'
import {
  buildTempoMap,
  enumerateTempoGridLines,
  formatMusicalPosition,
  snapTickToTempoMap,
  type TempoMapModel,
} from '../utils/tempoMap'

interface Props {
  lengthTicks: number
  pxPerTick: number
  settings: TimelineSettings
  tempoMap?: readonly TempoMapEvent[]
  onSeek: (tick: number) => void
  onLoopChange: (startTick: number, endTick: number) => void
}

function formatLabel(tick: number, settings: TimelineSettings, tempoModel: TempoMapModel): string {
  if (settings.timeDisplay === 'seconds') return `${(tick / 20).toFixed(1)}s`
  if (settings.timeDisplay === 'bars') return formatMusicalPosition(tick, tempoModel)
  return `${Math.round(tick)}`
}

export const TimelineRuler: React.FC<Props> = ({
  lengthTicks, pxPerTick, settings, tempoMap, onSeek, onLoopChange,
}) => {
  const rulerRef = useRef<HTMLDivElement | null>(null)
  const tempoModel = useMemo(() => buildTempoMap(tempoMap, {
    bpm: settings.bpm,
    timeSignature: {
      numerator: settings.timeSignature.numerator,
      denominator: settings.timeSignature.denominator,
    },
  }, Math.max(0, lengthTicks - 1)), [
    lengthTicks,
    settings.bpm,
    settings.timeSignature.denominator,
    settings.timeSignature.numerator,
    tempoMap,
  ])
  const marks = useMemo(() => {
    const musical = enumerateTempoGridLines(0, lengthTicks, tempoModel, 5_000)
    if (settings.timeDisplay === 'bars') return musical
    const byTick = new Map<number, { tick: number, major: boolean }>()
    const step = Math.max(1, pxPerTick < 3 ? 20 : pxPerTick < 6 ? 10 : 5)
    for (let tick = 0; tick <= lengthTicks + 0.001; tick += step) {
      byTick.set(Math.round(tick * 1_000_000), { tick, major: false })
    }
    for (const line of musical) {
      if (!line.major) continue
      byTick.set(Math.round(line.tick * 1_000_000), { tick: line.tick, major: true })
    }
    return [...byTick.values()].sort((left, right) => left.tick - right.tick)
  }, [lengthTicks, pxPerTick, settings.timeDisplay, tempoModel])

  const startHandleDrag = (edge: 'start' | 'end', event: React.PointerEvent) => {
    event.stopPropagation()
    const element = event.currentTarget as HTMLElement
    element.setPointerCapture(event.pointerId)
    const onMove = (move: PointerEvent) => {
      const rect = rulerRef.current?.getBoundingClientRect()
      if (!rect) return
      const tick = snapTickToTempoMap(
        pxToTick(move.clientX - rect.left - TIMELINE_LEADING_PADDING_PX, pxPerTick),
        settings,
        tempoModel,
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
              {formatLabel(mark.tick, settings, tempoModel)}
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
