import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Box, Text } from '@yamada-ui/react'
import type { Marker, ReferenceAudioTrack, TimelineSettings, Track } from '../types/timeline'
import { referenceAudioDurationTicks } from '../utils/referenceAudio'
import { overviewXToTick, type OverviewRange } from '../utils/arrangementOverview'

interface Props {
  tracks: Track[]
  markers: Marker[]
  referenceAudio?: ReferenceAudioTrack[]
  settings: TimelineSettings
  lengthTicks: number
  currentTick: number
  viewport: OverviewRange
  onSeek: (tick: number) => void
  label: string
}

const COLORS: Record<Track['color'], string> = {
  blue: '#60a5fa',
  cyan: '#22d3ee',
  green: '#4ade80',
  yellow: '#facc15',
  orange: '#fb923c',
  red: '#f87171',
  pink: '#f472b6',
  purple: '#c084fc',
}

export const ArrangementOverview: React.FC<Props> = ({
  tracks, markers, referenceAudio = [], settings, lengthTicks, currentTick, viewport, onSeek, label,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ width: 1, height: 64 })
  const tickPercent = (tick: number) => `${tick / Math.max(1, lengthTicks) * 100}%`

  useEffect(() => {
    const element = wrapperRef.current
    if (!element) return
    const update = () => {
      const rect = element.getBoundingClientRect()
      setSize({ width: Math.max(1, rect.width), height: Math.max(1, rect.height) })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ratio = Math.max(1, window.devicePixelRatio || 1)
    canvas.width = Math.round(size.width * ratio)
    canvas.height = Math.round(size.height * ratio)
    canvas.style.width = `${size.width}px`
    canvas.style.height = `${size.height}px`
    const context = canvas.getContext('2d')
    if (!context) return
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, size.width, size.height)

    const tickToX = (tick: number) => tick / Math.max(1, lengthTicks) * size.width
    const totalRows = tracks.length + referenceAudio.length
    const rowHeight = size.height / Math.max(1, totalRows)
    context.strokeStyle = 'rgba(124,151,134,.18)'
    context.lineWidth = 1
    for (let index = 1; index < totalRows; index++) {
      const y = Math.round(index * rowHeight) + 0.5
      context.beginPath()
      context.moveTo(0, y)
      context.lineTo(size.width, y)
      context.stroke()
    }

    if (settings.loop.enabled) {
      const x = tickToX(settings.loop.startTick)
      const width = tickToX(settings.loop.endTick) - x
      context.fillStyle = 'rgba(74,222,128,.13)'
      context.fillRect(x, 0, Math.max(1, width), size.height)
    }

    const hasSolo = tracks.some(track => track.solo) || referenceAudio.some(track => track.solo)
    for (const [index, track] of referenceAudio.entries()) {
      const x = tickToX(track.offsetTicks)
      const width = Math.max(
        2,
        tickToX(track.offsetTicks + referenceAudioDurationTicks(track)) - x,
      )
      const y = index * rowHeight + Math.max(1, rowHeight * 0.18)
      const audible = !track.muted && (!hasSolo || track.solo)
      context.globalAlpha = audible ? 0.75 : 0.2
      context.fillStyle = COLORS[track.color]
      context.fillRect(x, y, width, Math.max(1, rowHeight * 0.64))
    }
    const trackIndex = new Map(tracks.map((track, index) => (
      [track.id, index + referenceAudio.length]
    )))
    for (const marker of markers) {
      const index = trackIndex.get(marker.trackId)
      if (index === undefined) continue
      const track = tracks[index - referenceAudio.length]
      const audible = !track.muted && (!hasSolo || track.solo)
      const x = tickToX(marker.tick)
      const width = Math.max(2, tickToX(marker.tick + Math.max(1, marker.duration ?? 0)) - x)
      const y = index * rowHeight + Math.max(1, rowHeight * 0.18)
      context.globalAlpha = audible ? 0.9 : 0.25
      context.fillStyle = marker.soundId ? COLORS[track.color] : '#ef4444'
      context.fillRect(x, y, width, Math.max(1, rowHeight * 0.64))
    }
    context.globalAlpha = 1
  }, [lengthTicks, markers, referenceAudio, settings.loop, size, tracks])

  const seekAtPointer = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    onSeek(overviewXToTick(event.clientX - rect.left, rect.width, lengthTicks))
  }, [lengthTicks, onSeek])

  return (
    <Box
      ref={wrapperRef}
      className="studio-navigator"
      role="slider"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={lengthTicks}
      aria-valuenow={Math.round(currentTick)}
      tabIndex={0}
      h="52px"
      minH="52px"
      position="relative"
      borderTop="1px solid"
      borderColor="var(--studio-line)"
      bg="var(--studio-frame)"
      cursor="crosshair"
      userSelect="none"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId)
        seekAtPointer(event)
      }}
      onPointerMove={(event) => { if (event.buttons === 1) seekAtPointer(event) }}
      onKeyDown={(event) => {
        if (event.key === 'Home') onSeek(0)
        else if (event.key === 'End') onSeek(lengthTicks)
        else if (event.key === 'ArrowLeft') onSeek(Math.max(0, currentTick - (event.shiftKey ? 10 : 1)))
        else if (event.key === 'ArrowRight') onSeek(Math.min(lengthTicks, currentTick + (event.shiftKey ? 10 : 1)))
        else return
        event.preventDefault()
      }}
    >
      <canvas ref={canvasRef} aria-hidden="true" />
      <div
        aria-hidden="true" className="studio-navigator-viewport"
        style={{ left: tickPercent(viewport.startTick), width: tickPercent(viewport.endTick - viewport.startTick) }}
      />
      <div aria-hidden="true" className="studio-navigator-playhead" style={{ left: tickPercent(currentTick) }} />
      <Text position="absolute" top="1" left="2" fontSize="xs" color="var(--studio-text)" px="1" bg="var(--studio-frame)" borderRadius="sm" pointerEvents="none">
        {label}
      </Text>
    </Box>
  )
}
