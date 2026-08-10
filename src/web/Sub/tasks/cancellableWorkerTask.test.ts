import { describe, expect, it, vi } from 'vitest'
import {
  CancellableWorkerTask,
  isTaskAbortError,
  type WorkerTaskLike,
  type WorkerTaskResponse,
  type WorkerTaskRunMessage,
} from './cancellableWorkerTask'

type Request = { value: number }
type Result = { doubled: number }
type Stage = 'working' | 'complete'

class FakeWorker implements WorkerTaskLike<Request, Result, Stage> {
  onmessage: ((event: MessageEvent<WorkerTaskResponse<Result, Stage>>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null
  posted: WorkerTaskRunMessage<Request>[] = []
  terminate = vi.fn()

  postMessage(message: WorkerTaskRunMessage<Request>): void {
    this.posted.push(message)
  }

  emit(message: WorkerTaskResponse<Result, Stage>): void {
    this.onmessage?.({ data: message } as MessageEvent<WorkerTaskResponse<Result, Stage>>)
  }
}

describe('CancellableWorkerTask', () => {
  it('bounds and monotonizes progress before resolving the owned generation', async () => {
    const worker = new FakeWorker()
    const progress = vi.fn()
    const runner = new CancellableWorkerTask<Request, Result, Stage>(() => worker)
    const promise = runner.run({ value: 4 }, { onProgress: progress })
    const generation = worker.posted[0].generation

    worker.emit({ type: 'progress', generation, progress: -2, stage: 'working' })
    worker.emit({ type: 'progress', generation, progress: 0.6, stage: 'working' })
    worker.emit({ type: 'progress', generation, progress: 0.2, stage: 'working' })
    worker.emit({ type: 'success', generation, result: { doubled: 8 } })

    await expect(promise).resolves.toEqual({ doubled: 8 })
    expect(progress.mock.calls.map(([value]) => value.progress)).toEqual([0, 0.6, 0.6, 1])
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })

  it('terminates a superseded generation and ignores its late result', async () => {
    const workers = [new FakeWorker(), new FakeWorker()]
    const runner = new CancellableWorkerTask<Request, Result, Stage>(() => workers.shift()!)
    const firstWorker = workers[0]
    const secondWorker = workers[1]
    const first = runner.run({ value: 1 })
    const firstGeneration = firstWorker.posted[0].generation
    const second = runner.run({ value: 2 })
    const secondGeneration = secondWorker.posted[0].generation

    await expect(first).rejects.toSatisfy(isTaskAbortError)
    expect(firstWorker.terminate).toHaveBeenCalledTimes(1)
    firstWorker.emit({ type: 'success', generation: firstGeneration, result: { doubled: 2 } })
    secondWorker.emit({ type: 'success', generation: secondGeneration, result: { doubled: 4 } })
    await expect(second).resolves.toEqual({ doubled: 4 })
  })

  it('binds AbortSignal to hard worker cancellation', async () => {
    const worker = new FakeWorker()
    const runner = new CancellableWorkerTask<Request, Result, Stage>(() => worker)
    const controller = new AbortController()
    const promise = runner.run({ value: 5 }, { signal: controller.signal })
    controller.abort('User canceled')

    await expect(promise).rejects.toSatisfy(isTaskAbortError)
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })

  it('cleans up when structured cloning fails synchronously', async () => {
    const worker = new FakeWorker()
    worker.postMessage = () => {
      throw new DOMException('Cannot clone', 'DataCloneError')
    }
    const runner = new CancellableWorkerTask<Request, Result, Stage>(() => worker)

    await expect(runner.run({ value: 5 })).rejects.toMatchObject({ name: 'DataCloneError' })
    expect(worker.terminate).toHaveBeenCalledTimes(1)
    expect(runner.cancel()).toBe(false)
  })
})
