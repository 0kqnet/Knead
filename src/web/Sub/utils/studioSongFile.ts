import type {
  PlainNbsCustomAudioAsset,
  PlainNbsCustomAudioResult,
  StudioSongFileKind,
  StudioSongWritePayload,
  TimelineOpenResult,
} from '../../../../@types/global'
import {
  MAX_EMBEDDED_CUSTOM_AUDIO_BYTES,
  MAX_EMBEDDED_CUSTOM_AUDIO_PROJECT_BYTES,
  type TimelineState,
} from '../types/timeline'
import {
  isSoundStopperInstrument,
  isTempoChangerInstrument,
  nbsToTimelineState,
  parseNbs,
  timelineStateToNbs,
  writeNbsWithWarnings,
  type NbsInstrument,
  type NbsTargetVersion,
} from './nbs'
import {
  nbsBundleSoundId,
  type NbsBundleInstrumentAudio,
} from './nbsBundle'
import { prepareProjectCustomAudio } from './projectCustomAudio'
import { parse as parseKneadProject, serialize as serializeKneadProject } from './timelineIO'

export const MAX_STUDIO_NBS_BYTES = 16 * 1024 * 1024
export const MAX_PLAIN_NBS_CUSTOM_AUDIO_FILES = 240

type SuccessfulTimelineOpenResult = Extract<TimelineOpenResult, { ok: true }>

export interface ParsedStudioSongFile {
  state: TimelineState
  fileKind: StudioSongFileKind
  /** Present for NBS documents, including source version 0. */
  nbsTargetVersion: NbsTargetVersion | null
  warnings: string[]
  /** Transient native lookup metadata; never serialized into a project. */
  plainNbsCustomAudio: PlainNbsCustomAudioReference[]
}

export interface PlainNbsCustomAudioReference {
  customInstrumentIndex: number
  instrumentId: number
  instrument: NbsInstrument
  soundId: string
}

export type ParseStudioSongFileResult =
  | { ok: true, document: ParsedStudioSongFile }
  | { ok: false, error: string }

export interface SerializedStudioSongFile {
  payload: StudioSongWritePayload
  warnings: string[]
  /** Warnings which require an explicit save confirmation. */
  lossWarnings: string[]
}

function decodeBase64(value: string): Uint8Array {
  const estimatedBytes = Math.floor(value.length * 3 / 4)
  if (estimatedBytes > MAX_STUDIO_NBS_BYTES + 2) throw new Error('NBS file exceeds the 16 MiB limit')
  let binary: string
  try {
    binary = atob(value)
  }
  catch {
    throw new Error('NBS file contains invalid base64 data')
  }
  if (binary.length === 0 || binary.length > MAX_STUDIO_NBS_BYTES) {
    throw new Error('NBS file must be between 1 byte and 16 MiB')
  }
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function encodeBase64(bytes: Uint8Array): string {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_STUDIO_NBS_BYTES) {
    throw new Error('NBS file must be between 1 byte and 16 MiB')
  }
  const chunkSize = 0x8000
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
}

function uniqueWarnings(...groups: readonly (readonly string[])[]): string[] {
  return Array.from(new Set(groups.flat()))
}

function plainNbsCustomAudioReferences(
  customInstruments: readonly NbsInstrument[],
  vanillaInstrumentCount: number,
): PlainNbsCustomAudioReference[] {
  return customInstruments.flatMap((instrument, customInstrumentIndex) => {
    if (isSoundStopperInstrument(instrument) || isTempoChangerInstrument(instrument)) return []
    const instrumentId = vanillaInstrumentCount + customInstrumentIndex
    return [{
      customInstrumentIndex,
      instrumentId,
      instrument: { ...instrument },
      soundId: nbsBundleSoundId(instrument, instrumentId),
    }]
  })
}

function canonicalPlainNbsAudioName(fileName: string): string {
  return fileName.replace(/\\/gu, '/').normalize('NFKC').toLocaleLowerCase('en-US')
}

export function getPlainNbsCustomAudioFileNames(document: ParsedStudioSongFile): string[] {
  const seen = new Set<string>()
  const fileNames: string[] = []
  for (const reference of document.plainNbsCustomAudio) {
    const fileName = reference.instrument.file
    if (!fileName) continue
    const key = canonicalPlainNbsAudioName(fileName)
    if (seen.has(key)) continue
    seen.add(key)
    if (fileNames.length === MAX_PLAIN_NBS_CUSTOM_AUDIO_FILES) break
    fileNames.push(fileName)
  }
  return fileNames
}

