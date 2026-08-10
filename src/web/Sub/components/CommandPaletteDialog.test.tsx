// @vitest-environment jsdom

import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { UIProvider } from '@yamada-ui/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CommandPaletteDialog, type CommandPaletteDialogProps } from './CommandPaletteDialog'
import type { CommandPaletteCommand } from '../utils/commandPalette'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key: string, values?: Record<string, unknown>) => ({
      'studio.command_palette_title': 'Command Palette',
      'studio.command_palette_commands': 'Commands',
      'studio.command_palette_shortcuts': 'Shortcuts',
      'studio.command_palette_close': 'Close command palette',
      'studio.command_palette_search': 'Search commands',
      'studio.command_palette_search_commands': 'Search actions…',
      'studio.command_palette_search_shortcuts': 'Find a shortcut…',
      'studio.command_palette_recent': 'Recent',
      'studio.command_palette_results': 'Command results',
      'studio.command_palette_normalized': `Omitted ${String(values?.count)}`,
      'studio.command_palette_no_results': 'No matching commands.',
      'studio.command_palette_disabled': 'Unavailable',
      'studio.command_palette_running': 'Running…',
      'studio.command_palette_ran': `Ran ${String(values?.command)}.`,
      'studio.command_palette_failed': `${String(values?.command)} failed: ${String(values?.error)}`,
      'studio.command_palette_hint': 'Type to search',
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
  if (!window.requestAnimationFrame) {
    window.requestAnimationFrame = callback => window.setTimeout(() => callback(performance.now()), 0)
    window.cancelAnimationFrame = handle => window.clearTimeout(handle)
  }
})

afterEach(() => {
  cleanup()
  window.sessionStorage.clear()
  document.getElementById('palette-test-outside')?.remove()
  vi.restoreAllMocks()
})

function commands(): CommandPaletteCommand[] {
  return [{
    id: 'file.open',
    label: 'Open project',
    description: 'Open a project from disk',
    category: 'File',
    shortcut: 'Ctrl+O',
    run: vi.fn(),
  }, {
    id: 'file.save',
    label: 'Save project',
    description: 'Save the current project',
    category: 'File',
    shortcut: 'Ctrl+S',
    disabled: true,
    disabledReason: 'Choose a project before saving',
    run: vi.fn(),
  }, {
    id: 'view.player',
    label: 'Open Player Mode',
    description: 'Show the presentation player',
    category: 'View',
    run: vi.fn(),
  }]
}

function renderDialog(overrides: Partial<CommandPaletteDialogProps> = {}) {
  const componentProps: CommandPaletteDialogProps = {
    open: true,
    commands: commands(),
    closeOnRun: false,
    onClose: vi.fn(),
    ...overrides,
  }
  const rendered = render(<UIProvider><CommandPaletteDialog {...componentProps} /></UIProvider>)
  return { ...rendered, props: componentProps }
}

