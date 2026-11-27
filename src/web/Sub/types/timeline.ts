// Minecraft の実行時刻は常に整数 tick（1 tick = 1/20 秒）を正とする。
export type Tick = number

/** Maximum authored MIDI-style note gate (10,000,000 ticks / about 5.8 days). */
export const MAX_GATE_TICKS = 10_000_000
/** Shared project/import ceiling; checked before per-marker validation. */
export const MAX_TIMELINE_MARKERS = 250_000

/**
 * Safe DAW playback-pitch domain (-108 through +96 semitones).
 *
 * The power-of-two limits cover the practical NBS 0..87 note/source-key
 * combinations while keeping zero, subnormal rates, and unbounded tails out
 * of persisted projects. Minecraft authoring/export remains a narrower
 * 0.5..2 compatibility domain.
 */
export const MIN_MARKER_PITCH = 1 / 512
export const MAX_MARKER_PITCH = 256

export type TimeDisplay = 'ticks' | 'seconds' | 'bars'
export type SnapMode = 'off' | 'tick' | 'beat'
export type PanLaw = 'cascade' | 'nbs-average'
export type TimeSignatureDenominator = 2 | 4 | 8 | 16
export type TrackColor =
  | 'blue' | 'cyan' | 'green' | 'yellow'
  | 'orange' | 'red' | 'pink' | 'purple'

export type ReferenceAudioMimeType = 'audio/wav' | 'audio/ogg'
export type EmbeddedCustomAudioMimeType = ReferenceAudioMimeType | 'audio/mpeg' | 'application/octet-stream'

/** A portable, content-addressed one-shot used by timeline marker soundIds. */
export interface EmbeddedCustomAudioAsset {
  soundId: string
  /** NBS Sounds-relative file name; informational outside NBS bundle export. */
  fileName: string
  mimeType: EmbeddedCustomAudioMimeType
  byteLength: number
  /** Lowercase SHA-256 of the decoded bytes. */
  fingerprint: string
  dataBase64: string
  /** Base playback-rate multiplier, normally 1 for NBS custom instruments. */
  pitch: number
  /** Optional Minecraft resource-pack variant metadata. */
  volume?: number
  weight?: number
  stream?: boolean
  preload?: boolean
  attenuationDistance?: number
}

export type ProjectCustomInstrumentKind = 'audio' | 'sound-stopper' | 'tempo-changer'

/**
 * A project-authored instrument definition independent from imported NBS
 * provenance. `soundId` is the stable playback identity used by markers and
 * embedded variants; NBS-only fields remain editable without overloading it.
 */
export interface ProjectCustomInstrument {
  id: string
  kind: ProjectCustomInstrumentKind
  /** Original NBS custom-definition index; provenance only, never a file capability. */
  sourceIndex?: number
  /** Empty only for protected functional instruments. */
  soundId: string
  name: string
  /** OpenNBS Sounds-relative file path. Empty only for functional instruments. */
  file: string
  /** OpenNBS source key (0..87). */
  key: number
  pressKey: boolean
  /** Base playback-rate multiplier for newly attached and existing variants. */
  defaultPitch: number
}

/**
 * A portable reference/master recording embedded in the Knead project.
 *
 * Keeping the original bytes (instead of only an absolute file path) makes a
 * project reopenable after it is moved to another machine. `sourcePath` is
 * informational and is never used as an implicit filesystem read capability.
 */
export interface ReferenceAudioTrack {
  id: string
  name: string
  color: TrackColor
  fileName: string
  sourcePath: string
  mimeType: ReferenceAudioMimeType
  byteLength: number
  fingerprint: string
  dataBase64: string
  durationSeconds: number
  offsetTicks: Tick
  gainDb: number
  pan: number
  muted: boolean
  solo: boolean
  locked: boolean
  collapsed: boolean
}

/**
 * Lossless source-format data lives behind discriminated `source` objects so
 * ordinary timeline features do not need to understand NBS internals.  These
 * types intentionally mirror the values stored in an NBS file, before timing,
 * gain, panning, or pitch are converted into Knead's canonical model.
 */
