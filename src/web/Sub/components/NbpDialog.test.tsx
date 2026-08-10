// @vitest-environment jsdom

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { UIProvider } from '@yamada-ui/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_MASTER, DEFAULT_SETTINGS, createDefaultTrack, type TimelineState } from '../types/timeline'
import { parseNbp } from '../utils/nbp'
import { NbpDialog } from './NbpDialog'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'studio.nbp_title': 'Note Block Pattern',
      'studio.nbp_choose_file': 'Choose .nbp file',
      'studio.nbp_save_selection': 'Save selected pattern',
      'studio.close': 'Close',
    }[key] ?? key),
  }),
}))

const officialV1Base64 = 'AQ4AAgAPADB8MXwyfDM5fDEwMHwxNDB8NXwxfDJ8MzR8MTAwfDYwfC01fC0xfDJ8MHwzfDU2fDEwMHwxMDB8MHwtMXwyfDF8M3w0NnwxMDB8MTQwfDV8MXwzfDQxfDEwMHw2MHwtNXwtMXwyfDB8M3w1NnwxMDB8MTAwfDB8LTF8MnwxfDJ8Mzl8MTAwfDE0MHw1fDF8MnwzNHwxMDB8NjB8LTV8LTF8MnwwfDN8NTZ8MTAwfDEwMHwwfC0xfDJ8MXwzfDQ2fDEwMHwxNDB8NXwxfDN8NDF8MTAwfDYwfC01fC0xfDJ8MHwzfDU2fDEwMHwxMDB8MHwtMXwAAQL//wAA//8BAv//AAD//wEC//8AAP//AQL//wAA'

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
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

const originalApi = Object.getOwnPropertyDescriptor(window, 'myAPI')

afterEach(() => {
  cleanup()
  if (originalApi) Object.defineProperty(window, 'myAPI', originalApi)
  else Reflect.deleteProperty(window, 'myAPI')
})

function project(): TimelineState {
  const track = createDefaultTrack('track')
  return {
    projectId: 'pattern', randomSeed: 1, targetVersion: '1.21.4', lengthTicks: 200,
    settings: structuredClone(DEFAULT_SETTINGS), master: { ...DEFAULT_MASTER }, tracks: [track],
    markers: [{
      id: 'marker', trackId: track.id, tick: 10, soundId: 'block.note_block.harp',
      variantIndex: -1, volume: 0.75, pitch: 1, pan: 0,
    }],
  }
}

function renderDialog(source: TimelineState, onInsert = vi.fn()) {
  const props: React.ComponentProps<typeof NbpDialog> = {
    open: true,
    project: source,
    selectedIds: new Set(['marker']),
    defaultName: 'test-pattern',
    currentTick: 20,
    targetVersion: '1.21.4',
    onInsert,
    onReplace: vi.fn(async () => true),
    onClose: vi.fn(),
  }
  render(<UIProvider><NbpDialog {...props} /></UIProvider>)
  return props
}

describe('NbpDialog', () => {
  it('exposes a translated modal label and closes with Escape', () => {
    const props = renderDialog(project())
    const dialog = screen.getByRole('dialog', { name: 'Note Block Pattern' })
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(props.onClose).toHaveBeenCalledTimes(1)
  })

  it('imports an official NBP pattern at the playhead on appended tracks', async () => {
    const onInsert = vi.fn()
    Object.defineProperty(window, 'myAPI', {
      configurable: true,
      value: {
        nbp: {
          open: vi.fn(async () => ({ ok: true, path: 'Drum Example.nbp', dataBase64: officialV1Base64 })),
          save: vi.fn(),
        },
      } as unknown as Window['myAPI'],
    })
    renderDialog(project(), onInsert)
    fireEvent.click(screen.getByRole('button', { name: 'Choose .nbp file' }))
    await waitFor(() => expect(onInsert).toHaveBeenCalledTimes(1))
    const [state, selected] = onInsert.mock.calls[0] as [TimelineState, readonly string[]]
    expect(state.tracks).toHaveLength(4)
    expect(state.markers).toHaveLength(13)
    expect(state.markers.slice(1).map(marker => marker.tick)).toEqual([20, 20, 22, 24, 24, 26, 28, 28, 30, 32, 32, 34])
    expect(selected).toHaveLength(12)
  })

  it('exports the selected markers as a valid NBP v2 file', async () => {
    const save = vi.fn(async (defaultName: string, dataBase64: string) => {
      void defaultName
      void dataBase64
      return { ok: true as const, path: 'test-pattern.nbp' }
    })
    Object.defineProperty(window, 'myAPI', {
      configurable: true,
      value: {
        nbp: { open: vi.fn(), save },
      } as unknown as Window['myAPI'],
    })
    renderDialog(project())
    fireEvent.click(screen.getByRole('button', { name: 'Save selected pattern' }))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    const [name, base64] = save.mock.calls[0] as [string, string]
    expect(name).toBe('test-pattern.nbp')
    const binary = atob(base64)
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
    const parsed = parseNbp(bytes)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.pattern.version).toBe(2)
    expect(parsed.pattern.notes).toEqual([
      { tick: 0, layer: 0, instrument: 0, key: 45, velocity: 75, panning: 100, pitch: 0 },
    ])
  })
})
