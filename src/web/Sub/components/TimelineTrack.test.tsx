// @vitest-environment jsdom

import React from 'react'
import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SETTINGS,
  TIMELINE_LEADING_PADDING_PX,
  TIMELINE_MARKER_HEIGHT,
  createDefaultTrack,
  type Marker,
} from '../types/timeline'
import { TimelineTrack } from './TimelineTrack'

const marker: Marker = {
  id: 'marker',
  trackId: 'track',
  tick: 20,
  soundId: 'test',
  variantIndex: -1,
  volume: 1,
  pitch: 1,
  duration: 0,
}

function renderTrack(overrides: Partial<React.ComponentProps<typeof TimelineTrack>> = {}) {
  const callbacks = {
    onSelectMarker: vi.fn(),
    onClearSelection: vi.fn(),
    onRectangleSelect: vi.fn(),
    onBeginEdit: vi.fn(),
    onEndEdit: vi.fn(),
    onMoveSelection: vi.fn(),
    onResizeMarker: vi.fn(),
    onDuplicateForDrag: vi.fn(() => marker.id),
    onAddMarker: vi.fn(),
  }
  const view = render(
    <TimelineTrack
      track={createDefaultTrack('track')}
      markers={[marker]}
      lengthTicks={200}
      pxPerTick={8}
      settings={structuredClone(DEFAULT_SETTINGS)}
      selectedIds={new Set([marker.id])}
      validSoundIds={new Set(['test'])}
      {...callbacks}
      {...overrides}
    />,
  )
  const row = view.container.querySelector<HTMLElement>('[data-track-id="track"]')
  if (!row) throw new Error('Track row was not rendered')
  row.setPointerCapture = vi.fn()
  row.releasePointerCapture = vi.fn()
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: () => row,
  })
  return { ...view, row, callbacks }
}

