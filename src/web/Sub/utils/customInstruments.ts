import {
  MAX_CUSTOM_INSTRUMENT_TEXT_LENGTH,
  MAX_PROJECT_CUSTOM_INSTRUMENTS,
  type EmbeddedCustomAudioAsset,
  type NbsCustomInstrumentSource,
  type ProjectCustomInstrument,
  type ProjectCustomInstrumentKind,
  type TimelineState,
} from '../types/timeline'

export const SOUND_STOPPER_INSTRUMENT_NAME = 'Sound Stopper'
export const TEMPO_CHANGER_INSTRUMENT_NAME = 'Tempo Changer'

const MINECRAFT_SOUND_ID = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/u
const AUTHORABLE_AUDIO_EXTENSION = /\.(?:ogg|wav|mp3)$/iu
const utf8Encoder = new TextEncoder()

export interface ApplyProjectCustomInstrumentsResult {
  state: TimelineState
  warnings: string[]
  renamedMarkers: number
  removedAssets: number
}

function stableHash(value: string): string {
  let hash = 2_166_136_261
  for (let index = 0; index < value.length; index++) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16_777_619) >>> 0
  }
  return hash.toString(36).padStart(7, '0')
}

function cloneInstrument(instrument: ProjectCustomInstrument): ProjectCustomInstrument {
  return { ...instrument }
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint < 0x20 || codePoint === 0x7f
  })
}

export function projectCustomInstrumentKind(name: string): ProjectCustomInstrumentKind {
  if (name === SOUND_STOPPER_INSTRUMENT_NAME) return 'sound-stopper'
  if (name === TEMPO_CHANGER_INSTRUMENT_NAME) return 'tempo-changer'
  return 'audio'
}

export function isProtectedProjectCustomInstrument(instrument: ProjectCustomInstrument): boolean {
  return instrument.kind !== 'audio'
}

