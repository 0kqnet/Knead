import { describe, expect, it } from 'vitest'
import { createDefaultTrack, DEFAULT_MASTER, DEFAULT_SETTINGS, type TimelineState } from '../types/timeline'
import {
  COMMAND_VISUALIZER_TYPES,
  DEFAULT_COMMAND_EXPORT_OPTIONS,
  MAX_COMMAND_EXPORT_EVENTS,
  generateCommandDatapack,
  inferPackFormat,
  inferResourcePackFormat,
  sanitizeNamespace,
  supportsListenerRelativePan,
  type CommandExportOptions,
  type CommandVisualizerType,
} from './commandExport'
import { stableVariantIndex } from './studioMath'

function oggVorbisHeaderBase64(seed = 0): string {
  const bytes = new Uint8Array(58)
  bytes.set([0x4f, 0x67, 0x67, 0x53, 0, 2], 0)
  bytes[14] = seed & 0xff
  bytes[26] = 1
  bytes[27] = 30
  bytes.set([1, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73], 28)
  return btoa(String.fromCharCode(...bytes))
}

function project(): TimelineState {
  return {
    projectId: 'test',
    randomSeed: 1,
    targetVersion: '1.21.4',
    lengthTicks: 80,
    settings: structuredClone(DEFAULT_SETTINGS),
    master: { ...DEFAULT_MASTER, limiterEnabled: false },
    tracks: [createDefaultTrack('track')],
    markers: [{
      id: 'marker', trackId: 'track', tick: 10,
      soundId: 'block.note_block.harp', variantIndex: -1,
      volume: 0.5, pitch: 1.25, duration: 4, retriggerInterval: 2,
    }],
  }
}

type EnabledCommandVisualizer = Exclude<CommandVisualizerType, 'off'>

const VISUALIZER_GOLDENS: Record<EnabledCommandVisualizer, readonly [string, string]> = {
  arc: ['summon minecraft:falling_block ~-4.2 ~ ~', 'Motion:[0d,0.55d,0.35d]'],
  fall: ['summon minecraft:falling_block ~4.2 ~3 ~', 'Motion:[0d,-0.45d,0d]'],
  rise: ['summon minecraft:falling_block ~4.2 ~ ~', 'Motion:[0d,0.45d,0d]'],
  bounce: ['summon minecraft:falling_block ~ ~ ~2.4', 'Motion:[0d,0.6d,0d]'],
  pianoRoll: ['summon minecraft:falling_block ~-4.2 ~ ~', 'Motion:[0d,0d,0.55d]'],
  fountain: ['summon minecraft:falling_block ~ ~ ~', 'Motion:[0.32d,0.62d,0d]'],
  rittaiOnkyou: ['summon minecraft:falling_block ~1 ~2 ~1.44', 'Motion:[0d,-0.22d,0.12d]'],
}

