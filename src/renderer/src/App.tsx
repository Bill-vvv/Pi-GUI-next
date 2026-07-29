import { useEffect, useRef, useState } from 'react'

import {
  COPY_LAST_ANSWER_COMMAND_ID,
  EXPORT_SESSION_COMMAND_ID,
  FORK_SESSION_COMMAND_ID,
  type AppearanceSettings,
  type GeneralSettings,
  type KernelArchiveReceipt,
  type KernelForkCandidate,
  type KernelMutationAck,
  type KernelProjectTrustChoice,
  type KernelPromptAttachment,
  type KernelSessionPreview,
  type KernelState,
  type SessionNamingSettings,
  type SubagentSettings,
  type ShortcutSettings,
  type ThinkingLevel
} from '../../shared/kernel-contract'
import { Workbench } from './composition/Workbench'
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
import { awaitMutationAck as awaitKernelMutationAck } from './kernel/await-mutation-ack'
import { applyStatePatches } from './kernel/kernel-state-patches'
import {
  DEFAULT_RESYNC_TIMEOUT_MS,
  KernelRevisionBarrier
} from './kernel/kernel-revision-barrier'
import { unknownErrorMessage as errorMessage } from './unknown-error-message'

/** Dwell before starting a stopped historical Session after the last click. */
const SESSION_RUNTIME_SETTLE_MS = 120

type ArchiveNotification = {
  receipt: KernelArchiveReceipt
  expiresAt: number
  pending: 'undo' | 'preview' | null
}

type ArchivedSessionPreview = {
  preview: KernelSessionPreview
  expiresAt: number
}

