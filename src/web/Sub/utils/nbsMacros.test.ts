import { describe, expect, it } from 'vitest'
import { DEFAULT_MASTER, DEFAULT_SETTINGS, createDefaultTrack, type Marker, type TimelineState } from '../types/timeline'
import {
  NBS_MACRO_PREVIEW_DETAIL_LIMIT,
  NBS_MACRO_SELECTION_LIMIT,
  NBS_MACRO_TYPES,
  applyNbsMacro,
  previewNbsMacro,
  type NbsMacroRequest,
} from './nbsMacros'

function marker(id: string, trackId: string, tick: number, pitch = 1): Marker {
  return {
    id, trackId, tick, pitch, soundId: 'block.note_block.harp',
    variantIndex: -1, volume: 0.8, pan: 0,
  }
}

function project(): TimelineState {
  const tracks = Array.from({ length: 5 }, (_, index) => createDefaultTrack(`track-${index}`, index))
  tracks[4].locked = true
  return {
    projectId: 'macros', randomSeed: 1, targetVersion: '1.21.4', lengthTicks: 200,
    settings: structuredClone(DEFAULT_SETTINGS), master: { ...DEFAULT_MASTER }, tracks,
    markers: [
      marker('a', tracks[0].id, 0), marker('a2', tracks[1].id, 0, 2 ** (4 / 12)),
      marker('b', tracks[0].id, 2), marker('c', tracks[0].id, 4), marker('d', tracks[0].id, 6),
      marker('locked', tracks[4].id, 8),
    ],
  }
}

const selected = new Set(['a', 'a2', 'b', 'c', 'd', 'locked'])

