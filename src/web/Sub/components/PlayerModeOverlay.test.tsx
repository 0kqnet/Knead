// @vitest-environment jsdom

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { UIProvider } from '@yamada-ui/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { PlayerModeOverlay, type PlayerModeOverlayProps } from './PlayerModeOverlay'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => ({
      'studio.player_untitled': 'Untitled show',
      'studio.player_close': 'Exit Player Mode',
      'studio.player_shortcuts': 'Space play/pause · Shift+Space stop · Home beginning · Esc exit',
      'studio.player_loading': 'Loading sounds…',
      'studio.player_status_playing': 'PLAYING',
      'studio.player_status_paused': 'PAUSED',
      'studio.player_status_stopped': 'READY',
      'studio.player_ticks': 'ticks',
      'studio.player_bar': 'BAR',
      'studio.player_tempo_meter': `${String(values?.bpm)} BPM · ${String(values?.numerator)}/${String(values?.denominator)}`,
      'studio.player_tempo_meter_label': 'Current tempo and meter',
      'studio.player_progress': 'Song progress',
      'studio.player_seek': 'Seek playhead',
      'studio.player_loop': 'Loop',
      'studio.player_loop_range': `Loop bars ${String(values?.start)} – ${String(values?.end)}`,
      'studio.player_keep_awake': 'Keep screen awake',
      'studio.player_wake_unsupported': 'Wake Lock unavailable',
      'studio.player_wake_failed': `Could not keep the screen awake: ${String(values?.error)}`,
      'studio.player_master': 'MASTER',
      'studio.player_channels': `${String(values?.tracks)} timeline · ${String(values?.references)} reference`,
      'studio.player_reference': 'REF',
      'studio.play': 'Play',
      'studio.pause': 'Pause',
      'studio.resume': 'Resume',
      'studio.stop': 'Stop',
    }[key] ?? key),
  }),
}))

const originalWakeLock = Object.getOwnPropertyDescriptor(navigator, 'wakeLock')

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
  if (!window.requestAnimationFrame) {
    window.requestAnimationFrame = callback => window.setTimeout(() => callback(performance.now()), 0)
    window.cancelAnimationFrame = handle => window.clearTimeout(handle)
  }
})

afterEach(() => {
  cleanup()
  document.getElementById('player-test-outside')?.remove()
  if (originalWakeLock) Object.defineProperty(navigator, 'wakeLock', originalWakeLock)
  else Reflect.deleteProperty(navigator, 'wakeLock')
  vi.restoreAllMocks()
})

function props(overrides: Partial<PlayerModeOverlayProps> = {}): PlayerModeOverlayProps {
  return {
    open: true,
    title: 'Ultimate Show',
    lengthTicks: 400,
    currentTick: 100,
    settings: {
      bpm: 120,
      timeSignature: { numerator: 4, denominator: 4 },
      loop: { enabled: true, startTick: 40, endTick: 160 },
    },
    tracks: [{
      id: 'music', name: 'Music', color: 'purple', muted: false, solo: false,
    }],
    referenceAudio: [{
      id: 'reference', name: 'Guide Mix', muted: false, solo: true,
    }],
    trackMeters: { music: { peak: 0.65, rms: 0.35 } },
    referenceAudioMeters: { reference: { peak: 0.5, rms: 0.25 } },
    masterMeter: { peak: 0.8, rms: 0.4 },
    isPlaying: false,
    isPaused: false,
    onTogglePlay: vi.fn(),
    onStop: vi.fn(),
    onSeek: vi.fn(),
    onToggleLoop: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  }
}

function renderOverlay(overrides: Partial<PlayerModeOverlayProps> = {}) {
  const componentProps = props(overrides)
  const rendered = render(<UIProvider><PlayerModeOverlay {...componentProps} /></UIProvider>)
  return { ...rendered, props: componentProps }
}

