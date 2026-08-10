// @vitest-environment jsdom

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { UIProvider } from '@yamada-ui/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ResourcePackDialog } from './ResourcePackDialog'
import { clearProjectCustomAudio, getProjectCustomAudioSnapshot } from '../utils/projectCustomAudio'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => ({
      'studio.resource_pack_title': 'Java Resource-pack Sounds',
      'studio.resource_pack_description': 'Import sounds.json and audio.',
      'studio.resource_pack_layers': 'Pack priority',
      'studio.resource_pack_priority_hint': 'Lowest first; highest last.',
      'studio.resource_pack_add': 'Add .zip pack',
      'studio.resource_pack_empty': 'Add a pack.',
      'studio.resource_pack_layer_summary': `format ${String(values?.format)} · ${String(values?.assets)} audio`,
      'studio.resource_pack_move_lower': 'Move to lower priority',
      'studio.resource_pack_move_higher': 'Move to higher priority',
      'studio.resource_pack_remove': `Remove ${String(values?.name)}`,
      'studio.resource_pack_install': 'Install sound library',
      'studio.resource_pack_added': `Added ${String(values?.name)}`,
      'studio.resource_pack_duplicate': `${String(values?.name)} is already present`,
      'studio.resource_pack_installed': `Installed ${String(values?.sounds)} sounds`,
      'studio.resource_pack_error': `Resource-pack error: ${String(values?.error)}`,
      'studio.resource_pack_no_playable': 'No playable sounds',
      'studio.resource_pack_budget_error': 'Shared 96 MiB budget exceeded',
      'studio.resource_pack_warnings': `Warnings ${String(values?.count)}`,
      'studio.resource_pack_more_warnings': `${String(values?.count)} more`,
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

const encoder = new TextEncoder()

let table: Uint32Array | undefined
function crc32(data: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256)
    for (let index = 0; index < 256; index++) {
      let value = index
      for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1
      table[index] = value >>> 0
    }
  }
  let value = 0xffffffff
  for (const byte of data) value = table[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

function zip(files: Record<string, string | Uint8Array>): Uint8Array {
  const local: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const [path, value] of Object.entries(files)) {
    const name = encoder.encode(path)
    const data = typeof value === 'string' ? encoder.encode(value) : value
    const crc = crc32(data)
    const header = new Uint8Array(30)
    const headerView = new DataView(header.buffer)
    headerView.setUint32(0, 0x04034b50, true)
    headerView.setUint16(4, 20, true)
    headerView.setUint16(6, 0x0800, true)
    headerView.setUint32(14, crc, true)
    headerView.setUint32(18, data.length, true)
    headerView.setUint32(22, data.length, true)
    headerView.setUint16(26, name.length, true)
    local.push(header, name, data)

    const directory = new Uint8Array(46)
    const directoryView = new DataView(directory.buffer)
    directoryView.setUint32(0, 0x02014b50, true)
    directoryView.setUint16(4, 0x0314, true)
    directoryView.setUint16(6, 20, true)
    directoryView.setUint16(8, 0x0800, true)
    directoryView.setUint32(16, crc, true)
    directoryView.setUint32(20, data.length, true)
    directoryView.setUint32(24, data.length, true)
    directoryView.setUint16(28, name.length, true)
    directoryView.setUint32(38, 0x81a40000, true)
    directoryView.setUint32(42, offset, true)
    central.push(directory, name)
    offset += header.length + name.length + data.length
  }
  const centralData = concat(central)
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, Object.keys(files).length, true)
  endView.setUint16(10, Object.keys(files).length, true)
  endView.setUint32(12, centralData.length, true)
  endView.setUint32(16, offset, true)
  return concat([...local, centralData, end])
}

function base64(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data))
}

const ogg = Uint8Array.of(0x4f, 0x67, 0x67, 0x53, 1, 2, 3, 4)
const wav = Uint8Array.of(
  0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0,
  0x57, 0x41, 0x56, 0x45, 1, 2, 3, 4,
)

