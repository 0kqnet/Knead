export const COMMAND_PALETTE_LIMITS = Object.freeze({
  maxCommands: 500,
  maxIdCharacters: 128,
  maxLabelCharacters: 256,
  maxDescriptionCharacters: 1024,
  maxCategoryCharacters: 128,
  maxShortcutCharacters: 128,
  maxDisabledReasonCharacters: 512,
  maxQueryCharacters: 256,
  maxTotalCharacters: 256 * 1024,
  maxRecentCommands: 8,
  maxRecentStorageCharacters: 4096,
})

export const COMMAND_PALETTE_RECENT_STORAGE_KEY = 'knead.commandPalette.recent.v1'

export interface CommandPaletteCommand {
  id: string
  label: string
  description: string
  category: string
  shortcut?: string
  /** A string disables the command and doubles as its human-readable reason. */
  disabled?: boolean | string
  disabledReason?: string
  /** Host-owned callback. The palette never evaluates command text or packages. */
  run: () => void | Promise<void>
}

export interface NormalizedCommandPaletteCommand {
  id: string
  label: string
  description: string
  category: string
  shortcut?: string
  disabled: boolean
  disabledReason?: string
  run: () => void | Promise<void>
}

export interface NormalizedCommandPaletteResult {
  commands: NormalizedCommandPaletteCommand[]
  invalidCount: number
  duplicateCount: number
  truncatedCount: number
}

function truncateCharacters(value: string, maximum: number): string {
  return Array.from(value).slice(0, maximum).join('')
}

function withoutUnsafeControls(value: string): string {
  return Array.from(value).filter((character) => {
    const code = character.codePointAt(0) ?? 0
    if (code === 0x7f || (code < 0x20 && ![0x09, 0x0a, 0x0d].includes(code))) return false
    return !(code >= 0x202a && code <= 0x202e) && !(code >= 0x2066 && code <= 0x2069)
  }).join('')
}

function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string') return ''
  return truncateCharacters(
    withoutUnsafeControls(value.normalize('NFKC'))
      .replace(/\s+/gu, ' ')
      .trim(),
    maximum,
  )
}

function id(value: unknown): string {
  if (typeof value !== 'string') return ''
  const normalized = value.normalize('NFKC').trim()
  if (!normalized || Array.from(normalized).length > COMMAND_PALETTE_LIMITS.maxIdCharacters) return ''
  if (Array.from(normalized).some((character) => {
    const code = character.codePointAt(0) ?? 0
    return /\s/u.test(character)
      || code < 0x20 || code === 0x7f
      || (code >= 0x202a && code <= 0x202e)
      || (code >= 0x2066 && code <= 0x2069)
  })) return ''
  return normalized
}

/**
 * Copy only the fixed declarative fields and the host callback into a bounded
 * command list. Unknown fields and arbitrary package payloads never cross the
 * palette execution boundary.
 */
export function normalizeCommandPaletteCommands(
  values: readonly CommandPaletteCommand[],
): NormalizedCommandPaletteResult {
  const commands: NormalizedCommandPaletteCommand[] = []
  const ids = new Set<string>()
  let invalidCount = 0
  let duplicateCount = 0
  let truncatedCount = Math.max(0, values.length - COMMAND_PALETTE_LIMITS.maxCommands)
  let totalCharacters = 0
  const boundedValues = values.slice(0, COMMAND_PALETTE_LIMITS.maxCommands)
  for (let index = 0; index < boundedValues.length; index++) {
    const value = boundedValues[index]
    const commandId = id(value?.id)
    const label = text(value?.label, COMMAND_PALETTE_LIMITS.maxLabelCharacters)
    const description = text(value?.description, COMMAND_PALETTE_LIMITS.maxDescriptionCharacters)
    const category = text(value?.category, COMMAND_PALETTE_LIMITS.maxCategoryCharacters)
    if (!commandId || !label || !description || !category || typeof value?.run !== 'function') {
      invalidCount++
      continue
    }
    if (ids.has(commandId)) {
      duplicateCount++
      continue
    }
    const shortcut = text(value.shortcut, COMMAND_PALETTE_LIMITS.maxShortcutCharacters) || undefined
    const stringReason = typeof value.disabled === 'string'
      ? text(value.disabled, COMMAND_PALETTE_LIMITS.maxDisabledReasonCharacters)
      : ''
    const explicitReason = text(value.disabledReason, COMMAND_PALETTE_LIMITS.maxDisabledReasonCharacters)
    const disabledReason = stringReason || explicitReason || undefined
    const disabled = value.disabled === true || typeof value.disabled === 'string' || !!disabledReason
    const characterCount = commandId.length + label.length + description.length + category.length
      + (shortcut?.length ?? 0) + (disabledReason?.length ?? 0)
    if (totalCharacters + characterCount > COMMAND_PALETTE_LIMITS.maxTotalCharacters) {
      truncatedCount += boundedValues.length - index
      break
    }
    totalCharacters += characterCount
    ids.add(commandId)
    commands.push(Object.freeze({
      id: commandId,
      label,
      description,
      category,
      shortcut,
      disabled,
      disabledReason,
      run: value.run,
    }))
  }
  return { commands, invalidCount, duplicateCount, truncatedCount }
}

