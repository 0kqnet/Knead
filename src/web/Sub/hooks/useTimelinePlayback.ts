import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  DEFAULT_RETRIGGER_INTERVAL,
  MAX_MARKER_PITCH,
  MIN_MARKER_PITCH,
  dbToGain,
  isSoundStopMarker,
  type Marker,
  type MasterBus,
  type ReferenceAudioTrack,
  type SoundStopAction,
  type TempoMapEvent,
  type TimelineSettings,
  type Track,
} from '../types/timeline'
import type { useAudioBufferCache } from './useAudioBufferCache'
import { sampleCurve } from '../utils/curveSampling'
import { createMarkerTickIndex, forEachMarkerInTickRange } from '../utils/markerTickIndex'
import { stableVariantIndex } from '../utils/studioMath'
import {
  buildTempoMap,
  enumerateTempoGridLines,
  secondsToTick,
  tickRangeToSeconds,
  tickToSeconds,
  type TempoMapModel,
} from '../utils/tempoMap'

const LOOKAHEAD_SECONDS = 0.12
const BUFFER_RETRY_SECONDS = 0.04
const STATUS_UPDATE_INTERVAL_MS = 100
const EMPTY_REFERENCE_AUDIO: ReferenceAudioTrack[] = []

/** Resolve the exact WebAudio/offline rate without silently changing pitch. */
export function resolveMarkerPlaybackRate(markerPitch: number, basePitch: number): number | null {
  if (
    !Number.isFinite(markerPitch)
    || markerPitch < MIN_MARKER_PITCH
    || markerPitch > MAX_MARKER_PITCH
    || !Number.isFinite(basePitch)
    || basePitch <= 0
  ) return null
  const rate = markerPitch * basePitch
  return Number.isFinite(rate) && rate > 0 ? rate : null
}

function clampPan(value: number): number {
  return Math.max(-1, Math.min(1, value))
}

export interface ReferencePlaybackWindow {
  delaySeconds: number
  sourceOffsetSeconds: number
  durationSeconds: number
}

/** Resolve exact source/destination positions for play, seek, and loop restarts. */
export function resolveReferencePlaybackWindow(
  trackOffsetTicks: number,
  bufferDurationSeconds: number,
  windowStartTick: number,
  windowEndTick: number,
  tempoModel?: TempoMapModel,
): ReferencePlaybackWindow | null {
  if (
    !Number.isFinite(bufferDurationSeconds)
    || bufferDurationSeconds <= 0
    || windowEndTick <= windowStartTick
  ) return null
  const delay = tickRangeToSeconds(windowStartTick, trackOffsetTicks, tempoModel)
  const sourceOffsetSeconds = Math.max(0, -delay)
  const durationSeconds = Math.min(
    bufferDurationSeconds - sourceOffsetSeconds,
    tickRangeToSeconds(Math.max(windowStartTick, trackOffsetTicks), windowEndTick, tempoModel),
  )
  if (durationSeconds <= 0) return null
  return {
    delaySeconds: Math.max(0, delay),
    sourceOffsetSeconds,
    durationSeconds,
  }
}

/** Mirrors Note Block Studio's per-note/layer panning compatibility rule. */
export function resolveMarkerPan(
  panLaw: TimelineSettings['panLaw'],
  markerPan: number | undefined,
  trackPan: number,
): number {
  const note = clampPan(markerPan ?? 0)
  const track = clampPan(trackPan)
  if (panLaw !== 'nbs-average') return note
  return track === 0 ? note : clampPan((note + track) / 2)
}

interface Params {
  markers: Marker[]
  tracks: Track[]
  lengthTicks: number
  settings: TimelineSettings
  master: MasterBus
  randomSeed: number
  cache: ReturnType<typeof useAudioBufferCache>
  referenceAudio?: ReferenceAudioTrack[]
  tempoMap?: readonly TempoMapEvent[]
}

export interface TimelineFiring {
  key: string
  markerId: string
  firingIndex: number
  trackId: string
  soundId: string
  variantIndex: number
  tick: number
  volume: number
  pitch: number
  pan: number
  gateTicks?: number
}

interface MeterValue {
  peak: number
  rms: number
}

interface PlaybackStatus {
  currentTick: number
  trackMeters: Record<string, MeterValue>
  referenceAudioMeters: Record<string, MeterValue>
  masterMeter: MeterValue
}

export interface PlaybackStatusStore {
  getSnapshot: () => PlaybackStatus
  subscribe: (listener: () => void) => () => void
}

function noStatusSubscription(): () => void {
  return () => undefined
}

