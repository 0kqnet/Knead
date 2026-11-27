import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Marker } from '../types/timeline'
import {
  fitPianoRollPxPerTick,
  getPianoRollMarkerRect,
  PIANO_ROLL_MAX_PX_PER_TICK,
  PIANO_ROLL_MAX_ROW_HEIGHT,
  PIANO_ROLL_MIN_PX_PER_TICK,
  PIANO_ROLL_MIN_ROW_HEIGHT,
} from '../utils/pianoRoll'

export const PIANO_KEY_WIDTH = 88
const FALLBACK_WIDTH = 820
const WINDOW_STEP = 256
const END_PADDING = 16
// The scrollbar represents the whole song even when its pixel width exceeds browser layout limits.
const MAX_SCROLL_WIDTH = 8_000_000

function horizontalRange(length: number, scale: number, viewWidth: number) {
  const logicalWidth = Math.max(viewWidth, length * scale + END_PADDING)
  const width = Math.min(logicalWidth, MAX_SCROLL_WIDTH)
  const ratio = logicalWidth === width ? 1 : (logicalWidth - viewWidth) / (width - viewWidth)
  return { width, ratio }
}

function viewWidth(element: HTMLElement) {
  return element.clientWidth ? Math.max(1, element.clientWidth - PIANO_KEY_WIDTH) : FALLBACK_WIDTH
}

function scrollWindow(left: number, ratio: number) {
  return ratio === 1 ? Math.floor(left / WINDOW_STEP) * WINDOW_STEP : left
}

interface ZoomChange {
  factor?: number
  anchor?: number
  fit?: readonly Marker[]
  rows?: number
}

