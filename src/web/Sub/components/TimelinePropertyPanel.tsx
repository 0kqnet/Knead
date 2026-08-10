import React, { useMemo, useState } from 'react'
import { Box, Button, Flex, Select, SelectItem, Slider, Text } from '@yamada-ui/react'
import { useTranslation } from 'react-i18next'
import {
  DEFAULT_RETRIGGER_INTERVAL,
  MAX_GATE_TICKS,
  MAX_MARKER_PITCH,
  MAX_SOUND_STOP_TRACK,
  MIN_MARKER_PITCH,
  SINGLE_SHOT_CURVE_PREVIEW_TICKS,
  isSoundStopMarker,
  type Curve,
  type Marker,
  type Track,
} from '../types/timeline'
import { AudioSelectDropdown } from './AudioSelectDropdown'
import { CurveEditor } from './CurveEditor'
import { CommitNumberInput } from '../../components/CommitNumberInput'

const PITCH_SNAP_VALUES = Array.from({ length: 25 }, (_, index) => 2 ** ((index - 12) / 12))
const PITCH_NOTE_NAMES = ['F#', 'G', 'G#', 'A', 'A#', 'B', 'C', 'C#', 'D', 'D#', 'E', 'F']
const PITCH_SNAP_LABELS = Array.from({ length: 25 }, (_, index) => PITCH_NOTE_NAMES[index % 12])

interface Props {
  marker: Marker | null
  selectionCount: number
  selectedMarkers: Marker[]
  tracks: Track[]
  soundIdList: string[]
  variants: { path: string, hash: string }[]
  onChange: (patch: Partial<Marker>) => void
  onShiftTick: (delta: number) => void
  onBeginEdit: () => void
  onEndEdit: () => void
  soundFocusRequest: number
  onSoundFocusHandled: () => void
}

const PANEL_HEIGHT = 200
const PANEL_HEIGHT_WITH_CURVES = 420
const MIXED = Symbol('mixed')

function commonValue<TMarker extends Marker, T>(
  items: TMarker[],
  get: (marker: TMarker) => T,
): T | typeof MIXED | null {
  if (items.length === 0) return null
  const first = get(items[0])
  for (let i = 1; i < items.length; i++) {
    if (get(items[i]) !== first) return MIXED
  }
  return first
}

