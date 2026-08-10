import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MASTER,
  DEFAULT_SETTINGS,
  createDefaultTrack,
  type Marker,
  type TimelineState,
} from '../types/timeline'
import { ExtensionRegistry } from './registry'
import {
  EXTENSION_API_VERSION,
  defineCommand,
  defineExtension,
  defineMarkerTransform,
  defineTrackTransform,
  type ExtensionValidationResult,
} from './types'
import { ExtensionDefinitionError, validateExtensionDefinition } from './validation'

const TRANSFORM_PERMISSIONS = ['timeline.read', 'timeline.transform', 'selection.read'] as const

function project(): TimelineState {
  const first = createDefaultTrack('track-a')
  const second = createDefaultTrack('track-b', 1)
  return {
    projectId: 'project',
    randomSeed: 123,
    targetVersion: '1.21.4',
    lengthTicks: 200,
    settings: structuredClone(DEFAULT_SETTINGS),
    master: { ...DEFAULT_MASTER },
    tracks: [first, second],
    markers: [
      {
        id: 'marker-a', trackId: first.id, tick: 10, soundId: 'block.note_block.harp',
        variantIndex: -1, volume: 1, pitch: 1,
      },
      {
        id: 'marker-b', trackId: second.id, tick: 20, soundId: 'block.note_block.bass',
        variantIndex: -1, volume: 0.8, pitch: 0.75,
      },
    ],
  }
}

function numberInput(value: unknown): ExtensionValidationResult<{ value: number }> {
  if (
    typeof value !== 'object'
    || value === null
    || typeof (value as { value?: unknown }).value !== 'number'
  ) return { ok: false, error: 'value must be a number' }
  return { ok: true, value: { value: (value as { value: number }).value } }
}

describe('extension definition validation', () => {
  it('rejects incompatible API versions and dishonest capabilities', () => {
    const command = defineCommand({
      id: 'ping',
      name: 'Ping',
      requiredPermissions: [],
      validateInput: numberInput,
      execute: (_context, input) => input.value,
    })
    const invalid = {
      manifest: {
        apiVersion: '2',
        id: 'example.invalid',
        name: 'Invalid',
        version: '1.0.0',
        permissions: { required: [] },
        capabilities: [],
      },
      contributes: { commands: [command] },
    }
    const result = validateExtensionDefinition(invalid)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues.map(issue => issue.path)).toContain('manifest.apiVersion')
    expect(result.issues.some(issue => issue.message.includes('commands must be declared'))).toBe(true)
  })

  it('rejects duplicate registrations without replacing the first extension', () => {
    const definition = defineExtension({
      manifest: {
        apiVersion: EXTENSION_API_VERSION,
        id: 'example.lifecycle',
        name: 'Lifecycle',
        version: '1.0.0',
        permissions: { required: [] },
        capabilities: [],
      },
    })
    const registry = new ExtensionRegistry()
    registry.register(definition)
    expect(() => registry.register(definition)).toThrow(ExtensionDefinitionError)
    expect(registry.list()).toHaveLength(1)
  })
})

describe('extension lifecycle and failure isolation', () => {
  it('activates once and disposes subscriptions in reverse order', async () => {
    const events: string[] = []
    const definition = defineExtension({
      manifest: {
        apiVersion: EXTENSION_API_VERSION,
        id: 'example.lifecycle',
        name: 'Lifecycle',
        version: '1.0.0',
        permissions: { required: [] },
        capabilities: [],
      },
      activate: (context) => {
        events.push('activate')
        context.subscriptions.add(() => {
          events.push('dispose-a')
        })
        context.subscriptions.add({
          dispose: () => {
            events.push('dispose-b')
          },
        })
        return () => {
          events.push('dispose-returned')
        }
      },
      deactivate: () => { events.push('deactivate') },
    })
    const registry = new ExtensionRegistry()
    registry.register(definition)
    expect((await registry.activate(definition.manifest.id)).ok).toBe(true)
    expect((await registry.activate(definition.manifest.id)).ok).toBe(true)
    expect(registry.get(definition.manifest.id)?.status).toBe('active')
    expect((await registry.deactivate(definition.manifest.id)).ok).toBe(true)
    expect(events).toEqual(['activate', 'dispose-returned', 'dispose-b', 'dispose-a', 'deactivate'])
  })

  it('requires host grants and contains command failures', async () => {
    const failures = vi.fn()
    const double = defineCommand({
      id: 'double',
      name: 'Double',
      requiredPermissions: [],
      validateInput: numberInput,
      execute: (_context, input) => ({ doubled: input.value * 2 }),
    })
    const explode = defineCommand({
      id: 'explode',
      name: 'Explode',
      requiredPermissions: [],
      validateInput: numberInput,
      execute: () => { throw new Error('contained boom') },
    })
    const definition = defineExtension({
      manifest: {
        apiVersion: EXTENSION_API_VERSION,
        id: 'example.commands',
        name: 'Commands',
        version: '1.0.0',
        permissions: { required: ['timeline.read'] },
        capabilities: ['commands'],
      },
      contributes: { commands: [double, explode] },
    })
    const registry = new ExtensionRegistry({ onFailure: failures })
    registry.register(definition)
    const denied = await registry.activate(definition.manifest.id)
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.error.phase).toBe('permission')
    expect(registry.setGrantedPermissions(definition.manifest.id, ['timeline.read']).ok).toBe(true)
    expect((await registry.activate(definition.manifest.id)).ok).toBe(true)
    expect(registry.listCommands(definition.manifest.id).map(command => command.id)).toEqual(['double', 'explode'])

    const badInput = await registry.executeCommandById(definition.manifest.id, 'double', { value: 'x' })
    expect(badInput.ok).toBe(false)
    const exploded = await registry.executeCommand(definition.manifest.id, explode, { value: 1 })
    expect(exploded.ok).toBe(false)
    if (!exploded.ok) {
      expect(exploded.error.phase).toBe('command')
      expect(exploded.error.message).toBe('contained boom')
    }
    const healthy = await registry.executeCommand(definition.manifest.id, double, { value: 21 })
    expect(healthy).toEqual({ ok: true, value: { doubled: 42 } })
    expect(registry.get(definition.manifest.id)?.status).toBe('active')
    expect(failures).toHaveBeenCalled()
  })
})

