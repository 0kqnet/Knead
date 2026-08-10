import { describe, expect, it } from 'vitest'
import {
  mergeResourcePackCustomAudio,
  parseResourcePackArchive,
  prepareResourcePackInstall,
  resolveResourcePackArchives,
} from './resourcePackImport'
import type { EmbeddedCustomAudioAsset } from '../types/timeline'

const textEncoder = new TextEncoder()

let crcTable: Uint32Array | undefined
function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let index = 0; index < 256; index++) {
      let value = index
      for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1
      crcTable[index] = value >>> 0
    }
  }
  let value = 0xffffffff
  for (const byte of data) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function record(length: number): { bytes: Uint8Array, view: DataView } {
  const bytes = new Uint8Array(length)
  return { bytes, view: new DataView(bytes.buffer) }
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

function zip(files: Record<string, string | Uint8Array>): Uint8Array {
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let localOffset = 0
  for (const [path, value] of Object.entries(files)) {
    const name = textEncoder.encode(path)
    const data = typeof value === 'string' ? textEncoder.encode(value) : value
    const crc = crc32(data)
    const local = record(30)
    local.view.setUint32(0, 0x04034b50, true)
    local.view.setUint16(4, 20, true)
    local.view.setUint16(6, 0x0800, true)
    local.view.setUint32(14, crc, true)
    local.view.setUint32(18, data.byteLength, true)
    local.view.setUint32(22, data.byteLength, true)
    local.view.setUint16(26, name.byteLength, true)
    locals.push(local.bytes, name, data)

    const central = record(46)
    central.view.setUint32(0, 0x02014b50, true)
    central.view.setUint16(4, 0x0314, true)
    central.view.setUint16(6, 20, true)
    central.view.setUint16(8, 0x0800, true)
    central.view.setUint32(16, crc, true)
    central.view.setUint32(20, data.byteLength, true)
    central.view.setUint32(24, data.byteLength, true)
    central.view.setUint16(28, name.byteLength, true)
    central.view.setUint32(38, 0x81a40000, true)
    central.view.setUint32(42, localOffset, true)
    centrals.push(central.bytes, name)
    localOffset += 30 + name.byteLength + data.byteLength
  }
  const centralBytes = concat(centrals)
  const end = record(22)
  end.view.setUint32(0, 0x06054b50, true)
  end.view.setUint16(8, Object.keys(files).length, true)
  end.view.setUint16(10, Object.keys(files).length, true)
  end.view.setUint32(12, centralBytes.byteLength, true)
  end.view.setUint32(16, localOffset, true)
  return concat([...locals, centralBytes, end.bytes])
}

const ogg = Uint8Array.of(0x4f, 0x67, 0x67, 0x53, 1, 2, 3, 4)
const wav = Uint8Array.of(
  0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0,
  0x57, 0x41, 0x56, 0x45, 1, 2, 3, 4,
)
const mp3 = Uint8Array.of(0x49, 0x44, 0x33, 4, 0, 0, 0)

function pack(
  sounds: Record<string, unknown>,
  audio: Record<string, Uint8Array>,
  packMetadata: Record<string, unknown> = { pack_format: 34, description: 'Test pack' },
): Uint8Array {
  return zip({
    'pack.mcmeta': JSON.stringify({ pack: packMetadata }),
    'assets/example/sounds.json': JSON.stringify(sounds),
    ...audio,
  })
}

describe('Java resource-pack ZIP import', () => {
  it('accepts a common wrapper folder, validates audio signatures, and reports MP3 compatibility', async () => {
    const wrapped = zip({
      'My Pack/pack.mcmeta': JSON.stringify({ pack: { pack_format: 34, description: { text: 'Wrapped' } } }),
      'My Pack/assets/example/sounds.json': JSON.stringify({
        kick: { sounds: ['drums/kick'] },
        guide: { sounds: ['guide/theme.mp3'] },
      }),
      'My Pack/assets/example/sounds/drums/kick.ogg': ogg,
      'My Pack/assets/example/sounds/guide/theme.mp3': mp3,
    })
    const parsed = await parseResourcePackArchive(wrapped, 'C:\\Packs\\wrapped.zip')
    expect(parsed.label).toBe('wrapped.zip')
    expect(parsed.packFormat).toBe(34)
    expect(parsed.description).toContain('Wrapped')
    expect(parsed.audio.map(asset => asset.mimeType)).toEqual(['audio/ogg', 'audio/mpeg'])
    expect(parsed.warnings.join('\n')).toMatch(/wrapper folder/i)
    expect(parsed.warnings.join('\n')).toMatch(/MP3 is not a native/i)
  })

  it('resolves multiple packs from low to high priority and preserves variant metadata', async () => {
    const base = await parseResourcePackArchive(pack({
      kick: { sounds: [{ name: 'drums/kick', pitch: 0.75, volume: 0.5, weight: 3 }] },
    }, {
      'assets/example/sounds/drums/kick.ogg': ogg,
    }), 'base.zip')
    const high = await parseResourcePackArchive(pack({
      kick: {
        replace: true,
        sounds: [{
          name: 'drums/kick', pitch: 1.25, volume: 0.8, weight: 7,
          stream: true, preload: true, attenuation_distance: 24,
        }],
      },
    }, {
      'assets/example/sounds/drums/kick.wav': wav,
    }), 'high.zip')

    const resolved = resolveResourcePackArchives([base, high])
    expect(resolved.warnings.join('\n')).toMatch(/Multiple audio formats/i)
    expect(resolved.sounds).toEqual([{
      id: 'example:kick',
      subtitle: undefined,
      variants: [{
        path: 'assets/example/sounds/drums/kick.wav',
        hash: high.audio[0].fingerprint,
        pitch: 1.25,
        volume: 0.8,
        weight: 7,
        stream: true,
        preload: true,
        attenuationDistance: 24,
      }],
    }])

    const plan = await prepareResourcePackInstall([base, high])
    expect(plan.assets).toHaveLength(1)
    expect(plan.assets[0]).toMatchObject({
      soundId: 'example:kick',
      mimeType: 'audio/wav',
      pitch: 1.25,
      volume: 0.8,
      weight: 7,
      stream: true,
      preload: true,
      attenuationDistance: 24,
    })
    const existing = [{
      ...plan.assets[0], soundId: 'keep:sample', fingerprint: 'a'.repeat(64),
    }, {
      ...plan.assets[0], soundId: 'example:kick', fingerprint: 'b'.repeat(64),
    }] satisfies EmbeddedCustomAudioAsset[]
    expect(mergeResourcePackCustomAudio(existing, plan).map(asset => asset.soundId))
      .toEqual(['keep:sample', 'example:kick'])
  })

  it('reports malformed pack formats and missing/cyclic sound references', async () => {
    const parsed = await parseResourcePackArchive(pack({
      cycle: { sounds: [{ name: 'cycle', type: 'event' }] },
      missing: { sounds: ['does/not/exist'] },
    }, {}, { pack_format: 0, supported_formats: [40, 20] }), 'broken.zip')
    expect(parsed.warnings.join('\n')).toMatch(/pack_format/i)
    expect(parsed.warnings.join('\n')).toMatch(/supported_formats/i)
    const resolved = resolveResourcePackArchives([parsed])
    expect(resolved.sounds).toEqual([])
    expect(resolved.warnings.join('\n')).toMatch(/cycle/i)
    expect(resolved.warnings.join('\n')).toMatch(/missing/i)
  })

  it('inherits hardened ZIP traversal and portable asset-count limits', async () => {
    await expect(parseResourcePackArchive(zip({
      '../pack.mcmeta': JSON.stringify({ pack: { pack_format: 34 } }),
    }))).rejects.toThrow(/Unsafe ZIP path/i)

    const files: Record<string, string | Uint8Array> = {
      'pack.mcmeta': JSON.stringify({ pack: { pack_format: 34 } }),
      'assets/example/sounds.json': JSON.stringify({}),
    }
    for (let index = 0; index < 257; index++) {
      files[`assets/example/sounds/sample_${index}.ogg`] = ogg
    }
    await expect(parseResourcePackArchive(zip(files))).rejects.toThrow(/portable project limit/i)
  })

  it('scans large unrelated pack metadata without inflating textures', async () => {
    const files: Record<string, string | Uint8Array> = {
      'pack.mcmeta': JSON.stringify({ pack: { pack_format: 34 } }),
      'assets/example/sounds.json': JSON.stringify({ kick: { sounds: ['kick'] } }),
      'assets/example/sounds/kick.ogg': ogg,
    }
    for (let index = 0; index < 700; index++) {
      files[`assets/example/textures/generated/texture_${index}.png`] = Uint8Array.of(index & 0xff)
    }
    const parsed = await parseResourcePackArchive(zip(files), 'large.zip')
    expect(parsed.audio).toHaveLength(1)
    expect(resolveResourcePackArchives([parsed]).sounds[0].id).toBe('example:kick')
  })
})
