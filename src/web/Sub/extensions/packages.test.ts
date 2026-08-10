import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MASTER,
  DEFAULT_SETTINGS,
  createDefaultTrack,
  type TimelineState,
} from '../types/timeline'
import { ExtensionRegistry } from './registry'
import {
  DECLARATIVE_EXTENSION_FORMAT,
  DECLARATIVE_EXTENSION_SCHEMA_VERSION,
  MAX_EXTENSION_PACKAGE_BYTES,
  type DeclarativeExtensionPackage,
} from './packageTypes'
import {
  packageValidationMessage,
  parseDeclarativeExtensionPackage,
  serializeDeclarativeExtensionPackage,
  validateDeclarativeExtensionPackage,
} from './packageValidation'
import { compileDeclarativeExtensionPackage } from './packageRuntime'
import {
  createInstalledExtension,
  extensionPackageFileName,
  parseInstalledExtensionStore,
  serializeInstalledExtensionStore,
} from './packageStore'

const ALL_PERMISSIONS = ['timeline.read', 'timeline.transform', 'selection.read', 'notifications'] as const

function extensionPackage(): DeclarativeExtensionPackage {
  return {
    format: DECLARATIVE_EXTENSION_FORMAT,
    schemaVersion: DECLARATIVE_EXTENSION_SCHEMA_VERSION,
    manifest: {
      apiVersion: '1',
      id: 'example.safe-tools',
      name: 'Safe Tools',
      version: '1.2.3',
      description: 'A code-free extension package.',
      author: 'Knead SDK example',
      permissions: { required: ALL_PERMISSIONS },
      capabilities: ['commands', 'markerTransforms', 'trackTransforms'],
    },
    contributes: {
      commands: [{
        kind: 'command',
        id: 'summary',
        name: 'Summary',
        requiredPermissions: ['timeline.read', 'selection.read', 'notifications'],
        actions: [
          { op: 'projectSummary' },
          { op: 'selectionSummary' },
          { op: 'notify', level: 'success', message: 'Summary ready' },
        ],
      }],
      markerTransforms: [{
        kind: 'markerTransform',
        id: 'echo-up',
        name: 'Echo Up',
        requiredPermissions: ['timeline.read', 'timeline.transform', 'selection.read'],
        steps: [
          { op: 'transpose', semitones: 2 },
          { op: 'scaleVolume', factor: 0.8 },
          { op: 'duplicate', copies: 2, intervalTicks: 5, semitoneStep: 3, volumeDecay: 0.5 },
        ],
      }],
      trackTransforms: [{
        kind: 'trackTransform',
        id: 'bus-label',
        name: 'Bus Label',
        requiredPermissions: ['timeline.read', 'timeline.transform', 'selection.read'],
        steps: [
          { op: 'prefixName', prefix: '[FX] ' },
          { op: 'adjustGainDb', decibels: -3 },
        ],
      }],
    },
  }
}

function project(markerCount = 1): TimelineState {
  const track = createDefaultTrack('track')
  return {
    projectId: 'project',
    randomSeed: 123,
    targetVersion: '1.21.4',
    lengthTicks: 200,
    settings: structuredClone(DEFAULT_SETTINGS),
    master: { ...DEFAULT_MASTER },
    tracks: [track],
    markers: Array.from({ length: markerCount }, (_, index) => ({
      id: `marker-${index}`,
      trackId: track.id,
      tick: index,
      soundId: 'block.note_block.harp',
      variantIndex: -1,
      volume: 1,
      pitch: 1,
      laneY: 0.5,
    })),
  }
}

describe('declarative extension package schema', () => {
  it('round-trips a strictly validated, versioned package', () => {
    const serialized = serializeDeclarativeExtensionPackage(extensionPackage())
    const parsed = parseDeclarativeExtensionPackage(serialized)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(serializeDeclarativeExtensionPackage(parsed.package)).toBe(serialized)
    expect(parsed.byteLength).toBeLessThan(MAX_EXTENSION_PACKAGE_BYTES)
    expect(extensionPackageFileName(parsed.package)).toBe('example.safe-tools-1.2.3.knead-extension.json')
  })

  it('rejects executable-looking or unknown fields instead of retaining them', () => {
    const candidate = structuredClone(extensionPackage()) as unknown as Record<string, unknown>
    candidate.script = 'globalThis.compromised = true'
    const validated = validateDeclarativeExtensionPackage(candidate)
    expect(validated.ok).toBe(false)
    if (validated.ok) return
    expect(packageValidationMessage(validated.issues)).toContain('$.script: unknown field')

    const contribution = (candidate.contributes as {
      markerTransforms: Record<string, unknown>[]
    }).markerTransforms[0]
    delete candidate.script
    contribution.steps = [{ op: 'javascript', source: 'alert(1)' }]
    const unknownOperation = validateDeclarativeExtensionPackage(candidate)
    expect(unknownOperation.ok).toBe(false)
    if (!unknownOperation.ok) expect(packageValidationMessage(unknownOperation.issues)).toContain('unknown marker operation')
  })

  it('rejects unsupported schemas, capability drift, and oversized inputs', () => {
    const wrongSchema = { ...extensionPackage(), schemaVersion: 2 }
    expect(validateDeclarativeExtensionPackage(wrongSchema).ok).toBe(false)
    const source = extensionPackage()
    const wrongCapabilities = {
      ...source,
      manifest: { ...source.manifest, capabilities: ['commands'] },
    }
    expect(validateDeclarativeExtensionPackage(wrongCapabilities).ok).toBe(false)
    const oversized = parseDeclarativeExtensionPackage(' '.repeat(MAX_EXTENSION_PACKAGE_BYTES + 1))
    expect(oversized.ok).toBe(false)
    if (!oversized.ok) expect(oversized.issues[0].message).toContain('maximum')
  })
})

