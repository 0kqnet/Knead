import { v4 as uuidv4 } from 'uuid'
import {
  DEFAULT_MASTER,
  DEFAULT_SETTINGS,
  TRACK_COLORS,
  createDefaultTrack,
  dbToGain,
  getTimelineLengthTicks,
  isTrackAudible,
  isSoundStopMarker,
  MAX_SOUND_STOP_TRACK,
  MAX_TEMPO_MAP_EVENTS,
  MAX_MARKER_PITCH,
  MIN_MARKER_PITCH,
  snapLaneY,
  type Marker,
  type NbsCustomInstrumentSource,
  type NbsProjectSource,
  type SoundStopAction,
  type TimelineState,
  type Track,
} from '../types/timeline'
import { sampleCurve } from './curveSampling'
import { normalizeTempoMap } from './tempoMap'
import { normalizeSongMetadata } from './timelineIO'
import { projectCustomInstrumentsFromNbs } from './customInstruments'

export interface NbsHeader {
  version: number
  vanillaInstrumentCount: number
  /** Inclusive index of the final NBS tick (`enda` in OpenNBS). */
  songLength: number
  layerCount: number
  name: string
  author: string
  originalAuthor: string
  description: string
  tempo: number
  autoSave: boolean
  autoSaveDuration: number
  /** Numerator of the N/4 meter. OpenNBS supports 2 through 8. */
  timeSignature: number
  minutesSpent: number
  leftClicks: number
  rightClicks: number
  blocksAdded: number
  blocksRemoved: number
  sourceFile: string
  loop: boolean
  maxLoopCount: number
  loopStartTick: number
}

export interface NbsNote {
  tick: number
  layer: number
  instrument: number
  key: number
  velocity: number
  panning: number
  pitch: number
}

export interface NbsLayer {
  name: string
  locked: boolean
  volume: number
  panning: number
}

export interface NbsInstrument {
  name: string
  file: string
  key: number
  pressKey: boolean
}

export interface NbsSong {
  header: NbsHeader
  notes: NbsNote[]
  layers: NbsLayer[]
  customInstruments: NbsInstrument[]
}

/** OpenNBS draws each quarter-note beat every four song ticks. */
export const NBS_TICKS_PER_QUARTER = 4
const NBS_MIN_TIME_SIGNATURE = 2
const NBS_MAX_TIME_SIGNATURE = 8

export type NbsParseResult =
  | { ok: true, song: NbsSong }
  | { ok: false, error: string }

export interface NbsConversionResult {
  state: TimelineState
  warnings: string[]
}

export type NbsTargetVersion = 0 | 1 | 2 | 3 | 4 | 5 | 6

export interface NbsWriteResult {
  data: Uint8Array
  warnings: string[]
}

const MAX_NBS_BYTES = 16 * 1024 * 1024
const MAX_NBS_NOTES = 250_000
const MAX_NBS_LAYERS = 4_096
const MAX_NBS_STRING_BYTES = 1024 * 1024
const MAX_NBS_TOTAL_STRING_BYTES = 4 * 1024 * 1024
const MAX_NBS_SHORT = 0x7fff
const NBS_SOUND_STOPPER_NAME = 'Sound Stopper'
const NBS_SOUND_STOPPER_INSTRUMENT: NbsInstrument = {
  name: NBS_SOUND_STOPPER_NAME,
  file: '',
  key: 45,
  pressKey: false,
}
const NBS_TEMPO_CHANGER_NAME = 'Tempo Changer'
const NBS_TEMPO_CHANGER_INSTRUMENT: NbsInstrument = {
  name: NBS_TEMPO_CHANGER_NAME,
  file: '',
  key: 45,
  pressKey: false,
}

export const NBS_VANILLA_SOUND_IDS = [
  'block.note_block.harp',
  'block.note_block.bass',
  'block.note_block.basedrum',
  'block.note_block.snare',
  'block.note_block.hat',
  'block.note_block.guitar',
  'block.note_block.flute',
  'block.note_block.bell',
  'block.note_block.chime',
  'block.note_block.xylophone',
  'block.note_block.iron_xylophone',
  'block.note_block.cow_bell',
  'block.note_block.didgeridoo',
  'block.note_block.bit',
  'block.note_block.banjo',
  'block.note_block.pling',
  'block.note_block.trumpet',
  'block.note_block.trumpet_exposed',
  'block.note_block.trumpet_weathered',
  'block.note_block.trumpet_oxidized',
] as const

const NBS_TRUMPET_INSTRUMENTS: NbsInstrument[] = [
  { name: 'Trumpet', file: 'trumpet.ogg', key: 45, pressKey: true },
  { name: 'Exposed Trumpet', file: 'trumpet_exposed.ogg', key: 45, pressKey: true },
  { name: 'Weathered Trumpet', file: 'trumpet_weathered.ogg', key: 45, pressKey: true },
  { name: 'Oxidized Trumpet', file: 'trumpet_oxidized.ogg', key: 45, pressKey: true },
]

const NBS_POST_CLASSIC_INSTRUMENTS: NbsInstrument[] = [
  { name: 'Iron Xylophone', file: 'iron_xylophone.ogg', key: 45, pressKey: true },
  { name: 'Cow Bell', file: 'cow_bell.ogg', key: 45, pressKey: true },
  { name: 'Didgeridoo', file: 'didgeridoo.ogg', key: 45, pressKey: true },
  { name: 'Bit', file: 'bit.ogg', key: 45, pressKey: true },
  { name: 'Banjo', file: 'banjo.ogg', key: 45, pressKey: true },
  { name: 'Pling', file: 'pling.ogg', key: 45, pressKey: true },
  ...NBS_TRUMPET_INSTRUMENTS,
]

function downgradedVanillaInstrument(instrument: number): NbsInstrument {
  return NBS_POST_CLASSIC_INSTRUMENTS[instrument - 10] ?? {
    name: `Vanilla instrument ${instrument}`,
    file: `instrument_${instrument}.ogg`,
    key: 45,
    pressKey: true,
  }
}

class BinaryReader {
  private readonly view: DataView
  private readonly utf8Decoder = new TextDecoder('utf-8', { fatal: true })
  offset = 0
  private totalStringBytes = 0

  constructor(buffer: ArrayBuffer) {
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_NBS_BYTES) throw new Error('Invalid NBS data size')
    this.view = new DataView(buffer)
  }

  get remaining(): number { return this.view.byteLength - this.offset }

  private ensure(length: number): void {
    if (length < 0 || this.offset + length > this.view.byteLength) throw new Error('Unexpected end of NBS file')
  }

  u8(): number {
    this.ensure(1)
    return this.view.getUint8(this.offset++)
  }

  i16(): number {
    this.ensure(2)
    const value = this.view.getInt16(this.offset, true)
    this.offset += 2
    return value
  }

  i32(): number {
    this.ensure(4)
    const value = this.view.getInt32(this.offset, true)
    this.offset += 4
    return value
  }

  string(): string {
    const length = this.i32()
    if (length < 0 || length > MAX_NBS_STRING_BYTES) throw new Error(`Invalid NBS string length: ${length}`)
    this.totalStringBytes += length
    if (this.totalStringBytes > MAX_NBS_TOTAL_STRING_BYTES) throw new Error('NBS string data exceeds the safe limit')
    this.ensure(length)
    const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, length)
    let value: string
    try {
      value = this.utf8Decoder.decode(bytes)
    }
    catch {
      value = ''
      const chunkSize = 0x8000
      for (let start = 0; start < bytes.length; start += chunkSize) {
        value += String.fromCharCode(...bytes.subarray(start, start + chunkSize))
      }
    }
    this.offset += length
    return value
  }
}

class BinaryWriter {
  private readonly chunks: number[] = []

  u8(value: number): void { this.chunks.push(value & 0xff) }

  i16(value: number): void {
    const unsigned = value & 0xffff
    this.chunks.push(unsigned & 0xff, (unsigned >>> 8) & 0xff)
  }

  u16(value: number): void { this.i16(value) }

  i32(value: number): void {
    const unsigned = value >>> 0
    this.chunks.push(unsigned & 0xff, (unsigned >>> 8) & 0xff, (unsigned >>> 16) & 0xff, (unsigned >>> 24) & 0xff)
  }

  string(value: string): void {
    const bytes = Array.from(value, (character) => {
      const codePoint = character.codePointAt(0) ?? 0x3f
      return codePoint <= 0xff ? codePoint : 0x3f
    })
    this.i32(bytes.length)
    for (const byte of bytes) this.chunks.push(byte)
  }

  finish(): Uint8Array { return Uint8Array.from(this.chunks) }
}

