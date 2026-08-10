import { parseVersion, type VersionInfoType } from '../../../types/VersionInfo'
import {
  DEFAULT_RETRIGGER_INTERVAL,
  isSoundStopMarker,
  type Marker,
  type TimelineState,
} from '../types/timeline'
import { sampleCurve } from './curveSampling'
import { generationCheckpoint, type GenerationProgressContext } from './generationProgress'
import {
  gzipDeterministic,
  nbtByte,
  nbtByteArray,
  nbtCompound,
  nbtInt,
  nbtList,
  nbtShort,
  nbtString,
  writeNbt,
  type NbtNamedTag,
  type NbtTag,
} from './nbt'

/** The four formats exposed by OpenNBS at commit abbf7d52. */
export type NoteBlockBuildFormat =
  | 'structure-block-nbt'
  | 'litematica-compatible-nbt'
  | 'schematic-1.11-1.12'
  | 'schematic-pre-1.11'

export type NoteBlockBuildLayout = 'fixed-tracks' | 'schematic-grid'

export type NoteBlockBuildCircuit = 'display' | 'playable-redstone'

export interface NoteBlockBuildOptions {
  format: NoteBlockBuildFormat
  layout: NoteBlockBuildLayout
  /** Static placement or an OpenNBS-style, self-playing redstone circuit. */
  circuit: NoteBlockBuildCircuit
  includeLockedTracks: boolean
  /** Timeline ticks wrapped into each row by the schematic-grid layout. */
  notesPerRow: number
  /** Overrides project.targetVersion when the host has a newer active selection. */
  targetVersion?: string
}

export interface NoteBlockBuildDimensions {
  x: number
  y: number
  z: number
}

export interface NoteBlockBuildResult {
  data: Uint8Array
  extension: '.nbt' | '.schematic'
  format: NoteBlockBuildFormat
  dimensions: NoteBlockBuildDimensions
  blockCount: number
  noteBlockCount: number
  warnings: string[]
  circuit: NoteBlockBuildCircuit
  /** Present only for a physical redstone build. Values use Knead's 20 TPS ticks. */
  timing?: NoteBlockBuildTimingMetadata
}

export interface NoteBlockBuildTimingMetadata {
  /** Repeaters are reliable on a two-game-tick (one redstone-tick) grid. */
  quantumTicks: 2
  /** The first timing repeater deliberately adds one redstone tick. */
  startLatencyTicks: 2
  delayNodeCount: number
  quantizedNoteCount: number
  collapsedRetriggerCount: number
  trackSlotCount: number
}

export interface NoteBlockInstrumentDefinition {
  soundId: string
  instrument: string
  modernSupportBlock: string
  legacySupportBlock: number
  /** First release whose note block recognizes this instrument. */
  introduced: 'classic' | '1.12' | '1.14' | '26.1'
}

export const OPENNBS_SCHEMATIC_SOURCE = Object.freeze({
  repository: 'https://github.com/OpenNBS/NoteBlockStudio',
  commit: 'abbf7d52c279e08ce8f12799495bfbfb882280c2',
  exporter: 'scripts/schematic_export/schematic_export.gml',
  dialog: 'scripts/draw_window_schematic_export/draw_window_schematic_export.gml',
})

export const NOTE_BLOCK_BUILD_LIMITS = Object.freeze({
  maxTracks: 256,
  maxMarkers: 100_000,
  maxNoteInstances: 100_000,
  maxBlocks: 200_000,
  /** OpenNBS rejects a dimension value of 2,000 or greater. */
  maxHorizontalDimension: 1_999,
  /** OpenNBS rejects a height value of 256 or greater. */
  maxHeight: 255,
  maxLegacyVolume: 8 * 1024 * 1024,
  maxNbtBytes: 64 * 1024 * 1024,
  maxGzipBytes: 72 * 1024 * 1024,
})

export const NOTE_BLOCK_INSTRUMENTS: readonly NoteBlockInstrumentDefinition[] = Object.freeze([
  { soundId: 'block.note_block.harp', instrument: 'harp', modernSupportBlock: 'minecraft:dirt', legacySupportBlock: 3, introduced: 'classic' },
  { soundId: 'block.note_block.bass', instrument: 'bass', modernSupportBlock: 'minecraft:oak_planks', legacySupportBlock: 5, introduced: 'classic' },
  { soundId: 'block.note_block.basedrum', instrument: 'basedrum', modernSupportBlock: 'minecraft:cobblestone', legacySupportBlock: 4, introduced: 'classic' },
  { soundId: 'block.note_block.snare', instrument: 'snare', modernSupportBlock: 'minecraft:sand', legacySupportBlock: 12, introduced: 'classic' },
  { soundId: 'block.note_block.hat', instrument: 'hat', modernSupportBlock: 'minecraft:glass', legacySupportBlock: 20, introduced: 'classic' },
  { soundId: 'block.note_block.guitar', instrument: 'guitar', modernSupportBlock: 'minecraft:white_wool', legacySupportBlock: 35, introduced: '1.12' },
  { soundId: 'block.note_block.flute', instrument: 'flute', modernSupportBlock: 'minecraft:clay', legacySupportBlock: 82, introduced: '1.12' },
  { soundId: 'block.note_block.bell', instrument: 'bell', modernSupportBlock: 'minecraft:gold_block', legacySupportBlock: 41, introduced: '1.12' },
  { soundId: 'block.note_block.chime', instrument: 'chime', modernSupportBlock: 'minecraft:packed_ice', legacySupportBlock: 174, introduced: '1.12' },
  { soundId: 'block.note_block.xylophone', instrument: 'xylophone', modernSupportBlock: 'minecraft:bone_block', legacySupportBlock: 216, introduced: '1.12' },
  { soundId: 'block.note_block.iron_xylophone', instrument: 'iron_xylophone', modernSupportBlock: 'minecraft:iron_block', legacySupportBlock: 42, introduced: '1.14' },
  { soundId: 'block.note_block.cow_bell', instrument: 'cow_bell', modernSupportBlock: 'minecraft:soul_sand', legacySupportBlock: 88, introduced: '1.14' },
  { soundId: 'block.note_block.didgeridoo', instrument: 'didgeridoo', modernSupportBlock: 'minecraft:pumpkin', legacySupportBlock: 86, introduced: '1.14' },
  { soundId: 'block.note_block.bit', instrument: 'bit', modernSupportBlock: 'minecraft:emerald_block', legacySupportBlock: 133, introduced: '1.14' },
  { soundId: 'block.note_block.banjo', instrument: 'banjo', modernSupportBlock: 'minecraft:hay_block', legacySupportBlock: 170, introduced: '1.14' },
  { soundId: 'block.note_block.pling', instrument: 'pling', modernSupportBlock: 'minecraft:glowstone', legacySupportBlock: 89, introduced: '1.14' },
  { soundId: 'block.note_block.trumpet', instrument: 'trumpet', modernSupportBlock: 'minecraft:waxed_copper_block', legacySupportBlock: 1, introduced: '26.1' },
  { soundId: 'block.note_block.trumpet_exposed', instrument: 'trumpet_exposed', modernSupportBlock: 'minecraft:waxed_exposed_copper', legacySupportBlock: 1, introduced: '26.1' },
  { soundId: 'block.note_block.trumpet_weathered', instrument: 'trumpet_weathered', modernSupportBlock: 'minecraft:waxed_weathered_copper', legacySupportBlock: 1, introduced: '26.1' },
  { soundId: 'block.note_block.trumpet_oxidized', instrument: 'trumpet_oxidized', modernSupportBlock: 'minecraft:waxed_oxidized_copper', legacySupportBlock: 1, introduced: '26.1' },
])

