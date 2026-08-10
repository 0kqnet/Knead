import type { NbsBundleInstrumentAudio } from './nbsBundle'
import {
  MAX_EMBEDDED_CUSTOM_AUDIO_ASSETS,
  MAX_EMBEDDED_CUSTOM_AUDIO_BYTES,
  MAX_EMBEDDED_CUSTOM_AUDIO_PROJECT_BYTES,
  type EmbeddedCustomAudioAsset,
} from '../types/timeline'

export interface ProjectCustomAudioVariant {
  path: string
  /** Stable content-addressed key, not a filesystem path. */
  hash: string
  pitch: number
  volume?: number
  weight?: number
  stream?: boolean
  preload?: boolean
  attenuationDistance?: number
}

export type ProjectCustomAudioManifest = Readonly<Record<string, readonly ProjectCustomAudioVariant[]>>

export interface ProjectCustomAudioSnapshot {
  generation: number
  manifest: ProjectCustomAudioManifest
}

export interface ProjectCustomAudioInstallResult {
  installedSounds: number
  installedAssets: number
  warnings: string[]
}

export interface PreparedProjectCustomAudio {
  assets: EmbeddedCustomAudioAsset[]
  warnings: string[]
}

/** Fully verified registry state that can be committed synchronously. */
export interface PreparedProjectCustomAudioRegistry {
  manifest: ProjectCustomAudioManifest
  installedSounds: number
  installedAssets: number
  warnings: readonly string[]
}

/** Generic input shared by NBS bundles and resource-pack importers. */
export interface ProjectCustomAudioInput {
  soundId: string
  fileName: string
  mimeType: EmbeddedCustomAudioAsset['mimeType']
  data: Uint8Array
  pitch: number
  volume?: number
  weight?: number
  stream?: boolean
  preload?: boolean
  attenuationDistance?: number
}

const CUSTOM_KEY_PREFIX = 'knead-custom-sha256:'

interface PreparedProjectCustomAudioRegistryInternal {
  bytes: Map<string, Uint8Array>
}

const listeners = new Set<() => void>()
const preparedRegistryInternals = new WeakMap<PreparedProjectCustomAudioRegistry, PreparedProjectCustomAudioRegistryInternal>()
let assetBytes = new Map<string, Uint8Array>()
let snapshot: ProjectCustomAudioSnapshot = Object.freeze({
  generation: 0,
  manifest: Object.freeze({}),
})

