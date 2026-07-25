// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
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
  })
})
