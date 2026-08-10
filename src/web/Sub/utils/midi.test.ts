import { describe, expect, it } from 'vitest'
import {
  MIDI_IMPORT_LIMITS,
  buildMidiTempoMap,
  generalMidiMinecraftSoundId,
  generalMidiPercussionMinecraftSoundId,
  generalMidiPercussionSoundId,
  generalMidiSoundId,
  importMidi,
  midiTickToSeconds,
  midiToTimelineState,
  parseMidi,
} from './midi'
import { parse as parseProject, serialize as serializeProject } from './timelineIO'

function be16(value: number): number[] {
  return [(value >>> 8) & 0xff, value & 0xff]
}

function be32(value: number): number[] {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]
}

function variableLength(value: number): number[] {
  const bytes = [value & 0x7f]
  let remaining = value >>> 7
  while (remaining > 0) {
    bytes.unshift((remaining & 0x7f) | 0x80)
    remaining >>>= 7
  }
  return bytes
}

function trackChunk(events: number[]): number[] {
  return [
    ...Array.from('MTrk', character => character.charCodeAt(0)),
    ...be32(events.length),
    ...events,
  ]
}

function smf(format: 0 | 1 | 2, tracks: number[][], division = 480): Uint8Array {
  return Uint8Array.from([
    ...Array.from('MThd', character => character.charCodeAt(0)),
    ...be32(6),
    ...be16(format),
    ...be16(tracks.length),
    ...be16(division),
    ...tracks.flatMap(trackChunk),
  ])
}

const endOfTrack = [0x00, 0xff, 0x2f, 0x00]

describe('Standard MIDI File parser', () => {
  it('parses format 0 running status, program changes, and note-off velocity zero', () => {
    const bytes = smf(0, [[
      0x00, 0xff, 0x03, 0x05, ...Array.from('Piano', character => character.charCodeAt(0)),
      0x00, 0xc0, 0x05,
      0x00, 0x90, 60, 100,
      ...variableLength(480), 60, 0,
      ...endOfTrack,
    ]])
    const parsed = parseMidi(bytes)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.warnings).toEqual([])
    expect(parsed.song.header).toEqual({ format: 0, trackCount: 1, ticksPerQuarter: 480 })
    expect(parsed.song.tracks[0].name).toBe('Piano')
    expect(parsed.song.tracks[0].notes).toMatchObject([{
      channel: 0,
      note: 60,
      velocity: 100,
      startTick: 0,
      endTick: 480,
      program: 5,
    }])
  })

  it('parses format 1 tempo, time-signature, track metadata, and pitch bend', () => {
    const conductor = [
      0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20,
      0x00, 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08,
      ...variableLength(480), 0xff, 0x51, 0x03, 0x0f, 0x42, 0x40,
      ...endOfTrack,
    ]
    const violin = [
      0x00, 0xff, 0x03, 0x06, ...Array.from('Violin', character => character.charCodeAt(0)),
      0x00, 0xff, 0x04, 0x07, ...Array.from('Strings', character => character.charCodeAt(0)),
      0x00, 0xc0, 40,
      0x00, 0x90, 60, 100,
      ...variableLength(480), 0x80, 60, 32,
      0x00, 0xe0, 0x00, 0x50,
      0x00, 0x90, 64, 127,
      ...variableLength(480), 0x80, 64, 0,
      ...endOfTrack,
    ]
    const parsed = parseMidi(smf(1, [conductor, violin]))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.song.tempoEvents.map(event => [event.tick, event.microsecondsPerQuarter])).toEqual([
      [0, 500_000], [480, 1_000_000],
    ])
    expect(parsed.song.timeSignatureEvents[0]).toMatchObject({
      tick: 0, numerator: 4, denominator: 4,
    })
    expect(parsed.song.tracks[1]).toMatchObject({ name: 'Violin', instrumentName: 'Strings' })
    expect(parsed.song.tracks[1].pitchBends[0]).toMatchObject({ tick: 480, channel: 0, value: 2048 })
    expect(parsed.song.tracks[1].notes[1]).toMatchObject({
      note: 64,
      program: 40,
      startPitchBend: 2048,
      startTick: 480,
      endTick: 960,
    })
    expect(buildMidiTempoMap(parsed.song)).toEqual([
      { tick: 0, seconds: 0, microsecondsPerQuarter: 500_000 },
      { tick: 480, seconds: 0.5, microsecondsPerQuarter: 1_000_000 },
    ])
    expect(midiTickToSeconds(parsed.song, 960)).toBe(1.5)
  })

  it('skips SysEx safely and closes unterminated notes at track end', () => {
    const parsed = parseMidi(smf(0, [[
      0x00, 0xf0, 0x03, 0x01, 0x02, 0x03,
      0x00, 0x90, 60, 80,
      ...variableLength(120), 0xff, 0x2f, 0x00,
    ]]))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.song.tracks[0].notes[0].endTick).toBe(120)
    expect(parsed.warnings.join(' ')).toMatch(/unterminated/i)
  })

  it('merges format-1 channel state across source tracks', () => {
    const controls = [
      0x00, 0xc0, 56,
      0x00, 0xe0, 0x00, 0x50,
      ...endOfTrack,
    ]
    const notes = [
      0x00, 0x90, 60, 100,
      ...variableLength(120), 0x80, 60, 0,
      ...endOfTrack,
    ]
    const parsed = parseMidi(smf(1, [controls, notes]))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.song.tracks[1].notes[0]).toMatchObject({
      program: 56,
      startPitchBend: 2048,
    })
  })

  it('rejects format 2, SMPTE timing, malformed running status, truncation, and oversized input', () => {
    expect(parseMidi(smf(2, [endOfTrack])).ok).toBe(false)
    expect(parseMidi(smf(0, [endOfTrack], 0xe728)).ok).toBe(false)
    expect(parseMidi(smf(0, [[0x00, 60, 100, ...endOfTrack]])).ok).toBe(false)
    expect(parseMidi(Uint8Array.from([0x4d, 0x54, 0x68])).ok).toBe(false)
    expect(parseMidi(new Uint8Array(MIDI_IMPORT_LIMITS.maxBytes + 1)).ok).toBe(false)
  })
})

