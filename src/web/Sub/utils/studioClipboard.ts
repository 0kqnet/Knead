import {
  isSoundStopMarker,
  MAX_EMBEDDED_CUSTOM_AUDIO_ASSETS,
  MAX_EMBEDDED_CUSTOM_AUDIO_BYTES,
  MAX_EMBEDDED_CUSTOM_AUDIO_PROJECT_BYTES,
  MAX_PROJECT_CUSTOM_INSTRUMENTS,
  MAX_TIMELINE_MARKERS,
  type EmbeddedCustomAudioAsset,
  type Marker,
  type ProjectCustomInstrument,
  type SoundStopAction,
  type TimelineState,
} from '../types/timeline'
import {
  deriveProjectCustomInstruments,
  validateProjectCustomInstruments,
} from './customInstruments'

export const STUDIO_CLIPBOARD_FORMAT = 'knead-studio-clipboard'
export const STUDIO_CLIPBOARD_VERSION = 1
export const STUDIO_CLIPBOARD_LIMITS = Object.freeze({
  maxMarkers: 100_000,
  maxAssets: MAX_EMBEDDED_CUSTOM_AUDIO_ASSETS,
  maxAssetBytes: MAX_EMBEDDED_CUSTOM_AUDIO_BYTES,
  maxAssetProjectBytes: MAX_EMBEDDED_CUSTOM_AUDIO_PROJECT_BYTES,
  maxInstruments: MAX_PROJECT_CUSTOM_INSTRUMENTS,
})

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T

export type StudioClipboardMarker = DeepReadonly<Omit<Marker, 'source'>>
export type StudioClipboardInstrument = DeepReadonly<Omit<ProjectCustomInstrument, 'sourceIndex'>>

export interface StudioClipboardMarkerEntry {
  readonly sourceTrackIndex: number
  readonly marker: StudioClipboardMarker
}

export interface StudioClipboardV1 {
  readonly format: typeof STUDIO_CLIPBOARD_FORMAT
  readonly version: typeof STUDIO_CLIPBOARD_VERSION
  readonly originTick: number
  readonly originTrackIndex: number
  readonly sourceTrackCount: number
  readonly markers: readonly StudioClipboardMarkerEntry[]
  readonly assets: readonly DeepReadonly<EmbeddedCustomAudioAsset>[]
  /** Optional extension: clipboard snapshots created before authored instruments remain valid. */
  readonly instruments?: readonly StudioClipboardInstrument[]
}

export type StudioClipboardPasteMarker = Omit<Marker, 'id' | 'source'>

export interface StudioClipboardPasteOptions {
  atTick: number
  /** Zero-based destination index corresponding to the copied origin track. */
  destinationTrackIndex?: number
  /** Explicit zero-based source → destination overrides. */
  trackIndexMap?: Readonly<Record<number, number>>
}

export interface PreparedStudioClipboardPaste {
  /** Runtime-deep-frozen; typed for direct TimelinePasteInput compatibility. */
  readonly markers: readonly StudioClipboardPasteMarker[]
  readonly assets: readonly EmbeddedCustomAudioAsset[]
  readonly instruments: readonly ProjectCustomInstrument[]
  readonly warnings: readonly string[]
  readonly soundIdRemap: Readonly<Record<string, string>>
}

const ASSET_FIELDS = [
  'soundId',
  'fileName',
  'mimeType',
  'byteLength',
  'fingerprint',
  'dataBase64',
  'pitch',
  'volume',
  'weight',
  'stream',
  'preload',
  'attenuationDistance',
] as const satisfies readonly (keyof EmbeddedCustomAudioAsset)[]

const INSTRUMENT_FIELDS = [
  'kind',
  'soundId',
  'name',
  'file',
  'key',
  'pressKey',
  'defaultPitch',
] as const satisfies readonly (keyof ProjectCustomInstrument)[]

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): DeepReadonly<T> {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value as DeepReadonly<T>
  seen.add(value)
  for (const child of Object.values(value)) deepFreeze(child, seen)
  return Object.freeze(value) as DeepReadonly<T>
}

function cloneMarkerWithoutSource(marker: Marker): Omit<Marker, 'source'> {
  const clone = structuredClone(marker)
  delete clone.source
  return clone
}

