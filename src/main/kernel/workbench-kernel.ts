import type {
  KernelEvent,
  KernelModelState,
  KernelProjectState,
  KernelSessionState,
  KernelState,
  ProjectTrust,
  RuntimeStatus,
  ThinkingLevel
} from '../../shared/kernel-contract.ts'
import type { PiRpcEvent, PiRpcSessionState } from '../pi-rpc/pi-rpc-client.ts'
import type { RuntimeHost, RuntimeHostEvent, RuntimeHostState } from '../runtime/runtime-host.ts'
import { projectMessages, projectPiEvent } from './conversation-projection.ts'

const INITIAL_HOST_STATE: RuntimeHostState = {
  executable: null,
  version: null,
  stderrChars: 0,
  lastError: null,
  exitCode: null,
  exitSignal: null
}

const INITIAL_SESSION_STATE: KernelSessionState = {
  id: null,
  name: null,
  model: null,
  thinkingLevel: null,
  messageCount: 0,
  pendingMessageCount: 0,
  settled: true
}

export type RuntimeFactory = (project: { path: string; trust: ProjectTrust }) => RuntimeHost

export class WorkbenchKernel {
  private readonly createRuntime: RuntimeFactory
  private readonly listeners = new Set<(event: KernelEvent) => void>()
  private runtime: RuntimeHost | null = null
  private unsubscribeRuntime: (() => void) | null = null
  private state: KernelState
  private stopRequested = false

  constructor(createRuntime: RuntimeFactory, project: KernelProjectState = { path: null, trust: null }) {
    this.createRuntime = createRuntime
    this.state = initialKernelState(project)
  }

  getState(): KernelState {
    return copyState(this.state)
  }

