import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode
} from 'react'
import { createPortal } from 'react-dom'

import './tooltip.css'

const TOOLTIP_SHOW_DELAY_MS = 360
const TOOLTIP_GAP_PX = 9
const VIEWPORT_MARGIN_PX = 8

type TooltipPlacement = 'top' | 'right' | 'bottom' | 'left'
type RequestedTooltipPlacement = TooltipPlacement | 'auto'

type ActiveTooltip = {
  target: HTMLElement
  content: string
  requestedPlacement: RequestedTooltipPlacement
  mono: boolean
}

type TooltipPosition = {
  top: number
  left: number
  placement: TooltipPlacement
  arrowOffset: number
}

type TooltipStyle = CSSProperties & {
  '--tooltip-arrow-offset': string
}

export function TooltipProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const tooltipId = useId()
  const tooltipRef = useRef<HTMLDivElement>(null)
  const showTimerRef = useRef<number | null>(null)
  const pendingTargetRef = useRef<HTMLElement | null>(null)
  const activeRef = useRef<ActiveTooltip | null>(null)
  const [active, setActive] = useState<ActiveTooltip | null>(null)
  const [position, setPosition] = useState<TooltipPosition | null>(null)

  useEffect(() => {
    const clearShowTimer = (): void => {
      if (showTimerRef.current !== null) {
        window.clearTimeout(showTimerRef.current)
        showTimerRef.current = null
      }
      pendingTargetRef.current = null
    }

    const hideTooltip = (target?: HTMLElement): void => {
      if (target !== undefined && activeRef.current?.target !== target) return
      clearShowTimer()
      activeRef.current = null
      setActive(null)
      setPosition(null)
    }

    const showTooltip = (target: HTMLElement, immediate: boolean): void => {
      const content = target.dataset.tooltip?.trim()
      if (!content) return
      if (
        activeRef.current?.target === target &&
        activeRef.current.content === content
      ) return

      clearShowTimer()
      pendingTargetRef.current = target
      const activate = (): void => {
        if (!target.isConnected || pendingTargetRef.current !== target) return
        const currentContent = target.dataset.tooltip?.trim()
        if (!currentContent) return
        const next: ActiveTooltip = {
          target,
          content: currentContent,
          requestedPlacement: tooltipPlacement(target.dataset.tooltipPlacement),
          mono: target.dataset.tooltipVariant === 'mono'
        }
        pendingTargetRef.current = null
        showTimerRef.current = null
        activeRef.current = next
        setPosition(null)
        setActive(next)
      }

      if (immediate) activate()
      else showTimerRef.current = window.setTimeout(activate, TOOLTIP_SHOW_DELAY_MS)
    }

    const handlePointerOver = (event: PointerEvent): void => {
      const target = tooltipTarget(event.target)
      if (target !== null) showTooltip(target, false)
    }

    const handlePointerOut = (event: PointerEvent): void => {
      const target = tooltipTarget(event.target)
      if (target === null) return
      if (event.relatedTarget instanceof Node && target.contains(event.relatedTarget)) return
      if (pendingTargetRef.current === target) clearShowTimer()
      hideTooltip(target)
    }

    const handleFocusIn = (event: FocusEvent): void => {
      const target = tooltipTarget(event.target)
      if (target !== null) showTooltip(target, true)
    }

    const handleFocusOut = (event: FocusEvent): void => {
      const target = tooltipTarget(event.target)
      if (target === null) return
      if (event.relatedTarget instanceof Node && target.contains(event.relatedTarget)) return
      hideTooltip(target)
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || activeRef.current === null) return
      event.preventDefault()
      event.stopPropagation()
      hideTooltip()
    }

    const handleViewportChange = (): void => hideTooltip()

    document.addEventListener('pointerover', handlePointerOver, true)
    document.addEventListener('pointerout', handlePointerOut, true)
    document.addEventListener('focusin', handleFocusIn, true)
    document.addEventListener('focusout', handleFocusOut, true)
    document.addEventListener('keydown', handleKeyDown, true)
    window.addEventListener('resize', handleViewportChange)
    window.addEventListener('scroll', handleViewportChange, true)

    return () => {
      clearShowTimer()
      document.removeEventListener('pointerover', handlePointerOver, true)
      document.removeEventListener('pointerout', handlePointerOut, true)
      document.removeEventListener('focusin', handleFocusIn, true)
      document.removeEventListener('focusout', handleFocusOut, true)
      document.removeEventListener('keydown', handleKeyDown, true)
      window.removeEventListener('resize', handleViewportChange)
      window.removeEventListener('scroll', handleViewportChange, true)
    }
  }, [])

  useEffect(() => {
    if (active === null) return
    const previousDescription = active.target.getAttribute('aria-describedby')
    const descriptions = new Set((previousDescription ?? '').split(/\s+/).filter(Boolean))
    descriptions.add(tooltipId)
    active.target.setAttribute('aria-describedby', [...descriptions].join(' '))
    return () => {
      if (previousDescription === null) active.target.removeAttribute('aria-describedby')
      else active.target.setAttribute('aria-describedby', previousDescription)
    }
  }, [active, tooltipId])

  useLayoutEffect(() => {
    const tooltip = tooltipRef.current
    if (active === null || tooltip === null) return
    const targetRect = active.target.getBoundingClientRect()
    const tooltipRect = tooltip.getBoundingClientRect()
    if (targetRect.width === 0 && targetRect.height === 0) {
      setPosition(null)
      return
    }
    setPosition(calculateTooltipPosition(
      targetRect,
      tooltipRect,
      active.requestedPlacement
    ))
  }, [active])

  const tooltip = active === null ? null : createPortal(
    <div
      ref={tooltipRef}
      id={tooltipId}
      className={`app-tooltip${position === null ? '' : ' visible'}${active.mono ? ' mono' : ''}`}
      data-placement={position?.placement ?? active.requestedPlacement}
      role="tooltip"
      style={position === null ? undefined : ({
        top: position.top,
        left: position.left,
        '--tooltip-arrow-offset': `${position.arrowOffset}px`
      } as TooltipStyle)}
    >
      {active.content}
    </div>,
    document.body
  )

  return <>{children}{tooltip}</>
}

