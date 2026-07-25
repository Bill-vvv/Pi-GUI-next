import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import type {
  KernelCommandDescriptor,
  KernelProjectPathMatch,
  KernelProjectPathSearchResult,
  KernelPromptAttachment,
  KernelSessionPreview,
  KernelSessionUsage,
  KernelState,
  ThinkingLevel
} from '../../../../shared/kernel-contract'
import { Icon } from '../../components/Icon'
import { IconButton } from '../../components/IconButton'
import { useViewportPopoverPosition } from '../../components/useViewportPopoverPosition'
import {
  filterSlashCommands,
  parseSlashCommandToken,
  resolveSlashCommand
} from './slash-command-input'
import {
  parseActiveProjectPathToken,
  replaceProjectPathToken
} from './project-path-input'
import { readDroppedPromptAttachments } from './prompt-attachments'

type PendingAttachment = {
  id: string
  attachment: KernelPromptAttachment
}

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
  pendingAction: string | null
  completedAction: { action: string; succeeded: boolean } | null
  onSelectPromptAttachments: () => Promise<KernelPromptAttachment[]>
  onSearchProjectPaths: (query: string) => Promise<KernelProjectPathSearchResult>
  onStartSession: () => Promise<void>
  onActivateSession: (sessionKey: string) => Promise<void>
  onPrompt: (message: string, attachments?: KernelPromptAttachment[]) => Promise<void>
  onSteer: (message: string, attachments?: KernelPromptAttachment[]) => Promise<void>
  onFollowUp: (message: string, attachments?: KernelPromptAttachment[]) => Promise<void>
  onInvokeCommand: (commandId: string, argument: string) => Promise<void>
  onAbort: () => Promise<void>
  onSetModel: (provider: string, modelId: string) => Promise<void>
  onSetThinkingLevel: (level: ThinkingLevel) => Promise<void>
}

