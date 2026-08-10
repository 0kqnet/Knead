import { describe, expect, it } from 'vitest'
import { createDefaultTrack, DEFAULT_MASTER, DEFAULT_SETTINGS, type TimelineState } from '../types/timeline'
import { DEFAULT_COMMAND_EXPORT_OPTIONS, generateCommandDatapack } from '../utils/commandExport'
import { exportNoteBlockBuild } from '../utils/noteBlockBuild'
import { executeStudioExportRequest } from './studioExportExecutor'

function project(): TimelineState {
  const track = createDefaultTrack('track')
  return {
    projectId: 'worker-project',
    randomSeed: 42,
    targetVersion: '1.21.4',
    lengthTicks: 40,
    settings: structuredClone(DEFAULT_SETTINGS),
    master: { ...DEFAULT_MASTER },
    tracks: [track],
    markers: [{
      id: 'marker',
      trackId: track.id,
      tick: 4,
      soundId: 'block.note_block.harp',
      variantIndex: -1,
      volume: 0.8,
      pitch: 1,
    }],
  }
}

function expectBoundedMonotonic(values: number[]): void {
  expect(values.length).toBeGreaterThan(2)
  expect(values[0]).toBeGreaterThanOrEqual(0)
  expect(values.at(-1)).toBe(1)
  values.forEach((value, index) => {
    expect(value).toBeGreaterThanOrEqual(0)
    expect(value).toBeLessThanOrEqual(1)
    if (index > 0) expect(value).toBeGreaterThanOrEqual(values[index - 1])
  })
}

describe('studio export worker executor', () => {
  it('keeps command output identical while reporting bounded progress', () => {
    const state = project()
    const expected = generateCommandDatapack(state, DEFAULT_COMMAND_EXPORT_OPTIONS)
    const progress: number[] = []
    const actual = executeStudioExportRequest({
      kind: 'command',
      payload: { project: state, options: DEFAULT_COMMAND_EXPORT_OPTIONS },
    }, { reportProgress: value => progress.push(value) })

    expect(actual).toEqual(expected)
    expectBoundedMonotonic(progress)
  })

  it('keeps deterministic build bytes identical while reporting bounded progress', () => {
    const state = project()
    const options = { format: 'litematica-compatible-nbt' as const }
    const expected = exportNoteBlockBuild(state, options)
    const progress: number[] = []
    const actual = executeStudioExportRequest({
      kind: 'note-block-build',
      payload: { project: state, options },
    }, { reportProgress: value => progress.push(value) })

    expect(actual).toEqual(expected)
    expectBoundedMonotonic(progress)
  })
})
