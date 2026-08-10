// @vitest-environment jsdom

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { UIProvider } from '@yamada-ui/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, DEFAULT_SONG_METADATA } from '../types/timeline'
import { SongMetadataDialog, type SongMetadataDialogProps } from './SongMetadataDialog'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => ({
      'studio.song_metadata_title': 'Song Metadata',
      'studio.song_metadata_song_title': 'Song title',
      'studio.song_metadata_author': 'Author',
      'studio.song_metadata_original_author': 'Original author',
      'studio.song_metadata_description_field': 'Description',
      'studio.song_metadata_loop_enabled': 'Loop enabled',
      'studio.song_metadata_loop_disabled': 'Loop disabled',
      'studio.song_metadata_loop_start': 'Loop start tick',
      'studio.song_metadata_loop_end': 'Loop end tick',
      'studio.song_metadata_loop_count': 'Times to loop',
      'studio.song_metadata_advanced_show': 'Show advanced NBS fields',
      'studio.song_metadata_advanced_hide': 'Hide advanced NBS fields',
      'studio.song_metadata_source_file': 'Original source file',
      'studio.song_metadata_autosave_enabled': 'NBS autosave: on',
      'studio.song_metadata_autosave_disabled': 'NBS autosave: off',
      'studio.song_metadata_autosave_duration': 'NBS autosave interval',
      'studio.song_metadata_minutes_spent': 'Minutes spent',
      'studio.song_metadata_left_clicks': 'Left clicks',
      'studio.song_metadata_right_clicks': 'Right clicks',
      'studio.song_metadata_blocks_added': 'Blocks added',
      'studio.song_metadata_blocks_removed': 'Blocks removed',
      'studio.song_metadata_loop_range_error': `Invalid loop range ${String(values?.max)}`,
      'studio.song_metadata_loop_count_error': `Invalid loop count ${String(values?.max)}`,
      'studio.song_metadata_apply': 'Apply song info',
      'studio.song_metadata_cancel': 'Cancel',
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

afterEach(cleanup)

function renderDialog(overrides: Partial<SongMetadataDialogProps> = {}) {
  const props: SongMetadataDialogProps = {
    open: true,
    metadata: { ...DEFAULT_SONG_METADATA, title: 'Before', minutesSpent: 12 },
    loop: { ...DEFAULT_SETTINGS.loop, enabled: true, startTick: 10, endTick: 180 },
    lengthTicks: 200,
    onApply: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
  return {
    props,
    ...render(<UIProvider><SongMetadataDialog {...props} /></UIProvider>),
  }
}

describe('SongMetadataDialog', () => {
  it('returns credits and finite loop settings through exactly one undoable apply callback', async () => {
    const onApply = vi.fn()
    const onClose = vi.fn()
    renderDialog({ onApply, onClose })

    fireEvent.change(screen.getByLabelText('Song title'), { target: { value: 'After' } })
    fireEvent.change(screen.getByLabelText('Author'), { target: { value: 'Composer' } })
    fireEvent.change(screen.getByLabelText('Loop start tick'), { target: { value: '20' } })
    fireEvent.change(screen.getByLabelText('Loop end tick'), { target: { value: '160' } })
    fireEvent.change(screen.getByLabelText('Times to loop'), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply song info' }))

    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1))
    expect(onApply).toHaveBeenCalledWith({
      metadata: expect.objectContaining({ title: 'After', author: 'Composer', minutesSpent: 12 }),
      loop: { enabled: true, startTick: 20, endTick: 160, maxLoopCount: 3 },
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('blocks invalid loop ranges and counts before invoking the host', () => {
    const onApply = vi.fn()
    renderDialog({ onApply })
    fireEvent.change(screen.getByLabelText('Loop start tick'), { target: { value: '190' } })
    fireEvent.change(screen.getByLabelText('Loop end tick'), { target: { value: '180' } })
    expect(screen.getByRole('alert').textContent).toMatch(/Invalid loop range/)
    expect((screen.getByRole('button', { name: 'Apply song info' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(screen.getByLabelText('Loop end tick'), { target: { value: '200' } })
    fireEvent.change(screen.getByLabelText('Times to loop'), { target: { value: '256' } })
    expect(screen.getByRole('alert').textContent).toMatch(/Invalid loop count/)
    fireEvent.click(screen.getByRole('button', { name: 'Apply song info' }))
    expect(onApply).not.toHaveBeenCalled()
  })

  it('keeps imported NBS statistics read-only in the advanced section', () => {
    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Show advanced NBS fields' }))
    const minutes = screen.getByLabelText('Minutes spent') as HTMLInputElement
    expect(minutes.value).toBe('12')
    expect(minutes.readOnly).toBe(true)
    fireEvent.change(minutes, { target: { value: '999' } })
    expect(minutes.value).toBe('12')
  })
})
