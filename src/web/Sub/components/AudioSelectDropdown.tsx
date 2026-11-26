import React, { FC, useState, useRef, useEffect, useId, useMemo, ChangeEvent } from 'react'
import { Box, Input, Portal, Text, usePopper } from '@yamada-ui/react'
import { useTranslation } from 'react-i18next'
import { FixedSizeList as VirtualList, ListChildComponentProps } from 'react-window'

interface Props {
  options: string[]
  label: string
  value: string
  placeholder?: string
  onSelect: (val: string) => void
  height?: number
  isDisabled?: boolean
  focusRequest?: number
  onFocusRequestHandled?: () => void
}

export const AudioSelectDropdown: FC<Props> = ({
  options,
  label,
  value,
  placeholder = '',
  onSelect,
  height = 300,
  isDisabled = false,
  focusRequest = 0,
  onFocusRequestHandled,
}) => {
  const { t } = useTranslation()
  const listId = useId()
  const [open, setOpen] = useState(false)
  const [inputValue, setInputValue] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<VirtualList>(null)
  const handledFocusRequest = useRef(0)
  const { referenceRef, getPopperProps } = usePopper({
    enabled: open, placement: 'top-start', strategy: 'fixed', matchWidth: true, gutter: 4,
  })

  useEffect(() => {
    if (isDisabled || focusRequest <= 0 || handledFocusRequest.current === focusRequest) return
    handledFocusRequest.current = focusRequest
    setInputValue(value)
    setActiveIndex(0)
    setOpen(true)
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
      onFocusRequestHandled?.()
    })
    return () => cancelAnimationFrame(frame)
  }, [focusRequest, isDisabled, value, onFocusRequestHandled])

  const openDropdown = () => {
    setInputValue(value)
    setActiveIndex(Math.max(0, options.indexOf(value)))
    setOpen(true)
    requestAnimationFrame(() => {
      inputRef.current?.select()
    })
  }

  // 外部クリックで閉じる
  useEffect(() => {
    if (!open) return
    const handler = (event: MouseEvent) => {
      const target = event.target as Node
      if (!ref.current?.contains(target) && !inputRef.current?.contains(target)) setOpen(false)
    }
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [open])

  // 入力値でフィルタ (空白区切り AND 検索)
  const filteredOptions = useMemo(() => {
    const tokens = inputValue.toLowerCase().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) return options
    return options.filter((opt) => {
      const lower = opt.toLowerCase()
      return tokens.every(t => lower.includes(t))
    })
  }, [options, inputValue])

  const ITEM_H = 30

  useEffect(() => {
    if (!open || filteredOptions.length === 0) return
    const nextIndex = Math.min(activeIndex, filteredOptions.length - 1)
    if (nextIndex !== activeIndex) setActiveIndex(nextIndex)
    listRef.current?.scrollToItem(nextIndex, 'smart')
  }, [activeIndex, filteredOptions.length, open])

  const selectOption = (opt: string) => {
    onSelect(opt)
    setInputValue('')
    setOpen(false)
  }

  const Row: FC<ListChildComponentProps> = ({ index, style }) => {
    const opt = filteredOptions[index]
    const selected = opt === value
    const active = index === activeIndex
    return (
      <div
        style={{
          ...style,
          background: active || selected ? 'var(--studio-accent-soft)' : 'transparent',
          color: active || selected ? 'var(--studio-accent-text)' : 'inherit',
          padding: '6px 12px',
          cursor: 'pointer',
          userSelect: 'none',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
        id={`${listId}-option-${index}`}
        role="option"
        aria-selected={selected}
        title={opt}
        onClick={() => selectOption(opt)}
        onMouseEnter={() => setActiveIndex(index)}
      >
        {opt}
      </div>
    )
  }

  return (
    <Box ref={referenceRef} width="100%">
      <Input
        ref={inputRef}
        role="combobox"
        aria-label={label}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && filteredOptions[activeIndex] ? `${listId}-option-${activeIndex}` : undefined}
        value={open ? inputValue : value}
        placeholder={placeholder}
        readOnly={isDisabled}
        onClick={() => {
          if (!isDisabled && !open) openDropdown()
        }}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          setInputValue(e.target.value)
          setActiveIndex(0)
          if (!open) setOpen(true)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            if (!open) {
              setOpen(true)
              setActiveIndex(0)
              return
            }
            const direction = e.key === 'ArrowDown' ? 1 : -1
            setActiveIndex(current => Math.max(0, Math.min(filteredOptions.length - 1, current + direction)))
          }
          else if (e.key === 'Enter' && open && filteredOptions[activeIndex]) {
            e.preventDefault()
            selectOption(filteredOptions[activeIndex])
          }
          else if (e.key === 'Escape' && open) {
            e.preventDefault()
            setOpen(false)
          }
        }}
        cursor="pointer"
        disabled={isDisabled}
      />
      {open && (
        <Portal>
          <Box
            {...getPopperProps({}, ref)}
            id={listId}
            role="listbox"
            aria-label={label}
            bg="var(--studio-panel)"
            color="var(--studio-text)"
            border="1px solid var(--studio-line)"
            borderRadius="md"
            boxShadow="md"
            zIndex="popover"
          >
            {filteredOptions.length > 0
              ? (
                  <VirtualList
                    ref={listRef}
                    height={Math.min(filteredOptions.length * ITEM_H, height)}
                    width="100%"
                    itemCount={filteredOptions.length}
                    itemSize={ITEM_H}
                  >
                    {Row}
                  </VirtualList>
                )
              : <Text px="3" py="2" fontSize="sm" role="status">{t('studio.no_matching_sounds')}</Text>}
          </Box>
        </Portal>
      )}
    </Box>
  )
}
