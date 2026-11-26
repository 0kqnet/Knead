import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Button, Checkbox, Flex, Input, Select, Text } from '@yamada-ui/react'
import { useTranslation } from 'react-i18next'
import { MAX_GATE_TICKS, type Marker, type TimelineState } from '../types/timeline'
import {
  normalizeLiveMidiTimestampMs,
  useLiveMidi,
  type LiveMidiMessage,
} from '../hooks/useLiveMidi'
import { useModalDialog } from '../hooks/useModalDialog'
import {
  MIDI_IMPORT_LIMITS,
  MIDI_QUANTIZE_STEPS,
  parseMidi,
  type MidiNoteLengthMode,
  type MidiQuantizeStep,
  type MidiSong,
  type MidiSoundMapping,
} from '../utils/midi'
import { buildMidiImportPreview } from '../utils/midiPreview'

export interface LiveMidiRecordedNote {
  channel: number
  note: number
  velocity: number
  pitch: number
  soundId: string
}

interface ActiveLiveVoice {
  id: string
  note: number
  channel: number
  released: boolean
  startedAtTick: number
  startedAtTimestampMs: number
  generation: number
  updateRecordedNote: (id: string, patch: Partial<Marker>) => void
}

interface SelectedMidiFile {
  path: string
  song: MidiSong
  parseWarnings: readonly string[]
}

function activeVoiceCount(voices: ReadonlyMap<string, readonly ActiveLiveVoice[]>): number {
  let count = 0
  for (const queue of voices.values()) count += queue.length
  return count
}

export function liveMidiGateTicks(startedAtTimestampMs: number, endedAtTimestampMs: number): number {
  const elapsedMs = Math.max(0, endedAtTimestampMs - startedAtTimestampMs)
  return Math.max(1, Math.min(MAX_GATE_TICKS, Math.round(elapsedMs / 50)))
}

function liveMidiNowMs(): number {
  return normalizeLiveMidiTimestampMs(
    typeof performance !== 'undefined' ? performance.now() : 0,
  )
}

interface Props {
  open: boolean
  targetVersion: string
  currentTick: number
  canRecord: boolean
  soundIds: readonly string[]
  defaultSoundId: string
  onImport: (state: TimelineState, warnings: string[], sourcePath: string) => Promise<boolean>
  onRecordNote: (note: LiveMidiRecordedNote) => string
  onUpdateRecordedNote: (id: string, patch: Partial<Marker>) => void
  onBeginRecording: () => void
  onEndRecording: () => void
  onClose: () => void
}

