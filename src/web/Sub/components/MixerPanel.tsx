import React from 'react'
import { Box, Button, Flex, Slider, Text } from '@yamada-ui/react'
import { useTranslation } from 'react-i18next'
import type { MasterBus, ReferenceAudioTrack, Track } from '../types/timeline'

interface MeterValue {
  peak: number
  rms: number
}

interface Props {
  tracks: Track[]
  referenceAudio?: ReferenceAudioTrack[]
  master: MasterBus
  trackMeters: Record<string, MeterValue>
  referenceAudioMeters?: Record<string, MeterValue>
  masterMeter: MeterValue
  onTrackChange: (id: string, patch: Partial<Omit<Track, 'id'>>) => void
  onReferenceAudioChange?: (id: string, patch: Partial<ReferenceAudioTrack>) => void
  onMasterChange: (patch: Partial<MasterBus>) => void
}

const Meter: React.FC<{ value?: MeterValue }> = ({ value }) => (
  <Flex
    h="64px"
    w="12px"
    bg="var(--studio-canvas)"
    borderRadius="full"
    overflow="hidden"
    alignItems="flex-end"
    title={`Peak ${((value?.peak ?? 0) * 100).toFixed(0)}% / RMS ${((value?.rms ?? 0) * 100).toFixed(0)}%`}
  >
    <Box
      w="50%"
      h={`${Math.min(100, (value?.peak ?? 0) * 100)}%`}
      bg={(value?.peak ?? 0) > 0.9 ? 'red.400' : 'green.400'}
    />
    <Box
      w="50%"
      h={`${Math.min(100, (value?.rms ?? 0) * 100)}%`}
      bg="blue.400"
    />
  </Flex>
)

export const MixerPanel: React.FC<Props> = ({
  tracks,
  referenceAudio = [],
  master,
  trackMeters,
  referenceAudioMeters = {},
  masterMeter,
  onTrackChange,
  onReferenceAudioChange,
  onMasterChange,
}) => {
  const { t } = useTranslation()
  return (
    <Flex
      role="region"
      aria-label={t('studio.mixer')}
      flex="0 0 auto"
      maxH="min(150px, 25vh)"
      bg="var(--studio-panel)"
      borderTop="1px solid"
      borderColor="var(--studio-line)"
      overflow="auto"
      align="stretch"
    >
      {tracks.map(track => (
        <Flex
          key={track.id}
          direction="column"
          align="center"
          minW="112px"
          p="2"
          borderRight="1px solid"
          borderColor="var(--studio-line)"
          gap="1"
        >
          <Text fontSize="xs" w="95px" flexShrink="0" textAlign="center" whiteSpace="nowrap" overflow="hidden" textOverflow="ellipsis">{track.name}</Text>
          <Flex gap="2" align="center">
            <Meter value={trackMeters[track.id]} />
            <Box w="70px">
              <Text fontSize="xs" color="var(--studio-muted)">
                {t('studio.mixer_gain')}
                {' '}
                {track.gainDb.toFixed(1)}
                {' '}
                dB
              </Text>
              <Slider
                value={track.gainDb} min={-60} max={12} step={0.5}
                onChange={gainDb => onTrackChange(track.id, { gainDb })}
                focusThumbOnChange={false}
              />
              <Text fontSize="xs" color="var(--studio-muted)">
                {t('studio.mixer_pan')}
                {' '}
                {track.pan.toFixed(2)}
              </Text>
              <Slider
                value={track.pan} min={-1} max={1} step={0.01}
                onChange={pan => onTrackChange(track.id, { pan })}
                focusThumbOnChange={false}
              />
            </Box>
          </Flex>
          <Flex gap="1">
            <Button size="xs" aria-label={`${t('studio.track_mute')}: ${track.name}`} aria-pressed={track.muted} colorScheme={track.muted ? 'red' : 'gray'} onClick={() => onTrackChange(track.id, { muted: !track.muted })}>M</Button>
            <Button size="xs" aria-label={`${t('studio.track_solo')}: ${track.name}`} aria-pressed={track.solo} colorScheme={track.solo ? 'yellow' : 'gray'} onClick={() => onTrackChange(track.id, { solo: !track.solo })}>S</Button>
          </Flex>
        </Flex>
      ))}
      {referenceAudio.map(track => (
        <Flex
          key={track.id}
          direction="column"
          align="center"
          minW="112px"
          p="2"
          borderRight="1px solid"
          borderColor="var(--studio-line)"
          gap="1"
          bg="var(--studio-frame)"
        >
          <Text fontSize="xs" color="var(--studio-muted)">{t('studio.mixer_reference')}</Text>
          <Text fontSize="xs" w="95px" flexShrink="0" textAlign="center" whiteSpace="nowrap" overflow="hidden" textOverflow="ellipsis">
            {track.name}
          </Text>
          <Flex gap="2" align="center">
            <Meter value={referenceAudioMeters[track.id]} />
            <Box w="70px">
              <Text fontSize="xs" color="var(--studio-muted)">
                {t('studio.mixer_gain')}
                {' '}
                {track.gainDb.toFixed(1)}
                {' '}
                dB
              </Text>
              <Slider
                aria-label={`${track.name} reference gain`}
                value={track.gainDb}
                min={-60}
                max={12}
                step={0.5}
                onChange={gainDb => onReferenceAudioChange?.(track.id, { gainDb })}
                focusThumbOnChange={false}
              />
              <Text fontSize="xs" color="var(--studio-muted)">
                {t('studio.mixer_pan')}
                {' '}
                {track.pan.toFixed(2)}
              </Text>
              <Slider
                aria-label={`${track.name} reference pan`}
                value={track.pan}
                min={-1}
                max={1}
                step={0.01}
                onChange={pan => onReferenceAudioChange?.(track.id, { pan })}
                focusThumbOnChange={false}
              />
            </Box>
          </Flex>
          <Flex gap="1">
            <Button size="xs" aria-label={`${t('studio.track_mute')}: ${track.name}`} aria-pressed={track.muted} colorScheme={track.muted ? 'red' : 'gray'} onClick={() => onReferenceAudioChange?.(track.id, { muted: !track.muted })}>M</Button>
            <Button size="xs" aria-label={`${t('studio.track_solo')}: ${track.name}`} aria-pressed={track.solo} colorScheme={track.solo ? 'yellow' : 'gray'} onClick={() => onReferenceAudioChange?.(track.id, { solo: !track.solo })}>S</Button>
          </Flex>
        </Flex>
      ))}
      <Flex direction="column" align="center" minW="130px" p="2" gap="1" bg="var(--studio-raised)">
        <Text fontSize="sm" fontWeight="bold">{t('studio.mixer_master')}</Text>
        <Flex gap="2" align="center">
          <Meter value={masterMeter} />
          <Box w="80px">
            <Text fontSize="xs" color="var(--studio-muted)">
              {t('studio.mixer_gain')}
              {' '}
              {master.gainDb.toFixed(1)}
              {' '}
              dB
            </Text>
            <Slider
              value={master.gainDb} min={-60} max={12} step={0.5}
              onChange={gainDb => onMasterChange({ gainDb })}
              focusThumbOnChange={false}
            />
            <Button
              mt="2" size="xs"
              aria-pressed={master.limiterEnabled}
              colorScheme={master.limiterEnabled ? 'blue' : 'gray'}
              onClick={() => onMasterChange({ limiterEnabled: !master.limiterEnabled })}
            >
              LIMIT −1dB
            </Button>
          </Box>
        </Flex>
      </Flex>
    </Flex>
  )
}
