import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  createDefaultTrack,
  getTimelineLengthTicks,
  isTrackAudible,
  snapTick,
  ticksPerBeat,
  type TimelineState,
} from '../types/timeline'
import { parse, serialize } from './timelineIO'
import { sanitizeStemName, stableVariantIndex, stemFileName } from './studioMath'

describe('Knead Studio project v2', () => {
  it('migrates a v1 project into one track', () => {
    const parsed = parse(JSON.stringify({
      format: 'knead-project',
      version: 1,
      targetVersion: '1.21.4',
      lengthTicks: 200,
      markers: [{
        id: 'marker', tick: 20, soundId: 'block.note_block.harp',
        variantIndex: -1, volume: 1, pitch: 1, trackY: 48,
      }],
    }))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.state.tracks).toHaveLength(1)
    expect(parsed.state.markers[0].trackId).toBe(parsed.state.tracks[0].id)
    expect(parsed.state.markers[0].laneY).toBeCloseTo(0.15)
    expect(JSON.parse(serialize(parsed.state)).version).toBe(2)
  })

  it('round-trips mixer and tempo settings', () => {
    const track = createDefaultTrack('track')
    const state: TimelineState = {
      projectId: 'project',
      randomSeed: 42,
      targetVersion: '1.21.4',
      lengthTicks: 240,
      settings: {
        ...structuredClone(DEFAULT_SETTINGS),
        bpm: 128,
        timeSignature: { numerator: 7, denominator: 8 },
      },
      master: { gainDb: -3, limiterEnabled: true, limiterCeilingDb: -1 },
      tracks: [{ ...track, pan: 0.4, solo: true }],
      markers: [{
        id: 'marker', trackId: 'track', tick: 10, soundId: 'test',
        variantIndex: 0, volume: 0.8, pitch: 1, laneY: 0.25,
      }],
    }
    const parsed = parse(serialize(state))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.state.settings.bpm).toBe(128)
    expect(parsed.state.tracks[0].pan).toBe(0.4)
    expect(parsed.state.master.gainDb).toBe(-3)
    expect(parsed.state.markers[0].laneY).toBe(0.25)
  })
})

describe('timeline math', () => {
  it('keeps musical snapping on integer Minecraft ticks', () => {
    const settings = { ...structuredClone(DEFAULT_SETTINGS), bpm: 128 }
    expect(ticksPerBeat(settings)).toBeCloseTo(9.375)
    expect(snapTick(9.375, { ...settings, snap: { ...settings.snap, mode: 'beat', beatDivision: 4 } })).toBe(9)
  })

  it('never shrinks the explicit project end', () => {
    expect(getTimelineLengthTicks([], 480, DEFAULT_SETTINGS)).toBe(480)
  })

  it('applies solo precedence over ordinary tracks', () => {
    const a = createDefaultTrack('a')
    const b = { ...createDefaultTrack('b', 1), solo: true }
    expect(isTrackAudible(a, [a, b])).toBe(false)
    expect(isTrackAudible(b, [a, b])).toBe(true)
    expect(isTrackAudible({ ...b, muted: true }, [a, { ...b, muted: true }])).toBe(false)
  })
})

describe('deterministic exports', () => {
  it('chooses the same random variant every time', () => {
    expect(stableVariantIndex(123, 'marker', 0, 8)).toBe(3)
    expect(stableVariantIndex(123, 'marker', 0, 8)).toBe(3)
  })

  it('sanitizes stem filenames', () => {
    expect(sanitizeStemName('Kick/Lead:*?')).toBe('Kick_Lead___')
    expect(stemFileName(0, 'Kick/Lead', 'wav')).toBe('01_Kick_Lead.wav')
  })
})
