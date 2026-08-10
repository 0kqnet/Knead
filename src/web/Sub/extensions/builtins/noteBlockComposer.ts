import type { Curve, Marker } from '../../types/timeline'
import {
  EXTENSION_API_VERSION,
  defineCommand,
  defineExtension,
  defineMarkerTransform,
  type DeepReadonly,
  type ExtensionValidationResult,
} from '../types'

export type NoteBlockPattern = 'chord' | 'arpeggio'
export type NoteBlockPreset = 'major' | 'minor' | 'power' | 'octave'

export interface NoteBlockComposerOptions {
  readonly pattern: NoteBlockPattern
  readonly intervals: readonly number[]
  readonly stepTicks: number
  readonly volumeScale: number
  readonly laneSpread: number
}

export interface NoteBlockPresetRequest {
  readonly preset: NoteBlockPreset
  readonly pattern: NoteBlockPattern
}

const PRESET_INTERVALS: Readonly<Record<NoteBlockPreset, readonly number[]>> = Object.freeze({
  major: Object.freeze([0, 4, 7]),
  minor: Object.freeze([0, 3, 7]),
  power: Object.freeze([0, 7, 12]),
  octave: Object.freeze([0, 12]),
})

export const DEFAULT_NOTE_BLOCK_COMPOSER_OPTIONS: NoteBlockComposerOptions = Object.freeze({
  pattern: 'chord',
  intervals: PRESET_INTERVALS.major,
  stepTicks: 2,
  volumeScale: 0.8,
  laneSpread: 0.08,
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPattern(value: unknown): value is NoteBlockPattern {
  return value === 'chord' || value === 'arpeggio'
}

function validateIntervals(value: unknown): value is number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 12) return false
  const seen = new Set<number>()
  for (const interval of value) {
    if (!Number.isInteger(interval) || interval < -24 || interval > 24 || seen.has(interval)) return false
    seen.add(interval)
  }
  return true
}

export function validateNoteBlockComposerOptions(value: unknown): ExtensionValidationResult<NoteBlockComposerOptions> {
  if (!isRecord(value)) return { ok: false, error: 'options must be an object' }
  if (!isPattern(value.pattern)) return { ok: false, error: 'pattern must be chord or arpeggio' }
  if (!validateIntervals(value.intervals)) {
    return { ok: false, error: 'intervals must contain 1 to 12 unique integer semitone offsets from -24 to 24' }
  }
  if (!Number.isInteger(value.stepTicks) || (value.stepTicks as number) < 0 || (value.stepTicks as number) > 100) {
    return { ok: false, error: 'stepTicks must be an integer from 0 to 100' }
  }
  if (value.pattern === 'arpeggio' && value.stepTicks === 0) {
    return { ok: false, error: 'stepTicks must be at least 1 for an arpeggio' }
  }
  if (typeof value.volumeScale !== 'number' || !Number.isFinite(value.volumeScale) || value.volumeScale < 0 || value.volumeScale > 1) {
    return { ok: false, error: 'volumeScale must be from 0 to 1' }
  }
  if (typeof value.laneSpread !== 'number' || !Number.isFinite(value.laneSpread) || value.laneSpread < 0 || value.laneSpread > 0.5) {
    return { ok: false, error: 'laneSpread must be from 0 to 0.5' }
  }
  return {
    ok: true,
    value: {
      pattern: value.pattern,
      intervals: [...value.intervals],
      stepTicks: value.stepTicks as number,
      volumeScale: value.volumeScale,
      laneSpread: value.laneSpread,
    },
  }
}