export function parseNbs(buffer: ArrayBuffer): NbsParseResult {
  try {
    const reader = new BinaryReader(buffer)
    const firstLength = reader.i16()
    if (firstLength < 0) throw new Error('Invalid negative NBS song length')
    const modern = firstLength === 0
    const version = modern ? reader.u8() : 0
    if (version > 6) throw new Error(`Unsupported NBS version: ${version}`)
    const vanillaInstrumentCount = modern ? reader.u8() : 10
    const storedSongEndTick = modern ? (version >= 3 ? reader.i16() : undefined) : firstLength
    if (storedSongEndTick !== undefined && storedSongEndTick < 0) {
      throw new Error('Invalid negative NBS song length')
    }
    const songLength = storedSongEndTick ?? 0
    const layerCount = reader.i16()
    if (layerCount < 0 || layerCount > MAX_NBS_LAYERS) {
      throw new Error(`NBS layer count must be between 0 and ${MAX_NBS_LAYERS}`)
    }
    const header: NbsHeader = {
      version,
      vanillaInstrumentCount,
      songLength,
      layerCount,
      name: reader.string(),
      author: reader.string(),
      originalAuthor: reader.string(),
      description: reader.string(),
      tempo: reader.i16(),
      autoSave: reader.u8() !== 0,
      autoSaveDuration: reader.u8(),
      timeSignature: reader.u8(),
      minutesSpent: reader.i32(),
      leftClicks: reader.i32(),
      rightClicks: reader.i32(),
      blocksAdded: reader.i32(),
      blocksRemoved: reader.i32(),
      sourceFile: reader.string(),
      loop: version >= 4 ? reader.u8() !== 0 : false,
      maxLoopCount: version >= 4 ? reader.u8() : 0,
      loopStartTick: version >= 4 ? reader.i16() : 0,
    }
    if (header.tempo <= 0) throw new Error('NBS tempo must be greater than zero')
    if (header.loopStartTick < 0) throw new Error('NBS loop start tick cannot be negative')

    const notes: NbsNote[] = []
    let tick = -1
    while (true) {
      const tickJump = reader.i16()
      if (tickJump === 0) break
      if (tickJump < 0 || tick + tickJump > MAX_NBS_SHORT) throw new Error('Invalid NBS tick delta')
      tick += tickJump
      let layer = -1
      while (true) {
        const layerJump = reader.i16()
        if (layerJump === 0) break
        if (layerJump < 0 || layer + layerJump >= layerCount) throw new Error('Invalid NBS layer delta')
        layer += layerJump
        if (notes.length >= MAX_NBS_NOTES) throw new Error(`NBS note count exceeds ${MAX_NBS_NOTES}`)
        notes.push({
          tick,
          layer,
          instrument: reader.u8(),
          key: reader.u8(),
          velocity: version >= 4 ? reader.u8() : 100,
          panning: version >= 4 ? reader.u8() : 100,
          pitch: version >= 4 ? reader.i16() : 0,
        })
      }
    }

    const layers: NbsLayer[] = []
    for (let index = 0; index < layerCount; index++) {
      if (reader.remaining <= 0) break
      layers.push({
        name: reader.string(),
        locked: version >= 4 ? reader.u8() !== 0 : false,
        volume: reader.u8(),
        panning: version >= 2 ? reader.u8() : 100,
      })
    }
    while (layers.length < layerCount) {
      layers.push({ name: `Layer ${layers.length + 1}`, locked: false, volume: 100, panning: 100 })
    }

    const customInstruments: NbsInstrument[] = []
    if (reader.remaining > 0) {
      const count = reader.u8()
      for (let index = 0; index < count; index++) {
        customInstruments.push({
          name: reader.string(),
          file: reader.string(),
          key: reader.u8(),
          pressKey: reader.u8() !== 0,
        })
      }
    }
    const calculatedLastTick = notes.reduce((length, note) => Math.max(length, note.tick), 0)
    header.songLength = Math.max(header.songLength, calculatedLastTick)
    return { ok: true, song: { header, notes, layers, customInstruments } }
  }
  catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function vanillaInstrumentCountForTarget(targetVersion: NbsTargetVersion): number {
  if (targetVersion === 0) return 10
  return targetVersion >= 6 ? 20 : 16
}

function customInstrumentLimitForTarget(targetVersion: NbsTargetVersion): number {
  if (targetVersion === 0) return 9
  return targetVersion < 5 ? 18 : 240
}

function normalizeInstrumentsForTarget(song: NbsSong, targetVersion: NbsTargetVersion): {
  notes: NbsNote[]
  customInstruments: NbsInstrument[]
  vanillaInstrumentCount: number
  downgradedVanillaCount: number
} {
  if (!Number.isInteger(targetVersion) || targetVersion < 0 || targetVersion > 6) {
    throw new Error(`Unsupported NBS target version: ${targetVersion}`)
  }
  const targetBase = vanillaInstrumentCountForTarget(targetVersion)
  const sourceBase = Math.max(0, Math.min(255, song.header.vanillaInstrumentCount))
  const downgradedVanilla = Array.from(new Set(song.notes
    .map(note => note.instrument)
    .filter(instrument => instrument >= targetBase && instrument < sourceBase)))
    .sort((a, b) => a - b)
  const downgradedIndex = new Map(downgradedVanilla.map((instrument, index) => [instrument, index]))
  const downgradedInstruments = downgradedVanilla.map(downgradedVanillaInstrument)
  const customInstruments = [...downgradedInstruments, ...song.customInstruments]
  const customLimit = Math.min(customInstrumentLimitForTarget(targetVersion), 256 - targetBase)
  if (customInstruments.length > customLimit) {
    throw new Error(`NBS v${targetVersion} supports at most ${customLimit} custom instruments (got ${customInstruments.length})`)
  }
  const notes = song.notes.map((note) => {
    if (!Number.isInteger(note.instrument) || note.instrument < 0 || note.instrument > 255) {
      throw new Error(`Invalid NBS instrument ID: ${note.instrument}`)
    }
    if (note.instrument < sourceBase) {
      if (note.instrument < targetBase) return { ...note }
      const index = downgradedIndex.get(note.instrument)
      if (index === undefined) throw new Error(`Cannot down-save vanilla instrument ${note.instrument}`)
      return { ...note, instrument: targetBase + index }
    }
    const customIndex = note.instrument - sourceBase
    if (customIndex >= song.customInstruments.length) {
      throw new Error(`NBS note references missing custom instrument ${customIndex}`)
    }
    return { ...note, instrument: targetBase + downgradedInstruments.length + customIndex }
  })
  return {
    notes,
    customInstruments,
    vanillaInstrumentCount: targetBase,
    downgradedVanillaCount: downgradedInstruments.length,
  }
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.round(value)))
}

export function isSoundStopperInstrument(instrument: NbsInstrument | NbsCustomInstrumentSource | undefined): boolean {
  return instrument?.name === NBS_SOUND_STOPPER_NAME
}

export function isTempoChangerInstrument(instrument: NbsInstrument | NbsCustomInstrumentSource | undefined): boolean {
  return instrument?.name === NBS_TEMPO_CHANGER_NAME
}

function isNormalizedSoundStopperNote(
  note: NbsNote,
  normalized: Pick<ReturnType<typeof normalizeInstrumentsForTarget>, 'customInstruments' | 'vanillaInstrumentCount'>,
): boolean {
  if (note.instrument < normalized.vanillaInstrumentCount) return false
  return isSoundStopperInstrument(
    normalized.customInstruments[note.instrument - normalized.vanillaInstrumentCount],
  )
}

function decodeSoundStopEnd(note: Pick<NbsNote, 'panning' | 'velocity'>): number {
  const low = (Math.floor(note.panning) + 156) & 0xff
  const high = (Math.floor(note.velocity) + 156) & 0xff
  return low + high * 256
}

export function decodeSoundStopAction(note: Pick<NbsNote, 'pitch' | 'panning' | 'velocity'>): SoundStopAction {
  const rawStart = Math.floor(note.pitch)
  if (rawStart <= 0) return { type: 'sound-stop', scope: 'all' }
  const startTrack = Math.min(MAX_SOUND_STOP_TRACK, rawStart)
  const endTrack = Math.min(
    MAX_SOUND_STOP_TRACK,
    Math.max(startTrack, decodeSoundStopEnd(note)),
  )
  return { type: 'sound-stop', scope: 'track-range', startTrack, endTrack }
}

export function encodeSoundStopEnd(value: number): Pick<NbsNote, 'panning' | 'velocity'> {
  const encoded = clampInteger(value, 0, MAX_SOUND_STOP_TRACK)
  const high = Math.floor(encoded / 256)
  const low = encoded - high * 256
  return {
    panning: (low + 100) & 0xff,
    velocity: (high + 100) & 0xff,
  }
}

function sameSoundStopAction(left: SoundStopAction, right: SoundStopAction): boolean {
  if (left.scope !== right.scope) return false
  return left.scope === 'all'
    || (left.startTrack === right.startTrack && left.endTrack === right.endTrack)
}

