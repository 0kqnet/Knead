import { isSoundStopperInstrument, parseNbs, type NbsInstrument, type NbsSong } from './nbs'

/**
 * Open Note Block Studio's zipped-song layout is:
 *
 *   song.nbs
 *   sounds/<custom instrument file path>
 *
 * The importer deliberately never extracts entries to disk. Besides avoiding
 * zip-slip by construction, this lets us enforce the expanded-size budget
 * while a deflated entry is streaming instead of after a bomb has inflated.
 */
export const NBS_BUNDLE_LIMITS = Object.freeze({
  maxArchiveBytes: 64 * 1024 * 1024,
  maxEntries: 512,
  maxEntryBytes: 32 * 1024 * 1024,
  maxExpandedBytes: 96 * 1024 * 1024,
  maxNameBytes: 1024,
  maxTotalNameBytes: 64 * 1024,
  maxCompressionRatio: 1000,
})

export type NbsBundleMediaType =
  | 'audio/ogg'
  | 'audio/wav'
  | 'audio/mpeg'
  | 'application/octet-stream'

export interface NbsBundleAudioInput {
  /** Path relative to OpenNBS's Sounds directory (the value stored in NBS). */
  file: string
  data: Uint8Array
}

export interface NbsBundleInstrumentAudio {
  /** Zero-based index in song.customInstruments. */
  customInstrumentIndex: number
  /** Absolute NBS instrument ID (vanillaInstrumentCount + customInstrumentIndex). */
  instrumentId: number
  instrument: NbsInstrument
  /** The soundId emitted by nbsToTimelineState for this custom instrument. */
  soundId: string
  /** Canonical ZIP entry name. */
  archivePath: string
  mediaType: NbsBundleMediaType
  data: Uint8Array
}

export interface NbsBundleImportSuccess {
  ok: true
  song: NbsSong
  nbsData: Uint8Array
  audio: NbsBundleInstrumentAudio[]
  warnings: string[]
  ignoredEntries: string[]
}

export type NbsBundleImportResult =
  | NbsBundleImportSuccess
  | { ok: false, error: string }

export interface NbsBundleWriteResult {
  data: Uint8Array
  warnings: string[]
  includedAudioCount: number
}

/** Reusable, already-expanded result for other trusted bundle profiles. */
export interface SafeZipEntry {
  path: string
  directory: boolean
  data: Uint8Array
}

/** Metadata exposed to a selective ZIP profile before any entry is inflated. */
export interface SafeZipEntryMetadata {
  path: string
  directory: boolean
  compressionMethod: 0 | 8
  compressedSize: number
  uncompressedSize: number
}

/**
 * Limits for the archive scan and for the subset selected by `include`.
 *
 * `maxEntries`, `maxNameBytes`, and `maxTotalNameBytes` apply to every central
 * directory record. `maxEntryBytes`, `maxExpandedBytes`, and
 * `maxCompressionRatio` apply only to selected entries, so callers can inspect
 * a large resource pack without inflating unrelated textures or metadata.
 */
export interface SafeZipReadLimits {
  maxArchiveBytes: number
  maxEntries: number
  maxEntryBytes: number
  maxExpandedBytes: number
  maxNameBytes: number
  maxTotalNameBytes: number
  maxCompressionRatio: number
}

export interface SafeZipReadOptions {
  /** Return and inflate only matching entries. All entry metadata is still validated. */
  include?: (entry: Readonly<SafeZipEntryMetadata>) => boolean
  limits?: Partial<SafeZipReadLimits>
}

interface ZipEntry {
  path: string
  canonicalKey: string
  directory: boolean
  data: Uint8Array
}

interface CentralEntry {
  path: string
  canonicalKey: string
  directory: boolean
  flags: number
  method: number
  crc: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
  externalAttributes: number
  selected: boolean
}

const LOCAL_FILE_SIGNATURE = 0x04034b50
const CENTRAL_FILE_SIGNATURE = 0x02014b50
const END_SIGNATURE = 0x06054b50
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50
const UTF8_FLAG = 0x0800
const ENCRYPTED_FLAG = 0x0001
const DATA_DESCRIPTOR_FLAG = 0x0008
const SUPPORTED_FLAGS = UTF8_FLAG | DATA_DESCRIPTOR_FLAG
const DEFLATE_OPTION_FLAGS = 0x0006
const MIN_EOCD_BYTES = 22
const MAX_EOCD_SEARCH = 0xffff + MIN_EOCD_BYTES
const ZIP32_SENTINEL = 0xffffffff