export function App(): React.JSX.Element {
  const [kernelState, setKernelState] = useState<KernelState | null>(null)
  const [ipcError, setIpcError] = useState<string | null>(null)
  const [actionFailure, setActionFailure] = useState<WorkbenchActionFailure | null>(null)
  const [pendingAction, setPendingAction] = useState<WorkbenchOperation | null>(null)
  const [archivedSessionPreview, setArchivedSessionPreview] =
    useState<ArchivedSessionPreview | null>(null)
  const [archiveNotifications, setArchiveNotifications] =
    useState<ArchiveNotification[]>([])
  const [forkDialogOpen, setForkDialogOpen] = useState(false)
  const [forkCandidates, setForkCandidates] = useState<KernelForkCandidate[]>([])
  const [forkCandidatesLoading, setForkCandidatesLoading] = useState(false)
  const [forkError, setForkError] = useState<string | null>(null)
  const [forkSubmitting, setForkSubmitting] = useState(false)
  const [forkPreferredUserText, setForkPreferredUserText] = useState<string | null>(null)
  const [composerDraftRequest, setComposerDraftRequest] =
    useState<ComposerDraftRequest | null>(null)
  const [compactionNotice, setCompactionNotice] = useState<'cancelled' | 'failed' | null>(null)
  const [systemFonts, setSystemFonts] = useState<string[] | null>(null)
  const [systemFontsError, setSystemFontsError] = useState<string | null>(null)
  const [completedAction, setCompletedAction] = useState<WorkbenchCompletedAction | null>(null)
  const [connectionAttempt, setConnectionAttempt] = useState(0)
  const kernelStateRef = useRef<KernelState | null>(null)
  const revisionBarrierRef = useRef<KernelRevisionBarrier | null>(null)
  const pendingActionRef = useRef<WorkbenchOperation | null>(null)
  const coldStartHandledRef = useRef(false)
  const actionPresentationRevision = useRef(0)
  const forkRequestRevision = useRef(0)
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

  const {
    sessionViewTarget,
    sessionPreview,
    previewPendingKey,
    getSessionViewTarget,
    reconcileKernelState,
    previewSession,
    clearSessionView,
    startSession,
    waitForSessionStart,
    ensureInitialRuntime,
    ensureSessionRuntime,
    waitForRuntimeEnsureIdle
  } = useSessionRuntimeController({
    settleMs: SESSION_RUNTIME_SETTLE_MS,
    getKernelState: () => kernelStateRef.current,
    startSession: () => awaitMutationAck(() => window.piGui.startSession()),
    activateSession: (sessionKey) =>
      awaitMutationAck(() => window.piGui.activateSession(sessionKey)),
    previewSession: (sessionKey) => window.piGui.previewSession(sessionKey),
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
    onClearArchivedPreview: () => setArchivedSessionPreview(null)
  })

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
    if (archiveNotifications.length === 0) return
    const nextExpiry = Math.min(...archiveNotifications.map(({ expiresAt }) => expiresAt))
    const timeout = window.setTimeout(() => {
      const now = Date.now()
      setArchiveNotifications((current) =>
        current.filter(({ expiresAt }) => expiresAt > now)
      )
    }, Math.max(0, nextExpiry - Date.now()))
    return () => window.clearTimeout(timeout)
  }, [archiveNotifications])

  useEffect(() => {
    if (archivedSessionPreview === null) return
    const timeout = window.setTimeout(() => {
      setArchivedSessionPreview(null)
    }, Math.max(0, archivedSessionPreview.expiresAt - Date.now()))
    return () => window.clearTimeout(timeout)
  }, [archivedSessionPreview])

  useEffect(() => {
    const rootStyle = document.documentElement.style
    applySelectedFont(rootStyle, '--font-ui-selected', kernelState?.appearance.uiFontFamily ?? null)
    applySelectedFont(rootStyle, '--font-code-selected', kernelState?.appearance.codeFontFamily ?? null)
    const textSize = kernelState?.appearance.textSize ?? 'default'
    rootStyle.setProperty('--text-root', textSize === 'small' ? '14px' : textSize === 'large' ? '16px' : '15px')
  }, [kernelState?.appearance])

  useEffect(() => {
    const root = document.documentElement
    root.dataset.accent = kernelState?.appearance.accentColor ?? 'amber'
    root.style.setProperty(
      '--surface-transparency',
      `${kernelState?.appearance.surfaceTransparency ?? 20}%`
    )
  }, [kernelState?.appearance.accentColor, kernelState?.appearance.surfaceTransparency])

  useEffect(() => {
    const preference = kernelState?.appearance.theme ?? 'system'
    const systemTheme = window.matchMedia('(prefers-color-scheme: light)')
    const applyTheme = (): void => {
      document.documentElement.dataset.theme = preference === 'system'
        ? systemTheme.matches ? 'light' : 'dark'
        : preference
    }

    applyTheme()
    if (preference !== 'system') return
    systemTheme.addEventListener('change', applyTheme)
    return () => systemTheme.removeEventListener('change', applyTheme)
  }, [kernelState?.appearance.theme])

  useEffect(() => {
    let active = true
    let unsubscribe = (): void => undefined

    const barrier = new KernelRevisionBarrier({
      applyState: (state, meta) => {
        if (!active) return
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
  }, [connectionAttempt])

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

  function closeForkDialog(): void {
    forkRequestRevision.current += 1
    setForkDialogOpen(false)
    setForkCandidates([])
    setForkCandidatesLoading(false)
    setForkError(null)
    setForkSubmitting(false)
    setForkPreferredUserText(null)
  }

  async function loadForkCandidates(): Promise<void> {
    const requestRevision = forkRequestRevision.current + 1
    forkRequestRevision.current = requestRevision
    setForkCandidatesLoading(true)
    setForkError(null)
    try {
      const candidates = await window.piGui.listForkCandidates()
      if (forkRequestRevision.current !== requestRevision) return
      setForkCandidates(candidates)
    } catch (error) {
      if (forkRequestRevision.current !== requestRevision) return
      setForkCandidates([])
      setForkError(errorMessage(error))
    } finally {
      if (forkRequestRevision.current === requestRevision) setForkCandidatesLoading(false)
    }
  }

  function openForkDialog(preferredUserText?: string): void {
    const state = kernelStateRef.current
    if (
      state === null ||
      state.activeSessionKey === null ||
      state.runtime.status !== 'ready' ||
      !state.session.settled ||
      getSessionViewTarget() !== null
    ) {
      setActionFailure({ owner: 'header', message: '当前对话暂时不能分叉。' })
      return
    }
    setActionFailure(null)
    setForkPreferredUserText(
      preferredUserText !== undefined && preferredUserText.trim().length > 0
        ? preferredUserText
        : null
    )
    setForkDialogOpen(true)
    setForkCandidates([])
    void loadForkCandidates()
  }

  async function forkSession(entryId: string): Promise<void> {
    if (forkSubmitting || !forkCandidates.some((candidate) => candidate.entryId === entryId)) return
    if (pendingActionRef.current !== null) throw new Error('Another action is already running.')
    const action = workbenchOp('fork-session')
    setCompletedAction(null)
    pendingActionRef.current = action
    setPendingAction(action)
    setForkSubmitting(true)
    setForkError(null)
    setActionFailure(null)
    try {
      const result = await awaitMutationAck(() => window.piGui.forkSession(entryId))
      if (result.cancelled) {
        closeForkDialog()
        return
      }
      // Domain draft is safe once the ack revision has been applied to Kernel state.
      clearSessionView()
      composerDraftRevision.current += 1
      setComposerDraftRequest({
        id: composerDraftRevision.current,
        text: result.draft
      })
      closeForkDialog()
      setCompletedAction({ action, succeeded: true })
    } catch (error) {
      setForkError(errorMessage(error))
      setCompletedAction({ action, succeeded: false })
      throw error
    } finally {
      pendingActionRef.current = null
      setPendingAction(null)
      setForkSubmitting(false)
    }
  }

  async function exportSession(): Promise<void> {
    if (pendingActionRef.current !== null) throw new Error('Another action is already running.')
    const action = workbenchOp('export-session')
    setCompletedAction(null)
    pendingActionRef.current = action
    setPendingAction(action)
    setActionFailure(null)
    try {
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

  async function copyLastAnswer(): Promise<void> {
    const state = kernelStateRef.current
    if (
      state === null ||
      state.activeSessionKey === null ||
      state.runtime.status !== 'ready' ||
      !state.session.settled ||
      getSessionViewTarget() !== null
    ) {
      throw new Error('当前对话暂时没有可复制的最终回答。')
    }
    const answer = lastAssistantFinalAnswer(state)
    if (answer === null) throw new Error('当前对话暂时没有可复制的最终回答。')
    await copyAnswer(answer)
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
        openForkDialog()
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

  async function archiveSession(sessionKey: string): Promise<void> {
    if (pendingActionRef.current !== null) throw new Error('Another action is already running.')
    const action = workbenchOp('archive-session')
    pendingActionRef.current = action
    setPendingAction(action)
    setActionFailure(null)
    setArchivedSessionPreview(null)
    let succeeded = false
    try {
      await waitForRuntimeEnsureIdle()
      const result = await awaitMutationAck(() => window.piGui.archiveSession(sessionKey))
      const expiresAt = Date.now() + result.receipt.durationMs
      setArchiveNotifications((current) => [
        ...current.filter(({ receipt }) => receipt.token !== result.receipt.token),
        { receipt: result.receipt, expiresAt, pending: null }
      ])
      const viewTarget = getSessionViewTarget()
      if (viewTarget?.kind === 'session' && viewTarget.sessionKey === sessionKey) {
        clearSessionView()
      }
      succeeded = true
    } catch (error) {
      setActionFailure(actionFailureFor(action, error))
      throw error
    } finally {
      setCompletedAction({ action, succeeded })
      pendingActionRef.current = null
      setPendingAction(null)
    }
  }

  function setArchiveNotificationPending(
    token: string,
    pending: ArchiveNotification['pending']
  ): void {
    setArchiveNotifications((current) => current.map((notification) =>
      notification.receipt.token === token
        ? { ...notification, pending }
        : notification
    ))
  }

  function removeArchiveNotification(token: string): void {
    setArchiveNotifications((current) =>
      current.filter(({ receipt }) => receipt.token !== token)
    )
  }

  async function undoArchive(notification: ArchiveNotification): Promise<void> {
    const { token } = notification.receipt
    if (notification.expiresAt <= Date.now() || notification.pending !== null) {
      removeArchiveNotification(token)
      return
    }
    setArchiveNotificationPending(token, 'undo')
    setActionFailure(null)
    try {
      await waitForRuntimeEnsureIdle()
      await awaitMutationAck(() => window.piGui.undoArchiveSession(token))
      removeArchiveNotification(token)
      setCompletedAction({ action: workbenchOp('undo-archive-session'), succeeded: true })
    } catch (error) {
      removeArchiveNotification(token)
      const action = workbenchOp('undo-archive-session')
      setActionFailure(actionFailureFor(action, error))
      setCompletedAction({ action, succeeded: false })
    }
  }

  async function previewArchivedSession(notification: ArchiveNotification): Promise<void> {
    const { token } = notification.receipt
    if (notification.expiresAt <= Date.now() || notification.pending !== null) {
      removeArchiveNotification(token)
      return
    }
    setArchiveNotificationPending(token, 'preview')
    setActionFailure(null)
    try {
      const preview = await window.piGui.previewArchivedSession(token)
      removeArchiveNotification(token)
      clearSessionView()
      if (notification.expiresAt > Date.now()) {
        setArchivedSessionPreview({
          preview,
          expiresAt: notification.expiresAt
        })
      }
      setCompletedAction({ action: workbenchOp('preview-archived-session'), succeeded: true })
    } catch (error) {
      removeArchiveNotification(token)
      const action = workbenchOp('preview-archived-session')
      setActionFailure(actionFailureFor(action, error))
      setCompletedAction({ action, succeeded: false })
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

  async function setShortcuts(settings: ShortcutSettings): Promise<void> {
    await runAction(workbenchOp('set-shortcuts'), () => window.piGui.setShortcuts(settings))
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
      compactionNotice === null
      ? null
      : (
      <section
        className="archive-notification-region"
        aria-label="操作通知"
        aria-live="polite"
        aria-relevant="additions removals"
      >
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
                onClick={() => void undoArchive(notification)}
              >
                {notification.pending === 'undo' ? '撤销中…' : '撤销'}
              </button>
              <button
                type="button"
                disabled={notification.pending !== null}
                onClick={() => void previewArchivedSession(notification)}
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
      forkDialogOpen={forkDialogOpen}
      forkCandidates={forkCandidates}
      forkCandidatesLoading={forkCandidatesLoading}
      forkError={forkError}
      forkSubmitting={forkSubmitting}
      forkPreferredUserText={forkPreferredUserText}
      onAddProject={async () => {
        setArchivedSessionPreview(null)
        await waitForRuntimeEnsureIdle()
        await runAction(workbenchOp('add-project'), () => window.piGui.addProject())
      }}
      onActivateProject={async (projectKey) => {
        setArchivedSessionPreview(null)
        await waitForRuntimeEnsureIdle()
        await runAction(
          workbenchOp('activate-project'),
          () => window.piGui.activateProject(projectKey)
        )
        clearSessionView()
      }}
      onSelectNavigator={async (kind) => {
        setArchivedSessionPreview(null)
        await waitForRuntimeEnsureIdle()
        await runAction(
          workbenchOp('select-navigator'),
          () => window.piGui.selectNavigator(kind)
        )
        clearSessionView()
        const sessionKey = kernelStateRef.current?.activeSessionKey ?? null
        if (sessionKey !== null) await ensureSessionRuntime(sessionKey, 'immediate')
      }}
      onCreateTask={async () => {
        setArchivedSessionPreview(null)
        await waitForRuntimeEnsureIdle()
        await runAction(workbenchOp('create-task'), () => window.piGui.createTask())
        await startSession()
      }}
      onActivateTask={async (taskKey, sessionKey) => {
        setArchivedSessionPreview(null)
        await waitForRuntimeEnsureIdle()
        await runAction(
          workbenchOp('activate-task'),
          () => window.piGui.activateTask(taskKey)
        )
        clearSessionView()
        await ensureSessionRuntime(sessionKey, 'immediate')
      }}
      onStartSession={startSession}
      onReloadSession={() =>
        runAction(workbenchOp('reload-session'), () => window.piGui.reloadSession())}
      onWaitForSessionStart={waitForSessionStart}
      onResolveProjectTrust={resolveProjectTrust}
      onActivateSession={(sessionKey) => ensureSessionRuntime(sessionKey, 'immediate')}
      onEnsureSessionRuntime={ensureSessionRuntime}
      onPreviewSession={previewSession}
      onClearSessionPreview={clearSessionView}
      onClearArchivedSessionPreview={() => setArchivedSessionPreview(null)}
      onOpenForkDialog={openForkDialog}
      onCloseForkDialog={closeForkDialog}
      onRetryForkCandidates={() => void loadForkCandidates()}
      onForkSession={forkSession}
      onExportSession={exportSession}
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
      onPrompt={(
        message,
        attachments?: KernelPromptAttachment[],
        expectedSessionKey?: string
      ) => runAction(
        workbenchOp('prompt'),
        () => window.piGui.prompt(message, attachments, expectedSessionKey),
        false
      )}
      onNavigateHistoryPrompt={navigateHistoryPrompt}
      onSteer={(message, attachments?: KernelPromptAttachment[]) =>
        runAction(
          workbenchOp('steer'),
          () => window.piGui.steer(message, attachments),
          false
        )}
      onFollowUp={(message, attachments?: KernelPromptAttachment[]) =>
        runAction(
          workbenchOp('follow-up'),
          () => window.piGui.followUp(message, attachments),
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
      onSetSessionNaming={(settings: SessionNamingSettings) =>
        runAction(
          workbenchOp('set-session-naming'),
          () => window.piGui.setSessionNaming(settings)
        )
      }
      onSetGeneral={(settings: GeneralSettings) =>
        runAction(workbenchOp('set-general'), () => window.piGui.setGeneral(settings))
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
        runAction(workbenchOp('set-appearance'), () => window.piGui.setAppearance(settings))
      }
      onSetShortcuts={setShortcuts}
    />
  )
}

function lastAssistantFinalAnswer(state: KernelState): string | null {
  for (let index = state.conversation.entries.length - 1; index >= 0; index -= 1) {
    const entry = state.conversation.entries[index]
    if (
      entry.kind === 'message' &&
      entry.role === 'assistant' &&
      !entry.streaming &&
      (entry.phase === 'final_answer' || entry.phase == null) &&
      entry.text.trim().length > 0
    ) {
      return entry.text
    }
  }
  return null
}

function applySelectedFont(
  style: CSSStyleDeclaration,
  property: '--font-ui-selected' | '--font-code-selected',
  fontFamily: string | null
): void {
  if (fontFamily === null) style.removeProperty(property)
  else style.setProperty(property, `${JSON.stringify(fontFamily)},`)
}
