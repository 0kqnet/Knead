import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Box, Button, Flex, Select, Text } from '@yamada-ui/react'
import { useTranslation } from 'react-i18next'
import { StudioDialogClose } from './StudioDialogClose'
import { PianoRollNotes, PIANO_ROLL_DOM_NOTE_LIMIT } from './PianoRollNotes'
import { useModalDialog } from '../hooks/useModalDialog'
import { PIANO_KEY_WIDTH, usePianoRollViewport } from '../hooks/usePianoRollViewport'
import { CommitNumberInput } from '../../components/CommitNumberInput'
import type { Marker, TempoMapEvent, TimelineState } from '../types/timeline'
import { isSoundStopMarker } from '../types/timeline'
import { createMarkerTickIndex, forEachMarkerInTickRange } from '../utils/markerTickIndex'
import {
  PIANO_ROLL_KEY_COUNT,
  PIANO_ROLL_MAX_MIDI_NOTE,
  applyPianoRollEdits,
  buildPianoRollTickGrid,
  editableFieldsChanged,
  filterPianoRollMarkers,
  formatMidiNote,
  getPianoRollMarkerRect,
  getPianoRollSpanTicks,
  movePianoRollMarkers,
  pianoRollNoteToPitch,
  selectPianoRollMarkersInRect,
  updatePianoRollMarkerFields,
  type PianoRollFilterMode,
} from '../utils/pianoRoll'
import { buildTempoMap, musicalBeatToTick, tickToMusicalBeat, type TempoMapModel } from '../utils/tempoMap'

const keys = Array.from({ length: PIANO_ROLL_KEY_COUNT }, (_, index) => PIANO_ROLL_MAX_MIDI_NOTE - index)

export interface PianoRollDialogProps {
  open: boolean
  project: TimelineState
  /** Overrides project.tempoMap for embedding contexts that hold the conductor map separately. */
  tempoMap?: readonly TempoMapEvent[]
  selectedIds: ReadonlySet<string> | readonly string[]
  currentTrackId?: string | null
  onApply: (state: TimelineState, affectedMarkerIds: readonly string[]) => void | Promise<void>
  /** Uses the Studio's existing decoded-audio path; the dialog never opens its own AudioContext. */
  onAudition?: (marker: Marker) => void | Promise<void>
  onClose: () => void
}

interface DragState {
  pointerId: number
  startX: number
  startY: number
  baseMarkers: Marker[]
  markerIds: Set<string>
}

interface RectangleState {
  pointerId: number
  startX: number
  startY: number
  currentX: number
  currentY: number
  baseSelection: Set<string>
}

function isBlackKey(note: number): boolean {
  return [1, 3, 6, 8, 10].includes(((note % 12) + 12) % 12)
}

function snapTicks(project: TimelineState, tempoModel: TempoMapModel, referenceTick: number): number {
  if (project.settings.snap.mode === 'tick') return project.settings.snap.tickStep
  if (project.settings.snap.mode === 'beat') {
    const beatStep = 4 / project.settings.snap.beatDivision
    const beat = tickToMusicalBeat(Math.max(0, referenceTick), tempoModel)
    const gridBeat = Math.floor(beat / beatStep) * beatStep
    const startTick = musicalBeatToTick(gridBeat, tempoModel)
    const endTick = musicalBeatToTick(gridBeat + beatStep, tempoModel)
    return Math.max(1, Math.round(endTick - startTick))
  }
  return 1
}

export const PianoRollDialog: React.FC<PianoRollDialogProps> = props => props.open
  ? <PianoRollEditor key={JSON.stringify([props.project.projectId, props.currentTrackId])} {...props} />
  : null

