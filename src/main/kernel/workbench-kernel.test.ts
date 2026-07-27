import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  AppearanceSettings,
  GeneralSettings,
  KernelEvent,
  KernelProjectState,
  KernelSessionStatistics,
  RuntimeStatus,
  SessionNamingSettings,
  ShortcutSettings,
  SubagentSettings
} from '../../shared/kernel-contract.ts'
import { DEFAULT_SHORTCUT_SETTINGS } from '../../shared/shortcut-settings.ts'
import type { ProjectSessionRegistry, SessionPointer } from '../project/session-pointer.ts'
import type {
  PiRpcAvailableModel,
  PiRpcSessionEntry,
  PiRpcSessionState,
  PiRpcSessionStats,
  PiRpcSlashCommand
} from '../pi-rpc/pi-rpc-client.ts'
import {
  COPY_LAST_ANSWER_COMMAND_ID,
  DEFAULT_SUBAGENT_SETTINGS,
  EXPORT_SESSION_COMMAND_ID,
  FORK_SESSION_COMMAND_ID,
} from '../../shared/kernel-contract.ts'
import {
  COMPACT_COMMAND_ID,
  NEW_SESSION_COMMAND_ID,
  RELOAD_SESSION_COMMAND_ID,
  SET_MODEL_COMMAND_ID,
  SET_SESSION_NAME_COMMAND_ID,
  SET_THINKING_COMMAND_ID
} from './command-catalog.ts'
import { WorkbenchKernel } from './workbench-kernel.ts'
import { isKernelCommand } from './kernel-command-validation.ts'
import type {
  RuntimeCommand,
  RuntimeCommandResult,
  RuntimeHost,
  RuntimeHostEvent,
  RuntimeHostState
} from '../runtime/runtime-host.ts'
import type {
  SessionNameGenerationRequest,
  SessionNameGenerator
} from '../runtime/session-name-generator.ts'

class FakeRuntimeHost implements RuntimeHost {
  private readonly listeners = new Set<(event: RuntimeHostEvent) => void>()
  readonly commands: RuntimeCommand[] = []
  startCalls = 0
  stopCalls = 0
  protected readonly sessionState: PiRpcSessionState
  protected readonly messages: unknown[]
  protected readonly slashCommands: PiRpcSlashCommand[]
  protected readonly availableModels: PiRpcAvailableModel[]
  protected readonly sessionEntries: unknown[]
  private sessionStats: PiRpcSessionStats | undefined
  private state: RuntimeHostState = {
    executable: '/usr/bin/pi',
    version: '0.80.10',
    stderrChars: 0,
    stderrSummary: null,
    lastError: null,
    exitCode: null,
    exitSignal: null
  }

  constructor(
    sessionState: PiRpcSessionState = {
      sessionId: 'session-1',
      sessionFile: '/tmp/session-1.jsonl',
      thinkingLevel: 'medium',
      isStreaming: false,
      messageCount: 0,
      pendingMessageCount: 0
    },
    messages: unknown[] = [],
    slashCommands: PiRpcSlashCommand[] = [],
    availableModels: PiRpcAvailableModel[] = [{
      id: 'gpt-5.4-mini',
      provider: 'openai',
      name: 'GPT-5.4 mini',
      reasoning: true,
      contextWindow: 128000
    }],
    sessionStats?: PiRpcSessionStats,
    sessionEntries: unknown[] = []
  ) {
    this.sessionState = sessionState
    this.messages = messages
    this.slashCommands = slashCommands
    this.availableModels = availableModels
    this.sessionStats = sessionStats
    this.sessionEntries = sessionEntries
  }

  async start(): Promise<void> {
    this.startCalls += 1
  }

  async send(command: RuntimeCommand): Promise<RuntimeCommandResult> {
    this.commands.push(command)
    if (command.type === 'get_session_stats') {
      return {
        type: 'session-statistics',
        statistics: this.sessionStats ?? {
          ...(typeof this.sessionState.sessionFile === 'string'
            ? { sessionFile: this.sessionState.sessionFile }
            : {}),
          sessionId: typeof this.sessionState.sessionId === 'string'
            ? this.sessionState.sessionId
            : 'session-1',
          userMessages: 0,
          assistantMessages: 0,
          toolCalls: 0,
          toolResults: 0,
          totalMessages: 0,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          cost: 0
        }
      }
    }
    if (command.type === 'get_state') {
      return {
        type: 'state',
        state: this.sessionStats === undefined
          ? this.sessionState
          : { ...this.sessionState, sessionStats: this.sessionStats }
      }
    }
    if (command.type === 'get_messages') return { type: 'messages', messages: this.messages }
    if (command.type === 'get_commands') return { type: 'commands', commands: this.slashCommands }
    if (command.type === 'get_entries') {
      return {
        type: 'entries',
        entries: this.sessionEntries as PiRpcSessionEntry[],
        leafId: null
      }
    }
    if (command.type === 'get_available_models') {
      return { type: 'available-models', models: this.availableModels }
    }
    if (command.type === 'set_model') {
      this.sessionState.model = { id: command.modelId, provider: command.provider }
      return {
        type: 'model',
        model: { id: command.modelId, provider: command.provider }
      }
    }
    if (command.type === 'set_session_name') {
      this.sessionState.sessionName = command.name
      this.emit({
        type: 'pi-event',
        event: { type: 'session_info_changed', name: command.name }
      })
    }
    if (command.type === 'compact') {
      this.emit({
        type: 'pi-event',
        event: { type: 'compaction_start', reason: 'manual' }
      })
      this.emit({
        type: 'pi-event',
        event: {
          type: 'compaction_end',
          reason: 'manual',
          result: { summary: 'Compacted', firstKeptEntryId: 'kept', tokensBefore: 100 },
          aborted: false,
          willRetry: false
        }
      })
    }
    return { type: 'accepted' }
  }

  async stop(): Promise<void> {
    this.stopCalls += 1
  }

  getState(): RuntimeHostState {
    return { ...this.state }
  }

  subscribe(listener: (event: RuntimeHostEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: RuntimeHostEvent): void {
    if (event.type === 'process-exit') {
      this.state = { ...this.state, exitCode: event.code, exitSignal: event.signal }
    }
    for (const listener of this.listeners) {
      listener(event)
    }
  }

  setStreaming(streaming: boolean): void {
    this.sessionState.isStreaming = streaming
  }

  replaceMessages(messages: unknown[]): void {
    this.messages.splice(0, this.messages.length, ...messages)
  }

  setSessionStats(sessionStats: PiRpcSessionStats | undefined): void {
    this.sessionStats = sessionStats
  }

  replaceEntries(entries: unknown[]): void {
    this.sessionEntries.splice(0, this.sessionEntries.length, ...entries)
  }
}

class DeferredSessionStatsRuntimeHost extends FakeRuntimeHost {
  private deferSessionStats = false
  private readonly pendingSessionStats: Array<(result: RuntimeCommandResult) => void> = []

  override async send(command: RuntimeCommand): Promise<RuntimeCommandResult> {
    if (command.type !== 'get_session_stats' || !this.deferSessionStats) {
      return super.send(command)
    }
    this.commands.push(command)
    return new Promise<RuntimeCommandResult>((resolve) => {
      this.pendingSessionStats.push(resolve)
    })
  }

  beginDeferringSessionStats(): void {
    this.deferSessionStats = true
  }

  pendingSessionStatsCount(): number {
    return this.pendingSessionStats.length
  }

  resolveNextSessionStats(statistics: PiRpcSessionStats): void {
    const resolve = this.pendingSessionStats.shift()
    assert.ok(resolve)
    resolve({ type: 'session-statistics', statistics })
  }
}

function advisorCapabilities(enabled: boolean): unknown {
  return {
    type: 'custom',
    customType: 'pi-gui.multi-advisor/capabilities',
    data: {
      protocolVersion: 2,
      identity: 'pi-gui-multi-advisor',
      version: '1.0.0',
      enabled,
      multiAdvisor: true,
      liveToggle: true,
      roster: true,
      status: true,
      usage: true,
      dump: false,
      subagents: false,
      severities: ['nit', 'concern', 'blocker'],
      deliveries: ['aside', 'steer'],
      readOnlyTools: ['read', 'grep', 'find', 'ls'],
      optionalTools: ['edit', 'write']
    }
  }
}

class AdvisorRuntimeHost extends FakeRuntimeHost {
  private confirmToggle = true

  constructor(enabled: boolean) {
    super(undefined, [], [{
      name: 'advisor',
      source: 'extension',
      sourceInfo: {
        source: 'pi-gui-multi-advisor',
        scope: 'project',
        origin: 'package'
      }
    }], undefined, undefined, [advisorCapabilities(enabled)])
  }

  setConfirmToggle(confirmToggle: boolean): void {
    this.confirmToggle = confirmToggle
  }

  override async send(command: RuntimeCommand): Promise<RuntimeCommandResult> {
    if (
      command.type === 'prompt' &&
      this.confirmToggle &&
      (command.message === '/advisor on' || command.message === '/advisor off')
    ) {
      this.replaceEntries([advisorCapabilities(command.message.endsWith('on'))])
    }
    return super.send(command)
  }
}

class ForkingRuntimeHost extends FakeRuntimeHost {
  private forked = false
  private readonly entries: PiRpcSessionEntry[]
  private readonly leafId: string | null
  private readonly forkedState: PiRpcSessionState
  private readonly forkedMessages: unknown[]
  private readonly failForkedProjection: boolean
  private readonly cancelFork: boolean

  constructor(
    sessionState: PiRpcSessionState,
    messages: unknown[],
    entries: PiRpcSessionEntry[],
    leafId: string | null,
    forkedState: PiRpcSessionState,
    forkedMessages: unknown[],
    failForkedProjection = false,
    cancelFork = false
  ) {
    super(sessionState, messages)
    this.entries = entries
    this.leafId = leafId
    this.forkedState = forkedState
    this.forkedMessages = forkedMessages
    this.failForkedProjection = failForkedProjection
    this.cancelFork = cancelFork
  }

  override async send(command: RuntimeCommand): Promise<RuntimeCommandResult> {
    if (command.type === 'get_entries') {
      this.commands.push(command)
      return { type: 'entries', entries: this.entries, leafId: this.leafId }
    }
    if (command.type === 'fork') {
      this.commands.push(command)
      if (this.cancelFork) {
        return { type: 'forked', text: 'Selected prompt', cancelled: true }
      }
      this.forked = true
      Object.assign(this.sessionState, this.forkedState)
      this.replaceMessages(this.forkedMessages)
      return { type: 'forked', text: 'Selected prompt', cancelled: false }
    }
    if (command.type === 'get_messages' && this.forked && this.failForkedProjection) {
      this.commands.push(command)
      throw new Error('forked messages unavailable')
    }
    return super.send(command)
  }
}

class CompactingRuntimeHost extends FakeRuntimeHost {
  private readonly compactedMessages: unknown[]
  private failCompactedMessages = false

  constructor(initialMessages: unknown[], compactedMessages: unknown[]) {
    super(undefined, initialMessages)
    this.compactedMessages = compactedMessages
  }

  failNextCompactedProjection(): void {
    this.failCompactedMessages = true
  }

  override async send(command: RuntimeCommand): Promise<RuntimeCommandResult> {
    if (command.type === 'compact') {
      this.commands.push(command)
      this.emit({
        type: 'pi-event',
        event: { type: 'compaction_start', reason: 'manual' }
      })
      this.replaceMessages(this.compactedMessages)
      this.emit({
        type: 'pi-event',
        event: {
          type: 'compaction_end',
          reason: 'manual',
          result: { summary: 'Compacted', firstKeptEntryId: 'kept', tokensBefore: 100 },
          aborted: false,
          willRetry: false
        }
      })
      return { type: 'accepted' }
    }
    if (command.type === 'get_messages' && this.failCompactedMessages) {
      this.failCompactedMessages = false
      throw new Error('compacted messages unavailable')
    }
    return super.send(command)
  }
}

class MalformedCompactionRuntimeHost extends FakeRuntimeHost {
  override async send(command: RuntimeCommand): Promise<RuntimeCommandResult> {
    if (command.type !== 'compact') return super.send(command)
    this.commands.push(command)
    this.emit({
      type: 'pi-event',
      event: { type: 'compaction_start', reason: 'manual' }
    })
    this.emit({
      type: 'pi-event',
      event: {
        type: 'compaction_end',
        reason: 'manual',
        result: 42,
        aborted: false,
        willRetry: false
      }
    })
    return { type: 'accepted' }
  }
}

class DelayedCompactionProjectionRuntimeHost extends CompactingRuntimeHost {
  readonly projectionEntered: Promise<void>
  private readonly markProjectionEntered: () => void
  private readonly projectionGate: Promise<void>
  private readonly releaseProjectionGate: () => void

  constructor(initialMessages: unknown[], compactedMessages: unknown[]) {
    super(initialMessages, compactedMessages)
    let markProjectionEntered!: () => void
    let releaseProjectionGate!: () => void
    this.projectionEntered = new Promise((resolve) => {
      markProjectionEntered = resolve
    })
    this.projectionGate = new Promise((resolve) => {
      releaseProjectionGate = resolve
    })
    this.markProjectionEntered = markProjectionEntered
    this.releaseProjectionGate = releaseProjectionGate
  }

  override async send(command: RuntimeCommand): Promise<RuntimeCommandResult> {
    if (command.type === 'get_state' && this.commands.some(({ type }) => type === 'compact')) {
      this.commands.push(command)
      this.markProjectionEntered()
      await this.projectionGate
      return { type: 'state', state: this.sessionState }
    }
    return super.send(command)
  }

  releaseProjection(): void {
    this.releaseProjectionGate()
  }
}

class DelayedStartRuntimeHost extends FakeRuntimeHost {
  readonly startEntered: Promise<void>
  private readonly markStartEntered: () => void
  private readonly startGate: Promise<void>
  private readonly releaseStartGate: () => void

  constructor(sessionState?: PiRpcSessionState) {
    super(sessionState)
    let markStartEntered!: () => void
    let releaseStartGate!: () => void
    this.startEntered = new Promise((resolve) => {
      markStartEntered = resolve
    })
    this.startGate = new Promise((resolve) => {
      releaseStartGate = resolve
    })
    this.markStartEntered = markStartEntered
    this.releaseStartGate = releaseStartGate
  }

  override async start(): Promise<void> {
    this.startCalls += 1
    this.markStartEntered()
    await this.startGate
  }

  releaseStart(): void {
    this.releaseStartGate()
  }
}

class FailingStartRuntimeHost extends FakeRuntimeHost {
  override async start(): Promise<void> {
    this.startCalls += 1
    throw new Error('start failed')
  }
}

class FailingCommandRuntimeHost extends FakeRuntimeHost {
  private readonly failingCommand:
    'get_state' | 'get_session_stats' | 'get_messages' | 'get_commands' | 'get_available_models'

  constructor(
    failingCommand:
      'get_state' | 'get_session_stats' | 'get_messages' | 'get_commands' | 'get_available_models',
    sessionState?: PiRpcSessionState,
    messages: unknown[] = []
  ) {
    super(sessionState, messages)
    this.failingCommand = failingCommand
  }

  override async send(command: RuntimeCommand): Promise<RuntimeCommandResult> {
    if (command.type === this.failingCommand) throw new Error(`${this.failingCommand} failed`)
    return super.send(command)
  }
}

class FailingThenStoppingRuntimeHost extends FailingCommandRuntimeHost {
  constructor() {
    super('get_messages')
  }

  override async stop(): Promise<void> {
    this.stopCalls += 1
    if (this.stopCalls === 1) throw new Error('stop failed')
  }
}

class DelayedStopRuntimeHost extends FakeRuntimeHost {
  readonly stopEntered: Promise<void>
  private readonly markStopEntered: () => void
  private readonly stopGate: Promise<void>
  private readonly releaseStopGate: () => void

  constructor() {
    super()
    let markStopEntered!: () => void
    let releaseStopGate!: () => void
    this.stopEntered = new Promise((resolve) => {
      markStopEntered = resolve
    })
    this.stopGate = new Promise((resolve) => {
      releaseStopGate = resolve
    })
    this.markStopEntered = markStopEntered
    this.releaseStopGate = releaseStopGate
  }

  override async stop(): Promise<void> {
    this.stopCalls += 1
    this.markStopEntered()
    await this.stopGate
  }

  releaseStop(): void {
    this.releaseStopGate()
  }
}

class RejectablePromptRuntimeHost extends FakeRuntimeHost {
  readonly promptEntered: Promise<void>
  private readonly markPromptEntered: () => void
  private readonly promptResult: Promise<RuntimeCommandResult>
  private readonly rejectPromptResult: (error: Error) => void

  constructor() {
    super()
    let markPromptEntered!: () => void
    let rejectPromptResult!: (error: Error) => void
    this.promptEntered = new Promise((resolve) => {
      markPromptEntered = resolve
    })
    this.promptResult = new Promise((_resolve, reject) => {
      rejectPromptResult = reject
    })
    this.markPromptEntered = markPromptEntered
    this.rejectPromptResult = rejectPromptResult
  }

  override async send(command: RuntimeCommand): Promise<RuntimeCommandResult> {
    if (command.type !== 'prompt') return super.send(command)
    this.commands.push(command)
    this.markPromptEntered()
    return this.promptResult
  }

  rejectPrompt(error: Error): void {
    this.rejectPromptResult(error)
  }
}

function collectStatuses(kernel: WorkbenchKernel): RuntimeStatus[] {
  const statuses: RuntimeStatus[] = []
  kernel.subscribe((event: KernelEvent) => {
    if (event.type === 'kernel.state-changed') statuses.push(event.state.runtime.status)
    else if (event.type === 'kernel.state-patched' && event.patch.runtime !== undefined) {
      statuses.push(event.patch.runtime.status)
    }
  })
  return statuses
}

function waitForCompactionOutcome(
  kernel: WorkbenchKernel,
  outcome: 'completed' | 'retrying' | 'cancelled' | 'failed'
): Promise<Extract<KernelEvent, { type: 'kernel.compaction-ended' }>> {
  return new Promise((resolve) => {
    const unsubscribe = kernel.subscribe((event) => {
      if (event.type !== 'kernel.compaction-ended' || event.outcome !== outcome) return
      unsubscribe()
      resolve(event)
    })
  })
}

function kernelOptions(
  recentSession: SessionPointer | null = null,
  persisted: SessionPointer[] = [],
  activeProjects: string[] = [],
  persistedProjects: KernelProjectState[] = [],
  generateSessionName?: SessionNameGenerator,
  archivedSessions: Array<{ projectPath: string, sessionKey: string }> = []
): {
  sessionRegistry: ProjectSessionRegistry
  persistProject: (project: KernelProjectState) => Promise<void>
  persistActiveProject: (projectKey: string) => Promise<void>
  persistSession: (pointer: SessionPointer) => Promise<void>
  persistArchivedSession: (projectPath: string, sessionKey: string) => Promise<void>
  validateSession: (pointer: SessionPointer) => Promise<SessionPointer>
  generateSessionName?: SessionNameGenerator
} {
  return {
    sessionRegistry: sessionRegistry(recentSession),
    validateSession: async (pointer) => pointer,
    persistProject: async (project) => {
      persistedProjects.push(project)
    },
    persistActiveProject: async (projectKey) => {
      activeProjects.push(projectKey)
    },
    persistSession: async (pointer) => {
      persisted.push(pointer)
    },
    persistArchivedSession: async (projectPath, sessionKey) => {
      archivedSessions.push({ projectPath, sessionKey })
    },
    ...(generateSessionName === undefined ? {} : { generateSessionName })
  }
}

function sessionRegistry(pointer: SessionPointer | null): ProjectSessionRegistry {
  return {
    sessions: pointer === null ? [] : [pointer],
    activeSessionKey: pointer?.sessionFile ?? null
  }
}

function fileError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

test('advisor system toggle gates capability and refreshes the confirmed state', async () => {
  const unavailableRuntime = new FakeRuntimeHost()
  const unavailableKernel = new WorkbenchKernel(
    () => unavailableRuntime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions()
  )
  await unavailableKernel.start()
  assert.equal(unavailableKernel.getState().advisor.compatibility, 'unavailable')
  await assert.rejects(
    unavailableKernel.setAdvisorSystemEnabled(true),
    /live toggle is unavailable/
  )

  const runtime = new AdvisorRuntimeHost(false)
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions()
  )
  await kernel.start()
  assert.deepEqual(kernel.getState().advisor, {
    compatibility: 'ready',
    extensionVersion: '1.0.0',
    systemEnabled: false,
    liveToggle: true,
    multiAdvisor: true,
    roster: true,
    error: null
  })

  await kernel.setAdvisorSystemEnabled(true)
  assert.equal(kernel.getState().advisor.systemEnabled, true)
  assert.deepEqual(runtime.commands.slice(-3), [
    { type: 'prompt', message: '/advisor on' },
    { type: 'get_state' },
    { type: 'get_entries' }
  ])

  runtime.setConfirmToggle(false)
  await assert.rejects(
    kernel.setAdvisorSystemEnabled(false),
    /did not confirm/
  )
  assert.equal(kernel.getState().advisor.systemEnabled, true)
})

test('advisor commands require strict boolean payloads', () => {
  for (const type of [
    'kernel.set-advisor-system-enabled',
    'kernel.set-advisor-extension-enabled'
  ] as const) {
    assert.equal(isKernelCommand({ type, enabled: true }), true)
    assert.equal(isKernelCommand({ type, enabled: false }), true)
    assert.equal(isKernelCommand({ type, enabled: 'true' }), false)
    assert.equal(isKernelCommand({ type, enabled: true, extra: true }), false)
  }
})

test('normal start and stop follows the lifecycle', async () => {
  const runtime = new FakeRuntimeHost()
  const kernel = new WorkbenchKernel(() => runtime, { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' }, kernelOptions())
  const statuses = collectStatuses(kernel)

  await kernel.start()
  await kernel.stop()

  assert.deepEqual(statuses, ['starting', 'ready', 'stopping', 'stopped'])
  assert.equal(kernel.getState().runtime.status, 'stopped')
})

test('appearance settings persist strict visual and token count format changes', async () => {
  const persisted: AppearanceSettings[] = []
  const kernel = new WorkbenchKernel(
    () => new FakeRuntimeHost(),
    { projects: [], activeProjectKey: null },
    {
      ...kernelOptions(),
      persistAppearance: async (settings) => {
        persisted.push(settings)
      }
    }
  )

  assert.deepEqual(kernel.getState().appearance, {
    theme: 'system',
    accentColor: 'amber',
    surfaceTransparency: 20,
    textSize: 'default',
    tokenCountFormat: 'full',
    uiFontFamily: null,
    codeFontFamily: null
  })
  await kernel.setAppearance({
    theme: 'dark',
    accentColor: 'blue',
    surfaceTransparency: 30,
    textSize: 'large',
    tokenCountFormat: 'compact',
    uiFontFamily: null,
    codeFontFamily: null
  })
  assert.deepEqual(persisted, [{
    theme: 'dark',
    accentColor: 'blue',
    surfaceTransparency: 30,
    textSize: 'large',
    tokenCountFormat: 'compact',
    uiFontFamily: null,
    codeFontFamily: null
  }])
  await assert.rejects(
    kernel.setAppearance({
      theme: 'sepia',
      accentColor: 'amber',
      surfaceTransparency: 20,
      textSize: 'default',
      tokenCountFormat: 'full',
      uiFontFamily: null,
      codeFontFamily: null
    } as unknown as AppearanceSettings),
    /Invalid appearance settings/
  )
  await assert.rejects(
    kernel.setAppearance({
      theme: 'system',
      accentColor: 'amber',
      surfaceTransparency: 20,
      textSize: 'default',
      tokenCountFormat: 'short',
      uiFontFamily: null,
      codeFontFamily: null
    } as unknown as AppearanceSettings),
    /Invalid appearance settings/
  )
})

test('general settings default to restore and update only after persistence succeeds', async () => {
  const persisted: GeneralSettings[] = []
  const kernel = new WorkbenchKernel(
    () => new FakeRuntimeHost(),
    { projects: [], activeProjectKey: null },
    {
      ...kernelOptions(),
      persistGeneral: async (settings) => {
        persisted.push(settings)
      }
    }
  )

  assert.deepEqual(kernel.getState().general, {
    startupWorkspaceRestore: 'restore',
    doubleClickBorderMaximize: true,
    fastExtensionLoading: false
  })
  await kernel.setGeneral({
    startupWorkspaceRestore: 'none',
    doubleClickBorderMaximize: true,
    fastExtensionLoading: false
  })
  assert.deepEqual(persisted, [{
    startupWorkspaceRestore: 'none',
    doubleClickBorderMaximize: true,
    fastExtensionLoading: false
  }])
  assert.deepEqual(kernel.getState().general, {
    startupWorkspaceRestore: 'none',
    doubleClickBorderMaximize: true,
    fastExtensionLoading: false
  })
  await assert.rejects(
    kernel.setGeneral({
      startupWorkspaceRestore: 'invalid',
      doubleClickBorderMaximize: true,
      fastExtensionLoading: false
    } as unknown as GeneralSettings),
    /Invalid general settings/
  )
})

test('general settings can toggle double-click border maximize', async () => {
  const persisted: GeneralSettings[] = []
  const kernel = new WorkbenchKernel(
    () => new FakeRuntimeHost(),
    { projects: [], activeProjectKey: null },
    {
      ...kernelOptions(),
      persistGeneral: async (settings) => {
        persisted.push(settings)
      }
    }
  )

  await kernel.setGeneral({
    startupWorkspaceRestore: 'restore',
    doubleClickBorderMaximize: false,
    fastExtensionLoading: false
  })
  assert.deepEqual(persisted, [{
    startupWorkspaceRestore: 'restore',
    doubleClickBorderMaximize: false,
    fastExtensionLoading: false
  }])
  assert.equal(kernel.getState().general.doubleClickBorderMaximize, false)
})

test('fast extension loading is snapshotted only when a runtime is created', async () => {
  const runtimes = [
    new FakeRuntimeHost(),
    new FakeRuntimeHost({ sessionId: 'session-2', sessionFile: '/tmp/session-2.jsonl' })
  ]
  const launches: boolean[] = []
  const kernel = new WorkbenchKernel(
    (_project, launchOptions) => {
      launches.push(launchOptions.fastExtensionLoading)
      const runtime = runtimes.shift()
      assert.ok(runtime)
      return runtime
    },
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions()
  )

  await kernel.start()
  await kernel.setGeneral({
    startupWorkspaceRestore: 'restore',
    doubleClickBorderMaximize: true,
    fastExtensionLoading: true
  })
  assert.deepEqual(launches, [false])

  await kernel.start()
  assert.deepEqual(launches, [false, true])
})

test('subagent settings update only after strict persistence succeeds', async () => {
  const persisted: SubagentSettings[] = []
  let rejectPersistence = false
  const kernel = new WorkbenchKernel(
    () => new FakeRuntimeHost(),
    { projects: [], activeProjectKey: null },
    {
      ...kernelOptions(),
      persistSubagent: async (settings) => {
        if (rejectPersistence) throw new Error('subagent persistence failed')
        persisted.push(settings)
      }
    }
  )

  assert.deepEqual(kernel.getState().subagent, DEFAULT_SUBAGENT_SETTINGS)
  await kernel.setSubagent({ maxDepth: 2 })
  assert.deepEqual(persisted, [{ maxDepth: 2 }])
  assert.deepEqual(kernel.getState().subagent, { maxDepth: 2 })
  rejectPersistence = true
  await assert.rejects(
    kernel.setSubagent({ maxDepth: 1 }),
    /subagent persistence failed/u
  )
  assert.deepEqual(kernel.getState().subagent, { maxDepth: 2 })
  await assert.rejects(
    kernel.setSubagent({ maxDepth: 4 as 1 }),
    /Invalid subagent settings/u
  )
})

test('shortcut settings update only after strict persistence succeeds', async () => {
  const persisted: ShortcutSettings[] = []
  let rejectPersistence = false
  const kernel = new WorkbenchKernel(
    () => new FakeRuntimeHost(),
    { projects: [], activeProjectKey: null },
    {
      ...kernelOptions(),
      persistShortcuts: async (settings) => {
        if (rejectPersistence) throw new Error('shortcut persistence failed')
        persisted.push(settings)
      }
    }
  )
  const custom = {
    ...DEFAULT_SHORTCUT_SETTINGS,
    'new-session': null,
    'open-model-selector': 'Ctrl+M'
  }

  await kernel.setShortcuts(custom)
  assert.deepEqual(persisted, [custom])
  assert.deepEqual(kernel.getState().shortcuts, custom)
  rejectPersistence = true
  await assert.rejects(
    kernel.setShortcuts({ ...custom, 'open-model-selector': null }),
    /shortcut persistence failed/
  )
  assert.deepEqual(kernel.getState().shortcuts, custom)
  await assert.rejects(
    kernel.setShortcuts({ ...custom, 'open-model-selector': custom['focus-composer'] }),
    /Invalid shortcut settings/
  )
})

test('exposes a normalized model catalog and keeps model selection typed', async () => {
  const runtime = new FakeRuntimeHost(
    {
      sessionId: 'session-1',
      sessionFile: '/tmp/session-1.jsonl',
      model: {
        id: 'claude-test',
        provider: 'anthropic',
        name: 'Claude Test',
        reasoning: true,
        thinkingLevelMap: { low: 'low', xhigh: null }
      }
    },
    [],
    [],
    [{
      id: 'claude-test',
      provider: 'anthropic',
      name: 'Claude Test',
      reasoning: true,
      thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null },
      contextWindow: 200000,
      cost: {
        input: 3,
        output: 15,
        cacheRead: 0.3,
        cacheWrite: 3.75,
        tiers: [{
          inputTokensAbove: 200000,
          input: 6,
          output: 22.5,
          cacheRead: 0.6,
          cacheWrite: 7.5
        }]
      },
      baseUrl: 'https://private.example'
    } as PiRpcAvailableModel],
    {
      sessionId: 'session-1',
      sessionFile: '/tmp/session-1.jsonl',
      userMessages: 3,
      assistantMessages: 4,
      toolCalls: 5,
      toolResults: 5,
      totalMessages: 12,
      tokens: {
        input: 42000,
        output: 3600,
        cacheRead: 18000,
        cacheWrite: 2000,
        total: 65600
      },
      cost: 0.42,
      contextUsage: {
        tokens: 56000,
        contextWindow: 200000,
        percent: 28
      }
    }
  )
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions()
  )

  await kernel.start()

  const readyState = kernel.getState()
  assert.deepEqual(readyState.availableModels, [{
    id: 'claude-test',
    provider: 'anthropic',
    name: 'Claude Test',
    reasoning: true,
    thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high', xhigh: null, max: null },
    contextWindow: 200000,
    pricing: {
      input: 3,
      output: 15,
      cacheRead: 0.3,
      cacheWrite: 3.75,
      tiers: [{
        inputTokensAbove: 200000,
        input: 6,
        output: 22.5,
        cacheRead: 0.6,
        cacheWrite: 7.5
      }]
    }
  }])
  assert.deepEqual(readyState.session.model?.thinkingLevelMap, { low: 'low', xhigh: null })
  assert.deepEqual(readyState.session.usage, {
    inputTokens: 42000,
    outputTokens: 3600,
    cacheReadTokens: 18000,
    cacheWriteTokens: 2000,
    totalTokens: 65600,
    contextTokens: 56000,
    contextWindow: 200000,
    contextPercent: 28,
    cost: 0.42
  })
  readyState.availableModels[0]!.name = 'mutated copy'
  readyState.availableModels[0]!.thinkingLevelMap.low = 'mutated copy'
  readyState.availableModels[0]!.pricing!.input = 999
  readyState.availableModels[0]!.pricing!.tiers![0]!.output = 999
  if (readyState.session.model !== null) readyState.session.model.thinkingLevelMap.low = 'mutated copy'
  assert.equal(kernel.getState().availableModels[0]?.name, 'Claude Test')
  assert.equal(kernel.getState().availableModels[0]?.thinkingLevelMap.low, 'low')
  assert.equal(kernel.getState().availableModels[0]?.pricing?.input, 3)
  assert.equal(kernel.getState().availableModels[0]?.pricing?.tiers?.[0]?.output, 22.5)
  assert.equal(kernel.getState().session.model?.thinkingLevelMap.low, 'low')

  await kernel.setModel('anthropic', 'claude-test')
  assert.deepEqual(runtime.commands.slice(-2), [
    { type: 'set_model', provider: 'anthropic', modelId: 'claude-test' },
    { type: 'get_state' }
  ])
  assert.deepEqual(kernel.getState().session.model, {
    id: 'claude-test',
    provider: 'anthropic',
    name: 'claude-test',
    reasoning: false,
    thinkingLevelMap: {},
    contextWindow: null
  })
})

test('refreshes session usage after an assistant message reports usage', async () => {
  const initialStats: PiRpcSessionStats = {
    sessionId: 'session-1',
    sessionFile: '/tmp/session-1.jsonl',
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
    tokens: { input: 100, output: 20, cacheRead: 50, cacheWrite: 0, total: 170 },
    cost: 0,
    contextUsage: { tokens: 120, contextWindow: 1000, percent: 12 }
  }
  const nextStats: PiRpcSessionStats = {
    ...initialStats,
    assistantMessages: 1,
    totalMessages: 2,
    tokens: { input: 400, output: 80, cacheRead: 200, cacheWrite: 20, total: 700 },
    contextUsage: { tokens: 520, contextWindow: 1000, percent: 52 }
  }
  const runtime = new FakeRuntimeHost(undefined, [], [], undefined, initialStats)
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions()
  )

  await kernel.start()
  runtime.setSessionStats(nextStats)
  runtime.emit({
    type: 'pi-event',
    event: {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Done' }],
        usage: { input: 300, output: 60, cacheRead: 150, cacheWrite: 20 }
      }
    }
  })
  await new Promise<void>((resolve) => setImmediate(resolve))

  assert.deepEqual(kernel.getState().session.usage, {
    inputTokens: 400,
    outputTokens: 80,
    cacheReadTokens: 200,
    cacheWriteTokens: 20,
    totalTokens: 700,
    contextTokens: 520,
    contextWindow: 1000,
    contextPercent: 52,
    cost: 0
  })
})

test('coalesces overlapping session usage refreshes per runtime', async () => {
  const initialStats: PiRpcSessionStats = {
    sessionId: 'session-1',
    sessionFile: '/tmp/session-1.jsonl',
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0
  }
  const runtime = new DeferredSessionStatsRuntimeHost(
    undefined,
    [],
    [],
    undefined,
    initialStats
  )
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions()
  )
  await kernel.start()
  runtime.beginDeferringSessionStats()

  for (const [timestamp, text] of [[1, 'First'], [2, 'Second']] as const) {
    runtime.emit({
      type: 'pi-event',
      event: {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text }],
          timestamp,
          usage: { input: timestamp, output: timestamp, cacheRead: 0, cacheWrite: 0 }
        }
      }
    })
  }
  assert.equal(runtime.pendingSessionStatsCount(), 1)

  runtime.resolveNextSessionStats({
    ...initialStats,
    assistantMessages: 1,
    totalMessages: 2,
    tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 }
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(runtime.pendingSessionStatsCount(), 1)

  runtime.resolveNextSessionStats({
    ...initialStats,
    assistantMessages: 2,
    totalMessages: 4,
    tokens: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, total: 30 }
  })
  await new Promise<void>((resolve) => setImmediate(resolve))

  assert.equal(runtime.pendingSessionStatsCount(), 0)
  assert.equal(kernel.getState().session.usage?.totalTokens, 30)
  assert.equal(kernel.getState().sessions[0]?.statistics?.totalMessages, 4)
})

test('discovers the normalized command catalog and routes typed commands', async () => {
  const runtime = new FakeRuntimeHost(
    undefined,
    [],
    [
      {
        name: 'review',
        description: 'Review changes',
        source: 'extension',
        sourceInfo: { source: 'review-extension', scope: 'project', origin: 'top-level' }
      },
      {
        name: 'ship',
        description: 'Prepare release',
        source: 'prompt',
        sourceInfo: { source: 'ship', scope: 'project', origin: 'top-level' }
      },
      {
        name: 'skill:verify',
        source: 'skill',
        sourceInfo: { source: 'verify', scope: 'project', origin: 'top-level' }
      }
    ]
  )
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions()
  )

  await kernel.start()
  assert.deepEqual(
    kernel.getState().commands
      .filter(({ source }) => source === 'extension' || source === 'prompt' || source === 'skill')
      .map(({ name, source }) => ({ name, source })),
    [
    { name: 'review', source: 'extension' },
    { name: 'ship', source: 'prompt' },
    { name: 'skill:verify', source: 'skill' }
    ]
  )

  await kernel.invokeCommand(SET_MODEL_COMMAND_ID, 'openrouter/anthropic/claude-test')
  await kernel.invokeCommand(SET_THINKING_COMMAND_ID, 'high')
  await kernel.invokeCommand(COMPACT_COMMAND_ID, 'Preserve decisions')
  await kernel.invokeCommand(SET_SESSION_NAME_COMMAND_ID, 'Release planning')

  assert.deepEqual(runtime.commands.slice(-10), [
    { type: 'set_model', provider: 'openrouter', modelId: 'anthropic/claude-test' },
    { type: 'get_state' },
    { type: 'set_thinking_level', level: 'high' },
    { type: 'get_state' },
    { type: 'compact', customInstructions: 'Preserve decisions' },
    { type: 'get_state' },
    { type: 'get_messages' },
    { type: 'get_session_stats' },
    { type: 'set_session_name', name: 'Release planning' },
    { type: 'get_state' }
  ])
  assert.deepEqual(
    kernel.getState().conversation.entries
      .filter((entry) => entry.kind === 'command')
      .map((entry) => entry.kind === 'command' ? entry.text : null),
    [
      '/model openrouter/anthropic/claude-test',
      '/thinking high',
      '/compact Preserve decisions',
      '/name Release planning'
    ]
  )
})

