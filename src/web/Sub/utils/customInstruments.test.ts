import { describe, expect, it } from 'vitest'
import { createDefaultTimelineState } from '../hooks/useTimeline'
import type { EmbeddedCustomAudioAsset, ProjectCustomInstrument } from '../types/timeline'
import {
  applyProjectCustomInstruments,
  createProjectCustomInstrument,
  deriveProjectCustomInstruments,
  projectCustomInstrumentsFromNbs,
  validateProjectCustomInstruments,
  validateAuthoredNbsInstrumentFile,
} from './customInstruments'

function definition(id: string, soundId: string): ProjectCustomInstrument {
  return {
    id,
    kind: 'audio',
    soundId,
    name: id,
    file: `${id}.ogg`,
    key: 45,
    pressKey: true,
    defaultPitch: 1,
  }
}

function asset(soundId: string, fingerprint = 'a'.repeat(64)): EmbeddedCustomAudioAsset {
  return {
    soundId,
    fileName: 'old.ogg',
    mimeType: 'audio/ogg',
    byteLength: 4,
    fingerprint,
    dataBase64: 'T2dnUw==',
    pitch: 1,
  }
}

describe('project custom instrument authoring model', () => {
  it('derives ordered protected and audio definitions from legacy NBS provenance', () => {
    const state = createDefaultTimelineState()
    state.customInstruments = undefined
    state.source = {
      format: 'nbs', sourceVersion: 5, tickScale: 2, vanillaInstrumentCount: 16,
      songLength: 1, layerCount: 1, name: '', author: '', originalAuthor: '', description: '',
      tempo: 1000, autoSave: false, autoSaveDuration: 10, timeSignature: 4,
      minutesSpent: 0, leftClicks: 0, rightClicks: 0, blocksAdded: 0, blocksRemoved: 0,
      sourceFile: '', loop: false, maxLoopCount: 0, loopStartTick: 0,
      customInstruments: [
        { name: 'Lead', file: 'kit/lead.ogg', key: 40, pressKey: true },
        { name: 'Sound Stopper', file: '', key: 45, pressKey: false },
        { name: 'Tempo Changer', file: '', key: 45, pressKey: false },
      ],
    }
    const result = deriveProjectCustomInstruments(state)
    expect(result.map(item => [item.kind, item.soundId])).toEqual([
      ['audio', 'nbs:custom/kit/lead'],
      ['sound-stopper', ''],
      ['tempo-changer', ''],
    ])
    expect(result[0]).toMatchObject({ key: 40, pressKey: true })
  })

  it('renames marker and embedded-audio references atomically and updates authored defaults', () => {
    const state = createDefaultTimelineState()
    const original = definition('lead', 'knead:custom/lead')
    state.customInstruments = [original]
    state.customAudio = [asset(original.soundId)]
    state.markers = [{
      id: 'note', trackId: state.tracks[0].id, tick: 0, soundId: original.soundId,
      variantIndex: -1, volume: 1, pitch: 1,
    }]
    const next = [{
      ...original,
      soundId: 'knead:custom/super_lead',
      file: 'instruments/super-lead.ogg',
      defaultPitch: 0.75,
    }]
    const applied = applyProjectCustomInstruments(state, next)
    expect(applied.renamedMarkers).toBe(1)
    expect(applied.state.markers[0].soundId).toBe(next[0].soundId)
    expect(applied.state.customAudio?.[0]).toMatchObject({
      soundId: next[0].soundId,
      fileName: next[0].file,
      pitch: 0.75,
    })
    expect(state.markers[0].soundId).toBe(original.soundId)
  })

  it('handles sound-ID swaps from the original snapshot instead of mutation order', () => {
    const state = createDefaultTimelineState()
    const left = definition('left', 'knead:custom/left')
    const right = definition('right', 'knead:custom/right')
    state.customInstruments = [left, right]
    state.markers = [
      { id: 'l', trackId: state.tracks[0].id, tick: 0, soundId: left.soundId, variantIndex: -1, volume: 1, pitch: 1 },
      { id: 'r', trackId: state.tracks[0].id, tick: 1, soundId: right.soundId, variantIndex: -1, volume: 1, pitch: 1 },
    ]
    const applied = applyProjectCustomInstruments(state, [
      { ...left, soundId: right.soundId },
      { ...right, soundId: left.soundId },
    ])
    expect(applied.state.markers.map(marker => marker.soundId)).toEqual([right.soundId, left.soundId])
  })

  it('blocks deletion with live references and protects functional definitions', () => {
    const state = createDefaultTimelineState()
    const lead = definition('lead', 'knead:custom/lead')
    const protectedRows = projectCustomInstrumentsFromNbs([
      { name: 'Sound Stopper', file: '', key: 45, pressKey: false },
    ], 16)
    state.customInstruments = [lead, ...protectedRows]
    state.markers = [{
      id: 'note', trackId: state.tracks[0].id, tick: 0, soundId: lead.soundId,
      variantIndex: -1, volume: 1, pitch: 1,
    }]
    expect(() => applyProjectCustomInstruments(state, protectedRows)).toThrow(/still use/i)
    expect(() => applyProjectCustomInstruments(state, [lead])).toThrow(/protected/i)
  })

  it('validates bounds and creates collision-free portable defaults', () => {
    const first = createProjectCustomInstrument([], 'Epic Lead')
    const second = createProjectCustomInstrument([first], 'Epic Lead')
    expect(first.soundId).toBe('knead:custom/epic_lead')
    expect(second.soundId).toBe('knead:custom/epic_lead_2')
    expect(validateProjectCustomInstruments([first, second])).toBeNull()
    expect(validateProjectCustomInstruments([{ ...first, key: 88 }])).toMatch(/source key/i)
    expect(validateProjectCustomInstruments([{ ...first, name: 'Sound Stopper' }])).toMatch(/reserved exact/i)
    expect(validateProjectCustomInstruments([{ ...first, name: 'Tempo Changer' }])).toMatch(/reserved exact/i)
  })

  it.each([
    '', '/absolute.ogg', 'C:/drive.ogg', '\\\\server\\file.ogg', '../escape.ogg',
    'folder/../escape.ogg', 'folder//empty.ogg', 'folder/trailing. /x.ogg',
    'folder/CON.ogg', 'folder/file.txt', 'folder\\file.ogg',
  ])('rejects unsafe authored NBS file path %j', (file) => {
    expect(validateAuthoredNbsInstrumentFile(file)).not.toBeNull()
  })
})
