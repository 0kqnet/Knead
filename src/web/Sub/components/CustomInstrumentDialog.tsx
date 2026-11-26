import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Button, Checkbox, Flex, Input, Text } from '@yamada-ui/react'
import { useTranslation } from 'react-i18next'
import {
  MAX_EMBEDDED_CUSTOM_AUDIO_PROJECT_BYTES,
  MAX_PROJECT_CUSTOM_INSTRUMENTS,
  type EmbeddedCustomAudioAsset,
  type ProjectCustomInstrument,
  type TimelineState,
} from '../types/timeline'
import {
  applyProjectCustomInstruments,
  createProjectCustomInstrument,
  deriveProjectCustomInstruments,
  isProtectedProjectCustomInstrument,
  projectCustomInstrumentWarnings,
  validateProjectCustomInstruments,
} from '../utils/customInstruments'
import {
  prepareProjectCustomAudioAssets,
  prepareProjectCustomAudioRegistry,
} from '../utils/projectCustomAudio'
import { readReferenceAudioFileData } from '../utils/referenceAudio'
import { useModalDialog } from '../hooks/useModalDialog'

export interface CustomInstrumentDialogProps {
  open: boolean
  project: TimelineState
  onApply: (state: TimelineState, warnings: readonly string[]) => void | Promise<void>
  onClose: () => void
}

const MAX_VISIBLE_WARNINGS = 12
const EDITOR_TEXT_LIMIT = 1024

function cloneDefinitions(project: TimelineState): ProjectCustomInstrument[] {
  return deriveProjectCustomInstruments(project).map(instrument => ({ ...instrument }))
}

function customBytes(assets: readonly EmbeddedCustomAudioAsset[]): number {
  return assets.reduce((total, asset) => total + asset.byteLength, 0)
}

function referenceBytes(project: TimelineState): number {
  return (project.referenceAudio ?? []).reduce((total, track) => total + track.byteLength, 0)
}