function cloneAsset(asset: DeepReadonly<EmbeddedCustomAudioAsset>): EmbeddedCustomAudioAsset {
  return {
    soundId: asset.soundId,
    fileName: asset.fileName,
    mimeType: asset.mimeType,
    byteLength: asset.byteLength,
    fingerprint: asset.fingerprint,
    dataBase64: asset.dataBase64,
    pitch: asset.pitch,
    ...(asset.volume === undefined ? {} : { volume: asset.volume }),
    ...(asset.weight === undefined ? {} : { weight: asset.weight }),
    ...(asset.stream === undefined ? {} : { stream: asset.stream }),
    ...(asset.preload === undefined ? {} : { preload: asset.preload }),
    ...(asset.attenuationDistance === undefined
      ? {}
      : { attenuationDistance: asset.attenuationDistance }),
  }
}

function cloneInstrumentWithoutSourceIndex(
  instrument: DeepReadonly<ProjectCustomInstrument>,
  patch: Partial<Pick<ProjectCustomInstrument, 'id' | 'soundId' | 'file'>> = {},
): ProjectCustomInstrument {
  return {
    id: patch.id ?? instrument.id,
    kind: instrument.kind,
    soundId: patch.soundId ?? instrument.soundId,
    name: instrument.name,
    file: patch.file ?? instrument.file,
    key: instrument.key,
    pressKey: instrument.pressKey,
    defaultPitch: instrument.defaultPitch,
  }
}

function validBase64Shape(value: string, byteLength: number): boolean {
  if (value.length !== Math.ceil(byteLength / 3) * 4) return false
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) return false
  const expectedPadding = (3 - (byteLength % 3)) % 3
  return expectedPadding === 0 ? !value.endsWith('=') : value.endsWith('='.repeat(expectedPadding))
}

function validateAsset(asset: DeepReadonly<EmbeddedCustomAudioAsset>): void {
  if (typeof asset.soundId !== 'string' || !asset.soundId || asset.soundId.length > 1024) {
    throw new Error('Invalid clipboard custom audio soundId')
  }
  if (typeof asset.fileName !== 'string' || !asset.fileName || asset.fileName.length > 1024) {
    throw new Error(`Invalid clipboard custom audio file name: ${asset.soundId}`)
  }
  if (!['audio/wav', 'audio/ogg', 'audio/mpeg', 'application/octet-stream'].includes(asset.mimeType)) {
    throw new Error(`Invalid clipboard custom audio media type: ${asset.fileName}`)
  }
  if (!Number.isInteger(asset.byteLength)
    || asset.byteLength < 1
    || asset.byteLength > STUDIO_CLIPBOARD_LIMITS.maxAssetBytes) {
    throw new Error(`Invalid clipboard custom audio size: ${asset.fileName}`)
  }
  if (!/^[0-9a-f]{64}$/u.test(asset.fingerprint)) {
    throw new Error(`Invalid clipboard custom audio fingerprint: ${asset.fileName}`)
  }
  if (typeof asset.dataBase64 !== 'string' || !validBase64Shape(asset.dataBase64, asset.byteLength)) {
    throw new Error(`Invalid clipboard custom audio Base64: ${asset.fileName}`)
  }
  if (!Number.isFinite(asset.pitch) || asset.pitch < 0.01 || asset.pitch > 100) {
    throw new Error(`Invalid clipboard custom audio pitch: ${asset.fileName}`)
  }
  if (asset.volume !== undefined
    && (!Number.isFinite(asset.volume) || asset.volume < 0 || asset.volume > 1)) {
    throw new Error(`Invalid clipboard custom audio volume: ${asset.fileName}`)
  }
  if (asset.weight !== undefined
    && (!Number.isInteger(asset.weight) || asset.weight < 1 || asset.weight > 0x7fff_ffff)) {
    throw new Error(`Invalid clipboard custom audio weight: ${asset.fileName}`)
  }
  if (asset.stream !== undefined && typeof asset.stream !== 'boolean') {
    throw new Error(`Invalid clipboard custom audio stream flag: ${asset.fileName}`)
  }
  if (asset.preload !== undefined && typeof asset.preload !== 'boolean') {
    throw new Error(`Invalid clipboard custom audio preload flag: ${asset.fileName}`)
  }
  if (asset.attenuationDistance !== undefined && (
    !Number.isFinite(asset.attenuationDistance)
    || asset.attenuationDistance < 0
    || asset.attenuationDistance > 1_000_000
  )) throw new Error(`Invalid clipboard custom audio attenuation: ${asset.fileName}`)
}

