import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { Sandbox } from '../@types/global'
import type { SettingType } from './types/Settings'
import { createLocalTimelineRecoveryApi } from './web/Sub/utils/timelineRecovery'

const invokeVoid = async (command: string, args?: Record<string, unknown>): Promise<void> => {
  await invoke(command, args)
}

const api: Sandbox = {
  get_versions: () => invoke<{ id: string, downloaded: boolean }[]>('get_versions'),
  downloadVersionAssets: version => invoke('download_version_assets', { version }),
  get_mcSounds: version => invoke('get_mc_sounds', { version }),
  get_mcSoundHash: async (hash) => {
    const path = await invoke<string>('get_mc_sound_hash', { hash })
    return path === '' ? '' : convertFileSrc(path)
  },
  get_mcSoundData: async (hash) => {
    const data = await invoke<ArrayBuffer | Uint8Array | number[]>('get_mc_sound_data', { hash })
    if (data instanceof ArrayBuffer) return data
    return Uint8Array.from(data).buffer
  },
  get_mcMarkerIcons: (version, soundIds) => invoke('get_mc_marker_icons', { version, soundIds }),
  make_sub_window: () => {
    void invokeVoid('make_sub_window')
  },
  loadSettings: () => invoke('load_settings'),
  updateSettings: (partial) => {
    void invokeVoid('update_settings', { partial })
  },
  getSetting: key => invoke('get_setting', { key }),
  setSetting: (key, value) => {
    void invokeVoid('set_setting', { key, value })
  },
  loadRatingStar: () => invoke('load_rating_star'),
  saveRatingStar: data => invokeVoid('save_rating_star', { data }),
  saveRatingStarAsString: data => invokeVoid('save_rating_star_as_string', { data }),
  updateRatingStar: (key, value) => invokeVoid('update_rating_star', { key, value }),
  getCurrentSounds: () => invoke('get_current_sounds'),
  setSelectedSound: (id) => {
    void invokeVoid('set_selected_sound', { id })
  },
  getMainSelectedSound: () => invoke('get_main_selected_sound'),
  timeline: {
    save: (documentId, payload) => invoke('timeline_save', { documentId, payload }),
    saveDialog: (documentId, defaultPath, payload) => invoke('timeline_save_dialog', {
      documentId,
      defaultPath,
      payload,
    }),
    openDialog: () => invoke('timeline_open_dialog'),
    openPath: path => invoke('timeline_open_path', { path }),
    resolveNbsCustomAudio: (documentId, fileNames) => invoke('timeline_resolve_nbs_custom_audio', {
      documentId,
      fileNames,
    }),
    bindCurrentPath: (documentId, path) => invoke('timeline_bind_current_path', { documentId, path }),
    releaseCurrentPath: documentId => invokeVoid('timeline_release_current_path', { documentId }),
    takeOpenRequests: () => invoke('timeline_take_open_requests'),
    onOpenRequested: handler => listen('timeline-open-requested', handler),
    onCloseRequested: async (handler) => {
      const unlisten = await listen('timeline-close-requested', (event) => {
        handler(event.payload as Parameters<typeof handler>[0])
      })
      try {
        await invokeVoid('timeline_set_close_ready', { ready: true })
      }
      catch (error) {
        unlisten()
        throw error
      }
      return () => {
        void invokeVoid('timeline_set_close_ready', { ready: false })
          .finally(unlisten)
          .catch(() => undefined)
      }
    },
    confirmClose: mode => invokeVoid('timeline_confirm_close', { mode }),
    onDragDrop: handler => getCurrentWindow().onDragDropEvent(event => handler(event.payload)),
  },
  timelineRecovery: {
    save: request => invoke('timeline_recovery_save', { ...request }),
    list: () => invoke('timeline_recovery_list'),
    restore: id => invoke('timeline_recovery_restore', { id }),
    discard: id => invoke('timeline_recovery_discard', { id }),
    clearProject: projectId => invoke('timeline_recovery_clear_project', { projectId }),
  },
  audioExport: {
    start: request => invoke('audio_export_start', { request }),
    cancel: jobId => invokeVoid('audio_export_cancel', { jobId }),
    onProgress: handler => listen('audio-export-progress', event => handler(event.payload as Parameters<typeof handler>[0])),
  },
  commandExport: {
    save: request => invoke('command_export_save', { request }),
  },
  noteBlockBuild: {
    save: (defaultName, format, dataBase64) => invoke('note_block_build_save_dialog', {
      defaultName,
      format,
      dataBase64,
    }),
  },
  nbs: {
    open: () => invoke('nbs_open_dialog'),
    save: (defaultName, dataBase64) => invoke('nbs_save_dialog', { defaultName, dataBase64 }),
    openBundle: () => invoke('nbs_bundle_open_dialog'),
    saveBundle: (defaultName, dataBase64) => invoke('nbs_bundle_save_dialog', { defaultName, dataBase64 }),
  },
  midi: {
    open: () => invoke('midi_open_dialog'),
  },
  nbp: {
    open: () => invoke('nbp_open_dialog'),
    save: (defaultName, dataBase64) => invoke('nbp_save_dialog', { defaultName, dataBase64 }),
  },
  referenceAudio: {
    open: () => invoke('reference_audio_open_dialog'),
  },
  resourcePack: {
    open: () => invoke('resource_pack_open_dialog'),
  },
}

