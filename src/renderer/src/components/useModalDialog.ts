import { useEffect, useRef, type RefObject } from 'react'

const openModalStack: symbol[] = []

const modalFocusableSelector = [
  'a[href]',
  'button:not(:disabled)',
  'input:not(:disabled):not([type="hidden"])',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])'
].join(', ')

type UseModalDialogOptions = {
  open: boolean
  dialogRef: RefObject<HTMLElement | null>
  initialFocus?: () => HTMLElement | null
  dismissDisabled?: boolean
  onDismiss: () => void
}

export function useModalDialog({
  open,
  dialogRef,
  initialFocus,
  dismissDisabled = false,
  onDismiss
}: UseModalDialogOptions): void {
  const instanceIdRef = useRef(Symbol('modal-dialog'))
  const dismissDisabledRef = useRef(dismissDisabled)
  const initialFocusRef = useRef(initialFocus)
  const onDismissRef = useRef(onDismiss)
  dismissDisabledRef.current = dismissDisabled
  initialFocusRef.current = initialFocus
  onDismissRef.current = onDismiss

  useEffect(() => {
    if (!open) return

    const instanceId = instanceIdRef.current
    openModalStack.push(instanceId)
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const focusFrame = requestAnimationFrame(() => {
      const dialog = dialogRef.current
      if (dialog === null) return
      const preferredTarget = initialFocusRef.current?.() ?? null
      const target = preferredTarget !== null && isVisibleFocusTarget(preferredTarget)
        ? preferredTarget
        : modalFocusableElements(dialog)[0] ?? dialog
      target.focus()
    })

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || openModalStack.at(-1) !== instanceId) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (!dismissDisabledRef.current) onDismissRef.current()
        return
      }
      if (event.key !== 'Tab') return

      const dialog = dialogRef.current
      if (dialog === null) return
      const focusable = modalFocusableElements(dialog)
      const activeIndex = focusable.findIndex((element) => element === document.activeElement)
      const targetIndex = modalTabTargetIndex(focusable.length, activeIndex, event.shiftKey)
      if (targetIndex === null) return

      event.preventDefault()
      event.stopPropagation()
      if (targetIndex < 0) dialog.focus()
      else focusable[targetIndex]?.focus()
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      cancelAnimationFrame(focusFrame)
      document.removeEventListener('keydown', handleKeyDown)
      const wasTopModal = openModalStack.at(-1) === instanceId
      const stackIndex = openModalStack.lastIndexOf(instanceId)
      if (stackIndex >= 0) openModalStack.splice(stackIndex, 1)
      if (wasTopModal && previousFocus !== null && previousFocus.isConnected) {
        previousFocus.focus()
      }
    }
  }, [dialogRef, open])
}

export function modalTabTargetIndex(
  focusableCount: number,
  activeIndex: number,
  shiftKey: boolean
): number | null {
  if (focusableCount <= 0) return -1
  if (activeIndex < 0) return shiftKey ? focusableCount - 1 : 0
  if (shiftKey && activeIndex === 0) return focusableCount - 1
  if (!shiftKey && activeIndex === focusableCount - 1) return 0
  return null
}

function modalFocusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(modalFocusableSelector))
    .filter(isVisibleFocusTarget)
}

function isVisibleFocusTarget(element: HTMLElement): boolean {
  if (
    !element.isConnected ||
    element.matches(':disabled') ||
    element.closest('[inert]') !== null
  ) return false
  if (element.getAttribute('aria-hidden') === 'true' || element.getClientRects().length === 0) {
    return false
  }
  const style = window.getComputedStyle(element)
  return style.visibility !== 'hidden' && style.display !== 'none'
}
