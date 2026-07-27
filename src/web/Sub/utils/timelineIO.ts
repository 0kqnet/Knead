import { v4 as uuidv4 } from 'uuid'
import {
  DEFAULT_MASTER,
  DEFAULT_SETTINGS,
  DEFAULT_TIMELINE_LENGTH_TICKS,
  SINGLE_SHOT_CURVE_PREVIEW_TICKS,
  TRACK_COLORS,
  createDefaultTrack,
  getTimelineLengthTicks,
  snapLaneY,
  type Keyframe,
  type Marker,
  type TimelineFile,
  type TimelineSettings,
  type TimelineState,
  type Track,
} from '../types/timeline'
import { constrainCurveHandles } from './curveHandles'

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

function validateCurve(x: unknown, duration: number, min: number, max: number): string | null {
  if (!isObj(x) || !Array.isArray(x.keyframes) || x.keyframes.length === 0) {
    return 'keyframes が空、または配列ではありません'
  }
  let previous = -1
  for (let i = 0; i < x.keyframes.length; i++) {
    const keyframe = x.keyframes[i]
    if (!validateKeyframe(keyframe)) return `keyframes[${i}] の形式が不正です`
    if (keyframe.tick <= previous || keyframe.tick > duration) return `keyframes[${i}] のtickが不正です`
    if (keyframe.value < min || keyframe.value > max) return `keyframes[${i}] のvalueが範囲外です`
    previous = keyframe.tick
  }
  return null
}

