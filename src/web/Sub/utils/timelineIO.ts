import { v4 as uuidv4 } from 'uuid'
import {
  DEFAULT_MASTER,
  DEFAULT_SONG_METADATA,
  DEFAULT_SETTINGS,
  DEFAULT_TIMELINE_LENGTH_TICKS,
  MAX_EMBEDDED_CUSTOM_AUDIO_ASSETS,
  MAX_EMBEDDED_CUSTOM_AUDIO_BYTES,
  MAX_EMBEDDED_CUSTOM_AUDIO_PROJECT_BYTES,
  MAX_GATE_TICKS,
  MAX_MARKER_PITCH,
  MAX_PROJECT_CUSTOM_INSTRUMENTS,
  MAX_REFERENCE_AUDIO_BYTES,
  MAX_REFERENCE_AUDIO_DURATION_SECONDS,
  MAX_REFERENCE_AUDIO_PROJECT_BYTES,
  MAX_REFERENCE_AUDIO_TRACKS,
  MAX_LOOP_COUNT,
  MAX_SONG_METADATA_FIELD_LENGTH,
  MAX_SONG_METADATA_STAT,
  MAX_SONG_METADATA_TOTAL_LENGTH,
  MAX_SOUND_STOP_TRACK,
  MAX_TIMELINE_MARKERS,
  MIN_MARKER_PITCH,
  SINGLE_SHOT_CURVE_PREVIEW_TICKS,
  TRACK_COLORS,
  createDefaultTrack,
  getTimelineLengthTicks,
  snapLaneY,
  type EmbeddedCustomAudioAsset,
  type Keyframe,
  type Marker,
  type MidiNoteSource,
  type MidiPitchBendSource,
  type MidiProgramChangeSource,
  type MidiProjectSource,
  type MidiTempoSource,
  type MidiTimeSignatureSource,
  type MidiTrackSource,
  type NbsLayerSource,
  type NbsNoteSource,
  type NbsProjectSource,
  type ProjectCustomInstrument,
  type ReferenceAudioTrack,
  type SoundStopAction,
  type SongMetadata,
  type TempoMapEvent,
  type TimelineFile,
  type TimelineProjectSource,
  type TimelineSettings,
  type TimelineState,
  type Track,
} from '../types/timeline'
import { constrainCurveHandles } from './curveHandles'
import { deriveProjectCustomInstruments, validateProjectCustomInstruments } from './customInstruments'
import { normalizeTempoMap, validateTempoMap } from './tempoMap'

interface LegacyMarker extends Omit<Marker, 'trackId'> {
  trackY?: number
}

interface LegacyFile {
  format: 'knead-project'
  version: 1
  targetVersion: string
  lengthTicks: number
  markers: LegacyMarker[]
}

export type ParseResult =
  | { ok: true, state: TimelineState, warnings: string[] }
  | { ok: false, error: string }

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x)
}

function isIntegerInRange(x: unknown, min: number, max: number): x is number {
  return Number.isInteger(x) && (x as number) >= min && (x as number) <= max
}

const SONG_METADATA_STRING_FIELDS = [
  'title', 'author', 'originalAuthor', 'description', 'sourceFile',
] as const

const SONG_METADATA_STAT_FIELDS = [
  'minutesSpent', 'leftClicks', 'rightClicks', 'blocksAdded', 'blocksRemoved',
] as const

export function validateSongMetadata(x: unknown): string | null {
  if (!isObj(x)) return 'metadata がオブジェクトではありません'
  let totalLength = 0
  for (const field of SONG_METADATA_STRING_FIELDS) {
    const value = x[field]
    if (typeof value !== 'string' || value.length > MAX_SONG_METADATA_FIELD_LENGTH) {
      return `${field} が文字列ではない、または長さ上限を超えています`
    }
    totalLength += value.length
  }
  if (totalLength > MAX_SONG_METADATA_TOTAL_LENGTH) return 'metadata の文字列合計が長さ上限を超えています'
  if (typeof x.autoSave !== 'boolean') return 'autoSave がbooleanではありません'
  if (!isIntegerInRange(x.autoSaveDuration, 0, 0xff)) return 'autoSaveDuration が範囲外です'
  for (const field of SONG_METADATA_STAT_FIELDS) {
    if (!isIntegerInRange(x[field], 0, MAX_SONG_METADATA_STAT)) return `${field} が範囲外です`
  }
  return null
}

function clampMetadataInteger(value: unknown, fallback: number, maximum: number): number {
  if (!isFiniteNumber(value)) return fallback
  return Math.max(0, Math.min(maximum, Math.trunc(value)))
}

/** Canonicalize API-created states before they are persisted as project v10. */
export function normalizeSongMetadata(metadata?: Partial<SongMetadata>): SongMetadata {
  const source = metadata ?? DEFAULT_SONG_METADATA
  let remaining = MAX_SONG_METADATA_TOTAL_LENGTH
  const normalizedStrings = {} as Pick<SongMetadata, typeof SONG_METADATA_STRING_FIELDS[number]>
  for (const field of SONG_METADATA_STRING_FIELDS) {
    const value = typeof source[field] === 'string' ? source[field] : DEFAULT_SONG_METADATA[field]
    const bounded = value.slice(0, Math.min(MAX_SONG_METADATA_FIELD_LENGTH, remaining))
    normalizedStrings[field] = bounded
    remaining -= bounded.length
  }
  return {
    ...normalizedStrings,
    autoSave: typeof source.autoSave === 'boolean' ? source.autoSave : DEFAULT_SONG_METADATA.autoSave,
    autoSaveDuration: clampMetadataInteger(source.autoSaveDuration, DEFAULT_SONG_METADATA.autoSaveDuration, 0xff),
    minutesSpent: clampMetadataInteger(source.minutesSpent, 0, MAX_SONG_METADATA_STAT),
    leftClicks: clampMetadataInteger(source.leftClicks, 0, MAX_SONG_METADATA_STAT),
    rightClicks: clampMetadataInteger(source.rightClicks, 0, MAX_SONG_METADATA_STAT),
    blocksAdded: clampMetadataInteger(source.blocksAdded, 0, MAX_SONG_METADATA_STAT),
    blocksRemoved: clampMetadataInteger(source.blocksRemoved, 0, MAX_SONG_METADATA_STAT),
  }
}

