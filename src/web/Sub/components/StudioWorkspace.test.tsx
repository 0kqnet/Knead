// @vitest-environment jsdom

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { UIProvider } from '@yamada-ui/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TimelineCloseRequest } from '../../../../@types/global'
import type { TimelineState } from '../types/timeline'
import { parseNbs, writeNbs, type NbsSong } from '../utils/nbs'
import { RECENT_STUDIO_SONGS_KEY } from '../utils/recentStudioSongs'
import { StudioWorkspace } from './StudioWorkspace'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => ({
      'studio.song_tabs': 'Open songs',
      'studio.untitled': 'Untitled',
      'studio.song_tab_unsaved': 'Unsaved',
      'studio.song_tab_saving': 'Saving',
      'studio.song_tab_new': 'New song tab',
      'studio.song_tab_close_named': `Close ${String(values?.name)}`,
      'studio.song_tab_created': 'Song tab created',
      'studio.song_tab_activated': `Activated ${String(values?.name)}`,
      'studio.song_tab_closed': `Closed ${String(values?.name)}`,
      'studio.song_tab_close_title': 'Save changes?',
      'studio.song_tab_close_message': `Save changes to ${String(values?.name)}?`,
      'studio.song_tab_dirty_count': `${String(values?.count)} unsaved songs`,
      'studio.song_tab_discard': 'Don\'t Save',
      'studio.song_tab_switching_audio': 'Switching audio',
      'studio.song_tab_limit': 'Too many song tabs',
      'studio.cancel': 'Cancel',
      'studio.save': 'Save',
      'studio.nbs_plain_save_loss_title': 'Save lossy NBS file?',
      'studio.nbs_plain_save_loss_confirm': 'Some data will be lost.',
      'studio.open_warnings': 'Project warnings',
      'studio.open_warnings_more': `${String(values?.count)} more warnings omitted`,
      'studio.recent_songs_open': 'Open recent songs',
      'studio.recent_songs_short': 'Recent',
      'studio.recent_songs_title': 'Recent songs',
      'studio.recent_songs_clear': 'Clear recent songs',
      'studio.recent_songs_empty': 'No recent songs',
      'studio.recent_songs_open_path': `Open recent song ${String(values?.path)}`,
      'studio.close': 'Close',
    }[key] ?? key),
  }),
}))

vi.mock('../hooks/useActiveProjectAudio', () => ({
  useActiveProjectAudio: ({ projectId }: { projectId: string }) => ({
    status: 'ready',
    requestGeneration: 1,
    requestedProjectId: projectId,
    activeProjectId: projectId,
    registryGeneration: 1,
    canMountEditor: true,
  }),
}))

vi.mock('./DocumentRecoveryAgent', () => ({
  DocumentRecoveryAgent: () => null,
}))

vi.mock('./TimelineEditor', async () => {
  const { createElement } = await import('react')
  return {
    TimelineEditor: (props: {
      documentId?: string
      timelineController?: {
        state?: TimelineState
        addMarker: (input: { tick: number, soundId: string }) => string
      }
      onSaveDocument?: () => void | Promise<void>
      onSaveDocumentAs?: () => void | Promise<void>
    }) => createElement(
      'div',
      {
        'data-testid': 'timeline-editor',
        'data-document-id': props.documentId,
        'data-custom-audio-count': props.timelineController?.state?.customAudio?.length ?? 0,
        'data-project-bpm': props.timelineController?.state?.settings.bpm,
        'data-ticks-per-quarter': props.timelineController?.state?.settings.ticksPerQuarter,
      },
      createElement('button', {
        type: 'button',
        onClick: () => props.timelineController?.addMarker({ tick: 1, soundId: 'test:note' }),
      }, 'Make dirty'),
      createElement('button', {
        type: 'button',
        onClick: () => { void props.onSaveDocument?.() },
      }, 'Save document'),
      createElement('button', {
        type: 'button',
        onClick: () => { void props.onSaveDocumentAs?.() },
      }, 'Save document as'),
    ),
  }
})

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

