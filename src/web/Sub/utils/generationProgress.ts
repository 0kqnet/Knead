export type GenerationStage =
  | 'preparing'
  | 'analyzing'
  | 'collecting-events'
  | 'building-model'
  | 'writing-files'
  | 'compressing'
  | 'serializing'
  | 'complete'

/**
 * Optional instrumentation for deterministic synchronous generators.
 *
 * The generators intentionally remain synchronous so their direct API and
 * byte output stay stable. Production callers run them inside a disposable
 * Worker; `isCanceled` is additionally useful to cooperative/fallback hosts.
 */
export interface GenerationProgressContext {
  reportProgress?: (progress: number, stage: GenerationStage) => void
  isCanceled?: () => boolean
}

export class GenerationCanceledError extends Error {
  constructor() {
    super('Generation canceled')
    this.name = 'AbortError'
  }
}

export function generationCheckpoint(
  context: GenerationProgressContext | undefined,
  progress: number,
  stage: GenerationStage,
): void {
  if (context?.isCanceled?.()) throw new GenerationCanceledError()
  context?.reportProgress?.(Math.max(0, Math.min(1, progress)), stage)
}
