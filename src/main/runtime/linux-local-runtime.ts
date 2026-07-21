import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { isAbsolute } from 'node:path'

import {
  PiRpcClient,
  type PiRpcDiagnostic,
  type PiRpcEvent,
  type PiRpcSessionState
} from '../pi-rpc/pi-rpc-client.ts'
import type {
  RuntimeCommand,
  RuntimeCommandResult,
  RuntimeHost,
  RuntimeHostEvent,
  RuntimeHostState
} from './runtime-host.ts'
import {
  checkPiVersion,
  resolvePiExecutable,
  type ResolvePiExecutableOptions
} from './pi-executable.ts'

const DEFAULT_RPC_TIMEOUT_MS = 10_000
const STOP_GRACE_MS = 1_000

export type LinuxLocalRuntimeOptions = {
  cwd: string
  explicitExecutable?: string
  path?: string
  versionTimeoutMs?: number
  rpcTimeoutMs?: number
  sessionFile?: string
  noSession?: boolean
}

export function buildPiRpcArguments(sessionFile?: string, noSession = false): string[] {
  if (sessionFile !== undefined && noSession) {
    throw new Error('Session file and no-session mode cannot be used together.')
  }
  const arguments_ = ['--mode', 'rpc', '--offline']
  if (sessionFile !== undefined) {
    if (!isAbsolute(sessionFile)) {
      throw new Error(`Session file must be an absolute path: ${sessionFile}`)
    }
    arguments_.push('--session', sessionFile)
  } else if (noSession) {
    arguments_.push('--no-session')
  }
  return arguments_
}

export type PiRpcProbeResult = {
  executable: string
  version: string
  state: PiRpcSessionState
  stderrChars: number
}

export class LinuxLocalRuntime implements RuntimeHost {
  private readonly options: LinuxLocalRuntimeOptions
  private readonly listeners = new Set<(event: RuntimeHostEvent) => void>()
  private child: ChildProcessWithoutNullStreams | null = null
  private client: PiRpcClient | null = null
  private streaming = false
  private startPromise: Promise<void> | null = null
  private stopPromise: Promise<void> | null = null
  private stopRequested = false
  private state: RuntimeHostState = {
    executable: null,
    version: null,
    stderrChars: 0,
    stderrSummary: null,
    lastError: null,
    exitCode: null,
    exitSignal: null
  }

  constructor(options: LinuxLocalRuntimeOptions) {
    if (options.sessionFile !== undefined && options.noSession) {
      throw new Error('Session file and no-session mode cannot be used together.')
    }
    if (options.sessionFile !== undefined && !isAbsolute(options.sessionFile)) {
      throw new Error(`Session file must be an absolute path: ${options.sessionFile}`)
    }
    this.options = options
  }

  start(): Promise<void> {
    if (this.startPromise !== null) {
      return this.startPromise
    }
    if (this.child !== null && !hasExited(this.child)) {
      return Promise.reject(new Error('Pi RPC process is already running.'))
    }

    this.stopRequested = false
    const startPromise = this.startRuntime()
    this.startPromise = startPromise
    void startPromise.then(
      () => {
        if (this.startPromise === startPromise) this.startPromise = null
      },
      () => {
        if (this.startPromise === startPromise) this.startPromise = null
      }
    )
    return startPromise
  }

