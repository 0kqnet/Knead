import { describe, expect, it } from 'vitest'
import {
  MAX_WORKSPACE_WARNING_CHARS,
  MAX_WORKSPACE_WARNING_ITEMS,
  normalizeWorkspaceWarnings,
} from './workspaceWarnings'

describe('workspaceWarnings', () => {
  it('trims, deduplicates, and preserves first-seen order', () => {
    expect(normalizeWorkspaceWarnings([' first ', 'second', 'first', '', '  '])).toEqual({
      items: ['first', 'second'],
      omitted: 0,
    })
  })

  it('bounds item count and reports the remainder', () => {
    const warnings = Array.from(
      { length: MAX_WORKSPACE_WARNING_ITEMS + 25 },
      (_, index) => `warning-${index}`,
    )
    const result = normalizeWorkspaceWarnings(warnings)
    expect(result.items).toHaveLength(MAX_WORKSPACE_WARNING_ITEMS)
    expect(result.omitted).toBe(25)
  })

  it('bounds individual warning text', () => {
    const result = normalizeWorkspaceWarnings(['x'.repeat(MAX_WORKSPACE_WARNING_CHARS + 20)])
    expect(result.items[0].length).toBe(MAX_WORKSPACE_WARNING_CHARS)
    expect(result.items[0].endsWith('…')).toBe(true)
  })
})
