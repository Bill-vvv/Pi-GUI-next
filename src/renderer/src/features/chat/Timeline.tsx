import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import type {
  KernelConversationEntry,
  KernelMessageEntry,
  RuntimeStatus
} from '../../../../shared/kernel-contract'
import { IconButton } from '../../components/IconButton'
import { useViewportPopoverPosition } from '../../components/useViewportPopoverPosition'
import { isTodoWriteToolEntry } from '../../todo-state'
import type { ToolDisplayDensity } from '../../tool-display-density'
import {
  SubagentTaskInteractionContext,
  type SubagentTaskInteraction
} from './SubagentTaskDetail'
import type { SubagentTaskSelection } from './subagent-task-detail-model'
import {
  CompletedTurn,
  groupConversationTurns,
  hasCurrentRunningEntry,
  isProcessEntry,
  latestThinkingSummaryLabel,
  LiveTurn,
  splitTurn,
  ThinkingStatus,
  TimelineSessionKeyContext,
  turnFinalAnswerText,
  turnForkUserText
} from './TimelineTurns'

type TimelineProps = {
  entries: KernelConversationEntry[]
  activeRunStartIndex: number | null
  runtimeStatus: RuntimeStatus
  compactionActive: boolean
  showPromptNavigation: boolean
  toolDisplayDensity: ToolDisplayDensity
  sessionKey: string | null
  canCopyAnswers: boolean
  canExportSession: boolean
  canForkSession: boolean
  conversationActionBusy: boolean
  conversationActionStatus: string | null
  conversationActionError: string | null
  onCopyAnswer: (text: string) => Promise<void>
  onExportSession: () => Promise<void>
  onForkTurn: (userText: string) => void
  subagentTaskSelection: SubagentTaskSelection | null
  onOpenSubagentTask: SubagentTaskInteraction['onOpen']
  title?: string
  warning: string | null
}

type PromptNavigationItem = {
  turnId: string
  prompt: KernelMessageEntry
  ordinal: number
}

