import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DEFAULT_RETRIGGER_INTERVAL,
  dbToGain,
  isTrackAudible,
  ticksPerBeat,
  type Marker,
  type MasterBus,
  type TimelineSettings,
  type Track,
} from '../types/timeline'
import type { useAudioBufferCache } from './useAudioBufferCache'
import { sampleCurve } from '../utils/curveSampling'
import { stableVariantIndex } from '../utils/studioMath'

const TICK_SEC = 0.05

interface Params {
  markers: Marker[]
  tracks: Track[]
  lengthTicks: number
  settings: TimelineSettings
  master: MasterBus
  randomSeed: number
  cache: ReturnType<typeof useAudioBufferCache>
}

interface Firing {
  key: string
  markerId: string
  firingIndex: number
  trackId: string
  soundId: string
  variantIndex: number
  tick: number
  volume: number
  pitch: number
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

function enumerateFirings(marker: Marker): Firing[] {
  const duration = marker.duration ?? 0
  const interval = marker.retriggerInterval && marker.retriggerInterval > 0
    ? marker.retriggerInterval
    : DEFAULT_RETRIGGER_INTERVAL
  const count = duration > 0 ? Math.floor(duration / interval) + 1 : 1
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
    }
  })
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
}: Params) {
  const [isPlaying, setIsPlaying] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [currentTick, setCurrentTick] = useState(0)
  const [trackMeters, setTrackMeters] = useState<Record<string, MeterValue>>({})
  const [masterMeter, setMasterMeter] = useState<MeterValue>({ peak: 0, rms: 0 })

  const latestRef = useRef({ markers, tracks, lengthTicks, settings, master, randomSeed, cache })
  latestRef.current = { markers, tracks, lengthTicks, settings, master, randomSeed, cache }
  const playStartAudioTimeRef = useRef(0)
  const startTickRef = useRef(0)
  const scheduledKeysRef = useRef<Set<string>>(new Set())
  const activeSourcesRef = useRef<AudioScheduledSourceNode[]>([])
  const rafRef = useRef<number | null>(null)
  const playingRef = useRef(false)
  const pausedRef = useRef(false)
  const trackBusesRef = useRef<Map<string, TrackBus>>(new Map())
  const masterGainRef = useRef<GainNode | null>(null)
  const limiterRef = useRef<DynamicsCompressorNode | null>(null)
  const masterAnalyserRef = useRef<AnalyserNode | null>(null)
  const lastMeterAtRef = useRef(0)

  const ensureGraph = useCallback(() => {
    const { cache: currentCache, tracks: currentTracks, master: currentMaster } = latestRef.current
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
        isTrackAudible(track, currentTracks) ? dbToGain(track.gainDb) : 0,
        ctx.currentTime,
        0.01,
      )
      bus.pan.pan.setTargetAtTime(track.pan, ctx.currentTime, 0.01)
    }
    for (const [id, bus] of trackBusesRef.current) {
      if (currentTracks.some(track => track.id === id)) continue
      bus.gain.disconnect()
      bus.pan.disconnect()
      bus.analyser.disconnect()
      trackBusesRef.current.delete(id)
    }
    return ctx
  }, [])

  useEffect(() => {
    ensureGraph()
  }, [tracks, master, ensureGraph])

  const resolveVariant = useCallback((firing: Firing): number => {
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

  const scheduleFiring = useCallback((firing: Firing): boolean => {
    const { cache: currentCache, tracks: currentTracks } = latestRef.current
    const track = currentTracks.find(item => item.id === firing.trackId)
    const bus = trackBusesRef.current.get(firing.trackId)
    if (!track || !bus || !isTrackAudible(track, currentTracks)) return true
    const variantIndex = resolveVariant(firing)
    if (variantIndex < 0) return false
    const buffer = currentCache.getBuffer(firing.soundId, variantIndex)
    if (!buffer) return false
    const ctx = ensureGraph()
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.playbackRate.value = firing.pitch * currentCache.getBasePitch(firing.soundId, variantIndex)
    const markerGain = ctx.createGain()
    markerGain.gain.value = firing.volume
    source.connect(markerGain).connect(bus.gain)
    const when = playStartAudioTimeRef.current + (firing.tick - startTickRef.current) * TICK_SEC
    source.start(Math.max(when, ctx.currentTime))
    activeSourcesRef.current.push(source)
    source.onended = () => {
      const index = activeSourcesRef.current.indexOf(source)
      if (index >= 0) activeSourcesRef.current.splice(index, 1)
      markerGain.disconnect()
    }
    return true
  }, [ensureGraph, resolveVariant])

  const scheduleMetronome = useCallback((tick: number, beatIndex: number) => {
    const { settings: currentSettings } = latestRef.current
    if (!currentSettings.metronomeEnabled) return
    const ctx = ensureGraph()
    const oscillator = ctx.createOscillator()
    const gain = ctx.createGain()
    const accent = beatIndex % currentSettings.timeSignature.numerator === 0
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
    activeSourcesRef.current.push(oscillator)
    oscillator.onended = () => {
      const index = activeSourcesRef.current.indexOf(oscillator)
      if (index >= 0) activeSourcesRef.current.splice(index, 1)
      gain.disconnect()
    }
  }, [ensureGraph])

  const stopSources = useCallback(() => {
    for (const source of activeSourcesRef.current) {
      try {
        source.stop()
      }
      catch { /* already stopped */ }
      try {
        source.disconnect()
      }
      catch { /* noop */ }
    }
    activeSourcesRef.current = []
    scheduledKeysRef.current.clear()
  }, [])

  const updateMeters = useCallback((timestamp: number) => {
    if (timestamp - lastMeterAtRef.current < 50) return
    lastMeterAtRef.current = timestamp
    const scratch = new Float32Array(256)
    const next: Record<string, MeterValue> = {}
    for (const [id, bus] of trackBusesRef.current) next[id] = readMeter(bus.analyser, scratch)
    setTrackMeters(next)
    if (masterAnalyserRef.current) setMasterMeter(readMeter(masterAnalyserRef.current, scratch))
  }, [])

  const stopInternal = useCallback(() => {
    playingRef.current = false
    pausedRef.current = false
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
      if (loop.enabled) {
        stopSources()
        startTickRef.current = loop.startTick
        playStartAudioTimeRef.current = ctx.currentTime
        setCurrentTick(loop.startTick)
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
    for (const marker of currentMarkers) {
      for (const firing of enumerateFirings(marker)) {
        if (scheduledKeysRef.current.has(firing.key)) continue
        if (firing.tick < startTickRef.current || firing.tick > lookahead || firing.tick >= endTick) continue
        if (scheduleFiring(firing)) scheduledKeysRef.current.add(firing.key)
      }
    }
    if (currentSettings.metronomeEnabled) {
      const beatLength = ticksPerBeat(currentSettings)
      const firstBeat = Math.max(0, Math.floor(startTickRef.current / beatLength))
      const lastBeat = Math.ceil(lookahead / beatLength)
      for (let beat = firstBeat; beat <= lastBeat; beat++) {
        const beatTick = Math.round(beat * beatLength)
        const key = `metro#${beat}`
        if (beatTick < startTickRef.current || beatTick > lookahead || scheduledKeysRef.current.has(key)) continue
        scheduleMetronome(beatTick, beat)
        scheduledKeysRef.current.add(key)
      }
    }
    updateMeters(timestamp)
    rafRef.current = requestAnimationFrame(tick)
  }, [scheduleFiring, scheduleMetronome, stopInternal, stopSources, updateMeters])

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
    playStartAudioTimeRef.current = ctx.currentTime
    startTickRef.current = start
    scheduledKeysRef.current.clear()
    setCurrentTick(start)
    setIsPlaying(true)
    setIsPaused(false)
    rafRef.current = requestAnimationFrame(tick)
  }, [currentTick, ensureGraph, tick])

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
    setMasterMeter({ peak: 0, rms: 0 })
  }, [stopInternal])

  const seek = useCallback((tickValue: number) => {
    const wasPlaying = playingRef.current
    const ctx = latestRef.current.cache.getAudioContext()
    const clamped = Math.max(0, Math.min(latestRef.current.lengthTicks, tickValue))
    stopSources()
    setCurrentTick(clamped)
    startTickRef.current = clamped
    playStartAudioTimeRef.current = ctx.currentTime
    if (wasPlaying) rafRef.current = requestAnimationFrame(tick)
  }, [stopSources, tick])

  useEffect(() => () => {
    stopInternal()
    for (const bus of trackBusesRef.current.values()) {
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
    masterMeter,
    play,
    pause,
    resume,
    stop,
    seek,
  }), [
    isPlaying, isPaused, currentTick, trackMeters, masterMeter,
    play, pause, resume, stop, seek,
  ])
}