export interface NbsCustomInstrumentSource {
  name: string
  file: string
  key: number
  pressKey: boolean
}

export interface NbsProjectSource {
  format: 'nbs'
  sourceVersion: number
  /** Initial conversion multiplier; Tempo Changer notes may alter later ticks. */
  tickScale: number
  vanillaInstrumentCount: number
  /** Inclusive index of the final source tick. */
  songLength: number
  layerCount: number
  name: string
  author: string
  originalAuthor: string
  description: string
  tempo: number
  autoSave: boolean
  autoSaveDuration: number
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
  customInstruments: readonly NbsCustomInstrumentSource[]
  /** Raw functional notes omitted from ordinary markers and represented by tempoMap. */
  tempoChangerNotes?: readonly NbsNoteSource[]
}

export interface NbsLayerSource {
  format: 'nbs'
  /** Zero-based layer index in the source file. */
  index: number
  name: string
  locked: boolean
  volume: number
  panning: number
}

export interface NbsNoteSource {
  format: 'nbs'
  tick: number
  layer: number
  instrument: number
  key: number
  velocity: number
  panning: number
  /** NBS fine pitch in cents. */
  pitch: number
}

export interface MidiTempoSource {
  tick: number
  microsecondsPerQuarter: number
  trackIndex: number
  order: number
}

export interface MidiTimeSignatureSource {
  tick: number
  numerator: number
  denominator: number
  clocksPerMetronome: number
  thirtySecondsPerQuarter: number
  trackIndex: number
  order: number
}

export interface MidiProgramChangeSource {
  tick: number
  channel: number
  program: number
  order: number
}

export interface MidiPitchBendSource {
  tick: number
  channel: number
  value: number
  order: number
}

export interface MidiProjectSource {
  format: 'midi'
  sourceFormat: 0 | 1
  ticksPerQuarter: number
  fingerprint: string
  tempoEvents: readonly MidiTempoSource[]
  timeSignatureEvents: readonly MidiTimeSignatureSource[]
}

export interface MidiTrackSource {
  format: 'midi'
  index: number
  name: string
  instrumentName: string
  lastTick: number
  channels: readonly number[]
  programChanges: readonly MidiProgramChangeSource[]
  pitchBends: readonly MidiPitchBendSource[]
}

export interface MidiNoteSource {
  format: 'midi'
  index: number
  trackIndex: number
  channel: number
  note: number
  velocity: number
  releaseVelocity: number
  startTick: number
  endTick: number
  program: number
  startPitchBend: number
  startOrder: number
  endOrder: number
}

// Future source formats can extend these unions without changing timeline
// consumers: code that cares about provenance narrows on `format`.
export type TimelineProjectSource = NbsProjectSource | MidiProjectSource
export type TimelineTrackSource = NbsLayerSource | MidiTrackSource
export type TimelineMarkerSource = NbsNoteSource | MidiNoteSource

export interface Keyframe {
  tick: Tick
  value: number
  interpolation: 'linear' | 'bezier'
  handleL?: { dt: number, dv: number }
  handleR?: { dt: number, dv: number }
}

export interface Curve {
  keyframes: Keyframe[]
}

/**
 * A first-class transport event matching OpenNBS' functional Sound Stopper.
 * Track numbers are one-based positions in the current track order, just like
 * NBS layer numbers.  Keeping the range positional makes reordering behave the
 * same way in both editors and permits lossless NBS round-trips.
 */
export interface SoundStopAction {
  type: 'sound-stop'
  scope: 'all' | 'track-range'
  startTrack?: number
  endTrack?: number
}

export type MarkerAction = SoundStopAction

export interface Marker {
  id: string
  trackId: string
  tick: Tick
  soundId: string
  variantIndex: number
  volume: number
  pitch: number
  /** Per-marker stereo position. Missing values from older v2 files mean center. */
  pan?: number
  /**
   * Wall-clock voice cutoff in 20 TPS ticks. Missing/zero lets the sample play
   * its natural tail. This is deliberately independent from retrigger span.
   */
  gateTicks?: Tick
  duration?: Tick
  retriggerInterval?: Tick
  laneY?: number
  volumeCurve?: Curve
  pitchCurve?: Curve
  /** Missing means the ordinary play-sound action used by project v1-v6. */
  action?: MarkerAction
  source?: TimelineMarkerSource
}

