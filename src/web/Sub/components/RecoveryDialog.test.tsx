// @vitest-environment jsdom

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { UIProvider } from '@yamada-ui/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { TimelineRecoveryApi, TimelineRecoveryMetadata } from '../types/recovery'
import {
  DEFAULT_MASTER,
  DEFAULT_SETTINGS,
  DEFAULT_TIMELINE_LENGTH_TICKS,
  createDefaultTrack,
  type TimelineState,
} from '../types/timeline'
import { createTimelineRecoverySaveRequest } from '../utils/timelineRecovery'
import { RecoveryDialog } from './RecoveryDialog'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en-US' },
    t: (key: string, values?: Record<string, unknown>) => ({
      'studio.recovery_title': 'Recover unsaved projects',
      'studio.recovery_description': 'Recover work.',
      'studio.recovery_loading': 'Loading…',
      'studio.recovery_empty': 'No snapshots.',
      'studio.recovery_details': `${String(values?.updated)} · ${String(values?.size)}`,
      'studio.recovery_restore': 'Restore',
      'studio.recovery_discard': 'Discard',
      'studio.recovery_restore_named': `Restore ${String(values?.name)}`,
      'studio.recovery_discard_named': `Discard ${String(values?.name)}`,
      'studio.recovery_error': `Recovery failed: ${String(values?.error)}`,
      'studio.recovery_mismatch': 'Mismatched project.',
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
  vi.restoreAllMocks()
})

function project(): TimelineState {
  return {
    projectId: 'recovered-project',
    randomSeed: 2,
    targetVersion: '1.21.4',
    lengthTicks: DEFAULT_TIMELINE_LENGTH_TICKS,
    settings: structuredClone(DEFAULT_SETTINGS),
    master: { ...DEFAULT_MASTER },
    tracks: [createDefaultTrack('track-recovery')],
    markers: [],
    referenceAudio: [],
    customAudio: [],
  }
}

const snapshot: TimelineRecoveryMetadata = {
  id: 'opaque-snapshot-id',
  projectId: 'recovered-project',
  filePath: 'C:\\Music\\song.kp',
  updatedAt: Date.UTC(2026, 7, 10),
  fingerprint: 'fingerprint',
  byteLength: 1024,
}

function mockApi(): TimelineRecoveryApi {
  return {
    save: vi.fn(async () => ({ ok: true as const, snapshot })),
    list: vi.fn(async () => ({ ok: true as const, snapshots: [snapshot] })),
    restore: vi.fn(async () => ({
      ok: true as const,
      snapshot,
      json: createTimelineRecoverySaveRequest(project(), snapshot.filePath, snapshot.updatedAt).json,
    })),
    discard: vi.fn(async () => ({ ok: true as const })),
    clearProject: vi.fn(async () => ({ ok: true as const })),
  }
}

describe('RecoveryDialog', () => {
  it('lists and restores a validated current TimelineState', async () => {
    const api = mockApi()
    const onRestore = vi.fn<React.ComponentProps<typeof RecoveryDialog>['onRestore']>()
      .mockResolvedValue(true)
    const onClose = vi.fn()
    render(
      <UIProvider>
        <RecoveryDialog open api={api} onRestore={onRestore} onClose={onClose} />
      </UIProvider>,
    )

    await screen.findByText('song.kp')
    fireEvent.click(screen.getByRole('button', { name: 'Restore song.kp' }))
    await waitFor(() => expect(onRestore).toHaveBeenCalledTimes(1))
    expect(onRestore.mock.calls[0][0].projectId).toBe('recovered-project')
    expect(onRestore.mock.calls[0][1]).toEqual(snapshot)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('hides behind a dirty-change confirmation and stays open when restore is declined', async () => {
    const api = mockApi()
    let resolveConfirmation: ((accepted: boolean) => void) | undefined
    const onRestore = vi.fn<React.ComponentProps<typeof RecoveryDialog>['onRestore']>()
      .mockImplementation(() => new Promise<boolean>((resolve) => { resolveConfirmation = resolve }))
    const onClose = vi.fn()
    render(
      <UIProvider>
        <RecoveryDialog open api={api} onRestore={onRestore} onClose={onClose} />
      </UIProvider>,
    )

    await screen.findByText('song.kp')
    fireEvent.click(screen.getByRole('button', { name: 'Restore song.kp' }))
    await waitFor(() => expect(onRestore).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('dialog', { name: 'Recover unsaved projects' })).toBeNull()

    resolveConfirmation?.(false)
    await screen.findByRole('dialog', { name: 'Recover unsaved projects' })
    expect(screen.getByText('song.kp')).not.toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('discards one opaque snapshot without treating its source path as a target', async () => {
    const api = mockApi()
    render(
      <UIProvider>
        <RecoveryDialog open api={api} onRestore={vi.fn(() => true)} onClose={vi.fn()} />
      </UIProvider>,
    )

    await screen.findByText('song.kp')
    fireEvent.click(screen.getByRole('button', { name: 'Discard song.kp' }))
    await waitFor(() => expect(api.discard).toHaveBeenCalledWith('opaque-snapshot-id'))
    await waitFor(() => expect(screen.queryByText('song.kp')).toBeNull())
  })
})