  private async startRuntime(): Promise<void> {
    const resolveOptions: ResolvePiExecutableOptions = {
      explicitPath: this.options.explicitExecutable,
      path: this.options.path
    }
    const executable = resolvePiExecutable(resolveOptions)
    let version: string
    try {
      version = await checkPiVersion({
        executable,
        cwd: this.options.cwd,
        timeoutMs: this.options.versionTimeoutMs
      })
    } catch (error) {
      if (this.stopRequested) throw startCancelledError()
      throw error
    }
    this.assertStartNotCancelled()

    const child = spawn(
      executable,
      buildPiRpcArguments(this.options.sessionFile, this.options.noSession),
      {
        cwd: this.options.cwd,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe']
      }
    )
    this.child = child
    this.streaming = false
    this.state = {
      executable,
      version,
      stderrChars: 0,
      stderrSummary: null,
      lastError: null,
      exitCode: null,
      exitSignal: null
    }
    const client = new PiRpcClient(child, {
      requestTimeoutMs: this.options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS,
      onDiagnostic: (diagnostic) => this.handleDiagnostic(diagnostic),
      onEvent: (event) => this.handlePiEvent(event)
    })
    this.client = client

    try {
      const initialState = await client.getState()
      this.assertStartNotCancelled()
      this.streaming = initialState.isStreaming === true
    } catch (error) {
      const cancelled = this.stopRequested
      let cleanupError: unknown = null
      try {
        await stopProcess(child)
      } catch (stopError) {
        cleanupError = stopError
      }
      if (cleanupError === null && this.child === child) {
        this.child = null
        this.client = null
        this.streaming = false
      }
      if (cleanupError !== null) {
        throw new Error(
          `${cancelled ? 'Runtime start was cancelled' : errorMessage(error)} ` +
          `and the Pi RPC process could not be stopped: ${errorMessage(cleanupError)}`
        )
      }
      if (cancelled) throw startCancelledError()
      this.state = { ...this.state, lastError: errorMessage(error) }
      throw enrichRuntimeError(error, this.state.stderrChars)
    }
  }

  async send(command: RuntimeCommand): Promise<RuntimeCommandResult> {
    if (this.client === null || this.child === null || hasExited(this.child)) {
      throw new Error('Pi RPC process is not running.')
    }

    if (command.type === 'get_state') {
      const state = await this.client.getState()
      this.updateStreamingState(state.isStreaming === true)
      return { type: 'state', state }
    }
    if (command.type === 'get_messages') {
      return { type: 'messages', messages: await this.client.getMessages() }
    }
    if (command.type === 'prompt') {
      await this.client.prompt(command.message)
      return { type: 'accepted' }
    }
    if (command.type === 'abort') {
      await this.client.abort()
      return { type: 'accepted' }
    }
    if (command.type === 'set_model') {
      const model = await this.client.setModel(command.provider, command.modelId)
      return { type: 'model', model }
    }

    await this.client.setThinkingLevel(command.level)
    return { type: 'accepted' }
  }

  stop(): Promise<void> {
    this.stopRequested = true
    if (this.stopPromise !== null) {
      return this.stopPromise
    }

    const stopPromise = this.stopRuntime()
    this.stopPromise = stopPromise
    void stopPromise.then(
      () => {
        if (this.stopPromise === stopPromise) this.stopPromise = null
      },
      () => {
        if (this.stopPromise === stopPromise) this.stopPromise = null
      }
    )
    return stopPromise
  }

  getState(): RuntimeHostState {
    return { ...this.state }
  }

