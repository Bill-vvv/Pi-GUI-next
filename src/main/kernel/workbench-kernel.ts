import type {
  AppearanceSettings,
  GeneralSettings,
  KernelCommandDescriptor,
  KernelConversationEntry,
  KernelConversationEntryPatch,
  KernelConversationState,
  KernelEvent,
  KernelExtensionDescriptor,
  KernelMessageAttachment,
  KernelModelState,
  KernelProjectState,
  KernelPromptAttachment,
  KernelSessionSummary,
  KernelSessionPreview,
  KernelSessionState,
  KernelSessionUsage,
  KernelState,
  KernelStatePatch,
  RuntimeStatus,
  SessionNamingSettings,
  ThinkingLevel
} from '../../shared/kernel-contract.ts'
import {
  DEFAULT_APPEARANCE_SETTINGS,
  DEFAULT_GENERAL_SETTINGS,
  DEFAULT_SESSION_NAMING_SETTINGS
} from '../../shared/kernel-contract.ts'
import type { PiRpcEvent, PiRpcSessionState } from '../pi-rpc/pi-rpc-client.ts'
import {
  materializePrompt,
  stripPromptFileBlocks
} from '../prompt/prompt-attachments.ts'
import { isAbsolute } from 'node:path'
import {
  upsertSessionPointer,
  type ProjectSessionRegistry,
  type SessionPointer
} from '../project/session-pointer.ts'
import type { RuntimeHost, RuntimeHostEvent, RuntimeHostState } from '../runtime/runtime-host.ts'
import type { SessionNameGenerator } from '../runtime/session-name-generator.ts'
import { errorMessage } from '../utils/errors.ts'
import {
  COMPACT_COMMAND_ID,
  createCommandCatalog,
  NEW_SESSION_COMMAND_ID,
  SET_MODEL_COMMAND_ID,
  SET_SESSION_NAME_COMMAND_ID,
  SET_THINKING_COMMAND_ID
} from './command-catalog.ts'
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
  usage: null,
  thinkingLevel: null,
  messageCount: 0,
  pendingMessageCount: 0,
  pendingSteeringMessages: [],
  pendingFollowUpMessages: [],
  settled: true
}

const AUTOMATIC_SESSION_NAME_MODEL_IDS = [
  'gpt-5.4-nano',
  'gpt-5.4-mini',
  'gpt-5.6-luna'
] as const

export type RuntimeFactory = (
  project: { path: string },
  launchOptions: { sessionFile?: string }
) => RuntimeHost

export type WorkbenchKernelOptions = {
  sessionRegistry: ProjectSessionRegistry
  extensions?: readonly KernelExtensionDescriptor[]
  persistProject: (project: KernelProjectState) => Promise<void>
  persistActiveProject: (projectKey: string) => Promise<void>
  persistSession: (pointer: SessionPointer) => Promise<void>
  persistArchivedSession: (projectPath: string, sessionKey: string) => Promise<void>
  validateSession: (pointer: SessionPointer) => Promise<SessionPointer>
  readSessionActivityAt?: (pointer: SessionPointer) => Promise<number | null>
  readSessionMessages?: (pointer: SessionPointer) => Promise<unknown[]>
  persistProjectOrder?: (projectKeys: string[]) => Promise<void>
  persistSessionOrder?: (projectPath: string, sessionKeys: string[]) => Promise<void>
  sessionNaming?: SessionNamingSettings
  persistSessionNaming?: (settings: SessionNamingSettings) => Promise<void>
  appearance?: AppearanceSettings
  persistAppearance?: (settings: AppearanceSettings) => Promise<void>
  general?: GeneralSettings
  persistGeneral?: (settings: GeneralSettings) => Promise<void>
  generateSessionName?: SessionNameGenerator
}

type RuntimeContext = {
  projectPath: string
  runtime: RuntimeHost
  state: KernelState
  unsubscribeRuntime: (() => void) | null
  stopRequested: boolean
  launchCommitting: boolean
  provisionalSession: {
    runtime: RuntimeHost
    pointer: SessionPointer
    initialPrompt: string | null
  } | null
  provisionalCommit: Promise<void> | null
  provisionalSettled: boolean
  pendingSessionName: {
    runtime: RuntimeHost
    sessionFile: string
    sessionId: string
    userMessage: string
  } | null
  sessionNameOperation: {
    runtime: RuntimeHost
    controller: AbortController
  } | null
}

export class WorkbenchKernel {
  private readonly createRuntime: RuntimeFactory
  private readonly listeners = new Set<(event: KernelEvent) => void>()
  private sessionActivityAtByKey = new Map<string, number | null>()
  private readonly contexts = new Set<RuntimeContext>()
  private readonly contextByRuntime = new Map<RuntimeHost, RuntimeContext>()
  private readonly contextBySessionKey = new Map<string, RuntimeContext>()
  private readonly sessionPointersByProject = new Map<string, SessionPointer[]>()
  private readonly sessionActivityByProject = new Map<string, Map<string, number | null>>()
  private activeContext: RuntimeContext | null = null
  private suppressEvents = false
  private runtime: RuntimeHost | null = null
  private unsubscribeRuntime: (() => void) | null = null
  private sessionPointers: SessionPointer[]
  private state: KernelState
  private stopRequested = false
  private launchOperation: Promise<void> | null = null
  private projectChangeOperation: Promise<void> | null = null
  private launchCommitting = false
  private provisionalSession: {
    runtime: RuntimeHost
    pointer: SessionPointer
    initialPrompt: string | null
  } | null = null
  private provisionalCommit: Promise<void> | null = null
  private provisionalSettled = false
  private pendingSessionName: {
    runtime: RuntimeHost
    sessionFile: string
    sessionId: string
    userMessage: string
  } | null = null
  private sessionNameOperation: {
    runtime: RuntimeHost
    controller: AbortController
  } | null = null

  constructor(
    createRuntime: RuntimeFactory,
    projectRegistry: Pick<KernelState, 'projects' | 'activeProjectKey'>,
    options: WorkbenchKernelOptions
  ) {
    this.createRuntime = createRuntime
    assertProjectRegistry(projectRegistry)
    const sessionRegistry = matchingSessionRegistry(activeProject(projectRegistry), options.sessionRegistry)
    this.sessionPointers = sessionRegistry.sessions
    const initialProject = activeProject(projectRegistry)
    if (initialProject !== null) {
      this.sessionPointersByProject.set(initialProject.path, this.sessionPointers)
      this.sessionActivityByProject.set(initialProject.path, this.sessionActivityAtByKey)
    }
    this.persistProject = options.persistProject
    this.persistActiveProject = options.persistActiveProject
    this.persistSession = options.persistSession
    this.persistArchivedSession = options.persistArchivedSession
    this.validateSession = options.validateSession
    this.readSessionActivityAt = options.readSessionActivityAt ?? (async () => null)
    this.readSessionMessages = options.readSessionMessages
    this.persistProjectOrder = options.persistProjectOrder ?? (async () => {})
    this.persistSessionOrder = options.persistSessionOrder ?? (async () => {})
    this.persistSessionNaming = options.persistSessionNaming ?? (async () => {})
    this.persistAppearance = options.persistAppearance ?? (async () => {})
    this.persistGeneral = options.persistGeneral ?? (async () => {})
    this.generateSessionName = options.generateSessionName
    this.state = initialKernelState(
      projectRegistry,
      sessionRegistry,
      this.sessionActivityAtByKey,
      options.sessionNaming ?? DEFAULT_SESSION_NAMING_SETTINGS,
      options.appearance ?? DEFAULT_APPEARANCE_SETTINGS,
      options.general ?? DEFAULT_GENERAL_SETTINGS,
      options.extensions ?? []
    )
  }

  private readonly persistProject: (project: KernelProjectState) => Promise<void>
  private readonly persistActiveProject: (projectKey: string) => Promise<void>
  private readonly persistSession: (pointer: SessionPointer) => Promise<void>
  private readonly persistArchivedSession: (projectPath: string, sessionKey: string) => Promise<void>
  private readonly validateSession: ((pointer: SessionPointer) => Promise<SessionPointer>) | undefined
  private readonly readSessionActivityAt: (pointer: SessionPointer) => Promise<number | null>
  private readonly readSessionMessages: ((pointer: SessionPointer) => Promise<unknown[]>) | undefined
  private readonly persistProjectOrder: (projectKeys: string[]) => Promise<void>
  private readonly persistSessionOrder: (projectPath: string, sessionKeys: string[]) => Promise<void>
  private readonly persistSessionNaming: (settings: SessionNamingSettings) => Promise<void>
  private readonly persistAppearance: (settings: AppearanceSettings) => Promise<void>
  private readonly persistGeneral: (settings: GeneralSettings) => Promise<void>
  private readonly generateSessionName: SessionNameGenerator | undefined

