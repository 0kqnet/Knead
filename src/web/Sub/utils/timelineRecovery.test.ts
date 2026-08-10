import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MASTER,
  DEFAULT_SETTINGS,
  DEFAULT_TIMELINE_LENGTH_TICKS,
  createDefaultTrack,
  type TimelineState,
} from '../types/timeline'
import {
  createLocalTimelineRecoveryApi,
  createTimelineRecoverySaveRequest,
  getTimelineRecoveryDisplayName,
  LOCAL_RECOVERY_TTL_MS,
  MAX_LOCAL_RECOVERY_PROJECT_BYTES,
  MAX_LOCAL_RECOVERY_SNAPSHOTS,
  parseTimelineRecoveryProject,
  type TimelineRecoveryStorage,
} from './timelineRecovery'

class MemoryStorage implements TimelineRecoveryStorage {
  readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

function project(projectId: string): TimelineState {
  return {
    projectId,
    randomSeed: 1,
    targetVersion: '1.21.4',
    lengthTicks: DEFAULT_TIMELINE_LENGTH_TICKS,
    settings: structuredClone(DEFAULT_SETTINGS),
    master: { ...DEFAULT_MASTER },
    tracks: [createDefaultTrack(`track-${projectId}`)],
    markers: [],
    referenceAudio: [],
    customAudio: [],
  }
}

describe('timeline recovery browser fallback', () => {
  it('round-trips current timeline serialization with bounded metadata', async () => {
    const storage = new MemoryStorage()
    const now = 1_800_000_000_000
    const api = createLocalTimelineRecoveryApi(storage, () => now)
    const request = createTimelineRecoverySaveRequest(
      project('portable-project'),
      'C:\\Music\\portable.kp',
      now,
    )

    const saved = await api.save(request)
    expect(saved.ok).toBe(true)
    if (!saved.ok) return
    expect(saved.snapshot).toMatchObject({
      projectId: 'portable-project',
      filePath: 'C:\\Music\\portable.kp',
      updatedAt: now,
    })
    expect(saved.snapshot.id).toMatch(/^[0-9a-f]{16}$/u)
    expect(saved.snapshot.fingerprint).toMatch(/^[0-9a-f]{16}$/u)
    expect(getTimelineRecoveryDisplayName(saved.snapshot)).toBe('portable.kp')

    const listed = await api.list()
    expect(listed).toEqual({ ok: true, snapshots: [saved.snapshot] })
    const restored = await api.restore(saved.snapshot.id)
    expect(restored.ok).toBe(true)
    if (restored.ok) {
      const parsed = parseTimelineRecoveryProject(restored.json)
      expect(parsed.ok && parsed.state.projectId).toBe('portable-project')
    }
  })

  it('keeps only the newest fixed number of per-project snapshots', async () => {
    const storage = new MemoryStorage()
    const now = 1_800_000_000_000
    const api = createLocalTimelineRecoveryApi(storage, () => now)
    for (let index = 0; index < MAX_LOCAL_RECOVERY_SNAPSHOTS + 2; index++) {
      const state = project(`project-${index}`)
      const result = await api.save(createTimelineRecoverySaveRequest(state, null, now - index))
      expect(result.ok).toBe(true)
    }
    const listed = await api.list()
    expect(listed.ok && listed.snapshots).toHaveLength(MAX_LOCAL_RECOVERY_SNAPSHOTS)
    if (listed.ok) {
      expect(listed.snapshots.map(snapshot => snapshot.projectId)).toEqual([
        'project-0', 'project-1', 'project-2',
      ])
    }
  })

  it('rejects corrupt, expired, oversized, and unsafe recovery requests', async () => {
    const storage = new MemoryStorage()
    const now = 1_800_000_000_000
    const api = createLocalTimelineRecoveryApi(storage, () => now)
    const expired = await api.save(createTimelineRecoverySaveRequest(
      project('expired'),
      null,
      now - LOCAL_RECOVERY_TTL_MS - 1,
    ))
    expect(expired).toMatchObject({ ok: false })

    const large = project('large')
    large.targetVersion = 'x'.repeat(MAX_LOCAL_RECOVERY_PROJECT_BYTES + 1)
    const oversized = await api.save(createTimelineRecoverySaveRequest(large, null, now))
    expect(oversized).toMatchObject({ ok: false })

    expect(await api.restore('../../escape')).toMatchObject({ ok: false })
    storage.setItem('studio.timelineRecovery.v1', '{corrupt')
    expect(await api.list()).toEqual({ ok: true, snapshots: [] })
    expect(storage.values.size).toBe(0)
  })

  it('clears only the requested project after a normal save', async () => {
    const storage = new MemoryStorage()
    const now = 1_800_000_000_000
    const api = createLocalTimelineRecoveryApi(storage, () => now)
    await api.save(createTimelineRecoverySaveRequest(project('keep'), null, now - 1))
    await api.save(createTimelineRecoverySaveRequest(project('clear'), null, now))

    expect(await api.clearProject('clear')).toEqual({ ok: true })
    const listed = await api.list()
    expect(listed.ok && listed.snapshots.map(snapshot => snapshot.projectId)).toEqual(['keep'])
  })
})
