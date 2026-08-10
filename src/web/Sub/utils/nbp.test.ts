import { describe, expect, it } from 'vitest'
import { DEFAULT_MASTER, DEFAULT_SETTINGS, createDefaultTrack, type TimelineState } from '../types/timeline'
import {
  insertNbpPattern,
  nbpToTimelineState,
  parseNbp,
  timelineSelectionToNbp,
  writeNbp,
  type NbpPattern,
} from './nbp'

// OpenNBS/NoteBlockStudio development datafiles/Patterns/Drum Example.nbp
// commit abbf7d52c279e08ce8f12799495bfbfb882280c2 (MIT), SHA-256 12CB1B...FD1.
const officialV1 = Uint8Array.from(Buffer.from(
  'AQ4AAgAPADB8MXwyfDM5fDEwMHwxNDB8NXwxfDJ8MzR8MTAwfDYwfC01fC0xfDJ8MHwzfDU2fDEwMHwxMDB8MHwtMXwyfDF8M3w0NnwxMDB8MTQwfDV8MXwzfDQxfDEwMHw2MHwtNXwtMXwyfDB8M3w1NnwxMDB8MTAwfDB8LTF8MnwxfDJ8Mzl8MTAwfDE0MHw1fDF8MnwzNHwxMDB8NjB8LTV8LTF8MnwwfDN8NTZ8MTAwfDEwMHwwfC0xfDJ8MXwzfDQ2fDEwMHwxNDB8NXwxfDN8NDF8MTAwfDYwfC01fC0xfDJ8MHwzfDU2fDEwMHwxMDB8MHwtMXwAAQL//wAA//8BAv//AAD//wEC//8AAP//AQL//wAA',
  'base64',
))

const customPattern: NbpPattern = {
  version: 2,
  songLength: 8,
  songHeight: 2,
  selectionLength: 9,
  columns: [],
  notes: [
    { tick: 0, layer: 0, instrument: 0, key: 45, velocity: 90, panning: 100, pitch: 0 },
    { tick: 8, layer: 2, instrument: 20, key: 57, velocity: 70, panning: 150, pitch: -25 },
  ],
  customInstruments: [
    { sourceIndex: 20, name: 'Voice', file: 'voices/voice.ogg', key: 57, pressKey: true },
  ],
}

function project(): TimelineState {
  const track = createDefaultTrack('track')
  return {
    projectId: 'project',
    randomSeed: 1,
    targetVersion: '1.21.4',
    lengthTicks: 200,
    settings: structuredClone(DEFAULT_SETTINGS),
    master: { ...DEFAULT_MASTER },
    tracks: [track],
    markers: [
      {
        id: 'harp', trackId: track.id, tick: 12, soundId: 'block.note_block.harp',
        variantIndex: -1, volume: 0.8, pitch: 1, pan: -0.25,
      },
      {
        id: 'custom', trackId: track.id, tick: 16, soundId: 'example:voice',
        variantIndex: -1, volume: 0.6, pitch: 2 ** (3.25 / 12), pan: 0.5,
      },
    ],
  }
}

describe('NBP v1/v2 codec', () => {
  it('parses the official OpenNBS v1 pattern fixture', () => {
    const parsed = parseNbp(officialV1)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.warnings).toEqual([])
    expect(parsed.pattern).toMatchObject({
      version: 1, songLength: 14, songHeight: 2, selectionLength: 15,
    })
    expect(parsed.pattern.notes).toHaveLength(12)
    expect(parsed.pattern.notes[0]).toEqual({
      tick: 0, layer: 1, instrument: 2, key: 39, velocity: 100, panning: 140, pitch: 5,
    })
    expect(parsed.pattern.notes.at(-1)?.tick).toBe(14)
    expect(writeNbp(parsed.pattern, 1).data).toEqual(officialV1)
  })

  it('round-trips v2 custom definitions and note attributes', () => {
    const written = writeNbp(customPattern)
    expect(written.warnings).toEqual([])
    const parsed = parseNbp(written.data)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.warnings).toEqual([])
    expect(parsed.pattern.notes).toEqual(customPattern.notes)
    expect(parsed.pattern.customInstruments).toEqual(customPattern.customInstruments)
    expect(parsed.pattern.columns[8]).toEqual({ first: 2, last: 2 })
  })

  it('warns when down-saving custom instruments to v1', () => {
    const written = writeNbp(customPattern, 1)
    expect(written.warnings.join(' ')).toContain('cannot embed')
    const parsed = parseNbp(written.data)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.pattern.version).toBe(1)
    expect(parsed.pattern.customInstruments).toEqual([])
    expect(parsed.warnings.join(' ')).toContain('destination song')
  })

  it('rejects unsafe sizes, truncated strings, and malformed note code', () => {
    expect(parseNbp(new Uint8Array()).ok).toBe(false)
    expect(parseNbp(new Uint8Array(8 * 1024 * 1024 + 1)).ok).toBe(false)
    expect(parseNbp(Uint8Array.from([2, 0, 0, 0, 0, 1, 0, 0x31])).ok).toBe(false)
    expect(parseNbp(Uint8Array.from([1, 0, 0, 0, 0, 1, 0, ...Buffer.from('0|0|0|99|1|100|0|-1|\0'), -1, -1])).ok).toBe(false)
  })
})

