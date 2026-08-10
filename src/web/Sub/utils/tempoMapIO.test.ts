import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MASTER,
  DEFAULT_SETTINGS,
  MAX_TEMPO_MAP_EVENTS,
  createDefaultTrack,
  type TimelineState,
} from '../types/timeline'
import { parse, serialize } from './timelineIO'

function state(): TimelineState {
  return {
    projectId: 'tempo-map-project',
    randomSeed: 42,
    targetVersion: '1.21.4',
    lengthTicks: 200,
    settings: structuredClone(DEFAULT_SETTINGS),
    master: { ...DEFAULT_MASTER },
    tracks: [createDefaultTrack('track')],
    markers: [],
    referenceAudio: [],
    customAudio: [],
  }
}

describe('Knead project v10 tempo-map persistence', () => {
  it('serializes a canonical map, extends the range, and mirrors tick zero into legacy settings', () => {
    const project = state()
    project.tempoMap = [
      { tick: 500, bpm: 90, meter: { numerator: 7, denominator: 8 } },
      { tick: 0, bpm: 132, meter: { numerator: 3, denominator: 4 } },
      { tick: 100, bpm: 110, meter: { numerator: 3, denominator: 4 } },
    ]
    const raw = JSON.parse(serialize(project)) as Record<string, unknown>
    expect(raw.version).toBe(10)
    expect(raw.lengthTicks).toBe(501)
    expect(raw.tempoMap).toEqual([
      { tick: 0, bpm: 132, meter: { numerator: 3, denominator: 4 } },
      { tick: 100, bpm: 110 },
      { tick: 500, bpm: 90, meter: { numerator: 7, denominator: 8 } },
    ])
    expect(raw.settings).toMatchObject({
      bpm: 132,
      timeSignature: { numerator: 3, denominator: 4 },
    })

    const parsed = parse(JSON.stringify(raw))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.state.tempoMap).toEqual(raw.tempoMap)
    expect(parsed.state.settings.bpm).toBe(132)
  })

  it.each([1, 2, 3, 4, 5])('migrates a version %i project from its legacy settings', (version) => {
    const raw = JSON.parse(serialize(state()))
    raw.version = version
    delete raw.tempoMap
    raw.settings.bpm = 144
    raw.settings.timeSignature = { numerator: 5, denominator: 8 }
    if (version === 1) {
      const migrated = parse(JSON.stringify({
        format: 'knead-project', version: 1, targetVersion: raw.targetVersion,
        lengthTicks: raw.lengthTicks, markers: [],
      }))
      expect(migrated.ok).toBe(true)
      if (migrated.ok) expect(migrated.state.tempoMap?.[0]).toEqual({
        tick: 0, bpm: 120, meter: { numerator: 4, denominator: 4 },
      })
      return
    }
    const migrated = parse(JSON.stringify(raw))
    expect(migrated.ok).toBe(true)
    if (!migrated.ok) return
    expect(migrated.state.tempoMap).toEqual([{
      tick: 0, bpm: 144, meter: { numerator: 5, denominator: 8 },
    }])
    expect(migrated.warnings.join(' ')).toMatch(/tempo map/)
  })

  it('rejects non-canonical, out-of-range, and over-budget v9 maps', () => {
    const raw = JSON.parse(serialize(state()))
    raw.tempoMap = [{ tick: 10, bpm: 120 }]
    expect(parse(JSON.stringify(raw))).toMatchObject({ ok: false })
    raw.tempoMap = [{ tick: 0, bpm: 120 }, { tick: 0, bpm: 100 }]
    expect(parse(JSON.stringify(raw))).toMatchObject({ ok: false })
    raw.tempoMap = [{ tick: 0, bpm: 120 }, { tick: raw.lengthTicks, bpm: 100 }]
    expect(parse(JSON.stringify(raw))).toMatchObject({ ok: false })
    raw.tempoMap = Array.from({ length: MAX_TEMPO_MAP_EVENTS + 1 }, (_, tick) => ({
      tick, bpm: 120,
    }))
    raw.lengthTicks = MAX_TEMPO_MAP_EVENTS + 2
    raw.settings.loop.endTick = 80
    expect(parse(JSON.stringify(raw))).toMatchObject({ ok: false })
  })
})