test('compact atomically rebuilds the conversation and preserves it when projection fails', async () => {
  const initialMessages = [
    { role: 'user', content: [{ type: 'text', text: 'Long request' }], timestamp: 10 },
    { role: 'assistant', content: [{ type: 'text', text: 'Long response' }], timestamp: 20 }
  ]
  const compactedMessages = [
    { role: 'assistant', content: [{ type: 'text', text: 'Compacted summary' }], timestamp: 30 }
  ]
  const runtime = new CompactingRuntimeHost(initialMessages, compactedMessages)
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions()
  )

  await kernel.start()
  await kernel.invokeCommand(COMPACT_COMMAND_ID, '')

  let entries = kernel.getState().conversation.entries
  assert.equal(entries.length, 2)
  assert.equal(entries[0]?.kind === 'message' ? entries[0].text : null, 'Compacted summary')
  assert.equal(entries[1]?.kind === 'command' ? entries[1].text : null, '/compact')
  assert.deepEqual(runtime.commands.slice(-4), [
    { type: 'compact' },
    { type: 'get_state' },
    { type: 'get_messages' },
    { type: 'get_session_stats' }
  ])

  const beforeFailure = entries
  const lifecycleEvents: KernelEvent[] = []
  kernel.subscribe((event) => {
    if (event.type === 'kernel.compaction-ended') lifecycleEvents.push(event)
  })
  runtime.failNextCompactedProjection()
  await assert.rejects(
    kernel.invokeCommand(COMPACT_COMMAND_ID, 'Keep decisions'),
    /compacted messages unavailable/
  )
  entries = kernel.getState().conversation.entries
  assert.deepEqual(entries, beforeFailure)
  assert.equal(kernel.getState().session.compaction, null)
  assert.deepEqual(lifecycleEvents, [{
    type: 'kernel.compaction-ended',
    projectKey: '/tmp/project',
    sessionKey: '/tmp/session-1.jsonl',
    reason: 'manual',
    outcome: 'failed',
    willRetry: false
  }])
})

test('compaction lifecycle normalizes all reasons and rejects malformed reasons', async () => {
  for (const reason of ['manual', 'threshold', 'overflow'] as const) {
    const runtime = new FakeRuntimeHost()
    const kernel = new WorkbenchKernel(
      () => runtime,
      { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
      kernelOptions()
    )
    await kernel.start()
    const events: KernelEvent[] = []
    kernel.subscribe((event) => events.push(event))

    runtime.emit({ type: 'pi-event', event: { type: 'compaction_start', reason } })
    assert.deepEqual(kernel.getState().session.compaction, { reason })
    const completed = waitForCompactionOutcome(kernel, 'completed')
    runtime.emit({
      type: 'pi-event',
      event: {
        type: 'compaction_end',
        reason,
        result: {
          summary: 'Private summary must not cross the boundary',
          firstKeptEntryId: 'kept',
          tokensBefore: 100
        },
        aborted: false,
        willRetry: false,
        errorMessage: 'must not cross the boundary'
      }
    })
    await completed

    assert.deepEqual(events.filter((event) =>
      event.type === 'kernel.compaction-started' || event.type === 'kernel.compaction-ended'
    ), [
      {
        type: 'kernel.compaction-started',
        projectKey: '/tmp/project',
        sessionKey: '/tmp/session-1.jsonl',
        reason
      },
      {
        type: 'kernel.compaction-ended',
        projectKey: '/tmp/project',
        sessionKey: '/tmp/session-1.jsonl',
        reason,
        outcome: 'completed',
        willRetry: false
      }
    ])
  }

  const runtime = new FakeRuntimeHost()
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions()
  )
  await kernel.start()
  runtime.emit({ type: 'pi-event', event: { type: 'compaction_start', reason: 'unknown' } })
  assert.equal(kernel.getState().session.compaction, null)
})

test('compaction terminal settlement is atomic under reentrant lifecycle listeners', async () => {
  const runtime = new FakeRuntimeHost()
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions()
  )
  await kernel.start()

  type Lifecycle = {
    revision: number
    promise: Promise<void>
    settled: boolean
  }
  const lifecycle = (): Lifecycle => {
    const context = (kernel as unknown as {
      activeContext: { compactionLifecycle: Lifecycle | null } | null
    }).activeContext
    assert.ok(context?.compactionLifecycle)
    return context.compactionLifecycle
  }

  const events: KernelEvent[] = []
  let reentered = false
  let secondLifecycle: Lifecycle | null = null
  kernel.subscribe((event) => {
    if (
      event.type !== 'kernel.compaction-started' &&
      event.type !== 'kernel.compaction-ended'
    ) return
    events.push(event)
    if (event.type === 'kernel.compaction-ended' && event.outcome === 'completed' && !reentered) {
      reentered = true
      runtime.emit({ type: 'pi-event', event: { type: 'compaction_start', reason: 'threshold' } })
      secondLifecycle = lifecycle()
      runtime.emit({
        type: 'pi-event',
        event: {
          type: 'compaction_end',
          reason: 'threshold',
          result: null,
          aborted: true,
          willRetry: false
        }
      })
    }
  })

  runtime.emit({ type: 'pi-event', event: { type: 'compaction_start', reason: 'manual' } })
  const firstLifecycle = lifecycle()
  runtime.emit({
    type: 'pi-event',
    event: {
      type: 'compaction_end',
      reason: 'manual',
      result: { summary: 'Compacted', firstKeptEntryId: 'kept', tokensBefore: 100 },
      aborted: false,
      willRetry: false
    }
  })

  await firstLifecycle.promise
  const observedSecondLifecycle = secondLifecycle as Lifecycle | null
  assert.ok(observedSecondLifecycle)
  await assert.rejects(observedSecondLifecycle.promise, /cancelled/)
  assert.notEqual(observedSecondLifecycle, firstLifecycle)
  assert.equal(observedSecondLifecycle.revision, firstLifecycle.revision + 1)
  assert.deepEqual(events, [
    {
      type: 'kernel.compaction-started',
      projectKey: '/tmp/project',
      sessionKey: '/tmp/session-1.jsonl',
      reason: 'manual'
    },
    {
      type: 'kernel.compaction-ended',
      projectKey: '/tmp/project',
      sessionKey: '/tmp/session-1.jsonl',
      reason: 'manual',
      outcome: 'completed',
      willRetry: false
    },
    {
      type: 'kernel.compaction-started',
      projectKey: '/tmp/project',
      sessionKey: '/tmp/session-1.jsonl',
      reason: 'threshold'
    },
    {
      type: 'kernel.compaction-ended',
      projectKey: '/tmp/project',
      sessionKey: '/tmp/session-1.jsonl',
      reason: 'threshold',
      outcome: 'cancelled',
      willRetry: false
    }
  ])
})

test('duplicate compaction starts are idempotent and conflicting starts fail the open lifecycle', async () => {
  const runtime = new FakeRuntimeHost()
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions()
  )
  await kernel.start()

  type Lifecycle = { promise: Promise<void>, settled: boolean }
  const currentLifecycle = (): Lifecycle => {
    const context = (kernel as unknown as {
      activeContext: { compactionLifecycle: Lifecycle | null } | null
    }).activeContext
    assert.ok(context?.compactionLifecycle)
    return context.compactionLifecycle
  }
  const events: KernelEvent[] = []
  kernel.subscribe((event) => {
    if (
      event.type === 'kernel.compaction-started' ||
      event.type === 'kernel.compaction-ended'
    ) events.push(event)
  })

  runtime.emit({ type: 'pi-event', event: { type: 'compaction_start', reason: 'manual' } })
  const first = currentLifecycle()
  runtime.emit({ type: 'pi-event', event: { type: 'compaction_start', reason: 'manual' } })
  assert.equal(currentLifecycle(), first)
  assert.equal(events.filter((event) => event.type === 'kernel.compaction-started').length, 1)

  runtime.emit({ type: 'pi-event', event: { type: 'compaction_start', reason: 'threshold' } })
  await assert.rejects(first.promise, /conflicting compaction start/)
  assert.equal(first.settled, true)
  assert.equal(kernel.getState().session.compaction, null)
  assert.deepEqual(events, [
    {
      type: 'kernel.compaction-started',
      projectKey: '/tmp/project',
      sessionKey: '/tmp/session-1.jsonl',
      reason: 'manual'
    },
    {
      type: 'kernel.compaction-ended',
      projectKey: '/tmp/project',
      sessionKey: '/tmp/session-1.jsonl',
      reason: 'manual',
      outcome: 'failed',
      willRetry: false
    }
  ])
})

test('fork operations fail before RPC while compaction is in progress', async () => {
  const runtime = new FakeRuntimeHost()
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions()
  )
  await kernel.start()
  runtime.emit({ type: 'pi-event', event: { type: 'compaction_start', reason: 'manual' } })
  const commandsBefore = runtime.commands.length

  await assert.rejects(kernel.listForkCandidates(), /Fork is unavailable while compaction is in progress/)
  await assert.rejects(kernel.forkSession('entry-1'), /Fork is unavailable while compaction is in progress/)
  assert.equal(runtime.commands.length, commandsBefore)

  runtime.emit({
    type: 'pi-event',
    event: {
      type: 'compaction_end',
      reason: 'manual',
      result: null,
      aborted: true,
      willRetry: false
    }
  })
})

test('overflow compaction accepts nullable wire results and preserves willRetry', async () => {
  const runtime = new FakeRuntimeHost()
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions()
  )
  await kernel.start()

  runtime.emit({ type: 'pi-event', event: { type: 'compaction_start', reason: 'overflow' } })
  const retrying = waitForCompactionOutcome(kernel, 'retrying')
  runtime.emit({
    type: 'pi-event',
    event: {
      type: 'compaction_end',
      reason: 'overflow',
      result: null,
      aborted: false,
      willRetry: true
    }
  })
  assert.equal((await retrying).willRetry, true)

  const completed = waitForCompactionOutcome(kernel, 'completed')
  runtime.emit({
    type: 'pi-event',
    event: {
      type: 'compaction_end',
      reason: 'overflow',
      result: { summary: 'Compacted', firstKeptEntryId: 'kept', tokensBefore: 100 },
      aborted: false,
      willRetry: true
    }
  })
  assert.equal((await completed).willRetry, true)
})

test('malformed compaction end rejects the command instead of leaving it pending', async () => {
  const runtime = new MalformedCompactionRuntimeHost()
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions()
  )
  await kernel.start()
  const events: KernelEvent[] = []
  kernel.subscribe((event) => events.push(event))

  await assert.rejects(
    kernel.invokeCommand(COMPACT_COMMAND_ID, ''),
    /invalid compaction lifecycle/
  )
  assert.equal(kernel.getState().session.compaction, null)
  assert.equal(events.some((event) =>
    event.type === 'kernel.compaction-ended' && event.outcome === 'failed'
  ), true)
})

test('stopping during a compaction projection rejects the command and clears lifecycle state', async () => {
  const runtime = new DelayedCompactionProjectionRuntimeHost(
    [],
    [{ role: 'assistant', content: [{ type: 'text', text: 'Compacted' }], timestamp: 2 }]
  )
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions()
  )
  await kernel.start()

  const invocation = kernel.invokeCommand(COMPACT_COMMAND_ID, '')
  const rejected = assert.rejects(invocation, /runtime stopped/)
  await runtime.projectionEntered
  await kernel.stop()
  await rejected
  assert.equal(kernel.getState().session.compaction, null)
  runtime.releaseProjection()
})

test('completed compaction atomically refreshes conversation, usage, and session statistics', async () => {
  const pointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/session-1.jsonl',
    sessionId: 'session-1',
    sessionName: 'Compaction'
  }
  const runtime = new FakeRuntimeHost(
    { sessionId: pointer.sessionId, sessionFile: pointer.sessionFile, model: { provider: 'openai', id: 'gpt' } },
    [{ role: 'assistant', content: [{ type: 'text', text: 'Before' }], timestamp: 1 }]
  )
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions(pointer)
  )
  await kernel.activateSession(pointer.sessionFile)
  runtime.replaceMessages([
    { role: 'assistant', content: [{ type: 'text', text: 'After compaction' }], timestamp: 2 }
  ])
  runtime.setSessionStats({
    sessionId: pointer.sessionId,
    sessionFile: pointer.sessionFile,
    userMessages: 2,
    assistantMessages: 3,
    toolCalls: 1,
    toolResults: 1,
    totalMessages: 7,
    tokens: { input: 100, output: 20, cacheRead: 30, cacheWrite: 4, total: 154 },
    cost: 0.12,
    contextUsage: { tokens: 80, contextWindow: 1000, percent: 8 }
  })
  const completed = waitForCompactionOutcome(kernel, 'completed')
  runtime.emit({ type: 'pi-event', event: { type: 'compaction_start', reason: 'threshold' } })
  runtime.emit({
    type: 'pi-event',
    event: {
      type: 'compaction_end',
      reason: 'threshold',
      result: { summary: 'Compacted', firstKeptEntryId: 'kept', tokensBefore: 100 },
      aborted: false,
      willRetry: false
    }
  })
  await completed

  const state = kernel.getState()
  assert.equal(state.conversation.entries[0]?.kind === 'message'
    ? state.conversation.entries[0].text
    : null, 'After compaction')
  assert.equal(state.session.usage?.contextTokens, 80)
  assert.equal(state.sessions[0]?.statistics?.totalMessages, 7)
  assert.equal(state.session.compaction, null)
})

test('compaction cancel and retry preserve the old projection without agent settlement', async () => {
  const runtime = new FakeRuntimeHost(
    undefined,
    [{ role: 'assistant', content: [{ type: 'text', text: 'Keep old projection' }], timestamp: 1 }]
  )
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions()
  )
  await kernel.start()
  const before = kernel.getState().conversation

  runtime.emit({ type: 'pi-event', event: { type: 'compaction_start', reason: 'overflow' } })
  const retrying = waitForCompactionOutcome(kernel, 'retrying')
  runtime.emit({
    type: 'pi-event',
    event: { type: 'compaction_end', reason: 'overflow', aborted: false, willRetry: true }
  })
  assert.equal((await retrying).outcome, 'retrying')
  assert.deepEqual(kernel.getState().conversation, before)
  assert.deepEqual(kernel.getState().session.compaction, { reason: 'overflow' })
  assert.equal(kernel.getState().session.settled, true)

  const cancelled = waitForCompactionOutcome(kernel, 'cancelled')
  runtime.emit({
    type: 'pi-event',
    event: { type: 'compaction_end', reason: 'overflow', aborted: true, willRetry: false }
  })
  assert.equal((await cancelled).outcome, 'cancelled')
  assert.deepEqual(kernel.getState().conversation, before)
  assert.equal(kernel.getState().session.compaction, null)
  assert.equal(kernel.getState().session.settled, true)
})

test('renaming an existing session updates navigation and persisted restart state', async () => {
  const pointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/existing-session.jsonl',
    sessionId: 'existing-session',
    sessionName: 'Old name'
  }
  const persisted: SessionPointer[] = []
  const runtime = new FakeRuntimeHost({
    sessionId: pointer.sessionId,
    sessionFile: pointer.sessionFile,
    sessionName: pointer.sessionName ?? undefined
  })
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions(pointer, persisted)
  )

  await kernel.resumeSession()
  persisted.length = 0
  await kernel.invokeCommand(SET_SESSION_NAME_COMMAND_ID, 'Renamed session')

  const renamedPointer = persisted.at(-1)
  assert.deepEqual(renamedPointer, { ...pointer, sessionName: 'Renamed session' })
  assert.equal(kernel.getState().session.name, 'Renamed session')
  assert.equal(kernel.getState().sessions[0]?.name, 'Renamed session')

  assert.ok(renamedPointer)
  const restarted = new WorkbenchKernel(
    () => new FakeRuntimeHost(),
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions(renamedPointer)
  )
  assert.equal(restarted.getState().session.name, 'Renamed session')
  assert.equal(restarted.getState().sessions[0]?.name, 'Renamed session')
})

test('resuming an existing unnamed session backfills a purpose-based name', async () => {
  const pointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/existing-unnamed-session.jsonl',
    sessionId: 'existing-unnamed-session',
    sessionName: null
  }
  const runtime = new FakeRuntimeHost(
    {
      sessionId: pointer.sessionId,
      sessionFile: pointer.sessionFile,
      model: { provider: 'openai', id: 'gpt-purpose' }
    },
    [
      { role: 'user', content: [{ type: 'text', text: 'Make session names describe the goal.' }], timestamp: 10 },
      { role: 'assistant', content: [{ type: 'text', text: 'I will generate a semantic title.' }], timestamp: 20 }
    ]
  )
  const persisted: SessionPointer[] = []
  let releaseGeneration!: (name: string) => void
  const generatedName = new Promise<string>((resolve) => {
    releaseGeneration = resolve
  })
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions(pointer, persisted, [], [], async () => generatedName)
  )

  await kernel.resumeSession()
  assert.equal(kernel.getState().session.name, null)
  const named = new Promise<void>((resolve) => {
    const unsubscribe = kernel.subscribe(() => {
      if (kernel.getState().session.name === 'Semantic session naming' && persisted.length === 2) {
        unsubscribe()
        resolve()
      }
    })
  })
  releaseGeneration('Semantic session naming')
  await named

  assert.deepEqual(persisted, [
    pointer,
    { ...pointer, sessionName: 'Semantic session naming' }
  ])
})

test('automatic naming never falls back to an expensive active model and allows an authorized override', async () => {
  const pointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/oauth-title-session.jsonl',
    sessionId: 'oauth-title-session',
    sessionName: null
  }
  const runtime = new FakeRuntimeHost(
    {
      sessionId: pointer.sessionId,
      sessionFile: pointer.sessionFile,
      model: { provider: 'openai-codex', id: 'gpt-5.6-sol' }
    },
    [
      { role: 'user', content: [{ type: 'text', text: 'Name this conversation by purpose.' }], timestamp: 10 },
      { role: 'assistant', content: [{ type: 'text', text: 'I will use the configured title model.' }], timestamp: 20 }
    ],
    [],
    [
      { id: 'gpt-5.6-sol', provider: 'openai-codex', reasoning: true },
      { id: 'gpt-5.4-mini', provider: 'oauth-provider', reasoning: true }
    ]
  )
  const persistedSettings: SessionNamingSettings[] = []
  let generationRequest: SessionNameGenerationRequest | null = null
  let releaseGeneration!: (name: string) => void
  const generatedName = new Promise<string>((resolve) => {
    releaseGeneration = resolve
  })
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(pointer, [], [], [], async (request) => {
        generationRequest = request
        return generatedName
      }),
      persistSessionNaming: async (settings) => {
        persistedSettings.push(settings)
      }
    }
  )

  await kernel.resumeSession()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(generationRequest, null)
  assert.equal(kernel.getState().session.name, null)

  await kernel.setSessionNaming({
    mode: 'model',
    provider: 'oauth-provider',
    modelId: 'gpt-5.4-mini'
  })
  const request = generationRequest as SessionNameGenerationRequest | null
  assert.ok(request)
  assert.deepEqual({ provider: request.provider, modelId: request.modelId }, {
    provider: 'oauth-provider',
    modelId: 'gpt-5.4-mini'
  })
  assert.deepEqual(persistedSettings, [{
    mode: 'model',
    provider: 'oauth-provider',
    modelId: 'gpt-5.4-mini'
  }])

  const named = new Promise<void>((resolve) => {
    const unsubscribe = kernel.subscribe(() => {
      if (kernel.getState().session.name === 'OAuth title model') {
        unsubscribe()
        resolve()
      }
    })
  })
  releaseGeneration('OAuth title model')
  await named
})

test('automatic naming still persists after the session is no longer foreground', async () => {
  const firstPointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/background-name-a.jsonl',
    sessionId: 'background-name-a',
    sessionName: null
  }
  const secondPointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/background-name-b.jsonl',
    sessionId: 'background-name-b',
    sessionName: 'Already named'
  }
  const runtimeA = new FakeRuntimeHost(
    {
      sessionId: firstPointer.sessionId,
      sessionFile: firstPointer.sessionFile,
      model: { provider: 'openai', id: 'gpt-purpose' }
    },
    [
      { role: 'user', content: [{ type: 'text', text: 'Name me after I leave the foreground.' }], timestamp: 10 },
      { role: 'assistant', content: [{ type: 'text', text: 'I will finish the title later.' }], timestamp: 20 }
    ]
  )
  const runtimeB = new FakeRuntimeHost({
    sessionId: secondPointer.sessionId,
    sessionFile: secondPointer.sessionFile,
    sessionName: secondPointer.sessionName ?? undefined,
    model: { provider: 'openai', id: 'gpt-purpose' }
  })
  const runtimes = [runtimeA, runtimeB]
  const persisted: SessionPointer[] = []
  let releaseGeneration!: (name: string) => void
  const generatedName = new Promise<string>((resolve) => {
    releaseGeneration = resolve
  })
  const kernel = new WorkbenchKernel(
    () => {
      const runtime = runtimes.shift()
      assert.ok(runtime)
      return runtime
    },
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(firstPointer, persisted, [], [], async () => generatedName),
      sessionRegistry: {
        sessions: [firstPointer, secondPointer],
        activeSessionKey: firstPointer.sessionFile
      }
    }
  )

  await kernel.resumeSession()
  assert.equal(kernel.getState().session.id, firstPointer.sessionId)
  assert.equal(kernel.getState().session.name, null)

  await kernel.activateSession(secondPointer.sessionFile)
  assert.equal(kernel.getState().session.id, secondPointer.sessionId)

  const named = new Promise<void>((resolve) => {
    const unsubscribe = kernel.subscribe(() => {
      const summary = kernel.getState().sessions.find(({ id }) => id === firstPointer.sessionId)
      const persistedName = persisted.some((pointer) =>
        pointer.sessionFile === firstPointer.sessionFile &&
        pointer.sessionName === 'Background purpose title'
      )
      if (summary?.name === 'Background purpose title' && persistedName) {
        unsubscribe()
        resolve()
      }
    })
  })
  releaseGeneration('Background purpose title')
  await named

  assert.equal(
    kernel.getState().sessions.find(({ id }) => id === firstPointer.sessionId)?.name,
    'Background purpose title'
  )
  assert.equal(kernel.getState().session.id, secondPointer.sessionId)
  assert.equal(kernel.getState().session.name, 'Already named')
  assert.deepEqual(
    runtimeA.commands.filter(({ type }) => type === 'set_session_name'),
    [{ type: 'set_session_name', name: 'Background purpose title' }]
  )
  assert.ok(persisted.some((pointer) =>
    pointer.sessionFile === firstPointer.sessionFile &&
    pointer.sessionName === 'Background purpose title'
  ))
})

test('automatic naming prefers mini then codex-spark within the active provider', async () => {
  const pointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/auto-model-order-session.jsonl',
    sessionId: 'auto-model-order-session',
    sessionName: null
  }
  const runtime = new FakeRuntimeHost(
    {
      sessionId: pointer.sessionId,
      sessionFile: pointer.sessionFile,
      model: { provider: 'vvqq-cpa', id: 'gpt-5.6-sol' }
    },
    [
      { role: 'user', content: [{ type: 'text', text: 'Choose a cheap title model.' }], timestamp: 10 },
      { role: 'assistant', content: [{ type: 'text', text: 'I will use the authorized low-cost model.' }], timestamp: 20 }
    ],
    [],
    [
      { id: 'gpt-5.6-sol', provider: 'vvqq-cpa', name: 'Sol', reasoning: true },
      { id: 'gpt-5.3-codex-spark', provider: 'vvqq-cpa', name: 'Spark', reasoning: true },
      { id: 'gpt-5.6-luna', provider: 'vvqq-cpa', name: 'Luna', reasoning: true }
    ]
  )
  let generationRequest: SessionNameGenerationRequest | null = null
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions(pointer, [], [], [], async (request) => {
      generationRequest = request
      return 'Spark title model'
    })
  )

  await kernel.resumeSession()
  await new Promise<void>((resolve) => setImmediate(resolve))
  const request = generationRequest as SessionNameGenerationRequest | null
  assert.ok(request)
  assert.deepEqual({ provider: request.provider, modelId: request.modelId }, {
    provider: 'vvqq-cpa',
    modelId: 'gpt-5.3-codex-spark'
  })
})

test('a manual session name cancels an in-flight generated name', async () => {
  const pointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/manually-named-session.jsonl',
    sessionId: 'manually-named-session',
    sessionName: null
  }
  const runtime = new FakeRuntimeHost(
    {
      sessionId: pointer.sessionId,
      sessionFile: pointer.sessionFile,
      model: { provider: 'openai', id: 'gpt-purpose' }
    },
    [
      { role: 'user', content: [{ type: 'text', text: 'Generate a useful session title.' }], timestamp: 10 },
      { role: 'assistant', content: [{ type: 'text', text: 'I will name it by purpose.' }], timestamp: 20 }
    ]
  )
  const persisted: SessionPointer[] = []
  let generationRequest: SessionNameGenerationRequest | null = null
  let releaseGeneration!: (name: string) => void
  const generatedName = new Promise<string>((resolve) => {
    releaseGeneration = resolve
  })
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions(pointer, persisted, [], [], async (request) => {
      generationRequest = request
      return generatedName
    })
  )

  await kernel.resumeSession()
  const request = generationRequest as SessionNameGenerationRequest | null
  assert.ok(request)
  assert.equal(request.signal.aborted, false)

  await kernel.invokeCommand(SET_SESSION_NAME_COMMAND_ID, 'Manual purpose name')
  assert.equal(request.signal.aborted, true)
  releaseGeneration('Generated name must not win')
  await new Promise<void>((resolve) => setImmediate(resolve))

  assert.deepEqual(
    runtime.commands.filter(({ type }) => type === 'set_session_name'),
    [{ type: 'set_session_name', name: 'Manual purpose name' }]
  )
  assert.deepEqual(persisted, [
    pointer,
    { ...pointer, sessionName: 'Manual purpose name' }
  ])
  assert.equal(kernel.getState().session.name, 'Manual purpose name')
})

test('invokes catalog prompt commands without passing unknown slash text through', async () => {
  const runtime = new FakeRuntimeHost(
    undefined,
    [],
    [
      {
        name: 'review',
        source: 'extension',
        sourceInfo: { source: 'review-extension', scope: 'project', origin: 'top-level' }
      },
      {
        name: 'ship',
        source: 'prompt',
        sourceInfo: { source: 'ship', scope: 'project', origin: 'top-level' }
      },
      {
        name: 'ctx-status',
        source: 'extension',
        sourceInfo: {
          source: '@cortexkit/pi-magic-context',
          scope: 'user',
          origin: 'package'
        }
      }
    ]
  )
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions()
  )

  await kernel.start()
  const extension = kernel.getState().commands.find(({ name }) => name === 'review')
  const prompt = kernel.getState().commands.find(({ name }) => name === 'ship')
  const magicStatus = kernel.getState().commands.find(({ name }) => name === 'ctx-status')
  assert.ok(extension)
  assert.ok(prompt)
  assert.ok(magicStatus)

  await kernel.invokeCommand(extension.id, 'current diff')
  assert.equal(kernel.getState().runtime.status, 'ready')
  assert.deepEqual(runtime.commands.slice(-2), [
    { type: 'prompt', message: '/review current diff' },
    { type: 'get_state' }
  ])
  const commandEcho = kernel.getState().conversation.entries.find(
    (entry) => entry.kind === 'command'
  )
  assert.equal(
    commandEcho?.kind === 'command' ? commandEcho.text : null,
    '/review current diff'
  )

  runtime.setStreaming(true)
  await kernel.invokeCommand(prompt.id, '')
  assert.equal(kernel.getState().runtime.status, 'running')
  assert.deepEqual(runtime.commands.slice(-2), [
    { type: 'prompt', message: '/ship' },
    { type: 'get_state' }
  ])
  runtime.setStreaming(false)
  runtime.emit({ type: 'pi-event', event: { type: 'agent_settled' } })
  assert.equal(kernel.getState().runtime.status, 'ready')

  runtime.emit({
    type: 'pi-event',
    event: {
      type: 'extension_ui_request',
      method: 'setStatus',
      statusKey: 'magic-context',
      statusText: 'mc: 8.2k (13%) · idle'
    }
  })
  await kernel.invokeCommand(magicStatus.id, '')
  const magicEntries = kernel.getState().conversation.entries.filter(
    (entry) => entry.kind === 'extension-status'
  )
  assert.deepEqual(magicEntries.map((entry) => entry.kind === 'extension-status'
    ? { title: entry.title, text: entry.text, level: entry.level }
    : null), [
    { title: 'Magic Context', text: 'mc: 8.2k (13%) · idle', level: 'info' },
    { title: 'Magic Context 状态', text: 'mc: 8.2k (13%) · idle', level: 'info' }
  ])

  await assert.rejects(kernel.invokeCommand('missing-command', ''), /not available/)
  await assert.rejects(kernel.invokeCommand(SET_MODEL_COMMAND_ID, 'missing-provider'), /provider\/model/)
})

test('GUI-only slash commands reject direct kernel invocation without reaching Pi', async () => {
  const runtime = new FakeRuntimeHost()
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions()
  )

  await kernel.start()
  const commandCount = runtime.commands.length
  for (const commandId of [
    FORK_SESSION_COMMAND_ID,
    EXPORT_SESSION_COMMAND_ID,
    COPY_LAST_ANSWER_COMMAND_ID
  ]) {
    await assert.rejects(kernel.invokeCommand(commandId, ''), /handled by the renderer/)
    await assert.rejects(kernel.invokeCommand(commandId, 'unexpected'), /does not accept arguments/)
  }
  assert.equal(runtime.commands.length, commandCount)
})

test('the typed new command starts one additional runtime', async () => {
  const firstRuntime = new FakeRuntimeHost()
  const secondRuntime = new FakeRuntimeHost({
    sessionId: 'session-2',
    sessionFile: '/tmp/session-2.jsonl'
  })
  const runtimes = [firstRuntime, secondRuntime]
  const kernel = new WorkbenchKernel(
    () => {
      const runtime = runtimes.shift()
      assert.ok(runtime)
      return runtime
    },
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions()
  )

  await kernel.start()
  await kernel.invokeCommand(NEW_SESSION_COMMAND_ID, '')

  assert.equal(firstRuntime.stopCalls, 0)
  assert.equal(secondRuntime.startCalls, 1)
  assert.equal(kernel.getState().session.id, 'session-2')
})