function PianoRollEditor({
  project, tempoMap, selectedIds, currentTrackId = null, onApply, onAudition, onClose,
}: PianoRollDialogProps) {
  const { t } = useTranslation()
  const effectiveTempoMap = tempoMap ?? project.tempoMap
  const tempoModel = useMemo(() => buildTempoMap(effectiveTempoMap, project.settings), [effectiveTempoMap, project.settings])
  const lockedTrackIds = useMemo(() => new Set(project.tracks.filter(track => track.locked).map(track => track.id)), [project.tracks])
  const originalById = useMemo(() => new Map(project.markers.map(marker => [marker.id, marker])), [project.markers])
  const externalSelection = useMemo(() => new Set([...selectedIds].filter((id) => {
    const marker = originalById.get(id)
    return marker && !isSoundStopMarker(marker)
  })), [selectedIds, originalById])
  const [filterMode, setFilterMode] = useState<PianoRollFilterMode>(() => externalSelection.size ? 'selected' : 'track')
  const [localSelection, setLocalSelection] = useState(() => new Set(externalSelection))
  const [edits, setEdits] = useState<Map<string, Marker>>(() => new Map())
  const [drag, setDrag] = useState<DragState | null>(null)
  const [preview, setPreview] = useState<Map<string, Marker> | null>(null)
  const [rectangle, setRectangle] = useState<RectangleState | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)
  const focusRequest = useRef<string | null>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const { dialogRef } = useModalDialog({ open: true, busy, onClose })

  const scope = useMemo(() => filterPianoRollMarkers(project, filterMode, externalSelection, currentTrackId).markers,
    [project, filterMode, externalSelection, currentTrackId])
  const markers = useMemo(() => edits.size ? scope.map(marker => edits.get(marker.id) ?? marker) : scope, [scope, edits])
  const tickIndex = useMemo(() => createMarkerTickIndex(markers), [markers])
  const selectedVisible = useMemo(() => {
    const selected: Marker[] = []
    for (const id of localSelection) {
      const marker = edits.get(id) ?? originalById.get(id)
      if (marker && (filterMode === 'track' ? marker.trackId === currentTrackId : externalSelection.has(id))) selected.push(marker)
    }
    return selected
  }, [originalById, edits, localSelection, filterMode, currentTrackId, externalSelection])
  const selectedEditable = useMemo(() => selectedVisible.filter(marker => !lockedTrackIds.has(marker.trackId)), [selectedVisible, lockedTrackIds])
  const view = usePianoRollViewport(project.lengthTicks, markers, selectedVisible[0])
  const { pxPerTick, rowHeight, canvasWidth, windowStart, windowEnd, origin } = view
  const canvasHeight = PIANO_ROLL_KEY_COUNT * rowHeight
  const gridStep = snapTicks(project, tempoModel, selectedVisible[0]?.tick ?? 0)
  const gridLines = useMemo(() => buildPianoRollTickGrid(
    windowStart / pxPerTick, Math.min(project.lengthTicks, windowEnd / pxPerTick),
    project.settings, effectiveTempoMap, Math.max(12, Math.ceil((windowEnd - windowStart) / 8)), tempoModel,
  ), [windowStart, windowEnd, pxPerTick, project.lengthTicks, project.settings, effectiveTempoMap, tempoModel])
  const windowMarkers = useMemo(() => {
    const result: Marker[] = []
    // One-shots have an eight-pixel hit target even though their stored duration is zero.
    forEachMarkerInTickRange(tickIndex, (windowStart - 8) / pxPerTick, windowEnd / pxPerTick, marker => result.push(marker))
    return result
  }, [tickIndex, windowStart, windowEnd, pxPerTick])
  const drawnMarkers = useMemo(() => {
    if (!preview) return windowMarkers
    const notes = windowMarkers.filter(marker => !preview.has(marker.id))
    for (const marker of preview.values()) {
      const left = marker.tick * pxPerTick
      if (left <= windowEnd && left + Math.max(8, getPianoRollSpanTicks(marker) * pxPerTick) >= windowStart) notes.push(marker)
    }
    return notes
  }, [preview, windowMarkers, windowStart, windowEnd, pxPerTick])
  const dense = drawnMarkers.length > PIANO_ROLL_DOM_NOTE_LIMIT
  const template = selectedVisible[0] ?? markers[0]
  const changedCount = edits.size

  useLayoutEffect(() => {
    if (!focusRequest.current) return
    const button = Array.from(gridRef.current?.querySelectorAll<HTMLElement>('[data-piano-roll-note]') ?? [])
      .find(element => element.dataset.pianoRollNote === focusRequest.current)
    if (button) {
      button.focus({ preventScroll: true })
      focusRequest.current = null
    }
  }, [focusId, drawnMarkers])

  const commitMarkers = useCallback((changed: readonly Marker[]) => {
    if (!changed.length) return
    setEdits((previous) => {
      const next = new Map(previous)
      for (const marker of changed) {
        const original = originalById.get(marker.id)
        if (original && editableFieldsChanged(original, marker)) next.set(marker.id, marker)
        else next.delete(marker.id)
      }
      return next
    })
  }, [originalById])

  function audition(marker: Marker | undefined, note?: number) {
    if (!marker || !onAudition) return
    const candidate = note === undefined ? marker : { ...marker, pitch: pianoRollNoteToPitch(note) }
    void Promise.resolve(onAudition(candidate)).catch(caught => setError(String(caught)))
  }

  function canvasPoint(event: React.MouseEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect()
    return { x: event.clientX - bounds.left + origin, y: event.clientY - bounds.top }
  }

  function targetNote(target: EventTarget | null) {
    const id = target instanceof Element ? target.closest<HTMLElement>('[data-piano-roll-note]')?.dataset.pianoRollNote : undefined
    return id ? edits.get(id) ?? originalById.get(id) : undefined
  }

  function hitNote(event: React.MouseEvent<HTMLDivElement>) {
    const button = targetNote(event.target)
    if (button && !dense) return button
    const { x, y } = canvasPoint(event)
    let hit: Marker | undefined
    forEachMarkerInTickRange(tickIndex, (x - 8) / pxPerTick, x / pxPerTick, (marker) => {
      const rect = getPianoRollMarkerRect(marker, { startTick: 0, pxPerTick, rowHeight })
      if (x <= rect.left + rect.width && y >= rect.top && y <= rect.top + rect.height) hit = marker
    })
    return hit
  }

  function beginGesture(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button > 0 || drag || rectangle) return
    const marker = hitNote(event)
    const { x, y } = canvasPoint(event)
    if (!marker) {
      if (event.pointerType === 'touch') return
      event.currentTarget.setPointerCapture?.(event.pointerId)
      setRectangle({ pointerId: event.pointerId, startX: x, startY: y, currentX: x, currentY: y,
        baseSelection: event.ctrlKey || event.metaKey || event.shiftKey ? localSelection : new Set() })
      return
    }
    let selection: Set<string>
    if (event.ctrlKey || event.metaKey || event.shiftKey) {
      selection = new Set(localSelection)
      if ((event.ctrlKey || event.metaKey) && selection.has(marker.id)) selection.delete(marker.id)
      else selection.add(marker.id)
    }
    else selection = localSelection.has(marker.id) ? localSelection : new Set([marker.id])
    setLocalSelection(selection)
    setFocusId(marker.id)
    if (dense) event.currentTarget.focus({ preventScroll: true })
    if (!selection.has(marker.id) || lockedTrackIds.has(marker.trackId)) return
    const baseMarkers: Marker[] = []
    for (const id of selection) {
      const note = edits.get(id) ?? originalById.get(id)
      if (note && !lockedTrackIds.has(note.trackId)) baseMarkers.push(note)
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    setDrag({ pointerId: event.pointerId, startX: x, startY: y, baseMarkers, markerIds: selection })
  }

  function draggedNotes(gesture: DragState, x: number, y: number) {
    if (Math.abs(x - gesture.startX) < 3 && Math.abs(y - gesture.startY) < 3) return gesture.baseMarkers
    return movePianoRollMarkers(gesture.baseMarkers, {
      markerIds: gesture.markerIds, deltaTick: (x - gesture.startX) / pxPerTick,
      deltaSemitones: (gesture.startY - y) / rowHeight, snapTicks: gridStep,
      lengthTicks: project.lengthTicks, lockedTrackIds, settings: project.settings, tempoModel,
    }).markers
  }

  function moveGesture(event: React.PointerEvent<HTMLDivElement>) {
    if (!drag && !rectangle) return
    const { x, y } = canvasPoint(event)
    if (drag && event.pointerId === drag.pointerId) {
      setPreview(new Map(draggedNotes(drag, x, y).map(marker => [marker.id, marker])))
    }
    if (rectangle && event.pointerId === rectangle.pointerId) setRectangle({ ...rectangle, currentX: x, currentY: y })
  }

  const cancelGesture = useCallback(() => {
    setDrag(null)
    setPreview(null)
    setRectangle(null)
  }, [])

  const changeFilter = useCallback((mode: PianoRollFilterMode) => {
    cancelGesture()
    setFocusId(null)
    setFilterMode(mode)
    setLocalSelection(mode === 'selected' ? new Set(externalSelection) : new Set())
  }, [cancelGesture, externalSelection])

  function endGesture(event: React.PointerEvent<HTMLDivElement>) {
    const { x, y } = canvasPoint(event)
    if (drag && event.pointerId === drag.pointerId) {
      const notes = draggedNotes(drag, x, y)
      if (notes !== drag.baseMarkers) commitMarkers(notes)
      cancelGesture()
    }
    if (rectangle && event.pointerId === rectangle.pointerId) {
      const candidates: Marker[] = []
      forEachMarkerInTickRange(tickIndex, (Math.min(rectangle.startX, x) - 8) / pxPerTick,
        Math.max(rectangle.startX, x) / pxPerTick, marker => candidates.push(marker))
      setLocalSelection(selectPianoRollMarkersInRect(candidates,
        { left: rectangle.startX, top: rectangle.startY, right: x, bottom: y },
        { startTick: 0, pxPerTick, rowHeight }, rectangle.baseSelection))
      cancelGesture()
    }
  }

  function handleNoteKey(event: React.KeyboardEvent<HTMLDivElement>) {
    const marker = targetNote(event.target) ?? (focusId ? edits.get(focusId) ?? originalById.get(focusId) : undefined)
    if (!marker) return
    if (event.key === 'Tab') {
      const index = tickIndex.entries.findIndex(entry => entry.marker.id === marker.id)
      const next = tickIndex.entries[index + (event.shiftKey ? -1 : 1)]?.marker
      if (index >= 0 && next) {
        event.preventDefault()
        view.revealNote(next)
        focusRequest.current = next.id
        setFocusId(next.id)
      }
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      audition(marker)
      return
    }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp'].includes(event.key)) return
    event.preventDefault()
    if (lockedTrackIds.has(marker.trackId)) return
    const group = localSelection.has(marker.id) ? selectedEditable : [marker]
    if (!localSelection.has(marker.id)) setLocalSelection(new Set([marker.id]))
    const horizontal = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0
    const musical = horizontal !== 0 && project.settings.snap.mode === 'beat'
    commitMarkers(movePianoRollMarkers(group, {
      markerIds: new Set(group.map(note => note.id)), lockedTrackIds, lengthTicks: project.lengthTicks,
      deltaTick: musical ? 0 : horizontal * gridStep,
      deltaBeats: musical ? horizontal * 4 / project.settings.snap.beatDivision : undefined,
      deltaSemitones: event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0,
      snapTicks: gridStep, settings: project.settings, tempoModel,
    }).markers)
  }

  const updateSelected = useCallback((patch: Parameters<typeof updatePianoRollMarkerFields>[2]) => {
    commitMarkers(updatePianoRollMarkerFields(selectedEditable, localSelection, patch, lockedTrackIds).markers)
  }, [commitMarkers, selectedEditable, localSelection, lockedTrackIds])

  const apply = async () => {
    const result = applyPianoRollEdits(project, [...edits.values()], effectiveTempoMap)
    if (result.changedIds.length === 0) return
    setBusy(true)
    setError('')
    try {
      await onApply(result.state, result.changedIds)
      onClose()
    }
    catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
    finally {
      setBusy(false)
    }
  }

  const rectangleStyle = rectangle
    ? {
        left: Math.min(rectangle.startX, rectangle.currentX) - origin,
        top: Math.min(rectangle.startY, rectangle.currentY),
        width: Math.abs(rectangle.currentX - rectangle.startX),
        height: Math.abs(rectangle.currentY - rectangle.startY),
      }
    : null

  return (
    <Box
      position="fixed" inset="0" zIndex="2140" bg="var(--knead-scrim)"
      display="flex" alignItems="center" justifyContent="center"
      ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t('studio.piano_roll_title')}
      onPointerDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}
    >
      <Box
        w="min(1180px, calc(100vw - 24px))" h="min(820px, calc(100vh - 24px))"
        bg="var(--studio-panel)" borderRadius="lg" boxShadow="xl" p="4" display="flex" flexDirection="column"
      >
        <PianoRollToolbar
          trackName={project.tracks.find(track => track.id === currentTrackId)?.name ?? '—'}
          filterMode={filterMode} onFilter={changeFilter} markers={markers}
          onZoom={view.changeZoom} onClose={onClose} busy={busy}
        />

        <Flex mt="3" gap="3" fontSize="xs" color="var(--studio-muted)">
          <Text>{t('studio.piano_roll_visible_count', { count: markers.length })}</Text>
          <Text>{t('studio.piano_roll_selected_count', { count: localSelection.size })}</Text>
          <Text>{t('studio.piano_roll_changed_count', { count: changedCount })}</Text>
          <Text>{t('studio.piano_roll_grid_step', { count: gridStep })}</Text>
          {lockedTrackIds.size > 0 && <Text color="var(--studio-warning)">{t('studio.piano_roll_locked_hint')}</Text>}
        </Flex>

        <Box ref={view.scrollerRef} onScroll={view.updateViewport} data-testid="piano-roll-scroll" mt="3" flex="1" minH="0" overflow="auto" overscrollBehavior="contain" bg="var(--studio-canvas)" border="1px solid" borderColor="var(--studio-line)">
          <div className="piano-roll-content" style={{ width: PIANO_KEY_WIDTH + canvasWidth, minHeight: canvasHeight }}>
            <div className="piano-roll-keyboard" style={{ width: PIANO_KEY_WIDTH }}>
              {keys.map(note => (
                <button
                  type="button" key={note} className="piano-roll-key" data-black={isBlackKey(note)}
                  style={{ height: rowHeight }} aria-label={t('studio.piano_roll_audition_key', { note: formatMidiNote(note) })}
                  disabled={!onAudition || !template} onClick={() => audition(template, note)}
                >
                  {formatMidiNote(note)}
                </button>
              ))}
            </div>
            <div
              ref={gridRef} className="piano-roll-grid" tabIndex={-1}
              style={{ width: canvasWidth, height: canvasHeight }}
              role="group" aria-label={t('studio.piano_roll_grid')}
              data-testid="piano-roll-grid"
              data-px-per-tick={pxPerTick}
              onPointerDown={beginGesture} onPointerMove={moveGesture} onPointerUp={endGesture}
              onPointerCancel={cancelGesture} onLostPointerCapture={cancelGesture}
              onDoubleClick={event => audition(hitNote(event))}
              onKeyDown={handleNoteKey}
              onFocus={(event) => {
                const note = targetNote(event.target)
                if (note) setFocusId(note.id)
              }}
            >
              {keys.map((note, index) => (
                <div
                  key={note} className="piano-roll-row" data-black={isBlackKey(note)}
                  style={{ top: index * rowHeight, height: rowHeight }}
                />
              ))}
              {gridLines.map(line => (
                <div
                  key={line.tick} className="piano-roll-grid-line" data-kind={line.kind}
                  style={{ left: line.tick * pxPerTick - origin }}
                >
                  {line.kind === 'bar' && <span>{Math.round(line.tick)}</span>}
                </div>
              ))}
              <PianoRollNotes
                markers={drawnMarkers} selection={localSelection} lockedTracks={lockedTrackIds}
                focusId={focusId} pxPerTick={pxPerTick} rowHeight={rowHeight} origin={origin}
                windowStart={windowStart} windowEnd={windowEnd}
              />

              {rectangleStyle && (
                <div className="piano-roll-selection" style={rectangleStyle} data-testid="piano-roll-selection-rectangle" />
              )}
            </div>
          </div>
        </Box>

        <PianoRollInspector selectedEditable={selectedEditable} updateSelected={updateSelected} />
        {error && <Text mt="2" role="alert" color="var(--studio-error)">{t('studio.piano_roll_error', { error })}</Text>}
        <Flex mt="3" justify="flex-end" gap="2">
          <Button onClick={onClose} disabled={busy}>{t('studio.cancel')}</Button>
          <Button colorScheme="primary" loading={busy} disabled={changedCount === 0} onClick={() => { void apply() }}>
            {t('studio.piano_roll_apply', { count: changedCount })}
          </Button>
        </Flex>
      </Box>
    </Box>
  )
}

