import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import type { PiRpcExtensionEvent, PiRpcExtensionInventory } from '../pi-rpc/pi-rpc-data.ts'
import { NOOP_LOGGER, type JsonlLogger } from '../utils/jsonl-log.ts'
import { errorMessage } from '../utils/errors.ts'
import {
  PI_RUNTIME_LOG_DIRECTORY_ENV,
  PI_RUNTIME_PENDING_REQUEST_LIMIT,
  parsePiRuntimeMessage,
  type PiRuntimeMessage,
  type PiRuntimeRemoteMethod,
  type PiRuntimeRequest
} from './pi-runtime-protocol.ts'
import type {
  RuntimeHibernateLeaseResult,
  RuntimeQuiescenceQueryResult
} from './runtime-quiescence.ts'
import type {
  RuntimeCommand,
  RuntimeCommandResult,
  RuntimeHost,
  RuntimeHostEvent,
  RuntimeHostState
} from './runtime-host.ts'
import type { SharedPiRuntimeOptions } from './shared-pi-host.ts'

export type PiRuntimeProcessHostOptions = {
  /** Built child entry (out/main/pi-runtime-host.js) or a TypeScript source path in tests. */
  entryPath: string
  executable?: string
  env?: NodeJS.ProcessEnv
  /** Passed to the child for its own JSON Lines log. */
  logDirectory?: string
  logger?: JsonlLogger
  /** Child stdout/stderr, including Extension console output. Never the Main stdout pipe. */
  forwardOutput?: (chunk: Buffer) => void
  readyTimeoutMs?: number
  restartWindowMs?: number
  maxStartsPerWindow?: number
  maxPendingRequests?: number
  disposeTimeoutMs?: number
  killGraceMs?: number
  now?: () => number
}

type ExitResult = { code: number | null; signal: NodeJS.Signals | null }

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  runtime: PiProcessRuntime | null
}

type ProcessRecord = {
  generation: number
  child: ChildProcess
  pid: number | null
  ready: Promise<void>
  exited: ExitResult | null
  exit: Promise<ExitResult>
  pending: Map<number, PendingRequest>
  runtimes: Map<string, PiProcessRuntime>
}

type RuntimePhase = 'new' | 'starting' | 'running' | 'stopping' | 'stopped' | 'crashed'

const COMPONENT = 'pi-runtime-process'

export class PiRuntimeProcessError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PiRuntimeProcessError'
  }
}

/**
 * Main-side owner of the single shared Pi Runtime process (D-094/D-099). The process starts
 * only when a Runtime needs it, is never restarted in the background, and never replays work.
 */
export class PiRuntimeProcessHost {
  private readonly options: Required<Omit<PiRuntimeProcessHostOptions, 'logDirectory'>> & { logDirectory?: string }
  private current: ProcessRecord | null = null
  private generation = 0
  private nextRequestId = 0
  private starts: number[] = []
  private disposing = false
  private disposePromise: Promise<void> | null = null

  constructor(options: PiRuntimeProcessHostOptions) {
    this.options = {
      executable: process.execPath,
      env: process.env,
      logger: NOOP_LOGGER,
      forwardOutput: (chunk) => { process.stderr.write(chunk) },
      readyTimeoutMs: 60_000,
      restartWindowMs: 120_000,
      maxStartsPerWindow: 3,
      maxPendingRequests: PI_RUNTIME_PENDING_REQUEST_LIMIT,
      disposeTimeoutMs: 10_000,
      killGraceMs: 2_000,
      now: Date.now,
      ...options
    }
  }

  createRuntime(options: SharedPiRuntimeOptions): RuntimeHost {
    if (this.disposing) throw new Error('Shared Pi Host is not accepting new Sessions.')
    return new PiProcessRuntime(this, options)
  }

  /** Real PID of the shared Runtime process, reported as shared rather than per Session. */
  getPid(): number | null {
    const record = this.current
    return record === null || record.exited !== null ? null : record.pid
  }

  dispose(): Promise<void> {
    this.disposePromise ??= this.disposeProcess()
    return this.disposePromise
  }

