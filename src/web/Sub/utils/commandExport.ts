import type { Marker, TimelineState } from '../types/timeline'
import { MAX_SOUND_STOP_TRACK, MINECRAFT_TICKS_PER_SECOND, dbToGain, isTrackAudible } from '../types/timeline'
import { parseVersion } from '../../../types/VersionInfo'
import { sampleCurve } from './curveSampling'
import { generationCheckpoint, type GenerationProgressContext } from './generationProgress'
import { stableVariantIndex } from './studioMath'
import { buildTempoMap, tickRangeToSeconds } from './tempoMap'

export type CommandAudience = 'all' | 'nearby' | 'custom'

export const COMMAND_PAN_MODES = ['world', 'listener'] as const
export type CommandPanMode = typeof COMMAND_PAN_MODES[number]

export const COMMAND_LISTENER_PAN_LIMITS = Object.freeze({
  widthMin: 0.25,
  widthMax: 16,
})

export const COMMAND_VISUALIZER_TYPES = [
  'off', 'arc', 'fall', 'rise', 'bounce', 'pianoRoll', 'fountain', 'rittaiOnkyou',
] as const
export type CommandVisualizerType = typeof COMMAND_VISUALIZER_TYPES[number]

export const COMMAND_VISUALIZER_PLACEMENTS = ['north', 'south', 'east', 'west'] as const
export type CommandVisualizerPlacement = typeof COMMAND_VISUALIZER_PLACEMENTS[number]

export const COMMAND_VISUALIZER_COLOR_MAPPINGS = ['track', 'sound', 'pitch'] as const
export type CommandVisualizerColorMapping = typeof COMMAND_VISUALIZER_COLOR_MAPPINGS[number]

export const COMMAND_VISUALIZER_LIMITS = Object.freeze({
  densityMin: 1,
  densityMax: 8,
  scaleMin: 0.25,
  scaleMax: 4,
  pitchSemitones: 24,
  lifetimeTicks: 20,
})

export const MAX_COMMAND_EXPORT_EVENTS = 20_000
export const COMMAND_EXPORT_REPORT_SCHEMA_VERSION = 1
export const COMMAND_EXPORT_DIAGNOSTIC_MAX_IDS = 64

export interface CommandExportOptions {
  namespace: string
  description: string
  packFormat: number
  resourcePackFormat: number
  source: string
  target: string
  audience: CommandAudience
  nearbyRadius: number
  position: string
  panMode: CommandPanMode
  listenerPanWidth: number
  minVolume: number
  range: 'project' | 'loop'
  loopPlayback: boolean
  includeMutedTracks: boolean
  includeStopCommands: boolean
  visualizerType: CommandVisualizerType
  visualizerOrigin: string
  visualizerPlacement: CommandVisualizerPlacement
  visualizerGlow: boolean
  visualizerDensity: number
  visualizerScale: number
  visualizerColorMapping: CommandVisualizerColorMapping
}

export type CommandExportFilePayload = string | { encoding: 'base64', data: string }

export interface CommandCompanionResourcePack {
  files: Record<string, CommandExportFilePayload>
  namespace: string
  eventCount: number
  variantCount: number
  assetCount: number
  byteLength: number
}

export interface CommandExportResult {
  files: Record<string, string>
  eventCount: number
  skippedEventCount: number
  durationTicks: number
  installCommand: string
  startCommand: string
  pauseCommand: string
  resumeCommand: string
  stopCommand: string
  uninstallCommand: string
  warnings: CommandExportWarning[]
  diagnostics: CommandExportDiagnostic[]
  report: CommandExportReport
  /** Separate client-side pack; install it alongside the generated data pack. */
  resourcePack: CommandCompanionResourcePack | null
}

export type CommandExportDiagnosticSeverity = 'info' | 'warning' | 'error'
export type CommandExportDisposition = 'preserved' | 'baked' | 'degraded' | 'omitted'
export type CommandExportFeature =
  | 'timing'
  | 'panning'
  | 'variants'
  | 'automation'
  | 'gate-length'
  | 'audibility'
  | 'sound-stop'
  | 'reference-audio'
  | 'custom-audio'
  | 'limiter'
  | 'validation'
  | 'visualizer'
  | 'loop'
  | 'schedule'
  | 'event-budget'

export interface CommandExportDiagnostic {
  /** Stable machine-readable identifier. Never localized. */
  code: string
  severity: CommandExportDiagnosticSeverity
  disposition: CommandExportDisposition
  feature: CommandExportFeature
  /** Deterministic English explanation for tools that do not ship Knead locales. */
  message: string
  markerIds?: string[]
  markerIdCount?: number
  trackIds?: string[]
  trackIdCount?: number
}

export interface CommandExportReport {
  schemaVersion: typeof COMMAND_EXPORT_REPORT_SCHEMA_VERSION
  generator: 'Knead Studio'
  namespace: string
  targetVersion: string
  summary: {
    eventCount: number
    skippedEventCount: number
    durationTicks: number
  }
  diagnostics: CommandExportDiagnostic[]
}

export type CommandExportWarning =
  | 'pan'
  | 'legacyPan'
  | 'listenerPanOptionsClamped'
  | 'fixedVariant'
  | 'legacySchedule'
  | 'invalidSoundId'
  | 'invalidTarget'
  | 'invalidPosition'
  | 'invalidSource'
  | 'invalidLoopRange'
  | 'largeExport'
  | 'invalidVisualizerOrigin'
  | 'visualizerOptionsClamped'
  | 'legacyVisualizer'
  | 'soundStopRangeOverlap'

interface CommandEvent {
  tick: number
  projectTick: number
  trackIndex: number
  kind: 'play' | 'stop'
  command: string
  note?: CommandVisualizerNote
}

export interface CommandVisualizerNote {
  pitchSemitones: number
  volume: number
  pan: number
  trackIndex: number
  soundId: string
}

export interface CommandVisualizerEmission {
  offset: readonly [number, number, number]
  motion: readonly [number, number, number]
}

export interface CommandVisualizerContract {
  type: Exclude<CommandVisualizerType, 'off'>
  emit: (note: Readonly<CommandVisualizerNote>, scale: number) => CommandVisualizerEmission
}

const SOUND_SOURCES = new Set([
  'master', 'music', 'record', 'weather', 'block', 'hostile',
  'neutral', 'player', 'ambient', 'voice', 'ui',
])
const RESOURCE_LOCATION = /^(?:[a-z0-9_.-]+:)?[a-z0-9_.-]+(?:\/[a-z0-9_.-]+)*$/
const SAFE_PLAYER_TARGET = /^(?:@[apr](?:\[[^\s\r\n]*\])?|[A-Za-z0-9_]{1,16})$/
const COORDINATE = /^(?:[~^](?:-?(?:\d+(?:\.\d*)?|\.\d+))?|-?(?:\d+(?:\.\d*)?|\.\d+))$/
const DISPATCH_LEAF_SIZE = 8
const VISUALIZER_TYPES = new Set<string>(COMMAND_VISUALIZER_TYPES)
const VISUALIZER_PLACEMENTS = new Set<string>(COMMAND_VISUALIZER_PLACEMENTS)
const VISUALIZER_COLOR_MAPPINGS = new Set<string>(COMMAND_VISUALIZER_COLOR_MAPPINGS)
const VISUALIZER_BLOCKS = [
  'minecraft:white_concrete', 'minecraft:orange_concrete', 'minecraft:magenta_concrete',
  'minecraft:light_blue_concrete', 'minecraft:yellow_concrete', 'minecraft:lime_concrete',
  'minecraft:pink_concrete', 'minecraft:gray_concrete', 'minecraft:light_gray_concrete',
  'minecraft:cyan_concrete', 'minecraft:purple_concrete', 'minecraft:blue_concrete',
  'minecraft:brown_concrete', 'minecraft:green_concrete', 'minecraft:red_concrete',
  'minecraft:black_concrete',
] as const

function visualEmission(
  offset: readonly [number, number, number],
  motion: readonly [number, number, number],
  scale: number,
): CommandVisualizerEmission {
  return {
    offset: [offset[0] * scale, offset[1] * scale, offset[2] * scale],
    motion: [motion[0] * scale, motion[1] * scale, motion[2] * scale],
  }
}

function visualLane(note: Readonly<CommandVisualizerNote>): number {
  return Math.min(15, Math.max(0, note.trackIndex)) * 0.45
}

/**
 * Reusable, data-only visualizer geometry based on OpenNBS beta 5's seven
 * falling-block modes. Command encoding, selectors, and cleanup stay outside
 * the contracts so hosts cannot inject executable text through a mode.
 * Source: OpenNBS/NoteBlockStudio@abbf7d5, scripts/dat_generate/dat_generate.gml.
 */
export const COMMAND_VISUALIZER_CONTRACTS = Object.freeze({
  arc: {
    type: 'arc',
    emit: (note, scale) => visualEmission(
      [-note.pitchSemitones * 0.35, 0, visualLane(note)],
      [0, 0.55, 0.35],
      scale,
    ),
  },
  fall: {
    type: 'fall',
    emit: (note, scale) => visualEmission(
      [note.pitchSemitones * 0.35, 3, visualLane(note)],
      [0, -0.45, 0],
      scale,
    ),
  },
  rise: {
    type: 'rise',
    emit: (note, scale) => visualEmission(
      [note.pitchSemitones * 0.35, 0, visualLane(note)],
      [0, 0.45, 0],
      scale,
    ),
  },
  bounce: {
    type: 'bounce',
    emit: (note, scale) => visualEmission(
      [visualLane(note), 0, note.pitchSemitones * 0.2],
      [0, 0.6, 0],
      scale,
    ),
  },
  pianoRoll: {
    type: 'pianoRoll',
    emit: (note, scale) => visualEmission(
      [-note.pitchSemitones * 0.35, visualLane(note) * 0.15, 0],
      [0, 0, 0.55],
      scale,
    ),
  },
  fountain: {
    type: 'fountain',
    emit: (note, scale) => visualEmission(
      [visualLane(note), 0, 0],
      [note.pitchSemitones >= 0 ? 0.32 : -0.32, 0.62, 0],
      scale,
    ),
  },
  rittaiOnkyou: {
    type: 'rittaiOnkyou',
    emit: (note, scale) => visualEmission(
      [note.pan * 4, Math.min(1, Math.max(0, note.volume)) * 4, note.pitchSemitones * 0.12],
      [0, -0.22, 0.12],
      scale,
    ),
  },
} satisfies Readonly<Record<Exclude<CommandVisualizerType, 'off'>, CommandVisualizerContract>>)

