import { v4 as uuidv4 } from 'uuid'
import {
  DEFAULT_MASTER,
  DEFAULT_SETTINGS,
  createDefaultTrack,
  isSoundStopMarker,
  MAX_MARKER_PITCH,
  MAX_PROJECT_CUSTOM_INSTRUMENTS,
  MAX_SOUND_STOP_TRACK,
  MIN_MARKER_PITCH,
  snapLaneY,
  type Marker,
  type NbsProjectSource,
  type ProjectCustomInstrument,
  type TempoMapEvent,
  type TimelineState,
  type Track,
} from '../types/timeline'
import {
  NBS_VANILLA_SOUND_IDS,
  decodeSoundStopAction,
  encodeSoundStopEnd,
  isSoundStopperInstrument,
  isTempoChangerInstrument,
  nbsTempoChangerBpm,
} from './nbs'
import { getTimelineLengthTicks, normalizeTempoMap, tempoBpmLimits, tempoMapEventLimit } from './tempoMap'
import {
  projectCustomInstrumentKind,
  validateAuthoredNbsInstrumentFile,
} from './customInstruments'

export type NbpVersion = 1 | 2

export interface NbpNote {
  tick: number
  layer: number
  instrument: number
  key: number
  velocity: number
  panning: number
  pitch: number
}

export interface NbpCustomInstrument {
  sourceIndex: number
  name: string
  file: string
  key: number
  pressKey: boolean
}

export interface NbpSelectionColumn {
  first: number
  last: number
}

export interface NbpPattern {
  version: NbpVersion
  /** Inclusive last tick copied from the source song. */
  songLength: number
  /** Inclusive last layer copied from the source song. */
  songHeight: number
  selectionLength: number
  columns: NbpSelectionColumn[]
  notes: NbpNote[]
  customInstruments: NbpCustomInstrument[]
}

export type NbpParseResult =
  | { ok: true, pattern: NbpPattern, warnings: string[] }
  | { ok: false, error: string }

export interface NbpWriteResult {
  data: Uint8Array
  warnings: string[]
}

export interface NbpConversionResult {
  state: TimelineState
  warnings: string[]
  insertedMarkerIds: string[]
}

export interface InsertNbpOptions {
  startTick?: number
  startTrackIndex?: number
}

const MAX_NBP_BYTES = 8 * 1024 * 1024
const MAX_NBP_STRING_BYTES = 1024 * 1024
const MAX_NBP_TOTAL_STRING_BYTES = 4 * 1024 * 1024
const MAX_NBP_NOTES = 250_000
const MAX_NBP_SELECTION_LENGTH = 32_767
const MAX_NBP_LAYER = 127
const NBP_V2_VANILLA_INSTRUMENTS = 20

function inputBytes(input: ArrayBuffer | Uint8Array): Uint8Array {
  return input instanceof Uint8Array
    ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
    : new Uint8Array(input)
}

class BinaryReader {
  private readonly bytes: Uint8Array
  private readonly view: DataView
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })
  private totalStringBytes = 0
  offset = 0

  constructor(input: ArrayBuffer | Uint8Array) {
    this.bytes = inputBytes(input)
    if (this.bytes.byteLength === 0 || this.bytes.byteLength > MAX_NBP_BYTES) {
      throw new Error('Invalid NBP data size')
    }
    this.view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength)
  }

  get remaining(): number { return this.bytes.byteLength - this.offset }

  private ensure(length: number): void {
    if (length < 0 || this.offset + length > this.bytes.byteLength) throw new Error('Unexpected end of NBP file')
  }

  u8(): number {
    this.ensure(1)
    return this.bytes[this.offset++]
  }

  i8(): number {
    const value = this.u8()
    return value > 0x7f ? value - 0x100 : value
  }

  i16(): number {
    this.ensure(2)
    const value = this.view.getInt16(this.offset, true)
    this.offset += 2
    return value
  }

  zstr(): string {
    const start = this.offset
    while (this.offset < this.bytes.byteLength && this.bytes[this.offset] !== 0) this.offset++
    if (this.offset >= this.bytes.byteLength) throw new Error('Unterminated NBP string')
    const length = this.offset - start
    if (length > MAX_NBP_STRING_BYTES) throw new Error('NBP string exceeds the size limit')
    this.totalStringBytes += length
    if (this.totalStringBytes > MAX_NBP_TOTAL_STRING_BYTES) throw new Error('NBP strings exceed the aggregate size limit')
    const value = this.decoder.decode(this.bytes.subarray(start, this.offset))
    this.offset++
    return value
  }
}

class BinaryWriter {
  private readonly bytes: number[] = []
  private readonly encoder = new TextEncoder()

  u8(value: number): void { this.bytes.push(value & 0xff) }

  i8(value: number): void { this.u8(value) }

  i16(value: number): void {
    this.u8(value)
    this.u8(value >> 8)
  }

  zstr(value: string): void {
    const encoded = this.encoder.encode(value)
    if (encoded.byteLength > MAX_NBP_STRING_BYTES || encoded.includes(0)) {
      throw new Error('Invalid NBP string')
    }
    this.bytes.push(...encoded, 0)
  }

