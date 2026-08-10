import {
  getTimelineLengthTicks,
  isSoundStopMarker,
  type Marker,
  type TempoMapEvent,
  type TimelineSettings,
  type TimelineState,
} from '../types/timeline'
import {
  buildTempoMap,
  enumerateTempoGridLines,
  musicalBeatToTick,
  snapTickToTempoMap,
  tickToMusicalBeat,
  type TempoMapModel,
} from './tempoMap'

export const PIANO_ROLL_MIN_MIDI_NOTE = 48
export const PIANO_ROLL_MAX_MIDI_NOTE = 72
export const PIANO_ROLL_KEY_COUNT = PIANO_ROLL_MAX_MIDI_NOTE - PIANO_ROLL_MIN_MIDI_NOTE + 1
export const PIANO_ROLL_MAX_VISIBLE_MARKERS = 5_000
export const PIANO_ROLL_MAX_DRAFT_MARKERS = PIANO_ROLL_MAX_VISIBLE_MARKERS * 2
export const PIANO_ROLL_MAX_SELECTION = 2_000
export const PIANO_ROLL_MAX_SPAN_TICKS = 1_000_000
export const PIANO_ROLL_MIN_PX_PER_TICK = 0.25
export const PIANO_ROLL_MAX_PX_PER_TICK = 12
export const PIANO_ROLL_MIN_ROW_HEIGHT = 18
export const PIANO_ROLL_MAX_ROW_HEIGHT = 44

const PITCH_MIN = 0.5
const PITCH_MAX = 2
const ROOT_MIDI_NOTE = 60
const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'] as const

export type PianoRollFilterMode = 'selected' | 'track'

export interface PianoRollPitch {
  midiFloat: number
  note: number
  cents: number
  name: string
}

export interface PianoRollViewport {
  startTick: number
  pxPerTick: number
  rowHeight: number
  minMidi?: number
  maxMidi?: number
}

export interface PianoRollMarkerRect {
  left: number
  top: number
  width: number
  height: number
}

export interface PianoRollSelectionRect {
  left: number
  top: number
  right: number
  bottom: number
}

export interface PianoRollGridLine {
  tick: number
  kind: 'tick' | 'beat' | 'bar'
}

export interface PianoRollFilterResult {
  markers: Marker[]
  total: number
  truncated: boolean
}

export interface PianoRollMoveOptions {
  markerIds: ReadonlySet<string> | readonly string[]
  deltaTick: number
  deltaSemitones: number
  /** Used by accessible beat-step movement across variable-tempo segments. */
  deltaBeats?: number
  snapTicks: number
  lengthTicks: number
  lockedTrackIds: ReadonlySet<string>
  settings?: TimelineSettings
  tempoModel?: TempoMapModel
}

export interface PianoRollEditResult {
  markers: Marker[]
  changedIds: string[]
}

