import type { TimelineState } from '../types/timeline'
import type {
  TimelineRecoveryApi,
  TimelineRecoveryMetadata,
  TimelineRecoverySaveRequest,
} from '../types/recovery'
import { parse, serialize, type ParseResult } from './timelineIO'

export const RECOVERY_DEBOUNCE_MS = 1_500
export const LOCAL_RECOVERY_TTL_MS = 30 * 24 * 60 * 60 * 1_000
export const MAX_LOCAL_RECOVERY_SNAPSHOTS = 3
export const MAX_LOCAL_RECOVERY_PROJECT_BYTES = 512 * 1024
export const MAX_LOCAL_RECOVERY_STORAGE_BYTES = 2 * 1024 * 1024

const LOCAL_RECOVERY_STORAGE_KEY = 'studio.timelineRecovery.v1'
const MAX_PROJECT_ID_LENGTH = 128
const MAX_FILE_PATH_LENGTH = 32_768
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1_000
const LOCAL_ID_PATTERN = /^[0-9a-f]{16}$/u

interface LocalRecoverySnapshot extends TimelineRecoveryMetadata {
  json: string
}

interface LocalRecoveryIndex {
  format: 'knead-recovery-index'
  version: 1
  snapshots: LocalRecoverySnapshot[]
}

function utf8ByteLength(value: string): number {
  let bytes = 0
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length
      && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4
      index += 1
    }
    else bytes += 3
  }
  return bytes
}

