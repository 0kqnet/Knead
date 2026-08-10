/// <reference lib="webworker" />

import { executeStudioExportRequest } from '../tasks/studioExportExecutor'
import type {
  StudioExportWorkerMessage,
  StudioExportWorkerRunMessage,
} from '../tasks/studioExportProtocol'

const workerScope = self as DedicatedWorkerGlobalScope

function post(message: StudioExportWorkerMessage, transfer: Transferable[] = []): void {
  workerScope.postMessage(message, transfer)
}

workerScope.onmessage = (event: MessageEvent<StudioExportWorkerRunMessage>) => {
  const message = event.data
  if (!message || message.type !== 'run' || !Number.isSafeInteger(message.generation)) return
  try {
    const result = executeStudioExportRequest(message.request, {
      reportProgress: (progress, stage) => post({
        type: 'progress', generation: message.generation, progress, stage,
      }),
    })
    const transfer = message.request.kind === 'note-block-build'
      ? [(result as { data: Uint8Array }).data.buffer as ArrayBuffer]
      : []
    post({ type: 'success', generation: message.generation, result }, transfer)
  }
  catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error))
    post({
      type: 'error',
      generation: message.generation,
      name: normalized.name,
      message: normalized.message,
      ...(normalized.stack ? { stack: normalized.stack } : {}),
    })
  }
}

export {}