describe('command data pack export', () => {
  it('generates a runnable clock data pack and expands retriggers', () => {
    const result = generateCommandDatapack(project(), DEFAULT_COMMAND_EXPORT_OPTIONS)
    expect(result.eventCount).toBe(3)
    expect(result.startCommand).toBe('/function knead_show:start')
    expect(result.pauseCommand).toBe('/function knead_show:pause')
    expect(result.resumeCommand).toBe('/function knead_show:resume')
    expect(result.uninstallCommand).toBe('/function knead_show:uninstall')
    expect(result.files['data/minecraft/tags/function/load.json']).toContain('knead_show:install')
    expect(result.files['data/knead_show/function/start.mcfunction']).toContain(
      'function knead_show:runtime/dispatch',
    )
    expect(result.files['data/knead_show/function/runtime/tick.mcfunction']).toContain(
      'schedule function knead_show:runtime/tick 1t replace',
    )
    expect(result.files['data/knead_show/function/runtime/dispatch.mcfunction']).toContain(
      'matches 10 run function knead_show:events/tick_10',
    )
    expect(result.files['data/knead_show/function/events/tick_10.mcfunction']).toContain(
      'execute positioned ~ ~ ~ run playsound block.note_block.harp master @a ~ ~ ~ 0.5 1.25 0',
    )
    expect(result.files['data/knead_show/function/events/tick_14.mcfunction']).toContain('playsound')
  })

  it('converts NBS loop timing to the Minecraft clock at export', () => {
    const state = project()
    state.settings.ticksPerQuarter = 4
    state.settings.bpm = 150
    state.settings.loop = { enabled: true, startTick: 4, endTick: 10 }
    state.tempoMap = [{ tick: 6, bpm: 450 }]
    state.markers = [5, 7].map(tick => ({
      ...state.markers[0], id: `note-${tick}`, tick, duration: 0,
    }))
    const result = generateCommandDatapack(state, { ...DEFAULT_COMMAND_EXPORT_OPTIONS, range: 'loop' })
    expect(result.durationTicks).toBe(7)
    expect(result.files['data/knead_show/function/events/tick_2.mcfunction']).toContain('playsound')
    expect(result.files['data/knead_show/function/events/tick_5.mcfunction']).toContain('playsound')
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: 'command.timing.rounded', markerIds: ['note-7'],
    }))
  })

  it('embeds a deterministic, bounded machine-readable compatibility report', () => {
    const state = project()
    state.master.limiterEnabled = true
    state.tempoMap = [
      { tick: 0, bpm: 120, meter: { numerator: 4, denominator: 4 } },
      { tick: 40, bpm: 150, meter: { numerator: 3, denominator: 4 } },
    ]
    state.markers = Array.from({ length: 80 }, (_, index) => ({
      ...state.markers[0],
      id: `marker-${String(index).padStart(3, '0')}`,
      tick: index % 40,
      duration: 0,
      pan: 0.5,
      variantIndex: index,
    }))

    const first = generateCommandDatapack(state, DEFAULT_COMMAND_EXPORT_OPTIONS)
    const second = generateCommandDatapack(state, DEFAULT_COMMAND_EXPORT_OPTIONS)
    const parsed = JSON.parse(first.files['knead-export-report.json'])
    expect(parsed).toEqual(first.report)
    expect(first.files['knead-export-report.json']).toBe(second.files['knead-export-report.json'])
    expect(first.report.schemaVersion).toBe(1)
    expect(first.report.summary.eventCount).toBe(first.eventCount)
    expect(first.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining([
      'command.limiter.omitted',
      'command.panning.omitted',
      'command.pitch.range_baked',
      'command.tempo_map.baked',
      'command.variants.fixed_omitted',
    ]))
    const variants = first.diagnostics.find(item => item.code === 'command.variants.fixed_omitted')
    expect(variants?.markerIds).toHaveLength(64)
    expect(variants?.markerIdCount).toBe(80)
    expect(variants?.markerIds).toEqual([...variants!.markerIds!].sort())
  })

  it('clamps extended DAW pitch per firing with one bounded Minecraft diagnostic', () => {
    const state = project()
    const base = { ...state.markers[0], duration: 0, retriggerInterval: undefined }
    state.markers = [
      { ...base, id: 'high', tick: 1, pitch: 8 },
      { ...base, id: 'low', tick: 2, pitch: 0.125 },
      { ...base, id: 'inside', tick: 3, pitch: 1.25 },
      { ...base, id: 'missing', tick: 4, soundId: '', pitch: 8 },
      {
        ...base, id: 'stop', tick: 5, soundId: '', pitch: 1,
        action: { type: 'sound-stop', scope: 'all' },
      },
    ]
    const result = generateCommandDatapack(state, DEFAULT_COMMAND_EXPORT_OPTIONS)
    expect(result.files['data/knead_show/function/events/tick_1.mcfunction']).toContain(' 0.5 2 0')
    expect(result.files['data/knead_show/function/events/tick_2.mcfunction']).toContain(' 0.5 0.5 0')
    expect(result.files['data/knead_show/function/events/tick_3.mcfunction']).toContain(' 0.5 1.25 0')
    const clamped = result.diagnostics.find(item => item.code === 'command.pitch.minecraft_clamped')
    expect(clamped).toMatchObject({
      severity: 'warning', disposition: 'degraded', markerIds: ['high', 'low'], markerIdCount: 2,
    })
    expect(result.diagnostics.find(item => item.code === 'command.pitch.range_baked'))
      .toMatchObject({ markerIds: ['inside'], markerIdCount: 1 })
  })

  it('reports gated voices without synthesizing unsafe stopsound events', () => {
    const state = project()
    state.markers = [
      {
        ...state.markers[0], id: 'gate-b', tick: 11, duration: 0, retriggerInterval: undefined,
      },
      {
        ...state.markers[0], id: 'gate-a', tick: 10, duration: 0, retriggerInterval: undefined,
      },
    ]
    for (const marker of state.markers) marker.gateTicks = 4

    const result = generateCommandDatapack(state, DEFAULT_COMMAND_EXPORT_OPTIONS)
    const diagnostic = result.diagnostics.find(item => item.code === 'command.gate_length.omitted')
    const eventFunctions = Object.entries(result.files)
      .filter(([path]) => path.includes('/events/'))
      .map(([, contents]) => contents)
      .join('\n')

    expect(diagnostic).toMatchObject({
      severity: 'warning',
      disposition: 'omitted',
      feature: 'gate-length',
      markerIds: ['gate-a', 'gate-b'],
      markerIdCount: 2,
    })
    expect(diagnostic?.message).toMatch(/overlapping voices.*share a sound ID/i)
    expect(eventFunctions.match(/playsound/gu)).toHaveLength(2)
    expect(eventFunctions).not.toContain('stopsound')
  })

  it('reports portable audio that a data pack references or omits', () => {
    const state = project()
    state.customAudio = [{
      soundId: 'custom:bell',
      fileName: 'bell.ogg',
      mimeType: 'audio/ogg',
      byteLength: 4,
      fingerprint: '0'.repeat(64),
      dataBase64: 'AAAAAA==',
      pitch: 1,
    }]
    state.markers[0].soundId = 'custom:bell'
    state.referenceAudio = [{
      id: 'reference',
      name: 'Guide',
      color: 'purple',
      fileName: 'guide.ogg',
      sourcePath: '',
      mimeType: 'audio/ogg',
      byteLength: 4,
      fingerprint: 'deadbeef',
      dataBase64: 'AAAAAA==',
      durationSeconds: 1,
      offsetTicks: 0,
      gainDb: 0,
      pan: 0,
      muted: false,
      solo: false,
      locked: false,
      collapsed: false,
    }]
    const result = generateCommandDatapack(state, DEFAULT_COMMAND_EXPORT_OPTIONS)
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'command.custom_audio.resource_pack_required',
        disposition: 'degraded',
        markerIds: ['marker'],
      }),
      expect.objectContaining({
        code: 'command.reference_audio.omitted',
        disposition: 'omitted',
        trackIds: ['reference'],
      }),
    ]))
  })

  it('writes an isolated companion resource pack and resolves fixed and deterministic variants', () => {
    const state = project()
    const unsafeOriginalId = 'minecraft:../../Custom Bell'
    const firstData = oggVorbisHeaderBase64(1)
    const secondData = oggVorbisHeaderBase64(2)
    state.customAudio = [{
      soundId: unsafeOriginalId,
      fileName: 'first.ogg',
      mimeType: 'audio/ogg',
      byteLength: 58,
      fingerprint: '1'.repeat(64),
      dataBase64: firstData,
      pitch: 0.75,
      volume: 0.5,
      weight: 3,
      stream: true,
      preload: true,
      attenuationDistance: 24,
    }, {
      soundId: unsafeOriginalId,
      fileName: 'second.ogg',
      mimeType: 'audio/ogg',
      byteLength: 58,
      fingerprint: '2'.repeat(64),
      dataBase64: secondData,
      pitch: 1.25,
      volume: 0.8,
      weight: 7,
      stream: false,
      preload: false,
    }]
    state.markers = [{
      ...state.markers[0], id: 'fixed', tick: 10, duration: 0,
      soundId: unsafeOriginalId, variantIndex: 1,
    }, {
      ...state.markers[0], id: 'deterministic', tick: 11, duration: 2, retriggerInterval: 1,
      soundId: unsafeOriginalId, variantIndex: -1,
    }]
    state.markers.push({
      ...state.markers[0],
      id: 'stop-custom-aliases',
      tick: 20,
      soundId: '',
      variantIndex: -1,
      action: { type: 'sound-stop', scope: 'track-range', startTrack: 1, endTrack: 1 },
    })

    const result = generateCommandDatapack(state, {
      ...DEFAULT_COMMAND_EXPORT_OPTIONS,
      namespace: 'minecraft',
      resourcePackFormat: 69,
    })
    const resourcePack = result.resourcePack
    expect(resourcePack).toMatchObject({
      namespace: 'knead_minecraft',
      eventCount: 3,
      variantCount: 2,
      assetCount: 2,
    })
    expect(resourcePack?.files['assets/minecraft/sounds.json']).toBeUndefined()
    const manifestFile = resourcePack?.files['assets/knead_minecraft/sounds.json']
    expect(typeof manifestFile).toBe('string')
    const manifest = JSON.parse(String(manifestFile)) as Record<string, { sounds: Record<string, unknown>[] }>
    const general = Object.entries(manifest).find(([, event]) => event.sounds.length === 2)
    expect(general?.[1].sounds).toEqual([
      expect.objectContaining({
        name: `knead_minecraft:knead/audio/${'1'.repeat(64)}`,
        pitch: 0.75,
        volume: 0.5,
        weight: 3,
        stream: true,
        preload: true,
        attenuation_distance: 24,
      }),
      expect.objectContaining({
        name: `knead_minecraft:knead/audio/${'2'.repeat(64)}`,
        pitch: 1.25,
        volume: 0.8,
        weight: 7,
      }),
    ])
    expect(resourcePack?.files[`assets/knead_minecraft/sounds/knead/audio/${'1'.repeat(64)}.ogg`])
      .toEqual({ encoding: 'base64', data: firstData })
    expect(JSON.parse(String(resourcePack?.files['pack.mcmeta'])).pack).toMatchObject({
      min_format: [69, 0],
      max_format: [69, 0],
    })
    const commands = Object.entries(result.files)
      .filter(([path]) => path.includes('/events/'))
      .map(([, value]) => value)
      .join('\n')
    expect(commands).toContain('playsound knead_minecraft:knead/custom/')
    expect(commands).not.toContain(unsafeOriginalId)
    expect(result.files['data/knead_minecraft/function/events/tick_10.mcfunction'])
      .toContain('/v_0001')
    for (let firingIndex = 0; firingIndex <= 2; firingIndex++) {
      const expectedVariant = stableVariantIndex(state.randomSeed, 'deterministic', firingIndex, 2)
      expect(result.files[`data/knead_minecraft/function/events/tick_${11 + firingIndex}.mcfunction`])
        .toContain(`/v_${String(expectedVariant).padStart(4, '0')}`)
    }
    const stopAliases = result.files['data/knead_minecraft/function/events/tick_20.mcfunction']
    expect(stopAliases).toContain('stopsound @a master knead_minecraft:knead/custom/')
    expect(stopAliases).toContain('/v_0000')
    expect(stopAliases).toContain('/v_0001')
    expect(stopAliases).not.toContain(unsafeOriginalId)
    expect(result.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining([
      'command.custom_audio.resource_pack_generated',
      'command.variants.deterministic_resource_alias',
      'command.variants.fixed_resource_alias',
    ]))
    expect(result.warnings).not.toContain('fixedVariant')
    expect(resourcePack?.files['knead-resource-pack-report.json']).toEqual(
      generateCommandDatapack(state, {
        ...DEFAULT_COMMAND_EXPORT_OPTIONS,
        namespace: 'minecraft',
        resourcePackFormat: 69,
      }).resourcePack?.files['knead-resource-pack-report.json'],
    )
  })

  it('omits non-Vorbis and missing custom assets with explicit diagnostics', () => {
    const state = project()
    const base = {
      fileName: 'sample.bin',
      byteLength: 4,
      fingerprint: 'a'.repeat(64),
      dataBase64: 'AAAAAA==',
      pitch: 1,
    }
    state.customAudio = [{ ...base, soundId: 'custom:wav', mimeType: 'audio/wav' },
      { ...base, soundId: 'custom:mp3', mimeType: 'audio/mpeg', fingerprint: 'b'.repeat(64) },
      { ...base, soundId: 'custom:unknown', mimeType: 'application/octet-stream', fingerprint: 'c'.repeat(64) },
      { ...base, soundId: 'custom:invalid-ogg', mimeType: 'audio/ogg', fingerprint: 'd'.repeat(64) },
      {
        ...base,
        soundId: 'custom:missing',
        mimeType: 'audio/ogg',
        byteLength: 58,
        fingerprint: 'e'.repeat(64),
      }]
    state.markers = state.customAudio.map((asset, index) => ({
      ...state.markers[0], id: `codec-${index}`, tick: 10 + index, duration: 0,
      soundId: asset.soundId,
    }))
    const result = generateCommandDatapack(state, DEFAULT_COMMAND_EXPORT_OPTIONS)
    expect(result.resourcePack).toBeNull()
    expect(result.diagnostics.map(item => item.code)).toEqual(expect.arrayContaining([
      'command.custom_audio.wav_omitted',
      'command.custom_audio.mp3_omitted',
      'command.custom_audio.codec_omitted',
      'command.custom_audio.invalid_ogg_omitted',
      'command.custom_audio.missing_asset_omitted',
      'command.custom_audio.resource_pack_required',
    ]))
  })

  it('infers official data-pack formats for legacy and numbered releases', () => {
    expect(inferPackFormat('1.19.2')).toBe(10)
    expect(inferPackFormat('1.21.5')).toBe(71)
    expect(inferPackFormat('26.1')).toBe(101.1)
    expect(inferPackFormat('26.1-snapshot-8')).toBe(99.2)
    expect(inferPackFormat('26.2')).toBe(107.1)
    expect(inferPackFormat('26.2-snapshot-7')).toBe(105.1)
    expect(inferPackFormat('26.3-snapshot-5')).toBe(112)
    expect(inferPackFormat('26.3-snapshot-6')).toBe(113)
  })

  it('infers resource-pack formats independently from data-pack formats', () => {
    expect(inferResourcePackFormat('1.21.4')).toBe(46)
    expect(inferResourcePackFormat('1.21.5')).toBe(55)
    expect(inferResourcePackFormat('1.21.9')).toBe(69)
    expect(inferResourcePackFormat('1.21.11')).toBe(75)
    expect(inferResourcePackFormat('26.1')).toBe(84)
    expect(inferResourcePackFormat('26.1-snapshot-8')).toBe(81.1)
    expect(inferResourcePackFormat('26.2')).toBe(88)
    expect(inferResourcePackFormat('26.2-snapshot-4')).toBe(86.1)
    expect(inferResourcePackFormat('26.2-snapshot-7')).toBe(87)
    expect(inferResourcePackFormat('26.3-snapshot-4')).toBe(92)
    expect(inferResourcePackFormat('26.3-snapshot-5')).toBe(93)
    expect(inferResourcePackFormat('26.3-snapshot-6')).toBe(94)
  })

  it('exports and repeats a loop range relative to its start', () => {
    const state = project()
    state.settings.loop = { enabled: true, startTick: 10, endTick: 14 }
    const result = generateCommandDatapack(state, {
      ...DEFAULT_COMMAND_EXPORT_OPTIONS,
      range: 'loop',
      loopPlayback: true,
    })
    expect(result.durationTicks).toBe(4)
    expect(result.files['data/knead_show/function/runtime/dispatch.mcfunction']).toContain(
      'matches 0 run function knead_show:events/tick_0',
    )
    expect(result.files['data/knead_show/function/events/tick_0.mcfunction']).toContain('playsound')
    expect(result.files['data/knead_show/function/events/tick_4.mcfunction']).toBeUndefined()
    expect(result.files['data/knead_show/function/runtime/finish.mcfunction']).toContain(
      'function knead_show:runtime/repeat',
    )
    expect(result.files['data/knead_show/function/runtime/repeat.mcfunction']).toContain(
      'scoreboard players add #loops',
    )
    expect(result.files['data/knead_show/function/runtime/repeat.mcfunction']).toContain(
      'function knead_show:runtime/dispatch',
    )
  })

  it('stops loop-range playback after the configured finite repeat count', () => {
    const state = project()
    state.settings.loop = {
      enabled: true,
      startTick: 10,
      endTick: 14,
      maxLoopCount: 3,
    }
    const result = generateCommandDatapack(state, {
      ...DEFAULT_COMMAND_EXPORT_OPTIONS,
      range: 'loop',
      loopPlayback: true,
    })
    const start = result.files['data/knead_show/function/start.mcfunction']
    const finish = result.files['data/knead_show/function/runtime/finish.mcfunction']
    expect(start).toContain('scoreboard players set #loops')
    expect(finish).toContain('matches 3.. run scoreboard players set #state')
    expect(finish).toContain('matches ..2 run function knead_show:runtime/repeat')
    expect(result.files['README.txt']).toContain('repeat selected range 3 additional time(s)')
  })

  it('falls back from an invalid loop range and reports it', () => {
    const state = project()
    state.settings.loop = { enabled: false, startTick: 20, endTick: 20 }
    const result = generateCommandDatapack(state, { ...DEFAULT_COMMAND_EXPORT_OPTIONS, range: 'loop' })
    expect(result.durationTicks).toBe(80)
    expect(result.warnings).toContain('invalidLoopRange')
  })

  it('omits muted tracks unless explicitly requested', () => {
    const state = project()
    state.tracks[0].muted = true
    const omitted = generateCommandDatapack(state, DEFAULT_COMMAND_EXPORT_OPTIONS)
    expect(omitted.eventCount).toBe(0)
    expect(omitted.files['data/knead_show/function/stop.mcfunction']).not.toContain(
      'block.note_block.harp',
    )
    const included = generateCommandDatapack(state, {
      ...DEFAULT_COMMAND_EXPORT_OPTIONS,
      includeMutedTracks: true,
    })
    expect(included.eventCount).toBe(3)
    expect(included.files['data/knead_show/function/stop.mcfunction']).toContain(
      'block.note_block.harp',
    )
  })

  it('sanitizes namespaces and selects version-aware layouts', () => {
    expect(sanitizeNamespace(' My Show! ')).toBe('my_show')
    expect(sanitizeNamespace('minecraft')).toBe('knead_minecraft')
    expect(sanitizeNamespace('../../')).toBe('knead_show')
    expect(inferPackFormat('1.21.4')).toBe(61)
    const state = project()
    state.targetVersion = '1.20.4'
    const result = generateCommandDatapack(state, DEFAULT_COMMAND_EXPORT_OPTIONS)
    expect(result.files['data/knead_show/functions/start.mcfunction']).toBeTruthy()
    expect(result.files['data/minecraft/tags/functions/load.json']).toBeTruthy()
  })

  it('uses the new min/max metadata format for current Minecraft releases', () => {
    const state = project()
    state.targetVersion = '26.1'
    const options = { ...DEFAULT_COMMAND_EXPORT_OPTIONS, packFormat: inferPackFormat(state.targetVersion) }
    const metadata = JSON.parse(generateCommandDatapack(state, options).files['pack.mcmeta'])
    expect(metadata.pack.min_format).toEqual([101, 1])
    expect(metadata.pack.max_format).toEqual([101, 1])
    expect(metadata.pack.pack_format).toBeUndefined()
  })

  it('supports pause/resume and removes its isolated objective on uninstall', () => {
    const result = generateCommandDatapack(project(), DEFAULT_COMMAND_EXPORT_OPTIONS)
    const install = result.files['data/knead_show/function/install.mcfunction']
    const objective = /scoreboard objectives add (kn_[a-z0-9]+) dummy/.exec(install)?.[1]
    expect(objective).toBeTruthy()
    expect(result.files['data/knead_show/function/pause.mcfunction']).toContain(
      `scoreboard players set #state ${objective} 2`,
    )
    expect(result.files['data/knead_show/function/pause.mcfunction']).toContain(
      'schedule clear knead_show:runtime/tick',
    )
    expect(result.files['data/knead_show/function/resume.mcfunction']).toContain(
      `if score #state ${objective} matches 2 run schedule function`,
    )
    expect(result.files['data/knead_show/function/uninstall.mcfunction']).toContain(
      `scoreboard objectives remove ${objective}`,
    )
  })

  it('uses a safe nearby audience centered on the playback position', () => {
    const result = generateCommandDatapack(project(), {
      ...DEFAULT_COMMAND_EXPORT_OPTIONS,
      audience: 'nearby',
      nearbyRadius: 24.4,
      position: '10 64 -2',
    })
    expect(result.files['data/knead_show/function/events/tick_10.mcfunction']).toContain(
      'execute positioned 10 64 -2 run playsound block.note_block.harp master @a[distance=..24] ~ ~ ~',
    )
    expect(result.files['data/knead_show/function/stop.mcfunction']).toContain(
      'execute positioned 10 64 -2 run stopsound @a[distance=..24]',
    )
  })

  it('normalizes unsafe command fields and skips injected sound ids', () => {
    const state = project()
    state.markers[0].soundId = 'harp\nsay injected'
    const result = generateCommandDatapack(state, {
      ...DEFAULT_COMMAND_EXPORT_OPTIONS,
      audience: 'custom',
      target: '@a\nsay injected',
      source: 'master\nsay injected',
      position: '~ ~\nsay injected',
    })
    expect(result.eventCount).toBe(0)
    expect(result.skippedEventCount).toBe(3)
    expect(result.warnings).toEqual(expect.arrayContaining([
      'invalidSoundId', 'invalidTarget', 'invalidSource', 'invalidPosition',
    ]))
    expect(Object.values(result.files).join('\n')).not.toContain('say injected')
  })

  it('can leave active sounds alone while still stopping the clock', () => {
    const result = generateCommandDatapack(project(), {
      ...DEFAULT_COMMAND_EXPORT_OPTIONS,
      includeStopCommands: false,
    })
    const stop = result.files['data/knead_show/function/stop.mcfunction']
    const pause = result.files['data/knead_show/function/pause.mcfunction']
    expect(stop).toContain('schedule clear knead_show:runtime/tick')
    expect(stop).not.toContain('stopsound')
    expect(pause).not.toContain('stopsound')
  })

  it('uses a balanced dispatcher when a show has many distinct event ticks', () => {
    const state = project()
    state.markers = Array.from({ length: 20 }, (_, tick) => ({
      ...state.markers[0],
      id: `marker-${tick}`,
      tick,
      duration: 0,
    }))
    const result = generateCommandDatapack(state, DEFAULT_COMMAND_EXPORT_OPTIONS)
    const root = result.files['data/knead_show/function/runtime/dispatch.mcfunction']
    expect(root).toContain('matches 0..9 run function knead_show:runtime/dispatch/node_')
    expect(root).toContain('matches 10..19 run function knead_show:runtime/dispatch/node_')
    expect(Object.keys(result.files).filter(path => path.includes('/runtime/dispatch/node_')).length).toBeGreaterThan(2)
  })

  it('only expands retriggers that intersect the selected range', () => {
    const state = project()
    state.markers[0].duration = 1_000_000_000
    state.markers[0].retriggerInterval = 1
    const result = generateCommandDatapack(state, DEFAULT_COMMAND_EXPORT_OPTIONS)
    expect(result.eventCount).toBe(70)
    expect(result.files['data/knead_show/function/events/tick_79.mcfunction']).toContain('playsound')
    expect(result.files['data/knead_show/function/events/tick_80.mcfunction']).toBeUndefined()
  })

  it('keeps world-position playback unchanged and reports omitted pan', () => {
    const state = project()
    state.markers[0].pan = 0.5
    const result = generateCommandDatapack(state, DEFAULT_COMMAND_EXPORT_OPTIONS)
    expect(result.warnings).toContain('pan')
    expect(result.files['data/knead_show/function/events/tick_10.mcfunction']).toContain(
      'execute positioned ~ ~ ~ run playsound block.note_block.harp master @a ~ ~ ~',
    )
  })

  it('clamps combined track and marker pan into listener-relative local coordinates', () => {
    const state = project()
    state.tracks[0].pan = 0.8
    state.markers[0].pan = 0.6
    const result = generateCommandDatapack(state, {
      ...DEFAULT_COMMAND_EXPORT_OPTIONS,
      panMode: 'listener',
      listenerPanWidth: 2,
    })
    const tick = result.files['data/knead_show/function/events/tick_10.mcfunction']
    expect(tick).toContain(
      'execute positioned ~ ~ ~ as @a at @s rotated as @s anchored eyes positioned ^-2 ^ ^',
    )
    expect(tick).toContain(
      'run playsound block.note_block.harp master @s ~ ~ ~ 0.5 1.25 0',
    )
    expect(result.warnings).not.toContain('pan')
  })

  it.each([
    ['all', '@a'],
    ['nearby', '@a[distance=..24]'],
    ['custom', '@a[tag=band]'],
  ] as const)('fans out listener-relative audio safely for the %s audience', (audience, target) => {
    const state = project()
    state.tracks[0].pan = -0.25
    state.markers[0].pan = -0.25
    const result = generateCommandDatapack(state, {
      ...DEFAULT_COMMAND_EXPORT_OPTIONS,
      audience,
      target: audience === 'custom' ? target : DEFAULT_COMMAND_EXPORT_OPTIONS.target,
      nearbyRadius: 24,
      position: '10 64 -2',
      panMode: 'listener',
      listenerPanWidth: 3,
    })
    const tick = result.files['data/knead_show/function/events/tick_10.mcfunction']
    expect(tick).toContain(
      `execute positioned 10 64 -2 as ${target} at @s rotated as @s anchored eyes positioned ^1.5 ^ ^`,
    )
    expect(tick).toContain('run playsound block.note_block.harp master @s')
    expect(tick).not.toContain(`playsound block.note_block.harp master ${target}`)
  })

  it('keeps pause, stop, and Sound Stopper audience semantics in listener mode', () => {
    const state = project()
    state.markers.push({
      ...state.markers[0],
      id: 'stop-all',
      tick: 20,
      soundId: '',
      duration: 0,
      action: { type: 'sound-stop', scope: 'all' },
    })
    const result = generateCommandDatapack(state, {
      ...DEFAULT_COMMAND_EXPORT_OPTIONS,
      audience: 'nearby',
      nearbyRadius: 24,
      position: '10 64 -2',
      panMode: 'listener',
    })
    const stop = 'execute positioned 10 64 -2 run stopsound @a[distance=..24] master'
    expect(result.files['data/knead_show/function/events/tick_20.mcfunction']).toBe(`${stop}\n`)
    expect(result.files['data/knead_show/function/pause.mcfunction']).toContain(
      `${stop} block.note_block.harp`,
    )
    expect(result.files['data/knead_show/function/stop.mcfunction']).toContain(
      `${stop} block.note_block.harp`,
    )
  })

  it('degrades listener panning before Java 1.13 with explicit warnings', () => {
    const state = project()
    state.targetVersion = '1.12.2'
    state.markers[0].pan = 0.5
    const result = generateCommandDatapack(state, {
      ...DEFAULT_COMMAND_EXPORT_OPTIONS,
      panMode: 'listener',
    })
    const tick = result.files['data/knead_show/functions/events/tick_10.mcfunction']
    expect(tick).toContain('execute positioned ~ ~ ~ run playsound')
    expect(tick).not.toContain('at @s')
    expect(result.warnings).toEqual(expect.arrayContaining(['legacyPan', 'pan', 'legacySchedule']))
  })

  it('uses the exact 18w02a local-coordinate snapshot boundary conservatively', () => {
    expect(supportsListenerRelativePan('18w01a')).toBe(false)
    expect(supportsListenerRelativePan('18w02a')).toBe(true)
    expect(supportsListenerRelativePan('1.12.2')).toBe(false)
    expect(supportsListenerRelativePan('1.13')).toBe(true)
    expect(supportsListenerRelativePan('unknown')).toBe(false)
  })

  it('normalizes listener width and hostile command fields without injection', () => {
    const state = project()
    state.markers[0].pan = 1
    const result = generateCommandDatapack(state, {
      ...DEFAULT_COMMAND_EXPORT_OPTIONS,
      audience: 'custom',
      target: '@a\nsay target_injected',
      source: 'master\nsay source_injected',
      position: '~ ~ ~\nsay position_injected',
      panMode: 'listener',
      listenerPanWidth: '2\nsay width_injected' as unknown as number,
    })
    const output = Object.values(result.files).join('\n')
    const tick = result.files['data/knead_show/function/events/tick_10.mcfunction']
    expect(tick).toContain(
      'execute positioned ~ ~ ~ as @a at @s rotated as @s anchored eyes positioned ^-2 ^ ^',
    )
    expect(result.warnings).toEqual(expect.arrayContaining([
      'invalidTarget', 'invalidSource', 'invalidPosition', 'listenerPanOptionsClamped',
    ]))
    expect(output).not.toContain('injected')
  })

  it('exports an all-scope Sound Stopper without visualizing it', () => {
    const state = project()
    state.markers.push({
      ...state.markers[0],
      id: 'stop-all',
      tick: 20,
      soundId: '',
      duration: 0,
      action: { type: 'sound-stop', scope: 'all' },
    })
    const result = generateCommandDatapack(state, {
      ...DEFAULT_COMMAND_EXPORT_OPTIONS,
      visualizerType: 'arc',
    })
    const stopEvent = result.files['data/knead_show/function/events/tick_20.mcfunction']
    expect(stopEvent).toBe('execute positioned ~ ~ ~ run stopsound @a master\n')
    expect(stopEvent).not.toContain('summon')
    expect(stopEvent).not.toContain('particle')
  })

  it('deduplicates ranged Sound Stopper IDs and warns about out-of-range overlap', () => {
    const state = project()
    state.tracks = [createDefaultTrack('one'), createDefaultTrack('two'), createDefaultTrack('three')]
    const base = state.markers[0]
    state.markers = [{
      ...base, id: 'one-a', trackId: 'one', tick: 1, soundId: 'test:a', duration: 0,
    }, {
      ...base, id: 'two-b', trackId: 'two', tick: 2, soundId: 'test:b', duration: 0,
    }, {
      ...base, id: 'two-a', trackId: 'two', tick: 3, soundId: 'test:a', duration: 0,
    }, {
      ...base, id: 'three-a', trackId: 'three', tick: 4, soundId: 'test:a', duration: 0,
    }, {
      ...base,
      id: 'stop-range',
      trackId: 'one',
      tick: 20,
      soundId: '',
      duration: 0,
      action: { type: 'sound-stop', scope: 'track-range', startTrack: 1, endTrack: 2 },
    }]
    const result = generateCommandDatapack(state, DEFAULT_COMMAND_EXPORT_OPTIONS)
    const stopEvent = result.files['data/knead_show/function/events/tick_20.mcfunction']
    expect(stopEvent).toContain('stopsound @a master test:a')
    expect(stopEvent).toContain('stopsound @a master test:b')
    expect(stopEvent.match(/stopsound @a master test:a/gu)).toHaveLength(1)
    expect(result.warnings).toContain('soundStopRangeOverlap')
  })

  it('orders same-tick Sound Stoppers by track, after playable notes on the same track', () => {
    const state = project()
    state.tracks = [createDefaultTrack('one'), createDefaultTrack('two')]
    const base = state.markers[0]

    state.markers = [{
      ...base, id: 'stop-upper', trackId: 'one', tick: 10, soundId: '', duration: 0,
      action: { type: 'sound-stop', scope: 'all' },
    }, {
      ...base, id: 'play-lower', trackId: 'two', tick: 10, duration: 0,
    }]
    const upperStop = generateCommandDatapack(state, DEFAULT_COMMAND_EXPORT_OPTIONS)
      .files['data/knead_show/function/events/tick_10.mcfunction']
    expect(upperStop.indexOf('stopsound')).toBeLessThan(upperStop.indexOf('playsound'))

    state.markers = [{
      ...base, id: 'play-same-track', trackId: 'one', tick: 10, duration: 0,
    }, {
      ...base, id: 'stop-same-track', trackId: 'one', tick: 10, soundId: '', duration: 0,
      action: { type: 'sound-stop', scope: 'all' },
    }]
    const sameTrackStop = generateCommandDatapack(state, DEFAULT_COMMAND_EXPORT_OPTIONS)
      .files['data/knead_show/function/events/tick_10.mcfunction']
    expect(sameTrackStop.indexOf('playsound')).toBeLessThan(sameTrackStop.indexOf('stopsound'))
  })

  it.each(['muted', 'excluded-by-solo'] as const)(
    'does not let %s tracks widen a ranged Sound Stopper',
    (audibility) => {
      const state = project()
      state.tracks = [createDefaultTrack('one'), createDefaultTrack('two')]
      if (audibility === 'muted') state.tracks[1].muted = true
      else state.tracks[0].solo = true
      const base = state.markers[0]
      state.markers = [{
        ...base, id: 'selected', trackId: 'one', tick: 1, soundId: 'test:a', duration: 0,
      }, {
        ...base, id: 'inaudible', trackId: 'two', tick: 2, soundId: 'test:a', duration: 0,
      }, {
        ...base, id: 'stop', trackId: 'one', tick: 20, soundId: '', duration: 0,
        action: { type: 'sound-stop', scope: 'track-range', startTrack: 2, endTrack: 2 },
      }]

      const result = generateCommandDatapack(state, DEFAULT_COMMAND_EXPORT_OPTIONS)
      expect(result.files['data/knead_show/function/events/tick_20.mcfunction']).toBeUndefined()
      expect(result.warnings).not.toContain('soundStopRangeOverlap')

      const includingMuted = generateCommandDatapack(state, {
        ...DEFAULT_COMMAND_EXPORT_OPTIONS,
        includeMutedTracks: true,
      })
      expect(includingMuted.files['data/knead_show/function/events/tick_20.mcfunction']).toContain(
        'stopsound @a master test:a',
      )
      expect(includingMuted.warnings).toContain('soundStopRangeOverlap')
    },
  )

  it('does not widen a loop-range Sound Stopper with sounds outside the exported range', () => {
    const state = project()
    state.settings.loop = { enabled: true, startTick: 10, endTick: 20 }
    state.markers = [{
      ...state.markers[0], id: 'outside-loop', tick: 1, duration: 0, soundId: 'test:outside',
    }, {
      ...state.markers[0], id: 'stop', tick: 15, soundId: '', duration: 0,
      action: { type: 'sound-stop', scope: 'track-range', startTrack: 1, endTrack: 1 },
    }]

    const result = generateCommandDatapack(state, {
      ...DEFAULT_COMMAND_EXPORT_OPTIONS,
      range: 'loop',
    })
    expect(result.eventCount).toBe(0)
    expect(result.files['data/knead_show/function/events/tick_5.mcfunction']).toBeUndefined()
    expect(Object.values(result.files).join('\n')).not.toContain('test:outside')
  })

  it.each(Object.entries(VISUALIZER_GOLDENS))(
    'generates the %s visualizer geometry from the reusable contract',
    (type, expected) => {
      const state = project()
      state.markers[0].pitch = 2
      state.markers[0].pan = 0.25
      const result = generateCommandDatapack(state, {
        ...DEFAULT_COMMAND_EXPORT_OPTIONS,
        visualizerType: type as EnabledCommandVisualizer,
        visualizerOrigin: '10 70 -2',
        visualizerGlow: true,
        visualizerDensity: 3,
      })
      const tick = result.files['data/knead_show/function/events/tick_10.mcfunction']
      expect(tick).toContain(`execute positioned 10 70 -2 run ${expected[0]}`)
      expect(tick).toContain(expected[1])
      expect(tick).toContain('BlockState:{Name:"minecraft:white_concrete"}')
      expect(tick).toContain('Glowing:1b')
      expect(tick).toContain('particle minecraft:note')
      expect(tick).toContain('0.05 0.05 0.05 0 3 force @a')
    },
  )

  it('cleans namespace-isolated visual entities on every transport boundary', () => {
    const options = {
      ...DEFAULT_COMMAND_EXPORT_OPTIONS,
      namespace: 'show_one',
      visualizerType: 'arc' as const,
      loopPlayback: true,
    }
    const result = generateCommandDatapack(project(), options)
    const cleanupPath = 'data/show_one/function/runtime/visual_cleanup.mcfunction'
    const cleanup = result.files[cleanupPath]
    const tag = /tag=(knv_[a-z0-9]+)/.exec(cleanup)?.[1]
    expect(tag).toBeTruthy()
    expect(cleanup).toBe(`kill @e[type=minecraft:falling_block,tag=${tag}]\n`)
    for (const path of ['pause', 'stop', 'runtime/finish']) {
      expect(result.files[`data/show_one/function/${path}.mcfunction`]).toContain(
        'function show_one:runtime/visual_cleanup',
      )
    }
    expect(result.files['data/show_one/function/uninstall.mcfunction']).toContain('function show_one:stop')
    expect(result.files['data/show_one/function/runtime/tick.mcfunction']).toContain(
      `@e[type=minecraft:falling_block,tag=${tag},scores=`,
    )
    expect(result.files['data/show_one/function/start.mcfunction']).toContain('function show_one:stop')

    const other = generateCommandDatapack(project(), { ...options, namespace: 'show_two' })
    expect(other.files['data/show_two/function/runtime/visual_cleanup.mcfunction']).not.toContain(String(tag))
    expect(Object.values(result.files).join('\n')).not.toContain('tag=nbs')
  })

  it('degrades Minecraft 1.13 visualizers to particles with an explicit warning', () => {
    const state = project()
    state.targetVersion = '1.13.2'
    const result = generateCommandDatapack(state, {
      ...DEFAULT_COMMAND_EXPORT_OPTIONS,
      visualizerType: 'fall',
    })
    const tick = result.files['data/knead_show/functions/events/tick_10.mcfunction']
    expect(tick).toContain('particle minecraft:note')
    expect(tick).not.toContain('summon minecraft:falling_block')
    expect(result.warnings).toContain('legacyVisualizer')
    expect(result.warnings).not.toContain('legacySchedule')
    expect(result.files['data/minecraft/tags/functions/tick.json']).toContain(
      'knead_show:runtime/tick_driver',
    )
    expect(Object.values(result.files).join('\n')).not.toMatch(/\bschedule\b/u)
    expect(result.files['data/knead_show/functions/runtime/visual_cleanup.mcfunction']).toContain(
      'short-lived particles only',
    )
  })

  it('hard-caps events and clamps hostile visualizer options without command injection', () => {
    const state = project()
    state.lengthTicks = 1
    state.markers = Array.from({ length: MAX_COMMAND_EXPORT_EVENTS + 37 }, (_, index) => ({
      ...state.markers[0],
      id: `marker-${index}`,
      tick: 0,
      duration: 0,
    }))
    const result = generateCommandDatapack(state, {
      ...DEFAULT_COMMAND_EXPORT_OPTIONS,
      visualizerType: 'arc',
      visualizerOrigin: '~ ~ ~\nsay injected',
      visualizerPlacement: 'north\nkill @e' as CommandExportOptions['visualizerPlacement'],
      visualizerDensity: 999,
      visualizerScale: 999,
      visualizerColorMapping: 'track\nsay injected' as CommandExportOptions['visualizerColorMapping'],
    })
    const output = Object.values(result.files).join('\n')
    expect(result.eventCount).toBe(MAX_COMMAND_EXPORT_EVENTS)
    expect(result.skippedEventCount).toBeGreaterThan(0)
    expect(result.warnings).toEqual(expect.arrayContaining([
      'largeExport', 'invalidVisualizerOrigin', 'visualizerOptionsClamped',
    ]))
    expect(output).not.toContain('say injected')
    expect(output).not.toContain('kill @e\n')
    expect(result.files['data/knead_show/function/events/tick_0.mcfunction']).toContain(
      '0.05 0.05 0.05 0 8 force @a',
    )
  })

  it('keeps the published visualizer type list aligned with all seven contracts', () => {
    expect(COMMAND_VISUALIZER_TYPES.filter(type => type !== 'off').sort()).toEqual(
      Object.keys(VISUALIZER_GOLDENS).sort(),
    )
  })
})
