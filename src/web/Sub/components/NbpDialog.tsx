import React, { useEffect, useState } from 'react'
import { Box, Button, Flex, Select, Text } from '@yamada-ui/react'
import { useTranslation } from 'react-i18next'
import { StudioDialogClose } from './StudioDialogClose'
import { CommitNumberInput } from '../../components/CommitNumberInput'
import type { TimelineState } from '../types/timeline'
import {
  insertNbpPattern,
  nbpToTimelineState,
  parseNbp,
  timelineSelectionToNbp,
  type NbpVersion,
} from '../utils/nbp'
import { useModalDialog } from '../hooks/useModalDialog'

interface Props {
  open: boolean
  project: TimelineState
  selectedIds: ReadonlySet<string> | readonly string[]
  defaultName: string
  currentTick: number
  targetVersion: string
  onInsert: (
    state: TimelineState,
    selectedIds: readonly string[],
    warnings: readonly string[],
  ) => void | Promise<void>
  onReplace: (
    state: TimelineState,
    warnings: readonly string[],
    sourcePath: string,
  ) => boolean | Promise<boolean>
  onClose: () => void
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function encodeBase64(bytes: Uint8Array): string {
  const chunks: string[] = []
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + chunkSize)))
  }
  return btoa(chunks.join(''))
}

