import React, { useEffect, useMemo, useState } from 'react'
import { Box, Button, Flex, Input, Text, Textarea } from '@yamada-ui/react'
import { useTranslation } from 'react-i18next'
import { StudioDialogClose } from './StudioDialogClose'
import { useModalDialog } from '../hooks/useModalDialog'
import {
  DEFAULT_SONG_METADATA,
  MAX_LOOP_COUNT,
  MAX_SONG_METADATA_FIELD_LENGTH,
  MAX_SONG_METADATA_TOTAL_LENGTH,
  type SongMetadata,
  type TimelineSettings,
} from '../types/timeline'
import { normalizeSongMetadata, validateSongMetadata } from '../utils/timelineIO'

export interface SongMetadataDialogValue {
  metadata: SongMetadata
  loop: TimelineSettings['loop'] & { maxLoopCount: number }
}

export interface SongMetadataDialogProps {
  open: boolean
  metadata?: SongMetadata
  loop: TimelineSettings['loop']
  lengthTicks: number
  /** Route this one project-sized change through a single undoable host action. */
  onApply: (value: SongMetadataDialogValue) => void | Promise<void>
  onClose: () => void
}

function initialValue(
  metadata: SongMetadata | undefined,
  loop: TimelineSettings['loop'],
  lengthTicks: number,
): SongMetadataDialogValue {
  const maximumEnd = Math.max(1, Math.trunc(lengthTicks))
  const startTick = Math.max(0, Math.min(maximumEnd - 1, Math.trunc(loop.startTick)))
  const endTick = Math.max(startTick + 1, Math.min(maximumEnd, Math.trunc(loop.endTick)))
  return {
    metadata: normalizeSongMetadata(metadata ?? DEFAULT_SONG_METADATA),
    loop: {
      enabled: loop.enabled,
      startTick,
      endTick,
      maxLoopCount: Math.max(0, Math.min(MAX_LOOP_COUNT, Math.trunc(loop.maxLoopCount ?? 0))),
    },
  }
}

const STAT_FIELDS = [
  'minutesSpent', 'leftClicks', 'rightClicks', 'blocksAdded', 'blocksRemoved',
] as const

const CREDIT_LABEL_KEYS = {
  title: 'studio.song_metadata_song_title',
  author: 'studio.song_metadata_author',
  originalAuthor: 'studio.song_metadata_original_author',
} as const

const STAT_LABEL_KEYS = {
  minutesSpent: 'studio.song_metadata_minutes_spent',
  leftClicks: 'studio.song_metadata_left_clicks',
  rightClicks: 'studio.song_metadata_right_clicks',
  blocksAdded: 'studio.song_metadata_blocks_added',
  blocksRemoved: 'studio.song_metadata_blocks_removed',
} as const

