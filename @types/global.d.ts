import { Sound } from '../src/store/fetchSlice'
import { SettingType } from '../src/types/Settings'
import type { TimelineState } from '../src/web/Sub/types/timeline'

export type ProjectDragDropEvent =
  | { type: 'enter', paths: string[] }
  | { type: 'over' }
  | { type: 'drop', paths: string[] }
  | { type: 'leave' }

export type TimelineOpenResult =
  | { ok: true, path: string, json: string }
  | { ok: false, canceled: true }
  | { ok: false, error: string }

export interface AudioExportOptions {
  format: 'wav' | 'ogg' | 'mp3'
  targets: ('mix' | 'stems')[]
  sampleRate: 44100 | 48000 | 96000
  channels: 1 | 2
  wavBitDepth: 16 | 24 | 32
  oggQuality: number
  mp3Bitrate: 128 | 192 | 256 | 320
  range: 'project' | 'loop'
  includeTails: boolean
  includeMutedTracks: boolean
}

export interface AudioExportVariant {
  path: string
  hash: string
  pitch: number
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
      json: string,
    ) => Promise<{ ok: true, path: string } | { ok: false, error: string }>
    saveDialog: (
      defaultPath: string | undefined,
      json: string,
    ) => Promise<{ ok: true, path: string } | { ok: false, canceled: true } | { ok: false, error: string }>
    openDialog: () => Promise<TimelineOpenResult>
    openPath: (path: string) => Promise<TimelineOpenResult>
    setCurrentPath: (path: string) => Promise<{ ok: true, path: string } | { ok: false, error: string }>
    takeOpenRequest: () => Promise<string | null>
    onOpenRequested: (handler: () => void) => Promise<() => void>
    onDragDrop: (handler: (event: ProjectDragDropEvent) => void) => Promise<() => void>
  }
  audioExport: {
    start: (request: AudioExportRequest) => Promise<
      { ok: true, jobId: string } | { ok: false, canceled: true } | { ok: false, error: string }
    >
    cancel: (jobId: string) => Promise<void>
    onProgress: (handler: (progress: AudioExportProgress) => void) => Promise<() => void>
  }
}