function metadataFromNbsSource(source: NbsProjectSource): SongMetadata {
  return normalizeSongMetadata({
    title: source.name,
    author: source.author,
    originalAuthor: source.originalAuthor,
    description: source.description,
    sourceFile: source.sourceFile,
    autoSave: source.autoSave,
    autoSaveDuration: source.autoSaveDuration,
    minutesSpent: source.minutesSpent,
    leftClicks: source.leftClicks,
    rightClicks: source.rightClicks,
    blocksAdded: source.blocksAdded,
    blocksRemoved: source.blocksRemoved,
  })
}

function validateNbsNoteSource(x: unknown): x is NbsNoteSource {
  return isObj(x)
    && x.format === 'nbs'
    && isIntegerInRange(x.tick, 0, Number.MAX_SAFE_INTEGER)
    && isIntegerInRange(x.layer, 0, Number.MAX_SAFE_INTEGER)
    && isIntegerInRange(x.instrument, 0, 0xff)
    && isIntegerInRange(x.key, 0, 0xff)
    && isIntegerInRange(x.velocity, 0, 0xff)
    && isIntegerInRange(x.panning, 0, 0xff)
    && isIntegerInRange(x.pitch, -0x8000, 0x7fff)
}

function validateNbsLayerSource(x: unknown): x is NbsLayerSource {
  return isObj(x)
    && x.format === 'nbs'
    && isIntegerInRange(x.index, 0, 0xffff)
    && typeof x.name === 'string'
    && typeof x.locked === 'boolean'
    && isIntegerInRange(x.volume, 0, 0xff)
    && isIntegerInRange(x.panning, 0, 0xff)
}

function validateNbsProjectSource(x: unknown): x is NbsProjectSource {
  if (!isObj(x) || x.format !== 'nbs') return false
  const stringFields = [
    'name', 'author', 'originalAuthor', 'description', 'sourceFile',
  ] as const
  if (stringFields.some(field => typeof x[field] !== 'string')) return false
  if (typeof x.autoSave !== 'boolean' || typeof x.loop !== 'boolean') return false
  if (
    !isIntegerInRange(x.sourceVersion, 0, 0xff)
    || !isFiniteNumber(x.tickScale) || x.tickScale <= 0
    || !isIntegerInRange(x.vanillaInstrumentCount, 0, 0xff)
    || !isIntegerInRange(x.songLength, 0, 0x7fff)
    || !isIntegerInRange(x.layerCount, 0, 0xffff)
    || !isIntegerInRange(x.tempo, 0, 0xffff)
    || !isIntegerInRange(x.autoSaveDuration, 0, 0xff)
    || !isIntegerInRange(x.timeSignature, 0, 0xff)
    || !isIntegerInRange(x.minutesSpent, -0x8000_0000, 0x7fff_ffff)
    || !isIntegerInRange(x.leftClicks, -0x8000_0000, 0x7fff_ffff)
    || !isIntegerInRange(x.rightClicks, -0x8000_0000, 0x7fff_ffff)
    || !isIntegerInRange(x.blocksAdded, -0x8000_0000, 0x7fff_ffff)
    || !isIntegerInRange(x.blocksRemoved, -0x8000_0000, 0x7fff_ffff)
    || !isIntegerInRange(x.maxLoopCount, 0, 0xff)
    || !isIntegerInRange(x.loopStartTick, 0, 0xffff)
  ) return false
  if (!Array.isArray(x.customInstruments) || x.customInstruments.length > 0xff) return false
  if (x.tempoChangerNotes !== undefined && (
    !Array.isArray(x.tempoChangerNotes)
    || x.tempoChangerNotes.length > 250_000
    || !x.tempoChangerNotes.every(validateNbsNoteSource)
  )) return false
  return x.customInstruments.every(instrument => (
    isObj(instrument)
    && typeof instrument.name === 'string'
    && typeof instrument.file === 'string'
    && isIntegerInRange(instrument.key, 0, 0xff)
    && typeof instrument.pressKey === 'boolean'
  ))
}

function validateMidiTempoSource(x: unknown): x is MidiTempoSource {
  return isObj(x)
    && isIntegerInRange(x.tick, 0, 0x7fff_ffff)
    && isIntegerInRange(x.microsecondsPerQuarter, 1, 0xff_ffff)
    && isIntegerInRange(x.trackIndex, 0, 0xffff)
    && isIntegerInRange(x.order, 0, Number.MAX_SAFE_INTEGER)
}

function validateMidiTimeSignatureSource(x: unknown): x is MidiTimeSignatureSource {
  return isObj(x)
    && isIntegerInRange(x.tick, 0, 0x7fff_ffff)
    && isIntegerInRange(x.numerator, 0, 0xff)
    && isIntegerInRange(x.denominator, 1, 0x4000_0000)
    && ((x.denominator as number) & ((x.denominator as number) - 1)) === 0
    && isIntegerInRange(x.clocksPerMetronome, 0, 0xff)
    && isIntegerInRange(x.thirtySecondsPerQuarter, 0, 0xff)
    && isIntegerInRange(x.trackIndex, 0, 0xffff)
    && isIntegerInRange(x.order, 0, Number.MAX_SAFE_INTEGER)
}

function validateMidiProgramChangeSource(x: unknown): x is MidiProgramChangeSource {
  return isObj(x)
    && isIntegerInRange(x.tick, 0, 0x7fff_ffff)
    && isIntegerInRange(x.channel, 0, 15)
    && isIntegerInRange(x.program, 0, 127)
    && isIntegerInRange(x.order, 0, Number.MAX_SAFE_INTEGER)
}

