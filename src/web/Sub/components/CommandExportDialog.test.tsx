// @vitest-environment jsdom

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { UIProvider } from '@yamada-ui/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CommandExportRequest } from '../../../../@types/global'
import { createDefaultTrack, DEFAULT_MASTER, DEFAULT_SETTINGS, type TimelineState } from '../types/timeline'
import { CommandExportDialog } from './CommandExportDialog'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { path?: string }) => ({
      'studio.command_export': 'Minecraft Data Pack Export',
      'studio.command_export_description': 'Export a show.',
      'studio.command_audience': 'Audience',
      'studio.audience_all': 'All players',
      'studio.audience_nearby': 'Nearby players',
      'studio.audience_custom': 'Custom selector',
      'studio.nearby_radius': 'Radius (blocks)',
      'studio.command_pan_mode': 'Pan positioning',
      'studio.command_pan_world': 'World position',
      'studio.command_pan_listener': 'Listener-relative stereo',
      'studio.command_pan_width': 'Stereo width (blocks)',
      'studio.command_pan_world_hint': 'World position omits pan.',
      'studio.command_pan_listener_hint': 'Each listener receives their own facing-relative sound.',
      'studio.command_pan_listener_legacy_hint': 'Listener stereo unavailable for this target.',
      'studio.command_visualizer': 'OpenNBS visualizer',
      'studio.command_visualizer_type': 'Visualizer type',
      'studio.command_visualizer_off': 'Off',
      'studio.command_visualizer_arc': 'Arc',
      'studio.command_visualizer_fall': 'Fall',
      'studio.command_visualizer_rise': 'Rise',
      'studio.command_visualizer_bounce': 'Bounce',
      'studio.command_visualizer_pianoRoll': 'Piano Roll',
      'studio.command_visualizer_fountain': 'Fountain',
      'studio.command_visualizer_rittaiOnkyou': 'Rittai Onkyou',
      'studio.command_visualizer_origin': 'Visualizer origin',
      'studio.command_visualizer_placement': 'Facing',
      'studio.command_visualizer_placement_north': 'North',
      'studio.command_visualizer_placement_south': 'South',
      'studio.command_visualizer_placement_east': 'East',
      'studio.command_visualizer_placement_west': 'West',
      'studio.command_visualizer_glow': 'Glow',
      'studio.command_visualizer_density': 'Particle density',
      'studio.command_visualizer_scale': 'Scale',
      'studio.command_visualizer_color': 'Block color mapping',
      'studio.command_visualizer_color_track': 'By track',
      'studio.command_visualizer_color_sound': 'By sound',
      'studio.command_visualizer_color_pitch': 'By pitch',
      'studio.command_visualizer_hint': 'Visualizer cleanup hint.',
      'studio.repeat_playback': 'Repeat selected range',
      'studio.pause_resume_hint': 'Pause keeps the event position.',
      'studio.copy_commands': 'Copy controls',
      'studio.copied': 'Copied',
      'studio.close': 'Close',
      'studio.export_datapack': 'Export ZIP',
      'studio.export_companion_resource_pack': 'Export resource ZIP',
      'studio.command_export_saved': `Saved: ${values?.path ?? ''}`,
      'studio.command_resource_pack_saved': `Resource saved: ${values?.path ?? ''}`,
      'studio.export_generation_status': 'Export generation status',
      'studio.export_generation_progress': 'Generating export',
      'studio.cancel_generation': 'Cancel generation',
      'studio.export_generation_canceled': 'Generation canceled.',
      'studio.retry': 'Retry',
    }[key] ?? key),
  }),
}))

function project(): TimelineState {
  const track = createDefaultTrack('track')
  return {
    projectId: 'project',
    randomSeed: 1,
    targetVersion: '1.21.4',
    lengthTicks: 40,
    settings: structuredClone(DEFAULT_SETTINGS),
    master: { ...DEFAULT_MASTER },
    tracks: [track],
    markers: [{
      id: 'marker',
      trackId: track.id,
      tick: 0,
      soundId: 'block.note_block.harp',
      variantIndex: -1,
      volume: 1,
      pitch: 1,
    }],
  }
}

function renderDialog(state = project(), onClose = vi.fn()) {
  return render(
    <UIProvider>
      <CommandExportDialog open project={state} defaultName="My Show" onClose={onClose} />
    </UIProvider>,
  )
}

