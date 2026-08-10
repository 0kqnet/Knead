import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useAudioLibrary } from '../../../hooks/useAudioLibrary'
import {
  cacheDecodedAudioWaveform,
  clearCachedAudioWaveforms,
  getCachedAudioWaveform,
  subscribeAudioWaveforms,
} from '../utils/waveformCache'
import { buildWaveformPeaks, type WaveformPeaks } from '../utils/waveformPeaks'
import type { ReferenceAudioTrack } from '../types/timeline'
import { decodeReferenceAudioBase64 } from '../utils/referenceAudio'
import { getProjectCustomAudioData } from '../utils/projectCustomAudio'

interface CachedReferenceAudio {
  fingerprint: string
  byteLength: number
  dataBase64: string
  buffer: AudioBuffer
  waveform: WaveformPeaks
}

interface PendingReferenceAudio {
  byteLength: number
  dataBase64: string
  promise: Promise<CachedReferenceAudio>
}

export function useAudioWaveform(soundId: string, variantIndex: number) {
  const getSnapshot = useCallback(
    () => getCachedAudioWaveform(soundId, variantIndex),
    [soundId, variantIndex],
  )
  return useSyncExternalStore(subscribeAudioWaveforms, getSnapshot, getSnapshot)
}

export function useAudioBufferCache() {
  const { soundMap } = useAudioLibrary()
  const ctxRef = useRef<AudioContext | null>(null)
  // key = variant の hash（設計仕様どおり。同じ hash を共有する variant はデコード済みバッファを共有する) (M10)
  const cacheRef = useRef<Map<string, AudioBuffer>>(new Map())
  const pendingRef = useRef<Map<string, Promise<AudioBuffer | undefined>>>(new Map())
  const referenceByFingerprintRef = useRef<Map<string, CachedReferenceAudio>>(new Map())
  const referenceByTrackRef = useRef<Map<string, CachedReferenceAudio>>(new Map())
  const referenceErrorsRef = useRef<Map<string, string>>(new Map())
  const referencePendingRef = useRef<Map<string, PendingReferenceAudio>>(new Map())
  const cacheGenerationRef = useRef(0)
  // 同時に走っている preload() の数。0 になったら preloading を false に戻す (I8)
  const preloadCountRef = useRef(0)
  const [preloading, setPreloading] = useState(false)
  const [referenceRevision, setReferenceRevision] = useState(0)

  const getAudioContext = useCallback((): AudioContext => {
    if (!ctxRef.current) ctxRef.current = new AudioContext()
    return ctxRef.current
  }, [])

  const loadOne = useCallback(async (soundId: string, variantIndex: number): Promise<void> => {
    const variants = soundMap[soundId]
    if (!variants || !variants[variantIndex]) return
    const variant = variants[variantIndex]
    const hash = variant.hash
    if (!hash) return
    const generation = cacheGenerationRef.current
    let buf = cacheRef.current.get(hash)
    if (!buf) {
      let pending = pendingRef.current.get(hash)
      if (!pending) {
        pending = (async () => {
          const data = getProjectCustomAudioData(hash) ?? await window.myAPI.get_mcSoundData(hash)
          if (cacheGenerationRef.current !== generation) return undefined
          return getAudioContext().decodeAudioData(data)
        })()
        pendingRef.current.set(hash, pending)
        const removePending = () => {
          if (pendingRef.current.get(hash) === pending) pendingRef.current.delete(hash)
        }
        void pending.then(removePending, removePending)
      }
      buf = await pending
      if (!buf || cacheGenerationRef.current !== generation) return
      cacheRef.current.set(hash, buf)
    }
    if (cacheGenerationRef.current !== generation) return
    cacheDecodedAudioWaveform(soundId, variantIndex, hash, variant.pitch ?? 1, buf)
  }, [soundMap, getAudioContext])

  const preload = useCallback(async (soundIds: string[]): Promise<void> => {
    const generation = cacheGenerationRef.current
    const jobs: Promise<void>[] = []
    for (const id of soundIds) {
      const variants = soundMap[id] || []
      for (let i = 0; i < variants.length; i++) jobs.push(loadOne(id, i))
    }
    if (jobs.length === 0) return
    preloadCountRef.current += 1
    setPreloading(true)
    try {
      await Promise.all(jobs)
    }
    finally {
      if (cacheGenerationRef.current === generation) {
        preloadCountRef.current = Math.max(0, preloadCountRef.current - 1)
        if (preloadCountRef.current === 0) setPreloading(false)
      }
    }
  }, [soundMap, loadOne])

  const getBuffer = useCallback((soundId: string, variantIndex: number): AudioBuffer | undefined => {
    const variants = soundMap[soundId] || []
    if (variants.length === 0) return undefined
    const idx = variantIndex === -1
      ? Math.floor(Math.random() * variants.length)
      : variantIndex
    const hash = variants[idx]?.hash
    if (!hash) return undefined
    return cacheRef.current.get(hash)
  }, [soundMap])

  const getVariantCount = useCallback((soundId: string): number => {
    return soundMap[soundId]?.length ?? 0
  }, [soundMap])

  const getBasePitch = useCallback((soundId: string, variantIndex: number): number => {
    return soundMap[soundId]?.[variantIndex]?.pitch ?? 1
  }, [soundMap])

  const getWaveform = useCallback((soundId: string, variantIndex: number) => {
    return getCachedAudioWaveform(soundId, variantIndex)
  }, [])

  const decodeReferenceAudio = useCallback(async (bytes: Uint8Array): Promise<AudioBuffer> => {
    const copy = Uint8Array.from(bytes).buffer
    return getAudioContext().decodeAudioData(copy)
  }, [getAudioContext])

  const seedReferenceAudio = useCallback((
    trackId: string,
    fingerprint: string,
    byteLength: number,
    dataBase64: string,
    buffer: AudioBuffer,
  ): void => {
    let cached = referenceByFingerprintRef.current.get(fingerprint)
    if (
      !cached
      || cached.byteLength !== byteLength
      || cached.dataBase64 !== dataBase64
      || cached.buffer !== buffer
    ) {
      cached = {
        fingerprint,
        byteLength,
        dataBase64,
        buffer,
        waveform: buildWaveformPeaks(buffer),
      }
      referenceByFingerprintRef.current.set(fingerprint, cached)
    }
    referenceByTrackRef.current.set(trackId, cached)
    referenceErrorsRef.current.delete(trackId)
    setReferenceRevision(value => value + 1)
  }, [])

  const preloadReferenceAudio = useCallback(async (
    tracks: readonly ReferenceAudioTrack[],
  ): Promise<void> => {
    const generation = cacheGenerationRef.current
    const liveIds = new Set(tracks.map(track => track.id))
    for (const id of referenceByTrackRef.current.keys()) {
      if (!liveIds.has(id)) referenceByTrackRef.current.delete(id)
    }
    for (const id of referenceErrorsRef.current.keys()) {
      if (!liveIds.has(id)) referenceErrorsRef.current.delete(id)
    }
    const pendingTracks = tracks.filter(track => (
      referenceByTrackRef.current.get(track.id)?.fingerprint !== track.fingerprint
      || referenceByTrackRef.current.get(track.id)?.byteLength !== track.byteLength
      || referenceByTrackRef.current.get(track.id)?.dataBase64 !== track.dataBase64
    ))
    const jobs = pendingTracks.map(async (track) => {
      let cached = referenceByFingerprintRef.current.get(track.fingerprint)
      if (
        cached
        && (cached.byteLength !== track.byteLength || cached.dataBase64 !== track.dataBase64)
      ) cached = undefined
      if (!cached) {
        let pending = referencePendingRef.current.get(track.fingerprint)
        if (
          !pending
          || pending.byteLength !== track.byteLength
          || pending.dataBase64 !== track.dataBase64
        ) {
          const promise = (async () => {
            const bytes = decodeReferenceAudioBase64(track.dataBase64, track.byteLength)
            const buffer = await decodeReferenceAudio(bytes)
            return {
              fingerprint: track.fingerprint,
              byteLength: track.byteLength,
              dataBase64: track.dataBase64,
              buffer,
              waveform: buildWaveformPeaks(buffer),
            }
          })()
          pending = { byteLength: track.byteLength, dataBase64: track.dataBase64, promise }
          referencePendingRef.current.set(track.fingerprint, pending)
          const remove = () => {
            if (referencePendingRef.current.get(track.fingerprint)?.promise === promise) {
              referencePendingRef.current.delete(track.fingerprint)
            }
          }
          void promise.then(remove, remove)
        }
        cached = await pending.promise
        if (cacheGenerationRef.current !== generation) return
        referenceByFingerprintRef.current.set(track.fingerprint, cached)
      }
      if (cacheGenerationRef.current !== generation) return
      referenceByTrackRef.current.set(track.id, cached)
      referenceErrorsRef.current.delete(track.id)
    })
    if (jobs.length === 0) return
    preloadCountRef.current += 1
    setPreloading(true)
    const results = await Promise.allSettled(jobs)
    if (cacheGenerationRef.current !== generation) return
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        referenceErrorsRef.current.set(pendingTracks[index].id, String(result.reason))
      }
    })
    preloadCountRef.current = Math.max(0, preloadCountRef.current - 1)
    if (preloadCountRef.current === 0) setPreloading(false)
    setReferenceRevision(value => value + 1)
  }, [decodeReferenceAudio])

  const getReferenceBuffer = useCallback((trackId: string): AudioBuffer | undefined => (
    referenceByTrackRef.current.get(trackId)?.buffer
  ), [])

  const getReferenceWaveform = useCallback((trackId: string): WaveformPeaks | undefined => (
    referenceByTrackRef.current.get(trackId)?.waveform
  ), [])

  const getReferenceError = useCallback((trackId: string): string | undefined => (
    referenceErrorsRef.current.get(trackId)
  ), [])

  const clear = useCallback(() => {
    cacheGenerationRef.current += 1
    preloadCountRef.current = 0
    setPreloading(false)
    cacheRef.current.clear()
    pendingRef.current.clear()
    referenceByFingerprintRef.current.clear()
    referenceByTrackRef.current.clear()
    referenceErrorsRef.current.clear()
    referencePendingRef.current.clear()
    clearCachedAudioWaveforms()
    setReferenceRevision(value => value + 1)
  }, [])

  // アンマウント時に AudioContext を閉じる
  useEffect(() => {
    const cache = cacheRef.current
    const pending = pendingRef.current
    const referenceByFingerprint = referenceByFingerprintRef.current
    const referenceByTrack = referenceByTrackRef.current
    const referenceErrors = referenceErrorsRef.current
    const referencePending = referencePendingRef.current
    return () => {
      if (ctxRef.current) {
        ctxRef.current.close().catch(() => {})
        ctxRef.current = null
      }
      cacheGenerationRef.current += 1
      cache.clear()
      pending.clear()
      referenceByFingerprint.clear()
      referenceByTrack.clear()
      referenceErrors.clear()
      referencePending.clear()
      clearCachedAudioWaveforms()
    }
  }, [])

  return useMemo(
    () => ({
      preload,
      getBuffer,
      getWaveform,
      getVariantCount,
      getBasePitch,
      getAudioContext,
      decodeReferenceAudio,
      seedReferenceAudio,
      preloadReferenceAudio,
      getReferenceBuffer,
      getReferenceWaveform,
      getReferenceError,
      referenceRevision,
      clear,
      clearForProjectSwitch: clear,
      preloading,
    }),
    [
      preload,
      getBuffer,
      getWaveform,
      getVariantCount,
      getBasePitch,
      getAudioContext,
      decodeReferenceAudio,
      seedReferenceAudio,
      preloadReferenceAudio,
      getReferenceBuffer,
      getReferenceWaveform,
      getReferenceError,
      referenceRevision,
      clear,
      preloading,
    ],
  )
}
