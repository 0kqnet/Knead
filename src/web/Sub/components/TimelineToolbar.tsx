import React, { useMemo } from 'react'
import {
  Button, ChevronDownIcon, Flex, IconButton, MaximizeIcon, Menu, MenuContent, MenuItem, MenuOptionGroup,
  MenuOptionItem, MenuSeparator, MinusIcon, PauseIcon, PlayIcon, PlusIcon, Redo2Icon, RepeatIcon,
  SaveIcon, SearchIcon, Select, SquareIcon, Text, TimerIcon, TrashIcon, Undo2Icon,
} from '@yamada-ui/react'
import { useTranslation } from 'react-i18next'
import { CommitNumberInput } from '../../components/CommitNumberInput'
import { DEFAULT_PX_PER_TICK } from '../utils/tickPixel'
import type { TimelineSettings } from '../types/timeline'

interface Props {
  onNew: () => void
  onOpen: () => void
  onCommandPalette: () => void
  onSave: () => void
  onSaveAs: () => void
  onAudioExport: () => void
  onCommandExport: () => void
  onNoteBlockBuild: () => void
  onNbs: () => void
  onNbp: () => void
  onNbsMacros: () => void
  onResourcePack: () => void
  onRecovery: () => void
  recoverySaving: boolean
  recoveryError: string | null
  onPlayerMode: () => void
  onPianoRoll: () => void
  onTempoMap: () => void
  onSongMetadata: () => void
  onCustomInstruments: () => void
  onMidi: () => void
  onExtensions: () => void
  onAddMarker: () => void
  onAddSoundStopper: () => void
  canAddMarker: boolean
  onAddTrack: () => void
  onAddReferenceAudio: () => void
  onDeleteSelected: () => void
  canDelete: boolean
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
  markerIconsEnabled: boolean
  markerIconsLoading: boolean
  onToggleMarkerIcons: () => void
  navigatorOpen: boolean
  onToggleNavigator: () => void
}

const toolButton = { size: 'xs', variant: 'ghost' } as const
const timeUnits = ['ticks', 'seconds', 'bars'] as const

const ToolbarMenu = ({ label, children }: { label: string, children: React.ReactNode }) => (
  <Menu.Root placement="end-start">
    <Menu.Trigger>
      <Button {...toolButton} endIcon={<ChevronDownIcon boxSize="3" />}>{label}</Button>
    </Menu.Trigger>
    <MenuContent className="studio-menu" minW="194px" maxH="60vh" overflowY="auto">
      {children}
    </MenuContent>
  </Menu.Root>
)

