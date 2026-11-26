import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Modal, Flex, Text } from '@yamada-ui/react'
import {
  TRACK_HEADER_WIDTH,
  TRACK_HEIGHT,
  TRACK_HEIGHT_COLLAPSED,
  REFERENCE_AUDIO_TRACK_HEIGHT,
  REFERENCE_AUDIO_TRACK_HEIGHT_COLLAPSED,
  TIMELINE_LEADING_PADDING_PX,
  isSoundStopMarker,
  snapLaneY,
  type EmbeddedCustomAudioAsset,
  type Marker,
} from '../types/timeline'
import { useTimeline, type TimelineController } from '../hooks/useTimeline'
import { useAudioBufferCache } from '../hooks/useAudioBufferCache'
import { resolveMarkerPlaybackRate, useTimelinePlayback } from '../hooks/useTimelinePlayback'
import { DEFAULT_PX_PER_TICK, tickToPx } from '../utils/tickPixel'
import {
  nbsTargetVersionForState,
  parseStudioSongFile,
  serializeStudioSongFile,
} from '../utils/studioSongFile'
import { TimelineToolbar } from './TimelineToolbar'
import { TimelineRuler } from './TimelineRuler'
import { SelectModifiers, TimelineTrack } from './TimelineTrack'
import { TimelinePlayhead } from './TimelinePlayhead'
import { TrackHeader } from './TrackHeader'
import { MixerPanel } from './MixerPanel'
import { ExportDialog } from './ExportDialog'
import { CommandExportDialog } from './CommandExportDialog'
import { NoteBlockBuildDialog } from './NoteBlockBuildDialog'
import { ArrangementOverview } from './ArrangementOverview'
import { NbsDialog } from './NbsDialog'
import { NbpDialog } from './NbpDialog'
import { NbsMacroDialog } from './NbsMacroDialog'
import { ResourcePackDialog } from './ResourcePackDialog'
import { RecoveryDialog } from './RecoveryDialog'
import { PlayerModeOverlay } from './PlayerModeOverlay'
import { PianoRollDialog } from './PianoRollDialog'
import { TempoMapDialog } from './TempoMapDialog'
import { SongMetadataDialog } from './SongMetadataDialog'
import { CustomInstrumentDialog } from './CustomInstrumentDialog'
import { CommandPaletteDialog } from './CommandPaletteDialog'
import { MidiDialog, type LiveMidiRecordedNote } from './MidiDialog'
import { ExtensionManagerDialog } from './ExtensionManagerDialog'
import { useAudioLibrary } from '../../../hooks/useAudioLibrary'
import { TimelinePropertyPanel } from './TimelinePropertyPanel'
import type { StudioSongFileKind, TimelineOpenResult } from '../../../../@types/global'
import type { NbsTargetVersion } from '../utils/nbs'
import type { TimelineRecoveryMetadata } from '../types/recovery'
import type { StudioDocumentSelection, StudioDocumentView } from '../types/studioDocuments'
import { findKneadProjectPath, findKneadProjectPaths } from '../utils/projectFiles'
import { useTranslation } from 'react-i18next'
import { useMarkerIcons } from '../hooks/useMarkerIcons'
import { timelineViewportRange, type OverviewRange } from '../utils/arrangementOverview'
import { ReferenceAudioTrackRow } from './ReferenceAudioTrackRow'
import {
  assertCanAddReferenceAudio,
  createReferenceAudioTrackDraft,
  readReferenceAudioFileData,
} from '../utils/referenceAudio'
import { restoreProjectCustomAudio } from '../utils/projectCustomAudio'
import { useTimelineRecovery } from '../hooks/useTimelineRecovery'
import type { CommandPaletteCommand } from '../utils/commandPalette'
import { buildTempoMap, snapTickToTempoMap } from '../utils/tempoMap'

interface Props {
  defaultSoundId?: string
  currentTargetVersion?: string
  timelineController?: TimelineController
  documentId?: string
  documentFilePath?: string | null
  documentDirty?: boolean
  onDocumentSaved?: (state: TimelineController['state'], path: string) => void | Promise<void>
  onSaveDocument?: () => void | Promise<void>
  onSaveDocumentAs?: () => void | Promise<void>
  onNewDocument?: () => void | Promise<void>
  onOpenDocument?: () => void | Promise<void>
  onOpenDocumentPath?: (path: string) => void | Promise<void>
  onImportDocument?: (
    state: TimelineController['state'],
    warnings: readonly string[],
    sourcePath: string,
    kind: 'nbs' | 'midi' | 'nbp' | 'recovery',
  ) => boolean | Promise<boolean>
  onBlockingDialogChange?: (open: boolean) => void
  projectAudioManagedExternally?: boolean
  recoveryEnabled?: boolean
  autoOpenRecoveryDialog?: boolean
  embeddedWorkspace?: boolean
  onCopyMarkers?: (markerIds: readonly string[]) => boolean
  onPasteMarkers?: (atTick: number, destinationTrackId: string) => readonly string[]
  initialSelection?: StudioDocumentSelection
  initialView?: StudioDocumentView
  onSessionChange?: (selection: StudioDocumentSelection, view: StudioDocumentView) => void
}

interface ClipboardItem {
  tickOffset: number
  data: Omit<Marker, 'id' | 'tick'>
}

interface MoveOrigin {
  tick: number
  trackIndex: number
}

interface ConfirmationRequest {
  title: string
  message: string
  confirmLabel: string
}

const EMPTY_REFERENCE_AUDIO: NonNullable<ReturnType<typeof useTimeline>['state']['referenceAudio']> = []

function omitMarkerId(marker: Marker): Omit<Marker, 'id'> {
  const { id, ...rest } = marker
  void id
  return rest
}