test('stop during start cancels the old start without reviving the runtime', async () => {
  const runtime = new DelayedStartRuntimeHost()
  const kernel = new WorkbenchKernel(() => runtime, { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' }, kernelOptions())
  const statuses = collectStatuses(kernel)

  const startPromise = kernel.start()
  await runtime.startEntered
  const stopPromise = kernel.stop()
  runtime.releaseStart()

  await assert.rejects(startPromise, /cancelled/i)
  await stopPromise

  assert.equal(kernel.getState().runtime.status, 'stopped')
  assert.equal(statuses.includes('ready'), false)
  assert.equal(statuses.includes('crashed'), false)
  await kernel.addProject('/tmp/next-project', sessionRegistry(null))
  assert.equal(kernel.getState().activeProjectKey, '/tmp/next-project')
  assert.deepEqual(
    kernel.getState().projects.map(({ path, busySessionCount }) => ({ path, busySessionCount })),
    [
      { path: '/tmp/project', busySessionCount: 0 },
      { path: '/tmp/next-project', busySessionCount: 0 }
    ]
  )
})

test('activity transitions ready to running and back to ready', async () => {
  const runtime = new FakeRuntimeHost()
  const kernel = new WorkbenchKernel(() => runtime, { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' }, kernelOptions())
  const statuses = collectStatuses(kernel)

  await kernel.start()
  runtime.emit({ type: 'activity-started' })
  runtime.emit({ type: 'activity-settled' })

  assert.deepEqual(statuses, ['starting', 'ready', 'running', 'ready'])
})

test('unexpected exit crashes and later activity cannot make it running', async () => {
  const runtime = new FakeRuntimeHost()
  const kernel = new WorkbenchKernel(() => runtime, { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' }, kernelOptions())

  await kernel.start()
  runtime.emit({ type: 'process-exit', code: 7, signal: null })
  runtime.emit({ type: 'activity-started' })

  const state = kernel.getState().runtime
  assert.equal(state.status, 'crashed')
  assert.equal(state.exitCode, 7)
  assert.equal(state.lastError, 'Pi RPC process exited with code 7.')
})

test('prompt rejection after process exit preserves the crashed state and exit diagnosis', async () => {
  const runtime = new RejectablePromptRuntimeHost()
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions()
  )

  await kernel.start()
  const promptPromise = kernel.prompt('Keep the crash diagnosis')
  await runtime.promptEntered
  runtime.emit({ type: 'process-exit', code: 9, signal: null })
  runtime.rejectPrompt(new Error('prompt transport rejected'))

  await assert.rejects(promptPromise, /prompt transport rejected/)
  const state = kernel.getState()
  assert.equal(state.runtime.status, 'crashed')
  assert.equal(state.runtime.exitCode, 9)
  assert.equal(state.runtime.lastError, 'Pi RPC process exited with code 9.')
  assert.equal(state.session.settled, false)
})

test('project path is required and passed to the runtime factory', async () => {
  const runtime = new FakeRuntimeHost()
  let receivedProject: { path: string } | null = null
  const persistedProjects: KernelProjectState[] = []
  const kernel = new WorkbenchKernel((project) => {
    receivedProject = project
    return runtime
  }, { projects: [], activeProjectKey: null }, kernelOptions(null, [], [], persistedProjects))

  await assert.rejects(kernel.start(), /Select a project directory/)

  await kernel.addProject('/tmp/project', sessionRegistry(null))
  await kernel.start()

  assert.deepEqual(persistedProjects, [{ path: '/tmp/project' }])
  assert.deepEqual(receivedProject, { path: '/tmp/project' })
  assert.deepEqual(
    kernel.getState().projects.map(({ path, busySessionCount }) => ({ path, busySessionCount })),
    [{ path: '/tmp/project', busySessionCount: 0 }]
  )
  assert.equal(kernel.getState().activeProjectKey, '/tmp/project')
})

test('activating another project preserves the ready runtime while changing the active projection', async () => {
  const runtime = new FakeRuntimeHost()
  const activeProjects: string[] = []
  const recentSession: SessionPointer = {
    projectPath: '/tmp/next-project',
    sessionFile: '/tmp/next-session.jsonl',
    sessionId: 'next-session',
    sessionName: 'Next session'
  }
  const kernel = new WorkbenchKernel(
    () => runtime,
    {
      projects: [{ path: '/tmp/project' }, { path: '/tmp/next-project' }],
      activeProjectKey: '/tmp/project'
    },
    kernelOptions(null, [], activeProjects)
  )

  await kernel.start()
  await kernel.activateProject('/tmp/next-project', sessionRegistry(recentSession))

  assert.equal(runtime.stopCalls, 0)
  assert.deepEqual(activeProjects, ['/tmp/next-project'])
  assert.equal(kernel.getState().activeProjectKey, '/tmp/next-project')
  assert.equal(kernel.getState().runtime.status, 'stopped')
  assert.deepEqual(kernel.getState().availableModels, [])
  assert.equal(kernel.getState().session.id, 'next-session')
  assert.equal(kernel.getState().session.resumeAvailable, true)
  assert.deepEqual(kernel.getState().conversation.entries, [])
})

test('activating another project preserves a running background turn', async () => {
  const runtime = new FakeRuntimeHost()
  const activeProjects: string[] = []
  const kernel = new WorkbenchKernel(
    () => runtime,
    {
      projects: [{ path: '/tmp/project' }, { path: '/tmp/next-project' }],
      activeProjectKey: '/tmp/project'
    },
    kernelOptions(null, [], activeProjects)
  )

  await kernel.start()
  runtime.emit({ type: 'activity-started' })

  await kernel.activateProject('/tmp/next-project', sessionRegistry(null))
  assert.equal(runtime.stopCalls, 0)
  assert.deepEqual(activeProjects, ['/tmp/next-project'])
  assert.equal(kernel.getState().activeProjectKey, '/tmp/next-project')
})

test('project activation keeps session registries isolated while the old runtime emits', async () => {
  const oldPointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/session-1.jsonl',
    sessionId: 'session-1',
    sessionName: 'Old session'
  }
  const nextPointer: SessionPointer = {
    projectPath: '/tmp/next-project',
    sessionFile: '/tmp/next-session.jsonl',
    sessionId: 'next-session',
    sessionName: 'Next session'
  }
  let activityLoadEntered!: () => void
  let releaseActivityLoad!: () => void
  const activityLoadStarted = new Promise<void>((resolve) => {
    activityLoadEntered = resolve
  })
  const activityLoadGate = new Promise<void>((resolve) => {
    releaseActivityLoad = resolve
  })
  const runtime = new FakeRuntimeHost()
  const kernel = new WorkbenchKernel(
    () => runtime,
    {
      projects: [{ path: '/tmp/project' }, { path: '/tmp/next-project' }],
      activeProjectKey: '/tmp/project'
    },
    {
      ...kernelOptions(oldPointer),
      readSessionActivityAt: async (pointer) => {
        if (pointer.projectPath === '/tmp/next-project') {
          activityLoadEntered()
          await activityLoadGate
        }
        return null
      }
    }
  )

  await kernel.start()
  const activation = kernel.activateProject(
    '/tmp/next-project',
    sessionRegistry(nextPointer)
  )
  await activityLoadStarted
  runtime.emit({
    type: 'pi-event',
    event: { type: 'session_info_changed', name: 'Renamed old session' }
  })
  releaseActivityLoad()
  await activation

  const state = kernel.getState()
  assert.deepEqual(
    state.projects.find(({ path }) => path === '/tmp/project')?.sessions?.map(({ key }) => key),
    [oldPointer.sessionFile]
  )
  assert.deepEqual(
    state.projects.find(({ path }) => path === '/tmp/next-project')?.sessions?.map(({ key }) => key),
    [nextPointer.sessionFile]
  )
  assert.equal(state.activeProjectKey, '/tmp/next-project')
  assert.equal(state.activeSessionKey, nextPointer.sessionFile)
})

test('active-project persistence failure leaves the stopped old project selected', async () => {
  const runtime = new FakeRuntimeHost()
  const kernel = new WorkbenchKernel(
    () => runtime,
    {
      projects: [{ path: '/tmp/project' }, { path: '/tmp/next-project' }],
      activeProjectKey: '/tmp/project'
    },
    {
      ...kernelOptions(),
      persistActiveProject: async () => {
        throw new Error('active project persistence failed')
      }
    }
  )

  await kernel.start()
  await assert.rejects(
    kernel.activateProject('/tmp/next-project', sessionRegistry(null)),
    /active project persistence failed/
  )

  assert.equal(runtime.stopCalls, 0)
  assert.equal(kernel.getState().runtime.status, 'ready')
  assert.equal(kernel.getState().activeProjectKey, '/tmp/project')
})

test('project activation blocks runtime launch until persistence and loading finish', async () => {
  let persistenceEntered!: () => void
  let releasePersistence!: () => void
  const entered = new Promise<void>((resolve) => {
    persistenceEntered = resolve
  })
  const persistenceGate = new Promise<void>((resolve) => {
    releasePersistence = resolve
  })
  let createCalls = 0
  const kernel = new WorkbenchKernel(
    () => {
      createCalls += 1
      return new FakeRuntimeHost()
    },
    {
      projects: [{ path: '/tmp/project' }, { path: '/tmp/next-project' }],
      activeProjectKey: '/tmp/project'
    },
    {
      ...kernelOptions(),
      persistActiveProject: async () => {
        persistenceEntered()
        await persistenceGate
      }
    }
  )

  const activation = kernel.activateProject('/tmp/next-project', sessionRegistry(null))
  await entered
  await assert.rejects(kernel.start(), /project change is in progress/)
  assert.equal(createCalls, 0)
  assert.equal(kernel.getState().activeProjectKey, '/tmp/project')

  releasePersistence()
  await activation
  assert.equal(kernel.getState().activeProjectKey, '/tmp/next-project')
  assert.equal(createCalls, 0)
})

test('concurrent adds of the same project allow only one registry mutation', async () => {
  let persistenceEntered!: () => void
  let releasePersistence!: () => void
  const entered = new Promise<void>((resolve) => {
    persistenceEntered = resolve
  })
  const persistenceGate = new Promise<void>((resolve) => {
    releasePersistence = resolve
  })
  let persistProjectCalls = 0
  const kernel = new WorkbenchKernel(
    () => new FakeRuntimeHost(),
    { projects: [], activeProjectKey: null },
    {
      ...kernelOptions(),
      persistProject: async () => {
        persistProjectCalls += 1
        persistenceEntered()
        await persistenceGate
      }
    }
  )

  const firstAdd = kernel.addProject('/tmp/project', sessionRegistry(null))
  await entered
  await assert.rejects(
    kernel.addProject('/tmp/project', sessionRegistry(null)),
    /project change is already in progress/
  )
  releasePersistence()
  await firstAdd

  assert.equal(persistProjectCalls, 1)
  assert.deepEqual(
    kernel.getState().projects.map(({ path, busySessionCount }) => ({ path, busySessionCount })),
    [{ path: '/tmp/project', busySessionCount: 0 }]
  )
  assert.equal(kernel.getState().activeProjectKey, '/tmp/project')
})

test('projects streaming messages and tools without duplication and settles only on agent_settled', async () => {
  const runtime = new FakeRuntimeHost()
  const kernel = new WorkbenchKernel(() => runtime, { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' }, kernelOptions())

  await kernel.start()
  await kernel.prompt('Inspect package.json')
  assert.equal(kernel.getState().runtime.status, 'running')
  assert.equal(kernel.getState().conversation.activeRunStartIndex, 0)

  runtime.emit({
    type: 'pi-event',
    event: {
      type: 'message_start',
      message: { role: 'user', content: 'Inspect package.json', timestamp: 10 }
    }
  })
  runtime.emit({
    type: 'pi-event',
    event: {
      type: 'message_update',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Inspect the project file.' },
          { type: 'toolCall', id: 'tool-1', name: 'read', arguments: { path: 'package.json' } }
        ],
        timestamp: 20
      }
    }
  })
  runtime.emit({
    type: 'pi-event',
    event: {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Inspect the project file.' },
          { type: 'toolCall', id: 'tool-1', name: 'read', arguments: { path: 'package.json' } }
        ],
        timestamp: 20
      }
    }
  })
  runtime.emit({
    type: 'pi-event',
    event: {
      type: 'tool_execution_start',
      toolCallId: 'tool-1',
      toolName: 'read',
      args: { path: 'package.json' }
    }
  })
  runtime.emit({
    type: 'pi-event',
    event: {
      type: 'tool_execution_update',
      toolCallId: 'tool-1',
      toolName: 'read',
      args: { path: 'package.json' },
      partialResult: { content: [{ type: 'text', text: '{"name"' }] }
    }
  })
  runtime.emit({
    type: 'pi-event',
    event: {
      type: 'tool_execution_end',
      toolCallId: 'tool-1',
      toolName: 'read',
      result: { content: [{ type: 'text', text: '{"name":"pi-gui"}' }] },
      isError: false
    }
  })
  runtime.emit({
    type: 'pi-event',
    event: {
      type: 'message_update',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Summarize the result.' },
          { type: 'text', text: 'Hel' }
        ],
        timestamp: 30
      }
    }
  })
  runtime.emit({
    type: 'pi-event',
    event: {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Summarize the result.' },
          { type: 'text', text: 'Hello' }
        ],
        timestamp: 30
      }
    }
  })

  await kernel.abort()
  runtime.emit({ type: 'pi-event', event: { type: 'agent_end', messages: [], willRetry: false } })
  assert.equal(kernel.getState().runtime.status, 'running')
  runtime.emit({ type: 'pi-event', event: { type: 'agent_settled' } })

  const state = kernel.getState()
  const assistantMessages = state.conversation.entries.filter(
    (entry) => entry.kind === 'message' && entry.role === 'assistant'
  )
  const thinkingEntries = state.conversation.entries.filter((entry) => entry.kind === 'thinking')
  const tools = state.conversation.entries.filter((entry) => entry.kind === 'tool')
  assert.deepEqual(
    state.conversation.entries.map((entry) => entry.kind),
    ['message', 'thinking', 'tool', 'thinking', 'message']
  )
  assert.equal(assistantMessages.length, 1)
  assert.equal(assistantMessages[0]?.kind === 'message' ? assistantMessages[0].text : null, 'Hello')
  assert.deepEqual(
    thinkingEntries.map((entry) => entry.kind === 'thinking' ? entry.text : null),
    ['Inspect the project file.', 'Summarize the result.']
  )
  assert.equal(tools.length, 1)
  assert.equal(tools[0]?.kind === 'tool' ? tools[0].status : null, 'success')
  assert.equal(tools[0]?.kind === 'tool' ? tools[0].output : null, '{"name":"pi-gui"}')
  assert.equal(state.runtime.status, 'ready')
  assert.equal(state.session.settled, true)
  assert.equal(state.conversation.activeRunStartIndex, null)
  assert.deepEqual(runtime.commands.slice(-2), [
    { type: 'prompt', message: 'Inspect package.json' },
    { type: 'abort' }
  ])
})

test('materializes file references without content and forwards native images to the runtime', async () => {
  const runtime = new FakeRuntimeHost()
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions()
  )
  const image = { type: 'image' as const, mimeType: 'image/png', data: 'aGVsbG8=' }
  const file = {
    type: 'file' as const,
    name: 'project notes.txt',
    path: '/tmp/project notes.txt'
  }

  await kernel.start()
  await kernel.prompt('', [
    file,
    {
      type: 'image',
      name: 'diagram.png',
      path: '/tmp/diagram.png',
      image,
      hints: []
    }
  ])

  assert.deepEqual(runtime.commands.at(-1), {
    type: 'prompt',
    message: '@"/tmp/project notes.txt"\n<file name="/tmp/diagram.png"></file>\n',
    images: [image]
  })
})

test('settling after abort marks a tool without an end event as error', async () => {
  const runtime = new FakeRuntimeHost()
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions()
  )

  await kernel.start()
  await kernel.prompt('Run a long tool')
  runtime.emit({
    type: 'pi-event',
    event: {
      type: 'tool_execution_start',
      toolCallId: 'tool-abort',
      toolName: 'bash',
      args: { command: 'sleep 60' }
    }
  })

  await kernel.abort()
  runtime.emit({ type: 'pi-event', event: { type: 'agent_settled' } })

  const state = kernel.getState()
  const tool = state.conversation.entries.find((entry) => entry.kind === 'tool')
  assert.equal(tool?.kind === 'tool' ? tool.status : null, 'error')
  assert.equal(state.runtime.status, 'ready')
  assert.equal(state.session.settled, true)
  assert.equal(state.conversation.activeRunStartIndex, null)
})

test('Pi streaming emits indexed patches and only includes changed state boundaries', async () => {
  const runtime = new FakeRuntimeHost()
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions()
  )
  await kernel.start()
  const events: KernelEvent[] = []
  kernel.subscribe((event) => events.push(event))

  runtime.emit({
    type: 'pi-event',
    event: {
      type: 'message_update',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hel' }],
        timestamp: 20
      }
    }
  })
  runtime.emit({
    type: 'pi-event',
    event: {
      type: 'message_update',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
        timestamp: 20
      }
    }
  })

  assert.equal(events.length, 2)
  for (const event of events) {
    assert.equal(event.type, 'kernel.state-patched')
    if (event.type !== 'kernel.state-patched') continue
    assert.equal(event.patch.projectKey, '/tmp/project')
    assert.equal(event.patch.sessionKey, '/tmp/session-1.jsonl')
    assert.equal(event.patch.runtime, undefined)
    assert.equal(event.patch.session, undefined)
    assert.equal(event.patch.conversation?.entries?.length, 1)
    assert.equal(event.patch.conversation?.entries?.[0]?.index, 0)
  }
  const firstEntryPatch = events[0]?.type === 'kernel.state-patched'
    ? events[0].patch.conversation?.entries?.[0]
    : undefined
  assert.equal(firstEntryPatch?.type, 'insert')
  assert.equal(
    firstEntryPatch?.type === 'insert' && firstEntryPatch.entry.kind === 'message'
      ? firstEntryPatch.entry.text
      : null,
    'Hel'
  )
  const lastEvent = events[1]
  const lastEntryPatch = lastEvent?.type === 'kernel.state-patched'
    ? lastEvent.patch.conversation?.entries?.[0]
    : undefined
  assert.equal(lastEntryPatch?.type, 'append-message-text')
  if (lastEntryPatch?.type === 'append-message-text') {
    assert.equal(lastEntryPatch.from, 3)
    assert.equal(lastEntryPatch.text, 'lo')
    assert.equal(lastEntryPatch.streaming, true)
  }
})

test('Pi patches append tool output and falls back for a non-prefix message rewrite', async () => {
  const runtime = new FakeRuntimeHost()
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions()
  )
  await kernel.start()
  const events: KernelEvent[] = []
  kernel.subscribe((event) => events.push(event))

  runtime.emit({
    type: 'pi-event',
    event: { type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'bash', args: { command: 'test' } }
  })
  runtime.emit({
    type: 'pi-event',
    event: {
      type: 'tool_execution_update',
      toolCallId: 'tool-1',
      toolName: 'bash',
      args: { command: 'test' },
      partialResult: { content: [{ type: 'text', text: 'abcdef' }] }
    }
  })

  const toolPatch = events[1]?.type === 'kernel.state-patched'
    ? events[1].patch.conversation?.entries?.[0]
    : undefined
  assert.equal(toolPatch?.type, 'append-tool-output')
  if (toolPatch?.type === 'append-tool-output') {
    assert.equal(toolPatch.toolCallId, 'tool-1')
    assert.equal(toolPatch.from, 0)
    assert.equal(toolPatch.output, 'abcdef')
  }

  runtime.emit({
    type: 'pi-event',
    event: {
      type: 'message_update',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Original' }], timestamp: 30 }
    }
  })
  runtime.emit({
    type: 'pi-event',
    event: {
      type: 'message_update',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Rewritten' }], timestamp: 30 }
    }
  })

  const rewrittenEvent = events.at(-1)
  assert.equal(rewrittenEvent?.type, 'kernel.state-changed')
  if (rewrittenEvent?.type === 'kernel.state-changed') {
    const rewrittenEntry = rewrittenEvent.state.conversation.entries.at(-1)
    assert.equal(rewrittenEntry?.kind === 'message' ? rewrittenEntry.text : null, 'Rewritten')
  }
})

test('Subagent metadata-only tool changes use full state while output growth stays atomic', async () => {
  const runtime = new FakeRuntimeHost()
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions()
  )
  await kernel.start()
  const events: KernelEvent[] = []
  kernel.subscribe((event) => events.push(event))
  const args = { agent: 'reviewer', task: 'Review renderer' }

  runtime.emit({
    type: 'pi-event',
    event: {
      type: 'tool_execution_start',
      toolCallId: 'subagent-1',
      toolName: 'subagent',
      args
    }
  })
  runtime.emit({
    type: 'pi-event',
    event: {
      type: 'tool_execution_update',
      toolCallId: 'subagent-1',
      toolName: 'subagent',
      args,
      partialResult: {
        content: [{ type: 'text', text: 'working' }],
        details: {
          mode: 'single',
          runId: 'run-1',
          progress: [{
            index: 0,
            agent: 'reviewer',
            task: 'Review renderer',
            status: 'running',
            currentTool: 'read',
            toolCount: 1,
            turnCount: 1,
            tokens: 100,
            durationMs: 500
          }]
        }
      }
    }
  })

  const growthEvent = events.at(-1)
  assert.equal(growthEvent?.type, 'kernel.state-patched')
  const growthPatch = growthEvent?.type === 'kernel.state-patched'
    ? growthEvent.patch.conversation?.entries?.[0]
    : undefined
  assert.equal(growthPatch?.type, 'append-tool-output')
  if (growthPatch?.type === 'append-tool-output') {
    assert.equal(growthPatch.toolCallId, 'subagent-1')
    assert.equal(growthPatch.output, 'working')
    assert.equal(growthPatch.status, 'running')
    assert.equal(growthPatch.subagent?.participants[0]?.currentTool, 'read')
    assert.equal(growthPatch.subagent?.participants[0]?.tokens, 100)
    const participant = growthPatch.subagent?.participants[0]
    assert.ok(participant)
    participant.currentTool = 'mutated externally'
    const storedTool = kernel.getState().conversation.entries[0]
    assert.equal(
      storedTool?.kind === 'tool' ? storedTool.subagent?.participants[0]?.currentTool : null,
      'read'
    )
  }

  runtime.emit({
    type: 'pi-event',
    event: {
      type: 'tool_execution_update',
      toolCallId: 'subagent-1',
      toolName: 'subagent',
      args,
      partialResult: {
        content: [{ type: 'text', text: 'working' }],
        details: {
          mode: 'single',
          runId: 'run-1',
          progress: [{
            index: 0,
            agent: 'reviewer',
            task: 'Review renderer',
            status: 'running',
            currentTool: 'grep',
            toolCount: 2,
            turnCount: 2,
            tokens: 250,
            durationMs: 900
          }]
        }
      }
    }
  })

  const metadataEvent = events.at(-1)
  assert.equal(metadataEvent?.type, 'kernel.state-changed')
  if (metadataEvent?.type === 'kernel.state-changed') {
    const tool = metadataEvent.state.conversation.entries[0]
    assert.equal(tool?.kind === 'tool' ? tool.output : null, 'working')
    assert.equal(tool?.kind === 'tool' ? tool.subagent?.participants[0]?.currentTool : null, 'grep')
    assert.equal(tool?.kind === 'tool' ? tool.subagent?.participants[0]?.tokens : null, 250)
  }

  runtime.emit({
    type: 'pi-event',
    event: {
      type: 'tool_execution_end',
      toolCallId: 'subagent-1',
      toolName: 'subagent',
      result: {
        content: [{ type: 'text', text: 'working' }],
        details: {
          mode: 'single',
          runId: 'run-1',
          progress: [{
            index: 0,
            agent: 'reviewer',
            task: 'Review renderer',
            status: 'completed',
            toolCount: 2,
            turnCount: 2,
            tokens: 250,
            durationMs: 1200
          }],
          results: [{
            index: 0,
            agent: 'reviewer',
            status: 'completed',
            finalOutput: 'Review complete.'
          }]
        }
      },
      isError: false
    }
  })

  const terminalEvent = events.at(-1)
  assert.equal(terminalEvent?.type, 'kernel.state-changed')
  if (terminalEvent?.type === 'kernel.state-changed') {
    const tool = terminalEvent.state.conversation.entries[0]
    assert.equal(tool?.kind === 'tool' ? tool.status : null, 'success')
    assert.equal(tool?.kind === 'tool' ? tool.output : null, 'working')
    assert.equal(tool?.kind === 'tool' ? tool.subagent?.participants[0]?.status : null, 'completed')
    assert.equal(
      tool?.kind === 'tool' ? tool.subagent?.participants[0]?.finalOutput : null,
      'Review complete.'
    )
  }
})

test('a successful supervisor reply publishes the handled request through full state', async () => {
  const runtime = new FakeRuntimeHost()
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions()
  )
  await kernel.start()
  runtime.emit({
    type: 'pi-event',
    event: {
      type: 'message_end',
      message: {
        role: 'custom',
        customType: 'subagent_supervisor_request',
        content: '请提供当前 Git 状态。',
        display: true,
        details: {
          id: 'request-1',
          reason: 'need_decision',
          expectsReply: true,
          runId: 'run-1',
          agent: 'explorer',
          childIndex: 0
        },
        timestamp: 40
      }
    }
  })
  runtime.emit({
    type: 'pi-event',
    event: {
      type: 'tool_execution_start',
      toolCallId: 'supervisor-reply-1',
      toolName: 'subagent_supervisor',
      args: {
        action: 'reply',
        replyTo: 'request-1',
        message: '状态已提供。'
      }
    }
  })
  const events: KernelEvent[] = []
  kernel.subscribe((event) => events.push(event))

  runtime.emit({
    type: 'pi-event',
    event: {
      type: 'tool_execution_end',
      toolCallId: 'supervisor-reply-1',
      toolName: 'subagent_supervisor',
      result: { content: [{ type: 'text', text: 'Replied.' }] },
      isError: false
    }
  })

  const event = events.at(-1)
  assert.equal(event?.type, 'kernel.state-changed')
  if (event?.type === 'kernel.state-changed') {
    const notice = event.state.conversation.entries.find((entry) =>
      entry.kind === 'subagent-notice' && entry.noticeType === 'request'
    )
    assert.equal(notice?.kind === 'subagent-notice' ? notice.coordination?.status : null, 'handled')
    assert.ok(notice?.kind === 'subagent-notice' && notice.coordination !== undefined)
    notice.coordination.status = 'pending'
    const storedNotice = kernel.getState().conversation.entries.find((entry) =>
      entry.kind === 'subagent-notice' && entry.noticeType === 'request'
    )
    assert.equal(
      storedNotice?.kind === 'subagent-notice' ? storedNotice.coordination?.status : null,
      'handled'
    )
  }
})

test('message and thinking metadata-only settlement uses the full-state fallback', async () => {
  const runtime = new FakeRuntimeHost()
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions()
  )
  await kernel.start()
  const events: KernelEvent[] = []
  kernel.subscribe((event) => events.push(event))
  const message = {
    role: 'assistant' as const,
    content: [
      { type: 'thinking' as const, thinking: 'Stable reasoning.' },
      { type: 'text' as const, text: 'Stable answer.' }
    ],
    timestamp: 31
  }

  runtime.emit({
    type: 'pi-event',
    event: { type: 'message_update', message }
  })
  events.length = 0
  runtime.emit({
    type: 'pi-event',
    event: { type: 'message_end', message }
  })

  const settledEvent = events.at(-1)
  assert.equal(settledEvent?.type, 'kernel.state-changed')
  if (settledEvent?.type === 'kernel.state-changed') {
    const projectedMessage = settledEvent.state.conversation.entries.find(
      (entry) => entry.kind === 'message' && entry.role === 'assistant'
    )
    const projectedThinking = settledEvent.state.conversation.entries.find(
      (entry) => entry.kind === 'thinking'
    )
    assert.equal(projectedMessage?.kind === 'message' ? projectedMessage.streaming : null, false)
    assert.equal(projectedThinking?.kind === 'thinking' ? projectedThinking.streaming : null, false)
  }
})

test('message attachment changes use the full-state fallback', async () => {
  const runtime = new FakeRuntimeHost()
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions()
  )
  await kernel.start()
  const events: KernelEvent[] = []
  kernel.subscribe((event) => events.push(event))

  runtime.emit({
    type: 'pi-event',
    event: {
      type: 'message_update',
      message: { role: 'user', content: [{ type: 'text', text: 'Hello' }], timestamp: 31 }
    }
  })
  runtime.emit({
    type: 'pi-event',
    event: {
      type: 'message_update',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }
        ],
        timestamp: 31
      }
    }
  })

  assert.equal(events.at(-1)?.type, 'kernel.state-changed')
})

test('Pi lifecycle publishes complete activity summaries without changing state semantics', async () => {
  const pointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/session.jsonl',
    sessionId: 'session-1',
    sessionName: 'Session'
  }
  const runtime = new FakeRuntimeHost({
    sessionId: pointer.sessionId,
    sessionFile: pointer.sessionFile,
    sessionName: pointer.sessionName ?? undefined
  })
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions(pointer)
  )
  await kernel.activateSession(pointer.sessionFile)
  const events: KernelEvent[] = []
  kernel.subscribe((event) => events.push(event))

  runtime.emit({ type: 'pi-event', event: { type: 'agent_start' } })
  runtime.emit({ type: 'pi-event', event: { type: 'agent_settled' } })

  assert.equal(events.length, 2)
  const started = events[0]
  assert.equal(started?.type, 'kernel.state-changed')
  if (started?.type === 'kernel.state-changed') {
    assert.equal(started.state.runtime.status, 'running')
    assert.equal(started.state.session.settled, false)
    assert.equal(started.state.conversation.activeRunStartIndex, 0)
    assert.equal(started.state.sessions[0]?.runtimeStatus, 'running')
    assert.equal(started.state.projects[0]?.busySessionCount, 1)
  }
  const settled = events[1]
  assert.equal(settled?.type, 'kernel.state-changed')
  if (settled?.type === 'kernel.state-changed') {
    assert.equal(settled.state.runtime.status, 'ready')
    assert.equal(settled.state.session.settled, true)
    assert.equal(settled.state.session.pendingMessageCount, 0)
    assert.equal(settled.state.conversation.activeRunStartIndex, null)
    assert.equal(settled.state.sessions[0]?.runtimeStatus, 'ready')
    assert.equal(settled.state.projects[0]?.busySessionCount, 0)
    assert.equal(typeof settled.state.sessions[0]?.lastActivityAt, 'number')
  }
  assert.equal(kernel.getState().runtime.status, 'ready')
  assert.equal(kernel.getState().session.settled, true)
  assert.equal(kernel.getState().conversation.activeRunStartIndex, null)
})

test('queue updates project steering and follow-up messages until the agent settles', async () => {
  const runtime = new FakeRuntimeHost()
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions()
  )
  await kernel.start()
  runtime.emit({ type: 'pi-event', event: { type: 'agent_start' } })

  runtime.emit({
    type: 'pi-event',
    event: {
      type: 'queue_update',
      steering: [
        '@"/tmp/context file.txt"\nRefine the current answer',
        'Check the edge case'
      ],
      followUp: ['<file name="/tmp/chart.png"></file>\nSummarize the result']
    }
  })

  let session = kernel.getState().session
  assert.deepEqual(session.pendingSteeringMessages, [
    'Refine the current answer\n@"context file.txt"',
    'Check the edge case'
  ])
  assert.deepEqual(session.pendingFollowUpMessages, ['Summarize the result\n@chart.png'])
  assert.equal(session.pendingMessageCount, 3)

  runtime.emit({ type: 'pi-event', event: { type: 'agent_settled' } })

  session = kernel.getState().session
  assert.deepEqual(session.pendingSteeringMessages, [])
  assert.deepEqual(session.pendingFollowUpMessages, [])
  assert.equal(session.pendingMessageCount, 0)
})

test('low-frequency activity lifecycle keeps the full-state fallback', async () => {
  const runtime = new FakeRuntimeHost()
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions()
  )
  await kernel.start()
  const events: KernelEvent[] = []
  kernel.subscribe((event) => events.push(event))

  runtime.emit({ type: 'activity-started' })
  runtime.emit({ type: 'activity-settled' })

  assert.deepEqual(events.map((event) => event.type), [
    'kernel.state-changed',
    'kernel.state-changed'
  ])
  assert.equal(kernel.getState().runtime.status, 'ready')
  assert.equal(kernel.getState().session.settled, true)
})

test('session summaries refresh activity and lifetime statistics without starting a runtime', async () => {
  const pointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/session.jsonl',
    sessionId: 'session-1',
    sessionName: 'Session'
  }
  let runtimeCreations = 0
  const kernel = new WorkbenchKernel(
    () => {
      runtimeCreations += 1
      return new FakeRuntimeHost()
    },
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(pointer),
      readSessionActivityAt: async () => 1_784_630_000_000,
      readSessionStatistics: async () => ({
        userMessages: 3,
        assistantMessages: 4,
        toolCalls: 2,
        toolResults: 2,
        totalMessages: 11,
        inputTokens: 1_000,
        outputTokens: 200,
        cacheReadTokens: 300,
        cacheWriteTokens: 50,
        totalTokens: 1_550,
        cost: 0.025
      })
    }
  )

  await kernel.refreshSessionActivities()

  assert.equal(kernel.getState().sessions[0]?.lastActivityAt, 1_784_630_000_000)
  assert.deepEqual(kernel.getState().sessions[0]?.statistics, {
    userMessages: 3,
    assistantMessages: 4,
    toolCalls: 2,
    toolResults: 2,
    totalMessages: 11,
    inputTokens: 1_000,
    outputTokens: 200,
    cacheReadTokens: 300,
    cacheWriteTokens: 50,
    totalTokens: 1_550,
    cost: 0.025
  })
  assert.equal(runtimeCreations, 0)
})

test('session activity refresh orders every registered project without starting runtimes', async () => {
  const activePointer: SessionPointer = {
    projectPath: '/tmp/project-a',
    sessionFile: '/tmp/project-a-session.jsonl',
    sessionId: 'project-a-session',
    sessionName: 'Project A'
  }
  const olderPointer: SessionPointer = {
    projectPath: '/tmp/project-b',
    sessionFile: '/tmp/project-b-older.jsonl',
    sessionId: 'project-b-older',
    sessionName: 'Older'
  }
  const newerPointer: SessionPointer = {
    projectPath: '/tmp/project-b',
    sessionFile: '/tmp/project-b-newer.jsonl',
    sessionId: 'project-b-newer',
    sessionName: 'Newer'
  }
  const activeRegistry = sessionRegistry(activePointer)
  const inactiveRegistry: ProjectSessionRegistry = {
    sessions: [olderPointer, newerPointer],
    activeSessionKey: newerPointer.sessionFile
  }
  const activityBySession = new Map<string, number>([
    [activePointer.sessionFile, 2_000],
    [olderPointer.sessionFile, 1_000],
    [newerPointer.sessionFile, 3_000]
  ])
  let runtimeCreations = 0
  const kernel = new WorkbenchKernel(
    () => {
      runtimeCreations += 1
      return new FakeRuntimeHost()
    },
    {
      projects: [{ path: activePointer.projectPath }, { path: olderPointer.projectPath }],
      activeProjectKey: activePointer.projectPath
    },
    {
      ...kernelOptions(),
      sessionRegistry: activeRegistry,
      sessionRegistriesByProject: new Map([
        [activePointer.projectPath, activeRegistry],
        [olderPointer.projectPath, inactiveRegistry]
      ]),
      readSessionActivityAt: async (pointer) => activityBySession.get(pointer.sessionFile) ?? null
    }
  )

  await kernel.refreshSessionActivities()

  const state = kernel.getState()
  assert.deepEqual(
    state.projects
      .find(({ path }) => path === olderPointer.projectPath)
      ?.sessions
      ?.map(({ key, lastActivityAt }) => ({ key, lastActivityAt })),
    [
      { key: newerPointer.sessionFile, lastActivityAt: 3_000 },
      { key: olderPointer.sessionFile, lastActivityAt: 1_000 }
    ]
  )
  assert.equal(runtimeCreations, 0)
})

test('session summaries prioritize running and otherwise remain activity sorted', async () => {
  const oldestPointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/oldest-session.jsonl',
    sessionId: 'oldest-session',
    sessionName: 'Oldest'
  }
  const unknownPointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/unknown-session.jsonl',
    sessionId: 'unknown-session',
    sessionName: 'Unknown'
  }
  const newestPointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/newest-session.jsonl',
    sessionId: 'newest-session',
    sessionName: 'Newest'
  }
  const activityBySession = new Map<string, number | null>([
    [oldestPointer.sessionFile, 1_000],
    [unknownPointer.sessionFile, null],
    [newestPointer.sessionFile, 3_000]
  ])
  const oldestRuntime = new FakeRuntimeHost({
    sessionId: oldestPointer.sessionId,
    sessionFile: oldestPointer.sessionFile,
    sessionName: oldestPointer.sessionName ?? undefined,
    thinkingLevel: 'medium',
    isStreaming: false,
    messageCount: 0,
    pendingMessageCount: 0
  })
  const kernel = new WorkbenchKernel(
    () => oldestRuntime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(),
      sessionRegistry: {
        sessions: [oldestPointer, unknownPointer, newestPointer],
        activeSessionKey: oldestPointer.sessionFile
      },
      readSessionActivityAt: async (pointer) => activityBySession.get(pointer.sessionFile) ?? null
    }
  )

  await kernel.refreshSessionActivities()

  assert.deepEqual(kernel.getState().sessions.map(({ key }) => key), [
    newestPointer.sessionFile,
    oldestPointer.sessionFile,
    unknownPointer.sessionFile
  ])

  await kernel.activateSession(oldestPointer.sessionFile)
  oldestRuntime.emit({ type: 'activity-started' })
  await kernel.refreshSessionActivities()
  assert.deepEqual(kernel.getState().sessions.map(({ key }) => key), [
    oldestPointer.sessionFile,
    newestPointer.sessionFile,
    unknownPointer.sessionFile
  ])

  activityBySession.set(newestPointer.sessionFile, 9_000)
  const restarted = new WorkbenchKernel(
    () => new FakeRuntimeHost(),
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(),
      sessionRegistry: {
        sessions: [unknownPointer, oldestPointer, newestPointer],
        activeSessionKey: oldestPointer.sessionFile
      },
      readSessionActivityAt: async (pointer) => activityBySession.get(pointer.sessionFile) ?? null
    }
  )
  await restarted.refreshSessionActivities()
  assert.deepEqual(restarted.getState().sessions.map(({ key }) => key), [
    newestPointer.sessionFile,
    oldestPointer.sessionFile,
    unknownPointer.sessionFile
  ])
})

test('new session persists its recent-session pointer', async () => {
  const runtime = new FakeRuntimeHost({
    sessionId: 'new-session',
    sessionFile: '/tmp/new-session.jsonl',
    sessionName: 'New session'
  })
  const persisted: SessionPointer[] = []
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(null, persisted),
      validateSession: async (pointer) => ({
        ...pointer,
        sessionFile: '/tmp/canonical-new-session.jsonl'
      })
    }
  )

  await kernel.start()

  assert.deepEqual(persisted, [{
    projectPath: '/tmp/project',
    sessionFile: '/tmp/canonical-new-session.jsonl',
    sessionId: 'new-session',
    sessionName: 'New session'
  }])
  assert.equal(kernel.getState().session.resumeAvailable, true)
})

test('a new session whose JSONL is not written yet starts as an unregistered provisional session', async () => {
  const existingPointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/existing-session.jsonl',
    sessionId: 'existing-session',
    sessionName: 'Existing session'
  }
  const runtime = new FakeRuntimeHost({
    sessionId: 'provisional-session',
    sessionFile: '/tmp/provisional-session.jsonl',
    sessionName: 'Provisional session'
  })
  const persisted: SessionPointer[] = []
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(existingPointer, persisted),
      validateSession: async () => {
        throw fileError('ENOENT', 'session file not written yet')
      }
    }
  )

  const activityWindowStart = Date.now()
  await kernel.start()
  const activityWindowEnd = Date.now()

  const state = kernel.getState()
  assert.equal(state.runtime.status, 'ready')
  assert.equal(state.session.id, 'provisional-session')
  assert.equal(state.session.resumeAvailable, false)
  assert.equal(state.activeSessionKey, '/tmp/provisional-session.jsonl')
  assert.equal(state.sessions.length, 2)
  assert.deepEqual(
    state.sessions.map(({ lastActivityAt: _lastActivityAt, ...summary }) => summary),
    [
      {
        key: '/tmp/provisional-session.jsonl',
        id: 'provisional-session',
        name: 'Provisional session',
        runtimeStatus: 'ready',
        provisional: true,
        statistics: null
      },
      {
        key: existingPointer.sessionFile,
        id: existingPointer.sessionId,
        name: existingPointer.sessionName,
        runtimeStatus: 'stopped',
        statistics: null
      }
    ]
  )
  const provisionalActivityAt = state.sessions[0]?.lastActivityAt
  assert.equal(typeof provisionalActivityAt, 'number')
  assert.ok(provisionalActivityAt !== null && provisionalActivityAt !== undefined)
  assert.ok(provisionalActivityAt >= activityWindowStart)
  assert.ok(provisionalActivityAt <= activityWindowEnd)
  assert.deepEqual(persisted, [])

  await kernel.prompt('Write the first turn')
  assert.deepEqual(runtime.commands.at(-1), { type: 'prompt', message: 'Write the first turn' })
})

