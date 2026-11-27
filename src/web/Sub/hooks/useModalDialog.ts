import { useEffect, useRef, type RefObject } from 'react'

interface ModalEntry {
  container: HTMLElement
  order: number
}

export interface UseModalDialogOptions {
  open: boolean
  busy?: boolean
  onClose: () => void
}

export interface ModalDialogBinding {
  dialogRef: RefObject<HTMLDivElement | null>
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

const activeModals: ModalEntry[] = []
let modalOrder = 0

function isHidden(element: HTMLElement): boolean {
  if (element.hidden || element.closest('[hidden],[inert],[aria-hidden="true"]')) return true
  const style = window.getComputedStyle(element)
  return style.display === 'none' || style.visibility === 'hidden'
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
    .filter(element => !isHidden(element) && element.tabIndex >= 0)
    .sort((left, right) => {
      const leftIndex = left.tabIndex > 0 ? left.tabIndex : Number.MAX_SAFE_INTEGER
      const rightIndex = right.tabIndex > 0 ? right.tabIndex : Number.MAX_SAFE_INTEGER
      return leftIndex - rightIndex
    })
}

function modalLayer(container: HTMLElement): number {
  let layer = 0
  let current: HTMLElement | null = container
  while (current) {
    const parsed = Number.parseInt(window.getComputedStyle(current).zIndex, 10)
    if (Number.isFinite(parsed)) layer = Math.max(layer, parsed)
    current = current.parentElement
  }
  return layer
}

function compareModalOrder(left: ModalEntry, right: ModalEntry): number {
  if (left.container.contains(right.container)) return -1
  if (right.container.contains(left.container)) return 1
  const layerDifference = modalLayer(left.container) - modalLayer(right.container)
  if (layerDifference) return layerDifference
  const position = left.container.compareDocumentPosition(right.container)
  if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1
  if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1
  return left.order - right.order
}

function topModal(): ModalEntry | undefined {
  return activeModals
    .filter(entry => entry.container.isConnected)
    .sort(compareModalOrder)
    .at(-1)
}

function removeModal(entry: ModalEntry): void {
  const index = activeModals.indexOf(entry)
  if (index >= 0) activeModals.splice(index, 1)
}

function initialFocusTarget(container: HTMLElement): HTMLElement {
  const preferred = container.querySelector<HTMLElement>('[data-dialog-initial-focus]')
  if (preferred?.matches(FOCUSABLE_SELECTOR) && preferred.tabIndex >= 0 && !isHidden(preferred)) return preferred
  const focusable = focusableElements(container)
  if (!preferred) return focusable[0] ?? container
  return focusable.find(element => preferred.contains(element)) ?? focusable[0] ?? container
}

function expandedPopupOwnsEscape(container: HTMLElement, target: Element | null): boolean {
  if (target?.closest('[aria-expanded="true"]')) return true
  const active = document.activeElement
  return active instanceof Element
    && container.contains(active)
    && !!active.closest('[aria-expanded="true"]')
}

/**
 * Keyboard and focus behavior shared by the Studio's custom fixed overlays.
 * Portal popovers keep ownership of their own keyboard events, while only the
 * visually topmost registered modal may close or wrap focus.
 */
export function useModalDialog({ open, busy = false, onClose }: UseModalDialogOptions): ModalDialogBinding {
  const dialogRef = useRef<HTMLDivElement>(null)
  const optionsRef = useRef({ busy, onClose })
  optionsRef.current = { busy, onClose }

  useEffect(() => {
    const container = dialogRef.current
    if (!open || !container) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const entry: ModalEntry = { container, order: ++modalOrder }
    activeModals.push(entry)

    queueMicrotask(() => {
      if (topModal() !== entry || !container.isConnected) return
      if (document.activeElement instanceof Element && container.contains(document.activeElement)) return
      initialFocusTarget(container).focus()
    })

    const onKeyDown = (event: KeyboardEvent) => {
      if (topModal() !== entry || event.defaultPrevented || event.isComposing) return
      const eventTarget = event.target instanceof Element ? event.target : null
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
      const focusTarget = eventTarget && container.contains(eventTarget)
        ? eventTarget
        : active && container.contains(active) ? active : null

      if (event.key === 'Escape') {
        // A Select/menu rendered through a portal owns Escape until it closes.
        if ((eventTarget && !container.contains(eventTarget))
          || expandedPopupOwnsEscape(container, eventTarget)) {
          event.stopPropagation()
          return
        }
        if (optionsRef.current.busy) {
          event.preventDefault()
          event.stopPropagation()
          return
        }
        event.preventDefault()
        event.stopPropagation()
        optionsRef.current.onClose()
        return
      }
      if (event.key !== 'Tab' || !focusTarget) return

      const focusable = focusableElements(container)
      if (!focusable.length) {
        event.preventDefault()
        container.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && (focusTarget === first || focusTarget === container)) {
        event.preventDefault()
        event.stopPropagation()
        last.focus()
      }
      else if (!event.shiftKey && focusTarget === last) {
        event.preventDefault()
        event.stopPropagation()
        first.focus()
      }
    }
    // Yamada selects consume Escape even with the list closed.
    const onClosedSelectEscape = (event: KeyboardEvent) => {
      const target = event.target
      if (event.key === 'Escape' && target instanceof Element && container.contains(target)
        && target.closest('[role="combobox"][aria-expanded="false"]')) onKeyDown(event)
    }
    document.addEventListener('keydown', onClosedSelectEscape, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onClosedSelectEscape, true)
      document.removeEventListener('keydown', onKeyDown)
      removeModal(entry)
      queueMicrotask(() => {
        if (!previousFocus?.isConnected || isHidden(previousFocus)) return
        const remaining = topModal()
        if (remaining && !remaining.container.contains(previousFocus)) return
        previousFocus.focus()
      })
    }
  }, [open])

  return { dialogRef }
}
