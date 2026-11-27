import React, { memo, useLayoutEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { Marker } from '../types/timeline'
import { formatPianoRollPitch, getPianoRollMarkerRect, PIANO_ROLL_KEY_COUNT } from '../utils/pianoRoll'

export const PIANO_ROLL_DOM_NOTE_LIMIT = 240

function panColor(pan: number): string {
  if (pan < -0.2) return '#63b3ed'
  if (pan > 0.2) return '#f687b3'
  return '#68d391'
}

interface Props {
  markers: readonly Marker[]
  selection: ReadonlySet<string>
  lockedTracks: ReadonlySet<string>
  focusId: string | null
  pxPerTick: number
  rowHeight: number
  windowStart: number
  windowEnd: number
  origin: number
}

function DenseNotes({ markers, selection, lockedTracks, pxPerTick, rowHeight, windowStart, windowEnd, origin }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const width = Math.max(1, Math.ceil(windowEnd - windowStart))
  const height = rowHeight * PIANO_ROLL_KEY_COUNT
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ratio = window.devicePixelRatio || 1
    canvas.width = Math.ceil(width * ratio)
    canvas.height = Math.ceil(height * ratio)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(ratio, ratio)
    const viewport = { startTick: windowStart / pxPerTick, pxPerTick, rowHeight }
    ctx.font = 'bold 10px sans-serif'
    for (const marker of markers) {
      const rect = getPianoRollMarkerRect(marker, viewport)
      const left = Math.max(-2, rect.left)
      const right = Math.min(width + 2, rect.left + rect.width)
      if (right <= left) continue
      const pan = marker.pan ?? 0
      ctx.globalAlpha = 0.35 + marker.volume * 0.65
      ctx.fillStyle = panColor(pan)
      ctx.fillRect(left, rect.top, right - left, rect.height)
      ctx.strokeStyle = selection.has(marker.id) ? '#fff' : lockedTracks.has(marker.trackId) ? '#737b87' : 'rgba(255,255,255,.5)'
      ctx.lineWidth = selection.has(marker.id) ? 3 : 1
      ctx.strokeRect(left + 0.5, rect.top + 0.5, right - left - 1, rect.height - 1)
      if (right - left > 28) {
        ctx.fillStyle = '#17202a'
        ctx.save()
        ctx.beginPath()
        ctx.rect(left, rect.top, right - left, rect.height)
        ctx.clip()
        ctx.fillText(formatPianoRollPitch(marker.pitch) + ' · ' + marker.soundId, rect.left + 4, rect.top + 12)
        const spacing = (marker.retriggerInterval ?? 0) * pxPerTick
        if (spacing >= 4 && marker.duration) {
          for (let x = rect.left + Math.max(1, Math.ceil(-rect.left / spacing)) * spacing; x < right; x += spacing) {
            ctx.fillRect(x, rect.top, 1, rect.height)
          }
        }
        const panLeft = rect.left + rect.width * (0.5 + Math.min(0, pan) / 2)
        ctx.fillRect(panLeft, rect.top + rect.height - 3, Math.max(2, rect.width * Math.abs(pan) / 2), 2)
        ctx.restore()
      }
    }
  }, [width, height, markers, lockedTracks, selection, pxPerTick, rowHeight, windowStart])

  return (
    <canvas
      ref={canvasRef} aria-hidden="true" className="piano-roll-dense-notes"
      style={{ left: windowStart - origin, width, height }}
    />
  )
}

export const PianoRollNotes = memo(function PianoRollNotes(props: Props) {
  const { t } = useTranslation()
  const { markers, selection, lockedTracks, focusId, pxPerTick, rowHeight, origin } = props
  const dense = markers.length > PIANO_ROLL_DOM_NOTE_LIMIT
  // In overview, pointer hit testing uses the same index as drawing. One native note
  // button carries focus; Tab/Shift+Tab still step through the notes in tick order.
  const buttons = dense ? [markers.find(marker => marker.id === focusId) ?? markers[0]] : markers
  const viewport = { startTick: origin / pxPerTick, pxPerTick, rowHeight }
  return (
    <>
      {dense && <DenseNotes {...props} />}
      {buttons.map((marker) => {
        const rect = getPianoRollMarkerRect(marker, viewport)
        const left = Math.max(rect.left, props.windowStart - origin - 2)
        const right = Math.min(rect.left + rect.width, props.windowEnd - origin + 2)
        const pan = marker.pan ?? 0
        const note = formatPianoRollPitch(marker.pitch)
        const spacing = (marker.retriggerInterval ?? 0) * pxPerTick
        const label = t('studio.piano_roll_note_label', {
          sound: marker.soundId, note, tick: marker.tick, velocity: Math.round(marker.volume * 100), pan: Math.round(pan * 100),
        })
        return (
          <button
            key={marker.id} type="button" className="piano-roll-note"
            style={{
              'left': left, 'top': rect.top, 'width': Math.max(1, right - left), 'height': rect.height,
              'backgroundColor': panColor(pan), 'opacity': 0.35 + marker.volume * 0.65,
              'backgroundImage': marker.duration && spacing >= 4
                ? `repeating-linear-gradient(90deg, transparent 0 ${spacing - 1}px, rgba(0,0,0,.4) ${spacing - 1}px ${spacing}px)`
                : undefined,
              '--pan-left': `${50 + Math.min(0, pan) * 50}%`,
              '--pan-width': `${Math.max(2, Math.abs(pan) * 50)}%`,
            } as React.CSSProperties}
            aria-pressed={selection.has(marker.id)} aria-disabled={lockedTracks.has(marker.trackId)}
            aria-label={label} title={label}
            data-piano-roll-note={marker.id} data-pan={pan} data-volume={marker.volume}
          >
            {rect.width > 26 ? note + ' · ' + marker.soundId : ''}
          </button>
        )
      })}
    </>
  )
})
