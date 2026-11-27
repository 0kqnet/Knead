import {
  DEFAULT_MASTER,
  DEFAULT_SETTINGS,
  MAX_GATE_TICKS,
  MAX_MARKER_PITCH,
  MAX_TIMELINE_MARKERS,
  MIN_MARKER_PITCH,
  TRACK_COLORS,
  createDefaultTrack,
  snapLaneY,
  type Marker,
  type TempoMapEvent,
  type TimelineState,
  type Track,
} from '../types/timeline'
import {
  MAX_TEMPO_BPM,
  getTimelineLengthTicks,
  MIN_TEMPO_BPM,
  normalizeTempoMap,
} from './tempoMap'

export interface MidiHeader {
  format: 0 | 1
  trackCount: number
  ticksPerQuarter: number
}

export interface MidiTempoEvent {
  tick: number
  microsecondsPerQuarter: number
  trackIndex: number
  order: number
}

export interface MidiTimeSignatureEvent {
  tick: number
  numerator: number
  denominator: number
  clocksPerMetronome: number
  thirtySecondsPerQuarter: number
  trackIndex: number
  order: number
}

export interface MidiProgramChange {
  tick: number
  channel: number
  program: number
  order: number
}

export interface MidiPitchBendEvent {
  tick: number
  channel: number
  /** Signed 14-bit bend value: -8192..8191. */
  value: number
  order: number
}

export interface MidiNote {
  index: number
  trackIndex: number
  channel: number
  note: number
  velocity: number
  releaseVelocity: number
  startTick: number
  endTick: number
  program: number
  /** Signed 14-bit bend value at note-on. */
  startPitchBend: number
  startOrder: number
  endOrder: number
}

export interface MidiTrack {
  index: number
  name: string
  instrumentName: string
  lastTick: number
  channels: number[]
  notes: MidiNote[]
  programChanges: MidiProgramChange[]
  pitchBends: MidiPitchBendEvent[]
}

export interface MidiSong {
  header: MidiHeader
  tracks: MidiTrack[]
  tempoEvents: MidiTempoEvent[]
  timeSignatureEvents: MidiTimeSignatureEvent[]
  /** FNV-1a hash of the source bytes, used only for stable imported IDs. */
  fingerprint: string
}

export interface MidiTempoSegment {
  tick: number
  seconds: number
  microsecondsPerQuarter: number
}

export type MidiParseResult =
  | { ok: true, song: MidiSong, warnings: string[] }
  | { ok: false, error: string }

export interface MidiConversionResult {
  state: TimelineState
  warnings: string[]
}

export type MidiSoundMapping = 'gm-identifiers' | 'minecraft'
export type MidiQuantizeStep = 0 | 1 | 2 | 4 | 5 | 10
export type MidiNoteLengthMode = 'note-off-gate' | 'single-shot'

export const MIDI_QUANTIZE_STEPS: readonly MidiQuantizeStep[] = [0, 1, 2, 4, 5, 10]

export interface MidiTailFadeOptions {
  /** Mirrors OpenNBS 3.12's "Fade tail velocity" checkbox. */
  enabled?: boolean
  /** Integer percent of the imported head velocity, 0..100. Official default: 50. */
  startPercent?: number
  /** Integer percent of the imported head velocity, 0..100. Official default: 50. */
  endPercent?: number
}

export interface MidiConversionOptions {
  /** Minecraft mapping is immediately audible; GM IDs are lossless external references. */
  soundMapping?: MidiSoundMapping
  /** Extra grid applied after conversion onto Knead's integer 20 TPS timeline. */
  quantizeStep?: MidiQuantizeStep
  /** Preserve paired note-off timing by default, or deliberately import one-shots. */
  noteLengthMode?: MidiNoteLengthMode
  /** OpenNBS 3.12-style per-tick melodic note tails. Requires note-off-gate mode. */
  tailFade?: MidiTailFadeOptions
  /** Optional global MIDI-channel sound overrides (0..15, at most one per channel). */
  channelSoundOverrides?: Readonly<Record<number, string>>
}

export type MidiImportResult =
  | { ok: true, song: MidiSong, state: TimelineState, warnings: string[] }
  | { ok: false, error: string }

export const MIDI_IMPORT_LIMITS = Object.freeze({
  maxBytes: 16 * 1024 * 1024,
  maxTracks: 256,
  maxEvents: 1_000_000,
  maxNotes: 250_000,
  maxTick: 0x7fff_ffff,
  maxTextEventBytes: 64 * 1024,
  maxTotalTextBytes: 1024 * 1024,
  maxTimelineTracks: 4096,
  maxTimelineTicks: 10_000_000,
  /** Includes source note heads and at most two bounded tail markers per head. */
  maxTimelineMarkers: MAX_TIMELINE_MARKERS,
})

const DEFAULT_TEMPO_US_PER_QUARTER = 500_000
const MIDI_PITCH_BEND_RANGE_SEMITONES = 2

/** General MIDI Level 1 program names, in zero-based program order. */
export const GENERAL_MIDI_PROGRAM_NAMES = [
  'acoustic_grand_piano', 'bright_acoustic_piano', 'electric_grand_piano', 'honky_tonk_piano',
  'electric_piano_1', 'electric_piano_2', 'harpsichord', 'clavinet',
  'celesta', 'glockenspiel', 'music_box', 'vibraphone', 'marimba', 'xylophone',
  'tubular_bells', 'dulcimer', 'drawbar_organ', 'percussive_organ', 'rock_organ',
  'church_organ', 'reed_organ', 'accordion', 'harmonica', 'tango_accordion',
  'acoustic_guitar_nylon', 'acoustic_guitar_steel', 'electric_guitar_jazz',
  'electric_guitar_clean', 'electric_guitar_muted', 'overdriven_guitar', 'distortion_guitar',
  'guitar_harmonics', 'acoustic_bass', 'electric_bass_finger', 'electric_bass_pick',
  'fretless_bass', 'slap_bass_1', 'slap_bass_2', 'synth_bass_1', 'synth_bass_2',
  'violin', 'viola', 'cello', 'contrabass', 'tremolo_strings', 'pizzicato_strings',
  'orchestral_harp', 'timpani', 'string_ensemble_1', 'string_ensemble_2',
  'synth_strings_1', 'synth_strings_2', 'choir_aahs', 'voice_oohs', 'synth_voice',
  'orchestra_hit', 'trumpet', 'trombone', 'tuba', 'muted_trumpet', 'french_horn',
  'brass_section', 'synth_brass_1', 'synth_brass_2', 'soprano_sax', 'alto_sax',
  'tenor_sax', 'baritone_sax', 'oboe', 'english_horn', 'bassoon', 'clarinet',
  'piccolo', 'flute', 'recorder', 'pan_flute', 'blown_bottle', 'shakuhachi',
  'whistle', 'ocarina', 'lead_1_square', 'lead_2_sawtooth', 'lead_3_calliope',
  'lead_4_chiff', 'lead_5_charang', 'lead_6_voice', 'lead_7_fifths', 'lead_8_bass_lead',
  'pad_1_new_age', 'pad_2_warm', 'pad_3_polysynth', 'pad_4_choir', 'pad_5_bowed',
  'pad_6_metallic', 'pad_7_halo', 'pad_8_sweep', 'fx_1_rain', 'fx_2_soundtrack',
  'fx_3_crystal', 'fx_4_atmosphere', 'fx_5_brightness', 'fx_6_goblins',
  'fx_7_echoes', 'fx_8_sci_fi', 'sitar', 'banjo', 'shamisen', 'koto', 'kalimba',
  'bag_pipe', 'fiddle', 'shanai', 'tinkle_bell', 'agogo', 'steel_drums', 'woodblock',
  'taiko_drum', 'melodic_tom', 'synth_drum', 'reverse_cymbal', 'guitar_fret_noise',
  'breath_noise', 'seashore', 'bird_tweet', 'telephone_ring', 'helicopter', 'applause',
  'gunshot',
] as const

