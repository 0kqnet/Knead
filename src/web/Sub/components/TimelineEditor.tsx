import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Dialog, Flex, Text } from '@yamada-ui/react'
import {
  TRACK_HEADER_WIDTH,
  TRACK_HEIGHT,
  TRACK_HEIGHT_COLLAPSED,
  snapTick,
  type Marker,
} from '../types/timeline'
import { useTimeline } from '../hooks/useTimeline'
import { useAudioBufferCache } from '../hooks/useAudioBufferCache'
import { useTimelinePlayback } from '../hooks/useTimelinePlayback'
import { DEFAULT_PX_PER_TICK, tickToPx } from '../utils/tickPixel'
import { parse, serialize } from '../utils/timelineIO'
import { TimelineToolbar } from './TimelineToolbar'
import { TimelineRuler } from './TimelineRuler'
import { SelectModifiers, TimelineTrack } from './TimelineTrack'
import { TimelinePlayhead } from './TimelinePlayhead'
import { TrackHeader } from './TrackHeader'
import { MixerPanel } from './MixerPanel'
import { ExportDialog } from './ExportDialog'
import { useAudioLibrary } from '../../../hooks/useAudioLibrary'
import { TimelinePropertyPanel } from './TimelinePropertyPanel'
import type { TimelineOpenResult } from '../../../../@types/global'
import { findKneadProjectPath } from '../utils/projectFiles'
import { useTranslation } from 'react-i18next'

