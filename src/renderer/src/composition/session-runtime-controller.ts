import type {
  KernelSessionPreview,
  KernelState
} from '../../../shared/kernel-contract'

export type SessionViewTarget =
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

export type RuntimeEnsureTarget =
  | {
      kind: 'session'
      projectKey: string
      sessionKey: string
    }
  | {
      kind: 'new'
      projectKey: string
    }

export type SessionRuntimeSnapshot = {
  sessionViewTarget: SessionViewTarget | null
  sessionPreview: KernelSessionPreview | null
  previewPendingKey: string | null
}

type RuntimeEnsureWaiter = {
  target: RuntimeEnsureTarget
  resolve: () => void
  reject: (error: unknown) => void
}

type TimerHandle = number | ReturnType<typeof setTimeout>

export type SessionRuntimeControllerDependencies = {
  settleMs: number
  getKernelState: () => KernelState | null
  getEventRevision: () => number
  startSession: () => Promise<KernelState>
  activateSession: (sessionKey: string) => Promise<KernelState>
  previewSession: (sessionKey: string) => Promise<KernelSessionPreview>
  applyReturnedState: (state: KernelState, revisionBeforeAction: number) => boolean
  beginActionPresentation: () => number
  isActionPresentationCurrent: (revision: number) => boolean
  onSnapshot: (snapshot: SessionRuntimeSnapshot) => void
  onError: (error: unknown | null) => void
  onCompletedAction: (action: 'start-session' | 'activate-session', succeeded: boolean) => void
  onClearArchivedPreview: () => void
  setTimer?: (callback: () => void, delay: number) => TimerHandle
  clearTimer?: (handle: TimerHandle) => void
}

const SUPERSEDED_ERROR = 'Session activation superseded.'

export class SessionRuntimeController {
  private readonly dependencies: SessionRuntimeControllerDependencies
  private snapshot: SessionRuntimeSnapshot = {
    sessionViewTarget: null,
    sessionPreview: null,
    previewPendingKey: null
  }
  private previewRequestRevision = 0
  private desiredRuntimeEnsure: RuntimeEnsureTarget | null = null
  private executingRuntimeEnsure: RuntimeEnsureTarget | null = null
  private runtimeEnsureGeneration = 0
  private runtimeEnsureTimer: TimerHandle | null = null
  private runtimeEnsurePump: Promise<void> | null = null
  private runtimeEnsureWaiters: RuntimeEnsureWaiter[] = []
  private disposed = false

  constructor(dependencies: SessionRuntimeControllerDependencies) {
    this.dependencies = dependencies
  }

  getSnapshot(): SessionRuntimeSnapshot {
    return this.snapshot
  }

  reconcileKernelState(state: KernelState, initializing = false): void {
    const nextTarget = initializing && state.activeProjectKey !== null
      ? state.activeSessionKey === null
        ? {
            kind: 'new' as const,
            projectKey: state.activeProjectKey,
            prepared: false,
            sawProvisional: true
          }
        : {
            kind: 'session' as const,
            projectKey: state.activeProjectKey,
            sessionKey: state.activeSessionKey
          }
      : keepValidSessionViewTarget(this.snapshot.sessionViewTarget, state)
    this.updateSnapshot({
      ...this.snapshot,
      sessionViewTarget: nextTarget,
      sessionPreview: keepValidPreview(this.snapshot.sessionPreview, state)
    })
  }

  async preview(sessionKey: string): Promise<void> {
    this.assertActive()
    this.dependencies.onClearArchivedPreview()
    const state = this.dependencies.getKernelState()
    if (state?.activeProjectKey === null || state?.activeProjectKey === undefined) {
      throw new Error('No active project is available.')
    }
    const requestRevision = this.previewRequestRevision + 1
    this.previewRequestRevision = requestRevision
    const target: SessionViewTarget = {
      kind: 'session',
      projectKey: state.activeProjectKey,
      sessionKey
    }
    this.updateSnapshot({
      sessionViewTarget: target,
      sessionPreview: null,
      previewPendingKey: sessionKey
    })
    this.dependencies.onError(null)
    try {
      const preview = await this.dependencies.previewSession(sessionKey)
      if (
        this.disposed ||
        this.previewRequestRevision !== requestRevision ||
        !sessionViewTargetsEqual(this.snapshot.sessionViewTarget, target)
      ) return
      this.updateSnapshot({ ...this.snapshot, sessionPreview: preview })
    } catch (error) {
      if (this.previewRequestRevision !== requestRevision || this.disposed) return
      this.dependencies.onError(error)
      throw error
    } finally {
      if (!this.disposed && this.previewRequestRevision === requestRevision) {
        this.updateSnapshot({ ...this.snapshot, previewPendingKey: null })
      }
    }
  }