const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

function u16(view: DataView, offset: number): number {
  return view.getUint16(offset, true)
}

function u32(view: DataView, offset: number): number {
  return view.getUint32(offset, true)
}

function checkedEnd(offset: number, length: number, limit: number, label: string): number {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
    throw new Error(`Invalid ZIP ${label}`)
  }
  const end = offset + length
  if (!Number.isSafeInteger(end) || end > limit) throw new Error(`Truncated ZIP ${label}`)
  return end
}

function asBytes(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data)
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function unsafeWindowsSegment(segment: string): boolean {
  if (/[<>:"|?*]/u.test(segment)
    || Array.from(segment).some(character => (character.codePointAt(0) ?? 0) < 0x20)) return true
  if (segment.endsWith('.') || segment.endsWith(' ')) return true
  const stem = segment.split('.')[0].toUpperCase()
  return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(stem)
}

function validateRelativePath(path: string, directory = false): string {
  if (!path || path.includes('\\') || path.includes('\0') || path.startsWith('/')) {
    throw new Error(`Unsafe ZIP path: ${JSON.stringify(path)}`)
  }
  const value = directory && path.endsWith('/') ? path.slice(0, -1) : path
  if (!value || (!directory && path.endsWith('/'))) throw new Error(`Unsafe ZIP path: ${JSON.stringify(path)}`)
  const segments = value.split('/')
  if (segments.length > 16 || segments.some(segment => (
    !segment
    || segment === '.'
    || segment === '..'
    || unsafeWindowsSegment(segment)
    || utf8Encoder.encode(segment).byteLength > 255
  ))) {
    throw new Error(`Unsafe ZIP path: ${JSON.stringify(path)}`)
  }
  return value
}

function canonicalPathKey(path: string): string {
  return validateRelativePath(path, path.endsWith('/'))
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
}

/** Convert an NBS Sounds-relative path into a safe, portable path. */
export function normalizeNbsInstrumentFile(file: string): string {
  return validateRelativePath(file.replace(/\\/gu, '/'))
}

export function nbsBundleArchivePath(file: string): string {
  return `sounds/${normalizeNbsInstrumentFile(file)}`
}

/** Mirrors nbsToTimelineState's stable custom sound identifier. */
export function nbsBundleSoundId(instrument: NbsInstrument, instrumentId: number): string {
  const path = instrument.file
    .replace(/\\/gu, '/')
    .replace(/\.[^.]+$/u, '')
    .replace(/[^a-zA-Z0-9_./-]+/gu, '_')
  return `nbs:custom/${path || `instrument_${instrumentId}`}`
}

let crcTable: Uint32Array | undefined

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable
  crcTable = new Uint32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1)
    }
    crcTable[index] = value >>> 0
  }
  return crcTable
}

