import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'

const VIEWPORT_MARGIN = 8
const TRIGGER_GAP = 6
const MIN_SIDE_POPOVER_WIDTH = 180

type PopoverPosition = {
  placement: 'above' | 'below' | 'left' | 'right'
  style: CSSProperties
}

type PopoverPositionOptions = {
  preferredWidth?: number
  align?: 'start' | 'end' | 'before'
  axis?: 'horizontal' | 'vertical'
}

export function useViewportPopoverPosition(
  open: boolean,
  triggerRef: RefObject<HTMLElement | null>,
  maximumHeight: number,
  options: PopoverPositionOptions = {}
): {
  popoverRef: RefObject<HTMLDivElement | null>
  position: PopoverPosition | null
} {
  const popoverRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<PopoverPosition | null>(null)
  const preferredWidth = options.preferredWidth
  const align = options.align ?? 'start'
  const axis = options.axis ?? 'vertical'

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }

    const commitPosition = (next: PopoverPosition): void => {
      setPosition((current) => (samePopoverPosition(current, next) ? current : next))
    }

    const updatePosition = (): void => {
      const trigger = triggerRef.current
      if (trigger === null) return

      const rect = trigger.getBoundingClientRect()
      const viewportWidth = window.innerWidth
      const viewportHeight = window.innerHeight
      if (axis === 'horizontal') {
        const spaceLeft = Math.max(0, rect.left - TRIGGER_GAP - VIEWPORT_MARGIN)
        const spaceRight = Math.max(0, viewportWidth - rect.right - TRIGGER_GAP - VIEWPORT_MARGIN)
        const desiredWidth = preferredWidth ?? rect.width
        const minimumUsableWidth = Math.min(desiredWidth, MIN_SIDE_POPOVER_WIDTH)

        if (Math.max(spaceLeft, spaceRight) >= minimumUsableWidth) {
          const rightIsUsable = spaceRight >= minimumUsableWidth
          const placement = rightIsUsable || spaceRight >= spaceLeft ? 'right' : 'left'
          const availableWidth = placement === 'right' ? spaceRight : spaceLeft
          const width = Math.min(desiredWidth, availableWidth)
          const maxHeight = Math.min(
            maximumHeight,
            Math.max(0, viewportHeight - VIEWPORT_MARGIN * 2)
          )
          const top = Math.min(
            Math.max(VIEWPORT_MARGIN, rect.top),
            Math.max(VIEWPORT_MARGIN, viewportHeight - VIEWPORT_MARGIN - maxHeight)
          )

          commitPosition({
            placement,
            style: {
              position: 'fixed',
              top,
              width,
              maxHeight,
              ...(placement === 'right'
                ? { left: rect.right + TRIGGER_GAP }
                : { right: viewportWidth - rect.left + TRIGGER_GAP })
            }
          })
          return
        }
      }

      const spaceAbove = Math.max(0, rect.top - TRIGGER_GAP - VIEWPORT_MARGIN)
      const spaceBelow = Math.max(0, viewportHeight - rect.bottom - TRIGGER_GAP - VIEWPORT_MARGIN)
      const placement = spaceBelow >= spaceAbove ? 'below' : 'above'
      const availableHeight = placement === 'below' ? spaceBelow : spaceAbove
      const width = Math.min(
        Math.max(rect.width, preferredWidth ?? rect.width),
        Math.max(0, viewportWidth - VIEWPORT_MARGIN * 2)
      )
      const alignedLeft = align === 'end'
        ? rect.right - width
        : align === 'before'
          ? rect.left - TRIGGER_GAP - width
          : rect.left
      const left = Math.min(
        Math.max(VIEWPORT_MARGIN, alignedLeft),
        Math.max(VIEWPORT_MARGIN, viewportWidth - VIEWPORT_MARGIN - width)
      )

      commitPosition({
        placement,
        style: {
          position: 'fixed',
          left,
          width,
          maxHeight: Math.min(maximumHeight, availableHeight),
          ...(placement === 'below'
            ? { top: rect.bottom + TRIGGER_GAP }
            : { bottom: viewportHeight - rect.top + TRIGGER_GAP })
        }
      })
    }

    const handleScroll = (event: Event): void => {
      // Internal popover scrolling should not reflow the fixed menu.
      if (event.target instanceof Node && popoverRef.current?.contains(event.target)) return
      updatePosition()
    }

    updatePosition()
    const trigger = triggerRef.current
    const resizeObserver = new ResizeObserver(updatePosition)
    if (trigger !== null) resizeObserver.observe(trigger)
    window.addEventListener('resize', updatePosition)
    window.addEventListener('scroll', handleScroll, true)

    return () => {
      resizeObserver.disconnect()
      window.removeEventListener('resize', updatePosition)
      window.removeEventListener('scroll', handleScroll, true)
    }
  }, [align, axis, maximumHeight, open, preferredWidth, triggerRef])

  return { popoverRef, position }
}

function samePopoverPosition(
  current: PopoverPosition | null,
  next: PopoverPosition
): boolean {
  if (current === null || current.placement !== next.placement) return false
  return sameStyleValue(current.style, next.style, [
    'position',
    'top',
    'right',
    'bottom',
    'left',
    'width',
    'maxHeight'
  ])
}

function sameStyleValue(
  current: CSSProperties,
  next: CSSProperties,
  keys: readonly (keyof CSSProperties)[]
): boolean {
  return keys.every((key) => current[key] === next[key])
}
