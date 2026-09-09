import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import type { KernelState } from '../../../../shared/kernel-contract'
import { Icon } from '../../components/Icon'
import { useViewportPopoverPosition } from '../../components/useViewportPopoverPosition'
import { formatUsd } from '../../format-usd'
import { formatTokenCount } from '../../usage-formatters'

/** Match TooltipProvider: only reveal after a deliberate hover dwell. */
const HOVER_CARD_SHOW_DELAY_MS = 600
const HOVER_CARD_CLOSE_DELAY_MS = 120

type SessionHoverCardState = {
  sessionKey: string
}

export type SessionHoverCardController = {
  sessionKey: string | null
  describedBy: (sessionKey: string) => string | undefined
  open: (sessionKey: string, anchor: HTMLElement) => void
  request: (sessionKey: string, anchor: HTMLElement) => void
  scheduleClose: () => void
  cancelClose: () => void
  dismiss: () => void
  cardId: string
  popoverRef: React.RefObject<HTMLElement | null>
  position: ReturnType<typeof useViewportPopoverPosition<HTMLElement>>['position']
}

export function useSessionHoverCard(hidden: boolean): SessionHoverCardController {
  const [hoverCard, setHoverCard] = useState<SessionHoverCardState | null>(null)
  const cardId = `${useId()}-session-information`
  const anchorRef = useRef<HTMLElement>(null)
  const closeTimerRef = useRef<number | null>(null)
  const showTimerRef = useRef<number | null>(null)
  const pendingSessionKeyRef = useRef<string | null>(null)
  const { popoverRef, position } = useViewportPopoverPosition<HTMLElement>(
    hoverCard !== null && !hidden,
    anchorRef,
    360,
    { preferredWidth: 300, axis: 'horizontal' }
  )

  const cancelClose = (): void => {
    if (closeTimerRef.current === null) return
    window.clearTimeout(closeTimerRef.current)
    closeTimerRef.current = null
  }

  const cancelShow = (): void => {
    if (showTimerRef.current !== null) {
      window.clearTimeout(showTimerRef.current)
      showTimerRef.current = null
    }
    pendingSessionKeyRef.current = null
  }

  const dismiss = (): void => {
    cancelClose()
    cancelShow()
    setHoverCard(null)
  }

  const scheduleClose = (): void => {
    cancelShow()
    cancelClose()
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null
      setHoverCard(null)
    }, HOVER_CARD_CLOSE_DELAY_MS)
  }

  const open = (sessionKey: string, anchor: HTMLElement): void => {
    anchorRef.current = anchor
    cancelShow()
    cancelClose()
    if (hoverCard !== null && hoverCard.sessionKey !== sessionKey) {
      setHoverCard(null)
      pendingSessionKeyRef.current = sessionKey
      showTimerRef.current = window.setTimeout(() => {
        if (pendingSessionKeyRef.current !== sessionKey) return
        pendingSessionKeyRef.current = null
        showTimerRef.current = null
        if (anchor.isConnected) setHoverCard({ sessionKey })
      }, 0)
      return
    }
    setHoverCard({ sessionKey })
  }

  const request = (sessionKey: string, anchor: HTMLElement): void => {
    anchorRef.current = anchor
    cancelClose()

    if (hoverCard !== null && hoverCard.sessionKey === sessionKey) {
      cancelShow()
      return
    }
    if (
      pendingSessionKeyRef.current === sessionKey &&
      showTimerRef.current !== null
    ) return

    if (hoverCard !== null) setHoverCard(null)

    const activate = (): void => {
      if (pendingSessionKeyRef.current !== sessionKey) return
      pendingSessionKeyRef.current = null
      showTimerRef.current = null
      if (!anchor.isConnected) return
      open(sessionKey, anchor)
    }

    cancelShow()
    pendingSessionKeyRef.current = sessionKey
    showTimerRef.current = window.setTimeout(activate, HOVER_CARD_SHOW_DELAY_MS)
  }

  useEffect(() => {
    if (hidden) dismiss()
  }, [hidden])

  useEffect(() => {
    return () => {
      cancelClose()
      cancelShow()
    }
  }, [])

  return {
    sessionKey: hoverCard?.sessionKey ?? null,
    describedBy: (sessionKey) =>
      hoverCard?.sessionKey === sessionKey && position !== null ? cardId : undefined,
    open,
    request,
    scheduleClose,
    cancelClose,
    dismiss,
    cardId,
    popoverRef,
    position
  }
}