function basenameForClassicNbs(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

function serializedNbsStrings(song: NbsSong, instruments: NbsInstrument[]): string[] {
  return [
    song.header.name,
    song.header.author,
    song.header.originalAuthor,
    song.header.description,
    song.header.sourceFile,
    ...song.layers.map(layer => layer.name),
    ...instruments.flatMap(instrument => [instrument.name, instrument.file]),
  ]
}

function validateSerializedStringBudgets(strings: string[]): void {
  let totalBytes = 0
  for (const value of strings) {
    const bytes = Array.from(value).length
    if (bytes > MAX_NBS_STRING_BYTES) throw new Error(`NBS string exceeds ${MAX_NBS_STRING_BYTES} bytes`)
    totalBytes += bytes
    if (totalBytes > MAX_NBS_TOTAL_STRING_BYTES) {
      throw new Error(`NBS string data exceeds ${MAX_NBS_TOTAL_STRING_BYTES} bytes`)
    }
  }
}

function validateNbsWriteInput(song: NbsSong): void {
  if (!Number.isInteger(song.header.vanillaInstrumentCount)
    || song.header.vanillaInstrumentCount < 0
    || song.header.vanillaInstrumentCount > 255) {
    throw new Error(`Invalid NBS vanilla instrument count: ${song.header.vanillaInstrumentCount}`)
  }
  if (song.notes.length > MAX_NBS_NOTES) throw new Error(`NBS export exceeds ${MAX_NBS_NOTES} notes`)
  if (!Number.isInteger(song.header.songLength) || song.header.songLength < 0) {
    throw new Error(`Invalid NBS song length: ${song.header.songLength}`)
  }
  for (const note of song.notes) {
    if (!Number.isInteger(note.tick) || note.tick < 0) throw new Error(`Invalid NBS note tick: ${note.tick}`)
    if (!Number.isInteger(note.layer) || note.layer < 0) throw new Error(`Invalid NBS note layer: ${note.layer}`)
  }
}

function compatibilityWarnings(
  song: NbsSong,
  targetVersion: NbsTargetVersion,
  normalized: ReturnType<typeof normalizeInstrumentsForTarget>,
): string[] {
  const warnings: string[] = []
  const encodedTimeSignature = clampInteger(
    song.header.timeSignature,
    NBS_MIN_TIME_SIGNATURE,
    NBS_MAX_TIME_SIGNATURE,
  )
  if (encodedTimeSignature !== song.header.timeSignature) {
    warnings.push(`NBS time signature ${song.header.timeSignature}/4 was clamped to ${encodedTimeSignature}/4.`)
  }
  if (normalized.downgradedVanillaCount) {
    warnings.push(`${normalized.downgradedVanillaCount} vanilla instrument(s) were encoded as custom instruments for NBS v${targetVersion}.`)
  }
  if (targetVersion < 4) {
    const ordinaryNotes = normalized.notes.filter(note => !isNormalizedSoundStopperNote(note, normalized))
    const velocityCount = ordinaryNotes.filter(note => clampInteger(note.velocity, 0, 100) !== 100).length
    const notePanCount = ordinaryNotes.filter(note => clampInteger(note.panning, 0, 200) !== 100).length
    const finePitchCount = ordinaryNotes.filter(note => clampInteger(note.pitch, -0x8000, 0x7fff) !== 0).length
    const rangedSoundStopCount = normalized.notes.filter(note => (
      isNormalizedSoundStopperNote(note, normalized) && note.pitch > 0
    )).length
    const lockedLayerCount = song.layers.filter(layer => layer.locked).length
    if (velocityCount) warnings.push(`${velocityCount} note velocity value(s) are unsupported in NBS v${targetVersion} and were reset to 100.`)
    if (notePanCount) warnings.push(`${notePanCount} note panning value(s) are unsupported in NBS v${targetVersion} and were reset to center.`)
    if (finePitchCount) warnings.push(`${finePitchCount} note fine-pitch value(s) are unsupported in NBS v${targetVersion} and were reset to 0.`)
    if (rangedSoundStopCount) {
      warnings.push(`${rangedSoundStopCount} Sound Stopper range(s) are unsupported in NBS v${targetVersion} and will stop all layers.`)
    }
    if (lockedLayerCount) warnings.push(`${lockedLayerCount} layer lock value(s) are unsupported in NBS v${targetVersion} and were removed.`)
    if (song.header.loop || song.header.maxLoopCount !== 0 || song.header.loopStartTick !== 0) {
      warnings.push(`Loop settings are unsupported in NBS v${targetVersion} and were removed.`)
    }
  }
  if (targetVersion < 2) {
    const layerPanCount = song.layers.filter(layer => clampInteger(layer.panning, 0, 200) !== 100).length
    if (layerPanCount) warnings.push(`${layerPanCount} layer panning value(s) are unsupported in NBS v${targetVersion} and were reset to center.`)
  }
  if (targetVersion === 1 || targetVersion === 2) {
    const calculatedLastTick = normalized.notes.reduce((length, note) => Math.max(length, note.tick), 0)
    if (song.header.songLength > calculatedLastTick) {
      warnings.push(`NBS v${targetVersion} does not store song length; trailing silence will not round-trip.`)
    }
  }
  if (targetVersion < 5) {
    const pathCount = normalized.customInstruments.filter(instrument => /[\\/]/.test(instrument.file)).length
    if (pathCount) warnings.push(`${pathCount} custom-instrument path(s) were reduced to file names for NBS v${targetVersion}.`)
  }
  const strings = serializedNbsStrings(song, normalized.customInstruments)
  const replacedStringCount = strings.filter(value => (
    Array.from(value).some(character => (character.codePointAt(0) ?? 0) > 0xff)
  )).length
  if (replacedStringCount) {
    warnings.push(`NBS uses single-byte text; unsupported characters were replaced in ${replacedStringCount} text field(s).`)
  }
  return warnings
}

export function getNbsCompatibilityWarnings(
  song: NbsSong,
  targetVersion: NbsTargetVersion,
): string[] {
  validateNbsWriteInput(song)
  return compatibilityWarnings(song, targetVersion, normalizeInstrumentsForTarget(song, targetVersion))
}

export function writeNbsWithWarnings(
  song: NbsSong,
  targetVersion: NbsTargetVersion = 5,
): NbsWriteResult {
  validateNbsWriteInput(song)
  const writer = new BinaryWriter()
  const normalized = normalizeInstrumentsForTarget(song, targetVersion)
  validateSerializedStringBudgets(serializedNbsStrings(song, normalized.customInstruments))
  const notes = [...normalized.notes]
    .sort((a, b) => a.tick - b.tick || a.layer - b.layer)
  const noteLayerCount = notes.reduce((maximum, note) => Math.max(maximum, note.layer + 1), 0)
  const lastNoteTick = notes.at(-1)?.tick ?? -1
  const layerCount = Math.max(song.header.layerCount, song.layers.length, noteLayerCount)
  const storedSongEndTick = Math.max(
    targetVersion === 0 ? 1 : 0,
    song.header.songLength,
    lastNoteTick,
  )
  if (layerCount > MAX_NBS_LAYERS) throw new Error(`NBS export exceeds ${MAX_NBS_LAYERS} layers`)
  if (storedSongEndTick > MAX_NBS_SHORT) {
    throw new Error(`NBS v${targetVersion} supports a last tick of at most ${MAX_NBS_SHORT.toLocaleString('en-US')}`)
  }
  if (targetVersion > 0) {
    writer.u16(0)
    writer.u8(targetVersion)
    writer.u8(normalized.vanillaInstrumentCount)
  }
  if (targetVersion === 0 || targetVersion >= 3) writer.u16(storedSongEndTick)
  writer.u16(layerCount)
  writer.string(song.header.name)
  writer.string(song.header.author)
  writer.string(song.header.originalAuthor)
  writer.string(song.header.description)
  writer.u16(Math.max(1, Math.min(MAX_NBS_SHORT, Math.round(song.header.tempo))))
  writer.u8(song.header.autoSave ? 1 : 0)
  writer.u8(clampInteger(song.header.autoSaveDuration, 0, 255))
  writer.u8(clampInteger(song.header.timeSignature, NBS_MIN_TIME_SIGNATURE, NBS_MAX_TIME_SIGNATURE))
  writer.i32(song.header.minutesSpent)
  writer.i32(song.header.leftClicks)
  writer.i32(song.header.rightClicks)
  writer.i32(song.header.blocksAdded)
  writer.i32(song.header.blocksRemoved)
  writer.string(song.header.sourceFile)
  if (targetVersion >= 4) {
    writer.u8(song.header.loop ? 1 : 0)
    writer.u8(clampInteger(song.header.maxLoopCount, 0, 255))
    writer.u16(clampInteger(song.header.loopStartTick, 0, MAX_NBS_SHORT))
  }

  let previousTick = -1
  let noteIndex = 0
  while (noteIndex < notes.length) {
    const tick = notes[noteIndex].tick
    const tickDelta = tick - previousTick
    if (tickDelta > MAX_NBS_SHORT) throw new Error(`NBS tick delta exceeds ${MAX_NBS_SHORT}`)
    writer.u16(tickDelta)
    previousTick = tick
    let previousLayer = -1
    while (noteIndex < notes.length && notes[noteIndex].tick === tick) {
      const note = notes[noteIndex++]
      if (note.layer <= previousLayer) throw new Error(`NBS layer collision at tick ${tick}`)
      const layerDelta = note.layer - previousLayer
      if (layerDelta > MAX_NBS_SHORT) throw new Error(`NBS layer delta exceeds ${MAX_NBS_SHORT}`)
      writer.u16(layerDelta)
      previousLayer = note.layer
      writer.u8(note.instrument)
      writer.u8(clampInteger(note.key, 0, 87))
      if (targetVersion >= 4) {
        const functionalSoundStop = isNormalizedSoundStopperNote(note, normalized)
        writer.u8(clampInteger(note.velocity, 0, functionalSoundStop ? 255 : 100))
        writer.u8(clampInteger(note.panning, 0, functionalSoundStop ? 255 : 200))
        writer.i16(clampInteger(note.pitch, -0x8000, 0x7fff))
      }
    }
    writer.u16(0)
  }
  writer.u16(0)

  for (let index = 0; index < layerCount; index++) {
    const layer = song.layers[index] ?? { name: `Layer ${index + 1}`, locked: false, volume: 100, panning: 100 }
    writer.string(layer.name)
    if (targetVersion >= 4) writer.u8(layer.locked ? 1 : 0)
    writer.u8(clampInteger(layer.volume, 0, 100))
    if (targetVersion >= 2) writer.u8(clampInteger(layer.panning, 0, 200))
  }
  writer.u8(normalized.customInstruments.length)
  for (const instrument of normalized.customInstruments) {
    writer.string(instrument.name)
    writer.string(targetVersion < 5 ? basenameForClassicNbs(instrument.file) : instrument.file)
    writer.u8(clampInteger(instrument.key, 0, 87))
    writer.u8(instrument.pressKey ? 1 : 0)
  }
  const data = writer.finish()
  if (data.byteLength > MAX_NBS_BYTES) throw new Error(`NBS export exceeds ${MAX_NBS_BYTES} bytes`)
  return { data, warnings: compatibilityWarnings(song, targetVersion, normalized) }
}

export function writeNbs(song: NbsSong, targetVersion: NbsTargetVersion = 5): Uint8Array {
  return writeNbsWithWarnings(song, targetVersion).data
}

function dbFromPercent(percent: number): number {
  return percent <= 0 ? -60 : Math.max(-60, Math.min(0, 20 * Math.log10(percent / 100)))
}

function soundIdForCustomInstrument(custom: NbsInstrument | undefined, instrumentIndex: number): string {
  if (!custom) return `nbs:instrument_${instrumentIndex}`
  const path = custom.file.replace(/\\/g, '/').replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_./-]+/g, '_')
  return `nbs:custom/${path || `instrument_${instrumentIndex}`}`
}

