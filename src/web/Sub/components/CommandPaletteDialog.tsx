import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { StudioDialogClose } from './StudioDialogClose'
import { Box, Button, Flex, Input, Text } from '@yamada-ui/react'
import { useTranslation } from 'react-i18next'
import {
  COMMAND_PALETTE_LIMITS,
  addRecentCommandId,
  normalizeCommandPaletteCommands,
  readRecentCommandIds,
  searchCommandPaletteCommands,
  writeRecentCommandIds,
  type CommandPaletteCommand,
  type NormalizedCommandPaletteCommand,
  type RecentCommandStorage,
} from '../utils/commandPalette'

export type CommandPaletteView = 'commands' | 'shortcuts'

export interface CommandPaletteDialogProps {
  open: boolean
  commands: readonly CommandPaletteCommand[]
  locale?: string
  initialView?: CommandPaletteView
  closeOnRun?: boolean
  /** Undefined uses bounded sessionStorage; null disables recent-command storage. */
  recentStorage?: RecentCommandStorage | null
  onClose: () => void
}

interface CommandGroup {
  key: string
  label: string
  commands: NormalizedCommandPaletteCommand[]
}

const focusableSelector = [
  'button:not([disabled])',
  'input:not([disabled])',
  '[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function defaultStorage(): RecentCommandStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  }
  catch {
    return null
  }
}

function groupCommands(commands: readonly NormalizedCommandPaletteCommand[]): CommandGroup[] {
  const groups = new Map<string, NormalizedCommandPaletteCommand[]>()
  for (const command of commands) {
    const values = groups.get(command.category) ?? []
    values.push(command)
    groups.set(command.category, values)
  }
  return [...groups].map(([category, values]) => ({
    key: `category:${category}`,
    label: category,
    commands: values,
  }))
}

function upper(value: string, locale: string): string {
  try {
    return value.toLocaleUpperCase(locale)
  }
  catch {
    return value.toUpperCase()
  }
}

