import { describe, expect, it } from 'vitest'
import {
  MAX_LIVE_MIDI_TIMESTAMP_MS,
  decodeLiveMidiMessage,
  normalizeLiveMidiTimestampMs,
} from './useLiveMidi'

describe('decodeLiveMidiMessage', () => {
  it('decodes note on and velocity-zero note off', () => {
    expect(decodeLiveMidiMessage([0x92, 60, 127])).toEqual({
      type: 'note-on', channel: 2, note: 60, velocity: 1, timestampMs: 0,
    })
    expect(decodeLiveMidiMessage([0x92, 60, 0])).toEqual({
      type: 'note-off', channel: 2, note: 60, velocity: 0, timestampMs: 0,
    })
  })

  it('normalizes pitch bend at both endpoints and center', () => {
    expect(decodeLiveMidiMessage([0xe0, 0, 0])).toEqual({ type: 'pitch-bend', channel: 0, value: -1, timestampMs: 0 })
    expect(decodeLiveMidiMessage([0xe0, 0, 64])).toEqual({ type: 'pitch-bend', channel: 0, value: 0, timestampMs: 0 })
    expect(decodeLiveMidiMessage([0xe0, 127, 127])).toEqual({ type: 'pitch-bend', channel: 0, value: 1, timestampMs: 0 })
  })

  it('decodes sustain pedal and ignores unsupported messages', () => {
    expect(decodeLiveMidiMessage([0xb4, 64, 127])).toEqual({
      type: 'control-change', channel: 4, controller: 64, value: 1, timestampMs: 0,
    })
    expect(decodeLiveMidiMessage([0xc0, 12])).toBeNull()
    expect(decodeLiveMidiMessage([0xf8])).toBeNull()
    expect(decodeLiveMidiMessage([0x90])).toBeNull()
    expect(decodeLiveMidiMessage([0x90, 60])).toBeNull()
    expect(decodeLiveMidiMessage([0x90, 60, 1, 0])).toBeNull()
    expect(decodeLiveMidiMessage([0x90, 128, 1])).toBeNull()
    expect(decodeLiveMidiMessage([0x90, 60, -1])).toBeNull()
    expect(decodeLiveMidiMessage([0x90, 60, 1.5])).toBeNull()
    expect(decodeLiveMidiMessage([Number.NaN, 60, 1])).toBeNull()
  })

  it('propagates and bounds the monotonic receive timestamp', () => {
    expect(decodeLiveMidiMessage([0x90, 60, 1], 123.5)).toMatchObject({ timestampMs: 123.5 })
    expect(normalizeLiveMidiTimestampMs(-10)).toBe(0)
    expect(normalizeLiveMidiTimestampMs(Number.POSITIVE_INFINITY, 42)).toBe(42)
    expect(normalizeLiveMidiTimestampMs(MAX_LIVE_MIDI_TIMESTAMP_MS + 1)).toBe(MAX_LIVE_MIDI_TIMESTAMP_MS)
  })
})