function soundIdForNote(song: NbsSong, instrumentIndex: number): string {
  if (instrumentIndex < song.header.vanillaInstrumentCount) {
    return NBS_VANILLA_SOUND_IDS[instrumentIndex] ?? `nbs:instrument_${instrumentIndex}`
  }
  const custom = song.customInstruments[instrumentIndex - song.header.vanillaInstrumentCount]
  return soundIdForCustomInstrument(custom, instrumentIndex)
}

function soundIdForProjectSource(source: NbsProjectSource, instrumentIndex: number): string {
  if (instrumentIndex < source.vanillaInstrumentCount) {
    return NBS_VANILLA_SOUND_IDS[instrumentIndex] ?? `nbs:instrument_${instrumentIndex}`
  }
  return soundIdForCustomInstrument(
    source.customInstruments[instrumentIndex - source.vanillaInstrumentCount],
    instrumentIndex,
  )
}

function sourceKeyForProjectSource(source: NbsProjectSource, instrumentIndex: number): number {
  if (instrumentIndex < source.vanillaInstrumentCount) return 45
  return source.customInstruments[instrumentIndex - source.vanillaInstrumentCount]?.key ?? 45
}

function sourceKeyForNote(song: NbsSong, instrumentIndex: number): number {
  if (instrumentIndex < song.header.vanillaInstrumentCount) return 45
  return song.customInstruments[instrumentIndex - song.header.vanillaInstrumentCount]?.key ?? 45
}

function isTempoChangerNote(song: NbsSong, note: Pick<NbsNote, 'instrument'>): boolean {
  if (note.instrument < song.header.vanillaInstrumentCount) return false
  return isTempoChangerInstrument(
    song.customInstruments[note.instrument - song.header.vanillaInstrumentCount],
  )
}

export function nbsTempoChangerTicksPerSecond(pitch: number): number {
  return Math.max(0.25, Math.floor(Math.abs(pitch)) / 15)
}

interface NbsTempoSegment {
  sourceTick: number
  timelineTick: number
  ticksPerSecond: number
  sourceNote?: NbsNote
}

interface NbsTempoMapping {
  rawNotes: NbsNote[]
  activeNotes: NbsNote[]
  segments: NbsTempoSegment[]
  mapTick: (sourceTick: number) => number
  duplicateAtTickCount: number
  lockedCount: number
}

/**
 * Rebuild OpenNBS' functional Tempo Changer clock. A changer is processed at
 * its column time and affects the interval beginning at that source tick. If
 * several changers share a column, layer-order processing makes the last one
 * win. Locked layers do not participate in OpenNBS playback.
 */
function buildNbsTempoMapping(song: NbsSong): NbsTempoMapping {
  const rawNotes = song.notes
    .filter(note => isTempoChangerNote(song, note))
    .sort((left, right) => left.tick - right.tick || left.layer - right.layer)
  const unlocked = rawNotes.filter(note => !(song.layers[note.layer]?.locked ?? false))
  const winnerByTick = new Map<number, NbsNote>()
  for (const note of unlocked) winnerByTick.set(note.tick, note)
  const activeNotes = [...winnerByTick.values()].sort((left, right) => left.tick - right.tick)
  const initialTicksPerSecond = song.header.tempo / 100
  const segments: NbsTempoSegment[] = [{
    sourceTick: 0,
    timelineTick: 0,
    ticksPerSecond: initialTicksPerSecond,
  }]
  let sourceTick = 0
  let timelineTick = 0
  let ticksPerSecond = initialTicksPerSecond
  for (const note of activeNotes) {
    timelineTick += (note.tick - sourceTick) * 20 / ticksPerSecond
    sourceTick = note.tick
    ticksPerSecond = nbsTempoChangerTicksPerSecond(note.pitch)
    const segment: NbsTempoSegment = { sourceTick, timelineTick, ticksPerSecond, sourceNote: note }
    if (segments.at(-1)?.sourceTick === sourceTick) segments[segments.length - 1] = segment
    else segments.push(segment)
  }
  const mapTick = (targetTick: number): number => {
    let low = 0
    let high = segments.length - 1
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (segments[middle].sourceTick <= targetTick) low = middle
      else high = middle - 1
    }
    const segment = segments[low]
    return segment.timelineTick + (targetTick - segment.sourceTick) * 20 / segment.ticksPerSecond
  }
  return {
    rawNotes,
    activeNotes,
    segments,
    mapTick,
    duplicateAtTickCount: unlocked.length - activeNotes.length,
    lockedCount: rawNotes.length - unlocked.length,
  }
}

function toNbsNoteSource(note: NbsNote) {
  return {
    format: 'nbs' as const,
    tick: note.tick,
    layer: note.layer,
    instrument: note.instrument,
    key: note.key,
    velocity: note.velocity,
    panning: note.panning,
    pitch: note.pitch,
  }
}

