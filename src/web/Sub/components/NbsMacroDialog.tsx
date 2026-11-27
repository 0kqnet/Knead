import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Button, Flex, Input, Select, Text } from '@yamada-ui/react'
import { useTranslation } from 'react-i18next'
import { useModalDialog } from '../hooks/useModalDialog'
import { CommitNumberInput } from '../../components/CommitNumberInput'
import type { TimelineState } from '../types/timeline'
import {
  NBS_MACRO_TYPES,
  previewNbsMacro,
  type NbsMacroPreview,
  type NbsMacroPreviewDetail,
  type NbsMacroPreviewValue,
  type NbsMacroRequest,
} from '../utils/nbsMacros'

interface Props {
  open: boolean
  project: TimelineState
  selectedIds: ReadonlySet<string> | readonly string[]
  onApply: (state: TimelineState, selectedIds: readonly string[]) => void | Promise<void>
  onClose: () => void
}

const LABEL_KEYS: Record<NbsMacroRequest['type'], string> = {
  'tremolo': 'studio.nbs_macro_tremolo',
  'stereo': 'studio.nbs_macro_stereo',
  'arpeggio': 'studio.nbs_macro_arpeggio',
  'portamento': 'studio.nbs_macro_portamento',
  'vibrato': 'studio.nbs_macro_vibrato',
  'stagger': 'studio.nbs_macro_stagger',
  'chorus': 'studio.nbs_macro_chorus',
  'volume-lfo': 'studio.nbs_macro_volume_lfo',
  'fade-in': 'studio.nbs_macro_fade_in',
  'fade-out': 'studio.nbs_macro_fade_out',
  'replace-key': 'studio.nbs_macro_replace_key',
  'set-velocity': 'studio.nbs_macro_set_velocity',
  'set-panning': 'studio.nbs_macro_set_panning',
  'set-pitch': 'studio.nbs_macro_set_pitch',
  'reset-properties': 'studio.nbs_macro_reset',
}

function numbers(value: string, scale = 1): number[] {
  const pieces = value.split(/[|,\s]+/).filter(Boolean)
  if (!pieces.length) throw new Error('Enter at least one pattern value')
  const parsed = pieces.map(piece => Number(piece) / scale)
  if (parsed.some(item => !Number.isFinite(item))) throw new Error('Pattern values must be numbers')
  return parsed
}

function formatPreviewValue(value: NbsMacroPreviewValue): string {
  if (value === null) return '—'
  if (typeof value === 'string') return value
  if (Number.isInteger(value)) return String(value)
  return String(Number(value.toFixed(4)))
}

function formatPreviewDetail(detail: NbsMacroPreviewDetail): string {
  const prefix = detail.kind === 'added' ? '+' : detail.kind === 'deleted' ? '−' : '~'
  const differences = detail.differences.map(difference => (
    `${difference.field} ${formatPreviewValue(difference.before)} → ${formatPreviewValue(difference.after)}`
  )).join(', ')
  return `${prefix} ${detail.markerId}: ${differences}`
}

interface PreparedPreview {
  preview: NbsMacroPreview
  type: NbsMacroRequest['type']
}

