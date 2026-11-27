import { describe, expect, it } from 'vitest'
import { createDefaultTrack, DEFAULT_MASTER, DEFAULT_SETTINGS, type TimelineState } from '../types/timeline'
import {
  decodeSoundStopAction,
  encodeSoundStopEnd,
  nbsToTimelineState,
  parseNbs,
  timelineStateToNbs,
  writeNbs,
  writeNbsWithWarnings,
  type NbsInstrument,
  type NbsSong,
  type NbsTargetVersion,
} from './nbs'
import { buildTempoMap, tickToSeconds } from './tempoMap'
import { parse, serialize } from './timelineIO'

const song: NbsSong = {
  header: {
    version: 5, vanillaInstrumentCount: 16, songLength: 31, layerCount: 2,
    name: 'Roundtrip', author: 'Knead', originalAuthor: '', description: 'Test',
    tempo: 1000, autoSave: false, autoSaveDuration: 10, timeSignature: 4,
    minutesSpent: 1, leftClicks: 2, rightClicks: 3, blocksAdded: 4, blocksRemoved: 5,
    sourceFile: '', loop: true, maxLoopCount: 0, loopStartTick: 4,
  },
  notes: [
    { tick: 0, layer: 0, instrument: 0, key: 45, velocity: 80, panning: 100, pitch: 0 },
    { tick: 3, layer: 1, instrument: 7, key: 57, velocity: 100, panning: 150, pitch: -25 },
  ],
  layers: [
    { name: 'Lead', locked: false, volume: 90, panning: 100 },
    { name: 'Bell', locked: true, volume: 60, panning: 140 },
  ],
  customInstruments: [{ name: 'Custom', file: 'folder/custom.ogg', key: 45, pressKey: true }],
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

describe('NBS v5 compatibility', () => {
  it('round-trips header, notes, layers, and custom instruments', () => {
    const parsed = parseNbs(toArrayBuffer(writeNbs(song)))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.song.header.name).toBe('Roundtrip')
    expect(parsed.song.header.loopStartTick).toBe(4)
    expect(parsed.song.notes).toEqual(song.notes)
    expect(parsed.song.layers).toEqual(song.layers)
    expect(parsed.song.customInstruments).toEqual(song.customInstruments)
  })

  it('reads and writes the official single-byte string representation', () => {
    const latinSong = { ...song, header: { ...song.header, name: 'Café' } }
    const parsed = parseNbs(toArrayBuffer(writeNbs(latinSong)))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.song.header.name).toBe('Café')
  })

  it('normalizes the official N/4 time-signature byte to its 2..8 range', () => {
    const encoded = writeNbsWithWarnings({
      ...song,
      header: { ...song.header, timeSignature: 255 },
    })
    expect(encoded.warnings).toContain('NBS time signature 255/4 was clamped to 8/4.')
    const parsed = parseNbs(toArrayBuffer(encoded.data))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.song.header.timeSignature).toBe(8)
  })

  it('rejects truncated and unsupported files', () => {
    expect(parseNbs(new Uint8Array([0]).buffer).ok).toBe(false)
    expect(parseNbs(new Uint8Array([0, 0, 99, 16]).buffer).ok).toBe(false)
    expect(parseNbs(new ArrayBuffer(16 * 1024 * 1024 + 1)).ok).toBe(false)
  })

  it('maps NBS tempo, layers, instruments, and pitch into a Knead project', () => {
    const converted = nbsToTimelineState(song, '1.21.4')
    expect(converted.state.tracks).toHaveLength(2)
    expect(converted.state.tracks[1].locked).toBe(true)
    expect(converted.state.markers[0].soundId).toBe('block.note_block.harp')
    expect(converted.state.markers[1].pitch).toBeCloseTo(1.9713, 3)
    expect(converted.state.markers[1].pan).toBe(0.5)
    expect(converted.state.markers[1].tick).toBe(3)
    expect(converted.state.settings.ticksPerQuarter).toBe(4)
    expect(converted.state.settings.loop.startTick).toBe(4)
    expect(converted.state.settings.loop.maxLoopCount).toBe(0)
    expect(converted.state.settings.panLaw).toBe('nbs-average')
    expect(converted.state.metadata).toMatchObject({
      title: 'Roundtrip', author: 'Knead', description: 'Test',
      minutesSpent: 1, leftClicks: 2, blocksRemoved: 5,
    })
    expect(converted.state.source).toMatchObject({
      format: 'nbs', sourceVersion: 5, tickScale: 1, name: 'Roundtrip', author: 'Knead',
    })
    expect(converted.state.tracks[1].source).toEqual({
      format: 'nbs', index: 1, name: 'Bell', locked: true, volume: 60, panning: 140,
    })
    expect(converted.state.markers[1].source).toEqual({ format: 'nbs', ...song.notes[1] })
    expect(converted.state.markers[0]).not.toHaveProperty('gateTicks')
    expect(converted.state.markers[1]).not.toHaveProperty('gateTicks')
  })

  it('preserves adjacent columns at fractional TPS through project and NBS saves', () => {
    const source: NbsSong = {
      ...song,
      header: { ...song.header, tempo: 3333, loopStartTick: 2 },
      notes: [1, 2].map(tick => ({ ...song.notes[0], tick })),
    }
    const { state, warnings } = nbsToTimelineState(source)
    expect(warnings).toEqual([])
    const json = serialize(state)
    expect(JSON.parse(json).version).toBe(11)
    const reopened = parse(json)
    expect(reopened.ok).toBe(true)
    if (!reopened.ok) return
    const restored = reopened.state
    expect(restored.markers.map(marker => marker.tick)).toEqual([1, 2])
    expect(restored.settings.loop).toMatchObject({ startTick: 2, endTick: 32 })
    const model = buildTempoMap(restored.tempoMap, restored.settings)
    expect(tickToSeconds(2, model) - tickToSeconds(1, model)).toBeCloseTo(1 / 33.33, 12)
    restored.tempoMap!.push({ tick: 16, bpm: restored.settings.bpm, meter: { numerator: 3, denominator: 4 } })
    const exported = timelineStateToNbs(restored).song
    expect(exported.header).toMatchObject({ tempo: 3333, songLength: 31, loopStartTick: 2 })
    expect(exported.notes).toEqual(source.notes)
  })

  it('uses the NBS N/4 meter independently from its fixed four ticks per quarter', () => {
    const converted = nbsToTimelineState({
      ...song,
      header: { ...song.header, timeSignature: 3 },
      customInstruments: [{ ...song.customInstruments[0], key: 57 }],
      notes: [
        { tick: 0, layer: 0, instrument: 16, key: 33, velocity: 100, panning: 100, pitch: 0 },
      ],
    })
    expect(converted.state.settings.bpm).toBe(150)
    expect(converted.state.settings.timeSignature).toEqual({ numerator: 3, denominator: 4 })
    expect(converted.state.tempoMap).toEqual([{
      tick: 0, bpm: 150, meter: { numerator: 3, denominator: 4 },
    }])
    expect(converted.state.markers[0].pitch).toBe(1)
  })

  it('imports OpenNBS Tempo Changer notes as a piecewise conductor map', () => {
    const tempoSong: NbsSong = {
      ...song,
      header: {
        ...song.header,
        songLength: 8,
        layerCount: 3,
        tempo: 1000,
        timeSignature: 3,
      },
      layers: [
        { name: 'Notes', locked: false, volume: 100, panning: 100 },
        { name: 'Earlier tempo', locked: false, volume: 100, panning: 100 },
        { name: 'Winning tempo', locked: false, volume: 100, panning: 100 },
      ],
      customInstruments: [{ name: 'Tempo Changer', file: '', key: 45, pressKey: false }],
      notes: [
        { tick: 0, layer: 0, instrument: 0, key: 45, velocity: 100, panning: 100, pitch: 0 },
        { tick: 4, layer: 0, instrument: 0, key: 45, velocity: 100, panning: 100, pitch: 0 },
        { tick: 4, layer: 1, instrument: 16, key: 39, velocity: 100, panning: 100, pitch: 150 },
        { tick: 4, layer: 2, instrument: 16, key: 39, velocity: 100, panning: 100, pitch: 300 },
        { tick: 8, layer: 0, instrument: 0, key: 45, velocity: 100, panning: 100, pitch: 0 },
      ],
    }

    const converted = nbsToTimelineState(tempoSong)

    expect(converted.state.markers.map(marker => marker.tick)).toEqual([0, 4, 8])
    expect(converted.state.tempoMap).toEqual([
      { tick: 0, bpm: 150, meter: { numerator: 3, denominator: 4 } },
      { tick: 4, bpm: 300 },
    ])
    expect(converted.state.source).toMatchObject({
      format: 'nbs',
      tempoChangerNotes: [
        { format: 'nbs', tick: 4, layer: 1, pitch: 150 },
        { format: 'nbs', tick: 4, layer: 2, pitch: 300 },
      ],
    })
    expect(converted.warnings.join('\n')).toMatch(/highest unlocked layer won/i)
    expect(converted.warnings.join('\n')).not.toMatch(/matching sounds/i)
    const model = buildTempoMap(converted.state.tempoMap, converted.state.settings)
    expect(tickToSeconds(4, model)).toBeCloseTo(0.4, 12)
    expect(tickToSeconds(8, model)).toBeCloseTo(0.6, 12)
  })

  it('round-trips a tick-zero rate above the header range and a slow Tempo Changer', () => {
    const source: NbsSong = {
      ...song,
      customInstruments: [{ name: 'Tempo Changer', file: '', key: 45, pressKey: false }],
      notes: [
        { ...song.notes[0], tick: 0, instrument: 16, pitch: -32768 },
        { ...song.notes[0], tick: 1 },
        { ...song.notes[0], tick: 2, instrument: 16, pitch: 3 },
        { ...song.notes[0], tick: 3 },
      ],
    }
    const { state } = nbsToTimelineState(source)
    const exported = timelineStateToNbs(state)
    const reimported = nbsToTimelineState(exported.song).state
    expect(reimported.tempoMap).toEqual(state.tempoMap)
    expect(reimported.markers.map(marker => marker.tick)).toEqual([1, 3])
    const model = buildTempoMap(reimported.tempoMap, reimported.settings)
    expect(tickToSeconds(1, model)).toBeCloseTo(15 / 32768, 12)
    expect(tickToSeconds(3, model)).toBeCloseTo(30 / 32768 + 4, 12)
  })

  it('imports and losslessly writes OpenNBS Sound Stopper functional instruments', () => {
    const stopperSong: NbsSong = {
      ...song,
      header: { ...song.header, version: 6, vanillaInstrumentCount: 20, layerCount: 2 },
      layers: song.layers,
      customInstruments: [{ name: 'Sound Stopper', file: '', key: 45, pressKey: false }],
      notes: [{
        tick: 7,
        layer: 1,
        instrument: 20,
        key: 52,
        velocity: 227,
        panning: 99,
        pitch: 1,
      }],
    }
    const imported = nbsToTimelineState(stopperSong)
    expect(imported.state.markers[0]).toMatchObject({
      soundId: '',
      action: {
        type: 'sound-stop',
        scope: 'track-range',
        startTrack: 1,
        endTrack: 32_767,
      },
    })
    expect(imported.warnings.join('\n')).not.toMatch(/matching sounds/i)

    const exported = timelineStateToNbs(imported.state, 'Stopper', 6)
    expect(exported.song.notes[0]).toEqual(stopperSong.notes[0])
    expect(exported.song.customInstruments).toEqual(stopperSong.customInstruments)
    const reparsed = parseNbs(toArrayBuffer(writeNbs(exported.song, 6)))
    expect(reparsed.ok).toBe(true)
    if (!reparsed.ok) return
    expect(reparsed.song.notes[0]).toEqual(stopperSong.notes[0])
    expect(nbsToTimelineState(reparsed.song).state.markers[0].action).toEqual({
      type: 'sound-stop', scope: 'track-range', startTrack: 1, endTrack: 32_767,
    })
  })

  it('does not reinterpret similarly named ordinary custom instruments', () => {
    const ordinary = nbsToTimelineState({
      ...song,
      customInstruments: [{ name: 'sound stopper', file: 'sound_stopper.ogg', key: 45, pressKey: true }],
      notes: [{ tick: 0, layer: 0, instrument: 16, key: 45, velocity: 100, panning: 100, pitch: 0 }],
    })
    expect(ordinary.state.markers[0].action).toBeUndefined()
    expect(ordinary.state.markers[0].soundId).toBe('nbs:custom/sound_stopper')

    const ordinaryTempoName = nbsToTimelineState({
      ...song,
      customInstruments: [{ name: 'tempo changer', file: 'tempo_changer.ogg', key: 45, pressKey: true }],
      notes: [{ tick: 0, layer: 0, instrument: 16, key: 45, velocity: 100, panning: 100, pitch: 300 }],
    })
    expect(ordinaryTempoName.state.markers[0].soundId).toBe('nbs:custom/tempo_changer')
    expect(ordinaryTempoName.state.tempoMap).toEqual([{
      tick: 0, bpm: 150, meter: { numerator: 4, denominator: 4 },
    }])
  })
})

