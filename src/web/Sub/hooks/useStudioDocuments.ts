import { useCallback, useMemo, useReducer, useRef } from 'react'
import { v4 as uuidv4 } from 'uuid'
import type { TimelineState } from '../types/timeline'
import type { StudioSongFileKind } from '../../../../@types/global'
import type { NbsTargetVersion } from '../utils/nbs'
import {
  MAX_STUDIO_DOCUMENTS,
  MAX_WORKSPACE_HISTORY_REVISIONS,
  isStudioDocumentDirty,
  type StudioDocument,
  type StudioDocumentOperationOwner,
  type StudioDocumentsState,
  type StudioDocumentStatus,
} from '../types/studioDocuments'
import { DEFAULT_PX_PER_TICK } from '../utils/tickPixel'
import {
  createDefaultTimelineState,
  createTimelineHistory,
  createTimelinePasteAction,
  timelineHistoryReducer,
  useTimelineController,
  type TimelineHistoryAction,
  type TimelinePasteInput,
} from './useTimeline'

export interface CreateStudioDocumentOptions {
  id?: string
  state?: TimelineState
  targetVersion?: string
  filePath?: string | null
  fileKind?: StudioSongFileKind
  nbsTargetVersion?: NbsTargetVersion | null
  displayName?: string
  /** Opened .kp files and pristine new songs start at a save point. */
  saved?: boolean
  pristineUntitled?: boolean
  status?: StudioDocumentStatus
  lastTouchedAt?: number
}

export type StudioDocumentUpdate = Partial<Pick<
  StudioDocument,
  | 'filePath'
  | 'fileKind'
  | 'nbsTargetVersion'
  | 'displayName'
  | 'pristineUntitled'
  | 'followsMainVersion'
  | 'selection'
  | 'view'
  | 'status'
  | 'error'
  | 'recoverySaving'
  | 'recoveryError'
>>

export type StudioDocumentsAction =
  | { type: 'add', document: StudioDocument, activate: boolean }
  | { type: 'mainVersion', version: string }
  | { type: 'activate', documentId: string }
  | { type: 'timeline', documentId: string, action: TimelineHistoryAction }
  | { type: 'update', documentId: string, patch: StudioDocumentUpdate }
  | {
    type: 'savePoint'
    documentId: string
    savePoint: TimelineState | null
    filePath?: string | null
    displayName?: string
  }
  | {
    type: 'beginOperation'
    documentId: string
    token: string
    status: StudioDocumentStatus
  }
  | {
    type: 'completeOperation'
    owner: StudioDocumentOperationOwner
    patch: StudioDocumentUpdate
  }
  | { type: 'close', documentId: string, replacement?: StudioDocument }

function pathName(path: string | null | undefined): string | undefined {
  const trimmed = path?.trim()
  if (!trimmed) return undefined
  return trimmed.split(/[\\/]/u).at(-1) || undefined
}

export function createStudioDocument(options: CreateStudioDocumentOptions = {}): StudioDocument {
  const state = options.state ?? createDefaultTimelineState(options.targetVersion)
  const history = createTimelineHistory(state)
  const saved = options.saved ?? true
  const filePath = options.filePath ?? null
  return {
    id: options.id ?? uuidv4(),
    history,
    savePoint: saved ? history.current : null,
    filePath,
    fileKind: options.fileKind ?? 'kp',
    nbsTargetVersion: options.nbsTargetVersion ?? null,
    displayName: options.displayName ?? pathName(filePath) ?? 'Untitled',
    pristineUntitled: options.pristineUntitled
      ?? (options.state === undefined && filePath === null && saved),
    followsMainVersion: options.state === undefined && filePath === null,
    selection: {
      markerIds: [],
      anchorMarkerId: null,
      trackId: state.tracks[0]?.id ?? '',
    },
    view: {
      pxPerTick: DEFAULT_PX_PER_TICK,
      scrollLeft: 0,
      scrollTop: 0,
      transportTick: 0,
    },
    status: options.status ?? 'ready',
    error: null,
    recoverySaving: false,
    recoveryError: null,
    operationToken: null,
    lastTouchedAt: options.lastTouchedAt ?? 0,
  }
}

export function createStudioDocumentsState(
  options: CreateStudioDocumentOptions = {},
): StudioDocumentsState {
  const document = createStudioDocument({ ...options, lastTouchedAt: 1 })
  return {
    order: [document.id],
    activeDocumentId: document.id,
    documents: { [document.id]: document },
    clock: 1,
  }
}

