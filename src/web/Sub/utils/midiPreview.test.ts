import { describe, expect, it } from 'vitest'
import type { MidiNote, MidiSong, MidiTrack } from './midi'
import { MIDI_PREVIEW_LIMITS, buildMidiImportPreview } from './midiPreview'

function note(index: number, trackIndex: number, program: number): MidiNote {
  return {
    index,
    trackIndex,
    channel: 0,
    note: 60 + (index % 12),
    velocity: 100,
    releaseVelocity: 0,
    startTick: index * 24,
    endTick: index * 24 + 24,
    program,
    startPitchBend: 0,
    startOrder: index * 2,
    endOrder: index * 2 + 1,
  }
}

function song(trackCount = 1): MidiSong {
  let noteIndex = 0
  const tracks: MidiTrack[] = Array.from({ length: trackCount }, (_, trackIndex) => {
    const notes = trackIndex === 0
      ? Array.from({ length: 10 }, (_, program) => note(noteIndex++, trackIndex, program))
      : [note(noteIndex++, trackIndex, trackIndex % 128)]
    return {
      index: trackIndex,
      name: `Track ${trackIndex + 1}`,
      instrumentName: '',
      lastTick: notes.at(-1)?.endTick ?? 0,
      channels: [0],
      notes,
      programChanges: notes.map((entry, order) => ({
        tick: entry.startTick,
        channel: 0,
        program: entry.program,
        order,
      })),
      pitchBends: [],
    }
  })
  return {
    header: { format: trackCount > 1 ? 1 : 0, trackCount, ticksPerQuarter: 480 },
    tracks,
    tempoEvents: [],
    timeSignatureEvents: [],
    fingerprint: '1234abcd',
  }
}

describe('MIDI import preview', () => {
  it('bounds track/channel rows, mapping examples, programs, and displayed warnings', () => {
    const source = song(70)
    const parseWarnings = Array.from({ length: 40 }, (_, index) => `Parser warning ${index}`)
    const result = buildMidiImportPreview(source, parseWarnings, '1.21.4', {
      soundMapping: 'gm-identifiers',
      tailFade: { enabled: true, startPercent: 50, endPercent: 0 },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { summary } = result.preview
    expect(summary.sourceTrackCount).toBe(70)
    expect(summary.trackChannelCount).toBe(70)
    expect(summary.channelCount).toBe(1)
    expect(summary.noteCount).toBe(79)
    expect(summary.channelRows).toHaveLength(MIDI_PREVIEW_LIMITS.channelRows)
    expect(summary.omittedChannelRowCount).toBe(6)
    expect(summary.channelRows[0].programs).toHaveLength(MIDI_PREVIEW_LIMITS.programsPerRow)
    expect(summary.channelRows[0].omittedProgramCount).toBe(2)
    expect(summary.channelRows[0].soundIds).toHaveLength(MIDI_PREVIEW_LIMITS.soundsPerRow)
    expect(summary.channelRows[0].omittedSoundCount).toBe(6)
    expect(summary.displayedWarnings).toHaveLength(MIDI_PREVIEW_LIMITS.warnings)
    expect(summary.omittedWarningCount).toBeGreaterThanOrEqual(8)
    expect(summary.displayedWarnings.join(' ')).toMatch(/tail/i)
  })

  it('rebuilds from the same parsed song for note length, mapping, and channel overrides', () => {
    const source = song()
    const gated = buildMidiImportPreview(source, [], '1.21.4', {
      soundMapping: 'gm-identifiers',
      noteLengthMode: 'note-off-gate',
    })
    const adjusted = buildMidiImportPreview(source, [], '1.21.4', {
      soundMapping: 'minecraft',
      noteLengthMode: 'single-shot',
      tailFade: { enabled: true, startPercent: 50, endPercent: 0 },
      channelSoundOverrides: { 0: 'custom:preview_sound' },
    })
    expect(gated.ok).toBe(true)
    expect(adjusted.ok).toBe(true)
    if (!gated.ok || !adjusted.ok) return
    expect(gated.preview.state.markers[0].gateTicks).toBeGreaterThan(0)
    expect(adjusted.preview.state.markers[0]).toMatchObject({
      soundId: 'custom:preview_sound',
      gateTicks: undefined,
    })
    expect(adjusted.preview.summary.channelRows[0].soundIds).toEqual(['custom:preview_sound'])
    expect(adjusted.preview.warnings.join(' ')).toMatch(/tail fade was not applied in single-shot/i)
    expect(source.tracks[0].notes[0].program).toBe(0)
  })
})
