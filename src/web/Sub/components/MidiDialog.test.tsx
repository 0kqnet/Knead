// @vitest-environment jsdom

import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { UIProvider } from '@yamada-ui/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { liveMidiGateTicks, MidiDialog } from './MidiDialog'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string | number | undefined>) => ({
      'studio.midi_title': 'MIDI Studio',
      'studio.midi_description': 'Import or record MIDI.',
      'studio.midi_file_import': 'Import MIDI file',
      'studio.midi_file_hint': 'Choose a Standard MIDI File.',
      'studio.midi_choose_file': 'Choose MIDI file',
      'studio.midi_preview_mapping': 'Sound mapping',
      'studio.midi_quantize': 'Quantize',
      'studio.midi_quantize_off': 'Off',
      'studio.midi_quantize_ticks': `${values?.count ?? ''}-tick grid`,
      'studio.midi_note_length': 'Note length',
      'studio.midi_note_length_gate': 'Note-off gate',
      'studio.midi_note_length_single': 'Single-shot sample tail',
      'studio.midi_tail_fade': 'Fade tail velocity',
      'studio.midi_tail_fade_hint': 'Add alternating tail voices.',
      'studio.midi_tail_fade_start': 'Tail start velocity (%)',
      'studio.midi_tail_fade_end': 'Tail end velocity (%)',
      'studio.midi_tail_fade_single_shot': 'Tail fade requires Note-off gate mode.',
      'studio.midi_preview_title': 'MIDI import preview',
      'studio.midi_preview_source': `Source: ${values?.file ?? ''}`,
      'studio.midi_preview_stats': 'Format and duration summary',
      'studio.midi_preview_events': 'Tempo and meter summary',
      'studio.midi_preview_channel_row': `Track channel ${values?.channel ?? ''}`,
      'studio.midi_preview_drums': 'General MIDI drums',
      'studio.midi_preview_programs': `Programs: ${values?.programs ?? ''}${values?.omitted ?? ''}`,
      'studio.midi_preview_sounds': `Sounds: ${values?.sounds ?? ''}${values?.omitted ?? ''}`,
      'studio.midi_preview_rows_omitted': `Rows omitted: ${values?.count ?? ''}`,
      'studio.midi_preview_warnings_omitted': `Warnings omitted: ${values?.count ?? ''}`,
      'studio.midi_channel_override': 'Per-channel sound override',
      'studio.midi_channel_override_label': `Channel ${values?.channel ?? ''} sound override`,
      'studio.midi_channel_override_placeholder': 'Use mapped sound',
      'studio.midi_apply': 'Apply MIDI import',
      'studio.midi_live': 'Live MIDI recording',
      'studio.midi_live_hint': 'Connect a MIDI keyboard.',
      'studio.midi_all_channels': 'All channels',
      'studio.midi_connect': 'Connect MIDI device',
      'studio.midi_arm': 'Arm recording',
      'studio.midi_disarm': 'Stop recording',
      'studio.midi_mapping_minecraft': 'Minecraft sounds',
      'studio.midi_mapping_gm': 'GM identifiers',
      'studio.midi_no_unlocked_track': 'Unlock a track to record.',
      'studio.midi_unsupported': 'Web MIDI is unavailable.',
      'studio.midi_error': `MIDI error: ${values?.error ?? ''}`,
      'studio.close': 'Close',
      'studio.close_dialog': 'Close dialog',
    }[key] ?? key),
  }),
}))

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value: vi.fn(),
  })
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, 'requestMIDIAccess')
  Reflect.deleteProperty(window, 'myAPI')
})

function minimalMidiBase64(): string {
  const bytes = Uint8Array.from([
    0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x60,
    0x4d, 0x54, 0x72, 0x6b, 0x00, 0x00, 0x00, 0x0c,
    0x00, 0x90, 0x3c, 0x64,
    0x60, 0x80, 0x3c, 0x00,
    0x00, 0xff, 0x2f, 0x00,
  ])
  return btoa(String.fromCharCode(...bytes))
}

