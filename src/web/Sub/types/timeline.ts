// Minecraft の実行時刻は常に整数 tick（1 tick = 1/20 秒）を正とする。
export type Tick = number

export type TimeDisplay = 'ticks' | 'seconds' | 'bars'
export type SnapMode = 'off' | 'tick' | 'beat'
export type TrackColor =
  | 'blue' | 'cyan' | 'green' | 'yellow'
  | 'orange' | 'red' | 'pink' | 'purple'

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

export interface Marker {
  id: string
  trackId: string
  tick: Tick
  soundId: string
  variantIndex: number
  volume: number
  pitch: number
  duration?: Tick
  retriggerInterval?: Tick
  laneY?: number
  volumeCurve?: Curve
  pitchCurve?: Curve
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
}

export interface TimelineSettings {
  bpm: number
  timeSignature: {
    numerator: number
    denominator: 2 | 4 | 8 | 16
  }
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
  }
  metronomeEnabled: boolean
  metronomeVolume: number
}

export interface MasterBus {
  gainDb: number
  limiterEnabled: boolean
  limiterCeilingDb: number
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
}

export interface TimelineFile extends TimelineState {
  format: 'knead-project'
  version: 2
}

export const DEFAULT_TIMELINE_LENGTH_TICKS = 200
export const DEFAULT_RETRIGGER_INTERVAL = 1
export const SINGLE_SHOT_CURVE_PREVIEW_TICKS = 20
export const TRACK_HEIGHT = 96
export const TRACK_HEIGHT_COLLAPSED = 36
export const TRACK_HEADER_WIDTH = 248
export const TIMELINE_MARKER_HEIGHT = 16
export const TRACK_COLORS: TrackColor[] = [
  'blue', 'cyan', 'green', 'yellow', 'orange', 'red', 'pink', 'purple',
]

export const DEFAULT_SETTINGS: TimelineSettings = {
  bpm: 120,
  timeSignature: { numerator: 4, denominator: 4 },
  timeDisplay: 'ticks',
  snap: { mode: 'tick', tickStep: 1, beatDivision: 4 },
  loop: { enabled: false, startTick: 0, endTick: 80 },
  metronomeEnabled: false,
  metronomeVolume: 0.35,
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
): number {
  return Math.max(currentLength, getRequiredTimelineLengthTicks(markers, settings))
}

export function isTrackAudible(track: Track, tracks: Track[]): boolean {
  const hasSolo = tracks.some(item => item.solo)
  return !track.muted && (!hasSolo || track.solo)
}