export function usePlaybackStatus(status: PlaybackStatusStore, enabled: boolean): PlaybackStatus {
  return useSyncExternalStore(
    enabled ? status.subscribe : noStatusSubscription,
    enabled ? status.getSnapshot : () => INITIAL_STATUS,
  )
}

export function usePlaybackPosition(status: PlaybackStatusStore): number {
  return useSyncExternalStore(status.subscribe, () => status.getSnapshot().currentTick)
}

export function usePlaybackMeter(
  status: PlaybackStatusStore | undefined,
  kind: 'track' | 'reference' | 'master',
  trackId = '',
): MeterValue | undefined {
  return useSyncExternalStore(status?.subscribe ?? noStatusSubscription, () => {
    if (!status) return undefined
    const snapshot = status.getSnapshot()
    if (kind === 'master') return snapshot.masterMeter
    return (kind === 'track' ? snapshot.trackMeters : snapshot.referenceAudioMeters)[trackId]
  })
}

const INITIAL_STATUS: PlaybackStatus = {
  currentTick: 0,
  trackMeters: {},
  referenceAudioMeters: {},
  masterMeter: { peak: 0, rms: 0 },
}

interface TrackBus {
  gain: GainNode
  pan: StereoPannerNode
  analyser: AnalyserNode
}

export interface SourceStopTarget {
  node: Pick<AudioScheduledSourceNode, 'stop'>
  stopAt?: number
}

interface ActiveScheduledSource extends SourceStopTarget {
  node: AudioScheduledSourceNode
  kind: 'marker' | 'metronome'
  tick: number
  trackId?: string
  soundId?: string
  /** Earliest already-scheduled stop, in AudioContext seconds. */
  stopAt?: number
}

type TimelineScheduleEvent =
  | { type: 'firing', key: string, tick: number, trackIndex: number, firing: TimelineFiring }
  | { type: 'sound-stop', key: string, tick: number, trackIndex: number, marker: Marker }

export function resolveSoundStopTrackIds(
  action: Readonly<SoundStopAction>,
  tracks: readonly Track[],
): string[] {
  if (action.scope === 'all') return tracks.map(track => track.id)
  const start = Math.max(1, Math.trunc(action.startTrack ?? 1))
  const end = Math.max(start, Math.trunc(action.endTrack ?? start))
  return tracks.slice(start - 1, end).map(track => track.id)
}

/**
 * OpenNBS stores the number of repeats after the initial pass; zero is
 * infinite. `completedLoopCount` is therefore compared before the next jump.
 */
export function canRestartLoop(maxLoopCount: number | undefined, completedLoopCount: number): boolean {
  const maximum = Math.max(0, Math.trunc(maxLoopCount ?? 0))
  return maximum === 0 || completedLoopCount < maximum
}

export interface MetronomeEvent {
  tick: number
  accent: boolean
}

/** Replace the transport's single animation-frame loop without leaking an older loop. */
export function replaceTransportAnimationFrame(
  current: number | null,
  enabled: boolean,
  callback: FrameRequestCallback,
): number | null {
  if (current !== null) cancelAnimationFrame(current)
  return enabled ? requestAnimationFrame(callback) : null
}

export function resolveMetronomeEvents(
  startTick: number,
  endTick: number,
  tempoModel: TempoMapModel,
): MetronomeEvent[] {
  const byTick = new Map<number, MetronomeEvent>()
  for (const line of enumerateTempoGridLines(startTick, endTick, tempoModel, 512)) {
    const tick = Math.max(0, Math.round(line.tick))
    const previous = byTick.get(tick)
    byTick.set(tick, { tick, accent: line.major || previous?.accent === true })
  }
  return [...byTick.values()].sort((left, right) => left.tick - right.tick)
}

function markerFiringInterval(marker: Marker): number {
  return marker.retriggerInterval && marker.retriggerInterval > 0
    ? marker.retriggerInterval
    : DEFAULT_RETRIGGER_INTERVAL
}

function markerFiringCount(marker: Marker, interval: number): number {
  const duration = marker.duration ?? 0
  return duration > 0 ? Math.floor(duration / interval) + 1 : 1
}

function createFiring(marker: Marker, firingIndex: number, interval: number, key: string): TimelineFiring {
  const offset = firingIndex * interval
  const gateTicks = Math.trunc(marker.gateTicks ?? 0)
  return {
    key,
    markerId: marker.id,
    firingIndex,
    trackId: marker.trackId,
    soundId: marker.soundId,
    variantIndex: marker.variantIndex,
    tick: marker.tick + offset,
    volume: sampleCurve(marker.volumeCurve, offset, marker.volume),
    pitch: sampleCurve(marker.pitchCurve, offset, marker.pitch),
    pan: clampPan(marker.pan ?? 0),
    gateTicks: gateTicks > 0 ? gateTicks : undefined,
  }
}