describe('OpenNBS-compatible macro suite', () => {
  it('exposes all 15 official macro actions', () => {
    expect(NBS_MACRO_TYPES).toEqual([
      'tremolo', 'stereo', 'arpeggio', 'portamento', 'vibrato',
      'stagger', 'chorus', 'volume-lfo', 'fade-in', 'fade-out',
      'replace-key', 'set-velocity', 'set-panning', 'set-pitch', 'reset-properties',
    ])
  })

  it('uses editable retrigger and automation data for tremolo', () => {
    const original = project()
    const result = applyNbsMacro(original, selected, { type: 'tremolo', spacing: 1, fade: 'out' })
    expect(original.markers[0].duration).toBeUndefined()
    expect(result.state.markers[0]).toMatchObject({ duration: 1, retriggerInterval: 1 })
    expect(result.state.markers[0].volumeCurve?.keyframes).toEqual([
      { tick: 0, value: 0.8, interpolation: 'linear' },
      { tick: 1, value: 0, interpolation: 'linear' },
    ])
    expect(result.state.markers[2]).toMatchObject({ duration: 1, retriggerInterval: 1 })
    expect(result.warnings.join(' ')).toContain('locked tracks')
  })

  it('applies stereo, chorus, arpeggio, portamento, and vibrato pitch/pan motion', () => {
    const stereo = applyNbsMacro(project(), selected, { type: 'stereo', width: 0.75 }).state
    expect(stereo.markers.slice(0, 5).map(item => item.pan)).toEqual([0.75, 0.75, -0.75, 0.75, -0.75])

    const chorus = applyNbsMacro(project(), new Set(['a', 'a2']), { type: 'chorus' }).state
    expect(chorus.markers[0].pan).toBe(0.4)
    expect(chorus.markers[1].pan).toBe(-0.4)
    expect(chorus.markers[0].pitch).toBeCloseTo(2 ** (5 / 1200), 6)
    expect(chorus.markers[1].pitch).toBeCloseTo(2 ** (4 / 12) * 2 ** (-5 / 1200), 6)

    const arpeggio = applyNbsMacro(project(), selected, { type: 'arpeggio', semitones: [0, 4, 7] }).state
    expect(arpeggio.markers.find(item => item.id === 'b')?.pitch).toBeCloseTo(2 ** (4 / 12), 6)
    expect(arpeggio.markers.find(item => item.id === 'c')?.pitch).toBeCloseTo(2 ** (7 / 12), 6)

    const portamento = applyNbsMacro(project(), selected, { type: 'portamento', cents: 1200 }).state
    expect(portamento.markers.find(item => item.id === 'a')?.pitch).toBe(1)
    expect(portamento.markers.find(item => item.id === 'd')?.pitch).toBe(2)

    const vibrato = applyNbsMacro(project(), selected, { type: 'vibrato' }).state
    expect(vibrato.markers.find(item => item.id === 'a')?.pitch).toBeCloseTo(2 ** (40 / 1200), 6)
    expect(vibrato.markers.find(item => item.id === 'c')?.pitch).toBeCloseTo(2 ** (-40 / 1200), 6)
  })

  it('supports stagger, volume LFO, fades, and replace-key', () => {
    const stagger = applyNbsMacro(project(), new Set(['a', 'b', 'c']), {
      type: 'stagger', trackOffsets: [0, 1, 2],
    }).state
    expect(stagger.markers.slice(0, 4).map(item => item.trackId)).toEqual(['track-0', 'track-1', 'track-1', 'track-2'])

    const lfo = applyNbsMacro(project(), selected, { type: 'volume-lfo' }).state
    expect(lfo.markers.slice(0, 5).map(item => item.volume)).toEqual([1, 1, 0.5, 0.25, 0.5])

    const fadeIn = applyNbsMacro(project(), selected, { type: 'fade-in' }).state
    expect(fadeIn.markers.slice(0, 5).map(item => item.volume)).toEqual([0.01, 0.01, 0.27, 0.54, 0.8])
    expect(fadeIn.markers.find(item => item.id === 'd')?.volume).toBe(0.8)
    const fadeOut = applyNbsMacro(project(), selected, { type: 'fade-out' }).state
    expect(fadeOut.markers.slice(0, 5).map(item => item.volume)).toEqual([0.8, 0.8, 0.54, 0.27, 0.01])

    const source = project()
    source.markers[0].pitch = 1.5
    const replaced = applyNbsMacro(source, selected, { type: 'replace-key' }).state
    expect(replaced.markers.slice(0, 5).every(item => item.pitch === 1.5)).toBe(true)
  })

  it('sets velocity, panning and pitch, then resets all note properties', () => {
    let state = applyNbsMacro(project(), selected, { type: 'set-velocity', value: 25 }).state
    expect(state.markers[0].volume).toBe(0.25)
    state = applyNbsMacro(state, selected, { type: 'set-velocity', value: 200, percent: true }).state
    expect(state.markers[0].volume).toBe(0.5)
    state = applyNbsMacro(state, selected, { type: 'set-panning', value: -0.6 }).state
    expect(state.markers[0].pan).toBe(-0.6)
    state = applyNbsMacro(state, selected, { type: 'set-pitch', cents: 700 }).state
    expect(state.markers[0].pitch).toBeCloseTo(2 ** (7 / 12), 6)
    state.markers[0].volumeCurve = { keyframes: [{ tick: 0, value: 0.4, interpolation: 'linear' }] }
    state = applyNbsMacro(state, selected, { type: 'reset-properties' }).state
    expect(state.markers[0]).toMatchObject({ volume: 1, pan: 0, pitch: 1 })
    expect(state.markers[0].volumeCurve).toBeUndefined()
  })

  it('validates unsafe option values for every parameterized transform', () => {
    const invalid: NbsMacroRequest[] = [
      { type: 'stereo', width: 2 },
      { type: 'arpeggio', semitones: [] },
      { type: 'portamento', cents: 1201 },
      { type: 'vibrato', depthCents: -1 },
      { type: 'stagger', trackOffsets: [-1] },
      { type: 'volume-lfo', levels: [1.1] },
      { type: 'set-velocity', value: 101 },
      { type: 'set-panning', value: -2 },
      { type: 'set-pitch', cents: Number.NaN },
    ]
    for (const request of invalid) expect(() => applyNbsMacro(project(), selected, request)).toThrow()
  })

  it('builds an exact deterministic preview without mutating the project', () => {
    const original = project()
    const untouched = structuredClone(original)
    const preview = previewNbsMacro(original, new Set([...selected].reverse()), {
      type: 'tremolo', spacing: 1, fade: 'out',
    })

    expect(original).toEqual(untouched)
    expect(preview).toMatchObject({
      changedCount: 5,
      addedCount: 0,
      deletedCount: 0,
      omittedDetailCount: 0,
    })
    expect(preview.details.map(detail => detail.markerId)).toEqual(['a', 'a2', 'b', 'c', 'd'])
    expect(preview.details[0].differences).toEqual(expect.arrayContaining([
      { field: 'duration', before: null, after: 1 },
      { field: 'retriggerInterval', before: null, after: 1 },
      { field: 'volumeCurve', before: null, after: '2 keyframe(s)' },
    ]))
    expect(preview.result.warnings.join(' ')).toContain('locked tracks')
    expect(preview.result.state.markers.find(item => item.id === 'locked')).toEqual(
      original.markers.find(item => item.id === 'locked'),
    )
  })

  it('reports bounded pitch, volume, pan, and track before/after values', () => {
    const volume = previewNbsMacro(project(), selected, { type: 'set-velocity', value: 25 })
    expect(volume.details[0].differences).toContainEqual({
      field: 'volume', before: 0.8, after: 0.25,
    })

    const pitch = previewNbsMacro(project(), selected, { type: 'set-pitch', cents: 1200 })
    expect(pitch.details[0].differences).toContainEqual({ field: 'pitch', before: 1, after: 2 })

    const pan = previewNbsMacro(project(), selected, { type: 'set-panning', value: -0.5 })
    expect(pan.details[0].differences).toContainEqual({ field: 'pan', before: 0, after: -0.5 })

    const stagger = previewNbsMacro(project(), new Set(['b']), { type: 'stagger', trackOffsets: [1] })
    expect(stagger.details[0].differences).toContainEqual({
      field: 'trackId', before: 'track-0', after: 'track-1',
    })
  })

  it('caps rendered detail rows while retaining exact aggregate counts', () => {
    const source = project()
    source.markers = Array.from({ length: 20 }, (_, index) => marker(
      `marker-${String(index).padStart(2, '0')}`,
      source.tracks[0].id,
      index,
    ))
    const ids = source.markers.map(item => item.id).reverse()
    const preview = previewNbsMacro(source, ids, { type: 'set-panning', value: 0.5 })

    expect(preview.changedCount).toBe(20)
    expect(preview.details).toHaveLength(NBS_MACRO_PREVIEW_DETAIL_LIMIT)
    expect(preview.omittedDetailCount).toBe(20 - NBS_MACRO_PREVIEW_DETAIL_LIMIT)
    expect(preview.details.map(detail => detail.markerId)).toEqual(
      source.markers.slice(0, NBS_MACRO_PREVIEW_DETAIL_LIMIT).map(item => item.id),
    )
  })

  it('rejects oversized selections before transforming or previewing', () => {
    const ids = Array.from({ length: NBS_MACRO_SELECTION_LIMIT + 1 }, (_, index) => `id-${index}`)
    const request = { type: 'set-panning', value: 0 } as const
    expect(() => applyNbsMacro(project(), ids, request)).toThrow(`at most ${NBS_MACRO_SELECTION_LIMIT}`)
    expect(() => previewNbsMacro(project(), ids, request)).toThrow(`at most ${NBS_MACRO_SELECTION_LIMIT}`)
  })
})
