import { randomUUID } from 'node:crypto'

import { VERSION } from '@earendil-works/pi-coding-agent'

import type { SubagentSettings } from '../../shared/kernel-contract.ts'
import type { PiRpcEvent, PiRpcExtensionEvent, PiRpcExtensionInventory } from '../pi-rpc/pi-rpc-client.ts'
import { errorMessage } from '../utils/errors.ts'
import {
  buildHibernateLeasePrompt,
  buildQuiescencePrompt,
  interpretHibernateLeaseStatusText,
  interpretQuiescenceStatusText,
  isHibernateLeaseStatusEvent,
  isInternalRuntimeStatusEvent,
  isMutatingRuntimeCommandType,
  isQuiescenceStatusEvent,
  isValidAttemptId,
  isValidLeaseToken,
  isValidRuntimeGeneration,
  isValidSessionId,
  normalizeHibernateLeaseTimeoutMs,
  normalizeQuiescenceTimeoutMs,
  type RuntimeHibernateLeaseAction,
  type RuntimeHibernateLeaseResult,
  type RuntimeQuiescenceQueryResult
} from './runtime-quiescence.ts'
import {
  SharedPiAgentSession,
  type SharedPiAgentSessionOptions,
  type SharedPiSessionDriver,
  type SharedPiSessionFactory
} from './shared-pi-agent-session.ts'
import { SharedPiProcessEnvironment } from './shared-pi-process-environment.ts'
import type {
  RuntimeCommand,
  RuntimeCommandResult,
  RuntimeHost,
  RuntimeHostEvent,
  RuntimeHostState
} from './runtime-host.ts'

type HostStatus = 'running' | 'disposing' | 'disposed'
type RuntimePhase = 'new' | 'starting' | 'running' | 'stopping' | 'stopped' | 'crashed'

type PublishedSession = {
  driver: SharedPiSessionDriver
  sessionFile: string
}

type BufferedEvent =
  | { kind: 'runtime', event: RuntimeHostEvent }
  | { kind: 'extension', event: PiRpcExtensionEvent }

type HibernateLease =
  | {
      phase: 'preparing'
      sessionId: string
      generation: number
      attemptId: string
    }
  | {
      phase: 'prepared' | 'committed'
      sessionId: string
      generation: number
      attemptId: string
      token: string
    }

export type SharedPiRuntimeOptions = {
  cwd: string
  sessionFile?: string
  projectTrust?: boolean
  fastExtensionLoading?: boolean
  quiescenceExtensionPath?: string
  extensionPaths: string[]
  subagent?: SubagentSettings
  desktopNotification?: {
    socketPath: string
    token: string
  }
  openAiFastMode?: boolean
}

export type SharedPiHostOptions = {
  createSession?: SharedPiSessionFactory
}

/**
 * DSH-style process owner for every in-process Pi Session.
 * Sessions are prepared privately, published atomically by canonical session file,
 * and disposed only through the exact Runtime handle that owns the published record.
 */
export class SharedPiHost {
  private readonly environment = new SharedPiProcessEnvironment()
  private readonly createSession: SharedPiSessionFactory
  private readonly handles = new Set<SharedPiRuntime>()
  private readonly publishedByRuntime = new Map<SharedPiRuntime, PublishedSession>()
  private readonly runtimeBySessionFile = new Map<string, SharedPiRuntime>()
  private status: HostStatus = 'running'
  private disposePromise: Promise<void> | null = null

  constructor(options: SharedPiHostOptions = {}) {
    this.createSession = options.createSession ?? SharedPiAgentSession.create
  }

  createRuntime(options: SharedPiRuntimeOptions): RuntimeHost {
    if (this.status !== 'running') throw new Error('Shared Pi Host is not accepting new Sessions.')
    const runtime = new SharedPiRuntime(this, options)
    this.handles.add(runtime)
    return runtime
  }