export const DEFAULT_COMMAND_EXPORT_OPTIONS: CommandExportOptions = {
  namespace: 'knead_show',
  description: 'Knead Studio sound show',
  packFormat: 48,
  resourcePackFormat: 46,
  source: 'master',
  target: '@a',
  audience: 'all',
  nearbyRadius: 32,
  position: '~ ~ ~',
  panMode: 'world',
  listenerPanWidth: 2,
  minVolume: 0,
  range: 'project',
  loopPlayback: false,
  includeMutedTracks: false,
  includeStopCommands: true,
  visualizerType: 'off',
  visualizerOrigin: '~ ~4 ~',
  visualizerPlacement: 'north',
  visualizerGlow: false,
  visualizerDensity: 2,
  visualizerScale: 1,
  visualizerColorMapping: 'track',
}

export function sanitizeNamespace(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '_')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    .slice(0, 48) || 'knead_show'
  // Writing functions into the vanilla namespace is legal but dangerously easy
  // to confuse with Minecraft-owned resources.
  return sanitized === 'minecraft' ? 'knead_minecraft' : sanitized
}

export function inferPackFormat(version: string): number {
  const value = version.trim()
  const numberedSnapshot = /^26\.(\d+)-snapshot-(\d+)$/u.exec(value)
  if (numberedSnapshot) {
    const release = Number(numberedSnapshot[1])
    const number = Number(numberedSnapshot[2])
    const knownFormats: Readonly<Record<number, readonly number[]>> = {
      1: [95, 96, 97, 97.1, 98, 99, 99.1, 99.2, 99.2, 99.3, 100],
      2: [101.2, 101.2, 102, 103, 104, 105, 105.1, 106],
      3: [108, 109, 110, 111, 112, 113],
    }
    const known = knownFormats[release]?.[number - 1]
    if (known !== undefined) return known
    if (release >= 3) return 113
    if (release === 2) return 107.1
    return 101.1
  }
  const modern = /^26\.(\d+)/u.exec(value)
  if (modern) {
    const release = Number(modern[1])
    if (release >= 3) return 113
    if (release === 2) return 107.1
    return 101.1
  }
  const match = /^1\.(\d+)(?:\.(\d+))?/.exec(value)
  if (!match) return DEFAULT_COMMAND_EXPORT_OPTIONS.packFormat
  const minor = Number(match[1])
  const patch = Number(match[2] ?? 0)
  if (minor >= 22) return 101.1
  if (minor === 21) {
    if (patch >= 11) return 94.1
    if (patch >= 9) return 88
    if (patch >= 7) return 81
    if (patch >= 6) return 80
    if (patch >= 5) return 71
    if (patch >= 4) return 61
    if (patch >= 2) return 57
    return 48
  }
  if (minor === 20) {
    if (patch >= 5) return 41
    if (patch >= 3) return 26
    if (patch >= 2) return 18
    return 15
  }
  if (minor === 19) return patch >= 4 ? 12 : 10
  if (minor === 18) return patch >= 2 ? 9 : 8
  if (minor === 17) return 7
  if (minor === 16) return patch >= 2 ? 6 : 5
  if (minor === 15) return 5
  if (minor === 14) return 4
  if (minor === 13) return 4
  return 3
}

/**
 * Resource-pack formats are versioned independently from data packs. Values
 * follow Mojang's Java Edition technical changelogs; unknown releases fall
 * back conservatively instead of reusing the data-pack format.
 * Source: https://feedback.minecraft.net/hc/en-us/articles/39966147272589
 * (1.21.9 introduced minor pack formats and min_format/max_format.)
 */
export function inferResourcePackFormat(version: string): number {
  const value = version.trim()
  const snapshot = /^26\.(\d+)-snapshot-(\d+)$/u.exec(value)
  if (snapshot) {
    const release = Number(snapshot[1])
    const number = Number(snapshot[2])
    if (release >= 3) {
      if (number >= 6) return 94
      if (number === 5) return 93
      if (number >= 4) return 92
      if (number === 3) return 91
      if (number === 2) return 90
      return 89
    }
    if (release === 2) {
      if (number >= 7) return 87
      if (number >= 5) return 86.2
      if (number === 4) return 86.1
      if (number >= 3) return 86
      return 85
    }
    if (release === 1) {
      const known = [76, 77, 78, 78.1, 79, 80, 81, 81.1, 81.1, 82, 83][number - 1]
      return known ?? 84
    }
  }
  const modern = /^(\d+)\.(\d+)/u.exec(value)
  if (modern && Number(modern[1]) >= 26) {
    const release = Number(modern[2])
    if (release >= 3) return 94
    if (release === 2) return 88
    return 84
  }
  const match = /^1\.(\d+)(?:\.(\d+))?/u.exec(value)
  if (!match) return DEFAULT_COMMAND_EXPORT_OPTIONS.resourcePackFormat
  const minor = Number(match[1])
  const patch = Number(match[2] ?? 0)
  if (minor >= 22) return 75
  if (minor === 21) {
    if (patch >= 11) return 75
    if (patch >= 9) return 69
    if (patch >= 7) return 64
    if (patch >= 6) return 63
    if (patch >= 5) return 55
    if (patch >= 4) return 46
    if (patch >= 2) return 42
    return 34
  }
  if (minor === 20) {
    if (patch >= 5) return 32
    if (patch >= 3) return 22
    if (patch >= 2) return 18
    return 15
  }
  if (minor === 19) return patch >= 4 ? 13 : patch >= 3 ? 12 : 9
  if (minor === 18) return 8
  if (minor === 17) return 7
  if (minor === 16) return patch >= 2 ? 6 : 5
  if (minor === 15) return 5
  if (minor === 14 || minor === 13) return 4
  return 3
}

function packMetadata(description: string, packFormat: number, modernThreshold = 82): string {
  const safePackFormat = Number.isFinite(packFormat) ? Math.min(999, Math.max(1, packFormat)) : 48
  const normalized = Math.round(safePackFormat * 10) / 10
  const major = Math.floor(normalized)
  const minor = Math.round((normalized - major) * 10)
  const pack = major >= modernThreshold
    ? {
        description,
        min_format: [major, minor],
        max_format: [major, minor],
      }
    : { pack_format: major, description }
  return JSON.stringify({ pack }, null, 2) + '\n'
}

type CommandClockMode = 'unsupported' | 'tick-tag' | 'schedule-basic' | 'schedule-clear-replace'

function snapshotAtLeast(
  version: Extract<NonNullable<ReturnType<typeof parseVersion>>, { kind: 'snapshot' }>,
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

/** 1.21 / 24w21a renamed functions and tags/functions to their singular forms. */
function modernDirectoryLayout(version: string): boolean {
  const parsed = parseVersion(version.trim())
  if (!parsed) return true
  if (parsed.kind === 'snapshot') return snapshotAtLeast(parsed, 24, 21, 'a')
  return parsed.major > 1 || (parsed.major === 1 && parsed.minor >= 21)
}

/**
 * Mojang introduced /schedule in 18w43a (Java 1.14), then added `clear`
 * and the append/replace suffix in 19w38a (Java 1.15). Java 1.13 uses its
 * load/tick function tags instead of emitting commands that its parser lacks.
 */
function commandClockMode(version: string): CommandClockMode {
  const parsed = parseVersion(version.trim())
  if (!parsed) return 'schedule-clear-replace'
  if (parsed.kind === 'snapshot') {
    if (!snapshotAtLeast(parsed, 17, 43, 'a')) return 'unsupported'
    if (!snapshotAtLeast(parsed, 18, 43, 'a')) return 'tick-tag'
    if (!snapshotAtLeast(parsed, 19, 38, 'a')) return 'schedule-basic'
    return 'schedule-clear-replace'
  }
  if (parsed.major < 1 || (parsed.major === 1 && parsed.minor < 13)) return 'unsupported'
  if (parsed.major === 1 && parsed.minor === 13) return 'tick-tag'
  if (parsed.major === 1 && parsed.minor === 14) return 'schedule-basic'
  return 'schedule-clear-replace'
}

/**
 * Java Edition 1.13 introduced the modern execute chain and local `^ ^ ^`
 * coordinates used by listener-relative panning.
 * Source: https://www.minecraft.net/en-us/article/minecraft-snapshot-18w02a
 */
export function supportsListenerRelativePan(version: string): boolean {
  const parsed = parseVersion(version.trim())
  if (!parsed) return false
  if (parsed.kind === 'snapshot') {
    return parsed.year > 18
      || (parsed.year === 18 && (
        parsed.releaseNumber > 2
        || (parsed.releaseNumber === 2 && parsed.letter.localeCompare('a') >= 0)
      ))
  }
  return parsed.major > 1 || (parsed.major === 1 && parsed.minor >= 13)
}

function commandNumber(value: number): string {
  if (!Number.isFinite(value)) return '0'
  const rounded = Math.round(value * 10000) / 10000
  return Object.is(rounded, -0) ? '0' : String(rounded)
}

export interface NormalizedCommandPanOptions {
  mode: CommandPanMode
  width: number
  supported: boolean
  enabled: boolean
  clamped: boolean
}

export function normalizeCommandPanOptions(
  options: Readonly<CommandExportOptions>,
  targetVersion: string,
): NormalizedCommandPanOptions {
  const rawMode: unknown = options.panMode
  const mode: CommandPanMode = rawMode === 'listener' ? 'listener' : 'world'
  const rawWidth: unknown = options.listenerPanWidth
  const numericWidth = typeof rawWidth === 'number' && Number.isFinite(rawWidth)
    ? rawWidth
    : DEFAULT_COMMAND_EXPORT_OPTIONS.listenerPanWidth
  const width = Math.min(
    COMMAND_LISTENER_PAN_LIMITS.widthMax,
    Math.max(COMMAND_LISTENER_PAN_LIMITS.widthMin, numericWidth),
  )
  const supported = supportsListenerRelativePan(targetVersion)
  return {
    mode,
    width,
    supported,
    enabled: mode === 'listener' && supported,
    clamped: rawMode !== mode || rawWidth !== width,
  }
}

function normalizedPosition(value: string): { value: string, valid: boolean } {
  const tokens = value.trim().split(/\s+/).filter(Boolean)
  const validCoordinates = tokens.length === 3 && tokens.every(token => COORDINATE.test(token))
  const localCoordinates = validCoordinates && tokens.some(token => token.startsWith('^'))
  const valid = validCoordinates && (!localCoordinates || tokens.every(token => token.startsWith('^')))
  return { value: valid ? tokens.join(' ') : '~ ~ ~', valid }
}

export interface NormalizedCommandVisualizerOptions {
  type: CommandVisualizerType
  origin: string
  placement: CommandVisualizerPlacement
  glow: boolean
  density: number
  scale: number
  colorMapping: CommandVisualizerColorMapping
  validOrigin: boolean
  clamped: boolean
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): {
  value: number
  valid: boolean
} {
  const numeric = typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(numeric)) return { value: fallback, valid: false }
  return { value: Math.min(maximum, Math.max(minimum, numeric)), valid: numeric >= minimum && numeric <= maximum }
}

