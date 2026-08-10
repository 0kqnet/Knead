// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { EmbeddedCustomAudioAsset } from '../types/timeline'
import type { PreparedProjectCustomAudioRegistry } from '../utils/projectCustomAudio'
import {
  createProjectAudioActivationController,
  useActiveProjectAudio,
} from './useActiveProjectAudio'

interface Deferred<Value> {
  promise: Promise<Value>
  resolve: (value: Value) => void
  reject: (reason: unknown) => void
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<Value>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

function prepared(id: string): PreparedProjectCustomAudioRegistry {
  return {
    manifest: Object.freeze({ [id]: Object.freeze([]) }),
    installedSounds: 1,
    installedAssets: 1,
    warnings: Object.freeze([]),
  }
}

const NO_ASSETS: readonly EmbeddedCustomAudioAsset[] = Object.freeze([])
const NEXT_ASSETS: readonly EmbeddedCustomAudioAsset[] = Object.freeze([])

describe('active project audio activation', () => {
  it('lets only the final A → B → A verification commit and become ready', async () => {
    const requests = [
      deferred<PreparedProjectCustomAudioRegistry>(),
      deferred<PreparedProjectCustomAudioRegistry>(),
      deferred<PreparedProjectCustomAudioRegistry>(),
    ]
    const prepare = vi.fn(() => {
      const request = requests[prepare.mock.calls.length - 1]
      if (!request) throw new Error('Unexpected prepare call')
      return request.promise
    })
    const committed: string[] = []
    let registryGeneration = 10
    const clearAudioCache = vi.fn()
    const controller = createProjectAudioActivationController({
      prepare,
      activate: (value) => {
        committed.push(Object.keys(value.manifest)[0])
        registryGeneration += 1
        return { installedSounds: 1, installedAssets: 1, warnings: [] }
      },
      getRegistryGeneration: () => registryGeneration,
      clearAudioCache,
    })

    const firstA = controller.activateProject('A', NO_ASSETS)
    const b = controller.activateProject('B', NO_ASSETS)
    const finalA = controller.activateProject('A', NO_ASSETS)
    expect(controller.getSnapshot()).toMatchObject({
      status: 'switching', requestedProjectId: 'A', canMountEditor: false,
    })

    requests[1].resolve(prepared('B'))
    expect(await b).toMatchObject({ committed: false, superseded: true })
    requests[0].resolve(prepared('old-A'))
    expect(await firstA).toMatchObject({ committed: false, superseded: true })
    expect(committed).toEqual([])

    requests[2].resolve(prepared('final-A'))
    expect(await finalA).toMatchObject({ committed: true, superseded: false })
    expect(committed).toEqual(['final-A'])
    expect(clearAudioCache).toHaveBeenCalledTimes(3)
    expect(controller.getSnapshot()).toEqual({
      status: 'ready',
      requestGeneration: 3,
      requestedProjectId: 'A',
      activeProjectId: 'A',
      registryGeneration: 11,
      canMountEditor: true,
    })
  })

  it('keeps the host gated when the latest verification fails', async () => {
    const request = deferred<PreparedProjectCustomAudioRegistry>()
    const activate = vi.fn()
    const controller = createProjectAudioActivationController({
      prepare: () => request.promise,
      activate,
    })
    const activation = controller.activateProject('broken', NO_ASSETS)
    expect(controller.getSnapshot().canMountEditor).toBe(false)
    request.reject(new Error('fingerprint mismatch'))
    expect(await activation).toMatchObject({
      committed: false, superseded: false, error: 'fingerprint mismatch',
    })
    expect(activate).not.toHaveBeenCalled()
    expect(controller.getSnapshot()).toMatchObject({
      status: 'error', requestedProjectId: 'broken', canMountEditor: false,
    })
  })

  it('binds controller switching/ready state to React and invalidates on unmount', async () => {
    const request = deferred<PreparedProjectCustomAudioRegistry>()
    const clearAudioCache = vi.fn()
    const controller = createProjectAudioActivationController({
      prepare: () => request.promise,
      activate: () => ({ installedSounds: 0, installedAssets: 0, warnings: [] }),
      getRegistryGeneration: () => 7,
      clearAudioCache,
    })
    const { result, unmount } = renderHook(() => useActiveProjectAudio({
      projectId: 'active',
      assets: NO_ASSETS,
      controller,
    }))
    await waitFor(() => expect(result.current.status).toBe('switching'))
    expect(result.current.canMountEditor).toBe(false)
    await act(async () => {
      request.resolve(prepared('active'))
      await request.promise
    })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.canMountEditor).toBe(true)
    unmount()
    expect(controller.getSnapshot()).toMatchObject({ status: 'idle', canMountEditor: false })
    expect(clearAudioCache).toHaveBeenCalledTimes(2)
  })

  it('gates the first render when assets change inside the same project id', async () => {
    const second = deferred<PreparedProjectCustomAudioRegistry>()
    let prepareCount = 0
    const controller = createProjectAudioActivationController({
      prepare: () => {
        prepareCount += 1
        return prepareCount === 1 ? Promise.resolve(prepared('initial')) : second.promise
      },
      activate: () => ({ installedSounds: 0, installedAssets: 0, warnings: [] }),
    })
    const renderGates: boolean[] = []
    const { result, rerender } = renderHook(
      ({ assets }: { assets: readonly EmbeddedCustomAudioAsset[] }) => {
        const state = useActiveProjectAudio({ projectId: 'same', assets, controller })
        renderGates.push(state.canMountEditor)
        return state
      },
      { initialProps: { assets: NO_ASSETS } },
    )
    await waitFor(() => expect(result.current.status).toBe('ready'))
    renderGates.length = 0

    rerender({ assets: NEXT_ASSETS })
    expect(renderGates[0]).toBe(false)
    expect(result.current).toMatchObject({ status: 'switching', canMountEditor: false })
    await act(async () => {
      second.resolve(prepared('next'))
      await second.promise
    })
    await waitFor(() => expect(result.current.status).toBe('ready'))
  })
})