function validateMidiPitchBendSource(x: unknown): x is MidiPitchBendSource {
  return isObj(x)
    && isIntegerInRange(x.tick, 0, 0x7fff_ffff)
    && isIntegerInRange(x.channel, 0, 15)
    && isIntegerInRange(x.value, -8192, 8191)
    && isIntegerInRange(x.order, 0, Number.MAX_SAFE_INTEGER)
}

function validateMidiProjectSource(x: unknown): x is MidiProjectSource {
  if (!isObj(x) || x.format !== 'midi') return false
  if (
    (x.sourceFormat !== 0 && x.sourceFormat !== 1)
    || !isIntegerInRange(x.ticksPerQuarter, 1, 0x7fff)
    || typeof x.fingerprint !== 'string' || !/^[0-9a-f]{8}$/i.test(x.fingerprint)
    || !Array.isArray(x.tempoEvents) || x.tempoEvents.length > 250_000
    || !Array.isArray(x.timeSignatureEvents) || x.timeSignatureEvents.length > 250_000
  ) return false
  return x.tempoEvents.every(validateMidiTempoSource)
    && x.timeSignatureEvents.every(validateMidiTimeSignatureSource)
}

function validateMidiTrackSource(x: unknown): x is MidiTrackSource {
  if (!isObj(x) || x.format !== 'midi') return false
  if (
    !isIntegerInRange(x.index, 0, 0xffff)
    || typeof x.name !== 'string' || typeof x.instrumentName !== 'string'
    || !isIntegerInRange(x.lastTick, 0, 0x7fff_ffff)
    || !Array.isArray(x.channels) || x.channels.length > 16
    || !x.channels.every(channel => isIntegerInRange(channel, 0, 15))
    || !Array.isArray(x.programChanges) || x.programChanges.length > 250_000
    || !Array.isArray(x.pitchBends) || x.pitchBends.length > 250_000
  ) return false
  return x.programChanges.every(validateMidiProgramChangeSource)
    && x.pitchBends.every(validateMidiPitchBendSource)
}

function validateMidiNoteSource(x: unknown): x is MidiNoteSource {
  return isObj(x)
    && x.format === 'midi'
    && isIntegerInRange(x.index, 0, 250_000)
    && isIntegerInRange(x.trackIndex, 0, 0xffff)
    && isIntegerInRange(x.channel, 0, 15)
    && isIntegerInRange(x.note, 0, 127)
    && isIntegerInRange(x.velocity, 0, 127)
    && isIntegerInRange(x.releaseVelocity, 0, 127)
    && isIntegerInRange(x.startTick, 0, 0x7fff_ffff)
    && isIntegerInRange(x.endTick, x.startTick as number, 0x7fff_ffff)
    && isIntegerInRange(x.program, 0, 127)
    && isIntegerInRange(x.startPitchBend, -8192, 8191)
    && isIntegerInRange(x.startOrder, 0, Number.MAX_SAFE_INTEGER)
    && isIntegerInRange(x.endOrder, 0, Number.MAX_SAFE_INTEGER)
}

function validateMarkerSource(x: unknown): x is NbsNoteSource | MidiNoteSource {
  return isObj(x) && (x.format === 'nbs' ? validateNbsNoteSource(x) : validateMidiNoteSource(x))
}

function validateTrackSource(x: unknown): x is NbsLayerSource | MidiTrackSource {
  return isObj(x) && (x.format === 'nbs' ? validateNbsLayerSource(x) : validateMidiTrackSource(x))
}

function validateProjectSource(x: unknown): x is TimelineProjectSource {
  return isObj(x) && (x.format === 'nbs' ? validateNbsProjectSource(x) : validateMidiProjectSource(x))
}

function validateHandle(x: unknown): boolean {
  return isObj(x) && isFiniteNumber(x.dt) && isFiniteNumber(x.dv)
}

function validateKeyframe(x: unknown): x is Keyframe {
  return isObj(x)
    && isFiniteNumber(x.tick) && x.tick >= 0
    && isFiniteNumber(x.value)
    && (x.interpolation === 'linear' || x.interpolation === 'bezier')
    && (x.handleL === undefined || validateHandle(x.handleL))
    && (x.handleR === undefined || validateHandle(x.handleR))
}

function validateCurve(
  x: unknown,
  duration: number,
  min: number,
  max: number,
  validateControlValues = false,
): string | null {
  if (!isObj(x) || !Array.isArray(x.keyframes) || x.keyframes.length === 0) {
    return 'keyframes が空、または配列ではありません'
  }
  let previous = -1
  for (let i = 0; i < x.keyframes.length; i++) {
    const keyframe = x.keyframes[i]
    if (!validateKeyframe(keyframe)) return `keyframes[${i}] の形式が不正です`
    if (keyframe.tick <= previous || keyframe.tick > duration) return `keyframes[${i}] のtickが不正です`
    if (keyframe.value < min || keyframe.value > max) return `keyframes[${i}] のvalueが範囲外です`
    if (validateControlValues) {
      for (const [name, handle] of [['handleL', keyframe.handleL], ['handleR', keyframe.handleR]] as const) {
        if (handle === undefined) continue
        const controlValue = keyframe.value + handle.dv
        if (!Number.isFinite(controlValue) || controlValue < min || controlValue > max) {
          return `keyframes[${i}].${name} のvalueが範囲外です`
        }
      }
    }
    previous = keyframe.tick
  }
  return null
}

function validateMarkerAction(x: unknown): string | null {
  if (!isObj(x) || x.type !== 'sound-stop') return 'type が不正です'
  if (x.scope === 'all') {
    if (x.startTrack !== undefined || x.endTrack !== undefined) {
      return 'all scope にトラック範囲は指定できません'
    }
    return null
  }
  if (x.scope !== 'track-range') return 'scope が不正です'
  if (!isIntegerInRange(x.startTrack, 1, MAX_SOUND_STOP_TRACK)) {
    return `startTrack が 1..${MAX_SOUND_STOP_TRACK} の範囲外です`
  }
  if (!isIntegerInRange(x.endTrack, x.startTrack as number, MAX_SOUND_STOP_TRACK)) {
    return `endTrack が startTrack..${MAX_SOUND_STOP_TRACK} の範囲外です`
  }
  return null
}