describe('NBP timeline conversion', () => {
  it('exports selected markers relative to the selection and restores their core note values', () => {
    const exported = timelineSelectionToNbp(project(), new Set(['harp', 'custom']))
    expect(exported.pattern.selectionLength).toBe(5)
    expect(exported.pattern.notes.map(note => note.tick)).toEqual([0, 4])
    expect(exported.pattern.customInstruments).toMatchObject([{ sourceIndex: 20, file: 'example_voice.ogg' }])
    const parsed = parseNbp(exported.data)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const restored = nbpToTimelineState(parsed.pattern, '1.21.4')
    expect(restored.state.markers[0]).toMatchObject({ soundId: 'block.note_block.harp', volume: 0.8, pan: -0.25 })
    expect(restored.state.markers[1].soundId).toBe('nbs:custom/example_voice')
    expect(restored.state.markers[1].pitch).toBeCloseTo(2 ** (3.25 / 12), 4)
    expect(restored.state.markers.every(marker => !Object.hasOwn(marker, 'gateTicks'))).toBe(true)
  })

  it('carries authored definition fields and bakes default sample pitch into NBP notes', () => {
    const state = project()
    state.customInstruments = [{
      id: 'voice-definition', kind: 'audio', soundId: 'example:voice',
      name: 'Epic Voice', file: 'voices/epic.ogg', key: 40, pressKey: false,
      defaultPitch: 0.5,
    }]
    const exported = timelineSelectionToNbp(state, new Set(['custom']))
    expect(exported.pattern.customInstruments).toMatchObject([{
      name: 'Epic Voice', file: 'voices/epic.ogg', key: 40, pressKey: false,
    }])
    expect(exported.warnings.join('\n')).toMatch(/sound ID.*not stored/i)
    expect(exported.warnings.join('\n')).toMatch(/default sample pitch.*baked/i)
    const restored = nbpToTimelineState(exported.pattern)
    expect(restored.state.customInstruments).toMatchObject([{
      kind: 'audio', soundId: 'nbs:custom/voices/epic', name: 'Epic Voice',
      file: 'voices/epic.ogg', key: 40, pressKey: false, defaultPitch: 1,
    }])
    expect(restored.state.markers[0].pitch).toBeCloseTo(state.markers[1].pitch * 0.5, 4)
  })

  it('keeps an existing definition and warns on NBP insertion collisions', () => {
    const state = project()
    state.customInstruments = [{
      id: 'existing', kind: 'audio', soundId: 'nbs:custom/voices/voice',
      name: 'Existing Voice', file: 'existing.ogg', key: 45, pressKey: true, defaultPitch: 1,
    }]
    const inserted = insertNbpPattern(state, customPattern, { startTick: 20, startTrackIndex: 0 })
    expect(inserted.state.customInstruments).toEqual(state.customInstruments)
    expect(inserted.warnings.join('\n')).toMatch(/collided.*existing.*kept/i)
  })

  it('honors the 255-definition project cap when inserting NBP definitions', () => {
    const state = project()
    state.customInstruments = Array.from({ length: 255 }, (_, index) => ({
      id: `existing-${index}`,
      kind: 'audio' as const,
      soundId: `knead:custom/existing_${index}`,
      name: `Existing ${index}`,
      file: `existing_${index}.ogg`,
      key: 45,
      pressKey: true,
      defaultPitch: 1,
    }))
    const inserted = insertNbpPattern(state, customPattern, { startTick: 20, startTrackIndex: 0 })
    expect(inserted.state.customInstruments).toHaveLength(255)
    expect(inserted.warnings.join('\n')).toMatch(/project custom-instrument limit.*omitted/i)
  })

  it('counts selected marker gate lengths that NBP cannot represent', () => {
    const state = project()
    const first = state.markers[0]
    first.gateTicks = 6
    const naturalTail = state.markers[1]
    naturalTail.gateTicks = 0

    const exported = timelineSelectionToNbp(state, new Set(['harp', 'custom']))

    expect(exported.pattern.notes).toHaveLength(2)
    expect(exported.warnings).toContain(
      '1 marker gate length(s) are not represented by NBP patterns.',
    )
  })

  it('inserts patterns at a requested tick and creates enough destination tracks', () => {
    const base = project()
    base.markers = []
    const inserted = insertNbpPattern(base, customPattern, { startTick: 40, startTrackIndex: 1 })
    expect(inserted.state.tracks).toHaveLength(4)
    expect(inserted.state.markers.map(marker => marker.tick)).toEqual([40, 48])
    expect(inserted.insertedMarkerIds).toHaveLength(2)
    expect(inserted.state.markers[1].soundId).toBe('nbs:custom/voices/voice')
    expect(inserted.state.markers[1].pitch).toBeCloseTo(2 ** (23.75 / 12))
    expect(inserted.warnings.join('\n')).not.toMatch(/pitch range.*clamped/i)
  })

  it('round-trips Sound Stopper ranges as an NBP v2 functional instrument', () => {
    const state = project()
    state.markers = [{
      id: 'stop',
      trackId: state.tracks[0].id,
      tick: 24,
      soundId: '',
      variantIndex: -1,
      volume: 1,
      pitch: 1,
      pan: 0,
      action: {
        type: 'sound-stop', scope: 'track-range', startTrack: 1, endTrack: 32_767,
      },
    }]
    const exported = timelineSelectionToNbp(state)
    expect(exported.pattern.customInstruments).toMatchObject([{
      name: 'Sound Stopper', file: '', key: 45, pressKey: false,
    }])
    expect(exported.pattern.notes[0]).toMatchObject({
      velocity: 227, panning: 99, pitch: 1,
    })
    const parsed = parseNbp(exported.data)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const restored = nbpToTimelineState(parsed.pattern)
    expect(restored.state.markers[0]).toMatchObject({
      soundId: '',
      action: {
        type: 'sound-stop', scope: 'track-range', startTrack: 1, endTrack: 32_767,
      },
    })
  })

  it('imports exact-name Tempo Changers as conductor events and uses the highest unlocked layer', () => {
    const pattern: NbpPattern = {
      version: 2,
      songLength: 8,
      songHeight: 1,
      selectionLength: 9,
      columns: [],
      notes: [
        { tick: 4, layer: 0, instrument: 20, key: 39, velocity: 100, panning: 100, pitch: 150 },
        { tick: 4, layer: 1, instrument: 20, key: 39, velocity: 100, panning: 100, pitch: 240 },
        { tick: 8, layer: 0, instrument: 0, key: 45, velocity: 100, panning: 100, pitch: 0 },
      ],
      customInstruments: [
        { sourceIndex: 20, name: 'Tempo Changer', file: '', key: 45, pressKey: false },
      ],
    }

    const restored = nbpToTimelineState(pattern)

    expect(restored.state.markers).toHaveLength(1)
    expect(restored.state.markers[0]).toMatchObject({ tick: 8, soundId: 'block.note_block.harp' })
    expect(restored.state.tempoMap).toMatchObject([
      { tick: 0, bpm: DEFAULT_SETTINGS.bpm, meter: DEFAULT_SETTINGS.timeSignature },
      { tick: 4, bpm: 240 },
    ])
    expect(restored.warnings.join(' ')).toContain('highest unlocked layer won')
    expect(restored.warnings.join(' ')).not.toContain('could not be resolved')
  })

  it('discriminates the Tempo Changer name case-sensitively', () => {
    const pattern: NbpPattern = {
      version: 2,
      songLength: 0,
      songHeight: 0,
      selectionLength: 1,
      columns: [],
      notes: [
        { tick: 0, layer: 0, instrument: 20, key: 39, velocity: 100, panning: 100, pitch: 180 },
      ],
      customInstruments: [
        { sourceIndex: 20, name: 'tempo changer', file: 'tempo.ogg', key: 45, pressKey: false },
      ],
    }

    const restored = nbpToTimelineState(pattern)

    expect(restored.state.markers).toHaveLength(1)
    expect(restored.state.markers[0].soundId).toBe('nbs:custom/tempo')
    expect(restored.state.tempoMap).toMatchObject([{ tick: 0, bpm: DEFAULT_SETTINGS.bpm }])
  })

  it('merges inserted Tempo Changers without removing a destination meter change', () => {
    const base = project()
    base.markers = []
    base.settings.bpm = 100
    base.settings.timeSignature = { numerator: 3, denominator: 4 }
    base.tempoMap = [
      { tick: 0, bpm: 100, meter: { numerator: 3, denominator: 4 } },
      { tick: 42, bpm: 110, meter: { numerator: 5, denominator: 4 } },
    ]
    const pattern: NbpPattern = {
      version: 2,
      songLength: 2,
      songHeight: 0,
      selectionLength: 3,
      columns: [],
      notes: [
        { tick: 2, layer: 0, instrument: 20, key: 39, velocity: 100, panning: 100, pitch: 180 },
      ],
      customInstruments: [
        { sourceIndex: 20, name: 'Tempo Changer', file: '', key: 45, pressKey: false },
      ],
    }

    const inserted = insertNbpPattern(base, pattern, { startTick: 40, startTrackIndex: 0 })

    expect(inserted.state.markers).toEqual([])
    expect(inserted.state.tempoMap).toMatchObject([
      { tick: 0, bpm: 100, meter: { numerator: 3, denominator: 4 } },
      { tick: 42, bpm: 180, meter: { numerator: 5, denominator: 4 } },
    ])
  })

  it('exports selected conductor changes as portable Tempo Changer notes and round-trips them', () => {
    const state = project()
    state.tempoMap = [
      { tick: 0, bpm: 120, meter: { numerator: 4, denominator: 4 } },
      { tick: 14, bpm: 180 },
      { tick: 16, bpm: 210.5, meter: { numerator: 3, denominator: 4 } },
    ]

    const exported = timelineSelectionToNbp(state, new Set(['harp', 'custom']))
    const definition = exported.pattern.customInstruments.find(instrument => instrument.name === 'Tempo Changer')
    expect(definition).toMatchObject({ file: '', key: 45, pressKey: false })
    const tempoNotes = exported.pattern.notes.filter(note => note.instrument === definition?.sourceIndex)
    expect(tempoNotes).toMatchObject([
      { tick: 2, key: 39, velocity: 100, panning: 100, pitch: 180 },
      { tick: 4, key: 39, velocity: 100, panning: 100, pitch: 211 },
    ])
    expect(exported.warnings.join(' ')).toContain('rounded to whole numbers')
    expect(exported.warnings.join(' ')).toContain('meter event')
    expect(writeNbp(exported.pattern, 1).warnings.join(' ')).toContain('matching destination functional instrument')

    const parsed = parseNbp(exported.data)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const restored = nbpToTimelineState(parsed.pattern)
    expect(restored.state.markers.map(marker => marker.tick)).toEqual([0, 4])
    expect(restored.state.tempoMap).toMatchObject([
      { tick: 0, bpm: DEFAULT_SETTINGS.bpm },
      { tick: 2, bpm: 180 },
      { tick: 4, bpm: 211 },
    ])
    expect(restored.warnings.join(' ')).not.toContain('could not be resolved')
  })

  it('bounds imported Tempo Changers to the project tempo-map limit', () => {
    const noteCount = 4_096
    const pattern: NbpPattern = {
      version: 2,
      songLength: noteCount,
      songHeight: 0,
      selectionLength: noteCount + 1,
      columns: [],
      notes: Array.from({ length: noteCount }, (_, index) => ({
        tick: index + 1,
        layer: 0,
        instrument: 20,
        key: 39,
        velocity: 100,
        panning: 100,
        pitch: 180,
      })),
      customInstruments: [
        { sourceIndex: 20, name: 'Tempo Changer', file: '', key: 45, pressKey: false },
      ],
    }

    const restored = nbpToTimelineState(pattern)

    expect(restored.state.tempoMap).toHaveLength(noteCount)
    expect(restored.state.tempoMap?.at(-1)?.tick).toBe(noteCount - 1)
    expect(restored.warnings.join(' ')).toContain('1 Tempo Changer event(s) exceeded')
  })
})
