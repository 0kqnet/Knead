// @vitest-environment jsdom

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { UIProvider } from '@yamada-ui/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { NbsDialog } from './NbsDialog'
import { nbsToTimelineState, writeNbs, type NbsSong } from '../utils/nbs'
import { parseNbsBundle, writeNbsBundleWithWarnings } from '../utils/nbsBundle'
import { clearProjectCustomAudio, getProjectCustomAudioSnapshot } from '../utils/projectCustomAudio'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => ({
      'studio.nbs_compatibility': 'Note Block Studio Compatibility',
      'studio.nbs_description': 'NBS and zipped songs.',
      'studio.nbs_import': 'Import NBS',
      'studio.nbs_import_hint': 'Choose a plain or portable song.',
      'studio.nbs_choose_file': 'Choose .nbs file',
      'studio.nbs_choose_bundle': 'Choose zipped song (.zip)',
      'studio.nbs_export': 'Export NBS',
      'studio.nbs_export_hint': 'Choose plain or portable output.',
      'studio.nbs_export_button': 'Export .nbs',
      'studio.nbs_export_bundle_button': 'Export song + sounds (.zip)',
      'studio.nbs_imported': `Imported: ${String(values?.details ?? '')}`,
      'studio.nbs_bundle_imported': `Imported portable song: ${String(values?.details ?? '')}`,
      'studio.nbs_exported': `Saved: ${String(values?.path ?? '')}`,
      'studio.nbs_bundle_exported': `Saved ${String(values?.count ?? '')}: ${String(values?.path ?? '')}`,
      'studio.nbs_error': `NBS error: ${String(values?.error ?? '')}`,
      'studio.close': 'Close',
    }[key] ?? key),
  }),
}))

beforeAll(() => {
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
  clearProjectCustomAudio()
  vi.restoreAllMocks()
})

const ogg = Uint8Array.of(0x4f, 0x67, 0x67, 0x53, 1, 2, 3, 4)

function song(): NbsSong {
  return {
    header: {
      version: 5,
      vanillaInstrumentCount: 16,
      songLength: 1,
      layerCount: 1,
      name: 'Portable',
      author: '',
      originalAuthor: '',
      description: '',
      tempo: 1000,
      autoSave: false,
      autoSaveDuration: 10,
      timeSignature: 4,
      minutesSpent: 0,
      leftClicks: 0,
      rightClicks: 0,
      blocksAdded: 1,
      blocksRemoved: 0,
      sourceFile: '',
      loop: false,
      maxLoopCount: 0,
      loopStartTick: 0,
    },
    notes: [{
      tick: 0, layer: 0, instrument: 16, key: 45,
      velocity: 100, panning: 100, pitch: 0,
    }],
    layers: [{ name: 'Lead', locked: false, volume: 100, panning: 100 }],
    customInstruments: [{ name: 'Lead', file: 'lead.ogg', key: 45, pressKey: true }],
  }
}

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

function decode(value: string): Uint8Array {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0))
}

function renderDialog(overrides: Partial<React.ComponentProps<typeof NbsDialog>> = {}) {
  const project = nbsToTimelineState(song(), '1.21.4').state
  const props: React.ComponentProps<typeof NbsDialog> = {
    open: true,
    project,
    defaultName: 'portable',
    targetVersion: '1.21.4',
    soundManifest: {},
    onImport: vi.fn(async () => true),
    onClose: vi.fn(),
    ...overrides,
  }
  return {
    props,
    ...render(<UIProvider><NbsDialog {...props} /></UIProvider>),
  }
}