const FORMAT_EXTENSIONS: Readonly<Record<NoteBlockBuildFormat, '.nbt' | '.schematic'>> = Object.freeze({
  'structure-block-nbt': '.nbt',
  'litematica-compatible-nbt': '.nbt',
  'schematic-1.11-1.12': '.schematic',
  'schematic-pre-1.11': '.schematic',
})

const HISTORICAL_NOTE_BLOCK_SOUND_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  'note.harp': 'block.note_block.harp',
  'note.bass': 'block.note_block.bass',
  'note.bd': 'block.note_block.basedrum',
  'note.basedrum': 'block.note_block.basedrum',
  'note.snare': 'block.note_block.snare',
  'note.hat': 'block.note_block.hat',
  'note.pling': 'block.note_block.pling',
  'block.note.harp': 'block.note_block.harp',
  'block.note.bass': 'block.note_block.bass',
  'block.note.bd': 'block.note_block.basedrum',
  'block.note.basedrum': 'block.note_block.basedrum',
  'block.note.snare': 'block.note_block.snare',
  'block.note.hat': 'block.note_block.hat',
  'block.note.guitar': 'block.note_block.guitar',
  'block.note.flute': 'block.note_block.flute',
  'block.note.bell': 'block.note_block.bell',
  'block.note.chime': 'block.note_block.chime',
  'block.note.xylophone': 'block.note_block.xylophone',
  'block.note.pling': 'block.note_block.pling',
})

export const DEFAULT_NOTE_BLOCK_BUILD_OPTIONS: NoteBlockBuildOptions = Object.freeze({
  format: 'litematica-compatible-nbt',
  layout: 'fixed-tracks',
  circuit: 'display',
  includeLockedTracks: false,
  notesPerRow: 20,
})

interface VersionCapabilities {
  era: 'pre-1.11' | '1.11-1.12' | 'modern' | 'unknown'
  instrumentLevel: 0 | 1 | 2 | 3
}

type SnapshotVersion = Extract<VersionInfoType, { kind: 'snapshot' }>

interface BuildNote {
  marker: Marker
  trackIndex: number
  tick: number
  firingIndex: number
  instrument: NoteBlockInstrumentDefinition
  note: number
  voice: number
}

interface BuildBlockState {
  name: string
  properties?: Readonly<Record<string, string>>
}

interface BuildBlock {
  x: number
  y: number
  z: number
  state: BuildBlockState
  legacyId: number
  legacyData: number
  note?: number
  instrument?: string
}

