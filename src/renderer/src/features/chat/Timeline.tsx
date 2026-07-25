import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import type {
  KernelConversationEntry,
  KernelErrorEntry,
  KernelMessageAttachment,
  KernelMessageEntry,
  KernelThinkingEntry,
  KernelToolEntry,
  RuntimeStatus
} from '../../../../shared/kernel-contract'
import { MarkdownMessage } from './MarkdownMessage'
import { IconButton } from '../../components/IconButton'
import { useViewportPopoverPosition } from '../../components/useViewportPopoverPosition'
import type { ToolDisplayDensity } from '../../tool-display-density'

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

type ConversationTurn = {
  id: string
  entries: KernelConversationEntry[]
}

type CommentaryEntry = KernelMessageEntry & {
  role: 'assistant'
  phase: 'commentary'
}

type ProcessEntry = KernelThinkingEntry | KernelToolEntry | CommentaryEntry
type NarrativeEntry = KernelThinkingEntry | CommentaryEntry

type LiveChunk =
  | { id: string; kind: 'process'; entries: ProcessEntry[] }
  | { id: string; kind: 'entry'; entry: KernelMessageEntry | KernelErrorEntry }

type ToolFileOperation = 'read' | 'modify'

type ToolFileInfo = {
  operation: ToolFileOperation
  path: string
  detail: string | null
}

