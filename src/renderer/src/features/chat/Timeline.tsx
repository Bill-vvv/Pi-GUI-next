import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import type {
  KernelConversationEntry,
  KernelMessageEntry,
  RuntimeStatus
} from '../../../../shared/kernel-contract'
import { MarkdownMessage } from './MarkdownMessage'
import { IconButton } from '../../components/IconButton'
import { useViewportPopoverPosition } from '../../components/useViewportPopoverPosition'
import type { ToolDisplayDensity } from '../../tool-display-density'
import {
  CompletedTurn,
  groupConversationTurns,
  hasCurrentRunningEntry,
  isProcessEntry,
  LiveTurn,
  MessageAttachments,
  splitTurn,
  ThinkingStatus
} from './TimelineTurns'

type TimelineProps = {
  entries: KernelConversationEntry[]
  activeRunStartIndex: number | null
  runtimeStatus: RuntimeStatus
  compactionActive: boolean
  showPromptNavigation: boolean
  toolDisplayDensity: ToolDisplayDensity
  canCopyLastAnswer: boolean
  canExportSession: boolean
  canForkSession: boolean
  conversationActionBusy: boolean
  conversationActionStatus: string | null
  conversationActionError: string | null
  onCopyLastAnswer: () => Promise<void>
  onExportSession: () => Promise<void>
  onForkSession: () => void
  title?: string
  warning: string | null
}

type PromptNavigationItem = {
  turnId: string
  prompt: KernelMessageEntry
  ordinal: number
}

const COMPLETED_TURN_WINDOW_SIZE = 60
const PINNED_PROMPT_SWITCH_GAP = 8
const PROMPT_NAVIGATION_PREVIEW_DELAY_MS = 360
const EMPTY_STATE_SLOGANS = [
  '从一个想法开始。',
  '把复杂的事，一步一步做成。',
  '想清楚，然后动手。',
  '说说你想完成什么。',
  '从问题出发，向结果推进。',
  '今天想让什么变得更好？'
] as const