  async startRuntime(runtime: SharedPiRuntime, options: SharedPiAgentSessionOptions): Promise<SharedPiSessionDriver> {
    if (this.status !== 'running') throw new Error('Shared Pi Host is not accepting Session starts.')
    const driver = await this.createSession(this.environment, options, {
      onEvent: (event) => runtime.handlePiEvent(event),
      onExtensionEvent: (event) => runtime.handleExtensionEvent(event),
      onIdentityChange: async (previousSessionFile, nextSessionFile) => {
        await runtime.handleIdentityChange(previousSessionFile, nextSessionFile)
      },
      onShutdownRequested: () => {
        void runtime.stop()
      }
    })

    try {
      const sessionFile = driver.sessionFile
      const existing = this.runtimeBySessionFile.get(sessionFile)
      if (existing !== undefined && existing !== runtime) {
        throw new Error(`Shared Pi Session is already live: ${sessionFile}`)
      }
      if (this.status !== 'running') {
        throw new Error('Shared Pi Host began disposal before Session publication.')
      }
      this.publishedByRuntime.set(runtime, { driver, sessionFile })
      this.runtimeBySessionFile.set(sessionFile, runtime)
      return driver
    } catch (publicationError) {
      try {
        await driver.dispose()
      } catch (cleanupError) {
        runtime.retainFailedStartupDriver(driver)
        throw new AggregateError(
          [publicationError, cleanupError],
          'Shared Pi Session publication and cleanup both failed.'
        )
      }
      throw publicationError
    }
  }

  replaceIdentity(
    runtime: SharedPiRuntime,
    previousSessionFile: string | null,
    nextSessionFile: string
  ): void {
    const published = this.publishedByRuntime.get(runtime)
    if (published === undefined) {
      throw new Error('Shared Pi Session identity changed before publication.')
    }
    if (previousSessionFile !== published.sessionFile) {
      throw new Error('Shared Pi Session identity replacement did not match its published owner.')
    }
    const existing = this.runtimeBySessionFile.get(nextSessionFile)
    if (existing !== undefined && existing !== runtime) {
      throw new Error(`Shared Pi Session is already live: ${nextSessionFile}`)
    }
    if (this.runtimeBySessionFile.get(previousSessionFile) === runtime) {
      this.runtimeBySessionFile.delete(previousSessionFile)
    }
    this.runtimeBySessionFile.set(nextSessionFile, runtime)
    published.sessionFile = nextSessionFile
  }

  releaseUnpublishedRuntime(runtime: SharedPiRuntime): void {
    if (this.publishedByRuntime.has(runtime)) {
      throw new Error('Published Shared Pi Runtime must be released through its exact Session disposer.')
    }
    this.handles.delete(runtime)
  }

  async stopRuntime(runtime: SharedPiRuntime, driver: SharedPiSessionDriver): Promise<void> {
    const published = this.publishedByRuntime.get(runtime)
    if (published !== undefined && published.driver !== driver) {
      throw new Error('Shared Pi Session disposer does not own the published driver.')
    }

    await driver.dispose()

    const current = this.publishedByRuntime.get(runtime)
    if (current !== undefined && current.driver === driver) {
      this.publishedByRuntime.delete(runtime)
      if (this.runtimeBySessionFile.get(current.sessionFile) === runtime) {
        this.runtimeBySessionFile.delete(current.sessionFile)
      }
    }
    this.handles.delete(runtime)
  }

  dispose(): Promise<void> {
    if (this.status === 'disposed') return Promise.resolve()
    if (this.disposePromise !== null) return this.disposePromise
    this.status = 'disposing'
    const disposePromise = this.disposeHost()
    this.disposePromise = disposePromise
    void disposePromise.catch(() => {
      if (this.disposePromise === disposePromise) this.disposePromise = null
    })
    return disposePromise
  }