export const NbsMacroDialog: React.FC<Props> = ({ open, project, selectedIds, onApply, onClose }) => {
  const { t } = useTranslation()
  const [type, setType] = useState<NbsMacroRequest['type']>('tremolo')
  const [primary, setPrimary] = useState(40)
  const [secondary, setSecondary] = useState(5)
  const [pattern, setPattern] = useState('0|4|7')
  const [toggle, setToggle] = useState(false)
  const [fade, setFade] = useState<'none' | 'in' | 'out'>('none')
  const [spacing, setSpacing] = useState<1 | 2>(1)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const applyLockRef = useRef(false)
  const selectionCount = useMemo(
    () => selectedIds instanceof Set ? selectedIds.size : new Set(selectedIds).size,
    [selectedIds],
  )

  useEffect(() => {
    if (open) {
      applyLockRef.current = false
      setMessage('')
    }
  }, [open])

  const buildRequest = useCallback((): NbsMacroRequest => {
    switch (type) {
      case 'tremolo': return { type, spacing, fade }
      case 'stereo': return { type, width: primary / 100, reversed: toggle }
      case 'arpeggio': return { type, semitones: numbers(pattern) }
      case 'portamento': return { type, cents: primary, reversed: toggle }
      case 'vibrato': return { type, depthCents: primary }
      case 'stagger': return { type, trackOffsets: numbers(pattern).map(Math.round) }
      case 'chorus': return { type, width: primary / 100, detuneCents: secondary }
      case 'volume-lfo': return { type, levels: numbers(pattern, 100) }
      case 'set-velocity': return { type, value: primary, percent: toggle }
      case 'set-panning': return { type, value: primary / 100 }
      case 'set-pitch': return { type, cents: primary, add: toggle }
      default: return { type }
    }
  }, [fade, pattern, primary, secondary, spacing, toggle, type])

  const prepared = useMemo<PreparedPreview | { error: string } | null>(() => {
    if (!open || !selectionCount) return null
    try {
      return { preview: previewNbsMacro(project, selectedIds, buildRequest()), type }
    }
    catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }, [buildRequest, open, project, selectedIds, selectionCount, type])
  const preview = prepared && 'preview' in prepared ? prepared.preview : null
  const previewError = prepared && 'error' in prepared ? prepared.error : ''
  const hasPreviewChanges = !!preview
    && preview.changedCount + preview.addedCount + preview.deletedCount > 0

  const apply = useCallback(async () => {
    if (!preview || !hasPreviewChanges || applyLockRef.current) return
    const shownPreview = preview
    const shownType = prepared && 'type' in prepared ? prepared.type : type
    applyLockRef.current = true
    setBusy(true)
    setMessage('')
    try {
      await onApply(shownPreview.result.state, shownPreview.result.affectedMarkerIds)
      setMessage([
        t('studio.nbs_macro_applied', {
          name: t(LABEL_KEYS[shownType]),
          count: shownPreview.result.affectedMarkerIds.length,
        }),
        ...shownPreview.result.warnings,
      ].join(' '))
    }
    catch (error) {
      setMessage(t('studio.nbs_macro_error', {
        error: error instanceof Error ? error.message : String(error),
      }))
    }
    finally {
      applyLockRef.current = false
      setBusy(false)
    }
  }, [hasPreviewChanges, onApply, prepared, preview, t, type])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.repeat) {
        event.preventDefault()
        event.stopPropagation()
        void apply()
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [apply, open])

  const { dialogRef } = useModalDialog({ open, busy, onClose })

  if (!open) return null

  const numberControl = (label: string, minimum: number, maximum: number, step = 1) => (
    <Flex align="center" gap="3">
      <Text minW="140px" fontSize="sm">{label}</Text>
      <CommitNumberInput
        value={primary} min={minimum} max={maximum} step={step} precision={step < 1 ? 1 : 0}
        onCommit={setPrimary} size="sm" w="130px" disabled={busy}
      />
    </Flex>
  )

  return (
    <Box
      position="fixed" inset="0" zIndex="2140" bg="rgba(0,0,0,.75)"
      display="flex" alignItems="center" justifyContent="center"
      ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t('studio.nbs_macros_title')}
      onPointerDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}
    >
      <Box w="680px" maxW="calc(100vw - 32px)" maxH="calc(100vh - 32px)" overflowY="auto" bg="var(--studio-panel)" borderRadius="lg" boxShadow="xl" p="5">
        <Flex align="start" gap="3">
          <Box>
            <Text fontSize="xl" fontWeight="bold">{t('studio.nbs_macros_title')}</Text>
            <Text fontSize="sm" color="var(--studio-muted)">
              {t('studio.nbs_macros_description')}
            </Text>
          </Box>
          <Box flex="1" />
          <Button size="sm" onClick={onClose} disabled={busy}>×</Button>
        </Flex>

        <Box mt="4" p="4" bg="var(--studio-frame)" borderRadius="md">
          <Flex align="center" gap="3">
            <Text minW="140px" fontSize="sm">{t('studio.nbs_macro_label')}</Text>
            <Select.Root
              value={type}
              aria-label={t('studio.nbs_macro_label')}
              disabled={busy}
              items={NBS_MACRO_TYPES.map(value => ({ value, label: t(LABEL_KEYS[value]) }))}
              onChange={(value) => {
                setType(value as NbsMacroRequest['type'])
                setMessage('')
                if (value === 'arpeggio') setPattern('0|4|7')
                if (value === 'stagger') setPattern('0|1|2')
                if (value === 'volume-lfo') setPattern('100|50|25|50')
                if (value === 'stereo' || value === 'chorus') setPrimary(40)
                if (value === 'portamento' || value === 'set-pitch') setPrimary(100)
                if (value === 'vibrato') setPrimary(40)
                if (value === 'set-velocity') setPrimary(100)
                if (value === 'set-panning') setPrimary(0)
              }}
              rootProps={{ flex: '1' }}
            />
          </Flex>

          <Box mt="4">
            {type === 'tremolo' && (
              <Flex gap="3">
                <Select.Root
                  value={String(spacing)}
                  disabled={busy}
                  items={[
                    { label: t('studio.nbs_macro_spacing', { count: 1 }), value: '1' },
                    { label: t('studio.nbs_macro_spacing', { count: 2 }), value: '2' },
                  ]}
                  onChange={value => setSpacing(Number(value) as 1 | 2)}
                />
                <Select.Root
                  value={fade}
                  disabled={busy}
                  items={[
                    { label: t('studio.nbs_macro_no_fade'), value: 'none' },
                    { label: t('studio.nbs_macro_fade_in'), value: 'in' },
                    { label: t('studio.nbs_macro_fade_out'), value: 'out' },
                  ]}
                  onChange={value => setFade(value as typeof fade)}
                />
              </Flex>
            )}
            {(type === 'arpeggio' || type === 'stagger' || type === 'volume-lfo') && (
              <Flex align="center" gap="3">
                <Text minW="140px" fontSize="sm">
                  {type === 'volume-lfo'
                    ? t('studio.nbs_macro_percent_pattern')
                    : type === 'stagger'
                      ? t('studio.nbs_macro_track_offsets')
                      : t('studio.nbs_macro_semitone_pattern')}
                </Text>
                <Input value={pattern} disabled={busy} onChange={event => setPattern(event.target.value)} fontFamily="mono" />
              </Flex>
            )}
            {type === 'stereo' && numberControl(t('studio.nbs_macro_stereo_width'), 0, 100)}
            {type === 'portamento' && numberControl(t('studio.nbs_macro_cent_shift'), -1200, 1200)}
            {type === 'vibrato' && numberControl(t('studio.nbs_macro_depth'), 0, 1200)}
            {type === 'chorus' && (
              <Flex direction="column" gap="3">
                {numberControl(t('studio.nbs_macro_stereo_width'), 0, 100)}
                <Flex align="center" gap="3">
                  <Text minW="140px" fontSize="sm">{t('studio.nbs_macro_detune')}</Text>
                  <CommitNumberInput
                    value={secondary} min={0} max={1200} step={1} precision={0}
                    onCommit={setSecondary} size="sm" w="130px" disabled={busy}
                  />
                </Flex>
              </Flex>
            )}
            {type === 'set-velocity' && numberControl(toggle ? t('studio.nbs_macro_velocity_percent') : t('studio.nbs_macro_velocity'), 0, toggle ? 1000 : 100)}
            {type === 'set-panning' && numberControl(t('studio.nbs_macro_panning'), -100, 100)}
            {type === 'set-pitch' && numberControl(t('studio.nbs_macro_pitch'), -1200, 1200)}
            {(type === 'stereo' || type === 'portamento' || type === 'set-velocity' || type === 'set-pitch') && (
              <Button mt="3" size="sm" colorScheme={toggle ? 'purple' : 'gray'} disabled={busy} onClick={() => setToggle(value => !value)}>
                {type === 'set-velocity'
                  ? t('studio.nbs_macro_percent_mode')
                  : type === 'set-pitch'
                    ? t('studio.nbs_macro_add_mode')
                    : t('studio.nbs_macro_reversed')}
                {toggle ? ' ON' : ' OFF'}
              </Button>
            )}
            {['fade-in', 'fade-out', 'replace-key', 'reset-properties'].includes(type) && (
              <Text fontSize="sm" color="var(--studio-muted)">{t('studio.nbs_macro_no_parameters')}</Text>
            )}
          </Box>
        </Box>

        <Text mt="3" fontSize="xs" color={selectionCount ? 'cyan.300' : 'orange.300'}>
          {t('studio.nbs_macro_selection_hint', { count: selectionCount })}
        </Text>
        <Box mt="3" p="3" bg="var(--studio-frame)" borderRadius="md" aria-live="polite">
          <Text fontSize="sm" fontWeight="bold">{t('studio.nbs_macro_preview_title')}</Text>
          {!selectionCount && (
            <Text mt="1" fontSize="sm" color="var(--studio-muted)">{t('studio.nbs_macro_preview_empty')}</Text>
          )}
          {previewError && (
            <Text role="alert" mt="1" fontSize="sm" color="var(--studio-error)">
              {t('studio.nbs_macro_preview_error', { error: previewError })}
            </Text>
          )}
          {preview && (
            <>
              <Text mt="1" fontSize="sm" color={hasPreviewChanges ? 'cyan.200' : 'gray.400'}>
                {t('studio.nbs_macro_preview_summary', {
                  changed: preview.changedCount,
                  added: preview.addedCount,
                  deleted: preview.deletedCount,
                })}
              </Text>
              {!hasPreviewChanges && (
                <Text mt="1" fontSize="xs" color="var(--studio-muted)">{t('studio.nbs_macro_preview_no_changes')}</Text>
              )}
              {!!preview.details.length && (
                <Box mt="2" maxH="170px" overflowY="auto">
                  {preview.details.map(detail => (
                    <Text key={`${detail.kind}:${detail.markerId}`} fontSize="xs" fontFamily="mono" color="var(--studio-muted)">
                      {formatPreviewDetail(detail)}
                    </Text>
                  ))}
                </Box>
              )}
              {!!preview.omittedDetailCount && (
                <Text mt="1" fontSize="xs" color="var(--studio-muted)">
                  {t('studio.nbs_macro_preview_more', { count: preview.omittedDetailCount })}
                </Text>
              )}
              {preview.result.warnings.map(warning => (
                <Text key={warning} mt="1" fontSize="xs" color="var(--studio-warning)">{warning}</Text>
              ))}
            </>
          )}
        </Box>
        {message && (
          <Text
            mt="3" fontSize="sm"
            color={message.startsWith('Error:') || message.startsWith('エラー:') ? 'red.300' : 'green.300'}
          >
            {message}
          </Text>
        )}
        <Flex mt="5" justify="flex-end" gap="2">
          <Button onClick={onClose} disabled={busy}>{t('studio.close')}</Button>
          <Button colorScheme="purple" onClick={() => void apply()} loading={busy} disabled={!hasPreviewChanges || busy}>
            {t('studio.nbs_macro_apply')}
          </Button>
        </Flex>
      </Box>
    </Box>
  )
}