  /** @internal Used by PiProcessRuntime. */
  async acquire(): Promise<ProcessRecord> {
    if (this.disposing) throw new PiRuntimeProcessError('Shared Pi Host is not accepting Session starts.')
    const existing = this.current
    if (existing !== null && existing.exited === null) {
      await existing.ready
      return existing
    }
    const now = this.options.now()
    this.starts = this.starts.filter((time) => now - time < this.options.restartWindowMs)
    if (this.starts.length >= this.options.maxStartsPerWindow) {
      this.options.logger.write('error', COMPONENT, 'start-limit-reached', {
        starts: this.starts.length,
        windowMs: this.options.restartWindowMs
      })
      throw new PiRuntimeProcessError(
        `The Pi Runtime process started ${this.starts.length} times within ` +
        `${Math.round(this.options.restartWindowMs / 60_000)} minutes; automatic start is paused. ` +
        'Try again later or restart Pi GUI.'
      )
    }
    this.starts.push(now)
    const record = this.spawnProcess()
    this.current = record
    await record.ready
    return record
  }

  /** @internal Used by PiProcessRuntime. */
  request(
    record: ProcessRecord,
    message: DistributiveOmit<PiRuntimeRequest, 'id'>,
    runtime: PiProcessRuntime | null
  ): Promise<unknown> {
    if (record.exited !== null) {
      return Promise.reject(new PiRuntimeProcessError('The Pi Runtime process has exited.'))
    }
    if (record.pending.size >= this.options.maxPendingRequests) {
      this.options.logger.write('error', COMPONENT, 'pending-request-limit', {
        generation: record.generation,
        pending: record.pending.size
      })
      this.terminate(record, 'SIGKILL')
      return Promise.reject(new PiRuntimeProcessError('The Pi Runtime process stopped responding.'))
    }
    const id = ++this.nextRequestId
    return new Promise((resolve, reject) => {
      record.pending.set(id, { resolve, reject, runtime })
      try {
        record.child.send({ ...message, id }, (error) => {
          if (error === null) return
          const pending = record.pending.get(id)
          if (pending === undefined) return
          record.pending.delete(id)
          pending.reject(new PiRuntimeProcessError(`The Pi Runtime process is unavailable: ${error.message}`))
        })
      } catch (error) {
        record.pending.delete(id)
        reject(new PiRuntimeProcessError(`The Pi Runtime process is unavailable: ${errorMessage(error)}`))
      }
    })
  }

