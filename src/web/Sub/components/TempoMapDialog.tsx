import React, { useEffect, useMemo, useState } from 'react'
import { Box, Button, Flex, Input, Select, Text } from '@yamada-ui/react'
import { useTranslation } from 'react-i18next'
import { StudioDialogClose } from './StudioDialogClose'
import { useModalDialog } from '../hooks/useModalDialog'
import {
  MAX_TEMPO_MAP_EVENTS,
  type TempoMapEvent,
  type TimelineSettings,
} from '../types/timeline'
import {
  buildTempoMap,
  normalizeTempoMap,
  tempoAtTick,
  validateTempoMap,
} from '../utils/tempoMap'

export interface TempoMapDialogProps {
  open: boolean
  events?: readonly TempoMapEvent[]
  settings: Pick<TimelineSettings, 'bpm' | 'timeSignature'>
  lengthTicks: number
  /** Used as the suggested location for a newly added conductor event. */
  currentTick?: number
  /** The host should route this single callback through useTimeline.setTempoMap. */
  onApply: (events: TempoMapEvent[]) => void | Promise<void>
  onClose: () => void
}

const DENOMINATOR_ITEMS = [2, 4, 8, 16] as const

function cloneEvents(events: readonly TempoMapEvent[]): TempoMapEvent[] {
  return events.map(event => ({
    ...event,
    ...(event.meter === undefined ? {} : { meter: { ...event.meter } }),
  }))
}

function duplicateTick(events: readonly TempoMapEvent[]): number | null {
  const seen = new Set<number>()
  for (const event of events) {
    if (seen.has(event.tick)) return event.tick
    seen.add(event.tick)
  }
  return null
}