function validateAssetCollection(
  assets: readonly DeepReadonly<EmbeddedCustomAudioAsset>[],
): void {
  if (assets.length > STUDIO_CLIPBOARD_LIMITS.maxAssets) {
    throw new Error('Clipboard has too many custom audio assets')
  }
  let total = 0
  for (const asset of assets) {
    if (typeof asset !== 'object' || asset === null) throw new Error('Invalid clipboard custom audio asset')
    if (Number.isInteger(asset.byteLength) && asset.byteLength > 0) {
      total += asset.byteLength
      if (total > STUDIO_CLIPBOARD_LIMITS.maxAssetProjectBytes) {
        throw new Error('Clipboard custom audio exceeds the 96 MiB project budget')
      }
    }
  }
  const pairs = new Set<string>()
  for (const asset of assets) {
    validateAsset(asset)
    const pair = `${asset.soundId}\0${asset.fingerprint}`
    if (pairs.has(pair)) throw new Error(`Duplicate clipboard custom audio variant: ${asset.soundId}`)
    pairs.add(pair)
  }
}

function validateInstrumentCollection(
  instruments: readonly DeepReadonly<ProjectCustomInstrument>[],
  label = 'Clipboard',
): void {
  if (instruments.length > STUDIO_CLIPBOARD_LIMITS.maxInstruments) {
    throw new Error(`${label} has too many custom instrument definitions`)
  }
  for (const instrument of instruments) {
    if (typeof instrument !== 'object' || instrument === null) {
      throw new Error(`Invalid ${label.toLowerCase()} custom instrument definition`)
    }
    if (instrument.kind !== 'audio') {
      throw new Error(`${label} cannot transfer protected functional instruments`)
    }
    if (Object.prototype.hasOwnProperty.call(instrument, 'sourceIndex')) {
      throw new Error(`${label} custom instrument definitions must not contain source provenance`)
    }
  }
  const error = validateProjectCustomInstruments(instruments as readonly ProjectCustomInstrument[])
  if (error) throw new Error(`${label} custom instrument definitions are invalid: ${error}`)
}

function selectedIdSet(ids: ReadonlySet<string> | readonly string[]): ReadonlySet<string> {
  return 'has' in ids ? ids : new Set(ids)
}

/** Creates an immutable, provenance-free v1 copy snapshot. */
export function createStudioClipboardV1(
  source: TimelineState,
  selectedIds: ReadonlySet<string> | readonly string[],
): StudioClipboardV1 {
  const selected = selectedIdSet(selectedIds)
  const markerRows = source.markers.flatMap((marker) => {
    if (!selected.has(marker.id)) return []
    const sourceTrackIndex = source.tracks.findIndex(track => track.id === marker.trackId)
    if (sourceTrackIndex < 0) throw new Error(`Clipboard marker references a missing track: ${marker.id}`)
    return [{ sourceTrackIndex, marker }]
  })
  if (markerRows.length === 0) throw new Error('No timeline markers were selected')
  if (markerRows.length > STUDIO_CLIPBOARD_LIMITS.maxMarkers) {
    throw new Error('Clipboard has too many timeline markers')
  }
  const originTick = Math.min(...markerRows.map(row => row.marker.tick))
  const originTrackIndex = Math.min(...markerRows.map(row => row.sourceTrackIndex))
  const dependencyIds = new Set(markerRows.flatMap(row => (
    isSoundStopMarker(row.marker) ? [] : [row.marker.soundId]
  )))
  const assets = (source.customAudio ?? [])
    .filter(asset => dependencyIds.has(asset.soundId))
    .map(cloneAsset)
  const instruments = deriveProjectCustomInstruments(source)
    .filter(instrument => instrument.kind === 'audio' && dependencyIds.has(instrument.soundId))
    .map(instrument => cloneInstrumentWithoutSourceIndex(instrument))
  validateAssetCollection(assets)
  validateInstrumentCollection(instruments)
  const clipboard: StudioClipboardV1 = {
    format: STUDIO_CLIPBOARD_FORMAT,
    version: STUDIO_CLIPBOARD_VERSION,
    originTick,
    originTrackIndex,
    sourceTrackCount: source.tracks.length,
    markers: markerRows.map(row => ({
      sourceTrackIndex: row.sourceTrackIndex,
      marker: cloneMarkerWithoutSource(row.marker),
    })),
    assets,
    instruments,
  }
  return deepFreeze(clipboard)
}