export type SoundStopMarker = Marker & { action: SoundStopAction }

export function isSoundStopMarker(marker: Marker): marker is SoundStopMarker {
  return marker.action?.type === 'sound-stop'
}

export interface Track {
  id: string
  name: string
  color: TrackColor
  gainDb: number
  pan: number
  muted: boolean
  solo: boolean
  locked: boolean
  collapsed: boolean
  source?: TimelineTrackSource
}

export interface TimelineMeter {
  numerator: number
  denominator: TimeSignatureDenominator
}

/**
 * A musical-grid change anchored to Knead's immutable 20 TPS timeline.
 * BPM changes only beat/bar placement; they never move audio or markers in real time.
 */
export interface TempoMapEvent {
  tick: Tick
  bpm: number
  /** Missing meters inherit the previous event (or the project fallback at tick zero). */
  meter?: TimelineMeter
}

export interface TimelineSettings {
  bpm: number
  /** Stereo routing compatibility. Missing values from older projects mean cascade. */
  panLaw?: PanLaw
  timeSignature: TimelineMeter
  timeDisplay: TimeDisplay
  snap: {
    mode: SnapMode
    tickStep: 1 | 2 | 5 | 10 | 20
    beatDivision: 1 | 2 | 4 | 8 | 16
  }
  loop: {
    enabled: boolean
    startTick: Tick
    endTick: Tick
    /** Number of repeats after the first pass. 0 matches NBS infinite looping. */
    maxLoopCount?: number
  }
  metronomeEnabled: boolean
  metronomeVolume: number
}

export interface MasterBus {
  gainDb: number
  limiterEnabled: boolean
  limiterCeilingDb: number
}

/**
 * Format-neutral song credits plus the authoring counters represented by NBS.
 *
 * The counters are informational in Knead. Keeping them outside `source`
 * means a new project can carry credits and an imported project can edit them
 * without discarding the raw source provenance used for lossless round-trips.
 */
export interface SongMetadata {
  title: string
  author: string
  originalAuthor: string
  description: string
  sourceFile: string
  autoSave: boolean
  autoSaveDuration: number
  minutesSpent: number
  leftClicks: number
  rightClicks: number
  blocksAdded: number
  blocksRemoved: number
}

export interface TimelineState {
  projectId: string
  randomSeed: number
  targetVersion: string
  lengthTicks: Tick
  settings: TimelineSettings
  master: MasterBus
  tracks: Track[]
  markers: Marker[]
  /** Introduced in project v4; older in-memory states may omit it. */
  referenceAudio?: ReferenceAudioTrack[]
  /** Introduced in project v5; project-scoped sounds survive ordinary .kp saves. */
  customAudio?: EmbeddedCustomAudioAsset[]
  /** Introduced in project v10; ordered NBS-compatible authored definitions. */
  customInstruments?: ProjectCustomInstrument[]
  /** Introduced in project v6; missing maps inherit settings.bpm/timeSignature. */
  tempoMap?: TempoMapEvent[]
  /** Introduced in project v8; callers constructing legacy states may omit it. */
  metadata?: SongMetadata
  source?: TimelineProjectSource
}

export interface TimelineFile extends TimelineState {
  format: 'knead-project'
  version: 10
  customInstruments: ProjectCustomInstrument[]
  tempoMap: TempoMapEvent[]
  metadata: SongMetadata
}

