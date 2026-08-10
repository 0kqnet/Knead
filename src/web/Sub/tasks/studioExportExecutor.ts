import { generateCommandDatapack } from '../utils/commandExport'
import { exportNoteBlockBuild } from '../utils/noteBlockBuild'
import type { GenerationProgressContext } from '../utils/generationProgress'
import type {
  StudioExportRequest,
  StudioExportRequestMap,
  StudioExportResultMap,
  StudioExportTaskKind,
} from './studioExportProtocol'

export function executeStudioExportRequest<K extends StudioExportTaskKind>(
  request: StudioExportRequest<K>,
  context?: GenerationProgressContext,
): StudioExportResultMap[K] {
  if (request.kind === 'command') {
    const payload = request.payload as StudioExportRequestMap['command']
    return generateCommandDatapack(payload.project, payload.options, context) as StudioExportResultMap[K]
  }
  const payload = request.payload as StudioExportRequestMap['note-block-build']
  return exportNoteBlockBuild(payload.project, payload.options, context) as StudioExportResultMap[K]
}