function deferred() {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

describe('CommandPaletteDialog', () => {
  it('searches categories, runs the selected host callback, and records a bounded recent command', async () => {
    const values = commands()
    const { unmount } = renderDialog({ commands: values })
    const search = screen.getByRole('combobox', { name: 'Search commands' })
    await waitFor(() => expect(document.activeElement).toBe(search))
    expect(screen.getByRole('listbox', { name: 'Command results' })).toBeTruthy()
    expect(screen.getByText('FILE')).toBeTruthy()
    expect(screen.getByText('VIEW')).toBeTruthy()

    fireEvent.change(search, { target: { value: 'open project' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    fireEvent.keyDown(search, { key: 'Enter' })
    await waitFor(() => expect(values[0].run).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('status').textContent).toContain('Ran Open project')
    unmount()

    renderDialog({ commands: values })
    expect(await screen.findByText('RECENT')).toBeTruthy()
    expect(screen.getAllByRole('option')[0].textContent).toContain('Open project')
  })

  it('supports arrow, Home/End, Enter, disabled reasons, and Escape', async () => {
    const values = commands()
    const { props: componentProps } = renderDialog({ commands: values })
    const search = screen.getByRole('combobox', { name: 'Search commands' })
    await waitFor(() => expect(document.activeElement).toBe(search))

    fireEvent.keyDown(search, { key: 'ArrowDown' })
    expect(search.getAttribute('aria-activedescendant')).toMatch(/-1$/)
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(values[1].run).not.toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toContain('Choose a project before saving')

    fireEvent.keyDown(search, { key: 'End' })
    expect(search.getAttribute('aria-activedescendant')).toMatch(/-2$/)
    fireEvent.keyDown(search, { key: 'Enter' })
    await waitFor(() => expect(values[2].run).toHaveBeenCalledTimes(1))
    fireEvent.keyDown(search, { key: 'Home' })
    expect(search.getAttribute('aria-activedescendant')).toMatch(/-0$/)
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(componentProps.onClose).toHaveBeenCalledTimes(1)
  })

  it('keeps the keyboard-selected option visible', async () => {
    const values = Array.from({ length: 20 }, (_, index): CommandPaletteCommand => ({
      id: `command.${index}`,
      label: `Command ${index}`,
      description: `Run command ${index}`,
      category: 'Tools',
      run: vi.fn(),
    }))
    renderDialog({ commands: values })
    const search = screen.getByRole('combobox', { name: 'Search commands' })
    await waitFor(() => expect(document.activeElement).toBe(search))
    const lastOption = screen.getAllByRole('option').at(-1)
    expect(lastOption).toBeTruthy()
    const scrollIntoView = vi.fn()
    Object.defineProperty(lastOption, 'scrollIntoView', { configurable: true, value: scrollIntoView })

    fireEvent.keyDown(search, { key: 'End' })

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' }))
    expect(lastOption?.getAttribute('aria-selected')).toBe('true')
  })

  it('switches to shortcut discovery and keeps disabled commands explanatory', async () => {
    const values = commands()
    renderDialog({ commands: values })
    fireEvent.click(screen.getByRole('button', { name: 'Shortcuts' }))
    const list = screen.getByRole('listbox', { name: 'Command results' })
    expect(within(list).getAllByRole('option')).toHaveLength(2)
    expect(within(list).queryByText('Open Player Mode')).toBeNull()
    expect(within(list).getByText('Ctrl+O')).toBeTruthy()

    const search = screen.getByRole('combobox', { name: 'Search commands' })
    expect(search.getAttribute('placeholder')).toBe('Find a shortcut…')
    fireEvent.change(search, { target: { value: 'ctrl s' } })
    const save = within(list).getByRole('option', { name: /Save project/ })
    fireEvent.click(save)
    expect(values[1].run).not.toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toContain('Choose a project before saving')
  })

  it('traps focus and keeps callback failures inline without closing', async () => {
    const outside = document.createElement('button')
    outside.id = 'palette-test-outside'
    outside.textContent = 'Outside'
    document.body.append(outside)
    const failing = commands()
    failing[0].run = vi.fn(async () => {
      throw new Error('host denied action')
    })
    const { props: componentProps } = renderDialog({ commands: failing })
    const search = screen.getByRole('combobox', { name: 'Search commands' })
    const commandsButton = screen.getByRole('button', { name: 'Commands' })
    await waitFor(() => expect(document.activeElement).toBe(search))

    fireEvent.keyDown(search, { key: 'Tab' })
    expect(document.activeElement).toBe(commandsButton)
    fireEvent.keyDown(commandsButton, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(search)
    fireEvent.keyDown(search, { key: 'Enter' })
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('host denied action'))
    expect(componentProps.onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Command Palette' })).toBeTruthy()
  })

  it('ignores an async completion from an earlier open generation', async () => {
    const first = deferred()
    const second = deferred()
    const onClose = vi.fn()
    const firstRun = vi.fn(() => first.promise)
    const secondRun = vi.fn(() => second.promise)
    const palette = (open: boolean, run: () => Promise<void>) => (
      <UIProvider>
        <CommandPaletteDialog
          open={open}
          commands={[{
            id: 'file.save',
            label: 'Save project',
            description: 'Save the current project',
            category: 'File',
            run,
          }]}
          onClose={onClose}
        />
      </UIProvider>
    )
    const { rerender } = render(palette(true, firstRun))
    let search = screen.getByRole('combobox', { name: 'Search commands' })
    await waitFor(() => expect(document.activeElement).toBe(search))
    fireEvent.keyDown(search, { key: 'Enter' })
    await waitFor(() => expect(firstRun).toHaveBeenCalledTimes(1))

    rerender(palette(false, firstRun))
    rerender(palette(true, secondRun))
    search = screen.getByRole('combobox', { name: 'Search commands' })
    await waitFor(() => expect(document.activeElement).toBe(search))
    fireEvent.keyDown(search, { key: 'Enter' })
    await waitFor(() => expect(secondRun).toHaveBeenCalledTimes(1))
    expect(screen.getByText('Running…')).toBeTruthy()

    await act(async () => {
      first.resolve()
      await first.promise
    })
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByText('Running…')).toBeTruthy()

    await act(async () => {
      second.resolve()
      await second.promise
    })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