const GENERAL_MIDI_PERCUSSION_NAMES: Readonly<Record<number, string>> = Object.freeze({
  35: 'acoustic_bass_drum', 36: 'bass_drum_1', 37: 'side_stick',
  38: 'acoustic_snare', 39: 'hand_clap', 40: 'electric_snare', 41: 'low_floor_tom',
  42: 'closed_hi_hat', 43: 'high_floor_tom', 44: 'pedal_hi_hat', 45: 'low_tom',
  46: 'open_hi_hat', 47: 'low_mid_tom', 48: 'hi_mid_tom', 49: 'crash_cymbal_1',
  50: 'high_tom', 51: 'ride_cymbal_1', 52: 'chinese_cymbal', 53: 'ride_bell',
  54: 'tambourine', 55: 'splash_cymbal', 56: 'cowbell', 57: 'crash_cymbal_2',
  58: 'vibraslap', 59: 'ride_cymbal_2', 60: 'hi_bongo', 61: 'low_bongo',
  62: 'mute_hi_conga', 63: 'open_hi_conga', 64: 'low_conga', 65: 'high_timbale',
  66: 'low_timbale', 67: 'high_agogo', 68: 'low_agogo', 69: 'cabasa', 70: 'maracas',
  71: 'short_whistle', 72: 'long_whistle', 73: 'short_guiro', 74: 'long_guiro',
  75: 'claves', 76: 'hi_wood_block', 77: 'low_wood_block', 78: 'mute_cuica',
  79: 'open_cuica', 80: 'mute_triangle', 81: 'open_triangle',
})

class MidiReader {
  offset = 0

  constructor(private readonly data: Uint8Array) {}

  get remaining(): number { return this.data.length - this.offset }

  private ensure(length: number): void {
    if (!Number.isInteger(length) || length < 0 || length > this.remaining) {
      throw new Error('Unexpected end of MIDI file')
    }
  }

  u8(): number {
    this.ensure(1)
    return this.data[this.offset++]
  }

  u16(): number {
    this.ensure(2)
    const value = (this.data[this.offset] << 8) | this.data[this.offset + 1]
    this.offset += 2
    return value
  }

  u32(): number {
    this.ensure(4)
    const value = (
      this.data[this.offset] * 0x1000000
      + (this.data[this.offset + 1] << 16)
      + (this.data[this.offset + 2] << 8)
      + this.data[this.offset + 3]
    )
    this.offset += 4
    return value
  }

  ascii(length: number): string {
    const bytes = this.bytes(length)
    return String.fromCharCode(...bytes)
  }

  bytes(length: number): Uint8Array {
    this.ensure(length)
    const value = this.data.subarray(this.offset, this.offset + length)
    this.offset += length
    return value
  }

  skip(length: number): void {
    this.ensure(length)
    this.offset += length
  }

  variableLength(): number {
    let value = 0
    for (let index = 0; index < 4; index++) {
      const byte = this.u8()
      value = value * 128 + (byte & 0x7f)
      if ((byte & 0x80) === 0) return value
    }
    throw new Error('Invalid MIDI variable-length quantity')
  }
}

interface ParseContext {
  eventCount: number
  noteCount: number
  totalTextBytes: number
  warnings: string[]
  tempoEvents: MidiTempoEvent[]
  timeSignatureEvents: MidiTimeSignatureEvent[]
}

interface ActiveNoteQueue {
  notes: MidiNote[]
  head: number
}

function inputBytes(input: ArrayBuffer | Uint8Array): Uint8Array {
  return input instanceof Uint8Array
    ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
    : new Uint8Array(input)
}

