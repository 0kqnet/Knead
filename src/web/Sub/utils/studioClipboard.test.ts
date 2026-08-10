import { describe, expect, it } from 'vitest'
import {
  createTimelineHistory,
  createTimelinePasteAction,
  timelineHistoryReducer,
  type TimelinePasteInput,
} from '../hooks/useTimeline'
import {
  createDefaultTrack,
  DEFAULT_SETTINGS,
  MAX_EMBEDDED_CUSTOM_AUDIO_ASSETS,
  MAX_EMBEDDED_CUSTOM_AUDIO_BYTES,
  MAX_PROJECT_CUSTOM_INSTRUMENTS,
  MAX_TIMELINE_MARKERS,
  type EmbeddedCustomAudioAsset,
  type Marker,
  type ProjectCustomInstrument,
  type TimelineState,
} from '../types/timeline'
import {
  STUDIO_CLIPBOARD_FORMAT,
  STUDIO_CLIPBOARD_VERSION,
  createStudioClipboardV1,
  prepareStudioClipboardPaste,
  type StudioClipboardV1,
} from './studioClipboard'

function asset(
  soundId: string,
  sequence: number,
  patch: Partial<EmbeddedCustomAudioAsset> = {},
): EmbeddedCustomAudioAsset {
  return {
    soundId,
    fileName: `${soundId.replace(/[:/]/gu, '_')}-${sequence}.ogg`,
    mimeType: 'audio/ogg',
    byteLength: 1,
    fingerprint: sequence.toString(16).padStart(64, '0'),
    dataBase64: 'AQ==',
    pitch: 0.75,
    volume: 0.5,
    weight: 2,
    stream: true,
    preload: false,
    attenuationDistance: 24,
    ...patch,
  }
}

function zeroBase64(byteLength: number): string {
  const padding = (3 - (byteLength % 3)) % 3
  return `${'A'.repeat(Math.ceil(byteLength / 3) * 4 - padding)}${'='.repeat(padding)}`
}

function marker(
  id: string,
  trackId: string,
  tick: number,
  soundId = 'custom:bell',
): Marker {
  return {
    id,
    trackId,
    tick,
    soundId,
    variantIndex: -1,
    volume: 1,
    pitch: 1,
    duration: 10,
    volumeCurve: {
      keyframes: [
        { tick: 0, value: 1, interpolation: 'linear' },
        { tick: 10, value: 0, interpolation: 'linear' },
      ],
    },
    source: {
      format: 'midi',
      index: 1,
      trackIndex: 0,
      channel: 0,
      note: 60,
      velocity: 100,
      releaseVelocity: 0,
      startTick: 0,
      endTick: 10,
      program: 0,
      startPitchBend: 8192,
      startOrder: 0,
      endOrder: 1,
    },
  }
}

function instrument(
  id: string,
  soundId = 'custom:bell',
  patch: Partial<ProjectCustomInstrument> = {},
): ProjectCustomInstrument {
  return {
    id,
    kind: 'audio',
    soundId,
    name: 'Bell',
    file: `${soundId.replace(/[:/]/gu, '_')}.ogg`,
    key: 45,
    pressKey: true,
    defaultPitch: 1,
    ...patch,
  }
}

function timeline(trackCount = 2): TimelineState {
  return {
    projectId: 'project',
    randomSeed: 1,
    targetVersion: '1.21.4',
    lengthTicks: 200,
    settings: structuredClone(DEFAULT_SETTINGS),
    master: { gainDb: 0, limiterEnabled: false, limiterCeilingDb: -1 },
    tracks: Array.from({ length: trackCount }, (_, index) => createDefaultTrack(`track-${index}`, index)),
    markers: [],
    customAudio: [],
    customInstruments: [],
  }
}