export function nbsToTimelineState(song: NbsSong, targetVersion = ''): NbsConversionResult {
  const warnings: string[] = []
  const ticksPerSecond = song.header.tempo / 100
  const scale = 20 / ticksPerSecond
  const tempoMapping = buildNbsTempoMapping(song)
  const tracks: Track[] = song.layers.map((layer, index) => ({
    ...createDefaultTrack(uuidv4(), index),
    name: layer.name.trim() || `Layer ${index + 1}`,
    color: TRACK_COLORS[index % TRACK_COLORS.length],
    gainDb: dbFromPercent(layer.volume),
    pan: Math.max(-1, Math.min(1, (layer.panning - 100) / 100)),
    locked: layer.locked,
    source: {
      format: 'nbs',
      index,
      name: layer.name,
      locked: layer.locked,
      volume: layer.volume,
      panning: layer.panning,
    },
  }))
  while (tracks.length < song.header.layerCount) tracks.push(createDefaultTrack(uuidv4(), tracks.length))
  if (tracks.length === 0) tracks.push(createDefaultTrack(uuidv4()))

  let boundedPitchCount = 0
  let customCount = 0
  let normalizedSoundStopCount = 0
  const markers: Marker[] = song.notes.filter(note => !isTempoChangerNote(song, note)).map((note) => {
    const trackId = tracks[Math.max(0, Math.min(tracks.length - 1, note.layer))].id
    const source = toNbsNoteSource(note)
    const customInstrument = note.instrument >= song.header.vanillaInstrumentCount
      ? song.customInstruments[note.instrument - song.header.vanillaInstrumentCount]
      : undefined
    if (isSoundStopperInstrument(customInstrument)) {
      const action = decodeSoundStopAction(note)
      if (note.pitch > MAX_SOUND_STOP_TRACK || decodeSoundStopEnd(note) > MAX_SOUND_STOP_TRACK) {
        normalizedSoundStopCount++
      }
      return {
        id: uuidv4(),
        trackId,
        tick: Math.max(0, Math.round(tempoMapping.mapTick(note.tick))),
        soundId: '',
        variantIndex: -1,
        volume: 1,
        pitch: 1,
        pan: 0,
        laneY: 0.5,
        action,
        source,
      }
    }
    const soundId = soundIdForNote(song, note.instrument)
    if (soundId.startsWith('nbs:custom/') || soundId.startsWith('nbs:instrument_')) customCount++
    const semitones = note.key + sourceKeyForNote(song, note.instrument) - 90 + note.pitch / 100
    const rawPitch = 2 ** (semitones / 12)
    if (!Number.isFinite(rawPitch) || rawPitch < MIN_MARKER_PITCH || rawPitch > MAX_MARKER_PITCH) {
      boundedPitchCount++
    }
    return {
      id: uuidv4(),
      trackId,
      tick: Math.max(0, Math.round(tempoMapping.mapTick(note.tick))),
      soundId,
      variantIndex: -1,
      volume: Math.max(0, Math.min(1, note.velocity / 100)),
      pitch: Number.isFinite(rawPitch)
        ? Math.max(MIN_MARKER_PITCH, Math.min(MAX_MARKER_PITCH, rawPitch))
        : rawPitch > 0 ? MAX_MARKER_PITCH : MIN_MARKER_PITCH,
      pan: Math.max(-1, Math.min(1, (note.panning - 100) / 100)),
      laneY: snapLaneY(1 - Math.max(0, Math.min(1, (note.key - 33) / 24))),
      source,
    }
  })
  if (boundedPitchCount) {
    warnings.push(`${boundedPitchCount} note(s) outside Knead's safe ${MIN_MARKER_PITCH}..${MAX_MARKER_PITCH} DAW pitch range were clamped; raw NBS pitch fields were retained for round-trip export.`)
  }
  if (customCount) warnings.push(`${customCount} custom-instrument note(s) need matching sounds to be installed.`)
  if (normalizedSoundStopCount) {
    warnings.push(`${normalizedSoundStopCount} Sound Stopper range(s) exceeded OpenNBS's supported range and were clamped.`)
  }
  const maxTick = markers.reduce((value, marker) => Math.max(value, marker.tick + 1), 1)
  const mappedLength = Math.max(maxTick, Math.ceil(tempoMapping.mapTick(song.header.songLength + 1)))
  const settings = structuredClone(DEFAULT_SETTINGS)
  settings.panLaw = 'nbs-average'
  const importedMeterNumerator = clampInteger(
    song.header.timeSignature,
    NBS_MIN_TIME_SIGNATURE,
    NBS_MAX_TIME_SIGNATURE,
  )
  settings.timeSignature = {
    numerator: importedMeterNumerator,
    denominator: 4,
  }
  let clampedTempoCount = 0
  let canonicalTempoCollisionCount = 0
  const tempoEventsByTick = new Map<number, { tick: number, bpm: number, meter?: { numerator: number, denominator: 4 } }>()
  for (const segment of tempoMapping.segments) {
    const tick = Math.max(0, Math.round(segment.timelineTick))
    const rawBpm = segment.ticksPerSecond * 60 / NBS_TICKS_PER_QUARTER
    const bpm = Math.max(20, Math.min(300, rawBpm))
    if (bpm !== rawBpm) clampedTempoCount++
    if (tempoEventsByTick.has(tick)) canonicalTempoCollisionCount++
    tempoEventsByTick.set(tick, {
      tick,
      bpm,
      ...(tick === 0 ? { meter: { numerator: importedMeterNumerator, denominator: 4 as const } } : {}),
    })
  }
  const allTempoEvents = [...tempoEventsByTick.values()].sort((left, right) => left.tick - right.tick)
  const importedTempoEvents = allTempoEvents.slice(0, MAX_TEMPO_MAP_EVENTS)
  const tempoMap = normalizeTempoMap(importedTempoEvents, {
    ...settings,
    bpm: importedTempoEvents[0]?.bpm ?? Math.max(20, Math.min(300, 60 * ticksPerSecond / NBS_TICKS_PER_QUARTER)),
  })
  settings.bpm = tempoMap[0].bpm
  settings.loop = {
    enabled: song.header.loop,
    startTick: Math.max(0, Math.min(mappedLength - 1, Math.round(tempoMapping.mapTick(song.header.loopStartTick)))),
    endTick: mappedLength,
    maxLoopCount: song.header.maxLoopCount,
  }
  const state: TimelineState = {
    projectId: uuidv4(),
    randomSeed: Math.floor(Math.random() * 0x1_0000_0000),
    targetVersion,
    lengthTicks: getTimelineLengthTicks(markers, mappedLength, settings, [], tempoMap),
    settings,
    master: { ...DEFAULT_MASTER },
    tracks,
    markers,
    customInstruments: projectCustomInstrumentsFromNbs(
      song.customInstruments,
      song.header.vanillaInstrumentCount,
    ),
    tempoMap,
    metadata: normalizeSongMetadata({
      title: song.header.name,
      author: song.header.author,
      originalAuthor: song.header.originalAuthor,
      description: song.header.description,
      sourceFile: song.header.sourceFile,
      autoSave: song.header.autoSave,
      autoSaveDuration: song.header.autoSaveDuration,
      minutesSpent: song.header.minutesSpent,
      leftClicks: song.header.leftClicks,
      rightClicks: song.header.rightClicks,
      blocksAdded: song.header.blocksAdded,
      blocksRemoved: song.header.blocksRemoved,
    }),
    source: {
      format: 'nbs',
      sourceVersion: song.header.version,
      tickScale: scale,
      vanillaInstrumentCount: song.header.vanillaInstrumentCount,
      songLength: song.header.songLength,
      layerCount: song.header.layerCount,
      name: song.header.name,
      author: song.header.author,
      originalAuthor: song.header.originalAuthor,
      description: song.header.description,
      tempo: song.header.tempo,
      autoSave: song.header.autoSave,
      autoSaveDuration: song.header.autoSaveDuration,
      timeSignature: song.header.timeSignature,
      minutesSpent: song.header.minutesSpent,
      leftClicks: song.header.leftClicks,
      rightClicks: song.header.rightClicks,
      blocksAdded: song.header.blocksAdded,
      blocksRemoved: song.header.blocksRemoved,
      sourceFile: song.header.sourceFile,
      loop: song.header.loop,
      maxLoopCount: song.header.maxLoopCount,
      loopStartTick: song.header.loopStartTick,
      customInstruments: song.customInstruments.map(instrument => ({ ...instrument })),
      ...(tempoMapping.rawNotes.length > 0
        ? { tempoChangerNotes: tempoMapping.rawNotes.map(toNbsNoteSource) }
        : {}),
    },
  }
  state.settings.loop.endTick = Math.min(state.lengthTicks, Math.max(state.settings.loop.startTick + 1, mappedLength))
  const timingNeedsQuantization = tempoMapping.segments.some((segment) => {
    const segmentScale = 20 / segment.ticksPerSecond
    return Math.abs(segmentScale - Math.round(segmentScale)) > 1e-6
  }) || song.notes.some(note => (
    Math.abs(tempoMapping.mapTick(note.tick) - Math.round(tempoMapping.mapTick(note.tick))) > 1e-6
  ))
  if (timingNeedsQuantization) {
    warnings.push('NBS timing was quantized to Minecraft 20 TPS ticks.')
  }
  if (tempoMapping.duplicateAtTickCount > 0) {
    warnings.push(`${tempoMapping.duplicateAtTickCount} earlier Tempo Changer note(s) shared a source tick; the highest unlocked layer won, matching OpenNBS.`)
  }
  if (tempoMapping.lockedCount > 0) {
    warnings.push(`${tempoMapping.lockedCount} Tempo Changer note(s) on locked layers were preserved as source data but ignored during playback.`)
  }
  if (canonicalTempoCollisionCount > 0) {
    warnings.push(`${canonicalTempoCollisionCount} Tempo Changer event(s) collided after 20 TPS quantization; the last event won.`)
  }
  if (allTempoEvents.length > importedTempoEvents.length) {
    warnings.push(`${allTempoEvents.length - importedTempoEvents.length} Tempo Changer event(s) exceeded Knead's ${MAX_TEMPO_MAP_EVENTS}-event tempo-map limit and were omitted from the conductor map.`)
  }
  if (clampedTempoCount > 0) {
    warnings.push(`${clampedTempoCount} NBS tempo value(s) were clamped to Knead's 20–300 BPM conductor range; note timing remains source-accurate.`)
  }
  if (song.header.timeSignature !== importedMeterNumerator) {
    warnings.push(`NBS time signature ${song.header.timeSignature}/4 was clamped to ${importedMeterNumerator}/4.`)
  }
  return { state, warnings }
}

interface NbsExportTiming {
  scale: number
  tempo: number
  timeSignature: number
  mapTick: (timelineTick: number) => number
  tempoEvents: Array<{
    timelineTick: number
    sourceTick: number
    pitch: number
  }>
  omittedTempoEventCount: number
  collapsedTempoEventCount: number
  quantizedTempoEventCount: number
}

function nbsExportTiming(state: TimelineState, targetVersion: NbsTargetVersion): NbsExportTiming {
  const tempoMap = normalizeTempoMap(state.tempoMap, state.settings)
  const initialTempo = tempoMap[0]
  const initialSettings = {
    ...state.settings,
    bpm: initialTempo.bpm,
    timeSignature: { ...initialTempo.meter! },
  }
  const source = state.source?.format === 'nbs' ? state.source : undefined
  if (source && source.tickScale > 0 && source.tempo > 0 && source.tempo <= MAX_NBS_SHORT
    && source.timeSignature >= 2 && source.timeSignature <= 8
    && initialSettings.timeSignature.numerator === source.timeSignature
    && initialSettings.timeSignature.denominator === 4) {
    const sourceTicksPerSecond = source.tempo / 100
    const importedBpm = Math.max(20, Math.min(300, 60 * sourceTicksPerSecond / NBS_TICKS_PER_QUARTER))
    if (Math.abs(initialSettings.bpm - importedBpm) < 1e-6) {
      // Preserve an imported file's exact initial rate when its canonical
      // conductor event has not changed. Later events are still rebuilt below.
      const timing = buildNbsExportTempoSegments(
        tempoMap,
        source.tempo,
        source.timeSignature,
        targetVersion,
      )
      return timing
    }
  }
  const tempo = Math.max(1, Math.min(
    MAX_NBS_SHORT,
    Math.round(initialSettings.bpm * NBS_TICKS_PER_QUARTER * 100 / 60),
  ))
  return buildNbsExportTempoSegments(
    tempoMap,
    tempo,
    clampInteger(
      initialSettings.timeSignature.numerator,
      NBS_MIN_TIME_SIGNATURE,
      NBS_MAX_TIME_SIGNATURE,
    ),
    targetVersion,
  )
}

