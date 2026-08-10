import { useMemo, useSyncExternalStore } from 'react'
import { useAppSelector } from '../store/_store'
import {
  getProjectCustomAudioSnapshot,
  subscribeProjectCustomAudio,
} from '../web/Sub/utils/projectCustomAudio'

export function useAudioLibrary() {
  const sounds = useAppSelector(state => state.fetch.sounds)
  const custom = useSyncExternalStore(
    subscribeProjectCustomAudio,
    getProjectCustomAudioSnapshot,
    getProjectCustomAudioSnapshot,
  )
  const soundIdList = useMemo(() => Array.from(new Set([
    ...sounds.map(sound => sound.id),
    ...Object.keys(custom.manifest),
  ])), [custom.manifest, sounds])

  // ID → variant用配列のmap
  const soundMap = useMemo(() => {
    const m: Record<string, { path: string, hash: string, pitch: number }[]> = {}
    for (const s of sounds) {
      m[s.id] = s.sounds.map(ss => ({ path: ss.path, hash: ss.hash, pitch: ss.pitch }))
    }
    for (const [soundId, variants] of Object.entries(custom.manifest)) {
      m[soundId] = variants.map(variant => ({ ...variant }))
    }
    return m
  }, [custom.manifest, sounds])

  return { soundIdList, soundMap, loaded: sounds.length > 0 || soundIdList.length > 0 }
}
