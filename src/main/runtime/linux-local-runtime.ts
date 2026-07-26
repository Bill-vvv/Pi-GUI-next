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
import { errorMessage } from '../utils/errors.ts'
import type { SubagentSettings } from '../../shared/kernel-contract.ts'

const DEFAULT_RPC_TIMEOUT_MS = 10_000
const STOP_GRACE_MS = 1_000
const PROBE_SESSION_NAME = 'Pi GUI S11 probe'
const PROGRESS_SYSTEM_PROMPT =
  'For non-trivial tasks, provide brief user-visible commentary before important tool operations and after important discoveries. Do not narrate every tool call. Use commentary for progress updates and final_answer for the final response.'

export type LinuxLocalRuntimeOptions = {
  cwd: string
  explicitExecutable?: string
  path?: string
  versionTimeoutMs?: number
  rpcTimeoutMs?: number
  sessionFile?: string
  noSession?: boolean
  projectTrust?: boolean
  subagent?: SubagentSettings
}

export function buildPiRpcArguments(
  sessionFile?: string,
  noSession = false,
  projectTrust?: boolean,
  subagent?: SubagentSettings
): string[] {
  if (sessionFile !== undefined && noSession) {
    throw new Error('Session file and no-session mode cannot be used together.')
  }
  const arguments_ = [
    '--mode',
    'rpc',
    '--offline',
    '--append-system-prompt',
    PROGRESS_SYSTEM_PROMPT
  ]
  if (sessionFile !== undefined) {
    if (!isAbsolute(sessionFile)) {
      throw new Error(`Session file must be an absolute path: ${sessionFile}`)
    }
    arguments_.push('--session', sessionFile)
  } else if (noSession) {
    arguments_.push('--no-session')
  }
  if (projectTrust === true) arguments_.push('--approve')
  else if (projectTrust === false) arguments_.push('--no-approve')
  if (subagent !== undefined) {
    assertSubagentSettings(subagent)
    arguments_.push('--subagent-max-depth', String(subagent.maxDepth))
    arguments_.push(
      subagent.preventCycles
        ? '--subagent-prevent-cycles'
        : '--no-subagent-prevent-cycles'
    )
  }
  return arguments_
}

export type PiRpcProbeResult = {
  executable: string
  version: string
  state: PiRpcSessionState
  commandCount: number
  sessionNameEventObserved: boolean
  stderrChars: number
}

