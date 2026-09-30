import { isAbsolute } from 'node:path'
import type { AgentCollaborationOperation, AgentCollaborationResult, AgentDelivery, AgentSessionReference } from '../../shared/agent-collaboration-contract.ts'
import { isAgentCollaborationOperation } from '../../shared/agent-collaboration-contract.ts'
import type { KernelMutationAck, KernelState, KernelSubagentTranscript } from '../../shared/kernel-contract.ts'
import { copySubagentSettings } from '../../shared/workbench-settings.ts'
import type { SessionPointer } from '../project/session-pointer.ts'
import type { RuntimeHost, RuntimeHostEvent } from '../runtime/runtime-host.ts'
import { SessionCollaboration } from '../subagent/session-collaboration.ts'
import { errorMessage } from '../utils/errors.ts'
import { projectAdvisorState, UNAVAILABLE_ADVISOR_STATE } from './advisor-projection.ts'
import { createCommandCatalog } from './command-catalog.ts'
import { projectMessages, projectSessionEntries } from './conversation-projection.ts'
import { sessionEntriesOnActivePath } from './session-branch.ts'
import { mergeConversationEntries, toAvailableKernelModel, toKernelModel, toKernelSession } from './session-projection.ts'
import { beginConversationRun, settleConversationRun, toKernelRuntime, type RuntimeSessionState } from './runtime-session-state.ts'
import { contextKey, isEnoent, stringValue, workspaceKind } from './workbench-kernel-helpers.ts'
import { INITIAL_SESSION_STATE, type ProjectNavigationState, type ProjectTrustController, type RuntimeContext, type RuntimeFactory } from './workbench-kernel-types.ts'

/** Kernel retains workspace selection and registry mutations; this owns managed collaboration lifecycle. */
export type SessionCollaborationRuntimeHost = {
  state(): KernelState
  activeContext(): RuntimeContext | null
  contexts(): ReadonlySet<RuntimeContext>
  sessions(): ReadonlyMap<string, SessionPointer[]>
  contextForSession(projectPath: string, sessionFile: string): RuntimeContext | undefined
  admissionOpen(): boolean
  assertLaunchActive(): void
  assertRegisteredProject(projectPath: string): void
  createRuntime: RuntimeFactory
  inspectProjectTrust: ProjectTrustController['inspect']
  validateSession(pointer: SessionPointer): Promise<SessionPointer>
  persistSession(pointer: SessionPointer): Promise<void>
  registerPointer(pointer: SessionPointer): void
  registerContext(context: RuntimeContext): void
  registerIdentity(context: RuntimeContext, sessionFile: string): void
  retireContext(context: RuntimeContext, wasActive: boolean, navigationBefore: ProjectNavigationState): void
  allocateIdentity(): Pick<RuntimeContext, 'runtimeId' | 'runtimeGeneration'>
  touchWarmUse(context: RuntimeContext): void
  cancelCompaction(context: RuntimeContext): void
  clearToolImages(sessionKey: string): void
  projectNavigationState(projectPath: string): ProjectNavigationState
  publishContextState(context: RuntimeContext, navigationBefore: ProjectNavigationState | null, publication?: 'patch' | 'snapshot'): void
  acknowledge(): KernelMutationAck
  now(): number
}

export class SessionCollaborationRuntime {
  private readonly host: SessionCollaborationRuntimeHost
  private readonly coordinator: SessionCollaboration
  private readonly collaborationLaunches = new Map<string, Promise<RuntimeContext>>()

