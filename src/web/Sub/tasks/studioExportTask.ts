import { useCallback, useEffect, useRef, useState } from 'react'
import type { GenerationStage } from '../utils/generationProgress'
import {
  CancellableWorkerTask,
  isTaskAbortError,
  type WorkerTaskLike,
  type WorkerTaskRunOptions,
} from './cancellableWorkerTask'
import type {
  StudioExportRequest,
  StudioExportRequestMap,
  StudioExportResultMap,
  StudioExportTaskKind,
  StudioExportWorkerMessage,
  StudioExportWorkerRunMessage,
} from './studioExportProtocol'
import { executeStudioExportRequest } from './studioExportExecutor'

type AnyStudioExportResult = StudioExportResultMap[StudioExportTaskKind]

class FallbackStudioExportWorker implements WorkerTaskLike<StudioExportRequest, AnyStudioExportResult, GenerationStage> {
  onmessage: ((event: MessageEvent<StudioExportWorkerMessage>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null
  private terminated = false

  postMessage(message: StudioExportWorkerRunMessage): void {
    // Keep the same asynchronous ownership contract in test runners and hosts
    // that disable Workers. Production WebViews use the hard-cancelable Worker.
    window.setTimeout(() => {
      if (this.terminated) return
      const emit = (data: StudioExportWorkerMessage) => {
        if (!this.terminated) this.onmessage?.({ data } as MessageEvent<StudioExportWorkerMessage>)
      }
      try {
        const result = executeStudioExportRequest(message.request, {
          isCanceled: () => this.terminated,
          reportProgress: (progress, stage) => emit({
            type: 'progress', generation: message.generation, progress, stage,
          }),
        })
        emit({ type: 'success', generation: message.generation, result })
      }
      catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error))
        emit({
          type: 'error',
          generation: message.generation,
          name: normalized.name,
          message: normalized.message,
          ...(normalized.stack ? { stack: normalized.stack } : {}),
        })
      }
    }, 0)
  }

  terminate(): void {
    this.terminated = true
  }
}

function createStudioExportWorker(): WorkerTaskLike<StudioExportRequest, AnyStudioExportResult, GenerationStage> {
  if (typeof Worker === 'undefined') return new FallbackStudioExportWorker()
  try {
    return new Worker(
      new URL('../workers/studioExport.worker.ts', import.meta.url),
      { type: 'module', name: 'knead-studio-export' },
    ) as unknown as WorkerTaskLike<StudioExportRequest, AnyStudioExportResult, GenerationStage>
  }
  catch {
    return new FallbackStudioExportWorker()
  }
}

export class StudioExportTaskRunner {
  private readonly workerTask = new CancellableWorkerTask<
    StudioExportRequest,
    AnyStudioExportResult,
    GenerationStage
  >(createStudioExportWorker)

  run<K extends StudioExportTaskKind>(
    request: StudioExportRequest<K>,
    options?: WorkerTaskRunOptions<GenerationStage>,
  ): Promise<StudioExportResultMap[K]> {
    return this.workerTask.run(
      request as unknown as StudioExportRequest,
      options,
    ) as Promise<StudioExportResultMap[K]>
  }

  cancel(reason?: unknown): boolean {
    return this.workerTask.cancel(reason)
  }

  dispose(): void {
    this.workerTask.dispose()
  }
}

export type StudioExportTaskStatus = 'idle' | 'running' | 'success' | 'canceled' | 'error'

export interface StudioExportTaskState<Result> {
  status: StudioExportTaskStatus
  progress: number
  stage: GenerationStage | null
  result: Result | null
  error: string | null
  generation: number
}

const INITIAL_TASK_STATE: StudioExportTaskState<never> = {
  status: 'idle',
  progress: 0,
  stage: null,
  result: null,
  error: null,
  generation: 0,
}

export function useStudioExportTask<K extends StudioExportTaskKind>(kind: K) {
  const runnerRef = useRef<StudioExportTaskRunner | null>(null)
  if (!runnerRef.current) runnerRef.current = new StudioExportTaskRunner()
  const controllerRef = useRef<AbortController | null>(null)
  const generationRef = useRef(0)
  const [state, setState] = useState<StudioExportTaskState<StudioExportResultMap[K]>>(
    INITIAL_TASK_STATE,
  )

  useEffect(() => () => {
    controllerRef.current?.abort('Component unmounted')
    runnerRef.current?.dispose()
  }, [])

  const run = useCallback((payload: StudioExportRequestMap[K]): Promise<StudioExportResultMap[K]> => {
    controllerRef.current?.abort('Superseded by a newer generation')
    const controller = new AbortController()
    controllerRef.current = controller
    const generation = ++generationRef.current
    setState({
      status: 'running', progress: 0, stage: 'preparing', result: null, error: null, generation,
    })
    const promise = runnerRef.current!.run(
      { kind, payload } as StudioExportRequest<K>,
      {
        signal: controller.signal,
        onProgress: ({ progress, stage }) => {
          if (generationRef.current !== generation) return
          setState(current => current.generation === generation
            ? { ...current, progress, stage }
            : current)
        },
      },
    )
    return promise.then((result) => {
      if (generationRef.current === generation) {
        setState({
          status: 'success', progress: 1, stage: 'complete', result, error: null, generation,
        })
      }
      return result
    }, (error: unknown) => {
      if (generationRef.current === generation) {
        setState({
          status: isTaskAbortError(error) ? 'canceled' : 'error',
          progress: 0,
          stage: null,
          result: null,
          error: isTaskAbortError(error) ? null : error instanceof Error ? error.message : String(error),
          generation,
        })
      }
      throw error
    })
  }, [kind])

  const cancel = useCallback(() => {
    controllerRef.current?.abort('Canceled by user')
  }, [])

  const reset = useCallback(() => {
    generationRef.current++
    controllerRef.current?.abort('Task reset')
    controllerRef.current = null
    runnerRef.current?.cancel('Task reset')
    setState({ ...INITIAL_TASK_STATE, generation: generationRef.current })
  }, [])

  return { state, run, cancel, reset }
}