  finish(): Uint8Array {
    if (this.bytes.length > MAX_NBP_BYTES) throw new Error('NBP export exceeds the size limit')
    return Uint8Array.from(this.bytes)
  }
}

function integerToken(code: string, cursor: { value: number }): number {
  const start = cursor.value
  const separator = code.indexOf('|', start)
  if (separator < 0) throw new Error('NBP selection code is missing a separator')
  if (separator === start || separator - start > 12) throw new Error('NBP selection code contains an invalid value')
  const raw = code.slice(start, separator)
  if (!/^-?\d+$/.test(raw)) throw new Error('NBP selection code contains a non-integer value')
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) throw new Error('NBP selection code contains an unsafe integer')
  cursor.value = separator + 1
  return value
}

function parseSelectionCode(code: string, selectionLength: number): NbpNote[] {
  if (!code || code.length > MAX_NBP_STRING_BYTES) throw new Error('Invalid NBP selection code size')
  const notes: NbpNote[] = []
  const cursor = { value: 0 }
  let tick = 0
  while (cursor.value < code.length) {
    const tickJump = integerToken(code, cursor)
    if (tickJump < 0) throw new Error('NBP selection tick jump cannot be negative')
    tick += tickJump
    if (tick >= selectionLength) throw new Error('NBP note tick is outside the selection')
    let layer = 0
    let noteSeen = false
    while (true) {
      const layerJump = integerToken(code, cursor)
      if (layerJump === -1) break
      if (layerJump < 0) throw new Error('NBP selection layer jump cannot be negative')
      layer += layerJump
      if (layer > MAX_NBP_LAYER) throw new Error('NBP note layer is outside the supported range')
      const instrument = integerToken(code, cursor)
      const key = integerToken(code, cursor)
      const velocity = integerToken(code, cursor)
      const panning = integerToken(code, cursor)
      const pitch = integerToken(code, cursor)
      if (instrument < 0 || instrument > 255) throw new Error('NBP instrument is outside 0..255')
      if (key < 0 || key > 87) throw new Error('NBP key is outside 0..87')
      // OpenNBS functional instruments combine these two byte-sized fields.
      if (velocity < 0 || velocity > 255) throw new Error('NBP velocity is outside 0..255')
      if (panning < 0 || panning > 255) throw new Error('NBP panning is outside 0..255')
      if (pitch < -32_768 || pitch > 32_767) throw new Error('NBP fine pitch is outside int16')
      notes.push({ tick, layer, instrument, key, velocity, panning, pitch })
      if (notes.length > MAX_NBP_NOTES) throw new Error('NBP note count exceeds the safety limit')
      noteSeen = true
    }
    if (!noteSeen) throw new Error('NBP selection contains an empty encoded column')
  }
  return notes
}

function columnWarnings(columns: NbpSelectionColumn[], notes: NbpNote[]): string[] {
  const expected = columns.map(() => ({ first: -1, last: -1 }))
  for (const note of notes) {
    const column = expected[note.tick]
    if (column.first < 0) column.first = note.layer
    column.last = Math.max(column.last, note.layer)
  }
  return columns.some((column, index) => column.first !== expected[index].first || column.last !== expected[index].last)
    ? ['NBP column metadata disagrees with its note code; note code was used.']
    : []
}

