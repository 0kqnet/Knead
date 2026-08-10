import { Sound } from '../src/store/fetchSlice'
import { SettingType } from '../src/types/Settings'
import type { TimelineState } from '../src/web/Sub/types/timeline'
import type { TimelineRecoveryApi } from '../src/web/Sub/types/recovery'

export type ProjectDragDropEvent =
  | { type: 'enter', paths: string[] }
  | { type: 'over' }
  | { type: 'drop', paths: string[] }
  | { type: 'leave' }

export type StudioSongFileKind = 'kp' | 'nbs'

export type StudioSongWritePayload =
  | { kind: 'kp', data: string }
  | { kind: 'nbs', dataBase64: string }

export type TimelineOpenResult =
  | { ok: true, path: string, kind: 'kp', json: string }
  | { ok: true, path: string, kind: 'nbs', dataBase64: string }
  | { ok: false, canceled: true }
  | { ok: false, error: string }

export interface PlainNbsCustomAudioAsset {
  /** The original NBS Sounds-relative name requested by the renderer. */
  fileName: string
  mimeType: 'audio/wav' | 'audio/ogg'
  byteLength: number
  dataBase64: string
}

export type PlainNbsCustomAudioResult =
  | { ok: true, assets: PlainNbsCustomAudioAsset[], warnings: string[] }
  | { ok: false, error: string }

export type TimelineCloseMode = 'hide' | 'exit'

export interface TimelineCloseRequest {
  mode: TimelineCloseMode
}

export interface AudioExportOptions {
  format: 'wav' | 'aiff' | 'flac' | 'ogg' | 'mp3'
  targets: ('mix' | 'stems')[]
  /** Integer Hz. The backend validates the 8,000–384,000 range and codec limits. */
  sampleRate: number
  channels: 1 | 2
  /** WAV uses 32-bit float; AIFF/FLAC use signed integer PCM at 32-bit. */
  wavBitDepth: 16 | 24 | 32
  oggQuality: number
  mp3Bitrate: 8 | 16 | 24 | 32 | 40 | 48 | 56 | 64 | 80 | 96 | 112 | 128 | 144 | 160 | 192 | 224 | 256 | 320
  range: 'project' | 'loop'
  includeTails: boolean
  includeMutedTracks: boolean
}

export interface AudioExportVariant {
  path: string
  hash: string
  pitch: number
  /** Present only for project-scoped custom audio at the export IPC boundary. */
  dataBase64?: string
}

export interface AudioExportRequest {
  defaultName: string
  options: AudioExportOptions
  project: TimelineState
  soundManifest: Record<string, AudioExportVariant[]>
}

export interface AudioExportProgress {
  jobId: string
  progress: number
  stage: string
  currentTrack?: string
  done?: boolean
  canceled?: boolean
  error?: string
  outputPaths?: string[]
}

export interface MarkerVisualIcon {
  dataUrl: string
  kind: 'block' | 'entity' | 'item'
  cropX: number
  cropY: number
  cropWidth: number
  cropHeight: number
  imageWidth: number
  imageHeight: number
}

export interface CommandExportRequest {
  defaultName: string
  /** Omitted by older callers and therefore defaults to a data-pack dialog. */
  kind?: 'data-pack' | 'resource-pack'
  files: Record<string, string | { encoding: 'base64', data: string }>
}

export type NoteBlockBuildFormat =
  | 'structure-block-nbt'
  | 'litematica-compatible-nbt'
  | 'schematic-1.11-1.12'
  | 'schematic-pre-1.11'

export type NbsOpenResult =
  | { ok: true, path: string, dataBase64: string }
  | { ok: false, canceled: true }
  | { ok: false, error: string }

export type MidiOpenResult = NbsOpenResult
export type NbpOpenResult = NbsOpenResult
export type ResourcePackOpenResult = NbsOpenResult

export type ReferenceAudioOpenResult =
  | {
    ok: true
    path: string
    fileName: string
    mimeType: 'audio/wav' | 'audio/ogg'
    byteLength: number
    dataBase64: string
  }
  | { ok: false, canceled: true }
  | { ok: false, error: string }

declare global {
  interface Window {
    myAPI: Sandbox
  }
}

