import { describe, expect, it } from 'vitest'
import { resolveResourcePackSounds, type ResourcePackLayerInput } from './resourcePack'

function layer(overrides: Partial<ResourcePackLayerInput> = {}): ResourcePackLayerInput {
  return {
    namespace: 'example',
    soundsJson: JSON.stringify({
      kick: {
        subtitle: 'subtitles.example.kick',
        sounds: [
          'drums/kick',
          { name: 'drums/kick_soft', pitch: 0.75, volume: 0.5, weight: 3, stream: true, preload: true },
        ],
      },
    }),
    assets: [
      { path: 'assets/example/sounds/drums/kick.ogg', hash: 'kick-v1' },
      { path: 'assets/example/sounds/drums/kick_soft.ogg', hash: 'kick-soft' },
    ],
    ...overrides,
  }
}

describe('resource-pack sounds.json resolver', () => {
  it('resolves file entries and preserves playback metadata', () => {
    const result = resolveResourcePackSounds([layer()])
    expect(result.warnings).toEqual([])
    expect(result.sounds).toEqual([{
      id: 'example:kick',
      subtitle: 'subtitles.example.kick',
      variants: [
        {
          path: 'assets/example/sounds/drums/kick.ogg', hash: 'kick-v1', pitch: 1,
          volume: 1, weight: 1, stream: false, preload: false, attenuationDistance: undefined,
        },
        {
          path: 'assets/example/sounds/drums/kick_soft.ogg', hash: 'kick-soft', pitch: 0.75,
          volume: 0.5, weight: 3, stream: true, preload: true, attenuationDistance: undefined,
        },
      ],
    }])
  })

  it('merges lower layers, overrides asset bytes, and honors replace', () => {
    const base = layer({
      soundsJson: JSON.stringify({ kick: { sounds: ['drums/kick'] } }),
      assets: [{ path: 'assets/example/sounds/drums/kick.ogg', hash: 'base' }],
    })
    const appended = layer({
      soundsJson: JSON.stringify({ kick: { sounds: ['drums/extra'] } }),
      assets: [
        { path: 'assets/example/sounds/drums/kick.ogg', hash: 'overridden-by-priority' },
        { path: 'assets/example/sounds/drums/extra.ogg', hash: 'extra' },
      ],
    })
    const merged = resolveResourcePackSounds([base, appended])
    expect(merged.sounds[0].variants.map(variant => variant.hash)).toEqual(['overridden-by-priority', 'extra'])

    const replaced = resolveResourcePackSounds([base, {
      ...appended,
      soundsJson: JSON.stringify({ kick: { replace: true, sounds: ['drums/extra'] } }),
    }])
    expect(replaced.sounds[0].variants.map(variant => variant.hash)).toEqual(['extra'])
  })

  it('flattens namespaced event references with inherited factors', () => {
    const result = resolveResourcePackSounds([layer({
      soundsJson: JSON.stringify({
        'source': { sounds: [{ name: 'minecraft:shared', type: 'event', pitch: 0.5, volume: 0.5, weight: 2 }] },
        'minecraft:shared': {
          sounds: [{
            name: 'minecraft:block/note', pitch: 3, volume: 3, weight: 4,
            attenuation_distance: 32,
          }],
        },
      }),
      assets: [{ path: 'assets/minecraft/sounds/block/note.ogg', hash: 'note' }],
    })])
    expect(result.warnings).toEqual([])
    expect(result.sounds.find(sound => sound.id === 'example:source')?.variants).toEqual([{
      path: 'assets/minecraft/sounds/block/note.ogg', hash: 'note',
      pitch: 1.5, volume: 1, weight: 8, stream: false, preload: false, attenuationDistance: 32,
    }])
  })

  it('contains cycles and reports missing files/events without silent variants', () => {
    const result = resolveResourcePackSounds([layer({
      soundsJson: JSON.stringify({
        cycle_a: { sounds: [{ name: 'cycle_b', type: 'event' }] },
        cycle_b: { sounds: [{ name: 'cycle_a', type: 'event' }] },
        missing_event: { sounds: [{ name: 'does_not_exist', type: 'event' }] },
        missing_file: { sounds: ['missing/file'] },
      }),
      assets: [],
    })])
    expect(result.sounds).toEqual([])
    expect(result.warnings.join('\n')).toMatch(/cycle/i)
    expect(result.warnings.join('\n')).toMatch(/Referenced sound event is missing/)
    expect(result.warnings.join('\n')).toMatch(/Sound file is missing/)
  })

  it('rejects traversal, malformed fields, duplicate assets, and oversized manifests', () => {
    expect(() => resolveResourcePackSounds([layer({
      soundsJson: JSON.stringify({ bad: { sounds: ['../escape'] } }),
    })])).toThrow(/resource path/i)
    expect(() => resolveResourcePackSounds([layer({
      soundsJson: JSON.stringify({ bad: { sounds: [{ name: 'x', weight: 0 }] } }),
    })])).toThrow(/weight/i)
    expect(() => resolveResourcePackSounds([layer({
      assets: [
        { path: 'assets/example/sounds/a.ogg', hash: 'a' },
        { path: 'assets/example/sounds/a.ogg', hash: 'b' },
      ],
    })])).toThrow(/Duplicate/i)
    expect(() => resolveResourcePackSounds([layer({ soundsJson: `{"a":{"sounds":[]},"padding":"${'x'.repeat(4 * 1024 * 1024)}"}` })]))
      .toThrow(/size limit/i)
  })
})
