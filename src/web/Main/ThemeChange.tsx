import React from 'react'
import {
  CardBody, CardHeader, HStack, MonitorCogIcon, MoonIcon, PaletteIcon,
  SegmentedControl, SegmentedControlItem, SunIcon, Text, useColorMode,
} from '@yamada-ui/react'
import { useTranslation } from 'react-i18next'

export const ThemeChange = () => {
  const { internalColorMode } = useColorMode()
  const { t } = useTranslation()

  return (
    <>
      <CardHeader>
        <HStack>
          <PaletteIcon fontSize="xl" />
          <Text>{t('theme_select')}</Text>
        </HStack>
      </CardHeader>
      <CardBody>
        <SegmentedControl.Root value={internalColorMode} onChange={theme => window.myAPI.updateSettings({ theme })}>
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