function validateMarker(
  x: unknown,
  lengthTicks: number,
  requireTrack: boolean,
  allowExtendedPitch: boolean,
): string | null {
  if (!isObj(x)) return 'オブジェクトではありません'
  if (typeof x.id !== 'string' || !x.id) return 'id が空です'
  if (requireTrack && (typeof x.trackId !== 'string' || !x.trackId)) return 'trackId が空です'
  if (!Number.isInteger(x.tick) || (x.tick as number) < 0 || (x.tick as number) >= lengthTicks) {
    return 'tick がタイムライン範囲外です'
  }
  if (typeof x.soundId !== 'string') return 'soundId が文字列ではありません'
  if (!Number.isInteger(x.variantIndex) || (x.variantIndex as number) < -1) return 'variantIndex が不正です'
  if (!isFiniteNumber(x.volume) || x.volume < 0 || x.volume > 1) return 'volume が 0..1 の範囲外です'
  const minimumPitch = allowExtendedPitch ? MIN_MARKER_PITCH : 0.5
  const maximumPitch = allowExtendedPitch ? MAX_MARKER_PITCH : 2
  if (!isFiniteNumber(x.pitch) || x.pitch < minimumPitch || x.pitch > maximumPitch) {
    return `pitch が ${minimumPitch}..${maximumPitch} の範囲外です`
  }
  if (x.pan !== undefined && (!isFiniteNumber(x.pan) || x.pan < -1 || x.pan > 1)) {
    return 'pan が -1..1 の範囲外です'
  }
  if (x.duration !== undefined && (!Number.isInteger(x.duration) || (x.duration as number) < 0)) {
    return 'duration が不正です'
  }
  if (
    x.gateTicks !== undefined
    && (!Number.isInteger(x.gateTicks) || (x.gateTicks as number) < 0 || (x.gateTicks as number) > MAX_GATE_TICKS)
  ) return `gateTicks が不正です（0..${MAX_GATE_TICKS}）`
  if (
    x.retriggerInterval !== undefined
    && (!Number.isInteger(x.retriggerInterval) || (x.retriggerInterval as number) <= 0)
  ) return 'retriggerInterval が不正です'
  if (x.laneY !== undefined && (!isFiniteNumber(x.laneY) || x.laneY < 0 || x.laneY > 1)) {
    return 'laneY が 0..1 の範囲外です'
  }
  if (x.source !== undefined && !validateMarkerSource(x.source)) return 'source が不正です'
  if (x.action !== undefined) {
    const actionError = validateMarkerAction(x.action)
    if (actionError) return `action: ${actionError}`
    if (x.soundId !== '' || x.variantIndex !== -1 || x.volume !== 1 || x.pitch !== 1 || (x.pan ?? 0) !== 0) {
      return 'Sound Stopper に音声・音量・ピッチ・パンは指定できません'
    }
    if (x.gateTicks !== undefined || x.duration !== undefined || x.retriggerInterval !== undefined
      || x.volumeCurve !== undefined || x.pitchCurve !== undefined) {
      return 'Sound Stopper にゲート・長さ・リトリガー・カーブは指定できません'
    }
  }
  const duration = isFiniteNumber(x.duration) && x.duration > 0
    ? x.duration
    : SINGLE_SHOT_CURVE_PREVIEW_TICKS
  if (x.volumeCurve !== undefined) {
    const error = validateCurve(x.volumeCurve, duration, 0, 1)
    if (error) return `volumeCurve: ${error}`
  }
  if (x.pitchCurve !== undefined) {
    const error = validateCurve(x.pitchCurve, duration, minimumPitch, maximumPitch, true)
    if (error) return `pitchCurve: ${error}`
  }
  return null
}

function validateTrack(x: unknown): string | null {
  if (!isObj(x)) return 'オブジェクトではありません'
  if (typeof x.id !== 'string' || !x.id) return 'id が空です'
  if (typeof x.name !== 'string' || !x.name.trim()) return 'name が空です'
  if (!TRACK_COLORS.includes(x.color as Track['color'])) return 'color が不正です'
  if (!isFiniteNumber(x.gainDb) || x.gainDb < -60 || x.gainDb > 12) return 'gainDb が範囲外です'
  if (!isFiniteNumber(x.pan) || x.pan < -1 || x.pan > 1) return 'pan が範囲外です'
  for (const key of ['muted', 'solo', 'locked', 'collapsed'] as const) {
    if (typeof x[key] !== 'boolean') return `${key} がbooleanではありません`
  }
  if (x.source !== undefined && !validateTrackSource(x.source)) return 'source が不正です'
  return null
}

function hasValidBase64Shape(value: string, byteLength: number): boolean {
  if (value.length !== Math.ceil(byteLength / 3) * 4 || value.length === 0) return false
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return value.length / 4 * 3 - padding === byteLength
}

