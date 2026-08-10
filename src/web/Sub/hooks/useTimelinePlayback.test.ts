import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDefaultTrack,
  DEFAULT_SETTINGS,
  MAX_MARKER_PITCH,
  MIN_MARKER_PITCH,
  type Marker,
} from '../types/timeline'
import { buildTempoMap } from '../utils/tempoMap'
import {
  canRestartLoop,
  enumerateMarkerFirings,
  resolveMarkerPan,
  resolveMetronomeEvents,
  resolveReferencePlaybackWindow,
  replaceTransportAnimationFrame,
  resolveMarkerPlaybackRate,
  resolveSoundStopTrackIds,
  scheduleEarliestSourceStop,
  type SourceStopTarget,
} from './useTimelinePlayback'

afterEach(() => vi.unstubAllGlobals())

describe('WebAudio marker playback rate', () => {
  it('passes bounded extended pitch and base-pitch multiplication through exactly', () => {
    expect(resolveMarkerPlaybackRate(MIN_MARKER_PITCH, 1)).toBe(MIN_MARKER_PITCH)
    expect(resolveMarkerPlaybackRate(MAX_MARKER_PITCH, 0.75)).toBe(192)
    expect(resolveMarkerPlaybackRate(64, 1.25)).toBe(80)
  })

  it('rejects unsafe marker/base rates instead of silently clamping them', () => {
    expect(resolveMarkerPlaybackRate(MIN_MARKER_PITCH / 2, 1)).toBeNull()
    expect(resolveMarkerPlaybackRate(MAX_MARKER_PITCH * 2, 1)).toBeNull()
    expect(resolveMarkerPlaybackRate(1, 0)).toBeNull()
    expect(resolveMarkerPlaybackRate(1, Number.NaN)).toBeNull()
  })
})

describe('timeline pan routing', () => {
  it('keeps marker pan independent for the normal cascade law', () => {
    expect(resolveMarkerPan('cascade', 0.8, -0.4)).toBe(0.8)
    expect(resolveMarkerPan(undefined, -2, 1)).toBe(-1)
  })

  it('matches Note Block Studio note/layer averaging', () => {
    expect(resolveMarkerPan('nbs-average', 0.8, 0)).toBe(0.8)
    expect(resolveMarkerPan('nbs-average', 0.8, -0.4)).toBeCloseTo(0.2)
    expect(resolveMarkerPan('nbs-average', undefined, 0.6)).toBeCloseTo(0.3)
  })
})

describe('reference audio transport synchronization', () => {
  it('starts a future clip at its timeline offset', () => {
    expect(resolveReferencePlaybackWindow(40, 10, 0, 200)).toEqual({
      delaySeconds: 2,
      sourceOffsetSeconds: 0,
      durationSeconds: 8,
    })
  })

  it('seeks into the source and clips playback at the loop boundary', () => {
    expect(resolveReferencePlaybackWindow(20, 10, 60, 100)).toEqual({
      delaySeconds: 0,
      sourceOffsetSeconds: 2,
      durationSeconds: 2,
    })
  })

  it('does not schedule a clip outside the active transport window', () => {
    expect(resolveReferencePlaybackWindow(200, 4, 0, 100)).toBeNull()
    expect(resolveReferencePlaybackWindow(0, 2, 80, 120)).toBeNull()
  })
})

describe('transport animation loop', () => {
  it('cancels the prior frame before scheduling exactly one replacement on seek', () => {
    const cancel = vi.fn()
    const request = vi.fn(() => 42)
    vi.stubGlobal('cancelAnimationFrame', cancel)
    vi.stubGlobal('requestAnimationFrame', request)
    const callback = vi.fn()

    expect(replaceTransportAnimationFrame(7, true, callback)).toBe(42)
    expect(cancel).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledWith(7)
    expect(request).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledWith(callback)
  })
})

describe('finite NBS loop count', () => {
  it('treats the byte as repeats after the initial pass and zero as infinite', () => {
    expect(canRestartLoop(0, 0)).toBe(true)
    expect(canRestartLoop(0, 10_000)).toBe(true)
    expect(canRestartLoop(1, 0)).toBe(true)
    expect(canRestartLoop(1, 1)).toBe(false)
    expect(canRestartLoop(3, 2)).toBe(true)
    expect(canRestartLoop(3, 3)).toBe(false)
  })
})

describe('Sound Stopper routing', () => {
  it('resolves OpenNBS-compatible one-based inclusive track ranges', () => {
    const tracks = [createDefaultTrack('a'), createDefaultTrack('b'), createDefaultTrack('c')]
    expect(resolveSoundStopTrackIds({ type: 'sound-stop', scope: 'all' }, tracks)).toEqual(['a', 'b', 'c'])
    expect(resolveSoundStopTrackIds({
      type: 'sound-stop', scope: 'track-range', startTrack: 2, endTrack: 99,
    }, tracks)).toEqual(['b', 'c'])
    expect(resolveSoundStopTrackIds({
      type: 'sound-stop', scope: 'track-range', startTrack: 4, endTrack: 5,
    }, tracks)).toEqual([])
  })
})

describe('first-class marker gate', () => {
  const marker = (patch: Partial<Marker> = {}): Marker => ({
    id: 'note', trackId: 'locked-track', tick: 12,
    soundId: 'block.note_block.harp', variantIndex: 0,
    volume: 1, pitch: 1, pan: 0,
    ...patch,
  })

  it('copies one wall-clock gate onto every retrigger without changing the firing span', () => {
    expect(enumerateMarkerFirings(marker({ duration: 4, retriggerInterval: 2, gateTicks: 3 })))
      .toMatchObject([
        { tick: 12, firingIndex: 0, gateTicks: 3 },
        { tick: 14, firingIndex: 1, gateTicks: 3 },
        { tick: 16, firingIndex: 2, gateTicks: 3 },
      ])
    expect(enumerateMarkerFirings(marker({ gateTicks: 0 }))[0].gateTicks).toBeUndefined()
  })

  it('never lets a later gate/stopper call extend an earlier cutoff', () => {
    const stop = vi.fn()
    const target: SourceStopTarget = { node: { stop } }
    expect(scheduleEarliestSourceStop(target, 12)).toBe(true)
    expect(scheduleEarliestSourceStop(target, 20)).toBe(false)
    expect(scheduleEarliestSourceStop(target, 8)).toBe(true)
    expect(stop.mock.calls).toEqual([[12], [8]])
    expect(target.stopAt).toBe(8)
  })
})

describe('tempo-map metronome', () => {
  it('changes beat spacing and accents a mid-measure meter anchor', () => {
    const model = buildTempoMap([
      { tick: 0, bpm: 120, meter: { numerator: 4, denominator: 4 } },
      { tick: 20, bpm: 60 },
      { tick: 45, bpm: 60, meter: { numerator: 3, denominator: 8 } },
    ], DEFAULT_SETTINGS)
    expect(resolveMetronomeEvents(0, 60, model)).toEqual([
      { tick: 0, accent: true },
      { tick: 10, accent: false },
      { tick: 20, accent: false },
      { tick: 40, accent: false },
      { tick: 45, accent: true },
      { tick: 55, accent: false },
    ])
  })
})
