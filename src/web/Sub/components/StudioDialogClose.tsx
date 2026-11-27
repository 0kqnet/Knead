import React from 'react'
import { IconButton, XIcon, type IconButtonProps } from '@yamada-ui/react'
import { useTranslation } from 'react-i18next'

export function StudioDialogClose(props: Pick<IconButtonProps, 'onClick' | 'disabled' | 'aria-label'>) {
  const { t } = useTranslation()
  return (
    <IconButton
      aria-label={t('studio.close_dialog')}
      variant="ghost" size="xs" flexShrink="0" icon={<XIcon boxSize="16px" />}
      {...props}
    />
  )
}