function fnv1a(bytes: Uint8Array): string {
  let hash = 0x811c9dc5
  for (const byte of bytes) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function decodeMidiText(bytes: Uint8Array): string {
  let value: string
  try {
    value = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }
  catch {
    value = new TextDecoder('windows-1252').decode(bytes)
  }
  return value.replace(/\0/g, '').trim()
}

function readDataByte(reader: MidiReader): number {
  const value = reader.u8()
  if (value >= 0x80) throw new Error(`Invalid MIDI data byte: 0x${value.toString(16)}`)
  return value
}

function parseMidiTrack(
  bytes: Uint8Array,
  trackIndex: number,
  context: ParseContext,
): MidiTrack {
  const reader = new MidiReader(bytes)
  const programs = new Uint8Array(16)
  const pitchBends = new Int16Array(16)
  const activeNotes = new Map<string, ActiveNoteQueue>()
  const notes: MidiNote[] = []
  const programChanges: MidiProgramChange[] = []
  const bendEvents: MidiPitchBendEvent[] = []
  const usedChannels = new Set<number>()
  let runningStatus: number | null = null
  let lastTick = 0
  let name = ''
  let instrumentName = ''
  let sawEndOfTrack = false
  let unmatchedNoteOffs = 0

  while (reader.remaining > 0) {
    const delta = reader.variableLength()
    const tick = lastTick + delta
    if (!Number.isSafeInteger(tick) || tick > MIDI_IMPORT_LIMITS.maxTick) {
      throw new Error(`MIDI tick exceeds ${MIDI_IMPORT_LIMITS.maxTick}`)
    }
    lastTick = tick
    context.eventCount++
    if (context.eventCount > MIDI_IMPORT_LIMITS.maxEvents) {
      throw new Error(`MIDI event count exceeds ${MIDI_IMPORT_LIMITS.maxEvents}`)
    }
    const order = context.eventCount
    const statusOrData = reader.u8()
    let status: number
    let firstData: number | undefined
    if (statusOrData < 0x80) {
      if (runningStatus === null) throw new Error('MIDI running status used before a channel status')
      status = runningStatus
      firstData = statusOrData
    }
    else {
      status = statusOrData
      if (status < 0xf0) runningStatus = status
      else runningStatus = null
    }

    if (status === 0xff) {
      const type = reader.u8()
      const length = reader.variableLength()
      const payload = reader.bytes(length)
      if (type >= 0x01 && type <= 0x09) {
        if (length > MIDI_IMPORT_LIMITS.maxTextEventBytes) {
          throw new Error(`MIDI text event exceeds ${MIDI_IMPORT_LIMITS.maxTextEventBytes} bytes`)
        }
        context.totalTextBytes += length
        if (context.totalTextBytes > MIDI_IMPORT_LIMITS.maxTotalTextBytes) {
          throw new Error(`MIDI text data exceeds ${MIDI_IMPORT_LIMITS.maxTotalTextBytes} bytes`)
        }
      }
      if (type === 0x2f) {
        if (length !== 0) throw new Error('Invalid MIDI end-of-track event')
        sawEndOfTrack = true
        break
      }
      if (type === 0x03 && !name) name = decodeMidiText(payload)
      else if (type === 0x04 && !instrumentName) instrumentName = decodeMidiText(payload)
      else if (type === 0x51) {
        if (length !== 3) throw new Error('Invalid MIDI tempo event')
        const microsecondsPerQuarter = payload[0] * 0x10000 + payload[1] * 0x100 + payload[2]
        if (microsecondsPerQuarter === 0) throw new Error('MIDI tempo must be greater than zero')
        context.tempoEvents.push({ tick, microsecondsPerQuarter, trackIndex, order })
      }
      else if (type === 0x58) {
        if (length !== 4) throw new Error('Invalid MIDI time-signature event')
        const denominator = 2 ** payload[1]
        if (!Number.isSafeInteger(denominator)) throw new Error('Invalid MIDI time-signature denominator')
        context.timeSignatureEvents.push({
          tick,
          numerator: payload[0],
          denominator,
          clocksPerMetronome: payload[2],
          thirtySecondsPerQuarter: payload[3],
          trackIndex,
          order,
        })
      }
      continue
    }

    if (status === 0xf0 || status === 0xf7) {
      reader.skip(reader.variableLength())
      continue
    }
    if (status >= 0xf0) throw new Error(`Unsupported MIDI system status: 0x${status.toString(16)}`)

    const eventType = status & 0xf0
    const channel = status & 0x0f
    usedChannels.add(channel)
    const first = firstData ?? readDataByte(reader)
    const second = eventType === 0xc0 || eventType === 0xd0 ? undefined : readDataByte(reader)
    if (eventType === 0xc0) {
      programs[channel] = first
      programChanges.push({ tick, channel, program: first, order })
      continue
    }
    if (eventType === 0xe0) {
      const value = first + (second ?? 0) * 128 - 8192
      pitchBends[channel] = value
      bendEvents.push({ tick, channel, value, order })
      continue
    }
    if (eventType !== 0x80 && eventType !== 0x90) continue

    const isNoteOn = eventType === 0x90 && (second ?? 0) > 0
    const key = `${channel}:${first}`
    if (isNoteOn) {
      if (context.noteCount >= MIDI_IMPORT_LIMITS.maxNotes) {
        throw new Error(`MIDI note count exceeds ${MIDI_IMPORT_LIMITS.maxNotes}`)
      }
      const note: MidiNote = {
        index: context.noteCount++,
        trackIndex,
        channel,
        note: first,
        velocity: second ?? 0,
        releaseVelocity: 0,
        startTick: tick,
        endTick: tick,
        program: programs[channel],
        startPitchBend: pitchBends[channel],
        startOrder: order,
        endOrder: order,
      }
      notes.push(note)
      const queue = activeNotes.get(key) ?? { notes: [], head: 0 }
      queue.notes.push(note)
      activeNotes.set(key, queue)
    }
    else {
      const queue = activeNotes.get(key)
      const note = queue?.notes[queue.head]
      if (!note) {
        unmatchedNoteOffs++
        continue
      }
      queue.head++
      note.endTick = tick
      note.endOrder = order
      note.releaseVelocity = second ?? 0
      if (queue.head >= queue.notes.length) activeNotes.delete(key)
    }
  }

  let unterminatedNotes = 0
  for (const queue of activeNotes.values()) {
    for (let index = queue.head; index < queue.notes.length; index++) {
      const note = queue.notes[index]
      note.endTick = Math.max(lastTick, note.startTick + 1)
      note.endOrder = context.eventCount
      unterminatedNotes++
    }
  }
  if (!sawEndOfTrack) context.warnings.push(`Track ${trackIndex + 1} has no end-of-track event.`)
  if (unmatchedNoteOffs) {
    context.warnings.push(`Track ${trackIndex + 1}: ignored ${unmatchedNoteOffs} unmatched note-off event(s).`)
  }
  if (unterminatedNotes) {
    context.warnings.push(`Track ${trackIndex + 1}: closed ${unterminatedNotes} unterminated note(s) at track end.`)
  }
  const channels = [...usedChannels].sort((a, b) => a - b)
  return {
    index: trackIndex,
    name,
    instrumentName,
    lastTick,
    channels,
    notes,
    programChanges,
    pitchBends: bendEvents,
  }
}

type MergedChannelEvent =
  | { kind: 'program', tick: number, order: number, channel: number, value: number }
  | { kind: 'bend', tick: number, order: number, channel: number, value: number }
  | { kind: 'note', tick: number, order: number, channel: number, note: MidiNote }

/** SMF format 1 tracks are simultaneous, so channel state is global after merging. */
function applyMergedChannelState(tracks: readonly MidiTrack[]): void {
  const events: MergedChannelEvent[] = []
  for (const track of tracks) {
    for (const event of track.programChanges) {
      events.push({
        kind: 'program', tick: event.tick, order: event.order,
        channel: event.channel, value: event.program,
      })
    }
    for (const event of track.pitchBends) {
      events.push({
        kind: 'bend', tick: event.tick, order: event.order,
        channel: event.channel, value: event.value,
      })
    }
    for (const note of track.notes) {
      events.push({
        kind: 'note', tick: note.startTick, order: note.startOrder,
        channel: note.channel, note,
      })
    }
  }
  events.sort((a, b) => a.tick - b.tick || a.order - b.order)
  const programs = new Uint8Array(16)
  const pitchBends = new Int16Array(16)
  for (const event of events) {
    if (event.kind === 'program') programs[event.channel] = event.value
    else if (event.kind === 'bend') pitchBends[event.channel] = event.value
    else {
      event.note.program = programs[event.channel]
      event.note.startPitchBend = pitchBends[event.channel]
    }
  }
}

export function parseMidi(input: ArrayBuffer | Uint8Array): MidiParseResult {
  try {
    const bytes = inputBytes(input)
    if (bytes.length === 0 || bytes.length > MIDI_IMPORT_LIMITS.maxBytes) {
      throw new Error(`MIDI file size must be between 1 and ${MIDI_IMPORT_LIMITS.maxBytes} bytes`)
    }
    const reader = new MidiReader(bytes)
    if (reader.ascii(4) !== 'MThd') throw new Error('Missing MIDI header chunk')
    const headerLength = reader.u32()
    if (headerLength < 6) throw new Error('Invalid MIDI header length')
    const format = reader.u16()
    const trackCount = reader.u16()
    const division = reader.u16()
    reader.skip(headerLength - 6)
    if (format === 2) throw new Error('MIDI format 2 is not supported; convert it to format 0 or 1 first')
    if (format !== 0 && format !== 1) throw new Error(`Unsupported MIDI format: ${format}`)
    if (trackCount < 1 || trackCount > MIDI_IMPORT_LIMITS.maxTracks) {
      throw new Error(`MIDI track count must be between 1 and ${MIDI_IMPORT_LIMITS.maxTracks}`)
    }
    if (format === 0 && trackCount !== 1) throw new Error('MIDI format 0 must contain exactly one track')
    if ((division & 0x8000) !== 0) {
      throw new Error('SMPTE-timed MIDI files are not supported; use PPQN timing')
    }
    if (division === 0) throw new Error('MIDI ticks-per-quarter must be greater than zero')

    const context: ParseContext = {
      eventCount: 0,
      noteCount: 0,
      totalTextBytes: 0,
      warnings: [],
      tempoEvents: [],
      timeSignatureEvents: [],
    }
    const tracks: MidiTrack[] = []
    for (let trackIndex = 0; trackIndex < trackCount; trackIndex++) {
      if (reader.ascii(4) !== 'MTrk') throw new Error(`Missing MIDI track chunk ${trackIndex + 1}`)
      const trackLength = reader.u32()
      tracks.push(parseMidiTrack(reader.bytes(trackLength), trackIndex, context))
    }
    applyMergedChannelState(tracks)
    if (reader.remaining > 0) {
      context.warnings.push(`Ignored ${reader.remaining} trailing byte(s) after the declared MIDI tracks.`)
    }
    return {
      ok: true,
      song: {
        header: { format, trackCount, ticksPerQuarter: division },
        tracks,
        tempoEvents: context.tempoEvents,
        timeSignatureEvents: context.timeSignatureEvents,
        fingerprint: fnv1a(bytes),
      },
      warnings: context.warnings,
    }
  }
  catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function compareTimedEvents(
  a: Pick<MidiTempoEvent, 'tick' | 'trackIndex' | 'order'>,
  b: Pick<MidiTempoEvent, 'tick' | 'trackIndex' | 'order'>,
): number {
  return a.tick - b.tick || a.trackIndex - b.trackIndex || a.order - b.order
}

/** Builds a piecewise tempo map with an implicit 120 BPM segment at tick zero. */
export function buildMidiTempoMap(song: MidiSong): MidiTempoSegment[] {
  const ticksPerQuarter = song.header.ticksPerQuarter
  if (!Number.isInteger(ticksPerQuarter) || ticksPerQuarter <= 0) {
    throw new Error('MIDI ticks-per-quarter must be greater than zero')
  }
  const segments: MidiTempoSegment[] = [{
    tick: 0,
    seconds: 0,
    microsecondsPerQuarter: DEFAULT_TEMPO_US_PER_QUARTER,
  }]
  const events = [...song.tempoEvents].sort(compareTimedEvents)
  for (const event of events) {
    if (
      !Number.isInteger(event.tick) || event.tick < 0
      || !Number.isInteger(event.microsecondsPerQuarter)
      || event.microsecondsPerQuarter <= 0
      || event.microsecondsPerQuarter > 0xff_ffff
    ) throw new Error('Invalid MIDI tempo map')
    const previous = segments[segments.length - 1]
    const seconds = previous.seconds
      + (event.tick - previous.tick) * previous.microsecondsPerQuarter
      / 1_000_000 / ticksPerQuarter
    if (event.tick === previous.tick) previous.microsecondsPerQuarter = event.microsecondsPerQuarter
    else segments.push({ tick: event.tick, seconds, microsecondsPerQuarter: event.microsecondsPerQuarter })
  }
  return segments
}

function tickToSeconds(
  tick: number,
  ticksPerQuarter: number,
  segments: readonly MidiTempoSegment[],
): number {
  let low = 0
  let high = segments.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (segments[middle].tick <= tick) low = middle
    else high = middle - 1
  }
  const segment = segments[low]
  return segment.seconds
    + (tick - segment.tick) * segment.microsecondsPerQuarter
    / 1_000_000 / ticksPerQuarter
}

/** Converts a source tick through the complete tempo map, including tempo changes. */
export function midiTickToSeconds(song: MidiSong, tick: number): number {
  if (!Number.isFinite(tick) || tick < 0) throw new Error('MIDI tick must be a non-negative number')
  return tickToSeconds(tick, song.header.ticksPerQuarter, buildMidiTempoMap(song))
}

function zeroPad(value: number, width: number): string {
  return Math.max(0, Math.round(value)).toString().padStart(width, '0')
}

export function generalMidiSoundId(program: number): string {
  const normalized = Math.max(0, Math.min(127, Math.round(program)))
  const name = GENERAL_MIDI_PROGRAM_NAMES[normalized] ?? `program_${normalized}`
  return `midi:gm/${zeroPad(normalized, 3)}_${name}`
}

export function generalMidiPercussionSoundId(note: number): string {
  const normalized = Math.max(0, Math.min(127, Math.round(note)))
  const name = GENERAL_MIDI_PERCUSSION_NAMES[normalized] ?? `note_${normalized}`
  return `midi:drum/${zeroPad(normalized, 3)}_${name}`
}

const GM_MINECRAFT_FAMILY_SOUND_IDS = [
  'block.note_block.harp',
  'block.note_block.xylophone',
  'block.note_block.flute',
  'block.note_block.guitar',
  'block.note_block.bass',
  'block.note_block.harp',
  'block.note_block.harp',
  'block.note_block.didgeridoo',
  'block.note_block.flute',
  'block.note_block.flute',
  'block.note_block.bit',
  'block.note_block.chime',
  'block.note_block.bit',
  'block.note_block.banjo',
  'block.note_block.cow_bell',
  'block.note_block.bit',
] as const

/** Maps a General MIDI program onto the vanilla note-block palette. */
export function generalMidiMinecraftSoundId(program: number): string {
  const normalized = Math.max(0, Math.min(127, Math.round(program)))
  if (normalized === 8 || normalized === 9) return 'block.note_block.bell'
  if (normalized === 10) return 'block.note_block.chime'
  if (normalized === 11) return 'block.note_block.iron_xylophone'
  if (normalized >= 12 && normalized <= 15) return 'block.note_block.xylophone'
  return GM_MINECRAFT_FAMILY_SOUND_IDS[Math.floor(normalized / 8)]
}

/** Maps GM percussion keys onto Minecraft percussion and chromatic instruments. */
export function generalMidiPercussionMinecraftSoundId(note: number): string {
  const normalized = Math.max(0, Math.min(127, Math.round(note)))
  if (normalized === 35 || normalized === 36) return 'block.note_block.basedrum'
  if ([37, 38, 39, 40].includes(normalized)) return 'block.note_block.snare'
  if ([42, 44, 46, 49, 51, 52, 55, 57, 59].includes(normalized)) return 'block.note_block.hat'
  if (normalized >= 41 && normalized <= 50) return 'block.note_block.basedrum'
  if ([53, 56, 58, 60, 62, 64, 67, 68, 69, 70, 73, 75, 76, 77].includes(normalized)) {
    return 'block.note_block.cow_bell'
  }
  return 'block.note_block.xylophone'
}

function titleFromSlug(slug: string): string {
  return slug.split('_').map(part => part ? part[0].toUpperCase() + part.slice(1) : '').join(' ')
}

function clampedPitch(note: number, bend: number, rootNote = 60): { value: number, clipped: boolean } {
  const bendSemitones = bend / 8192 * MIDI_PITCH_BEND_RANGE_SEMITONES
  const raw = 2 ** ((note - rootNote + bendSemitones) / 12)
  const value = Math.max(MIN_MARKER_PITCH, Math.min(MAX_MARKER_PITCH, raw))
  return { value, clipped: Math.abs(value - raw) > 1e-9 }
}

function nearestTimelineDenominator(value: number): 2 | 4 | 8 | 16 {
  const supported = [2, 4, 8, 16] as const
  return supported.reduce((nearest, candidate) => (
    Math.abs(Math.log2(candidate) - Math.log2(Math.max(1, value)))
    < Math.abs(Math.log2(nearest) - Math.log2(Math.max(1, value)))
      ? candidate
      : nearest
  ))
}

export interface MidiTimelineTempoMapResult {
  events: TempoMapEvent[]
  warnings: string[]
}

function midiTempoSegmentAtTick(
  tick: number,
  segments: readonly MidiTempoSegment[],
): MidiTempoSegment {
  let low = 0
  let high = segments.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (segments[middle].tick <= tick) low = middle
    else high = middle - 1
  }
  return segments[low]
}