export function parseNbp(input: ArrayBuffer | Uint8Array): NbpParseResult {
  try {
    const reader = new BinaryReader(input)
    const version = reader.u8()
    if (version !== 1 && version !== 2) throw new Error(`Unsupported NBP version ${version}`)
    const songLength = reader.i16()
    const songHeight = reader.i16()
    const selectionLength = reader.i16()
    if (songLength < 0 || songHeight < 0 || selectionLength <= 0 || selectionLength > MAX_NBP_SELECTION_LENGTH) {
      throw new Error('Invalid NBP dimensions')
    }
    const code = reader.zstr()
    const columns = Array.from({ length: selectionLength }, () => ({ first: reader.i8(), last: reader.i8() }))
    const customInstruments: NbpCustomInstrument[] = []
    if (version >= 2) {
      const count = reader.u8()
      for (let index = 0; index < count; index++) {
        const sourceIndex = reader.i16()
        const name = reader.zstr()
        const file = reader.zstr().replace(/\\/g, '/')
        const key = reader.u8()
        const press = reader.u8()
        if (sourceIndex < 0 || sourceIndex > 255) throw new Error('Invalid NBP custom-instrument source index')
        if (key > 87 || press > 1) throw new Error('Invalid NBP custom-instrument definition')
        customInstruments.push({ sourceIndex, name, file, key, pressKey: press === 1 })
      }
    }
    const notes = parseSelectionCode(code, selectionLength)
    const warnings = columnWarnings(columns, notes)
    if (version === 1 && notes.some(note => note.instrument >= 16)) {
      warnings.push('NBP v1 custom instruments depend on the destination song instrument list.')
    }
    if (reader.remaining) warnings.push(`${reader.remaining} trailing NBP byte(s) were ignored.`)
    return {
      ok: true,
      pattern: { version, songLength, songHeight, selectionLength, columns, notes, customInstruments },
      warnings,
    }
  }
  catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function encodedSelection(pattern: NbpPattern): { code: string, columns: NbpSelectionColumn[] } {
  const notes = [...pattern.notes].sort((left, right) => (
    left.tick - right.tick || left.layer - right.layer || left.instrument - right.instrument
  ))
  const columns = Array.from({ length: pattern.selectionLength }, () => ({ first: -1, last: -1 }))
  const parts: string[] = []
  let previousTick = 0
  let noteIndex = 0
  while (noteIndex < notes.length) {
    const tick = notes[noteIndex].tick
    if (!Number.isInteger(tick) || tick < 0 || tick >= pattern.selectionLength) throw new Error('NBP note tick is outside the selection')
    parts.push(String(tick - previousTick))
    previousTick = tick
    let previousLayer = 0
    const occupied = new Set<number>()
    while (noteIndex < notes.length && notes[noteIndex].tick === tick) {
      const note = notes[noteIndex++]
      if (!Number.isInteger(note.layer) || note.layer < 0 || note.layer > MAX_NBP_LAYER || occupied.has(note.layer)) {
        throw new Error('NBP notes must occupy unique tick/layer cells within layer 0..127')
      }
      if (!Number.isInteger(note.instrument) || note.instrument < 0 || note.instrument > 255) throw new Error('Invalid NBP instrument')
      if (!Number.isInteger(note.key) || note.key < 0 || note.key > 87) throw new Error('Invalid NBP key')
      if (!Number.isInteger(note.velocity) || note.velocity < 0 || note.velocity > 255) throw new Error('Invalid NBP velocity')
      if (!Number.isInteger(note.panning) || note.panning < 0 || note.panning > 255) throw new Error('Invalid NBP panning')
      if (!Number.isInteger(note.pitch) || note.pitch < -32_768 || note.pitch > 32_767) throw new Error('Invalid NBP fine pitch')
      occupied.add(note.layer)
      parts.push(
        String(note.layer - previousLayer), String(note.instrument), String(note.key),
        String(note.velocity), String(note.panning), String(note.pitch),
      )
      previousLayer = note.layer
      const column = columns[tick]
      if (column.first < 0) column.first = note.layer
      column.last = note.layer
    }
    parts.push('-1')
  }
  if (!parts.length) throw new Error('Cannot export an empty NBP pattern')
  const code = `${parts.join('|')}|`
  if (code.length > MAX_NBP_STRING_BYTES) throw new Error('NBP selection code exceeds the size limit')
  return { code, columns }
}

function compatibilityWarnings(pattern: NbpPattern, version: NbpVersion): string[] {
  const warnings: string[] = []
  if (version === 1 && pattern.customInstruments.length) {
    warnings.push('NBP v1 cannot embed custom-instrument definitions; destination instruments must already match.')
  }
  if (version === 1 && pattern.customInstruments.some(isSoundStopperInstrument)) {
    warnings.push('NBP v1 Sound Stopper events require a matching destination functional instrument; use v2 for portable patterns.')
  }
  if (version === 1 && pattern.customInstruments.some(isTempoChangerInstrument)) {
    warnings.push('NBP v1 Tempo Changer events require a matching destination functional instrument; use v2 for portable patterns.')
  }
  const paths = pattern.customInstruments.filter(instrument => /\\/.test(instrument.file)).length
  if (paths) warnings.push(`${paths} custom-instrument path(s) were normalized to forward slashes.`)
  return warnings
}

export function writeNbp(pattern: NbpPattern, version: NbpVersion = 2): NbpWriteResult {
  if (pattern.notes.length > MAX_NBP_NOTES) throw new Error('NBP note count exceeds the safety limit')
  if (!Number.isInteger(pattern.songLength) || pattern.songLength < 0 || pattern.songLength > 32_767) {
    throw new Error('Invalid NBP song length')
  }
  if (!Number.isInteger(pattern.songHeight) || pattern.songHeight < 0 || pattern.songHeight > 32_767) {
    throw new Error('Invalid NBP song height')
  }
  if (!Number.isInteger(pattern.selectionLength) || pattern.selectionLength <= 0 || pattern.selectionLength > MAX_NBP_SELECTION_LENGTH) {
    throw new Error('Invalid NBP selection length')
  }
  if (pattern.customInstruments.length > 255) throw new Error('NBP supports at most 255 custom-instrument definitions')
  const { code, columns } = encodedSelection(pattern)
  const writer = new BinaryWriter()
  writer.u8(version)
  writer.i16(pattern.songLength)
  writer.i16(pattern.songHeight)
  writer.i16(pattern.selectionLength)
  writer.zstr(code)
  for (const column of columns) {
    writer.i8(column.first)
    writer.i8(column.last)
  }
  if (version >= 2) {
    writer.u8(pattern.customInstruments.length)
    for (const instrument of pattern.customInstruments) {
      if (!Number.isInteger(instrument.sourceIndex) || instrument.sourceIndex < 0 || instrument.sourceIndex > 255) {
        throw new Error('Invalid NBP custom-instrument source index')
      }
      if (!Number.isInteger(instrument.key) || instrument.key < 0 || instrument.key > 87) {
        throw new Error('Invalid NBP custom-instrument key')
      }
      writer.i16(instrument.sourceIndex)
      writer.zstr(instrument.name)
      writer.zstr(instrument.file.replace(/\\/g, '/'))
      writer.u8(instrument.key)
      writer.u8(instrument.pressKey ? 1 : 0)
    }
  }
  return { data: writer.finish(), warnings: compatibilityWarnings(pattern, version) }
}

function safeCustomSoundId(file: string, instrument: number): string {
  const path = file.replace(/\\/g, '/').replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_./-]+/g, '_')
  return `nbs:custom/${path || `instrument_${instrument}`}`
}