test('repeated starts reuse the active empty provisional session until it receives a prompt', async () => {
  const runtimes = [
    new FakeRuntimeHost({
      sessionId: 'empty-provisional',
      sessionFile: '/tmp/empty-provisional.jsonl',
      isStreaming: false
    }),
    new FakeRuntimeHost({
      sessionId: 'next-provisional',
      sessionFile: '/tmp/next-provisional.jsonl',
      isStreaming: false
    })
  ]
  let createCalls = 0
  const kernel = new WorkbenchKernel(
    () => runtimes[createCalls++]!,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(),
      validateSession: async () => {
        throw fileError('ENOENT', 'session file not written yet')
      }
    }
  )

  await kernel.start()
  await kernel.start()

  assert.equal(createCalls, 1)
  assert.equal(runtimes[0].startCalls, 1)
  assert.deepEqual(kernel.getState().sessions.map(({ id }) => id), ['empty-provisional'])

  await kernel.prompt('Begin the first conversation')
  await kernel.start()

  assert.equal(createCalls, 2)
  assert.equal(runtimes[1].startCalls, 1)
  assert.deepEqual(
    new Set(kernel.getState().sessions.map(({ id }) => id)),
    new Set(['empty-provisional', 'next-provisional'])
  )
})

test('the settled first turn uses a low-cost model to generate and persist a purpose-based session name', async () => {
  const runtime = new FakeRuntimeHost({
    sessionId: 'unnamed-session',
    sessionFile: '/tmp/unnamed-session.jsonl',
    model: { provider: 'openai', id: 'gpt-purpose' }
  })
  const canonicalSessionFile = '/tmp/canonical-unnamed-session.jsonl'
  const automaticName = '修复会话语义命名'
  const persisted: SessionPointer[] = []
  let generationRequest: SessionNameGenerationRequest | null = null
  let validationCalls = 0
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(null, persisted, [], [], async (request) => {
        generationRequest = request
        return `标题：${automaticName}\n不应采用这一行`
      }),
      validateSession: async (pointer) => {
        validationCalls += 1
        if (validationCalls === 1) throw fileError('ENOENT', 'session file not written yet')
        return { ...pointer, sessionFile: canonicalSessionFile }
      }
    }
  )

  await kernel.start()
  await kernel.prompt('请让对话名称体现会话目的，而不是复制第一条消息。')
  const materialized = new Promise<void>((resolve) => {
    const unsubscribe = kernel.subscribe(() => {
      if (kernel.getState().activeSessionKey === canonicalSessionFile) {
        unsubscribe()
        resolve()
      }
    })
  })
  runtime.emit({
    type: 'pi-event',
    event: {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '我会改用独立模型请求生成语义标题。' }],
        timestamp: 20
      }
    }
  })
  await materialized
  assert.equal(generationRequest, null)

  const named = new Promise<void>((resolve) => {
    const unsubscribe = kernel.subscribe(() => {
      if (kernel.getState().session.name === automaticName && persisted.length === 2) {
        unsubscribe()
        resolve()
      }
    })
  })
  runtime.emit({ type: 'pi-event', event: { type: 'agent_settled' } })
  await named

  const request = generationRequest as SessionNameGenerationRequest | null
  assert.ok(request)
  assert.deepEqual({
    executable: request.executable,
    cwd: request.cwd,
    provider: request.provider,
    modelId: request.modelId,
    userMessage: request.userMessage,
    assistantMessage: request.assistantMessage,
    aborted: request.signal.aborted
  }, {
    executable: '/usr/bin/pi',
    cwd: '/tmp/project',
    provider: 'openai',
    modelId: 'gpt-5.4-mini',
    userMessage: '请让对话名称体现会话目的，而不是复制第一条消息。',
    assistantMessage: '我会改用独立模型请求生成语义标题。',
    aborted: false
  })
  const expectedPointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: canonicalSessionFile,
    sessionId: 'unnamed-session',
    sessionName: automaticName
  }
  assert.equal(persisted.length, 2)
  assert.deepEqual(persisted[0], { ...expectedPointer, sessionName: null })
  assert.deepEqual(persisted[1], expectedPointer)
  assert.deepEqual(
    runtime.commands.filter(({ type }) => type === 'prompt' || type === 'set_session_name'),
    [
      { type: 'prompt', message: '请让对话名称体现会话目的，而不是复制第一条消息。' },
      { type: 'set_session_name', name: automaticName }
    ]
  )
  assert.equal(kernel.getState().sessions[0]?.name, automaticName)
})

test('renaming a provisional session persists the real name and replaces the provisional pointer', async () => {
  const runtime = new FakeRuntimeHost({
    sessionId: 'provisional-session',
    sessionFile: '/tmp/provisional-session.jsonl',
    sessionName: 'Temporary name'
  })
  const persisted: SessionPointer[] = []
  let validationCalls = 0
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(null, persisted),
      validateSession: async (pointer) => {
        validationCalls += 1
        if (validationCalls === 1) throw fileError('ENOENT', 'session file not written yet')
        return { ...pointer, sessionFile: '/tmp/canonical-provisional-session.jsonl' }
      }
    }
  )

  await kernel.start()
  await kernel.invokeCommand(SET_SESSION_NAME_COMMAND_ID, 'Named before first turn')

  const expectedPointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/canonical-provisional-session.jsonl',
    sessionId: 'provisional-session',
    sessionName: 'Named before first turn'
  }
  assert.deepEqual(persisted, [expectedPointer])
  assert.equal(kernel.getState().activeSessionKey, expectedPointer.sessionFile)
  assert.equal(kernel.getState().session.name, expectedPointer.sessionName)
  assert.equal(kernel.getState().session.resumeAvailable, true)
  assert.deepEqual(kernel.getState().sessions, [{
    key: expectedPointer.sessionFile,
    id: expectedPointer.sessionId,
    name: expectedPointer.sessionName,
    lastActivityAt: null,
    runtimeStatus: 'ready',
    statistics: null
  }])

  const restarted = new WorkbenchKernel(
    () => new FakeRuntimeHost(),
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions(expectedPointer)
  )
  assert.equal(restarted.getState().session.name, expectedPointer.sessionName)
})

test('the first assistant message materializes a provisional session before settled becomes ready', async () => {
  const runtime = new FakeRuntimeHost({
    sessionId: 'provisional-session',
    sessionFile: '/tmp/provisional-session.jsonl',
    sessionName: 'Provisional session'
  })
  const canonicalPointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/canonical-provisional-session.jsonl',
    sessionId: 'provisional-session',
    sessionName: 'Provisional session'
  }
  const persisted: SessionPointer[] = []
  let validationCalls = 0
  let earlyAttemptEntered!: () => void
  let persistenceEntered!: () => void
  let releasePersistence!: () => void
  const earlyAttempt = new Promise<void>((resolve) => {
    earlyAttemptEntered = resolve
  })
  const entered = new Promise<void>((resolve) => {
    persistenceEntered = resolve
  })
  const persistenceGate = new Promise<void>((resolve) => {
    releasePersistence = resolve
  })
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(null, persisted),
      validateSession: async () => {
        validationCalls += 1
        if (validationCalls === 1) throw fileError('ENOENT', 'session file not written yet')
        if (validationCalls === 2) {
          earlyAttemptEntered()
          throw fileError('ENOENT', 'message event arrived before Pi finished writing')
        }
        return canonicalPointer
      },
      persistSession: async (pointer) => {
        persistenceEntered()
        await persistenceGate
        persisted.push(pointer)
      }
    }
  )

  await kernel.start()
  await kernel.prompt('Materialize the session')
  runtime.emit({
    type: 'pi-event',
    event: {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Written' }],
        timestamp: 20
      }
    }
  })
  await earlyAttempt
  await new Promise<void>((resolve) => setImmediate(resolve))
  runtime.emit({ type: 'pi-event', event: { type: 'agent_settled' } })
  await entered

  assert.equal(kernel.getState().runtime.status, 'running')
  assert.equal(kernel.getState().activeSessionKey, '/tmp/provisional-session.jsonl')
  assert.equal(kernel.getState().sessions[0]?.provisional, true)
  const committed = new Promise<void>((resolve) => {
    const unsubscribe = kernel.subscribe(() => {
      const state = kernel.getState()
      if (state.activeSessionKey === canonicalPointer.sessionFile && state.runtime.status === 'ready') {
        unsubscribe()
        resolve()
      }
    })
  })
  releasePersistence()
  await committed

  const state = kernel.getState()
  assert.deepEqual(persisted, [canonicalPointer])
  assert.deepEqual(state.sessions.map(({ lastActivityAt: _lastActivityAt, ...summary }) => summary), [{
    key: canonicalPointer.sessionFile,
    id: canonicalPointer.sessionId,
    name: canonicalPointer.sessionName,
    runtimeStatus: 'ready',
    statistics: null
  }])
  assert.equal(typeof state.sessions[0]?.lastActivityAt, 'number')
  assert.equal(state.activeSessionKey, canonicalPointer.sessionFile)
  assert.equal(state.session.resumeAvailable, true)
  assert.equal(state.session.settled, true)
  assert.equal(state.runtime.status, 'ready')
  assert.equal(runtime.commands.some(({ type }) => type === 'set_session_name'), false)
})

test('provisional materialization retries when agent_settled races an in-flight ENOENT commit', async () => {
  const runtime = new FakeRuntimeHost({
    sessionId: 'provisional-race',
    sessionFile: '/tmp/provisional-race.jsonl',
    sessionName: 'Raced session'
  })
  const canonicalPointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/canonical-provisional-race.jsonl',
    sessionId: 'provisional-race',
    sessionName: 'Raced session'
  }
  const persisted: SessionPointer[] = []
  let validationCalls = 0
  let holdValidation!: () => void
  const validationGate = new Promise<void>((resolve) => {
    holdValidation = resolve
  })
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(null, persisted),
      validateSession: async () => {
        validationCalls += 1
        if (validationCalls === 1) throw fileError('ENOENT', 'session file not written yet')
        if (validationCalls === 2) {
          await validationGate
          throw fileError('ENOENT', 'commit still racing the write')
        }
        return canonicalPointer
      }
    }
  )

  await kernel.start()
  await kernel.prompt('Materialize after race')
  runtime.emit({
    type: 'pi-event',
    event: {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Written later' }],
        timestamp: 20
      }
    }
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  runtime.emit({ type: 'pi-event', event: { type: 'agent_settled' } })

  const committed = new Promise<void>((resolve) => {
    const unsubscribe = kernel.subscribe(() => {
      if (kernel.getState().activeSessionKey === canonicalPointer.sessionFile) {
        unsubscribe()
        resolve()
      }
    })
  })
  holdValidation()
  await committed

  assert.deepEqual(persisted, [canonicalPointer])
  assert.equal(kernel.getState().activeSessionKey, canonicalPointer.sessionFile)
  assert.equal(kernel.getState().sessions.some(({ key }) => key === canonicalPointer.sessionFile), true)
  assert.equal(kernel.getState().runtime.status, 'ready')
  assert.equal(kernel.getState().session.settled, true)
})

test('a non-ENOENT provisional commit failure crashes without registering a ghost session', async () => {
  const runtime = new FakeRuntimeHost({
    sessionId: 'failed-provisional-session',
    sessionFile: '/tmp/failed-provisional-session.jsonl'
  })
  const persisted: SessionPointer[] = []
  let validationCalls = 0
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(null, persisted),
      validateSession: async () => {
        validationCalls += 1
        if (validationCalls === 1) throw fileError('ENOENT', 'session file not written yet')
        throw fileError('EACCES', 'session file is unreadable')
      }
    }
  )

  await kernel.start()
  await kernel.prompt('Trigger materialization')
  const crashed = new Promise<void>((resolve) => {
    const unsubscribe = kernel.subscribe(() => {
      if (kernel.getState().runtime.status === 'crashed') {
        unsubscribe()
        resolve()
      }
    })
  })
  runtime.emit({
    type: 'pi-event',
    event: {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Cannot commit' }],
        timestamp: 20
      }
    }
  })
  await crashed

  const state = kernel.getState()
  assert.equal(state.runtime.status, 'crashed')
  assert.match(state.runtime.lastError ?? '', /unreadable/)
  assert.equal(state.activeSessionKey, null)
  assert.equal(state.sessions.some((summary) => summary.provisional === true), false)
  assert.deepEqual(state.sessions, [])
  assert.deepEqual(persisted, [])
})

test('starting another session preserves the ready runtime and keeps both sessions indexed', async () => {
  const firstRuntime = new FakeRuntimeHost({
    sessionId: 'session-1',
    sessionFile: '/tmp/session-1.jsonl',
    sessionName: 'First session'
  })
  const secondRuntime = new FakeRuntimeHost({
    sessionId: 'session-2',
    sessionFile: '/tmp/session-2.jsonl',
    sessionName: 'Second session'
  })
  const runtimes = [firstRuntime, secondRuntime]
  const persisted: SessionPointer[] = []
  const kernel = new WorkbenchKernel(
    () => {
      const runtime = runtimes.shift()
      assert.ok(runtime)
      return runtime
    },
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions(null, persisted)
  )

  await kernel.start()
  await kernel.start()

  assert.equal(firstRuntime.stopCalls, 0)
  assert.deepEqual(persisted.map(({ sessionId }) => sessionId), ['session-1', 'session-2'])
  assert.deepEqual(kernel.getState().sessions.map(({ id }) => id), ['session-1', 'session-2'])
  assert.equal(kernel.getState().activeSessionKey, '/tmp/session-2.jsonl')
  assert.equal(kernel.getState().session.id, 'session-2')
  assert.equal(kernel.getState().runtime.status, 'ready')
})

test('activating a registered session preserves and reuses managed runtimes', async () => {
  const firstPointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/session-1.jsonl',
    sessionId: 'session-1',
    sessionName: 'First session'
  }
  const secondPointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/session-2.jsonl',
    sessionId: 'session-2',
    sessionName: 'Second session'
  }
  const firstRuntime = new FakeRuntimeHost({
    sessionId: firstPointer.sessionId,
    sessionFile: firstPointer.sessionFile,
    sessionName: firstPointer.sessionName ?? undefined
  })
  const secondRuntime = new FakeRuntimeHost(
    {
      sessionId: secondPointer.sessionId,
      sessionFile: secondPointer.sessionFile,
      sessionName: secondPointer.sessionName ?? undefined
    },
    [{ role: 'assistant', content: [{ type: 'text', text: 'Second history' }], timestamp: 10 }]
  )
  const runtimes = [firstRuntime, secondRuntime]
  const launches: Array<{ sessionFile?: string }> = []
  const persisted: SessionPointer[] = []
  let rejectManagedPersistence = false
  const kernel = new WorkbenchKernel(
    (_project, launchOptions) => {
      launches.push(launchOptions)
      const runtime = runtimes.shift()
      assert.ok(runtime)
      return runtime
    },
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(),
      sessionRegistry: {
        sessions: [firstPointer, secondPointer],
        activeSessionKey: firstPointer.sessionFile
      },
      persistSession: async (pointer) => {
        if (rejectManagedPersistence) throw new Error('persist active session failed')
        persisted.push(pointer)
      }
    }
  )

  await kernel.activateSession(firstPointer.sessionFile)
  await kernel.activateSession(secondPointer.sessionFile)

  assert.equal(firstRuntime.stopCalls, 0)
  assert.deepEqual(launches, [
    {
      sessionFile: firstPointer.sessionFile,
      subagent: DEFAULT_SUBAGENT_SETTINGS,
      fastExtensionLoading: false
    },
    {
      sessionFile: secondPointer.sessionFile,
      subagent: DEFAULT_SUBAGENT_SETTINGS,
      fastExtensionLoading: false
    }
  ])
  assert.equal(kernel.getState().activeSessionKey, secondPointer.sessionFile)
  assert.equal(kernel.getState().session.id, secondPointer.sessionId)
  const recovered = kernel.getState().conversation.entries[0]
  assert.equal(recovered?.kind === 'message' ? recovered.text : null, 'Second history')

  secondRuntime.emit({ type: 'activity-started' })
  await kernel.activateSession(firstPointer.sessionFile)
  assert.equal(kernel.getState().session.id, firstPointer.sessionId)
  assert.equal(firstRuntime.startCalls, 1)
  assert.equal(secondRuntime.stopCalls, 0)
  secondRuntime.emit({ type: 'activity-settled' })
  assert.deepEqual(persisted.map(({ sessionId }) => sessionId), [
    firstPointer.sessionId,
    secondPointer.sessionId,
    firstPointer.sessionId
  ])

  rejectManagedPersistence = true
  await assert.rejects(
    kernel.activateSession(secondPointer.sessionFile),
    /persist active session failed/
  )
  assert.equal(kernel.getState().activeSessionKey, firstPointer.sessionFile)
  assert.equal(kernel.getState().session.id, firstPointer.sessionId)

  await assert.rejects(
    kernel.activateSession('/tmp/unregistered-session.jsonl'),
    /Session is not registered for the active project/
  )
  assert.equal(secondRuntime.stopCalls, 0)
})

test('starting a registered session attributes lifecycle status to its target before activation commits', async () => {
  const firstPointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/session-1.jsonl',
    sessionId: 'session-1',
    sessionName: 'First session'
  }
  const secondPointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/session-2.jsonl',
    sessionId: 'session-2',
    sessionName: 'Second session'
  }
  const firstRuntime = new FakeRuntimeHost({
    sessionId: firstPointer.sessionId,
    sessionFile: firstPointer.sessionFile,
    sessionName: firstPointer.sessionName ?? undefined
  })
  const secondRuntime = new DelayedStartRuntimeHost({
    sessionId: secondPointer.sessionId,
    sessionFile: secondPointer.sessionFile,
    sessionName: secondPointer.sessionName ?? undefined
  })
  const runtimes = [firstRuntime, secondRuntime]
  const kernel = new WorkbenchKernel(
    () => {
      const runtime = runtimes.shift()
      assert.ok(runtime)
      return runtime
    },
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(),
      sessionRegistry: {
        sessions: [firstPointer, secondPointer],
        activeSessionKey: firstPointer.sessionFile
      }
    }
  )

  await kernel.activateSession(firstPointer.sessionFile)
  const activation = kernel.activateSession(secondPointer.sessionFile)
  await secondRuntime.startEntered

  let state = kernel.getState()
  assert.equal(state.activeSessionKey, firstPointer.sessionFile)
  assert.equal(state.sessions.find(({ key }) => key === firstPointer.sessionFile)?.runtimeStatus, 'ready')
  assert.equal(state.sessions.find(({ key }) => key === secondPointer.sessionFile)?.runtimeStatus, 'starting')
  assert.equal(state.projects[0]?.busySessionCount, 0)

  secondRuntime.releaseStart()
  await activation

  state = kernel.getState()
  assert.equal(state.activeSessionKey, secondPointer.sessionFile)
  assert.equal(state.sessions.find(({ key }) => key === firstPointer.sessionFile)?.runtimeStatus, 'ready')
  assert.equal(state.sessions.find(({ key }) => key === secondPointer.sessionFile)?.runtimeStatus, 'ready')
})

test('registered session start failure restores the ready runtime and releases target ownership', async () => {
  const firstPointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/session-1.jsonl',
    sessionId: 'session-1',
    sessionName: 'First session'
  }
  const secondPointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/session-2.jsonl',
    sessionId: 'session-2',
    sessionName: 'Second session'
  }
  const firstRuntime = new FakeRuntimeHost({
    sessionId: firstPointer.sessionId,
    sessionFile: firstPointer.sessionFile,
    sessionName: firstPointer.sessionName ?? undefined
  })
  const secondRuntime = new FailingStartRuntimeHost({
    sessionId: secondPointer.sessionId,
    sessionFile: secondPointer.sessionFile,
    sessionName: secondPointer.sessionName ?? undefined
  })
  const runtimes = [firstRuntime, secondRuntime]
  const kernel = new WorkbenchKernel(
    () => {
      const runtime = runtimes.shift()
      assert.ok(runtime)
      return runtime
    },
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(),
      sessionRegistry: {
        sessions: [firstPointer, secondPointer],
        activeSessionKey: firstPointer.sessionFile
      }
    }
  )

  await kernel.activateSession(firstPointer.sessionFile)
  await assert.rejects(kernel.activateSession(secondPointer.sessionFile), /start failed/)

  const state = kernel.getState()
  assert.equal(secondRuntime.stopCalls, 1)
  assert.equal(state.activeSessionKey, firstPointer.sessionFile)
  assert.equal(state.runtime.status, 'ready')
  assert.equal(state.session.id, firstPointer.sessionId)
  assert.equal(state.sessions.find(({ key }) => key === firstPointer.sessionFile)?.runtimeStatus, 'ready')
  assert.equal(state.sessions.find(({ key }) => key === secondPointer.sessionFile)?.runtimeStatus, 'stopped')
  assert.deepEqual(
    state.projects.map(({ path, busySessionCount }) => ({ path, busySessionCount })),
    [{ path: '/tmp/project', busySessionCount: 0 }]
  )
})

test('previewing another session while ready projects its messages without changing runtime or kernel state', async () => {
  const firstPointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/session-1.jsonl',
    sessionId: 'session-1',
    sessionName: 'First session'
  }
  const secondPointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/session-2.jsonl',
    sessionId: 'session-2',
    sessionName: 'Second session'
  }
  const runtime = new FakeRuntimeHost({
    sessionId: firstPointer.sessionId,
    sessionFile: firstPointer.sessionFile,
    sessionName: firstPointer.sessionName ?? undefined
  })
  const readPointers: SessionPointer[] = []
  let createCalls = 0
  const kernel = new WorkbenchKernel(
    () => {
      createCalls += 1
      return runtime
    },
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(),
      sessionRegistry: {
        sessions: [firstPointer, secondPointer],
        activeSessionKey: firstPointer.sessionFile
      },
      readSessionMessages: async (pointer) => {
        readPointers.push(pointer)
        return [{
          role: 'assistant',
          content: [{ type: 'text', text: 'Read-only second history' }],
          timestamp: 42
        }]
      }
    }
  )

  await kernel.activateSession(firstPointer.sessionFile)
  const stateBeforePreview = kernel.getState()
  const runtimeCallsBeforePreview = {
    create: createCalls,
    start: runtime.startCalls,
    stop: runtime.stopCalls
  }

  const preview = await kernel.previewSession(secondPointer.sessionFile)

  assert.deepEqual(readPointers, [secondPointer])
  assert.equal(preview.projectKey, secondPointer.projectPath)
  assert.equal(preview.sessionKey, secondPointer.sessionFile)
  assert.equal(preview.sessionId, secondPointer.sessionId)
  assert.equal(preview.sessionName, secondPointer.sessionName)
  assert.equal(preview.conversation.activeRunStartIndex, null)
  assert.equal(preview.conversation.entries.length, 1)
  const previewEntry = preview.conversation.entries[0]
  assert.equal(previewEntry?.kind === 'message' ? previewEntry.text : null, 'Read-only second history')
  assert.deepEqual(kernel.getState(), stateBeforePreview)
  assert.deepEqual({
    create: createCalls,
    start: runtime.startCalls,
    stop: runtime.stopCalls
  }, runtimeCallsBeforePreview)
})

test('session export reads only the settled active persisted branch without starting a runtime', async () => {
  const pointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/session-export.jsonl',
    sessionId: 'session-export',
    sessionName: 'Export session'
  }
  const messages = [
    { role: 'user', content: 'Question' },
    { role: 'assistant', content: [{ type: 'text', text: 'Answer' }] }
  ]
  const readPointers: SessionPointer[] = []
  let runtimeCreations = 0
  const kernel = new WorkbenchKernel(
    () => {
      runtimeCreations += 1
      return new FakeRuntimeHost()
    },
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(pointer),
      readSessionMessages: async (candidate) => {
        readPointers.push(candidate)
        return messages
      }
    }
  )
  const stateBefore = kernel.getState()

  const source = await kernel.prepareSessionExport()

  assert.deepEqual(source, {
    projectKey: pointer.projectPath,
    sessionKey: pointer.sessionFile,
    sessionId: pointer.sessionId,
    title: pointer.sessionName,
    messages
  })
  assert.deepEqual(readPointers, [pointer])
  assert.deepEqual(kernel.getState(), stateBefore)
  assert.equal(runtimeCreations, 0)
})

test('archiving a non-active session preserves the active runtime and conversation', async () => {
  const activePointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/active-session.jsonl',
    sessionId: 'active-session',
    sessionName: 'Active session'
  }
  const archivedPointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/archived-session.jsonl',
    sessionId: 'archived-session',
    sessionName: 'Archived session'
  }
  const runtime = new FakeRuntimeHost(
    {
      sessionId: activePointer.sessionId,
      sessionFile: activePointer.sessionFile,
      sessionName: activePointer.sessionName ?? undefined
    },
    [{ role: 'assistant', content: [{ type: 'text', text: 'Active history' }], timestamp: 10 }]
  )
  const archived: Array<{ projectPath: string, sessionKey: string }> = []
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(null, [], [], [], undefined, archived),
      sessionRegistry: {
        sessions: [activePointer, archivedPointer],
        activeSessionKey: activePointer.sessionFile
      }
    }
  )
  await kernel.activateSession(activePointer.sessionFile)
  const before = kernel.getState()

  await kernel.archiveSession(archivedPointer.sessionFile)

  const after = kernel.getState()
  assert.deepEqual(archived, [{
    projectPath: archivedPointer.projectPath,
    sessionKey: archivedPointer.sessionFile
  }])
  assert.equal(runtime.stopCalls, 0)
  assert.equal(after.activeSessionKey, before.activeSessionKey)
  assert.deepEqual(after.runtime, before.runtime)
  assert.deepEqual(after.session, before.session)
  assert.deepEqual(after.conversation, before.conversation)
  assert.deepEqual(after.sessions.map(({ key }) => key), [activePointer.sessionFile])
})

test('archiving the active ready session stops it before clearing the active projection', async () => {
  const pointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/active-session.jsonl',
    sessionId: 'active-session',
    sessionName: 'Active session'
  }
  const runtime = new FakeRuntimeHost(
    {
      sessionId: pointer.sessionId,
      sessionFile: pointer.sessionFile,
      sessionName: pointer.sessionName ?? undefined
    },
    [{ role: 'assistant', content: [{ type: 'text', text: 'History' }], timestamp: 10 }]
  )
  const archived: Array<{ projectPath: string, sessionKey: string }> = []
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions(pointer, [], [], [], undefined, archived)
  )
  await kernel.activateSession(pointer.sessionFile)

  await kernel.archiveSession(pointer.sessionFile)

  const state = kernel.getState()
  assert.equal(runtime.stopCalls, 1)
  assert.deepEqual(archived, [{ projectPath: pointer.projectPath, sessionKey: pointer.sessionFile }])
  assert.equal(state.runtime.status, 'stopped')
  assert.deepEqual(state.sessions, [])
  assert.equal(state.activeSessionKey, null)
  assert.deepEqual(state.availableModels, [])
  assert.equal(state.session.id, null)
  assert.equal(state.session.resumeAvailable, false)
  assert.deepEqual(state.conversation, { entries: [], activeRunStartIndex: null })
})

test('archiving while running stops and removes only the target runtime', async () => {
  const pointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/active-session.jsonl',
    sessionId: 'active-session',
    sessionName: 'Active session'
  }
  const runtime = new FakeRuntimeHost({
    sessionId: pointer.sessionId,
    sessionFile: pointer.sessionFile,
    sessionName: pointer.sessionName ?? undefined
  })
  const archived: Array<{ projectPath: string, sessionKey: string }> = []
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions(pointer, [], [], [], undefined, archived)
  )
  await kernel.activateSession(pointer.sessionFile)
  runtime.emit({ type: 'activity-started' })
  await kernel.archiveSession(pointer.sessionFile)

  assert.deepEqual(archived, [{
    projectPath: pointer.projectPath,
    sessionKey: pointer.sessionFile
  }])
  assert.equal(runtime.stopCalls, 1)
  assert.deepEqual(kernel.getState().sessions, [])
})

test('reordering projects persists and preserves active identities', async () => {
  const firstPointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/session-1.jsonl',
    sessionId: 'session-1',
    sessionName: 'First session'
  }
  const secondPointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/session-2.jsonl',
    sessionId: 'session-2',
    sessionName: 'Second session'
  }
  const persistedProjectOrders: string[][] = []
  const kernel = new WorkbenchKernel(
    () => new FakeRuntimeHost(),
    {
      projects: [{ path: '/tmp/project' }, { path: '/tmp/next-project' }],
      activeProjectKey: '/tmp/project'
    },
    {
      ...kernelOptions(),
      sessionRegistry: {
        sessions: [firstPointer, secondPointer],
        activeSessionKey: firstPointer.sessionFile
      },
      persistProjectOrder: async (projectKeys) => {
        persistedProjectOrders.push(projectKeys)
      }
    }
  )

  await kernel.reorderProjects(['/tmp/next-project', '/tmp/project'])

  const state = kernel.getState()
  assert.deepEqual(persistedProjectOrders, [['/tmp/next-project', '/tmp/project']])
  assert.deepEqual(state.projects.map(({ path }) => path), ['/tmp/next-project', '/tmp/project'])
  assert.deepEqual(state.sessions.map(({ key }) => key), [
    firstPointer.sessionFile,
    secondPointer.sessionFile
  ])
  assert.equal(state.activeProjectKey, '/tmp/project')
  assert.equal(state.activeSessionKey, firstPointer.sessionFile)
})

test('project reordering fails fast for duplicate, omitted, or unknown keys without persistence', async () => {
  let persistProjectOrderCalls = 0
  const kernel = new WorkbenchKernel(
    () => new FakeRuntimeHost(),
    {
      projects: [{ path: '/tmp/project' }, { path: '/tmp/next-project' }],
      activeProjectKey: '/tmp/project'
    },
    {
      ...kernelOptions(),
      persistProjectOrder: async () => {
        persistProjectOrderCalls += 1
      }
    }
  )
  const initialState = kernel.getState()

  for (const invalidOrder of [
    ['/tmp/project', '/tmp/project'],
    ['/tmp/project'],
    ['/tmp/project', '/tmp/unknown-project']
  ]) {
    await assert.rejects(kernel.reorderProjects(invalidOrder), /Invalid project order/)
  }

  assert.equal(persistProjectOrderCalls, 0)
  assert.deepEqual(kernel.getState(), initialState)
})

test('session validation failure leaves the ready runtime and active identity untouched', async () => {
  const firstPointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/session-1.jsonl',
    sessionId: 'session-1',
    sessionName: 'First session'
  }
  const secondPointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/missing-session.jsonl',
    sessionId: 'session-2',
    sessionName: 'Missing session'
  }
  const runtime = new FakeRuntimeHost({
    sessionId: firstPointer.sessionId,
    sessionFile: firstPointer.sessionFile,
    sessionName: firstPointer.sessionName ?? undefined
  })
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(),
      sessionRegistry: {
        sessions: [firstPointer, secondPointer],
        activeSessionKey: firstPointer.sessionFile
      },
      validateSession: async (pointer) => {
        if (pointer.sessionFile === secondPointer.sessionFile) throw new Error('session file missing')
        return pointer
      }
    }
  )

  await kernel.activateSession(firstPointer.sessionFile)
  await assert.rejects(kernel.activateSession(secondPointer.sessionFile), /session file missing/)

  assert.equal(runtime.stopCalls, 0)
  assert.equal(kernel.getState().runtime.status, 'ready')
  assert.equal(kernel.getState().activeSessionKey, firstPointer.sessionFile)
  assert.equal(kernel.getState().session.id, firstPointer.sessionId)
})

test('stop waits for the session commit, then stops the committed runtime', async () => {
  const runtime = new FakeRuntimeHost({
    sessionId: 'session-commit',
    sessionFile: '/tmp/session-commit.jsonl'
  })
  let commitEntered!: () => void
  let releaseCommit!: () => void
  const entered = new Promise<void>((resolve) => {
    commitEntered = resolve
  })
  const commitGate = new Promise<void>((resolve) => {
    releaseCommit = resolve
  })
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(),
      persistSession: async () => {
        commitEntered()
        await commitGate
      }
    }
  )

  const startPromise = kernel.start()
  await entered
  const stopPromise = kernel.stop()
  releaseCommit()
  await startPromise
  await stopPromise

  assert.equal(runtime.stopCalls, 1)
  assert.equal(kernel.getState().activeSessionKey, '/tmp/session-commit.jsonl')
  assert.equal(kernel.getState().runtime.status, 'stopped')
})

test('session switch crash during persistence cannot commit ready or the target session', async () => {
  const firstPointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/session-1.jsonl',
    sessionId: 'session-1',
    sessionName: 'First session'
  }
  const secondPointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/session-2.jsonl',
    sessionId: 'session-2',
    sessionName: 'Second session'
  }
  const runtime = new FakeRuntimeHost({
    sessionId: secondPointer.sessionId,
    sessionFile: secondPointer.sessionFile,
    sessionName: secondPointer.sessionName ?? undefined
  })
  let persistenceEntered!: () => void
  let releasePersistence!: () => void
  const entered = new Promise<void>((resolve) => {
    persistenceEntered = resolve
  })
  const persistenceGate = new Promise<void>((resolve) => {
    releasePersistence = resolve
  })
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(),
      sessionRegistry: {
        sessions: [firstPointer, secondPointer],
        activeSessionKey: firstPointer.sessionFile
      },
      persistSession: async () => {
        persistenceEntered()
        await persistenceGate
      }
    }
  )
  const statuses = collectStatuses(kernel)

  const switchPromise = kernel.activateSession(secondPointer.sessionFile)
  await entered
  runtime.emit({ type: 'process-exit', code: 11, signal: null })
  releasePersistence()

  await assert.rejects(switchPromise, /cancelled/i)
  const crashedState = kernel.getState()
  assert.equal(crashedState.runtime.status, 'crashed')
  assert.equal(crashedState.runtime.exitCode, 11)
  assert.equal(statuses.includes('ready'), false)
  assert.equal(crashedState.activeSessionKey, firstPointer.sessionFile)
  assert.equal(crashedState.session.id, firstPointer.sessionId)
  assert.deepEqual(crashedState.conversation.entries, [])

  await kernel.stop()
  assert.equal(runtime.stopCalls, 1)
  assert.equal(kernel.getState().runtime.status, 'stopped')
})

test('explicit resume after a crash replaces the managed runtime and restores the session', async () => {
  const pointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/session-1.jsonl',
    sessionId: 'session-1',
    sessionName: 'Resumed session'
  }
  const firstRuntime = new FakeRuntimeHost({
    sessionId: pointer.sessionId,
    sessionFile: pointer.sessionFile,
    sessionName: pointer.sessionName ?? undefined
  })
  const resumedRuntime = new FakeRuntimeHost(
    {
      sessionId: pointer.sessionId,
      sessionFile: pointer.sessionFile,
      sessionName: pointer.sessionName ?? undefined
    },
    [{ role: 'assistant', content: [{ type: 'text', text: 'Recovered' }], timestamp: 42 }]
  )
  const runtimes = [firstRuntime, resumedRuntime]
  const launches: { sessionFile?: string }[] = []
  const kernel = new WorkbenchKernel(
    (_project, launchOptions) => {
      launches.push(launchOptions)
      const runtime = runtimes.shift()
      assert.ok(runtime)
      return runtime
    },
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions(pointer)
  )

  await kernel.activateSession(pointer.sessionFile)
  firstRuntime.emit({ type: 'process-exit', code: 7, signal: null })
  await kernel.resumeSession()

  assert.equal(firstRuntime.stopCalls, 1)
  assert.equal(resumedRuntime.startCalls, 1)
  assert.equal(kernel.getState().runtime.status, 'ready')
  assert.equal(kernel.getState().session.id, pointer.sessionId)
  const recovered = kernel.getState().conversation.entries[0]
  assert.equal(recovered?.kind === 'message' ? recovered.text : null, 'Recovered')
  assert.deepEqual(launches, [
    {
      sessionFile: pointer.sessionFile,
      subagent: DEFAULT_SUBAGENT_SETTINGS,
      fastExtensionLoading: false
    },
    {
      sessionFile: pointer.sessionFile,
      subagent: DEFAULT_SUBAGENT_SETTINGS,
      fastExtensionLoading: false
    }
  ])
})

test('a stored pointer is resumable from a stopped kernel relaunch', async () => {
  const pointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/stored-session.jsonl',
    sessionId: 'stored-session',
    sessionName: 'Stored session'
  }
  const launches: { sessionFile?: string }[] = []
  const runtime = new FakeRuntimeHost({
    sessionId: pointer.sessionId,
    sessionFile: pointer.sessionFile,
    sessionName: pointer.sessionName ?? undefined
  })
  const kernel = new WorkbenchKernel(
    (_project, launchOptions) => {
      launches.push(launchOptions)
      return runtime
    },
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions(pointer)
  )

  assert.equal(kernel.getState().session.resumeAvailable, true)
  assert.equal(kernel.getState().session.id, pointer.sessionId)
  await kernel.resumeSession()

  assert.deepEqual(launches, [{
    sessionFile: pointer.sessionFile,
    subagent: DEFAULT_SUBAGENT_SETTINGS,
    fastExtensionLoading: false
  }])
  assert.equal(kernel.getState().runtime.status, 'ready')
})

