import React from 'react'
import { Box, Button, Flex, Slider, Text } from '@yamada-ui/react'
import type { MasterBus, Track } from '../types/timeline'

interface MeterValue {
  peak: number
  rms: number
}

interface Props {
  tracks: Track[]
  master: MasterBus
  trackMeters: Record<string, MeterValue>
  masterMeter: MeterValue
  onTrackChange: (id: string, patch: Partial<Omit<Track, 'id'>>) => void
  onMasterChange: (patch: Partial<MasterBus>) => void
}

const Meter: React.FC<{ value?: MeterValue }> = ({ value }) => (
  <Flex
    h="72px"
    w="12px"
    bg="gray.950"
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
  tracks, master, trackMeters, masterMeter, onTrackChange, onMasterChange,
}) => (
  <Flex
    h="190px"
    bg="gray.900"
    borderTop="1px solid"
    borderColor="gray.600"
    overflowX="auto"
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
        borderColor="gray.700"
        gap="1"
      >
        <Text fontSize="xs" w="95px" textAlign="center" whiteSpace="nowrap" overflow="hidden" textOverflow="ellipsis">{track.name}</Text>
        <Flex gap="2" align="center">
          <Meter value={trackMeters[track.id]} />
          <Box w="70px">
            <Text fontSize="9px">
              Gain
              {track.gainDb.toFixed(1)}
              {' '}
              dB
            </Text>
            <Slider
              value={track.gainDb} min={-60} max={12} step={0.5}
              onChange={gainDb => onTrackChange(track.id, { gainDb })}
              focusThumbOnChange={false}
            />
            <Text fontSize="9px">
              Pan
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
          <Button size="xs" colorScheme={track.muted ? 'red' : 'gray'} onClick={() => onTrackChange(track.id, { muted: !track.muted })}>M</Button>
          <Button size="xs" colorScheme={track.solo ? 'yellow' : 'gray'} onClick={() => onTrackChange(track.id, { solo: !track.solo })}>S</Button>
        </Flex>
      </Flex>
    ))}
    <Flex direction="column" align="center" minW="130px" p="2" gap="1" bg="gray.800">
      <Text fontSize="sm" fontWeight="bold">MASTER</Text>
      <Flex gap="2" align="center">
        <Meter value={masterMeter} />
        <Box w="80px">
          <Text fontSize="9px">
            Gain
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