function customDefinitionForSound(
  source: NbsProjectSource | undefined,
  authored: readonly ProjectCustomInstrument[] | undefined,
  soundId: string,
): { definition: NbpCustomInstrument, defaultPitch: number } | undefined {
  const authoredDefinition = authored?.find(instrument => (
    instrument.kind === 'audio' && instrument.soundId === soundId
  ))
  if (authoredDefinition) {
    return {
      definition: {
        sourceIndex: 0,
        name: authoredDefinition.name,
        file: authoredDefinition.file,
        key: authoredDefinition.key,
        pressKey: authoredDefinition.pressKey,
      },
      defaultPitch: authoredDefinition.defaultPitch,
    }
  }
  if (!source) return undefined
  for (let index = 0; index < source.customInstruments.length; index++) {
    const instrument = source.customInstruments[index]
    const sourceIndex = source.vanillaInstrumentCount + index
    if (safeCustomSoundId(instrument.file, sourceIndex) === soundId) {
      return {
        definition: {
          sourceIndex, name: instrument.name, file: instrument.file,
          key: instrument.key, pressKey: instrument.pressKey,
        },
        defaultPitch: 1,
      }
    }
  }
  return undefined
}

function markerInstrument(
  marker: Marker,
  source: NbsProjectSource | undefined,
  authored: readonly ProjectCustomInstrument[] | undefined,
  customBySound: Map<string, NbpCustomInstrument>,
): { instrument: number, sourceKey: number, defaultPitch: number } {
  const vanilla = NBS_VANILLA_SOUND_IDS.indexOf(marker.soundId as typeof NBS_VANILLA_SOUND_IDS[number])
  if (vanilla >= 0 && vanilla < NBP_V2_VANILLA_INSTRUMENTS) {
    return { instrument: vanilla, sourceKey: 45, defaultPitch: 1 }
  }
  let custom = customBySound.get(marker.soundId)
  let defaultPitch = authored?.find(instrument => (
    instrument.kind === 'audio' && instrument.soundId === marker.soundId
  ))?.defaultPitch ?? 1
  if (!custom) {
    const preserved = customDefinitionForSound(source, authored, marker.soundId)
    const sourceIndex = NBP_V2_VANILLA_INSTRUMENTS + customBySound.size
    custom = preserved
      ? { ...preserved.definition, sourceIndex }
      : {
          sourceIndex,
          name: marker.soundId || `Instrument ${sourceIndex}`,
          file: `${(marker.soundId || `instrument_${sourceIndex}`).replace(/[:/\\]/g, '_')}.ogg`,
          key: 45,
          pressKey: true,
        }
    defaultPitch = preserved?.defaultPitch ?? 1
    customBySound.set(marker.soundId, custom)
  }
  return { instrument: custom.sourceIndex, sourceKey: custom.key, defaultPitch }
}

function soundStopperInstrument(
  customBySound: Map<string, NbpCustomInstrument>,
): { instrument: number, sourceKey: number, defaultPitch: number } {
  const key = '\u0000knead:sound-stopper'
  let custom = customBySound.get(key)
  if (!custom) {
    custom = {
      sourceIndex: NBP_V2_VANILLA_INSTRUMENTS + customBySound.size,
      name: 'Sound Stopper',
      file: '',
      key: 45,
      pressKey: false,
    }
    customBySound.set(key, custom)
  }
  return { instrument: custom.sourceIndex, sourceKey: custom.key, defaultPitch: 1 }
}

function tempoChangerInstrument(
  customBySound: Map<string, NbpCustomInstrument>,
): { instrument: number, sourceKey: number, defaultPitch: number } {
  const key = '\u0000knead:tempo-changer'
  let custom = customBySound.get(key)
  if (!custom) {
    custom = {
      sourceIndex: NBP_V2_VANILLA_INSTRUMENTS + customBySound.size,
      name: 'Tempo Changer',
      file: '',
      key: 45,
      pressKey: false,
    }
    customBySound.set(key, custom)
  }
  return { instrument: custom.sourceIndex, sourceKey: custom.key, defaultPitch: 1 }
}