function decodePlainNbsCustomAudioAsset(asset: PlainNbsCustomAudioAsset): Uint8Array {
  if (!Number.isInteger(asset.byteLength)
    || asset.byteLength < 1
    || asset.byteLength > MAX_EMBEDDED_CUSTOM_AUDIO_BYTES) {
    throw new Error(`Invalid resolved custom-audio size: ${asset.fileName}`)
  }
  if (asset.mimeType !== 'audio/ogg' && asset.mimeType !== 'audio/wav') {
    throw new Error(`Invalid resolved custom-audio type: ${asset.fileName}`)
  }
  const expectedType = /\.ogg$/iu.test(asset.fileName)
    ? 'audio/ogg'
    : /\.wav$/iu.test(asset.fileName) ? 'audio/wav' : null
  if (expectedType !== asset.mimeType) {
    throw new Error(`Resolved custom-audio extension mismatch: ${asset.fileName}`)
  }
  if (asset.dataBase64.length !== Math.ceil(asset.byteLength / 3) * 4) {
    throw new Error(`Resolved custom-audio base64 length mismatch: ${asset.fileName}`)
  }
  let binary: string
  try {
    binary = atob(asset.dataBase64)
  }
  catch {
    throw new Error(`Invalid resolved custom-audio base64: ${asset.fileName}`)
  }
  if (binary.length !== asset.byteLength) {
    throw new Error(`Resolved custom-audio length mismatch: ${asset.fileName}`)
  }
  const data = Uint8Array.from(binary, character => character.charCodeAt(0))
  const validOgg = asset.mimeType === 'audio/ogg'
    && data.byteLength >= 4
    && String.fromCharCode(...data.subarray(0, 4)) === 'OggS'
  const validWav = asset.mimeType === 'audio/wav'
    && data.byteLength >= 12
    && String.fromCharCode(...data.subarray(0, 4)) === 'RIFF'
    && String.fromCharCode(...data.subarray(8, 12)) === 'WAVE'
  if (!validOgg && !validWav) {
    throw new Error(`Resolved custom-audio signature mismatch: ${asset.fileName}`)
  }
  return data
}

const NEEDS_CUSTOM_SOUND_WARNING = /^\d+ custom-instrument note\(s\) need matching sounds to be installed\.$/u

/**
 * Verify native sibling-sound results and turn them into the same portable,
 * content-addressed assets used by NBS bundles. No active registry is mutated.
 */