test('resume rejects without a pointer or from an active runtime state', async () => {
  const runtime = new FakeRuntimeHost()
  const noPointerKernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions()
  )
  await assert.rejects(noPointerKernel.resumeSession(), /No active session/)

  const pointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/session-1.jsonl',
    sessionId: 'session-1',
    sessionName: null
  }
  const activeKernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions(pointer)
  )
  await activeKernel.start()
  await activeKernel.resumeSession()
  assert.equal(runtime.startCalls, 1)
})

test('startup persistence and projection failures stop and release the runtime', async (t) => {
  await t.test('persistence failure', async () => {
    const failedRuntime = new FakeRuntimeHost()
    const replacementRuntime = new FakeRuntimeHost()
    const runtimes = [failedRuntime, replacementRuntime]
    const kernel = new WorkbenchKernel(
      () => {
        const runtime = runtimes.shift()
        assert.ok(runtime)
        return runtime
      },
      { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
      {
        sessionRegistry: sessionRegistry(null),
        validateSession: async (pointer) => pointer,
        persistProject: async () => {},
        persistActiveProject: async () => {},
        persistSession: async () => {
          throw new Error('persist failed')
        },
        persistArchivedSession: async () => {}
      }
    )

    await assert.rejects(kernel.start(), /persist failed/)
    assert.equal(failedRuntime.stopCalls, 1)
    assert.equal(kernel.getState().runtime.status, 'crashed')

    await assert.rejects(kernel.start(), /persist failed/)
    assert.equal(failedRuntime.stopCalls, 1)
    assert.equal(replacementRuntime.stopCalls, 1)
  })

  await t.test('get_messages failure', async () => {
    const runtime = new FailingCommandRuntimeHost('get_messages')
    const persisted: SessionPointer[] = []
    const previousPointer: SessionPointer = {
      projectPath: '/tmp/project',
      sessionFile: '/tmp/previous-session.jsonl',
      sessionId: 'previous-session',
      sessionName: 'Previous session'
    }
    const kernel = new WorkbenchKernel(
      () => runtime,
      { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
      kernelOptions(previousPointer, persisted)
    )

    await assert.rejects(kernel.start(), /get_messages failed/)
    assert.equal(runtime.stopCalls, 1)
    assert.deepEqual(persisted, [])
    assert.equal(kernel.getState().runtime.status, 'crashed')
    assert.equal(kernel.getState().session.id, previousPointer.sessionId)
    assert.equal(kernel.getState().session.name, previousPointer.sessionName)
    assert.deepEqual(kernel.getState().conversation.entries, [])
    await kernel.stop()
    assert.equal(kernel.getState().runtime.status, 'stopped')
  })

  await t.test('get_commands failure', async () => {
    const runtime = new FailingCommandRuntimeHost('get_commands')
    const kernel = new WorkbenchKernel(
      () => runtime,
      { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
      kernelOptions()
    )

    await assert.rejects(kernel.start(), /get_commands failed/)
    assert.equal(runtime.stopCalls, 1)
    assert.equal(kernel.getState().runtime.status, 'crashed')
    assert.deepEqual(kernel.getState().commands.map(({ name }) => name), [
      'new',
      'fork',
      'export',
      'copy',
      'model',
      'thinking',
      'compact',
      'name'
    ])
  })

  await t.test('get_available_models failure', async () => {
    const runtime = new FailingCommandRuntimeHost('get_available_models')
    const kernel = new WorkbenchKernel(
      () => runtime,
      { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
      kernelOptions()
    )

    await assert.rejects(kernel.start(), /get_available_models failed/)
    assert.equal(runtime.stopCalls, 1)
    assert.equal(kernel.getState().runtime.status, 'crashed')
    assert.deepEqual(kernel.getState().availableModels, [])
  })

  await t.test('get_session_stats failure', async () => {
    const runtime = new FailingCommandRuntimeHost('get_session_stats')
    const kernel = new WorkbenchKernel(
      () => runtime,
      { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
      kernelOptions()
    )

    await assert.rejects(kernel.start(), /get_session_stats failed/)
    assert.equal(runtime.stopCalls, 1)
    assert.equal(kernel.getState().runtime.status, 'crashed')
  })
})

test('resume requires a validator before creating a runtime', async () => {
  const pointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/session-1.jsonl',
    sessionId: 'session-1',
    sessionName: null
  }
  let createCalls = 0
  const options = {
    sessionRegistry: sessionRegistry(pointer),
    persistProject: async () => {},
    persistActiveProject: async () => {},
    persistSession: async () => {}
  } as unknown as ConstructorParameters<typeof WorkbenchKernel>[2]
  const kernel = new WorkbenchKernel(
    () => {
      createCalls += 1
      return new FakeRuntimeHost()
    },
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    options
  )

  await assert.rejects(kernel.resumeSession(), /validation is unavailable/)
  assert.equal(createCalls, 0)
})

test('resume validation failure preserves the pointer without creating a runtime', async () => {
  const pointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/missing-session.jsonl',
    sessionId: 'missing-session',
    sessionName: null
  }
  let createCalls = 0
  const kernel = new WorkbenchKernel(
    () => {
      createCalls += 1
      return new FakeRuntimeHost()
    },
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      sessionRegistry: sessionRegistry(pointer),
      persistProject: async () => {},
      persistActiveProject: async () => {},
      persistSession: async () => {},
      persistArchivedSession: async () => {},
      validateSession: async () => {
        throw new Error('session file missing')
      }
    }
  )

  await assert.rejects(kernel.resumeSession(), /session file missing/)

  assert.equal(createCalls, 0)
  assert.equal(kernel.getState().runtime.status, 'stopped')
  assert.equal(kernel.getState().session.resumeAvailable, true)
})

test('concurrent resumes allow only one launch operation and create one runtime', async () => {
  const pointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/session-1.jsonl',
    sessionId: 'session-1',
    sessionName: null
  }
  let createCalls = 0
  let validationEntered!: () => void
  let releaseValidation!: () => void
  const entered = new Promise<void>((resolve) => {
    validationEntered = resolve
  })
  const validationGate = new Promise<void>((resolve) => {
    releaseValidation = resolve
  })
  const kernel = new WorkbenchKernel(
    () => {
      createCalls += 1
      return new FakeRuntimeHost({
        sessionId: pointer.sessionId,
        sessionFile: pointer.sessionFile
      })
    },
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      sessionRegistry: sessionRegistry(pointer),
      persistProject: async () => {},
      persistActiveProject: async () => {},
      persistSession: async () => {},
      persistArchivedSession: async () => {},
      validateSession: async () => {
        validationEntered()
        await validationGate
        return pointer
      }
    }
  )

  const firstResume = kernel.resumeSession()
  await entered
  await assert.rejects(kernel.resumeSession(), /launch is already in progress/)
  releaseValidation()
  await firstResume

  assert.equal(createCalls, 1)
  assert.equal(kernel.getState().runtime.status, 'ready')
})

test('stop during resume validation cancels launch before runtime creation', async () => {
  const pointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/session-1.jsonl',
    sessionId: 'session-1',
    sessionName: null
  }
  let createCalls = 0
  let validationEntered!: () => void
  let releaseValidation!: () => void
  const entered = new Promise<void>((resolve) => {
    validationEntered = resolve
  })
  const validationGate = new Promise<void>((resolve) => {
    releaseValidation = resolve
  })
  const kernel = new WorkbenchKernel(
    () => {
      createCalls += 1
      return new FakeRuntimeHost()
    },
    {
      projects: [{ path: '/tmp/project' }, { path: '/tmp/next-project' }],
      activeProjectKey: '/tmp/project'
    },
    {
      sessionRegistry: sessionRegistry(pointer),
      persistProject: async () => {},
      persistActiveProject: async () => {},
      persistSession: async () => {},
      persistArchivedSession: async () => {},
      validateSession: async () => {
        validationEntered()
        await validationGate
        return pointer
      }
    }
  )

  const resumePromise = kernel.resumeSession()
  await entered
  await assert.rejects(
    kernel.activateProject('/tmp/next-project', sessionRegistry(null)),
    /launch is in progress/
  )
  const stopPromise = kernel.stop()
  releaseValidation()

  await assert.rejects(resumePromise, /cancelled/)
  await stopPromise
  assert.equal(createCalls, 0)
  assert.equal(kernel.getState().runtime.status, 'stopped')
  assert.equal(kernel.getState().activeProjectKey, '/tmp/project')
})

test('shutdown after starting beside a crashed runtime stops every owned runtime', async () => {
  const crashedRuntime = new FakeRuntimeHost()
  const replacementRuntime = new FakeRuntimeHost({
    sessionId: 'replacement-session',
    sessionFile: '/tmp/replacement-session.jsonl'
  })
  const runtimes = [crashedRuntime, replacementRuntime]
  let createCalls = 0
  const kernel = new WorkbenchKernel(
    () => {
      const runtime = runtimes[createCalls]
      createCalls += 1
      assert.ok(runtime)
      return runtime
    },
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions()
  )

  await kernel.start()
  crashedRuntime.emit({ type: 'process-exit', code: 9, signal: null })
  await kernel.start()
  await kernel.stop()
  assert.equal(createCalls, 2)
  assert.equal(crashedRuntime.stopCalls, 1)
  assert.equal(replacementRuntime.stopCalls, 1)
  assert.equal(kernel.getState().runtime.status, 'stopped')
})

test('failed launch cleanup keeps runtime ownership so stop can be retried', async () => {
  const runtime = new FailingThenStoppingRuntimeHost()
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions()
  )

  await assert.rejects(
    kernel.start(),
    /get_messages failed Cleanup failed while stopping runtime: stop failed/
  )
  assert.equal(runtime.stopCalls, 1)
  assert.equal(kernel.getState().runtime.status, 'crashed')

  await kernel.stop()
  assert.equal(runtime.stopCalls, 2)
  assert.equal(kernel.getState().runtime.status, 'stopped')
})

test('resume session ID mismatch preserves the pointer and cleans up the runtime', async () => {
  const pointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/stored-session.jsonl',
    sessionId: 'stored-session',
    sessionName: 'Stored session'
  }
  const persisted: SessionPointer[] = []
  const runtime = new FakeRuntimeHost({
    sessionId: 'different-session',
    sessionFile: '/tmp/different-session.jsonl'
  })
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions(pointer, persisted)
  )

  await assert.rejects(kernel.resumeSession(), /session ID mismatch/i)

  assert.equal(runtime.stopCalls, 1)
  assert.deepEqual(persisted, [])
  assert.equal(kernel.getState().session.id, pointer.sessionId)
  assert.equal(kernel.getState().session.resumeAvailable, true)
  assert.equal(kernel.getState().runtime.status, 'crashed')
})

test('a crashed kernel without a pointer can explicitly start an additional runtime', async () => {
  const firstRuntime = new FakeRuntimeHost()
  const secondRuntime = new FakeRuntimeHost({
    sessionId: 'session-2',
    sessionFile: '/tmp/session-2.jsonl'
  })
  const runtimes = [firstRuntime, secondRuntime]
  const kernel = new WorkbenchKernel(
    () => {
      const runtime = runtimes.shift()
      assert.ok(runtime)
      return runtime
    },
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions()
  )

  await kernel.start()
  firstRuntime.emit({ type: 'process-exit', code: 7, signal: null })
  await kernel.start()

  assert.equal(firstRuntime.stopCalls, 0)
  assert.equal(secondRuntime.startCalls, 1)
  assert.equal(kernel.getState().runtime.status, 'ready')
  assert.equal(kernel.getState().session.id, 'session-2')
})

test('delayed activity and Pi events cannot revive a stopping runtime', async () => {
  const runtime = new DelayedStopRuntimeHost()
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions()
  )

  await kernel.start()
  const stopPromise = kernel.stop()
  await runtime.stopEntered
  runtime.emit({ type: 'activity-started' })
  runtime.emit({ type: 'pi-event', event: { type: 'agent_start' } })

  assert.equal(kernel.getState().runtime.status, 'stopping')
  runtime.releaseStop()
  await stopPromise
  assert.equal(kernel.getState().runtime.status, 'stopped')
})

test('managed sessions keep independent runtimes and projections across active switches', async () => {
  const firstPointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/session-a.jsonl',
    sessionId: 'session-a',
    sessionName: 'Session A'
  }
  const runtimeA = new FakeRuntimeHost({
    sessionId: firstPointer.sessionId,
    sessionFile: firstPointer.sessionFile,
    sessionName: firstPointer.sessionName ?? undefined
  })
  const runtimeB = new FakeRuntimeHost({
    sessionId: 'session-b',
    sessionFile: '/tmp/session-b.jsonl',
    sessionName: 'Session B'
  })
  const runtimes = [runtimeA, runtimeB]
  const archived: Array<{ projectPath: string, sessionKey: string }> = []
  const kernel = new WorkbenchKernel(
    () => {
      const runtime = runtimes.shift()
      assert.ok(runtime)
      return runtime
    },
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions(firstPointer, [], [], [], undefined, archived)
  )

  await kernel.activateSession(firstPointer.sessionFile)
  runtimeA.emit({ type: 'activity-started' })
  await kernel.start()

  assert.equal(runtimeA.stopCalls, 0)
  assert.equal(kernel.getState().session.id, 'session-b')
  const backgroundEvents: KernelEvent[] = []
  const unsubscribeBackgroundEvents = kernel.subscribe((event) => backgroundEvents.push(event))
  for (const text of ['A', 'A background']) {
    runtimeA.emit({
      type: 'pi-event',
      event: {
        type: 'message_update',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: `Thinking about ${text}` },
            { type: 'text', text }
          ],
          timestamp: 10
        }
      }
    })
  }
  runtimeA.emit({
    type: 'pi-event',
    event: {
      type: 'tool_execution_start',
      toolCallId: 'background-tool',
      toolName: 'read',
      args: { path: 'package.json' }
    }
  })
  runtimeA.emit({
    type: 'pi-event',
    event: {
      type: 'tool_execution_update',
      toolCallId: 'background-tool',
      toolName: 'read',
      args: { path: 'package.json' },
      partialResult: { content: [{ type: 'text', text: '{"name"' }] }
    }
  })
  runtimeA.emit({
    type: 'pi-event',
    event: {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'A background' }],
        timestamp: 10,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      }
    }
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  unsubscribeBackgroundEvents()
  assert.deepEqual(backgroundEvents, [])
  runtimeB.emit({
    type: 'pi-event',
    event: {
      type: 'message_update',
      message: { role: 'assistant', content: [{ type: 'text', text: 'B foreground' }], timestamp: 20 }
    }
  })
  const foregroundEntry = kernel.getState().conversation.entries[0]
  assert.equal(foregroundEntry?.kind === 'message' ? foregroundEntry.text : null, 'B foreground')
  assert.equal(
    kernel.getState().sessions.find(({ id }) => id === 'session-a')?.runtimeStatus,
    'running'
  )

  await kernel.activateSession(firstPointer.sessionFile)
  assert.equal(runtimeA.startCalls, 1)
  assert.equal(kernel.getState().runtime.status, 'running')
  const backgroundEntry = kernel.getState().conversation.entries.find(
    (entry) => entry.kind === 'message'
  )
  assert.equal(backgroundEntry?.kind === 'message' ? backgroundEntry.text : null, 'A background')

  await kernel.activateSession('/tmp/session-b.jsonl')
  await kernel.archiveSession(firstPointer.sessionFile)
  assert.equal(runtimeA.stopCalls, 1)
  assert.equal(runtimeB.stopCalls, 0)
  assert.deepEqual(archived, [{
    projectPath: firstPointer.projectPath,
    sessionKey: firstPointer.sessionFile
  }])

  await kernel.stop()
  assert.equal(runtimeB.stopCalls, 1)
})

test('background compaction refresh remains isolated from the foreground context', async () => {
  const pointerA: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/compaction-a.jsonl',
    sessionId: 'compaction-a',
    sessionName: 'A'
  }
  const pointerB: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/compaction-b.jsonl',
    sessionId: 'compaction-b',
    sessionName: 'B'
  }
  const runtimeA = new FakeRuntimeHost(
    { sessionId: pointerA.sessionId, sessionFile: pointerA.sessionFile },
    [{ role: 'assistant', content: [{ type: 'text', text: 'Old A' }], timestamp: 1 }]
  )
  const runtimeB = new FakeRuntimeHost(
    { sessionId: pointerB.sessionId, sessionFile: pointerB.sessionFile },
    [{ role: 'assistant', content: [{ type: 'text', text: 'Foreground B' }], timestamp: 2 }]
  )
  const runtimes = [runtimeA, runtimeB]
  const kernel = new WorkbenchKernel(
    () => {
      const runtime = runtimes.shift()
      assert.ok(runtime)
      return runtime
    },
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(),
      sessionRegistry: {
        sessions: [pointerA, pointerB],
        activeSessionKey: pointerA.sessionFile
      }
    }
  )
  await kernel.activateSession(pointerA.sessionFile)
  await kernel.activateSession(pointerB.sessionFile)
  runtimeA.replaceMessages([
    { role: 'assistant', content: [{ type: 'text', text: 'Compacted A' }], timestamp: 3 }
  ])
  runtimeA.setSessionStats({
    sessionId: pointerA.sessionId,
    sessionFile: pointerA.sessionFile,
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 2,
    tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
    cost: 0
  })

  const completed = waitForCompactionOutcome(kernel, 'completed')
  runtimeA.emit({ type: 'pi-event', event: { type: 'compaction_start', reason: 'manual' } })
  runtimeA.emit({
    type: 'pi-event',
    event: {
      type: 'compaction_end',
      reason: 'manual',
      result: { summary: 'Compacted', firstKeptEntryId: 'kept', tokensBefore: 100 },
      aborted: false,
      willRetry: false
    }
  })
  await completed
  let entry = kernel.getState().conversation.entries[0]
  assert.equal(kernel.getState().session.id, pointerB.sessionId)
  assert.equal(entry?.kind === 'message' ? entry.text : null, 'Foreground B')

  await kernel.activateSession(pointerA.sessionFile)
  entry = kernel.getState().conversation.entries[0]
  assert.equal(kernel.getState().session.id, pointerA.sessionId)
  assert.equal(entry?.kind === 'message' ? entry.text : null, 'Compacted A')
  assert.equal(kernel.getState().sessions.find(({ id }) => id === pointerA.sessionId)?.statistics?.totalTokens, 15)
})

test('project switching preserves managed runtime ownership', async () => {
  const pointer: SessionPointer = {
    projectPath: '/tmp/project-a',
    sessionFile: '/tmp/project-a-session.jsonl',
    sessionId: 'project-a-session',
    sessionName: 'Project A session'
  }
  const runtime = new FakeRuntimeHost({
    sessionId: pointer.sessionId,
    sessionFile: pointer.sessionFile,
    sessionName: pointer.sessionName ?? undefined
  })
  const kernel = new WorkbenchKernel(
    () => runtime,
    {
      projects: [{ path: '/tmp/project-a' }, { path: '/tmp/project-b' }],
      activeProjectKey: '/tmp/project-a'
    },
    kernelOptions(pointer)
  )

  await kernel.activateSession(pointer.sessionFile)
  runtime.emit({ type: 'activity-started' })
  await kernel.activateProject('/tmp/project-b', sessionRegistry(null))
  assert.equal(runtime.stopCalls, 0)
  assert.equal(kernel.getState().runtime.status, 'stopped')

  await kernel.activateProject('/tmp/project-a', sessionRegistry(pointer))
  assert.equal(runtime.startCalls, 1)
  assert.equal(kernel.getState().activeSessionKey, pointer.sessionFile)
  assert.equal(kernel.getState().runtime.status, 'running')
})

test('inactive project runtime activity updates project busy session counts', async () => {
  const pointer: SessionPointer = {
    projectPath: '/tmp/project-a',
    sessionFile: '/tmp/project-a-session.jsonl',
    sessionId: 'project-a-session',
    sessionName: 'Project A session'
  }
  const runtime = new FakeRuntimeHost({
    sessionId: pointer.sessionId,
    sessionFile: pointer.sessionFile,
    sessionName: pointer.sessionName ?? undefined
  })
  const kernel = new WorkbenchKernel(
    () => runtime,
    {
      projects: [{ path: '/tmp/project-a' }, { path: '/tmp/project-b' }],
      activeProjectKey: '/tmp/project-a'
    },
    kernelOptions(pointer)
  )

  await kernel.activateSession(pointer.sessionFile)
  runtime.emit({ type: 'activity-started' })
  await kernel.activateProject('/tmp/project-b', sessionRegistry(null))
  assert.deepEqual(
    kernel.getState().projects.map(({ path, busySessionCount }) => ({ path, busySessionCount })),
    [
      { path: '/tmp/project-a', busySessionCount: 1 },
      { path: '/tmp/project-b', busySessionCount: 0 }
    ]
  )

  const events: KernelEvent[] = []
  kernel.subscribe((event) => events.push(event))
  runtime.emit({ type: 'activity-settled' })

  assert.equal(events.length, 1)
  assert.equal(events[0]?.type, 'kernel.state-changed')
  if (events[0]?.type === 'kernel.state-changed') {
    assert.deepEqual(
      events[0].state.projects.map(({ path, busySessionCount }) => ({ path, busySessionCount })),
      [
        { path: '/tmp/project-a', busySessionCount: 0 },
        { path: '/tmp/project-b', busySessionCount: 0 }
      ]
    )
    assert.deepEqual(events[0].state.sessions, [])
    assert.deepEqual(
      events[0].state.projects.map(({ path, sessions }) => ({
        path,
        sessionKeys: sessions?.map(({ key }) => key)
      })),
      [
        { path: '/tmp/project-a', sessionKeys: [pointer.sessionFile] },
        { path: '/tmp/project-b', sessionKeys: [] }
      ]
    )
  }
})

test('a background provisional session materializes without changing the foreground projection', async () => {
  const provisionalRuntime = new FakeRuntimeHost({
    sessionId: 'provisional-a',
    sessionFile: '/tmp/provisional-a.jsonl'
  })
  const foregroundRuntime = new FakeRuntimeHost({
    sessionId: 'session-b',
    sessionFile: '/tmp/session-b.jsonl'
  })
  let validationCalls = 0
  let now = 0
  const persisted: SessionPointer[] = []
  const kernel = new WorkbenchKernel(
    (() => {
      const runtimes = [provisionalRuntime, foregroundRuntime]
      return () => {
        const runtime = runtimes.shift()
        assert.ok(runtime)
        return runtime
      }
    })(),
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(null, persisted),
      validateSession: async (pointer) => {
        validationCalls += 1
        if (validationCalls === 1) throw fileError('ENOENT', 'not written')
        return { ...pointer, sessionFile: '/tmp/materialized-a.jsonl' }
      },
      now: () => ++now
    }
  )

  await kernel.start()
  await kernel.prompt('Materialize A')
  await kernel.start()

  const backgroundEvents: KernelEvent[] = []
  const unsubscribeBackgroundEvents = kernel.subscribe((event) => backgroundEvents.push(event))
  for (const text of ['A', 'A remains provisional']) {
    provisionalRuntime.emit({
      type: 'pi-event',
      event: {
        type: 'message_update',
        message: { role: 'assistant', content: [{ type: 'text', text }], timestamp: 9 }
      }
    })
  }
  unsubscribeBackgroundEvents()
  assert.deepEqual(backgroundEvents, [])

  provisionalRuntime.emit({
    type: 'pi-event',
    event: {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'A is written' }],
        timestamp: 10
      }
    }
  })
  await new Promise<void>((resolve) => setImmediate(resolve))

  assert.equal(kernel.getState().session.id, 'session-b')
  assert.deepEqual(persisted.map(({ sessionId }) => sessionId), ['session-b', 'provisional-a'])
  assert.equal(
    kernel.getState().sessions.find(({ id }) => id === 'provisional-a')?.runtimeStatus,
    'running'
  )
  await kernel.activateSession('/tmp/materialized-a.jsonl')
  assert.equal(kernel.getState().session.id, 'provisional-a')
  assert.equal(kernel.getState().session.resumeAvailable, true)
})

test('background provisional materialization preserves concurrent session metadata and emits once', async () => {
  const provisionalRuntime = new FakeRuntimeHost({
    sessionId: 'provisional-race-a',
    sessionFile: '/tmp/provisional-race-a.jsonl'
  })
  const foregroundRuntime = new FakeRuntimeHost({
    sessionId: 'provisional-race-b',
    sessionFile: '/tmp/provisional-race-b.jsonl'
  })
  const foregroundStats: PiRpcSessionStats = {
    sessionId: 'provisional-race-b',
    sessionFile: '/tmp/provisional-race-b.jsonl',
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 2,
    tokens: { input: 31, output: 17, cacheRead: 0, cacheWrite: 0, total: 48 },
    cost: 0.02
  }
  const provisionalStats: KernelSessionStatistics = {
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 2,
    inputTokens: 13,
    outputTokens: 8,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 21,
    cost: 0.01
  }
  let firstProvisionalValidation = true
  let metadataReadEntered!: () => void
  let releaseMetadataRead!: () => void
  const metadataReadStarted = new Promise<void>((resolve) => {
    metadataReadEntered = resolve
  })
  const metadataReadGate = new Promise<void>((resolve) => {
    releaseMetadataRead = resolve
  })
  const kernel = new WorkbenchKernel(
    (() => {
      const runtimes = [provisionalRuntime, foregroundRuntime]
      return () => {
        const runtime = runtimes.shift()
        assert.ok(runtime)
        return runtime
      }
    })(),
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(),
      validateSession: async (pointer) => {
        if (pointer.sessionId !== 'provisional-race-a') return pointer
        if (firstProvisionalValidation) {
          firstProvisionalValidation = false
          throw fileError('ENOENT', 'not written')
        }
        return { ...pointer, sessionFile: '/tmp/materialized-race-a.jsonl' }
      },
      readSessionActivityAt: async (pointer) => {
        if (pointer.sessionId === 'provisional-race-a') {
          metadataReadEntered()
          await metadataReadGate
        }
        return pointer.sessionId === 'provisional-race-a' ? 200 : 100
      },
      readSessionStatistics: async () => provisionalStats
    }
  )

  await kernel.start()
  await kernel.prompt('Materialize A without losing B metadata')
  await kernel.start()
  provisionalRuntime.emit({
    type: 'pi-event',
    event: {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'A is written' }],
        timestamp: 10
      }
    }
  })
  await metadataReadStarted

  foregroundRuntime.setSessionStats(foregroundStats)
  foregroundRuntime.emit({
    type: 'pi-event',
    event: {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'B updates while A waits' }],
        timestamp: 11,
        usage: { input: 31, output: 17, cacheRead: 0, cacheWrite: 0 }
      }
    }
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(
    kernel.getState().sessions.find(({ id }) => id === 'provisional-race-b')?.statistics?.totalTokens,
    48
  )

  const foregroundBefore = kernel.getState().conversation.entries
  const events: KernelEvent[] = []
  const unsubscribe = kernel.subscribe((event) => events.push(event))
  releaseMetadataRead()
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
  unsubscribe()

  const stateChanged = events.filter((event) => event.type === 'kernel.state-changed')
  assert.equal(stateChanged.length, 1)
  if (stateChanged[0]?.type === 'kernel.state-changed') {
    assert.equal(stateChanged[0].state.session.id, 'provisional-race-b')
    assert.deepEqual(stateChanged[0].state.conversation.entries, foregroundBefore)
  }
  const state = kernel.getState()
  assert.equal(
    state.sessions.find(({ id }) => id === 'provisional-race-b')?.statistics?.totalTokens,
    48
  )
  assert.equal(
    state.sessions.find(({ id }) => id === 'provisional-race-a')?.statistics?.totalTokens,
    21
  )
})

test('background provisional materialization failure emits one foreground navigation snapshot', async () => {
  const provisionalRuntime = new FakeRuntimeHost({
    sessionId: 'provisional-failure-a',
    sessionFile: '/tmp/provisional-failure-a.jsonl'
  })
  const foregroundRuntime = new FakeRuntimeHost({
    sessionId: 'provisional-failure-b',
    sessionFile: '/tmp/provisional-failure-b.jsonl'
  })
  let firstProvisionalValidation = true
  let resolveFailureAttempted!: () => void
  const failureAttempted = new Promise<void>((resolve) => {
    resolveFailureAttempted = resolve
  })
  const kernel = new WorkbenchKernel(
    (() => {
      const runtimes = [provisionalRuntime, foregroundRuntime]
      return () => {
        const runtime = runtimes.shift()
        assert.ok(runtime)
        return runtime
      }
    })(),
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(),
      validateSession: async (pointer) => {
        if (pointer.sessionId !== 'provisional-failure-a') return pointer
        if (firstProvisionalValidation) {
          firstProvisionalValidation = false
          throw fileError('ENOENT', 'not written')
        }
        resolveFailureAttempted()
        throw new Error('background provisional validation failed')
      },
      now: () => 100
    }
  )

  await kernel.start()
  await kernel.prompt('Fail materialization without replacing B')
  await kernel.start()
  const foregroundBefore = kernel.getState().conversation.entries
  const events: KernelEvent[] = []
  const unsubscribe = kernel.subscribe((event) => events.push(event))
  provisionalRuntime.emit({
    type: 'pi-event',
    event: {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'A fails to materialize' }],
        timestamp: 10
      }
    }
  })
  await failureAttempted
  await new Promise<void>((resolve) => setImmediate(resolve))
  unsubscribe()

  const stateChanged = events.filter((event) => event.type === 'kernel.state-changed')
  assert.equal(stateChanged.length, 1)
  if (stateChanged[0]?.type === 'kernel.state-changed') {
    assert.equal(stateChanged[0].state.session.id, 'provisional-failure-b')
    assert.deepEqual(stateChanged[0].state.conversation.entries, foregroundBefore)
  }
  assert.equal(kernel.getState().session.id, 'provisional-failure-b')
  assert.deepEqual(kernel.getState().conversation.entries, foregroundBefore)
  assert.equal(
    kernel.getState().sessions.some(({ id }) => id === 'provisional-failure-b'),
    true
  )
})

test('project trust choices gate runtime creation and separate persisted from one-shot decisions', async (t) => {
  const choices = [
    { choice: 'once-trusted' as const, override: true, persisted: [] },
    { choice: 'once-untrusted' as const, override: false, persisted: [] },
    { choice: 'persist-trusted' as const, override: undefined, persisted: [true] },
    { choice: 'persist-untrusted' as const, override: undefined, persisted: [false] }
  ]

  for (const scenario of choices) {
    await t.test(scenario.choice, async () => {
      const launchOptions: Array<{ sessionFile?: string, projectTrust?: boolean }> = []
      const persisted: boolean[] = []
      const runtime = new FakeRuntimeHost()
      const kernel = new WorkbenchKernel(
        (_project, options) => {
          launchOptions.push(options)
          return runtime
        },
        { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
        {
          ...kernelOptions(),
          projectTrust: {
            inspect: async () => ({ requiresDecision: true, decision: null }),
            persist: async (_path, decision) => {
              persisted.push(decision)
            }
          }
        }
      )

      const start = kernel.start()
      await new Promise<void>((resolve) => setImmediate(resolve))
      const request = kernel.getState().projectTrustRequest
      assert.ok(request)
      assert.equal(launchOptions.length, 0)
      await assert.rejects(
        kernel.resolveProjectTrust(`${request.id}-stale`, scenario.choice),
        /stale or mismatched/
      )
      await kernel.resolveProjectTrust(request.id, scenario.choice)
      await start

      assert.deepEqual(launchOptions, [
        scenario.override === undefined
          ? { subagent: DEFAULT_SUBAGENT_SETTINGS, fastExtensionLoading: false }
          : {
              projectTrust: scenario.override,
              subagent: DEFAULT_SUBAGENT_SETTINGS,
              fastExtensionLoading: false
            }
      ])
      assert.deepEqual(persisted, scenario.persisted)
      assert.equal(kernel.getState().projectTrustRequest, null)
    })
  }
})

test('persistent project trust decisions reject concurrent resolve and remain retryable after failure', async () => {
  let persistCalls = 0
  let releasePersistence!: () => void
  let rejectPersistence!: (error: Error) => void
  const persistenceGate = new Promise<void>((resolve, reject) => {
    releasePersistence = resolve
    rejectPersistence = reject
  })
  const launches: Array<{ sessionFile?: string, projectTrust?: boolean }> = []
  const kernel = new WorkbenchKernel(
    (_project, options) => {
      launches.push(options)
      return new FakeRuntimeHost()
    },
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(),
      projectTrust: {
        inspect: async () => ({ requiresDecision: true, decision: null }),
        persist: async () => {
          persistCalls += 1
          if (persistCalls === 1) await persistenceGate
        }
      }
    }
  )

  const start = kernel.start()
  await new Promise<void>((resolve) => setImmediate(resolve))
  const request = kernel.getState().projectTrustRequest
  assert.ok(request)
  const firstResolve = kernel.resolveProjectTrust(request.id, 'persist-trusted')
  await assert.rejects(
    kernel.resolveProjectTrust(request.id, 'persist-untrusted'),
    /persistence is already in progress/
  )
  assert.equal(persistCalls, 1)
  rejectPersistence(new Error('trust persistence failed'))
  await assert.rejects(firstResolve, /trust persistence failed/)
  assert.deepEqual(kernel.getState().projectTrustRequest, request)
  assert.deepEqual(launches, [])

  await kernel.resolveProjectTrust(request.id, 'persist-trusted')
  await start
  assert.equal(persistCalls, 2)
  assert.deepEqual(launches, [{
    subagent: DEFAULT_SUBAGENT_SETTINGS,
    fastExtensionLoading: false
  }])
  releasePersistence()
})

test('project trust cancel and stop cancel pending launches without creating a runtime', async (t) => {
  const createKernel = (): { kernel: WorkbenchKernel, createCalls: () => number } => {
    let calls = 0
    const kernel = new WorkbenchKernel(
      () => {
        calls += 1
        return new FakeRuntimeHost()
      },
      { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
      {
        ...kernelOptions(),
        projectTrust: {
          inspect: async () => ({ requiresDecision: true, decision: null }),
          persist: async () => {}
        }
      }
    )
    return { kernel, createCalls: () => calls }
  }

  await t.test('cancel choice', async () => {
    const { kernel, createCalls } = createKernel()
    const start = kernel.start()
    await new Promise<void>((resolve) => setImmediate(resolve))
    const request = kernel.getState().projectTrustRequest
    assert.ok(request)
    await kernel.resolveProjectTrust(request.id, 'cancel')
    await assert.rejects(start, /cancelled/)
    assert.equal(createCalls(), 0)
  })

  await t.test('stop', async () => {
    const { kernel, createCalls } = createKernel()
    const start = kernel.start()
    await new Promise<void>((resolve) => setImmediate(resolve))
    await kernel.stop()
    await assert.rejects(start, /cancelled/)
    assert.equal(createCalls(), 0)
    assert.equal(kernel.getState().projectTrustRequest, null)
  })
})

test('stored or inherited project trust decisions skip prompting and overrides', async () => {
  const launches: Array<{ sessionFile?: string, projectTrust?: boolean }> = []
  const kernel = new WorkbenchKernel(
    (_project, options) => {
      launches.push(options)
      return new FakeRuntimeHost()
    },
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(),
      projectTrust: {
        inspect: async () => ({ requiresDecision: true, decision: false }),
        persist: async () => {}
      }
    }
  )

  await kernel.start()
  assert.deepEqual(launches, [{
    subagent: DEFAULT_SUBAGENT_SETTINGS,
    fastExtensionLoading: false
  }])
  assert.equal(kernel.getState().projectTrustRequest, null)
})