describe('TimelineTrack legacy editing gestures', () => {
  it('keeps a tick-zero marker inside the visible timeline padding', () => {
    const { container, row, callbacks } = renderTrack({
      markers: [{ ...marker, tick: 0 }],
    })
    const markerElement = container.querySelector<HTMLElement>('[data-marker-id="marker"]')

    expect(Number(markerElement?.dataset.markerLeft)).toBe(
      TIMELINE_LEADING_PADDING_PX - TIMELINE_MARKER_HEIGHT / 2,
    )

    Object.defineProperty(row, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({ left: 100 }),
    })
    fireEvent.doubleClick(row, { clientX: 100 + TIMELINE_LEADING_PADDING_PX })
    expect(callbacks.onAddMarker).toHaveBeenCalledWith(0, 'track')
  })

  it('moves a marker to a tick before its original placement', () => {
    const { container, row, callbacks } = renderTrack()
    const markerElement = container.querySelector<HTMLElement>('[data-marker-id="marker"]')
    if (!markerElement) throw new Error('Marker was not rendered')

    fireEvent.pointerDown(markerElement, {
      button: 0,
      pointerId: 1,
      clientX: 160,
      clientY: 40,
    })
    fireEvent.pointerMove(row, { pointerId: 1, clientX: 80, clientY: 40 })

    expect(callbacks.onMoveSelection).toHaveBeenLastCalledWith('marker', 10, 'track', undefined)
  })

  it('uses Ctrl plus the endpoint to extend a single-shot marker', () => {
    const { container, row, callbacks } = renderTrack()
    const endpoint = container.querySelector<HTMLElement>('[data-marker-edge="end"]')
    if (!endpoint) throw new Error('End point was not rendered')

    fireEvent.pointerDown(endpoint, {
      button: 0,
      pointerId: 2,
      clientX: 160,
      ctrlKey: true,
    })
    fireEvent.pointerMove(row, {
      pointerId: 2,
      clientX: 200,
      clientY: 40,
      ctrlKey: true,
    })

    expect(callbacks.onResizeMarker).toHaveBeenLastCalledWith('marker', 20, 5)
  })

  it('stacks simultaneous markers at distinct vertical positions', () => {
    const simultaneous = { ...marker, id: 'marker-2' }
    const { container } = renderTrack({ markers: [marker, simultaneous] })
    const markers = Array.from(container.querySelectorAll<HTMLElement>('[data-marker-id]'))

    expect(markers).toHaveLength(2)
    expect(markers[0].dataset.markerTop).not.toBe(markers[1].dataset.markerTop)
  })

  it('moves a marker vertically within its track', () => {
    const { container, row, callbacks } = renderTrack()
    const markerElement = container.querySelector<HTMLElement>('[data-marker-id="marker"]')
    if (!markerElement) throw new Error('Marker was not rendered')

    fireEvent.pointerDown(markerElement, {
      button: 0,
      pointerId: 3,
      clientX: 160,
      clientY: 48,
    })
    fireEvent.pointerMove(row, {
      pointerId: 3,
      clientX: 160,
      clientY: 68,
    })

    const laneYs = callbacks.onMoveSelection.mock.lastCall?.[3] as Map<string, number>
    expect(callbacks.onMoveSelection).toHaveBeenCalled()
    expect(laneYs.get('marker')).toBeCloseTo(0.8)
  })

  it('snaps vertical movement to half the marker height', () => {
    const { container, row, callbacks } = renderTrack()
    const markerElement = container.querySelector<HTMLElement>('[data-marker-id="marker"]')
    if (!markerElement) throw new Error('Marker was not rendered')

    fireEvent.pointerDown(markerElement, {
      button: 0,
      pointerId: 5,
      clientX: 160,
      clientY: 48,
    })
    fireEvent.pointerMove(row, {
      pointerId: 5,
      clientX: 160,
      clientY: 52,
    })
    const firstLaneYs = callbacks.onMoveSelection.mock.lastCall?.[3] as Map<string, number>
    fireEvent.pointerMove(row, {
      pointerId: 5,
      clientX: 160,
      clientY: 55,
    })
    const secondLaneYs = callbacks.onMoveSelection.mock.lastCall?.[3] as Map<string, number>

    expect(firstLaneYs.get('marker')).toBeCloseTo(0.6)
    expect(secondLaneYs.get('marker')).toBeCloseTo(0.6)
  })

  it('renders saved lane positions on the vertical grid', () => {
    const { container } = renderTrack({ markers: [{ ...marker, laneY: 0.54 }] })
    const markerElement = container.querySelector<HTMLElement>('[data-marker-id="marker"]')

    expect(markerElement?.dataset.markerTop).toBe('48')
  })

  it('uses an optional visual icon without changing the default marker', () => {
    const icon = {
      dataUrl: 'data:image/png;base64,AA==',
      kind: 'item' as const,
      cropX: 0,
      cropY: 0,
      cropWidth: 16,
      cropHeight: 16,
      imageWidth: 16,
      imageHeight: 16,
    }
    const defaultView = renderTrack()
    expect(
      defaultView.container.querySelector<HTMLElement>('[data-marker-id="marker"]')
        ?.dataset.markerVisual,
    ).toBe('default')
    defaultView.unmount()

    const iconView = renderTrack({ markerIcons: { test: icon } })
    expect(
      iconView.container.querySelector<HTMLElement>('[data-marker-id="marker"]')
        ?.dataset.markerVisual,
    ).toBe('item')
    const viewport = iconView.container.querySelector<HTMLElement>('[data-marker-icon-viewport]')
    const image = iconView.container.querySelector<HTMLImageElement>('[data-marker-icon-image]')
    expect(image?.src).toBe(icon.dataUrl)
    expect(image?.style.width).toBe('16px')
    expect(image?.style.height).toBe('16px')
    expect(image?.style.left).toBe('0px')
    expect(image?.style.top).toBe('0px')
    expect(viewport?.style.borderWidth).toBe('')
    expect(viewport?.style.outlineWidth).toBe('1px')
  })

  it('does not clear a marker selection on its following click', () => {
    const { container, row, callbacks } = renderTrack({ selectedIds: new Set() })
    const markerElement = container.querySelector<HTMLElement>('[data-marker-id="marker"]')
    if (!markerElement) throw new Error('Marker was not rendered')

    fireEvent.pointerDown(markerElement, {
      button: 0,
      pointerId: 4,
      clientX: 160,
      clientY: 48,
    })
    fireEvent.pointerUp(row, {
      pointerId: 4,
      clientX: 160,
      clientY: 48,
    })
    fireEvent.click(row)

    expect(callbacks.onSelectMarker).toHaveBeenCalledWith('marker', { ctrl: false, shift: false })
    expect(callbacks.onClearSelection).not.toHaveBeenCalled()
  })
})
