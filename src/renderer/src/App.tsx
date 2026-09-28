import { submitPromptDraft } from './features/composer/prompt-attachments'
import type { PromptDraftAttachment } from '../../shared/desktop-attachment-contract'
import { useEffect, useMemo, useRef, useState } from 'react'

import {
  COPY_LAST_ANSWER_COMMAND_ID,
  EXPORT_SESSION_COMMAND_ID,
  FORK_SESSION_COMMAND_ID,
  type AppearanceSettings,
  type GeneralSettings,
  type KernelConversationPageRequest,
  type KernelMutationAck,
  type KernelPiPackageInstallJob,
  type KernelProjectTrustChoice,
  type KernelState,
  type SessionNamingSettings,
  type SubagentSettings,
  type ShortcutSettings,
  type ThinkingLevel
} from '../../shared/kernel-contract'
import { Workbench } from './composition/Workbench'
import { ConnectHostPanel } from './features/desktop-client/ConnectHostPanel'
import { workbenchClientSurface } from './features/desktop-client/workbench-client-surface'
import type { DesktopClientStatus } from '../../shared/desktop-client-contract'
import { withDesktopPreferences, type DesktopPreferences } from '../../shared/desktop-settings-contract'
import {
  workbenchGlobalActionErrorOwner,
  workbenchOp,
  type WorkbenchActionFailure,
  type WorkbenchCompletedAction,
  type WorkbenchOperation
} from './workbench-actions'
import { IconButton } from './components/IconButton'
import { useSessionRuntimeController } from './composition/useSessionRuntimeController'
import type { ComposerDraftRequest } from './features/composer/Composer'
import {
  collectSessionLifecycleObservations,
  indexSessionLifecycles,
  reconcileBackgroundSessionNotifications,
  type BackgroundSessionNotification,
  type SessionLifecycleObservation
} from './features/session/background-session-completion'
import { awaitMutationAck as awaitKernelMutationAck } from './kernel/await-mutation-ack'
import { applyStatePatches } from './kernel/kernel-state-patches'
import { useSessionArchive } from './features/session/use-session-archive'
import { useSessionFork } from './features/session/use-session-fork'
import {
  DEFAULT_RESYNC_TIMEOUT_MS,
  KernelRevisionBarrier
} from './kernel/kernel-revision-barrier'
import { unknownErrorMessage as errorMessage } from './unknown-error-message'

/** Dwell before reading the last selected stopped historical Session. */
const SESSION_RUNTIME_SETTLE_MS = 120