function tempoEventsInSelection(
  state: TimelineState,
  firstTick: number,
  lastTick: number,
): TempoMapEvent[] {
  if (!state.tempoMap?.length) return []
  const explicitTicks = new Set(state.tempoMap.map(event => event.tick))
  return normalizeTempoMap(state.tempoMap, state.settings)
    .filter(event => explicitTicks.has(event.tick) && event.tick >= firstTick && event.tick <= lastTick)
}

export function timelineSelectionToNbp(
  state: TimelineState,
  markerIds?: ReadonlySet<string> | readonly string[],
  version: NbpVersion = 2,
): { pattern: NbpPattern, data: Uint8Array, warnings: string[] } {
  const selected = markerIds === undefined
    ? state.markers
    : (() => {
        const ids = markerIds instanceof Set ? markerIds : new Set(markerIds)
        return state.markers.filter(marker => ids.has(marker.id))
      })()
  if (!selected.length) throw new Error('Select at least one marker to export an NBP pattern')
  const trackIndex = new Map(state.tracks.map((track, index) => [track.id, index]))
  const valid = selected.filter(marker => trackIndex.has(marker.trackId))
  if (!valid.length) throw new Error('Selected NBP markers do not belong to a track')
  const minTick = valid.reduce((value, marker) => Math.min(value, marker.tick), Number.POSITIVE_INFINITY)
  const minTrack = valid.reduce((value, marker) => Math.min(value, trackIndex.get(marker.trackId) ?? value), Number.POSITIVE_INFINITY)
  const source = state.source?.format === 'nbs' ? state.source : undefined
  const customBySound = new Map<string, NbpCustomInstrument>()
  const occupied = new Set<string>()
  const warnings: string[] = []
  let collisionCount = 0
  const notes: NbpNote[] = [...valid]
    .sort((left, right) => left.tick - right.tick
      || (trackIndex.get(left.trackId) ?? 0) - (trackIndex.get(right.trackId) ?? 0)
      || left.id.localeCompare(right.id))
    .map((marker) => {
      const tick = marker.tick - minTick
      let layer = (trackIndex.get(marker.trackId) ?? minTrack) - minTrack
      while (occupied.has(`${tick}:${layer}`)) {
        layer++
        collisionCount++
      }
      if (layer > MAX_NBP_LAYER) throw new Error('NBP collision allocation exceeded layer 127')
      occupied.add(`${tick}:${layer}`)
      const soundStop = isSoundStopMarker(marker)
      const mapped = soundStop
        ? soundStopperInstrument(customBySound)
        : markerInstrument(marker, source, state.customInstruments, customBySound)
      if (soundStop) {
        const startTrack = marker.action.scope === 'all'
          ? 0
          : Math.max(1, Math.min(MAX_SOUND_STOP_TRACK, Math.trunc(marker.action.startTrack ?? 1)))
        const endTrack = marker.action.scope === 'all'
          ? 0
          : Math.max(
              startTrack,
              Math.min(MAX_SOUND_STOP_TRACK, Math.trunc(marker.action.endTrack ?? startTrack)),
            )
        const encodedEnd = encodeSoundStopEnd(endTrack)
        return {
          tick,
          layer,
          instrument: mapped.instrument,
          key: 45,
          velocity: encodedEnd.velocity,
          panning: encodedEnd.panning,
          pitch: startTrack,
        }
      }
      const semitones = 12 * Math.log2(marker.pitch * mapped.defaultPitch)
      const rounded = Math.round(semitones)
      const key = Math.max(0, Math.min(87, 90 - mapped.sourceKey + rounded))
      const pitch = Math.max(-32_768, Math.min(32_767, Math.round((semitones - (key + mapped.sourceKey - 90)) * 100)))
      return {
        tick,
        layer,
        instrument: mapped.instrument,
        key,
        velocity: Math.max(0, Math.min(100, Math.round(marker.volume * 100))),
        panning: Math.max(0, Math.min(200, Math.round(((marker.pan ?? 0) + 1) * 100))),
        pitch,
      }
    })
  const selectedTempoEvents = tempoEventsInSelection(
    state,
    minTick,
    valid.reduce((value, marker) => Math.max(value, marker.tick), 0),
  )
  let omittedTempoEventCount = 0
  let quantizedTempoEventCount = 0
  for (const event of selectedTempoEvents) {
    const tick = event.tick - minTick
    let layer = -1
    for (let candidate = 0; candidate <= MAX_NBP_LAYER; candidate++) {
      if (!occupied.has(`${tick}:${candidate}`)) {
        layer = candidate
        break
      }
    }
    if (layer < 0 || notes.length >= MAX_NBP_NOTES
      || NBP_V2_VANILLA_INSTRUMENTS + customBySound.size > 255) {
      omittedTempoEventCount++
      continue
    }
    const mapped = tempoChangerInstrument(customBySound)
    const pitch = Math.round(event.bpm)
    if (Math.abs(event.bpm - pitch) > 1e-6) quantizedTempoEventCount++
    occupied.add(`${tick}:${layer}`)
    notes.push({
      tick,
      layer,
      instrument: mapped.instrument,
      key: 39,
      velocity: 100,
      panning: 100,
      pitch,
    })
  }
  if (collisionCount) warnings.push(`${collisionCount} colliding note(s) were moved to additional pattern layers.`)
  if (omittedTempoEventCount) {
    warnings.push(`${omittedTempoEventCount} selected tempo change(s) could not be represented within NBP's layer, instrument, or note limits.`)
  }
  if (quantizedTempoEventCount) {
    warnings.push(`${quantizedTempoEventCount} selected Tempo Changer BPM value(s) were rounded to whole numbers required by OpenNBS.`)
  }
  const omittedMeterEventCount = selectedTempoEvents.filter(event => event.meter !== undefined).length
  if (omittedMeterEventCount) {
    warnings.push(`${omittedMeterEventCount} selected meter event(s) are not represented by NBP patterns; the destination meter is preserved on insertion.`)
  }
  if (valid.some(marker => (marker.duration ?? 0) > 0 || marker.retriggerInterval !== undefined)) {
    warnings.push('Marker duration and retrigger settings are not represented by NBP patterns.')
  }
  const gatedMarkerCount = valid.filter(marker => (
    !isSoundStopMarker(marker)
    && marker.soundId.length > 0
    && (marker.gateTicks ?? 0) > 0
  )).length
  if (gatedMarkerCount > 0) {
    warnings.push(`${gatedMarkerCount} marker gate length(s) are not represented by NBP patterns.`)
  }
  if (valid.some(marker => marker.volumeCurve !== undefined || marker.pitchCurve !== undefined)) {
    warnings.push('Automation curves are not represented by NBP patterns.')
  }
  let remappedAuthoredSoundIds = 0
  let bakedDefaultPitchCount = 0
  for (const [soundId, definition] of customBySound) {
    if (soundId.startsWith('\u0000knead:')) continue
    const authored = state.customInstruments?.find(instrument => (
      instrument.kind === 'audio' && instrument.soundId === soundId
    ))
    if (!authored) continue
    if (safeCustomSoundId(definition.file, definition.sourceIndex) !== soundId) remappedAuthoredSoundIds++
    if (authored.defaultPitch !== 1) bakedDefaultPitchCount++
  }
  if (remappedAuthoredSoundIds) {
    warnings.push(`${remappedAuthoredSoundIds} authored sound ID(s) are not stored by NBP and will be re-derived from their file paths on import.`)
  }
  if (bakedDefaultPitchCount) {
    warnings.push(`${bakedDefaultPitchCount} authored default sample pitch value(s) were baked into NBP note pitch.`)
  }
  const usedTrackIds = new Set(valid.map(marker => marker.trackId))
  const usedTracks = state.tracks.filter(track => usedTrackIds.has(track.id))
  if (usedTracks.some(track => track.gainDb !== 0 || track.pan !== 0 || track.muted || track.solo) || state.master.gainDb !== 0) {
    warnings.push('Track/master mixer settings are not represented by NBP patterns.')
  }
  const maxTick = notes.reduce((value, note) => Math.max(value, note.tick), 0)
  const maxLayer = notes.reduce((value, note) => Math.max(value, note.layer), 0)
  const pattern: NbpPattern = {
    version,
    songLength: maxTick,
    songHeight: maxLayer,
    selectionLength: maxTick + 1,
    columns: [],
    notes,
    customInstruments: [...customBySound.values()],
  }
  const written = writeNbp(pattern, version)
  return { pattern, data: written.data, warnings: [...warnings, ...written.warnings] }
}

