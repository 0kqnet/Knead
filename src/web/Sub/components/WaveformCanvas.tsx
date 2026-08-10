import React, { memo, useLayoutEffect, useRef } from 'react'
import {
  chooseWaveformPeakLevel,
  getWaveformViewport,
  type WaveformPeakLevel,
  type WaveformPeaks,
} from '../utils/waveformPeaks'

interface Props {
  waveform: WaveformPeaks
  width: number
  height: number
  durationSeconds: number
  playbackRate: number
  color: string
  selected?: boolean
  muted?: boolean
  retriggerEverySeconds?: number
}

interface Envelope {
  minimum: number
  maximum: number
}

const MAX_BITMAP_WIDTH = 4096
const MAX_DEVICE_PIXEL_RATIO = 2

function readEnvelope(level: WaveformPeakLevel, startSample: number, endSample: number): Envelope {
  if (level.peakCount === 0) return { minimum: 0, maximum: 0 }
  const firstPeak = Math.max(0, Math.floor(startSample / level.samplesPerPeak))
  const lastPeak = Math.min(
    level.peakCount - 1,
    Math.max(firstPeak, Math.ceil(endSample / level.samplesPerPeak) - 1),
  )
  let minimum = 0
  let maximum = 0
  for (let peakIndex = firstPeak; peakIndex <= lastPeak; peakIndex++) {
    minimum = Math.min(minimum, level.peaks[peakIndex * 2])
    maximum = Math.max(maximum, level.peaks[peakIndex * 2 + 1])
  }
  return { minimum, maximum }
}

function amplitudeY(amplitude: number, centerY: number, radius: number): number {
  return centerY - Math.max(-1, Math.min(1, amplitude)) * radius
}

export const WaveformCanvas = memo(function WaveformCanvas({
  waveform,
  width,
  height,
  durationSeconds,
  playbackRate,
  color,
  selected = false,
  muted = false,
  retriggerEverySeconds,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || width <= 0 || height <= 0) return
    const ratio = Math.min(
      MAX_DEVICE_PIXEL_RATIO,
      Math.max(1, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1),
    )
    const bitmapWidth = Math.min(MAX_BITMAP_WIDTH, Math.max(1, Math.ceil(width * ratio)))
    const bitmapHeight = Math.max(1, Math.ceil(height * ratio))
    if (canvas.width !== bitmapWidth) canvas.width = bitmapWidth
    if (canvas.height !== bitmapHeight) canvas.height = bitmapHeight
    const context = canvas.getContext('2d')
    if (!context) return
    context.clearRect(0, 0, bitmapWidth, bitmapHeight)

    const viewport = getWaveformViewport(waveform, durationSeconds, playbackRate)
    const activeWidth = Math.min(
      bitmapWidth,
      Math.max(0, Math.ceil(bitmapWidth * viewport.activeFraction)),
    )
    if (activeWidth === 0 || viewport.sourceSampleEnd === 0) return
    const level = chooseWaveformPeakLevel(waveform, viewport.sourceSampleEnd, activeWidth)
    const centerY = bitmapHeight / 2
    const amplitudeRadius = Math.max(1, bitmapHeight / 2 - ratio)

    context.globalAlpha = muted ? 0.42 : selected ? 1 : 0.82
    context.fillStyle = color
    context.beginPath()
    for (let x = 0; x < activeWidth; x++) {
      const startSample = x / activeWidth * viewport.sourceSampleEnd
      const endSample = (x + 1) / activeWidth * viewport.sourceSampleEnd
      const { maximum } = readEnvelope(level, startSample, endSample)
      const y = amplitudeY(maximum, centerY, amplitudeRadius)
      if (x === 0) context.moveTo(x, y)
      else context.lineTo(x, y)
    }
    for (let x = activeWidth - 1; x >= 0; x--) {
      const startSample = x / activeWidth * viewport.sourceSampleEnd
      const endSample = (x + 1) / activeWidth * viewport.sourceSampleEnd
      const { minimum } = readEnvelope(level, startSample, endSample)
      context.lineTo(x, amplitudeY(minimum, centerY, amplitudeRadius))
    }
    context.closePath()
    context.fill()

    context.globalAlpha = muted ? 0.2 : selected ? 0.72 : 0.35
    context.strokeStyle = selected ? '#ffffff' : color
    context.lineWidth = Math.max(1, ratio * 0.5)
    context.beginPath()
    context.moveTo(0, centerY)
    context.lineTo(activeWidth, centerY)
    context.stroke()

    if (
      retriggerEverySeconds
      && retriggerEverySeconds > 0
      && retriggerEverySeconds < durationSeconds
    ) {
      const spacing = retriggerEverySeconds / durationSeconds * bitmapWidth
      if (spacing >= 3) {
        context.globalAlpha = muted ? 0.12 : 0.28
        context.strokeStyle = selected ? '#ffffff' : '#e2e8f0'
        context.lineWidth = 1
        context.beginPath()
        for (let x = spacing; x < bitmapWidth; x += spacing) {
          context.moveTo(Math.round(x) + 0.5, 0)
          context.lineTo(Math.round(x) + 0.5, bitmapHeight)
        }
        context.stroke()
      }
    }
    context.globalAlpha = 1
  }, [
    color,
    durationSeconds,
    height,
    muted,
    playbackRate,
    retriggerEverySeconds,
    selected,
    waveform,
    width,
  ])

  return (
    <canvas
      ref={canvasRef}
      data-waveform-canvas
      data-waveform-selected={selected ? 'true' : 'false'}
      data-waveform-muted={muted ? 'true' : 'false'}
      data-waveform-playback-rate={playbackRate}
      aria-hidden="true"
      style={{
        display: 'block',
        width: `${width}px`,
        height: `${height}px`,
        pointerEvents: 'none',
      }}
    />
  )
})
