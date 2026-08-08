import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { isAbsolute } from 'node:path'

import {
  PiRpcClient,
  type PiRpcDiagnostic,
  type PiRpcEvent,
  type PiRpcExtensionEvent,
  type PiRpcExtensionInventory,
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
import {
  HISTORY_NAVIGATION_COMMAND_DESCRIPTION,
  HISTORY_NAVIGATION_COMMAND_NAME,
  buildHistoryNavigationCommandArgs
} from './history-navigation.ts'
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

const DEFAULT_RPC_TIMEOUT_MS = 10_000
const STOP_GRACE_MS = 1_000
const PROBE_SESSION_NAME = 'Pi GUI S11 probe'
const MAX_EXTENSION_COMMAND_NAME_LENGTH = 256
const MAX_EXTENSION_COMMAND_ARGS_LENGTH = 64 * 1024
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u
const PROGRESS_SYSTEM_PROMPT =
  'For non-trivial tasks, provide brief user-visible commentary before important tool operations and after important discoveries. Do not narrate every tool call. Use commentary for progress updates and final_answer for the final response.'

function buildExtensionCommandPrompt(name: string, args?: string): string {
  if (
    name.length === 0 ||
    name.length > MAX_EXTENSION_COMMAND_NAME_LENGTH ||
    name.trim() !== name ||
    name.startsWith('/') ||
    CONTROL_CHARACTER_PATTERN.test(name)
  ) {
    throw new Error('Runtime extension command name is malformed')
  }
  if (args !== undefined && args.length > MAX_EXTENSION_COMMAND_ARGS_LENGTH) {
    throw new Error(
      `Runtime extension command args exceed maximum length of ${MAX_EXTENSION_COMMAND_ARGS_LENGTH}`
    )
  }
  return args === undefined || args.length === 0 ? `/${name}` : `/${name} ${args}`
}

const FAST_EXTENSION_RESOLVER_HOOK_URL = `data:text/javascript,${encodeURIComponent(`
import { existsSync, realpathSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

try {
  const cliPath = realpathSync(process.argv[1])
  const packageRoot = dirname(dirname(cliPath))
  const piAiRoot = join(packageRoot, 'node_modules/@earendil-works/pi-ai/dist')
  const aliases = new Map(Object.entries({
    '@earendil-works/pi-coding-agent': join(packageRoot, 'dist/index.js'),
    '@earendil-works/pi-agent-core': join(packageRoot, 'node_modules/@earendil-works/pi-agent-core/dist/index.js'),
    '@earendil-works/pi-tui': join(packageRoot, 'node_modules/@earendil-works/pi-tui/dist/index.js'),
    '@earendil-works/pi-ai': join(piAiRoot, 'compat.js'),
    '@earendil-works/pi-ai/compat': join(piAiRoot, 'compat.js'),
    '@earendil-works/pi-ai/oauth': join(piAiRoot, 'oauth.js'),
    '@earendil-works/pi-ai/providers/all': join(piAiRoot, 'providers/all.js'),
    '@mariozechner/pi-coding-agent': join(packageRoot, 'dist/index.js'),
    '@mariozechner/pi-agent-core': join(packageRoot, 'node_modules/@earendil-works/pi-agent-core/dist/index.js'),
    '@mariozechner/pi-tui': join(packageRoot, 'node_modules/@earendil-works/pi-tui/dist/index.js'),
    '@mariozechner/pi-ai': join(piAiRoot, 'compat.js'),
    '@mariozechner/pi-ai/compat': join(piAiRoot, 'compat.js'),
    '@mariozechner/pi-ai/oauth': join(piAiRoot, 'oauth.js'),
    '@mariozechner/pi-ai/providers/all': join(piAiRoot, 'providers/all.js')
  }).filter(([, target]) => existsSync(target)))
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const target = aliases.get(specifier)
      return target === undefined
        ? nextResolve(specifier, context)
        : { url: pathToFileURL(target).href, shortCircuit: true }
    }
  })
} catch {}
`)}`

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
  fastExtensionLoading?: boolean
  /** Absolute path to the app-owned runtime quiescence extension entry. */
  quiescenceExtensionPath?: string
  /** Ordered app-owned extension entries loaded explicitly for every managed Pi process. */
  extensionPaths?: readonly string[]
  desktopNotification?: {
    socketPath: string
    token: string
  }
}

