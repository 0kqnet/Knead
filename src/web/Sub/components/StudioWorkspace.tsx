import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Button, Modal, Text } from '@yamada-ui/react'
import { useTranslation } from 'react-i18next'
import type { TimelineOpenResult } from '../../../../@types/global'
import { useStudioDocuments } from '../hooks/useStudioDocuments'
import { useActiveProjectAudio } from '../hooks/useActiveProjectAudio'
import { createDefaultTimelineState, type TimelineHistoryAction } from '../hooks/useTimeline'
import {
  isStudioDocumentDirty,
  type StudioDocument,
} from '../types/studioDocuments'
import type { EmbeddedCustomAudioAsset, TimelineState } from '../types/timeline'
import { prepareProjectCustomAudioRegistry } from '../utils/projectCustomAudio'
import { findKneadProjectPaths } from '../utils/projectFiles'
import {
  attachPlainNbsCustomAudio,
  getPlainNbsCustomAudioFileNames,
  parseStudioSongFile,
  serializeStudioSongFile,
} from '../utils/studioSongFile'
import { getTimelineRecoveryDisplayName } from '../utils/timelineRecovery'
import {
  clearRecentStudioSongs,
  loadRecentStudioSongs,
  rememberRecentStudioSong,
  removeRecentStudioSong,
  type RecentStudioSong,
} from '../utils/recentStudioSongs'
import {
  createStudioClipboardV1,
  prepareStudioClipboardPaste,
  type StudioClipboardV1,
} from '../utils/studioClipboard'
import {
  normalizeWorkspaceWarnings,
  type WorkspaceWarningList,
} from '../utils/workspaceWarnings'
import {
  DocumentRecoveryAgent,
  type DocumentRecoveryController,
  type DocumentRecoveryStatus,
} from './DocumentRecoveryAgent'
import { DocumentCloseDialog } from './DocumentCloseDialog'
import { RecoveryDialog } from './RecoveryDialog'
import { SongTabBar, type SongTabItem } from './SongTabBar'
import { TimelineEditor } from './TimelineEditor'

const EMPTY_CUSTOM_AUDIO: readonly EmbeddedCustomAudioAsset[] = []
type InstallStudioSongOutcome = 'opened' | 'remove-recent' | 'retain-recent'

export interface StudioWorkspaceProps {
  defaultSoundId?: string
  defaultTargetVersion?: string
  activateTargetVersion?: (version: string) => void | Promise<void>
}

function displayName(path: string): string {
  return path.replace(/^.*[\\/]/u, '') || 'Untitled'
}

function pathKey(path: string): string {
  return path.replace(/\\/gu, '/')
}

function createDocumentId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `song_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`
}

function isEditableTarget(target: EventTarget | null): boolean {
  const element = target instanceof HTMLElement ? target : null
  return Boolean(element?.closest('input, textarea, select, [contenteditable="true"]'))
}