  constructor(host: SessionCollaborationRuntimeHost) {
    this.host = host
    this.coordinator = new SessionCollaboration({
      list: () => this.collaborationSessions(),
      spawn: (sourceSessionId, title, model) => this.spawnCollaborationSession(sourceSessionId, title, model),
      ready: (sessionId) => {
        const context = this.collaborationContext(sessionId)
        return this.host.admissionOpen() &&
          (context === null || context.state.runtime.status === 'ready' && context.state.session.settled && !context.stopRequested)
      },
      deliver: (delivery) => this.deliverCollaborationMessage(delivery),
      abort: async (sessionId) => {
        const context = this.collaborationContext(sessionId)
        if (context !== null) await context.runtime.send({ type: 'abort' })
      },
      reportError: (sessionId, error) => {
        const context = this.collaborationContext(sessionId)
        if (context === null) return
        const navigationBefore = this.host.projectNavigationState(context.projectPath)
        context.state = { ...context.state, runtime: { ...context.state.runtime, lastError: error } }
        this.host.publishContextState(context, navigationBefore)
      },
      now: () => this.host.now()
    })
  }

  hasPending(sessionId: string): boolean { return this.coordinator.hasPending(sessionId) }
  ready(sessionId: string): void { this.coordinator.ready(sessionId) }
  interrupted(sessionId: string, error: string): void { this.coordinator.interrupted(sessionId, error) }

  createContext(projectPath: string, runtime: RuntimeHost, state: RuntimeSessionState, launchCommitting = false): RuntimeContext {
    return {
      ...this.host.allocateIdentity(), lastWarmUseAt: this.host.now(), projectPath, runtime, state,
      commandEntries: [], unsubscribeRuntime: null, stopRequested: false, launchCommitting,
      provisionalSession: null, provisionalCommit: null, provisionalSettled: false,
      sessionUsageRefreshInFlight: false, sessionUsageRefreshRequested: false,
      pendingSessionName: null, sessionNameOperation: null, compactionRevision: 0, compactionLifecycle: null,
      askInteraction: null, extensionCommandInvocation: null, extensionDialogInteraction: null, deferredEvents: null
    }
  }

  getAgentCollaboration(): AgentCollaborationResult {
    return { kind: 'sessions', sessions: this.collaborationSessions() }
  }

  async agentCollaboration(operation: AgentCollaborationOperation, expectedSessionKey: string): Promise<AgentCollaborationResult> {
    if (!isAgentCollaborationOperation(operation)) throw new Error('Invalid agent collaboration operation.')
    const context = this.requireCollaborationOrigin(expectedSessionKey)
    return this.coordinator.execute(context.state.session.id!, operation)
  }

  async getSubagentTranscript(taskId: string, expectedSessionKey: string): Promise<KernelSubagentTranscript> {
    const context = this.requireCollaborationOrigin(expectedSessionKey)
    const result = await context.runtime.send({ type: 'get_subagent_transcript', taskId })
    if (!this.host.contexts().has(context) || context.state.activeSessionKey !== expectedSessionKey) {
      throw new Error('The owning Session changed while reading its subagent.')
    }
    if (result.type !== 'subagent-transcript' || result.taskId !== taskId) {
      throw new Error('Runtime returned an invalid subagent transcript.')
    }
    // Child image lookups need their own Session identity; do not reuse parent endpoints.
    const entries = projectMessages(result.messages).map((entry) =>
      entry.kind === 'message' || entry.kind === 'tool' ? { ...entry, attachments: [] } : entry)
    return { taskId, status: result.status, entries }
  }

  async controlSubagent(taskId: string, expectedSessionKey: string, action: 'stop' | 'continue', message?: string): Promise<KernelMutationAck> {
    const context = this.requireCollaborationOrigin(expectedSessionKey)
    const result = await context.runtime.send({ type: 'control_subagent', taskId, action, ...(message === undefined ? {} : { message }) })
    if (result.type !== 'accepted') throw new Error('Runtime did not accept the subagent action.')
    return this.host.acknowledge()
  }

  private requireCollaborationOrigin(expectedSessionKey?: string): RuntimeContext {
    const context = this.host.activeContext()
    if (context === null || expectedSessionKey !== undefined && context.state.activeSessionKey !== expectedSessionKey ||
      !this.host.contexts().has(context) || context.stopRequested || !this.host.admissionOpen() ||
      !['ready', 'running'].includes(context.state.runtime.status) || context.state.session.id === null) {
      throw new Error('The owning Session is unavailable or has changed.')
    }
    return context
  }

