import React, { useState } from 'react'
import { Box, Button, Flex, Select, Text } from '@yamada-ui/react'
import { useTranslation } from 'react-i18next'
import { StudioDialogClose } from './StudioDialogClose'
import type { TimelineState } from '../types/timeline'
import {
  nbsToTimelineState,
  parseNbs,
  isSoundStopperInstrument,
  timelineStateToNbs,
  writeNbsWithWarnings,
  type NbsTargetVersion,
  type NbsInstrument,
} from '../utils/nbs'
import {
  nbsBundleSoundId,
  parseNbsBundle,
  writeNbsBundleWithWarnings,
  type NbsBundleAudioInput,
  type NbsBundleInstrumentAudio,
} from '../utils/nbsBundle'
import {
  clearProjectCustomAudio,
  getProjectCustomAudioData,
  prepareProjectCustomAudio,
  restoreProjectCustomAudio,
} from '../utils/projectCustomAudio'
import { useModalDialog } from '../hooks/useModalDialog'

interface SoundVariant {
  path: string
  hash: string
  pitch: number
}

interface Props {
  open: boolean
  project: TimelineState
  defaultName: string
  targetVersion: string
  soundManifest?: Record<string, SoundVariant[]>
  onImport: (state: TimelineState, warnings: string[], sourcePath: string) => Promise<boolean>
  onClose: () => void
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function encodeBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

function uniqueWarnings(...groups: readonly string[][]): string[] {
  return Array.from(new Set(groups.flat()))
}

function bundleConversionWarnings(
  converted: string[],
  audio: readonly NbsBundleInstrumentAudio[],
  customInstrumentBase: number,
  customInstruments: readonly NbsInstrument[],
  notes: readonly { instrument: number }[],
): string[] {
  const matched = new Set(audio.map(item => item.instrumentId))
  const missingNotes = notes.filter((note) => {
    if (note.instrument < customInstrumentBase || matched.has(note.instrument)) return false
    return !isSoundStopperInstrument(customInstruments[note.instrument - customInstrumentBase])
  }).length
  const withoutGeneric = converted.filter(warning => !/custom-instrument note\(s\) need matching sounds/u.test(warning))
  if (missingNotes) withoutGeneric.push(`${missingNotes} custom-instrument note(s) have no matched bundled audio.`)
  return withoutGeneric
}

function soundCandidates(instrument: NbsInstrument, instrumentId: number): string[] {
  const baseName = instrument.file.replace(/\\/gu, '/').split('/').pop()?.replace(/\.[^.]+$/u, '') ?? ''
  return Array.from(new Set([
    nbsBundleSoundId(instrument, instrumentId),
    instrument.name,
    ...(baseName ? [`block.note_block.${baseName}`] : []),
  ].filter(Boolean)))
}

function authoredSoundCandidates(project: TimelineState, instrument: NbsInstrument): string[] {
  const outputFile = instrument.file.replace(/\\/gu, '/')
  const outputBaseName = outputFile.split('/').at(-1) ?? outputFile
  return (project.customInstruments ?? [])
    .filter(candidate => (
      candidate.kind === 'audio'
      && candidate.name === instrument.name
      && candidate.key === instrument.key
      && candidate.pressKey === instrument.pressKey
      && (
        candidate.file.replace(/\\/gu, '/') === outputFile
        || candidate.file.replace(/\\/gu, '/').split('/').at(-1) === outputBaseName
      )
    ))
    .map(candidate => candidate.soundId)
}

export const NbsDialog: React.FC<Props> = ({
  open, project, defaultName, targetVersion, soundManifest = {}, onImport, onClose,
}) => {
  const { t } = useTranslation()
  const [nbsVersion, setNbsVersion] = useState<NbsTargetVersion>(5)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [warnings, setWarnings] = useState<string[]>([])
  const { dialogRef } = useModalDialog({ open, busy, onClose })

  if (!open) return null

  const importNbs = async () => {
    setBusy(true)
    setMessage('')
    setWarnings([])
    try {
      const result = await window.myAPI.nbs.open()
      if (!result.ok) {
        if (!('canceled' in result)) setMessage(t('studio.nbs_error', { error: result.error }))
        return
      }
      const bytes = decodeBase64(result.dataBase64)
      const parsed = parseNbs(bytes.buffer as ArrayBuffer)
      if (!parsed.ok) {
        setMessage(t('studio.nbs_error', { error: parsed.error }))
        return
      }
      const converted = nbsToTimelineState(parsed.song, targetVersion)
      converted.state.customAudio = []
      const details = [
        `NBS v${parsed.song.header.version}`,
        `${parsed.song.notes.length} notes`,
        `${parsed.song.layers.length} layers`,
        `${(parsed.song.header.tempo / 100).toFixed(2)} TPS`,
      ]
      if (await onImport(converted.state, converted.warnings, result.path)) {
        clearProjectCustomAudio()
        setMessage(t('studio.nbs_imported', { details: details.join(' · ') }))
        setWarnings(converted.warnings)
        onClose()
      }
    }
    catch (error) {
      setMessage(t('studio.nbs_error', { error: String(error) }))
    }
    finally {
      setBusy(false)
    }
  }

  const importBundle = async () => {
    setBusy(true)
    setMessage('')
    setWarnings([])
    try {
      const result = await window.myAPI.nbs.openBundle()
      if (!result.ok) {
        if (!('canceled' in result)) setMessage(t('studio.nbs_error', { error: result.error }))
        return
      }
      const bundle = await parseNbsBundle(decodeBase64(result.dataBase64))
      if (!bundle.ok) {
        setMessage(t('studio.nbs_error', { error: bundle.error }))
        return
      }
      const converted = nbsToTimelineState(bundle.song, targetVersion)
      const prepared = await prepareProjectCustomAudio(bundle.audio)
      converted.state.customAudio = prepared.assets
      const conversionWarnings = bundleConversionWarnings(
        converted.warnings,
        bundle.audio,
        bundle.song.header.vanillaInstrumentCount,
        bundle.song.customInstruments,
        bundle.song.notes,
      )
      const allWarnings = uniqueWarnings(bundle.warnings, conversionWarnings, prepared.warnings)
      const details = [
        `NBS v${bundle.song.header.version}`,
        `${bundle.song.notes.length} notes`,
        `${bundle.song.layers.length} layers`,
        `${bundle.audio.length} bundled samples`,
      ]
      if (await onImport(converted.state, allWarnings, result.path)) {
        await restoreProjectCustomAudio(prepared.assets)
        setMessage(t('studio.nbs_bundle_imported', { details: details.join(' · ') }))
        setWarnings(allWarnings)
        onClose()
      }
    }
    catch (error) {
      setMessage(t('studio.nbs_error', { error: String(error) }))
    }
    finally {
      setBusy(false)
    }
  }

  const exportNbs = async () => {
    setBusy(true)
    setMessage('')
    setWarnings([])
    try {
      const converted = timelineStateToNbs(project, defaultName, nbsVersion)
      const encoded = writeNbsWithWarnings(converted.song, nbsVersion)
      const allWarnings = Array.from(new Set([...converted.warnings, ...encoded.warnings]))
      const result = await window.myAPI.nbs.save(`${defaultName}.nbs`, encodeBase64(encoded.data))
      setWarnings(allWarnings)
      if (!result.ok) {
        if (!('canceled' in result)) setMessage(t('studio.nbs_error', { error: result.error }))
        return
      }
      setMessage(t('studio.nbs_exported', { path: result.path }))
    }
    catch (error) {
      setMessage(t('studio.nbs_error', { error: String(error) }))
    }
    finally {
      setBusy(false)
    }
  }

  const collectBundleAudio = async (
    instruments: readonly NbsInstrument[],
    vanillaInstrumentCount: number,
  ): Promise<{ files: NbsBundleAudioInput[], warnings: string[] }> => {
    const files: NbsBundleAudioInput[] = []
    const warnings: string[] = []
    const usedFiles = new Set<string>()
    for (let index = 0; index < instruments.length; index++) {
      const instrument = instruments[index]
      const fileKey = instrument.file.replace(/\\/gu, '/').normalize('NFKC').toLocaleLowerCase('en-US')
      if (!fileKey || usedFiles.has(fileKey)) continue
      const candidates = Array.from(new Set([
        ...authoredSoundCandidates(project, instrument),
        ...soundCandidates(instrument, vanillaInstrumentCount + index),
      ]))
      const match = candidates
        .map(soundId => ({ soundId, variants: soundManifest[soundId] ?? [] }))
        .find(candidate => candidate.variants.some(variant => !!variant.hash))
      if (!match) continue
      if (match.variants.length > 1) {
        warnings.push(`Custom instrument ${index + 1} used the first sound variant: ${match.soundId}.`)
      }
      const variant = match.variants.find(item => !!item.hash)
      if (!variant) continue
      const customData = getProjectCustomAudioData(variant.hash)
      const data = customData ?? await window.myAPI.get_mcSoundData(variant.hash)
      if (!data.byteLength) continue
      usedFiles.add(fileKey)
      files.push({ file: instrument.file, data: new Uint8Array(data) })
    }
    return { files, warnings }
  }

  const exportBundle = async () => {
    setBusy(true)
    setMessage('')
    setWarnings([])
    try {
      const converted = timelineStateToNbs(project, defaultName, nbsVersion)
      const encoded = writeNbsWithWarnings(converted.song, nbsVersion)
      const actual = parseNbs(encoded.data.buffer.slice(
        encoded.data.byteOffset,
        encoded.data.byteOffset + encoded.data.byteLength,
      ) as ArrayBuffer)
      if (!actual.ok) throw new Error(`Internal NBS bundle error: ${actual.error}`)
      const collected = await collectBundleAudio(
        actual.song.customInstruments,
        actual.song.header.vanillaInstrumentCount,
      )
      const bundle = writeNbsBundleWithWarnings(encoded.data, collected.files)
      const conversionWarnings = converted.warnings.filter(warning => !/audio files are not bundled/u.test(warning))
      const allWarnings = uniqueWarnings(
        conversionWarnings,
        encoded.warnings,
        collected.warnings,
        bundle.warnings,
      )
      const result = await window.myAPI.nbs.saveBundle(`${defaultName}.zip`, encodeBase64(bundle.data))
      setWarnings(allWarnings)
      if (!result.ok) {
        if (!('canceled' in result)) setMessage(t('studio.nbs_error', { error: result.error }))
        return
      }
      setMessage(t('studio.nbs_bundle_exported', { path: result.path, count: bundle.includedAudioCount }))
    }
    catch (error) {
      setMessage(t('studio.nbs_error', { error: String(error) }))
    }
    finally {
      setBusy(false)
    }
  }

  return (
    <Box
      position="fixed" inset="0" zIndex="2120" bg="var(--knead-scrim)"
      display="flex" alignItems="center" justifyContent="center"
      onPointerDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}
    >
      <Box
        ref={dialogRef} role="dialog" aria-modal="true" aria-label={t('studio.nbs_compatibility')} tabIndex={-1}
        w="640px" maxW="calc(100vw - 32px)" bg="var(--studio-panel)" borderRadius="lg" boxShadow="xl" p="5"
      >
        <Flex align="start" gap="3">
          <Box>
            <Text fontSize="xl" fontWeight="bold">{t('studio.nbs_compatibility')}</Text>
            <Text fontSize="sm" color="var(--studio-muted)">{t('studio.nbs_description')}</Text>
          </Box>
          <Box flex="1" />
          <StudioDialogClose onClick={onClose} disabled={busy} />
        </Flex>

        {project.source?.format === 'nbs' && (
          <Text mt="3" fontSize="xs" color="var(--studio-accent-text)">
            {`Source: NBS v${project.source.sourceVersion} · ${project.source.name || 'Untitled'} · ${project.source.customInstruments.length} custom · loop ${project.source.loop ? (project.source.maxLoopCount || '∞') : 'off'}`}
          </Text>
        )}

        <Flex mt="5" gap="3">
          <Box flex="1" p="4" bg="var(--studio-frame)" borderRadius="md" border="1px solid" borderColor="var(--studio-line)">
            <Text fontWeight="bold">{t('studio.nbs_import')}</Text>
            <Text mt="1" minH="42px" fontSize="xs" color="var(--studio-muted)">{t('studio.nbs_import_hint')}</Text>
            <Button data-dialog-initial-focus mt="3" w="full" colorScheme="purple" onClick={importNbs} loading={busy}>
              {t('studio.nbs_choose_file')}
            </Button>
            <Button mt="2" w="full" variant="surface" colorScheme="purple" onClick={importBundle} loading={busy}>
              {t('studio.nbs_choose_bundle')}
            </Button>
          </Box>
          <Box flex="1" p="4" bg="var(--studio-frame)" borderRadius="md" border="1px solid" borderColor="var(--studio-line)">
            <Text fontWeight="bold">{t('studio.nbs_export')}</Text>
            <Text mt="1" fontSize="xs" color="var(--studio-muted)">{t('studio.nbs_export_hint')}</Text>
            <Select.Root
              rootProps={{ mt: '2' }} value={String(nbsVersion)}
              items={[
                { label: 'NBS v6 (beta)', value: '6' },
                { label: 'NBS v5 (stable)', value: '5' },
                { label: 'NBS v4', value: '4' },
                { label: 'NBS v3', value: '3' },
                { label: 'NBS v2', value: '2' },
                { label: 'NBS v1', value: '1' },
                { label: 'NBS v0 (Classic)', value: '0' },
              ]}
              onChange={value => setNbsVersion(Number(value) as NbsTargetVersion)}
            />
            <Button mt="2" w="full" colorScheme="purple" onClick={exportNbs} loading={busy}>
              {t('studio.nbs_export_button')}
            </Button>
            <Button mt="2" w="full" variant="surface" colorScheme="purple" onClick={exportBundle} loading={busy}>
              {t('studio.nbs_export_bundle_button')}
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
        {message && <Text mt="4" fontSize="sm" color={message.includes('Error') || message.includes('エラー') ? 'var(--studio-error)' : 'var(--studio-success)'}>{message}</Text>}
        <Flex mt="5" justify="flex-end">
          <Button onClick={onClose} disabled={busy}>{t('studio.close')}</Button>
        </Flex>
      </Box>
    </Box>
  )
}