  subscribe(listener: (event: RuntimeHostEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private async stopRuntime(): Promise<void> {
    const initialChild = this.child
    let stopError: unknown = null
    if (initialChild !== null) {
      try {
        await stopProcess(initialChild)
      } catch (error) {
        stopError = error
      }
    }

    const startPromise = this.startPromise
    if (startPromise !== null) {
      try {
        await startPromise
      } catch {
        // A cancelled or failed start is fully cleaned up below.
      }
    }

    const currentChild = this.child
    if (currentChild !== null && currentChild !== initialChild) {
      try {
        await stopProcess(currentChild)
      } catch (error) {
        stopError ??= error
      }
    }
    if (stopError !== null) throw stopError
    this.child = null
    this.client = null
    this.streaming = false
  }

  private assertStartNotCancelled(): void {
    if (this.stopRequested) throw startCancelledError()
  }

  private handlePiEvent(event: PiRpcEvent): void {
    if (event.type === 'agent_start') {
      this.streaming = true
    } else if (event.type === 'agent_settled') {
      this.streaming = false
    }
    this.emit({ type: 'pi-event', event })
  }

  private updateStreamingState(nextStreaming: boolean): void {
    if (!this.streaming && nextStreaming) {
      this.emit({ type: 'activity-started' })
    } else if (this.streaming && !nextStreaming) {
      this.emit({ type: 'activity-settled' })
    }
    this.streaming = nextStreaming
  }

  private handleDiagnostic(diagnostic: PiRpcDiagnostic): void {
    if (diagnostic.type === 'stderr') {
      const stderrChars = this.state.stderrChars + diagnostic.chunk.length
      this.state = {
        ...this.state,
        stderrChars,
        stderrSummary: `Pi stderr captured ${stderrChars} characters.`
      }
      this.emit({
        type: 'diagnostic',
        kind: 'stderr',
        message: `Pi stderr captured ${this.state.stderrChars} characters.`,
        stderrChars: this.state.stderrChars
      })
      return
    }
    if (diagnostic.type === 'stdout-parse-error') {
      const message = 'Pi RPC stdout contained invalid JSONL.'
      this.state = { ...this.state, lastError: message }
      this.emit({
        type: 'diagnostic',
        kind: 'protocol',
        message,
        stderrChars: this.state.stderrChars
      })
      return
    }
    if (diagnostic.type === 'process-error') {
      const message = `Pi RPC process error: ${diagnostic.error.message}`
      this.state = { ...this.state, lastError: message }
      this.emit({
        type: 'diagnostic',
        kind: 'process',
        message,
        stderrChars: this.state.stderrChars
      })
      return
    }

    this.state = {
      ...this.state,
      exitCode: diagnostic.code,
      exitSignal: diagnostic.signal
    }
    this.emit({
      type: 'process-exit',
      code: diagnostic.code,
      signal: diagnostic.signal
    })
  }

  private emit(event: RuntimeHostEvent): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }
}

export async function probePiRpc(options: LinuxLocalRuntimeOptions): Promise<PiRpcProbeResult> {
  const runtime = new LinuxLocalRuntime(options)
  const diagnostics: RuntimeHostEvent[] = []
  runtime.subscribe((event) => diagnostics.push(event))
  let state: PiRpcSessionState
  try {
    await runtime.start()
    const result = await runtime.send({ type: 'get_state' })
    if (result.type !== 'state') {
      throw new Error('Pi RPC probe did not receive session state.')
    }
    state = result.state
  } catch (error) {
    await runtime.stop()
    throw error
  }

  await runtime.stop()
  const runtimeState = runtime.getState()
  if (runtimeState.exitCode !== 0) {
    throw enrichRuntimeError(
      new Error(formatExitError(runtimeState.exitCode, runtimeState.exitSignal as NodeJS.Signals | null)),
      runtimeState.stderrChars
    )
  }

  const protocolError = diagnostics.find(
    (event) => event.type === 'diagnostic' && (event.kind === 'protocol' || event.kind === 'process')
  )
  if (protocolError !== undefined) {
    throw enrichRuntimeError(
      new Error('Pi RPC probe reported a protocol or process error.'),
      runtimeState.stderrChars
    )
  }

  return {
    executable: runtimeState.executable!,
    version: runtimeState.version!,
    state,
    stderrChars: runtimeState.stderrChars
  }
}

async function stopProcess(
  child: ChildProcessWithoutNullStreams
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (hasExited(child)) {
    return { code: child.exitCode, signal: child.signalCode }
  }

  child.stdin.end()
  if (await waitForExit(child, STOP_GRACE_MS)) {
    return { code: child.exitCode, signal: child.signalCode }
  }

  child.kill('SIGTERM')
  if (await waitForExit(child, STOP_GRACE_MS)) {
    return { code: child.exitCode, signal: child.signalCode }
  }

  child.kill('SIGKILL')
  if (await waitForExit(child, STOP_GRACE_MS)) {
    return { code: child.exitCode, signal: child.signalCode }
  }

  throw new Error('Pi RPC process did not exit after stdin close, SIGTERM, and SIGKILL.')
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) {
    return Promise.resolve(true)
  }

  return new Promise((resolveWait) => {
    const onClose = (): void => {
      clearTimeout(timer)
      resolveWait(true)
    }
    const timer = setTimeout(() => {
      child.off('close', onClose)
      resolveWait(false)
    }, timeoutMs)
    child.once('close', onClose)
  })
}

function hasExited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

function enrichRuntimeError(error: unknown, stderrChars: number): Error {
  const message = errorMessage(error)
  return new Error(stderrChars > 0 ? `${message} Pi stderr captured ${stderrChars} characters.` : message)
}

function formatExitError(code: number | null, signal: NodeJS.Signals | null): string {
  if (code !== null) {
    return `Pi RPC process exited with code ${code}.`
  }
  return `Pi RPC process exited from signal ${signal ?? 'unknown'}.`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function startCancelledError(): Error {
  return new Error('Runtime start cancelled.')
}
