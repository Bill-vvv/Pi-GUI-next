import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  AppearanceSettings,
  GeneralSettings,
  KernelEvent,
  KernelProjectState,
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
    sessionStats?: PiRpcSessionStats
  ) {
    this.sessionState = sessionState
    this.messages = messages
    this.slashCommands = slashCommands
    this.availableModels = availableModels
    this.sessionStats = sessionStats
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

test('normal start and stop follows the lifecycle', async () => {
  const runtime = new FakeRuntimeHost()
  const kernel = new WorkbenchKernel(() => runtime, { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' }, kernelOptions())
  const statuses = collectStatuses(kernel)

  await kernel.start()
  await kernel.stop()

  assert.deepEqual(statuses, ['starting', 'ready', 'stopping', 'stopped'])
  assert.equal(kernel.getState().runtime.status, 'stopped')
})

test('appearance settings persist strict theme, accent, transparency, and text size changes', async () => {
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
    uiFontFamily: null,
    codeFontFamily: null
  })
  await kernel.setAppearance({
    theme: 'dark',
    accentColor: 'blue',
    surfaceTransparency: 30,
    textSize: 'large',
    uiFontFamily: null,
    codeFontFamily: null
  })
  assert.deepEqual(persisted, [{
    theme: 'dark',
    accentColor: 'blue',
    surfaceTransparency: 30,
    textSize: 'large',
    uiFontFamily: null,
    codeFontFamily: null
  }])
  await assert.rejects(
    kernel.setAppearance({
      theme: 'sepia',
      accentColor: 'amber',
      surfaceTransparency: 20,
      textSize: 'default',
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

  assert.deepEqual(kernel.getState().general, { startupWorkspaceRestore: 'restore', doubleClickBorderMaximize: true })
  await kernel.setGeneral({ startupWorkspaceRestore: 'none', doubleClickBorderMaximize: true })
  assert.deepEqual(persisted, [{ startupWorkspaceRestore: 'none', doubleClickBorderMaximize: true }])
  assert.deepEqual(kernel.getState().general, { startupWorkspaceRestore: 'none', doubleClickBorderMaximize: true })
  await assert.rejects(
    kernel.setGeneral({ startupWorkspaceRestore: 'invalid', doubleClickBorderMaximize: true } as unknown as GeneralSettings),
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
    doubleClickBorderMaximize: false
  })
  assert.deepEqual(persisted, [{
    startupWorkspaceRestore: 'restore',
    doubleClickBorderMaximize: false
  }])
  assert.equal(kernel.getState().general.doubleClickBorderMaximize, false)
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
  await kernel.setSubagent({ maxDepth: 2, preventCycles: false })
  assert.deepEqual(persisted, [{ maxDepth: 2, preventCycles: false }])
  assert.deepEqual(kernel.getState().subagent, { maxDepth: 2, preventCycles: false })
  rejectPersistence = true
  await assert.rejects(
    kernel.setSubagent({ maxDepth: 1, preventCycles: true }),
    /subagent persistence failed/u
  )
  assert.deepEqual(kernel.getState().subagent, { maxDepth: 2, preventCycles: false })
  await assert.rejects(
    kernel.setSubagent({ maxDepth: 4 as 1, preventCycles: true }),
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

test('discovers the normalized command catalog and routes typed commands', async () => {
  const runtime = new FakeRuntimeHost(
    undefined,
    [],
    [
      { name: 'review', description: 'Review changes', source: 'extension' },
      { name: 'ship', description: 'Prepare release', source: 'prompt' },
      { name: 'skill:verify', source: 'skill' }
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
  assert.equal(entries.length, 1)
  assert.equal(entries[0]?.kind === 'message' ? entries[0].text : null, 'Compacted summary')
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
      { name: 'review', source: 'extension' },
      { name: 'ship', source: 'prompt' }
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
  assert.ok(extension)
  assert.ok(prompt)

  await kernel.invokeCommand(extension.id, 'current diff')
  assert.equal(kernel.getState().runtime.status, 'ready')
  assert.deepEqual(runtime.commands.slice(-2), [
    { type: 'prompt', message: '/review current diff' },
    { type: 'get_state' }
  ])

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

  await kernel.start()

  const state = kernel.getState()
  assert.equal(state.runtime.status, 'ready')
  assert.equal(state.session.id, 'provisional-session')
  assert.equal(state.session.resumeAvailable, false)
  assert.equal(state.activeSessionKey, null)
  assert.deepEqual(state.sessions, [{
    key: existingPointer.sessionFile,
    id: existingPointer.sessionId,
    name: existingPointer.sessionName,
    lastActivityAt: null,
    runtimeStatus: 'stopped',
    statistics: null
  }])
  assert.deepEqual(persisted, [])

  await kernel.prompt('Write the first turn')
  assert.deepEqual(runtime.commands.at(-1), { type: 'prompt', message: 'Write the first turn' })
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
  assert.equal(kernel.getState().activeSessionKey, null)
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
      }
    }
  )

  await kernel.activateSession(firstPointer.sessionFile)
  await kernel.activateSession(secondPointer.sessionFile)

  assert.equal(firstRuntime.stopCalls, 0)
  assert.deepEqual(launches, [
    { sessionFile: firstPointer.sessionFile, subagent: DEFAULT_SUBAGENT_SETTINGS },
    { sessionFile: secondPointer.sessionFile, subagent: DEFAULT_SUBAGENT_SETTINGS }
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

test('explicit resume after a crash reuses the managed crashed runtime', async () => {
  const firstRuntime = new FakeRuntimeHost()
  const resumedRuntime = new FakeRuntimeHost(
    {
      sessionId: 'session-1',
      sessionFile: '/tmp/session-1.jsonl',
      sessionName: 'Resumed session'
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
    kernelOptions()
  )

  await kernel.start()
  firstRuntime.emit({ type: 'process-exit', code: 7, signal: null })
  await kernel.resumeSession()

  assert.equal(kernel.getState().runtime.status, 'crashed')
  assert.deepEqual(launches, [{ subagent: DEFAULT_SUBAGENT_SETTINGS }])
  assert.equal(resumedRuntime.startCalls, 0)
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
    subagent: DEFAULT_SUBAGENT_SETTINGS
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
  runtimeA.emit({
    type: 'pi-event',
    event: {
      type: 'message_update',
      message: { role: 'assistant', content: [{ type: 'text', text: 'A background' }], timestamp: 10 }
    }
  })
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
  const backgroundEntry = kernel.getState().conversation.entries[0]
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
      }
    }
  )

  await kernel.start()
  await kernel.prompt('Materialize A')
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
          ? { subagent: DEFAULT_SUBAGENT_SETTINGS }
          : { projectTrust: scenario.override, subagent: DEFAULT_SUBAGENT_SETTINGS }
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
  assert.deepEqual(launches, [{ subagent: DEFAULT_SUBAGENT_SETTINGS }])
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
  assert.deepEqual(launches, [{ subagent: DEFAULT_SUBAGENT_SETTINGS }])
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
    [{ name: 'fresh', source: 'extension' }],
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
    reloadedA.commands.slice(0, 4).map(({ type }) => type),
    ['get_state', 'get_messages', 'get_commands', 'get_available_models']
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
    assert.equal(kernel.getState().activeSessionKey, null)
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
      { type: 'fork', entryId: 'selected-user' }
    ]
  )
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

  await assert.rejects(kernel.forkSession('selected-user'), /forked messages unavailable/)

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
