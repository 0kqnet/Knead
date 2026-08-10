import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

export type LiveMidiMessage =
  | { type: 'note-on', channel: number, note: number, velocity: number, timestampMs: number }
  | { type: 'note-off', channel: number, note: number, velocity: number, timestampMs: number }
  | { type: 'pitch-bend', channel: number, value: number, timestampMs: number }
  | { type: 'control-change', channel: number, controller: number, value: number, timestampMs: number }

/** A generous monotonic-clock bound; voice duration is separately capped by MAX_GATE_TICKS. */
export const MAX_LIVE_MIDI_TIMESTAMP_MS = 365 * 24 * 60 * 60 * 1_000

export function normalizeLiveMidiTimestampMs(value: unknown, fallback = 0): number {
  let timestamp = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  // Some hosts expose epoch-based Event.timeStamp values. Convert them onto
  // the same monotonic performance timeline used by receivedTime/now().
  if (
    timestamp > MAX_LIVE_MIDI_TIMESTAMP_MS
    && typeof performance !== 'undefined'
    && Number.isFinite(performance.timeOrigin)
    && timestamp >= performance.timeOrigin
  ) timestamp -= performance.timeOrigin
  return Math.max(0, Math.min(MAX_LIVE_MIDI_TIMESTAMP_MS, timestamp))
}

export interface LiveMidiInput {
  id: string
  name: string
  manufacturer: string
  state: MIDIPortDeviceState
}

interface UseLiveMidiOptions {
  onMessage: (message: LiveMidiMessage) => void
}

export function decodeLiveMidiMessage(data: ArrayLike<number>, timestampMs = 0): LiveMidiMessage | null {
  if (data.length !== 3) return null
  const status = data[0]
  if (!Number.isInteger(status) || status < 0x80 || status >= 0xf0) return null
  const command = status & 0xf0
  const channel = status & 0x0f
  const first = data[1]
  const second = data[2]
  const timestamp = normalizeLiveMidiTimestampMs(timestampMs)
  if (!Number.isInteger(first) || first < 0 || first > 0x7f) return null
  if (!Number.isInteger(second) || second < 0 || second > 0x7f) return null
  if (command === 0x90) {
    return second === 0
      ? { type: 'note-off', channel, note: first, velocity: 0, timestampMs: timestamp }
      : { type: 'note-on', channel, note: first, velocity: second / 127, timestampMs: timestamp }
  }
  if (command === 0x80) {
    return { type: 'note-off', channel, note: first, velocity: second / 127, timestampMs: timestamp }
  }
  if (command === 0xe0) {
    const raw = first | (second << 7)
    const value = raw >= 8192 ? (raw - 8192) / 8191 : (raw - 8192) / 8192
    return { type: 'pitch-bend', channel, value: Math.max(-1, Math.min(1, value)), timestampMs: timestamp }
  }
  if (command === 0xb0) {
    return { type: 'control-change', channel, controller: first, value: second / 127, timestampMs: timestamp }
  }
  return null
}

function listInputs(access: MIDIAccess): LiveMidiInput[] {
  return Array.from(access.inputs.values()).filter(input => input.state === 'connected').map(input => ({
    id: input.id,
    name: input.name?.trim() || 'MIDI input',
    manufacturer: input.manufacturer?.trim() || '',
    state: input.state,
  }))
}