function notify(): void {
  for (const listener of listeners) listener()
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

async function fingerprint(data: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('Web Crypto is required for custom audio assets')
  const copy = data.slice()
  const digest = await globalThis.crypto.subtle.digest('SHA-256', copy.buffer)
  return hex(new Uint8Array(digest))
}

function contentKey(value: string): string {
  return `${CUSTOM_KEY_PREFIX}${value}`
}

function base64(data: Uint8Array): string {
  const chunkSize = 0x8000
  let binary = ''
  for (let offset = 0; offset < data.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...data.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

function decodeBase64(value: string): Uint8Array {
  let binary: string
  try {
    binary = atob(value)
  }
  catch {
    throw new Error('Invalid embedded custom audio base64')
  }
  const data = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) data[index] = binary.charCodeAt(index)
  return data
}

function validateAssetBudgets(assets: readonly Pick<EmbeddedCustomAudioAsset, 'byteLength' | 'fileName'>[]): void {
  if (assets.length > MAX_EMBEDDED_CUSTOM_AUDIO_ASSETS) throw new Error('Too many embedded custom audio assets')
  let totalBytes = 0
  for (const asset of assets) {
    if (!asset.byteLength || asset.byteLength > MAX_EMBEDDED_CUSTOM_AUDIO_BYTES) {
      throw new Error(`Invalid custom audio size: ${asset.fileName}`)
    }
    totalBytes += asset.byteLength
    if (totalBytes > MAX_EMBEDDED_CUSTOM_AUDIO_PROJECT_BYTES) {
      throw new Error('Custom audio exceeds the project memory budget')
    }
  }
}

function validateOptionalMetadata(input: Pick<
  ProjectCustomAudioInput,
  'fileName' | 'pitch' | 'volume' | 'weight' | 'stream' | 'preload' | 'attenuationDistance'
>): void {
  if (!Number.isFinite(input.pitch) || input.pitch < 0.01 || input.pitch > 100) {
    throw new Error(`Invalid custom audio pitch: ${input.fileName}`)
  }
  if (input.volume !== undefined
    && (!Number.isFinite(input.volume) || input.volume < 0 || input.volume > 1)) {
    throw new Error(`Invalid custom audio volume: ${input.fileName}`)
  }
  if (input.weight !== undefined
    && (!Number.isInteger(input.weight) || input.weight < 1 || input.weight > 2_147_483_647)) {
    throw new Error(`Invalid custom audio weight: ${input.fileName}`)
  }
  for (const field of ['stream', 'preload'] as const) {
    if (input[field] !== undefined && typeof input[field] !== 'boolean') {
      throw new Error(`Invalid custom audio ${field}: ${input.fileName}`)
    }
  }
  if (input.attenuationDistance !== undefined && (
    !Number.isFinite(input.attenuationDistance)
    || input.attenuationDistance < 0
    || input.attenuationDistance > 1_000_000
  )) {
    throw new Error(`Invalid custom audio attenuation distance: ${input.fileName}`)
  }
}

function validateEmbeddedAssetShape(asset: EmbeddedCustomAudioAsset): void {
  if (typeof asset.soundId !== 'string' || !asset.soundId || asset.soundId.length > 1024) {
    throw new Error('Invalid custom audio soundId')
  }
  if (typeof asset.fileName !== 'string' || !asset.fileName || asset.fileName.length > 1024) {
    throw new Error('Invalid custom audio fileName')
  }
  if (!['audio/wav', 'audio/ogg', 'audio/mpeg', 'application/octet-stream'].includes(asset.mimeType)) {
    throw new Error(`Invalid custom audio media type: ${asset.fileName}`)
  }
  if (!Number.isInteger(asset.byteLength)
    || asset.byteLength < 1
    || asset.byteLength > MAX_EMBEDDED_CUSTOM_AUDIO_BYTES) {
    throw new Error(`Invalid custom audio size: ${asset.fileName}`)
  }
  if (typeof asset.fingerprint !== 'string' || !/^[0-9a-f]{64}$/u.test(asset.fingerprint)) {
    throw new Error(`Invalid custom audio fingerprint: ${asset.fileName}`)
  }
  if (typeof asset.dataBase64 !== 'string') throw new Error(`Invalid custom audio base64: ${asset.fileName}`)
  validateOptionalMetadata(asset)
}

function optionalMetadata(input: ProjectCustomAudioInput): Pick<
  EmbeddedCustomAudioAsset,
  'volume' | 'weight' | 'stream' | 'preload' | 'attenuationDistance'
> {
  return {
    ...(input.volume === undefined ? {} : { volume: input.volume }),
    ...(input.weight === undefined ? {} : { weight: input.weight }),
    ...(input.stream === undefined ? {} : { stream: input.stream }),
    ...(input.preload === undefined ? {} : { preload: input.preload }),
    ...(input.attenuationDistance === undefined ? {} : { attenuationDistance: input.attenuationDistance }),
  }
}

export function subscribeProjectCustomAudio(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getProjectCustomAudioSnapshot(): ProjectCustomAudioSnapshot {
  return snapshot
}

export function isProjectCustomAudioKey(key: string): boolean {
  return key.startsWith(CUSTOM_KEY_PREFIX)
}

/** Returns a defensive copy suitable for decodeAudioData. */
export function getProjectCustomAudioData(key: string): ArrayBuffer | undefined {
  const data = assetBytes.get(key)
  return data?.slice().buffer
}

/**
 * Build portable, content-addressed assets from any trusted importer.
 *
 * A repeated soundId + fingerprint pair is represented once. Different
 * fingerprints for the same soundId remain separate variants in input order.
 */
export async function prepareProjectCustomAudioAssets(
  inputs: readonly ProjectCustomAudioInput[],
): Promise<EmbeddedCustomAudioAsset[]> {
  if (inputs.length > MAX_EMBEDDED_CUSTOM_AUDIO_ASSETS) {
    throw new Error('Too many embedded custom audio assets')
  }
  const assets: EmbeddedCustomAudioAsset[] = []
  const pairs = new Set<string>()
  for (const input of inputs) {
    if (typeof input.soundId !== 'string' || !input.soundId || input.soundId.length > 1024) {
      throw new Error('Invalid custom audio soundId')
    }
    if (typeof input.fileName !== 'string' || !input.fileName || input.fileName.length > 1024) {
      throw new Error('Invalid custom audio fileName')
    }
    if (!['audio/wav', 'audio/ogg', 'audio/mpeg', 'application/octet-stream'].includes(input.mimeType)) {
      throw new Error(`Invalid custom audio media type: ${input.fileName}`)
    }
    if (!(input.data instanceof Uint8Array)
      || !input.data.byteLength
      || input.data.byteLength > MAX_EMBEDDED_CUSTOM_AUDIO_BYTES) {
      throw new Error(`Invalid custom audio size: ${input.fileName}`)
    }
    validateOptionalMetadata(input)
    const digest = await fingerprint(input.data)
    const pair = `${input.soundId}\0${digest}`
    if (pairs.has(pair)) continue
    pairs.add(pair)
    assets.push({
      soundId: input.soundId,
      fileName: input.fileName,
      mimeType: input.mimeType,
      byteLength: input.data.byteLength,
      fingerprint: digest,
      dataBase64: base64(input.data),
      pitch: input.pitch,
      ...optionalMetadata(input),
    })
  }
  validateAssetBudgets(assets)
  return assets
}

/** Build the portable v5 project payload without mutating the active registry. */
export async function prepareProjectCustomAudio(
  audio: readonly NbsBundleInstrumentAudio[],
): Promise<PreparedProjectCustomAudio> {
  const prepared = await prepareProjectCustomAudioAssets(audio.map(item => ({
    soundId: item.soundId,
    fileName: item.instrument.file,
    mimeType: item.mediaType,
    data: item.data,
    pitch: 1,
  })))
  const assets: EmbeddedCustomAudioAsset[] = []
  const bySoundId = new Map<string, string>()
  const warnings: string[] = []
  for (const asset of prepared) {
    const previous = bySoundId.get(asset.soundId)
    if (previous) {
      if (previous !== asset.fingerprint) {
        warnings.push(`Custom soundId collision; the first bundled sound was kept: ${asset.soundId}.`)
      }
      continue
    }
    bySoundId.set(asset.soundId, asset.fingerprint)
    assets.push(asset)
  }
  return { assets, warnings }
}

/**
 * Verify a portable registry without touching the currently active project.
 * The returned object owns defensive byte copies and cannot be forged into an
 * activation because its mutable internals remain in a private WeakMap.
 */
export async function prepareProjectCustomAudioRegistry(
  assets: readonly EmbeddedCustomAudioAsset[],
): Promise<PreparedProjectCustomAudioRegistry> {
  const input = assets.map(asset => ({ ...asset }))
  validateAssetBudgets(input)
  const uniqueData = new Map<string, Uint8Array>()
  const mutableManifest: Record<string, ProjectCustomAudioVariant[]> = Object.create(null)
  const pairs = new Set<string>()
  for (const asset of input) {
    validateEmbeddedAssetShape(asset)
    const pair = `${asset.soundId}\0${asset.fingerprint}`
    if (pairs.has(pair)) throw new Error(`Duplicate custom audio asset: ${asset.soundId}`)
    pairs.add(pair)
    if (asset.dataBase64.length !== Math.ceil(asset.byteLength / 3) * 4) {
      throw new Error(`Custom audio base64 length mismatch: ${asset.fileName}`)
    }
    const data = decodeBase64(asset.dataBase64)
    if (data.byteLength !== asset.byteLength) throw new Error(`Custom audio length mismatch: ${asset.fileName}`)
    const digest = await fingerprint(data)
    if (digest !== asset.fingerprint.toLowerCase()) {
      throw new Error(`Custom audio fingerprint mismatch: ${asset.fileName}`)
    }
    const key = contentKey(digest)
    if (!uniqueData.has(key)) uniqueData.set(key, data)
    const variants = mutableManifest[asset.soundId] ?? []
    variants.push({
      path: asset.fileName,
      hash: key,
      pitch: asset.pitch,
      ...(asset.volume === undefined ? {} : { volume: asset.volume }),
      ...(asset.weight === undefined ? {} : { weight: asset.weight }),
      ...(asset.stream === undefined ? {} : { stream: asset.stream }),
      ...(asset.preload === undefined ? {} : { preload: asset.preload }),
      ...(asset.attenuationDistance === undefined ? {} : { attenuationDistance: asset.attenuationDistance }),
    })
    mutableManifest[asset.soundId] = variants
  }
  const manifest = Object.freeze(Object.fromEntries(
    Object.entries(mutableManifest)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([soundId, variants]) => [soundId, Object.freeze(variants.map(variant => Object.freeze(variant)))]),
  ))
  const prepared: PreparedProjectCustomAudioRegistry = Object.freeze({
    manifest,
    installedSounds: Object.keys(manifest).length,
    installedAssets: uniqueData.size,
    warnings: Object.freeze([]),
  })
  preparedRegistryInternals.set(prepared, { bytes: uniqueData })
  return prepared
}

/** Commit an already verified registry in one synchronous notification. */
export function activatePreparedProjectCustomAudioRegistry(
  prepared: PreparedProjectCustomAudioRegistry,
): ProjectCustomAudioInstallResult {
  const internal = preparedRegistryInternals.get(prepared)
  if (!internal) throw new Error('Invalid prepared custom audio registry')
  assetBytes = new Map(internal.bytes)
  snapshot = Object.freeze({ generation: snapshot.generation + 1, manifest: prepared.manifest })
  notify()
  return {
    installedSounds: prepared.installedSounds,
    installedAssets: prepared.installedAssets,
    warnings: [...prepared.warnings],
  }
}

/** Atomically restore and cryptographically verify a portable v5 project payload. */
export async function restoreProjectCustomAudio(
  assets: readonly EmbeddedCustomAudioAsset[],
): Promise<ProjectCustomAudioInstallResult> {
  const prepared = await prepareProjectCustomAudioRegistry(assets)
  return activatePreparedProjectCustomAudioRegistry(prepared)
}

/** Prepare and install the custom sounds from a validated NBS bundle. */
export async function replaceProjectCustomAudio(
  audio: readonly NbsBundleInstrumentAudio[],
): Promise<ProjectCustomAudioInstallResult & { assets: EmbeddedCustomAudioAsset[] }> {
  const prepared = await prepareProjectCustomAudio(audio)
  const installed = await restoreProjectCustomAudio(prepared.assets)
  return { ...installed, assets: prepared.assets, warnings: prepared.warnings }
}

export function clearProjectCustomAudio(): void {
  if (!assetBytes.size && !Object.keys(snapshot.manifest).length) return
  assetBytes = new Map()
  snapshot = Object.freeze({ generation: snapshot.generation + 1, manifest: Object.freeze({}) })
  notify()
}

/**
 * Attach base64 bytes only at the desktop export boundary. Keeping them out of
 * React/Redux state avoids a permanent ~33% base64 memory expansion.
 */
export function embedProjectCustomAudio<Variant extends { hash: string }>(
  manifest: Readonly<Record<string, readonly Variant[]>>,
): Record<string, (Variant & { dataBase64?: string })[]> {
  return Object.fromEntries(Object.entries(manifest).map(([soundId, variants]) => [
    soundId,
    variants.map((variant) => {
      const data = assetBytes.get(variant.hash)
      return data ? { ...variant, dataBase64: base64(data) } : { ...variant }
    }),
  ]))
}
