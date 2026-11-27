import React, { useEffect, useMemo, useRef, useState } from 'react'
import { StudioDialogClose } from './StudioDialogClose'
import { Box, Button, Flex, Text } from '@yamada-ui/react'
import { useTranslation } from 'react-i18next'
import {
  type ReferenceAudioTrack,
  type TempoMapEvent,
  type TimelineGridSettings,
  type TimelineSettings,
  type Track,
} from '../types/timeline'
import {
  buildTempoMap,
  formatMusicalPosition,
  tickToMusicalPosition,
  tickToSeconds,
} from '../utils/tempoMap'

export interface PlayerMeterValue {
  peak: number
  rms: number
}

export interface PlayerModeOverlayProps {
  open: boolean
  title: string
  lengthTicks: number
  currentTick: number
  settings: TimelineGridSettings & Pick<TimelineSettings, 'loop'>
  /** Optional conductor map. Missing maps retain the legacy single-tempo display. */
  tempoMap?: readonly TempoMapEvent[]
  tracks: readonly Pick<Track, 'id' | 'name' | 'color' | 'muted' | 'solo'>[]
  referenceAudio?: readonly Pick<ReferenceAudioTrack, 'id' | 'name' | 'muted' | 'solo'>[]
  trackMeters: Readonly<Record<string, PlayerMeterValue>>
  referenceAudioMeters?: Readonly<Record<string, PlayerMeterValue>>
  masterMeter: PlayerMeterValue
  isPlaying: boolean
  isPaused: boolean
  preloading?: boolean
  onTogglePlay: () => void
  onStop: () => void
  onSeek: (tick: number) => void
  onToggleLoop: (enabled: boolean) => void
  onClose: () => void
}

interface WakeLockSentinelLike extends EventTarget {
  released: boolean
  release: () => Promise<void>
}

interface WakeLockCapable {
  wakeLock?: {
    request: (type: 'screen') => Promise<WakeLockSentinelLike>
  }
}

const focusableSelector = [
  'button:not([disabled])',
  'input:not([disabled])',
  '[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function clamp(value: number, minimum = 0, maximum = 1): number {
  if (!Number.isFinite(value)) return minimum
  return Math.max(minimum, Math.min(maximum, value))
}