function unsafeWindowsSegment(segment: string): boolean {
  if (/[<>:"|?*]/u.test(segment) || segment.endsWith('.') || segment.endsWith(' ')) return true
  const stem = segment.split('.')[0].toUpperCase()
  return /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(stem)
}

/** Strict portable path accepted by new authoring and safe zipped-song output. */
export function validateAuthoredNbsInstrumentFile(file: string): string | null {
  if (!file || file.length > 1024 || file.includes('\\') || file.startsWith('/')
    || hasControlCharacter(file) || !AUTHORABLE_AUDIO_EXTENSION.test(file)) {
    return 'must be a portable relative .ogg, .wav, or legacy .mp3 path'
  }
  const segments = file.split('/')
  if (segments.length > 16 || segments.some(segment => (
    !segment || segment === '.' || segment === '..'
    || unsafeWindowsSegment(segment)
    || utf8Encoder.encode(segment).byteLength > 255
  ))) return 'contains an unsafe or non-portable path segment'
  return null
}

function portableImportedFile(file: string, absoluteInstrumentIndex: number): string {
  const normalized = file.replace(/\\/gu, '/')
  return validateAuthoredNbsInstrumentFile(normalized) === null
    ? normalized
    : `instrument_${absoluteInstrumentIndex}.ogg`
}

/** Mirrors OpenNBS/NBS import's stable marker sound ID. */
export function nbsCustomInstrumentSoundId(
  instrument: Pick<NbsCustomInstrumentSource, 'file'>,
  absoluteInstrumentIndex: number,
): string {
  const path = instrument.file
    .replace(/\\/gu, '/')
    .replace(/\.[^.]+$/u, '')
    .replace(/[^a-zA-Z0-9_./-]+/gu, '_')
  return `nbs:custom/${path || `instrument_${absoluteInstrumentIndex}`}`
}

export function projectCustomInstrumentsFromNbs(
  instruments: readonly NbsCustomInstrumentSource[],
  vanillaInstrumentCount: number,
  assets: readonly EmbeddedCustomAudioAsset[] = [],
): ProjectCustomInstrument[] {
  return instruments.map((instrument, index) => {
    const kind = projectCustomInstrumentKind(instrument.name)
    const soundId = kind === 'audio'
      ? nbsCustomInstrumentSoundId(instrument, vanillaInstrumentCount + index)
      : ''
    const defaultPitch = assets.find(asset => asset.soundId === soundId)?.pitch ?? 1
    const identity = `${index}\0${instrument.name}\0${instrument.file}\0${instrument.key}\0${instrument.pressKey}`
    return {
      id: `nbs-${index}-${stableHash(identity)}`,
      kind,
      sourceIndex: index,
      soundId,
      name: instrument.name,
      file: kind === 'audio'
        ? portableImportedFile(instrument.file, vanillaInstrumentCount + index)
        : instrument.file,
      key: Math.max(0, Math.min(87, Math.trunc(instrument.key))),
      pressKey: instrument.pressKey,
      defaultPitch,
    }
  })
}

/**
 * Derive the v10 model for legacy projects without mutating provenance. Audio
 * assets not represented by NBS definitions are retained as authored rows.
 */
export function deriveProjectCustomInstruments(state: TimelineState): ProjectCustomInstrument[] {
  if (state.customInstruments !== undefined) return state.customInstruments.map(cloneInstrument)
  const result = state.source?.format === 'nbs'
    ? projectCustomInstrumentsFromNbs(
        state.source.customInstruments,
        state.source.vanillaInstrumentCount,
        state.customAudio,
      )
    : []
  const represented = new Set(result.filter(item => item.kind === 'audio').map(item => item.soundId))
  for (const asset of state.customAudio ?? []) {
    if (represented.has(asset.soundId)) continue
    represented.add(asset.soundId)
    const stem = asset.fileName.replace(/\.(?:wav|ogg)$/iu, '') || asset.soundId
    result.push({
      id: `asset-${stableHash(`${asset.soundId}\0${asset.fingerprint}`)}`,
      kind: 'audio',
      soundId: asset.soundId,
      name: stem,
      file: asset.fileName,
      key: 45,
      pressKey: true,
      defaultPitch: asset.pitch,
    })
  }
  return result
}

export function validateProjectCustomInstruments(
  instruments: readonly ProjectCustomInstrument[],
): string | null {
  if (instruments.length > MAX_PROJECT_CUSTOM_INSTRUMENTS) {
    return `Custom instruments exceed the ${MAX_PROJECT_CUSTOM_INSTRUMENTS}-definition limit.`
  }
  const ids = new Set<string>()
  for (let index = 0; index < instruments.length; index++) {
    const instrument = instruments[index]
    const label = `Custom instrument ${index + 1}`
    if (!instrument || typeof instrument !== 'object') return `${label} is invalid.`
    if (!instrument.id || instrument.id.length > 256 || hasControlCharacter(instrument.id)) {
      return `${label} has an invalid internal ID.`
    }
    if (ids.has(instrument.id)) return `${label} repeats an internal ID.`
    ids.add(instrument.id)
    if (instrument.sourceIndex !== undefined && (
      !Number.isInteger(instrument.sourceIndex)
      || instrument.sourceIndex < 0
      || instrument.sourceIndex >= MAX_PROJECT_CUSTOM_INSTRUMENTS
    )) return `${label} has an invalid NBS source index.`
    if (!['audio', 'sound-stopper', 'tempo-changer'].includes(instrument.kind)) {
      return `${label} has an invalid kind.`
    }
    if (instrument.kind === 'sound-stopper' && instrument.name !== SOUND_STOPPER_INSTRUMENT_NAME) {
      return `${label} is not an exact Sound Stopper definition.`
    }
    if (instrument.kind === 'tempo-changer' && instrument.name !== TEMPO_CHANGER_INSTRUMENT_NAME) {
      return `${label} is not an exact Tempo Changer definition.`
    }
    if (instrument.kind === 'audio'
      && (instrument.name === SOUND_STOPPER_INSTRUMENT_NAME || instrument.name === TEMPO_CHANGER_INSTRUMENT_NAME)) {
      return `${label} uses a reserved exact OpenNBS functional name.`
    }
    for (const [field, value] of [['name', instrument.name], ['file', instrument.file]] as const) {
      if (typeof value !== 'string' || value.length > MAX_CUSTOM_INSTRUMENT_TEXT_LENGTH
        || hasControlCharacter(value)) return `${label} has an invalid ${field}.`
    }
    if (typeof instrument.soundId !== 'string' || instrument.soundId.length > 1024
      || hasControlCharacter(instrument.soundId)
      || (instrument.kind === 'audio' ? !instrument.soundId : instrument.soundId !== '')) {
      return `${label} has an invalid sound ID.`
    }
    if (instrument.kind === 'audio') {
      const fileError = validateAuthoredNbsInstrumentFile(instrument.file)
      if (fileError) return `${label} file ${fileError}.`
    }
    if (!Number.isInteger(instrument.key) || instrument.key < 0 || instrument.key > 87) {
      return `${label} has an invalid source key.`
    }
    if (typeof instrument.pressKey !== 'boolean') return `${label} has an invalid press-key value.`
    if (!Number.isFinite(instrument.defaultPitch)
      || instrument.defaultPitch < 0.01 || instrument.defaultPitch > 100) {
      return `${label} has an invalid default pitch.`
    }
  }
  return null
}

function equalProtected(
  left: ProjectCustomInstrument,
  right: ProjectCustomInstrument,
): boolean {
  return left.id === right.id
    && left.kind === right.kind
    && left.sourceIndex === right.sourceIndex
    && left.soundId === right.soundId
    && left.name === right.name
    && left.file === right.file
    && left.key === right.key
    && left.pressKey === right.pressKey
    && left.defaultPitch === right.defaultPitch
}

function markerReferencesForSoundId(state: TimelineState, soundId: string): number {
  return state.markers.filter(marker => marker.soundId === soundId).length
}

function allReferencesForSoundId(state: TimelineState, soundId: string): number {
  return markerReferencesForSoundId(state, soundId)
    + (state.customAudio ?? []).filter(asset => asset.soundId === soundId).length
}

export function projectCustomInstrumentWarnings(
  instruments: readonly ProjectCustomInstrument[],
  assets: readonly EmbeddedCustomAudioAsset[],
): string[] {
  const warnings: string[] = []
  const counts = new Map<string, number>()
  const fileOwners = new Map<string, string[]>()
  for (const instrument of instruments) {
    if (instrument.kind !== 'audio') continue
    counts.set(instrument.soundId, (counts.get(instrument.soundId) ?? 0) + 1)
    if (!MINECRAFT_SOUND_ID.test(instrument.soundId)) {
      warnings.push(`${instrument.soundId} is valid for Knead/NBS playback but not a Minecraft resource location.`)
    }
    if (!instrument.file) warnings.push(`${instrument.name || instrument.soundId} has no NBS sound file.`)
    if (!assets.some(asset => asset.soundId === instrument.soundId)) {
      warnings.push(`${instrument.name || instrument.soundId} has no embedded WAV/Ogg attachment.`)
    }
    const fileKey = instrument.file.normalize('NFKC').toLocaleLowerCase('en-US')
    const owners = fileOwners.get(fileKey) ?? []
    owners.push(instrument.soundId)
    fileOwners.set(fileKey, owners)
  }
  for (const [soundId, count] of counts) {
    if (count > 1) warnings.push(`${count} definitions share ${soundId}; their audio variants and marker references are shared.`)
  }
  for (const [file, owners] of fileOwners) {
    if (owners.length > 1) {
      warnings.push(`${owners.length} definitions collide at NBS file ${file}; zipped-song export uses one shared attachment.`)
    }
  }
  return warnings
}

/**
 * Apply all staged definition edits as one project-sized value. Marker and
 * asset identities are rewritten from the original snapshot, so swaps and
 * chains never depend on mutation order.
 */
export function applyProjectCustomInstruments(
  state: TimelineState,
  nextInstruments: readonly ProjectCustomInstrument[],
): ApplyProjectCustomInstrumentsResult {
  const original = deriveProjectCustomInstruments(state)
  const next = nextInstruments.map(cloneInstrument)
  const validationError = validateProjectCustomInstruments(next)
  if (validationError) throw new Error(validationError)

  const nextById = new Map(next.map(instrument => [instrument.id, instrument]))
  for (const instrument of original.filter(isProtectedProjectCustomInstrument)) {
    const candidate = nextById.get(instrument.id)
    if (!candidate || !equalProtected(instrument, candidate)) {
      throw new Error(`${instrument.name} is a protected functional instrument and cannot be edited or deleted.`)
    }
  }

  const originalAudioBySound = new Map<string, ProjectCustomInstrument[]>()
  for (const instrument of original.filter(item => item.kind === 'audio')) {
    const group = originalAudioBySound.get(instrument.soundId) ?? []
    group.push(instrument)
    originalAudioBySound.set(instrument.soundId, group)
  }
  const rename = new Map<string, string>()
  for (const [oldSoundId, group] of originalAudioBySound) {
    const destinations = new Set(group
      .map(instrument => nextById.get(instrument.id)?.soundId)
      .filter((value): value is string => value !== undefined))
    const markerReferences = markerReferencesForSoundId(state, oldSoundId)
    if (destinations.size === 0) {
      if (markerReferences > 0) {
        throw new Error(`Cannot delete ${oldSoundId}; ${markerReferences} marker reference(s) still use it.`)
      }
      continue
    }
    if (destinations.size > 1 && allReferencesForSoundId(state, oldSoundId) > 0) {
      throw new Error(`Cannot split shared sound ID ${oldSoundId} while markers or audio still reference it.`)
    }
    const destination = destinations.values().next().value as string
    if (destination !== oldSoundId) rename.set(oldSoundId, destination)
  }

  let renamedMarkers = 0
  const markers = state.markers.map((marker) => {
    const soundId = rename.get(marker.soundId)
    if (!soundId) return marker
    renamedMarkers++
    return { ...marker, soundId }
  })

  const warnings: string[] = []
  const audioDefinitions = next.filter(instrument => instrument.kind === 'audio')
  const firstBySound = new Map<string, ProjectCustomInstrument>()
  for (const instrument of audioDefinitions) {
    const previous = firstBySound.get(instrument.soundId)
    if (!previous) firstBySound.set(instrument.soundId, instrument)
    else if (previous.defaultPitch !== instrument.defaultPitch || previous.file !== instrument.file) {
      warnings.push(`Shared sound ID ${instrument.soundId} uses the first definition's file and default pitch for embedded variants.`)
    }
  }
  const assets: EmbeddedCustomAudioAsset[] = []
  const assetPairs = new Set<string>()
  let removedAssets = 0
  for (const asset of state.customAudio ?? []) {
    const soundId = rename.get(asset.soundId) ?? asset.soundId
    const definition = firstBySound.get(soundId)
    if (!definition && originalAudioBySound.has(asset.soundId)) {
      removedAssets++
      continue
    }
    const pair = `${soundId}\0${asset.fingerprint}`
    if (assetPairs.has(pair)) {
      removedAssets++
      warnings.push(`A duplicate ${soundId} audio variant created by renaming was removed.`)
      continue
    }
    assetPairs.add(pair)
    assets.push({
      ...asset,
      soundId,
      ...(definition
        ? {
            fileName: definition.file || asset.fileName,
            pitch: definition.defaultPitch,
          }
        : {}),
    })
  }

  warnings.push(...projectCustomInstrumentWarnings(next, assets))
  return {
    state: {
      ...state,
      markers,
      customAudio: assets,
      customInstruments: next,
    },
    warnings: Array.from(new Set(warnings)),
    renamedMarkers,
    removedAssets,
  }
}

function slug(value: string): string {
  return value
    .normalize('NFKD')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9_.-]+/gu, '_')
    .replace(/^[_ .-]+|[_ .-]+$/gu, '')
    .slice(0, 80) || 'instrument'
}

export function createProjectCustomInstrument(
  existing: readonly ProjectCustomInstrument[],
  label = 'Instrument',
): ProjectCustomInstrument {
  const usedIds = new Set(existing.map(instrument => instrument.id))
  const usedSoundIds = new Set(existing.map(instrument => instrument.soundId))
  const base = slug(label)
  let suffix = 1
  let soundId = `knead:custom/${base}`
  while (usedSoundIds.has(soundId)) soundId = `knead:custom/${base}_${++suffix}`
  const randomId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${existing.length}`
  let id = `custom-${randomId}`
  while (usedIds.has(id)) id = `${id}-1`
  return {
    id,
    kind: 'audio',
    soundId,
    name: label,
    file: `${base}.ogg`,
    key: 45,
    pressKey: true,
    defaultPitch: 1,
  }
}