export function buildPiRpcArguments(
  sessionFile?: string,
  noSession = false,
  projectTrust?: boolean,
  extensionPaths: readonly string[] = []
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
  for (const extensionPath of extensionPaths) {
    if (!isAbsolute(extensionPath)) {
      throw new Error(`Extension path must be absolute: ${extensionPath}`)
    }
    arguments_.push('-e', extensionPath)
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

type QuiescenceWaiter = {
  nonce: string
  resolve: (result: RuntimeQuiescenceQueryResult) => void
  timer: ReturnType<typeof setTimeout>
}

type LeaseWaiter = {
  nonce: string
  action: RuntimeHibernateLeaseAction
  resolve: (result: RuntimeHibernateLeaseResult) => void
  timer: ReturnType<typeof setTimeout>
}

type HibernateLeaseState =
  | { phase: 'preparing'; sessionId: string; generation: number; attemptId: string }
  | {
      phase: 'prepared' | 'committed'
      sessionId: string
      generation: number
      attemptId: string
      token: string
    }

export class LinuxLocalRuntime implements RuntimeHost {
  private readonly options: LinuxLocalRuntimeOptions
  private readonly listeners = new Set<(event: RuntimeHostEvent) => void>()
  private readonly extensionEventListeners = new Set<(event: PiRpcExtensionEvent) => void>()
  private child: ChildProcessWithoutNullStreams | null = null
  private client: PiRpcClient | null = null
  private streaming = false
  private streamingRevision = 0
  private startPromise: Promise<void> | null = null
  private stopPromise: Promise<void> | null = null
  private stopRequested = false
  private readonly quiescenceWaiters = new Map<string, QuiescenceWaiter>()
  private readonly leaseWaiters = new Map<string, LeaseWaiter>()
  private hibernateLease: HibernateLeaseState | null = null
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
    if (
      options.quiescenceExtensionPath !== undefined &&
      !isAbsolute(options.quiescenceExtensionPath)
    ) {
      throw new Error(
        `Quiescence extension path must be an absolute path: ${options.quiescenceExtensionPath}`
      )
    }
    if (options.extensionPaths !== undefined) {
      for (const extensionPath of options.extensionPaths) {
        if (!isAbsolute(extensionPath)) {
          throw new Error(`Runtime extension path must be absolute: ${extensionPath}`)
        }
      }
    }
    if (options.subagent !== undefined) assertSubagentSettings(options.subagent)
    if (options.desktopNotification !== undefined) {
      if (!isAbsolute(options.desktopNotification.socketPath)) {
        throw new Error(
          `Desktop notification socket path must be absolute: ${options.desktopNotification.socketPath}`
        )
      }
      if (
        options.desktopNotification.token.length < 32 ||
        options.desktopNotification.token.length > 256
      ) {
        throw new Error('Desktop notification broker token is invalid.')
      }
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

    const env = { ...process.env }
    delete env.PI_PARALLEL_EXTENSION_IMPORTS
    delete env.PI_NATIVE_COMPILED_EXTENSION_IMPORTS
    delete env.JITI_TRY_NATIVE
    delete env.PI_GUI_NOTIFICATION_SOCKET
    delete env.PI_GUI_NOTIFICATION_TOKEN
    delete env.PI_GUI_OPENAI_FAST_MODE
    if (this.options.fastExtensionLoading === true) {
      env.PI_PARALLEL_EXTENSION_IMPORTS = '1'
      env.PI_NATIVE_COMPILED_EXTENSION_IMPORTS = '1'
      env.JITI_TRY_NATIVE = '1'
      if (!env.NODE_OPTIONS?.includes(FAST_EXTENSION_RESOLVER_HOOK_URL)) {
        env.NODE_OPTIONS = [env.NODE_OPTIONS, `--import=${FAST_EXTENSION_RESOLVER_HOOK_URL}`]
          .filter((value) => value !== undefined && value.length > 0)
          .join(' ')
      }
    }
    if (this.options.subagent !== undefined) {
      env.PI_SUBAGENT_MAX_DEPTH = String(this.options.subagent.maxDepth)
    }
    if (this.options.desktopNotification !== undefined) {
      env.PI_GUI_NOTIFICATION_SOCKET = this.options.desktopNotification.socketPath
      env.PI_GUI_NOTIFICATION_TOKEN = this.options.desktopNotification.token
    }
    const extensionPaths = [...new Set([
      ...(this.options.extensionPaths ?? []),
      ...(this.options.quiescenceExtensionPath === undefined
        ? []
        : [this.options.quiescenceExtensionPath])
    ])]
    const child = spawn(
      executable,
      buildPiRpcArguments(
        this.options.sessionFile,
        this.options.noSession,
        this.options.projectTrust,
        extensionPaths
      ),
      {
        cwd: this.options.cwd,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env
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
    let client: PiRpcClient
    client = new PiRpcClient(child, {
      requestTimeoutMs: this.options.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS,
      onDiagnostic: (diagnostic) => this.handleDiagnostic(diagnostic, child, client),
      onEvent: (event) => this.handlePiEvent(event),
      onExtensionEvent: (event) => this.emitExtensionEvent(event, child, client)
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
        this.extensionEventListeners.clear()
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
    // After prepare begins, only read-only state reads and commit/release/stop remain.
    if (this.hibernateLease !== null && isMutatingRuntimeCommandType(command.type)) {
      throw new Error(
        `Runtime command ${command.type} is rejected while a hibernate lease is active.`
      )
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
    if (command.type === 'get_tree') {
      return { type: 'tree', ...await this.client.getTree() }
    }
    if (command.type === 'navigate_tree') {
      const before = await this.client.getEntries()
      const target = before.entries.find(({ id }) => id === command.targetEntryId)
      if (
        target?.type !== 'message' ||
        target.message?.role !== 'user' ||
        target.message.content === undefined
      ) {
        throw new Error('History navigation target must be a projected user message.')
      }

      const extensionCommand = (await this.client.getCommands()).find((candidate) =>
        candidate.name === HISTORY_NAVIGATION_COMMAND_NAME &&
        candidate.description === HISTORY_NAVIGATION_COMMAND_DESCRIPTION &&
        candidate.source === 'extension' &&
        candidate.sourceInfo?.source === 'cli' &&
        candidate.sourceInfo.scope === 'temporary' &&
        candidate.sourceInfo.origin === 'top-level'
      )
      if (extensionCommand === undefined) {
        throw new Error('Pi GUI history navigation Extension command is unavailable.')
      }

      await this.client.prompt(buildExtensionCommandPrompt(
        HISTORY_NAVIGATION_COMMAND_NAME,
        buildHistoryNavigationCommandArgs(command.targetEntryId)
      ))
      const after = await this.client.getEntries()
      if (after.leafId !== target.parentId) {
        throw new Error('Pi history navigation did not select the prompt parent.')
      }
      return {
        type: 'tree-navigation',
        targetEntryId: command.targetEntryId,
        cancelled: false,
        leafId: after.leafId,
        editorText: target.message.content.text
      }
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
    if (command.type === 'invoke_extension_command') {
      await this.client.prompt(buildExtensionCommandPrompt(command.name, command.args))
      return { type: 'accepted' }
    }
    if (command.type === 'subscribe_extension_events') {
      return {
        type: 'extension-event-subscription',
        channels: await this.client.subscribeExtensionEvents(command.channels)
      }
    }
    if (command.type === 'extension_ui_response') {
      await this.client.respondExtensionUi(
        'value' in command
          ? { id: command.id, value: command.value }
          : { id: command.id, cancelled: true }
      )
      return { type: 'accepted' }
    }

    command satisfies never
    throw new Error('Unsupported runtime command.')
  }

  stop(): Promise<void> {
    this.stopRequested = true
    // Settle outstanding QUERY/lease waiters at stop start so callers do not wait on a dying process.
    this.rejectQuiescenceWaiters('stopping', 'Pi RPC process is stopping.')
    this.rejectLeaseWaiters('stopping', 'Pi RPC process is stopping.')
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

  getRpcPid(): number | null {
    const child = this.child
    if (child === null || hasExited(child)) return null
    const pid = child.pid
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : null
  }

  /**
   * This Pi inventory has no Main-owned runtimeId. The future Workbench caller must
   * capture and fence the owning RuntimeContext/runtimeId and this RuntimeHost identity
   * both before dispatch and after await before using the result.
   */
  async getLoadedExtensions(): Promise<PiRpcExtensionInventory> {
    if (this.client === null || this.child === null || hasExited(this.child)) {
      throw new Error('Pi RPC process is not running.')
    }
    return this.client.getExtensions()
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
    if (this.stopRequested) {
      return {
        ok: false,
        reason: 'stopping',
        message: 'Pi RPC process is stopping; quiescence queries are rejected.'
      }
    }
    if (this.client === null || this.child === null || hasExited(this.child)) {
      return {
        ok: false,
        reason: 'runtime-not-running',
        message: 'Pi RPC process is not running.'
      }
    }
    if (this.options.quiescenceExtensionPath === undefined) {
      return {
        ok: false,
        reason: 'extension-missing',
        message: 'Runtime quiescence extension path is not configured.'
      }
    }

    const timeout = normalizeQuiescenceTimeoutMs(options?.timeoutMs)
    if (!timeout.ok) {
      return {
        ok: false,
        reason: 'malformed',
        message: `Quiescence query timeout rejected: ${timeout.reason}.`
      }
    }

    const nonce = randomUUID()
    const timeoutMs = timeout.timeoutMs
    const prompt = buildQuiescencePrompt(nonce)

    return await new Promise<RuntimeQuiescenceQueryResult>((resolve) => {
      const timer = setTimeout(() => {
        this.quiescenceWaiters.delete(nonce)
        resolve({
          ok: false,
          reason: 'timeout',
          message: `Quiescence query timed out after ${timeoutMs}ms.`,
          nonce
        })
      }, timeoutMs)
      this.quiescenceWaiters.set(nonce, { nonce, resolve, timer })

      void this.client!.prompt(prompt).then(
        () => {
          // Extension commands complete without agent turns; the correlated setStatus
          // event settles the waiter. Timeout remains the fail-closed backstop.
        },
        (error) => {
          const waiter = this.quiescenceWaiters.get(nonce)
          if (waiter === undefined) return
          clearTimeout(waiter.timer)
          this.quiescenceWaiters.delete(nonce)
          resolve({
            ok: false,
            reason: 'prompt-failed',
            message: errorMessage(error),
            nonce
          })
        }
      )
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
      return {
        ok: false,
        reason: 'fenced',
        message: 'A hibernate lease is already active on this runtime.',
        action: 'prepare'
      }
    }

    // Local fence begins before the extension prepare round-trip.
    this.hibernateLease = {
      phase: 'preparing',
      sessionId: input.sessionId,
      generation: input.generation,
      attemptId: input.attemptId
    }

    const result = await this.runLeaseCommand({
      action: 'prepare',
      sessionId: input.sessionId,
      generation: input.generation,
      attemptId: input.attemptId,
      timeoutMs: input.timeoutMs
    })

    if (!result.ok) {
      this.hibernateLease = null
      return result
    }
    if (typeof result.token !== 'string' || !isValidLeaseToken(result.token)) {
      this.hibernateLease = null
      return {
        ok: false,
        reason: 'malformed',
        message: 'Prepare succeeded without a valid lease token.',
        action: 'prepare'
      }
    }
    this.hibernateLease = {
      phase: 'prepared',
      sessionId: input.sessionId,
      generation: input.generation,
      attemptId: input.attemptId,
      token: result.token
    }
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

    if (
      this.hibernateLease === null ||
      this.hibernateLease.phase === 'preparing' ||
      this.hibernateLease.sessionId !== input.sessionId ||
      this.hibernateLease.generation !== input.generation ||
      this.hibernateLease.attemptId !== input.attemptId ||
      this.hibernateLease.token !== input.token
    ) {
      return {
        ok: false,
        reason: 'identity-mismatch',
        message: 'Commit identity does not match the active prepared lease.',
        action: 'commit'
      }
    }

    if (this.hibernateLease.phase === 'committed') {
      return {
        ok: true,
        action: 'commit',
        sessionId: input.sessionId,
        generation: input.generation,
        attemptId: input.attemptId,
        token: input.token
      }
    }

    const result = await this.runLeaseCommand({
      action: 'commit',
      sessionId: input.sessionId,
      generation: input.generation,
      attemptId: input.attemptId,
      token: input.token,
      timeoutMs: input.timeoutMs
    })
    if (result.ok) {
      this.hibernateLease = {
        phase: 'committed',
        sessionId: input.sessionId,
        generation: input.generation,
        attemptId: input.attemptId,
        token: input.token
      }
    }
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

    if (
      this.hibernateLease === null ||
      this.hibernateLease.phase === 'preparing' ||
      this.hibernateLease.sessionId !== input.sessionId ||
      this.hibernateLease.generation !== input.generation ||
      this.hibernateLease.attemptId !== input.attemptId ||
      this.hibernateLease.token !== input.token
    ) {
      return {
        ok: false,
        reason: 'identity-mismatch',
        message: 'Release identity does not match the active lease generation/token.',
        action: 'release'
      }
    }

    // Only a verifiably absent process can bypass the provider round-trip. A
    // failed stop leaves stopRequested set while the child may still own live
    // provider fences, so exact release must remain available in that state.
    if (this.client === null || this.child === null || hasExited(this.child)) {
      this.hibernateLease = null
      return {
        ok: true,
        action: 'release',
        sessionId: input.sessionId,
        generation: input.generation,
        attemptId: input.attemptId,
        token: input.token
      }
    }

    const result = await this.runLeaseCommand({
      action: 'release',
      sessionId: input.sessionId,
      generation: input.generation,
      attemptId: input.attemptId,
      token: input.token,
      timeoutMs: input.timeoutMs
    })
    // Clear the host fence only after an exact provider release succeeds. Rejected or
    // stale releases remain fail-closed and cannot reopen mutation admission.
    if (
      result.ok &&
      this.hibernateLease !== null &&
      this.hibernateLease.token === input.token &&
      this.hibernateLease.attemptId === input.attemptId
    ) {
      this.hibernateLease = null
      // A live child whose stop failed is usable again only after every owner
      // accepted the exact rollback token.
      this.stopRequested = false
    }
    return result
  }

  private validateLeaseIdentity(
    input: {
      sessionId: string
      generation: number
      attemptId: string
      token?: string
    },
    requireToken: boolean
  ): { ok: true } | RuntimeHibernateLeaseResult {
    if (!isValidSessionId(input.sessionId)) {
      return {
        ok: false,
        reason: 'invalid-input',
        message: 'Hibernate lease sessionId is invalid.'
      }
    }
    if (!isValidRuntimeGeneration(input.generation)) {
      return {
        ok: false,
        reason: 'invalid-input',
        message: 'Hibernate lease generation is invalid.'
      }
    }
    if (!isValidAttemptId(input.attemptId)) {
      return {
        ok: false,
        reason: 'invalid-input',
        message: 'Hibernate lease attemptId is invalid.'
      }
    }
    if (requireToken && !isValidLeaseToken(input.token)) {
      return {
        ok: false,
        reason: 'invalid-input',
        message: 'Hibernate lease token is invalid.'
      }
    }
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
      return {
        ok: false,
        reason: 'stopping',
        message: 'Pi RPC process is stopping; new hibernate lease commands are rejected.',
        action: input.action
      }
    }
    if (this.client === null || this.child === null || hasExited(this.child)) {
      return {
        ok: false,
        reason: 'runtime-not-running',
        message: 'Pi RPC process is not running.',
        action: input.action
      }
    }
    if (this.options.quiescenceExtensionPath === undefined) {
      return {
        ok: false,
        reason: 'extension-missing',
        message: 'Runtime quiescence extension path is not configured.',
        action: input.action
      }
    }

    const timeout = normalizeHibernateLeaseTimeoutMs(input.timeoutMs)
    if (!timeout.ok) {
      return {
        ok: false,
        reason: 'malformed',
        message: `Hibernate lease timeout rejected: ${timeout.reason}.`,
        action: input.action
      }
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
        ...(input.token !== undefined ? { token: input.token } : {})
      })
    } catch (error) {
      return {
        ok: false,
        reason: 'invalid-input',
        message: errorMessage(error),
        action: input.action
      }
    }

    const timeoutMs = timeout.timeoutMs
    return await new Promise<RuntimeHibernateLeaseResult>((resolve) => {
      const timer = setTimeout(() => {
        this.leaseWaiters.delete(nonce)
        resolve({
          ok: false,
          reason: 'timeout',
          message: `Hibernate lease ${input.action} timed out after ${timeoutMs}ms.`,
          action: input.action,
          nonce
        })
      }, timeoutMs)
      this.leaseWaiters.set(nonce, { nonce, action: input.action, resolve, timer })

      void this.client!.prompt(prompt).then(
        () => {
          // Correlated setStatus settles the waiter. Timeout remains fail-closed.
        },
        (error) => {
          const waiter = this.leaseWaiters.get(nonce)
          if (waiter === undefined) return
          clearTimeout(waiter.timer)
          this.leaseWaiters.delete(nonce)
          resolve({
            ok: false,
            reason: 'prompt-failed',
            message: errorMessage(error),
            action: input.action,
            nonce
          })
        }
      )
    })
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
    this.rejectQuiescenceWaiters('runtime-not-running', 'Pi RPC process stopped before quiescence settled.')
    this.rejectLeaseWaiters('runtime-not-running', 'Pi RPC process stopped before hibernate lease settled.')
    this.hibernateLease = null
    this.extensionEventListeners.clear()
    this.child = null
    this.client = null
    this.streaming = false
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
      waiter.resolve({
        ok: false,
        reason,
        message,
        action: waiter.action,
        nonce
      })
    }
    this.leaseWaiters.clear()
  }

  private assertStartNotCancelled(): void {
    if (this.stopRequested) throw startCancelledError()
  }

  private handlePiEvent(event: PiRpcEvent): void {
    // Internal quiescence/lease replies stay on the RuntimeHost path only.
    // Do not forward them as pi-events into Kernel/GUI conversation state.
    if (isInternalRuntimeStatusEvent(event)) {
      if (isQuiescenceStatusEvent(event)) {
        this.handleQuiescenceStatusEvent(event)
      } else if (isHibernateLeaseStatusEvent(event)) {
        this.handleLeaseStatusEvent(event)
      }
      return
    }
    if (event.type === 'agent_start') {
      this.setStreamingFromLifecycleEvent(true)
    } else if (event.type === 'agent_settled') {
      this.setStreamingFromLifecycleEvent(false)
    }
    this.emit({ type: 'pi-event', event })
  }

  private handleQuiescenceStatusEvent(event: PiRpcEvent): void {
    const statusText = typeof event.statusText === 'string' ? event.statusText : undefined
    // Clearing the status bar after delivery is expected and must not fail open waiters.
    if (statusText === undefined) return

    let nonce: string | null = null
    try {
      const raw = JSON.parse(statusText) as { nonce?: unknown }
      if (typeof raw.nonce === 'string') nonce = raw.nonce
    } catch {
      // Malformed payloads cannot be correlated; leave waiters for timeout fail-closed.
      return
    }
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

    let nonce: string | null = null
    try {
      const raw = JSON.parse(statusText) as { nonce?: unknown }
      if (typeof raw.nonce === 'string') nonce = raw.nonce
    } catch {
      return
    }
    if (nonce === null) return
    const waiter = this.leaseWaiters.get(nonce)
    if (waiter === undefined) return
    clearTimeout(waiter.timer)
    this.leaseWaiters.delete(nonce)
    waiter.resolve(interpretHibernateLeaseStatusText(statusText, nonce, waiter.action))
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

  private handleDiagnostic(
    diagnostic: PiRpcDiagnostic,
    sourceChild: ChildProcessWithoutNullStreams,
    sourceClient: PiRpcClient
  ): void {
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
    if (
      diagnostic.type === 'stdout-parse-error' ||
      diagnostic.type === 'extension-event-protocol-error'
    ) {
      const message = diagnostic.type === 'stdout-parse-error'
        ? 'Pi RPC stdout contained invalid JSONL.'
        : 'Pi RPC stdout contained a malformed extension-event envelope.'
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
      if (sourceChild === this.child && sourceClient === this.client) {
        this.extensionEventListeners.clear()
      }
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
    if (sourceChild === this.child && sourceClient === this.client) {
      this.extensionEventListeners.clear()
    }
    // Natural process death must not leave QUERY/lease waiters hanging on timeout.
    // Explicit stop() already settled them as `stopping`; this path is a no-op then.
    if (!this.stopRequested) {
      this.rejectQuiescenceWaiters(
        'runtime-not-running',
        'Pi RPC process exited before quiescence settled.'
      )
      this.rejectLeaseWaiters(
        'runtime-not-running',
        'Pi RPC process exited before hibernate lease settled.'
      )
      this.hibernateLease = null
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

  private emitExtensionEvent(
    event: PiRpcExtensionEvent,
    sourceChild: ChildProcessWithoutNullStreams,
    sourceClient: PiRpcClient
  ): void {
    if (
      this.stopRequested ||
      sourceChild !== this.child ||
      sourceClient !== this.client ||
      hasExited(sourceChild)
    ) {
      return
    }
    for (const listener of this.extensionEventListeners) {
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
  if (settings.maxDepth !== 1 && settings.maxDepth !== 2 && settings.maxDepth !== 3) {
    throw new Error('Invalid subagent settings.')
  }
}
