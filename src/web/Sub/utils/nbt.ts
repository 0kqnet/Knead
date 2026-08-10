/** Minimal big-endian Java NBT encoder used by Minecraft build exports. */

export type NbtTagType =
  | 'byte'
  | 'short'
  | 'int'
  | 'byteArray'
  | 'string'
  | 'list'
  | 'compound'

export type NbtTag =
  | { type: 'byte', value: number }
  | { type: 'short', value: number }
  | { type: 'int', value: number }
  | { type: 'byteArray', value: Uint8Array }
  | { type: 'string', value: string }
  | { type: 'list', elementType: NbtTagType, value: readonly NbtTag[] }
  | { type: 'compound', value: readonly NbtNamedTag[] }

export interface NbtNamedTag {
  name: string
  tag: NbtTag
}

const TAG_IDS: Readonly<Record<NbtTagType, number>> = Object.freeze({
  byte: 1,
  short: 2,
  int: 3,
  byteArray: 7,
  string: 8,
  list: 9,
  compound: 10,
})

const MAX_NBT_DEPTH = 64
const MAX_NBT_LIST_ITEMS = 1_000_000
const textEncoder = new TextEncoder()

class NbtWriter {
  private data: Uint8Array
  private view: DataView
  private offset = 0

  constructor(private readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('NBT byte budget must be a positive integer')
    this.data = new Uint8Array(Math.min(4096, maxBytes))
    this.view = new DataView(this.data.buffer)
  }

  private ensure(count: number): void {
    const required = this.offset + count
    if (!Number.isSafeInteger(required) || required > this.maxBytes) {
      throw new Error(`NBT output exceeds the ${this.maxBytes}-byte budget`)
    }
    if (required <= this.data.length) return
    let size = this.data.length
    while (size < required) size = Math.min(this.maxBytes, Math.max(size + 1, size * 2))
    const next = new Uint8Array(size)
    next.set(this.data)
    this.data = next
    this.view = new DataView(next.buffer)
  }

  u8(value: number): void {
    this.ensure(1)
    this.view.setUint8(this.offset, value & 0xff)
    this.offset++
  }

  i16(value: number): void {
    if (!Number.isInteger(value) || value < -0x8000 || value > 0x7fff) {
      throw new Error(`NBT short is out of range: ${value}`)
    }
    this.ensure(2)
    this.view.setInt16(this.offset, value, false)
    this.offset += 2
  }

  u16(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
      throw new Error(`NBT UTF-8 length is out of range: ${value}`)
    }
    this.ensure(2)
    this.view.setUint16(this.offset, value, false)
    this.offset += 2
  }

  i32(value: number): void {
    if (!Number.isInteger(value) || value < -0x8000_0000 || value > 0x7fff_ffff) {
      throw new Error(`NBT int is out of range: ${value}`)
    }
    this.ensure(4)
    this.view.setInt32(this.offset, value, false)
    this.offset += 4
  }

  bytes(value: Uint8Array): void {
    this.ensure(value.byteLength)
    this.data.set(value, this.offset)
    this.offset += value.byteLength
  }

  string(value: string): void {
    const encoded = textEncoder.encode(value)
    if (encoded.byteLength > 0xffff) throw new Error('NBT string exceeds 65,535 UTF-8 bytes')
    this.u16(encoded.byteLength)
    this.bytes(encoded)
  }

  finish(): Uint8Array {
    return this.data.slice(0, this.offset)
  }
}

