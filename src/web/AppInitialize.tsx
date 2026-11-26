import { useEffect } from 'react'
import { useColorMode } from '@yamada-ui/react'
import { useTranslation } from 'react-i18next'

export const AppInitialize = () => {
  const { changeColorMode } = useColorMode()
  const { i18n } = useTranslation()

  useEffect(() => {
    let active = true
    window.myAPI.getSetting('language').then((language) => {
      if (active && typeof language === 'string') return i18n.changeLanguage(language)
    }).catch(error => console.error('Failed to load language:', error))

    window.myAPI.getSetting('theme').then((theme) => {
      if (active && (theme === 'light' || theme === 'dark' || theme === 'system')) changeColorMode(theme)
    }).catch(error => console.error('Failed to load theme:', error))

    return () => {
      active = false
    }
  }, [changeColorMode, i18n])

  return null
}
