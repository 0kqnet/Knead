import React, { useLayoutEffect, useRef } from 'react'
import { Box } from '@yamada-ui/react'
import { tickToPx } from '../utils/tickPixel'
import { TIMELINE_LEADING_PADDING_PX } from '../types/timeline'

interface Props {
  getCurrentTick: () => number
  subscribeTick: (listener: (tick: number) => void) => () => void
  pxPerTick: number
  heightPx: number
}

const HEAD_SIZE = 10

export const TimelinePlayhead = React.memo(function TimelinePlayhead({
  getCurrentTick, subscribeTick, pxPerTick, heightPx,
}: Props) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const move = (tick: number) => {
      const left = TIMELINE_LEADING_PADDING_PX + tickToPx(tick, pxPerTick)
      element.style.transform = `translateX(${left}px)`
    }
    move(getCurrentTick())
    return subscribeTick(move)
  }, [getCurrentTick, pxPerTick, subscribeTick])

  return (
    <Box
      ref={ref}
      position="absolute"
      left="0"
      top="0"
      pointerEvents="none"
      zIndex={10}
      willChange="transform"
    >
      {/* 見つけやすくするための三角形のヘッド (M17) */}
      <Box
        position="absolute"
        top="0"
        left={`-${HEAD_SIZE / 2}px`}
        w="0"
        h="0"
        borderLeft={`${HEAD_SIZE / 2}px solid transparent`}
        borderRight={`${HEAD_SIZE / 2}px solid transparent`}
        borderTop={`${HEAD_SIZE * 0.7}px solid`}
        borderTopColor="red.500"
      />
      <Box
        position="absolute"
        top={`${HEAD_SIZE * 0.7}px`}
        left="-1px"
        w="2px"
        h={`${Math.max(0, heightPx - HEAD_SIZE * 0.7)}px`}
        bg="red.500"
      />
    </Box>
  )
})
