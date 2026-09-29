import { useEffect, type RefObject } from 'react'

import type { SettingsJumpTarget } from './settings-workspace'

export const SETTINGS_SEARCH_HIT_ATTRIBUTE = 'data-settings-search-hit'

const FOCUSABLE = [
  'button:not(:disabled)',
  'input:not(:disabled)',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])'
].join(', ')

/**
 * Scrolls a rendered settings target into view, marks its row (or the target
 * itself when it is a group heading) and focuses the first usable control of
 * that row or group, or the target itself when there is none. Returns false
 * while the target is not rendered and visible.
 */
export function revealSettingsTarget(container: HTMLElement, id: string): boolean {
  const target = container.ownerDocument.getElementById(id)
  if (target === null || !container.contains(target) || target.getClientRects().length === 0) return false
  const row = target.closest<HTMLElement>('.settings-row, .settings-density-block')
  const group = target.closest<HTMLElement>('section')
  const region = row ?? (group !== null && container.contains(group) ? group : target)
  clearSettingsSearchHit(container)
  ;(row ?? target).setAttribute(SETTINGS_SEARCH_HIT_ATTRIBUTE, '')
  region.scrollIntoView({ block: row === null ? 'start' : 'center' })
  const control = target.matches(FOCUSABLE) ? target : region.querySelector<HTMLElement>(FOCUSABLE)
  if (control === null && !target.hasAttribute('tabindex')) target.tabIndex = -1
  ;(control ?? target).focus({ preventScroll: true })
  return true
}

function clearSettingsSearchHit(container: HTMLElement): void {
  for (const element of container.querySelectorAll(`[${SETTINGS_SEARCH_HIT_ATTRIBUTE}]`)) {
    element.removeAttribute(SETTINGS_SEARCH_HIT_ATTRIBUTE)
  }
}

/**
 * Reveals each new jump target once. A target that is not rendered yet (page
 * data still loading) is revealed when it appears, unless the user scrolls,
 * clicks or types first. The mark stays until the next pointer or key press.
 */
export function useSettingsJump(
  containerRef: RefObject<HTMLElement | null>,
  target: SettingsJumpTarget | null
): void {
  useEffect(() => {
    const container = containerRef.current
    if (target === null || container === null) return
    const document = container.ownerDocument
    const observer = new MutationObserver(() => {
      if (revealSettingsTarget(container, target.id)) settle()
    })
    const clearHit = (): void => {
      clearSettingsSearchHit(container)
      document.removeEventListener('pointerdown', clearHit, true)
      document.removeEventListener('keydown', clearHit, true)
    }
    const stopWaiting = (): void => {
      observer.disconnect()
      container.removeEventListener('wheel', stopWaiting)
      document.removeEventListener('pointerdown', stopWaiting, true)
      document.removeEventListener('keydown', stopWaiting, true)
    }
    const settle = (): void => {
      stopWaiting()
      document.addEventListener('pointerdown', clearHit, true)
      document.addEventListener('keydown', clearHit, true)
    }

    if (revealSettingsTarget(container, target.id)) {
      settle()
    } else {
      observer.observe(container, { childList: true, subtree: true })
      container.addEventListener('wheel', stopWaiting, { passive: true })
      document.addEventListener('pointerdown', stopWaiting, true)
      document.addEventListener('keydown', stopWaiting, true)
    }
    return () => {
      stopWaiting()
      clearHit()
    }
  }, [containerRef, target])
}