function buildNbsExportTempoSegments(
  tempoMap: ReturnType<typeof normalizeTempoMap>,
  tempo: number,
  timeSignature: number,
  targetVersion: NbsTargetVersion,
): NbsExportTiming {
  interface ExportSegment {
    timelineTick: number
    sourceTick: number
    scale: number
  }
  const initialScale = tempo / 2000
  const segments: ExportSegment[] = [{ timelineTick: 0, sourceTick: 0, scale: initialScale }]
  const tempoEvents: NbsExportTiming['tempoEvents'] = []
  let omittedTempoEventCount = 0
  let collapsedTempoEventCount = 0
  let quantizedTempoEventCount = 0
  let currentPitch = Math.round(tempo * 60 / (100 * NBS_TICKS_PER_QUARTER))

  for (const event of tempoMap.slice(1)) {
    const pitch = clampInteger(Math.round(event.bpm), 1, MAX_NBS_SHORT)
    if (Math.abs(event.bpm - pitch) > 1e-6) quantizedTempoEventCount++
    if (pitch === currentPitch) continue
    currentPitch = pitch
    if (targetVersion < 4) {
      omittedTempoEventCount++
      continue
    }

    const previous = segments[segments.length - 1]
    const sourceTick = Math.max(0, Math.round(
      previous.sourceTick + (event.tick - previous.timelineTick) * previous.scale,
    ))
    const timelineTick = previous.timelineTick + (sourceTick - previous.sourceTick) / previous.scale
    const nextSegment: ExportSegment = {
      timelineTick,
      sourceTick,
      scale: pitch / 300,
    }
    if (sourceTick === previous.sourceTick) {
      segments[segments.length - 1] = nextSegment
      if (tempoEvents.at(-1)?.sourceTick === sourceTick) tempoEvents[tempoEvents.length - 1] = { timelineTick, sourceTick, pitch }
      else tempoEvents.push({ timelineTick, sourceTick, pitch })
      collapsedTempoEventCount++
    }
    else {
      segments.push(nextSegment)
      tempoEvents.push({ timelineTick, sourceTick, pitch })
    }
  }

  const mapTick = (targetTick: number): number => {
    let low = 0
    let high = segments.length - 1
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (segments[middle].timelineTick <= targetTick) low = middle
      else high = middle - 1
    }
    const segment = segments[low]
    return segment.sourceTick + (targetTick - segment.timelineTick) * segment.scale
  }
  return {
    scale: initialScale,
    tempo,
    timeSignature,
    mapTick,
    tempoEvents,
    omittedTempoEventCount,
    collapsedTempoEventCount,
    quantizedTempoEventCount,
  }
}

function emptyHeader(
  state: TimelineState,
  name: string,
  targetVersion: NbsTargetVersion,
  timing: NbsExportTiming,
  noteCount: number,
): NbsHeader {
  const source = state.source?.format === 'nbs' ? state.source : undefined
  const metadata = state.metadata === undefined ? undefined : normalizeSongMetadata(state.metadata)
  return {
    version: targetVersion,
    vanillaInstrumentCount: vanillaInstrumentCountForTarget(targetVersion),
    songLength: Math.max(0, Math.round(timing.mapTick(state.lengthTicks)) - 1),
    layerCount: state.tracks.length,
    name: metadata?.title || source?.name || name,
    author: metadata ? metadata.author : source?.author ?? '',
    originalAuthor: metadata ? metadata.originalAuthor : source?.originalAuthor ?? '',
    description: metadata ? metadata.description : source?.description ?? 'Exported by Knead Studio',
    tempo: timing.tempo,
    autoSave: metadata ? metadata.autoSave : source?.autoSave ?? false,
    autoSaveDuration: metadata ? metadata.autoSaveDuration : source?.autoSaveDuration ?? 10,
    timeSignature: timing.timeSignature,
    minutesSpent: metadata ? metadata.minutesSpent : source?.minutesSpent ?? 0,
    leftClicks: metadata ? metadata.leftClicks : source?.leftClicks ?? 0,
    rightClicks: metadata ? metadata.rightClicks : source?.rightClicks ?? 0,
    blocksAdded: metadata ? metadata.blocksAdded : source?.blocksAdded ?? noteCount,
    blocksRemoved: metadata ? metadata.blocksRemoved : source?.blocksRemoved ?? 0,
    sourceFile: metadata ? metadata.sourceFile : source?.sourceFile ?? '',
    loop: state.settings.loop.enabled,
    maxLoopCount: state.settings.loop.maxLoopCount ?? source?.maxLoopCount ?? 0,
    loopStartTick: Math.round(timing.mapTick(state.settings.loop.startTick)),
  }
}

