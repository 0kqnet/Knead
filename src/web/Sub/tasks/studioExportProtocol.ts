import type { TimelineState } from '../types/timeline'
import type { CommandExportOptions, CommandExportResult } from '../utils/commandExport'
import type { NoteBlockBuildOptions, NoteBlockBuildResult } from '../utils/noteBlockBuild'
import type { GenerationStage } from '../utils/generationProgress'

export interface StudioExportRequestMap {
  'command': {
    project: TimelineState
    options: CommandExportOptions
  }
  'note-block-build': {
    project: TimelineState
    options: Partial<NoteBlockBuildOptions>
  }
}

export interface StudioExportResultMap {
  'command': CommandExportResult
  'note-block-build': NoteBlockBuildResult
}

export type StudioExportTaskKind = keyof StudioExportRequestMap

export type StudioExportRequest<K extends StudioExportTaskKind = StudioExportTaskKind> = {
  [P in K]: { kind: P, payload: StudioExportRequestMap[P] }
}[K]

export interface StudioExportWorkerRunMessage {
  type: 'run'
  generation: number
  request: StudioExportRequest
}

export interface StudioExportWorkerProgressMessage {
  type: 'progress'
  generation: number
  progress: number
  stage: GenerationStage
}

export interface StudioExportWorkerSuccessMessage {
  type: 'success'
  generation: number
  result: StudioExportResultMap[StudioExportTaskKind]
}

export interface StudioExportWorkerErrorMessage {
  type: 'error'
  generation: number
  name: string
  message: string
  stack?: string
}

export type StudioExportWorkerMessage =
  | StudioExportWorkerProgressMessage
  | StudioExportWorkerSuccessMessage
  | StudioExportWorkerErrorMessage
