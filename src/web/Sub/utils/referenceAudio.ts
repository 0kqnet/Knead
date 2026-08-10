import {
  MAX_REFERENCE_AUDIO_BYTES,
  MAX_REFERENCE_AUDIO_DURATION_SECONDS,
  MAX_REFERENCE_AUDIO_PROJECT_BYTES,
  MAX_REFERENCE_AUDIO_TRACKS,
  type ReferenceAudioMimeType,
  type ReferenceAudioTrack,
} from '../types/timeline'

export interface ReferenceAudioFileData {
  path: string
  fileName: string
  mimeType: ReferenceAudioMimeType
  byteLength: number
  dataBase64: string
}

export type ReferenceAudioTrackDraft = Omit<ReferenceAudioTrack, 'id' | 'color'>

const BASE64_CHUNK = 0x8000

function canonicalBase64Length(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4
}

export function decodeReferenceAudioBase64(dataBase64: string, byteLength: number): Uint8Array {
  if (
    !Number.isInteger(byteLength)
    || byteLength <= 0
    || byteLength > MAX_REFERENCE_AUDIO_BYTES
    || dataBase64.length !== canonicalBase64Length(byteLength)
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64)
  ) throw new Error('参照オーディオのBase64データが不正です')
  let binary: string
  try {
    binary = atob(dataBase64)
  }
  catch {
    throw new Error('参照オーディオのBase64デコードに失敗しました')
  }
  if (binary.length !== byteLength) throw new Error('参照オーディオのサイズが一致しません')
  const bytes = new Uint8Array(byteLength)
  for (let index = 0; index < byteLength; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export function encodeReferenceAudioBase64(bytes: Uint8Array): string {
  if (bytes.byteLength <= 0 || bytes.byteLength > MAX_REFERENCE_AUDIO_BYTES) {
    throw new Error(`参照オーディオは1バイト以上${MAX_REFERENCE_AUDIO_BYTES}バイト以下にしてください`)
  }
  const chunks: string[] = []
  for (let start = 0; start < bytes.length; start += BASE64_CHUNK) {
    let binary = ''
    const end = Math.min(bytes.length, start + BASE64_CHUNK)
    for (let index = start; index < end; index++) binary += String.fromCharCode(bytes[index])
    chunks.push(binary)
  }
  return btoa(chunks.join(''))
}

export function referenceAudioFingerprint(bytes: Uint8Array): string {
  let hash = 2_166_136_261
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16_777_619) >>> 0
  return hash.toString(16).padStart(8, '0')
}

export function hasReferenceAudioMagic(bytes: Uint8Array, mimeType: ReferenceAudioMimeType): boolean {
  if (mimeType === 'audio/ogg') {
    return bytes.length >= 4
      && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53
  }
  return bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45
}

export function readReferenceAudioFileData(file: ReferenceAudioFileData): Uint8Array {
  if (file.path.length > 32_768 || file.fileName.length === 0 || file.fileName.length > 512) {
    throw new Error('参照オーディオのパスまたはファイル名が不正です')
  }
  const extension = file.fileName.split('.').at(-1)?.toLowerCase()
  if (
    (file.mimeType === 'audio/wav' && extension !== 'wav')
    || (file.mimeType === 'audio/ogg' && extension !== 'ogg')
  ) throw new Error('参照オーディオの拡張子と形式が一致しません')
  const bytes = decodeReferenceAudioBase64(file.dataBase64, file.byteLength)
  if (!hasReferenceAudioMagic(bytes, file.mimeType)) {
    throw new Error(file.mimeType === 'audio/wav' ? 'WAVヘッダーが不正です' : 'Oggヘッダーが不正です')
  }
  return bytes
}

export function createReferenceAudioTrackDraft(
  file: ReferenceAudioFileData,
  bytes: Uint8Array,
  durationSeconds: number,
): ReferenceAudioTrackDraft {
  if (
    !Number.isFinite(durationSeconds)
    || durationSeconds <= 0
    || durationSeconds > MAX_REFERENCE_AUDIO_DURATION_SECONDS
  ) throw new Error('参照オーディオの再生時間が不正、または6時間を超えています')
  return {
    name: file.fileName.replace(/\.(?:wav|ogg)$/i, '') || 'Reference Audio',
    fileName: file.fileName,
    // The original absolute path can expose local usernames when a project is shared.
    // Bytes are embedded, so only the portable file name belongs in the project.
    sourcePath: '',
    mimeType: file.mimeType,
    byteLength: file.byteLength,
    fingerprint: referenceAudioFingerprint(bytes),
    dataBase64: file.dataBase64,
    durationSeconds,
    offsetTicks: 0,
    gainDb: 0,
    pan: 0,
    muted: false,
    solo: false,
    locked: false,
    collapsed: false,
  }
}

export function assertCanAddReferenceAudio(
  existing: readonly ReferenceAudioTrack[],
  nextByteLength: number,
): void {
  if (existing.length >= MAX_REFERENCE_AUDIO_TRACKS) {
    throw new Error(`参照オーディオは最大${MAX_REFERENCE_AUDIO_TRACKS}トラックです`)
  }
  const total = existing.reduce((sum, track) => sum + track.byteLength, 0) + nextByteLength
  if (total > MAX_REFERENCE_AUDIO_PROJECT_BYTES) {
    throw new Error('参照オーディオの合計容量が64 MiBを超えます（長尺はOggを推奨）')
  }
}

export function referenceAudioDurationTicks(track: Pick<ReferenceAudioTrack, 'durationSeconds'>): number {
  return Math.max(1, Math.ceil(track.durationSeconds / 0.05))
}
