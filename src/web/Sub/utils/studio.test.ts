import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SONG_METADATA,
  DEFAULT_SETTINGS,
  MAX_GATE_TICKS,
  MAX_MARKER_PITCH,
  MAX_LOOP_COUNT,
  MAX_TIMELINE_MARKERS,
  MIN_MARKER_PITCH,
  createDefaultTrack,
  isTrackAudible,
  snapTick,
  ticksPerBeat,
  type TimelineState,
} from '../types/timeline'
import { parse, serialize } from './timelineIO'
import { getTimelineLengthTicks } from './tempoMap'
import { sanitizeStemName, stableVariantIndex, stemFileName } from './studioMath'

describe('Knead Studio project v10', () => {
  it('migrates a v1 project into one track', () => {
    const parsed = parse(JSON.stringify({
      format: 'knead-project',
      version: 1,
      targetVersion: '1.21.4',
      lengthTicks: 200,
      markers: [{
        id: 'marker', tick: 20, soundId: 'block.note_block.harp',
        variantIndex: -1, volume: 1, pitch: 1, trackY: 48,
      }],
    }))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.state.tracks).toHaveLength(1)
    expect(parsed.state.markers[0].trackId).toBe(parsed.state.tracks[0].id)
    expect(parsed.state.markers[0].laneY).toBeCloseTo(0.2)
    expect(parsed.state.markers[0].pan).toBe(0)
    expect(parsed.state.settings.panLaw).toBe('cascade')
    expect(JSON.parse(serialize(parsed.state)).version).toBe(10)
  })

  it('round-trips mixer and tempo settings', () => {
    const track = createDefaultTrack('track')
    const state: TimelineState = {
      projectId: 'project',
      randomSeed: 42,
      targetVersion: '1.21.4',
      lengthTicks: 240,
      settings: {
        ...structuredClone(DEFAULT_SETTINGS),
        bpm: 128,
        panLaw: 'nbs-average',
        timeSignature: { numerator: 7, denominator: 8 },
      },
      master: { gainDb: -3, limiterEnabled: true, limiterCeilingDb: -1 },
      tracks: [{ ...track, pan: 0.4, solo: true }],
      markers: [{
        id: 'marker', trackId: 'track', tick: 10, soundId: 'test',
        variantIndex: 0, volume: 0.8, pitch: 1, pan: 0.35, laneY: 0.25,
      }],
    }
    const parsed = parse(serialize(state))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.state.settings.bpm).toBe(128)
    expect(parsed.state.settings.panLaw).toBe('nbs-average')
    expect(parsed.state.tracks[0].pan).toBe(0.4)
    expect(parsed.state.master.gainDb).toBe(-3)
    expect(parsed.state.markers[0].laneY).toBe(0.3)
    expect(parsed.state.markers[0].pan).toBe(0.35)
  })

  it('round-trips strict extended DAW pitch bounds without widening legacy schemas', () => {
    const track = createDefaultTrack('pitch-track')
    const state: TimelineState = {
      projectId: 'extended-pitch', randomSeed: 1, targetVersion: '', lengthTicks: 200,
      settings: structuredClone(DEFAULT_SETTINGS),
      master: { gainDb: 0, limiterEnabled: true, limiterCeilingDb: -1 },
      tracks: [track],
      markers: [{
        id: 'pitch', trackId: track.id, tick: 0, soundId: 'test', variantIndex: -1,
        volume: 1, pitch: MIN_MARKER_PITCH, duration: 10,
        pitchCurve: { keyframes: [
          { tick: 0, value: MIN_MARKER_PITCH, interpolation: 'bezier', handleR: { dt: 2, dv: 1 } },
          { tick: 10, value: MAX_MARKER_PITCH, interpolation: 'bezier', handleL: { dt: -2, dv: -1 } },
        ] },
      }],
    }
    const raw = JSON.parse(serialize(state))
    const parsed = parse(JSON.stringify(raw))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.state.markers[0].pitch).toBe(MIN_MARKER_PITCH)
    expect(parsed.state.markers[0].pitchCurve?.keyframes[1].value).toBe(MAX_MARKER_PITCH)

    for (const invalid of [MIN_MARKER_PITCH / 2, MAX_MARKER_PITCH * 2, Number.NaN]) {
      const unsafe = structuredClone(raw)
      unsafe.markers[0].pitch = invalid
      expect(parse(JSON.stringify(unsafe))).toMatchObject({ ok: false })
    }
    const unsafeControl = structuredClone(raw)
    unsafeControl.markers[0].pitchCurve.keyframes[0].handleR.dv = MAX_MARKER_PITCH
    expect(parse(JSON.stringify(unsafeControl))).toMatchObject({ ok: false })

    const legacy = structuredClone(raw)
    legacy.version = 8
    legacy.markers[0].pitch = MAX_MARKER_PITCH
    delete legacy.markers[0].gateTicks
    expect(parse(JSON.stringify(legacy))).toMatchObject({ ok: false })
  })

  it('rejects marker arrays above the shared project ceiling before item validation', () => {
    expect(parse(JSON.stringify({
      format: 'knead-project', version: 9, targetVersion: '', lengthTicks: 1,
      markers: Array(MAX_TIMELINE_MARKERS + 1).fill(null),
    }))).toMatchObject({ ok: false, error: expect.stringContaining(String(MAX_TIMELINE_MARKERS)) })
  })

  it('round-trips bounded gateTicks and migrates v8 markers to natural sample tails', () => {
    const track = createDefaultTrack('track')
    const state: TimelineState = {
      projectId: 'gate-project', randomSeed: 9, targetVersion: '', lengthTicks: 200,
      settings: structuredClone(DEFAULT_SETTINGS),
      master: { gainDb: 0, limiterEnabled: true, limiterCeilingDb: -1 },
      tracks: [track],
      markers: [{
        id: 'gate', trackId: track.id, tick: 10, soundId: 'test',
        variantIndex: -1, volume: 1, pitch: 1, gateTicks: 12,
        duration: 20, retriggerInterval: 4,
      }],
    }
    const raw = JSON.parse(serialize(state))
    expect(raw).toMatchObject({ version: 10, markers: [{ gateTicks: 12, duration: 20 }] })
    const parsed = parse(JSON.stringify(raw))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.state.markers[0]).toMatchObject({ gateTicks: 12, duration: 20 })

    state.markers[0].gateTicks = 0
    expect(JSON.parse(serialize(state)).markers[0]).not.toHaveProperty('gateTicks')
    state.markers[0].gateTicks = 12

    const natural = structuredClone(raw)
    natural.markers[0].gateTicks = 0
    const parsedNatural = parse(JSON.stringify(natural))
    expect(parsedNatural.ok).toBe(true)
    if (parsedNatural.ok) expect(parsedNatural.state.markers[0].gateTicks).toBeUndefined()

    for (const invalid of [-1, 1.5, MAX_GATE_TICKS + 1]) {
      const unsafe = structuredClone(raw)
      unsafe.markers[0].gateTicks = invalid
      expect(parse(JSON.stringify(unsafe))).toMatchObject({ ok: false })
    }

    const legacy = structuredClone(raw)
    legacy.version = 8
    const migrated = parse(JSON.stringify(legacy))
    expect(migrated.ok).toBe(true)
    if (migrated.ok) {
      expect(migrated.state.markers[0].gateTicks).toBeUndefined()
      expect(migrated.warnings.join(' ')).toMatch(/version 9.*自然減衰/)
    }
  })

  it('persists generic song metadata and finite repeats with bounded v9 validation', () => {
    const track = createDefaultTrack('track')
    const state: TimelineState = {
      projectId: 'metadata-project', randomSeed: 1, targetVersion: '', lengthTicks: 200,
      settings: {
        ...structuredClone(DEFAULT_SETTINGS),
        loop: { enabled: true, startTick: 20, endTick: 180, maxLoopCount: 3 },
      },
      master: { gainDb: 0, limiterEnabled: true, limiterCeilingDb: -1 },
      tracks: [track], markers: [],
      metadata: {
        ...DEFAULT_SONG_METADATA,
        title: 'Edited title', author: 'Composer', originalAuthor: 'Arranger',
        description: 'Project-level credits', sourceFile: 'source.mid',
        autoSave: true, autoSaveDuration: 12, minutesSpent: 42, blocksAdded: 99,
      },
    }
    const raw = JSON.parse(serialize(state))
    expect(raw.version).toBe(10)
    expect(raw.settings.loop.maxLoopCount).toBe(3)
    expect(raw.metadata).toMatchObject({
      title: 'Edited title', author: 'Composer', autoSave: true, minutesSpent: 42,
    })
    const parsed = parse(JSON.stringify(raw))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.state.metadata).toEqual(raw.metadata)
    expect(parsed.state.settings.loop.maxLoopCount).toBe(3)

    raw.settings.loop.maxLoopCount = MAX_LOOP_COUNT + 1
    expect(parse(JSON.stringify(raw))).toMatchObject({ ok: false })
    raw.settings.loop.maxLoopCount = 3
    raw.metadata.leftClicks = -1
    expect(parse(JSON.stringify(raw))).toMatchObject({ ok: false })
  })

  it('migrates v2-v7 projects with default metadata and infinite looping', () => {
    const track = createDefaultTrack('track')
    const state: TimelineState = {
      projectId: 'legacy-metadata', randomSeed: 1, targetVersion: '', lengthTicks: 200,
      settings: structuredClone(DEFAULT_SETTINGS),
      master: { gainDb: 0, limiterEnabled: true, limiterCeilingDb: -1 },
      tracks: [track], markers: [],
    }
    for (const version of [2, 3, 4, 5, 6, 7]) {
      const raw = JSON.parse(serialize(state))
      raw.version = version
      delete raw.metadata
      delete raw.settings.loop.maxLoopCount
      if (version < 6) delete raw.tempoMap
      const parsed = parse(JSON.stringify(raw))
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) continue
      expect(parsed.state.metadata).toEqual(DEFAULT_SONG_METADATA)
      expect(parsed.state.settings.loop.maxLoopCount).toBe(0)
      expect(parsed.warnings.join(' ')).toMatch(/有限ループ/)
    }
  })

  it('persists portable reference audio and extends the project range', () => {
    const track = createDefaultTrack('track')
    const state: TimelineState = {
      projectId: 'reference-project',
      randomSeed: 7,
      targetVersion: '1.21.4',
      lengthTicks: 200,
      settings: structuredClone(DEFAULT_SETTINGS),
      master: { gainDb: 0, limiterEnabled: true, limiterCeilingDb: -1 },
      tracks: [track],
      markers: [],
      referenceAudio: [{
        id: 'reference',
        name: 'Guide Mix',
        color: 'cyan',
        fileName: 'guide.wav',
        sourcePath: 'C:\\music\\guide.wav',
        mimeType: 'audio/wav',
        byteLength: 12,
        fingerprint: '1234abcd',
        dataBase64: 'UklGRgAAAABXQVZF',
        durationSeconds: 10,
        offsetTicks: 50,
        gainDb: -3,
        pan: -0.25,
        muted: false,
        solo: true,
        locked: false,
        collapsed: false,
      }],
    }
    const json = serialize(state)
    expect(JSON.parse(json).version).toBe(10)
    const parsed = parse(json)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.state.referenceAudio).toEqual(state.referenceAudio?.map(track => ({ ...track, sourcePath: '' })))
    expect(state.referenceAudio?.[0].sourcePath).toBe('C:\\music\\guide.wav')
    expect(parsed.state.lengthTicks).toBeGreaterThanOrEqual(250)
  })

  it('persists bounded project-scoped custom audio for portable playback', () => {
    const track = createDefaultTrack('track')
    const state: TimelineState = {
      projectId: 'custom-audio-project',
      randomSeed: 9,
      targetVersion: '1.21.4',
      lengthTicks: 200,
      settings: structuredClone(DEFAULT_SETTINGS),
      master: { gainDb: 0, limiterEnabled: true, limiterCeilingDb: -1 },
      tracks: [track],
      markers: [{
        id: 'note', trackId: track.id, tick: 0, soundId: 'nbs:custom/lead',
        variantIndex: -1, volume: 1, pitch: 1,
      }],
      customAudio: [{
        soundId: 'nbs:custom/lead',
        fileName: 'kit/lead.ogg',
        mimeType: 'audio/ogg',
        byteLength: 3,
        fingerprint: 'a'.repeat(64),
        dataBase64: 'AQID',
        pitch: 1,
      }],
    }
    const parsed = parse(serialize(state))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.state.customAudio).toEqual(state.customAudio)

    const invalidBase64 = JSON.parse(serialize(state))
    invalidBase64.customAudio[0].dataBase64 = 'AQI='
    expect(parse(JSON.stringify(invalidBase64))).toMatchObject({ ok: false })
    const duplicate = JSON.parse(serialize(state))
    duplicate.customAudio.push({ ...duplicate.customAudio[0] })
    expect(parse(JSON.stringify(duplicate))).toMatchObject({ ok: false })
  })

  it('rejects out-of-range marker pan while accepting old v2 markers without it', () => {
    const track = createDefaultTrack('track')
    const legacySettings = structuredClone(DEFAULT_SETTINGS)
    delete legacySettings.panLaw
    const base = {
      projectId: 'project',
      randomSeed: 42,
      targetVersion: '1.21.4',
      lengthTicks: 200,
      settings: legacySettings,
      master: { gainDb: 0, limiterEnabled: true, limiterCeilingDb: -1 },
      tracks: [track],
      markers: [{
        id: 'marker', trackId: 'track', tick: 0, soundId: 'test',
        variantIndex: -1, volume: 1, pitch: 1,
      }],
    }
    const compatible = parse(JSON.stringify({ format: 'knead-project', version: 2, ...base }))
    expect(compatible.ok).toBe(true)
    if (compatible.ok) {
      expect(compatible.state.markers[0].pan).toBe(0)
      expect(compatible.state.settings.panLaw).toBe('cascade')
    }

    const invalid = parse(JSON.stringify({
      format: 'knead-project',
      version: 2,
      ...base,
      markers: [{ ...base.markers[0], pan: 1.01 }],
    }))
    expect(invalid).toMatchObject({ ok: false })

    const invalidPanLaw = parse(JSON.stringify({
      format: 'knead-project',
      version: 2,
      ...base,
      settings: { ...legacySettings, panLaw: 'unknown' },
    }))
    expect(invalidPanLaw).toMatchObject({ ok: false })
  })

  it('round-trips canonical Sound Stopper actions and rejects malformed ranges', () => {
    const track = createDefaultTrack('track')
    const state: TimelineState = {
      projectId: 'sound-stop-project',
      randomSeed: 77,
      targetVersion: '1.21.4',
      lengthTicks: 200,
      settings: structuredClone(DEFAULT_SETTINGS),
      master: { gainDb: 0, limiterEnabled: true, limiterCeilingDb: -1 },
      tracks: [track],
      markers: [{
        id: 'stop', trackId: track.id, tick: 12, soundId: '',
        variantIndex: -1, volume: 1, pitch: 1, pan: 0,
        action: { type: 'sound-stop', scope: 'track-range', startTrack: 1, endTrack: 12 },
      }],
    }
    const json = serialize(state)
    expect(JSON.parse(json).version).toBe(10)
    const parsed = parse(json)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.state.markers[0].action).toEqual({
      type: 'sound-stop', scope: 'track-range', startTrack: 1, endTrack: 12,
    })

    const invalid = JSON.parse(json)
    invalid.markers[0].action.endTrack = 0
    expect(parse(JSON.stringify(invalid))).toMatchObject({ ok: false })
    const gatedStopper = JSON.parse(json)
    gatedStopper.markers[0].gateTicks = 1
    expect(parse(JSON.stringify(gatedStopper))).toMatchObject({ ok: false })
  })

  it('round-trips lossless NBS project, layer, note, instrument, and finite-loop data', () => {
    const track = {
      ...createDefaultTrack('track'),
      source: {
        format: 'nbs' as const,
        index: 3,
        name: 'Original layer',
        locked: true,
        volume: 83,
        panning: 142,
      },
    }
    const state: TimelineState = {
      projectId: 'nbs-project',
      randomSeed: 123,
      targetVersion: '1.21.4',
      lengthTicks: 200,
      settings: {
        ...structuredClone(DEFAULT_SETTINGS),
        loop: { enabled: true, startTick: 16, endTick: 200, maxLoopCount: 3 },
      },
      master: { gainDb: 0, limiterEnabled: true, limiterCeilingDb: -1 },
      tracks: [track],
      markers: [{
        id: 'note',
        trackId: track.id,
        tick: 20,
        soundId: 'nbs:custom/piano',
        variantIndex: -1,
        volume: 0.73,
        pitch: 1.25,
        source: {
          format: 'nbs',
          tick: 7,
          layer: 3,
          instrument: 20,
          key: 51,
          velocity: 73,
          panning: 142,
          pitch: -125,
        },
      }],
      source: {
        format: 'nbs',
        sourceVersion: 6,
        tickScale: 1.6,
        vanillaInstrumentCount: 20,
        songLength: 128,
        layerCount: 4,
        name: 'Song',
        author: 'Author',
        originalAuthor: 'Original author',
        description: 'Description',
        tempo: 1250,
        autoSave: true,
        autoSaveDuration: 10,
        timeSignature: 4,
        minutesSpent: 123,
        leftClicks: 456,
        rightClicks: 789,
        blocksAdded: 12,
        blocksRemoved: 3,
        sourceFile: 'source.mid',
        loop: true,
        maxLoopCount: 3,
        loopStartTick: 16,
        customInstruments: [{
          name: 'Custom piano',
          file: 'sounds/piano.ogg',
          key: 45,
          pressKey: true,
        }],
        tempoChangerNotes: [{
          format: 'nbs', tick: 32, layer: 2, instrument: 21,
          key: 39, velocity: 100, panning: 100, pitch: 180,
        }],
      },
    }

    const json = serialize(state)
    expect(JSON.parse(json).version).toBe(10)
    expect(JSON.parse(json).metadata).toMatchObject({ title: 'Song', author: 'Author' })
    const parsed = parse(json)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.state.source).toEqual(state.source)
    expect(parsed.state.source?.format).toBe('nbs')
    if (parsed.state.source?.format !== 'nbs') return
    expect(parsed.state.settings.loop.maxLoopCount).toBe(3)
    expect(parsed.state.metadata).toMatchObject({ title: 'Song', author: 'Author' })
    expect(parsed.state.source.maxLoopCount).toBe(3)
    expect(parsed.state.source.customInstruments[0].file).toBe('sounds/piano.ogg')
    expect(parsed.state.source.tempoChangerNotes).toEqual(state.source?.format === 'nbs'
      ? state.source.tempoChangerNotes
      : undefined)
    expect(parsed.state.tracks[0].source).toEqual(track.source)
    expect(parsed.state.markers[0].source).toEqual(state.markers[0].source)

    const legacy = JSON.parse(json)
    legacy.version = 7
    delete legacy.metadata
    delete legacy.settings.loop.maxLoopCount
    const migrated = parse(JSON.stringify(legacy))
    expect(migrated.ok).toBe(true)
    if (!migrated.ok) return
    expect(migrated.state.metadata).toMatchObject({
      title: 'Song', author: 'Author', originalAuthor: 'Original author',
    })
    expect(migrated.state.settings.loop.maxLoopCount).toBe(3)
  })

  it('rejects malformed NBS provenance without weakening old-project compatibility', () => {
    const track = createDefaultTrack('track')
    const base = {
      format: 'knead-project',
      version: 3,
      projectId: 'project',
      randomSeed: 1,
      targetVersion: '1.21.4',
      lengthTicks: 200,
      settings: structuredClone(DEFAULT_SETTINGS),
      master: { gainDb: 0, limiterEnabled: true, limiterCeilingDb: -1 },
      tracks: [track],
      markers: [{
        id: 'marker', trackId: track.id, tick: 0, soundId: 'test',
        variantIndex: -1, volume: 1, pitch: 1,
      }],
    }
    const malformedNote = parse(JSON.stringify({
      ...base,
      markers: [{
        ...base.markers[0],
        source: {
          format: 'nbs', tick: 0, layer: 0, instrument: 256,
          key: 45, velocity: 100, panning: 100, pitch: 0,
        },
      }],
    }))
    expect(malformedNote).toMatchObject({ ok: false })

    const malformedProject = parse(JSON.stringify({
      ...base,
      source: { format: 'nbs', sourceVersion: 6, maxLoopCount: 256 },
    }))
    expect(malformedProject).toMatchObject({ ok: false })

    const validNbsSource = JSON.parse(serialize({
      ...base,
      version: undefined,
      format: undefined,
      source: {
        format: 'nbs', sourceVersion: 6, tickScale: 1, vanillaInstrumentCount: 20,
        songLength: 0, layerCount: 1, name: '', author: '', originalAuthor: '', description: '',
        tempo: 1000, autoSave: false, autoSaveDuration: 10, timeSignature: 4,
        minutesSpent: 0, leftClicks: 0, rightClicks: 0, blocksAdded: 0, blocksRemoved: 0,
        sourceFile: '', loop: false, maxLoopCount: 0, loopStartTick: 0, customInstruments: [],
        tempoChangerNotes: [],
      },
    } as TimelineState))
    validNbsSource.source.tempoChangerNotes = [{
      format: 'nbs', tick: 0, layer: 0, instrument: 20,
      key: 39, velocity: 100, panning: 100, pitch: 40_000,
    }]
    expect(parse(JSON.stringify(validNbsSource))).toMatchObject({ ok: false })
  })

  it('round-trips normalized MIDI tempo, track, and note provenance', () => {
    const track = {
      ...createDefaultTrack('midi-track'),
      source: {
        format: 'midi' as const,
        index: 1,
        name: 'Lead',
        instrumentName: 'Piano',
        lastTick: 960,
        channels: [0],
        programChanges: [{ tick: 0, channel: 0, program: 0, order: 1 }],
        pitchBends: [{ tick: 240, channel: 0, value: 1024, order: 3 }],
      },
    }
    const state: TimelineState = {
      projectId: 'midi-deadbeef',
      randomSeed: 0xdeadbeef,
      targetVersion: '1.21.4',
      lengthTicks: 200,
      settings: structuredClone(DEFAULT_SETTINGS),
      master: { gainDb: 0, limiterEnabled: true, limiterCeilingDb: -1 },
      tracks: [track],
      markers: [{
        id: 'midi-note', trackId: track.id, tick: 0,
        soundId: 'midi:gm/000_acoustic_grand_piano', variantIndex: -1,
        volume: 1, pitch: 1, pan: 0,
        source: {
          format: 'midi', index: 0, trackIndex: 1, channel: 0, note: 60,
          velocity: 127, releaseVelocity: 64, startTick: 0, endTick: 480,
          program: 0, startPitchBend: 0, startOrder: 2, endOrder: 4,
        },
      }],
      source: {
        format: 'midi', sourceFormat: 1, ticksPerQuarter: 480, fingerprint: 'deadbeef',
        tempoEvents: [{ tick: 0, microsecondsPerQuarter: 500_000, trackIndex: 0, order: 0 }],
        timeSignatureEvents: [{
          tick: 0, numerator: 4, denominator: 4, clocksPerMetronome: 24,
          thirtySecondsPerQuarter: 8, trackIndex: 0, order: 1,
        }],
      },
    }
    const parsed = parse(serialize(state))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.state.source).toEqual(state.source)
    expect(parsed.state.tracks[0].source).toEqual(track.source)
    expect(parsed.state.markers[0].source).toEqual(state.markers[0].source)
  })
})

