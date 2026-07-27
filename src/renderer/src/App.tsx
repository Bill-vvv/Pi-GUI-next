import { useEffect, useRef, useState } from 'react'

import {
  COPY_LAST_ANSWER_COMMAND_ID,
  EXPORT_SESSION_COMMAND_ID,
  FORK_SESSION_COMMAND_ID,
  type AppearanceSettings,
  type GeneralSettings,
  type KernelArchiveReceipt,
  type KernelForkCandidate,
  type KernelProjectTrustChoice,
  type KernelPromptAttachment,
  type KernelSessionPreview,
  type KernelStatePatch,
  type KernelState,
  type SessionNamingSettings,
  type SubagentSettings,
  type ShortcutSettings,
  type ThinkingLevel
} from '../../shared/kernel-contract'
import { Workbench } from './composition/Workbench'
import { useSessionRuntimeController } from './composition/useSessionRuntimeController'
import type { ComposerDraftRequest } from './features/composer/Composer'
import { applyStatePatches } from './kernel/kernel-state-patches'
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
  const [actionError, setActionError] = useState<string | null>(null)
  const [pendingAction, setPendingAction] = useState<string | null>(null)
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
  const [completedAction, setCompletedAction] = useState<{
    action: string
    succeeded: boolean
  } | null>(null)
  const [connectionAttempt, setConnectionAttempt] = useState(0)
  const kernelStateRef = useRef<KernelState | null>(null)
  const pendingActionRef = useRef<string | null>(null)
  const coldStartHandledRef = useRef(false)
  const eventRevision = useRef(0)
  const actionPresentationRevision = useRef(0)
  const forkRequestRevision = useRef(0)
  const composerDraftRevision = useRef(0)
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
    getEventRevision: () => eventRevision.current,
    startSession: () => window.piGui.startSession(),
    activateSession: (sessionKey) => window.piGui.activateSession(sessionKey),
    previewSession: (sessionKey) => window.piGui.previewSession(sessionKey),
    applyReturnedState: (state, revisionBeforeAction) => {
      if (eventRevision.current !== revisionBeforeAction) return false
      kernelStateRef.current = state
      setKernelState(state)
      return true
    },
    beginActionPresentation: () => {
      actionPresentationRevision.current += 1
      return actionPresentationRevision.current
    },
    isActionPresentationCurrent: (revision) =>
      actionPresentationRevision.current === revision,
    onError: (error) => setActionError(error === null ? null : errorMessage(error)),
    onCompletedAction: (action, succeeded) => setCompletedAction({ action, succeeded }),
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
    let pendingPatches: KernelStatePatch[] = []
    let framePatches: KernelStatePatch[] = []
    let renderFrame: number | null = null
    let unsubscribe = (): void => undefined

    const commitImmediately = (state: KernelState): void => {
      const initializing = kernelStateRef.current === null
      if (renderFrame !== null) {
        cancelAnimationFrame(renderFrame)
        renderFrame = null
      }
      framePatches = []
      kernelStateRef.current = state
      setKernelState(state)
      reconcileKernelState(state, initializing)
    }

    const schedulePatch = (patch: KernelStatePatch): void => {
      framePatches.push(patch)
      if (renderFrame !== null) return
      renderFrame = requestAnimationFrame(() => {
        renderFrame = null
        const state = kernelStateRef.current
        const patches = framePatches
        framePatches = []
        if (!active || state === null) return
        const nextState = applyStatePatches(state, patches)
        kernelStateRef.current = nextState
        setKernelState(nextState)
      })
    }

    try {
      unsubscribe = window.piGui.subscribe((event) => {
        if (!active) return
        if (event.type === 'kernel.state-changed') {
          eventRevision.current += 1
          pendingPatches = []
          commitImmediately(event.state)
        } else if (event.type === 'kernel.state-patched') {
          eventRevision.current += 1
          const state = kernelStateRef.current
          if (state === null) pendingPatches.push(event.patch)
          else schedulePatch(event.patch)
        } else if (
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
      })

      void window.piGui.getState().then(
        (state) => {
          if (!active) return
          if (kernelStateRef.current !== null) return
          const initialized = applyStatePatches(state, pendingPatches)
          pendingPatches = []
          commitImmediately(initialized)
          setIpcError(null)
        },
        (error: unknown) => {
          if (!active) return
          setIpcError(errorMessage(error))
        }
      )
    } catch (error: unknown) {
      setIpcError(errorMessage(error))
    }

    return () => {
      active = false
      if (renderFrame !== null) cancelAnimationFrame(renderFrame)
      unsubscribe()
    }
  }, [connectionAttempt])

  useEffect(() => {
    if (coldStartHandledRef.current || kernelState === null) return
    coldStartHandledRef.current = true
    void ensureInitialRuntime().catch(() => undefined)
  }, [kernelState])

  async function runAction(
    action: string,
    operation: () => Promise<KernelState>,
    exclusive = true
  ): Promise<void> {
    if (exclusive) {
      if (pendingActionRef.current !== null) throw new Error('Another action is already running.')
      pendingActionRef.current = action
      setPendingAction(action)
    }
    const presentationRevision = actionPresentationRevision.current + 1
    actionPresentationRevision.current = presentationRevision
    setActionError(null)
    let succeeded = false
    const revisionBeforeAction = eventRevision.current
    try {
      const state: unknown = await operation()
      assertKernelState(state)
      if (eventRevision.current === revisionBeforeAction) {
        kernelStateRef.current = state
        setKernelState(state)
        reconcileKernelState(state)
      }
      succeeded = true
    } catch (error) {
      if (actionPresentationRevision.current === presentationRevision) {
        setActionError(errorMessage(error))
      }
      throw error
    } finally {
      if (actionPresentationRevision.current === presentationRevision) {
        setCompletedAction({ action, succeeded })
      }
      if (exclusive) {
        pendingActionRef.current = null
        setPendingAction(null)
      }
    }
  }

  function applyReturnedState(state: KernelState, revisionBeforeAction: number): void {
    if (eventRevision.current !== revisionBeforeAction) return
    kernelStateRef.current = state
    setKernelState(state)
    reconcileKernelState(state)
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
      setActionError('当前对话暂时不能分叉。')
      return
    }
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
    setCompletedAction(null)
    pendingActionRef.current = 'fork-session'
    setPendingAction('fork-session')
    setForkSubmitting(true)
    setForkError(null)
    setActionError(null)
    const revisionBeforeAction = eventRevision.current
    try {
      const result = await window.piGui.forkSession(entryId)
      if (result.cancelled) {
        closeForkDialog()
        return
      }
      applyReturnedState(result.state, revisionBeforeAction)
      clearSessionView()
      composerDraftRevision.current += 1
      setComposerDraftRequest({
        id: composerDraftRevision.current,
        text: result.draft
      })
      closeForkDialog()
      setCompletedAction({ action: 'fork-session', succeeded: true })
    } catch (error) {
      setForkError(errorMessage(error))
      setCompletedAction({ action: 'fork-session', succeeded: false })
      throw error
    } finally {
      pendingActionRef.current = null
      setPendingAction(null)
      setForkSubmitting(false)
    }
  }

  async function exportSession(): Promise<void> {
    if (pendingActionRef.current !== null) throw new Error('Another action is already running.')
    setCompletedAction(null)
    pendingActionRef.current = 'export-session'
    setPendingAction('export-session')
    setActionError(null)
    try {
      const result = await window.piGui.exportSession()
      if (result.saved) {
        setCompletedAction({ action: 'export-session', succeeded: true })
      }
    } catch (error) {
      setActionError(errorMessage(error))
      setCompletedAction({ action: 'export-session', succeeded: false })
    } finally {
      pendingActionRef.current = null
      setPendingAction(null)
    }
  }

  async function copyAnswer(text: string): Promise<void> {
    if (pendingActionRef.current !== null) throw new Error('Another action is already running.')
    const answer = text.trim()
    if (answer.length === 0) throw new Error('当前对话暂时没有可复制的最终回答。')

    setCompletedAction(null)
    pendingActionRef.current = 'copy-last-answer'
    setPendingAction('copy-last-answer')
    setActionError(null)
    try {
      await navigator.clipboard.writeText(text)
      setCompletedAction({ action: 'copy-last-answer', succeeded: true })
    } catch (error) {
      setActionError(errorMessage(error))
      setCompletedAction({ action: 'copy-last-answer', succeeded: false })
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

    await runAction('invoke-command', () => window.piGui.invokeCommand(commandId, argument))
  }

  async function archiveSession(sessionKey: string): Promise<void> {
    if (pendingActionRef.current !== null) throw new Error('Another action is already running.')
    pendingActionRef.current = 'archive-session'
    setPendingAction('archive-session')
    setActionError(null)
    setArchivedSessionPreview(null)
    let succeeded = false
    try {
      await waitForRuntimeEnsureIdle()
      const revisionBeforeAction = eventRevision.current
      const result = await window.piGui.archiveSession(sessionKey)
      applyReturnedState(result.state, revisionBeforeAction)
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
      setActionError(errorMessage(error))
      throw error
    } finally {
      setCompletedAction({ action: 'archive-session', succeeded })
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
    setActionError(null)
    try {
      await waitForRuntimeEnsureIdle()
      const revisionBeforeAction = eventRevision.current
      const state = await window.piGui.undoArchiveSession(token)
      applyReturnedState(state, revisionBeforeAction)
      removeArchiveNotification(token)
      setCompletedAction({ action: 'undo-archive-session', succeeded: true })
    } catch (error) {
      removeArchiveNotification(token)
      setActionError(errorMessage(error))
      setCompletedAction({ action: 'undo-archive-session', succeeded: false })
    }
  }

  async function previewArchivedSession(notification: ArchiveNotification): Promise<void> {
    const { token } = notification.receipt
    if (notification.expiresAt <= Date.now() || notification.pending !== null) {
      removeArchiveNotification(token)
      return
    }
    setArchiveNotificationPending(token, 'preview')
    setActionError(null)
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
      setCompletedAction({ action: 'preview-archived-session', succeeded: true })
    } catch (error) {
      removeArchiveNotification(token)
      setActionError(errorMessage(error))
      setCompletedAction({ action: 'preview-archived-session', succeeded: false })
    }
  }

  async function resolveProjectTrust(
    requestId: string,
    choice: KernelProjectTrustChoice
  ): Promise<void> {
    const revisionBeforeAction = eventRevision.current
    const state = await window.piGui.resolveProjectTrust(requestId, choice)
    if (eventRevision.current === revisionBeforeAction) {
      kernelStateRef.current = state
      setKernelState(state)
    }
  }

  async function setShortcuts(settings: ShortcutSettings): Promise<void> {
    const revisionBeforeAction = eventRevision.current
    const state = await window.piGui.setShortcuts(settings)
    applyReturnedState(state, revisionBeforeAction)
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
    archiveNotifications.length === 0 && compactionNotice === null ? null : (
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
              <button type="button" onClick={() => setCompactionNotice(null)}>关闭</button>
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
      actionError={actionError ?? ipcError}
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
        await runAction('add-project', () => window.piGui.addProject())
      }}
      onActivateProject={async (projectKey) => {
        setArchivedSessionPreview(null)
        await waitForRuntimeEnsureIdle()
        await runAction('activate-project', () => window.piGui.activateProject(projectKey))
        clearSessionView()
      }}
      onStartSession={startSession}
      onReloadSession={() =>
        runAction('reload-session', () => window.piGui.reloadSession())}
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
        runAction('reorder-projects', () => window.piGui.reorderProjects(projectKeys))
      }
      onInstallExtension={(kind) =>
        runAction('install-extension', () => window.piGui.installExtension(kind))
      }
      onRemoveExtension={(path) =>
        runAction('remove-extension', () => window.piGui.removeExtension(path))
      }
      onSearchPiDevExtensions={(query) => window.piGui.searchPiDevExtensions(query)}
      onSearchPiDevPackages={(query) => window.piGui.searchPiDevPackages(query)}
      onListPiPackages={() => window.piGui.listPiPackages()}
      onListAdvisorDefinitions={() => window.piGui.listAdvisorDefinitions()}
      onSaveAdvisorDefinition={(definition) => window.piGui.saveAdvisorDefinition(definition)}
      onRemoveAdvisorDefinition={(slug, scope) =>
        window.piGui.removeAdvisorDefinition(slug, scope)}
      onListSubagentDefinitions={() => window.piGui.listSubagentDefinitions()}
      onSaveSubagentDefinition={(definition) => window.piGui.saveSubagentDefinition(definition)}
      onSetSubagentDefinitionEnabled={(id, scope, enabled) =>
        window.piGui.setSubagentDefinitionEnabled(id, scope, enabled)}
      onRemoveSubagentDefinition={(id) => window.piGui.removeSubagentDefinition(id)}
      onInstallPiDevPackage={(name) =>
        runAction('install-pi-dev-package', () => window.piGui.installPiDevPackage(name))
      }
      onRemovePiPackage={(source) =>
        runAction('remove-pi-package', () => window.piGui.removePiPackage(source))
      }
      onUpdatePiPackage={(source) =>
        runAction('update-pi-package', () => window.piGui.updatePiPackage(source))
      }
      onUpdatePiPackages={() =>
        runAction('update-pi-packages', () => window.piGui.updatePiPackages())
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
      onPrompt={(message, attachments?: KernelPromptAttachment[]) =>
        runAction('prompt', () => window.piGui.prompt(message, attachments), false)}
      onSteer={(message, attachments?: KernelPromptAttachment[]) =>
        runAction('steer', () => window.piGui.steer(message, attachments), false)}
      onFollowUp={(message, attachments?: KernelPromptAttachment[]) =>
        runAction('follow-up', () => window.piGui.followUp(message, attachments), false)}
      onInvokeCommand={invokeCommand}
      onAbort={() => runAction('abort', () => window.piGui.abort(), false)}
      onSetModel={(provider, modelId) =>
        runAction('set-model', () => window.piGui.setModel(provider, modelId))
      }
      onSetThinkingLevel={(level: ThinkingLevel) =>
        runAction('set-thinking-level', () => window.piGui.setThinkingLevel(level))
      }
      onSetSessionNaming={(settings: SessionNamingSettings) =>
        runAction('set-session-naming', () => window.piGui.setSessionNaming(settings))
      }
      onSetGeneral={(settings: GeneralSettings) =>
        runAction('set-general', () => window.piGui.setGeneral(settings))
      }
      onSetSubagentEnabled={(enabled) =>
        runAction('set-subagent-enabled', async () => {
          await window.piGui.setSubagentEnabled(enabled)
          return window.piGui.getState()
        })
      }
      onSetMagicContextEnabled={(enabled) =>
        runAction('set-magic-context-enabled', async () => {
          await window.piGui.setMagicContextEnabled(enabled)
          return window.piGui.getState()
        })
      }
      onSetAdvisorSystemEnabled={(enabled) =>
        runAction(
          'set-advisor-system-enabled',
          () => window.piGui.setAdvisorSystemEnabled(enabled)
        )
      }
      onSetAdvisorExtensionEnabled={async (enabled) => {
        await window.piGui.setAdvisorExtensionEnabled(enabled)
      }}
      onSetSubagent={(settings: SubagentSettings) =>
        runAction('set-subagent', async () => {
          await window.piGui.setSubagent(settings)
          return window.piGui.getState()
        })
      }
      onSetAppearance={(settings: AppearanceSettings) =>
        runAction('set-appearance', () => window.piGui.setAppearance(settings))
      }
      onSetShortcuts={setShortcuts}
    />
  )
}

function assertKernelState(value: unknown): asserts value is KernelState {
  const state = value as Partial<KernelState> | null
  if (
    state === null ||
    typeof state !== 'object' ||
    !Array.isArray(state.projects) ||
    !Array.isArray(state.sessions) ||
    state.runtime === null ||
    typeof state.runtime !== 'object' ||
    state.conversation === null ||
    typeof state.conversation !== 'object'
  ) {
    throw new Error('Pi GUI 返回了无效状态，请重启应用以同步 Main 与 preload。')
  }
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