type ToolFileReference = ToolFileInfo & {
  entry: KernelToolEntry
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
    return {
      completedTurns: groupConversationTurns(entries.slice(0, boundary)),
      activeEntries: nextActiveEntries,
      activeTurns: groupConversationTurns(nextActiveEntries),
      hasActiveProcess: nextActiveEntries.some(isProcessEntry),
      hasRunningStep: currentRunningEntry(nextActiveEntries) !== undefined,
      hasVisibleContent: entries.some(isVisibleEntry)
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

const CompletedTurn = memo(function CompletedTurn({
  turn,
  toolDisplayDensity,
  runElapsedMs,
  thinkingElapsedByEntryId
}: {
  turn: ConversationTurn
  toolDisplayDensity: ToolDisplayDensity
  runElapsedMs: number | null
  thinkingElapsedByEntryId: ReadonlyMap<string, number>
}): React.JSX.Element {
  const { user, responseEntries } = splitTurn(turn)
  const processEntries = responseEntries.filter(isProcessEntry)
  const answerEntries = responseEntries.filter(
    (entry): entry is KernelMessageEntry | KernelErrorEntry =>
      (entry.kind === 'message' && entry.phase !== 'commentary') || entry.kind === 'error'
  )

  return (
    <section className="conversation-run completed" data-conversation-turn-id={turn.id}>
      {user ? <MessageEntry entry={user} promptAnchor /> : null}
      <div className="assistant-run">
        {processEntries.length > 0 ? (
          <CompletedProcess
            entries={processEntries}
            toolDisplayDensity={toolDisplayDensity}
            runElapsedMs={runElapsedMs}
            thinkingElapsedByEntryId={thinkingElapsedByEntryId}
          />
        ) : null}
        {answerEntries.map((entry) => (
          <TimelineContentEntry entry={entry} key={entry.id} />
        ))}
      </div>
    </section>
  )
}, sameTurnEntries)

const LiveTurn = memo(function LiveTurn({
  turn,
  toolDisplayDensity,
  thinkingElapsedByEntryId
}: {
  turn: ConversationTurn
  toolDisplayDensity: ToolDisplayDensity
  thinkingElapsedByEntryId: ReadonlyMap<string, number>
}): React.JSX.Element {
  const { user, responseEntries } = splitTurn(turn)
  const chunks = buildLiveChunks(responseEntries)

  return (
    <section className="conversation-run active" data-conversation-turn-id={turn.id}>
      {user ? <MessageEntry entry={user} promptAnchor /> : null}
      <div className="assistant-run live">
        {chunks.map((chunk) =>
          chunk.kind === 'process' ? (
            <LiveProcess
              entries={chunk.entries}
              toolDisplayDensity={toolDisplayDensity}
              thinkingElapsedByEntryId={thinkingElapsedByEntryId}
              key={chunk.id}
            />
          ) : (
            <TimelineContentEntry entry={chunk.entry} key={chunk.id} />
          )
        )}
      </div>
    </section>
  )
}, sameTurnEntries)

function CompletedProcess({
  entries,
  toolDisplayDensity,
  runElapsedMs,
  thinkingElapsedByEntryId
}: {
  entries: ProcessEntry[]
  toolDisplayDensity: ToolDisplayDensity
  runElapsedMs: number | null
  thinkingElapsedByEntryId: ReadonlyMap<string, number>
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)

  return (
    <details
      className="completed-process"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="completed-process-summary">
        <span className="completed-process-title">
          已处理{runElapsedMs === null ? '' : ` ${formatDuration(runElapsedMs)}`}
        </span>
        <span className="completed-process-expand" aria-hidden="true" />
      </summary>
      {expanded ? (
        <div className="completed-process-body">
          <ProcessSequence
            entries={entries}
            toolDisplayDensity={toolDisplayDensity}
            thinkingElapsedByEntryId={thinkingElapsedByEntryId}
          />
        </div>
      ) : null}
    </details>
  )
}

function LiveProcess({
  entries,
  toolDisplayDensity,
  thinkingElapsedByEntryId
}: {
  entries: ProcessEntry[]
  toolDisplayDensity: ToolDisplayDensity
  thinkingElapsedByEntryId: ReadonlyMap<string, number>
}): React.JSX.Element {
  const activeEntry = currentRunningEntry(entries)
  if (toolDisplayDensity === 'detailed') {
    return (
      <ProcessSequence
        activeEntryId={activeEntry?.id ?? null}
        entries={entries}
        toolDisplayDensity={toolDisplayDensity}
        thinkingElapsedByEntryId={thinkingElapsedByEntryId}
        pinThinking
      />
    )
  }

  const narrativeEntries = toolDisplayDensity === 'standard'
    ? entries.filter(
        (entry): entry is NarrativeEntry =>
          entry.kind === 'message' || (entry.kind === 'thinking' && !entry.summary)
      )
    : []
  const narrativeIds = new Set(narrativeEntries.map((entry) => entry.id))
  const detailEntries = entries.filter((entry) => !narrativeIds.has(entry.id))
  const narrativeIsCurrent = activeEntry !== undefined && narrativeIds.has(activeEntry.id)

  return (
    <ol
      className={`process-step-list live-process-condensed tool-density-${toolDisplayDensity}`}
      aria-label="当前工作过程"
    >
      {narrativeEntries.map((entry) =>
        entry.kind === 'thinking' ? (
          <ThinkingStep
            active={entry.id === activeEntry?.id}
            entry={entry}
            elapsedMs={thinkingElapsedByEntryId.get(entry.id) ?? null}
            key={entry.id}
            pinned
          />
        ) : (
          <CommentaryStep entry={entry} key={entry.id} />
        )
      )}
      {!narrativeIsCurrent ? (
        <LiveProcessStatus
          activeEntryId={activeEntry?.id ?? null}
          detailEntries={detailEntries}
          entries={entries}
          toolDisplayDensity={toolDisplayDensity}
          thinkingElapsedByEntryId={thinkingElapsedByEntryId}
        />
      ) : null}
    </ol>
  )
}

function ProcessSequence({
  activeEntryId = null,
  entries,
  toolDisplayDensity,
  thinkingElapsedByEntryId,
  pinThinking = false
}: {
  activeEntryId?: string | null
  entries: ProcessEntry[]
  toolDisplayDensity: ToolDisplayDensity
  thinkingElapsedByEntryId: ReadonlyMap<string, number>
  pinThinking?: boolean
}): React.JSX.Element {
  const tools = entries.filter((entry): entry is KernelToolEntry => entry.kind === 'tool')
  const firstToolId = tools[0]?.id ?? null
  return (
    <ol className={`process-step-list tool-density-${toolDisplayDensity}`} aria-label="工作过程">
      {entries.map((entry) => {
        if (entry.kind === 'thinking') {
          return (
            <ThinkingStep
              active={entry.id === activeEntryId}
              entry={entry}
              elapsedMs={thinkingElapsedByEntryId.get(entry.id) ?? null}
              pinned={pinThinking}
              key={entry.id}
            />
          )
        }
        if (entry.kind === 'message') {
          return <CommentaryStep entry={entry} key={entry.id} />
        }
        if (toolDisplayDensity === 'compact') {
          return entry.id === firstToolId
            ? <ToolGroupSummary entries={tools} key={`tools:${entry.id}`} />
            : null
        }
        return (
          <ToolStep
            entry={entry}
            detailed={toolDisplayDensity === 'detailed'}
            key={entry.id}
          />
        )
      })}
    </ol>
  )
}

function LiveProcessStatus({
  activeEntryId,
  detailEntries,
  entries,
  toolDisplayDensity,
  thinkingElapsedByEntryId
}: {
  activeEntryId: string | null
  detailEntries: ProcessEntry[]
  entries: ProcessEntry[]
  toolDisplayDensity: ToolDisplayDensity
  thinkingElapsedByEntryId: ReadonlyMap<string, number>
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const status = <ThinkingStatus label={liveProcessStatusLabel(entries)} />
  if (detailEntries.length === 0) {
    return <li className="live-process-status-row">{status}</li>
  }
  return (
    <li className="live-process-status-row">
      <details
        className="live-process-status"
        open={expanded}
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary className="live-process-status-summary">
          {status}
          <span className="process-step-expand" aria-hidden="true" />
        </summary>
        {expanded ? (
          <div className="live-process-status-detail">
            <ProcessSequence
              activeEntryId={activeEntryId}
              entries={detailEntries}
              toolDisplayDensity={toolDisplayDensity}
              thinkingElapsedByEntryId={thinkingElapsedByEntryId}
            />
          </div>
        ) : null}
      </details>
    </li>
  )
}

function CommentaryStep({ entry }: { entry: CommentaryEntry }): React.JSX.Element {
  return (
    <li className={`process-step commentary${entry.streaming ? ' running' : ' completed'}`}>
      <MessageEntry entry={entry} />
    </li>
  )
}

function ToolGroupSummary({ entries }: { entries: KernelToolEntry[] }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const running = entries.some((entry) => entry.status === 'pending' || entry.status === 'running')
  const failed = entries.some((entry) => entry.status === 'error')
  return (
    <li className={`tool-group-summary${running ? ' running' : ''}${failed ? ' failed' : ''}`}>
      <details
        className="tool-group-details"
        open={expanded}
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary className="tool-group-summary-row">
          <span className="process-step-text">{summarizeTools(entries)}</span>
          <span className="process-step-meta">
            {running ? '进行中' : failed ? '部分失败' : '完成'}
          </span>
          <span className="process-step-expand" aria-hidden="true" />
        </summary>
        {expanded ? (
          <ol className="tool-group-entries" aria-label="工具调用">
            {entries.map((entry) => (
              <ToolStep entry={entry} detailed={false} key={entry.id} />
            ))}
          </ol>
        ) : null}
      </details>
    </li>
  )
}

function ThinkingStep({
  active = false,
  entry,
  elapsedMs,
  pinned = false
}: {
  active?: boolean
  entry: KernelThinkingEntry
  elapsedMs: number | null
  pinned?: boolean
}): React.JSX.Element {
  const status = active ? 'running' : 'completed'
  const hasText = entry.text.trim().length > 0
  const [expanded, setExpanded] = useState(pinned || active)
  const previousActiveRef = useRef(active)
  useLayoutEffect(() => {
    const wasActive = previousActiveRef.current
    if (!pinned) {
      if (active && !wasActive) setExpanded(true)
      if (!active && wasActive) setExpanded(false)
    }
    previousActiveRef.current = active
  }, [active, pinned])
  return (
    <li className={`process-step thinking ${entry.summary ? 'summary' : 'narrative'} ${status}`}>
      <details
        className="process-thinking"
        open={expanded}
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary className="process-thinking-summary">
          <span className="process-thinking-title">
            {active
              ? <ThinkingStatus label="正在思考" />
              : elapsedMs === null ? '思考' : `思考了 ${formatDuration(elapsedMs)}`}
          </span>
          <span className="process-thinking-expand" aria-hidden="true" />
        </summary>
        {expanded && hasText ? (
          <div className="process-thinking-detail">
            <MarkdownMessage text={entry.text} streaming={active} />
          </div>
        ) : null}
      </details>
    </li>
  )
}

function ToolStep({
  entry,
  detailed
}: {
  entry: KernelToolEntry
  detailed: boolean
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const status = activityStatus(entry)
  const file = toolFileInfo(entry)
  const target = file?.path ?? toolTarget(entry)
  const detail = entry.output || entry.details
  if (!detailed) {
    const args = parseToolArgs(entry.args)
    const command = compactToolName(entry.name) === 'bash' && args !== null
      ? stringArgument(args, ['command'])
      : null
    if (command !== null) {
      return (
        <li className={`process-step tool standard ${status}`}>
          <details
            className="process-standard-tool"
            open={expanded}
            onToggle={(event) => setExpanded(event.currentTarget.open)}
          >
            <summary className="process-step-summary tool-standard-summary standard-tool-summary">
              <span className="process-step-text">
                {entry.status === 'error'
                  ? '运行失败'
                  : entry.status === 'success' ? '已运行' : '正在运行'}{' '}
                {compactTarget(command)}
              </span>
              {entry.status === 'success' ? null : (
                <span className="process-step-meta">{toolStatusLabel(entry)}</span>
              )}
              <span className="process-step-expand" aria-hidden="true" />
            </summary>
            {expanded ? (
              <div className="standard-tool-detail">
                <pre>{command}</pre>
              </div>
            ) : null}
          </details>
        </li>
      )
    }
    return (
      <li className={`process-step tool standard ${status}`}>
        <details
          className="process-standard-tool"
          open={expanded}
          onToggle={(event) => setExpanded(event.currentTarget.open)}
        >
          <summary className="process-step-summary tool-standard-summary standard-tool-summary">
            <span className="process-step-text">
              {toolActivityPrefix(entry, file)}{' '}
              {file ? <FileReference file={{ ...file, entry }} basenameOnly /> : target}
            </span>
            {entry.status === 'success' ? null : (
              <span className="process-step-meta">{toolStatusLabel(entry)}</span>
            )}
            <span className="process-step-expand" aria-hidden="true" />
          </summary>
          {expanded ? <ToolDetailContent entry={entry} detail={detail} /> : null}
        </details>
      </li>
    )
  }
  return <DetailedToolStep entry={entry} file={file} target={target} detail={detail} status={status} />
}

function DetailedToolStep({
  entry,
  file,
  target,
  detail,
  status
}: {
  entry: KernelToolEntry
  file: ToolFileInfo | null
  target: string
  detail: string
  status: ReturnType<typeof activityStatus>
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(true)
  return (
    <li className={`process-step tool detailed ${status}`}>
      <details
        className="process-tool-details"
        open={expanded}
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary className="process-step-summary">
          <span className="process-step-tool">{compactToolName(entry.name)}</span>
          <span className="process-step-text">
            {toolActivityPrefix(entry, file)}{' '}
            {file ? <FileReference file={{ ...file, entry }} basenameOnly /> : target}
          </span>
          <span className="process-step-meta">
            {entry.durationMs === null ? toolStatusLabel(entry) : formatDuration(entry.durationMs)}
          </span>
          <span className="process-step-expand" aria-hidden="true" />
        </summary>
        {expanded ? <ToolDetailContent entry={entry} detail={detail} /> : null}
      </details>
    </li>
  )
}

function ToolDetailContent({
  entry,
  detail
}: {
  entry: KernelToolEntry
  detail: string
}): React.JSX.Element {
  return (
    <div className="process-tool-detail">
      {entry.args ? (
        <section>
          <span>输入</span>
          <pre>{entry.args}</pre>
        </section>
      ) : null}
      {detail ? (
        <section>
          <span>{entry.output ? '输出' : '详情'}</span>
          <pre>{detail}</pre>
        </section>
      ) : <p>等待工具输出</p>}
      {entry.truncated ? <small>输出已截断</small> : null}
    </div>
  )
}

function FileReference({
  file,
  basenameOnly = false
}: {
  file: ToolFileReference
  basenameOnly?: boolean
}): React.JSX.Element {
  const operation = file.operation === 'read' ? '读取' : '修改'
  const status = toolStatusLabel(file.entry)
  const duration = file.entry.durationMs === null ? null : formatDuration(file.entry.durationMs)
  return (
    <span
      className={`tool-file-reference ${file.operation}`}
      aria-label={`${operation}文件 ${file.path}`}
    >
      <span className="tool-file-reference-label">
        {basenameOnly ? fileBasename(file.path) : compactTarget(file.path)}
      </span>
      <span className="tool-file-tooltip" role="tooltip">
        <strong>{fileBasename(file.path)}</strong>
        <code>{file.path}</code>
        <span>{operation}{file.detail ? ` · ${file.detail}` : ''}</span>
        <span>{status}{duration ? ` · ${duration}` : ''}</span>
      </span>
    </span>
  )
}

function TimelineContentEntry({
  entry
}: {
  entry: KernelMessageEntry | KernelErrorEntry
}): React.JSX.Element | null {
  if (entry.kind === 'message') return <MessageEntry entry={entry} />
  return (
    <article className="chat-message error" role="alert">
      <pre>{entry.title}: {entry.message}</pre>
    </article>
  )
}

function MessageEntry({
  entry,
  promptAnchor = false
}: {
  entry: KernelMessageEntry
  promptAnchor?: boolean
}): React.JSX.Element | null {
  const hasText = entry.text.trim().length > 0
  const attachments = entry.attachments ?? []
  const aborted = entry.stopReason === 'aborted'
  if (!hasText && attachments.length === 0 && !entry.error && !entry.streaming && !aborted) return null

  return (
    <div className="conversation-turn" data-user-prompt={promptAnchor ? 'true' : undefined}>
      <MessageAttachments attachments={attachments} role={entry.role} />
      {hasText ? (
        <article className={`chat-message ${entry.role}${entry.streaming ? ' streaming' : ''}`}>
          <MarkdownMessage text={entry.text} streaming={entry.streaming} />
        </article>
      ) : entry.streaming ? (
        <article className="chat-message assistant streaming thinking-placeholder">
          <ThinkingStatus label="正在生成回答" />
        </article>
      ) : null}
      {aborted ? (
        <article className="chat-message aborted" role="status">
          <span>{abortedMessage(entry.error)}</span>
        </article>
      ) : entry.error ? (
        <article className="chat-message error" role="alert">
          <pre>{entry.error}</pre>
        </article>
      ) : null}
    </div>
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

function MessageAttachments({
  attachments,
  role,
  label = '消息附件'
}: {
  attachments: KernelMessageAttachment[]
  role: KernelMessageEntry['role']
  label?: string
}): React.JSX.Element | null {
  if (attachments.length === 0) return null
  return (
    <ul className={`message-attachment-list ${role}`} aria-label={label}>
      {attachments.map((attachment, index) => (
        <li
          className={`message-attachment ${attachment.type}`}
          data-tooltip={attachment.path}
          data-tooltip-variant="mono"
          key={`${attachment.type}:${attachment.path}:${index}`}
        >
          <span className="message-attachment-kind">
            {attachment.type === 'image' ? '图片' : '文件'}
          </span>
          <span className="message-attachment-name">{attachment.name}</span>
        </li>
      ))}
    </ul>
  )
}

function ThinkingStatus({ label }: { label: string }): React.JSX.Element {
  return (
    <span className="thinking-status" aria-label={`Pi ${label}`} role="status">
      <span className="thinking-visual" aria-hidden="true">
        <span className="thinking-core" />
      </span>
      <span>{label}</span>
    </span>
  )
}

function groupConversationTurns(entries: KernelConversationEntry[]): ConversationTurn[] {
  const turns: ConversationTurn[] = []
  let current: ConversationTurn | null = null
  for (const entry of entries.filter(isVisibleEntry)) {
    if (entry.kind === 'message' && entry.role === 'user') {
      if (current !== null) turns.push(current)
      current = { id: entry.id, entries: [entry] }
      continue
    }
    if (current === null) current = { id: `turn:${entry.id}`, entries: [] }
    current.entries.push(entry)
  }
  if (current !== null) turns.push(current)
  return turns
}

function sameTurnEntries(
  previous: {
    turn: ConversationTurn
    toolDisplayDensity: ToolDisplayDensity
    thinkingElapsedByEntryId: ReadonlyMap<string, number>
    runElapsedMs?: number | null
  },
  next: {
    turn: ConversationTurn
    toolDisplayDensity: ToolDisplayDensity
    thinkingElapsedByEntryId: ReadonlyMap<string, number>
    runElapsedMs?: number | null
  }
): boolean {
  if (previous.toolDisplayDensity !== next.toolDisplayDensity) return false
  if (previous.thinkingElapsedByEntryId !== next.thinkingElapsedByEntryId) return false
  if (previous.runElapsedMs !== next.runElapsedMs) return false
  if (previous.turn.entries.length !== next.turn.entries.length) return false
  return previous.turn.entries.every((entry, index) => entry === next.turn.entries[index])
}

function promptNavigationLabel(entry: KernelMessageEntry): string {
  const text = entry.text.replace(/\s+/g, ' ').trim()
  if (text.length > 0) return text.length > 72 ? `${text.slice(0, 71)}…` : text
  const attachmentNames = (entry.attachments ?? []).map((attachment) => attachment.name)
  return attachmentNames.length > 0 ? `附件：${attachmentNames.join('、')}` : '空提示词'
}

function abortedMessage(error: string | null): string {
  const message = error?.trim()
  if (!message || /^Request was aborted\.?$/i.test(message)) return '已中止'
  return `已中止：${message}`
}

function splitTurn(turn: ConversationTurn): {
  user: KernelMessageEntry | null
  responseEntries: KernelConversationEntry[]
} {
  const first = turn.entries[0]
  if (first?.kind === 'message' && first.role === 'user') {
    return { user: first, responseEntries: turn.entries.slice(1) }
  }
  return { user: null, responseEntries: turn.entries }
}

function buildLiveChunks(entries: KernelConversationEntry[]): LiveChunk[] {
  const chunks: LiveChunk[] = []
  let processEntries: ProcessEntry[] = []
  const flushProcess = (): void => {
    if (processEntries.length === 0) return
    chunks.push({ id: `process:${processEntries[0]!.id}`, kind: 'process', entries: processEntries })
    processEntries = []
  }

  for (const entry of entries) {
    if (isProcessEntry(entry)) {
      processEntries.push(entry)
      continue
    }
    flushProcess()
    if (entry.kind === 'message' || entry.kind === 'error') {
      chunks.push({ id: entry.id, kind: 'entry', entry })
    }
  }
  flushProcess()
  return chunks
}

function isProcessEntry(entry: KernelConversationEntry): entry is ProcessEntry {
  return entry.kind === 'thinking' ||
    entry.kind === 'tool' ||
    (entry.kind === 'message' && entry.role === 'assistant' && entry.phase === 'commentary')
}

function isVisibleEntry(entry: KernelConversationEntry): boolean {
  if (entry.kind === 'message') {
    return Boolean(entry.text.trim() || entry.attachments?.length || entry.error || entry.streaming)
  }
  if (entry.kind === 'thinking') return Boolean(entry.text.trim() || entry.streaming)
  return true
}

function isRunningEntry(entry: KernelConversationEntry): boolean {
  if (entry.kind === 'message' || entry.kind === 'thinking') return entry.streaming
  if (entry.kind === 'tool') return entry.status === 'pending' || entry.status === 'running'
  return false
}

function liveProcessStatusLabel(entries: ProcessEntry[]): string {
  const activeEntry = currentRunningEntry(entries)
  if (activeEntry?.kind === 'thinking') return '正在思考'
  if (activeEntry?.kind === 'message') return '正在继续'
  if (activeEntry?.kind === 'tool') {
    const file = toolFileInfo(activeEntry)
    if (file?.operation === 'read') return `正在阅读 ${fileBasename(file.path)}`
    if (file?.operation === 'modify') return `正在修改 ${fileBasename(file.path)}`
    return compactToolName(activeEntry.name) === 'bash'
      ? '正在运行命令'
      : `正在调用 ${compactToolName(activeEntry.name)}`
  }
  return '正在继续'
}

function currentRunningEntry<T extends KernelConversationEntry>(entries: T[]): T | undefined {
  const runningTool = entries.findLast(
    (entry) => entry.kind === 'tool' && (entry.status === 'pending' || entry.status === 'running')
  )
  if (runningTool !== undefined) return runningTool
  const lastEntry = entries.at(-1)
  return lastEntry !== undefined &&
    (lastEntry.kind === 'message' || lastEntry.kind === 'thinking') &&
    lastEntry.streaming
    ? lastEntry
    : undefined
}

function uniqueToolFiles(tools: KernelToolEntry[]): ToolFileReference[] {
  const files = new Map<string, ToolFileReference>()
  for (const entry of tools) {
    const file = toolFileInfo(entry)
    if (file === null) continue
    files.set(`${file.operation}:${file.path}`, { ...file, entry })
  }
  return [...files.values()]
}

function summarizeTools(tools: KernelToolEntry[]): string {
  const files = uniqueToolFiles(tools)
  const readCount = files.filter((file) => file.operation === 'read').length
  const modifiedCount = files.filter((file) => file.operation === 'modify').length
  const fileToolIds = new Set(
    tools.filter((entry) => toolFileInfo(entry) !== null).map((entry) => entry.id)
  )
  const commandCount = tools.filter(
    (entry) => !fileToolIds.has(entry.id) && compactToolName(entry.name) === 'bash'
  ).length
  const otherToolCount = tools.length - fileToolIds.size - commandCount
  return [
    readCount > 0 ? `读取 ${readCount} 个文件` : null,
    modifiedCount > 0 ? `修改 ${modifiedCount} 个文件` : null,
    commandCount > 0 ? `运行 ${commandCount} 条命令` : null,
    otherToolCount > 0 ? `调用 ${otherToolCount} 个工具` : null
  ].filter((part): part is string => part !== null).join('，') || '处理工具调用'
}

function toolFileInfo(entry: KernelToolEntry): ToolFileInfo | null {
  const name = compactToolName(entry.name)
  const args = parseToolArgs(entry.args)
  if (args === null) return null
  const path = stringArgument(args, ['path', 'file_path'])
  if (path === null) return null

  if (name === 'read' || name === 'read_file') {
    const offset = numericArgument(args.offset)
    const limit = numericArgument(args.limit)
    const start = offset ?? 1
    const detail = offset === null && limit === null
      ? null
      : limit === null ? `从第 ${start} 行开始` : `第 ${start}–${start + limit - 1} 行`
    return { operation: 'read', path, detail }
  }

  if (name === 'edit' || name === 'write' || name === 'write_file' || name === 'apply_patch') {
    let detail: string | null = null
    if (name === 'edit' && Array.isArray(args.edits)) detail = `${args.edits.length} 处修改`
    if ((name === 'write' || name === 'write_file') && typeof args.content === 'string') {
      detail = `${lineCount(args.content)} 行内容`
    }
    return { operation: 'modify', path, detail }
  }

  return null
}

function toolActivityPrefix(entry: KernelToolEntry, file: ToolFileInfo | null): string {
  if (file?.operation === 'read') {
    if (entry.status === 'error') return '阅读失败'
    return entry.status === 'success' ? '已阅读' : '正在阅读'
  }
  if (file?.operation === 'modify') {
    if (entry.status === 'error') return '修改失败'
    return entry.status === 'success' ? '已修改' : '正在修改'
  }
  const name = compactToolName(entry.name)
  if (entry.status === 'error') return `${name} 调用失败 ·`
  return entry.status === 'success' ? `已完成 ${name} ·` : `正在调用 ${name} ·`
}

function activityStatus(entry: KernelToolEntry): 'running' | 'completed' | 'failed' {
  if (entry.status === 'error') return 'failed'
  if (entry.status === 'success') return 'completed'
  return 'running'
}

function toolStatusLabel(entry: KernelToolEntry): string {
  if (entry.status === 'error') return '失败'
  if (entry.status === 'success') return '完成'
  return '运行中'
}

function toolTarget(entry: KernelToolEntry): string {
  const args = parseToolArgs(entry.args)
  if (args !== null) {
    const target = stringArgument(args, ['command', 'path', 'file_path', 'query', 'url'])
    if (target !== null) return compactTarget(target)
  }
  const first = entry.args.split('\n', 1)[0]?.trim()
  if (first && first !== '{' && first !== '[') return compactTarget(first)
  return compactToolName(entry.name) === 'bash' ? '命令' : '相关内容'
}

function parseToolArgs(value: string): Record<string, unknown> | null {
  if (value.trim().length === 0) return null
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function stringArgument(args: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    if (typeof args[key] === 'string' && args[key].trim().length > 0) return args[key]
  }
  return null
}

function numericArgument(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function compactTarget(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= 96) return normalized
  return `${normalized.slice(0, 95)}…`
}

function compactToolName(name: string): string {
  const normalized = name.trim().toLowerCase()
  return normalized.split('.').at(-1) || normalized || 'tool'
}

function fileBasename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? path
}

function lineCount(value: string): number {
  if (value.length === 0) return 0
  return value.split('\n').length
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs}ms`
  if (durationMs >= 60_000) {
    const totalSeconds = Math.round(durationMs / 1_000)
    return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`
  }
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`
}