  private collaborationSessions(): AgentSessionReference[] {
    const references = new Map<string, AgentSessionReference>()
    for (const [projectPath, pointers] of this.host.sessions()) {
      for (const pointer of pointers) {
        const context = this.host.contextForSession(projectPath, pointer.sessionFile)
        references.set(contextKey(projectPath, pointer.sessionFile), this.collaborationReference(pointer, context))
      }
    }
    for (const context of this.host.contexts()) {
      const pointer = context.provisionalSession?.pointer
      if (pointer !== undefined) references.set(contextKey(pointer.projectPath, pointer.sessionFile), this.collaborationReference(pointer, context))
    }
    return [...references.values()]
  }

  private collaborationReference(pointer: SessionPointer, context?: RuntimeContext): AgentSessionReference {
    const status = context?.state.runtime.status
    return {
      sessionId: pointer.sessionId, title: context?.state.session.name ?? pointer.sessionName ?? '未命名对话',
      projectPath: pointer.projectPath,
      status: status === 'running' ? context?.askInteraction !== null || context?.extensionDialogInteraction !== null ? 'waiting' : 'running'
        : status === 'crashed' ? 'crashed' : status === 'stopped' || status === 'stopping' ? 'stopped' : 'idle'
    }
  }

  private collaborationContext(sessionId: string): RuntimeContext | null {
    const contexts = [...this.host.contexts()].filter((context) => context.state.session.id === sessionId)
    if (contexts.length > 1) throw new Error('Agent Session identity is ambiguous.')
    return contexts[0] ?? null
  }

  private async spawnCollaborationSession(sourceSessionId: string, title?: string, model?: string): Promise<AgentSessionReference> {
    const source = this.collaborationContext(sourceSessionId)
    if (source === null || !this.host.contexts().has(source) || source.stopRequested) throw new Error('Source Session is unavailable.')
    const project = this.host.state().projects.find((project) => project.path === source.projectPath)
    if (project === undefined || workspaceKind(project) === 'task') {
      throw new Error('Task workspaces own one Session; spawn a subagent with Task instead.')
    }
    const context = await this.launchCollaborationContext(source.projectPath)
    if (!this.host.contexts().has(source) || source.stopRequested) {
      await this.stopContext(context)
      throw new Error('Source Session stopped before spawn completed.')
    }
    try {
      if (title !== undefined) {
        const result = await context.runtime.send({ type: 'set_session_name', name: title })
        if (result.type !== 'accepted') throw new Error('Runtime did not accept the Session title.')
        context.state = { ...context.state, session: { ...context.state.session, name: title } }
        if (context.provisionalSession !== null) context.provisionalSession.pointer.sessionName = title
      }
      if (model !== undefined) {
        const selected = context.state.availableModels.filter((candidate) => `${candidate.provider}/${candidate.id}` === model || candidate.id === model)
        if (selected.length !== 1) throw new Error('Requested collaboration model is unavailable or ambiguous; use provider/modelId.')
        const result = await context.runtime.send({ type: 'set_model', provider: selected[0]!.provider, modelId: selected[0]!.id })
        if (result.type !== 'model') throw new Error('Runtime returned an invalid model selection.')
        context.state = { ...context.state, session: { ...context.state.session, model: toKernelModel(result.model) } }
      }
      const pointer = context.provisionalSession?.pointer ?? (this.host.sessions().get(context.projectPath) ?? []).find((pointer) => pointer.sessionId === context.state.session.id)
      if (pointer === undefined) throw new Error('Spawned Session identity is unavailable.')
      return this.collaborationReference(pointer, context)
    } catch (error) {
      await this.stopContext(context)
      throw error
    }
  }

