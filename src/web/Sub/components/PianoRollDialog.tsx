import React, { useEffect, useMemo, useState } from 'react'
import { Box, Button, Flex, Select, Text } from '@yamada-ui/react'
import { useTranslation } from 'react-i18next'
import { CommitNumberInput } from '../../components/CommitNumberInput'
import type { Marker, TempoMapEvent, TimelineState } from '../types/timeline'
import {
  PIANO_ROLL_KEY_COUNT,
  PIANO_ROLL_MAX_DRAFT_MARKERS,
  PIANO_ROLL_MAX_MIDI_NOTE,
  PIANO_ROLL_MAX_PX_PER_TICK,
  PIANO_ROLL_MAX_ROW_HEIGHT,
  PIANO_ROLL_MIN_PX_PER_TICK,
  PIANO_ROLL_MIN_ROW_HEIGHT,
  applyPianoRollEdits,
  buildPianoRollTickGrid,
  filterPianoRollMarkers,
  fitPianoRollPxPerTick,
  formatMidiNote,
  formatPianoRollPitch,
  getPianoRollMarkerRect,
  getPianoRollSpanTicks,
  movePianoRollMarkers,
  pianoRollNoteToPitch,
  selectPianoRollMarkersInRect,
  updatePianoRollMarkerFields,
  type PianoRollFilterMode,
} from '../utils/pianoRoll'
import {
  buildTempoMap,
  musicalBeatToTick,
  tickToMusicalBeat,
  type TempoMapModel,
} from '../utils/tempoMap'

const MIN_CANVAS_WIDTH = 820
const MAX_CANVAS_WIDTH = 1_000_000

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

function toIdSet(ids: ReadonlySet<string> | readonly string[]): Set<string> {
  return ids instanceof Set ? new Set(ids) : new Set(ids)
}