  clear(): void {
    this.assertActive()
    this.previewRequestRevision += 1
    this.updateSnapshot({
      sessionViewTarget: null,
      sessionPreview: null,
      previewPendingKey: null
    })
    this.dependencies.onClearArchivedPreview()
    this.dependencies.onError(null)
  }

  start(): Promise<void> {
    this.assertActive()
    this.dependencies.onClearArchivedPreview()
    const state = this.dependencies.getKernelState()
    if (state === null || state.activeProjectKey === null) {
      return Promise.reject(new Error('No active project is available.'))
    }
    const projectKey = state.activeProjectKey
    this.previewRequestRevision += 1
    this.updateSnapshot({
      sessionViewTarget: {
        kind: 'new',
        projectKey,
        prepared: false,
        sawProvisional: state.activeSessionKey === null
      },
      sessionPreview: null,
      previewPendingKey: null
    })
    this.dependencies.onError(null)
    return this.enqueueRuntimeEnsure({ kind: 'new', projectKey }, 'immediate')
  }

  activate(
    sessionKey: string,
    mode: 'immediate' | 'settled' = 'immediate'
  ): Promise<void> {
    this.assertActive()
    const projectKey = this.dependencies.getKernelState()?.activeProjectKey
    if (projectKey === null || projectKey === undefined) {
      return Promise.reject(new Error('No active project is available.'))
    }
    return this.enqueueRuntimeEnsure(
      { kind: 'session', projectKey, sessionKey },
      mode
    )
  }

  async waitForStart(): Promise<void> {
    const target = this.snapshot.sessionViewTarget
    if (target?.kind === 'new' && !target.prepared) {
      await this.enqueueRuntimeEnsure(
        { kind: 'new', projectKey: target.projectKey },
        'immediate'
      )
    }
  }

  async ensureInitialRuntime(): Promise<void> {
    this.assertActive()
    const state = this.dependencies.getKernelState()
    if (
      state === null ||
      state.activeProjectKey === null ||
      state.runtime.status !== 'stopped'
    ) return
    if (state.activeSessionKey !== null) {
      await this.activate(state.activeSessionKey, 'immediate')
      return
    }
    if (this.snapshot.sessionViewTarget?.kind === 'new') await this.start()
  }