export const NbpDialog: React.FC<Props> = ({
  open,
  project,
  selectedIds,
  defaultName,
  currentTick,
  targetVersion,
  onInsert,
  onReplace,
  onClose,
}) => {
  const { t } = useTranslation()
  const [mode, setMode] = useState<'insert' | 'replace'>('insert')
  const [startTick, setStartTick] = useState(Math.max(0, Math.round(currentTick)))
  const [startTrack, setStartTrack] = useState('append')
  const [version, setVersion] = useState<NbpVersion>(2)
  const [busy, setBusy] = useState(false)
  const [confirmingReplace, setConfirmingReplace] = useState(false)
  const [message, setMessage] = useState('')
  const [warnings, setWarnings] = useState<string[]>([])
  const selectionCount = 'size' in selectedIds ? selectedIds.size : selectedIds.length
  const { dialogRef } = useModalDialog({ open: open && !confirmingReplace, busy, onClose })

  useEffect(() => {
    if (!open) return
    setStartTick(Math.max(0, Math.round(currentTick)))
    setMessage('')
    setWarnings([])
  }, [currentTick, open])

  if (!open || confirmingReplace) return null

  const importPattern = async () => {
    setBusy(true)
    setMessage('')
    setWarnings([])
    try {
      const opened = await window.myAPI.nbp.open()
      if (!opened.ok) {
        if (!('canceled' in opened)) setMessage(t('studio.nbp_error', { error: opened.error }))
        return
      }
      const parsed = parseNbp(decodeBase64(opened.dataBase64))
      if (!parsed.ok) {
        setMessage(t('studio.nbp_error', { error: parsed.error }))
        return
      }
      if (mode === 'replace') {
        const converted = nbpToTimelineState(parsed.pattern, targetVersion)
        const allWarnings = [...parsed.warnings, ...converted.warnings]
        setConfirmingReplace(true)
        let accepted = false
        try {
          accepted = await onReplace(converted.state, allWarnings, opened.path)
        }
        finally {
          setConfirmingReplace(false)
        }
        if (accepted) {
          setWarnings(allWarnings)
          setMessage(t('studio.nbp_imported_project', { version: parsed.pattern.version }))
          onClose()
        }
        return
      }
      const trackIndex = startTrack === 'append' ? project.tracks.length : Number(startTrack)
      const inserted = insertNbpPattern(project, parsed.pattern, { startTick, startTrackIndex: trackIndex })
      const allWarnings = [...parsed.warnings, ...inserted.warnings]
      await onInsert(inserted.state, inserted.insertedMarkerIds, allWarnings)
      setWarnings(allWarnings)
      setMessage(t('studio.nbp_inserted', {
        count: inserted.insertedMarkerIds.length,
        version: parsed.pattern.version,
      }))
    }
    catch (error) {
      setMessage(t('studio.nbp_error', { error: error instanceof Error ? error.message : String(error) }))
    }
    finally {
      setBusy(false)
    }
  }

  const exportPattern = async () => {
    setBusy(true)
    setMessage('')
    setWarnings([])
    try {
      const exported = timelineSelectionToNbp(project, selectedIds, version)
      const saved = await window.myAPI.nbp.save(`${defaultName}.nbp`, encodeBase64(exported.data))
      setWarnings(exported.warnings)
      if (!saved.ok) {
        if (!('canceled' in saved)) setMessage(t('studio.nbp_error', { error: saved.error }))
        return
      }
      setMessage(t('studio.nbp_exported', { version, path: saved.path }))
    }
    catch (error) {
      setMessage(t('studio.nbp_error', { error: error instanceof Error ? error.message : String(error) }))
    }
    finally {
      setBusy(false)
    }
  }

  return (
    <Box
      position="fixed" inset="0" zIndex="2130" bg="var(--knead-scrim)"
      display="flex" alignItems="center" justifyContent="center"
      onPointerDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}
    >
      <Box
        ref={dialogRef} role="dialog" aria-modal="true" aria-label={t('studio.nbp_title')} tabIndex={-1}
        w="640px" maxW="calc(100vw - 32px)" bg="var(--studio-panel)" borderRadius="lg" boxShadow="xl" p="5"
      >
        <Flex align="start" gap="3">
          <Box>
            <Text fontSize="xl" fontWeight="bold">{t('studio.nbp_title')}</Text>
            <Text fontSize="sm" color="var(--studio-muted)">
              {t('studio.nbp_description')}
            </Text>
          </Box>
          <Box flex="1" />
          <StudioDialogClose onClick={onClose} disabled={busy} />
        </Flex>

        <Flex mt="5" gap="3" align="stretch">
          <Box flex="1" p="4" bg="var(--studio-frame)" borderRadius="md">
            <Text fontWeight="bold">{t('studio.nbp_import')}</Text>
            <Select.Root
              data-dialog-initial-focus
              rootProps={{ mt: '3' }}
              value={mode}
              items={[
                { label: t('studio.nbp_mode_insert'), value: 'insert' },
                { label: t('studio.nbp_mode_replace'), value: 'replace' },
              ]}
              onChange={value => setMode(value as typeof mode)}
            />
            {mode === 'insert' && (
              <Flex mt="3" direction="column" gap="2">
                <Flex align="center" gap="2">
                  <Text minW="82px" fontSize="xs">{t('studio.nbp_start_tick')}</Text>
                  <CommitNumberInput
                    value={startTick} min={0} max={Number.MAX_SAFE_INTEGER} step={1} precision={0}
                    onCommit={value => setStartTick(Math.max(0, Math.round(value)))} size="sm"
                  />
                </Flex>
                <Flex align="center" gap="2">
                  <Text minW="82px" fontSize="xs">{t('studio.nbp_first_track')}</Text>
                  <Select.Root
                    value={startTrack}
                    items={[
                      { label: t('studio.nbp_append_tracks'), value: 'append' },
                      ...project.tracks.map((track, index) => ({ label: `${index + 1}. ${track.name}`, value: String(index) })),
                    ]}
                    onChange={setStartTrack}
                  />
                </Flex>
              </Flex>
            )}
            <Button mt="3" w="full" colorScheme="primary" onClick={importPattern} loading={busy}>
              {t('studio.nbp_choose_file')}
            </Button>
          </Box>

          <Box flex="1" p="4" bg="var(--studio-frame)" borderRadius="md">
            <Text fontWeight="bold">{t('studio.nbp_export_selection')}</Text>
            <Text mt="2" fontSize="xs" color="var(--studio-muted)">
              {t('studio.nbp_selected_hint', { count: selectionCount })}
            </Text>
            <Select.Root
              rootProps={{ mt: '3' }}
              value={String(version)}
              items={[
                { label: t('studio.nbp_v2'), value: '2' },
                { label: t('studio.nbp_v1'), value: '1' },
              ]}
              onChange={value => setVersion(Number(value) as NbpVersion)}
            />
            <Button
              mt="3" w="full" colorScheme="primary" onClick={exportPattern}
              loading={busy} disabled={!selectionCount}
            >
              {t('studio.nbp_save_selection')}
            </Button>
          </Box>
        </Flex>

        {warnings.length > 0 && (
          <Box mt="4" p="3" bg="var(--studio-warning-soft)" borderRadius="md">
            {warnings.map(warning => (
              <Text key={warning} fontSize="xs">
                •
                {' '}
                {warning}
              </Text>
            ))}
          </Box>
        )}
        {message && (
          <Text mt="4" fontSize="sm" color={message.startsWith('Error:') || message.startsWith('エラー:') ? 'var(--studio-error)' : 'var(--studio-success)'}>{message}</Text>
        )}
        <Flex mt="5" justify="flex-end">
          <Button onClick={onClose} disabled={busy}>{t('studio.close')}</Button>
        </Flex>
      </Box>
    </Box>
  )
}
