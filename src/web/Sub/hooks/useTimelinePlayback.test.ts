// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDefaultTrack,
  DEFAULT_MASTER,
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
  useTimelinePlayback,
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

  it('schedules adjacent notes across an NBS tempo change using the AudioContext clock', () => {
    const start = vi.fn()
    const node = {
      connect: <T>(next: T) => next,
      disconnect: vi.fn(),
    }
    const parameter = () => ({ value: 0, setTargetAtTime: vi.fn() })
    const context = {
      currentTime: 10,
      resume: vi.fn(),
      destination: node,
      createGain: () => ({ ...node, gain: parameter() }),
      createStereoPanner: () => ({ ...node, pan: parameter() }),
      createDynamicsCompressor: () => ({
        ...node, threshold: parameter(), knee: parameter(), ratio: parameter(), attack: parameter(), release: parameter(),
      }),
      createAnalyser: () => ({ ...node, fftSize: 256, getFloatTimeDomainData: vi.fn() }),
      createBufferSource: () => ({ ...node, playbackRate: parameter(), start, stop: vi.fn() }),
    }
    const cache = {
      getAudioContext: () => context,
      getBuffer: () => ({}),
      getBasePitch: () => 1,
    } as unknown as Parameters<typeof useTimelinePlayback>[0]['cache']
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const { result, unmount } = renderHook(() => useTimelinePlayback({
      cache,
      randomSeed: 1,
      master: DEFAULT_MASTER,
      lengthTicks: 4,
      settings: { ...DEFAULT_SETTINGS, ticksPerQuarter: 4, bpm: 555 },
      tempoMap: [{ tick: 2, bpm: 900 }],
      tracks: [createDefaultTrack('track')],
      markers: [1, 3].map(tick => ({
        id: `note-${tick}`, trackId: 'track', tick, soundId: 'block.note_block.harp',
        variantIndex: 0, volume: 1, pitch: 1,
      })),
    }))
    act(() => result.current.play())
    expect(start).toHaveBeenCalledTimes(2)
    expect(start.mock.calls[0][0]).toBeCloseTo(10 + 1 / 37, 12)
    expect(start.mock.calls[1][0]).toBeCloseTo(10 + 2 / 37 + 1 / 60, 12)
    unmount()
  })

  it('seeks into a long retrigger span and schedules its notes and stopper once per loop pass', () => {
    const node = { connect: <T>(next: T) => next, disconnect: vi.fn() }
    const parameter = () => ({ value: 0, setTargetAtTime: vi.fn() })
    const start = vi.fn()
    const stop = vi.fn()
    const context = {
      currentTime: 10,
      resume: vi.fn(),
      destination: node,
      createGain: () => ({ ...node, gain: parameter() }),
      createStereoPanner: () => ({ ...node, pan: parameter() }),
      createDynamicsCompressor: () => ({
        ...node, threshold: parameter(), knee: parameter(), ratio: parameter(), attack: parameter(), release: parameter(),
      }),
      createAnalyser: vi.fn(() => ({ ...node, fftSize: 256, getFloatTimeDomainData: vi.fn() })),
      createBufferSource: () => ({ ...node, playbackRate: parameter(), start, stop }),
    }
    const cache = {
      getAudioContext: () => context,
      getBuffer: () => ({}),
      getBasePitch: () => 1,
    } as unknown as Parameters<typeof useTimelinePlayback>[0]['cache']
    let frame: FrameRequestCallback = () => undefined
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    const note: Marker = {
      id: 'long-note', trackId: 'track', tick: 0, soundId: 'block.note_block.harp',
      variantIndex: 0, volume: 1, pitch: 1, duration: 10_000_000, retriggerInterval: 2,
    }
    const params: Parameters<typeof useTimelinePlayback>[0] = {
      cache,
      randomSeed: 1,
      master: DEFAULT_MASTER,
      lengthTicks: 10_000_001,
      settings: {
        ...DEFAULT_SETTINGS,
        loop: { enabled: true, startTick: 100_000, endTick: 100_008, maxLoopCount: 1 },
      },
      tracks: [createDefaultTrack('track'), createDefaultTrack('stopper'), createDefaultTrack('silent')],
      markers: [
        note,
        { ...note, id: 'stop', trackId: 'stopper', tick: 100_006, action: { type: 'sound-stop', scope: 'all' } },
      ],
    }
    const { result, unmount } = renderHook(() => useTimelinePlayback(params))
    act(() => result.current.seek(100_003))
    act(() => result.current.play())
    expect(start).toHaveBeenCalledTimes(1)
    expect(start.mock.calls[0][0]).toBeCloseTo(10.05)
    expect(context.createAnalyser).toHaveBeenCalledTimes(2)

    context.currentTime = 10.07
    act(() => frame(200))
    expect(start).toHaveBeenCalledTimes(2)
    expect(start.mock.calls[1][0]).toBeCloseTo(10.15)
    expect(stop.mock.calls.map(([time]) => time)).toEqual([10.15, 10.15])
    expect(result.current.getCurrentTick()).toBeCloseTo(100_004.4)
    act(() => frame(210))
    expect(start).toHaveBeenCalledTimes(2)

    context.currentTime = 10.26
    act(() => frame(400))
    expect(result.current.getCurrentTick()).toBe(100_000)
    expect(start).toHaveBeenCalledTimes(4)
    expect(start.mock.calls[2][0]).toBeCloseTo(10.26)
    expect(start.mock.calls[3][0]).toBeCloseTo(10.36)
    unmount()
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