export interface PianoRollApplyResult {
  state: TimelineState
  changedIds: string[]
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function normalizedIds(ids: ReadonlySet<string> | readonly string[]): Set<string> {
  return ids instanceof Set ? new Set(ids) : new Set(ids)
}

export function formatMidiNote(note: number): string {
  const rounded = Math.round(note)
  const pitchClass = ((rounded % 12) + 12) % 12
  return `${NOTE_NAMES[pitchClass]}${Math.floor(rounded / 12) - 1}`
}

export function pitchToPianoRollNote(pitch: number): PianoRollPitch {
  const safePitch = clamp(Number.isFinite(pitch) ? pitch : 1, PITCH_MIN, PITCH_MAX)
  const midiFloat = ROOT_MIDI_NOTE + 12 * Math.log2(safePitch)
  let note = Math.round(midiFloat)
  let cents = Math.round((midiFloat - note) * 100)
  if (cents >= 100) {
    note += 1
    cents -= 100
  }
  else if (cents <= -100) {
    note -= 1
    cents += 100
  }
  if (Object.is(cents, -0)) cents = 0
  return { midiFloat, note, cents, name: formatMidiNote(note) }
}

export function pianoRollNoteToPitch(note: number, cents = 0): number {
  const midi = clamp(
    (Number.isFinite(note) ? note : ROOT_MIDI_NOTE)
    + clamp(Number.isFinite(cents) ? cents : 0, -99, 99) / 100,
    PIANO_ROLL_MIN_MIDI_NOTE,
    PIANO_ROLL_MAX_MIDI_NOTE,
  )
  return clamp(2 ** ((midi - ROOT_MIDI_NOTE) / 12), PITCH_MIN, PITCH_MAX)
}

export function formatPianoRollPitch(pitch: number): string {
  const converted = pitchToPianoRollNote(pitch)
  if (converted.cents === 0) return converted.name
  return `${converted.name} ${converted.cents > 0 ? '+' : ''}${converted.cents}¢`
}

export function getPianoRollSpanTicks(marker: Pick<Marker, 'duration' | 'retriggerInterval'>): number {
  return marker.duration && marker.duration > 0 ? marker.duration : 0
}

export function getPianoRollMarkerRect(
  marker: Pick<Marker, 'tick' | 'pitch' | 'duration' | 'retriggerInterval'>,
  viewport: PianoRollViewport,
): PianoRollMarkerRect {
  const minMidi = viewport.minMidi ?? PIANO_ROLL_MIN_MIDI_NOTE
  const maxMidi = viewport.maxMidi ?? PIANO_ROLL_MAX_MIDI_NOTE
  const pitch = pitchToPianoRollNote(marker.pitch)
  const span = getPianoRollSpanTicks(marker)
  return {
    left: (marker.tick - viewport.startTick) * viewport.pxPerTick,
    top: (maxMidi - clamp(pitch.midiFloat, minMidi, maxMidi)) * viewport.rowHeight + 2,
    width: Math.max(8, span * viewport.pxPerTick),
    height: Math.max(10, viewport.rowHeight - 4),
  }
}

export function filterPianoRollMarkers(
  state: Pick<TimelineState, 'markers'>,
  mode: PianoRollFilterMode,
  selectedIds: ReadonlySet<string> | readonly string[],
  currentTrackId: string | null | undefined,
  limit = PIANO_ROLL_MAX_VISIBLE_MARKERS,
): PianoRollFilterResult {
  const selected = normalizedIds(selectedIds)
  const filtered = state.markers
    .filter(marker => !isSoundStopMarker(marker))
    .filter(marker => mode === 'selected' ? selected.has(marker.id) : marker.trackId === currentTrackId)
    .sort((left, right) => left.tick - right.tick || left.id.localeCompare(right.id))
  const safeLimit = clamp(Math.trunc(limit), 1, PIANO_ROLL_MAX_VISIBLE_MARKERS)
  return {
    markers: filtered.slice(0, safeLimit),
    total: filtered.length,
    truncated: filtered.length > safeLimit,
  }
}

function rectanglesIntersect(left: PianoRollMarkerRect, right: PianoRollSelectionRect): boolean {
  return left.left <= right.right
    && left.left + left.width >= right.left
    && left.top <= right.bottom
    && left.top + left.height >= right.top
}

export function selectPianoRollMarkersInRect(
  markers: readonly Marker[],
  rectangle: PianoRollSelectionRect,
  viewport: PianoRollViewport,
  baseSelection: ReadonlySet<string> | readonly string[] = [],
  limit = PIANO_ROLL_MAX_SELECTION,
): Set<string> {
  const normalized: PianoRollSelectionRect = {
    left: Math.min(rectangle.left, rectangle.right),
    top: Math.min(rectangle.top, rectangle.bottom),
    right: Math.max(rectangle.left, rectangle.right),
    bottom: Math.max(rectangle.top, rectangle.bottom),
  }
  const result = normalizedIds(baseSelection)
  for (const marker of markers) {
    if (result.size >= Math.min(limit, PIANO_ROLL_MAX_SELECTION)) break
    if (rectanglesIntersect(getPianoRollMarkerRect(marker, viewport), normalized)) result.add(marker.id)
  }
  return result
}

function snappedTickDelta(deltaTick: number, snapTicks: number): number {
  const safeSnap = Math.max(1, Math.round(snapTicks))
  return Math.round(deltaTick / safeSnap) * safeSnap
}

export function movePianoRollMarkers(
  markers: readonly Marker[],
  options: PianoRollMoveOptions,
): PianoRollEditResult {
  const ids = normalizedIds(options.markerIds)
  const deltaTick = snappedTickDelta(options.deltaTick, options.snapTicks)
  const deltaSemitones = Math.round(options.deltaSemitones)
  const maximumTick = Math.max(0, Math.trunc(options.lengthTicks) - 1)
  const changedIds: string[] = []
  const moved = markers.map((marker) => {
    if (!ids.has(marker.id) || options.lockedTrackIds.has(marker.trackId)) return marker
    let targetTick = marker.tick + deltaTick
    if (options.settings && options.tempoModel) {
      if (options.deltaBeats !== undefined && options.settings.snap.mode === 'beat') {
        const beatStep = 4 / options.settings.snap.beatDivision
        const beat = tickToMusicalBeat(marker.tick, options.tempoModel)
        const snappedBeat = Math.round(beat / beatStep) * beatStep
        targetTick = musicalBeatToTick(
          Math.max(0, snappedBeat + options.deltaBeats),
          options.tempoModel,
        )
      }
      else {
        targetTick = snapTickToTempoMap(
          marker.tick + options.deltaTick,
          options.settings,
          options.tempoModel,
        )
      }
    }
    const tick = clamp(Math.round(targetTick), 0, maximumTick)
    const pitch = clamp(marker.pitch * 2 ** (deltaSemitones / 12), PITCH_MIN, PITCH_MAX)
    if (tick === marker.tick && pitch === marker.pitch) return marker
    changedIds.push(marker.id)
    return { ...marker, tick, pitch }
  })
  return { markers: moved, changedIds }
}

export function updatePianoRollMarkerFields(
  markers: readonly Marker[],
  markerIds: ReadonlySet<string> | readonly string[],
  patch: Partial<Pick<Marker, 'volume' | 'pan' | 'duration' | 'retriggerInterval'>>,
  lockedTrackIds: ReadonlySet<string>,
): PianoRollEditResult {
  const ids = normalizedIds(markerIds)
  const changedIds: string[] = []
  const updated = markers.map((marker) => {
    if (!ids.has(marker.id) || lockedTrackIds.has(marker.trackId)) return marker
    const next: Marker = { ...marker }
    if (patch.volume !== undefined) next.volume = clamp(patch.volume, 0, 1)
    if (patch.pan !== undefined) next.pan = clamp(patch.pan, -1, 1)
    if (patch.duration !== undefined) {
      const duration = clamp(Math.round(patch.duration), 0, PIANO_ROLL_MAX_SPAN_TICKS)
      next.duration = duration > 0 ? duration : undefined
    }
    if (patch.retriggerInterval !== undefined) {
      next.retriggerInterval = clamp(
        Math.round(patch.retriggerInterval),
        1,
        PIANO_ROLL_MAX_SPAN_TICKS,
      )
    }
    if (
      next.volume === marker.volume
      && (next.pan ?? 0) === (marker.pan ?? 0)
      && next.duration === marker.duration
      && next.retriggerInterval === marker.retriggerInterval
    ) return marker
    changedIds.push(marker.id)
    return next
  })
  return { markers: updated, changedIds }
}

function mergePianoRollEditableFields(original: Marker, edited: Marker, lengthTicks: number): Marker {
  const maximumTick = Math.max(0, lengthTicks - 1)
  return {
    ...original,
    tick: clamp(Math.round(edited.tick), 0, maximumTick),
    pitch: clamp(edited.pitch, PITCH_MIN, PITCH_MAX),
    volume: clamp(edited.volume, 0, 1),
    pan: (edited.pan ?? 0) === (original.pan ?? 0)
      ? original.pan
      : clamp(edited.pan ?? 0, -1, 1),
    duration: edited.duration === undefined
      ? undefined
      : clamp(Math.round(edited.duration), 0, PIANO_ROLL_MAX_SPAN_TICKS) || undefined,
    retriggerInterval: edited.retriggerInterval === undefined
      ? undefined
      : clamp(Math.round(edited.retriggerInterval), 1, PIANO_ROLL_MAX_SPAN_TICKS),
  }
}

function editableFieldsChanged(left: Marker, right: Marker): boolean {
  return left.tick !== right.tick
    || left.pitch !== right.pitch
    || left.volume !== right.volume
    || (left.pan ?? 0) !== (right.pan ?? 0)
    || left.duration !== right.duration
    || left.retriggerInterval !== right.retriggerInterval
}

export function applyPianoRollEdits(
  state: TimelineState,
  editedMarkers: readonly Marker[],
  tempoMap: readonly TempoMapEvent[] | undefined = state.tempoMap,
): PianoRollApplyResult {
  const edits = new Map(editedMarkers.slice(0, PIANO_ROLL_MAX_DRAFT_MARKERS).map(marker => [marker.id, marker]))
  const lockedTracks = new Set(state.tracks.filter(track => track.locked).map(track => track.id))
  const changedIds: string[] = []
  const markers = state.markers.map((marker) => {
    const edited = edits.get(marker.id)
    if (!edited || edited.trackId !== marker.trackId || lockedTracks.has(marker.trackId)) return marker
    const merged = mergePianoRollEditableFields(marker, edited, state.lengthTicks)
    if (!editableFieldsChanged(marker, merged)) return marker
    changedIds.push(marker.id)
    return merged
  })
  if (changedIds.length === 0) return { state, changedIds }
  return {
    state: {
      ...state,
      markers,
      lengthTicks: getTimelineLengthTicks(
        markers,
        state.lengthTicks,
        state.settings,
        state.referenceAudio,
        tempoMap,
      ),
    },
    changedIds,
  }
}

export function buildPianoRollTickGrid(
  startTick: number,
  endTick: number,
  settings: TimelineSettings,
  tempoMap?: readonly TempoMapEvent[],
  maxLines = 2_000,
): PianoRollGridLine[] {
  const start = Math.max(0, Math.min(startTick, endTick))
  const end = Math.max(start, Math.max(startTick, endTick))
  const model = buildTempoMap(tempoMap, settings)
  const lines = new Map<string, PianoRollGridLine>()
  const add = (tick: number, kind: PianoRollGridLine['kind']) => {
    if (tick < start - 1e-6 || tick > end + 1e-6) return
    const key = tick.toFixed(6)
    const existing = lines.get(key)
    const rank = { tick: 0, beat: 1, bar: 2 }
    if (!existing || rank[kind] > rank[existing.kind]) lines.set(key, { tick, kind })
  }
  for (const line of enumerateTempoGridLines(start, end, model, Math.max(2, Math.floor(maxLines * 0.7)))) {
    add(line.tick, line.major ? 'bar' : 'beat')
  }
  if (settings.snap.mode === 'beat') {
    const step = 4 / settings.snap.beatDivision
    const first = Math.ceil(tickToMusicalBeat(start, model) / step - 1e-8) * step
    const last = tickToMusicalBeat(end, model)
    const count = Math.max(0, Math.floor((last - first) / step) + 1)
    const stride = Math.max(1, Math.ceil(count / Math.max(1, Math.floor(maxLines * 0.3))))
    for (let beat = first; beat <= last + 1e-8; beat += step * stride) {
      add(musicalBeatToTick(beat, model), 'tick')
    }
  }
  else {
    const configuredStep = settings.snap.mode === 'tick' ? settings.snap.tickStep : 1
    const minimumStep = Math.max(configuredStep, Math.ceil((end - start) / Math.max(1, maxLines * 0.3)))
    for (let tick = Math.ceil(start / minimumStep) * minimumStep; tick <= end; tick += minimumStep) {
      add(tick, 'tick')
    }
  }
  return [...lines.values()]
    .sort((left, right) => left.tick - right.tick)
    .slice(0, maxLines)
}

export function fitPianoRollPxPerTick(
  markers: readonly Marker[],
  availableWidth: number,
  fallbackLengthTicks: number,
): number {
  const endTick = markers.reduce((latest, marker) => (
    Math.max(latest, marker.tick + getPianoRollSpanTicks(marker))
  ), 0)
  const range = Math.max(1, endTick || fallbackLengthTicks)
  return clamp(availableWidth / range, PIANO_ROLL_MIN_PX_PER_TICK, PIANO_ROLL_MAX_PX_PER_TICK)
}