function historyRevisionCount(document: StudioDocument): number {
  return document.history.past.length
    + 1
    + document.history.future.length
    + (document.history.txSnapshot === null ? 0 : 1)
}

export function countWorkspaceHistoryRevisions(state: StudioDocumentsState): number {
  return state.order.reduce((total, id) => {
    const document = state.documents[id]
    return total + (document ? historyRevisionCount(document) : 0)
  }, 0)
}

/**
 * Keep current states and open transactions. Old inactive undo/redo entries
 * are released first; the active document is only considered as a last resort.
 */
export function enforceWorkspaceHistoryBudget(state: StudioDocumentsState): StudioDocumentsState {
  let overflow = countWorkspaceHistoryRevisions(state) - MAX_WORKSPACE_HISTORY_REVISIONS
  if (overflow <= 0) return state
  let documents = state.documents
  const candidates = [...state.order].sort((left, right) => {
    const leftActive = left === state.activeDocumentId ? 1 : 0
    const rightActive = right === state.activeDocumentId ? 1 : 0
    return leftActive - rightActive
      || (state.documents[left]?.lastTouchedAt ?? 0) - (state.documents[right]?.lastTouchedAt ?? 0)
  })

  for (const id of candidates) {
    if (overflow <= 0) break
    const document = documents[id]
    if (!document) continue
    let past = document.history.past
    let future = document.history.future
    const removePast = Math.min(overflow, past.length)
    if (removePast > 0) {
      past = past.slice(removePast)
      overflow -= removePast
    }
    const removeFuture = Math.min(overflow, future.length)
    if (removeFuture > 0) {
      // future[0] is the next redo; discard the farthest redo entries first.
      future = future.slice(0, future.length - removeFuture)
      overflow -= removeFuture
    }
    if (past !== document.history.past || future !== document.history.future) {
      if (documents === state.documents) documents = { ...documents }
      documents[id] = {
        ...document,
        history: { ...document.history, past, future },
      }
    }
  }

  return documents === state.documents ? state : { ...state, documents }
}

function sanitizeDocumentSelection(document: StudioDocument): StudioDocument {
  const markerIds = new Set(document.history.current.markers.map(marker => marker.id))
  const selected = document.selection.markerIds.filter(id => markerIds.has(id))
  const trackId = document.history.current.tracks.some(track => track.id === document.selection.trackId)
    ? document.selection.trackId
    : document.history.current.tracks[0]?.id ?? ''
  const anchorMarkerId = document.selection.anchorMarkerId
    && markerIds.has(document.selection.anchorMarkerId)
    ? document.selection.anchorMarkerId
    : null
  if (
    selected.length === document.selection.markerIds.length
    && selected.every((id, index) => id === document.selection.markerIds[index])
    && trackId === document.selection.trackId
    && anchorMarkerId === document.selection.anchorMarkerId
  ) return document
  return {
    ...document,
    selection: { markerIds: selected, anchorMarkerId, trackId },
  }
}

