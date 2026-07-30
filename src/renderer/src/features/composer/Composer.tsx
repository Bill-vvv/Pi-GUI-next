import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import type {
  KernelCommandDescriptor,
  KernelProjectPathMatch,
  KernelProjectPathSearchResult,
  KernelPromptAttachment,
  KernelSessionPreview,
  KernelSessionUsage,
  KernelState,
  KernelTodoItem,
  ThinkingLevel
} from '../../../../shared/kernel-contract'
import {
  isRuntimeContextAction,
  isWorkbenchAction,
  type WorkbenchCompletedAction,
  type WorkbenchOperation
} from '../../workbench-actions'
import { Icon } from '../../components/Icon'
import { IconButton } from '../../components/IconButton'
import { useViewportPopoverPosition } from '../../components/useViewportPopoverPosition'
import { formatUsd } from '../../format-usd'
import { unknownErrorMessage as errorMessage } from '../../unknown-error-message'
import {
  formatPercent,
  formatTokenCount,
  normalizeContextPercent
} from '../../usage-formatters'
import {
  filterSlashCommands,
  parseSlashCommandToken,
  resolveSlashCommand
} from './slash-command-input'
import {
  parseActiveProjectPathToken,
  replaceProjectPathToken
} from './project-path-input'
import { shouldAbortComposerFromEscape } from './composer-escape'
import {
  resolveComposerDraftContext,
  switchComposerDraft,
  type ComposerDraft,
  type ComposerPendingAttachment as PendingAttachment
} from './composer-drafts'
import { readDroppedPromptAttachments } from './prompt-attachments'
import { ComposerModelPicker } from './ComposerModelPicker'
import { TodoPanel } from './TodoPanel'
import {
  projectPathMatchKey,
  ProjectPathSurface,
  SlashCommandSurface
} from './ComposerSuggestionSurfaces'

type ProjectPathSearchState = {
  key: string
  status: 'loading' | 'ready' | 'error'
  matches: KernelProjectPathMatch[]
  error: string | null
}

export type ComposerDraftRequest = {
  id: number
  text: string
}

export type ComposerControlRequest = {
  id: number
  action: 'focus' | 'open-model-picker'
}

type ComposerProps = {
  state: KernelState
  sessionPreview: KernelSessionPreview | null
  draftRequest: ComposerDraftRequest | null
  controlRequest: ComposerControlRequest | null
  viewedSessionKey: string | null
  viewingInactiveSession: boolean
  viewingNewSession: boolean
  newSessionPrepared: boolean
  busy: boolean
  pendingAction: WorkbenchOperation | null
  completedAction: WorkbenchCompletedAction | null
  todos: KernelTodoItem[] | null
  onSelectPromptAttachments: () => Promise<KernelPromptAttachment[]>
  onSearchProjectPaths: (query: string) => Promise<KernelProjectPathSearchResult>
  onStartSession: () => Promise<void>
  onActivateSession: (sessionKey: string) => Promise<void>
  onPrompt: (message: string, attachments?: KernelPromptAttachment[]) => Promise<void>
  onSteer: (message: string, attachments?: KernelPromptAttachment[]) => Promise<void>
  onFollowUp: (message: string, attachments?: KernelPromptAttachment[]) => Promise<void>
  onInvokeCommand: (commandId: string, argument: string) => Promise<void>
  onAbort: () => Promise<void>
  globalEscapeAbortEnabled: boolean
  onSetModel: (provider: string, modelId: string) => Promise<void>
  onSetThinkingLevel: (level: ThinkingLevel) => Promise<void>
  onSetOpenAiFastMode: (enabled: boolean) => Promise<void>
  onMeasuredHeightChange: (height: number) => void
}