type SessionHoverCardProps = {
  hidden: boolean
  controller: SessionHoverCardController
  session: KernelState['sessions'][number] | null
  title: string | null
  tokenCountFormat: KernelState['appearance']['tokenCountFormat']
  showSessionFile?: boolean
}

export function SessionHoverCard({
  hidden,
  controller,
  session,
  title,
  tokenCountFormat,
  showSessionFile = true
}: SessionHoverCardProps): React.JSX.Element | null {
  if (
    hidden ||
    session === null ||
    title === null ||
    controller.sessionKey !== session.key ||
    controller.position === null
  ) return null

  return createPortal(
    <aside
      ref={controller.popoverRef}
      id={controller.cardId}
      className="session-hover-card"
      data-placement={controller.position.placement}
      style={controller.position.style}
      onPointerEnter={controller.cancelClose}
      onPointerLeave={controller.scheduleClose}
      onFocus={controller.cancelClose}
      onBlur={controller.scheduleClose}
    >
      <div className="session-hover-card-main">
        <div className="session-hover-card-heading">
          <span className="session-hover-card-icon" aria-hidden="true">
            <Icon name="messages" size="lg" />
          </span>
          <div className="session-hover-card-title-block">
            <strong>{title}</strong>
            <code>{session.id}</code>
          </div>
        </div>
        {session.provisional === true ? (
          <p className="session-hover-card-status">创建中（尚未落盘，不可恢复）</p>
        ) : session.statistics === null ? (
          <p className="session-hover-card-status">统计暂不可用</p>
        ) : (
          <dl className="session-hover-card-stats">
            <div className="session-hover-stat-row">
              <dt>消息总计</dt>
              <dd>{session.statistics.totalMessages.toLocaleString()}</dd>
            </div>
            <div className="session-hover-stat-row">
              <dt>用户 / 助手</dt>
              <dd>
                {session.statistics.userMessages.toLocaleString()}
                {' / '}
                {session.statistics.assistantMessages.toLocaleString()}
              </dd>
            </div>
            <div className="session-hover-stat-row session-hover-stat-row-divider">
              <dt>Token 总量</dt>
              <dd>{formatTokenCount(session.statistics.totalTokens, tokenCountFormat)}</dd>
            </div>
            <div className="session-hover-stat-row">
              <dt>输入</dt>
              <dd>{formatTokenCount(session.statistics.inputTokens, tokenCountFormat)}</dd>
            </div>
            <div className="session-hover-stat-row">
              <dt>输出</dt>
              <dd>{formatTokenCount(session.statistics.outputTokens, tokenCountFormat)}</dd>
            </div>
            <div className="session-hover-stat-row">
              <dt>缓存读取</dt>
              <dd>{formatTokenCount(session.statistics.cacheReadTokens, tokenCountFormat)}</dd>
            </div>
            <div className="session-hover-stat-row">
              <dt>缓存写入</dt>
              <dd>{formatTokenCount(session.statistics.cacheWriteTokens, tokenCountFormat)}</dd>
            </div>
            <div className="session-hover-stat-row session-hover-stat-row-divider">
              <dt>费用（USD）</dt>
              <dd>{formatUsd(session.statistics.cost)}</dd>
            </div>
          </dl>
        )}
      </div>
      {showSessionFile ? (
        <div className="session-hover-card-path">
          <span>会话文件</span>
          <code data-tooltip={session.key} data-tooltip-variant="mono">
            {session.key}
          </code>
        </div>
      ) : null}
    </aside>,
    document.body
  )
}