async function waitForEnabledButton(name: string): Promise<HTMLButtonElement> {
  const button = screen.getByRole('button', { name }) as HTMLButtonElement
  await waitFor(() => expect(button.disabled).toBe(false))
  return button
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
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('CommandExportDialog', () => {
  it('exposes a named modal, takes initial focus, and closes with Escape', async () => {
    const onClose = vi.fn()
    renderDialog(project(), onClose)
    const dialog = screen.getByRole('dialog', { name: 'Minecraft Data Pack Export' })
    const initial = dialog.querySelector<HTMLElement>('[data-dialog-initial-focus]')
    await waitFor(() => expect(document.activeElement).toBe(initial))
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('shows and copies the full playback control surface', async () => {
    const writeText = vi.fn(async (text: string) => {
      void text
    })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    renderDialog()

    expect(await screen.findByText('/function knead_show:start')).toBeTruthy()
    expect(screen.getByText('/function knead_show:pause')).toBeTruthy()
    expect(screen.getByText('/function knead_show:resume')).toBeTruthy()
    expect(screen.getByText('/function knead_show:stop')).toBeTruthy()
    expect(screen.getByText('/function knead_show:uninstall')).toBeTruthy()

    fireEvent.click(await waitForEnabledButton('Copy controls'))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1))
    expect(writeText.mock.calls[0][0]).toContain('/function knead_show:pause')
    expect(writeText.mock.calls[0][0]).toContain('/function knead_show:uninstall')
  })

  it('persists repeat and nearby options into the exported data pack', async () => {
    localStorage.setItem('studio.commandExportOptions', JSON.stringify({
      audience: 'nearby',
      nearbyRadius: 12,
      loopPlayback: true,
      position: '10 64 -2',
    }))
    const save = vi.fn(async (request: CommandExportRequest) => {
      void request
      return { ok: true as const, path: 'C:\\Shows\\knead_show.zip' }
    })
    Object.defineProperty(window, 'myAPI', {
      configurable: true,
      value: { commandExport: { save } } as unknown as Window['myAPI'],
    })
    renderDialog()

    expect(screen.getAllByText('Nearby players').length).toBeGreaterThan(0)
    fireEvent.click(await waitForEnabledButton('Export ZIP'))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))

    const request = save.mock.calls[0][0]
    expect(request.defaultName).toBe('knead_show.zip')
    expect(request.files['data/knead_show/function/runtime/finish.mcfunction']).toContain(
      'function knead_show:runtime/repeat',
    )
    expect(request.files['data/knead_show/function/runtime/repeat.mcfunction']).toContain(
      'scoreboard players set #tick',
    )
    expect(request.files['data/knead_show/function/events/tick_0.mcfunction']).toContain(
      '@a[distance=..12]',
    )
    const report = request.files['knead-export-report.json']
    expect(JSON.parse(typeof report === 'string' ? report : '')).toEqual(expect.objectContaining({
      schemaVersion: 1,
      namespace: 'knead_show',
    }))
    expect(screen.getByLabelText('studio.command_diagnostics_title')).toBeTruthy()
  })

  it('loads bounded visualizer options and exports glow, placement, and cleanup', async () => {
    localStorage.setItem('studio.commandExportOptions', JSON.stringify({
      visualizerType: 'fountain',
      visualizerOrigin: '10 70 -2',
      visualizerPlacement: 'east',
      visualizerGlow: true,
      visualizerDensity: 4,
      visualizerScale: 1.5,
      visualizerColorMapping: 'sound',
    }))
    const save = vi.fn(async (request: CommandExportRequest) => {
      void request
      return { ok: true as const, path: 'C:\\Shows\\visual.zip' }
    })
    Object.defineProperty(window, 'myAPI', {
      configurable: true,
      value: { commandExport: { save } } as unknown as Window['myAPI'],
    })
    renderDialog()

    expect(screen.getByLabelText('Visualizer type')).toBeTruthy()
    expect(screen.getByLabelText('Visualizer origin')).toHaveProperty('value', '10 70 -2')
    expect(screen.getByRole('button', { name: 'Glow' })).toBeTruthy()
    fireEvent.click(await waitForEnabledButton('Export ZIP'))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))

    const files = save.mock.calls[0][0].files
    const tick = files['data/knead_show/function/events/tick_0.mcfunction']
    expect(tick).toContain('execute positioned 10 70 -2 run summon minecraft:falling_block')
    expect(tick).toContain('Glowing:1b')
    expect(tick).toContain('0.05 0.05 0.05 0 4 force @a')
    expect(files['data/knead_show/function/pause.mcfunction']).toContain(
      'function knead_show:runtime/visual_cleanup',
    )
    expect(files['data/knead_show/function/runtime/visual_cleanup.mcfunction']).toContain(
      'tag=knv_',
    )
  })

  it('makes listener-relative stereo an explicit persisted opt-in', async () => {
    localStorage.setItem('studio.commandExportOptions', JSON.stringify({
      panMode: 'listener',
      listenerPanWidth: 3,
    }))
    const state = project()
    state.markers[0].pan = 0.5
    const save = vi.fn(async (request: CommandExportRequest) => {
      void request
      return { ok: true as const, path: 'C:\\Shows\\stereo.zip' }
    })
    Object.defineProperty(window, 'myAPI', {
      configurable: true,
      value: { commandExport: { save } } as unknown as Window['myAPI'],
    })
    renderDialog(state)

    expect(screen.getByLabelText('Pan positioning')).toBeTruthy()
    expect(screen.getByLabelText('Stereo width (blocks)')).toHaveProperty('value', '3')
    expect(screen.getByText('Each listener receives their own facing-relative sound.')).toBeTruthy()
    fireEvent.click(await waitForEnabledButton('Export ZIP'))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))

    expect(save.mock.calls[0][0].files['data/knead_show/function/events/tick_0.mcfunction']).toContain(
      'as @a at @s rotated as @s anchored eyes positioned ^-1.5 ^ ^ run playsound block.note_block.harp master @s',
    )
  })

  it('states when listener-relative stereo will degrade for an old target', () => {
    localStorage.setItem('studio.commandExportOptions', JSON.stringify({ panMode: 'listener' }))
    const state = project()
    state.targetVersion = '1.12.2'
    renderDialog(state)

    expect(screen.getByText('Listener stereo unavailable for this target.')).toBeTruthy()
  })

  it('shows bounded worker progress and lets the user hard-cancel preview generation', async () => {
    class HangingWorker {
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: ((event: ErrorEvent) => void) | null = null
      onmessageerror: ((event: MessageEvent) => void) | null = null
      postMessage = vi.fn()
      terminate = vi.fn()
    }
    vi.stubGlobal('Worker', HangingWorker)
    renderDialog()

    const progress = await screen.findByRole('progressbar', { name: 'Generating export' })
    expect(Number(progress.getAttribute('aria-valuenow'))).toBeGreaterThanOrEqual(0)
    expect(Number(progress.getAttribute('aria-valuenow'))).toBeLessThanOrEqual(100)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel generation' }))

    expect(await screen.findByText('Generation canceled.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Export ZIP' })).toHaveProperty('disabled', true)
  })

  it('saves playable custom audio as a separate binary-safe resource-pack request', async () => {
    const state = project()
    const bytes = new Uint8Array(58)
    bytes.set([0x4f, 0x67, 0x67, 0x53, 0, 2], 0)
    bytes[26] = 1
    bytes[27] = 30
    bytes.set([1, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73], 28)
    const dataBase64 = btoa(String.fromCharCode(...bytes))
    state.markers[0].soundId = 'minecraft:custom/bell'
    state.customAudio = [{
      soundId: state.markers[0].soundId,
      fileName: 'bell.ogg',
      mimeType: 'audio/ogg',
      byteLength: bytes.byteLength,
      fingerprint: 'a'.repeat(64),
      dataBase64,
      pitch: 1,
    }]
    const save = vi.fn(async (request: CommandExportRequest) => {
      void request
      return { ok: true as const, path: 'C:\\Shows\\knead_show-resources.zip' }
    })
    Object.defineProperty(window, 'myAPI', {
      configurable: true,
      value: { commandExport: { save } } as unknown as Window['myAPI'],
    })
    renderDialog(state)

    fireEvent.click(await waitForEnabledButton('Export resource ZIP'))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    const request = save.mock.calls[0][0]
    expect(request.kind).toBe('resource-pack')
    expect(request.defaultName).toBe('knead_show-resources.zip')
    expect(request.files[`assets/knead_show/sounds/knead/audio/${'a'.repeat(64)}.ogg`]).toEqual({
      encoding: 'base64',
      data: dataBase64,
    })
    expect(request.files['assets/minecraft/sounds.json']).toBeUndefined()
  })
})