export function Composer({
  state,
  sessionPreview,
  draftRequest,
  controlRequest,
  viewedSessionKey,
  viewingInactiveSession,
  viewingNewSession,
  newSessionPrepared,
  busy,
  pendingAction,
  completedAction,
  todos,
  onSelectPromptAttachments,
  onSearchProjectPaths,
  onStartSession,
  onActivateSession,
  onPrompt,
  onSteer,
  onFollowUp,
  onInvokeCommand,
  onAbort,
  globalEscapeAbortEnabled,
  onSetModel,
  onSetThinkingLevel,
  onSetOpenAiFastMode,
  onMeasuredHeightChange
}: ComposerProps): React.JSX.Element {
  const [prompt, setPrompt] = useState('')
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([])
  const [attachmentProcessing, setAttachmentProcessing] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [selectedCommandId, setSelectedCommandId] = useState<string | null>(null)
  const [dismissedMenuPrompt, setDismissedMenuPrompt] = useState<string | null>(null)
  const [cursorPosition, setCursorPosition] = useState(0)
  const [projectPathSearch, setProjectPathSearch] = useState<ProjectPathSearchState | null>(null)
  const [selectedProjectPath, setSelectedProjectPath] = useState<string | null>(null)
  const [dismissedProjectPathKey, setDismissedProjectPathKey] = useState<string | null>(null)
  const [commandError, setCommandError] = useState<string | null>(null)
  const [modelPickerOpenRequestId, setModelPickerOpenRequestId] = useState<number | null>(null)
  const composerRef = useRef<HTMLFormElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const slashSurfaceRef = useRef<HTMLElement>(null)
  const selectedCommandOptionRef = useRef<HTMLButtonElement>(null)
  const selectedProjectPathOptionRef = useRef<HTMLButtonElement>(null)
  const restoreFocusRef = useRef(false)
  const attachmentDragDepthRef = useRef(0)
  const attachmentProcessingRef = useRef(false)
  const previousCompletedActionRef = useRef(completedAction)
  const appliedDraftRequestIdRef = useRef<number | null>(null)
  const appliedControlRequestIdRef = useRef<number | null>(null)
  const projectPathSearchRevisionRef = useRef(0)
  const composerDraftsRef = useRef(new Map<string, ComposerDraft>())
  const { activeProjectKey, activeSessionKey, runtime, session } = state
  const activeWorkspace = activeProjectKey === null
    ? null
    : state.projects.find(({ path }) => path === activeProjectKey) ?? null
  const taskWorkspace = activeWorkspace?.workspaceKind === 'task'
  const projectPathFeaturesAvailable = !taskWorkspace
  const displayedSessionKey = viewingNewSession
    ? null
    : viewedSessionKey ?? activeSessionKey
  const displayedSessionSummary = displayedSessionKey === null
    ? null
    : state.sessions.find(({ key }) => key === displayedSessionKey) ?? null
  const displayedSessionId = displayedSessionSummary?.id ?? (
    displayedSessionKey === activeSessionKey ? session.id : null
  )
  const draftContext = resolveComposerDraftContext({
    projectKey: activeProjectKey,
    viewingNewSession,
    sessionKey: displayedSessionKey,
    sessionId: displayedSessionId,
    provisional: displayedSessionSummary?.provisional === true
  })
  const displayedContextKey = draftContext.key
  const draftContextRef = useRef(draftContext)
  const displayedContextKeyRef = useRef(displayedContextKey)
  displayedContextKeyRef.current = displayedContextKey
  const promptRef = useRef(prompt)
  promptRef.current = prompt
  const pendingAttachmentsRef = useRef(pendingAttachments)
  pendingAttachmentsRef.current = pendingAttachments
  const cursorPositionRef = useRef(cursorPosition)
  cursorPositionRef.current = cursorPosition
  const activeProjectKeyRef = useRef(activeProjectKey)
  activeProjectKeyRef.current = activeProjectKey
  const preparingNewSession = viewingNewSession && !newSessionPrepared
  const submissionBusy = busy && !preparingNewSession
  const commands = preparingNewSession ? [] : state.commands ?? []
  const availableModels = state.availableModels ?? []
  const openAiFastModeAvailable = session.model !== null && (
    session.model.provider === 'openai' ||
    session.model.provider === 'openai-codex' ||
    (session.model.provider === 'vvqq-cpa' && session.model.id.startsWith('gpt-'))
  )
  const viewedSessionRuntimeStatus = viewingInactiveSession
    ? state.sessions.find(({ key }) => key === viewedSessionKey)?.runtimeStatus ?? 'stopped'
    : runtime.status
  const running = !viewingInactiveSession && runtime.status === 'running'
  const ready = viewingInactiveSession
    ? canChangeRuntimeContext(viewedSessionRuntimeStatus)
    : viewingNewSession && !newSessionPrepared
      ? preparingNewSession
      : runtime.status === 'ready'
  const promptCanWaitForStartingRuntime =
    viewedSessionKey !== null && viewedSessionRuntimeStatus === 'starting'
  const draftEditable = activeProjectKey !== null && !submitting
  const runtimeContextBusy =
    !preparingNewSession &&
    pendingAction !== null &&
    isRuntimeContextAction(pendingAction)
  const attachmentInputAvailable =
    draftEditable &&
    !attachmentProcessing &&
    !runtimeContextBusy
  const canSubmit =
    (ready || running || promptCanWaitForStartingRuntime) &&
    !submissionBusy &&
    !submitting &&
    !attachmentProcessing
  const slashQuery = parseSlashCommandToken(prompt, commands)
  const matchingCommands = slashQuery === null
    ? []
    : filterSlashCommands(commands, slashQuery)
  const showSlashCommandSurface =
    !preparingNewSession &&
    ready && draftEditable && slashQuery !== null && dismissedMenuPrompt !== prompt
  const activeProjectPathToken = parseActiveProjectPathToken(prompt, cursorPosition)
  const projectPathRequestKey = activeProjectPathToken === null
    ? null
    : JSON.stringify([
        displayedContextKey,
        prompt,
        cursorPosition,
        activeProjectPathToken.start,
        activeProjectPathToken.end,
        activeProjectPathToken.query
      ])
  const projectPathSearchEnabled =
    projectPathFeaturesAvailable &&
    draftEditable &&
    activeProjectKey !== null &&
    slashQuery === null &&
    activeProjectPathToken !== null &&
    projectPathRequestKey !== dismissedProjectPathKey
  const showProjectPathSurface = projectPathSearchEnabled && !showSlashCommandSurface
  const { popoverRef: projectPathSurfaceRef, position: projectPathSurfacePosition } =
    useViewportPopoverPosition(showProjectPathSurface, textareaRef, 300)
  const visibleProjectPathSearch =
    projectPathSearch?.key === projectPathRequestKey ? projectPathSearch : null
  const projectPathMatches = visibleProjectPathSearch?.matches ?? []
  const selectedProjectPathMatch =
    projectPathMatches.find((match) => projectPathMatchKey(match) === selectedProjectPath) ??
    projectPathMatches[0] ??
    null
  const activeProjectPathOptionKey = selectedProjectPathMatch === null
    ? null
    : projectPathMatchKey(selectedProjectPathMatch)
  const selectedProjectPathIndex = projectPathMatches.findIndex(
    (match) => projectPathMatchKey(match) === activeProjectPathOptionKey
  )
  const selectedCommand =
    matchingCommands.find((command) => command.id === selectedCommandId) ??
    matchingCommands[0] ??
    null
  const activeCommandId = selectedCommand?.id ?? null
  const selectedCommandIndex = matchingCommands.findIndex(
    (command) => command.id === activeCommandId
  )
  const canStart =
    canStartRuntime(runtime.status) &&
    activeProjectKey !== null &&
    !taskWorkspace &&
    !busy
  const canResume =
    canStartRuntime(runtime.status) &&
    activeProjectKey !== null &&
    activeSessionKey !== null &&
    session.resumeAvailable &&
    !busy
  useLayoutEffect(() => {
    const previousContext = draftContextRef.current
    if (previousContext.key === draftContext.key) {
      draftContextRef.current = draftContext
      return
    }

    const nextDraft = switchComposerDraft(
      composerDraftsRef.current,
      previousContext,
      draftContext,
      {
        prompt: promptRef.current,
        pendingAttachments: pendingAttachmentsRef.current,
        cursorPosition: cursorPositionRef.current
      }
    )
    draftContextRef.current = draftContext
    promptRef.current = nextDraft.prompt
    pendingAttachmentsRef.current = nextDraft.pendingAttachments
    cursorPositionRef.current = nextDraft.cursorPosition
    setPrompt(nextDraft.prompt)
    setPendingAttachments(nextDraft.pendingAttachments)
    setCursorPosition(nextDraft.cursorPosition)

    const restoreFrame = requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (textarea === null) return
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`
      textarea.setSelectionRange(nextDraft.cursorPosition, nextDraft.cursorPosition)
    })
    return () => cancelAnimationFrame(restoreFrame)
  }, [
    draftContext.key,
    draftContext.kind,
    draftContext.projectKey,
    draftContext.provisional,
    draftContext.sessionKey
  ])
  useLayoutEffect(() => {
    const composer = composerRef.current
    if (composer === null) return
    let measuredHeight = -1

    const updateMeasuredHeight = (): void => {
      const height = Math.ceil(composer.getBoundingClientRect().height)
      if (height === measuredHeight) return
      measuredHeight = height
      onMeasuredHeightChange(height)
    }

    updateMeasuredHeight()
    const resizeObserver = new ResizeObserver(updateMeasuredHeight)
    resizeObserver.observe(composer)

    return () => {
      resizeObserver.disconnect()
      onMeasuredHeightChange(0)
    }
  }, [onMeasuredHeightChange])

  const abortRuntime = useCallback(async (): Promise<void> => {
    const contextKey = displayedContextKeyRef.current
    setCommandError(null)
    try {
      await onAbort()
    } catch (error) {
      if (displayedContextKeyRef.current === contextKey) {
        setCommandError(errorMessage(error))
      }
    }
  }, [onAbort])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!shouldAbortComposerFromEscape({
        enabled: globalEscapeAbortEnabled,
        running,
        key: event.key,
        defaultPrevented: event.defaultPrevented,
        isComposing: event.isComposing,
        keyCode: event.keyCode
      })) return
      event.preventDefault()
      void abortRuntime()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [abortRuntime, globalEscapeAbortEnabled, running])

  useEffect(() => {
    if (!viewingNewSession) return
    restoreFocusRef.current = true
  }, [viewingNewSession])

  useEffect(() => {
    setSelectedCommandId(null)
    setDismissedMenuPrompt(null)
    setProjectPathSearch(null)
    setSelectedProjectPath(null)
    setDismissedProjectPathKey(null)
    projectPathSearchRevisionRef.current += 1
    setCommandError(null)
    setModelPickerOpenRequestId(null)
  }, [activeProjectKey, activeSessionKey, sessionPreview?.sessionKey, viewingNewSession])

  useEffect(() => {
    if (
      draftRequest === null ||
      appliedDraftRequestIdRef.current === draftRequest.id
    ) return
    appliedDraftRequestIdRef.current = draftRequest.id
    setPrompt(draftRequest.text)
    setCursorPosition(draftRequest.text.length)
    setPendingAttachments([])
    setSelectedCommandId(null)
    setDismissedMenuPrompt(null)
    setProjectPathSearch(null)
    setSelectedProjectPath(null)
    setDismissedProjectPathKey(null)
    setCommandError(null)
    restoreFocusRef.current = true
    const focusFrame = requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (textarea === null || textarea.disabled) return
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`
      textarea.focus()
    })
    return () => cancelAnimationFrame(focusFrame)
  }, [draftRequest])

  useEffect(() => {
    if (
      controlRequest === null ||
      appliedControlRequestIdRef.current === controlRequest.id
    ) return
    appliedControlRequestIdRef.current = controlRequest.id
    if (controlRequest.action === 'focus') {
      setModelPickerOpenRequestId(null)
      requestAnimationFrame(() => {
        const textarea = textareaRef.current
        if (textarea === null || textarea.disabled) return
        textarea.focus()
      })
      return
    }
    if (
      runtime.status !== 'ready' ||
      viewingInactiveSession ||
      (viewingNewSession && !newSessionPrepared)
    ) return
    setModelPickerOpenRequestId(controlRequest.id)
  }, [
    controlRequest,
    runtime.status,
    viewingInactiveSession,
    viewingNewSession,
    newSessionPrepared
  ])

  useEffect(() => {
    if (previousCompletedActionRef.current === completedAction) return
    previousCompletedActionRef.current = completedAction
    if (
      completedAction !== null &&
      completedAction.succeeded &&
      isRuntimeContextAction(completedAction.action)
    ) {
      restoreFocusRef.current = true
    }
  }, [completedAction])

  useEffect(() => {
    if (!draftEditable || !restoreFocusRef.current) return
    const focusFrame = requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (textarea === null || textarea.disabled) return
      restoreFocusRef.current = false
      textarea.focus()
    })
    return () => cancelAnimationFrame(focusFrame)
  }, [attachmentProcessing, completedAction, draftEditable])

  useLayoutEffect(() => {
    if (!showSlashCommandSurface || selectedCommand === null) return
    selectedCommandOptionRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeCommandId, selectedCommandIndex, showSlashCommandSurface])

  useLayoutEffect(() => {
    if (!showProjectPathSurface || selectedProjectPathMatch === null) return
    selectedProjectPathOptionRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeProjectPathOptionKey, selectedProjectPathIndex, showProjectPathSurface])

  useEffect(() => {
    const revision = projectPathSearchRevisionRef.current + 1
    projectPathSearchRevisionRef.current = revision

    if (
      !projectPathSearchEnabled ||
      projectPathRequestKey === null ||
      activeProjectPathToken === null ||
      activeProjectKey === null
    ) {
      setProjectPathSearch(null)
      setSelectedProjectPath(null)
      return
    }

    const requestKey = projectPathRequestKey
    const requestContextKey = displayedContextKey
    const requestProjectKey = activeProjectKey
    const requestPrompt = prompt
    const requestCursor = cursorPosition
    const requestQuery = activeProjectPathToken.query
    setProjectPathSearch({
      key: requestKey,
      status: 'loading',
      matches: [],
      error: null
    })
    setSelectedProjectPath(null)

    const debounceTimer = window.setTimeout(() => {
      void onSearchProjectPaths(requestQuery).then(
        (result) => {
          if (
            projectPathSearchRevisionRef.current !== revision ||
            displayedContextKeyRef.current !== requestContextKey ||
            activeProjectKeyRef.current !== requestProjectKey ||
            promptRef.current !== requestPrompt ||
            cursorPositionRef.current !== requestCursor ||
            result.projectKey !== activeProjectKeyRef.current ||
            result.query !== requestQuery
          ) return
          setProjectPathSearch({
            key: requestKey,
            status: 'ready',
            matches: result.matches.slice(0, 100),
            error: null
          })
        },
        (error) => {
          if (
            projectPathSearchRevisionRef.current !== revision ||
            displayedContextKeyRef.current !== requestContextKey ||
            activeProjectKeyRef.current !== requestProjectKey ||
            promptRef.current !== requestPrompt ||
            cursorPositionRef.current !== requestCursor
          ) return
          setProjectPathSearch({
            key: requestKey,
            status: 'error',
            matches: [],
            error: errorMessage(error)
          })
        }
      )
    }, 100)

    return () => window.clearTimeout(debounceTimer)
  }, [
    activeProjectKey,
    activeProjectPathToken?.end,
    activeProjectPathToken?.query,
    activeProjectPathToken?.start,
    cursorPosition,
    displayedContextKey,
    onSearchProjectPaths,
    projectPathRequestKey,
    projectPathSearchEnabled,
    prompt
  ])

  useEffect(() => {
    if (!showSlashCommandSurface) return
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (slashSurfaceRef.current?.contains(target) || textareaRef.current?.contains(target)) return
      setDismissedMenuPrompt(prompt)
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => document.removeEventListener('pointerdown', handlePointerDown, true)
  }, [prompt, showSlashCommandSurface])

  useEffect(() => {
    if (!showProjectPathSurface || projectPathRequestKey === null) return
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (
        projectPathSurfaceRef.current?.contains(target) ||
        textareaRef.current?.contains(target)
      ) return
      setDismissedProjectPathKey(projectPathRequestKey)
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => document.removeEventListener('pointerdown', handlePointerDown, true)
  }, [projectPathRequestKey, showProjectPathSurface])

  async function invokeCommand(command: KernelCommandDescriptor, argument: string): Promise<void> {
    if (!ready || submitting || submissionBusy) return
    setSubmitting(true)
    setCommandError(null)
    try {
      await onInvokeCommand(command.id, argument)
      setPrompt('')
      setCursorPosition(0)
      if (textareaRef.current) textareaRef.current.style.height = ''
    } catch (error) {
      setCommandError(errorMessage(error))
      return
    } finally {
      restoreFocusRef.current = true
      setSubmitting(false)
    }
  }

  function appendPendingAttachments(attachments: readonly KernelPromptAttachment[]): void {
    setPendingAttachments((current) => [
      ...current,
      ...attachments.map((attachment) => ({
        id: crypto.randomUUID(),
        attachment
      }))
    ])
  }

  async function selectAttachments(): Promise<void> {
    if (!attachmentInputAvailable || attachmentProcessingRef.current) return
    const attachmentContextKey = displayedContextKeyRef.current
    attachmentProcessingRef.current = true
    setAttachmentProcessing(true)
    setCommandError(null)
    try {
      const attachments = await onSelectPromptAttachments()
      if (displayedContextKeyRef.current === attachmentContextKey) {
        appendPendingAttachments(attachments)
      }
    } catch (error) {
      if (displayedContextKeyRef.current === attachmentContextKey) {
        setCommandError(errorMessage(error))
      }
    } finally {
      attachmentProcessingRef.current = false
      setAttachmentProcessing(false)
      if (displayedContextKeyRef.current === attachmentContextKey) {
        restoreFocusRef.current = true
      }
    }
  }

  async function addDroppedAttachments(files: readonly File[]): Promise<void> {
    if (!attachmentInputAvailable || attachmentProcessingRef.current || files.length === 0) return
    const attachmentContextKey = displayedContextKeyRef.current
    attachmentProcessingRef.current = true
    setAttachmentProcessing(true)
    setCommandError(null)
    try {
      const attachments = await readDroppedPromptAttachments(
        files,
        (file) => window.piGui.getPathForFile(file)
      )
      if (displayedContextKeyRef.current === attachmentContextKey) {
        appendPendingAttachments(attachments)
      }
    } catch (error) {
      if (displayedContextKeyRef.current === attachmentContextKey) {
        setCommandError(errorMessage(error))
      }
    } finally {
      attachmentProcessingRef.current = false
      setAttachmentProcessing(false)
      if (displayedContextKeyRef.current === attachmentContextKey) {
        restoreFocusRef.current = true
      }
    }
  }

  function completeCommand(command: KernelCommandDescriptor): void {
    const completedPrompt = `/${command.name}${command.argumentHint !== null ? ' ' : ''}`
    setPrompt(completedPrompt)
    setCursorPosition(completedPrompt.length)
    setDismissedMenuPrompt(command.argumentHint === null ? completedPrompt : null)
    setCommandError(null)
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  function completeProjectPath(match: KernelProjectPathMatch): void {
    const textarea = textareaRef.current
    const currentPrompt = promptRef.current
    const currentCursor = textarea?.selectionStart ?? cursorPositionRef.current
    const token = parseActiveProjectPathToken(currentPrompt, currentCursor)
    if (token === null) return

    try {
      const replacement = replaceProjectPathToken(currentPrompt, token, match.path)
      setPrompt(replacement.value)
      setCursorPosition(replacement.cursor)
      setProjectPathSearch(null)
      setSelectedProjectPath(null)
      setDismissedProjectPathKey(null)
      setCommandError(null)
      projectPathSearchRevisionRef.current += 1
      requestAnimationFrame(() => {
        const currentTextarea = textareaRef.current
        if (currentTextarea === null) return
        currentTextarea.focus()
        currentTextarea.setSelectionRange(replacement.cursor, replacement.cursor)
      })
    } catch (error) {
      setCommandError(errorMessage(error))
    }
  }

  function clearSubmittedDraft(): void {
    setPrompt('')
    setCursorPosition(0)
    setPendingAttachments([])
    if (textareaRef.current) textareaRef.current.style.height = ''
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  async function submitPrompt(behavior: 'prompt' | 'steer' | 'follow-up' = running ? 'follow-up' : 'prompt'): Promise<void> {
    const message = prompt.trim()
    const submittedPrompt = prompt
    const submittedContextKey = displayedContextKey
    const submittedPendingAttachments = pendingAttachments
    const attachments = pendingAttachments.map(({ attachment }) => attachment)
    if (
      (!ready && !running && !promptCanWaitForStartingRuntime) ||
      submitting ||
      submissionBusy ||
      attachmentProcessingRef.current ||
      (message.length === 0 && attachments.length === 0)
    ) return

    if (running) {
      setSubmitting(true)
      setCommandError(null)
      clearSubmittedDraft()
      try {
        if (behavior === 'follow-up') await onFollowUp(message, attachments)
        else await onSteer(message, attachments)
      } catch (error) {
        restoreFailedSubmission(
          submittedContextKey,
          submittedPrompt,
          submittedPendingAttachments,
          error
        )
      } finally {
        if (displayedContextKeyRef.current === submittedContextKey) {
          restoreFocusRef.current = true
        }
        setSubmitting(false)
      }
      return
    }

    if (promptCanWaitForStartingRuntime && message.startsWith('/')) {
      setCommandError('Slash 命令将在对话启动完成后可用。')
      return
    }

    const resolution = message.length === 0
      ? { kind: 'prompt' as const }
      : resolveSlashCommand(message, commands)
    if (resolution.kind === 'unknown') {
      setCommandError(`未知命令：/${resolution.name}`)
      return
    }
    if (resolution.kind === 'command') {
      if (attachments.length > 0) {
        setCommandError('Slash 命令不能携带附件。')
        return
      }
      const argumentHint = resolution.command.argumentHint?.trim()
      if (
        resolution.argument.length === 0 &&
        argumentHint !== undefined &&
        argumentHint.startsWith('<')
      ) {
        setCommandError(`/${resolution.command.name} 需要参数：${argumentHint}`)
        return
      }
      await invokeCommand(resolution.command, resolution.argument)
      return
    }

    setSubmitting(true)
    setCommandError(null)
    clearSubmittedDraft()
    try {
      await onPrompt(message, attachments)
    } catch (error) {
      restoreFailedSubmission(
        submittedContextKey,
        submittedPrompt,
        submittedPendingAttachments,
        error
      )
    } finally {
      if (displayedContextKeyRef.current === submittedContextKey) {
        restoreFocusRef.current = true
      }
      setSubmitting(false)
    }
  }

  function restoreFailedSubmission(
    submittedContextKey: string,
    submittedPrompt: string,
    submittedAttachments: PendingAttachment[],
    error: unknown
  ): void {
    if (displayedContextKeyRef.current !== submittedContextKey) return
    setCommandError(errorMessage(error))
    setPrompt(submittedPrompt)
    setCursorPosition(submittedPrompt.length)
    setPendingAttachments(submittedAttachments)
    requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (textarea === null) return
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`
      textarea.focus()
    })
  }

  return (
    <form
      ref={composerRef}
      className={`composer${dragOver ? ' drag-over' : ''}`}
      aria-busy={attachmentProcessing || submitting ? true : undefined}
      onDragEnter={(event) => {
        if (!hasDraggedFiles(event.dataTransfer) || !attachmentInputAvailable) return
        event.preventDefault()
        attachmentDragDepthRef.current += 1
        setDragOver(true)
      }}
      onDragOver={(event) => {
        if (!hasDraggedFiles(event.dataTransfer) || !attachmentInputAvailable) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      }}
      onDragLeave={(event) => {
        if (!hasDraggedFiles(event.dataTransfer)) return
        attachmentDragDepthRef.current = Math.max(0, attachmentDragDepthRef.current - 1)
        if (attachmentDragDepthRef.current === 0) setDragOver(false)
      }}
      onDrop={(event) => {
        if (!hasDraggedFiles(event.dataTransfer)) return
        event.preventDefault()
        attachmentDragDepthRef.current = 0
        setDragOver(false)
        void addDroppedAttachments([...event.dataTransfer.files])
      }}
      onSubmit={(event) => {
        event.preventDefault()
        void submitPrompt()
      }}
    >
      {todos === null ? null : <TodoPanel key={displayedContextKey} todos={todos} />}

      {running && (session.pendingSteeringMessages.length > 0 || session.pendingFollowUpMessages.length > 0) ? (
        <section className="composer-queue" aria-label="已排队消息" aria-live="polite">
          <ol className="composer-queue-list">
            {session.pendingSteeringMessages.map((message, index) => (
              <li className="composer-queue-item" key={`steer-${index}`}>
                <span className="composer-queue-kind">引导</span>
                <p className="composer-queue-message">{message}</p>
              </li>
            ))}
            {session.pendingFollowUpMessages.map((message, index) => (
              <li className="composer-queue-item" key={`follow-up-${index}`}>
                <span className="composer-queue-kind">排队</span>
                <p className="composer-queue-message">{message}</p>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {showSlashCommandSurface ? (
        <SlashCommandSurface
          commands={matchingCommands}
          activeCommandId={activeCommandId}
          surfaceRef={slashSurfaceRef}
          selectedOptionRef={selectedCommandOptionRef}
          onSelect={completeCommand}
        />
      ) : null}

      {showProjectPathSurface && projectPathSurfacePosition !== null
        ? (
            <ProjectPathSurface
              search={visibleProjectPathSearch}
              matches={projectPathMatches}
              activeOptionKey={activeProjectPathOptionKey}
              placement={projectPathSurfacePosition.placement}
              style={projectPathSurfacePosition.style}
              surfaceRef={projectPathSurfaceRef}
              selectedOptionRef={selectedProjectPathOptionRef}
              onSelect={completeProjectPath}
            />
          )
        : null}

      {commandError !== null ? (
        <p className="composer-command-error" role="alert">{commandError}</p>
      ) : null}

      <div
        className="composer-input-row"
        onClick={(event) => {
          const target = event.target
          if (!(target instanceof Element) || target.closest('button, textarea') !== null) return
          textareaRef.current?.focus()
        }}
      >
        <div className="composer-editor-column">
          {pendingAttachments.length > 0 ? (
            <ul className="composer-attachment-list" aria-label="待发送附件">
              {pendingAttachments.map(({ id, attachment }) => (
                <li
                  className={`composer-attachment ${attachment.type}`}
                  key={id}
                  data-tooltip={attachment.path}
                  data-tooltip-variant="mono"
                >
                  {attachment.type === 'image' ? (
                    <img
                      className="composer-attachment-thumbnail"
                      src={`data:${attachment.image.mimeType};base64,${attachment.image.data}`}
                      alt=""
                    />
                  ) : (
                    <span className="composer-attachment-file-kind" aria-hidden="true">引用</span>
                  )}
                  <span className="composer-attachment-name">{attachment.name}</span>
                  <button
                    className="composer-attachment-remove"
                    type="button"
                    aria-label={`移除附件 ${attachment.name}`}
                    disabled={submitting || attachmentProcessing}
                    onClick={() => {
                      setPendingAttachments((current) => current.filter((item) => item.id !== id))
                    }}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <textarea
            ref={textareaRef}
            value={prompt}
            rows={1}
            disabled={!draftEditable}
            role="combobox"
            aria-label="发送给 Pi 的任务"
            aria-autocomplete="list"
            aria-expanded={showSlashCommandSurface || showProjectPathSurface}
            aria-haspopup="listbox"
            aria-controls={
              showSlashCommandSurface
                ? 'slash-command-listbox'
                : showProjectPathSurface
                  ? 'project-path-listbox'
                  : undefined
            }
            aria-activedescendant={
              showSlashCommandSurface && selectedCommand !== null
                ? `slash-command-${selectedCommand.id}`
                : showProjectPathSurface && selectedProjectPathIndex !== -1
                  ? `project-path-option-${selectedProjectPathIndex}`
                  : undefined
            }
            placeholder={composerPlaceholder(
              state,
              viewingInactiveSession,
              viewingNewSession,
              viewedSessionRuntimeStatus
            )}
            onPaste={(event) => {
              const files = event.clipboardData.files.length > 0
                ? [...event.clipboardData.files]
                : [...event.clipboardData.items]
                  .filter((item) => item.kind === 'file')
                  .map((item) => item.getAsFile())
                  .filter((file): file is File => file !== null)
              if (files.length === 0) return
              event.preventDefault()
              void addDroppedAttachments(files)
            }}
            onChange={(event) => {
              setPrompt(event.target.value)
              setCursorPosition(event.target.selectionStart)
              setSelectedCommandId(null)
              setDismissedMenuPrompt(null)
              setDismissedProjectPathKey(null)
              setCommandError(null)
              event.currentTarget.style.height = 'auto'
              event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 180)}px`
            }}
            onSelect={(event) => {
              setCursorPosition(event.currentTarget.selectionStart)
            }}
            onKeyDown={(event) => {
              const completesAsciiSlashCommand =
                event.key === 'Tab' &&
                showSlashCommandSurface &&
                selectedCommand !== null &&
                /^\/[a-z0-9-]*$/i.test(prompt)
              if (event.nativeEvent.keyCode === 229) return
              if (event.nativeEvent.isComposing && !completesAsciiSlashCommand) return
              if (showSlashCommandSurface && event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                setDismissedMenuPrompt(prompt)
                return
              }
              if (showSlashCommandSurface && matchingCommands.length > 0) {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault()
                  const direction = event.key === 'ArrowDown' ? 1 : -1
                  const currentIndex = matchingCommands.findIndex(
                    (command) => command.id === activeCommandId
                  )
                  const nextIndex = currentIndex === -1
                    ? direction === 1 ? 0 : matchingCommands.length - 1
                    : (currentIndex + direction + matchingCommands.length) % matchingCommands.length
                  setSelectedCommandId(matchingCommands[nextIndex].id)
                  return
                }
                if (event.key === 'Tab' && selectedCommand !== null) {
                  event.preventDefault()
                  completeCommand(selectedCommand)
                  return
                }
                if (event.key === 'Enter' && !event.shiftKey && selectedCommand !== null) {
                  event.preventDefault()
                  completeCommand(selectedCommand)
                  return
                }
              }
              if (showProjectPathSurface && event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                if (projectPathRequestKey !== null) {
                  setDismissedProjectPathKey(projectPathRequestKey)
                }
                return
              }
              if (showProjectPathSurface && projectPathMatches.length > 0) {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault()
                  const direction = event.key === 'ArrowDown' ? 1 : -1
                  const nextIndex = selectedProjectPathIndex === -1
                    ? direction === 1 ? 0 : projectPathMatches.length - 1
                    : (
                        selectedProjectPathIndex +
                        direction +
                        projectPathMatches.length
                      ) % projectPathMatches.length
                  setSelectedProjectPath(projectPathMatchKey(projectPathMatches[nextIndex]))
                  return
                }
                if (
                  (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) &&
                  selectedProjectPathMatch !== null
                ) {
                  event.preventDefault()
                  completeProjectPath(selectedProjectPathMatch)
                  return
                }
              }
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void submitPrompt(running && event.altKey ? 'steer' : running ? 'follow-up' : 'prompt')
              }
            }}
          />
        </div>

        <div className="composer-input-actions">
          <IconButton
            className="composer-attach-action"
            icon="attach"
            label="添加图片或引用文件"
            type="button"
            disabled={!attachmentInputAvailable}
            aria-busy={attachmentProcessing ? true : undefined}
            onClick={() => void selectAttachments()}
          />
          <div className="composer-submit-actions">
            {running ? (
              <IconButton
                className="send-action abort-action"
                icon="stop"
                label="中止本轮输出"
                type="button"
                onClick={() => void abortRuntime()}
              />
            ) : (
              <IconButton
                className="send-action"
                icon="enter"
                label="发送"
                type="submit"
                disabled={
                  !canSubmit ||
                  (prompt.trim().length === 0 && pendingAttachments.length === 0)
                }
              />
            )}
          </div>
        </div>
      </div>

      <div className="composer-meta-row">
        <div className="composer-runtime-controls">
          {preparingNewSession || viewingInactiveSession ? null : canResume ? (
            <>
              {taskWorkspace ? null : (
                <button
                  className="composer-start-action"
                  type="button"
                  disabled={!canStart}
                  aria-busy={isWorkbenchAction(pendingAction, 'start-session') ? true : undefined}
                  onClick={() => void onStartSession().catch(() => undefined)}
                >
                  <span>新建对话</span>
                </button>
              )}
              <button
                className="composer-start-action"
                type="button"
                disabled={busy}
                aria-busy={isWorkbenchAction(pendingAction, 'activate-session') ? true : undefined}
                onClick={() => {
                  if (activeSessionKey !== null) {
                    void onActivateSession(activeSessionKey).catch(() => undefined)
                  }
                }}
              >
                <span>{runtime.status === 'crashed'
                  ? '重启并恢复'
                  : taskWorkspace ? '恢复任务' : '恢复对话'}</span>
                <Icon name="arrow-right" size="sm" />
              </button>
            </>
          ) : canStartRuntime(runtime.status) && !taskWorkspace ? (
            <button
              className="composer-start-action"
              type="button"
              disabled={!canStart}
              aria-busy={isWorkbenchAction(pendingAction, 'start-session') ? true : undefined}
              onClick={() => void onStartSession().catch(() => undefined)}
            >
              <span>{runtime.status === 'crashed' ? '重新启动 Pi' : '启动 Pi'}</span>
              <Icon name="arrow-right" size="sm" />
            </button>
          ) : runtime.status === 'starting' || runtime.status === 'stopping' ? (
            <span className="composer-runtime-state" role="status" aria-live="polite">
              {runtime.status === 'starting' ? '正在启动' : '正在停止'}
            </span>
          ) : (
            <ComposerModelPicker
              key={controlRequest?.action === 'focus' ? `focus:${controlRequest.id}` : 'model-picker'}
              model={session.model}
              thinkingLevel={session.thinkingLevel}
              openAiFastModeAvailable={openAiFastModeAvailable}
              openAiFastMode={session.openAiFastMode}
              openAiFastModePending={
                isWorkbenchAction(pendingAction, 'set-openai-fast-mode')
              }
              availableModels={availableModels}
              runtimeStatus={runtime.status}
              busy={busy}
              contextKey={displayedContextKey}
              openRequestId={
                controlRequest?.action === 'focus' ? null : modelPickerOpenRequestId
              }
              onSetModel={onSetModel}
              onSetThinkingLevel={onSetThinkingLevel}
              onSetOpenAiFastMode={onSetOpenAiFastMode}
            />
          )}

          <ContextIndicator
            usage={viewingInactiveSession ? null : session.usage}
            tokenCountFormat={state.appearance.tokenCountFormat}
          />
        </div>
      </div>
    </form>
  )
}