function validateClipboard(clipboard: StudioClipboardV1): void {
  if (typeof clipboard !== 'object' || clipboard === null
    || clipboard.format !== STUDIO_CLIPBOARD_FORMAT
    || clipboard.version !== STUDIO_CLIPBOARD_VERSION) {
    throw new Error('Unsupported Knead studio clipboard format')
  }
  if (!Number.isInteger(clipboard.sourceTrackCount) || clipboard.sourceTrackCount < 1) {
    throw new Error('Invalid clipboard source track count')
  }
  if (!Number.isInteger(clipboard.originTrackIndex)
    || clipboard.originTrackIndex < 0
    || clipboard.originTrackIndex >= clipboard.sourceTrackCount) {
    throw new Error('Invalid clipboard origin track')
  }
  if (!Number.isSafeInteger(clipboard.originTick) || clipboard.originTick < 0) {
    throw new Error('Invalid clipboard origin tick')
  }
  if (!Array.isArray(clipboard.markers)
    || clipboard.markers.length < 1
    || clipboard.markers.length > STUDIO_CLIPBOARD_LIMITS.maxMarkers) {
    throw new Error('Invalid clipboard marker count')
  }
  for (const entry of clipboard.markers) {
    if (!Number.isInteger(entry.sourceTrackIndex)
      || entry.sourceTrackIndex < 0
      || entry.sourceTrackIndex >= clipboard.sourceTrackCount) {
      throw new Error('Invalid clipboard marker track')
    }
    const marker = entry.marker
    if (typeof marker !== 'object' || marker === null
      || !Number.isSafeInteger(marker.tick) || marker.tick < 0
      || typeof marker.soundId !== 'string') {
      throw new Error('Invalid clipboard marker')
    }
  }
  if (!Array.isArray(clipboard.assets)) throw new Error('Invalid clipboard custom audio list')
  validateAssetCollection(clipboard.assets)
  const instruments = clipboard.instruments ?? []
  if (!Array.isArray(instruments)) throw new Error('Invalid clipboard custom instrument list')
  validateInstrumentCollection(instruments as readonly DeepReadonly<ProjectCustomInstrument>[])
  const dependencies = new Set(clipboard.markers.flatMap(entry => (
    isSoundStopMarker(entry.marker as Marker) ? [] : [entry.marker.soundId]
  )))
  if (clipboard.assets.some(asset => !dependencies.has(asset.soundId))
    || instruments.some(instrument => !dependencies.has(instrument.soundId))) {
    throw new Error('Clipboard contains an unreferenced custom sound dependency')
  }
}

function assetEqual(
  left: DeepReadonly<EmbeddedCustomAudioAsset>,
  right: DeepReadonly<EmbeddedCustomAudioAsset>,
  ignoreSoundId = false,
): boolean {
  return ASSET_FIELDS.every(field => (
    (ignoreSoundId && field === 'soundId') || Object.is(left[field], right[field])
  ))
}

function groupEqual(
  left: readonly DeepReadonly<EmbeddedCustomAudioAsset>[],
  right: readonly DeepReadonly<EmbeddedCustomAudioAsset>[],
  ignoreSoundId = false,
): boolean {
  return left.length === right.length
    && left.every((asset, index) => assetEqual(asset, right[index], ignoreSoundId))
}

function groupedAssets(
  assets: readonly DeepReadonly<EmbeddedCustomAudioAsset>[],
): Map<string, DeepReadonly<EmbeddedCustomAudioAsset>[]> {
  const groups = new Map<string, DeepReadonly<EmbeddedCustomAudioAsset>[]>()
  for (const asset of assets) {
    const group = groups.get(asset.soundId) ?? []
    group.push(asset)
    groups.set(asset.soundId, group)
  }
  return groups
}

function instrumentEqual(
  left: DeepReadonly<ProjectCustomInstrument>,
  right: DeepReadonly<ProjectCustomInstrument>,
  ignoreSoundId = false,
): boolean {
  return INSTRUMENT_FIELDS.every(field => (
    (ignoreSoundId && field === 'soundId') || Object.is(left[field], right[field])
  ))
}

function instrumentGroupEqual(
  left: readonly DeepReadonly<ProjectCustomInstrument>[],
  right: readonly DeepReadonly<ProjectCustomInstrument>[],
  ignoreSoundId = false,
): boolean {
  return left.length === right.length
    && left.every((instrument, index) => instrumentEqual(
      instrument,
      right[index],
      ignoreSoundId,
    ))
}

