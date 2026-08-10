// @vitest-environment jsdom

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { UIProvider } from '@yamada-ui/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_MASTER,
  DEFAULT_SETTINGS,
  createDefaultTrack,
  type TimelineState,
} from '../types/timeline'
import { ExtensionManagerDialog } from './ExtensionManagerDialog'
import {
  DECLARATIVE_EXTENSION_FORMAT,
  DECLARATIVE_EXTENSION_SCHEMA_VERSION,
  INSTALLED_EXTENSIONS_SETTING,
  serializeDeclarativeExtensionPackage,
  type DeclarativeExtensionPackage,
} from '../extensions'

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

const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'myAPI')

afterEach(() => {
  cleanup()
  if (originalApiDescriptor) Object.defineProperty(window, 'myAPI', originalApiDescriptor)
  else Reflect.deleteProperty(window, 'myAPI')
})

function declarativePackage(): DeclarativeExtensionPackage {
  return {
    format: DECLARATIVE_EXTENSION_FORMAT,
    schemaVersion: DECLARATIVE_EXTENSION_SCHEMA_VERSION,
    manifest: {
      apiVersion: '1',
      id: 'tests.octave-tool',
      name: 'Octave Tool',
      version: '1.0.0',
      permissions: {
        required: ['timeline.read', 'timeline.transform', 'selection.read'],
      },
      capabilities: ['markerTransforms'],
    },
    contributes: {
      markerTransforms: [{
        kind: 'markerTransform',
        id: 'octave-up',
        name: 'Octave Up',
        requiredPermissions: ['timeline.read', 'timeline.transform', 'selection.read'],
        steps: [{ op: 'transpose', semitones: 12 }],
      }],
    },
  }
}

function mockExtensionStorage() {
  const values = new Map<string, unknown>()
  const setSetting = vi.fn((key: string, value: unknown) => values.set(key, value))
  const getSetting = vi.fn(async (key: string) => values.get(key))
  Object.defineProperty(window, 'myAPI', {
    configurable: true,
    value: { getSetting, setSetting } as unknown as Window['myAPI'],
  })
  return { getSetting, setSetting }
}

function project(): TimelineState {
  const track = createDefaultTrack('track')
  return {
    projectId: 'project',
    randomSeed: 1234,
    targetVersion: '1.21.4',
    lengthTicks: 200,
    settings: structuredClone(DEFAULT_SETTINGS),
    master: { ...DEFAULT_MASTER },
    tracks: [track],
    markers: [{
      id: 'marker',
      trackId: track.id,
      tick: 20,
      soundId: 'block.note_block.harp',
      variantIndex: -1,
      volume: 1,
      pitch: 1,
      laneY: 0.5,
    }],
  }
}

