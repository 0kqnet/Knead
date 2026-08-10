import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { EmbeddedCustomAudioAsset } from '../types/timeline'
import {
  activatePreparedProjectCustomAudioRegistry,
  getProjectCustomAudioSnapshot,
  prepareProjectCustomAudioRegistry,
  type PreparedProjectCustomAudioRegistry,
  type ProjectCustomAudioInstallResult,
} from '../utils/projectCustomAudio'

export type ProjectAudioActivationStatus = 'idle' | 'switching' | 'ready' | 'error'

export interface ProjectAudioActivationState {
  status: ProjectAudioActivationStatus
  requestGeneration: number
  requestedProjectId?: string
  /** Hook-local identity for the exact project asset snapshot being verified. */
  requestKey?: number
  activeProjectId?: string
  registryGeneration?: number
  error?: string
  /** The host may mount an Editor only after this project's registry committed. */
  canMountEditor: boolean
}

export interface ProjectAudioActivationResult {
  committed: boolean
  superseded: boolean
  projectId: string
  requestGeneration: number
  error?: string
}

export interface ProjectAudioActivationDependencies {
  prepare?: (
    assets: readonly EmbeddedCustomAudioAsset[],
  ) => Promise<PreparedProjectCustomAudioRegistry>
  activate?: (
    prepared: PreparedProjectCustomAudioRegistry,
  ) => ProjectCustomAudioInstallResult
  clearAudioCache?: () => void
  getRegistryGeneration?: () => number
}

export interface ProjectAudioActivationController {
  getSnapshot: () => ProjectAudioActivationState
  subscribe: (listener: () => void) => () => void
  activateProject: (
    projectId: string,
    assets: readonly EmbeddedCustomAudioAsset[],
    requestKey?: number,
  ) => Promise<ProjectAudioActivationResult>
  invalidate: () => void
}

const INITIAL_STATE: ProjectAudioActivationState = Object.freeze({
  status: 'idle',
  requestGeneration: 0,
  canMountEditor: false,
})

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Creates a latest-request-wins project audio switcher.
 *
 * Expensive verification may overlap, but the generation check and synchronous
 * registry activation form a single commit point. A stale verification can
 * therefore never replace the active song's sounds.
 */
export function createProjectAudioActivationController(
  dependencies: ProjectAudioActivationDependencies = {},
): ProjectAudioActivationController {
  const prepare = dependencies.prepare ?? prepareProjectCustomAudioRegistry
  const activate = dependencies.activate ?? activatePreparedProjectCustomAudioRegistry
  const getRegistryGeneration = dependencies.getRegistryGeneration
    ?? (() => getProjectCustomAudioSnapshot().generation)
  const listeners = new Set<() => void>()
  let generation = 0
  let state = INITIAL_STATE

  const publish = (next: ProjectAudioActivationState): void => {
    state = Object.freeze(next)
    for (const listener of listeners) listener()
  }

  const clearAndInvalidate = (): number => {
    generation += 1
    dependencies.clearAudioCache?.()
    return generation
  }

  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    activateProject: async (projectId, assets, requestKey) => {
      if (!projectId) throw new Error('A project id is required for audio activation')
      const requestGeneration = clearAndInvalidate()
      publish({
        status: 'switching',
        requestGeneration,
        requestedProjectId: projectId,
        ...(requestKey === undefined ? {} : { requestKey }),
        activeProjectId: state.activeProjectId,
        registryGeneration: state.registryGeneration,
        canMountEditor: false,
      })
      try {
        const prepared = await prepare(assets)
        if (generation !== requestGeneration) {
          return { committed: false, superseded: true, projectId, requestGeneration }
        }
        activate(prepared)
        if (generation !== requestGeneration) {
          return { committed: true, superseded: true, projectId, requestGeneration }
        }
        const registryGeneration = getRegistryGeneration()
        publish({
          status: 'ready',
          requestGeneration,
          requestedProjectId: projectId,
          ...(requestKey === undefined ? {} : { requestKey }),
          activeProjectId: projectId,
          registryGeneration,
          canMountEditor: true,
        })
        return { committed: true, superseded: false, projectId, requestGeneration }
      }
      catch (error) {
        if (generation !== requestGeneration) {
          return { committed: false, superseded: true, projectId, requestGeneration }
        }
        const message = errorMessage(error)
        publish({
          status: 'error',
          requestGeneration,
          requestedProjectId: projectId,
          ...(requestKey === undefined ? {} : { requestKey }),
          activeProjectId: state.activeProjectId,
          registryGeneration: state.registryGeneration,
          error: message,
          canMountEditor: false,
        })
        return {
          committed: false,
          superseded: false,
          projectId,
          requestGeneration,
          error: message,
        }
      }
    },
    invalidate: () => {
      const requestGeneration = clearAndInvalidate()
      publish({ status: 'idle', requestGeneration, canMountEditor: false })
    },
  }
}

export interface UseActiveProjectAudioOptions {
  projectId?: string | null
  assets: readonly EmbeddedCustomAudioAsset[]
  clearAudioCache?: () => void
  controller?: ProjectAudioActivationController
}

/** React binding used by the song-tab host while it gates the Editor mount. */
export function useActiveProjectAudio({
  projectId,
  assets,
  clearAudioCache,
  controller,
}: UseActiveProjectAudioOptions): ProjectAudioActivationState {
  const clearAudioCacheRef = useRef(clearAudioCache)
  clearAudioCacheRef.current = clearAudioCache
  const ownedControllerRef = useRef<ProjectAudioActivationController | null>(null)
  if (!ownedControllerRef.current) {
    ownedControllerRef.current = createProjectAudioActivationController({
      clearAudioCache: () => clearAudioCacheRef.current?.(),
    })
  }
  const activeController = controller ?? ownedControllerRef.current
  const desiredRequestRef = useRef<{
    projectId?: string | null
    assets: readonly EmbeddedCustomAudioAsset[]
    key: number
  }>({ projectId, assets, key: 1 })
  if (
    desiredRequestRef.current.projectId !== projectId
    || desiredRequestRef.current.assets !== assets
  ) {
    desiredRequestRef.current = {
      projectId,
      assets,
      key: desiredRequestRef.current.key + 1,
    }
  }
  const desiredRequest = desiredRequestRef.current
  const state = useSyncExternalStore(
    activeController.subscribe,
    activeController.getSnapshot,
    activeController.getSnapshot,
  )

  useEffect(() => {
    if (!desiredRequest.projectId) {
      activeController.invalidate()
      return
    }
    void activeController.activateProject(
      desiredRequest.projectId,
      desiredRequest.assets,
      desiredRequest.key,
    )
    return () => activeController.invalidate()
  }, [activeController, desiredRequest])

  if (!projectId) {
    return {
      status: 'idle',
      requestGeneration: state.requestGeneration,
      canMountEditor: false,
    }
  }
  if (state.requestedProjectId === projectId && state.requestKey === desiredRequest.key) {
    return state
  }
  return {
    status: 'switching',
    requestGeneration: state.requestGeneration,
    requestedProjectId: projectId,
    requestKey: desiredRequest.key,
    activeProjectId: state.activeProjectId,
    registryGeneration: state.registryGeneration,
    canMountEditor: false,
  }
}
