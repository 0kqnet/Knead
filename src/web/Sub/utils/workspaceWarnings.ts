export const MAX_WORKSPACE_WARNING_ITEMS = 100
export const MAX_WORKSPACE_WARNING_SCAN = 1_000
export const MAX_WORKSPACE_WARNING_CHARS = 4_096
export const MAX_WORKSPACE_WARNING_TOTAL_CHARS = 64 * 1024

export interface WorkspaceWarningList {
  items: string[]
  omitted: number
}

export function normalizeWorkspaceWarnings(
  warnings: readonly string[],
): WorkspaceWarningList {
  const items: string[] = []
  const seen = new Set<string>()
  let omitted = Math.max(0, warnings.length - MAX_WORKSPACE_WARNING_SCAN)
  let totalCharacters = 0
  const scanned = warnings.slice(0, MAX_WORKSPACE_WARNING_SCAN)
  for (const raw of scanned) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    const warning = trimmed.length > MAX_WORKSPACE_WARNING_CHARS
      ? `${trimmed.slice(0, MAX_WORKSPACE_WARNING_CHARS - 1)}…`
      : trimmed
    if (seen.has(warning)) continue
    seen.add(warning)
    if (
      items.length >= MAX_WORKSPACE_WARNING_ITEMS
      || totalCharacters + warning.length > MAX_WORKSPACE_WARNING_TOTAL_CHARS
    ) {
      omitted++
      continue
    }
    totalCharacters += warning.length
    items.push(warning)
  }
  return { items, omitted }
}
