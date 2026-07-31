import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { createPortal } from 'react-dom'

import type {
  KernelAskAnswer,
  KernelConversationEntry,
  KernelMessageEntry,
  RuntimeStatus
} from '../../../../shared/kernel-contract'
import { IconButton } from '../../components/IconButton'
import { useViewportPopoverPosition } from '../../components/useViewportPopoverPosition'
import { isTodoWriteToolEntry } from '../../todo-state'
import type { ToolDisplayDensity } from '../../tool-display-density'
import { unknownErrorMessage } from '../../unknown-error-message'
import {
  SubagentTaskInteractionContext,
  type SubagentTaskInteraction
} from './SubagentTaskDetail'
import type { SubagentTaskSelection } from './subagent-task-detail-model'
import {
  AskToolInteractionContext,
  type AskToolInteraction
} from './AskToolCard'
import {
  anchoredTimelineScrollTop,
  isTimelineViewportMeasurable,
  timelineScrollModeAfterScroll,
  type TimelineScrollMode
} from './timeline-scroll-stability'
import { latestThinkingSummaryLabel } from './timeline-process-model'
import {
  CompletedTurn,
  groupConversationTurns,
  hasCurrentRunningEntry,
  isProcessEntry,
  LiveTurn,
  splitTurn,
  ThinkingStatus,
  TimelineSessionKeyContext,
  turnFinalAnswerText,
  turnForkUserText,
  turnHistoryPrompt,
  type TurnHistoryPrompt
} from './TimelineTurns'

type TimelineProps = {
  entries: KernelConversationEntry[]
  activeRunStartIndex: number | null
  runtimeStatus: RuntimeStatus
  loading: boolean
  compactionActive: boolean
  showPromptNavigation: boolean
  toolDisplayDensity: ToolDisplayDensity
  sessionKey: string | null
  askSessionKey: string | null
  canCopyAnswers: boolean
  canExportSession: boolean
  canForkSession: boolean
  canEditHistoryPrompt: boolean
  conversationActionBusy: boolean
  conversationActionStatus: string | null
  conversationActionError: string | null
  onCopyAnswer: (text: string) => Promise<void>
  onExportSession: () => Promise<void>
  onForkTurn: (userText: string) => void
  onNavigateHistoryPrompt: (messageId: string) => Promise<void>
  onSendHistoryPrompt: (message: string) => Promise<void>
  onHistoryPromptEditingChange: (editing: boolean) => void
  subagentTaskSelection: SubagentTaskSelection | null
  onOpenSubagentTask: SubagentTaskInteraction['onOpen']
  onSubmitAsk: (
    sessionKey: string,
    toolCallId: string,
    answers: KernelAskAnswer[]
  ) => Promise<void>
  onCancelAsk: (sessionKey: string, toolCallId: string) => Promise<void>
  onLayoutStabilizeReady: (stabilize: (() => void) | null) => void
  title?: string
  warning: string | null
}

type PromptNavigationItem = {
  turnId: string
  prompt: KernelMessageEntry
  ordinal: number
}

type PromptNavigationMarkerPosition = {
  index: number
  centerY: number
}

type TimelineReadingAnchorTarget =
  | { kind: 'text'; node: Text; offset: number }
  | { kind: 'element'; element: HTMLElement }

type TimelineReadingAnchor = {
  target: TimelineReadingAnchorTarget
  viewportOffset: number
  fallbackElement: HTMLElement
  fallbackViewportOffset: number
}