function ContextIndicator({
  usage,
  tokenCountFormat
}: {
  usage: KernelSessionUsage | null
  tokenCountFormat: KernelState['appearance']['tokenCountFormat']
}): React.JSX.Element {
  const contextPercent = normalizeContextPercent(usage?.contextPercent ?? null)
  const ringPercent = contextPercent ?? 0
  const promptTokens = usage === null
    ? null
    : usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  const cacheRate = usage === null || promptTokens === null || promptTokens === 0
    ? null
    : (usage.cacheReadTokens / promptTokens) * 100
  const tooltipId = 'composer-context-tooltip'
  const contextLabel = usage === null
    ? '上下文使用量不可用'
    : contextPercent === null
      ? '上下文占比暂不可用'
      : `上下文已使用 ${contextPercent.toFixed(1)}%`

  return (
    <div
      className={`context-indicator${contextPercent === null ? ' unknown' : ''}`}
      style={{ '--context-percent': `${ringPercent}%` } as React.CSSProperties}
      tabIndex={0}
      aria-label={contextLabel}
      aria-describedby={tooltipId}
    >
      <span className="context-ring" aria-hidden="true" />
      <div id={tooltipId} className="context-tooltip" role="tooltip">
        <strong>本对话用量与费用</strong>
        {usage === null ? (
          <span>当前未提供 token 使用量</span>
        ) : (
          <>
            <span className="context-tooltip-context">
              {contextUsageLabel(usage, tokenCountFormat)}
            </span>
            <dl className="context-tooltip-stats">
              <dt>总输入（含缓存）</dt>
              <dd>{formatTokenCount(promptTokens, tokenCountFormat)}</dd>
              <dt>缓存读取</dt>
              <dd>{formatTokenCount(usage.cacheReadTokens, tokenCountFormat)}</dd>
              <dt>缓存写入</dt>
              <dd>{formatTokenCount(usage.cacheWriteTokens, tokenCountFormat)}</dd>
              <dt>输出</dt>
              <dd>{formatTokenCount(usage.outputTokens, tokenCountFormat)}</dd>
              <dt>缓存率</dt>
              <dd>{formatPercent(cacheRate)}</dd>
              <dt>本对话累计（USD）</dt>
              <dd>{formatUsd(usage.cost)}</dd>
            </dl>
          </>
        )}
      </div>
    </div>
  )
}