describe('PlayerModeOverlay', () => {
  it('shows transport position and meters for timeline and reference tracks', () => {
    const { props: componentProps } = renderOverlay()
    expect(screen.getByRole('dialog', { name: 'Ultimate Show' })).toBeTruthy()
    expect(screen.getByText('00:05.0')).toBeTruthy()
    expect(screen.getByText('BAR 3.3')).toBeTruthy()
    expect(screen.getByText('120 BPM · 4/4')).toBeTruthy()
    expect(screen.getByRole('meter', { name: 'MASTER' }).getAttribute('aria-valuenow')).toBe('80')
    expect(screen.getByRole('meter', { name: 'Music' }).getAttribute('aria-valuenow')).toBe('65')
    expect(screen.getByRole('meter', { name: 'REF · Guide Mix · S' })).toBeTruthy()

    fireEvent.change(screen.getByRole('slider', { name: 'Seek playhead' }), { target: { value: '125' } })
    expect(componentProps.onSeek).toHaveBeenCalledWith(125)
    fireEvent.click(screen.getByRole('button', { name: /Loop/ }))
    expect(componentProps.onToggleLoop).toHaveBeenCalledWith(false)
  })

  it('shows musical position, BPM, and meter from the current tempo-map segment', () => {
    renderOverlay({
      currentTick: 100,
      tempoMap: [
        { tick: 0, bpm: 120, meter: { numerator: 4, denominator: 4 } },
        { tick: 80, bpm: 60, meter: { numerator: 3, denominator: 4 } },
      ],
    })

    expect(screen.getByText('BAR 3.2')).toBeTruthy()
    expect(screen.getByText('60 BPM · 3/4')).toBeTruthy()
  })

  it('owns presentation shortcuts and traps keyboard focus', async () => {
    const outside = document.createElement('button')
    outside.id = 'player-test-outside'
    outside.textContent = 'Outside'
    document.body.append(outside)
    const { props: componentProps } = renderOverlay()
    const close = screen.getByRole('button', { name: 'Exit Player Mode' })
    const lastControl = screen.getByRole('button', { name: /Loop/ })
    await waitFor(() => expect(document.activeElement).toBe(close))

    fireEvent.keyDown(document, { key: ' ' })
    fireEvent.keyDown(document, { key: ' ', shiftKey: true })
    fireEvent.keyDown(document, { key: 'Home' })
    expect(componentProps.onTogglePlay).toHaveBeenCalledTimes(1)
    expect(componentProps.onStop).toHaveBeenCalledTimes(1)
    expect(componentProps.onSeek).toHaveBeenCalledWith(0)

    close.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(lastControl)
    outside.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(componentProps.onClose).toHaveBeenCalledTimes(1)
    outside.remove()
  })

  it('acquires an optional screen Wake Lock and releases it on close', async () => {
    const sentinel = new EventTarget() as EventTarget & {
      released: boolean
      release: ReturnType<typeof vi.fn<() => Promise<void>>>
    }
    sentinel.released = false
    sentinel.release = vi.fn(async () => {
      sentinel.released = true
      sentinel.dispatchEvent(new Event('release'))
    })
    const request = vi.fn(async () => sentinel)
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: { request },
    })
    const { rerender } = renderOverlay()
    fireEvent.click(screen.getByRole('button', { name: /Keep screen awake/ }))
    await waitFor(() => expect(request).toHaveBeenCalledWith('screen'))
    await waitFor(() => expect(screen.getByRole('button', { name: /Keep screen awake/ }).getAttribute('aria-pressed')).toBe('true'))

    rerender(<UIProvider><PlayerModeOverlay {...props({ open: false })} /></UIProvider>)
    await waitFor(() => expect(sentinel.release).toHaveBeenCalledTimes(1))
  })

  it('keeps Wake Lock failures inline and non-blocking', async () => {
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: { request: vi.fn(async () => { throw new Error('permission denied') }) },
    })
    renderOverlay()
    fireEvent.click(screen.getByRole('button', { name: /Keep screen awake/ }))
    expect((await screen.findByRole('status')).textContent).toContain('permission denied')
    expect(screen.getByRole('dialog', { name: 'Ultimate Show' })).toBeTruthy()
    expect((screen.getByRole('button', { name: '▶ Play' }) as HTMLButtonElement).disabled).toBe(false)
  })
})
