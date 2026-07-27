import { useCallback, useMemo, useReducer } from 'react'
import { produce, Draft } from 'immer'
import { v4 as uuidv4 } from 'uuid'
import {
  DEFAULT_MASTER,
  DEFAULT_RETRIGGER_INTERVAL,
  DEFAULT_SETTINGS,
  DEFAULT_TIMELINE_LENGTH_TICKS,
  SINGLE_SHOT_CURVE_PREVIEW_TICKS,
  TRACK_COLORS,
  createDefaultTrack,
  getTimelineLengthTicks,
  snapLaneY,
  type Curve,
  type Marker,
  type MasterBus,
  type Tick,
  type TimelineSettings,
  type TimelineState,
  type Track,
} from '../types/timeline'
import { scaleCurveDuration } from '../utils/curveScaling'

const MAX_HISTORY = 100

function defaultState(): TimelineState {
  return {
    projectId: uuidv4(),
    randomSeed: Math.floor(Math.random() * 0x1_0000_0000),
    targetVersion: '',
    lengthTicks: DEFAULT_TIMELINE_LENGTH_TICKS,
    settings: structuredClone(DEFAULT_SETTINGS),
    master: { ...DEFAULT_MASTER },
    tracks: [createDefaultTrack(uuidv4())],
    markers: [],
  }
}

function resizeMarkerCurves(marker: Draft<Marker>, duration: number): void {
  const oldSpan = marker.duration && marker.duration > 0
    ? marker.duration
    : SINGLE_SHOT_CURVE_PREVIEW_TICKS
  const newSpan = duration > 0 ? duration : SINGLE_SHOT_CURVE_PREVIEW_TICKS
  marker.volumeCurve = scaleCurveDuration(marker.volumeCurve as Curve | undefined, oldSpan, newSpan)
  marker.pitchCurve = scaleCurveDuration(marker.pitchCurve as Curve | undefined, oldSpan, newSpan)
}

function changesDuration(patch: Partial<Marker>, marker: Draft<Marker>): boolean {
  return Object.prototype.hasOwnProperty.call(patch, 'duration') && patch.duration !== marker.duration
}

function extendTimeline(draft: Draft<TimelineState>): void {
  draft.lengthTicks = getTimelineLengthTicks(draft.markers, draft.lengthTicks, draft.settings)
  draft.settings.loop.endTick = Math.min(draft.settings.loop.endTick, draft.lengthTicks)
}

interface History {
  past: TimelineState[]
  current: TimelineState
  future: TimelineState[]
  txSnapshot: TimelineState | null
}

type Action =
  | { type: 'mutate', recipe: (draft: Draft<TimelineState>) => void }
  | { type: 'beginTx' }
  | { type: 'commitTx' }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'replace', state: TimelineState }

function reducer(history: History, action: Action): History {
  switch (action.type) {
    case 'mutate': {
      const next = produce(history.current, action.recipe)
      if (next === history.current) return history
      if (history.txSnapshot !== null) return { ...history, current: next }
      return {
        past: [...history.past, history.current].slice(-MAX_HISTORY),
        current: next,
        future: [],
        txSnapshot: null,
      }
    }
    case 'beginTx':
      return history.txSnapshot === null ? { ...history, txSnapshot: history.current } : history
    case 'commitTx':
      if (history.txSnapshot === null) return history
      if (history.txSnapshot === history.current) return { ...history, txSnapshot: null }
      return {
        past: [...history.past, history.txSnapshot].slice(-MAX_HISTORY),
        current: history.current,
        future: [],
        txSnapshot: null,
      }
    case 'undo': {
      const previous = history.past.at(-1)
      if (!previous) return history
      return {
        past: history.past.slice(0, -1),
        current: previous,
        future: [history.current, ...history.future].slice(0, MAX_HISTORY),
        txSnapshot: null,
      }
    }
    case 'redo': {
      const next = history.future[0]
      if (!next) return history
      return {
        past: [...history.past, history.current].slice(-MAX_HISTORY),
        current: next,
        future: history.future.slice(1),
        txSnapshot: null,
      }
    }
    case 'replace':
      return { past: [], current: action.state, future: [], txSnapshot: null }
  }
}

