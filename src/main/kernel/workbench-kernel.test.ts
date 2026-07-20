import assert from 'node:assert/strict'
import test from 'node:test'
import type { KernelEvent, RuntimeStatus } from '../../shared/kernel-contract.ts'
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
  private state: RuntimeHostState = {
    executable: '/usr/bin/pi',
    version: '0.80.10',
    stderrChars: 0,
    lastError: null,
    exitCode: null,
    exitSignal: null
  }

  async start(): Promise<void> {}

  async send(command: RuntimeCommand): Promise<RuntimeCommandResult> {
    this.commands.push(command)
    if (command.type === 'get_state') {
      return {
        type: 'state',
        state: {
          sessionId: 'session-1',
          thinkingLevel: 'medium',
          isStreaming: false,
          messageCount: 0,
          pendingMessageCount: 0
        }
      }
    }
    if (command.type === 'get_messages') return { type: 'messages', messages: [] }
    if (command.type === 'set_model') {
      return {
        type: 'model',
        model: { id: command.modelId, provider: command.provider }
      }
    }
    return { type: 'accepted' }
  }

  async stop(): Promise<void> {}

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
    this.markStartEntered()
    await this.startGate
  }

  releaseStart(): void {
    this.releaseStartGate()
  }
}

function collectStatuses(kernel: WorkbenchKernel): RuntimeStatus[] {
  const statuses: RuntimeStatus[] = []
  kernel.subscribe((event: KernelEvent) => statuses.push(event.state.runtime.status))
  return statuses
}

test('normal start and stop follows the lifecycle', async () => {
  const runtime = new FakeRuntimeHost()
  const kernel = new WorkbenchKernel(() => runtime, {
    path: '/tmp/project',
    trust: 'untrusted'
  })
  const statuses = collectStatuses(kernel)

  await kernel.start()
  await kernel.stop()

  assert.deepEqual(statuses, ['starting', 'ready', 'stopping', 'stopped'])
  assert.equal(kernel.getState().runtime.status, 'stopped')
})

test('stop during start cancels the old start without reviving the runtime', async () => {
  const runtime = new DelayedStartRuntimeHost()
  const kernel = new WorkbenchKernel(() => runtime, {
    path: '/tmp/project',
    trust: 'untrusted'
  })
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
  kernel.setProject('/tmp/next-project')
  assert.equal(kernel.getState().project.path, '/tmp/next-project')
})

test('activity transitions ready to running and back to ready', async () => {
  const runtime = new FakeRuntimeHost()
  const kernel = new WorkbenchKernel(() => runtime, {
    path: '/tmp/project',
    trust: 'untrusted'
  })
  const statuses = collectStatuses(kernel)

  await kernel.start()
  runtime.emit({ type: 'activity-started' })
  runtime.emit({ type: 'activity-settled' })

  assert.deepEqual(statuses, ['starting', 'ready', 'running', 'ready'])
})

test('unexpected exit crashes and later activity cannot make it running', async () => {
  const runtime = new FakeRuntimeHost()
  const kernel = new WorkbenchKernel(() => runtime, {
    path: '/tmp/project',
    trust: 'untrusted'
  })

  await kernel.start()
  runtime.emit({ type: 'process-exit', code: 7, signal: null })
  runtime.emit({ type: 'activity-started' })

  const state = kernel.getState().runtime
  assert.equal(state.status, 'crashed')
  assert.equal(state.exitCode, 7)
  assert.equal(state.lastError, 'Pi RPC process exited with code 7.')
})

test('project path and trust are required and passed to the runtime factory', async () => {
  const runtime = new FakeRuntimeHost()
  let receivedProject: { path: string; trust: 'trusted' | 'untrusted' } | null = null
  const kernel = new WorkbenchKernel((project) => {
    receivedProject = project
    return runtime
  })

  assert.throws(() => kernel.setProjectTrust('trusted'), /Select a project directory/)
  await assert.rejects(kernel.start(), /Select a project directory/)

  kernel.setProject('/tmp/project')
  kernel.setProjectTrust('trusted')
  await kernel.start()

  assert.deepEqual(receivedProject, { path: '/tmp/project', trust: 'trusted' })
  assert.deepEqual(kernel.getState().project, { path: '/tmp/project', trust: 'trusted' })
})

test('projects streaming messages and tools without duplication and settles only on agent_settled', async () => {
  const runtime = new FakeRuntimeHost()
  const kernel = new WorkbenchKernel(() => runtime, {
    path: '/tmp/project',
    trust: 'trusted'
  })

  await kernel.start()
  await kernel.prompt('Inspect package.json')
  assert.equal(kernel.getState().runtime.status, 'running')

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

  await kernel.abort()
  runtime.emit({ type: 'pi-event', event: { type: 'agent_end', messages: [], willRetry: false } })
  assert.equal(kernel.getState().runtime.status, 'running')
  runtime.emit({ type: 'pi-event', event: { type: 'agent_settled' } })

  const state = kernel.getState()
  const assistantMessages = state.conversation.entries.filter(
    (entry) => entry.kind === 'message' && entry.role === 'assistant'
  )
  const tools = state.conversation.entries.filter((entry) => entry.kind === 'tool')
  assert.equal(assistantMessages.length, 1)
  assert.equal(assistantMessages[0]?.kind === 'message' ? assistantMessages[0].text : null, 'Hello')
  assert.equal(tools.length, 1)
  assert.equal(tools[0]?.kind === 'tool' ? tools[0].status : null, 'success')
  assert.equal(tools[0]?.kind === 'tool' ? tools[0].output : null, '{"name":"pi-gui"}')
  assert.equal(state.runtime.status, 'ready')
  assert.equal(state.session.settled, true)
  assert.deepEqual(runtime.commands.slice(-2), [
    { type: 'prompt', message: 'Inspect package.json' },
    { type: 'abort' }
  ])
})
