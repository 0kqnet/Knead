// @vitest-environment jsdom

import React from 'react'
import { fireEvent, render } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { UIProvider } from '@yamada-ui/react'
import { CommitNumberInput, clampCommittedNumber } from './CommitNumberInput'

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
})

describe('CommitNumberInput', () => {
  it('clamps committed values to the nearest boundary', () => {
    expect(clampCommittedNumber('-10', 50, 20, 300, 0)).toBe(20)
    expect(clampCommittedNumber('999', 50, 20, 300, 0)).toBe(300)
    expect(clampCommittedNumber('', 50, 20, 300, 0)).toBe(50)
  })

  it('allows delete and out-of-range drafts until blur', () => {
    const onCommit = vi.fn()
    const { getByRole } = render(
      <UIProvider>
        <CommitNumberInput value={120} min={20} max={300} precision={0} onCommit={onCommit} />
      </UIProvider>,
    )
    const input = getByRole('spinbutton') as HTMLInputElement

    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: '' } })
    expect(input.value).toBe('')
    fireEvent.change(input, { target: { value: '999' } })
    expect(input.value).toBe('999')
    fireEvent.blur(input)

    expect(onCommit).toHaveBeenLastCalledWith(300)
    expect(input.value).toBe('300')
  })
})