export function useTimeline(initial?: TimelineState) {
  const [history, dispatch] = useReducer(reducer, undefined, () => ({
    past: [],
    current: initial ?? defaultState(),
    future: [],
    txSnapshot: null,
  }))

  const mutate = useCallback((recipe: (draft: Draft<TimelineState>) => void) => {
    dispatch({ type: 'mutate', recipe })
  }, [])

  const addMarker = useCallback((partial: Partial<Marker> & { tick: Tick }): string => {
    const id = uuidv4()
    mutate((draft) => {
      const trackId = partial.trackId && draft.tracks.some(track => track.id === partial.trackId)
        ? partial.trackId
        : draft.tracks[0].id
      draft.markers.push({
        id,
        trackId,
        tick: Math.max(0, Math.trunc(partial.tick)),
        soundId: partial.soundId ?? '',
        variantIndex: partial.variantIndex ?? -1,
        volume: partial.volume ?? 1,
        pitch: partial.pitch ?? 1,
        duration: partial.duration,
        retriggerInterval: partial.retriggerInterval ?? DEFAULT_RETRIGGER_INTERVAL,
        laneY: partial.laneY === undefined ? undefined : snapLaneY(partial.laneY),
        volumeCurve: partial.volumeCurve,
        pitchCurve: partial.pitchCurve,
      })
      extendTimeline(draft)
    })
    return id
  }, [mutate])

  const addMarkers = useCallback((partials: (Partial<Marker> & { tick: Tick })[]): string[] => {
    const ids = partials.map(() => uuidv4())
    mutate((draft) => {
      partials.forEach((partial, index) => {
        const trackId = partial.trackId && draft.tracks.some(track => track.id === partial.trackId)
          ? partial.trackId
          : draft.tracks[0].id
        draft.markers.push({
          id: ids[index],
          trackId,
          tick: Math.max(0, Math.trunc(partial.tick)),
          soundId: partial.soundId ?? '',
          variantIndex: partial.variantIndex ?? -1,
          volume: partial.volume ?? 1,
          pitch: partial.pitch ?? 1,
          duration: partial.duration,
          retriggerInterval: partial.retriggerInterval ?? DEFAULT_RETRIGGER_INTERVAL,
          laneY: partial.laneY === undefined ? undefined : snapLaneY(partial.laneY),
          volumeCurve: partial.volumeCurve,
          pitchCurve: partial.pitchCurve,
        })
      })
      extendTimeline(draft)
    })
    return ids
  }, [mutate])

  const removeMarkers = useCallback((ids: string[]) => {
    const idSet = new Set(ids)
    mutate((draft) => {
      draft.markers = draft.markers.filter(marker => !idSet.has(marker.id))
    })
  }, [mutate])
  const removeMarker = useCallback((id: string) => removeMarkers([id]), [removeMarkers])

  const updateMarker = useCallback((id: string, patch: Partial<Marker>) => {
    mutate((draft) => {
      const marker = draft.markers.find(item => item.id === id)
      if (!marker) return
      if (changesDuration(patch, marker)) resizeMarkerCurves(marker, patch.duration ?? 0)
      Object.assign(marker, patch)
      marker.tick = Math.max(0, Math.trunc(marker.tick))
      if (marker.laneY !== undefined) marker.laneY = snapLaneY(marker.laneY)
      if (!draft.tracks.some(track => track.id === marker.trackId)) marker.trackId = draft.tracks[0].id
      extendTimeline(draft)
    })
  }, [mutate])

  const updateMarkers = useCallback((ids: string[], patch: Partial<Marker>) => {
    const idSet = new Set(ids)
    mutate((draft) => {
      for (const marker of draft.markers) {
        if (!idSet.has(marker.id)) continue
        if (changesDuration(patch, marker)) resizeMarkerCurves(marker, patch.duration ?? 0)
        Object.assign(marker, patch)
        marker.tick = Math.max(0, Math.trunc(marker.tick))
        if (marker.laneY !== undefined) marker.laneY = snapLaneY(marker.laneY)
        if (!draft.tracks.some(track => track.id === marker.trackId)) marker.trackId = draft.tracks[0].id
      }
      extendTimeline(draft)
    })
  }, [mutate])

  const moveMarker = useCallback((id: string, tick: Tick) => updateMarker(id, { tick }), [updateMarker])
  const moveMarkers = useCallback((positions: Map<string, Tick>) => {
    mutate((draft) => {
      for (const marker of draft.markers) {
        const tick = positions.get(marker.id)
        if (tick !== undefined) marker.tick = Math.max(0, Math.trunc(tick))
      }
      extendTimeline(draft)
    })
  }, [mutate])

  const moveMarkersToTracks = useCallback((
    positions: Map<string, { tick: Tick, trackId: string, laneY?: number }>,
  ) => {
    mutate((draft) => {
      for (const marker of draft.markers) {
        const next = positions.get(marker.id)
        if (!next) continue
        marker.tick = Math.max(0, Math.trunc(next.tick))
        if (draft.tracks.some(track => track.id === next.trackId)) marker.trackId = next.trackId
        if (next.laneY !== undefined) marker.laneY = snapLaneY(next.laneY)
      }
      extendTimeline(draft)
    })
  }, [mutate])

  const addTrack = useCallback((afterId?: string): string => {
    const id = uuidv4()
    mutate((draft) => {
      const track = createDefaultTrack(id, draft.tracks.length)
      const afterIndex = afterId ? draft.tracks.findIndex(item => item.id === afterId) : -1
      if (afterIndex >= 0) draft.tracks.splice(afterIndex + 1, 0, track)
      else draft.tracks.push(track)
    })
    return id
  }, [mutate])

  const updateTrack = useCallback((id: string, patch: Partial<Omit<Track, 'id'>>) => {
    mutate((draft) => {
      const track = draft.tracks.find(item => item.id === id)
      if (!track) return
      Object.assign(track, patch)
      track.name = track.name.trim() || 'Track'
      track.gainDb = Math.max(-60, Math.min(12, track.gainDb))
      track.pan = Math.max(-1, Math.min(1, track.pan))
    })
  }, [mutate])

  const removeTrack = useCallback((id: string) => {
    mutate((draft) => {
      if (draft.tracks.length <= 1) return
      draft.tracks = draft.tracks.filter(track => track.id !== id)
      draft.markers = draft.markers.filter(marker => marker.trackId !== id)
    })
  }, [mutate])

  const duplicateTrack = useCallback((id: string): string => {
    const newId = uuidv4()
    mutate((draft) => {
      const index = draft.tracks.findIndex(track => track.id === id)
      if (index < 0) return
      const source = draft.tracks[index]
      draft.tracks.splice(index + 1, 0, {
        ...source,
        id: newId,
        name: `${source.name} Copy`,
        color: TRACK_COLORS[(TRACK_COLORS.indexOf(source.color) + 1) % TRACK_COLORS.length],
        solo: false,
      })
      const copies = draft.markers
        .filter(marker => marker.trackId === id)
        .map(marker => ({ ...marker, id: uuidv4(), trackId: newId }))
      draft.markers.push(...copies)
    })
    return newId
  }, [mutate])

  const reorderTrack = useCallback((id: string, toIndex: number) => {
    mutate((draft) => {
      const from = draft.tracks.findIndex(track => track.id === id)
      if (from < 0) return
      const [track] = draft.tracks.splice(from, 1)
      draft.tracks.splice(Math.max(0, Math.min(draft.tracks.length, toIndex)), 0, track)
    })
  }, [mutate])

  const setSettings = useCallback((patch: Partial<TimelineSettings>) => {
    mutate((draft) => {
      draft.settings = {
        ...draft.settings,
        ...patch,
        timeSignature: { ...draft.settings.timeSignature, ...patch.timeSignature },
        snap: { ...draft.settings.snap, ...patch.snap },
        loop: { ...draft.settings.loop, ...patch.loop },
      }
      draft.settings.bpm = Math.max(20, Math.min(300, draft.settings.bpm))
      draft.settings.loop.startTick = Math.max(0, Math.min(draft.lengthTicks - 1, Math.trunc(draft.settings.loop.startTick)))
      draft.settings.loop.endTick = Math.max(
        draft.settings.loop.startTick + 1,
        Math.min(draft.lengthTicks, Math.trunc(draft.settings.loop.endTick)),
      )
      extendTimeline(draft)
    })
  }, [mutate])

  const setMaster = useCallback((patch: Partial<MasterBus>) => {
    mutate((draft) => {
      Object.assign(draft.master, patch)
      draft.master.gainDb = Math.max(-60, Math.min(12, draft.master.gainDb))
      draft.master.limiterCeilingDb = Math.max(-12, Math.min(0, draft.master.limiterCeilingDb))
    })
  }, [mutate])

  const setLength = useCallback((lengthTicks: number) => {
    mutate((draft) => {
      const required = getTimelineLengthTicks(draft.markers, 1, draft.settings)
      draft.lengthTicks = Math.max(required, Math.trunc(lengthTicks))
      draft.settings.loop.endTick = Math.min(draft.settings.loop.endTick, draft.lengthTicks)
    })
  }, [mutate])

  const setTargetVersion = useCallback((targetVersion: string) => {
    mutate((draft) => {
      draft.targetVersion = targetVersion
    })
  }, [mutate])

  const rerollRandomSeed = useCallback(() => {
    mutate((draft) => {
      draft.randomSeed = (draft.randomSeed + 0x9e3779b9) >>> 0
    })
  }, [mutate])

  const replaceAll = useCallback((state: TimelineState) => dispatch({ type: 'replace', state }), [])
  const newProject = useCallback((): TimelineState => {
    const state = defaultState()
    dispatch({ type: 'replace', state })
    return state
  }, [])
  const beginTransaction = useCallback(() => dispatch({ type: 'beginTx' }), [])
  const commitTransaction = useCallback(() => dispatch({ type: 'commitTx' }), [])
  const undo = useCallback(() => dispatch({ type: 'undo' }), [])
  const redo = useCallback(() => dispatch({ type: 'redo' }), [])

  return useMemo(() => ({
    state: history.current,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    addMarker,
    addMarkers,
    removeMarker,
    removeMarkers,
    moveMarker,
    moveMarkers,
    moveMarkersToTracks,
    updateMarker,
    updateMarkers,
    addTrack,
    updateTrack,
    removeTrack,
    duplicateTrack,
    reorderTrack,
    setSettings,
    setMaster,
    setLength,
    setTargetVersion,
    rerollRandomSeed,
    replaceAll,
    newProject,
    beginTransaction,
    commitTransaction,
    undo,
    redo,
  }), [
    history,
    addMarker, addMarkers, removeMarker, removeMarkers, moveMarker, moveMarkers,
    moveMarkersToTracks, updateMarker, updateMarkers, addTrack, updateTrack,
    removeTrack, duplicateTrack, reorderTrack, setSettings, setMaster, setLength,
    setTargetVersion, rerollRandomSeed, replaceAll, newProject, beginTransaction,
    commitTransaction, undo, redo,
  ])
}