function validateReferenceAudioTrack(x: unknown, lengthTicks: number): string | null {
  if (!isObj(x)) return 'オブジェクトではありません'
  if (typeof x.id !== 'string' || !x.id || x.id.length > 128) return 'id が不正です'
  if (typeof x.name !== 'string' || !x.name.trim() || x.name.length > 512) return 'name が不正です'
  if (!TRACK_COLORS.includes(x.color as Track['color'])) return 'color が不正です'
  if (
    typeof x.fileName !== 'string' || !x.fileName || x.fileName.length > 512
    || typeof x.sourcePath !== 'string' || x.sourcePath.length > 32_768
  ) return 'ファイル名またはsourcePathが不正です'
  if (x.mimeType !== 'audio/wav' && x.mimeType !== 'audio/ogg') return 'mimeType が不正です'
  if (!isIntegerInRange(x.byteLength, 1, MAX_REFERENCE_AUDIO_BYTES)) return 'byteLength が範囲外です'
  if (typeof x.fingerprint !== 'string' || !/^[0-9a-f]{8}$/i.test(x.fingerprint)) {
    return 'fingerprint が不正です'
  }
  if (
    typeof x.dataBase64 !== 'string'
    || !hasValidBase64Shape(x.dataBase64, x.byteLength as number)
  ) return 'dataBase64 が不正です'
  if (
    !isFiniteNumber(x.durationSeconds)
    || x.durationSeconds <= 0
    || x.durationSeconds > MAX_REFERENCE_AUDIO_DURATION_SECONDS
  ) return 'durationSeconds が範囲外です'
  if (!isIntegerInRange(x.offsetTicks, 0, Math.max(0, lengthTicks - 1))) {
    return 'offsetTicks がタイムライン範囲外です'
  }
  if (!isFiniteNumber(x.gainDb) || x.gainDb < -60 || x.gainDb > 12) return 'gainDb が範囲外です'
  if (!isFiniteNumber(x.pan) || x.pan < -1 || x.pan > 1) return 'pan が範囲外です'
  for (const key of ['muted', 'solo', 'locked', 'collapsed'] as const) {
    if (typeof x[key] !== 'boolean') return `${key} がbooleanではありません`
  }
  return null
}

function validateEmbeddedCustomAudioAsset(x: unknown): string | null {
  if (!isObj(x)) return 'オブジェクトではありません'
  if (typeof x.soundId !== 'string' || !x.soundId || x.soundId.length > 1024) return 'soundId が不正です'
  if (typeof x.fileName !== 'string' || !x.fileName || x.fileName.length > 1024) return 'fileName が不正です'
  if (!['audio/wav', 'audio/ogg', 'audio/mpeg', 'application/octet-stream'].includes(x.mimeType as string)) {
    return 'mimeType が不正です'
  }
  if (!isIntegerInRange(x.byteLength, 1, MAX_EMBEDDED_CUSTOM_AUDIO_BYTES)) {
    return 'byteLength が範囲外です'
  }
  if (typeof x.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(x.fingerprint)) {
    return 'fingerprint が不正です'
  }
  if (typeof x.dataBase64 !== 'string' || !hasValidBase64Shape(x.dataBase64, x.byteLength as number)) {
    return 'dataBase64 が不正です'
  }
  if (!isFiniteNumber(x.pitch) || x.pitch < 0.01 || x.pitch > 100) return 'pitch が範囲外です'
  if (x.volume !== undefined && (!isFiniteNumber(x.volume) || x.volume < 0 || x.volume > 1)) {
    return 'volume が範囲外です'
  }
  if (x.weight !== undefined || x.stream !== undefined || x.preload !== undefined
    || x.attenuationDistance !== undefined) {
    if (x.weight !== undefined && !isIntegerInRange(x.weight, 1, 2_147_483_647)) return 'weight が範囲外です'
    if (x.stream !== undefined && typeof x.stream !== 'boolean') return 'stream がbooleanではありません'
    if (x.preload !== undefined && typeof x.preload !== 'boolean') return 'preload がbooleanではありません'
    if (x.attenuationDistance !== undefined && (
      !isFiniteNumber(x.attenuationDistance)
      || x.attenuationDistance < 0
      || x.attenuationDistance > 1_000_000
    )) return 'attenuationDistance が範囲外です'
  }
  return null
}

function validateSettings(x: unknown, lengthTicks: number, requireMaxLoopCount: boolean): string | null {
  if (!isObj(x)) return 'settings がオブジェクトではありません'
  if (!isFiniteNumber(x.bpm) || x.bpm < 20 || x.bpm > 300) return 'bpm が範囲外です'
  if (x.panLaw !== undefined && x.panLaw !== 'cascade' && x.panLaw !== 'nbs-average') {
    return 'panLaw が不正です'
  }
  if (!isObj(x.timeSignature)) return 'timeSignature が不正です'
  if (!Number.isInteger(x.timeSignature.numerator) || (x.timeSignature.numerator as number) < 1 || (x.timeSignature.numerator as number) > 16) {
    return '拍子の分子が不正です'
  }
  if (![2, 4, 8, 16].includes(x.timeSignature.denominator as number)) return '拍子の分母が不正です'
  if (!['ticks', 'seconds', 'bars'].includes(x.timeDisplay as string)) return 'timeDisplay が不正です'
  if (!isObj(x.snap) || !['off', 'tick', 'beat'].includes(x.snap.mode as string)) return 'snap が不正です'
  if (![1, 2, 5, 10, 20].includes(x.snap.tickStep as number)) return 'tickStep が不正です'
  if (![1, 2, 4, 8, 16].includes(x.snap.beatDivision as number)) return 'beatDivision が不正です'
  if (!isObj(x.loop) || typeof x.loop.enabled !== 'boolean') return 'loop が不正です'
  if (
    !Number.isInteger(x.loop.startTick) || !Number.isInteger(x.loop.endTick)
    || (x.loop.startTick as number) < 0 || (x.loop.endTick as number) <= (x.loop.startTick as number)
    || (x.loop.endTick as number) > lengthTicks
  ) return 'loop範囲が不正です'
  if (requireMaxLoopCount && x.loop.maxLoopCount === undefined) return 'maxLoopCount がありません'
  if (x.loop.maxLoopCount !== undefined && !isIntegerInRange(x.loop.maxLoopCount, 0, MAX_LOOP_COUNT)) {
    return `maxLoopCount が 0..${MAX_LOOP_COUNT} の範囲外です`
  }
  if (typeof x.metronomeEnabled !== 'boolean') return 'metronomeEnabled が不正です'
  if (!isFiniteNumber(x.metronomeVolume) || x.metronomeVolume < 0 || x.metronomeVolume > 1) {
    return 'metronomeVolume が範囲外です'
  }
  return null
}

