// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SONG_METADATA,
  MAX_GATE_TICKS,
  MAX_MARKER_PITCH,
  MIN_MARKER_PITCH,
} from '../types/timeline'
import { useTimeline } from './useTimeline'

describe('useTimeline track operations', () => {
  it('adds, edits, duplicates, reorders, and deletes tracks with their markers', () => {
    const { result } = renderHook(() => useTimeline())
    const firstTrackId = result.current.state.tracks[0].id
    let secondTrackId = ''
    act(() => {
      secondTrackId = result.current.addTrack(firstTrackId)
    })
    act(() => {
      result.current.updateTrack(secondTrackId, { name: 'Percussion', gainDb: 30, pan: -2 })
      result.current.addMarker({ tick: 10, trackId: secondTrackId, soundId: 'test' })
    })
    expect(result.current.state.tracks[1]).toMatchObject({
      id: secondTrackId,
      name: 'Percussion',
      gainDb: 12,
      pan: -1,
    })

    let copyId = ''
    act(() => {
      copyId = result.current.duplicateTrack(secondTrackId)
    })
    expect(result.current.state.markers.filter(marker => marker.trackId === copyId)).toHaveLength(1)

    act(() => {
      result.current.reorderTrack(copyId, 0)
    })
    expect(result.current.state.tracks[0].id).toBe(copyId)

    act(() => {
      result.current.removeTrack(secondTrackId)
    })
    expect(result.current.state.tracks.some(track => track.id === secondTrackId)).toBe(false)
    expect(result.current.state.markers.some(marker => marker.trackId === secondTrackId)).toBe(false)
  })

  it('undoes and redoes a grouped marker edit', () => {
    const { result } = renderHook(() => useTimeline())
    let markerId = ''
    act(() => {
      markerId = result.current.addMarker({ tick: 0, soundId: 'test' })
    })
    act(() => {
      result.current.beginTransaction()
      result.current.moveMarker(markerId, 10)
      result.current.moveMarker(markerId, 20)
      result.current.commitTransaction()
    })
    expect(result.current.state.markers[0].tick).toBe(20)

    act(() => result.current.undo())
    expect(result.current.state.markers[0].tick).toBe(0)
    act(() => result.current.redo())
    expect(result.current.state.markers[0].tick).toBe(20)
  })

  it('defaults marker pan to center and clamps marker edits', () => {
    const { result } = renderHook(() => useTimeline())
    expect(result.current.state.settings.panLaw).toBe('cascade')
    let centeredId = ''
    let rightId = ''
    act(() => {
      centeredId = result.current.addMarker({ tick: 0, soundId: 'centered' })
      rightId = result.current.addMarker({ tick: 1, soundId: 'right', pan: 5, gateTicks: MAX_GATE_TICKS + 1 })
    })
    expect(result.current.state.markers.find(marker => marker.id === centeredId)?.pan).toBe(0)
    expect(result.current.state.markers.find(marker => marker.id === rightId)?.pan).toBe(1)
    expect(result.current.state.markers.find(marker => marker.id === rightId)?.gateTicks).toBe(MAX_GATE_TICKS)

    act(() => result.current.updateMarkers([centeredId, rightId], { pan: -5 }))
    expect(result.current.state.markers.every(marker => marker.pan === -1)).toBe(true)

    act(() => result.current.updateMarkers([centeredId, rightId], { gateTicks: 12 }))
    expect(result.current.state.markers.every(marker => marker.gateTicks === 12)).toBe(true)
    act(() => result.current.undo())
    expect(result.current.state.markers.find(marker => marker.id === centeredId)?.gateTicks).toBeUndefined()
    expect(result.current.state.markers.find(marker => marker.id === rightId)?.gateTicks).toBe(MAX_GATE_TICKS)
  })

  it('keeps explicit extended pitch while bounding unsafe marker and curve edits', () => {
    const { result } = renderHook(() => useTimeline())
    let markerId = ''
    act(() => {
      markerId = result.current.addMarker({ tick: 0, soundId: 'extended', pitch: 64 })
    })
    expect(result.current.state.markers[0].pitch).toBe(64)

    act(() => result.current.updateMarker(markerId, {
      pitch: MAX_MARKER_PITCH * 2,
      pitchCurve: { keyframes: [{
        tick: 0,
        value: MIN_MARKER_PITCH / 2,
        interpolation: 'bezier',
        handleR: { dt: 1, dv: MAX_MARKER_PITCH * 2 },
      }] },
    }))
    const bounded = result.current.state.markers[0]
    expect(bounded.pitch).toBe(MAX_MARKER_PITCH)
    expect(bounded.pitchCurve?.keyframes[0].value).toBe(MIN_MARKER_PITCH)
    expect((bounded.pitchCurve?.keyframes[0].value ?? 0)
      + (bounded.pitchCurve?.keyframes[0].handleR?.dv ?? 0)).toBe(MAX_MARKER_PITCH)

    act(() => result.current.updateMarker(markerId, { pitch: Number.NaN }))
    expect(result.current.state.markers[0].pitch).toBe(1)
  })

  it('materializes Sound Stopper events without playable audio fields', () => {
    const { result } = renderHook(() => useTimeline())
    let markerId = ''
    act(() => {
      markerId = result.current.addMarker({
        tick: 4,
        soundId: 'must-be-cleared',
        duration: 20,
        gateTicks: 8,
        volume: 0.25,
        pitch: 2,
        action: {
          type: 'sound-stop',
          scope: 'track-range',
          startTrack: -4,
          endTrack: 99_999,
        },
      })
    })
    expect(result.current.state.markers.find(marker => marker.id === markerId)).toMatchObject({
      soundId: '',
      variantIndex: -1,
      volume: 1,
      pitch: 1,
      pan: 0,
      action: {
        type: 'sound-stop',
        scope: 'track-range',
        startTrack: 1,
        endTrack: 32_767,
      },
    })
    expect(result.current.state.markers.find(marker => marker.id === markerId)?.duration).toBeUndefined()
    expect(result.current.state.markers.find(marker => marker.id === markerId)?.gateTicks).toBeUndefined()
  })

  it('copies frozen Sound Stopper actions when duplicating or pasting markers', () => {
    const { result } = renderHook(() => useTimeline())
    let sourceId = ''
    act(() => {
      sourceId = result.current.addMarker({
        tick: 4,
        action: { type: 'sound-stop', scope: 'track-range', startTrack: 1, endTrack: 2 },
      })
    })
    const source = result.current.state.markers.find(marker => marker.id === sourceId)
    if (!source?.action) throw new Error('Expected Sound Stopper action')
    expect(Object.isFrozen(source.action)).toBe(true)

    let copyId = ''
    expect(() => act(() => {
      copyId = result.current.addMarkers([{ ...source, tick: 8 }])[0]
    })).not.toThrow()
    const copy = result.current.state.markers.find(marker => marker.id === copyId)
    expect(copy?.action).toEqual(source.action)
    expect(copy?.action).not.toBe(source.action)

    act(() => result.current.updateMarkers([sourceId, copyId], {
      action: { type: 'sound-stop', scope: 'track-range', startTrack: 2, endTrack: 4 },
    }))
    const updated = result.current.state.markers.filter(marker => marker.id === sourceId || marker.id === copyId)
    expect(updated.map(marker => marker.action)).toEqual([
      { type: 'sound-stop', scope: 'track-range', startTrack: 2, endTrack: 4 },
      { type: 'sound-stop', scope: 'track-range', startTrack: 2, endTrack: 4 },
    ])
    expect(updated[0].action).not.toBe(updated[1].action)
  })

  it('applies a whole-project transform as one undoable edit', () => {
    const { result } = renderHook(() => useTimeline())
    const originalProjectId = result.current.state.projectId
    const transformed = structuredClone(result.current.state)
    transformed.projectId = 'extension-result'
    transformed.settings.bpm = 180

    act(() => result.current.applyState(transformed))
    expect(result.current.state.projectId).toBe('extension-result')
    expect(result.current.state.settings.bpm).toBe(180)

    act(() => result.current.undo())
    expect(result.current.state.projectId).toBe(originalProjectId)
    expect(result.current.state.settings.bpm).toBe(120)
  })

  it('accepts 2,000 BPM in the project settings and updates the tempo map', () => {
    const { result } = renderHook(() => useTimeline())

    act(() => result.current.setSettings({ bpm: 2_000 }))

    expect(result.current.state.settings.bpm).toBe(2_000)
    expect(result.current.state.tempoMap?.[0]?.bpm).toBe(2_000)
  })

  it('applies a tempo map as one undoable edit without changing unrelated data', () => {
    const { result } = renderHook(() => useTimeline())
    const originalProjectId = result.current.state.projectId
    const originalTrack = structuredClone(result.current.state.tracks[0])
    act(() => result.current.setTempoMap([
      { tick: 0, bpm: 128, meter: { numerator: 7, denominator: 8 } },
      { tick: 320, bpm: 90 },
    ]))
    expect(result.current.state.tempoMap).toEqual([
      { tick: 0, bpm: 128, meter: { numerator: 7, denominator: 8 } },
      { tick: 320, bpm: 90 },
    ])
    expect(result.current.state.settings).toMatchObject({
      bpm: 128,
      timeSignature: { numerator: 7, denominator: 8 },
    })
    expect(result.current.state.lengthTicks).toBeGreaterThanOrEqual(321)
    expect(result.current.state.projectId).toBe(originalProjectId)
    expect(result.current.state.tracks[0]).toEqual(originalTrack)

    act(() => result.current.undo())
    expect(result.current.state.tempoMap).toEqual([{
      tick: 0, bpm: 120, meter: { numerator: 4, denominator: 4 },
    }])
    expect(result.current.state.settings.bpm).toBe(120)
  })

  it('applies song metadata and a finite loop as one undoable edit', () => {
    const { result } = renderHook(() => useTimeline())
    const originalMetadata = structuredClone(result.current.state.metadata)

    act(() => result.current.setSongMetadataAndLoop({
      ...result.current.state.metadata!,
      title: 'Finite Song',
      author: 'Knead',
    }, {
      enabled: true,
      startTick: 20,
      endTick: 80,
      maxLoopCount: 3,
    }))

    expect(result.current.state.metadata).toMatchObject({ title: 'Finite Song', author: 'Knead' })
    expect(result.current.state.settings.loop).toEqual({
      enabled: true,
      startTick: 20,
      endTick: 80,
      maxLoopCount: 3,
    })

    act(() => result.current.undo())
    expect(result.current.state.metadata).toEqual(originalMetadata)
    expect(result.current.state.settings.loop.maxLoopCount).toBe(0)
  })

  it('clamps loop boundaries to the explicit project range', () => {
    const { result } = renderHook(() => useTimeline())
    act(() => {
      result.current.setSettings({
        loop: { enabled: true, startTick: 99_999, endTick: -10 },
      })
    })
    expect(result.current.state.settings.loop.startTick).toBe(result.current.state.lengthTicks - 1)
    expect(result.current.state.settings.loop.endTick).toBe(result.current.state.lengthTicks)
  })

  it('keeps multiple markers on the same track and tick', () => {
    const { result } = renderHook(() => useTimeline())
    const trackId = result.current.state.tracks[0].id
    act(() => {
      result.current.addMarker({ tick: 12, trackId, soundId: 'first' })
      result.current.addMarker({ tick: 12, trackId, soundId: 'second' })
    })
    expect(result.current.state.markers).toHaveLength(2)
    expect(result.current.state.markers.every(item => item.trackId === trackId && item.tick === 12)).toBe(true)
  })

  it('returns the active track when creating a fresh project', () => {
    const { result } = renderHook(() => useTimeline())
    act(() => {
      result.current.addTrack()
      result.current.addMarker({ tick: 12, soundId: 'test' })
    })

    let nextTrackId = ''
    act(() => {
      const nextState = result.current.newProject()
      nextTrackId = nextState.tracks[0].id
    })

    expect(result.current.state.tracks).toHaveLength(1)
    expect(result.current.state.tracks[0].id).toBe(nextTrackId)
    expect(result.current.state.markers).toHaveLength(0)
    expect(result.current.state.metadata).toEqual(DEFAULT_SONG_METADATA)
  })

  it('adds reference audio as an undoable track and extends the timeline', () => {
    const { result } = renderHook(() => useTimeline())
    let id = ''
    act(() => {
      id = result.current.addReferenceAudio({
        name: 'Guide',
        fileName: 'guide.wav',
        sourcePath: 'guide.wav',
        mimeType: 'audio/wav',
        byteLength: 12,
        fingerprint: '1234abcd',
        dataBase64: 'UklGRgAAAABXQVZF',
        durationSeconds: 30,
        offsetTicks: 20,
        gainDb: 0,
        pan: 0,
        muted: false,
        solo: false,
        locked: false,
        collapsed: false,
      })
    })
    expect(result.current.state.referenceAudio?.[0].id).toBe(id)
    expect(result.current.state.lengthTicks).toBeGreaterThanOrEqual(620)

    act(() => {
      result.current.beginTransaction()
      result.current.updateReferenceAudio(id, { offsetTicks: 40, gainDb: 99, pan: -2 })
      result.current.updateReferenceAudio(id, { offsetTicks: 60 })
      result.current.commitTransaction()
    })
    expect(result.current.state.referenceAudio?.[0]).toMatchObject({
      offsetTicks: 60,
      gainDb: 12,
      pan: -1,
    })
    act(() => result.current.undo())
    expect(result.current.state.referenceAudio?.[0].offsetTicks).toBe(20)
    act(() => result.current.removeReferenceAudio(id))
    expect(result.current.state.referenceAudio).toHaveLength(0)
    act(() => result.current.undo())
    expect(result.current.state.referenceAudio).toHaveLength(1)
  })

  it('pastes markers, custom assets, and definitions as one undoable edit', () => {
    const { result } = renderHook(() => useTimeline())
    const trackId = result.current.state.tracks[0].id
    let markerIds: string[] = []
    act(() => {
      markerIds = result.current.pasteMarkersWithAssets({
        markers: [{ tick: 24, trackId, soundId: 'knead:paste/bell', volume: 0.75 }],
        assets: [{
          soundId: 'knead:paste/bell',
          fileName: 'bell.ogg',
          mimeType: 'audio/ogg',
          byteLength: 3,
          fingerprint: 'a'.repeat(64),
          dataBase64: 'YWJj',
          pitch: 1,
        }],
        instruments: [{
          id: 'bell-definition',
          kind: 'audio',
          soundId: 'knead:paste/bell',
          name: 'Bell',
          file: 'bell.ogg',
          key: 45,
          pressKey: true,
          defaultPitch: 1,
        }],
      })
    })

    expect(result.current.state.markers).toMatchObject([{
      id: markerIds[0],
      tick: 24,
      soundId: 'knead:paste/bell',
    }])
    expect(result.current.state.customAudio).toHaveLength(1)
    expect(result.current.state.customInstruments).toHaveLength(1)

    act(() => result.current.undo())
    expect(result.current.state.markers).toHaveLength(0)
    expect(result.current.state.customAudio).toHaveLength(0)
    expect(result.current.state.customInstruments).toHaveLength(0)

    act(() => result.current.redo())
    expect(result.current.state.markers).toHaveLength(1)
    expect(result.current.state.customAudio).toHaveLength(1)
    expect(result.current.state.customInstruments).toHaveLength(1)
  })
})
