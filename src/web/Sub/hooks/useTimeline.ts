import { useCallback, useMemo, useReducer, type Dispatch } from 'react'
import { castDraft, produce, Draft } from 'immer'
import { v4 as uuidv4 } from 'uuid'
import {
  DEFAULT_MASTER,
  DEFAULT_RETRIGGER_INTERVAL,
  DEFAULT_SETTINGS,
  DEFAULT_SONG_METADATA,
  DEFAULT_TIMELINE_LENGTH_TICKS,
  MAX_LOOP_COUNT,
  MAX_GATE_TICKS,
  MAX_MARKER_PITCH,
  MAX_SOUND_STOP_TRACK,
  MIN_MARKER_PITCH,
  SINGLE_SHOT_CURVE_PREVIEW_TICKS,
  TRACK_COLORS,
  createDefaultTrack,
  snapLaneY,
  type Curve,
  type EmbeddedCustomAudioAsset,
  type Marker,
  type MasterBus,
  type ProjectCustomInstrument,
  type ReferenceAudioTrack,
  type SongMetadata,
  type TempoMapEvent,
  type Tick,
  type TimelineSettings,
  type TimelineState,
  type Track,
} from '../types/timeline'
import { scaleCurveDuration } from '../utils/curveScaling'
import { deriveProjectCustomInstruments } from '../utils/customInstruments'
import { getTimelineLengthTicks, normalizeTempoMap, tempoBpmLimits } from '../utils/tempoMap'

export const MAX_TIMELINE_HISTORY = 100