function groupedInstruments(
  instruments: readonly DeepReadonly<ProjectCustomInstrument>[],
): Map<string, DeepReadonly<ProjectCustomInstrument>[]> {
  const groups = new Map<string, DeepReadonly<ProjectCustomInstrument>[]>()
  for (const instrument of instruments) {
    if (instrument.kind !== 'audio') continue
    const group = groups.get(instrument.soundId) ?? []
    group.push(instrument)
    groups.set(instrument.soundId, group)
  }
  return groups
}

function hashPiece(hash: number, value: unknown): number {
  const text = value === undefined ? 'undefined' : String(value)
  const framed = `${text.length}:${text};`
  let next = hash
  for (let index = 0; index < framed.length; index++) {
    next ^= framed.charCodeAt(index)
    next = Math.imul(next, 0x0100_0193)
  }
  return next >>> 0
}

function stableBundleHash(
  soundId: string,
  assets: readonly DeepReadonly<EmbeddedCustomAudioAsset>[],
  instruments: readonly DeepReadonly<ProjectCustomInstrument>[],
): string {
  let hash = hashPiece(0x811c_9dc5, soundId)
  hash = hashPiece(hash, assets.length)
  for (const asset of assets) {
    for (const field of ASSET_FIELDS) hash = hashPiece(hashPiece(hash, field), asset[field])
  }
  hash = hashPiece(hash, instruments.length)
  for (const instrument of instruments) {
    for (const field of INSTRUMENT_FIELDS) {
      hash = hashPiece(hashPiece(hash, field), instrument[field])
    }
  }
  return hash.toString(16).padStart(8, '0')
}

function soundSlug(soundId: string): string {
  const slug = soundId.toLowerCase()
    .replace(/:/gu, '/')
    .replace(/[^a-z0-9._/-]+/gu, '_')
    .replace(/^[/._-]+|[/._-]+$/gu, '')
  return (slug || 'sound').slice(0, 96)
}

interface ClipboardSoundBundle {
  soundId: string
  assets: readonly DeepReadonly<EmbeddedCustomAudioAsset>[]
  instruments: readonly DeepReadonly<ProjectCustomInstrument>[]
  hash: string
}

interface MaterializedBundle {
  assets: EmbeddedCustomAudioAsset[]
  instruments: ProjectCustomInstrument[]
  fileRemaps: ReadonlyMap<string, string>
}

interface BundleCandidate {
  bundle: MaterializedBundle
  addAssets: boolean
  addInstruments: boolean
}

function normalizedFileKey(file: string): string {
  return file.replace(/\\/gu, '/').normalize('NFKC').toLocaleLowerCase('en-US')
}

function groupedFileOwners(
  instruments: readonly DeepReadonly<ProjectCustomInstrument>[],
): Map<string, Set<string>> {
  const owners = new Map<string, Set<string>>()
  for (const instrument of instruments) {
    if (instrument.kind !== 'audio') continue
    const key = normalizedFileKey(instrument.file)
    const sounds = owners.get(key) ?? new Set<string>()
    sounds.add(instrument.soundId)
    owners.set(key, sounds)
  }
  return owners
}

function fileAvailableFor(
  file: string,
  soundId: string,
  owners: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  const existing = owners.get(normalizedFileKey(file))
  return !existing || Array.from(existing).every(owner => owner === soundId)
}

function allocatePastedFile(
  sourceFile: string,
  bundle: ClipboardSoundBundle,
  soundId: string,
  owners: ReadonlyMap<string, ReadonlySet<string>>,
): string {
  const leaf = sourceFile.replace(/\\/gu, '/').split('/').at(-1) ?? 'instrument.ogg'
  const extension = /\.[^.]+$/u.exec(leaf)?.[0].toLocaleLowerCase('en-US') ?? '.ogg'
  const stem = leaf.slice(0, Math.max(0, leaf.length - extension.length))
    .normalize('NFKD')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9_.-]+/gu, '_')
    .replace(/^[_ .-]+|[_ .-]+$/gu, '')
    .slice(0, 72) || 'instrument'
  const fileHash = hashPiece(Number.parseInt(bundle.hash, 16), sourceFile)
    .toString(16)
    .padStart(8, '0')
  const base = `knead-paste/${stem}-${fileHash}`
  const limit = STUDIO_CLIPBOARD_LIMITS.maxAssets + STUDIO_CLIPBOARD_LIMITS.maxInstruments + 1
  for (let suffix = 1; suffix <= limit; suffix++) {
    const candidate = `${base}${suffix === 1 ? '' : `-${suffix}`}${extension}`
    if (fileAvailableFor(candidate, soundId, owners)) return candidate
  }
  throw new Error(`Unable to allocate a stable pasted instrument file: ${sourceFile}`)
}