function pack(audioPath: string, audio: Uint8Array, pitch: number): Uint8Array {
  return zip({
    'pack.mcmeta': JSON.stringify({ pack: { pack_format: 34, description: 'Test' } }),
    'assets/example/sounds.json': JSON.stringify({ kick: { replace: true, sounds: [{ name: 'kick', pitch }] } }),
    [audioPath]: audio,
  })
}

function renderDialog(onInstall = vi.fn(), referenceAudioBytes = 0, onClose = vi.fn()) {
  render(
    <UIProvider>
      <ResourcePackDialog
        open existingCustomAudio={[]} referenceAudioBytes={referenceAudioBytes}
        onInstall={onInstall} onClose={onClose}
      />
    </UIProvider>,
  )
  return onInstall
}

describe('ResourcePackDialog', () => {
  it('exposes a translated modal label and closes with Escape', () => {
    const onClose = vi.fn()
    renderDialog(vi.fn(), 0, onClose)
    const dialog = screen.getByRole('dialog', { name: 'Java Resource-pack Sounds' })
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('adds packs, lets the user change precedence, and installs portable playable assets', async () => {
    const base = pack('assets/example/sounds/kick.ogg', ogg, 0.75)
    const high = pack('assets/example/sounds/kick.wav', wav, 1.25)
    const open = vi.fn()
      .mockResolvedValueOnce({ ok: true, path: 'base.zip', dataBase64: base64(base) })
      .mockResolvedValueOnce({ ok: true, path: 'high.zip', dataBase64: base64(high) })
    Object.defineProperty(window, 'myAPI', {
      configurable: true,
      value: { resourcePack: { open } } as unknown as Window['myAPI'],
    })
    const onInstall = renderDialog()

    fireEvent.click(screen.getByRole('button', { name: 'Add .zip pack' }))
    await screen.findByText('base.zip')
    fireEvent.click(screen.getByRole('button', { name: 'Add .zip pack' }))
    await screen.findByText('high.zip')

    // Move high.zip below base.zip, making base.zip the final/highest layer.
    fireEvent.click(screen.getAllByRole('button', { name: 'Move to lower priority' })[1])
    fireEvent.click(screen.getByRole('button', { name: 'Install sound library' }))

    await waitFor(() => expect(onInstall).toHaveBeenCalledTimes(1))
    const [assets, summary] = onInstall.mock.calls[0]
    expect(assets).toHaveLength(1)
    expect(assets[0]).toMatchObject({
      soundId: 'example:kick', mimeType: 'audio/ogg', pitch: 0.75,
    })
    expect(summary).toMatchObject({ soundCount: 1, variantCount: 1, assetCount: 1 })
    expect(summary.sounds[0].variants[0]).toMatchObject({ pitch: 0.75, volume: 1, weight: 1 })
    expect(getProjectCustomAudioSnapshot().manifest['example:kick']).toHaveLength(1)
  }, 10_000)

  it('rejects an install that exceeds the shared reference/custom audio budget', async () => {
    const data = pack('assets/example/sounds/kick.ogg', ogg, 1)
    Object.defineProperty(window, 'myAPI', {
      configurable: true,
      value: {
        resourcePack: { open: vi.fn(async () => ({ ok: true, path: 'pack.zip', dataBase64: base64(data) })) },
      } as unknown as Window['myAPI'],
    })
    const onInstall = renderDialog(vi.fn(), 96 * 1024 * 1024)
    fireEvent.click(screen.getByRole('button', { name: 'Add .zip pack' }))
    await screen.findByText('pack.zip')
    fireEvent.click(screen.getByRole('button', { name: 'Install sound library' }))
    await screen.findByText(/Shared 96 MiB budget exceeded/)
    expect(onInstall).not.toHaveBeenCalled()
    expect(getProjectCustomAudioSnapshot().manifest).toEqual({})
  })
})