export function studioDocumentsReducer(
  state: StudioDocumentsState,
  action: StudioDocumentsAction,
): StudioDocumentsState {
  switch (action.type) {
    case 'mainVersion': {
      // Retargeting a new song is a preference change. Preserve undo and the
      // shared identity between its save point and its history revisions.
      const revisions = new Map<TimelineState, TimelineState>()
      const retarget = (revision: TimelineState) => {
        if (revision.targetVersion === action.version) return revision
        const next = revisions.get(revision) ?? { ...revision, targetVersion: action.version }
        revisions.set(revision, next)
        return next
      }
      let documents = state.documents
      for (const document of Object.values(documents)) {
        const { history, savePoint } = document
        if (!document.followsMainVersion || history.current.targetVersion === action.version) continue
        if (documents === state.documents) documents = { ...documents }
        documents[document.id] = {
          ...document,
          history: {
            current: retarget(history.current),
            past: history.past.map(retarget),
            future: history.future.map(retarget),
            txSnapshot: history.txSnapshot && retarget(history.txSnapshot),
          },
          savePoint: savePoint && retarget(savePoint),
        }
      }
      return documents === state.documents ? state : { ...state, documents }
    }
    case 'add': {
      if (
        state.documents[action.document.id]
        || state.order.length >= MAX_STUDIO_DOCUMENTS
      ) return state
      const clock = state.clock + 1
      const document = { ...action.document, lastTouchedAt: clock }
      return enforceWorkspaceHistoryBudget({
        order: [...state.order, document.id],
        activeDocumentId: action.activate ? document.id : state.activeDocumentId,
        documents: { ...state.documents, [document.id]: document },
        clock,
      })
    }
    case 'activate':
      return state.documents[action.documentId] && state.activeDocumentId !== action.documentId
        ? { ...state, activeDocumentId: action.documentId }
        : state
    case 'timeline': {
      const document = state.documents[action.documentId]
      if (!document) return state
      const history = timelineHistoryReducer(document.history, action.action)
      if (history === document.history) return state
      const clock = state.clock + 1
      const nextDocument = sanitizeDocumentSelection({
        ...document,
        history,
        pristineUntitled: history.current === document.history.current
          ? document.pristineUntitled
          : false,
        lastTouchedAt: clock,
      })
      return enforceWorkspaceHistoryBudget({
        ...state,
        clock,
        documents: { ...state.documents, [document.id]: nextDocument },
      })
    }
    case 'update': {
      const document = state.documents[action.documentId]
      if (!document) return state
      return {
        ...state,
        documents: {
          ...state.documents,
          [document.id]: sanitizeDocumentSelection({ ...document, ...action.patch }),
        },
      }
    }
    case 'savePoint': {
      const document = state.documents[action.documentId]
      if (!document) return state
      const hasFilePath = Object.prototype.hasOwnProperty.call(action, 'filePath')
      return {
        ...state,
        documents: {
          ...state.documents,
          [document.id]: {
            ...document,
            savePoint: action.savePoint,
            ...(hasFilePath ? { filePath: action.filePath ?? null } : {}),
            ...(action.displayName === undefined ? {} : { displayName: action.displayName }),
            pristineUntitled: hasFilePath && action.filePath ? false : document.pristineUntitled,
            followsMainVersion: action.filePath ? false : document.followsMainVersion,
          },
        },
      }
    }
    case 'beginOperation': {
      const document = state.documents[action.documentId]
      if (!document) return state
      return {
        ...state,
        documents: {
          ...state.documents,
          [document.id]: {
            ...document,
            operationToken: action.token,
            status: action.status,
            error: null,
          },
        },
      }
    }
    case 'completeOperation': {
      const document = state.documents[action.owner.documentId]
      if (!document || document.operationToken !== action.owner.token) return state
      return {
        ...state,
        documents: {
          ...state.documents,
          [document.id]: {
            ...document,
            ...action.patch,
            operationToken: null,
          },
        },
      }
    }
    case 'close': {
      const index = state.order.indexOf(action.documentId)
      if (index < 0) return state
      let order = state.order.filter(id => id !== action.documentId)
      const documents = { ...state.documents }
      delete documents[action.documentId]
      let clock = state.clock
      if (order.length === 0) {
        if (!action.replacement) return state
        clock += 1
        const replacement = { ...action.replacement, lastTouchedAt: clock }
        order = [replacement.id]
        documents[replacement.id] = replacement
      }
      const activeDocumentId = state.activeDocumentId === action.documentId
        ? order[Math.min(index, order.length - 1)]
        : state.activeDocumentId
      return {
        order,
        activeDocumentId,
        documents,
        clock,
      }
    }
  }
}

export interface OpenStudioDocumentOptions extends Omit<CreateStudioDocumentOptions, 'state'> {
  activate?: boolean
}