function instrumentForPattern(pattern: NbpPattern, instrument: number): {
  soundId: string
  sourceKey: number
  soundStop: boolean
  tempoChanger: boolean
} {
  if (instrument < NBP_V2_VANILLA_INSTRUMENTS) {
    return {
      soundId: NBS_VANILLA_SOUND_IDS[instrument] ?? `nbp:instrument_${instrument}`,
      sourceKey: 45,
      soundStop: false,
      tempoChanger: false,
    }
  }
  const custom = pattern.customInstruments.find(candidate => candidate.sourceIndex === instrument)
  return custom
    ? {
        soundId: safeCustomSoundId(custom.file, instrument),
        sourceKey: custom.key,
        soundStop: isSoundStopperInstrument(custom),
        tempoChanger: isTempoChangerInstrument(custom),
      }
    : {
        soundId: `nbp:instrument_${instrument}`,
        sourceKey: 45,
        soundStop: false,
        tempoChanger: false,
      }
}

function projectDefinitionsForPattern(pattern: NbpPattern): {
  definitions: ProjectCustomInstrument[]
  warnings: string[]
} {
  const warnings: string[] = []
  const definitions = pattern.customInstruments.slice(0, MAX_PROJECT_CUSTOM_INSTRUMENTS).map((instrument) => {
    const kind = projectCustomInstrumentKind(instrument.name)
    const normalizedFile = instrument.file.replace(/\\/gu, '/')
    const file = kind === 'audio' && validateAuthoredNbsInstrumentFile(normalizedFile) !== null
      ? `instrument_${instrument.sourceIndex}.ogg`
      : normalizedFile
    if (kind === 'audio' && file !== normalizedFile) {
      warnings.push(`NBP instrument ${instrument.sourceIndex} used an unsafe file path; its authored path was replaced with ${file}.`)
    }
    return {
      id: `nbp-${instrument.sourceIndex}-${uuidv4()}`,
      kind,
      soundId: kind === 'audio' ? safeCustomSoundId(instrument.file, instrument.sourceIndex) : '',
      name: instrument.name,
      file,
      key: instrument.key,
      pressKey: instrument.pressKey,
      defaultPitch: 1,
    }
  })
  if (pattern.customInstruments.length > definitions.length) {
    warnings.push(`${pattern.customInstruments.length - definitions.length} NBP custom-instrument definition(s) exceeded the project limit and were omitted.`)
  }
  return { definitions, warnings }
}