interface Props {
  defaultSoundId?: string
  currentTargetVersion?: string
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

function omitMarkerId(marker: Marker): Omit<Marker, 'id'> {
  const { id, ...rest } = marker
  void id
  return rest
}

export const TimelineEditor: React.FC<Props> = ({ defaultSoundId, currentTargetVersion }) => {
  const { t } = useTranslation()
  const timeline = useTimeline()
  const { soundIdList, soundMap } = useAudioLibrary()
  const cache = useAudioBufferCache()
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [selectedTrackId, setSelectedTrackId] = useState(() => timeline.state.tracks[0].id)
  const [filePath, setFilePath] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [pxPerTick, setPxPerTick] = useState(DEFAULT_PX_PER_TICK)
  const [mixerOpen, setMixerOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [soundFocusRequest, setSoundFocusRequest] = useState(0)
  const [isProjectDragOver, setIsProjectDragOver] = useState(false)
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null)
  const clipboardRef = useRef<ClipboardItem[]>([])
  const selectionAnchorRef = useRef<string | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const moveOriginsRef = useRef<Map<string, MoveOrigin>>(new Map())
  const pendingDuplicateOriginsRef = useRef<Map<string, MoveOrigin> | null>(null)
  const confirmationResolverRef = useRef<((accepted: boolean) => void) | null>(null)
  const stateRef = useRef(timeline.state)
  const selectedIdsRef = useRef(selectedIds)
  stateRef.current = timeline.state
  selectedIdsRef.current = selectedIds

  const playback = useTimelinePlayback({
    markers: timeline.state.markers,
    tracks: timeline.state.tracks,
    lengthTicks: timeline.state.lengthTicks,
    settings: timeline.state.settings,
    master: timeline.state.master,
    randomSeed: timeline.state.randomSeed,
    cache,
  })

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
  }, [timeline.state])

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
    const key = ids.join('|')
    if (key === preloadKeyRef.current) return
    preloadKeyRef.current = key
    cache.preload(ids).catch(error => console.error('preload failed', error))
  }, [cache, timeline.state.markers])

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

  const addAtTick = useCallback((tick: number, trackId = selectedTrackId) => {
    const track = stateRef.current.tracks.find(item => item.id === trackId)
    if (!track || track.locked) return
    const id = timeline.addMarker({ tick, trackId, soundId: defaultSoundId ?? '' })
    setSelectedIds(new Set([id]))
    selectionAnchorRef.current = id
    setSelectedTrackId(trackId)
    setSoundFocusRequest(value => value + 1)
  }, [defaultSoundId, selectedTrackId, timeline])

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
    const minTick = Math.min(...selected.map(marker => marker.tick))
    clipboardRef.current = selected.map((marker) => {
      const { tick, ...data } = omitMarkerId(marker)
      return { tickOffset: tick - minTick, data }
    })
  }, [])

  const paste = useCallback(() => {
    if (clipboardRef.current.length === 0) return
    const baseTick = Math.round(playback.currentTick)
    const ids = timeline.addMarkers(clipboardRef.current.map(item => ({
      ...item.data,
      trackId: stateRef.current.tracks.some(track => track.id === item.data.trackId)
        ? item.data.trackId
        : selectedTrackId,
      tick: baseTick + item.tickOffset,
    })))
    setSelectedIds(new Set(ids))
    selectionAnchorRef.current = ids.at(-1) ?? null
  }, [playback.currentTick, selectedTrackId, timeline])

  const duplicateSelected = useCallback(() => {
    const source = stateRef.current.markers.filter(marker => selectedIdsRef.current.has(marker.id))
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
    const parsed = parse(result.json)
    if (!parsed.ok) {
      window.alert(`読込エラー: ${parsed.error}`)
      return
    }
    const pathResult = await window.myAPI.timeline.setCurrentPath(result.path)
    if (!pathResult.ok) {
      window.alert(`読込エラー: ${pathResult.error}`)
      return
    }
    playback.stop()
    skipDirtyRef.current = true
    timeline.replaceAll(parsed.state)
    setFilePath(pathResult.path)
    setDirty(false)
    setSelectedIds(new Set())
    setSelectedTrackId(parsed.state.tracks[0].id)
    const warnings = [...parsed.warnings]
    if (currentTargetVersion && parsed.state.targetVersion !== currentTargetVersion) {
      warnings.push(`Minecraftバージョンが異なります: ${parsed.state.targetVersion || '(未指定)'} / ${currentTargetVersion}`)
    }
    const missing = Array.from(new Set(parsed.state.markers.map(marker => marker.soundId).filter(id => id && !soundMap[id])))
    if (missing.length) warnings.push(`存在しないsoundId: ${missing.join(', ')}`)
    if (warnings.length) window.alert(`警告:\n${warnings.join('\n')}`)
  }, [currentTargetVersion, playback, soundMap, timeline])

  const openingRef = useRef(false)
  const openPath = useCallback(async (path: string) => {
    if (openingRef.current) return
    openingRef.current = true
    try {
      if (!(await confirmDiscard())) return
      await applyProjectResult(await window.myAPI.timeline.openPath(path))
    }
    catch (error) {
      window.alert(`読込エラー: ${String(error)}`)
    }
    finally {
      openingRef.current = false
    }
  }, [applyProjectResult, confirmDiscard])
  const openPathRef = useRef(openPath)
  openPathRef.current = openPath

  useEffect(() => {
    let disposed = false
    let unlistenOpen: (() => void) | undefined
    let unlistenDrop: (() => void) | undefined
    const consume = async () => {
      const path = await window.myAPI.timeline.takeOpenRequest()
      if (path && !disposed) await openPathRef.current(path)
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
        const path = findKneadProjectPath(event.paths)
        if (path) void openPathRef.current(path)
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
  }, [])

  const handleOpen = useCallback(async () => {
    if (openingRef.current) return
    openingRef.current = true
    try {
      if (!(await confirmDiscard())) return
      await applyProjectResult(await window.myAPI.timeline.openDialog())
    }
    catch (error) {
      window.alert(`読込エラー: ${String(error)}`)
    }
    finally {
      openingRef.current = false
    }
  }, [applyProjectResult, confirmDiscard])

  const saveAs = useCallback(async () => {
    const result = await window.myAPI.timeline.saveDialog(filePath ?? 'untitled.kp', serialize(stateRef.current))
    if (!result.ok) {
      if (!('canceled' in result)) window.alert(`保存エラー: ${result.error}`)
      return
    }
    setFilePath(result.path)
    setDirty(false)
  }, [filePath])

  const save = useCallback(async () => {
    if (!filePath) return saveAs()
    const result = await window.myAPI.timeline.save(serialize(stateRef.current))
    if (!result.ok) window.alert(`保存エラー: ${result.error}`)
    else setDirty(false)
  }, [filePath, saveAs])

  const newProject = useCallback(async () => {
    if (!(await confirmDiscard())) return
    playback.stop()
    skipDirtyRef.current = true
    const nextState = timeline.newProject()
    setFilePath(null)
    setDirty(false)
    setSelectedTrackId(nextState.tracks[0].id)
    clearSelection()
  }, [clearSelection, confirmDiscard, playback, timeline])

  const addTrack = useCallback(() => {
    const id = timeline.addTrack(selectedTrackId)
    setSelectedTrackId(id)
  }, [selectedTrackId, timeline])

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
    const availableWidth = Math.max(160, viewport.clientWidth - TRACK_HEADER_WIDTH - 32)
    const nextZoom = Math.max(1.5, Math.min(64, availableWidth / Math.max(1, endTick - startTick)))
    setPxPerTick(nextZoom)
    requestAnimationFrame(() => {
      viewport.scrollLeft = Math.max(0, TRACK_HEADER_WIDTH + tickToPx(startTick, nextZoom) - 16)
    })
  }, [])

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
      if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName) || target.isContentEditable) return
      const mod = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()
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
    clearSelection, copy, deleteSelected, duplicateSelected, handleOpen, newProject,
    paste, playback, save, saveAs, timeline,
  ])

  useEffect(() => {
    if (!playback.isPlaying || !scrollRef.current) return
    const x = TRACK_HEADER_WIDTH + tickToPx(playback.currentTick, pxPerTick)
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
  const singleSelected = selectedMarkers.length === 1 ? selectedMarkers[0] : null
  const commonSound = selectedMarkers.length > 0 && selectedMarkers.every(marker => marker.soundId === selectedMarkers[0].soundId)
    ? selectedMarkers[0].soundId
    : null
  const variants = commonSound ? (soundMap[commonSound] ?? []) : []
  const totalTrackHeight = timeline.state.tracks.reduce(
    (sum, track) => sum + (track.collapsed ? TRACK_HEIGHT_COLLAPSED : TRACK_HEIGHT),
    0,
  )
  const contentWidth = tickToPx(timeline.state.lengthTicks, pxPerTick)
  const exportName = (filePath?.replace(/^.*[\\/]/, '').replace(/\.kp$/i, '') || 'knead-mix')

  return (
    <Box display="flex" flexDir="column" h="100vh" bg="gray.950" position="relative">
      {isProjectDragOver && (
        <Box position="absolute" inset="0" zIndex="1500" pointerEvents="none" bg="rgba(0,0,0,.75)" display="flex" alignItems="center" justifyContent="center">
          <Text color="white" fontSize="xl" fontWeight="bold">.kpファイルをドロップして開く</Text>
        </Box>
      )}
      <TimelineToolbar
        onNew={newProject}
        onOpen={handleOpen}
        onSave={save}
        onSaveAs={saveAs}
        onExport={() => setExportOpen(true)}
        onAddMarker={() => addAtTick(snapTick(playback.currentTick, timeline.state.settings), selectedTrackId)}
        onAddTrack={addTrack}
        onDeleteSelected={deleteSelected}
        canDelete={selectedIds.size > 0}
        dirty={dirty}
        filePath={filePath}
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
      />

      <Box
        ref={scrollRef}
        flex="1"
        minH="150px"
        overflow="auto"
        onWheel={(event) => {
          if (!(event.ctrlKey || event.metaKey)) return
          event.preventDefault()
          setPxPerTick(value => Math.max(1.5, Math.min(64, value * (event.deltaY > 0 ? 0.88 : 1.12))))
        }}
      >
        <Box position="relative" w={`${TRACK_HEADER_WIDTH + contentWidth}px`} minW="100%">
          <Flex position="sticky" top="0" zIndex="20">
            <Flex
              position="sticky" left="0" zIndex="22"
              w={`${TRACK_HEADER_WIDTH}px`} minW={`${TRACK_HEADER_WIDTH}px`} h="32px"
              align="center" px="3" bg="gray.800" borderRight="1px solid" borderBottom="1px solid" borderColor="gray.600"
            >
              <Text fontSize="xs" fontWeight="bold">{t('studio.tracks').toUpperCase()}</Text>
            </Flex>
            <TimelineRuler
              lengthTicks={timeline.state.lengthTicks}
              pxPerTick={pxPerTick}
              settings={timeline.state.settings}
              onSeek={playback.seek}
              onLoopChange={(startTick, endTick) => timeline.setSettings({
                loop: { ...timeline.state.settings.loop, startTick, endTick },
              })}
            />
          </Flex>
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
                selectedIds={selectedIds}
                validSoundIds={validSoundIds}
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
                left={`${tickToPx(timeline.state.settings.loop.startTick, pxPerTick)}px`}
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
          master={timeline.state.master}
          trackMeters={playback.trackMeters}
          masterMeter={playback.masterMeter}
          onTrackChange={timeline.updateTrack}
          onMasterChange={timeline.setMaster}
        />
      )}

      <TimelinePropertyPanel
        marker={singleSelected}
        selectionCount={selectedMarkers.length}
        selectedMarkers={selectedMarkers}
        soundIdList={soundIdList}
        variants={variants}
        onChange={patch => timeline.updateMarkers(Array.from(selectedIds), patch)}
        onShiftTick={(delta) => {
          const selected = stateRef.current.markers.filter(marker => selectedIdsRef.current.has(marker.id))
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
      <Dialog
        open={confirmation !== null}
        header={confirmation?.title}
        cancel={t('studio.cancel')}
        success={{ children: confirmation?.confirmLabel, colorScheme: 'red' }}
        closeOnOverlay={false}
        onClose={() => settleConfirmation(false)}
        onCancel={() => settleConfirmation(false)}
        onSuccess={() => settleConfirmation(true)}
      >
        <Text whiteSpace="pre-wrap">{confirmation?.message}</Text>
      </Dialog>
    </Box>
  )
}