/** Maps MIDI conductor events onto the already integrated, fixed 20 TPS timeline. */
export function buildMidiTimelineTempoMap(song: MidiSong): MidiTimelineTempoMapResult {
  const segments = buildMidiTempoMap(song)
  const signatures = [...song.timeSignatureEvents].sort(compareTimedEvents)
  const clampBpm = (microsecondsPerQuarter: number): number => Math.max(
    MIN_TEMPO_BPM,
    Math.min(MAX_TEMPO_BPM, 60_000_000 / microsecondsPerQuarter),
  )
  const eventByTick = new Map<number, TempoMapEvent>()
  let clampedTempoCount = 0
  let mappedMeterCount = 0
  for (const segment of segments) {
    const rawBpm = 60_000_000 / segment.microsecondsPerQuarter
    const bpm = clampBpm(segment.microsecondsPerQuarter)
    if (Math.abs(rawBpm - bpm) > 1e-9) clampedTempoCount++
    const tick = Math.max(0, Math.round(segment.seconds * 20))
    eventByTick.set(tick, { tick, bpm })
  }
  for (const signature of signatures) {
    const tick = Math.max(0, Math.round(tickToSeconds(
      signature.tick,
      song.header.ticksPerQuarter,
      segments,
    ) * 20))
    const meter = {
      numerator: Math.max(1, Math.min(16, signature.numerator)),
      denominator: nearestTimelineDenominator(signature.denominator),
    }
    if (meter.numerator !== signature.numerator || meter.denominator !== signature.denominator) {
      mappedMeterCount++
    }
    const activeTempo = midiTempoSegmentAtTick(signature.tick, segments)
    const previous = eventByTick.get(tick)
    eventByTick.set(tick, {
      tick,
      bpm: previous?.bpm ?? clampBpm(activeTempo.microsecondsPerQuarter),
      meter,
    })
  }
  const initial = eventByTick.get(0)
  const fallback = {
    bpm: initial?.bpm ?? DEFAULT_SETTINGS.bpm,
    timeSignature: initial?.meter ?? DEFAULT_SETTINGS.timeSignature,
  }
  const events = normalizeTempoMap([...eventByTick.values()], fallback)
  const collapsedCount = Math.max(0, segments.length + signatures.length - eventByTick.size)
  return {
    events,
    warnings: [
      ...(clampedTempoCount
        ? [`${clampedTempoCount} MIDI tempo event(s) were clamped to Knead's ${MIN_TEMPO_BPM}–${MAX_TEMPO_BPM} BPM range.`]
        : []),
      ...(mappedMeterCount
        ? [`${mappedMeterCount} MIDI time-signature event(s) were mapped to Knead's supported meter range.`]
        : []),
      ...(collapsedCount
        ? [`${collapsedCount} MIDI conductor event(s) shared a 20 TPS tick and were merged.`]
        : []),
    ],
  }
}