export function createDefaultTimelineState(targetVersion = ''): TimelineState {
  return {
    projectId: uuidv4(),
    randomSeed: Math.floor(Math.random() * 0x1_0000_0000),
    targetVersion,
    lengthTicks: DEFAULT_TIMELINE_LENGTH_TICKS,
    settings: structuredClone(DEFAULT_SETTINGS),
    master: { ...DEFAULT_MASTER },
    tracks: [createDefaultTrack(uuidv4())],
    markers: [],
    referenceAudio: [],
    customAudio: [],
    customInstruments: [],
    tempoMap: normalizeTempoMap([], DEFAULT_SETTINGS),
    metadata: { ...DEFAULT_SONG_METADATA },
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

function clampMarkerPitch(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.max(MIN_MARKER_PITCH, Math.min(MAX_MARKER_PITCH, value))
}

function normalizePitchCurve(marker: Draft<Marker>): void {
  if (!marker.pitchCurve) return
  for (const keyframe of marker.pitchCurve.keyframes) {
    keyframe.value = clampMarkerPitch(keyframe.value)
    for (const handle of [keyframe.handleL, keyframe.handleR]) {
      if (!handle) continue
      const controlValue = clampMarkerPitch(keyframe.value + handle.dv)
      handle.dv = controlValue - keyframe.value
    }
  }
}

function normalizeMarkerFields(marker: Draft<Marker>): void {
  marker.tick = Math.max(0, Math.trunc(marker.tick))
  marker.pan = Math.max(-1, Math.min(1, marker.pan ?? 0))
  marker.pitch = clampMarkerPitch(marker.pitch)
  normalizePitchCurve(marker)
  const gateTicks = Number.isFinite(marker.gateTicks) ? Math.trunc(marker.gateTicks ?? 0) : 0
  marker.gateTicks = gateTicks > 0 ? Math.min(MAX_GATE_TICKS, gateTicks) : undefined
  if (marker.laneY !== undefined) marker.laneY = snapLaneY(marker.laneY)
  if (marker.action?.type !== 'sound-stop') return
  if (marker.action.scope === 'track-range') {
    const startTrack = Math.max(
      1,
      Math.min(MAX_SOUND_STOP_TRACK, Math.trunc(marker.action.startTrack ?? 1)),
    )
    marker.action.startTrack = startTrack
    marker.action.endTrack = Math.max(
      startTrack,
      Math.min(MAX_SOUND_STOP_TRACK, Math.trunc(marker.action.endTrack ?? startTrack)),
    )
  }
  else {
    marker.action = { type: 'sound-stop', scope: 'all' }
  }
  marker.soundId = ''
  marker.variantIndex = -1
  marker.volume = 1
  marker.pitch = 1
  marker.pan = 0
  marker.gateTicks = undefined
  marker.duration = undefined
  marker.retriggerInterval = undefined
  marker.volumeCurve = undefined
  marker.pitchCurve = undefined
}

function extendTimeline(draft: Draft<TimelineState>): void {
  draft.lengthTicks = getTimelineLengthTicks(
    draft.markers,
    draft.lengthTicks,
    draft.settings,
    draft.referenceAudio ?? [],
    draft.tempoMap ?? [],
  )
  draft.settings.loop.endTick = Math.min(draft.settings.loop.endTick, draft.lengthTicks)
}

export interface TimelineHistory {
  past: TimelineState[]
  current: TimelineState
  future: TimelineState[]
  txSnapshot: TimelineState | null
}

export type TimelinePasteMarker = Partial<Marker> & Pick<Marker, 'tick'>

export interface TimelinePasteInput {
  markers: readonly TimelinePasteMarker[]
  assets: readonly EmbeddedCustomAudioAsset[]
  instruments?: readonly ProjectCustomInstrument[]
}

export interface PreparedTimelinePaste {
  ids: string[]
  action: Extract<TimelineHistoryAction, { type: 'paste' }>
}

export type TimelineHistoryAction =
  | { type: 'mutate', recipe: (draft: Draft<TimelineState>) => void }
  | { type: 'beginTx' }
  | { type: 'commitTx' }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'replace', state: TimelineState }
  | {
    type: 'paste'
    ids: readonly string[]
    markers: readonly TimelinePasteMarker[]
    assets: readonly EmbeddedCustomAudioAsset[]
    instruments: readonly ProjectCustomInstrument[]
  }

export function createTimelinePasteAction(input: TimelinePasteInput): PreparedTimelinePaste {
  const ids = input.markers.map(() => uuidv4())
  return {
    ids,
    action: {
      type: 'paste',
      ids,
      markers: input.markers,
      assets: input.assets,
      instruments: input.instruments ?? [],
    },
  }
}

export function createTimelineHistory(initial = createDefaultTimelineState()): TimelineHistory {
  return {
    past: [],
    current: initial,
    future: [],
    txSnapshot: null,
  }
}

function materializeMarker(
  draft: Draft<TimelineState>,
  id: string,
  partial: TimelinePasteMarker,
): Marker {
  const trackId = partial.trackId && draft.tracks.some(track => track.id === partial.trackId)
    ? partial.trackId
    : draft.tracks[0].id
  const marker: Marker = {
    id,
    trackId,
    tick: Math.max(0, Math.trunc(partial.tick)),
    soundId: partial.soundId ?? '',
    variantIndex: partial.variantIndex ?? -1,
    volume: partial.volume ?? 1,
    pitch: partial.pitch ?? 1,
    pan: Math.max(-1, Math.min(1, partial.pan ?? 0)),
    gateTicks: partial.gateTicks,
    duration: partial.duration,
    retriggerInterval: partial.retriggerInterval ?? DEFAULT_RETRIGGER_INTERVAL,
    laneY: partial.laneY === undefined ? undefined : snapLaneY(partial.laneY),
    volumeCurve: partial.volumeCurve,
    pitchCurve: partial.pitchCurve,
    action: partial.action ? { ...partial.action } : undefined,
    source: partial.source,
  }
  normalizeMarkerFields(castDraft(marker))
  return marker
}

function applyMutation(
  history: TimelineHistory,
  recipe: (draft: Draft<TimelineState>) => void,
): TimelineHistory {
  const next = produce(history.current, recipe)
  if (next === history.current) return history
  if (history.txSnapshot !== null) return { ...history, current: next }
  return {
    past: [...history.past, history.current].slice(-MAX_TIMELINE_HISTORY),
    current: next,
    future: [],
    txSnapshot: null,
  }
}

export function timelineHistoryReducer(
  history: TimelineHistory,
  action: TimelineHistoryAction,
): TimelineHistory {
  switch (action.type) {
    case 'mutate':
      return applyMutation(history, action.recipe)
    case 'paste': {
      const legacyInstruments = history.current.customInstruments === undefined
        ? deriveProjectCustomInstruments(history.current)
        : undefined
      return applyMutation(history, (draft) => {
        const customAudio = draft.customAudio ?? (draft.customAudio = [])
        for (const asset of action.assets) customAudio.push(castDraft({ ...asset }))
        const customInstruments = draft.customInstruments ?? (
          draft.customInstruments = castDraft(legacyInstruments ?? [])
        )
        for (const instrument of action.instruments) {
          customInstruments.push(castDraft({ ...instrument }))
        }
        action.markers.forEach((partial, index) => {
          const id = action.ids[index]
          if (id) draft.markers.push(castDraft(materializeMarker(draft, id, partial)))
        })
        extendTimeline(draft)
      })
    }
    case 'beginTx':
      return history.txSnapshot === null ? { ...history, txSnapshot: history.current } : history
    case 'commitTx':
      if (history.txSnapshot === null) return history
      if (history.txSnapshot === history.current) return { ...history, txSnapshot: null }
      return {
        past: [...history.past, history.txSnapshot].slice(-MAX_TIMELINE_HISTORY),
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
        future: [history.current, ...history.future].slice(0, MAX_TIMELINE_HISTORY),
        txSnapshot: null,
      }
    }
    case 'redo': {
      const next = history.future[0]
      if (!next) return history
      return {
        past: [...history.past, history.current].slice(-MAX_TIMELINE_HISTORY),
        current: next,
        future: history.future.slice(1),
        txSnapshot: null,
      }
    }
    case 'replace':
      return { past: [], current: action.state, future: [], txSnapshot: null }
  }
}

