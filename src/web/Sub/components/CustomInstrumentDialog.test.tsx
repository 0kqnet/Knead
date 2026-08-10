// @vitest-environment jsdom

import React from 'react'
import { webcrypto } from 'node:crypto'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { UIProvider } from '@yamada-ui/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createDefaultTimelineState } from '../hooks/useTimeline'
import type { ProjectCustomInstrument, TimelineState } from '../types/timeline'
import { projectCustomInstrumentsFromNbs } from '../utils/customInstruments'
import { CustomInstrumentDialog, type CustomInstrumentDialogProps } from './CustomInstrumentDialog'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => ({
      'studio.custom_instrument_title': 'Custom Instrument Studio',
      'studio.custom_instrument_default_name': 'Custom Instrument',
      'studio.custom_instrument_add': '+ Instrument',
      'studio.custom_instrument_list': 'Instrument list',
      'studio.custom_instrument_empty': 'No instruments',
      'studio.custom_instrument_select_index': `Select instrument ${String(values?.index)}`,
      'studio.custom_instrument_name': 'Display name',
      'studio.custom_instrument_sound_id': 'Sound ID',
      'studio.custom_instrument_file': 'NBS file',
      'studio.custom_instrument_source_key': 'Source key',
      'studio.custom_instrument_default_pitch': 'Default pitch',
      'studio.custom_instrument_press_key': 'Press key',
      'studio.custom_instrument_attach_replace': 'Attach or replace',
      'studio.custom_instrument_delete': 'Delete instrument',
      'studio.custom_instrument_apply': 'Apply instruments',
      'studio.custom_instrument_attached': `Attached ${String(values?.file)}`,
      'studio.custom_instrument_delete_referenced': `Used by ${String(values?.count)} markers`,
      'studio.cancel': 'Cancel',
    }[key] ?? key),
  }),
}))

beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
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

function definition(id = 'lead', soundId = 'knead:custom/lead'): ProjectCustomInstrument {
  return {
    id, kind: 'audio', soundId, name: 'Lead', file: 'lead.ogg',
    key: 45, pressKey: true, defaultPitch: 1,
  }
}

function project(instrument?: ProjectCustomInstrument): TimelineState {
  const state = createDefaultTimelineState()
  state.projectId = `project-${instrument?.id ?? 'empty'}`
  state.customInstruments = instrument ? [instrument] : []
  return state
}

function installApi(open: () => Promise<unknown>): void {
  Object.defineProperty(window, 'myAPI', {
    configurable: true,
    value: {
      referenceAudio: { open },
    },
  })
}

function renderDialog(overrides: Partial<CustomInstrumentDialogProps> = {}) {
  const props: CustomInstrumentDialogProps = {
    open: true,
    project: project(),
    onApply: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
  return {
    props,
    ...render(<UIProvider><CustomInstrumentDialog {...props} /></UIProvider>),
  }
}

describe('CustomInstrumentDialog', () => {
  it('authors a definition and commits one project-sized update', async () => {
    installApi(async () => ({ ok: false, canceled: true }))
    const onApply = vi.fn()
    renderDialog({ onApply })
    fireEvent.click(screen.getByRole('button', { name: '+ Instrument' }))
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Epic Lead' } })
    fireEvent.change(screen.getByLabelText('Sound ID'), { target: { value: 'knead:custom/epic' } })
    fireEvent.change(screen.getByLabelText('NBS file'), { target: { value: 'instruments/epic.ogg' } })
    fireEvent.change(screen.getByLabelText('Source key'), { target: { value: '40' } })
    fireEvent.change(screen.getByLabelText('Default pitch'), { target: { value: '0.75' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply instruments' }))
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1))
    expect(onApply.mock.calls[0][0].customInstruments).toMatchObject([{
      kind: 'audio', name: 'Epic Lead', soundId: 'knead:custom/epic',
      file: 'instruments/epic.ogg', key: 40, defaultPitch: 0.75,
    }])
  })

  it('attaches and cryptographically prepares a portable Ogg before apply', async () => {
    const ogg = Uint8Array.of(0x4f, 0x67, 0x67, 0x53, 1, 2, 3, 4)
    installApi(async () => ({
      ok: true, path: 'C:/audio/new.ogg', fileName: 'new.ogg', mimeType: 'audio/ogg',
      byteLength: ogg.byteLength,
      dataBase64: btoa(String.fromCharCode(...ogg)),
    }))
    const onApply = vi.fn()
    renderDialog({ project: project(definition()), onApply })
    fireEvent.click(screen.getByRole('button', { name: 'Attach or replace' }))
    await screen.findByText('Attached new.ogg')
    expect((screen.getByLabelText('NBS file') as HTMLInputElement).value).toBe('new.ogg')
    fireEvent.click(screen.getByRole('button', { name: 'Apply instruments' }))
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1))
    expect(onApply.mock.calls[0][0].customAudio).toMatchObject([{
      soundId: 'knead:custom/lead', fileName: 'new.ogg', mimeType: 'audio/ogg', byteLength: 8,
    }])
    expect(onApply.mock.calls[0][0].customAudio[0].fingerprint).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('keeps exact functional instruments read-only and non-audio', () => {
    installApi(async () => ({ ok: false, canceled: true }))
    const protectedDefinition = projectCustomInstrumentsFromNbs([
      { name: 'Tempo Changer', file: '', key: 45, pressKey: false },
    ], 16)[0]
    renderDialog({ project: project(protectedDefinition) })
    expect((screen.getByLabelText('Display name') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText('Sound ID') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Delete instrument' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole('button', { name: 'Attach or replace' })).toBeNull()
  })

  it('drops a pending picker result after the project prop changes', async () => {
    let resolvePicker!: (value: unknown) => void
    installApi(() => new Promise((resolve) => {
      resolvePicker = resolve
    }))
    const first = project(definition('first', 'knead:custom/first'))
    const second = project(definition('second', 'knead:custom/second'))
    const onApply = vi.fn()
    const view = renderDialog({ project: first, onApply })
    fireEvent.click(screen.getByRole('button', { name: 'Attach or replace' }))
    view.rerender(<UIProvider><CustomInstrumentDialog {...view.props} project={second} /></UIProvider>)
    resolvePicker({
      ok: true, path: 'late.ogg', fileName: 'late.ogg', mimeType: 'audio/ogg',
      byteLength: 4, dataBase64: 'T2dnUw==',
    })
    await waitFor(() => expect((screen.getByLabelText('Sound ID') as HTMLInputElement).value).toBe('knead:custom/second'))
    expect(screen.queryByText('Attached late.ogg')).toBeNull()
    expect(onApply).not.toHaveBeenCalled()
  })

  it('does not apply or set stale state after unmounting a pending picker', async () => {
    let resolvePicker!: (value: unknown) => void
    installApi(() => new Promise((resolve) => {
      resolvePicker = resolve
    }))
    const onApply = vi.fn()
    const view = renderDialog({ project: project(definition()), onApply })
    fireEvent.click(screen.getByRole('button', { name: 'Attach or replace' }))
    view.unmount()
    resolvePicker({
      ok: true, path: 'late.ogg', fileName: 'late.ogg', mimeType: 'audio/ogg',
      byteLength: 4, dataBase64: 'T2dnUw==',
    })
    await Promise.resolve()
    expect(onApply).not.toHaveBeenCalled()
  })
})
