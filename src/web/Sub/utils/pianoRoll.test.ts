import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MASTER,
  DEFAULT_SETTINGS,
  createDefaultTrack,
  type Marker,
  type TimelineState,
} from '../types/timeline'
import {
  PIANO_ROLL_MAX_SELECTION,
  applyPianoRollEdits,
  buildPianoRollTickGrid,
  filterPianoRollMarkers,
  fitPianoRollPxPerTick,
  formatPianoRollPitch,
  getPianoRollMarkerRect,
  getPianoRollSpanTicks,
  movePianoRollMarkers,
  pianoRollNoteToPitch,
  pitchToPianoRollNote,
  selectPianoRollMarkersInRect,
  updatePianoRollMarkerFields,
} from './pianoRoll'
import { buildTempoMap } from './tempoMap'

function marker(id: string, trackId = 'track-a', patch: Partial<Marker> = {}): Marker {
  return {
    id,
    trackId,
    tick: 0,
    soundId: `custom:${id}`,
    variantIndex: 3,
    volume: 0.8,
    pitch: 1,
    pan: 0,
    source: {
      format: 'nbs',
      tick: 0,
      layer: 0,
      instrument: 0,
      key: 45,
      velocity: 80,
      panning: 100,
      pitch: 0,
    },
    ...patch,
  }
}

function project(markers: Marker[]): TimelineState {
  const unlocked = createDefaultTrack('track-a')
  const locked = { ...createDefaultTrack('track-locked', 1), locked: true }
  return {
    projectId: 'piano-roll',
    randomSeed: 9,
    targetVersion: '1.21.4',
    lengthTicks: 200,
    settings: structuredClone(DEFAULT_SETTINGS),
    master: { ...DEFAULT_MASTER },
    tracks: [unlocked, locked],
    markers,
    referenceAudio: [],
    customAudio: [],
  }
}

describe('piano roll pitch mapping', () => {
  it('maps the Minecraft pitch range to MIDI C3 through C5', () => {
    expect(pitchToPianoRollNote(0.5)).toMatchObject({ note: 48, cents: 0, name: 'C3' })
    expect(pitchToPianoRollNote(1)).toMatchObject({ note: 60, cents: 0, name: 'C4' })
    expect(pitchToPianoRollNote(2)).toMatchObject({ note: 72, cents: 0, name: 'C5' })
    expect(pianoRollNoteToPitch(60)).toBe(1)
  })

  it('retains and displays microtonal cents', () => {
    const pitch = 2 ** (3.25 / 12)
    expect(pitchToPianoRollNote(pitch)).toMatchObject({ note: 63, cents: 25, name: 'D♯4' })
    expect(formatPianoRollPitch(pitch)).toBe('D♯4 +25¢')
    expect(pianoRollNoteToPitch(63, 25)).toBeCloseTo(pitch)
  })
})

describe('piano roll filtering and geometry', () => {
  const markers = [
    marker('a', 'track-a', { tick: 10, duration: 8 }),
    marker('b', 'track-a', { tick: 20, pitch: 2 }),
    marker('locked', 'track-locked', { tick: 30 }),
  ]

  it('filters by selected IDs or the current track without changing order', () => {
    expect(filterPianoRollMarkers({ markers }, 'selected', new Set(['b', 'locked']), 'track-a').markers
      .map(item => item.id)).toEqual(['b', 'locked'])
    expect(filterPianoRollMarkers({ markers }, 'track', [], 'track-a').markers
      .map(item => item.id)).toEqual(['a', 'b'])
    expect(filterPianoRollMarkers({ markers }, 'track', [], 'track-a', 1)).toMatchObject({
      total: 2,
      truncated: true,
    })
  })

  it('uses duration for note spans and rectangle hit testing', () => {
    const viewport = { startTick: 0, pxPerTick: 4, rowHeight: 20 }
    expect(getPianoRollSpanTicks(markers[0])).toBe(8)
    expect(getPianoRollMarkerRect(markers[0], viewport)).toMatchObject({ left: 40, width: 32 })
    const selected = selectPianoRollMarkersInRect(
      markers,
      { left: 35, top: 230, right: 75, bottom: 270 },
      viewport,
    )
    expect(selected).toEqual(new Set(['a']))
  })

  it('caps rectangle selections before they can create unbounded edits', () => {
    const many = Array.from({ length: PIANO_ROLL_MAX_SELECTION + 10 }, (_, index) => (
      marker(String(index), 'track-a', { tick: 0 })
    ))
    const selected = selectPianoRollMarkersInRect(
      many,
      { left: 0, top: 0, right: 100, bottom: 1_000 },
      { startTick: 0, pxPerTick: 1, rowHeight: 20 },
    )
    expect(selected.size).toBe(PIANO_ROLL_MAX_SELECTION)
  })
})