function contextUsageLabel(
  usage: KernelSessionUsage,
  tokenCountFormat: KernelState['appearance']['tokenCountFormat']
): string {
  const tokens = usage.contextTokens === null
    ? '—'
    : formatTokenCount(usage.contextTokens, tokenCountFormat)
  const window = usage.contextWindow === null
    ? '—'
    : formatTokenCount(usage.contextWindow, tokenCountFormat)
  const percent = formatPercent(usage.contextPercent)
  return `上下文 ${tokens} / ${window} · ${percent}`
}

function composerPlaceholder(
  state: KernelState,
  viewingInactiveSession: boolean,
  viewingNewSession: boolean,
  viewedSessionRuntimeStatus: KernelState['runtime']['status']
): string {
  if (state.activeProjectKey === null) {
    return state.navigatorKind === 'task' ? '新建任务开始' : '先选择项目文件夹'
  }
  if (viewingNewSession && state.runtime.status === 'crashed') return '新对话启动失败'
  if (viewingNewSession) return ''
  if (viewingInactiveSession && canChangeRuntimeContext(viewedSessionRuntimeStatus)) return ''
  if (viewedSessionRuntimeStatus === 'starting') return '正在启动 Pi…'
  if (viewedSessionRuntimeStatus === 'stopped') return '选择对话即可自动启动'
  if (viewedSessionRuntimeStatus === 'running') return 'Enter 排队，Alt+Enter 引导'
  if (viewedSessionRuntimeStatus === 'crashed') return 'Pi Runtime 已退出'
  return ''
}

function hasDraggedFiles(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes('Files')
}

function canChangeRuntimeContext(status: KernelState['runtime']['status']): boolean {
  return status === 'stopped' || status === 'ready' || status === 'crashed'
}

function canStartRuntime(status: KernelState['runtime']['status']): boolean {
  return status === 'stopped' || status === 'crashed'
}