export function App(): React.JSX.Element {
  const [hostState, setKernelState] = useState<KernelState | null>(null)
  const [desktopPreferences, setDesktopPreferences] = useState<DesktopPreferences | null>(null)
  const kernelState = useMemo(() => hostState === null || desktopPreferences === null ? hostState : withDesktopPreferences(hostState, desktopPreferences), [hostState, desktopPreferences])
  const appearance = desktopPreferences?.appearance ?? hostState?.appearance
  const [ipcError, setIpcError] = useState<string | null>(null)
  const [actionFailure, setActionFailure] = useState<WorkbenchActionFailure | null>(null)
  const [pendingAction, setPendingAction] = useState<WorkbenchOperation | null>(null)
  const [backgroundSessionNotifications, setBackgroundSessionNotifications] =
    useState<readonly BackgroundSessionNotification[]>([])
  const [openingBackgroundSessionIdentity, setOpeningBackgroundSessionIdentity] =
    useState<string | null>(null)
  const [composerDraftRequest, setComposerDraftRequest] =
    useState<ComposerDraftRequest | null>(null)
  const [compactionNotice, setCompactionNotice] = useState<'cancelled' | 'failed' | null>(null)
  const [systemFonts, setSystemFonts] = useState<string[] | null>(null)
  const [systemFontsError, setSystemFontsError] = useState<string | null>(null)
  const [packageInstallJobs, setPackageInstallJobs] = useState<KernelPiPackageInstallJob[]>([])
  const [completedAction, setCompletedAction] = useState<WorkbenchCompletedAction | null>(null)
  const [connectionAttempt, setConnectionAttempt] = useState(0)
  const [desktopClientStatus, setDesktopClientStatus] = useState<DesktopClientStatus | null>(null)
  const [desktopClientBusy, setDesktopClientBusy] = useState(false)
  const kernelStateRef = useRef<KernelState | null>(null)
  const revisionBarrierRef = useRef<KernelRevisionBarrier | null>(null)
  const pendingActionRef = useRef<WorkbenchOperation | null>(null)
  const sessionLifecycleByIdentityRef = useRef(
    new Map<string, SessionLifecycleObservation>()
  )
  const coldStartHandledRef = useRef(false)
  const actionPresentationRevision = useRef(0)
  const composerDraftRevision = useRef(0)

  async function awaitMutationAck<T extends KernelMutationAck>(
    operation: () => Promise<T>
  ): Promise<T> {
    return awaitKernelMutationAck(operation, revisionBarrierRef.current)
  }

  function actionFailureFor(
    action: WorkbenchOperation,
    error: unknown
  ): WorkbenchActionFailure | null {
    const owner = workbenchGlobalActionErrorOwner(action)
    return owner === null ? null : { owner, message: errorMessage(error) }
  }

  function requestWorkspaceMetadataRefresh(workspaceKey: string): void {
    const presentationRevision = actionPresentationRevision.current + 1
    actionPresentationRevision.current = presentationRevision
    void awaitMutationAck(() => window.piGui.refreshWorkspaceMetadata(workspaceKey)).then(
      () => {
        if (
          actionPresentationRevision.current !== presentationRevision ||
          kernelStateRef.current?.activeProjectKey !== workspaceKey
        ) return
        setActionFailure(null)
      },
      (error: unknown) => {
        if (
          actionPresentationRevision.current !== presentationRevision ||
          kernelStateRef.current?.activeProjectKey !== workspaceKey
        ) return
        setActionFailure({ owner: 'header', message: errorMessage(error) })
      }
    )
  }

  const {
    sessionViewTarget,
    sessionPreview,
    previewPendingKey,
    getSessionViewTarget,
    reconcileKernelState,
    selectSession,
    clearSessionView,
    startSession,
    waitForSessionStart,
    ensureInitialRuntime,
    loadEarlierSessionPreview: loadEarlierStaticSessionPreview,
    ensureSessionRuntime,
    waitForRuntimeEnsureIdle
  } = useSessionRuntimeController({
    settleMs: SESSION_RUNTIME_SETTLE_MS,
    getKernelState: () => kernelStateRef.current,
    startSession: () => awaitMutationAck(() => window.piGui.startSession()),
    activateSession: (sessionKey) =>
      awaitMutationAck(() => window.piGui.activateSession(sessionKey)),
    previewSession: (sessionKey, requestId) =>
      window.piGui.previewSession(sessionKey, requestId),
    completeSessionPreview: (requestId) => window.piGui.completeSessionPreview(requestId),
    cancelSessionPreview: (requestId) => window.piGui.cancelSessionPreview(requestId),
    loadEarlierSessionPreview: (request) => window.piGui.loadEarlierSessionPreview(request),
    beginActionPresentation: () => {
      actionPresentationRevision.current += 1
      return actionPresentationRevision.current
    },
    isActionPresentationCurrent: (revision) =>
      actionPresentationRevision.current === revision,
    onError: (error) => setActionFailure(error === null
      ? null
      : { owner: 'header', message: errorMessage(error) }),
    onCompletedAction: (action, succeeded) =>
      setCompletedAction({ action: workbenchOp(action), succeeded }),
    onClearArchivedPreview: () => clearArchivedSessionPreview()
  })
  const {
    archiveNotifications, archivedSessionPreview, archiveSession, clearArchivedSessionPreview,
    loadEarlierArchivedPreview, undoArchive, previewArchivedSession
  } = useSessionArchive({
    operations: { mutation: runActionResult, read: runPlainAction },
    waitForRuntimeEnsureIdle,
    onArchived: (sessionKey) => {
      const target = getSessionViewTarget()
      if (target?.kind === 'session' && target.sessionKey === sessionKey) clearSessionView()
    },
    onPreviewOpened: clearSessionView
  })
  const {
    forkDialogOpen, forkCandidates, forkCandidatesLoading, forkError, forkSubmitting,
    forkPreferredUserText, openForkDialog, closeForkDialog, loadForkCandidates, forkSession
  } = useSessionFork({
    getKernelState: () => kernelStateRef.current,
    getSessionViewTarget,
    ensureSessionRuntime,
    runMutation: runActionResult,
    onOpenError: (error) => setActionFailure(error === null
      ? null : { owner: 'header', message: errorMessage(error) }),
    onCompletedAction: setCompletedAction,
    onForked: (draft) => {
      clearSessionView()
      composerDraftRevision.current += 1
      setComposerDraftRequest({ id: composerDraftRevision.current, text: draft })
    }
  })
  const displayedSessionKey = sessionViewTarget?.kind === 'new'
    ? null
    : sessionViewTarget?.kind === 'session'
      ? sessionViewTarget.sessionKey
      : kernelState?.activeSessionKey ?? null
  const lifecycleProjects = kernelState?.projects ?? null
  const lifecycleActiveProjectKey = kernelState?.activeProjectKey ?? null
  const lifecycleSessions = kernelState?.sessions ?? null

  useEffect(() => {
    if (lifecycleProjects === null || lifecycleSessions === null) return
    const observations = collectSessionLifecycleObservations({
      projects: lifecycleProjects,
      activeProjectKey: lifecycleActiveProjectKey,
      sessions: lifecycleSessions
    })
    const previousByIdentity = sessionLifecycleByIdentityRef.current
    setBackgroundSessionNotifications((current) =>
      reconcileBackgroundSessionNotifications(
        current,
        displayedSessionKey,
        previousByIdentity,
        observations
      )
    )
    sessionLifecycleByIdentityRef.current = indexSessionLifecycles(observations)
  }, [
    displayedSessionKey,
    lifecycleActiveProjectKey,
    lifecycleProjects,
    lifecycleSessions
  ])

  useEffect(() => {
    let active = true
    void window.piGui.listSystemFonts().then(
      (fonts) => {
        if (!active) return
        setSystemFonts(fonts)
        setSystemFontsError(null)
      },
      (error: unknown) => {
        if (!active) return
        setSystemFontsError(errorMessage(error))
      }
    )
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    let active = true
    void window.piGui.listPiPackageInstallJobs().then(
      (jobs) => {
        if (active) setPackageInstallJobs(jobs)
      },
      () => {
        if (active) setPackageInstallJobs([])
      }
    )
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    const rootStyle = document.documentElement.style
    applySelectedFont(rootStyle, '--font-ui-selected', appearance?.uiFontFamily ?? null)
    applySelectedFont(rootStyle, '--font-code-selected', appearance?.codeFontFamily ?? null)
    const textSize = appearance?.textSize ?? 'default'
    rootStyle.setProperty('--text-root', textSize === 'small' ? '14px' : textSize === 'large' ? '16px' : '15px')
  }, [appearance])

  useEffect(() => {
    const root = document.documentElement
    root.dataset.accent = appearance?.accentColor ?? 'amber'
    root.style.setProperty(
      '--surface-transparency',
      `${appearance?.surfaceTransparency ?? 20}%`
    )
  }, [appearance?.accentColor, appearance?.surfaceTransparency])

  useEffect(() => {
    const preference = appearance?.theme ?? 'system'
    const systemTheme = window.matchMedia('(prefers-color-scheme: light)')
    const applyTheme = (): void => {
      const theme = preference === 'system'
        ? systemTheme.matches ? 'light' : 'dark'
        : preference
      document.documentElement.dataset.theme = theme
      // Electron titleBarOverlay requires #RRGGBB; keep these aligned with tokens.
      void window.piGui.setWindowChrome(
        theme === 'light'
          ? { color: '#f4f4f2', symbolColor: '#20201e' }
          : { color: '#1b1b1a', symbolColor: '#f1eee8' }
      ).catch(() => undefined)
    }

    applyTheme()
    if (preference !== 'system') return
    systemTheme.addEventListener('change', applyTheme)
    return () => systemTheme.removeEventListener('change', applyTheme)
  }, [appearance?.theme])

  useEffect(() => {
    const desktop = window.piDesktopClient
    if (!desktop?.getPreferences) return
    let active = true
    void desktop.getPreferences(hostState === null ? undefined : { appearance: hostState.appearance, shortcuts: hostState.shortcuts, doubleClickBorderMaximize: hostState.general.doubleClickBorderMaximize }).then(
      (preferences) => { if (active) setDesktopPreferences(preferences) },
      (error) => { if (active) setIpcError(errorMessage(error)) }
    )
    return () => { active = false }
    // Preferences are device-owned; initialize once on connection, not on every Host patch.
  }, [hostState === null, connectionAttempt])

  useEffect(() => {
    const desktop = window.piDesktopClient
    if (desktop === undefined) {
      setDesktopClientStatus({ mode: 'local' })
      return
    }
    let active = true
    const unsubscribe = desktop.subscribeStatus((status) => {
      if (!active) return
      setDesktopClientStatus(status)
      if (status.mode === 'windows-remote' && status.phase !== 'connected') {
        desktop.setControlIdentity(null)
        kernelStateRef.current = null
        setKernelState(null)
        coldStartHandledRef.current = false
      }
    })
    void desktop.getStatus().then(
      (status) => {
        if (active) setDesktopClientStatus(status)
      },
      (error: unknown) => {
        if (active) setIpcError(errorMessage(error))
      }
    )
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    let active = true
    let unsubscribe = (): void => undefined

    const waitingForDesktopHost = desktopClientStatus === null ||
      (desktopClientStatus.mode === 'windows-remote' && desktopClientStatus.phase !== 'connected')
    if (waitingForDesktopHost) {
      return
    }

    const barrier = new KernelRevisionBarrier({
      applyState: (state, meta) => {
        if (!active) return
        window.piDesktopClient?.setControlIdentity({
          projectKey: state.activeProjectKey,
          sessionKey: state.activeSessionKey
        })
        kernelStateRef.current = state
        setKernelState(state)
        reconcileKernelState(state, meta.initializing)
      },
      applyPatches: (state, patches) =>
        applyStatePatches(state, patches.map((entry) => entry.patch)),
      fetchSnapshot: () => window.piGui.getState(),
      scheduleFrame: (callback) => requestAnimationFrame(callback),
      cancelFrame: (handle) => cancelAnimationFrame(handle as number),
      onRecoveryError: (error) => {
        if (!active) return
        setIpcError(errorMessage(error))
      }
    })
    revisionBarrierRef.current = barrier

    try {
      unsubscribe = window.piGui.subscribe((event) => {
        if (!active) return
        try {
          if (event.type === 'kernel.pi-package-install') {
            setPackageInstallJobs((current) => [
              ...current.filter(({ id }) => id !== event.job.id),
              event.job
            ].slice(-32))
          }
          barrier.handleEvent(event)
          if (
            event.type === 'kernel.compaction-ended' &&
            event.outcome !== 'retrying'
          ) {
            const state = kernelStateRef.current
            if (
              state?.activeProjectKey === event.projectKey &&
              state.activeSessionKey === event.sessionKey &&
              (event.outcome === 'failed' || event.outcome === 'cancelled')
            ) {
              setCompactionNotice(event.outcome)
            }
          }
          setIpcError(null)
        } catch (error: unknown) {
          setIpcError(errorMessage(error))
        }
      })

      void (async () => {
        let timeoutHandle: number | null = null
        try {
          const snapshot = await Promise.race([
            window.piGui.getState(),
            new Promise<never>((_, reject) => {
              timeoutHandle = window.setTimeout(() => {
                reject(
                  new Error(
                    `Kernel snapshot timed out after ${DEFAULT_RESYNC_TIMEOUT_MS}ms.`
                  )
                )
              }, DEFAULT_RESYNC_TIMEOUT_MS)
            })
          ])
          if (!active) return
          barrier.handleSnapshot(snapshot)
          setIpcError(null)
        } catch (error: unknown) {
          if (!active) return
          setIpcError(errorMessage(error))
        } finally {
          if (timeoutHandle !== null) window.clearTimeout(timeoutHandle)
        }
      })()
    } catch (error: unknown) {
      setIpcError(errorMessage(error))
    }

    return () => {
      active = false
      if (revisionBarrierRef.current === barrier) revisionBarrierRef.current = null
      barrier.dispose()
      unsubscribe()
    }
  }, [connectionAttempt, desktopClientStatus])

  useEffect(() => {
    if (coldStartHandledRef.current || kernelState === null) return
    coldStartHandledRef.current = true
    void ensureInitialRuntime().catch(() => undefined)
  }, [kernelState])

  async function runActionResult<T extends KernelMutationAck>(
    action: WorkbenchOperation,
    operation: () => Promise<T>,
    exclusive = true
  ): Promise<T> {
    if (exclusive) {
      if (pendingActionRef.current !== null) throw new Error('Another action is already running.')
      pendingActionRef.current = action
      setPendingAction(action)
    }
    const globalErrorOwner = workbenchGlobalActionErrorOwner(action)
    const presentationRevision = globalErrorOwner === null
      ? null
      : actionPresentationRevision.current + 1
    if (presentationRevision !== null) actionPresentationRevision.current = presentationRevision
    setActionFailure(null)
    let succeeded = false
    try {
      // Mutating invokes return a narrow ack. Settle only after the ack revision is applied.
      const result = await awaitMutationAck(operation)
      succeeded = true
      return result
    } catch (error) {
      if (
        globalErrorOwner !== null &&
        presentationRevision !== null &&
        actionPresentationRevision.current === presentationRevision
      ) {
        setActionFailure({ owner: globalErrorOwner, message: errorMessage(error) })
      }
      throw error
    } finally {
      if (
        presentationRevision !== null &&
        actionPresentationRevision.current === presentationRevision
      ) {
        setCompletedAction({ action, succeeded })
      }
      if (exclusive) {
        pendingActionRef.current = null
        setPendingAction(null)
      }
    }
  }

  async function runAction(
    action: WorkbenchOperation,
    operation: () => Promise<KernelMutationAck>,
    exclusive = true
  ): Promise<void> {
    await runActionResult(action, operation, exclusive)
  }

  /** Domain/catalog operations that intentionally do not return KernelMutationAck. */
  async function runPlainAction(
    action: WorkbenchOperation,
    operation: () => Promise<unknown>,
    exclusive = true
  ): Promise<void> {
    if (exclusive) {
      if (pendingActionRef.current !== null) throw new Error('Another action is already running.')
      pendingActionRef.current = action
      setPendingAction(action)
    }
    const globalErrorOwner = workbenchGlobalActionErrorOwner(action)
    const presentationRevision = globalErrorOwner === null
      ? null
      : actionPresentationRevision.current + 1
    if (presentationRevision !== null) actionPresentationRevision.current = presentationRevision
    setActionFailure(null)
    let succeeded = false
    try {
      await operation()
      succeeded = true
    } catch (error) {
      if (
        globalErrorOwner !== null &&
        presentationRevision !== null &&
        actionPresentationRevision.current === presentationRevision
      ) {
        setActionFailure({ owner: globalErrorOwner, message: errorMessage(error) })
      }
      throw error
    } finally {
      if (
        presentationRevision !== null &&
        actionPresentationRevision.current === presentationRevision
      ) {
        setCompletedAction({ action, succeeded })
      }
      if (exclusive) {
        pendingActionRef.current = null
        setPendingAction(null)
      }
    }
  }

  async function exportSession(): Promise<void> {
    if (pendingActionRef.current !== null) throw new Error('Another action is already running.')
    const action = workbenchOp('export-session')
    const viewTarget = getSessionViewTarget()
    const targetSessionKey = viewTarget?.kind === 'session'
      ? viewTarget.sessionKey
      : kernelStateRef.current?.activeSessionKey ?? null
    setCompletedAction(null)
    pendingActionRef.current = action
    setPendingAction(action)
    setActionFailure(null)
    try {
      if (viewTarget?.kind === 'session') {
        await ensureSessionRuntime(viewTarget.sessionKey, 'immediate')
      }
      if (
        targetSessionKey === null ||
        kernelStateRef.current?.activeSessionKey !== targetSessionKey ||
        getSessionViewTarget() !== null
      ) {
        throw new Error('导出目标在操作前发生了变化。')
      }
      const result = await window.piGui.exportSession()
      if (result.saved) {
        setCompletedAction({ action, succeeded: true })
      }
    } catch (error) {
      setActionFailure(actionFailureFor(action, error))
      setCompletedAction({ action, succeeded: false })
    } finally {
      pendingActionRef.current = null
      setPendingAction(null)
    }
  }

  async function copyAnswer(text: string): Promise<void> {
    if (pendingActionRef.current !== null) throw new Error('Another action is already running.')
    const answer = text.trim()
    if (answer.length === 0) throw new Error('当前对话暂时没有可复制的最终回答。')

    const action = workbenchOp('copy-last-answer')
    setCompletedAction(null)
    pendingActionRef.current = action
    setPendingAction(action)
    setActionFailure(null)
    try {
      await navigator.clipboard.writeText(text)
      setCompletedAction({ action, succeeded: true })
    } catch (error) {
      setActionFailure(actionFailureFor(action, error))
      setCompletedAction({ action, succeeded: false })
      throw error
    } finally {
      pendingActionRef.current = null
      setPendingAction(null)
    }
  }

  async function loadEarlierConversation(): Promise<void> {
    if (await loadEarlierArchivedPreview()) return
    if (getSessionViewTarget()?.kind === 'session') {
      await loadEarlierStaticSessionPreview()
      return
    }

    const state = kernelStateRef.current
    const firstEntry = state?.conversation.entries[0]
    if (
      state === null ||
      state.activeProjectKey === null ||
      state.activeSessionKey === null ||
      state.session.id === null ||
      state.conversation.startIndex <= 0 ||
      firstEntry === undefined ||
      getSessionViewTarget() !== null
    ) {
      throw new Error('当前对话没有可加载的更早历史。')
    }
    const request: KernelConversationPageRequest = {
      projectKey: state.activeProjectKey,
      sessionKey: state.activeSessionKey,
      sessionId: state.session.id,
      beforeIndex: state.conversation.startIndex,
      beforeEntryId: firstEntry.id
    }
    const page = await window.piGui.loadEarlierConversation(request)
    const barrier = revisionBarrierRef.current
    const current = barrier?.getState() ?? null
    if (
      current === null ||
      current.activeProjectKey !== request.projectKey ||
      current.activeSessionKey !== request.sessionKey ||
      current.session.id !== request.sessionId
    ) {
      throw new Error('Conversation page response is stale after a Session switch.')
    }
    barrier!.mergeConversationPage(page)
  }

  async function copyLastAnswer(): Promise<void> {
    const state = kernelStateRef.current
    if (
      state === null ||
      state.activeProjectKey === null ||
      state.activeSessionKey === null ||
      state.session.id === null ||
      state.runtime.status !== 'ready' ||
      !state.session.settled ||
      getSessionViewTarget() !== null
    ) {
      throw new Error('当前对话暂时没有可复制的最终回答。')
    }
    const identity = {
      projectKey: state.activeProjectKey,
      sessionKey: state.activeSessionKey,
      sessionId: state.session.id
    }
    const answer = await window.piGui.getLastAssistantFinalAnswer()
    const current = kernelStateRef.current
    if (
      answer.projectKey !== identity.projectKey ||
      answer.sessionKey !== identity.sessionKey ||
      answer.sessionId !== identity.sessionId ||
      current?.activeProjectKey !== identity.projectKey ||
      current.activeSessionKey !== identity.sessionKey ||
      current.session.id !== identity.sessionId
    ) {
      throw new Error('Final answer response is stale after a Session switch.')
    }
    if (answer.text === null) throw new Error('当前对话暂时没有可复制的最终回答。')
    await copyAnswer(answer.text)
  }

  async function navigateHistoryPrompt(
    sessionKey: string,
    messageId: string
  ): Promise<void> {
    await runAction(
      workbenchOp('edit-history-prompt'),
      () => window.piGui.navigateHistoryPrompt(sessionKey, messageId)
    )
  }

  async function invokeCommand(commandId: string, argument: string): Promise<void> {
    if (
      commandId === FORK_SESSION_COMMAND_ID ||
      commandId === EXPORT_SESSION_COMMAND_ID ||
      commandId === COPY_LAST_ANSWER_COMMAND_ID
    ) {
      if (argument.trim().length > 0) {
        const commandName = commandId === FORK_SESSION_COMMAND_ID
          ? 'fork'
          : commandId === EXPORT_SESSION_COMMAND_ID ? 'export' : 'copy'
        throw new Error(`/${commandName} 不接受参数。`)
      }
      if (commandId === FORK_SESSION_COMMAND_ID) {
        await openForkDialog()
        return
      }
      if (commandId === EXPORT_SESSION_COMMAND_ID) {
        await exportSession()
        return
      }
      await copyLastAnswer()
      return
    }

    await runAction(workbenchOp('invoke-command'), () => window.piGui.invokeCommand(commandId, argument))
  }

  function removeBackgroundSessionNotification(identity: string): void {
    setBackgroundSessionNotifications((current) =>
      current.filter((notification) => notification.identity !== identity)
    )
  }

  async function openBackgroundSessionNotification(
    notification: BackgroundSessionNotification
  ): Promise<void> {
    if (pendingActionRef.current !== null || openingBackgroundSessionIdentity !== null) return
    setOpeningBackgroundSessionIdentity(notification.identity)
    setActionFailure(null)
    clearArchivedSessionPreview()
    try {
      await waitForRuntimeEnsureIdle()
      if (kernelStateRef.current?.activeProjectKey !== notification.projectKey) {
        if (notification.workspaceKind === 'task') {
          if (notification.taskKey === null) {
            throw new Error('Background Task notification is missing its Task identity.')
          }
          await runAction(
            workbenchOp('activate-task'),
            () => window.piGui.activateTask(notification.taskKey!)
          )
        } else {
          await runAction(
            workbenchOp('activate-project'),
            () => window.piGui.activateProject(notification.projectKey)
          )
        }
        clearSessionView()
        requestWorkspaceMetadataRefresh(notification.projectKey)
      }
      const targetState = kernelStateRef.current
      if (
        targetState?.activeProjectKey === notification.projectKey &&
        targetState.activeSessionKey === notification.sessionKey
      ) {
        clearSessionView()
      }
      await ensureSessionRuntime(notification.sessionKey, 'immediate')
      removeBackgroundSessionNotification(notification.identity)
    } finally {
      setOpeningBackgroundSessionIdentity((current) =>
        current === notification.identity ? null : current
      )
    }
  }

  async function resolveProjectTrust(
    requestId: string,
    choice: KernelProjectTrustChoice
  ): Promise<void> {
    await runAction(
      workbenchOp('resolve-project-trust'),
      () => window.piGui.resolveProjectTrust(requestId, choice)
    )
  }

  async function saveGeneralSettings(settings: GeneralSettings): Promise<void> {
    if (!window.piDesktopClient?.setPreferences || hostState === null) return runAction(workbenchOp('set-general'), () => window.piGui.setGeneral(settings))
    await runPlainAction(workbenchOp('set-general'), async () => {
      const shared = { ...settings, doubleClickBorderMaximize: hostState.general.doubleClickBorderMaximize }
      if (JSON.stringify(shared) !== JSON.stringify(hostState.general)) await awaitMutationAck(() => window.piGui.setGeneral(shared))
      setDesktopPreferences(await window.piDesktopClient!.setPreferences({ doubleClickBorderMaximize: settings.doubleClickBorderMaximize }))
    })
  }

  async function setShortcuts(settings: ShortcutSettings): Promise<void> {
    if (!window.piDesktopClient?.setPreferences) return runAction(workbenchOp('set-shortcuts'), () => window.piGui.setShortcuts(settings))
    await runPlainAction(workbenchOp('set-shortcuts'), async () => {
      setDesktopPreferences(await window.piDesktopClient!.setPreferences({ shortcuts: settings }))
    })
  }

  if (
    desktopClientStatus?.mode === 'windows-remote' &&
    desktopClientStatus.phase !== 'connected'
  ) {
    return (
      <ConnectHostPanel
        status={desktopClientStatus}
        busy={desktopClientBusy || desktopClientStatus.phase === 'connecting'}
        error={ipcError}
        onConnect={async (request) => {
          const desktop = window.piDesktopClient
          if (desktop === undefined) throw new Error('Desktop client API is unavailable.')
          setDesktopClientBusy(true)
          setIpcError(null)
          try {
            await desktop.connect(request)
            const status = await desktop.getStatus()
            setDesktopClientStatus(status)
            setConnectionAttempt((attempt) => attempt + 1)
          } finally {
            setDesktopClientBusy(false)
          }
        }}
      />
    )
  }

  if (kernelState === null) {
    if (ipcError !== null) {
      return (
        <main className="screen-loading error">
          <div className="kernel-connection-error" role="alert">
            <span>无法连接 Workbench Kernel：{ipcError}</span>
            <button
              type="button"
              onClick={() => {
                setIpcError(null)
                setConnectionAttempt((attempt) => attempt + 1)
              }}
            >
              重试
            </button>
          </div>
        </main>
      )
    }
    return (
      <main className="screen-loading">
        正在连接 Pi Workbench…
      </main>
    )
  }

  const operationNotifications =
    archiveNotifications.length === 0 &&
      backgroundSessionNotifications.length === 0 &&
      compactionNotice === null
      ? null
      : (
      <section
        className="archive-notification-region"
        aria-label="操作通知"
        aria-live="polite"
        aria-relevant="additions removals"
      >
        {backgroundSessionNotifications.map((notification) => {
          const opening = openingBackgroundSessionIdentity === notification.identity
          return (
            <article
              className="archive-notification"
              key={`background-session:${notification.identity}`}
              aria-busy={opening}
            >
              <div className="archive-notification-copy">
                <strong>{notification.sessionName?.trim() || (
                  notification.workspaceKind === 'task' ? '后台任务' : '后台对话'
                )}</strong>
                <span>
                  {notification.outcome === 'completed'
                    ? '后台工作已完成，结果保留在原对话中。'
                    : '后台工作异常结束，请返回原对话查看。'}
                </span>
              </div>
              <div className="archive-notification-actions">
                <button
                  type="button"
                  disabled={pendingAction !== null || openingBackgroundSessionIdentity !== null}
                  onClick={() => {
                    void openBackgroundSessionNotification(notification).catch(() => undefined)
                  }}
                >
                  {opening ? '正在打开…' : '查看'}
                </button>
                <IconButton
                  className="archive-notification-dismiss"
                  icon="close"
                  iconSize="sm"
                  label="关闭后台完成通知"
                  disabled={opening}
                  onClick={() => removeBackgroundSessionNotification(notification.identity)}
                />
              </div>
            </article>
          )
        })}
        {archiveNotifications.map((notification) => (
          <article
            className="archive-notification"
            key={notification.receipt.token}
            aria-busy={notification.pending !== null}
          >
            <div className="archive-notification-copy">
              <strong>
                {notification.receipt.sessionName?.trim() ||
                  `对话 ${notification.receipt.sessionKey.split(/[\\/]/).at(-1) ?? ''}`}
              </strong>
              <span>已归档，可在短时间内撤销或临时查看</span>
            </div>
            <div className="archive-notification-actions">
              <button
                type="button"
                disabled={notification.pending !== null}
                onClick={() => void undoArchive(notification.receipt.token).catch(() => undefined)}
              >
                {notification.pending === 'undo' ? '撤销中…' : '撤销'}
              </button>
              <button
                type="button"
                disabled={notification.pending !== null}
                onClick={() => void previewArchivedSession(notification.receipt.token).catch(() => undefined)}
              >
                {notification.pending === 'preview' ? '读取中…' : '临时查看'}
              </button>
            </div>
          </article>
        ))}
        {compactionNotice === null ? null : (
          <article className="archive-notification">
            <div className="archive-notification-copy">
              <strong>上下文整理未完成</strong>
              <span>
                {compactionNotice === 'cancelled'
                  ? '上下文整理已取消，对话内容保持不变。'
                  : '上下文整理失败，对话内容保持不变。'}
              </span>
            </div>
            <div className="archive-notification-actions">
              <IconButton
                className="archive-notification-dismiss"
                icon="close"
                iconSize="sm"
                label="关闭通知"
                onClick={() => setCompactionNotice(null)}
              />
            </div>
          </article>
        )}
      </section>
    )

  return (
    <Workbench
      state={kernelState}
      clientSurface={workbenchClientSurface(desktopClientStatus)}
      sessionPreview={sessionPreview}
      archivedSessionPreview={archivedSessionPreview?.preview ?? null}
      composerDraftRequest={composerDraftRequest}
      viewedSessionKey={
        sessionViewTarget?.kind === 'session' ? sessionViewTarget.sessionKey : null
      }
      viewingNewSession={sessionViewTarget?.kind === 'new'}
      newSessionPrepared={
        sessionViewTarget?.kind === 'new' && sessionViewTarget.prepared
      }
      sessionPreviewPending={
        sessionViewTarget?.kind === 'session' &&
        previewPendingKey === sessionViewTarget.sessionKey
      }
      pendingAction={pendingAction}
      completedAction={completedAction}
      actionFailure={actionFailure ?? (ipcError === null
        ? null
        : { owner: 'header', message: ipcError })}
      operationNotifications={operationNotifications}
      systemFonts={systemFonts}
      systemFontsError={systemFontsError}
      packageInstallJobs={packageInstallJobs}
      forkDialogOpen={forkDialogOpen}
      forkCandidates={forkCandidates}
      forkCandidatesLoading={forkCandidatesLoading}
      forkError={forkError}
      forkSubmitting={forkSubmitting}
      forkPreferredUserText={forkPreferredUserText}
      onDisconnectHost={desktopClientStatus?.mode === 'windows-remote'
        ? async () => {
            const desktop = window.piDesktopClient
            if (desktop === undefined) throw new Error('Desktop client API is unavailable.')
            await desktop.disconnect()
          }
        : undefined}
      connectedHostAlias={desktopClientStatus?.mode === 'windows-remote' ? desktopClientStatus.lastHost?.sshHostAlias : undefined}
      onRevokeHostPairing={desktopClientStatus?.mode === 'windows-remote' && desktopClientStatus.lastHost !== null
        ? async () => {
            const desktop = window.piDesktopClient
            if (desktop === undefined) throw new Error('Desktop client API is unavailable.')
            await desktop.revokePairing(desktopClientStatus.lastHost!)
          }
        : undefined}
      onAddProject={async (projectPath) => {
        clearArchivedSessionPreview()
        await waitForRuntimeEnsureIdle()
        await runAction(workbenchOp('add-project'), () => window.piGui.addProject(projectPath))
      }}
      onActivateProject={async (projectKey) => {
        clearArchivedSessionPreview()
        await waitForRuntimeEnsureIdle()
        await runAction(
          workbenchOp('activate-project'),
          () => window.piGui.activateProject(projectKey)
        )
        clearSessionView()
        requestWorkspaceMetadataRefresh(projectKey)
      }}
      onCreateTask={async () => {
        clearArchivedSessionPreview()
        await waitForRuntimeEnsureIdle()
        await runAction(workbenchOp('create-task'), () => window.piGui.createTask())
        await startSession()
      }}
      onActivateTask={async (taskKey, sessionKey) => {
        clearArchivedSessionPreview()
        await waitForRuntimeEnsureIdle()
        await runAction(
          workbenchOp('activate-task'),
          () => window.piGui.activateTask(taskKey)
        )
        clearSessionView()
        const workspaceKey = kernelStateRef.current?.activeProjectKey ?? null
        if (workspaceKey !== null) requestWorkspaceMetadataRefresh(workspaceKey)
        await ensureSessionRuntime(sessionKey, 'immediate')
      }}
      onStartSession={startSession}
      onReloadSession={() =>
        runAction(workbenchOp('reload-session'), () => window.piGui.reloadSession())}
      onWaitForSessionStart={waitForSessionStart}
      onResolveProjectTrust={resolveProjectTrust}
      onActivateSession={(sessionKey) => ensureSessionRuntime(sessionKey, 'immediate')}
      onEnsureSessionRuntime={ensureSessionRuntime}
      onSelectSession={selectSession}
      onClearSessionPreview={clearSessionView}
      onClearArchivedSessionPreview={() => clearArchivedSessionPreview()}
      onOpenForkDialog={openForkDialog}
      onCloseForkDialog={closeForkDialog}
      onRetryForkCandidates={() => void loadForkCandidates()}
      onForkSession={forkSession}
      onExportSession={exportSession}
      onLoadEarlierConversation={loadEarlierConversation}
      onCopyAnswer={copyAnswer}
      onCopyLastAnswer={copyLastAnswer}
      onArchiveSession={archiveSession}
      onReorderProjects={(projectKeys) =>
        runAction(
          workbenchOp('reorder-projects'),
          () => window.piGui.reorderProjects(projectKeys)
        )
      }
      onInstallExtension={(kind) =>
        runAction(workbenchOp('install-extension'), () => window.piGui.installExtension(kind))
      }
      onRemoveExtension={(path) =>
        runAction(workbenchOp('remove-extension'), () => window.piGui.removeExtension(path))
      }
      onSearchPiDevExtensions={(query) => window.piGui.searchPiDevExtensions(query)}
      onSearchPiDevPackages={(query) => window.piGui.searchPiDevPackages(query)}
      onListPiPackages={() => window.piGui.listPiPackages()}
      onListSubagentDefinitions={() => window.piGui.listSubagentDefinitions()}
      onSaveSubagentDefinition={(definition) => window.piGui.saveSubagentDefinition(definition)}
      onSetSubagentDefinitionEnabled={(id, scope, enabled) =>
        window.piGui.setSubagentDefinitionEnabled(id, scope, enabled)}
      onRemoveSubagentDefinition={(id) => window.piGui.removeSubagentDefinition(id)}
      onInstallPiDevPackage={(name) =>
        runAction(
          workbenchOp('install-pi-dev-package'),
          () => window.piGui.installPiDevPackage(name)
        )
      }
      onRemovePiPackage={(source) =>
        runAction(workbenchOp('remove-pi-package'), () => window.piGui.removePiPackage(source))
      }
      onUpdatePiPackage={(source) =>
        runAction(workbenchOp('update-pi-package'), () => window.piGui.updatePiPackage(source))
      }
      onUpdatePiPackages={() =>
        runAction(workbenchOp('update-pi-packages'), () => window.piGui.updatePiPackages())
      }
      onOpenExternal={(url) => window.piGui.openExternal(url)}
      onListProviders={window.piGui.listProviders}
      onSaveProvider={window.piGui.saveProvider}
      onRemoveProvider={window.piGui.removeProvider}
      onTestProvider={window.piGui.testProvider}
      onFetchModelPricing={window.piGui.fetchModelPricing}
      onListProviderCredentials={window.piGui.listProviderCredentials}
      onLoginProvider={window.piGui.loginProvider}
      onSubmitProviderAuthPrompt={window.piGui.submitProviderAuthPrompt}
      onCancelProviderLogin={window.piGui.cancelProviderLogin}
      onLogoutProvider={window.piGui.logoutProvider}
      onSubscribeProviderAuth={window.piGui.subscribeProviderAuth}
      onGetRemoteAccessStatus={window.piRemote.getStatus}
      onCreateRemotePairingCode={window.piRemote.createPairingCode}
      onRevokeRemoteDevice={window.piRemote.revokeDevice}
      onGetTailscaleStatus={window.piRemote.getTailscaleStatus}
      onEnableTailscaleFunnel={window.piRemote.enableTailscaleFunnel}
      onEnableTailscaleServe={window.piRemote.enableTailscaleServe}
      onDisableTailscale={window.piRemote.disableTailscale}
      onGetDesktopHostStatus={window.piRemote.getDesktopHostStatus}
      onCreateDesktopHostPairingCode={window.piRemote.createDesktopHostPairingCode}
      onRevokeDesktopHostDevice={window.piRemote.revokeDesktopHostDevice}
      onSelectPromptAttachments={() => window.piGui.selectPromptAttachments()}
      onSearchProjectPaths={(query) => window.piGui.searchProjectPaths(query)}
      onSubmitAsk={(sessionKey, toolCallId, answers) =>
        runAction(
          workbenchOp('submit-ask'),
          () => window.piGui.submitAsk(sessionKey, toolCallId, answers),
          false
        )}
      onCancelAsk={(sessionKey, toolCallId) =>
        runAction(
          workbenchOp('cancel-ask'),
          () => window.piGui.cancelAsk(sessionKey, toolCallId),
          false
        )}
      onRespondExtensionDialog={async (request, value) => {
        await awaitMutationAck(() => window.piGui.respondExtensionDialog(
          request.projectKey,
          request.sessionKey,
          request.sessionId,
          request.requestId,
          request.commandInvocationId,
          value
        ))
      }}
      onCancelExtensionDialog={async (request) => {
        await awaitMutationAck(() => window.piGui.cancelExtensionDialog(
          request.projectKey,
          request.sessionKey,
          request.sessionId,
          request.requestId,
          request.commandInvocationId
        ))
      }}
      onPrompt={(
        message,
        attachments?: PromptDraftAttachment[],
        expectedSessionKey?: string
      ) => runAction(
        workbenchOp('prompt'),
        () => submitPromptDraft('prompt', message, attachments, expectedSessionKey),
        false
      )}
      onNavigateHistoryPrompt={navigateHistoryPrompt}
      onSteer={(message, attachments?: PromptDraftAttachment[]) =>
        runAction(
          workbenchOp('steer'),
          () => submitPromptDraft('steer', message, attachments),
          false
        )}
      onFollowUp={(message, attachments?: PromptDraftAttachment[]) =>
        runAction(
          workbenchOp('follow-up'),
          () => submitPromptDraft('follow-up', message, attachments),
          false
        )}
      onInvokeCommand={invokeCommand}
      onAbort={() => runAction(workbenchOp('abort'), () => window.piGui.abort(), false)}
      onSetModel={(provider, modelId, origin) =>
        runAction(
          workbenchOp('set-model', origin),
          () => window.piGui.setModel(provider, modelId)
        )
      }
      onSetThinkingLevel={(level: ThinkingLevel) =>
        runAction(
          workbenchOp('set-thinking-level'),
          () => window.piGui.setThinkingLevel(level)
        )
      }
      onSetOpenAiFastMode={(enabled) =>
        runAction(
          workbenchOp('set-openai-fast-mode'),
          () => window.piGui.setOpenAiFastMode(enabled)
        )
      }
      onSetSessionNaming={(settings: SessionNamingSettings) =>
        runAction(
          workbenchOp('set-session-naming'),
          () => window.piGui.setSessionNaming(settings)
        )
      }
      onSetGeneral={(settings: GeneralSettings) =>
        saveGeneralSettings(settings)
      }
      onSetSubagentEnabled={(enabled) =>
        runPlainAction(
          workbenchOp('set-subagent-enabled'),
          () => window.piGui.setSubagentEnabled(enabled)
        )
      }
      onSetMagicContextEnabled={(enabled) =>
        runPlainAction(
          workbenchOp('set-magic-context-enabled'),
          () => window.piGui.setMagicContextEnabled(enabled)
        )
      }
      onSetSubagent={(settings: SubagentSettings) =>
        runAction(workbenchOp('set-subagent'), () => window.piGui.setSubagent(settings))
      }
      onSetAppearance={(settings: AppearanceSettings) =>
        window.piDesktopClient?.setPreferences
          ? runPlainAction(workbenchOp('set-appearance'), async () => { setDesktopPreferences(await window.piDesktopClient!.setPreferences({ appearance: settings })) })
          : runAction(workbenchOp('set-appearance'), () => window.piGui.setAppearance(settings))
      }
      onSetShortcuts={setShortcuts}
    />
  )
}

function applySelectedFont(
  style: CSSStyleDeclaration,
  property: '--font-ui-selected' | '--font-code-selected',
  fontFamily: string | null
): void {
  if (fontFamily === null) style.removeProperty(property)
  else style.setProperty(property, `${JSON.stringify(fontFamily)},`)
}