export function useTimelineController(
  history: TimelineHistory,
  dispatch: Dispatch<TimelineHistoryAction>,
) {
  const mutate = useCallback((recipe: (draft: Draft<TimelineState>) => void) => {
    dispatch({ type: 'mutate', recipe })
  }, [dispatch])

  const addMarker = useCallback((partial: Partial<Marker> & { tick: Tick }): string => {
    const id = uuidv4()
    mutate((draft) => {
      draft.markers.push(castDraft(materializeMarker(draft, id, partial)))
      extendTimeline(draft)
    })
    return id
  }, [mutate])

  const addMarkers = useCallback((partials: (Partial<Marker> & { tick: Tick })[]): string[] => {
    const ids = partials.map(() => uuidv4())
    mutate((draft) => {
      partials.forEach((partial, index) => {
        draft.markers.push(castDraft(materializeMarker(draft, ids[index], partial)))
      })
      extendTimeline(draft)
    })
    return ids
  }, [mutate])

  const pasteMarkersWithAssets = useCallback((input: TimelinePasteInput): string[] => {
    const prepared = createTimelinePasteAction(input)
    dispatch(prepared.action)
    return prepared.ids
  }, [dispatch])

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
      Object.assign(marker, patch.action ? { ...patch, action: { ...patch.action } } : patch)
      normalizeMarkerFields(marker)
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
        Object.assign(marker, patch.action ? { ...patch, action: { ...patch.action } } : patch)
        normalizeMarkerFields(marker)
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
      if (afterIndex >= 0) draft.tracks.splice(afterIndex + 1, 0, castDraft(track))
      else draft.tracks.push(castDraft(track))
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
        .map(marker => ({
          ...marker,
          id: uuidv4(),
          trackId: newId,
          action: marker.action ? { ...marker.action } : undefined,
        }))
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

  const addReferenceAudio = useCallback((track: Omit<ReferenceAudioTrack, 'id' | 'color'>): string => {
    const id = uuidv4()
    mutate((draft) => {
      const references = draft.referenceAudio ?? (draft.referenceAudio = [])
      references.push({
        ...castDraft(track),
        id,
        color: TRACK_COLORS[(draft.tracks.length + references.length) % TRACK_COLORS.length],
      })
      extendTimeline(draft)
    })
    return id
  }, [mutate])

  const updateReferenceAudio = useCallback((id: string, patch: Partial<ReferenceAudioTrack>) => {
    mutate((draft) => {
      const track = draft.referenceAudio?.find(item => item.id === id)
      if (!track) return
      Object.assign(track, patch)
      track.name = track.name.trim() || track.fileName || 'Reference Audio'
      track.offsetTicks = Math.max(0, Math.trunc(track.offsetTicks))
      track.gainDb = Math.max(-60, Math.min(12, track.gainDb))
      track.pan = Math.max(-1, Math.min(1, track.pan))
      extendTimeline(draft)
    })
  }, [mutate])

  const removeReferenceAudio = useCallback((id: string) => {
    mutate((draft) => {
      if (!draft.referenceAudio?.some(track => track.id === id)) return
      draft.referenceAudio = draft.referenceAudio.filter(track => track.id !== id)
    })
  }, [mutate])

  const setSettings = useCallback((patch: Partial<TimelineSettings>) => {
    mutate((draft) => {
      const previousFallback = {
        bpm: draft.settings.bpm,
        timeSignature: { ...draft.settings.timeSignature },
        ticksPerQuarter: draft.settings.ticksPerQuarter,
      }
      draft.settings = {
        ...draft.settings,
        ...patch,
        timeSignature: { ...draft.settings.timeSignature, ...patch.timeSignature },
        snap: { ...draft.settings.snap, ...patch.snap },
        loop: { ...draft.settings.loop, ...patch.loop },
      }
      const { min, max } = tempoBpmLimits(draft.settings)
      draft.settings.bpm = Math.max(min, Math.min(max, draft.settings.bpm))
      draft.settings.panLaw ??= 'cascade'
      draft.settings.loop.startTick = Math.max(0, Math.min(draft.lengthTicks - 1, Math.trunc(draft.settings.loop.startTick)))
      draft.settings.loop.endTick = Math.max(
        draft.settings.loop.startTick + 1,
        Math.min(draft.lengthTicks, Math.trunc(draft.settings.loop.endTick)),
      )
      if (patch.bpm !== undefined || patch.timeSignature !== undefined) {
        const tempoMap = normalizeTempoMap(
          draft.tempoMap as TempoMapEvent[] | undefined,
          previousFallback,
        )
        tempoMap[0] = {
          ...tempoMap[0],
          bpm: patch.bpm === undefined ? tempoMap[0].bpm : draft.settings.bpm,
          meter: patch.timeSignature === undefined
            ? { ...tempoMap[0].meter! }
            : { ...draft.settings.timeSignature },
        }
        const normalized = normalizeTempoMap(tempoMap, draft.settings)
        draft.tempoMap = castDraft(normalized)
        draft.settings.bpm = normalized[0].bpm
        draft.settings.timeSignature = castDraft({ ...normalized[0].meter! })
      }
      extendTimeline(draft)
    })
  }, [mutate])

  /** Replaces the complete map as one history entry and leaves unrelated project data untouched. */
  const setTempoMap = useCallback((events: readonly TempoMapEvent[]) => {
    const input = events.map(event => ({
      ...event,
      ...(event.meter === undefined ? {} : { meter: { ...event.meter } }),
    }))
    mutate((draft) => {
      const normalized = normalizeTempoMap(input, draft.settings)
      draft.tempoMap = castDraft(normalized)
      draft.settings.bpm = normalized[0].bpm
      draft.settings.timeSignature = castDraft({ ...normalized[0].meter! })
      extendTimeline(draft)
    })
  }, [mutate])

  /** Applies editable song credits and finite-loop settings as one undoable project edit. */
  const setSongMetadataAndLoop = useCallback((
    metadata: SongMetadata,
    loop: TimelineSettings['loop'],
  ) => {
    const nextMetadata = { ...metadata }
    const nextLoop = { ...loop }
    mutate((draft) => {
      draft.metadata = castDraft(nextMetadata)
      const startTick = Math.max(0, Math.min(
        draft.lengthTicks - 1,
        Math.trunc(nextLoop.startTick),
      ))
      draft.settings.loop = {
        enabled: Boolean(nextLoop.enabled),
        startTick,
        endTick: Math.max(
          startTick + 1,
          Math.min(draft.lengthTicks, Math.trunc(nextLoop.endTick)),
        ),
        maxLoopCount: Math.max(
          0,
          Math.min(MAX_LOOP_COUNT, Math.trunc(nextLoop.maxLoopCount ?? 0)),
        ),
      }
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
      const required = getTimelineLengthTicks(
        draft.markers,
        1,
        draft.settings,
        draft.referenceAudio ?? [],
        draft.tempoMap ?? [],
      )
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

  const applyState = useCallback((state: TimelineState) => {
    mutate((draft) => {
      Object.assign(draft, structuredClone(state))
    })
  }, [mutate])

  const replaceAll = useCallback((state: TimelineState) => dispatch({ type: 'replace', state }), [dispatch])
  const newProject = useCallback((): TimelineState => {
    const state = createDefaultTimelineState()
    dispatch({ type: 'replace', state })
    return state
  }, [dispatch])
  const beginTransaction = useCallback(() => dispatch({ type: 'beginTx' }), [dispatch])
  const commitTransaction = useCallback(() => dispatch({ type: 'commitTx' }), [dispatch])
  const undo = useCallback(() => dispatch({ type: 'undo' }), [dispatch])
  const redo = useCallback(() => dispatch({ type: 'redo' }), [dispatch])

  return useMemo(() => ({
    state: history.current,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    addMarker,
    addMarkers,
    pasteMarkersWithAssets,
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
    addReferenceAudio,
    updateReferenceAudio,
    removeReferenceAudio,
    setSettings,
    setTempoMap,
    setSongMetadataAndLoop,
    setMaster,
    setLength,
    setTargetVersion,
    rerollRandomSeed,
    applyState,
    replaceAll,
    newProject,
    beginTransaction,
    commitTransaction,
    undo,
    redo,
  }), [
    history,
    addMarker, addMarkers, pasteMarkersWithAssets, removeMarker, removeMarkers, moveMarker, moveMarkers,
    moveMarkersToTracks, updateMarker, updateMarkers, addTrack, updateTrack,
    removeTrack, duplicateTrack, reorderTrack, addReferenceAudio, updateReferenceAudio,
    removeReferenceAudio, setSettings, setTempoMap, setSongMetadataAndLoop, setMaster, setLength,
    setTargetVersion, rerollRandomSeed, applyState, replaceAll, newProject, beginTransaction,
    commitTransaction, undo, redo,
  ])
}

export type TimelineController = ReturnType<typeof useTimelineController>

/** Backward-compatible single-document timeline used by the current editor and focused tests. */
export function useTimeline(initial?: TimelineState): TimelineController {
  const [history, dispatch] = useReducer(
    timelineHistoryReducer,
    initial,
    value => createTimelineHistory(value ?? createDefaultTimelineState()),
  )
  return useTimelineController(history, dispatch)
}
