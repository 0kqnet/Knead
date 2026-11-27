import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Box, Button, Flex, Select, Text } from '@yamada-ui/react'
import { StudioDialogClose } from './StudioDialogClose'
import { useModalDialog } from '../hooks/useModalDialog'
import { CommitNumberInput } from '../../components/CommitNumberInput'
import type { TimelineState } from '../types/timeline'
import { DeclarativeExtensionPackagesPanel } from './DeclarativeExtensionPackagesPanel'
import {
  BUILTIN_EXTENSIONS,
  DEFAULT_HUMANIZE_OPTIONS,
  DEFAULT_NOTE_BLOCK_COMPOSER_OPTIONS,
  ExtensionRegistry,
  humanizeExtension,
  humanizeTransform,
  noteBlockComposerExtension,
  noteBlockComposerTransform,
  noteBlockPresetCommand,
  type ExtensionInfo,
  type ExtensionResult,
  type HumanizeOptions,
  type NoteBlockPattern,
  type NoteBlockPreset,
} from '../extensions'

interface Props {
  open: boolean
  project: TimelineState
  selectedIds: ReadonlySet<string> | readonly string[]
  onApply: (nextState: TimelineState, nextSelectedIds?: readonly string[]) => void | Promise<void>
  onClose: () => void
}

interface Feedback {
  readonly tone: 'error' | 'success' | 'info'
  readonly text: string
}

const NOTE_BLOCK_PRESETS: { label: string, value: NoteBlockPreset }[] = [
  { label: 'Major triad (0, 4, 7)', value: 'major' },
  { label: 'Minor triad (0, 3, 7)', value: 'minor' },
  { label: 'Power chord (0, 7, 12)', value: 'power' },
  { label: 'Octave (0, 12)', value: 'octave' },
]

const DISABLED_EXTENSIONS_SETTING = 'studioDisabledExtensions'
const BUILTIN_EXTENSION_IDS = new Set(BUILTIN_EXTENSIONS.map(extension => extension.manifest.id))

function createTrustedRegistry(): ExtensionRegistry {
  const registry = new ExtensionRegistry()
  for (const extension of BUILTIN_EXTENSIONS) {
    registry.register(extension, extension.manifest.permissions.required)
  }
  return registry
}

function idsFrom(value: ReadonlySet<string> | readonly string[]): readonly string[] {
  return [...value]
}

function resultError(result: ExtensionResult<unknown>): string {
  return result.ok ? '' : `${result.error.phase}: ${result.error.message}`
}

function unknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function transformedSelection(
  previous: TimelineState,
  next: TimelineState,
  selectedIds: readonly string[],
): readonly string[] {
  const selected = new Set(selectedIds)
  const untouchedIds = new Set(previous.markers.filter(marker => !selected.has(marker.id)).map(marker => marker.id))
  return next.markers.filter(marker => !untouchedIds.has(marker.id)).map(marker => marker.id)
}

function statusColor(info: ExtensionInfo | undefined): string {
  if (info?.status === 'active') return 'var(--studio-success)'
  if (info?.status === 'activating' || info?.status === 'deactivating') return 'var(--studio-warning)'
  return 'var(--studio-muted)'
}

