import type { ExtensionDefinition } from '../types'
import { humanizeExtension } from './humanize'
import { noteBlockComposerExtension } from './noteBlockComposer'

export * from './humanize'
export * from './noteBlockComposer'

export const BUILTIN_EXTENSIONS: readonly ExtensionDefinition[] = Object.freeze([
  humanizeExtension,
  noteBlockComposerExtension,
])
