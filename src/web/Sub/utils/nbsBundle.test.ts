import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  NBS_BUNDLE_LIMITS,
  nbsBundleArchivePath,
  normalizeNbsInstrumentFile,
  parseNbsBundle,
  readSafeZipEntries,
  writeNbsBundleWithWarnings,
} from './nbsBundle'
import { writeNbs, type NbsInstrument, type NbsSong } from './nbs'

const ogg = Uint8Array.of(0x4f, 0x67, 0x67, 0x53, 1, 2, 3, 4)
const wav = Uint8Array.of(
  0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0,
  0x57, 0x41, 0x56, 0x45, 1, 2, 3, 4,
)

function makeSong(customInstruments: NbsInstrument[]): NbsSong {
  return {
    header: {
      version: 5,
      vanillaInstrumentCount: 16,
      songLength: 1,
      layerCount: 1,
      name: 'Bundle test',
      author: '',
      originalAuthor: '',
      description: '',
      tempo: 1000,
      autoSave: false,
      autoSaveDuration: 10,
      timeSignature: 4,
      minutesSpent: 0,
      leftClicks: 0,
      rightClicks: 0,
      blocksAdded: customInstruments.length,
      blocksRemoved: 0,
      sourceFile: '',
      loop: false,
      maxLoopCount: 0,
      loopStartTick: 0,
    },
    notes: customInstruments.map((instrument, index) => ({
      tick: 0,
      layer: index,
      instrument: 16 + index,
      key: instrument.key,
      velocity: 100,
      panning: 100,
      pitch: 0,
    })),
    layers: customInstruments.map((_, index) => ({
      name: `Layer ${index + 1}`,
      locked: false,
      volume: 100,
      panning: 100,
    })),
    customInstruments,
  }
}

let testCrcTable: Uint32Array | undefined