  private async launchCollaborationContext(projectPath: string, existing?: SessionPointer): Promise<RuntimeContext> {
    this.host.assertLaunchActive()
    this.host.assertRegisteredProject(projectPath)
    const workspace = this.host.state().projects.find((project) => project.path === projectPath)!
    const inspection = workspaceKind(workspace) === 'task'
      ? { requiresDecision: false, decision: true }
      : await this.host.inspectProjectTrust(projectPath)
    if (inspection.requiresDecision && inspection.decision === null) {
      throw new Error('This project requires a user trust decision before an agent can start its Session.')
    }
    this.host.assertLaunchActive()
    const runtime = this.host.createRuntime({ path: projectPath }, {
      ...(existing === undefined ? {} : { sessionFile: existing.sessionFile }),
      ...(inspection.decision === null ? {} : { projectTrust: inspection.decision }),
      subagent: copySubagentSettings(this.host.state().subagent), fastExtensionLoading: this.host.state().general.fastExtensionLoading
    })
    const context = this.createContext(projectPath, runtime, {
      activeSessionKey: existing?.sessionFile ?? null, commands: createCommandCatalog(), advisor: { ...UNAVAILABLE_ADVISOR_STATE },
      availableModels: [], extensionDialog: null, runtime: toKernelRuntime('starting', runtime.getState()),
      session: { ...INITIAL_SESSION_STATE }, conversation: { entries: [], startIndex: 0, activeRunStartIndex: null }
    }, true)
    this.host.registerContext(context)
    const assertOwned = (): void => {
      this.host.assertLaunchActive()
      if (!this.host.contexts().has(context) || context.stopRequested || context.state.runtime.status === 'crashed') {
        throw new Error('Background Session start was interrupted.')
      }
    }
    try {
      await runtime.start()
      assertOwned()
      const stateResult = await runtime.send({ type: 'get_state' })
      assertOwned()
      if (stateResult.type !== 'state') throw new Error('Runtime returned an invalid background Session state.')
      const sessionFile = stringValue(stateResult.state.sessionFile)
      const session = toKernelSession(stateResult.state, true, null, false)
      if (sessionFile === null || !isAbsolute(sessionFile) || session.id === null ||
        existing !== undefined && (sessionFile !== existing.sessionFile || session.id !== existing.sessionId)) {
        throw new Error('Background Session identity does not match its registered Pi Session.')
      }
      let pointer: SessionPointer = { projectPath, sessionFile, sessionId: session.id, sessionName: session.name }
      try {
        pointer = await this.host.validateSession(pointer)
      } catch (error) {
        if (existing !== undefined || !isEnoent(error)) throw error
        context.provisionalSession = { runtime, pointer, initialPrompt: null, sessionNameAttempted: false, activityAt: this.host.now() }
      }
      assertOwned()
      const messagesResult = await runtime.send({ type: 'get_messages' })
      const entriesResult = await runtime.send({ type: 'get_entries' })
      const commandsResult = await runtime.send({ type: 'get_commands' })
      const modelsResult = await runtime.send({ type: 'get_available_models' })
      assertOwned()
      if (messagesResult.type !== 'messages' || entriesResult.type !== 'entries' || commandsResult.type !== 'commands' || modelsResult.type !== 'available-models') {
        throw new Error('Runtime returned an invalid background Session projection.')
      }
      const activeEntries = sessionEntriesOnActivePath(entriesResult.entries, entriesResult.leafId)
      const navigationBefore = this.host.projectNavigationState(projectPath)
      context.state = {
        ...context.state, activeSessionKey: sessionFile, session: { ...session, resumeAvailable: context.provisionalSession === null },
        commands: createCommandCatalog(commandsResult.commands, context.provisionalSession === null),
        advisor: projectAdvisorState(entriesResult.entries), availableModels: modelsResult.models.map(toAvailableKernelModel),
        runtime: toKernelRuntime('ready', runtime.getState()),
        conversation: { entries: mergeConversationEntries(projectMessages(messagesResult.messages), projectSessionEntries(activeEntries)), startIndex: 0, activeRunStartIndex: null }
      }
      this.host.registerIdentity(context, sessionFile)
      if (context.provisionalSession === null && existing === undefined) {
        await this.host.persistSession(pointer)
        assertOwned()
        this.host.registerPointer(pointer)
      }
      context.launchCommitting = false
      this.host.publishContextState(context, navigationBefore, 'snapshot')
      return context
    } catch (error) {
      context.launchCommitting = false
      await this.stopContext(context)
      throw error
    }
  }