  private spawnProcess(): ProcessRecord {
    const generation = ++this.generation
    const env: NodeJS.ProcessEnv = { ...this.options.env, ELECTRON_RUN_AS_NODE: '1' }
    if (this.options.logDirectory !== undefined) env[PI_RUNTIME_LOG_DIRECTORY_ENV] = this.options.logDirectory
    const child = spawn(this.options.executable, [this.options.entryPath], {
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      serialization: 'json',
      // Own process group, so tool descendants are reaped with the Runtime process.
      detached: process.platform !== 'win32',
      windowsHide: true
    })
    let resolveReady!: () => void
    let rejectReady!: (error: Error) => void
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    // Callers observe readiness through acquire(); never leave a detached rejection.
    ready.catch(() => undefined)
    let resolveExit!: (result: ExitResult) => void
    const record: ProcessRecord = {
      generation,
      child,
      pid: child.pid ?? null,
      ready,
      exited: null,
      exit: new Promise((resolve) => { resolveExit = resolve }),
      pending: new Map(),
      runtimes: new Map()
    }
    this.options.logger.write('info', COMPONENT, 'spawn', { generation, pid: record.pid })

    const readyTimer = setTimeout(() => {
      this.options.logger.write('error', COMPONENT, 'ready-timeout', { generation })
      rejectReady(new PiRuntimeProcessError('The Pi Runtime process did not become ready in time.'))
      this.terminate(record, 'SIGKILL')
    }, this.options.readyTimeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => this.options.forwardOutput(chunk))
    child.stderr?.on('data', (chunk: Buffer) => this.options.forwardOutput(chunk))

    child.on('message', (text: unknown) => {
      if (record.exited !== null) return
      const message = parsePiRuntimeMessage(text)
      if (message === null) {
        this.options.logger.write('error', COMPONENT, 'protocol-error', { generation })
        this.terminate(record, 'SIGKILL')
        return
      }
      if (message.type === 'ready') {
        clearTimeout(readyTimer)
        record.pid = message.pid
        this.options.logger.write('info', COMPONENT, 'ready', { generation, pid: message.pid, version: message.version })
        resolveReady()
        return
      }
      this.handleMessage(record, message)
    })

    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (record.exited !== null) return
      clearTimeout(readyTimer)
      const result = { code, signal }
      record.exited = result
      if (this.current === record) this.current = null
      rejectReady(new PiRuntimeProcessError(`The Pi Runtime process exited before it was ready (${code ?? signal ?? 'unknown'}).`))
      this.options.logger.write(this.disposing ? 'info' : 'error', COMPONENT, 'exit', {
        generation,
        code,
        signal,
        expected: this.disposing,
        runtimes: record.runtimes.size,
        pending: record.pending.size
      })
      const exitError = new PiRuntimeProcessError(`The Pi Runtime process exited (${code ?? signal ?? 'unknown'}).`)
      for (const pending of record.pending.values()) pending.reject(exitError)
      record.pending.clear()
      const runtimes = [...record.runtimes.values()]
      record.runtimes.clear()
      for (const runtime of runtimes) runtime.handleProcessExit(code, signal)
      // Reap Extension/tool descendants left in the Runtime process group.
      this.signalGroup(record, 'SIGKILL')
      resolveExit(result)
    }
    child.once('exit', onExit)
    child.once('error', (error) => {
      this.options.logger.write('error', COMPONENT, 'process-error', { generation, message: error.message })
      onExit(null, null)
    })
    return record
  }

  private handleMessage(record: ProcessRecord, message: Exclude<PiRuntimeMessage, { type: 'ready' }>): void {
    if (message.type === 'response') {
      const pending = record.pending.get(message.id)
      if (pending === undefined) return
      record.pending.delete(message.id)
      if (message.state !== undefined) pending.runtime?.applyState(message.state)
      if (message.ok) pending.resolve(message.value)
      else pending.reject(new Error(message.message))
      return
    }
    const runtime = record.runtimes.get(message.runtimeId)
    if (runtime === undefined) return
    if (message.type === 'event') runtime.handleEvent(message.event, message.state)
    else runtime.handleExtensionEvent(message.event)
  }

  private terminate(record: ProcessRecord, signal: NodeJS.Signals): void {
    if (record.exited !== null) return
    this.signalGroup(record, signal)
  }

  private signalGroup(record: ProcessRecord, signal: NodeJS.Signals): void {
    const pid = record.child.pid
    if (pid === undefined) return
    try {
      if (process.platform === 'win32') throw new Error('no process groups')
      process.kill(-pid, signal)
    } catch {
      if (record.exited === null) {
        try { record.child.kill(signal) } catch { /* Already exited. */ }
      }
    }
  }

  private async disposeProcess(): Promise<void> {
    this.disposing = true
    const record = this.current
    if (record === null || record.exited !== null) return
    try {
      await record.ready
    } catch {
      await record.exit
      return
    }
    const response = this.request(record, { type: 'dispose' }, null).then(
      () => null,
      (error: unknown) => error
    )
    if (!await settlesWithin(record.exit, this.options.disposeTimeoutMs)) {
      this.options.logger.write('error', COMPONENT, 'dispose-timeout', {
        generation: record.generation,
        timeoutMs: this.options.disposeTimeoutMs
      })
      this.terminate(record, 'SIGTERM')
      if (!await settlesWithin(record.exit, this.options.killGraceMs)) {
        this.terminate(record, 'SIGKILL')
        await record.exit
      }
      throw new PiRuntimeProcessError(
        `The Pi Runtime process did not stop within ${this.options.disposeTimeoutMs / 1_000} seconds and was terminated.`
      )
    }
    const exit = await record.exit
    const responseError = await response
    if (responseError instanceof Error && !(responseError instanceof PiRuntimeProcessError)) throw responseError
    if (exit.code !== 0) {
      throw new PiRuntimeProcessError(`The Pi Runtime process failed to stop cleanly (${exit.code ?? exit.signal ?? 'unknown'}).`)
    }
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs) })
  try {
    return await Promise.race([promise.then(() => true), timeout])
  } finally {
    clearTimeout(timer)
  }
}