describe('studio clipboard v1', () => {
  it('deep-clones/freezes markers, strips provenance, ignores Stopper dependencies, and keeps all variants', () => {
    const source = timeline(3)
    const ordinary = marker('ordinary', source.tracks[1].id, 20)
    const stopper: Marker = {
      ...marker('stopper', source.tracks[2].id, 25, 'custom:stopper-decoy'),
      action: { type: 'sound-stop', scope: 'track-range', startTrack: 1, endTrack: 3 },
    }
    source.markers = [ordinary, stopper]
    source.customAudio = [
      asset('custom:bell', 1),
      asset('custom:unselected', 2),
      asset('custom:bell', 3, { pitch: 1.25 }),
      asset('custom:stopper-decoy', 4),
    ]
    source.customInstruments = [
      instrument('bell-definition', 'custom:bell', { sourceIndex: 3, file: 'kit/bell.ogg' }),
      instrument('unselected-definition', 'custom:unselected'),
      {
        id: 'protected-stopper',
        kind: 'sound-stopper',
        sourceIndex: 4,
        soundId: '',
        name: 'Sound Stopper',
        file: '',
        key: 45,
        pressKey: false,
        defaultPitch: 1,
      },
    ]
    const clipboard = createStudioClipboardV1(source, new Set(['ordinary', 'stopper']))

    expect(clipboard.assets.map(item => item.soundId)).toEqual(['custom:bell', 'custom:bell'])
    expect(clipboard.instruments).toEqual([{
      id: 'bell-definition',
      kind: 'audio',
      soundId: 'custom:bell',
      name: 'Bell',
      file: 'kit/bell.ogg',
      key: 45,
      pressKey: true,
      defaultPitch: 1,
    }])
    expect(clipboard.instruments?.[0]).not.toHaveProperty('sourceIndex')
    expect(clipboard.markers[0].marker).not.toHaveProperty('source')
    expect(clipboard.markers[1].marker.action).toEqual({
      type: 'sound-stop', scope: 'track-range', startTrack: 1, endTrack: 3,
    })
    expect(Object.isFrozen(clipboard)).toBe(true)
    expect(Object.isFrozen(clipboard.markers)).toBe(true)
    expect(Object.isFrozen(clipboard.markers[0].marker)).toBe(true)
    expect(Object.isFrozen(clipboard.markers[0].marker.volumeCurve?.keyframes)).toBe(true)
    expect(Object.isFrozen(clipboard.assets[0])).toBe(true)
    expect(Object.isFrozen(clipboard.instruments?.[0])).toBe(true)

    ordinary.tick = 99
    ordinary.volumeCurve!.keyframes[0].value = 0
    source.customAudio[0].pitch = 2
    source.customInstruments[0].name = 'Mutated'
    expect(clipboard.markers[0].marker.tick).toBe(20)
    expect(clipboard.markers[0].marker.volumeCurve?.keyframes[0].value).toBe(1)
    expect(clipboard.assets[0].pitch).toBe(0.75)
    expect(clipboard.instruments?.[0].name).toBe('Bell')
  })

  it('accepts legacy v1 snapshots without the optional instrument extension', () => {
    const source = timeline()
    source.markers = [marker('copy', source.tracks[0].id, 5)]
    source.customAudio = [asset('custom:bell', 1)]
    source.customInstruments = [instrument('source-definition')]
    const legacy = structuredClone(createStudioClipboardV1(source, ['copy']))
    Reflect.deleteProperty(legacy, 'instruments')

    const prepared = prepareStudioClipboardPaste(legacy, timeline(), { atTick: 20 })
    expect(prepared.markers[0]).toMatchObject({ tick: 20, soundId: 'custom:bell' })
    expect(prepared.assets).toHaveLength(1)
    expect(prepared.instruments).toEqual([])
  })

  it('reuses semantically equal definitions while ignoring source and destination internal IDs', () => {
    const source = timeline()
    source.markers = [marker('copy', source.tracks[0].id, 0)]
    source.customInstruments = [instrument('source-id', 'custom:bell', { file: 'kit/bell.ogg' })]
    const destination = timeline()
    destination.customInstruments = [instrument('destination-id', 'custom:bell', { file: 'kit/bell.ogg' })]

    const prepared = prepareStudioClipboardPaste(
      createStudioClipboardV1(source, ['copy']),
      destination,
      { atTick: 10 },
    )
    expect(prepared.soundIdRemap).toEqual({ 'custom:bell': 'custom:bell' })
    expect(prepared.instruments).toEqual([])
    expect(prepared.markers[0].soundId).toBe('custom:bell')
  })

  it('stably remaps an assetless sound when its authored definition differs', () => {
    const source = timeline()
    source.markers = [marker('copy', source.tracks[0].id, 0)]
    source.customInstruments = [instrument('source-id', 'custom:bell', {
      name: 'Source Bell',
      file: 'source/bell.ogg',
    })]
    const clipboard = createStudioClipboardV1(source, ['copy'])
    const destination = timeline()
    destination.customInstruments = [instrument('destination-id', 'custom:bell', {
      name: 'Destination Bell',
      file: 'destination/bell.ogg',
    })]
    const before = structuredClone(destination)

    const first = prepareStudioClipboardPaste(clipboard, destination, { atTick: 10 })
    const second = prepareStudioClipboardPaste(clipboard, destination, { atTick: 10 })
    expect(first.assets).toEqual([])
    expect(first.instruments).toHaveLength(1)
    expect(first.markers[0].soundId).toMatch(/^knead:paste\//u)
    expect(first.instruments[0].soundId).toBe(first.markers[0].soundId)
    expect(second.instruments[0]).toEqual(first.instruments[0])
    expect(destination).toEqual(before)
  })

  it('atomically remaps a marker, its definition, and all embedded variants', () => {
    const source = timeline()
    source.markers = [marker('copy', source.tracks[0].id, 0)]
    source.customAudio = [asset('custom:bell', 1), asset('custom:bell', 2)]
    source.customInstruments = [instrument('source-definition', 'custom:bell', {
      file: 'source/bell.ogg',
    })]
    const destination = timeline()
    destination.customAudio = [asset('custom:bell', 3)]
    destination.customInstruments = [instrument('destination-definition', 'custom:bell', {
      name: 'Other Bell',
      file: 'destination/bell.ogg',
    })]

    const prepared = prepareStudioClipboardPaste(
      createStudioClipboardV1(source, ['copy']),
      destination,
      { atTick: 0 },
    )
    const target = prepared.markers[0].soundId
    expect(target).toMatch(/^knead:paste\//u)
    expect(prepared.assets.map(item => item.soundId)).toEqual([target, target])
    expect(prepared.instruments.map(item => item.soundId)).toEqual([target])
  })

  it('reuses an exactly equal destination group and adds no duplicate assets', () => {
    const source = timeline()
    source.markers = [marker('copy', source.tracks[0].id, 10)]
    source.customAudio = [asset('custom:bell', 1), asset('custom:bell', 2, { pitch: 1.25 })]
    const clipboard = createStudioClipboardV1(source, ['copy'])
    const destination = timeline()
    destination.customAudio = structuredClone(source.customAudio)
    const prepared = prepareStudioClipboardPaste(clipboard, destination, { atTick: 50 })

    expect(prepared.assets).toEqual([])
    expect(prepared.soundIdRemap).toEqual({ 'custom:bell': 'custom:bell' })
    expect(prepared.markers[0]).toMatchObject({ tick: 50, soundId: 'custom:bell' })
    expect(prepared.markers[0]).not.toHaveProperty('id')
    expect(prepared.markers[0]).not.toHaveProperty('source')
  })

  const collisionCases: [string, (value: EmbeddedCustomAudioAsset) => void][] = [
    ['fileName', (value) => { value.fileName = 'different.ogg' }],
    ['mimeType', (value) => { value.mimeType = 'audio/wav' }],
    ['byteLength', (value) => {
      value.byteLength = 2
      value.dataBase64 = 'AQI='
    }],
    ['fingerprint', (value) => { value.fingerprint = 'f'.repeat(64) }],
    ['dataBase64', (value) => { value.dataBase64 = 'Ag==' }],
    ['pitch', (value) => { value.pitch = 1.25 }],
    ['volume', (value) => { value.volume = 0.25 }],
    ['weight', (value) => { value.weight = 9 }],
    ['stream', (value) => { value.stream = false }],
    ['preload', (value) => { value.preload = true }],
    ['attenuationDistance', (value) => { value.attenuationDistance = 48 }],
  ]

  it.each(collisionCases)('stably renames a collision when %s differs', (_field, change) => {
    const source = timeline()
    source.markers = [marker('copy', source.tracks[0].id, 10)]
    source.customAudio = [asset('custom:bell', 1)]
    const clipboard = createStudioClipboardV1(source, ['copy'])
    const destination = timeline()
    const destinationVariant = asset('custom:bell', 1)
    change(destinationVariant)
    destination.customAudio = [destinationVariant]
    const before = structuredClone(destination)

    const first = prepareStudioClipboardPaste(clipboard, destination, { atTick: 40 })
    const second = prepareStudioClipboardPaste(clipboard, destination, { atTick: 40 })
    const renamed = first.markers[0].soundId
    expect(renamed).toMatch(/^knead:paste\//u)
    expect(second.markers[0].soundId).toBe(renamed)
    expect(first.assets).toHaveLength(1)
    expect(first.assets[0].soundId).toBe(renamed)
    expect(first.warnings.join('\n')).toMatch(/collision renamed/i)
    expect(destination).toEqual(before)
  })

  it('deterministically resolves definition ID and portable file collisions', () => {
    const source = timeline()
    source.markers = [marker('copy', source.tracks[0].id, 0, 'custom:new')]
    source.customInstruments = [instrument('shared-id', 'custom:new', {
      name: 'Lead',
      file: 'KIT/Lead.ogg',
    })]
    const destination = timeline()
    destination.customInstruments = [instrument('shared-id', 'custom:existing', {
      name: 'Existing',
      file: 'kit/lead.OGG',
    })]
    const clipboard = createStudioClipboardV1(source, ['copy'])

    const first = prepareStudioClipboardPaste(clipboard, destination, { atTick: 0 })
    const second = prepareStudioClipboardPaste(clipboard, destination, { atTick: 0 })
    expect(first.markers[0].soundId).toBe('custom:new')
    expect(first.instruments[0].id).toMatch(/^paste-/u)
    expect(first.instruments[0].id).not.toBe('shared-id')
    expect(first.instruments[0].file).toMatch(/^knead-paste\/.+\.ogg$/u)
    expect(first.instruments).toEqual(second.instruments)
    expect(first.warnings.join('\n')).toMatch(/file collision renamed/i)
  })

  it('treats variant order as part of a sound group collision', () => {
    const source = timeline()
    source.markers = [marker('copy', source.tracks[0].id, 10)]
    const first = asset('custom:bell', 1)
    const second = asset('custom:bell', 2, { pitch: 1.25 })
    source.customAudio = [first, second]
    const clipboard = createStudioClipboardV1(source, ['copy'])
    const destination = timeline()
    destination.customAudio = [structuredClone(second), structuredClone(first)]

    const prepared = prepareStudioClipboardPaste(clipboard, destination, { atTick: 10 })
    expect(prepared.markers[0].soundId).toMatch(/^knead:paste\//u)
    expect(prepared.assets).toHaveLength(2)
  })

  it('shifts ticks/tracks and remaps one-based Stopper ranges with clamping', () => {
    const source = timeline(4)
    source.markers = [
      marker('ordinary', source.tracks[1].id, 10, 'minecraft:block.note_block.harp'),
      {
        ...marker('stopper', source.tracks[3].id, 15, ''),
        action: { type: 'sound-stop', scope: 'track-range', startTrack: 1, endTrack: 4 },
      },
    ]
    const clipboard = createStudioClipboardV1(source, ['ordinary', 'stopper'])
    const destination = timeline(3)
    const prepared = prepareStudioClipboardPaste(clipboard, destination, {
      atTick: 100,
      destinationTrackIndex: 0,
    })

    expect(prepared.markers[0]).toMatchObject({ tick: 100, trackId: 'track-0' })
    expect(prepared.markers[1]).toMatchObject({
      tick: 105,
      trackId: 'track-2',
      action: { type: 'sound-stop', scope: 'track-range', startTrack: 1, endTrack: 3 },
    })
    expect(Object.isFrozen(prepared)).toBe(true)
    expect(Object.isFrozen(prepared.markers[1].action)).toBe(true)
  })

  it('supports explicit track remaps and clamps each Stopper endpoint range member', () => {
    const source = timeline(3)
    source.markers = [{
      ...marker('stopper', source.tracks[1].id, 0, ''),
      action: { type: 'sound-stop', scope: 'track-range', startTrack: 1, endTrack: 3 },
    }]
    const clipboard = createStudioClipboardV1(source, ['stopper'])
    const destination = timeline(2)
    const prepared = prepareStudioClipboardPaste(clipboard, destination, {
      atTick: 0,
      trackIndexMap: { 0: 99, 1: 0, 2: -20 },
    })
    expect(prepared.markers[0]).toMatchObject({
      trackId: 'track-0',
      action: { startTrack: 1, endTrack: 2 },
    })
  })

  it('rejects the 256-asset and 96 MiB budgets before producing a paste payload', () => {
    const source = timeline()
    source.markers = [marker('copy', source.tracks[0].id, 0)]
    source.customAudio = Array.from(
      { length: MAX_EMBEDDED_CUSTOM_AUDIO_ASSETS + 1 },
      (_, index) => asset('custom:bell', index + 1),
    )
    expect(() => createStudioClipboardV1(source, ['copy'])).toThrow(/too many custom audio/i)

    const base = createStudioClipboardV1({
      ...timeline(),
      markers: [marker('copy', 'track-0', 0)],
      customAudio: [asset('custom:bell', 1)],
    }, ['copy'])
    const oversized: StudioClipboardV1 = {
      format: STUDIO_CLIPBOARD_FORMAT,
      version: STUDIO_CLIPBOARD_VERSION,
      originTick: 0,
      originTrackIndex: 0,
      sourceTrackCount: 1,
      markers: base.markers,
      assets: Array.from({ length: 4 }, (_, index) => ({
        ...asset('custom:bell', index + 1),
        byteLength: MAX_EMBEDDED_CUSTOM_AUDIO_BYTES,
      })),
    }
    expect(() => prepareStudioClipboardPaste(oversized, timeline(), { atTick: 0 }))
      .toThrow(/96 MiB/i)
  })

  it('rejects protected, provenance-bearing, and over-limit definition payloads', () => {
    const source = timeline()
    source.markers = [marker('copy', source.tracks[0].id, 0)]
    source.customInstruments = [instrument('source')]
    const base = createStudioClipboardV1(source, ['copy'])
    const protectedPayload: StudioClipboardV1 = {
      ...base,
      instruments: [{
        id: 'stopper',
        kind: 'sound-stopper',
        soundId: '',
        name: 'Sound Stopper',
        file: '',
        key: 45,
        pressKey: false,
        defaultPitch: 1,
      }],
    }
    expect(() => prepareStudioClipboardPaste(protectedPayload, timeline(), { atTick: 0 }))
      .toThrow(/protected functional/i)

    const provenancePayload = structuredClone(base) as StudioClipboardV1 & {
      instruments: Array<ProjectCustomInstrument>
    }
    provenancePayload.instruments[0].sourceIndex = 0
    expect(() => prepareStudioClipboardPaste(provenancePayload, timeline(), { atTick: 0 }))
      .toThrow(/source provenance/i)

    const overLimit: StudioClipboardV1 = {
      ...base,
      instruments: Array.from(
        { length: MAX_PROJECT_CUSTOM_INSTRUMENTS + 1 },
        (_, index) => instrument(`definition-${index}`, `custom:sound-${index}`),
      ),
    }
    expect(() => prepareStudioClipboardPaste(overLimit, timeline(), { atTick: 0 }))
      .toThrow(/too many custom instrument/i)
  })

  it('rejects the combined definition cap without touching the destination', () => {
    const source = timeline()
    source.markers = [marker('copy', source.tracks[0].id, 0, 'custom:new')]
    source.customInstruments = [instrument('new-definition', 'custom:new')]
    const destination = timeline()
    destination.customInstruments = Array.from(
      { length: MAX_PROJECT_CUSTOM_INSTRUMENTS },
      (_, index) => instrument(`existing-${index}`, `custom:existing-${index}`, {
        file: `existing-${index}.ogg`,
      }),
    )
    const before = structuredClone(destination)
    expect(() => prepareStudioClipboardPaste(
      createStudioClipboardV1(source, ['copy']),
      destination,
      { atTick: 0 },
    )).toThrow(/255-definition limit/i)
    expect(destination).toEqual(before)
  })

  it('rejects merged marker and shared embedded-audio budgets before dispatch', () => {
    const source = timeline()
    source.markers = [marker('copy', source.tracks[0].id, 0)]
    const clipboard = createStudioClipboardV1(source, ['copy'])
    const markerDestination = timeline()
    markerDestination.markers = Array(MAX_TIMELINE_MARKERS).fill(
      marker('existing', markerDestination.tracks[0].id, 0, 'minecraft:block.note_block.harp'),
    )
    const markerBefore = markerDestination.markers
    expect(() => prepareStudioClipboardPaste(clipboard, markerDestination, { atTick: 0 }))
      .toThrow(/250000-marker project limit/i)
    expect(markerDestination.markers).toBe(markerBefore)

    const audioSource = timeline()
    audioSource.markers = [marker('audio-copy', audioSource.tracks[0].id, 0, 'custom:new')]
    audioSource.customAudio = [asset('custom:new', 99)]
    const audioClipboard = createStudioClipboardV1(audioSource, ['audio-copy'])
    const audioDestination = timeline()
    const referenceBytes = MAX_EMBEDDED_CUSTOM_AUDIO_BYTES
    const referenceBase64 = zeroBase64(referenceBytes)
    audioDestination.referenceAudio = Array.from({ length: 2 }, (_, index) => ({
      id: `reference-${index}`,
      name: `Reference ${index}`,
      color: 'blue' as const,
      fileName: `reference-${index}.wav`,
      sourcePath: '',
      mimeType: 'audio/wav' as const,
      byteLength: referenceBytes,
      fingerprint: index.toString(16).padStart(8, '0'),
      dataBase64: referenceBase64,
      durationSeconds: 1,
      offsetTicks: 0,
      gainDb: 0,
      pan: 0,
      muted: false,
      solo: false,
      locked: false,
      collapsed: false,
    }))
    const customBytes = 1024 * 1024
    const customBase64 = zeroBase64(customBytes)
    audioDestination.customAudio = Array.from({ length: 32 }, (_, index) => asset(
      'custom:existing',
      index + 1,
      { byteLength: customBytes, dataBase64: customBase64 },
    ))
    const referencesBefore = audioDestination.referenceAudio
    const customAudioBefore = audioDestination.customAudio
    expect(() => prepareStudioClipboardPaste(audioClipboard, audioDestination, { atTick: 0 }))
      .toThrow(/shared 96 MiB/i)
    expect(audioDestination.referenceAudio).toBe(referencesBefore)
    expect(audioDestination.customAudio).toBe(customAudioBefore)
  })

  it('rejects a merged asset budget atomically without touching the destination', () => {
    const source = timeline()
    source.markers = [marker('copy', source.tracks[0].id, 0, 'custom:new')]
    source.customAudio = [asset('custom:new', 10_000)]
    const clipboard = createStudioClipboardV1(source, ['copy'])
    const destination = timeline()
    destination.customAudio = Array.from(
      { length: MAX_EMBEDDED_CUSTOM_AUDIO_ASSETS },
      (_, index) => asset(`custom:existing-${index}`, index + 1),
    )
    const before = structuredClone(destination)
    expect(() => prepareStudioClipboardPaste(clipboard, destination, { atTick: 0 }))
      .toThrow(/too many custom audio/i)
    expect(destination).toEqual(before)
  })

  it('feeds the timeline controller one undoable marker-assets-and-definitions action', () => {
    const source = timeline()
    source.markers = [marker('copy', source.tracks[0].id, 10, 'custom:new')]
    source.customAudio = [asset('custom:new', 1)]
    source.customInstruments = [instrument('new-definition', 'custom:new', { file: 'new.ogg' })]
    const destination = timeline()
    const prepared = prepareStudioClipboardPaste(
      createStudioClipboardV1(source, ['copy']),
      destination,
      { atTick: 40 },
    )
    const atomicInput: TimelinePasteInput = prepared
    const action = createTimelinePasteAction(atomicInput).action
    const pasted = timelineHistoryReducer(createTimelineHistory(destination), action)

    expect(pasted.past).toHaveLength(1)
    expect(pasted.current.markers).toHaveLength(1)
    expect(pasted.current.customAudio).toHaveLength(1)
    expect(pasted.current.customInstruments).toEqual(prepared.instruments)
    const undone = timelineHistoryReducer(pasted, { type: 'undo' })
    expect(undone.current).toBe(destination)
  })

  it('materializes legacy derived definitions before the atomic paste action', () => {
    const destination = timeline()
    destination.customAudio = [asset('custom:legacy', 9, { fileName: 'legacy.ogg' })]
    delete destination.customInstruments
    const action = createTimelinePasteAction({
      markers: [{ tick: 1, soundId: 'custom:new' }],
      assets: [],
      instruments: [instrument('new-definition', 'custom:new')],
    }).action
    const pasted = timelineHistoryReducer(createTimelineHistory(destination), action)

    expect(pasted.current.customInstruments?.map(item => item.soundId)).toEqual([
      'custom:legacy',
      'custom:new',
    ])
    expect(timelineHistoryReducer(pasted, { type: 'undo' }).current).toBe(destination)
  })
})
