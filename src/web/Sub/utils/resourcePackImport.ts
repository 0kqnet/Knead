import { readSafeZipEntries, type SafeZipEntry } from './nbsBundle'
import {
  resolveResourcePackSounds,
  type ResourcePackLayerInput,
  type ResourcePackSound,
} from './resourcePack'
import { prepareProjectCustomAudioAssets } from './projectCustomAudio'
import type { EmbeddedCustomAudioAsset, EmbeddedCustomAudioMimeType } from '../types/timeline'

export const RESOURCE_PACK_LIMITS = Object.freeze({
  maxMetadataBytes: 256 * 1024,
  maxAudioAssets: 256,
})

export interface ResourcePackAudioAsset {
  path: string
  fingerprint: string
  mimeType: EmbeddedCustomAudioMimeType
  data: Uint8Array
}

export interface ResourcePackManifest {
  namespace: string
  soundsJson: string
}

export interface ParsedResourcePack {
  /** SHA-256 of the original archive; useful as a stable, non-path identity. */
  fingerprint: string
  label: string
  packFormat?: number
  supportedFormats?: { minimum: number, maximum: number }
  description?: string
  manifests: ResourcePackManifest[]
  audio: ResourcePackAudioAsset[]
  warnings: string[]
}

export interface ResolvedResourcePackLibrary {
  sounds: ResourcePackSound[]
  audioByFingerprint: ReadonlyMap<string, ResourcePackAudioAsset>
  warnings: string[]
}

export interface ResourcePackInstallPlan extends ResolvedResourcePackLibrary {
  /** Portable v5 assets ready for restoreProjectCustomAudio and TimelineState.customAudio. */
  assets: EmbeddedCustomAudioAsset[]
  soundIds: string[]
  variantCount: number
}

const utf8Decoder = new TextDecoder('utf-8', { fatal: true })
const encoder = new TextEncoder()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describe(value: unknown): string | undefined {
  if (typeof value === 'string') return value.slice(0, 1024)
  if (value === undefined) return undefined
  try {
    return JSON.stringify(value).slice(0, 1024)
  }
  catch {
    return undefined
  }
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) > 0 && (value as number) <= 999
    ? value as number
    : undefined
}

function supportedFormats(value: unknown): { minimum: number, maximum: number } | undefined {
  const single = positiveInteger(value)
  if (single) return { minimum: single, maximum: single }
  if (Array.isArray(value) && value.length === 2) {
    const minimum = positiveInteger(value[0])
    const maximum = positiveInteger(value[1])
    if (minimum && maximum && minimum <= maximum) return { minimum, maximum }
  }
  if (isRecord(value)) {
    const minimum = positiveInteger(value.min_inclusive)
    const maximum = positiveInteger(value.max_inclusive)
    if (minimum && maximum && minimum <= maximum) return { minimum, maximum }
  }
  return undefined
}

function decodeText(entry: SafeZipEntry, maximumBytes: number, label: string): string {
  if (!entry.data.byteLength || entry.data.byteLength > maximumBytes) {
    throw new Error(`${label} must be between 1 byte and ${maximumBytes} bytes`)
  }
  try {
    return utf8Decoder.decode(entry.data)
  }
  catch {
    throw new Error(`${label} must be valid UTF-8`)
  }
}

function mediaType(path: string, data: Uint8Array): EmbeddedCustomAudioMimeType | undefined {
  const extension = /\.([^.]+)$/u.exec(path)?.[1].toLowerCase()
  if (extension === 'ogg' && data.byteLength >= 4
    && data[0] === 0x4f && data[1] === 0x67 && data[2] === 0x67 && data[3] === 0x53) return 'audio/ogg'
  if (extension === 'wav' && data.byteLength >= 12
    && data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46
    && data[8] === 0x57 && data[9] === 0x41 && data[10] === 0x56 && data[11] === 0x45) return 'audio/wav'
  if (extension === 'mp3' && (
    (data.byteLength >= 3 && data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33)
    || (data.byteLength >= 2 && data[0] === 0xff && (data[1] & 0xe0) === 0xe0)
  )) return 'audio/mpeg'
  return undefined
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

async function fingerprint(data: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto is required to import resource-pack audio')
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data.slice().buffer)
  return hex(new Uint8Array(digest))
}

