// @vitest-environment jsdom

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { UIProvider } from '@yamada-ui/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultTrack, DEFAULT_MASTER, DEFAULT_SETTINGS, type TimelineState } from '../types/timeline'
import { NoteBlockBuildDialog } from './NoteBlockBuildDialog'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      const translations: Record<string, string> = {
        'studio.note_block_build_title': 'Minecraft note-block build export',
        'studio.note_block_build_description': 'Export OpenNBS-compatible files.',
        'studio.note_block_build_circuit': 'Build mode',
        'studio.note_block_build_circuit_display': 'Static placement',
        'studio.note_block_build_circuit_playable': 'Playable redstone',
        'studio.note_block_build_format': 'Format',
        'studio.note_block_build_format_structure': 'Structure Block .nbt (size header capped at 32)',
        'studio.note_block_build_format_exact': 'Litematica-compatible exact-size Structure .nbt',
        'studio.note_block_build_format_111': 'Legacy .schematic (1.11–1.12)',
        'studio.note_block_build_format_pre111': 'Legacy .schematic (pre-1.11)',
        'studio.note_block_build_exact_warning': 'This writes an exact-size vanilla Structure .nbt for Litematica import. It is not a native .litematic file.',
        'studio.note_block_build_layout': 'Layout',
        'studio.note_block_build_layout_fixed': 'Fixed track lanes',
        'studio.note_block_build_layout_grid': 'Wrapped schematic grid',
        'studio.note_block_build_include_locked': 'Include locked tracks',
        'studio.note_block_build_static_warning': 'Static placement only: no redstone circuitry is generated.',
        'studio.note_block_build_playable_warning': 'Playable redstone uses an OpenNBS-style 2-game-tick grid.',
        'studio.note_block_build_row_nodes': 'Delay nodes per row',
        'studio.note_block_build_save': 'Export build',
        'studio.close': 'Close',
        'studio.export_generation_status': 'Export generation status',
        'studio.export_generation_progress': 'Generating export',
        'studio.cancel_generation': 'Cancel generation',
        'studio.export_generation_canceled': 'Generation canceled.',
      }
      if (key === 'studio.note_block_build_saved') return `Saved: ${String(values?.path ?? '')}`
      if (key === 'studio.note_block_build_error') return `Export failed: ${String(values?.error ?? '')}`
      if (key === 'studio.note_block_build_summary') return `${String(values?.notes)} note blocks`
      if (key === 'studio.note_block_build_timing_summary') {
        return `${String(values?.quantum)}-tick grid · ${String(values?.nodes)} delay nodes`
      }
      return translations[key] ?? String(values?.defaultValue ?? key)
    },
  }),
}))

function project(soundId = 'block.note_block.harp'): TimelineState {
  const track = createDefaultTrack('track')
  return {
    projectId: 'project',
    randomSeed: 1,
    targetVersion: '1.21.4',
    lengthTicks: 20,
    settings: structuredClone(DEFAULT_SETTINGS),
    master: { ...DEFAULT_MASTER },
    tracks: [track],
    markers: [{
      id: 'marker', trackId: track.id, tick: 0, soundId,
      variantIndex: -1, volume: 1, pitch: 1,
    }],
  }
}

function renderDialog(
  state = project(),
  onClose = vi.fn(),
) {
  return render(
    <UIProvider>
      <NoteBlockBuildDialog open project={state} defaultName="My Build.litematic" onClose={onClose} />
    </UIProvider>,
  )
}

beforeEach(() => {
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
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('NoteBlockBuildDialog', () => {
  it('labels exact-size Structure NBT honestly and saves deterministic GZIP bytes', async () => {
    const save = vi.fn(async (...args: [string, string, string]) => {
      void args
      return { ok: true as const, path: 'C:\\builds\\My Build.nbt' }
    })
    Object.defineProperty(window, 'myAPI', {
      configurable: true,
      value: { noteBlockBuild: { save } },
    })
    renderDialog()

    expect(screen.getAllByText('Litematica-compatible exact-size Structure .nbt').length).toBeGreaterThan(0)
    expect(screen.getByText(/not a native \.litematic file/i)).toBeTruthy()
    expect(screen.getByText(/Static placement only/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Export build' }))

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    const [name, format, base64] = save.mock.calls[0]
    expect(name).toBe('My Build.nbt')
    expect(format).toBe('litematica-compatible-nbt')
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0))
    expect([...bytes.slice(0, 10)]).toEqual([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 0xff])
    expect(await screen.findByText('1 note blocks')).toBeTruthy()
    expect(await screen.findByText('Saved: C:\\builds\\My Build.nbt')).toBeTruthy()
  })

  it('surfaces an unknown sound instead of silently writing an empty build', async () => {
    const save = vi.fn()
    Object.defineProperty(window, 'myAPI', {
      configurable: true,
      value: { noteBlockBuild: { save } },
    })
    renderDialog(project('custom:unknown_sound'))

    fireEvent.click(screen.getByRole('button', { name: 'Export build' }))

    expect(await screen.findByText(/custom:unknown_sound/)).toBeTruthy()
    expect(save).not.toHaveBeenCalled()
  })

  it('exports the playable circuit with explicit physical timing metadata', async () => {
    const save = vi.fn(async (...args: [string, string, string]) => {
      void args
      return { ok: true as const, path: 'C:\\builds\\playable.nbt' }
    })
    Object.defineProperty(window, 'myAPI', {
      configurable: true,
      value: { noteBlockBuild: { save } },
    })
    renderDialog()

    fireEvent.click(screen.getByRole('button', { name: 'Playable redstone' }))
    expect(screen.getByText(/OpenNBS-style 2-game-tick grid/)).toBeTruthy()
    expect(screen.getByLabelText('Delay nodes per row')).toBeTruthy()
    expect(screen.queryByText('Legacy .schematic (1.11–1.12)')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Export build' }))

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(await screen.findByText(/2-tick grid · 1 delay nodes/)).toBeTruthy()
    const [, format] = save.mock.calls[0]
    expect(format).toBe('litematica-compatible-nbt')
  })

  it('takes initial focus and closes with Escape when no save is active', async () => {
    const onClose = vi.fn()
    Object.defineProperty(window, 'myAPI', {
      configurable: true,
      value: { noteBlockBuild: { save: vi.fn() } },
    })
    renderDialog(project(), onClose)
    const initial = screen.getByRole('button', { name: 'Static placement' })
    await waitFor(() => expect(document.activeElement).toBe(initial))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('cancels generation without opening the native save dialog', async () => {
    class HangingWorker {
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: ErrorEvent) => void) | null = null
      onmessageerror: ((event: MessageEvent) => void) | null = null
      postMessage = vi.fn()
      terminate = vi.fn()
    }
    vi.stubGlobal('Worker', HangingWorker)
    const save = vi.fn()
    Object.defineProperty(window, 'myAPI', {
      configurable: true,
      value: { noteBlockBuild: { save } },
    })
    const onClose = vi.fn()
    renderDialog(project(), onClose)

    fireEvent.click(screen.getByRole('button', { name: 'Export build' }))
    expect(await screen.findByRole('progressbar', { name: 'Generating export' })).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel generation' }))

    expect(await screen.findByText('Generation canceled.')).toBeTruthy()
    expect(save).not.toHaveBeenCalled()
  })
})