function patternMarkers(
  pattern: NbpPattern,
  tracks: Track[],
  startTick: number,
  startTrackIndex: number,
  settings = DEFAULT_SETTINGS,
): {
  markers: Marker[]
  tempoEvents: TempoMapEvent[]
  warnings: string[]
} {
  const warnings: string[] = []
  let boundedPitch = 0
  let clampedMix = 0
  let clampedTempo = 0
  let duplicateTempo = 0
  let locked = 0
  const markers: Marker[] = []
  const tempoWinnerByTick = new Map<number, NbpNote>()
  for (const note of pattern.notes) {
    const track = tracks[startTrackIndex + note.layer]
    if (!track || track.locked) {
      locked++
      continue
    }
    const mapped = instrumentForPattern(pattern, note.instrument)
    if (mapped.tempoChanger) {
      const previous = tempoWinnerByTick.get(note.tick)
      if (previous) duplicateTempo++
      if (!previous || note.layer >= previous.layer) tempoWinnerByTick.set(note.tick, note)
      continue
    }
    if (mapped.soundStop) {
      markers.push({
        id: uuidv4(),
        trackId: track.id,
        tick: startTick + note.tick,
        soundId: '',
        variantIndex: -1,
        volume: 1,
        pitch: 1,
        pan: 0,
        laneY: 0.5,
        action: decodeSoundStopAction(note),
      })
      continue
    }
    const semitones = note.key + mapped.sourceKey - 90 + note.pitch / 100
    const rawPitch = 2 ** (semitones / 12)
    if (!Number.isFinite(rawPitch) || rawPitch < MIN_MARKER_PITCH || rawPitch > MAX_MARKER_PITCH) {
      boundedPitch++
    }
    markers.push({
      id: uuidv4(),
      trackId: track.id,
      tick: startTick + note.tick,
      soundId: mapped.soundId,
      variantIndex: -1,
      volume: Math.max(0, Math.min(1, note.velocity / 100)),
      pitch: Number.isFinite(rawPitch)
        ? Math.max(MIN_MARKER_PITCH, Math.min(MAX_MARKER_PITCH, rawPitch))
        : rawPitch > 0 ? MAX_MARKER_PITCH : MIN_MARKER_PITCH,
      pan: Math.max(-1, Math.min(1, (note.panning - 100) / 100)),
      laneY: snapLaneY(1 - Math.max(0, Math.min(1, (note.key - 33) / 24))),
    })
    if (note.velocity > 100 || note.panning > 200) clampedMix++
  }
  const { min, max } = tempoBpmLimits(settings)
  const tempoEvents = [...tempoWinnerByTick.values()]
    .sort((left, right) => left.tick - right.tick)
    .map((note): TempoMapEvent => {
      const rawBpm = nbsTempoChangerBpm(note.pitch)
      const bpm = Math.max(min, Math.min(max, rawBpm))
      if (bpm !== rawBpm) clampedTempo++
      return { tick: startTick + note.tick, bpm }
    })
  if (locked) warnings.push(`${locked} note(s) targeting locked or unavailable tracks were skipped.`)
  if (boundedPitch) {
    warnings.push(`${boundedPitch} note(s) outside Knead's safe ${MIN_MARKER_PITCH}..${MAX_MARKER_PITCH} DAW pitch range were clamped.`)
  }
  if (clampedMix) warnings.push(`${clampedMix} ordinary note velocity/panning value(s) were clamped.`)
  if (duplicateTempo) {
    warnings.push(`${duplicateTempo} earlier Tempo Changer note(s) shared a pattern tick; the highest unlocked layer won, matching OpenNBS.`)
  }
  if (clampedTempo) {
    warnings.push(`${clampedTempo} Tempo Changer event(s) outside Knead's ${min}..${max} BPM range were clamped.`)
  }
  const unresolved = new Set(markers.filter(marker => marker.soundId.startsWith('nbp:')).map(marker => marker.soundId))
  if (unresolved.size) warnings.push(`${unresolved.size} instrument definition(s) could not be resolved from this pattern.`)
  return { markers, tempoEvents, warnings }
}

