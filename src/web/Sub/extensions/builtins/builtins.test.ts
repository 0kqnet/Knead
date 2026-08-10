import { describe, expect, it } from 'vitest'
import { DEFAULT_MASTER, DEFAULT_SETTINGS, createDefaultTrack, type TimelineState } from '../../types/timeline'
import { ExtensionRegistry } from '../registry'
import {
  DEFAULT_HUMANIZE_OPTIONS,
  humanizeExtension,
  humanizeMarkers,
  humanizeTransform,
} from './humanize'
import {
  DEFAULT_NOTE_BLOCK_COMPOSER_OPTIONS,
  noteBlockComposerExtension,
  noteBlockComposerTransform,
  noteBlockPresetCommand,
} from './noteBlockComposer'

const TRANSFORM_PERMISSIONS = ['timeline.read', 'timeline.transform', 'selection.read'] as const

function project(): TimelineState {
  const track = createDefaultTrack('track')
  return {
    projectId: 'project',
    randomSeed: 0x1234_5678,
    targetVersion: '1.21.4',
    lengthTicks: 200,
    settings: structuredClone(DEFAULT_SETTINGS),
    master: { ...DEFAULT_MASTER },
    tracks: [track],
    markers: [{
      id: 'root',
      trackId: track.id,
      tick: 198,
      soundId: 'block.note_block.harp',
      variantIndex: -1,
      volume: 1,
      pitch: 1,
      laneY: 0.5,
      duration: 4,
      volumeCurve: { keyframes: [{ tick: 0, value: 1, interpolation: 'linear' }] },
      pitchCurve: { keyframes: [{ tick: 0, value: 1, interpolation: 'linear' }] },
    }],
  }
}

describe('Knead Humanize extension', () => {
  it('is deterministic, bounded, and does not mutate its source project', async () => {
    const source = project()
    const before = structuredClone(source)
    const registry = new ExtensionRegistry()
    registry.register(humanizeExtension, TRANSFORM_PERMISSIONS)
    await registry.activate(humanizeExtension.manifest.id)
    const options = {
      ...DEFAULT_HUMANIZE_OPTIONS,
      timingJitterTicks: 4,
      volumeJitter: 0.2,
      pitchJitterCents: 50,
      laneJitter: 0.1,
      seed: 99,
    }
    const first = await registry.executeMarkerTransform(
      humanizeExtension.manifest.id,
      humanizeTransform,
      options,
      { project: source, markerIds: ['root'] },
    )
    const second = await registry.executeMarkerTransform(
      humanizeExtension.manifest.id,
      humanizeTransform,
      options,
      { project: source, markerIds: ['root'] },
    )
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(first.value.markers).toEqual(second.value.markers)
    expect(first.value.markers[0].tick).toBeGreaterThanOrEqual(0)
    expect(first.value.markers[0].volume).toBeGreaterThanOrEqual(0)
    expect(first.value.markers[0].volume).toBeLessThanOrEqual(1)
    expect(first.value.markers[0].pitch).toBeGreaterThanOrEqual(0.5)
    expect(first.value.markers[0].pitch).toBeLessThanOrEqual(2)
    expect(source).toEqual(before)
  })

  it('humanizes Sound Stopper timing without inventing playable audio fields', () => {
    const source = project().markers[0]
    const stopper = {
      ...source,
      id: 'stop',
      soundId: '',
      volume: 1,
      pitch: 1,
      duration: undefined,
      volumeCurve: undefined,
      pitchCurve: undefined,
      action: { type: 'sound-stop' as const, scope: 'all' as const },
    }
    const [result] = humanizeMarkers([stopper], {
      ...DEFAULT_HUMANIZE_OPTIONS,
      timingJitterTicks: 4,
      volumeJitter: 0.5,
      pitchJitterCents: 100,
    }, 123)
    expect(result).toMatchObject({ soundId: '', volume: 1, pitch: 1, action: stopper.action })
    expect(result.duration).toBeUndefined()
  })
})

