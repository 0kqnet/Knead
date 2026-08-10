import React, { useEffect, useMemo, useRef } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { useTimelineRecovery } from '../hooks/useTimelineRecovery'
import { isStudioDocumentDirty, type StudioDocument } from '../types/studioDocuments'
import type { TimelineRecoveryApi, TimelineRecoveryMetadata } from '../types/recovery'
import type { TimelineState } from '../types/timeline'

export interface DocumentRecoveryStatus {
  saving: boolean
  error: string | null
  lastSnapshot: TimelineRecoveryMetadata | null
}

export interface DocumentRecoveryReconcileResult {
  ok: boolean
  /** False means a newer dirty state was flushed and deliberately retained. */
  cleared: boolean
}

export interface DocumentRecoveryController {
  documentId: string
  registrationToken: string
  flush: () => Promise<boolean>
  clear: () => Promise<boolean>
  reconcileAfterSave: (
    savedState: TimelineState,
    currentState?: TimelineState,
  ) => Promise<DocumentRecoveryReconcileResult>
}

export interface DocumentRecoveryAgentProps {
  document: StudioDocument
  api?: TimelineRecoveryApi
  debounceMs?: number
  onStatus?: (documentId: string, status: DocumentRecoveryStatus) => void
  /**
   * Registry removals carry the original token. A parent must only delete a
   * controller if the token still matches its current registration.
   */
  onController?: (
    documentId: string,
    controller: DocumentRecoveryController | null,
    registrationToken: string,
  ) => void
}

const DocumentRecoveryWorker: React.FC<DocumentRecoveryAgentProps> = ({
  document,
  api,
  debounceMs,
  onStatus,
  onController,
}) => {
  const dirty = isStudioDocumentDirty(document)
  const recovery = useTimelineRecovery({
    state: document.history.current,
    filePath: document.filePath,
    dirty,
    api,
    debounceMs,
  })
  const flushRecovery = recovery.flush
  const clearRecovery = recovery.clearAfterSave
  const documentRef = useRef(document)
  documentRef.current = document
  const aliveRef = useRef(true)
  const registrationTokenRef = useRef(uuidv4())
  const statusCallbackRef = useRef(onStatus)
  statusCallbackRef.current = onStatus

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  useEffect(() => {
    statusCallbackRef.current?.(document.id, {
      saving: recovery.saving,
      error: recovery.error,
      lastSnapshot: recovery.lastSnapshot,
    })
  }, [document.id, recovery.error, recovery.lastSnapshot, recovery.saving])

  const controller = useMemo<DocumentRecoveryController>(() => ({
    documentId: document.id,
    registrationToken: registrationTokenRef.current,
    flush: async () => aliveRef.current && flushRecovery(),
    clear: async () => aliveRef.current && clearRecovery(),
    reconcileAfterSave: async (savedState, suppliedCurrentState) => {
      if (!aliveRef.current) return { ok: false, cleared: false }
      const currentState = suppliedCurrentState ?? documentRef.current.history.current
      if (currentState !== savedState) {
        return { ok: await flushRecovery(), cleared: false }
      }
      const ok = await clearRecovery()
      return { ok, cleared: ok }
    },
  }), [clearRecovery, document.id, flushRecovery])

  useEffect(() => {
    if (!onController) return undefined
    const token = registrationTokenRef.current
    onController(document.id, controller, token)
    return () => onController(document.id, null, token)
  }, [controller, document.id, onController])

  return null
}

/**
 * Headless autosave worker. Parent workspaces render one keyed instance for
 * every resident document, including inactive tabs.
 */
export const DocumentRecoveryAgent: React.FC<DocumentRecoveryAgentProps> = props => (
  <DocumentRecoveryWorker
    key={`${props.document.id}\0${props.document.history.current.projectId}`}
    {...props}
  />
)