export const CustomInstrumentDialog: React.FC<CustomInstrumentDialogProps> = ({
  open,
  project,
  onApply,
  onClose,
}) => {
  const { t } = useTranslation()
  const [draft, setDraft] = useState<ProjectCustomInstrument[]>(() => cloneDefinitions(project))
  const [assets, setAssets] = useState<EmbeddedCustomAudioAsset[]>(() => (
    (project.customAudio ?? []).map(asset => ({ ...asset }))
  ))
  const [selectedId, setSelectedId] = useState<string | null>(() => draft[0]?.id ?? null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const projectRef = useRef(project)
  const openRef = useRef(open)
  const mountedRef = useRef(true)
  const asyncGenerationRef = useRef(0)
  projectRef.current = project
  openRef.current = open
  const { dialogRef } = useModalDialog({ open, busy, onClose })

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      asyncGenerationRef.current = -1
    }
  }, [])

  useEffect(() => {
    asyncGenerationRef.current++
    if (!open) return
    const definitions = cloneDefinitions(project)
    setDraft(definitions)
    setAssets((project.customAudio ?? []).map(asset => ({ ...asset })))
    setSelectedId(definitions[0]?.id ?? null)
    setBusy(false)
    setError('')
    setNotice('')
  }, [open, project])

  const selectedIndex = draft.findIndex(instrument => instrument.id === selectedId)
  const selected = selectedIndex >= 0 ? draft[selectedIndex] : undefined
  const selectedAssets = selected?.kind === 'audio'
    ? assets.filter(asset => asset.soundId === selected.soundId)
    : []
  const validationError = useMemo(() => validateProjectCustomInstruments(draft) ?? '', [draft])
  const warnings = useMemo(
    () => projectCustomInstrumentWarnings(draft, assets),
    [assets, draft],
  )

  if (!open) return null

  const updateSelected = (patch: Partial<ProjectCustomInstrument>) => {
    if (!selected) return
    setError('')
    setNotice('')
    setDraft(current => current.map(instrument => (
      instrument.id === selected.id ? { ...instrument, ...patch } : instrument
    )))
  }

  const add = () => {
    if (draft.length >= MAX_PROJECT_CUSTOM_INSTRUMENTS) return
    const instrument = createProjectCustomInstrument(draft, t('studio.custom_instrument_default_name'))
    setDraft(current => [...current, instrument])
    setSelectedId(instrument.id)
    setError('')
    setNotice('')
  }

  const remove = () => {
    if (!selected || isProtectedProjectCustomInstrument(selected)) return
    const original = deriveProjectCustomInstruments(project).find(instrument => instrument.id === selected.id)
    const referencedSoundIds = new Set([selected.soundId, ...(original ? [original.soundId] : [])])
    const markerCount = project.markers.filter(marker => referencedSoundIds.has(marker.soundId)).length
    if (markerCount > 0) {
      setError(t('studio.custom_instrument_delete_referenced', { count: markerCount }))
      return
    }
    const remaining = draft.filter(instrument => instrument.id !== selected.id)
    const retainedSoundIds = new Set(remaining
      .filter(instrument => instrument.kind === 'audio')
      .map(instrument => instrument.soundId))
    setDraft(remaining)
    setAssets(current => current.filter(asset => (
      !referencedSoundIds.has(asset.soundId) || retainedSoundIds.has(asset.soundId)
    )))
    setSelectedId(remaining[Math.min(selectedIndex, remaining.length - 1)]?.id ?? null)
    setError('')
    setNotice(t('studio.custom_instrument_deleted'))
  }

  const move = (offset: -1 | 1) => {
    if (selectedIndex < 0) return
    const destination = selectedIndex + offset
    if (destination < 0 || destination >= draft.length) return
    setDraft((current) => {
      const next = [...current]
      const [item] = next.splice(selectedIndex, 1)
      next.splice(destination, 0, item)
      return next
    })
    setError('')
    setNotice('')
  }

  const attach = async () => {
    if (!selected || selected.kind !== 'audio' || busy) return
    const generation = ++asyncGenerationRef.current
    const sourceProject = project
    const isCurrent = () => mountedRef.current
      && openRef.current
      && asyncGenerationRef.current === generation
      && projectRef.current === sourceProject
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const result = await window.myAPI.referenceAudio.open()
      if (!isCurrent()) return
      if (!result.ok) {
        if (!('canceled' in result)) setError(result.error)
        return
      }
      const bytes = readReferenceAudioFileData(result)
      const nextDefinition = { ...selected, file: result.fileName }
      const prepared = await prepareProjectCustomAudioAssets([{
        soundId: nextDefinition.soundId,
        fileName: nextDefinition.file,
        mimeType: result.mimeType,
        data: bytes,
        pitch: nextDefinition.defaultPitch,
      }])
      if (!isCurrent()) return
      const original = deriveProjectCustomInstruments(project).find(item => item.id === selected.id)
      const replacedIds = new Set([selected.soundId, ...(original ? [original.soundId] : [])])
      const nextAssets = [
        ...assets.filter(asset => !replacedIds.has(asset.soundId)),
        ...prepared,
      ]
      if (referenceBytes(project) + customBytes(nextAssets) > MAX_EMBEDDED_CUSTOM_AUDIO_PROJECT_BYTES) {
        throw new Error(t('studio.custom_instrument_audio_budget_error'))
      }
      await prepareProjectCustomAudioRegistry(nextAssets)
      if (!isCurrent()) return
      setAssets(nextAssets)
      setDraft(current => current.map(instrument => (
        instrument.id === selected.id ? nextDefinition : instrument
      )))
      setNotice(t('studio.custom_instrument_attached', { file: result.fileName }))
    }
    catch (caught) {
      if (isCurrent()) setError(caught instanceof Error ? caught.message : String(caught))
    }
    finally {
      if (isCurrent()) setBusy(false)
    }
  }

  const apply = async () => {
    if (validationError || busy) return
    const generation = ++asyncGenerationRef.current
    const sourceProject = project
    const isCurrent = () => mountedRef.current
      && openRef.current
      && asyncGenerationRef.current === generation
      && projectRef.current === sourceProject
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const applied = applyProjectCustomInstruments({ ...project, customAudio: assets }, draft)
      if (referenceBytes(project) + customBytes(applied.state.customAudio ?? [])
        > MAX_EMBEDDED_CUSTOM_AUDIO_PROJECT_BYTES) {
        throw new Error(t('studio.custom_instrument_audio_budget_error'))
      }
      await prepareProjectCustomAudioRegistry(applied.state.customAudio ?? [])
      if (!isCurrent()) return
      await onApply(applied.state, applied.warnings)
      if (!isCurrent()) return
      onClose()
    }
    catch (caught) {
      if (isCurrent()) setError(caught instanceof Error ? caught.message : String(caught))
    }
    finally {
      if (isCurrent()) setBusy(false)
    }
  }

  return (
    <Box
      position="fixed" inset="0" zIndex="2140" bg="rgba(0,0,0,.75)"
      display="flex" alignItems="center" justifyContent="center"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <Box
        ref={dialogRef} role="dialog" aria-modal="true" aria-label={t('studio.custom_instrument_title')} tabIndex={-1}
        w="1040px" maxW="calc(100vw - 32px)" maxH="calc(100vh - 40px)"
        overflow="hidden" bg="var(--studio-panel)" borderRadius="lg" boxShadow="xl" p="5"
      >
        <Flex align="start" gap="3">
          <Box>
            <Text fontSize="xl" fontWeight="bold">{t('studio.custom_instrument_title')}</Text>
            <Text mt="1" fontSize="sm" color="var(--studio-muted)">
              {t('studio.custom_instrument_description')}
            </Text>
          </Box>
          <Box flex="1" />
          <Button size="sm" onClick={onClose} isDisabled={busy}>×</Button>
        </Flex>

        <Flex mt="4" gap="4" minH="440px" maxH="calc(100vh - 230px)">
          <Box w="310px" minW="260px" display="flex" flexDir="column">
            <Flex gap="2">
              <Button data-dialog-initial-focus size="sm" colorScheme="blue" onClick={add} isDisabled={busy || draft.length >= MAX_PROJECT_CUSTOM_INSTRUMENTS}>
                {t('studio.custom_instrument_add')}
              </Button>
              <Text alignSelf="center" fontSize="xs" color="var(--studio-muted)">
                {t('studio.custom_instrument_count', { count: draft.length, max: MAX_PROJECT_CUSTOM_INSTRUMENTS })}
              </Text>
            </Flex>
            <Box mt="2" flex="1" overflowY="auto" pr="1" aria-label={t('studio.custom_instrument_list')}>
              {draft.length === 0 && (
                <Text p="3" color="var(--studio-muted)" fontSize="sm">{t('studio.custom_instrument_empty')}</Text>
              )}
              {draft.map((instrument, index) => {
                const usage = instrument.kind === 'audio'
                  ? project.markers.filter(marker => marker.soundId === instrument.soundId).length
                  : 0
                const attachmentCount = instrument.kind === 'audio'
                  ? assets.filter(asset => asset.soundId === instrument.soundId).length
                  : 0
                return (
                  <Button
                    key={instrument.id} mt="1" w="full" h="auto" minH="52px" p="2"
                    justifyContent="flex-start" textAlign="left"
                    colorScheme={selectedId === instrument.id ? 'cyan' : 'gray'}
                    variant={selectedId === instrument.id ? 'solid' : 'outline'}
                    onClick={() => setSelectedId(instrument.id)}
                    aria-label={t('studio.custom_instrument_select_index', { index: index + 1 })}
                  >
                    <Box minW="0">
                      <Text fontSize="sm" whiteSpace="nowrap" overflow="hidden" textOverflow="ellipsis">{instrument.name || instrument.soundId || `#${index + 1}`}</Text>
                      <Text fontSize="xs" opacity={0.8} whiteSpace="nowrap" overflow="hidden" textOverflow="ellipsis">
                        {instrument.kind === 'audio'
                          ? t('studio.custom_instrument_row_stats', { usage, attachments: attachmentCount })
                          : t('studio.custom_instrument_protected')}
                      </Text>
                    </Box>
                  </Button>
                )
              })}
            </Box>
          </Box>

          <Box flex="1" minW="0" overflowY="auto" pr="2">
            {!selected
              ? <Text color="var(--studio-muted)">{t('studio.custom_instrument_select_hint')}</Text>
              : (
                  <Box>
                    {isProtectedProjectCustomInstrument(selected) && (
                      <Text p="3" bg="purple.900" color="purple.100" borderRadius="md" fontSize="sm">
                        {t('studio.custom_instrument_protected_hint')}
                      </Text>
                    )}
                    <Flex mt="3" gap="3" wrap="wrap">
                      <Box flex="1" minW="260px">
                        <Text fontSize="xs" mb="1">{t('studio.custom_instrument_name')}</Text>
                        <Input
                          aria-label={t('studio.custom_instrument_name')}
                          value={selected.name} maxLength={EDITOR_TEXT_LIMIT}
                          isDisabled={isProtectedProjectCustomInstrument(selected) || busy}
                          onChange={event => updateSelected({ name: event.target.value })}
                        />
                      </Box>
                      <Box flex="1" minW="260px">
                        <Text fontSize="xs" mb="1">{t('studio.custom_instrument_sound_id')}</Text>
                        <Input
                          aria-label={t('studio.custom_instrument_sound_id')}
                          value={selected.soundId} maxLength={1024}
                          isDisabled={isProtectedProjectCustomInstrument(selected) || busy}
                          onChange={event => updateSelected({ soundId: event.target.value })}
                        />
                      </Box>
                    </Flex>
                    <Box mt="3">
                      <Text fontSize="xs" mb="1">{t('studio.custom_instrument_file')}</Text>
                      <Input
                        aria-label={t('studio.custom_instrument_file')}
                        value={selected.file} maxLength={EDITOR_TEXT_LIMIT}
                        isDisabled={isProtectedProjectCustomInstrument(selected) || busy}
                        onChange={event => updateSelected({ file: event.target.value })}
                      />
                    </Box>
                    <Flex mt="3" gap="3" align="end" wrap="wrap">
                      <Box w="150px">
                        <Text fontSize="xs" mb="1">{t('studio.custom_instrument_source_key')}</Text>
                        <Input
                          aria-label={t('studio.custom_instrument_source_key')}
                          type="number" min={0} max={87} step={1} value={selected.key}
                          isDisabled={isProtectedProjectCustomInstrument(selected) || busy}
                          onChange={event => updateSelected({ key: Number(event.target.value) })}
                        />
                      </Box>
                      <Box w="170px">
                        <Text fontSize="xs" mb="1">{t('studio.custom_instrument_default_pitch')}</Text>
                        <Input
                          aria-label={t('studio.custom_instrument_default_pitch')}
                          type="number" min={0.01} max={100} step={0.01} value={selected.defaultPitch}
                          isDisabled={isProtectedProjectCustomInstrument(selected) || busy}
                          onChange={event => updateSelected({ defaultPitch: Number(event.target.value) })}
                        />
                      </Box>
                      <Checkbox
                        checked={selected.pressKey}
                        isDisabled={isProtectedProjectCustomInstrument(selected) || busy}
                        onChange={event => updateSelected({ pressKey: event.target.checked })}
                      >
                        {t('studio.custom_instrument_press_key')}
                      </Checkbox>
                    </Flex>

                    {selected.kind === 'audio' && (
                      <Box mt="4" p="3" bg="var(--studio-frame)" borderRadius="md">
                        <Flex align="center" gap="3" wrap="wrap">
                          <Box flex="1" minW="230px">
                            <Text fontWeight="bold">{t('studio.custom_instrument_attachment')}</Text>
                            <Text fontSize="xs" color="var(--studio-muted)">
                              {selectedAssets.length
                                ? t('studio.custom_instrument_attachment_summary', {
                                    count: selectedAssets.length,
                                    size: (selectedAssets.reduce((sum, asset) => sum + asset.byteLength, 0) / 1024 / 1024).toFixed(2),
                                  })
                                : t('studio.custom_instrument_attachment_empty')}
                            </Text>
                          </Box>
                          <Button size="sm" colorScheme="green" isLoading={busy} onClick={() => { void attach() }}>
                            {t('studio.custom_instrument_attach_replace')}
                          </Button>
                        </Flex>
                      </Box>
                    )}

                    <Flex mt="4" gap="2">
                      <Button size="sm" onClick={() => move(-1)} isDisabled={busy || selectedIndex <= 0}>↑</Button>
                      <Button size="sm" onClick={() => move(1)} isDisabled={busy || selectedIndex >= draft.length - 1}>↓</Button>
                      <Button
                        size="sm" colorScheme="red" variant="outline" onClick={remove}
                        isDisabled={busy || isProtectedProjectCustomInstrument(selected)}
                      >
                        {t('studio.custom_instrument_delete')}
                      </Button>
                    </Flex>
                  </Box>
                )}
          </Box>
        </Flex>

        {warnings.length > 0 && (
          <Box mt="3" p="3" maxH="110px" overflowY="auto" bg="yellow.900" color="yellow.100" borderRadius="md">
            {warnings.slice(0, MAX_VISIBLE_WARNINGS).map(warning => (
              <Text key={warning} fontSize="xs">
                •
                {' '}
                {warning}
              </Text>
            ))}
            {warnings.length > MAX_VISIBLE_WARNINGS && (
              <Text fontSize="xs">{t('studio.custom_instrument_more_warnings', { count: warnings.length - MAX_VISIBLE_WARNINGS })}</Text>
            )}
          </Box>
        )}
        {(validationError || error) && (
          <Text mt="3" p="3" bg="red.900" color="red.100" borderRadius="md" role="alert">
            {validationError || error}
          </Text>
        )}
        {notice && !error && <Text mt="3" color="green.300" role="status">{notice}</Text>}
        <Flex mt="4" justify="flex-end" gap="2">
          <Button onClick={onClose} isDisabled={busy}>{t('studio.cancel')}</Button>
          <Button
            colorScheme="blue" isLoading={busy} isDisabled={Boolean(validationError)}
            onClick={() => { void apply() }}
          >
            {t('studio.custom_instrument_apply')}
          </Button>
        </Flex>
      </Box>
    </Box>
  )
}