export const CommandPaletteDialog: React.FC<CommandPaletteDialogProps> = ({
  open,
  commands,
  locale,
  initialView = 'commands',
  closeOnRun = true,
  recentStorage,
  onClose,
}) => {
  const { t, i18n } = useTranslation()
  const language = locale ?? i18n.language ?? 'en'
  const normalized = useMemo(() => normalizeCommandPaletteCommands(commands), [commands])
  const storage = useMemo(
    () => recentStorage === undefined ? defaultStorage() : recentStorage,
    [recentStorage],
  )
  const instanceId = useId().replace(/:/gu, '')
  const inputId = `command-palette-input-${instanceId}`
  const listboxId = `command-palette-list-${instanceId}`
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const runningRef = useRef(false)
  const executionGenerationRef = useRef(0)
  const [query, setQuery] = useState('')
  const [view, setView] = useState<CommandPaletteView>(initialView)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [recentIds, setRecentIds] = useState<string[]>([])
  const [runningId, setRunningId] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [statusError, setStatusError] = useState(false)

  useLayoutEffect(() => {
    if (open) executionGenerationRef.current++
  }, [open])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setView(initialView)
    setSelectedIndex(0)
    setRecentIds(readRecentCommandIds(storage))
    setRunningId(null)
    runningRef.current = false
    setStatus('')
    setStatusError(false)
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const frame = requestAnimationFrame(() => inputRef.current?.focus())
    return () => {
      cancelAnimationFrame(frame)
      previousFocusRef.current?.focus()
      previousFocusRef.current = null
    }
  }, [initialView, open, storage])

  const baseCommands = useMemo(() => (
    view === 'shortcuts'
      ? normalized.commands.filter(command => !!command.shortcut)
      : normalized.commands
  ), [normalized.commands, view])
  const searched = useMemo(
    () => searchCommandPaletteCommands(baseCommands, query, language),
    [baseCommands, language, query],
  )
  const groups = useMemo(() => {
    if (query || view === 'shortcuts') return groupCommands(searched)
    const byId = new Map(searched.map(command => [command.id, command]))
    const recent = recentIds.flatMap(commandId => byId.get(commandId) ?? [])
    const recentSet = new Set(recent.map(command => command.id))
    return [
      ...(recent.length
        ? [{
            key: 'recent',
            label: t('studio.command_palette_recent'),
            commands: recent,
          }]
        : []),
      ...groupCommands(searched.filter(command => !recentSet.has(command.id))),
    ]
  }, [query, recentIds, searched, t, view])
  const visibleCommands = useMemo(() => groups.flatMap(group => group.commands), [groups])
  const selectedCommand = visibleCommands[selectedIndex]
  const selectedOptionId = selectedCommand
    ? `command-palette-option-${instanceId}-${selectedIndex}`
    : undefined

  useEffect(() => {
    setSelectedIndex(index => Math.max(0, Math.min(index, Math.max(0, visibleCommands.length - 1))))
  }, [visibleCommands])

  useEffect(() => {
    if (!open || !selectedOptionId) return
    const option = document.getElementById(selectedOptionId)
    if (typeof option?.scrollIntoView === 'function') option.scrollIntoView({ block: 'nearest' })
  }, [open, selectedOptionId])

  const execute = useCallback(async (command: NormalizedCommandPaletteCommand | undefined) => {
    if (!command || runningRef.current) return
    if (command.disabled) {
      setStatus(command.disabledReason || t('studio.command_palette_disabled'))
      setStatusError(false)
      return
    }
    setStatus('')
    setStatusError(false)
    runningRef.current = true
    setRunningId(command.id)
    const executionGeneration = executionGenerationRef.current
    try {
      await command.run()
      if (executionGeneration !== executionGenerationRef.current) return
      const nextRecent = addRecentCommandId(recentIds, command.id)
      setRecentIds(nextRecent)
      writeRecentCommandIds(storage, nextRecent)
      if (closeOnRun) onClose()
      else setStatus(t('studio.command_palette_ran', { command: command.label }))
    }
    catch (error) {
      if (executionGeneration !== executionGenerationRef.current) return
      const detail = (error instanceof Error ? error.message : String(error)).slice(0, 512)
      setStatus(t('studio.command_palette_failed', { command: command.label, error: detail }))
      setStatusError(true)
    }
    finally {
      if (executionGeneration === executionGenerationRef.current) {
        runningRef.current = false
        setRunningId(null)
      }
    }
  }, [closeOnRun, onClose, recentIds, storage, t])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Tab') {
        event.stopPropagation()
        const focusable = Array.from(overlayRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? [])
        if (!focusable.length) {
          event.preventDefault()
          overlayRef.current?.focus()
          return
        }
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        const focusIsInside = !!overlayRef.current?.contains(document.activeElement)
        if (!focusIsInside) {
          event.preventDefault()
          ;(event.shiftKey ? last : first).focus()
        }
        else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        }
        else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
        return
      }
      if (event.target instanceof HTMLButtonElement) return
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
        event.preventDefault()
        event.stopPropagation()
        if (!visibleCommands.length) return
        setSelectedIndex((index) => {
          if (event.key === 'Home') return 0
          if (event.key === 'End') return visibleCommands.length - 1
          const delta = event.key === 'ArrowDown' ? 1 : -1
          return (index + delta + visibleCommands.length) % visibleCommands.length
        })
      }
      else if (event.key === 'Enter') {
        event.preventDefault()
        event.stopPropagation()
        void execute(selectedCommand)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [execute, onClose, open, selectedCommand, visibleCommands.length])

  if (!open) return null

  const warningCount = normalized.invalidCount + normalized.duplicateCount + normalized.truncatedCount

  return (
    <Box
      ref={overlayRef}
      role="dialog" aria-modal="true" aria-labelledby={`command-palette-title-${instanceId}`}
      tabIndex={-1} position="fixed" inset="0" zIndex="2250" bg="var(--knead-scrim)"
      display="flex" alignItems="flex-start" justifyContent="center" p="clamp(16px, 8vh, 72px) 16px"
      onPointerDown={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <Box
        w="720px" maxW="100%" maxH="min(760px, calc(100vh - 32px))"
        display="flex" flexDirection="column" bg="var(--studio-frame)" border="1px solid"
        borderColor="var(--studio-line)" borderRadius="xl" boxShadow="2xl" overflow="hidden"
      >
        <Flex align="center" gap="3" px="4" pt="4">
          <Text id={`command-palette-title-${instanceId}`} as="h2" fontSize="lg" fontWeight="bold" flex="1">
            {t('studio.command_palette_title')}
          </Text>
          <Flex gap="1">
            <Button
              size="xs" aria-pressed={view === 'commands'}
              variant="surface" colorScheme={view === 'commands' ? 'primary' : 'gray'}
              onClick={() => {
                setView('commands')
                setQuery('')
                setSelectedIndex(0)
                inputRef.current?.focus()
              }}
            >
              {t('studio.command_palette_commands')}
            </Button>
            <Button
              size="xs" aria-pressed={view === 'shortcuts'}
              variant="surface" colorScheme={view === 'shortcuts' ? 'primary' : 'gray'}
              onClick={() => {
                setView('shortcuts')
                setQuery('')
                setSelectedIndex(0)
                inputRef.current?.focus()
              }}
            >
              {t('studio.command_palette_shortcuts')}
            </Button>
            <StudioDialogClose aria-label={t('studio.command_palette_close')} onClick={onClose} />
          </Flex>
        </Flex>

        <Box px="4" py="3">
          <Input
            ref={inputRef}
            id={inputId}
            role="combobox"
            aria-label={t('studio.command_palette_search')}
            aria-expanded="true"
            aria-controls={listboxId}
            aria-activedescendant={selectedOptionId}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck="false"
            maxLength={COMMAND_PALETTE_LIMITS.maxQueryCharacters}
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value)
              setSelectedIndex(0)
              setStatus('')
              setStatusError(false)
            }}
            placeholder={view === 'shortcuts'
              ? t('studio.command_palette_search_shortcuts')
              : t('studio.command_palette_search_commands')}
          />
          {warningCount > 0 && (
            <Text mt="2" fontSize="xs" color="var(--studio-warning)">
              {t('studio.command_palette_normalized', { count: warningCount })}
            </Text>
          )}
        </Box>

        <Box
          id={listboxId} role="listbox" aria-label={t('studio.command_palette_results')}
          flex="1" minH="160px" overflowY="auto" px="2" pb="2"
        >
          {!visibleCommands.length && (
            <Text p="8" textAlign="center" color="var(--studio-muted)">{t('studio.command_palette_no_results')}</Text>
          )}
          {groups.map((group) => {
            let groupOffset = 0
            for (const previous of groups) {
              if (previous === group) break
              groupOffset += previous.commands.length
            }
            return (
              <Box key={group.key} role="presentation">
                <Text
                  role="presentation" px="3" pt="3" pb="1"
                  fontSize="10px" fontWeight="bold" letterSpacing=".08em" color="var(--studio-muted)"
                >
                  {upper(group.label, language)}
                </Text>
                {group.commands.map((command, commandIndex) => {
                  const index = groupOffset + commandIndex
                  const selected = index === selectedIndex
                  const disabledReason = command.disabled
                    ? command.disabledReason || t('studio.command_palette_disabled')
                    : undefined
                  return (
                    <Flex
                      key={command.id}
                      id={`command-palette-option-${instanceId}-${index}`}
                      role="option" aria-selected={selected} aria-disabled={command.disabled || undefined}
                      align="center" gap="3" px="3" py="2" borderRadius="md"
                      bg={selected ? 'var(--studio-accent-soft)' : 'transparent'} opacity={command.disabled ? 0.55 : 1}
                      color={selected ? 'var(--studio-selected-text)' : 'var(--studio-text)'}
                      cursor={command.disabled ? 'not-allowed' : 'pointer'}
                      onPointerMove={() => setSelectedIndex(index)}
                      onClick={() => { void execute(command) }}
                    >
                      <Box flex="1" minW="0">
                        <Flex align="center" gap="2">
                          <Text fontSize="sm" fontWeight="bold" whiteSpace="nowrap" overflow="hidden" textOverflow="ellipsis">
                            {command.label}
                          </Text>
                          {runningId === command.id && (
                            <Text fontSize="xs" color="var(--studio-accent-text)">{t('studio.command_palette_running')}</Text>
                          )}
                        </Flex>
                        <Text fontSize="xs" color={disabledReason ? 'var(--studio-warning)' : 'var(--studio-muted)'}>
                          {disabledReason || command.description}
                        </Text>
                      </Box>
                      {command.shortcut && (
                        <kbd
                          style={{
                            maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            border: '1px solid var(--knead-control-line)', borderBottomWidth: 2, borderRadius: 5,
                            padding: '2px 7px', color: 'var(--studio-muted)', fontSize: 11,
                          }}
                        >
                          {command.shortcut}
                        </kbd>
                      )}
                    </Flex>
                  )
                })}
              </Box>
            )
          })}
        </Box>

        <Flex minH="38px" align="center" gap="3" px="4" py="2" bg="var(--studio-canvas)" borderTop="1px solid" borderColor="var(--studio-line)">
          <Text role="status" aria-live="polite" flex="1" fontSize="xs" color={statusError ? 'var(--studio-error)' : 'var(--studio-muted)'}>
            {status || selectedCommand?.description || t('studio.command_palette_hint')}
          </Text>
          <Text fontSize="10px" color="var(--studio-muted)">↑↓ · Enter · Esc</Text>
        </Flex>
      </Box>
    </Box>
  )
}