interface BuildModel {
  dimensions: NoteBlockBuildDimensions
  blocks: BuildBlock[]
  noteBlocks: BuildBlock[]
  warnings: string[]
  timing?: NoteBlockBuildTimingMetadata
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function snapshotAtLeast(
  version: SnapshotVersion,
  year: number,
  releaseNumber: number,
  letter = 'a',
): boolean {
  return version.year > year
    || (version.year === year && (
      version.releaseNumber > releaseNumber
      || (version.releaseNumber === releaseNumber && version.letter.localeCompare(letter) >= 0)
    ))
}

function numberedSnapshotInstrumentLevel(raw: string): 2 | 3 | null {
  const match = /^(\d+)\.(\d+)-snapshot-(\d+)$/.exec(raw)
  if (!match) return null
  const major = Number(match[1])
  const minor = Number(match[2])
  const snapshot = Number(match[3])
  return major > 26 || (major === 26 && (minor > 1 || (minor === 1 && snapshot >= 7))) ? 3 : 2
}

function classifyTargetVersion(raw: string): VersionCapabilities {
  const parsed = parseVersion(raw.trim())
  if (!parsed) return { era: 'unknown', instrumentLevel: 0 }
  if (parsed.kind === 'snapshot') {
    if (!snapshotAtLeast(parsed, 16, 32)) {
      return { era: 'pre-1.11', instrumentLevel: 0 }
    }
    if (!snapshotAtLeast(parsed, 17, 43)) {
      return {
        era: '1.11-1.12',
        instrumentLevel: snapshotAtLeast(parsed, 17, 17) ? 1 : 0,
      }
    }
    const numberedLevel = numberedSnapshotInstrumentLevel(parsed.raw)
    if (numberedLevel !== null) return { era: 'modern', instrumentLevel: numberedLevel }
    if (parsed.year > 26) return { era: 'modern', instrumentLevel: 3 }
    return {
      era: 'modern',
      instrumentLevel: snapshotAtLeast(parsed, 18, 43) ? 2 : 1,
    }
  }
  const { major, minor } = parsed
  if (major === 1 && minor < 11) return { era: 'pre-1.11', instrumentLevel: 0 }
  if (major === 1 && minor < 13) {
    return { era: '1.11-1.12', instrumentLevel: minor >= 12 ? 1 : 0 }
  }
  if (major > 26 || (major === 26 && minor >= 1)) return { era: 'modern', instrumentLevel: 3 }
  return { era: 'modern', instrumentLevel: major > 1 || minor >= 14 ? 2 : 1 }
}

function requiredEra(format: NoteBlockBuildFormat): VersionCapabilities['era'] {
  if (format === 'schematic-pre-1.11') return 'pre-1.11'
  if (format === 'schematic-1.11-1.12') return '1.11-1.12'
  return 'modern'
}

export function validateNoteBlockBuildTarget(format: NoteBlockBuildFormat, targetVersion: string): string | null {
  const capability = classifyTargetVersion(targetVersion)
  if (capability.era === 'unknown') return null
  const expected = requiredEra(format)
  if (capability.era === expected) return null
  return `${format} is incompatible with Minecraft ${targetVersion}; expected ${expected}`
}

export function defaultNoteBlockBuildFormat(targetVersion: string): NoteBlockBuildFormat {
  const capability = classifyTargetVersion(targetVersion)
  if (capability.era === 'pre-1.11') return 'schematic-pre-1.11'
  if (capability.era === '1.11-1.12') return 'schematic-1.11-1.12'
  return 'litematica-compatible-nbt'
}

function normalizeSoundId(soundId: string): string {
  return soundId.startsWith('minecraft:') ? soundId.slice('minecraft:'.length) : soundId
}

function resolveInstrument(soundId: string): NoteBlockInstrumentDefinition | undefined {
  const normalized = normalizeSoundId(soundId)
  const canonical = HISTORICAL_NOTE_BLOCK_SOUND_ALIASES[normalized] ?? normalized
  return NOTE_BLOCK_INSTRUMENTS.find(instrument => instrument.soundId === canonical)
}

function instrumentLevel(instrument: NoteBlockInstrumentDefinition): number {
  if (instrument.introduced === 'classic') return 0
  if (instrument.introduced === '1.12') return 1
  if (instrument.introduced === '1.14') return 2
  return 3
}

function effectiveInstrumentLevel(
  capabilities: VersionCapabilities,
  format: NoteBlockBuildFormat,
): number {
  if (capabilities.era !== 'unknown') return capabilities.instrumentLevel
  if (format === 'schematic-pre-1.11') return 0
  if (format === 'schematic-1.11-1.12') return 1
  return 1
}

function validateProject(project: TimelineState, options: NoteBlockBuildOptions): void {
  if (!project || !Array.isArray(project.tracks) || !Array.isArray(project.markers)) {
    throw new Error('Project tracks and markers are required')
  }
  if (project.tracks.length < 1 || project.tracks.length > NOTE_BLOCK_BUILD_LIMITS.maxTracks) {
    throw new Error(`Track count must be between 1 and ${NOTE_BLOCK_BUILD_LIMITS.maxTracks}`)
  }
  if (project.markers.length > NOTE_BLOCK_BUILD_LIMITS.maxMarkers) {
    throw new Error(`Marker count exceeds ${NOTE_BLOCK_BUILD_LIMITS.maxMarkers}`)
  }
  if (!Number.isInteger(options.notesPerRow) || options.notesPerRow < 5 || options.notesPerRow > 100) {
    throw new Error('notesPerRow must be an integer between 5 and 100')
  }
  const ids = new Set<string>()
  for (const track of project.tracks) {
    if (!track.id || ids.has(track.id)) throw new Error('Track IDs must be non-empty and unique')
    ids.add(track.id)
  }
  for (const marker of project.markers) {
    if (!ids.has(marker.trackId)) throw new Error(`Marker ${marker.id} references an unknown track`)
    if (!Number.isInteger(marker.tick) || marker.tick < 0) throw new Error(`Marker ${marker.id} has an invalid tick`)
    if (!Number.isFinite(marker.pitch) || marker.pitch <= 0) throw new Error(`Marker ${marker.id} has an invalid pitch`)
    if (!Number.isInteger(marker.variantIndex) || marker.variantIndex < -1) {
      throw new Error(`Marker ${marker.id} has an invalid variant index`)
    }
    if (marker.duration !== undefined && (!Number.isInteger(marker.duration) || marker.duration < 0)) {
      throw new Error(`Marker ${marker.id} has an invalid duration`)
    }
    if (marker.retriggerInterval !== undefined
      && (!Number.isInteger(marker.retriggerInterval) || marker.retriggerInterval <= 0)) {
      throw new Error(`Marker ${marker.id} has an invalid retrigger interval`)
    }
  }
}

function collectBuildNotes(
  project: TimelineState,
  options: NoteBlockBuildOptions,
  capabilities: VersionCapabilities,
  progressContext?: GenerationProgressContext,
): { notes: BuildNote[], warnings: string[] } {
  const trackById = new Map(project.tracks.map((track, index) => [track.id, { track, index }]))
  const unknownSounds = new Map<string, number>()
  const unavailableSounds = new Map<string, number>()
  const candidates: Omit<BuildNote, 'voice'>[] = []
  let lockedMarkerCount = 0
  let soundStopCount = 0
  let volumeAutomationCount = 0
  let fixedVariantCount = 0
  let pitchQuantizedCount = 0
  let pitchClampedCount = 0
  let dynamicMixCount = 0
  const supportedLevel = effectiveInstrumentLevel(capabilities, options.format)
  const sortedMarkers = [...project.markers].sort((left, right) => (
    left.tick - right.tick
    || (trackById.get(left.trackId)!.index - trackById.get(right.trackId)!.index)
    || compareText(left.id, right.id)
  ))
  let markerIndex = 0
  for (const marker of sortedMarkers) {
    if ((markerIndex & 0xff) === 0) {
      generationCheckpoint(
        progressContext,
        0.1 + 0.24 * (markerIndex / Math.max(1, sortedMarkers.length)),
        'analyzing',
      )
    }
    markerIndex++
    const entry = trackById.get(marker.trackId)!
    if (isSoundStopMarker(marker)) {
      soundStopCount++
      continue
    }
    if (entry.track.locked && !options.includeLockedTracks) {
      lockedMarkerCount++
      continue
    }
    const instrument = resolveInstrument(marker.soundId)
    if (!instrument) {
      unknownSounds.set(marker.soundId, (unknownSounds.get(marker.soundId) ?? 0) + 1)
      continue
    }
    if (instrumentLevel(instrument) > supportedLevel) {
      unavailableSounds.set(marker.soundId, (unavailableSounds.get(marker.soundId) ?? 0) + 1)
      continue
    }
    if (marker.volumeCurve) volumeAutomationCount++
    if (marker.variantIndex >= 0) fixedVariantCount++
    if (marker.volume !== 1 || (marker.pan !== undefined && marker.pan !== 0)
      || entry.track.gainDb !== 0 || entry.track.pan !== 0) dynamicMixCount++
    const duration = Math.max(0, marker.duration ?? 0)
    const interval = marker.retriggerInterval && marker.retriggerInterval > 0
      ? marker.retriggerInterval
      : DEFAULT_RETRIGGER_INTERVAL
    const firingCount = duration > 0 ? Math.floor(duration / interval) + 1 : 1
    if (candidates.length + firingCount > NOTE_BLOCK_BUILD_LIMITS.maxNoteInstances) {
      throw new Error(`Expanded note count exceeds ${NOTE_BLOCK_BUILD_LIMITS.maxNoteInstances}`)
    }
    for (let firingIndex = 0; firingIndex < firingCount; firingIndex++) {
      if ((firingIndex & 0x7ff) === 0) {
        generationCheckpoint(
          progressContext,
          0.1 + 0.24 * ((markerIndex - 1 + firingIndex / Math.max(1, firingCount))
            / Math.max(1, sortedMarkers.length)),
          'analyzing',
        )
      }
      const offset = duration > 0 ? firingIndex * interval : 0
      const pitch = sampleCurve(marker.pitchCurve, offset, marker.pitch)
      if (pitch < 0.5 || pitch > 2) pitchClampedCount++
      const exactNote = 12 + 12 * Math.log2(pitch)
      const note = Math.max(0, Math.min(24, Math.round(exactNote)))
      if (Math.abs(exactNote - note) > 1e-6) pitchQuantizedCount++
      candidates.push({
        marker,
        trackIndex: entry.index,
        tick: marker.tick + offset,
        firingIndex,
        instrument,
        note,
      })
    }
  }
  const voices = new Map<string, number>()
  const notes = candidates.map((candidate) => {
    const key = `${candidate.trackIndex}:${candidate.tick}`
    const voice = voices.get(key) ?? 0
    voices.set(key, voice + 1)
    return { ...candidate, voice }
  })
  const warnings: string[] = []
  if (capabilities.era === 'unknown') {
    warnings.push('Minecraft target version is unknown; conservative instrument availability was used.')
  }
  if (lockedMarkerCount) {
    warnings.push(`${lockedMarkerCount} marker(s) on locked tracks were excluded.`)
  }
  if (soundStopCount) {
    warnings.push(`${soundStopCount} Sound Stopper marker(s) cannot be represented by a physical note-block build and were omitted.`)
  }
  if (volumeAutomationCount) {
    warnings.push(`${volumeAutomationCount} marker(s) use volume automation that physical note blocks cannot store.`)
  }
  if (fixedVariantCount) {
    warnings.push(`${fixedVariantCount} marker(s) pin a sound variant that physical note blocks cannot select.`)
  }
  for (const [soundId, count] of [...unknownSounds].sort(([left], [right]) => compareText(left, right))) {
    warnings.push(`${count} marker(s) use unknown note-block sound "${soundId}" and were omitted.`)
  }
  for (const [soundId, count] of [...unavailableSounds].sort(([left], [right]) => compareText(left, right))) {
    warnings.push(`${count} marker(s) use "${soundId}", which is unavailable for the target version, and were omitted.`)
  }
  if (pitchQuantizedCount) warnings.push(`${pitchQuantizedCount} pitch value(s) were quantized to note-block semitones.`)
  if (pitchClampedCount) {
    warnings.push(`${pitchClampedCount} DAW pitch value(s) outside the physical note-block 0.5..2 range were clamped.`)
  }
  if (dynamicMixCount) {
    warnings.push(`${dynamicMixCount} marker(s) use gain or pan settings that physical note blocks cannot store.`)
  }
  return { notes, warnings }
}

function createDisplayBuildModel(
  project: TimelineState,
  options: NoteBlockBuildOptions,
  capabilities: VersionCapabilities,
  progressContext?: GenerationProgressContext,
): BuildModel {
  const collected = collectBuildNotes(project, options, capabilities, progressContext)
  if (collected.notes.length === 0) {
    throw new Error(['No compatible note blocks remain to export.', ...collected.warnings].join(' '))
  }
  const groupCounts = new Map<string, number>()
  let groupNoteIndex = 0
  for (const note of collected.notes) {
    if ((groupNoteIndex & 0x3ff) === 0) {
      generationCheckpoint(
        progressContext,
        0.36 + 0.08 * (groupNoteIndex / Math.max(1, collected.notes.length)),
        'building-model',
      )
    }
    groupNoteIndex++
    const key = `${note.trackIndex}:${note.tick}`
    groupCounts.set(key, Math.max(groupCounts.get(key) ?? 0, note.voice + 1))
  }
  const maxVoices = Math.max(1, ...groupCounts.values())
  const laneStride = maxVoices + 1
  const rowStride = project.tracks.length * laneStride + 1
  const blocks: BuildBlock[] = []
  const noteBlocks: BuildBlock[] = []
  let displayBlockIndex = 0
  for (const note of collected.notes) {
    if ((displayBlockIndex & 0x3ff) === 0) {
      generationCheckpoint(
        progressContext,
        0.46 + 0.18 * (displayBlockIndex / Math.max(1, collected.notes.length)),
        'building-model',
      )
    }
    displayBlockIndex++
    let x: number
    let z: number
    if (options.layout === 'fixed-tracks') {
      x = note.tick
      z = note.trackIndex * laneStride + note.voice
    }
    else {
      const row = Math.floor(note.tick / options.notesPerRow)
      const offset = note.tick % options.notesPerRow
      x = row % 2 === 0 ? offset : options.notesPerRow - 1 - offset
      z = row * rowStride + note.trackIndex * laneStride + note.voice
    }
    const support: BuildBlock = {
      x,
      y: 0,
      z,
      state: {
        name: note.instrument.modernSupportBlock,
        ...(note.instrument.modernSupportBlock === 'minecraft:bone_block'
          ? { properties: { axis: 'y' } }
          : {}),
      },
      legacyId: note.instrument.legacySupportBlock,
      legacyData: 0,
    }
    const noteBlock: BuildBlock = {
      x,
      y: 1,
      z,
      state: {
        name: 'minecraft:note_block',
        properties: {
          instrument: note.instrument.instrument,
          note: String(note.note),
          powered: 'false',
        },
      },
      legacyId: 25,
      legacyData: 0,
      note: note.note,
      instrument: note.instrument.instrument,
    }
    blocks.push(support, noteBlock)
    noteBlocks.push(noteBlock)
  }
  if (blocks.length > NOTE_BLOCK_BUILD_LIMITS.maxBlocks) {
    throw new Error(`Block count exceeds ${NOTE_BLOCK_BUILD_LIMITS.maxBlocks}`)
  }
  const dimensions = blocks.reduce<NoteBlockBuildDimensions>((size, block) => ({
    x: Math.max(size.x, block.x + 1),
    y: Math.max(size.y, block.y + 1),
    z: Math.max(size.z, block.z + 1),
  }), { x: 0, y: 0, z: 0 })
  if (dimensions.x > NOTE_BLOCK_BUILD_LIMITS.maxHorizontalDimension
    || dimensions.z > NOTE_BLOCK_BUILD_LIMITS.maxHorizontalDimension
    || dimensions.y > NOTE_BLOCK_BUILD_LIMITS.maxHeight) {
    throw new Error(
      `Build dimensions ${dimensions.x}x${dimensions.y}x${dimensions.z} exceed `
      + `${NOTE_BLOCK_BUILD_LIMITS.maxHorizontalDimension}x${NOTE_BLOCK_BUILD_LIMITS.maxHeight}`
      + `x${NOTE_BLOCK_BUILD_LIMITS.maxHorizontalDimension}`,
    )
  }
  if (options.format === 'structure-block-nbt'
    && (dimensions.x > 32 || dimensions.y > 32 || dimensions.z > 32)) {
    collected.warnings.push(
      'Structure Block NBT caps only its size header at 32 blocks per axis; '
      + 'out-of-header block positions are retained for OpenNBS compatibility and may be ignored by vanilla loading.',
    )
  }
  if (options.layout === 'fixed-tracks') {
    collected.warnings.push('Fixed track lanes place absolute 20 TPS ticks along X; they do not synthesize redstone timing circuitry.')
  }
  else {
    collected.warnings.push('Schematic grid wraps fixed 20 TPS ticks into rows; it does not synthesize redstone timing circuitry.')
  }
  if (options.format === 'litematica-compatible-nbt') {
    collected.warnings.push('This is exact-size vanilla Structure NBT (.nbt) for Litematica import, not native .litematic data.')
  }
  return { dimensions, blocks, noteBlocks, warnings: collected.warnings }
}

interface PhysicalBuildNote extends BuildNote {
  step: number
  slot: number
}

interface RedstoneDelayNode {
  delay: 1 | 2 | 3 | 4
  notes: PhysicalBuildNote[]
}

interface CircuitCell {
  state: BuildBlockState
  note?: number
  instrument?: string
}

class CircuitGrid {
  readonly cells = new Map<string, CircuitCell>()