export function enumerateMarkerFirings(marker: Marker): TimelineFiring[] {
  if (isSoundStopMarker(marker)) return []
  const interval = markerFiringInterval(marker)
  return Array.from({ length: markerFiringCount(marker, interval) }, (_, firingIndex) => (
    createFiring(marker, firingIndex, interval, `${marker.id}#${firingIndex}`)
  ))
}

/**
 * AudioScheduledSourceNode replaces an earlier scheduled stop when stop() is
 * called again. Keep the minimum so a later Sound Stopper can never extend a
 * marker's gate (and a gate can never extend an earlier stopper).
 */
export function scheduleEarliestSourceStop(
  target: SourceStopTarget,
  when: number,
): boolean {
  if (!Number.isFinite(when) || (target.stopAt !== undefined && target.stopAt <= when)) return false
  try {
    target.node.stop(when)
    target.stopAt = when
    return true
  }
  catch {
    return false
  }
}

function readMeter(analyser: AnalyserNode, scratch: Float32Array<ArrayBuffer>): MeterValue {
  analyser.getFloatTimeDomainData(scratch)
  let peak = 0
  let squareSum = 0
  for (const sample of scratch) {
    peak = Math.max(peak, Math.abs(sample))
    squareSum += sample * sample
  }
  return { peak, rms: Math.sqrt(squareSum / scratch.length) }
}

function readTrackMeters(
  buses: ReadonlyMap<string, TrackBus>,
  previous: Record<string, MeterValue>,
  scratch: Float32Array<ArrayBuffer>,
): Record<string, MeterValue> {
  const meters: Record<string, MeterValue> = {}
  for (const [id, bus] of buses) {
    const meter = readMeter(bus.analyser, scratch)
    const cached = previous[id]
    meters[id] = cached?.peak === meter.peak && cached.rms === meter.rms ? cached : meter
  }
  return meters
}

function createTrackBus(context: AudioContext, output: AudioNode): TrackBus {
  const gain = context.createGain()
  const pan = context.createStereoPanner()
  const analyser = context.createAnalyser()
  analyser.fftSize = 256
  gain.connect(pan).connect(analyser).connect(output)
  return { gain, pan, analyser }
}

function disconnectTrackBus(bus: TrackBus): void {
  bus.gain.disconnect()
  bus.pan.disconnect()
  bus.analyser.disconnect()
}

function trackGain(track: Track | ReferenceAudioTrack, hasSolo: boolean): number {
  return !track.muted && (!hasSolo || track.solo) ? dbToGain(track.gainDb) : 0
}