export const TimelineToolbar: React.FC<Props> = ({
  onNew, onOpen, onCommandPalette, onSave, onSaveAs, onAudioExport, onCommandExport,
  onNoteBlockBuild, onNbs, onNbp, onNbsMacros, onResourcePack, onRecovery, recoverySaving,
  recoveryError, onPlayerMode, onPianoRoll, onTempoMap, onSongMetadata, onCustomInstruments,
  onMidi, onExtensions, onAddMarker, onAddSoundStopper, onAddTrack, onAddReferenceAudio,
  canAddMarker, onDeleteSelected, canDelete, onTogglePlay, onStop, isPlaying, isPaused,
  currentTick, preloading, onUndo, onRedo, canUndo, canRedo, settings, onSettingsChange,
  onReroll, pxPerTick, onZoom, onFitProject, onFitSelection, canFitSelection, mixerOpen,
  onToggleMixer, markerIconsEnabled, markerIconsLoading, onToggleMarkerIcons, navigatorOpen,
  onToggleNavigator,
}) => {
  const { t } = useTranslation()
  const snapItems = useMemo(() => [
    { label: t('studio.snap_off'), value: 'off' },
    ...[1, 2, 5, 10, 20].map(value => ({ label: t('studio.snap_ticks', { value }), value: `tick:${value}` })),
    ...[1, 2, 4, 8, 16].map(value => ({ label: t('studio.snap_beat', { value }), value: `beat:${value}` })),
  ], [t])
  const snapValue = settings.snap.mode === 'off'
    ? 'off'
    : settings.snap.mode === 'tick'
      ? `tick:${settings.snap.tickStep}`
      : `beat:${settings.snap.beatDivision}`
  const playLabel = preloading
    ? t('studio.loading')
    : isPlaying ? t('studio.pause') : isPaused ? t('studio.resume') : t('studio.play')

  return (
    <header className="studio-toolbar">
      <div className="studio-toolbar-primary">
        <Flex className="studio-toolbar-group">
          <ToolbarMenu label={t('studio.file_menu')}>
            <MenuItem onSelect={onNew} title="Ctrl+N">{t('studio.new')}</MenuItem>
            <MenuItem onSelect={onOpen} title="Ctrl+O">{t('studio.open')}</MenuItem>
            <MenuItem onSelect={onSaveAs} title="Ctrl+Shift+S">{t('studio.save_as')}</MenuItem>
            <MenuSeparator />
            <MenuItem onSelect={onRecovery} title={recoveryError ?? undefined}>
              {recoverySaving ? '… ' : ''}
              {t('studio.recovery_short')}
            </MenuItem>
          </ToolbarMenu>
          <IconButton
            {...toolButton}
            icon={<SaveIcon boxSize="4" />}
            aria-label={t('studio.save')}
            title={`${t('studio.save')} (Ctrl+S)`}
            onClick={onSave}
          />
          <ToolbarMenu label={t('studio.export')}>
            <MenuItem onSelect={onAudioExport}>{t('studio.audio_export')}</MenuItem>
            <MenuItem onSelect={onCommandExport} title="Ctrl+E">{t('studio.command_export_short')}</MenuItem>
            <MenuItem onSelect={onNoteBlockBuild}>{t('studio.note_block_build_short')}</MenuItem>
          </ToolbarMenu>
          <ToolbarMenu label={t('studio.tools_menu')}>
            <MenuItem onSelect={onNbs}>{t('studio.nbs_short')}</MenuItem>
            <MenuItem onSelect={onNbp}>{t('studio.nbp_short')}</MenuItem>
            <MenuItem onSelect={onMidi}>{t('studio.midi_short')}</MenuItem>
            <MenuItem onSelect={onResourcePack}>{t('studio.resource_pack_short')}</MenuItem>
            <MenuSeparator />
            <MenuItem onSelect={onTempoMap}>{t('studio.tempo_map_short')}</MenuItem>
            <MenuItem onSelect={onSongMetadata}>{t('studio.song_metadata_short')}</MenuItem>
            <MenuItem onSelect={onCustomInstruments}>{t('studio.custom_instrument_short')}</MenuItem>
            <MenuItem onSelect={onNbsMacros} disabled={!canDelete}>{t('studio.nbs_macros_short')}</MenuItem>
            <MenuItem onSelect={onReroll} title={t('studio.reroll_hint')}>{t('studio.reroll')}</MenuItem>
            <MenuItem onSelect={onExtensions}>{t('studio.extensions_short')}</MenuItem>
          </ToolbarMenu>
          {recoveryError && (
            <IconButton
              {...toolButton}
              colorScheme="red"
              icon={<span aria-hidden="true">!</span>}
              aria-label={t('studio.recovery_short')}
              title={recoveryError}
              onClick={onRecovery}
            />
          )}
        </Flex>

        <Flex className="studio-transport" role="group" aria-label={t('studio.transport')}>
          <Button
            size="xs"
            colorScheme="purple"
            className="studio-play"
            startIcon={isPlaying ? <PauseIcon boxSize="3.5" /> : <PlayIcon boxSize="3.5" />}
            onClick={onTogglePlay}
            disabled={preloading}
          >
            {playLabel}
          </Button>
          <IconButton
            {...toolButton}
            icon={<SquareIcon boxSize="3.5" />}
            aria-label={t('studio.stop')}
            title={t('studio.stop')}
            onClick={onStop}
            disabled={!isPlaying && !isPaused && currentTick <= 0}
          />
          <Text as="span" className="studio-time-readout">
            <span>
              {(currentTick / 20).toFixed(2)}
              {' '}
              s
            </span>
            <small>
              {Math.floor(currentTick)}
              {' '}
              t
            </small>
          </Text>
          <IconButton
            {...toolButton}
            icon={<RepeatIcon boxSize="4" />}
            aria-label={t('studio.loop')}
            aria-pressed={settings.loop.enabled}
            title={`${t('studio.loop')} (L)`}
            onClick={() => onSettingsChange({ loop: { ...settings.loop, enabled: !settings.loop.enabled } })}
          />
          <IconButton
            {...toolButton}
            icon={<TimerIcon boxSize="4" />}
            aria-label={t('studio.metronome')}
            aria-pressed={settings.metronomeEnabled}
            title={`${t('studio.metronome')} (M)`}
            onClick={() => onSettingsChange({ metronomeEnabled: !settings.metronomeEnabled })}
          />
        </Flex>

        <Flex className="studio-toolbar-group studio-view-actions">
          <Button {...toolButton} aria-pressed={navigatorOpen} onClick={onToggleNavigator} title="N">
            {t('studio.navigator')}
          </Button>
          <Button {...toolButton} aria-pressed={mixerOpen} onClick={onToggleMixer}>{t('studio.mixer')}</Button>
          <ToolbarMenu label={t('studio.view_menu')}>
            <MenuItem onSelect={onPianoRoll}>{t('studio.piano_roll_short')}</MenuItem>
            <MenuItem onSelect={onPlayerMode}>{t('studio.player_mode_short')}</MenuItem>
            <MenuItem onSelect={onFitSelection} disabled={!canFitSelection}>{t('studio.fit_selection')}</MenuItem>
            <MenuSeparator />
            <MenuOptionGroup type="checkbox" value={markerIconsEnabled ? ['icons'] : []} onChange={onToggleMarkerIcons}>
              <MenuOptionItem value="icons" title={t('studio.marker_icons_hint')}>
                {markerIconsLoading ? t('studio.marker_icons_loading') : t('studio.marker_icons')}
              </MenuOptionItem>
            </MenuOptionGroup>
          </ToolbarMenu>
          <IconButton
            {...toolButton}
            icon={<SearchIcon boxSize="4" />}
            aria-label={t('studio.command_palette_title')}
            title={`${t('studio.command_palette_title')} (Ctrl/Cmd+K)`}
            onClick={onCommandPalette}
          />
        </Flex>
      </div>

      <div className="studio-toolbar-edit">
        <Flex className="studio-toolbar-group">
          <IconButton
            {...toolButton}
            icon={<Undo2Icon boxSize="4" />}
            aria-label={t('studio.undo')}
            title={`${t('studio.undo')} (Ctrl+Z)`}
            onClick={onUndo}
            disabled={!canUndo}
          />
          <IconButton
            {...toolButton}
            icon={<Redo2Icon boxSize="4" />}
            aria-label={t('studio.redo')}
            title={`${t('studio.redo')} (Ctrl+Y)`}
            onClick={onRedo}
            disabled={!canRedo}
          />
          <Button size="xs" variant="outline" borderColor="var(--studio-line)" onClick={onAddTrack}>{t('studio.add_track')}</Button>
          <Button size="xs" variant="outline" borderColor="var(--studio-line)" onClick={onAddMarker} disabled={!canAddMarker}>{t('studio.add_marker')}</Button>
          <ToolbarMenu label={t('studio.insert_menu')}>
            <MenuItem onSelect={onAddSoundStopper} disabled={!canAddMarker}>{t('studio.add_sound_stopper')}</MenuItem>
            <MenuItem onSelect={onAddReferenceAudio}>{t('studio.reference_audio_short')}</MenuItem>
          </ToolbarMenu>
          <IconButton
            {...toolButton}
            icon={<TrashIcon boxSize="4" />}
            aria-label={t('studio.delete')}
            title={t('studio.delete')}
            onClick={onDeleteSelected}
            disabled={!canDelete}
          />
        </Flex>

        <Flex className="studio-toolbar-group studio-tempo-controls">
          <Text as="span" className="studio-field-label">BPM</Text>
          <CommitNumberInput
            aria-label="BPM" size="xs" w="60px" value={settings.bpm} min={20} max={300} step={1} precision={0}
            onCommit={bpm => onSettingsChange({ bpm })}
          />
          <Flex className="studio-toolbar-group" role="group" aria-label={t('studio.time_signature')}>
            <CommitNumberInput
              aria-label={t('studio.meter_numerator')}
              size="xs" w="42px" value={settings.timeSignature.numerator} min={1} max={16} step={1} precision={0}
              onCommit={numerator => onSettingsChange({
                timeSignature: { ...settings.timeSignature, numerator },
              })}
            />
            <Select.Root
              aria-label={t('studio.meter_denominator')}
              size="xs" w="55px"
              value={String(settings.timeSignature.denominator)}
              items={[2, 4, 8, 16].map(value => ({ label: `/${value}`, value: String(value) }))}
              onChange={value => onSettingsChange({
                timeSignature: {
                  ...settings.timeSignature,
                  denominator: Number(value) as 2 | 4 | 8 | 16,
                },
              })}
            />
          </Flex>
          <Text as="span" className="studio-field-label">{t('studio.snap')}</Text>
          <Select.Root
            aria-label={t('studio.snap')}
            size="xs" w="82px"
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
          <Flex className="studio-time-units" role="group" aria-label={t('studio.time_units')}>
            {timeUnits.map(unit => (
              <Button
                key={unit}
                {...toolButton}
                aria-pressed={settings.timeDisplay === unit}
                onClick={() => onSettingsChange({ timeDisplay: unit })}
              >
                {t(`studio.time_unit_${unit}`)}
              </Button>
            ))}
          </Flex>
        </Flex>

        <Flex className="studio-toolbar-group studio-zoom-controls" role="group" aria-label={t('studio.zoom')}>
          <IconButton
            {...toolButton}
            icon={<MinusIcon boxSize="4" />}
            aria-label={t('studio.zoom_out')}
            title={t('studio.zoom_out')}
            onClick={() => onZoom(pxPerTick / 1.35)}
          />
          <Text as="span" className="studio-zoom-value">
            {Math.round(pxPerTick / DEFAULT_PX_PER_TICK * 100)}
            %
          </Text>
          <IconButton
            {...toolButton}
            icon={<PlusIcon boxSize="4" />}
            aria-label={t('studio.zoom_in')}
            title={t('studio.zoom_in')}
            onClick={() => onZoom(pxPerTick * 1.35)}
          />
          <IconButton
            {...toolButton}
            icon={<MaximizeIcon boxSize="3.5" />}
            aria-label={t('studio.fit_all')}
            title={t('studio.fit_all')}
            onClick={onFitProject}
          />
        </Flex>
      </div>
    </header>
  )
}