  constructor(
    readonly length: number,
    readonly width: number,
    readonly height: number,
  ) {}

  set(x: number, y: number, z: number, cell: CircuitCell): void {
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)
      || x < 0 || y < 0 || z < 0
      || x >= this.length || y >= this.width || z >= this.height) {
      throw new Error(`Playable circuit attempted to place an out-of-bounds block at ${x},${y},${z}`)
    }
    this.cells.set(`${x}:${y}:${z}`, cell)
  }
}

const CIRCUIT_SOLID: BuildBlockState = Object.freeze({ name: 'minecraft:stone' })
const CIRCUIT_BLUE_WOOL: BuildBlockState = Object.freeze({ name: 'minecraft:blue_wool' })
const CIRCUIT_AIR: BuildBlockState = Object.freeze({ name: 'minecraft:air' })

function circuitWireState(): BuildBlockState {
  // OpenNBS writes this connected state and lets Minecraft recalculate it when
  // the structure receives its first block updates.
  return {
    name: 'minecraft:redstone_wire',
    properties: {
      east: 'side',
      north: 'side',
      power: '0',
      south: 'side',
      west: 'side',
    },
  }
}

function circuitRepeaterState(delay: 1 | 2 | 3 | 4, direction: 1 | -1): BuildBlockState {
  return {
    name: 'minecraft:repeater',
    properties: {
      delay: String(delay),
      // This mirrors OpenNBS's data 3 / data 1 palette mapping after its
      // internal-to-Structure coordinate transform.
      facing: direction === 1 ? 'east' : 'west',
      locked: 'false',
      powered: 'false',
    },
  }
}

