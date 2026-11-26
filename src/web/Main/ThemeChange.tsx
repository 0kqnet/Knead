import React, { useEffect, useState } from 'react'
import {
  CardBody, CardHeader, ColorModeWithSystem, HStack, MonitorCogIcon, MoonIcon, PaletteIcon,
  SegmentedControl, SegmentedControlItem, SunIcon, Text, useColorMode,
} from '@yamada-ui/react'
import { useTranslation } from 'react-i18next'

export const ThemeChange = () => {
  const { changeColorMode } = useColorMode()
  const { t } = useTranslation()

  const [Theme, setTheme] = useState('system')

  const getColorModeWithSystem = (v: string): ColorModeWithSystem => {
    if (v == 'system') return 'system'
    if (v == 'light') return 'light'
    if (v == 'dark') return 'dark'
    return 'system'
  }

  useEffect(() => {
    (async () => {
      const theme = await window.myAPI.getSetting('theme') as string
      setTheme(theme ?? 'system')
    })()
  }, [changeColorMode])

  const changeTheme = (v: ColorModeWithSystem) => {
    window.myAPI.updateSettings({ theme: v })
    changeColorMode(v)
    setTheme(v)
  }

  return (
    <>
      <CardHeader>
        <HStack>
          <PaletteIcon fontSize="xl" />
          <Text>{t('theme_select')}</Text>
        </HStack>
      </CardHeader>
      <CardBody>
        <SegmentedControl.Root value={Theme} onChange={v => changeTheme(getColorModeWithSystem(v))}>
          <SegmentedControlItem value="system">
            <HStack>
              <MonitorCogIcon fontSize="xl" />
              <Text>System</Text>
            </HStack>
          </SegmentedControlItem>
          <SegmentedControlItem value="light">
            <HStack>
              <SunIcon fontSize="xl" />
              <Text>Light</Text>
            </HStack>
          </SegmentedControlItem>
          <SegmentedControlItem value="dark">
            <HStack>
              <MoonIcon fontSize="xl" />
              <Text>Dark</Text>
            </HStack>
          </SegmentedControlItem>
        </SegmentedControl.Root>
      </CardBody>
    </>
  )
}
