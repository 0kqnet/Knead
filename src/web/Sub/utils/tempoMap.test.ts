import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SETTINGS,
  MAX_TEMPO_MAP_EVENTS,
  type TempoMapEvent,
} from '../types/timeline'
import {
  buildTempoMap,
  enumerateTempoGridLines,
  formatMusicalPosition,
  musicalBarToTick,
  musicalBeatToTick,
  normalizeTempoMap,
  secondsToTick,
  snapTickToTempoMap,
  tempoAtTick,
  tickToMusicalBar,
  tickToMusicalBeat,
  tickToSeconds,
  validateTempoMap,
} from './tempoMap'

const fallback = {
  bpm: 120,
  timeSignature: { numerator: 4, denominator: 4 as const },
}

const changes: TempoMapEvent[] = [
  { tick: 120, bpm: 120, meter: { numerator: 3, denominator: 8 } },
  { tick: 40, bpm: 60 },
]

describe('tempo-map normalization and validation', () => {
  it('sorts, adds a complete tick-zero event, and canonicalizes inherited meters', () => {
    expect(normalizeTempoMap(changes, fallback)).toEqual([
      { tick: 0, bpm: 120, meter: { numerator: 4, denominator: 4 } },
      { tick: 40, bpm: 60 },
      { tick: 120, bpm: 120, meter: { numerator: 3, denominator: 8 } },
    ])
    expect(normalizeTempoMap([
      { tick: 0, bpm: 100, meter: { numerator: 4, denominator: 4 } },
      { tick: 20, bpm: 90, meter: { numerator: 4, denominator: 4 } },
      { tick: 20, bpm: 80 },
    ], fallback)).toEqual([
      { tick: 0, bpm: 100, meter: { numerator: 4, denominator: 4 } },
      { tick: 20, bpm: 80 },
    ])
  })

  it('enforces BPM, meter, tick, uniqueness, and event-count budgets', () => {
    expect(validateTempoMap([{ tick: 0, bpm: 19 }], fallback)).toMatch(/BPM/)
    expect(validateTempoMap([{ tick: 0.5, bpm: 120 }], fallback)).toMatch(/integer/)
    expect(validateTempoMap([{
      tick: 0, bpm: 120, meter: { numerator: 4, denominator: 3 },
    }], fallback)).toMatch(/denominator/)
    expect(validateTempoMap([
      { tick: 0, bpm: 120 }, { tick: 0, bpm: 100 },
    ], fallback, { requireSortedUnique: true })).toMatch(/more than one/)
    expect(validateTempoMap(Array.from({ length: MAX_TEMPO_MAP_EVENTS + 1 }, (_, tick) => ({
      tick, bpm: 120,
    })), fallback)).toMatch(/exceeds/)
  })
})

describe('piecewise musical-time integration', () => {
  const model = buildTempoMap(changes, fallback)

  it('keeps tick/seconds fixed at 20 TPS while tempo changes musical positions', () => {
    expect(tickToSeconds(40)).toBe(2)
    expect(secondsToTick(2)).toBe(40)
    expect(tickToMusicalBeat(40, model)).toBeCloseTo(4)
    expect(tickToMusicalBeat(120, model)).toBeCloseTo(8)
    expect(tickToMusicalBeat(125, model)).toBeCloseTo(9)
    expect(tickToMusicalBar(40, model)).toBeCloseTo(1)
    expect(tickToMusicalBar(120, model)).toBeCloseTo(2)
    expect(tickToMusicalBar(135, model)).toBeCloseTo(3)
  })

  it('inverts integrated beat and bar coordinates at section boundaries', () => {
    for (const tick of [0, 10, 40, 75, 120, 125, 180]) {
      expect(musicalBeatToTick(tickToMusicalBeat(tick, model), model)).toBeCloseTo(tick)
      expect(musicalBarToTick(tickToMusicalBar(tick, model), model)).toBeCloseTo(tick)
    }
    expect(tempoAtTick(119, model)).toEqual({
      bpm: 60, meter: { numerator: 4, denominator: 4 },
    })
    expect(tempoAtTick(120, model)).toEqual({
      bpm: 120, meter: { numerator: 3, denominator: 8 },
    })
    expect(formatMusicalPosition(120, model)).toBe('3.1')
    expect(formatMusicalPosition(125, model)).toBe('3.2')
  })

  it('enumerates bounded metronome/ruler lines across tempo and meter changes', () => {
    const lines = enumerateTempoGridLines(0, 135, model, 100)
    expect(lines.map(line => line.tick)).toEqual([
      0, 10, 20, 30, 40, 60, 80, 100, 120, 125, 130, 135,
    ])
    expect(lines.filter(line => line.major).map(line => line.tick)).toEqual([0, 40, 120, 135])
    expect(enumerateTempoGridLines(0, 10_000_000, model, 50).length).toBeLessThanOrEqual(52)
  })

  it('snaps against the active piecewise beat grid', () => {
    const settings = structuredClone(DEFAULT_SETTINGS)
    settings.snap = { mode: 'beat', tickStep: 1, beatDivision: 4 }
    expect(snapTickToTempoMap(36, settings, model)).toBe(40)
    expect(snapTickToTempoMap(51, settings, model)).toBe(60)
    expect(snapTickToTempoMap(123, settings, model)).toBe(125)
    expect(snapTickToTempoMap(123, settings, model, true)).toBe(123)
  })

  it('anchors a mid-measure meter change to a new bar and beat', () => {
    const anchored = buildTempoMap([
      { tick: 0, bpm: 120, meter: { numerator: 4, denominator: 4 } },
      { tick: 25, bpm: 120, meter: { numerator: 3, denominator: 4 } },
    ], fallback)
    expect(tickToMusicalBeat(24, anchored)).toBeCloseTo(2.4)
    expect(tickToMusicalBeat(25, anchored)).toBe(3)
    expect(tickToMusicalBar(25, anchored)).toBe(1)
    expect(formatMusicalPosition(25, anchored)).toBe('2.1')
    expect(musicalBeatToTick(2.5, anchored)).toBe(25)
    expect(musicalBeatToTick(3, anchored)).toBe(25)
    expect(musicalBarToTick(1, anchored)).toBe(25)
    const eventLine = enumerateTempoGridLines(0, 40, anchored)
      .find(line => line.tick === 25)
    expect(eventLine).toMatchObject({ major: true, bar: 2, beat: 1 })

    const settings = structuredClone(DEFAULT_SETTINGS)
    settings.snap = { mode: 'beat', tickStep: 1, beatDivision: 4 }
    expect(snapTickToTempoMap(26, settings, anchored)).toBe(25)
  })
})