function circuitWallTorchState(facing: 'east' | 'west', lit: boolean): BuildBlockState {
  return {
    name: 'minecraft:redstone_wall_torch',
    properties: { facing, lit: String(lit) },
  }
}

const CIRCUIT_BUTTON: BuildBlockState = Object.freeze({
  name: 'minecraft:stone_button',
  properties: { face: 'wall', facing: 'south', powered: 'false' },
})

function putCircuitSolid(grid: CircuitGrid, x: number, y: number, z: number): void {
  grid.set(x, y, z, { state: CIRCUIT_SOLID })
}

function putCircuitWire(grid: CircuitGrid, x: number, y: number, z: number): void {
  grid.set(x, y, z, { state: circuitWireState() })
}

function putCircuitRepeater(
  grid: CircuitGrid,
  x: number,
  y: number,
  z: number,
  delay: 1 | 2 | 3 | 4,
  direction: 1 | -1,
): void {
  grid.set(x, y, z, { state: circuitRepeaterState(delay, direction) })
}

/**
 * Ports OpenNBS schematic_export.gml lines 140-203: button controls plus a
 * delay-equalized vertical fan-out, with decorative signs/walkways omitted.
 */
function placeOpenNbsStartSpine(grid: CircuitGrid, layers: number): void {
  const center = Math.round(grid.width / 2)
  putCircuitSolid(grid, 1, center, grid.height - 2)
  putCircuitSolid(grid, 1, center + 1, grid.height - 2)
  grid.set(1, center, grid.height - 1, { state: CIRCUIT_BLUE_WOOL })
  grid.set(1, center + 1, grid.height - 1, { state: CIRCUIT_BLUE_WOOL })
  grid.set(2, center + 1, grid.height - 1, { state: CIRCUIT_BUTTON })

  putCircuitSolid(grid, 0, center + 1, grid.height - 2)
  putCircuitWire(grid, 0, center + 1, grid.height - 1)
  putCircuitSolid(grid, 0, center, grid.height - 2)
  putCircuitWire(grid, 0, center, grid.height - 1)
  putCircuitSolid(grid, 0, center - 1, grid.height - 2)
  putCircuitWire(grid, 0, center - 1, grid.height - 1)
  grid.set(0, center - 2, grid.height - 2, {
    state: circuitWallTorchState('east', true),
  })
  putCircuitSolid(grid, 0, center - 2, grid.height - 4)
  putCircuitWire(grid, 0, center - 2, grid.height - 3)
  grid.set(0, center - 3, grid.height - 4, {
    state: circuitWallTorchState('east', false),
  })

  let stagger = 0
  for (let layer = layers - 1; layer >= 0; layer--) {
    if (layer > 0) {
      grid.set(0, center - 1 - stagger, layer * 3 + 1, {
        state: circuitWallTorchState('west', true),
      })
      putCircuitSolid(grid, 0, center - 1, layer * 3 - 1 + stagger)
      putCircuitWire(grid, 0, center - 1, layer * 3 + stagger)
      grid.set(0, center - 2, layer * 3 - 1 + stagger, {
        state: circuitWallTorchState('east', false),
      })
    }
    let dustRun = 0
    let equalizingDelay = layer * 2
    for (let y = center - 2 - stagger; y >= 0; y--) {
      putCircuitSolid(grid, 0, y, layer * 3 + 1)
      putCircuitWire(grid, 0, y, layer * 3 + 2)
      dustRun++
      if (equalizingDelay > 0 && y < center - 3 - stagger) {
        const delay = Math.min(4, equalizingDelay) as 1 | 2 | 3 | 4
        putCircuitRepeater(grid, 0, y, layer * 3 + 2, delay, -1)
        equalizingDelay -= 4
        dustRun = 0
      }
      if (dustRun === 16 || y === 1) {
        putCircuitRepeater(grid, 0, y, layer * 3 + 2, 1, -1)
        dustRun = 0
      }
    }
    for (let x = 0; x < 4; x++) {
      putCircuitWire(grid, x, 0, layer * 3 + 2)
      putCircuitSolid(grid, x, 0, layer * 3 + 1)
    }
    stagger = stagger ? 0 : 1
  }
}

function placePhysicalNote(
  grid: CircuitGrid,
  x: number,
  y: number,
  z: number,
  note: PhysicalBuildNote,
): void {
  grid.set(x, y, z - 1, {
    state: {
      name: note.instrument.modernSupportBlock,
      ...(note.instrument.modernSupportBlock === 'minecraft:bone_block'
        ? { properties: { axis: 'y' } }
        : {}),
    },
  })
  grid.set(x, y, z, {
    state: {
      name: 'minecraft:note_block',
      properties: {
        instrument: note.instrument.instrument,
        note: String(note.note),
        powered: 'false',
      },
    },
    note: note.note,
    instrument: note.instrument.instrument,
  })
}