  private async deliverCollaborationMessage(delivery: AgentDelivery): Promise<void> {
    let context = this.collaborationContext(delivery.targetSessionId)
    if (context === null) {
      const matches = [...this.host.sessions().values()].flat().filter((pointer) => pointer.sessionId === delivery.targetSessionId)
      if (matches.length !== 1) throw new Error('Target Session is not registered or its identity is ambiguous.')
      const pointer = matches[0]!
      let pending = this.collaborationLaunches.get(pointer.sessionFile)
      if (pending === undefined) {
        pending = this.launchCollaborationContext(pointer.projectPath, pointer)
        this.collaborationLaunches.set(pointer.sessionFile, pending)
      }
      try { context = await pending } finally { if (this.collaborationLaunches.get(pointer.sessionFile) === pending) this.collaborationLaunches.delete(pointer.sessionFile) }
    }
    if (!this.host.contexts().has(context) || context.stopRequested || !this.host.admissionOpen() ||
      context.state.session.id !== delivery.targetSessionId || context.state.runtime.status !== 'ready' || !context.state.session.settled) {
      throw new Error('Target Session is unavailable or busy.')
    }
    this.host.touchWarmUse(context)
    const navigationBefore = this.host.projectNavigationState(context.projectPath)
    context.collaborationRunStartIndex = context.state.conversation.entries.length
    delete context.collaborationRunError
    context.state = {
      ...context.state, runtime: toKernelRuntime('running', context.runtime.getState()),
      session: { ...context.state.session, settled: false }, conversation: beginConversationRun(context.state.conversation)
    }
    this.host.publishContextState(context, navigationBefore, 'snapshot')
    try {
      await context.runtime.send({ type: 'collaboration_prompt', message: delivery.content, sourceSessionId: delivery.sourceSessionId, messageId: delivery.messageId, kind: delivery.kind })
      if (context.provisionalSession !== null) {
        context.provisionalSession.initialPrompt = delivery.content
        // Pi 0.99 first flush requires a user/assistant entry. The existing
        // message_end / agent_settled provisional owner commits the real file.
      }
    } catch (error) {
      if (this.host.contexts().has(context) && context.state.runtime.status === 'running') {
        const beforeFailure = this.host.projectNavigationState(context.projectPath)
        context.state = { ...context.state, runtime: toKernelRuntime('ready', context.runtime.getState(), errorMessage(error)), session: { ...context.state.session, settled: true }, conversation: settleConversationRun(context.state.conversation) }
        this.host.publishContextState(context, beforeFailure, 'snapshot')
      }
      delete context.collaborationRunStartIndex
      throw error
    }
  }

  settled(context: RuntimeContext): void {
    const sessionId = context.state.session.id
    if (sessionId === null) return
    if (context.collaborationRunStartIndex === undefined) {
      this.coordinator.ready(sessionId)
      return
    }
    const entries = context.state.conversation.entries.slice(context.collaborationRunStartIndex)
    const answer = entries.findLast((entry) => entry.kind === 'message' && entry.role === 'assistant')
    delete context.collaborationRunStartIndex
    const error = answer?.kind === 'message' ? answer.error ?? context.collaborationRunError ?? null : context.collaborationRunError ?? null
    delete context.collaborationRunError
    this.coordinator.settled(sessionId, answer?.kind === 'message' ? answer.text : null, error, answer?.kind === 'message' && answer.stopReason === 'aborted')
  }