interface ChannelTrack {
  source: MidiTrack
  channel: number
  track: Track
}

function timelineTrackSource(source: MidiTrack): NonNullable<Track['source']> {
  return {
    format: 'midi',
    index: source.index,
    name: source.name,
    instrumentName: source.instrumentName,
    lastTick: source.lastTick,
    channels: [...source.channels],
    programChanges: source.programChanges.map(event => ({ ...event })),
    pitchBends: source.pitchBends.map(event => ({ ...event })),
  }
}

function makeTrackName(source: MidiTrack, channel: number): string {
  const channelNotes = source.notes.filter(note => note.channel === channel)
  const sourceName = source.name.trim() || source.instrumentName.trim()
  const programs = Array.from(new Set([
    ...channelNotes.map(note => note.program),
    ...source.programChanges.filter(event => event.channel === channel).map(event => event.program),
  ]))
  const fallback = channel === 9
    ? 'Drums'
    : programs.length === 1
      ? titleFromSlug(GENERAL_MIDI_PROGRAM_NAMES[programs[0]] ?? `program_${programs[0]}`)
      : `MIDI Track ${source.index + 1}`
  const base = sourceName || fallback
  return source.channels.length > 1 ? `${base} · Ch ${channel + 1}` : base
}

const MIDI_SOUND_OVERRIDE_PATTERN = /^(?:[a-z0-9_.-]+:)?[a-z0-9_./-]+$/u

function normalizeChannelSoundOverrides(
  source: MidiConversionOptions['channelSoundOverrides'],
): { values: Map<number, string>, invalidCount: number } {
  const values = new Map<number, string>()
  let invalidCount = 0
  for (let channel = 0; channel < 16; channel++) {
    const raw = source?.[channel]
    if (raw === undefined || raw.trim() === '') continue
    const value = raw.trim()
    if (value.length > 256 || !MIDI_SOUND_OVERRIDE_PATTERN.test(value)) invalidCount++
    else values.set(channel, value)
  }
  return { values, invalidCount }
}

interface NormalizedMidiTailFade {
  enabled: boolean
  startPercent: number
  endPercent: number
  normalizedValueCount: number
}

function normalizeMidiTailFade(source: MidiConversionOptions['tailFade']): NormalizedMidiTailFade {
  let normalizedValueCount = 0
  const normalizePercent = (value: number | undefined): number => {
    if (value === undefined) return 50
    if (!Number.isFinite(value)) {
      normalizedValueCount++
      return 50
    }
    const normalized = Math.max(0, Math.min(100, Math.round(value)))
    if (normalized !== value) normalizedValueCount++
    return normalized
  }
  return {
    enabled: source?.enabled === true,
    startPercent: normalizePercent(source?.startPercent),
    endPercent: normalizePercent(source?.endPercent),
    normalizedValueCount,
  }
}

function midiTailFadePercentAt(
  tailOffset: number,
  tailCount: number,
  startPercent: number,
  endPercent: number,
): number {
  if (tailCount <= 1) return startPercent
  return startPercent + (endPercent - startPercent) * ((tailOffset - 1) / (tailCount - 1))
}

function midiTailFadeVolume(headVolume: number, percent: number): number {
  return Math.max(0, Math.min(1, headVolume * percent / 100))
}

