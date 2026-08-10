import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NbsBundleInstrumentAudio } from './nbsBundle'
import { createDefaultTrack, DEFAULT_SETTINGS, type TimelineState } from '../types/timeline'
import { parse, serialize } from './timelineIO'
import {
  activatePreparedProjectCustomAudioRegistry,
  clearProjectCustomAudio,
  embedProjectCustomAudio,
  getProjectCustomAudioData,
  getProjectCustomAudioSnapshot,
  isProjectCustomAudioKey,
  prepareProjectCustomAudio,
  prepareProjectCustomAudioAssets,
  prepareProjectCustomAudioRegistry,
  replaceProjectCustomAudio,
  restoreProjectCustomAudio,
  subscribeProjectCustomAudio,
} from './projectCustomAudio'

function audio(
  soundId: string,
  archivePath: string,
  data: Uint8Array,
  customInstrumentIndex = 0,
): NbsBundleInstrumentAudio {
  return {
    customInstrumentIndex,
    instrumentId: 16 + customInstrumentIndex,
    instrument: { name: soundId, file: archivePath.replace(/^sounds\//u, ''), key: 45, pressKey: true },
    soundId,
    archivePath,
    mediaType: 'audio/ogg',
    data,
  }
}

afterEach(() => clearProjectCustomAudio())

describe('project custom audio registry', () => {
  it('verifies without mutation and commits a prepared registry synchronously once', async () => {
    const old = await prepareProjectCustomAudioAssets([{
      soundId: 'old', fileName: 'old.ogg', mimeType: 'audio/ogg', data: Uint8Array.of(1), pitch: 1,
    }])
    await restoreProjectCustomAudio(old)
    const before = getProjectCustomAudioSnapshot()
    const changed = vi.fn()
    const unsubscribe = subscribeProjectCustomAudio(changed)
    const next = await prepareProjectCustomAudioAssets([{
      soundId: 'next', fileName: 'next.ogg', mimeType: 'audio/ogg', data: Uint8Array.of(2), pitch: 1,
    }])
    const preparing = prepareProjectCustomAudioRegistry(next)
    next[0].soundId = 'mutated-after-call'
    const prepared = await preparing

    expect(getProjectCustomAudioSnapshot()).toBe(before)
    expect(changed).not.toHaveBeenCalled()
    expect(prepared.manifest).toHaveProperty('next')
    const installed = activatePreparedProjectCustomAudioRegistry(prepared)
    expect(installed).toEqual({ installedSounds: 1, installedAssets: 1, warnings: [] })
    expect(getProjectCustomAudioSnapshot()).toMatchObject({
      generation: before.generation + 1,
      manifest: { next: expect.any(Array) },
    })
    expect(changed).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it('rejects failed or forged preparations without replacing the active registry', async () => {
    const old = await prepareProjectCustomAudioAssets([{
      soundId: 'old', fileName: 'old.ogg', mimeType: 'audio/ogg', data: Uint8Array.of(1), pitch: 1,
    }])
    await restoreProjectCustomAudio(old)
    const before = getProjectCustomAudioSnapshot()
    await expect(prepareProjectCustomAudioRegistry([{
      ...old[0],
      soundId: 'tampered',
      dataBase64: 'Ag==',
    }])).rejects.toThrow(/fingerprint mismatch/i)
    expect(getProjectCustomAudioSnapshot()).toBe(before)
    expect(() => activatePreparedProjectCustomAudioRegistry({
      manifest: Object.freeze({}),
      installedSounds: 0,
      installedAssets: 0,
      warnings: Object.freeze([]),
    })).toThrow(/invalid prepared/i)
    expect(getProjectCustomAudioSnapshot()).toBe(before)
  })

  it('prepares multiple generic variants, retains resource metadata, and deduplicates a content pair', async () => {
    const first = Uint8Array.of(1, 2, 3)
    const second = Uint8Array.of(4, 5, 6)
    const assets = await prepareProjectCustomAudioAssets([
      {
        soundId: 'example:event', fileName: 'first.ogg', mimeType: 'audio/ogg', data: first,
        pitch: 0.75, volume: 0.5, weight: 3, stream: true, preload: true, attenuationDistance: 24,
      },
      {
        soundId: 'example:event', fileName: 'duplicate-name.ogg', mimeType: 'audio/ogg', data: first,
        pitch: 1,
      },
      {
        soundId: 'example:event', fileName: 'second.ogg', mimeType: 'audio/ogg', data: second,
        pitch: 1.25, volume: 0.8, weight: 2, stream: false, preload: false,
      },
    ])
    expect(assets).toHaveLength(2)
    expect(assets[0]).toMatchObject({
      fileName: 'first.ogg', pitch: 0.75, volume: 0.5, weight: 3,
      stream: true, preload: true, attenuationDistance: 24,
    })
    expect(assets[1].fingerprint).not.toBe(assets[0].fingerprint)

    const serialized = serialize({
      projectId: 'metadata', randomSeed: 1, targetVersion: '1.21.4', lengthTicks: 200,
      settings: structuredClone(DEFAULT_SETTINGS),
      master: { gainDb: 0, limiterEnabled: false, limiterCeilingDb: -1 },
      tracks: [createDefaultTrack('track')], markers: [], customAudio: assets,
    })
    const parsed = parse(serialized)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    await restoreProjectCustomAudio(parsed.state.customAudio ?? [])
    expect(getProjectCustomAudioSnapshot().manifest['example:event']).toEqual([
      expect.objectContaining({ pitch: 0.75, volume: 0.5, weight: 3, stream: true, preload: true, attenuationDistance: 24 }),
      expect.objectContaining({ pitch: 1.25, volume: 0.8, weight: 2, stream: false, preload: false }),
    ])
  })

  it('installs content-addressed sound variants and returns defensive audio copies', async () => {
    const changed = vi.fn()
    const unsubscribe = subscribeProjectCustomAudio(changed)
    const bytes = Uint8Array.of(0x4f, 0x67, 0x67, 0x53, 1, 2, 3)
    const result = await replaceProjectCustomAudio([
      audio('nbs:custom/lead', 'sounds/lead.ogg', bytes),
      audio('nbs:custom/copy', 'sounds/copy.ogg', bytes, 1),
    ])
    expect(result).toMatchObject({ installedSounds: 2, installedAssets: 1, warnings: [] })
    expect(changed).toHaveBeenCalledTimes(1)
    const snapshot = getProjectCustomAudioSnapshot()
    const lead = snapshot.manifest['nbs:custom/lead'][0]
    const copy = snapshot.manifest['nbs:custom/copy'][0]
    expect(isProjectCustomAudioKey(lead.hash)).toBe(true)
    expect(copy.hash).toBe(lead.hash)
    const first = new Uint8Array(getProjectCustomAudioData(lead.hash) ?? new ArrayBuffer(0))
    first[0] = 0
    expect(new Uint8Array(getProjectCustomAudioData(lead.hash) ?? new ArrayBuffer(0))).toEqual(bytes)
    unsubscribe()
  })

  it('uses stable SHA-256 keys and only base64-embeds custom variants at export time', async () => {
    const bytes = Uint8Array.of(1, 2, 3, 4)
    await replaceProjectCustomAudio([audio('nbs:custom/lead', 'sounds/lead.ogg', bytes)])
    const first = getProjectCustomAudioSnapshot().manifest['nbs:custom/lead'][0].hash
    await replaceProjectCustomAudio([audio('nbs:custom/lead', 'sounds/renamed.ogg', bytes)])
    const secondSnapshot = getProjectCustomAudioSnapshot()
    const second = secondSnapshot.manifest['nbs:custom/lead'][0].hash
    expect(second).toBe(first)
    const embedded = embedProjectCustomAudio({
      ...secondSnapshot.manifest,
      'block.note_block.harp': [{ path: 'harp.ogg', hash: 'minecraft-hash', pitch: 1 }],
    })
    expect(embedded['nbs:custom/lead'][0].dataBase64).toBe('AQIDBA==')
    expect(embedded['block.note_block.harp'][0]).not.toHaveProperty('dataBase64')
  })

  it('atomically replaces scopes and reports unrepresentable soundId collisions', async () => {
    await replaceProjectCustomAudio([audio('old', 'sounds/old.ogg', Uint8Array.of(1))])
    const before = getProjectCustomAudioSnapshot().generation
    const result = await replaceProjectCustomAudio([
      audio('collision', 'sounds/a.ogg', Uint8Array.of(2)),
      audio('collision', 'sounds/b.ogg', Uint8Array.of(3), 1),
    ])
    const snapshot = getProjectCustomAudioSnapshot()
    expect(snapshot.generation).toBe(before + 1)
    expect(snapshot.manifest).not.toHaveProperty('old')
    expect(snapshot.manifest.collision).toHaveLength(1)
    expect(result.warnings.join('\n')).toMatch(/soundId collision/i)
  })

  it('round-trips portable project assets and rejects fingerprint tampering before replacement', async () => {
    const prepared = await prepareProjectCustomAudio([
      audio('portable', 'sounds/portable.ogg', Uint8Array.of(1, 2, 3)),
    ])
    expect(prepared.assets[0].fingerprint).toMatch(/^[0-9a-f]{64}$/u)
    await restoreProjectCustomAudio(prepared.assets)
    expect(getProjectCustomAudioSnapshot().manifest.portable).toHaveLength(1)
    const generation = getProjectCustomAudioSnapshot().generation
    await expect(restoreProjectCustomAudio([{
      ...prepared.assets[0],
      dataBase64: 'BAUG',
    }])).rejects.toThrow(/fingerprint mismatch/i)
    expect(getProjectCustomAudioSnapshot().generation).toBe(generation)
  })

  it('survives a normal .kp serialize/parse/reopen cycle with playable bytes', async () => {
    const prepared = await prepareProjectCustomAudio([
      audio('portable', 'sounds/portable.ogg', Uint8Array.of(7, 8, 9)),
    ])
    const track = createDefaultTrack('track')
    const state: TimelineState = {
      projectId: 'portable-project',
      randomSeed: 1,
      targetVersion: '1.21.4',
      lengthTicks: 200,
      settings: structuredClone(DEFAULT_SETTINGS),
      master: { gainDb: 0, limiterEnabled: false, limiterCeilingDb: -1 },
      tracks: [track],
      markers: [{
        id: 'marker', trackId: track.id, tick: 0, soundId: 'portable',
        variantIndex: -1, volume: 1, pitch: 1,
      }],
      customAudio: prepared.assets,
    }
    const parsed = parse(serialize(state))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    clearProjectCustomAudio()
    await restoreProjectCustomAudio(parsed.state.customAudio ?? [])
    const key = getProjectCustomAudioSnapshot().manifest.portable[0].hash
    expect(new Uint8Array(getProjectCustomAudioData(key) ?? new ArrayBuffer(0))).toEqual(Uint8Array.of(7, 8, 9))
  })
})
