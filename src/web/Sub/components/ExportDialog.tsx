import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Button, Flex, Select, Text } from '@yamada-ui/react'
import type {
  AudioExportOptions,
  AudioExportProgress,
  AudioExportVariant,
} from '../../../../@types/global'
import type { TimelineState } from '../types/timeline'
import { useTranslation } from 'react-i18next'
import { CommitNumberInput } from '../../components/CommitNumberInput'
import {
  compatibleSampleRatePresets,
  formatSampleRate,
  isCodecSampleRateSupported,
  isLosslessExportFormat,
  MAX_AUDIO_EXPORT_SAMPLE_RATE,
  MIN_AUDIO_EXPORT_SAMPLE_RATE,
  MP3_BITRATES,
  restoreAudioExportOptions,
  validateAudioExportOptions,
  type AudioExportValidationError,
} from '../utils/audioExport'
import { embedProjectCustomAudio } from '../utils/projectCustomAudio'
import { useModalDialog } from '../hooks/useModalDialog'

interface Props {
  open: boolean
  project: TimelineState
  defaultName: string
  soundManifest: Record<string, AudioExportVariant[]>
  onClose: () => void
}

const DEFAULT_OPTIONS: AudioExportOptions = {
  format: 'wav',
  targets: ['mix'],
  sampleRate: 48000,
  channels: 2,
  wavBitDepth: 24,
  oggQuality: 5,
  mp3Bitrate: 192,
  range: 'project',
  includeTails: true,
  includeMutedTracks: false,
}

const VALIDATION_KEYS: Record<AudioExportValidationError, string> = {
  'sample-rate-range': 'studio.audio_export_error_sample_rate_range',
  'ogg-sample-rate': 'studio.audio_export_error_ogg_sample_rate',
  'mp3-sample-rate': 'studio.audio_export_error_mp3_sample_rate',
  'mp3-bitrate': 'studio.audio_export_error_mp3_bitrate',
  'mp3-rate-bitrate': 'studio.audio_export_error_mp3_rate_bitrate',
  'channels': 'studio.audio_export_error_channels',
  'bit-depth': 'studio.audio_export_error_bit_depth',
  'ogg-quality': 'studio.audio_export_error_ogg_quality',
  'targets': 'studio.audio_export_error_targets',
  'range': 'studio.audio_export_error_range',
}