export const DEFAULT_TIMELINE_LENGTH_TICKS = 200
export const DEFAULT_RETRIGGER_INTERVAL = 1
export const SINGLE_SHOT_CURVE_PREVIEW_TICKS = 20
export const TRACK_HEIGHT = 96
export const TRACK_HEIGHT_COLLAPSED = 36
export const REFERENCE_AUDIO_TRACK_HEIGHT = TRACK_HEIGHT
export const REFERENCE_AUDIO_TRACK_HEIGHT_COLLAPSED = 36
export const MAX_REFERENCE_AUDIO_TRACKS = 16
export const MAX_REFERENCE_AUDIO_BYTES = 32 * 1024 * 1024
export const MAX_REFERENCE_AUDIO_PROJECT_BYTES = 64 * 1024 * 1024
export const MAX_REFERENCE_AUDIO_DURATION_SECONDS = 6 * 60 * 60
export const MAX_EMBEDDED_CUSTOM_AUDIO_ASSETS = 256
export const MAX_EMBEDDED_CUSTOM_AUDIO_BYTES = 32 * 1024 * 1024
export const MAX_EMBEDDED_CUSTOM_AUDIO_PROJECT_BYTES = 96 * 1024 * 1024
/** NBS stores the custom-instrument definition count in one unsigned byte. */
export const MAX_PROJECT_CUSTOM_INSTRUMENTS = 0xff
export const MAX_CUSTOM_INSTRUMENT_TEXT_LENGTH = 1024 * 1024
export const MAX_TEMPO_MAP_EVENTS = 4_096
export const MAX_SOUND_STOP_TRACK = 0x7fff
/** Mirrors the NBS byte field. 0 means infinite. */
export const MAX_LOOP_COUNT = 0xff
/** NBS stores each header string behind a signed 32-bit byte length. */
export const MAX_SONG_METADATA_FIELD_LENGTH = 1024 * 1024
export const MAX_SONG_METADATA_TOTAL_LENGTH = 4 * 1024 * 1024
export const MAX_SONG_METADATA_STAT = 0x7fff_ffff
export const TRACK_HEADER_WIDTH = 248
export const TIMELINE_MARKER_HEIGHT = 16
export const TIMELINE_LEADING_PADDING_PX = TIMELINE_MARKER_HEIGHT / 2 + 4
export const TIMELINE_LANE_STEP_PX = TIMELINE_MARKER_HEIGHT / 2
export const TRACK_COLORS: TrackColor[] = [
  'blue', 'cyan', 'green', 'yellow', 'orange', 'red', 'pink', 'purple',
]

export function snapMarkerCenterY(centerY: number, trackHeight = TRACK_HEIGHT): number {
  const half = TIMELINE_MARKER_HEIGHT / 2
  const min = half
  const max = Math.max(min, trackHeight - half)
  const clamped = Math.max(min, Math.min(max, centerY))
  const snapped = min + Math.round((clamped - min) / TIMELINE_LANE_STEP_PX) * TIMELINE_LANE_STEP_PX
  return Math.max(min, Math.min(max, snapped))
}

export function laneYToMarkerCenterY(laneY: number, trackHeight = TRACK_HEIGHT): number {
  const half = TIMELINE_MARKER_HEIGHT / 2
  const span = Math.max(1, trackHeight - TIMELINE_MARKER_HEIGHT)
  const clamped = Math.max(0, Math.min(1, laneY))
  return snapMarkerCenterY(half + clamped * span, trackHeight)
}

export function markerCenterYToLaneY(centerY: number, trackHeight = TRACK_HEIGHT): number {
  const half = TIMELINE_MARKER_HEIGHT / 2
  const span = Math.max(1, trackHeight - TIMELINE_MARKER_HEIGHT)
  return Math.max(0, Math.min(1, (snapMarkerCenterY(centerY, trackHeight) - half) / span))
}

export function snapLaneY(laneY: number): number {
  return markerCenterYToLaneY(laneYToMarkerCenterY(laneY))
}

export const DEFAULT_SETTINGS: TimelineSettings = {
  bpm: 120,
  panLaw: 'cascade',
  timeSignature: { numerator: 4, denominator: 4 },
  timeDisplay: 'ticks',
  snap: { mode: 'tick', tickStep: 1, beatDivision: 4 },
  loop: { enabled: false, startTick: 0, endTick: 80, maxLoopCount: 0 },
  metronomeEnabled: false,
  metronomeVolume: 0.35,
}

