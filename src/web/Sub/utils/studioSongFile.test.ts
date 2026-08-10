import { describe, expect, it } from 'vitest'
import type { TimelineOpenResult } from '../../../../@types/global'
import { createDefaultTimelineState } from '../hooks/useTimeline'
import type { TimelineState } from '../types/timeline'
import { parseNbs, writeNbs, type NbsSong, type NbsTargetVersion } from './nbs'
import {
  attachPlainNbsCustomAudio,
  getPlainNbsCustomAudioFileNames,
  getPlainNbsLossWarnings,
  MAX_STUDIO_NBS_BYTES,
  parseStudioSongFile,
  serializeStudioSongFile,
} from './studioSongFile'

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function nbsSong(version: NbsTargetVersion): NbsSong {
  return {
    header: {
      version,
      vanillaInstrumentCount: version === 0 ? 10 : version >= 6 ? 20 : 16,
      songLength: 8,
      layerCount: 1,
      name: `Version ${version}`,
      author: '',
      originalAuthor: '',
      description: '',
      tempo: 1000,
      autoSave: false,
      autoSaveDuration: 10,
      timeSignature: 4,
      minutesSpent: 0,
      leftClicks: 0,
      rightClicks: 0,
      blocksAdded: 1,
      blocksRemoved: 0,
      sourceFile: '',
      loop: false,
      maxLoopCount: 0,
      loopStartTick: 0,
    },
    notes: [{ tick: 1, layer: 0, instrument: 0, key: 45, velocity: 100, panning: 100, pitch: 0 }],
    layers: [{ name: 'Layer', locked: false, volume: 100, panning: 100 }],
    customInstruments: [],
  }
}

function nbsOpen(version: NbsTargetVersion): Extract<TimelineOpenResult, { ok: true }> {
  return {
    ok: true,
    path: `C:\\Songs\\v${version}.nbs`,
    kind: 'nbs',
    dataBase64: base64(writeNbs(nbsSong(version), version)),
  }
}