export async function attachPlainNbsCustomAudio(
  document: ParsedStudioSongFile,
  resolution: PlainNbsCustomAudioResult,
): Promise<ParsedStudioSongFile> {
  if (document.fileKind !== 'nbs' || document.plainNbsCustomAudio.length === 0) return document
  const warnings = document.warnings.filter(warning => !NEEDS_CUSTOM_SOUND_WARNING.test(warning))
  if (!resolution.ok) {
    return {
      ...document,
      state: { ...document.state, customAudio: [] },
      warnings: uniqueWarnings(warnings, [
        `Automatic custom-sound lookup failed: ${resolution.error}`,
      ]),
    }
  }

  const requested = new Set(getPlainNbsCustomAudioFileNames(document).map(canonicalPlainNbsAudioName))
  if (resolution.assets.length > MAX_PLAIN_NBS_CUSTOM_AUDIO_FILES) {
    throw new Error('Native custom-audio result exceeds the 240-file limit')
  }
  const resolvedByName = new Map<string, { asset: PlainNbsCustomAudioAsset, data: Uint8Array }>()
  let totalBytes = 0
  for (const asset of resolution.assets) {
    const key = canonicalPlainNbsAudioName(asset.fileName)
    if (!requested.has(key)) throw new Error(`Native custom-audio result was not requested: ${asset.fileName}`)
    if (resolvedByName.has(key)) throw new Error(`Duplicate native custom-audio result: ${asset.fileName}`)
    totalBytes += asset.byteLength
    if (totalBytes > MAX_EMBEDDED_CUSTOM_AUDIO_PROJECT_BYTES) {
      throw new Error('Resolved custom audio exceeds the 96 MiB project budget')
    }
    const data = decodePlainNbsCustomAudioAsset(asset)
    resolvedByName.set(key, { asset, data })
  }

  const audio: NbsBundleInstrumentAudio[] = []
  const missing = new Set<string>()
  for (const reference of document.plainNbsCustomAudio) {
    if (!reference.instrument.file) {
      missing.add(`Custom instrument ${reference.customInstrumentIndex + 1} (${reference.instrument.name || 'unnamed'}) has no sound file.`)
      continue
    }
    const resolved = resolvedByName.get(canonicalPlainNbsAudioName(reference.instrument.file))
    if (!resolved) {
      if (!resolution.warnings.some(warning => warning.includes(reference.instrument.file))) {
        missing.add(`No usable sibling sound was loaded for custom instrument ${reference.customInstrumentIndex + 1}: ${reference.instrument.file}.`)
      }
      continue
    }
    audio.push({
      customInstrumentIndex: reference.customInstrumentIndex,
      instrumentId: reference.instrumentId,
      instrument: { ...reference.instrument },
      soundId: reference.soundId,
      archivePath: `sounds/${reference.instrument.file.replace(/\\/gu, '/')}`,
      mediaType: resolved.asset.mimeType,
      data: resolved.data,
    })
  }
  const prepared = await prepareProjectCustomAudio(audio)
  return {
    ...document,
    state: { ...document.state, customAudio: prepared.assets },
    warnings: uniqueWarnings(warnings, resolution.warnings, [...missing], prepared.warnings),
  }
}

export function isNbsTargetVersion(value: number): value is NbsTargetVersion {
  return Number.isInteger(value) && value >= 0 && value <= 6
}

export function nbsTargetVersionForState(state: TimelineState): NbsTargetVersion {
  const sourceVersion = state.source?.format === 'nbs' ? state.source.sourceVersion : undefined
  return sourceVersion !== undefined && isNbsTargetVersion(sourceVersion) ? sourceVersion : 5
}

export function parseStudioSongFile(
  result: SuccessfulTimelineOpenResult,
  minecraftTargetVersion = '',
): ParseStudioSongFileResult {
  if (result.kind === 'kp') {
    const parsed = parseKneadProject(result.json)
    return parsed.ok
      ? {
          ok: true,
          document: {
            state: parsed.state,
            fileKind: 'kp',
            nbsTargetVersion: null,
            warnings: parsed.warnings,
            plainNbsCustomAudio: [],
          },
        }
      : parsed
  }

  try {
    const parsed = parseNbs(exactArrayBuffer(decodeBase64(result.dataBase64)))
    if (!parsed.ok) return parsed
    if (!isNbsTargetVersion(parsed.song.header.version)) {
      return { ok: false, error: `Unsupported NBS version: ${parsed.song.header.version}` }
    }
    const converted = nbsToTimelineState(parsed.song, minecraftTargetVersion)
    converted.state.customAudio = []
    const customAudio = plainNbsCustomAudioReferences(
      parsed.song.customInstruments,
      parsed.song.header.vanillaInstrumentCount,
    )
    const uniqueFiles = new Set(
      customAudio
        .filter(reference => reference.instrument.file)
        .map(reference => canonicalPlainNbsAudioName(reference.instrument.file)),
    )
    const lookupWarnings = uniqueFiles.size > MAX_PLAIN_NBS_CUSTOM_AUDIO_FILES
      ? [`Only the first ${MAX_PLAIN_NBS_CUSTOM_AUDIO_FILES} unique custom-instrument sounds can be loaded automatically.`]
      : []
    return {
      ok: true,
      document: {
        state: converted.state,
        fileKind: 'nbs',
        nbsTargetVersion: parsed.song.header.version,
        warnings: uniqueWarnings(converted.warnings, lookupWarnings),
        plainNbsCustomAudio: customAudio,
      },
    }
  }
  catch (error) {
    return { ok: false, error: String(error) }
  }
}

/**
 * Features whose authoring data cannot be reconstructed from a plain NBS file.
 * These are intentionally separate from ordinary compatibility warnings so a
 * caller can require an explicit, cancelable confirmation before writing.
 */