function normalizeMarker(marker: Marker): Marker {
  if (marker.action?.type === 'sound-stop') {
    const action: SoundStopAction = marker.action.scope === 'track-range'
      ? {
          type: 'sound-stop',
          scope: 'track-range',
          startTrack: Math.max(1, Math.min(MAX_SOUND_STOP_TRACK, Math.trunc(marker.action.startTrack ?? 1))),
          endTrack: Math.max(
            Math.max(1, Math.min(MAX_SOUND_STOP_TRACK, Math.trunc(marker.action.startTrack ?? 1))),
            Math.min(MAX_SOUND_STOP_TRACK, Math.trunc(marker.action.endTrack ?? marker.action.startTrack ?? 1)),
          ),
        }
      : { type: 'sound-stop', scope: 'all' }
    return {
      ...marker,
      soundId: '',
      variantIndex: -1,
      volume: 1,
      pitch: 1,
      pan: 0,
      gateTicks: undefined,
      duration: undefined,
      retriggerInterval: undefined,
      laneY: marker.laneY === undefined ? undefined : snapLaneY(marker.laneY),
      volumeCurve: undefined,
      pitchCurve: undefined,
      action,
    }
  }
  const duration = marker.duration && marker.duration > 0
    ? marker.duration
    : SINGLE_SHOT_CURVE_PREVIEW_TICKS
  const gateTicks = Number.isFinite(marker.gateTicks) ? Math.trunc(marker.gateTicks ?? 0) : 0
  return {
    ...marker,
    gateTicks: gateTicks > 0 ? Math.min(MAX_GATE_TICKS, gateTicks) : undefined,
    pan: Math.max(-1, Math.min(1, marker.pan ?? 0)),
    laneY: marker.laneY === undefined ? undefined : snapLaneY(marker.laneY),
    volumeCurve: constrainCurveHandles(marker.volumeCurve, duration),
    pitchCurve: constrainCurveHandles(marker.pitchCurve, duration),
  }
}

export function serialize(state: TimelineState): string {
  const referenceAudio = (state.referenceAudio ?? []).map(track => ({ ...track, sourcePath: '' }))
  const customAudio = state.customAudio ?? []
  const customInstruments = deriveProjectCustomInstruments(state)
  const customInstrumentError = validateProjectCustomInstruments(customInstruments)
  if (customInstrumentError) throw new Error(customInstrumentError)
  const lengthTicks = getTimelineLengthTicks(
    state.markers,
    state.lengthTicks,
    state.settings,
    referenceAudio,
    state.tempoMap ?? [],
  )
  const tempoMap = normalizeTempoMap(state.tempoMap, state.settings, lengthTicks - 1)
  const initialTempo = tempoMap[0]
  const file: TimelineFile = {
    ...state,
    lengthTicks,
    settings: {
      ...state.settings,
      bpm: initialTempo.bpm,
      timeSignature: { ...initialTempo.meter! },
      panLaw: state.settings.panLaw ?? 'cascade',
      loop: {
        ...state.settings.loop,
        maxLoopCount: Math.max(0, Math.min(MAX_LOOP_COUNT, Math.trunc(state.settings.loop.maxLoopCount ?? 0))),
      },
    },
    markers: state.markers.map(normalizeMarker),
    referenceAudio,
    customAudio,
    customInstruments,
    tempoMap,
    metadata: state.metadata === undefined && state.source?.format === 'nbs'
      ? metadataFromNbsSource(state.source)
      : normalizeSongMetadata(state.metadata),
    format: 'knead-project',
    version: 10,
  }
  return JSON.stringify(file, null, 2)
}

function migrateV1(raw: LegacyFile): TimelineState {
  const track = createDefaultTrack(uuidv4(), 0)
  const markers = raw.markers.map(({ trackY, ...marker }) => {
    return normalizeMarker({
      ...marker,
      gateTicks: undefined,
      trackId: track.id,
      laneY: typeof trackY === 'number'
        ? snapLaneY(trackY / 320)
        : undefined,
    })
  })
  return {
    projectId: uuidv4(),
    randomSeed: Math.floor(Math.random() * 0x1_0000_0000),
    targetVersion: raw.targetVersion,
    lengthTicks: getTimelineLengthTicks(markers, raw.lengthTicks, DEFAULT_SETTINGS),
    settings: structuredClone(DEFAULT_SETTINGS),
    master: { ...DEFAULT_MASTER },
    tracks: [track],
    markers,
    referenceAudio: [],
    customAudio: [],
    customInstruments: [],
    tempoMap: normalizeTempoMap([], DEFAULT_SETTINGS),
    metadata: { ...DEFAULT_SONG_METADATA },
  }
}

