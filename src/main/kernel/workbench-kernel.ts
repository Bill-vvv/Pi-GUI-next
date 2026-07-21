import type {
  KernelConversationEntry,
  KernelConversationEntryPatch,
  KernelConversationState,
  KernelEvent,
  KernelModelState,
  KernelProjectState,
  KernelSessionSummary,
  KernelSessionState,
  KernelState,
  KernelStatePatch,
  RuntimeStatus,
  ThinkingLevel
} from '../../shared/kernel-contract.ts'
import type { PiRpcEvent, PiRpcSessionState } from '../pi-rpc/pi-rpc-client.ts'
import { isAbsolute } from 'node:path'
import type { ProjectSessionRegistry, SessionPointer } from '../project/project-store.ts'
import type { RuntimeHost, RuntimeHostEvent, RuntimeHostState } from '../runtime/runtime-host.ts'
import { projectMessages, projectPiEvent } from './conversation-projection.ts'

const INITIAL_HOST_STATE: RuntimeHostState = {
  executable: null,
  version: null,
  stderrChars: 0,
  stderrSummary: null,
  lastError: null,
  exitCode: null,
  exitSignal: null
}

const INITIAL_SESSION_STATE: KernelSessionState = {
  id: null,
  name: null,
  resumeAvailable: false,
  model: null,
  thinkingLevel: null,
  messageCount: 0,
  pendingMessageCount: 0,
  settled: true
}

export type RuntimeFactory = (
  project: { path: string },
  launchOptions: { sessionFile?: string }
) => RuntimeHost

export type WorkbenchKernelOptions = {
  sessionRegistry: ProjectSessionRegistry
  persistProject: (project: KernelProjectState) => Promise<void>
  persistActiveProject: (projectKey: string) => Promise<void>
  persistSession: (pointer: SessionPointer) => Promise<void>
  validateSession: (pointer: SessionPointer) => Promise<SessionPointer>
}

export class WorkbenchKernel {
  private readonly createRuntime: RuntimeFactory
  private readonly listeners = new Set<(event: KernelEvent) => void>()
  private runtime: RuntimeHost | null = null
  private unsubscribeRuntime: (() => void) | null = null
  private sessionPointers: SessionPointer[]
  private state: KernelState
  private stopRequested = false
  private launchOperation: Promise<void> | null = null
  private launchCommitting = false
  private provisionalSession: { runtime: RuntimeHost, pointer: SessionPointer } | null = null
  private provisionalCommit: Promise<void> | null = null
  private provisionalSettled = false

  constructor(
    createRuntime: RuntimeFactory,
    projectRegistry: Pick<KernelState, 'projects' | 'activeProjectKey'>,
    options: WorkbenchKernelOptions
  ) {
    this.createRuntime = createRuntime
    assertProjectRegistry(projectRegistry)
    const sessionRegistry = matchingSessionRegistry(activeProject(projectRegistry), options.sessionRegistry)
    this.sessionPointers = sessionRegistry.sessions
    this.persistProject = options.persistProject
    this.persistActiveProject = options.persistActiveProject
    this.persistSession = options.persistSession
    this.validateSession = options.validateSession
    this.state = initialKernelState(projectRegistry, sessionRegistry)
  }

  private readonly persistProject: (project: KernelProjectState) => Promise<void>
  private readonly persistActiveProject: (projectKey: string) => Promise<void>
  private readonly persistSession: (pointer: SessionPointer) => Promise<void>
  private readonly validateSession: ((pointer: SessionPointer) => Promise<SessionPointer>) | undefined

  getState(): KernelState {
    return copyState(this.state)
  }

