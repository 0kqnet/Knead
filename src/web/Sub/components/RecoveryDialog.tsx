import React, { useCallback, useEffect, useState } from 'react'
import { Box, Button, Flex, Text } from '@yamada-ui/react'
import { useTranslation } from 'react-i18next'
import { StudioDialogClose } from './StudioDialogClose'
import type { TimelineRecoveryApi, TimelineRecoveryMetadata } from '../types/recovery'
import type { TimelineState } from '../types/timeline'
import {
  getTimelineRecoveryDisplayName,
  parseTimelineRecoveryProject,
} from '../utils/timelineRecovery'

export interface RecoveryDialogProps {
  open: boolean
  onClose: () => void
  onRestore: (
    state: TimelineState,
    snapshot: TimelineRecoveryMetadata,
    warnings: string[],
  ) => boolean | Promise<boolean>
  api?: TimelineRecoveryApi
}

function formatBytes(byteLength: number): string {
  if (byteLength < 1024) return `${byteLength} B`
  if (byteLength < 1024 * 1024) return `${(byteLength / 1024).toFixed(1)} KiB`
  return `${(byteLength / (1024 * 1024)).toFixed(1)} MiB`
}

export const RecoveryDialog: React.FC<RecoveryDialogProps> = ({
  open,
  onClose,
  onRestore,
  api = window.myAPI.timelineRecovery,
}) => {
  const { t, i18n } = useTranslation()
  const [snapshots, setSnapshots] = useState<TimelineRecoveryMetadata[]>([])
  const [loading, setLoading] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [confirmingRestore, setConfirmingRestore] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await api.list()
      if (!result.ok) {
        setSnapshots([])
        setError(result.error)
        return
      }
      setSnapshots(result.snapshots)
    }
    catch (caught) {
      setSnapshots([])
      setError(String(caught))
    }
    finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    if (open) void load()
  }, [load, open])

  if (!open || confirmingRestore) return null

  const restore = async (snapshot: TimelineRecoveryMetadata) => {
    setBusyId(snapshot.id)
    setError('')
    try {
      const result = await api.restore(snapshot.id)
      if (!result.ok) {
        setError(result.error)
        return
      }
      const parsed = parseTimelineRecoveryProject(result.json)
      if (!parsed.ok || parsed.state.projectId !== result.snapshot.projectId) {
        setError(parsed.ok ? t('studio.recovery_mismatch') : parsed.error)
        return
      }
      setConfirmingRestore(true)
      const accepted = await onRestore(parsed.state, result.snapshot, parsed.warnings)
      setConfirmingRestore(false)
      if (accepted) onClose()
    }
    catch (caught) {
      setConfirmingRestore(false)
      setError(String(caught))
    }
    finally {
      setBusyId(null)
    }
  }

  const discard = async (snapshot: TimelineRecoveryMetadata) => {
    setBusyId(snapshot.id)
    setError('')
    try {
      const result = await api.discard(snapshot.id)
      if (!result.ok) {
        setError(result.error)
        return
      }
      setSnapshots(current => current.filter(item => item.id !== snapshot.id))
    }
    catch (caught) {
      setError(String(caught))
    }
    finally {
      setBusyId(null)
    }
  }

  return (
    <Box
      position="fixed" inset="0" zIndex="2140" bg="var(--knead-scrim)"
      display="flex" alignItems="center" justifyContent="center"
      role="dialog" aria-modal="true" aria-label={t('studio.recovery_title')}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !busyId) onClose()
      }}
    >
      <Box
        w="680px" maxW="calc(100vw - 32px)" maxH="calc(100vh - 40px)" overflowY="auto"
        bg="var(--studio-panel)" borderRadius="lg" boxShadow="xl" p="5"
      >
        <Flex align="start" gap="3">
          <Box>
            <Text fontSize="xl" fontWeight="bold">{t('studio.recovery_title')}</Text>
            <Text mt="1" fontSize="sm" color="var(--studio-muted)">{t('studio.recovery_description')}</Text>
          </Box>
          <Box flex="1" />
          <StudioDialogClose onClick={onClose} disabled={!!busyId} />
        </Flex>

        {loading && <Text mt="5" color="var(--studio-muted)">{t('studio.recovery_loading')}</Text>}
        {!loading && snapshots.length === 0 && !error && (
          <Text mt="5" color="var(--studio-muted)">{t('studio.recovery_empty')}</Text>
        )}
        {!loading && snapshots.map((snapshot) => {
          const name = getTimelineRecoveryDisplayName(snapshot)
          const updated = new Intl.DateTimeFormat(i18n.language, {
            dateStyle: 'medium',
            timeStyle: 'short',
          }).format(new Date(snapshot.updatedAt))
          return (
            <Box
              key={snapshot.id} mt="4" p="4" bg="var(--studio-frame)" borderRadius="md"
              border="1px solid" borderColor="var(--studio-line)"
            >
              <Flex align="center" gap="3">
                <Box minW="0" flex="1">
                  <Text fontWeight="bold" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
                    {name}
                  </Text>
                  <Text mt="1" fontSize="xs" color="var(--studio-muted)">
                    {t('studio.recovery_details', {
                      updated,
                      size: formatBytes(snapshot.byteLength),
                    })}
                  </Text>
                  {snapshot.filePath && (
                    <Text mt="1" fontSize="xs" color="var(--studio-muted)" overflowWrap="anywhere">
                      {snapshot.filePath}
                    </Text>
                  )}
                </Box>
                <Button
                  size="sm" colorScheme="primary" loading={busyId === snapshot.id}
                  disabled={!!busyId && busyId !== snapshot.id}
                  aria-label={t('studio.recovery_restore_named', { name })}
                  onClick={() => { void restore(snapshot) }}
                >
                  {t('studio.recovery_restore')}
                </Button>
                <Button
                  size="sm" colorScheme="red" variant="outline"
                  disabled={!!busyId}
                  aria-label={t('studio.recovery_discard_named', { name })}
                  onClick={() => { void discard(snapshot) }}
                >
                  {t('studio.recovery_discard')}
                </Button>
              </Flex>
            </Box>
          )
        })}

        {error && (
          <Text mt="4" p="3" borderRadius="md" bg="var(--studio-error-soft)" color="var(--studio-error)" role="alert">
            {t('studio.recovery_error', { error })}
          </Text>
        )}
        <Flex mt="5" justify="flex-end">
          <Button onClick={onClose} disabled={!!busyId}>{t('studio.close')}</Button>
        </Flex>
      </Box>
    </Box>
  )
}
