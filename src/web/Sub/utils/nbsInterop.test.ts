import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fromArrayBuffer, type Song as NbsJsSong } from '@nbsjs/core'
import { describe, expect, it } from 'vitest'
import {
  parseNbs,
  writeNbs,
  type NbsInstrument,
  type NbsLayer,
  type NbsNote,
  type NbsSong,
  type NbsTargetVersion,
} from './nbs'

const OFFICIAL_FIXTURE_SHA256 = '94b0e69270e0bce404d0d49f00c1c94568229e0eb76d7ba32e1fde5e31291973'
const MAX_SIGNED_SHORT = 0x7fff

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function sha256(value: Uint8Array | unknown): string {
  const input = value instanceof Uint8Array ? value : JSON.stringify(value)
  return createHash('sha256').update(input).digest('hex')
}

function fixtureBytes(): Uint8Array {
  const encoded = readFileSync(
    new URL('./fixtures/open-nbs-nyan-cat-v6.nbs.base64', import.meta.url),
    'utf8',
  ).trim()
  return new Uint8Array(Buffer.from(encoded, 'base64'))
}

function notesFromNbsJs(song: NbsJsSong): NbsNote[] {
  const notes: NbsNote[] = []
  song.layers.all.forEach((layer, layerIndex) => {
    for (const [tick, note] of layer.notes) {
      notes.push({
        tick,
        layer: layerIndex,
        instrument: note.instrument,
        key: note.key ?? 45,
        velocity: note.velocity ?? 100,
        panning: (note.panning ?? 0) + 100,
        pitch: note.pitch ?? 0,
      })
    }
  })
  return notes.sort((left, right) => left.tick - right.tick || left.layer - right.layer)
}

function layersFromNbsJs(song: NbsJsSong): NbsLayer[] {
  return song.layers.all.map(layer => ({
    name: layer.name ?? '',
    locked: Boolean(layer.isLocked),
    volume: layer.volume ?? 100,
    panning: (layer.stereo ?? 0) + 100,
  }))
}

function customFromNbsJs(song: NbsJsSong): NbsInstrument[] {
  const instruments: NbsInstrument[] = []
  for (const [, instrument] of song.instruments) {
    if (instrument.isBuiltIn) continue
    instruments.push({
      name: instrument.name ?? '',
      file: instrument.soundFile ?? '',
      key: instrument.key ?? 45,
      pressKey: Boolean(instrument.pressKey),
    })
  }
  return instruments
}

