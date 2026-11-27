import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box } from '@yamada-ui/react'
import { useTranslation } from 'react-i18next'
import {
  TIMELINE_MARKER_HEIGHT,
  TIMELINE_LEADING_PADDING_PX,
  TIMELINE_LANE_STEP_PX,
  TRACK_HEIGHT,
  TRACK_HEIGHT_COLLAPSED,
  isSoundStopMarker,
  laneYToMarkerCenterY,
  markerCenterYToLaneY,
  type Marker,
  type TempoMapEvent,
  type TimelineSettings,
  type Track,
} from '../types/timeline'
import { pxDeltaToTick, pxToTick, tickToPx } from '../utils/tickPixel'
import { buildTempoMap, snapTickToTempoMap } from '../utils/tempoMap'
import { ResizeEdge, TimelineMarker } from './TimelineMarker'
import type { MarkerVisualIcon } from '../../../../@types/global'

export interface SelectModifiers {
  ctrl: boolean
  shift: boolean
}

interface Props {
  track: Track
  markers: Marker[]
  lengthTicks: number
  pxPerTick: number
  settings: TimelineSettings
  tempoMap?: readonly TempoMapEvent[]
  selectedIds: Set<string>
  validSoundIds: Set<string>
  markerIcons?: Record<string, MarkerVisualIcon>
  onSelectMarker: (id: string, modifiers: SelectModifiers) => void
  onClearSelection: () => void
  onRectangleSelect: (ids: string[], additive: boolean) => void
  onBeginEdit: (primaryId: string) => void
  onEndEdit: () => void
  onMoveSelection: (
    primaryId: string,
    tick: number,
    targetTrackId: string,
    laneYs?: Map<string, number>,
  ) => void
  onResizeMarker: (id: string, tick: number, duration: number) => void
  onDuplicateForDrag: (primaryId: string) => string
  onAddMarker: (tick: number, trackId: string) => void
}

interface DragState {
  pointerId: number
  primaryId: string
  originClientX: number
  originClientY: number
  originTick: number
  originDuration: number
  originLaneYs: Map<string, number>
  edge: ResizeEdge | null
  moved: boolean
  editing: boolean
}