function placeOpenNbsDelayNode(
  grid: CircuitGrid,
  x: number,
  y: number,
  direction: 1 | -1,
  layers: number,
  node: RedstoneDelayNode,
): void {
  const bySlot = new Map(node.notes.map(note => [note.slot, note]))
  for (let layer = 0; layer < layers; layer++) {
    const z = layer * 3
    putCircuitRepeater(grid, x, y, z + 2, node.delay, direction)
    putCircuitSolid(grid, x, y, z + 1)
    putCircuitSolid(grid, x, y + direction, z + 2)
    if (layer > 0) {
      putCircuitSolid(grid, x, y, z)
      putCircuitSolid(grid, x, y + direction, z)
    }
    putCircuitSolid(grid, x, y + direction * 2, z + 1)
    const layerNotes = [0, 1, 2, 3].map(branch => bySlot.get(layer * 4 + branch))
    if (layerNotes.some(Boolean)) putCircuitWire(grid, x, y + direction, z + 1)
    if (layerNotes[0]) placePhysicalNote(grid, x - 1, y + direction * 2, z + 1, layerNotes[0])
    if (layerNotes[1]) placePhysicalNote(grid, x + 1, y + direction * 2, z + 1, layerNotes[1])
    if (layerNotes[2]) placePhysicalNote(grid, x - 1, y + direction, z + 2, layerNotes[2])
    if (layerNotes[3]) placePhysicalNote(grid, x + 1, y + direction, z + 2, layerNotes[3])
  }
}

/** Ports the row connector at schematic_export.gml lines 346-365. */
function placeOpenNbsRowTurn(
  grid: CircuitGrid,
  x: number,
  y: number,
  direction: 1 | -1,
  layers: number,
): void {
  for (let layer = 0; layer < layers; layer++) {
    const z = layer * 3
    putCircuitWire(grid, x, y, z + 1)
    if (layer > 0 && layer < layers - 1) {
      // OpenNBS uses layer*4 here; layer*3 keeps the layer stack bounded and
      // electrically aligned with the rest of its three-block pitch.
      putCircuitSolid(grid, x, y, z)
    }
    putCircuitWire(grid, x, y + direction, z + 2)
    putCircuitSolid(grid, x, y + direction, z + 1)
    for (let offset = 0; offset < 4; offset++) {
      putCircuitWire(grid, x + offset, y + direction * 2, z + 2)
      putCircuitSolid(grid, x + offset, y + direction * 2, z + 1)
    }
  }
}

function allocatePhysicalNotes(notes: BuildNote[], trackCount: number): {
  notes: PhysicalBuildNote[]
  quantizedNoteCount: number
  collapsedRetriggerCount: number
  trackSlotCount: number
} {
  let quantizedNoteCount = 0
  let collapsedRetriggerCount = 0
  const seenFiringStep = new Set<string>()
  const quantized: Array<BuildNote & { step: number }> = []
  for (const note of notes) {
    const step = Math.round(note.tick / 2)
    if (step * 2 !== note.tick) quantizedNoteCount++
    const firingKey = `${note.marker.id}\0${step}`
    if (seenFiringStep.has(firingKey)) {
      collapsedRetriggerCount++
      continue
    }
    seenFiringStep.add(firingKey)
    quantized.push({ ...note, step })
  }
  quantized.sort((left, right) => (
    left.step - right.step || left.trackIndex - right.trackIndex
    || compareText(left.marker.id, right.marker.id) || left.firingIndex - right.firingIndex
  ))
  const groups = new Map<string, Array<BuildNote & { step: number }>>()
  for (const note of quantized) {
    const key = `${note.trackIndex}:${note.step}`
    const group = groups.get(key) ?? []
    group.push(note)
    groups.set(key, group)
  }
  const trackWidths = Array.from({ length: trackCount }, () => 1)
  for (const group of groups.values()) {
    const trackIndex = group[0].trackIndex
    trackWidths[trackIndex] = Math.max(trackWidths[trackIndex], group.length)
  }
  const trackOffsets: number[] = []
  let trackSlotCount = 0
  for (const width of trackWidths) {
    trackOffsets.push(trackSlotCount)
    trackSlotCount += width
  }
  const physical: PhysicalBuildNote[] = []
  for (const group of groups.values()) {
    group.forEach((note, voice) => physical.push({
      ...note,
      slot: trackOffsets[note.trackIndex] + voice,
    }))
  }
  physical.sort((left, right) => (
    left.step - right.step || left.slot - right.slot
    || compareText(left.marker.id, right.marker.id) || left.firingIndex - right.firingIndex
  ))
  return { notes: physical, quantizedNoteCount, collapsedRetriggerCount, trackSlotCount }
}

function createDelayNodes(notes: PhysicalBuildNote[]): RedstoneDelayNode[] {
  const notesByStep = new Map<number, PhysicalBuildNote[]>()
  for (const note of notes) {
    const group = notesByStep.get(note.step) ?? []
    group.push(note)
    notesByStep.set(note.step, group)
  }
  const nodes: RedstoneDelayNode[] = []
  let cursor = -1
  for (const step of [...notesByStep.keys()].sort((left, right) => left - right)) {
    let gap = step - cursor
    while (gap > 4) {
      nodes.push({ delay: 4, notes: [] })
      cursor += 4
      gap -= 4
    }
    nodes.push({ delay: gap as 1 | 2 | 3 | 4, notes: notesByStep.get(step)! })
    cursor = step
  }
  return nodes
}

