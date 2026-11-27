import React from 'react'
import {
  Box, Button, ChevronDownIcon, ChevronRightIcon, CopyIcon, Flex, IconButton, Input, LockIcon,
  LockOpenIcon, Slider, Text, TrashIcon,
} from '@yamada-ui/react'
import { useTranslation } from 'react-i18next'
import { usePlaybackMeter, type PlaybackStatusStore } from '../hooks/useTimelinePlayback'
import {
  TRACK_COLORS,
  TRACK_HEIGHT,
  TRACK_HEIGHT_COLLAPSED,
  type Track,
} from '../types/timeline'

interface Props {
  track: Track
  index: number
  selected: boolean
  playbackStatus: PlaybackStatusStore
  canDelete: boolean
  onSelect: (id: string) => void
  onChange: (id: string, patch: Partial<Omit<Track, 'id'>>) => void
  onDuplicate: (id: string) => void
  onDelete: (id: string) => void
  onMove: (draggedId: string, toIndex: number) => void
}

const COLOR_HEX: Record<Track['color'], string> = {
  blue: '#3b82f6', cyan: '#06b6d4', green: '#22c55e', yellow: '#eab308',
  orange: '#f97316', red: '#ef4444', pink: '#ec4899', purple: '#a855f7',
}

function TrackMeter({ status, trackId }: { status: PlaybackStatusStore, trackId: string }) {
  const meter = usePlaybackMeter(status, 'track', trackId)
  const peak = (meter?.peak ?? 0) * 100
  const rms = (meter?.rms ?? 0) * 100
  return (
    <Box
      flex="1"
      h="5px"
      bg="var(--studio-canvas)"
      borderRadius="full"
      overflow="hidden"
      position="relative"
      title={`Peak ${peak.toFixed(0)}% / RMS ${rms.toFixed(0)}%`}
    >
      <Box h="100%" w={`${Math.min(100, peak)}%`} bg={peak > 90 ? 'red.400' : 'green.400'} />
      <Box
        position="absolute"
        left={`${Math.min(100, rms)}%`}
        top="0"
        h="100%"
        w="2px"
        bg="blue.200"
      />
    </Box>
  )
}