function crc32(data: Uint8Array): number {
  const table = getCrcTable()
  let value = 0xffffffff
  for (const byte of data) value = table[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function findEndRecord(view: DataView): number {
  const first = Math.max(0, view.byteLength - MAX_EOCD_SEARCH)
  for (let offset = view.byteLength - MIN_EOCD_BYTES; offset >= first; offset--) {
    if (u32(view, offset) !== END_SIGNATURE) continue
    const commentLength = u16(view, offset + 20)
    if (offset + MIN_EOCD_BYTES + commentLength === view.byteLength) return offset
  }
  throw new Error('ZIP end-of-central-directory record was not found')
}

function decodeEntryName(bytes: Uint8Array, maxNameBytes: number): string {
  if (!bytes.byteLength || bytes.byteLength > maxNameBytes) {
    throw new Error('Invalid ZIP entry name length')
  }
  try {
    return utf8Decoder.decode(bytes)
  }
  catch {
    throw new Error('ZIP entry names must be valid UTF-8')
  }
}

function positiveLimit(value: number, label: keyof SafeZipReadLimits): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid safe ZIP limit: ${label}`)
  return value
}

function resolveSafeZipLimits(overrides?: Partial<SafeZipReadLimits>): SafeZipReadLimits {
  const limits = { ...NBS_BUNDLE_LIMITS, ...overrides }
  return {
    maxArchiveBytes: positiveLimit(limits.maxArchiveBytes, 'maxArchiveBytes'),
    maxEntries: positiveLimit(limits.maxEntries, 'maxEntries'),
    maxEntryBytes: positiveLimit(limits.maxEntryBytes, 'maxEntryBytes'),
    maxExpandedBytes: positiveLimit(limits.maxExpandedBytes, 'maxExpandedBytes'),
    maxNameBytes: positiveLimit(limits.maxNameBytes, 'maxNameBytes'),
    maxTotalNameBytes: positiveLimit(limits.maxTotalNameBytes, 'maxTotalNameBytes'),
    maxCompressionRatio: positiveLimit(limits.maxCompressionRatio, 'maxCompressionRatio'),
  }
}

function parseCentralEntries(
  bytes: Uint8Array,
  limits: SafeZipReadLimits,
  include?: SafeZipReadOptions['include'],
): { entries: CentralEntry[], centralOffset: number } {
  if (!bytes.byteLength || bytes.byteLength > limits.maxArchiveBytes) {
    throw new Error('Invalid ZIP archive size')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const endOffset = findEndRecord(view)
  const disk = u16(view, endOffset + 4)
  const centralDisk = u16(view, endOffset + 6)
  const diskEntries = u16(view, endOffset + 8)
  const totalEntries = u16(view, endOffset + 10)
  const centralSize = u32(view, endOffset + 12)
  const centralOffset = u32(view, endOffset + 16)
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) {
    throw new Error('Multi-disk ZIP bundles are unsupported')
  }
  if (totalEntries === 0 || totalEntries === 0xffff
    || centralSize === ZIP32_SENTINEL || centralOffset === ZIP32_SENTINEL) {
    throw new Error(totalEntries === 0 ? 'NBS bundle is empty' : 'ZIP64 bundles are unsupported')
  }
  if (totalEntries > limits.maxEntries) {
    throw new Error(`ZIP archive exceeds ${limits.maxEntries} entries`)
  }
  if (checkedEnd(centralOffset, centralSize, bytes.byteLength, 'central directory') !== endOffset) {
    throw new Error('Invalid ZIP central-directory bounds')
  }

  const entries: CentralEntry[] = []
  const names = new Map<string, { path: string, directory: boolean }>()
  let offset = centralOffset
  let totalNames = 0
  let totalExpanded = 0
  for (let index = 0; index < totalEntries; index++) {
    checkedEnd(offset, 46, endOffset, 'central entry')
    if (u32(view, offset) !== CENTRAL_FILE_SIGNATURE) throw new Error('Invalid ZIP central entry signature')
    const flags = u16(view, offset + 8)
    const method = u16(view, offset + 10)
    const crc = u32(view, offset + 16)
    const compressedSize = u32(view, offset + 20)
    const uncompressedSize = u32(view, offset + 24)
    const nameLength = u16(view, offset + 28)
    const extraLength = u16(view, offset + 30)
    const commentLength = u16(view, offset + 32)
    const startDisk = u16(view, offset + 34)
    const externalAttributes = u32(view, offset + 38)
    const localOffset = u32(view, offset + 42)
    const recordEnd = checkedEnd(offset, 46 + nameLength + extraLength + commentLength, endOffset, 'central entry')
    if ((flags & ENCRYPTED_FLAG) !== 0) throw new Error('Encrypted ZIP entries are unsupported')
    if (method !== 0 && method !== 8) throw new Error(`Unsupported ZIP compression method: ${method}`)
    const allowedFlags = SUPPORTED_FLAGS | (method === 8 ? DEFLATE_OPTION_FLAGS : 0)
    if ((flags & ~allowedFlags) !== 0) throw new Error(`Unsupported ZIP entry flags: 0x${flags.toString(16)}`)
    if (startDisk !== 0) throw new Error('Multi-disk ZIP bundles are unsupported')
    if (compressedSize === ZIP32_SENTINEL || uncompressedSize === ZIP32_SENTINEL || localOffset === ZIP32_SENTINEL) {
      throw new Error('ZIP64 entries are unsupported')
    }
    totalNames += nameLength
    if (totalNames > limits.maxTotalNameBytes) throw new Error('ZIP entry names exceed the safe limit')
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength)
    const path = decodeEntryName(nameBytes, limits.maxNameBytes)
    const directory = path.endsWith('/')
    validateRelativePath(path, directory)
    const canonicalKey = canonicalPathKey(path)
    const previous = names.get(canonicalKey)
    if (previous) {
      throw new Error(`Duplicate ZIP entry name: ${JSON.stringify(path)} conflicts with ${JSON.stringify(previous.path)}`)
    }
    names.set(canonicalKey, { path, directory })
    const unixMode = (externalAttributes >>> 16) & 0xf000
    if (unixMode === 0xa000) throw new Error(`Symbolic-link ZIP entry is unsupported: ${path}`)
    const metadata: SafeZipEntryMetadata = {
      path,
      directory,
      compressionMethod: method,
      compressedSize,
      uncompressedSize,
    }
    const selected = include ? include(Object.freeze(metadata)) : true
    if (selected) {
      if (uncompressedSize > limits.maxEntryBytes) {
        throw new Error(`ZIP entry exceeds ${limits.maxEntryBytes} expanded bytes`)
      }
      if (uncompressedSize > 1024 * 1024
        && compressedSize > 0
        && uncompressedSize / compressedSize > limits.maxCompressionRatio) {
        throw new Error('ZIP entry exceeds the safe compression ratio')
      }
      totalExpanded += uncompressedSize
      if (totalExpanded > limits.maxExpandedBytes) {
        throw new Error(`Selected ZIP entries exceed ${limits.maxExpandedBytes} expanded bytes`)
      }
    }
    if (method === 0 && compressedSize !== uncompressedSize) {
      throw new Error(`Invalid stored ZIP entry size: ${path}`)
    }
    entries.push({
      path, canonicalKey, directory, flags, method, crc, compressedSize,
      uncompressedSize, localOffset, externalAttributes, selected,
    })
    offset = recordEnd
  }
  if (offset !== endOffset) throw new Error('ZIP central-directory entry count is inconsistent')

  const byKey = new Map(entries.map(entry => [entry.canonicalKey, entry]))
  for (const entry of entries) {
    const parts = entry.canonicalKey.split('/')
    for (let length = 1; length < parts.length; length++) {
      const parent = byKey.get(parts.slice(0, length).join('/'))
      if (parent && !parent.directory) throw new Error(`ZIP file/directory path collision: ${entry.path}`)
    }
  }
  return { entries, centralOffset }
}

async function inflateRawLimited(
  data: Uint8Array,
  expectedSize: number,
  maxEntryBytes: number,
): Promise<Uint8Array> {
  let stream: ReadableStream<Uint8Array>
  try {
    stream = new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  }
  catch (error) {
    throw new Error(`Deflate decompression is unavailable: ${String(error)}`, { cause: error })
  }
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      size += result.value.byteLength
      if (size > expectedSize || size > maxEntryBytes) {
        await reader.cancel('ZIP entry expanded beyond its declared size')
        throw new Error('ZIP entry expanded beyond its declared size')
      }
      chunks.push(result.value)
    }
  }
  catch (error) {
    if (error instanceof Error && error.message.includes('declared size')) throw error
    throw new Error(`Invalid deflated ZIP entry: ${String(error)}`, { cause: error })
  }
  if (size !== expectedSize) throw new Error('ZIP entry expanded size does not match its directory record')
  const output = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

function dataDescriptorEnd(
  view: DataView,
  dataEnd: number,
  centralOffset: number,
  entry: CentralEntry,
): number {
  const matches = (offset: number): boolean => (
    u32(view, offset) === entry.crc
    && u32(view, offset + 4) === entry.compressedSize
    && u32(view, offset + 8) === entry.uncompressedSize
  )
  if (dataEnd + 16 <= centralOffset
    && u32(view, dataEnd) === DATA_DESCRIPTOR_SIGNATURE
    && matches(dataEnd + 4)) return dataEnd + 16
  checkedEnd(dataEnd, 12, centralOffset, `data descriptor ${entry.path}`)
  if (!matches(dataEnd)) throw new Error(`ZIP data descriptor mismatch: ${entry.path}`)
  return dataEnd + 12
}

async function readZipEntries(
  data: ArrayBuffer | Uint8Array,
  options: SafeZipReadOptions = {},
): Promise<ZipEntry[]> {
  const bytes = asBytes(data)
  const limits = resolveSafeZipLimits(options.limits)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const { entries, centralOffset } = parseCentralEntries(bytes, limits, options.include)
  const ranges: { start: number, end: number, path: string }[] = []
  const output: ZipEntry[] = []
  for (const entry of entries) {
    checkedEnd(entry.localOffset, 30, centralOffset, `local entry ${entry.path}`)
    if (u32(view, entry.localOffset) !== LOCAL_FILE_SIGNATURE) throw new Error(`Invalid local ZIP entry: ${entry.path}`)
    const localFlags = u16(view, entry.localOffset + 6)
    const localMethod = u16(view, entry.localOffset + 8)
    const localCrc = u32(view, entry.localOffset + 14)
    const localCompressedSize = u32(view, entry.localOffset + 18)
    const localUncompressedSize = u32(view, entry.localOffset + 22)
    const nameLength = u16(view, entry.localOffset + 26)
    const extraLength = u16(view, entry.localOffset + 28)
    if (localFlags !== entry.flags || localMethod !== entry.method) {
      throw new Error(`ZIP local/central metadata mismatch: ${entry.path}`)
    }
    const usesDescriptor = (entry.flags & DATA_DESCRIPTOR_FLAG) !== 0
    if ((!usesDescriptor && (
      localCrc !== entry.crc
      || localCompressedSize !== entry.compressedSize
      || localUncompressedSize !== entry.uncompressedSize
    )) || (usesDescriptor && (
      (localCrc !== 0 && localCrc !== entry.crc)
      || (localCompressedSize !== 0 && localCompressedSize !== entry.compressedSize)
      || (localUncompressedSize !== 0 && localUncompressedSize !== entry.uncompressedSize)
    ))) {
      throw new Error(`ZIP local/central metadata mismatch: ${entry.path}`)
    }
    const nameStart = entry.localOffset + 30
    const dataStart = checkedEnd(nameStart, nameLength + extraLength, centralOffset, `local entry ${entry.path}`)
    const dataEnd = checkedEnd(dataStart, entry.compressedSize, centralOffset, `entry data ${entry.path}`)
    const localName = decodeEntryName(bytes.subarray(nameStart, nameStart + nameLength), limits.maxNameBytes)
    if (localName !== entry.path) throw new Error(`ZIP local/central name mismatch: ${entry.path}`)
    const recordEnd = usesDescriptor
      ? dataDescriptorEnd(view, dataEnd, centralOffset, entry)
      : dataEnd
    ranges.push({ start: entry.localOffset, end: recordEnd, path: entry.path })
    if (!entry.selected) continue
    const compressed = bytes.subarray(dataStart, dataEnd)
    let expanded: Uint8Array
    if (entry.method === 0) {
      expanded = compressed.slice()
    }
    else {
      expanded = await inflateRawLimited(compressed, entry.uncompressedSize, limits.maxEntryBytes)
    }
    if (crc32(expanded) !== entry.crc) throw new Error(`ZIP CRC mismatch: ${entry.path}`)
    output.push({
      path: entry.path,
      canonicalKey: entry.canonicalKey,
      directory: entry.directory,
      data: expanded,
    })
  }
  ranges.sort((left, right) => left.start - right.start)
  for (let index = 1; index < ranges.length; index++) {
    if (ranges[index].start < ranges[index - 1].end) {
      throw new Error(`Overlapping ZIP entries: ${ranges[index - 1].path} and ${ranges[index].path}`)
    }
  }
  return output
}

/**
 * Dependency-free safe ZIP reader shared by resource-pack/NBP tooling.
 *
 * Excluded entries are never inflated or CRC-checked, because both require
 * reading their contents. Their central/local headers, names, flags, sizes,
 * ranges, duplicates, path safety, and link type are still validated. The
 * default profile selects every entry and preserves the strict NBS budgets.
 */
export async function readSafeZipEntries(
  data: ArrayBuffer | Uint8Array,
  options: SafeZipReadOptions = {},
): Promise<SafeZipEntry[]> {
  return (await readZipEntries(data, options)).map(entry => ({
    path: entry.path,
    directory: entry.directory,
    data: entry.data,
  }))
}

function mediaTypeFor(file: string, data: Uint8Array): NbsBundleMediaType {
  if (data.byteLength >= 4
    && data[0] === 0x4f && data[1] === 0x67 && data[2] === 0x67 && data[3] === 0x53) return 'audio/ogg'
  if (data.byteLength >= 12
    && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46
    && data[8] === 0x57 && data[9] === 0x41 && data[10] === 0x56 && data[11] === 0x45) return 'audio/wav'
  if (data.byteLength >= 3 && data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) return 'audio/mpeg'
  if (data.byteLength >= 2 && data[0] === 0xff && (data[1] & 0xe0) === 0xe0) return 'audio/mpeg'
  return 'application/octet-stream'
}

function expectedMediaType(file: string): NbsBundleMediaType | undefined {
  const extension = /\.([^.]+)$/u.exec(file)?.[1].toLowerCase()
  if (extension === 'ogg') return 'audio/ogg'
  if (extension === 'wav') return 'audio/wav'
  if (extension === 'mp3') return 'audio/mpeg'
  return undefined
}

/** Safely parse an OpenNBS zipped song without writing any archive entry to disk. */
export async function parseNbsBundle(data: ArrayBuffer | Uint8Array): Promise<NbsBundleImportResult> {
  try {
    const entries = await readZipEntries(data)
    const byKey = new Map(entries.map(entry => [entry.canonicalKey, entry]))
    const songEntry = byKey.get(canonicalPathKey('song.nbs'))
    if (!songEntry || songEntry.directory || songEntry.path !== 'song.nbs') {
      throw new Error('NBS bundle must contain song.nbs at the ZIP root')
    }
    const parsed = parseNbs(songEntry.data.buffer.slice(
      songEntry.data.byteOffset,
      songEntry.data.byteOffset + songEntry.data.byteLength,
    ) as ArrayBuffer)
    if (!parsed.ok) throw new Error(`Invalid bundled song.nbs: ${parsed.error}`)

    const warnings: string[] = []
    const audio: NbsBundleInstrumentAudio[] = []
    const used = new Set<string>([songEntry.canonicalKey])
    parsed.song.customInstruments.forEach((instrument, customInstrumentIndex) => {
      const instrumentId = parsed.song.header.vanillaInstrumentCount + customInstrumentIndex
      if (!instrument.file) {
        if (!isSoundStopperInstrument(instrument)) {
          warnings.push(`Custom instrument ${customInstrumentIndex + 1} (${instrument.name || 'unnamed'}) has no sound file.`)
        }
        return
      }
      let archivePath: string
      try {
        archivePath = nbsBundleArchivePath(instrument.file)
      }
      catch {
        warnings.push(`Custom instrument ${customInstrumentIndex + 1} has an unsafe sound path: ${JSON.stringify(instrument.file)}.`)
        return
      }
      const entry = byKey.get(canonicalPathKey(archivePath))
      if (!entry || entry.directory) {
        warnings.push(`Missing bundled sound for custom instrument ${customInstrumentIndex + 1}: ${archivePath}.`)
        return
      }
      used.add(entry.canonicalKey)
      if (entry.path !== archivePath) {
        warnings.push(`Bundled sound path casing differs from the NBS reference: ${entry.path} / ${archivePath}.`)
      }
      if (entry.data.byteLength === 0) {
        warnings.push(`Bundled sound is empty: ${entry.path}.`)
        return
      }
      const mediaType = mediaTypeFor(instrument.file, entry.data)
      const expected = expectedMediaType(instrument.file)
      if (!expected) warnings.push(`Bundled sound has an unrecognized extension: ${instrument.file}.`)
      else if (mediaType !== expected) warnings.push(`Bundled sound signature does not match ${instrument.file}.`)
      audio.push({
        customInstrumentIndex,
        instrumentId,
        instrument: { ...instrument },
        soundId: nbsBundleSoundId(instrument, instrumentId),
        archivePath,
        mediaType,
        data: entry.data,
      })
    })
    const ignoredEntries = entries
      .filter(entry => !entry.directory && !used.has(entry.canonicalKey))
      .map(entry => entry.path)
      .sort(compareCodeUnits)
    if (ignoredEntries.length) warnings.push(`${ignoredEntries.length} unreferenced bundle file(s) were ignored.`)
    return {
      ok: true,
      song: parsed.song,
      nbsData: songEntry.data,
      audio,
      warnings,
      ignoredEntries,
    }
  }
  catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function header(length: number): { bytes: Uint8Array, view: DataView } {
  const bytes = new Uint8Array(length)
  return { bytes, view: new DataView(bytes.buffer) }
}

function concatBytes(chunks: Uint8Array[], length: number): Uint8Array {
  const output = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

interface StoredEntry {
  path: string
  name: Uint8Array
  data: Uint8Array
  crc: number
  offset: number
}

function writeStoredZip(files: { path: string, data: Uint8Array }[]): Uint8Array {
  if (!files.length || files.length > NBS_BUNDLE_LIMITS.maxEntries) throw new Error('Invalid ZIP entry count')
  const sorted = [...files].sort((left, right) => compareCodeUnits(left.path, right.path))
  const seen = new Set<string>()
  const entries: StoredEntry[] = []
  const localChunks: Uint8Array[] = []
  let localLength = 0
  let expandedSize = 0
  let totalNameBytes = 0
  for (const file of sorted) {
    validateRelativePath(file.path)
    const key = canonicalPathKey(file.path)
    if (seen.has(key)) throw new Error(`Duplicate ZIP entry name: ${file.path}`)
    seen.add(key)
    const name = utf8Encoder.encode(file.path)
    if (name.byteLength > NBS_BUNDLE_LIMITS.maxNameBytes) throw new Error(`ZIP entry name is too long: ${file.path}`)
    totalNameBytes += name.byteLength
    if (totalNameBytes > NBS_BUNDLE_LIMITS.maxTotalNameBytes) throw new Error('ZIP entry names exceed the safe limit')
    if (!file.data.byteLength || file.data.byteLength > NBS_BUNDLE_LIMITS.maxEntryBytes) {
      throw new Error(`Invalid ZIP entry size: ${file.path}`)
    }
    expandedSize += file.data.byteLength
    if (expandedSize > NBS_BUNDLE_LIMITS.maxExpandedBytes) throw new Error('ZIP contents exceed the safe limit')
    const record = header(30)
    record.view.setUint32(0, LOCAL_FILE_SIGNATURE, true)
    record.view.setUint16(4, 20, true)
    record.view.setUint16(6, UTF8_FLAG, true)
    record.view.setUint16(8, 0, true)
    record.view.setUint16(10, 0, true)
    record.view.setUint16(12, 0x21, true) // 1980-01-01, deterministic DOS date.
    const crc = crc32(file.data)
    record.view.setUint32(14, crc, true)
    record.view.setUint32(18, file.data.byteLength, true)
    record.view.setUint32(22, file.data.byteLength, true)
    record.view.setUint16(26, name.byteLength, true)
    record.view.setUint16(28, 0, true)
    entries.push({ path: file.path, name, data: file.data, crc, offset: localLength })
    localChunks.push(record.bytes, name, file.data)
    localLength += record.bytes.byteLength + name.byteLength + file.data.byteLength
  }

  const centralChunks: Uint8Array[] = []
  let centralLength = 0
  for (const entry of entries) {
    const record = header(46)
    record.view.setUint32(0, CENTRAL_FILE_SIGNATURE, true)
    record.view.setUint16(4, 0x0314, true)
    record.view.setUint16(6, 20, true)
    record.view.setUint16(8, UTF8_FLAG, true)
    record.view.setUint16(10, 0, true)
    record.view.setUint16(12, 0, true)
    record.view.setUint16(14, 0x21, true)
    record.view.setUint32(16, entry.crc, true)
    record.view.setUint32(20, entry.data.byteLength, true)
    record.view.setUint32(24, entry.data.byteLength, true)
    record.view.setUint16(28, entry.name.byteLength, true)
    record.view.setUint16(30, 0, true)
    record.view.setUint16(32, 0, true)
    record.view.setUint16(34, 0, true)
    record.view.setUint16(36, 0, true)
    record.view.setUint32(38, 0x81a40000, true) // Unix regular file, mode 0644.
    record.view.setUint32(42, entry.offset, true)
    centralChunks.push(record.bytes, entry.name)
    centralLength += record.bytes.byteLength + entry.name.byteLength
  }
  const end = header(MIN_EOCD_BYTES)
  end.view.setUint32(0, END_SIGNATURE, true)
  end.view.setUint16(4, 0, true)
  end.view.setUint16(6, 0, true)
  end.view.setUint16(8, entries.length, true)
  end.view.setUint16(10, entries.length, true)
  end.view.setUint32(12, centralLength, true)
  end.view.setUint32(16, localLength, true)
  end.view.setUint16(20, 0, true)
  const totalLength = localLength + centralLength + end.bytes.byteLength
  if (totalLength > NBS_BUNDLE_LIMITS.maxArchiveBytes) throw new Error('NBS bundle exceeds the archive size limit')
  return concatBytes([...localChunks, ...centralChunks, end.bytes], totalLength)
}

/**
 * Create a deterministic OpenNBS-compatible bundle. Audio inputs are keyed by
 * the exact Sounds-relative path stored in song.nbs; missing/extra audio is
 * reported instead of silently changing the song's instrument definitions.
 */
export function writeNbsBundleWithWarnings(
  nbsData: Uint8Array,
  audioFiles: readonly NbsBundleAudioInput[],
): NbsBundleWriteResult {
  const parsed = parseNbs(nbsData.buffer.slice(
    nbsData.byteOffset,
    nbsData.byteOffset + nbsData.byteLength,
  ) as ArrayBuffer)
  if (!parsed.ok) throw new Error(`Cannot bundle invalid NBS data: ${parsed.error}`)
  const warnings: string[] = []
  const inputs = new Map<string, { input: NbsBundleAudioInput, normalized: string }>()
  for (const input of audioFiles) {
    const normalized = normalizeNbsInstrumentFile(input.file)
    const key = canonicalPathKey(normalized)
    if (inputs.has(key)) throw new Error(`Duplicate custom audio input: ${input.file}`)
    if (!input.data.byteLength || input.data.byteLength > NBS_BUNDLE_LIMITS.maxEntryBytes) {
      throw new Error(`Invalid custom audio size: ${input.file}`)
    }
    inputs.set(key, { input, normalized })
  }

  const files: { path: string, data: Uint8Array }[] = [{ path: 'song.nbs', data: nbsData }]
  const included = new Set<string>()
  const archivePaths = new Set<string>([canonicalPathKey('song.nbs')])
  parsed.song.customInstruments.forEach((instrument, index) => {
    if (!instrument.file) {
      if (!isSoundStopperInstrument(instrument)) {
        warnings.push(`Custom instrument ${index + 1} (${instrument.name || 'unnamed'}) has no sound file.`)
      }
      return
    }
    let normalized: string
    try {
      normalized = normalizeNbsInstrumentFile(instrument.file)
    }
    catch {
      warnings.push(`Custom instrument ${index + 1} has an unsafe sound path and was not bundled: ${JSON.stringify(instrument.file)}.`)
      return
    }
    const key = canonicalPathKey(normalized)
    const audio = inputs.get(key)
    if (!audio) {
      warnings.push(`No audio was supplied for custom instrument ${index + 1}: ${instrument.file}.`)
      return
    }
    included.add(key)
    const path = nbsBundleArchivePath(instrument.file)
    const archiveKey = canonicalPathKey(path)
    if (archivePaths.has(archiveKey)) return // Multiple instruments may intentionally share a sound.
    archivePaths.add(archiveKey)
    const mediaType = mediaTypeFor(instrument.file, audio.input.data)
    const expected = expectedMediaType(instrument.file)
    if (!expected) warnings.push(`Custom audio has an unrecognized extension: ${instrument.file}.`)
    else if (mediaType !== expected) warnings.push(`Custom audio signature does not match ${instrument.file}.`)
    files.push({ path, data: audio.input.data })
  })
  const extras = [...inputs.entries()]
    .filter(([key]) => !included.has(key))
    .map(([, value]) => value.normalized)
    .sort(compareCodeUnits)
  if (extras.length) warnings.push(`${extras.length} unreferenced custom audio input(s) were not bundled.`)
  return { data: writeStoredZip(files), warnings, includedAudioCount: files.length - 1 }
}