const PianoRollToolbar = React.memo(function PianoRollToolbar({
  trackName, filterMode, onFilter, onZoom, markers, onClose, busy,
}: {
  trackName: string
  filterMode: PianoRollFilterMode
  onFilter: (mode: PianoRollFilterMode) => void
  onZoom: ReturnType<typeof usePianoRollViewport>['changeZoom']
  markers: readonly Marker[]
  onClose: () => void
  busy: boolean
}) {
  const { t } = useTranslation()
  return (
    <Flex align="center" gap="2" wrap="wrap">
      <Box>
        <Text fontSize="xl" fontWeight="bold">{t('studio.piano_roll_title')}</Text>
        <Text fontSize="xs" color="var(--studio-muted)">{t('studio.piano_roll_description')}</Text>
      </Box>
      <Box flex="1" />
      <Select.Root
        rootProps={{ w: '220px' }} value={filterMode}
        items={[
          { value: 'selected', label: t('studio.piano_roll_filter_selected') },
          { value: 'track', label: t('studio.piano_roll_filter_track', {
            name: trackName,
          }) },
        ]}
        aria-label={t('studio.piano_roll_filter')}
        onChange={value => onFilter(value as PianoRollFilterMode)}
      />
      <Button size="sm" onClick={() => onZoom({ factor: 1 / 1.5 })}>
        {t('studio.piano_roll_zoom_out')}
      </Button>
      <Button size="sm" onClick={() => onZoom({ factor: 1.5 })}>
        {t('studio.piano_roll_zoom_in')}
      </Button>
      <Button size="sm" onClick={() => onZoom({ rows: -4 })}>Y−</Button>
      <Button size="sm" onClick={() => onZoom({ rows: 4 })}>Y＋</Button>
      <Button size="sm" onClick={() => onZoom({ fit: markers })}>
        {t('studio.piano_roll_fit')}
      </Button>
      <StudioDialogClose onClick={onClose} disabled={busy} />
    </Flex>
  )
})