function testCrc32(data: Uint8Array): number {
  if (!testCrcTable) {
    testCrcTable = new Uint32Array(256)
    for (let index = 0; index < 256; index++) {
      let value = index
      for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1
      testCrcTable[index] = value >>> 0
    }
  }
  let value = 0xffffffff
  for (const byte of data) value = testCrcTable[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

interface RawZipEntry {
  path: string
  data: Uint8Array
  deflate?: boolean
  flags?: number
  declaredSize?: number
  crc?: number
  externalAttributes?: number
}

function rawZip(entries: RawZipEntry[]): Uint8Array {
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  const offsets: number[] = []
  const encoded = entries.map((entry) => {
    const name = encoder.encode(entry.path)
    const compressed = entry.deflate ? new Uint8Array(deflateRawSync(entry.data)) : entry.data
    return { entry, name, compressed }
  })
  let offset = 0
  encoded.forEach(({ entry, name, compressed }, index) => {
    offsets[index] = offset
    const header = new Uint8Array(30)
    const view = new DataView(header.buffer)
    view.setUint32(0, 0x04034b50, true)
    view.setUint16(4, 20, true)
    view.setUint16(6, entry.flags ?? 0x0800, true)
    view.setUint16(8, entry.deflate ? 8 : 0, true)
    view.setUint32(14, entry.crc ?? testCrc32(entry.data), true)
    view.setUint32(18, compressed.byteLength, true)
    view.setUint32(22, entry.declaredSize ?? entry.data.byteLength, true)
    view.setUint16(26, name.byteLength, true)
    chunks.push(header, name, compressed)
    offset += header.byteLength + name.byteLength + compressed.byteLength
  })
  const centralOffset = offset
  encoded.forEach(({ entry, name, compressed }, index) => {
    const header = new Uint8Array(46)
    const view = new DataView(header.buffer)
    view.setUint32(0, 0x02014b50, true)
    view.setUint16(4, 0x0314, true)
    view.setUint16(6, 20, true)
    view.setUint16(8, entry.flags ?? 0x0800, true)
    view.setUint16(10, entry.deflate ? 8 : 0, true)
    view.setUint32(16, entry.crc ?? testCrc32(entry.data), true)
    view.setUint32(20, compressed.byteLength, true)
    view.setUint32(24, entry.declaredSize ?? entry.data.byteLength, true)
    view.setUint16(28, name.byteLength, true)
    view.setUint32(38, entry.externalAttributes ?? 0x81a40000, true)
    view.setUint32(42, offsets[index], true)
    central.push(header, name)
    offset += header.byteLength + name.byteLength
  })
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, entries.length, true)
  endView.setUint16(10, entries.length, true)
  endView.setUint32(12, offset - centralOffset, true)
  endView.setUint32(16, centralOffset, true)
  const output = new Uint8Array(offset + end.byteLength)
  let writeOffset = 0
  for (const chunk of [...chunks, ...central, end]) {
    output.set(chunk, writeOffset)
    writeOffset += chunk.byteLength
  }
  return output
}

describe('NBS zipped song bundles', () => {
  it('writes deterministic OpenNBS paths and restores instrument/audio associations', async () => {
    const song = makeSong([
      { name: 'Lead', file: 'kit/Lead.ogg', key: 45, pressKey: true },
      { name: 'Snare', file: 'Snare.wav', key: 40, pressKey: false },
    ])
    const nbs = writeNbs(song, 5)
    const input = [
      { file: 'Snare.wav', data: wav },
      { file: 'kit/Lead.ogg', data: ogg },
    ]
    const first = writeNbsBundleWithWarnings(nbs, input)
    const second = writeNbsBundleWithWarnings(nbs, [...input].reverse())

    expect(first.data).toEqual(second.data)
    expect(first.includedAudioCount).toBe(2)
    expect(first.warnings).toEqual([])
    const safeEntries = await readSafeZipEntries(first.data)
    expect(safeEntries.map(entry => entry.path)).toEqual([
      'song.nbs',
      'sounds/Snare.wav',
      'sounds/kit/Lead.ogg',
    ])
    const parsed = await parseNbsBundle(first.data)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.song.customInstruments).toEqual(song.customInstruments)
    expect(parsed.audio.map(audio => ({
      index: audio.customInstrumentIndex,
      id: audio.instrumentId,
      path: audio.archivePath,
      type: audio.mediaType,
      soundId: audio.soundId,
    }))).toEqual([
      { index: 0, id: 16, path: 'sounds/kit/Lead.ogg', type: 'audio/ogg', soundId: 'nbs:custom/kit/Lead' },
      { index: 1, id: 17, path: 'sounds/Snare.wav', type: 'audio/wav', soundId: 'nbs:custom/Snare' },
    ])
    expect(parsed.audio[0].data).toEqual(ogg)
    expect(parsed.audio[1].data).toEqual(wav)
    expect(parsed.ignoredEntries).toEqual([])
  })

  it('stores one entry when multiple custom instruments share an audio file', async () => {
    const song = makeSong([
      { name: 'A', file: 'shared.ogg', key: 40, pressKey: true },
      { name: 'B', file: 'shared.ogg', key: 50, pressKey: true },
    ])
    const bundle = writeNbsBundleWithWarnings(writeNbs(song, 5), [{ file: 'shared.ogg', data: ogg }])
    expect(bundle.includedAudioCount).toBe(1)
    const parsed = await parseNbsBundle(bundle.data)
    expect(parsed.ok && parsed.audio).toHaveLength(2)
    if (parsed.ok) expect(parsed.audio[0].data).toBe(parsed.audio[1].data)
  })

  it('treats the exact Sound Stopper instrument as functional metadata without bundled audio', async () => {
    const song = makeSong([
      { name: 'Sound Stopper', file: '', key: 45, pressKey: false },
    ])
    const bundle = writeNbsBundleWithWarnings(writeNbs(song, 5), [])

    expect(bundle.includedAudioCount).toBe(0)
    expect(bundle.warnings).toEqual([])
    const parsed = await parseNbsBundle(bundle.data)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.audio).toEqual([])
    expect(parsed.warnings).toEqual([])
    expect(parsed.song.customInstruments).toEqual(song.customInstruments)
  })

  it('reports missing, unreferenced, and signature-mismatched audio without mutating NBS metadata', async () => {
    const song = makeSong([
      { name: 'Lead', file: 'lead.ogg', key: 45, pressKey: true },
      { name: 'Missing', file: 'missing.wav', key: 45, pressKey: true },
    ])
    const bundle = writeNbsBundleWithWarnings(writeNbs(song, 5), [
      { file: 'lead.ogg', data: wav },
      { file: 'extra.ogg', data: ogg },
    ])
    expect(bundle.warnings.join('\n')).toMatch(/signature does not match lead\.ogg/i)
    expect(bundle.warnings.join('\n')).toMatch(/No audio was supplied.*missing\.wav/i)
    expect(bundle.warnings.join('\n')).toMatch(/1 unreferenced custom audio input/i)
    const parsed = await parseNbsBundle(bundle.data)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.song.customInstruments).toEqual(song.customInstruments)
    expect(parsed.warnings.join('\n')).toMatch(/signature does not match lead\.ogg/i)
    expect(parsed.warnings.join('\n')).toMatch(/Missing bundled sound.*missing\.wav/i)
  })

  it('reads deflated entries produced by conventional ZIP tools', async () => {
    const song = makeSong([{ name: 'Lead', file: 'lead.ogg', key: 45, pressKey: true }])
    const bundle = rawZip([
      { path: 'song.nbs', data: writeNbs(song, 5), deflate: true },
      { path: 'sounds/lead.ogg', data: ogg, deflate: true },
    ])
    const parsed = await parseNbsBundle(bundle)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.audio[0].data).toEqual(ogg)
  })

  it('selectively inflates entries with separate scan-name and expanded-data budgets', async () => {
    const archive = rawZip([
      { path: 'pack.mcmeta', data: Uint8Array.of(1, 2, 3) },
      { path: 'assets/example/textures/large.png', data: new Uint8Array(2 * 1024 * 1024) },
    ])
    const strictLimits = { maxEntryBytes: 1024, maxExpandedBytes: 1024 }
    await expect(readSafeZipEntries(archive, { limits: strictLimits })).rejects.toThrow(/entry exceeds/i)
    const selected = await readSafeZipEntries(archive, {
      include: entry => entry.path === 'pack.mcmeta',
      limits: strictLimits,
    })
    expect(selected).toEqual([{ path: 'pack.mcmeta', directory: false, data: Uint8Array.of(1, 2, 3) }])
  })

  it('validates paths and local metadata even for entries excluded from inflation', async () => {
    await expect(readSafeZipEntries(rawZip([
      { path: 'pack.mcmeta', data: Uint8Array.of(1) },
      { path: '../ignored.png', data: Uint8Array.of(2) },
    ]), { include: entry => entry.path === 'pack.mcmeta' })).rejects.toThrow(/Unsafe ZIP path/i)

    const mismatched = rawZip([
      { path: 'pack.mcmeta', data: Uint8Array.of(1) },
      { path: 'ignored.png', data: Uint8Array.of(2) },
    ])
    const ignoredOffset = 30 + new TextEncoder().encode('pack.mcmeta').byteLength + 1
    new DataView(mismatched.buffer).setUint32(ignoredOffset + 14, 0, true)
    await expect(readSafeZipEntries(mismatched, {
      include: entry => entry.path === 'pack.mcmeta',
    })).rejects.toThrow(/local\/central metadata mismatch/i)
  })

  it.each([
    '../evil.ogg',
    '/absolute.ogg',
    'C:/drive.ogg',
    'sounds\\backslash.ogg',
    'sounds/../escape.ogg',
    'sounds/CON.ogg',
    'sounds/trailing. ',
  ])('rejects unsafe cross-platform ZIP path %s', async (path) => {
    const song = makeSong([])
    const result = await parseNbsBundle(rawZip([
      { path: 'song.nbs', data: writeNbs(song, 5) },
      { path, data: ogg },
    ]))
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/Unsafe ZIP path/i) })
  })

  it('rejects case-insensitive duplicate names before reading entry contents', async () => {
    const song = makeSong([])
    const result = await parseNbsBundle(rawZip([
      { path: 'song.nbs', data: writeNbs(song, 5) },
      { path: 'SONG.NBS', data: writeNbs(song, 5) },
    ]))
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/Duplicate ZIP entry name/i) })
  })

  it('rejects entries whose declared expanded size exceeds the per-file budget', async () => {
    const result = await parseNbsBundle(rawZip([{
      path: 'song.nbs',
      data: Uint8Array.of(1),
      declaredSize: NBS_BUNDLE_LIMITS.maxEntryBytes + 1,
    }]))
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/entry exceeds.*expanded bytes/i) })
  })

  it('rejects corrupt CRCs, encrypted files, symlinks, and excess entry counts', async () => {
    const songData = writeNbs(makeSong([]), 5)
    const corrupt = await parseNbsBundle(rawZip([{ path: 'song.nbs', data: songData, crc: 1 }]))
    expect(corrupt).toEqual({ ok: false, error: expect.stringMatching(/CRC mismatch/i) })

    const encrypted = await parseNbsBundle(rawZip([{ path: 'song.nbs', data: songData, flags: 0x0801 }]))
    expect(encrypted).toEqual({ ok: false, error: expect.stringMatching(/Encrypted ZIP/i) })

    const symlink = await parseNbsBundle(rawZip([{
      path: 'song.nbs', data: songData, externalAttributes: 0xa1ff0000,
    }]))
    expect(symlink).toEqual({ ok: false, error: expect.stringMatching(/Symbolic-link ZIP/i) })

    const tooMany = Array.from({ length: NBS_BUNDLE_LIMITS.maxEntries + 1 }, (_, index) => ({
      path: `file-${index}.bin`, data: Uint8Array.of(index & 0xff),
    }))
    const excessive = await parseNbsBundle(rawZip(tooMany))
    expect(excessive).toEqual({ ok: false, error: expect.stringMatching(/exceeds 512 entries/i) })
  })

  it('requires the exact OpenNBS root song name and ignores unreferenced regular files', async () => {
    const songData = writeNbs(makeSong([]), 5)
    const wrongCase = await parseNbsBundle(rawZip([{ path: 'Song.nbs', data: songData }]))
    expect(wrongCase).toEqual({ ok: false, error: expect.stringMatching(/must contain song\.nbs/i) })

    const result = await parseNbsBundle(rawZip([
      { path: 'song.nbs', data: songData },
      { path: 'readme.txt', data: Uint8Array.of(1) },
    ]))
    expect(result.ok && result.ignoredEntries).toEqual(['readme.txt'])
    expect(result.ok && result.warnings.join('\n')).toMatch(/1 unreferenced bundle file/i)
  })

  it('warns instead of resolving unsafe sound paths embedded in otherwise valid NBS data', async () => {
    const song = makeSong([{ name: 'Unsafe', file: '../escape.ogg', key: 45, pressKey: true }])
    const result = await parseNbsBundle(rawZip([{ path: 'song.nbs', data: writeNbs(song, 5) }]))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.audio).toEqual([])
      expect(result.warnings.join('\n')).toMatch(/unsafe sound path/i)
    }
  })

  it('normalizes OpenNBS backslashes but rejects traversal and duplicate audio inputs', () => {
    expect(normalizeNbsInstrumentFile('kit\\lead.ogg')).toBe('kit/lead.ogg')
    expect(nbsBundleArchivePath('kit\\lead.ogg')).toBe('sounds/kit/lead.ogg')
    expect(() => normalizeNbsInstrumentFile('../lead.ogg')).toThrow(/Unsafe ZIP path/i)
    const nbs = writeNbs(makeSong([{ name: 'Lead', file: 'Kit/lead.ogg', key: 45, pressKey: true }]), 5)
    expect(() => writeNbsBundleWithWarnings(nbs, [
      { file: 'kit/LEAD.ogg', data: ogg },
      { file: 'KIT/lead.ogg', data: ogg },
    ])).toThrow(/Duplicate custom audio input/i)
  })
})