export function getPlainNbsLossWarnings(state: TimelineState): string[] {
  const warnings: string[] = []
  const customAudioCount = state.customAudio?.length ?? 0
  if (customAudioCount > 0) {
    warnings.push(`${customAudioCount} embedded custom-audio asset(s) are not bundled in a plain NBS file.`)
  }
  const referenceAudioCount = state.referenceAudio?.length ?? 0
  if (referenceAudioCount > 0) {
    warnings.push(`${referenceAudioCount} reference-audio track(s) are omitted from NBS.`)
  }
  const laterTempoEvents = Math.max(0, (state.tempoMap?.length ?? 1) - 1)
  if (laterTempoEvents > 0) {
    warnings.push(`${laterTempoEvents} later tempo/meter event(s) are omitted from NBS.`)
  }
  const automatedMarkers = state.markers.filter(marker => marker.volumeCurve || marker.pitchCurve).length
  if (automatedMarkers > 0) {
    warnings.push(`${automatedMarkers} marker automation curve(s) are baked or omitted by NBS.`)
  }
  const retriggerMarkers = state.markers.filter(marker => (
    (marker.duration ?? 0) > 0 || (marker.retriggerInterval ?? 1) !== 1
  )).length
  if (retriggerMarkers > 0) {
    warnings.push(`${retriggerMarkers} duration/retrigger marker(s) are flattened into NBS note events.`)
  }
  const gatedMarkers = state.markers.filter(marker => (marker.gateTicks ?? 0) > 0)
  if (gatedMarkers.length > 0) {
    const shownIds = gatedMarkers.slice(0, 20).map(marker => marker.id)
    const remaining = gatedMarkers.length - shownIds.length
    warnings.push(
      `${gatedMarkers.length} marker gate cutoff(s) are omitted from NBS (IDs: ${shownIds.join(', ')}${remaining ? `, +${remaining} more` : ''}).`,
    )
  }
  const fixedVariants = state.markers.filter(marker => marker.variantIndex >= 0).length
  if (fixedVariants > 0) {
    warnings.push(`${fixedVariants} fixed sound variant selection(s) cannot be represented in NBS.`)
  }
  const mutedOrSoloTracks = state.tracks.filter(track => track.muted || track.solo).length
  if (mutedOrSoloTracks > 0) {
    warnings.push(`${mutedOrSoloTracks} muted/solo mixer track state(s) are baked by omitting inaudible notes.`)
  }
  const mixedTracks = state.tracks.filter(track => track.gainDb !== 0 || track.pan !== 0).length
  if (mixedTracks > 0) {
    warnings.push(`${mixedTracks} track gain/pan mixer setting(s) are baked into NBS note velocity and panning.`)
  }
  if (state.master.gainDb !== 0) warnings.push('Master gain is baked into NBS note velocities.')
  if (state.master.limiterEnabled) warnings.push('The Knead master limiter is not stored or applied by NBS.')
  return warnings
}

export function serializeStudioSongFile(
  state: TimelineState,
  fileKind: StudioSongFileKind,
  displayName = 'Untitled',
  nbsTargetVersion: NbsTargetVersion = nbsTargetVersionForState(state),
): SerializedStudioSongFile {
  if (fileKind === 'kp') {
    return {
      payload: { kind: 'kp', data: serializeKneadProject(state) },
      warnings: [],
      lossWarnings: [],
    }
  }
  if (!isNbsTargetVersion(nbsTargetVersion)) {
    throw new Error(`Unsupported NBS target version: ${String(nbsTargetVersion)}`)
  }
  const name = displayName.replace(/^.*[\\/]/u, '').replace(/\.nbs$/iu, '') || 'Untitled'
  const converted = timelineStateToNbs(state, name, nbsTargetVersion)
  const encoded = writeNbsWithWarnings(converted.song, nbsTargetVersion)
  // Compatibility/down-save warnings are data-loss warnings too (clamps,
  // unsupported fields, generated layers, and string/path normalization).
  const lossWarnings = uniqueWarnings(
    converted.warnings,
    encoded.warnings,
    getPlainNbsLossWarnings(state),
  )
  return {
    payload: { kind: 'nbs', dataBase64: encodeBase64(encoded.data) },
    warnings: lossWarnings,
    lossWarnings,
  }
}