describe('NbsDialog zipped songs', () => {
  it('exposes a translated modal label and closes with Escape', () => {
    const { props } = renderDialog()
    const dialog = screen.getByRole('dialog', { name: 'Note Block Studio Compatibility' })
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('imports mapped audio into the portable project payload and runtime registry', async () => {
    const bundle = writeNbsBundleWithWarnings(writeNbs(song(), 5), [{ file: 'lead.ogg', data: ogg }])
    const openBundle = vi.fn(async () => ({
      ok: true as const,
      path: 'C:\\Music\\portable.zip',
      dataBase64: encode(bundle.data),
    }))
    Object.defineProperty(window, 'myAPI', {
      configurable: true,
      value: {
        nbs: { openBundle, open: vi.fn(), save: vi.fn(), saveBundle: vi.fn() },
      } as unknown as Window['myAPI'],
    })
    const onImport = vi.fn<React.ComponentProps<typeof NbsDialog>['onImport']>().mockResolvedValue(true)
    const onClose = vi.fn()
    renderDialog({ onImport, onClose })

    fireEvent.click(screen.getByRole('button', { name: 'Choose zipped song (.zip)' }))

    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1))
    const [state, warnings, sourcePath] = onImport.mock.calls[0]
    expect(sourcePath).toBe('C:\\Music\\portable.zip')
    expect(state.customAudio).toHaveLength(1)
    expect(state.customAudio?.[0]).toMatchObject({
      soundId: 'nbs:custom/lead',
      fileName: 'lead.ogg',
      mimeType: 'audio/ogg',
      byteLength: ogg.byteLength,
    })
    expect(warnings.join('\n')).not.toMatch(/need matching sounds/i)
    await waitFor(() => expect(getProjectCustomAudioSnapshot().manifest['nbs:custom/lead']).toHaveLength(1))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('exports an OpenNBS-compatible bundle with the available sound variant bytes', async () => {
    const saveBundle = vi.fn(async (defaultName: string, dataBase64: string) => {
      void defaultName
      void dataBase64
      return { ok: true as const, path: 'C:\\Music\\portable.zip' }
    })
    const getMcSoundData = vi.fn(async () => ogg.slice().buffer)
    Object.defineProperty(window, 'myAPI', {
      configurable: true,
      value: {
        get_mcSoundData: getMcSoundData,
        nbs: { openBundle: vi.fn(), open: vi.fn(), save: vi.fn(), saveBundle },
      } as unknown as Window['myAPI'],
    })
    renderDialog({
      soundManifest: {
        'nbs:custom/lead': [{ path: 'lead.ogg', hash: 'minecraft-hash', pitch: 1 }],
      },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Export song + sounds (.zip)' }))

    await waitFor(() => expect(saveBundle).toHaveBeenCalledTimes(1))
    expect(getMcSoundData).toHaveBeenCalledWith('minecraft-hash')
    const [name, encoded] = saveBundle.mock.calls[0]
    expect(name).toBe('portable.zip')
    const parsed = await parseNbsBundle(decode(encoded))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.audio).toHaveLength(1)
      expect(parsed.audio[0].data).toEqual(ogg)
    }
  })

  it('prefers an authored stable soundId when its NBS file/name differ from that ID', async () => {
    const authoredOgg = Uint8Array.of(0x4f, 0x67, 0x67, 0x53, 9, 8, 7, 6)
    const saveBundle = vi.fn(async (defaultName: string, dataBase64: string) => {
      void defaultName
      void dataBase64
      return { ok: true as const, path: 'C:\\Music\\authored.zip' }
    })
    const getMcSoundData = vi.fn(async (hash: string) => (
      hash === 'authored-hash' ? authoredOgg.slice().buffer : ogg.slice().buffer
    ))
    Object.defineProperty(window, 'myAPI', {
      configurable: true,
      value: {
        get_mcSoundData: getMcSoundData,
        nbs: { openBundle: vi.fn(), open: vi.fn(), save: vi.fn(), saveBundle },
      } as unknown as Window['myAPI'],
    })
    const authored = nbsToTimelineState(song(), '1.21.4').state
    authored.customInstruments = authored.customInstruments?.map(instrument => ({
      ...instrument,
      soundId: instrument.kind === 'audio' ? 'knead:custom/epic_lead' : instrument.soundId,
      name: instrument.kind === 'audio' ? 'Epic Lead' : instrument.name,
      file: instrument.kind === 'audio' ? 'instruments/epic.ogg' : instrument.file,
    }))
    authored.markers = authored.markers.map(marker => ({ ...marker, soundId: 'knead:custom/epic_lead' }))
    renderDialog({
      project: authored,
      soundManifest: {
        'knead:custom/epic_lead': [{ path: 'source.ogg', hash: 'authored-hash', pitch: 1 }],
        'nbs:custom/instruments/epic': [{ path: 'fallback.ogg', hash: 'fallback-hash', pitch: 1 }],
      },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Export song + sounds (.zip)' }))
    await waitFor(() => expect(saveBundle).toHaveBeenCalledTimes(1))
    expect(getMcSoundData).toHaveBeenCalledWith('authored-hash')
    expect(getMcSoundData).not.toHaveBeenCalledWith('fallback-hash')
    const parsed = await parseNbsBundle(decode(saveBundle.mock.calls[0][1]))
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.song.customInstruments[0]).toMatchObject({
        name: 'Epic Lead', file: 'instruments/epic.ogg', key: 45, pressKey: true,
      })
      expect(parsed.audio[0].data).toEqual(authoredOgg)
    }
  })
})
