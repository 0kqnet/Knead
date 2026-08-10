// @vitest-environment jsdom

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useModalDialog } from './useModalDialog'

interface HarnessProps {
  open: boolean
  busy?: boolean
  layer?: number
  label?: string
  onClose: () => void
}

const Harness: React.FC<HarnessProps> = ({ open, busy, layer = 1, label = 'Test dialog', onClose }) => {
  const { dialogRef } = useModalDialog({ open, busy, onClose })
  if (!open) return null
  return (
    <div style={{ position: 'fixed', zIndex: layer }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
        <button data-dialog-initial-focus>First</button>
        <input aria-label="Middle" />
        <button>Last</button>
      </div>
    </div>
  )
}

afterEach(cleanup)

describe('useModalDialog', () => {
  it('moves initial focus, wraps Tab in both directions, and restores the opener', async () => {
    const opener = document.createElement('button')
    opener.textContent = 'Open'
    document.body.append(opener)
    opener.focus()
    const onClose = vi.fn()
    const rendered = render(<Harness open onClose={onClose} />)

    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'First' })))
    const first = screen.getByRole('button', { name: 'First' })
    const last = screen.getByRole('button', { name: 'Last' })
    last.focus()
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)

    rendered.rerender(<Harness open={false} onClose={onClose} />)
    await waitFor(() => expect(document.activeElement).toBe(opener))
    opener.remove()
  })

  it('closes on Escape but blocks Escape while busy', () => {
    const onClose = vi.fn()
    const underlyingKeyDown = vi.fn()
    window.addEventListener('keydown', underlyingKeyDown)
    const rendered = render(<Harness open busy onClose={onClose} />)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect(underlyingKeyDown).not.toHaveBeenCalled()

    rendered.rerender(<Harness open busy={false} onClose={onClose} />)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    window.removeEventListener('keydown', underlyingKeyDown)
  })

  it('leaves Escape to an expanded control or its portal', async () => {
    const onClose = vi.fn()
    render(<Harness open onClose={onClose} />)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'First' })))
    const underlyingKeyDown = vi.fn()
    window.addEventListener('keydown', underlyingKeyDown)
    const first = screen.getByRole('button', { name: 'First' })
    first.setAttribute('aria-expanded', 'true')
    fireEvent.keyDown(first, { key: 'Escape' })

    const portalOption = document.createElement('button')
    portalOption.textContent = 'Portal option'
    document.body.append(portalOption)
    portalOption.focus()
    fireEvent.keyDown(portalOption, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect(underlyingKeyDown).not.toHaveBeenCalled()
    window.removeEventListener('keydown', underlyingKeyDown)
    portalOption.remove()
  })

  it('allows only the visually topmost modal to handle Escape', async () => {
    const closeLow = vi.fn()
    const closeHigh = vi.fn()
    render(
      <>
        <Harness open layer={100} label="Low" onClose={closeLow} />
        <Harness open layer={200} label="High" onClose={closeHigh} />
      </>,
    )
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'High' }).contains(document.activeElement)).toBe(true))
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'High' }), { key: 'Escape' })
    expect(closeHigh).toHaveBeenCalledTimes(1)
    expect(closeLow).not.toHaveBeenCalled()
  })
})
