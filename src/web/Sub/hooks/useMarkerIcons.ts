import { useEffect, useMemo, useRef, useState } from 'react'
import type { MarkerVisualIcon } from '../../../../@types/global'

const EMPTY_ICONS: Record<string, MarkerVisualIcon> = {}

interface MarkerIconCache {
  version: string
  icons: Record<string, MarkerVisualIcon>
  attempted: Set<string>
}

export function useMarkerIcons(
  enabled: boolean,
  version: string | undefined,
  soundIds: string[],
) {
  const [icons, setIcons] = useState<Record<string, MarkerVisualIcon>>({})
  const [loading, setLoading] = useState(false)
  const cacheRef = useRef<MarkerIconCache>({ version: '', icons: {}, attempted: new Set() })
  const soundKey = useMemo(
    () => Array.from(new Set(soundIds.filter(Boolean))).sort().join('\0'),
    [soundIds],
  )
  const uniqueSoundIds = useMemo(
    () => soundKey === '' ? [] : soundKey.split('\0'),
    [soundKey],
  )

  useEffect(() => {
    if (!enabled || !version || uniqueSoundIds.length === 0) {
      setLoading(false)
      return
    }

    if (cacheRef.current.version !== version) {
      cacheRef.current = { version, icons: {}, attempted: new Set() }
      setIcons({})
    }
    let cancelled = false
    const cache = cacheRef.current
    const missing = uniqueSoundIds.filter(soundId => !cache.attempted.has(soundId))
    if (missing.length === 0) return
    missing.forEach(soundId => cache.attempted.add(soundId))

    setLoading(true)
    window.myAPI.get_mcMarkerIcons(version, missing)
      .then((loaded) => {
        if (cancelled) return
        cache.icons = { ...cache.icons, ...loaded }
        setIcons(cache.icons)
      })
      .catch((error) => {
        missing.forEach(soundId => cache.attempted.delete(soundId))
        console.warn('marker icon loading failed', error)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [enabled, uniqueSoundIds, version])

  return {
    icons: enabled && cacheRef.current.version === version ? icons : EMPTY_ICONS,
    loading,
  }
}
