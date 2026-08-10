// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearRecentStudioSongs,
  loadRecentStudioSongs,
  MAX_RECENT_STUDIO_SONGS,
  MAX_RECENT_STUDIO_SONGS_STORAGE_BYTES,
  RECENT_STUDIO_SONGS_KEY,
  rememberRecentStudioSong,
  removeRecentStudioSong,
  type RecentStudioSong,
} from './recentStudioSongs'

describe('recentStudioSongs', () => {
  beforeEach(() => localStorage.clear())

  it('deduplicates, orders newest first, accepts kp/nbs, and caps at ten', () => {
    let recent: RecentStudioSong[] = []
    for (let index = 0; index < MAX_RECENT_STUDIO_SONGS + 3; index++) {
      recent = rememberRecentStudioSong(localStorage, recent, {
        path: `C:\\Songs\\song-${index}.${index % 2 ? 'kp' : 'nbs'}`,
        kind: index % 2 ? 'kp' : 'nbs',
      })
    }
    expect(recent).toHaveLength(MAX_RECENT_STUDIO_SONGS)
    expect(recent[0].path).toBe('C:\\Songs\\song-12.nbs')

    recent = rememberRecentStudioSong(localStorage, recent, {
      path: 'c:/songs/SONG-12.NBS',
      kind: 'nbs',
    })
    expect(recent).toHaveLength(MAX_RECENT_STUDIO_SONGS)
    expect(recent[0].path).toBe('c:/songs/SONG-12.NBS')
    expect(loadRecentStudioSongs(localStorage)).toEqual(recent)
  })

  it('removes failed paths and clears the persisted list', () => {
    let recent = rememberRecentStudioSong(localStorage, [], { path: 'C:\\Songs\\one.kp', kind: 'kp' })
    recent = rememberRecentStudioSong(localStorage, recent, { path: 'C:\\Songs\\two.nbs', kind: 'nbs' })
    expect(removeRecentStudioSong(localStorage, recent, 'C:\\Songs\\one.kp')).toEqual([
      { path: 'C:\\Songs\\two.nbs', kind: 'nbs' },
    ])
    expect(removeRecentStudioSong(
      localStorage,
      [{ path: 'C:\\Songs\\two.nbs', kind: 'nbs' }],
      'C:\\Songs\\two.nbs',
    )).toEqual([])
    expect(localStorage.getItem(RECENT_STUDIO_SONGS_KEY)).toBeNull()
    expect(clearRecentStudioSongs(localStorage)).toEqual([])
    expect(localStorage.getItem(RECENT_STUDIO_SONGS_KEY)).toBeNull()
  })

  it('drops malformed, mismatched-extension, and oversized private path data', () => {
    localStorage.setItem(RECENT_STUDIO_SONGS_KEY, '{bad json')
    expect(loadRecentStudioSongs(localStorage)).toEqual([])
    expect(localStorage.getItem(RECENT_STUDIO_SONGS_KEY)).toBeNull()

    localStorage.setItem(RECENT_STUDIO_SONGS_KEY, JSON.stringify([
      { path: 'wrong.kp', kind: 'nbs' },
      { path: 'relative.nbs', kind: 'nbs' },
      { path: 'bad\0name.kp', kind: 'kp' },
    ]))
    expect(loadRecentStudioSongs(localStorage)).toEqual([])
    expect(localStorage.getItem(RECENT_STUDIO_SONGS_KEY)).toBeNull()

    localStorage.setItem(RECENT_STUDIO_SONGS_KEY, JSON.stringify([
      { path: 'C:\\Songs\\kept.kp', kind: 'kp' },
      { path: 'C:\\Private\\wrong.kp', kind: 'nbs' },
    ]))
    expect(loadRecentStudioSongs(localStorage)).toEqual([
      { path: 'C:\\Songs\\kept.kp', kind: 'kp' },
    ])
    expect(localStorage.getItem(RECENT_STUDIO_SONGS_KEY)).toBe(JSON.stringify([
      { path: 'C:\\Songs\\kept.kp', kind: 'kp' },
    ]))

    localStorage.setItem(RECENT_STUDIO_SONGS_KEY, 'x'.repeat(MAX_RECENT_STUDIO_SONGS_STORAGE_BYTES + 1))
    expect(loadRecentStudioSongs(localStorage)).toEqual([])
    expect(localStorage.getItem(RECENT_STUDIO_SONGS_KEY)).toBeNull()
  })
})