export const StudioWorkspace: React.FC<StudioWorkspaceProps> = ({
  defaultSoundId,
  defaultTargetVersion = '',
  activateTargetVersion,
}) => {
  const { t } = useTranslation()
  const workspace = useStudioDocuments()
  const workspaceRef = useRef(workspace)
  workspaceRef.current = workspace
  const activeDocument = workspace.activeDocument
  const activeState = activeDocument.history.current
  const [blockingDialogOpen, setBlockingDialogOpen] = useState(false)
  const [isProjectDragOver, setIsProjectDragOver] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const [closingDocumentId, setClosingDocumentId] = useState<string | null>(null)
  const [pendingWindowClose, setPendingWindowClose] = useState<'hide' | 'exit' | null>(null)
  const [startupRecoveryOpen, setStartupRecoveryOpen] = useState(false)
  const [recentSongsOpen, setRecentSongsOpen] = useState(false)
  const [recentSongs, setRecentSongs] = useState<RecentStudioSong[]>(() => (
    loadRecentStudioSongs(window.localStorage)
  ))
  const [closeBusy, setCloseBusy] = useState(false)
  const [closeError, setCloseError] = useState<string | null>(null)
  const [workspaceWarnings, setWorkspaceWarnings] = useState<WorkspaceWarningList | null>(null)
  const [nbsLossWarnings, setNbsLossWarnings] = useState<readonly string[] | null>(null)
  const savingDocumentIdsRef = useRef(new Set<string>())
  const nbsLossResolverRef = useRef<((accepted: boolean) => void) | null>(null)
  const nbsLossActiveRef = useRef(false)
  const openQueueRef = useRef<Promise<void>>(Promise.resolve())
  const openGenerationRef = useRef(0)
  const workspaceInteractionBlocked = blockingDialogOpen
    || closingDocumentId !== null
    || pendingWindowClose !== null
    || startupRecoveryOpen
    || recentSongsOpen
    || workspaceWarnings !== null
    || nbsLossWarnings !== null
  const recoveryControllersRef = useRef(new Map<string, DocumentRecoveryController>())
  const clipboardRef = useRef<StudioClipboardV1 | null>(null)

  const rememberRecent = useCallback((path: string, kind: RecentStudioSong['kind']) => {
    setRecentSongs(current => rememberRecentStudioSong(
      window.localStorage,
      current,
      { path, kind },
    ))
  }, [])

  const forgetRecent = useCallback((path: string) => {
    setRecentSongs(current => removeRecentStudioSong(window.localStorage, current, path))
  }, [])

  const settleNbsLossConfirmation = useCallback((accepted: boolean) => {
    const resolve = nbsLossResolverRef.current
    nbsLossResolverRef.current = null
    nbsLossActiveRef.current = false
    setNbsLossWarnings(null)
    resolve?.(accepted)
  }, [])

  const requestNbsLossConfirmation = useCallback((warnings: readonly string[]) => {
    if (nbsLossResolverRef.current) return Promise.resolve(false)
    nbsLossActiveRef.current = true
    setNbsLossWarnings([...warnings])
    return new Promise<boolean>((resolve) => {
      nbsLossResolverRef.current = resolve
    })
  }, [])

  useEffect(() => () => {
    openGenerationRef.current += 1
    nbsLossResolverRef.current?.(false)
    nbsLossResolverRef.current = null
    nbsLossActiveRef.current = false
  }, [])

  useEffect(() => {
    let canceled = false
    void window.myAPI.timelineRecovery.list().then((result) => {
      if (!canceled && result.ok && result.snapshots.length > 0) setStartupRecoveryOpen(true)
    }).catch((error) => {
      console.error('Could not enumerate recovery snapshots', error)
    })
    return () => {
      canceled = true
    }
  }, [])

  const audioActivation = useActiveProjectAudio({
    projectId: activeDocument.id,
    assets: activeState.customAudio ?? EMPTY_CUSTOM_AUDIO,
  })
  const [targetActivation, setTargetActivation] = useState<{
    documentId: string
    version: string
    ready: boolean
    error: string | null
  }>({
    documentId: activeDocument.id,
    version: activeState.targetVersion || defaultTargetVersion,
    ready: !activateTargetVersion,
    error: null,
  })
  const targetGenerationRef = useRef(0)

  useEffect(() => {
    const generation = ++targetGenerationRef.current
    const documentId = activeDocument.id
    const version = activeState.targetVersion || defaultTargetVersion
    if (!activateTargetVersion || !version) {
      setTargetActivation({ documentId, version, ready: true, error: null })
      return
    }
    setTargetActivation({ documentId, version, ready: false, error: null })
    void Promise.resolve(activateTargetVersion(version)).then(() => {
      if (targetGenerationRef.current === generation) {
        setTargetActivation({ documentId, version, ready: true, error: null })
      }
    }).catch((error) => {
      if (targetGenerationRef.current === generation) {
        setTargetActivation({ documentId, version, ready: false, error: String(error) })
      }
    })
  }, [activateTargetVersion, activeDocument.id, activeState.targetVersion, defaultTargetVersion])

  const audioReady = audioActivation.canMountEditor
    && audioActivation.activeProjectId === activeDocument.id
  const activeTargetVersion = activeState.targetVersion || defaultTargetVersion
  const targetReady = targetActivation.documentId === activeDocument.id
    && targetActivation.version === activeTargetVersion
    && targetActivation.ready
  const editorReady = audioReady && targetReady
  const activationError = audioActivation.requestedProjectId === activeDocument.id
    ? audioActivation.error
    : targetActivation.documentId === activeDocument.id ? targetActivation.error : undefined

  const registerRecoveryController = useCallback((
    documentId: string,
    controller: DocumentRecoveryController | null,
    registrationToken: string,
  ) => {
    if (controller) {
      recoveryControllersRef.current.set(documentId, controller)
      return
    }
    if (recoveryControllersRef.current.get(documentId)?.registrationToken === registrationToken) {
      recoveryControllersRef.current.delete(documentId)
    }
  }, [])

  const updateRecoveryStatus = useCallback((documentId: string, status: DocumentRecoveryStatus) => {
    const document = workspaceRef.current.state.documents[documentId]
    if (!document
      || (
        document.recoverySaving === status.saving
        && document.recoveryError === status.error
      )) return
    workspaceRef.current.updateDocument(documentId, {
      recoverySaving: status.saving,
      recoveryError: status.error,
    })
  }, [])

  const findReusableUntitled = useCallback((): StudioDocument | undefined => {
    const current = workspaceRef.current.activeDocument
    return current.pristineUntitled && !isStudioDocumentDirty(current) ? current : undefined
  }, [])

  const showWarnings = useCallback((warnings: readonly string[]) => {
    if (warnings.length === 0) return
    setWorkspaceWarnings((current) => {
      const normalized = normalizeWorkspaceWarnings([
        ...(current?.items ?? []),
        ...warnings,
      ])
      const omitted = (current?.omitted ?? 0) + normalized.omitted
      return normalized.items.length > 0 || omitted > 0
        ? { items: normalized.items, omitted }
        : null
    })
  }, [])

  const installImportedState = useCallback((
    state: TimelineState,
    name: string,
    warnings: readonly string[],
  ): boolean => {
    const controller = workspaceRef.current
    const reusable = findReusableUntitled()
    if (reusable) {
      controller.dispatchTimeline(reusable.id, { type: 'replace', state })
      controller.setDocumentSavePoint(reusable.id, null, {
        filePath: null,
        displayName: name,
      })
      controller.updateDocument(reusable.id, { pristineUntitled: false })
    }
    else {
      const id = controller.openDocument(state, {
        saved: false,
        pristineUntitled: false,
        displayName: name,
      })
      if (!id) {
        window.alert(t('studio.song_tab_limit'))
        return false
      }
    }
    showWarnings(warnings)
    return true
  }, [findReusableUntitled, showWarnings, t])

  const installOpenedProject = useCallback(async (
    result: TimelineOpenResult,
    openGeneration: number,
  ): Promise<InstallStudioSongOutcome> => {
    const isCurrent = () => openGenerationRef.current === openGeneration
    if (!result.ok) {
      if (isCurrent() && !('canceled' in result)) window.alert(`${t('studio.open_error')}: ${result.error}`)
      return 'canceled' in result ? 'retain-recent' : 'remove-recent'
    }
    const parsedResult = parseStudioSongFile(result, defaultTargetVersion)
    if (!parsedResult.ok) {
      if (isCurrent()) window.alert(`${t('studio.open_error')}: ${parsedResult.error}`)
      return 'remove-recent'
    }
    const controller = workspaceRef.current
    const existing = controller.documents.find(document => (
      document.filePath && pathKey(document.filePath) === pathKey(result.path)
    ))
    if (existing) {
      if (!isCurrent()) return 'retain-recent'
      controller.activateDocument(existing.id)
      rememberRecent(result.path, parsedResult.document.fileKind)
      setAnnouncement(t('studio.song_tab_activated', { name: existing.displayName }))
      return 'opened'
    }

    const reusable = findReusableUntitled()
    if (!reusable && !controller.canAddDocument) {
      window.alert(t('studio.song_tab_limit'))
      return 'retain-recent'
    }
    const documentId = reusable?.id ?? createDocumentId()
    const reusableOwner = reusable
      ? controller.beginDocumentOperation(reusable.id, 'opening')
      : null
    if (reusable && !reusableOwner) return 'retain-recent'
    let ownsBinding = false
    let completedReusable = false
    try {
      const binding = await window.myAPI.timeline.bindCurrentPath(documentId, result.path)
      if (!binding.ok) {
        if (isCurrent()) window.alert(`${t('studio.open_error')}: ${binding.error}`)
        return 'retain-recent'
      }
      ownsBinding = true
      if (!isCurrent()) return 'retain-recent'

      let parsed = parsedResult.document
      if (parsed.fileKind === 'nbs' && parsed.plainNbsCustomAudio.length > 0) {
        const fileNames = getPlainNbsCustomAudioFileNames(parsed)
        let resolution: Awaited<ReturnType<typeof window.myAPI.timeline.resolveNbsCustomAudio>>
        try {
          resolution = fileNames.length > 0
            ? await window.myAPI.timeline.resolveNbsCustomAudio(documentId, fileNames)
            : { ok: true, assets: [], warnings: [] }
        }
        catch (error) {
          resolution = { ok: false, error: String(error) }
        }
        if (!isCurrent()) return 'retain-recent'
        try {
          parsed = await attachPlainNbsCustomAudio(parsed, resolution)
        }
        catch (error) {
          parsed = await attachPlainNbsCustomAudio(parsed, {
            ok: false,
            error: `Native custom-sound results were rejected: ${String(error)}`,
          })
        }
      }
      if (!isCurrent()) return 'retain-recent'

      try {
        await prepareProjectCustomAudioRegistry(parsed.state.customAudio ?? EMPTY_CUSTOM_AUDIO)
      }
      catch (error) {
        if (parsed.fileKind !== 'nbs') {
          if (isCurrent()) window.alert(`${t('studio.open_error')}: ${String(error)}`)
          return 'remove-recent'
        }
        parsed = await attachPlainNbsCustomAudio(parsedResult.document, {
          ok: false,
          error: `Resolved custom sounds failed verification: ${String(error)}`,
        })
        await prepareProjectCustomAudioRegistry(EMPTY_CUSTOM_AUDIO)
      }
      if (!isCurrent()) return 'retain-recent'

      const latestController = workspaceRef.current
      if (reusableOwner) {
        const reserved = latestController.state.documents[reusableOwner.documentId]
        if (!reserved
          // A fully synchronous native mock can finish before React publishes
          // the queued beginOperation action. `null` is therefore accepted
          // only while the exact pristine state snapshot is still unchanged.
          || (reserved.operationToken !== null && reserved.operationToken !== reusableOwner.token)
          || reserved.history.current !== reusableOwner.stateSnapshot
          || !reserved.pristineUntitled
          || isStudioDocumentDirty(reserved)) {
          return 'retain-recent'
        }
      }
      else if (!latestController.canAddDocument) {
        window.alert(t('studio.song_tab_limit'))
        return 'retain-recent'
      }

      const duplicateProjectId = latestController.documents.some(document => (
        document.id !== reusable?.id
        && document.history.current.projectId === parsed.state.projectId
      ))
      const warnings = [...parsed.warnings]
      let state = parsed.state
      let diskSavePoint: TimelineState | null = state
      if (duplicateProjectId) {
        diskSavePoint = state
        state = { ...state, projectId: createDocumentId() }
        warnings.push(t('studio.song_tab_duplicate_project_id'))
      }

      if (reusable) {
        latestController.dispatchTimeline(reusable.id, { type: 'replace', state })
        latestController.setDocumentSavePoint(reusable.id, duplicateProjectId ? diskSavePoint : state, {
          filePath: binding.path,
          displayName: displayName(binding.path),
        })
        latestController.updateDocument(reusable.id, {
          pristineUntitled: false,
          fileKind: parsed.fileKind,
          nbsTargetVersion: parsed.nbsTargetVersion,
        })
        latestController.completeDocumentOperation(reusableOwner!, { status: 'ready' })
        completedReusable = true
      }
      else {
        const id = latestController.openDocument(
          duplicateProjectId ? diskSavePoint! : state,
          {
            id: documentId,
            saved: true,
            filePath: binding.path,
            fileKind: parsed.fileKind,
            nbsTargetVersion: parsed.nbsTargetVersion,
            displayName: displayName(binding.path),
            pristineUntitled: false,
          },
        )
        if (!id) {
          window.alert(t('studio.song_tab_limit'))
          return 'retain-recent'
        }
        if (duplicateProjectId) latestController.dispatchTimeline(id, { type: 'replace', state })
      }
      ownsBinding = false
      showWarnings(warnings)
      rememberRecent(binding.path, parsed.fileKind)
      setAnnouncement(t('studio.song_tab_opened', { name: displayName(binding.path) }))
      return 'opened'
    }
    finally {
      try {
        if (ownsBinding) await window.myAPI.timeline.releaseCurrentPath(documentId)
      }
      finally {
        if (reusableOwner && !completedReusable) {
          workspaceRef.current.completeDocumentOperation(reusableOwner, { status: 'ready' })
        }
      }
    }
  }, [defaultTargetVersion, findReusableUntitled, rememberRecent, showWarnings, t])

  const openPath = useCallback(async (path: string) => {
    const operation = openQueueRef.current.then(async () => {
      const openGeneration = ++openGenerationRef.current
      try {
        return await installOpenedProject(await window.myAPI.timeline.openPath(path), openGeneration)
      }
      catch (error) {
        if (openGenerationRef.current === openGeneration) {
          window.alert(`${t('studio.open_error')}: ${String(error)}`)
        }
        return 'retain-recent' as const
      }
    })
    openQueueRef.current = operation.then(() => undefined, () => undefined)
    return operation
  }, [installOpenedProject, t])

  const openRecentSong = useCallback(async (entry: RecentStudioSong) => {
    setRecentSongsOpen(false)
    if (await openPath(entry.path) === 'remove-recent') forgetRecent(entry.path)
  }, [forgetRecent, openPath])

  const openDialog = useCallback(async () => {
    const controller = workspaceRef.current
    if (!findReusableUntitled() && !controller.canAddDocument) {
      window.alert(t('studio.song_tab_limit'))
      return
    }
    const operation = openQueueRef.current.then(async () => {
      const openGeneration = ++openGenerationRef.current
      try {
        return await installOpenedProject(await window.myAPI.timeline.openDialog(), openGeneration)
      }
      catch (error) {
        if (openGenerationRef.current === openGeneration) {
          window.alert(`${t('studio.open_error')}: ${String(error)}`)
        }
        return 'retain-recent' as const
      }
    })
    openQueueRef.current = operation.then(() => undefined, () => undefined)
    await operation
  }, [findReusableUntitled, installOpenedProject, t])

  useEffect(() => {
    let disposed = false
    let unlistenOpen: (() => void) | undefined
    let unlistenDrop: (() => void) | undefined
    const consumeOpenRequests = async () => {
      const paths = await window.myAPI.timeline.takeOpenRequests()
      for (const path of paths) {
        if (disposed) return
        await openPath(path)
      }
    }
    void window.myAPI.timeline.onOpenRequested(() => void consumeOpenRequests()).then((unlisten) => {
      if (disposed) unlisten()
      else {
        unlistenOpen = unlisten
        void consumeOpenRequests()
      }
    })
    void window.myAPI.timeline.onDragDrop((event) => {
      if (event.type === 'enter') setIsProjectDragOver(findKneadProjectPaths(event.paths).length > 0)
      else if (event.type === 'leave') setIsProjectDragOver(false)
      else if (event.type === 'drop') {
        setIsProjectDragOver(false)
        const paths = findKneadProjectPaths(event.paths)
        void (async () => {
          for (const path of paths) await openPath(path)
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
  }, [openPath])

  const saveDocument = useCallback(async (
    documentId: string,
    saveAs = false,
  ): Promise<boolean> => {
    const controller = workspaceRef.current
    const document = controller.state.documents[documentId]
    if (
      !document
      || document.status === 'saving'
      || savingDocumentIdsRef.current.has(documentId)
    ) return false
    savingDocumentIdsRef.current.add(documentId)
    const owner = controller.beginDocumentOperation(documentId, 'saving')
    if (!owner) {
      savingDocumentIdsRef.current.delete(documentId)
      return false
    }
    setCloseError(null)
    try {
      const serialized = serializeStudioSongFile(
        owner.stateSnapshot,
        document.fileKind,
        document.displayName,
        document.nbsTargetVersion ?? undefined,
      )
      if (serialized.lossWarnings.length > 0) {
        const confirmed = await requestNbsLossConfirmation(serialized.lossWarnings)
        if (!confirmed) {
          controller.completeDocumentOperation(owner, { status: 'ready' })
          return false
        }
      }
      const extension = document.fileKind
      const expectedSuffix = new RegExp(`\\.${extension}$`, 'iu')
      const defaultSaveName = expectedSuffix.test(document.displayName)
        ? document.displayName
        : `${document.displayName || 'untitled'}.${extension}`
      const result = document.filePath && !saveAs
        ? await window.myAPI.timeline.save(documentId, serialized.payload)
        : await window.myAPI.timeline.saveDialog(documentId, defaultSaveName, serialized.payload)
      if (!result.ok) {
        if (!('canceled' in result)) setCloseError(result.error)
        controller.completeDocumentOperation(owner, { status: 'ready' })
        return false
      }
      controller.setDocumentSavePoint(documentId, owner.stateSnapshot, {
        filePath: result.path,
        displayName: displayName(result.path),
      })
      controller.completeDocumentOperation(owner, { status: 'ready' })
      rememberRecent(result.path, document.fileKind)
      const current = workspaceRef.current.state.documents[documentId]?.history.current
      await recoveryControllersRef.current.get(documentId)?.reconcileAfterSave(
        owner.stateSnapshot,
        current,
      )
      if (serialized.warnings.length > 0 && serialized.lossWarnings.length === 0) {
        showWarnings(serialized.warnings)
      }
      return current === owner.stateSnapshot
    }
    catch (error) {
      controller.completeDocumentOperation(owner, { status: 'error', error: String(error) })
      setCloseError(String(error))
      return false
    }
    finally {
      savingDocumentIdsRef.current.delete(documentId)
    }
  }, [rememberRecent, requestNbsLossConfirmation, showWarnings])

  const closeDocumentNow = useCallback(async (documentId: string) => {
    await recoveryControllersRef.current.get(documentId)?.clear()
    await window.myAPI.timeline.releaseCurrentPath(documentId)
    const name = workspaceRef.current.state.documents[documentId]?.displayName ?? ''
    workspaceRef.current.closeDocument(documentId)
    setClosingDocumentId(null)
    setAnnouncement(t('studio.song_tab_closed', { name }))
  }, [t])

  const requestCloseDocument = useCallback((documentId: string) => {
    if (workspaceInteractionBlocked) return
    const document = workspaceRef.current.state.documents[documentId]
    if (!document) return
    if (isStudioDocumentDirty(document)) {
      setCloseError(null)
      setClosingDocumentId(documentId)
    }
    else void closeDocumentNow(documentId)
  }, [closeDocumentNow, workspaceInteractionBlocked])

  const createNewDocument = useCallback(() => {
    if (workspaceInteractionBlocked) return
    const id = workspaceRef.current.newDocument(defaultTargetVersion)
    if (!id) window.alert(t('studio.song_tab_limit'))
    else setAnnouncement(t('studio.song_tab_created'))
  }, [defaultTargetVersion, t, workspaceInteractionBlocked])

  const importDocument = useCallback((
    state: TimelineState,
    warnings: readonly string[],
    sourcePath: string,
  ): boolean => installImportedState(state, displayName(sourcePath), warnings), [installImportedState])

  const copyMarkers = useCallback((markerIds: readonly string[]): boolean => {
    try {
      clipboardRef.current = createStudioClipboardV1(
        workspaceRef.current.activeDocument.history.current,
        markerIds,
      )
      setAnnouncement(t('studio.song_tab_copied', { count: markerIds.length }))
      return true
    }
    catch (error) {
      window.alert(String(error))
      return false
    }
  }, [t])

  const pasteMarkers = useCallback((
    atTick: number,
    destinationTrackId: string,
  ): readonly string[] => {
    const clipboard = clipboardRef.current
    if (!clipboard) return []
    const controller = workspaceRef.current
    const document = controller.activeDocument
    const selectedTrackIndex = document.history.current.tracks.findIndex(
      track => track.id === destinationTrackId,
    )
    const destinationTrackIndex = selectedTrackIndex >= 0
      && !document.history.current.tracks[selectedTrackIndex].locked
      ? selectedTrackIndex
      : document.history.current.tracks.findIndex(track => !track.locked)
    if (destinationTrackIndex < 0) return []
    try {
      const prepared = prepareStudioClipboardPaste(clipboard, document.history.current, {
        atTick,
        destinationTrackIndex,
      })
      const lockedTrackIds = new Set(
        document.history.current.tracks.filter(track => track.locked).map(track => track.id),
      )
      if (prepared.markers.some(marker => lockedTrackIds.has(marker.trackId))) {
        throw new Error(t('studio.song_tab_paste_locked'))
      }
      const ids = controller.pasteIntoDocument(document.id, {
        markers: prepared.markers.map(marker => structuredClone(marker)),
        assets: prepared.assets.map(asset => structuredClone(asset)),
        instruments: prepared.instruments.map(instrument => structuredClone(instrument)),
      })
      showWarnings(prepared.warnings)
      setAnnouncement(t('studio.song_tab_pasted', { count: ids.length }))
      return ids
    }
    catch (error) {
      window.alert(String(error))
      return []
    }
  }, [showWarnings, t])

  const activateDocument = useCallback((documentId: string) => {
    if (workspaceInteractionBlocked || documentId === workspaceRef.current.activeDocument.id) return
    workspaceRef.current.activateDocument(documentId)
    const name = workspaceRef.current.state.documents[documentId]?.displayName ?? ''
    setAnnouncement(t('studio.song_tab_activated', { name }))
  }, [t, workspaceInteractionBlocked])

  const dirtyDocuments = workspace.documents.filter(isStudioDocumentDirty)
  const handleNativeClose = useCallback((mode: 'hide' | 'exit') => {
    if (nbsLossActiveRef.current) settleNbsLossConfirmation(false)
    if (recentSongsOpen) setRecentSongsOpen(false)
    if (workspaceWarnings) setWorkspaceWarnings(null)
    if (workspaceRef.current.dirtyDocumentIds.length === 0) {
      void window.myAPI.timeline.confirmClose(mode)
      return
    }
    setCloseError(null)
    // A native window-close request supersedes a per-tab prompt. Keeping both
    // mounted would create two modal dialogs for the same unsaved document.
    setClosingDocumentId(null)
    setPendingWindowClose(mode)
  }, [recentSongsOpen, settleNbsLossConfirmation, workspaceWarnings])
  const nativeCloseRef = useRef(handleNativeClose)
  nativeCloseRef.current = handleNativeClose
  useEffect(() => {
    let unlisten: (() => void) | undefined
    let disposed = false
    void window.myAPI.timeline.onCloseRequested(request => nativeCloseRef.current(request.mode))
      .then((next) => {
        if (disposed) next()
        else unlisten = next
      })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (workspaceInteractionBlocked || isEditableTarget(event.target)) return
      if (!(event.ctrlKey || event.metaKey)) return
      if (event.key === 'Tab') {
        event.preventDefault()
        const documents = workspaceRef.current.documents
        const index = documents.findIndex(document => document.id === workspaceRef.current.activeDocument.id)
        const delta = event.shiftKey ? -1 : 1
        const next = documents[(index + delta + documents.length) % documents.length]
        if (next) activateDocument(next.id)
      }
      else if (event.key.toLowerCase() === 'w') {
        event.preventDefault()
        requestCloseDocument(workspaceRef.current.activeDocument.id)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [activateDocument, requestCloseDocument, workspaceInteractionBlocked])

  const tabs = useMemo<SongTabItem[]>(() => workspace.documents.map((document) => {
    let status: SongTabItem['status'] = document.status === 'error' || document.recoveryError
      ? 'error'
      : document.status === 'saving' || document.recoverySaving
        ? 'saving'
        : 'ready'
    if (document.id === activeDocument.id && !editorReady) {
      status = activationError ? 'error' : 'audio-switching'
    }
    return {
      id: document.id,
      label: document.displayName,
      dirty: isStudioDocumentDirty(document),
      status,
    }
  }), [activationError, activeDocument.id, editorReady, workspace.documents])

  const closingDocument = closingDocumentId
    ? workspace.state.documents[closingDocumentId]
    : undefined

  const saveAllAndCloseWindow = async () => {
    if (!pendingWindowClose || closeBusy) return
    setCloseBusy(true)
    setCloseError(null)
    try {
      for (const document of workspaceRef.current.documents.filter(isStudioDocumentDirty)) {
        if (!(await saveDocument(document.id))) return
      }
      await window.myAPI.timeline.confirmClose(pendingWindowClose)
      setPendingWindowClose(null)
    }
    finally {
      setCloseBusy(false)
    }
  }

  const discardAllAndCloseWindow = async () => {
    if (!pendingWindowClose || closeBusy) return
    setCloseBusy(true)
    try {
      for (const document of workspaceRef.current.documents.filter(isStudioDocumentDirty)) {
        await recoveryControllersRef.current.get(document.id)?.clear()
        if (!document.savePoint && document.filePath) {
          await window.myAPI.timeline.releaseCurrentPath(document.id)
        }
        const next = document.savePoint ?? createDefaultTimelineState(defaultTargetVersion)
        const action: TimelineHistoryAction = { type: 'replace', state: next }
        workspaceRef.current.dispatchTimeline(document.id, action)
        workspaceRef.current.setDocumentSavePoint(document.id, next, document.savePoint
          ? {}
          : { filePath: null, displayName: 'Untitled' })
      }
      await window.myAPI.timeline.confirmClose(pendingWindowClose)
      setPendingWindowClose(null)
    }
    finally {
      setCloseBusy(false)
    }
  }

  return (
    <Box className="studio-shell" display="flex" flexDir="column" h="100vh" position="relative">
      {isProjectDragOver && (
        <Box
          position="absolute" inset="0" zIndex="2200" pointerEvents="none"
          bg="rgba(0,0,0,.78)" display="flex" alignItems="center" justifyContent="center"
        >
          <Text color="white" fontSize="xl" fontWeight="bold">{t('studio.song_tab_drop')}</Text>
        </Box>
      )}
      <SongTabBar
        tabs={tabs}
        activeId={activeDocument.id}
        disabled={workspaceInteractionBlocked}
        announcement={announcement}
        onActivate={activateDocument}
        onClose={requestCloseDocument}
        onNew={createNewDocument}
        onOpenRecent={() => setRecentSongsOpen(true)}
      />
      {workspace.documents.map(document => (
        <DocumentRecoveryAgent
          key={document.id}
          document={document}
          onController={registerRecoveryController}
          onStatus={updateRecoveryStatus}
        />
      ))}
      <Box
        id={`song-panel-${activeDocument.id}`}
        role="tabpanel"
        aria-labelledby={`song-tab-${activeDocument.id}`}
        flex="1"
        minH="0"
      >
        {editorReady
          ? (
              <TimelineEditor
                key={activeDocument.id}
                timelineController={workspace.activeTimeline}
                documentId={activeDocument.id}
                documentFilePath={activeDocument.filePath}
                documentDirty={isStudioDocumentDirty(activeDocument)}
                defaultSoundId={defaultSoundId}
                currentTargetVersion={activeState.targetVersion || defaultTargetVersion}
                projectAudioManagedExternally
                recoveryEnabled={false}
                autoOpenRecoveryDialog={false}
                embeddedWorkspace
                onSaveDocument={async () => { await saveDocument(activeDocument.id) }}
                onSaveDocumentAs={async () => { await saveDocument(activeDocument.id, true) }}
                onNewDocument={createNewDocument}
                onOpenDocument={openDialog}
                onOpenDocumentPath={async (path) => { await openPath(path) }}
                onImportDocument={importDocument}
                onBlockingDialogChange={setBlockingDialogOpen}
                onCopyMarkers={copyMarkers}
                onPasteMarkers={pasteMarkers}
                initialSelection={activeDocument.selection}
                initialView={activeDocument.view}
                onSessionChange={(selection, view) => {
                  workspaceRef.current.updateDocument(activeDocument.id, { selection, view })
                }}
              />
            )
          : (
              <Box h="100%" display="flex" flexDir="column" alignItems="center" justifyContent="center" gap="3">
                <Text>{activationError ?? t('studio.song_tab_switching_audio')}</Text>
                {activationError && (
                  <Button size="sm" onClick={() => window.location.reload()}>{t('studio.retry')}</Button>
                )}
              </Box>
            )}
      </Box>
      <RecoveryDialog
        open={startupRecoveryOpen}
        onClose={() => setStartupRecoveryOpen(false)}
        onRestore={(state, snapshot, warnings) => installImportedState(
          state,
          getTimelineRecoveryDisplayName(snapshot),
          warnings,
        )}
      />
      <Modal.Root
        withCloseButton={false}
        open={recentSongsOpen}
        aria-label={t('studio.recent_songs_title')}
        title={t('studio.recent_songs_title')}
        cancel={t('studio.close')}
        success={{
          children: t('studio.recent_songs_clear'),
          colorScheme: 'red',
          disabled: recentSongs.length === 0,
        }}
        onClose={() => setRecentSongsOpen(false)}
        onCancel={() => setRecentSongsOpen(false)}
        onSuccess={() => setRecentSongs(clearRecentStudioSongs(window.localStorage))}
        body={recentSongs.length === 0
          ? <Text color="gray.400">{t('studio.recent_songs_empty')}</Text>
          : (
              <Box maxH="50vh" overflowY="auto">
                {recentSongs.map(entry => (
                  <Button
                    key={`${entry.kind}:${entry.path}`}
                    w="full"
                    h="auto"
                    minH="36px"
                    mb="2"
                    px="3"
                    py="2"
                    justifyContent="flex-start"
                    textAlign="left"
                    whiteSpace="normal"
                    aria-label={t('studio.recent_songs_open_path', { path: entry.path })}
                    onClick={() => { void openRecentSong(entry) }}
                  >
                    <Text as="span" fontFamily="mono" fontSize="xs" overflowWrap="anywhere">
                      {entry.path}
                    </Text>
                  </Button>
                ))}
              </Box>
            )}
      />
      <Modal.Root
        withCloseButton={false}
        open={workspaceWarnings !== null}
        aria-label={t('studio.open_warnings')}
        title={t('studio.open_warnings')}
        cancel={t('studio.close')}
        onClose={() => setWorkspaceWarnings(null)}
        onCancel={() => setWorkspaceWarnings(null)}
        body={(
          <Box maxH="50vh" overflowY="auto">
            {workspaceWarnings?.items.map(warning => (
              <Text key={warning} mt="1" fontSize="sm">
                •
                {' '}
                {warning}
              </Text>
            ))}
            {workspaceWarnings && workspaceWarnings.omitted > 0 && (
              <Text mt="3" color="gray.400" fontSize="sm">
                {t('studio.open_warnings_more', { count: workspaceWarnings.omitted })}
              </Text>
            )}
          </Box>
        )}
      />
      <Modal.Root
        withCloseButton={false}
        open={nbsLossWarnings !== null}
        aria-label={t('studio.nbs_plain_save_loss_title')}
        title={t('studio.nbs_plain_save_loss_title')}
        cancel={t('studio.cancel')}
        success={{ children: t('studio.save'), colorScheme: 'orange' }}
        closeOnOverlay={false}
        onClose={() => settleNbsLossConfirmation(false)}
        onCancel={() => settleNbsLossConfirmation(false)}
        onSuccess={() => settleNbsLossConfirmation(true)}
        body={(
          <>
            <Text whiteSpace="pre-wrap">{t('studio.nbs_plain_save_loss_confirm')}</Text>
            <Box mt="3" maxH="40vh" overflowY="auto">
              {nbsLossWarnings?.map(warning => (
                <Text key={warning} mt="1" fontSize="sm">
                  •
                  {' '}
                  {warning}
                </Text>
              ))}
            </Box>
          </>
        )}
      />
      <DocumentCloseDialog
        open={Boolean(closingDocument) && nbsLossWarnings === null && workspaceWarnings === null}
        name={closingDocument?.displayName ?? ''}
        busy={closeBusy}
        error={closeError}
        onCancel={() => setClosingDocumentId(null)}
        onDiscard={() => {
          if (closingDocument) void closeDocumentNow(closingDocument.id)
        }}
        onSave={() => {
          if (!closingDocument || closeBusy) return
          setCloseBusy(true)
          void saveDocument(closingDocument.id).then((savedAndUnchanged) => {
            if (savedAndUnchanged) return closeDocumentNow(closingDocument.id)
            return undefined
          }).finally(() => setCloseBusy(false))
        }}
      />
      <DocumentCloseDialog
        open={pendingWindowClose !== null && nbsLossWarnings === null && workspaceWarnings === null}
        name={t('studio.song_tab_dirty_count', { count: dirtyDocuments.length })}
        busy={closeBusy}
        error={closeError}
        onCancel={() => setPendingWindowClose(null)}
        onDiscard={() => { void discardAllAndCloseWindow() }}
        onSave={() => { void saveAllAndCloseWindow() }}
      />
    </Box>
  )
}