export function Timeline({
  entries,
  activeRunStartIndex,
  runtimeStatus,
  compactionActive,
  showPromptNavigation,
  toolDisplayDensity,
  canCopyLastAnswer,
  canExportSession,
  canForkSession,
  conversationActionBusy,
  conversationActionStatus,
  conversationActionError,
  onCopyLastAnswer,
  onExportSession,
  onForkSession,
  title,
  warning
}: TimelineProps): React.JSX.Element {
  const shellRef = useRef<HTMLDivElement>(null)
  const chromeRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const messageListRef = useRef<HTMLDivElement>(null)
  const outputEndRef = useRef<HTMLDivElement>(null)
  const scrollTailRef = useRef<HTMLDivElement>(null)
  const followOutputRef = useRef(true)
  const pinnedPromptFrameRef = useRef<number | null>(null)
  const pinnedPromptReadingLineOffsetRef = useRef<number | null>(null)
  const pinnedPromptTurnIdRef = useRef<string | null>(null)
  const pinnedPromptScrollTopRef = useRef(0)
  const pendingPromptNavigationTargetRef = useRef<string | null>(null)
  const revealScrollHeightRef = useRef<number | null>(null)
  const observedRunRef = useRef<{ startedAt: number; turnId: string | null } | null>(null)
  const observedThinkingStartsRef = useRef(new Map<string, number>())
  const [completedTurnWindow, setCompletedTurnWindow] = useState(COMPLETED_TURN_WINDOW_SIZE)
  const [pinnedPrompt, setPinnedPrompt] = useState<KernelMessageEntry | null>(null)
  const [activePromptTurnId, setActivePromptTurnId] = useState<string | null>(null)
  const [expandedPinnedPromptId, setExpandedPinnedPromptId] = useState<string | null>(null)
  const [runElapsedByTurnId, setRunElapsedByTurnId] = useState<ReadonlyMap<string, number>>(
    () => new Map()
  )
  const [thinkingElapsedByEntryId, setThinkingElapsedByEntryId] = useState<
    ReadonlyMap<string, number>
  >(() => new Map())
  const [emptyStateSlogan] = useState(
    () => EMPTY_STATE_SLOGANS[Math.floor(Math.random() * EMPTY_STATE_SLOGANS.length)]
  )
  const pinnedPromptExpanded =
    pinnedPrompt !== null && expandedPinnedPromptId === pinnedPrompt.id
  const {
    completedTurns,
    activeEntries,
    activeTurns,
    hasActiveProcess,
    hasRunningStep,
    hasVisibleContent
  } = useMemo(() => {
    const boundary = activeRunStartIndex === null
      ? entries.length
      : Math.max(0, Math.min(activeRunStartIndex, entries.length))
    const nextActiveEntries = activeRunStartIndex === null ? [] : entries.slice(boundary)
    const nextCompletedTurns = groupConversationTurns(entries.slice(0, boundary))
    const nextActiveTurns = groupConversationTurns(nextActiveEntries)
    return {
      completedTurns: nextCompletedTurns,
      activeEntries: nextActiveEntries,
      activeTurns: nextActiveTurns,
      hasActiveProcess: nextActiveEntries.some(isProcessEntry),
      hasRunningStep: hasCurrentRunningEntry(nextActiveEntries),
      hasVisibleContent: nextCompletedTurns.length > 0 || nextActiveTurns.length > 0
    }
  }, [activeRunStartIndex, entries])
  const visibleCompletedTurns = useMemo(
    () => completedTurns.slice(Math.max(0, completedTurns.length - completedTurnWindow)),
    [completedTurnWindow, completedTurns]
  )
  const hiddenCompletedTurnCount = completedTurns.length - visibleCompletedTurns.length
  const promptByTurnId = useMemo(() => {
    const prompts = new Map<string, KernelMessageEntry>()
    for (const turn of [...visibleCompletedTurns, ...activeTurns]) {
      const { user } = splitTurn(turn)
      if (user !== null) prompts.set(turn.id, user)
    }
    return prompts
  }, [activeTurns, visibleCompletedTurns])
  const promptNavigationItems = useMemo(() => {
    const items: PromptNavigationItem[] = []
    for (const turn of [...completedTurns, ...activeTurns]) {
      const { user } = splitTurn(turn)
      if (user === null) continue
      items.push({ turnId: turn.id, prompt: user, ordinal: items.length + 1 })
    }
    return items
  }, [activeTurns, completedTurns])
  const updatePinnedPrompt = useCallback(() => {
    const viewport = viewportRef.current
    if (viewport === null) return
    const viewportRect = viewport.getBoundingClientRect()
    const readingLineOffset = pinnedPromptReadingLineOffsetRef.current ?? 0
    const readingLine = viewportRect.top + readingLineOffset
    const pinnedPromptSwitchLine = Math.max(
      readingLine,
      (chromeRef.current?.getBoundingClientRect().bottom ?? readingLine) +
        PINNED_PROMPT_SWITCH_GAP
    )
    const turnElements = viewport.querySelectorAll<HTMLElement>('[data-conversation-turn-id]')
    const turns = Array.from(turnElements, (element) => ({
      element,
      id: element.dataset.conversationTurnId ?? '',
      top: element.getBoundingClientRect().top
    })).filter((turn) => turn.id.length > 0)
    if (turns.length === 0) {
      pinnedPromptTurnIdRef.current = null
      setActivePromptTurnId(null)
      setPinnedPrompt(null)
      return
    }

    const scrollTop = viewport.scrollTop
    const scrollDelta = scrollTop - pinnedPromptScrollTopRef.current
    pinnedPromptScrollTopRef.current = scrollTop
    let currentIndex = turns.findIndex((turn) => turn.id === pinnedPromptTurnIdRef.current)
    if (currentIndex < 0) {
      currentIndex = turns.findLastIndex((turn) => turn.top <= readingLine)
      if (currentIndex < 0) currentIndex = 0
    } else if (scrollDelta >= -0.5) {
      while (
        currentIndex < turns.length - 1 &&
        turns[currentIndex + 1]!.top <= pinnedPromptSwitchLine
      ) {
        currentIndex += 1
      }
    } else if (scrollDelta < -0.5) {
      while (
        currentIndex > 0 &&
        turns[currentIndex]!.top >= readingLine + PINNED_PROMPT_SWITCH_GAP
      ) {
        currentIndex -= 1
      }
    }

    const currentTurn = turns[currentIndex]!
    pinnedPromptTurnIdRef.current = currentTurn.id
    setActivePromptTurnId((previous) => previous === currentTurn.id ? previous : currentTurn.id)
    const nextPrompt = promptByTurnId.get(currentTurn.id) ?? null
    const promptElement = currentTurn.element.querySelector<HTMLElement>('[data-user-prompt="true"]')
    const promptStillAtReadingLine = promptElement !== null &&
      promptElement.getBoundingClientRect().bottom > readingLine
    const visiblePrompt = promptStillAtReadingLine ? null : nextPrompt
    setPinnedPrompt((previous) => {
      if (previous?.id === visiblePrompt?.id) return previous === visiblePrompt ? previous : visiblePrompt
      return visiblePrompt
    })
  }, [promptByTurnId])
  const schedulePinnedPromptUpdate = useCallback(() => {
    if (pinnedPromptFrameRef.current !== null) return
    pinnedPromptFrameRef.current = requestAnimationFrame(() => {
      pinnedPromptFrameRef.current = null
      updatePinnedPrompt()
    })
  }, [updatePinnedPrompt])
  const outputEndScrollTop = useCallback((): number | null => {
    const viewport = viewportRef.current
    const outputEnd = outputEndRef.current
    if (viewport === null || outputEnd === null) return null
    const viewportRect = viewport.getBoundingClientRect()
    const outputEndRect = outputEnd.getBoundingClientRect()
    const bottomClearance = Number.parseFloat(window.getComputedStyle(viewport).paddingBottom)
    const visibleBottom = viewportRect.bottom -
      (Number.isFinite(bottomClearance) ? bottomClearance : 0)
    return Math.max(
      0,
      viewport.scrollTop + outputEndRect.bottom - visibleBottom
    )
  }, [])
  const scrollToOutputEnd = useCallback(() => {
    const viewport = viewportRef.current
    const targetTop = outputEndScrollTop()
    if (viewport === null || targetTop === null) return
    viewport.scrollTop = targetTop
  }, [outputEndScrollTop])
  const updateScrollTail = useCallback(() => {
    const viewport = viewportRef.current
    const outputEnd = outputEndRef.current
    const scrollTail = scrollTailRef.current
    if (viewport === null || outputEnd === null || scrollTail === null) return
    const turns = viewport.querySelectorAll<HTMLElement>('[data-conversation-turn-id]')
    const lastTurn = turns.item(turns.length - 1)
    if (lastTurn === null) {
      scrollTail.style.height = '0px'
      return
    }

    const viewportRect = viewport.getBoundingClientRect()
    const outputEndRect = outputEnd.getBoundingClientRect()
    const lastTurnRect = lastTurn.getBoundingClientRect()
    const readingLineOffset = pinnedPromptReadingLineOffsetRef.current ?? 0
    const bottomClearance = Number.parseFloat(window.getComputedStyle(viewport).paddingBottom)
    const outputEndOffset =
      viewport.scrollTop + outputEndRect.bottom - viewportRect.top
    const desiredMaxScrollTop = Math.max(
      0,
      viewport.scrollTop + lastTurnRect.top - viewportRect.top - readingLineOffset
    )
    const baseContentExtent = outputEndOffset +
      (Number.isFinite(bottomClearance) ? bottomClearance : 0)
    const requiredTailHeight = Math.max(
      0,
      Math.ceil(viewport.clientHeight + desiredMaxScrollTop - baseContentExtent)
    )
    if (scrollTail.offsetHeight !== requiredTailHeight) {
      scrollTail.style.height = `${requiredTailHeight}px`
    }
  }, [])
  const scrollToMountedPrompt = useCallback((turnId: string): boolean => {
    const viewport = viewportRef.current
    if (viewport === null) return false
    const turn = Array.from(
      viewport.querySelectorAll<HTMLElement>('[data-conversation-turn-id]')
    ).find((element) => element.dataset.conversationTurnId === turnId)
    if (turn === undefined) return false

    const viewportRect = viewport.getBoundingClientRect()
    const turnRect = turn.getBoundingClientRect()
    const readingLineOffset = pinnedPromptReadingLineOffsetRef.current ?? 0
    const targetTop = Math.max(
      0,
      viewport.scrollTop + turnRect.top - viewportRect.top - readingLineOffset
    )
    followOutputRef.current = false
    viewport.scrollTo({
      top: targetTop,
      behavior: 'auto'
    })
    schedulePinnedPromptUpdate()
    return true
  }, [schedulePinnedPromptUpdate])
  const navigateToPrompt = useCallback((turnId: string) => {
    if (scrollToMountedPrompt(turnId)) return
    const completedIndex = completedTurns.findIndex((turn) => turn.id === turnId)
    if (completedIndex < 0) return
    const requiredWindow = completedTurns.length - completedIndex
    pendingPromptNavigationTargetRef.current = turnId
    setCompletedTurnWindow((current) =>
      Math.max(current, Math.ceil(requiredWindow / COMPLETED_TURN_WINDOW_SIZE) * COMPLETED_TURN_WINDOW_SIZE)
    )
  }, [completedTurns, scrollToMountedPrompt])

  useLayoutEffect(() => () => {
    if (pinnedPromptFrameRef.current !== null) {
      cancelAnimationFrame(pinnedPromptFrameRef.current)
    }
  }, [])

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (viewport === null) return
    const topClearance = Number.parseFloat(window.getComputedStyle(viewport).paddingTop)
    pinnedPromptReadingLineOffsetRef.current =
      (Number.isFinite(topClearance) ? topClearance : 0) + 8
    pinnedPromptScrollTopRef.current = viewport.scrollTop
  }, [])

  useLayoutEffect(() => {
    if (
      expandedPinnedPromptId !== null &&
      expandedPinnedPromptId !== pinnedPrompt?.id
    ) {
      setExpandedPinnedPromptId(null)
    }
  }, [expandedPinnedPromptId, pinnedPrompt?.id])

  useLayoutEffect(() => {
    const shell = shellRef.current
    const viewport = viewportRef.current
    if (shell === null || viewport === null) return
    const chrome = chromeRef.current
    const updateChromeHeight = (): void => {
      const previousTopClearance = Number.parseFloat(window.getComputedStyle(viewport).paddingTop)
      shell.style.setProperty(
        '--conversation-chrome-height',
        `${chrome?.getBoundingClientRect().height ?? 0}px`
      )
      const nextTopClearance = Number.parseFloat(window.getComputedStyle(viewport).paddingTop)
      if (
        Number.isFinite(previousTopClearance) &&
        Number.isFinite(nextTopClearance) &&
        Math.abs(nextTopClearance - previousTopClearance) > 0.5
      ) {
        viewport.scrollTop += nextTopClearance - previousTopClearance
        pinnedPromptScrollTopRef.current = viewport.scrollTop
      }
      updateScrollTail()
      schedulePinnedPromptUpdate()
    }
    updateChromeHeight()
    if (chrome === null) return
    const observer = new ResizeObserver(updateChromeHeight)
    observer.observe(chrome)
    return () => observer.disconnect()
  }, [
    pinnedPrompt?.id,
    pinnedPromptExpanded,
    schedulePinnedPromptUpdate,
    title,
    updateScrollTail,
    warning
  ])

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const messageList = messageListRef.current
    updateScrollTail()
    if (viewport === null || messageList === null) return
    const observer = new ResizeObserver(updateScrollTail)
    observer.observe(viewport)
    observer.observe(messageList)
    return () => observer.disconnect()
  }, [
    compactionActive,
    hasVisibleContent,
    runtimeStatus,
    updateScrollTail
  ])

  useLayoutEffect(() => {
    updateScrollTail()
  }, [activeRunStartIndex, completedTurnWindow, entries, updateScrollTail])

  useLayoutEffect(() => {
    updatePinnedPrompt()
  }, [activeRunStartIndex, completedTurnWindow, entries, pinnedPrompt?.id, pinnedPromptExpanded, updatePinnedPrompt])

  useLayoutEffect(() => {
    const now = Date.now()
    const observedRun = observedRunRef.current
    if (activeRunStartIndex !== null) {
      const turnId = activeTurns.at(-1)?.id ?? null
      if (observedRun === null) {
        observedRunRef.current = { startedAt: now, turnId }
      } else if (turnId !== null) {
        observedRun.turnId = turnId
      }
    } else if (observedRun !== null) {
      if (observedRun.turnId !== null) {
        const elapsed = Math.max(0, now - observedRun.startedAt)
        setRunElapsedByTurnId((previous) => {
          const next = new Map(previous)
          next.set(observedRun.turnId!, elapsed)
          return next
        })
      }
      observedRunRef.current = null
    }

    const thinkingStarts = observedThinkingStartsRef.current
    const completedThinking: Array<[string, number]> = []
    for (const entry of entries) {
      if (entry.kind !== 'thinking') continue
      if (entry.streaming) {
        if (!thinkingStarts.has(entry.id)) thinkingStarts.set(entry.id, now)
        continue
      }
      const startedAt = thinkingStarts.get(entry.id)
      if (startedAt === undefined) continue
      thinkingStarts.delete(entry.id)
      completedThinking.push([entry.id, Math.max(0, now - startedAt)])
    }
    if (completedThinking.length > 0) {
      setThinkingElapsedByEntryId((previous) => {
        const next = new Map(previous)
        for (const [id, elapsed] of completedThinking) next.set(id, elapsed)
        return next
      })
    }
  }, [activeRunStartIndex, activeTurns, entries])

  useLayoutEffect(() => {
    if (followOutputRef.current) scrollToOutputEnd()
  }, [entries, activeRunStartIndex, scrollToOutputEnd])

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const previousScrollHeight = revealScrollHeightRef.current
    if (!viewport || previousScrollHeight === null) return
    viewport.scrollTop += viewport.scrollHeight - previousScrollHeight
    pinnedPromptScrollTopRef.current = viewport.scrollTop
    revealScrollHeightRef.current = null
  }, [completedTurnWindow])

  useLayoutEffect(() => {
    const pendingTurnId = pendingPromptNavigationTargetRef.current
    if (pendingTurnId === null || !scrollToMountedPrompt(pendingTurnId)) return
    pendingPromptNavigationTargetRef.current = null
  }, [completedTurnWindow, scrollToMountedPrompt])

  return (
    <div className="conversation-shell" ref={shellRef}>
      {title || warning || pinnedPrompt ? (
        <div className="conversation-chrome" ref={chromeRef}>
          {title || warning ? (
            <div className="conversation-header">
              {title ? <strong data-tooltip={title}>{title}</strong> : null}
              {warning ? <small className="connection-status-warning">{warning}</small> : null}
            </div>
          ) : null}
          {pinnedPrompt ? (
            <PinnedPrompt
              entry={pinnedPrompt}
              expanded={pinnedPromptExpanded}
              onExpandedChange={(expanded) =>
                setExpandedPinnedPromptId(expanded ? pinnedPrompt.id : null)}
            />
          ) : null}
        </div>
      ) : null}

      {showPromptNavigation && promptNavigationItems.length > 0 ? (
        <PromptNavigationRail
          activeTurnId={activePromptTurnId}
          items={promptNavigationItems}
          onNavigate={navigateToPrompt}
        />
      ) : null}

      <div
        className={`conversation-surface stealth-scroll tool-density-${toolDisplayDensity}`}
        ref={viewportRef}
        tabIndex={0}
        onScroll={(event) => {
          const target = event.currentTarget
          const targetTop = outputEndScrollTop()
          followOutputRef.current =
            targetTop !== null && Math.abs(target.scrollTop - targetTop) < 120
          schedulePinnedPromptUpdate()
        }}
      >
        {hasVisibleContent || runtimeStatus === 'running' || compactionActive ? (
          <>
            <div
              className="message-list"
              ref={messageListRef}
              aria-live={runtimeStatus === 'running' ? 'polite' : 'off'}
              aria-label="对话时间线"
            >
              {hiddenCompletedTurnCount > 0 ? (
                <button
                  className="conversation-history-reveal"
                  type="button"
                  onClick={() => {
                    const viewport = viewportRef.current
                    if (viewport) revealScrollHeightRef.current = viewport.scrollHeight
                    setCompletedTurnWindow((count) => count + COMPLETED_TURN_WINDOW_SIZE)
                  }}
                >
                  显示更早的 {Math.min(COMPLETED_TURN_WINDOW_SIZE, hiddenCompletedTurnCount)} 轮
                </button>
              ) : null}
              {visibleCompletedTurns.map((turn) => (
                <div className="conversation-virtual-row" key={turn.id}>
                  <CompletedTurn
                    turn={turn}
                    toolDisplayDensity={toolDisplayDensity}
                    runElapsedMs={runElapsedByTurnId.get(turn.id) ?? null}
                    thinkingElapsedByEntryId={thinkingElapsedByEntryId}
                  />
                </div>
              ))}
              {activeTurns.map((turn) => (
                <div className="conversation-virtual-row" key={`active:${turn.id}`}>
                  <LiveTurn
                    turn={turn}
                    toolDisplayDensity={toolDisplayDensity}
                    thinkingElapsedByEntryId={thinkingElapsedByEntryId}
                  />
                </div>
              ))}
              {canCopyLastAnswer || canExportSession || canForkSession ? (
                <div className="conversation-actions" aria-label="对话操作">
                  {canCopyLastAnswer ? (
                    <IconButton
                      className="conversation-action-button"
                      icon="copy"
                      iconSize="sm"
                      label="复制最后一条回答的原始 Markdown"
                      disabled={conversationActionBusy}
                      onClick={() => void onCopyLastAnswer().catch(() => undefined)}
                    />
                  ) : null}
                  {canExportSession ? (
                    <IconButton
                      className="conversation-action-button"
                      icon="export"
                      iconSize="sm"
                      label="导出对话为 HTML"
                      disabled={conversationActionBusy}
                      onClick={() => void onExportSession().catch(() => undefined)}
                    />
                  ) : null}
                  {canForkSession ? (
                    <IconButton
                      className="conversation-action-button"
                      icon="fork"
                      iconSize="sm"
                      label="分叉对话"
                      disabled={conversationActionBusy}
                      onClick={onForkSession}
                    />
                  ) : null}
                  {conversationActionStatus !== null ? (
                    <span className="conversation-action-feedback" role="status" aria-live="polite">
                      {conversationActionStatus}
                    </span>
                  ) : null}
                  {conversationActionError !== null ? (
                    <span className="conversation-action-feedback error" role="alert">
                      {conversationActionError}
                    </span>
                  ) : null}
                </div>
              ) : null}
              {compactionActive ? (
                <div
                  className="conversation-compaction-status"
                  role="status"
                  aria-live="polite"
                >
                  <ThinkingStatus label="正在整理上下文" />
                </div>
              ) : null}
              {runtimeStatus === 'running' &&
                !compactionActive &&
                !hasRunningStep &&
                (toolDisplayDensity === 'detailed' || !hasActiveProcess) ? (
                <div className="conversation-virtual-row active-wait-row">
                  <article className="chat-message assistant streaming thinking-placeholder">
                    <ThinkingStatus label={activeEntries.length === 0 ? '正在开始' : '正在继续'} />
                  </article>
                </div>
              ) : null}
              <div className="conversation-bottom-sentinel" ref={outputEndRef} />
            </div>
            <div
              className="conversation-scroll-tail"
              ref={scrollTailRef}
              aria-hidden="true"
            />
          </>
        ) : (
          <p className="conversation-empty-state" role="status">
            {emptyStateSlogan}
          </p>
        )}
      </div>
    </div>
  )
}