export function useLiveMidi({ onMessage }: UseLiveMidiOptions) {
  const [access, setAccess] = useState<MIDIAccess | null>(null)
  const [inputs, setInputs] = useState<LiveMidiInput[]>([])
  const [selectedInputId, setSelectedInputId] = useState('')
  const [armed, setArmed] = useState(false)
  const [requesting, setRequesting] = useState(false)
  const [error, setError] = useState('')
  const mountedRef = useRef(true)
  const requestingRef = useRef(false)
  const selectedInputIdRef = useRef(selectedInputId)
  const armedRef = useRef(armed)
  const onMessageRef = useRef(onMessage)
  selectedInputIdRef.current = selectedInputId
  armedRef.current = armed
  onMessageRef.current = onMessage

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const updateArmed = useCallback((next: boolean) => {
    armedRef.current = next
    if (mountedRef.current) setArmed(next)
  }, [])

  const selectInputId = useCallback((next: string) => {
    selectedInputIdRef.current = next
    if (mountedRef.current) setSelectedInputId(next)
  }, [])

  const refreshInputs = useCallback((nextAccess: MIDIAccess): LiveMidiInput[] => {
    const nextInputs = listInputs(nextAccess)
    setInputs(nextInputs)
    const current = selectedInputIdRef.current
    const currentConnected = nextInputs.some(input => input.id === current)
    if (armedRef.current && (!current || !currentConnected)) {
      setError(current && nextInputs.length > 0
        ? 'The selected MIDI input was disconnected.'
        : 'No MIDI input devices are connected.')
      updateArmed(false)
    }
    else if (nextInputs.length > 0) {
      setError(previous => previous === 'No MIDI input devices are connected.' ? '' : previous)
    }
    selectInputId(currentConnected ? current : (nextInputs[0]?.id ?? ''))
    return nextInputs
  }, [selectInputId, updateArmed])

  const requestAccess = useCallback(async (): Promise<boolean> => {
    if (typeof navigator === 'undefined' || typeof navigator.requestMIDIAccess !== 'function') {
      setError('Web MIDI is not available in this environment.')
      return false
    }
    if (requestingRef.current) return false
    if (access) {
      setError('')
      if (refreshInputs(access).length > 0) return true
      setError('No MIDI input devices are connected.')
      return false
    }
    requestingRef.current = true
    setRequesting(true)
    setError('')
    try {
      const nextAccess = await navigator.requestMIDIAccess({ sysex: false })
      if (!mountedRef.current) return false
      setAccess(nextAccess)
      if (refreshInputs(nextAccess).length > 0) return true
      setError('No MIDI input devices are connected.')
      return false
    }
    catch (reason) {
      if (mountedRef.current) setError(reason instanceof Error ? reason.message : String(reason))
      return false
    }
    finally {
      requestingRef.current = false
      if (mountedRef.current) setRequesting(false)
    }
  }, [access, refreshInputs])

  const clearError = useCallback(() => setError(''), [])

  useEffect(() => {
    if (!access) return
    const onStateChange = () => refreshInputs(access)
    access.addEventListener('statechange', onStateChange)
    return () => access.removeEventListener('statechange', onStateChange)
  }, [access, refreshInputs])

  useEffect(() => {
    if (!access || !armed || !selectedInputId) return
    const input = access.inputs.get(selectedInputId)
    if (!input || input.state !== 'connected') {
      setError('The selected MIDI input was disconnected.')
      updateArmed(false)
      return
    }
    let disposed = false
    const receive = (event: MIDIMessageEvent) => {
      if (!event.data) return
      const receivedTime = (event as MIDIMessageEvent & { receivedTime?: number }).receivedTime
      const fallback = typeof performance !== 'undefined' ? performance.now() : event.timeStamp
      const timestamp = normalizeLiveMidiTimestampMs(
        Number.isFinite(receivedTime) ? receivedTime : event.timeStamp,
        fallback,
      )
      const message = decodeLiveMidiMessage(event.data, timestamp)
      if (message) onMessageRef.current(message)
    }
    input.addEventListener('midimessage', receive)
    input.open().catch((reason) => {
      if (!disposed) {
        setError(reason instanceof Error ? reason.message : String(reason))
        updateArmed(false)
      }
    })
    return () => {
      disposed = true
      input.removeEventListener('midimessage', receive)
      input.close().catch(() => undefined)
    }
  }, [access, armed, selectedInputId, updateArmed])

  const selectedInput = useMemo(
    () => inputs.find(input => input.id === selectedInputId) ?? null,
    [inputs, selectedInputId],
  )

  return {
    supported: typeof navigator !== 'undefined' && typeof navigator.requestMIDIAccess === 'function',
    inputs,
    selectedInput,
    selectedInputId,
    setSelectedInputId: selectInputId,
    armed,
    setArmed: updateArmed,
    requesting,
    error,
    clearError,
    requestAccess,
  }
}
