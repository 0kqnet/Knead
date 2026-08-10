import { isSoundStopMarker, snapLaneY, type Marker, type TimelineState } from '../types/timeline'

export type NbsMacroRequest =
  | { type: 'tremolo', spacing: 1 | 2, fade: 'none' | 'in' | 'out' }
  | { type: 'stereo', width: number, reversed?: boolean }
  | { type: 'arpeggio', semitones: readonly number[] }
  | { type: 'portamento', cents: number, reversed?: boolean }
  | { type: 'vibrato', depthCents?: number }
  | { type: 'stagger', trackOffsets: readonly number[] }
  | { type: 'chorus', width?: number, detuneCents?: number }
  | { type: 'volume-lfo', levels?: readonly number[] }
  | { type: 'fade-in' }
  | { type: 'fade-out' }
  | { type: 'replace-key' }
  | { type: 'set-velocity', value: number, percent?: boolean }
  | { type: 'set-panning', value: number }
  | { type: 'set-pitch', cents: number, add?: boolean }
  | { type: 'reset-properties' }

export interface NbsMacroResult {
  state: TimelineState
  affectedMarkerIds: string[]
  warnings: string[]
}

export type NbsMacroPreviewField =
  | 'trackId'
  | 'tick'
  | 'soundId'
  | 'variantIndex'
  | 'volume'
  | 'pitch'
  | 'pan'
  | 'duration'
  | 'retriggerInterval'
  | 'laneY'
  | 'volumeCurve'
  | 'pitchCurve'

export type NbsMacroPreviewValue = number | string | null

export interface NbsMacroPreviewDifference {
  field: NbsMacroPreviewField
  before: NbsMacroPreviewValue
  after: NbsMacroPreviewValue
}

export interface NbsMacroPreviewDetail {
  markerId: string
  kind: 'changed' | 'added' | 'deleted'
  differences: NbsMacroPreviewDifference[]
}

export interface NbsMacroPreview {
  result: NbsMacroResult
  changedCount: number
  addedCount: number
  deletedCount: number
  details: NbsMacroPreviewDetail[]
  omittedDetailCount: number
}

interface SelectionContext {
  markers: Marker[]
  columns: Marker[][]
  columnByTick: Map<number, number>
  trackIndex: Map<string, number>
  warnings: string[]
}

const MAX_PATTERN_LENGTH = 256
/** Keeps both the transform and its render-time preview predictably bounded. */
export const NBS_MACRO_SELECTION_LIMIT = 10_000
/** The transform may affect more notes, but the dialog never renders more rows. */
export const NBS_MACRO_PREVIEW_DETAIL_LIMIT = 12

const PREVIEW_FIELDS = [
  'trackId', 'tick', 'soundId', 'variantIndex', 'volume', 'pitch', 'pan',
  'duration', 'retriggerInterval', 'laneY', 'volumeCurve', 'pitchCurve',
] as const satisfies readonly NbsMacroPreviewField[]

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function normalizeSelectedIds(ids: ReadonlySet<string> | readonly string[]): Set<string> {
  return ids instanceof Set ? new Set(ids) : new Set(ids)
}

function selectionContext(state: TimelineState, ids: ReadonlySet<string> | readonly string[]): SelectionContext {
  const wanted = normalizeSelectedIds(ids)
  if (wanted.size > NBS_MACRO_SELECTION_LIMIT) {
    throw new Error(`A macro can process at most ${NBS_MACRO_SELECTION_LIMIT} selected markers`)
  }
  const trackIndex = new Map(state.tracks.map((track, index) => [track.id, index]))
  const lockedTracks = new Set(state.tracks.filter(track => track.locked).map(track => track.id))
  let lockedCount = 0
  let functionalCount = 0
  const markers = state.markers
    .filter((marker) => {
      if (!wanted.has(marker.id)) return false
      if (lockedTracks.has(marker.trackId)) {
        lockedCount++
        return false
      }
      if (isSoundStopMarker(marker)) {
        functionalCount++
        return false
      }
      return trackIndex.has(marker.trackId)
    })
    .sort((left, right) => left.tick - right.tick
      || (trackIndex.get(left.trackId) ?? 0) - (trackIndex.get(right.trackId) ?? 0)
      || left.id.localeCompare(right.id))
  const columns: Marker[][] = []
  const columnByTick = new Map<number, number>()
  for (const marker of markers) {
    let index = columnByTick.get(marker.tick)
    if (index === undefined) {
      index = columns.length
      columnByTick.set(marker.tick, index)
      columns.push([])
    }
    columns[index].push(marker)
  }
  return {
    markers,
    columns,
    columnByTick,
    trackIndex,
    warnings: [
      ...(lockedCount ? [`${lockedCount} marker(s) on locked tracks were skipped.`] : []),
      ...(functionalCount ? [`${functionalCount} Sound Stopper event(s) were left unchanged.`] : []),
    ],
  }
}