let closeRequestHandler: ((request: TimelineCloseRequest) => void) | undefined
const releaseCurrentPath = vi.fn(async () => undefined)
const confirmClose = vi.fn(async () => undefined)
const timelineSave = vi.fn()
const timelineSaveDialog = vi.fn()
const timelineOpenPath = vi.fn()
const resolveNbsCustomAudio = vi.fn()
const bindCurrentPath = vi.fn()
const takeOpenRequests = vi.fn(async () => [] as string[])
const onCloseRequested = vi.fn(async (handler: (request: TimelineCloseRequest) => void) => {
  closeRequestHandler = handler
  return () => undefined
})

beforeEach(() => {
  window.localStorage.clear()
  closeRequestHandler = undefined
  releaseCurrentPath.mockClear()
  confirmClose.mockClear()
  onCloseRequested.mockClear()
  timelineSave.mockReset()
  timelineSaveDialog.mockReset()
  timelineOpenPath.mockReset()
  resolveNbsCustomAudio.mockReset()
  bindCurrentPath.mockReset()
  takeOpenRequests.mockReset()
  takeOpenRequests.mockResolvedValue([])
  Object.defineProperty(window, 'alert', {
    configurable: true,
    value: vi.fn(),
  })
  Object.defineProperty(window, 'myAPI', {
    configurable: true,
    value: {
      timeline: {
        save: timelineSave,
        saveDialog: timelineSaveDialog,
        openDialog: vi.fn(async () => ({ ok: false, canceled: true })),
        openPath: timelineOpenPath,
        resolveNbsCustomAudio,
        bindCurrentPath,
        releaseCurrentPath,
        takeOpenRequests,
        onOpenRequested: vi.fn(async () => () => undefined),
        onCloseRequested,
        confirmClose,
        onDragDrop: vi.fn(async () => () => undefined),
      },
      timelineRecovery: {
        list: vi.fn(async () => ({ ok: true, snapshots: [] })),
      },
    } as unknown as Window['myAPI'],
  })
})

afterEach(cleanup)

function renderWorkspace() {
  return render(
    <UIProvider>
      <StudioWorkspace defaultTargetVersion="1.21.4" />
    </UIProvider>,
  )
}

function classicNbs(tempo = 1000): Uint8Array {
  const song: NbsSong = {
    header: {
      version: 0,
      vanillaInstrumentCount: 10,
      songLength: 4,
      layerCount: 1,
      name: 'Classic',
      author: '',
      originalAuthor: '',
      description: '',
      tempo,
      autoSave: false,
      autoSaveDuration: 10,
      timeSignature: 4,
      minutesSpent: 0,
      leftClicks: 0,
      rightClicks: 0,
      blocksAdded: 1,
      blocksRemoved: 0,
      sourceFile: '',
      loop: false,
      maxLoopCount: 0,
      loopStartTick: 0,
    },
    notes: [{
      tick: 0,
      layer: 0,
      instrument: 0,
      key: 45,
      velocity: 100,
      panning: 100,
      pitch: 0,
    }],
    layers: [{ name: 'Layer', locked: false, volume: 100, panning: 100 }],
    customInstruments: [],
  }
  return writeNbs(song, 0)
}

function customAudioNbs(): Uint8Array {
  const song: NbsSong = {
    header: {
      version: 5,
      vanillaInstrumentCount: 16,
      songLength: 4,
      layerCount: 1,
      name: 'Custom audio',
      author: '',
      originalAuthor: '',
      description: '',
      tempo: 1000,
      autoSave: false,
      autoSaveDuration: 10,
      timeSignature: 4,
      minutesSpent: 0,
      leftClicks: 0,
      rightClicks: 0,
      blocksAdded: 1,
      blocksRemoved: 0,
      sourceFile: '',
      loop: false,
      maxLoopCount: 0,
      loopStartTick: 0,
    },
    notes: [{
      tick: 0,
      layer: 0,
      instrument: 16,
      key: 45,
      velocity: 100,
      panning: 100,
      pitch: 0,
    }],
    layers: [{ name: 'Layer', locked: false, volume: 100, panning: 100 }],
    customInstruments: [
      { name: 'Lead', file: 'kit/lead.ogg', key: 45, pressKey: false },
      { name: 'Sound Stopper', file: 'must-not-read.wav', key: 45, pressKey: false },
      { name: 'Tempo Changer', file: 'must-not-read.ogg', key: 45, pressKey: false },
    ],
  }
  return writeNbs(song, 5)
}

function bytesBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function arrangeClassicNbsOpen(path = 'C:\\Songs\\classic.nbs', tempo = 1000) {
  takeOpenRequests.mockResolvedValueOnce([path]).mockResolvedValue([])
  timelineOpenPath.mockResolvedValue({
    ok: true,
    path,
    kind: 'nbs',
    dataBase64: bytesBase64(classicNbs(tempo)),
  })
  bindCurrentPath.mockResolvedValue({ ok: true, path })
  return path
}

function arrangeCustomAudioNbsOpen(path = 'C:\\Songs\\custom.nbs') {
  takeOpenRequests.mockResolvedValueOnce([path]).mockResolvedValue([])
  timelineOpenPath.mockResolvedValue({
    ok: true,
    path,
    kind: 'nbs',
    dataBase64: bytesBase64(customAudioNbs()),
  })
  bindCurrentPath.mockResolvedValue({ ok: true, path })
  return path
}

describe('StudioWorkspace', () => {
  it('binds a direct NBS before resolving safe sibling sounds and keeps the hydrated load clean', async () => {
    const sourcePath = arrangeCustomAudioNbsOpen()
    const ogg = Uint8Array.of(0x4f, 0x67, 0x67, 0x53, 0, 1, 2, 3)
    resolveNbsCustomAudio.mockResolvedValue({
      ok: true,
      assets: [{
        fileName: 'kit/lead.ogg',
        mimeType: 'audio/ogg',
        byteLength: ogg.byteLength,
        dataBase64: bytesBase64(ogg),
      }],
      warnings: [],
    })
    renderWorkspace()

    const tab = await screen.findByRole('tab', { name: 'custom.nbs' })
    const documentId = screen.getByTestId('timeline-editor').getAttribute('data-document-id')!
    expect(bindCurrentPath).toHaveBeenCalledWith(documentId, sourcePath)
    expect(resolveNbsCustomAudio).toHaveBeenCalledWith(documentId, ['kit/lead.ogg'])
    expect(bindCurrentPath.mock.invocationCallOrder[0])
      .toBeLessThan(resolveNbsCustomAudio.mock.invocationCallOrder[0])
    expect(screen.getByTestId('timeline-editor').getAttribute('data-custom-audio-count')).toBe('1')
    expect(tab.getAttribute('aria-label')).toBe('custom.nbs')
    expect(screen.queryByRole('tab', { name: 'Unsaved custom.nbs' })).toBeNull()
  })

  it('opens a direct NBS without missing sibling sounds and reports a bounded warning', async () => {
    arrangeCustomAudioNbsOpen('C:\\Songs\\missing.nbs')
    resolveNbsCustomAudio.mockResolvedValue({
      ok: true,
      assets: [],
      warnings: ['Custom instrument sound "kit/lead.ogg" was not loaded: it was not found.'],
    })
    renderWorkspace()

    await screen.findByRole('tab', { name: 'missing.nbs' })
    const dialog = await screen.findByRole('dialog', { name: 'Project warnings' })
    expect(dialog.textContent).toContain('kit/lead.ogg')
    expect(screen.getByTestId('timeline-editor').getAttribute('data-custom-audio-count')).toBe('0')
    expect(window.alert).not.toHaveBeenCalled()
  })

  it('drops a stale sibling-sound result when the reserved reusable tab changes', async () => {
    arrangeCustomAudioNbsOpen('C:\\Songs\\stale.nbs')
    let finishResolution!: (value: {
      ok: true
      assets: []
      warnings: string[]
    }) => void
    resolveNbsCustomAudio.mockImplementation(() => new Promise((resolve) => {
      finishResolution = resolve
    }))
    renderWorkspace()
    await waitFor(() => expect(resolveNbsCustomAudio).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: 'Make dirty' }))
    finishResolution({ ok: true, assets: [], warnings: [] })

    await waitFor(() => expect(releaseCurrentPath).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('tab', { name: 'Unsaved Untitled' })).toBeTruthy()
    expect(screen.queryByRole('tab', { name: 'stale.nbs' })).toBeNull()
    expect(screen.getByTestId('timeline-editor').getAttribute('data-custom-audio-count')).toBe('0')
  })

  it('opens a classic song at its source tempo without a timing warning', async () => {
    arrangeClassicNbsOpen('C:\\Songs\\source-tempo.nbs', 750)
    renderWorkspace()

    await screen.findByRole('tab', { name: 'source-tempo.nbs' })
    const editor = screen.getByTestId('timeline-editor')
    expect(editor.getAttribute('data-ticks-per-quarter')).toBe('4')
    expect(editor.getAttribute('data-project-bpm')).toBe('112.5')
    expect(screen.queryByRole('dialog', { name: 'Project warnings' })).toBeNull()
    expect(window.alert).not.toHaveBeenCalled()
  })

  it('opens NBS v0 as a bound song tab and Save As keeps the NBS kind/version', async () => {
    const sourcePath = arrangeClassicNbsOpen()
    timelineSaveDialog.mockResolvedValue({ ok: true, path: 'C:\\Songs\\classic-copy.nbs' })
    renderWorkspace()

    const tab = await screen.findByRole('tab', { name: 'classic.nbs' })
    const documentId = screen.getByTestId('timeline-editor').getAttribute('data-document-id')
    expect(documentId).toBeTruthy()
    expect(bindCurrentPath).toHaveBeenCalledWith(documentId, sourcePath)
    expect(tab).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Save document as' }))
    expect(await screen.findByText('Save lossy NBS file?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(timelineSaveDialog).toHaveBeenCalledTimes(1))
    const [savedDocumentId, defaultName, payload] = timelineSaveDialog.mock.calls[0]
    expect(savedDocumentId).toBe(documentId)
    expect(defaultName).toBe('classic.nbs')
    expect(payload).toMatchObject({ kind: 'nbs' })
    const binary = atob((payload as { dataBase64: string }).dataBase64)
    const parsed = parseNbs(Uint8Array.from(binary, value => value.charCodeAt(0)).buffer)
    expect(parsed.ok && parsed.song.header.version).toBe(0)
    await screen.findByRole('tab', { name: 'classic-copy.nbs' })
    fireEvent.click(screen.getByRole('button', { name: 'Open recent songs' }))
    expect(await screen.findByText('C:\\Songs\\classic-copy.nbs')).toBeTruthy()
  })

  it('cancels a lossy plain-NBS save before native write', async () => {
    arrangeClassicNbsOpen()
    renderWorkspace()
    await screen.findByRole('tab', { name: 'classic.nbs' })
    fireEvent.click(screen.getByRole('button', { name: 'Make dirty' }))

    fireEvent.click(screen.getByRole('button', { name: 'Save document' }))
    expect(await screen.findByText('Save lossy NBS file?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => {
      expect(screen.queryByText('Save lossy NBS file?')).toBeNull()
    })
    expect(timelineSave).not.toHaveBeenCalled()
    expect(screen.getByRole('tab', { name: 'Unsaved classic.nbs' })).toBeTruthy()
  })

  it('shows explicit recent paths, removes failed entries, and can clear history', async () => {
    const sourcePath = arrangeClassicNbsOpen()
    renderWorkspace()
    await screen.findByRole('tab', { name: 'classic.nbs' })

    fireEvent.click(screen.getByRole('button', { name: 'Open recent songs' }))
    expect(await screen.findByText('Recent songs')).toBeTruthy()
    expect(screen.getByText(sourcePath)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    timelineOpenPath.mockResolvedValue({ ok: false, error: 'File not found' })
    fireEvent.click(screen.getByRole('button', { name: 'Open recent songs' }))
    fireEvent.click(screen.getByRole('button', { name: `Open recent song ${sourcePath}` }))
    await waitFor(() => expect(window.alert).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'Open recent songs' }))
    expect(await screen.findByText('No recent songs')).toBeTruthy()

    // Clear remains safe and idempotent for an already-empty list.
    expect(screen.getByRole('button', { name: 'Clear recent songs' }).hasAttribute('disabled')).toBe(true)
  })

  it('clears recent history from its dialog', async () => {
    arrangeClassicNbsOpen()
    renderWorkspace()
    await screen.findByRole('tab', { name: 'classic.nbs' })
    fireEvent.click(screen.getByRole('button', { name: 'Open recent songs' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Clear recent songs' }))
    expect(await screen.findByText('No recent songs')).toBeTruthy()
  })

  it('retains a valid recent entry when the eight-tab capacity blocks opening it', async () => {
    const recentPath = 'C:\\Songs\\capacity.nbs'
    window.localStorage.setItem(RECENT_STUDIO_SONGS_KEY, JSON.stringify([
      { path: recentPath, kind: 'nbs' },
    ]))
    timelineOpenPath.mockResolvedValue({
      ok: true,
      path: recentPath,
      kind: 'nbs',
      dataBase64: bytesBase64(classicNbs()),
    })
    renderWorkspace()

    for (let index = 0; index < 8; index++) {
      fireEvent.click(screen.getByRole('button', { name: 'Make dirty' }))
      if (index < 7) fireEvent.click(screen.getByRole('button', { name: 'New song tab' }))
    }
    await waitFor(() => expect(screen.getAllByRole('tab')).toHaveLength(8))
    fireEvent.click(screen.getByRole('button', { name: 'Open recent songs' }))
    fireEvent.click(screen.getByRole('button', { name: `Open recent song ${recentPath}` }))
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith('Too many song tabs'))
    expect(bindCurrentPath).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Open recent songs' }))
    expect(await screen.findByText(recentPath)).toBeTruthy()
  })

  it('retains a valid recent entry when another native document owns its path', async () => {
    const recentPath = 'C:\\Songs\\owned.nbs'
    window.localStorage.setItem(RECENT_STUDIO_SONGS_KEY, JSON.stringify([
      { path: recentPath, kind: 'nbs' },
    ]))
    timelineOpenPath.mockResolvedValue({
      ok: true,
      path: recentPath,
      kind: 'nbs',
      dataBase64: bytesBase64(classicNbs()),
    })
    bindCurrentPath.mockResolvedValue({ ok: false, error: 'Already open in another window' })
    renderWorkspace()

    fireEvent.click(screen.getByRole('button', { name: 'Open recent songs' }))
    fireEvent.click(screen.getByRole('button', { name: `Open recent song ${recentPath}` }))
    await waitFor(() => expect(window.alert).toHaveBeenCalledWith(
      'studio.open_error: Already open in another window',
    ))

    fireEvent.click(screen.getByRole('button', { name: 'Open recent songs' }))
    expect(await screen.findByText(recentPath)).toBeTruthy()
  })

  it('serializes the operation snapshot and stays dirty if edited during NBS loss confirmation', async () => {
    const sourcePath = arrangeClassicNbsOpen()
    timelineSave.mockResolvedValue({ ok: true, path: sourcePath })
    renderWorkspace()
    await screen.findByRole('tab', { name: 'classic.nbs' })
    fireEvent.click(screen.getByRole('button', { name: 'Make dirty' }))

    fireEvent.click(screen.getByRole('button', { name: 'Save document' }))
    expect(await screen.findByText('Save lossy NBS file?')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Make dirty' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(timelineSave).toHaveBeenCalledTimes(1))
    const [documentId, payload] = timelineSave.mock.calls[0]
    expect(documentId).toBe(screen.getByTestId('timeline-editor').getAttribute('data-document-id'))
    expect(payload).toMatchObject({ kind: 'nbs' })
    const binary = atob((payload as { dataBase64: string }).dataBase64)
    const parsed = parseNbs(Uint8Array.from(binary, value => value.charCodeAt(0)).buffer)
    // Source note + the edit captured before confirmation. The confirmation-side edit stays dirty.
    expect(parsed.ok && parsed.song.notes).toHaveLength(2)
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Unsaved classic.nbs' })).toBeTruthy()
    })
  })

  it('cancels an in-flight NBS loss prompt before showing one native-close prompt', async () => {
    arrangeClassicNbsOpen()
    renderWorkspace()
    await screen.findByRole('tab', { name: 'classic.nbs' })
    fireEvent.click(screen.getByRole('button', { name: 'Make dirty' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save document' }))
    expect(await screen.findByText('Save lossy NBS file?')).toBeTruthy()

    closeRequestHandler?.({ mode: 'hide' })
    await waitFor(() => {
      expect(screen.queryByText('Save lossy NBS file?')).toBeNull()
      expect(screen.getByText('Save changes to 1 unsaved songs?')).toBeTruthy()
      expect(screen.getAllByRole('dialog', { name: 'Save changes?' })).toHaveLength(1)
    })
    expect(timelineSave).not.toHaveBeenCalled()
  })

  it('creates, switches, and closes independent clean song tabs', async () => {
    renderWorkspace()
    const firstDocumentId = screen.getByTestId('timeline-editor').getAttribute('data-document-id')
    expect(firstDocumentId).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'New song tab' }))
    await waitFor(() => expect(screen.getAllByRole('tab', { name: 'Untitled' })).toHaveLength(2))
    const secondDocumentId = screen.getByTestId('timeline-editor').getAttribute('data-document-id')
    expect(secondDocumentId).toBeTruthy()
    expect(secondDocumentId).not.toBe(firstDocumentId)

    const tabs = screen.getAllByRole('tab', { name: 'Untitled' })
    fireEvent.click(tabs[0])
    await waitFor(() => {
      expect(screen.getByTestId('timeline-editor').getAttribute('data-document-id'))
        .toBe(firstDocumentId)
    })

    fireEvent.click(screen.getAllByRole('button', { name: 'Close Untitled' })[1])
    await waitFor(() => expect(screen.getAllByRole('tab', { name: 'Untitled' })).toHaveLength(1))
    expect(releaseCurrentPath).toHaveBeenCalledWith(secondDocumentId)
    expect(screen.getByTestId('timeline-editor').getAttribute('data-document-id'))
      .toBe(firstDocumentId)
  })

  it('uses the native close handshake and blocks tab shortcuts while confirmation is open', async () => {
    renderWorkspace()
    await waitFor(() => expect(onCloseRequested).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'New song tab' }))
    await waitFor(() => expect(screen.getAllByRole('tab', { name: 'Untitled' })).toHaveLength(2))
    const dirtyDocumentId = screen.getByTestId('timeline-editor').getAttribute('data-document-id')
    fireEvent.click(screen.getByRole('button', { name: 'Make dirty' }))
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Unsaved Untitled' })).toBeTruthy())

    fireEvent.keyDown(window, { key: 'w', ctrlKey: true })
    expect(await screen.findByText('Save changes to Untitled?')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'New song tab' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getAllByRole('tab').every(tab => tab.hasAttribute('disabled'))).toBe(true)

    fireEvent.keyDown(window, { key: 'Tab', ctrlKey: true })
    expect(screen.getByTestId('timeline-editor').getAttribute('data-document-id'))
      .toBe(dirtyDocumentId)

    closeRequestHandler?.({ mode: 'hide' })
    await waitFor(() => {
      expect(screen.getAllByRole('dialog', { name: 'Save changes?' })).toHaveLength(1)
      expect(screen.getByText('Save changes to 1 unsaved songs?')).toBeTruthy()
    })
    expect(confirmClose).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Don\'t Save' }))
    await waitFor(() => expect(confirmClose).toHaveBeenCalledWith('hide'))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Save changes?' })).toBeNull())
  })
})