function createPlayableBuildModel(
  project: TimelineState,
  options: NoteBlockBuildOptions,
  capabilities: VersionCapabilities,
  progressContext?: GenerationProgressContext,
): BuildModel {
  if (options.format !== 'structure-block-nbt' && options.format !== 'litematica-compatible-nbt') {
    throw new Error('Playable redstone requires a modern Structure .nbt format')
  }
  if (options.layout !== 'fixed-tracks') {
    throw new Error('Playable redstone currently supports only the fixed-tracks layout')
  }
  const collected = collectBuildNotes(project, options, capabilities, progressContext)
  if (collected.notes.length === 0) {
    throw new Error(['No compatible note blocks remain to export.', ...collected.warnings].join(' '))
  }
  const allocated = allocatePhysicalNotes(collected.notes, project.tracks.length)
  const nodes = createDelayNodes(allocated.notes)
  const layers = Math.ceil(allocated.trackSlotCount / 4)
  const length = 2 + Math.ceil(nodes.length / options.notesPerRow) * 3
  const width = options.notesPerRow * 2 + 3
  const height = 4 + layers * 3
  const dimensions: NoteBlockBuildDimensions = { x: width, y: height, z: length }
  const startSpineCenter = Math.round(width / 2)
  // The source circuit spends two redstone ticks per vertical layer and has
  // finite horizontal room for its delay-equalizing repeaters. Positions 0
  // and 1 are later occupied by the output bus, so they cannot carry that
  // compensation safely.
  const maxSynchronizedLayers = Math.max(1, (startSpineCenter - 5) * 2 + 1)
  if (layers > maxSynchronizedLayers) {
    throw new Error(
      `${options.notesPerRow} delay nodes per row synchronize at most `
      + `${maxSynchronizedLayers * 4} fixed slots; this build needs ${allocated.trackSlotCount}. `
      + 'Increase delay nodes per row.',
    )
  }
  if (dimensions.x > NOTE_BLOCK_BUILD_LIMITS.maxHorizontalDimension
    || dimensions.z > NOTE_BLOCK_BUILD_LIMITS.maxHorizontalDimension
    || dimensions.y > NOTE_BLOCK_BUILD_LIMITS.maxHeight) {
    throw new Error(
      `Playable build dimensions ${dimensions.x}x${dimensions.y}x${dimensions.z} exceed `
      + `${NOTE_BLOCK_BUILD_LIMITS.maxHorizontalDimension}x${NOTE_BLOCK_BUILD_LIMITS.maxHeight}`
      + `x${NOTE_BLOCK_BUILD_LIMITS.maxHorizontalDimension}`,
    )
  }
  if (options.format === 'structure-block-nbt'
    && (dimensions.x > 32 || dimensions.y > 32 || dimensions.z > 32)) {
    throw new Error(
      `Playable Structure Block NBT must fit within 32x32x32; got `
      + `${dimensions.x}x${dimensions.y}x${dimensions.z}. Use exact-size Structure NBT instead.`,
    )
  }
  const volume = dimensions.x * dimensions.y * dimensions.z
  if (!Number.isSafeInteger(volume) || volume > NOTE_BLOCK_BUILD_LIMITS.maxBlocks) {
    throw new Error(
      `Playable build clearing volume ${volume} exceeds ${NOTE_BLOCK_BUILD_LIMITS.maxBlocks} blocks`,
    )
  }

  const grid = new CircuitGrid(length, width, height)
  generationCheckpoint(progressContext, 0.4, 'building-model')
  for (let x = 0; x < length; x++) {
    for (let y = 0; y < width; y++) putCircuitSolid(grid, x, y, 0)
  }
  placeOpenNbsStartSpine(grid, layers)

  let x = 3
  let y = 0
  let direction: 1 | -1 = 1
  nodes.forEach((node, index) => {
    if ((index & 0xff) === 0) {
      generationCheckpoint(
        progressContext,
        0.43 + 0.13 * (index / Math.max(1, nodes.length)),
        'building-model',
      )
    }
    const nodeY = y + direction
    placeOpenNbsDelayNode(grid, x, nodeY, direction, layers, node)
    y += direction * 2
    const shouldTurn = index < nodes.length - 1
      && (direction === 1 ? y >= width - 3 : y <= 2)
    if (shouldTurn) {
      placeOpenNbsRowTurn(grid, x, y, direction, layers)
      y += direction * 2
      direction = direction === 1 ? -1 : 1
      x += 3
    }
  })

  const byPosition = new Map<string, BuildBlock>()
  const noteBlocks: BuildBlock[] = []
  for (const [key, cell] of grid.cells) {
    const [internalX, internalY, internalZ] = key.split(':').map(Number)
    const block: BuildBlock = {
      x: width - 1 - internalY,
      y: internalZ,
      z: internalX,
      state: cell.state,
      legacyId: 0,
      legacyData: 0,
      ...(cell.note === undefined ? {} : { note: cell.note, instrument: cell.instrument }),
    }
    byPosition.set(`${block.x}:${block.y}:${block.z}`, block)
    if (cell.note !== undefined) noteBlocks.push(block)
  }
  for (let outputY = 0; outputY < height; outputY++) {
    generationCheckpoint(
      progressContext,
      0.58 + 0.08 * (outputY / Math.max(1, height)),
      'building-model',
    )
    for (let outputZ = 0; outputZ < length; outputZ++) {
      for (let outputX = 0; outputX < width; outputX++) {
        const key = `${outputX}:${outputY}:${outputZ}`
        if (!byPosition.has(key)) {
          byPosition.set(key, {
            x: outputX,
            y: outputY,
            z: outputZ,
            state: CIRCUIT_AIR,
            legacyId: 0,
            legacyData: 0,
          })
        }
      }
    }
  }
  const warnings = collected.warnings
  warnings.push(
    'Playable redstone uses a reliable two-game-tick timing grid (10 steps/second) and starts two ticks after the button press.',
    'Tempo and meter metadata are not embedded; absolute Knead 20 TPS marker positions drive the circuit.',
  )
  if (allocated.quantizedNoteCount) {
    warnings.push(`${allocated.quantizedNoteCount} note onset(s) were quantized to the two-tick redstone grid.`)
  }
  if (allocated.collapsedRetriggerCount) {
    warnings.push(
      `${allocated.collapsedRetriggerCount} retrigger firing(s) from the same marker collapsed onto an existing redstone step.`,
    )
  }
  if (project.settings.loop.enabled) {
    warnings.push('The project loop is not synthesized by fixed-tracks playable redstone; this build plays one pass.')
  }
  if (options.format === 'litematica-compatible-nbt') {
    warnings.push('This is exact-size vanilla Structure NBT (.nbt) for Litematica import, not native .litematic data.')
  }
  return {
    dimensions,
    blocks: [...byPosition.values()],
    noteBlocks,
    warnings,
    timing: {
      quantumTicks: 2,
      startLatencyTicks: 2,
      delayNodeCount: nodes.length,
      quantizedNoteCount: allocated.quantizedNoteCount,
      collapsedRetriggerCount: allocated.collapsedRetriggerCount,
      trackSlotCount: allocated.trackSlotCount,
    },
  }
}

function intList(values: readonly number[]): NbtTag {
  return nbtList('int', values.map(nbtInt))
}

function blockStateKey(state: BuildBlockState): string {
  const properties = Object.entries(state.properties ?? {}).sort(([left], [right]) => compareText(left, right))
  return `${state.name}\0${properties.map(([name, value]) => `${name}=${value}`).join('\0')}`
}

function blockStateTag(state: BuildBlockState): NbtTag {
  const properties = Object.entries(state.properties ?? {}).sort(([left], [right]) => compareText(left, right))
  const entries: NbtNamedTag[] = [{ name: 'Name', tag: nbtString(state.name) }]
  if (properties.length) {
    entries.push({
      name: 'Properties',
      tag: nbtCompound(properties.map(([name, value]) => ({ name, tag: nbtString(value) }))),
    })
  }
  return nbtCompound(entries)
}

