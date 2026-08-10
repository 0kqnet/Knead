import type { TimelineState } from '../types/timeline'
import {
  GENERAL_MIDI_PROGRAM_NAMES,
  midiTickToSeconds,
  midiToTimelineState,
  type MidiConversionOptions,
  type MidiSong,
} from './midi'

export const MIDI_PREVIEW_LIMITS = Object.freeze({
  channelRows: 64,
  programsPerRow: 8,
  soundsPerRow: 4,
  warnings: 32,
})

export interface MidiPreviewChannelRow {
  trackIndex: number
  trackName: string
  channel: number
  drum: boolean
  noteCount: number
  programs: readonly number[]
  programNames: readonly string[]
  omittedProgramCount: number
  soundIds: readonly string[]
  omittedSoundCount: number
}

export interface MidiImportPreviewSummary {
  sourceFormat: 0 | 1
  ticksPerQuarter: number
  sourceTrackCount: number
  channelCount: number
  trackChannelCount: number
  noteCount: number
  durationSeconds: number
  durationTicks: number
  tempoEventCount: number
  meterEventCount: number
  channelRows: readonly MidiPreviewChannelRow[]
  omittedChannelRowCount: number
  displayedWarnings: readonly string[]
  omittedWarningCount: number
}

export interface MidiImportPreview {
  state: TimelineState
  /** Full bounded-import warning list passed unchanged to the eventual Apply callback. */
  warnings: readonly string[]
  summary: MidiImportPreviewSummary
}

export type MidiImportPreviewResult =
  | { ok: true, preview: MidiImportPreview }
  | { ok: false, error: string }

interface MutablePreviewRow {
  trackIndex: number
  trackName: string
  channel: number
  drum: boolean
  noteCount: number
  programs: Set<number>
  omittedPrograms: Set<number>
  soundIds: Set<string>
  omittedSoundIds: Set<string>
}

function previewRowKey(trackIndex: number, channel: number): string {
  return `${trackIndex}:${channel}`
}

function addBoundedValue<T>(values: Set<T>, value: T, limit: number): boolean {
  if (values.has(value)) return false
  if (values.size >= limit) return true
  values.add(value)
  return false
}

function previewTrackName(song: MidiSong, trackIndex: number): string {
  const track = song.tracks[trackIndex]
  return track?.name.trim() || track?.instrumentName.trim() || `MIDI Track ${trackIndex + 1}`
}

function boundedMidiPreviewWarnings(
  parseWarnings: readonly string[],
  conversionWarnings: readonly string[],
): string[] {
  const limit = MIDI_PREVIEW_LIMITS.warnings
  let parseCount = Math.min(parseWarnings.length, Math.floor(limit / 2))
  let conversionCount = Math.min(conversionWarnings.length, limit - parseCount)
  let remaining = limit - parseCount - conversionCount
  if (remaining > 0) {
    const extraParse = Math.min(remaining, parseWarnings.length - parseCount)
    parseCount += extraParse
    remaining -= extraParse
  }
  if (remaining > 0) {
    conversionCount += Math.min(remaining, conversionWarnings.length - conversionCount)
  }
  return [
    ...parseWarnings.slice(0, parseCount),
    ...conversionWarnings.slice(0, conversionCount),
  ]
}

/**
 * Rebuilds an adjustable import preview from one immutable parsed song. Parsing
 * and its byte/event budgets therefore run only when the user chooses a file.
 */
export function buildMidiImportPreview(
  song: MidiSong,
  parseWarnings: readonly string[],
  targetVersion: string,
  options: MidiConversionOptions,
): MidiImportPreviewResult {
  try {
    const converted = midiToTimelineState(song, targetVersion, options)
    const warnings = [...parseWarnings, ...converted.warnings]
    const displayedWarnings = boundedMidiPreviewWarnings(parseWarnings, converted.warnings)
    const channelSet = new Set<number>()
    let trackChannelCount = 0
    let noteCount = 0
    const rows: MutablePreviewRow[] = []
    const rowByKey = new Map<string, MutablePreviewRow>()

    for (const track of song.tracks) {
      noteCount += track.notes.length
      for (const channel of track.channels) {
        channelSet.add(channel)
        trackChannelCount++
        if (rows.length >= MIDI_PREVIEW_LIMITS.channelRows) continue
        const row: MutablePreviewRow = {
          trackIndex: track.index,
          trackName: previewTrackName(song, track.index),
          channel,
          drum: channel === 9,
          noteCount: 0,
          programs: new Set(),
          omittedPrograms: new Set(),
          soundIds: new Set(),
          omittedSoundIds: new Set(),
        }
        rows.push(row)
        rowByKey.set(previewRowKey(track.index, channel), row)
      }
    }

    // One bounded pass over notes/programs; never rescan a huge track per UI row.
    for (const track of song.tracks) {
      for (const event of track.programChanges) {
        const row = rowByKey.get(previewRowKey(track.index, event.channel))
        if (
          row
          && addBoundedValue(row.programs, event.program, MIDI_PREVIEW_LIMITS.programsPerRow)
        ) row.omittedPrograms.add(event.program)
      }
      for (const note of track.notes) {
        const row = rowByKey.get(previewRowKey(track.index, note.channel))
        if (!row) continue
        row.noteCount++
        if (addBoundedValue(row.programs, note.program, MIDI_PREVIEW_LIMITS.programsPerRow)) {
          row.omittedPrograms.add(note.program)
        }
      }
    }
    // Use converted markers for this table so overrides and both mappings are exact.
    for (const marker of converted.state.markers) {
      if (marker.source?.format !== 'midi') continue
      const row = rowByKey.get(previewRowKey(marker.source.trackIndex, marker.source.channel))
      if (
        row
        && addBoundedValue(row.soundIds, marker.soundId, MIDI_PREVIEW_LIMITS.soundsPerRow)
      ) row.omittedSoundIds.add(marker.soundId)
    }

    const sourceLastTick = song.tracks.reduce(
      (latest, track) => Math.max(latest, track.lastTick),
      0,
    )
    const channelRows: MidiPreviewChannelRow[] = rows.map(row => ({
      trackIndex: row.trackIndex,
      trackName: row.trackName,
      channel: row.channel,
      drum: row.drum,
      noteCount: row.noteCount,
      programs: [...row.programs],
      programNames: [...row.programs].map(program => (
        GENERAL_MIDI_PROGRAM_NAMES[program] ?? `program_${program}`
      )),
      omittedProgramCount: row.omittedPrograms.size,
      soundIds: [...row.soundIds],
      omittedSoundCount: row.omittedSoundIds.size,
    }))
    return {
      ok: true,
      preview: {
        state: converted.state,
        warnings,
        summary: {
          sourceFormat: song.header.format,
          ticksPerQuarter: song.header.ticksPerQuarter,
          sourceTrackCount: song.tracks.length,
          channelCount: channelSet.size,
          trackChannelCount,
          noteCount,
          durationSeconds: midiTickToSeconds(song, sourceLastTick),
          durationTicks: converted.state.lengthTicks,
          tempoEventCount: song.tempoEvents.length,
          meterEventCount: song.timeSignatureEvents.length,
          channelRows,
          omittedChannelRowCount: Math.max(0, trackChannelCount - channelRows.length),
          displayedWarnings,
          omittedWarningCount: Math.max(0, warnings.length - displayedWarnings.length),
        },
      },
    }
  }
  catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