  getState(): KernelState {
    const state = copyState(this.state)
    const busySessionCountByProject = new Map<string, number>()
    for (const context of this.contexts) {
      const status = context.state.runtime.status
      if (status !== 'starting' && status !== 'running' && status !== 'stopping') continue
      busySessionCountByProject.set(
        context.projectPath,
        (busySessionCountByProject.get(context.projectPath) ?? 0) + 1
      )
    }
    state.projects = state.projects.map((project) => ({
      ...project,
      busySessionCount: busySessionCountByProject.get(project.path) ?? 0
    }))
    return state
  }

  subscribe(listener: (event: KernelEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setExtensions(extensions: readonly KernelExtensionDescriptor[]): void {
    if (sameExtensions(this.state.extensions, extensions)) return
    this.state = {
      ...this.state,
      extensions: extensions.map((extension) => ({ ...extension }))
    }
    this.emitState()
  }

  async refreshSessionActivities(): Promise<void> {
    const pointers = this.sessionPointers.map((pointer) => ({ ...pointer }))
    const activityAtByKey = await this.loadSessionActivities(pointers)
    if (!sameSessionPointers(this.sessionPointers, pointers)) return
    this.sessionActivityAtByKey = activityAtByKey
    if (this.state.activeProjectKey !== null) {
      this.sessionActivityByProject.set(this.state.activeProjectKey, activityAtByKey)
    }
    this.state = {
      ...this.state,
      sessions: this.toSessionSummaries()
    }
    this.emitState()
  }

  async addProject(path: string, sessionRegistry: ProjectSessionRegistry): Promise<void> {
    if (!isAbsolute(path)) throw new Error(`Project path must be absolute: ${path}`)
    if (this.state.activeProjectKey === path) return
    await this.beginProjectChange(async () => {
      if (this.state.projects.some((project) => project.path === path)) {
        await this.activateProjectWithinChange(path, sessionRegistry)
        return
      }
      await this.persistProject({ path })
      this.state = {
        ...this.state,
        projects: [...this.state.projects, { path }]
      }
      try {
        await this.activateProjectWithinChange(path, sessionRegistry)
      } catch (error) {
        this.emitState()
        throw error
      }
    })
  }

  async activateProject(path: string, sessionRegistry: ProjectSessionRegistry): Promise<void> {
    if (!isAbsolute(path)) throw new Error(`Project path must be absolute: ${path}`)
    if (this.state.activeProjectKey === path) return
    await this.beginProjectChange(() => this.activateProjectWithinChange(path, sessionRegistry))
  }

  private async activateProjectWithinChange(
    path: string,
    sessionRegistry: ProjectSessionRegistry
  ): Promise<void> {
    if (this.state.projects.some((project) => project.path === path)) {
      if (this.state.activeProjectKey === path) return
    } else {
      throw new Error(`Project is not registered: ${path}`)
    }
    await this.persistActiveProject(path)
    this.captureActiveContext()
    const matchingRegistry = matchingSessionRegistry({ path }, sessionRegistry)
    this.sessionPointers = matchingRegistry.sessions
    this.sessionActivityAtByKey = await this.loadSessionActivities(this.sessionPointers)
    this.sessionPointersByProject.set(path, this.sessionPointers)
    this.sessionActivityByProject.set(path, this.sessionActivityAtByKey)
    this.state = initialKernelState({
      projects: this.state.projects,
      activeProjectKey: path
    }, matchingRegistry, this.sessionActivityAtByKey, this.state.sessionNaming, this.state.appearance, this.state.general, this.state.extensions)
    const managed = matchingRegistry.activeSessionKey === null
      ? null
      : this.contextBySessionKey.get(contextKey(path, matchingRegistry.activeSessionKey)) ?? null
    if (managed !== null) this.loadContext(managed)
    else this.activeContext = null
    this.emitState()
  }

  async start(): Promise<void> {
    await this.beginLaunch(async () => {
      const project = configuredProject(this.state)
      await this.launch(project, {})
    })
  }

  async activateSession(sessionKey: string): Promise<void> {
    if (!isAbsolute(sessionKey)) throw new Error(`Session key must be absolute: ${sessionKey}`)
    await this.beginLaunch(async () => {
      const project = configuredProject(this.state)
      const storedPointer = this.sessionPointers.find(
        (pointer) => pointer.projectPath === project.path && pointer.sessionFile === sessionKey
      )
      if (storedPointer === undefined) {
        throw new Error(`Session is not registered for the active project: ${sessionKey}`)
      }
      const managed = this.contextBySessionKey.get(contextKey(project.path, sessionKey))
      if (managed !== undefined) {
        this.captureActiveContext()
        this.loadContext(managed)
        this.emitState()
        return
      }
      if (typeof this.validateSession !== 'function') {
        throw new Error('Session validation is unavailable.')
      }
      const pointer = await this.validateSession(storedPointer)
      this.assertLaunchActive()
      await this.launch(project, { sessionFile: pointer.sessionFile }, pointer.sessionId)
    })
  }

  async previewSession(sessionKey: string): Promise<KernelSessionPreview> {
    if (!isAbsolute(sessionKey)) throw new Error(`Session key must be absolute: ${sessionKey}`)
    const project = configuredProject(this.state)
    const storedPointer = this.sessionPointers.find(
      (pointer) => pointer.projectPath === project.path && pointer.sessionFile === sessionKey
    )
    if (storedPointer === undefined) {
      throw new Error(`Session is not registered for the active project: ${sessionKey}`)
    }
    if (typeof this.validateSession !== 'function') {
      throw new Error('Session validation is unavailable.')
    }
    if (typeof this.readSessionMessages !== 'function') {
      throw new Error('Session preview is unavailable.')
    }

    const pointer = await this.validateSession(storedPointer)
    const messages = await this.readSessionMessages(pointer)
    if (
      this.state.activeProjectKey !== project.path ||
      !this.sessionPointers.some((candidate) =>
        candidate.projectPath === project.path &&
        candidate.sessionFile === pointer.sessionFile &&
        candidate.sessionId === pointer.sessionId
      )
    ) {
      throw new Error('Session preview cancelled because the active project changed.')
    }

    return {
      projectKey: project.path,
      sessionKey: pointer.sessionFile,
      sessionId: pointer.sessionId,
      sessionName: pointer.sessionName,
      conversation: {
        entries: projectMessages(messages),
        activeRunStartIndex: null
      }
    }
  }

  async archiveSession(sessionKey: string): Promise<void> {
    if (!isAbsolute(sessionKey)) throw new Error(`Session key must be absolute: ${sessionKey}`)
    const project = configuredProject(this.state)
    const pointer = this.sessionPointers.find((candidate) =>
      candidate.projectPath === project.path && candidate.sessionFile === sessionKey
    )
    if (pointer === undefined) {
      throw new Error(`Session is not registered for the active project: ${sessionKey}`)
    }

    await this.beginProjectChange(async () => {
      const isActive = this.state.activeSessionKey === sessionKey
      const targetContext = this.contextBySessionKey.get(contextKey(project.path, sessionKey)) ?? null
      if (targetContext !== null) await this.stopContext(targetContext)
      await this.persistArchivedSession(project.path, sessionKey)

      this.sessionPointers = this.sessionPointers.filter((candidate) =>
        candidate.sessionFile !== sessionKey
      )
      this.sessionActivityAtByKey.delete(sessionKey)
      this.sessionPointersByProject.set(project.path, this.sessionPointers)
      const sessions = this.toSessionSummaries()
      this.state = isActive
        ? {
            ...this.state,
            sessions,
            activeSessionKey: null,
            commands: createCommandCatalog(),
            availableModels: [],
            session: { ...INITIAL_SESSION_STATE },
            conversation: { entries: [], activeRunStartIndex: null }
          }
        : { ...this.state, sessions }
      this.emitState()
    })
  }

  async reorderProjects(projectKeys: string[]): Promise<void> {
    const currentKeys = this.state.projects.map(({ path }) => path)
    assertStrictPermutation(currentKeys, projectKeys, 'project')
    await this.persistProjectOrder(projectKeys)
    const projectsByKey = new Map(this.state.projects.map((project) => [project.path, project]))
    this.state = {
      ...this.state,
      projects: projectKeys.map((key) => ({ ...projectsByKey.get(key)! }))
    }
    this.emitState()
  }

  async reorderSessions(sessionKeys: string[]): Promise<void> {
    const project = configuredProject(this.state)
    const currentKeys = this.sessionPointers.map(({ sessionFile }) => sessionFile)
    assertStrictPermutation(currentKeys, sessionKeys, 'session')
    await this.persistSessionOrder(project.path, sessionKeys)
    const pointersByKey = new Map(
      this.sessionPointers.map((pointer) => [pointer.sessionFile, pointer])
    )
    this.sessionPointers = sessionKeys.map((key) => ({ ...pointersByKey.get(key)! }))
    this.sessionPointersByProject.set(project.path, this.sessionPointers)
    this.state = {
      ...this.state,
      sessions: this.toSessionSummaries()
    }
    this.emitState()
  }

  async resumeSession(): Promise<void> {
    if (this.state.activeSessionKey === null) {
      throw new Error('No active session is available for this project.')
    }
    await this.activateSession(this.state.activeSessionKey)
  }

  private beginLaunch(task: () => Promise<void>): Promise<void> {
    if (this.projectChangeOperation !== null) {
      throw new Error('Cannot launch a runtime while a project change is in progress.')
    }
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
    const previousContext = this.activeContext
    const previousState = copyState(this.state)
    this.captureActiveContext()
    const runtime = this.createRuntime(project, launchOptions)
    this.runtime = runtime
    const context: RuntimeContext = {
      projectPath: project.path,
      runtime,
      state: copyState(this.state),
      unsubscribeRuntime: null,
      stopRequested: false,
      launchCommitting: false,
      provisionalSession: null,
      provisionalCommit: null,
      provisionalSettled: false,
      pendingSessionName: null,
      sessionNameOperation: null
    }
    this.contexts.add(context)
    this.contextByRuntime.set(runtime, context)
    this.activeContext = context
    this.unsubscribeRuntime = runtime.subscribe((event) => {
      this.handleContextEvent(context, event)
    })
    context.unsubscribeRuntime = this.unsubscribeRuntime

    this.state = {
      ...this.state,
      activeSessionKey: launchOptions.sessionFile === undefined ? null : this.state.activeSessionKey,
      commands: createCommandCatalog(),
      availableModels: [],
      ...(launchOptions.sessionFile === undefined
        ? {
            session: { ...INITIAL_SESSION_STATE },
            conversation: { entries: [], activeRunStartIndex: null }
          }
        : {})
    }
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
      context.state = copyState(this.state)
      const availableModelsResult = await runtime.send({ type: 'get_available_models' })
      this.assertStartActive(runtime)
      if (availableModelsResult.type !== 'available-models') {
        throw new Error('Runtime returned an invalid model catalog.')
      }
      const availableModels = availableModelsResult.models.map(toAvailableKernelModel)
      const commandsResult = await runtime.send({ type: 'get_commands' })
      this.assertStartActive(runtime)
      if (commandsResult.type !== 'commands') {
        throw new Error('Runtime returned an invalid command catalog.')
      }
      const commands = createCommandCatalog(commandsResult.commands)
      const messagesResult = await runtime.send({ type: 'get_messages' })
      this.assertStartActive(runtime)
      if (messagesResult.type !== 'messages') {
        throw new Error('Runtime returned an invalid startup projection.')
      }
      const projectedMessages = projectMessages(messagesResult.messages)
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
        this.provisionalSession = { runtime, pointer, initialPrompt: null }
        this.state = {
          ...this.state,
          activeSessionKey: null,
          commands,
          availableModels,
          runtime: toKernelRuntime('ready', runtime.getState()),
          session: { ...session, resumeAvailable: false },
          conversation: {
            entries: projectedMessages,
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
        await this.captureSessionActivity(canonicalPointer)
        this.assertStartActive(runtime)
        this.state = {
          ...this.state,
          sessions: this.toSessionSummaries(),
          activeSessionKey: canonicalPointer.sessionFile,
          commands,
          availableModels,
          runtime: toKernelRuntime('ready', runtime.getState()),
          session,
          conversation: {
            entries: projectedMessages,
            activeRunStartIndex: null
          }
        }
        this.contextBySessionKey.set(contextKey(project.path, canonicalPointer.sessionFile), context)
        this.queueSessionNameGeneration(
          runtime,
          canonicalPointer,
          firstUserMessage(projectedMessages)
        )
        this.emitState()
        this.beginSessionNameGeneration()
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
      const failedRuntime = toKernelRuntime('crashed', runtime.getState(), errorMessage(launchError))
      if (previousContext !== null && this.contexts.has(previousContext)) {
        this.loadContext(previousContext)
      } else {
        this.activeContext = null
        this.runtime = null
        this.unsubscribeRuntime = null
        this.provisionalSession = null
        this.provisionalCommit = null
        this.provisionalSettled = false
        this.pendingSessionName = null
        this.sessionNameOperation = null
        this.state = { ...previousState, runtime: failedRuntime }
      }
      this.emitState()
      throw launchError
    }
  }

  private async cleanupFailedLaunch(runtime: RuntimeHost, error: unknown): Promise<unknown> {
    const context = this.contextByRuntime.get(runtime)
    context?.unsubscribeRuntime?.()
    if (this.runtime === runtime) this.unsubscribeRuntime = null
    let cleanupError: unknown = null
    try {
      await runtime.stop()
    } catch (caught) {
      cleanupError = caught
    }
    if (cleanupError === null && context !== undefined) {
      this.contexts.delete(context)
      this.contextByRuntime.delete(runtime)
      for (const [key, candidate] of this.contextBySessionKey) {
        if (candidate === context) this.contextBySessionKey.delete(key)
      }
      if (this.activeContext === context) this.activeContext = null
    }
    if (this.runtime === runtime) this.runtime = null
    if (cleanupError === null) return error
    return new Error(
      `${errorMessage(error)} Cleanup failed while stopping runtime: ${errorMessage(cleanupError)}`,
      { cause: error }
    )
  }

  async prompt(message: string, attachments: readonly KernelPromptAttachment[] = []): Promise<void> {
    const runtime = this.requireRuntime('ready')
    if (message.trim().length === 0 && attachments.length === 0) {
      throw new Error('Prompt must not be empty.')
    }
    const materialized = materializePrompt(message, attachments)
    const provisional = this.provisionalSession?.runtime === runtime &&
      this.provisionalSession.pointer.sessionName === null &&
      this.provisionalSession.initialPrompt === null
      ? this.provisionalSession
      : null
    if (provisional !== null) {
      provisional.initialPrompt = message.trim().length > 0
        ? message
        : attachments.map((attachment) => attachment.name).join(', ')
    }

    this.state = {
      ...this.state,
      runtime: toKernelRuntime('running', runtime.getState()),
      session: { ...this.state.session, settled: false },
      conversation: beginConversationRun(this.state.conversation)
    }
    this.emitState()
    try {
      await runtime.send({
        type: 'prompt',
        message: materialized.message,
        ...(materialized.images.length === 0 ? {} : { images: materialized.images })
      })
    } catch (error) {
      if (
        provisional !== null &&
        this.provisionalSession === provisional &&
        provisional.pointer.sessionName === null
      ) {
        provisional.initialPrompt = null
      }
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

  async steer(message: string, attachments: readonly KernelPromptAttachment[] = []): Promise<void> {
    const runtime = this.requireRuntime('running')
    if (message.trim().length === 0 && attachments.length === 0) {
      throw new Error('Steering message must not be empty.')
    }
    const materialized = materializePrompt(message, attachments)
    await runtime.send({
      type: 'steer',
      message: materialized.message,
      ...(materialized.images.length === 0 ? {} : { images: materialized.images })
    })
  }

  async followUp(message: string, attachments: readonly KernelPromptAttachment[] = []): Promise<void> {
    const runtime = this.requireRuntime('running')
    if (message.trim().length === 0 && attachments.length === 0) {
      throw new Error('Follow-up message must not be empty.')
    }
    const materialized = materializePrompt(message, attachments)
    await runtime.send({
      type: 'follow_up',
      message: materialized.message,
      ...(materialized.images.length === 0 ? {} : { images: materialized.images })
    })
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

  async setSessionNaming(settings: SessionNamingSettings): Promise<void> {
    assertSessionNamingSettings(settings)
    if (sameSessionNamingSettings(this.state.sessionNaming, settings)) return
    if (settings.mode === 'model' && !this.state.availableModels.some((model) =>
      model.provider === settings.provider && model.id === settings.modelId
    )) {
      throw new Error(`Session naming model is not currently available: ${settings.provider}/${settings.modelId}`)
    }

    const nextSettings = copySessionNamingSettings(settings)
    await this.persistSessionNaming(nextSettings)
    this.cancelSessionNameGeneration()
    this.state = { ...this.state, sessionNaming: nextSettings }
    this.emitState()

    const runtime = this.runtime
    const activePointer = this.sessionPointers.find((pointer) =>
      pointer.sessionFile === this.state.activeSessionKey
    )
    if (
      runtime !== null &&
      this.state.runtime.status === 'ready' &&
      this.state.session.name === null &&
      activePointer !== undefined
    ) {
      this.queueSessionNameGeneration(
        runtime,
        activePointer,
        firstUserMessage(this.state.conversation.entries)
      )
      this.beginSessionNameGeneration()
    }
  }

  async setAppearance(settings: AppearanceSettings): Promise<void> {
    assertAppearanceSettings(settings)
    if (sameAppearanceSettings(this.state.appearance, settings)) return
    const nextSettings = copyAppearanceSettings(settings)
    await this.persistAppearance(nextSettings)
    this.state = { ...this.state, appearance: nextSettings }
    this.emitState()
  }

  async setGeneral(settings: GeneralSettings): Promise<void> {
    assertGeneralSettings(settings)
    if (sameGeneralSettings(this.state.general, settings)) return
    const nextSettings = copyGeneralSettings(settings)
    await this.persistGeneral(nextSettings)
    this.state = { ...this.state, general: nextSettings }
    this.emitState()
  }

  async invokeCommand(commandId: string, argument: string): Promise<void> {
    const command = this.state.commands.find(({ id }) => id === commandId)
    if (command === undefined) throw new Error(`Command is not available: ${commandId}`)

    if (command.id === NEW_SESSION_COMMAND_ID) {
      assertNoCommandArgument(command, argument)
      await this.start()
      return
    }
    if (command.id === SET_MODEL_COMMAND_ID) {
      const { provider, modelId } = parseModelArgument(argument)
      await this.setModel(provider, modelId)
      return
    }
    if (command.id === SET_THINKING_COMMAND_ID) {
      const level = thinkingLevel(argument.trim())
      if (level === null) {
        throw new Error('Thinking level must be off, minimal, low, medium, high, xhigh, or max.')
      }
      await this.setThinkingLevel(level)
      return
    }
    if (command.id === COMPACT_COMMAND_ID) {
      const runtime = this.requireRuntime('ready')
      const customInstructions = argument.trim()
      await runtime.send({
        type: 'compact',
        ...(customInstructions.length === 0 ? {} : { customInstructions })
      })
      await this.refreshCompactedProjection(runtime)
      return
    }
    if (command.id === SET_SESSION_NAME_COMMAND_ID) {
      const name = argument.trim()
      if (name.length === 0) throw new Error('Session name must not be empty.')
      const runtime = this.requireRuntime('ready')
      this.cancelSessionNameGeneration(runtime)
      await runtime.send({ type: 'set_session_name', name })
      await this.refreshRenamedSession(runtime)
      return
    }

    await this.invokePiCommand(command, argument)
  }

  private async invokePiCommand(command: KernelCommandDescriptor, argument: string): Promise<void> {
    if (command.source !== 'extension' && command.source !== 'prompt' && command.source !== 'skill') {
      throw new Error(`Command has no execution path: ${command.id}`)
    }
    const runtime = this.requireRuntime('ready')
    const commandText = argument.trim().length === 0
      ? `/${command.name}`
      : `/${command.name} ${argument.trim()}`
    await this.prompt(commandText)
    if (this.runtime !== runtime || this.state.runtime.status !== 'running') {
      return
    }

    const stateResult = await runtime.send({ type: 'get_state' })
    if (stateResult.type !== 'state') throw new Error('Runtime did not return session state.')
    if (
      this.runtime === runtime &&
      this.state.runtime.status === 'running' &&
      stateResult.state.isStreaming !== true
    ) {
      this.state = this.withActiveSessionActivity({
        ...this.state,
        runtime: toKernelRuntime('ready', runtime.getState()),
        session: toKernelSession(
          stateResult.state,
          this.state.session.resumeAvailable,
          this.state.session.usage
        ),
        conversation: settleConversationRun(this.state.conversation)
      })
      this.emitState()
    }
  }

  async stop(): Promise<void> {
    if (this.launchCommitting) await this.waitForLaunchToSettle()
    const pendingCommits = [...this.contexts]
      .map((context) => context.provisionalCommit)
      .filter((commit): commit is Promise<void> => commit !== null)
    await Promise.all(pendingCommits)
    this.stopRequested = true
    await this.waitForLaunchToSettle()
    const contexts = [...this.contexts]
    let firstError: unknown = null
    for (const context of contexts) {
      try {
        await this.stopContext(context)
      } catch (error) {
        firstError ??= error
      }
    }
    if (this.contexts.size === 0 && this.state.runtime.status !== 'stopped') {
      this.state = {
        ...this.state,
        commands: createCommandCatalog(),
        runtime: toKernelRuntime('stopped', INITIAL_HOST_STATE)
      }
      this.emitState()
    }
    this.stopRequested = false
    if (firstError !== null) throw firstError
  }

  private async stopContext(context: RuntimeContext): Promise<void> {
    if (!this.contexts.has(context)) return
    context.stopRequested = true
    context.sessionNameOperation?.controller.abort()
    context.pendingSessionName = null
    context.sessionNameOperation = null
    context.state = {
      ...context.state,
      runtime: toKernelRuntime('stopping', context.runtime.getState())
    }
    if (this.activeContext === context) {
      this.state = copyState(context.state)
      this.emitState()
    } else {
      this.emitState()
    }
    let stopError: unknown = null
    try {
      await context.runtime.stop()
    } catch (error) {
      stopError = error
    }
    context.unsubscribeRuntime?.()
    context.unsubscribeRuntime = null
    context.state = {
      ...context.state,
      commands: createCommandCatalog(),
      runtime: toKernelRuntime(
        stopError === null ? 'stopped' : 'crashed',
        context.runtime.getState(),
        stopError === null ? undefined : errorMessage(stopError)
      )
    }
    this.contexts.delete(context)
    this.contextByRuntime.delete(context.runtime)
    for (const [key, candidate] of this.contextBySessionKey) {
      if (candidate === context) this.contextBySessionKey.delete(key)
    }
    if (this.activeContext === context) {
      this.activeContext = null
      this.runtime = null
      this.unsubscribeRuntime = null
      this.provisionalSession = null
      this.provisionalCommit = null
      this.provisionalSettled = false
      this.pendingSessionName = null
      this.sessionNameOperation = null
      this.state = copyState(context.state)
    }
    if (this.state.activeProjectKey === context.projectPath) {
      this.state = { ...this.state, sessions: this.toSessionSummaries() }
    }
    this.emitState()
    if (stopError !== null) throw stopError
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
      session: toKernelSession(
        result.state,
        this.state.session.resumeAvailable,
        this.state.session.usage
      )
    }
    this.emitState()
  }

  private async refreshSessionUsage(runtime: RuntimeHost): Promise<void> {
    try {
      const result = await runtime.send({ type: 'get_state' })
      if (result.type !== 'state') return
      const usage = toKernelSessionUsage(result.state)
      const context = this.contextByRuntime.get(runtime)
      if (context === undefined || usage === null) return
      if (this.activeContext !== context) {
        if (sameSessionUsage(context.state.session.usage, usage)) return
        context.state = {
          ...context.state,
          session: { ...context.state.session, usage }
        }
        if (this.state.activeProjectKey === context.projectPath) this.emitState()
        return
      }
      if (sameSessionUsage(this.state.session.usage, usage)) return
      this.state = {
        ...this.state,
        session: { ...this.state.session, usage }
      }
      this.emitState()
    } catch {
      // Usage is supplementary telemetry; keep the conversation usable if it is unavailable.
    }
  }

  private async refreshCompactedProjection(runtime: RuntimeHost): Promise<void> {
    const stateResult = await runtime.send({ type: 'get_state' })
    if (stateResult.type !== 'state') throw new Error('Runtime did not return session state.')
    const messagesResult = await runtime.send({ type: 'get_messages' })
    if (messagesResult.type !== 'messages') {
      throw new Error('Runtime did not return conversation messages.')
    }
    if (this.runtime !== runtime) return
    this.state = {
      ...this.state,
      session: toKernelSession(
        stateResult.state,
        this.state.session.resumeAvailable,
        this.state.session.usage
      ),
      conversation: {
        entries: projectMessages(messagesResult.messages),
        activeRunStartIndex: null
      }
    }
    this.emitState()
  }

  private async refreshRenamedSession(runtime: RuntimeHost): Promise<void> {
    const result = await runtime.send({ type: 'get_state' })
    if (result.type !== 'state') throw new Error('Runtime did not return session state.')
    if (this.runtime !== runtime) return

    const session = toKernelSession(
      result.state,
      this.state.session.resumeAvailable,
      this.state.session.usage
    )
    const sessionFile = stringValue(result.state.sessionFile)
    if (session.id === null || sessionFile === null || !isAbsolute(sessionFile)) {
      throw new Error('Runtime did not return a valid session identity.')
    }
    const provisional = this.provisionalSession?.runtime === runtime
      ? this.provisionalSession
      : null
    const storedPointer = provisional?.pointer ?? this.sessionPointers.find((pointer) =>
      pointer.sessionFile === this.state.activeSessionKey ||
      (pointer.projectPath === this.state.activeProjectKey && pointer.sessionId === session.id)
    )
    if (storedPointer === undefined || storedPointer === null) {
      throw new Error('Active session pointer is unavailable.')
    }
    let pointer: SessionPointer = {
      ...storedPointer,
      sessionFile: provisional === null ? storedPointer.sessionFile : sessionFile,
      sessionId: session.id,
      sessionName: session.name
    }
    if (provisional !== null) {
      provisional.pointer = pointer
      if (typeof this.validateSession !== 'function') {
        throw new Error('Session validation is unavailable.')
      }
      pointer = await this.validateSession(pointer)
      if (this.provisionalSession !== provisional || this.runtime !== runtime) return
    }
    await this.persistSession(pointer)
    if (this.runtime !== runtime || (provisional !== null && this.provisionalSession !== provisional)) {
      return
    }

    this.sessionPointers = upsertSessionPointer(this.sessionPointers, pointer)
    await this.captureSessionActivity(pointer)
    if (this.runtime !== runtime) return
    if (provisional !== null) {
      this.provisionalSession = null
      this.provisionalSettled = false
    }
    const renamedContext = this.contextByRuntime.get(runtime)
    if (renamedContext !== undefined) {
      for (const [key, candidate] of this.contextBySessionKey) {
        if (candidate === renamedContext) this.contextBySessionKey.delete(key)
      }
      this.contextBySessionKey.set(contextKey(pointer.projectPath, pointer.sessionFile), renamedContext)
    }
    this.state = {
      ...this.state,
      sessions: this.toSessionSummaries(),
      activeSessionKey: pointer.sessionFile,
      session: { ...session, resumeAvailable: true }
    }
    this.emitState()
  }

  private assertProjectActivationAllowed(): void {
    if (this.launchOperation !== null) {
      throw new Error('Cannot change project while a runtime launch is in progress.')
    }
  }

  private beginProjectChange(task: () => Promise<void>): Promise<void> {
    if (this.projectChangeOperation !== null) {
      throw new Error('A project change is already in progress.')
    }
    this.assertProjectActivationAllowed()
    const operation = this.performProjectChange(task)
    this.projectChangeOperation = operation
    return operation
  }

  private async performProjectChange(task: () => Promise<void>): Promise<void> {
    await Promise.resolve()
    try {
      await task()
    } finally {
      this.projectChangeOperation = null
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
        this.state = this.withActiveSessionActivity({
          ...this.state,
          runtime: toKernelRuntime('ready', this.runtime.getState()),
          session: { ...this.state.session, settled: true },
          conversation: settleConversationRun(this.state.conversation)
        })
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
      nextState = this.withActiveSessionActivity({
        ...nextState,
        runtime: toKernelRuntime('ready', this.runtime.getState()),
        session: {
          ...nextState.session,
          settled: true,
          pendingMessageCount: 0,
          pendingSteeringMessages: [],
          pendingFollowUpMessages: []
        },
        conversation: settleConversationRun(nextState.conversation)
      })
    } else if (event.type === 'message_end') {
      nextState = {
        ...nextState,
        session: { ...nextState.session, messageCount: nextState.session.messageCount + 1 }
      }
    } else if (event.type === 'queue_update') {
      const { steering, followUp } = event
      if (
        Array.isArray(steering) &&
        steering.every((message): message is string => typeof message === 'string') &&
        Array.isArray(followUp) &&
        followUp.every((message): message is string => typeof message === 'string')
      ) {
        const pendingSteeringMessages = steering.map(stripPromptFileBlocks)
        const pendingFollowUpMessages = followUp.map(stripPromptFileBlocks)
        nextState = {
          ...nextState,
          session: {
            ...nextState.session,
            pendingMessageCount: pendingSteeringMessages.length + pendingFollowUpMessages.length,
            pendingSteeringMessages,
            pendingFollowUpMessages
          }
        }
      }
    } else if (event.type === 'session_info_changed' && typeof event.name === 'string') {
      const sessionName = event.name
      const provisional = this.provisionalSession?.runtime === this.runtime
        ? this.provisionalSession
        : null
      if (provisional !== null) {
        provisional.pointer = { ...provisional.pointer, sessionName }
      } else {
        const pointerIndex = this.sessionPointers.findIndex((pointer) =>
          pointer.sessionFile === nextState.activeSessionKey
        )
        if (pointerIndex !== -1) {
          this.sessionPointers = this.sessionPointers.map((pointer, index) =>
            index === pointerIndex ? { ...pointer, sessionName } : pointer
          )
          nextState = {
            ...nextState,
            sessions: this.toSessionSummaries()
          }
        }
      }
      nextState = {
        ...nextState,
        session: { ...nextState.session, name: sessionName }
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
    if (hasAssistantUsage(event)) void this.refreshSessionUsage(this.runtime)
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
    if (event.type === 'agent_settled') this.beginSessionNameGeneration()
  }

  private beginProvisionalCommit(): void {
    const provisional = this.provisionalSession
    if (provisional === null || provisional.runtime !== this.runtime || this.provisionalCommit !== null) {
      return
    }
    const context = this.contextByRuntime.get(provisional.runtime)
    if (this.suppressEvents && context !== undefined) {
      const commit = this.commitBackgroundProvisional(context, provisional)
      context.provisionalCommit = commit
      this.provisionalCommit = commit
      void commit.finally(() => {
        if (context.provisionalCommit === commit) context.provisionalCommit = null
      })
      return
    }
    const commit = this.commitProvisionalSession(provisional)
    this.provisionalCommit = commit
    void commit.finally(() => {
      if (this.provisionalCommit === commit) this.provisionalCommit = null
    })
  }

  private async commitBackgroundProvisional(
    context: RuntimeContext,
    provisional: NonNullable<RuntimeContext['provisionalSession']>
  ): Promise<void> {
    try {
      if (typeof this.validateSession !== 'function') {
        throw new Error('Session validation is unavailable.')
      }
      let pointer = await this.validateSession(provisional.pointer)
      if (!this.contexts.has(context) || context.provisionalSession !== provisional) return
      if (provisional.pointer.sessionName !== null) {
        pointer = { ...pointer, sessionName: provisional.pointer.sessionName }
      }
      await this.persistSession(pointer)
      if (!this.contexts.has(context) || context.provisionalSession !== provisional) return
      const pointers = upsertSessionPointer(
        this.sessionPointersByProject.get(context.projectPath) ?? [],
        pointer
      )
      this.sessionPointersByProject.set(context.projectPath, pointers)
      const activities = this.sessionActivityByProject.get(context.projectPath) ?? new Map()
      activities.set(pointer.sessionFile, await this.readSessionActivityAt(pointer))
      this.sessionActivityByProject.set(context.projectPath, activities)
      this.contextBySessionKey.set(contextKey(context.projectPath, pointer.sessionFile), context)
      context.provisionalSession = null
      context.state = {
        ...context.state,
        activeSessionKey: pointer.sessionFile,
        session: {
          ...context.state.session,
          resumeAvailable: true,
          settled: context.provisionalSettled ? true : context.state.session.settled
        },
        runtime: context.provisionalSettled
          ? toKernelRuntime('ready', context.runtime.getState())
          : context.state.runtime,
        conversation: context.provisionalSettled
          ? settleConversationRun(context.state.conversation)
          : context.state.conversation
      }
      context.provisionalSettled = false
      if (pointer.sessionName === null && provisional.initialPrompt !== null) {
        const pending = {
          runtime: context.runtime,
          sessionFile: pointer.sessionFile,
          sessionId: pointer.sessionId,
          userMessage: provisional.initialPrompt
        }
        context.pendingSessionName = pending
        if (context.state.runtime.status === 'ready') {
          this.beginBackgroundSessionNameGeneration(context, pending)
        }
      }
      if (this.state.activeProjectKey === context.projectPath) {
        this.sessionPointers = pointers
        this.sessionActivityAtByKey = activities
        this.state = { ...this.state, sessions: this.toSessionSummaries() }
        this.emitState()
      }
    } catch (error) {
      if (!this.contexts.has(context) || context.provisionalSession !== provisional) return
      if (isEnoent(error)) return
      context.provisionalSession = null
      context.provisionalSettled = false
      context.state = {
        ...context.state,
        runtime: toKernelRuntime('crashed', context.runtime.getState(), errorMessage(error))
      }
      this.emitState()
    }
  }

  private async commitProvisionalSession(
    provisional: {
      runtime: RuntimeHost
      pointer: SessionPointer
      initialPrompt: string | null
    }
  ): Promise<void> {
    try {
      if (typeof this.validateSession !== 'function') {
        throw new Error('Session validation is unavailable.')
      }
      let canonicalPointer = await this.validateSession(provisional.pointer)
      if (this.provisionalSession !== provisional || this.runtime !== provisional.runtime) return
      if (provisional.pointer.sessionName !== null) {
        canonicalPointer = {
          ...canonicalPointer,
          sessionName: provisional.pointer.sessionName
        }
      }
      await this.persistSession(canonicalPointer)
      if (this.provisionalSession !== provisional || this.runtime !== provisional.runtime) return
      this.sessionPointers = upsertSessionPointer(this.sessionPointers, canonicalPointer)
      await this.captureSessionActivity(canonicalPointer)
      if (this.provisionalSession !== provisional || this.runtime !== provisional.runtime) return
      this.queueSessionNameGeneration(provisional.runtime, canonicalPointer, provisional.initialPrompt)
      const materializedContext = this.contextByRuntime.get(provisional.runtime)
      if (materializedContext !== undefined) {
        this.contextBySessionKey.set(
          contextKey(canonicalPointer.projectPath, canonicalPointer.sessionFile),
          materializedContext
        )
      }
      this.provisionalSession = null
      this.state = {
        ...this.state,
        sessions: this.toSessionSummaries(),
        activeSessionKey: canonicalPointer.sessionFile,
        session: { ...this.state.session, resumeAvailable: true }
      }
      this.finishDeferredSettled(provisional.runtime)
      this.emitState()
      this.beginSessionNameGeneration()
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
    this.state = this.withActiveSessionActivity({
      ...this.state,
      runtime: toKernelRuntime('ready', runtime.getState()),
      session: {
        ...this.state.session,
        settled: true,
        pendingMessageCount: 0,
        pendingSteeringMessages: [],
        pendingFollowUpMessages: []
      },
      conversation: settleConversationRun(this.state.conversation)
    })
  }

  private beginSessionNameGeneration(): void {
    const pending = this.pendingSessionName
    if (pending === null || this.sessionNameOperation !== null) return
    const backgroundContext = this.contextByRuntime.get(pending.runtime)
    if (this.suppressEvents && backgroundContext !== undefined) {
      this.beginBackgroundSessionNameGeneration(backgroundContext, pending)
      return
    }
    if (this.generateSessionName === undefined) {
      this.pendingSessionName = null
      return
    }
    if (
      this.runtime !== pending.runtime ||
      this.state.activeSessionKey !== pending.sessionFile ||
      this.state.session.id !== pending.sessionId
    ) {
      this.pendingSessionName = null
      return
    }
    if (this.state.runtime.status !== 'ready') return
    if (this.state.session.name !== null) {
      this.pendingSessionName = null
      return
    }

    const executable = pending.runtime.getState().executable
    const project = activeProject(this.state)
    const model = selectSessionNameModel(
      this.state.sessionNaming,
      this.state.availableModels,
      this.state.session.model?.provider ?? null
    )
    if (executable === null || project === null || model === null) {
      this.pendingSessionName = null
      return
    }
    const assistantMessage = lastAssistantMessage(this.state.conversation.entries)
    const controller = new AbortController()
    const operation = { runtime: pending.runtime, controller }
    this.sessionNameOperation = operation
    void this.generateSessionName({
      executable,
      cwd: project.path,
      provider: model.provider,
      modelId: model.id,
      userMessage: pending.userMessage,
      assistantMessage,
      signal: controller.signal
    }).then(async (generatedName) => {
      const name = normalizeGeneratedSessionName(generatedName)
      if (
        name === null ||
        controller.signal.aborted ||
        this.sessionNameOperation !== operation ||
        this.pendingSessionName !== pending ||
        this.runtime !== pending.runtime ||
        this.state.runtime.status !== 'ready' ||
        this.state.activeSessionKey !== pending.sessionFile ||
        this.state.session.id !== pending.sessionId ||
        this.state.session.name !== null
      ) return

      await pending.runtime.send({ type: 'set_session_name', name })
      if (
        controller.signal.aborted ||
        this.sessionNameOperation !== operation ||
        this.pendingSessionName !== pending ||
        this.runtime !== pending.runtime ||
        this.state.activeSessionKey !== pending.sessionFile
      ) return
      await this.refreshRenamedSession(pending.runtime)
    }).catch(() => {
      // Automatic naming is metadata enrichment; leave the session unnamed on failure.
    }).finally(() => {
      if (this.sessionNameOperation === operation) this.sessionNameOperation = null
      if (this.pendingSessionName === pending) this.pendingSessionName = null
    })
  }

  private beginBackgroundSessionNameGeneration(
    context: RuntimeContext,
    pending: NonNullable<RuntimeContext['pendingSessionName']>
  ): void {
    if (this.generateSessionName === undefined || context.state.runtime.status !== 'ready') {
      context.pendingSessionName = null
      return
    }
    const model = selectSessionNameModel(
      this.state.sessionNaming,
      context.state.availableModels,
      context.state.session.model?.provider ?? null
    )
    const executable = context.runtime.getState().executable
    if (model === null || executable === null) {
      context.pendingSessionName = null
      return
    }
    const controller = new AbortController()
    const operation = { runtime: context.runtime, controller }
    context.sessionNameOperation = operation
    if (this.activeContext === context) this.sessionNameOperation = operation
    void this.generateSessionName({
      executable,
      cwd: context.projectPath,
      provider: model.provider,
      modelId: model.id,
      userMessage: pending.userMessage,
      assistantMessage: lastAssistantMessage(context.state.conversation.entries),
      signal: controller.signal
    }).then(async (generated) => {
      const name = normalizeGeneratedSessionName(generated)
      if (
        name === null ||
        controller.signal.aborted ||
        context.sessionNameOperation !== operation ||
        context.pendingSessionName !== pending ||
        context.state.runtime.status !== 'ready' ||
        context.state.session.name !== null
      ) return
      await context.runtime.send({ type: 'set_session_name', name })
      const pointer = (this.sessionPointersByProject.get(context.projectPath) ?? []).find(
        ({ sessionFile }) => sessionFile === pending.sessionFile
      )
      if (pointer === undefined || controller.signal.aborted) return
      const renamed = { ...pointer, sessionName: name }
      await this.persistSession(renamed)
      const pointers = upsertSessionPointer(
        this.sessionPointersByProject.get(context.projectPath) ?? [],
        renamed
      )
      this.sessionPointersByProject.set(context.projectPath, pointers)
      context.state = {
        ...context.state,
        session: { ...context.state.session, name }
      }
      if (this.state.activeProjectKey === context.projectPath) {
        this.sessionPointers = pointers
        this.state = { ...this.state, sessions: this.toSessionSummaries() }
        this.emitState()
      }
    }).catch(() => {
      // Automatic naming remains best-effort metadata enrichment.
    }).finally(() => {
      if (context.sessionNameOperation === operation) context.sessionNameOperation = null
      if (context.pendingSessionName === pending) context.pendingSessionName = null
    })
  }

  private queueSessionNameGeneration(
    runtime: RuntimeHost,
    pointer: SessionPointer,
    userMessage: string | null
  ): void {
    this.pendingSessionName = pointer.sessionName === null && userMessage !== null
      ? {
          runtime,
          sessionFile: pointer.sessionFile,
          sessionId: pointer.sessionId,
          userMessage
        }
      : null
  }

  private cancelSessionNameGeneration(runtime?: RuntimeHost): void {
    if (this.pendingSessionName !== null && (
      runtime === undefined || this.pendingSessionName.runtime === runtime
    )) {
      this.pendingSessionName = null
    }
    if (this.sessionNameOperation !== null && (
      runtime === undefined || this.sessionNameOperation.runtime === runtime
    )) {
      const operation = this.sessionNameOperation
      this.sessionNameOperation = null
      operation.controller.abort()
    }
  }

  private async loadSessionActivities(
    pointers: SessionPointer[]
  ): Promise<Map<string, number | null>> {
    const entries = await Promise.all(pointers.map(async (pointer) => [
      pointer.sessionFile,
      await this.readSessionActivityAt(pointer)
    ] as const))
    return new Map(entries)
  }

  private async captureSessionActivity(pointer: SessionPointer): Promise<void> {
    this.sessionActivityAtByKey.set(
      pointer.sessionFile,
      await this.readSessionActivityAt(pointer)
    )
  }

  private withActiveSessionActivity(state: KernelState): KernelState {
    if (state.activeSessionKey === null) return state
    this.sessionActivityAtByKey.set(state.activeSessionKey, Date.now())
    return {
      ...state,
      sessions: this.toSessionSummaries()
    }
  }

  private toSessionSummaries(): KernelSessionSummary[] {
    const projectPath = this.state.activeProjectKey
    return toKernelSessionSummaries(
      this.sessionPointers,
      this.sessionActivityAtByKey,
      (sessionKey) => projectPath === null
        ? 'stopped'
        : this.contextBySessionKey.get(contextKey(projectPath, sessionKey))?.state.runtime.status ??
          'stopped'
    )
  }

  private clearProvisionalSession(runtime: RuntimeHost): void {
    if (this.provisionalSession?.runtime !== runtime) return
    this.provisionalSession = null
    this.provisionalSettled = false
  }

  private captureActiveContext(): void {
    const context = this.activeContext
    if (context === null || this.runtime !== context.runtime) return
    context.state = copyState(this.state)
    context.unsubscribeRuntime = this.unsubscribeRuntime
    context.stopRequested = this.stopRequested
    context.launchCommitting = this.launchCommitting
    context.provisionalSession = this.provisionalSession
    context.provisionalCommit = this.provisionalCommit
    context.provisionalSettled = this.provisionalSettled
    context.pendingSessionName = this.pendingSessionName
    context.sessionNameOperation = this.sessionNameOperation
    this.sessionPointersByProject.set(context.projectPath, this.sessionPointers)
    this.sessionActivityByProject.set(context.projectPath, this.sessionActivityAtByKey)
  }

  private loadContext(context: RuntimeContext): void {
    const shared = this.state
    this.activeContext = context
    this.runtime = context.runtime
    this.unsubscribeRuntime = context.unsubscribeRuntime
    this.stopRequested = context.stopRequested
    this.launchCommitting = context.launchCommitting
    this.provisionalSession = context.provisionalSession
    this.provisionalCommit = context.provisionalCommit
    this.provisionalSettled = context.provisionalSettled
    this.pendingSessionName = context.pendingSessionName
    this.sessionNameOperation = context.sessionNameOperation
    this.sessionPointers = this.sessionPointersByProject.get(context.projectPath) ?? []
    this.sessionActivityAtByKey = this.sessionActivityByProject.get(context.projectPath) ?? new Map()
    this.state = {
      ...context.state,
      projects: shared.projects,
      activeProjectKey: context.projectPath,
      sessions: [],
      sessionNaming: shared.sessionNaming,
      appearance: shared.appearance,
      general: shared.general,
      extensions: shared.extensions
    }
    this.state = { ...this.state, sessions: this.toSessionSummaries() }
  }

  private handleContextEvent(context: RuntimeContext, event: RuntimeHostEvent): void {
    if (!this.contexts.has(context)) return
    if (this.activeContext === context) {
      this.handleRuntimeEvent(event)
      return
    }
    const active = this.activeContext
    const inactiveState = active === null ? copyState(this.state) : null
    this.captureActiveContext()
    this.loadContext(context)
    this.suppressEvents = true
    try {
      this.handleRuntimeEvent(event)
      this.captureActiveContext()
    } finally {
      this.suppressEvents = false
      if (active !== null) this.loadContext(active)
      else {
        this.activeContext = null
        this.runtime = null
        this.unsubscribeRuntime = null
        this.stopRequested = false
        this.launchCommitting = false
        this.provisionalSession = null
        this.provisionalCommit = null
        this.provisionalSettled = false
        this.pendingSessionName = null
        this.sessionNameOperation = null
        if (inactiveState !== null) this.state = inactiveState
      }
    }
    if (this.state.activeProjectKey === context.projectPath) {
      this.sessionPointers = this.sessionPointersByProject.get(context.projectPath) ?? []
      this.sessionActivityAtByKey = this.sessionActivityByProject.get(context.projectPath) ?? new Map()
      this.state = { ...this.state, sessions: this.toSessionSummaries() }
    }
    this.emitState()
  }

  private transition(status: RuntimeStatus, lastError?: string): void {
    if (status === 'crashed') this.cancelSessionNameGeneration(this.runtime ?? undefined)
    this.state = {
      ...this.state,
      runtime: toKernelRuntime(status, this.runtime?.getState() ?? INITIAL_HOST_STATE, lastError)
    }
    this.emitState()
  }

  private emitState(): void {
    this.captureActiveContext()
    if (this.suppressEvents) return
    const event: KernelEvent = { type: 'kernel.state-changed', state: this.getState() }
    for (const listener of this.listeners) listener(event)
  }

  private emitPatch(patch: KernelStatePatch): void {
    this.captureActiveContext()
    if (this.suppressEvents) return
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
  sessionRegistry: ProjectSessionRegistry,
  sessionActivityAtByKey: ReadonlyMap<string, number | null>,
  sessionNaming: SessionNamingSettings,
  appearance: AppearanceSettings,
  general: GeneralSettings,
  extensions: readonly KernelExtensionDescriptor[]
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
    sessions: toKernelSessionSummaries(matchingRegistry.sessions, sessionActivityAtByKey),
    activeSessionKey: matchingRegistry.activeSessionKey,
    commands: createCommandCatalog(),
    extensions: extensions.map((extension) => ({ ...extension })),
    availableModels: [],
    sessionNaming: copySessionNamingSettings(sessionNaming),
    appearance: copyAppearanceSettings(appearance),
    general: copyGeneralSettings(general),
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

function toKernelSession(
  state: PiRpcSessionState,
  resumeAvailable: boolean,
  usageFallback: KernelSessionUsage | null = null
): KernelSessionState {
  return {
    id: stringValue(state.sessionId),
    name: stringValue(state.sessionName),
    resumeAvailable,
    model: toKernelModel(state.model),
    usage: toKernelSessionUsage(state) ?? usageFallback,
    thinkingLevel: thinkingLevel(state.thinkingLevel),
    messageCount: integerValue(state.messageCount),
    pendingMessageCount: integerValue(state.pendingMessageCount),
    pendingSteeringMessages: [],
    pendingFollowUpMessages: [],
    settled: state.isStreaming !== true
  }
}

function toKernelSessionUsage(state: PiRpcSessionState): KernelSessionUsage | null {
  const stats = state.sessionStats
  if (stats === undefined) return null
  return {
    inputTokens: stats.tokens.input,
    outputTokens: stats.tokens.output,
    cacheReadTokens: stats.tokens.cacheRead,
    cacheWriteTokens: stats.tokens.cacheWrite,
    totalTokens: stats.tokens.total,
    contextTokens: stats.contextUsage?.tokens ?? null,
    contextWindow: stats.contextUsage?.contextWindow ?? (
      typeof state.model?.contextWindow === 'number' ? state.model.contextWindow : null
    ),
    contextPercent: stats.contextUsage?.percent ?? null
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

function toKernelSessionSummaries(
  pointers: SessionPointer[],
  sessionActivityAtByKey: ReadonlyMap<string, number | null>,
  runtimeStatus: (sessionKey: string) => RuntimeStatus = () => 'stopped'
): KernelSessionSummary[] {
  return pointers.map((pointer) => ({
    key: pointer.sessionFile,
    id: pointer.sessionId,
    name: pointer.sessionName,
    lastActivityAt: sessionActivityAtByKey.get(pointer.sessionFile) ?? null,
    runtimeStatus: runtimeStatus(pointer.sessionFile)
  }))
}

function assertStrictPermutation(current: string[], next: string[], label: string): void {
  if (
    current.length !== next.length ||
    new Set(next).size !== next.length ||
    next.some((key) => !current.includes(key))
  ) {
    throw new Error(`Invalid ${label} order.`)
  }
}

function sameSessionPointers(current: SessionPointer[], snapshot: SessionPointer[]): boolean {
  return current.length === snapshot.length && current.every((pointer, index) => {
    const other = snapshot[index]
    return other !== undefined &&
      pointer.projectPath === other.projectPath &&
      pointer.sessionFile === other.sessionFile &&
      pointer.sessionId === other.sessionId &&
      pointer.sessionName === other.sessionName
  })
}

function sameExtensions(
  current: readonly KernelExtensionDescriptor[],
  next: readonly KernelExtensionDescriptor[]
): boolean {
  return current.length === next.length && current.every((extension, index) => {
    const other = next[index]
    return other !== undefined &&
      extension.path === other.path &&
      extension.name === other.name
  })
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
    thinkingLevelMap: { ...(value.thinkingLevelMap ?? {}) },
    contextWindow: typeof value.contextWindow === 'number' ? value.contextWindow : null
  }
}

function toAvailableKernelModel(value: unknown): KernelModelState {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('id' in value) ||
    typeof value.id !== 'string' ||
    value.id.trim().length === 0 ||
    !('provider' in value) ||
    typeof value.provider !== 'string' ||
    value.provider.trim().length === 0
  ) {
    throw new Error('Runtime returned an invalid model catalog.')
  }
  return {
    id: value.id,
    provider: value.provider,
    name: 'name' in value && typeof value.name === 'string' ? value.name : value.id,
    reasoning: 'reasoning' in value && value.reasoning === true,
    thinkingLevelMap: {
      ...('thinkingLevelMap' in value && typeof value.thinkingLevelMap === 'object'
        ? value.thinkingLevelMap
        : {})
    },
    contextWindow: 'contextWindow' in value && typeof value.contextWindow === 'number'
      ? value.contextWindow
      : null
  }
}

function copyState(state: KernelState): KernelState {
  return {
    projects: state.projects.map((project) => ({ ...project })),
    activeProjectKey: state.activeProjectKey,
    sessions: state.sessions.map((session) => ({ ...session })),
    activeSessionKey: state.activeSessionKey,
    commands: state.commands.map((command) => ({ ...command })),
    extensions: state.extensions.map((extension) => ({ ...extension })),
    availableModels: state.availableModels.map((model) => ({
      ...model,
      thinkingLevelMap: { ...model.thinkingLevelMap }
    })),
    sessionNaming: copySessionNamingSettings(state.sessionNaming),
    appearance: copyAppearanceSettings(state.appearance),
    general: copyGeneralSettings(state.general),
    runtime: { ...state.runtime },
    session: {
      ...state.session,
      pendingSteeringMessages: [...state.session.pendingSteeringMessages],
      pendingFollowUpMessages: [...state.session.pendingFollowUpMessages],
      usage: state.session.usage === null ? null : { ...state.session.usage },
      model: state.session.model === null
        ? null
        : { ...state.session.model, thinkingLevelMap: { ...state.session.model.thinkingLevelMap } }
    },
    conversation: {
      entries: state.conversation.entries.map(copyConversationEntry),
      activeRunStartIndex: state.conversation.activeRunStartIndex
    }
  }
}

function createStatePatch(previous: KernelState, next: KernelState): KernelStatePatch | null {
  if (
    next.sessions !== previous.sessions ||
    next.activeSessionKey !== previous.activeSessionKey ||
    next.sessionNaming !== previous.sessionNaming ||
    next.appearance !== previous.appearance ||
    next.general !== previous.general
  ) {
    return null
  }
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
            pendingSteeringMessages: [...patch.session.pendingSteeringMessages],
            pendingFollowUpMessages: [...patch.session.pendingFollowUpMessages],
            usage: patch.session.usage === null ? null : { ...patch.session.usage },
            model: patch.session.model === null
              ? null
              : {
                  ...patch.session.model,
                  thinkingLevelMap: { ...patch.session.model.thinkingLevelMap }
                }
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
                      ? { ...entryPatch, entry: copyConversationEntry(entryPatch.entry) }
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
      !sameMessageAttachments(previous.attachments, next.attachments) ||
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

function copyConversationEntry(entry: KernelConversationEntry): KernelConversationEntry {
  if (entry.kind !== 'message' || entry.attachments === undefined) return { ...entry }
  return {
    ...entry,
    attachments: entry.attachments.map((attachment) => attachment.type === 'image'
      ? { ...attachment, hints: [...attachment.hints] }
      : { ...attachment })
  }
}

function sameMessageAttachments(
  first: KernelMessageAttachment[] | undefined,
  second: KernelMessageAttachment[] | undefined
): boolean {
  if (first === second) return true
  if (first === undefined || second === undefined || first.length !== second.length) return false
  return first.every((attachment, index) => {
    const other = second[index]
    if (
      other === undefined ||
      attachment.type !== other.type ||
      attachment.name !== other.name ||
      attachment.path !== other.path
    ) return false
    return attachment.type === 'file' ||
      (
        other.type === 'image' &&
        attachment.hints.length === other.hints.length &&
        attachment.hints.every((hint, hintIndex) => hint === other.hints[hintIndex])
      )
  })
}

function hasAssistantUsage(event: PiRpcEvent): boolean {
  if (
    event.type !== 'message_end' ||
    typeof event.message !== 'object' ||
    event.message === null ||
    !('role' in event.message) ||
    event.message.role !== 'assistant' ||
    !('usage' in event.message)
  ) return false
  return typeof event.message.usage === 'object' && event.message.usage !== null
}

function sameSessionUsage(
  first: KernelSessionUsage | null,
  second: KernelSessionUsage | null
): boolean {
  if (first === second) return true
  if (first === null || second === null) return false
  return first.inputTokens === second.inputTokens &&
    first.outputTokens === second.outputTokens &&
    first.cacheReadTokens === second.cacheReadTokens &&
    first.cacheWriteTokens === second.cacheWriteTokens &&
    first.totalTokens === second.totalTokens &&
    first.contextTokens === second.contextTokens &&
    first.contextWindow === second.contextWindow &&
    first.contextPercent === second.contextPercent
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

function selectSessionNameModel(
  settings: SessionNamingSettings,
  availableModels: KernelModelState[],
  activeProvider: string | null
): KernelModelState | null {
  if (settings.mode === 'off') return null
  if (settings.mode === 'model') {
    return availableModels.find((model) =>
      model.provider === settings.provider && model.id === settings.modelId
    ) ?? null
  }
  if (activeProvider === null) return null
  for (const modelId of AUTOMATIC_SESSION_NAME_MODEL_IDS) {
    const model = availableModels.find((candidate) =>
      candidate.provider === activeProvider && candidate.id === modelId
    )
    if (model !== undefined) return model
  }
  return null
}

function copySessionNamingSettings(settings: SessionNamingSettings): SessionNamingSettings {
  return settings.mode === 'model'
    ? { mode: 'model', provider: settings.provider, modelId: settings.modelId }
    : { mode: settings.mode }
}

function sameSessionNamingSettings(
  first: SessionNamingSettings,
  second: SessionNamingSettings
): boolean {
  if (first.mode !== second.mode) return false
  if (first.mode !== 'model' || second.mode !== 'model') return true
  return first.provider === second.provider && first.modelId === second.modelId
}

function copyAppearanceSettings(settings: AppearanceSettings): AppearanceSettings {
  return {
    theme: settings.theme,
    accentColor: settings.accentColor,
    surfaceTransparency: settings.surfaceTransparency,
    textSize: settings.textSize,
    uiFontFamily: settings.uiFontFamily,
    codeFontFamily: settings.codeFontFamily
  }
}

function sameAppearanceSettings(first: AppearanceSettings, second: AppearanceSettings): boolean {
  return first.theme === second.theme &&
    first.accentColor === second.accentColor &&
    first.surfaceTransparency === second.surfaceTransparency &&
    first.textSize === second.textSize &&
    first.uiFontFamily === second.uiFontFamily &&
    first.codeFontFamily === second.codeFontFamily
}

function copyGeneralSettings(settings: GeneralSettings): GeneralSettings {
  return { startupWorkspaceRestore: settings.startupWorkspaceRestore }
}

function sameGeneralSettings(first: GeneralSettings, second: GeneralSettings): boolean {
  return first.startupWorkspaceRestore === second.startupWorkspaceRestore
}

function assertGeneralSettings(value: GeneralSettings): void {
  if (value.startupWorkspaceRestore !== 'restore' && value.startupWorkspaceRestore !== 'none') {
    throw new Error('Invalid general settings.')
  }
}

function assertAppearanceSettings(value: AppearanceSettings): void {
  if (
    !isAppearanceTheme(value.theme) ||
    !isAppearanceAccentColor(value.accentColor) ||
    !isSurfaceTransparency(value.surfaceTransparency) ||
    !isTextSize(value.textSize) ||
    !isOptionalFontFamily(value.uiFontFamily) ||
    !isOptionalFontFamily(value.codeFontFamily)
  ) {
    throw new Error('Invalid appearance settings.')
  }
}

function isAppearanceTheme(value: unknown): value is AppearanceSettings['theme'] {
  return value === 'system' || value === 'dark' || value === 'light'
}

function isAppearanceAccentColor(value: unknown): value is AppearanceSettings['accentColor'] {
  return value === 'amber' ||
    value === 'blue' ||
    value === 'green' ||
    value === 'purple' ||
    value === 'rose'
}

function isSurfaceTransparency(value: unknown): value is AppearanceSettings['surfaceTransparency'] {
  return value === 0 || value === 10 || value === 20 || value === 30 || value === 40
}

function isTextSize(value: unknown): value is AppearanceSettings['textSize'] {
  return value === 'small' || value === 'default' || value === 'large'
}

function isOptionalFontFamily(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.trim().length > 0)
}

function assertSessionNamingSettings(value: SessionNamingSettings): void {
  if (value.mode === 'auto' || value.mode === 'off') return
  if (
    value.mode !== 'model' ||
    value.provider.trim().length === 0 ||
    value.modelId.trim().length === 0
  ) {
    throw new Error('Invalid session naming settings.')
  }
}

function normalizeGeneratedSessionName(value: string): string | null {
  const firstLine = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (firstLine === undefined) return null
  const withoutPrefix = firstLine.replace(/^(?:conversation title|session title|title|会话标题|对话标题|标题)\s*[:：]\s*/i, '')
  const withoutQuotes = withoutPrefix.replace(/^["'“‘《]+|["'”’》]+$/g, '')
  const normalized = withoutQuotes.replace(/\s+/g, ' ').trim()
  if (normalized.length === 0) return null
  const characters = Array.from(normalized)
  return characters.length <= 48
    ? normalized
    : `${characters.slice(0, 47).join('')}…`
}

function firstUserMessage(entries: KernelConversationEntry[]): string | null {
  const entry = entries.find((candidate) =>
    candidate.kind === 'message' &&
    candidate.role === 'user' &&
    candidate.text.trim().length > 0
  )
  return entry?.kind === 'message' ? entry.text : null
}

function lastAssistantMessage(entries: KernelConversationEntry[]): string | null {
  const entry = [...entries].reverse().find((candidate) =>
    candidate.kind === 'message' &&
    candidate.role === 'assistant' &&
    candidate.text.trim().length > 0
  )
  return entry?.kind === 'message' ? entry.text : null
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

function assertNoCommandArgument(command: KernelCommandDescriptor, argument: string): void {
  if (argument.trim().length > 0) throw new Error(`/${command.name} does not accept arguments.`)
}

function parseModelArgument(argument: string): { provider: string, modelId: string } {
  const normalized = argument.trim()
  const separator = normalized.indexOf('/')
  if (separator <= 0 || separator === normalized.length - 1) {
    throw new Error('Model must use the provider/model format.')
  }
  return {
    provider: normalized.slice(0, separator).trim(),
    modelId: normalized.slice(separator + 1).trim()
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function integerValue(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function formatExitError(code: number | null, signal: string | null): string {
  return code !== null
    ? `Pi RPC process exited with code ${code}.`
    : `Pi RPC process exited from signal ${signal ?? 'unknown'}.`
}

function contextKey(projectPath: string, sessionKey: string): string {
  return `${projectPath}\u0000${sessionKey}`
}