function encodePayload(writer: NbtWriter, tag: NbtTag, depth: number): void {
  if (depth > MAX_NBT_DEPTH) throw new Error(`NBT nesting exceeds ${MAX_NBT_DEPTH} levels`)
  switch (tag.type) {
    case 'byte':
      if (!Number.isInteger(tag.value) || tag.value < -0x80 || tag.value > 0xff) {
        throw new Error(`NBT byte is out of range: ${tag.value}`)
      }
      writer.u8(tag.value)
      return
    case 'short':
      writer.i16(tag.value)
      return
    case 'int':
      writer.i32(tag.value)
      return
    case 'byteArray':
      writer.i32(tag.value.byteLength)
      writer.bytes(tag.value)
      return
    case 'string':
      writer.string(tag.value)
      return
    case 'list':
      if (tag.value.length > MAX_NBT_LIST_ITEMS) {
        throw new Error(`NBT list exceeds ${MAX_NBT_LIST_ITEMS} items`)
      }
      writer.u8(TAG_IDS[tag.elementType])
      writer.i32(tag.value.length)
      for (const element of tag.value) {
        if (element.type !== tag.elementType) {
          throw new Error(`NBT list expected ${tag.elementType}, got ${element.type}`)
        }
        encodePayload(writer, element, depth + 1)
      }
      return
    case 'compound':
      for (const entry of tag.value) {
        writer.u8(TAG_IDS[entry.tag.type])
        writer.string(entry.name)
        encodePayload(writer, entry.tag, depth + 1)
      }
      writer.u8(0)
  }
}

export function nbtByte(value: number): NbtTag {
  return { type: 'byte', value }
}

export function nbtShort(value: number): NbtTag {
  return { type: 'short', value }
}

export function nbtInt(value: number): NbtTag {
  return { type: 'int', value }
}

export function nbtByteArray(value: Uint8Array): NbtTag {
  return { type: 'byteArray', value }
}

export function nbtString(value: string): NbtTag {
  return { type: 'string', value }
}

export function nbtList(elementType: NbtTagType, value: readonly NbtTag[]): NbtTag {
  return { type: 'list', elementType, value }
}

export function nbtCompound(value: readonly NbtNamedTag[]): NbtTag {
  return { type: 'compound', value }
}

export function writeNbt(rootName: string, root: NbtTag, maxBytes: number): Uint8Array {
  if (root.type !== 'compound') throw new Error('NBT root must be a compound')
  const writer = new NbtWriter(maxBytes)
  writer.u8(TAG_IDS.compound)
  writer.string(rootName)
  encodePayload(writer, root, 0)
  return writer.finish()
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb8_8320 & -(value & 1))
    table[index] = value >>> 0
  }
  return table
})()

function crc32(data: Uint8Array): number {
  let crc = 0xffff_ffff
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffff_ffff) >>> 0
}

/**
 * Writes a deterministic GZIP stream using DEFLATE stored blocks. The fixed
 * header has mtime=0 and OS=unknown, so identical NBT always yields identical bytes.
 */
export function gzipDeterministic(data: Uint8Array, maxBytes: number): Uint8Array {
  const blockCount = Math.max(1, Math.ceil(data.byteLength / 0xffff))
  const outputLength = 10 + data.byteLength + blockCount * 5 + 8
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || outputLength > maxBytes) {
    throw new Error(`GZIP output exceeds the ${maxBytes}-byte budget`)
  }
  const output = new Uint8Array(outputLength)
  output.set([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff])
  let inputOffset = 0
  let outputOffset = 10
  for (let blockIndex = 0; blockIndex < blockCount; blockIndex++) {
    const length = Math.min(0xffff, data.byteLength - inputOffset)
    const final = blockIndex === blockCount - 1
    output[outputOffset++] = final ? 1 : 0
    output[outputOffset++] = length & 0xff
    output[outputOffset++] = length >>> 8
    const inverted = (~length) & 0xffff
    output[outputOffset++] = inverted & 0xff
    output[outputOffset++] = inverted >>> 8
    output.set(data.subarray(inputOffset, inputOffset + length), outputOffset)
    outputOffset += length
    inputOffset += length
  }
  const trailer = new DataView(output.buffer, output.byteOffset + outputOffset, 8)
  trailer.setUint32(0, crc32(data), true)
  trailer.setUint32(4, data.byteLength >>> 0, true)
  return output
}
