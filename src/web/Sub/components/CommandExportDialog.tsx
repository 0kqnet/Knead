import React, { useEffect, useMemo, useState } from 'react'
import { Box, Button, Flex, Input, Select, Text, Textarea } from '@yamada-ui/react'
import { useTranslation } from 'react-i18next'
import type { TimelineState } from '../types/timeline'
import {
  COMMAND_LISTENER_PAN_LIMITS,
  COMMAND_PAN_MODES,
  COMMAND_VISUALIZER_COLOR_MAPPINGS,
  COMMAND_VISUALIZER_LIMITS,
  COMMAND_VISUALIZER_PLACEMENTS,
  COMMAND_VISUALIZER_TYPES,
  DEFAULT_COMMAND_EXPORT_OPTIONS,
  inferPackFormat,
  inferResourcePackFormat,
  normalizeCommandPanOptions,
  normalizeCommandVisualizerOptions,
  sanitizeNamespace,
  supportsListenerRelativePan,
  type CommandPanMode,
  type CommandVisualizerColorMapping,
  type CommandVisualizerPlacement,
  type CommandVisualizerType,
  type CommandExportOptions,
} from '../utils/commandExport'
import { CommitNumberInput } from '../../components/CommitNumberInput'
import { useModalDialog } from '../hooks/useModalDialog'
import { useStudioExportTask } from '../tasks/studioExportTask'

interface Props {
  open: boolean
  project: TimelineState
  defaultName: string
  onClose: () => void
}

const STORAGE_KEY = 'studio.commandExportOptions'

function loadOptions(project: TimelineState): CommandExportOptions {
  let stored: Partial<CommandExportOptions> = {}
  try {
    stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')
  }
  catch {
    // Ignore a malformed preference and use safe defaults.
  }
  const merged: CommandExportOptions = {
    ...DEFAULT_COMMAND_EXPORT_OPTIONS,
    ...stored,
    packFormat: inferPackFormat(project.targetVersion),
    resourcePackFormat: inferResourcePackFormat(project.targetVersion),
  }
  const visualizer = normalizeCommandVisualizerOptions(
    merged,
    DEFAULT_COMMAND_EXPORT_OPTIONS.visualizerOrigin,
  )
  const pan = normalizeCommandPanOptions(merged, project.targetVersion)
  return {
    ...merged,
    panMode: pan.mode,
    listenerPanWidth: pan.width,
    visualizerType: visualizer.type,
    visualizerOrigin: visualizer.origin,
    visualizerPlacement: visualizer.placement,
    visualizerGlow: visualizer.glow,
    visualizerDensity: visualizer.density,
    visualizerScale: visualizer.scale,
    visualizerColorMapping: visualizer.colorMapping,
  }
}