export const TimelinePropertyPanel: React.FC<Props> = React.memo(function TimelinePropertyPanel({
  marker, selectionCount, selectedMarkers, tracks, soundIdList, variants,
  onChange, onShiftTick, onBeginEdit, onEndEdit, soundFocusRequest, onSoundFocusHandled,
}: Props) {
  const { t } = useTranslation()
  const [tickShift, setTickShift] = useState<number>(0)

  const variantItems: SelectItem[] = useMemo(() => [
    { label: 'ランダム', value: '-1' },
    ...variants.map((v, i) => ({ label: v.path, value: `${i}` })),
  ], [variants])

  if (selectionCount === 0) {
    return (
      <Box
        h={`${PANEL_HEIGHT}px`} bg="gray.900" borderTop="1px solid" borderColor="gray.700"
        display="flex" alignItems="center" justifyContent="center"
      >
        <Text color="gray.500">マーカーを選択してください</Text>
      </Box>
    )
  }

  const isMulti = selectionCount >= 2
  const soundStopMarkers = selectedMarkers.filter(isSoundStopMarker)
  const hasSoundStops = soundStopMarkers.length > 0
  const onlySoundStops = soundStopMarkers.length === selectedMarkers.length
  const showCurves = !isMulti && marker !== null
  const curveKeyframes = [
    ...(marker?.volumeCurve?.keyframes ?? []),
    ...(marker?.pitchCurve?.keyframes ?? []),
  ]
  const curveDuration = marker?.duration && marker.duration > 0
    ? marker.duration
    : Math.max(SINGLE_SHOT_CURVE_PREVIEW_TICKS, ...curveKeyframes.map(keyframe => keyframe.tick))
  const pitchCurveValues = marker?.pitchCurve?.keyframes.flatMap(keyframe => [
    keyframe.value,
    ...(keyframe.handleL ? [keyframe.value + keyframe.handleL.dv] : []),
    ...(keyframe.handleR ? [keyframe.value + keyframe.handleR.dv] : []),
  ]) ?? []
  const pitchEditorMin = Math.max(
    MIN_MARKER_PITCH,
    Math.min(0.5, marker?.pitch ?? 1, ...pitchCurveValues),
  )
  const pitchEditorMax = Math.min(
    MAX_MARKER_PITCH,
    Math.max(2, marker?.pitch ?? 1, ...pitchCurveValues),
  )

  const soundIdCommon = commonValue(selectedMarkers, m => m.soundId)
  const variantCommon = commonValue(selectedMarkers, m => m.variantIndex)
  const volumeCommon = commonValue(selectedMarkers, m => m.volume)
  const pitchCommon = commonValue(selectedMarkers, m => m.pitch)
  const panCommon = commonValue(selectedMarkers, m => m.pan ?? 0)
  const gateCommon = commonValue(selectedMarkers, m => m.gateTicks ?? 0)
  const durationCommon = commonValue(selectedMarkers, m => m.duration ?? 0)
  const retriggerCommon = commonValue(selectedMarkers, m => m.retriggerInterval ?? DEFAULT_RETRIGGER_INTERVAL)

  const displayVal = (v: unknown) => (v === MIXED || v === null ? '' : String(v))
  const displayNum = (v: unknown, fallback: number) => (
    v === MIXED || v === null
      ? fallback
      : (v as number)
  )
  const isMixed = (v: unknown) => v === MIXED

  const tickControl = !isMulti && marker !== null
    ? (
        <Box w="120px">
          <Text fontSize="sm" color="gray.400" mb="1">Tick</Text>
          <CommitNumberInput
            value={marker.tick}
            min={0} step={1} precision={0}
            onCommit={tick => onChange({ tick })}
            w="120px"
          />
        </Box>
      )
    : (
        <Box w="240px">
          <Text fontSize="sm" color="gray.400" mb="1">Tick シフト (選択全体)</Text>
          <Flex gap="2">
            <CommitNumberInput
              value={tickShift} step={1} precision={0}
              onCommit={setTickShift}
              w="100px"
            />
            <Button
              size="sm"
              onClick={() => {
                if (tickShift === 0) return
                onShiftTick(tickShift)
                setTickShift(0)
              }}
              isDisabled={tickShift === 0 || selectedMarkers.length === 0}
            >
              適用
            </Button>
          </Flex>
        </Box>
      )

  if (hasSoundStops) {
    const scopeCommon = onlySoundStops
      ? commonValue(soundStopMarkers, item => item.action.scope)
      : MIXED
    const startCommon = onlySoundStops
      ? commonValue(soundStopMarkers, item => item.action.scope === 'track-range' ? item.action.startTrack ?? 1 : 1)
      : MIXED
    const endCommon = onlySoundStops
      ? commonValue(soundStopMarkers, item => item.action.scope === 'track-range' ? item.action.endTrack ?? 1 : 1)
      : MIXED
    const fallbackTrack = marker
      ? Math.max(1, tracks.findIndex(track => track.id === marker.trackId) + 1)
      : 1
    const start = displayNum(startCommon, fallbackTrack)
    const end = Math.max(start, displayNum(endCommon, start))
    return (
      <Box
        h={`${PANEL_HEIGHT}px`}
        bg="gray.900" borderTop="1px solid" borderColor="gray.700"
        p="4" overflowY="auto"
      >
        <Flex gap="6" wrap="wrap" align="flex-start">
          {tickControl}
          <Box minW="180px">
            <Text fontSize="sm" color="rose.300" mb="1">{t('studio.sound_stopper_title')}</Text>
            <Text fontSize="xs" color="gray.400">
              {onlySoundStops
                ? t('studio.sound_stopper_description')
                : t('studio.sound_stopper_mixed_description')}
            </Text>
          </Box>
          {onlySoundStops && (
            <>
              <Box w="190px">
                <Text fontSize="sm" color="gray.400" mb="1">{t('studio.sound_stopper_scope')}</Text>
                <Select
                  aria-label={t('studio.sound_stopper_scope')}
                  value={scopeCommon === MIXED ? '' : scopeCommon ?? 'all'}
                  items={[
                    { label: t('studio.sound_stopper_scope_all'), value: 'all' },
                    { label: t('studio.sound_stopper_scope_range'), value: 'track-range' },
                  ]}
                  placeholder={scopeCommon === MIXED ? t('studio.sound_stopper_mixed') : undefined}
                  placeholderInOptions={false}
                  onChange={(scope) => {
                    if (scope === 'all') onChange({ action: { type: 'sound-stop', scope: 'all' } })
                    else {
                      onChange({
                        action: {
                          type: 'sound-stop',
                          scope: 'track-range',
                          startTrack: start,
                          endTrack: end,
                        },
                      })
                    }
                  }}
                />
              </Box>
              {scopeCommon !== 'all' && (
                <>
                  <Box w="140px">
                    <Text fontSize="sm" color="gray.400" mb="1">{t('studio.sound_stopper_start_track')}</Text>
                    <CommitNumberInput
                      aria-label={t('studio.sound_stopper_start_track')}
                      value={start}
                      min={1} max={MAX_SOUND_STOP_TRACK} step={1} precision={0}
                      onCommit={startTrack => onChange({
                        action: {
                          type: 'sound-stop',
                          scope: 'track-range',
                          startTrack,
                          endTrack: Math.max(startTrack, end),
                        },
                      })}
                      w="140px"
                    />
                  </Box>
                  <Box w="140px">
                    <Text fontSize="sm" color="gray.400" mb="1">{t('studio.sound_stopper_end_track')}</Text>
                    <CommitNumberInput
                      aria-label={t('studio.sound_stopper_end_track')}
                      value={end}
                      min={start} max={MAX_SOUND_STOP_TRACK} step={1} precision={0}
                      onCommit={endTrack => onChange({
                        action: {
                          type: 'sound-stop',
                          scope: 'track-range',
                          startTrack: start,
                          endTrack,
                        },
                      })}
                      w="140px"
                    />
                  </Box>
                </>
              )}
            </>
          )}
        </Flex>
      </Box>
    )
  }

  return (
    <Box
      h={`${showCurves ? PANEL_HEIGHT_WITH_CURVES : PANEL_HEIGHT}px`}
      bg="gray.900" borderTop="1px solid" borderColor="gray.700"
      p="4" overflowY="auto"
    >
      <Flex gap="6" wrap="wrap" align="flex-start">
        {tickControl}

        <Box w="240px">
          <Text fontSize="sm" color="gray.400" mb="1">
            Sound
            {isMixed(soundIdCommon) && (
              <Text as="span" color="yellow.400" ml="2">(混在)</Text>
            )}
          </Text>
          <AudioSelectDropdown
            options={soundIdList}
            value={displayVal(soundIdCommon)}
            placeholder={isMixed(soundIdCommon) ? '(混在)' : '(未指定)'}
            onSelect={v => onChange({ soundId: v, variantIndex: -1 })}
            focusRequest={soundFocusRequest}
            onFocusRequestHandled={onSoundFocusHandled}
          />
        </Box>

        <Box w="320px">
          <Text fontSize="sm" color="gray.400" mb="1">
            Variant
            {isMixed(variantCommon) && (
              <Text as="span" color="yellow.400" ml="2">(混在)</Text>
            )}
          </Text>
          <Select
            value={isMixed(variantCommon) ? '' : String(variantCommon ?? -1)}
            items={variantItems}
            onChange={v => onChange({ variantIndex: parseInt(v, 10) })}
            disabled={variants.length === 0 || isMixed(soundIdCommon)}
            w="320px"
            placeholder={isMixed(variantCommon) ? '(混在)' : undefined}
            placeholderInOptions={false}
          />
        </Box>

        <Box w="120px">
          <Text fontSize="sm" color="gray.400" mb="1">
            Volume
            {isMixed(volumeCommon) && (
              <Text as="span" color="yellow.400" ml="2">(混在)</Text>
            )}
          </Text>
          <CommitNumberInput
            value={displayNum(volumeCommon, 1)}
            min={0} max={1} step={0.1} precision={2}
            onCommit={volume => onChange({ volume })}
            w="120px"
          />
        </Box>

        <Box w="220px">
          <Text fontSize="sm" color="gray.400" mb="1">
            Pitch
            {isMixed(pitchCommon) && (
              <Text as="span" color="yellow.400" ml="2">(混在)</Text>
            )}
          </Text>
          <CommitNumberInput
            aria-label="Marker pitch"
            value={displayNum(pitchCommon, 1)}
            min={MIN_MARKER_PITCH} max={MAX_MARKER_PITCH} step={0.001} precision={9}
            onCommit={pitch => onChange({ pitch })}
            w="220px"
          />
          <Text fontSize="xs" color="gray.500" mt="1">Minecraft quick range (0.5–2)</Text>
          <Slider
            aria-label="Minecraft pitch quick slider"
            value={Math.max(0.5, Math.min(2, displayNum(pitchCommon, 1)))}
            onChange={value => onChange({ pitch: value })}
            w="220px" h={8} step={0.01} min={0.5} max={2}
            filledTrackColor="gray.200" trackColor="gray.200" thumbColor="primary"
            thumbSize={2.5}
            focusThumbOnChange={false} readOnly={false}
            thumbProps={{
              _disabled: { color: 'primary' },
            }}
          />
        </Box>

        <Box w="220px">
          <Text fontSize="sm" color="gray.400" mb="1">
            Pan:
            {' '}
            {isMixed(panCommon) ? '(混在)' : (panCommon as number ?? 0).toFixed(2)}
          </Text>
          <Slider
            aria-label="Marker pan"
            value={displayNum(panCommon, 0)}
            onChange={value => onChange({ pan: value })}
            w="220px" h={10} step={0.01} min={-1} max={1}
            filledTrackColor="cyan.300" trackColor="gray.600" thumbColor="cyan.300"
            thumbSize={2.5}
            focusThumbOnChange={false} readOnly={false}
            thumbProps={{
              _disabled: { color: 'cyan.300' },
            }}
          />
          <Flex justify="space-between" mt="-1">
            <Text fontSize="xs" color="gray.500">L</Text>
            <Text fontSize="xs" color="gray.500">C</Text>
            <Text fontSize="xs" color="gray.500">R</Text>
          </Flex>
        </Box>

        <Box w="140px">
          <Text fontSize="sm" color="gray.400" mb="1">
            Duration (tick)
            {isMixed(durationCommon) && (
              <Text as="span" color="yellow.400" ml="2">(混在)</Text>
            )}
          </Text>
          <CommitNumberInput
            value={displayNum(durationCommon, 0)}
            min={0} step={1} precision={0}
            onCommit={duration => onChange({ duration: duration > 0 ? duration : undefined })}
            w="140px"
          />
          <Text fontSize="xs" color="gray.500" mt="1">0 = 単発</Text>
        </Box>

        <Box w="150px">
          <Text fontSize="sm" color="gray.400" mb="1">
            {t('studio.marker_gate_ticks')}
            {isMixed(gateCommon) && (
              <Text as="span" color="yellow.400" ml="2">
                {`(${t('studio.sound_stopper_mixed')})`}
              </Text>
            )}
          </Text>
          <CommitNumberInput
            aria-label={t('studio.marker_gate_ticks')}
            value={displayNum(gateCommon, 0)}
            min={0} max={MAX_GATE_TICKS} step={1} precision={0}
            onCommit={gateTicks => onChange({ gateTicks: gateTicks > 0 ? gateTicks : undefined })}
            w="150px"
          />
          <Text mt="1" fontSize="xs" color="gray.500">{t('studio.marker_gate_sample_tail')}</Text>
        </Box>

        <Box w="180px">
          <Text fontSize="sm" color="gray.400" mb="1">
            Retrigger Interval (tick)
            {isMixed(retriggerCommon) && (
              <Text as="span" color="yellow.400" ml="2">(混在)</Text>
            )}
          </Text>
          <CommitNumberInput
            value={displayNum(retriggerCommon, DEFAULT_RETRIGGER_INTERVAL)}
            min={1} step={1} precision={0}
            onCommit={retriggerInterval => onChange({ retriggerInterval })}
            w="180px"
          />
          <Text fontSize="xs" color="gray.500" mt="1">連続モード時のみ有効</Text>
        </Box>
      </Flex>

      {showCurves && marker !== null && (
        <Flex gap="6" mt="4" wrap="wrap">
          <CurveEditor
            label="Volume カーブ"
            duration={curveDuration}
            valueMin={0} valueMax={Math.max(1, marker.volume)}
            fallback={marker.volume}
            curve={marker.volumeCurve}
            valueTooltip
            onChange={(next: Curve | undefined) => onChange({ volumeCurve: next })}
            onBeginEdit={onBeginEdit}
            onEndEdit={onEndEdit}
          />
          <CurveEditor
            label="Pitch カーブ"
            duration={curveDuration}
            valueMin={pitchEditorMin} valueMax={pitchEditorMax}
            fallback={marker.pitch}
            curve={marker.pitchCurve}
            referenceValue={1}
            snapValues={PITCH_SNAP_VALUES}
            snapValueLabels={PITCH_SNAP_LABELS}
            valueTooltip
            warningRange={{ min: 0.5, max: 2.0 }}
            onChange={(next: Curve | undefined) => onChange({ pitchCurve: next })}
            onBeginEdit={onBeginEdit}
            onEndEdit={onEndEdit}
          />
        </Flex>
      )}
    </Box>
  )
})