export interface Sandbox {
  get_versions: () => Promise<{ id: string, downloaded: boolean }[]>
  downloadVersionAssets: (version: string) => Promise<{
    version: string
    assetIndex: string
    downloadedAssets: number
    reusedAssets: number
  }>
  get_mcSounds: (version: string) => Promise<Sound[]>
  get_mcSoundHash: (hash: string) => Promise<string>
  get_mcSoundData: (hash: string) => Promise<ArrayBuffer>
  get_mcMarkerIcons: (
    version: string,
    soundIds: string[],
  ) => Promise<Record<string, MarkerVisualIcon>>
  make_sub_window: () => void
  loadSettings: () => Promise<SettingType>
  updateSettings: (partial: Record<string, SettingType>) => void
  getSetting: <Key extends string>(key: Key) => Promise<SettingType>
  setSetting: <Key extends string>(key: Key, value: SettingType) => void
  loadRatingStar: () => Promise<{ [key: string]: number }>
  saveRatingStar: (data: string) => Promise<void>
  saveRatingStarAsString: (data: string) => Promise<void>
  updateRatingStar: (key: string, value: number) => Promise<void>
  getCurrentSounds: () => Promise<Sound[]>
  setSelectedSound: (id: string) => void
  getMainSelectedSound: () => Promise<string>
  timeline: {
    save: (
      documentId: string,
      payload: StudioSongWritePayload,
    ) => Promise<{ ok: true, path: string } | { ok: false, error: string }>
    saveDialog: (
      documentId: string,
      defaultPath: string | undefined,
      payload: StudioSongWritePayload,
    ) => Promise<{ ok: true, path: string } | { ok: false, canceled: true } | { ok: false, error: string }>
    openDialog: () => Promise<TimelineOpenResult>
    openPath: (path: string) => Promise<TimelineOpenResult>
    resolveNbsCustomAudio: (
      /** Existing native path owner; arbitrary renderer paths are never accepted. */
      documentId: string,
      fileNames: string[],
    ) => Promise<PlainNbsCustomAudioResult>
    bindCurrentPath: (
      documentId: string,
      path: string,
    ) => Promise<{ ok: true, path: string } | { ok: false, error: string }>
    releaseCurrentPath: (documentId: string) => Promise<void>
    takeOpenRequests: () => Promise<string[]>
    onOpenRequested: (handler: () => void) => Promise<() => void>
    onCloseRequested: (handler: (request: TimelineCloseRequest) => void) => Promise<() => void>
    confirmClose: (mode: TimelineCloseMode) => Promise<void>
    onDragDrop: (handler: (event: ProjectDragDropEvent) => void) => Promise<() => void>
  }
  timelineRecovery: TimelineRecoveryApi
  audioExport: {
    start: (request: AudioExportRequest) => Promise<
      { ok: true, jobId: string } | { ok: false, canceled: true } | { ok: false, error: string }
    >
    cancel: (jobId: string) => Promise<void>
    onProgress: (handler: (progress: AudioExportProgress) => void) => Promise<() => void>
  }
  commandExport: {
    save: (request: CommandExportRequest) => Promise<
      { ok: true, path: string } | { ok: false, canceled: true } | { ok: false, error: string }
    >
  }
  noteBlockBuild: {
    save: (
      defaultName: string,
      format: NoteBlockBuildFormat,
      dataBase64: string,
    ) => Promise<{ ok: true, path: string } | { ok: false, canceled: true } | { ok: false, error: string }>
  }
  nbs: {
    open: () => Promise<NbsOpenResult>
    save: (
      defaultName: string,
      dataBase64: string,
    ) => Promise<{ ok: true, path: string } | { ok: false, canceled: true } | { ok: false, error: string }>
    openBundle: () => Promise<NbsOpenResult>
    saveBundle: (
      defaultName: string,
      dataBase64: string,
    ) => Promise<{ ok: true, path: string } | { ok: false, canceled: true } | { ok: false, error: string }>
  }
  midi: {
    open: () => Promise<MidiOpenResult>
  }
  nbp: {
    open: () => Promise<NbpOpenResult>
    save: (
      defaultName: string,
      dataBase64: string,
    ) => Promise<{ ok: true, path: string } | { ok: false, canceled: true } | { ok: false, error: string }>
  }
  referenceAudio: {
    open: () => Promise<ReferenceAudioOpenResult>
  }
  resourcePack: {
    open: () => Promise<ResourcePackOpenResult>
  }
}