export function useTimelinePlayback({
  markers, tracks, lengthTicks, settings, master, randomSeed, cache,
  referenceAudio = EMPTY_REFERENCE_AUDIO, tempoMap,
}: Params) {
  const [isPlaying, setIsPlaying] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const statusRef = useRef(INITIAL_STATUS)
  const statusListenersRef = useRef(new Set<() => void>())
  const status = useMemo<PlaybackStatusStore>(() => ({
    getSnapshot: () => statusRef.current,
    subscribe: (listener) => {
      const listeners = statusListenersRef.current
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }), [])
  const publishStatus = useCallback((snapshot: PlaybackStatus) => {
    statusRef.current = snapshot
    for (const listener of statusListenersRef.current) listener()
  }, [])
  const publishPosition = useCallback((tick: number) => {
    if (statusRef.current.currentTick !== tick) publishStatus({ ...statusRef.current, currentTick: tick })
  }, [publishStatus])

  const currentTickRef = useRef(0)
  const tickListenersRef = useRef(new Set<(tick: number) => void>())
  const getCurrentTick = useCallback(() => currentTickRef.current, [])
  const subscribeTick = useCallback((listener: (tick: number) => void) => {
    const listeners = tickListenersRef.current
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }, [])
  const publishTick = useCallback((tick: number) => {
    if (currentTickRef.current === tick) return
    currentTickRef.current = tick
    for (const listener of tickListenersRef.current) listener(tick)
  }, [])

  const tempoModel = useMemo(() => buildTempoMap(tempoMap, {
    bpm: settings.bpm,
    ticksPerQuarter: settings.ticksPerQuarter,
    timeSignature: {
      numerator: settings.timeSignature.numerator,
      denominator: settings.timeSignature.denominator,
    },
  }, Math.max(0, lengthTicks - 1)), [
    lengthTicks,
    settings.bpm,
    settings.ticksPerQuarter,
    settings.timeSignature.denominator,
    settings.timeSignature.numerator,
    tempoMap,
  ])
  const trackById = useMemo(() => new Map(tracks.map((track, index) => (
    [track.id, { track, index }]
  ))), [tracks])
  const hasSolo = useMemo(
    () => tracks.some(track => track.solo) || referenceAudio.some(track => track.solo),
    [tracks, referenceAudio],
  )
  const latestRef = useRef({
    markers, tracks, trackById, hasSolo, lengthTicks, settings, master, randomSeed, cache, referenceAudio, tempoModel,
  })
  latestRef.current = {
    markers, tracks, trackById, hasSolo, lengthTicks, settings, master, randomSeed, cache, referenceAudio, tempoModel,
  }
  const playStartAudioTimeRef = useRef(0)
  const startTickRef = useRef(0)
  const metronomeScanTickRef = useRef(0)
  const scheduledThroughRef = useRef<number | null>(null)
  const markerIndexRef = useRef<{ markers: Marker[], index: ReturnType<typeof createMarkerTickIndex> } | null>(null)
  const scheduledKeysRef = useRef<Set<string>>(new Set())
  const activeSourcesRef = useRef<Set<ActiveScheduledSource>>(new Set())
  const activeReferenceSourcesRef = useRef<AudioBufferSourceNode[]>([])
  const rafRef = useRef<number | null>(null)
  const playingRef = useRef(false)
  const pausedRef = useRef(false)
  const completedLoopCountRef = useRef(0)
  const trackBusesRef = useRef<Map<string, TrackBus>>(new Map())
  const referenceBusesRef = useRef<Map<string, TrackBus>>(new Map())
  const masterGainRef = useRef<GainNode | null>(null)
  const limiterRef = useRef<DynamicsCompressorNode | null>(null)
  const masterAnalyserRef = useRef<AnalyserNode | null>(null)
  const lastStatusAtRef = useRef(0)

  const ensureGraph = useCallback(() => {
    const {
      cache: currentCache,
      trackById: currentTrackById,
      hasSolo: currentHasSolo,
      master: currentMaster,
      settings: currentSettings,
      referenceAudio: currentReferenceAudio,
    } = latestRef.current
    const ctx = currentCache.getAudioContext()
    if (!masterGainRef.current) {
      const gain = ctx.createGain()
      const limiter = ctx.createDynamicsCompressor()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 256
      gain.connect(limiter).connect(analyser).connect(ctx.destination)
      masterGainRef.current = gain
      limiterRef.current = limiter
      masterAnalyserRef.current = analyser
    }
    masterGainRef.current.gain.setTargetAtTime(dbToGain(currentMaster.gainDb), ctx.currentTime, 0.01)
    const limiter = limiterRef.current
    if (limiter) {
      limiter.threshold.value = currentMaster.limiterEnabled ? currentMaster.limiterCeilingDb : 0
      limiter.knee.value = 0
      limiter.ratio.value = currentMaster.limiterEnabled ? 20 : 1
      limiter.attack.value = 0.005
      limiter.release.value = 0.05
    }
    for (const [id, bus] of trackBusesRef.current) {
      const track = currentTrackById.get(id)?.track
      if (!track) {
        disconnectTrackBus(bus)
        trackBusesRef.current.delete(id)
        continue
      }
      bus.gain.gain.setTargetAtTime(
        trackGain(track, currentHasSolo),
        ctx.currentTime,
        0.01,
      )
      bus.pan.pan.setTargetAtTime(
        currentSettings.panLaw === 'nbs-average' ? 0 : track.pan,
        ctx.currentTime,
        0.01,
      )
    }
    const referenceIds = new Set<string>()
    for (const track of currentReferenceAudio) {
      referenceIds.add(track.id)
      let bus = referenceBusesRef.current.get(track.id)
      if (!bus) {
        bus = createTrackBus(ctx, masterGainRef.current)
        referenceBusesRef.current.set(track.id, bus)
      }
      bus.gain.gain.setTargetAtTime(
        trackGain(track, currentHasSolo),
        ctx.currentTime,
        0.01,
      )
      bus.pan.pan.setTargetAtTime(track.pan, ctx.currentTime, 0.01)
    }
    for (const [id, bus] of referenceBusesRef.current) {
      if (referenceIds.has(id)) continue
      disconnectTrackBus(bus)
      referenceBusesRef.current.delete(id)
    }
    return ctx
  }, [])

  useEffect(() => {
    ensureGraph()
  }, [tracks, referenceAudio, master, settings.panLaw, ensureGraph])

  useEffect(() => {
    completedLoopCountRef.current = 0
  }, [
    settings.loop.enabled,
    settings.loop.endTick,
    settings.loop.maxLoopCount,
    settings.loop.startTick,
  ])

  const resolveVariant = useCallback((firing: TimelineFiring): number => {
    if (firing.variantIndex >= 0) return firing.variantIndex
    const count = latestRef.current.cache.getVariantCount(firing.soundId)
    if (count <= 0) return -1
    return stableVariantIndex(
      latestRef.current.randomSeed,
      firing.markerId,
      firing.firingIndex,
      count,
    )
  }, [])

  const scheduleFiring = useCallback((firing: TimelineFiring): boolean => {
    const {
      cache: currentCache,
      trackById: currentTrackById,
      hasSolo: currentHasSolo,
      settings: currentSettings,
      tempoModel: currentTempoModel,
    } = latestRef.current
    const track = currentTrackById.get(firing.trackId)?.track
    if (!track || track.muted || (currentHasSolo && !track.solo)) return true
    const variantIndex = resolveVariant(firing)
    if (variantIndex < 0) return false
    const buffer = currentCache.getBuffer(firing.soundId, variantIndex)
    if (!buffer) return false
    const playbackRate = resolveMarkerPlaybackRate(
      firing.pitch,
      currentCache.getBasePitch(firing.soundId, variantIndex),
    )
    if (playbackRate === null) return true
    const ctx = currentCache.getAudioContext()
    let bus = trackBusesRef.current.get(firing.trackId)
    if (!bus) {
      bus = createTrackBus(ctx, masterGainRef.current!)
      bus.gain.gain.value = trackGain(track, currentHasSolo)
      bus.pan.pan.value = currentSettings.panLaw === 'nbs-average' ? 0 : track.pan
      trackBusesRef.current.set(firing.trackId, bus)
    }
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.playbackRate.value = playbackRate
    const markerGain = ctx.createGain()
    const markerPan = ctx.createStereoPanner()
    markerGain.gain.value = firing.volume
    markerPan.pan.value = resolveMarkerPan(currentSettings.panLaw, firing.pan, track.pan)
    source.connect(markerGain).connect(markerPan).connect(bus.gain)
    const when = playStartAudioTimeRef.current + tickRangeToSeconds(startTickRef.current, firing.tick, currentTempoModel)
    const startWhen = Math.max(when, ctx.currentTime)
    source.start(startWhen)
    const active: ActiveScheduledSource = {
      node: source,
      kind: 'marker',
      tick: firing.tick,
      trackId: firing.trackId,
      soundId: firing.soundId,
    }
    activeSourcesRef.current.add(active)
    if (firing.gateTicks && firing.gateTicks > 0) {
      // Gate time is tied to AudioContext/timeline time, never playbackRate.
      const duration = tickRangeToSeconds(firing.tick, firing.tick + firing.gateTicks, currentTempoModel)
      scheduleEarliestSourceStop(active, startWhen + duration)
    }
    source.onended = () => {
      activeSourcesRef.current.delete(active)
      markerGain.disconnect()
      markerPan.disconnect()
    }
    return true
  }, [resolveVariant])

  const scheduleSoundStop = useCallback((marker: Marker) => {
    if (!isSoundStopMarker(marker)) return
    const { tracks: currentTracks, cache: currentCache, tempoModel: currentTempoModel } = latestRef.current
    const targetTrackIds = new Set(resolveSoundStopTrackIds(marker.action, currentTracks))
    const ctx = currentCache.getAudioContext()
    const when = Math.max(
      ctx.currentTime,
      playStartAudioTimeRef.current + tickRangeToSeconds(startTickRef.current, marker.tick, currentTempoModel),
    )
    for (const active of activeSourcesRef.current) {
      if (active.kind !== 'marker' || active.tick > marker.tick || !active.trackId) continue
      if (!targetTrackIds.has(active.trackId)) continue
      scheduleEarliestSourceStop(active, when)
    }
  }, [])

  const scheduleMetronome = useCallback((tick: number, accent: boolean) => {
    const { cache: currentCache, settings: currentSettings, tempoModel: currentTempoModel } = latestRef.current
    if (!currentSettings.metronomeEnabled) return
    const ctx = currentCache.getAudioContext()
    const oscillator = ctx.createOscillator()
    const gain = ctx.createGain()
    oscillator.frequency.value = accent ? 1400 : 900
    gain.gain.value = currentSettings.metronomeVolume
    const when = Math.max(
      ctx.currentTime,
      playStartAudioTimeRef.current + tickRangeToSeconds(startTickRef.current, tick, currentTempoModel),
    )
    gain.gain.setValueAtTime(currentSettings.metronomeVolume, when)
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.035)
    oscillator.connect(gain).connect(masterGainRef.current!)
    oscillator.start(when)
    oscillator.stop(when + 0.04)
    const active: ActiveScheduledSource = { node: oscillator, kind: 'metronome', tick }
    activeSourcesRef.current.add(active)
    oscillator.onended = () => {
      activeSourcesRef.current.delete(active)
      gain.disconnect()
    }
  }, [])

  const stopReferenceSources = useCallback(() => {
    for (const source of activeReferenceSourcesRef.current) {
      try {
        source.stop()
      }
      catch { /* already stopped */ }
      try {
        source.disconnect()
      }
      catch { /* noop */ }
    }
    activeReferenceSourcesRef.current = []
  }, [])

  /** Start every overlapping reference at the exact source offset for this transport window. */
  const scheduleReferenceAudio = useCallback((windowStartTick: number, windowEndTick: number) => {
    stopReferenceSources()
    const {
      cache: currentCache,
      hasSolo: currentHasSolo,
      referenceAudio: currentReferenceAudio,
      tempoModel: currentTempoModel,
    } = latestRef.current
    const ctx = currentCache.getAudioContext()
    for (const track of currentReferenceAudio) {
      if (track.muted || (currentHasSolo && !track.solo)) continue
      const buffer = currentCache.getReferenceBuffer(track.id)
      const bus = referenceBusesRef.current.get(track.id)
      if (!buffer || !bus || buffer.duration <= 0) continue
      const window = resolveReferencePlaybackWindow(
        track.offsetTicks,
        buffer.duration,
        windowStartTick,
        windowEndTick,
        currentTempoModel,
      )
      if (!window || window.durationSeconds <= 0) continue
      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.connect(bus.gain)
      source.start(
        ctx.currentTime + window.delaySeconds,
        window.sourceOffsetSeconds,
        window.durationSeconds,
      )
      activeReferenceSourcesRef.current.push(source)
      source.onended = () => {
        const index = activeReferenceSourcesRef.current.indexOf(source)
        if (index >= 0) activeReferenceSourcesRef.current.splice(index, 1)
        try {
          source.disconnect()
        }
        catch { /* noop */ }
      }
    }
  }, [stopReferenceSources])

  const stopSources = useCallback(() => {
    stopReferenceSources()
    for (const active of activeSourcesRef.current) {
      try {
        active.node.stop()
      }
      catch { /* already stopped */ }
      try {
        active.node.disconnect()
      }
      catch { /* noop */ }
    }
    activeSourcesRef.current.clear()
    scheduledKeysRef.current.clear()
    scheduledThroughRef.current = null
  }, [stopReferenceSources])

  const updateStatus = useCallback((currentTick: number) => {
    const scratch = new Float32Array(256)
    const previous = statusRef.current
    publishStatus({
      currentTick,
      trackMeters: readTrackMeters(trackBusesRef.current, previous.trackMeters, scratch),
      referenceAudioMeters: readTrackMeters(referenceBusesRef.current, previous.referenceAudioMeters, scratch),
      masterMeter: masterAnalyserRef.current ? readMeter(masterAnalyserRef.current, scratch) : previous.masterMeter,
    })
  }, [publishStatus])

  const stopInternal = useCallback((letNotesFinish = false) => {
    playingRef.current = false
    pausedRef.current = false
    completedLoopCountRef.current = 0
    if (!letNotesFinish) stopSources()
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    setIsPlaying(false)
    setIsPaused(false)
  }, [stopSources])

  const tick = useCallback((timestamp: number) => {
    const {
      cache: currentCache,
      settings: currentSettings,
      markers: currentMarkers,
      trackById: currentTrackById,
      lengthTicks: currentLength,
      tempoModel: currentTempoModel,
    } = latestRef.current
    const ctx = currentCache.getAudioContext()
    let currentSeconds = tickToSeconds(startTickRef.current, currentTempoModel)
      + (ctx.currentTime - playStartAudioTimeRef.current)
    let effectiveCurrent = secondsToTick(currentSeconds, currentTempoModel)
    const loop = currentSettings.loop
    const endTick = loop.enabled ? loop.endTick : currentLength
    if (currentSeconds >= tickToSeconds(endTick, currentTempoModel)) {
      if (loop.enabled && canRestartLoop(loop.maxLoopCount, completedLoopCountRef.current)) {
        completedLoopCountRef.current++
        stopSources()
        startTickRef.current = loop.startTick
        metronomeScanTickRef.current = loop.startTick
        playStartAudioTimeRef.current = ctx.currentTime
        effectiveCurrent = loop.startTick
        currentSeconds = tickToSeconds(loop.startTick, currentTempoModel)
        scheduleReferenceAudio(loop.startTick, loop.endTick)
      }
      else {
        publishTick(currentLength)
        publishPosition(currentLength)
        stopInternal(!loop.enabled && currentTempoModel.ticksPerQuarter !== undefined)
        return
      }
    }
    const lookahead = secondsToTick(currentSeconds + LOOKAHEAD_SECONDS, currentTempoModel)
    const retryFrom = secondsToTick(Math.max(0, currentSeconds - BUFFER_RETRY_SECONDS), currentTempoModel)
    // Catch up if a frame was delayed. Keep retrying undecoded sounds only
    // around their playback time, so a missing sound cannot build a backlog.
    const scanStart = Math.max(startTickRef.current, Math.min(scheduledThroughRef.current ?? startTickRef.current, retryFrom))
    const scanEnd = Math.min(lookahead, endTick)
    if (markerIndexRef.current?.markers !== currentMarkers) {
      markerIndexRef.current = { markers: currentMarkers, index: createMarkerTickIndex(currentMarkers) }
    }
    const scheduleEvents: TimelineScheduleEvent[] = []
    forEachMarkerInTickRange(markerIndexRef.current.index, scanStart, scanEnd, (marker) => {
      const trackIndex = currentTrackById.get(marker.trackId)?.index ?? Number.MAX_SAFE_INTEGER
      if (isSoundStopMarker(marker)) {
        const key = `${marker.id}#sound-stop`
        if (marker.tick < endTick && !scheduledKeysRef.current.has(key)) {
          scheduleEvents.push({ type: 'sound-stop', key, tick: marker.tick, trackIndex, marker })
        }
        return
      }
      const interval = markerFiringInterval(marker)
      const first = Math.max(0, Math.ceil((scanStart - marker.tick) / interval))
      const last = Math.min(markerFiringCount(marker, interval) - 1, Math.floor((scanEnd - marker.tick) / interval))
      for (let firingIndex = first; firingIndex <= last; firingIndex++) {
        const key = `${marker.id}#${firingIndex}`
        const tick = marker.tick + firingIndex * interval
        if (tick >= endTick || scheduledKeysRef.current.has(key)) continue
        const firing = createFiring(marker, firingIndex, interval, key)
        scheduleEvents.push({ type: 'firing', key, tick, trackIndex, firing })
      }
    })
    scheduledThroughRef.current = lookahead
    scheduleEvents.sort((left, right) => (
      left.tick - right.tick
      || left.trackIndex - right.trackIndex
      || (left.type === right.type ? left.key.localeCompare(right.key) : left.type === 'firing' ? -1 : 1)
    ))
    for (const event of scheduleEvents) {
      if (event.type === 'sound-stop') {
        scheduleSoundStop(event.marker)
        scheduledKeysRef.current.add(event.key)
      }
      else if (scheduleFiring(event.firing)) {
        scheduledKeysRef.current.add(event.key)
      }
    }
    if (currentSettings.metronomeEnabled) {
      for (const event of resolveMetronomeEvents(
        Math.max(startTickRef.current, metronomeScanTickRef.current),
        lookahead,
        latestRef.current.tempoModel,
      )) {
        const beatTick = event.tick
        const key = `metro#${beatTick}`
        if (beatTick < effectiveCurrent - 1 || beatTick > lookahead || beatTick >= endTick || scheduledKeysRef.current.has(key)) continue
        scheduleMetronome(beatTick, event.accent)
        scheduledKeysRef.current.add(key)
      }
      metronomeScanTickRef.current = lookahead + 1e-6
    }
    else {
      metronomeScanTickRef.current = lookahead + 1e-6
    }
    publishTick(effectiveCurrent)
    // The playhead follows every frame. Numeric readouts and meters update
    // together at a slower rate so they do not repaint the editor every frame.
    if (timestamp - lastStatusAtRef.current >= STATUS_UPDATE_INTERVAL_MS) {
      lastStatusAtRef.current = timestamp
      updateStatus(effectiveCurrent)
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [
    publishPosition,
    publishTick,
    scheduleFiring,
    scheduleMetronome,
    scheduleReferenceAudio,
    scheduleSoundStop,
    stopInternal,
    stopSources,
    updateStatus,
  ])

  const play = useCallback(() => {
    if (playingRef.current) return
    const { lengthTicks: currentLength, settings: currentSettings } = latestRef.current
    const ctx = ensureGraph()
    void ctx.resume()
    stopSources()
    const position = currentTickRef.current
    let start = position >= currentLength ? 0 : position
    if (currentSettings.loop.enabled && (start < currentSettings.loop.startTick || start >= currentSettings.loop.endTick)) {
      start = currentSettings.loop.startTick
    }
    playingRef.current = true
    pausedRef.current = false
    completedLoopCountRef.current = 0
    playStartAudioTimeRef.current = ctx.currentTime
    startTickRef.current = start
    metronomeScanTickRef.current = start
    scheduledKeysRef.current.clear()
    publishTick(start)
    publishPosition(start)
    setIsPlaying(true)
    setIsPaused(false)
    scheduleReferenceAudio(
      start,
      currentSettings.loop.enabled ? currentSettings.loop.endTick : currentLength,
    )
    tick(performance.now())
  }, [ensureGraph, publishPosition, publishTick, scheduleReferenceAudio, stopSources, tick])

  const pause = useCallback(() => {
    if (!playingRef.current || pausedRef.current) return
    pausedRef.current = true
    void latestRef.current.cache.getAudioContext().suspend()
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    publishPosition(currentTickRef.current)
    setIsPlaying(false)
    setIsPaused(true)
  }, [publishPosition])

  const resume = useCallback(() => {
    if (!pausedRef.current) return
    pausedRef.current = false
    void latestRef.current.cache.getAudioContext().resume()
    setIsPlaying(true)
    setIsPaused(false)
    rafRef.current = requestAnimationFrame(tick)
  }, [tick])

  const stop = useCallback(() => {
    stopInternal()
    publishTick(0)
    publishStatus(INITIAL_STATUS)
  }, [publishStatus, publishTick, stopInternal])

  const seek = useCallback((tickValue: number) => {
    const wasPlaying = playingRef.current
    const ctx = latestRef.current.cache.getAudioContext()
    const clamped = Math.max(0, Math.min(latestRef.current.lengthTicks, tickValue))
    completedLoopCountRef.current = 0
    rafRef.current = replaceTransportAnimationFrame(rafRef.current, false, tick)
    stopSources()
    publishTick(clamped)
    publishPosition(clamped)
    startTickRef.current = clamped
    metronomeScanTickRef.current = clamped
    playStartAudioTimeRef.current = ctx.currentTime
    if (wasPlaying) {
      const currentSettings = latestRef.current.settings
      scheduleReferenceAudio(
        clamped,
        currentSettings.loop.enabled
          ? currentSettings.loop.endTick
          : latestRef.current.lengthTicks,
      )
      if (!pausedRef.current) tick(performance.now())
    }
  }, [publishPosition, publishTick, scheduleReferenceAudio, stopSources, tick])

  useEffect(() => {
    if (!playingRef.current) return
    const ctx = latestRef.current.cache.getAudioContext()
    const currentTempoModel = latestRef.current.tempoModel
    const transportTick = pausedRef.current
      ? startTickRef.current
      : secondsToTick(tickToSeconds(startTickRef.current, currentTempoModel)
        + (ctx.currentTime - playStartAudioTimeRef.current), currentTempoModel)
    const currentSettings = latestRef.current.settings
    scheduleReferenceAudio(
      transportTick,
      currentSettings.loop.enabled ? currentSettings.loop.endTick : latestRef.current.lengthTicks,
    )
  }, [cache.referenceRevision, referenceAudio, scheduleReferenceAudio])

  useEffect(() => () => {
    stopInternal()
    for (const bus of trackBusesRef.current.values()) disconnectTrackBus(bus)
    for (const bus of referenceBusesRef.current.values()) disconnectTrackBus(bus)
    trackBusesRef.current.clear()
    referenceBusesRef.current.clear()
    masterGainRef.current?.disconnect()
    limiterRef.current?.disconnect()
    masterAnalyserRef.current?.disconnect()
    masterGainRef.current = null
    limiterRef.current = null
    masterAnalyserRef.current = null
  }, [stopInternal])

  return useMemo(() => ({
    isPlaying,
    isPaused,
    status,
    getCurrentTick,
    subscribeTick,
    play,
    pause,
    resume,
    stop,
    seek,
  }), [
    isPlaying, isPaused, status, getCurrentTick, subscribeTick,
    play, pause, resume, stop, seek,
  ])
}
