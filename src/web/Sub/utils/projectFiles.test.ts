import { describe, expect, it } from 'vitest'
import {
  findKneadProjectPath,
  findKneadProjectPaths,
  findStudioSongPaths,
  MAX_KNEAD_PROJECT_PATHS,
} from './projectFiles'

describe('projectFiles', () => {
  it('keeps all .kp/.nbs paths in input order and rejects lookalike suffixes', () => {
    expect(findKneadProjectPaths([
      'notes.json',
      'first.kp',
      'archive.kp.json',
      'SECOND.KP',
      'third.NBS',
      'third.nbs.zip',
    ])).toEqual(['first.kp', 'SECOND.KP', 'third.NBS'])
  })

  it('deduplicates equivalent slash spellings while retaining the first path', () => {
    expect(findKneadProjectPaths([
      'C:\\songs\\demo.kp',
      'C:/songs/demo.kp',
      'c:/SONGS/DEMO.KP',
      'C:\\songs\\demo.nbs',
      'c:/SONGS/DEMO.NBS',
      'C:\\songs\\other.kp',
    ])).toEqual(['C:\\songs\\demo.kp', 'C:\\songs\\demo.nbs', 'C:\\songs\\other.kp'])
  })

  it('bounds a batch to 32 projects', () => {
    const paths = Array.from(
      { length: MAX_KNEAD_PROJECT_PATHS + 8 },
      (_, index) => `song-${index}.kp`,
    )

    expect(findKneadProjectPaths(paths)).toEqual(paths.slice(0, MAX_KNEAD_PROJECT_PATHS))
  })

  it('retains the singular compatibility wrapper', () => {
    expect(findKneadProjectPath(['ignore.txt', 'one.nbs', 'two.kp'])).toBe('one.nbs')
    expect(findKneadProjectPath(['ignore.kp.json'])).toBeUndefined()
    expect(findStudioSongPaths(['one.nbs', 'two.kp'])).toEqual(['one.nbs', 'two.kp'])
  })
})