export function timelineStateToNbs(
  state: TimelineState,
  name = 'Knead Song',
  targetVersion: NbsTargetVersion = 5,
): { song: NbsSong, warnings: string[] } {
  const warnings: string[] = []
  const gatedMarkerCount = state.markers.filter(marker => (
    !isSoundStopMarker(marker)
    && marker.soundId.length > 0
    && (marker.gateTicks ?? 0) > 0
  )).length
  if (gatedMarkerCount > 0) {
    warnings.push(`${gatedMarkerCount} marker gate length(s) cannot be represented in NBS and were omitted.`)
  }
  const tempoMap = normalizeTempoMap(state.tempoMap, state.settings)
  const vanillaInstrumentCount = vanillaInstrumentCountForTarget(targetVersion)
  const timing = nbsExportTiming(state, targetVersion)
  const laterMeterEventCount = tempoMap.slice(1).filter(event => event.meter !== undefined).length
  if (laterMeterEventCount > 0) {
    warnings.push(`${laterMeterEventCount} later meter change(s) cannot be represented by NBS and were omitted.`)
  }
  if (timing.omittedTempoEventCount > 0) {
    warnings.push(`NBS v${targetVersion} cannot encode fine-pitch Tempo Changer events; ${timing.omittedTempoEventCount} later tempo change(s) were omitted while note timing was preserved.`)
  }
  if (timing.collapsedTempoEventCount > 0) {
    warnings.push(`${timing.collapsedTempoEventCount} Tempo Changer event(s) collapsed onto an earlier NBS tick after quantization; the last event won.`)
  }
  if (timing.quantizedTempoEventCount > 0) {
    warnings.push(`${timing.quantizedTempoEventCount} Tempo Changer BPM value(s) were rounded to whole numbers required by OpenNBS.`)
  }
  const initialMeter = tempoMap[0]?.meter ?? state.settings.timeSignature
  if (initialMeter.denominator !== 4 || initialMeter.numerator !== timing.timeSignature) {
    warnings.push(
      `NBS stores only 2/4 through 8/4 meters; ${initialMeter.numerator}/${initialMeter.denominator} was written as ${timing.timeSignature}/4.`,
    )
  }
  const mappedLength = Math.round(timing.mapTick(state.lengthTicks))
  if (mappedLength - 1 > MAX_NBS_SHORT) throw new Error('This project is too long for the selected NBS tick grid')
  const baseLayers: NbsLayer[] = state.tracks.map((track, index) => {
    const source = track.source?.format === 'nbs' ? track.source : undefined
    const importedName = source?.name.trim() || `Layer ${index + 1}`
    const importedGainDb = source ? dbFromPercent(source.volume) : Number.NaN
    const importedPan = source ? Math.max(-1, Math.min(1, (source.panning - 100) / 100)) : Number.NaN
    return {
      name: source && track.name === importedName ? source.name : track.name,
      locked: track.locked,
      volume: source && Math.abs(track.gainDb - importedGainDb) < 1e-9
        ? source.volume
        : Math.max(0, Math.min(100, Math.round(100 * dbToGain(track.gainDb)))),
      panning: source && Math.abs(track.pan - importedPan) < 1e-9
        ? source.panning
        : Math.max(0, Math.min(200, Math.round(100 + track.pan * 100))),
    }
  })
  const projectSource = state.source?.format === 'nbs' ? state.source : undefined
  const authoredInstruments = state.customInstruments
  const sourceInstrumentBaselines = projectSource
    ? projectCustomInstrumentsFromNbs(
        projectSource.customInstruments,
        projectSource.vanillaInstrumentCount,
      )
    : []
  const authoredNbsInstrument = (instrument: NonNullable<TimelineState['customInstruments']>[number]): NbsInstrument => {
    const sourceIndex = instrument.sourceIndex
    const baseline = sourceIndex === undefined ? undefined : sourceInstrumentBaselines[sourceIndex]
    const sourceInstrument = sourceIndex === undefined ? undefined : projectSource?.customInstruments[sourceIndex]
    const unchangedImportedDefinition = Boolean(
      baseline && sourceInstrument
      && instrument.id === baseline.id
      && instrument.kind === baseline.kind
      && instrument.sourceIndex === baseline.sourceIndex
      && instrument.soundId === baseline.soundId
      && instrument.name === baseline.name
      && instrument.file === baseline.file
      && instrument.key === baseline.key
      && instrument.pressKey === baseline.pressKey,
    )
    return unchangedImportedDefinition && sourceInstrument
      ? { ...sourceInstrument }
      : {
          name: instrument.name,
          file: instrument.file,
          key: instrument.key,
          pressKey: instrument.pressKey,
        }
  }
  const customInstruments: NbsInstrument[] = authoredInstruments !== undefined
    ? authoredInstruments.map(authoredNbsInstrument)
    : projectSource
      ? projectSource.customInstruments.map(instrument => ({ ...instrument }))
      : []
  const customBySound = new Map<string, number>()
  if (authoredInstruments !== undefined) {
    authoredInstruments.forEach((instrument, index) => {
      if (instrument.kind === 'audio' && !customBySound.has(instrument.soundId)) {
        customBySound.set(instrument.soundId, index)
      }
    })
  }
  else if (projectSource) {
    projectSource.customInstruments.forEach((instrument, index) => {
      if (isSoundStopperInstrument(instrument) || isTempoChangerInstrument(instrument)) return
      const instrumentId = projectSource.vanillaInstrumentCount + index
      const soundId = soundIdForCustomInstrument(instrument, instrumentId)
      if (!customBySound.has(soundId)) customBySound.set(soundId, index)
    })
  }
  const trackById = new Map(state.tracks.map((track, index) => [track.id, { track, index }]))
  const sortedMarkers = [...state.markers].sort((left, right) => {
    const leftTrack = trackById.get(left.trackId)?.index ?? Number.MAX_SAFE_INTEGER
    const rightTrack = trackById.get(right.trackId)?.index ?? Number.MAX_SAFE_INTEGER
    return left.tick - right.tick
      || leftTrack - rightTrack
      || (isSoundStopMarker(left) === isSoundStopMarker(right) ? left.id.localeCompare(right.id) : isSoundStopMarker(left) ? 1 : -1)
  })
  const firingCountForMarker = (marker: Marker): number => {
    const duration = Math.max(0, marker.duration ?? 0)
    const interval = Math.max(1, marker.retriggerInterval ?? 1)
    return duration > 0 ? Math.floor(duration / interval) + 1 : 1
  }
  const eventCountsByTrack = new Map<string, Map<number, number>>()
  let demandedNoteCount = 0
  const recordLayerDemand = (trackId: string, encodedTick: number) => {
    demandedNoteCount++
    if (demandedNoteCount > MAX_NBS_NOTES) throw new Error(`NBS export exceeds ${MAX_NBS_NOTES} notes`)
    const countsByTick = eventCountsByTrack.get(trackId) ?? new Map<number, number>()
    countsByTick.set(encodedTick, (countsByTick.get(encodedTick) ?? 0) + 1)
    eventCountsByTrack.set(trackId, countsByTick)
  }
  for (const marker of sortedMarkers) {
    const trackEntry = trackById.get(marker.trackId)
    if (!trackEntry) continue
    if (isSoundStopMarker(marker)) {
      recordLayerDemand(marker.trackId, Math.round(timing.mapTick(marker.tick)))
      continue
    }
    if (!marker.soundId || !isTrackAudible(trackEntry.track, state.tracks)) continue
    const duration = Math.max(0, marker.duration ?? 0)
    const interval = Math.max(1, marker.retriggerInterval ?? 1)
    const count = firingCountForMarker(marker)
    for (let firingIndex = 0; firingIndex < count; firingIndex++) {
      const offset = duration > 0 ? firingIndex * interval : 0
      recordLayerDemand(marker.trackId, Math.round(timing.mapTick(marker.tick + offset)))
    }
  }
  const trackLayerBankById = new Map<string, { start: number, end: number }>()
  const layers: NbsLayer[] = []
  state.tracks.forEach((track, index) => {
    const width = Math.max(1, ...eventCountsByTrack.get(track.id)?.values() ?? [])
    if (layers.length + width > MAX_NBS_LAYERS) {
      throw new Error(`NBS export exceeds ${MAX_NBS_LAYERS} layers`)
    }
    const start = layers.length
    for (let offset = 0; offset < width; offset++) {
      layers.push({
        ...baseLayers[index],
        name: offset === 0 ? baseLayers[index].name : `${baseLayers[index].name} ${offset + 1}`,
      })
    }
    trackLayerBankById.set(track.id, { start, end: layers.length - 1 })
  })
  const insertedLayerCount = layers.length - state.tracks.length
  const occupied = new Set<string>()
  const notes: NbsNote[] = []
  const masterGain = dbToGain(state.master.gainDb)
  let omittedFiringCount = 0
  let clippedVelocityCount = 0
  let clippedPitchCount = 0
  let downgradedVanillaCount = 0
  let soundStopCount = 0
  let soundStopperCustomIndex = customInstruments.findIndex(isSoundStopperInstrument)
  let tempoChangerCustomIndex = customInstruments.findIndex(isTempoChangerInstrument)

  const ensureSoundStopperInstrument = (): number => {
    if (soundStopperCustomIndex >= 0) return soundStopperCustomIndex
    soundStopperCustomIndex = customInstruments.length
    customInstruments.push({ ...NBS_SOUND_STOPPER_INSTRUMENT })
    return soundStopperCustomIndex
  }

  const ensureTempoChangerInstrument = (): number => {
    if (tempoChangerCustomIndex >= 0) return tempoChangerCustomIndex
    tempoChangerCustomIndex = customInstruments.length
    customInstruments.push({ ...NBS_TEMPO_CHANGER_INSTRUMENT })
    return tempoChangerCustomIndex
  }

  if (timing.tempoEvents.length > 0) {
    if (layers.length >= MAX_NBS_LAYERS) throw new Error(`NBS export exceeds ${MAX_NBS_LAYERS} layers`)
    const tempoLayer = layers.length
    layers.push({ name: NBS_TEMPO_CHANGER_NAME, locked: false, volume: 100, panning: 100 })
    const customIndex = ensureTempoChangerInstrument()
    const instrument = vanillaInstrumentCount + customIndex
    for (const event of timing.tempoEvents) {
      if (event.sourceTick < 0 || event.sourceTick > MAX_NBS_SHORT) {
        throw new Error(`Tempo change at tick ${event.timelineTick} is outside the NBS range`)
      }
      if (notes.length >= MAX_NBS_NOTES) throw new Error(`NBS export exceeds ${MAX_NBS_NOTES} notes`)
      notes.push({
        tick: event.sourceTick,
        layer: tempoLayer,
        instrument,
        key: 39,
        velocity: 100,
        panning: 100,
        pitch: event.pitch,
      })
    }
  }

  const allocateLayer = (marker: Marker, encodedTick: number): number => {
    const bank = trackLayerBankById.get(marker.trackId)
    if (!bank) throw new Error(`Missing NBS layer bank for track ${marker.trackId}`)
    for (let layer = bank.start; layer <= bank.end; layer++) {
      if (occupied.has(`${encodedTick}:${layer}`)) continue
      occupied.add(`${encodedTick}:${layer}`)
      return layer
    }
    throw new Error(`NBS layer bank exhausted at tick ${encodedTick}`)
  }

  const mapSoundStopTrack = (trackNumber: number, useBankEnd: boolean): number => {
    const track = state.tracks[trackNumber - 1]
    const bank = track ? trackLayerBankById.get(track.id) : undefined
    if (bank) return (useBankEnd ? bank.end : bank.start) + 1
    return clampInteger(trackNumber + insertedLayerCount, 1, MAX_SOUND_STOP_TRACK)
  }
  for (const marker of sortedMarkers) {
    const trackEntry = trackById.get(marker.trackId)
    if (!trackEntry) continue
    if (isSoundStopMarker(marker)) {
      if (notes.length >= MAX_NBS_NOTES) throw new Error(`NBS export exceeds ${MAX_NBS_NOTES} notes`)
      const encodedTick = Math.round(timing.mapTick(marker.tick))
      if (encodedTick < 0 || encodedTick > MAX_NBS_SHORT) {
        throw new Error(`Marker at tick ${marker.tick} is outside the NBS range`)
      }
      const layer = allocateLayer(marker, encodedTick)
      const customIndex = ensureSoundStopperInstrument()
      const instrument = vanillaInstrumentCount + customIndex
      const canonicalStart = marker.action.scope === 'all'
        ? 0
        : clampInteger(marker.action.startTrack ?? 1, 1, MAX_SOUND_STOP_TRACK)
      const canonicalEnd = marker.action.scope === 'all'
        ? 0
        : clampInteger(marker.action.endTrack ?? canonicalStart, canonicalStart, MAX_SOUND_STOP_TRACK)
      const encodedStart = marker.action.scope === 'all'
        ? 0
        : mapSoundStopTrack(canonicalStart, false)
      const physicalEnd = marker.action.scope === 'all'
        ? 0
        : mapSoundStopTrack(canonicalEnd, true)
      const encodedEnd = encodeSoundStopEnd(physicalEnd)
      const encodedAction: SoundStopAction = marker.action.scope === 'all'
        ? { type: 'sound-stop', scope: 'all' }
        : {
            type: 'sound-stop',
            scope: 'track-range',
            startTrack: encodedStart,
            endTrack: physicalEnd,
          }
      const markerSource = marker.source?.format === 'nbs' ? marker.source : undefined
      const trackSource = trackEntry.track.source?.format === 'nbs' ? trackEntry.track.source : undefined
      const sourceInstrument = markerSource && projectSource
        ? projectSource.customInstruments[
          markerSource.instrument - projectSource.vanillaInstrumentCount
        ]
        : undefined
      const canReuseSourceNote = Boolean(
        markerSource && trackSource && projectSource
        && isSoundStopperInstrument(sourceInstrument)
        && marker.tick === Math.round(markerSource.tick * projectSource.tickScale)
        && encodedTick === markerSource.tick
        && layer === markerSource.layer
        && trackSource.index === markerSource.layer
        && sameSoundStopAction(encodedAction, decodeSoundStopAction(markerSource)),
      )
      notes.push({
        tick: canReuseSourceNote && markerSource ? markerSource.tick : encodedTick,
        layer,
        instrument,
        key: canReuseSourceNote && markerSource ? clampInteger(markerSource.key, 0, 87) : 45,
        velocity: canReuseSourceNote && markerSource ? clampInteger(markerSource.velocity, 0, 255) : encodedEnd.velocity,
        panning: canReuseSourceNote && markerSource ? clampInteger(markerSource.panning, 0, 255) : encodedEnd.panning,
        pitch: canReuseSourceNote && markerSource ? clampInteger(markerSource.pitch, -0x8000, 0x7fff) : encodedStart,
      })
      soundStopCount++
      continue
    }
    if (!marker.soundId) continue
    const duration = Math.max(0, marker.duration ?? 0)
    const interval = Math.max(1, marker.retriggerInterval ?? 1)
    const count = firingCountForMarker(marker)
    if (!isTrackAudible(trackEntry.track, state.tracks)) {
      omittedFiringCount += count
      continue
    }
    const knownVanillaIndex = NBS_VANILLA_SOUND_IDS
      .indexOf(marker.soundId as typeof NBS_VANILLA_SOUND_IDS[number])
    let instrument = knownVanillaIndex >= 0 && knownVanillaIndex < vanillaInstrumentCount
      ? knownVanillaIndex
      : -1
    if (instrument < 0) {
      const markerSource = marker.source?.format === 'nbs' ? marker.source : undefined
      const sourceCustomIndex = markerSource && projectSource
        && markerSource.instrument >= projectSource.vanillaInstrumentCount
        ? markerSource.instrument - projectSource.vanillaInstrumentCount
        : -1
      const sourceCustom = sourceCustomIndex >= 0 ? projectSource?.customInstruments[sourceCustomIndex] : undefined
      const outputSourceCustom = sourceCustomIndex >= 0 ? customInstruments[sourceCustomIndex] : undefined
      const sourceDefinitionStillAtIndex = Boolean(
        sourceCustom && outputSourceCustom
        && sourceCustom.name === outputSourceCustom.name
        && sourceCustom.file === outputSourceCustom.file
        && sourceCustom.key === outputSourceCustom.key
        && sourceCustom.pressKey === outputSourceCustom.pressKey,
      )
      const unchangedSourceSound = sourceCustom
        && sourceDefinitionStillAtIndex
        && !isSoundStopperInstrument(sourceCustom)
        && !isTempoChangerInstrument(sourceCustom)
        && marker.soundId === soundIdForCustomInstrument(sourceCustom, markerSource?.instrument ?? -1)
      let customIndex = unchangedSourceSound ? sourceCustomIndex : customBySound.get(marker.soundId)
      if (customIndex === undefined) {
        customIndex = customInstruments.length
        customBySound.set(marker.soundId, customIndex)
        const downSavedVanilla = knownVanillaIndex >= vanillaInstrumentCount && knownVanillaIndex < 20
          ? downgradedVanillaInstrument(knownVanillaIndex)
          : undefined
        if (downSavedVanilla) downgradedVanillaCount++
        customInstruments.push(
          downSavedVanilla
            ? { ...downSavedVanilla }
            : {
                name: marker.soundId,
                file: `${marker.soundId.replace(/[:/\\]/g, '_')}.ogg`,
                key: 45,
                pressKey: true,
              },
        )
      }
      instrument = vanillaInstrumentCount + customIndex
    }

    const outputCustomInstrument = instrument >= vanillaInstrumentCount
      ? customInstruments[instrument - vanillaInstrumentCount]
      : undefined
    const authoredCustomInstrument = instrument >= vanillaInstrumentCount
      ? authoredInstruments?.[instrument - vanillaInstrumentCount]
      : undefined
    const outputSourceKey = outputCustomInstrument?.key ?? 45
    const outputDefaultPitch = authoredCustomInstrument?.kind === 'audio'
      ? authoredCustomInstrument.defaultPitch
      : 1

    for (let firingIndex = 0; firingIndex < count; firingIndex++) {
      if (notes.length >= MAX_NBS_NOTES) throw new Error(`NBS export exceeds ${MAX_NBS_NOTES} notes`)
      const offset = duration > 0 ? firingIndex * interval : 0
      const sourceTick = marker.tick + offset
      const encodedTick = Math.round(timing.mapTick(sourceTick))
      if (encodedTick < 0 || encodedTick > MAX_NBS_SHORT) {
        throw new Error(`Marker at tick ${sourceTick} is outside the NBS range`)
      }
      const layer = allocateLayer(marker, encodedTick)

      const sampledPitch = sampleCurve(marker.pitchCurve, offset, marker.pitch)
      const exactKey = 90 - outputSourceKey
        + 12 * Math.log2(Math.max(0.0001, sampledPitch * outputDefaultPitch))
      const key = Math.max(0, Math.min(87, Math.round(exactKey)))
      const rawFinePitch = Math.round((exactKey - key) * 100)
      const finePitch = Math.max(-0x8000, Math.min(0x7fff, rawFinePitch))
      const trackGain = dbToGain(trackEntry.track.gainDb)
      const layerGain = Math.min(1, trackGain)
      const gainBeyondLayer = layerGain > 0 ? trackGain / layerGain : 0
      const rawVelocity = sampleCurve(marker.volumeCurve, offset, marker.volume)
        * gainBeyondLayer * masterGain * 100
      if (rawVelocity > 100) clippedVelocityCount++
      const encodedVelocity = Math.max(0, Math.min(100, Math.round(rawVelocity)))
      const markerSource = marker.source?.format === 'nbs' ? marker.source : undefined
      const trackSource = trackEntry.track.source?.format === 'nbs' ? trackEntry.track.source : undefined
      const sourceInstrumentKey = markerSource && projectSource
        ? sourceKeyForProjectSource(projectSource, markerSource.instrument)
        : 45
      const sourceSemitones = markerSource
        ? markerSource.key + sourceInstrumentKey - 90 + markerSource.pitch / 100
        : 0
      const sourceCanonicalPitch = Math.max(
        MIN_MARKER_PITCH,
        Math.min(MAX_MARKER_PITCH, 2 ** (sourceSemitones / 12)),
      )
      const sourceCanonicalVolume = markerSource
        ? Math.max(0, Math.min(1, markerSource.velocity / 100))
        : 0
      const sourceCanonicalPan = markerSource
        ? Math.max(-1, Math.min(1, (markerSource.panning - 100) / 100))
        : 0
      const canReuseSourceNote = Boolean(
        markerSource && trackSource && projectSource
        && count === 1 && firingIndex === 0
        && !marker.pitchCurve && !marker.volumeCurve
        && marker.variantIndex < 0
        && outputDefaultPitch === 1
        && outputSourceKey === sourceInstrumentKey
        && marker.tick === Math.round(markerSource.tick * projectSource.tickScale)
        && encodedTick === markerSource.tick
        && layer === markerSource.layer
        && trackSource.index === markerSource.layer
        && marker.soundId === soundIdForProjectSource(projectSource, markerSource.instrument)
        && Math.abs(marker.volume - sourceCanonicalVolume) < 1e-9
        && Math.abs((marker.pan ?? 0) - sourceCanonicalPan) < 1e-9
        && Math.abs(marker.pitch - sourceCanonicalPitch) < 1e-9
        && encodedVelocity === clampInteger(markerSource.velocity, 0, 100),
      )
      if (!canReuseSourceNote && (key !== Math.round(exactKey) || finePitch !== rawFinePitch)) {
        clippedPitchCount++
      }
      notes.push({
        tick: canReuseSourceNote && markerSource ? markerSource.tick : encodedTick,
        layer,
        instrument,
        key: canReuseSourceNote && markerSource ? clampInteger(markerSource.key, 0, 87) : key,
        velocity: canReuseSourceNote && markerSource
          ? clampInteger(markerSource.velocity, 0, 100)
          : encodedVelocity,
        panning: canReuseSourceNote && markerSource
          ? clampInteger(markerSource.panning, 0, 200)
          : Math.max(0, Math.min(200, Math.round(100 + (marker.pan ?? 0) * 100))),
        pitch: canReuseSourceNote && markerSource
          ? clampInteger(markerSource.pitch, -0x8000, 0x7fff)
          : finePitch,
      })
    }
  }
  if (insertedLayerCount > 0) warnings.push('Overlapping notes were moved to generated NBS layers.')
  if (omittedFiringCount) warnings.push(`${omittedFiringCount} muted or non-solo firing(s) were omitted.`)
  if (clippedVelocityCount) warnings.push(`${clippedVelocityCount} firing(s) exceeded NBS velocity and were clipped.`)
  if (clippedPitchCount) warnings.push(`${clippedPitchCount} firing(s) exceeded the NBS key/pitch range and were clipped.`)
  if (downgradedVanillaCount) {
    warnings.push(`${downgradedVanillaCount} vanilla instrument(s) were encoded as custom instruments for NBS v${targetVersion}.`)
  }
  if (state.master.limiterEnabled) warnings.push('The Knead master limiter cannot be represented in NBS and was not applied.')
  if (state.markers.some(marker => marker.variantIndex >= 0)) warnings.push('Fixed sound variants cannot be represented in NBS.')
  const customSoundReferences = customInstruments.filter(instrument => (
    !isSoundStopperInstrument(instrument) && !isTempoChangerInstrument(instrument)
  )).length
  if (customSoundReferences) {
    warnings.push(`${customSoundReferences} sound reference(s) were exported as NBS custom instruments; audio files are not bundled.`)
  }
  if (soundStopCount && targetVersion < 4 && state.markers.some(marker => (
    isSoundStopMarker(marker) && marker.action.scope === 'track-range'
  ))) {
    warnings.push(`NBS v${targetVersion} cannot store Sound Stopper ranges; affected events stop all layers.`)
  }
  if (timing.tempoEvents.length > 0) {
    warnings.push('Timeline ticks were piecewise rescaled around Tempo Changer events for NBS\'s fixed four-ticks-per-quarter grid.')
  }
  else if (Math.abs(timing.scale - 1) > 1e-6) {
    warnings.push(`Timeline ticks were rescaled by ${timing.scale.toFixed(4)} for NBS's fixed four-ticks-per-quarter grid.`)
  }
  notes.sort((left, right) => left.tick - right.tick || left.layer - right.layer)
  const exportSong: NbsSong = {
    header: { ...emptyHeader(state, name, targetVersion, timing, notes.length), layerCount: layers.length },
    notes,
    layers,
    customInstruments,
  }
  for (const warning of getNbsCompatibilityWarnings(exportSong, targetVersion)) {
    if (!warnings.includes(warning)) warnings.push(warning)
  }
  return { song: exportSong, warnings }
}
