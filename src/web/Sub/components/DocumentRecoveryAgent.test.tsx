// @vitest-environment jsdom

import React from 'react'
import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  TimelineRecoveryApi,
  TimelineRecoverySaveRequest,
} from '../types/recovery'
import type { StudioDocument } from '../types/studioDocuments'
import { timelineHistoryReducer } from '../hooks/useTimeline'
import { createStudioDocument } from '../hooks/useStudioDocuments'
import {
  DocumentRecoveryAgent,
  type DocumentRecoveryController,
} from './DocumentRecoveryAgent'

function createRecoveryApi() {
  const save = vi.fn(async (request: TimelineRecoverySaveRequest) => ({
    ok: true as const,
    snapshot: {
      id: `snapshot-${request.projectId}`,
      projectId: request.projectId,
      filePath: request.filePath,
      updatedAt: request.updatedAt,
      fingerprint: 'fingerprint',
      byteLength: request.json.length,
    },
  }))
  const clearProject = vi.fn(async () => ({ ok: true as const }))
  const api: TimelineRecoveryApi = {
    save,
    clearProject,
    list: vi.fn(async () => ({ ok: true as const, snapshots: [] })),
    restore: vi.fn(async () => ({ ok: false as const, error: 'not found' })),
    discard: vi.fn(async () => ({ ok: true as const })),
  }
  return { api, save, clearProject }
}

function editDocument(document: StudioDocument, amount = 1): StudioDocument {
  return {
    ...document,
    history: timelineHistoryReducer(document.history, {
      type: 'mutate',
      recipe: (draft) => {
        draft.randomSeed = (draft.randomSeed + amount) >>> 0
      },
    }),
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('DocumentRecoveryAgent', () => {
  it('autosaves an inactive dirty document with its own path after debounce', async () => {
    vi.useFakeTimers()
    const mocked = createRecoveryApi()
    const document = editDocument(createStudioDocument({
      id: 'inactive-document',
      filePath: 'C:\\Music\\inactive.kp',
    }))

    render(
      <DocumentRecoveryAgent
        document={document}
        api={mocked.api}
        debounceMs={1_500}
      />,
    )
    expect(mocked.save).not.toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500)
    })

    expect(mocked.save).toHaveBeenCalledTimes(1)
    const request = mocked.save.mock.calls[0][0]
    expect(request.projectId).toBe(document.history.current.projectId)
    expect(request.filePath).toBe('C:\\Music\\inactive.kp')
    expect(JSON.parse(request.json)).toMatchObject({
      projectId: document.history.current.projectId,
      randomSeed: document.history.current.randomSeed,
    })
  })

  it('flushes the newest state instead of clearing recovery after a stale save completes', async () => {
    vi.useFakeTimers()
    const mocked = createRecoveryApi()
    const firstEdit = editDocument(createStudioDocument({ id: 'save-race' }))
    const savedState = firstEdit.history.current
    let controller: DocumentRecoveryController | null = null
    const onController = (
      _documentId: string,
      next: DocumentRecoveryController | null,
    ) => {
      if (next) controller = next
    }
    const rendered = render(
      <DocumentRecoveryAgent
        document={firstEdit}
        api={mocked.api}
        debounceMs={1_500}
        onController={onController}
      />,
    )
    const secondEdit = editDocument(firstEdit, 2)
    rendered.rerender(
      <DocumentRecoveryAgent
        document={secondEdit}
        api={mocked.api}
        debounceMs={1_500}
        onController={onController}
      />,
    )
    if (!controller) throw new Error('Expected a recovery controller')

    let retainedResult
    await act(async () => {
      retainedResult = await controller!.reconcileAfterSave(
        savedState,
        secondEdit.history.current,
      )
    })
    expect(retainedResult).toEqual({ ok: true, cleared: false })
    expect(mocked.clearProject).not.toHaveBeenCalled()
    expect(JSON.parse(mocked.save.mock.calls[0][0].json).randomSeed).toBe(
      secondEdit.history.current.randomSeed,
    )

    let clearedResult
    await act(async () => {
      clearedResult = await controller!.reconcileAfterSave(
        secondEdit.history.current,
        secondEdit.history.current,
      )
    })
    expect(clearedResult).toEqual({ ok: true, cleared: true })
    expect(mocked.clearProject).toHaveBeenCalledWith(secondEdit.history.current.projectId)
  })

  it('tokenizes registrations and makes an unmounted controller inert', async () => {
    const mocked = createRecoveryApi()
    const document = editDocument(createStudioDocument({ id: 'closing-document' }))
    const registrations: Array<{
      controller: DocumentRecoveryController | null
      token: string
    }> = []
    const rendered = render(
      <DocumentRecoveryAgent
        document={document}
        api={mocked.api}
        onController={(_documentId, controller, token) => {
          registrations.push({ controller, token })
        }}
      />,
    )
    const registered = registrations.find(item => item.controller !== null)
    if (!registered?.controller) throw new Error('Expected a registered controller')

    rendered.unmount()
    const removed = registrations.at(-1)
    expect(removed).toEqual({ controller: null, token: registered.token })
    await expect(registered.controller.flush()).resolves.toBe(false)
    await expect(registered.controller.clear()).resolves.toBe(false)
    expect(mocked.save).not.toHaveBeenCalled()
    expect(mocked.clearProject).not.toHaveBeenCalled()
  })

  it('re-registers with a new token when the document project identity changes', () => {
    const mocked = createRecoveryApi()
    const original = editDocument(createStudioDocument({ id: 'identity-document' }))
    const registrations: Array<{
      controller: DocumentRecoveryController | null
      token: string
    }> = []
    const onController = (
      _documentId: string,
      controller: DocumentRecoveryController | null,
      token: string,
    ) => {
      registrations.push({ controller, token })
    }
    const rendered = render(
      <DocumentRecoveryAgent
        document={original}
        api={mocked.api}
        onController={onController}
      />,
    )
    const changedIdentity: StudioDocument = {
      ...original,
      history: timelineHistoryReducer(original.history, {
        type: 'mutate',
        recipe: (draft) => {
          draft.projectId = 'replacement-project-id'
        },
      }),
    }
    rendered.rerender(
      <DocumentRecoveryAgent
        document={changedIdentity}
        api={mocked.api}
        onController={onController}
      />,
    )

    const controllers = registrations.filter(item => item.controller !== null)
    expect(controllers).toHaveLength(2)
    expect(controllers[0].token).not.toBe(controllers[1].token)
    expect(registrations).toContainEqual({ controller: null, token: controllers[0].token })
  })
})
