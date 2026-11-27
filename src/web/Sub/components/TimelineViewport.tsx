import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, ReactNode, RefObject, SetStateAction } from 'react'
import {
  TIMELINE_LEADING_PADDING_PX,
  TRACK_HEADER_WIDTH,
  TRACK_HEIGHT,
} from '../types/timeline'
import type { useTimelinePlayback } from '../hooks/useTimelinePlayback'
import { timelineViewportRange, type OverviewRange } from '../utils/arrangementOverview'
import { tickToPx } from '../utils/tickPixel'

export const RULER_HEIGHT = 32
const HORIZONTAL_CHUNK_PX = 128
const VERTICAL_CHUNK_PX = TRACK_HEIGHT
const FOLLOW_RESUME_DELAY_MS = 750
const EMPTY_VIEWPORT = { left: 0, top: 0, width: 0, height: 0 }

interface Props {
  scrollRef: RefObject<HTMLDivElement | null>
  playback: Pick<ReturnType<typeof useTimelinePlayback>, 'getCurrentTick' | 'isPlaying' | 'subscribeTick'>
  lengthTicks: number
  pxPerTick: number
  setPxPerTick: Dispatch<SetStateAction<number>>
  trackRows: readonly { top: number }[]
  trackOrder: ReadonlyMap<string, number>
  selectedTrackId: string
  referenceAudioHeight: number
  onHorizontalViewportChange: (left: number, width: number) => void
  children: (view: { visibleTicks: OverviewRange, visibleTrackIndices: number[] }) => ReactNode
}

function firstTrackStartingAfter(rows: readonly { top: number }[], y: number): number {
  let low = 0
  let high = rows.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (rows[middle].top <= y) low = middle + 1
    else high = middle
  }
  return low
}

function trackIdAtTarget(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null
  const row = target.closest<HTMLElement>('[data-track-id], [data-track-header-id]')
  return row?.dataset.trackId ?? row?.dataset.trackHeaderId ?? null
}