const THINKING_LEVELS: ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]

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
  onSelectPromptAttachments,
  onSearchProjectPaths,
  onStartSession,
  onActivateSession,
  onPrompt,
  onSteer,
  onFollowUp,
  onInvokeCommand,
  onAbort,
  onSetModel,
  onSetThinkingLevel
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
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const composerRef = useRef<HTMLFormElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const slashSurfaceRef = useRef<HTMLElement>(null)
  const modelPickerRef = useRef<HTMLDetailsElement>(null)
  const modelMenuTriggerRef = useRef<HTMLButtonElement>(null)
  const selectedCommandOptionRef = useRef<HTMLButtonElement>(null)
  const selectedProjectPathOptionRef = useRef<HTMLButtonElement>(null)
  const restoreFocusRef = useRef(false)
  const attachmentDragDepthRef = useRef(0)
  const attachmentProcessingRef = useRef(false)
  const previousCompletedActionRef = useRef(completedAction)
  const appliedDraftRequestIdRef = useRef<number | null>(null)
  const appliedControlRequestIdRef = useRef<number | null>(null)
  const projectPathSearchRevisionRef = useRef(0)
  const { popoverRef: modelPickerPopoverRef, position: modelPickerPosition } =
    useViewportPopoverPosition(modelPickerOpen, modelPickerRef, 420, {
      preferredWidth: 380,
      align: 'before'
    })
  const modelPickerPlaced = modelPickerPosition !== null
  const { popoverRef: modelMenuPopoverRef, position: modelMenuPosition } =
    useViewportPopoverPosition(modelMenuOpen, modelMenuTriggerRef, 320, {
      preferredWidth: 240,
      axis: 'horizontal'
    })
  const modelMenuPlaced = modelMenuPosition !== null
  const { activeProjectKey, activeSessionKey, runtime, session } = state
  const displayedContextKey = [
    activeProjectKey ?? 'no-project',
    viewingNewSession ? 'new-session' : viewedSessionKey ?? activeSessionKey ?? 'no-session'
  ].join(':')
  const displayedContextKeyRef = useRef(displayedContextKey)
  displayedContextKeyRef.current = displayedContextKey
  const promptRef = useRef(prompt)
  promptRef.current = prompt
  const cursorPositionRef = useRef(cursorPosition)
  cursorPositionRef.current = cursorPosition
  const activeProjectKeyRef = useRef(activeProjectKey)
  activeProjectKeyRef.current = activeProjectKey
  const preparingNewSession = viewingNewSession && !newSessionPrepared
  const submissionBusy = busy && !preparingNewSession
  const commands = preparingNewSession ? [] : state.commands ?? []
  const availableModels = state.availableModels ?? []
  const thinkingLevelMap = session.model?.thinkingLevelMap ?? {}
  const viewedSessionRuntimeStatus = viewingInactiveSession
    ? state.sessions.find(({ key }) => key === viewedSessionKey)?.runtimeStatus ?? 'stopped'
    : runtime.status
  const running = !viewingInactiveSession && runtime.status === 'running'
  const ready = viewingInactiveSession
    ? canChangeRuntimeContext(viewedSessionRuntimeStatus)
    : viewingNewSession && !newSessionPrepared
      ? preparingNewSession
      : runtime.status === 'ready'
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
    (ready || running) &&
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
    !busy
  const canResume =
    canStartRuntime(runtime.status) &&
    activeProjectKey !== null &&
    activeSessionKey !== null &&
    session.resumeAvailable &&
    !busy
  const availableThinkingLevels = session.model?.reasoning === true
    ? THINKING_LEVELS.filter((level) => isThinkingLevelAvailable(level, thinkingLevelMap))
    : []
  const currentThinkingLevel = session.thinkingLevel

  useLayoutEffect(() => {
    const composer = composerRef.current
    const mainChat = composer?.closest<HTMLElement>('.main-chat')
    if (!composer || !mainChat) return
    let scrollFrame: number | null = null

    const updateClearance = (): void => {
      const conversation = mainChat.querySelector<HTMLElement>('.conversation-surface')
      const followsOutput = conversation !== null &&
        conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 120
      const height = Math.ceil(composer.getBoundingClientRect().height)
      mainChat.style.setProperty('--composer-measured-clearance', `${height}px`)
      if (followsOutput && conversation !== null) {
        if (scrollFrame !== null) cancelAnimationFrame(scrollFrame)
        scrollFrame = requestAnimationFrame(() => {
          conversation.scrollTop = conversation.scrollHeight
          scrollFrame = null
        })
      }
    }

    updateClearance()
    const resizeObserver = new ResizeObserver(updateClearance)
    resizeObserver.observe(composer)

    return () => {
      resizeObserver.disconnect()
      if (scrollFrame !== null) cancelAnimationFrame(scrollFrame)
      mainChat.style.removeProperty('--composer-measured-clearance')
    }
  }, [])

  useEffect(() => {
    if (!running) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (event.isComposing || event.keyCode === 229) return
      event.preventDefault()
      void onAbort().catch(() => undefined)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onAbort, running])

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
    setModelPickerOpen(false)
    setModelMenuOpen(false)
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
      setModelPickerOpen(false)
      setModelMenuOpen(false)
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
    setModelMenuOpen(false)
    setModelPickerOpen(true)
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

  useEffect(() => {
    if (!modelPickerOpen) return
    const handlePointerDown = (event: PointerEvent): void => {
      const path = event.composedPath()
      if (
        (modelPickerRef.current !== null && path.includes(modelPickerRef.current)) ||
        (modelPickerPopoverRef.current !== null && path.includes(modelPickerPopoverRef.current)) ||
        (modelMenuPopoverRef.current !== null && path.includes(modelMenuPopoverRef.current))
      ) return
      setModelPickerOpen(false)
      setModelMenuOpen(false)
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => document.removeEventListener('pointerdown', handlePointerDown, true)
  }, [modelPickerOpen])

  useEffect(() => {
    if (!modelPickerOpen || !modelPickerPlaced) return
    const focusFrame = requestAnimationFrame(() => {
      const popover = modelPickerPopoverRef.current
      const preferredTarget =
        popover?.querySelector<HTMLElement>('.model-picker-item.selected:not(:disabled)') ??
        popover?.querySelector<HTMLElement>('.model-picker-model-button')
      preferredTarget?.focus()
    })
    return () => cancelAnimationFrame(focusFrame)
  }, [modelPickerOpen, modelPickerPlaced])

  useEffect(() => {
    if (!modelPickerOpen) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      if (modelMenuOpen) {
        setModelMenuOpen(false)
        requestAnimationFrame(() => modelMenuTriggerRef.current?.focus())
        return
      }
      closeModelPickerAndRestoreFocus()
    }
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [modelMenuOpen, modelPickerOpen])

  useEffect(() => {
    if (!modelMenuOpen || !modelMenuPlaced) return
    const focusFrame = requestAnimationFrame(() => {
      const popover = modelMenuPopoverRef.current
      const preferredTarget =
        popover?.querySelector<HTMLElement>('.model-picker-item.selected:not(:disabled)') ??
        popover?.querySelector<HTMLElement>('.model-picker-item:not(:disabled)')
      preferredTarget?.focus()
    })
    return () => cancelAnimationFrame(focusFrame)
  }, [modelMenuOpen, modelMenuPlaced])

  useEffect(() => {
    if (runtime.status === 'ready' || runtime.status === 'running') return
    setModelPickerOpen(false)
    setModelMenuOpen(false)
  }, [runtime.status])

  function closeModelPickerAndRestoreFocus(): void {
    setModelPickerOpen(false)
    setModelMenuOpen(false)
    requestAnimationFrame(() => {
      modelPickerRef.current?.querySelector<HTMLElement>('summary')?.focus()
    })
  }

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
      (!ready && !running) ||
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
        <section ref={slashSurfaceRef} className="slash-command-surface" aria-label="Slash 命令">
          <div id="slash-command-listbox" className="slash-command-list" role="listbox">
            {matchingCommands.length > 0 ? (
              matchingCommands.map((command) => (
                <button
                  ref={command.id === activeCommandId ? selectedCommandOptionRef : undefined}
                  id={`slash-command-${command.id}`}
                  className={`slash-command-option${command.id === activeCommandId ? ' selected' : ''}`}
                  type="button"
                  role="option"
                  aria-selected={command.id === activeCommandId}
                  key={command.id}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => completeCommand(command)}
                >
                  <span className="slash-command-name">
                    /{command.name}
                    {command.argumentHint !== null ? (
                      <span className="slash-command-argument-hint"> {command.argumentHint}</span>
                    ) : null}
                  </span>
                  <span className="slash-command-description">{command.description}</span>
                  <span className="slash-command-source">{commandSourceLabel(command.source)}</span>
                </button>
              ))
            ) : (
              <p id="slash-command-empty-state" role="status">没有匹配的命令</p>
            )}
          </div>
        </section>
      ) : null}

      {showProjectPathSurface && projectPathSurfacePosition !== null
        ? createPortal(
            <div
              ref={projectPathSurfaceRef}
              className="project-path-surface"
              data-placement={projectPathSurfacePosition.placement}
              style={projectPathSurfacePosition.style}
            >
              <div
                id="project-path-listbox"
                className="project-path-list"
                role="listbox"
                aria-label="项目路径"
              >
                {visibleProjectPathSearch === null ||
                visibleProjectPathSearch.status === 'loading' ? (
                  <p className="project-path-state" role="status" aria-live="polite">
                    正在搜索项目路径…
                  </p>
                ) : visibleProjectPathSearch.status === 'error' ? (
                  <p className="project-path-state error" role="alert">
                    项目路径搜索失败，请重试。
                  </p>
                ) : projectPathMatches.length === 0 ? (
                  <p className="project-path-state" role="status">没有匹配的项目路径</p>
                ) : (
                  projectPathMatches.map((match, index) => {
                    const matchKey = projectPathMatchKey(match)
                    const selected = matchKey === activeProjectPathOptionKey
                    return (
                      <button
                        ref={selected ? selectedProjectPathOptionRef : undefined}
                        id={`project-path-option-${index}`}
                        className={`project-path-option${selected ? ' selected' : ''}`}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        key={`${matchKey}:${index}`}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => completeProjectPath(match)}
                      >
                        <span className="project-path-kind">
                          {match.kind === 'directory' ? '目录' : '文件'}
                        </span>
                        <span className="project-path-value">{match.path}</span>
                      </button>
                    )
                  })
                )}
              </div>
            </div>,
            document.body
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
                onClick={() => void onAbort().catch(() => undefined)}
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
              <button
                className="composer-start-action"
                type="button"
                disabled={!canStart}
                aria-busy={pendingAction === 'start-session' ? true : undefined}
                onClick={() => void onStartSession().catch(() => undefined)}
              >
                <span>新建对话</span>
              </button>
              <button
                className="composer-start-action"
                type="button"
                disabled={busy}
                aria-busy={pendingAction === 'activate-session' ? true : undefined}
                onClick={() => {
                  if (activeSessionKey !== null) {
                    void onActivateSession(activeSessionKey).catch(() => undefined)
                  }
                }}
              >
                <span>{runtime.status === 'crashed' ? '重启并恢复' : '恢复对话'}</span>
                <Icon name="arrow-right" size="sm" />
              </button>
            </>
          ) : canStartRuntime(runtime.status) ? (
            <button
              className="composer-start-action"
              type="button"
              disabled={!canStart}
              aria-busy={pendingAction === 'start-session' ? true : undefined}
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
            <details
              ref={modelPickerRef}
              className="composer-model-controls"
              open={modelPickerOpen}
            >
              <summary
                className="model-picker-button"
                aria-label="选择模型和思考强度"
                aria-haspopup="dialog"
                aria-expanded={modelPickerOpen}
                aria-controls={modelPickerOpen ? 'model-picker-popover' : undefined}
                onClick={(event) => {
                  // Fully control open state in React. Native <details> toggle races with
                  // portaled menus and can drop model selection clicks.
                  event.preventDefault()
                  setModelPickerOpen((open) => {
                    if (open) setModelMenuOpen(false)
                    return !open
                  })
                }}
              >
                <span className="model-summary-label">
                  {session.model?.name ?? session.model?.id ?? '选择模型'}
                </span>
                {currentThinkingLevel !== null ? (
                  <span className="model-summary-meta">
                    {thinkingOptionLabel(currentThinkingLevel)}
                  </span>
                ) : null}
              </summary>
              {modelPickerOpen && modelPickerPosition !== null
                ? createPortal(
                    <div
                      ref={modelPickerPopoverRef}
                      id="model-picker-popover"
                      className="model-picker-popover"
                      role="dialog"
                      aria-label="模型和思考强度设置"
                      data-placement={modelPickerPosition.placement}
                      style={modelPickerPosition.style}
                    >
                      <div className="model-picker-content">
                        <section className="model-picker-thinking-section" aria-label="思考强度">
                          <h3 className="model-picker-section-heading">思考强度</h3>
                          {session.model === null ? (
                            <p className="model-picker-empty" role="status">请先选择模型</p>
                          ) : session.model.reasoning === false ? (
                            <p className="model-picker-empty" role="status">
                              当前模型不支持思考强度
                            </p>
                          ) : availableThinkingLevels.length === 0 ? (
                            <p className="model-picker-empty" role="status">
                              当前模型没有可用的思考强度
                            </p>
                          ) : (
                            <div className="model-picker-thinking-list">
                              {availableThinkingLevels.map((level) => {
                                const selected = session.thinkingLevel === level
                                return (
                                  <button
                                    className={`picker-option model-picker-item${selected ? ' selected' : ''}`}
                                    type="button"
                                    key={level}
                                    aria-pressed={selected}
                                    disabled={busy || runtime.status !== 'ready'}
                                    onClick={() => {
                                      closeModelPickerAndRestoreFocus()
                                      void onSetThinkingLevel(level).catch(() => undefined)
                                    }}
                                  >
                                    <span className="model-picker-option-copy">
                                      <span className="model-picker-option-label">
                                        {thinkingOptionLabel(level)}
                                      </span>
                                      <span className="model-picker-option-meta">
                                        {thinkingLabel(level)}
                                      </span>
                                    </span>
                                    {selected
                                      ? <span className="model-picker-selected">当前</span>
                                      : null}
                                  </button>
                                )
                              })}
                            </div>
                          )}
                        </section>

                        <div className="model-picker-model-menu">
                          <button
                            ref={modelMenuTriggerRef}
                            className="model-picker-model-button"
                            type="button"
                            aria-label="选择其他模型"
                            aria-haspopup="menu"
                            aria-expanded={modelMenuOpen}
                            aria-controls={modelMenuOpen ? 'model-picker-model-popover' : undefined}
                            data-placement={modelMenuPosition?.placement ?? 'right'}
                            onClick={() => setModelMenuOpen((open) => !open)}
                          >
                            <span className="model-picker-option-copy">
                              <span className="model-picker-heading-label">模型</span>
                              <span className="model-picker-option-label">
                                {session.model?.name ?? session.model?.id ?? '选择模型'}
                              </span>
                            </span>
                            <Icon name="arrow-right" size="sm" />
                          </button>
                          {modelMenuOpen && modelMenuPosition !== null
                            ? createPortal(
                                <div
                                  ref={modelMenuPopoverRef}
                                  id="model-picker-model-popover"
                                  className="model-picker-model-popover"
                                  role="menu"
                                  aria-label="选择模型"
                                  data-placement={modelMenuPosition.placement}
                                  style={modelMenuPosition.style}
                                >
                                  {availableModels.length > 0 ? (
                                    <div className="model-picker-model-list">
                                      {availableModels.map((model) => {
                                        const selected =
                                          session.model?.provider === model.provider &&
                                          session.model.id === model.id
                                        return (
                                          <button
                                            className={`picker-option model-picker-item${selected ? ' selected' : ''}`}
                                            type="button"
                                            role="menuitemradio"
                                            key={`${model.provider}:${model.id}`}
                                            aria-checked={selected}
                                            disabled={busy || runtime.status !== 'ready'}
                                            onClick={() => {
                                              closeModelPickerAndRestoreFocus()
                                              if (!selected) {
                                                void onSetModel(model.provider, model.id).catch(() => undefined)
                                              }
                                            }}
                                          >
                                            <span className="model-picker-option-copy">
                                              <span className="model-picker-option-label">
                                                {model.name.trim() || model.id}
                                              </span>
                                              <span className="model-picker-option-meta">
                                                {model.provider}/{model.id}
                                              </span>
                                            </span>
                                            {selected
                                              ? <span className="model-picker-selected">当前</span>
                                              : null}
                                          </button>
                                        )
                                      })}
                                    </div>
                                  ) : (
                                    <p className="model-picker-empty" role="status">暂无可用模型</p>
                                  )}
                                </div>,
                                document.body
                              )
                            : null}
                        </div>
                      </div>
                    </div>,
                    document.body
                  )
                : null}
            </details>
          )}

          <ContextIndicator usage={viewingInactiveSession ? null : session.usage} />
        </div>
      </div>
    </form>
  )
}