const COMPLETED_TURN_WINDOW_SIZE = 60
const ACTIVE_PROMPT_SWITCH_GAP = 8
const PROMPT_NAVIGATION_PREVIEW_DELAY_MS = 360
const MAGIC_CONTEXT_LIVE_STATUS_ID = 'extension-status:magic-context'
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
  sessionKey,
  canCopyAnswers,
  canExportSession,
  canForkSession,
  conversationActionBusy,
  conversationActionStatus,
  conversationActionError,
  onCopyAnswer,
  onExportSession,
  onForkTurn,
  subagentTaskSelection,
  onOpenSubagentTask,
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
  const activePromptFrameRef = useRef<number | null>(null)
  const readingLineOffsetRef = useRef<number | null>(null)
  const activePromptTurnIdRef = useRef<string | null>(null)
  const activePromptScrollTopRef = useRef(0)
  const pendingPromptNavigationTargetRef = useRef<string | null>(null)
  const revealScrollHeightRef = useRef<number | null>(null)
  const observedRunRef = useRef<{ startedAt: number; turnId: string | null } | null>(null)
  const observedThinkingStartsRef = useRef(new Map<string, number>())
  const [completedTurnWindow, setCompletedTurnWindow] = useState(COMPLETED_TURN_WINDOW_SIZE)
  const [actionTurnId, setActionTurnId] = useState<string | null>(null)
  const [actionFeedbackTurnId, setActionFeedbackTurnId] = useState<string | null>(null)
  const [activePromptTurnId, setActivePromptTurnId] = useState<string | null>(null)
  const [runElapsedByTurnId, setRunElapsedByTurnId] = useState<ReadonlyMap<string, number>>(
    () => new Map()
  )
  const [thinkingElapsedByEntryId, setThinkingElapsedByEntryId] = useState<
    ReadonlyMap<string, number>
  >(() => new Map())
  const [emptyStateSlogan] = useState(
    () => EMPTY_STATE_SLOGANS[Math.floor(Math.random() * EMPTY_STATE_SLOGANS.length)]
  )
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
    const nextActiveEntries = activeRunStartIndex === null
      ? []
      : entries
          .slice(boundary)
          .filter(isTimelineEntryVisible)
    const nextCompletedTurns = groupConversationTurns(
      entries
        .slice(0, boundary)
        .filter(isTimelineEntryVisible)
    )
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
  const subagentTaskInteraction = useMemo<SubagentTaskInteraction>(() => ({
    selection: subagentTaskSelection,
    onOpen: onOpenSubagentTask
  }), [onOpenSubagentTask, subagentTaskSelection])
  useEffect(() => {
    if (actionTurnId === null) return
    if (visibleCompletedTurns.some((turn) => turn.id === actionTurnId)) return
    setActionTurnId(null)
  }, [actionTurnId, visibleCompletedTurns])
  useEffect(() => {
    if (actionFeedbackTurnId === null) return
    if (visibleCompletedTurns.some((turn) => turn.id === actionFeedbackTurnId)) return
    setActionFeedbackTurnId(null)
  }, [actionFeedbackTurnId, visibleCompletedTurns])
  useEffect(() => {
    if (conversationActionStatus !== null || conversationActionError !== null) return
    setActionFeedbackTurnId(null)
  }, [conversationActionError, conversationActionStatus])
  const promptNavigationItems = useMemo(() => {
    const items: PromptNavigationItem[] = []
    for (const turn of [...completedTurns, ...activeTurns]) {
      const { user } = splitTurn(turn)
      if (user === null) continue
      items.push({ turnId: turn.id, prompt: user, ordinal: items.length + 1 })
    }
    return items
  }, [activeTurns, completedTurns])
  const updateActivePromptTurn = useCallback(() => {
    const viewport = viewportRef.current
    if (viewport === null) return
    const viewportRect = viewport.getBoundingClientRect()
    const readingLineOffset = readingLineOffsetRef.current ?? 0
    const readingLine = viewportRect.top + readingLineOffset
    const activePromptSwitchLine = Math.max(
      readingLine,
      (chromeRef.current?.getBoundingClientRect().bottom ?? readingLine) +
        ACTIVE_PROMPT_SWITCH_GAP
    )
    const turnElements = viewport.querySelectorAll<HTMLElement>('[data-conversation-turn-id]')
    const turns = Array.from(turnElements, (element) => ({
      id: element.dataset.conversationTurnId ?? '',
      top: element.getBoundingClientRect().top
    })).filter((turn) => turn.id.length > 0)
    if (turns.length === 0) {
      activePromptTurnIdRef.current = null
      setActivePromptTurnId(null)
      return
    }

    const scrollTop = viewport.scrollTop
    const scrollDelta = scrollTop - activePromptScrollTopRef.current
    activePromptScrollTopRef.current = scrollTop
    let currentIndex = turns.findIndex((turn) => turn.id === activePromptTurnIdRef.current)
    if (currentIndex < 0) {
      currentIndex = turns.findLastIndex((turn) => turn.top <= readingLine)
      if (currentIndex < 0) currentIndex = 0
    } else if (scrollDelta >= -0.5) {
      while (
        currentIndex < turns.length - 1 &&
        turns[currentIndex + 1]!.top <= activePromptSwitchLine
      ) {
        currentIndex += 1
      }
    } else if (scrollDelta < -0.5) {
      while (
        currentIndex > 0 &&
        turns[currentIndex]!.top >= readingLine + ACTIVE_PROMPT_SWITCH_GAP
      ) {
        currentIndex -= 1
      }
    }

    const currentTurn = turns[currentIndex]!
    activePromptTurnIdRef.current = currentTurn.id
    setActivePromptTurnId((previous) => previous === currentTurn.id ? previous : currentTurn.id)
  }, [])
  const scheduleActivePromptTurnUpdate = useCallback(() => {
    if (activePromptFrameRef.current !== null) return
    activePromptFrameRef.current = requestAnimationFrame(() => {
      activePromptFrameRef.current = null
      updateActivePromptTurn()
    })
  }, [updateActivePromptTurn])
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
    const readingLineOffset = readingLineOffsetRef.current ?? 0
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
    const readingLineOffset = readingLineOffsetRef.current ?? 0
    const targetTop = Math.max(
      0,
      viewport.scrollTop + turnRect.top - viewportRect.top - readingLineOffset
    )
    followOutputRef.current = false
    viewport.scrollTo({
      top: targetTop,
      behavior: 'auto'
    })
    scheduleActivePromptTurnUpdate()
    return true
  }, [scheduleActivePromptTurnUpdate])
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
    if (activePromptFrameRef.current !== null) {
      cancelAnimationFrame(activePromptFrameRef.current)
    }
  }, [])

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (viewport === null) return
    const topClearance = Number.parseFloat(window.getComputedStyle(viewport).paddingTop)
    readingLineOffsetRef.current =
      (Number.isFinite(topClearance) ? topClearance : 0) + 8
    activePromptScrollTopRef.current = viewport.scrollTop
  }, [])

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
        activePromptScrollTopRef.current = viewport.scrollTop
      }
      updateScrollTail()
      scheduleActivePromptTurnUpdate()
    }
    updateChromeHeight()
    if (chrome === null) return
    const observer = new ResizeObserver(updateChromeHeight)
    observer.observe(chrome)
    return () => observer.disconnect()
  }, [
    scheduleActivePromptTurnUpdate,
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
    updateActivePromptTurn()
  }, [activeRunStartIndex, completedTurnWindow, entries, updateActivePromptTurn])

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
    activePromptScrollTopRef.current = viewport.scrollTop
    revealScrollHeightRef.current = null
  }, [completedTurnWindow])

  useLayoutEffect(() => {
    const pendingTurnId = pendingPromptNavigationTargetRef.current
    if (pendingTurnId === null || !scrollToMountedPrompt(pendingTurnId)) return
    pendingPromptNavigationTargetRef.current = null
  }, [completedTurnWindow, scrollToMountedPrompt])

  return (
    <TimelineSessionKeyContext.Provider value={sessionKey}>
    <SubagentTaskInteractionContext.Provider value={subagentTaskInteraction}>
    <div className="conversation-shell" ref={shellRef}>
      {title || warning ? (
        <div className="conversation-chrome" ref={chromeRef}>
          <div className="conversation-header">
            {title ? <strong data-tooltip={title}>{title}</strong> : null}
            {warning ? <small className="connection-status-warning">{warning}</small> : null}
          </div>
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
          scheduleActivePromptTurnUpdate()
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
              {visibleCompletedTurns.map((turn) => {
                const answerText = canCopyAnswers ? turnFinalAnswerText(turn) : null
                const forkUserText = canForkSession ? turnForkUserText(turn) : null
                const canCopyTurn = answerText !== null
                const canForkTurn = forkUserText !== null
                const canShowTurnActions = canCopyTurn || canForkTurn || canExportSession
                const showTurnActions = actionTurnId === turn.id && canShowTurnActions
                const showTurnFeedback = actionFeedbackTurnId === turn.id &&
                  (conversationActionStatus !== null || conversationActionError !== null)
                const showTurnActionSurface = showTurnActions || showTurnFeedback
                return (
                  <div
                    className="conversation-virtual-row conversation-turn-shell"
                    key={turn.id}
                    onPointerEnter={() => {
                      if (!canShowTurnActions) return
                      setActionTurnId(turn.id)
                    }}
                    onPointerLeave={(event) => {
                      const next = event.relatedTarget
                      if (next instanceof Node && event.currentTarget.contains(next)) return
                      setActionTurnId((current) => (current === turn.id ? null : current))
                    }}
                    onFocusCapture={() => {
                      if (!canShowTurnActions) return
                      setActionTurnId(turn.id)
                    }}
                    onBlurCapture={(event) => {
                      const next = event.relatedTarget
                      if (next instanceof Node && event.currentTarget.contains(next)) return
                      setActionTurnId((current) => (current === turn.id ? null : current))
                    }}
                  >
                    <CompletedTurn
                      turn={turn}
                      toolDisplayDensity={toolDisplayDensity}
                      runElapsedMs={runElapsedByTurnId.get(turn.id) ?? null}
                      thinkingElapsedByEntryId={thinkingElapsedByEntryId}
                    />
                    {canShowTurnActions ? (
                      <div
                        className={`conversation-turn-actions${showTurnActionSurface ? ' is-visible' : ''}`}
                        aria-label="对话操作"
                      >
                        {canCopyTurn ? (
                          <IconButton
                            className="conversation-action-button"
                            icon="copy"
                            iconSize="sm"
                            label="复制本轮回答的原始 Markdown"
                            disabled={conversationActionBusy}
                            onClick={() => {
                              setActionFeedbackTurnId(turn.id)
                              void onCopyAnswer(answerText).catch(() => undefined)
                            }}
                          />
                        ) : null}
                        {canExportSession ? (
                          <IconButton
                            className="conversation-action-button"
                            icon="export"
                            iconSize="sm"
                            label="导出对话为 HTML"
                            disabled={conversationActionBusy}
                            onClick={() => {
                              setActionFeedbackTurnId(turn.id)
                              void onExportSession().catch(() => undefined)
                            }}
                          />
                        ) : null}
                        {canForkTurn ? (
                          <IconButton
                            className="conversation-action-button"
                            icon="fork"
                            iconSize="sm"
                            label="从此轮用户消息分叉对话"
                            disabled={conversationActionBusy}
                            onClick={() => onForkTurn(forkUserText)}
                          />
                        ) : null}
                        {showTurnFeedback && conversationActionStatus !== null ? (
                          <span
                            className="conversation-action-feedback"
                            role="status"
                            aria-live="polite"
                          >
                            {conversationActionStatus}
                          </span>
                        ) : null}
                        {showTurnFeedback && conversationActionError !== null ? (
                          <span className="conversation-action-feedback error" role="alert">
                            {conversationActionError}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                )
              })}
              {activeTurns.map((turn) => (
                <div className="conversation-virtual-row" key={`active:${turn.id}`}>
                  <LiveTurn
                    turn={turn}
                    toolDisplayDensity={toolDisplayDensity}
                    thinkingElapsedByEntryId={thinkingElapsedByEntryId}
                  />
                </div>
              ))}
              {actionFeedbackTurnId === null &&
              (conversationActionStatus !== null || conversationActionError !== null) ? (
                <div className="conversation-actions" aria-label="对话操作反馈">
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
                    <ThinkingStatus
                      label={activeEntries.length === 0
                        ? '正在开始'
                        : latestThinkingSummaryLabel(activeEntries) ?? '正在继续'}
                    />
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
    </SubagentTaskInteractionContext.Provider>
    </TimelineSessionKeyContext.Provider>
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

function promptNavigationLabel(entry: KernelMessageEntry): string {
  const text = entry.text.replace(/\s+/g, ' ').trim()
  if (text.length > 0) return text.length > 72 ? `${text.slice(0, 71)}…` : text
  const attachmentNames = (entry.attachments ?? []).map((attachment) => attachment.name)
  return attachmentNames.length > 0 ? `附件：${attachmentNames.join('、')}` : '空提示词'
}

export function isTimelineEntryVisible(entry: KernelConversationEntry): boolean {
  if (isTodoWriteToolEntry(entry)) return false
  if (entry.kind !== 'extension-status' || entry.id !== MAGIC_CONTEXT_LIVE_STATUS_ID) return true
  return entry.level === 'warning' || entry.level === 'error'
}