function fnv1a32(value: string, seed: number): number {
  let hash = seed >>> 0
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    hash ^= code & 0xff
    hash = Math.imul(hash, 0x01000193) >>> 0
    hash ^= code >>> 8
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

function localFingerprint(value: string): string {
  const first = fnv1a32(value, 0x811c9dc5).toString(16).padStart(8, '0')
  const second = fnv1a32(`${value}\0knead-recovery`, 0x9e3779b9).toString(16).padStart(8, '0')
  return `${first}${second}`
}

function localRecoveryId(projectId: string): string {
  return localFingerprint(`project:${projectId}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validProjectId(projectId: string): boolean {
  return projectId.length > 0 && projectId.length <= MAX_PROJECT_ID_LENGTH
}

function validUpdatedAt(updatedAt: number, now: number): boolean {
  return Number.isSafeInteger(updatedAt)
    && updatedAt > 0
    && updatedAt <= now + MAX_FUTURE_CLOCK_SKEW_MS
    && now - updatedAt <= LOCAL_RECOVERY_TTL_MS
}

function toMetadata(snapshot: LocalRecoverySnapshot): TimelineRecoveryMetadata {
  return {
    id: snapshot.id,
    projectId: snapshot.projectId,
    filePath: snapshot.filePath,
    updatedAt: snapshot.updatedAt,
    fingerprint: snapshot.fingerprint,
    byteLength: snapshot.byteLength,
  }
}

function validateLocalSnapshot(value: unknown, now: number): value is LocalRecoverySnapshot {
  if (!isRecord(value)) return false
  if (
    typeof value.id !== 'string' || !LOCAL_ID_PATTERN.test(value.id)
    || typeof value.projectId !== 'string' || !validProjectId(value.projectId)
    || value.id !== localRecoveryId(value.projectId)
    || (value.filePath !== null && (
      typeof value.filePath !== 'string' || value.filePath.length > MAX_FILE_PATH_LENGTH
    ))
    || typeof value.updatedAt !== 'number' || !validUpdatedAt(value.updatedAt, now)
    || typeof value.fingerprint !== 'string' || !LOCAL_ID_PATTERN.test(value.fingerprint)
    || typeof value.byteLength !== 'number' || !Number.isSafeInteger(value.byteLength)
    || value.byteLength < 1 || value.byteLength > MAX_LOCAL_RECOVERY_PROJECT_BYTES
    || typeof value.json !== 'string' || utf8ByteLength(value.json) !== value.byteLength
    || localFingerprint(value.json) !== value.fingerprint
  ) return false
  const parsed = parse(value.json)
  return parsed.ok && parsed.state.projectId === value.projectId
}

function serializeLocalIndex(snapshots: LocalRecoverySnapshot[]): string {
  const index: LocalRecoveryIndex = {
    format: 'knead-recovery-index',
    version: 1,
    snapshots,
  }
  return JSON.stringify(index)
}

export interface TimelineRecoveryStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

export function createLocalTimelineRecoveryApi(
  storage: TimelineRecoveryStorage,
  now: () => number = Date.now,
): TimelineRecoveryApi {
  const load = (): { snapshots: LocalRecoverySnapshot[], changed: boolean } => {
    const raw = storage.getItem(LOCAL_RECOVERY_STORAGE_KEY)
    if (raw === null) return { snapshots: [], changed: false }
    if (utf8ByteLength(raw) > MAX_LOCAL_RECOVERY_STORAGE_BYTES) {
      storage.removeItem(LOCAL_RECOVERY_STORAGE_KEY)
      return { snapshots: [], changed: true }
    }
    try {
      const decoded: unknown = JSON.parse(raw)
      if (!isRecord(decoded) || decoded.format !== 'knead-recovery-index'
        || decoded.version !== 1 || !Array.isArray(decoded.snapshots)) {
        storage.removeItem(LOCAL_RECOVERY_STORAGE_KEY)
        return { snapshots: [], changed: true }
      }
      const unique = new Set<string>()
      const snapshots = decoded.snapshots
        .filter(snapshot => validateLocalSnapshot(snapshot, now()))
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .filter((snapshot) => {
          if (unique.has(snapshot.id)) return false
          unique.add(snapshot.id)
          return true
        })
        .slice(0, MAX_LOCAL_RECOVERY_SNAPSHOTS)
      return { snapshots, changed: snapshots.length !== decoded.snapshots.length }
    }
    catch {
      storage.removeItem(LOCAL_RECOVERY_STORAGE_KEY)
      return { snapshots: [], changed: true }
    }
  }

  const persist = (source: LocalRecoverySnapshot[]): LocalRecoverySnapshot[] => {
    const snapshots = [...source]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_LOCAL_RECOVERY_SNAPSHOTS)
    let encoded = serializeLocalIndex(snapshots)
    while (snapshots.length > 0 && utf8ByteLength(encoded) > MAX_LOCAL_RECOVERY_STORAGE_BYTES) {
      snapshots.pop()
      encoded = serializeLocalIndex(snapshots)
    }
    if (snapshots.length === 0) storage.removeItem(LOCAL_RECOVERY_STORAGE_KEY)
    else storage.setItem(LOCAL_RECOVERY_STORAGE_KEY, encoded)
    return snapshots
  }

  return {
    save: async (request) => {
      if (!validProjectId(request.projectId)) return { ok: false, error: 'Invalid recovery project ID' }
      if (request.filePath !== null && request.filePath.length > MAX_FILE_PATH_LENGTH) {
        return { ok: false, error: 'Recovery source path is too long' }
      }
      if (!validUpdatedAt(request.updatedAt, now())) return { ok: false, error: 'Invalid recovery timestamp' }
      const byteLength = utf8ByteLength(request.json)
      if (byteLength < 1 || byteLength > MAX_LOCAL_RECOVERY_PROJECT_BYTES) {
        return { ok: false, error: 'Browser recovery snapshot exceeds the 512 KiB limit' }
      }
      const parsed = parse(request.json)
      if (!parsed.ok || parsed.state.projectId !== request.projectId) {
        return { ok: false, error: 'Recovery project data is invalid or mismatched' }
      }
      const loaded = load().snapshots
      const id = localRecoveryId(request.projectId)
      const previous = loaded.find(snapshot => snapshot.id === id)
      if (previous && previous.updatedAt > request.updatedAt) {
        return { ok: true, snapshot: toMetadata(previous) }
      }
      const snapshot: LocalRecoverySnapshot = {
        id,
        projectId: request.projectId,
        filePath: request.filePath,
        updatedAt: request.updatedAt,
        fingerprint: localFingerprint(request.json),
        byteLength,
        json: request.json,
      }
      try {
        persist([snapshot, ...loaded.filter(item => item.id !== id)])
        return { ok: true, snapshot: toMetadata(snapshot) }
      }
      catch (error) {
        return { ok: false, error: `Browser recovery storage failed: ${String(error)}` }
      }
    },
    list: async () => {
      try {
        const loaded = load()
        const snapshots = loaded.changed ? persist(loaded.snapshots) : loaded.snapshots
        return { ok: true, snapshots: snapshots.map(toMetadata) }
      }
      catch (error) {
        return { ok: false, error: `Browser recovery storage failed: ${String(error)}` }
      }
    },
    restore: async (id) => {
      if (!LOCAL_ID_PATTERN.test(id)) return { ok: false, error: 'Invalid recovery snapshot ID' }
      try {
        const loaded = load()
        if (loaded.changed) persist(loaded.snapshots)
        const snapshot = loaded.snapshots.find(item => item.id === id)
        if (!snapshot) return { ok: false, error: 'Recovery snapshot was not found or is no longer valid' }
        return { ok: true, snapshot: toMetadata(snapshot), json: snapshot.json }
      }
      catch (error) {
        return { ok: false, error: `Browser recovery storage failed: ${String(error)}` }
      }
    },
    discard: async (id) => {
      if (!LOCAL_ID_PATTERN.test(id)) return { ok: false, error: 'Invalid recovery snapshot ID' }
      try {
        const loaded = load().snapshots
        persist(loaded.filter(snapshot => snapshot.id !== id))
        return { ok: true }
      }
      catch (error) {
        return { ok: false, error: `Browser recovery storage failed: ${String(error)}` }
      }
    },
    clearProject: async (projectId) => {
      if (!validProjectId(projectId)) return { ok: false, error: 'Invalid recovery project ID' }
      try {
        const id = localRecoveryId(projectId)
        const loaded = load().snapshots
        persist(loaded.filter(snapshot => snapshot.id !== id))
        return { ok: true }
      }
      catch (error) {
        return { ok: false, error: `Browser recovery storage failed: ${String(error)}` }
      }
    },
  }
}

export function createTimelineRecoverySaveRequest(
  state: TimelineState,
  filePath: string | null | undefined,
  updatedAt = Date.now(),
): TimelineRecoverySaveRequest {
  return {
    projectId: state.projectId,
    filePath: filePath ?? null,
    updatedAt,
    json: serialize(state),
  }
}

export function parseTimelineRecoveryProject(json: string): ParseResult {
  return parse(json)
}

export function getTimelineRecoveryDisplayName(snapshot: TimelineRecoveryMetadata): string {
  const path = snapshot.filePath?.trim()
  if (!path) return snapshot.projectId
  const pieces = path.split(/[\\/]/u)
  return pieces.at(-1) || snapshot.projectId
}
