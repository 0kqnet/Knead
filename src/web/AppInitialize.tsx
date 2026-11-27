import { useEffect, useEffectEvent } from 'react'
import { useColorMode } from '@yamada-ui/react'
import { useTranslation } from 'react-i18next'
import { useAddDispatch } from '../store/_store'
import { updateTargetVersion } from '../store/fetchSlice'
import type { Settings } from '../types/Settings'
import { parseVersion } from '../types/VersionInfo'

export const AppInitialize = () => {
  const { changeColorMode } = useColorMode()
  const { i18n } = useTranslation()
  const dispatch = useAddDispatch()

  const applySettings = useEffectEvent((settings: Settings) => {
    const { theme, language, selectedVersion } = settings
    if (theme === 'light' || theme === 'dark' || theme === 'system') changeColorMode(theme)
    if (typeof language === 'string') {
      document.documentElement.lang = language
      if (language !== i18n.language) void i18n.changeLanguage(language)
    }
    if ('selectedVersion' in settings) {
      const raw = typeof selectedVersion === 'string'
        ? selectedVersion
        : selectedVersion && typeof selectedVersion === 'object' && 'raw' in selectedVersion ? selectedVersion.raw : ''
      dispatch(updateTargetVersion({ targetVersion: parseVersion(raw) }))
    }
  })

  useEffect(() => {
    let active = true
    let unlisten: (() => void) | undefined
    // A change can arrive while the initial settings are crossing the IPC boundary.
    let pending: Settings | undefined = {}
    void (async () => {
      const stop = await window.myAPI.onSettingsChanged((changes) => {
        if (!active) return
        if (pending) Object.assign(pending, changes)
        applySettings(changes)
      })
      if (!active) return stop()
      unlisten = stop
      const initial = await window.myAPI.loadSettings()
      if (active) applySettings({ ...initial, ...pending })
      pending = undefined
    })().catch(error => console.error('Failed to synchronize settings:', error))

    return () => {
      active = false
      unlisten?.()
    }
  }, [])

  return null
}