describe('declarative extension runtime', () => {
  it('interprets approved commands and marker/track pipelines without package code', async () => {
    const notifications = vi.fn()
    const registry = new ExtensionRegistry({ onNotification: notifications })
    const definition = compileDeclarativeExtensionPackage(extensionPackage())
    registry.register(definition, ALL_PERMISSIONS)
    expect((await registry.activate(definition.manifest.id)).ok).toBe(true)
    const source = project()

    const command = await registry.executeCommandById(
      definition.manifest.id,
      'summary',
      {},
      { project: source, selection: { markerIds: ['marker-0'], trackIds: ['track'] } },
    )
    expect(command.ok).toBe(true)
    if (command.ok) {
      expect(command.value).toEqual({
        messages: ['1 tracks, 1 markers, 200 ticks', '1 markers and 1 tracks selected', 'Summary ready'],
      })
    }
    expect(notifications).toHaveBeenCalledWith(expect.objectContaining({ message: 'Summary ready' }))

    const transformed = await registry.executeMarkerTransformById(
      definition.manifest.id,
      'echo-up',
      {},
      { project: source, markerIds: ['marker-0'] },
    )
    expect(transformed.ok).toBe(true)
    if (transformed.ok) {
      expect(transformed.value.markers).toHaveLength(3)
      expect(transformed.value.markers.map(marker => marker.tick)).toEqual([0, 5, 10])
      expect(transformed.value.markers.map(marker => marker.volume)).toEqual([0.8, 0.4, 0.2])
      expect(new Set(transformed.value.markers.map(marker => marker.id)).size).toBe(3)
    }

    const tracks = await registry.executeTrackTransformById(
      definition.manifest.id,
      'bus-label',
      {},
      { project: source, trackIds: ['track'] },
    )
    expect(tracks.ok).toBe(true)
    if (tracks.ok) {
      expect(tracks.value.tracks[0].name).toBe('[FX] Track 1')
      expect(tracks.value.tracks[0].gainDb).toBe(-3)
    }
    expect(source.markers).toHaveLength(1)
    expect(source.tracks[0].name).toBe('Track 1')
  })

  it('isolates expansion-budget failures as registry results', async () => {
    const sourcePackage = extensionPackage()
    const sourceTransform = sourcePackage.contributes.markerTransforms![0]
    const candidate: DeclarativeExtensionPackage = {
      ...sourcePackage,
      contributes: {
        ...sourcePackage.contributes,
        markerTransforms: [{
          ...sourceTransform,
          steps: Array.from({ length: 4 }, () => ({
            op: 'duplicate' as const,
            copies: 16,
            intervalTicks: 0,
            semitoneStep: 0,
            volumeDecay: 1,
          })),
        }],
      },
    }
    const registry = new ExtensionRegistry()
    const definition = compileDeclarativeExtensionPackage(candidate)
    registry.register(definition, ALL_PERMISSIONS)
    await registry.activate(definition.manifest.id)
    const source = project(100)
    const result = await registry.executeMarkerTransformById(
      definition.manifest.id,
      'echo-up',
      {},
      { project: source, markerIds: source.markers.map(marker => marker.id) },
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.phase).toBe('transform')
      expect(result.error.message).toContain('25000')
    }
  })

  it('keeps registry ids collision-safe', () => {
    const definition = compileDeclarativeExtensionPackage(extensionPackage())
    const registry = new ExtensionRegistry()
    registry.register(definition, ALL_PERMISSIONS)
    expect(() => registry.register(definition, ALL_PERMISSIONS)).toThrow(/already registered/)
  })
})

describe('installed declarative extension persistence', () => {
  it('round-trips grants and enabled state', () => {
    const record = createInstalledExtension(extensionPackage(), ALL_PERMISSIONS, true)
    const loaded = parseInstalledExtensionStore(serializeInstalledExtensionStore([record]))
    expect(loaded.warnings).toEqual([])
    expect(loaded.records).toEqual([record])
  })

  it('isolates malformed records and downgrades unsafe enabled state', () => {
    const valid = createInstalledExtension(extensionPackage(), ALL_PERMISSIONS, true)
    const missingRequired = {
      ...valid,
      grantedPermissions: ['notifications'],
      enabled: true,
    }
    const invalid = { package: { format: 'evil' }, grantedPermissions: [], enabled: true }
    const loaded = parseInstalledExtensionStore(JSON.stringify({
      format: 'knead-installed-extensions',
      version: 1,
      packages: [missingRequired, invalid],
    }))
    expect(loaded.records).toHaveLength(1)
    expect(loaded.records[0].enabled).toBe(false)
    expect(loaded.warnings.join(' ')).toContain('missing required grants')
    expect(loaded.warnings.join(' ')).toContain('ignored')
  })

  it('enforces the installed package-count budget before serialization', () => {
    const record = createInstalledExtension(extensionPackage(), ALL_PERMISSIONS)
    expect(() => serializeInstalledExtensionStore(Array.from({ length: 33 }, () => record)))
      .toThrow('Cannot install more than 32')
  })
})
