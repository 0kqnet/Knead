import { describe, expect, it, vi } from 'vitest'
import {
  COMMAND_PALETTE_LIMITS,
  addRecentCommandId,
  normalizeCommandPaletteCommands,
  readRecentCommandIds,
  searchCommandPaletteCommands,
  writeRecentCommandIds,
  type CommandPaletteCommand,
  type RecentCommandStorage,
} from './commandPalette'

function command(overrides: Partial<CommandPaletteCommand> = {}): CommandPaletteCommand {
  return {
    id: 'file.open',
    label: 'Open project',
    description: 'Open a Knead project from disk',
    category: 'File',
    shortcut: 'Ctrl+O',
    run: vi.fn(),
    ...overrides,
  }
}

describe('command palette model', () => {
  it('normalizes declarative fields and rejects invalid or duplicate descriptors', () => {
    const result = normalizeCommandPaletteCommands([
      command({ label: '  Open\n project  ' }),
      command({ label: 'Duplicate ID' }),
      { ...command({ id: 'bad id' }), run: undefined } as unknown as CommandPaletteCommand,
      command({ id: 'edit.locked', disabled: 'Selection is locked' }),
    ])
    expect(result.commands).toHaveLength(2)
    expect(result.commands[0].label).toBe('Open project')
    expect(result.commands[1]).toMatchObject({
      id: 'edit.locked', disabled: true, disabledReason: 'Selection is locked',
    })
    expect(result.duplicateCount).toBe(1)
    expect(result.invalidCount).toBe(1)
  })

  it('enforces command-count and total-text budgets', () => {
    const many = Array.from({ length: COMMAND_PALETTE_LIMITS.maxCommands + 20 }, (_, index) => command({
      id: `command.${index}`,
      label: `Command ${index} ${'x'.repeat(250)}`,
      description: 'd'.repeat(1024),
      category: `Category ${index}`,
    }))
    const result = normalizeCommandPaletteCommands(many)
    expect(result.commands.length).toBeLessThanOrEqual(COMMAND_PALETTE_LIMITS.maxCommands)
    expect(result.truncatedCount).toBeGreaterThan(0)
  })

  it('searches locale-aware text, diacritics, categories, and shortcuts', () => {
    const commands = normalizeCommandPaletteCommands([
      command({ id: 'settings.audio', label: 'Réglages audio', category: 'Préférences', shortcut: 'Ctrl+,' }),
      command({ id: 'transport.play', label: '再生', description: 'タイムラインをスタート', category: 'トランスポート', shortcut: 'Space' }),
    ]).commands
    expect(searchCommandPaletteCommands(commands, 'reglages', 'fr')[0].id).toBe('settings.audio')
    expect(searchCommandPaletteCommands(commands, 'preferences ctrl', 'fr')[0].id).toBe('settings.audio')
    expect(searchCommandPaletteCommands(commands, 'タイムライン', 'ja')[0].id).toBe('transport.play')
  })

  it('stores only a bounded, unique list of recent IDs and tolerates broken storage', () => {
    let value: string | null = null
    const storage: RecentCommandStorage = {
      getItem: () => value,
      setItem: (_key, next) => { value = next },
    }
    const ids = Array.from({ length: 20 }, (_, index) => `command.${index}`)
    writeRecentCommandIds(storage, ids)
    expect(readRecentCommandIds(storage)).toEqual(ids.slice(0, COMMAND_PALETTE_LIMITS.maxRecentCommands))
    expect(addRecentCommandId(['a', 'b', 'a'], 'b')).toEqual(['b', 'a'])
    value = '{broken'
    expect(readRecentCommandIds(storage)).toEqual([])
    const deniedStorage = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => undefined,
    }
    expect(readRecentCommandIds(deniedStorage)).toEqual([])
  })
})