function validateMarker(x: unknown, lengthTicks: number, requireTrack: boolean): string | null {
  if (!isObj(x)) return 'オブジェクトではありません'
  if (typeof x.id !== 'string' || !x.id) return 'id が空です'
  if (requireTrack && (typeof x.trackId !== 'string' || !x.trackId)) return 'trackId が空です'
  if (!Number.isInteger(x.tick) || (x.tick as number) < 0 || (x.tick as number) >= lengthTicks) {
    return 'tick がタイムライン範囲外です'
  }
  if (typeof x.soundId !== 'string') return 'soundId が文字列ではありません'
  if (!Number.isInteger(x.variantIndex) || (x.variantIndex as number) < -1) return 'variantIndex が不正です'
  if (!isFiniteNumber(x.volume) || x.volume < 0 || x.volume > 1) return 'volume が 0..1 の範囲外です'
  if (!isFiniteNumber(x.pitch) || x.pitch < 0.5 || x.pitch > 2) return 'pitch が 0.5..2 の範囲外です'
  if (x.duration !== undefined && (!Number.isInteger(x.duration) || (x.duration as number) < 0)) {
    return 'duration が不正です'
  }
  if (
    x.retriggerInterval !== undefined
    && (!Number.isInteger(x.retriggerInterval) || (x.retriggerInterval as number) <= 0)
  ) return 'retriggerInterval が不正です'
  if (x.laneY !== undefined && (!isFiniteNumber(x.laneY) || x.laneY < 0 || x.laneY > 1)) {
    return 'laneY が 0..1 の範囲外です'
  }
  const duration = isFiniteNumber(x.duration) && x.duration > 0
    ? x.duration
    : SINGLE_SHOT_CURVE_PREVIEW_TICKS
  if (x.volumeCurve !== undefined) {
    const error = validateCurve(x.volumeCurve, duration, 0, 1)
    if (error) return `volumeCurve: ${error}`
  }
  if (x.pitchCurve !== undefined) {
    const error = validateCurve(x.pitchCurve, duration, 0.5, 2)
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
  return null
}

function validateSettings(x: unknown, lengthTicks: number): string | null {
  if (!isObj(x)) return 'settings がオブジェクトではありません'
  if (!isFiniteNumber(x.bpm) || x.bpm < 20 || x.bpm > 300) return 'bpm が範囲外です'
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
  if (typeof x.metronomeEnabled !== 'boolean') return 'metronomeEnabled が不正です'
  if (!isFiniteNumber(x.metronomeVolume) || x.metronomeVolume < 0 || x.metronomeVolume > 1) {
    return 'metronomeVolume が範囲外です'
  }
  return null
}

function normalizeMarker(marker: Marker): Marker {
  const duration = marker.duration && marker.duration > 0
    ? marker.duration
    : SINGLE_SHOT_CURVE_PREVIEW_TICKS
  return {
    ...marker,
    laneY: marker.laneY === undefined ? undefined : snapLaneY(marker.laneY),
    volumeCurve: constrainCurveHandles(marker.volumeCurve, duration),
    pitchCurve: constrainCurveHandles(marker.pitchCurve, duration),
  }
}

export function serialize(state: TimelineState): string {
  const file: TimelineFile = {
    format: 'knead-project',
    version: 2,
    ...state,
    lengthTicks: getTimelineLengthTicks(state.markers, state.lengthTicks, state.settings),
    markers: state.markers.map(normalizeMarker),
  }
  return JSON.stringify(file, null, 2)
}

function migrateV1(raw: LegacyFile): TimelineState {
  const track = createDefaultTrack(uuidv4(), 0)
  const markers = raw.markers.map(({ trackY, ...marker }) => {
    return normalizeMarker({
      ...marker,
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
  if (raw.version !== 1 && raw.version !== 2) {
    return { ok: false, error: `version ${JSON.stringify(raw.version)} は未対応です（対応: 1, 2）` }
  }
  if (typeof raw.targetVersion !== 'string') return { ok: false, error: 'targetVersion が不正です' }
  if (!Number.isInteger(raw.lengthTicks) || (raw.lengthTicks as number) < 1) {
    return { ok: false, error: 'lengthTicks が不正です' }
  }
  if (!Array.isArray(raw.markers)) return { ok: false, error: 'markers が配列ではありません' }

  const ids = new Set<string>()
  for (let i = 0; i < raw.markers.length; i++) {
    const error = validateMarker(raw.markers[i], raw.lengthTicks as number, raw.version === 2)
    if (error) return { ok: false, error: `markers[${i}]: ${error}` }
    const id = (raw.markers[i] as Record<string, unknown>).id as string
    if (ids.has(id)) return { ok: false, error: `markers[${i}]: id が重複しています` }
    ids.add(id)
  }

  if (raw.version === 1) {
    return {
      ok: true,
      state: migrateV1(raw as unknown as LegacyFile),
      warnings: ['version 1プロジェクトを1トラックのversion 2へ変換しました'],
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
  const settingsError = validateSettings(raw.settings, raw.lengthTicks as number)
  if (settingsError) return { ok: false, error: settingsError }
  if (!isObj(raw.master)) return { ok: false, error: 'master が不正です' }
  if (!isFiniteNumber(raw.master.gainDb) || raw.master.gainDb < -60 || raw.master.gainDb > 12) {
    return { ok: false, error: 'master.gainDb が範囲外です' }
  }
  if (typeof raw.master.limiterEnabled !== 'boolean') return { ok: false, error: 'limiterEnabled が不正です' }
  if (!isFiniteNumber(raw.master.limiterCeilingDb) || raw.master.limiterCeilingDb < -12 || raw.master.limiterCeilingDb > 0) {
    return { ok: false, error: 'limiterCeilingDb が範囲外です' }
  }

  const sourceMarkers = raw.markers as unknown as Marker[]
  const markers = sourceMarkers.map(normalizeMarker)
  const corrected = markers.some((marker, index) => (
    marker.volumeCurve !== sourceMarkers[index].volumeCurve
    || marker.pitchCurve !== sourceMarkers[index].pitchCurve
  ))
  const state: TimelineState = {
    projectId: raw.projectId,
    randomSeed: raw.randomSeed as number,
    targetVersion: raw.targetVersion,
    lengthTicks: getTimelineLengthTicks(markers, raw.lengthTicks as number, raw.settings as unknown as TimelineSettings),
    settings: raw.settings as unknown as TimelineSettings,
    master: raw.master as unknown as TimelineState['master'],
    tracks: raw.tracks as unknown as Track[],
    markers,
  }
  return {
    ok: true,
    state,
    warnings: corrected ? ['カーブハンドルを有効な範囲へ補正しました'] : [],
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
  if (!roundTrip.ok || roundTrip.state.markers.length !== 1) throw new Error('v2往復失敗')
  if (parse('{}').ok) throw new Error('不正formatを受理')
  if (parse(JSON.stringify({ format: 'knead-project', version: 3 })).ok) throw new Error('未知versionを受理')
  if (roundTrip.ok && roundTrip.state.lengthTicks < DEFAULT_TIMELINE_LENGTH_TICKS) throw new Error('長さが不正')
  console.log('timelineIO self-check OK')
}