function relativeEntries(entries: readonly SafeZipEntry[]): { entries: SafeZipEntry[], prefix: string, warnings: string[] } {
  const root = entries.find(entry => !entry.directory && entry.path === 'pack.mcmeta')
  if (root) return { entries: [...entries], prefix: '', warnings: [] }
  const nested = entries.filter(entry => !entry.directory && /(^|\/)pack\.mcmeta$/u.test(entry.path))
  if (nested.length !== 1) throw new Error('Resource pack must contain one pack.mcmeta file')
  const prefix = nested[0].path.slice(0, -'pack.mcmeta'.length)
  if (!prefix || entries.some(entry => !entry.path.startsWith(prefix))) {
    throw new Error('pack.mcmeta must be at the ZIP root or inside one shared wrapper folder')
  }
  return {
    prefix,
    warnings: [`Removed the wrapper folder ${prefix.slice(0, -1)} while importing.`],
    entries: entries.map(entry => ({
      ...entry,
      path: entry.path.slice(prefix.length),
    })).filter(entry => !!entry.path),
  }
}

function parseMetadata(entry: SafeZipEntry, warnings: string[]): {
  packFormat?: number
  supportedFormats?: { minimum: number, maximum: number }
  description?: string
} {
  const text = decodeText(entry, RESOURCE_PACK_LIMITS.maxMetadataBytes, 'pack.mcmeta')
  let raw: unknown
  try {
    raw = JSON.parse(text)
  }
  catch (error) {
    throw new Error(`Invalid pack.mcmeta JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isRecord(raw) || !isRecord(raw.pack)) throw new Error('pack.mcmeta must contain a pack object')
  const packFormat = positiveInteger(raw.pack.pack_format)
  if (!packFormat) warnings.push('pack.mcmeta has a missing or invalid pack_format; audio can still be imported.')
  const range = raw.pack.supported_formats === undefined
    ? undefined
    : supportedFormats(raw.pack.supported_formats)
  if (raw.pack.supported_formats !== undefined && !range) {
    warnings.push('pack.mcmeta has an invalid supported_formats range.')
  }
  if (packFormat && range && (packFormat < range.minimum || packFormat > range.maximum)) {
    warnings.push(`pack_format ${packFormat} is outside supported_formats ${range.minimum}–${range.maximum}.`)
  }
  return {
    packFormat,
    supportedFormats: range,
    description: describe(raw.pack.description),
  }
}

function displayLabel(path: string): string {
  return path.replace(/\\/gu, '/').split('/').filter(Boolean).at(-1) ?? 'resource-pack.zip'
}

/**
 * Safely parse a Java Edition resource-pack ZIP entirely in memory. Nothing is
 * extracted to disk; ZIP path, collision, compression, CRC, and size checks are
 * delegated to the shared hardened reader.
 */
export async function parseResourcePackArchive(
  data: ArrayBuffer | Uint8Array,
  sourceLabel = 'resource-pack.zip',
): Promise<ParsedResourcePack> {
  const archiveBytes = data instanceof Uint8Array
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data)
  const archiveFingerprint = await fingerprint(archiveBytes)
  const normalized = relativeEntries(await readSafeZipEntries(archiveBytes, {
    include: entry => !entry.directory && (
      /(^|\/)pack\.mcmeta$/u.test(entry.path)
      || /(^|\/)assets\/[a-z0-9_.-]{1,64}\/sounds\.json$/u.test(entry.path)
      || /(^|\/)assets\/[a-z0-9_.-]{1,64}\/sounds\/.+\.(?:ogg|wav|mp3)$/u.test(entry.path)
    ),
    limits: {
      // Large packs commonly contain thousands of unrelated textures. Their
      // metadata remains fully checked, but only sound-related entries inflate.
      maxEntries: 65_000,
      maxTotalNameBytes: 8 * 1024 * 1024,
      maxExpandedBytes: 96 * 1024 * 1024,
    },
  }))
  const warnings = [...normalized.warnings]
  const metadataEntry = normalized.entries.find(entry => !entry.directory && entry.path === 'pack.mcmeta')
  if (!metadataEntry) throw new Error('Resource pack is missing pack.mcmeta')
  const metadata = parseMetadata(metadataEntry, warnings)

  const manifestEntries = normalized.entries
    .filter(entry => !entry.directory && /^assets\/[a-z0-9_.-]{1,64}\/sounds\.json$/u.test(entry.path))
    .sort((left, right) => left.path.localeCompare(right.path))
  if (!manifestEntries.length) throw new Error('Resource pack has no assets/<namespace>/sounds.json manifest')
  const manifests = manifestEntries.map((entry) => {
    const namespace = /^assets\/([^/]+)\//u.exec(entry.path)?.[1]
    if (!namespace) throw new Error(`Invalid sounds.json path: ${entry.path}`)
    return {
      namespace,
      soundsJson: decodeText(entry, 4 * 1024 * 1024, entry.path),
    }
  })

  const audioEntries = normalized.entries
    .filter(entry => !entry.directory && /^assets\/[a-z0-9_.-]{1,64}\/sounds\/.+\.(?:ogg|wav|mp3)$/u.test(entry.path))
    .sort((left, right) => left.path.localeCompare(right.path))
  if (audioEntries.length > RESOURCE_PACK_LIMITS.maxAudioAssets) {
    throw new Error(`Resource pack has ${audioEntries.length} audio assets; the portable project limit is ${RESOURCE_PACK_LIMITS.maxAudioAssets}`)
  }
  const audio: ResourcePackAudioAsset[] = []
  for (const entry of audioEntries) {
    const type = mediaType(entry.path, entry.data)
    if (!type) {
      warnings.push(`Skipped audio with an invalid extension/signature pair: ${entry.path}.`)
      continue
    }
    if (type === 'audio/mpeg') {
      warnings.push(`MP3 is not a native Java resource-pack sound format and decoder support varies: ${entry.path}.`)
    }
    audio.push({
      path: entry.path,
      fingerprint: await fingerprint(entry.data),
      mimeType: type,
      data: entry.data,
    })
  }
  if (!audio.length) warnings.push('The resource pack contains no supported OGG or WAV audio assets.')

  return {
    fingerprint: archiveFingerprint,
    label: displayLabel(sourceLabel),
    ...metadata,
    manifests,
    audio,
    warnings: Array.from(new Set(warnings)),
  }
}

/** Resolve packs supplied from lowest to highest priority. */
export function resolveResourcePackArchives(
  packs: readonly ParsedResourcePack[],
): ResolvedResourcePackLibrary {
  const inputs: ResourcePackLayerInput[] = []
  const audioByFingerprint = new Map<string, ResourcePackAudioAsset>()
  const warnings: string[] = []
  for (const pack of packs) {
    warnings.push(...pack.warnings.map(warning => `${pack.label}: ${warning}`))
    for (const audio of pack.audio) audioByFingerprint.set(audio.fingerprint, audio)
    const assets = pack.audio.map(audio => ({ path: audio.path, hash: audio.fingerprint }))
    for (const manifest of pack.manifests) {
      inputs.push({
        namespace: manifest.namespace,
        soundsJson: manifest.soundsJson,
        assets,
        label: pack.label,
      })
    }
  }
  const resolved = resolveResourcePackSounds(inputs)
  warnings.push(...resolved.warnings)
  return {
    sounds: resolved.sounds,
    audioByFingerprint,
    warnings: Array.from(new Set(warnings)),
  }
}

/** Build the portable audio payload while retaining the full resolved metadata. */
export async function prepareResourcePackInstall(
  packs: readonly ParsedResourcePack[],
): Promise<ResourcePackInstallPlan> {
  const resolved = resolveResourcePackArchives(packs)
  const warnings = [...resolved.warnings]
  const inputs = resolved.sounds.flatMap(sound => sound.variants.flatMap((variant) => {
    const audio = resolved.audioByFingerprint.get(variant.hash)
    if (!audio) {
      warnings.push(`Resolved audio bytes are missing for ${sound.id}: ${variant.path}.`)
      return []
    }
    return [{
      soundId: sound.id,
      fileName: variant.path,
      mimeType: audio.mimeType,
      data: audio.data,
      pitch: variant.pitch,
      volume: variant.volume,
      weight: variant.weight,
      stream: variant.stream,
      preload: variant.preload,
      attenuationDistance: variant.attenuationDistance,
    }]
  }))
  const assets = await prepareProjectCustomAudioAssets(inputs)
  if (assets.length !== inputs.length) {
    warnings.push(`${inputs.length - assets.length} repeated sound/content variant(s) were collapsed for portable storage.`)
  }
  return {
    ...resolved,
    assets,
    soundIds: resolved.sounds.map(sound => sound.id),
    variantCount: resolved.sounds.reduce((total, sound) => total + sound.variants.length, 0),
    warnings: Array.from(new Set(warnings)),
  }
}

/** Replace only imported event IDs while preserving unrelated project sounds. */
export function mergeResourcePackCustomAudio(
  existing: readonly EmbeddedCustomAudioAsset[],
  plan: Pick<ResourcePackInstallPlan, 'assets' | 'soundIds'>,
): EmbeddedCustomAudioAsset[] {
  const replaced = new Set(plan.soundIds)
  return [
    ...existing.filter(asset => !replaced.has(asset.soundId)),
    ...plan.assets,
  ]
}

/** Prevent accidental unbounded JSON/base64 growth when callers bypass ZIP IO. */
export function resourcePackManifestByteLength(pack: ParsedResourcePack): number {
  return pack.manifests.reduce((total, manifest) => total + encoder.encode(manifest.soundsJson).byteLength, 0)
}
