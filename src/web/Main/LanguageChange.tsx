import React, { useEffect } from 'react'
import {
  CardBody, CardHeader, GlobeIcon, HStack, SegmentedControl, SegmentedControlItem, Text,
} from '@yamada-ui/react'
import { useTranslation } from 'react-i18next'

export const LanguageChange = () => {
  const { i18n } = useTranslation()

  useEffect(() => {}, [i18n])

  const onClickLang = (lang: string) => {
    i18n.changeLanguage(lang)
    window.myAPI.updateSettings({ language: lang })
  }

  return (
    <>
      <CardHeader>
        <HStack>
          <GlobeIcon fontSize="xl" />
          <Text>Language / 言語</Text>
        </HStack>
      </CardHeader>
      <CardBody>
        <SegmentedControl.Root value={i18n.language} onChange={onClickLang}>
          <SegmentedControlItem value="en">English</SegmentedControlItem>
          <SegmentedControlItem value="ja">日本語</SegmentedControlItem>
        </SegmentedControl.Root>
      </CardBody>
    </>
  )
}