export const ExtensionManagerDialog: React.FC<Props> = ({
  open,
  project,
  selectedIds,
  onApply,
  onClose,
}) => {
  const [registry] = useState(createTrustedRegistry)
  const [extensions, setExtensions] = useState<readonly ExtensionInfo[]>(() => registry.list())
  const [busy, setBusy] = useState<string | null>(null)
  const [packagesBusy, setPackagesBusy] = useState(false)
  const operationBusy = busy !== null || packagesBusy
  const { dialogRef } = useModalDialog({ open, busy: operationBusy, onClose })
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [humanizeOptions, setHumanizeOptions] = useState<HumanizeOptions>(DEFAULT_HUMANIZE_OPTIONS)
  const [notePreset, setNotePreset] = useState<NoteBlockPreset>('major')
  const [notePattern, setNotePattern] = useState<NoteBlockPattern>('chord')
  const [arpeggioStep, setArpeggioStep] = useState(DEFAULT_NOTE_BLOCK_COMPOSER_OPTIONS.stepTicks)
  const [noteVolumeScale, setNoteVolumeScale] = useState(DEFAULT_NOTE_BLOCK_COMPOSER_OPTIONS.volumeScale)
  const [noteLaneSpread, setNoteLaneSpread] = useState(DEFAULT_NOTE_BLOCK_COMPOSER_OPTIONS.laneSpread)

  const refreshExtensions = useCallback(() => setExtensions(registry.list()), [registry])
  const persistDisabledExtensions = useCallback(() => {
    if (!('myAPI' in window)) return
    const disabled = registry.list()
      .filter(info => BUILTIN_EXTENSION_IDS.has(info.manifest.id) && info.status === 'inactive')
      .map(info => info.manifest.id)
    window.myAPI.setSetting(DISABLED_EXTENSIONS_SETTING, JSON.stringify(disabled))
  }, [registry])
  const selectedMarkerIds = useMemo(() => {
    const projectIds = new Set(project.markers.map(marker => marker.id))
    return [...new Set(idsFrom(selectedIds))].filter(id => projectIds.has(id))
  }, [project.markers, selectedIds])
  const humanizeInfo = extensions.find(info => info.manifest.id === humanizeExtension.manifest.id)
  const composerInfo = extensions.find(info => info.manifest.id === noteBlockComposerExtension.manifest.id)

  useEffect(() => {
    let alive = true
    const activateBuiltins = async () => {
      let disabled = new Set<string>()
      if ('myAPI' in window) {
        try {
          const saved = await window.myAPI.getSetting(DISABLED_EXTENSIONS_SETTING)
          const parsed = typeof saved === 'string' ? JSON.parse(saved) : []
          if (Array.isArray(parsed)) disabled = new Set(parsed.filter(value => typeof value === 'string'))
        }
        catch {
          disabled = new Set()
        }
      }
      for (const extension of BUILTIN_EXTENSIONS) {
        if (disabled.has(extension.manifest.id)) continue
        const result = await registry.activate(extension.manifest.id)
        if (!result.ok && alive) setFeedback({ tone: 'error', text: resultError(result) })
      }
      if (alive) refreshExtensions()
    }
    void activateBuiltins()
    return () => {
      alive = false
      for (const extension of BUILTIN_EXTENSIONS) void registry.deactivate(extension.manifest.id)
    }
  }, [refreshExtensions, registry])

  useEffect(() => {
    if (open) setFeedback(null)
  }, [open])

  if (!open) return null

  const toggleExtension = async (extensionId: string) => {
    const info = registry.get(extensionId)
    if (!info || busy) return
    setBusy(`toggle:${extensionId}`)
    setFeedback(null)
    try {
      const result = info.status === 'active'
        ? await registry.deactivate(extensionId)
        : await registry.activate(extensionId)
      refreshExtensions()
      if (result.ok) persistDisabledExtensions()
      if (!result.ok) setFeedback({ tone: 'error', text: resultError(result) })
      else setFeedback({
        tone: 'info',
        text: `${info.manifest.name} ${info.status === 'active' ? 'disabled' : 'enabled'}.`,
      })
    }
    catch (error) {
      setFeedback({ tone: 'error', text: `lifecycle: ${unknownError(error)}` })
    }
    finally {
      setBusy(null)
    }
  }

  const applyHumanize = async () => {
    if (selectedMarkerIds.length === 0 || busy) return
    setBusy('run:humanize')
    setFeedback(null)
    try {
      const result = await registry.executeMarkerTransform(
        humanizeExtension.manifest.id,
        humanizeTransform,
        humanizeOptions,
        { project, markerIds: selectedMarkerIds },
      )
      if (!result.ok) setFeedback({ tone: 'error', text: resultError(result) })
      else {
        const nextSelectedIds = transformedSelection(project, result.value, selectedMarkerIds)
        await onApply(result.value, nextSelectedIds)
        setFeedback({ tone: 'success', text: `Humanized ${nextSelectedIds.length} marker${nextSelectedIds.length === 1 ? '' : 's'}.` })
      }
    }
    catch (error) {
      setFeedback({ tone: 'error', text: `apply: ${unknownError(error)}` })
    }
    finally {
      setBusy(null)
    }
  }

  const applyNoteBlockComposer = async () => {
    if (selectedMarkerIds.length === 0 || busy) return
    setBusy('run:composer')
    setFeedback(null)
    try {
      const preset = await registry.executeCommand(
        noteBlockComposerExtension.manifest.id,
        noteBlockPresetCommand,
        { preset: notePreset, pattern: notePattern },
      )
      if (!preset.ok) {
        setFeedback({ tone: 'error', text: resultError(preset) })
        return
      }
      const result = await registry.executeMarkerTransform(
        noteBlockComposerExtension.manifest.id,
        noteBlockComposerTransform,
        {
          ...preset.value,
          stepTicks: notePattern === 'arpeggio' ? arpeggioStep : 0,
          volumeScale: noteVolumeScale,
          laneSpread: noteLaneSpread,
        },
        { project, markerIds: selectedMarkerIds },
      )
      if (!result.ok) setFeedback({ tone: 'error', text: resultError(result) })
      else {
        const nextSelectedIds = transformedSelection(project, result.value, selectedMarkerIds)
        await onApply(result.value, nextSelectedIds)
        setFeedback({
          tone: 'success',
          text: `Created ${nextSelectedIds.length} ${notePattern === 'chord' ? 'chord voices' : 'arpeggio notes'}.`,
        })
      }
    }
    catch (error) {
      setFeedback({ tone: 'error', text: `apply: ${unknownError(error)}` })
    }
    finally {
      setBusy(null)
    }
  }

  const noSelection = selectedMarkerIds.length === 0

  return (
    <Box
      position="fixed" inset="0" zIndex="2140" bg="var(--knead-scrim)"
      display="flex" alignItems="center" justifyContent="center"
      onPointerDown={(event) => { if (event.target === event.currentTarget && !operationBusy) onClose() }}
    >
      <Box
        w="760px" maxW="calc(100vw - 32px)" maxH="92vh" overflowY="auto"
        bg="var(--studio-panel)" borderRadius="lg" boxShadow="xl" p="5"
        ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Studio extensions"
      >
        <Flex align="start" gap="3">
          <Box>
            <Text fontSize="xl" fontWeight="bold">Studio Extensions</Text>
            <Text fontSize="sm" color="var(--studio-muted)">
              Built-in tools plus permission-reviewed, code-free declarative packages on Studio extension API v1.
            </Text>
          </Box>
          <Box flex="1" />
          <Box textAlign="right">
            <Text fontSize="xs" color={noSelection ? 'var(--studio-warning)' : 'var(--studio-accent-text)'}>
              {selectedMarkerIds.length}
              {' '}
              marker
              {selectedMarkerIds.length === 1 ? '' : 's'}
              {' '}
              selected
            </Text>
            <StudioDialogClose onClick={onClose} disabled={operationBusy} aria-label="Close extensions" />
          </Box>
        </Flex>

        {noSelection && (
          <Box mt="4" p="3" borderRadius="md" bg="var(--studio-warning-soft)" border="1px solid" borderColor="var(--studio-warning)">
            <Text fontSize="sm">Select one or more timeline markers to run a transform.</Text>
          </Box>
        )}

        <Box mt="4" p="4" bg="var(--studio-frame)" borderRadius="lg" border="1px solid" borderColor="var(--studio-line)">
          <Flex align="center" gap="3" wrap="wrap">
            <Box flex="1" minW="250px">
              <Text fontWeight="bold">Humanize</Text>
              <Text fontSize="xs" color="var(--studio-muted)">Deterministic timing, volume, pitch, and lane variation.</Text>
            </Box>
            <Text fontSize="xs" color={statusColor(humanizeInfo)} data-extension-status="knead.humanize">
              {humanizeInfo?.status ?? 'inactive'}
            </Text>
            <Button
              size="sm" variant="outline"
              onClick={() => toggleExtension(humanizeExtension.manifest.id)}
              loading={busy === `toggle:${humanizeExtension.manifest.id}`}
              disabled={operationBusy && busy !== `toggle:${humanizeExtension.manifest.id}`}
            >
              {humanizeInfo?.status === 'active' ? 'Disable Humanize' : 'Enable Humanize'}
            </Button>
          </Flex>

          <Flex mt="4" gap="3" wrap="wrap" align="end" opacity={humanizeInfo?.status === 'active' ? 1 : 0.55}>
            <Box>
              <Text fontSize="xs" mb="1">Timing ± ticks</Text>
              <CommitNumberInput
                aria-label="Humanize timing jitter" w="115px" value={humanizeOptions.timingJitterTicks}
                min={0} max={20} step={1} precision={0}
                onCommit={timingJitterTicks => setHumanizeOptions(current => ({ ...current, timingJitterTicks }))}
              />
            </Box>
            <Box>
              <Text fontSize="xs" mb="1">Volume ±</Text>
              <CommitNumberInput
                aria-label="Humanize volume jitter" w="105px" value={humanizeOptions.volumeJitter}
                min={0} max={1} step={0.01} precision={2}
                onCommit={volumeJitter => setHumanizeOptions(current => ({ ...current, volumeJitter }))}
              />
            </Box>
            <Box>
              <Text fontSize="xs" mb="1">Pitch ± cents</Text>
              <CommitNumberInput
                aria-label="Humanize pitch jitter" w="115px" value={humanizeOptions.pitchJitterCents}
                min={0} max={1200} step={1} precision={0}
                onCommit={pitchJitterCents => setHumanizeOptions(current => ({ ...current, pitchJitterCents }))}
              />
            </Box>
            <Box>
              <Text fontSize="xs" mb="1">Lane ±</Text>
              <CommitNumberInput
                aria-label="Humanize lane jitter" w="105px" value={humanizeOptions.laneJitter}
                min={0} max={1} step={0.01} precision={2}
                onCommit={laneJitter => setHumanizeOptions(current => ({ ...current, laneJitter }))}
              />
            </Box>
            <Box>
              <Text fontSize="xs" mb="1">Seed</Text>
              <CommitNumberInput
                aria-label="Humanize seed" w="120px" value={humanizeOptions.seed}
                min={0} max={0xffff_ffff} step={1} precision={0}
                onCommit={seed => setHumanizeOptions(current => ({ ...current, seed }))}
              />
            </Box>
            <Button
              colorScheme="primary" ml="auto" onClick={applyHumanize}
              loading={busy === 'run:humanize'}
              disabled={noSelection || humanizeInfo?.status !== 'active' || operationBusy}
            >
              Apply Humanize
            </Button>
          </Flex>
        </Box>

        <Box mt="4" p="4" bg="var(--studio-frame)" borderRadius="lg" border="1px solid" borderColor="var(--studio-line)">
          <Flex align="center" gap="3" wrap="wrap">
            <Box flex="1" minW="250px">
              <Text fontWeight="bold">Note Block Composer</Text>
              <Text fontSize="xs" color="var(--studio-muted)">Turn each selected marker into a pitch-safe chord or arpeggio.</Text>
            </Box>
            <Text fontSize="xs" color={statusColor(composerInfo)} data-extension-status="knead.note-block-composer">
              {composerInfo?.status ?? 'inactive'}
            </Text>
            <Button
              size="sm" variant="outline"
              onClick={() => toggleExtension(noteBlockComposerExtension.manifest.id)}
              loading={busy === `toggle:${noteBlockComposerExtension.manifest.id}`}
              disabled={operationBusy && busy !== `toggle:${noteBlockComposerExtension.manifest.id}`}
            >
              {composerInfo?.status === 'active' ? 'Disable Composer' : 'Enable Composer'}
            </Button>
          </Flex>

          <Flex mt="4" gap="3" wrap="wrap" align="end" opacity={composerInfo?.status === 'active' ? 1 : 0.55}>
            <Box minW="220px" flex="1">
              <Text fontSize="xs" mb="1">Preset</Text>
              <Select.Root
                aria-label="Note block preset" value={notePreset}
                items={NOTE_BLOCK_PRESETS}
                onChange={value => setNotePreset(value as NoteBlockPreset)}
              />
            </Box>
            <Box minW="145px">
              <Text fontSize="xs" mb="1">Pattern</Text>
              <Select.Root
                aria-label="Note block pattern" value={notePattern}
                items={[{ label: 'Chord', value: 'chord' }, { label: 'Arpeggio', value: 'arpeggio' }]}
                onChange={value => setNotePattern(value as NoteBlockPattern)}
              />
            </Box>
            <Box>
              <Text fontSize="xs" mb="1">Step ticks</Text>
              <CommitNumberInput
                aria-label="Arpeggio step ticks" w="100px" value={arpeggioStep}
                min={1} max={100} step={1} precision={0} disabled={notePattern !== 'arpeggio'}
                onCommit={setArpeggioStep}
              />
            </Box>
            <Box>
              <Text fontSize="xs" mb="1">Volume</Text>
              <CommitNumberInput
                aria-label="Note block volume scale" w="100px" value={noteVolumeScale}
                min={0} max={1} step={0.05} precision={2}
                onCommit={setNoteVolumeScale}
              />
            </Box>
            <Box>
              <Text fontSize="xs" mb="1">Lane spread</Text>
              <CommitNumberInput
                aria-label="Note block lane spread" w="105px" value={noteLaneSpread}
                min={0} max={0.5} step={0.01} precision={2}
                onCommit={setNoteLaneSpread}
              />
            </Box>
            <Button
              colorScheme="primary" ml="auto" onClick={applyNoteBlockComposer}
              loading={busy === 'run:composer'}
              disabled={noSelection || composerInfo?.status !== 'active' || operationBusy}
            >
              Create Notes
            </Button>
          </Flex>
        </Box>

        <DeclarativeExtensionPackagesPanel
          registry={registry}
          project={project}
          selectedMarkerIds={selectedMarkerIds}
          onApply={onApply}
          onRegistryChanged={refreshExtensions}
          onFeedback={setFeedback}
          onBusyChange={setPackagesBusy}
        />

        {feedback && (
          <Box
            mt="4" p="3" borderRadius="md" border="1px solid"
            bg={feedback.tone === 'error' ? 'var(--studio-error-soft)' : feedback.tone === 'success' ? 'var(--studio-success-soft)' : 'var(--studio-accent-soft)'}
            borderColor={feedback.tone === 'error' ? 'var(--studio-error)' : feedback.tone === 'success' ? 'var(--studio-success)' : 'var(--knead-accent-line)'}
            role={feedback.tone === 'error' ? 'alert' : 'status'}
          >
            <Text fontSize="sm">{feedback.text}</Text>
          </Box>
        )}

        <Flex mt="5" justify="flex-end">
          <Button onClick={onClose} disabled={operationBusy}>Close</Button>
        </Flex>
      </Box>
    </Box>
  )
}
