// @vitest-environment jsdom

import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { UIProvider } from '@yamada-ui/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { DocumentCloseDialog } from './DocumentCloseDialog'
import { SongTabBar, type SongTabBarProps } from './SongTabBar'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => ({
      'studio.song_tabs': 'Open songs',
      'studio.song_tab_unsaved': 'Unsaved',
      'studio.song_tab_saving': 'Saving',
      'studio.song_tab_new': 'New song tab',
      'studio.recent_songs_open': 'Open recent songs',
      'studio.recent_songs_short': 'Recent',
      'studio.song_tab_close_named': `Close ${String(values?.name)}`,
      'studio.song_tab_close_title': 'Save changes?',
      'studio.song_tab_close_message': `Save changes to ${String(values?.name)}?`,
      'studio.song_tab_discard': 'Don\'t Save',
      'studio.cancel': 'Cancel',
      'studio.save': 'Save',
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

const tabs: SongTabBarProps['tabs'] = [
  { id: 'a', label: 'Alpha.kp', dirty: true, status: 'ready' },
  { id: 'b', label: 'Beta.kp', dirty: false, status: 'ready' },
  { id: 'c', label: 'Loading.kp', dirty: false, status: 'audio-switching' },
]

function provider(node: React.ReactNode) {
  return render(
    <UIProvider disableEnvironment disableGlobalStyle disableResetStyle>{node}</UIProvider>,
  )
}

describe('SongTabBar', () => {
  it('exposes dirty state and activates tabs with roving keyboard focus', () => {
    const onActivate = vi.fn()
    provider(
      <SongTabBar
        tabs={tabs} activeId="a" onActivate={onActivate} onClose={vi.fn()} onNew={vi.fn()}
      />,
    )
    const alpha = screen.getByRole('tab', { name: 'Unsaved Alpha.kp' })
    const beta = screen.getByRole('tab', { name: 'Beta.kp' })
    expect(alpha.getAttribute('aria-selected')).toBe('true')
    expect(alpha.textContent).toContain('* Alpha.kp')
    alpha.focus()
    fireEvent.keyDown(alpha, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(beta)
    fireEvent.click(beta)
    expect(onActivate).toHaveBeenCalledWith('b')
  })

  it('keeps close controls independent and blocks switching while audio changes', () => {
    const onClose = vi.fn()
    provider(
      <SongTabBar
        tabs={tabs} activeId="a" onActivate={vi.fn()} onClose={onClose} onNew={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Close Beta.kp' }))
    expect(onClose).toHaveBeenCalledWith('b')
    expect(screen.getByRole('tab', { name: 'Loading.kp' }).hasAttribute('disabled')).toBe(true)
  })

  it('exposes the optional recent-song control next to tabs', () => {
    const onOpenRecent = vi.fn()
    provider(
      <SongTabBar
        tabs={tabs} activeId="a" onActivate={vi.fn()} onClose={vi.fn()}
        onNew={vi.fn()} onOpenRecent={onOpenRecent}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open recent songs' }))
    expect(onOpenRecent).toHaveBeenCalledTimes(1)
  })
})

describe('DocumentCloseDialog', () => {
  it('offers Save, Don\'t Save and Cancel and honors Escape', () => {
    const onSave = vi.fn()
    const onDiscard = vi.fn()
    const onCancel = vi.fn()
    provider(
      <DocumentCloseDialog
        open name="Alpha.kp" onSave={onSave} onDiscard={onDiscard} onCancel={onCancel}
      />,
    )
    expect(screen.getByRole('dialog', { name: 'Save changes?' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    fireEvent.click(screen.getByRole('button', { name: 'Don\'t Save' }))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onDiscard).toHaveBeenCalledTimes(1)
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