/**
 * OpenNBS emits alternating tail notes every tick. Two parity markers reproduce
 * that schedule and pan with constant, bounded (two-keyframe) automation.
 */
function createMidiTailFadeParityMarker(
  head: Marker,
  firstOffset: 1 | 2,
  tailCount: number,
  startPercent: number,
  endPercent: number,
): Marker | null {
  if (tailCount < firstOffset) return null
  const firingCount = Math.floor((tailCount - firstOffset) / 2) + 1
  const lastOffset = firstOffset + (firingCount - 1) * 2
  const firstVolume = midiTailFadeVolume(
    head.volume,
    midiTailFadePercentAt(firstOffset, tailCount, startPercent, endPercent),
  )
  const tail: Marker = {
    ...head,
    id: `${head.id}-tail-${firstOffset === 1 ? 'left' : 'right'}`,
    tick: head.tick + firstOffset,
    volume: firstVolume,
    pan: firstOffset === 1 ? -0.5 : 0.5,
    gateTicks: undefined,
    duration: undefined,
    retriggerInterval: undefined,
    volumeCurve: undefined,
  }
  if (firingCount > 1) {
    const duration = lastOffset - firstOffset
    tail.duration = duration
    tail.retriggerInterval = 2
    tail.volumeCurve = {
      keyframes: [
        { tick: 0, value: firstVolume, interpolation: 'linear' },
        {
          tick: duration,
          value: midiTailFadeVolume(
            head.volume,
            midiTailFadePercentAt(lastOffset, tailCount, startPercent, endPercent),
          ),
          interpolation: 'linear',
        },
      ],
    }
  }
  return tail
}

function quantizeMidiTimelineTick(exactTick: number, step: MidiQuantizeStep): number {
  const base = Math.round(exactTick)
  return step > 1 ? Math.round(base / step) * step : base
}

interface QuantizedMidiInterval {
  key: string
  baseStart: number
  baseEnd: number
  start: number
  end: number
}

function countIntroducedMidiOverlaps(intervals: QuantizedMidiInterval[]): number {
  const byKey = new Map<string, QuantizedMidiInterval[]>()
  for (const interval of intervals) {
    const group = byKey.get(interval.key) ?? []
    group.push(interval)
    byKey.set(interval.key, group)
  }
  let count = 0
  for (const group of byKey.values()) {
    group.sort((left, right) => left.baseStart - right.baseStart || left.baseEnd - right.baseEnd)
    for (let index = 1; index < group.length; index++) {
      const previous = group[index - 1]
      const current = group[index]
      if (current.baseStart >= previous.baseEnd && current.start < previous.end) count++
    }
  }
  return count
}

function countOverlappingMidiIntervals(
  intervals: readonly Pick<QuantizedMidiInterval, 'key' | 'start' | 'end'>[],
): number {
  const byKey = new Map<string, Array<Pick<QuantizedMidiInterval, 'start' | 'end'>>>()
  for (const interval of intervals) {
    const group = byKey.get(interval.key) ?? []
    group.push(interval)
    byKey.set(interval.key, group)
  }
  let count = 0
  for (const group of byKey.values()) {
    group.sort((left, right) => left.start - right.start || left.end - right.end)
    let furthestEnd = -1
    for (const interval of group) {
      if (interval.start < furthestEnd) count++
      furthestEnd = Math.max(furthestEnd, interval.end)
    }
  }
  return count
}

/**
 * Converts an already parsed SMF into Knead's integer 20 TPS timeline.
 * Paired MIDI note-on/off events become first-class wall-clock marker gates.
 * Source heads never reuse `duration`; OpenNBS tail fade uses separate bounded
 * derived markers whose `duration` explicitly represents their retrigger span.
 */
