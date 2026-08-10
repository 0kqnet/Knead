import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Button, Flex, Input, Select, Text } from '@yamada-ui/react'
import { useTranslation } from 'react-i18next'
import type { TimelineState } from '../types/timeline'
import {
  DEFAULT_NOTE_BLOCK_BUILD_OPTIONS,
  defaultNoteBlockBuildFormat,
  validateNoteBlockBuildTarget,
  type NoteBlockBuildCircuit,
  type NoteBlockBuildFormat,
  type NoteBlockBuildLayout,
} from '../utils/noteBlockBuild'
import { useStudioExportTask } from '../tasks/studioExportTask'
import { isTaskAbortError } from '../tasks/cancellableWorkerTask'
import { useModalDialog } from '../hooks/useModalDialog'

export interface NoteBlockBuildDialogProps {
  open: boolean
  project: TimelineState
  defaultName: string
  onClose: () => void
}

function encodeBase64(bytes: Uint8Array): string {
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)))
  }
  return btoa(chunks.join(''))
}

function safeBaseName(value: string): string {
  const withoutExtension = value.replace(/\.(?:nbt|schematic|litematic)$/i, '')
  const fileName = withoutExtension
    .replace(/[\\/:*?"<>|]/g, '_')
    .split('')
    .map(character => character.charCodeAt(0) < 0x20 ? '_' : character)
    .join('')
  return fileName.trim() || 'knead-note-block-build'
}

export const NoteBlockBuildDialog: React.FC<NoteBlockBuildDialogProps> = ({
  open,
  project,
  defaultName,
  onClose,
}) => {
  const { t } = useTranslation()
  const [format, setFormat] = useState<NoteBlockBuildFormat>(() => defaultNoteBlockBuildFormat(project.targetVersion))
  const [layout, setLayout] = useState<NoteBlockBuildLayout>(DEFAULT_NOTE_BLOCK_BUILD_OPTIONS.layout)
  const [circuit, setCircuit] = useState<NoteBlockBuildCircuit>(DEFAULT_NOTE_BLOCK_BUILD_OPTIONS.circuit)
  const [includeLockedTracks, setIncludeLockedTracks] = useState(false)
  const [notesPerRow, setNotesPerRow] = useState(DEFAULT_NOTE_BLOCK_BUILD_OPTIONS.notesPerRow)
  const [saving, setSaving] = useState(false)
  const [warnings, setWarnings] = useState<string[]>([])
  const [message, setMessage] = useState('')
  const [isError, setIsError] = useState(false)
  const [summary, setSummary] = useState('')
  const [timingSummary, setTimingSummary] = useState('')
  const {
    state: generation,
    run: runGeneration,
    cancel: cancelGeneration,
    reset: resetGeneration,
  } = useStudioExportTask('note-block-build')
  const generating = generation.status === 'running'
  const busy = generating || saving
  const latestProjectRef = useRef(project)
  latestProjectRef.current = project
  const { dialogRef } = useModalDialog({ open, busy, onClose })

  useEffect(() => {
    if (!open) return
    setFormat(defaultNoteBlockBuildFormat(project.targetVersion))
    setCircuit(DEFAULT_NOTE_BLOCK_BUILD_OPTIONS.circuit)
    setLayout(DEFAULT_NOTE_BLOCK_BUILD_OPTIONS.layout)
    setNotesPerRow(DEFAULT_NOTE_BLOCK_BUILD_OPTIONS.notesPerRow)
    setWarnings([])
    setMessage('')
    setSummary('')
    setTimingSummary('')
    setIsError(false)
    resetGeneration()
  }, [open, project.targetVersion, resetGeneration])

  useEffect(() => {
    if (circuit !== 'playable-redstone') return
    if (format !== 'structure-block-nbt' && format !== 'litematica-compatible-nbt') {
      setFormat('litematica-compatible-nbt')
    }
    if (layout !== 'fixed-tracks') setLayout('fixed-tracks')
    if (format === 'structure-block-nbt' && notesPerRow > 14) setNotesPerRow(14)
  }, [circuit, format, layout, notesPerRow])

  useEffect(() => {
    // A document replacement invalidates a running structured-clone snapshot.
    cancelGeneration()
  }, [cancelGeneration, project])

  const targetError = useMemo(
    () => validateNoteBlockBuildTarget(format, project.targetVersion),
    [format, project.targetVersion],
  )

  if (!open) return null

  const save = async () => {
    const ownedProject = project
    setWarnings([])
    setMessage('')
    setSummary('')
    setTimingSummary('')
    setIsError(false)
    try {
      const exported = await runGeneration({
        project: ownedProject,
        options: {
          format,
          layout,
          circuit,
          includeLockedTracks,
          notesPerRow,
        },
      })
      if (latestProjectRef.current !== ownedProject) return
      setWarnings(exported.warnings)
      setSummary(t('studio.note_block_build_summary', {
        defaultValue: '{{notes}} note blocks, {{blocks}} blocks · {{x}}×{{y}}×{{z}}',
        notes: exported.noteBlockCount,
        blocks: exported.blockCount,
        x: exported.dimensions.x,
        y: exported.dimensions.y,
        z: exported.dimensions.z,
      }))
      if (exported.timing) {
        setTimingSummary(t('studio.note_block_build_timing_summary', {
          defaultValue: '{{quantum}}-tick grid · {{nodes}} delay nodes · {{quantized}} quantized · {{collapsed}} collapsed',
          quantum: exported.timing.quantumTicks,
          nodes: exported.timing.delayNodeCount,
          quantized: exported.timing.quantizedNoteCount,
          collapsed: exported.timing.collapsedRetriggerCount,
        }))
      }
      setSaving(true)
      const saved = await window.myAPI.noteBlockBuild.save(
        `${safeBaseName(defaultName)}${exported.extension}`,
        exported.format,
        encodeBase64(exported.data),
      )
      if (!saved.ok) {
        if (!('canceled' in saved)) {
          setIsError(true)
          setMessage(t('studio.note_block_build_error', {
            defaultValue: 'Export failed: {{error}}',
            error: saved.error,
          }))
        }
        return
      }
      setMessage(t('studio.note_block_build_saved', {
        defaultValue: 'Saved: {{path}}',
        path: saved.path,
      }))
    }
    catch (error) {
      if (isTaskAbortError(error)) return
      setIsError(true)
      setMessage(t('studio.note_block_build_error', {
        defaultValue: 'Export failed: {{error}}',
        error: error instanceof Error ? error.message : String(error),
      }))
    }
    finally {
      setSaving(false)
    }
  }

  const formatItems = [
    {
      value: 'structure-block-nbt',
      label: t('studio.note_block_build_format_structure', {
        defaultValue: 'Structure Block .nbt (size header capped at 32)',
      }),
    },
    {
      value: 'litematica-compatible-nbt',
      label: t('studio.note_block_build_format_exact', {
        defaultValue: 'Litematica-compatible exact-size Structure .nbt',
      }),
    },
    {
      value: 'schematic-1.11-1.12',
      label: t('studio.note_block_build_format_111', { defaultValue: 'Legacy .schematic (1.11–1.12)' }),
    },
    {
      value: 'schematic-pre-1.11',
      label: t('studio.note_block_build_format_pre111', { defaultValue: 'Legacy .schematic (pre-1.11)' }),
    },
  ]
  const visibleFormatItems = circuit === 'playable-redstone'
    ? formatItems.slice(0, 2)
    : formatItems

  return (
    <Box
      position="fixed" inset="0" zIndex="2140" bg="rgba(0,0,0,.75)"
      display="flex" alignItems="center" justifyContent="center"
      onPointerDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}
    >
      <Box
        ref={dialogRef} role="dialog" aria-modal="true" tabIndex={-1}
        aria-label={t('studio.note_block_build_title', { defaultValue: 'Minecraft note-block build export' })}
        w="680px" maxW="calc(100vw - 32px)" maxH="92vh" overflowY="auto"
        bg="gray.800" borderRadius="lg" boxShadow="xl" p="5"
      >
        <Flex align="start" gap="3">
          <Box>
            <Text fontSize="xl" fontWeight="bold">
              {t('studio.note_block_build_title', { defaultValue: 'Minecraft note-block build export' })}
            </Text>
            <Text fontSize="sm" color="gray.400">
              {t('studio.note_block_build_description', {
                defaultValue: 'Export OpenNBS-compatible Structure or legacy schematic files.',
              })}
            </Text>
          </Box>
          <Box flex="1" />
          <Button size="sm" aria-label={t('studio.close', { defaultValue: 'Close' })} onClick={onClose} isDisabled={busy}>×</Button>
        </Flex>

        <Box mt="5">
          <Text fontSize="xs" mb="1">
            {t('studio.note_block_build_circuit', { defaultValue: 'Build mode' })}
          </Text>
          <Flex gap="2" wrap="wrap">
            <Button
              data-dialog-initial-focus
              size="sm"
              aria-pressed={circuit === 'display'}
              colorScheme={circuit === 'display' ? 'orange' : 'gray'}
              isDisabled={busy}
              onClick={() => setCircuit('display')}
            >
              {t('studio.note_block_build_circuit_display', { defaultValue: 'Static placement' })}
            </Button>
            <Button
              size="sm"
              aria-pressed={circuit === 'playable-redstone'}
              colorScheme={circuit === 'playable-redstone' ? 'red' : 'gray'}
              isDisabled={busy}
              onClick={() => setCircuit('playable-redstone')}
            >
              {t('studio.note_block_build_circuit_playable', { defaultValue: 'Playable redstone' })}
            </Button>
          </Flex>
        </Box>

        <Box mt="4">
          <Text fontSize="xs" mb="1">{t('studio.note_block_build_format', { defaultValue: 'Format' })}</Text>
          <Select
            aria-label={t('studio.note_block_build_format', { defaultValue: 'Format' })}
            value={format} items={visibleFormatItems}
            isDisabled={busy}
            onChange={(value) => {
              const next = value as NoteBlockBuildFormat
              setFormat(next)
              if (circuit === 'playable-redstone' && next === 'structure-block-nbt') {
                setNotesPerRow(current => Math.min(current, 14))
              }
            }}
          />
          {format === 'litematica-compatible-nbt' && (
            <Text mt="2" fontSize="xs" color="orange.300">
              {t('studio.note_block_build_exact_warning', {
                defaultValue: 'This writes an exact-size vanilla Structure .nbt for Litematica import. It is not a native .litematic file.',
              })}
            </Text>
          )}
        </Box>

        <Flex mt="4" gap="3" align="end" wrap="wrap">
          <Box flex="1" minW="230px">
            <Text fontSize="xs" mb="1">{t('studio.note_block_build_layout', { defaultValue: 'Layout' })}</Text>
            <Select
              aria-label={t('studio.note_block_build_layout', { defaultValue: 'Layout' })}
              value={layout}
              isDisabled={busy}
              items={[
                { value: 'fixed-tracks', label: t('studio.note_block_build_layout_fixed', { defaultValue: 'Fixed track lanes' }) },
                ...(circuit === 'display'
                  ? [{ value: 'schematic-grid', label: t('studio.note_block_build_layout_grid', { defaultValue: 'Wrapped schematic grid' }) }]
                  : []),
              ]}
              onChange={value => setLayout(value as NoteBlockBuildLayout)}
            />
          </Box>
          {(layout === 'schematic-grid' || circuit === 'playable-redstone') && (
            <Box w="150px">
              <Text fontSize="xs" mb="1">
                {circuit === 'playable-redstone'
                  ? t('studio.note_block_build_row_nodes', { defaultValue: 'Delay nodes per row' })
                  : t('studio.note_block_build_row_ticks', { defaultValue: 'Ticks per row' })}
              </Text>
              <Input
                aria-label={circuit === 'playable-redstone'
                  ? t('studio.note_block_build_row_nodes', { defaultValue: 'Delay nodes per row' })
                  : t('studio.note_block_build_row_ticks', { defaultValue: 'Ticks per row' })}
                type="number" min={5} max={circuit === 'playable-redstone' && format === 'structure-block-nbt' ? 14 : 100}
                step={1} value={notesPerRow}
                isDisabled={busy}
                onChange={event => setNotesPerRow(Number(event.target.value))}
              />
            </Box>
          )}
        </Flex>

        <Flex mt="4" align="center" gap="3" wrap="wrap">
          <Button
            size="sm" aria-pressed={includeLockedTracks}
            colorScheme={includeLockedTracks ? 'orange' : 'gray'}
            isDisabled={busy}
            onClick={() => setIncludeLockedTracks(value => !value)}
          >
            {t('studio.note_block_build_include_locked', { defaultValue: 'Include locked tracks' })}
          </Button>
          <Text fontSize="xs" color="gray.400">
            {t('studio.note_block_build_target', {
              defaultValue: 'Target: {{version}}',
              version: project.targetVersion || t('studio.unknown', { defaultValue: 'unknown' }),
            })}
          </Text>
        </Flex>

        <Text mt="3" p="3" borderRadius="md" bg={circuit === 'playable-redstone' ? 'red.900' : 'orange.900'} color={circuit === 'playable-redstone' ? 'red.100' : 'orange.100'} fontSize="sm">
          {circuit === 'playable-redstone'
            ? t('studio.note_block_build_playable_warning', {
                defaultValue: 'Playable redstone uses OpenNBS-style repeaters on a reliable 2-game-tick grid. It plays one pass; loops and Sound Stopper actions are not physical circuitry.',
              })
            : t('studio.note_block_build_static_warning', {
                defaultValue: 'Static placement only: this exporter preserves note blocks and substrates, but does not generate OpenNBS repeater, redstone, control, or transmission circuitry.',
              })}
        </Text>

        {targetError && (
          <Text mt="3" p="3" borderRadius="md" bg="red.900" color="red.200" fontSize="sm">
            {targetError}
          </Text>
        )}
        {summary && <Text mt="4" fontSize="sm" fontWeight="bold">{summary}</Text>}
        {timingSummary && <Text mt="1" fontSize="xs" color="red.200">{timingSummary}</Text>}
        {warnings.length > 0 && (
          <Box mt="3" p="3" bg="orange.900" borderRadius="md" aria-label={t('studio.warnings', { defaultValue: 'Warnings' })}>
            {warnings.map((warning, index) => (
              <Text key={`${index}-${warning}`} fontSize="xs">
                •
                {' '}
                {warning}
              </Text>
            ))}
          </Box>
        )}
        {generating && (
          <Box
            mt="3" p="3" borderRadius="md" bg="blue.900"
            aria-label={t('studio.export_generation_status', { defaultValue: 'Export generation status' })}
          >
            <Flex align="center" gap="3">
              <Box flex="1">
                <Text fontSize="sm">
                  {t(`studio.export_stage_${generation.stage ?? 'preparing'}`, {
                    defaultValue: generation.stage ?? 'preparing',
                  })}
                </Text>
                <Box
                  mt="2" h="7px" overflow="hidden" borderRadius="full" bg="gray.700"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(generation.progress * 100)}
                  aria-label={t('studio.export_generation_progress', { defaultValue: 'Generating export' })}
                >
                  <Box h="100%" w={`${Math.round(generation.progress * 100)}%`} bg="blue.300" />
                </Box>
              </Box>
              <Text fontSize="xs">
                {Math.round(generation.progress * 100)}
                %
              </Text>
            </Flex>
          </Box>
        )}
        {generation.status === 'canceled' && (
          <Text mt="3" fontSize="sm" color="gray.300">
            {t('studio.export_generation_canceled', { defaultValue: 'Generation canceled.' })}
          </Text>
        )}
        {message && <Text mt="3" fontSize="sm" color={isError ? 'red.300' : 'green.300'}>{message}</Text>}

        <Flex mt="5" justify="flex-end" gap="2">
          <Button onClick={onClose} isDisabled={busy}>{t('studio.close', { defaultValue: 'Close' })}</Button>
          {generating
            ? (
                <Button colorScheme="orange" onClick={cancelGeneration}>
                  {t('studio.cancel_generation', { defaultValue: 'Cancel generation' })}
                </Button>
              )
            : (
                <Button
                  colorScheme="green" onClick={save} isLoading={saving}
                  isDisabled={Boolean(targetError) || saving}
                >
                  {t('studio.note_block_build_save', { defaultValue: 'Export build' })}
                </Button>
              )}
        </Flex>
      </Box>
    </Box>
  )
}