  async waitForIdle(): Promise<void> {
    this.assertActive()
    this.cancelSettleTimer()
    this.desiredRuntimeEnsure = null
    this.runtimeEnsureGeneration += 1
    this.supersedeRuntimeEnsureWaiters(this.executingRuntimeEnsure)
    if (this.runtimeEnsurePump !== null) {
      await this.runtimeEnsurePump.catch(() => undefined)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.previewRequestRevision += 1
    this.cancelSettleTimer()
    this.desiredRuntimeEnsure = null
    const error = new Error(SUPERSEDED_ERROR)
    for (const waiter of this.runtimeEnsureWaiters) waiter.reject(error)
    this.runtimeEnsureWaiters = []
  }

  private updateSnapshot(snapshot: SessionRuntimeSnapshot): void {
    this.snapshot = snapshot
    this.dependencies.onSnapshot(snapshot)
  }

  private enqueueRuntimeEnsure(
    target: RuntimeEnsureTarget,
    mode: 'immediate' | 'settled'
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      this.runtimeEnsureWaiters.push({ target, resolve, reject })
      this.desiredRuntimeEnsure = target
      this.supersedeRuntimeEnsureWaiters(target)
      this.runtimeEnsureGeneration += 1
      const generation = this.runtimeEnsureGeneration
      this.cancelSettleTimer()

      if (mode === 'immediate') {
        this.startRuntimeEnsurePump()
        return
      }

      const setTimer = this.dependencies.setTimer ?? setTimeout
      this.runtimeEnsureTimer = setTimer(() => {
        this.runtimeEnsureTimer = null
        if (this.disposed || this.runtimeEnsureGeneration !== generation) return
        this.startRuntimeEnsurePump()
      }, this.dependencies.settleMs)
    })
  }

  private startRuntimeEnsurePump(): void {
    if (this.runtimeEnsurePump !== null || this.disposed) return
    const pump = this.pumpRuntimeEnsure()
    this.runtimeEnsurePump = pump
    void pump.finally(() => {
      if (this.runtimeEnsurePump === pump) this.runtimeEnsurePump = null
      if (
        !this.disposed &&
        this.runtimeEnsureTimer === null &&
        this.desiredRuntimeEnsure !== null
      ) {
        this.startRuntimeEnsurePump()
      }
    })
  }

  private async pumpRuntimeEnsure(): Promise<void> {
    while (
      !this.disposed &&
      this.runtimeEnsureTimer === null &&
      this.desiredRuntimeEnsure !== null
    ) {
      const target = this.desiredRuntimeEnsure
      const generation = this.runtimeEnsureGeneration
      this.executingRuntimeEnsure = target
      try {
        await this.performRuntimeEnsure(target, generation)
        this.settleRuntimeEnsureWaiters((waiterTarget) =>
          runtimeEnsureTargetsEqual(waiterTarget, target)
        )
      } catch (error) {
        this.settleRuntimeEnsureWaiters(
          (waiterTarget) => runtimeEnsureTargetsEqual(waiterTarget, target),
          error
        )
      } finally {
        this.desiredRuntimeEnsure = nextDesiredRuntimeEnsureAfterCompletion(
          this.desiredRuntimeEnsure,
          target
        )
        this.executingRuntimeEnsure = null
      }
    }
  }

  private async performRuntimeEnsure(
    target: RuntimeEnsureTarget,
    generation: number
  ): Promise<void> {
    const state = this.dependencies.getKernelState()
    if (state?.activeProjectKey !== target.projectKey) {
      throw new Error(SUPERSEDED_ERROR)
    }

    if (target.kind === 'session' && sessionRuntimeAlreadyUsable(state, target)) {
      if (
        this.snapshot.sessionViewTarget?.kind === 'session' &&
        sessionViewTargetsEqual(this.snapshot.sessionViewTarget, target)
      ) {
        this.clear()
      }
      return
    }

    this.dependencies.onError(null)
    const presentationRevision = this.dependencies.beginActionPresentation()
    const revisionBeforeAction = this.dependencies.getEventRevision()
    const action = target.kind === 'new' ? 'start-session' : 'activate-session'
    try {
      const returnedState = target.kind === 'new'
        ? await this.dependencies.startSession()
        : await this.dependencies.activateSession(target.sessionKey)
      if (this.runtimeResultIsCurrent(target, generation)) {
        if (this.dependencies.applyReturnedState(returnedState, revisionBeforeAction)) {
          this.reconcileKernelState(returnedState)
        }
        if (target.kind === 'new') this.markNewTargetPrepared(target)
        if (this.dependencies.isActionPresentationCurrent(presentationRevision)) {
          this.dependencies.onCompletedAction(action, true)
        }
      }
    } catch (error) {
      if (
        this.runtimeResultIsCurrent(target, generation) &&
        this.dependencies.isActionPresentationCurrent(presentationRevision) &&
        this.viewTargetMatchesRuntimeTarget(target)
      ) {
        this.dependencies.onError(error)
        this.dependencies.onCompletedAction(action, false)
      }
      throw error
    }
  }

  private runtimeResultIsCurrent(
    target: RuntimeEnsureTarget,
    generation: number
  ): boolean {
    return (
      this.runtimeEnsureGeneration === generation ||
      runtimeEnsureTargetsEqual(this.desiredRuntimeEnsure, target)
    )
  }

  private viewTargetMatchesRuntimeTarget(target: RuntimeEnsureTarget): boolean {
    const viewTarget = this.snapshot.sessionViewTarget
    if (target.kind === 'new') {
      return viewTarget?.kind === 'new' && viewTarget.projectKey === target.projectKey
    }
    return (
      viewTarget?.kind === 'session' &&
      sessionViewTargetsEqual(viewTarget, target)
    )
  }

  private markNewTargetPrepared(target: Extract<RuntimeEnsureTarget, { kind: 'new' }>): void {
    const viewTarget = this.snapshot.sessionViewTarget
    if (viewTarget?.kind !== 'new' || viewTarget.projectKey !== target.projectKey) return
    const preparedTarget = { ...viewTarget, prepared: true }
    const state = this.dependencies.getKernelState()
    this.updateSnapshot({
      ...this.snapshot,
      sessionViewTarget: state === null
        ? preparedTarget
        : keepValidSessionViewTarget(preparedTarget, state)
    })
  }

  private settleRuntimeEnsureWaiters(
    predicate: (target: RuntimeEnsureTarget) => boolean,
    error?: unknown
  ): void {
    const remaining: RuntimeEnsureWaiter[] = []
    for (const waiter of this.runtimeEnsureWaiters) {
      if (!predicate(waiter.target)) {
        remaining.push(waiter)
        continue
      }
      if (error === undefined) waiter.resolve()
      else waiter.reject(error)
    }
    this.runtimeEnsureWaiters = remaining
  }

  private supersedeRuntimeEnsureWaiters(next: RuntimeEnsureTarget | null): void {
    const remaining: RuntimeEnsureWaiter[] = []
    for (const waiter of this.runtimeEnsureWaiters) {
      if (runtimeEnsureTargetsEqual(waiter.target, next)) {
        remaining.push(waiter)
        continue
      }
      if (
        this.executingRuntimeEnsure !== null &&
        runtimeEnsureTargetsEqual(waiter.target, this.executingRuntimeEnsure)
      ) {
        remaining.push(waiter)
        continue
      }
      waiter.reject(new Error(SUPERSEDED_ERROR))
    }
    this.runtimeEnsureWaiters = remaining
  }

  private cancelSettleTimer(): void {
    if (this.runtimeEnsureTimer === null) return
    const clearTimer = this.dependencies.clearTimer ?? clearTimeout
    clearTimer(this.runtimeEnsureTimer)
    this.runtimeEnsureTimer = null
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('Session Runtime controller is disposed.')
  }
}

