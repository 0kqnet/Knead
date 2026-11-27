import React, { useEffect } from 'react'
import { Box, Button, Flex, Text } from '@yamada-ui/react'
import { useTranslation } from 'react-i18next'

export interface DocumentCloseDialogProps {
  open: boolean
  name: string
  busy?: boolean
  error?: string | null
  onSave: () => void
  onDiscard: () => void
  onCancel: () => void
}

export const DocumentCloseDialog: React.FC<DocumentCloseDialogProps> = ({
  open,
  name,
  busy = false,
  error = null,
  onSave,
  onDiscard,
  onCancel,
}) => {
  const { t } = useTranslation()

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busy) return
      event.preventDefault()
      onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, onCancel, open])

  if (!open) return null
  return (
    <Box
      position="fixed" inset="0" zIndex="2160" bg="var(--knead-scrim)"
      display="flex" alignItems="center" justifyContent="center"
      role="dialog" aria-modal="true" aria-label={t('studio.song_tab_close_title')}
    >
      <Box w="520px" maxW="calc(100vw - 32px)" bg="var(--studio-panel)" p="5" borderRadius="lg" boxShadow="xl">
        <Text fontSize="lg" fontWeight="bold">{t('studio.song_tab_close_title')}</Text>
        <Text mt="2">{t('studio.song_tab_close_message', { name })}</Text>
        {error && <Text role="alert" mt="3" color="var(--studio-error)">{error}</Text>}
        <Flex mt="5" justify="flex-end" gap="2">
          <Button disabled={busy} onClick={onCancel}>{t('studio.cancel')}</Button>
          <Button colorScheme="red" disabled={busy} onClick={onDiscard}>
            {t('studio.song_tab_discard')}
          </Button>
          <Button colorScheme="purple" loading={busy} onClick={onSave}>
            {t('studio.save')}
          </Button>
        </Flex>
      </Box>
    </Box>
  )
}