const NOT_RUNNING = 'Shared Pi Runtime is not running.'

/** RuntimeHost handle for one Session inside the shared Pi Runtime process. */
class PiProcessRuntime implements RuntimeHost {
  private readonly runtimeId = randomUUID()
  private readonly listeners = new Set<(event: RuntimeHostEvent) => void>()
  private readonly extensionEventListeners = new Set<(event: PiRpcExtensionEvent) => void>()
  private record: ProcessRecord | null = null
  private phase: RuntimePhase = 'new'
  private startPromise: Promise<void> | null = null
  private stopPromise: Promise<void> | null = null
  private stopRequested = false
  private state: RuntimeHostState = {
    executable: '@earendil-works/pi-coding-agent',
    version: null,
    stderrSummary: '',
    stderrChars: 0,
    lastError: null,
    exitCode: null,
    exitSignal: null
  }

  private readonly host: PiRuntimeProcessHost
  private readonly options: SharedPiRuntimeOptions

  constructor(host: PiRuntimeProcessHost, options: SharedPiRuntimeOptions) {
    this.host = host
    this.options = options
  }

  start(): Promise<void> {
    if (this.startPromise !== null) return this.startPromise
    if (this.phase !== 'new') throw new Error('Shared Pi Runtime cannot be started more than once.')
    this.phase = 'starting'
    this.startPromise = this.startRuntime()
    return this.startPromise
  }

  private async startRuntime(): Promise<void> {
    let record: ProcessRecord
    try {
      record = await this.host.acquire()
    } catch (error) {
      this.fail(errorMessage(error))
      this.emit({ type: 'process-exit', code: null, signal: null })
      throw error
    }
    this.record = record
    record.runtimes.set(this.runtimeId, this)
    try {
      await this.host.request(record, { type: 'start', runtimeId: this.runtimeId, options: this.options }, this)
    } catch (error) {
      // A child-side failure already emitted its own process-exit; a process exit did too.
      if (this.phase === 'starting') this.fail(errorMessage(error))
      throw error
    }
    if (this.phase !== 'starting') throw new Error(this.state.lastError ?? NOT_RUNNING)
    this.phase = 'running'
  }

  async send(command: RuntimeCommand): Promise<RuntimeCommandResult> {
    return await this.call('send', [command]) as RuntimeCommandResult
  }

  stop(): Promise<void> {
    if (this.phase === 'stopped') return Promise.resolve()
    this.stopRequested = true
    if (this.stopPromise !== null) return this.stopPromise
    const promise = this.stopRuntime()
    this.stopPromise = promise
    const clear = (): void => { if (this.stopPromise === promise) this.stopPromise = null }
    void promise.then(clear, clear)
    return promise
  }

  private async stopRuntime(): Promise<void> {
    if (this.startPromise !== null && this.phase === 'starting') {
      try { await this.startPromise } catch { /* A failed start still needs its child-side release. */ }
    }
    const record = this.record
    if (record === null || record.exited !== null || !record.runtimes.has(this.runtimeId)) {
      this.markStopped()
      return
    }
    this.phase = 'stopping'
    try {
      await this.host.request(record, { type: 'call', runtimeId: this.runtimeId, method: 'stop', args: [] }, this)
      record.runtimes.delete(this.runtimeId)
      this.markStopped()
    } catch (error) {
      if (record.exited !== null) {
        this.markStopped()
        return
      }
      this.fail(errorMessage(error))
      throw error
    }
  }

  getState(): RuntimeHostState {
    return { ...this.state }
  }

  getRpcPid(): number | null {
    // The shared process is not a per-Session process; Main reports its PID separately.
    return null
  }

  async getLoadedExtensions(): Promise<PiRpcExtensionInventory> {
    return await this.call('getLoadedExtensions', []) as PiRpcExtensionInventory
  }