function renderDialog(overrides: Partial<React.ComponentProps<typeof ExtensionManagerDialog>> = {}) {
  const source = project()
  const props: React.ComponentProps<typeof ExtensionManagerDialog> = {
    open: true,
    project: source,
    selectedIds: new Set(['marker']),
    onApply: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
  return {
    source,
    props,
    ...render(
      <UIProvider disableEnvironment disableGlobalStyle disableResetStyle>
        <ExtensionManagerDialog {...props} />
      </UIProvider>,
    ),
  }
}

async function enabledButton(name: string): Promise<HTMLButtonElement> {
  const button = screen.getByRole('button', { name }) as HTMLButtonElement
  await waitFor(() => expect(button.disabled).toBe(false))
  return button
}

describe('ExtensionManagerDialog', () => {
  it('activates trusted built-ins and applies Humanize without mutating props', async () => {
    const onApply = vi.fn()
    const { source } = renderDialog({ onApply })
    const before = structuredClone(source)
    fireEvent.click(await enabledButton('Apply Humanize'))
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1))

    const [next, nextSelectedIds] = onApply.mock.calls[0] as [TimelineState, readonly string[]]
    expect(next.markers).toHaveLength(1)
    expect(nextSelectedIds).toEqual(['marker'])
    expect(source).toEqual(before)
    expect((await screen.findByRole('status')).textContent).toContain('Humanized 1 marker.')
  }, 10_000)

  it('runs the typed major preset command and selects all generated chord voices', async () => {
    const onApply = vi.fn()
    const { source } = renderDialog({ onApply })
    fireEvent.click(await enabledButton('Create Notes'))
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1))

    const [next, nextSelectedIds] = onApply.mock.calls[0] as [TimelineState, readonly string[]]
    expect(next.markers).toHaveLength(3)
    expect(next.markers.map(marker => marker.pitch)).toEqual([1, 2 ** (4 / 12), 2 ** (7 / 12)])
    expect(nextSelectedIds).toHaveLength(3)
    expect(source.markers).toHaveLength(1)
  })

  it('disables transforms with no selection and shows a local hint', async () => {
    renderDialog({ selectedIds: new Set() })
    expect(screen.getByText('Select one or more timeline markers to run a transform.')).toBeTruthy()
    const button = screen.getByRole('button', { name: 'Apply Humanize' }) as HTMLButtonElement
    await waitFor(() => expect(button.disabled).toBe(true))
  })

  it('contains host callback errors as inline feedback', async () => {
    const onApply = vi.fn().mockRejectedValue(new Error('host refused update'))
    renderDialog({ onApply })
    fireEvent.click(await enabledButton('Apply Humanize'))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('apply: host refused update')
    expect((screen.getByRole('button', { name: 'Apply Humanize' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('installs, permission-approves, runs, persists, exposes export, and removes a JSON package', async () => {
    const storage = mockExtensionStorage()
    const onApply = vi.fn()
    const rendered = renderDialog({ onApply })
    const textarea = screen.getByRole('textbox', { name: 'Extension package JSON' })
    fireEvent.change(textarea, { target: { value: serializeDeclarativeExtensionPackage(declarativePackage()) } })
    fireEvent.click(await enabledButton('Validate JSON'))

    const preview = await screen.findByTestId('package-install-preview')
    expect(preview.textContent).toContain('Octave Tool')
    const permissionChecks = preview.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')
    expect(permissionChecks).toHaveLength(3)
    expect([...permissionChecks].every(input => input.checked)).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Install Package' }))

    const packageCard = await screen.findByTestId('extension-package-tests.octave-tool')
    expect(packageCard).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Export' })).toBeTruthy()
    await waitFor(() => expect(storage.setSetting).toHaveBeenCalledWith(
      INSTALLED_EXTENSIONS_SETTING,
      expect.stringContaining('tests.octave-tool'),
    ))

    fireEvent.click(await enabledButton('Enable'))
    fireEvent.click(await enabledButton('Apply Octave Up'))
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1))
    const [next] = onApply.mock.calls[0] as [TimelineState]
    expect(next.markers[0].pitch).toBe(2)

    rendered.rerender(
      <UIProvider disableEnvironment disableGlobalStyle disableResetStyle>
        <ExtensionManagerDialog {...rendered.props} open={false} />
      </UIProvider>,
    )
    rendered.rerender(
      <UIProvider disableEnvironment disableGlobalStyle disableResetStyle>
        <ExtensionManagerDialog {...rendered.props} open />
      </UIProvider>,
    )
    const reloadedCard = await screen.findByTestId('extension-package-tests.octave-tool')
    await waitFor(() => expect(reloadedCard.textContent).toContain('active'))

    fireEvent.click(await enabledButton('Remove'))
    fireEvent.click(await enabledButton('Confirm Remove'))
    await waitFor(() => expect(document.querySelector('[data-extension-package="tests.octave-tool"]')).toBeNull())
  })

  it('keeps a package disabled when a required grant is explicitly denied', async () => {
    mockExtensionStorage()
    renderDialog()
    fireEvent.change(screen.getByRole('textbox', { name: 'Extension package JSON' }), {
      target: { value: serializeDeclarativeExtensionPackage(declarativePackage()) },
    })
    fireEvent.click(await enabledButton('Validate JSON'))
    const preview = await screen.findByTestId('package-install-preview')
    const firstPermission = preview.querySelector<HTMLInputElement>('input[type="checkbox"]')
    if (!firstPermission) throw new Error('Permission checkbox was not rendered')
    fireEvent.click(firstPermission)
    fireEvent.click(screen.getByRole('button', { name: 'Install Package' }))
    fireEvent.click(await enabledButton('Enable'))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Required permissions were not granted')
    expect((screen.getByRole('button', { name: 'Apply Octave Up' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