function tooltipTarget(eventTarget: EventTarget | null): HTMLElement | null {
  if (!(eventTarget instanceof Element)) return null
  const target = eventTarget.closest<HTMLElement>('[data-tooltip]')
  return target?.dataset.tooltip?.trim() ? target : null
}

function tooltipPlacement(value: string | undefined): RequestedTooltipPlacement {
  return value === 'top' || value === 'right' || value === 'bottom' || value === 'left'
    ? value
    : 'auto'
}

function calculateTooltipPosition(
  target: DOMRect,
  tooltip: DOMRect,
  requested: RequestedTooltipPlacement
): TooltipPosition {
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const spaces: Record<TooltipPlacement, number> = {
    top: target.top - VIEWPORT_MARGIN_PX,
    right: viewportWidth - target.right - VIEWPORT_MARGIN_PX,
    bottom: viewportHeight - target.bottom - VIEWPORT_MARGIN_PX,
    left: target.left - VIEWPORT_MARGIN_PX
  }
  const required: Record<TooltipPlacement, number> = {
    top: tooltip.height + TOOLTIP_GAP_PX,
    right: tooltip.width + TOOLTIP_GAP_PX,
    bottom: tooltip.height + TOOLTIP_GAP_PX,
    left: tooltip.width + TOOLTIP_GAP_PX
  }
  const preferredOrder: TooltipPlacement[] = requested === 'auto'
    ? ['top', 'bottom', 'right', 'left']
    : [requested, oppositePlacement(requested), 'top', 'bottom', 'right', 'left']
  const uniqueOrder = [...new Set(preferredOrder)]
  const placement = uniqueOrder.find((candidate) => spaces[candidate] >= required[candidate])
    ?? uniqueOrder.reduce((best, candidate) => spaces[candidate] > spaces[best] ? candidate : best)

  let top: number
  let left: number
  if (placement === 'top' || placement === 'bottom') {
    top = placement === 'top'
      ? target.top - tooltip.height - TOOLTIP_GAP_PX
      : target.bottom + TOOLTIP_GAP_PX
    left = target.left + (target.width - tooltip.width) / 2
  } else {
    top = target.top + (target.height - tooltip.height) / 2
    left = placement === 'left'
      ? target.left - tooltip.width - TOOLTIP_GAP_PX
      : target.right + TOOLTIP_GAP_PX
  }

  top = clamp(top, VIEWPORT_MARGIN_PX, viewportHeight - tooltip.height - VIEWPORT_MARGIN_PX)
  left = clamp(left, VIEWPORT_MARGIN_PX, viewportWidth - tooltip.width - VIEWPORT_MARGIN_PX)

  const arrowOffset = placement === 'top' || placement === 'bottom'
    ? clamp(target.left + target.width / 2 - left, 10, tooltip.width - 10)
    : clamp(target.top + target.height / 2 - top, 10, tooltip.height - 10)

  return { top, left, placement, arrowOffset }
}

function oppositePlacement(placement: TooltipPlacement): TooltipPlacement {
  if (placement === 'top') return 'bottom'
  if (placement === 'bottom') return 'top'
  return placement === 'left' ? 'right' : 'left'
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum))
}