describe('Knead Note Block Composer extension', () => {
  it('provides typed presets and expands a marker into a major chord', async () => {
    const source = project()
    const registry = new ExtensionRegistry()
    registry.register(noteBlockComposerExtension, TRANSFORM_PERMISSIONS)
    await registry.activate(noteBlockComposerExtension.manifest.id)
    const preset = await registry.executeCommand(
      noteBlockComposerExtension.manifest.id,
      noteBlockPresetCommand,
      { preset: 'major', pattern: 'chord' },
    )
    expect(preset.ok).toBe(true)
    if (!preset.ok) return
    const composed = await registry.executeMarkerTransform(
      noteBlockComposerExtension.manifest.id,
      noteBlockComposerTransform,
      preset.value,
      { project: source, markerIds: ['root'] },
    )
    expect(composed.ok).toBe(true)
    if (!composed.ok) return
    expect(composed.value.markers).toHaveLength(3)
    expect(composed.value.markers.map(marker => marker.tick)).toEqual([198, 198, 198])
    expect(composed.value.markers.map(marker => marker.pitch)).toEqual([
      1,
      2 ** (4 / 12),
      2 ** (7 / 12),
    ])
    expect(new Set(composed.value.markers.map(marker => marker.id)).size).toBe(3)
    expect(composed.value.lengthTicks).toBeGreaterThan(200)
    expect(source.markers).toHaveLength(1)
  })

  it('uses integer tick steps for arpeggios and rejects unsafe option shapes', async () => {
    const registry = new ExtensionRegistry()
    registry.register(noteBlockComposerExtension, TRANSFORM_PERMISSIONS)
    await registry.activate(noteBlockComposerExtension.manifest.id)
    const options = {
      ...DEFAULT_NOTE_BLOCK_COMPOSER_OPTIONS,
      pattern: 'arpeggio' as const,
      intervals: [0, 3, 7],
      stepTicks: 3,
    }
    const composed = await registry.executeMarkerTransform(
      noteBlockComposerExtension.manifest.id,
      noteBlockComposerTransform,
      options,
      { project: project(), markerIds: ['root'] },
    )
    expect(composed.ok).toBe(true)
    if (composed.ok) expect(composed.value.markers.map(marker => marker.tick)).toEqual([198, 201, 204])

    const rejected = await registry.executeMarkerTransformById(
      noteBlockComposerExtension.manifest.id,
      noteBlockComposerTransform.id,
      { ...options, intervals: new Array(20).fill(0) },
      { project: project(), markerIds: ['root'] },
    )
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.error.phase).toBe('validation')
  })

  it('retains selected Sound Stoppers as one functional event instead of chord voices', async () => {
    const source = project()
    source.markers.push({
      ...source.markers[0],
      id: 'stop',
      tick: 190,
      soundId: '',
      duration: undefined,
      volumeCurve: undefined,
      pitchCurve: undefined,
      action: { type: 'sound-stop', scope: 'track-range', startTrack: 1, endTrack: 1 },
    })
    const registry = new ExtensionRegistry()
    registry.register(noteBlockComposerExtension, TRANSFORM_PERMISSIONS)
    await registry.activate(noteBlockComposerExtension.manifest.id)
    const composed = await registry.executeMarkerTransform(
      noteBlockComposerExtension.manifest.id,
      noteBlockComposerTransform,
      DEFAULT_NOTE_BLOCK_COMPOSER_OPTIONS,
      { project: source, markerIds: ['root', 'stop'] },
    )
    expect(composed.ok).toBe(true)
    if (!composed.ok) return
    const stoppers = composed.value.markers.filter(marker => marker.action?.type === 'sound-stop')
    expect(stoppers).toHaveLength(1)
    expect(stoppers[0]).toMatchObject({ id: 'stop', tick: 190, soundId: '' })
  })
})
