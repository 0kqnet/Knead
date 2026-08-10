import type { StudioSongFileKind } from '../../../../@types/global'

export const RECENT_STUDIO_SONGS_KEY = 'knead.studio.recent-songs.v1'
export const MAX_RECENT_STUDIO_SONGS = 10
export const MAX_RECENT_STUDIO_SONG_PATH_BYTES = 4 * 1024
export const MAX_RECENT_STUDIO_SONGS_STORAGE_BYTES = 64 * 1024

export interface RecentStudioSong {
  path: string
  kind: StudioSongFileKind
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function dedupeKey(path: string): string {
  const normalized = path.replace(/\\/gu, '/')
  return /^(?:[a-z]:|\/\/)/iu.test(normalized) ? normalized.toLocaleLowerCase('en-US') : normalized
}

function validEntry(value: unknown): value is RecentStudioSong {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<RecentStudioSong>
  if (candidate.kind !== 'kp' && candidate.kind !== 'nbs') return false
  if (typeof candidate.path !== 'string' || candidate.path.length === 0) return false
  if (candidate.path !== candidate.path.trim() || candidate.path.includes('\0')) return false
  if (!/^(?:[a-z]:[\\/]|\\\\|\/)/iu.test(candidate.path)) return false
  if (byteLength(candidate.path) > MAX_RECENT_STUDIO_SONG_PATH_BYTES) return false
  return new RegExp(`\\.${candidate.kind}$`, 'iu').test(candidate.path)
}

function clearInvalidStorage(storage: Storage): RecentStudioSong[] {
  try {
    storage.removeItem(RECENT_STUDIO_SONGS_KEY)
  }
  catch {
    // Storage can be unavailable in hardened browser contexts.
  }
  return []
}

export function loadRecentStudioSongs(storage: Storage): RecentStudioSong[] {
  let raw: string | null
  try {
    raw = storage.getItem(RECENT_STUDIO_SONGS_KEY)
  }
  catch {
    return []
  }
  if (raw === null) return []
  if (raw.length === 0 || byteLength(raw) > MAX_RECENT_STUDIO_SONGS_STORAGE_BYTES) {
    return clearInvalidStorage(storage)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    return clearInvalidStorage(storage)
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_RECENT_STUDIO_SONGS * 4) {
    return clearInvalidStorage(storage)
  }
  const recent: RecentStudioSong[] = []
  const seen = new Set<string>()
  for (const item of parsed) {
    if (!validEntry(item)) continue
    const key = dedupeKey(item.path)
    if (seen.has(key)) continue
    seen.add(key)
    recent.push({ path: item.path, kind: item.kind })
    if (recent.length === MAX_RECENT_STUDIO_SONGS) break
  }
  if (recent.length === 0) return clearInvalidStorage(storage)
  const normalized = JSON.stringify(recent)
  if (normalized !== raw) {
    try {
      storage.setItem(RECENT_STUDIO_SONGS_KEY, normalized)
    }
    catch {
      // The validated in-memory list remains usable without persistence.
    }
  }
  return recent
}

export function saveRecentStudioSongs(
  storage: Storage,
  songs: readonly RecentStudioSong[],
): RecentStudioSong[] {
  const normalized: RecentStudioSong[] = []
  const seen = new Set<string>()
  for (const song of songs) {
    if (!validEntry(song)) continue
    const key = dedupeKey(song.path)
    if (seen.has(key)) continue
    seen.add(key)
    normalized.push({ path: song.path, kind: song.kind })
    if (normalized.length === MAX_RECENT_STUDIO_SONGS) break
  }
  if (normalized.length === 0) return clearInvalidStorage(storage)
  const json = JSON.stringify(normalized)
  if (byteLength(json) > MAX_RECENT_STUDIO_SONGS_STORAGE_BYTES) return clearInvalidStorage(storage)
  try {
    storage.setItem(RECENT_STUDIO_SONGS_KEY, json)
  }
  catch {
    return normalized
  }
  return normalized
}

export function rememberRecentStudioSong(
  storage: Storage,
  current: readonly RecentStudioSong[],
  entry: RecentStudioSong,
): RecentStudioSong[] {
  return saveRecentStudioSongs(storage, [entry, ...current])
}

export function removeRecentStudioSong(
  storage: Storage,
  current: readonly RecentStudioSong[],
  path: string,
): RecentStudioSong[] {
  const key = dedupeKey(path)
  return saveRecentStudioSongs(storage, current.filter(entry => dedupeKey(entry.path) !== key))
}

export function clearRecentStudioSongs(storage: Storage): RecentStudioSong[] {
  try {
    storage.removeItem(RECENT_STUDIO_SONGS_KEY)
  }
  catch {
    // Keep the in-memory list clear even when persistence is unavailable.
  }
  return []
}
