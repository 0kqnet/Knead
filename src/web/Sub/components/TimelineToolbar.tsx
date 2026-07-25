import React from 'react'
import { Box, Button, Flex, Select, SelectItem, Text } from '@yamada-ui/react'
import type { TimelineSettings } from '../types/timeline'
import { useTranslation } from 'react-i18next'
import { CommitNumberInput } from '../../components/CommitNumberInput'

interface Props {
  onNew: () => void
  onOpen: () => void
  onSave: () => void
  onSaveAs: () => void
  onExport: () => void
  onAddMarker: () => void
  onAddTrack: () => void
  onDeleteSelected: () => void
  canDelete: boolean
  dirty: boolean
  filePath: string | null
  onTogglePlay: () => void
  onStop: () => void
  isPlaying: boolean
  isPaused: boolean
  currentTick: number
  preloading: boolean
  onUndo: () => void
  onRedo: () => void
  canUndo: boolean
  canRedo: boolean
  settings: TimelineSettings
  onSettingsChange: (patch: Partial<TimelineSettings>) => void
  onReroll: () => void
  pxPerTick: number
  onZoom: (next: number) => void
  onFitProject: () => void
  onFitSelection: () => void
  canFitSelection: boolean
  mixerOpen: boolean
  onToggleMixer: () => void
}

const snapItems: SelectItem[] = [
  { label: 'Snap OFF', value: 'off' },
  ...[1, 2, 5, 10, 20].map(value => ({ label: `${value} tick`, value: `tick:${value}` })),
  ...[1, 2, 4, 8, 16].map(value => ({ label: `1/${value} beat`, value: `beat:${value}` })),
]