function ContextIndicator({ usage }: { usage: KernelSessionUsage | null }): React.JSX.Element {
  const contextPercent = usage?.contextPercent ?? null
  const ringPercent = contextPercent === null ? 0 : clampPercent(contextPercent)
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
            <span className="context-tooltip-context">{contextUsageLabel(usage)}</span>
            <dl className="context-tooltip-stats">
              <dt>总输入（含缓存）</dt>
              <dd>{formatTokenCount(promptTokens)}</dd>
              <dt>缓存读取</dt>
              <dd>{formatTokenCount(usage.cacheReadTokens)}</dd>
              <dt>缓存写入</dt>
              <dd>{formatTokenCount(usage.cacheWriteTokens)}</dd>
              <dt>输出</dt>
              <dd>{formatTokenCount(usage.outputTokens)}</dd>
              <dt>缓存率</dt>
              <dd>{formatPercent(cacheRate)}</dd>
              <dt>本对话累计（USD）</dt>
              <dd>{formatUsd(usage.cost)}</dd>
            </dl>
          </>
        )}
        <span className="context-tooltip-note">
          由 Pi 按各轮实际用量累计，不是模型单价。
        </span>
      </div>
    </div>
  )
}

function contextUsageLabel(usage: KernelSessionUsage): string {
  const tokens = usage.contextTokens === null
    ? '—'
    : formatTokenCount(usage.contextTokens)
  const window = usage.contextWindow === null
    ? '—'
    : formatTokenCount(usage.contextWindow)
  const percent = formatPercent(usage.contextPercent)
  return `上下文 ${tokens} / ${window} · ${percent}`
}

