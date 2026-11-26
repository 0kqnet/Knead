import React from 'react'
import { AudioLinesIcon, Button, Flex, Spacer } from '@yamada-ui/react'
import { useTranslation } from 'react-i18next'
import { VersionSelector } from './VersionSelector'
import { SoundSelector } from './SoundSelector'
import { Footer } from './Footer'
import { Configuration } from './Configuration'
import { VolumeChange } from './VolumeChange'

export const App = () => {
  const { t } = useTranslation()

  return (
    <main className="knead-main">
      <Flex className="knead-main-toolbar" align="center" gap="2">
        <VersionSelector />
        <Spacer />
        <VolumeChange />
        <Button
          className="knead-studio-button"
          colorScheme="purple"
          startIcon={<AudioLinesIcon boxSize="4" />}
          onClick={() => window.myAPI.make_sub_window()}
        >
          {t('studio.title')}
        </Button>
        <Configuration />
      </Flex>
      <SoundSelector />
      <Footer />
    </main>
  )
}