export const TrackHeader = React.memo(function TrackHeader({
  track, index, selected, playbackStatus, canDelete, onSelect, onChange, onDuplicate, onDelete, onMove,
}: Props) {
  const { t } = useTranslation()
  const collapseLabel = t(track.collapsed ? 'studio.track_expand' : 'studio.track_collapse')
  const height = track.collapsed ? TRACK_HEIGHT_COLLAPSED : TRACK_HEIGHT
  return (
    <Box
      className="studio-track-header"
      data-track-header-id={track.id}
      draggable
      h={`${height}px`}
      bg={selected ? 'var(--studio-accent-soft)' : 'var(--studio-panel)'}
      boxShadow={selected ? 'inset 2px 0 var(--studio-accent)' : undefined}
      borderBottom="1px solid"
      borderRight="1px solid"
      borderColor="var(--studio-line)"
      overflow="hidden"
      onClick={() => onSelect(track.id)}
      onDragStart={event => event.dataTransfer.setData('application/x-knead-track', track.id)}
      onDragOver={event => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault()
        const dragged = event.dataTransfer.getData('application/x-knead-track')
        if (dragged) onMove(dragged, index)
      }}
    >
      <Flex align="center" gap="1">
        <IconButton
          size="xs"
          variant="ghost"
          minW="21px"
          p="0"
          icon={<Box as="span" w="9px" h="16px" borderRadius="sm" bg={COLOR_HEX[track.color]} />}
          aria-label={t('studio.track_color')}
          title={t('studio.track_color')}
          onClick={(event) => {
            event.stopPropagation()
            const index = TRACK_COLORS.indexOf(track.color)
            onChange(track.id, { color: TRACK_COLORS[(index + 1) % TRACK_COLORS.length] })
          }}
        />
        <Input
          size="xs"
          value={track.name}
          fontSize="xs"
          h="24px"
          onClick={event => event.stopPropagation()}
          onChange={event => onChange(track.id, { name: event.target.value })}
          aria-label={t('studio.track_name')}
        />
        <IconButton
          size="xs" variant="ghost" minW="24px" p="0"
          icon={track.collapsed ? <ChevronRightIcon boxSize="3.5" /> : <ChevronDownIcon boxSize="3.5" />}
          aria-label={collapseLabel}
          aria-expanded={!track.collapsed}
          title={collapseLabel}
          onClick={(event) => {
            event.stopPropagation()
            onChange(track.id, { collapsed: !track.collapsed })
          }}
        />
      </Flex>
      {!track.collapsed && (
        <Flex align="center" gap="1">
          <Button
            size="xs" minW="26px" p="0"
            variant={track.muted ? 'solid' : 'outline'}
            colorScheme={track.muted ? 'red' : 'gray'}
            onClick={(event) => {
              event.stopPropagation()
              onChange(track.id, { muted: !track.muted })
            }}
            aria-label={t('studio.track_mute')}
            aria-pressed={track.muted}
            title={t('studio.track_mute')}
          >
            M
          </Button>
          <Button
            size="xs" minW="26px" p="0"
            variant={track.solo ? 'solid' : 'outline'}
            colorScheme={track.solo ? 'yellow' : 'gray'}
            onClick={(event) => {
              event.stopPropagation()
              onChange(track.id, { solo: !track.solo })
            }}
            aria-label={t('studio.track_solo')}
            aria-pressed={track.solo}
            title={t('studio.track_solo')}
          >
            S
          </Button>
          <IconButton
            size="xs" minW="26px" p="0"
            colorScheme={track.locked ? 'primary' : 'gray'}
            variant={track.locked ? 'solid' : 'ghost'}
            icon={track.locked ? <LockIcon boxSize="3.5" /> : <LockOpenIcon boxSize="3.5" />}
            aria-label={t('studio.track_lock')}
            aria-pressed={track.locked}
            title={t('studio.track_lock')}
            onClick={(event) => {
              event.stopPropagation()
              onChange(track.id, { locked: !track.locked })
            }}
          />
          <IconButton
            size="xs" variant="ghost" minW="26px" p="0"
            icon={<CopyIcon boxSize="3.5" />}
            aria-label={t('studio.track_duplicate')}
            title={t('studio.track_duplicate')}
            onClick={(event) => {
              event.stopPropagation()
              onDuplicate(track.id)
            }}
          />
          <IconButton
            size="xs" variant="ghost" minW="26px" p="0"
            icon={<TrashIcon boxSize="3.5" />}
            aria-label={t('studio.track_delete')}
            title={t('studio.track_delete')}
            disabled={!canDelete}
            onClick={(event) => {
              event.stopPropagation()
              onDelete(track.id)
            }}
          />
          <TrackMeter status={playbackStatus} trackId={track.id} />
        </Flex>
      )}
      {!track.collapsed && (
        <Flex align="center" gap="1">
          <Text fontSize="10px" fontVariantNumeric="tabular-nums" minW="42px">
            G
            {' '}
            {track.gainDb.toFixed(1)}
          </Text>
          <Slider.Root
            size="sm" colorScheme="primary"
            thumbProps={{ 'aria-label': t('studio.mixer_gain') }}
            value={track.gainDb}
            min={-60}
            max={12}
            step={0.5}
            onClick={event => event.stopPropagation()}
            onChange={gainDb => onChange(track.id, { gainDb })}
          />
          <Text fontSize="10px" fontVariantNumeric="tabular-nums" minW="36px">
            P
            {' '}
            {track.pan.toFixed(1)}
          </Text>
          <Slider.Root
            size="sm" colorScheme="primary"
            thumbProps={{ 'aria-label': t('studio.mixer_pan') }}
            value={track.pan}
            min={-1}
            max={1}
            step={0.05}
            onClick={event => event.stopPropagation()}
            onChange={pan => onChange(track.id, { pan })}
          />
        </Flex>
      )}
    </Box>
  )
})
