import assert from 'node:assert/strict'
import test from 'node:test'
import type { KernelEvent, RuntimeStatus } from '../../shared/kernel-contract.ts'
import type { RecentSessionPointer } from '../project/project-store.ts'
import type { PiRpcSessionState } from '../pi-rpc/pi-rpc-client.ts'
import { WorkbenchKernel } from './workbench-kernel.ts'
import type {
  RuntimeCommand,
  RuntimeCommandResult,
  RuntimeHost,
  RuntimeHostEvent,
  RuntimeHostState
} from '../runtime/runtime-host.ts'

class FakeRuntimeHost implements RuntimeHost {
  private readonly listeners = new Set<(event: RuntimeHostEvent) => void>()
  readonly commands: RuntimeCommand[] = []
  startCalls = 0
  stopCalls = 0
  private readonly sessionState: PiRpcSessionState
  private readonly messages: unknown[]
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
    messages: unknown[] = []
  ) {
    this.sessionState = sessionState
    this.messages = messages
  }

  async start(): Promise<void> {
    this.startCalls += 1
  }

  async send(command: RuntimeCommand): Promise<RuntimeCommandResult> {
    this.commands.push(command)
    if (command.type === 'get_state') {
      return {
        type: 'state',
        state: this.sessionState
      }
    }
    if (command.type === 'get_messages') return { type: 'messages', messages: this.messages }
    if (command.type === 'set_model') {
      return {
        type: 'model',
        model: { id: command.modelId, provider: command.provider }
      }
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
  private readonly failingCommand: 'get_state' | 'get_messages'

  constructor(failingCommand: 'get_state' | 'get_messages') {
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
  recentSession: RecentSessionPointer | null = null,
  persisted: RecentSessionPointer[] = []
): {
  recentSession: RecentSessionPointer | null
  persistRecentSession: (pointer: RecentSessionPointer) => Promise<void>
  validateRecentSession: (pointer: RecentSessionPointer) => Promise<void>
} {
  return {
    recentSession,
    validateRecentSession: async () => {},
    persistRecentSession: async (pointer) => {
      persisted.push(pointer)
    }
  }
}

test('normal start and stop follows the lifecycle', async () => {
  const runtime = new FakeRuntimeHost()
  const kernel = new WorkbenchKernel(() => runtime, {
    path: '/tmp/project'
  }, kernelOptions())
  const statuses = collectStatuses(kernel)

  await kernel.start()
  await kernel.stop()

  assert.deepEqual(statuses, ['starting', 'ready', 'stopping', 'stopped'])
  assert.equal(kernel.getState().runtime.status, 'stopped')
})

test('stop during start cancels the old start without reviving the runtime', async () => {
  const runtime = new DelayedStartRuntimeHost()
  const kernel = new WorkbenchKernel(() => runtime, {
    path: '/tmp/project'
  }, kernelOptions())
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
  kernel.setProject('/tmp/next-project', null)
  assert.equal(kernel.getState().project.path, '/tmp/next-project')
})

test('activity transitions ready to running and back to ready', async () => {
  const runtime = new FakeRuntimeHost()
  const kernel = new WorkbenchKernel(() => runtime, {
    path: '/tmp/project'
  }, kernelOptions())
  const statuses = collectStatuses(kernel)

  await kernel.start()
  runtime.emit({ type: 'activity-started' })
  runtime.emit({ type: 'activity-settled' })

  assert.deepEqual(statuses, ['starting', 'ready', 'running', 'ready'])
})

test('unexpected exit crashes and later activity cannot make it running', async () => {
  const runtime = new FakeRuntimeHost()
  const kernel = new WorkbenchKernel(() => runtime, {
    path: '/tmp/project'
  }, kernelOptions())

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
    { path: '/tmp/project' },
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
  const kernel = new WorkbenchKernel((project) => {
    receivedProject = project
    return runtime
  }, { path: null }, kernelOptions())

  await assert.rejects(kernel.start(), /Select a project directory/)

  kernel.setProject('/tmp/project', null)
  await kernel.start()

  assert.deepEqual(receivedProject, { path: '/tmp/project' })
  assert.deepEqual(kernel.getState().project, { path: '/tmp/project' })
})

test('projects streaming messages and tools without duplication and settles only on agent_settled', async () => {
  const runtime = new FakeRuntimeHost()
  const kernel = new WorkbenchKernel(() => runtime, {
    path: '/tmp/project'
  }, kernelOptions())

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

test('settling after abort marks a tool without an end event as error', async () => {
  const runtime = new FakeRuntimeHost()
  const kernel = new WorkbenchKernel(
    () => runtime,
    { path: '/tmp/project' },
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
    { path: '/tmp/project' },
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
    { path: '/tmp/project' },
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

test('Pi lifecycle patches runtime, session, and run boundary without changing state semantics', async () => {
  const runtime = new FakeRuntimeHost()
  const kernel = new WorkbenchKernel(
    () => runtime,
    { path: '/tmp/project' },
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
  assert.equal(settled?.type, 'kernel.state-patched')
  if (settled?.type === 'kernel.state-patched') {
    assert.equal(settled.patch.runtime?.status, 'ready')
    assert.equal(settled.patch.session?.settled, true)
    assert.equal(settled.patch.session?.pendingMessageCount, 0)
    assert.equal(settled.patch.conversation?.activeRunStartIndex, null)
  }
  assert.equal(kernel.getState().runtime.status, 'ready')
  assert.equal(kernel.getState().session.settled, true)
  assert.equal(kernel.getState().conversation.activeRunStartIndex, null)
})

test('low-frequency activity lifecycle keeps the full-state fallback', async () => {
  const runtime = new FakeRuntimeHost()
  const kernel = new WorkbenchKernel(
    () => runtime,
    { path: '/tmp/project' },
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

test('new session persists its recent-session pointer', async () => {
  const runtime = new FakeRuntimeHost({
    sessionId: 'new-session',
    sessionFile: '/tmp/new-session.jsonl',
    sessionName: 'New session'
  })
  const persisted: RecentSessionPointer[] = []
  const kernel = new WorkbenchKernel(
    () => runtime,
    { path: '/tmp/project' },
    kernelOptions(null, persisted)
  )

  await kernel.start()

  assert.deepEqual(persisted, [{
    projectPath: '/tmp/project',
    sessionFile: '/tmp/new-session.jsonl',
    sessionId: 'new-session',
    sessionName: 'New session'
  }])
  assert.equal(kernel.getState().session.resumeAvailable, true)
})

test('explicit resume after a crash creates a new runtime and rebuilds messages', async () => {
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
    { path: '/tmp/project' },
    kernelOptions()
  )

  await kernel.start()
  firstRuntime.emit({ type: 'process-exit', code: 7, signal: null })
  await kernel.resumeSession()

  assert.equal(kernel.getState().runtime.status, 'ready')
  assert.deepEqual(launches, [{}, { sessionFile: '/tmp/session-1.jsonl' }])
  assert.equal(kernel.getState().conversation.entries.length, 1)
  const recoveredEntry = kernel.getState().conversation.entries[0]
  assert.equal(recoveredEntry?.kind, 'message')
  assert.equal(recoveredEntry?.kind === 'message' ? recoveredEntry.text : null, 'Recovered')
})

test('a stored pointer is resumable from a stopped kernel relaunch', async () => {
  const pointer: RecentSessionPointer = {
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
    { path: '/tmp/project' },
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
    { path: '/tmp/project' },
    kernelOptions()
  )
  await assert.rejects(noPointerKernel.resumeSession(), /No recent session/)

  const pointer: RecentSessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/session-1.jsonl',
    sessionId: 'session-1',
    sessionName: null
  }
  const activeKernel = new WorkbenchKernel(
    () => runtime,
    { path: '/tmp/project' },
    kernelOptions(pointer)
  )
  await activeKernel.start()
  await assert.rejects(activeKernel.resumeSession(), /while runtime is ready/)
})

test('startup persistence and message failures stop and release the runtime', async (t) => {
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
      { path: '/tmp/project' },
      {
        recentSession: null,
        validateRecentSession: async () => {},
        persistRecentSession: async () => {
          throw new Error('persist failed')
        }
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
    const kernel = new WorkbenchKernel(
      () => runtime,
      { path: '/tmp/project' },
      kernelOptions()
    )

    await assert.rejects(kernel.start(), /get_messages failed/)
    assert.equal(runtime.stopCalls, 1)
    assert.equal(kernel.getState().runtime.status, 'crashed')
    await kernel.stop()
    assert.equal(kernel.getState().runtime.status, 'stopped')
  })
})

test('resume requires a validator before creating a runtime', async () => {
  const pointer: RecentSessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/session-1.jsonl',
    sessionId: 'session-1',
    sessionName: null
  }
  let createCalls = 0
  const options = {
    recentSession: pointer,
    persistRecentSession: async () => {}
  } as unknown as ConstructorParameters<typeof WorkbenchKernel>[2]
  const kernel = new WorkbenchKernel(
    () => {
      createCalls += 1
      return new FakeRuntimeHost()
    },
    { path: '/tmp/project' },
    options
  )

  await assert.rejects(kernel.resumeSession(), /validation is unavailable/)
  assert.equal(createCalls, 0)
})

test('resume validation failure preserves the pointer without creating a runtime', async () => {
  const pointer: RecentSessionPointer = {
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
    { path: '/tmp/project' },
    {
      recentSession: pointer,
      persistRecentSession: async () => {},
      validateRecentSession: async () => {
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
  const pointer: RecentSessionPointer = {
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
    { path: '/tmp/project' },
    {
      recentSession: pointer,
      persistRecentSession: async () => {},
      validateRecentSession: async () => {
        validationEntered()
        await validationGate
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
  const pointer: RecentSessionPointer = {
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
    { path: '/tmp/project' },
    {
      recentSession: pointer,
      persistRecentSession: async () => {},
      validateRecentSession: async () => {
        validationEntered()
        await validationGate
      }
    }
  )

  const resumePromise = kernel.resumeSession()
  await entered
  assert.throws(() => kernel.setProject('/tmp/next-project', null), /launch is in progress/)
  const stopPromise = kernel.stop()
  releaseValidation()

  await assert.rejects(resumePromise, /cancelled/)
  await stopPromise
  assert.equal(createCalls, 0)
  assert.equal(kernel.getState().runtime.status, 'stopped')
  assert.equal(kernel.getState().project.path, '/tmp/project')
})

test('stop during crashed runtime disposal settles at stopped without launching a replacement', async () => {
  const crashedRuntime = new DelayedStopRuntimeHost()
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
    { path: '/tmp/project' },
    kernelOptions()
  )

  await kernel.start()
  crashedRuntime.emit({ type: 'process-exit', code: 9, signal: null })
  const restartPromise = kernel.start()
  await crashedRuntime.stopEntered
  const stopPromise = kernel.stop()
  crashedRuntime.releaseStop()

  await assert.rejects(restartPromise, /cancelled/)
  await stopPromise
  assert.equal(createCalls, 1)
  assert.equal(kernel.getState().runtime.status, 'stopped')
})

test('failed launch cleanup keeps runtime ownership so stop can be retried', async () => {
  const runtime = new FailingThenStoppingRuntimeHost()
  const kernel = new WorkbenchKernel(
    () => runtime,
    { path: '/tmp/project' },
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
  const pointer: RecentSessionPointer = {
    projectPath: '/tmp/project',
    sessionFile: '/tmp/stored-session.jsonl',
    sessionId: 'stored-session',
    sessionName: 'Stored session'
  }
  const persisted: RecentSessionPointer[] = []
  const runtime = new FakeRuntimeHost({
    sessionId: 'different-session',
    sessionFile: '/tmp/different-session.jsonl'
  })
  const kernel = new WorkbenchKernel(
    () => runtime,
    { path: '/tmp/project' },
    kernelOptions(pointer, persisted)
  )

  await assert.rejects(kernel.resumeSession(), /session ID mismatch/i)

  assert.equal(runtime.stopCalls, 1)
  assert.deepEqual(persisted, [])
  assert.equal(kernel.getState().session.id, pointer.sessionId)
  assert.equal(kernel.getState().session.resumeAvailable, true)
  assert.equal(kernel.getState().runtime.status, 'crashed')
})

test('a crashed kernel without a pointer can explicitly start a new runtime', async () => {
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
    { path: '/tmp/project' },
    kernelOptions()
  )

  await kernel.start()
  firstRuntime.emit({ type: 'process-exit', code: 7, signal: null })
  await kernel.start()

  assert.equal(firstRuntime.stopCalls, 1)
  assert.equal(secondRuntime.startCalls, 1)
  assert.equal(kernel.getState().runtime.status, 'ready')
  assert.equal(kernel.getState().session.id, 'session-2')
})

test('delayed activity and Pi events cannot revive a stopping runtime', async () => {
  const runtime = new DelayedStopRuntimeHost()
  const kernel = new WorkbenchKernel(
    () => runtime,
    { path: '/tmp/project' },
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