export function midiToTimelineState(
  song: MidiSong,
  targetVersion = '',
  options: MidiConversionOptions = {},
): MidiConversionResult {
  const tempoMap = buildMidiTempoMap(song)
  const ticksPerQuarter = song.header.ticksPerQuarter
  const soundMapping = options.soundMapping ?? 'gm-identifiers'
  const quantizeStep = MIDI_QUANTIZE_STEPS.includes(options.quantizeStep ?? 0)
    ? options.quantizeStep ?? 0
    : 0
  const noteLengthMode = options.noteLengthMode === 'single-shot' ? 'single-shot' : 'note-off-gate'
  const tailFade = normalizeMidiTailFade(options.tailFade)
  const channelOverrides = normalizeChannelSoundOverrides(options.channelSoundOverrides)
  const warnings: string[] = []
  if (channelOverrides.invalidCount) {
    warnings.push(`${channelOverrides.invalidCount} invalid MIDI channel sound override(s) were ignored.`)
  }
  if (tailFade.normalizedValueCount) {
    warnings.push(`${tailFade.normalizedValueCount} MIDI tail-fade percentage value(s) were rounded and clamped to 0..100.`)
  }
  const sourceNoteCount = song.tracks.reduce((count, track) => count + track.notes.length, 0)
  if (sourceNoteCount > MIDI_IMPORT_LIMITS.maxTimelineMarkers) {
    throw new Error(`MIDI note heads exceed the ${MIDI_IMPORT_LIMITS.maxTimelineMarkers} marker budget`)
  }
  let remainingTailMarkerBudget = MIDI_IMPORT_LIMITS.maxTimelineMarkers - sourceNoteCount
  const timelineTempoMap = buildMidiTimelineTempoMap(song)
  warnings.push(...timelineTempoMap.warnings)
  const channelTracks: ChannelTrack[] = []

  for (const source of song.tracks) {
    const preserveEmptyTrack = source.channels.length === 0 && Boolean(
      source.name || source.instrumentName || source.programChanges.length || source.pitchBends.length,
    )
    if (preserveEmptyTrack) {
      const id = `midi-${song.fingerprint}-track-${source.index}-control`
      const track = {
        ...createDefaultTrack(id, channelTracks.length),
        name: source.name.trim() || source.instrumentName.trim() || `MIDI Track ${source.index + 1}`,
        color: TRACK_COLORS[channelTracks.length % TRACK_COLORS.length],
        collapsed: true,
        source: timelineTrackSource(source),
      }
      channelTracks.push({ source, channel: -1, track })
    }
    for (const channel of source.channels) {
      if (channelTracks.length >= MIDI_IMPORT_LIMITS.maxTimelineTracks) {
        throw new Error(`MIDI import exceeds ${MIDI_IMPORT_LIMITS.maxTimelineTracks} timeline tracks`)
      }
      const id = `midi-${song.fingerprint}-track-${source.index}-channel-${channel}`
      const track = {
        ...createDefaultTrack(id, channelTracks.length),
        name: makeTrackName(source, channel),
        color: TRACK_COLORS[channelTracks.length % TRACK_COLORS.length],
        source: timelineTrackSource(source),
      }
      channelTracks.push({ source, channel, track })
    }
  }
  if (channelTracks.length === 0) {
    const source = song.tracks[0]
    const id = `midi-${song.fingerprint}-track-0-channel-0`
    const track = createDefaultTrack(id)
    track.name = source?.name.trim() || source?.instrumentName.trim() || 'MIDI Track 1'
    if (source) track.source = timelineTrackSource(source)
    channelTracks.push({ source: source ?? {
      index: 0,
      name: '',
      instrumentName: '',
      lastTick: 0,
      channels: [],
      notes: [],
      programChanges: [],
      pitchBends: [],
    }, channel: 0, track })
    warnings.push('The MIDI file contains no note events.')
  }

  let clippedPitchCount = 0
  let quantizedStartCount = 0
  let gridQuantizedStartCount = 0
  let gridQuantizedGateCount = 0
  let zeroGateClampCount = 0
  let notesWithGateLength = 0
  let clampedTimelineNoteCount = 0
  let notesWithPitchBend = 0
  let tailFadeAppliedNoteCount = 0
  let tailFadeDerivedMarkerCount = 0
  let tailFadeFiringCount = 0
  let tailFadeSingleTailNoteCount = 0
  let tailFadeZeroTailNoteCount = 0
  let tailFadePercussionNoteCount = 0
  let tailFadeOmittedNoteCount = 0
  let tailFadeOmittedMarkerCount = 0
  let tailFadeOmittedFiringCount = 0
  const markers: Marker[] = []
  const quantizedIntervals: QuantizedMidiInterval[] = []
  const tailFadeIntervals: QuantizedMidiInterval[] = []
  let latestNoteEndTick = 0
  for (const entry of channelTracks) {
    const notes = entry.source.notes.filter(note => note.channel === entry.channel)
    for (const note of notes) {
      const exactStart = tickToSeconds(note.startTick, ticksPerQuarter, tempoMap) * 20
      const exactEnd = tickToSeconds(note.endTick, ticksPerQuarter, tempoMap) * 20
      const baseTimelineTick = Math.max(0, Math.round(exactStart))
      const rawTimelineTick = Math.max(0, quantizeMidiTimelineTick(exactStart, quantizeStep))
      const timelineTick = Math.min(MIDI_IMPORT_LIMITS.maxTimelineTicks - 1, rawTimelineTick)
      const baseEndTick = Math.round(exactEnd)
      const rawEndTick = quantizeMidiTimelineTick(exactEnd, quantizeStep)
      const maximumGateWithinTimeline = MIDI_IMPORT_LIMITS.maxTimelineTicks - timelineTick
      const requestedGate = Math.max(1, rawEndTick - timelineTick)
      const rawGridGate = Math.max(1, rawEndTick - rawTimelineTick)
      const gateTicks = Math.min(MAX_GATE_TICKS, maximumGateWithinTimeline, requestedGate)
      if (timelineTick !== rawTimelineTick || gateTicks !== requestedGate) clampedTimelineNoteCount++
      if (rawTimelineTick !== baseTimelineTick) gridQuantizedStartCount++
      const baseGate = Math.max(1, baseEndTick - baseTimelineTick)
      if (rawGridGate !== baseGate) gridQuantizedGateCount++
      if (
        rawEndTick <= rawTimelineTick
        && baseEndTick > baseTimelineTick
      ) zeroGateClampCount++
      latestNoteEndTick = Math.max(
        latestNoteEndTick,
        Math.min(MIDI_IMPORT_LIMITS.maxTimelineTicks, timelineTick + gateTicks),
      )
      if (Math.abs(baseTimelineTick - exactStart) > 1e-6) quantizedStartCount++
      if (note.endTick > note.startTick) notesWithGateLength++
      if (note.startPitchBend !== 0) notesWithPitchBend++
      const isPercussion = note.channel === 9
      const pitch = isPercussion
        ? { value: 1, clipped: false }
        : clampedPitch(note.note, note.startPitchBend, soundMapping === 'minecraft' ? 66 : 60)
      if (pitch.clipped) clippedPitchCount++
      const overrideSoundId = channelOverrides.values.get(note.channel)
      const headMarker: Marker = {
        id: `midi-${song.fingerprint}-note-${note.index}`,
        trackId: entry.track.id,
        tick: timelineTick,
        soundId: overrideSoundId ?? (isPercussion
          ? soundMapping === 'minecraft'
            ? generalMidiPercussionMinecraftSoundId(note.note)
            : generalMidiPercussionSoundId(note.note)
          : soundMapping === 'minecraft'
            ? generalMidiMinecraftSoundId(note.program)
            : generalMidiSoundId(note.program)),
        variantIndex: -1,
        volume: note.velocity / 127,
        pitch: pitch.value,
        pan: 0,
        gateTicks: noteLengthMode === 'note-off-gate' ? gateTicks : undefined,
        laneY: snapLaneY(1 - note.note / 127),
        source: { format: 'midi', ...note },
      }
      markers.push(headMarker)
      if (tailFade.enabled && noteLengthMode === 'note-off-gate') {
        const tailCount = Math.max(0, gateTicks - 1)
        if (isPercussion) {
          if (tailCount > 0) tailFadePercussionNoteCount++
        }
        else if (tailCount === 0) tailFadeZeroTailNoteCount++
        else {
          const requiredMarkers = tailCount > 1 ? 2 : 1
          if (remainingTailMarkerBudget < requiredMarkers) {
            tailFadeOmittedNoteCount++
            tailFadeOmittedMarkerCount += requiredMarkers
            tailFadeOmittedFiringCount += tailCount
          }
          else {
            const left = createMidiTailFadeParityMarker(
              headMarker, 1, tailCount, tailFade.startPercent, tailFade.endPercent,
            )
            const right = createMidiTailFadeParityMarker(
              headMarker, 2, tailCount, tailFade.startPercent, tailFade.endPercent,
            )
            const tailMarkers = [left, right].filter((marker): marker is Marker => marker !== null)
            markers.push(...tailMarkers)
            remainingTailMarkerBudget -= tailMarkers.length
            tailFadeAppliedNoteCount++
            tailFadeDerivedMarkerCount += tailMarkers.length
            tailFadeFiringCount += tailCount
            if (tailCount === 1) tailFadeSingleTailNoteCount++
            tailFadeIntervals.push({
              key: `${entry.track.id}:${note.note}`,
              baseStart: baseTimelineTick,
              baseEnd: baseTimelineTick + baseGate,
              start: timelineTick,
              end: timelineTick + gateTicks,
            })
          }
        }
      }
      if (noteLengthMode === 'note-off-gate') {
        quantizedIntervals.push({
          key: `${entry.track.id}:${note.note}`,
          baseStart: baseTimelineTick,
          baseEnd: baseTimelineTick + baseGate,
          start: timelineTick,
          end: timelineTick + gateTicks,
        })
      }
    }
  }
  markers.sort((a, b) => a.tick - b.tick || a.id.localeCompare(b.id))
  if (markers.length === 0 && !warnings.some(warning => /no note events/i.test(warning))) {
    warnings.push('The MIDI file contains no note events.')
  }
  if (tailFade.enabled && noteLengthMode === 'single-shot') {
    warnings.push('MIDI tail fade was not applied in single-shot mode; OpenNBS 3.12 enables Fade tail velocity only with Note Duration.')
  }
  else if (tailFade.enabled) {
    if (tailFadeAppliedNoteCount) {
      warnings.push(`${tailFadeAppliedNoteCount} melodic MIDI note tail(s) were represented by ${tailFadeDerivedMarkerCount} bounded parity marker(s) and ${tailFadeFiringCount} per-tick tail firing(s).`)
      warnings.push('OpenNBS 3.12 floors every tail velocity to an integer percent. Knead preserves the schedule and alternating -0.5/+0.5 pan with editable linear parity curves, so intermediate velocity rounding can differ by less than 1%.')
    }
    if (tailFadeSingleTailNoteCount) {
      warnings.push(`${tailFadeSingleTailNoteCount} one-tick MIDI tail(s) used only Start velocity; End is unused, matching OpenNBS 3.12.`)
    }
    if (tailFadeZeroTailNoteCount) {
      warnings.push(`${tailFadeZeroTailNoteCount} melodic MIDI note(s) had no tail after quantization/clamping, so their head velocity was left unchanged.`)
    }
    if (tailFadePercussionNoteCount) {
      warnings.push(`${tailFadePercussionNoteCount} percussion note tail(s) were excluded from velocity fade, matching OpenNBS 3.12.`)
    }
    const overlappingTailCount = countOverlappingMidiIntervals(tailFadeIntervals)
    if (overlappingTailCount) {
      warnings.push(`${overlappingTailCount} tail-faded same-pitch MIDI note(s) overlap an earlier tail and remain separate retriggering voices.`)
    }
    if (tailFadeOmittedNoteCount) {
      warnings.push(`${tailFadeOmittedMarkerCount} derived marker(s) covering ${tailFadeOmittedFiringCount} tail firing(s) from ${tailFadeOmittedNoteCount} MIDI note(s) were omitted at the ${MIDI_IMPORT_LIMITS.maxTimelineMarkers}-marker safety budget.`)
    }
  }

  const sourceEndTick = song.tracks.reduce((latest, track) => Math.max(latest, track.lastTick), 0)
  const exactTimelineEnd = tickToSeconds(sourceEndTick, ticksPerQuarter, tempoMap) * 20
  const rawRequestedLength = Math.max(1, latestNoteEndTick, Math.ceil(exactTimelineEnd))
  if (!Number.isSafeInteger(rawRequestedLength)) throw new Error('MIDI duration is not a safe timeline value')
  const requestedLength = Math.min(MIDI_IMPORT_LIMITS.maxTimelineTicks, rawRequestedLength)

  const settings = structuredClone(DEFAULT_SETTINGS)
  settings.bpm = timelineTempoMap.events[0].bpm
  settings.timeSignature = { ...timelineTempoMap.events[0].meter! }
  if (timelineTempoMap.events.length > 1) {
    warnings.push('MIDI tempo and time-signature changes were imported onto Knead\'s first-class 20 TPS tempo map.')
  }
  if (quantizedStartCount) {
    warnings.push(`${quantizedStartCount} note start(s) were quantized to Minecraft's 20 TPS grid.`)
  }
  if (quantizeStep > 1 && gridQuantizedStartCount) {
    warnings.push(`${gridQuantizedStartCount} note start(s) moved on the ${quantizeStep}-tick preview grid.`)
  }
  if (quantizeStep > 1 && gridQuantizedGateCount && noteLengthMode === 'note-off-gate') {
    warnings.push(`${gridQuantizedGateCount} note gate(s) changed on the ${quantizeStep}-tick preview grid.`)
  }
  if (quantizeStep > 1 && zeroGateClampCount && noteLengthMode === 'note-off-gate') {
    warnings.push(`${zeroGateClampCount} quantized note gate(s) collapsed to zero and were clamped to 1 tick.`)
  }
  const introducedOverlapCount = quantizeStep > 1 && noteLengthMode === 'note-off-gate'
    ? countIntroducedMidiOverlaps(quantizedIntervals)
    : 0
  if (introducedOverlapCount) {
    warnings.push(`${introducedOverlapCount} new same-pitch overlap(s) were introduced by quantization.`)
  }
  if (notesWithGateLength && noteLengthMode === 'note-off-gate') {
    warnings.push(`${notesWithGateLength} MIDI note-off length(s) were imported as wall-clock marker gates on the original heads; head retrigger duration remains unchanged.`)
  }
  else if (notesWithGateLength) {
    warnings.push(`${notesWithGateLength} MIDI note-off length(s) were omitted by single-shot note-length mode.`)
  }
  if (clampedTimelineNoteCount || rawRequestedLength > MIDI_IMPORT_LIMITS.maxTimelineTicks) {
    warnings.push(`${Math.max(clampedTimelineNoteCount, 1)} MIDI note gate(s) outside the safe timeline were clamped to ${MIDI_IMPORT_LIMITS.maxTimelineTicks} ticks.`)
  }
  if (clippedPitchCount) {
    warnings.push(`${clippedPitchCount} pitched note(s) outside Knead's safe ${MIN_MARKER_PITCH}..${MAX_MARKER_PITCH} DAW playback range were clamped.`)
  }
  const hasAnyPitchBend = song.tracks.some(track => track.pitchBends.some(event => event.value !== 0))
  if (hasAnyPitchBend || notesWithPitchBend) {
    warnings.push('Pitch bend at note-on uses the General MIDI ±2-semitone default; later bend events remain in the parsed MidiSong.')
  }
  if (markers.length && soundMapping === 'gm-identifiers') {
    warnings.push('General MIDI instruments use stable midi: sound IDs and need matching sounds for preview/export.')
  }
  if (markers.length && soundMapping === 'minecraft') {
    warnings.push('General MIDI programs were mapped onto the vanilla Minecraft note-block palette; original programs remain in source metadata.')
  }

  const tracks = channelTracks.map(entry => entry.track)
  const lengthTicks = Math.min(
    MIDI_IMPORT_LIMITS.maxTimelineTicks,
    getTimelineLengthTicks(markers, requestedLength, settings, [], timelineTempoMap.events),
  )
  const state: TimelineState = {
    projectId: `midi-${song.fingerprint}`,
    randomSeed: Number.parseInt(song.fingerprint, 16) >>> 0,
    targetVersion,
    lengthTicks,
    settings,
    master: { ...DEFAULT_MASTER },
    tracks,
    markers,
    tempoMap: timelineTempoMap.events,
    source: {
      format: 'midi',
      sourceFormat: song.header.format,
      ticksPerQuarter: song.header.ticksPerQuarter,
      fingerprint: song.fingerprint,
      tempoEvents: song.tempoEvents.map(event => ({ ...event })),
      timeSignatureEvents: song.timeSignatureEvents.map(event => ({ ...event })),
    },
  }
  state.settings.loop.endTick = Math.min(lengthTicks, Math.max(1, requestedLength))
  return { state, warnings }
}

/** Parse and convert in one call for file-picker/dialog integrations. */
export function importMidi(
  input: ArrayBuffer | Uint8Array,
  targetVersion = '',
  options: MidiConversionOptions = {},
): MidiImportResult {
  const parsed = parseMidi(input)
  if (!parsed.ok) return parsed
  try {
    const converted = midiToTimelineState(parsed.song, targetVersion, options)
    return {
      ok: true,
      song: parsed.song,
      state: converted.state,
      warnings: [...parsed.warnings, ...converted.warnings],
    }
  }
  catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