export function runtimeEnsureTargetsEqual(
  left: RuntimeEnsureTarget | null,
  right: RuntimeEnsureTarget | null
): boolean {
  if (left === null || right === null) return left === right
  if (left.kind !== right.kind || left.projectKey !== right.projectKey) return false
  return left.kind === 'new' || (
    right.kind === 'session' &&
    left.sessionKey === right.sessionKey
  )
}

export function nextDesiredRuntimeEnsureAfterCompletion(
  desired: RuntimeEnsureTarget | null,
  completed: RuntimeEnsureTarget
): RuntimeEnsureTarget | null {
  return runtimeEnsureTargetsEqual(desired, completed) ? null : desired
}

export function keepValidPreview(
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

export function keepValidSessionViewTarget(
  target: SessionViewTarget | null,
  state: KernelState
): SessionViewTarget | null {
  if (target === null || target.projectKey !== state.activeProjectKey) return null
  if (target.kind === 'session') {
    const summary = state.sessions.find(({ key }) => key === target.sessionKey)
    if (summary === undefined) return null
    if (target.sessionKey !== state.activeSessionKey) return target
    const status = summary.runtimeStatus
    return status === 'ready' || status === 'running' ? null : target
  }
  if (state.activeSessionKey === null) {
    return target.sawProvisional ? target : { ...target, sawProvisional: true }
  }
  if (target.sawProvisional || target.prepared) return null
  if (state.sessions.some((session) => session.key === state.activeSessionKey)) return null
  return target
}

function sessionRuntimeAlreadyUsable(
  state: KernelState,
  target: Extract<RuntimeEnsureTarget, { kind: 'session' }>
): boolean {
  if (
    state.activeProjectKey !== target.projectKey ||
    state.activeSessionKey !== target.sessionKey
  ) return false
  const summary = state.sessions.find((session) => session.key === target.sessionKey)
  const status = summary?.runtimeStatus ?? state.runtime.status
  return (
    status === 'ready' ||
    status === 'running' ||
    status === 'starting' ||
    status === 'stopping'
  )
}

function sessionViewTargetsEqual(
  left: SessionViewTarget | null,
  right: SessionViewTarget | RuntimeEnsureTarget | null
): boolean {
  if (left === null || right === null) return left === right
  if (left.kind !== right.kind || left.projectKey !== right.projectKey) return false
  return left.kind === 'new' || (
    right.kind === 'session' &&
    left.sessionKey === right.sessionKey
  )
}