describe('Knead to NBS conversion', () => {
  it('preserves overlapping notes by creating overflow layers', () => {
    const track = createDefaultTrack('track')
    const state: TimelineState = {
      projectId: 'project', randomSeed: 1, targetVersion: '1.21.4', lengthTicks: 40,
      settings: structuredClone(DEFAULT_SETTINGS), master: { ...DEFAULT_MASTER }, tracks: [track],
      markers: [
        { id: 'a', trackId: track.id, tick: 5, soundId: 'block.note_block.harp', variantIndex: -1, volume: 1, pitch: 1 },
        { id: 'b', trackId: track.id, tick: 5, soundId: 'block.note_block.bell', variantIndex: -1, volume: 0.5, pitch: 2, pan: -0.25 },
      ],
    }
    const converted = timelineStateToNbs(state)
    expect(converted.song.layers).toHaveLength(2)
    expect(converted.song.notes.map(note => note.layer)).toEqual([0, 1])
    expect(converted.song.notes[1].panning).toBe(75)
    expect(parseNbs(toArrayBuffer(writeNbs(converted.song))).ok).toBe(true)
  })

  it('expands retriggers, samples automation, and emits a valid NBS beat grid', () => {
    const track = createDefaultTrack('track')
    const state: TimelineState = {
      projectId: 'project', randomSeed: 1, targetVersion: '1.21.4', lengthTicks: 40,
      settings: structuredClone(DEFAULT_SETTINGS), master: { ...DEFAULT_MASTER, limiterEnabled: false }, tracks: [track],
      markers: [{
        id: 'a', trackId: track.id, tick: 5, soundId: 'block.note_block.harp', variantIndex: -1,
        volume: 1, pitch: 1, duration: 4, retriggerInterval: 2,
        volumeCurve: { keyframes: [
          { tick: 0, value: 1, interpolation: 'linear' },
          { tick: 4, value: 0.5, interpolation: 'linear' },
        ] },
      }],
    }
    const converted = timelineStateToNbs(state, 'Automated', 5)
    expect(converted.song.header.timeSignature).toBe(4)
    expect(converted.song.header.tempo).toBe(800)
    expect(converted.song.notes.map(note => note.tick)).toEqual([2, 3, 4])
    expect(converted.song.notes.map(note => note.velocity)).toEqual([100, 75, 50])
  })

  it('counts marker gate lengths that NBS cannot represent', () => {
    const track = createDefaultTrack('track')
    const state: TimelineState = {
      projectId: 'gated', randomSeed: 1, targetVersion: '1.21.4', lengthTicks: 40,
      settings: structuredClone(DEFAULT_SETTINGS), master: { ...DEFAULT_MASTER }, tracks: [track],
      markers: [
        {
          id: 'gated-a', trackId: track.id, tick: 5, soundId: 'block.note_block.harp',
          variantIndex: -1, volume: 1, pitch: 1,
        },
        {
          id: 'gated-b', trackId: track.id, tick: 6, soundId: 'block.note_block.harp',
          variantIndex: -1, volume: 1, pitch: 1,
        },
        {
          id: 'natural-tail', trackId: track.id, tick: 7, soundId: 'block.note_block.harp',
          variantIndex: -1, volume: 1, pitch: 1,
        },
      ],
    }
    for (const marker of state.markers.slice(0, 2)) {
      marker.gateTicks = 4
    }
    const naturalTail = state.markers[2]
    naturalTail.gateTicks = 0

    const converted = timelineStateToNbs(state)

    expect(converted.song.notes).toHaveLength(3)
    expect(converted.warnings).toContain(
      '2 marker gate length(s) cannot be represented in NBS and were omitted.',
    )
  })

  it('rejects projects that cannot fit the selected NBS tick grid', () => {
    const track = createDefaultTrack('track')
    const state: TimelineState = {
      projectId: 'project', randomSeed: 1, targetVersion: '1.21.4', lengthTicks: 100_000,
      settings: structuredClone(DEFAULT_SETTINGS), master: { ...DEFAULT_MASTER }, tracks: [track], markers: [],
    }
    expect(() => timelineStateToNbs(state)).toThrow(/too long/i)
  })

  it('encodes later tempo events as OpenNBS Tempo Changer notes', () => {
    const track = createDefaultTrack('track')
    const state: TimelineState = {
      projectId: 'tempo-map', randomSeed: 1, targetVersion: '1.21.4', lengthTicks: 200,
      settings: structuredClone(DEFAULT_SETTINGS), master: { ...DEFAULT_MASTER }, tracks: [track],
      markers: [{
        id: 'note', trackId: track.id, tick: 100, soundId: 'block.note_block.harp',
        variantIndex: -1, volume: 1, pitch: 1,
      }],
      tempoMap: [
        { tick: 0, bpm: 150, meter: { numerator: 3, denominator: 4 } },
        { tick: 80, bpm: 60, meter: { numerator: 3, denominator: 4 } },
      ],
    }
    const converted = timelineStateToNbs(state)
    expect(converted.song.header.tempo).toBe(1000)
    expect(converted.song.header.timeSignature).toBe(3)
    expect(converted.song.customInstruments).toContainEqual({
      name: 'Tempo Changer', file: '', key: 45, pressKey: false,
    })
    const tempoInstrument = 16 + converted.song.customInstruments.findIndex(instrument => instrument.name === 'Tempo Changer')
    expect(converted.song.notes).toContainEqual({
      tick: 40, layer: 1, instrument: tempoInstrument, key: 39, velocity: 100, panning: 100, pitch: 60,
    })
    expect(converted.song.notes.find(note => note.instrument === 0)?.tick).toBe(44)
    expect(converted.warnings.join(' ')).not.toMatch(/tempo change.*omitted/i)

    const reimported = nbsToTimelineState(converted.song)
    expect(reimported.state.tempoMap).toEqual([
      { tick: 0, bpm: 150, meter: { numerator: 3, denominator: 4 } },
      { tick: 40, bpm: 60 },
    ])
    expect(reimported.state.markers[0].tick).toBe(44)
    const model = buildTempoMap(reimported.state.tempoMap, reimported.state.settings)
    expect(tickToSeconds(44, model)).toBeCloseTo(5, 12)
  })

  it('preserves note timing but warns when down-saving tempo changes before NBS v4', () => {
    const track = createDefaultTrack('track')
    const state: TimelineState = {
      projectId: 'tempo-downsave', randomSeed: 1, targetVersion: '1.21.4', lengthTicks: 20,
      settings: structuredClone(DEFAULT_SETTINGS), master: { ...DEFAULT_MASTER }, tracks: [track],
      markers: [{
        id: 'note', trackId: track.id, tick: 12, soundId: 'block.note_block.harp',
        variantIndex: -1, volume: 1, pitch: 1,
      }],
      tempoMap: [
        { tick: 0, bpm: 150, meter: { numerator: 4, denominator: 4 } },
        { tick: 8, bpm: 300 },
      ],
    }

    const converted = timelineStateToNbs(state, 'Pre-v4', 3)

    expect(converted.song.customInstruments.some(instrument => instrument.name === 'Tempo Changer')).toBe(false)
    expect(converted.song.notes[0].tick).toBe(6)
    expect(converted.warnings.join('\n')).toMatch(/v3 cannot encode.*Tempo Changer/i)
    const reimported = nbsToTimelineState(converted.song).state
    expect(reimported.markers[0].tick).toBe(6)
    expect(tickToSeconds(6, buildTempoMap(reimported.tempoMap, reimported.settings))).toBeCloseTo(0.6, 12)
  })

  it('warns separately when later meter changes cannot be represented', () => {
    const track = createDefaultTrack('track')
    const state: TimelineState = {
      projectId: 'meter-map', randomSeed: 1, targetVersion: '1.21.4', lengthTicks: 40,
      settings: structuredClone(DEFAULT_SETTINGS), master: { ...DEFAULT_MASTER }, tracks: [track], markers: [],
      tempoMap: [
        { tick: 0, bpm: 150, meter: { numerator: 3, denominator: 4 } },
        { tick: 20, bpm: 150, meter: { numerator: 4, denominator: 4 } },
      ],
    }
    const converted = timelineStateToNbs(state)
    expect(converted.song.customInstruments.some(instrument => instrument.name === 'Tempo Changer')).toBe(false)
    expect(converted.warnings.join('\n')).toMatch(/1 later meter change/i)
  })

  it('uses target-correct IDs for v5 trumpet down-save and v6 custom sounds', () => {
    const track = createDefaultTrack('track')
    const state: TimelineState = {
      projectId: 'project', randomSeed: 1, targetVersion: '1.21.4', lengthTicks: 40,
      settings: structuredClone(DEFAULT_SETTINGS), master: { ...DEFAULT_MASTER }, tracks: [track],
      markers: [
        { id: 'trumpet', trackId: track.id, tick: 0, soundId: 'block.note_block.trumpet', variantIndex: -1, volume: 1, pitch: 1 },
        { id: 'custom', trackId: track.id, tick: 1, soundId: 'my_pack:lead', variantIndex: -1, volume: 1, pitch: 1 },
      ],
    }
    const v5 = timelineStateToNbs(state, 'Down-save', 5).song
    expect(v5.notes.map(note => note.instrument)).toEqual([16, 17])
    expect(v5.customInstruments.map(instrument => instrument.name)).toEqual(['Trumpet', 'my_pack:lead'])
    expect(v5.customInstruments[0].file).toBe('trumpet.ogg')
    const v6 = timelineStateToNbs(state, 'Native', 6).song
    expect(v6.notes.map(note => note.instrument)).toEqual([16, 20])
    expect(v6.customInstruments.map(instrument => instrument.name)).toEqual(['my_pack:lead'])
    const classic = timelineStateToNbs(state, 'Classic', 0)
    expect(classic.song.notes.map(note => note.instrument)).toEqual([10, 11])
    expect(classic.song.customInstruments.map(instrument => instrument.name)).toEqual(['Trumpet', 'my_pack:lead'])
  })

  it('preserves imported metadata, finite loops, custom definitions, and source timing', () => {
    const sourceSong: NbsSong = {
      ...song,
      header: {
        ...song.header,
        maxLoopCount: 3,
        sourceFile: 'original.mid',
        originalAuthor: 'Original Author',
      },
    }
    const imported = nbsToTimelineState(sourceSong).state
    expect(imported.settings.loop.maxLoopCount).toBe(3)
    expect(imported.metadata).toMatchObject({
      title: 'Roundtrip', author: 'Knead', originalAuthor: 'Original Author',
      description: 'Test', sourceFile: 'original.mid', autoSaveDuration: 10,
      minutesSpent: 1, blocksAdded: 4,
    })
    const exported = timelineStateToNbs(imported, 'Ignored file stem', 5).song
    expect(exported.header).toMatchObject({
      name: 'Roundtrip',
      author: 'Knead',
      originalAuthor: 'Original Author',
      description: 'Test',
      sourceFile: 'original.mid',
      tempo: 1000,
      timeSignature: 4,
      loop: true,
      maxLoopCount: 3,
      loopStartTick: 4,
    })
    expect(exported.layers).toEqual(sourceSong.layers)
    expect(exported.notes).toEqual(sourceSong.notes)
    expect(exported.customInstruments).toEqual(sourceSong.customInstruments)

    imported.metadata = {
      ...imported.metadata!,
      title: 'Edited in Knead',
      author: 'New Author',
      description: '',
      blocksAdded: 900,
    }
    imported.settings.loop.maxLoopCount = 7
    const edited = timelineStateToNbs(imported, 'Still ignored', 5).song
    expect(edited.header).toMatchObject({
      name: 'Edited in Knead', author: 'New Author', description: '',
      blocksAdded: 900, maxLoopCount: 7,
    })
    expect(edited.customInstruments).toEqual(sourceSong.customInstruments)
  })

  it('clamps malicious negative NBS authoring counters in generic metadata while retaining provenance', () => {
    const imported = nbsToTimelineState({
      ...song,
      header: { ...song.header, minutesSpent: -1, leftClicks: -2 },
    }).state
    expect(imported.metadata).toMatchObject({ minutesSpent: 0, leftClicks: 0 })
    expect(imported.source).toMatchObject({ minutesSpent: -1, leftClicks: -2 })
  })

  it('reuses raw custom-source pitch fields only while the canonical marker is unchanged', () => {
    const sourceSong: NbsSong = {
      ...song,
      header: { ...song.header, layerCount: 1 },
      layers: [song.layers[0]],
      customInstruments: [{ name: 'High source', file: 'high.ogg', key: 57, pressKey: true }],
      notes: [
        { tick: 3, layer: 0, instrument: 16, key: 80, velocity: 73, panning: 17, pitch: 1200 },
      ],
    }
    const conversion = nbsToTimelineState(sourceSong)
    const imported = conversion.state
    expect(imported.markers[0].pitch).toBeCloseTo(2 ** (59 / 12))
    expect(imported.markers[0].pitch).toBeGreaterThan(2)
    expect(conversion.warnings.join('\n')).not.toMatch(/pitch range.*clamped/i)
    const unchanged = timelineStateToNbs(imported, 'Raw source', 5).song.notes[0]
    expect(unchanged).toEqual(sourceSong.notes[0])

    imported.markers[0].pitch = 1.5
    const edited = timelineStateToNbs(imported, 'Edited', 5).song.notes[0]
    expect({ key: edited.key, pitch: edited.pitch }).not.toEqual({ key: 80, pitch: 1200 })
  })

  it('encodes authored source keys and default sample pitch without changing audible pitch', () => {
    const track = createDefaultTrack('track')
    const state: TimelineState = {
      projectId: 'authored-instrument', randomSeed: 1, targetVersion: '1.21.4', lengthTicks: 20,
      settings: structuredClone(DEFAULT_SETTINGS), master: { ...DEFAULT_MASTER }, tracks: [track],
      markers: [{
        id: 'lead', trackId: track.id, tick: 0, soundId: 'knead:custom/lead',
        variantIndex: -1, volume: 1, pitch: 1,
      }],
      customInstruments: [{
        id: 'lead-definition', kind: 'audio', soundId: 'knead:custom/lead',
        name: 'Lead', file: 'instruments/lead.ogg', key: 40, pressKey: true,
        defaultPitch: 0.5,
      }],
    }
    const converted = timelineStateToNbs(state, 'Authored', 5).song
    expect(converted.customInstruments).toEqual([{
      name: 'Lead', file: 'instruments/lead.ogg', key: 40, pressKey: true,
    }])
    expect(converted.notes[0]).toMatchObject({ instrument: 16, key: 38, pitch: 0 })
    const reimported = nbsToTimelineState(converted).state
    expect(reimported.markers[0].pitch).toBeCloseTo(0.5)
  })

  it('does not reuse a raw custom note after its authored source key changes', () => {
    const sourceSong: NbsSong = {
      ...song,
      header: { ...song.header, layerCount: 1 },
      layers: [song.layers[0]],
      customInstruments: [{ name: 'Lead', file: 'lead.ogg', key: 45, pressKey: true }],
      notes: [{ tick: 0, layer: 0, instrument: 16, key: 45, velocity: 100, panning: 100, pitch: 0 }],
    }
    const imported = nbsToTimelineState(sourceSong).state
    if (!imported.customInstruments) throw new Error('missing authored definitions')
    imported.customInstruments[0] = { ...imported.customInstruments[0], key: 40 }
    const output = timelineStateToNbs(imported, 'Changed key', 5).song
    expect(output.customInstruments[0].key).toBe(40)
    expect(output.notes[0]).toMatchObject({ key: 50, pitch: 0 })
    expect(nbsToTimelineState(output).state.markers[0].pitch).toBeCloseTo(1)
  })

  it('bounds only unsafe NBS playback pitch while retaining its raw source fields', () => {
    const rawNote = {
      tick: 0, layer: 0, instrument: 16, key: 87,
      velocity: 100, panning: 100, pitch: 0x7fff,
    }
    const converted = nbsToTimelineState({
      ...song,
      header: { ...song.header, layerCount: 1 },
      layers: [song.layers[0]],
      customInstruments: [{ name: 'Extreme source', file: 'extreme.ogg', key: 255, pressKey: true }],
      notes: [rawNote],
    })
    expect(converted.state.markers[0].pitch).toBe(256)
    expect(converted.state.markers[0].source).toEqual({ format: 'nbs', ...rawNote })
    expect(converted.warnings.join('\n')).toMatch(/safe .* DAW pitch range were clamped.*raw NBS pitch fields were retained/i)
    expect(timelineStateToNbs(converted.state, 'Extreme', 5).song.notes[0]).toEqual(rawNote)
  })

  it('warns when pre-v4 NBS down-save reduces ranged Sound Stoppers to stop-all', () => {
    const track = createDefaultTrack('track')
    const state: TimelineState = {
      projectId: 'stopper', randomSeed: 1, targetVersion: '1.21.4', lengthTicks: 40,
      settings: structuredClone(DEFAULT_SETTINGS), master: { ...DEFAULT_MASTER }, tracks: [track],
      markers: [{
        id: 'stop', trackId: track.id, tick: 4, soundId: '', variantIndex: -1,
        volume: 1, pitch: 1, pan: 0,
        action: { type: 'sound-stop', scope: 'track-range', startTrack: 1, endTrack: 3 },
      }],
    }
    const converted = timelineStateToNbs(state, 'Stopper', 3)
    expect(converted.warnings.join('\n')).toMatch(/cannot store Sound Stopper ranges/i)
    const written = writeNbsWithWarnings(converted.song, 3)
    expect(written.warnings.join('\n')).toMatch(/stop all layers/i)
    const parsed = parseNbs(toArrayBuffer(written.data))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(nbsToTimelineState(parsed.song).state.markers[0].action).toEqual({
      type: 'sound-stop', scope: 'all',
    })
  })

  it('remaps ranged Sound Stoppers across contiguous overflow layer banks', () => {
    const first = createDefaultTrack('first')
    const second = createDefaultTrack('second', 1)
    const state: TimelineState = {
      projectId: 'stop-overflow', randomSeed: 1, targetVersion: '1.21.4', lengthTicks: 40,
      settings: structuredClone(DEFAULT_SETTINGS), master: { ...DEFAULT_MASTER }, tracks: [first, second],
      markers: [
        { id: 'a', trackId: first.id, tick: 0, soundId: 'block.note_block.harp', variantIndex: -1, volume: 1, pitch: 1 },
        { id: 'b', trackId: first.id, tick: 0, soundId: 'block.note_block.bell', variantIndex: -1, volume: 1, pitch: 1 },
        {
          id: 'stop', trackId: second.id, tick: 1, soundId: '', variantIndex: -1,
          volume: 1, pitch: 1, pan: 0,
          action: { type: 'sound-stop', scope: 'track-range', startTrack: 1, endTrack: 1 },
        },
      ],
    }
    const converted = timelineStateToNbs(state, 'Overflow stopper', 5)
    const stopperIndex = converted.song.customInstruments.findIndex(instrument => instrument.name === 'Sound Stopper') + 16
    const actions = converted.song.notes
      .filter(note => note.instrument === stopperIndex)
      .map(decodeSoundStopAction)
    expect(actions).toEqual([
      { type: 'sound-stop', scope: 'track-range', startTrack: 1, endTrack: 2 },
    ])
    expect(converted.warnings.join('\n')).toMatch(/generated NBS layers/i)
  })

  it('orders same-tick track banks and plays notes before their Sound Stopper', () => {
    const first = createDefaultTrack('first')
    const second = createDefaultTrack('second', 1)
    const state: TimelineState = {
      projectId: 'stop-order', randomSeed: 1, targetVersion: '1.21.4', lengthTicks: 40,
      settings: structuredClone(DEFAULT_SETTINGS), master: { ...DEFAULT_MASTER }, tracks: [first, second],
      markers: [
        { id: 'first-a', trackId: first.id, tick: 0, soundId: 'block.note_block.harp', variantIndex: -1, volume: 1, pitch: 1 },
        { id: 'first-b', trackId: first.id, tick: 0, soundId: 'block.note_block.bell', variantIndex: -1, volume: 1, pitch: 1 },
        {
          id: 'first-stop', trackId: first.id, tick: 0, soundId: '', variantIndex: -1,
          volume: 1, pitch: 1, pan: 0,
          action: { type: 'sound-stop', scope: 'track-range', startTrack: 1, endTrack: 1 },
        },
        { id: 'second-note', trackId: second.id, tick: 0, soundId: 'block.note_block.chime', variantIndex: -1, volume: 1, pitch: 1 },
      ],
    }
    const converted = timelineStateToNbs(state, 'Ordered stopper', 5)
    const stopperIndex = converted.song.customInstruments.findIndex(is => is.name === 'Sound Stopper') + 16
    expect(converted.song.layers.map(layer => layer.name)).toEqual([
      first.name, `${first.name} 2`, `${first.name} 3`, second.name,
    ])
    expect(converted.song.notes.map(note => note.layer)).toEqual([0, 1, 2, 3])
    expect(converted.song.notes.map(note => note.instrument)).toEqual([0, 7, stopperIndex, 8])
    expect(decodeSoundStopAction(converted.song.notes[2])).toEqual({
      type: 'sound-stop', scope: 'track-range', startTrack: 1, endTrack: 3,
    })

    const parsed = parseNbs(toArrayBuffer(writeNbs(converted.song, 5)))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.song.notes.map(note => note.layer)).toEqual([0, 1, 2, 3])
    expect(parsed.song.notes.filter(note => note.instrument === stopperIndex)).toHaveLength(1)
  })

  it('does not reuse a raw Stopper range when a later track bank expands', () => {
    const end = encodeSoundStopEnd(2)
    const imported = nbsToTimelineState({
      ...song,
      customInstruments: [{ name: 'Sound Stopper', file: '', key: 45, pressKey: false }],
      notes: [
        { tick: 0, layer: 0, instrument: 16, key: 45, ...end, pitch: 2 },
        { tick: 0, layer: 1, instrument: 0, key: 45, velocity: 100, panning: 100, pitch: 0 },
      ],
    }).state
    imported.markers.push({
      id: 'second-overlap', trackId: imported.tracks[1].id, tick: 0,
      soundId: 'block.note_block.bell', variantIndex: -1, volume: 1, pitch: 1,
    })

    const converted = timelineStateToNbs(imported, 'Expanded raw stopper', 5)
    const stopperIndex = converted.song.customInstruments.findIndex(is => is.name === 'Sound Stopper') + 16
    const stopper = converted.song.notes.find(note => note.instrument === stopperIndex)
    expect(stopper).toBeDefined()
    expect(decodeSoundStopAction(stopper!)).toEqual({
      type: 'sound-stop', scope: 'track-range', startTrack: 2, endTrack: 3,
    })
  })

  it('remaps v6 trumpet and custom IDs when writing v5', () => {
    const v6Song: NbsSong = {
      ...song,
      header: { ...song.header, version: 6, vanillaInstrumentCount: 20 },
      notes: [
        { tick: 0, layer: 0, instrument: 16, key: 45, velocity: 100, panning: 100, pitch: 0 },
        { tick: 1, layer: 0, instrument: 20, key: 45, velocity: 100, panning: 100, pitch: 0 },
      ],
    }
    const parsed = parseNbs(toArrayBuffer(writeNbs(v6Song, 5)))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.song.header.vanillaInstrumentCount).toBe(16)
    expect(parsed.song.notes.map(note => note.instrument)).toEqual([16, 17])
    expect(parsed.song.customInstruments.map(instrument => instrument.name)).toEqual([
      'Trumpet', 'Custom',
    ])
  })
})

