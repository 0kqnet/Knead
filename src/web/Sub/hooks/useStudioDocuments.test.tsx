// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  MAX_STUDIO_DOCUMENTS,
  MAX_WORKSPACE_HISTORY_REVISIONS,
  isStudioDocumentDirty,
} from '../types/studioDocuments'
import {
  countWorkspaceHistoryRevisions,
  createStudioDocument,
  createStudioDocumentsState,
  studioDocumentsReducer,
  useStudioDocuments,
} from './useStudioDocuments'

describe('useStudioDocuments', () => {
  it('stores direct NBS format and source version 0 without a truthy fallback', () => {
    const document = createStudioDocument({
      filePath: 'C:\\Music\\classic.nbs',
      fileKind: 'nbs',
      nbsTargetVersion: 0,
    })
    expect(document.fileKind).toBe('nbs')
    expect(document.nbsTargetVersion).toBe(0)
  })

  it('keeps undo and redo history independent across song tabs', () => {
    const { result } = renderHook(() => useStudioDocuments())
    const firstId = result.current.activeDocument.id
    act(() => {
      result.current.activeTimeline.addMarker({ tick: 1, soundId: 'first' })
    })

    let secondId: string | null = null
    act(() => {
      secondId = result.current.newDocument()
    })
    if (!secondId) throw new Error('Expected a second document')
    act(() => {
      result.current.activeTimeline.addMarker({ tick: 2, soundId: 'second' })
    })
    expect(result.current.state.documents[firstId].history.current.markers).toHaveLength(1)
    expect(result.current.state.documents[secondId].history.current.markers).toHaveLength(1)

    act(() => {
      result.current.activateDocument(firstId)
    })
    act(() => {
      result.current.activeTimeline.undo()
    })
    expect(result.current.state.documents[firstId].history.current.markers).toHaveLength(0)
    expect(result.current.state.documents[secondId].history.current.markers).toHaveLength(1)

    act(() => {
      result.current.activeTimeline.redo()
    })
    expect(result.current.state.documents[firstId].history.current.markers).toHaveLength(1)
  })

  it('uses state identity as the save point and stays dirty when editing during save', () => {
    const { result } = renderHook(() => useStudioDocuments())
    const documentId = result.current.activeDocument.id
    expect(isStudioDocumentDirty(result.current.activeDocument)).toBe(false)

    act(() => {
      result.current.activeTimeline.addMarker({ tick: 1, soundId: 'saved-candidate' })
    })
    const owner = result.current.beginDocumentOperation(documentId, 'saving')
    if (!owner) throw new Error('Expected a save owner')
    act(() => {
      result.current.activeTimeline.addMarker({ tick: 2, soundId: 'edited-during-save' })
    })
    act(() => {
      result.current.setDocumentSavePoint(documentId, owner!.stateSnapshot, {
        filePath: 'C:\\Music\\song.kp',
      })
      result.current.completeDocumentOperation(owner!, { status: 'ready' })
    })

    expect(result.current.activeDocument.filePath).toBe('C:\\Music\\song.kp')
    expect(result.current.activeDocument.history.current.markers).toHaveLength(2)
    expect(isStudioDocumentDirty(result.current.activeDocument)).toBe(true)

    act(() => {
      result.current.activeTimeline.undo()
    })
    expect(result.current.activeDocument.history.current).toBe(owner.stateSnapshot)
    expect(isStudioDocumentDirty(result.current.activeDocument)).toBe(false)
  })

  it('retains each tab selection and applies async completion only to its owner', () => {
    const { result } = renderHook(() => useStudioDocuments())
    const firstId = result.current.activeDocument.id
    const firstTrackId = result.current.activeDocument.history.current.tracks[0].id
    let markerId = ''
    act(() => {
      markerId = result.current.activeTimeline.addMarker({ tick: 3, soundId: 'selected' })
    })
    act(() => {
      result.current.updateDocument(firstId, {
        selection: {
          markerIds: [markerId],
          anchorMarkerId: markerId,
          trackId: firstTrackId,
        },
      })
    })
    const owner = result.current.beginDocumentOperation(firstId, 'saving')
    if (!owner) throw new Error('Expected an operation owner')

    let secondId: string | null = null
    act(() => {
      secondId = result.current.newDocument()
    })
    if (!secondId) throw new Error('Expected a second document')
    act(() => {
      result.current.completeDocumentOperation(owner, {
        status: 'ready',
        displayName: 'First Saved',
      })
    })

    expect(result.current.activeDocument.id).toBe(secondId)
    expect(result.current.activeDocument.displayName).toBe('Untitled')
    expect(result.current.state.documents[firstId].displayName).toBe('First Saved')

    act(() => {
      result.current.activateDocument(firstId)
    })
    expect(result.current.activeDocument.selection).toEqual({
      markerIds: [markerId],
      anchorMarkerId: markerId,
      trackId: firstTrackId,
    })
  })

  it('ignores completion from a superseded document operation token', () => {
    const { result } = renderHook(() => useStudioDocuments())
    const documentId = result.current.activeDocument.id
    let olderOwner: ReturnType<typeof result.current.beginDocumentOperation> = null
    let newestOwner: ReturnType<typeof result.current.beginDocumentOperation> = null
    act(() => {
      olderOwner = result.current.beginDocumentOperation(documentId, 'saving')
    })
    act(() => {
      newestOwner = result.current.beginDocumentOperation(documentId, 'audio-switching')
    })
    if (!olderOwner || !newestOwner) throw new Error('Expected operation owners')

    act(() => {
      result.current.completeDocumentOperation(olderOwner!, {
        status: 'ready',
        displayName: 'Stale Result',
      })
    })
    expect(result.current.activeDocument.displayName).toBe('Untitled')
    expect(result.current.activeDocument.status).toBe('audio-switching')

    act(() => {
      result.current.completeDocumentOperation(newestOwner!, {
        status: 'ready',
        displayName: 'Current Result',
      })
    })
    expect(result.current.activeDocument.displayName).toBe('Current Result')
    expect(result.current.activeDocument.status).toBe('ready')
  })

  it('caps resident documents at eight', () => {
    const { result } = renderHook(() => useStudioDocuments())
    for (let index = 1; index < MAX_STUDIO_DOCUMENTS; index++) {
      act(() => {
        expect(result.current.newDocument()).not.toBeNull()
      })
    }
    expect(result.current.documents).toHaveLength(MAX_STUDIO_DOCUMENTS)
    act(() => {
      expect(result.current.newDocument()).toBeNull()
    })
    expect(result.current.documents).toHaveLength(MAX_STUDIO_DOCUMENTS)
  })
})
describe('studio document history budget', () => {
  it('prunes the oldest inactive histories to 400 workspace revisions', () => {
    let state = createStudioDocumentsState({ id: 'document-0' })
    for (let documentIndex = 1; documentIndex < 5; documentIndex++) {
      state = studioDocumentsReducer(state, {
        type: 'add',
        document: createStudioDocument({ id: `document-${documentIndex}` }),
        activate: false,
      })
    }

    for (const documentId of state.order) {
      for (let revision = 0; revision < 100; revision++) {
        state = studioDocumentsReducer(state, {
          type: 'timeline',
          documentId,
          action: {
            type: 'mutate',
            recipe: (draft) => {
              draft.randomSeed = (draft.randomSeed + 1) >>> 0
            },
          },
        })
      }
    }

    expect(countWorkspaceHistoryRevisions(state)).toBeLessThanOrEqual(
      MAX_WORKSPACE_HISTORY_REVISIONS,
    )
    expect(state.documents['document-0'].history.past).toHaveLength(100)
    expect(state.documents['document-1'].history.past.length).toBeLessThan(100)
    expect(state.documents['document-4'].history.current.randomSeed).not.toBe(
      state.documents['document-4'].savePoint?.randomSeed,
    )
  })
})