function collectDraftMarkers(
  project: TimelineState,
  selectedIds: ReadonlySet<string> | readonly string[],
  currentTrackId: string | null | undefined,
): Marker[] {
  const selected = filterPianoRollMarkers(project, 'selected', selectedIds, currentTrackId).markers
  const track = filterPianoRollMarkers(project, 'track', selectedIds, currentTrackId).markers
  const markers = new Map<string, Marker>()
  for (const marker of [...selected, ...track]) markers.set(marker.id, marker)
  return [...markers.values()].slice(0, PIANO_ROLL_MAX_DRAFT_MARKERS)
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

function editableFieldsDiffer(left: Marker, right: Marker): boolean {
  return left.tick !== right.tick
    || left.pitch !== right.pitch
    || left.volume !== right.volume
    || (left.pan ?? 0) !== (right.pan ?? 0)
    || left.duration !== right.duration
    || left.retriggerInterval !== right.retriggerInterval
}

function panColor(pan: number): string {
  if (pan < -0.2) return '#63b3ed'
  if (pan > 0.2) return '#f687b3'
  return '#68d391'
}

export const PianoRollDialog: React.FC<PianoRollDialogProps> = ({
  open,
  project,
  tempoMap,
  selectedIds,
  currentTrackId = null,
  onApply,
  onAudition,
  onClose,
}) => {
  const { t } = useTranslation()
  const [filterMode, setFilterMode] = useState<PianoRollFilterMode>('selected')
  const [draftMarkers, setDraftMarkers] = useState<Marker[]>([])
  const [localSelection, setLocalSelection] = useState<Set<string>>(new Set())
  const [pxPerTick, setPxPerTick] = useState(3)
  const [rowHeight, setRowHeight] = useState(24)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [rectangle, setRectangle] = useState<RectangleState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const externalSelection = useMemo(() => toIdSet(selectedIds), [selectedIds])
  const effectiveTempoMap = tempoMap ?? project.tempoMap
  const tempoModel = useMemo(
    () => buildTempoMap(effectiveTempoMap, project.settings),
    [effectiveTempoMap, project.settings],
  )
  const lockedTrackIds = useMemo(() => new Set(
    project.tracks.filter(track => track.locked).map(track => track.id),
  ), [project.tracks])
  const originalById = useMemo(() => new Map(project.markers.map(marker => [marker.id, marker])), [project.markers])

  useEffect(() => {
    if (!open) return
    const draft = collectDraftMarkers(project, selectedIds, currentTrackId)
    const selected = new Set(draft.filter(marker => externalSelection.has(marker.id)).map(marker => marker.id))
    const mode: PianoRollFilterMode = selected.size > 0 ? 'selected' : 'track'
    const initialVisible = filterPianoRollMarkers({ markers: draft }, mode, selectedIds, currentTrackId).markers
    setDraftMarkers(draft)
    setLocalSelection(selected)
    setFilterMode(mode)
    setPxPerTick(fitPianoRollPxPerTick(initialVisible, MIN_CANVAS_WIDTH, project.lengthTicks))
    setRowHeight(24)
    setDrag(null)
    setRectangle(null)
    setError('')
  }, [currentTrackId, externalSelection, open, project, selectedIds])

  const visible = useMemo(() => filterPianoRollMarkers(
    { markers: draftMarkers },
    filterMode,
    selectedIds,
    currentTrackId,
  ), [currentTrackId, draftMarkers, filterMode, selectedIds])
  const visibleIds = useMemo(() => new Set(visible.markers.map(marker => marker.id)), [visible.markers])
  const selectedVisible = useMemo(() => draftMarkers.filter(marker => (
    localSelection.has(marker.id) && visibleIds.has(marker.id)
  )), [draftMarkers, localSelection, visibleIds])
  const selectedEditable = useMemo(() => selectedVisible.filter(marker => (
    !lockedTrackIds.has(marker.trackId)
  )), [lockedTrackIds, selectedVisible])
  const changedCount = useMemo(() => draftMarkers.reduce((count, marker) => {
    const original = originalById.get(marker.id)
    return count + (original && editableFieldsDiffer(original, marker) ? 1 : 0)
  }, 0), [draftMarkers, originalById])

  if (!open) return null

  const gridStep = snapTicks(project, tempoModel, selectedVisible[0]?.tick ?? 0)
  const canvasWidth = Math.min(
    MAX_CANVAS_WIDTH,
    Math.max(MIN_CANVAS_WIDTH, project.lengthTicks * pxPerTick + 40),
  )
  const canvasHeight = PIANO_ROLL_KEY_COUNT * rowHeight
  const gridEndTick = Math.min(project.lengthTicks, canvasWidth / pxPerTick)
  const gridLines = buildPianoRollTickGrid(0, gridEndTick, project.settings, effectiveTempoMap)
  const keys = Array.from(
    { length: PIANO_ROLL_KEY_COUNT },
    (_, index) => PIANO_ROLL_MAX_MIDI_NOTE - index,
  )
  const template = selectedVisible[0] ?? visible.markers[0]

  const selectMarker = (event: React.MouseEvent | React.PointerEvent, marker: Marker) => {
    const additive = event.ctrlKey || event.metaKey || event.shiftKey
    setLocalSelection((current) => {
      if (!additive) return new Set([marker.id])
      const next = new Set(current)
      if ((event.ctrlKey || event.metaKey) && next.has(marker.id)) next.delete(marker.id)
      else next.add(marker.id)
      return next
    })
  }

  const audition = (marker: Marker | undefined, note?: number) => {
    if (!marker || !onAudition) return
    const candidate = note === undefined ? marker : { ...marker, pitch: pianoRollNoteToPitch(note) }
    void Promise.resolve(onAudition(candidate)).catch(caught => setError(String(caught)))
  }

  const beginNoteDrag = (event: React.PointerEvent, marker: Marker) => {
    event.stopPropagation()
    selectMarker(event, marker)
    if (lockedTrackIds.has(marker.trackId)) return
    const ids = localSelection.has(marker.id) ? new Set(localSelection) : new Set([marker.id])
    const editableIds = new Set([...ids].filter((id) => {
      const candidate = draftMarkers.find(item => item.id === id)
      return candidate && !lockedTrackIds.has(candidate.trackId) && visibleIds.has(id)
    }))
    event.currentTarget.setPointerCapture?.(event.pointerId)
    setDrag({
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      baseMarkers: draftMarkers,
      markerIds: editableIds,
    })
  }

  const moveNoteDrag = (event: React.PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return
    const moved = movePianoRollMarkers(drag.baseMarkers, {
      markerIds: drag.markerIds,
      deltaTick: (event.clientX - drag.startX) / pxPerTick,
      deltaSemitones: (drag.startY - event.clientY) / rowHeight,
      snapTicks: gridStep,
      lengthTicks: project.lengthTicks,
      lockedTrackIds,
      settings: project.settings,
      tempoModel,
    })
    setDraftMarkers(moved.markers)
  }

  const moveSelectionByKeyboard = (
    marker: Marker,
    tickDelta: number,
    semitoneDelta: number,
    beatDelta?: number,
  ) => {
    if (lockedTrackIds.has(marker.trackId)) return
    const ids = localSelection.has(marker.id) ? localSelection : new Set([marker.id])
    setLocalSelection(new Set(ids))
    setDraftMarkers(current => movePianoRollMarkers(current, {
      markerIds: ids,
      deltaTick: tickDelta,
      deltaSemitones: semitoneDelta,
      snapTicks: gridStep,
      lengthTicks: project.lengthTicks,
      lockedTrackIds,
      deltaBeats: beatDelta,
      settings: project.settings,
      tempoModel,
    }).markers)
  }

  const handleNoteKey = (event: React.KeyboardEvent, marker: Marker) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      audition(marker)
    }
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      const direction = event.key === 'ArrowLeft' ? -1 : 1
      if (project.settings.snap.mode === 'beat') {
        moveSelectionByKeyboard(
          marker,
          0,
          0,
          direction * 4 / project.settings.snap.beatDivision,
        )
      }
      else moveSelectionByKeyboard(marker, direction * gridStep, 0)
    }
    else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()
      moveSelectionByKeyboard(marker, 0, event.key === 'ArrowUp' ? 1 : -1)
    }
  }

  const canvasPoint = (event: React.PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
  }

  const beginRectangle = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return
    const point = canvasPoint(event)
    event.currentTarget.setPointerCapture?.(event.pointerId)
    setRectangle({
      pointerId: event.pointerId,
      startX: point.x,
      startY: point.y,
      currentX: point.x,
      currentY: point.y,
      baseSelection: event.ctrlKey || event.metaKey ? new Set(localSelection) : new Set(),
    })
  }

  const moveRectangle = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!rectangle || event.pointerId !== rectangle.pointerId) return
    const point = canvasPoint(event)
    setRectangle(current => current && ({ ...current, currentX: point.x, currentY: point.y }))
  }

  const endRectangle = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!rectangle || event.pointerId !== rectangle.pointerId) return
    const point = canvasPoint(event)
    setLocalSelection(selectPianoRollMarkersInRect(
      visible.markers,
      { left: rectangle.startX, top: rectangle.startY, right: point.x, bottom: point.y },
      { startTick: 0, pxPerTick, rowHeight },
      rectangle.baseSelection,
    ))
    setRectangle(null)
  }

  const updateSelected = (patch: Parameters<typeof updatePianoRollMarkerFields>[2]) => {
    setDraftMarkers(current => updatePianoRollMarkerFields(
      current,
      new Set(selectedEditable.map(marker => marker.id)),
      patch,
      lockedTrackIds,
    ).markers)
  }

  const apply = async () => {
    const result = applyPianoRollEdits(project, draftMarkers, effectiveTempoMap)
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

  const firstEditable = selectedEditable[0]
  const rectangleStyle = rectangle
    ? {
        left: Math.min(rectangle.startX, rectangle.currentX),
        top: Math.min(rectangle.startY, rectangle.currentY),
        width: Math.abs(rectangle.currentX - rectangle.startX),
        height: Math.abs(rectangle.currentY - rectangle.startY),
      }
    : null

  return (
    <Box
      position="fixed" inset="0" zIndex="2140" bg="rgba(0,0,0,.78)"
      display="flex" alignItems="center" justifyContent="center"
      role="dialog" aria-modal="true" aria-label={t('studio.piano_roll_title')}
      onPointerDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}
    >
      <Box
        w="min(1180px, calc(100vw - 24px))" h="min(820px, calc(100vh - 24px))"
        bg="gray.800" borderRadius="lg" boxShadow="xl" p="4" display="flex" flexDirection="column"
      >
        <Flex align="center" gap="3">
          <Box>
            <Text fontSize="xl" fontWeight="bold">{t('studio.piano_roll_title')}</Text>
            <Text fontSize="xs" color="gray.400">{t('studio.piano_roll_description')}</Text>
          </Box>
          <Box flex="1" />
          <Select
            w="220px" value={filterMode}
            items={[
              { value: 'selected', label: t('studio.piano_roll_filter_selected') },
              { value: 'track', label: t('studio.piano_roll_filter_track', {
                name: project.tracks.find(track => track.id === currentTrackId)?.name ?? '—',
              }) },
            ]}
            aria-label={t('studio.piano_roll_filter')}
            onChange={(value) => {
              const mode = value as PianoRollFilterMode
              setFilterMode(mode)
              setLocalSelection(mode === 'selected' ? new Set(externalSelection) : new Set())
            }}
          />
          <Button size="sm" onClick={() => setPxPerTick(value => Math.max(PIANO_ROLL_MIN_PX_PER_TICK, value / 1.5))}>
            {t('studio.piano_roll_zoom_out')}
          </Button>
          <Button size="sm" onClick={() => setPxPerTick(value => Math.min(PIANO_ROLL_MAX_PX_PER_TICK, value * 1.5))}>
            {t('studio.piano_roll_zoom_in')}
          </Button>
          <Button size="sm" onClick={() => setRowHeight(value => Math.max(PIANO_ROLL_MIN_ROW_HEIGHT, value - 4))}>Y−</Button>
          <Button size="sm" onClick={() => setRowHeight(value => Math.min(PIANO_ROLL_MAX_ROW_HEIGHT, value + 4))}>Y＋</Button>
          <Button size="sm" onClick={() => setPxPerTick(fitPianoRollPxPerTick(visible.markers, MIN_CANVAS_WIDTH, project.lengthTicks))}>
            {t('studio.piano_roll_fit')}
          </Button>
          <Button size="sm" onClick={onClose} isDisabled={busy}>×</Button>
        </Flex>

        <Flex mt="3" gap="3" fontSize="xs" color="gray.300">
          <Text>{t('studio.piano_roll_visible_count', { count: visible.total })}</Text>
          <Text>{t('studio.piano_roll_selected_count', { count: localSelection.size })}</Text>
          <Text>{t('studio.piano_roll_changed_count', { count: changedCount })}</Text>
          <Text>{t('studio.piano_roll_grid_step', { count: gridStep })}</Text>
          {visible.truncated && <Text color="orange.300">{t('studio.piano_roll_limit_warning')}</Text>}
          {lockedTrackIds.size > 0 && <Text color="yellow.300">{t('studio.piano_roll_locked_hint')}</Text>}
        </Flex>

        <Box mt="3" flex="1" minH="0" overflow="auto" bg="gray.950" border="1px solid" borderColor="gray.600">
          <Flex align="start" w={`${88 + canvasWidth}px`} minH={`${canvasHeight}px`}>
            <Box position="sticky" left="0" zIndex="4" w="88px" flexShrink="0" boxShadow="2px 0 4px rgba(0,0,0,.45)">
              {keys.map(note => (
                <Button
                  key={note} w="88px" h={`${rowHeight}px`} minH="0" p="0 5px" borderRadius="0"
                  justifyContent="flex-end" fontSize="xs"
                  color={isBlackKey(note) ? 'white' : 'gray.900'}
                  bg={isBlackKey(note) ? 'gray.700' : 'gray.100'}
                  _hover={{ bg: isBlackKey(note) ? 'gray.600' : 'gray.300' }}
                  aria-label={t('studio.piano_roll_audition_key', { note: formatMidiNote(note) })}
                  isDisabled={!onAudition || !template}
                  onClick={() => audition(template, note)}
                >
                  {formatMidiNote(note)}
                </Button>
              ))}
            </Box>
            <Box
              position="relative" w={`${canvasWidth}px`} h={`${canvasHeight}px`} flexShrink="0"
              role="group" aria-label={t('studio.piano_roll_grid')}
              data-testid="piano-roll-grid"
              onPointerDown={beginRectangle}
              onPointerMove={moveRectangle}
              onPointerUp={endRectangle}
            >
              {keys.map((note, index) => (
                <Box
                  key={`row-${note}`} position="absolute" pointerEvents="none"
                  left="0" right="0" top={`${index * rowHeight}px`} h={`${rowHeight}px`}
                  bg={isBlackKey(note) ? 'rgba(0,0,0,.28)' : 'rgba(255,255,255,.02)'}
                  borderBottom="1px solid" borderColor="whiteAlpha.100"
                />
              ))}
              {gridLines.map(line => (
                <Box
                  key={`${line.kind}-${line.tick}`} position="absolute" pointerEvents="none"
                  top="0" bottom="0" left={`${line.tick * pxPerTick}px`}
                  borderLeft="1px solid"
                  borderColor={line.kind === 'bar' ? 'purple.300' : line.kind === 'beat' ? 'whiteAlpha.400' : 'whiteAlpha.100'}
                >
                  {line.kind !== 'tick' && (
                    <Text ml="1" fontSize="10px" color="gray.400">{Math.round(line.tick)}</Text>
                  )}
                </Box>
              ))}

              {visible.markers.map((marker) => {
                const note = formatPianoRollPitch(marker.pitch)
                const rect = getPianoRollMarkerRect(marker, { startTick: 0, pxPerTick, rowHeight })
                if (rect.left > canvasWidth || rect.left + rect.width < 0) return null
                const selected = localSelection.has(marker.id)
                const locked = lockedTrackIds.has(marker.trackId)
                const span = getPianoRollSpanTicks(marker)
                const interval = span > 0 ? marker.retriggerInterval ?? 0 : 0
                const retriggers = interval > 0
                  ? Array.from({ length: Math.min(64, Math.floor(span / interval)) }, (_, index) => (index + 1) * interval)
                  : []
                const markerPan = marker.pan ?? 0
                return (
                  <Box
                    key={marker.id} position="absolute" overflow="hidden" cursor={locked ? 'not-allowed' : 'grab'}
                    left={`${rect.left}px`} top={`${rect.top}px`} w={`${rect.width}px`} h={`${rect.height}px`}
                    bg={panColor(markerPan)} opacity={0.35 + marker.volume * 0.65}
                    border="2px solid" borderColor={selected ? 'yellow.200' : locked ? 'gray.500' : 'whiteAlpha.500'}
                    borderRadius="sm" boxShadow={selected ? '0 0 0 2px rgba(236,201,75,.35)' : undefined}
                    role="button" tabIndex={0} aria-pressed={selected}
                    aria-disabled={locked}
                    aria-label={t('studio.piano_roll_note_label', {
                      sound: marker.soundId,
                      note,
                      tick: marker.tick,
                      velocity: Math.round(marker.volume * 100),
                      pan: Math.round(markerPan * 100),
                    })}
                    data-piano-roll-note={marker.id} data-volume={marker.volume} data-pan={markerPan}
                    onClick={event => selectMarker(event, marker)}
                    onDoubleClick={() => audition(marker)}
                    onPointerDown={event => beginNoteDrag(event, marker)}
                    onPointerMove={moveNoteDrag}
                    onPointerUp={(event) => { if (drag?.pointerId === event.pointerId) setDrag(null) }}
                    onKeyDown={event => handleNoteKey(event, marker)}
                  >
                    <Text px="1" fontSize="10px" fontWeight="bold" whiteSpace="nowrap" overflow="hidden" textOverflow="ellipsis">
                      {note}
                      {' · '}
                      {marker.soundId}
                    </Text>
                    {retriggers.map(tick => (
                      <Box
                        key={tick} position="absolute" pointerEvents="none" top="0" bottom="0"
                        left={`${tick * pxPerTick}px`} borderLeft="1px dashed rgba(0,0,0,.65)"
                      />
                    ))}
                    <Box
                      position="absolute" pointerEvents="none" bottom="0" h="3px"
                      left={markerPan < 0 ? `${50 + markerPan * 50}%` : '50%'}
                      w={`${Math.max(2, Math.abs(markerPan) * 50)}%`} bg="blackAlpha.600"
                    />
                  </Box>
                )
              })}

              {rectangleStyle && (
                <Box
                  position="absolute" pointerEvents="none" zIndex="5"
                  left={`${rectangleStyle.left}px`} top={`${rectangleStyle.top}px`}
                  w={`${rectangleStyle.width}px`} h={`${rectangleStyle.height}px`}
                  border="1px solid" borderColor="cyan.200" bg="rgba(0,200,255,.15)"
                  data-testid="piano-roll-selection-rectangle"
                />
              )}
            </Box>
          </Flex>
        </Box>

        <Flex mt="3" gap="3" align="center" wrap="wrap">
          <Text fontSize="sm" minW="150px">
            {firstEditable
              ? t('studio.piano_roll_inspector_count', { count: selectedEditable.length })
              : t('studio.piano_roll_inspector_empty')}
          </Text>
          <Text fontSize="xs">{t('studio.piano_roll_velocity')}</Text>
          <CommitNumberInput
            value={Math.round((firstEditable?.volume ?? 0) * 100)} min={0} max={100} step={1} precision={0}
            size="sm" w="92px" isDisabled={!firstEditable}
            onCommit={value => updateSelected({ volume: value / 100 })}
          />
          <Text fontSize="xs">{t('studio.piano_roll_pan')}</Text>
          <CommitNumberInput
            value={Math.round((firstEditable?.pan ?? 0) * 100)} min={-100} max={100} step={1} precision={0}
            size="sm" w="92px" isDisabled={!firstEditable}
            onCommit={value => updateSelected({ pan: value / 100 })}
          />
          <Text fontSize="xs">{t('studio.piano_roll_duration')}</Text>
          <CommitNumberInput
            value={firstEditable?.duration ?? 0} min={0} max={1_000_000} step={1} precision={0}
            size="sm" w="105px" isDisabled={!firstEditable}
            onCommit={value => updateSelected({ duration: value })}
          />
          <Text fontSize="xs">{t('studio.piano_roll_retrigger')}</Text>
          <CommitNumberInput
            value={firstEditable?.retriggerInterval ?? 1} min={1} max={1_000_000} step={1} precision={0}
            size="sm" w="105px" isDisabled={!firstEditable}
            onCommit={value => updateSelected({ retriggerInterval: value })}
          />
        </Flex>

        {error && <Text mt="2" role="alert" color="red.300">{t('studio.piano_roll_error', { error })}</Text>}
        <Flex mt="3" justify="flex-end" gap="2">
          <Button onClick={onClose} isDisabled={busy}>{t('studio.cancel')}</Button>
          <Button colorScheme="purple" isLoading={busy} isDisabled={changedCount === 0} onClick={() => { void apply() }}>
            {t('studio.piano_roll_apply', { count: changedCount })}
          </Button>
        </Flex>
      </Box>
    </Box>
  )
}