describe('studioSongFile', () => {
  it('prepares direct-NBS custom audio while excluding exact functional instruments', async () => {
    const song = nbsSong(5)
    song.customInstruments = [
      { name: 'Lead', file: 'kit/lead.ogg', key: 45, pressKey: false },
      { name: 'Sound Stopper', file: 'must-not-load.wav', key: 45, pressKey: false },
      { name: 'Tempo Changer', file: 'must-not-load.ogg', key: 45, pressKey: false },
    ]
    song.notes = [{
      tick: 1,
      layer: 0,
      instrument: song.header.vanillaInstrumentCount,
      key: 45,
      velocity: 100,
      panning: 100,
      pitch: 0,
    }]
    const opened = parseStudioSongFile({
      ok: true,
      path: 'C:\\Songs\\custom.nbs',
      kind: 'nbs',
      dataBase64: base64(writeNbs(song, 5)),
    })
    expect(opened.ok).toBe(true)
    if (!opened.ok) return
    expect(opened.document.plainNbsCustomAudio).toHaveLength(1)
    expect(getPlainNbsCustomAudioFileNames(opened.document)).toEqual(['kit/lead.ogg'])

    const ogg = Uint8Array.of(0x4f, 0x67, 0x67, 0x53, 1, 2, 3, 4)
    const hydrated = await attachPlainNbsCustomAudio(opened.document, {
      ok: true,
      assets: [{
        fileName: 'kit/lead.ogg',
        mimeType: 'audio/ogg',
        byteLength: ogg.byteLength,
        dataBase64: base64(ogg),
      }],
      warnings: [],
    })
    expect(hydrated.state.customAudio).toHaveLength(1)
    expect(hydrated.state.customAudio?.[0]).toMatchObject({
      soundId: 'nbs:custom/kit/lead',
      fileName: 'kit/lead.ogg',
      mimeType: 'audio/ogg',
      byteLength: ogg.byteLength,
    })
    expect(hydrated.warnings.join('\n')).not.toMatch(/need matching sounds/u)
  })

  it('keeps direct-NBS missing custom audio nonfatal with an explicit warning', async () => {
    const song = nbsSong(5)
    song.customInstruments = [{ name: 'Lead', file: 'missing.wav', key: 45, pressKey: false }]
    song.notes[0].instrument = song.header.vanillaInstrumentCount
    const opened = parseStudioSongFile({
      ok: true,
      path: 'C:\\Songs\\missing.nbs',
      kind: 'nbs',
      dataBase64: base64(writeNbs(song, 5)),
    })
    if (!opened.ok) throw new Error(opened.error)
    const hydrated = await attachPlainNbsCustomAudio(opened.document, {
      ok: true,
      assets: [],
      warnings: ['Custom instrument sound "missing.wav" was not loaded: it was not found.'],
    })
    expect(hydrated.state.customAudio).toEqual([])
    expect(hydrated.warnings.join('\n')).toContain('missing.wav')
    expect(hydrated.warnings.join('\n')).not.toMatch(/need matching sounds/u)
  })

  it.each([0, 1, 2, 3, 4, 5, 6] satisfies NbsTargetVersion[])(
    'opens and preserves NBS source/target version %i',
    (version) => {
      const result = parseStudioSongFile(nbsOpen(version), '1.21.4')
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.document.fileKind).toBe('nbs')
      expect(result.document.nbsTargetVersion).toBe(version)
      expect(result.document.state.source?.format).toBe('nbs')
      expect(result.document.state.source?.format === 'nbs' && result.document.state.source.sourceVersion).toBe(version)

      const saved = serializeStudioSongFile(
        result.document.state,
        'nbs',
        'round-trip.nbs',
        result.document.nbsTargetVersion!,
      )
      expect(saved.payload.kind).toBe('nbs')
      if (saved.payload.kind !== 'nbs') return
      const binary = atob(saved.payload.dataBase64)
      const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
      const parsed = parseNbs(bytes.buffer)
      expect(parsed.ok && parsed.song.header.version).toBe(version)
    },
  )

  it('round-trips .kp through the discriminated open/write payloads', () => {
    const state = createDefaultTimelineState('1.21.4')
    const serialized = serializeStudioSongFile(state, 'kp')
    expect(serialized.lossWarnings).toEqual([])
    expect(serialized.payload.kind).toBe('kp')
    if (serialized.payload.kind !== 'kp') return
    const parsed = parseStudioSongFile({
      ok: true,
      path: 'song.kp',
      kind: 'kp',
      json: serialized.payload.data,
    })
    expect(parsed.ok && parsed.document.fileKind).toBe('kp')
    expect(parsed.ok && parsed.document.state.projectId).toBe(state.projectId)
  })

  it('reports every plain-NBS authoring/asset loss category before save', () => {
    const state = createDefaultTimelineState('1.21.4')
    const trackId = state.tracks[0].id
    const lossy: TimelineState = {
      ...state,
      master: { gainDb: -3, limiterEnabled: true, limiterCeilingDb: -1 },
      tracks: [{ ...state.tracks[0], gainDb: 12, pan: 0.5, solo: true }],
      markers: [{
        id: 'automated',
        trackId,
        tick: 0,
        soundId: 'custom:lead',
        variantIndex: 1,
        volume: 1,
        pitch: 1,
        duration: 4,
        retriggerInterval: 2,
        gateTicks: 2,
        volumeCurve: { keyframes: [{ tick: 0, value: 1, interpolation: 'linear' }] },
      }],
      tempoMap: [
        { tick: 0, bpm: 120, meter: { numerator: 4, denominator: 4 } },
        { tick: 40, bpm: 140 },
      ],
      referenceAudio: [{
        id: 'reference', name: 'Reference', color: 'blue', fileName: 'reference.wav',
        sourcePath: '', mimeType: 'audio/wav', byteLength: 4, fingerprint: '0'.repeat(64),
        dataBase64: 'AAAAAA==', durationSeconds: 1, offsetTicks: 0, gainDb: 0, pan: 0,
        muted: false, solo: false, locked: false, collapsed: false,
      }],
      customAudio: [{
        soundId: 'custom:lead', fileName: 'lead.ogg', mimeType: 'audio/ogg', byteLength: 4,
        fingerprint: '1'.repeat(64), dataBase64: 'AAAAAA==', pitch: 1,
      }],
    }
    const warnings = getPlainNbsLossWarnings(lossy)
    expect(warnings.join('\n')).toMatch(/custom-audio/u)
    expect(warnings.join('\n')).toMatch(/reference-audio/u)
    expect(warnings.join('\n')).toMatch(/tempo\/meter/u)
    expect(warnings.join('\n')).toMatch(/automation/u)
    expect(warnings.join('\n')).toMatch(/duration\/retrigger/u)
    expect(warnings.join('\n')).toMatch(/gate cutoff.*automated/u)
    expect(warnings.join('\n')).toMatch(/variant/u)
    expect(warnings.join('\n')).toMatch(/mixer/u)
    expect(warnings.join('\n')).toMatch(/gain\/pan/u)
    expect(warnings.join('\n')).toMatch(/Master gain/u)
    expect(warnings.join('\n')).toMatch(/limiter/u)

    const serialized = serializeStudioSongFile(lossy, 'nbs', 'lossy.nbs', 5)
    expect(serialized.lossWarnings).toEqual(expect.arrayContaining(warnings))
    expect(serialized.lossWarnings.join('\n')).toMatch(/clipped/u)
    expect(serialized.warnings).toEqual(expect.arrayContaining(warnings))
  })

  it('rejects base64 amplification before decoding an oversized NBS file', () => {
    const oversizedBase64 = 'A'.repeat(Math.ceil((MAX_STUDIO_NBS_BYTES + 4) * 4 / 3))
    const parsed = parseStudioSongFile({
      ok: true,
      path: 'oversized.nbs',
      kind: 'nbs',
      dataBase64: oversizedBase64,
    })
    expect(parsed.ok).toBe(false)
    expect(!parsed.ok && parsed.error).toMatch(/16 MiB/u)
  })
})