function PromptNavigationRail({
  activeTurnId,
  items,
  onNavigate
}: {
  activeTurnId: string | null
  items: PromptNavigationItem[]
  onNavigate: (turnId: string) => void
}): React.JSX.Element {
  const markerRefs = useRef<Array<HTMLButtonElement | null>>([])
  const previewDelayRef = useRef<number | null>(null)
  const previewModeRef = useRef(false)
  const [preview, setPreview] = useState<{
    item: PromptNavigationItem
    trigger: HTMLButtonElement
  } | null>(null)

  const clearPreviewDelay = useCallback(() => {
    if (previewDelayRef.current === null) return
    window.clearTimeout(previewDelayRef.current)
    previewDelayRef.current = null
  }, [])
  const closePreview = useCallback(() => {
    clearPreviewDelay()
    previewModeRef.current = false
    setPreview(null)
  }, [clearPreviewDelay])
  const showPreview = useCallback((
    item: PromptNavigationItem,
    trigger: HTMLButtonElement,
    immediate: boolean
  ) => {
    clearPreviewDelay()
    if (immediate) {
      previewModeRef.current = true
      setPreview({ item, trigger })
      return
    }
    previewDelayRef.current = window.setTimeout(() => {
      previewDelayRef.current = null
      previewModeRef.current = true
      setPreview({ item, trigger })
    }, PROMPT_NAVIGATION_PREVIEW_DELAY_MS)
  }, [clearPreviewDelay])

  useEffect(() => {
    if (preview === null) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closePreview()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [closePreview, preview])

  useEffect(() => () => clearPreviewDelay(), [clearPreviewDelay])

  const focusMarker = (index: number): void => {
    markerRefs.current[Math.max(0, Math.min(items.length - 1, index))]?.focus()
  }

  return (
    <nav
      className="prompt-navigation-rail"
      aria-label="提示词导航"
      onPointerLeave={closePreview}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) closePreview()
      }}
    >
      <ol className="prompt-navigation-list">
        {items.map((item, index) => {
          const active = item.turnId === activeTurnId
          const described = preview?.item.turnId === item.turnId
          return (
            <li key={item.turnId}>
              <button
                ref={(element) => {
                  markerRefs.current[index] = element
                }}
                className="prompt-navigation-marker"
                type="button"
                tabIndex={active || (activeTurnId === null && index === 0) ? 0 : -1}
                aria-current={active ? 'location' : undefined}
                aria-describedby={described ? 'prompt-navigation-preview' : undefined}
                aria-label={`跳转到提示词 ${item.ordinal}：${promptNavigationLabel(item.prompt)}`}
                onPointerEnter={(event) =>
                  showPreview(item, event.currentTarget, previewModeRef.current)}
                onFocus={(event) => showPreview(item, event.currentTarget, true)}
                onClick={() => onNavigate(item.turnId)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowUp') {
                    event.preventDefault()
                    focusMarker(index - 1)
                  } else if (event.key === 'ArrowDown') {
                    event.preventDefault()
                    focusMarker(index + 1)
                  } else if (event.key === 'Home') {
                    event.preventDefault()
                    focusMarker(0)
                  } else if (event.key === 'End') {
                    event.preventDefault()
                    focusMarker(items.length - 1)
                  } else if (event.key === 'Escape') {
                    event.stopPropagation()
                    closePreview()
                  }
                }}
              />
            </li>
          )
        })}
      </ol>
      {preview ? (
        <PromptNavigationPreview
          item={preview.item}
          key={preview.item.turnId}
          trigger={preview.trigger}
        />
      ) : null}
    </nav>
  )
}