export function normalizeCommandVisualizerOptions(
  options: Readonly<CommandExportOptions>,
  fallbackOrigin: string,
): NormalizedCommandVisualizerOptions {
  const rawType: unknown = options.visualizerType
  const type = VISUALIZER_TYPES.has(String(rawType))
    ? rawType as CommandVisualizerType
    : DEFAULT_COMMAND_EXPORT_OPTIONS.visualizerType
  const rawPlacement: unknown = options.visualizerPlacement
  const placement = VISUALIZER_PLACEMENTS.has(String(rawPlacement))
    ? rawPlacement as CommandVisualizerPlacement
    : DEFAULT_COMMAND_EXPORT_OPTIONS.visualizerPlacement
  const rawColorMapping: unknown = options.visualizerColorMapping
  const colorMapping = VISUALIZER_COLOR_MAPPINGS.has(String(rawColorMapping))
    ? rawColorMapping as CommandVisualizerColorMapping
    : DEFAULT_COMMAND_EXPORT_OPTIONS.visualizerColorMapping
  const densityResult = boundedNumber(
    options.visualizerDensity,
    DEFAULT_COMMAND_EXPORT_OPTIONS.visualizerDensity,
    COMMAND_VISUALIZER_LIMITS.densityMin,
    COMMAND_VISUALIZER_LIMITS.densityMax,
  )
  const roundedDensity = Math.round(densityResult.value)
  const scaleResult = boundedNumber(
    options.visualizerScale,
    DEFAULT_COMMAND_EXPORT_OPTIONS.visualizerScale,
    COMMAND_VISUALIZER_LIMITS.scaleMin,
    COMMAND_VISUALIZER_LIMITS.scaleMax,
  )
  const originResult = normalizedPosition(
    typeof options.visualizerOrigin === 'string' ? options.visualizerOrigin : '',
  )
  return {
    type,
    origin: originResult.valid ? originResult.value : fallbackOrigin,
    placement,
    glow: options.visualizerGlow === true,
    density: roundedDensity,
    scale: scaleResult.value,
    colorMapping,
    validOrigin: originResult.valid,
    clamped: type !== rawType || placement !== rawPlacement || colorMapping !== rawColorMapping
      || !densityResult.valid || roundedDensity !== densityResult.value || !scaleResult.valid,
  }
}

function usesLegacyVisualizerFallback(version: string): boolean {
  const match = /^1\.(\d+)(?:\.|$)/.exec(version.trim())
  return !!match && Number(match[1]) <= 13
}

function rotatedXZ(
  x: number,
  z: number,
  placement: CommandVisualizerPlacement,
): readonly [number, number] {
  if (placement === 'south') return [-x, -z]
  if (placement === 'east') return [-z, x]
  if (placement === 'west') return [z, -x]
  return [x, z]
}

function relativeCoordinate(value: number): string {
  const encoded = commandNumber(value)
  return encoded === '0' ? '~' : `~${encoded}`
}

function visualizerBlock(
  note: Readonly<CommandVisualizerNote>,
  mapping: CommandVisualizerColorMapping,
): typeof VISUALIZER_BLOCKS[number] {
  let index: number
  if (mapping === 'sound') index = Number.parseInt(stableHash(note.soundId), 36)
  else if (mapping === 'pitch') index = Math.round(note.pitchSemitones) + COMMAND_VISUALIZER_LIMITS.pitchSemitones
  else index = note.trackIndex
  return VISUALIZER_BLOCKS[Math.abs(index) % VISUALIZER_BLOCKS.length]
}

function visualizerCommands(
  note: Readonly<CommandVisualizerNote>,
  visualizer: Readonly<NormalizedCommandVisualizerOptions>,
  visualTag: string,
  target: string,
  legacy: boolean,
): string[] {
  if (visualizer.type === 'off') return []
  const contract = COMMAND_VISUALIZER_CONTRACTS[visualizer.type]
  const emission = contract.emit(note, visualizer.scale)
  const [offsetX, offsetZ] = rotatedXZ(emission.offset[0], emission.offset[2], visualizer.placement)
  const [motionX, motionZ] = rotatedXZ(emission.motion[0], emission.motion[2], visualizer.placement)
  const position = [
    relativeCoordinate(offsetX),
    relativeCoordinate(emission.offset[1]),
    relativeCoordinate(offsetZ),
  ].join(' ')
  const particle = [
    'execute positioned', visualizer.origin, 'run particle minecraft:note', position,
    '0.05 0.05 0.05 0', String(visualizer.density), 'force', target,
  ].join(' ')
  if (legacy) return [particle]
  const glow = visualizer.glow ? ',Glowing:1b' : ''
  const motion = [motionX, emission.motion[1], motionZ].map(value => `${commandNumber(value)}d`).join(',')
  const entity = [
    'execute positioned', visualizer.origin, 'run summon minecraft:falling_block', position,
    `{Tags:["${visualTag}"],BlockState:{Name:"${visualizerBlock(note, visualizer.colorMapping)}"},Time:-120,DropItem:0b,NoGravity:1b,Invulnerable:1b${glow},Motion:[${motion}]}`,
  ].join(' ')
  return [entity, particle]
}

function rangeFor(project: TimelineState, range: CommandExportOptions['range']): {
  start: number
  end: number
  validLoop: boolean
} {
  const loop = project.settings.loop
  if (range === 'loop' && loop.endTick > loop.startTick) {
    return { start: loop.startTick, end: loop.endTick, validLoop: true }
  }
  return { start: 0, end: project.lengthTicks, validLoop: range !== 'loop' }
}

function firingBounds(
  marker: Readonly<Marker>,
  rangeStart: number,
  rangeEnd: number,
): { duration: number, interval: number, first: number, last: number } | null {
  const duration = Number.isFinite(marker.duration) ? Math.max(0, marker.duration ?? 0) : 0
  const interval = Number.isFinite(marker.retriggerInterval)
    ? Math.max(1, marker.retriggerInterval ?? 1)
    : 1
  const lastPossible = duration > 0 ? Math.floor(duration / interval) : 0
  const first = Math.max(0, Math.ceil((rangeStart - marker.tick) / interval))
  const last = Math.min(lastPossible, Math.ceil((rangeEnd - marker.tick) / interval) - 1)
  return first <= last ? { duration, interval, first, last } : null
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36).padStart(7, '0').slice(0, 7)
}

type CompanionAudioOmission = 'wav' | 'mp3' | 'unknown' | 'invalid-ogg' | 'missing-bytes'

interface CustomAudioAlias {
  eventId: string
  variantEventIds: (string | undefined)[]
}

interface CompanionResourcePackBuild {
  resourcePack: CommandCompanionResourcePack | null
  aliases: Map<string, CustomAudioAlias>
  omittedSoundIds: Map<CompanionAudioOmission, Set<string>>
  metadataAdjustedSoundIds: Set<string>
}

function base64Prefix(value: string, byteLimit = 1024): Uint8Array | null {
  if (!value || value.length % 4 !== 0) return null
  const encodedLimit = Math.min(value.length, Math.ceil(byteLimit / 3) * 4)
  const alignedLimit = encodedLimit - (encodedLimit % 4)
  try {
    const decoded = atob(value.slice(0, alignedLimit))
    return Uint8Array.from(decoded, character => character.charCodeAt(0))
  }
  catch {
    return null
  }
}

/**
 * Java Edition resource-pack sounds must be Ogg Vorbis. Checking both the Ogg
 * capture pattern and the first Vorbis identification packet prevents renamed
 * WAV/MP3/Opus files from entering the companion pack. The native save
 * boundary performs the full strict base64/size validation before writing.
 */
function hasOggVorbisIdentification(asset: NonNullable<TimelineState['customAudio']>[number]): boolean {
  if (asset.mimeType !== 'audio/ogg'
    || asset.byteLength < 35
    || asset.dataBase64.length !== Math.ceil(asset.byteLength / 3) * 4
    || !/^[0-9a-f]{64}$/u.test(asset.fingerprint)) return false
  const bytes = base64Prefix(asset.dataBase64)
  if (!bytes || bytes.length < 35
    || bytes[0] !== 0x4f || bytes[1] !== 0x67 || bytes[2] !== 0x67 || bytes[3] !== 0x53
    || bytes[4] !== 0) return false
  const segmentCount = bytes[26]
  const packetOffset = 27 + segmentCount
  return packetOffset + 7 <= bytes.length
    && bytes[packetOffset] === 1
    && String.fromCharCode(...bytes.subarray(packetOffset + 1, packetOffset + 7)) === 'vorbis'
}

function addOmission(
  omissions: Map<CompanionAudioOmission, Set<string>>,
  reason: CompanionAudioOmission,
  soundId: string,
): void {
  const values = omissions.get(reason) ?? new Set<string>()
  values.add(soundId)
  omissions.set(reason, values)
}

