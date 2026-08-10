import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Button, Flex, Text } from '@yamada-ui/react'
import { useTranslation } from 'react-i18next'

export type SongTabStatus = 'ready' | 'opening' | 'saving' | 'audio-switching' | 'error'

export interface SongTabItem {
  id: string
  label: string
  dirty: boolean
  status: SongTabStatus
}

export interface SongTabBarProps {
  tabs: readonly SongTabItem[]
  activeId: string
  disabled?: boolean
  maxTabs?: number
  announcement?: string
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onNew: () => void
  onOpenRecent?: () => void
}

export const SongTabBar: React.FC<SongTabBarProps> = ({
  tabs,
  activeId,
  disabled = false,
  maxTabs = 8,
  announcement = '',
  onActivate,
  onClose,
  onNew,
  onOpenRecent,
}) => {
  const { t } = useTranslation()
  const [focusedId, setFocusedId] = useState(activeId)
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())
  const orderedIds = useMemo(() => tabs.map(tab => tab.id), [tabs])

  useEffect(() => {
    if (orderedIds.includes(focusedId)) return
    setFocusedId(orderedIds.includes(activeId) ? activeId : orderedIds[0] ?? '')
  }, [activeId, focusedId, orderedIds])

  const focusAt = (index: number) => {
    if (orderedIds.length === 0) return
    const bounded = (index + orderedIds.length) % orderedIds.length
    const id = orderedIds[bounded]
    setFocusedId(id)
    tabRefs.current.get(id)?.focus()
  }

  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, id: string) => {
    const index = orderedIds.indexOf(id)
    if (index < 0) return
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      focusAt(index + 1)
    }
    else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      focusAt(index - 1)
    }
    else if (event.key === 'Home') {
      event.preventDefault()
      focusAt(0)
    }
    else if (event.key === 'End') {
      event.preventDefault()
      focusAt(orderedIds.length - 1)
    }
  }

  return (
    <Box bg="gray.950" borderBottom="1px solid" borderColor="gray.700" px="2" py="1">
      <Flex role="tablist" aria-label={t('studio.song_tabs')} align="stretch" gap="1" overflowX="auto">
        {tabs.map(tab => (
          <Flex key={tab.id} flex="0 0 auto" align="stretch" borderRadius="md" overflow="hidden">
            <Button
              ref={(node) => {
                if (node) tabRefs.current.set(tab.id, node)
                else tabRefs.current.delete(tab.id)
              }}
              role="tab"
              id={`song-tab-${tab.id}`}
              aria-controls={`song-panel-${tab.id}`}
              aria-selected={tab.id === activeId}
              aria-label={`${tab.dirty ? `${t('studio.song_tab_unsaved')} ` : ''}${tab.label}`}
              tabIndex={tab.id === focusedId ? 0 : -1}
              size="xs"
              borderRightRadius="0"
              colorScheme={tab.id === activeId ? 'blue' : tab.status === 'error' ? 'red' : 'gray'}
              isDisabled={disabled || tab.status === 'opening' || tab.status === 'audio-switching'}
              onFocus={() => setFocusedId(tab.id)}
              onKeyDown={event => onTabKeyDown(event, tab.id)}
              onClick={() => onActivate(tab.id)}
            >
              <Text as="span" maxW="190px" overflow="hidden" textOverflow="ellipsis" whiteSpace="nowrap">
                {tab.dirty ? '* ' : ''}
                {tab.label}
                {tab.status === 'saving' ? ` · ${t('studio.song_tab_saving')}` : ''}
              </Text>
            </Button>
            <Button
              size="xs"
              minW="28px"
              px="1"
              borderLeftRadius="0"
              colorScheme={tab.status === 'error' ? 'red' : 'gray'}
              aria-label={t('studio.song_tab_close_named', { name: tab.label })}
              isDisabled={disabled || (tab.status !== 'ready' && tab.status !== 'error')}
              onClick={() => onClose(tab.id)}
            >
              ×
            </Button>
          </Flex>
        ))}
        {onOpenRecent && (
          <Button
            flex="0 0 auto"
            size="xs"
            aria-label={t('studio.recent_songs_open')}
            isDisabled={disabled}
            onClick={onOpenRecent}
          >
            {t('studio.recent_songs_short')}
          </Button>
        )}
        <Button
          flex="0 0 auto"
          size="xs"
          aria-label={t('studio.song_tab_new')}
          title={t('studio.song_tab_new')}
          isDisabled={disabled || tabs.length >= maxTabs}
          onClick={onNew}
        >
          ＋
        </Button>
      </Flex>
      <Box position="absolute" w="1px" h="1px" overflow="hidden" clip="rect(0 0 0 0)" aria-live="polite">
        {announcement}
      </Box>
    </Box>
  )
}