function sortedBlocks(blocks: readonly BuildBlock[]): BuildBlock[] {
  return [...blocks].sort((left, right) => (
    left.y - right.y || left.z - right.z || left.x - right.x
    || compareText(blockStateKey(left.state), blockStateKey(right.state))
  ))
}

function writeModernStructure(model: BuildModel, capSizeHeader: boolean): Uint8Array {
  const blocks = sortedBlocks(model.blocks)
  const statesByKey = new Map<string, BuildBlockState>()
  for (const block of blocks) statesByKey.set(blockStateKey(block.state), block.state)
  const palette = [...statesByKey.entries()].sort(([left], [right]) => compareText(left, right))
  const paletteIndex = new Map(palette.map(([key], index) => [key, index]))
  // OpenNBS format 0 caps only the declared header while still serializing all
  // block positions. Format 1 declares the exact dimensions for Litematica import.
  const root = nbtCompound([
    { name: 'DataVersion', tag: nbtInt(1519) },
    {
      name: 'size',
      tag: intList([
        capSizeHeader ? Math.min(model.dimensions.x, 32) : model.dimensions.x,
        capSizeHeader ? Math.min(model.dimensions.y, 32) : model.dimensions.y,
        capSizeHeader ? Math.min(model.dimensions.z, 32) : model.dimensions.z,
      ]),
    },
    { name: 'palette', tag: nbtList('compound', palette.map(([, state]) => blockStateTag(state))) },
    {
      name: 'blocks',
      tag: nbtList('compound', blocks.map(block => nbtCompound([
        { name: 'pos', tag: intList([block.x, block.y, block.z]) },
        { name: 'state', tag: nbtInt(paletteIndex.get(blockStateKey(block.state))!) },
      ]))),
    },
    { name: 'entities', tag: nbtList('compound', []) },
  ])
  return writeNbt('', root, NOTE_BLOCK_BUILD_LIMITS.maxNbtBytes)
}

function legacyIndex(block: BuildBlock, dimensions: NoteBlockBuildDimensions): number {
  return block.y * dimensions.z * dimensions.x + block.z * dimensions.x + block.x
}

function writeLegacySchematic(model: BuildModel, pre111: boolean): Uint8Array {
  const volume = model.dimensions.x * model.dimensions.y * model.dimensions.z
  if (!Number.isSafeInteger(volume) || volume > NOTE_BLOCK_BUILD_LIMITS.maxLegacyVolume) {
    throw new Error(`Legacy schematic volume exceeds ${NOTE_BLOCK_BUILD_LIMITS.maxLegacyVolume} cells`)
  }
  const blocks = new Uint8Array(volume)
  const data = new Uint8Array(volume)
  for (const block of model.blocks) {
    const index = legacyIndex(block, model.dimensions)
    blocks[index] = block.legacyId
    data[index] = block.legacyData
  }
  const tileEntities = sortedBlocks(model.noteBlocks).map(block => nbtCompound([
    { name: 'id', tag: nbtString(pre111 ? 'Music' : 'minecraft:noteblock') },
    { name: 'x', tag: nbtInt(block.x) },
    { name: 'y', tag: nbtInt(block.y) },
    { name: 'z', tag: nbtInt(block.z) },
    { name: 'note', tag: nbtByte(block.note!) },
  ]))
  const versionEntries: NbtNamedTag[] = pre111
    ? [
        { name: 'Name', tag: nbtString('1.8') },
        { name: 'Snapshot', tag: nbtByte(0) },
      ]
    : [
        { name: 'Id', tag: nbtInt(922) },
        { name: 'Name', tag: nbtString('1.11.2') },
        { name: 'Snapshot', tag: nbtByte(0) },
      ]
  return writeNbt('Schematic', nbtCompound([
    { name: 'Height', tag: nbtShort(model.dimensions.y) },
    { name: 'Length', tag: nbtShort(model.dimensions.z) },
    { name: 'Width', tag: nbtShort(model.dimensions.x) },
    { name: 'Entities', tag: nbtList('compound', []) },
    { name: 'TileEntities', tag: nbtList('compound', tileEntities) },
    { name: 'Materials', tag: nbtString('Alpha') },
    { name: 'Blocks', tag: nbtByteArray(blocks) },
    { name: 'Data', tag: nbtByteArray(data) },
    { name: 'Version', tag: nbtCompound(versionEntries) },
  ]), NOTE_BLOCK_BUILD_LIMITS.maxNbtBytes)
}

export function exportNoteBlockBuild(
  project: TimelineState,
  overrides: Partial<NoteBlockBuildOptions> = {},
  progressContext?: GenerationProgressContext,
): NoteBlockBuildResult {
  generationCheckpoint(progressContext, 0.02, 'preparing')
  const options: NoteBlockBuildOptions = {
    ...DEFAULT_NOTE_BLOCK_BUILD_OPTIONS,
    ...overrides,
  }
  validateProject(project, options)
  generationCheckpoint(progressContext, 0.08, 'analyzing')
  if (options.circuit === 'playable-redstone') {
    if (options.format !== 'structure-block-nbt' && options.format !== 'litematica-compatible-nbt') {
      throw new Error('Playable redstone requires a modern Structure .nbt format')
    }
    if (options.layout !== 'fixed-tracks') {
      throw new Error('Playable redstone currently supports only the fixed-tracks layout')
    }
  }
  const targetVersion = options.targetVersion?.trim() || project.targetVersion.trim()
  const targetError = validateNoteBlockBuildTarget(options.format, targetVersion)
  if (targetError) throw new Error(targetError)
  const capabilities = classifyTargetVersion(targetVersion)
  const model = options.circuit === 'playable-redstone'
    ? createPlayableBuildModel(project, options, capabilities, progressContext)
    : createDisplayBuildModel(project, options, capabilities, progressContext)
  generationCheckpoint(progressContext, 0.7, 'writing-files')
  const nbt = options.format === 'structure-block-nbt'
    || options.format === 'litematica-compatible-nbt'
    ? writeModernStructure(model, options.format === 'structure-block-nbt')
    : writeLegacySchematic(model, options.format === 'schematic-pre-1.11')
  generationCheckpoint(progressContext, 0.88, 'compressing')
  const data = gzipDeterministic(nbt, NOTE_BLOCK_BUILD_LIMITS.maxGzipBytes)
  generationCheckpoint(progressContext, 0.98, 'serializing')
  generationCheckpoint(progressContext, 1, 'complete')
  return {
    data,
    extension: FORMAT_EXTENSIONS[options.format],
    format: options.format,
    dimensions: model.dimensions,
    blockCount: model.blocks.length,
    noteBlockCount: model.noteBlocks.length,
    warnings: model.warnings,
    circuit: options.circuit,
    ...(model.timing ? { timing: model.timing } : {}),
  }
}