function materializeBundle(
  source: ClipboardSoundBundle,
  soundId: string,
  fileOwners: ReadonlyMap<string, ReadonlySet<string>>,
  preserveFiles: ReadonlySet<string> = new Set(),
): MaterializedBundle {
  const fileRemaps = new Map<string, string>()
  for (const instrument of source.instruments) {
    const key = normalizedFileKey(instrument.file)
    if (fileRemaps.has(key)) continue
    const file = preserveFiles.has(key) || fileAvailableFor(instrument.file, soundId, fileOwners)
      ? instrument.file
      : allocatePastedFile(instrument.file, source, soundId, fileOwners)
    fileRemaps.set(key, file)
  }
  return {
    assets: source.assets.map(asset => ({
      ...cloneAsset(asset),
      soundId,
      fileName: fileRemaps.get(normalizedFileKey(asset.fileName)) ?? asset.fileName,
    })),
    instruments: source.instruments.map(instrument => cloneInstrumentWithoutSourceIndex(
      instrument,
      {
        soundId,
        file: fileRemaps.get(normalizedFileKey(instrument.file)) ?? instrument.file,
      },
    )),
    fileRemaps,
  }
}

function evaluateBundleCandidate(
  source: ClipboardSoundBundle,
  soundId: string,
  occupiedAssets: ReadonlyMap<string, readonly DeepReadonly<EmbeddedCustomAudioAsset>[]>,
  occupiedInstruments: ReadonlyMap<string, readonly DeepReadonly<ProjectCustomInstrument>[]>,
  fileOwners: ReadonlyMap<string, ReadonlySet<string>>,
): BundleCandidate | null {
  const existingAssets = occupiedAssets.get(soundId) ?? []
  const existingInstruments = occupiedInstruments.get(soundId) ?? []
  const rawAssets = source.assets.map(asset => ({ ...cloneAsset(asset), soundId }))
  const rawInstruments = source.instruments.map(instrument => (
    cloneInstrumentWithoutSourceIndex(instrument, { soundId })
  ))
  const rawInstrumentMatch = source.instruments.length > 0
    && existingInstruments.length > 0
    && instrumentGroupEqual(rawInstruments, existingInstruments)
  const preserveFiles = rawInstrumentMatch
    ? new Set(source.instruments.map(instrument => normalizedFileKey(instrument.file)))
    : new Set<string>()
  const materialized = materializeBundle(source, soundId, fileOwners, preserveFiles)
  const assetsMatch = source.assets.length === 0
    || existingAssets.length === 0
    || groupEqual(rawAssets, existingAssets)
    || groupEqual(materialized.assets, existingAssets)
  const instrumentsMatch = source.instruments.length === 0
    || existingInstruments.length === 0
    || rawInstrumentMatch
    || instrumentGroupEqual(materialized.instruments, existingInstruments)
  if (!assetsMatch || !instrumentsMatch) return null
  return {
    bundle: materialized,
    addAssets: source.assets.length > 0 && existingAssets.length === 0,
    addInstruments: source.instruments.length > 0 && existingInstruments.length === 0,
  }
}

function allocateInstrumentId(
  instrument: ProjectCustomInstrument,
  occupiedIds: Set<string>,
): string {
  if (!occupiedIds.has(instrument.id)) {
    occupiedIds.add(instrument.id)
    return instrument.id
  }
  let hash = hashPiece(0x811c_9dc5, instrument.id)
  for (const field of INSTRUMENT_FIELDS) hash = hashPiece(hashPiece(hash, field), instrument[field])
  const slug = instrument.id.toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9_.-]+/gu, '_')
    .replace(/^[_ .-]+|[_ .-]+$/gu, '')
    .slice(0, 72) || 'instrument'
  const base = `paste-${slug}-${hash.toString(16).padStart(8, '0')}`
  for (let suffix = 1; suffix <= STUDIO_CLIPBOARD_LIMITS.maxInstruments + 1; suffix++) {
    const candidate = suffix === 1 ? base : `${base}-${suffix}`
    if (occupiedIds.has(candidate)) continue
    occupiedIds.add(candidate)
    return candidate
  }
  throw new Error(`Unable to allocate a stable pasted instrument ID: ${instrument.id}`)
}