describe('timeline math', () => {
  it('keeps musical snapping on integer Minecraft ticks', () => {
    const settings = { ...structuredClone(DEFAULT_SETTINGS), bpm: 128 }
    expect(ticksPerBeat(settings)).toBeCloseTo(9.375)
    expect(snapTick(9.375, { ...settings, snap: { ...settings.snap, mode: 'beat', beatDivision: 4 } })).toBe(9)
  })

  it('never shrinks the explicit project end', () => {
    expect(getTimelineLengthTicks([], 480, DEFAULT_SETTINGS)).toBe(480)
  })

  it('applies solo precedence over ordinary tracks', () => {
    const a = createDefaultTrack('a')
    const b = { ...createDefaultTrack('b', 1), solo: true }
    expect(isTrackAudible(a, [a, b])).toBe(false)
    expect(isTrackAudible(b, [a, b])).toBe(true)
    expect(isTrackAudible({ ...b, muted: true }, [a, { ...b, muted: true }])).toBe(false)
  })
})

describe('deterministic exports', () => {
  it('chooses the same random variant every time', () => {
    expect(stableVariantIndex(123, 'marker', 0, 8)).toBe(3)
    expect(stableVariantIndex(123, 'marker', 0, 8)).toBe(3)
  })

  it('sanitizes stem filenames', () => {
    expect(sanitizeStemName('Kick/Lead:*?')).toBe('Kick_Lead___')
    expect(stemFileName(0, 'Kick/Lead', 'wav')).toBe('01_Kick_Lead.wav')
  })
})