export const ExportDialog: React.FC<Props> = ({
  open, project, defaultName, soundManifest, onClose,
}) => {
  const { t } = useTranslation()
  const [options, setOptions] = useState<AudioExportOptions>(() => {
    try {
      return restoreAudioExportOptions(
        DEFAULT_OPTIONS,
        JSON.parse(localStorage.getItem('studio.exportOptions') ?? '{}'),
      )
    }
    catch {
      return DEFAULT_OPTIONS
    }
  })
  const [advanced, setAdvanced] = useState(false)
  const [progress, setProgress] = useState<AudioExportProgress | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const unlistenRef = useRef<(() => void) | null>(null)

  const missingSounds = useMemo(() => Array.from(new Set(
    project.markers
      .filter(marker => marker.action?.type !== 'sound-stop')
      .map(marker => marker.soundId)
      .filter(soundId => !soundId || !(soundManifest[soundId]?.some(variant => !!variant.hash))),
  )), [project.markers, soundManifest])

  useEffect(() => () => {
    unlistenRef.current?.()
  }, [])
  const validationError = useMemo(() => validateAudioExportOptions(options), [options])
  const sampleRatePresets = useMemo(() => compatibleSampleRatePresets(options), [options])
  const exportBusy = !!jobId || (!!progress && !progress.done && !progress.error && !progress.canceled)
  const { dialogRef } = useModalDialog({ open, busy: exportBusy, onClose })

  if (!open) return null

  const update = (patch: Partial<AudioExportOptions>) => {
    setOptions((current) => {
      const next = { ...current, ...patch }
      if ((patch.format !== undefined || patch.mp3Bitrate !== undefined)
        && !isCodecSampleRateSupported(next.format, next.sampleRate, next.mp3Bitrate)) {
        const presets = compatibleSampleRatePresets(next)
        next.sampleRate = presets.includes(48_000) ? 48_000 : (presets[0] ?? 48_000)
      }
      try {
        localStorage.setItem('studio.exportOptions', JSON.stringify(next))
      }
      catch { /* Preferences are optional in storage-restricted previews. */ }
      return next
    })
  }
  const toggleTarget = (target: 'mix' | 'stems') => {
    const has = options.targets.includes(target)
    const next = has ? options.targets.filter(item => item !== target) : [...options.targets, target]
    if (next.length > 0) update({ targets: next })
  }
  const start = async () => {
    if (validationError) return
    setProgress({ jobId: '', progress: 0, stage: t('studio.audio_export_selecting_destination') })
    unlistenRef.current?.()
    unlistenRef.current = await window.myAPI.audioExport.onProgress((next) => {
      setProgress(next)
      if (next.done || next.error || next.canceled) setJobId(null)
    })
    try {
      const result = await window.myAPI.audioExport.start({
        defaultName,
        options,
        project,
        soundManifest: embedProjectCustomAudio(soundManifest),
      })
      if (!result.ok) {
        if ('canceled' in result) setProgress(null)
        else setProgress({ jobId: '', progress: 0, stage: t('studio.audio_export_failed'), error: result.error })
        return
      }
      setJobId(result.jobId)
    }
    catch (error) {
      setProgress({ jobId: '', progress: 0, stage: t('studio.audio_export_failed'), error: String(error) })
    }
  }

  return (
    <Box
      position="fixed" inset="0" zIndex="2000"
      bg="rgba(0,0,0,.72)"
      display="flex" alignItems="center" justifyContent="center"
      onPointerDown={(event) => { if (event.target === event.currentTarget && !exportBusy) onClose() }}
    >
      <Box
        ref={dialogRef} role="dialog" aria-modal="true" aria-label={t('studio.audio_export')} tabIndex={-1}
        w="560px" maxH="90vh" overflowY="auto" bg="gray.800" borderRadius="lg" boxShadow="xl" p="5"
      >
        <Flex align="center">
          <Text fontSize="xl" fontWeight="bold">{t('studio.audio_export')}</Text>
          <Box flex="1" />
          <Button size="sm" onClick={onClose} isDisabled={exportBusy}>×</Button>
        </Flex>
        <Text fontSize="sm" color="gray.400" mt="1">{defaultName}</Text>

        {missingSounds.length > 0 && (
          <Box mt="4" p="3" bg="red.900" border="1px solid" borderColor="red.500" borderRadius="md">
            <Text fontSize="sm">
              {t('studio.missing_sounds')}
              :
            </Text>
            <Text fontSize="xs">{missingSounds.map(value => value || '(未指定)').join(', ')}</Text>
          </Box>
        )}

        <Flex mt="4" gap="3" align="end" wrap="wrap">
          <Box>
            <Text fontSize="xs" mb="1">{t('studio.format')}</Text>
            <Select
              data-dialog-initial-focus
              aria-label={t('studio.format')}
              w="120px" value={options.format}
              items={[
                { label: 'WAV', value: 'wav' },
                { label: 'AIFF', value: 'aiff' },
                { label: 'FLAC', value: 'flac' },
                { label: 'Ogg Vorbis', value: 'ogg' },
                { label: 'MP3', value: 'mp3' },
              ]}
              onChange={format => update({ format: format as AudioExportOptions['format'] })}
            />
          </Box>
          <Box>
            <Text fontSize="xs" mb="1">{t('studio.output')}</Text>
            <Flex gap="1">
              <Button
                colorScheme={options.targets.includes('mix') ? 'blue' : 'gray'}
                onClick={() => toggleTarget('mix')}
              >
                {t('studio.audio_export_mix')}
              </Button>
              <Button
                colorScheme={options.targets.includes('stems') ? 'blue' : 'gray'}
                onClick={() => toggleTarget('stems')}
              >
                {t('studio.audio_export_stems')}
              </Button>
            </Flex>
          </Box>
          <Box>
            <Text fontSize="xs" mb="1">{t('studio.range')}</Text>
            <Select
              aria-label={t('studio.range')}
              w="140px" value={options.range}
              items={[
                { label: t('studio.project_range'), value: 'project' },
                { label: t('studio.loop_range'), value: 'loop' },
              ]}
              onChange={range => update({ range: range as AudioExportOptions['range'] })}
            />
          </Box>
        </Flex>

        <Button mt="4" size="sm" variant="ghost" onClick={() => setAdvanced(value => !value)}>
          {advanced ? `▾ ${t('studio.advanced')}` : `▸ ${t('studio.advanced')}`}
        </Button>
        {advanced && (
          <Flex mt="2" gap="4" wrap="wrap" p="3" bg="gray.900" borderRadius="md">
            <Box>
              <Text fontSize="xs">{t('studio.audio_export_sample_rate')}</Text>
              <Flex gap="2" align="center">
                <Select
                  aria-label={t('studio.audio_export_sample_rate_preset')}
                  w="150px"
                  value={sampleRatePresets.includes(options.sampleRate) ? String(options.sampleRate) : 'custom'}
                  items={[
                    ...sampleRatePresets.map(value => ({
                      label: formatSampleRate(value), value: String(value),
                    })),
                    { label: t('studio.audio_export_custom_rate'), value: 'custom' },
                  ]}
                  onChange={(sampleRate) => {
                    if (sampleRate !== 'custom') update({ sampleRate: Number(sampleRate) })
                  }}
                />
                <CommitNumberInput
                  aria-label={t('studio.audio_export_sample_rate_hz')}
                  w="130px"
                  value={options.sampleRate}
                  min={MIN_AUDIO_EXPORT_SAMPLE_RATE}
                  max={MAX_AUDIO_EXPORT_SAMPLE_RATE}
                  step={1}
                  precision={0}
                  onCommit={sampleRate => update({ sampleRate })}
                />
                <Text fontSize="xs" color="gray.400">Hz</Text>
              </Flex>
            </Box>
            <Box>
              <Text fontSize="xs">{t('studio.audio_export_channels')}</Text>
              <Select
                aria-label={t('studio.audio_export_channels')}
                w="110px" value={String(options.channels)}
                items={[
                  { label: t('studio.audio_export_mono'), value: '1' },
                  { label: t('studio.audio_export_stereo'), value: '2' },
                ]}
                onChange={channels => update({ channels: Number(channels) as 1 | 2 })}
              />
            </Box>
            {isLosslessExportFormat(options.format) && (
              <Box>
                <Text fontSize="xs">{t('studio.audio_export_bit_depth')}</Text>
                <Select
                  aria-label={t('studio.audio_export_bit_depth')}
                  w="120px" value={String(options.wavBitDepth)}
                  items={[16, 24, 32].map(value => ({
                    label: value === 32 && options.format === 'wav'
                      ? t('studio.audio_export_32_bit_float')
                      : t('studio.audio_export_integer_bit', { bits: value }),
                    value: String(value),
                  }))}
                  onChange={wavBitDepth => update({ wavBitDepth: Number(wavBitDepth) as 16 | 24 | 32 })}
                />
              </Box>
            )}
            {options.format === 'ogg' && (
              <Box>
                <Text fontSize="xs">{t('studio.audio_export_ogg_quality')}</Text>
                <CommitNumberInput
                  aria-label={t('studio.audio_export_ogg_quality')}
                  w="100px" value={options.oggQuality} min={0} max={10} step={1} precision={0}
                  onCommit={oggQuality => update({ oggQuality })}
                />
              </Box>
            )}
            {options.format === 'mp3' && (
              <Box>
                <Text fontSize="xs">{t('studio.audio_export_mp3_bitrate')}</Text>
                <Select
                  aria-label={t('studio.audio_export_mp3_bitrate')}
                  w="120px" value={String(options.mp3Bitrate)}
                  items={MP3_BITRATES.map(value => ({ label: `${value} kbps`, value: String(value) }))}
                  onChange={mp3Bitrate => update({
                    mp3Bitrate: Number(mp3Bitrate) as AudioExportOptions['mp3Bitrate'],
                  })}
                />
              </Box>
            )}
            <Button
              size="sm"
              colorScheme={options.includeTails ? 'blue' : 'gray'}
              onClick={() => update({ includeTails: !options.includeTails })}
            >
              {t('studio.include_tails')}
            </Button>
            <Button
              size="sm"
              colorScheme={options.includeMutedTracks ? 'blue' : 'gray'}
              onClick={() => update({ includeMutedTracks: !options.includeMutedTracks })}
            >
              {t('studio.include_muted')}
            </Button>
          </Flex>
        )}

        {validationError && (
          <Text role="alert" mt="3" color="red.300" fontSize="sm">
            {t(VALIDATION_KEYS[validationError], {
              min: MIN_AUDIO_EXPORT_SAMPLE_RATE,
              max: MAX_AUDIO_EXPORT_SAMPLE_RATE,
            })}
          </Text>
        )}

        {progress && (
          <Box mt="4">
            <Flex>
              <Text fontSize="sm">{progress.stage}</Text>
              <Box flex="1" />
              <Text fontSize="sm">
                {Math.round(progress.progress * 100)}
                %
              </Text>
            </Flex>
            <Box mt="1" h="8px" bg="gray.950" borderRadius="full" overflow="hidden">
              <Box h="100%" w={`${Math.max(0, Math.min(100, progress.progress * 100))}%`} bg="blue.400" />
            </Box>
            {progress.currentTrack && <Text fontSize="xs" color="gray.400">{progress.currentTrack}</Text>}
            {progress.error && <Text color="red.300" fontSize="sm" mt="2">{progress.error}</Text>}
            {progress.done && (
              <Text color="green.300" fontSize="sm" mt="2">
                {t('studio.audio_export_complete')}
                :
                {' '}
                {progress.outputPaths?.join(', ')}
              </Text>
            )}
          </Box>
        )}

        <Flex mt="5" justify="flex-end" gap="2">
          {jobId
            ? (
                <Button colorScheme="red" onClick={() => window.myAPI.audioExport.cancel(jobId)}>{t('studio.cancel')}</Button>
              )
            : (
                <>
                  <Button onClick={onClose} isDisabled={exportBusy}>{t('studio.close')}</Button>
                  <Button
                    colorScheme="purple"
                    onClick={start}
                    isDisabled={missingSounds.length > 0 || !!validationError || exportBusy}
                  >
                    {t('studio.export_start')}
                  </Button>
                </>
              )}
        </Flex>
      </Box>
    </Box>
  )
}