export function useStudioDocuments(initialState?: StudioDocumentsState) {
  const [state, dispatch] = useReducer(
    studioDocumentsReducer,
    initialState,
    value => value ?? createStudioDocumentsState(),
  )
  const stateRef = useRef(state)
  stateRef.current = state

  const syncMainVersion = useCallback((version: string) => dispatch({ type: 'mainVersion', version }), [])

  const dispatchTimeline = useCallback((documentId: string, action: TimelineHistoryAction) => {
    dispatch({ type: 'timeline', documentId, action })
  }, [])
  const activeDocument = state.documents[state.activeDocumentId]
  const activeTimelineDispatch = useCallback((action: TimelineHistoryAction) => {
    dispatchTimeline(state.activeDocumentId, action)
  }, [dispatchTimeline, state.activeDocumentId])
  const activeTimeline = useTimelineController(activeDocument.history, activeTimelineDispatch)

  const newDocument = useCallback((targetVersion = ''): string | null => {
    if (stateRef.current.order.length >= MAX_STUDIO_DOCUMENTS) return null
    const document = createStudioDocument({ targetVersion })
    dispatch({ type: 'add', document, activate: true })
    return document.id
  }, [])

  const openDocument = useCallback((
    timelineState: TimelineState,
    options: OpenStudioDocumentOptions = {},
  ): string | null => {
    if (stateRef.current.order.length >= MAX_STUDIO_DOCUMENTS) return null
    const document = createStudioDocument({ ...options, state: timelineState })
    dispatch({ type: 'add', document, activate: options.activate ?? true })
    return document.id
  }, [])

  const activateDocument = useCallback((documentId: string): boolean => {
    if (!stateRef.current.documents[documentId]) return false
    dispatch({ type: 'activate', documentId })
    return true
  }, [])

  const updateDocument = useCallback((documentId: string, patch: StudioDocumentUpdate) => {
    dispatch({ type: 'update', documentId, patch })
  }, [])

  const setDocumentSavePoint = useCallback((
    documentId: string,
    savePoint: TimelineState | null,
    options: { filePath?: string | null, displayName?: string } = {},
  ) => {
    dispatch({ type: 'savePoint', documentId, savePoint, ...options })
  }, [])

  const closeDocument = useCallback((documentId: string): boolean => {
    const current = stateRef.current
    if (!current.documents[documentId]) return false
    const replacement = current.order.length === 1 ? createStudioDocument() : undefined
    dispatch({ type: 'close', documentId, replacement })
    return true
  }, [])

  const beginDocumentOperation = useCallback((
    documentId: string,
    status: StudioDocumentStatus,
  ): StudioDocumentOperationOwner | null => {
    const document = stateRef.current.documents[documentId]
    if (!document) return null
    const owner = {
      documentId,
      token: uuidv4(),
      stateSnapshot: document.history.current,
    }
    dispatch({ type: 'beginOperation', documentId, token: owner.token, status })
    return owner
  }, [])

  const completeDocumentOperation = useCallback((
    owner: StudioDocumentOperationOwner,
    patch: StudioDocumentUpdate = { status: 'ready' },
  ) => {
    dispatch({ type: 'completeOperation', owner, patch })
  }, [])

  const isDocumentOperationCurrent = useCallback((owner: StudioDocumentOperationOwner): boolean => {
    return stateRef.current.documents[owner.documentId]?.operationToken === owner.token
  }, [])

  const pasteIntoDocument = useCallback((
    documentId: string,
    input: TimelinePasteInput,
  ): string[] => {
    if (!stateRef.current.documents[documentId]) return []
    const prepared = createTimelinePasteAction(input)
    dispatchTimeline(documentId, prepared.action)
    return prepared.ids
  }, [dispatchTimeline])

  const documents = useMemo(
    () => state.order.map(id => state.documents[id]).filter((item): item is StudioDocument => Boolean(item)),
    [state.documents, state.order],
  )
  const dirtyDocumentIds = useMemo(
    () => documents.filter(isStudioDocumentDirty).map(document => document.id),
    [documents],
  )

  return useMemo(() => ({
    state,
    documents,
    activeDocument,
    activeTimeline,
    dirtyDocumentIds,
    syncMainVersion,
    canAddDocument: state.order.length < MAX_STUDIO_DOCUMENTS,
    dispatchTimeline,
    newDocument,
    openDocument,
    activateDocument,
    updateDocument,
    setDocumentSavePoint,
    closeDocument,
    beginDocumentOperation,
    completeDocumentOperation,
    isDocumentOperationCurrent,
    pasteIntoDocument,
  }), [
    activateDocument,
    activeDocument,
    activeTimeline,
    beginDocumentOperation,
    closeDocument,
    completeDocumentOperation,
    dirtyDocumentIds,
    dispatchTimeline,
    documents,
    isDocumentOperationCurrent,
    newDocument,
    openDocument,
    pasteIntoDocument,
    setDocumentSavePoint,
    state,
    syncMainVersion,
    updateDocument,
  ])
}

export type StudioDocumentsController = ReturnType<typeof useStudioDocuments>