const COMPLETED_TURN_WINDOW_SIZE = 60
const ACTIVE_PROMPT_SWITCH_GAP = 8
const PROMPT_NAVIGATION_PREVIEW_DELAY_MS = 360
const PROMPT_NAVIGATION_CLOSE_DELAY_MS = 180
const PROMPT_NAVIGATION_FOCUS_SIGMA = 2.1
const PROMPT_NAVIGATION_FOCUS_BASE_OPACITY = 0.4
const PROMPT_NAVIGATION_FOCUS_OPACITY_SPAN = 0.5
const PROMPT_NAVIGATION_FOCUS_BASE_WIDTH_PX = 9
const PROMPT_NAVIGATION_FOCUS_WIDTH_SPAN_PX = 23
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
  loading,
  compactionActive,
  showPromptNavigation,
  toolDisplayDensity,
  sessionKey,
  askSessionKey,
  canCopyAnswers,
  canExportSession,
  canForkSession,
  canEditHistoryPrompt,
  conversationActionBusy,
  conversationActionStatus,
  conversationActionError,
  onCopyAnswer,
  onExportSession,
  onForkTurn,
  onNavigateHistoryPrompt,
  onSendHistoryPrompt,
  onHistoryPromptEditingChange,
  subagentTaskSelection,
  onOpenSubagentTask,
  onSubmitAsk,
  onCancelAsk,
  onLayoutStabilizeReady,
  title,
  warning
}: TimelineProps): React.JSX.Element {
  const shellRef = useRef<HTMLDivElement>(null)
  const chromeRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const messageListRef = useRef<HTMLDivElement>(null)
  const outputEndRef = useRef<HTMLDivElement>(null)
  const scrollTailRef = useRef<HTMLDivElement>(null)
  const scrollModeRef = useRef<TimelineScrollMode>('following')
  const viewportScrollTopRef = useRef(0)
  const readingAnchorRef = useRef<TimelineReadingAnchor | null>(null)
  const activePromptFrameRef = useRef<number | null>(null)
  const readingLineOffsetRef = useRef<number | null>(null)
  const activePromptTurnIdRef = useRef<string | null>(null)
  const activePromptScrollTopRef = useRef(0)
  const pendingPromptNavigationTargetRef = useRef<string | null>(null)
  const revealScrollHeightRef = useRef<number | null>(null)
  const observedRunRef = useRef<{ startedAt: number; turnId: string | null } | null>(null)
  const observedThinkingStartsRef = useRef(new Map<string, number>())
  const historyPromptTextareaRef = useRef<HTMLTextAreaElement>(null)
  const [completedTurnWindow, setCompletedTurnWindow] = useState(COMPLETED_TURN_WINDOW_SIZE)
  const [actionTurnId, setActionTurnId] = useState<string | null>(null)
  const [actionFeedbackTurnId, setActionFeedbackTurnId] = useState<string | null>(null)
  const [historyPromptEdit, setHistoryPromptEdit] = useState<
    (TurnHistoryPrompt & { draft: string; error: string | null; readyToSend: boolean }) | null
  >(null)
  const [historyPromptSubmitting, setHistoryPromptSubmitting] = useState(false)
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
  const editingTurnIndex = historyPromptEdit === null
    ? -1
    : visibleCompletedTurns.findIndex(
        (turn) => turnHistoryPrompt(turn)?.messageId === historyPromptEdit.messageId
      )
  const renderedCompletedTurns = editingTurnIndex < 0
    ? visibleCompletedTurns
    : visibleCompletedTurns.slice(0, editingTurnIndex + 1)
  const detachedHistoryPromptEditor = historyPromptEdit !== null && editingTurnIndex < 0
  const isHistoryPromptEditing = historyPromptEdit !== null
  const hiddenCompletedTurnCount = completedTurns.length - visibleCompletedTurns.length
  const subagentTaskInteraction = useMemo<SubagentTaskInteraction>(() => ({
    selection: subagentTaskSelection,
    onOpen: onOpenSubagentTask
  }), [onOpenSubagentTask, subagentTaskSelection])
  const askToolInteraction = useMemo<AskToolInteraction | null>(
    () => askSessionKey === null
      ? null
      : { sessionKey: askSessionKey, onSubmit: onSubmitAsk, onCancel: onCancelAsk },
    [askSessionKey, onCancelAsk, onSubmitAsk]
  )
  useEffect(() => {
    onHistoryPromptEditingChange(isHistoryPromptEditing)
    return () => {
      if (isHistoryPromptEditing) onHistoryPromptEditingChange(false)
    }
  }, [isHistoryPromptEditing, onHistoryPromptEditingChange])
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
  const setScrollMode = useCallback((mode: TimelineScrollMode) => {
    scrollModeRef.current = mode
    const viewport = viewportRef.current
    if (viewport !== null) viewport.dataset.scrollMode = mode
    if (mode === 'following') readingAnchorRef.current = null
  }, [])
  const setViewportScrollTop = useCallback((viewport: HTMLElement, nextScrollTop: number) => {
    viewport.scrollTop = Math.max(0, nextScrollTop)
    viewportScrollTopRef.current = viewport.scrollTop
  }, [])
  const captureReadingAnchor = useCallback(() => {
    if (scrollModeRef.current !== 'reading') return
    const viewport = viewportRef.current
    const messageList = messageListRef.current
    if (viewport === null || messageList === null) return
    const viewportRect = viewport.getBoundingClientRect()
    if (!isTimelineViewportMeasurable({
      width: viewportRect.width,
      height: viewportRect.height
    })) return
    readingAnchorRef.current = captureTimelineReadingAnchor(
      viewport,
      messageList,
      readingLineOffsetRef.current ?? 0
    )
  }, [])
  const restoreReadingAnchor = useCallback(() => {
    if (scrollModeRef.current !== 'reading') return
    const viewport = viewportRef.current
    const anchor = readingAnchorRef.current
    if (viewport === null || anchor === null) return
    const viewportRect = viewport.getBoundingClientRect()
    if (!isTimelineViewportMeasurable({
      width: viewportRect.width,
      height: viewportRect.height
    })) return
    const anchorOffsets = readingAnchorViewportOffsets(anchor, viewportRect.top)
    if (anchorOffsets !== null) {
      setViewportScrollTop(viewport, anchoredTimelineScrollTop({
        scrollTop: viewport.scrollTop,
        previousAnchorViewportOffset: anchorOffsets.previous,
        currentAnchorViewportOffset: anchorOffsets.current
      }))
    }
    captureReadingAnchor()
  }, [captureReadingAnchor, setViewportScrollTop])
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
    setViewportScrollTop(viewport, targetTop)
  }, [outputEndScrollTop, setViewportScrollTop])
  const updateScrollTail = useCallback(() => {
    const viewport = viewportRef.current
    const outputEnd = outputEndRef.current
    const scrollTail = scrollTailRef.current
    if (viewport === null || outputEnd === null || scrollTail === null) return
    const viewportRect = viewport.getBoundingClientRect()
    if (!isTimelineViewportMeasurable({
      width: viewportRect.width,
      height: viewportRect.height
    })) return
    const turns = viewport.querySelectorAll<HTMLElement>('[data-conversation-turn-id]')
    const lastTurn = turns.item(turns.length - 1)
    if (lastTurn === null) {
      scrollTail.style.height = '0px'
      return
    }

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
  const stabilizeTimelineLayout = useCallback(() => {
    const viewport = viewportRef.current
    if (viewport === null) return
    const viewportRect = viewport.getBoundingClientRect()
    if (!isTimelineViewportMeasurable({
      width: viewportRect.width,
      height: viewportRect.height
    })) return
    updateScrollTail()
    if (scrollModeRef.current === 'following') scrollToOutputEnd()
    else restoreReadingAnchor()
    scheduleActivePromptTurnUpdate()
  }, [
    restoreReadingAnchor,
    scheduleActivePromptTurnUpdate,
    scrollToOutputEnd,
    updateScrollTail
  ])
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
    setScrollMode('reading')
    setViewportScrollTop(viewport, targetTop)
    captureReadingAnchor()
    scheduleActivePromptTurnUpdate()
    return true
  }, [
    captureReadingAnchor,
    scheduleActivePromptTurnUpdate,
    setScrollMode,
    setViewportScrollTop
  ])
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
    viewport.dataset.scrollMode = scrollModeRef.current
    viewportScrollTopRef.current = viewport.scrollTop
    activePromptScrollTopRef.current = viewport.scrollTop
  }, [])

  useLayoutEffect(() => {
    const shell = shellRef.current
    const viewport = viewportRef.current
    if (shell === null || viewport === null) return
    const chrome = chromeRef.current
    const updateChromeHeight = (): void => {
      shell.style.setProperty(
        '--conversation-chrome-height',
        `${chrome?.getBoundingClientRect().height ?? 0}px`
      )
      const topClearance = Number.parseFloat(window.getComputedStyle(viewport).paddingTop)
      readingLineOffsetRef.current =
        (Number.isFinite(topClearance) ? topClearance : 0) + 8
      stabilizeTimelineLayout()
    }
    updateChromeHeight()
    if (chrome === null) return
    const observer = new ResizeObserver(updateChromeHeight)
    observer.observe(chrome)
    return () => observer.disconnect()
  }, [stabilizeTimelineLayout, title, warning])

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const messageList = messageListRef.current
    stabilizeTimelineLayout()
    if (viewport === null || messageList === null) return
    const handleLayoutChange = (): void => stabilizeTimelineLayout()
    const observer = new ResizeObserver(handleLayoutChange)
    observer.observe(viewport)
    observer.observe(messageList)
    window.addEventListener('resize', handleLayoutChange)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', handleLayoutChange)
    }
  }, [
    compactionActive,
    hasVisibleContent,
    runtimeStatus,
    stabilizeTimelineLayout
  ])

  useLayoutEffect(() => {
    onLayoutStabilizeReady(stabilizeTimelineLayout)
    return () => onLayoutStabilizeReady(null)
  }, [onLayoutStabilizeReady, stabilizeTimelineLayout])

  useLayoutEffect(() => {
    if (
      revealScrollHeightRef.current !== null ||
      pendingPromptNavigationTargetRef.current !== null
    ) {
      updateScrollTail()
      return
    }
    stabilizeTimelineLayout()
  }, [
    activeRunStartIndex,
    completedTurnWindow,
    entries,
    stabilizeTimelineLayout,
    updateScrollTail
  ])

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
    const viewport = viewportRef.current
    const previousScrollHeight = revealScrollHeightRef.current
    if (!viewport || previousScrollHeight === null) return
    setViewportScrollTop(
      viewport,
      viewport.scrollTop + viewport.scrollHeight - previousScrollHeight
    )
    activePromptScrollTopRef.current = viewport.scrollTop
    revealScrollHeightRef.current = null
    captureReadingAnchor()
    scheduleActivePromptTurnUpdate()
  }, [
    captureReadingAnchor,
    completedTurnWindow,
    scheduleActivePromptTurnUpdate,
    setViewportScrollTop
  ])

  useLayoutEffect(() => {
    const pendingTurnId = pendingPromptNavigationTargetRef.current
    if (pendingTurnId === null || !scrollToMountedPrompt(pendingTurnId)) return
    pendingPromptNavigationTargetRef.current = null
  }, [completedTurnWindow, scrollToMountedPrompt])

  const startHistoryPromptEdit = (prompt: TurnHistoryPrompt): void => {
    setHistoryPromptEdit({ ...prompt, draft: prompt.text, error: null, readyToSend: false })
    setActionTurnId(null)
    setActionFeedbackTurnId(null)
  }
  const cancelHistoryPromptEdit = (): void => {
    if (historyPromptSubmitting || historyPromptEdit === null) return
    const { messageId, turnId } = historyPromptEdit
    setActionTurnId(turnId)
    setHistoryPromptEdit(null)
    requestAnimationFrame(() => {
      const trigger = [...(shellRef.current?.querySelectorAll<HTMLButtonElement>(
        '[data-history-prompt-edit-id]'
      ) ?? [])].find((button) => button.dataset.historyPromptEditId === messageId)
      trigger?.focus()
    })
  }
  const submitHistoryPromptEdit = async (): Promise<void> => {
    if (historyPromptEdit === null || historyPromptSubmitting) return
    const message = historyPromptEdit.draft
    if (message.trim().length === 0) {
      setHistoryPromptEdit({ ...historyPromptEdit, error: '消息不能为空。' })
      return
    }
    setHistoryPromptSubmitting(true)
    setHistoryPromptEdit({ ...historyPromptEdit, error: null })
    let readyToSend = historyPromptEdit.readyToSend
    try {
      if (!readyToSend) {
        await onNavigateHistoryPrompt(historyPromptEdit.messageId)
        readyToSend = true
        setHistoryPromptEdit((current) => current === null
          ? null
          : { ...current, error: null, readyToSend: true })
      }
      await onSendHistoryPrompt(message)
      setHistoryPromptEdit(null)
    } catch (error: unknown) {
      setHistoryPromptEdit((current) => current === null
        ? null
        : { ...current, error: unknownErrorMessage(error), readyToSend })
      requestAnimationFrame(() => historyPromptTextareaRef.current?.focus())
    } finally {
      setHistoryPromptSubmitting(false)
    }
  }

  return (
    <TimelineSessionKeyContext.Provider value={sessionKey}>
    <AskToolInteractionContext.Provider value={askToolInteraction}>
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

      {historyPromptEdit === null && showPromptNavigation && promptNavigationItems.length > 0 ? (
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
          const previousScrollTop = viewportScrollTopRef.current
          const scrollTop = target.scrollTop
          const suppressUserIntent = Math.abs(scrollTop - previousScrollTop) <= 0.5
          const nextMode = timelineScrollModeAfterScroll({
            currentMode: scrollModeRef.current,
            previousScrollTop,
            scrollTop,
            outputEndScrollTop: outputEndScrollTop(),
            suppressUserIntent
          })
          setScrollMode(nextMode)
          viewportScrollTopRef.current = scrollTop
          if (nextMode === 'reading') captureReadingAnchor()
          scheduleActivePromptTurnUpdate()
        }}
      >
        {hasVisibleContent || historyPromptEdit !== null || runtimeStatus === 'running' || compactionActive ? (
          <>
            <div
              className="message-list"
              ref={messageListRef}
              aria-live={runtimeStatus === 'running' ? 'polite' : 'off'}
              aria-label="对话时间线"
            >
              {historyPromptEdit === null && hiddenCompletedTurnCount > 0 ? (
                <button
                  className="conversation-history-reveal"
                  type="button"
                  onClick={() => {
                    const viewport = viewportRef.current
                    setScrollMode('reading')
                    if (viewport) {
                      revealScrollHeightRef.current = viewport.scrollHeight
                      captureReadingAnchor()
                    }
                    setCompletedTurnWindow((count) => count + COMPLETED_TURN_WINDOW_SIZE)
                  }}
                >
                  显示更早的 {Math.min(COMPLETED_TURN_WINDOW_SIZE, hiddenCompletedTurnCount)} 轮
                </button>
              ) : null}
              {renderedCompletedTurns.map((turn) => {
                const historyPrompt = turnHistoryPrompt(turn)
                const editingThisPrompt = historyPromptEdit !== null &&
                  historyPrompt?.messageId === historyPromptEdit.messageId
                const answerText = canCopyAnswers ? turnFinalAnswerText(turn) : null
                const forkUserText = canForkSession ? turnForkUserText(turn) : null
                const canCopyTurn = answerText !== null
                const canForkTurn = forkUserText !== null
                const canEditTurn = canEditHistoryPrompt && historyPrompt !== null
                const canShowTurnActions = historyPromptEdit === null &&
                  (canEditTurn || canCopyTurn || canForkTurn || canExportSession)
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
                    {editingThisPrompt && historyPromptEdit !== null ? (
                      <HistoryPromptEditor
                        textareaRef={historyPromptTextareaRef}
                        draft={historyPromptEdit.draft}
                        error={historyPromptEdit.error}
                        busy={historyPromptSubmitting || conversationActionBusy}
                        onChange={(draft) => setHistoryPromptEdit({
                          ...historyPromptEdit,
                          draft,
                          error: null
                        })}
                        onCancel={cancelHistoryPromptEdit}
                        onSubmit={submitHistoryPromptEdit}
                      />
                    ) : (
                      <CompletedTurn
                        turn={turn}
                        toolDisplayDensity={toolDisplayDensity}
                        runElapsedMs={runElapsedByTurnId.get(turn.id) ?? null}
                        thinkingElapsedByEntryId={thinkingElapsedByEntryId}
                      />
                    )}
                    {canShowTurnActions ? (
                      <div
                        className={`conversation-turn-actions${showTurnActionSurface ? ' is-visible' : ''}`}
                        aria-label="对话操作"
                      >
                        {canEditTurn && historyPrompt !== null ? (
                          <IconButton
                            className="conversation-action-button"
                            data-history-prompt-edit-id={historyPrompt.messageId}
                            icon="edit"
                            iconSize="sm"
                            label="编辑并重新发送这条消息"
                            disabled={conversationActionBusy}
                            onClick={() => startHistoryPromptEdit(historyPrompt)}
                          />
                        ) : null}
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
              {detachedHistoryPromptEditor && historyPromptEdit !== null ? (
                <div className="conversation-virtual-row conversation-turn-shell">
                  <HistoryPromptEditor
                    textareaRef={historyPromptTextareaRef}
                    draft={historyPromptEdit.draft}
                    error={historyPromptEdit.error}
                    busy={historyPromptSubmitting || conversationActionBusy}
                    onChange={(draft) => setHistoryPromptEdit({
                      ...historyPromptEdit,
                      draft,
                      error: null
                    })}
                    onCancel={cancelHistoryPromptEdit}
                    onSubmit={submitHistoryPromptEdit}
                  />
                </div>
              ) : null}
              {historyPromptEdit === null ? activeTurns.map((turn) => (
                <div className="conversation-virtual-row" key={`active:${turn.id}`}>
                  <LiveTurn
                    turn={turn}
                    toolDisplayDensity={toolDisplayDensity}
                    thinkingElapsedByEntryId={thinkingElapsedByEntryId}
                  />
                </div>
              )) : null}
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
              {historyPromptEdit === null && compactionActive ? (
                <div
                  className="conversation-compaction-status"
                  role="status"
                  aria-live="polite"
                >
                  <ThinkingStatus label="正在整理上下文" />
                </div>
              ) : null}
              {historyPromptEdit === null &&
                runtimeStatus === 'running' &&
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
            {loading ? '正在打开对话…' : emptyStateSlogan}
          </p>
        )}
      </div>
    </div>
    </SubagentTaskInteractionContext.Provider>
    </AskToolInteractionContext.Provider>
    </TimelineSessionKeyContext.Provider>
  )
}

function HistoryPromptEditor({
  textareaRef,
  draft,
  error,
  busy,
  onChange,
  onCancel,
  onSubmit
}: {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  draft: string
  error: string | null
  busy: boolean
  onChange: (draft: string) => void
  onCancel: () => void
  onSubmit: () => Promise<void>
}): React.JSX.Element {
  return (
    <section className="history-prompt-editor" aria-label="编辑历史消息" aria-busy={busy}>
      <label className="history-prompt-editor-field">
        <span>编辑并重新发送</span>
        <textarea
          ref={textareaRef}
          autoFocus
          rows={4}
          value={draft}
          readOnly={busy}
          onChange={(event) => onChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.keyCode === 229 || event.nativeEvent.isComposing) return
            if (event.key === 'Escape') {
              event.preventDefault()
              onCancel()
              return
            }
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              void onSubmit()
            }
          }}
        />
      </label>
      {error === null ? null : (
        <p className="history-prompt-editor-error" role="alert">{error}</p>
      )}
      <div className="history-prompt-editor-actions">
        <small>旧分支会保留。⌘/Ctrl + Enter 重新发送。</small>
        <button type="button" disabled={busy} onClick={onCancel}>取消</button>
        <button
          className="primary"
          type="button"
          disabled={busy || draft.trim().length === 0}
          onClick={() => void onSubmit()}
        >
          {busy ? '正在重新发送…' : '重新发送'}
        </button>
      </div>
    </section>
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
  const markerPositionsRef = useRef<PromptNavigationMarkerPosition[]>([])
  const previewDelayRef = useRef<number | null>(null)
  const closeDelayRef = useRef<number | null>(null)
  const focusFrameRef = useRef<number | null>(null)
  const pendingFocusPositionRef = useRef<number | null>(null)
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
  const clearCloseDelay = useCallback(() => {
    if (closeDelayRef.current === null) return
    window.clearTimeout(closeDelayRef.current)
    closeDelayRef.current = null
  }, [])
  const clearNavigationFocus = useCallback(() => {
    if (focusFrameRef.current !== null) {
      window.cancelAnimationFrame(focusFrameRef.current)
      focusFrameRef.current = null
    }
    pendingFocusPositionRef.current = null
    markerPositionsRef.current = []
    applyPromptNavigationFocus(markerRefs.current, null)
  }, [])
  const scheduleNavigationFocus = useCallback((position: number) => {
    pendingFocusPositionRef.current = position
    if (focusFrameRef.current !== null) return
    focusFrameRef.current = window.requestAnimationFrame(() => {
      focusFrameRef.current = null
      const nextPosition = pendingFocusPositionRef.current
      pendingFocusPositionRef.current = null
      if (nextPosition !== null) {
        applyPromptNavigationFocus(markerRefs.current, nextPosition)
      }
    })
  }, [])
  const closePreview = useCallback(() => {
    clearPreviewDelay()
    clearCloseDelay()
    clearNavigationFocus()
    previewModeRef.current = false
    setPreview(null)
  }, [clearCloseDelay, clearNavigationFocus, clearPreviewDelay])
  const scheduleClosePreview = useCallback(() => {
    clearCloseDelay()
    closeDelayRef.current = window.setTimeout(() => {
      closeDelayRef.current = null
      closePreview()
    }, PROMPT_NAVIGATION_CLOSE_DELAY_MS)
  }, [clearCloseDelay, closePreview])
  const showPreview = useCallback((
    item: PromptNavigationItem,
    index: number,
    trigger: HTMLButtonElement,
    immediate: boolean
  ) => {
    clearPreviewDelay()
    clearCloseDelay()
    if (immediate) {
      previewModeRef.current = true
      if (markerPositionsRef.current.length === 0) {
        markerPositionsRef.current = measurePromptNavigationMarkers(markerRefs.current)
      }
      scheduleNavigationFocus(index)
      setPreview({ item, trigger })
      return
    }
    previewDelayRef.current = window.setTimeout(() => {
      previewDelayRef.current = null
      previewModeRef.current = true
      markerPositionsRef.current = measurePromptNavigationMarkers(markerRefs.current)
      scheduleNavigationFocus(index)
      setPreview({ item, trigger })
    }, PROMPT_NAVIGATION_PREVIEW_DELAY_MS)
  }, [clearCloseDelay, clearPreviewDelay, scheduleNavigationFocus])

  useEffect(() => {
    if (preview === null) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closePreview()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [closePreview, preview])

  useEffect(() => () => {
    clearPreviewDelay()
    clearCloseDelay()
    clearNavigationFocus()
  }, [clearCloseDelay, clearNavigationFocus, clearPreviewDelay])

  const focusMarker = (index: number): void => {
    markerRefs.current[Math.max(0, Math.min(items.length - 1, index))]?.focus()
  }

  return (
    <nav
      className="prompt-navigation-rail"
      aria-label="提示词导航"
      data-expanded={preview === null ? undefined : 'true'}
      onPointerEnter={clearCloseDelay}
      onPointerLeave={(event) => {
        if (event.currentTarget.contains(document.activeElement)) return
        if (previewModeRef.current) scheduleClosePreview()
        else closePreview()
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) closePreview()
      }}
    >
      <ol
        className="prompt-navigation-list"
        onPointerMove={(event) => {
          if (!previewModeRef.current || event.pointerType === 'touch') return
          const position = promptNavigationPointerPosition(
            event.clientY,
            markerPositionsRef.current
          )
          if (position !== null) scheduleNavigationFocus(position)
        }}
      >
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
                data-navigation-focus={described ? 'true' : undefined}
                onPointerEnter={(event) =>
                  showPreview(item, index, event.currentTarget, previewModeRef.current)}
                onFocus={(event) => showPreview(item, index, event.currentTarget, true)}
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
          trigger={preview.trigger}
        />
      ) : null}
    </nav>
  )
}

function applyPromptNavigationFocus(
  markers: Array<HTMLButtonElement | null>,
  focusedPosition: number | null
): void {
  markers.forEach((marker, index) => {
    if (marker === null) return
    if (focusedPosition === null) {
      marker.style.removeProperty('--prompt-navigation-marker-opacity')
      marker.style.removeProperty('--prompt-navigation-marker-width')
      return
    }
    const distance = Math.abs(index - focusedPosition)
    const weight = Math.exp(
      -(distance ** 2) / (2 * PROMPT_NAVIGATION_FOCUS_SIGMA ** 2)
    )
    marker.style.setProperty(
      '--prompt-navigation-marker-opacity',
      (
        PROMPT_NAVIGATION_FOCUS_BASE_OPACITY +
        weight * PROMPT_NAVIGATION_FOCUS_OPACITY_SPAN
      ).toFixed(3)
    )
    marker.style.setProperty(
      '--prompt-navigation-marker-width',
      `${Math.round(
        PROMPT_NAVIGATION_FOCUS_BASE_WIDTH_PX +
        weight * PROMPT_NAVIGATION_FOCUS_WIDTH_SPAN_PX
      )}px`
    )
  })
}

function measurePromptNavigationMarkers(
  markers: Array<HTMLButtonElement | null>
): PromptNavigationMarkerPosition[] {
  return markers.flatMap((marker, index) => {
    if (marker === null) return []
    const rect = marker.getBoundingClientRect()
    return [{ index, centerY: rect.top + rect.height / 2 }]
  })
}

function promptNavigationPointerPosition(
  clientY: number,
  positions: PromptNavigationMarkerPosition[]
): number | null {
  const first = positions[0]
  const last = positions.at(-1)
  if (first === undefined || last === undefined) return null
  if (clientY <= first.centerY) return first.index
  if (clientY >= last.centerY) return last.index

  for (let positionIndex = 1; positionIndex < positions.length; positionIndex += 1) {
    const previous = positions[positionIndex - 1]!
    const next = positions[positionIndex]!
    if (clientY > next.centerY) continue
    const span = Math.max(1, next.centerY - previous.centerY)
    const progress = (clientY - previous.centerY) / span
    return previous.index + (next.index - previous.index) * progress
  }
  return last.index
}

function PromptNavigationPreview({
  item,
  trigger
}: {
  item: PromptNavigationItem
  trigger: HTMLButtonElement
}): React.JSX.Element | null {
  const triggerRef = useMemo<{ current: HTMLElement | null }>(
    () => ({ current: trigger }),
    [trigger]
  )
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

function captureTimelineReadingAnchor(
  viewport: HTMLElement,
  messageList: HTMLElement,
  readingLineOffset: number
): TimelineReadingAnchor | null {
  const viewportRect = viewport.getBoundingClientRect()
  const readingY = Math.max(
    viewportRect.top + 1,
    Math.min(viewportRect.bottom - 1, viewportRect.top + readingLineOffset)
  )
  const readingXPositions = [0.5, 0.35, 0.65].map(
    (ratio) => viewportRect.left + viewportRect.width * ratio
  )
  for (const readingX of readingXPositions) {
    const pointElement = readingAnchorElementAtPoint(
      messageList,
      readingX,
      readingY
    )
    if (pointElement === null) continue
    const fallbackElement =
      pointElement.closest<HTMLElement>('[data-conversation-turn-id]') ?? pointElement
    const caretTarget = readingCaretTargetAtPoint(
      messageList,
      readingX,
      readingY
    )
    const target = caretTarget ?? { kind: 'element', element: fallbackElement } as const
    const viewportOffset = readingTargetViewportOffset(target, viewportRect.top)
    if (viewportOffset === null) continue
    return {
      target,
      viewportOffset,
      fallbackElement,
      fallbackViewportOffset: fallbackElement.getBoundingClientRect().top - viewportRect.top
    }
  }

  const turns = Array.from(
    messageList.querySelectorAll<HTMLElement>('[data-conversation-turn-id]')
  )
  const fallbackElement = turns.findLast(
    (turn) => turn.getBoundingClientRect().top <= readingY
  ) ?? turns[0] ?? null
  if (fallbackElement === null) return null
  const viewportOffset = fallbackElement.getBoundingClientRect().top - viewportRect.top
  return {
    target: { kind: 'element', element: fallbackElement },
    viewportOffset,
    fallbackElement,
    fallbackViewportOffset: viewportOffset
  }
}

function readingAnchorViewportOffsets(
  anchor: TimelineReadingAnchor,
  viewportTop: number
): { previous: number; current: number } | null {
  const currentTargetOffset = readingTargetViewportOffset(anchor.target, viewportTop)
  if (currentTargetOffset !== null) {
    return { previous: anchor.viewportOffset, current: currentTargetOffset }
  }
  if (!anchor.fallbackElement.isConnected) return null
  return {
    previous: anchor.fallbackViewportOffset,
    current: anchor.fallbackElement.getBoundingClientRect().top - viewportTop
  }
}

function readingTargetViewportOffset(
  target: TimelineReadingAnchorTarget,
  viewportTop: number
): number | null {
  let rect: DOMRect
  if (target.kind === 'element') {
    if (!target.element.isConnected) return null
    rect = target.element.getBoundingClientRect()
  } else {
    if (!target.node.isConnected) return null
    const range = target.node.ownerDocument.createRange()
    const offset = Math.max(0, Math.min(target.node.data.length, target.offset))
    range.setStart(target.node, offset)
    range.collapse(true)
    rect = range.getBoundingClientRect()
    if (rect.height <= 0 && target.node.data.length > 0) {
      const characterStart = Math.min(offset, target.node.data.length - 1)
      range.setStart(target.node, characterStart)
      range.setEnd(target.node, characterStart + 1)
      rect = range.getBoundingClientRect()
    }
  }
  return Number.isFinite(rect.top) && rect.height > 0
    ? rect.top - viewportTop
    : null
}

function readingAnchorElementAtPoint(
  messageList: HTMLElement,
  x: number,
  y: number
): HTMLElement | null {
  return messageList.ownerDocument.elementsFromPoint(x, y).find(
    (element): element is HTMLElement =>
      element instanceof HTMLElement &&
      element !== messageList &&
      messageList.contains(element)
  ) ?? null
}

function readingCaretTargetAtPoint(
  messageList: HTMLElement,
  x: number,
  y: number
): TimelineReadingAnchorTarget | null {
  type CaretDocument = Document & {
    caretPositionFromPoint?: (
      x: number,
      y: number
    ) => { offsetNode: Node; offset: number } | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  const documentWithCaret = messageList.ownerDocument as CaretDocument
  const position = documentWithCaret.caretPositionFromPoint?.(x, y)
  const legacyRange = position === undefined || position === null
    ? documentWithCaret.caretRangeFromPoint?.(x, y) ?? null
    : null
  const node = position?.offsetNode ?? legacyRange?.startContainer ?? null
  const offset = position?.offset ?? legacyRange?.startOffset ?? 0
  const parent = node instanceof Text ? node.parentElement : node
  if (!(parent instanceof HTMLElement) || !messageList.contains(parent)) return null
  return node instanceof Text
    ? { kind: 'text', node, offset }
    : { kind: 'element', element: parent }
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