export const TempoMapDialog: React.FC<TempoMapDialogProps> = ({
  open,
  events,
  settings,
  lengthTicks,
  currentTick = 0,
  onApply,
  onClose,
}) => {
  const { t } = useTranslation()
  const fallback = useMemo(() => ({
    bpm: settings.bpm,
    timeSignature: {
      numerator: settings.timeSignature.numerator,
      denominator: settings.timeSignature.denominator,
    },
  }), [
    settings.bpm,
    settings.timeSignature.denominator,
    settings.timeSignature.numerator,
  ])
  const [draft, setDraft] = useState<TempoMapEvent[]>(() => normalizeTempoMap(events, fallback))
  const [busy, setBusy] = useState(false)
  const [submitError, setSubmitError] = useState('')

  useEffect(() => {
    if (!open) return
    setDraft(cloneEvents(normalizeTempoMap(events, fallback, Math.max(0, lengthTicks - 1))))
    setSubmitError('')
  }, [
    events,
    fallback,
    lengthTicks,
    open,
  ])

  const validationError = useMemo(() => {
    const error = validateTempoMap(draft, fallback, { maxTick: Math.max(0, lengthTicks - 1) })
    if (error) return error
    const duplicate = duplicateTick(draft)
    if (duplicate !== null) return t('studio.tempo_map_duplicate_tick', { tick: duplicate })
    if (!draft.some(event => event.tick === 0)) return t('studio.tempo_map_tick_zero_required')
    return ''
  }, [draft, fallback, lengthTicks, t])

  const { dialogRef } = useModalDialog({ open, busy, onClose })

  if (!open) return null

  const update = (index: number, patch: Partial<TempoMapEvent>) => {
    setSubmitError('')
    setDraft(current => current.map((event, eventIndex) => (
      eventIndex === index ? { ...event, ...patch } : event
    )))
  }

  const add = () => {
    if (draft.length >= MAX_TEMPO_MAP_EVENTS) return
    const used = new Set(draft.map(event => event.tick))
    let tick = Math.max(0, Math.min(lengthTicks - 1, Math.round(currentTick)))
    if (used.has(tick)) {
      tick = Math.max(0, Math.min(lengthTicks - 1, (draft.at(-1)?.tick ?? 0) + 20))
      while (used.has(tick) && tick < lengthTicks - 1) tick++
      while (used.has(tick) && tick > 0) tick--
    }
    if (used.has(tick)) return
    const model = buildTempoMap(draft, fallback, Math.max(0, lengthTicks - 1))
    const active = tempoAtTick(tick, model)
    setDraft(current => [...current, { tick, bpm: active.bpm }].sort((left, right) => left.tick - right.tick))
    setSubmitError('')
  }

  const apply = async () => {
    if (validationError) return
    setBusy(true)
    setSubmitError('')
    try {
      const normalized = normalizeTempoMap(draft, fallback, Math.max(0, lengthTicks - 1))
      await onApply(normalized)
      onClose()
    }
    catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error))
    }
    finally {
      setBusy(false)
    }
  }

  return (
    <Box
      position="fixed" inset="0" zIndex="2140" bg="var(--knead-scrim)"
      display="flex" alignItems="center" justifyContent="center"
      ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t('studio.tempo_map_title')}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <Box
        w="820px" maxW="calc(100vw - 32px)" maxH="calc(100vh - 40px)"
        overflowY="auto" bg="var(--studio-panel)" borderRadius="lg" boxShadow="xl" p="5"
      >
        <Flex align="start" gap="3">
          <Box>
            <Text fontSize="xl" fontWeight="bold">{t('studio.tempo_map_title')}</Text>
            <Text mt="1" fontSize="sm" color="var(--studio-muted)">
              {t('studio.tempo_map_description')}
            </Text>
          </Box>
          <Box flex="1" />
          <StudioDialogClose onClick={onClose} disabled={busy} />
        </Flex>

        <Text mt="3" fontSize="xs" color="var(--studio-accent-text)">
          {t('studio.tempo_map_anchor_hint')}
        </Text>

        <Flex mt="4" px="2" gap="2" color="var(--studio-muted)" fontSize="xs">
          <Text w="110px">{t('studio.tempo_map_tick')}</Text>
          <Text w="110px">{t('studio.tempo_map_bpm')}</Text>
          <Text w="130px">{t('studio.tempo_map_meter')}</Text>
          <Text w="110px">{t('studio.tempo_map_numerator')}</Text>
        </Flex>
        {draft.map((event, index) => {
          const meterMode = event.meter ? String(event.meter.denominator) : 'inherit'
          return (
            <Flex
              key={`tempo-row-${index}`} mt="2" p="2" gap="2" align="center"
              bg="var(--studio-frame)" borderRadius="md"
            >
              <Input
                aria-label={t('studio.tempo_map_tick_index', { index: index + 1 })}
                type="number" w="110px" min={0} max={Math.max(0, lengthTicks - 1)} step={1}
                value={event.tick}
                disabled={index === 0}
                onChange={change => update(index, { tick: Number(change.target.value) })}
              />
              <Input
                aria-label={t('studio.tempo_map_bpm_index', { index: index + 1 })}
                type="number" w="110px" min={20} max={300} step={0.01}
                value={event.bpm}
                onChange={change => update(index, { bpm: Number(change.target.value) })}
              />
              <Select.Root
                aria-label={t('studio.tempo_map_meter_index', { index: index + 1 })}
                rootProps={{ w: '130px' }}
                value={meterMode}
                items={[
                  ...(index === 0
                    ? []
                    : [{
                        value: 'inherit', label: t('studio.tempo_map_inherit'),
                      }]),
                  ...DENOMINATOR_ITEMS.map(denominator => ({
                    value: String(denominator), label: `1/${denominator}`,
                  })),
                ]}
                onChange={(value) => {
                  if (value === 'inherit') update(index, { meter: undefined })
                  else update(index, {
                    meter: {
                      numerator: event.meter?.numerator ?? fallback.timeSignature.numerator,
                      denominator: Number(value) as 2 | 4 | 8 | 16,
                    },
                  })
                }}
              />
              <Input
                aria-label={t('studio.tempo_map_numerator_index', { index: index + 1 })}
                type="number" w="110px" min={1} max={16} step={1}
                value={event.meter?.numerator ?? ''}
                disabled={!event.meter}
                onChange={change => update(index, {
                  meter: event.meter
                    ? {
                        ...event.meter,
                        numerator: Number(change.target.value),
                      }
                    : undefined,
                })}
              />
              <Box flex="1" />
              <Button
                size="sm" colorScheme="red" variant="outline"
                aria-label={t('studio.tempo_map_delete_index', { index: index + 1 })}
                disabled={index === 0 || busy}
                onClick={() => setDraft(current => current.filter((_, eventIndex) => eventIndex !== index))}
              >
                {t('studio.tempo_map_delete')}
              </Button>
            </Flex>
          )
        })}

        <Button
          mt="3" size="sm" onClick={add}
          disabled={busy || draft.length >= MAX_TEMPO_MAP_EVENTS}
        >
          {t('studio.tempo_map_add')}
        </Button>
        <Text ml="3" as="span" fontSize="xs" color="var(--studio-muted)">
          {t('studio.tempo_map_count', { count: draft.length, max: MAX_TEMPO_MAP_EVENTS })}
        </Text>

        {(validationError || submitError) && (
          <Text mt="4" p="3" borderRadius="md" bg="var(--studio-error-soft)" color="var(--studio-error)" role="alert">
            {t('studio.tempo_map_error', { error: validationError || submitError })}
          </Text>
        )}
        <Flex mt="5" justify="flex-end" gap="2">
          <Button onClick={onClose} disabled={busy}>{t('studio.close')}</Button>
          <Button
            colorScheme="primary" loading={busy} disabled={Boolean(validationError)}
            onClick={() => { void apply() }}
          >
            {t('studio.tempo_map_apply')}
          </Button>
        </Flex>
      </Box>
    </Box>
  )
}
