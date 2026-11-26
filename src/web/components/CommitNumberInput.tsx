import React, { useCallback, useEffect, useRef, useState } from 'react'
import { NumberInput, type NumberInputProps } from '@yamada-ui/react'

export interface CommitNumberInputProps extends Omit<
  NumberInputProps,
  'clampValueOnBlur' | 'defaultValue' | 'keepWithinRange' | 'onChange' | 'value'
> {
  value: number | string
  onCommit: (value: number) => void
}

export function clampCommittedNumber(
  draft: string,
  fallback: number,
  min = Number.MIN_SAFE_INTEGER,
  max = Number.MAX_SAFE_INTEGER,
  precision?: number,
): number {
  if (draft.trim() === '') return fallback
  const parsed = Number(draft)
  if (!Number.isFinite(parsed)) return fallback
  const clamped = Math.max(min, Math.min(max, parsed))
  if (precision === undefined) return clamped
  const factor = 10 ** precision
  return Math.round(clamped * factor) / factor
}

export const CommitNumberInput = React.forwardRef<HTMLInputElement, CommitNumberInputProps>(function CommitNumberInput({
  value,
  onCommit,
  min = Number.MIN_SAFE_INTEGER,
  max = Number.MAX_SAFE_INTEGER,
  precision,
  w,
  rootProps,
  onBlur,
  onFocus,
  onKeyDown,
  ...props
}, ref) {
  const [draft, setDraft] = useState(String(value))
  const focusedRef = useRef(false)
  const externalRef = useRef(value)
  externalRef.current = value

  useEffect(() => {
    if (!focusedRef.current) setDraft(String(value))
  }, [value])

  const externalNumber = useCallback(() => {
    const parsed = Number(externalRef.current)
    return Number.isFinite(parsed)
      ? Math.max(min, Math.min(max, parsed))
      : Math.max(min, Math.min(max, 0))
  }, [max, min])

  const commit = useCallback((nextDraft: string) => {
    const next = clampCommittedNumber(nextDraft, externalNumber(), min, max, precision)
    onCommit(next)
    setDraft(String(next))
  }, [externalNumber, max, min, onCommit, precision])

  return (
    <NumberInput
      ref={ref}
      {...props}
      rootProps={{ w, ...rootProps }}
      value={draft}
      min={min}
      max={max}
      precision={precision}
      keepWithinRange={false}
      clampValueOnBlur={false}
      onChange={(nextDraft, valueAsNumber) => {
        setDraft(nextDraft)
        if (
          Number.isFinite(valueAsNumber)
          && valueAsNumber >= min
          && valueAsNumber <= max
        ) {
          onCommit(clampCommittedNumber(nextDraft, valueAsNumber, min, max, precision))
        }
      }}
      onFocus={(event) => {
        focusedRef.current = true
        onFocus?.(event)
      }}
      onBlur={(event) => {
        focusedRef.current = false
        commit(draft)
        onBlur?.(event)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
        onKeyDown?.(event)
      }}
    />
  )
})