  subscribe(listener: (event: KernelEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async addProject(path: string, sessionRegistry: ProjectSessionRegistry): Promise<void> {
    if (!isAbsolute(path)) throw new Error(`Project path must be absolute: ${path}`)
    if (this.state.projects.some((project) => project.path === path)) {
      await this.activateProject(path, sessionRegistry)
      return
    }
    this.assertProjectActivationAllowed()
    if (this.state.runtime.status !== 'stopped') await this.stop()
    await this.persistProject({ path })
    this.state = {
      ...this.state,
      projects: [...this.state.projects, { path }]
    }
    try {
      await this.activateProject(path, sessionRegistry)
    } catch (error) {
      this.emitState()
      throw error
    }
  }

  async activateProject(path: string, sessionRegistry: ProjectSessionRegistry): Promise<void> {
    if (!isAbsolute(path)) throw new Error(`Project path must be absolute: ${path}`)
    if (!this.state.projects.some((project) => project.path === path)) {
      throw new Error(`Project is not registered: ${path}`)
    }
    if (this.state.activeProjectKey === path) return
    this.assertProjectActivationAllowed()
    if (this.state.runtime.status !== 'stopped') await this.stop()
    await this.persistActiveProject(path)
    const matchingRegistry = matchingSessionRegistry({ path }, sessionRegistry)
    this.sessionPointers = matchingRegistry.sessions
    this.state = initialKernelState({
      projects: this.state.projects,
      activeProjectKey: path
    }, matchingRegistry)
    this.emitState()
  }

  async start(): Promise<void> {
    await this.beginLaunch(async () => {
      const status = this.state.runtime.status
      if (status === 'running' || status === 'starting' || status === 'stopping') {
        throw new Error(`Cannot start session while runtime is ${status}.`)
      }
      const project = configuredProject(this.state)
      if (status !== 'stopped') {
        await this.stopRuntime(false)
        this.assertLaunchActive()
      }
      await this.launch(project, {})
    })
  }

  async activateSession(sessionKey: string): Promise<void> {
    if (!isAbsolute(sessionKey)) throw new Error(`Session key must be absolute: ${sessionKey}`)
    await this.beginLaunch(async () => {
      const status = this.state.runtime.status
      if (status === 'running' || status === 'starting' || status === 'stopping') {
        throw new Error(`Cannot change session while runtime is ${status}.`)
      }
      const project = configuredProject(this.state)
      const storedPointer = this.sessionPointers.find(
        (pointer) => pointer.projectPath === project.path && pointer.sessionFile === sessionKey
      )
      if (storedPointer === undefined) {
        throw new Error(`Session is not registered for the active project: ${sessionKey}`)
      }
      if (this.state.activeSessionKey === sessionKey && status === 'ready') return
      if (typeof this.validateSession !== 'function') {
        throw new Error('Session validation is unavailable.')
      }
      const pointer = await this.validateSession(storedPointer)
      this.assertLaunchActive()
      if (status !== 'stopped') {
        await this.stopRuntime(false)
        this.assertLaunchActive()
      }
      await this.launch(project, { sessionFile: pointer.sessionFile }, pointer.sessionId)
    })
  }

  async resumeSession(): Promise<void> {
    if (this.state.activeSessionKey === null) {
      throw new Error('No active session is available for this project.')
    }
    await this.activateSession(this.state.activeSessionKey)
  }

  private beginLaunch(task: () => Promise<void>): Promise<void> {
    if (this.launchOperation !== null) {
      throw new Error('A runtime launch is already in progress.')
    }
    const operation = this.performLaunch(task)
    this.launchOperation = operation
    return operation
  }

  private async performLaunch(task: () => Promise<void>): Promise<void> {
    await Promise.resolve()
    try {
      this.assertLaunchActive()
      await task()
    } finally {
      this.launchOperation = null
    }
  }

  private assertLaunchActive(): void {
    if (this.stopRequested) throw new Error('Runtime start cancelled.')
  }

  private async launch(
    project: { path: string },
    launchOptions: { sessionFile?: string },
    expectedSessionId?: string
  ): Promise<void> {
    this.assertLaunchActive()
    const runtime = this.createRuntime(project, launchOptions)
    this.runtime = runtime
    this.unsubscribeRuntime = runtime.subscribe((event) => {
      if (this.runtime === runtime) this.handleRuntimeEvent(event)
    })

    this.transition('starting')
    let runtimeStarted = false
    try {
      await runtime.start()
      runtimeStarted = true
      this.assertStartActive(runtime)
      const stateAfterRuntimeStart = this.getState()
      if (stateAfterRuntimeStart.runtime.status === 'crashed') {
        throw new Error(stateAfterRuntimeStart.runtime.lastError ?? 'Runtime exited while starting.')
      }

      const stateResult = await runtime.send({ type: 'get_state' })
      this.assertStartActive(runtime)
      if (stateResult.type !== 'state') {
        throw new Error('Runtime returned an invalid startup projection.')
      }
      const session = toKernelSession(stateResult.state, true)
      if (session.id === null || session.id.length === 0) {
        throw new Error('Runtime did not return a session ID.')
      }
      if (expectedSessionId !== undefined && session.id !== expectedSessionId) {
        throw new Error(
          `Resumed session ID mismatch: expected ${expectedSessionId}, received ${session.id}.`
        )
      }
      const sessionFile = stringValue(stateResult.state.sessionFile)
      if (sessionFile === null || !isAbsolute(sessionFile)) {
        throw new Error('Runtime did not return an absolute session file.')
      }
      const pointer: SessionPointer = {
        projectPath: project.path,
        sessionFile,
        sessionId: session.id,
        sessionName: session.name
      }
      this.assertStartActive(runtime)
      const messagesResult = await runtime.send({ type: 'get_messages' })
      this.assertStartActive(runtime)
      if (messagesResult.type !== 'messages') {
        throw new Error('Runtime returned an invalid startup projection.')
      }
      const stateAfterProjection = this.getState()
      if (stateAfterProjection.runtime.status === 'crashed') {
        throw new Error(stateAfterProjection.runtime.lastError ?? 'Runtime exited while starting.')
      }
      if (typeof this.validateSession !== 'function') {
        throw new Error('Session validation is unavailable.')
      }
      let canonicalPointer: SessionPointer
      try {
        canonicalPointer = await this.validateSession(pointer)
      } catch (error) {
        if (expectedSessionId !== undefined || !isEnoent(error)) throw error
        this.assertStartActive(runtime)
        this.provisionalSession = { runtime, pointer }
        this.state = {
          ...this.state,
          activeSessionKey: null,
          runtime: toKernelRuntime('ready', runtime.getState()),
          session: { ...session, resumeAvailable: false },
          conversation: {
            entries: projectMessages(messagesResult.messages),
            activeRunStartIndex: null
          }
        }
        this.emitState()
        return
      }
      this.assertStartActive(runtime)
      this.launchCommitting = true
      try {
        await this.persistSession(canonicalPointer)
        this.assertStartActive(runtime)
        this.sessionPointers = upsertSessionPointer(this.sessionPointers, canonicalPointer)
        this.state = {
          ...this.state,
          sessions: toKernelSessionSummaries(this.sessionPointers),
          activeSessionKey: canonicalPointer.sessionFile,
          runtime: toKernelRuntime('ready', runtime.getState()),
          session,
          conversation: {
            entries: projectMessages(messagesResult.messages),
            activeRunStartIndex: null
          }
        }
        this.emitState()
      } finally {
        this.launchCommitting = false
      }
    } catch (error) {
      if (!this.isStartActive(runtime)) {
        throw new Error('Runtime start cancelled.')
      }
      let launchError = error
      if (runtimeStarted) {
        launchError = await this.cleanupFailedLaunch(runtime, error)
      }
      if (this.state.runtime.status !== 'crashed' || this.runtime === null) {
        this.transition('crashed', errorMessage(launchError))
      }
      throw launchError
    }
  }

  private async cleanupFailedLaunch(runtime: RuntimeHost, error: unknown): Promise<unknown> {
    if (this.runtime === runtime) {
      this.unsubscribeRuntime?.()
      this.unsubscribeRuntime = null
    }
    let cleanupError: unknown = null
    try {
      await runtime.stop()
      if (this.runtime === runtime) this.runtime = null
    } catch (caught) {
      cleanupError = caught
    }
    if (cleanupError === null) return error
    return new Error(
      `${errorMessage(error)} Cleanup failed while stopping runtime: ${errorMessage(cleanupError)}`,
      { cause: error }
    )
  }

  async prompt(message: string): Promise<void> {
    const runtime = this.requireRuntime('ready')
    if (message.trim().length === 0) throw new Error('Prompt must not be empty.')

    this.state = {
      ...this.state,
      runtime: toKernelRuntime('running', runtime.getState()),
      session: { ...this.state.session, settled: false },
      conversation: beginConversationRun(this.state.conversation)
    }
    this.emitState()
    try {
      await runtime.send({ type: 'prompt', message })
    } catch (error) {
      if (this.runtime === runtime && this.state.runtime.status === 'running') {
        this.state = {
          ...this.state,
          runtime: toKernelRuntime('ready', runtime.getState(), errorMessage(error)),
          session: { ...this.state.session, settled: true },
          conversation: settleConversationRun(this.state.conversation)
        }
        this.emitState()
      }
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
    if (this.launchCommitting) await this.waitForLaunchToSettle()
    await this.waitForProvisionalCommit()
    await this.stopRuntime(true)
  }

  private async stopRuntime(waitForLaunch: boolean): Promise<void> {
    if (waitForLaunch) this.stopRequested = true
    if (this.state.runtime.status === 'stopped') {
      if (waitForLaunch) await this.waitForLaunchToSettle()
      if (waitForLaunch) this.stopRequested = false
      return
    }
    if (this.runtime === null) {
      if (waitForLaunch) this.stopRequested = false
      this.state = {
        ...this.state,
        runtime: toKernelRuntime('stopped', INITIAL_HOST_STATE)
      }
      this.emitState()
      return
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
      }
      this.clearProvisionalSession(runtime)
      if (this.runtime === null) {
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
      if (waitForLaunch) await this.waitForLaunchToSettle()
      if (waitForLaunch && (this.runtime === runtime || this.runtime === null)) {
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
      this.state.runtime.status !== 'stopped' &&
      this.state.runtime.status !== 'crashed'
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
    this.state = {
      ...this.state,
      session: toKernelSession(result.state, this.state.session.resumeAvailable)
    }
    this.emitState()
  }

  private assertProjectActivationAllowed(): void {
    if (this.launchOperation !== null) {
      throw new Error('Cannot change project while a runtime launch is in progress.')
    }
    if (
      this.state.runtime.status === 'running' ||
      this.state.runtime.status === 'starting' ||
      this.state.runtime.status === 'stopping'
    ) {
      throw new Error(`Cannot change project while runtime is ${this.state.runtime.status}.`)
    }
  }

  private async waitForLaunchToSettle(): Promise<void> {
    const operation = this.launchOperation
    if (operation === null) return
    try {
      await operation
    } catch {
      // The initiating start/resume call owns the launch error.
    }
  }

  private async waitForProvisionalCommit(): Promise<void> {
    const commit = this.provisionalCommit
    if (commit === null) return
    await commit
  }

  private handleRuntimeEvent(event: RuntimeHostEvent): void {
    if (this.runtime === null) return
    if (
      (this.stopRequested || this.state.runtime.status === 'stopping') &&
      (event.type === 'activity-started' || event.type === 'activity-settled' || event.type === 'pi-event')
    ) {
      return
    }

    if (event.type === 'activity-started') {
      if (this.state.runtime.status === 'ready') {
        this.state = {
          ...this.state,
          runtime: toKernelRuntime('running', this.runtime.getState()),
          session: { ...this.state.session, settled: false },
          conversation: beginConversationRun(this.state.conversation)
        }
        this.emitState()
      }
      return
    }
    if (event.type === 'activity-settled') {
      if (this.state.runtime.status === 'running') {
        if (this.provisionalCommit !== null) {
          this.provisionalSettled = true
          return
        }
        this.state = {
          ...this.state,
          runtime: toKernelRuntime('ready', this.runtime.getState()),
          session: { ...this.state.session, settled: true },
          conversation: settleConversationRun(this.state.conversation)
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
      if (
        event.kind === 'process' &&
        !this.stopRequested &&
        this.state.runtime.status !== 'stopped' &&
        this.state.runtime.status !== 'stopping'
      ) {
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
    if (
      !this.stopRequested &&
      this.state.runtime.status !== 'stopped' &&
      this.state.runtime.status !== 'stopping'
    ) {
      this.transition('crashed', formatExitError(event.code, event.signal))
    }
  }

  private handlePiEvent(event: PiRpcEvent): void {
    if (
      this.runtime === null ||
      this.stopRequested ||
      this.state.runtime.status === 'stopping' ||
      this.state.runtime.status === 'crashed'
    ) return

    const previousState = this.state
    let nextState = previousState
    if (event.type === 'agent_start') {
      nextState = {
        ...nextState,
        runtime: toKernelRuntime('running', this.runtime.getState()),
        session: { ...nextState.session, settled: false },
        conversation: beginConversationRun(nextState.conversation)
      }
    } else if (event.type === 'agent_settled') {
      if (this.provisionalSession?.runtime === this.runtime) {
        this.provisionalSettled = true
        this.beginProvisionalCommit()
        return
      }
      nextState = {
        ...nextState,
        runtime: toKernelRuntime('ready', this.runtime.getState()),
        session: { ...nextState.session, settled: true, pendingMessageCount: 0 },
        conversation: settleConversationRun(nextState.conversation)
      }
    } else if (event.type === 'message_end') {
      nextState = {
        ...nextState,
        session: { ...nextState.session, messageCount: nextState.session.messageCount + 1 }
      }
    }

    const entries = projectPiEvent(nextState.conversation.entries, event)
    if (entries !== nextState.conversation.entries) {
      nextState = { ...nextState, conversation: { ...nextState.conversation, entries } }
    }

    if (nextState !== previousState) {
      this.state = nextState
      const patch = createStatePatch(previousState, nextState)
      if (patch === null) this.emitState()
      else this.emitPatch(patch)
    }
    if (
      event.type === 'message_end' &&
      typeof event.message === 'object' &&
      event.message !== null &&
      'role' in event.message &&
      event.message.role === 'assistant' &&
      this.provisionalSession?.runtime === this.runtime
    ) {
      this.beginProvisionalCommit()
    }
  }

  private beginProvisionalCommit(): void {
    const provisional = this.provisionalSession
    if (provisional === null || provisional.runtime !== this.runtime || this.provisionalCommit !== null) {
      return
    }
    const commit = this.commitProvisionalSession(provisional)
    this.provisionalCommit = commit
    void commit.finally(() => {
      if (this.provisionalCommit === commit) this.provisionalCommit = null
    })
  }

  private async commitProvisionalSession(
    provisional: { runtime: RuntimeHost, pointer: SessionPointer }
  ): Promise<void> {
    try {
      if (typeof this.validateSession !== 'function') {
        throw new Error('Session validation is unavailable.')
      }
      const canonicalPointer = await this.validateSession(provisional.pointer)
      if (this.provisionalSession !== provisional || this.runtime !== provisional.runtime) return
      await this.persistSession(canonicalPointer)
      if (this.provisionalSession !== provisional || this.runtime !== provisional.runtime) return
      this.sessionPointers = upsertSessionPointer(this.sessionPointers, canonicalPointer)
      this.provisionalSession = null
      this.state = {
        ...this.state,
        sessions: toKernelSessionSummaries(this.sessionPointers),
        activeSessionKey: canonicalPointer.sessionFile,
        session: { ...this.state.session, resumeAvailable: true }
      }
      this.finishDeferredSettled(provisional.runtime)
      this.emitState()
    } catch (error) {
      if (this.provisionalSession !== provisional || this.runtime !== provisional.runtime) return
      if (isEnoent(error)) {
        this.finishDeferredSettled(provisional.runtime)
        this.emitState()
        return
      }
      this.provisionalSession = null
      this.provisionalSettled = false
      this.transition('crashed', errorMessage(error))
    }
  }

  private finishDeferredSettled(runtime: RuntimeHost): void {
    if (!this.provisionalSettled) return
    this.provisionalSettled = false
    if (this.runtime !== runtime || this.state.runtime.status !== 'running') return
    this.state = {
      ...this.state,
      runtime: toKernelRuntime('ready', runtime.getState()),
      session: { ...this.state.session, settled: true, pendingMessageCount: 0 },
      conversation: settleConversationRun(this.state.conversation)
    }
  }

  private clearProvisionalSession(runtime: RuntimeHost): void {
    if (this.provisionalSession?.runtime !== runtime) return
    this.provisionalSession = null
    this.provisionalSettled = false
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

  private emitPatch(patch: KernelStatePatch): void {
    const event: KernelEvent = { type: 'kernel.state-patched', patch: copyPatch(patch) }
    for (const listener of this.listeners) listener(event)
  }
}

function configuredProject(state: Pick<KernelState, 'projects' | 'activeProjectKey'>): { path: string } {
  const project = activeProject(state)
  if (project === null) throw new Error('Select a project directory before starting.')
  return project
}

function initialKernelState(
  projectRegistry: Pick<KernelState, 'projects' | 'activeProjectKey'>,
  sessionRegistry: ProjectSessionRegistry
): KernelState {
  assertProjectRegistry(projectRegistry)
  const projects = projectRegistry.projects.map((project) => ({ ...project }))
  const project = activeProject(projectRegistry)
  const matchingRegistry = matchingSessionRegistry(project, sessionRegistry)
  const activePointer = matchingRegistry.activeSessionKey === null
    ? null
    : matchingRegistry.sessions.find(
      ({ sessionFile }) => sessionFile === matchingRegistry.activeSessionKey
    ) ?? null
  return {
    projects,
    activeProjectKey: projectRegistry.activeProjectKey,
    sessions: toKernelSessionSummaries(matchingRegistry.sessions),
    activeSessionKey: matchingRegistry.activeSessionKey,
    runtime: toKernelRuntime('stopped', INITIAL_HOST_STATE),
    session: activePointer === null
      ? { ...INITIAL_SESSION_STATE }
      : {
          ...INITIAL_SESSION_STATE,
          id: activePointer.sessionId,
          name: activePointer.sessionName,
          resumeAvailable: true
        },
    conversation: { entries: [], activeRunStartIndex: null }
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
    stderrSummary: host.stderrSummary,
    lastError,
    exitCode: host.exitCode,
    exitSignal: host.exitSignal
  }
}

function toKernelSession(state: PiRpcSessionState, resumeAvailable: boolean): KernelSessionState {
  return {
    id: stringValue(state.sessionId),
    name: stringValue(state.sessionName),
    resumeAvailable,
    model: toKernelModel(state.model),
    thinkingLevel: thinkingLevel(state.thinkingLevel),
    messageCount: integerValue(state.messageCount),
    pendingMessageCount: integerValue(state.pendingMessageCount),
    settled: state.isStreaming !== true
  }
}

function matchingSessionRegistry(
  project: KernelProjectState | null,
  registry: ProjectSessionRegistry
): ProjectSessionRegistry {
  if (project === null) return { sessions: [], activeSessionKey: null }
  const sessions = registry.sessions.filter(({ projectPath }) => projectPath === project.path)
  if (
    sessions.some((pointer) => !isAbsolute(pointer.sessionFile) || pointer.sessionId.length === 0) ||
    new Set(sessions.map(({ sessionFile }) => sessionFile)).size !== sessions.length ||
    new Set(sessions.map(({ projectPath, sessionId }) => `${projectPath}\u0000${sessionId}`)).size !==
      sessions.length ||
    (
      registry.activeSessionKey !== null &&
      !sessions.some(({ sessionFile }) => sessionFile === registry.activeSessionKey)
    )
  ) {
    throw new Error('Invalid Workbench session registry.')
  }
  return {
    sessions: sessions.map((pointer) => ({ ...pointer })),
    activeSessionKey: registry.activeSessionKey
  }
}

function upsertSessionPointer(pointers: SessionPointer[], pointer: SessionPointer): SessionPointer[] {
  const index = pointers.findIndex((existing) =>
    existing.sessionFile === pointer.sessionFile ||
    (
      existing.projectPath === pointer.projectPath &&
      existing.sessionId === pointer.sessionId
    )
  )
  if (index === -1) return [...pointers, { ...pointer }]
  return pointers.map((existing, pointerIndex) =>
    pointerIndex === index ? { ...pointer } : { ...existing }
  )
}

function toKernelSessionSummaries(pointers: SessionPointer[]): KernelSessionSummary[] {
  return pointers.map((pointer) => ({
    key: pointer.sessionFile,
    id: pointer.sessionId,
    name: pointer.sessionName
  }))
}

function activeProject(
  state: Pick<KernelState, 'projects' | 'activeProjectKey'>
): KernelProjectState | null {
  if (state.activeProjectKey === null) return null
  return state.projects.find((project) => project.path === state.activeProjectKey) ?? null
}

function assertProjectRegistry(
  registry: Pick<KernelState, 'projects' | 'activeProjectKey'>
): void {
  if (
    registry.projects.some((project) => !isAbsolute(project.path)) ||
    new Set(registry.projects.map((project) => project.path)).size !== registry.projects.length ||
    (registry.activeProjectKey !== null && activeProject(registry) === null)
  ) {
    throw new Error('Invalid Workbench project registry.')
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
    projects: state.projects.map((project) => ({ ...project })),
    activeProjectKey: state.activeProjectKey,
    sessions: state.sessions.map((session) => ({ ...session })),
    activeSessionKey: state.activeSessionKey,
    runtime: { ...state.runtime },
    session: {
      ...state.session,
      model: state.session.model === null ? null : { ...state.session.model }
    },
    conversation: {
      entries: state.conversation.entries.map((entry) => ({ ...entry })),
      activeRunStartIndex: state.conversation.activeRunStartIndex
    }
  }
}

function createStatePatch(previous: KernelState, next: KernelState): KernelStatePatch | null {
  const patch: KernelStatePatch = {}
  if (next.runtime !== previous.runtime) patch.runtime = next.runtime
  if (next.session !== previous.session) patch.session = next.session

  const conversationPatch: NonNullable<KernelStatePatch['conversation']> = {}
  const previousEntries = previous.conversation.entries
  const nextEntries = next.conversation.entries
  if (nextEntries !== previousEntries) {
    if (nextEntries.length < previousEntries.length) return null
    const entries: NonNullable<typeof conversationPatch.entries> = []
    for (let index = 0; index < nextEntries.length; index += 1) {
      const entry = nextEntries[index]
      if (entry === undefined) return null
      if (index < previousEntries.length) {
        const previousEntry = previousEntries[index]
        if (previousEntry === undefined || previousEntry.id !== entry.id) return null
        if (previousEntry === entry) continue
        const entryPatch = createConversationEntryPatch(previousEntry, entry, index)
        if (entryPatch === null) return null
        entries.push(entryPatch)
        continue
      }
      entries.push({ type: 'insert', index, entry })
    }
    if (entries.length > 0) conversationPatch.entries = entries
  }
  if (next.conversation.activeRunStartIndex !== previous.conversation.activeRunStartIndex) {
    conversationPatch.activeRunStartIndex = next.conversation.activeRunStartIndex
  }
  if (Object.keys(conversationPatch).length > 0) patch.conversation = conversationPatch
  return patch
}

function copyPatch(patch: KernelStatePatch): KernelStatePatch {
  return {
    ...(patch.runtime === undefined ? {} : { runtime: { ...patch.runtime } }),
    ...(patch.session === undefined
      ? {}
      : {
          session: {
            ...patch.session,
            model: patch.session.model === null ? null : { ...patch.session.model }
          }
        }),
    ...(patch.conversation === undefined
      ? {}
      : {
          conversation: {
            ...(patch.conversation.entries === undefined
              ? {}
              : {
                  entries: patch.conversation.entries.map((entryPatch) =>
                    entryPatch.type === 'insert'
                      ? { ...entryPatch, entry: { ...entryPatch.entry } }
                      : { ...entryPatch }
                  )
                }),
            ...('activeRunStartIndex' in patch.conversation
              ? { activeRunStartIndex: patch.conversation.activeRunStartIndex }
              : {})
          }
        })
  }
}

function createConversationEntryPatch(
  previous: KernelConversationEntry,
  next: KernelConversationEntry,
  index: number
): KernelConversationEntryPatch | null {
  if (previous.kind !== next.kind) return null

  if (previous.kind === 'message' && next.kind === 'message') {
    if (
      previous.role !== next.role ||
      previous.timestamp !== next.timestamp ||
      !next.text.startsWith(previous.text)
    ) return null
    return {
      type: 'append-message-text',
      index,
      from: previous.text.length,
      text: next.text.slice(previous.text.length),
      streaming: next.streaming,
      stopReason: next.stopReason,
      error: next.error
    }
  }

  if (previous.kind === 'thinking' && next.kind === 'thinking') {
    if (previous.timestamp !== next.timestamp || !next.text.startsWith(previous.text)) return null
    return {
      type: 'append-thinking-text',
      index,
      from: previous.text.length,
      text: next.text.slice(previous.text.length),
      streaming: next.streaming
    }
  }

  if (previous.kind === 'tool' && next.kind === 'tool') {
    if (
      previous.toolCallId !== next.toolCallId ||
      previous.name !== next.name ||
      previous.args !== next.args ||
      previous.timestamp !== next.timestamp ||
      !next.output.startsWith(previous.output)
    ) return null
    return {
      type: 'append-tool-output',
      index,
      from: previous.output.length,
      output: next.output.slice(previous.output.length),
      status: next.status,
      details: next.details,
      truncated: next.truncated,
      durationMs: next.durationMs
    }
  }

  return null
}

function beginConversationRun(conversation: KernelConversationState): KernelConversationState {
  if (conversation.activeRunStartIndex !== null) return conversation
  return { ...conversation, activeRunStartIndex: conversation.entries.length }
}

function settleConversationRun(conversation: KernelConversationState): KernelConversationState {
  const activeRunStartIndex = conversation.activeRunStartIndex
  if (activeRunStartIndex === null) return conversation
  const entries = conversation.entries.map((entry, index) => {
    if (
      index < activeRunStartIndex ||
      entry.kind !== 'tool' ||
      (entry.status !== 'pending' && entry.status !== 'running')
    ) return entry
    return { ...entry, status: 'error' as const }
  })
  return { entries, activeRunStartIndex: null }
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

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function formatExitError(code: number | null, signal: string | null): string {
  return code !== null
    ? `Pi RPC process exited with code ${code}.`
    : `Pi RPC process exited from signal ${signal ?? 'unknown'}.`
}