export function TimelineViewport({
  scrollRef, playback, lengthTicks, pxPerTick, setPxPerTick, trackRows, trackOrder,
  selectedTrackId, referenceAudioHeight, onHorizontalViewportChange, children,
}: Props) {
  const { getCurrentTick, isPlaying, subscribeTick } = playback
  const [renderViewport, setRenderViewport] = useState(EMPTY_VIEWPORT)
  const [focusedTrackId, setFocusedTrackId] = useState<string | null>(null)
  const [capturedTrackId, setCapturedTrackId] = useState<string | null>(null)
  const [draggedTrackId, setDraggedTrackId] = useState<string | null>(null)
  const viewportRef = useRef({ ...EMPTY_VIEWPORT, maxLeft: 0 })
  const followLeftRef = useRef<number | null>(null)
  const manualScrollUntilRef = useRef(0)

  const holdFollow = useCallback(() => {
    if (!isPlaying) return
    manualScrollUntilRef.current = performance.now() + FOLLOW_RESUME_DELAY_MS
    followLeftRef.current = null
  }, [isPlaying])

  const syncViewport = useCallback((measure: boolean) => {
    const element = scrollRef.current
    if (!element) return
    const previous = viewportRef.current
    const left = element.scrollLeft
    const top = element.scrollTop
    const width = measure ? element.clientWidth : previous.width
    const height = measure ? element.clientHeight : previous.height
    const maxLeft = measure ? Math.max(0, element.scrollWidth - width) : previous.maxLeft
    viewportRef.current = { left, top, width, height, maxLeft }
    if (!measure && (left !== previous.left || top !== previous.top)) {
      const fromFollow = followLeftRef.current !== null && Math.abs(left - followLeftRef.current) < 1
      if (top !== previous.top || !fromFollow) holdFollow()
      followLeftRef.current = null
    }
    if (left !== previous.left || width !== previous.width) onHorizontalViewportChange(left, width)

    const leftChunk = Math.floor(left / HORIZONTAL_CHUNK_PX)
    const topChunk = Math.floor(top / VERTICAL_CHUNK_PX)
    if (
      leftChunk === Math.floor(previous.left / HORIZONTAL_CHUNK_PX)
      && topChunk === Math.floor(previous.top / VERTICAL_CHUNK_PX)
      && width === previous.width && height === previous.height
    ) return
    const next = { left: leftChunk * HORIZONTAL_CHUNK_PX, top: topChunk * VERTICAL_CHUNK_PX, width, height }
    if (measure) setRenderViewport(next)
    // Scroll updates can wait for the spare area around the visible rows.
    else startTransition(() => setRenderViewport(next))
  }, [holdFollow, onHorizontalViewportChange, scrollRef])

  useLayoutEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const observer = new ResizeObserver(() => syncViewport(true))
    observer.observe(element)
    return () => observer.disconnect()
  }, [scrollRef, syncViewport])

  useLayoutEffect(() => {
    syncViewport(true)
  }, [lengthTicks, pxPerTick, syncViewport])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const headers = element.querySelectorAll<HTMLElement>('[data-track-header-id]')
    const selected = Array.from(headers).find(header => header.dataset.trackHeaderId === selectedTrackId)
    if (!selected) return
    const observer = new ResizeObserver(() => selected.scrollIntoView({ block: 'nearest', inline: 'nearest' }))
    observer.observe(element)
    return () => observer.disconnect()
  }, [scrollRef, selectedTrackId])

  useEffect(() => {
    if (!isPlaying) {
      manualScrollUntilRef.current = 0
      return
    }
    const follow = (tick: number) => {
      const element = scrollRef.current
      const { left, width, maxLeft } = viewportRef.current
      const timelineWidth = width - TRACK_HEADER_WIDTH
      if (!element || timelineWidth <= 0 || performance.now() < manualScrollUntilRef.current) return

      const x = TRACK_HEADER_WIDTH + TIMELINE_LEADING_PADDING_PX + tickToPx(tick, pxPerTick)
      const margin = Math.min(80, timelineWidth / 3)
      let target = left
      if (x < left + TRACK_HEADER_WIDTH + margin) target = x - TRACK_HEADER_WIDTH - margin
      else if (x > left + width - margin) target = x - width + margin
      const next = Math.max(0, Math.min(maxLeft, Math.round(target)))
      if (Math.abs(next - left) < 1) return
      followLeftRef.current = next
      element.scrollLeft = next
    }
    follow(getCurrentTick())
    return subscribeTick(follow)
  }, [getCurrentTick, isPlaying, pxPerTick, scrollRef, subscribeTick])

  const range = timelineViewportRange(
    renderViewport.left, renderViewport.width + HORIZONTAL_CHUNK_PX, pxPerTick,
    TRACK_HEADER_WIDTH, TIMELINE_LEADING_PADDING_PX, lengthTicks,
  )
  const startChunk = Math.floor(range.startTick * pxPerTick / HORIZONTAL_CHUNK_PX) - 1
  const endChunk = Math.ceil(range.endTick * pxPerTick / HORIZONTAL_CHUNK_PX) + 1
  const visibleTicks = useMemo<OverviewRange>(() => ({
    startTick: Math.max(0, startChunk * HORIZONTAL_CHUNK_PX / pxPerTick),
    endTick: Math.min(lengthTicks, endChunk * HORIZONTAL_CHUNK_PX / pxPerTick),
  }), [endChunk, lengthTicks, pxPerTick, startChunk])
  const trackTop = renderViewport.top - referenceAudioHeight
  // The current scroll position can be anywhere in this chunk.
  const trackBottom = trackTop + Math.max(0, renderViewport.height - RULER_HEIGHT) + VERTICAL_CHUNK_PX
  const firstTrackIndex = Math.max(0, firstTrackStartingAfter(trackRows, trackTop - TRACK_HEIGHT) - 1)
  const endTrackIndex = firstTrackStartingAfter(trackRows, trackBottom + TRACK_HEIGHT)
  const visibleTrackIndices = useMemo(() => {
    const indices = new Set<number>()
    for (let index = firstTrackIndex; index < endTrackIndex; index++) indices.add(index)
    // Keep a row mounted while its header has focus or it owns an active drag.
    for (const id of [selectedTrackId, focusedTrackId, capturedTrackId, draggedTrackId]) {
      const index = id === null ? undefined : trackOrder.get(id)
      if (index !== undefined) indices.add(index)
    }
    return [...indices].sort((left, right) => left - right)
  }, [capturedTrackId, draggedTrackId, endTrackIndex, firstTrackIndex, focusedTrackId, selectedTrackId, trackOrder])

  return (
    <div
      ref={scrollRef}
      className="studio-timeline-viewport"
      onScroll={() => syncViewport(false)}
      onFocus={event => setFocusedTrackId(trackIdAtTarget(event.target))}
      onBlur={event => setFocusedTrackId(trackIdAtTarget(event.relatedTarget))}
      onGotPointerCapture={event => setCapturedTrackId(trackIdAtTarget(event.target))}
      onLostPointerCapture={() => setCapturedTrackId(null)}
      onDragStart={event => setDraggedTrackId(trackIdAtTarget(event.target))}
      onDragEnd={() => setDraggedTrackId(null)}
      onWheel={(event) => {
        holdFollow()
        if (!(event.ctrlKey || event.metaKey)) return
        event.preventDefault()
        setPxPerTick(value => Math.max(1.5, Math.min(64, value * (event.deltaY > 0 ? 0.88 : 1.12))))
      }}
    >
      {children({ visibleTicks, visibleTrackIndices })}
    </div>
  )
}
