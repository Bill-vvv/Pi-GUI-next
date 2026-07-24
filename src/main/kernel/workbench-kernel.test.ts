import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  AppearanceSettings,
  GeneralSettings,
  KernelEvent,
  KernelProjectState,
  RuntimeStatus,
  SessionNamingSettings
} from '../../shared/kernel-contract.ts'
import type { ProjectSessionRegistry, SessionPointer } from '../project/session-pointer.ts'
import type {
  PiRpcAvailableModel,
  PiRpcSessionState,
  PiRpcSessionStats,
  PiRpcSlashCommand
} from '../pi-rpc/pi-rpc-client.ts'
import {
  COMPACT_COMMAND_ID,
  NEW_SESSION_COMMAND_ID,
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
  private readonly sessionState: PiRpcSessionState
  private readonly messages: unknown[]
  private readonly slashCommands: PiRpcSlashCommand[]
  private readonly availableModels: PiRpcAvailableModel[]
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
      const result = await super.send(command)
      this.replaceMessages(this.compactedMessages)
      return result
    }
    if (command.type === 'get_messages' && this.failCompactedMessages) {
      this.failCompactedMessages = false
      throw new Error('compacted messages unavailable')
    }
    return super.send(command)
  }
}

class DelayedStartRuntimeHost extends FakeRuntimeHost {
  readonly startEntered: Promise<void>
  private readonly markStartEntered: () => void
  private readonly startGate: Promise<void>
  private readonly releaseStartGate: () => void

  constructor() {
    super()
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

class FailingCommandRuntimeHost extends FakeRuntimeHost {
  private readonly failingCommand: 'get_state' | 'get_messages' | 'get_commands' | 'get_available_models'

  constructor(failingCommand: 'get_state' | 'get_messages' | 'get_commands' | 'get_available_models') {
    super()
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
    else if (event.patch.runtime !== undefined) statuses.push(event.patch.runtime.status)
  })
  return statuses
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

  assert.deepEqual(kernel.getState().general, { startupWorkspaceRestore: 'restore' })
  await kernel.setGeneral({ startupWorkspaceRestore: 'none' })
  assert.deepEqual(persisted, [{ startupWorkspaceRestore: 'none' }])
  assert.deepEqual(kernel.getState().general, { startupWorkspaceRestore: 'none' })
  await assert.rejects(
    kernel.setGeneral({ startupWorkspaceRestore: 'invalid' } as unknown as GeneralSettings),
    /Invalid general settings/
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
    contextWindow: 200000
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
    contextPercent: 28
  })
  readyState.availableModels[0]!.name = 'mutated copy'
  readyState.availableModels[0]!.thinkingLevelMap.low = 'mutated copy'
  if (readyState.session.model !== null) readyState.session.model.thinkingLevelMap.low = 'mutated copy'
  assert.equal(kernel.getState().availableModels[0]?.name, 'Claude Test')
  assert.equal(kernel.getState().availableModels[0]?.thinkingLevelMap.low, 'low')
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
    contextPercent: 52
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
  assert.deepEqual(kernel.getState().commands.slice(5).map(({ name, source }) => ({ name, source })), [
    { name: 'review', source: 'extension' },
    { name: 'ship', source: 'prompt' },
    { name: 'skill:verify', source: 'skill' }
  ])

  await kernel.invokeCommand(SET_MODEL_COMMAND_ID, 'openrouter/anthropic/claude-test')
  await kernel.invokeCommand(SET_THINKING_COMMAND_ID, 'high')
  await kernel.invokeCommand(COMPACT_COMMAND_ID, 'Preserve decisions')
  await kernel.invokeCommand(SET_SESSION_NAME_COMMAND_ID, 'Release planning')

