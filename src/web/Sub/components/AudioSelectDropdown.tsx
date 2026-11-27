import React, { FC, useState, useRef, useEffect, useId, useMemo, ChangeEvent } from 'react'
import { Box, CheckIcon, ChevronDownIcon, Input, Text, usePopper } from '@yamada-ui/react'
import { useTranslation } from 'react-i18next'
import { List, type ListImperativeAPI, type RowComponentProps } from 'react-window'

interface Props {
  options: readonly string[]
  label: string
  value: string
  placeholder?: string
  onSelect: (val: string) => void
  allowCustomValue?: boolean
  maxLength?: number
  height?: number
  disabled?: boolean
  focusRequest?: number
  onFocusRequestHandled?: () => void
}

interface SoundOptionRowProps {
  options: readonly string[]
  value: string
  activeIndex: number
  listId: string
  onActivate: (index: number) => void
  onSelect: (value: string) => void
}

function SoundOptionRow({
  index, style, ariaAttributes, options, value, activeIndex, listId, onActivate, onSelect,
}: RowComponentProps<SoundOptionRowProps>) {
  const opt = options[index]
  const selected = opt === value
  const active = index === activeIndex
  return (
    <div
      {...ariaAttributes}
      style={style}
      className="knead-option"
      data-active={active}
      id={`${listId}-option-${index}`}
      role="option"
      aria-selected={selected}
      title={opt}
      onClick={() => onSelect(opt)}
      onMouseEnter={() => onActivate(index)}
    >
      <CheckIcon aria-hidden boxSize="14px" flexShrink="0" opacity={selected ? 1 : 0} />
      <span>{opt}</span>
    </div>
  )
}

export const AudioSelectDropdown: FC<Props> = ({
  options,
  label,
  value,
  placeholder = '',
  onSelect,
  allowCustomValue = false,
  maxLength,
  height = 300,
  disabled = false,
  focusRequest = 0,
  onFocusRequestHandled,
}) => {
  const { t } = useTranslation()
  const listId = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState<string | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<ListImperativeAPI>(null)
  const handledFocusRequest = useRef(0)
  const { getReferenceProps, getPopperProps } = usePopper({
    open, placement: 'end-start', strategy: 'fixed', matchWidth: true, gutter: 4,
  })

  useEffect(() => {
    if (focusRequest <= 0) {
      handledFocusRequest.current = 0
      return
    }
    if (disabled || handledFocusRequest.current === focusRequest) return
    handledFocusRequest.current = focusRequest
    setQuery(null)
    setActiveIndex(Math.max(0, options.indexOf(value)))
    setOpen(true)
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
      onFocusRequestHandled?.()
    })
    return () => cancelAnimationFrame(frame)
  }, [focusRequest, disabled, value, options, onFocusRequestHandled])

  const openDropdown = () => {
    setQuery(null)
    const selectedIndex = options.indexOf(value)
    setActiveIndex(allowCustomValue ? selectedIndex : Math.max(0, selectedIndex))
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
    const tokens = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) return options
    return options.filter((opt) => {
      const lower = opt.toLowerCase()
      return tokens.every(t => lower.includes(t))
    })
  }, [options, query])

  const ITEM_H = 32

  useEffect(() => {
    if (!open || activeIndex < 0 || filteredOptions.length === 0) return
    const nextIndex = Math.min(activeIndex, filteredOptions.length - 1)
    if (nextIndex !== activeIndex) setActiveIndex(nextIndex)
    listRef.current?.scrollToRow({ index: nextIndex, align: 'smart' })
  }, [activeIndex, filteredOptions.length, open])

  const selectOption = (opt: string) => {
    onSelect(opt)
    setQuery(null)
    setOpen(false)
  }

  return (
    <Box {...getReferenceProps()} width="100%" position="relative">
      <Input
        className="knead-select-trigger"
        ref={inputRef}
        role="combobox"
        aria-label={label}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && filteredOptions[activeIndex] ? `${listId}-option-${activeIndex}` : undefined}
        value={open ? query ?? value : value}
        maxLength={maxLength}
        placeholder={placeholder}
        readOnly={disabled}
        onClick={() => {
          if (!disabled && !open) openDropdown()
        }}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          setQuery(e.target.value)
          if (allowCustomValue) onSelect(e.target.value)
          setActiveIndex(allowCustomValue ? -1 : 0)
          if (!open) setOpen(true)
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            if (!open) {
              openDropdown()
              return
            }
            const direction = e.key === 'ArrowDown' ? 1 : -1
            setActiveIndex(current => Math.max(0, Math.min(filteredOptions.length - 1, current + direction)))
          }
          else if (e.key === 'Enter' && open && filteredOptions[activeIndex]) {
            e.preventDefault()
            selectOption(filteredOptions[activeIndex])
          }
          else if (e.key === 'Enter' && open && allowCustomValue) {
            e.preventDefault()
            setOpen(false)
          }
          else if (e.key === 'Escape' && open) {
            e.preventDefault()
            setOpen(false)
          }
          else if (e.key === 'Tab' && open) {
            setOpen(false)
          }
        }}
        cursor="pointer"
        disabled={disabled}
      />
      <ChevronDownIcon aria-hidden className="knead-select-chevron" transform={open ? 'rotate(180deg)' : undefined} />
      {open && (
        <Box
          {...getPopperProps({ ref })}
          id={listId}
          role="listbox"
          aria-label={label}
          className="knead-popup"
          w="0"
          zIndex="recoome"
        >
          {filteredOptions.length > 0
            ? (
                <List
                  listRef={listRef}
                  style={{ height: Math.min(filteredOptions.length * ITEM_H, height), width: '100%' }}
                  rowCount={filteredOptions.length}
                  rowHeight={ITEM_H}
                  rowComponent={SoundOptionRow}
                  rowProps={{ options: filteredOptions, value, activeIndex, listId, onSelect: selectOption, onActivate: setActiveIndex }}
                />
              )
            : <Text px="3" py="2" fontSize="sm" role="status">{t('studio.no_matching_sounds')}</Text>}
        </Box>
      )}
    </Box>
  )
}