export class LinuxLocalRuntime implements RuntimeHost {
  private readonly options: LinuxLocalRuntimeOptions
  private readonly listeners = new Set<(event: RuntimeHostEvent) => void>()
  private child: ChildProcessWithoutNullStreams | null = null
  private client: PiRpcClient | null = null
  private streaming = false
  private streamingRevision = 0
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
    if (options.subagent !== undefined) assertSubagentSettings(options.subagent)
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
      buildPiRpcArguments(
        this.options.sessionFile,
        this.options.noSession,
        this.options.projectTrust,
        this.options.subagent
      ),
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
      const streamingRevision = this.streamingRevision
      const initialState = await client.getState()
      this.assertStartNotCancelled()
      if (this.streamingRevision === streamingRevision) {
        this.setStreamingSnapshot(initialState.isStreaming === true)
      }
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
      const streamingRevision = this.streamingRevision
      const state = await this.client.getState()
      // get_state is only a snapshot. A lifecycle event received while the
      // request was in flight is newer and must not be overwritten by it.
      if (this.streamingRevision === streamingRevision) {
        this.updateStreamingState(state.isStreaming === true)
      }
      try {
        const sessionStats = await this.client.getSessionStats()
        return { type: 'state', state: { ...state, sessionStats } }
      } catch {
        // Older Pi runtimes may not expose session statistics. Keep the normal
        // session-state path usable and let the UI retain its last known usage.
        return { type: 'state', state }
      }
    }
    if (command.type === 'get_session_stats') {
      return {
        type: 'session-statistics',
        statistics: await this.client.getSessionStats()
      }
    }
    if (command.type === 'get_messages') {
      return { type: 'messages', messages: await this.client.getMessages() }
    }
    if (command.type === 'get_entries') {
      return { type: 'entries', ...await this.client.getEntries() }
    }
    if (command.type === 'fork') {
      return { type: 'forked', ...await this.client.fork(command.entryId) }
    }
    if (command.type === 'prompt') {
      await this.client.prompt(command.message, command.images)
      return { type: 'accepted' }
    }
    if (command.type === 'steer') {
      await this.client.steer(command.message, command.images)
      return { type: 'accepted' }
    }
    if (command.type === 'follow_up') {
      await this.client.followUp(command.message, command.images)
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
    if (command.type === 'set_thinking_level') {
      await this.client.setThinkingLevel(command.level)
      return { type: 'accepted' }
    }
    if (command.type === 'get_commands') {
      return { type: 'commands', commands: await this.client.getCommands() }
    }
    if (command.type === 'get_available_models') {
      return { type: 'available-models', models: await this.client.getAvailableModels() }
    }
    if (command.type === 'compact') {
      await this.client.compact(command.customInstructions)
      return { type: 'accepted' }
    }
    if (command.type === 'set_session_name') {
      await this.client.setSessionName(command.name)
      return { type: 'accepted' }
    }

    command satisfies never
    throw new Error('Unsupported runtime command.')
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
      this.setStreamingFromLifecycleEvent(true)
    } else if (event.type === 'agent_settled') {
      this.setStreamingFromLifecycleEvent(false)
    }
    this.emit({ type: 'pi-event', event })
  }

  private setStreamingFromLifecycleEvent(nextStreaming: boolean): void {
    this.streaming = nextStreaming
    this.streamingRevision += 1
  }

  private setStreamingSnapshot(nextStreaming: boolean): void {
    if (this.streaming === nextStreaming) return
    this.streaming = nextStreaming
    this.streamingRevision += 1
  }

  private updateStreamingState(nextStreaming: boolean): void {
    if (this.streaming === nextStreaming) return
    this.setStreamingSnapshot(nextStreaming)
    this.emit({ type: nextStreaming ? 'activity-started' : 'activity-settled' })
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
  let sessionNameEventObserved = false
  runtime.subscribe((event) => {
    diagnostics.push(event)
    if (
      event.type === 'pi-event' &&
      event.event.type === 'session_info_changed' &&
      event.event.name === PROBE_SESSION_NAME
    ) {
      sessionNameEventObserved = true
    }
  })
  let state: PiRpcSessionState
  let commandCount = 0
  try {
    await runtime.start()
    const result = await runtime.send({ type: 'get_state' })
    if (result.type !== 'state') {
      throw new Error('Pi RPC probe did not receive session state.')
    }
    state = result.state
    const commandsResult = await runtime.send({ type: 'get_commands' })
    if (commandsResult.type !== 'commands') {
      throw new Error('Pi RPC probe did not receive a command catalog.')
    }
    commandCount = commandsResult.commands.length
    if (options.noSession === true) {
      await runtime.send({ type: 'set_session_name', name: PROBE_SESSION_NAME })
      const renamedResult = await runtime.send({ type: 'get_state' })
      if (renamedResult.type !== 'state' || renamedResult.state.sessionName !== PROBE_SESSION_NAME) {
        throw new Error('Pi RPC probe did not retain the typed session name.')
      }
      if (!sessionNameEventObserved) {
        throw new Error('Pi RPC probe did not observe session_info_changed.')
      }
      state = renamedResult.state
    }
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
    commandCount,
    sessionNameEventObserved,
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

function startCancelledError(): Error {
  return new Error('Runtime start cancelled.')
}

function assertSubagentSettings(settings: SubagentSettings): void {
  if (
    (settings.maxDepth !== 1 && settings.maxDepth !== 2 && settings.maxDepth !== 3) ||
    typeof settings.preventCycles !== 'boolean'
  ) {
    throw new Error('Invalid subagent settings.')
  }
}