  subscribe(listener: (event: KernelEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setProject(path: string): void {
    this.assertProjectEditable()
    const trust = this.state.project.path === path ? this.state.project.trust : null
    this.state = initialKernelState({ path, trust })
    this.emitState()
  }

  setProjectTrust(trust: ProjectTrust): void {
    this.assertProjectEditable()
    if (this.state.project.path === null) {
      throw new Error('Select a project directory before choosing trust.')
    }
    this.state = initialKernelState({ path: this.state.project.path, trust })
    this.emitState()
  }

  async start(): Promise<void> {
    if (this.state.runtime.status !== 'stopped') {
      throw new Error(`Cannot start runtime while it is ${this.state.runtime.status}.`)
    }
    const project = configuredProject(this.state.project)
    const runtime = this.createRuntime(project)
    this.runtime = runtime
    this.unsubscribeRuntime = runtime.subscribe((event) => {
      if (this.runtime === runtime) this.handleRuntimeEvent(event)
    })

    this.stopRequested = false
    this.transition('starting')
    try {
      await runtime.start()
      this.assertStartActive(runtime)
      const stateAfterRuntimeStart = this.getState()
      if (stateAfterRuntimeStart.runtime.status === 'crashed') {
        throw new Error(stateAfterRuntimeStart.runtime.lastError ?? 'Runtime exited while starting.')
      }

      const stateResult = await runtime.send({ type: 'get_state' })
      this.assertStartActive(runtime)
      const messagesResult = await runtime.send({ type: 'get_messages' })
      this.assertStartActive(runtime)
      if (stateResult.type !== 'state' || messagesResult.type !== 'messages') {
        throw new Error('Runtime returned an invalid startup projection.')
      }
      const stateAfterProjection = this.getState()
      if (stateAfterProjection.runtime.status === 'crashed') {
        throw new Error(stateAfterProjection.runtime.lastError ?? 'Runtime exited while starting.')
      }

      this.state = {
        ...this.state,
        runtime: toKernelRuntime('ready', runtime.getState()),
        session: toKernelSession(stateResult.state),
        conversation: { entries: projectMessages(messagesResult.messages) }
      }
      this.emitState()
    } catch (error) {
      if (!this.isStartActive(runtime)) {
        throw new Error('Runtime start cancelled.')
      }
      if (this.state.runtime.status !== 'crashed') {
        this.transition('crashed', errorMessage(error))
      }
      throw error
    }
  }

  async prompt(message: string): Promise<void> {
    const runtime = this.requireRuntime('ready')
    if (message.trim().length === 0) throw new Error('Prompt must not be empty.')

    this.state = {
      ...this.state,
      runtime: toKernelRuntime('running', runtime.getState()),
      session: { ...this.state.session, settled: false }
    }
    this.emitState()
    try {
      await runtime.send({ type: 'prompt', message })
    } catch (error) {
      this.state = {
        ...this.state,
        runtime: toKernelRuntime('ready', runtime.getState(), errorMessage(error)),
        session: { ...this.state.session, settled: true }
      }
      this.emitState()
      throw error
    }
  }

  async abort(): Promise<void> {
    const runtime = this.requireRuntime('running')
    await runtime.send({ type: 'abort' })
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    const runtime = this.requireRuntime('ready')
    if (provider.trim().length === 0 || modelId.trim().length === 0) {
      throw new Error('Provider and model ID must not be empty.')
    }
    await runtime.send({ type: 'set_model', provider, modelId })
    await this.refreshSessionState(runtime)
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    const runtime = this.requireRuntime('ready')
    await runtime.send({ type: 'set_thinking_level', level })
    await this.refreshSessionState(runtime)
  }

  async stop(): Promise<void> {
    this.stopRequested = true
    if (this.state.runtime.status === 'stopped') {
      this.stopRequested = false
      return
    }
    if (this.runtime === null) {
      this.stopRequested = false
      throw new Error('Runtime is unavailable.')
    }

    const runtime = this.runtime
    const unsubscribeRuntime = this.unsubscribeRuntime
    this.transition('stopping')
    try {
      await runtime.stop()
      if (this.runtime === runtime) {
        unsubscribeRuntime?.()
        this.unsubscribeRuntime = null
        this.runtime = null
        this.state = {
          ...this.state,
          runtime: toKernelRuntime('stopped', runtime.getState())
        }
        this.emitState()
      }
    } catch (error) {
      if (this.runtime === runtime) {
        this.transition('crashed', errorMessage(error))
      }
      throw error
    } finally {
      if (this.runtime === runtime || this.runtime === null) {
        this.stopRequested = false
      }
    }
  }

  private assertStartActive(runtime: RuntimeHost): void {
    if (!this.isStartActive(runtime)) {
      throw new Error('Runtime start cancelled.')
    }
  }

  private isStartActive(runtime: RuntimeHost): boolean {
    return (
      this.runtime === runtime &&
      !this.stopRequested &&
      this.state.runtime.status !== 'stopping' &&
      this.state.runtime.status !== 'stopped'
    )
  }

  private requireRuntime(status: RuntimeStatus): RuntimeHost {
    if (this.state.runtime.status !== status) {
      throw new Error(`Runtime must be ${status}; current status is ${this.state.runtime.status}.`)
    }
    if (this.runtime === null) throw new Error('Runtime is unavailable.')
    return this.runtime
  }

  private async refreshSessionState(runtime: RuntimeHost): Promise<void> {
    const result = await runtime.send({ type: 'get_state' })
    if (result.type !== 'state') throw new Error('Runtime did not return session state.')
    if (this.runtime !== runtime) return
    this.state = { ...this.state, session: toKernelSession(result.state) }
    this.emitState()
  }

  private assertProjectEditable(): void {
    if (this.state.runtime.status !== 'stopped') {
      throw new Error(`Cannot change project while runtime is ${this.state.runtime.status}.`)
    }
  }

  private handleRuntimeEvent(event: RuntimeHostEvent): void {
    if (this.runtime === null) return

    if (event.type === 'activity-started') {
      if (this.state.runtime.status === 'ready') {
        this.state = {
          ...this.state,
          runtime: toKernelRuntime('running', this.runtime.getState()),
          session: { ...this.state.session, settled: false }
        }
        this.emitState()
      }
      return
    }
    if (event.type === 'activity-settled') {
      if (this.state.runtime.status === 'running') {
        this.state = {
          ...this.state,
          runtime: toKernelRuntime('ready', this.runtime.getState()),
          session: { ...this.state.session, settled: true }
        }
        this.emitState()
      }
      return
    }
    if (event.type === 'pi-event') {
      this.handlePiEvent(event.event)
      return
    }
    if (event.type === 'diagnostic') {
      const hostState = this.runtime.getState()
      this.state = {
        ...this.state,
        runtime: toKernelRuntime(
          this.state.runtime.status,
          hostState,
          event.kind === 'stderr' ? undefined : event.message
        )
      }
      this.emitState()
      if (event.kind === 'process' && !this.stopRequested && this.state.runtime.status !== 'stopped') {
        this.transition('crashed', event.message)
      }
      return
    }

    const hostState = this.runtime.getState()
    this.state = {
      ...this.state,
      runtime: toKernelRuntime(this.state.runtime.status, {
        ...hostState,
        exitCode: event.code,
        exitSignal: event.signal
      })
    }
    this.emitState()
    if (!this.stopRequested && this.state.runtime.status !== 'stopped') {
      this.transition('crashed', formatExitError(event.code, event.signal))
    }
  }

  private handlePiEvent(event: PiRpcEvent): void {
    if (this.runtime === null || this.state.runtime.status === 'crashed') return

    let nextState = this.state
    if (event.type === 'agent_start') {
      nextState = {
        ...nextState,
        runtime: toKernelRuntime('running', this.runtime.getState()),
        session: { ...nextState.session, settled: false }
      }
    } else if (event.type === 'agent_settled') {
      nextState = {
        ...nextState,
        runtime: toKernelRuntime('ready', this.runtime.getState()),
        session: { ...nextState.session, settled: true, pendingMessageCount: 0 }
      }
    } else if (event.type === 'message_end') {
      nextState = {
        ...nextState,
        session: { ...nextState.session, messageCount: nextState.session.messageCount + 1 }
      }
    }

    const entries = projectPiEvent(nextState.conversation.entries, event)
    if (entries !== nextState.conversation.entries) {
      nextState = { ...nextState, conversation: { entries } }
    }

    if (nextState !== this.state) {
      this.state = nextState
      this.emitState()
    }
  }

  private transition(status: RuntimeStatus, lastError?: string): void {
    this.state = {
      ...this.state,
      runtime: toKernelRuntime(status, this.runtime?.getState() ?? INITIAL_HOST_STATE, lastError)
    }
    this.emitState()
  }

  private emitState(): void {
    const event: KernelEvent = { type: 'kernel.state-changed', state: this.getState() }
    for (const listener of this.listeners) listener(event)
  }
}

function configuredProject(project: KernelProjectState): { path: string; trust: ProjectTrust } {
  if (project.path === null) throw new Error('Select a project directory before starting.')
  if (project.trust === null) throw new Error('Choose whether the project is trusted before starting.')
  return { path: project.path, trust: project.trust }
}

function initialKernelState(project: KernelProjectState): KernelState {
  return {
    project: { ...project },
    runtime: toKernelRuntime('stopped', INITIAL_HOST_STATE),
    session: { ...INITIAL_SESSION_STATE },
    conversation: { entries: [] }
  }
}

function toKernelRuntime(
  status: RuntimeStatus,
  host: RuntimeHostState,
  lastError = host.lastError
): KernelState['runtime'] {
  return {
    status,
    executable: host.executable,
    version: host.version,
    stderrChars: host.stderrChars,
    lastError,
    exitCode: host.exitCode,
    exitSignal: host.exitSignal
  }
}

function toKernelSession(state: PiRpcSessionState): KernelSessionState {
  return {
    id: stringValue(state.sessionId),
    name: stringValue(state.sessionName),
    model: toKernelModel(state.model),
    thinkingLevel: thinkingLevel(state.thinkingLevel),
    messageCount: integerValue(state.messageCount),
    pendingMessageCount: integerValue(state.pendingMessageCount),
    settled: state.isStreaming !== true
  }
}

function toKernelModel(value: PiRpcSessionState['model']): KernelModelState | null {
  if (value === null || value === undefined) return null
  if (typeof value.id !== 'string' || typeof value.provider !== 'string') return null
  return {
    provider: value.provider,
    id: value.id,
    name: typeof value.name === 'string' ? value.name : value.id,
    reasoning: value.reasoning === true,
    contextWindow: typeof value.contextWindow === 'number' ? value.contextWindow : null
  }
}

function copyState(state: KernelState): KernelState {
  return {
    project: { ...state.project },
    runtime: { ...state.runtime },
    session: {
      ...state.session,
      model: state.session.model === null ? null : { ...state.session.model }
    },
    conversation: { entries: state.conversation.entries.map((entry) => ({ ...entry })) }
  }
}

function thinkingLevel(value: unknown): ThinkingLevel | null {
  return value === 'off' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max'
    ? value
    : null
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function integerValue(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function formatExitError(code: number | null, signal: string | null): string {
  return code !== null
    ? `Pi RPC process exited with code ${code}.`
    : `Pi RPC process exited from signal ${signal ?? 'unknown'}.`
}