const PianoRollInspector = React.memo(function PianoRollInspector({ selectedEditable, updateSelected }: {
  selectedEditable: readonly Marker[]
  updateSelected: (patch: Parameters<typeof updatePianoRollMarkerFields>[2]) => void
}) {
  const { t } = useTranslation()
  const firstEditable = selectedEditable[0]
  return (
    <Flex mt="3" gap="3" align="center" wrap="wrap">
      <Text fontSize="sm" minW="150px">
        {firstEditable
          ? t('studio.piano_roll_inspector_count', { count: selectedEditable.length })
          : t('studio.piano_roll_inspector_empty')}
      </Text>
      <Flex align="center" gap="2">
        <Text fontSize="xs">{t('studio.piano_roll_velocity')}</Text>
        <CommitNumberInput
          aria-label={t('studio.piano_roll_velocity')}
          value={Math.round((firstEditable?.volume ?? 0) * 100)} min={0} max={100} step={1} precision={0}
          size="sm" w="92px" disabled={!firstEditable}
          onCommit={value => updateSelected({ volume: value / 100 })}
        />
      </Flex>
      <Flex align="center" gap="2">
        <Text fontSize="xs">{t('studio.piano_roll_pan')}</Text>
        <CommitNumberInput
          aria-label={t('studio.piano_roll_pan')}
          value={Math.round((firstEditable?.pan ?? 0) * 100)} min={-100} max={100} step={1} precision={0}
          size="sm" w="92px" disabled={!firstEditable}
          onCommit={value => updateSelected({ pan: value / 100 })}
        />
      </Flex>
      <Flex align="center" gap="2">
        <Text fontSize="xs">{t('studio.piano_roll_duration')}</Text>
        <CommitNumberInput
          aria-label={t('studio.piano_roll_duration')}
          value={firstEditable?.duration ?? 0} min={0} max={1_000_000} step={1} precision={0}
          size="sm" w="105px" disabled={!firstEditable}
          onCommit={value => updateSelected({ duration: value })}
        />
      </Flex>
      <Flex align="center" gap="2">
        <Text fontSize="xs">{t('studio.piano_roll_retrigger')}</Text>
        <CommitNumberInput
          aria-label={t('studio.piano_roll_retrigger')}
          value={firstEditable?.retriggerInterval ?? 1} min={1} max={1_000_000} step={1} precision={0}
          size="sm" w="105px" disabled={!firstEditable}
          onCommit={value => updateSelected({ retriggerInterval: value })}
        />
      </Flex>
    </Flex>
  )
})
