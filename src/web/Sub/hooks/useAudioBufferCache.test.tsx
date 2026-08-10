// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReferenceAudioTrack } from '../types/timeline'
import { useAudioBufferCache } from './useAudioBufferCache'

interface Deferred<Value> {
  promise: Promise<Value>
  resolve: (value: Value) => void
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((onResolve) => {
    resolve = onResolve
  })
  return { promise, resolve }
}

const audioLibrary = vi.hoisted(() => ({
  soundMap: {} as Record<string, { path: string, hash: string, pitch: number }[]>,
}))

vi.mock('../../../hooks/useAudioLibrary', () => ({
  useAudioLibrary: () => ({ soundMap: audioLibrary.soundMap }),
}))

function audioBuffer(sample = 0.5): AudioBuffer {
  return {
    length: 1,
    sampleRate: 20,
    numberOfChannels: 1,
    duration: 0.05,
    getChannelData: () => Float32Array.of(sample),
  } as unknown as AudioBuffer
}

function reference(id: string, fingerprint: string, dataBase64: string): ReferenceAudioTrack {
  return {
    id,
    name: id,
    color: 'blue',
    fileName: `${id}.wav`,
    sourcePath: '',
    mimeType: 'audio/wav',
    byteLength: 1,
    fingerprint,
    dataBase64,
    durationSeconds: 1,
    offsetTicks: 0,
    gainDb: 0,
    pan: 0,
    muted: false,
    solo: false,
    locked: false,
    collapsed: false,
  }
}

describe('project-aware audio buffer cache', () => {
  let decodes: Deferred<AudioBuffer>[]

  beforeEach(() => {
    decodes = []
    audioLibrary.soundMap = {}
    class MockAudioContext {
      decodeAudioData(): Promise<AudioBuffer> {
        const job = deferred<AudioBuffer>()
        decodes.push(job)
        return job.promise
      }

      close(): Promise<void> {
        return Promise.resolve()
      }
    }
    vi.stubGlobal('AudioContext', MockAudioContext)
    Object.defineProperty(window, 'myAPI', {
      configurable: true,
      value: { get_mcSoundData: vi.fn(async () => new ArrayBuffer(1)) },
    })
  })

  it('drops a stale song decode without changing the new song preload state', async () => {
    audioLibrary.soundMap = {
      old: [{ path: 'old.ogg', hash: 'old-hash', pitch: 1 }],
    }
    const { result, rerender } = renderHook(() => useAudioBufferCache())
    let oldPreload!: Promise<void>
    act(() => {
      oldPreload = result.current.preload(['old'])
    })
    expect(result.current.preloading).toBe(true)
    await waitFor(() => expect(decodes).toHaveLength(1))

    act(() => result.current.clearForProjectSwitch())
    audioLibrary.soundMap = {
      next: [{ path: 'next.ogg', hash: 'next-hash', pitch: 1 }],
    }
    rerender()
    let nextPreload!: Promise<void>
    act(() => {
      nextPreload = result.current.preload(['next'])
    })
    await waitFor(() => expect(decodes).toHaveLength(2))
    expect(result.current.preloading).toBe(true)

    await act(async () => {
      decodes[0].resolve(audioBuffer(0.1))
      await oldPreload
    })
    expect(result.current.getBuffer('old', 0)).toBeUndefined()
    expect(result.current.preloading).toBe(true)

    const nextBuffer = audioBuffer(0.9)
    await act(async () => {
      decodes[1].resolve(nextBuffer)
      await nextPreload
    })
    expect(result.current.getBuffer('next', 0)).toBe(nextBuffer)
    expect(result.current.preloading).toBe(false)
  })

  it('does not start decoding inactive song bytes that finish loading after a switch', async () => {
    const bytes = deferred<ArrayBuffer>()
    const getMcSoundData = vi.fn(() => bytes.promise)
    Object.defineProperty(window, 'myAPI', {
      configurable: true,
      value: { get_mcSoundData: getMcSoundData },
    })
    audioLibrary.soundMap = {
      old: [{ path: 'old.ogg', hash: 'old-hash', pitch: 1 }],
    }
    const { result } = renderHook(() => useAudioBufferCache())
    let preload!: Promise<void>
    act(() => {
      preload = result.current.preload(['old'])
    })
    await waitFor(() => expect(getMcSoundData).toHaveBeenCalledTimes(1))
    act(() => result.current.clearForProjectSwitch())
    await act(async () => {
      bytes.resolve(new ArrayBuffer(1))
      await preload
    })
    expect(decodes).toEqual([])
    expect(result.current.getBuffer('old', 0)).toBeUndefined()
    expect(result.current.preloading).toBe(false)
  })

  it('does not let stale reference audio repopulate track or fingerprint caches', async () => {
    const { result } = renderHook(() => useAudioBufferCache())
    let oldPreload!: Promise<void>
    act(() => {
      oldPreload = result.current.preloadReferenceAudio([
        reference('old-track', 'old-fingerprint', 'AQ=='),
      ])
    })
    expect(decodes).toHaveLength(1)
    act(() => result.current.clearForProjectSwitch())

    let nextPreload!: Promise<void>
    act(() => {
      nextPreload = result.current.preloadReferenceAudio([
        reference('next-track', 'next-fingerprint', 'Ag=='),
      ])
    })
    expect(decodes).toHaveLength(2)
    await act(async () => {
      decodes[0].resolve(audioBuffer(0.1))
      await oldPreload
    })
    expect(result.current.getReferenceBuffer('old-track')).toBeUndefined()
    expect(result.current.preloading).toBe(true)

    const nextBuffer = audioBuffer(0.8)
    await act(async () => {
      decodes[1].resolve(nextBuffer)
      await nextPreload
    })
    expect(result.current.getReferenceBuffer('next-track')).toBe(nextBuffer)
    expect(result.current.getReferenceBuffer('old-track')).toBeUndefined()
    expect(result.current.preloading).toBe(false)
  })
})