export function parse(json: string): ParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  }
  catch (error) {
    return { ok: false, error: `JSON パース失敗: ${(error as Error).message}` }
  }
  if (!isObj(raw) || raw.format !== 'knead-project') {
    return { ok: false, error: `format が 'knead-project' ではありません` }
  }
  if (raw.version !== 1 && raw.version !== 2 && raw.version !== 3
    && raw.version !== 4 && raw.version !== 5 && raw.version !== 6 && raw.version !== 7
    && raw.version !== 8 && raw.version !== 9 && raw.version !== 10) {
    return { ok: false, error: `version ${JSON.stringify(raw.version)} は未対応です（対応: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10）` }
  }
  if (typeof raw.targetVersion !== 'string') return { ok: false, error: 'targetVersion が不正です' }
  if (!Number.isInteger(raw.lengthTicks) || (raw.lengthTicks as number) < 1) {
    return { ok: false, error: 'lengthTicks が不正です' }
  }
  if (!Array.isArray(raw.markers)) return { ok: false, error: 'markers が配列ではありません' }
  if (raw.markers.length > MAX_TIMELINE_MARKERS) {
    return { ok: false, error: `markers が ${MAX_TIMELINE_MARKERS} 件の上限を超えています` }
  }

  const ids = new Set<string>()
  for (let i = 0; i < raw.markers.length; i++) {
    const error = validateMarker(
      raw.markers[i],
      raw.lengthTicks as number,
      raw.version !== 1,
      raw.version >= 9,
    )
    if (error) return { ok: false, error: `markers[${i}]: ${error}` }
    const id = (raw.markers[i] as Record<string, unknown>).id as string
    if (ids.has(id)) return { ok: false, error: `markers[${i}]: id が重複しています` }
    ids.add(id)
  }

  if (raw.version === 1) {
    return {
      ok: true,
      state: migrateV1(raw as unknown as LegacyFile),
      warnings: ['version 1プロジェクトを1トラックのversion 10へ変換しました（ゲート未指定は自然減衰）'],
    }
  }

  if (typeof raw.projectId !== 'string' || !raw.projectId) return { ok: false, error: 'projectId が不正です' }
  if (!Number.isInteger(raw.randomSeed) || (raw.randomSeed as number) < 0) return { ok: false, error: 'randomSeed が不正です' }
  if (!Array.isArray(raw.tracks) || raw.tracks.length === 0) return { ok: false, error: 'tracks が空です' }
  const trackIds = new Set<string>()
  for (let i = 0; i < raw.tracks.length; i++) {
    const error = validateTrack(raw.tracks[i])
    if (error) return { ok: false, error: `tracks[${i}]: ${error}` }
    const id = (raw.tracks[i] as Record<string, unknown>).id as string
    if (trackIds.has(id)) return { ok: false, error: `tracks[${i}]: id が重複しています` }
    trackIds.add(id)
  }
  for (let i = 0; i < raw.markers.length; i++) {
    const marker = raw.markers[i] as Record<string, unknown>
    if (!trackIds.has(marker.trackId as string)) {
      return { ok: false, error: `markers[${i}]: 存在しないtrackIdです` }
    }
  }
  const rawReferenceAudio = raw.referenceAudio === undefined ? [] : raw.referenceAudio
  if (!Array.isArray(rawReferenceAudio) || rawReferenceAudio.length > MAX_REFERENCE_AUDIO_TRACKS) {
    return { ok: false, error: 'referenceAudio が不正、またはトラック数上限を超えています' }
  }
  const referenceIds = new Set<string>()
  let referenceBytes = 0
  for (let i = 0; i < rawReferenceAudio.length; i++) {
    const error = validateReferenceAudioTrack(rawReferenceAudio[i], raw.lengthTicks as number)
    if (error) return { ok: false, error: `referenceAudio[${i}]: ${error}` }
    const reference = rawReferenceAudio[i] as unknown as ReferenceAudioTrack
    if (referenceIds.has(reference.id) || trackIds.has(reference.id)) {
      return { ok: false, error: `referenceAudio[${i}]: id が重複しています` }
    }
    referenceIds.add(reference.id)
    referenceBytes += reference.byteLength
    if (referenceBytes > MAX_REFERENCE_AUDIO_PROJECT_BYTES) {
      return { ok: false, error: 'referenceAudio の合計容量上限を超えています' }
    }
  }
  const rawCustomAudio = raw.customAudio === undefined ? [] : raw.customAudio
  if (!Array.isArray(rawCustomAudio) || rawCustomAudio.length > MAX_EMBEDDED_CUSTOM_AUDIO_ASSETS) {
    return { ok: false, error: 'customAudio が不正、またはアセット数上限を超えています' }
  }
  const customKeys = new Set<string>()
  let customBytes = 0
  for (let i = 0; i < rawCustomAudio.length; i++) {
    const error = validateEmbeddedCustomAudioAsset(rawCustomAudio[i])
    if (error) return { ok: false, error: `customAudio[${i}]: ${error}` }
    const asset = rawCustomAudio[i] as unknown as EmbeddedCustomAudioAsset
    const key = `${asset.soundId}\0${asset.fingerprint}`
    if (customKeys.has(key)) {
      return { ok: false, error: `customAudio[${i}]: soundIdとfingerprintが重複しています` }
    }
    customKeys.add(key)
    customBytes += asset.byteLength
    if (customBytes > MAX_EMBEDDED_CUSTOM_AUDIO_PROJECT_BYTES) {
      return { ok: false, error: 'customAudio の合計容量上限を超えています' }
    }
  }
  if (referenceBytes + customBytes > MAX_EMBEDDED_CUSTOM_AUDIO_PROJECT_BYTES) {
    return { ok: false, error: '埋め込み音声全体の合計容量上限を超えています' }
  }
  const rawCustomInstruments = raw.version >= 10 ? raw.customInstruments : undefined
  if (raw.version >= 10 && (
    !Array.isArray(rawCustomInstruments)
    || rawCustomInstruments.length > MAX_PROJECT_CUSTOM_INSTRUMENTS
  )) {
    return { ok: false, error: 'customInstruments が不正、または定義数上限を超えています' }
  }
  if (raw.version >= 10) {
    const error = validateProjectCustomInstruments(rawCustomInstruments as ProjectCustomInstrument[])
    if (error) return { ok: false, error: `customInstruments: ${error}` }
  }
  const settingsError = validateSettings(raw.settings, raw.lengthTicks as number, raw.version >= 8)
  if (settingsError) return { ok: false, error: settingsError }
  const fallbackSettings = raw.settings as unknown as TimelineSettings
  const rawTempoMap = raw.version >= 6 ? raw.tempoMap : []
  if (raw.version >= 6) {
    const tempoMapError = validateTempoMap(rawTempoMap, fallbackSettings, {
      maxTick: (raw.lengthTicks as number) - 1,
      requireTickZero: true,
      requireSortedUnique: true,
    })
    if (tempoMapError) return { ok: false, error: `tempoMap: ${tempoMapError}` }
  }
  const tempoMap = normalizeTempoMap(
    raw.version >= 6 ? rawTempoMap as TempoMapEvent[] : [],
    fallbackSettings,
    (raw.lengthTicks as number) - 1,
  )
  const initialTempo = tempoMap[0]
  const tempoMapWasNormalized = raw.version >= 6
    && JSON.stringify(rawTempoMap) !== JSON.stringify(tempoMap)
  const initialSettingsWereNormalized = fallbackSettings.bpm !== initialTempo.bpm
    || fallbackSettings.timeSignature.numerator !== initialTempo.meter!.numerator
    || fallbackSettings.timeSignature.denominator !== initialTempo.meter!.denominator
  if (!isObj(raw.master)) return { ok: false, error: 'master が不正です' }
  if (!isFiniteNumber(raw.master.gainDb) || raw.master.gainDb < -60 || raw.master.gainDb > 12) {
    return { ok: false, error: 'master.gainDb が範囲外です' }
  }
  if (typeof raw.master.limiterEnabled !== 'boolean') return { ok: false, error: 'limiterEnabled が不正です' }
  if (!isFiniteNumber(raw.master.limiterCeilingDb) || raw.master.limiterCeilingDb < -12 || raw.master.limiterCeilingDb > 0) {
    return { ok: false, error: 'limiterCeilingDb が範囲外です' }
  }
  if (raw.source !== undefined && !validateProjectSource(raw.source)) {
    return { ok: false, error: 'source が不正です' }
  }
  if (raw.version >= 8) {
    const metadataError = validateSongMetadata(raw.metadata)
    if (metadataError) return { ok: false, error: metadataError }
  }

  const sourceMarkers = raw.markers as unknown as Marker[]
  const markers = sourceMarkers.map(marker => normalizeMarker(
    (raw.version as number) >= 9 ? marker : { ...marker, gateTicks: undefined },
  ))
  const corrected = markers.some((marker, index) => (
    marker.volumeCurve !== sourceMarkers[index].volumeCurve
    || marker.pitchCurve !== sourceMarkers[index].pitchCurve
  ))
  const source = raw.source as unknown as TimelineProjectSource | undefined
  const migratedNbsSource = source?.format === 'nbs' ? source : undefined
  const stateWithoutCustomInstruments: TimelineState = {
    projectId: raw.projectId,
    randomSeed: raw.randomSeed as number,
    targetVersion: raw.targetVersion,
    lengthTicks: getTimelineLengthTicks(
      markers,
      raw.lengthTicks as number,
      raw.settings as unknown as TimelineSettings,
      rawReferenceAudio as unknown as ReferenceAudioTrack[],
      tempoMap,
    ),
    settings: {
      ...(raw.settings as unknown as TimelineSettings),
      bpm: initialTempo.bpm,
      timeSignature: { ...initialTempo.meter! },
      panLaw: (raw.settings as unknown as TimelineSettings).panLaw ?? 'cascade',
      loop: {
        ...(raw.settings as unknown as TimelineSettings).loop,
        maxLoopCount: raw.version >= 8
          ? (raw.settings as unknown as TimelineSettings).loop.maxLoopCount ?? 0
          : migratedNbsSource?.maxLoopCount ?? 0,
      },
    },
    master: raw.master as unknown as TimelineState['master'],
    tracks: raw.tracks as unknown as Track[],
    markers,
    referenceAudio: rawReferenceAudio as unknown as ReferenceAudioTrack[],
    customAudio: rawCustomAudio as unknown as EmbeddedCustomAudioAsset[],
    tempoMap,
    metadata: raw.version >= 8
      ? raw.metadata as unknown as SongMetadata
      : migratedNbsSource ? metadataFromNbsSource(migratedNbsSource) : { ...DEFAULT_SONG_METADATA },
    ...(source === undefined ? {} : { source }),
  }
  const state: TimelineState = {
    ...stateWithoutCustomInstruments,
    customInstruments: raw.version >= 10
      ? (rawCustomInstruments as unknown as ProjectCustomInstrument[]).map(instrument => ({ ...instrument }))
      : deriveProjectCustomInstruments(stateWithoutCustomInstruments),
  }
  return {
    ok: true,
    state,
    warnings: [
      ...(raw.version < 6 ? [`version ${raw.version}プロジェクトへtempo mapを追加しました`] : []),
      ...(raw.version < 7 ? [`version ${raw.version}プロジェクトをSound Stopper対応のversion 7へ移行しました`] : []),
      ...(raw.version < 8 ? [`version ${raw.version}プロジェクトへ曲メタデータと有限ループ設定を追加しました`] : []),
      ...(raw.version < 9 ? [`version ${raw.version}プロジェクトをゲート対応のversion 9へ移行しました（既存音は自然減衰）`] : []),
      ...(raw.version < 10 ? [`version ${raw.version}プロジェクトへカスタム楽器定義を追加しversion 10へ移行しました`] : []),
      ...(tempoMapWasNormalized ? ['tempoMapを正規形へ補正しました'] : []),
      ...(initialSettingsWereNormalized ? ['settingsのテンポと拍子をtempoMap先頭へ同期しました'] : []),
      ...(corrected ? ['カーブハンドルを有効な範囲へ補正しました'] : []),
    ],
  }
}

export function _selfCheckTimelineIO(): void {
  const v1 = JSON.stringify({
    format: 'knead-project',
    version: 1,
    targetVersion: '1.21.4',
    lengthTicks: 100,
    markers: [{
      id: 'a', tick: 10, soundId: 'block.note_block.pling',
      variantIndex: -1, volume: 1, pitch: 1, trackY: 40,
    }],
  })
  const migrated = parse(v1)
  if (!migrated.ok || migrated.state.tracks.length !== 1) throw new Error('v1移行失敗')
  if (migrated.state.markers[0].trackId !== migrated.state.tracks[0].id) throw new Error('trackId移行失敗')
  const roundTrip = parse(serialize(migrated.state))
  if (!roundTrip.ok || roundTrip.state.markers.length !== 1) throw new Error('v10往復失敗')
  if (parse('{}').ok) throw new Error('不正formatを受理')
  if (parse(JSON.stringify({ format: 'knead-project', version: 99 })).ok) throw new Error('未知versionを受理')
  if (roundTrip.ok && roundTrip.state.lengthTicks < DEFAULT_TIMELINE_LENGTH_TICKS) throw new Error('長さが不正')
  console.log('timelineIO self-check OK')
}
