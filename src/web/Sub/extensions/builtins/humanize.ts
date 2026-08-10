import type { Curve, Marker } from '../../types/timeline'
import {
  EXTENSION_API_VERSION,
  defineExtension,
  defineMarkerTransform,
  type DeepReadonly,
  type ExtensionValidationResult,
} from '../types'

export interface HumanizeOptions {
  readonly timingJitterTicks: number
  readonly volumeJitter: number
  readonly pitchJitterCents: number
  readonly laneJitter: number
  readonly seed: number
}

export const DEFAULT_HUMANIZE_OPTIONS: HumanizeOptions = Object.freeze({
  timingJitterTicks: 1,
  volumeJitter: 0.08,
  pitchJitterCents: 8,
  laneJitter: 0,
  seed: 0,
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function inRange(value: unknown, minimum: number, maximum: number, integer = false): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value >= minimum
    && value <= maximum
    && (!integer || Number.isInteger(value))
}

export function validateHumanizeOptions(value: unknown): ExtensionValidationResult<HumanizeOptions> {
  if (!isRecord(value)) return { ok: false, error: 'options must be an object' }
  if (!inRange(value.timingJitterTicks, 0, 20, true)) {
    return { ok: false, error: 'timingJitterTicks must be an integer from 0 to 20' }
  }
  if (!inRange(value.volumeJitter, 0, 1)) return { ok: false, error: 'volumeJitter must be from 0 to 1' }
  if (!inRange(value.pitchJitterCents, 0, 1_200)) {
    return { ok: false, error: 'pitchJitterCents must be from 0 to 1200' }
  }
  if (!inRange(value.laneJitter, 0, 1)) return { ok: false, error: 'laneJitter must be from 0 to 1' }
  if (!inRange(value.seed, 0, 0xffff_ffff, true)) {
    return { ok: false, error: 'seed must be an unsigned 32-bit integer' }
  }
  return {
    ok: true,
    value: {
      timingJitterTicks: value.timingJitterTicks,
      volumeJitter: value.volumeJitter,
      pitchJitterCents: value.pitchJitterCents,
      laneJitter: value.laneJitter,
      seed: value.seed,
    },
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function hash(seed: number, text: string, channel: number): number {
  let value = (0x811c9dc5 ^ seed ^ Math.imul(channel + 1, 0x9e3779b1)) >>> 0
  for (let index = 0; index < text.length; index++) {
    value ^= text.charCodeAt(index)
    value = Math.imul(value, 0x01000193) >>> 0
  }
  value ^= value >>> 16
  value = Math.imul(value, 0x7feb352d) >>> 0
  value ^= value >>> 15
  value = Math.imul(value, 0x846ca68b) >>> 0
  return (value ^ (value >>> 16)) >>> 0
}

function signedRandom(seed: number, markerId: string, channel: number): number {
  return hash(seed, markerId, channel) / 0xffff_ffff * 2 - 1
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

export function humanizeMarkers(
  markers: readonly DeepReadonly<Marker>[],
  options: DeepReadonly<HumanizeOptions>,
  projectSeed: number,
): Marker[] {
  const seed = (projectSeed ^ options.seed) >>> 0
  return markers.map((marker) => {
    const timingOffset = Math.round(signedRandom(seed, marker.id, 0) * options.timingJitterTicks)
    const laneOffset = signedRandom(seed, marker.id, 3) * options.laneJitter
    if (marker.action?.type === 'sound-stop') {
      return {
        ...marker,
        tick: Math.max(0, marker.tick + timingOffset),
        soundId: '',
        variantIndex: -1,
        volume: 1,
        pitch: 1,
        pan: 0,
        duration: undefined,
        retriggerInterval: undefined,
        laneY: marker.laneY === undefined && options.laneJitter === 0
          ? undefined
          : clamp((marker.laneY ?? 0.5) + laneOffset, 0, 1),
        volumeCurve: undefined,
        pitchCurve: undefined,
        action: { ...marker.action },
      }
    }
    const volumeScale = 1 + signedRandom(seed, marker.id, 1) * options.volumeJitter
    const cents = signedRandom(seed, marker.id, 2) * options.pitchJitterCents
    const pitchScale = 2 ** (cents / 1_200)
    return {
      ...marker,
      tick: Math.max(0, marker.tick + timingOffset),
      volume: clamp(marker.volume * volumeScale, 0, 1),
      pitch: clamp(marker.pitch * pitchScale, 0.5, 2),
      laneY: marker.laneY === undefined && options.laneJitter === 0
        ? undefined
        : clamp((marker.laneY ?? 0.5) + laneOffset, 0, 1),
      volumeCurve: scaleCurve(marker.volumeCurve, volumeScale, 0, 1),
      pitchCurve: scaleCurve(marker.pitchCurve, pitchScale, 0.5, 2),
    }
  })
}

export const humanizeTransform = defineMarkerTransform<HumanizeOptions>({
  id: 'humanize',
  name: 'Humanize',
  description: 'Adds deterministic timing, velocity, pitch, and lane variation to selected markers.',
  requiredPermissions: ['timeline.read', 'timeline.transform', 'selection.read'],
  validateOptions: validateHumanizeOptions,
  transform: (markers, context, options) => humanizeMarkers(markers, options, context.project.randomSeed),
})

export const humanizeExtension = defineExtension({
  manifest: {
    apiVersion: EXTENSION_API_VERSION,
    id: 'knead.humanize',
    name: 'Knead Humanize',
    version: '1.0.0',
    description: 'Deterministic DAW-style performance variation for timeline markers.',
    author: 'Knead',
    permissions: {
      required: ['timeline.read', 'timeline.transform', 'selection.read'],
    },
    capabilities: ['markerTransforms'],
  },
  contributes: {
    markerTransforms: [humanizeTransform],
  },
})