function mergeTempoEvents(
  state: Pick<TimelineState, 'settings' | 'tempoMap'>,
  incoming: readonly TempoMapEvent[],
  warnings: string[],
): TempoMapEvent[] {
  const current = normalizeTempoMap(state.tempoMap, state.settings)
  const byTick = new Map(current.map(event => [event.tick, event]))
  const eventLimit = tempoMapEventLimit(state.settings)
  let omitted = 0
  for (const event of incoming) {
    const previous = byTick.get(event.tick)
    if (!previous && byTick.size >= eventLimit) {
      omitted++
      continue
    }
    byTick.set(event.tick, {
      tick: event.tick,
      bpm: event.bpm,
      ...(previous?.meter === undefined ? {} : { meter: { ...previous.meter } }),
    })
  }
  if (omitted) {
    warnings.push(`${omitted} Tempo Changer event(s) exceeded Knead's ${eventLimit}-event tempo-map limit and were omitted.`)
  }
  return normalizeTempoMap([...byTick.values()], state.settings)
}

export function insertNbpPattern(
  state: TimelineState,
  pattern: NbpPattern,
  options: InsertNbpOptions = {},
): NbpConversionResult {
  const startTick = Math.max(0, Math.round(options.startTick ?? 0))
  const startTrackIndex = Math.max(0, Math.round(options.startTrackIndex ?? state.tracks.length))
  const next = structuredClone(state)
  const requiredTracks = startTrackIndex + pattern.notes.reduce((value, note) => Math.max(value, note.layer + 1), 1)
  while (next.tracks.length < requiredTracks) next.tracks.push(createDefaultTrack(uuidv4(), next.tracks.length))
  const converted = patternMarkers(pattern, next.tracks, startTick, startTrackIndex, next.settings)
  const incomingDefinitions = projectDefinitionsForPattern(pattern)
  converted.warnings.push(...incomingDefinitions.warnings)
  const definitions = next.customInstruments ?? (next.customInstruments = [])
  for (const incoming of incomingDefinitions.definitions) {
    const matching = incoming.kind === 'audio'
      ? definitions.find(instrument => instrument.kind === 'audio' && instrument.soundId === incoming.soundId)
      : definitions.find(instrument => instrument.kind === incoming.kind)
    if (matching) {
      if (matching.name !== incoming.name || matching.file !== incoming.file
        || matching.key !== incoming.key || matching.pressKey !== incoming.pressKey) {
        converted.warnings.push(`NBP definition ${incoming.name} collided with an existing project instrument; the existing definition was kept.`)
      }
      continue
    }
    if (definitions.length >= MAX_PROJECT_CUSTOM_INSTRUMENTS) {
      converted.warnings.push(`NBP definition ${incoming.name} exceeded the project custom-instrument limit and was omitted.`)
      continue
    }
    definitions.push(incoming)
  }
  next.markers.push(...converted.markers)
  next.tempoMap = mergeTempoEvents(next, converted.tempoEvents, converted.warnings)
  next.settings.bpm = next.tempoMap[0].bpm
  next.settings.timeSignature = { ...next.tempoMap[0].meter! }
  next.lengthTicks = getTimelineLengthTicks(
    next.markers,
    next.lengthTicks,
    next.settings,
    next.referenceAudio ?? [],
    next.tempoMap,
  )
  return {
    state: next,
    warnings: converted.warnings,
    insertedMarkerIds: converted.markers.map(marker => marker.id),
  }
}

export function nbpToTimelineState(pattern: NbpPattern, targetVersion = ''): NbpConversionResult {
  const layerCount = pattern.notes.reduce((value, note) => Math.max(value, note.layer + 1), 1)
  const tracks = Array.from({ length: layerCount }, (_, index) => createDefaultTrack(uuidv4(), index))
  const converted = patternMarkers(pattern, tracks, 0, 0)
  const incomingDefinitions = projectDefinitionsForPattern(pattern)
  converted.warnings.push(...incomingDefinitions.warnings)
  const settings = structuredClone(DEFAULT_SETTINGS)
  const tempoMap = mergeTempoEvents({ settings, tempoMap: undefined }, converted.tempoEvents, converted.warnings)
  settings.bpm = tempoMap[0].bpm
  settings.timeSignature = { ...tempoMap[0].meter! }
  const state: TimelineState = {
    projectId: uuidv4(),
    randomSeed: Math.floor(Math.random() * 0x1_0000_0000),
    targetVersion,
    lengthTicks: getTimelineLengthTicks(
      converted.markers,
      Math.max(1, pattern.songLength + 1),
      settings,
      [],
      tempoMap,
    ),
    settings,
    master: { ...DEFAULT_MASTER },
    tracks,
    markers: converted.markers,
    customInstruments: incomingDefinitions.definitions,
    tempoMap,
  }
  return { state, warnings: converted.warnings, insertedMarkerIds: converted.markers.map(marker => marker.id) }
}
