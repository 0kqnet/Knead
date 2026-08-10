export interface TimelineRecoveryMetadata {
  /** Opaque, backend-generated identifier. It must never be interpreted as a path. */
  id: string
  projectId: string
  filePath: string | null
  updatedAt: number
  fingerprint: string
  byteLength: number
}

export interface TimelineRecoverySaveRequest {
  projectId: string
  filePath: string | null
  updatedAt: number
  json: string
}

export type TimelineRecoverySaveResult =
  | { ok: true, snapshot: TimelineRecoveryMetadata }
  | { ok: false, error: string }

export type TimelineRecoveryListResult =
  | { ok: true, snapshots: TimelineRecoveryMetadata[] }
  | { ok: false, error: string }

export type TimelineRecoveryRestoreResult =
  | { ok: true, snapshot: TimelineRecoveryMetadata, json: string }
  | { ok: false, error: string }

export type TimelineRecoveryMutationResult =
  | { ok: true }
  | { ok: false, error: string }

export interface TimelineRecoveryApi {
  save: (request: TimelineRecoverySaveRequest) => Promise<TimelineRecoverySaveResult>
  list: () => Promise<TimelineRecoveryListResult>
  restore: (id: string) => Promise<TimelineRecoveryRestoreResult>
  discard: (id: string) => Promise<TimelineRecoveryMutationResult>
  clearProject: (projectId: string) => Promise<TimelineRecoveryMutationResult>
}