function clampTrackIndex(value: number, trackCount: number): number {
  return Math.max(0, Math.min(trackCount - 1, Math.trunc(value)))
}

function destinationTrackFor(
  sourceTrackIndex: number,
  clipboard: StudioClipboardV1,
  options: StudioClipboardPasteOptions,
  destinationTrackCount: number,
): number {
  const explicit = options.trackIndexMap?.[sourceTrackIndex]
  if (explicit !== undefined) {
    if (!Number.isFinite(explicit)) throw new Error(`Invalid destination track mapping: ${sourceTrackIndex}`)
    return clampTrackIndex(explicit, destinationTrackCount)
  }
  const origin = options.destinationTrackIndex ?? 0
  if (!Number.isFinite(origin)) throw new Error('Invalid destination origin track')
  return clampTrackIndex(origin + sourceTrackIndex - clipboard.originTrackIndex, destinationTrackCount)
}

function remapStopAction(
  action: DeepReadonly<SoundStopAction>,
  clipboard: StudioClipboardV1,
  options: StudioClipboardPasteOptions,
  destinationTrackCount: number,
): SoundStopAction {
  if (action.scope === 'all') return { type: 'sound-stop', scope: 'all' }
  if (!Number.isInteger(action.startTrack)
    || !Number.isInteger(action.endTrack)
    || (action.startTrack ?? 0) < 1
    || (action.endTrack ?? 0) < (action.startTrack ?? 0)) {
    throw new Error('Invalid clipboard Sound Stopper track range')
  }
  const startTrack = action.startTrack as number
  const endTrack = action.endTrack as number
  const mapped: number[] = []
  for (let oneBased = startTrack; oneBased <= endTrack; oneBased++) {
    mapped.push(destinationTrackFor(
      oneBased - 1,
      clipboard,
      options,
      destinationTrackCount,
    ) + 1)
  }
  return {
    type: 'sound-stop',
    scope: 'track-range',
    startTrack: Math.min(...mapped),
    endTrack: Math.max(...mapped),
  }
}

/**
 * Resolves track and custom-sound collisions without mutating either song.
 * Passing the result to pasteMarkersWithAssets performs definitions, assets,
 * and markers as one history action.
 */