class FakeMidiInput extends EventTarget {
  state: MIDIPortDeviceState = 'connected'
  readonly open = vi.fn(async () => this as unknown as MIDIPort)
  readonly close = vi.fn(async () => this as unknown as MIDIPort)

  constructor(
    readonly id = 'keyboard-1',
    readonly name = 'Test Keyboard',
    readonly manufacturer = 'Knead Labs',
  ) {
    super()
  }

  send(data: number[], receivedTime?: number) {
    const event = new Event('midimessage')
    Object.defineProperty(event, 'data', { value: Uint8Array.from(data) })
    if (receivedTime !== undefined) Object.defineProperty(event, 'receivedTime', { value: receivedTime })
    this.dispatchEvent(event)
  }
}

function installMidiAccess(...inputs: FakeMidiInput[]) {
  const access = new EventTarget() as MIDIAccess
  Object.defineProperty(access, 'inputs', {
    value: new Map(inputs.map(input => [input.id, input as unknown as MIDIInput])),
  })
  const requestMIDIAccess = vi.fn(async () => access)
  Object.defineProperty(navigator, 'requestMIDIAccess', {
    configurable: true,
    value: requestMIDIAccess,
  })
  return { access, requestMIDIAccess }
}

function dialogTree(props: React.ComponentProps<typeof MidiDialog>) {
  return (
    <UIProvider>
      <MidiDialog {...props} />
    </UIProvider>
  )
}

