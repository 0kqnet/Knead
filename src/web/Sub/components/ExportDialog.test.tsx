// @vitest-environment jsdom

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { UIProvider } from '@yamada-ui/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AudioExportRequest } from '../../../../@types/global'
import {
  createDefaultTrack,
  DEFAULT_MASTER,
  DEFAULT_SETTINGS,
  type TimelineState,
} from '../types/timeline'
import { ExportDialog } from './ExportDialog'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => ({
      'studio.audio_export': 'Audio Export',
      'studio.audio_export_mix': 'Mix',
      'studio.audio_export_stems': 'Stems',
      'studio.audio_export_sample_rate': 'Sample rate',
      'studio.audio_export_sample_rate_preset': 'Sample-rate preset',
      'studio.audio_export_sample_rate_hz': 'Custom sample rate in hertz',
      'studio.audio_export_custom_rate': 'Custom',
      'studio.audio_export_channels': 'Channels',
      'studio.audio_export_mono': 'Mono',
      'studio.audio_export_stereo': 'Stereo',
      'studio.audio_export_bit_depth': 'Bit depth',
      'studio.audio_export_integer_bit': `${values?.bits}-bit integer`,
      'studio.audio_export_32_bit_float': '32-bit float',
      'studio.audio_export_ogg_quality': 'Ogg quality',
      'studio.audio_export_mp3_bitrate': 'MP3 bitrate',
      'studio.audio_export_selecting_destination': 'Choosing destination',
      'studio.audio_export_failed': 'Export failed',
      'studio.audio_export_complete': 'Complete',
      'studio.audio_export_error_ogg_sample_rate': 'Ogg rate is too high',
      'studio.format': 'Format',
      'studio.output': 'Output',
      'studio.range': 'Range',
      'studio.project_range': 'Whole project',
      'studio.loop_range': 'Loop range',
      'studio.advanced': 'Advanced settings',
      'studio.include_tails': 'Include tails',
      'studio.include_muted': 'Include muted tracks',
      'studio.export_start': 'Export',
      'studio.close': 'Close',
      'studio.cancel': 'Cancel',
    }[key] ?? key),
  }),
}))

function project(): TimelineState {
  return {
    projectId: 'project',
    randomSeed: 1,
    targetVersion: '1.21.4',
    lengthTicks: 20,
    settings: structuredClone(DEFAULT_SETTINGS),
    master: { ...DEFAULT_MASTER },
    tracks: [],
    markers: [],
  }
}

function renderDialog(value = project(), onClose = vi.fn()) {
  return render(
    <UIProvider>
      <ExportDialog
        open
        project={value}
        defaultName="show"
        soundManifest={{}}
        onClose={onClose}
      />
    </UIProvider>,
  )
}

beforeEach(() => {
  localStorage.clear()
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
})

describe('ExportDialog', () => {
  it('exposes a translated modal label and closes with Escape', () => {
    const onClose = vi.fn()
    renderDialog(project(), onClose)
    const dialog = screen.getByRole('dialog', { name: 'Audio Export' })
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('exports FLAC at 384 kHz in mono through the existing request path', async () => {
    localStorage.setItem('studio.exportOptions', JSON.stringify({
      format: 'flac',
      sampleRate: 384_000,
      channels: 1,
      wavBitDepth: 24,
    }))
    const start = vi.fn(async (request: AudioExportRequest) => {
      void request
      return { ok: false as const, canceled: true as const }
    })
    const onProgress = vi.fn(async () => vi.fn())
    Object.defineProperty(window, 'myAPI', {
      configurable: true,
      value: { audioExport: { start, onProgress, cancel: vi.fn() } } as unknown as Window['myAPI'],
    })

    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: /Advanced settings/ }))
    expect((screen.getByLabelText('Custom sample rate in hertz') as HTMLInputElement).value)
      .toBe('384000')
    expect(screen.getByLabelText('Channels').textContent).toContain('Mono')
    fireEvent.click(screen.getByRole('button', { name: 'Export' }))

    await waitFor(() => expect(start).toHaveBeenCalledTimes(1))
    expect(start.mock.calls[0][0].options).toMatchObject({
      format: 'flac', sampleRate: 384_000, channels: 1, wavBitDepth: 24,
    })
  })

  it('blocks a codec-incompatible Ogg rate before opening the desktop picker', () => {
    localStorage.setItem('studio.exportOptions', JSON.stringify({
      format: 'ogg',
      sampleRate: 48_000,
    }))
    Object.defineProperty(window, 'myAPI', {
      configurable: true,
      value: {
        audioExport: { start: vi.fn(), onProgress: vi.fn(), cancel: vi.fn() },
      } as unknown as Window['myAPI'],
    })

    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: /Advanced settings/ }))
    fireEvent.change(screen.getByLabelText('Custom sample rate in hertz'), {
      target: { value: '384000' },
    })
    expect(screen.getByRole('alert').textContent).toContain('Ogg rate is too high')
    expect((screen.getByRole('button', { name: 'Export' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('offers AIFF and FLAC without removing the existing formats', async () => {
    Object.defineProperty(window, 'myAPI', {
      configurable: true,
      value: {
        audioExport: { start: vi.fn(), onProgress: vi.fn(), cancel: vi.fn() },
      } as unknown as Window['myAPI'],
    })
    renderDialog()
    fireEvent.click(screen.getByLabelText('Format'))
    fireEvent.click(await screen.findByRole('option', { name: 'AIFF' }))
    expect(JSON.parse(localStorage.getItem('studio.exportOptions') ?? '{}').format).toBe('aiff')
    fireEvent.click(screen.getByLabelText('Format'))
    fireEvent.click(await screen.findByRole('option', { name: 'FLAC' }))
    expect(JSON.parse(localStorage.getItem('studio.exportOptions') ?? '{}').format).toBe('flac')
  })

  it('does not treat a Sound Stopper empty soundId as a missing audio asset', async () => {
    const track = createDefaultTrack('stop-track')
    const value = project()
    value.tracks = [track]
    value.markers = [{
      id: 'stopper',
      trackId: track.id,
      tick: 4,
      soundId: '',
      variantIndex: -1,
      volume: 1,
      pitch: 1,
      action: { type: 'sound-stop', scope: 'all' },
    }]
    const start = vi.fn(async () => ({ ok: false as const, canceled: true as const }))
    Object.defineProperty(window, 'myAPI', {
      configurable: true,
      value: {
        audioExport: {
          start,
          onProgress: vi.fn(async () => vi.fn()),
          cancel: vi.fn(),
        },
      } as unknown as Window['myAPI'],
    })

    renderDialog(value)
    const button = screen.getByRole('button', { name: 'Export' }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1))
  })
})