function validatePresetRequest(value: unknown): ExtensionValidationResult<NoteBlockPresetRequest> {
  if (!isRecord(value)) return { ok: false, error: 'request must be an object' }
  if (typeof value.preset !== 'string' || !Object.prototype.hasOwnProperty.call(PRESET_INTERVALS, value.preset)) {
    return { ok: false, error: 'preset must be major, minor, power, or octave' }
  }
  if (!isPattern(value.pattern)) return { ok: false, error: 'pattern must be chord or arpeggio' }
  return { ok: true, value: { preset: value.preset as NoteBlockPreset, pattern: value.pattern } }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function scaleCurve(
  curve: DeepReadonly<Curve> | undefined,
  scale: number,
  minimum: number,
  maximum: number,
): Curve | undefined {
  if (!curve) return undefined
  return {
    keyframes: curve.keyframes.map(keyframe => ({
      ...keyframe,
      value: clamp(keyframe.value * scale, minimum, maximum),
      handleL: keyframe.handleL ? { ...keyframe.handleL, dv: keyframe.handleL.dv * scale } : undefined,
      handleR: keyframe.handleR ? { ...keyframe.handleR, dv: keyframe.handleR.dv * scale } : undefined,
    })),
  }
}

function derivedId(baseId: string, interval: number, voiceIndex: number, usedIds: Set<string>): string {
  const stem = `${baseId}::note-${interval >= 0 ? '+' : ''}${interval}-${voiceIndex + 1}`
  let id = stem
  let suffix = 2
  while (usedIds.has(id)) {
    id = `${stem}-${suffix}`
    suffix += 1
  }
  usedIds.add(id)
  return id
}

export function composeNoteBlockMarkers(
  markers: readonly DeepReadonly<Marker>[],
  options: DeepReadonly<NoteBlockComposerOptions>,
  existingMarkerIds: readonly string[],
): Marker[] {
  const selectedIds = new Set(markers.map(marker => marker.id))
  const usedIds = new Set(existingMarkerIds.filter(id => !selectedIds.has(id)))
  const result: Marker[] = []

  markers.forEach((marker) => {
    if (marker.action?.type === 'sound-stop') {
      usedIds.add(marker.id)
      result.push({
        ...marker,
        soundId: '',
        variantIndex: -1,
        volume: 1,
        pitch: 1,
        pan: 0,
        duration: undefined,
        retriggerInterval: undefined,
        volumeCurve: undefined,
        pitchCurve: undefined,
        action: { ...marker.action },
      })
      return
    }
    let retainedOriginal = false
    options.intervals.forEach((interval, voiceIndex) => {
      const pitchScale = 2 ** (interval / 12)
      const voiceOffset = voiceIndex - (options.intervals.length - 1) / 2
      const retainId = interval === 0 && !retainedOriginal && !usedIds.has(marker.id)
      const id = retainId
        ? marker.id
        : derivedId(marker.id, interval, voiceIndex, usedIds)
      if (retainId) {
        retainedOriginal = true
        usedIds.add(id)
      }
      result.push({
        ...marker,
        id,
        tick: marker.tick + (options.pattern === 'arpeggio' ? voiceIndex * options.stepTicks : 0),
        volume: clamp(marker.volume * options.volumeScale, 0, 1),
        pitch: clamp(marker.pitch * pitchScale, 0.5, 2),
        laneY: clamp((marker.laneY ?? 0.5) + voiceOffset * options.laneSpread, 0, 1),
        volumeCurve: scaleCurve(marker.volumeCurve, options.volumeScale, 0, 1),
        pitchCurve: scaleCurve(marker.pitchCurve, pitchScale, 0.5, 2),
      })
    })
  })
  return result
}

export const noteBlockPresetCommand = defineCommand<NoteBlockPresetRequest, NoteBlockComposerOptions>({
  id: 'create-preset',
  name: 'Create chord preset',
  description: 'Returns validated options for a common note-block chord or arpeggio.',
  requiredPermissions: [],
  validateInput: validatePresetRequest,
  validateOutput: validateNoteBlockComposerOptions,
  execute: (_context, request) => ({
    ...DEFAULT_NOTE_BLOCK_COMPOSER_OPTIONS,
    pattern: request.pattern,
    intervals: [...PRESET_INTERVALS[request.preset]],
  }),
})

export const noteBlockComposerTransform = defineMarkerTransform<NoteBlockComposerOptions>({
  id: 'compose',
  name: 'Note Block Chord / Arpeggio',
  description: 'Expands selected markers into pitch-safe chords or tick-aligned arpeggios.',
  requiredPermissions: ['timeline.read', 'timeline.transform', 'selection.read'],
  validateOptions: validateNoteBlockComposerOptions,
  transform: (markers, context, options) => composeNoteBlockMarkers(
    markers,
    options,
    context.project.markers.map(marker => marker.id),
  ),
})

export const noteBlockComposerExtension = defineExtension({
  manifest: {
    apiVersion: EXTENSION_API_VERSION,
    id: 'knead.note-block-composer',
    name: 'Knead Note Block Composer',
    version: '1.0.0',
    description: 'Chord and arpeggio generation for Minecraft note-block arrangements.',
    author: 'Knead',
    permissions: {
      required: ['timeline.read', 'timeline.transform', 'selection.read'],
    },
    capabilities: ['commands', 'markerTransforms'],
  },
  contributes: {
    commands: [noteBlockPresetCommand],
    markerTransforms: [noteBlockComposerTransform],
  },
})