function PromptNavigationPreview({
  item,
  trigger
}: {
  item: PromptNavigationItem
  trigger: HTMLButtonElement
}): React.JSX.Element | null {
  const triggerRef = useRef<HTMLElement | null>(trigger)
  const { popoverRef, position } = useViewportPopoverPosition(
    true,
    triggerRef,
    240,
    { axis: 'horizontal', preferredWidth: 320 }
  )
  if (position === null) return null
  const attachments = item.prompt.attachments ?? []
  return createPortal(
    <div
      className={`prompt-navigation-preview ${position.placement}`}
      id="prompt-navigation-preview"
      ref={popoverRef}
      role="tooltip"
      style={position.style}
    >
      <strong>提示词 {item.ordinal}</strong>
      {item.prompt.text.trim().length > 0 ? <p>{item.prompt.text}</p> : null}
      {attachments.length > 0 ? (
        <small>{attachments.map((attachment) => attachment.name).join('、')}</small>
      ) : null}
    </div>,
    document.body
  )
}

function PinnedPrompt({
  entry,
  expanded,
  onExpandedChange
}: {
  entry: KernelMessageEntry
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
}): React.JSX.Element {
  const attachments = entry.attachments ?? []
  const canExpand = entry.text.length > 180 || entry.text.split('\n').length > 3 || attachments.length > 2
  return (
    <section
      className={`pinned-prompt${expanded ? ' expanded' : ''}${canExpand ? ' collapsible' : ''}`}
      aria-label={canExpand ? '当前轮次的提示词，悬浮或聚焦时展开' : '当前轮次的提示词'}
      tabIndex={canExpand ? 0 : undefined}
      onPointerEnter={() => {
        if (canExpand) onExpandedChange(true)
      }}
      onPointerLeave={(event) => {
        if (canExpand && !event.currentTarget.matches(':focus-within')) {
          onExpandedChange(false)
        }
      }}
      onFocus={() => {
        if (canExpand) onExpandedChange(true)
      }}
      onBlur={(event) => {
        if (
          canExpand &&
          !event.currentTarget.contains(event.relatedTarget) &&
          !event.currentTarget.matches(':hover')
        ) {
          onExpandedChange(false)
        }
      }}
    >
      <div className="pinned-prompt-content stealth-scroll" id="pinned-prompt-content">
        <MessageAttachments attachments={attachments} role="user" label="当前提示词附件" />
        {entry.text.trim().length > 0 ? (
          <article className="chat-message user">
            <MarkdownMessage text={entry.text} streaming={false} />
          </article>
        ) : null}
      </div>
    </section>
  )
}
function promptNavigationLabel(entry: KernelMessageEntry): string {
  const text = entry.text.replace(/\s+/g, ' ').trim()
  if (text.length > 0) return text.length > 72 ? `${text.slice(0, 71)}…` : text
  const attachmentNames = (entry.attachments ?? []).map((attachment) => attachment.name)
  return attachmentNames.length > 0 ? `附件：${attachmentNames.join('、')}` : '空提示词'
}