function decodeBase64(value: string): Uint8Array {
  const maxEncodedLength = 4 * Math.ceil(MIDI_IMPORT_LIMITS.maxBytes / 3)
  if (!value || value.length > maxEncodedLength) {
    throw new Error(`MIDI file size must be between 1 and ${MIDI_IMPORT_LIMITS.maxBytes} bytes`)
  }
  const binary = atob(value)
  if (!binary.length || binary.length > MIDI_IMPORT_LIMITS.maxBytes) {
    throw new Error(`MIDI file size must be between 1 and ${MIDI_IMPORT_LIMITS.maxBytes} bytes`)
  }
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function noteName(note: number): string {
  const names = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
  return `${names[note % 12]}${Math.floor(note / 12) - 1}`
}

function livePitch(note: number, rootNote: number, bend: number): number {
  return Math.max(0.5, Math.min(2, 2 ** ((note - rootNote + bend * 2) / 12)))
}

export const MidiDialog: React.FC<Props> = ({
  open,
  targetVersion,
  currentTick,
  canRecord,
  soundIds,
  defaultSoundId,
  onImport,
  onRecordNote,
  onUpdateRecordedNote,
  onBeginRecording,
  onEndRecording,
  onClose,
}) => {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [selectedMidiFile, setSelectedMidiFile] = useState<SelectedMidiFile | null>(null)
  const [channelFilter, setChannelFilter] = useState('all')
  const [soundMapping, setSoundMapping] = useState<MidiSoundMapping>('minecraft')
  const [quantizeStep, setQuantizeStep] = useState<MidiQuantizeStep>(0)
  const [noteLengthMode, setNoteLengthMode] = useState<MidiNoteLengthMode>('note-off-gate')
  const [tailFadeEnabled, setTailFadeEnabled] = useState(false)
  const [tailFadeStartPercent, setTailFadeStartPercent] = useState(50)
  const [tailFadeEndPercent, setTailFadeEndPercent] = useState(50)
  const [channelSoundOverrides, setChannelSoundOverrides] = useState<Record<number, string>>({})
  const [rootNote, setRootNote] = useState(66)
  const [liveSoundId, setLiveSoundId] = useState(defaultSoundId || 'block.note_block.harp')
  const [activeNoteCount, setActiveNoteCount] = useState(0)
  const bendsRef = useRef(Array.from({ length: 16 }, () => 0))
  const sustainRef = useRef(Array.from({ length: 16 }, () => false))
  const activeRef = useRef(new Map<string, ActiveLiveVoice[]>())
  const currentTickRef = useRef(currentTick)
  const recordingTransactionRef = useRef(false)
  const recordingGenerationRef = useRef(0)
  const armedRef = useRef(false)
  const previousOpenRef = useRef(false)
  const previousArmedRef = useRef(false)
  const mountedRef = useRef(true)
  const openRef = useRef(open)
  const canRecordRef = useRef(canRecord)
  const busyRef = useRef(false)
  const lifecycleGenerationRef = useRef(0)
  const armAttemptRef = useRef(0)
  const armPendingRef = useRef(false)
  const selectedMidiFileRef = useRef(selectedMidiFile)
  currentTickRef.current = currentTick
  openRef.current = open
  canRecordRef.current = canRecord
  selectedMidiFileRef.current = selectedMidiFile

  const previewResult = useMemo(() => selectedMidiFile
    ? buildMidiImportPreview(
        selectedMidiFile.song,
        selectedMidiFile.parseWarnings,
        targetVersion,
        {
          soundMapping,
          quantizeStep,
          noteLengthMode,
          tailFade: {
            enabled: tailFadeEnabled,
            startPercent: tailFadeStartPercent,
            endPercent: tailFadeEndPercent,
          },
          channelSoundOverrides,
        },
      )
    : null, [
    channelSoundOverrides,
    noteLengthMode,
    quantizeStep,
    selectedMidiFile,
    soundMapping,
    tailFadeEnabled,
    tailFadeEndPercent,
    tailFadeStartPercent,
    targetVersion,
  ])

  const previewChannels = useMemo(() => {
    if (!selectedMidiFile) return []
    const channels = new Set<number>()
    for (const track of selectedMidiFile.song.tracks) {
      for (const channel of track.channels) channels.add(channel)
    }
    return [...channels].sort((left, right) => left - right).slice(0, 16)
  }, [selectedMidiFile])

  const invalidateAsyncWork = useCallback(() => {
    lifecycleGenerationRef.current++
    armAttemptRef.current++
  }, [])

  const clearLiveState = useCallback(() => {
    activeRef.current.clear()
    sustainRef.current.fill(false)
    bendsRef.current.fill(0)
    setActiveNoteCount(0)
  }, [])

  const finishRecording = useCallback(() => {
    if (!recordingTransactionRef.current) return
    recordingTransactionRef.current = false
    recordingGenerationRef.current++
    onEndRecording()
  }, [onEndRecording])

  const finishVoiceAt = useCallback((voice: ActiveLiveVoice, endedAtTimestampMs: number) => {
    if (
      !mountedRef.current || !openRef.current || !canRecordRef.current
      || !recordingTransactionRef.current
      || voice.generation !== recordingGenerationRef.current
    ) return
    const gateTicks = liveMidiGateTicks(voice.startedAtTimestampMs, endedAtTimestampMs)
    // Use the callback captured at note-on so a tab/callback swap cannot apply
    // the note-off to a different document that happens to reuse the marker ID.
    voice.updateRecordedNote(voice.id, { gateTicks })
  }, [])

  const finishAllVoicesAt = useCallback((endedAtTimestampMs: number) => {
    for (const voices of activeRef.current.values()) {
      for (const voice of voices) finishVoiceAt(voice, endedAtTimestampMs)
    }
    clearLiveState()
  }, [clearLiveState, finishVoiceAt])

  const handleMidiMessage = useCallback((event: LiveMidiMessage) => {
    if (
      !armedRef.current || !mountedRef.current || !openRef.current
      || !canRecordRef.current || !recordingTransactionRef.current
    ) return
    if (channelFilter !== 'all' && event.channel !== Number(channelFilter)) return
    if (event.type === 'pitch-bend') {
      bendsRef.current[event.channel] = event.value
      for (const voices of activeRef.current.values()) {
        for (const active of voices) {
          if (active.channel !== event.channel) continue
          active.updateRecordedNote(active.id, { pitch: livePitch(active.note, rootNote, event.value) })
        }
      }
      return
    }
    if (event.type === 'control-change') {
      if (event.controller === 64) {
        const pressed = event.value >= 0.5
        sustainRef.current[event.channel] = pressed
        if (!pressed) {
          for (const [key, voices] of activeRef.current) {
            const remaining = voices.filter((voice) => {
              if (voice.channel !== event.channel || !voice.released) return true
              // MIDI sustain releases every deferred note at the pedal-up tick.
              finishVoiceAt(voice, event.timestampMs)
              return false
            })
            if (remaining.length > 0) activeRef.current.set(key, remaining)
            else activeRef.current.delete(key)
          }
          setActiveNoteCount(activeVoiceCount(activeRef.current))
        }
      }
      return
    }
    const key = `${event.channel}:${event.note}`
    if (event.type === 'note-off') {
      const voices = activeRef.current.get(key)
      const index = voices?.findIndex(voice => !voice.released) ?? -1
      if (voices && index >= 0) {
        if (sustainRef.current[event.channel]) voices[index].released = true
        else {
          finishVoiceAt(voices[index], event.timestampMs)
          voices.splice(index, 1)
        }
        if (voices.length === 0) activeRef.current.delete(key)
      }
      setActiveNoteCount(activeVoiceCount(activeRef.current))
      return
    }
    const bend = bendsRef.current[event.channel]
    const id = onRecordNote({
      channel: event.channel,
      note: event.note,
      velocity: event.velocity,
      pitch: livePitch(event.note, rootNote, bend),
      soundId: liveSoundId.trim() || defaultSoundId || 'block.note_block.harp',
    })
    if (!id) return
    const voices = activeRef.current.get(key) ?? []
    voices.push({
      id,
      note: event.note,
      channel: event.channel,
      released: false,
      startedAtTick: currentTickRef.current,
      startedAtTimestampMs: event.timestampMs,
      generation: recordingGenerationRef.current,
      updateRecordedNote: onUpdateRecordedNote,
    })
    activeRef.current.set(key, voices)
    setActiveNoteCount(activeVoiceCount(activeRef.current))
  }, [channelFilter, defaultSoundId, finishVoiceAt, liveSoundId, onRecordNote, onUpdateRecordedNote, rootNote])

  const liveMidi = useLiveMidi({ onMessage: handleMidiMessage })
  const setMidiArmed = liveMidi.setArmed
  const clearLiveMidiError = liveMidi.clearError
  const finishRecordingRef = useRef(finishRecording)
  finishRecordingRef.current = finishRecording

  useEffect(() => {
    const wasOpen = previousOpenRef.current
    previousOpenRef.current = open
    if (wasOpen !== open) lifecycleGenerationRef.current++
    if (open) {
      if (!wasOpen) {
        setMessage('')
        setSelectedMidiFile(null)
        setSoundMapping('minecraft')
        setQuantizeStep(0)
        setNoteLengthMode('note-off-gate')
        setTailFadeEnabled(false)
        setTailFadeStartPercent(50)
        setTailFadeEndPercent(50)
        setChannelSoundOverrides({})
        clearLiveMidiError()
        setLiveSoundId(defaultSoundId || 'block.note_block.harp')
      }
      return
    }
    armAttemptRef.current++
    setMidiArmed(false)
    clearLiveState()
    finishRecording()
  }, [clearLiveMidiError, clearLiveState, defaultSoundId, finishRecording, open, setMidiArmed])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      openRef.current = false
      invalidateAsyncWork()
      finishRecordingRef.current()
    }
  }, [invalidateAsyncWork])

  useEffect(() => {
    const wasArmed = previousArmedRef.current
    previousArmedRef.current = liveMidi.armed
    if (wasArmed && !liveMidi.armed) {
      armedRef.current = false
      clearLiveState()
      finishRecording()
    }
  }, [clearLiveState, finishRecording, liveMidi.armed])

  useEffect(() => {
    if (canRecord || !liveMidi.armed) return
    armAttemptRef.current++
    armedRef.current = false
    setMidiArmed(false)
  }, [canRecord, liveMidi.armed, setMidiArmed])

  const selectMidiFile = async () => {
    if (busyRef.current || armPendingRef.current || liveMidi.armed || !openRef.current) return
    const generation = lifecycleGenerationRef.current
    busyRef.current = true
    setBusy(true)
    setMessage('')
    clearLiveMidiError()
    try {
      const result = await window.myAPI.midi.open()
      if (
        !mountedRef.current || !openRef.current
        || lifecycleGenerationRef.current !== generation
      ) return
      if (!result.ok) {
        if (!('canceled' in result)) setMessage(t('studio.midi_error', { error: result.error }))
        return
      }
      const parsed = parseMidi(decodeBase64(result.dataBase64))
      if (!parsed.ok) {
        setSelectedMidiFile(null)
        setMessage(t('studio.midi_error', { error: parsed.error }))
        return
      }
      setChannelSoundOverrides({})
      setSelectedMidiFile({
        path: result.path,
        song: parsed.song,
        parseWarnings: parsed.warnings,
      })
    }
    catch (error) {
      if (
        mountedRef.current && openRef.current
        && lifecycleGenerationRef.current === generation
      ) setMessage(t('studio.midi_error', { error: String(error) }))
    }
    finally {
      busyRef.current = false
      if (mountedRef.current) setBusy(false)
    }
  }

  const applyMidiPreview = async () => {
    if (
      busyRef.current || armPendingRef.current || liveMidi.armed || !openRef.current
      || !selectedMidiFile || !previewResult?.ok
    ) return
    const generation = lifecycleGenerationRef.current
    const ownerFile = selectedMidiFile
    const ownerImport = onImport
    const { state, warnings } = previewResult.preview
    busyRef.current = true
    setBusy(true)
    setMessage('')
    clearLiveMidiError()
    try {
      const applied = await ownerImport(state, [...warnings], ownerFile.path)
      if (
        applied && mountedRef.current && openRef.current
        && lifecycleGenerationRef.current === generation
        && selectedMidiFileRef.current === ownerFile
      ) onClose()
    }
    catch (error) {
      if (
        mountedRef.current && openRef.current
        && lifecycleGenerationRef.current === generation
        && selectedMidiFileRef.current === ownerFile
      ) setMessage(t('studio.midi_error', { error: String(error) }))
    }
    finally {
      busyRef.current = false
      if (mountedRef.current) setBusy(false)
    }
  }

  const toggleArmed = async () => {
    if (busyRef.current || armPendingRef.current || !canRecordRef.current || !openRef.current) return
    if (liveMidi.armed) {
      armAttemptRef.current++
      finishAllVoicesAt(liveMidiNowMs())
      armedRef.current = false
      liveMidi.setArmed(false)
      finishRecording()
      return
    }
    const attempt = ++armAttemptRef.current
    armPendingRef.current = true
    try {
      if (!(await liveMidi.requestAccess())) return
      if (
        !mountedRef.current || !openRef.current || !canRecordRef.current
        || busyRef.current || armAttemptRef.current !== attempt
      ) return
      setMessage('')
      clearLiveState()
      recordingGenerationRef.current++
      recordingTransactionRef.current = true
      try {
        onBeginRecording()
        armedRef.current = true
        liveMidi.setArmed(true)
      }
      catch (error) {
        armedRef.current = false
        finishRecording()
        setMessage(t('studio.midi_error', { error: String(error) }))
      }
    }
    finally {
      armPendingRef.current = false
    }
  }

  const close = () => {
    if (armedRef.current) finishAllVoicesAt(liveMidiNowMs())
    armedRef.current = false
    invalidateAsyncWork()
    liveMidi.setArmed(false)
    clearLiveState()
    finishRecording()
    onClose()
  }

  const { dialogRef } = useModalDialog({ open, busy, onClose: close })

  const inputItems = liveMidi.inputs.map(input => ({
    value: input.id,
    label: `${input.name}${input.manufacturer ? ` · ${input.manufacturer}` : ''}`,
  }))
  const channelItems = useMemo(() => [
    { value: 'all', label: t('studio.midi_all_channels') },
    ...Array.from({ length: 16 }, (_, channel) => ({
      value: String(channel),
      label: channel === 9 ? `Ch ${channel + 1} · Drums` : `Ch ${channel + 1}`,
    })),
  ], [t])
  const rootItems = useMemo(() => Array.from({ length: 37 }, (_, offset) => {
    const note = 48 + offset
    return { value: String(note), label: `${noteName(note)} · ${note}` }
  }), [])
  const preview = previewResult?.ok ? previewResult.preview : null
  const previewError = previewResult && !previewResult.ok ? previewResult.error : ''
  const selectedFileName = selectedMidiFile?.path.split(/[\\/]/).at(-1)?.slice(0, 256) ?? ''

  if (!open) return null

  return (
    <Box
      position="fixed" inset="0" zIndex="2140" bg="rgba(0,0,0,.75)"
      display="flex" alignItems="center" justifyContent="center"
      onPointerDown={(event) => { if (event.target === event.currentTarget && !busy && !liveMidi.armed) close() }}
    >
      <Box
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('studio.midi_title')}
        tabIndex={-1}
        w="760px" maxW="calc(100vw - 32px)" maxH="calc(100vh - 32px)"
        overflowY="auto" bg="var(--studio-panel)" borderRadius="lg" boxShadow="xl" p="5"
      >
        <Flex align="start" gap="3">
          <Box>
            <Text fontSize="xl" fontWeight="bold">{t('studio.midi_title')}</Text>
            <Text fontSize="sm" color="var(--studio-muted)">{t('studio.midi_description')}</Text>
          </Box>
          <Box flex="1" />
          <Button size="sm" onClick={close} disabled={busy}>×</Button>
        </Flex>

        <Flex mt="5" gap="3" align="stretch" flexWrap={{ base: 'wrap', md: 'nowrap' }}>
          <Box flex="1" minW="280px" p="4" bg="var(--studio-frame)" borderRadius="md" border="1px solid" borderColor="var(--studio-line)">
            <Text fontWeight="bold">{t('studio.midi_file_import')}</Text>
            <Text mt="1" minH="54px" fontSize="xs" color="var(--studio-muted)">{t('studio.midi_file_hint')}</Text>
            <Text mt="3" mb="1" fontSize="xs" color="var(--studio-muted)">{t('studio.midi_preview_mapping')}</Text>
            <Select.Root
              aria-label={t('studio.midi_preview_mapping')}
              size="sm" value={soundMapping}
              items={[
                { value: 'minecraft', label: t('studio.midi_mapping_minecraft') },
                { value: 'gm-identifiers', label: t('studio.midi_mapping_gm') },
              ]}
              onChange={value => setSoundMapping(value as MidiSoundMapping)}
              disabled={busy || liveMidi.armed || liveMidi.requesting}
            />
            <Flex mt="2" gap="2">
              <Box flex="1">
                <Text mb="1" fontSize="xs" color="var(--studio-muted)">{t('studio.midi_quantize')}</Text>
                <Select.Root
                  aria-label={t('studio.midi_quantize')}
                  size="sm"
                  value={String(quantizeStep)}
                  items={MIDI_QUANTIZE_STEPS.map(step => ({
                    value: String(step),
                    label: step === 0
                      ? t('studio.midi_quantize_off')
                      : t('studio.midi_quantize_ticks', { count: step }),
                  }))}
                  onChange={value => setQuantizeStep(Number(value) as MidiQuantizeStep)}
                  disabled={busy || liveMidi.armed || liveMidi.requesting}
                />
              </Box>
              <Box flex="1">
                <Text mb="1" fontSize="xs" color="var(--studio-muted)">{t('studio.midi_note_length')}</Text>
                <Select.Root
                  aria-label={t('studio.midi_note_length')}
                  size="sm"
                  value={noteLengthMode}
                  items={[
                    { value: 'note-off-gate', label: t('studio.midi_note_length_gate') },
                    { value: 'single-shot', label: t('studio.midi_note_length_single') },
                  ]}
                  onChange={value => setNoteLengthMode(value as MidiNoteLengthMode)}
                  disabled={busy || liveMidi.armed || liveMidi.requesting}
                />
              </Box>
            </Flex>
            <Box mt="3" p="2" border="1px solid" borderColor="var(--studio-line)" borderRadius="md">
              <Checkbox
                checked={tailFadeEnabled}
                onChange={event => setTailFadeEnabled(event.target.checked)}
                disabled={
                  busy || liveMidi.armed || liveMidi.requesting
                  || noteLengthMode === 'single-shot'
                }
              >
                {t('studio.midi_tail_fade')}
              </Checkbox>
              <Text mt="1" fontSize="xs" color="var(--studio-muted)">
                {t('studio.midi_tail_fade_hint')}
              </Text>
              <Flex mt="2" gap="2">
                <Box flex="1">
                  <Text mb="1" fontSize="xs" color="var(--studio-muted)">
                    {t('studio.midi_tail_fade_start')}
                  </Text>
                  <Input
                    aria-label={t('studio.midi_tail_fade_start')}
                    type="number" min={0} max={100} step={1} size="sm"
                    value={tailFadeStartPercent}
                    onChange={(event) => {
                      const value = Math.round(Number(event.target.value))
                      setTailFadeStartPercent(Number.isFinite(value)
                        ? Math.max(0, Math.min(100, value))
                        : 50)
                    }}
                    disabled={
                      busy || liveMidi.armed || liveMidi.requesting || !tailFadeEnabled
                      || noteLengthMode === 'single-shot'
                    }
                  />
                </Box>
                <Box flex="1">
                  <Text mb="1" fontSize="xs" color="var(--studio-muted)">
                    {t('studio.midi_tail_fade_end')}
                  </Text>
                  <Input
                    aria-label={t('studio.midi_tail_fade_end')}
                    type="number" min={0} max={100} step={1} size="sm"
                    value={tailFadeEndPercent}
                    onChange={(event) => {
                      const value = Math.round(Number(event.target.value))
                      setTailFadeEndPercent(Number.isFinite(value)
                        ? Math.max(0, Math.min(100, value))
                        : 50)
                    }}
                    disabled={
                      busy || liveMidi.armed || liveMidi.requesting || !tailFadeEnabled
                      || noteLengthMode === 'single-shot'
                    }
                  />
                </Box>
              </Flex>
              {noteLengthMode === 'single-shot' && (
                <Text mt="1" fontSize="xs" color="var(--studio-warning)">
                  {t('studio.midi_tail_fade_single_shot')}
                </Text>
              )}
            </Box>
            <Button
              mt="3" w="full" colorScheme="cyan" onClick={selectMidiFile} loading={busy}
              disabled={busy || liveMidi.armed || liveMidi.requesting}
            >
              {t('studio.midi_choose_file')}
            </Button>
          </Box>

          <Box flex="1.35" minW="340px" p="4" bg="var(--studio-frame)" borderRadius="md" border="1px solid" borderColor={liveMidi.armed ? 'red.500' : 'gray.700'}>
            <Flex align="center" gap="2">
              <Text fontWeight="bold">{t('studio.midi_live')}</Text>
              {liveMidi.armed && (
                <Text fontSize="xs" color="var(--studio-error)">
                  {`● REC · ${activeNoteCount} active · ${Math.round(currentTickRef.current)}t`}
                </Text>
              )}
            </Flex>
            <Text mt="1" fontSize="xs" color="var(--studio-muted)">{t('studio.midi_live_hint')}</Text>

            {liveMidi.inputs.length > 0 && (
              <Box mt="3">
                <Text mb="1" fontSize="xs" color="var(--studio-muted)">{t('studio.midi_device')}</Text>
                <Select.Root size="sm" value={liveMidi.selectedInputId} items={inputItems} onChange={liveMidi.setSelectedInputId} disabled={liveMidi.armed} />
              </Box>
            )}
            <Flex mt="2" gap="2">
              <Box flex="1">
                <Text mb="1" fontSize="xs" color="var(--studio-muted)">{t('studio.midi_channel')}</Text>
                <Select.Root size="sm" value={channelFilter} items={channelItems} onChange={setChannelFilter} disabled={liveMidi.armed} />
              </Box>
              <Box flex="1">
                <Text mb="1" fontSize="xs" color="var(--studio-muted)">{t('studio.midi_root_note')}</Text>
                <Select.Root size="sm" value={String(rootNote)} items={rootItems} onChange={value => setRootNote(Number(value))} disabled={liveMidi.armed} />
              </Box>
            </Flex>
            <Text mt="2" mb="1" fontSize="xs" color="var(--studio-muted)">{t('studio.midi_sound')}</Text>
            <Input
              size="sm" value={liveSoundId} list="knead-midi-sounds"
              placeholder="block.note_block.harp"
              onChange={(event) => {
                setLiveSoundId(event.target.value)
              }}
              disabled={liveMidi.armed}
            />
            <datalist id="knead-midi-sounds">
              {soundIds.map(soundId => <option key={soundId} value={soundId} />)}
            </datalist>
            <Button
              data-dialog-initial-focus
              mt="3" w="full" colorScheme={liveMidi.armed ? 'red' : 'purple'}
              onClick={toggleArmed} loading={liveMidi.requesting}
              disabled={!liveMidi.supported || !canRecord || busy}
            >
              {liveMidi.armed ? t('studio.midi_disarm') : liveMidi.inputs.length ? t('studio.midi_arm') : t('studio.midi_connect')}
            </Button>
            {!canRecord && <Text mt="2" fontSize="xs" color="var(--studio-warning)">{t('studio.midi_no_unlocked_track')}</Text>}
            {!liveMidi.supported && <Text mt="2" fontSize="xs" color="var(--studio-warning)">{t('studio.midi_unsupported')}</Text>}
          </Box>
        </Flex>

        {preview && (
          <Box
            role="region"
            aria-label={t('studio.midi_preview_title')}
            mt="4" p="4" bg="var(--studio-frame)" borderRadius="md"
            border="1px solid" borderColor="cyan.700"
          >
            <Flex align="start" gap="3" flexWrap="wrap">
              <Box flex="1" minW="260px">
                <Text fontWeight="bold">{t('studio.midi_preview_title')}</Text>
                <Text mt="1" fontSize="xs" color="var(--studio-muted)">
                  {t('studio.midi_preview_source', { file: selectedFileName })}
                </Text>
                <Text mt="1" fontSize="xs" color="var(--studio-muted)">
                  {t('studio.midi_preview_stats', {
                    format: preview.summary.sourceFormat,
                    duration: preview.summary.durationSeconds.toFixed(2),
                    ticks: preview.summary.durationTicks,
                    tracks: preview.summary.sourceTrackCount,
                    channels: preview.summary.channelCount,
                    notes: preview.summary.noteCount,
                  })}
                </Text>
                <Text fontSize="xs" color="var(--studio-muted)">
                  {t('studio.midi_preview_events', {
                    ppqn: preview.summary.ticksPerQuarter,
                    tempo: preview.summary.tempoEventCount,
                    meter: preview.summary.meterEventCount,
                  })}
                </Text>
              </Box>
              <Button
                colorScheme="cyan"
                onClick={applyMidiPreview}
                loading={busy}
                disabled={busy || liveMidi.armed || liveMidi.requesting}
              >
                {t('studio.midi_apply')}
              </Button>
            </Flex>

            <Text mt="3" mb="1" fontSize="xs" color="var(--studio-muted)">
              {t('studio.midi_channel_override')}
            </Text>
            <Flex gap="2" flexWrap="wrap">
              {previewChannels.map(channel => (
                <Box key={channel} w="180px">
                  <Input
                    aria-label={t('studio.midi_channel_override_label', { channel: channel + 1 })}
                    size="sm"
                    list="knead-midi-sounds"
                    maxLength={256}
                    value={channelSoundOverrides[channel] ?? ''}
                    placeholder={t('studio.midi_channel_override_placeholder')}
                    onChange={(event) => {
                      const value = event.target.value
                      setChannelSoundOverrides(current => ({ ...current, [channel]: value }))
                    }}
                    disabled={busy || liveMidi.armed || liveMidi.requesting}
                  />
                </Box>
              ))}
            </Flex>

            <Box mt="3" maxH="210px" overflowY="auto" borderTop="1px solid" borderColor="var(--studio-line)">
              {preview.summary.channelRows.map(row => (
                <Box
                  key={`${row.trackIndex}:${row.channel}`}
                  py="2" borderBottom="1px solid" borderColor="var(--studio-line)"
                >
                  <Text fontSize="xs" fontWeight="bold">
                    {t('studio.midi_preview_channel_row', {
                      track: row.trackName,
                      channel: row.channel + 1,
                      notes: row.noteCount,
                    })}
                  </Text>
                  <Text fontSize="xs" color="var(--studio-muted)">
                    {row.drum
                      ? t('studio.midi_preview_drums')
                      : t('studio.midi_preview_programs', {
                          programs: row.programNames.map((name, index) => (
                            `${(row.programs[index] ?? 0) + 1} ${name}`
                          )).join(', ') || '—',
                          omitted: row.omittedProgramCount ? ` (+${row.omittedProgramCount})` : '',
                        })}
                  </Text>
                  <Text fontSize="xs" color="cyan.200">
                    {t('studio.midi_preview_sounds', {
                      sounds: row.soundIds.join(', ') || '—',
                      omitted: row.omittedSoundCount ? ` (+${row.omittedSoundCount})` : '',
                    })}
                  </Text>
                </Box>
              ))}
              {preview.summary.omittedChannelRowCount > 0 && (
                <Text py="2" fontSize="xs" color="var(--studio-warning)">
                  {t('studio.midi_preview_rows_omitted', {
                    count: preview.summary.omittedChannelRowCount,
                  })}
                </Text>
              )}
            </Box>
          </Box>
        )}

        {(liveMidi.error || message || previewError) && (
          <Text mt="4" fontSize="sm" color="var(--studio-error)">
            {liveMidi.error || message || t('studio.midi_error', { error: previewError })}
          </Text>
        )}
        {preview && preview.summary.displayedWarnings.length > 0 && (
          <Box mt="4" p="3" bg="orange.900" borderRadius="md">
            <Text mb="1" fontSize="xs" fontWeight="bold">{t('studio.midi_import_warnings')}</Text>
            {preview.summary.displayedWarnings.map((warning, index) => (
              <Text key={`${index}:${warning}`} fontSize="xs">{`• ${warning}`}</Text>
            ))}
            {preview.summary.omittedWarningCount > 0 && (
              <Text mt="1" fontSize="xs">
                {t('studio.midi_preview_warnings_omitted', {
                  count: preview.summary.omittedWarningCount,
                })}
              </Text>
            )}
          </Box>
        )}
        <Flex mt="5" justify="flex-end">
          <Button onClick={close} disabled={busy}>{t('studio.close')}</Button>
        </Flex>
      </Box>
    </Box>
  )
}
