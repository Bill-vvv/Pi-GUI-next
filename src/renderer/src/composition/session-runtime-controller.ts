import type {
  KernelConversationState,
  KernelMutationAck,
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

type SessionSwitchCacheEntry = {
  preview: KernelSessionPreview
  estimatedBytes: number
}

type SessionSwitchCacheLookup = {
  key: string
  entry: SessionSwitchCacheEntry
}

/** Renderer-only first-paint snapshots; full Conversation remains authoritative elsewhere. */
const SESSION_SWITCH_CACHE_MAX_ENTRIES = 16
const SESSION_SWITCH_CACHE_MAX_ESTIMATED_BYTES = 8 * 1024 * 1024
const SESSION_SWITCH_CACHE_MAX_PREVIEW_BYTES = 1024 * 1024

export type SessionRuntimeControllerDependencies = {
  settleMs: number
  getKernelState: () => KernelState | null
  startSession: () => Promise<KernelMutationAck>
  activateSession: (sessionKey: string) => Promise<KernelMutationAck>
  previewSession: (sessionKey: string) => Promise<KernelSessionPreview>
  beginActionPresentation: () => number
  isActionPresentationCurrent: (revision: number) => boolean
  onSnapshot: (snapshot: SessionRuntimeSnapshot) => void
  onError: (error: unknown | null) => void
  onCompletedAction: (action: 'start-session' | 'activate-session', succeeded: boolean) => void
  onClearArchivedPreview: () => void
  setTimer?: (callback: () => void, delay: number) => TimerHandle
  clearTimer?: (handle: TimerHandle) => void
  setPostTask?: (callback: () => void) => TimerHandle
  clearPostTask?: (handle: TimerHandle) => void
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
  private readonly sessionSwitchCache = new Map<string, SessionSwitchCacheEntry>()
  private readonly sessionSwitchCacheTasks = new Map<string, TimerHandle>()
  private sessionSwitchCacheEstimatedBytes = 0
  private lastReconciledState: KernelState | null = null
  private desiredRuntimeEnsure: RuntimeEnsureTarget | null = null
  private desiredRuntimeEnsurePreview = false
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
    const previousState = this.lastReconciledState
    if (previousState !== null && activeSessionIdentityChanged(previousState, state)) {
      this.scheduleRememberActiveSession(previousState)
    }
    this.lastReconciledState = state
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
      sessionPreview: keepValidPreview(this.snapshot.sessionPreview, state),
      previewPendingKey: keepValidPreviewPendingKey(this.snapshot.previewPendingKey, state)
    })
  }

  async preview(sessionKey: string): Promise<void> {
    this.assertActive()
    this.dependencies.onClearArchivedPreview()
    const state = this.dependencies.getKernelState()
    if (state?.activeProjectKey === null || state?.activeProjectKey === undefined) {
      throw new Error('No active project is available.')
    }
    if (!sessionIsRegistered(state, sessionKey)) {
      this.discardStaleSessionTarget(sessionKey)
      return
    }
    const target: Extract<RuntimeEnsureTarget, { kind: 'session' }> = {
      kind: 'session',
      projectKey: state.activeProjectKey,
      sessionKey
    }
    const requestRevision = this.publishSessionView(state, target)
    this.dependencies.onError(null)
    await this.loadSessionPreview(target, requestRevision)
  }

  select(sessionKey: string): Promise<void> {
    this.assertActive()
    this.dependencies.onClearArchivedPreview()
    const state = this.dependencies.getKernelState()
    if (state === null || state.activeProjectKey === null) {
      return Promise.reject(new Error('No active project is available.'))
    }
    if (!sessionIsRegistered(state, sessionKey)) {
      this.discardStaleSessionTarget(sessionKey)
      return Promise.resolve()
    }
    const target: Extract<RuntimeEnsureTarget, { kind: 'session' }> = {
      kind: 'session',
      projectKey: state.activeProjectKey,
      sessionKey
    }
    this.publishSessionView(state, target)
    this.dependencies.onError(null)
    return this.enqueueRuntimeEnsure(
      target,
      'settled',
      sessionNeedsHistoricalPreview(state, target)
    )
  }

  clear(): void {
    this.assertActive()
    if (this.runtimeEnsureTimer !== null) {
      this.cancelSettleTimer()
      this.desiredRuntimeEnsure = null
      this.desiredRuntimeEnsurePreview = false
      this.runtimeEnsureGeneration += 1
      this.supersedeRuntimeEnsureWaiters(this.executingRuntimeEnsure)
    }
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
    const state = this.dependencies.getKernelState()
    if (state === null || state.activeProjectKey === null) {
      return Promise.reject(new Error('No active project is available.'))
    }
    const projectKey = state.activeProjectKey
    if (!sessionIsRegistered(state, sessionKey)) {
      this.discardStaleSessionTarget(sessionKey)
      return Promise.resolve()
    }
    const target: Extract<RuntimeEnsureTarget, { kind: 'session' }> = {
      kind: 'session',
      projectKey,
      sessionKey
    }
    if (!sessionRuntimeAlreadyUsable(state, target)) {
      this.prepareSessionView(state, target)
    }
    return this.enqueueRuntimeEnsure(target, mode)
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
    this.desiredRuntimeEnsurePreview = false
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
    this.cancelSessionSwitchCacheTasks()
    this.desiredRuntimeEnsure = null
    this.desiredRuntimeEnsurePreview = false
    const error = new Error(SUPERSEDED_ERROR)
    for (const waiter of this.runtimeEnsureWaiters) waiter.reject(error)
    this.runtimeEnsureWaiters = []
    this.sessionSwitchCache.clear()
    this.sessionSwitchCacheEstimatedBytes = 0
    this.lastReconciledState = null
  }

  private updateSnapshot(snapshot: SessionRuntimeSnapshot): void {
    this.snapshot = snapshot
    this.dependencies.onSnapshot(snapshot)
  }

  private enqueueRuntimeEnsure(
    target: RuntimeEnsureTarget,
    mode: 'immediate' | 'settled',
    preview = false
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      this.runtimeEnsureWaiters.push({ target, resolve, reject })
      const preservePendingPreview =
        runtimeEnsureTargetsEqual(this.desiredRuntimeEnsure, target) &&
        this.desiredRuntimeEnsurePreview
      this.desiredRuntimeEnsure = target
      this.desiredRuntimeEnsurePreview = preview || preservePendingPreview
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
      const preview = this.desiredRuntimeEnsurePreview
      const generation = this.runtimeEnsureGeneration
      this.executingRuntimeEnsure = target
      try {
        await this.performRuntimeEnsure(target, generation, preview)
        this.settleRuntimeEnsureWaiters((waiterTarget) =>
          runtimeEnsureTargetsEqual(waiterTarget, target)
        )
      } catch (error) {
        this.settleRuntimeEnsureWaiters(
          (waiterTarget) => runtimeEnsureTargetsEqual(waiterTarget, target),
          error
        )
      } finally {
        const nextTarget = nextDesiredRuntimeEnsureAfterCompletion(
          this.desiredRuntimeEnsure,
          target
        )
        this.desiredRuntimeEnsure = nextTarget
        if (nextTarget === null) this.desiredRuntimeEnsurePreview = false
        this.executingRuntimeEnsure = null
      }
    }
  }

  private async performRuntimeEnsure(
    target: RuntimeEnsureTarget,
    generation: number,
    preview: boolean
  ): Promise<void> {
    const state = this.dependencies.getKernelState()
    if (state?.activeProjectKey !== target.projectKey) {
      throw new Error(SUPERSEDED_ERROR)
    }
    if (target.kind === 'session' && !sessionIsRegistered(state, target.sessionKey)) {
      this.discardStaleSessionTarget(target.sessionKey)
      return
    }

    if (target.kind === 'session' && preview && sessionNeedsHistoricalPreview(state, target)) {
      // Historical projection is presentation-only. A stale or slow preview must
      // never hold the Runtime queue or prevent a newer target from activating.
      void this.loadSessionPreview(target, this.previewRequestRevision).catch(() => undefined)
    }

    await this.ensureRuntimeTarget(target, generation, state)
  }

  private async ensureRuntimeTarget(
    target: RuntimeEnsureTarget,
    generation: number,
    state: KernelState
  ): Promise<void> {
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
    const action = target.kind === 'new' ? 'start-session' : 'activate-session'
    try {
      if (target.kind === 'new') await this.dependencies.startSession()
      else await this.dependencies.activateSession(target.sessionKey)
      if (this.runtimeResultIsCurrent(target, generation)) {
        // Mutations publish state events; reconcile from the latest projected state.
        const latest = this.dependencies.getKernelState()
        if (latest !== null) this.reconcileKernelState(latest)
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
        if (target.kind === 'session' && this.snapshot.previewPendingKey === target.sessionKey) {
          this.updateSnapshot({ ...this.snapshot, previewPendingKey: null })
        }
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

  private prepareSessionView(
    state: KernelState,
    target: Extract<RuntimeEnsureTarget, { kind: 'session' }>
  ): void {
    if (sessionViewTargetsEqual(this.snapshot.sessionViewTarget, target)) return
    this.publishSessionView(state, target)
  }

  private publishSessionView(
    state: KernelState,
    target: Extract<RuntimeEnsureTarget, { kind: 'session' }>
  ): number {
    const cached = this.getTargetCachedPreview(state, target.sessionKey)
    const requestRevision = this.previewRequestRevision + 1
    this.previewRequestRevision = requestRevision
    this.updateSnapshot({
      sessionViewTarget: target,
      sessionPreview: cached?.entry.preview ?? null,
      previewPendingKey: target.sessionKey
    })
    if (state.activeSessionKey !== target.sessionKey) {
      this.scheduleRememberActiveSession(state)
    }
    if (cached !== null) this.scheduleCachePromotion(cached)
    return requestRevision
  }

  private async loadSessionPreview(
    target: Extract<RuntimeEnsureTarget, { kind: 'session' }>,
    requestRevision: number
  ): Promise<void> {
    try {
      const preview = await this.dependencies.previewSession(target.sessionKey)
      if (this.disposed) return
      this.scheduleRememberPreview(preview)
      if (
        this.previewRequestRevision !== requestRevision ||
        !sessionViewTargetsEqual(this.snapshot.sessionViewTarget, target)
      ) return
      this.updateSnapshot({ ...this.snapshot, sessionPreview: preview })
    } catch (error) {
      if (
        this.disposed ||
        this.previewRequestRevision !== requestRevision ||
        !sessionViewTargetsEqual(this.snapshot.sessionViewTarget, target)
      ) return
      this.dependencies.onError(error)
      throw error
    } finally {
      if (
        !this.disposed &&
        this.previewRequestRevision === requestRevision &&
        sessionViewTargetsEqual(this.snapshot.sessionViewTarget, target)
      ) {
        this.updateSnapshot({ ...this.snapshot, previewPendingKey: null })
      }
    }
  }

  private scheduleRememberActiveSession(state: KernelState): void {
    const projectKey = state.activeProjectKey
    const sessionKey = state.activeSessionKey
    const sessionId = state.session.id
    if (projectKey === null || sessionKey === null || sessionId === null) return
    const summary = state.sessions.find((session) => session.key === sessionKey)
    if (summary === undefined || summary.id !== sessionId || summary.provisional === true) return
    this.scheduleRememberPreview({
      projectKey,
      sessionKey,
      sessionId,
      sessionName: state.session.name ?? summary.name,
      conversation: state.conversation
    })
  }

  private scheduleRememberPreview(preview: KernelSessionPreview): void {
    const key = sessionSwitchCacheKey(preview)
    this.scheduleSessionSwitchCacheTask(`write\0${key}`, () => {
      this.writePreviewToCache(preview)
    })
  }

  private writePreviewToCache(preview: KernelSessionPreview): void {
    const cachedPreview: KernelSessionPreview = {
      ...preview,
      conversation: sessionSwitchConversation(preview.conversation)
    }
    const key = sessionSwitchCacheKey(cachedPreview)
    const estimatedBytes = JSON.stringify(cachedPreview).length * 2
    const previous = this.sessionSwitchCache.get(key)
    if (previous !== undefined) {
      this.sessionSwitchCache.delete(key)
      this.sessionSwitchCacheEstimatedBytes -= previous.estimatedBytes
    }
    if (estimatedBytes > SESSION_SWITCH_CACHE_MAX_PREVIEW_BYTES) return
    this.sessionSwitchCache.set(key, { preview: cachedPreview, estimatedBytes })
    this.sessionSwitchCacheEstimatedBytes += estimatedBytes
    while (
      this.sessionSwitchCache.size > SESSION_SWITCH_CACHE_MAX_ENTRIES ||
      this.sessionSwitchCacheEstimatedBytes > SESSION_SWITCH_CACHE_MAX_ESTIMATED_BYTES
    ) {
      const oldestKey = this.sessionSwitchCache.keys().next().value as string | undefined
      if (oldestKey === undefined) break
      const oldest = this.sessionSwitchCache.get(oldestKey)
      this.sessionSwitchCache.delete(oldestKey)
      if (oldest !== undefined) {
        this.sessionSwitchCacheEstimatedBytes -= oldest.estimatedBytes
      }
    }
  }

  private getTargetCachedPreview(
    state: KernelState,
    sessionKey: string
  ): SessionSwitchCacheLookup | null {
    const summary = state.sessions.find((session) => session.key === sessionKey)
    const stateOwnsVisibleConversation =
      state.activeSessionKey === sessionKey &&
      state.session.id !== null &&
      summary?.id === state.session.id &&
      state.conversation.entries.length > 0
    return stateOwnsVisibleConversation ? null : this.getCachedPreview(state, sessionKey)
  }

  private getCachedPreview(
    state: KernelState,
    sessionKey: string
  ): SessionSwitchCacheLookup | null {
    const projectKey = state.activeProjectKey
    const summary = state.sessions.find((session) => session.key === sessionKey)
    if (projectKey === null || summary === undefined || summary.provisional === true) return null
    const key = sessionSwitchCacheKey({
      projectKey,
      sessionKey,
      sessionId: summary.id
    })
    const cached = this.sessionSwitchCache.get(key)
    return cached === undefined ? null : { key, entry: cached }
  }

  private scheduleCachePromotion(cached: SessionSwitchCacheLookup): void {
    this.scheduleSessionSwitchCacheTask(`promote\0${cached.key}`, () => {
      if (this.sessionSwitchCache.get(cached.key) !== cached.entry) return
      this.sessionSwitchCache.delete(cached.key)
      this.sessionSwitchCache.set(cached.key, cached.entry)
    })
  }

  private scheduleSessionSwitchCacheTask(key: string, callback: () => void): void {
    const existing = this.sessionSwitchCacheTasks.get(key)
    if (existing !== undefined) {
      const clearPostTask = this.dependencies.clearPostTask ?? clearTimeout
      clearPostTask(existing)
    }
    const setPostTask = this.dependencies.setPostTask ?? ((task: () => void) => setTimeout(task, 0))
    let handle: TimerHandle
    handle = setPostTask(() => {
      if (this.sessionSwitchCacheTasks.get(key) !== handle) return
      this.sessionSwitchCacheTasks.delete(key)
      if (!this.disposed) callback()
    })
    this.sessionSwitchCacheTasks.set(key, handle)
  }

  private cancelSessionSwitchCacheTasks(): void {
    const clearPostTask = this.dependencies.clearPostTask ?? clearTimeout
    for (const handle of this.sessionSwitchCacheTasks.values()) clearPostTask(handle)
    this.sessionSwitchCacheTasks.clear()
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

  private discardStaleSessionTarget(sessionKey: string): void {
    const target = this.snapshot.sessionViewTarget
    if (target?.kind === 'session' && target.sessionKey === sessionKey) {
      this.previewRequestRevision += 1
      this.updateSnapshot({
        sessionViewTarget: null,
        sessionPreview: null,
        previewPendingKey: null
      })
    }
    this.dependencies.onError(null)
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

/** Keep two settled turns, or the previous settled turn plus the complete active run. */
export function sessionSwitchConversation(
  conversation: KernelConversationState
): KernelConversationState {
  const entries = conversation.entries
  if (entries.length === 0) return conversation
  const activeBoundary = conversation.activeRunStartIndex === null
    ? null
    : Math.max(0, Math.min(conversation.activeRunStartIndex, entries.length))
  const completedBoundary = activeBoundary ?? entries.length
  const completedTurnsToKeep = activeBoundary === null ? 2 : 1
  const startIndex = conversationWindowStartIndex(
    entries,
    completedBoundary,
    completedTurnsToKeep
  )
  if (startIndex === 0) return conversation
  return {
    entries: entries.slice(startIndex),
    activeRunStartIndex: activeBoundary === null ? null : activeBoundary - startIndex
  }
}

export function keepValidPreview(
  preview: KernelSessionPreview | null,
  state: KernelState
): KernelSessionPreview | null {
  const summary = preview === null
    ? null
    : state.sessions.find(({ key }) => key === preview.sessionKey) ?? null
  if (
    preview === null ||
    preview.projectKey !== state.activeProjectKey ||
    summary === null
  ) return null
  if (preview.sessionKey !== state.activeSessionKey) return preview
  return (
    state.session.id === preview.sessionId &&
    (summary.runtimeStatus === 'ready' || summary.runtimeStatus === 'running')
  ) ? null : preview
}

function keepValidPreviewPendingKey(
  sessionKey: string | null,
  state: KernelState
): string | null {
  if (sessionKey === null || !sessionIsRegistered(state, sessionKey)) return null
  const summary = state.sessions.find((session) => session.key === sessionKey)
  if (
    state.activeSessionKey === sessionKey &&
    state.session.id !== null &&
    summary?.id === state.session.id &&
    (summary.runtimeStatus === 'ready' || summary.runtimeStatus === 'running')
  ) return null
  return sessionKey
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
  if (activeSessionIsListedInProject(state)) return null
  return target.sawProvisional ? target : { ...target, sawProvisional: true }
}

function conversationWindowStartIndex(
  entries: KernelConversationState['entries'],
  end: number,
  turnCount: number
): number {
  let start = end
  for (let remaining = turnCount; remaining > 0 && start > 0; remaining -= 1) {
    const lastEntry = entries[start - 1]!
    if (lastEntry.kind === 'command') {
      start -= 1
      continue
    }
    let index = start - 1
    while (index >= 0) {
      const entry = entries[index]!
      if (entry.kind === 'message' && entry.role === 'user') {
        start = index
        break
      }
      if (entry.kind === 'command') {
        start = index + 1
        break
      }
      index -= 1
    }
    if (index < 0) start = 0
  }
  return start
}

function sessionSwitchCacheKey(identity: {
  projectKey: string
  sessionKey: string
  sessionId: string
}): string {
  return `${identity.projectKey}\0${identity.sessionKey}\0${identity.sessionId}`
}

function activeSessionIdentityChanged(previous: KernelState, next: KernelState): boolean {
  return previous.activeProjectKey !== next.activeProjectKey ||
    previous.activeSessionKey !== next.activeSessionKey ||
    previous.session.id !== next.session.id
}

function activeSessionIsListedInProject(state: KernelState): boolean {
  const activeProjectKey = state.activeProjectKey
  const activeSessionKey = state.activeSessionKey
  if (activeProjectKey === null || activeSessionKey === null) return false
  return state.projects
    .find(({ path }) => path === activeProjectKey)
    ?.sessions
    ?.some(({ key }) => key === activeSessionKey) === true
}

function sessionIsRegistered(state: KernelState, sessionKey: string): boolean {
  return state.sessions.some(({ key }) => key === sessionKey)
}

function sessionNeedsHistoricalPreview(
  state: KernelState,
  target: Extract<RuntimeEnsureTarget, { kind: 'session' }>
): boolean {
  if (state.activeSessionKey === target.sessionKey) return false
  const status = state.sessions.find(({ key }) => key === target.sessionKey)?.runtimeStatus
  return status === 'stopped' || status === 'crashed'
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