  assert.deepEqual(runtime.commands.slice(-9), [
    { type: 'set_model', provider: 'openrouter', modelId: 'anthropic/claude-test' },
    { type: 'get_state' },
    { type: 'set_thinking_level', level: 'high' },
    { type: 'get_state' },
    { type: 'compact', customInstructions: 'Preserve decisions' },
    { type: 'get_state' },
    { type: 'get_messages' },
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
  assert.deepEqual(runtime.commands.slice(-3), [
    { type: 'compact' },
    { type: 'get_state' },
    { type: 'get_messages' }
  ])

  const beforeFailure = entries
  runtime.failNextCompactedProjection()
  await assert.rejects(
    kernel.invokeCommand(COMPACT_COMMAND_ID, 'Keep decisions'),
    /compacted messages unavailable/
  )
  entries = kernel.getState().conversation.entries
  assert.deepEqual(entries, beforeFailure)
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
  assert.deepEqual(kernel.getState().projects, [
    { path: '/tmp/project', busySessionCount: 0 },
    { path: '/tmp/next-project', busySessionCount: 0 }
  ])
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
  assert.deepEqual(kernel.getState().projects, [{ path: '/tmp/project', busySessionCount: 0 }])
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
  assert.deepEqual(kernel.getState().projects, [{ path: '/tmp/project', busySessionCount: 0 }])
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

test('Pi lifecycle patches runtime, session, and run boundary without changing state semantics', async () => {
  const runtime = new FakeRuntimeHost()
  const kernel = new WorkbenchKernel(
    () => runtime,
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    kernelOptions()
  )
  await kernel.start()
  const events: KernelEvent[] = []
  kernel.subscribe((event) => events.push(event))

  runtime.emit({ type: 'pi-event', event: { type: 'agent_start' } })
  runtime.emit({ type: 'pi-event', event: { type: 'agent_settled' } })

  assert.equal(events.length, 2)
  const started = events[0]
  assert.equal(started?.type, 'kernel.state-patched')
  if (started?.type === 'kernel.state-patched') {
    assert.equal(started.patch.runtime?.status, 'running')
    assert.equal(started.patch.session?.settled, false)
    assert.equal(started.patch.conversation?.activeRunStartIndex, 0)
    assert.equal(started.patch.conversation?.entries, undefined)
  }
  const settled = events[1]
  assert.equal(settled?.type, 'kernel.state-changed')
  if (settled?.type === 'kernel.state-changed') {
    assert.equal(settled.state.runtime.status, 'ready')
    assert.equal(settled.state.session.settled, true)
    assert.equal(settled.state.session.pendingMessageCount, 0)
    assert.equal(settled.state.conversation.activeRunStartIndex, null)
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

test('session summaries refresh activity time from the configured metadata reader', async () => {
  const pointer: SessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/session.jsonl',
    sessionId: 'session-1',
    sessionName: 'Session'
  }
  const kernel = new WorkbenchKernel(
    () => new FakeRuntimeHost(),
    { projects: [{ path: '/tmp/project' }], activeProjectKey: '/tmp/project' },
    {
      ...kernelOptions(pointer),
      readSessionActivityAt: async () => 1_784_630_000_000
    }
  )

  await kernel.refreshSessionActivities()

  assert.equal(kernel.getState().sessions[0]?.lastActivityAt, 1_784_630_000_000)
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
    runtimeStatus: 'stopped'
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
    runtimeStatus: 'ready'
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
    runtimeStatus: 'running'
  }])
  assert.equal(typeof state.sessions[0]?.lastActivityAt, 'number')
  assert.equal(state.activeSessionKey, canonicalPointer.sessionFile)
  assert.equal(state.session.resumeAvailable, true)
  assert.equal(state.session.settled, true)
  assert.equal(state.runtime.status, 'ready')
  assert.equal(runtime.commands.some(({ type }) => type === 'set_session_name'), false)
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
    { sessionFile: firstPointer.sessionFile },
    { sessionFile: secondPointer.sessionFile }
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

test('reordering projects and sessions persists and preserves active identities', async () => {
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
  const persistedSessionOrders: Array<{ projectPath: string, sessionKeys: string[] }> = []
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
      },
      persistSessionOrder: async (projectPath, sessionKeys) => {
        persistedSessionOrders.push({ projectPath, sessionKeys })
      }
    }
  )

  await kernel.reorderProjects(['/tmp/next-project', '/tmp/project'])
  await kernel.reorderSessions([secondPointer.sessionFile, firstPointer.sessionFile])

  const state = kernel.getState()
  assert.deepEqual(persistedProjectOrders, [['/tmp/next-project', '/tmp/project']])
  assert.deepEqual(persistedSessionOrders, [{
    projectPath: '/tmp/project',
    sessionKeys: [secondPointer.sessionFile, firstPointer.sessionFile]
  }])
  assert.deepEqual(state.projects.map(({ path }) => path), ['/tmp/next-project', '/tmp/project'])
  assert.deepEqual(state.sessions.map(({ key }) => key), [
    secondPointer.sessionFile,
    firstPointer.sessionFile
  ])
  assert.equal(state.activeProjectKey, '/tmp/project')
  assert.equal(state.activeSessionKey, firstPointer.sessionFile)
})

test('reordering fails fast for duplicate, omitted, or unknown keys without persistence', async () => {
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
  let persistProjectOrderCalls = 0
  let persistSessionOrderCalls = 0
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
      persistProjectOrder: async () => {
        persistProjectOrderCalls += 1
      },
      persistSessionOrder: async () => {
        persistSessionOrderCalls += 1
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
  for (const invalidOrder of [
    [firstPointer.sessionFile, firstPointer.sessionFile],
    [firstPointer.sessionFile],
    [firstPointer.sessionFile, '/tmp/unknown-session.jsonl']
  ]) {
    await assert.rejects(kernel.reorderSessions(invalidOrder), /Invalid session order/)
  }

  assert.equal(persistProjectOrderCalls, 0)
  assert.equal(persistSessionOrderCalls, 0)
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
  assert.deepEqual(launches, [{}])
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

  assert.deepEqual(launches, [{ sessionFile: pointer.sessionFile }])
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
  assert.deepEqual(kernel.getState().projects, [
    { path: '/tmp/project-a', busySessionCount: 1 },
    { path: '/tmp/project-b', busySessionCount: 0 }
  ])

  const events: KernelEvent[] = []
  kernel.subscribe((event) => events.push(event))
  runtime.emit({ type: 'activity-settled' })

  assert.equal(events.length, 1)
  assert.equal(events[0]?.type, 'kernel.state-changed')
  if (events[0]?.type === 'kernel.state-changed') {
    assert.deepEqual(events[0].state.projects, [
      { path: '/tmp/project-a', busySessionCount: 0 },
      { path: '/tmp/project-b', busySessionCount: 0 }
    ])
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