export const CommandExportDialog: React.FC<Props> = ({ open, project, defaultName, onClose }) => {
  const { t } = useTranslation()
  const [options, setOptions] = useState<CommandExportOptions>(() => loadOptions(project))
  const [advanced, setAdvanced] = useState(false)
  const [savingKind, setSavingKind] = useState<'data-pack' | 'resource-pack' | null>(null)
  const [resultMessage, setResultMessage] = useState('')
  const [copied, setCopied] = useState(false)
  const [generationRetry, setGenerationRetry] = useState(0)
  const {
    state: generation,
    run: runGeneration,
    cancel: cancelGeneration,
    reset: resetGeneration,
  } = useStudioExportTask('command')
  const saving = savingKind !== null
  const { dialogRef } = useModalDialog({ open, busy: saving, onClose })

  useEffect(() => {
    if (!open) return
    setOptions(current => ({
      ...current,
      namespace: sanitizeNamespace(current.namespace || defaultName),
      packFormat: inferPackFormat(project.targetVersion),
      resourcePackFormat: inferResourcePackFormat(project.targetVersion),
    }))
    setResultMessage('')
    setCopied(false)
    setGenerationRetry(0)
  }, [defaultName, open, project.targetVersion])

  useEffect(() => {
    if (!open) {
      resetGeneration()
      return
    }
    // Invalidate the prior preview immediately; only this exact option/project
    // generation may enable save or copy actions.
    resetGeneration()
    const timeout = window.setTimeout(() => {
      void runGeneration({ project, options }).catch(() => {
        // The task state owns cancellation and error presentation.
      })
    }, 60)
    return () => {
      window.clearTimeout(timeout)
      cancelGeneration()
    }
  }, [cancelGeneration, generationRetry, open, options, project, resetGeneration, runGeneration])

  const generated = generation.result
  const diagnosticCounts = useMemo(() => ({
    preserved: generated?.diagnostics.filter(item => item.disposition === 'preserved').length ?? 0,
    baked: generated?.diagnostics.filter(item => item.disposition === 'baked').length ?? 0,
    degraded: generated?.diagnostics.filter(item => item.disposition === 'degraded').length ?? 0,
    omitted: generated?.diagnostics.filter(item => item.disposition === 'omitted').length ?? 0,
  }), [generated])
  const listenerPanSupported = supportsListenerRelativePan(project.targetVersion)
  const functionPath = Object.keys(generated?.files ?? {}).find(path => path.endsWith('/start.mcfunction')) ?? ''
  const preview = generated?.files[functionPath] ?? ''

  if (!open) return null

  const update = (patch: Partial<CommandExportOptions>) => {
    setOptions((current) => {
      const next = { ...current, ...patch }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      return next
    })
  }

  const copyCommands = async () => {
    if (!generated) return
    await navigator.clipboard.writeText([
      generated.startCommand,
      generated.pauseCommand,
      generated.resumeCommand,
      generated.stopCommand,
      generated.uninstallCommand,
    ].join('\n'))
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1600)
  }

  const save = async (kind: 'data-pack' | 'resource-pack') => {
    if (!generated) return
    const resourcePack = generated.resourcePack
    if (kind === 'resource-pack' && !resourcePack) return
    setSavingKind(kind)
    setResultMessage('')
    try {
      const result = await window.myAPI.commandExport.save({
        kind,
        defaultName: kind === 'data-pack'
          ? `${sanitizeNamespace(options.namespace || defaultName)}.zip`
          : `${sanitizeNamespace(options.namespace || defaultName)}-resources.zip`,
        files: kind === 'data-pack' ? generated.files : resourcePack!.files,
      })
      if (result.ok) setResultMessage(t(
        kind === 'data-pack' ? 'studio.command_export_saved' : 'studio.command_resource_pack_saved',
        { path: result.path },
      ))
      else if (!('canceled' in result)) setResultMessage(t('studio.command_export_failed', { error: result.error }))
    }
    catch (error) {
      setResultMessage(t('studio.command_export_failed', { error: String(error) }))
    }
    finally {
      setSavingKind(null)
    }
  }

  return (
    <Box
      position="fixed" inset="0" zIndex="2100" bg="rgba(0,0,0,.75)"
      display="flex" alignItems="center" justifyContent="center"
      onPointerDown={(event) => { if (event.target === event.currentTarget && !saving) onClose() }}
    >
      <Box
        ref={dialogRef} role="dialog" aria-modal="true" aria-label={t('studio.command_export')} tabIndex={-1}
        w="680px" maxW="calc(100vw - 32px)" maxH="92vh" overflowY="auto"
        bg="var(--studio-panel)" borderRadius="lg" boxShadow="xl" p="5"
      >
        <Flex align="start" gap="3">
          <Box>
            <Text fontSize="xl" fontWeight="bold">{t('studio.command_export')}</Text>
            <Text fontSize="sm" color="var(--studio-muted)">{t('studio.command_export_description')}</Text>
          </Box>
          <Box flex="1" />
          <Button size="sm" onClick={onClose} disabled={saving}>×</Button>
        </Flex>

        <Flex mt="4" gap="3" wrap="wrap" align="end">
          <Box flex="1" minW="220px">
            <Text fontSize="xs" mb="1">{t('studio.namespace')}</Text>
            <Input
              data-dialog-initial-focus
              value={options.namespace}
              onChange={event => update({ namespace: event.target.value })}
              onBlur={() => update({ namespace: sanitizeNamespace(options.namespace) })}
              fontFamily="mono"
            />
          </Box>
          <Box>
            <Text fontSize="xs" mb="1">{t('studio.range')}</Text>
            <Select.Root
              w="160px" value={options.range}
              items={[
                { label: t('studio.project_range'), value: 'project' },
                { label: t('studio.loop_range'), value: 'loop' },
              ]}
              onChange={range => update({ range: range as CommandExportOptions['range'] })}
            />
          </Box>
          <Box>
            <Text fontSize="xs" mb="1">{t('studio.command_source')}</Text>
            <Select.Root
              w="130px" value={options.source}
              items={['master', 'music', 'record', 'weather', 'block', 'hostile', 'neutral', 'player', 'ambient', 'voice', 'ui'].map(value => ({ label: value, value }))}
              onChange={source => update({ source })}
            />
          </Box>
        </Flex>

        <Flex mt="3" gap="3" wrap="wrap" align="end">
          <Box>
            <Text fontSize="xs" mb="1">{t('studio.command_audience')}</Text>
            <Select.Root
              w="170px" value={options.audience}
              items={[
                { label: t('studio.audience_all'), value: 'all' },
                { label: t('studio.audience_nearby'), value: 'nearby' },
                { label: t('studio.audience_custom'), value: 'custom' },
              ]}
              onChange={audience => update({ audience: audience as CommandExportOptions['audience'] })}
            />
          </Box>
          {options.audience === 'custom' && (
            <Box flex="1" minW="180px">
              <Text fontSize="xs" mb="1">{t('studio.command_target')}</Text>
              <Input value={options.target} onChange={event => update({ target: event.target.value })} fontFamily="mono" />
            </Box>
          )}
          {options.audience === 'nearby' && (
            <Box>
              <Text fontSize="xs" mb="1">{t('studio.nearby_radius')}</Text>
              <CommitNumberInput
                w="120px" value={options.nearbyRadius} min={1} max={4096} step={1} precision={0}
                onCommit={nearbyRadius => update({ nearbyRadius })}
              />
            </Box>
          )}
          <Box flex="1" minW="200px">
            <Text fontSize="xs" mb="1">{t('studio.command_position')}</Text>
            <Input value={options.position} onChange={event => update({ position: event.target.value })} fontFamily="mono" />
          </Box>
        </Flex>

        <Box mt="3" p="3" bg="var(--studio-frame)" borderRadius="md">
          <Flex align="end" gap="3" wrap="wrap">
            <Box minW="230px">
              <Text fontSize="xs" mb="1" fontWeight="bold">{t('studio.command_pan_mode')}</Text>
              <Select.Root
                aria-label={t('studio.command_pan_mode')}
                value={options.panMode}
                items={COMMAND_PAN_MODES.map(value => ({
                  value,
                  label: t(`studio.command_pan_${value}`),
                }))}
                onChange={panMode => update({ panMode: panMode as CommandPanMode })}
              />
            </Box>
            {options.panMode === 'listener' && (
              <Box>
                <Text fontSize="xs" mb="1">{t('studio.command_pan_width')}</Text>
                <CommitNumberInput
                  aria-label={t('studio.command_pan_width')}
                  w="125px"
                  value={options.listenerPanWidth}
                  min={COMMAND_LISTENER_PAN_LIMITS.widthMin}
                  max={COMMAND_LISTENER_PAN_LIMITS.widthMax}
                  step={0.25}
                  precision={2}
                  onCommit={listenerPanWidth => update({ listenerPanWidth })}
                />
              </Box>
            )}
          </Flex>
          <Text mt="2" fontSize="xs" color={options.panMode === 'listener' && !listenerPanSupported ? 'orange.300' : 'gray.500'}>
            {options.panMode === 'listener'
              ? t(listenerPanSupported
                  ? 'studio.command_pan_listener_hint'
                  : 'studio.command_pan_listener_legacy_hint', { version: project.targetVersion })
              : t('studio.command_pan_world_hint')}
          </Text>
        </Box>

        <Box mt="4" p="3" bg="var(--studio-frame)" borderRadius="md">
          <Flex align="center" gap="3" wrap="wrap">
            <Box minW="190px">
              <Text fontSize="xs" mb="1" fontWeight="bold">{t('studio.command_visualizer')}</Text>
              <Select.Root
                aria-label={t('studio.command_visualizer_type')}
                value={options.visualizerType}
                items={COMMAND_VISUALIZER_TYPES.map(value => ({
                  value,
                  label: t(`studio.command_visualizer_${value}`),
                }))}
                onChange={visualizerType => update({ visualizerType: visualizerType as CommandVisualizerType })}
              />
            </Box>
            {options.visualizerType !== 'off' && (
              <>
                <Box flex="1" minW="210px">
                  <Text fontSize="xs" mb="1">{t('studio.command_visualizer_origin')}</Text>
                  <Input
                    aria-label={t('studio.command_visualizer_origin')}
                    value={options.visualizerOrigin}
                    onChange={event => update({ visualizerOrigin: event.target.value })}
                    fontFamily="mono"
                  />
                </Box>
                <Box minW="135px">
                  <Text fontSize="xs" mb="1">{t('studio.command_visualizer_placement')}</Text>
                  <Select.Root
                    aria-label={t('studio.command_visualizer_placement')}
                    value={options.visualizerPlacement}
                    items={COMMAND_VISUALIZER_PLACEMENTS.map(value => ({
                      value,
                      label: t(`studio.command_visualizer_placement_${value}`),
                    }))}
                    onChange={visualizerPlacement => update({
                      visualizerPlacement: visualizerPlacement as CommandVisualizerPlacement,
                    })}
                  />
                </Box>
              </>
            )}
          </Flex>
          {options.visualizerType !== 'off' && (
            <Flex mt="3" align="end" gap="3" wrap="wrap">
              <Button
                size="sm"
                colorScheme={options.visualizerGlow ? 'yellow' : 'gray'}
                onClick={() => update({ visualizerGlow: !options.visualizerGlow })}
              >
                {t('studio.command_visualizer_glow')}
              </Button>
              <Box>
                <Text fontSize="xs" mb="1">{t('studio.command_visualizer_density')}</Text>
                <CommitNumberInput
                  aria-label={t('studio.command_visualizer_density')}
                  w="105px"
                  value={options.visualizerDensity}
                  min={COMMAND_VISUALIZER_LIMITS.densityMin}
                  max={COMMAND_VISUALIZER_LIMITS.densityMax}
                  step={1}
                  precision={0}
                  onCommit={visualizerDensity => update({ visualizerDensity })}
                />
              </Box>
              <Box>
                <Text fontSize="xs" mb="1">{t('studio.command_visualizer_scale')}</Text>
                <CommitNumberInput
                  aria-label={t('studio.command_visualizer_scale')}
                  w="105px"
                  value={options.visualizerScale}
                  min={COMMAND_VISUALIZER_LIMITS.scaleMin}
                  max={COMMAND_VISUALIZER_LIMITS.scaleMax}
                  step={0.25}
                  precision={2}
                  onCommit={visualizerScale => update({ visualizerScale })}
                />
              </Box>
              <Box minW="150px">
                <Text fontSize="xs" mb="1">{t('studio.command_visualizer_color')}</Text>
                <Select.Root
                  aria-label={t('studio.command_visualizer_color')}
                  value={options.visualizerColorMapping}
                  items={COMMAND_VISUALIZER_COLOR_MAPPINGS.map(value => ({
                    value,
                    label: t(`studio.command_visualizer_color_${value}`),
                  }))}
                  onChange={visualizerColorMapping => update({
                    visualizerColorMapping: visualizerColorMapping as CommandVisualizerColorMapping,
                  })}
                />
              </Box>
            </Flex>
          )}
          <Text mt="2" fontSize="xs" color="var(--studio-muted)">
            {t('studio.command_visualizer_hint')}
          </Text>
        </Box>

        <Flex mt="4" gap="2" align="center" wrap="wrap">
          <Button
            size="sm" colorScheme={options.includeMutedTracks ? 'blue' : 'gray'}
            onClick={() => update({ includeMutedTracks: !options.includeMutedTracks })}
          >
            {t('studio.include_muted')}
          </Button>
          <Button
            size="sm" colorScheme={options.includeStopCommands ? 'blue' : 'gray'}
            onClick={() => update({ includeStopCommands: !options.includeStopCommands })}
          >
            {t('studio.stop_sounds_on_stop')}
          </Button>
          <Button
            size="sm" colorScheme={options.loopPlayback ? 'purple' : 'gray'}
            onClick={() => update({ loopPlayback: !options.loopPlayback })}
          >
            {t('studio.repeat_playback')}
          </Button>
          <Box flex="1" />
          <Box textAlign="right">
            <Text fontSize="sm" color="cyan.200">
              {t('studio.command_export_summary', {
                events: generated?.eventCount ?? 0,
                ticks: generated?.durationTicks ?? 0,
                seconds: ((generated?.durationTicks ?? 0) / 20).toFixed(2),
              })}
            </Text>
            {(generated?.skippedEventCount ?? 0) > 0 && (
              <Text fontSize="xs" color="var(--studio-warning)">
                {t('studio.command_skipped_events', { count: generated?.skippedEventCount ?? 0 })}
              </Text>
            )}
          </Box>
        </Flex>

        <Button mt="3" size="sm" variant="ghost" onClick={() => setAdvanced(value => !value)}>
          {advanced ? '▾' : '▸'}
          {' '}
          {t('studio.advanced')}
        </Button>
        {advanced && (
          <Flex mt="2" gap="4" wrap="wrap" p="3" bg="var(--studio-frame)" borderRadius="md">
            <Box>
              <Text fontSize="xs">{t('studio.pack_format')}</Text>
              <CommitNumberInput
                w="110px" value={options.packFormat} min={1} max={999} step={0.1} precision={1}
                onCommit={packFormat => update({ packFormat })}
              />
            </Box>
            <Box>
              <Text fontSize="xs">{t('studio.resource_pack_format')}</Text>
              <CommitNumberInput
                w="110px" value={options.resourcePackFormat} min={1} max={999} step={0.1} precision={1}
                onCommit={resourcePackFormat => update({ resourcePackFormat })}
              />
            </Box>
            <Box>
              <Text fontSize="xs">{t('studio.min_volume')}</Text>
              <CommitNumberInput
                w="110px" value={options.minVolume} min={0} max={1} step={0.05} precision={2}
                onCommit={minVolume => update({ minVolume })}
              />
            </Box>
            <Box flex="1" minW="240px">
              <Text fontSize="xs">{t('studio.pack_description')}</Text>
              <Input value={options.description} onChange={event => update({ description: event.target.value })} />
            </Box>
          </Flex>
        )}

        {generation.status === 'running' && (
          <Box
            mt="3" p="3" bg="blue.900" border="1px solid" borderColor="blue.500" borderRadius="md"
            aria-label={t('studio.export_generation_status', { defaultValue: 'Export generation status' })}
          >
            <Flex align="center" gap="3">
              <Box flex="1">
                <Text fontSize="sm">
                  {t(`studio.export_stage_${generation.stage ?? 'preparing'}`, {
                    defaultValue: generation.stage ?? 'preparing',
                  })}
                </Text>
                <Box
                  mt="2" h="7px" overflow="hidden" borderRadius="full" bg="var(--studio-raised)"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(generation.progress * 100)}
                  aria-label={t('studio.export_generation_progress', { defaultValue: 'Generating export' })}
                >
                  <Box h="100%" w={`${Math.round(generation.progress * 100)}%`} bg="blue.300" />
                </Box>
              </Box>
              <Text fontSize="xs" minW="42px" textAlign="right">
                {Math.round(generation.progress * 100)}
                %
              </Text>
              <Button size="sm" onClick={cancelGeneration}>
                {t('studio.cancel_generation', { defaultValue: 'Cancel generation' })}
              </Button>
            </Flex>
          </Box>
        )}
        {(generation.status === 'canceled' || generation.status === 'error') && (
          <Flex
            mt="3" p="3" gap="3" align="center" borderRadius="md"
            bg={generation.status === 'error' ? 'red.900' : 'gray.900'}
          >
            <Text flex="1" fontSize="sm" color={generation.status === 'error' ? 'red.200' : 'gray.300'}>
              {generation.status === 'error'
                ? t('studio.export_generation_failed', {
                    defaultValue: 'Generation failed: {{error}}',
                    error: generation.error ?? '',
                  })
                : t('studio.export_generation_canceled', { defaultValue: 'Generation canceled.' })}
            </Text>
            <Button size="sm" onClick={() => setGenerationRetry(value => value + 1)}>
              {t('studio.retry', { defaultValue: 'Retry' })}
            </Button>
          </Flex>
        )}

        {(generated?.warnings.length ?? 0) > 0 && (
          <Box mt="3" p="3" bg="orange.900" border="1px solid" borderColor="orange.500" borderRadius="md">
            {generated?.warnings.map(warning => (
              <Text key={warning} fontSize="xs">
                •
                {' '}
                {t(`studio.command_warning_${warning}`)}
              </Text>
            ))}
          </Box>
        )}

        <Box
          mt="3" p="3" bg="var(--studio-frame)" border="1px solid" borderColor="var(--studio-line)"
          borderRadius="md" aria-label={t('studio.command_diagnostics_title')}
        >
          <Text fontSize="sm" fontWeight="bold">{t('studio.command_diagnostics_title')}</Text>
          <Text mt="1" fontSize="xs" color="var(--studio-muted)">
            {t('studio.command_diagnostics_summary', diagnosticCounts)}
          </Text>
          <Text fontSize="xs" color="var(--studio-muted)">{t('studio.command_diagnostics_report')}</Text>
          <Box mt="2" maxH="150px" overflowY="auto">
            {generated?.diagnostics.map(diagnostic => (
              <Text
                key={diagnostic.code}
                fontSize="xs"
                color={diagnostic.severity === 'error'
                  ? 'red.300'
                  : diagnostic.severity === 'warning' ? 'orange.300' : 'gray.300'}
              >
                {diagnostic.disposition.toUpperCase()}
                {' · '}
                {diagnostic.code}
                {' — '}
                {diagnostic.message}
              </Text>
            ))}
          </Box>
        </Box>

        <Box mt="4">
          <Text fontSize="xs" mb="1" color="var(--studio-muted)">{t('studio.command_preview')}</Text>
          <Textarea value={preview} readOnly h="110px" resize="vertical" fontFamily="mono" fontSize="xs" />
        </Box>

        <Box mt="3" p="3" bg="var(--studio-frame)" borderRadius="md">
          <Text fontSize="sm" fontWeight="bold">{t('studio.command_resource_pack_title')}</Text>
          <Text mt="1" fontSize="xs" color={generated?.resourcePack ? 'green.200' : 'gray.500'}>
            {generated?.resourcePack
              ? t('studio.command_resource_pack_summary', {
                  events: generated.resourcePack.eventCount,
                  variants: generated.resourcePack.variantCount,
                  assets: generated.resourcePack.assetCount,
                  size: (generated.resourcePack.byteLength / 1024 / 1024).toFixed(2),
                })
              : t('studio.command_resource_pack_empty')}
          </Text>
          <Text mt="1" fontSize="xs" color="var(--studio-muted)">{t('studio.command_resource_pack_hint')}</Text>
        </Box>

        <Box mt="3" p="3" bg="var(--studio-frame)" borderRadius="md">
          <Text fontSize="xs" color="var(--studio-muted)">{t('studio.after_install')}</Text>
          <Flex mt="1" gapX="4" gapY="1" wrap="wrap">
            <Text minW="200px" fontFamily="mono" color="green.200">{generated?.startCommand ?? '—'}</Text>
            <Text minW="200px" fontFamily="mono" color="var(--studio-warning)">{generated?.pauseCommand ?? '—'}</Text>
            <Text minW="200px" fontFamily="mono" color="cyan.200">{generated?.resumeCommand ?? '—'}</Text>
            <Text minW="200px" fontFamily="mono" color="var(--studio-error)">{generated?.stopCommand ?? '—'}</Text>
            <Text minW="200px" fontFamily="mono" color="var(--studio-warning)">{generated?.uninstallCommand ?? '—'}</Text>
          </Flex>
          <Text mt="2" fontSize="xs" color="var(--studio-muted)">{t('studio.pause_resume_hint')}</Text>
        </Box>

        {resultMessage && <Text mt="3" fontSize="sm" color={resultMessage.includes('失敗') || resultMessage.includes('Failed') ? 'red.300' : 'green.300'}>{resultMessage}</Text>}

        <Flex mt="5" justify="flex-end" gap="2">
          <Button onClick={copyCommands} disabled={!generated || generation.status === 'running'}>
            {copied ? t('studio.copied') : t('studio.copy_commands')}
          </Button>
          <Button onClick={onClose} disabled={saving}>{t('studio.close')}</Button>
          <Button
            colorScheme="purple"
            onClick={() => void save('resource-pack')}
            loading={savingKind === 'resource-pack'}
            disabled={!generated?.resourcePack || saving || generation.status === 'running'}
          >
            {t('studio.export_companion_resource_pack')}
          </Button>
          <Button
            colorScheme="green"
            onClick={() => void save('data-pack')}
            loading={savingKind === 'data-pack'}
            disabled={!generated || generated.eventCount === 0 || saving || generation.status === 'running'}
          >
            {t('studio.export_datapack')}
          </Button>
        </Flex>
      </Box>
    </Box>
  )
}
