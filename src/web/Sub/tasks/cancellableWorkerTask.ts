export interface WorkerTaskProgress<Stage extends string> {
  progress: number
  stage: Stage
}

export interface WorkerTaskRunOptions<Stage extends string> {
  signal?: AbortSignal
  onProgress?: (update: WorkerTaskProgress<Stage>) => void
}

export interface WorkerTaskRunMessage<Request> {
  type: 'run'
  generation: number
  request: Request
}

export type WorkerTaskResponse<Result, Stage extends string> =
  | { type: 'progress', generation: number, progress: number, stage: Stage }
  | { type: 'success', generation: number, result: Result }
  | { type: 'error', generation: number, name: string, message: string, stack?: string }

export interface WorkerTaskLike<Request, Result, Stage extends string> {
  postMessage(message: WorkerTaskRunMessage<Request>): void
  terminate(): void
  onmessage: ((event: MessageEvent<WorkerTaskResponse<Result, Stage>>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null
}

export type WorkerTaskFactory<Request, Result, Stage extends string> =
  () => WorkerTaskLike<Request, Result, Stage>

export function createTaskAbortError(reason?: unknown): Error {
  const message = typeof reason === 'string' && reason ? reason : 'Task canceled'
  if (typeof DOMException !== 'undefined') return new DOMException(message, 'AbortError')
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

export function isTaskAbortError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'name' in error
    && error.name === 'AbortError'
}

/**
 * Owns at most one disposable Worker. Starting a new generation hard-cancels
 * the previous CPU job and stale messages can never resolve the new promise.
 */
export class CancellableWorkerTask<Request, Result, Stage extends string> {
  private generation = 0

  private active: {
    generation: number
    worker: WorkerTaskLike<Request, Result, Stage>
    reject: (reason: Error) => void
    removeAbortListener: () => void
  } | null = null

  constructor(private readonly createWorker: WorkerTaskFactory<Request, Result, Stage>) {}

  run(
    request: Request,
    { signal, onProgress }: WorkerTaskRunOptions<Stage> = {},
  ): Promise<Result> {
    this.cancel('Superseded by a newer task')
    const generation = ++this.generation
    if (signal?.aborted) return Promise.reject(createTaskAbortError(signal.reason))

    let worker: WorkerTaskLike<Request, Result, Stage>
    try {
      worker = this.createWorker()
    }
    catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
    return new Promise<Result>((resolve, reject) => {
      let lastProgress = 0
      let lastStage: Stage | null = null
      const settle = (callback: () => void) => {
        const active = this.active
        if (!active || active.generation !== generation) return
        this.active = null
        active.removeAbortListener()
        active.worker.terminate()
        callback()
      }
      const abort = () => settle(() => reject(createTaskAbortError(signal?.reason)))
      const removeAbortListener = () => signal?.removeEventListener('abort', abort)
      this.active = { generation, worker, reject, removeAbortListener }
      signal?.addEventListener('abort', abort, { once: true })

      worker.onmessage = (event) => {
        const message = event.data
        if (!message || message.generation !== generation || this.active?.generation !== generation) return
        if (message.type === 'progress') {
          if (!Number.isFinite(message.progress) || typeof message.stage !== 'string') return
          const progress = Math.max(lastProgress, Math.max(0, Math.min(1, message.progress)))
          lastProgress = progress
          lastStage = message.stage
          onProgress?.({ progress, stage: message.stage })
          return
        }
        if (message.type === 'success') {
          if (lastProgress < 1 && lastStage !== null) onProgress?.({ progress: 1, stage: lastStage })
          settle(() => resolve(message.result))
          return
        }
        const error = new Error(message.message || 'Worker task failed')
        error.name = message.name || 'Error'
        if (message.stack) error.stack = message.stack
        settle(() => reject(error))
      }
      worker.onerror = (event) => {
        event.preventDefault?.()
        settle(() => reject(new Error(event.message || 'Worker task crashed')))
      }
      worker.onmessageerror = () => {
        settle(() => reject(new Error('Worker returned an unreadable result')))
      }
      try {
        worker.postMessage({ type: 'run', generation, request })
      }
      catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error))
        settle(() => reject(normalized))
      }
    })
  }

  cancel(reason?: unknown): boolean {
    const active = this.active
    if (!active) return false
    this.active = null
    active.removeAbortListener()
    active.worker.terminate()
    active.reject(createTaskAbortError(reason))
    return true
  }

  dispose(): void {
    this.cancel('Task runner disposed')
  }
}