test('reload replaces only the active settled persisted runtime after refreshing all projections', async () => {
  const pointerA: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/reload-a.jsonl',
    sessionId: 'reload-a',
    sessionName: 'Reload A'
  }
  const pointerB: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/reload-b.jsonl',
    sessionId: 'reload-b',
    sessionName: 'Reload B'
  }
  const runtimeA = new FakeRuntimeHost(
    {
      sessionId: pointerA.sessionId,
      sessionFile: pointerA.sessionFile,
      sessionName: pointerA.sessionName ?? undefined,
      model: { provider: 'openai', id: 'gpt-test' },
      thinkingLevel: 'low'
    },
    [{ role: 'assistant', content: [{ type: 'text', text: 'Old A' }], timestamp: 10 }]
  )
  const runtimeB = new FakeRuntimeHost({
    sessionId: pointerB.sessionId,
    sessionFile: pointerB.sessionFile,
    sessionName: pointerB.sessionName ?? undefined,
    model: { provider: 'anthropic', id: 'claude-test' }
  })
  const reloadedA = new FakeRuntimeHost(
    {
      sessionId: pointerA.sessionId,
      sessionFile: pointerA.sessionFile,
      sessionName: pointerA.sessionName ?? undefined,
      model: { provider: 'openai', id: 'gpt-test' },
      thinkingLevel: 'high'
    },
    [{ role: 'assistant', content: [{ type: 'text', text: 'Fresh A' }], timestamp: 20 }],
    [{
      name: 'fresh',
      source: 'extension',
      sourceInfo: { source: 'fresh-extension', scope: 'project', origin: 'top-level' }
    }],
    [{ id: 'fresh-model', provider: 'fresh-provider' }]
  )
  const runtimes = [runtimeA, runtimeB, reloadedA]
  const kernel = new WorkbenchKernel(
    () => {
      const runtime = runtimes.shift()
      assert.ok(runtime)
      return runtime
    },
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(),
      sessionRegistry: {
        sessions: [pointerA, pointerB],
        activeSessionKey: pointerA.sessionFile
      }
    }
  )

  await kernel.activateSession(pointerA.sessionFile)
  await kernel.activateSession(pointerB.sessionFile)
  await kernel.activateSession(pointerA.sessionFile)
  kernel.markProviderSessionsForReload('openai')
  assert.equal(
    kernel.getState().sessions.find(({ key }) => key === pointerA.sessionFile)?.requiresReload,
    true
  )
  assert.equal(
    kernel.getState().sessions.find(({ key }) => key === pointerB.sessionFile)?.requiresReload,
    undefined
  )
  assert.equal(runtimeA.stopCalls, 0)
  assert.equal(runtimeB.stopCalls, 0)
  assert.ok(kernel.getState().commands.some(({ id }) => id === RELOAD_SESSION_COMMAND_ID))
  await assert.rejects(
    kernel.invokeCommand(RELOAD_SESSION_COMMAND_ID, 'unexpected'),
    /does not accept arguments/
  )
  await kernel.invokeCommand(RELOAD_SESSION_COMMAND_ID, '')

  const state = kernel.getState()
  assert.equal(runtimeA.stopCalls, 1)
  assert.equal(runtimeB.stopCalls, 0)
  assert.equal(reloadedA.startCalls, 1)
  assert.equal(state.activeSessionKey, pointerA.sessionFile)
  assert.equal(
    state.sessions.find(({ key }) => key === pointerA.sessionFile)?.requiresReload,
    undefined
  )
  assert.equal(state.session.id, pointerA.sessionId)
  assert.equal(state.session.thinkingLevel, 'high')
  assert.equal(state.availableModels[0]?.id, 'fresh-model')
  assert.ok(state.commands.some(({ name }) => name === 'fresh'))
  const entry = state.conversation.entries[0]
  assert.equal(entry?.kind === 'message' ? entry.text : null, 'Fresh A')
  assert.deepEqual(
    reloadedA.commands.slice(0, 5).map(({ type }) => type),
    ['get_state', 'get_messages', 'get_commands', 'get_entries', 'get_available_models']
  )
})

test('reload gates unavailable states and preserves conversation and pointer on refresh failure', async () => {
  const pointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/reload-failure.jsonl',
    sessionId: 'reload-failure',
    sessionName: 'Reload failure'
  }
  const oldRuntime = new FakeRuntimeHost(
    {
      sessionId: pointer.sessionId,
      sessionFile: pointer.sessionFile,
      sessionName: pointer.sessionName ?? undefined,
      model: { provider: 'openai', id: 'gpt-test' }
    },
    [{ role: 'assistant', content: [{ type: 'text', text: 'Keep me' }], timestamp: 10 }]
  )
  const failedRuntime = new FailingCommandRuntimeHost(
    'get_commands',
    {
      sessionId: pointer.sessionId,
      sessionFile: pointer.sessionFile,
      sessionName: pointer.sessionName ?? undefined,
      model: { provider: 'openai', id: 'gpt-test' }
    },
    [{ role: 'assistant', content: [{ type: 'text', text: 'Do not commit' }], timestamp: 20 }]
  )
  const runtimes = [oldRuntime, failedRuntime]
  const kernel = new WorkbenchKernel(
    () => {
      const runtime = runtimes.shift()
      assert.ok(runtime)
      return runtime
    },
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions(pointer)
  )

  assert.equal(kernel.getState().commands.some(({ id }) => id === RELOAD_SESSION_COMMAND_ID), false)
  await assert.rejects(kernel.reloadSession(), /Runtime must be ready/)
  await kernel.resumeSession()
  kernel.markProviderSessionsForReload('openai')
  const before = kernel.getState()
  await assert.rejects(kernel.reloadSession(), /get_commands failed/)

  const after = kernel.getState()
  assert.equal(after.runtime.status, 'crashed')
  assert.equal(after.activeSessionKey, pointer.sessionFile)
  assert.equal(after.session.id, pointer.sessionId)
  assert.equal(after.sessions[0]?.requiresReload, true)
  assert.deepEqual(after.conversation, before.conversation)
  assert.equal(oldRuntime.stopCalls, 1)
  assert.equal(failedRuntime.stopCalls, 1)
  await assert.rejects(kernel.invokeCommand(RELOAD_SESSION_COMMAND_ID, 'unexpected'), /not available|arguments/)
})

test('reload rechecks readiness inside the launch critical task before replacing the runtime', async () => {
  const pointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/reload-race.jsonl',
    sessionId: 'reload-race',
    sessionName: 'Reload race'
  }
  const runtime = new FakeRuntimeHost({
    sessionId: pointer.sessionId,
    sessionFile: pointer.sessionFile,
    sessionName: pointer.sessionName ?? undefined
  })
  let createCalls = 0
  const kernel = new WorkbenchKernel(
    () => {
      createCalls += 1
      return runtime
    },
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions(pointer)
  )
  await kernel.resumeSession()

  const reload = kernel.reloadSession()
  runtime.emit({ type: 'activity-started' })
  await assert.rejects(reload, /Runtime must be ready/)

  assert.equal(createCalls, 1)
  assert.equal(runtime.stopCalls, 0)
  assert.equal(kernel.getState().runtime.status, 'running')
  assert.equal(kernel.getState().session.settled, false)
  assert.equal(kernel.getState().activeSessionKey, pointer.sessionFile)
})

test('reload rejects unsettled and provisional ready sessions before replacing a runtime', async (t) => {
  await t.test('unsettled persisted session', async () => {
    const pointer: SessionPointer = {
      projectPath: '/tmp/project',
      sessionFile: '/tmp/reload-unsettled.jsonl',
      sessionId: 'reload-unsettled',
      sessionName: null
    }
    const runtime = new FakeRuntimeHost({
      sessionId: pointer.sessionId,
      sessionFile: pointer.sessionFile,
      isStreaming: true
    })
    let createCalls = 0
    const kernel = new WorkbenchKernel(
      () => {
        createCalls += 1
        return runtime
      },
      { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
      kernelOptions(pointer)
    )
    await kernel.resumeSession()
    assert.equal(kernel.getState().runtime.status, 'ready')
    assert.equal(kernel.getState().session.settled, false)
    await assert.rejects(kernel.reloadSession(), /must be settled/)
    assert.equal(createCalls, 1)
    assert.equal(runtime.stopCalls, 0)
  })

  await t.test('provisional session', async () => {
    const runtime = new FakeRuntimeHost({
      sessionId: 'reload-provisional',
      sessionFile: '/tmp/reload-provisional.jsonl'
    })
    let createCalls = 0
    const kernel = new WorkbenchKernel(
      () => {
        createCalls += 1
        return runtime
      },
      { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
      {
        ...kernelOptions(),
        validateSession: async () => {
          throw fileError('ENOENT', 'not written yet')
        }
      }
    )
    await kernel.start()
    assert.equal(kernel.getState().runtime.status, 'ready')
    assert.equal(kernel.getState().activeSessionKey, '/tmp/reload-provisional.jsonl')
    assert.equal(kernel.getState().sessions[0]?.provisional, true)
    assert.equal(kernel.getState().commands.some(({ id }) => id === RELOAD_SESSION_COMMAND_ID), false)
    await assert.rejects(kernel.reloadSession(), /active persisted session/)
    assert.equal(createCalls, 1)
    assert.equal(runtime.stopCalls, 0)
  })
})

test('fork candidates follow the active entry path and fork migrates the same runtime', async () => {
  const original: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/original-session.jsonl',
    sessionId: 'original-session',
    sessionName: 'Original'
  }
  const forked: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/forked-session.jsonl',
    sessionId: 'forked-session',
    sessionName: 'Forked'
  }
  const entries: PiRpcSessionEntry[] = [
    {
      id: 'user-root',
      parentId: null,
      type: 'message',
      timestamp: '2026-07-24T01:00:00.000Z',
      message: { role: 'user', content: { text: 'Root prompt', hasImage: false } }
    },
    {
      id: 'assistant-root',
      parentId: 'user-root',
      type: 'message',
      timestamp: '2026-07-24T01:00:01.000Z',
      message: { role: 'assistant' }
    },
    {
      id: 'abandoned-user',
      parentId: 'assistant-root',
      type: 'message',
      timestamp: '2026-07-24T01:00:02.000Z',
      message: { role: 'user', content: { text: 'Abandoned', hasImage: false } }
    },
    {
      id: 'image-user',
      parentId: 'assistant-root',
      type: 'message',
      timestamp: '2026-07-24T01:00:03.000Z',
      message: { role: 'user', content: { text: 'Image prompt', hasImage: true } }
    },
    {
      id: 'selected-user',
      parentId: 'image-user',
      type: 'message',
      timestamp: '2026-07-24T01:00:04.000Z',
      message: { role: 'user', content: { text: 'Selected prompt', hasImage: false } }
    },
    {
      id: 'leaf',
      parentId: 'selected-user',
      type: 'message',
      timestamp: '2026-07-24T01:00:05.000Z',
      message: { role: 'assistant' }
    }
  ]
  const runtime = new ForkingRuntimeHost(
    {
      sessionId: original.sessionId,
      sessionFile: original.sessionFile,
      sessionName: original.sessionName ?? undefined,
      isStreaming: false
    },
    [{ role: 'assistant', content: [{ type: 'text', text: 'Original history' }], timestamp: 1 }],
    entries,
    'leaf',
    {
      sessionId: forked.sessionId,
      sessionFile: forked.sessionFile,
      sessionName: forked.sessionName ?? undefined,
      isStreaming: false
    },
    [
      { role: 'user', content: [{ type: 'text', text: 'Selected prompt' }], timestamp: 2 },
      { role: 'assistant', content: [{ type: 'text', text: 'Forked history' }], timestamp: 3 }
    ]
  )
  const persisted: SessionPointer[] = []
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions(original, persisted)
  )
  await kernel.activateSession(original.sessionFile)

  assert.deepEqual(await kernel.listForkCandidates(), [
    {
      entryId: 'user-root',
      text: 'Root prompt',
      timestamp: '2026-07-24T01:00:00.000Z'
    },
    {
      entryId: 'selected-user',
      text: 'Selected prompt',
      timestamp: '2026-07-24T01:00:04.000Z'
    }
  ])
  const unsubscribeThrowingListener = kernel.subscribe(() => {
    throw new Error('observer failed after commit')
  })
  assert.deepEqual(
    await kernel.forkSession('selected-user'),
    { draft: 'Selected prompt', cancelled: false }
  )
  unsubscribeThrowingListener()

  const state = kernel.getState()
  const finalEntry = state.conversation.entries.at(-1)
  assert.equal(runtime.startCalls, 1)
  assert.equal(runtime.stopCalls, 0)
  assert.equal(state.activeSessionKey, forked.sessionFile)
  assert.deepEqual(state.sessions.map(({ key }) => key), [original.sessionFile, forked.sessionFile])
  assert.equal(state.session.id, forked.sessionId)
  assert.equal(finalEntry?.kind === 'message' ? finalEntry.text : null, 'Forked history')
  assert.deepEqual(persisted.at(-1), forked)
  assert.deepEqual(
    runtime.commands.filter(({ type }) => type === 'get_entries' || type === 'fork'),
    [
      { type: 'get_entries' },
      { type: 'get_entries' },
      { type: 'get_entries' },
      { type: 'fork', entryId: 'selected-user' },
      { type: 'get_entries' }
    ]
  )
})

test('fork buffers runtime events across persisted identity commit and replays them on the fork', async () => {
  const original: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/fork-buffer-original.jsonl',
    sessionId: 'fork-buffer-original',
    sessionName: 'Original'
  }
  const forked: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/fork-buffer-result.jsonl',
    sessionId: 'fork-buffer-result',
    sessionName: 'Forked'
  }
  const entries: PiRpcSessionEntry[] = [{
    id: 'selected-user',
    parentId: null,
    type: 'message',
    timestamp: '2026-07-24T01:00:00.000Z',
    message: { role: 'user', content: { text: 'Selected prompt', hasImage: false } }
  }]
  const runtime = new ForkingRuntimeHost(
    {
      sessionId: original.sessionId,
      sessionFile: original.sessionFile,
      sessionName: original.sessionName ?? undefined,
      isStreaming: false
    },
    [{ role: 'assistant', content: [{ type: 'text', text: 'Original' }], timestamp: 1 }],
    entries,
    'selected-user',
    {
      sessionId: forked.sessionId,
      sessionFile: forked.sessionFile,
      sessionName: forked.sessionName ?? undefined,
      isStreaming: false
    },
    [{ role: 'assistant', content: [{ type: 'text', text: 'Forked' }], timestamp: 2 }]
  )
  let resolvePersistEntered!: () => void
  let releasePersist!: () => void
  const persistEntered = new Promise<void>((resolve) => {
    resolvePersistEntered = resolve
  })
  const persistGate = new Promise<void>((resolve) => {
    releasePersist = resolve
  })
  const persisted: SessionPointer[] = []
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(original, persisted),
      persistSession: async (pointer) => {
        if (pointer.sessionId === forked.sessionId) {
          resolvePersistEntered()
          await persistGate
        }
        persisted.push({ ...pointer })
      }
    }
  )
  await kernel.activateSession(original.sessionFile)

  const lifecycleEvents: KernelEvent[] = []
  let reentered = false
  kernel.subscribe(() => {
    throw new Error('observer failure must stay outside the Kernel state machine')
  })
  kernel.subscribe((event) => {
    if (
      event.type !== 'kernel.compaction-started' &&
      event.type !== 'kernel.compaction-ended'
    ) return
    lifecycleEvents.push(event)
    if (event.type === 'kernel.compaction-started' && event.reason === 'manual' && !reentered) {
      reentered = true
      runtime.emit({ type: 'pi-event', event: { type: 'compaction_start', reason: 'threshold' } })
      runtime.emit({
        type: 'pi-event',
        event: {
          type: 'compaction_end',
          reason: 'threshold',
          result: null,
          aborted: true,
          willRetry: false
        }
      })
    }
  })
  const forkPromise = kernel.forkSession('selected-user')
  await persistEntered

  runtime.emit({ type: 'pi-event', event: { type: 'compaction_start', reason: 'manual' } })
  runtime.emit({
    type: 'pi-event',
    event: {
      type: 'compaction_end',
      reason: 'manual',
      result: null,
      aborted: true,
      willRetry: false
    }
  })
  assert.equal(kernel.getState().activeSessionKey, original.sessionFile)
  assert.equal(kernel.getState().session.compaction, null)

  releasePersist()
  assert.deepEqual(await forkPromise, { draft: 'Selected prompt', cancelled: false })
  assert.equal(kernel.getState().activeSessionKey, forked.sessionFile)
  assert.equal(kernel.getState().session.id, forked.sessionId)
  assert.equal(kernel.getState().session.compaction, null)
  assert.deepEqual(lifecycleEvents, [
    {
      type: 'kernel.compaction-started',
      projectKey: '/tmp/project',
      sessionKey: forked.sessionFile,
      reason: 'manual'
    },
    {
      type: 'kernel.compaction-ended',
      projectKey: '/tmp/project',
      sessionKey: forked.sessionFile,
      reason: 'manual',
      outcome: 'cancelled',
      willRetry: false
    },
    {
      type: 'kernel.compaction-started',
      projectKey: '/tmp/project',
      sessionKey: forked.sessionFile,
      reason: 'threshold'
    },
    {
      type: 'kernel.compaction-ended',
      projectKey: '/tmp/project',
      sessionKey: forked.sessionFile,
      reason: 'threshold',
      outcome: 'cancelled',
      willRetry: false
    }
  ])
  assert.equal(persisted.some(({ sessionId }) => sessionId === forked.sessionId), true)
})

test('failed post-fork projection stops the rebound runtime and preserves old identity', async () => {
  const pointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/original-session.jsonl',
    sessionId: 'original-session',
    sessionName: 'Original'
  }
  const runtime = new ForkingRuntimeHost(
    {
      sessionId: pointer.sessionId,
      sessionFile: pointer.sessionFile,
      sessionName: pointer.sessionName ?? undefined,
      isStreaming: false
    },
    [{ role: 'assistant', content: [{ type: 'text', text: 'Original history' }], timestamp: 1 }],
    [{
      id: 'selected-user',
      parentId: null,
      type: 'message',
      timestamp: '2026-07-24T01:00:00.000Z',
      message: { role: 'user', content: { text: 'Selected prompt', hasImage: false } }
    }],
    'selected-user',
    {
      sessionId: 'forked-session',
      sessionFile: '/tmp/forked-session.jsonl',
      isStreaming: false
    },
    [],
    true
  )
  const persisted: SessionPointer[] = []
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions(pointer, persisted)
  )
  await kernel.activateSession(pointer.sessionFile)

  const unsubscribeThrowingListener = kernel.subscribe(() => {
    throw new Error('observer must not interrupt failed-fork cleanup')
  })
  await assert.rejects(kernel.forkSession('selected-user'), /forked messages unavailable/)
  unsubscribeThrowingListener()

  const state = kernel.getState()
  const firstEntry = state.conversation.entries[0]
  assert.equal(runtime.stopCalls, 1)
  assert.equal(state.runtime.status, 'crashed')
  assert.equal(state.activeSessionKey, pointer.sessionFile)
  assert.equal(state.session.id, pointer.sessionId)
  assert.equal(firstEntry?.kind === 'message' ? firstEntry.text : null, 'Original history')
  assert.equal(state.sessions.some(({ key }) => key === '/tmp/forked-session.jsonl'), false)
  assert.equal(persisted.some(({ sessionId }) => sessionId === 'forked-session'), false)
})

test('archive undo credentials are independent, monotonic, and single-use', async () => {
  const pointers: SessionPointer[] = ['active', 'older', 'later'].map((name) => ({
    projectPath: '/tmp/project',
    sessionFile: `/tmp/${name}.jsonl`,
    sessionId: name,
    sessionName: name
  }))
  const [active, older, later] = pointers
  assert.ok(active && older && later)
  const archived = new Set<string>()
  let now = 10
  const kernel = new WorkbenchKernel(
    () => new FakeRuntimeHost(),
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(),
      sessionRegistry: { sessions: pointers, activeSessionKey: active.sessionFile },
      persistArchivedSession: async (_projectPath, sessionKey) => {
        archived.add(sessionKey)
      },
      restoreArchivedSession: async (_projectPath, sessionKey) => {
        if (!archived.delete(sessionKey)) throw new Error('not archived')
        return {
          sessions: pointers.filter((pointer) => !archived.has(pointer.sessionFile)),
          activeSessionKey: active.sessionFile
        }
      },
      now: () => now
    }
  )

  const olderReceipt = await kernel.archiveSession(older.sessionFile)
  now += 1_000
  const laterReceipt = await kernel.archiveSession(later.sessionFile)
  assert.notEqual(olderReceipt.token, laterReceipt.token)
  assert.equal(olderReceipt.durationMs, 5_000)

  now = 5_010
  await assert.rejects(kernel.undoArchiveSession(olderReceipt.token), /expired/)
  await kernel.undoArchiveSession(laterReceipt.token)
  assert.deepEqual(
    kernel.getState().sessions.map(({ key }) => key),
    [active.sessionFile, later.sessionFile]
  )
  assert.equal(archived.has(older.sessionFile), true)
  await assert.rejects(kernel.undoArchiveSession(laterReceipt.token), /invalid or already used/)
})

test('archived preview is runtime-free, expiring, and consumes its credential', async () => {
  const pointers: SessionPointer[] = ['active', 'preview', 'expired'].map((name) => ({
    projectPath: '/tmp/project',
    sessionFile: `/tmp/${name}.jsonl`,
    sessionId: name,
    sessionName: name
  }))
  const [active, previewPointer, expired] = pointers
  assert.ok(active && previewPointer && expired)
  let createCalls = 0
  let readCalls = 0
  let now = 0
  const kernel = new WorkbenchKernel(
    () => {
      createCalls += 1
      return new FakeRuntimeHost()
    },
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(),
      sessionRegistry: { sessions: pointers, activeSessionKey: active.sessionFile },
      readSessionMessages: async () => {
        readCalls += 1
        return [{
          role: 'assistant',
          content: [{ type: 'text', text: 'Archived history' }],
          timestamp: 1
        }]
      },
      now: () => now
    }
  )

  const previewReceipt = await kernel.archiveSession(previewPointer.sessionFile)
  const preview = await kernel.previewArchivedSession(previewReceipt.token)
  const previewEntry = preview.conversation.entries[0]
  assert.equal(createCalls, 0)
  assert.equal(readCalls, 1)
  assert.equal(preview.sessionKey, previewPointer.sessionFile)
  assert.equal(previewEntry?.kind === 'message' ? previewEntry.text : null, 'Archived history')
  assert.equal(kernel.getState().sessions.some(({ key }) => key === previewPointer.sessionFile), false)
  await assert.rejects(kernel.previewArchivedSession(previewReceipt.token), /invalid or already used/)
  await assert.rejects(kernel.undoArchiveSession(previewReceipt.token), /invalid or already used/)

  const expiredReceipt = await kernel.archiveSession(expired.sessionFile)
  now = 5_000
  await assert.rejects(kernel.previewArchivedSession(expiredReceipt.token), /expired/)
  assert.equal(readCalls, 1)
})

test('getState conversation entries are defensive copies of kernel-owned state', async () => {
  const runtime = new FakeRuntimeHost(
    undefined,
    [{
      role: 'assistant',
      content: [{ type: 'text', text: 'Owned text' }],
      timestamp: 1
    }]
  )
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions()
  )
  await kernel.start()
  runtime.emit({
    type: 'pi-event',
    event: {
      type: 'tool_execution_start',
      toolCallId: 'tool-1',
      toolName: 'read',
      args: { path: 'package.json' }
    }
  })
  runtime.emit({
    type: 'pi-event',
    event: {
      type: 'tool_execution_end',
      toolCallId: 'tool-1',
      toolName: 'read',
      result: { content: [{ type: 'text', text: 'ok' }] },
      isError: false
    }
  })
  runtime.emit({
    type: 'pi-event',
    event: {
      type: 'tool_execution_start',
      toolCallId: 'subagent-1',
      toolName: 'subagent',
      args: { agent: 'reviewer', task: 'Review ownership' }
    }
  })
  runtime.emit({
    type: 'pi-event',
    event: {
      type: 'tool_execution_update',
      toolCallId: 'subagent-1',
      toolName: 'subagent',
      args: { agent: 'reviewer', task: 'Review ownership' },
      partialResult: {
        content: [{ type: 'text', text: 'working' }],
        details: {
          mode: 'single',
          runId: 'run-1',
          progress: [{
            index: 0,
            agent: 'reviewer',
            task: 'Review ownership',
            status: 'running',
            currentTool: 'read',
            toolCount: 1,
            turnCount: 1,
            tokens: 100,
            durationMs: 500
          }]
        }
      }
    }
  })

  const snapshot = kernel.getState()
  const message = snapshot.conversation.entries.find((entry) => entry.kind === 'message')
  const tool = snapshot.conversation.entries.find(
    (entry) => entry.kind === 'tool' && entry.name === 'read'
  )
  const subagentTool = snapshot.conversation.entries.find(
    (entry) => entry.kind === 'tool' && entry.name === 'subagent'
  )
  assert.ok(message && message.kind === 'message')
  assert.ok(tool && tool.kind === 'tool')
  assert.ok(subagentTool && subagentTool.kind === 'tool')
  const participant = subagentTool.subagent?.participants[0]
  assert.ok(participant)
  message.text = 'mutated externally'
  tool.output = 'mutated tool output'
  tool.details = 'mutated details'
  participant.currentTool = 'mutated externally'

  const next = kernel.getState()
  const nextMessage = next.conversation.entries.find((entry) => entry.kind === 'message')
  const nextTool = next.conversation.entries.find(
    (entry) => entry.kind === 'tool' && entry.name === 'read'
  )
  const nextSubagentTool = next.conversation.entries.find(
    (entry) => entry.kind === 'tool' && entry.name === 'subagent'
  )
  assert.equal(nextMessage?.kind === 'message' ? nextMessage.text : null, 'Owned text')
  assert.equal(nextTool?.kind === 'tool' ? nextTool.output : null, 'ok')
  assert.notEqual(nextTool?.kind === 'tool' ? nextTool.details : null, 'mutated details')
  assert.equal(
    nextSubagentTool?.kind === 'tool'
      ? nextSubagentTool.subagent?.participants[0]?.currentTool
      : null,
    'read'
  )
})

test('background compaction with unchanged stats emits lifecycle only', async () => {
  const pointerA: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/stage1-compaction-a.jsonl',
    sessionId: 'stage1-compaction-a',
    sessionName: 'A'
  }
  const pointerB: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/stage1-compaction-b.jsonl',
    sessionId: 'stage1-compaction-b',
    sessionName: 'B'
  }
  const sharedStats: PiRpcSessionStats = {
    sessionId: pointerA.sessionId,
    sessionFile: pointerA.sessionFile,
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 2,
    tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
    cost: 0
  }
  const runtimeA = new FakeRuntimeHost(
    { sessionId: pointerA.sessionId, sessionFile: pointerA.sessionFile },
    [{ role: 'assistant', content: [{ type: 'text', text: 'Old A' }], timestamp: 1 }],
    [],
    undefined,
    sharedStats
  )
  const runtimeB = new FakeRuntimeHost(
    { sessionId: pointerB.sessionId, sessionFile: pointerB.sessionFile },
    [{ role: 'assistant', content: [{ type: 'text', text: 'Foreground B' }], timestamp: 2 }]
  )
  const runtimes = [runtimeA, runtimeB]
  const kernel = new WorkbenchKernel(
    () => {
      const runtime = runtimes.shift()
      assert.ok(runtime)
      return runtime
    },
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(),
      sessionRegistry: {
        sessions: [pointerA, pointerB],
        activeSessionKey: pointerA.sessionFile
      }
    }
  )

  await kernel.activateSession(pointerA.sessionFile)
  // Seed summary statistics so a later identical refresh is a navigation no-op.
  runtimeA.emit({
    type: 'pi-event',
    event: {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Old A' }],
        timestamp: 1,
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }
      }
    }
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  await kernel.activateSession(pointerB.sessionFile)

  const foregroundBefore = kernel.getState().conversation.entries
  const events: KernelEvent[] = []
  const unsubscribe = kernel.subscribe((event) => events.push(event))
  runtimeA.replaceMessages([
    { role: 'assistant', content: [{ type: 'text', text: 'Compacted A' }], timestamp: 3 }
  ])
  // Same stats as already stored for A: navigation projection must not change.
  runtimeA.setSessionStats(sharedStats)

  const completed = waitForCompactionOutcome(kernel, 'completed')
  runtimeA.emit({ type: 'pi-event', event: { type: 'compaction_start', reason: 'manual' } })
  runtimeA.emit({
    type: 'pi-event',
    event: {
      type: 'compaction_end',
      reason: 'manual',
      result: { summary: 'Compacted', firstKeptEntryId: 'kept', tokensBefore: 100 },
      aborted: false,
      willRetry: false
    }
  })
  await completed
  unsubscribe()

  const stateChanged = events.filter((event) => event.type === 'kernel.state-changed')
  const statePatched = events.filter((event) => event.type === 'kernel.state-patched')
  const lifecycle = events.filter((event) => event.type === 'kernel.compaction-ended')
  assert.equal(stateChanged.length, 0)
  assert.equal(statePatched.length, 0)
  assert.equal(lifecycle.length, 1)
  assert.deepEqual(kernel.getState().conversation.entries, foregroundBefore)
  assert.equal(kernel.getState().session.id, pointerB.sessionId)

  await kernel.activateSession(pointerA.sessionFile)
  const entry = kernel.getState().conversation.entries[0]
  assert.equal(entry?.kind === 'message' ? entry.text : null, 'Compacted A')
})

test('background compaction with changed stats emits exactly one state snapshot', async () => {
  const pointerA: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/stage1-stats-a.jsonl',
    sessionId: 'stage1-stats-a',
    sessionName: 'A'
  }
  const pointerB: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/stage1-stats-b.jsonl',
    sessionId: 'stage1-stats-b',
    sessionName: 'B'
  }
  const runtimeA = new FakeRuntimeHost(
    { sessionId: pointerA.sessionId, sessionFile: pointerA.sessionFile },
    [{ role: 'assistant', content: [{ type: 'text', text: 'Old A' }], timestamp: 1 }]
  )
  const runtimeB = new FakeRuntimeHost(
    { sessionId: pointerB.sessionId, sessionFile: pointerB.sessionFile },
    [{ role: 'assistant', content: [{ type: 'text', text: 'Foreground B' }], timestamp: 2 }]
  )
  const runtimes = [runtimeA, runtimeB]
  const kernel = new WorkbenchKernel(
    () => {
      const runtime = runtimes.shift()
      assert.ok(runtime)
      return runtime
    },
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(),
      sessionRegistry: {
        sessions: [pointerA, pointerB],
        activeSessionKey: pointerA.sessionFile
      }
    }
  )

  await kernel.activateSession(pointerA.sessionFile)
  await kernel.activateSession(pointerB.sessionFile)
  const foregroundBefore = kernel.getState().conversation.entries
  const events: KernelEvent[] = []
  const unsubscribe = kernel.subscribe((event) => events.push(event))
  runtimeA.replaceMessages([
    { role: 'assistant', content: [{ type: 'text', text: 'Compacted A' }], timestamp: 3 }
  ])
  runtimeA.setSessionStats({
    sessionId: pointerA.sessionId,
    sessionFile: pointerA.sessionFile,
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 2,
    tokens: { input: 40, output: 20, cacheRead: 0, cacheWrite: 0, total: 60 },
    cost: 0.1
  })

  const completed = waitForCompactionOutcome(kernel, 'completed')
  runtimeA.emit({ type: 'pi-event', event: { type: 'compaction_start', reason: 'manual' } })
  runtimeA.emit({
    type: 'pi-event',
    event: {
      type: 'compaction_end',
      reason: 'manual',
      result: { summary: 'Compacted', firstKeptEntryId: 'kept', tokensBefore: 100 },
      aborted: false,
      willRetry: false
    }
  })
  await completed
  unsubscribe()

  const stateChanged = events.filter((event) => event.type === 'kernel.state-changed')
  assert.equal(stateChanged.length, 1)
  assert.equal(stateChanged[0]?.type, 'kernel.state-changed')
  if (stateChanged[0]?.type === 'kernel.state-changed') {
    assert.equal(stateChanged[0].state.session.id, pointerB.sessionId)
    assert.deepEqual(stateChanged[0].state.conversation.entries, foregroundBefore)
    assert.equal(
      stateChanged[0].state.sessions.find(({ id }) => id === pointerA.sessionId)?.statistics?.totalTokens,
      60
    )
  }
  assert.deepEqual(kernel.getState().conversation.entries, foregroundBefore)
})

test('background compaction projection failure emits lifecycle only', async () => {
  const pointerA: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/session-1.jsonl',
    sessionId: 'session-1',
    sessionName: 'A'
  }
  const pointerB: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/stage1-compaction-failure-b.jsonl',
    sessionId: 'stage1-compaction-failure-b',
    sessionName: 'B'
  }
  const runtimeA = new CompactingRuntimeHost(
    [{ role: 'assistant', content: [{ type: 'text', text: 'Old A' }], timestamp: 1 }],
    [{ role: 'assistant', content: [{ type: 'text', text: 'Compacted A' }], timestamp: 3 }]
  )
  const runtimeB = new FakeRuntimeHost(
    { sessionId: pointerB.sessionId, sessionFile: pointerB.sessionFile },
    [{ role: 'assistant', content: [{ type: 'text', text: 'Foreground B' }], timestamp: 2 }]
  )
  const runtimes = [runtimeA, runtimeB]
  const kernel = new WorkbenchKernel(
    () => {
      const runtime = runtimes.shift()
      assert.ok(runtime)
      return runtime
    },
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(),
      sessionRegistry: {
        sessions: [pointerA, pointerB],
        activeSessionKey: pointerA.sessionFile
      }
    }
  )

  await kernel.activateSession(pointerA.sessionFile)
  await kernel.activateSession(pointerB.sessionFile)
  const foregroundBefore = kernel.getState().conversation.entries
  const events: KernelEvent[] = []
  const unsubscribe = kernel.subscribe((event) => events.push(event))
  runtimeA.failNextCompactedProjection()
  const failed = waitForCompactionOutcome(kernel, 'failed')
  runtimeA.emit({ type: 'pi-event', event: { type: 'compaction_start', reason: 'manual' } })
  runtimeA.emit({
    type: 'pi-event',
    event: {
      type: 'compaction_end',
      reason: 'manual',
      result: { summary: 'Compacted', firstKeptEntryId: 'kept', tokensBefore: 100 },
      aborted: false,
      willRetry: false
    }
  })
  const outcome = await failed
  unsubscribe()

  assert.equal(outcome.outcome, 'failed')
  assert.equal(events.filter((event) => event.type === 'kernel.state-changed').length, 0)
  assert.equal(events.filter((event) => event.type === 'kernel.state-patched').length, 0)
  assert.equal(
    events.filter(
      (event) => event.type === 'kernel.compaction-ended' && event.outcome === 'failed'
    ).length,
    1
  )
  assert.equal(kernel.getState().session.id, pointerB.sessionId)
  assert.deepEqual(kernel.getState().conversation.entries, foregroundBefore)

  await kernel.activateSession(pointerA.sessionFile)
  const entry = kernel.getState().conversation.entries[0]
  assert.equal(entry?.kind === 'message' ? entry.text : null, 'Old A')
  assert.equal(kernel.getState().session.compaction, null)
})

test('background automatic naming emits exactly one navigation state snapshot', async () => {
  const pointerA: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/stage1-name-a.jsonl',
    sessionId: 'stage1-name-a',
    sessionName: null
  }
  const pointerB: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/stage1-name-b.jsonl',
    sessionId: 'stage1-name-b',
    sessionName: 'Foreground B'
  }
  const runtimeA = new FakeRuntimeHost(
    {
      sessionId: pointerA.sessionId,
      sessionFile: pointerA.sessionFile,
      model: { provider: 'openai', id: 'gpt-purpose' }
    },
    [
      { role: 'user', content: [{ type: 'text', text: 'Name this session' }], timestamp: 1 },
      { role: 'assistant', content: [{ type: 'text', text: 'Naming now' }], timestamp: 2 }
    ]
  )
  const runtimeB = new FakeRuntimeHost({
    sessionId: pointerB.sessionId,
    sessionFile: pointerB.sessionFile,
    sessionName: pointerB.sessionName ?? undefined
  })
  const runtimes = [runtimeA, runtimeB]
  let resolveName!: (value: string) => void
  const namePromise = new Promise<string>((resolve) => {
    resolveName = resolve
  })
  let generationStarted = false
  const persisted: SessionPointer[] = []
  let observeNamePersistence = (): void => {}
  const kernel = new WorkbenchKernel(
    () => {
      const runtime = runtimes.shift()
      assert.ok(runtime)
      return runtime
    },
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(null, persisted, [], [], async () => {
        generationStarted = true
        return namePromise
      }),
      persistSession: async (pointer) => {
        observeNamePersistence()
        persisted.push({ ...pointer })
      },
      sessionRegistry: {
        sessions: [pointerA, pointerB],
        activeSessionKey: pointerA.sessionFile
      }
    }
  )

  await kernel.activateSession(pointerA.sessionFile)
  assert.equal(generationStarted, true)
  await kernel.activateSession(pointerB.sessionFile)

  const foregroundBefore = kernel.getState().conversation.entries
  const spies = installStage2BStructuralSpies(kernel)
  observeNamePersistence = () => {
    assert.equal(kernel.getState().session.id, pointerB.sessionId)
  }
  const events: KernelEvent[] = []
  const unsubscribe = kernel.subscribe((event) => events.push(event))
  try {
    resolveName('Generated A')
    await new Promise<void>((resolve) => setImmediate(resolve))
    await new Promise<void>((resolve) => setImmediate(resolve))
  } finally {
    unsubscribe()
    spies.restore()
  }

  assert.equal(spies.loadContextCalls(), 0)
  assert.equal(spies.suppressWrites(), 0)
  const stateChanged = events.filter((event) => event.type === 'kernel.state-changed')
  assert.equal(stateChanged.length, 1)
  if (stateChanged[0]?.type === 'kernel.state-changed') {
    assert.equal(stateChanged[0].state.session.id, pointerB.sessionId)
    assert.deepEqual(stateChanged[0].state.conversation.entries, foregroundBefore)
    assert.equal(
      stateChanged[0].state.sessions.find(({ id }) => id === pointerA.sessionId)?.name,
      'Generated A'
    )
  }
  assert.deepEqual(kernel.getState().conversation.entries, foregroundBefore)
})