export function usePianoRollViewport(length: number, initialMarkers: readonly Marker[], focusMarker?: Marker) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState(() => ({
    scale: Math.max(3, fitPianoRollPxPerTick(initialMarkers, FALLBACK_WIDTH - END_PADDING, length)),
    rowHeight: 24,
  }))
  const [viewport, setViewport] = useState({ left: 0, width: FALLBACK_WIDTH })
  const committed = useRef(zoom)
  const wheelFrame = useRef(0)
  const initialView = useRef({ markers: initialMarkers, focusMarker })
  const initialized = useRef(false)
  const pending = useRef<{ scale: number, rowHeight: number, left: number, top: number } | null>(null)
  const updateViewport = useCallback(() => {
    const element = scrollerRef.current
    if (!element) return
    const width = viewWidth(element)
    const ratio = horizontalRange(length, zoom.scale, width).ratio
    // Native scrolling moves the existing overscan region until another region is needed.
    const left = scrollWindow(element.scrollLeft, ratio)
    setViewport(previous => previous.width === width && previous.left === left ? previous : { left, width })
  }, [length, zoom.scale])

  useLayoutEffect(() => {
    committed.current = zoom
    const element = scrollerRef.current
    if (!element) return
    const width = viewWidth(element)
    if (!initialized.current) {
      initialized.current = true
      const { markers, focusMarker: note } = initialView.current
      const scale = Math.max(3, fitPianoRollPxPerTick(markers, width - END_PADDING, length))
      const rect = getPianoRollMarkerRect(note ?? { tick: 0, pitch: 1 }, { startTick: 0, pxPerTick: scale, rowHeight: 24 })
      pending.current = {
        scale, rowHeight: 24, left: Math.max(0, rect.left - width / 2),
        top: element.clientHeight ? Math.max(0, rect.top + rect.height / 2 - element.clientHeight / 2) : 0,
      }
      if (scale !== zoom.scale) {
        setZoom({ scale, rowHeight: 24 })
        return
      }
    }
    if (pending.current?.scale === zoom.scale && pending.current.rowHeight === zoom.rowHeight) {
      const { left, top } = pending.current
      element.scrollLeft = left / horizontalRange(length, zoom.scale, width).ratio
      element.scrollTop = top
      pending.current = null
    }
    updateViewport()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(updateViewport)
    observer?.observe(element)
    return () => observer?.disconnect()
  }, [length, updateViewport, zoom])

  function revealNote(marker: Marker) {
    const element = scrollerRef.current
    if (!element) return
    const width = viewWidth(element)
    const { ratio } = horizontalRange(length, zoom.scale, width)
    const rect = getPianoRollMarkerRect(marker, { startTick: 0, pxPerTick: zoom.scale, rowHeight: zoom.rowHeight })
    const left = element.scrollLeft * ratio
    if (rect.left + rect.width < left || rect.left >= left + width) {
      element.scrollLeft = (rect.left - width / 2) / ratio
    }
    if (rect.top < element.scrollTop || rect.top + rect.height > element.scrollTop + element.clientHeight) {
      element.scrollTop = rect.top + rect.height / 2 - element.clientHeight / 2
    }
    updateViewport()
  }

  const changeZoom = useCallback(({ factor = 1, anchor, fit, rows = 0 }: ZoomChange, wheel = false) => {
    const element = scrollerRef.current
    if (!element) return
    const width = viewWidth(element)
    const previous = pending.current ?? {
      ...committed.current,
      left: element.scrollLeft * horizontalRange(length, committed.current.scale, width).ratio,
      top: element.scrollTop,
    }
    const available = Math.max(1, width - END_PADDING)
    const firstTick = fit?.length ? fit.reduce((first, marker) => Math.min(first, marker.tick), Infinity) : 0
    const scale = fit
      ? fitPianoRollPxPerTick(fit, available, length, firstTick)
      : Math.max(Math.min(available / Math.max(1, length), PIANO_ROLL_MIN_PX_PER_TICK),
          Math.min(PIANO_ROLL_MAX_PX_PER_TICK, previous.scale * factor))
    const rowHeight = Math.max(PIANO_ROLL_MIN_ROW_HEIGHT, Math.min(PIANO_ROLL_MAX_ROW_HEIGHT, previous.rowHeight + rows))
    if (!fit && scale === previous.scale && rowHeight === previous.rowHeight) return
    const x = Math.max(0, Math.min(width, anchor ?? width / 2))
    const y = element.clientHeight / 2
    const left = fit ? firstTick * scale - END_PADDING / 2 : (previous.left + x) * (scale / previous.scale) - x
    pending.current = {
      scale, rowHeight,
      left: Math.max(0, Math.min(Math.max(0, length * scale + END_PADDING - width), left)),
      top: Math.max(0, (previous.top + y) * (rowHeight / previous.rowHeight) - y),
    }
    const flush = () => {
      wheelFrame.current = 0
      const next = pending.current
      if (!next) return
      const { ratio } = horizontalRange(length, next.scale, width)
      setViewport({ left: scrollWindow(Math.round(next.left / ratio), ratio), width })
      setZoom({ scale: next.scale, rowHeight: next.rowHeight })
    }
    if (wheel) {
      if (!wheelFrame.current) wheelFrame.current = requestAnimationFrame(flush)
    }
    else {
      cancelAnimationFrame(wheelFrame.current)
      flush()
    }
  }, [length])

  useEffect(() => {
    const element = scrollerRef.current
    if (!element) return
    const onWheel = (event: WheelEvent) => {
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientWidth : 1
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault()
        const x = event.clientX - element.getBoundingClientRect().left - element.clientLeft - PIANO_KEY_WIDTH
        const delta = Math.max(-240, Math.min(240, event.deltaY * unit))
        changeZoom({ factor: Math.exp(-delta * 0.004), anchor: x }, true)
      }
      else if (event.shiftKey && event.deltaY && !event.deltaX) {
        event.preventDefault()
        element.scrollLeft += event.deltaY * unit
      }
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      element.removeEventListener('wheel', onWheel)
      cancelAnimationFrame(wheelFrame.current)
      wheelFrame.current = 0
    }
  }, [changeZoom])

  const { width: canvasWidth, ratio } = horizontalRange(length, zoom.scale, viewport.width)
  const worldLeft = viewport.left * ratio
  const origin = worldLeft - viewport.left
  const windowStart = Math.max(0, worldLeft - WINDOW_STEP)
  const windowEnd = Math.min(length * zoom.scale + END_PADDING, worldLeft + viewport.width + 2 * WINDOW_STEP)
  return {
    scrollerRef, updateViewport, changeZoom, revealNote, canvasWidth, origin, windowStart, windowEnd,
    pxPerTick: zoom.scale, rowHeight: zoom.rowHeight,
  }
}