export const TimelineToolbar: React.FC<Props> = ({
  onNew, onOpen, onSave, onSaveAs, onExport, onAddMarker, onAddTrack,
  onDeleteSelected, canDelete, dirty, filePath, onTogglePlay, onStop,
  isPlaying, isPaused, currentTick, preloading, onUndo, onRedo, canUndo, canRedo,
  settings, onSettingsChange, onReroll, pxPerTick, onZoom,
  onFitProject, onFitSelection, canFitSelection, mixerOpen, onToggleMixer,
}) => {
  const { t } = useTranslation()
  const snapValue = settings.snap.mode === 'off'
    ? 'off'
    : settings.snap.mode === 'tick'
      ? `tick:${settings.snap.tickStep}`
      : `beat:${settings.snap.beatDivision}`
  const fileName = filePath ? filePath.replace(/^.*[\\/]/, '') : `(${t('studio.unsaved')})`
  return (
    <Box bg="gray.900" borderBottom="1px solid" borderColor="gray.700" px="2" py="1">
      <Flex align="center" gap="1" minW="max-content">
        <Button size="xs" onClick={onNew} title="Ctrl+N">{t('studio.new')}</Button>
        <Button size="xs" onClick={onOpen} title="Ctrl+O">{t('studio.open')}</Button>
        <Button size="xs" onClick={onSave} title="Ctrl+S">{t('studio.save')}</Button>
        <Button size="xs" onClick={onSaveAs} title="Ctrl+Shift+S">{t('studio.save_as')}</Button>
        <Button size="xs" colorScheme="purple" onClick={onExport}>{t('studio.export')}</Button>
        <Box w="1px" h="22px" bg="gray.600" mx="1" />
        <Button size="xs" onClick={onUndo} isDisabled={!canUndo}>↺</Button>
        <Button size="xs" onClick={onRedo} isDisabled={!canRedo}>↻</Button>
        <Button
          size="xs"
          minW="82px"
          colorScheme={preloading ? 'gray' : isPlaying ? 'red' : 'green'}
          onClick={onTogglePlay}
          isDisabled={preloading}
        >
          {preloading ? t('studio.loading') : isPlaying ? `⏸ ${t('studio.pause')}` : isPaused ? `▶ ${t('studio.resume')}` : `▶ ${t('studio.play')}`}
        </Button>
        <Button size="xs" onClick={onStop} isDisabled={currentTick <= 0 && !isPaused}>
          ■
          {t('studio.stop')}
        </Button>
        <Text minW="84px" textAlign="center" fontFamily="mono" fontSize="xs">
          {Math.floor(currentTick)}
          t /
          {(currentTick / 20).toFixed(2)}
          s
        </Text>
        <Box w="1px" h="22px" bg="gray.600" mx="1" />
        <Button size="xs" colorScheme="blue" onClick={onAddMarker}>{t('studio.add_marker')}</Button>
        <Button size="xs" colorScheme="cyan" onClick={onAddTrack}>{t('studio.add_track')}</Button>
        <Button size="xs" colorScheme="red" onClick={onDeleteSelected} isDisabled={!canDelete}>{t('studio.delete')}</Button>
        <Box flex="1" />
        <Text fontSize="xs" color={dirty ? 'yellow.300' : 'gray.400'} maxW="160px" whiteSpace="nowrap" overflow="hidden" textOverflow="ellipsis">
          {dirty ? '* ' : ''}
          {fileName}
        </Text>
      </Flex>
      <Flex align="center" gap="2" mt="1" minW="max-content">
        <Text fontSize="xs">BPM</Text>
        <CommitNumberInput
          size="xs" w="76px" value={settings.bpm} min={20} max={300} step={1} precision={0}
          onCommit={bpm => onSettingsChange({ bpm })}
        />
        <Text fontSize="xs">{t('studio.time_signature')}</Text>
        <CommitNumberInput
          size="xs" w="52px" value={settings.timeSignature.numerator} min={1} max={16} step={1} precision={0}
          onCommit={numerator => onSettingsChange({
            timeSignature: { ...settings.timeSignature, numerator },
          })}
        />
        <Select
          size="xs" w="66px"
          value={String(settings.timeSignature.denominator)}
          items={[2, 4, 8, 16].map(value => ({ label: `/${value}`, value: String(value) }))}
          onChange={value => onSettingsChange({
            timeSignature: {
              ...settings.timeSignature,
              denominator: Number(value) as 2 | 4 | 8 | 16,
            },
          })}
        />
        <Select
          size="xs" w="112px"
          value={snapValue}
          items={snapItems}
          onChange={(value) => {
            if (value === 'off') onSettingsChange({ snap: { ...settings.snap, mode: 'off' } })
            else {
              const [mode, raw] = value.split(':') as ['tick' | 'beat', string]
              const amount = Number(raw)
              onSettingsChange({
                snap: mode === 'tick'
                  ? { ...settings.snap, mode, tickStep: amount as 1 | 2 | 5 | 10 | 20 }
                  : { ...settings.snap, mode, beatDivision: amount as 1 | 2 | 4 | 8 | 16 },
              })
            }
          }}
        />
        <Flex gap="0">
          {(['ticks', 'seconds', 'bars'] as const).map(mode => (
            <Button
              key={mode} size="xs" borderRadius="0"
              colorScheme={settings.timeDisplay === mode ? 'blue' : 'gray'}
              onClick={() => onSettingsChange({ timeDisplay: mode })}
            >
              {mode === 'ticks' ? 'Tick' : mode === 'seconds' ? 'Sec' : 'Bar'}
            </Button>
          ))}
        </Flex>
        <Button
          size="xs"
          colorScheme={settings.loop.enabled ? 'green' : 'gray'}
          onClick={() => onSettingsChange({ loop: { ...settings.loop, enabled: !settings.loop.enabled } })}
          title="L"
        >
          ↻ Loop
        </Button>
        <Button
          size="xs"
          colorScheme={settings.metronomeEnabled ? 'orange' : 'gray'}
          onClick={() => onSettingsChange({ metronomeEnabled: !settings.metronomeEnabled })}
          title="M"
        >
          ♩
          {t('studio.metronome')}
        </Button>
        <Button size="xs" onClick={onReroll} title={t('studio.reroll_hint')}>
          ⚄
          {t('studio.reroll')}
        </Button>
        <Box w="1px" h="22px" bg="gray.600" />
        <Button size="xs" onClick={() => onZoom(pxPerTick / 1.35)}>−</Button>
        <Text fontSize="xs" minW="42px" textAlign="center">
          {Math.round(pxPerTick * 10) / 10}
          x
        </Text>
        <Button size="xs" onClick={() => onZoom(pxPerTick * 1.35)}>＋</Button>
        <Button size="xs" onClick={onFitProject}>{t('studio.fit_all')}</Button>
        <Button size="xs" onClick={onFitSelection} isDisabled={!canFitSelection}>
          {t('studio.fit_selection')}
        </Button>
        <Button size="xs" colorScheme={mixerOpen ? 'blue' : 'gray'} onClick={onToggleMixer}>{t('studio.mixer')}</Button>
      </Flex>
    </Box>
  )
}
