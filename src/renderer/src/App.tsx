import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

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
import type { ComposerDraftRequest } from './features/composer/Composer'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type SessionViewTarget =
  | {
      kind: 'session'
      projectKey: string
      sessionKey: string
    }
  | {
      kind: 'new'
      projectKey: string
      prepared: boolean
      sawProvisional: boolean
    }

type RuntimeEnsureTarget =
  | { kind: 'session'; sessionKey: string }
  | { kind: 'new' }

type RuntimeEnsureWaiter = {
  target: RuntimeEnsureTarget
  resolve: () => void
  reject: (error: unknown) => void
}

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
  const [sessionPreview, setSessionPreview] = useState<KernelSessionPreview | null>(null)
  const [archivedSessionPreview, setArchivedSessionPreview] =
    useState<ArchivedSessionPreview | null>(null)
  const [archiveNotifications, setArchiveNotifications] =
    useState<ArchiveNotification[]>([])
  const [forkDialogOpen, setForkDialogOpen] = useState(false)
  const [forkCandidates, setForkCandidates] = useState<KernelForkCandidate[]>([])
  const [forkCandidatesLoading, setForkCandidatesLoading] = useState(false)
  const [forkError, setForkError] = useState<string | null>(null)
  const [forkSubmitting, setForkSubmitting] = useState(false)
  const [composerDraftRequest, setComposerDraftRequest] =
    useState<ComposerDraftRequest | null>(null)
  const [compactionNotice, setCompactionNotice] = useState<'cancelled' | 'failed' | null>(null)
  const [sessionViewTarget, setSessionViewTarget] = useState<SessionViewTarget | null>(null)
  const [previewPendingKey, setPreviewPendingKey] = useState<string | null>(null)
  const [systemFonts, setSystemFonts] = useState<string[] | null>(null)
  const [systemFontsError, setSystemFontsError] = useState<string | null>(null)
  const [completedAction, setCompletedAction] = useState<{
    action: string
    succeeded: boolean
  } | null>(null)
  const [connectionAttempt, setConnectionAttempt] = useState(0)
  const kernelStateRef = useRef<KernelState | null>(null)
  const pendingActionRef = useRef<string | null>(null)
  const sessionViewTargetRef = useRef<SessionViewTarget | null>(null)
  const previewRequestRevision = useRef(0)
  const coldStartHandledRef = useRef(false)
  const eventRevision = useRef(0)
  const actionPresentationRevision = useRef(0)
  const forkRequestRevision = useRef(0)
  const composerDraftRevision = useRef(0)
  const desiredRuntimeEnsureRef = useRef<RuntimeEnsureTarget | null>(null)
  const executingRuntimeEnsureRef = useRef<RuntimeEnsureTarget | null>(null)
  const runtimeEnsureGenerationRef = useRef(0)
  const runtimeEnsureTimerRef = useRef<number | null>(null)
  const runtimeEnsurePumpRef = useRef<Promise<void> | null>(null)
  const runtimeEnsureWaitersRef = useRef<RuntimeEnsureWaiter[]>([])

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
      const nextTarget = initializing && state.activeProjectKey !== null
        ? {
            kind: 'new' as const,
            projectKey: state.activeProjectKey,
            prepared: false,
            sawProvisional: state.activeSessionKey === null
          }
        : keepValidSessionViewTarget(sessionViewTargetRef.current, state)
      sessionViewTargetRef.current = nextTarget
      setSessionViewTarget(nextTarget)
      setSessionPreview((preview) => keepValidPreview(preview, state))
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
    if (
      kernelState.activeProjectKey === null ||
      kernelState.runtime.status !== 'stopped' ||
      sessionViewTargetRef.current?.kind !== 'new'
    ) return
    void startSession().catch(() => undefined)
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
      const state = await operation()
      if (eventRevision.current === revisionBeforeAction) {
        kernelStateRef.current = state
        setKernelState(state)
        const nextTarget = keepValidSessionViewTarget(sessionViewTargetRef.current, state)
        sessionViewTargetRef.current = nextTarget
        setSessionViewTarget(nextTarget)
        setSessionPreview((preview) => keepValidPreview(preview, state))
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

  async function previewSession(sessionKey: string): Promise<void> {
    setArchivedSessionPreview(null)
    const state = kernelStateRef.current
    if (state?.activeProjectKey === null || state?.activeProjectKey === undefined) {
      throw new Error('No active project is available.')
    }
    const requestRevision = previewRequestRevision.current + 1
    previewRequestRevision.current = requestRevision
    const target: SessionViewTarget = {
      kind: 'session',
      projectKey: state.activeProjectKey,
      sessionKey
    }
    sessionViewTargetRef.current = target
    setSessionViewTarget(target)
    setSessionPreview(null)
    setPreviewPendingKey(sessionKey)
    setActionError(null)
    try {
      const preview = await window.piGui.previewSession(sessionKey)
      if (
        previewRequestRevision.current !== requestRevision ||
        sessionViewTargetRef.current?.kind !== 'session' ||
        sessionViewTargetRef.current.sessionKey !== sessionKey
      ) return
      setSessionPreview(preview)
    } catch (error) {
      if (previewRequestRevision.current !== requestRevision) return
      setActionError(errorMessage(error))
      throw error
    } finally {
      if (previewRequestRevision.current === requestRevision) setPreviewPendingKey(null)
    }
  }

  function clearSessionView(): void {
    previewRequestRevision.current += 1
    sessionViewTargetRef.current = null
    setSessionViewTarget(null)
    setSessionPreview(null)
    setArchivedSessionPreview(null)
    setPreviewPendingKey(null)
    setActionError(null)
  }

  function runtimeEnsureTargetsEqual(
    left: RuntimeEnsureTarget | null,
    right: RuntimeEnsureTarget | null
  ): boolean {
    if (left === null || right === null) return left === right
    if (left.kind === 'new' || right.kind === 'new') {
      return left.kind === 'new' && right.kind === 'new'
    }
    return left.sessionKey === right.sessionKey
  }

  function settleRuntimeEnsureWaiters(
    predicate: (target: RuntimeEnsureTarget) => boolean,
    error?: unknown
  ): void {
    const remaining: RuntimeEnsureWaiter[] = []
    for (const waiter of runtimeEnsureWaitersRef.current) {
      if (!predicate(waiter.target)) {
        remaining.push(waiter)
        continue
      }
      if (error === undefined) waiter.resolve()
      else waiter.reject(error)
    }
    runtimeEnsureWaitersRef.current = remaining
  }

  function supersedeRuntimeEnsureWaiters(next: RuntimeEnsureTarget | null): void {
    const remaining: RuntimeEnsureWaiter[] = []
    for (const waiter of runtimeEnsureWaitersRef.current) {
      if (runtimeEnsureTargetsEqual(waiter.target, next)) {
        remaining.push(waiter)
        continue
      }
      if (
        executingRuntimeEnsureRef.current !== null &&
        runtimeEnsureTargetsEqual(waiter.target, executingRuntimeEnsureRef.current)
      ) {
        remaining.push(waiter)
        continue
      }
      waiter.reject(new Error('Session activation superseded.'))
    }
    runtimeEnsureWaitersRef.current = remaining
  }

  function sessionRuntimeAlreadyUsable(sessionKey: string): boolean {
    const state = kernelStateRef.current
    if (state === null || state.activeSessionKey !== sessionKey) return false
    const summary = state.sessions.find((session) => session.key === sessionKey)
    const status = summary?.runtimeStatus ?? state.runtime.status
    return (
      status === 'ready' ||
      status === 'running' ||
      status === 'starting' ||
      status === 'stopping'
    )
  }

  async function performStartSession(): Promise<void> {
    const presentationRevision = actionPresentationRevision.current + 1
    actionPresentationRevision.current = presentationRevision
    setActionError(null)
    const revisionBeforeAction = eventRevision.current
    try {
      const state = await window.piGui.startSession()
      applyReturnedState(state, revisionBeforeAction)
      const target = sessionViewTargetRef.current
      if (target?.kind === 'new') {
        const preparedTarget = { ...target, prepared: true }
        const nextTarget = kernelStateRef.current === null
          ? preparedTarget
          : keepValidSessionViewTarget(preparedTarget, kernelStateRef.current)
        sessionViewTargetRef.current = nextTarget
        setSessionViewTarget(nextTarget)
      }
      if (actionPresentationRevision.current === presentationRevision) {
        setCompletedAction({ action: 'start-session', succeeded: true })
      }
    } catch (error) {
      if (actionPresentationRevision.current === presentationRevision) {
        setActionError(errorMessage(error))
        setCompletedAction({ action: 'start-session', succeeded: false })
      }
      throw error
    }
  }

  async function performActivateSession(sessionKey: string): Promise<void> {
    setArchivedSessionPreview(null)
    const presentationRevision = actionPresentationRevision.current + 1
    actionPresentationRevision.current = presentationRevision
    const revisionBeforeAction = eventRevision.current
    try {
      const state = await window.piGui.activateSession(sessionKey)
      applyReturnedState(state, revisionBeforeAction)
      if (actionPresentationRevision.current === presentationRevision) {
        setCompletedAction({ action: 'activate-session', succeeded: true })
      }
    } catch (error) {
      if (
        actionPresentationRevision.current === presentationRevision &&
        sessionViewTargetRef.current?.kind === 'session' &&
        sessionViewTargetRef.current.sessionKey === sessionKey
      ) {
        setActionError(errorMessage(error))
        setCompletedAction({ action: 'activate-session', succeeded: false })
      }
      throw error
    }
  }

  async function pumpRuntimeEnsure(generation: number): Promise<void> {
    if (runtimeEnsurePumpRef.current !== null) {
      await runtimeEnsurePumpRef.current.catch(() => undefined)
      if (runtimeEnsureGenerationRef.current !== generation) return
    }

    const pump = (async () => {
      let activeGeneration = generation
      while (desiredRuntimeEnsureRef.current !== null) {
        if (
          runtimeEnsureGenerationRef.current !== activeGeneration &&
          runtimeEnsureTimerRef.current !== null
        ) {
          return
        }

        const target = desiredRuntimeEnsureRef.current
        const workGeneration = runtimeEnsureGenerationRef.current
        executingRuntimeEnsureRef.current = target
        try {
          if (target.kind === 'new') {
            await performStartSession()
          } else if (sessionRuntimeAlreadyUsable(target.sessionKey)) {
            // Already the live foreground target; drop any stale preview shell.
            if (
              sessionViewTargetRef.current?.kind === 'session' &&
              sessionViewTargetRef.current.sessionKey === target.sessionKey
            ) {
              clearSessionView()
            }
          } else {
            await performActivateSession(target.sessionKey)
          }
          settleRuntimeEnsureWaiters((waiterTarget) =>
            runtimeEnsureTargetsEqual(waiterTarget, target)
          )
          if (
            runtimeEnsureTargetsEqual(desiredRuntimeEnsureRef.current, target) &&
            runtimeEnsureGenerationRef.current === workGeneration
          ) {
            desiredRuntimeEnsureRef.current = null
          }
        } catch (error) {
          settleRuntimeEnsureWaiters(
            (waiterTarget) => runtimeEnsureTargetsEqual(waiterTarget, target),
            error
          )
          if (runtimeEnsureTargetsEqual(desiredRuntimeEnsureRef.current, target)) {
            desiredRuntimeEnsureRef.current = null
          }
        } finally {
          executingRuntimeEnsureRef.current = null
        }

        if (runtimeEnsureTimerRef.current !== null) return
        activeGeneration = runtimeEnsureGenerationRef.current
      }
    })()

    runtimeEnsurePumpRef.current = pump
    try {
      await pump
    } finally {
      if (runtimeEnsurePumpRef.current === pump) runtimeEnsurePumpRef.current = null
    }
  }

  function enqueueRuntimeEnsure(
    target: RuntimeEnsureTarget,
    mode: 'immediate' | 'settled'
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      runtimeEnsureWaitersRef.current.push({ target, resolve, reject })
      desiredRuntimeEnsureRef.current = target
      supersedeRuntimeEnsureWaiters(target)
      runtimeEnsureGenerationRef.current += 1
      const generation = runtimeEnsureGenerationRef.current

      if (runtimeEnsureTimerRef.current !== null) {
        window.clearTimeout(runtimeEnsureTimerRef.current)
        runtimeEnsureTimerRef.current = null
      }

      if (mode === 'immediate') {
        void pumpRuntimeEnsure(generation)
        return
      }

      runtimeEnsureTimerRef.current = window.setTimeout(() => {
        runtimeEnsureTimerRef.current = null
        void pumpRuntimeEnsure(generation)
      }, SESSION_RUNTIME_SETTLE_MS)
    })
  }

  async function waitForRuntimeEnsureIdle(): Promise<void> {
    if (runtimeEnsureTimerRef.current !== null) {
      window.clearTimeout(runtimeEnsureTimerRef.current)
      runtimeEnsureTimerRef.current = null
    }
    desiredRuntimeEnsureRef.current = null
    runtimeEnsureGenerationRef.current += 1
    supersedeRuntimeEnsureWaiters(executingRuntimeEnsureRef.current)
    if (runtimeEnsurePumpRef.current !== null) {
      await runtimeEnsurePumpRef.current.catch(() => undefined)
    }
  }

  function ensureSessionRuntime(
    sessionKey: string,
    mode: 'immediate' | 'settled' = 'immediate'
  ): Promise<void> {
    return enqueueRuntimeEnsure({ kind: 'session', sessionKey }, mode)
  }

  function startSession(): Promise<void> {
    setArchivedSessionPreview(null)
    const projectKey = kernelStateRef.current?.activeProjectKey
    if (projectKey !== null && projectKey !== undefined) {
      previewRequestRevision.current += 1
      const target: SessionViewTarget = {
        kind: 'new',
        projectKey,
        prepared: false,
        sawProvisional: kernelStateRef.current?.activeSessionKey === null
      }
      sessionViewTargetRef.current = target
      setSessionViewTarget(target)
      setSessionPreview(null)
      setPreviewPendingKey(null)
      setActionError(null)
    }
    return enqueueRuntimeEnsure({ kind: 'new' }, 'immediate')
  }

  async function waitForSessionStart(): Promise<void> {
    const target = sessionViewTargetRef.current
    if (target?.kind === 'new' && !target.prepared) {
      await enqueueRuntimeEnsure({ kind: 'new' }, 'immediate')
    }
  }

  function applyReturnedState(state: KernelState, revisionBeforeAction: number): void {
    if (eventRevision.current !== revisionBeforeAction) return
    kernelStateRef.current = state
    setKernelState(state)
    const nextTarget = keepValidSessionViewTarget(sessionViewTargetRef.current, state)
    sessionViewTargetRef.current = nextTarget
    setSessionViewTarget(nextTarget)
    setSessionPreview((preview) => keepValidPreview(preview, state))
  }

  function closeForkDialog(): void {
    forkRequestRevision.current += 1
    setForkDialogOpen(false)
    setForkCandidates([])
    setForkCandidatesLoading(false)
    setForkError(null)
    setForkSubmitting(false)
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

  function openForkDialog(): void {
    const state = kernelStateRef.current
    if (
      state === null ||
      state.activeSessionKey === null ||
      state.runtime.status !== 'ready' ||
      !state.session.settled ||
      sessionViewTargetRef.current !== null
    ) {
      setActionError('当前对话暂时不能分叉。')
      return
    }
    setForkDialogOpen(true)
    setForkCandidates([])
    void loadForkCandidates()
  }

  async function forkSession(entryId: string): Promise<void> {
    if (forkSubmitting || !forkCandidates.some((candidate) => candidate.entryId === entryId)) return
    if (pendingActionRef.current !== null) throw new Error('Another action is already running.')
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
      previewRequestRevision.current += 1
      sessionViewTargetRef.current = null
      setSessionViewTarget(null)
      setSessionPreview(null)
      setArchivedSessionPreview(null)
      setPreviewPendingKey(null)
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

  async function copyLastAnswer(): Promise<void> {
    if (pendingActionRef.current !== null) throw new Error('Another action is already running.')
    const state = kernelStateRef.current
    if (
      state === null ||
      state.activeSessionKey === null ||
      state.runtime.status !== 'ready' ||
      !state.session.settled ||
      sessionViewTargetRef.current !== null
    ) {
      throw new Error('当前对话暂时没有可复制的最终回答。')
    }
    const answer = lastAssistantFinalAnswer(state)
    if (answer === null) throw new Error('当前对话暂时没有可复制的最终回答。')

    pendingActionRef.current = 'copy-last-answer'
    setPendingAction('copy-last-answer')
    setActionError(null)
    try {
      await navigator.clipboard.writeText(answer)
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
    const revisionBeforeAction = eventRevision.current
    let succeeded = false
    try {
      const result = await window.piGui.archiveSession(sessionKey)
      applyReturnedState(result.state, revisionBeforeAction)
      const expiresAt = Date.now() + result.receipt.durationMs
      setArchiveNotifications((current) => [
        ...current.filter(({ receipt }) => receipt.token !== result.receipt.token),
        { receipt: result.receipt, expiresAt, pending: null }
      ])
      if (
        sessionViewTargetRef.current?.kind === 'session' &&
        sessionViewTargetRef.current.sessionKey === sessionKey
      ) clearSessionView()
      setSessionPreview((preview) =>
        preview?.sessionKey === sessionKey ? null : preview
      )
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
    const revisionBeforeAction = eventRevision.current
    try {
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

  return (
    <>
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
      systemFonts={systemFonts}
      systemFontsError={systemFontsError}
      forkDialogOpen={forkDialogOpen}
      forkCandidates={forkCandidates}
      forkCandidatesLoading={forkCandidatesLoading}
      forkError={forkError}
      forkSubmitting={forkSubmitting}
      onAddProject={() => {
        setArchivedSessionPreview(null)
        return runAction('add-project', () => window.piGui.addProject())
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
      {archiveNotifications.length === 0 && compactionNotice === null ? null : createPortal(
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
        </section>,
        document.body
      )}
    </>
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

function keepValidPreview(
  preview: KernelSessionPreview | null,
  state: KernelState
): KernelSessionPreview | null {
  if (
    preview === null ||
    preview.projectKey !== state.activeProjectKey ||
    preview.sessionKey === state.activeSessionKey ||
    !state.sessions.some(({ key }) => key === preview.sessionKey)
  ) {
    return null
  }
  return preview
}

function keepValidSessionViewTarget(
  target: SessionViewTarget | null,
  state: KernelState
): SessionViewTarget | null {
  if (target === null || target.projectKey !== state.activeProjectKey) return null
  if (target.kind === 'session') {
    if (target.sessionKey === state.activeSessionKey) return null
    return state.sessions.some(({ key }) => key === target.sessionKey) ? target : null
  }
  if (state.activeSessionKey === null) {
    return target.sawProvisional ? target : { ...target, sawProvisional: true }
  }
  // Provisional new sessions clear activeSessionKey first. Once a real session is
  // registered, leave the synthetic "new" view even if the null phase was missed
  // (IPC ordering) or the session was registered without a provisional phase.
  if (target.sawProvisional || target.prepared) return null
  return target
}

function applyStatePatches(state: KernelState, patches: KernelStatePatch[]): KernelState {
  let runtime = state.runtime
  let session = state.session
  let entries = state.conversation.entries
  let activeRunStartIndex = state.conversation.activeRunStartIndex
  let conversationChanged = false
  let entriesCopied = false

  for (const patch of patches) {
    if (
      patch.projectKey !== state.activeProjectKey ||
      patch.sessionKey !== state.activeSessionKey
    ) continue
    if (patch.runtime !== undefined) runtime = patch.runtime
    if (patch.session !== undefined) session = patch.session
    if (patch.conversation === undefined) continue
    if (patch.conversation.entries !== undefined) {
      if (!entriesCopied) {
        entries = entries.slice()
        entriesCopied = true
      }
      conversationChanged = true
      for (const change of patch.conversation.entries) {
        if (change.type === 'insert') {
          if (change.index === entries.length) entries.push(change.entry)
          else if (entries[change.index]?.id !== change.entry.id) {
            throw new Error(`Conversation insert index ${change.index} is out of sequence.`)
          }
          continue
        }

        const current = entries[change.index]
        if (current === undefined) {
          throw new Error(`Conversation patch index ${change.index} does not exist.`)
        }
        if (change.type === 'append-message-text') {
          if (current.kind !== 'message') throw new Error('Conversation message patch kind mismatch.')
          const text = appendProjectedText(current.text, change.from, change.text)
          if (text === null) continue
          entries[change.index] = {
            ...current,
            text,
            streaming: change.streaming,
            stopReason: change.stopReason,
            error: change.error
          }
          continue
        }
        if (change.type === 'append-thinking-text') {
          if (current.kind !== 'thinking') throw new Error('Conversation thinking patch kind mismatch.')
          const text = appendProjectedText(current.text, change.from, change.text)
          if (text === null) continue
          entries[change.index] = { ...current, text, streaming: change.streaming }
          continue
        }
        if (current.kind !== 'tool') throw new Error('Conversation tool patch kind mismatch.')
        const output = appendProjectedText(current.output, change.from, change.output)
        if (output === null) continue
        entries[change.index] = {
          ...current,
          output,
          status: change.status,
          details: change.details,
          truncated: change.truncated,
          durationMs: change.durationMs
        }
      }
    }
    if ('activeRunStartIndex' in patch.conversation) {
      activeRunStartIndex = patch.conversation.activeRunStartIndex ?? null
      conversationChanged = true
    }
  }

  return {
    ...state,
    runtime,
    session,
    conversation: conversationChanged
      ? { entries, activeRunStartIndex }
      : state.conversation
  }
}

function appendProjectedText(current: string, from: number, addition: string): string | null {
  if (current.length === from) return `${current}${addition}`
  const targetLength = from + addition.length
  if (current.length >= targetLength && current.slice(from, targetLength) === addition) return null
  throw new Error(`Conversation text patch expected ${from} characters; received ${current.length}.`)
}