  private async disposeHost(): Promise<void> {
    const results = await Promise.allSettled([...this.handles].map(async (runtime) => runtime.stop()))
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    )
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Shared Pi Host failed to dispose every Session.')
    }
    if (
      this.handles.size !== 0 ||
      this.publishedByRuntime.size !== 0 ||
      this.runtimeBySessionFile.size !== 0
    ) {
      throw new Error('Shared Pi Host registry was not empty after Session disposal.')
    }
    this.environment.dispose()
    this.status = 'disposed'
  }
}

export class SharedPiRuntime implements RuntimeHost {
  private readonly host: SharedPiHost
  private readonly options: SharedPiRuntimeOptions
  private readonly listeners = new Set<(event: RuntimeHostEvent) => void>()
  private readonly extensionEventListeners = new Set<(event: PiRpcExtensionEvent) => void>()
  private readonly bufferedEvents: BufferedEvent[] = []
  private readonly quiescenceWaiters = new Map<string, {
    nonce: string
    resolve: (result: RuntimeQuiescenceQueryResult) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  private readonly leaseWaiters = new Map<string, {
    nonce: string
    action: RuntimeHibernateLeaseAction
    resolve: (result: RuntimeHibernateLeaseResult) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  private phase: RuntimePhase = 'new'
  private driver: SharedPiSessionDriver | null = null
  private preparedSessionFile: string | null = null
  private startPromise: Promise<void> | null = null
  private stopPromise: Promise<void> | null = null
  private stopRequested = false
  private streaming = false
  private streamingRevision = 0
  private hibernateLease: HibernateLease | null = null
  private state: RuntimeHostState = {
    executable: '@earendil-works/pi-coding-agent',
    version: VERSION,
    stderrSummary: '',
    stderrChars: 0,
    lastError: null,
    exitCode: null,
    exitSignal: null
  }

  constructor(host: SharedPiHost, options: SharedPiRuntimeOptions) {
    this.host = host
    this.options = options
  }

  retainFailedStartupDriver(driver: SharedPiSessionDriver): void {
    if (this.phase !== 'starting' || this.driver !== null) {
      throw new Error('Shared Pi Runtime cannot retain an unexpected failed-start driver.')
    }
    this.driver = driver
  }

  start(): Promise<void> {
    if (this.startPromise !== null) return this.startPromise
    if (this.phase !== 'new') throw new Error('Shared Pi Runtime cannot be started more than once.')
    this.phase = 'starting'
    this.state = { ...this.state, lastError: null }
    const promise = this.startRuntime()
    this.startPromise = promise
    return promise
  }

  private async startRuntime(): Promise<void> {
    try {
      const driver = await this.host.startRuntime(this, {
        cwd: this.options.cwd,
        sessionFile: this.options.sessionFile,
        projectTrust: this.options.projectTrust,
        fastExtensionLoading: this.options.fastExtensionLoading,
        extensionPaths: [...this.options.extensionPaths],
        subagentMaxDepth: this.options.subagent?.maxDepth,
        desktopNotification: this.options.desktopNotification,
        openAiFastMode: this.options.openAiFastMode
      })
      if (this.stopRequested) {
        await this.host.stopRuntime(this, driver)
        throw new Error('Shared Pi Runtime start was cancelled.')
      }
      if (this.preparedSessionFile !== driver.sessionFile) {
        await this.host.stopRuntime(this, driver)
        throw new Error('Shared Pi Session publication identity changed during startup.')
      }
      this.driver = driver
      this.phase = 'running'
      this.state = { ...this.state, lastError: null }
      this.flushBufferedEvents()
    } catch (error) {
      this.phase = 'crashed'
      this.state = { ...this.state, lastError: errorMessage(error) }
      this.emitNow({ type: 'process-exit', code: null, signal: null })
      throw error
    }
  }

  async handleIdentityChange(
    previousSessionFile: string | null,
    nextSessionFile: string
  ): Promise<void> {
    if (this.driver === null && this.phase === 'starting') {
      if (previousSessionFile !== null || this.preparedSessionFile !== null) {
        throw new Error('Shared Pi Session produced multiple identities before publication.')
      }
      this.preparedSessionFile = nextSessionFile
      return
    }
    this.host.replaceIdentity(this, previousSessionFile, nextSessionFile)
  }

  async send(command: RuntimeCommand): Promise<RuntimeCommandResult> {
    const driver = this.driver
    if (driver === null || this.phase !== 'running') {
      throw new Error('Shared Pi Runtime is not running.')
    }
    if (this.hibernateLease !== null && isMutatingRuntimeCommandType(command.type)) {
      throw new Error(
        `Runtime command ${command.type} is rejected while a hibernate lease is active.`
      )
    }
    const streamingRevision = this.streamingRevision
    const result = await driver.send(command)
    if (command.type === 'get_state' && result.type === 'state' && this.streamingRevision === streamingRevision) {
      this.updateStreamingState(result.state.isStreaming === true)
    }
    return result
  }

  stop(): Promise<void> {
    if (this.phase === 'stopped') return Promise.resolve()
    this.stopRequested = true
    this.rejectQuiescenceWaiters('stopping', 'Shared Pi Runtime is stopping.')
    this.rejectLeaseWaiters('stopping', 'Shared Pi Runtime is stopping.')
    if (this.stopPromise !== null) return this.stopPromise
    const promise = this.stopRuntime()
    this.stopPromise = promise
    void promise.then(
      () => {
        if (this.stopPromise === promise) this.stopPromise = null
      },
      () => {
        if (this.stopPromise === promise) this.stopPromise = null
      }
    )
    return promise
  }

  private async stopRuntime(): Promise<void> {
    const startPromise = this.startPromise
    if (startPromise !== null && this.phase === 'starting') {
      try {
        await startPromise
      } catch {
        // Failed and cancelled starts already dispose unpublished Sessions.
      }
    }
    const driver = this.driver
    if (driver === null) {
      this.host.releaseUnpublishedRuntime(this)
      this.phase = 'stopped'
      return
    }

    this.phase = 'stopping'
    try {
      await this.host.stopRuntime(this, driver)
      this.driver = null
      this.phase = 'stopped'
      this.streaming = false
      this.hibernateLease = null
      this.extensionEventListeners.clear()
    } catch (error) {
      this.phase = 'crashed'
      this.state = { ...this.state, lastError: errorMessage(error) }
      throw error
    }
  }

  getState(): RuntimeHostState {
    return { ...this.state }
  }

  getRpcPid(): number | null {
    return null
  }

  async getLoadedExtensions(): Promise<PiRpcExtensionInventory> {
    if (this.driver === null || this.phase !== 'running') {
      throw new Error('Shared Pi Runtime is not running.')
    }
    return this.driver.getLoadedExtensions()
  }

  subscribe(listener: (event: RuntimeHostEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  subscribeExtensionEvents(listener: (event: PiRpcExtensionEvent) => void): () => void {
    this.extensionEventListeners.add(listener)
    return () => this.extensionEventListeners.delete(listener)
  }

  handlePiEvent(event: PiRpcEvent): void {
    if (isInternalRuntimeStatusEvent(event)) {
      if (isQuiescenceStatusEvent(event)) this.handleQuiescenceStatusEvent(event)
      else if (isHibernateLeaseStatusEvent(event)) this.handleLeaseStatusEvent(event)
      return
    }
    if (event.type === 'agent_start') this.setStreamingFromLifecycleEvent(true)
    else if (event.type === 'agent_settled') this.setStreamingFromLifecycleEvent(false)
    this.publishOrBuffer({ kind: 'runtime', event: { type: 'pi-event', event } })
  }

  handleExtensionEvent(event: PiRpcExtensionEvent): void {
    this.publishOrBuffer({ kind: 'extension', event })
  }

  private publishOrBuffer(event: BufferedEvent): void {
    if (this.phase === 'running') {
      this.publishBufferedEvent(event)
      return
    }
    if (this.phase === 'starting') this.bufferedEvents.push(event)
  }

  private flushBufferedEvents(): void {
    for (const event of this.bufferedEvents.splice(0)) this.publishBufferedEvent(event)
  }

  private publishBufferedEvent(event: BufferedEvent): void {
    if (event.kind === 'runtime') {
      this.emitNow(event.event)
      return
    }
    for (const listener of this.extensionEventListeners) listener(event.event)
  }

  private emitNow(event: RuntimeHostEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  async queryQuiescence(options?: { timeoutMs?: number }): Promise<RuntimeQuiescenceQueryResult> {
    if (this.stopRequested) {
      return { ok: false, reason: 'stopping', message: 'Shared Pi Runtime is stopping.' }
    }
    const driver = this.driver
    if (driver === null || this.phase !== 'running') {
      return { ok: false, reason: 'runtime-not-running', message: 'Shared Pi Runtime is not running.' }
    }
    if (this.options.quiescenceExtensionPath === undefined) {
      return { ok: false, reason: 'extension-missing', message: 'Runtime quiescence extension path is not configured.' }
    }
    const timeout = normalizeQuiescenceTimeoutMs(options?.timeoutMs)
    if (!timeout.ok) {
      return { ok: false, reason: 'malformed', message: `Quiescence query timeout rejected: ${timeout.reason}.` }
    }
    const nonce = randomUUID()
    const prompt = buildQuiescencePrompt(nonce)
    return await new Promise<RuntimeQuiescenceQueryResult>((resolve) => {
      const timer = setTimeout(() => {
        this.quiescenceWaiters.delete(nonce)
        resolve({
          ok: false,
          reason: 'timeout',
          message: `Quiescence query timed out after ${timeout.timeoutMs}ms.`,
          nonce
        })
      }, timeout.timeoutMs)
      this.quiescenceWaiters.set(nonce, { nonce, resolve, timer })
      void driver.send({ type: 'prompt', message: prompt }).catch((error: unknown) => {
        const waiter = this.quiescenceWaiters.get(nonce)
        if (waiter === undefined) return
        clearTimeout(waiter.timer)
        this.quiescenceWaiters.delete(nonce)
        resolve({ ok: false, reason: 'prompt-failed', message: errorMessage(error), nonce })
      })
    })
  }

  async prepareHibernation(input: {
    sessionId: string
    generation: number
    attemptId: string
    timeoutMs?: number
  }): Promise<RuntimeHibernateLeaseResult> {
    const validated = this.validateLeaseIdentity(input, false)
    if (!validated.ok) return validated
    if (this.hibernateLease !== null) {
      return { ok: false, reason: 'fenced', message: 'A hibernate lease is already active on this runtime.', action: 'prepare' }
    }
    this.hibernateLease = { phase: 'preparing', ...input }
    const result = await this.runLeaseCommand({ action: 'prepare', ...input })
    if (!result.ok) {
      this.hibernateLease = null
      return result
    }
    if (typeof result.token !== 'string' || !isValidLeaseToken(result.token)) {
      this.hibernateLease = null
      return { ok: false, reason: 'malformed', message: 'Prepare succeeded without a valid lease token.', action: 'prepare' }
    }
    this.hibernateLease = { phase: 'prepared', ...input, token: result.token }
    return result
  }

  async commitHibernation(input: {
    sessionId: string
    generation: number
    attemptId: string
    token: string
    timeoutMs?: number
  }): Promise<RuntimeHibernateLeaseResult> {
    const validated = this.validateLeaseIdentity(input, true)
    if (!validated.ok) return validated
    const lease = this.hibernateLease
    if (
      lease === null || lease.phase === 'preparing' ||
      lease.sessionId !== input.sessionId || lease.generation !== input.generation ||
      lease.attemptId !== input.attemptId || lease.token !== input.token
    ) {
      return { ok: false, reason: 'identity-mismatch', message: 'Commit identity does not match the active prepared lease.', action: 'commit' }
    }
    if (lease.phase === 'committed') {
      return { ok: true, action: 'commit', sessionId: input.sessionId, generation: input.generation, attemptId: input.attemptId, token: input.token }
    }
    const result = await this.runLeaseCommand({ action: 'commit', ...input })
    if (result.ok) this.hibernateLease = { phase: 'committed', ...input }
    return result
  }

  async releaseHibernation(input: {
    sessionId: string
    generation: number
    attemptId: string
    token: string
    timeoutMs?: number
  }): Promise<RuntimeHibernateLeaseResult> {
    const validated = this.validateLeaseIdentity(input, true)
    if (!validated.ok) return validated
    const lease = this.hibernateLease
    if (
      lease === null || lease.phase === 'preparing' ||
      lease.sessionId !== input.sessionId || lease.generation !== input.generation ||
      lease.attemptId !== input.attemptId || lease.token !== input.token
    ) {
      return { ok: false, reason: 'identity-mismatch', message: 'Release identity does not match the active lease generation/token.', action: 'release' }
    }
    if (this.driver === null || this.phase !== 'running') {
      this.hibernateLease = null
      return { ok: true, action: 'release', sessionId: input.sessionId, generation: input.generation, attemptId: input.attemptId, token: input.token }
    }
    const result = await this.runLeaseCommand({ action: 'release', ...input })
    const currentLease = this.hibernateLease
    if (
      result.ok && currentLease !== null && currentLease.phase !== 'preparing' &&
      currentLease.attemptId === input.attemptId && currentLease.token === input.token
    ) {
      this.hibernateLease = null
      this.stopRequested = false
    }
    return result
  }

  private validateLeaseIdentity(
    input: { sessionId: string, generation: number, attemptId: string, token?: string },
    requireToken: boolean
  ): { ok: true } | RuntimeHibernateLeaseResult {
    if (!isValidSessionId(input.sessionId)) return { ok: false, reason: 'invalid-input', message: 'Hibernate lease sessionId is invalid.' }
    if (!isValidRuntimeGeneration(input.generation)) return { ok: false, reason: 'invalid-input', message: 'Hibernate lease generation is invalid.' }
    if (!isValidAttemptId(input.attemptId)) return { ok: false, reason: 'invalid-input', message: 'Hibernate lease attemptId is invalid.' }
    if (requireToken && !isValidLeaseToken(input.token)) return { ok: false, reason: 'invalid-input', message: 'Hibernate lease token is invalid.' }
    return { ok: true }
  }

  private async runLeaseCommand(input: {
    action: RuntimeHibernateLeaseAction
    sessionId: string
    generation: number
    attemptId: string
    token?: string
    timeoutMs?: number
  }): Promise<RuntimeHibernateLeaseResult> {
    if (this.stopRequested && input.action !== 'release') {
      return { ok: false, reason: 'stopping', message: 'Shared Pi Runtime is stopping; new hibernate lease commands are rejected.', action: input.action }
    }
    const driver = this.driver
    if (driver === null || this.phase !== 'running') {
      return { ok: false, reason: 'runtime-not-running', message: 'Shared Pi Runtime is not running.', action: input.action }
    }
    if (this.options.quiescenceExtensionPath === undefined) {
      return { ok: false, reason: 'extension-missing', message: 'Runtime quiescence extension path is not configured.', action: input.action }
    }
    const timeout = normalizeHibernateLeaseTimeoutMs(input.timeoutMs)
    if (!timeout.ok) {
      return { ok: false, reason: 'malformed', message: `Hibernate lease timeout rejected: ${timeout.reason}.`, action: input.action }
    }
    const nonce = randomUUID()
    let prompt: string
    try {
      prompt = buildHibernateLeasePrompt({
        action: input.action,
        nonce,
        sessionId: input.sessionId,
        generation: input.generation,
        attemptId: input.attemptId,
        ...(input.token === undefined ? {} : { token: input.token })
      })
    } catch (error) {
      return { ok: false, reason: 'invalid-input', message: errorMessage(error), action: input.action }
    }
    return await new Promise<RuntimeHibernateLeaseResult>((resolve) => {
      const timer = setTimeout(() => {
        this.leaseWaiters.delete(nonce)
        resolve({
          ok: false,
          reason: 'timeout',
          message: `Hibernate lease ${input.action} timed out after ${timeout.timeoutMs}ms.`,
          action: input.action,
          nonce
        })
      }, timeout.timeoutMs)
      this.leaseWaiters.set(nonce, { nonce, action: input.action, resolve, timer })
      void driver.send({ type: 'prompt', message: prompt }).catch((error: unknown) => {
        const waiter = this.leaseWaiters.get(nonce)
        if (waiter === undefined) return
        clearTimeout(waiter.timer)
        this.leaseWaiters.delete(nonce)
        resolve({ ok: false, reason: 'prompt-failed', message: errorMessage(error), action: input.action, nonce })
      })
    })
  }

  private handleQuiescenceStatusEvent(event: PiRpcEvent): void {
    const statusText = typeof event.statusText === 'string' ? event.statusText : undefined
    if (statusText === undefined) return
    const nonce = this.parseStatusNonce(statusText)
    if (nonce === null) return
    const waiter = this.quiescenceWaiters.get(nonce)
    if (waiter === undefined) return
    clearTimeout(waiter.timer)
    this.quiescenceWaiters.delete(nonce)
    waiter.resolve(interpretQuiescenceStatusText(statusText, nonce))
  }

  private handleLeaseStatusEvent(event: PiRpcEvent): void {
    const statusText = typeof event.statusText === 'string' ? event.statusText : undefined
    if (statusText === undefined) return
    const nonce = this.parseStatusNonce(statusText)
    if (nonce === null) return
    const waiter = this.leaseWaiters.get(nonce)
    if (waiter === undefined) return
    clearTimeout(waiter.timer)
    this.leaseWaiters.delete(nonce)
    waiter.resolve(interpretHibernateLeaseStatusText(statusText, nonce, waiter.action))
  }

  private parseStatusNonce(statusText: string): string | null {
    try {
      const parsed = JSON.parse(statusText) as { nonce?: unknown }
      return typeof parsed.nonce === 'string' ? parsed.nonce : null
    } catch {
      return null
    }
  }

  private rejectQuiescenceWaiters(
    reason: Extract<RuntimeQuiescenceQueryResult, { ok: false }>['reason'],
    message: string
  ): void {
    for (const [nonce, waiter] of this.quiescenceWaiters) {
      clearTimeout(waiter.timer)
      waiter.resolve({ ok: false, reason, message, nonce })
    }
    this.quiescenceWaiters.clear()
  }

  private rejectLeaseWaiters(
    reason: Extract<RuntimeHibernateLeaseResult, { ok: false }>['reason'],
    message: string
  ): void {
    for (const [nonce, waiter] of this.leaseWaiters) {
      clearTimeout(waiter.timer)
      waiter.resolve({ ok: false, reason, message, action: waiter.action, nonce })
    }
    this.leaseWaiters.clear()
  }

  private setStreamingFromLifecycleEvent(nextStreaming: boolean): void {
    this.streaming = nextStreaming
    this.streamingRevision += 1
  }

  private updateStreamingState(nextStreaming: boolean): void {
    if (this.streaming === nextStreaming) return
    this.streaming = nextStreaming
    this.streamingRevision += 1
    this.emitNow({ type: nextStreaming ? 'activity-started' : 'activity-settled' })
  }
}
