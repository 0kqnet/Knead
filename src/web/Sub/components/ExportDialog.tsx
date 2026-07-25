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

export const ExportDialog: React.FC<Props> = ({
  open, project, defaultName, soundManifest, onClose,
}) => {
  const { t } = useTranslation()
  const [options, setOptions] = useState<AudioExportOptions>(() => {
    try {
      return { ...DEFAULT_OPTIONS, ...JSON.parse(localStorage.getItem('studio.exportOptions') ?? '{}') }
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
      .map(marker => marker.soundId)
      .filter(soundId => !soundId || !(soundManifest[soundId]?.some(variant => !!variant.hash))),
  )), [project.markers, soundManifest])

  useEffect(() => () => {
    unlistenRef.current?.()
  }, [])
  useEffect(() => {
    if (options.format === 'mp3' && options.sampleRate === 96000) {
      setOptions(current => ({ ...current, sampleRate: 48000 }))
    }
  }, [options.format, options.sampleRate])

  if (!open) return null

  const update = (patch: Partial<AudioExportOptions>) => {
    setOptions((current) => {
      const next = { ...current, ...patch }
      localStorage.setItem('studio.exportOptions', JSON.stringify(next))
      return next
    })
  }
  const toggleTarget = (target: 'mix' | 'stems') => {
    const has = options.targets.includes(target)
    const next = has ? options.targets.filter(item => item !== target) : [...options.targets, target]
    if (next.length > 0) update({ targets: next })
  }
  const start = async () => {
    setProgress({ jobId: '', progress: 0, stage: '保存先を選択しています…' })
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
        soundManifest,
      })
      if (!result.ok) {
        if ('canceled' in result) setProgress(null)
        else setProgress({ jobId: '', progress: 0, stage: '失敗', error: result.error })
        return
      }
      setJobId(result.jobId)
    }
    catch (error) {
      setProgress({ jobId: '', progress: 0, stage: '失敗', error: String(error) })
    }
  }

  return (
    <Box
      position="fixed" inset="0" zIndex="2000"
      bg="rgba(0,0,0,.72)"
      display="flex" alignItems="center" justifyContent="center"
      onPointerDown={(event) => { if (event.target === event.currentTarget && !jobId) onClose() }}
    >
      <Box w="560px" maxH="90vh" overflowY="auto" bg="gray.800" borderRadius="lg" boxShadow="xl" p="5">
        <Flex align="center">
          <Text fontSize="xl" fontWeight="bold">{t('studio.audio_export')}</Text>
          <Box flex="1" />
          <Button size="sm" onClick={onClose} isDisabled={!!jobId}>×</Button>
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
              w="120px" value={options.format}
              items={[
                { label: 'WAV', value: 'wav' },
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
                Mix
              </Button>
              <Button
                colorScheme={options.targets.includes('stems') ? 'blue' : 'gray'}
                onClick={() => toggleTarget('stems')}
              >
                Stems
              </Button>
            </Flex>
          </Box>
          <Box>
            <Text fontSize="xs" mb="1">{t('studio.range')}</Text>
            <Select
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
              <Text fontSize="xs">Sample rate</Text>
              <Select
                w="120px" value={String(options.sampleRate)}
                items={[44100, 48000, ...(options.format === 'mp3' ? [] : [96000])].map(value => ({
                  label: `${value / 1000} kHz`, value: String(value),
                }))}
                onChange={sampleRate => update({ sampleRate: Number(sampleRate) as AudioExportOptions['sampleRate'] })}
              />
            </Box>
            <Box>
              <Text fontSize="xs">Channels</Text>
              <Select
                w="110px" value={String(options.channels)}
                items={[{ label: 'Mono', value: '1' }, { label: 'Stereo', value: '2' }]}
                onChange={channels => update({ channels: Number(channels) as 1 | 2 })}
              />
            </Box>
            {options.format === 'wav' && (
              <Box>
                <Text fontSize="xs">Bit depth</Text>
                <Select
                  w="120px" value={String(options.wavBitDepth)}
                  items={[16, 24, 32].map(value => ({
                    label: value === 32 ? '32-bit float' : `${value}-bit`, value: String(value),
                  }))}
                  onChange={wavBitDepth => update({ wavBitDepth: Number(wavBitDepth) as 16 | 24 | 32 })}
                />
              </Box>
            )}
            {options.format === 'ogg' && (
              <Box>
                <Text fontSize="xs">Ogg quality</Text>
                <CommitNumberInput
                  w="100px" value={options.oggQuality} min={0} max={10} step={1} precision={0}
                  onCommit={oggQuality => update({ oggQuality })}
                />
              </Box>
            )}
            {options.format === 'mp3' && (
              <Box>
                <Text fontSize="xs">MP3 bitrate</Text>
                <Select
                  w="120px" value={String(options.mp3Bitrate)}
                  items={[128, 192, 256, 320].map(value => ({ label: `${value} kbps`, value: String(value) }))}
                  onChange={mp3Bitrate => update({ mp3Bitrate: Number(mp3Bitrate) as 128 | 192 | 256 | 320 })}
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
                完了:
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
                  <Button onClick={onClose}>{t('studio.close')}</Button>
                  <Button
                    colorScheme="purple"
                    onClick={start}
                    isDisabled={missingSounds.length > 0 || options.targets.length === 0}
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