describe('NBS v0-v6 writer compatibility', () => {
  it.each([0, 1, 2, 3, 4, 5, 6] satisfies NbsTargetVersion[])(
    'writes the official v%i field layout and round-trips supported fields',
    (version) => {
      const bytes = writeNbs(song, version)
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      if (version === 0) {
        expect(view.getUint16(0, true)).toBe(31)
        expect(view.getUint16(2, true)).toBe(2)
      }
      else {
        expect(view.getUint16(0, true)).toBe(0)
        expect(view.getUint8(2)).toBe(version)
        expect(view.getUint8(3)).toBe(version === 6 ? 20 : 16)
        expect(view.getUint16(4, true)).toBe(version >= 3 ? 31 : 2)
      }
      const parsed = parseNbs(toArrayBuffer(bytes))
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) return
      expect(parsed.song.header.version).toBe(version)
      expect(parsed.song.header.vanillaInstrumentCount).toBe(version === 0 ? 10 : version === 6 ? 20 : 16)
      expect(parsed.song.notes.map(note => note.key)).toEqual([45, 57])
      expect(parsed.song.notes[0].velocity).toBe(version >= 4 ? 80 : 100)
      expect(parsed.song.notes[1].panning).toBe(version >= 4 ? 150 : 100)
      expect(parsed.song.notes[1].pitch).toBe(version >= 4 ? -25 : 0)
      expect(parsed.song.layers[1].locked).toBe(version >= 4)
      expect(parsed.song.layers[1].panning).toBe(version >= 2 ? 140 : 100)
      expect(parsed.song.header.loop).toBe(version >= 4)
      expect(parsed.song.header.songLength).toBe(version === 1 || version === 2 ? 3 : 31)
    },
  )

  it('reports every field family lost by a classic v0 down-save', () => {
    const result = writeNbsWithWarnings({
      ...song,
      customInstruments: [{ ...song.customInstruments[0], file: 'folder\\nested/custom.ogg' }],
    }, 0)
    expect(result.warnings.join('\n')).toMatch(/velocity/i)
    expect(result.warnings.join('\n')).toMatch(/note panning/i)
    expect(result.warnings.join('\n')).toMatch(/fine-pitch/i)
    expect(result.warnings.join('\n')).toMatch(/layer lock/i)
    expect(result.warnings.join('\n')).toMatch(/layer panning/i)
    expect(result.warnings.join('\n')).toMatch(/loop settings/i)
    expect(result.warnings.join('\n')).toMatch(/reduced to file names/i)
    const parsed = parseNbs(toArrayBuffer(result.data))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.song.customInstruments[0].file).toBe('custom.ogg')
  })

  it('warns when v1/v2 drop a trailing-silence song length', () => {
    for (const version of [1, 2] as const) {
      const result = writeNbsWithWarnings(song, version)
      expect(result.warnings.join('\n')).toMatch(/trailing silence/i)
      const parsed = parseNbs(toArrayBuffer(result.data))
      expect(parsed.ok).toBe(true)
      if (parsed.ok) expect(parsed.song.header.songLength).toBe(3)
    }
  })

  it('uses classic custom IDs and official sound definitions for post-classic vanilla instruments', () => {
    const modern: NbsSong = {
      ...song,
      header: { ...song.header, version: 6, vanillaInstrumentCount: 20 },
      notes: [
        { tick: 0, layer: 0, instrument: 10, key: 45, velocity: 100, panning: 100, pitch: 0 },
        { tick: 1, layer: 0, instrument: 16, key: 45, velocity: 100, panning: 100, pitch: 0 },
        { tick: 2, layer: 0, instrument: 20, key: 45, velocity: 100, panning: 100, pitch: 0 },
      ],
    }
    const result = writeNbsWithWarnings(modern, 0)
    const parsed = parseNbs(toArrayBuffer(result.data))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.song.notes.map(note => note.instrument)).toEqual([10, 11, 12])
    expect(parsed.song.customInstruments.map(instrument => instrument.name)).toEqual([
      'Iron Xylophone', 'Trumpet', 'Custom',
    ])
    expect(result.warnings.join('\n')).toMatch(/2 vanilla instrument/i)
  })

  it('enforces the official classic and pre-v5 custom-instrument limits', () => {
    const custom = (count: number): NbsInstrument[] => Array.from({ length: count }, (_, index) => ({
      name: `Custom ${index}`,
      file: `custom_${index}.ogg`,
      key: 45,
      pressKey: true,
    }))
    const classic = { ...song, header: { ...song.header, vanillaInstrumentCount: 10 }, customInstruments: custom(10) }
    expect(() => writeNbs(classic, 0)).toThrow(/at most 9 custom instruments/i)
    const preV5 = { ...song, customInstruments: custom(19) }
    expect(() => writeNbs(preV5, 4)).toThrow(/at most 18 custom instruments/i)
    expect(() => writeNbs(preV5, 5)).not.toThrow()
    expect(() => writeNbs({ ...song, customInstruments: custom(240) }, 5)).not.toThrow()
    expect(() => writeNbs({ ...song, customInstruments: custom(241) }, 5)).toThrow(/at most 240/i)
    const v6 = { ...song, header: { ...song.header, vanillaInstrumentCount: 20 } }
    expect(() => writeNbs({ ...v6, customInstruments: custom(236) }, 6)).not.toThrow()
    expect(() => writeNbs({ ...v6, customInstruments: custom(237) }, 6)).toThrow(/at most 236/i)
  })

  it('rejects invalid positions and layer collisions instead of emitting corrupt deltas', () => {
    expect(() => writeNbs(song, 7 as NbsTargetVersion)).toThrow(/unsupported.*version/i)
    expect(() => writeNbs({
      ...song,
      notes: [{ ...song.notes[0], tick: -1 }],
    }, 5)).toThrow(/invalid.*tick/i)
    expect(() => writeNbs({
      ...song,
      notes: [song.notes[0], { ...song.notes[0], instrument: 1 }],
    }, 5)).toThrow(/layer collision/i)
  })
})