export const DEFAULT_SONG_METADATA: SongMetadata = {
  title: '',
  author: '',
  originalAuthor: '',
  description: '',
  sourceFile: '',
  autoSave: false,
  autoSaveDuration: 10,
  minutesSpent: 0,
  leftClicks: 0,
  rightClicks: 0,
  blocksAdded: 0,
  blocksRemoved: 0,
}

export function createDefaultSongMetadata(): SongMetadata {
  return { ...DEFAULT_SONG_METADATA }
}

export const DEFAULT_MASTER: MasterBus = {
  gainDb: 0,
  limiterEnabled: true,
  limiterCeilingDb: -1,
}

export function createDefaultTrack(id: string, index = 0): Track {
  return {
    id,
    name: `Track ${index + 1}`,
    color: TRACK_COLORS[index % TRACK_COLORS.length],
    gainDb: 0,
    pan: 0,
    muted: false,
    solo: false,
    locked: false,
    collapsed: false,
  }
}

export function dbToGain(db: number): number {
  return db <= -60 ? 0 : 10 ** (db / 20)
}

export function ticksPerBeat(settings: Pick<TimelineSettings, 'bpm' | 'timeSignature'>): number {
  return (20 * 60 / settings.bpm) * (4 / settings.timeSignature.denominator)
}

export function ticksPerBar(settings: Pick<TimelineSettings, 'bpm' | 'timeSignature'>): number {
  return ticksPerBeat(settings) * settings.timeSignature.numerator
}

export function snapTick(tick: number, settings: TimelineSettings, bypass = false): Tick {
  const clamped = Math.max(0, tick)
  if (bypass || settings.snap.mode === 'off') return Math.round(clamped)
  const step = settings.snap.mode === 'tick'
    ? settings.snap.tickStep
    : ticksPerBeat(settings) * (4 / settings.snap.beatDivision)
  return Math.max(0, Math.round(Math.round(clamped / step) * step))
}

export function getRequiredTimelineLengthTicks(
  markers: ReadonlyArray<Pick<Marker, 'tick' | 'duration'>>,
  settings: Pick<TimelineSettings, 'bpm' | 'timeSignature'> = DEFAULT_SETTINGS,
): number {
  const lastMarkerEnd = markers.reduce((latest, marker) => (
    Math.max(latest, marker.tick + Math.max(0, marker.duration ?? 0))
  ), 0)
  if (lastMarkerEnd <= 0) return DEFAULT_TIMELINE_LENGTH_TICKS
  const bar = Math.max(1, ticksPerBar(settings))
  return Math.max(
    DEFAULT_TIMELINE_LENGTH_TICKS,
    Math.ceil(Math.ceil((lastMarkerEnd + bar) / bar) * bar),
  )
}

export function getTimelineLengthTicks(
  markers: ReadonlyArray<Pick<Marker, 'tick' | 'duration'>>,
  currentLength = DEFAULT_TIMELINE_LENGTH_TICKS,
  settings: Pick<TimelineSettings, 'bpm' | 'timeSignature'> = DEFAULT_SETTINGS,
  referenceAudio: ReadonlyArray<Pick<ReferenceAudioTrack, 'offsetTicks' | 'durationSeconds'>> = [],
  tempoMap: ReadonlyArray<Pick<TempoMapEvent, 'tick'>> = [],
): number {
  const referenceEndTick = referenceAudio.reduce((latest, track) => (
    Math.max(latest, track.offsetTicks + Math.ceil(track.durationSeconds / 0.05))
  ), 0)
  const tempoEndTick = tempoMap.reduce((latest, event) => Math.max(latest, event.tick + 1), 0)
  return Math.max(
    currentLength,
    referenceEndTick,
    tempoEndTick,
    getRequiredTimelineLengthTicks(markers, settings),
  )
}

export function isTrackAudible(track: Track, tracks: Track[]): boolean {
  const hasSolo = tracks.some(item => item.solo)
  return !track.muted && (!hasSolo || track.solo)
}
