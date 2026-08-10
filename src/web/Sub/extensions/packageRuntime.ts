import type { Marker, Track } from '../types/timeline'
import {
  defineCommand,
  defineExtension,
  defineMarkerTransform,
  defineTrackTransform,
  type ExtensionCommandContext,
  type ExtensionDefinition,
  type ExtensionTransformContext,
  type ExtensionValidationResult,
} from './types'
import {
  MAX_DSL_OUTPUT_MARKERS,
  type DeclarativeCommandContribution,
  type DeclarativeCommandOutput,
  type DeclarativeExtensionPackage,
  type DeclarativeMarkerOperation,
  type DeclarativeMarkerTransformContribution,
  type DeclarativeTrackOperation,
  type DeclarativeTrackTransformContribution,
} from './packageTypes'
import { validateDeclarativeExtensionPackage } from './packageValidation'

interface EmptyOptions {
  readonly [key: string]: never
}

function emptyOptions(value: unknown): ExtensionValidationResult<EmptyOptions> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).length > 0) {
    return { ok: false, error: 'Declarative contributions accept an empty options object' }
  }
  return { ok: true, value: {} }
}

function commandOutput(value: unknown): ExtensionValidationResult<DeclarativeCommandOutput> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, error: 'Command output must be an object' }
  }
  const messages = (value as { messages?: unknown }).messages
  if (!Array.isArray(messages) || messages.some(message => typeof message !== 'string')) {
    return { ok: false, error: 'Command output messages must be strings' }
  }
  return { ok: true, value: { messages: [...messages] } }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function withoutMarkerSource(marker: Readonly<Marker>): Marker {
  const canonical = { ...marker }
  delete canonical.source
  return canonical
}

function withoutTrackSource(track: Readonly<Track>): Track {
  const canonical = { ...track }
  delete canonical.source
  return canonical
}

function uniqueMarkerId(
  baseId: string,
  suffix: string,
  usedIds: Set<string>,
): string {
  const stem = `${baseId}~${suffix}`
  let candidate = stem
  let collision = 1
  while (usedIds.has(candidate)) {
    candidate = `${stem}-${collision}`
    collision += 1
  }
  usedIds.add(candidate)
  return candidate
}

function duplicateMarkers(
  markers: readonly Marker[],
  operation: Extract<DeclarativeMarkerOperation, { op: 'duplicate' }>,
  context: ExtensionTransformContext,
  transformId: string,
  stepIndex: number,
): Marker[] {
  const multiplier = operation.copies + 1
  if (markers.length > Math.floor(MAX_DSL_OUTPUT_MARKERS / multiplier)) {
    throw new Error(`Declarative transform output exceeds ${MAX_DSL_OUTPUT_MARKERS} markers`)
  }
  const usedIds = new Set(context.project.markers.map(marker => marker.id))
  markers.forEach(marker => usedIds.add(marker.id))
  const safeExtensionId = context.extensionId.replace(/[^a-z0-9.-]/g, '-')
  const safeTransformId = transformId.replace(/[^a-z0-9._-]/g, '-')
  return markers.flatMap((marker) => {
    const original = withoutMarkerSource(marker)
    const copies: Marker[] = [original]
    for (let index = 1; index <= operation.copies; index++) {
      copies.push({
        ...original,
        id: uniqueMarkerId(
          marker.id,
          `dsl-${safeExtensionId}-${safeTransformId}-${stepIndex}-${index}`,
          usedIds,
        ),
        tick: Math.max(0, marker.tick + operation.intervalTicks * index),
        pitch: clamp(marker.pitch * 2 ** (operation.semitoneStep * index / 12), 0.5, 2),
        volume: clamp(marker.volume * operation.volumeDecay ** index, 0, 1),
      })
    }
    return copies
  })
}

