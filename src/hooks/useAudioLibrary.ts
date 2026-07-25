import { useMemo } from 'react'
import { useAppSelector } from '../store/_store'

export function useAudioLibrary() {
  const sounds = useAppSelector(state => state.fetch.sounds)
  const soundIdList = useMemo(() => sounds.map(s => s.id), [sounds])

  // ID → variant用配列のmap
  const soundMap = useMemo(() => {
    const m: Record<string, { path: string, hash: string, pitch: number }[]> = {}
    for (const s of sounds) {
      m[s.id] = s.sounds.map(ss => ({ path: ss.path, hash: ss.hash, pitch: ss.pitch }))
    }
    return m
  }, [sounds])

  return { soundIdList, soundMap, loaded: sounds.length > 0 }
}