const previewSettings = new Map<string, SettingType>()
let previewSelectedSound = 'block.note_block.harp'
const previewSound = {
  id: previewSelectedSound,
  sounds: [{ path: 'preview-tone.wav', hash: 'preview-tone', pitch: 1 }],
}

function createPreviewTone(): ArrayBuffer {
  const sampleRate = 8000
  const samples = sampleRate / 2
  const buffer = new ArrayBuffer(44 + samples * 2)
  const view = new DataView(buffer)
  const ascii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + samples * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, samples * 2, true)
  for (let index = 0; index < samples; index++) {
    const envelope = Math.exp(-index / (sampleRate * 0.18))
    const sample = Math.sin(2 * Math.PI * 440 * index / sampleRate) * envelope
    view.setInt16(44 + index * 2, Math.round(sample * 0x5fff), true)
  }
  return buffer
}

const previewTone = createPreviewTone()

function previewBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const previewTimelineRecovery = createLocalTimelineRecoveryApi(window.localStorage)
const previewTimelinePaths = new Map<string, string>()

// `npm run dev:web` is intentionally usable without a Tauri host so UI work can
// be reviewed in an ordinary browser. Desktop builds always use the real API.
const previewApi: Sandbox = {
  get_versions: async () => [],
  downloadVersionAssets: async version => ({ version, assetIndex: '', downloadedAssets: 0, reusedAssets: 0 }),
  get_mcSounds: async () => [previewSound],
  get_mcSoundHash: async () => '',
  get_mcSoundData: async hash => hash === 'preview-tone' ? previewTone.slice(0) : new ArrayBuffer(0),
  get_mcMarkerIcons: async () => ({}),
  make_sub_window: () => undefined,
  loadSettings: async () => null,
  updateSettings: (partial) => { Object.entries(partial).forEach(([key, value]) => previewSettings.set(key, value)) },
  getSetting: async key => previewSettings.get(key),
  setSetting: (key, value) => { previewSettings.set(key, value) },
  loadRatingStar: async () => ({}),
  saveRatingStar: async () => undefined,
  saveRatingStarAsString: async () => undefined,
  updateRatingStar: async () => undefined,
  getCurrentSounds: async () => [previewSound],
  setSelectedSound: (id) => { previewSelectedSound = id },
  getMainSelectedSound: async () => previewSelectedSound,
  timeline: {
    save: async () => ({ ok: false, error: 'Project saving requires the desktop app.' }),
    saveDialog: async () => ({ ok: false, canceled: true }),
    openDialog: async () => ({ ok: false, canceled: true }),
    openPath: async () => ({ ok: false, error: 'Project opening requires the desktop app.' }),
    resolveNbsCustomAudio: async () => ({
      ok: false,
      error: 'Plain NBS custom sounds require the desktop app.',
    }),
    bindCurrentPath: async (documentId, path) => {
      const conflict = [...previewTimelinePaths].some(
        ([otherDocumentId, otherPath]) => otherDocumentId !== documentId && otherPath === path,
      )
      if (conflict) return { ok: false, error: 'This project is already open in another tab.' }
      previewTimelinePaths.set(documentId, path)
      return { ok: true, path }
    },
    releaseCurrentPath: async (documentId) => { previewTimelinePaths.delete(documentId) },
    takeOpenRequests: async () => [],
    onOpenRequested: async () => () => undefined,
    onCloseRequested: async () => () => undefined,
    confirmClose: async () => undefined,
    onDragDrop: async () => () => undefined,
  },
  timelineRecovery: previewTimelineRecovery,
  audioExport: {
    start: async () => ({ ok: false, error: 'Audio export requires the desktop app.' }),
    cancel: async () => undefined,
    onProgress: async () => () => undefined,
  },
  commandExport: {
    save: async () => ({ ok: false, error: 'Data pack export requires the desktop app.' }),
  },
  noteBlockBuild: {
    save: async () => ({ ok: false, error: 'Note-block build export requires the desktop app.' }),
  },
  nbs: {
    open: async () => ({ ok: false, canceled: true }),
    save: async () => ({ ok: false, error: 'NBS export requires the desktop app.' }),
    openBundle: async () => ({ ok: false, canceled: true }),
    saveBundle: async () => ({ ok: false, error: 'NBS bundle export requires the desktop app.' }),
  },
  midi: {
    open: async () => ({ ok: false, canceled: true }),
  },
  nbp: {
    open: async () => ({ ok: false, canceled: true }),
    save: async () => ({ ok: false, error: 'NBP export requires the desktop app.' }),
  },
  referenceAudio: {
    open: async () => ({
      ok: true,
      path: 'preview-tone.wav',
      fileName: 'preview-tone.wav',
      mimeType: 'audio/wav',
      byteLength: previewTone.byteLength,
      dataBase64: previewBase64(previewTone),
    }),
  },
  resourcePack: {
    open: async () => ({ ok: false, canceled: true }),
  },
}

window.myAPI = '__TAURI_INTERNALS__' in window ? api : previewApi