function applyMarkerOperation(
  markers: readonly Marker[],
  operation: DeclarativeMarkerOperation,
  context: ExtensionTransformContext,
  transformId: string,
  stepIndex: number,
): Marker[] {
  if (operation.op === 'duplicate') {
    return duplicateMarkers(markers, operation, context, transformId, stepIndex)
  }
  return markers.map((source) => {
    const marker = withoutMarkerSource(source)
    switch (operation.op) {
      case 'shiftTicks':
        return { ...marker, tick: Math.max(0, marker.tick + operation.ticks) }
      case 'quantizeTicks': {
        const quantized = Math.round(marker.tick / operation.step) * operation.step
        return { ...marker, tick: Math.max(0, Math.round(marker.tick + (quantized - marker.tick) * operation.strength)) }
      }
      case 'transpose':
        return { ...marker, pitch: clamp(marker.pitch * 2 ** (operation.semitones / 12), 0.5, 2) }
      case 'scaleVolume':
        return { ...marker, volume: clamp(marker.volume * operation.factor, 0, 1) }
      case 'setPan':
        return { ...marker, pan: operation.pan }
      case 'setLane':
        return { ...marker, laneY: operation.lane }
      case 'setSound':
        return {
          ...marker,
          soundId: operation.soundId,
          variantIndex: operation.variantIndex ?? -1,
        }
    }
  })
}

function applyTrackOperation(track: Readonly<Track>, operation: DeclarativeTrackOperation): Track {
  const canonical = withoutTrackSource(track)
  switch (operation.op) {
    case 'adjustGainDb':
      return { ...canonical, gainDb: clamp(canonical.gainDb + operation.decibels, -60, 12) }
    case 'setPan':
      return { ...canonical, pan: operation.pan }
    case 'prefixName':
      return { ...canonical, name: `${operation.prefix}${canonical.name}`.slice(0, 500) }
    case 'setMuted':
      return { ...canonical, muted: operation.value }
    case 'setSolo':
      return { ...canonical, solo: operation.value }
    case 'setLocked':
      return { ...canonical, locked: operation.value }
  }
}

function compileCommand(contribution: DeclarativeCommandContribution) {
  return defineCommand<EmptyOptions, DeclarativeCommandOutput>({
    ...contribution,
    validateInput: emptyOptions,
    validateOutput: commandOutput,
    execute: (context: ExtensionCommandContext) => {
      const messages: string[] = []
      contribution.actions.forEach((action) => {
        if (action.op === 'notify') {
          context.notify?.(action.level, action.message)
          messages.push(action.message)
        }
        else if (action.op === 'projectSummary') {
          const project = context.project
          messages.push(project
            ? `${project.tracks.length} tracks, ${project.markers.length} markers, ${project.lengthTicks} ticks`
            : 'Project data is unavailable')
        }
        else {
          const selection = context.selection
          messages.push(selection
            ? `${selection.markerIds.length} markers and ${selection.trackIds.length} tracks selected`
            : 'Selection data is unavailable')
        }
      })
      return { messages }
    },
  })
}

function compileMarkerTransform(contribution: DeclarativeMarkerTransformContribution) {
  return defineMarkerTransform<EmptyOptions>({
    ...contribution,
    validateOptions: emptyOptions,
    transform: (source, context) => {
      let markers = source.map(marker => structuredClone(marker) as Marker)
      contribution.steps.forEach((step, index) => {
        markers = applyMarkerOperation(markers, step, context, contribution.id, index)
      })
      if (markers.length > MAX_DSL_OUTPUT_MARKERS) {
        throw new Error(`Declarative transform output exceeds ${MAX_DSL_OUTPUT_MARKERS} markers`)
      }
      return markers
    },
  })
}

function compileTrackTransform(contribution: DeclarativeTrackTransformContribution) {
  return defineTrackTransform<EmptyOptions>({
    ...contribution,
    validateOptions: emptyOptions,
    transform: source => source.map((track) => {
      let transformed = structuredClone(track) as Track
      contribution.steps.forEach((step) => {
        transformed = applyTrackOperation(transformed, step)
      })
      return transformed
    }),
  })
}

export function compileDeclarativeExtensionPackage(
  extensionPackage: DeclarativeExtensionPackage,
): ExtensionDefinition {
  const validated = validateDeclarativeExtensionPackage(extensionPackage)
  if (!validated.ok) {
    throw new Error(validated.issues.map(issue => `${issue.path}: ${issue.message}`).join('; '))
  }
  return defineExtension({
    manifest: validated.package.manifest,
    contributes: {
      commands: validated.package.contributes.commands?.map(compileCommand),
      markerTransforms: validated.package.contributes.markerTransforms?.map(compileMarkerTransform),
      trackTransforms: validated.package.contributes.trackTransforms?.map(compileTrackTransform),
    },
  })
}