export const SongMetadataDialog: React.FC<SongMetadataDialogProps> = ({
  open,
  metadata,
  loop,
  lengthTicks,
  onApply,
  onClose,
}) => {
  const { t } = useTranslation()
  const [draft, setDraft] = useState(() => initialValue(metadata, loop, lengthTicks))
  const [advanced, setAdvanced] = useState(false)
  const [busy, setBusy] = useState(false)
  const [submitError, setSubmitError] = useState('')

  useEffect(() => {
    if (!open) return
    setDraft(initialValue(metadata, loop, lengthTicks))
    setAdvanced(false)
    setSubmitError('')
  }, [lengthTicks, loop, metadata, open])

  const validationError = useMemo(() => {
    if (validateSongMetadata(draft.metadata)) return t('studio.song_metadata_invalid_metadata')
    const textLength = draft.metadata.title.length
      + draft.metadata.author.length
      + draft.metadata.originalAuthor.length
      + draft.metadata.description.length
      + draft.metadata.sourceFile.length
    if (textLength > MAX_SONG_METADATA_TOTAL_LENGTH) {
      return t('studio.song_metadata_text_budget_error')
    }
    if (!Number.isInteger(draft.loop.startTick) || !Number.isInteger(draft.loop.endTick)
      || draft.loop.startTick < 0 || draft.loop.endTick <= draft.loop.startTick
      || draft.loop.endTick > lengthTicks) {
      return t('studio.song_metadata_loop_range_error', { max: lengthTicks })
    }
    if (!Number.isInteger(draft.loop.maxLoopCount)
      || draft.loop.maxLoopCount < 0 || draft.loop.maxLoopCount > MAX_LOOP_COUNT) {
      return t('studio.song_metadata_loop_count_error', { max: MAX_LOOP_COUNT })
    }
    return ''
  }, [draft, lengthTicks, t])

  const { dialogRef } = useModalDialog({ open, busy, onClose })

  if (!open) return null

  const updateMetadata = (patch: Partial<SongMetadata>) => {
    setSubmitError('')
    setDraft(current => ({
      ...current,
      metadata: { ...current.metadata, ...patch },
    }))
  }

  const updateLoop = (patch: Partial<SongMetadataDialogValue['loop']>) => {
    setSubmitError('')
    setDraft(current => ({
      ...current,
      loop: { ...current.loop, ...patch },
    }))
  }

  const apply = async () => {
    if (validationError || busy) return
    setBusy(true)
    setSubmitError('')
    try {
      await onApply({
        metadata: { ...draft.metadata },
        loop: { ...draft.loop },
      })
      onClose()
    }
    catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error))
    }
    finally {
      setBusy(false)
    }
  }

  const field = (
    key: 'title' | 'author' | 'originalAuthor',
  ) => (
    <Box flex="1" minW="210px">
      <Text fontSize="xs" mb="1">{t(CREDIT_LABEL_KEYS[key])}</Text>
      <Input
        aria-label={t(CREDIT_LABEL_KEYS[key])}
        value={draft.metadata[key]}
        maxLength={MAX_SONG_METADATA_FIELD_LENGTH}
        onChange={event => updateMetadata({ [key]: event.target.value })}
      />
    </Box>
  )

  return (
    <Box
      position="fixed" inset="0" zIndex="2140" bg="var(--knead-scrim)"
      display="flex" alignItems="center" justifyContent="center"
      ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t('studio.song_metadata_title')}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <Box
        w="780px" maxW="calc(100vw - 32px)" maxH="calc(100vh - 40px)"
        overflowY="auto" bg="var(--studio-panel)" borderRadius="lg" boxShadow="xl" p="5"
      >
        <Flex align="start" gap="3">
          <Box>
            <Text fontSize="xl" fontWeight="bold">{t('studio.song_metadata_title')}</Text>
            <Text mt="1" fontSize="sm" color="var(--studio-muted)">
              {t('studio.song_metadata_description')}
            </Text>
          </Box>
          <Box flex="1" />
          <StudioDialogClose onClick={onClose} disabled={busy} />
        </Flex>

        <Flex mt="4" gap="3" wrap="wrap">
          {field('title')}
          {field('author')}
          {field('originalAuthor')}
        </Flex>
        <Box mt="3">
          <Text fontSize="xs" mb="1">{t('studio.song_metadata_description_field')}</Text>
          <Textarea
            aria-label={t('studio.song_metadata_description_field')}
            value={draft.metadata.description}
            maxLength={MAX_SONG_METADATA_FIELD_LENGTH}
            h="110px" resize="vertical"
            onChange={event => updateMetadata({ description: event.target.value })}
          />
        </Box>

        <Box mt="4" p="3" bg="var(--studio-frame)" borderRadius="md">
          <Flex align="center" gap="3" wrap="wrap">
            <Box minW="155px">
              <Text fontWeight="bold">{t('studio.song_metadata_loop_section')}</Text>
              <Text fontSize="xs" color="var(--studio-muted)">{t('studio.song_metadata_loop_hint')}</Text>
            </Box>
            <Button
              size="sm" variant="surface" colorScheme={draft.loop.enabled ? 'primary' : 'gray'}
              aria-pressed={draft.loop.enabled}
              onClick={() => updateLoop({ enabled: !draft.loop.enabled })}
            >
              {draft.loop.enabled
                ? t('studio.song_metadata_loop_enabled')
                : t('studio.song_metadata_loop_disabled')}
            </Button>
            <Box w="135px">
              <Text fontSize="xs" mb="1">{t('studio.song_metadata_loop_start')}</Text>
              <Input
                aria-label={t('studio.song_metadata_loop_start')}
                type="number" min={0} max={Math.max(0, lengthTicks - 1)} step={1}
                value={draft.loop.startTick}
                onChange={event => updateLoop({ startTick: Number(event.target.value) })}
              />
            </Box>
            <Box w="135px">
              <Text fontSize="xs" mb="1">{t('studio.song_metadata_loop_end')}</Text>
              <Input
                aria-label={t('studio.song_metadata_loop_end')}
                type="number" min={1} max={lengthTicks} step={1}
                value={draft.loop.endTick}
                onChange={event => updateLoop({ endTick: Number(event.target.value) })}
              />
            </Box>
            <Box w="150px">
              <Text fontSize="xs" mb="1">{t('studio.song_metadata_loop_count')}</Text>
              <Input
                aria-label={t('studio.song_metadata_loop_count')}
                type="number" min={0} max={MAX_LOOP_COUNT} step={1}
                value={draft.loop.maxLoopCount}
                onChange={event => updateLoop({ maxLoopCount: Number(event.target.value) })}
              />
              <Text mt="1" fontSize="xs" color="var(--studio-muted)">
                {t('studio.song_metadata_loop_count_hint')}
              </Text>
            </Box>
          </Flex>
        </Box>

        <Button
          mt="4" size="sm" variant="outline" aria-expanded={advanced}
          onClick={() => setAdvanced(value => !value)}
        >
          {advanced
            ? t('studio.song_metadata_advanced_hide')
            : t('studio.song_metadata_advanced_show')}
        </Button>
        {advanced && (
          <Box mt="3" p="3" bg="var(--studio-frame)" borderRadius="md">
            <Text fontSize="xs" color="var(--studio-muted)">{t('studio.song_metadata_advanced_hint')}</Text>
            <Flex mt="3" gap="3" wrap="wrap" align="end">
              <Box flex="1" minW="250px">
                <Text fontSize="xs" mb="1">{t('studio.song_metadata_source_file')}</Text>
                <Input
                  aria-label={t('studio.song_metadata_source_file')}
                  value={draft.metadata.sourceFile}
                  maxLength={MAX_SONG_METADATA_FIELD_LENGTH}
                  onChange={event => updateMetadata({ sourceFile: event.target.value })}
                />
              </Box>
              <Button
                size="sm" variant="surface" colorScheme={draft.metadata.autoSave ? 'primary' : 'gray'}
                aria-pressed={draft.metadata.autoSave}
                onClick={() => updateMetadata({ autoSave: !draft.metadata.autoSave })}
              >
                {draft.metadata.autoSave
                  ? t('studio.song_metadata_autosave_enabled')
                  : t('studio.song_metadata_autosave_disabled')}
              </Button>
              <Box w="180px">
                <Text fontSize="xs" mb="1">{t('studio.song_metadata_autosave_duration')}</Text>
                <Input
                  aria-label={t('studio.song_metadata_autosave_duration')}
                  type="number" min={0} max={255} step={1}
                  value={draft.metadata.autoSaveDuration}
                  onChange={event => updateMetadata({ autoSaveDuration: Number(event.target.value) })}
                />
              </Box>
            </Flex>
            <Text mt="4" fontSize="sm" fontWeight="bold">{t('studio.song_metadata_stats')}</Text>
            <Text fontSize="xs" color="var(--studio-muted)">{t('studio.song_metadata_stats_readonly')}</Text>
            <Flex mt="2" gap="2" wrap="wrap">
              {STAT_FIELDS.map(stat => (
                <Box key={stat} w="130px">
                  <Text fontSize="xs" mb="1">{t(STAT_LABEL_KEYS[stat])}</Text>
                  <Input
                    aria-label={t(STAT_LABEL_KEYS[stat])}
                    value={draft.metadata[stat]}
                    readOnly
                  />
                </Box>
              ))}
            </Flex>
          </Box>
        )}

        {(validationError || submitError) && (
          <Text mt="4" p="3" borderRadius="md" bg="var(--studio-error-soft)" color="var(--studio-error)" role="alert">
            {validationError || t('studio.song_metadata_submit_error', { error: submitError })}
          </Text>
        )}
        <Flex mt="5" justify="flex-end" gap="2">
          <Button onClick={onClose} disabled={busy}>{t('studio.song_metadata_cancel')}</Button>
          <Button
            colorScheme="primary" loading={busy} disabled={Boolean(validationError)}
            onClick={() => { void apply() }}
          >
            {t('studio.song_metadata_apply')}
          </Button>
        </Flex>
      </Box>
    </Box>
  )
}