describe('isolated timeline transforms', () => {
  it('freezes snapshots, rejects malformed output, and leaves host state untouched', async () => {
    const mutateFrozen = defineMarkerTransform({
      id: 'mutate-frozen',
      name: 'Mutate frozen input',
      requiredPermissions: TRANSFORM_PERMISSIONS,
      validateOptions: () => ({ ok: true, value: undefined }),
      transform: (markers) => {
        ;(markers[0] as Marker).tick = 999
        return markers as readonly Marker[]
      },
    })
    const malformed = defineMarkerTransform({
      id: 'malformed',
      name: 'Malformed output',
      requiredPermissions: TRANSFORM_PERMISSIONS,
      validateOptions: () => ({ ok: true, value: undefined }),
      transform: (markers) => {
        const mutableMarkers = structuredClone(markers) as Marker[]
        return mutableMarkers.map(marker => ({ ...marker, volume: 2 }))
      },
    })
    const definition = defineExtension({
      manifest: {
        apiVersion: EXTENSION_API_VERSION,
        id: 'example.marker-safety',
        name: 'Marker Safety',
        version: '1.0.0',
        permissions: { required: TRANSFORM_PERMISSIONS },
        capabilities: ['markerTransforms'],
      },
      contributes: { markerTransforms: [mutateFrozen, malformed] },
    })
    const source = project()
    const registry = new ExtensionRegistry()
    registry.register(definition, TRANSFORM_PERMISSIONS)
    await registry.activate(definition.manifest.id)

    const mutation = await registry.executeMarkerTransform(
      definition.manifest.id,
      mutateFrozen,
      undefined,
      { project: source, markerIds: ['marker-a'] },
    )
    expect(mutation.ok).toBe(false)
    if (!mutation.ok) expect(mutation.error.phase).toBe('transform')
    expect(source.markers[0].tick).toBe(10)

    const invalid = await registry.executeMarkerTransform(
      definition.manifest.id,
      malformed,
      undefined,
      { project: source, markerIds: ['marker-a'] },
    )
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) {
      expect(invalid.error.phase).toBe('validation')
      expect(invalid.error.message).toContain('volume')
    }
    expect(source.markers[0].volume).toBe(1)
  })

  it('applies track transforms only to the explicit target', async () => {
    const rename = defineTrackTransform({
      id: 'rename',
      name: 'Rename',
      requiredPermissions: TRANSFORM_PERMISSIONS,
      validateOptions: (value: unknown): ExtensionValidationResult<{ prefix: string }> => (
        typeof value === 'object' && value !== null && typeof (value as { prefix?: unknown }).prefix === 'string'
          ? { ok: true, value: { prefix: (value as { prefix: string }).prefix } }
          : { ok: false, error: 'prefix must be a string' }
      ),
      transform: (tracks, _context, options) => tracks.map(track => ({ ...track, name: `${options.prefix}${track.name}` })),
    })
    const definition = defineExtension({
      manifest: {
        apiVersion: EXTENSION_API_VERSION,
        id: 'example.track-tools',
        name: 'Track Tools',
        version: '1.0.0',
        permissions: { required: TRANSFORM_PERMISSIONS },
        capabilities: ['trackTransforms'],
      },
      contributes: { trackTransforms: [rename] },
    })
    const source = project()
    source.tracks.splice(1, 0, createDefaultTrack('track-middle', 2))
    const registry = new ExtensionRegistry()
    registry.register(definition, TRANSFORM_PERMISSIONS)
    await registry.activate(definition.manifest.id)
    const renamed = await registry.executeTrackTransform(
      definition.manifest.id,
      rename,
      { prefix: 'FX / ' },
      { project: source, trackIds: ['track-a', 'track-b'] },
    )
    expect(renamed.ok).toBe(true)
    if (!renamed.ok) return
    expect(renamed.value.tracks.map(track => track.name)).toEqual(['FX / Track 1', 'Track 3', 'FX / Track 2'])
    expect(source.tracks.map(track => track.name)).toEqual(['Track 1', 'Track 3', 'Track 2'])
  })
})