test('inactive async usage no-op emits zero state events', async () => {
  const pointerA: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/stage1-usage-a.jsonl',
    sessionId: 'stage1-usage-a',
    sessionName: 'A'
  }
  const pointerB: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/stage1-usage-b.jsonl',
    sessionId: 'stage1-usage-b',
    sessionName: 'B'
  }
  const stats: PiRpcSessionStats = {
    sessionId: pointerA.sessionId,
    sessionFile: pointerA.sessionFile,
    userMessages: 0,
    assistantMessages: 1,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 2,
    tokens: { input: 11, output: 7, cacheRead: 0, cacheWrite: 0, total: 18 },
    cost: 0
  }
  const runtimeA = new DeferredSessionStatsRuntimeHost(
    { sessionId: pointerA.sessionId, sessionFile: pointerA.sessionFile },
    [],
    [],
    undefined,
    stats
  )
  const runtimeB = new FakeRuntimeHost({
    sessionId: pointerB.sessionId,
    sessionFile: pointerB.sessionFile,
    sessionName: pointerB.sessionName ?? undefined
  })
  const runtimes = [runtimeA, runtimeB]
  const kernel = new WorkbenchKernel(
    () => {
      const runtime = runtimes.shift()
      assert.ok(runtime)
      return runtime
    },
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(),
      sessionRegistry: {
        sessions: [pointerA, pointerB],
        activeSessionKey: pointerA.sessionFile
      }
    }
  )

  await kernel.activateSession(pointerA.sessionFile)
  runtimeA.emit({
    type: 'pi-event',
    event: {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Seed usage' }],
        timestamp: 1,
        usage: { input: 11, output: 7, cacheRead: 0, cacheWrite: 0 }
      }
    }
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  await kernel.activateSession(pointerB.sessionFile)

  const foregroundBefore = kernel.getState().conversation.entries
  runtimeA.beginDeferringSessionStats()
  const events: KernelEvent[] = []
  const unsubscribe = kernel.subscribe((event) => events.push(event))
  runtimeA.emit({
    type: 'pi-event',
    event: {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Background usage' }],
        timestamp: 2,
        usage: { input: 11, output: 7, cacheRead: 0, cacheWrite: 0 }
      }
    }
  })
  assert.equal(runtimeA.pendingSessionStatsCount(), 1)
  // Resolve with identical stats: no navigation change, no publication.
  runtimeA.resolveNextSessionStats(stats)
  await new Promise<void>((resolve) => setImmediate(resolve))
  unsubscribe()

  assert.equal(events.filter((event) => event.type === 'kernel.state-changed').length, 0)
  assert.equal(events.filter((event) => event.type === 'kernel.state-patched').length, 0)
  assert.deepEqual(kernel.getState().conversation.entries, foregroundBefore)
  assert.equal(kernel.getState().session.id, pointerB.sessionId)
})

/**
 * Stage 2A: inactive ordinary Pi streaming must never loadContext-swap into the
 * active execution workspace. Narrow test-only cast reaches private loadContext.
 */
type WorkbenchKernelStage2AInternals = {
  loadContext: (context: unknown) => void
  projectNavigationState: (projectPath: string) => unknown
  state: {
    conversation: { entries: readonly unknown[], activeRunStartIndex: number | null }
    session: { id: string | null, messageCount: number }
    runtime: { status: RuntimeStatus }
  }
  runtime: RuntimeHost | null
  activeContext: {
    state: {
      conversation: { entries: readonly unknown[], activeRunStartIndex: number | null }
      session: { id: string | null, messageCount: number }
    }
    runtime: RuntimeHost
    provisionalCommit: Promise<void> | null
  } | null
}

function stage2AInternals(kernel: WorkbenchKernel): WorkbenchKernelStage2AInternals {
  return kernel as unknown as WorkbenchKernelStage2AInternals
}

test('Stage 2A inactive ordinary streaming never calls loadContext and preserves foreground identity', async () => {
  const pointerA: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/stage2a-session-a.jsonl',
    sessionId: 'stage2a-session-a',
    sessionName: 'A'
  }
  const pointerB: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/stage2a-session-b.jsonl',
    sessionId: 'stage2a-session-b',
    sessionName: 'B'
  }
  const runtimeA = new FakeRuntimeHost({
    sessionId: pointerA.sessionId,
    sessionFile: pointerA.sessionFile,
    sessionName: pointerA.sessionName ?? undefined,
    messageCount: 0
  })
  const runtimeB = new FakeRuntimeHost({
    sessionId: pointerB.sessionId,
    sessionFile: pointerB.sessionFile,
    sessionName: pointerB.sessionName ?? undefined
  })
  const runtimes = [runtimeA, runtimeB]
  const kernel = new WorkbenchKernel(
    () => {
      const runtime = runtimes.shift()
      assert.ok(runtime)
      return runtime
    },
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(),
      sessionRegistry: {
        sessions: [pointerA, pointerB],
        activeSessionKey: pointerA.sessionFile
      }
    }
  )

  await kernel.activateSession(pointerA.sessionFile)
  runtimeA.emit({ type: 'activity-started' })
  await kernel.activateSession(pointerB.sessionFile)
  assert.equal(kernel.getState().session.id, pointerB.sessionId)

  const internals = stage2AInternals(kernel)
  const originalLoadContext = internals.loadContext.bind(kernel)
  const originalProjectNavigationState = internals.projectNavigationState.bind(kernel)
  let loadContextCalls = 0
  let projectNavigationStateCalls = 0
  internals.loadContext = (context) => {
    loadContextCalls += 1
    throw new Error(`loadContext must not run for inactive ordinary streaming (call #${loadContextCalls})`)
  }
  internals.projectNavigationState = (projectPath) => {
    projectNavigationStateCalls += 1
    return originalProjectNavigationState(projectPath)
  }

  const foregroundState = internals.state
  const foregroundConversation = foregroundState.conversation
  const foregroundEntries = foregroundState.conversation.entries
  const foregroundSession = foregroundState.session
  const foregroundRuntime = internals.runtime
  const foregroundActiveContext = internals.activeContext
  assert.ok(foregroundActiveContext)
  const foregroundContextState = foregroundActiveContext.state
  const foregroundContextConversation = foregroundContextState.conversation
  const foregroundContextEntries = foregroundContextState.conversation.entries
  const foregroundContextSession = foregroundContextState.session

  const events: KernelEvent[] = []
  const unsubscribe = kernel.subscribe((event) => events.push(event))
  let observedDuringProjection = false

  try {
    // Observe the Kernel reentrantly while the inactive payload is projected. This
    // catches transient direct swaps even if a future implementation restores them.
    const reentrantMessage: Record<string, unknown> = {
      role: 'assistant',
      timestamp: 5
    }
    Object.defineProperty(reentrantMessage, 'content', {
      enumerable: true,
      get: () => {
        observedDuringProjection = true
        assert.equal(internals.state, foregroundState)
        assert.equal(internals.state.conversation, foregroundConversation)
        assert.equal(internals.state.session, foregroundSession)
        assert.equal(internals.runtime, foregroundRuntime)
        assert.equal(internals.activeContext, foregroundActiveContext)
        assert.equal(kernel.getState().session.id, pointerB.sessionId)
        return [{ type: 'text', text: 'Observed while inactive A projected' }]
      }
    })
    runtimeA.emit({
      type: 'pi-event',
      event: { type: 'message_update', message: reentrantMessage }
    })
    // The getter's deliberate getState() call projects Project summaries. Reset the
    // counter so the following streaming trace measures only Kernel event handling.
    projectNavigationStateCalls = 0

  // Realistic inactive A streaming trace (thinking rides in message content).
  runtimeA.emit({
    type: 'pi-event',
    event: {
      type: 'message_start',
      message: { role: 'user', content: 'Inspect package.json', timestamp: 10 }
    }
  })
  runtimeA.emit({
    type: 'pi-event',
    event: {
      type: 'message_update',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Inspect the project file.' },
          { type: 'toolCall', id: 'tool-1', name: 'read', arguments: { path: 'package.json' } }
        ],
        timestamp: 20
      }
    }
  })
  runtimeA.emit({
    type: 'pi-event',
    event: {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Inspect the project file.' },
          { type: 'toolCall', id: 'tool-1', name: 'read', arguments: { path: 'package.json' } }
        ],
        timestamp: 20
      }
    }
  })
  runtimeA.emit({
    type: 'pi-event',
    event: {
      type: 'tool_execution_start',
      toolCallId: 'tool-1',
      toolName: 'read',
      args: { path: 'package.json' }
    }
  })
  for (const fragment of ['{"name"', '{"name":"pi-gui"}']) {
    runtimeA.emit({
      type: 'pi-event',
      event: {
        type: 'tool_execution_update',
        toolCallId: 'tool-1',
        toolName: 'read',
        args: { path: 'package.json' },
        partialResult: { content: [{ type: 'text', text: fragment }] }
      }
    })
  }
  runtimeA.emit({
    type: 'pi-event',
    event: {
      type: 'tool_execution_end',
      toolCallId: 'tool-1',
      toolName: 'read',
      result: { content: [{ type: 'text', text: '{"name":"pi-gui"}' }] },
      isError: false
    }
  })
  for (const text of ['Hel', 'Hello', 'Hello from A']) {
    runtimeA.emit({
      type: 'pi-event',
      event: {
        type: 'message_update',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Summarize the result.' },
            { type: 'text', text }
          ],
          timestamp: 30
        }
      }
    })
  }
  runtimeA.emit({
    type: 'pi-event',
    event: {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Summarize the result.' },
          { type: 'text', text: 'Hello from A' }
        ],
        timestamp: 30
      }
    }
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
  } finally {
    unsubscribe()
    internals.loadContext = originalLoadContext
    internals.projectNavigationState = originalProjectNavigationState
  }

  assert.equal(observedDuringProjection, true)
  assert.equal(loadContextCalls, 0)
  assert.equal(projectNavigationStateCalls, 0)
  assert.equal(events.filter((event) => event.type === 'kernel.state-changed').length, 0)
  assert.equal(events.filter((event) => event.type === 'kernel.state-patched').length, 0)

  // Foreground execution workspace identity is strictly unchanged.
  assert.equal(internals.state, foregroundState)
  assert.equal(internals.state.conversation, foregroundConversation)
  assert.equal(internals.state.conversation.entries, foregroundEntries)
  assert.equal(internals.state.session, foregroundSession)
  assert.equal(internals.runtime, foregroundRuntime)
  assert.equal(internals.activeContext, foregroundActiveContext)
  assert.equal(internals.activeContext?.state, foregroundContextState)
  assert.equal(internals.activeContext?.state.conversation, foregroundContextConversation)
  assert.equal(internals.activeContext?.state.conversation.entries, foregroundContextEntries)
  assert.equal(internals.activeContext?.state.session, foregroundContextSession)
  assert.equal(internals.activeContext?.runtime, runtimeB)
  assert.equal(kernel.getState().session.id, pointerB.sessionId)

  // Structural spies are restored before activation; verify accumulated A state.
  await kernel.activateSession(pointerA.sessionFile)

  const activated = kernel.getState()
  assert.equal(activated.session.id, pointerA.sessionId)
  assert.equal(activated.session.messageCount, 2)
  const assistantMessages = activated.conversation.entries.filter(
    (entry) => entry.kind === 'message' && entry.role === 'assistant'
  )
  const tools = activated.conversation.entries.filter((entry) => entry.kind === 'tool')
  assert.equal(assistantMessages.length >= 1, true)
  const finalAssistant = assistantMessages[assistantMessages.length - 1]
  assert.equal(
    finalAssistant?.kind === 'message' ? finalAssistant.text : null,
    'Hello from A'
  )
  assert.equal(tools.length, 1)
  assert.equal(tools[0]?.kind === 'tool' ? tools[0].toolCallId : null, 'tool-1')
  assert.equal(tools[0]?.kind === 'tool' ? tools[0].status : null, 'success')
  assert.equal(tools[0]?.kind === 'tool' ? tools[0].output : null, '{"name":"pi-gui"}')
})

test('Stage 2A inactive provisional message_end materializes through explicit context entry', async () => {
  const provisionalRuntime = new FakeRuntimeHost({
    sessionId: 'stage2a-provisional-a',
    sessionFile: '/tmp/stage2a-provisional-a.jsonl'
  })
  const foregroundRuntime = new FakeRuntimeHost({
    sessionId: 'stage2a-session-b',
    sessionFile: '/tmp/stage2a-session-b.jsonl'
  })
  let validationCalls = 0
  const persisted: SessionPointer[] = []
  const kernel = new WorkbenchKernel(
    (() => {
      const runtimes = [provisionalRuntime, foregroundRuntime]
      return () => {
        const runtime = runtimes.shift()
        assert.ok(runtime)
        return runtime
      }
    })(),
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(null, persisted),
      validateSession: async (pointer) => {
        validationCalls += 1
        if (validationCalls === 1) throw fileError('ENOENT', 'not written')
        return { ...pointer, sessionFile: '/tmp/stage2a-materialized-a.jsonl' }
      }
    }
  )

  await kernel.start()
  await kernel.prompt('Materialize A without loadContext')
  await kernel.start()
  assert.equal(kernel.getState().session.id, 'stage2a-session-b')

  const internals = stage2AInternals(kernel)
  const originalLoadContext = internals.loadContext.bind(kernel)
  let loadContextCalls = 0
  internals.loadContext = (context) => {
    loadContextCalls += 1
    throw new Error(`loadContext must not run for inactive provisional message_end (call #${loadContextCalls})`)
  }

  const events: KernelEvent[] = []
  const unsubscribe = kernel.subscribe((event) => events.push(event))
  provisionalRuntime.emit({
    type: 'pi-event',
    event: {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'A is written' }],
        timestamp: 10
      }
    }
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
  unsubscribe()

  assert.equal(loadContextCalls, 0)
  assert.equal(kernel.getState().session.id, 'stage2a-session-b')
  assert.deepEqual(
    persisted.map(({ sessionId }) => sessionId),
    ['stage2a-session-b', 'stage2a-provisional-a']
  )
  // Navigation snapshot is allowed for materialization; Conversation patches are not.
  assert.equal(events.filter((event) => event.type === 'kernel.state-patched').length, 0)

  internals.loadContext = originalLoadContext
  await kernel.activateSession('/tmp/stage2a-materialized-a.jsonl')
  assert.equal(kernel.getState().session.id, 'stage2a-provisional-a')
  assert.equal(kernel.getState().session.resumeAvailable, true)
})

test('Stage 2A provisional metadata failure does not create a durable ghost session', async () => {
  const provisionalRuntime = new FakeRuntimeHost({
    sessionId: 'stage2a-metadata-failure-a',
    sessionFile: '/tmp/stage2a-metadata-failure-a.jsonl'
  })
  const foregroundRuntime = new FakeRuntimeHost({
    sessionId: 'stage2a-metadata-failure-b',
    sessionFile: '/tmp/stage2a-metadata-failure-b.jsonl'
  })
  let firstProvisionalValidation = true
  let resolveMetadataAttempted!: () => void
  const metadataAttempted = new Promise<void>((resolve) => {
    resolveMetadataAttempted = resolve
  })
  const persisted: SessionPointer[] = []
  const kernel = new WorkbenchKernel(
    (() => {
      const runtimes = [provisionalRuntime, foregroundRuntime]
      return () => {
        const runtime = runtimes.shift()
        assert.ok(runtime)
        return runtime
      }
    })(),
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(null, persisted),
      validateSession: async (pointer) => {
        if (pointer.sessionId !== 'stage2a-metadata-failure-a') return pointer
        if (firstProvisionalValidation) {
          firstProvisionalValidation = false
          throw fileError('ENOENT', 'not written')
        }
        return { ...pointer, sessionFile: '/tmp/stage2a-metadata-failure-materialized-a.jsonl' }
      },
      readSessionActivityAt: async (pointer) => {
        if (pointer.sessionId === 'stage2a-metadata-failure-a') {
          resolveMetadataAttempted()
          throw new Error('metadata read failed before persistence')
        }
        return null
      }
    }
  )

  await kernel.start()
  await kernel.prompt('Do not persist before metadata is readable')
  await kernel.start()
  provisionalRuntime.emit({
    type: 'pi-event',
    event: {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Metadata will fail' }],
        timestamp: 10
      }
    }
  })
  await metadataAttempted
  await new Promise<void>((resolve) => setImmediate(resolve))

  assert.equal(kernel.getState().session.id, 'stage2a-metadata-failure-b')
  assert.deepEqual(
    persisted.map(({ sessionId }) => sessionId),
    ['stage2a-metadata-failure-b']
  )
})

test('stopContext waits for an owning background provisional durable commit before removal', async () => {
  const pointerB: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/provisional-stop-b.jsonl',
    sessionId: 'provisional-stop-b',
    sessionName: 'Foreground B'
  }
  const runtimeA = new FakeRuntimeHost({
    sessionId: 'provisional-stop-a',
    sessionFile: '/tmp/provisional-stop-a.jsonl'
  })
  const runtimeB = new FakeRuntimeHost({
    sessionId: pointerB.sessionId,
    sessionFile: pointerB.sessionFile,
    sessionName: pointerB.sessionName ?? undefined
  })
  const runtimes = [runtimeA, runtimeB]
  let firstProvisionalValidation = true
  let resolvePersistEntered!: () => void
  let releasePersist!: () => void
  const persistEntered = new Promise<void>((resolve) => {
    resolvePersistEntered = resolve
  })
  const persistGate = new Promise<void>((resolve) => {
    releasePersist = resolve
  })
  const persisted: SessionPointer[] = []
  const kernel = new WorkbenchKernel(
    () => {
      const runtime = runtimes.shift()
      assert.ok(runtime)
      return runtime
    },
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(),
      sessionRegistry: { sessions: [pointerB], activeSessionKey: null },
      validateSession: async ({ projectPath, sessionFile, sessionId, sessionName }) => {
        if (sessionId === 'provisional-stop-a' && firstProvisionalValidation) {
          firstProvisionalValidation = false
          throw fileError('ENOENT', 'not written yet')
        }
        return { projectPath, sessionFile, sessionId, sessionName }
      },
      persistSession: async (pointer) => {
        if (pointer.sessionId === 'provisional-stop-a') {
          resolvePersistEntered()
          await persistGate
        }
        persisted.push({ ...pointer })
      }
    }
  )

  await kernel.start()
  await kernel.activateSession(pointerB.sessionFile)
  runtimeA.emit({
    type: 'pi-event',
    event: {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Materialize before stop' }],
        timestamp: 10
      }
    }
  })
  await persistEntered

  const internals = stage2BInternals(kernel)
  const contextA = internals.contextByRuntime.get(runtimeA)
  assert.ok(contextA)
  let stopSettled = false
  const stopPromise = internals.stopContext(contextA).then(() => {
    stopSettled = true
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(stopSettled, false)
  assert.equal(runtimeA.stopCalls, 0)

  releasePersist()
  await stopPromise
  assert.equal(runtimeA.stopCalls, 1)
  assert.equal(internals.contextByRuntime.has(runtimeA), false)
  assert.equal(
    persisted.some(({ sessionId }) => sessionId === 'provisional-stop-a'),
    true
  )
  assert.equal(kernel.getState().session.id, pointerB.sessionId)
  assert.equal(
    kernel.getState().sessions.find(({ id }) => id === 'provisional-stop-a')?.runtimeStatus,
    'stopped'
  )
})

/**
 * Stage 2B: inactive RuntimeHostEvent delivery must stay Context-local.
 * Structural spies install a phantom suppressEvents write detector even though
 * production no longer owns that field.
 */
type WorkbenchKernelStage2BInternals = {
  loadContext: (context: unknown) => void
  projectNavigationState: (projectPath: string) => unknown
  stopContext: (context: unknown) => Promise<void>
  suppressEvents?: boolean
  state: {
    conversation: { entries: readonly unknown[], activeRunStartIndex: number | null }
    session: {
      id: string | null
      messageCount: number
      name: string | null
      settled: boolean
      pendingMessageCount: number
      pendingSteeringMessages: readonly string[]
      pendingFollowUpMessages: readonly string[]
    }
    runtime: {
      status: RuntimeStatus
      lastError: string | null
      exitCode: number | null
      exitSignal: string | null
    }
    activeProjectKey: string | null
    sessions: readonly { key: string, name: string | null, runtimeStatus: RuntimeStatus }[]
  }
  runtime: RuntimeHost | null
  activeContext: {
    state: {
      conversation: { entries: readonly unknown[], activeRunStartIndex: number | null }
      session: {
        id: string | null
        messageCount: number
        name: string | null
        settled: boolean
        pendingMessageCount: number
        pendingSteeringMessages: readonly string[]
        pendingFollowUpMessages: readonly string[]
      }
      runtime: {
        status: RuntimeStatus
        lastError: string | null
        exitCode: number | null
        exitSignal: string | null
      }
    }
    runtime: RuntimeHost
    provisionalCommit: Promise<void> | null
    provisionalSettled: boolean
    provisionalSession: { pointer: SessionPointer } | null
    pendingSessionName: unknown
    sessionNameOperation: unknown
  } | null
  contexts: Set<{
    runtime: RuntimeHost
    state: {
      conversation: { entries: readonly unknown[], activeRunStartIndex: number | null }
      session: {
        id: string | null
        messageCount: number
        name: string | null
        settled: boolean
        pendingMessageCount: number
        pendingSteeringMessages: readonly string[]
        pendingFollowUpMessages: readonly string[]
      }
      runtime: {
        status: RuntimeStatus
        lastError: string | null
        exitCode: number | null
        exitSignal: string | null
      }
    }
    provisionalCommit: Promise<void> | null
    provisionalSettled: boolean
    provisionalSession: { pointer: SessionPointer } | null
  }>
  contextByRuntime: Map<RuntimeHost, {
    state: {
      conversation: { entries: readonly unknown[], activeRunStartIndex: number | null }
      session: {
        id: string | null
        messageCount: number
        name: string | null
        settled: boolean
        pendingMessageCount: number
        pendingSteeringMessages: readonly string[]
        pendingFollowUpMessages: readonly string[]
      }
      runtime: {
        status: RuntimeStatus
        lastError: string | null
        exitCode: number | null
        exitSignal: string | null
      }
    }
    provisionalCommit: Promise<void> | null
    provisionalSettled: boolean
    provisionalSession: { pointer: SessionPointer } | null
  }>
  sessionPointers: SessionPointer[]
  sessionPointersByProject: Map<string, SessionPointer[]>
}

function stage2BInternals(kernel: WorkbenchKernel): WorkbenchKernelStage2BInternals {
  return kernel as unknown as WorkbenchKernelStage2BInternals
}

function installStage2BStructuralSpies(kernel: WorkbenchKernel): {
  loadContextCalls: () => number
  suppressWrites: () => number
  restore: () => void
  assertForeground: (sessionId: string) => void
  captureForeground: () => {
    state: WorkbenchKernelStage2BInternals['state']
    conversation: WorkbenchKernelStage2BInternals['state']['conversation']
    entries: readonly unknown[]
    session: WorkbenchKernelStage2BInternals['state']['session']
    runtime: RuntimeHost | null
    activeContext: WorkbenchKernelStage2BInternals['activeContext']
  }
} {
  const internals = stage2BInternals(kernel)
  const originalLoadContext = internals.loadContext.bind(kernel)
  let loadContextCalls = 0
  let suppressWrites = 0
  let suppressValue = internals.suppressEvents ?? false
  internals.loadContext = (context) => {
    loadContextCalls += 1
    throw new Error(`loadContext must not run for Stage 2B inactive events (call #${loadContextCalls})`)
  }
  Object.defineProperty(kernel, 'suppressEvents', {
    configurable: true,
    enumerable: true,
    get: () => suppressValue,
    set: (value: boolean) => {
      suppressWrites += 1
      suppressValue = value
    }
  })

  const captureForeground = () => {
    const state = internals.state
    return {
      state,
      conversation: state.conversation,
      entries: state.conversation.entries,
      session: state.session,
      runtime: internals.runtime,
      activeContext: internals.activeContext
    }
  }

  const assertForeground = (sessionId: string) => {
    const foreground = captureForeground()
    assert.equal(kernel.getState().session.id, sessionId)
    assert.equal(internals.runtime, foreground.runtime)
    assert.equal(internals.activeContext, foreground.activeContext)
    assert.equal(internals.state, foreground.state)
    assert.equal(internals.state.conversation, foreground.conversation)
    assert.equal(internals.state.session, foreground.session)
  }

  return {
    loadContextCalls: () => loadContextCalls,
    suppressWrites: () => suppressWrites,
    restore: () => {
      internals.loadContext = originalLoadContext
      Object.defineProperty(kernel, 'suppressEvents', {
        configurable: true,
        enumerable: true,
        writable: true,
        value: suppressValue
      })
    },
    assertForeground,
    captureForeground
  }
}

function reentrantHostState(
  runtime: FakeRuntimeHost,
  onAccess: () => void
): void {
  const originalGetState = runtime.getState.bind(runtime)
  runtime.getState = () => {
    onAccess()
    return originalGetState()
  }
}

test('Stage 2B inactive host/lifecycle/metadata never swaps and preserves exact navigation counts', async () => {
  const pointerA: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/stage2b-session-a.jsonl',
    sessionId: 'stage2b-session-a',
    sessionName: 'A'
  }
  const pointerB: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/stage2b-session-b.jsonl',
    sessionId: 'stage2b-session-b',
    sessionName: 'B'
  }
  const runtimeA = new FakeRuntimeHost({
    sessionId: pointerA.sessionId,
    sessionFile: pointerA.sessionFile,
    sessionName: pointerA.sessionName ?? undefined,
    messageCount: 0
  })
  const runtimeB = new FakeRuntimeHost({
    sessionId: pointerB.sessionId,
    sessionFile: pointerB.sessionFile,
    sessionName: pointerB.sessionName ?? undefined
  })
  const runtimes = [runtimeA, runtimeB]
  const kernel = new WorkbenchKernel(
    () => {
      const runtime = runtimes.shift()
      assert.ok(runtime)
      return runtime
    },
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(),
      now: () => 100,
      sessionRegistry: {
        sessions: [pointerA, pointerB],
        activeSessionKey: pointerA.sessionFile
      }
    }
  )

  await kernel.activateSession(pointerA.sessionFile)
  await kernel.activateSession(pointerB.sessionFile)
  assert.equal(kernel.getState().session.id, pointerB.sessionId)

  const spies = installStage2BStructuralSpies(kernel)
  const events: KernelEvent[] = []
  const unsubscribe = kernel.subscribe((event) => events.push(event))
  let reentrantObservations = 0
  const observeForeground = (): void => {
    reentrantObservations += 1
    spies.assertForeground(pointerB.sessionId)
  }
  reentrantHostState(runtimeA, observeForeground)

  const countChanged = () => events.filter((event) => event.type === 'kernel.state-changed').length
  const countPatched = () => events.filter((event) => event.type === 'kernel.state-patched').length
  const drain = async () => {
    await new Promise<void>((resolve) => setImmediate(resolve))
    await new Promise<void>((resolve) => setImmediate(resolve))
  }

  try {
    const beforeActivity = countChanged()
    runtimeA.emit({ type: 'activity-started' })
    assert.equal(countChanged() - beforeActivity, 1)
    assert.equal(countPatched(), 0)
    assert.equal(kernel.getState().session.id, pointerB.sessionId)
    assert.equal(
      kernel.getState().sessions.find((session) => session.key === pointerA.sessionFile)?.runtimeStatus,
      'running'
    )

    // Duplicate activity-started is a no-op.
    const afterFirstStart = countChanged()
    runtimeA.emit({ type: 'activity-started' })
    assert.equal(countChanged(), afterFirstStart)

    const beforeSettled = countChanged()
    runtimeA.emit({ type: 'activity-settled' })
    assert.equal(countChanged() - beforeSettled, 1)
    assert.equal(
      kernel.getState().sessions.find((session) => session.key === pointerA.sessionFile)?.runtimeStatus,
      'ready'
    )
    runtimeA.emit({ type: 'activity-settled' })
    assert.equal(countChanged(), beforeSettled + 1)

    const beforeAgentStart = countChanged()
    runtimeA.emit({ type: 'pi-event', event: { type: 'agent_start' } })
    assert.equal(countChanged() - beforeAgentStart, 1)
    runtimeA.emit({ type: 'pi-event', event: { type: 'agent_start' } })
    assert.equal(countChanged(), beforeAgentStart + 1)

    // Queue update must not publish navigation.
    const reentrantSteering = ['queued steering']
    Object.defineProperty(reentrantSteering, '0', {
      enumerable: true,
      configurable: true,
      get: () => {
        observeForeground()
        return 'queued steering'
      }
    })
    const beforeQueue = countChanged()
    runtimeA.emit({
      type: 'pi-event',
      event: {
        type: 'queue_update',
        steering: reentrantSteering,
        followUp: ['follow up one']
      }
    })
    assert.equal(countChanged(), beforeQueue)
    assert.equal(countPatched(), 0)

    // Malformed queue is ignored.
    runtimeA.emit({
      type: 'pi-event',
      event: {
        type: 'queue_update',
        steering: 'not-an-array',
        followUp: ['x']
      }
    })
    assert.equal(countChanged(), beforeQueue)

    const beforeAgentSettled = countChanged()
    runtimeA.emit({ type: 'pi-event', event: { type: 'agent_settled' } })
    assert.equal(countChanged() - beforeAgentSettled, 1)
    const afterFirstAgentSettled = countChanged()
    runtimeA.emit({ type: 'pi-event', event: { type: 'agent_settled' } })
    // A deterministic clock makes the duplicate settlement navigation-neutral.
    assert.equal(countChanged(), afterFirstAgentSettled)
    assert.equal(countPatched(), 0)
    assert.equal(kernel.getState().session.id, pointerB.sessionId)

    const renamedName = Object.defineProperty({} as { value?: string }, 'value', {
      enumerable: true,
      get: () => {
        observeForeground()
        return 'Renamed A'
      }
    })
    const beforeRename = countChanged()
    runtimeA.emit({
      type: 'pi-event',
      event: {
        type: 'session_info_changed',
        get name() {
          return renamedName.value as string
        }
      }
    })
    assert.equal(countChanged() - beforeRename, 1)
    assert.equal(
      kernel.getState().sessions.find((session) => session.key === pointerA.sessionFile)?.name,
      'Renamed A'
    )
    assert.equal(kernel.getState().session.name, pointerB.sessionName)

    // Custom/unknown Pi event updates only Conversation; zero navigation.
    const beforeCustom = countChanged()
    runtimeA.emit({
      type: 'pi-event',
      event: {
        type: 'extension_error',
        get error() {
          observeForeground()
          return 'background extension fault'
        }
      }
    })
    assert.equal(countChanged(), beforeCustom)
    assert.equal(countPatched(), 0)

    // stderr/protocol diagnostics do not change navigation summaries.
    const beforeStderr = countChanged()
    runtimeA.emit({
      type: 'diagnostic',
      kind: 'stderr',
      get message() {
        observeForeground()
        return 'noise on stderr'
      },
      stderrChars: 12
    })
    assert.equal(countChanged(), beforeStderr)
    runtimeA.emit({
      type: 'diagnostic',
      kind: 'protocol',
      message: 'protocol warning',
      stderrChars: 12
    })
    assert.equal(countChanged(), beforeStderr)

    const beforeCrash = countChanged()
    runtimeA.emit({
      type: 'diagnostic',
      kind: 'process',
      message: 'process died',
      stderrChars: 12
    })
    assert.equal(countChanged() - beforeCrash, 1)
    assert.equal(
      kernel.getState().sessions.find((session) => session.key === pointerA.sessionFile)?.runtimeStatus,
      'crashed'
    )
    // Duplicate process diagnostic while already crashed is a no-op for navigation.
    runtimeA.emit({
      type: 'diagnostic',
      kind: 'process',
      message: 'process died again',
      stderrChars: 12
    })
    assert.equal(countChanged(), beforeCrash + 1)

    // Recover A via a fresh activation is not available; process-exit on crashed stays no-op.
    const beforeExit = countChanged()
    runtimeA.emit({ type: 'process-exit', code: 17, signal: null })
    assert.equal(countChanged(), beforeExit)

    await drain()
    assert.equal(spies.loadContextCalls(), 0)
    assert.equal(spies.suppressWrites(), 0)
    assert.ok(reentrantObservations > 0)
    assert.equal(kernel.getState().session.id, pointerB.sessionId)
  } finally {
    unsubscribe()
    spies.restore()
  }

  // Activation of A reveals context-local results: settled queues cleared, rename, custom entry,
  // and crash/exit evidence.
  await kernel.activateSession(pointerA.sessionFile)
  const activated = kernel.getState()
  assert.equal(activated.session.id, pointerA.sessionId)
  assert.equal(activated.session.name, 'Renamed A')
  assert.equal(activated.session.pendingMessageCount, 0)
  assert.deepEqual(activated.session.pendingSteeringMessages, [])
  assert.deepEqual(activated.session.pendingFollowUpMessages, [])
  assert.equal(activated.runtime.status, 'crashed')
  // process-exit after a process diagnostic preserves the exit evidence and final crash reason.
  assert.equal(activated.runtime.lastError, 'Pi RPC process exited with code 17.')
  assert.equal(activated.runtime.exitCode, 17)
  assert.equal(activated.conversation.entries.some((entry) =>
    entry.kind === 'error' && entry.message === 'background extension fault'
  ), true)
})

test('Stage 2B inactive process-exit crashes only the owning context', async () => {
  const pointerA: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/stage2b-exit-a.jsonl',
    sessionId: 'stage2b-exit-a',
    sessionName: 'Exit A'
  }
  const pointerB: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/stage2b-exit-b.jsonl',
    sessionId: 'stage2b-exit-b',
    sessionName: 'Exit B'
  }
  const runtimeA = new FakeRuntimeHost({
    sessionId: pointerA.sessionId,
    sessionFile: pointerA.sessionFile,
    sessionName: pointerA.sessionName ?? undefined
  })
  const runtimeB = new FakeRuntimeHost({
    sessionId: pointerB.sessionId,
    sessionFile: pointerB.sessionFile,
    sessionName: pointerB.sessionName ?? undefined
  })
  const runtimes = [runtimeA, runtimeB]
  const kernel = new WorkbenchKernel(
    () => {
      const runtime = runtimes.shift()
      assert.ok(runtime)
      return runtime
    },
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(),
      sessionRegistry: {
        sessions: [pointerA, pointerB],
        activeSessionKey: pointerA.sessionFile
      }
    }
  )

  await kernel.activateSession(pointerA.sessionFile)
  await kernel.activateSession(pointerB.sessionFile)

  const spies = installStage2BStructuralSpies(kernel)
  const events: KernelEvent[] = []
  const unsubscribe = kernel.subscribe((event) => events.push(event))
  reentrantHostState(runtimeA, () => {
    assert.equal(kernel.getState().session.id, pointerB.sessionId)
  })

  try {
    runtimeA.emit({ type: 'activity-started' })
    events.length = 0
    runtimeA.emit({ type: 'process-exit', code: 9, signal: null })
    assert.equal(events.filter((event) => event.type === 'kernel.state-changed').length, 1)
    assert.equal(events.filter((event) => event.type === 'kernel.state-patched').length, 0)
    assert.equal(kernel.getState().session.id, pointerB.sessionId)
    assert.equal(kernel.getState().runtime.status, 'ready')
    assert.equal(
      kernel.getState().sessions.find((session) => session.key === pointerA.sessionFile)?.runtimeStatus,
      'crashed'
    )
    assert.equal(spies.loadContextCalls(), 0)
    assert.equal(spies.suppressWrites(), 0)
  } finally {
    unsubscribe()
    spies.restore()
  }

  await kernel.activateSession(pointerA.sessionFile)
  assert.equal(kernel.getState().runtime.status, 'crashed')
  assert.equal(
    kernel.getState().runtime.lastError,
    'Pi RPC process exited with code 9.'
  )
  assert.equal(kernel.getState().runtime.exitCode, 9)
})