describe('MIDI timeline conversion', () => {
  it('clamps unsupported meter values to a project that remains reopenable', () => {
    const parsed = parseMidi(smf(0, [[
      0x00, 0xff, 0x58, 0x04, 32, 0x02, 0x18, 0x08,
      ...endOfTrack,
    ]]))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const converted = midiToTimelineState(parsed.song)
    expect(converted.state.settings.timeSignature).toEqual({ numerator: 16, denominator: 4 })
    expect(parseProject(serializeProject(converted.state)).ok).toBe(true)
  })

  it('integrates tempo changes, creates stable GM IDs, and maps note-off to wall-clock gates', () => {
    const conductor = [
      0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20,
      ...variableLength(480), 0xff, 0x51, 0x03, 0x0f, 0x42, 0x40,
      0x00, 0xff, 0x58, 0x04, 0x03, 0x03, 0x18, 0x08,
      ...endOfTrack,
    ]
    const music = [
      0x00, 0xff, 0x03, 0x04, ...Array.from('Lead', character => character.charCodeAt(0)),
      0x00, 0xc0, 40,
      0x00, 0x90, 60, 100,
      ...variableLength(480), 0x80, 60, 0,
      0x00, 0xe0, 0x00, 0x50,
      0x00, 0x90, 64, 127,
      ...variableLength(480), 0x80, 64, 0,
      ...endOfTrack,
    ]
    const parsed = parseMidi(smf(1, [conductor, music]))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const first = midiToTimelineState(parsed.song, '1.21.4')
    const second = midiToTimelineState(parsed.song, '1.21.4')
    expect(second.state).toEqual(first.state)
    expect(first.state.tracks).toHaveLength(1)
    expect(first.state.tracks[0].name).toBe('Lead')
    expect(first.state.markers.map(marker => marker.tick)).toEqual([0, 10])
    expect(first.state.markers.map(marker => marker.soundId)).toEqual([
      'midi:gm/040_violin', 'midi:gm/040_violin',
    ])
    expect(first.state.markers.every(marker => marker.duration === undefined)).toBe(true)
    expect(first.state.markers.map(marker => marker.gateTicks)).toEqual([10, 20])
    expect(first.state.markers[1].pitch).toBeCloseTo(2 ** (4.5 / 12), 6)
    expect(first.state.targetVersion).toBe('1.21.4')
    expect(first.state.source).toMatchObject({
      format: 'midi', sourceFormat: 1, ticksPerQuarter: 480,
    })
    expect(first.state.tracks[0].source).toMatchObject({ format: 'midi', name: 'Lead' })
    expect(first.state.markers[1].source).toMatchObject({
      format: 'midi', note: 64, startTick: 480, endTick: 960,
    })
    expect(first.state.tempoMap).toEqual([
      { tick: 0, bpm: 120, meter: { numerator: 4, denominator: 4 } },
      { tick: 10, bpm: 60, meter: { numerator: 3, denominator: 8 } },
    ])
    expect(first.warnings.join(' ')).toMatch(/tempo.*first-class.*wall-clock marker gates.*Pitch bend/is)
  })

  it('splits format-0 channels and gives percussion stable note IDs', () => {
    const parsed = parseMidi(smf(0, [[
      0x00, 0x90, 60, 100,
      0x00, 0x99, 35, 127,
      ...variableLength(120), 0x80, 60, 0,
      0x00, 0x89, 35, 0,
      ...endOfTrack,
    ]]))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const converted = midiToTimelineState(parsed.song)
    expect(converted.state.tracks).toHaveLength(2)
    expect(converted.state.markers.map(marker => marker.soundId)).toContain('midi:drum/035_acoustic_bass_drum')
    expect(converted.state.markers.find(marker => marker.soundId.startsWith('midi:drum'))?.pitch).toBe(1)
  })

  it('offers a one-call import result and public deterministic sound-ID helpers', () => {
    const bytes = smf(0, [[0x00, 0x90, 60, 64, 0x01, 0x80, 60, 0, ...endOfTrack]])
    const imported = importMidi(bytes, '1.20.6')
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    expect(imported.state.targetVersion).toBe('1.20.6')
    expect(imported.song.tracks[0].notes[0].endTick).toBe(1)
    expect(generalMidiSoundId(0)).toBe('midi:gm/000_acoustic_grand_piano')
    expect(generalMidiPercussionSoundId(81)).toBe('midi:drum/081_open_triangle')
  })

  it('can map GM notes onto immediately playable vanilla Minecraft sounds', () => {
    const bytes = smf(0, [[0x00, 0x90, 66, 127, 0x01, 0x80, 66, 0, ...endOfTrack]])
    const imported = importMidi(bytes, '1.21.4', { soundMapping: 'minecraft' })
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    expect(imported.state.markers[0].soundId).toBe('block.note_block.harp')
    expect(imported.state.markers[0].pitch).toBe(1)
    expect(imported.state.markers[0].source).toMatchObject({ format: 'midi', program: 0, note: 66 })
    expect(generalMidiMinecraftSoundId(24)).toBe('block.note_block.guitar')
    expect(generalMidiPercussionMinecraftSoundId(38)).toBe('block.note_block.snare')
  })

  it('retains large MIDI note intervals in the extended DAW pitch domain', () => {
    const imported = importMidi(smf(0, [[
      0x00, 0x90, 127, 100,
      0x01, 0x80, 127, 0,
      0x00, 0x90, 0, 100,
      0x01, 0x80, 0, 0,
      ...endOfTrack,
    ]]))
    expect(imported.ok).toBe(true)
    if (!imported.ok) return
    expect(imported.state.markers.map(marker => marker.pitch)).toEqual([
      2 ** (67 / 12),
      2 ** (-60 / 12),
    ])
    expect(imported.state.markers.map(marker => marker.source?.format === 'midi'
      ? marker.source.note
      : undefined)).toEqual([127, 0])
    expect(imported.warnings.join('\n')).not.toMatch(/DAW playback range were clamped/i)
  })

  it('uses a one-tick minimum gate and clamps note ends outside the safe timeline', () => {
    const parsed = parseMidi(smf(0, [[
      0x00, 0x90, 60, 100,
      0x00, 0x80, 60, 0,
      ...endOfTrack,
    ]]))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const zeroLength = midiToTimelineState(parsed.song)
    expect(zeroLength.state.markers[0].gateTicks).toBe(1)

    const outside = structuredClone(parsed.song)
    const outsideMidiTick = (MIDI_IMPORT_LIMITS.maxTimelineTicks + 5) * 48
    outside.tracks[0].notes[0].startTick = outsideMidiTick
    outside.tracks[0].notes[0].endTick = outsideMidiTick + 48
    outside.tracks[0].lastTick = outsideMidiTick + 48
    const clamped = midiToTimelineState(outside)
    expect(clamped.state.markers[0]).toMatchObject({
      tick: MIDI_IMPORT_LIMITS.maxTimelineTicks - 1,
      gateTicks: 1,
    })
    expect(clamped.state.lengthTicks).toBe(MIDI_IMPORT_LIMITS.maxTimelineTicks)
    expect(clamped.warnings.join(' ')).toMatch(/outside the safe timeline.*clamped/i)
  })

  it('quantizes starts and note-off gates while reporting zero gates and new overlaps', () => {
    const parsed = parseMidi(smf(0, [[
      ...variableLength(5), 0x90, 60, 100,
      ...variableLength(53), 0x80, 60, 0,
      ...variableLength(4), 0x90, 60, 100,
      ...variableLength(48), 0x80, 60, 0,
      ...endOfTrack,
    ]]))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const original = midiToTimelineState(parsed.song, '', { quantizeStep: 0 })
    const quantized = midiToTimelineState(parsed.song, '', { quantizeStep: 5 })
    expect(original.state.markers.map(marker => [marker.tick, marker.gateTicks])).toEqual([
      [0, 1], [1, 1],
    ])
    expect(quantized.state.markers.map(marker => [marker.tick, marker.gateTicks])).toEqual([
      [0, 1], [0, 1],
    ])
    expect(quantized.warnings.join(' ')).toMatch(/moved on the 5-tick.*collapsed to zero.*new same-pitch overlap/is)

    const longParsed = parseMidi(smf(0, [[
      0x00, 0x90, 64, 100,
      ...variableLength(298), 0x80, 64, 0,
      ...endOfTrack,
    ]]))
    expect(longParsed.ok).toBe(true)
    if (!longParsed.ok) return
    const longOriginal = midiToTimelineState(longParsed.song, '', { quantizeStep: 0 })
    const longQuantized = midiToTimelineState(longParsed.song, '', { quantizeStep: 5 })
    expect(longOriginal.state.markers[0].gateTicks).toBe(6)
    expect(longQuantized.state.markers[0].gateTicks).toBe(5)
    expect(longQuantized.warnings.join(' ')).toMatch(/note gate.*changed on the 5-tick/i)
  })

  it('supports single-shot note lengths and bounded channel sound overrides', () => {
    const parsed = parseMidi(smf(0, [[
      0x00, 0x90, 66, 100,
      ...variableLength(480), 0x80, 66, 0,
      ...endOfTrack,
    ]]))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const converted = midiToTimelineState(parsed.song, '', {
      soundMapping: 'minecraft',
      noteLengthMode: 'single-shot',
      channelSoundOverrides: { 0: 'custom:channel_zero', 1: 'INVALID SOUND' },
    })
    expect(converted.state.markers[0]).toMatchObject({
      soundId: 'custom:channel_zero',
      gateTicks: undefined,
    })
    expect(converted.warnings.join(' ')).toMatch(/invalid MIDI channel sound override.*omitted by single-shot/is)
  })

  it('models OpenNBS 3.12 tail fade with two bounded alternating parity markers', () => {
    const parsed = parseMidi(smf(0, [[
      0x00, 0x90, 66, 100,
      ...variableLength(298), 0x80, 66, 0,
      ...endOfTrack,
    ]]))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const converted = midiToTimelineState(parsed.song, '1.21.4', {
      soundMapping: 'minecraft',
      quantizeStep: 5,
      noteLengthMode: 'note-off-gate',
      tailFade: { enabled: true, startPercent: 20, endPercent: 80 },
      channelSoundOverrides: { 0: 'custom:tail' },
    })
    expect(converted.state.markers).toHaveLength(3)
    const [head, left, right] = converted.state.markers
    expect(head).toMatchObject({
      tick: 0,
      soundId: 'custom:tail',
      gateTicks: 5,
    })
    expect(head.duration).toBeUndefined()
    expect(head.retriggerInterval).toBeUndefined()
    expect(head.volumeCurve).toBeUndefined()
    expect(left).toMatchObject({
      id: `${head.id}-tail-left`,
      tick: 1,
      soundId: 'custom:tail',
      pan: -0.5,
      gateTicks: undefined,
      duration: 2,
      retriggerInterval: 2,
    })
    expect(left.volume).toBeCloseTo(head.volume * 0.2)
    expect(left.volumeCurve?.keyframes.map(({ tick, interpolation }) => ({
      tick, interpolation,
    }))).toEqual([
      { tick: 0, interpolation: 'linear' },
      { tick: 2, interpolation: 'linear' },
    ])
    expect(left.volumeCurve?.keyframes[0].value).toBeCloseTo(left.volume)
    expect(left.volumeCurve?.keyframes[1].value).toBeCloseTo(head.volume * 0.6)
    expect(right).toMatchObject({
      id: `${head.id}-tail-right`,
      tick: 2,
      soundId: 'custom:tail',
      pan: 0.5,
      gateTicks: undefined,
      duration: 2,
      retriggerInterval: 2,
    })
    expect(right.volume).toBeCloseTo(head.volume * 0.4)
    expect(right.volumeCurve?.keyframes.map(({ tick, interpolation }) => ({
      tick, interpolation,
    }))).toEqual([
      { tick: 0, interpolation: 'linear' },
      { tick: 2, interpolation: 'linear' },
    ])
    expect(right.volumeCurve?.keyframes[0].value).toBeCloseTo(right.volume)
    expect(right.volumeCurve?.keyframes[1].value).toBeCloseTo(head.volume * 0.8)
    expect(converted.warnings.join(' ')).toMatch(/1 melodic MIDI note tail.*2 bounded parity marker.*4 per-tick tail firing.*integer percent/is)
  })

  it('uses Start for a one-tick tail and leaves a zero-length head unchanged', () => {
    const oneTailParsed = parseMidi(smf(0, [[
      0x00, 0x90, 60, 64,
      ...variableLength(96), 0x80, 60, 0,
      ...endOfTrack,
    ]]))
    expect(oneTailParsed.ok).toBe(true)
    if (!oneTailParsed.ok) return
    const oneTail = midiToTimelineState(oneTailParsed.song, '', {
      tailFade: { enabled: true, startPercent: 75, endPercent: 10 },
    })
    expect(oneTail.state.markers).toHaveLength(2)
    expect(oneTail.state.markers[0].gateTicks).toBe(2)
    expect(oneTail.state.markers[1]).toMatchObject({
      tick: 1,
      pan: -0.5,
      gateTicks: undefined,
      duration: undefined,
      retriggerInterval: undefined,
      volumeCurve: undefined,
    })
    expect(oneTail.state.markers[1].volume).toBeCloseTo(oneTail.state.markers[0].volume * 0.75)
    expect(oneTail.warnings.join(' ')).toMatch(/one-tick MIDI tail.*only Start velocity.*End is unused/i)

    const zeroParsed = parseMidi(smf(0, [[
      0x00, 0x90, 60, 64,
      0x00, 0x80, 60, 0,
      ...endOfTrack,
    ]]))
    expect(zeroParsed.ok).toBe(true)
    if (!zeroParsed.ok) return
    const zero = midiToTimelineState(zeroParsed.song, '', {
      tailFade: { enabled: true, startPercent: -5, endPercent: 100.6 },
    })
    expect(zero.state.markers).toHaveLength(1)
    expect(zero.state.markers[0].gateTicks).toBe(1)
    expect(zero.state.markers[0].duration).toBeUndefined()
    expect(zero.warnings.join(' ')).toMatch(/2 MIDI tail-fade percentage.*rounded and clamped.*no tail after quantization/is)
  })

  it('disables tail fade for single-shot and percussion exactly as OpenNBS does', () => {
    const melodic = parseMidi(smf(0, [[
      0x00, 0x90, 60, 100,
      ...variableLength(240), 0x80, 60, 0,
      ...endOfTrack,
    ]]))
    expect(melodic.ok).toBe(true)
    if (!melodic.ok) return
    const singleShot = midiToTimelineState(melodic.song, '', {
      noteLengthMode: 'single-shot',
      tailFade: { enabled: true, startPercent: 50, endPercent: 0 },
    })
    expect(singleShot.state.markers).toHaveLength(1)
    expect(singleShot.state.markers[0].gateTicks).toBeUndefined()
    expect(singleShot.state.markers[0].duration).toBeUndefined()
    expect(singleShot.state.markers[0].volumeCurve).toBeUndefined()
    expect(singleShot.warnings.join(' ')).toMatch(/tail fade was not applied in single-shot.*only with Note Duration/i)

    const percussion = parseMidi(smf(0, [[
      0x00, 0x99, 38, 100,
      ...variableLength(240), 0x89, 38, 0,
      ...endOfTrack,
    ]]))
    expect(percussion.ok).toBe(true)
    if (!percussion.ok) return
    const drums = midiToTimelineState(percussion.song, '', {
      tailFade: { enabled: true },
    })
    expect(drums.state.markers).toHaveLength(1)
    expect(drums.warnings.join(' ')).toMatch(/1 percussion note tail.*excluded.*OpenNBS 3.12/i)
  })

  it('reports overlapping same-pitch tail voices without merging them', () => {
    const parsed = parseMidi(smf(0, [[
      0x00, 0x90, 60, 100,
      ...variableLength(48), 0x90, 60, 90,
      ...variableLength(144), 0x80, 60, 0,
      ...variableLength(48), 0x80, 60, 0,
      ...endOfTrack,
    ]]))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const converted = midiToTimelineState(parsed.song, '', {
      tailFade: { enabled: true, startPercent: 50, endPercent: 0 },
    })
    expect(converted.state.markers).toHaveLength(6)
    expect(converted.warnings.join(' ')).toMatch(/1 tail-faded same-pitch MIDI note.*overlap an earlier tail.*separate retriggering voices/i)
  })

  it('reserves the total marker budget for note heads before adding tail voices', () => {
    const parsed = parseMidi(smf(0, [[
      0x00, 0x90, 60, 100,
      ...variableLength(240), 0x80, 60, 0,
      ...endOfTrack,
    ]]))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const source = structuredClone(parsed.song)
    const head = source.tracks[0].notes[0]
    const reservedButUnmapped = { ...head, index: 1, channel: 1 }
    source.tracks[0].notes = Array(MIDI_IMPORT_LIMITS.maxTimelineMarkers)
      .fill(reservedButUnmapped)
    source.tracks[0].notes[0] = head
    // A parser-produced song always lists every used channel. Deliberately omit
    // channel 1 here so this safety test can reserve 250k heads without building
    // a 250k-marker state in the test process.
    source.tracks[0].channels = [0]
    const converted = midiToTimelineState(source, '', {
      tailFade: { enabled: true },
    })
    expect(converted.state.markers).toHaveLength(1)
    expect(converted.warnings.join(' ')).toMatch(/2 derived marker.*4 tail firing.*1 MIDI note.*omitted.*250000-marker safety budget/is)
  })
})