  async stopContext(context: RuntimeContext, hibernating = false): Promise<void> {
    if (!this.host.contexts().has(context)) return
    // A successful provisional persistence is the durable commit point. Keep the
    // owning Context alive until its continuation synchronously reconciles the
    // project registries, then stop/remove it.
    const provisionalCommit = context.provisionalCommit
    if (provisionalCommit !== null) await provisionalCommit
    if (!this.host.contexts().has(context)) return
    this.host.cancelCompaction(context)
    context.askInteraction = null
    context.extensionCommandInvocation = null
    context.extensionDialogInteraction = null
    context.state = { ...context.state, extensionDialog: null }
    if (typeof context.state.activeSessionKey === 'string') {
      this.host.clearToolImages(context.state.activeSessionKey)
    }
    const wasActive = this.host.activeContext() === context
    const navigationBeforeStopping = this.host.projectNavigationState(context.projectPath)
    context.stopRequested = true
    if (!hibernating && context.state.session.id !== null) this.coordinator.interrupted(context.state.session.id, 'Session stopped.')
    context.sessionNameOperation?.controller.abort()
    context.pendingSessionName = null
    context.sessionNameOperation = null
    context.state = {
      ...context.state,
      runtime: toKernelRuntime('stopping', context.runtime.getState())
    }
    this.host.publishContextState(context, navigationBeforeStopping, 'snapshot')
    try {
      await context.runtime.stop()
    } catch (error) {
      // Retain ownership when stop fails so a potentially live process stays tracked.
      // Publish crashed navigation, clear the in-progress stop flag for retry, and throw.
      const navigationBeforeCrash = this.host.projectNavigationState(context.projectPath)
      context.stopRequested = false
      context.state = {
        ...context.state,
        extensionDialog: null,
        runtime: toKernelRuntime('crashed', context.runtime.getState(), errorMessage(error))
      }
      this.host.publishContextState(context, navigationBeforeCrash, 'snapshot')
      throw error
    }
    context.unsubscribeRuntime?.()
    context.unsubscribeRuntime = null
    // Capture while still `stopping` so the stopping→stopped/removed transition is visible.
    const navigationBeforeRemoval = this.host.projectNavigationState(context.projectPath)
    context.state = {
      ...context.state,
      commands: createCommandCatalog(),
      advisor: { ...UNAVAILABLE_ADVISOR_STATE },
      runtime: toKernelRuntime('stopped', context.runtime.getState())
    }
    this.host.retireContext(context, wasActive, navigationBeforeRemoval)
  }

  handleRequest(context: RuntimeContext, event: Extract<RuntimeHostEvent, { type: 'agent-collaboration-request' }>): void {
    const valid = isAgentCollaborationOperation(event.operation) && this.host.admissionOpen() && !context.stopRequested &&
      ['ready', 'running'].includes(context.state.runtime.status) && context.state.session.id !== null &&
      (context.state.activeSessionKey !== null && this.host.contextForSession(context.projectPath, context.state.activeSessionKey) === context)
    const operation = valid
      ? this.coordinator.execute(context.state.session.id!, event.operation)
      : Promise.reject(new Error('Collaboration source Session is unavailable.'))
    void operation.then(
      (result) => context.runtime.send({ type: 'agent_collaboration_response', response: { requestId: event.requestId, ok: true, result } }),
      (error: unknown) => context.runtime.send({ type: 'agent_collaboration_response', response: { requestId: event.requestId, ok: false, error: errorMessage(error) } })
    ).catch((error: unknown) => {
      if (!this.host.contexts().has(context) || context.stopRequested) return
      const before = this.host.projectNavigationState(context.projectPath)
      context.state = { ...context.state, runtime: { ...context.state.runtime, lastError: errorMessage(error) } }
      this.host.publishContextState(context, before)
    })
  }
}