function searchText(value: string, locale: string): string {
  let lowered: string
  try {
    lowered = value.normalize('NFKD').toLocaleLowerCase(locale)
  }
  catch {
    lowered = value.normalize('NFKD').toLowerCase()
  }
  return lowered.replace(/\p{M}/gu, '').replace(/\s+/gu, ' ').trim()
}

function collator(locale: string): Intl.Collator {
  try {
    return new Intl.Collator(locale, { usage: 'search', sensitivity: 'base', numeric: true })
  }
  catch {
    return new Intl.Collator(undefined, { usage: 'search', sensitivity: 'base', numeric: true })
  }
}

/** Locale-aware, diacritic-insensitive, all-token search with stable ranking. */
export function searchCommandPaletteCommands(
  commands: readonly NormalizedCommandPaletteCommand[],
  rawQuery: string,
  locale: string,
): NormalizedCommandPaletteCommand[] {
  const query = text(rawQuery, COMMAND_PALETTE_LIMITS.maxQueryCharacters)
  if (!query) return [...commands]
  const tokens = searchText(query, locale).split(' ').filter(Boolean)
  const ranked = commands.flatMap((command, index) => {
    const label = searchText(command.label, locale)
    const category = searchText(command.category, locale)
    const description = searchText(command.description, locale)
    const shortcut = searchText(command.shortcut ?? '', locale)
    const commandId = searchText(command.id, locale)
    const all = `${label} ${category} ${description} ${shortcut} ${commandId}`
    if (!tokens.every(token => all.includes(token))) return []
    const phrase = searchText(query, locale)
    const score = label === phrase
      ? 0
      : label.startsWith(phrase)
        ? 1
        : label.includes(phrase)
          ? 2
          : category.includes(phrase) || shortcut.includes(phrase)
            ? 3
            : 4
    return [{ command, index, score }]
  })
  const compare = collator(locale)
  ranked.sort((left, right) => left.score - right.score
    || compare.compare(left.command.label, right.command.label)
    || left.index - right.index)
  return ranked.map(value => value.command)
}

export interface RecentCommandStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

export function readRecentCommandIds(storage?: RecentCommandStorage | null): string[] {
  if (!storage) return []
  try {
    const raw = storage.getItem(COMMAND_PALETTE_RECENT_STORAGE_KEY)
    if (!raw || raw.length > COMMAND_PALETTE_LIMITS.maxRecentStorageCharacters) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const output: string[] = []
    for (const value of parsed) {
      const commandId = id(value)
      if (!commandId || output.includes(commandId)) continue
      output.push(commandId)
      if (output.length >= COMMAND_PALETTE_LIMITS.maxRecentCommands) break
    }
    return output
  }
  catch {
    return []
  }
}

export function writeRecentCommandIds(
  storage: RecentCommandStorage | null | undefined,
  ids: readonly string[],
): void {
  if (!storage) return
  const safe = readRecentCommandIds({
    getItem: () => JSON.stringify(ids),
    setItem: () => undefined,
  })
  try {
    const value = JSON.stringify(safe)
    if (value.length <= COMMAND_PALETTE_LIMITS.maxRecentStorageCharacters) {
      storage.setItem(COMMAND_PALETTE_RECENT_STORAGE_KEY, value)
    }
  }
  catch { /* storage can be disabled or full */ }
}

export function addRecentCommandId(ids: readonly string[], commandId: string): string[] {
  const safeId = id(commandId)
  return readRecentCommandIds({
    getItem: () => JSON.stringify(safeId ? [safeId, ...ids] : ids),
    setItem: () => undefined,
  })
}