export const TimelineTrack: React.FC<Props> = ({
  track, markers, lengthTicks, pxPerTick, settings, tempoMap, selectedIds, validSoundIds,
  markerIcons = {},
  onSelectMarker, onClearSelection, onRectangleSelect, onBeginEdit, onEndEdit,
  onMoveSelection, onResizeMarker, onDuplicateForDrag, onAddMarker,
}) => {
  const { t } = useTranslation()
  const rowRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const ignoreClickRef = useRef(false)
  const [selectionRect, setSelectionRect] = useState<{ start: number, end: number } | null>(null)
  const selectionPointerRef = useRef<number | null>(null)
  const [ctrlPressed, setCtrlPressed] = useState(false)
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

  const markerYById = useMemo(() => {
    const result = new Map<string, number>()
    const groups = new Map<number, Marker[]>()
    for (const marker of markers) {
      const group = groups.get(marker.tick)
      if (group) group.push(marker)
      else groups.set(marker.tick, [marker])
    }
    const height = track.collapsed ? TRACK_HEIGHT_COLLAPSED : TRACK_HEIGHT
    const center = height / 2
    const half = TIMELINE_MARKER_HEIGHT / 2
    const laneSpan = Math.max(1, height - TIMELINE_MARKER_HEIGHT)
    const candidates = Array.from(
      { length: Math.max(1, Math.floor(laneSpan / TIMELINE_LANE_STEP_PX) + 1) },
      (_, index) => half + index * TIMELINE_LANE_STEP_PX,
    )
    if (candidates.at(-1) !== height - half) candidates.push(height - half)
    candidates.sort((a, b) => Math.abs(a - center) - Math.abs(b - center) || a - b)
    for (const group of groups.values()) {
      const assigned: number[] = []
      for (const marker of group) {
        if (marker.laneY === undefined) continue
        const y = laneYToMarkerCenterY(marker.laneY, height)
        result.set(marker.id, y)
        assigned.push(y)
      }
      for (const marker of group) {
        if (marker.laneY !== undefined) continue
        const y = candidates.find(candidate => (
          assigned.every(existing => Math.abs(existing - candidate) >= TIMELINE_MARKER_HEIGHT + 2)
        )) ?? center
        result.set(marker.id, y)
        assigned.push(y)
      }
    }
    return result
  }, [markers, track.collapsed])

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === 'Control' || event.key === 'Meta') setCtrlPressed(true)
    }
    const keyUp = (event: KeyboardEvent) => {
      if (event.key === 'Control' || event.key === 'Meta') setCtrlPressed(false)
    }
    const blur = () => setCtrlPressed(false)
    window.addEventListener('keydown', keyDown)
    window.addEventListener('keyup', keyUp)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', keyDown)
      window.removeEventListener('keyup', keyUp)
      window.removeEventListener('blur', blur)
    }
  }, [])

  const handleMarkerPointerDown = useCallback((marker: Marker, edge: ResizeEdge | null, event: React.PointerEvent) => {
    if (track.locked || event.button !== 0) return
    event.stopPropagation()
    const control = event.ctrlKey || event.metaKey
    const resizing = control && edge !== null && !isSoundStopMarker(marker)
    if (!resizing && (control || event.shiftKey)) {
      onSelectMarker(marker.id, { ctrl: control, shift: event.shiftKey })
      return
    }
    if (resizing && !selectedIds.has(marker.id)) {
      onSelectMarker(marker.id, { ctrl: false, shift: false })
    }
    let primaryId = marker.id
    if (event.altKey && edge === null) {
      primaryId = onDuplicateForDrag(marker.id)
    }
    else if (!selectedIds.has(marker.id)) {
      onSelectMarker(marker.id, {
        ctrl: false,
        shift: false,
      })
    }
    const dragIds = selectedIds.has(marker.id) ? selectedIds : new Set([marker.id])
    const height = track.collapsed ? TRACK_HEIGHT_COLLAPSED : TRACK_HEIGHT
    const originLaneYs = new Map<string, number>()
    for (const item of markers) {
      if (!dragIds.has(item.id)) continue
      const y = markerYById.get(item.id) ?? height / 2
      originLaneYs.set(item.id, markerCenterYToLaneY(y, height))
    }
    ignoreClickRef.current = true
    dragRef.current = {
      pointerId: event.pointerId,
      primaryId,
      originClientX: event.clientX,
      originClientY: event.clientY,
      originTick: marker.tick,
      originDuration: marker.duration ?? 0,
      originLaneYs,
      edge: resizing ? edge : null,
      moved: false,
      editing: false,
    }
    rowRef.current?.setPointerCapture?.(event.pointerId)
  }, [
    markerYById, markers, onDuplicateForDrag, onSelectMarker, selectedIds,
    track.collapsed, track.locked,
  ])

  const handlePointerMove = useCallback((event: React.PointerEvent) => {
    const drag = dragRef.current
    if (drag && drag.pointerId === event.pointerId) {
      const deltaPx = event.clientX - drag.originClientX
      const deltaY = event.clientY - drag.originClientY
      if (!drag.moved && Math.hypot(deltaPx, deltaY) < 3) return
      drag.moved = true
      if (!drag.editing) {
        drag.editing = true
        onBeginEdit(drag.primaryId)
      }
      const deltaTick = pxDeltaToTick(deltaPx, pxPerTick)
      if (drag.edge) {
        const originEnd = drag.originTick + drag.originDuration
        if (drag.edge === 'start') {
          const tick = snapTickToTempoMap(
            Math.max(0, Math.min(originEnd, drag.originTick + deltaTick)),
            settings,
            tempoModel,
            event.altKey,
          )
          onResizeMarker(drag.primaryId, tick, Math.max(0, originEnd - tick))
        }
        else {
          const end = snapTickToTempoMap(
            Math.max(drag.originTick, originEnd + deltaTick),
            settings,
            tempoModel,
            event.altKey,
          )
          onResizeMarker(drag.primaryId, drag.originTick, Math.max(0, end - drag.originTick))
        }
      }
      else {
        const target = document.elementFromPoint(event.clientX, event.clientY)
          ?.closest<HTMLElement>('[data-track-id]')
        const targetTrackId = target?.dataset.trackId ?? track.id
        const tick = snapTickToTempoMap(
          drag.originTick + deltaTick,
          settings,
          tempoModel,
          event.altKey,
        )
        let laneYs: Map<string, number> | undefined
        if (Math.abs(deltaY) >= 3) {
          const height = track.collapsed ? TRACK_HEIGHT_COLLAPSED : TRACK_HEIGHT
          laneYs = new Map(Array.from(drag.originLaneYs, ([id, origin]) => [
            id,
            markerCenterYToLaneY(laneYToMarkerCenterY(origin, height) + deltaY, height),
          ]))
        }
        onMoveSelection(drag.primaryId, tick, targetTrackId, laneYs)
      }
      return
    }

    if (selectionPointerRef.current === event.pointerId && selectionRect && rowRef.current) {
      const rect = rowRef.current.getBoundingClientRect()
      setSelectionRect(current => current ? { ...current, end: event.clientX - rect.left } : null)
    }
  }, [
    onBeginEdit, onMoveSelection, onResizeMarker, pxPerTick, selectionRect, settings, tempoModel,
    track.collapsed, track.id,
  ])

  const finishPointer = useCallback((event: React.PointerEvent) => {
    const drag = dragRef.current
    if (drag?.pointerId === event.pointerId) {
      if (drag.editing) {
        ignoreClickRef.current = true
        onEndEdit()
      }
      rowRef.current?.releasePointerCapture?.(event.pointerId)
      dragRef.current = null
      window.setTimeout(() => {
        ignoreClickRef.current = false
      }, 0)
    }
    if (selectionPointerRef.current === event.pointerId) {
      selectionPointerRef.current = null
      if (selectionRect) {
        const left = Math.min(selectionRect.start, selectionRect.end)
        const right = Math.max(selectionRect.start, selectionRect.end)
        const ids = markers
          .filter((marker) => {
            const x = TIMELINE_LEADING_PADDING_PX + tickToPx(marker.tick, pxPerTick)
            return x >= left && x <= right
          })
          .map(marker => marker.id)
        onRectangleSelect(ids, event.ctrlKey || event.metaKey)
      }
      setSelectionRect(null)
    }
  }, [markers, onEndEdit, onRectangleSelect, pxPerTick, selectionRect])

  const handleBackgroundPointerDown = useCallback((event: React.PointerEvent) => {
    if (event.button !== 0 || !event.shiftKey || !rowRef.current) return
    const rect = rowRef.current.getBoundingClientRect()
    selectionPointerRef.current = event.pointerId
    setSelectionRect({ start: event.clientX - rect.left, end: event.clientX - rect.left })
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  }, [])

  const height = track.collapsed ? TRACK_HEIGHT_COLLAPSED : TRACK_HEIGHT
  return (
    <Box
      ref={rowRef}
      data-track-id={track.id}
      position="relative"
      h={`${height}px`}
      w={`${TIMELINE_LEADING_PADDING_PX + tickToPx(lengthTicks, pxPerTick)}px`}
      minW="100%"
      borderBottom="1px solid"
      borderColor="var(--studio-line)"
      bg={track.locked ? 'var(--studio-raised)' : 'var(--studio-canvas)'}
      backgroundImage="linear-gradient(to right, var(--studio-grid) 1px, transparent 1px), linear-gradient(to bottom, transparent 7px, var(--studio-lane-grid) 7px, var(--studio-lane-grid) 8px)"
      backgroundSize={`${Math.max(1, tickToPx(settings.snap.tickStep, pxPerTick))}px 100%, 100% ${TIMELINE_LANE_STEP_PX}px`}
      backgroundPosition={`${TIMELINE_LEADING_PADDING_PX}px 0, 0 0`}
      onPointerDown={handleBackgroundPointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishPointer}
      onPointerCancel={finishPointer}
      onClick={(event) => {
        if (ignoreClickRef.current) {
          ignoreClickRef.current = false
          return
        }
        if (event.target === event.currentTarget && !event.shiftKey) onClearSelection()
      }}
      onDoubleClick={(event) => {
        if (track.locked || event.target !== event.currentTarget) return
        const rect = event.currentTarget.getBoundingClientRect()
        onAddMarker(snapTickToTempoMap(
          pxToTick(event.clientX - rect.left - TIMELINE_LEADING_PADDING_PX, pxPerTick),
          settings,
          tempoModel,
          event.altKey,
        ), track.id)
      }}
    >
      {!track.collapsed && markers.map((marker) => {
        const soundStop = isSoundStopMarker(marker)
        return (
          <TimelineMarker
            key={marker.id}
            marker={marker}
            track={track}
            pxPerTick={pxPerTick}
            selected={selectedIds.has(marker.id)}
            invalidSound={!soundStop && (!marker.soundId || !validSoundIds.has(marker.soundId))}
            markerIcon={!soundStop && validSoundIds.has(marker.soundId) ? markerIcons[marker.soundId] : undefined}
            soundStopTitle={soundStop
              ? marker.action.scope === 'all'
                ? t('studio.sound_stopper_marker_all')
                : t('studio.sound_stopper_marker_range', {
                    start: marker.action.startTrack,
                    end: marker.action.endTrack,
                  })
              : undefined}
            resizeCursor={ctrlPressed && !soundStop}
            topPx={markerYById.get(marker.id) ?? height / 2}
            onPointerDown={(edge, event) => handleMarkerPointerDown(marker, edge, event)}
          />
        )
      })}
      {selectionRect && (
        <Box
          position="absolute"
          left={`${Math.min(selectionRect.start, selectionRect.end)}px`}
          top="2px"
          bottom="2px"
          w={`${Math.abs(selectionRect.end - selectionRect.start)}px`}
          bg="var(--studio-selection-fill)"
          border="1px solid"
          borderColor="var(--knead-focus)"
          pointerEvents="none"
          zIndex="8"
        />
      )}
    </Box>
  )
}
