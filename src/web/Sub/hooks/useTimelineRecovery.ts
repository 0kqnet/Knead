import { useCallback, useEffect, useRef, useState } from 'react'
import type { TimelineRecoveryApi, TimelineRecoveryMetadata } from '../types/recovery'
import type { TimelineState } from '../types/timeline'
import {
  createTimelineRecoverySaveRequest,
  RECOVERY_DEBOUNCE_MS,
} from '../utils/timelineRecovery'

export interface UseTimelineRecoveryOptions {
  state: TimelineState
  filePath?: string | null
  dirty: boolean
  enabled?: boolean
  debounceMs?: number
  api?: TimelineRecoveryApi
}

export interface TimelineRecoveryController {
  saving: boolean
  error: string | null
  lastSnapshot: TimelineRecoveryMetadata | null
  flush: () => Promise<boolean>
  /** Call only after a normal project save has completed successfully. */
  clearAfterSave: () => Promise<boolean>
}

export function useTimelineRecovery({
  state,
  filePath = null,
  dirty,
  enabled = true,
  debounceMs = RECOVERY_DEBOUNCE_MS,
  api = window.myAPI.timelineRecovery,
}: UseTimelineRecoveryOptions): TimelineRecoveryController {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastSnapshot, setLastSnapshot] = useState<TimelineRecoveryMetadata | null>(null)
  const mountedRef = useRef(true)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingRef = useRef(new Set<Promise<boolean>>())
  const generationRef = useRef(0)
  const latestRef = useRef({ state, filePath, dirty, enabled })
  latestRef.current = { state, filePath, dirty, enabled }

  const cancelTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const saveCurrent = useCallback(async (): Promise<boolean> => {
    const current = latestRef.current
    if (!current.enabled || !current.dirty) return false
    const generation = generationRef.current
    let request
    try {
      request = createTimelineRecoverySaveRequest(current.state, current.filePath)
    }
    catch (caught) {
      if (mountedRef.current && generation === generationRef.current) setError(String(caught))
      return false
    }
    if (mountedRef.current && generation === generationRef.current) {
      setSaving(true)
      setError(null)
    }
    const operation = Promise.resolve()
      .then(() => api.save(request))
      .then((result) => {
        if (generation !== generationRef.current) return false
        if (!result.ok) {
          if (mountedRef.current) setError(result.error)
          return false
        }
        if (mountedRef.current) {
          setLastSnapshot(result.snapshot)
          setError(null)
        }
        return true
      })
      .catch((caught) => {
        if (mountedRef.current && generation === generationRef.current) setError(String(caught))
        return false
      })
      .finally(() => {
        if (mountedRef.current && generation === generationRef.current) setSaving(false)
      })
    pendingRef.current.add(operation)
    const completed = await operation
    pendingRef.current.delete(operation)
    return completed
  }, [api])

  const flush = useCallback(async () => {
    cancelTimer()
    return saveCurrent()
  }, [cancelTimer, saveCurrent])

  const clearAfterSave = useCallback(async (): Promise<boolean> => {
    cancelTimer()
    generationRef.current += 1
    const projectId = latestRef.current.state.projectId
    const pending = [...pendingRef.current]
    if (pending.length > 0) await Promise.all(pending)
    if (mountedRef.current) {
      setSaving(true)
      setError(null)
    }
    try {
      const result = await api.clearProject(projectId)
      if (!result.ok) {
        if (mountedRef.current) setError(result.error)
        return false
      }
      if (mountedRef.current) {
        setLastSnapshot(null)
        setError(null)
      }
      return true
    }
    catch (caught) {
      if (mountedRef.current) setError(String(caught))
      return false
    }
    finally {
      if (mountedRef.current) setSaving(false)
    }
  }, [api, cancelTimer])

  useEffect(() => {
    cancelTimer()
    if (enabled && dirty) {
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        void saveCurrent()
      }, Math.max(0, debounceMs))
    }
    return cancelTimer
  }, [cancelTimer, debounceMs, dirty, enabled, saveCurrent, state, filePath])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      cancelTimer()
    }
  }, [cancelTimer])

  return { saving, error, lastSnapshot, flush, clearAfterSave }
}
