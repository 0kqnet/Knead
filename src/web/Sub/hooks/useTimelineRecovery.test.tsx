// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TimelineRecoveryApi, TimelineRecoverySaveRequest } from '../types/recovery'
import {
  DEFAULT_MASTER,
  DEFAULT_SETTINGS,
  DEFAULT_TIMELINE_LENGTH_TICKS,
  createDefaultTrack,
  type TimelineState,
} from '../types/timeline'
import { parseTimelineRecoveryProject } from '../utils/timelineRecovery'
import { useTimelineRecovery } from './useTimelineRecovery'

function project(targetVersion = '1.21.4'): TimelineState {
  return {
    projectId: 'autosave-project',
    randomSeed: 7,
    targetVersion,
    lengthTicks: DEFAULT_TIMELINE_LENGTH_TICKS,
    settings: structuredClone(DEFAULT_SETTINGS),
    master: { ...DEFAULT_MASTER },
    tracks: [createDefaultTrack('track-a')],
    markers: [],
    referenceAudio: [],
    customAudio: [],
  }
}

function recoveryApi() {
  const save = vi.fn(async (request: TimelineRecoverySaveRequest) => ({
    ok: true as const,
    snapshot: {
      id: 'snapshot-id',
      projectId: request.projectId,
      filePath: request.filePath,
      updatedAt: request.updatedAt,
      fingerprint: 'fingerprint',
      byteLength: request.json.length,
    },
  }))
  const clearProject = vi.fn(async () => ({ ok: true as const }))
  const api: TimelineRecoveryApi = {
    save,
    clearProject,
    list: vi.fn(async () => ({ ok: true as const, snapshots: [] })),
    restore: vi.fn(async () => ({ ok: false as const, error: 'not used' })),
    discard: vi.fn(async () => ({ ok: true as const })),
  }
  return { api, save, clearProject }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('useTimelineRecovery', () => {
  it('debounces dirty changes and saves only the latest serialized state', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-10T00:00:00Z'))
    const mocked = recoveryApi()
    const { rerender } = renderHook(
      ({ state }: { state: TimelineState }) => useTimelineRecovery({
        state,
        filePath: 'C:\\Music\\autosave.kp',
        dirty: true,
        debounceMs: 100,
        api: mocked.api,
      }),
      { initialProps: { state: project('1.21.4') } },
    )

    await act(async () => {
      vi.advanceTimersByTime(75)
    })
    expect(mocked.save).not.toHaveBeenCalled()
    rerender({ state: project('1.21.5') })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })

    expect(mocked.save).toHaveBeenCalledTimes(1)
    const request = mocked.save.mock.calls[0][0]
    expect(request).toMatchObject({
      projectId: 'autosave-project',
      filePath: 'C:\\Music\\autosave.kp',
    })
    const parsed = parseTimelineRecoveryProject(request.json)
    expect(parsed.ok && parsed.state.targetVersion).toBe('1.21.5')
  })

  it('flushes immediately and clears the project only when explicitly told a save succeeded', async () => {
    const mocked = recoveryApi()
    const { result } = renderHook(() => useTimelineRecovery({
      state: project(),
      dirty: true,
      debounceMs: 60_000,
      api: mocked.api,
    }))

    await act(async () => {
      expect(await result.current.flush()).toBe(true)
    })
    expect(mocked.save).toHaveBeenCalledTimes(1)
    expect(mocked.clearProject).not.toHaveBeenCalled()

    await act(async () => {
      expect(await result.current.clearAfterSave()).toBe(true)
    })
    expect(mocked.clearProject).toHaveBeenCalledWith('autosave-project')
    expect(result.current.lastSnapshot).toBeNull()
  })
})