function formatClock(secondsElapsed: number): string {
  const totalMilliseconds = secondsElapsed * 1_000
  const minutes = Math.floor(totalMilliseconds / 60_000)
  const seconds = Math.floor((totalMilliseconds % 60_000) / 1_000)
  const tenths = Math.floor((totalMilliseconds % 1_000) / 100)
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${tenths}`
}

export function formatPlayerMusicalPosition(
  tick: number,
  settings: TimelineGridSettings,
  tempoMap?: readonly TempoMapEvent[],
): string {
  return formatMusicalPosition(Math.max(0, tick), buildTempoMap(tempoMap, settings))
}

function formatBpm(bpm: number): string {
  return Number.isInteger(bpm) ? String(bpm) : bpm.toFixed(2).replace(/\.?0+$/, '')
}

const channelColors: Record<Track['color'], string> = {
  blue: 'blue.400',
  cyan: 'cyan.400',
  green: 'green.400',
  yellow: 'yellow.400',
  orange: 'orange.400',
  red: 'red.400',
  pink: 'pink.400',
  purple: 'purple.400',
}

const MeterBar: React.FC<{
  label: string
  value?: PlayerMeterValue
  color: string
  large?: boolean
}> = ({ label, value, color, large = false }) => {
  const peak = clamp(value?.peak ?? 0)
  const rms = clamp(value?.rms ?? 0)
  return (
    <Box>
      <Flex align="center" gap="2">
        <Text
          minW={large ? '72px' : '96px'} maxW={large ? '72px' : '96px'}
          fontSize={large ? 'sm' : 'xs'} fontWeight={large ? 'bold' : 'normal'}
          whiteSpace="nowrap" overflow="hidden" textOverflow="ellipsis"
        >
          {label}
        </Text>
        <Box
          role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={Math.round(peak * 100)}
          position="relative" flex="1" h={large ? '18px' : '10px'}
          bg="gray.900" borderRadius="full" overflow="hidden"
        >
          <Box position="absolute" inset="0 auto 0 0" w={`${peak * 100}%`} bg={peak > 0.9 ? 'red.400' : color} opacity="0.6" />
          <Box position="absolute" left="0" bottom="0" h="50%" w={`${rms * 100}%`} bg="blue.300" />
          <Box
            position="absolute" top="0" bottom="0" left={`${peak * 100}%`}
            w="2px" bg="white" transform="translateX(-1px)"
          />
        </Box>
        <Text minW="34px" textAlign="right" fontFamily="mono" fontSize="10px" color="gray.400">
          {Math.round(peak * 100)}
        </Text>
      </Flex>
    </Box>
  )
}

export const PlayerModeOverlay: React.FC<PlayerModeOverlayProps> = ({
  open,
  title,
  lengthTicks,
  currentTick,
  settings,
  tempoMap,
  tracks,
  referenceAudio = [],
  trackMeters,
  referenceAudioMeters = {},
  masterMeter,
  isPlaying,
  isPaused,
  preloading = false,
  onTogglePlay,
  onStop,
  onSeek,
  onToggleLoop,
  onClose,
}) => {
  const { t } = useTranslation()
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const wakeSentinelRef = useRef<WakeLockSentinelLike | null>(null)
  const [wakeLockWanted, setWakeLockWanted] = useState(false)
  const [wakeLockActive, setWakeLockActive] = useState(false)
  const [wakeLockError, setWakeLockError] = useState('')
  const maximumTick = Math.max(1, Number.isFinite(lengthTicks) ? lengthTicks : 1)
  const safeCurrentTick = clamp(currentTick, 0, maximumTick)
  const progress = clamp(safeCurrentTick / maximumTick)
  const loopStart = clamp(settings.loop.startTick, 0, maximumTick)
  const loopEnd = clamp(settings.loop.endTick, loopStart, maximumTick)
  const tempoModel = useMemo(
    () => buildTempoMap(tempoMap, settings),
    [settings, tempoMap],
  )
  const musicalPosition = tickToMusicalPosition(safeCurrentTick, tempoModel)
  const wakeLockApi = typeof navigator === 'undefined'
    ? undefined
    : (navigator as unknown as WakeLockCapable).wakeLock
  const wakeLockSupported = typeof navigator !== 'undefined'
    && typeof wakeLockApi?.request === 'function'

  const channels = useMemo(() => [
    ...tracks.map(track => ({
      id: track.id,
      name: track.name,
      color: channelColors[track.color],
      meter: trackMeters[track.id],
      muted: track.muted,
      solo: track.solo,
      reference: false,
    })),
    ...referenceAudio.map(track => ({
      id: track.id,
      name: track.name,
      color: 'cyan.300',
      meter: referenceAudioMeters[track.id],
      muted: track.muted,
      solo: track.solo,
      reference: true,
    })),
  ], [referenceAudio, referenceAudioMeters, trackMeters, tracks])

  useEffect(() => {
    if (!open) return
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const frame = requestAnimationFrame(() => {
      const first = overlayRef.current?.querySelector<HTMLElement>(focusableSelector)
      ;(first ?? overlayRef.current)?.focus()
    })
    return () => {
      cancelAnimationFrame(frame)
      previousFocusRef.current?.focus()
      previousFocusRef.current = null
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Tab') {
        event.stopPropagation()
        const focusable = Array.from(overlayRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? [])
        if (!focusable.length) {
          event.preventDefault()
          overlayRef.current?.focus()
          return
        }
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        const focusIsInside = !!overlayRef.current?.contains(document.activeElement)
        if (!focusIsInside) {
          event.preventDefault()
          ;(event.shiftKey ? last : first).focus()
        }
        else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        }
        else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
        return
      }
      if (event.repeat) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }
      else if (event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault()
        event.stopPropagation()
        if (event.shiftKey) onStop()
        else if (!preloading) onTogglePlay()
      }
      else if (event.key === 'Home') {
        event.preventDefault()
        event.stopPropagation()
        onSeek(0)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose, onSeek, onStop, onTogglePlay, open, preloading])

  useEffect(() => {
    if (!open || !wakeLockWanted || !wakeLockSupported) {
      const sentinel = wakeSentinelRef.current
      wakeSentinelRef.current = null
      setWakeLockActive(false)
      if (sentinel && !sentinel.released) void sentinel.release().catch(() => undefined)
      return
    }
    let canceled = false
    const acquire = async () => {
      if (document.visibilityState !== 'visible' || wakeSentinelRef.current) return
      try {
        const sentinel = await wakeLockApi!.request('screen')
        if (canceled) {
          await sentinel.release().catch(() => undefined)
          return
        }
        wakeSentinelRef.current = sentinel
        setWakeLockActive(!sentinel.released)
        setWakeLockError('')
        sentinel.addEventListener('release', () => {
          if (wakeSentinelRef.current === sentinel) wakeSentinelRef.current = null
          setWakeLockActive(false)
        }, { once: true })
      }
      catch (error) {
        if (!canceled) {
          setWakeLockActive(false)
          setWakeLockError(error instanceof Error ? error.message : String(error))
        }
      }
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void acquire()
    }
    document.addEventListener('visibilitychange', onVisibility)
    void acquire()
    return () => {
      canceled = true
      document.removeEventListener('visibilitychange', onVisibility)
      const sentinel = wakeSentinelRef.current
      wakeSentinelRef.current = null
      setWakeLockActive(false)
      if (sentinel && !sentinel.released) void sentinel.release().catch(() => undefined)
    }
  }, [open, wakeLockApi, wakeLockSupported, wakeLockWanted])

  if (!open) return null

  const transportLabel = preloading
    ? t('studio.player_loading')
    : isPlaying
      ? t('studio.pause')
      : isPaused
        ? t('studio.resume')
        : t('studio.play')
  const status = preloading
    ? t('studio.player_loading')
    : isPlaying
      ? t('studio.player_status_playing')
      : isPaused
        ? t('studio.player_status_paused')
        : t('studio.player_status_stopped')

  return (
    <Box
      ref={overlayRef}
      role="dialog" aria-modal="true" aria-labelledby="player-mode-title"
      aria-describedby="player-mode-description" tabIndex={-1}
      position="fixed" inset="0" zIndex="2200" bg="#020202" color="white"
      overflowY="auto" outline="none"
    >
      <Flex minH="100%" direction="column" p="clamp(16px, 3vw, 44px)" gap="clamp(16px, 3vh, 32px)">
        <Flex align="start" gap="3">
          <Box flex="1" minW="0">
            <Text
              id="player-mode-title" as="h2" fontSize="clamp(20px, 3.5vw, 44px)"
              fontWeight="bold" lineHeight="1.1" whiteSpace="nowrap" overflow="hidden" textOverflow="ellipsis"
            >
              {title || t('studio.player_untitled')}
            </Text>
            <Text id="player-mode-description" mt="1" fontSize="sm" color="gray.500">
              {t('studio.player_shortcuts')}
            </Text>
          </Box>
          <StudioDialogClose aria-label={t('studio.player_close')} onClick={onClose} />
        </Flex>

        <Flex direction="column" align="center" textAlign="center" gap="1" aria-live="polite">
          <Text color={isPlaying ? 'green.300' : isPaused ? 'yellow.300' : 'gray.500'} fontWeight="bold">
            {status}
          </Text>
          <Text fontFamily="mono" fontSize="clamp(52px, 13vw, 164px)" lineHeight=".95" letterSpacing="-.06em">
            {formatClock(tickToSeconds(safeCurrentTick, tempoModel))}
          </Text>
          <Flex align="baseline" justify="center" gap="clamp(12px, 4vw, 48px)" flexWrap="wrap">
            <Text fontFamily="mono" fontSize="clamp(18px, 3vw, 36px)">
              {Math.floor(safeCurrentTick)}
              {' '}
              {t('studio.player_ticks')}
            </Text>
            <Text fontFamily="mono" fontSize="clamp(18px, 3vw, 36px)">
              {t('studio.player_bar')}
              {' '}
              {formatMusicalPosition(safeCurrentTick, tempoModel)}
            </Text>
          </Flex>
          <Text
            aria-label={t('studio.player_tempo_meter_label')}
            fontFamily="mono" fontSize="clamp(14px, 2vw, 24px)" color="var(--knead-brand)"
          >
            {t('studio.player_tempo_meter', {
              bpm: formatBpm(musicalPosition.bpm),
              numerator: musicalPosition.meter.numerator,
              denominator: musicalPosition.meter.denominator,
            })}
          </Text>
        </Flex>

        <Box>
          <Box
            role="progressbar" aria-label={t('studio.player_progress')}
            aria-valuemin={0} aria-valuemax={Math.round(maximumTick)} aria-valuenow={Math.round(safeCurrentTick)}
            position="relative" h="12px" bg="gray.900" borderRadius="full" overflow="hidden"
          >
            {settings.loop.enabled && (
              <Box
                position="absolute" top="0" bottom="0"
                left={`${loopStart / maximumTick * 100}%`}
                w={`${Math.max(0, loopEnd - loopStart) / maximumTick * 100}%`}
                bg="green.900" opacity=".8"
              />
            )}
            <Box position="absolute" inset="0 auto 0 0" w={`${progress * 100}%`} bg="var(--knead-brand)" />
          </Box>
          <input
            aria-label={t('studio.player_seek')}
            type="range" min={0} max={maximumTick} step={0.1} value={safeCurrentTick}
            onChange={event => onSeek(Number(event.currentTarget.value))}
            style={{ width: '100%', accentColor: 'var(--knead-brand)', marginTop: 8 }}
          />
          <Flex justify="space-between" fontFamily="mono" fontSize="xs" color="gray.500">
            <Text>00:00.0</Text>
            <Text>{formatClock(tickToSeconds(maximumTick, tempoModel))}</Text>
          </Flex>
        </Box>

        <Flex justify="center" align="center" gap="3" flexWrap="wrap">
          <Button
            minW="clamp(132px, 20vw, 220px)" h="56px" fontSize="lg"
            colorScheme={isPlaying ? 'yellow' : 'green'}
            onClick={onTogglePlay} disabled={preloading}
          >
            {isPlaying ? 'Ⅱ' : '▶'}
            {' '}
            {transportLabel}
          </Button>
          <Button minW="112px" h="56px" fontSize="lg" onClick={onStop}>
            ■
            {' '}
            {t('studio.stop')}
          </Button>
          <Button
            minW="112px" h="56px" fontSize="lg"
            colorScheme={settings.loop.enabled ? 'green' : 'gray'}
            aria-pressed={settings.loop.enabled}
            onClick={() => onToggleLoop(!settings.loop.enabled)}
          >
            ↻
            {' '}
            {t('studio.player_loop')}
          </Button>
          <Button
            minW="150px" h="56px"
            colorScheme={wakeLockActive ? 'cyan' : 'gray'}
            aria-pressed={wakeLockWanted}
            onClick={() => {
              setWakeLockError('')
              setWakeLockWanted(value => !value)
            }}
            disabled={!wakeLockSupported}
          >
            {wakeLockActive ? '☀' : '◌'}
            {' '}
            {wakeLockSupported ? t('studio.player_keep_awake') : t('studio.player_wake_unsupported')}
          </Button>
        </Flex>

        {settings.loop.enabled && (
          <Text textAlign="center" fontFamily="mono" fontSize="sm" color="green.300">
            {t('studio.player_loop_range', {
              start: formatMusicalPosition(loopStart, tempoModel),
              end: formatMusicalPosition(loopEnd, tempoModel),
            })}
          </Text>
        )}
        {wakeLockError && (
          <Text role="status" textAlign="center" fontSize="sm" color="orange.300">
            {t('studio.player_wake_failed', { error: wakeLockError })}
          </Text>
        )}

        <Box mt="auto" p="clamp(12px, 2vw, 24px)" bg="rgba(17,24,39,.72)" borderRadius="xl">
          <MeterBar label={t('studio.player_master')} value={masterMeter} color="green.300" large />
          <Text mt="3" mb="2" fontSize="xs" color="gray.500">
            {t('studio.player_channels', { tracks: tracks.length, references: referenceAudio.length })}
          </Text>
          <Box
            display="grid" gridTemplateColumns="repeat(auto-fit, minmax(min(100%, 220px), 1fr))"
            gap="2" maxH="22vh" overflowY="auto" pr="1"
          >
            {channels.map(channel => (
              <Box key={`${channel.reference ? 'reference' : 'track'}:${channel.id}`} opacity={channel.muted ? 0.4 : 1}>
                <MeterBar
                  label={`${channel.reference ? `${t('studio.player_reference')} · ` : ''}${channel.name}${channel.solo ? ' · S' : ''}`}
                  value={channel.meter} color={channel.color}
                />
              </Box>
            ))}
          </Box>
        </Box>
      </Flex>
    </Box>
  )
}