function renderDialog(overrides: Partial<React.ComponentProps<typeof MidiDialog>> = {}) {
  const props: React.ComponentProps<typeof MidiDialog> = {
    open: true,
    targetVersion: '1.21.4',
    currentTick: 40,
    canRecord: true,
    soundIds: ['block.note_block.harp'],
    defaultSoundId: 'block.note_block.harp',
    onImport: vi.fn(async () => true),
    onRecordNote: vi.fn(() => 'recorded-1'),
    onUpdateRecordedNote: vi.fn(),
    onBeginRecording: vi.fn(),
    onEndRecording: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
  return {
    props,
    ...render(dialogTree(props)),
  }
}

describe('MidiDialog', () => {
  it('imports a selected Standard MIDI File through the real parser', async () => {
    const open = vi.fn(async () => ({
      ok: true as const,
      path: 'C:\\Music\\one-note.mid',
      dataBase64: minimalMidiBase64(),
    }))
    Object.defineProperty(window, 'myAPI', {
      configurable: true,
      value: { midi: { open } } as unknown as Window['myAPI'],
    })
    const onImport = vi.fn<React.ComponentProps<typeof MidiDialog>['onImport']>()
      .mockResolvedValue(true)
    const onClose = vi.fn()
    renderDialog({ onImport, onClose })

    fireEvent.click(screen.getByRole('button', { name: 'Choose MIDI file' }))

    expect(await screen.findByText('MIDI import preview')).toBeTruthy()
    expect(onImport).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Apply MIDI import' }))
    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1))
    const [state, warnings, sourcePath] = onImport.mock.calls[0]
    expect(sourcePath).toBe('C:\\Music\\one-note.mid')
    expect(state.targetVersion).toBe('1.21.4')
    expect(state.markers).toHaveLength(1)
    expect(state.markers[0]).toMatchObject({
      tick: 0,
      soundId: 'block.note_block.harp',
      volume: 100 / 127,
      pitch: 2 ** (-6 / 12),
    })
    expect(warnings.join(' ')).toMatch(/wall-clock marker gates/i)
    expect(onClose).toHaveBeenCalledTimes(1)
  }, 10_000)

  it('rebuilds the selected-file preview without mutating the project before Apply', async () => {
    const open = vi.fn(async () => ({
      ok: true as const,
      path: 'C:\\Music\\adjust.mid',
      dataBase64: minimalMidiBase64(),
    }))
    Object.defineProperty(window, 'myAPI', {
      configurable: true,
      value: { midi: { open } } as unknown as Window['myAPI'],
    })
    const onImport = vi.fn<React.ComponentProps<typeof MidiDialog>['onImport']>()
      .mockResolvedValue(true)
    renderDialog({ onImport })

    fireEvent.click(screen.getByRole('button', { name: 'Choose MIDI file' }))
    expect(await screen.findByText('MIDI import preview')).toBeTruthy()
    expect(open).toHaveBeenCalledTimes(1)
    expect(onImport).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('combobox', { name: 'Sound mapping' }))
    fireEvent.click(screen.getByText('GM identifiers'))
    expect(await screen.findByText(/Sounds: midi:gm\/000_acoustic_grand_piano/)).toBeTruthy()
    const quantize = screen.getByRole('combobox', { name: 'Quantize' })
    fireEvent.click(quantize)
    fireEvent.click(screen.getByText('5-tick grid'))
    await waitFor(() => expect(quantize.getAttribute('aria-expanded')).toBe('false'))
    const noteLength = screen.getByRole('combobox', { name: 'Note length' })
    fireEvent.click(noteLength)
    fireEvent.click(screen.getByText('Single-shot sample tail'))
    const tailFade = screen.getByRole('checkbox', { name: 'Fade tail velocity' }) as HTMLInputElement
    expect(tailFade.disabled).toBe(true)
    expect(screen.getByText('Tail fade requires Note-off gate mode.')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Channel 1 sound override'), {
      target: { value: 'custom:preview_sound' },
    })
    expect(await screen.findByText('Sounds: custom:preview_sound')).toBeTruthy()
    expect(onImport).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Apply MIDI import' }))
    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1))
    const [state] = onImport.mock.calls[0]
    expect(state.markers[0]).toMatchObject({
      soundId: 'custom:preview_sound',
      gateTicks: undefined,
    })
    expect(open).toHaveBeenCalledTimes(1)
  }, 10_000)

  it('previews OpenNBS tail fade controls and applies bounded parity markers only on Apply', async () => {
    Object.defineProperty(window, 'myAPI', {
      configurable: true,
      value: {
        midi: {
          open: vi.fn(async () => ({
            ok: true as const,
            path: 'C:\\Music\\tail.mid',
            dataBase64: minimalMidiBase64(),
          })),
        },
      } as unknown as Window['myAPI'],
    })
    const onImport = vi.fn<React.ComponentProps<typeof MidiDialog>['onImport']>()
      .mockResolvedValue(true)
    renderDialog({ onImport })
    const tailFade = screen.getByRole('checkbox', { name: 'Fade tail velocity' }) as HTMLInputElement
    const start = screen.getByLabelText('Tail start velocity (%)') as HTMLInputElement
    const end = screen.getByLabelText('Tail end velocity (%)') as HTMLInputElement
    expect(tailFade.checked).toBe(false)
    expect(start.disabled).toBe(true)
    expect(end.disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Choose MIDI file' }))
    await screen.findByText('MIDI import preview')
    fireEvent.click(tailFade)
    fireEvent.change(start, { target: { value: '25' } })
    fireEvent.change(end, { target: { value: '75' } })
    expect(await screen.findByText(/1 melodic MIDI note tail.*2 bounded parity marker.*9 per-tick tail firing/i)).toBeTruthy()
    expect(onImport).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Apply MIDI import' }))
    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1))
    const [state, warnings] = onImport.mock.calls[0]
    expect(state.markers).toHaveLength(3)
    const [head, left, right] = state.markers
    expect(head.gateTicks).toBe(10)
    expect(head.duration).toBeUndefined()
    expect(left).toMatchObject({ tick: 1, pan: -0.5, duration: 8, retriggerInterval: 2 })
    expect(right).toMatchObject({ tick: 2, pan: 0.5, duration: 6, retriggerInterval: 2 })
    expect(left.gateTicks).toBeUndefined()
    expect(right.gateTicks).toBeUndefined()
    expect(left.volume).toBeCloseTo(head.volume * 0.25)
    expect(right.volumeCurve?.keyframes.at(-1)?.value).toBeCloseTo(
      head.volume * (25 + (75 - 25) * 7 / 8) / 100,
    )
    expect(warnings.join(' ')).toMatch(/integer percent.*intermediate velocity rounding/i)
  }, 10_000)

  it('coalesces rapid Apply clicks into one import transaction', async () => {
    Object.defineProperty(window, 'myAPI', {
      configurable: true,
      value: {
        midi: {
          open: vi.fn(async () => ({
            ok: true as const,
            path: 'C:\\Music\\pending.mid',
            dataBase64: minimalMidiBase64(),
          })),
        },
      } as unknown as Window['myAPI'],
    })
    let resolveImport!: (value: boolean) => void
    const onImport = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveImport = resolve
    }))
    const onClose = vi.fn()
    renderDialog({ onImport, onClose })
    fireEvent.click(screen.getByRole('button', { name: 'Choose MIDI file' }))
    const apply = await screen.findByRole('button', { name: 'Apply MIDI import' })

    fireEvent.click(apply)
    fireEvent.click(apply)
    expect(onImport).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
    await act(async () => resolveImport(true))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not apply completion UI to a dialog owner that closed while Apply was pending', async () => {
    Object.defineProperty(window, 'myAPI', {
      configurable: true,
      value: {
        midi: {
          open: vi.fn(async () => ({
            ok: true as const,
            path: 'C:\\Music\\owner.mid',
            dataBase64: minimalMidiBase64(),
          })),
        },
      } as unknown as Window['myAPI'],
    })
    let resolveImport!: (value: boolean) => void
    const onImport = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveImport = resolve
    }))
    const onClose = vi.fn()
    const view = renderDialog({ onImport, onClose })
    fireEvent.click(screen.getByRole('button', { name: 'Choose MIDI file' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Apply MIDI import' }))
    expect(onImport).toHaveBeenCalledTimes(1)

    view.rerender(dialogTree({ ...view.props, open: false }))
    await act(async () => resolveImport(true))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('records note-on and applies live pitch bend from a mocked Web MIDI input', async () => {
    Object.defineProperty(window, 'myAPI', {
      configurable: true,
      value: { midi: { open: vi.fn() } } as unknown as Window['myAPI'],
    })
    const input = new FakeMidiInput()
    installMidiAccess(input)
    const onRecordNote = vi.fn(() => 'recorded-1')
    const onUpdateRecordedNote = vi.fn()
    const onBeginRecording = vi.fn()
    const onEndRecording = vi.fn()
    const view = renderDialog({
      onRecordNote,
      onUpdateRecordedNote,
      onBeginRecording,
      onEndRecording,
    })

    fireEvent.click(screen.getByRole('button', { name: 'Connect MIDI device' }))
    await waitFor(() => expect(input.open).toHaveBeenCalledTimes(1))
    expect(onBeginRecording).toHaveBeenCalledTimes(1)

    act(() => input.send([0x90, 66, 100], 1_000))
    expect(onRecordNote).toHaveBeenCalledWith({
      channel: 0,
      note: 66,
      velocity: 100 / 127,
      pitch: 1,
      soundId: 'block.note_block.harp',
    })
    expect(screen.getByText(/1 active · 40t/)).toBeTruthy()

    act(() => input.send([0xe0, 0x7f, 0x7f], 1_100))
    expect(onUpdateRecordedNote).toHaveBeenCalledWith('recorded-1', {
      pitch: 2 ** (2 / 12),
    })

    view.rerender(dialogTree({ ...view.props, currentTick: 46 }))
    act(() => input.send([0x80, 66, 0], 1_300))
    expect(onUpdateRecordedNote).toHaveBeenCalledWith('recorded-1', { gateTicks: 6 })
    expect(screen.getByText(/0 active · 46t/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }))
    await waitFor(() => expect(onEndRecording).toHaveBeenCalledTimes(1))
    const recordedCount = onRecordNote.mock.calls.length
    act(() => input.send([0x90, 66, 100], 1_000))
    expect(onRecordNote).toHaveBeenCalledTimes(recordedCount)
  })

  it('keeps overlapping voices for the same channel and note in FIFO order', async () => {
    Object.defineProperty(window, 'myAPI', {
      configurable: true,
      value: { midi: { open: vi.fn() } } as unknown as Window['myAPI'],
    })
    const input = new FakeMidiInput()
    installMidiAccess(input)
    const onRecordNote = vi.fn()
      .mockReturnValueOnce('voice-1')
      .mockReturnValueOnce('voice-2')
    const onUpdateRecordedNote = vi.fn()
    renderDialog({ onRecordNote, onUpdateRecordedNote })

    fireEvent.click(screen.getByRole('button', { name: 'Connect MIDI device' }))
    await waitFor(() => expect(input.open).toHaveBeenCalledTimes(1))
    act(() => {
      input.send([0x90, 66, 100])
      input.send([0x90, 66, 90])
    })
    expect(screen.getByText(/2 active · 40t/)).toBeTruthy()

    act(() => input.send([0xe0, 0x7f, 0x7f]))
    expect(onUpdateRecordedNote.mock.calls).toEqual([
      ['voice-1', { pitch: 2 ** (2 / 12) }],
      ['voice-2', { pitch: 2 ** (2 / 12) }],
    ])

    act(() => input.send([0x80, 66, 0]))
    expect(screen.getByText(/1 active · 40t/)).toBeTruthy()
    onUpdateRecordedNote.mockClear()
    act(() => input.send([0xe0, 0, 64]))
    expect(onUpdateRecordedNote).toHaveBeenCalledWith('voice-2', { pitch: 1 })
  })

  it('defers overlapping note-offs until CC64 pedal-up and gates each owned voice there', async () => {
    Object.defineProperty(window, 'myAPI', {
      configurable: true,
      value: { midi: { open: vi.fn() } } as unknown as Window['myAPI'],
    })
    const input = new FakeMidiInput()
    installMidiAccess(input)
    const onRecordNote = vi.fn()
      .mockReturnValueOnce('sustain-1')
      .mockReturnValueOnce('sustain-2')
    const onUpdateRecordedNote = vi.fn()
    const view = renderDialog({ onRecordNote, onUpdateRecordedNote })

    fireEvent.click(screen.getByRole('button', { name: 'Connect MIDI device' }))
    await waitFor(() => expect(input.open).toHaveBeenCalledTimes(1))
    act(() => {
      input.send([0x90, 66, 100], 1_000)
      input.send([0x90, 66, 90], 1_000)
      input.send([0xb0, 64, 127], 1_100)
    })
    view.rerender(dialogTree({ ...view.props, currentTick: 45 }))
    act(() => {
      input.send([0x80, 66, 0], 1_250)
      input.send([0x80, 66, 0], 1_250)
    })
    expect(onUpdateRecordedNote).not.toHaveBeenCalled()
    expect(screen.getByText(/2 active · 45t/)).toBeTruthy()

    view.rerender(dialogTree({ ...view.props, currentTick: 52 }))
    act(() => input.send([0xb0, 64, 0], 1_600))
    expect(onUpdateRecordedNote.mock.calls).toEqual([
      ['sustain-1', { gateTicks: 12 }],
      ['sustain-2', { gateTicks: 12 }],
    ])
    expect(screen.getByText(/0 active · 52t/)).toBeTruthy()
  })

  it('finalizes on explicit disarm, then rejects stale and newly locked-track messages', async () => {
    Object.defineProperty(window, 'myAPI', {
      configurable: true,
      value: { midi: { open: vi.fn() } } as unknown as Window['myAPI'],
    })
    const input = new FakeMidiInput()
    installMidiAccess(input)
    vi.spyOn(performance, 'now').mockReturnValue(1_200)
    const onUpdateRecordedNote = vi.fn()
    const view = renderDialog({ onUpdateRecordedNote })
    fireEvent.click(screen.getByRole('button', { name: 'Connect MIDI device' }))
    await waitFor(() => expect(input.open).toHaveBeenCalledTimes(1))
    act(() => input.send([0x90, 66, 100], 1_000))
    view.rerender(dialogTree({ ...view.props, currentTick: 44 }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop recording' }))
    expect(onUpdateRecordedNote).toHaveBeenCalledWith('recorded-1', { gateTicks: 4 })
    const updatesAfterDisarm = onUpdateRecordedNote.mock.calls.length
    act(() => input.send([0x80, 66, 0]))
    expect(onUpdateRecordedNote).toHaveBeenCalledTimes(updatesAfterDisarm)

    view.rerender(dialogTree({ ...view.props, canRecord: false }))
    act(() => input.send([0x90, 66, 100], 1_000))
    expect(onUpdateRecordedNote).toHaveBeenCalledTimes(updatesAfterDisarm)
  })

  it('keeps note-off updates owned by the document callback captured at note-on', async () => {
    Object.defineProperty(window, 'myAPI', {
      configurable: true,
      value: { midi: { open: vi.fn() } } as unknown as Window['myAPI'],
    })
    const input = new FakeMidiInput()
    installMidiAccess(input)
    const ownerUpdate = vi.fn()
    const otherDocumentUpdate = vi.fn()
    const view = renderDialog({ onUpdateRecordedNote: ownerUpdate })
    fireEvent.click(screen.getByRole('button', { name: 'Connect MIDI device' }))
    await waitFor(() => expect(input.open).toHaveBeenCalledTimes(1))
    act(() => input.send([0x90, 66, 100], 1_000))
    view.rerender(dialogTree({
      ...view.props,
      currentTick: 43,
      onUpdateRecordedNote: otherDocumentUpdate,
    }))
    act(() => input.send([0x80, 66, 0], 1_150))
    expect(ownerUpdate).toHaveBeenCalledWith('recorded-1', { gateTicks: 3 })
    expect(otherDocumentUpdate).not.toHaveBeenCalled()
  })

  it('does not mutate an active marker after every destination track becomes locked', async () => {
    Object.defineProperty(window, 'myAPI', {
      configurable: true,
      value: { midi: { open: vi.fn() } } as unknown as Window['myAPI'],
    })
    const input = new FakeMidiInput()
    installMidiAccess(input)
    const onUpdateRecordedNote = vi.fn()
    const onEndRecording = vi.fn()
    const view = renderDialog({ onUpdateRecordedNote, onEndRecording })
    fireEvent.click(screen.getByRole('button', { name: 'Connect MIDI device' }))
    await waitFor(() => expect(input.open).toHaveBeenCalledTimes(1))
    act(() => input.send([0x90, 66, 100]))
    view.rerender(dialogTree({ ...view.props, currentTick: 48, canRecord: false }))
    await waitFor(() => expect(onEndRecording).toHaveBeenCalledTimes(1))
    act(() => input.send([0x80, 66, 0]))
    expect(onUpdateRecordedNote).not.toHaveBeenCalled()
  })

  it('records real elapsed note length while the transport playhead is stopped', async () => {
    Object.defineProperty(window, 'myAPI', {
      configurable: true,
      value: { midi: { open: vi.fn() } } as unknown as Window['myAPI'],
    })
    const input = new FakeMidiInput()
    installMidiAccess(input)
    const onUpdateRecordedNote = vi.fn()
    renderDialog({ currentTick: 40, onUpdateRecordedNote })
    fireEvent.click(screen.getByRole('button', { name: 'Connect MIDI device' }))
    await waitFor(() => expect(input.open).toHaveBeenCalledTimes(1))
    act(() => {
      input.send([0x90, 66, 100], 2_000)
      input.send([0x80, 66, 0], 2_250)
    })
    expect(onUpdateRecordedNote).toHaveBeenCalledWith('recorded-1', { gateTicks: 5 })
    expect(screen.getByText(/0 active · 40t/)).toBeTruthy()
    expect(liveMidiGateTicks(500, 499)).toBe(1)
    expect(liveMidiGateTicks(0, Number.MAX_SAFE_INTEGER)).toBe(10_000_000)
  })

  it('exposes modal semantics, wraps Tab, and closes with Escape', async () => {
    installMidiAccess(new FakeMidiInput())
    const onClose = vi.fn()
    renderDialog({ onClose })
    const dialog = screen.getByRole('dialog', { name: 'MIDI Studio' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    const preferred = screen.getByRole('button', { name: 'Connect MIDI device' })
    const first = screen.getByRole('button', { name: 'Close dialog' })
    const last = screen.getByRole('button', { name: 'Close' })
    await waitFor(() => expect(document.activeElement).toBe(preferred))
    last.focus()
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('disarms instead of switching devices when the selected input disconnects', async () => {
    Object.defineProperty(window, 'myAPI', {
      configurable: true,
      value: { midi: { open: vi.fn() } } as unknown as Window['myAPI'],
    })
    const selected = new FakeMidiInput('keyboard-1', 'Primary Keyboard')
    const fallback = new FakeMidiInput('keyboard-2', 'Backup Keyboard')
    const { access } = installMidiAccess(selected, fallback)
    const onBeginRecording = vi.fn()
    const onEndRecording = vi.fn()
    renderDialog({ onBeginRecording, onEndRecording })

    fireEvent.click(screen.getByRole('button', { name: 'Connect MIDI device' }))
    await waitFor(() => expect(selected.open).toHaveBeenCalledTimes(1))
    selected.state = 'disconnected'
    act(() => access.dispatchEvent(new Event('statechange')))

    await waitFor(() => expect(onEndRecording).toHaveBeenCalledTimes(1))
    expect(screen.getByText('The selected MIDI input was disconnected.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Arm recording' })).toBeTruthy()
    expect(fallback.open).not.toHaveBeenCalled()
    expect(selected.close).toHaveBeenCalledTimes(1)
  })

  it('does not arm or begin a transaction when closed during the permission request', async () => {
    Object.defineProperty(window, 'myAPI', {
      configurable: true,
      value: { midi: { open: vi.fn() } } as unknown as Window['myAPI'],
    })
    const input = new FakeMidiInput()
    const access = new EventTarget() as MIDIAccess
    Object.defineProperty(access, 'inputs', {
      value: new Map([[input.id, input as unknown as MIDIInput]]),
    })
    let resolveAccess!: (value: MIDIAccess) => void
    const pendingAccess = new Promise<MIDIAccess>((resolve) => {
      resolveAccess = resolve
    })
    Object.defineProperty(navigator, 'requestMIDIAccess', {
      configurable: true,
      value: vi.fn(() => pendingAccess),
    })
    const onBeginRecording = vi.fn()
    const onEndRecording = vi.fn()
    const onClose = vi.fn()
    renderDialog({ onBeginRecording, onEndRecording, onClose })

    fireEvent.click(screen.getByRole('button', { name: 'Connect MIDI device' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    await act(async () => {
      resolveAccess(access)
      await pendingAccess
    })

    expect(onBeginRecording).not.toHaveBeenCalled()
    expect(onEndRecording).not.toHaveBeenCalled()
    expect(input.open).not.toHaveBeenCalled()
  })

  it('finishes the recording transaction and closes the port on unmount', async () => {
    Object.defineProperty(window, 'myAPI', {
      configurable: true,
      value: { midi: { open: vi.fn() } } as unknown as Window['myAPI'],
    })
    const input = new FakeMidiInput()
    installMidiAccess(input)
    const onBeginRecording = vi.fn()
    const onEndRecording = vi.fn()
    const onUpdateRecordedNote = vi.fn()
    const view = renderDialog({ onBeginRecording, onEndRecording, onUpdateRecordedNote })

    fireEvent.click(screen.getByRole('button', { name: 'Connect MIDI device' }))
    await waitFor(() => expect(input.open).toHaveBeenCalledTimes(1))
    act(() => input.send([0x90, 66, 100]))
    view.unmount()
    act(() => input.send([0x80, 66, 0]))

    expect(onBeginRecording).toHaveBeenCalledTimes(1)
    expect(onEndRecording).toHaveBeenCalledTimes(1)
    expect(input.close).toHaveBeenCalledTimes(1)
    expect(onUpdateRecordedNote).not.toHaveBeenCalled()
  })

  it('rejects empty desktop payloads before invoking the MIDI importer', async () => {
    Object.defineProperty(window, 'myAPI', {
      configurable: true,
      value: {
        midi: {
          open: vi.fn(async () => ({
            ok: true as const,
            path: 'C:\\Music\\empty.mid',
            dataBase64: '',
          })),
        },
      } as unknown as Window['myAPI'],
    })
    const onImport = vi.fn<React.ComponentProps<typeof MidiDialog>['onImport']>()
      .mockResolvedValue(true)
    renderDialog({ onImport })

    fireEvent.click(screen.getByRole('button', { name: 'Choose MIDI file' }))
    expect(await screen.findByText(/MIDI file size must be between 1 and/)).toBeTruthy()
    expect(onImport).not.toHaveBeenCalled()
  })

  it('clears stale import warnings and Web MIDI errors when reopened', async () => {
    Object.defineProperty(window, 'myAPI', {
      configurable: true,
      value: {
        midi: {
          open: vi.fn(async () => ({
            ok: true as const,
            path: 'C:\\Music\\one-note.mid',
            dataBase64: minimalMidiBase64(),
          })),
        },
      } as unknown as Window['myAPI'],
    })
    Object.defineProperty(navigator, 'requestMIDIAccess', {
      configurable: true,
      value: vi.fn(async () => { throw new Error('permission denied') }),
    })
    const view = renderDialog({ onImport: vi.fn(async () => false) })

    fireEvent.click(screen.getByRole('button', { name: 'Choose MIDI file' }))
    expect(await screen.findByText(/wall-clock marker gates/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Connect MIDI device' }))
    expect(await screen.findByText('permission denied')).toBeTruthy()

    view.rerender(dialogTree({ ...view.props, open: false }))
    view.rerender(dialogTree({ ...view.props, open: true }))
    await waitFor(() => {
      expect(screen.queryByText(/wall-clock marker gates/i)).toBeNull()
      expect(screen.queryByText('permission denied')).toBeNull()
    })
  })

  it('blocks live connection while a desktop import operation is pending', async () => {
    let resolveOpen!: (value: { ok: false, canceled: true }) => void
    const pendingOpen = new Promise<{ ok: false, canceled: true }>((resolve) => {
      resolveOpen = resolve
    })
    const open = vi.fn(() => pendingOpen)
    Object.defineProperty(window, 'myAPI', {
      configurable: true,
      value: { midi: { open } } as unknown as Window['myAPI'],
    })
    const input = new FakeMidiInput()
    const { requestMIDIAccess } = installMidiAccess(input)
    renderDialog()

    fireEvent.click(screen.getByRole('button', { name: 'Choose MIDI file' }))
    expect(open).toHaveBeenCalledTimes(1)
    const connect = screen.getByRole('button', { name: 'Connect MIDI device' }) as HTMLButtonElement
    expect(connect.disabled).toBe(true)
    fireEvent.click(connect)
    expect(requestMIDIAccess).not.toHaveBeenCalled()
    await act(async () => {
      resolveOpen({ ok: false, canceled: true })
      await pendingOpen
    })
  })

  it('does not request Web MIDI access when the host has no recordable track', () => {
    Object.defineProperty(window, 'myAPI', {
      configurable: true,
      value: { midi: { open: vi.fn() } } as unknown as Window['myAPI'],
    })
    const input = new FakeMidiInput()
    const { requestMIDIAccess } = installMidiAccess(input)
    renderDialog({ canRecord: false })

    const connect = screen.getByRole('button', { name: 'Connect MIDI device' }) as HTMLButtonElement
    expect(connect.disabled).toBe(true)
    fireEvent.click(connect)
    expect(requestMIDIAccess).not.toHaveBeenCalled()
    expect(screen.getByText('Unlock a track to record.')).toBeTruthy()
  })
})