export function prepareStudioClipboardPaste(
  clipboard: StudioClipboardV1,
  destination: TimelineState,
  options: StudioClipboardPasteOptions,
): PreparedStudioClipboardPaste {
  validateClipboard(clipboard)
  if (!destination.tracks.length) throw new Error('The destination project has no tracks')
  if (!Number.isSafeInteger(options.atTick) || options.atTick < 0) {
    throw new Error('Invalid clipboard paste tick')
  }
  if (destination.markers.length + clipboard.markers.length > MAX_TIMELINE_MARKERS) {
    throw new Error(`Pasted markers exceed the ${MAX_TIMELINE_MARKERS}-marker project limit`)
  }
  const destinationAssets = destination.customAudio ?? []
  validateAssetCollection(destinationAssets)
  const destinationInstruments = deriveProjectCustomInstruments(destination)
  const destinationInstrumentError = validateProjectCustomInstruments(destinationInstruments)
  if (destinationInstrumentError) {
    throw new Error(`Destination custom instrument definitions are invalid: ${destinationInstrumentError}`)
  }
  const sourceAssets = groupedAssets(clipboard.assets)
  const sourceInstruments = groupedInstruments(
    (clipboard.instruments ?? []) as readonly DeepReadonly<ProjectCustomInstrument>[],
  )
  const occupiedAssets = groupedAssets(destinationAssets)
  const occupiedInstruments = groupedInstruments(destinationInstruments)
  const fileOwners = groupedFileOwners(destinationInstruments)
  const occupiedInstrumentIds = new Set(destinationInstruments.map(instrument => instrument.id))
  const assetAdditions: EmbeddedCustomAudioAsset[] = []
  const instrumentAdditions: ProjectCustomInstrument[] = []
  const soundIdRemap: Record<string, string> = Object.create(null)
  const warnings: string[] = []

  const sourceSoundIds = new Set([...sourceAssets.keys(), ...sourceInstruments.keys()])
  for (const soundId of sourceSoundIds) {
    const assets = sourceAssets.get(soundId) ?? []
    const instruments = sourceInstruments.get(soundId) ?? []
    const source: ClipboardSoundBundle = {
      soundId,
      assets,
      instruments,
      hash: stableBundleHash(soundId, assets, instruments),
    }
    let targetSoundId = soundId
    let candidate = evaluateBundleCandidate(
      source,
      targetSoundId,
      occupiedAssets,
      occupiedInstruments,
      fileOwners,
    )
    if (!candidate) {
      const base = `knead:paste/${soundSlug(soundId)}-${source.hash}`
      const limit = STUDIO_CLIPBOARD_LIMITS.maxAssets + STUDIO_CLIPBOARD_LIMITS.maxInstruments + 1
      for (let suffix = 1; suffix <= limit; suffix++) {
        targetSoundId = suffix === 1 ? base : `${base}-${suffix}`
        candidate = evaluateBundleCandidate(
          source,
          targetSoundId,
          occupiedAssets,
          occupiedInstruments,
          fileOwners,
        )
        if (candidate) break
      }
      if (!candidate) throw new Error(`Unable to allocate a stable pasted sound id: ${soundId}`)
      warnings.push(`Custom sound collision renamed ${soundId} to ${targetSoundId}.`)
    }
    soundIdRemap[soundId] = targetSoundId

    if (candidate.addAssets) {
      assetAdditions.push(...candidate.bundle.assets)
      occupiedAssets.set(targetSoundId, candidate.bundle.assets)
    }
    if (candidate.addInstruments) {
      const additions = candidate.bundle.instruments.map(instrument => ({
        ...instrument,
        id: allocateInstrumentId(instrument, occupiedInstrumentIds),
      }))
      instrumentAdditions.push(...additions)
      occupiedInstruments.set(targetSoundId, additions)
      for (const instrument of additions) {
        const key = normalizedFileKey(instrument.file)
        const owners = fileOwners.get(key) ?? new Set<string>()
        owners.add(instrument.soundId)
        fileOwners.set(key, owners)
      }
      for (let index = 0; index < instruments.length; index++) {
        const remappedFile = additions[index]?.file
        if (remappedFile && remappedFile !== instruments[index].file) {
          warnings.push(`Custom instrument file collision renamed ${instruments[index].file} to ${remappedFile}.`)
        }
      }
    }
  }

  validateAssetCollection([...destinationAssets, ...assetAdditions])
  const referenceBytes = (destination.referenceAudio ?? []).reduce((total, track) => {
    if (!Number.isSafeInteger(track.byteLength) || track.byteLength < 1) {
      throw new Error(`Destination reference audio has an invalid size: ${track.fileName}`)
    }
    return total + track.byteLength
  }, 0)
  const customBytes = [...destinationAssets, ...assetAdditions]
    .reduce((total, asset) => total + asset.byteLength, 0)
  if (referenceBytes + customBytes > STUDIO_CLIPBOARD_LIMITS.maxAssetProjectBytes) {
    throw new Error('Pasted audio exceeds the shared 96 MiB embedded-audio project budget')
  }
  const combinedInstrumentError = validateProjectCustomInstruments([
    ...destinationInstruments,
    ...instrumentAdditions,
  ])
  if (combinedInstrumentError) {
    throw new Error(`Pasted custom instrument definitions are invalid: ${combinedInstrumentError}`)
  }
  const markers = clipboard.markers.map((entry): StudioClipboardPasteMarker => {
    const clone = structuredClone(entry.marker) as Omit<Marker, 'source'>
    const destinationTrackIndex = destinationTrackFor(
      entry.sourceTrackIndex,
      clipboard,
      options,
      destination.tracks.length,
    )
    const tick = options.atTick + clone.tick - clipboard.originTick
    if (!Number.isSafeInteger(tick)) throw new Error('Pasted marker tick exceeds the safe range')
    const remappedSoundId = isSoundStopMarker(clone as Marker)
      ? clone.soundId
      : (soundIdRemap[clone.soundId] ?? clone.soundId)
    Reflect.deleteProperty(clone, 'id')
    Reflect.deleteProperty(clone, 'source')
    return {
      ...clone,
      trackId: destination.tracks[destinationTrackIndex].id,
      tick: Math.max(0, tick),
      soundId: remappedSoundId,
      action: clone.action?.type === 'sound-stop'
        ? remapStopAction(clone.action, clipboard, options, destination.tracks.length)
        : clone.action,
    }
  })

  return deepFreeze({
    markers,
    assets: assetAdditions,
    instruments: instrumentAdditions,
    warnings,
    soundIdRemap,
  }) as PreparedStudioClipboardPaste
}