export const TimelineEditor: React.FC<Props> = ({
  defaultSoundId,
  currentTargetVersion,
  timelineController,
  documentId,
  documentFilePath,
  documentDirty,
  onDocumentSaved,
  onSaveDocument,
  onSaveDocumentAs,
  onNewDocument,
  onOpenDocument,
  onOpenDocumentPath,
  onImportDocument,
  onBlockingDialogChange,
  projectAudioManagedExternally = false,
  recoveryEnabled = true,
  autoOpenRecoveryDialog = true,
  embeddedWorkspace = false,
  onCopyMarkers,
  onPasteMarkers,
  initialSelection,
  initialView,
  onSessionChange,
}) => {
  const { t } = useTranslation()
  const localTimeline = useTimeline()
  const timeline = timelineController ?? localTimeline
  const { soundIdList, soundMap } = useAudioLibrary()
  const cache = useAudioBufferCache()
  const preloadReferenceAudio = cache.preloadReferenceAudio
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set(
    initialSelection?.markerIds.filter(id => timeline.state.markers.some(marker => marker.id === id))
    ?? [],
  ))
  const [selectedTrackId, setSelectedTrackId] = useState(() => (
    initialSelection && timeline.state.tracks.some(track => track.id === initialSelection.trackId)
      ? initialSelection.trackId
      : timeline.state.tracks[0].id
  ))
  const [localFilePath, setLocalFilePath] = useState<string | null>(null)
  const [localFileKind, setLocalFileKind] = useState<StudioSongFileKind>('kp')
  const [localNbsTargetVersion, setLocalNbsTargetVersion] = useState<NbsTargetVersion | null>(null)
  const [localDirty, setLocalDirty] = useState(false)
  const controlledDocument = documentId !== undefined
  const filePath = controlledDocument ? documentFilePath ?? null : localFilePath
  const dirty = controlledDocument ? Boolean(documentDirty) : localDirty
  const setFilePath = useCallback((value: string | null) => {
    if (!controlledDocument) setLocalFilePath(value)
  }, [controlledDocument])
  const setDirty = useCallback((value: boolean) => {
    if (!controlledDocument) setLocalDirty(value)
  }, [controlledDocument])
  const [pxPerTick, setPxPerTick] = useState(initialView?.pxPerTick ?? DEFAULT_PX_PER_TICK)
  const [mixerOpen, setMixerOpen] = useState(false)
  const [markerIconsEnabled, setMarkerIconsEnabled] = useState(false)
  const [navigatorOpen, setNavigatorOpen] = useState(true)
  const [viewportRange, setViewportRange] = useState<OverviewRange>({ startTick: 0, endTick: 0 })
  const [exportOpen, setExportOpen] = useState(false)
  const [commandExportOpen, setCommandExportOpen] = useState(false)
  const [noteBlockBuildOpen, setNoteBlockBuildOpen] = useState(false)
  const [nbsOpen, setNbsOpen] = useState(false)
  const [nbpOpen, setNbpOpen] = useState(false)
  const [nbsMacrosOpen, setNbsMacrosOpen] = useState(false)
  const [resourcePackOpen, setResourcePackOpen] = useState(false)
  const [recoveryOpen, setRecoveryOpen] = useState(false)
  const [playerModeOpen, setPlayerModeOpen] = useState(false)
  const [pianoRollOpen, setPianoRollOpen] = useState(false)
  const [tempoMapOpen, setTempoMapOpen] = useState(false)
  const [songMetadataOpen, setSongMetadataOpen] = useState(false)
  const [customInstrumentsOpen, setCustomInstrumentsOpen] = useState(false)
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [midiOpen, setMidiOpen] = useState(false)
  const [extensionsOpen, setExtensionsOpen] = useState(false)
  const [soundFocusRequest, setSoundFocusRequest] = useState(0)
  const [isProjectDragOver, setIsProjectDragOver] = useState(false)
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null)
  const blockingDialogOpen = exportOpen || commandExportOpen || noteBlockBuildOpen || nbsOpen || nbpOpen
    || nbsMacrosOpen || resourcePackOpen || recoveryOpen || playerModeOpen
    || pianoRollOpen || tempoMapOpen || songMetadataOpen || customInstrumentsOpen || midiOpen || extensionsOpen
    || confirmation !== null

  useEffect(() => {
    onBlockingDialogChange?.(blockingDialogOpen)
    return () => onBlockingDialogChange?.(false)
  }, [blockingDialogOpen, onBlockingDialogChange])
  const clipboardRef = useRef<ClipboardItem[]>([])
  const selectionAnchorRef = useRef<string | null>(initialSelection?.anchorMarkerId ?? null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const moveOriginsRef = useRef<Map<string, MoveOrigin>>(new Map())
  const pendingDuplicateOriginsRef = useRef<Map<string, MoveOrigin> | null>(null)
  const confirmationResolverRef = useRef<((accepted: boolean) => void) | null>(null)
  const customAudioSyncRef = useRef<Promise<void>>(Promise.resolve())
  const auditionSourceRef = useRef<AudioBufferSourceNode | null>(null)
  const stateRef = useRef(timeline.state)
  const selectedIdsRef = useRef(selectedIds)
  const selectedTrackIdRef = useRef(selectedTrackId)
  const pxPerTickRef = useRef(pxPerTick)
  const onSessionChangeRef = useRef(onSessionChange)
  stateRef.current = timeline.state
  selectedIdsRef.current = selectedIds
  selectedTrackIdRef.current = selectedTrackId
  pxPerTickRef.current = pxPerTick
  onSessionChangeRef.current = onSessionChange
  const referenceAudio = timeline.state.referenceAudio ?? EMPTY_REFERENCE_AUDIO

  const synchronizeProjectCustomAudio = useCallback((assets?: readonly EmbeddedCustomAudioAsset[]) => {
    const operation = customAudioSyncRef.current
      .catch(() => undefined)
      .then(async () => {
        await restoreProjectCustomAudio(assets ?? [])
      })
    customAudioSyncRef.current = operation.catch((error) => {
      console.error('Could not synchronize the project audio registry', error)
    })
    return operation
  }, [])

  useEffect(() => {
    if (projectAudioManagedExternally) return
    void synchronizeProjectCustomAudio(timeline.state.customAudio).catch(() => undefined)
  }, [projectAudioManagedExternally, synchronizeProjectCustomAudio, timeline.state.customAudio])

  const tempoModel = useMemo(() => buildTempoMap(
    timeline.state.tempoMap,
    timeline.state.settings,
    timeline.state.lengthTicks,
  ), [
    timeline.state.lengthTicks,
    timeline.state.settings,
    timeline.state.tempoMap,
  ])

  const playback = useTimelinePlayback({
    markers: timeline.state.markers,
    tracks: timeline.state.tracks,
    lengthTicks: timeline.state.lengthTicks,
    settings: timeline.state.settings,
    master: timeline.state.master,
    randomSeed: timeline.state.randomSeed,
    cache,
    referenceAudio,
    tempoMap: timeline.state.tempoMap,
  })
  const playbackTickRef = useRef(playback.currentTick)
  playbackTickRef.current = playback.currentTick

  useEffect(() => {
    if (!initialView) return
    playback.seek(initialView.transportTick)
    const frame = requestAnimationFrame(() => {
      if (!scrollRef.current) return
      scrollRef.current.scrollLeft = initialView.scrollLeft
      scrollRef.current.scrollTop = initialView.scrollTop
    })
    return () => cancelAnimationFrame(frame)
    // This project session is restored only once for the keyed editor mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => () => {
    const currentScroll = scrollRef.current
    onSessionChangeRef.current?.({
      markerIds: [...selectedIdsRef.current],
      anchorMarkerId: selectionAnchorRef.current,
      trackId: selectedTrackIdRef.current,
    }, {
      pxPerTick: pxPerTickRef.current,
      scrollLeft: currentScroll?.scrollLeft ?? 0,
      scrollTop: currentScroll?.scrollTop ?? 0,
      transportTick: playbackTickRef.current,
    })
  }, [])

  const auditionMarker = useCallback(async (marker: Marker): Promise<void> => {
    if (isSoundStopMarker(marker)) throw new Error(t('studio.piano_roll_audition_unavailable'))
    const variantCount = cache.getVariantCount(marker.soundId)
    if (variantCount <= 0) throw new Error(t('studio.piano_roll_audition_unavailable'))
    await cache.preload([marker.soundId])
    const variantIndex = marker.variantIndex >= 0 && marker.variantIndex < variantCount
      ? marker.variantIndex
      : 0
    const buffer = cache.getBuffer(marker.soundId, variantIndex)
    if (!buffer) throw new Error(t('studio.piano_roll_audition_unavailable'))
    const context = cache.getAudioContext()
    if (context.state === 'suspended') await context.resume()
    try {
      auditionSourceRef.current?.stop()
    }
    catch {
      // A source that already ended is harmless.
    }
    const playbackRate = resolveMarkerPlaybackRate(
      marker.pitch,
      cache.getBasePitch(marker.soundId, variantIndex),
    )
    if (playbackRate === null) throw new Error(t('studio.piano_roll_audition_unavailable'))
    const source = context.createBufferSource()
    const gain = context.createGain()
    const pan = context.createStereoPanner()
    source.buffer = buffer
    source.playbackRate.value = playbackRate
    gain.gain.value = Math.max(0, Math.min(1, marker.volume)) * 0.35
    pan.pan.value = Math.max(-1, Math.min(1, marker.pan ?? 0))
    source.connect(gain).connect(pan).connect(context.destination)
    auditionSourceRef.current = source
    source.onended = () => {
      source.disconnect()
      gain.disconnect()
      pan.disconnect()
      if (auditionSourceRef.current === source) auditionSourceRef.current = null
    }
    source.start()
    source.stop(context.currentTime + Math.min(1.5, buffer.duration / playbackRate))
  }, [cache, t])

  useEffect(() => () => {
    try {
      auditionSourceRef.current?.stop()
    }
    catch {
      // The source may already have ended during unmount.
    }
    auditionSourceRef.current = null
  }, [])
  const {
    clearAfterSave: clearRecoveryAfterSave,
    error: recoveryError,
    saving: recoverySaving,
  } = useTimelineRecovery({
    state: timeline.state,
    filePath,
    dirty,
    enabled: recoveryEnabled,
  })

  useEffect(() => {
    if (!autoOpenRecoveryDialog) return undefined
    let canceled = false
    void window.myAPI.timelineRecovery.list().then((result) => {
      if (!canceled && result.ok && result.snapshots.length > 0) setRecoveryOpen(true)
    }).catch((error) => {
      console.error('Could not enumerate recovery snapshots', error)
    })
    return () => {
      canceled = true
    }
  }, [autoOpenRecoveryDialog])

  const firstRenderRef = useRef(true)
  const skipDirtyRef = useRef(false)
  useEffect(() => {
    if (firstRenderRef.current) {
      firstRenderRef.current = false
      return
    }
    if (skipDirtyRef.current) {
      skipDirtyRef.current = false
      return
    }
    setDirty(true)
  }, [setDirty, timeline.state])

  useEffect(() => {
    if (!currentTargetVersion || timeline.state.targetVersion || filePath) return
    skipDirtyRef.current = true
    timeline.setTargetVersion(currentTargetVersion)
  }, [currentTargetVersion, filePath, timeline])

  useEffect(() => {
    const name = filePath ? filePath.replace(/^.*[\\/]/, '') : '(未保存)'
    document.title = `${dirty ? '* ' : ''}Knead Studio - ${name}`
  }, [dirty, filePath])

  const preloadKeyRef = useRef('')
  useEffect(() => {
    const ids = Array.from(new Set(timeline.state.markers.map(marker => marker.soundId).filter(Boolean))).sort()
    const key = ids.map(id => `${id}:${(soundMap[id] ?? []).map(variant => variant.hash).join(',')}`).join('|')
    if (key === preloadKeyRef.current) return
    preloadKeyRef.current = key
    cache.preload(ids).catch(error => console.error('preload failed', error))
  }, [cache, soundMap, timeline.state.markers])

  useEffect(() => {
    void preloadReferenceAudio(referenceAudio)
  }, [preloadReferenceAudio, referenceAudio])

  useEffect(() => {
    if (timeline.state.tracks.some(track => track.id === selectedTrackId)) return
    setSelectedTrackId(timeline.state.tracks[0].id)
  }, [selectedTrackId, timeline.state.tracks])

  const trackOrder = useMemo(
    () => new Map(timeline.state.tracks.map((track, index) => [track.id, index])),
    [timeline.state.tracks],
  )
  const sortedMarkers = useMemo(() => [...timeline.state.markers].sort((a, b) => (
    (trackOrder.get(a.trackId) ?? 0) - (trackOrder.get(b.trackId) ?? 0)
    || a.tick - b.tick
  )), [timeline.state.markers, trackOrder])
  const validSoundIds = useMemo(() => new Set(soundIdList), [soundIdList])
  const markerIconVersion = timeline.state.targetVersion || currentTargetVersion
  const markerIconSoundIds = useMemo(
    () => timeline.state.markers
      .filter(marker => !isSoundStopMarker(marker) && Boolean(marker.soundId))
      .map(marker => marker.soundId),
    [timeline.state.markers],
  )
  const markerIcons = useMarkerIcons(
    markerIconsEnabled,
    markerIconVersion,
    markerIconSoundIds,
  )

  useEffect(() => {
    window.myAPI.getSetting('studioMarkerIcons')
      .then(value => setMarkerIconsEnabled(value === true))
      .catch(error => console.warn('marker icon setting load failed', error))
  }, [])

  useEffect(() => {
    window.myAPI.getSetting('studioNavigator')
      .then(value => setNavigatorOpen(value !== false))
      .catch(error => console.warn('navigator setting load failed', error))
  }, [])

  const toggleMarkerIcons = useCallback(() => {
    setMarkerIconsEnabled((enabled) => {
      const next = !enabled
      window.myAPI.setSetting('studioMarkerIcons', next)
      return next
    })
  }, [])

  const toggleNavigator = useCallback(() => {
    setNavigatorOpen((open) => {
      const next = !open
      window.myAPI.setSetting('studioNavigator', next)
      return next
    })
  }, [])

  const addAtTick = useCallback((tick: number, trackId = selectedTrackId) => {
    const track = stateRef.current.tracks.find(item => item.id === trackId)
    if (!track || track.locked) return
    const id = timeline.addMarker({ tick, trackId, soundId: defaultSoundId ?? '' })
    setSelectedIds(new Set([id]))
    selectionAnchorRef.current = id
    setSelectedTrackId(trackId)
    setSoundFocusRequest(value => value + 1)
  }, [defaultSoundId, selectedTrackId, timeline])

  const addSoundStopAtTick = useCallback((tick: number, trackId = selectedTrackId) => {
    const currentState = stateRef.current
    const trackIndex = currentState.tracks.findIndex(item => item.id === trackId)
    const track = currentState.tracks[trackIndex]
    if (!track || track.locked) return
    const trackNumber = trackIndex + 1
    const id = timeline.addMarker({
      tick,
      trackId,
      laneY: 0.5,
      action: {
        type: 'sound-stop',
        scope: 'track-range',
        startTrack: trackNumber,
        endTrack: trackNumber,
      },
    })
    setSelectedIds(new Set([id]))
    selectionAnchorRef.current = id
    setSelectedTrackId(trackId)
  }, [selectedTrackId, timeline])

  const handleMarkerSelect = useCallback((id: string, modifiers: SelectModifiers) => {
    const marker = stateRef.current.markers.find(item => item.id === id)
    if (marker) setSelectedTrackId(marker.trackId)
    setSelectedIds((previous) => {
      if (modifiers.ctrl) {
        const next = new Set(previous)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        selectionAnchorRef.current = id
        return next
      }
      if (modifiers.shift && selectionAnchorRef.current) {
        const anchorIndex = sortedMarkers.findIndex(item => item.id === selectionAnchorRef.current)
        const index = sortedMarkers.findIndex(item => item.id === id)
        if (anchorIndex >= 0 && index >= 0) {
          const [start, end] = anchorIndex < index ? [anchorIndex, index] : [index, anchorIndex]
          return new Set(sortedMarkers.slice(start, end + 1).map(item => item.id))
        }
      }
      selectionAnchorRef.current = id
      return new Set([id])
    })
  }, [sortedMarkers])

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set())
    selectionAnchorRef.current = null
  }, [])

  const rectangleSelect = useCallback((ids: string[], additive: boolean) => {
    setSelectedIds(previous => additive ? new Set([...previous, ...ids]) : new Set(ids))
    selectionAnchorRef.current = ids.at(-1) ?? null
  }, [])

  const captureMoveOrigins = useCallback((primaryId: string) => {
    if (pendingDuplicateOriginsRef.current?.has(primaryId)) {
      moveOriginsRef.current = pendingDuplicateOriginsRef.current
      pendingDuplicateOriginsRef.current = null
    }
    else {
      const ids = selectedIdsRef.current.has(primaryId) ? selectedIdsRef.current : new Set([primaryId])
      moveOriginsRef.current = new Map(
        stateRef.current.markers
          .filter(marker => ids.has(marker.id))
          .map(marker => [marker.id, {
            tick: marker.tick,
            trackIndex: stateRef.current.tracks.findIndex(track => track.id === marker.trackId),
          }]),
      )
    }
    timeline.beginTransaction()
  }, [timeline])

  const moveSelection = useCallback((
    primaryId: string,
    tick: number,
    targetTrackId: string,
    laneYs?: Map<string, number>,
  ) => {
    const origins = moveOriginsRef.current
    const primary = origins.get(primaryId)
    if (!primary) return
    const targetIndex = stateRef.current.tracks.findIndex(track => track.id === targetTrackId)
    if (targetIndex < 0 || stateRef.current.tracks[targetIndex].locked) return
    const minTick = Math.min(...Array.from(origins.values()).map(origin => origin.tick))
    const deltaTick = Math.max(-minTick, tick - primary.tick)
    const deltaTrack = targetIndex - primary.trackIndex
    const positions = new Map<string, { tick: number, trackId: string, laneY?: number }>()
    for (const [id, origin] of origins) {
      const trackIndex = Math.max(0, Math.min(stateRef.current.tracks.length - 1, origin.trackIndex + deltaTrack))
      const targetTrack = stateRef.current.tracks[trackIndex]
      if (targetTrack.locked) continue
      positions.set(id, {
        tick: origin.tick + deltaTick,
        trackId: targetTrack.id,
        laneY: laneYs?.get(id),
      })
    }
    timeline.moveMarkersToTracks(positions)
  }, [timeline])

  const duplicateForDrag = useCallback((primaryId: string): string => {
    const sourceIds = selectedIdsRef.current.has(primaryId) ? selectedIdsRef.current : new Set([primaryId])
    const source = stateRef.current.markers.filter(marker => sourceIds.has(marker.id))
    const ids = timeline.addMarkers(source.map(omitMarkerId))
    const origins = new Map<string, MoveOrigin>()
    source.forEach((marker, index) => origins.set(ids[index], {
      tick: marker.tick,
      trackIndex: stateRef.current.tracks.findIndex(track => track.id === marker.trackId),
    }))
    pendingDuplicateOriginsRef.current = origins
    setSelectedIds(new Set(ids))
    const sourceIndex = source.findIndex(marker => marker.id === primaryId)
    const nextPrimary = ids[Math.max(0, sourceIndex)]
    selectionAnchorRef.current = nextPrimary
    return nextPrimary
  }, [timeline])

  const deleteSelected = useCallback(() => {
    if (selectedIdsRef.current.size === 0) return
    const unlocked = stateRef.current.markers
      .filter(marker => selectedIdsRef.current.has(marker.id))
      .filter(marker => !stateRef.current.tracks.find(track => track.id === marker.trackId)?.locked)
      .map(marker => marker.id)
    timeline.removeMarkers(unlocked)
    clearSelection()
  }, [clearSelection, timeline])

  const copy = useCallback(() => {
    const selected = stateRef.current.markers.filter(marker => selectedIdsRef.current.has(marker.id))
    if (selected.length === 0) return
    if (onCopyMarkers) {
      onCopyMarkers(selected.map(marker => marker.id))
      return
    }
    const minTick = Math.min(...selected.map(marker => marker.tick))
    clipboardRef.current = selected.map((marker) => {
      const { tick, ...data } = omitMarkerId(marker)
      return { tickOffset: tick - minTick, data }
    })
  }, [onCopyMarkers])

  const paste = useCallback(() => {
    const baseTick = Math.round(playback.currentTick)
    if (onPasteMarkers) {
      const ids = [...onPasteMarkers(baseTick, selectedTrackId)]
      if (ids.length === 0) return
      setSelectedIds(new Set(ids))
      selectionAnchorRef.current = ids.at(-1) ?? null
      return
    }
    if (clipboardRef.current.length === 0) return
    const fallbackTrack = stateRef.current.tracks.find(track => track.id === selectedTrackId && !track.locked)
      ?? stateRef.current.tracks.find(track => !track.locked)
    if (!fallbackTrack) return
    const ids = timeline.addMarkers(clipboardRef.current.map(item => ({
      ...item.data,
      trackId: stateRef.current.tracks.some(track => track.id === item.data.trackId && !track.locked)
        ? item.data.trackId
        : fallbackTrack.id,
      tick: baseTick + item.tickOffset,
    })))
    setSelectedIds(new Set(ids))
    selectionAnchorRef.current = ids.at(-1) ?? null
  }, [onPasteMarkers, playback.currentTick, selectedTrackId, timeline])

  const duplicateSelected = useCallback(() => {
    const lockedTrackIds = new Set(stateRef.current.tracks.filter(track => track.locked).map(track => track.id))
    const source = stateRef.current.markers.filter(marker => (
      selectedIdsRef.current.has(marker.id) && !lockedTrackIds.has(marker.trackId)
    ))
    if (source.length === 0) return
    const step = stateRef.current.settings.snap.mode === 'tick' ? stateRef.current.settings.snap.tickStep : 1
    const ids = timeline.addMarkers(source.map(marker => ({
      ...omitMarkerId(marker),
      tick: marker.tick + step,
    })))
    setSelectedIds(new Set(ids))
    selectionAnchorRef.current = ids.at(-1) ?? null
  }, [timeline])

  const requestConfirmation = useCallback((request: ConfirmationRequest): Promise<boolean> => {
    if (confirmationResolverRef.current) return Promise.resolve(false)
    setConfirmation(request)
    return new Promise((resolve) => {
      confirmationResolverRef.current = resolve
    })
  }, [])

  const settleConfirmation = useCallback((accepted: boolean) => {
    const resolve = confirmationResolverRef.current
    confirmationResolverRef.current = null
    setConfirmation(null)
    resolve?.(accepted)
  }, [])

  useEffect(() => () => {
    confirmationResolverRef.current?.(false)
    confirmationResolverRef.current = null
  }, [])

  const confirmDiscard = useCallback(async () => (
    !dirty || requestConfirmation({
      title: t('studio.discard_title'),
      message: t('studio.discard_message'),
      confirmLabel: t('studio.discard_action'),
    })
  ), [dirty, requestConfirmation, t])

  const applyProjectResult = useCallback(async (result: TimelineOpenResult) => {
    if (!result.ok) {
      if (!('canceled' in result)) window.alert(`読込エラー: ${result.error}`)
      return
    }
    const parsedResult = parseStudioSongFile(result, currentTargetVersion)
    if (!parsedResult.ok) {
      window.alert(`読込エラー: ${parsedResult.error}`)
      return
    }
    const parsed = parsedResult.document
    try {
      await synchronizeProjectCustomAudio(parsed.state.customAudio)
    }
    catch (error) {
      window.alert(`読込エラー: 埋め込みカスタム音源を検証できません: ${String(error)}`)
      return
    }
    const pathResult = await window.myAPI.timeline.bindCurrentPath(parsed.state.projectId, result.path)
    if (!pathResult.ok) {
      window.alert(`読込エラー: ${pathResult.error}`)
      return
    }
    playback.stop()
    skipDirtyRef.current = true
    timeline.replaceAll(parsed.state)
    setFilePath(pathResult.path)
    setLocalFileKind(parsed.fileKind)
    setLocalNbsTargetVersion(parsed.nbsTargetVersion)
    setDirty(false)
    setSelectedIds(new Set())
    setSelectedTrackId(parsed.state.tracks[0].id)
    const warnings = [...parsed.warnings]
    if (currentTargetVersion && parsed.state.targetVersion !== currentTargetVersion) {
      warnings.push(`Minecraftバージョンが異なります: ${parsed.state.targetVersion || '(未指定)'} / ${currentTargetVersion}`)
    }
    const embeddedSoundIds = new Set((parsed.state.customAudio ?? []).map(asset => asset.soundId))
    const missing = Array.from(new Set(parsed.state.markers
      .map(marker => marker.soundId)
      .filter(id => id && !soundMap[id] && !embeddedSoundIds.has(id))))
    if (missing.length) warnings.push(`存在しないsoundId: ${missing.join(', ')}`)
    if (warnings.length) window.alert(`警告:\n${warnings.join('\n')}`)
  }, [
    currentTargetVersion,
    playback,
    setDirty,
    setFilePath,
    soundMap,
    synchronizeProjectCustomAudio,
    timeline,
  ])

  const openingRef = useRef(false)
  const openPath = useCallback(async (path: string) => {
    if (openingRef.current) return
    openingRef.current = true
    try {
      if (onOpenDocumentPath) {
        await onOpenDocumentPath(path)
        return
      }
      if (!(await confirmDiscard())) return
      await applyProjectResult(await window.myAPI.timeline.openPath(path))
    }
    catch (error) {
      window.alert(`読込エラー: ${String(error)}`)
    }
    finally {
      openingRef.current = false
    }
  }, [applyProjectResult, confirmDiscard, onOpenDocumentPath])
  const openPathRef = useRef(openPath)
  openPathRef.current = openPath

  useEffect(() => {
    if (onOpenDocumentPath) return
    let disposed = false
    let unlistenOpen: (() => void) | undefined
    let unlistenDrop: (() => void) | undefined
    const consume = async () => {
      const paths = await window.myAPI.timeline.takeOpenRequests()
      for (const path of paths) {
        if (disposed) break
        await openPathRef.current(path)
      }
    }
    void window.myAPI.timeline.onOpenRequested(() => void consume()).then((unlisten) => {
      if (disposed) unlisten()
      else {
        unlistenOpen = unlisten
        void consume()
      }
    })
    void window.myAPI.timeline.onDragDrop((event) => {
      if (event.type === 'enter') setIsProjectDragOver(!!findKneadProjectPath(event.paths))
      else if (event.type === 'leave') setIsProjectDragOver(false)
      else if (event.type === 'drop') {
        setIsProjectDragOver(false)
        const paths = findKneadProjectPaths(event.paths)
        void (async () => {
          for (const path of paths) await openPathRef.current(path)
        })()
      }
    }).then((unlisten) => {
      if (disposed) unlisten()
      else unlistenDrop = unlisten
    })
    return () => {
      disposed = true
      unlistenOpen?.()
      unlistenDrop?.()
    }
  }, [onOpenDocumentPath])

  const handleOpen = useCallback(async () => {
    if (openingRef.current) return
    openingRef.current = true
    try {
      if (onOpenDocument) {
        await onOpenDocument()
        return
      }
      if (!(await confirmDiscard())) return
      await applyProjectResult(await window.myAPI.timeline.openDialog())
    }
    catch (error) {
      window.alert(`読込エラー: ${String(error)}`)
    }
    finally {
      openingRef.current = false
    }
  }, [applyProjectResult, confirmDiscard, onOpenDocument])

  const saveAs = useCallback(async () => {
    if (onSaveDocumentAs) {
      await onSaveDocumentAs()
      return
    }
    const savedState = stateRef.current
    const ownerDocumentId = documentId ?? savedState.projectId
    const serialized = serializeStudioSongFile(
      savedState,
      localFileKind,
      filePath ?? 'untitled',
      localNbsTargetVersion ?? nbsTargetVersionForState(savedState),
    )
    if (serialized.lossWarnings.length > 0 && !(await requestConfirmation({
      title: t('studio.nbs_plain_save_loss_title'),
      message: [
        t('studio.nbs_plain_save_loss_confirm'),
        '',
        ...serialized.warnings.map(warning => `• ${warning}`),
      ].join('\n'),
      confirmLabel: t('studio.save'),
    }))) return
    const defaultName = filePath ?? `untitled.${localFileKind}`
    const result = await window.myAPI.timeline.saveDialog(
      ownerDocumentId,
      defaultName,
      serialized.payload,
    )
    if (!result.ok) {
      if (!('canceled' in result)) window.alert(`保存エラー: ${result.error}`)
      return
    }
    if (onDocumentSaved) await onDocumentSaved(savedState, result.path)
    else setFilePath(result.path)
    if (stateRef.current === savedState) {
      if (!onDocumentSaved) setDirty(false)
      if (!(await clearRecoveryAfterSave())) {
        console.warn('The project was saved, but its recovery snapshot could not be cleared')
      }
    }
  }, [
    clearRecoveryAfterSave,
    documentId,
    filePath,
    localFileKind,
    localNbsTargetVersion,
    onDocumentSaved,
    onSaveDocumentAs,
    requestConfirmation,
    setDirty,
    setFilePath,
    t,
  ])

  const save = useCallback(async () => {
    if (onSaveDocument) {
      await onSaveDocument()
      return
    }
    if (!filePath) return saveAs()
    const savedState = stateRef.current
    const serialized = serializeStudioSongFile(
      savedState,
      localFileKind,
      filePath,
      localNbsTargetVersion ?? nbsTargetVersionForState(savedState),
    )
    if (serialized.lossWarnings.length > 0 && !(await requestConfirmation({
      title: t('studio.nbs_plain_save_loss_title'),
      message: [
        t('studio.nbs_plain_save_loss_confirm'),
        '',
        ...serialized.warnings.map(warning => `• ${warning}`),
      ].join('\n'),
      confirmLabel: t('studio.save'),
    }))) return
    const result = await window.myAPI.timeline.save(
      documentId ?? savedState.projectId,
      serialized.payload,
    )
    if (!result.ok) window.alert(`保存エラー: ${result.error}`)
    else {
      if (onDocumentSaved) await onDocumentSaved(savedState, result.path)
      if (stateRef.current !== savedState) return
      if (!onDocumentSaved) setDirty(false)
      if (!(await clearRecoveryAfterSave())) {
        console.warn('The project was saved, but its recovery snapshot could not be cleared')
      }
    }
  }, [
    clearRecoveryAfterSave,
    documentId,
    filePath,
    localFileKind,
    localNbsTargetVersion,
    onDocumentSaved,
    onSaveDocument,
    requestConfirmation,
    saveAs,
    setDirty,
    t,
  ])

  const newProject = useCallback(async () => {
    if (onNewDocument) {
      await onNewDocument()
      return
    }
    if (!(await confirmDiscard())) return
    playback.stop()
    skipDirtyRef.current = true
    const nextState = timeline.newProject()
    setFilePath(null)
    setLocalFileKind('kp')
    setLocalNbsTargetVersion(null)
    setDirty(false)
    setSelectedTrackId(nextState.tracks[0].id)
    clearSelection()
  }, [clearSelection, confirmDiscard, onNewDocument, playback, setDirty, setFilePath, timeline])

  const importNbsProject = useCallback(async (
    state: typeof timeline.state,
    warnings: string[],
    sourcePath: string,
  ): Promise<boolean> => {
    setNbsOpen(false)
    if (onImportDocument) {
      playback.stop()
      return onImportDocument(state, warnings, sourcePath, 'nbs')
    }
    if (!(await confirmDiscard())) return false
    playback.stop()
    skipDirtyRef.current = true
    timeline.replaceAll(state)
    setFilePath(null)
    setLocalFileKind('kp')
    setLocalNbsTargetVersion(null)
    setDirty(true)
    setSelectedIds(new Set())
    setSelectedTrackId(state.tracks[0].id)
    if (warnings.length) window.alert(`${t('studio.nbs_import_warnings')}:\n${warnings.join('\n')}`)
    document.title = `* Knead Studio - ${sourcePath.replace(/^.*[\\/]/, '')}`
    return true
  }, [confirmDiscard, onImportDocument, playback, setDirty, setFilePath, t, timeline])

  const importMidiProject = useCallback(async (
    state: typeof timeline.state,
    warnings: string[],
    sourcePath: string,
  ): Promise<boolean> => {
    setMidiOpen(false)
    const nextState = { ...state, customAudio: [] }
    if (onImportDocument) {
      playback.stop()
      return onImportDocument(nextState, warnings, sourcePath, 'midi')
    }
    if (!(await confirmDiscard())) return false
    playback.stop()
    skipDirtyRef.current = true
    timeline.replaceAll(nextState)
    setFilePath(null)
    setLocalFileKind('kp')
    setLocalNbsTargetVersion(null)
    setDirty(true)
    setSelectedIds(new Set())
    setSelectedTrackId(nextState.tracks[0].id)
    if (warnings.length) window.alert(`${t('studio.midi_import_warnings')}:\n${warnings.join('\n')}`)
    document.title = `* Knead Studio - ${sourcePath.replace(/^.*[\\/]/, '')}`
    return true
  }, [confirmDiscard, onImportDocument, playback, setDirty, setFilePath, t, timeline])

  const importNbpProject = useCallback(async (
    state: typeof timeline.state,
    warnings: readonly string[],
    sourcePath: string,
  ): Promise<boolean> => {
    setNbpOpen(false)
    const nextState = { ...state, customAudio: [] }
    if (onImportDocument) {
      playback.stop()
      return onImportDocument(nextState, warnings, sourcePath, 'nbp')
    }
    if (!(await confirmDiscard())) return false
    playback.stop()
    skipDirtyRef.current = true
    timeline.replaceAll(nextState)
    setFilePath(null)
    setLocalFileKind('kp')
    setLocalNbsTargetVersion(null)
    setDirty(true)
    setSelectedIds(new Set())
    setSelectedTrackId(nextState.tracks[0].id)
    if (warnings.length) window.alert(`${t('studio.nbp_import_warnings')}:\n${warnings.join('\n')}`)
    document.title = `* Knead Studio - ${sourcePath.replace(/^.*[\\/]/, '')}`
    return true
  }, [confirmDiscard, onImportDocument, playback, setDirty, setFilePath, t, timeline])

  const restoreRecoveryProject = useCallback(async (
    state: typeof timeline.state,
    snapshot: TimelineRecoveryMetadata,
    warnings: string[],
  ): Promise<boolean> => {
    if (onImportDocument) {
      playback.stop()
      return onImportDocument(
        state,
        warnings,
        snapshot.filePath ?? t('studio.unsaved'),
        'recovery',
      )
    }
    if (!(await confirmDiscard())) return false
    try {
      await synchronizeProjectCustomAudio(state.customAudio)
    }
    catch (error) {
      window.alert(t('studio.recovery_error', {
        error: error instanceof Error ? error.message : String(error),
      }))
      return false
    }
    playback.stop()
    skipDirtyRef.current = true
    timeline.replaceAll(state)
    // Recovery metadata remembers the original path for display, but the
    // native save target is window-scoped state that cannot be safely rebound
    // from renderer metadata. Force an explicit Save As so another open
    // project's path can never be overwritten by accident.
    setFilePath(null)
    setLocalFileKind('kp')
    setLocalNbsTargetVersion(null)
    setDirty(true)
    setSelectedIds(new Set())
    setSelectedTrackId(state.tracks[0].id)
    if (warnings.length) {
      window.alert(`${t('studio.recovery_restore_warnings')}:\n${warnings.join('\n')}`)
    }
    const name = snapshot.filePath?.replace(/^.*[\\/]/, '') ?? t('studio.unsaved')
    document.title = `* Knead Studio - ${name}`
    return true
  }, [
    confirmDiscard,
    onImportDocument,
    playback,
    setDirty,
    setFilePath,
    synchronizeProjectCustomAudio,
    t,
    timeline,
  ])

  const recordLiveMidiNote = useCallback((note: LiveMidiRecordedNote): string => {
    const currentState = stateRef.current
    const track = currentState.tracks.find(item => item.id === selectedTrackId && !item.locked)
      ?? currentState.tracks.find(item => !item.locked)
    if (!track) return ''
    const id = timeline.addMarker({
      trackId: track.id,
      tick: snapTickToTempoMap(playback.currentTick, currentState.settings, tempoModel),
      soundId: note.soundId,
      variantIndex: -1,
      volume: note.velocity,
      pitch: note.pitch,
      pan: 0,
      laneY: snapLaneY(1 - note.note / 127),
    })
    setSelectedIds(new Set([id]))
    selectionAnchorRef.current = id
    return id
  }, [playback.currentTick, selectedTrackId, tempoModel, timeline])

  const addTrack = useCallback(() => {
    const id = timeline.addTrack(selectedTrackId)
    setSelectedTrackId(id)
  }, [selectedTrackId, timeline])

  const addingReferenceAudioRef = useRef(false)
  const addReferenceAudio = useCallback(async () => {
    if (addingReferenceAudioRef.current) return
    addingReferenceAudioRef.current = true
    try {
      const result = await window.myAPI.referenceAudio.open()
      if (!result.ok) {
        if (!('canceled' in result)) window.alert(`${t('studio.reference_audio_error')}: ${result.error}`)
        return
      }
      assertCanAddReferenceAudio(stateRef.current.referenceAudio ?? [], result.byteLength)
      const bytes = readReferenceAudioFileData(result)
      const buffer = await cache.decodeReferenceAudio(bytes)
      const track = createReferenceAudioTrackDraft(result, bytes, buffer.duration)
      const id = timeline.addReferenceAudio(track)
      cache.seedReferenceAudio(
        id,
        track.fingerprint,
        track.byteLength,
        track.dataBase64,
        buffer,
      )
    }
    catch (error) {
      window.alert(`${t('studio.reference_audio_error')}: ${error instanceof Error ? error.message : String(error)}`)
    }
    finally {
      addingReferenceAudioRef.current = false
    }
  }, [cache, t, timeline])

  const removeTrack = useCallback(async (trackId: string) => {
    const track = stateRef.current.tracks.find(item => item.id === trackId)
    if (!track || stateRef.current.tracks.length <= 1) return
    const count = stateRef.current.markers.filter(marker => marker.trackId === trackId).length
    if (count && !(await requestConfirmation({
      title: t('studio.delete_track_title'),
      message: t('studio.delete_track_message', { name: track.name, count }),
      confirmLabel: t('studio.delete'),
    }))) return
    const nextTrackId = stateRef.current.tracks.find(item => item.id !== trackId)?.id
    timeline.removeTrack(trackId)
    if (selectedTrackId === trackId && nextTrackId) setSelectedTrackId(nextTrackId)
    clearSelection()
  }, [clearSelection, requestConfirmation, selectedTrackId, t, timeline])

  const fitRange = useCallback((startTick: number, endTick: number) => {
    const viewport = scrollRef.current
    if (!viewport) return
    const availableWidth = Math.max(
      160,
      viewport.clientWidth - TRACK_HEADER_WIDTH - TIMELINE_LEADING_PADDING_PX - 32,
    )
    const nextZoom = Math.max(1.5, Math.min(64, availableWidth / Math.max(1, endTick - startTick)))
    setPxPerTick(nextZoom)
    requestAnimationFrame(() => {
      viewport.scrollLeft = Math.max(
        0,
        TRACK_HEADER_WIDTH + TIMELINE_LEADING_PADDING_PX + tickToPx(startTick, nextZoom) - 16,
      )
    })
  }, [])

  const syncViewportRange = useCallback(() => {
    const viewport = scrollRef.current
    if (!viewport) return
    setViewportRange(timelineViewportRange(
      viewport.scrollLeft,
      viewport.clientWidth,
      pxPerTick,
      TRACK_HEADER_WIDTH,
      TIMELINE_LEADING_PADDING_PX,
      stateRef.current.lengthTicks,
    ))
  }, [pxPerTick])

  useEffect(() => {
    const viewport = scrollRef.current
    if (!viewport) return
    syncViewportRange()
    const observer = new ResizeObserver(syncViewportRange)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [syncViewportRange, timeline.state.lengthTicks])

  const navigateOverview = useCallback((tick: number) => {
    const viewport = scrollRef.current
    playback.seek(tick)
    if (!viewport) return
    const timelineWidth = Math.max(0, viewport.clientWidth - TRACK_HEADER_WIDTH)
    viewport.scrollLeft = Math.max(
      0,
      TRACK_HEADER_WIDTH + TIMELINE_LEADING_PADDING_PX + tickToPx(tick, pxPerTick) - timelineWidth / 2,
    )
    requestAnimationFrame(syncViewportRange)
  }, [playback, pxPerTick, syncViewportRange])

  const fitSelection = useCallback(() => {
    const markers = stateRef.current.markers.filter(marker => selectedIdsRef.current.has(marker.id))
    if (markers.length === 0) return
    const startTick = Math.min(...markers.map(marker => marker.tick))
    const endTick = Math.max(...markers.map(marker => marker.tick + Math.max(1, marker.duration ?? 1)))
    fitRange(startTick, endTick)
  }, [fitRange])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      const mod = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()
      if ((mod && key === 'k') || (mod && event.shiftKey && key === 'p')) {
        event.preventDefault()
        if (!commandPaletteOpen && !blockingDialogOpen) setCommandPaletteOpen(true)
        return
      }
      if (commandPaletteOpen) return
      if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName) || target.isContentEditable) return
      if (mod && key === 'n') {
        event.preventDefault()
        void newProject()
      }
      else if (mod && key === 'o') {
        event.preventDefault()
        void handleOpen()
      }
      else if (mod && key === 's') {
        event.preventDefault()
        void (event.shiftKey ? saveAs() : save())
      }
      else if (mod && key === 'e') {
        event.preventDefault()
        setCommandExportOpen(true)
      }
      else if (mod && key === 'a') {
        event.preventDefault()
        setSelectedIds(new Set(stateRef.current.markers.filter(marker => (
          !stateRef.current.tracks.find(track => track.id === marker.trackId)?.locked
        )).map(marker => marker.id)))
      }
      else if (mod && key === 'x') {
        event.preventDefault()
        copy()
        deleteSelected()
      }
      else if (mod && key === 'c') {
        event.preventDefault()
        copy()
      }
      else if (mod && key === 'v') {
        event.preventDefault()
        paste()
      }
      else if (mod && key === 'd') {
        event.preventDefault()
        duplicateSelected()
      }
      else if (mod && key === 'z' && !event.shiftKey) {
        event.preventDefault()
        timeline.undo()
      }
      else if ((mod && key === 'y') || (mod && event.shiftKey && key === 'z')) {
        event.preventDefault()
        timeline.redo()
      }
      else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        deleteSelected()
      }
      else if (event.key === ' ') {
        event.preventDefault()
        if (event.shiftKey) playback.stop()
        else if (playback.isPlaying) playback.pause()
        else if (playback.isPaused) playback.resume()
        else playback.play()
      }
      else if (event.key === 'Home') {
        event.preventDefault()
        playback.seek(0)
      }
      else if (key === 'l') timeline.setSettings({ loop: { ...stateRef.current.settings.loop, enabled: !stateRef.current.settings.loop.enabled } })
      else if (key === 'm') timeline.setSettings({ metronomeEnabled: !stateRef.current.settings.metronomeEnabled })
      else if (key === 'i') timeline.setSettings({ loop: { ...stateRef.current.settings.loop, startTick: Math.floor(playback.currentTick) } })
      else if (key === 'o') timeline.setSettings({ loop: { ...stateRef.current.settings.loop, endTick: Math.max(stateRef.current.settings.loop.startTick + 1, Math.floor(playback.currentTick)) } })
      else if (event.key === 'Escape') clearSelection()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    blockingDialogOpen, clearSelection, commandPaletteOpen, copy, deleteSelected, duplicateSelected, handleOpen, newProject,
    paste, playback, save, saveAs, timeline,
  ])

  useEffect(() => {
    if (!playback.isPlaying || !scrollRef.current) return
    const x = TRACK_HEADER_WIDTH + TIMELINE_LEADING_PADDING_PX
      + tickToPx(playback.currentTick, pxPerTick)
    const element = scrollRef.current
    const margin = 80
    if (x < element.scrollLeft + TRACK_HEADER_WIDTH + margin) {
      element.scrollLeft = Math.max(0, x - TRACK_HEADER_WIDTH - margin)
    }
    else if (x > element.scrollLeft + element.clientWidth - margin) {
      element.scrollLeft = x - element.clientWidth + margin
    }
  }, [playback.currentTick, playback.isPlaying, pxPerTick])

  const selectedMarkers = useMemo(
    () => timeline.state.markers.filter(marker => selectedIds.has(marker.id)),
    [selectedIds, timeline.state.markers],
  )
  const lockedTrackIds = useMemo(
    () => new Set(timeline.state.tracks.filter(track => track.locked).map(track => track.id)),
    [timeline.state.tracks],
  )
  const editableSelectedMarkers = useMemo(
    () => selectedMarkers.filter(marker => !lockedTrackIds.has(marker.trackId)),
    [lockedTrackIds, selectedMarkers],
  )
  const hasEditableSelection = editableSelectedMarkers.length > 0
  const hasEditableMarkers = timeline.state.markers.some(marker => !lockedTrackIds.has(marker.trackId))
  const singleSelected = editableSelectedMarkers.length === 1 ? editableSelectedMarkers[0] : null
  const commonSound = editableSelectedMarkers.length > 0
    && editableSelectedMarkers.every(marker => marker.soundId === editableSelectedMarkers[0].soundId)
    ? editableSelectedMarkers[0].soundId
    : null
  const variants = commonSound ? (soundMap[commonSound] ?? []) : []
  const noteTrackHeight = timeline.state.tracks.reduce(
    (sum, track) => sum + (track.collapsed ? TRACK_HEIGHT_COLLAPSED : TRACK_HEIGHT),
    0,
  )
  const referenceAudioHeight = referenceAudio.reduce(
    (sum, track) => sum + (track.collapsed
      ? REFERENCE_AUDIO_TRACK_HEIGHT_COLLAPSED
      : REFERENCE_AUDIO_TRACK_HEIGHT),
    0,
  )
  const totalTrackHeight = noteTrackHeight + referenceAudioHeight
  const contentWidth = TIMELINE_LEADING_PADDING_PX
    + tickToPx(timeline.state.lengthTicks, pxPerTick)
  const exportName = (filePath?.replace(/^.*[\\/]/, '').replace(/\.kp$/i, '') || 'knead-mix')

  const applyExtensionState = useCallback((nextState: typeof timeline.state, nextSelectedIds: readonly string[] = []) => {
    playback.stop()
    timeline.applyState(nextState)
    const nextSelection = new Set(nextSelectedIds)
    setSelectedIds(nextSelection)
    selectionAnchorRef.current = nextSelectedIds.at(-1) ?? null
    const first = nextState.markers.find(marker => nextSelection.has(marker.id))
    if (first) setSelectedTrackId(first.trackId)
  }, [playback, timeline])

  const commandCategories = {
    file: t('studio.command_palette_category_file'),
    edit: t('studio.command_palette_category_edit'),
    transport: t('studio.command_palette_category_transport'),
    view: t('studio.command_palette_category_view'),
    tools: t('studio.command_palette_category_tools'),
  }
  const describeCommand = (label: string) => t('studio.command_palette_action_description', { action: label })
  const command = (
    id: string,
    label: string,
    category: string,
    run: () => void | Promise<void>,
    shortcut?: string,
    disabled = false,
    disabledReason?: string,
  ): CommandPaletteCommand => ({
    id,
    label,
    description: describeCommand(label),
    category,
    shortcut,
    disabled,
    ...(disabled && disabledReason ? { disabledReason } : {}),
    run,
  })
  const runAfterClosingPalette = (
    action: () => void | Promise<void>,
  ): (() => Promise<void>) => async () => {
    setCommandPaletteOpen(false)
    // Let React remove the high-z-index palette before an action opens a
    // confirmation, native picker, or another modal.
    await new Promise<void>(resolve => window.setTimeout(resolve, 0))
    await action()
  }
  const commandPaletteCommands: CommandPaletteCommand[] = [
    command('file.new', t('studio.new'), commandCategories.file, runAfterClosingPalette(newProject), 'Ctrl/Cmd+N'),
    command('file.open', t('studio.open'), commandCategories.file, runAfterClosingPalette(handleOpen), 'Ctrl/Cmd+O'),
    command('file.save', t('studio.save'), commandCategories.file, runAfterClosingPalette(save), 'Ctrl/Cmd+S'),
    command('file.save-as', t('studio.save_as'), commandCategories.file, runAfterClosingPalette(saveAs), 'Ctrl/Cmd+Shift+S'),
    command('export.audio', t('studio.audio_export_short'), commandCategories.file, runAfterClosingPalette(() => setExportOpen(true))),
    command('export.datapack', t('studio.command_export_short'), commandCategories.file, runAfterClosingPalette(() => setCommandExportOpen(true)), 'Ctrl/Cmd+E'),
    command('export.note-block-build', t('studio.note_block_build_short'), commandCategories.file, runAfterClosingPalette(() => setNoteBlockBuildOpen(true))),
    command('exchange.nbs', t('studio.nbs_short'), commandCategories.file, runAfterClosingPalette(() => setNbsOpen(true))),
    command('exchange.nbp', t('studio.nbp_short'), commandCategories.file, runAfterClosingPalette(() => setNbpOpen(true))),
    command('exchange.midi', t('studio.midi_short'), commandCategories.file, runAfterClosingPalette(() => setMidiOpen(true))),
    command('edit.undo', t('studio.command_palette_undo'), commandCategories.edit, timeline.undo, 'Ctrl/Cmd+Z', !timeline.canUndo, t('studio.command_palette_nothing_to_undo')),
    command('edit.redo', t('studio.command_palette_redo'), commandCategories.edit, timeline.redo, 'Ctrl/Cmd+Y', !timeline.canRedo, t('studio.command_palette_nothing_to_redo')),
    command('edit.select-all', t('studio.command_palette_select_all'), commandCategories.edit, () => {
      setSelectedIds(new Set(stateRef.current.markers.filter(marker => (
        !stateRef.current.tracks.find(track => track.id === marker.trackId)?.locked
      )).map(marker => marker.id)))
    }, 'Ctrl/Cmd+A', !hasEditableMarkers, t('studio.command_palette_no_editable_markers')),
    command('edit.duplicate', t('studio.command_palette_duplicate'), commandCategories.edit, duplicateSelected, 'Ctrl/Cmd+D', !hasEditableSelection, t('studio.command_palette_editable_selection_required')),
    command('edit.delete', t('studio.delete'), commandCategories.edit, deleteSelected, 'Delete', !hasEditableSelection, t('studio.command_palette_editable_selection_required')),
    command('edit.add-sound-stopper', t('studio.add_sound_stopper'), commandCategories.edit, () => addSoundStopAtTick(
      snapTickToTempoMap(playback.currentTick, stateRef.current.settings, tempoModel),
      selectedTrackId,
    ), undefined, stateRef.current.tracks.find(track => track.id === selectedTrackId)?.locked === true),
    command('edit.nbs-macros', t('studio.nbs_macros_short'), commandCategories.edit, runAfterClosingPalette(() => setNbsMacrosOpen(true)), undefined, !hasEditableSelection, t('studio.command_palette_editable_selection_required')),
    command(
      'transport.toggle-play',
      playback.isPlaying ? t('studio.pause') : playback.isPaused ? t('studio.resume') : t('studio.play'),
      commandCategories.transport,
      () => playback.isPlaying ? playback.pause() : playback.isPaused ? playback.resume() : playback.play(),
      'Space',
      cache.preloading,
      t('studio.command_palette_audio_loading'),
    ),
    command('transport.stop', t('studio.stop'), commandCategories.transport, playback.stop, 'Shift+Space'),
    command('transport.toggle-loop', t('studio.player_loop'), commandCategories.transport, () => timeline.setSettings({
      loop: { ...stateRef.current.settings.loop, enabled: !stateRef.current.settings.loop.enabled },
    }), 'L'),
    command('transport.toggle-metronome', t('studio.metronome'), commandCategories.transport, () => timeline.setSettings({
      metronomeEnabled: !stateRef.current.settings.metronomeEnabled,
    }), 'M'),
    command('view.fit-project', t('studio.fit_all'), commandCategories.view, () => fitRange(0, stateRef.current.lengthTicks)),
    command('view.fit-selection', t('studio.fit_selection'), commandCategories.view, fitSelection, undefined, selectedIds.size === 0, t('studio.command_palette_selection_required')),
    command('view.mixer', t('studio.mixer'), commandCategories.view, () => setMixerOpen(value => !value)),
    command('view.navigator', t('studio.navigator'), commandCategories.view, toggleNavigator),
    command('view.marker-icons', t('studio.marker_icons'), commandCategories.view, toggleMarkerIcons),
    command('view.player-mode', t('studio.player_mode_short'), commandCategories.view, runAfterClosingPalette(() => setPlayerModeOpen(true))),
    command('view.piano-roll', t('studio.piano_roll_short'), commandCategories.view, runAfterClosingPalette(() => setPianoRollOpen(true))),
    command('tools.tempo-map', t('studio.tempo_map_short'), commandCategories.tools, runAfterClosingPalette(() => setTempoMapOpen(true))),
    command('tools.song-metadata', t('studio.song_metadata_short'), commandCategories.tools, runAfterClosingPalette(() => setSongMetadataOpen(true))),
    command('tools.custom-instruments', t('studio.custom_instrument_short'), commandCategories.tools, runAfterClosingPalette(() => setCustomInstrumentsOpen(true))),
    command('tools.resource-pack', t('studio.resource_pack_short'), commandCategories.tools, runAfterClosingPalette(() => setResourcePackOpen(true))),
    command('tools.recovery', t('studio.recovery_short'), commandCategories.tools, runAfterClosingPalette(() => setRecoveryOpen(true))),
    command('tools.extensions', t('studio.extensions_short'), commandCategories.tools, runAfterClosingPalette(() => setExtensionsOpen(true))),
  ]

  return (
    <Box
      className={embeddedWorkspace ? undefined : 'studio-shell'}
      display="flex" flexDir="column" h={embeddedWorkspace ? '100%' : '100vh'} position="relative"
    >
      {isProjectDragOver && (
        <Box position="absolute" inset="0" zIndex="1500" pointerEvents="none" bg="rgba(0,0,0,.75)" display="flex" alignItems="center" justifyContent="center">
          <Text color="white" fontSize="xl" fontWeight="bold">{t('studio.song_tab_drop')}</Text>
        </Box>
      )}
      <TimelineToolbar
        onNew={newProject}
        onOpen={handleOpen}
        onCommandPalette={() => setCommandPaletteOpen(true)}
        onSave={save}
        onSaveAs={saveAs}
        onAudioExport={() => setExportOpen(true)}
        onCommandExport={() => setCommandExportOpen(true)}
        onNoteBlockBuild={() => setNoteBlockBuildOpen(true)}
        onNbs={() => setNbsOpen(true)}
        onNbp={() => setNbpOpen(true)}
        onNbsMacros={() => setNbsMacrosOpen(true)}
        onResourcePack={() => setResourcePackOpen(true)}
        onRecovery={() => setRecoveryOpen(true)}
        recoverySaving={recoverySaving}
        recoveryError={recoveryError}
        onPlayerMode={() => setPlayerModeOpen(true)}
        onPianoRoll={() => setPianoRollOpen(true)}
        onTempoMap={() => setTempoMapOpen(true)}
        onSongMetadata={() => setSongMetadataOpen(true)}
        onCustomInstruments={() => setCustomInstrumentsOpen(true)}
        onMidi={() => setMidiOpen(true)}
        onExtensions={() => setExtensionsOpen(true)}
        onAddMarker={() => addAtTick(
          snapTickToTempoMap(playback.currentTick, timeline.state.settings, tempoModel),
          selectedTrackId,
        )}
        onAddSoundStopper={() => addSoundStopAtTick(
          snapTickToTempoMap(playback.currentTick, timeline.state.settings, tempoModel),
          selectedTrackId,
        )}
        canAddMarker={timeline.state.tracks.some(track => track.id === selectedTrackId && !track.locked)}
        onAddTrack={addTrack}
        onAddReferenceAudio={() => void addReferenceAudio()}
        onDeleteSelected={deleteSelected}
        canDelete={hasEditableSelection}
        onTogglePlay={() => playback.isPlaying ? playback.pause() : playback.isPaused ? playback.resume() : playback.play()}
        onStop={playback.stop}
        isPlaying={playback.isPlaying}
        isPaused={playback.isPaused}
        currentTick={playback.currentTick}
        preloading={cache.preloading}
        onUndo={timeline.undo}
        onRedo={timeline.redo}
        canUndo={timeline.canUndo}
        canRedo={timeline.canRedo}
        settings={timeline.state.settings}
        onSettingsChange={timeline.setSettings}
        onReroll={timeline.rerollRandomSeed}
        pxPerTick={pxPerTick}
        onZoom={value => setPxPerTick(Math.max(1.5, Math.min(64, value)))}
        onFitProject={() => fitRange(0, timeline.state.lengthTicks)}
        onFitSelection={fitSelection}
        canFitSelection={selectedIds.size > 0}
        mixerOpen={mixerOpen}
        onToggleMixer={() => setMixerOpen(value => !value)}
        markerIconsEnabled={markerIconsEnabled}
        markerIconsLoading={markerIcons.loading}
        onToggleMarkerIcons={toggleMarkerIcons}
        navigatorOpen={navigatorOpen}
        onToggleNavigator={toggleNavigator}
      />

      <Box
        ref={scrollRef}
        className="studio-timeline-viewport"
        flex="1"
        minH="120px"
        overflow="auto"
        onScroll={syncViewportRange}
        onWheel={(event) => {
          if (!(event.ctrlKey || event.metaKey)) return
          event.preventDefault()
          setPxPerTick(value => Math.max(1.5, Math.min(64, value * (event.deltaY > 0 ? 0.88 : 1.12))))
        }}
      >
        <Box position="relative" w={`${TRACK_HEADER_WIDTH + contentWidth}px`} minW="100%" minH="100%">
          <Box
            aria-hidden="true"
            position="absolute" top="32px" bottom="0" left={`${TRACK_HEADER_WIDTH}px`} right="0"
            pointerEvents="none"
            backgroundImage="linear-gradient(to right, var(--studio-lane-grid) 1px, transparent 1px)"
            backgroundPosition={`${TIMELINE_LEADING_PADDING_PX}px 0`}
            backgroundSize={`${pxPerTick * 5}px 100%`}
          />
          <Flex position="sticky" top="0" zIndex="20">
            <Flex
              position="sticky" left="0" zIndex="22"
              w={`${TRACK_HEADER_WIDTH}px`} minW={`${TRACK_HEADER_WIDTH}px`} h="32px"
              align="center" px="3" bg="var(--studio-frame)" borderRight="1px solid" borderBottom="1px solid"
              borderColor="var(--studio-line)"
            >
              <Text fontSize="xs" fontWeight="semibold" color="var(--studio-muted)">{t('studio.tracks')}</Text>
            </Flex>
            <TimelineRuler
              lengthTicks={timeline.state.lengthTicks}
              pxPerTick={pxPerTick}
              settings={timeline.state.settings}
              tempoMap={timeline.state.tempoMap}
              onSeek={playback.seek}
              onLoopChange={(startTick, endTick) => timeline.setSettings({
                loop: { ...timeline.state.settings.loop, startTick, endTick },
              })}
            />
          </Flex>
          {referenceAudio.map(track => (
            <ReferenceAudioTrackRow
              key={track.id}
              track={track}
              waveform={cache.getReferenceWaveform(track.id)}
              error={cache.getReferenceError(track.id)}
              meter={playback.referenceAudioMeters[track.id]}
              lengthTicks={timeline.state.lengthTicks}
              pxPerTick={pxPerTick}
              settings={timeline.state.settings}
              tempoMap={timeline.state.tempoMap}
              onChange={patch => timeline.updateReferenceAudio(track.id, patch)}
              onRemove={() => timeline.removeReferenceAudio(track.id)}
              onBeginEdit={timeline.beginTransaction}
              onEndEdit={timeline.commitTransaction}
              onSeek={playback.seek}
            />
          ))}
          {timeline.state.tracks.map((track, index) => (
            <Flex key={track.id}>
              <Box position="sticky" left="0" zIndex="12" w={`${TRACK_HEADER_WIDTH}px`} minW={`${TRACK_HEADER_WIDTH}px`}>
                <TrackHeader
                  track={track}
                  index={index}
                  selected={selectedTrackId === track.id}
                  meter={playback.trackMeters[track.id]}
                  canDelete={timeline.state.tracks.length > 1}
                  onSelect={() => setSelectedTrackId(track.id)}
                  onChange={patch => timeline.updateTrack(track.id, patch)}
                  onDuplicate={() => setSelectedTrackId(timeline.duplicateTrack(track.id))}
                  onDelete={() => void removeTrack(track.id)}
                  onMove={(draggedId, toIndex) => timeline.reorderTrack(draggedId, toIndex)}
                />
              </Box>
              <TimelineTrack
                track={track}
                markers={timeline.state.markers.filter(marker => marker.trackId === track.id)}
                lengthTicks={timeline.state.lengthTicks}
                pxPerTick={pxPerTick}
                settings={timeline.state.settings}
                tempoMap={timeline.state.tempoMap}
                selectedIds={selectedIds}
                validSoundIds={validSoundIds}
                markerIcons={markerIcons.icons}
                onSelectMarker={handleMarkerSelect}
                onClearSelection={clearSelection}
                onRectangleSelect={rectangleSelect}
                onBeginEdit={captureMoveOrigins}
                onEndEdit={timeline.commitTransaction}
                onMoveSelection={moveSelection}
                onResizeMarker={(id, tick, duration) => timeline.updateMarker(id, { tick, duration })}
                onDuplicateForDrag={duplicateForDrag}
                onAddMarker={addAtTick}
              />
            </Flex>
          ))}
          <Box position="absolute" left={`${TRACK_HEADER_WIDTH}px`} top="0" pointerEvents="none">
            {timeline.state.settings.loop.enabled && (
              <Box
                position="absolute"
                left={`${TIMELINE_LEADING_PADDING_PX + tickToPx(timeline.state.settings.loop.startTick, pxPerTick)}px`}
                top="32px"
                h={`${totalTrackHeight}px`}
                w={`${tickToPx(timeline.state.settings.loop.endTick - timeline.state.settings.loop.startTick, pxPerTick)}px`}
                bg="rgba(34,197,94,.035)"
                borderX="1px solid rgba(74,222,128,.35)"
              />
            )}
            <TimelinePlayhead currentTick={playback.currentTick} pxPerTick={pxPerTick} heightPx={32 + totalTrackHeight} />
          </Box>
        </Box>
      </Box>

      {mixerOpen && (
        <MixerPanel
          tracks={timeline.state.tracks}
          referenceAudio={referenceAudio}
          master={timeline.state.master}
          trackMeters={playback.trackMeters}
          referenceAudioMeters={playback.referenceAudioMeters}
          masterMeter={playback.masterMeter}
          onTrackChange={timeline.updateTrack}
          onReferenceAudioChange={timeline.updateReferenceAudio}
          onMasterChange={timeline.setMaster}
        />
      )}

      {navigatorOpen && (
        <ArrangementOverview
          tracks={timeline.state.tracks}
          markers={timeline.state.markers}
          referenceAudio={referenceAudio}
          settings={timeline.state.settings}
          lengthTicks={timeline.state.lengthTicks}
          currentTick={playback.currentTick}
          viewport={viewportRange}
          onSeek={navigateOverview}
          label={t('studio.navigator')}
        />
      )}

      <TimelinePropertyPanel
        marker={singleSelected}
        selectionCount={editableSelectedMarkers.length}
        selectedMarkers={editableSelectedMarkers}
        tracks={timeline.state.tracks}
        soundIdList={soundIdList}
        variants={variants}
        onChange={patch => timeline.updateMarkers(editableSelectedMarkers.map(marker => marker.id), patch)}
        onShiftTick={(delta) => {
          const currentLockedTrackIds = new Set(
            stateRef.current.tracks.filter(track => track.locked).map(track => track.id),
          )
          const selected = stateRef.current.markers.filter(marker => (
            selectedIdsRef.current.has(marker.id) && !currentLockedTrackIds.has(marker.trackId)
          ))
          if (selected.length === 0) return
          const min = Math.min(...selected.map(marker => marker.tick))
          const clamped = Math.max(-min, delta)
          timeline.moveMarkers(new Map(selected.map(marker => [marker.id, marker.tick + clamped])))
        }}
        onBeginEdit={timeline.beginTransaction}
        onEndEdit={timeline.commitTransaction}
        soundFocusRequest={soundFocusRequest}
        onSoundFocusHandled={() => setSoundFocusRequest(0)}
      />

      <ExportDialog
        open={exportOpen}
        project={timeline.state}
        defaultName={exportName}
        soundManifest={soundMap}
        onClose={() => setExportOpen(false)}
      />
      <CommandExportDialog
        open={commandExportOpen}
        project={timeline.state}
        defaultName={exportName}
        onClose={() => setCommandExportOpen(false)}
      />
      <NoteBlockBuildDialog
        open={noteBlockBuildOpen}
        project={timeline.state}
        defaultName={exportName}
        onClose={() => setNoteBlockBuildOpen(false)}
      />
      <NbsDialog
        open={nbsOpen}
        project={timeline.state}
        defaultName={exportName}
        targetVersion={currentTargetVersion ?? timeline.state.targetVersion}
        soundManifest={soundMap}
        onImport={importNbsProject}
        onClose={() => setNbsOpen(false)}
      />
      <NbpDialog
        open={nbpOpen}
        project={timeline.state}
        selectedIds={selectedIds}
        defaultName={exportName}
        currentTick={playback.currentTick}
        targetVersion={currentTargetVersion ?? timeline.state.targetVersion ?? ''}
        onInsert={(nextState, nextSelectedIds) => applyExtensionState(nextState, nextSelectedIds)}
        onReplace={importNbpProject}
        onClose={() => setNbpOpen(false)}
      />
      <NbsMacroDialog
        open={nbsMacrosOpen}
        project={timeline.state}
        selectedIds={selectedIds}
        onApply={applyExtensionState}
        onClose={() => setNbsMacrosOpen(false)}
      />
      <ResourcePackDialog
        open={resourcePackOpen}
        existingCustomAudio={timeline.state.customAudio ?? []}
        referenceAudioBytes={referenceAudio.reduce((sum, audio) => sum + audio.byteLength, 0)}
        onInstall={(assets) => {
          playback.stop()
          timeline.applyState({ ...stateRef.current, customAudio: [...assets] })
        }}
        onClose={() => setResourcePackOpen(false)}
      />
      <RecoveryDialog
        open={recoveryOpen}
        onRestore={restoreRecoveryProject}
        onClose={() => setRecoveryOpen(false)}
      />
      <PlayerModeOverlay
        open={playerModeOpen}
        title={exportName}
        lengthTicks={timeline.state.lengthTicks}
        currentTick={playback.currentTick}
        settings={timeline.state.settings}
        tempoMap={timeline.state.tempoMap}
        tracks={timeline.state.tracks}
        referenceAudio={referenceAudio}
        trackMeters={playback.trackMeters}
        referenceAudioMeters={playback.referenceAudioMeters}
        masterMeter={playback.masterMeter}
        isPlaying={playback.isPlaying}
        isPaused={playback.isPaused}
        preloading={cache.preloading}
        onTogglePlay={() => (
          playback.isPlaying ? playback.pause() : playback.isPaused ? playback.resume() : playback.play()
        )}
        onStop={playback.stop}
        onSeek={playback.seek}
        onToggleLoop={enabled => timeline.setSettings({
          loop: { ...timeline.state.settings.loop, enabled },
        })}
        onClose={() => setPlayerModeOpen(false)}
      />
      <PianoRollDialog
        open={pianoRollOpen}
        project={timeline.state}
        selectedIds={selectedIds}
        currentTrackId={selectedTrackId}
        tempoMap={timeline.state.tempoMap}
        onApply={applyExtensionState}
        onAudition={auditionMarker}
        onClose={() => setPianoRollOpen(false)}
      />
      <TempoMapDialog
        open={tempoMapOpen}
        events={timeline.state.tempoMap}
        settings={timeline.state.settings}
        lengthTicks={timeline.state.lengthTicks}
        currentTick={playback.currentTick}
        onApply={(events) => {
          playback.stop()
          timeline.setTempoMap(events)
        }}
        onClose={() => setTempoMapOpen(false)}
      />
      <SongMetadataDialog
        open={songMetadataOpen}
        metadata={timeline.state.metadata}
        loop={timeline.state.settings.loop}
        lengthTicks={timeline.state.lengthTicks}
        onApply={({ metadata, loop }) => {
          playback.stop()
          timeline.setSongMetadataAndLoop(metadata, loop)
        }}
        onClose={() => setSongMetadataOpen(false)}
      />
      <CustomInstrumentDialog
        open={customInstrumentsOpen}
        project={timeline.state}
        onApply={(state, warnings) => {
          playback.stop()
          timeline.applyState(state)
          if (warnings.length) {
            window.alert(`${t('studio.custom_instrument_warnings')}:\n${warnings.join('\n')}`)
          }
        }}
        onClose={() => setCustomInstrumentsOpen(false)}
      />
      <CommandPaletteDialog
        open={commandPaletteOpen}
        commands={commandPaletteCommands}
        onClose={() => setCommandPaletteOpen(false)}
      />
      <MidiDialog
        open={midiOpen}
        targetVersion={currentTargetVersion ?? timeline.state.targetVersion}
        currentTick={playback.currentTick}
        canRecord={timeline.state.tracks.some(track => !track.locked)}
        soundIds={soundIdList}
        defaultSoundId={defaultSoundId || soundIdList[0] || 'block.note_block.harp'}
        onImport={importMidiProject}
        onRecordNote={recordLiveMidiNote}
        onUpdateRecordedNote={timeline.updateMarker}
        onBeginRecording={timeline.beginTransaction}
        onEndRecording={timeline.commitTransaction}
        onClose={() => setMidiOpen(false)}
      />
      <ExtensionManagerDialog
        open={extensionsOpen}
        project={timeline.state}
        selectedIds={selectedIds}
        onApply={applyExtensionState}
        onClose={() => setExtensionsOpen(false)}
      />
      <Modal.Root
        withCloseButton={false}
        open={confirmation !== null}
        title={confirmation?.title}
        cancel={t('studio.cancel')}
        success={{ children: confirmation?.confirmLabel, colorScheme: 'red' }}
        closeOnOverlay={false}
        onClose={() => settleConfirmation(false)}
        onCancel={() => settleConfirmation(false)}
        onSuccess={() => settleConfirmation(true)}
        body={<Text whiteSpace="pre-wrap">{confirmation?.message}</Text>}
      />
    </Box>
  )
}