function formatTokenCount(value: number | null): string {
  return value === null ? '—' : value.toLocaleString()
}

function formatPercent(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(1)}%`
}

function formatUsd(value: number): string {
  return `$${value.toFixed(value > 0 && value < 0.01 ? 4 : 2)}`
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}

function composerPlaceholder(
  state: KernelState,
  viewingInactiveSession: boolean,
  viewingNewSession: boolean,
  viewedSessionRuntimeStatus: KernelState['runtime']['status']
): string {
  if (state.activeProjectKey === null) return '先选择项目文件夹'
  if (viewingNewSession && state.runtime.status === 'crashed') return '新对话启动失败'
  if (viewingNewSession) return ''
  if (viewingInactiveSession && canChangeRuntimeContext(viewedSessionRuntimeStatus)) return ''
  if (viewedSessionRuntimeStatus === 'starting') return '正在启动 Pi…'
  if (viewedSessionRuntimeStatus === 'stopped') return '选择对话即可自动启动'
  if (viewedSessionRuntimeStatus === 'running') return 'Enter 排队，Alt+Enter 引导'
  if (viewedSessionRuntimeStatus === 'crashed') return 'Pi Runtime 已退出'
  return ''
}

function thinkingLabel(level: ThinkingLevel): string {
  return {
    off: '关闭',
    minimal: '最小',
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '极高',
    max: '最高'
  }[level]
}

function thinkingOptionLabel(level: ThinkingLevel): string {
  return {
    off: 'Off',
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra High',
    max: 'Max'
  }[level]
}

function isThinkingLevelAvailable(
  level: ThinkingLevel,
  thinkingLevelMap: Partial<Record<ThinkingLevel, string | null>>
): boolean {
  const mappedLevel = thinkingLevelMap[level]
  if (mappedLevel === null) return false
  if (level === 'xhigh' || level === 'max') return mappedLevel !== undefined
  return true
}

function commandSourceLabel(source: KernelCommandDescriptor['source']): string {
  return {
    gui: 'GUI',
    'pi-rpc': 'Pi RPC',
    extension: 'Extension',
    prompt: 'Prompt',
    skill: 'Skill'
  }[source]
}

function projectPathMatchKey(match: KernelProjectPathMatch): string {
  return `${match.kind}:${match.path}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function hasDraggedFiles(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes('Files')
}

function isRuntimeContextAction(action: string): boolean {
  return action === 'add-project' ||
    action === 'activate-project' ||
    action === 'activate-session' ||
    action === 'start-session'
}

function canChangeRuntimeContext(status: KernelState['runtime']['status']): boolean {
  return status === 'stopped' || status === 'ready' || status === 'crashed'
}

function canStartRuntime(status: KernelState['runtime']['status']): boolean {
  return status === 'stopped' || status === 'crashed'
}