test('Stage 2B inactive session_info_changed isolates cross-project pointer maps', async () => {
  const pointerA: SessionPointer = {
    projectPath: '/tmp/project-a',
    sessionFile: '/tmp/stage2b-cross-a.jsonl',
    sessionId: 'stage2b-cross-a',
    sessionName: 'Project A session'
  }
  const pointerB: SessionPointer = {
    projectPath: '/tmp/project-b',
    sessionFile: '/tmp/stage2b-cross-b.jsonl',
    sessionId: 'stage2b-cross-b',
    sessionName: 'Project B session'
  }
  const runtimeA = new FakeRuntimeHost({
    sessionId: pointerA.sessionId,
    sessionFile: pointerA.sessionFile,
    sessionName: pointerA.sessionName ?? undefined
  })
  const runtimeB = new FakeRuntimeHost({
    sessionId: pointerB.sessionId,
    sessionFile: pointerB.sessionFile,
    sessionName: pointerB.sessionName ?? undefined
  })
  const runtimes = [runtimeA, runtimeB]
  const kernel = new WorkbenchKernel(
    () => {
      const runtime = runtimes.shift()
      assert.ok(runtime)
      return runtime
    },
    {
      projects: [{ path: '/tmp/project-a' }, { path: '/tmp/project-b' }],
      activeProjectKey: '/tmp/project-a'
    },
    {
      ...kernelOptions(),
      sessionRegistry: {
        sessions: [pointerA, pointerB],
        activeSessionKey: pointerA.sessionFile
      }
    }
  )

  await kernel.activateSession(pointerA.sessionFile)
  await kernel.activateProject('/tmp/project-b', {
    sessions: [pointerB],
    activeSessionKey: pointerB.sessionFile
  })
  assert.equal(kernel.getState().activeProjectKey, '/tmp/project-b')
  assert.equal(kernel.getState().session.id, pointerB.sessionId)

  const spies = installStage2BStructuralSpies(kernel)
  const internals = stage2BInternals(kernel)
  const bPointersBefore = [...(internals.sessionPointersByProject.get('/tmp/project-b') ?? internals.sessionPointers)]
  const events: KernelEvent[] = []
  const unsubscribe = kernel.subscribe((event) => events.push(event))

  try {
    runtimeA.emit({
      type: 'pi-event',
      event: { type: 'session_info_changed', name: 'Renamed only A' }
    })
    assert.equal(spies.loadContextCalls(), 0)
    assert.equal(spies.suppressWrites(), 0)
    assert.equal(kernel.getState().session.id, pointerB.sessionId)
    assert.equal(kernel.getState().session.name, pointerB.sessionName)
    assert.equal(kernel.getState().activeProjectKey, '/tmp/project-b')
    // B's project pointer map must remain untouched.
    assert.deepEqual(
      internals.sessionPointersByProject.get('/tmp/project-b') ?? internals.sessionPointers,
      bPointersBefore
    )
    assert.equal(
      (internals.sessionPointersByProject.get('/tmp/project-a') ?? [])
        .find((pointer) => pointer.sessionFile === pointerA.sessionFile)?.sessionName,
      'Renamed only A'
    )
  } finally {
    unsubscribe()
    spies.restore()
  }

  await kernel.activateProject('/tmp/project-a', {
    sessions: [
      { ...pointerA, sessionName: 'Renamed only A' },
      pointerB
    ],
    activeSessionKey: pointerA.sessionFile
  })
  assert.equal(kernel.getState().session.name, 'Renamed only A')
})

test('Stage 2B inactive provisional agent_settled retries ENOENT without swap', async () => {
  const provisionalRuntime = new FakeRuntimeHost({
    sessionId: 'stage2b-provisional-a',
    sessionFile: '/tmp/stage2b-provisional-a.jsonl'
  })
  const foregroundRuntime = new FakeRuntimeHost({
    sessionId: 'stage2b-session-b',
    sessionFile: '/tmp/stage2b-session-b.jsonl'
  })
  const canonicalPointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/stage2b-materialized-a.jsonl',
    sessionId: 'stage2b-provisional-a',
    sessionName: null
  }
  const persisted: SessionPointer[] = []
  // Count only provisional-A validations:
  // 1 = initial start ENOENT (provisional), 2 = message_end commit in flight,
  // 3 = post-settled ENOENT retry success.
  let validationCalls = 0
  let holdValidation!: () => void
  const validationGate = new Promise<void>((resolve) => {
    holdValidation = resolve
  })
  const kernel = new WorkbenchKernel(
    (() => {
      const runtimes = [provisionalRuntime, foregroundRuntime]
      return () => {
        const runtime = runtimes.shift()
        assert.ok(runtime)
        return runtime
      }
    })(),
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(null, persisted),
      validateSession: async (pointer) => {
        if (pointer.sessionId !== 'stage2b-provisional-a') return pointer
        validationCalls += 1
        if (validationCalls === 1) throw fileError('ENOENT', 'not written yet')
        if (validationCalls === 2) {
          await validationGate
          throw fileError('ENOENT', 'still racing write')
        }
        return { ...pointer, sessionFile: canonicalPointer.sessionFile }
      }
    }
  )

  await kernel.start()
  assert.equal(validationCalls, 1)
  await kernel.prompt('Materialize A in background')
  await kernel.start()
  assert.equal(kernel.getState().session.id, 'stage2b-session-b')
  assert.equal(validationCalls, 1)

  const spies = installStage2BStructuralSpies(kernel)
  const events: KernelEvent[] = []
  const unsubscribe = kernel.subscribe((event) => events.push(event))
  let settledWatch: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    // message_end starts commit #2 and parks on the gate.
    provisionalRuntime.emit({
      type: 'pi-event',
      event: {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'A body' }],
          timestamp: 20
        }
      }
    })
    assert.equal(validationCalls, 2)

    // agent_settled while commit #2 is in flight: mark settled, do not start a second commit.
    provisionalRuntime.emit({ type: 'pi-event', event: { type: 'agent_settled' } })
    assert.equal(validationCalls, 2)

    const committed = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(
          `timed out waiting for materialization; validationCalls=${validationCalls}; sessions=${kernel.getState().sessions.map((s) => s.key).join(',')}; persisted=${persisted.map((p) => p.sessionFile).join(',')}`
        ))
      }, 1000)
      settledWatch = kernel.subscribe(() => {
        if (kernel.getState().sessions.some((session) => session.key === canonicalPointer.sessionFile)) {
          if (timer !== undefined) {
            clearTimeout(timer)
            timer = undefined
          }
          if (settledWatch !== undefined) {
            settledWatch()
            settledWatch = undefined
          }
          resolve()
        }
      })
    })

    // Release call #2 → ENOENT → scheduled retry call #3 succeeds.
    holdValidation()
    await committed
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    await new Promise<void>((resolve) => setImmediate(resolve))

    assert.equal(spies.loadContextCalls(), 0)
    assert.equal(spies.suppressWrites(), 0)
    assert.equal(kernel.getState().session.id, 'stage2b-session-b')
    assert.equal(validationCalls, 3)
    assert.equal(
      persisted.filter((pointer) => pointer.sessionId === 'stage2b-provisional-a').length,
      1
    )
    assert.equal(
      events.filter((event) => event.type === 'kernel.state-patched').length,
      0
    )
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    settledWatch?.()
    unsubscribe()
    spies.restore()
  }

  await kernel.activateSession(canonicalPointer.sessionFile)
  assert.equal(kernel.getState().session.id, 'stage2b-provisional-a')
  assert.equal(kernel.getState().runtime.status, 'ready')
  assert.equal(kernel.getState().session.settled, true)
  assert.equal(kernel.getState().session.resumeAvailable, true)
})

test('Stage 2B inactive agent_settled clears only that context queues and run boundary', async () => {
  const pointerA: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/stage2b-queue-a.jsonl',
    sessionId: 'stage2b-queue-a',
    sessionName: 'Queue A'
  }
  const pointerB: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/stage2b-queue-b.jsonl',
    sessionId: 'stage2b-queue-b',
    sessionName: 'Queue B'
  }
  const runtimeA = new FakeRuntimeHost({
    sessionId: pointerA.sessionId,
    sessionFile: pointerA.sessionFile,
    sessionName: pointerA.sessionName ?? undefined
  })
  const runtimeB = new FakeRuntimeHost({
    sessionId: pointerB.sessionId,
    sessionFile: pointerB.sessionFile,
    sessionName: pointerB.sessionName ?? undefined
  })
  const runtimes = [runtimeA, runtimeB]
  const kernel = new WorkbenchKernel(
    () => {
      const runtime = runtimes.shift()
      assert.ok(runtime)
      return runtime
    },
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(),
      sessionRegistry: {
        sessions: [pointerA, pointerB],
        activeSessionKey: pointerA.sessionFile
      }
    }
  )

  await kernel.activateSession(pointerA.sessionFile)
  await kernel.activateSession(pointerB.sessionFile)

  // Seed B queue so we can prove it is not cleared.
  runtimeB.emit({
    type: 'pi-event',
    event: {
      type: 'queue_update',
      steering: ['b-steer'],
      followUp: ['b-follow']
    }
  })
  assert.equal(kernel.getState().session.pendingMessageCount, 2)

  const spies = installStage2BStructuralSpies(kernel)
  try {
    runtimeA.emit({ type: 'pi-event', event: { type: 'agent_start' } })
    runtimeA.emit({
      type: 'pi-event',
      event: {
        type: 'message_start',
        message: { role: 'user', content: 'A turn', timestamp: 1 }
      }
    })
    runtimeA.emit({
      type: 'pi-event',
      event: {
        type: 'queue_update',
        steering: ['a-steer'],
        followUp: ['a-follow']
      }
    })
    runtimeA.emit({ type: 'pi-event', event: { type: 'agent_settled' } })
    assert.equal(spies.loadContextCalls(), 0)
    assert.equal(spies.suppressWrites(), 0)
    // B remains foreground with its queue intact.
    assert.equal(kernel.getState().session.id, pointerB.sessionId)
    assert.equal(kernel.getState().session.pendingMessageCount, 2)
    assert.deepEqual(kernel.getState().session.pendingSteeringMessages, ['b-steer'])
  } finally {
    spies.restore()
  }

  await kernel.activateSession(pointerA.sessionFile)
  assert.equal(kernel.getState().session.id, pointerA.sessionId)
  assert.equal(kernel.getState().runtime.status, 'ready')
  assert.equal(kernel.getState().session.settled, true)
  assert.equal(kernel.getState().session.pendingMessageCount, 0)
  assert.deepEqual(kernel.getState().session.pendingSteeringMessages, [])
  assert.deepEqual(kernel.getState().session.pendingFollowUpMessages, [])
  assert.equal(kernel.getState().conversation.activeRunStartIndex, null)
  assert.equal(
    kernel.getState().conversation.entries.some((entry) =>
      entry.kind === 'message' && entry.role === 'user' && entry.text === 'A turn'
    ),
    true
  )
})

class DeferredCompactionRuntimeHost extends FakeRuntimeHost {
  private deferEnd = false

  deferCompactEnd(): void {
    this.deferEnd = true
  }

  completeCompact(payload?: {
    reason?: 'manual' | 'threshold' | 'overflow'
    result?: unknown
    aborted?: boolean
    willRetry?: boolean
  }): void {
    this.emit({
      type: 'pi-event',
      event: {
        type: 'compaction_end',
        reason: payload?.reason ?? 'manual',
        result: payload?.result ?? {
          summary: 'Compacted',
          firstKeptEntryId: 'kept',
          tokensBefore: 100
        },
        aborted: payload?.aborted ?? false,
        willRetry: payload?.willRetry ?? false
      }
    })
  }

  override async send(command: RuntimeCommand): Promise<RuntimeCommandResult> {
    if (command.type !== 'compact') return super.send(command)
    this.commands.push(command)
    this.emit({
      type: 'pi-event',
      event: { type: 'compaction_start', reason: 'manual' }
    })
    // Deferred mode returns after start so invokeCommand can await the lifecycle
    // while tests switch sessions or inject crash/exit. End is emitted separately.
    if (this.deferEnd) return { type: 'accepted' }
    this.emit({
      type: 'pi-event',
      event: {
        type: 'compaction_end',
        reason: 'manual',
        result: { summary: 'Compacted', firstKeptEntryId: 'kept', tokensBefore: 100 },
        aborted: false,
        willRetry: false
      }
    })
    return { type: 'accepted' }
  }
}

test('Stage 2B inactive compaction never swaps and covers start/end outcomes', async () => {
  const pointerA: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/stage2b-compaction-a.jsonl',
    sessionId: 'stage2b-compaction-a',
    sessionName: 'Compaction A'
  }
  const pointerB: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/stage2b-compaction-b.jsonl',
    sessionId: 'stage2b-compaction-b',
    sessionName: 'Compaction B'
  }
  const runtimeA = new FakeRuntimeHost({
    sessionId: pointerA.sessionId,
    sessionFile: pointerA.sessionFile,
    sessionName: pointerA.sessionName ?? undefined,
    messageCount: 2
  })
  const runtimeB = new FakeRuntimeHost({
    sessionId: pointerB.sessionId,
    sessionFile: pointerB.sessionFile,
    sessionName: pointerB.sessionName ?? undefined
  })
  const runtimes = [runtimeA, runtimeB]
  const kernel = new WorkbenchKernel(
    () => {
      const runtime = runtimes.shift()
      assert.ok(runtime)
      return runtime
    },
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(),
      sessionRegistry: {
        sessions: [pointerA, pointerB],
        activeSessionKey: pointerA.sessionFile
      }
    }
  )

  await kernel.activateSession(pointerA.sessionFile)
  await kernel.activateSession(pointerB.sessionFile)
  assert.equal(kernel.getState().session.id, pointerB.sessionId)

  const spies = installStage2BStructuralSpies(kernel)
  const events: KernelEvent[] = []
  const unsubscribe = kernel.subscribe((event) => events.push(event))
  let reentrantObservations = 0
  const observeForeground = (): void => {
    reentrantObservations += 1
    spies.assertForeground(pointerB.sessionId)
  }
  reentrantHostState(runtimeA, observeForeground)

  const countChanged = () => events.filter((event) => event.type === 'kernel.state-changed').length
  const countPatched = () => events.filter((event) => event.type === 'kernel.state-patched').length
  const lifecycleOf = (type: 'kernel.compaction-started' | 'kernel.compaction-ended') =>
    events.filter((event) => event.type === type)

  try {
    const beforeStart = countChanged()
    runtimeA.emit({
      type: 'pi-event',
      event: {
        type: 'compaction_start',
        get reason() {
          observeForeground()
          return 'manual'
        }
      }
    })
    assert.equal(countChanged(), beforeStart)
    assert.equal(countPatched(), 0)
    assert.equal(lifecycleOf('kernel.compaction-started').length, 1)
    assert.deepEqual(lifecycleOf('kernel.compaction-started')[0], {
      type: 'kernel.compaction-started',
      projectKey: '/tmp/project',
      sessionKey: pointerA.sessionFile,
      reason: 'manual'
    })
    assert.equal(kernel.getState().session.id, pointerB.sessionId)
    assert.equal(kernel.getState().session.compaction, null)

    // Completed path with statistics may publish one navigation-bounded state event.
    const beforeCompleted = countChanged()
    const completed = waitForCompactionOutcome(kernel, 'completed')
    runtimeA.emit({
      type: 'pi-event',
      event: {
        type: 'compaction_end',
        reason: 'manual',
        result: { summary: 'Compacted', firstKeptEntryId: 'kept', tokensBefore: 100 },
        aborted: false,
        willRetry: false
      }
    })
    await completed
    assert.equal(countPatched(), 0)
    assert.ok(countChanged() - beforeCompleted <= 1)
    assert.equal(kernel.getState().session.id, pointerB.sessionId)
    assert.equal(kernel.getState().session.compaction, null)

    // Failed malformed end
    runtimeA.emit({ type: 'pi-event', event: { type: 'compaction_start', reason: 'threshold' } })
    const failed = waitForCompactionOutcome(kernel, 'failed')
    runtimeA.emit({
      type: 'pi-event',
      event: {
        type: 'compaction_end',
        reason: 'threshold',
        result: 42,
        aborted: false,
        willRetry: false
      }
    })
    await failed

    // Cancelled end
    runtimeA.emit({ type: 'pi-event', event: { type: 'compaction_start', reason: 'overflow' } })
    const cancelled = waitForCompactionOutcome(kernel, 'cancelled')
    runtimeA.emit({
      type: 'pi-event',
      event: {
        type: 'compaction_end',
        reason: 'overflow',
        result: null,
        aborted: true,
        willRetry: false
      }
    })
    await cancelled

    // Retry end keeps lifecycle open without swapping foreground.
    runtimeA.emit({ type: 'pi-event', event: { type: 'compaction_start', reason: 'overflow' } })
    const retrying = waitForCompactionOutcome(kernel, 'retrying')
    runtimeA.emit({
      type: 'pi-event',
      event: {
        type: 'compaction_end',
        reason: 'overflow',
        result: null,
        aborted: false,
        willRetry: true
      }
    })
    await retrying
    const retryCompleted = waitForCompactionOutcome(kernel, 'completed')
    runtimeA.emit({
      type: 'pi-event',
      event: {
        type: 'compaction_end',
        reason: 'overflow',
        result: { summary: 'Compacted', firstKeptEntryId: 'kept', tokensBefore: 50 },
        aborted: false,
        willRetry: true
      }
    })
    await retryCompleted

    assert.equal(spies.loadContextCalls(), 0)
    assert.equal(spies.suppressWrites(), 0)
    assert.equal(countPatched(), 0)
    assert.ok(reentrantObservations > 0)
    assert.equal(kernel.getState().session.id, pointerB.sessionId)
    assert.equal(kernel.getState().session.compaction, null)
    assert.ok(lifecycleOf('kernel.compaction-started').length >= 4)
    assert.ok(lifecycleOf('kernel.compaction-ended').length >= 5)
  } finally {
    unsubscribe()
    spies.restore()
  }

  await kernel.activateSession(pointerA.sessionFile)
  assert.equal(kernel.getState().session.id, pointerA.sessionId)
  assert.equal(kernel.getState().session.compaction, null)
})

test('Stage 2B /compact echo stays on originating context after switch', async () => {
  const pointerA: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/stage2b-compact-echo-a.jsonl',
    sessionId: 'stage2b-compact-echo-a',
    sessionName: 'Echo A'
  }
  const pointerB: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/stage2b-compact-echo-b.jsonl',
    sessionId: 'stage2b-compact-echo-b',
    sessionName: 'Echo B'
  }
  const runtimeA = new DeferredCompactionRuntimeHost({
    sessionId: pointerA.sessionId,
    sessionFile: pointerA.sessionFile,
    sessionName: pointerA.sessionName ?? undefined
  })
  const runtimeB = new FakeRuntimeHost({
    sessionId: pointerB.sessionId,
    sessionFile: pointerB.sessionFile,
    sessionName: pointerB.sessionName ?? undefined
  })
  const runtimes = [runtimeA, runtimeB]
  const kernel = new WorkbenchKernel(
    () => {
      const runtime = runtimes.shift()
      assert.ok(runtime)
      return runtime
    },
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(),
      sessionRegistry: {
        sessions: [pointerA, pointerB],
        activeSessionKey: pointerA.sessionFile
      }
    }
  )

  await kernel.activateSession(pointerA.sessionFile)
  runtimeA.deferCompactEnd()
  const invocation = kernel.invokeCommand(COMPACT_COMMAND_ID, 'Keep decisions')
  await new Promise<void>((resolve) => setImmediate(resolve))
  await kernel.activateSession(pointerB.sessionFile)
  assert.equal(kernel.getState().session.id, pointerB.sessionId)

  runtimeA.completeCompact()
  await invocation

  assert.equal(kernel.getState().session.id, pointerB.sessionId)
  assert.equal(
    kernel.getState().conversation.entries.some((entry) =>
      entry.kind === 'command' && entry.text === '/compact Keep decisions'
    ),
    false
  )

  await kernel.activateSession(pointerA.sessionFile)
  assert.equal(
    kernel.getState().conversation.entries.some((entry) =>
      entry.kind === 'command' && entry.text === '/compact Keep decisions'
    ),
    true
  )
  assert.equal(kernel.getState().session.compaction, null)
})

test('Stage 2B process diagnostic during inactive compaction fails only that lifecycle', async () => {
  const pointerA: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/stage2b-compact-crash-a.jsonl',
    sessionId: 'stage2b-compact-crash-a',
    sessionName: 'Crash A'
  }
  const pointerB: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/stage2b-compact-crash-b.jsonl',
    sessionId: 'stage2b-compact-crash-b',
    sessionName: 'Crash B'
  }
  const runtimeA = new DeferredCompactionRuntimeHost({
    sessionId: pointerA.sessionId,
    sessionFile: pointerA.sessionFile,
    sessionName: pointerA.sessionName ?? undefined
  })
  const runtimeB = new FakeRuntimeHost({
    sessionId: pointerB.sessionId,
    sessionFile: pointerB.sessionFile,
    sessionName: pointerB.sessionName ?? undefined
  })
  const runtimes = [runtimeA, runtimeB]
  const kernel = new WorkbenchKernel(
    () => {
      const runtime = runtimes.shift()
      assert.ok(runtime)
      return runtime
    },
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(),
      sessionRegistry: {
        sessions: [pointerA, pointerB],
        activeSessionKey: pointerA.sessionFile
      }
    }
  )

  await kernel.activateSession(pointerA.sessionFile)
  runtimeA.deferCompactEnd()
  const invocation = kernel.invokeCommand(COMPACT_COMMAND_ID, '')
  await new Promise<void>((resolve) => setImmediate(resolve))
  await kernel.activateSession(pointerB.sessionFile)
  const events: KernelEvent[] = []
  const unsubscribe = kernel.subscribe((event) => events.push(event))

  runtimeA.emit({
    type: 'diagnostic',
    kind: 'process',
    message: 'process died during compact',
    stderrChars: 0
  })

  await assert.rejects(invocation, /process died during compact/)
  unsubscribe()

  assert.equal(
    events.filter((event) =>
      event.type === 'kernel.compaction-ended' && event.outcome === 'failed'
    ).length,
    1
  )
  assert.equal(kernel.getState().session.id, pointerB.sessionId)
  assert.equal(kernel.getState().runtime.status, 'ready')
  assert.equal(kernel.getState().session.compaction, null)

  await kernel.activateSession(pointerA.sessionFile)
  assert.equal(kernel.getState().runtime.status, 'crashed')
  assert.equal(kernel.getState().session.compaction, null)
})

test('Stage 2B process-exit during active compaction settles failed exactly once', async () => {
  const runtime = new DeferredCompactionRuntimeHost()
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions()
  )
  await kernel.start()
  runtime.deferCompactEnd()
  const invocation = kernel.invokeCommand(COMPACT_COMMAND_ID, '')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(kernel.getState().session.compaction, { reason: 'manual' })

  const events: KernelEvent[] = []
  kernel.subscribe((event) => events.push(event))
  runtime.emit({ type: 'process-exit', code: 9, signal: null })

  await assert.rejects(invocation, /exited with code 9/)
  assert.equal(
    events.filter((event) =>
      event.type === 'kernel.compaction-ended' && event.outcome === 'failed'
    ).length,
    1
  )
  assert.equal(kernel.getState().session.compaction, null)
  assert.equal(kernel.getState().runtime.status, 'crashed')
})

test('Stage 2B stop during gated compaction projection rejects once and blocks late mutation', async () => {
  const pointerA: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/stage2b-compact-stop-a.jsonl',
    sessionId: 'stage2b-compact-stop-a',
    sessionName: 'Stop A'
  }
  const pointerB: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/stage2b-compact-stop-b.jsonl',
    sessionId: 'stage2b-compact-stop-b',
    sessionName: 'Stop B'
  }
  const runtimeA = new DelayedCompactionProjectionRuntimeHost(
    [{ role: 'assistant', content: [{ type: 'text', text: 'Old A' }], timestamp: 1 }],
    [{ role: 'assistant', content: [{ type: 'text', text: 'Compacted A should not apply' }], timestamp: 3 }]
  )
  // Patch session identity on the delayed host.
  Object.assign((runtimeA as unknown as { sessionState: Record<string, unknown> }).sessionState, {
    sessionId: pointerA.sessionId,
    sessionFile: pointerA.sessionFile,
    sessionName: pointerA.sessionName
  })
  const runtimeB = new FakeRuntimeHost({
    sessionId: pointerB.sessionId,
    sessionFile: pointerB.sessionFile,
    sessionName: pointerB.sessionName ?? undefined,
    messageCount: 1
  }, [{ role: 'assistant', content: [{ type: 'text', text: 'Foreground B' }], timestamp: 2 }])
  const runtimes = [runtimeA, runtimeB]
  const kernel = new WorkbenchKernel(
    () => {
      const runtime = runtimes.shift()
      assert.ok(runtime)
      return runtime
    },
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(),
      sessionRegistry: {
        sessions: [pointerA, pointerB],
        activeSessionKey: pointerA.sessionFile
      }
    }
  )

  await kernel.activateSession(pointerA.sessionFile)
  const invocation = kernel.invokeCommand(COMPACT_COMMAND_ID, '')
  await runtimeA.projectionEntered
  await kernel.activateSession(pointerB.sessionFile)
  const foregroundBefore = kernel.getState().conversation.entries

  const rejected = assert.rejects(invocation, /runtime stopped|session changed|cancelled/i)
  const internals = stage2BInternals(kernel)
  const contextA = internals.contextByRuntime.get(runtimeA)
  assert.ok(contextA)
  await internals.stopContext(contextA)
  await rejected

  runtimeA.releaseProjection()
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))

  assert.equal(kernel.getState().session.id, pointerB.sessionId)
  assert.deepEqual(kernel.getState().conversation.entries, foregroundBefore)
  assert.equal(
    kernel.getState().conversation.entries.some((entry) =>
      entry.kind === 'message' && entry.text === 'Compacted A should not apply'
    ),
    false
  )
})

test('Stage 2B inactive stop uses bounded navigation only', async () => {
  const pointerA: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/stage2b-stop-a.jsonl',
    sessionId: 'stage2b-stop-a',
    sessionName: 'Stop A'
  }
  const pointerB: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/stage2b-stop-b.jsonl',
    sessionId: 'stage2b-stop-b',
    sessionName: 'Stop B'
  }
  const runtimeA = new FakeRuntimeHost({
    sessionId: pointerA.sessionId,
    sessionFile: pointerA.sessionFile,
    sessionName: pointerA.sessionName ?? undefined
  })
  const runtimeB = new FakeRuntimeHost({
    sessionId: pointerB.sessionId,
    sessionFile: pointerB.sessionFile,
    sessionName: pointerB.sessionName ?? undefined
  })
  const runtimes = [runtimeA, runtimeB]
  const kernel = new WorkbenchKernel(
    () => {
      const runtime = runtimes.shift()
      assert.ok(runtime)
      return runtime
    },
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(),
      sessionRegistry: {
        sessions: [pointerA, pointerB],
        activeSessionKey: pointerA.sessionFile
      }
    }
  )

  await kernel.activateSession(pointerA.sessionFile)
  await kernel.activateSession(pointerB.sessionFile)
  assert.equal(kernel.getState().session.id, pointerB.sessionId)

  const spies = installStage2BStructuralSpies(kernel)
  const events: KernelEvent[] = []
  const unsubscribe = kernel.subscribe((event) => events.push(event))
  const internals = stage2BInternals(kernel)
  const contextA = internals.contextByRuntime.get(runtimeA)
  assert.ok(contextA)

  try {
    await internals.stopContext(contextA)
    const changed = events.filter((event) => event.type === 'kernel.state-changed')
    const patched = events.filter((event) => event.type === 'kernel.state-patched')
    // Two real transitions: ready→stopping and stopping→stopped/removed.
    assert.equal(changed.length, 2)
    assert.equal(patched.length, 0)
    assert.equal(spies.loadContextCalls(), 0)
    assert.equal(spies.suppressWrites(), 0)
    assert.equal(kernel.getState().session.id, pointerB.sessionId)
    assert.equal(kernel.getState().runtime.status, 'ready')
    assert.equal(
      kernel.getState().sessions.find((session) => session.key === pointerA.sessionFile)?.runtimeStatus,
      'stopped'
    )
  } finally {
    unsubscribe()
    spies.restore()
  }
})

test('Stage 2B Context event gate and dispatcher have no loadContext or suppressEvents fallback', async () => {
  const source = await import('node:fs/promises').then((fs) =>
    fs.readFile(new URL('./workbench-kernel.ts', import.meta.url), 'utf8')
  )
  const methodBody = (name: string): string => {
    const start = source.indexOf(`private ${name}(`)
    assert.ok(start >= 0)
    const nextPrivate = source.indexOf('\n  private ', start + 1)
    return source.slice(start, nextPrivate === -1 ? undefined : nextPrivate)
  }
  const eventGate = methodBody('handleContextEvent')
  const dispatcher = methodBody('deliverContextEvent')
  for (const body of [eventGate, dispatcher]) {
    assert.equal(body.includes('loadContext'), false)
    assert.equal(body.includes('suppressEvents'), false)
    assert.equal(body.includes('handleInactiveCompactionLegacy'), false)
  }
  assert.equal(eventGate.includes('deferredEvents'), true)
  assert.equal(eventGate.includes('deliverContextEvent'), true)
  assert.equal(dispatcher.includes('handleInactiveRuntimeEvent'), true)
  assert.equal(source.includes('handleInactiveCompactionLegacy'), false)
  assert.equal(source.includes('private suppressEvents'), false)
})

const LIVE_TOOL_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test('tool image attachment changes fall back to full state and never include base64', async () => {
  const runtime = new FakeRuntimeHost({
    sessionId: 'session-1',
    sessionFile: '/tmp/session-1.jsonl',
    thinkingLevel: 'medium',
    isStreaming: false,
    messageCount: 0,
    pendingMessageCount: 0
  })
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions()
  )
  await kernel.start()
  const events: KernelEvent[] = []
  kernel.subscribe((event) => events.push(event))

  runtime.emit({
    type: 'pi-event',
    event: {
      type: 'tool_execution_start',
      toolCallId: 'tool-img-1',
      toolName: 'generate_image',
      args: { prompt: 'cat' }
    }
  })
  runtime.emit({
    type: 'pi-event',
    event: {
      type: 'tool_execution_end',
      toolCallId: 'tool-img-1',
      toolName: 'generate_image',
      isError: false,
      result: {
        content: [
          { type: 'text', text: 'done' },
          { type: 'image', mimeType: 'image/png', data: LIVE_TOOL_PNG }
        ]
      }
    }
  })

  const changed = events.filter((event) => event.type === 'kernel.state-changed')
  assert.ok(changed.length >= 1)
  const state = kernel.getState()
  const tool = state.conversation.entries.find((entry) => entry.kind === 'tool')
  assert.equal(tool?.kind === 'tool' ? tool.attachments?.[0]?.contentIndex : null, 1)
  assert.equal(JSON.stringify(state).includes(LIVE_TOOL_PNG), false)
  assert.equal(JSON.stringify(events).includes(LIVE_TOOL_PNG), false)
})

test('getToolImage reads live runtime messages and short-lived cache after tool end', async () => {
  const pointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/session-tool-img.jsonl',
    sessionId: 'session-tool-img',
    sessionName: 'Tool images'
  }
  const runtime = new FakeRuntimeHost({
    sessionId: pointer.sessionId,
    sessionFile: pointer.sessionFile,
    sessionName: pointer.sessionName ?? undefined,
    thinkingLevel: 'medium',
    isStreaming: false,
    messageCount: 0,
    pendingMessageCount: 0
  })
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(pointer),
      readSessionMessages: async () => {
        throw new Error('history should not be required for live cache path')
      }
    }
  )
  await kernel.activateSession(pointer.sessionFile)

  runtime.emit({
    type: 'pi-event',
    event: {
      type: 'tool_execution_end',
      toolCallId: 'live-img',
      toolName: 'generate_image',
      isError: false,
      result: {
        content: [
          { type: 'text', text: 'ok' },
          { type: 'image', mimeType: 'image/png', data: LIVE_TOOL_PNG }
        ]
      }
    }
  })

  // Immediate open before transcript materializes: Main cache must serve the image.
  const cached = await kernel.getToolImage(pointer.sessionFile, 'live-img', 1)
  assert.equal(cached.mimeType, 'image/png')
  assert.equal(cached.data, LIVE_TOOL_PNG)
  assert.equal(cached.path, '')

  runtime.replaceMessages([
    {
      role: 'toolResult',
      toolCallId: 'live-img',
      content: [
        { type: 'text', text: 'ok' },
        { type: 'image', mimeType: 'image/png', data: LIVE_TOOL_PNG }
      ]
    }
  ])
  const fromRuntime = await kernel.getToolImage(pointer.sessionFile, 'live-img', 1)
  assert.equal(fromRuntime.data, LIVE_TOOL_PNG)
})

test('tool image cache expires and cannot cross the active Project boundary', async () => {
  const pointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/session-tool-cache-boundary.jsonl',
    sessionId: 'session-tool-cache-boundary',
    sessionName: 'Tool image cache boundary'
  }
  const runtimeA = new FakeRuntimeHost({
    sessionId: pointer.sessionId,
    sessionFile: pointer.sessionFile,
    sessionName: pointer.sessionName ?? undefined,
    thinkingLevel: 'medium',
    isStreaming: false,
    messageCount: 0,
    pendingMessageCount: 0
  })
  const runtimeB = new FakeRuntimeHost()
  const runtimes = [runtimeA, runtimeB]
  let now = 1_000
  const kernel = new WorkbenchKernel(
    () => {
      const runtime = runtimes.shift()
      assert.ok(runtime)
      return runtime
    },
    {
      projects: [{ path: '/tmp/project' }, { path: '/tmp/other-project' }],
      activeProjectKey: '/tmp/project'
    },
    {
      ...kernelOptions(pointer),
      now: () => now
    }
  )
  await kernel.activateSession(pointer.sessionFile)

  runtimeA.emit({
    type: 'pi-event',
    event: {
      type: 'tool_execution_end',
      toolCallId: 'cache-boundary',
      toolName: 'generate_image',
      isError: false,
      result: {
        content: [{ type: 'image', mimeType: 'image/png', data: LIVE_TOOL_PNG }]
      }
    }
  })
  assert.equal(
    (await kernel.getToolImage(pointer.sessionFile, 'cache-boundary', 0)).data,
    LIVE_TOOL_PNG
  )

  now += 60_001
  await assert.rejects(
    () => kernel.getToolImage(pointer.sessionFile, 'cache-boundary', 0),
    /not found/i
  )

  now += 1
  runtimeA.emit({
    type: 'pi-event',
    event: {
      type: 'tool_execution_end',
      toolCallId: 'cache-project',
      toolName: 'generate_image',
      isError: false,
      result: {
        content: [
          { type: 'image', mimeType: 'image/png', data: LIVE_TOOL_PNG },
          { type: 'image', mimeType: 'image/png', data: LIVE_TOOL_PNG }
        ]
      }
    }
  })
  runtimeA.emit({
    type: 'pi-event',
    event: {
      type: 'tool_execution_end',
      toolCallId: 'cache-project',
      toolName: 'generate_image',
      isError: false,
      result: {
        content: [{ type: 'image', mimeType: 'image/png', data: LIVE_TOOL_PNG }]
      }
    }
  })
  await assert.rejects(
    () => kernel.getToolImage(pointer.sessionFile, 'cache-project', 1),
    /no longer owned|not found/i
  )
  await kernel.activateProject('/tmp/other-project', sessionRegistry(null))
  await assert.rejects(
    () => kernel.getToolImage(pointer.sessionFile, 'cache-project', 0),
    /unavailable|not registered|active project/i
  )
})

test('getToolImage reads historical toolResult and rejects invalid identity or content', async () => {
  const pointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/session-hist-img.jsonl',
    sessionId: 'session-hist-img',
    sessionName: 'History images'
  }
  const messages = [
    {
      role: 'toolResult',
      toolCallId: 'hist-img',
      content: [
        { type: 'text', text: 'ok' },
        { type: 'image', mimeType: 'image/png', data: LIVE_TOOL_PNG }
      ]
    }
  ]
  const kernel = new WorkbenchKernel(
    () => new FakeRuntimeHost(),
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(pointer),
      readSessionMessages: async () => messages
    }
  )

  const image = await kernel.getToolImage(pointer.sessionFile, 'hist-img', 1)
  assert.equal(image.data, LIVE_TOOL_PNG)
  assert.equal(image.name, 'image-2')

  await assert.rejects(
    () => kernel.getToolImage('relative/session.jsonl', 'hist-img', 1),
    /absolute/i
  )
  await assert.rejects(
    () => kernel.getToolImage(pointer.sessionFile, 'missing', 1),
    /not found/i
  )
  await assert.rejects(
    () => kernel.getToolImage(pointer.sessionFile, 'hist-img', 0),
    /invalid/i
  )
  await assert.rejects(
    () => kernel.getToolImage(pointer.sessionFile, 'hist-img', 99),
    /content index/i
  )
  assert.equal(
    isKernelCommand({
      type: 'kernel.get-tool-image',
      sessionKey: pointer.sessionFile,
      toolCallId: 'hist-img',
      contentIndex: 1
    }),
    true
  )
  assert.equal(
    isKernelCommand({
      type: 'kernel.get-tool-image',
      sessionKey: pointer.sessionFile,
      toolCallId: 'hist-img',
      contentIndex: 64
    }),
    false
  )
})