const goldenSong: NbsSong = {
  header: {
    version: 5,
    vanillaInstrumentCount: 16,
    songLength: 31,
    layerCount: 2,
    name: 'Roundtrip',
    author: 'Knead',
    originalAuthor: '',
    description: 'Test',
    tempo: 1000,
    autoSave: false,
    autoSaveDuration: 10,
    timeSignature: 4,
    minutesSpent: 1,
    leftClicks: 2,
    rightClicks: 3,
    blocksAdded: 4,
    blocksRemoved: 5,
    sourceFile: '',
    loop: true,
    maxLoopCount: 0,
    loopStartTick: 4,
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

describe('official OpenNBS v6 fixture interoperability', () => {
  it('pins the exact MIT-licensed development fixture bytes', () => {
    const bytes = fixtureBytes()
    expect(bytes.byteLength).toBe(10_845)
    expect(sha256(bytes)).toBe(OFFICIAL_FIXTURE_SHA256)
  })

  it('goldens every parsed header field and every note/layer/custom-instrument field', () => {
    const parsed = parseNbs(exactArrayBuffer(fixtureBytes()))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.song.header).toEqual({
      version: 6,
      vanillaInstrumentCount: 20,
      songLength: 671,
      layerCount: 36,
      name: 'Nyan Cat',
      author: 'chenxi050402',
      originalAuthor: '',
      description: '"Nyan Cat" recreated in note blocks by chenxi050402.',
      tempo: 1893,
      autoSave: false,
      autoSaveDuration: 10,
      timeSignature: 8,
      minutesSpent: 33,
      leftClicks: 1219,
      rightClicks: 32,
      blocksAdded: 213,
      blocksRemoved: 27,
      sourceFile: '',
      loop: true,
      maxLoopCount: 0,
      loopStartTick: 160,
    })
    expect(parsed.song.notes).toHaveLength(1022)
    expect(parsed.song.layers).toHaveLength(36)
    expect(parsed.song.customInstruments).toHaveLength(3)
    // Section hashes cover every field without checking in a 1,000-line literal.
    expect(sha256(parsed.song.notes)).toBe('b3357c80d03ec490a87e9d0f756d03860ad2b3fd44798efd582a41c7b801104e')
    expect(sha256(parsed.song.layers)).toBe('55f16971c4bf41f5cf843736e3b9580ec378628f57249bc51cebe804564a390c')
    expect(sha256(parsed.song.customInstruments)).toBe('81253c769345fab17f06a5dc142154f9387ef2ceae7ec8e4af0139fb88829886')
    expect(parsed.song.notes.at(-1)).toEqual({
      tick: 671, layer: 0, instrument: 0, key: 39, velocity: 0, panning: 100, pitch: 0,
    })
    expect(parsed.song.layers[12]).toEqual({ name: '', locked: false, volume: 50, panning: 200 })
    expect(parsed.song.customInstruments).toEqual([
      { name: 'entity.experience_orb.pickup', file: 'custom/entity.experience_orb.pickup.ogg', key: 45, pressKey: false },
      { name: 'entity.firework.blast_far', file: 'custom/entity.firework.blast_far.ogg', key: 45, pressKey: false },
      { name: 'block.sand.break', file: 'custom/block.sand.break.ogg', key: 45, pressKey: false },
    ])
  })

  it('agrees with pinned official @nbsjs/core 6.1.0 on the complete fixture model', () => {
    const bytes = fixtureBytes()
    const ours = parseNbs(exactArrayBuffer(bytes))
    expect(ours.ok).toBe(true)
    if (!ours.ok) return
    const reference = fromArrayBuffer(exactArrayBuffer(bytes))
    expect(reference.version).toBe(6)
    expect(reference.getLength()).toBe(671)
    expect(reference.name).toBe(ours.song.header.name)
    expect(reference.author).toBe(ours.song.header.author)
    expect(reference.getTempo() * 100).toBe(ours.song.header.tempo)
    expect(reference.loop).toEqual({ enabled: true, startTick: 160, totalLoops: 0 })
    expect(notesFromNbsJs(reference)).toEqual(ours.song.notes)
    expect(layersFromNbsJs(reference)).toEqual(ours.song.layers)
    expect(customFromNbsJs(reference)).toEqual(ours.song.customInstruments)
  })
})

describe('independent writer cross-read and version goldens', () => {
  it.each([
    [0, 130, 'e46eed8eb5b03b9bc251eb48f432eb52dcc32f723b54638fea56794d84fbf8cb'],
    [1, 132, '555131a869856eb99ef82ab88d33abe9dc7f3c7dbcca018e0a958b157527510d'],
    [2, 134, '952099fee3e5caeb6a730a984562c0bb6166d1a25ba36ac2e66364d809413f2a'],
    [3, 136, '3b1c270668b7158dddba6f3d83da365075d99093e035d5a17f7886f7b12f090d'],
    [4, 150, '17f10029079189a316da9e965af7425a291490219981eee77ea65af3a8d4a68d'],
    [5, 157, '89cf8b5f6de15f62565e1026ad0362b787a55af17740ee1de3ca766c091835ce'],
    [6, 157, 'c16c20294b34228233b9cd8ec219ab3ffdda0e25b74a968c51d03a3c916c79bd'],
  ] satisfies [NbsTargetVersion, number, string][])('keeps the exact v%i byte layout', (version, size, hash) => {
    const bytes = writeNbs(goldenSong, version)
    expect(bytes.byteLength).toBe(size)
    expect(sha256(bytes)).toBe(hash)
  })

  it.each([5, 6] satisfies NbsTargetVersion[])('writes v%i files cross-readable by official @nbsjs/core', (version) => {
    const base = version === 5 ? 16 : 20
    const candidate: NbsSong = {
      ...goldenSong,
      header: { ...goldenSong.header, version, vanillaInstrumentCount: base, songLength: 4 },
      notes: [
        ...goldenSong.notes,
        { tick: 4, layer: 0, instrument: version === 6 ? 20 : 0, key: 40, velocity: 70, panning: 25, pitch: 125 },
      ],
      customInstruments: version === 6 ? goldenSong.customInstruments : [],
    }
    const bytes = writeNbs(candidate, version)
    const reference = fromArrayBuffer(exactArrayBuffer(bytes))
    expect(reference.version).toBe(version)
    expect(reference.getLength()).toBe(4)
    expect(reference.name).toBe(candidate.header.name)
    expect(reference.author).toBe(candidate.header.author)
    expect(reference.description).toBe(candidate.header.description)
    expect(notesFromNbsJs(reference)).toEqual(candidate.notes)
    expect(layersFromNbsJs(reference)).toEqual(candidate.layers)
    expect(customFromNbsJs(reference)).toEqual(candidate.customInstruments)
  })

  it('uses the official inclusive last-tick and signed-delta boundaries', () => {
    const atFirstDeltaLimit = {
      ...goldenSong,
      header: { ...goldenSong.header, songLength: MAX_SIGNED_SHORT - 1, layerCount: 1 },
      notes: [{ ...goldenSong.notes[0], tick: MAX_SIGNED_SHORT - 1 }],
      layers: [goldenSong.layers[0]],
      customInstruments: [],
    }
    const parsedLimit = parseNbs(exactArrayBuffer(writeNbs(atFirstDeltaLimit, 5)))
    expect(parsedLimit.ok && parsedLimit.song.header.songLength).toBe(MAX_SIGNED_SHORT - 1)

    expect(() => writeNbs({
      ...atFirstDeltaLimit,
      header: { ...atFirstDeltaLimit.header, songLength: MAX_SIGNED_SHORT },
      notes: [{ ...goldenSong.notes[0], tick: MAX_SIGNED_SHORT }],
    }, 5)).toThrow(/tick delta/i)

    const withLeadingNote = {
      ...atFirstDeltaLimit,
      header: { ...atFirstDeltaLimit.header, songLength: MAX_SIGNED_SHORT },
      notes: [
        { ...goldenSong.notes[0], tick: 0 },
        { ...goldenSong.notes[0], tick: MAX_SIGNED_SHORT },
      ],
    }
    const parsedLastTick = parseNbs(exactArrayBuffer(writeNbs(withLeadingNote, 5)))
    expect(parsedLastTick.ok && parsedLastTick.song.notes.at(-1)?.tick).toBe(MAX_SIGNED_SHORT)
    expect(() => writeNbs({
      ...atFirstDeltaLimit,
      header: { ...atFirstDeltaLimit.header, songLength: MAX_SIGNED_SHORT + 1 },
      notes: [],
    }, 5)).toThrow(/last tick/i)
  })
})

describe('malformed, budget, and deterministic fuzz regressions', () => {
  const minimal: NbsSong = {
    ...goldenSong,
    header: {
      ...goldenSong.header,
      songLength: 0,
      layerCount: 1,
      name: '', author: '', originalAuthor: '', description: '', sourceFile: '',
      loop: false, maxLoopCount: 0, loopStartTick: 0,
    },
    notes: [{ ...goldenSong.notes[0], tick: 0, layer: 0 }],
    layers: [{ name: '', locked: false, volume: 100, panning: 100 }],
    customInstruments: [{ name: 'C', file: 'c.ogg', key: 45, pressKey: true }],
  }

  it('rejects truncation in each mandatory and optional section', () => {
    const bytes = writeNbs(minimal, 5)
    for (const length of [1, 3, 5, 9, 25, 56, 58, bytes.byteLength - 1]) {
      expect(parseNbs(exactArrayBuffer(bytes.slice(0, length))).ok, `prefix ${length}`).toBe(false)
    }
  })

  it('rejects negative signed shorts, delta overflow, and declared budgets before allocation', () => {
    const original = writeNbs(minimal, 5)
    const malformed = (offset: number, value: number, bytes = 2): Uint8Array => {
      const result = original.slice()
      const view = new DataView(result.buffer)
      if (bytes === 2) view.setInt16(offset, value, true)
      else view.setInt32(offset, value, true)
      return result
    }
    expect(parseNbs(exactArrayBuffer(malformed(4, -1))).ok).toBe(false) // song end tick
    expect(parseNbs(exactArrayBuffer(malformed(6, -1))).ok).toBe(false) // layer count
    expect(parseNbs(exactArrayBuffer(malformed(57, -0x8000))).ok).toBe(false) // tick delta
    expect(parseNbs(exactArrayBuffer(malformed(59, -0x8000))).ok).toBe(false) // layer delta
    expect(parseNbs(exactArrayBuffer(malformed(8, 1024 * 1024 + 1, 4))).ok).toBe(false) // first string
    expect(parseNbs(new ArrayBuffer(16 * 1024 * 1024 + 1)).ok).toBe(false)
  })

  it('round-trips deterministic generated songs across every format version', () => {
    let state = 0x6d2b79f5
    const random = (maximum: number): number => {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      return (state >>> 0) % maximum
    }
    for (let iteration = 0; iteration < 140; iteration++) {
      const version = iteration % 7 as NbsTargetVersion
      const vanilla = version === 0 ? 10 : version === 6 ? 20 : 16
      const layerCount = 1 + random(4)
      const layers = Array.from({ length: layerCount }, (_, index): NbsLayer => ({
        name: `L${iteration}-${index}`,
        locked: false,
        volume: 1 + random(100),
        panning: 100,
      }))
      let tick = -1
      const notes = Array.from({ length: 1 + random(20) }, (): NbsNote => {
        tick += 1 + random(20)
        return {
          tick,
          layer: random(layerCount),
          instrument: random(3) === 0 ? vanilla : random(vanilla),
          key: random(88),
          velocity: 100,
          panning: 100,
          pitch: 0,
        }
      })
      const requestedLastTick = tick + random(5)
      const generated: NbsSong = {
        header: {
          ...minimal.header,
          version,
          vanillaInstrumentCount: vanilla,
          songLength: requestedLastTick,
          layerCount,
          name: `Generated ${iteration}`,
          tempo: 1 + random(MAX_SIGNED_SHORT),
          timeSignature: 2 + random(7),
        },
        notes,
        layers,
        customInstruments: [{ name: `C${iteration}`, file: `c_${iteration}.ogg`, key: 45, pressKey: true }],
      }
      const parsed = parseNbs(exactArrayBuffer(writeNbs(generated, version)))
      expect(parsed.ok, `generated v${version} #${iteration}`).toBe(true)
      if (!parsed.ok) continue
      expect(parsed.song.notes).toEqual(notes)
      expect(parsed.song.layers).toEqual(layers)
      expect(parsed.song.customInstruments).toEqual(generated.customInstruments)
      const expectedLastTick = version === 1 || version === 2
        ? tick
        : Math.max(version === 0 ? 1 : 0, requestedLastTick)
      expect(parsed.song.header.songLength).toBe(expectedLastTick)
    }
  })

  it('never throws across deterministic byte-mutation and truncation fuzz cases', () => {
    const source = writeNbs(minimal, 6)
    let state = 0xa5a5_5a5a
    const next = (): number => {
      state = Math.imul(state ^ (state >>> 15), 1 | state)
      state ^= state + Math.imul(state ^ (state >>> 7), 61 | state)
      return (state ^ (state >>> 14)) >>> 0
    }
    for (let iteration = 0; iteration < 512; iteration++) {
      const length = next() % (source.byteLength + 1)
      const candidate = source.slice(0, length)
      for (let flip = 0; flip < 1 + next() % 4 && candidate.byteLength; flip++) {
        candidate[next() % candidate.byteLength] ^= 1 << (next() % 8)
      }
      expect(() => parseNbs(exactArrayBuffer(candidate))).not.toThrow()
      const result = parseNbs(exactArrayBuffer(candidate))
      if (!result.ok) continue
      expect(result.song.header.version).toBeGreaterThanOrEqual(0)
      expect(result.song.header.version).toBeLessThanOrEqual(6)
      expect(result.song.notes.every(note => (
        note.tick >= 0 && note.tick <= MAX_SIGNED_SHORT
        && note.layer >= 0 && note.layer < result.song.header.layerCount
      ))).toBe(true)
    }
  })
})