  subscribe(listener: (event: RuntimeHostEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  subscribeExtensionEvents(listener: (event: PiRpcExtensionEvent) => void): () => void {
    this.extensionEventListeners.add(listener)
    return () => this.extensionEventListeners.delete(listener)
  }

  async queryQuiescence(options?: { timeoutMs?: number }): Promise<RuntimeQuiescenceQueryResult> {
    if (this.stopRequested) return { ok: false, reason: 'stopping', message: 'Shared Pi Runtime is stopping.' }
    if (!this.isRunning()) return { ok: false, reason: 'runtime-not-running', message: NOT_RUNNING }
    try {
      return await this.call('queryQuiescence', options === undefined ? [] : [options]) as RuntimeQuiescenceQueryResult
    } catch (error) {
      return { ok: false, reason: 'runtime-not-running', message: errorMessage(error) }
    }
  }

  prepareHibernation(input: {
    sessionId: string
    generation: number
    attemptId: string
    timeoutMs?: number
  }): Promise<RuntimeHibernateLeaseResult> {
    return this.callLease('prepareHibernation', 'prepare', input)
  }

  commitHibernation(input: {
    sessionId: string
    generation: number
    attemptId: string
    token: string
    timeoutMs?: number
  }): Promise<RuntimeHibernateLeaseResult> {
    return this.callLease('commitHibernation', 'commit', input)
  }

  releaseHibernation(input: {
    sessionId: string
    generation: number
    attemptId: string
    token: string
    timeoutMs?: number
  }): Promise<RuntimeHibernateLeaseResult> {
    return this.callLease('releaseHibernation', 'release', input)
  }

  /** @internal */
  applyState(state: RuntimeHostState): void {
    this.state = { ...state }
  }

  /** @internal */
  handleEvent(event: RuntimeHostEvent, state: RuntimeHostState): void {
    this.applyState(state)
    this.emit(event)
  }

  /** @internal */
  handleExtensionEvent(event: PiRpcExtensionEvent): void {
    for (const listener of this.extensionEventListeners) listener(event)
  }

  /** @internal The shared process exited; this Runtime cannot continue and nothing is replayed. */
  handleProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.phase === 'new' || this.phase === 'stopped') return
    this.phase = 'crashed'
    this.state = {
      ...this.state,
      exitCode: code,
      exitSignal: signal,
      lastError: `The Pi Runtime process exited (${code ?? signal ?? 'unknown'}).`
    }
    this.emit({ type: 'process-exit', code, signal })
  }

  private async call(method: PiRuntimeRemoteMethod, args: unknown[]): Promise<unknown> {
    const record = this.record
    if (record === null || !this.isRunning()) throw new Error(NOT_RUNNING)
    return await this.host.request(record, { type: 'call', runtimeId: this.runtimeId, method, args }, this)
  }

  private async callLease(
    method: 'prepareHibernation' | 'commitHibernation' | 'releaseHibernation',
    action: 'prepare' | 'commit' | 'release',
    input: { sessionId: string, generation: number, attemptId: string, token?: string, timeoutMs?: number }
  ): Promise<RuntimeHibernateLeaseResult> {
    const record = this.record
    if (action === 'release' && (record === null || record.exited !== null) && input.token !== undefined) {
      // The lease lived in the exited process; nothing remains to reopen.
      return { ok: true, action, sessionId: input.sessionId, generation: input.generation, attemptId: input.attemptId, token: input.token }
    }
    if (!this.isRunning()) return { ok: false, reason: 'runtime-not-running', message: NOT_RUNNING, action }
    try {
      return await this.call(method, [input]) as RuntimeHibernateLeaseResult
    } catch (error) {
      return { ok: false, reason: 'runtime-not-running', message: errorMessage(error), action }
    }
  }

  private isRunning(): boolean {
    return this.phase === 'running' && this.record !== null && this.record.exited === null
  }

  private markStopped(): void {
    this.phase = 'stopped'
    this.extensionEventListeners.clear()
  }

  private fail(message: string): void {
    this.phase = 'crashed'
    this.state = { ...this.state, lastError: message }
  }

  private emit(event: RuntimeHostEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}
