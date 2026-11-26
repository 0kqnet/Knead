import React from 'react'
import {
  Box, Button, ChevronDownIcon, ChevronRightIcon, CopyIcon, Flex, IconButton, Input, LockIcon,
  LockOpenIcon, Slider, Text, TrashIcon,
} from '@yamada-ui/react'
import { useTranslation } from 'react-i18next'
import {
  TRACK_COLORS,
  TRACK_HEIGHT,
  TRACK_HEIGHT_COLLAPSED,
  type Track,
} from '../types/timeline'

interface MeterValue {
  peak: number
  rms: number
}

interface Props {
  track: Track
  index: number
  selected: boolean
  meter?: MeterValue
  canDelete: boolean
  onSelect: () => void
  onChange: (patch: Partial<Omit<Track, 'id'>>) => void
  onDuplicate: () => void
  onDelete: () => void
  onMove: (draggedId: string, toIndex: number) => void
}

const COLOR_HEX: Record<Track['color'], string> = {
  blue: '#3b82f6', cyan: '#06b6d4', green: '#22c55e', yellow: '#eab308',
  orange: '#f97316', red: '#ef4444', pink: '#ec4899', purple: '#a855f7',
}

export const TrackHeader: React.FC<Props> = ({
  track, index, selected, meter, canDelete, onSelect, onChange, onDuplicate, onDelete, onMove,
}) => {
  const { t } = useTranslation()
  const collapseLabel = t(track.collapsed ? 'studio.track_expand' : 'studio.track_collapse')
  const height = track.collapsed ? TRACK_HEIGHT_COLLAPSED : TRACK_HEIGHT
  return (
    <Box
      data-track-header-id={track.id}
      draggable
      h={`${height}px`}
      bg={selected ? 'var(--studio-accent-soft)' : 'var(--studio-panel)'}
      boxShadow={selected ? 'inset 2px 0 var(--studio-accent)' : undefined}
      borderBottom="1px solid"
      borderRight="1px solid"
      borderColor="var(--studio-line)"
      px="2"
      py={track.collapsed ? '1' : '2'}
      overflow="hidden"
      onClick={onSelect}
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
            onChange({ color: TRACK_COLORS[(index + 1) % TRACK_COLORS.length] })
          }}
        />
        <Input
          size="xs"
          value={track.name}
          fontSize="xs"
          h="24px"
          onClick={event => event.stopPropagation()}
          onChange={event => onChange({ name: event.target.value })}
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
            onChange({ collapsed: !track.collapsed })
          }}
        />
      </Flex>
      {!track.collapsed && (
        <Flex mt="1" align="center" gap="1">
          <Button
            size="xs" minW="26px" p="0"
            colorScheme={track.muted ? 'red' : 'gray'}
            onClick={(event) => {
              event.stopPropagation()
              onChange({ muted: !track.muted })
            }}
            aria-label={t('studio.track_mute')}
            aria-pressed={track.muted}
            title={t('studio.track_mute')}
          >
            M
          </Button>
          <Button
            size="xs" minW="26px" p="0"
            colorScheme={track.solo ? 'yellow' : 'gray'}
            onClick={(event) => {
              event.stopPropagation()
              onChange({ solo: !track.solo })
            }}
            aria-label={t('studio.track_solo')}
            aria-pressed={track.solo}
            title={t('studio.track_solo')}
          >
            S
          </Button>
          <IconButton
            size="xs" minW="26px" p="0"
            colorScheme={track.locked ? 'blue' : 'gray'}
            variant={track.locked ? 'solid' : 'ghost'}
            icon={track.locked ? <LockIcon boxSize="3.5" /> : <LockOpenIcon boxSize="3.5" />}
            aria-label={t('studio.track_lock')}
            aria-pressed={track.locked}
            title={t('studio.track_lock')}
            onClick={(event) => {
              event.stopPropagation()
              onChange({ locked: !track.locked })
            }}
          />
          <IconButton
            size="xs" variant="ghost" minW="26px" p="0"
            icon={<CopyIcon boxSize="3.5" />}
            aria-label={t('studio.track_duplicate')}
            title={t('studio.track_duplicate')}
            onClick={(event) => {
              event.stopPropagation()
              onDuplicate()
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
              onDelete()
            }}
          />
          <Box
            flex="1"
            h="5px"
            bg="var(--studio-canvas)"
            borderRadius="full"
            overflow="hidden"
            position="relative"
            title={`Peak ${((meter?.peak ?? 0) * 100).toFixed(0)}% / RMS ${((meter?.rms ?? 0) * 100).toFixed(0)}%`}
          >
            <Box h="100%" w={`${Math.min(100, (meter?.peak ?? 0) * 100)}%`} bg={(meter?.peak ?? 0) > 0.9 ? 'red.400' : 'green.400'} />
            <Box
              position="absolute"
              left={`${Math.min(100, (meter?.rms ?? 0) * 100)}%`}
              top="0"
              h="100%"
              w="2px"
              bg="blue.200"
            />
          </Box>
        </Flex>
      )}
      {!track.collapsed && (
        <Flex mt="1" align="center" gap="1">
          <Text fontSize="10px" fontVariantNumeric="tabular-nums" minW="42px">
            G
            {' '}
            {track.gainDb.toFixed(1)}
          </Text>
          <Slider.Root
            aria-label="Track gain"
            value={track.gainDb}
            min={-60}
            max={12}
            step={0.5}
            onClick={event => event.stopPropagation()}
            onChange={gainDb => onChange({ gainDb })}
          />
          <Text fontSize="10px" fontVariantNumeric="tabular-nums" minW="36px">
            P
            {' '}
            {track.pan.toFixed(1)}
          </Text>
          <Slider.Root
            aria-label="Track pan"
            value={track.pan}
            min={-1}
            max={1}
            step={0.05}
            onClick={event => event.stopPropagation()}
            onChange={pan => onChange({ pan })}
          />
        </Flex>
      )}
    </Box>
  )
}
