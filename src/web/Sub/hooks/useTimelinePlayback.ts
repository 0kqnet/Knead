import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { stableVariantIndex } from '../utils/studioMath'
import {
  buildTempoMap,
  enumerateTempoGridLines,
  type TempoMapModel,
} from '../utils/tempoMap'

const TICK_SEC = 0.05

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
): ReferencePlaybackWindow | null {
  if (
    !Number.isFinite(bufferDurationSeconds)
    || bufferDurationSeconds <= 0
    || windowEndTick <= windowStartTick
  ) return null
  const trackEndTick = trackOffsetTicks + bufferDurationSeconds / TICK_SEC
  const overlapStartTick = Math.max(windowStartTick, trackOffsetTicks)
  const overlapEndTick = Math.min(windowEndTick, trackEndTick)
  if (overlapEndTick <= overlapStartTick) return null
  const sourceOffsetSeconds = Math.max(0, (overlapStartTick - trackOffsetTicks) * TICK_SEC)
  return {
    delaySeconds: Math.max(0, (trackOffsetTicks - windowStartTick) * TICK_SEC),
    sourceOffsetSeconds,
    durationSeconds: Math.min(
      bufferDurationSeconds - sourceOffsetSeconds,
      (overlapEndTick - overlapStartTick) * TICK_SEC,
    ),
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

export function enumerateMarkerFirings(marker: Marker): TimelineFiring[] {
  if (isSoundStopMarker(marker)) return []
  const duration = marker.duration ?? 0
  const interval = marker.retriggerInterval && marker.retriggerInterval > 0
    ? marker.retriggerInterval
    : DEFAULT_RETRIGGER_INTERVAL
  const count = duration > 0 ? Math.floor(duration / interval) + 1 : 1
  const gateTicks = Math.trunc(marker.gateTicks ?? 0)
  return Array.from({ length: count }, (_, firingIndex) => {
    const offset = duration > 0 ? firingIndex * interval : 0
    return {
      key: `${marker.id}#${firingIndex}`,
      markerId: marker.id,
      firingIndex,
      trackId: marker.trackId,
      soundId: marker.soundId,
      variantIndex: marker.variantIndex,
      tick: marker.tick + offset,
      volume: sampleCurve(marker.volumeCurve, offset, marker.volume),
      pitch: sampleCurve(marker.pitchCurve, offset, marker.pitch),
      pan: Math.max(-1, Math.min(1, marker.pan ?? 0)),
      gateTicks: gateTicks > 0 ? gateTicks : undefined,
    }
  })
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

export function useTimelinePlayback({
  markers, tracks, lengthTicks, settings, master, randomSeed, cache,
  referenceAudio = [], tempoMap,
}: Params) {
  const [isPlaying, setIsPlaying] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [currentTick, setCurrentTick] = useState(0)
  const [trackMeters, setTrackMeters] = useState<Record<string, MeterValue>>({})
  const [referenceAudioMeters, setReferenceAudioMeters] = useState<Record<string, MeterValue>>({})
  const [masterMeter, setMasterMeter] = useState<MeterValue>({ peak: 0, rms: 0 })

  const tempoModel = useMemo(() => buildTempoMap(tempoMap, {
    bpm: settings.bpm,
    timeSignature: {
      numerator: settings.timeSignature.numerator,
      denominator: settings.timeSignature.denominator,
    },
  }, Math.max(0, lengthTicks - 1)), [
    lengthTicks,
    settings.bpm,
    settings.timeSignature.denominator,
    settings.timeSignature.numerator,
    tempoMap,
  ])
  const latestRef = useRef({
    markers, tracks, lengthTicks, settings, master, randomSeed, cache, referenceAudio, tempoModel,
  })
  latestRef.current = {
    markers, tracks, lengthTicks, settings, master, randomSeed, cache, referenceAudio, tempoModel,
  }
  const playStartAudioTimeRef = useRef(0)
  const startTickRef = useRef(0)
  const metronomeScanTickRef = useRef(0)
  const scheduledKeysRef = useRef<Set<string>>(new Set())
  const activeSourcesRef = useRef<ActiveScheduledSource[]>([])
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
  const lastMeterAtRef = useRef(0)

  const ensureGraph = useCallback(() => {
    const {
      cache: currentCache,
      tracks: currentTracks,
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
    const hasSolo = currentTracks.some(track => track.solo)
      || currentReferenceAudio.some(track => track.solo)
    for (const track of currentTracks) {
      let bus = trackBusesRef.current.get(track.id)
      if (!bus) {
        const gain = ctx.createGain()
        const pan = ctx.createStereoPanner()
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 256
        gain.connect(pan).connect(analyser).connect(masterGainRef.current)
        bus = { gain, pan, analyser }
        trackBusesRef.current.set(track.id, bus)
      }
      bus.gain.gain.setTargetAtTime(
        !track.muted && (!hasSolo || track.solo) ? dbToGain(track.gainDb) : 0,
        ctx.currentTime,
        0.01,
      )
      bus.pan.pan.setTargetAtTime(
        currentSettings.panLaw === 'nbs-average' ? 0 : track.pan,
        ctx.currentTime,
        0.01,
      )
    }
    for (const [id, bus] of trackBusesRef.current) {
      if (currentTracks.some(track => track.id === id)) continue
      bus.gain.disconnect()
      bus.pan.disconnect()
      bus.analyser.disconnect()
      trackBusesRef.current.delete(id)
    }
    for (const track of currentReferenceAudio) {
      let bus = referenceBusesRef.current.get(track.id)
      if (!bus) {
        const gain = ctx.createGain()
        const pan = ctx.createStereoPanner()
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 256
        gain.connect(pan).connect(analyser).connect(masterGainRef.current)
        bus = { gain, pan, analyser }
        referenceBusesRef.current.set(track.id, bus)
      }
      bus.gain.gain.setTargetAtTime(
        !track.muted && (!hasSolo || track.solo) ? dbToGain(track.gainDb) : 0,
        ctx.currentTime,
        0.01,
      )
      bus.pan.pan.setTargetAtTime(track.pan, ctx.currentTime, 0.01)
    }
    for (const [id, bus] of referenceBusesRef.current) {
      if (currentReferenceAudio.some(track => track.id === id)) continue
      bus.gain.disconnect()
      bus.pan.disconnect()
      bus.analyser.disconnect()
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
      tracks: currentTracks,
      settings: currentSettings,
    } = latestRef.current
    const track = currentTracks.find(item => item.id === firing.trackId)
    const bus = trackBusesRef.current.get(firing.trackId)
    const hasSolo = currentTracks.some(item => item.solo)
      || latestRef.current.referenceAudio.some(item => item.solo)
    if (!track || !bus || track.muted || (hasSolo && !track.solo)) return true
    const variantIndex = resolveVariant(firing)
    if (variantIndex < 0) return false
    const buffer = currentCache.getBuffer(firing.soundId, variantIndex)
    if (!buffer) return false
    const playbackRate = resolveMarkerPlaybackRate(
      firing.pitch,
      currentCache.getBasePitch(firing.soundId, variantIndex),
    )
    if (playbackRate === null) return true
    const ctx = ensureGraph()
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.playbackRate.value = playbackRate
    const markerGain = ctx.createGain()
    const markerPan = ctx.createStereoPanner()
    markerGain.gain.value = firing.volume
    markerPan.pan.value = resolveMarkerPan(currentSettings.panLaw, firing.pan, track.pan)
    source.connect(markerGain).connect(markerPan).connect(bus.gain)
    const when = playStartAudioTimeRef.current + (firing.tick - startTickRef.current) * TICK_SEC
    const startWhen = Math.max(when, ctx.currentTime)
    source.start(startWhen)
    const active: ActiveScheduledSource = {
      node: source,
      kind: 'marker',
      tick: firing.tick,
      trackId: firing.trackId,
      soundId: firing.soundId,
    }
    activeSourcesRef.current.push(active)
    if (firing.gateTicks && firing.gateTicks > 0) {
      // Gate time is tied to AudioContext/timeline time, never playbackRate.
      scheduleEarliestSourceStop(active, startWhen + firing.gateTicks * TICK_SEC)
    }
    source.onended = () => {
      const index = activeSourcesRef.current.findIndex(active => active.node === source)
      if (index >= 0) activeSourcesRef.current.splice(index, 1)
      markerGain.disconnect()
      markerPan.disconnect()
    }
    return true
  }, [ensureGraph, resolveVariant])

  const scheduleSoundStop = useCallback((marker: Marker) => {
    if (!isSoundStopMarker(marker)) return
    const { tracks: currentTracks, cache: currentCache } = latestRef.current
    const targetTrackIds = new Set(resolveSoundStopTrackIds(marker.action, currentTracks))
    const ctx = currentCache.getAudioContext()
    const when = Math.max(
      ctx.currentTime,
      playStartAudioTimeRef.current + (marker.tick - startTickRef.current) * TICK_SEC,
    )
    for (const active of activeSourcesRef.current) {
      if (active.kind !== 'marker' || active.tick > marker.tick || !active.trackId) continue
      if (!targetTrackIds.has(active.trackId)) continue
      scheduleEarliestSourceStop(active, when)
    }
  }, [])

  const scheduleMetronome = useCallback((tick: number, accent: boolean) => {
    const { settings: currentSettings } = latestRef.current
    if (!currentSettings.metronomeEnabled) return
    const ctx = ensureGraph()
    const oscillator = ctx.createOscillator()
    const gain = ctx.createGain()
    oscillator.frequency.value = accent ? 1400 : 900
    gain.gain.value = currentSettings.metronomeVolume
    const when = Math.max(
      ctx.currentTime,
      playStartAudioTimeRef.current + (tick - startTickRef.current) * TICK_SEC,
    )
    gain.gain.setValueAtTime(currentSettings.metronomeVolume, when)
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.035)
    oscillator.connect(gain).connect(masterGainRef.current!)
    oscillator.start(when)
    oscillator.stop(when + 0.04)
    activeSourcesRef.current.push({ node: oscillator, kind: 'metronome', tick })
    oscillator.onended = () => {
      const index = activeSourcesRef.current.findIndex(active => active.node === oscillator)
      if (index >= 0) activeSourcesRef.current.splice(index, 1)
      gain.disconnect()
    }
  }, [ensureGraph])

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
      tracks: currentTracks,
      referenceAudio: currentReferenceAudio,
    } = latestRef.current
    const hasSolo = currentTracks.some(track => track.solo)
      || currentReferenceAudio.some(track => track.solo)
    const ctx = ensureGraph()
    for (const track of currentReferenceAudio) {
      if (track.muted || (hasSolo && !track.solo)) continue
      const buffer = currentCache.getReferenceBuffer(track.id)
      const bus = referenceBusesRef.current.get(track.id)
      if (!buffer || !bus || buffer.duration <= 0) continue
      const window = resolveReferencePlaybackWindow(
        track.offsetTicks,
        buffer.duration,
        windowStartTick,
        windowEndTick,
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
  }, [ensureGraph, stopReferenceSources])

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
    activeSourcesRef.current = []
    scheduledKeysRef.current.clear()
  }, [stopReferenceSources])

  const updateMeters = useCallback((timestamp: number) => {
    if (timestamp - lastMeterAtRef.current < 50) return
    lastMeterAtRef.current = timestamp
    const scratch = new Float32Array(256)
    const next: Record<string, MeterValue> = {}
    for (const [id, bus] of trackBusesRef.current) next[id] = readMeter(bus.analyser, scratch)
    setTrackMeters(next)
    const nextReference: Record<string, MeterValue> = {}
    for (const [id, bus] of referenceBusesRef.current) {
      nextReference[id] = readMeter(bus.analyser, scratch)
    }
    setReferenceAudioMeters(nextReference)
    if (masterAnalyserRef.current) setMasterMeter(readMeter(masterAnalyserRef.current, scratch))
  }, [])

  const stopInternal = useCallback(() => {
    playingRef.current = false
    pausedRef.current = false
    completedLoopCountRef.current = 0
    stopSources()
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    setIsPlaying(false)
    setIsPaused(false)
  }, [stopSources])

  const tick = useCallback((timestamp: number) => {
    const { cache: currentCache, settings: currentSettings, markers: currentMarkers, lengthTicks: currentLength } = latestRef.current
    const ctx = currentCache.getAudioContext()
    const cur = startTickRef.current + (ctx.currentTime - playStartAudioTimeRef.current) / TICK_SEC
    const loop = currentSettings.loop
    const endTick = loop.enabled ? loop.endTick : currentLength
    if (cur >= endTick) {
      if (loop.enabled && canRestartLoop(loop.maxLoopCount, completedLoopCountRef.current)) {
        completedLoopCountRef.current++
        stopSources()
        startTickRef.current = loop.startTick
        metronomeScanTickRef.current = loop.startTick
        playStartAudioTimeRef.current = ctx.currentTime
        setCurrentTick(loop.startTick)
        scheduleReferenceAudio(loop.startTick, loop.endTick)
      }
      else {
        setCurrentTick(currentLength)
        stopInternal()
        return
      }
    }
    else {
      setCurrentTick(cur)
    }

    const effectiveCurrent = cur >= endTick && loop.enabled ? loop.startTick : cur
    const lookahead = effectiveCurrent + 0.12 / TICK_SEC
    const trackIndexById = new Map(latestRef.current.tracks.map((track, index) => [track.id, index]))
    const scheduleEvents: TimelineScheduleEvent[] = []
    for (const marker of currentMarkers) {
      const trackIndex = trackIndexById.get(marker.trackId) ?? Number.MAX_SAFE_INTEGER
      if (isSoundStopMarker(marker)) {
        const key = `${marker.id}#sound-stop`
        if (scheduledKeysRef.current.has(key)) continue
        if (marker.tick < startTickRef.current || marker.tick > lookahead || marker.tick >= endTick) continue
        scheduleEvents.push({ type: 'sound-stop', key, tick: marker.tick, trackIndex, marker })
        continue
      }
      for (const firing of enumerateMarkerFirings(marker)) {
        if (scheduledKeysRef.current.has(firing.key)) continue
        if (firing.tick < startTickRef.current || firing.tick > lookahead || firing.tick >= endTick) continue
        scheduleEvents.push({ type: 'firing', key: firing.key, tick: firing.tick, trackIndex, firing })
      }
    }
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
        if (beatTick < effectiveCurrent - 1 || beatTick > lookahead || scheduledKeysRef.current.has(key)) continue
        scheduleMetronome(beatTick, event.accent)
        scheduledKeysRef.current.add(key)
      }
      metronomeScanTickRef.current = lookahead + 1e-6
    }
    else {
      metronomeScanTickRef.current = lookahead + 1e-6
    }
    updateMeters(timestamp)
    rafRef.current = requestAnimationFrame(tick)
  }, [
    scheduleFiring,
    scheduleMetronome,
    scheduleReferenceAudio,
    scheduleSoundStop,
    stopInternal,
    stopSources,
    updateMeters,
  ])

  const play = useCallback(() => {
    if (playingRef.current) return
    const { lengthTicks: currentLength, settings: currentSettings } = latestRef.current
    const ctx = ensureGraph()
    void ctx.resume()
    let start = currentTick >= currentLength ? 0 : currentTick
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
    setCurrentTick(start)
    setIsPlaying(true)
    setIsPaused(false)
    scheduleReferenceAudio(
      start,
      currentSettings.loop.enabled ? currentSettings.loop.endTick : currentLength,
    )
    rafRef.current = requestAnimationFrame(tick)
  }, [currentTick, ensureGraph, scheduleReferenceAudio, tick])

  const pause = useCallback(() => {
    if (!playingRef.current || pausedRef.current) return
    pausedRef.current = true
    void latestRef.current.cache.getAudioContext().suspend()
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
    rafRef.current = null
    setIsPlaying(false)
    setIsPaused(true)
  }, [])

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
    setCurrentTick(0)
    setTrackMeters({})
    setReferenceAudioMeters({})
    setMasterMeter({ peak: 0, rms: 0 })
  }, [stopInternal])

  const seek = useCallback((tickValue: number) => {
    const wasPlaying = playingRef.current
    const ctx = latestRef.current.cache.getAudioContext()
    const clamped = Math.max(0, Math.min(latestRef.current.lengthTicks, tickValue))
    completedLoopCountRef.current = 0
    rafRef.current = replaceTransportAnimationFrame(rafRef.current, false, tick)
    stopSources()
    setCurrentTick(clamped)
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
      rafRef.current = replaceTransportAnimationFrame(rafRef.current, !pausedRef.current, tick)
    }
  }, [scheduleReferenceAudio, stopSources, tick])

  useEffect(() => {
    if (!playingRef.current) return
    const ctx = latestRef.current.cache.getAudioContext()
    const transportTick = pausedRef.current
      ? startTickRef.current
      : startTickRef.current + (ctx.currentTime - playStartAudioTimeRef.current) / TICK_SEC
    const currentSettings = latestRef.current.settings
    scheduleReferenceAudio(
      transportTick,
      currentSettings.loop.enabled ? currentSettings.loop.endTick : latestRef.current.lengthTicks,
    )
  }, [cache.referenceRevision, referenceAudio, scheduleReferenceAudio])

  useEffect(() => () => {
    stopInternal()
    for (const bus of trackBusesRef.current.values()) {
      bus.gain.disconnect()
      bus.pan.disconnect()
      bus.analyser.disconnect()
    }
    for (const bus of referenceBusesRef.current.values()) {
      bus.gain.disconnect()
      bus.pan.disconnect()
      bus.analyser.disconnect()
    }
  }, [stopInternal])

  return useMemo(() => ({
    isPlaying,
    isPaused,
    currentTick,
    trackMeters,
    referenceAudioMeters,
    masterMeter,
    play,
    pause,
    resume,
    stop,
    seek,
  }), [
    isPlaying, isPaused, currentTick, trackMeters, referenceAudioMeters, masterMeter,
    play, pause, resume, stop, seek,
  ])
}
