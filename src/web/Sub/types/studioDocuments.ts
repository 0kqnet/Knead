import type { TimelineHistory } from '../hooks/useTimeline'
import type { TimelineState } from './timeline'
import type { NbsTargetVersion } from '../utils/nbs'
import type { StudioSongFileKind } from '../../../../@types/global'

export const MAX_STUDIO_DOCUMENTS = 8
export const MAX_WORKSPACE_HISTORY_REVISIONS = 400

export type StudioDocumentStatus =
  | 'ready'
  | 'opening'
  | 'saving'
  | 'audio-switching'
  | 'closing'
  | 'error'

export interface StudioDocumentSelection {
  markerIds: string[]
  anchorMarkerId: string | null
  trackId: string
}

export interface StudioDocumentView {
  pxPerTick: number
  scrollLeft: number
  scrollTop: number
  transportTick: number
}

/**
 * One resident song tab. `savePoint` deliberately stores a TimelineState
 * identity: Immer returns that exact object when undo reaches the saved edit.
 */
export interface StudioDocument {
  id: string
  history: TimelineHistory
  savePoint: TimelineState | null
  filePath: string | null
  fileKind: StudioSongFileKind
  /** Direct-open NBS documents save back to this exact v0-v6 version. */
  nbsTargetVersion: NbsTargetVersion | null
  displayName: string
  pristineUntitled: boolean
  followsMainVersion: boolean
  selection: StudioDocumentSelection
  view: StudioDocumentView
  status: StudioDocumentStatus
  error: string | null
  recoverySaving: boolean
  recoveryError: string | null
  /** Newest document-scoped asynchronous operation, if any. */
  operationToken: string | null
  /** Monotonic workspace clock used for bounded inactive-history pruning. */
  lastTouchedAt: number
}

export interface StudioDocumentsState {
  order: string[]
  activeDocumentId: string
  documents: Record<string, StudioDocument>
  clock: number
}

/** Captures both ownership and the exact state an async operation started with. */
export interface StudioDocumentOperationOwner {
  documentId: string
  token: string
  stateSnapshot: TimelineState
}

export function isStudioDocumentDirty(document: StudioDocument): boolean {
  return document.history.current !== document.savePoint
}