function minecraftSoundEntry(
  namespace: string,
  asset: NonNullable<TimelineState['customAudio']>[number],
  metadataAdjustedSoundIds: Set<string>,
): Record<string, string | number | boolean> {
  const originalPitch = Number.isFinite(asset.pitch) ? asset.pitch : 1
  const pitch = Math.min(2, Math.max(0.5, originalPitch))
  const originalVolume = asset.volume === undefined || !Number.isFinite(asset.volume) ? 1 : asset.volume
  const volume = Math.min(1, Math.max(0, originalVolume))
  const originalWeight = asset.weight === undefined || !Number.isInteger(asset.weight) ? 1 : asset.weight
  const weight = Math.min(2_147_483_647, Math.max(1, originalWeight))
  const originalAttenuation = asset.attenuationDistance
  const attenuationDistance = originalAttenuation === undefined || !Number.isFinite(originalAttenuation)
    ? undefined
    : Math.min(1_000_000, Math.max(0, originalAttenuation))
  if (pitch !== originalPitch || volume !== originalVolume || weight !== originalWeight
    || attenuationDistance !== originalAttenuation) metadataAdjustedSoundIds.add(asset.soundId)
  return {
    name: `${namespace}:knead/audio/${asset.fingerprint}`,
    pitch,
    volume,
    weight,
    stream: asset.stream === true,
    preload: asset.preload === true,
    ...(attenuationDistance === undefined ? {} : { attenuation_distance: attenuationDistance }),
  }
}

function buildCompanionResourcePack(
  project: TimelineState,
  options: Readonly<CommandExportOptions>,
  selectedSoundIds: ReadonlySet<string>,
): CompanionResourcePackBuild {
  const aliases = new Map<string, CustomAudioAlias>()
  const omittedSoundIds = new Map<CompanionAudioOmission, Set<string>>()
  const metadataAdjustedSoundIds = new Set<string>()
  const grouped = new Map<string, NonNullable<TimelineState['customAudio']>>()
  for (const asset of project.customAudio ?? []) {
    if (!selectedSoundIds.has(asset.soundId)) continue
    const variants = grouped.get(asset.soundId) ?? []
    variants.push(asset)
    grouped.set(asset.soundId, variants)
  }
  const soundsJson: Record<string, { replace: true, sounds: Record<string, string | number | boolean>[] }> = {}
  const files: Record<string, CommandExportFilePayload> = {}
  const uniqueAssets = new Set<string>()
  const mappingLines: string[] = []
  let byteLength = 0
  let variantCount = 0
  let eventCount = 0
  const soundIds = Array.from(grouped.keys()).sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  for (let soundIndex = 0; soundIndex < soundIds.length; soundIndex++) {
    const soundId = soundIds[soundIndex]
    const variants = grouped.get(soundId) ?? []
    const eventPath = `knead/custom/e_${String(soundIndex).padStart(4, '0')}_${stableHash(soundId)}`
    const eventId = `${options.namespace}:${eventPath}`
    const variantEventIds: (string | undefined)[] = Array.from({ length: variants.length })
    const eventEntries: Record<string, string | number | boolean>[] = []
    for (let variantIndex = 0; variantIndex < variants.length; variantIndex++) {
      const asset = variants[variantIndex]
      if (asset.mimeType !== 'audio/ogg') {
        addOmission(
          omittedSoundIds,
          asset.mimeType === 'audio/wav' ? 'wav' : asset.mimeType === 'audio/mpeg' ? 'mp3' : 'unknown',
          soundId,
        )
        continue
      }
      if (!hasOggVorbisIdentification(asset)) {
        const missing = !asset.dataBase64
          || asset.dataBase64.length !== Math.ceil(asset.byteLength / 3) * 4
        addOmission(omittedSoundIds, missing ? 'missing-bytes' : 'invalid-ogg', soundId)
        continue
      }
      const entry = minecraftSoundEntry(options.namespace, asset, metadataAdjustedSoundIds)
      eventEntries.push(entry)
      const variantPath = `${eventPath}/v_${String(variantIndex).padStart(4, '0')}`
      const variantEventId = `${options.namespace}:${variantPath}`
      soundsJson[variantPath] = { replace: true, sounds: [entry] }
      variantEventIds[variantIndex] = variantEventId
      eventCount++
      variantCount++
      if (!uniqueAssets.has(asset.fingerprint)) {
        uniqueAssets.add(asset.fingerprint)
        files[`assets/${options.namespace}/sounds/knead/audio/${asset.fingerprint}.ogg`] = {
          encoding: 'base64',
          data: asset.dataBase64,
        }
        byteLength += asset.byteLength
      }
    }
    if (eventEntries.length === 0) continue
    soundsJson[eventPath] = { replace: true, sounds: eventEntries }
    aliases.set(soundId, { eventId, variantEventIds })
    mappingLines.push(`${JSON.stringify(soundId)} -> ${eventId}`)
    eventCount++
  }
  if (aliases.size === 0) {
    return { resourcePack: null, aliases, omittedSoundIds, metadataAdjustedSoundIds }
  }
  const textFiles: Record<string, string> = {
    'pack.mcmeta': packMetadata(
      `${options.description.trim() || DEFAULT_COMMAND_EXPORT_OPTIONS.description} (Knead companion sounds)`,
      options.resourcePackFormat,
      65,
    ),
    [`assets/${options.namespace}/sounds.json`]: JSON.stringify(soundsJson, null, 2) + '\n',
    'README.txt': [
      'Generated by Knead Studio',
      '',
      'Install this ZIP as a Java Edition resource pack alongside the matching Knead data pack.',
      `Namespace: ${options.namespace}`,
      `Sound events: ${eventCount}`,
      `Playable Ogg Vorbis variants: ${variantCount}`,
      '',
      'Knead aliases (original IDs are never written into minecraft:sounds.json):',
      ...mappingLines,
    ].join('\n') + '\n',
  }
  const encoder = new TextEncoder()
  for (const [path, contents] of Object.entries(textFiles)) {
    files[path] = contents
    byteLength += encoder.encode(contents).byteLength
  }
  return {
    resourcePack: {
      files,
      namespace: options.namespace,
      eventCount,
      variantCount,
      assetCount: uniqueAssets.size,
      byteLength,
    },
    aliases,
    omittedSoundIds,
    metadataAdjustedSoundIds,
  }
}

function resolveTarget(options: CommandExportOptions): { value: string, valid: boolean } {
  if (options.audience === 'all') return { value: '@a', valid: true }
  if (options.audience === 'nearby') {
    const valid = Number.isFinite(options.nearbyRadius)
      && options.nearbyRadius >= 1
      && options.nearbyRadius <= 4096
    const radius = valid ? Math.round(options.nearbyRadius) : DEFAULT_COMMAND_EXPORT_OPTIONS.nearbyRadius
    return { value: `@a[distance=..${radius}]`, valid }
  }
  const target = options.target.trim()
  return SAFE_PLAYER_TARGET.test(target)
    ? { value: target, valid: true }
    : { value: '@a', valid: false }
}

function playsoundCommand(
  soundId: string,
  source: string,
  target: string,
  position: string,
  volume: number,
  pitch: number,
  minVolume: number,
): string {
  return [
    'execute positioned', position, 'run playsound', soundId, source, target, '~ ~ ~',
    commandNumber(volume), commandNumber(pitch), commandNumber(minVolume),
  ].join(' ')
}

function localCoordinate(value: number): string {
  const encoded = commandNumber(value)
  return encoded === '0' ? '^' : `^${encoded}`
}

function listenerRelativePlaysoundCommand(
  soundId: string,
  source: string,
  target: string,
  selectionOrigin: string,
  volume: number,
  pitch: number,
  minVolume: number,
  pan: number,
  width: number,
): string {
  // Local +X points left in Java Edition, while Knead's positive pan points
  // right, hence the sign inversion. `as` fans out safely to players and the
  // final @s guarantees that each positioned sound is heard only by its owner.
  const localX = localCoordinate(-pan * width)
  return [
    'execute positioned', selectionOrigin,
    'as', target,
    'at @s rotated as @s anchored eyes positioned', `${localX} ^ ^`,
    'run playsound', soundId, source, '@s', '~ ~ ~',
    commandNumber(volume), commandNumber(pitch), commandNumber(minVolume),
  ].join(' ')
}

function stopSoundCommand(
  soundId: string | undefined,
  source: string,
  target: string,
  position: string,
): string {
  return [
    'execute positioned', position, 'run stopsound', target, source, soundId,
  ].filter(value => value !== undefined).join(' ')
}

function stopSoundCommands(
  soundIds: string[],
  source: string,
  target: string,
  position: string,
): string[] {
  return soundIds.map(soundId => stopSoundCommand(soundId, source, target, position))
}

function addDispatchFiles(
  files: Record<string, string>,
  base: string,
  namespace: string,
  objective: string,
  eventTicks: number[],
): void {
  let nextNode = 0

  const writeNode = (resourcePath: string, ticks: number[]) => {
    let lines: string[]
    if (ticks.length <= DISPATCH_LEAF_SIZE) {
      lines = ticks.map(tick => (
        `execute if score #tick ${objective} matches ${tick} run function ${namespace}:events/tick_${tick}`
      ))
    }
    else {
      const midpoint = Math.ceil(ticks.length / 2)
      const children = [ticks.slice(0, midpoint), ticks.slice(midpoint)]
      lines = children.map((child) => {
        const childPath = `runtime/dispatch/node_${nextNode++}`
        writeNode(childPath, child)
        return `execute if score #tick ${objective} matches ${child[0]}..${child[child.length - 1]} run function ${namespace}:${childPath}`
      })
    }
    files[`${base}/${resourcePath}.mcfunction`] = (lines.length > 0 ? lines : ['# No events in the selected range']).join('\n') + '\n'
  }

  writeNode('runtime/dispatch', eventTicks)
}