describe('piano roll editing', () => {
  it('snaps tick movement, transposes pitch, and skips locked tracks', () => {
    const markers = [marker('free', 'track-a', { tick: 11 }), marker('locked', 'track-locked', { tick: 11 })]
    const result = movePianoRollMarkers(markers, {
      markerIds: new Set(['free', 'locked']),
      deltaTick: 6,
      deltaSemitones: 3,
      snapTicks: 5,
      lengthTicks: 200,
      lockedTrackIds: new Set(['track-locked']),
    })
    expect(result.changedIds).toEqual(['free'])
    expect(result.markers[0]).toMatchObject({ tick: 16, pitch: 2 ** (3 / 12) })
    expect(result.markers[0].soundId).toBe('custom:free')
    expect(result.markers[0].variantIndex).toBe(3)
    expect(result.markers[1]).toBe(markers[1])
  })

  it('updates velocity, pan, duration, and retrigger with clamps', () => {
    const markers = [marker('free'), marker('locked', 'track-locked')]
    const result = updatePianoRollMarkerFields(
      markers,
      ['free', 'locked'],
      { volume: 3, pan: -3, duration: 16, retriggerInterval: 0 },
      new Set(['track-locked']),
    )
    expect(result.changedIds).toEqual(['free'])
    expect(result.markers[0]).toMatchObject({ volume: 1, pan: -1, duration: 16, retriggerInterval: 1 })
    expect(result.markers[1]).toBe(markers[1])
  })

  it('moves by musical beats across tempo changes', () => {
    const settings = {
      ...structuredClone(DEFAULT_SETTINGS),
      snap: { ...DEFAULT_SETTINGS.snap, mode: 'beat' as const, beatDivision: 4 as const },
    }
    const tempoMap = [
      { tick: 0, bpm: 120, meter: { numerator: 4 as const, denominator: 4 as const } },
      { tick: 40, bpm: 60 },
    ]
    const result = movePianoRollMarkers([marker('free', 'track-a', { tick: 43 })], {
      markerIds: ['free'],
      deltaTick: 0,
      deltaBeats: 1,
      deltaSemitones: 0,
      snapTicks: 20,
      lengthTicks: 200,
      lockedTrackIds: new Set(),
      settings,
      tempoModel: buildTempoMap(tempoMap, settings),
    })

    expect(result.markers[0].tick).toBe(60)
  })

  it('applies only editable musical fields and preserves arbitrary sound provenance', () => {
    const original = marker('free', 'track-a', { tick: 10 })
    const locked = marker('locked', 'track-locked', { tick: 10 })
    const state = project([original, locked])
    state.tempoMap = [
      { tick: 0, bpm: 120, meter: { numerator: 4, denominator: 4 } },
      { tick: 250, bpm: 90 },
    ]
    const maliciousEdit: Marker = {
      ...original,
      tick: 25,
      pitch: 1.5,
      soundId: 'changed:illegally',
      variantIndex: -1,
      trackId: 'track-a',
      source: undefined,
    }
    const lockedEdit = { ...locked, tick: 30, pitch: 2 }
    const result = applyPianoRollEdits(state, [maliciousEdit, lockedEdit])

    expect(result.changedIds).toEqual(['free'])
    expect(result.state.markers[0]).toMatchObject({
      tick: 25,
      pitch: 1.5,
      soundId: 'custom:free',
      variantIndex: 3,
      source: original.source,
    })
    expect(result.state.markers[1]).toBe(locked)
    expect(result.state.lengthTicks).toBe(251)
    expect(state.markers[0]).toBe(original)
  })
})

describe('piano roll grid and fit', () => {
  it('labels tick, beat, and bar grid lines at 20 TPS', () => {
    const grid = buildPianoRollTickGrid(0, 45, DEFAULT_SETTINGS)
    expect(grid.find(line => line.tick === 0)?.kind).toBe('bar')
    expect(grid.find(line => line.tick === 10)?.kind).toBe('beat')
    expect(grid.find(line => line.tick === 40)?.kind).toBe('bar')
    expect(grid.find(line => line.tick === 1)?.kind).toBe('tick')
  })

  it('anchors bar and beat grid lines to tempo-map changes', () => {
    const settings = {
      ...structuredClone(DEFAULT_SETTINGS),
      snap: { ...DEFAULT_SETTINGS.snap, mode: 'beat' as const, beatDivision: 4 as const },
    }
    const grid = buildPianoRollTickGrid(0, 110, settings, [
      { tick: 0, bpm: 120, meter: { numerator: 4, denominator: 4 } },
      { tick: 40, bpm: 60, meter: { numerator: 3, denominator: 4 } },
    ])

    expect(grid.find(line => line.tick === 40)?.kind).toBe('bar')
    expect(grid.find(line => line.tick === 60)?.kind).toBe('beat')
    expect(grid.find(line => line.tick === 100)?.kind).toBe('bar')
  })

  it('fits the visible note span to the available width', () => {
    const fitted = fitPianoRollPxPerTick([marker('a', 'track-a', { tick: 20, duration: 20 })], 400, 200)
    expect(fitted).toBe(10)
  })
})