function assertFinite(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`)
  }
  return value
}

function assertPattern(values: readonly number[], name: string, minimum: number, maximum: number): number[] {
  if (!values.length || values.length > MAX_PATTERN_LENGTH) throw new Error(`${name} must contain 1..${MAX_PATTERN_LENGTH} values`)
  return values.map((value, index) => assertFinite(value, `${name}[${index}]`, minimum, maximum))
}

function updateMarkers(state: TimelineState, replacements: Map<string, Marker>): TimelineState {
  const next = structuredClone(state)
  next.markers = next.markers.map(marker => replacements.get(marker.id) ?? marker)
  return next
}

function pitchByCents(pitch: number, cents: number): number {
  return clamp(pitch * 2 ** (cents / 1200), 0.5, 2)
}

function laneFromPitch(pitch: number): number {
  const semitones = 12 * Math.log2(pitch)
  return snapLaneY(clamp(0.5 - semitones / 24, 0, 1))
}

function positionFactor(index: number, length: number, reversed = false): number {
  if (length <= 1) return 1
  const factor = index / (length - 1)
  return reversed ? 1 - factor : factor
}

/** OpenNBS fades operate on integer velocity and never create a zero-velocity note. */
function openNbsFadeVolume(volume: number, factor: number): number {
  const velocity = Math.ceil(clamp(volume, 0, 1) * 100 * factor)
  return Math.max(1, Math.min(100, velocity)) / 100
}

function tremolo(
  marker: Marker,
  context: SelectionContext,
  spacing: 1 | 2,
  fade: 'none' | 'in' | 'out',
): Marker {
  const columnIndex = context.columnByTick.get(marker.tick) ?? 0
  const nextTick = context.columns[columnIndex + 1]?.[0]?.tick
  // `duration` is inclusive in Knead (duration 2 / interval 2 fires at 0 and
  // 2). Stop one interval before the next selected column so Tremolo never
  // adds a duplicate firing on top of that column. For the final column, keep
  // the useful Knead behavior of extending an existing/single-note gesture.
  const span = nextTick === undefined
    ? Math.max(spacing, marker.duration ?? spacing)
    : Math.max(0, nextTick - marker.tick - spacing)
  const changed: Marker = { ...marker, duration: span, retriggerInterval: spacing }
  if (fade === 'none' || span === 0) return changed
  changed.volumeCurve = {
    keyframes: [
      { tick: 0, value: fade === 'in' ? 0 : marker.volume, interpolation: 'linear' },
      { tick: span, value: fade === 'in' ? marker.volume : 0, interpolation: 'linear' },
    ],
  }
  return changed
}

function transformMarker(
  marker: Marker,
  request: NbsMacroRequest,
  context: SelectionContext,
): Marker {
  const columnIndex = context.columnByTick.get(marker.tick) ?? 0
  const columnCount = context.columns.length
  switch (request.type) {
    case 'tremolo':
      return tremolo(marker, context, request.spacing, request.fade)
    case 'stereo': {
      const width = assertFinite(request.width, 'Stereo width', 0, 1)
      const direction = (columnIndex % 2 === 0 ? 1 : -1) * (request.reversed ? -1 : 1)
      return { ...marker, pan: direction * width }
    }
    case 'arpeggio': {
      const pattern = assertPattern(request.semitones, 'Arpeggio pattern', -87, 87)
      const pitch = pitchByCents(marker.pitch, pattern[columnIndex % pattern.length] * 100)
      return { ...marker, pitch, laneY: laneFromPitch(pitch) }
    }
    case 'portamento': {
      const cents = assertFinite(request.cents, 'Portamento cents', -1200, 1200)
      const pitch = pitchByCents(marker.pitch, cents * positionFactor(columnIndex, columnCount, !!request.reversed))
      return { ...marker, pitch, laneY: laneFromPitch(pitch) }
    }
    case 'vibrato': {
      const depth = assertFinite(request.depthCents ?? 40, 'Vibrato depth', 0, 1200)
      const phase = [depth, 0, -depth, 0][columnIndex % 4]
      const pitch = pitchByCents(marker.pitch, phase)
      return { ...marker, pitch, laneY: laneFromPitch(pitch) }
    }
    case 'chorus': {
      const width = assertFinite(request.width ?? 0.4, 'Chorus width', 0, 1)
      const cents = assertFinite(request.detuneCents ?? 5, 'Chorus detune', 0, 1200)
      const noteIndex = context.columns[columnIndex].findIndex(candidate => candidate.id === marker.id)
      const direction = noteIndex % 2 === 0 ? 1 : -1
      const pitch = pitchByCents(marker.pitch, direction * cents)
      return { ...marker, pan: direction * width, pitch, laneY: laneFromPitch(pitch) }
    }
    case 'volume-lfo': {
      const levels = assertPattern(request.levels ?? [1, 0.5, 0.25, 0.5], 'Volume LFO', 0, 1)
      return { ...marker, volume: levels[columnIndex % levels.length] }
    }
    case 'fade-in':
      return { ...marker, volume: openNbsFadeVolume(marker.volume, positionFactor(columnIndex, columnCount)) }
    case 'fade-out':
      return { ...marker, volume: openNbsFadeVolume(marker.volume, positionFactor(columnIndex, columnCount, true)) }
    case 'replace-key': {
      const pitch = context.markers[0]?.pitch ?? marker.pitch
      return { ...marker, pitch, laneY: laneFromPitch(pitch) }
    }
    case 'set-velocity': {
      const value = assertFinite(request.value, 'Velocity', 0, request.percent ? 1000 : 100)
      return {
        ...marker,
        volume: request.percent ? clamp(marker.volume * value / 100, 0, 1) : value / 100,
      }
    }
    case 'set-panning':
      return { ...marker, pan: assertFinite(request.value, 'Panning', -1, 1) }
    case 'set-pitch': {
      const cents = assertFinite(request.cents, 'Pitch', -1200, 1200)
      const pitch = request.add ? pitchByCents(marker.pitch, cents) : clamp(2 ** (cents / 1200), 0.5, 2)
      return { ...marker, pitch, laneY: laneFromPitch(pitch) }
    }
    case 'reset-properties':
      return { ...marker, volume: 1, pan: 0, pitch: 1, laneY: laneFromPitch(1), volumeCurve: undefined, pitchCurve: undefined }
    case 'stagger':
      return marker
  }
}

function applyStagger(
  state: TimelineState,
  context: SelectionContext,
  offsets: readonly number[],
  replacements: Map<string, Marker>,
): void {
  const pattern = assertPattern(offsets, 'Stagger pattern', 0, state.tracks.length - 1)
  for (const marker of context.markers) {
    const columnIndex = context.columnByTick.get(marker.tick) ?? 0
    const currentIndex = context.trackIndex.get(marker.trackId) ?? 0
    const targetIndex = currentIndex + Math.round(pattern[columnIndex % pattern.length])
    const target = state.tracks[targetIndex]
    if (!target || target.locked) {
      context.warnings.push(`Marker ${marker.id} could not stagger to track ${targetIndex + 1}.`)
      continue
    }
    replacements.set(marker.id, { ...marker, trackId: target.id })
  }
}

/**
 * Applies one of OpenNBS' 15 macro actions as a pure project transform. Knead's
 * tremolo uses native retrigger/automation data instead of destructively
 * materializing repeated note columns, so it remains editable and previewable.
 */
export function applyNbsMacro(
  state: TimelineState,
  markerIds: ReadonlySet<string> | readonly string[],
  request: NbsMacroRequest,
): NbsMacroResult {
  const context = selectionContext(state, markerIds)
  if (!context.markers.length) throw new Error('Select at least one marker on an unlocked track')
  const replacements = new Map<string, Marker>()
  if (request.type === 'stagger') applyStagger(state, context, request.trackOffsets, replacements)
  else {
    for (const marker of context.markers) replacements.set(marker.id, transformMarker(marker, request, context))
  }
  return {
    state: updateMarkers(state, replacements),
    affectedMarkerIds: [...replacements.keys()],
    warnings: Array.from(new Set(context.warnings)),
  }
}

function curveValue(marker: Marker, field: 'volumeCurve' | 'pitchCurve'): NbsMacroPreviewValue {
  const curve = marker[field]
  return curve ? `${curve.keyframes.length} keyframe(s)` : null
}

function primitiveValue(marker: Marker, field: NbsMacroPreviewField): NbsMacroPreviewValue {
  if (field === 'volumeCurve' || field === 'pitchCurve') return curveValue(marker, field)
  return marker[field] ?? null
}

function curvesEqual(left: Marker, right: Marker, field: 'volumeCurve' | 'pitchCurve'): boolean {
  const leftFrames = left[field]?.keyframes
  const rightFrames = right[field]?.keyframes
  if (leftFrames === rightFrames) return true
  if (!leftFrames || !rightFrames || leftFrames.length !== rightFrames.length) return false
  return leftFrames.every((frame, index) => {
    const other = rightFrames[index]
    return frame.tick === other.tick
      && frame.value === other.value
      && frame.interpolation === other.interpolation
      && frame.handleL?.dt === other.handleL?.dt
      && frame.handleL?.dv === other.handleL?.dv
      && frame.handleR?.dt === other.handleR?.dt
      && frame.handleR?.dv === other.handleR?.dv
  })
}

function fieldEqual(left: Marker, right: Marker, field: NbsMacroPreviewField): boolean {
  if (field === 'volumeCurve' || field === 'pitchCurve') return curvesEqual(left, right, field)
  return Object.is(left[field], right[field])
}

function allMarkerDifferences(
  before: Marker | undefined,
  after: Marker | undefined,
): NbsMacroPreviewDifference[] {
  return PREVIEW_FIELDS.flatMap((field) => {
    if (before && after && fieldEqual(before, after, field)) return []
    return [{
      field,
      before: before ? primitiveValue(before, field) : null,
      after: after ? primitiveValue(after, field) : null,
    }]
  })
}

/**
 * Produces the exact immutable result later handed to the host plus a bounded,
 * deterministic marker diff for the confirmation UI. Previewing never mutates
 * the project and never invokes the host's history callback.
 */
export function previewNbsMacro(
  state: TimelineState,
  markerIds: ReadonlySet<string> | readonly string[],
  request: NbsMacroRequest,
): NbsMacroPreview {
  const result = applyNbsMacro(state, markerIds, request)
  const beforeById = new Map(state.markers.map(marker => [marker.id, marker]))
  const afterById = new Map(result.state.markers.map(marker => [marker.id, marker]))
  const candidateIds = new Set(result.affectedMarkerIds)
  for (const marker of state.markers) {
    if (!afterById.has(marker.id)) candidateIds.add(marker.id)
  }
  for (const marker of result.state.markers) {
    if (!beforeById.has(marker.id)) candidateIds.add(marker.id)
  }
  const beforeTrackIndex = new Map(state.tracks.map((track, index) => [track.id, index]))
  const afterTrackIndex = new Map(result.state.tracks.map((track, index) => [track.id, index]))
  const sortedIds = [...candidateIds].sort((leftId, rightId) => {
    const left = afterById.get(leftId) ?? beforeById.get(leftId)
    const right = afterById.get(rightId) ?? beforeById.get(rightId)
    if (!left || !right) return leftId.localeCompare(rightId)
    const leftTrack = afterTrackIndex.get(left.trackId) ?? beforeTrackIndex.get(left.trackId) ?? 0
    const rightTrack = afterTrackIndex.get(right.trackId) ?? beforeTrackIndex.get(right.trackId) ?? 0
    return left.tick - right.tick
      || leftTrack - rightTrack
      || leftId.localeCompare(rightId)
  })
  let changedCount = 0
  let addedCount = 0
  let deletedCount = 0
  const allDetails: NbsMacroPreviewDetail[] = []
  for (const markerId of sortedIds) {
    const before = beforeById.get(markerId)
    const after = afterById.get(markerId)
    const differences = allMarkerDifferences(before, after)
    if (!differences.length) continue
    const kind = before ? (after ? 'changed' : 'deleted') : 'added'
    if (kind === 'changed') changedCount++
    else if (kind === 'added') addedCount++
    else deletedCount++
    if (allDetails.length < NBS_MACRO_PREVIEW_DETAIL_LIMIT) {
      allDetails.push({ markerId, kind, differences })
    }
  }
  const total = changedCount + addedCount + deletedCount
  return {
    result,
    changedCount,
    addedCount,
    deletedCount,
    details: allDetails,
    omittedDetailCount: Math.max(0, total - allDetails.length),
  }
}

export const NBS_MACRO_TYPES = [
  'tremolo', 'stereo', 'arpeggio', 'portamento', 'vibrato',
  'stagger', 'chorus', 'volume-lfo', 'fade-in', 'fade-out',
  'replace-key', 'set-velocity', 'set-panning', 'set-pitch', 'reset-properties',
] as const satisfies readonly NbsMacroRequest['type'][]