export function generateCommandDatapack(
  project: TimelineState,
  rawOptions: CommandExportOptions,
  progressContext?: GenerationProgressContext,
): CommandExportResult {
  generationCheckpoint(progressContext, 0.02, 'preparing')
  const options = { ...rawOptions, namespace: sanitizeNamespace(rawOptions.namespace) }
  const selectedRange = rangeFor(project, options.range)
  const rangeStart = selectedRange.start
  const rangeEnd = selectedRange.end
  const tempoModel = project.settings.ticksPerQuarter === undefined
    ? undefined
    : buildTempoMap(project.tempoMap, project.settings)
  const relativeGameTick = (tick: number) => tempoModel
    ? tickRangeToSeconds(rangeStart, tick, tempoModel) * MINECRAFT_TICKS_PER_SECOND
    : tick - rangeStart
  const exactDurationTicks = relativeGameTick(rangeEnd)
  const durationTicks = Math.max(1, Math.ceil(exactDurationTicks - (tempoModel ? 1e-8 : 0)))
  if (durationTicks > 0x7fff_ffff) throw new Error('Playback length exceeds the Minecraft scoreboard tick range')
  const roundedTimingMarkerIds = new Set<string>()
  const scheduledGameTick = (projectTick: number, markerId: string) => {
    const exact = relativeGameTick(projectTick)
    const tick = Math.min(durationTicks - 1, Math.max(0, Math.round(exact)))
    if (tempoModel && Math.abs(tick - exact) > 1e-8) roundedTimingMarkerIds.add(markerId)
    return tick
  }
  const positionResult = normalizedPosition(options.position)
  const position = positionResult.value
  const targetResult = resolveTarget(options)
  const target = targetResult.value
  const source = SOUND_SOURCES.has(options.source) ? options.source : 'master'
  const panOptions = normalizeCommandPanOptions(options, project.targetVersion)
  const visualizer = normalizeCommandVisualizerOptions(options, position)
  const visualizerEnabled = visualizer.type !== 'off'
  const legacyVisualizer = visualizerEnabled && usesLegacyVisualizerFallback(project.targetVersion)
  const finiteLoopCount = options.loopPlayback && options.range === 'loop'
    ? Math.max(0, Math.min(0xff, Math.trunc(project.settings.loop.maxLoopCount ?? 0)))
    : 0
  const visualTag = `knv_${stableHash(options.namespace)}`
  const tracks = new Map(project.tracks.map(track => [track.id, track]))
  const trackIndices = new Map(project.tracks.map((track, index) => [track.id, index]))
  const selectedPlayMarkers = project.markers.filter((marker) => {
    if (marker.action?.type === 'sound-stop' || !marker.soundId) return false
    const track = tracks.get(marker.trackId)
    return Boolean(
      track
      && firingBounds(marker, rangeStart, rangeEnd)
      && (options.includeMutedTracks || isTrackAudible(track, project.tracks)),
    )
  })
  const selectedSoundIds = new Set(selectedPlayMarkers.map(marker => marker.soundId))
  const companion = buildCompanionResourcePack(project, options, selectedSoundIds)
  generationCheckpoint(progressContext, 0.14, 'analyzing')
  const effectiveSoundId = (marker: Readonly<Marker>, firingIndex: number): string => {
    const alias = companion.aliases.get(marker.soundId)
    if (!alias) return marker.soundId
    const variantIndex = marker.variantIndex >= 0
      ? marker.variantIndex
      : stableVariantIndex(project.randomSeed, marker.id, firingIndex, alias.variantEventIds.length)
    return alias.variantEventIds[variantIndex] ?? marker.soundId
  }
  const selectedTrackIds = new Set(selectedPlayMarkers.map(marker => marker.trackId))
  const trackSoundIds = project.tracks.map(() => new Set<string>())
  for (const marker of project.markers) {
    if (marker.action?.type === 'sound-stop' || !marker.soundId) continue
    if (!firingBounds(marker, rangeStart, rangeEnd)) continue
    const trackIndex = trackIndices.get(marker.trackId)
    const track = trackIndex === undefined ? undefined : project.tracks[trackIndex]
    if (
      trackIndex !== undefined
      && track
      && (options.includeMutedTracks || isTrackAudible(track, project.tracks))
    ) {
      const alias = companion.aliases.get(marker.soundId)
      if (alias) {
        if (marker.variantIndex >= 0) {
          const soundId = alias.variantEventIds[marker.variantIndex] ?? marker.soundId
          if (RESOURCE_LOCATION.test(soundId)) trackSoundIds[trackIndex].add(soundId)
        }
        else {
          let needsOriginalFallback = false
          for (const soundId of alias.variantEventIds) {
            if (soundId) trackSoundIds[trackIndex].add(soundId)
            else needsOriginalFallback = true
          }
          if (needsOriginalFallback && RESOURCE_LOCATION.test(marker.soundId)) {
            trackSoundIds[trackIndex].add(marker.soundId)
          }
        }
      }
      else if (RESOURCE_LOCATION.test(marker.soundId)) trackSoundIds[trackIndex].add(marker.soundId)
    }
  }
  const masterGain = dbToGain(project.master.gainDb)
  const events: CommandEvent[] = []
  const warnings = new Set<CommandExportWarning>()
  const minecraftClampedPitchMarkerIds = new Set<string>()
  let skippedEventCount = 0
  let eventBudgetExceeded = false

  const markerProgressDenominator = Math.max(1, project.markers.length)
  let processedMarkerCount = 0
  eventLoop: for (const marker of project.markers) {
    if ((processedMarkerCount & 0xff) === 0) {
      generationCheckpoint(
        progressContext,
        0.18 + 0.36 * (processedMarkerCount / markerProgressDenominator),
        'collecting-events',
      )
    }
    processedMarkerCount++
    const track = tracks.get(marker.trackId)
    if (!track) continue
    const trackIndex = trackIndices.get(marker.trackId) ?? Number.MAX_SAFE_INTEGER
    if (marker.action?.type === 'sound-stop') {
      if (marker.tick < rangeStart || marker.tick >= rangeEnd) continue
      let commands: string[]
      if (marker.action.scope === 'all') {
        commands = [stopSoundCommand(undefined, source, target, position)]
      }
      else {
        const rawStart = Number.isFinite(marker.action.startTrack) ? Math.trunc(marker.action.startTrack ?? 1) : 1
        const rawEnd = Number.isFinite(marker.action.endTrack)
          ? Math.trunc(marker.action.endTrack ?? rawStart)
          : rawStart
        const startTrack = Math.min(MAX_SOUND_STOP_TRACK, Math.max(1, rawStart))
        const endTrack = Math.min(MAX_SOUND_STOP_TRACK, Math.max(startTrack, rawEnd))
        const selectedSoundIds = new Set<string>()
        for (let trackIndex = startTrack - 1; trackIndex < Math.min(endTrack, trackSoundIds.length); trackIndex++) {
          for (const soundId of trackSoundIds[trackIndex]) selectedSoundIds.add(soundId)
        }
        for (const soundId of selectedSoundIds) {
          const sharedOutsideRange = trackSoundIds.some((ids, trackIndex) => (
            (trackIndex < startTrack - 1 || trackIndex >= endTrack) && ids.has(soundId)
          ))
          if (sharedOutsideRange) warnings.add('soundStopRangeOverlap')
        }
        commands = Array.from(selectedSoundIds).sort()
          .map(soundId => stopSoundCommand(soundId, source, target, position))
      }
      for (const command of commands) {
        if (events.length >= MAX_COMMAND_EXPORT_EVENTS) {
          skippedEventCount++
          eventBudgetExceeded = true
          break eventLoop
        }
        events.push({
          tick: scheduledGameTick(marker.tick, marker.id), projectTick: marker.tick, trackIndex, kind: 'stop', command,
        })
      }
      continue
    }
    if (!marker.soundId) continue
    if (!options.includeMutedTracks && !isTrackAudible(track, project.tracks)) continue
    const bounds = firingBounds(marker, rangeStart, rangeEnd)
    if (!bounds) continue
    const { duration, interval, first: firstFiringIndex, last: lastFiringIndex } = bounds
    for (let firingIndex = firstFiringIndex; firingIndex <= lastFiringIndex; firingIndex++) {
      if (((firingIndex - firstFiringIndex) & 0x7ff) === 0) {
        const firingFraction = (firingIndex - firstFiringIndex)
          / Math.max(1, lastFiringIndex - firstFiringIndex + 1)
        generationCheckpoint(
          progressContext,
          0.18 + 0.36 * ((processedMarkerCount - 1 + firingFraction) / markerProgressDenominator),
          'collecting-events',
        )
      }
      if (events.length >= MAX_COMMAND_EXPORT_EVENTS) {
        skippedEventCount++
        eventBudgetExceeded = true
        break eventLoop
      }
      const offset = duration > 0 ? firingIndex * interval : 0
      const absoluteTick = marker.tick + offset
      const soundId = effectiveSoundId(marker, firingIndex)
      if (!RESOURCE_LOCATION.test(soundId)) {
        skippedEventCount++
        warnings.add('invalidSoundId')
        continue
      }
      const volume = Math.max(0, sampleCurve(marker.volumeCurve, offset, marker.volume)
        * dbToGain(track.gainDb) * masterGain)
      const sampledPitch = sampleCurve(marker.pitchCurve, offset, marker.pitch)
      const pitch = Math.max(0.5, Math.min(2, sampledPitch))
      if (pitch !== sampledPitch) minecraftClampedPitchMarkerIds.add(marker.id)
      const trackPan = Number.isFinite(track.pan) ? track.pan : 0
      const markerPan = Number.isFinite(marker.pan) ? marker.pan ?? 0 : 0
      const pan = Math.min(1, Math.max(-1, trackPan + markerPan))
      const pitchSemitones = Math.min(
        COMMAND_VISUALIZER_LIMITS.pitchSemitones,
        Math.max(-COMMAND_VISUALIZER_LIMITS.pitchSemitones, 12 * Math.log2(Math.max(0.0001, pitch))),
      )
      events.push({
        tick: scheduledGameTick(absoluteTick, marker.id),
        projectTick: absoluteTick,
        trackIndex,
        kind: 'play',
        command: panOptions.enabled
          ? listenerRelativePlaysoundCommand(
              soundId,
              source,
              target,
              position,
              volume,
              pitch,
              Number.isFinite(options.minVolume) ? Math.min(1, Math.max(0, options.minVolume)) : 0,
              pan,
              panOptions.width,
            )
          : playsoundCommand(
              soundId,
              source,
              target,
              position,
              volume,
              pitch,
              Number.isFinite(options.minVolume) ? Math.min(1, Math.max(0, options.minVolume)) : 0,
            ),
        note: {
          pitchSemitones,
          volume,
          pan,
          trackIndex,
          soundId,
        },
      })
    }
  }

  events.sort((a, b) => (
    a.tick - b.tick
    || (tempoModel ? a.projectTick - b.projectTick : 0)
    || a.trackIndex - b.trackIndex
    || (a.kind === b.kind ? a.command.localeCompare(b.command) : a.kind === 'play' ? -1 : 1)
  ))
  generationCheckpoint(progressContext, 0.56, 'analyzing')
  if (!panOptions.enabled
    && (project.tracks.some(track => selectedTrackIds.has(track.id) && track.pan !== 0)
      || selectedPlayMarkers.some(marker => (marker.pan ?? 0) !== 0))) {
    warnings.add('pan')
  }
  if (panOptions.mode === 'listener' && !panOptions.supported) warnings.add('legacyPan')
  if (panOptions.clamped) warnings.add('listenerPanOptionsClamped')
  const unpreservedFixedMarkers = selectedPlayMarkers.filter((marker) => {
    if (marker.variantIndex < 0) return false
    const alias = companion.aliases.get(marker.soundId)
    return !alias?.variantEventIds[marker.variantIndex]
  })
  if (unpreservedFixedMarkers.length > 0) warnings.add('fixedVariant')
  if (commandClockMode(project.targetVersion) === 'unsupported') warnings.add('legacySchedule')
  if (!selectedRange.validLoop) warnings.add('invalidLoopRange')
  if (!positionResult.valid) warnings.add('invalidPosition')
  if (!targetResult.valid) warnings.add('invalidTarget')
  if (source !== options.source) warnings.add('invalidSource')
  if (eventBudgetExceeded) warnings.add('largeExport')
  if (visualizerEnabled && !visualizer.validOrigin) warnings.add('invalidVisualizerOrigin')
  if (visualizerEnabled && visualizer.clamped) warnings.add('visualizerOptionsClamped')
  if (legacyVisualizer) warnings.add('legacyVisualizer')

  const diagnostics: CommandExportDiagnostic[] = []
  const diagnosticIds = (values: Iterable<string>): { ids: string[], count: number } | undefined => {
    const allIds = Array.from(new Set(values)).sort()
    return allIds.length > 0
      ? { ids: allIds.slice(0, COMMAND_EXPORT_DIAGNOSTIC_MAX_IDS), count: allIds.length }
      : undefined
  }
  const addDiagnostic = (
    diagnostic: Omit<CommandExportDiagnostic, 'markerIds' | 'markerIdCount' | 'trackIds' | 'trackIdCount'>,
    markerIds?: Iterable<string>,
    trackIds?: Iterable<string>,
  ) => {
    const boundedMarkerIds = markerIds ? diagnosticIds(markerIds) : undefined
    const boundedTrackIds = trackIds ? diagnosticIds(trackIds) : undefined
    diagnostics.push({
      ...diagnostic,
      ...(boundedMarkerIds
        ? { markerIds: boundedMarkerIds.ids, markerIdCount: boundedMarkerIds.count }
        : {}),
      ...(boundedTrackIds
        ? { trackIds: boundedTrackIds.ids, trackIdCount: boundedTrackIds.count }
        : {}),
    })
  }
  const panMarkers = selectedPlayMarkers.filter(marker => (marker.pan ?? 0) !== 0)
  const panTracks = project.tracks.filter(track => selectedTrackIds.has(track.id) && track.pan !== 0)
  if (panOptions.enabled && (panMarkers.length > 0 || panTracks.length > 0)) {
    addDiagnostic({
      code: 'command.panning.listener_baked',
      severity: 'info',
      disposition: 'baked',
      feature: 'panning',
      message: 'Track and marker pan are baked into listener-relative local coordinates.',
    }, panMarkers.map(marker => marker.id), panTracks.map(track => track.id))
  }
  const automatedMarkers = selectedPlayMarkers.filter(marker => (
    (marker.volumeCurve?.keyframes.length ?? 0) > 0
    || (marker.pitchCurve?.keyframes.length ?? 0) > 0
    || (marker.duration ?? 0) > 0
  ))
  if (automatedMarkers.length > 0) {
    addDiagnostic({
      code: 'command.automation.sampled',
      severity: 'info',
      disposition: 'baked',
      feature: 'automation',
      message: 'Retriggers and volume/pitch automation are sampled into individual playsound events.',
    }, automatedMarkers.map(marker => marker.id))
  }
  const gatedMarkers = selectedPlayMarkers.filter(marker => (marker.gateTicks ?? 0) > 0)
  if (gatedMarkers.length > 0) {
    addDiagnostic({
      code: 'command.gate_length.omitted',
      severity: 'warning',
      disposition: 'omitted',
      feature: 'gate-length',
      message: 'Per-voice gate cutoffs cannot be represented safely by playsound commands and were omitted; no stopsound commands were synthesized because they could stop overlapping voices that share a sound ID.',
    }, gatedMarkers.map(marker => marker.id))
  }
  const pitchedMarkers = selectedPlayMarkers.filter(marker => (
    marker.pitch !== 1 || (marker.pitchCurve?.keyframes.length ?? 0) > 0
  ))
  const bakedPitchMarkers = pitchedMarkers.filter(marker => !minecraftClampedPitchMarkerIds.has(marker.id))
  if (bakedPitchMarkers.length > 0) {
    addDiagnostic({
      code: 'command.pitch.range_baked',
      severity: 'info',
      disposition: 'baked',
      feature: 'automation',
      message: 'Pitch values within Minecraft\'s 0.5–2 playsound range are baked into commands.',
    }, bakedPitchMarkers.map(marker => marker.id))
  }
  if (minecraftClampedPitchMarkerIds.size > 0) {
    addDiagnostic({
      code: 'command.pitch.minecraft_clamped',
      severity: 'warning',
      disposition: 'degraded',
      feature: 'automation',
      message: 'DAW pitch values outside Minecraft\'s 0.5–2 playsound range were clamped at each sampled firing.',
    }, minecraftClampedPitchMarkerIds)
  }
  const gainedTracks = project.tracks.filter(track => selectedTrackIds.has(track.id) && track.gainDb !== 0)
  if (project.master.gainDb !== 0 || gainedTracks.length > 0) {
    addDiagnostic({
      code: 'command.gain.baked',
      severity: 'info',
      disposition: 'baked',
      feature: 'automation',
      message: 'Master and track gain are multiplied into each exported playsound volume.',
    }, undefined, gainedTracks.map(track => track.id))
  }
  const inaudibleTracks = project.tracks.filter(track => !isTrackAudible(track, project.tracks))
  if (inaudibleTracks.length > 0) {
    addDiagnostic({
      code: options.includeMutedTracks
        ? 'command.audibility.muted_included'
        : 'command.audibility.filtered',
      severity: options.includeMutedTracks ? 'warning' : 'info',
      disposition: options.includeMutedTracks ? 'degraded' : 'baked',
      feature: 'audibility',
      message: options.includeMutedTracks
        ? 'Muted or non-solo tracks are included because the export option overrides project audibility.'
        : 'Mute and solo state are baked by omitting currently inaudible tracks.',
    }, undefined, inaudibleTracks.map(track => track.id))
  }
  const soundStopMarkers = project.markers.filter(marker => (
    marker.action?.type === 'sound-stop' && marker.tick >= rangeStart && marker.tick < rangeEnd
  ))
  if (soundStopMarkers.length > 0) {
    addDiagnostic({
      code: 'command.sound_stop.commands',
      severity: 'info',
      disposition: 'preserved',
      feature: 'sound-stop',
      message: 'Sound Stopper events are exported as stopsound commands.',
    }, soundStopMarkers.map(marker => marker.id))
  }
  if (tempoModel && (roundedTimingMarkerIds.size > 0 || Math.abs(exactDurationTicks - durationTicks) > 1e-8)) {
    addDiagnostic({
      code: 'command.timing.rounded',
      severity: 'warning',
      disposition: 'degraded',
      feature: 'timing',
      message: 'The data pack rounds playback times to the Minecraft 20 TPS command grid.',
    }, [...roundedTimingMarkerIds])
  }
  if ((project.tempoMap?.length ?? 0) > 1) {
    addDiagnostic({
      code: 'command.tempo_map.baked',
      severity: 'info',
      disposition: 'baked',
      feature: 'timing',
      message: 'Tempo and meter changes are baked into event positions at 20 TPS.',
    })
  }
  const referenceAudio = project.referenceAudio ?? []
  if (referenceAudio.length > 0) {
    addDiagnostic({
      code: 'command.reference_audio.omitted',
      severity: 'warning',
      disposition: 'omitted',
      feature: 'reference-audio',
      message: 'Reference audio tracks are not included in a Minecraft data pack.',
    }, undefined, referenceAudio.map(track => track.id))
  }
  const customSoundIds = new Set((project.customAudio ?? []).map(asset => asset.soundId))
  const customAudioMarkers = selectedPlayMarkers.filter(marker => customSoundIds.has(marker.soundId))
  const fullyCompanionedMarkers = customAudioMarkers.filter((marker) => {
    const alias = companion.aliases.get(marker.soundId)
    if (!alias) return false
    return marker.variantIndex >= 0
      ? alias.variantEventIds[marker.variantIndex] !== undefined
      : alias.variantEventIds.length > 0 && alias.variantEventIds.every(Boolean)
  })
  if (fullyCompanionedMarkers.length > 0) {
    addDiagnostic({
      code: 'command.custom_audio.resource_pack_generated',
      severity: 'info',
      disposition: 'preserved',
      feature: 'custom-audio',
      message: 'Playable custom Ogg Vorbis assets were written to a separate companion resource pack and commands were rewritten to isolated Knead aliases.',
    }, fullyCompanionedMarkers.map(marker => marker.id))
  }
  const fullyCompanionedMarkerIds = new Set(fullyCompanionedMarkers.map(marker => marker.id))
  const incompleteCompanionMarkers = customAudioMarkers
    .filter(marker => !fullyCompanionedMarkerIds.has(marker.id))
  if (incompleteCompanionMarkers.length > 0) {
    addDiagnostic({
      code: 'command.custom_audio.resource_pack_required',
      severity: 'warning',
      disposition: 'degraded',
      feature: 'custom-audio',
      message: 'One or more custom variants could not be included; those firings keep their original sound ID and require an external compatible resource pack.',
    }, incompleteCompanionMarkers.map(marker => marker.id))
  }
  const markersForOmission = (reason: CompanionAudioOmission): string[] => {
    const affected = companion.omittedSoundIds.get(reason)
    return affected
      ? customAudioMarkers.filter(marker => affected.has(marker.soundId)).map(marker => marker.id)
      : []
  }
  for (const [reason, code, message] of [
    ['wav', 'command.custom_audio.wav_omitted', 'WAV custom variants are not accepted as Java Edition resource-pack sounds and were omitted.'],
    ['mp3', 'command.custom_audio.mp3_omitted', 'MP3 custom variants are not accepted as Java Edition resource-pack sounds and were omitted.'],
    ['unknown', 'command.custom_audio.codec_omitted', 'Custom variants with an unknown codec were omitted from the companion resource pack.'],
    ['invalid-ogg', 'command.custom_audio.invalid_ogg_omitted', 'Files that were not identifiable Ogg Vorbis streams were omitted from the companion resource pack.'],
    ['missing-bytes', 'command.custom_audio.missing_asset_omitted', 'Custom variants with missing or size-mismatched embedded bytes were omitted from the companion resource pack.'],
  ] as const) {
    const markerIds = markersForOmission(reason)
    if (markerIds.length === 0) continue
    addDiagnostic({
      code,
      severity: 'warning',
      disposition: 'omitted',
      feature: 'custom-audio',
      message,
    }, markerIds)
  }
  const metadataAdjustedMarkers = customAudioMarkers
    .filter(marker => companion.metadataAdjustedSoundIds.has(marker.soundId))
  if (metadataAdjustedMarkers.length > 0) {
    addDiagnostic({
      code: 'command.custom_audio.metadata_clamped',
      severity: 'warning',
      disposition: 'degraded',
      feature: 'custom-audio',
      message: 'Variant pitch, volume, weight, or attenuation metadata outside Minecraft-safe bounds was clamped.',
    }, metadataAdjustedMarkers.map(marker => marker.id))
  }
  const fixedAliasMarkers = customAudioMarkers.filter(marker => (
    marker.variantIndex >= 0
    && companion.aliases.get(marker.soundId)?.variantEventIds[marker.variantIndex] !== undefined
  ))
  if (fixedAliasMarkers.length > 0) {
    addDiagnostic({
      code: 'command.variants.fixed_resource_alias',
      severity: 'info',
      disposition: 'preserved',
      feature: 'variants',
      message: 'Fixed custom variants are preserved with one isolated resource-pack sound event per variant.',
    }, fixedAliasMarkers.map(marker => marker.id))
  }
  const deterministicAliasMarkers = customAudioMarkers.filter((marker) => {
    const alias = companion.aliases.get(marker.soundId)
    return marker.variantIndex < 0 && !!alias && alias.variantEventIds.length > 0
      && alias.variantEventIds.every(Boolean)
  })
  if (deterministicAliasMarkers.length > 0) {
    addDiagnostic({
      code: 'command.variants.deterministic_resource_alias',
      severity: 'info',
      disposition: 'preserved',
      feature: 'variants',
      message: 'Knead deterministic variant selection is resolved per firing and preserved through individual resource-pack event aliases; general aliases retain variant weights.',
    }, deterministicAliasMarkers.map(marker => marker.id))
  }
  if (project.master.limiterEnabled) {
    addDiagnostic({
      code: 'command.limiter.omitted',
      severity: 'warning',
      disposition: 'omitted',
      feature: 'limiter',
      message: 'The offline master limiter cannot be represented by playsound commands.',
    })
  }
  if (options.loopPlayback) {
    addDiagnostic({
      code: 'command.loop.runtime',
      severity: 'info',
      disposition: 'preserved',
      feature: 'loop',
      message: finiteLoopCount > 0
        ? `The selected range repeats ${finiteLoopCount} additional time(s).`
        : 'The selected range repeats indefinitely.',
    })
  }
  if (rawOptions.namespace !== options.namespace) {
    addDiagnostic({
      code: 'command.namespace.normalized',
      severity: 'warning',
      disposition: 'degraded',
      feature: 'validation',
      message: `The namespace was normalized to ${options.namespace}.`,
    })
  }
  for (const warning of warnings) {
    switch (warning) {
      case 'pan':
        addDiagnostic({
          code: 'command.panning.omitted', severity: 'warning', disposition: 'omitted', feature: 'panning',
          message: 'World-position playback cannot represent track or marker pan.',
        }, panMarkers.map(marker => marker.id), panTracks.map(track => track.id))
        break
      case 'legacyPan':
        addDiagnostic({
          code: 'command.panning.legacy_fallback', severity: 'warning', disposition: 'degraded', feature: 'panning',
          message: 'The target predates listener-relative coordinates, so stereo falls back to world position.',
        })
        break
      case 'listenerPanOptionsClamped':
        addDiagnostic({
          code: 'command.panning.options_clamped', severity: 'warning', disposition: 'degraded', feature: 'panning',
          message: 'Listener-relative pan options were clamped to safe bounds.',
        })
        break
      case 'fixedVariant':
        addDiagnostic({
          code: 'command.variants.fixed_omitted', severity: 'warning', disposition: 'omitted', feature: 'variants',
          message: 'Minecraft chooses sounds.json variants; fixed Knead variant indices are not exported.',
        }, unpreservedFixedMarkers.map(marker => marker.id))
        break
      case 'legacySchedule':
        addDiagnostic({
          code: 'command.datapack.unsupported_target', severity: 'error', disposition: 'omitted', feature: 'validation',
          message: 'The selected target predates Java Edition data packs (1.13), so it cannot load this output.',
        })
        break
      case 'invalidSoundId':
        addDiagnostic({
          code: 'command.sound_id.invalid_omitted', severity: 'error', disposition: 'omitted', feature: 'validation',
          message: 'Markers with invalid or unsafe sound IDs were omitted.',
        }, selectedPlayMarkers.filter((marker) => {
          const alias = companion.aliases.get(marker.soundId)
          if (!alias) return !RESOURCE_LOCATION.test(marker.soundId)
          if (marker.variantIndex >= 0) {
            return !RESOURCE_LOCATION.test(alias.variantEventIds[marker.variantIndex] ?? marker.soundId)
          }
          return alias.variantEventIds.some(soundId => !soundId)
            && !RESOURCE_LOCATION.test(marker.soundId)
        }).map(marker => marker.id))
        break
      case 'invalidTarget':
        addDiagnostic({
          code: 'command.target.fallback', severity: 'warning', disposition: 'degraded', feature: 'validation',
          message: 'The audience target was invalid and was replaced with @a.',
        })
        break
      case 'invalidPosition':
        addDiagnostic({
          code: 'command.position.fallback', severity: 'warning', disposition: 'degraded', feature: 'validation',
          message: 'The playback position was invalid and was replaced with ~ ~ ~.',
        })
        break
      case 'invalidSource':
        addDiagnostic({
          code: 'command.source.fallback', severity: 'warning', disposition: 'degraded', feature: 'validation',
          message: 'The sound source was invalid and was replaced with master.',
        })
        break
      case 'invalidLoopRange':
        addDiagnostic({
          code: 'command.loop.range_fallback', severity: 'warning', disposition: 'degraded', feature: 'loop',
          message: 'The loop range was invalid, so the full project range was exported.',
        })
        break
      case 'largeExport':
        addDiagnostic({
          code: 'command.event_budget.truncated', severity: 'error', disposition: 'omitted', feature: 'event-budget',
          message: 'The event safety budget was reached and remaining events were omitted.',
        })
        break
      case 'invalidVisualizerOrigin':
        addDiagnostic({
          code: 'command.visualizer.origin_fallback', severity: 'warning', disposition: 'degraded', feature: 'visualizer',
          message: 'The visualizer origin was invalid and was replaced with the playback position.',
        })
        break
      case 'visualizerOptionsClamped':
        addDiagnostic({
          code: 'command.visualizer.options_clamped', severity: 'warning', disposition: 'degraded', feature: 'visualizer',
          message: 'Visualizer options were clamped to safe bounds.',
        })
        break
      case 'legacyVisualizer':
        addDiagnostic({
          code: 'command.visualizer.legacy_particles', severity: 'warning', disposition: 'degraded', feature: 'visualizer',
          message: 'The managed entity visualizer was degraded to short-lived particles for this target.',
        })
        break
      case 'soundStopRangeOverlap':
        addDiagnostic({
          code: 'command.sound_stop.shared_id_range', severity: 'warning', disposition: 'degraded', feature: 'sound-stop',
          message: 'A ranged stop shares sound IDs with tracks outside the range, so Minecraft stops those instances too.',
        }, soundStopMarkers.map(marker => marker.id))
        break
    }
  }
  diagnostics.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
  if (companion.resourcePack) {
    const resourceReport = JSON.stringify({
      schemaVersion: COMMAND_EXPORT_REPORT_SCHEMA_VERSION,
      generator: 'Knead Studio',
      namespace: options.namespace,
      targetVersion: project.targetVersion,
      summary: {
        soundEventCount: companion.resourcePack.eventCount,
        variantCount: companion.resourcePack.variantCount,
        assetCount: companion.resourcePack.assetCount,
      },
      diagnostics: diagnostics.filter(diagnostic => (
        diagnostic.feature === 'custom-audio' || diagnostic.feature === 'variants'
      )),
    }, null, 2) + '\n'
    companion.resourcePack.files['knead-resource-pack-report.json'] = resourceReport
    companion.resourcePack.byteLength += new TextEncoder().encode(resourceReport).byteLength
  }
  const report: CommandExportReport = {
    schemaVersion: COMMAND_EXPORT_REPORT_SCHEMA_VERSION,
    generator: 'Knead Studio',
    namespace: options.namespace,
    targetVersion: project.targetVersion,
    summary: {
      eventCount: events.length,
      skippedEventCount,
      durationTicks,
    },
    diagnostics,
  }

  generationCheckpoint(progressContext, 0.7, 'writing-files')

  const functionDir = modernDirectoryLayout(project.targetVersion) ? 'function' : 'functions'
  const clockMode = commandClockMode(project.targetVersion)
  const base = `data/${options.namespace}/${functionDir}`
  const tagBase = `data/minecraft/tags/${functionDir}`
  const objective = `kn_${stableHash(options.namespace)}`
  const legacyControllerTag = `knc_${stableHash(options.namespace)}`
  const legacyController = `@e[type=minecraft:armor_stand,tag=${legacyControllerTag},limit=1]`
  const installCommand = `/function ${options.namespace}:install`
  const startCommand = `/function ${options.namespace}:start`
  const pauseCommand = `/function ${options.namespace}:pause`
  const resumeCommand = `/function ${options.namespace}:resume`
  const stopCommand = `/function ${options.namespace}:stop`
  const uninstallCommand = `/function ${options.namespace}:uninstall`
  const groupedEvents = new Map<number, string[]>()
  let groupedEventIndex = 0
  for (const event of events) {
    if ((groupedEventIndex & 0x7ff) === 0) {
      generationCheckpoint(
        progressContext,
        0.72 + 0.1 * (groupedEventIndex / Math.max(1, events.length)),
        'writing-files',
      )
    }
    groupedEventIndex++
    const commands = groupedEvents.get(event.tick) ?? []
    commands.push(event.command)
    if (event.note) {
      commands.push(...visualizerCommands(event.note, visualizer, visualTag, target, legacyVisualizer))
    }
    groupedEvents.set(event.tick, commands)
  }
  const eventTicks = Array.from(groupedEvents.keys()).sort((a, b) => a - b)
  const soundIds = Array.from(new Set(
    events.flatMap(event => event.note ? [event.note.soundId] : []),
  )).sort()
  const stopSounds = options.includeStopCommands
    ? stopSoundCommands(soundIds, source, target, position)
    : []
  const visualCleanupCall = visualizerEnabled
    ? [`function ${options.namespace}:runtime/visual_cleanup`]
    : []
  const visualAgeLines = visualizerEnabled && !legacyVisualizer
    ? [
        `execute as @e[type=minecraft:falling_block,tag=${visualTag}] run scoreboard players add @s ${objective} 1`,
        `kill @e[type=minecraft:falling_block,tag=${visualTag},scores={${objective}=${COMMAND_VISUALIZER_LIMITS.lifetimeTicks}..}]`,
      ]
    : []
  const stopLines = [
    ...(clockMode === 'schedule-clear-replace'
      ? [`schedule clear ${options.namespace}:runtime/tick`]
      : []),
    `scoreboard players set #state ${objective} 0`,
    ...visualCleanupCall,
    ...stopSounds,
  ]
  const startLines = [
    `function ${options.namespace}:stop`,
    `scoreboard players set #tick ${objective} 0`,
    `scoreboard players set #loops ${objective} 0`,
    `scoreboard players set #state ${objective} 1`,
    `function ${options.namespace}:runtime/dispatch`,
    ...(clockMode === 'tick-tag'
      ? []
      : [`schedule function ${options.namespace}:runtime/tick 1t${clockMode === 'schedule-basic' ? '' : ' replace'}`]),
  ]
  const pauseLines = [
    `execute if score #state ${objective} matches 1 run scoreboard players set #state ${objective} 2`,
    ...(clockMode === 'schedule-clear-replace'
      ? [`schedule clear ${options.namespace}:runtime/tick`]
      : []),
    ...visualCleanupCall,
    ...stopSounds,
  ]
  const resumeLines = [
    ...(clockMode === 'tick-tag'
      ? []
      : [`execute if score #state ${objective} matches 2 run schedule function ${options.namespace}:runtime/tick 1t${clockMode === 'schedule-basic' ? '' : ' replace'}`]),
    `execute if score #state ${objective} matches 2 run scoreboard players set #state ${objective} 1`,
  ]
  const repeatLines = [
    `scoreboard players add #loops ${objective} 1`,
    `scoreboard players set #tick ${objective} 0`,
    `function ${options.namespace}:runtime/dispatch`,
  ]
  const finishLines = options.loopPlayback
    ? finiteLoopCount > 0
      ? [
          ...visualCleanupCall,
          `execute if score #loops ${objective} matches ${finiteLoopCount}.. run scoreboard players set #state ${objective} 0`,
          `execute if score #state ${objective} matches 1 if score #loops ${objective} matches ..${finiteLoopCount - 1} run function ${options.namespace}:runtime/repeat`,
        ]
      : [
          ...visualCleanupCall,
          `function ${options.namespace}:runtime/repeat`,
        ]
    : [...visualCleanupCall, `scoreboard players set #state ${objective} 0`]
  const tickLines = [
    ...visualAgeLines,
    `execute if score #state ${objective} matches 1 run scoreboard players add #tick ${objective} 1`,
    `execute if score #state ${objective} matches 1 run function ${options.namespace}:runtime/dispatch`,
    `execute if score #state ${objective} matches 1 if score #tick ${objective} matches ${durationTicks}.. run function ${options.namespace}:runtime/finish`,
    ...(clockMode === 'tick-tag'
      ? []
      : [`execute if score #state ${objective} matches 1 run schedule function ${options.namespace}:runtime/tick 1t${clockMode === 'schedule-basic' ? '' : ' replace'}`]),
    ...(clockMode === 'schedule-basic'
      ? [`execute if score #state ${objective} matches 3 run scoreboard objectives remove ${objective}`]
      : []),
  ]

  const installLines = [
    `scoreboard objectives add ${objective} dummy`,
    ...(clockMode === 'schedule-basic'
      ? [`execute if score #state ${objective} matches 3 run scoreboard players set #state ${objective} 0`]
      : []),
    ...(clockMode === 'tick-tag'
      ? [
          `execute unless entity ${legacyController} run summon minecraft:armor_stand ~ ~ ~ {Tags:["${legacyControllerTag}"],Invisible:1b,Marker:1b,NoGravity:1b,Invulnerable:1b,Silent:1b}`,
        ]
      : []),
    ...visualCleanupCall,
  ]
  const uninstallLines = clockMode === 'schedule-basic'
    ? [
        `function ${options.namespace}:stop`,
        `scoreboard players set #state ${objective} 3`,
        `schedule function ${options.namespace}:runtime/tick 1t`,
      ]
    : [
        `function ${options.namespace}:stop`,
        ...(clockMode === 'tick-tag' ? [`kill ${legacyController}`] : []),
        `scoreboard objectives remove ${objective}`,
      ]

  const files: Record<string, string> = {
    'pack.mcmeta': packMetadata(
      options.description.trim() || DEFAULT_COMMAND_EXPORT_OPTIONS.description,
      options.packFormat,
    ),
    'knead-export-report.json': JSON.stringify(report, null, 2) + '\n',
    [`${tagBase}/load.json`]: JSON.stringify({ values: [`${options.namespace}:install`] }, null, 2) + '\n',
    [`${base}/install.mcfunction`]: installLines.join('\n') + '\n',
    [`${base}/start.mcfunction`]: startLines.join('\n') + '\n',
    [`${base}/pause.mcfunction`]: pauseLines.join('\n') + '\n',
    [`${base}/resume.mcfunction`]: resumeLines.join('\n') + '\n',
    [`${base}/stop.mcfunction`]: stopLines.join('\n') + '\n',
    [`${base}/uninstall.mcfunction`]: uninstallLines.join('\n') + '\n',
    [`${base}/runtime/tick.mcfunction`]: tickLines.join('\n') + '\n',
    [`${base}/runtime/finish.mcfunction`]: finishLines.join('\n') + '\n',
    [`${base}/runtime/repeat.mcfunction`]: repeatLines.join('\n') + '\n',
    'README.txt': [
      'Generated by Knead Studio',
      '',
      'Run /reload after installing the ZIP. The load hook creates an isolated playback clock.',
      `Install:   ${installCommand} (only needed after a manual uninstall)`,
      `Start:     ${startCommand}`,
      `Pause:     ${pauseCommand}`,
      `Resume:    ${resumeCommand}`,
      `Stop:      ${stopCommand}`,
      `Uninstall: ${uninstallCommand} (run before removing the data pack)`,
      '',
      `Length: ${durationTicks} ticks (${commandNumber(durationTicks / MINECRAFT_TICKS_PER_SECOND)} seconds)`,
      `Events: ${events.length}`,
      `Playback: ${options.loopPlayback
        ? finiteLoopCount > 0
          ? `repeat selected range ${finiteLoopCount} additional time(s)`
          : 'repeat selected range forever'
        : 'once'}`,
      `Audience: ${target}`,
      `Position: ${position}`,
      `Pan positioning: ${panOptions.enabled
        ? `listener-relative (width ${commandNumber(panOptions.width)} blocks)`
        : panOptions.mode === 'listener' ? 'world-position fallback (target is older than Java 1.13)' : 'world position'}`,
      `Visualizer: ${visualizer.type}`,
      ...(visualizerEnabled
        ? [`Visualizer origin: ${visualizer.origin} (${visualizer.placement}, scale ${commandNumber(visualizer.scale)})`]
        : []),
      '',
      'Pause/resume preserves the event position. Already playing samples cannot resume mid-sample.',
      options.includeStopCommands
        ? 'Pause and stop end sounds started by this pack.'
        : 'Pause and stop leave already playing sounds alone.',
      panOptions.enabled
        ? 'Each listener receives only their own sound. Position is the audience-selection origin (not the sound origin).'
        : 'Use absolute coordinates for a stable origin; scheduled functions evaluate relative coordinates in server context.',
    ].join('\n') + '\n',
  }
  if (clockMode === 'tick-tag') {
    files[`${tagBase}/tick.json`] = JSON.stringify({
      values: [`${options.namespace}:runtime/tick_driver`],
    }, null, 2) + '\n'
    files[`${base}/runtime/tick_driver.mcfunction`] = [
      `execute if entity ${legacyController} run function ${options.namespace}:runtime/tick`,
    ].join('\n') + '\n'
  }
  if (visualizerEnabled) {
    files[`${base}/runtime/visual_cleanup.mcfunction`] = legacyVisualizer
      ? '# Minecraft 1.13 fallback uses short-lived particles only.\n'
      : `kill @e[type=minecraft:falling_block,tag=${visualTag}]\n`
  }
  generationCheckpoint(progressContext, 0.88, 'writing-files')
  addDispatchFiles(files, base, options.namespace, objective, eventTicks)
  let eventFileIndex = 0
  for (const [tick, commands] of groupedEvents) {
    if ((eventFileIndex & 0x7f) === 0) {
      generationCheckpoint(
        progressContext,
        0.9 + 0.08 * (eventFileIndex / Math.max(1, groupedEvents.size)),
        'writing-files',
      )
    }
    eventFileIndex++
    files[`${base}/events/tick_${tick}.mcfunction`] = commands.join('\n') + '\n'
  }

  generationCheckpoint(progressContext, 1, 'complete')
  return {
    files,
    eventCount: events.length,
    skippedEventCount,
    durationTicks,
    installCommand,
    startCommand,
    pauseCommand,
    resumeCommand,
    stopCommand,
    uninstallCommand,
    warnings: Array.from(warnings),
    diagnostics,
    report,
    resourcePack: companion.resourcePack,
  }
}
