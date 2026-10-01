import type { AgentCollaborationOperation, AgentCollaborationResult } from '../../shared/agent-collaboration-contract.ts'
import { SessionCollaborationRuntime } from './session-collaboration-runtime.ts'
import type {
  AppearanceSettings,
  GeneralSettings,
  KernelArchiveReceipt,
  KernelAssistantFinalAnswer,
  KernelAskAnswer,
  KernelCommandDescriptor,
  KernelCommandEntry,
  KernelConversationPage,
  KernelConversationPageRequest,
  KernelConversationState,
  KernelExtensionStatusEntry,
  KernelEvent,
  KernelExtensionDescriptor,
  KernelForkCandidate,
  KernelMessageImage,
  KernelMutationAck,
  KernelSnapshot,
  KernelSubagentTranscript,
  KernelProjectState,
  KernelPromptAttachment,
  KernelProjectTrustChoice,
  KernelRuntimeMemoryDiagnostics,
  KernelSharedRuntimeHostMemorySample,
  KernelRuntimeMemorySample,
  KernelRuntimeMemoryUnavailableReason,
  KernelSessionSummary,
  KernelSessionPreview,
  KernelSessionPreviewPageRequest,
  KernelSessionStatistics,
  KernelToolEntry,
  KernelState,
  KernelStatePatch,
  RuntimeStatus,
  SessionNamingSettings,
  ShortcutSettings,
  SubagentSettings,
  ThinkingLevel
} from '../../shared/kernel-contract.ts'
import {
  COPY_LAST_ANSWER_COMMAND_ID,
  DEFAULT_APPEARANCE_SETTINGS,
  DEFAULT_GENERAL_SETTINGS,
  DEFAULT_SESSION_NAMING_SETTINGS,
  DEFAULT_SUBAGENT_SETTINGS,
  EXPORT_SESSION_COMMAND_ID,
  FORK_SESSION_COMMAND_ID
} from '../../shared/kernel-contract.ts'
import {
  copySessionNamingSettings,
  copyAppearanceSettings,
  copyGeneralSettings,
  copySubagentSettings,
  isAppearanceSettings,
  isSubagentSettings,
  isSessionNamingSettings,
  isGeneralSettingsUpdate
} from '../../shared/workbench-settings.ts'
import {
  KERNEL_CONVERSATION_PAGE_TURN_COUNT,
  conversationTurnWindowStartIndex
} from '../../shared/conversation-window.ts'
import {
  copyShortcutSettings,
  DEFAULT_SHORTCUT_SETTINGS,
  isShortcutSettings
} from '../../shared/shortcut-settings.ts'
import type {
  PiRpcEvent
} from '../pi-rpc/pi-rpc-data.ts'
import {
  extractProjectedMessageImage,
  findUserMessageForImageLookup,
  materializePrompt
} from '../prompt/prompt-attachments.ts'
import {
  isAbsolute
} from 'node:path'
import {
  randomUUID
} from 'node:crypto'
import type {
  RestartContinuationCandidate
} from '../project/restart-continuation.ts'
import {
  SessionTranscriptPreparationCache
} from '../project/session-transcript-preparation-cache.ts'
import type {
  ReadSessionMessagesTailFirstOptions,
  SessionTranscriptMessagePhase
} from '../project/session-transcript-tail.ts'
import {
  upsertSessionPointer,
  type ProjectSessionRegistry,
  type SessionPointer
} from '../project/session-pointer.ts'
import type {
  RuntimeHost,
  RuntimeHostEvent
} from '../runtime/runtime-host.ts'
import {
  OPENAI_FAST_MODE_COMMAND_NAME,
  buildOpenAiFastModeCommandArgs,
  openAiFastModeFromSessionEntries
} from '../runtime/openai-fast-mode.ts'
import {
  readLinuxProcessMemoryBytes,
  type LinuxProcessMemoryReadResult
} from '../runtime/linux-process-memory.ts'
import type {
  SessionNameGenerator
} from '../runtime/session-name-generator.ts'
import {
  errorMessage
} from '../utils/errors.ts'
import {
  assertAdaptedExtensionCommandArgument,
  COMPACT_COMMAND_ID,
  createCommandCatalog,
  NEW_SESSION_COMMAND_ID,
  RELOAD_SESSION_COMMAND_ID,
  SET_MODEL_COMMAND_ID,
  SET_SESSION_NAME_COMMAND_ID,
  SET_THINKING_COMMAND_ID
} from './command-catalog.ts'
import {
  projectMessages,
  projectSessionEntries,
  projectTranscriptMessages
} from './conversation-projection.ts'
import { ContextCompaction } from './context-compaction.ts'
import { ContextInteractions } from './context-interactions.ts'
import { RuntimeHibernation } from './runtime-hibernation.ts'
import { SessionNaming } from './session-naming.ts'
import { SessionPreviews } from './session-previews.ts'
import { ToolImageCache } from './tool-image-cache.ts'
import {
  collectValidatedToolImages,
  extractToolResultImage,
  findToolResultMessage,
  ToolResultMessageNotFoundError
} from './tool-result-images.ts'
import {
  copyConversationEntry,
  copyState,
  createStatePatch,
  copyPatch
} from './kernel-state-encoding.ts'
import {
  runtimeSessionState,
  projectRuntimeSessionState,
  reduceRuntimeSessionEvent,
  toKernelRuntime,
  beginConversationRun,
  settleConversationRun,
  isAssistantMessageEnd,
  hasAssistantUsage,
  type RuntimeSessionState
} from './runtime-session-state.ts'
import {
  projectAdvisorState,
  UNAVAILABLE_ADVISOR_STATE
} from './advisor-projection.ts'
import {
  mergeConversationEntries,
  toAvailableKernelModel,
  toKernelSession,
  toKernelSessionStatistics,
  toKernelSessionUsage
} from './session-projection.ts'
import {
  forkCandidatesOnActivePath,
  resolveVisiblePromptCandidate,
  sessionEntriesOnActivePath
} from './session-branch.ts'
import {
  INITIAL_HOST_STATE,
  INITIAL_SESSION_STATE,
  ARCHIVE_UNDO_DURATION_MS,
  RESTART_CONTINUATION_PROMPT,
  type RuntimeFactory,
  type ProjectTrustController,
  type SessionMetadata,
  type WorkbenchKernelOptions,
  type SessionPreviewRegistrySource,
  type ConversationIdentity,
  type RuntimeContext,
  type ProjectNavigationState,
  type ArchiveUndoRecord,
  type ForkTarget,
  type RestartRecoverySelection
} from './workbench-kernel-types.ts'
import {
  metadataCacheForPointers,
  mergeRefreshedMetadata,
  configuredProject,
  isSessionExportRuntimeStatusAllowed,
  initialKernelState,
  assertSessionStatisticsIdentity,
  matchingSessionRegistry,
  toKernelSessionSummaries,
  mergeProvisionalSessionSummaries,
  assertStrictPermutation,
  sameSessionPointers,
  sameProjectNavigationState,
  sameSessionStatistics,
  sameExtensions,
  activeProject,
  workspaceKind,
  assertProjectRegistry,
  sameSessionUsage,
  sameSessionNamingSettings,
  sameAppearanceSettings,
  sameGeneralSettings,
  sameSubagentSettings,
  sameShortcutSettings,
  firstUserMessage,
  lastAssistantFinalAnswer,
  thinkingLevel,
  assertNoCommandArgument,
  parseModelArgument,
  stringValue,
  isEnoent,
  formatExitError,
  contextKey,
  hasProjectedToolImage,
  isSubagentToolName
} from './workbench-kernel-helpers.ts'

export { AUTO_HIBERNATE_GRACE_MS, AUTO_HIBERNATE_SWEEP_INTERVAL_MS } from './workbench-kernel-types.ts'
export type { RuntimeFactory, ProjectTrustController, WorkbenchKernelOptions } from './workbench-kernel-types.ts'

export class WorkbenchKernel {
  private readonly createRuntime: RuntimeFactory
  private readonly collaboration = new SessionCollaborationRuntime({
    state: () => this.state,
    activeContext: () => this.activeContext,
    contexts: () => this.contexts,
    sessions: () => this.sessionPointersByProject,
    contextForSession: (projectPath, sessionFile) => this.contextBySessionKey.get(contextKey(projectPath, sessionFile)),
    admissionOpen: () => !this.shutdownRequested && !this.stopAllRequested,
    assertLaunchActive: () => this.assertLaunchActive(),
    assertRegisteredProject: (path) => this.assertRegisteredProject(path),
    createRuntime: (project, options) => this.createRuntime(project, options),
    inspectProjectTrust: (path) => this.projectTrust.inspect(path),
    validateSession: (pointer) => {
      if (this.validateSession === undefined) throw new Error('Session validation is unavailable.')
      return this.validateSession(pointer)
    },
    persistSession: (pointer) => this.persistSession(pointer),
    registerPointer: (pointer) => {
      const pointers = upsertSessionPointer(this.sessionPointersByProject.get(pointer.projectPath) ?? [], pointer)
      this.sessionPointersByProject.set(pointer.projectPath, pointers)
      if (this.state.activeProjectKey === pointer.projectPath) this.sessionPointers = pointers
    },
    registerContext: (context) => {
      this.contexts.add(context)
      this.contextByRuntime.set(context.runtime, context)
      if (context.state.activeSessionKey !== null) this.contextBySessionKey.set(contextKey(context.projectPath, context.state.activeSessionKey), context)
      context.unsubscribeRuntime = context.runtime.subscribe((event) => this.handleContextEvent(context, event))
    },
    registerIdentity: (context, key) => this.contextBySessionKey.set(contextKey(context.projectPath, key), context),
    retireContext: (context, wasActive, navigationBefore) => this.retireContext(context, wasActive, navigationBefore),
    allocateIdentity: () => ({ runtimeId: this.allocateRuntimeId(), runtimeGeneration: this.allocateRuntimeGeneration() }),
    touchWarmUse: (context) => this.touchWarmUse(context),
    cancelCompaction: (context) => this.compaction.cancel(context),
    clearToolImages: (key) => this.toolImages.clearForSession(key),
    projectNavigationState: (path) => this.projectNavigationState(path),
    publishContextState: (context, navigationBefore, publication) => this.publishContextState(context, navigationBefore, publication),
    acknowledge: () => this.acknowledge(),
    now: () => this.now()
  })
  private readonly listeners = new Set<(event: KernelEvent) => void>()
  private sessionActivityAtByKey = new Map<string, number | null>()
  private sessionStatisticsByKey = new Map<string, KernelSessionStatistics | null>()
  private readonly contexts = new Set<RuntimeContext>()
  private readonly contextByRuntime = new Map<RuntimeHost, RuntimeContext>()
  private readonly contextBySessionKey = new Map<string, RuntimeContext>()
  /** Monotonic counter for opaque RuntimeContext.runtimeId values (process lifetime). */
  private nextRuntimeId = 1
  /** Monotonic counter for RuntimeContext.runtimeGeneration values (process lifetime). */
  private nextRuntimeGeneration = 1
  /** Non-overlapping automatic hibernation sweep gate. */
  private readonly hibernation = new RuntimeHibernation({
    now: () => this.now(),
    managedContexts: () => this.contexts,
    isManaged: (context) => this.contexts.has(context),
    isForeground: (context) => this.activeContext === context,
    foregroundSessionKey: () => this.state.activeSessionKey,
    hasPersistedPointer: (projectPath, sessionKey) =>
      (this.sessionPointersByProject.get(projectPath) ?? []).some((pointer) => pointer.sessionFile === sessionKey),
    withLaunchGate: (operation) => this.beginLaunch(operation),
    stopContext: (context) => this.stopContext(context, true),
    hasPendingCollaboration: (context) => context.state.session.id !== null && this.collaboration.hasPending(context.state.session.id)
  })
  private readonly sessionPointersByProject = new Map<string, SessionPointer[]>()
  private readonly sessionActivityByProject = new Map<string, Map<string, number | null>>()
  private readonly sessionStatisticsByProject =
    new Map<string, Map<string, KernelSessionStatistics | null>>()
  private readonly workspaceMetadataRefreshGeneration = new Map<string, number>()
  private readonly archiveUndoByToken = new Map<string, ArchiveUndoRecord>()
  private readonly sessionReloadRequired = new Set<string>()
  private readonly restartContinuations = new Map<string, RestartContinuationCandidate>()
  /**
   * Bounded Main-only cache for tool result images that completed but may not yet
   * be readable from the Pi transcript. Never enters KernelState / patches / logs.
   */
  private readonly toolImages = new ToolImageCache(() => this.now())
  private activeContext: RuntimeContext | null = null
  /** The selected runtime is derived; its lifecycle belongs to RuntimeContext. */
  private get runtime(): RuntimeHost | null {
    return this.activeContext?.runtime ?? null
  }
  private sessionPointers: SessionPointer[]
  private state: KernelState
  /** Monotonic revision bumped on every published state-changed/state-patched event. */
  private stateRevision = 0
  /** Kernel-wide admission gate while stop() cancels launches and drains all contexts. */
  private stopAllRequested = false
  private shutdownRequested = false
  private launchOperation: Promise<void> | null = null
  private projectChangeOperation: Promise<void> | null = null
  private pendingProjectTrust: {
    id: string
    projectPath: string
    resolve: (projectTrust: boolean | undefined) => void
    reject: (error: Error) => void
    persistenceInFlight: boolean
  } | null = null
  private readonly naming = new SessionNaming({
    isManaged: (context) => this.contexts.has(context),
    managedContexts: () => this.contexts,
    generator: () => this.generateSessionName,
    sessionNamingSettings: () => this.state.sessionNaming,
    pointersForProject: (projectPath) => this.sessionPointersByProject.get(projectPath) ?? (
      this.state.activeProjectKey === projectPath ? this.sessionPointers : []
    ),
    persistSession: (pointer) => this.persistSession(pointer),
    storeRenamedPointer: (projectPath, renamed, fallback) => {
      const pointers = upsertSessionPointer(this.sessionPointersByProject.get(projectPath) ?? fallback, renamed)
      this.sessionPointersByProject.set(projectPath, pointers)
      if (this.state.activeProjectKey === projectPath) this.sessionPointers = pointers
    },
    projectNavigationState: (projectPath) => this.projectNavigationState(projectPath),
    publishContextState: (context, navigationBefore, publication) =>
      this.publishContextState(context, navigationBefore, publication)
  })
  private readonly interactions = new ContextInteractions({
    activeContext: () => this.activeContext,
    activeRuntime: () => this.runtime,
    activeProjectKey: () => this.state.activeProjectKey,
    activeSessionKey: () => this.state.activeSessionKey,
    activeSessionId: () => this.state.session.id,
    projectNavigationState: (projectPath) => this.projectNavigationState(projectPath),
    publishContextState: (context, navigationBefore, publication) =>
      this.publishContextState(context, navigationBefore, publication)
  })
  private readonly compaction = new ContextCompaction({
    isManaged: (context) => this.contexts.has(context),
    projectNavigationState: (projectPath) => this.projectNavigationState(projectPath),
    publishContextState: (context, navigationBefore, publication) =>
      this.publishContextState(context, navigationBefore, publication),
    emitKernelEvent: (event) => this.emitKernelEvent(event),
    recordSessionStatistics: (projectPath, sessionKey, statistics) => {
      const statisticsByKey = new Map(this.sessionStatisticsByProject.get(projectPath) ?? [])
      statisticsByKey.set(sessionKey, statistics)
      this.sessionStatisticsByProject.set(projectPath, statisticsByKey)
      if (this.state.activeProjectKey === projectPath) this.sessionStatisticsByKey = statisticsByKey
    }
  })
  private readonly previews = new SessionPreviews({
    now: () => this.now(),
    activeProjectKey: () => this.state.activeProjectKey,
    configuredProjectPath: () => configuredProject(this.state).path,
    currentRegistry: () => async () => ({
      sessions: this.sessionPointers,
      activeSessionKey: this.state.activeSessionKey
    }),
    findPointer: (projectPath, sessionKey, registry) =>
      this.sessionPointers.find((pointer) => pointer.projectPath === projectPath && pointer.sessionFile === sessionKey) ??
        this.findSessionPointerInRegistry(projectPath, sessionKey, registry),
    sessionValidator: () => this.validateSession,
    transcriptPreparations: () => this.sessionTranscriptPreparations
  })
  private readonly sessionTranscriptPreparations: SessionTranscriptPreparationCache | null

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
      this.sessionStatisticsByProject.set(initialProject.path, this.sessionStatisticsByKey)
    }
    if (options.sessionRegistriesByProject !== undefined) {
      for (const [path, registry] of options.sessionRegistriesByProject) {
        if (this.sessionPointersByProject.has(path)) continue
        const matchingRegistry = matchingSessionRegistry({ path }, registry)
        this.sessionPointersByProject.set(path, matchingRegistry.sessions)
      }
    }
    this.persistProject = options.persistProject
    this.persistActiveProject = options.persistActiveProject
    this.persistActiveTask = options.persistActiveTask ?? (async () => {})
    this.persistNavigatorKind = options.persistNavigatorKind ?? (async () => {})
    this.persistSession = options.persistSession
    this.persistActiveSession = options.persistActiveSession
    this.persistArchivedSession = options.persistArchivedSession
    this.restoreArchivedSession = options.restoreArchivedSession ?? (async () => {
      throw new Error('Archived session restore is unavailable.')
    })
    this.validateSession = options.validateSession
    this.readSessionActivityAt = options.readSessionActivityAt ?? (async () => null)
    this.readSessionStatistics = options.readSessionStatistics ?? (async () => null)
    this.readSessionMetadata = options.readSessionMetadata
    this.readSessionMessages = options.readSessionMessages
    this.readSessionMessagesTailFirst = options.readSessionMessagesTailFirst
    this.sessionTranscriptPreparations =
      options.readSessionMessagesTailFirst === undefined ||
      options.readSessionTranscriptGeneration === undefined
        ? null
        : new SessionTranscriptPreparationCache(
            options.readSessionMessagesTailFirst,
            options.readSessionTranscriptGeneration,
            5
          )
    this.persistProjectOrder = options.persistProjectOrder ?? (async () => {})
    this.persistSessionNaming = options.persistSessionNaming ?? (async () => {})
    this.persistAppearance = options.persistAppearance ?? (async () => {})
    this.persistGeneral = options.persistGeneral ?? (async () => {})
    this.claimRestartContinuation = options.claimRestartContinuation ?? (async () => {})
    this.completeRestartContinuation = options.completeRestartContinuation ?? (async () => {})
    for (const candidate of options.restartContinuations ?? []) {
      this.restartContinuations.set(candidate.id, { ...candidate })
    }
    this.persistSubagent = options.persistSubagent ?? (async () => {})
    this.persistShortcuts = options.persistShortcuts ?? (async () => {})
    this.generateSessionName = options.generateSessionName
    this.projectTrust = options.projectTrust ?? {
      inspect: async () => ({ requiresDecision: false, decision: null }),
      persist: async () => {}
    }
    this.now = options.now ?? Date.now
    this.readProcessMemory = options.readProcessMemory ?? readLinuxProcessMemoryBytes
    this.readSharedRuntimeHostPid = options.readSharedRuntimeHostPid
    this.state = {
      ...initialKernelState(
        projectRegistry,
        sessionRegistry,
        this.sessionActivityAtByKey,
        this.sessionStatisticsByKey,
        options.sessionNaming ?? DEFAULT_SESSION_NAMING_SETTINGS,
        options.appearance ?? DEFAULT_APPEARANCE_SETTINGS,
        options.general ?? DEFAULT_GENERAL_SETTINGS,
        options.subagent ?? DEFAULT_SUBAGENT_SETTINGS,
        options.shortcuts ?? DEFAULT_SHORTCUT_SETTINGS,
        options.extensions ?? []
      ),
      navigatorKind: options.navigatorKind ?? workspaceKind(initialProject)
    }
  }

  private readonly persistProject: (project: KernelProjectState) => Promise<void>
  private readonly persistActiveProject: (projectKey: string) => Promise<void>
  private readonly persistActiveTask: (taskKey: string) => Promise<void>
  private readonly persistNavigatorKind: (kind: 'project' | 'task') => Promise<void>
  private readonly persistSession: (pointer: SessionPointer) => Promise<void>
  private readonly persistActiveSession: (
    projectPath: string,
    sessionKey: string,
    sessionId: string
  ) => Promise<void>
  private readonly persistArchivedSession: (projectPath: string, sessionKey: string) => Promise<void>
  private readonly restoreArchivedSession: (
    projectPath: string,
    sessionKey: string
  ) => Promise<ProjectSessionRegistry>
  private readonly validateSession: ((pointer: SessionPointer) => Promise<SessionPointer>) | undefined
  private readonly readSessionActivityAt: (pointer: SessionPointer) => Promise<number | null>
  private readonly readSessionStatistics:
    (pointer: SessionPointer) => Promise<KernelSessionStatistics | null>
  private readonly readSessionMetadata:
    ((pointer: SessionPointer) => Promise<SessionMetadata>) | undefined
  private readonly readSessionMessages: ((pointer: SessionPointer) => Promise<unknown[]>) | undefined
  private readonly readSessionMessagesTailFirst: ((
    pointer: SessionPointer,
    options: ReadSessionMessagesTailFirstOptions
  ) => Promise<SessionTranscriptMessagePhase>) | undefined
  private readonly persistProjectOrder: (projectKeys: string[]) => Promise<void>
  private readonly persistSessionNaming: (settings: SessionNamingSettings) => Promise<void>
  private readonly persistAppearance: (settings: AppearanceSettings) => Promise<void>
  private readonly persistGeneral: (settings: GeneralSettings) => Promise<void>
  private readonly claimRestartContinuation: (id: string) => Promise<void>
  private readonly completeRestartContinuation: (id: string) => Promise<void>
  private readonly persistSubagent: (settings: SubagentSettings) => Promise<void>
  private readonly persistShortcuts: (settings: ShortcutSettings) => Promise<void>
  private readonly generateSessionName: SessionNameGenerator | undefined
  private readonly projectTrust: ProjectTrustController
  private readonly now: () => number
  private readonly readProcessMemory: (pid: number) => Promise<LinuxProcessMemoryReadResult>
  private readonly readSharedRuntimeHostPid: (() => number | null) | undefined

  getAgentCollaboration(): AgentCollaborationResult {
    return this.collaboration.getAgentCollaboration()
  }

  async agentCollaboration(operation: AgentCollaborationOperation, expectedSessionKey: string): Promise<AgentCollaborationResult> {
    return this.collaboration.agentCollaboration(operation, expectedSessionKey)
  }

  async getSubagentTranscript(taskId: string, expectedSessionKey: string): Promise<KernelSubagentTranscript> {
    return this.collaboration.getSubagentTranscript(taskId, expectedSessionKey)
  }

  async controlSubagent(taskId: string, expectedSessionKey: string, action: 'stop' | 'continue', message?: string): Promise<KernelMutationAck> {
    return this.collaboration.controlSubagent(taskId, expectedSessionKey, action, message)
  }

  getActiveProjectPath(): string {
    return configuredProject(this.state).path
  }

  getState(): KernelState {
    return this.copyStateForConsumer(this.state.conversation)
  }

  /**
   * Atomic snapshot for Renderer initialization/resync. Pairs the deep-copied
   * KernelState with the current publish revision so clients never guess counters.
   */
  getSnapshot(): KernelSnapshot {
    return {
      revision: this.stateRevision,
      state: this.getPublishedState()
    }
  }

  loadEarlierConversation(request: KernelConversationPageRequest): KernelConversationPage {
    const identity = this.activeConversationIdentity()
    if (
      identity === null ||
      request.projectKey !== identity.projectKey ||
      request.sessionKey !== identity.sessionKey ||
      request.sessionId !== identity.sessionId
    ) {
      throw new Error('Conversation page request does not match the active Session identity.')
    }

    const entries = this.state.conversation.entries
    const boundaryEntry = entries[request.beforeIndex]
    if (
      request.beforeIndex <= 0 ||
      boundaryEntry === undefined ||
      request.beforeEntryId !== boundaryEntry.id
    ) {
      throw new Error('Conversation page request is stale or does not match its boundary identity.')
    }

    const startIndex = conversationTurnWindowStartIndex(
      entries,
      request.beforeIndex,
      KERNEL_CONVERSATION_PAGE_TURN_COUNT
    )
    const pageEntries = entries.slice(startIndex, request.beforeIndex)
    if (pageEntries.length === 0) throw new Error('Conversation earlier page is empty.')
    return {
      ...request,
      startIndex,
      entries: pageEntries.map(copyConversationEntry)
    }
  }

  getLastAssistantFinalAnswer(): KernelAssistantFinalAnswer {
    const identity = this.activeConversationIdentity()
    if (
      identity === null ||
      this.state.runtime.status !== 'ready' ||
      !this.state.session.settled
    ) {
      throw new Error('A settled active persisted Session is required.')
    }
    return {
      ...identity,
      text: lastAssistantFinalAnswer(this.state.conversation.entries)
    }
  }

  private getPublishedState(): KernelState {
    return this.copyStateForConsumer(this.publishedConversation(this.state))
  }

  private copyStateForConsumer(conversation: KernelConversationState): KernelState {
    const state = copyState(this.state, conversation)
    state.sessions = this.toSessionSummaries()
    state.projects = state.projects.map((project) => {
      const navigation = this.projectNavigationState(project.path)
      return {
        ...project,
        busySessionCount: navigation.busySessionCount,
        sessionCount: navigation.sessions.length,
        sessions: navigation.sessions
      }
    })
    return state
  }

  private activeConversationIdentity(): ConversationIdentity | null {
    const projectKey = this.state.activeProjectKey
    const sessionKey = this.state.activeSessionKey
    const sessionId = this.state.session.id
    return typeof projectKey === 'string' && typeof sessionKey === 'string' && typeof sessionId === 'string'
      ? { projectKey, sessionKey, sessionId }
      : null
  }

  private publishedConversation(state: KernelState): KernelConversationState {
    const entries = state.conversation.entries
    const activeRunStartIndex = state.conversation.activeRunStartIndex
    const settledEnd = activeRunStartIndex ?? entries.length
    if (!Number.isSafeInteger(settledEnd) || settledEnd < 0 || settledEnd > entries.length) {
      throw new Error('Kernel Conversation active run index is invalid.')
    }
    const defaultStartIndex = conversationTurnWindowStartIndex(
      entries,
      settledEnd,
      KERNEL_CONVERSATION_PAGE_TURN_COUNT
    )
    return {
      entries: entries.slice(defaultStartIndex),
      startIndex: defaultStartIndex,
      activeRunStartIndex
    }
  }

  /**
   * Narrow acknowledgement for mutating IPC. Carries the latest published revision
   * without deep-cloning KernelState for the invoke return path.
   */
  acknowledge(): KernelMutationAck {
    return { revision: this.stateRevision }
  }

  /**
   * Captures only exact, persisted RuntimeContexts observed running at the orderly
   * shutdown boundary. Startup never infers candidates from transcript shape or a
   * stale crashed projection.
   */
  prepareRestartContinuationShutdown(): RestartContinuationCandidate[] {
    const candidates = this.captureRestartContinuations()
    this.shutdownRequested = true
    return candidates
  }

  /** Main-only restart gate: check every context and close admission synchronously. */
  prepareEnvironmentSwitch(): void {
    this.captureActiveContext()
    if (this.launchOperation !== null || this.projectChangeOperation !== null || this.pendingProjectTrust !== null ||
      [...this.contexts].some((context) => {
        const state = context.state
        return !['ready', 'stopped', 'crashed'].includes(state.runtime.status) || !state.session.settled ||
          state.session.pendingMessageCount > 0 || state.session.compaction !== null ||
          context.launchCommitting || context.provisionalCommit !== null || context.stopRequested ||
          context.askInteraction !== null || context.extensionCommandInvocation !== null || context.extensionDialogInteraction !== null ||
          (context.compactionLifecycle !== null && !context.compactionLifecycle.settled) ||
          context.sessionNameOperation !== null || context.pendingSessionName !== null || context.deferredEvents !== null
      })) throw new Error('有会话正在工作或等待回复，请先完成或停止后再切换运行环境。')
    this.shutdownRequested = true
  }

  captureRestartContinuations(): RestartContinuationCandidate[] {
    if (!this.state.general.autoContinueInterruptedTasks) return []
    this.captureActiveContext()
    const capturedAt = this.now()
    const contexts = [...this.contexts].sort((first, second) => {
      if (first === this.activeContext) return -1
      if (second === this.activeContext) return 1
      return second.lastWarmUseAt - first.lastWarmUseAt
    })
    const candidates: RestartContinuationCandidate[] = []
    for (const context of contexts) {
      const state = context.state
      if (
        context.stopRequested ||
        context.launchCommitting ||
        context.deferredEvents !== null ||
        context.provisionalSession !== null ||
        context.provisionalCommit !== null ||
        context.askInteraction !== null ||
        state.extensionDialog !== null && state.extensionDialog !== undefined ||
        state.runtime.status !== 'running' ||
        state.session.settled ||
        state.session.compaction !== null ||
        (context.compactionLifecycle !== null && !context.compactionLifecycle.settled)
      ) {
        continue
      }
      const sessionFile = state.activeSessionKey
      const sessionId = state.session.id
      if (sessionFile === null || sessionId === null) continue
      const pointer = (this.sessionPointersByProject.get(context.projectPath) ?? []).find(
        (candidate) => candidate.projectPath === context.projectPath &&
          candidate.sessionFile === sessionFile &&
          candidate.sessionId === sessionId
      )
      if (pointer === undefined) continue
      candidates.push({
        id: randomUUID(),
        projectPath: pointer.projectPath,
        sessionFile: pointer.sessionFile,
        sessionId: pointer.sessionId,
        capturedAt
      })
    }
    return candidates
  }

  /**
   * Startup-only non-interactive recovery. It resumes every exact pending identity
   * that does not need a fresh Project trust decision, while restoring the user's
   * persisted foreground selection after background Runtime creation.
   */
  async resumeInterruptedSessions(): Promise<void> {
    if (
      !this.state.general.autoContinueInterruptedTasks ||
      this.restartContinuations.size === 0
    ) {
      return
    }
    if (
      this.contexts.size > 0 ||
      this.launchOperation !== null ||
      this.projectChangeOperation !== null ||
      this.pendingProjectTrust !== null
    ) {
      throw new Error('Restart continuation recovery is only available during startup.')
    }

    const selection: RestartRecoverySelection = {
      activeProjectKey: this.state.activeProjectKey,
      activeSessionKey: this.state.activeSessionKey,
      navigatorKind: this.state.navigatorKind ?? 'project'
    }
    const candidates = [...this.restartContinuations.values()].sort((first, second) => {
      const firstForeground = first.projectPath === selection.activeProjectKey &&
        first.sessionFile === selection.activeSessionKey
      const secondForeground = second.projectPath === selection.activeProjectKey &&
        second.sessionFile === selection.activeSessionKey
      if (firstForeground !== secondForeground) return firstForeground ? -1 : 1
      return first.capturedAt - second.capturedAt
    })

    try {
      for (const candidate of candidates) {
        const workspace = this.state.projects.find(({ path }) => path === candidate.projectPath)
        const pointer = (this.sessionPointersByProject.get(candidate.projectPath) ?? []).find(
          (stored) => stored.sessionFile === candidate.sessionFile &&
            stored.sessionId === candidate.sessionId
        )
        if (workspace === undefined || pointer === undefined) {
          await this.discardRestartContinuation(candidate)
          continue
        }

        let projectTrust: boolean | undefined | null = null
        try {
          projectTrust = await this.restartProjectTrust(workspace)
        } catch {
          continue
        }
        if (projectTrust === null) continue

        this.loadRestartRecoveryWorkspace(workspace, pointer)
        try {
          await this.beginLaunch(async () => {
            await this.launch(
              workspace,
              projectTrust === undefined
                ? { sessionFile: pointer.sessionFile }
                : { sessionFile: pointer.sessionFile, projectTrust },
              pointer.sessionId,
              true,
              false
            )
          })
        } catch {
          // Trust-blocked records remain pending. Once claim succeeds, every launch
          // or prompt failure is fail-closed and never retries automatically.
        }
      }
    } finally {
      this.restoreRestartRecoverySelection(selection)
    }
  }

  /**
   * On-demand read-only memory diagnostics for every managed RuntimeContext,
   * including pre-identity launch windows. Samples the root Pi RPC PID only via
   * `/proc/<pid>/smaps_rollup` (or the injected reader). Does not mutate KernelState,
   * publish events, poll, or write Conversation. Output carries opaque runtimeId only
   * — never Session identity, project path, names, prompt/output, or filesystem paths.
   */
  async getRuntimeMemoryDiagnostics(): Promise<KernelRuntimeMemoryDiagnostics> {
    const sampledAt = this.now()
    const runtimes: KernelRuntimeMemorySample[] = []
    // Snapshot membership first so every managed context gets exactly one record,
    // even if identity is still provisional or the set changes during async reads.
    const managed = [...this.contexts]

    for (const context of managed) {
      const runtimeStatus = this.activeContext === context
        ? this.state.runtime.status
        : context.state.runtime.status
      const rootPid = context.runtime.getRpcPid()
      let rssBytes: number | null = null
      let pssBytes: number | null = null
      let unavailableReason: KernelRuntimeMemoryUnavailableReason | null = null
      let sampleRootPid: number | null = rootPid

      if (rootPid === null) {
        unavailableReason = 'pid-unavailable'
      } else {
        const memory = await this.readProcessMemory(rootPid)
        // Late samples must not attach to a different owner after await.
        if (!this.contexts.has(context)) {
          unavailableReason = 'stale'
          sampleRootPid = null
        } else {
          const currentPid = context.runtime.getRpcPid()
          if (currentPid !== rootPid) {
            unavailableReason = 'ownership-changed'
            sampleRootPid = currentPid
          } else if (memory.ok) {
            rssBytes = memory.memory.rssBytes
            pssBytes = memory.memory.pssBytes
          } else {
            unavailableReason = memory.reason
          }
        }
      }

      runtimes.push({
        runtimeId: context.runtimeId,
        active: this.activeContext === context,
        runtimeStatus,
        rootPid: sampleRootPid,
        rssBytes,
        pssBytes,
        sampledAt,
        unavailableReason
      })
    }

    runtimes.sort((left, right) => {
      if (left.active !== right.active) return left.active ? -1 : 1
      return left.runtimeId.localeCompare(right.runtimeId)
    })

    if (this.readSharedRuntimeHostPid === undefined) return { sampledAt, runtimes }
    return { sampledAt, runtimes, sharedHost: await this.sampleSharedRuntimeHost(sampledAt) }
  }

  private async sampleSharedRuntimeHost(sampledAt: number): Promise<KernelSharedRuntimeHostMemorySample> {
    const readPid = this.readSharedRuntimeHostPid!
    const rootPid = readPid()
    if (rootPid === null) {
      return { rootPid: null, rssBytes: null, pssBytes: null, sampledAt, unavailableReason: 'pid-unavailable' }
    }
    const memory = await this.readProcessMemory(rootPid)
    const currentPid = readPid()
    if (currentPid !== rootPid) {
      return { rootPid: currentPid, rssBytes: null, pssBytes: null, sampledAt, unavailableReason: 'ownership-changed' }
    }
    return memory.ok
      ? { rootPid, rssBytes: memory.memory.rssBytes, pssBytes: memory.memory.pssBytes, sampledAt, unavailableReason: null }
      : { rootPid, rssBytes: null, pssBytes: null, sampledAt, unavailableReason: memory.reason }
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

  markProviderSessionsForReload(providerId: string): void {
    if (providerId.length === 0 || providerId.trim() !== providerId || /[\0\r\n]/u.test(providerId)) {
      throw new Error('Provider ID is invalid.')
    }
    let changed = false
    for (const context of this.contexts) {
      const contextState = context.state
      const sessionKey = contextState.activeSessionKey
      if (sessionKey === null || contextState.session.model?.provider !== providerId) continue
      const key = contextKey(context.projectPath, sessionKey)
      if (!this.sessionReloadRequired.has(key)) {
        this.sessionReloadRequired.add(key)
        changed = true
      }
    }
    if (!changed) return
    this.state = { ...this.state, sessions: this.toSessionSummaries() }
    this.emitState()
  }

  async refreshSessionActivities(): Promise<void> {
    const snapshots = Array.from(this.sessionPointersByProject, ([projectPath, pointers]) => ({
      projectPath,
      pointers: pointers.map((pointer) => ({ ...pointer }))
    }))
    const activeProjectAtStart = this.state.activeProjectKey
    // One Session file at a time: reading every transcript at once held all of them in memory
    // together (about 3 GB for 1.1 GB of Sessions).
    const metadataByProject: Array<{
      projectPath: string
      pointers: SessionPointer[]
      activityAtByKey: Map<string, number | null>
      statisticsByKey: Map<string, KernelSessionStatistics | null> | undefined
    }> = []
    for (const { projectPath, pointers } of snapshots) {
      metadataByProject.push(projectPath === activeProjectAtStart
        ? { projectPath, pointers, ...await this.loadSessionMetadata(pointers) }
        : { projectPath, pointers, activityAtByKey: await this.loadSessionActivities(pointers), statisticsByKey: undefined })
    }
    let changed = false
    for (const metadata of metadataByProject) {
      const currentPointers = this.sessionPointersByProject.get(metadata.projectPath)
      if (
        currentPointers === undefined ||
        !sameSessionPointers(currentPointers, metadata.pointers)
      ) {
        continue
      }
      this.sessionActivityByProject.set(metadata.projectPath, metadata.activityAtByKey)
      if (metadata.statisticsByKey !== undefined) {
        this.sessionStatisticsByProject.set(metadata.projectPath, metadata.statisticsByKey)
      }
      if (
        this.state.activeProjectKey === metadata.projectPath &&
        sameSessionPointers(this.sessionPointers, metadata.pointers)
      ) {
        this.sessionActivityAtByKey = metadata.activityAtByKey
        if (metadata.statisticsByKey !== undefined) {
          this.sessionStatisticsByKey = metadata.statisticsByKey
        }
      }
      changed = true
    }
    if (!changed) return
    this.state = {
      ...this.state,
      sessions: this.toSessionSummaries()
    }
    this.emitState()
  }

  async refreshWorkspaceMetadata(path: string): Promise<void> {
    if (!this.state.projects.some((workspace) => workspace.path === path)) {
      throw new Error(`Unknown Runtime workspace: ${path}`)
    }
    const generation = (this.workspaceMetadataRefreshGeneration.get(path) ?? 0) + 1
    this.workspaceMetadataRefreshGeneration.set(path, generation)
    const pointers = (this.sessionPointersByProject.get(path) ?? [])
      .map((pointer) => ({ ...pointer }))
    const activityBaseline = new Map(this.sessionActivityByProject.get(path) ?? [])
    const statisticsBaseline = new Map(this.sessionStatisticsByProject.get(path) ?? [])
    let refreshed: Awaited<ReturnType<WorkbenchKernel['loadSessionMetadata']>>
    try {
      refreshed = await this.loadSessionMetadata(pointers)
    } catch (error) {
      if (this.workspaceMetadataRefreshGeneration.get(path) !== generation) return
      throw error
    }
    if (this.workspaceMetadataRefreshGeneration.get(path) !== generation) return
    const currentPointers = this.sessionPointersByProject.get(path) ?? []
    const navigationBefore = this.projectNavigationState(path)
    const activityAtByKey = mergeRefreshedMetadata(
      currentPointers,
      refreshed.activityAtByKey,
      this.sessionActivityByProject.get(path) ?? new Map(),
      activityBaseline
    )
    const statisticsByKey = mergeRefreshedMetadata(
      currentPointers,
      refreshed.statisticsByKey,
      this.sessionStatisticsByProject.get(path) ?? new Map(),
      statisticsBaseline
    )
    this.sessionActivityByProject.set(path, activityAtByKey)
    this.sessionStatisticsByProject.set(path, statisticsByKey)
    if (this.state.activeProjectKey === path) {
      this.sessionPointers = currentPointers
      this.sessionActivityAtByKey = activityAtByKey
      this.sessionStatisticsByKey = statisticsByKey
    }
    this.publishProjectNavigationChange(path, navigationBefore)
  }

  async addProject(path: string, sessionRegistry: ProjectSessionRegistry): Promise<void> {
    if (!isAbsolute(path)) throw new Error(`Project path must be absolute: ${path}`)
    const existing = this.state.projects.find((project) => project.path === path)
    if (existing !== undefined && workspaceKind(existing) !== 'project') {
      throw new Error(`Runtime workspace is already registered as a Task: ${path}`)
    }
    if (this.state.activeProjectKey === path && this.state.navigatorKind === 'project') return
    await this.beginProjectChange(async () => {
      if (this.state.projects.some((project) => project.path === path)) {
        await this.activateWorkspaceWithinChange(path, sessionRegistry, 'project')
        return
      }
      await this.persistProject({ path })
      this.state = {
        ...this.state,
        projects: [...this.state.projects, { path }]
      }
      try {
        await this.activateWorkspaceWithinChange(path, sessionRegistry, 'project')
      } catch (error) {
        this.emitState()
        throw error
      }
    })
  }

  async addTask(
    task: { path: string, taskKey: string },
    sessionRegistry: ProjectSessionRegistry
  ): Promise<void> {
    if (!isAbsolute(task.path)) throw new Error(`Task workspace path must be absolute: ${task.path}`)
    if (task.taskKey.trim().length === 0) throw new Error('Task key is required.')
    if (this.state.projects.some((workspace) => workspace.path === task.path)) {
      throw new Error(`Runtime workspace is already registered: ${task.path}`)
    }
    await this.beginProjectChange(async () => {
      const staleTaskPaths = new Set(
        this.state.projects
          .filter((workspace) =>
            workspaceKind(workspace) === 'task' &&
            this.projectNavigationState(workspace.path).sessions.length === 0
          )
          .map(({ path }) => path)
      )
      for (const path of staleTaskPaths) {
        this.sessionPointersByProject.delete(path)
        this.sessionActivityByProject.delete(path)
        this.sessionStatisticsByProject.delete(path)
        this.workspaceMetadataRefreshGeneration.delete(path)
      }
      this.state = {
        ...this.state,
        projects: [
          ...this.state.projects.filter(({ path }) => !staleTaskPaths.has(path)),
          { path: task.path, workspaceKind: 'task', taskKey: task.taskKey }
        ]
      }
      try {
        await this.activateWorkspaceWithinChange(task.path, sessionRegistry, 'task')
      } catch (error) {
        this.emitState()
        throw error
      }
    })
  }

  async activateProject(path: string, sessionRegistry: ProjectSessionRegistry): Promise<void> {
    if (!isAbsolute(path)) throw new Error(`Project path must be absolute: ${path}`)
    const workspace = this.state.projects.find((project) => project.path === path)
    if (workspace === undefined || workspaceKind(workspace) !== 'project') {
      throw new Error(`Project is not registered: ${path}`)
    }
    if (this.state.activeProjectKey === path && this.state.navigatorKind === 'project') return
    await this.beginProjectChange(() =>
      this.activateWorkspaceWithinChange(path, sessionRegistry, 'project')
    )
  }

  async activateTask(taskKey: string, sessionRegistry: ProjectSessionRegistry): Promise<void> {
    const workspace = this.state.projects.find((candidate) =>
      workspaceKind(candidate) === 'task' && candidate.taskKey === taskKey
    )
    if (workspace === undefined) throw new Error(`Task is not registered: ${taskKey}`)
    if (this.state.activeProjectKey === workspace.path && this.state.navigatorKind === 'task') return
    await this.beginProjectChange(() =>
      this.activateWorkspaceWithinChange(workspace.path, sessionRegistry, 'task')
    )
  }

  async selectEmptyNavigator(kind: 'project' | 'task'): Promise<void> {
    if (this.state.activeProjectKey === null && this.state.navigatorKind === kind) return
    await this.beginProjectChange(async () => {
      await this.persistNavigatorKind(kind)
      await this.discardActiveEmptyProvisionalContext()
      this.captureActiveContext()
      this.sessionPointers = []
      this.sessionActivityAtByKey = new Map()
      this.sessionStatisticsByKey = new Map()
      this.state = {
        ...initialKernelState(
          { projects: this.state.projects, activeProjectKey: null },
          { sessions: [], activeSessionKey: null },
          this.sessionActivityAtByKey,
          this.sessionStatisticsByKey,
          this.state.sessionNaming,
          this.state.appearance,
          this.state.general,
          this.state.subagent,
          this.state.shortcuts,
          this.state.extensions
        ),
        navigatorKind: kind
      }
      this.activeContext = null
      this.emitState()
    })
  }

  private async activateWorkspaceWithinChange(
    path: string,
    sessionRegistry: ProjectSessionRegistry,
    kind: 'project' | 'task'
  ): Promise<void> {
    const workspace = this.state.projects.find((project) => project.path === path)
    if (workspace === undefined || workspaceKind(workspace) !== kind) {
      throw new Error(`${kind === 'project' ? 'Project' : 'Task'} is not registered: ${path}`)
    }
    if (this.state.activeProjectKey === path && this.state.navigatorKind === kind) return
    if (kind === 'task') await this.persistActiveTask(workspace.taskKey!)
    else await this.persistActiveProject(path)
    const matchingRegistry = matchingSessionRegistry(workspace, sessionRegistry)
    const sessionPointers = matchingRegistry.sessions
    await this.discardActiveEmptyProvisionalContext()
    this.captureActiveContext()

    const activityAtByKey = metadataCacheForPointers(
      sessionPointers,
      this.sessionActivityByProject.get(path)
    )
    const statisticsByKey = metadataCacheForPointers(
      sessionPointers,
      this.sessionStatisticsByProject.get(path)
    )
    this.sessionPointers = sessionPointers
    this.sessionActivityAtByKey = activityAtByKey
    this.sessionStatisticsByKey = statisticsByKey
    this.sessionPointersByProject.set(path, this.sessionPointers)
    this.sessionActivityByProject.set(path, this.sessionActivityAtByKey)
    this.sessionStatisticsByProject.set(path, this.sessionStatisticsByKey)
    this.state = {
      ...initialKernelState({
        projects: this.state.projects,
        activeProjectKey: path
      }, matchingRegistry, this.sessionActivityAtByKey, this.sessionStatisticsByKey, this.state.sessionNaming, this.state.appearance, this.state.general, this.state.subagent, this.state.shortcuts, this.state.extensions),
      navigatorKind: kind
    }
    const managed = matchingRegistry.activeSessionKey === null
      ? null
      : this.contextBySessionKey.get(contextKey(path, matchingRegistry.activeSessionKey)) ?? null
    if (managed !== null) this.loadContext(managed)
    else this.activeContext = null
    this.emitState()
  }

  async start(): Promise<void> {
    const currentProvisional = this.activeContext?.provisionalSession ?? null
    if (
      currentProvisional !== null &&
      currentProvisional.runtime === this.runtime &&
      currentProvisional.initialPrompt === null &&
      this.state.activeProjectKey === currentProvisional.pointer.projectPath &&
      this.state.activeSessionKey === currentProvisional.pointer.sessionFile &&
      this.state.runtime.status === 'ready' &&
      this.state.session.settled
    ) {
      // An empty provisional Session already represents the requested blank workspace.
      // Reusing it prevents repeated clicks or shortcuts from accumulating placeholders.
      return
    }

    const selectedWorkspace = configuredProject(this.state)
    if (
      workspaceKind(selectedWorkspace) === 'task' &&
      (
        this.state.activeSessionKey !== null ||
        this.sessionPointers.some(({ projectPath }) => projectPath === selectedWorkspace.path) ||
        Array.from(this.contexts).some(({ projectPath }) => projectPath === selectedWorkspace.path)
      )
    ) {
      throw new Error('A Task already owns its Session; create another Task instead.')
    }

    await this.beginLaunch(async () => {
      const project = configuredProject(this.state)
      await this.launch(project, {})
    })
  }

  async reloadSession(): Promise<void> {
    await this.beginLaunch(async () => {
      if (this.state.runtime.status !== 'ready') {
        throw new Error(`Runtime must be ready; current status is ${this.state.runtime.status}.`)
      }
      if (!this.state.session.settled) throw new Error('Session must be settled before reload.')
      const project = configuredProject(this.state)
      const sessionKey = this.state.activeSessionKey
      if (sessionKey === null) throw new Error('Reload requires an active persisted session.')
      const storedPointer = this.sessionPointers.find((pointer) =>
        pointer.projectPath === project.path && pointer.sessionFile === sessionKey
      )
      if (storedPointer === undefined) throw new Error('Reload requires an active persisted session.')
      if (typeof this.validateSession !== 'function') {
        throw new Error('Session validation is unavailable.')
      }
      const validateSession = this.validateSession
      const target = this.activeContext
      if (target === null || target.runtime !== this.runtime) {
        throw new Error('Active runtime context is unavailable.')
      }

      const pointer = await validateSession(storedPointer)
      this.assertLaunchActive()
      this.assertReloadTarget(project.path, storedPointer, target)
      const projectTrust = await this.preflightProjectTrust(project.path)
      this.assertLaunchActive()
      this.assertReloadTarget(project.path, storedPointer, target)
      await this.stopContext(target)
      this.assertLaunchActive()
      await this.launch(
        project,
        projectTrust === undefined
          ? { sessionFile: pointer.sessionFile }
          : { sessionFile: pointer.sessionFile, projectTrust },
        pointer.sessionId,
        true
      )
      if (this.sessionReloadRequired.delete(contextKey(project.path, pointer.sessionFile))) {
        this.state = { ...this.state, sessions: this.toSessionSummaries() }
        this.emitState()
      }
    })
  }

  async resolveProjectTrust(
    requestId: string,
    choice: KernelProjectTrustChoice
  ): Promise<void> {
    const pending = this.pendingProjectTrust
    if (pending === null || pending.id !== requestId) {
      throw new Error('Project trust request is stale or mismatched.')
    }
    if (pending.persistenceInFlight) {
      throw new Error('Project trust decision persistence is already in progress.')
    }
    if (choice === 'persist-trusted' || choice === 'persist-untrusted') {
      const decision = choice === 'persist-trusted'
      pending.persistenceInFlight = true
      try {
        await this.projectTrust.persist(pending.projectPath, decision)
      } catch (error) {
        if (this.pendingProjectTrust === pending) pending.persistenceInFlight = false
        throw error
      }
      if (this.pendingProjectTrust !== pending) {
        throw new Error('Project trust request became stale.')
      }
      this.finishProjectTrustRequest(pending)
      pending.resolve(undefined)
      return
    }
    if (choice === 'once-trusted' || choice === 'once-untrusted') {
      this.finishProjectTrustRequest(pending)
      pending.resolve(choice === 'once-trusted')
      return
    }
    if (choice === 'cancel') {
      this.finishProjectTrustRequest(pending)
      pending.reject(new Error('Runtime start cancelled by project trust decision.'))
      return
    }
    choice satisfies never
    throw new Error('Unsupported project trust choice.')
  }

  async submitAsk(
    sessionKey: string,
    toolCallId: string,
    answers: KernelAskAnswer[]
  ): Promise<void> {
    await this.interactions.submitAsk(sessionKey, toolCallId, answers)
  }

  async cancelAsk(sessionKey: string, toolCallId: string): Promise<void> {
    await this.interactions.cancelAsk(sessionKey, toolCallId)
  }

  async respondExtensionDialog(
    projectKey: string,
    sessionKey: string,
    sessionId: string,
    requestId: string,
    commandInvocationId: string,
    value: string
  ): Promise<void> {
    await this.interactions.respondExtensionDialog(projectKey, sessionKey, sessionId, requestId, commandInvocationId, value)
  }

  async cancelExtensionDialog(
    projectKey: string,
    sessionKey: string,
    sessionId: string,
    requestId: string,
    commandInvocationId: string
  ): Promise<void> {
    await this.interactions.cancelExtensionDialog(projectKey, sessionKey, sessionId, requestId, commandInvocationId)
  }

  async activateSession(
    sessionKey: string,
    sessionRegistry?: ProjectSessionRegistry | (() => Promise<ProjectSessionRegistry>)
  ): Promise<void> {
    if (!isAbsolute(sessionKey)) throw new Error(`Session key must be absolute: ${sessionKey}`)
    await this.beginLaunch(async () => {
      const project = configuredProject(this.state)
      if (this.isActiveProvisionalSessionIdentity(project.path, sessionKey)) return
      let storedPointer = this.sessionPointers.find(
        (pointer) => pointer.projectPath === project.path && pointer.sessionFile === sessionKey
      )
      if (storedPointer !== undefined) {
        const warmManaged = this.findHealthyManagedSessionContext(project.path, storedPointer)
        if (warmManaged !== undefined) {
          await this.activateHealthyManagedSession(project.path, storedPointer, warmManaged)
          return
        }
      }
      if (storedPointer === undefined) {
        // The Navigator may already reflect a durable/background materialization while
        // this active cache still trails it. Recover only an exact persisted target.
        const registry = typeof sessionRegistry === 'function'
          ? await sessionRegistry()
          : sessionRegistry
        this.assertLaunchActive()
        const refreshedPointer = this.findSessionPointerInRegistry(
          project.path,
          sessionKey,
          registry
        )
        if (refreshedPointer !== undefined) {
          if (typeof this.validateSession !== 'function') {
            throw new Error('Session validation is unavailable.')
          }
          storedPointer = await this.validateSession(refreshedPointer)
          this.assertLaunchActive()
          this.sessionPointers = upsertSessionPointer(this.sessionPointers, storedPointer)
          await this.captureSessionMetadata(storedPointer)
          this.assertLaunchActive()
          this.sessionPointersByProject.set(project.path, this.sessionPointers)
          const warmManaged = this.findHealthyManagedSessionContext(project.path, storedPointer)
          if (warmManaged !== undefined) {
            await this.activateHealthyManagedSession(project.path, storedPointer, warmManaged)
            return
          }
        }
      }
      if (storedPointer === undefined) {
        throw new Error(`Session is not registered for the active project: ${sessionKey}`)
      }
      if (typeof this.validateSession !== 'function') {
        throw new Error('Session validation is unavailable.')
      }
      const pointer = await this.validateSession(storedPointer)
      this.assertLaunchActive()
      const managed = this.contextBySessionKey.get(contextKey(project.path, sessionKey))
      if (managed !== undefined) {
        await this.stopContext(managed)
        this.assertLaunchActive()
      }
      await this.discardActiveEmptyProvisionalContext()
      this.assertLaunchActive()
      await this.launch(project, { sessionFile: pointer.sessionFile }, pointer.sessionId)
    })
  }

  private async activateHealthyManagedSession(
    projectPath: string,
    pointer: SessionPointer,
    managed: RuntimeContext
  ): Promise<void> {
    const emptyProvisional = this.activeContext === managed
      ? null
      : this.activeEmptyProvisionalContext()
    await this.persistActiveSession(projectPath, pointer.sessionFile, pointer.sessionId)
    this.assertLaunchActive()
    this.captureActiveContext()
    this.touchWarmUse(managed)
    this.loadContext(managed)
    this.emitState()
    if (emptyProvisional === null) return
    try {
      await this.stopContext(emptyProvisional)
    } catch (error) {
      throw new Error(
        `Warm Session activated, but empty provisional cleanup failed: ${errorMessage(error)}`
      )
    }
    this.assertLaunchActive()
  }

  private isActiveProvisionalSessionIdentity(
    projectPath: string,
    sessionKey: string
  ): boolean {
    const context = this.activeContext
    const provisional = context?.provisionalSession ?? null
    return context !== null &&
      this.contexts.has(context) &&
      context.projectPath === projectPath &&
      this.contextBySessionKey.get(contextKey(projectPath, sessionKey)) === context &&
      provisional !== null &&
      provisional.runtime === context.runtime &&
      provisional.pointer.projectPath === projectPath &&
      provisional.pointer.sessionFile === sessionKey &&
      this.state.activeSessionKey === sessionKey &&
      this.state.session.id === provisional.pointer.sessionId &&
      (this.state.runtime.status === 'ready' || this.state.runtime.status === 'running')
  }

  private findHealthyManagedSessionContext(
    projectPath: string,
    pointer: SessionPointer
  ): RuntimeContext | undefined {
    const managed = this.contextBySessionKey.get(contextKey(projectPath, pointer.sessionFile))
    if (
      managed === undefined ||
      !this.contexts.has(managed) ||
      managed.projectPath !== projectPath ||
      managed.deferredEvents !== null
    ) {
      return undefined
    }
    const active = this.activeContext === managed
    if (
      this.stopAllRequested ||
      managed.stopRequested ||
      managed.launchCommitting ||
      managed.provisionalSession !== null ||
      managed.provisionalCommit !== null
    ) {
      return undefined
    }
    const state = active ? this.state : managed.state
    if (state.runtime.status !== 'ready' && state.runtime.status !== 'running') return undefined
    if (
      state.activeSessionKey !== pointer.sessionFile ||
      state.session.id !== pointer.sessionId
    ) {
      return undefined
    }
    const summary = this.toSessionSummariesForProject(projectPath)
      .find(({ key }) => key === pointer.sessionFile)
    if (summary === undefined || summary.id !== pointer.sessionId || summary.provisional === true) {
      return undefined
    }
    return managed
  }

  async previewSession(
    sessionKey: string,
    requestId: string,
    sessionRegistry?: SessionPreviewRegistrySource
  ): Promise<KernelSessionPreview> {
    return await this.previews.preview(sessionKey, requestId, sessionRegistry)
  }

  async completeSessionPreview(requestId: string): Promise<KernelSessionPreview> {
    return await this.previews.complete(requestId)
  }

  cancelSessionPreview(requestId: string): void {
    this.previews.cancel(requestId)
  }

  async loadEarlierSessionPreview(
    request: KernelSessionPreviewPageRequest,
    sessionRegistry?: SessionPreviewRegistrySource
  ): Promise<KernelConversationPage> {
    return await this.previews.loadEarlier(request, sessionRegistry)
  }

  async getMessageImage(
    sessionKey: string,
    messageId: string,
    attachmentIndex: number
  ): Promise<KernelMessageImage> {
    if (!isAbsolute(sessionKey)) throw new Error(`Session key must be absolute: ${sessionKey}`)
    const project = configuredProject(this.state)
    const messages = await this.loadMessagesForImageLookup(project.path, sessionKey)
    const message = findUserMessageForImageLookup(messages, messageId)
    return extractProjectedMessageImage(message, attachmentIndex)
  }

  async getToolImage(
    sessionKey: string,
    toolCallId: string,
    contentIndex: number
  ): Promise<KernelMessageImage> {
    if (!isAbsolute(sessionKey)) throw new Error(`Session key must be absolute: ${sessionKey}`)
    if (typeof toolCallId !== 'string' || toolCallId.trim().length === 0 || toolCallId.length > 256) {
      throw new Error('Tool image lookup requires a valid toolCallId.')
    }
    if (!Number.isInteger(contentIndex) || contentIndex < 0 || contentIndex >= 64) {
      throw new Error('Tool image content index is invalid.')
    }
    const project = configuredProject(this.state)
    const ownerContext = this.contextBySessionKey.get(contextKey(project.path, sessionKey)) ?? null
    const ownerState = ownerContext === null
      ? this.state
      : this.activeContext === ownerContext ? this.state : ownerContext.state

    const messages = await this.loadMessagesForImageLookup(project.path, sessionKey)
    try {
      const message = findToolResultMessage(messages, toolCallId)
      const image = extractToolResultImage(message, contentIndex)
      this.deleteCachedToolImage(project.path, ownerState.session.id, sessionKey, toolCallId, contentIndex)
      return image
    } catch (error) {
      if (!(error instanceof ToolResultMessageNotFoundError) || ownerContext === null) throw error
      return this.readCachedToolImage(
        project.path,
        ownerContext,
        ownerState.session.id,
        sessionKey,
        toolCallId,
        contentIndex
      )
    }
  }

  async prepareSessionExport(): Promise<{
    projectKey: string
    sessionKey: string
    sessionId: string
    title: string | null
    messages: unknown[]
  }> {
    const project = configuredProject(this.state)
    const sessionKey = this.state.activeSessionKey
    if (sessionKey === null || !this.state.session.settled) {
      throw new Error('Export requires a settled active persisted session.')
    }
    if (!isSessionExportRuntimeStatusAllowed(this.state.runtime.status)) {
      throw new Error('Export requires a settled session.')
    }
    if (typeof this.validateSession !== 'function' || typeof this.readSessionMessages !== 'function') {
      throw new Error('Session export is unavailable.')
    }
    const storedPointer = this.sessionPointers.find((pointer) =>
      pointer.projectPath === project.path && pointer.sessionFile === sessionKey
    )
    if (storedPointer === undefined) {
      throw new Error('Export requires an active persisted session.')
    }

    const pointer = await this.validateSession(storedPointer)
    const messages = await this.readSessionMessages(pointer)
    if (
      this.state.activeProjectKey !== project.path ||
      this.state.activeSessionKey !== sessionKey ||
      !this.state.session.settled ||
      !isSessionExportRuntimeStatusAllowed(this.state.runtime.status) ||
      !this.sessionPointers.some((candidate) =>
        candidate.projectPath === pointer.projectPath &&
        candidate.sessionFile === pointer.sessionFile &&
        candidate.sessionId === pointer.sessionId
      )
    ) {
      throw new Error('Session export cancelled because the active session changed.')
    }
    return {
      projectKey: pointer.projectPath,
      sessionKey: pointer.sessionFile,
      sessionId: pointer.sessionId,
      title: pointer.sessionName,
      messages
    }
  }

  async listForkCandidates(): Promise<KernelForkCandidate[]> {
    const target = this.requireForkTarget()
    const result = await target.runtime.send({ type: 'get_entries' })
    if (result.type !== 'entries') {
      throw new Error('Runtime did not return session entries.')
    }
    this.assertForkTarget(target)
    return forkCandidatesOnActivePath(result.entries, result.leafId)
  }

  async navigateHistoryPrompt(expectedSessionKey: string, messageId: string): Promise<void> {
    if (messageId.trim().length === 0) {
      throw new Error('History prompt message ID must not be empty.')
    }

    await this.beginLaunch(async () => {
      const target = this.requireForkTarget()
      if (target.context.state.activeSessionKey !== expectedSessionKey) {
        throw new Error('The active Session changed before history navigation.')
      }
      const entriesResult = await target.runtime.send({ type: 'get_entries' })
      if (entriesResult.type !== 'entries') {
        throw new Error('Runtime did not return session entries.')
      }
      this.assertForkTarget(target)
      const candidate = resolveVisiblePromptCandidate(
        target.context.state.conversation.entries,
        forkCandidatesOnActivePath(entriesResult.entries, entriesResult.leafId),
        messageId
      )
      if (candidate === null) {
        throw new Error('History prompt is not an eligible user message on the active path.')
      }

      const navigation = await target.runtime.send({
        type: 'navigate_tree',
        targetEntryId: candidate.entryId
      })
      if (navigation.type !== 'tree-navigation') {
        throw new Error('Runtime did not return a tree navigation result.')
      }
      this.assertForkTarget(target)
      if (navigation.cancelled) {
        throw new Error('History prompt navigation was cancelled.')
      }

      const targetIndex = target.context.state.conversation.entries.findIndex(
        (entry) => entry.id === messageId
      )
      if (targetIndex < 0) {
        throw new Error('History prompt disappeared before navigation completed.')
      }
      const navigatedState: RuntimeSessionState = {
        ...target.context.state,
        session: {
          ...target.context.state.session,
          openAiFastMode: openAiFastModeFromSessionEntries(
            sessionEntriesOnActivePath(entriesResult.entries, navigation.leafId)
          )
        },
        conversation: {
          entries: target.context.state.conversation.entries.slice(0, targetIndex),
          startIndex: 0,
          activeRunStartIndex: null
        }
      }
      target.context.state = navigatedState
      this.state = projectRuntimeSessionState(this.state, navigatedState)
      this.emitState()
    })
  }

  async forkSession(entryId: string): Promise<{ draft: string, cancelled: boolean }> {
    if (entryId.trim().length === 0) throw new Error('Fork entry ID must not be empty.')
    let result: { draft: string, cancelled: boolean } | null = null
    await this.beginLaunch(async () => {
      const target = this.requireForkTarget()
      const previousState = copyState(this.state)
      let forkAttempted = false
      let forkCancelled = false
      let forkCommitted = false
      try {
        const entriesResult = await target.runtime.send({ type: 'get_entries' })
        if (entriesResult.type !== 'entries') {
          throw new Error('Runtime did not return session entries.')
        }
        this.assertForkTarget(target)
        if (!forkCandidatesOnActivePath(entriesResult.entries, entriesResult.leafId).some(
          (candidate) => candidate.entryId === entryId
        )) {
          throw new Error('Fork entry is not an eligible user message on the active path.')
        }

        this.naming.cancel(target.runtime)
        forkAttempted = true
        const forkResult = await target.runtime.send({ type: 'fork', entryId })
        if (forkResult.type !== 'forked') {
          throw new Error('Runtime did not return a fork result.')
        }
        forkCancelled = forkResult.cancelled
        if (forkResult.cancelled) {
          this.assertForkTarget(target)
          result = { draft: forkResult.text, cancelled: true }
          return
        }

        this.assertForkTarget(target)
        const stateResult = await target.runtime.send({ type: 'get_state' })
        this.assertForkTarget(target)
        if (stateResult.type !== 'state') {
          throw new Error('Runtime did not return forked session state.')
        }
        const statisticsResult = await target.runtime.send({ type: 'get_session_stats' })
        this.assertForkTarget(target)
        if (statisticsResult.type !== 'session-statistics') {
          throw new Error('Runtime did not return forked session statistics.')
        }
        let session = toKernelSession(
          stateResult.state,
          true,
          toKernelSessionUsage(statisticsResult.statistics, stateResult.state.model?.contextWindow),
          false
        )
        const sessionFile = stringValue(stateResult.state.sessionFile)
        if (
          session.id === null ||
          session.id.length === 0 ||
          session.id === target.pointer.sessionId ||
          sessionFile === null ||
          !isAbsolute(sessionFile) ||
          sessionFile === target.pointer.sessionFile
        ) {
          throw new Error('Runtime did not return a distinct forked session identity.')
        }
        const sessionId = session.id
        assertSessionStatisticsIdentity(statisticsResult.statistics, sessionFile, sessionId)

        const messagesResult = await target.runtime.send({ type: 'get_messages' })
        this.assertForkTarget(target)
        if (messagesResult.type !== 'messages') {
          throw new Error('Runtime did not return forked conversation messages.')
        }
        const commandsResult = await target.runtime.send({ type: 'get_commands' })
        this.assertForkTarget(target)
        if (commandsResult.type !== 'commands') {
          throw new Error('Runtime did not return a forked command catalog.')
        }
        const capabilitiesResult = await target.runtime.send({ type: 'get_entries' })
        this.assertForkTarget(target)
        if (capabilitiesResult.type !== 'entries') {
          throw new Error('Runtime did not return forked session entries.')
        }
        const modelsResult = await target.runtime.send({ type: 'get_available_models' })
        this.assertForkTarget(target)
        if (modelsResult.type !== 'available-models') {
          throw new Error('Runtime did not return a forked model catalog.')
        }
        const activeSessionEntries = sessionEntriesOnActivePath(
          capabilitiesResult.entries,
          capabilitiesResult.leafId
        )
        session = toKernelSession(
          stateResult.state,
          true,
          toKernelSessionUsage(statisticsResult.statistics, stateResult.state.model?.contextWindow),
          openAiFastModeFromSessionEntries(activeSessionEntries)
        )
        const projectedMessages = mergeConversationEntries(
          projectMessages(messagesResult.messages),
          projectSessionEntries(activeSessionEntries)
        )
        const advisor = projectAdvisorState(capabilitiesResult.entries)
        const availableModels = modelsResult.models.map(toAvailableKernelModel)
        if (typeof this.validateSession !== 'function') {
          throw new Error('Session validation is unavailable.')
        }
        let pointer: SessionPointer = {
          projectPath: target.projectPath,
          sessionFile,
          sessionId,
          sessionName: session.name
        }
        let provisionalFork = false
        try {
          pointer = await this.validateSession(pointer)
        } catch (error) {
          // The SDK defers a fork with no assistant history until its first answer,
          // just like a new Session. Keep the existing provisional lifecycle owner.
          if (!isEnoent(error) || projectedMessages.some((entry) =>
            entry.kind === 'message' && entry.role === 'assistant'
          )) throw error
          provisionalFork = true
        }
        const commands = createCommandCatalog(commandsResult.commands, !provisionalFork)
        this.assertForkTarget(target)
        if (
          pointer.projectPath !== target.projectPath ||
          pointer.sessionFile === target.pointer.sessionFile ||
          pointer.sessionId !== sessionId ||
          pointer.sessionId === target.pointer.sessionId
        ) {
          throw new Error('Forked session validation returned a mismatched identity.')
        }
        const activityAt = provisionalFork ? null : await this.readSessionActivityAt(pointer)
        this.assertForkTarget(target)
        const statistics = toKernelSessionStatistics(statisticsResult.statistics)

        if (target.context.deferredEvents !== null) {
          throw new Error('Fork identity commit is already buffering runtime events.')
        }
        target.context.launchCommitting = true
        target.context.deferredEvents = []
        try {
          if (!provisionalFork) await this.persistSession(pointer)
          // No Runtime event can mutate the old identity during this await: events
          // are buffered on the owning Context until the new identity and
          // in-memory projection are committed together.
          this.assertForkTarget(target)
          if (provisionalFork) {
            target.context.provisionalSession = {
              runtime: target.runtime,
              pointer,
              initialPrompt: null,
              sessionNameAttempted: false,
              activityAt: this.now()
            }
            target.context.provisionalSettled = false
          } else {
            this.sessionPointers = upsertSessionPointer(this.sessionPointers, pointer)
            this.sessionActivityAtByKey.set(pointer.sessionFile, activityAt)
            this.sessionStatisticsByKey.set(pointer.sessionFile, statistics)
            this.sessionPointersByProject.set(target.projectPath, this.sessionPointers)
            this.sessionActivityByProject.set(target.projectPath, this.sessionActivityAtByKey)
            this.sessionStatisticsByProject.set(target.projectPath, this.sessionStatisticsByKey)
          }
          if (
            this.contextBySessionKey.get(
              contextKey(target.projectPath, target.pointer.sessionFile)
            ) === target.context
          ) {
            this.contextBySessionKey.delete(
              contextKey(target.projectPath, target.pointer.sessionFile)
            )
          }
          const previousContextKey = contextKey(target.projectPath, target.pointer.sessionFile)
          const nextContextKey = contextKey(target.projectPath, pointer.sessionFile)
          if (this.sessionReloadRequired.delete(previousContextKey)) {
            this.sessionReloadRequired.add(nextContextKey)
          }
          this.contextBySessionKey.set(
            nextContextKey,
            target.context
          )
          // Fork creates a new session file on the same context; drop prior local echoes.
          target.context.commandEntries = []
          this.state = {
            ...this.state,
            sessions: this.toSessionSummaries(),
            activeSessionKey: pointer.sessionFile,
            commands,
            advisor,
            availableModels,
            runtime: toKernelRuntime('ready', target.runtime.getState()),
            session: provisionalFork ? { ...session, resumeAvailable: false } : session,
            conversation: {
              entries: projectedMessages,
              startIndex: 0,
              activeRunStartIndex: null
            }
          }
          result = { draft: forkResult.text, cancelled: false }
          forkCommitted = true
          this.emitState()

          const deferredEvents = target.context.deferredEvents
          if (deferredEvents !== null) {
            let replayError: unknown = null
            // Keep the queue installed while draining. Reentrant Runtime delivery
            // appends to the same tail, preserving FIFO behind events that already
            // arrived during persistence.
            for (let index = 0; index < deferredEvents.length; index += 1) {
              const deferredEvent = deferredEvents[index]
              if (deferredEvent === undefined) continue
              try {
                this.deliverContextEvent(target.context, deferredEvent)
              } catch (error) {
                replayError ??= error
              }
            }
            target.context.deferredEvents = null
            if (replayError !== null) throw replayError
          }
        } finally {
          // On pre-commit failure the rebound Runtime is stopped by failForkedContext;
          // buffered events belong to that discarded identity and must not leak later.
          target.context.deferredEvents = null
          target.context.launchCommitting = false
        }
      } catch (error) {
        if (forkCommitted) return
        if (forkAttempted && !forkCancelled) {
          throw await this.failForkedContext(target.context, previousState, error)
        }
        throw error
      }
    })
    if (result === null) throw new Error('Fork operation did not return a result.')
    return result
  }

  /**
   * Kernel-internal groundwork for future automatic Runtime reclamation.
   * Stops one managed, persisted, inactive RuntimeContext while preserving its
   * durable Session pointer and navigation identity for activateSession recovery.
   * This is intentionally not exposed through KernelCommand. A future automatic
   * policy must also prove Extension operation-lease quiescence before calling it.
   */
  async reclaimInactiveRuntime(
    sessionKey: string,
    projectPath = configuredProject(this.state).path
  ): Promise<boolean> {
    this.assertRegisteredProject(projectPath)
    if (!isAbsolute(sessionKey)) throw new Error(`Session key must be absolute: ${sessionKey}`)
    const pointer = (this.sessionPointersByProject.get(projectPath) ?? []).find((candidate) =>
      candidate.projectPath === projectPath && candidate.sessionFile === sessionKey
    )
    if (pointer === undefined) {
      throw new Error(`Session is not registered for the target project: ${sessionKey}`)
    }

    let reclaimed = false
    // Serialize with activate/reload/start so a target cannot be loaded or replaced
    // while reclamation is stopping it. Registered-but-unmanaged targets are no-ops.
    await this.beginLaunch(async () => {
      const targetContext = this.contextBySessionKey.get(contextKey(projectPath, sessionKey))
      if (targetContext === undefined) return

      this.assertInactiveRuntimeReclaimTarget(projectPath, sessionKey, targetContext)
      await this.stopContext(targetContext, true)
      reclaimed = true
    })
    return reclaimed
  }

  /**
   * One non-overlapping automatic hibernation sweep.
   * Candidates must be persisted, background, ready, settled, non-provisional,
   * Kernel-unblocked, and older than the grace period. Keeps the most-recent
   * background ready Runtime warm. Uses generation-fenced prepare→commit→stop
   * only — never the user-directed manual hibernation path as authority.
   */
  async sweepAutomaticHibernation(options?: {
    graceMs?: number
    nowMs?: number
  }): Promise<{
    attempted: number
    hibernatedCount: number
    skippedCount: number
    failedCount: number
  }> {
    return await this.hibernation.sweep(options)
  }

  async archiveSession(
    sessionKey: string,
    sessionRegistry?: ProjectSessionRegistry
  ): Promise<KernelArchiveReceipt> {
    if (!isAbsolute(sessionKey)) throw new Error(`Session key must be absolute: ${sessionKey}`)
    const project = configuredProject(this.state)
    const pointer = this.sessionPointers.find((candidate) =>
      candidate.projectPath === project.path && candidate.sessionFile === sessionKey
    ) ?? this.findSessionPointerInRegistry(project.path, sessionKey, sessionRegistry)
    if (pointer === undefined) {
      throw new Error(`Session is not registered for the active project: ${sessionKey}`)
    }
    const activityAt = this.sessionActivityAtByKey.get(sessionKey) ?? null
    const statistics = this.sessionStatisticsByKey.get(sessionKey) ?? null

    await this.beginProjectChange(async () => {
      const isActive = this.state.activeSessionKey === sessionKey
      const targetContext = this.contextBySessionKey.get(contextKey(project.path, sessionKey)) ?? null
      if (targetContext !== null) await this.stopContext(targetContext)
      this.toolImages.clearForSession(sessionKey)
      await this.persistArchivedSession(project.path, sessionKey)
      this.sessionReloadRequired.delete(contextKey(project.path, sessionKey))

      this.sessionPointers = this.sessionPointers.filter((candidate) =>
        candidate.sessionFile !== sessionKey
      )
      this.sessionActivityAtByKey.delete(sessionKey)
      this.sessionStatisticsByKey.delete(sessionKey)
      this.sessionPointersByProject.set(project.path, this.sessionPointers)
      this.sessionActivityByProject.set(project.path, this.sessionActivityAtByKey)
      this.sessionStatisticsByProject.set(project.path, this.sessionStatisticsByKey)
      const sessions = this.toSessionSummaries()
      this.state = isActive
        ? {
            ...this.state,
            sessions,
            activeSessionKey: null,
            commands: createCommandCatalog(),
            availableModels: [],
            session: { ...INITIAL_SESSION_STATE },
            conversation: { entries: [], startIndex: 0, activeRunStartIndex: null }
          }
        : { ...this.state, sessions }
      this.emitState()
    })
    const receipt: KernelArchiveReceipt = {
      token: randomUUID(),
      projectKey: project.path,
      sessionKey: pointer.sessionFile,
      sessionName: pointer.sessionName,
      durationMs: ARCHIVE_UNDO_DURATION_MS
    }
    this.archiveUndoByToken.set(receipt.token, {
      receipt,
      pointer: { ...pointer },
      activityAt,
      statistics,
      expiresAt: this.now() + ARCHIVE_UNDO_DURATION_MS
    })
    return { ...receipt }
  }

  async undoArchiveSession(token: string): Promise<void> {
    const record = this.requireArchiveUndoRecord(token)
    await this.beginProjectChange(async () => {
      const current = this.requireArchiveUndoRecord(token)
      if (current !== record) throw new Error('Archive undo credential is stale.')
      const registry = matchingSessionRegistry(
        configuredProject(this.state),
        await this.restoreArchivedSession(record.receipt.projectKey, record.pointer.sessionFile)
      )
      if (this.archiveUndoByToken.get(token) !== record) {
        throw new Error('Archive undo credential is stale.')
      }
      this.archiveUndoByToken.delete(token)
      this.sessionPointers = registry.sessions
      this.sessionActivityAtByKey = new Map(this.sessionPointers.map((pointer) => [
        pointer.sessionFile,
        pointer.sessionFile === record.pointer.sessionFile
          ? record.activityAt
          : this.sessionActivityAtByKey.get(pointer.sessionFile) ?? null
      ]))
      this.sessionStatisticsByKey = new Map(this.sessionPointers.map((pointer) => [
        pointer.sessionFile,
        pointer.sessionFile === record.pointer.sessionFile
          ? record.statistics
          : this.sessionStatisticsByKey.get(pointer.sessionFile) ?? null
      ]))
      this.sessionPointersByProject.set(record.receipt.projectKey, this.sessionPointers)
      this.sessionActivityByProject.set(record.receipt.projectKey, this.sessionActivityAtByKey)
      this.sessionStatisticsByProject.set(record.receipt.projectKey, this.sessionStatisticsByKey)
      this.state = {
        ...this.state,
        sessions: this.toSessionSummaries()
      }
      this.emitState()
    })
  }

  async previewArchivedSession(token: string): Promise<KernelSessionPreview> {
    const record = this.requireArchiveUndoRecord(token)
    if (typeof this.validateSession !== 'function') {
      throw new Error('Session validation is unavailable.')
    }
    const preparations = this.sessionTranscriptPreparations
    if (preparations === null) throw new Error('Session preview is unavailable.')
    const pointer = await this.validateSession(record.pointer)
    const handle = await preparations.acquire(pointer)
    try {
      const phase = await handle.completion
      if (this.requireArchiveUndoRecord(token) !== record) {
        throw new Error('Archive undo credential is stale.')
      }
      this.archiveUndoByToken.delete(token)
      const entries = projectTranscriptMessages(phase.messages)
      const startIndex = conversationTurnWindowStartIndex(
        entries,
        entries.length,
        KERNEL_CONVERSATION_PAGE_TURN_COUNT
      )
      const previewId = randomUUID()
      this.previews.rememberLease(previewId, pointer, record.expiresAt)
      return {
        previewId,
        projectKey: record.receipt.projectKey,
        sessionKey: pointer.sessionFile,
        sessionId: pointer.sessionId,
        sessionName: pointer.sessionName,
        conversation: {
          entries: entries.slice(startIndex),
          startIndex,
          activeRunStartIndex: null
        }
      }
    } finally {
      handle.release()
    }
  }

  async reorderProjects(projectKeys: string[]): Promise<void> {
    const projects = this.state.projects.filter((workspace) => workspaceKind(workspace) === 'project')
    const tasks = this.state.projects.filter((workspace) => workspaceKind(workspace) === 'task')
    const currentKeys = projects.map(({ path }) => path)
    assertStrictPermutation(currentKeys, projectKeys, 'project')
    await this.persistProjectOrder(projectKeys)
    const projectsByKey = new Map(projects.map((project) => [project.path, project]))
    this.state = {
      ...this.state,
      projects: [
        ...projectKeys.map((key) => ({ ...projectsByKey.get(key)! })),
        ...tasks.map((task) => ({ ...task }))
      ]
    }
    this.emitState()
  }

  async resumeSession(): Promise<void> {
    if (this.state.activeSessionKey === null) {
      throw new Error('No active session is available for this project.')
    }
    await this.activateSession(this.state.activeSessionKey)
  }

  private requireForkTarget(): ForkTarget {
    const runtime = this.requireRuntime('ready')
    if (!this.state.session.settled) throw new Error('Session must be settled before fork.')
    const project = configuredProject(this.state)
    if (workspaceKind(project) === 'task') {
      throw new Error('Task sessions cannot be forked into the same isolated workspace.')
    }
    const sessionKey = this.state.activeSessionKey
    if (sessionKey === null) throw new Error('Fork requires an active persisted session.')
    const pointer = this.sessionPointers.find((candidate) =>
      candidate.projectPath === project.path && candidate.sessionFile === sessionKey
    )
    if (pointer === undefined) throw new Error('Fork requires an active persisted session.')
    const context = this.activeContext
    if (
      context === null ||
      context.runtime !== runtime ||
      this.contextBySessionKey.get(contextKey(project.path, sessionKey)) !== context
    ) {
      throw new Error('Active runtime context is unavailable.')
    }
    this.assertContextNotCompacting(context, 'Fork')
    return { projectPath: project.path, pointer: { ...pointer }, runtime, context }
  }

  private assertForkTarget(target: ForkTarget): void {
    this.assertLaunchActive()
    if (
      this.state.runtime.status !== 'ready' ||
      !this.state.session.settled ||
      this.state.activeProjectKey !== target.projectPath ||
      this.state.activeSessionKey !== target.pointer.sessionFile ||
      this.runtime !== target.runtime ||
      this.activeContext !== target.context ||
      this.contextBySessionKey.get(
        contextKey(target.projectPath, target.pointer.sessionFile)
      ) !== target.context ||
      target.context.state.session.compaction !== null ||
      (
        target.context.compactionLifecycle !== null &&
        !target.context.compactionLifecycle.settled
      ) ||
      !this.sessionPointers.some((pointer) =>
        pointer.projectPath === target.pointer.projectPath &&
        pointer.sessionFile === target.pointer.sessionFile &&
        pointer.sessionId === target.pointer.sessionId
      )
    ) {
      throw new Error('Fork cancelled because the active session changed.')
    }
  }

  private assertContextNotCompacting(context: RuntimeContext, operation: string): void {
    if (
      context.state.session.compaction !== null ||
      (context.compactionLifecycle !== null && !context.compactionLifecycle.settled)
    ) {
      throw new Error(`${operation} is unavailable while compaction is in progress.`)
    }
  }

  private assertRegisteredProject(projectPath: string): void {
    if (!isAbsolute(projectPath)) {
      throw new Error(`Project path must be absolute: ${projectPath}`)
    }
    if (!this.state.projects.some(({ path }) => path === projectPath)) {
      throw new Error(`Project is not registered: ${projectPath}`)
    }
  }

  private assertInactiveRuntimeReclaimTarget(
    projectPath: string,
    sessionKey: string,
    context: RuntimeContext
  ): void {
    const blocker = this.hibernation.blockReason(projectPath, sessionKey, context)
    if (blocker !== null) throw new Error(blocker)
  }

  private async failForkedContext(
    context: RuntimeContext,
    previousState: KernelState,
    error: unknown
  ): Promise<unknown> {
    let cleanupError: unknown = null
    try {
      await this.stopContext(context)
    } catch (caught) {
      cleanupError = caught
    }
    const failure = cleanupError === null
      ? error
      : new Error(
          `${errorMessage(error)} Cleanup failed while stopping forked runtime: ${errorMessage(cleanupError)}`,
          { cause: error }
        )
    this.activeContext = null
    this.state = {
      ...previousState,
      runtime: toKernelRuntime('crashed', context.runtime.getState(), errorMessage(failure))
    }
    this.emitState()
    return failure
  }

  private requireArchiveUndoRecord(token: string): ArchiveUndoRecord {
    if (token.trim().length === 0) throw new Error('Archive undo token must not be empty.')
    const record = this.archiveUndoByToken.get(token)
    if (record === undefined) throw new Error('Archive undo credential is invalid or already used.')
    if (this.now() >= record.expiresAt) {
      this.archiveUndoByToken.delete(token)
      throw new Error('Archive undo credential has expired.')
    }
    if (this.state.activeProjectKey !== record.receipt.projectKey) {
      throw new Error('Archive undo credential does not belong to the active project.')
    }
    return record
  }

  private beginLaunch(task: () => Promise<void>): Promise<void> {
    if (this.shutdownRequested) throw new Error('Runtime shutdown is in progress.')
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
    if (this.stopAllRequested) throw new Error('Runtime start cancelled.')
  }

  private assertReloadTarget(
    projectPath: string,
    pointer: SessionPointer,
    target: RuntimeContext
  ): void {
    if (this.state.runtime.status !== 'ready') {
      throw new Error(`Runtime must be ready; current status is ${this.state.runtime.status}.`)
    }
    if (!this.state.session.settled) throw new Error('Session must be settled before reload.')
    if (
      this.state.activeProjectKey !== projectPath ||
      this.state.activeSessionKey !== pointer.sessionFile ||
      !this.sessionPointers.some((candidate) =>
        candidate.projectPath === projectPath &&
        candidate.sessionFile === pointer.sessionFile &&
        candidate.sessionId === pointer.sessionId
      )
    ) {
      throw new Error('Reload requires an active persisted session.')
    }
    if (this.activeContext !== target || this.runtime !== target.runtime) {
      throw new Error('Active runtime context is unavailable.')
    }
  }

  private async launch(
    project: { path: string },
    launchOptions: { sessionFile?: string, projectTrust?: boolean },
    expectedSessionId?: string,
    projectTrustPreflighted = false,
    persistSessionActivation = true
  ): Promise<void> {
    this.assertLaunchActive()
    const projectTrust = projectTrustPreflighted
      ? launchOptions.projectTrust
      : await this.preflightProjectTrust(project.path)
    this.assertLaunchActive()
    const resolvedLaunchOptions = projectTrust === undefined
      ? launchOptions
      : { ...launchOptions, projectTrust }
    const restartContinuation = launchOptions.sessionFile === undefined
      ? undefined
      : [...this.restartContinuations.values()].find(
          (candidate) => candidate.projectPath === project.path &&
            candidate.sessionFile === launchOptions.sessionFile
        )
    let claimedRestartContinuation: RestartContinuationCandidate | null = null
    if (restartContinuation !== undefined) {
      if (expectedSessionId !== restartContinuation.sessionId) {
        throw new Error('Restart continuation identity does not match the requested Session.')
      }
      await this.claimRestartContinuation(restartContinuation.id)
      this.restartContinuations.delete(restartContinuation.id)
      claimedRestartContinuation = restartContinuation
    }

    try {
    const previousContext = this.activeContext
    const previousState = copyState(this.state)
    this.captureActiveContext()
    const runtime = this.createRuntime(project, {
      ...resolvedLaunchOptions,
      subagent: copySubagentSettings(this.state.subagent),
      fastExtensionLoading: this.state.general.fastExtensionLoading
    })
    const context = this.collaboration.createContext(project.path, runtime, runtimeSessionState(this.state))
    this.contexts.add(context)
    this.contextByRuntime.set(runtime, context)
    if (launchOptions.sessionFile !== undefined) {
      this.contextBySessionKey.set(contextKey(project.path, launchOptions.sessionFile), context)
    }
    context.unsubscribeRuntime = runtime.subscribe((event) => {
      this.handleContextEvent(context, event)
    })
    this.loadContext(context)

    this.state = {
      ...this.state,
      activeSessionKey: launchOptions.sessionFile === undefined ? null : this.state.activeSessionKey,
      commands: createCommandCatalog(),
      advisor: { ...UNAVAILABLE_ADVISOR_STATE },
      availableModels: [],
      ...(launchOptions.sessionFile === undefined
        ? {
            session: { ...INITIAL_SESSION_STATE },
            conversation: { entries: [], startIndex: 0, activeRunStartIndex: null }
          }
        : {})
    }
    this.state = { ...this.state, runtime: toKernelRuntime('starting', runtime.getState()) }
    this.emitState()
    const startupBeganAt = Date.now()
    try {
      await runtime.start()
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
      const sessionFile = stringValue(stateResult.state.sessionFile)
      if (sessionFile === null || !isAbsolute(sessionFile)) {
        throw new Error('Runtime did not return an absolute session file.')
      }
      let session = toKernelSession(stateResult.state, true, null, false)
      if (session.id === null || session.id.length === 0) {
        throw new Error('Runtime did not return a session ID.')
      }
      if (expectedSessionId !== undefined && session.id !== expectedSessionId) {
        throw new Error(
          `Resumed session ID mismatch: expected ${expectedSessionId}, received ${session.id}.`
        )
      }
      if (launchOptions.sessionFile !== undefined && sessionFile !== launchOptions.sessionFile) {
        throw new Error(
          `Resumed session file mismatch: expected ${launchOptions.sessionFile}, received ${sessionFile}.`
        )
      }
      const pointer: SessionPointer = {
        projectPath: project.path,
        sessionFile,
        sessionId: session.id,
        sessionName: session.name
      }
      context.state = runtimeSessionState(this.state)
      const messagesResult = await runtime.send({ type: 'get_messages' })
      this.assertStartActive(runtime)
      if (messagesResult.type !== 'messages') {
        throw new Error('Runtime returned an invalid startup projection.')
      }
      let projectedMessages = projectMessages(messagesResult.messages)
      const commandsResult = await runtime.send({ type: 'get_commands' })
      this.assertStartActive(runtime)
      if (commandsResult.type !== 'commands') {
        throw new Error('Runtime returned an invalid command catalog.')
      }
      const provisionalCommands = createCommandCatalog(commandsResult.commands)
      const entriesResult = await runtime.send({ type: 'get_entries' })
      this.assertStartActive(runtime)
      if (entriesResult.type !== 'entries') {
        throw new Error('Runtime returned invalid session entries.')
      }
      const activeSessionEntries = sessionEntriesOnActivePath(
        entriesResult.entries,
        entriesResult.leafId
      )
      const projectedSessionEntries = projectSessionEntries(activeSessionEntries)
      const startupExtensionEntries = this.state.conversation.entries.filter(
        (entry): entry is KernelExtensionStatusEntry =>
          entry.kind === 'extension-status' &&
          entry.id === 'extension-status:magic-context' &&
          entry.timestamp >= startupBeganAt
      )
      const openAiFastMode = openAiFastModeFromSessionEntries(activeSessionEntries)
      projectedMessages = mergeConversationEntries(projectedMessages, projectedSessionEntries)
      projectedMessages = mergeConversationEntries(projectedMessages, startupExtensionEntries)
      const advisor = projectAdvisorState(entriesResult.entries)
      const availableModelsResult = await runtime.send({ type: 'get_available_models' })
      this.assertStartActive(runtime)
      if (availableModelsResult.type !== 'available-models') {
        throw new Error('Runtime returned an invalid model catalog.')
      }
      const availableModels = availableModelsResult.models.map(toAvailableKernelModel)
      const statisticsResult = await runtime.send({ type: 'get_session_stats' })
      this.assertStartActive(runtime)
      if (statisticsResult.type !== 'session-statistics') {
        throw new Error('Runtime returned invalid session statistics.')
      }
      assertSessionStatisticsIdentity(statisticsResult.statistics, sessionFile, session.id)
      const statistics = toKernelSessionStatistics(statisticsResult.statistics)
      session = toKernelSession(
        stateResult.state,
        true,
        toKernelSessionUsage(statisticsResult.statistics, stateResult.state.model?.contextWindow),
        openAiFastMode
      )
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
        context.provisionalSession = {
          runtime,
          pointer,
          initialPrompt: null,
          sessionNameAttempted: false,
          activityAt: this.now()
        }
        this.contextBySessionKey.set(contextKey(project.path, pointer.sessionFile), context)
        this.state = {
          ...this.state,
          // Workspace identity only: still not written to the XDG session index or
          // exposed in the Project's Navigator list until the first prompt is accepted.
          activeSessionKey: pointer.sessionFile,
          commands: provisionalCommands,
          advisor,
          availableModels,
          runtime: toKernelRuntime('ready', runtime.getState()),
          session: { ...session, resumeAvailable: false },
          conversation: {
            entries: projectedMessages,
            startIndex: 0,
            activeRunStartIndex: null
          }
        }
        this.state = { ...this.state, sessions: this.toSessionSummaries() }
        this.emitState()
        return
      }
      this.assertStartActive(runtime)
      if (this.readSessionMessagesTailFirst !== undefined) {
        const transcript = await this.readSessionMessagesTailFirst(canonicalPointer, {
          onTail: () => undefined
        })
        this.assertStartActive(runtime)
        projectedMessages = mergeConversationEntries(
          mergeConversationEntries(
            projectTranscriptMessages(transcript.messages),
            projectedSessionEntries
          ),
          startupExtensionEntries
        )
      }
      context.launchCommitting = true
      try {
        if (persistSessionActivation) await this.persistSession(canonicalPointer)
        this.assertStartActive(runtime)
        this.sessionPointers = upsertSessionPointer(this.sessionPointers, canonicalPointer)
        await this.captureSessionMetadata(canonicalPointer, statistics)
        this.assertStartActive(runtime)
        const commands = createCommandCatalog(commandsResult.commands, true)
        this.state = {
          ...this.state,
          sessions: this.toSessionSummaries(),
          activeSessionKey: canonicalPointer.sessionFile,
          commands,
          advisor,
          availableModels,
          runtime: toKernelRuntime('ready', runtime.getState()),
          session,
          conversation: {
            entries: projectedMessages,
            startIndex: 0,
            activeRunStartIndex: null
          }
        }
        if (
          launchOptions.sessionFile !== undefined &&
          launchOptions.sessionFile !== canonicalPointer.sessionFile &&
          this.contextBySessionKey.get(contextKey(project.path, launchOptions.sessionFile)) === context
        ) {
          this.contextBySessionKey.delete(contextKey(project.path, launchOptions.sessionFile))
        }
        this.contextBySessionKey.set(contextKey(project.path, canonicalPointer.sessionFile), context)
        this.naming.queue(
          context,
          canonicalPointer,
          firstUserMessage(projectedMessages)
        )
        this.emitState()
        this.naming.begin(context)
        if (claimedRestartContinuation !== null) {
          await this.prompt(RESTART_CONTINUATION_PROMPT, [], canonicalPointer.sessionFile)
        }
      } finally {
        context.launchCommitting = false
      }
    } catch (error) {
      if (!this.isStartActive(runtime)) {
        throw new Error('Runtime start cancelled.')
      }
      const launchError = await this.cleanupFailedLaunch(runtime, error)
      const retained = this.contextByRuntime.get(runtime)
      if (retained !== undefined) {
        // Stop failed: ownership/subscription retained and context marked crashed.
        if (previousContext !== null && this.contexts.has(previousContext) && previousContext !== retained) {
          this.publishRetainedLaunchCrash(retained, launchError)
          this.loadContext(previousContext)
        } else {
          this.activeContext = retained
          this.state = {
            ...this.state,
            runtime: retained.state.runtime
          }
        }
        this.emitState()
        throw launchError
      }
      const failedRuntime = toKernelRuntime('crashed', runtime.getState(), errorMessage(launchError))
      if (previousContext !== null && this.contexts.has(previousContext)) {
        this.loadContext(previousContext)
      } else {
        this.activeContext = null
        this.state = { ...previousState, runtime: failedRuntime }
      }
      this.emitState()
      throw launchError
    }
    } finally {
      if (
        claimedRestartContinuation !== null &&
        typeof this.completeRestartContinuation === 'function'
      ) {
        try {
          await this.completeRestartContinuation(claimedRestartContinuation.id)
        } catch {
          // The durable claim already prevents replay; cleanup is best effort.
        }
      }
    }
  }

  private async cleanupFailedLaunch(runtime: RuntimeHost, error: unknown): Promise<unknown> {
    const context = this.contextByRuntime.get(runtime)
    let cleanupError: unknown = null
    try {
      await runtime.stop()
    } catch (caught) {
      cleanupError = caught
    }

    if (cleanupError !== null) {
      // Retain maps + subscription until a later stop succeeds. Clear stopRequested so
      // activate/stop can retry cleanup on the still-owned Context.
      if (context !== undefined) {
        context.stopRequested = false
        context.state = {
          ...context.state,
          runtime: toKernelRuntime(
            'crashed',
            runtime.getState(),
            `${errorMessage(error)} Cleanup failed while stopping runtime: ${errorMessage(cleanupError)}`
          )
        }
      }
      return new Error(
        `${errorMessage(error)} Cleanup failed while stopping runtime: ${errorMessage(cleanupError)}`,
        { cause: error }
      )
    }

    // Stop succeeded: only now drop the runtime subscription and ownership maps.
    context?.unsubscribeRuntime?.()
    if (context !== undefined) {
      context.unsubscribeRuntime = null
      this.contexts.delete(context)
      this.contextByRuntime.delete(runtime)
      for (const [key, candidate] of this.contextBySessionKey) {
        if (candidate === context) this.contextBySessionKey.delete(key)
      }
      if (this.activeContext === context) this.activeContext = null
    }
    return error
  }

  private publishRetainedLaunchCrash(context: RuntimeContext, failure: unknown): void {
    const navigationBefore = this.projectNavigationState(context.projectPath)
    context.stopRequested = false
    context.state = {
      ...context.state,
      runtime: toKernelRuntime('crashed', context.runtime.getState(), errorMessage(failure))
    }
    this.publishContextState(context, navigationBefore, 'snapshot')
  }

  async prompt(
    message: string,
    attachments: readonly KernelPromptAttachment[] = [],
    expectedSessionKey?: string
  ): Promise<void> {
    if (
      expectedSessionKey !== undefined &&
      this.activeContext?.state.activeSessionKey !== expectedSessionKey
    ) {
      throw new Error('The active Session changed before prompt submission.')
    }
    const runtime = this.requireRuntime('ready')
    const context = this.activeContext!
    this.touchWarmUse(context)
    if (message.trim().length === 0 && attachments.length === 0) {
      throw new Error('Prompt must not be empty.')
    }
    const materialized = materializePrompt(message, attachments)
    const provisional = context.provisionalSession?.runtime === runtime &&
      context.provisionalSession.initialPrompt === null
      ? context.provisionalSession
      : null
    if (provisional !== null) {
      provisional.initialPrompt = message.trim().length > 0
        ? message
        : attachments.map((attachment) => attachment.name).join(', ')
    }

    const navigationBefore = this.projectNavigationState(context.projectPath)
    context.state = {
      ...context.state,
      runtime: toKernelRuntime('running', runtime.getState()),
      session: { ...context.state.session, settled: false },
      conversation: beginConversationRun(context.state.conversation)
    }
    this.publishContextState(context, navigationBefore, 'snapshot')
    try {
      await runtime.send({
        type: 'prompt',
        message: materialized.message,
        ...(materialized.images.length === 0 ? {} : { images: materialized.images })
      })
      if (!this.contexts.has(context) || context.stopRequested) return
      if (
        provisional !== null &&
        context.provisionalSession === provisional &&
        provisional.initialPrompt !== null &&
        !provisional.sessionNameAttempted
      ) {
        provisional.sessionNameAttempted = true
        this.naming.queue(context, provisional.pointer, provisional.initialPrompt)
      }
      this.naming.begin(context)
    } catch (error) {
      const navigationBeforeFailure = this.projectNavigationState(context.projectPath)
      if (provisional !== null && context.provisionalSession === provisional) {
        provisional.initialPrompt = null
      }
      if (this.contexts.has(context) && !context.stopRequested && context.state.runtime.status === 'running') {
        context.state = {
          ...context.state,
          runtime: toKernelRuntime('ready', runtime.getState(), errorMessage(error)),
          session: { ...context.state.session, settled: true },
          conversation: settleConversationRun(context.state.conversation)
        }
        this.publishContextState(context, navigationBeforeFailure, 'snapshot')
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
    if (this.activeContext !== null) this.touchWarmUse(this.activeContext)
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
    if (this.activeContext !== null) this.touchWarmUse(this.activeContext)
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

  async setOpenAiFastMode(enabled: boolean): Promise<void> {
    if (typeof enabled !== 'boolean') throw new Error('OpenAI Fast mode must be a boolean.')
    const runtime = this.requireRuntime('ready')
    const context = this.activeContext
    if (context === null || context.runtime !== runtime) {
      throw new Error('Active runtime context is unavailable.')
    }
    if (this.state.session.openAiFastMode === enabled) return

    await this.applyOpenAiFastMode(runtime, enabled)
    if (this.activeContext !== context || this.runtime !== runtime) {
      throw new Error('OpenAI Fast mode update cancelled because the active session changed.')
    }
    this.state = {
      ...this.state,
      session: { ...this.state.session, openAiFastMode: enabled }
    }
    this.emitState()
  }

  async setSessionNaming(settings: SessionNamingSettings): Promise<void> {
    if (!isSessionNamingSettings(settings)) throw new Error('Invalid session naming settings.')
    if (sameSessionNamingSettings(this.state.sessionNaming, settings)) return
    if (settings.mode === 'model' && !this.state.availableModels.some((model) =>
      model.provider === settings.provider && model.id === settings.modelId
    )) {
      throw new Error(`Session naming model is not currently available: ${settings.provider}/${settings.modelId}`)
    }

    const nextSettings = copySessionNamingSettings(settings)
    await this.persistSessionNaming(nextSettings)
    this.naming.cancel()
    this.state = { ...this.state, sessionNaming: nextSettings }
    this.emitState()

    const context = this.activeContext
    const activePointer = this.sessionPointers.find((pointer) =>
      pointer.sessionFile === this.state.activeSessionKey
    )
    if (
      context !== null &&
      this.state.runtime.status === 'ready' &&
      this.state.session.name === null &&
      activePointer !== undefined
    ) {
      this.naming.queue(
        context,
        activePointer,
        firstUserMessage(this.state.conversation.entries)
      )
      this.naming.begin(context)
    }
  }

  async setAppearance(settings: AppearanceSettings): Promise<void> {
    if (!isAppearanceSettings(settings)) throw new Error('Invalid appearance settings.')
    if (sameAppearanceSettings(this.state.appearance, settings)) return
    const nextSettings = copyAppearanceSettings(settings)
    await this.persistAppearance(nextSettings)
    this.state = { ...this.state, appearance: nextSettings }
    this.emitState()
  }

  async setGeneral(settings: GeneralSettings): Promise<void> {
    if (!isGeneralSettingsUpdate(settings)) throw new Error('Invalid general settings.')
    if (sameGeneralSettings(this.state.general, settings)) return
    const nextSettings = copyGeneralSettings(settings)
    await this.persistGeneral(nextSettings)
    this.state = { ...this.state, general: nextSettings }
    this.emitState()
  }

  async setSubagent(settings: SubagentSettings): Promise<void> {
    if (!isSubagentSettings(settings)) throw new Error('Invalid subagent settings.')
    if (sameSubagentSettings(this.state.subagent, settings)) return
    const nextSettings = copySubagentSettings(settings)
    await this.persistSubagent(nextSettings)
    this.state = { ...this.state, subagent: nextSettings }
    this.emitState()
  }

  async setShortcuts(settings: ShortcutSettings): Promise<void> {
    if (!isShortcutSettings(settings)) throw new Error('Invalid shortcut settings.')
    if (sameShortcutSettings(this.state.shortcuts, settings)) return
    const nextSettings = copyShortcutSettings(settings)
    await this.persistShortcuts(nextSettings)
    this.state = { ...this.state, shortcuts: nextSettings }
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
    if (command.id === RELOAD_SESSION_COMMAND_ID) {
      assertNoCommandArgument(command, argument)
      await this.reloadSession()
      // New Runtime context after reload; echo on the reloaded session view.
      this.appendCommandEcho(command, argument)
      return
    }
    if (
      command.id === FORK_SESSION_COMMAND_ID ||
      command.id === EXPORT_SESSION_COMMAND_ID ||
      command.id === COPY_LAST_ANSWER_COMMAND_ID
    ) {
      assertNoCommandArgument(command, argument)
      throw new Error(`GUI command must be handled by the renderer: ${command.name}`)
    }
    if (command.id === SET_MODEL_COMMAND_ID) {
      const { provider, modelId } = parseModelArgument(argument)
      await this.setModel(provider, modelId)
      this.appendCommandEcho(command, argument)
      return
    }
    if (command.id === SET_THINKING_COMMAND_ID) {
      const level = thinkingLevel(argument.trim())
      if (level === null) {
        throw new Error('Thinking level must be off, minimal, low, medium, high, xhigh, or max.')
      }
      await this.setThinkingLevel(level)
      this.appendCommandEcho(command, argument)
      return
    }
    if (command.id === COMPACT_COMMAND_ID) {
      const runtime = this.requireRuntime('ready')
      const context = this.contextByRuntime.get(runtime)
      if (context === undefined) throw new Error('Active runtime context is unavailable.')
      const previousRevision = context.compactionRevision
      const customInstructions = argument.trim()
      await runtime.send({
        type: 'compact',
        ...(customInstructions.length === 0 ? {} : { customInstructions })
      })
      const lifecycle = context.compactionLifecycle
      if (lifecycle === null || lifecycle.revision <= previousRevision) {
        throw new Error('Runtime did not emit a compaction lifecycle.')
      }
      await lifecycle.promise
      // Echo ownership is fixed to the originating context, not whichever Session is active.
      this.appendCommandEchoToContext(context, command, argument)
      return
    }
    if (command.id === SET_SESSION_NAME_COMMAND_ID) {
      const name = argument.trim()
      if (name.length === 0) throw new Error('Session name must not be empty.')
      const runtime = this.requireRuntime('ready')
      this.naming.cancel(runtime)
      await runtime.send({ type: 'set_session_name', name })
      await this.refreshRenamedSession(runtime)
      this.appendCommandEcho(command, argument)
      return
    }

    if (command.source === 'extension') {
      assertAdaptedExtensionCommandArgument(command, argument)
    }
    const originatingContext = this.activeContext
    await this.invokePiCommand(command, argument)
    if (command.source === 'extension' && originatingContext !== null) {
      this.appendCommandEchoToContext(originatingContext, command, argument)
    }
  }

  private appendCommandEcho(command: KernelCommandDescriptor, argument: string): void {
    const context = this.activeContext
    if (context === null) return
    this.appendCommandEchoToContext(context, command, argument)
  }

  /**
   * Append a Timeline command echo to a specific RuntimeContext.
   * If that context is still active, publish normally; if inactive, update only
   * context.commandEntries / context.state Conversation silently. If the context
   * has been removed/replaced, append nothing.
   */
  private appendCommandEchoToContext(
    context: RuntimeContext,
    command: KernelCommandDescriptor,
    argument: string
  ): void {
    if (!this.contexts.has(context)) return
    if (
      context.state.runtime.status !== 'ready' &&
      context.state.runtime.status !== 'running'
    ) return

    const trimmed = argument.trim()
    const entry: KernelCommandEntry = {
      id: `command:${randomUUID()}`,
      kind: 'command',
      commandId: command.id,
      name: command.name,
      argument: trimmed,
      source: command.source,
      text: trimmed.length === 0 ? `/${command.name}` : `/${command.name} ${trimmed}`,
      timestamp: Date.now()
    }
    context.commandEntries = [...context.commandEntries, entry]
    context.state = {
      ...context.state,
      conversation: {
        ...context.state.conversation,
        entries: [...context.state.conversation.entries, entry]
      }
    }
    this.publishContextState(context, null, 'snapshot')
  }

  private async invokePiCommand(command: KernelCommandDescriptor, argument: string): Promise<void> {
    if (command.source !== 'extension' && command.source !== 'prompt' && command.source !== 'skill') {
      throw new Error(`Command has no execution path: ${command.id}`)
    }
    const runtime = this.requireRuntime('ready')
    if (command.source === 'extension') {
      const context = this.activeContext
      if (context === null || context.runtime !== runtime) {
        throw new Error('Active Runtime context is unavailable.')
      }
      if (context.extensionCommandInvocation !== null) {
        throw new Error(`Extension command is already running: /${context.extensionCommandInvocation.name}`)
      }
      const invocation = { id: randomUUID(), name: command.name, active: true }
      context.extensionCommandInvocation = invocation
      try {
        const result = await runtime.send({
          type: 'invoke_extension_command',
          name: command.name,
          invocationId: invocation.id,
          ...(argument.trim().length === 0 ? {} : { args: argument.trim() })
        })
        if (result.type !== 'accepted') {
          throw new Error(`Runtime did not accept Extension command: /${command.name}`)
        }
      } finally {
        invocation.active = false
        if (context.extensionCommandInvocation === invocation) {
          context.extensionCommandInvocation = null
        }
      }
      return
    }
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
      const context = this.activeContext!
      const navigationBefore = this.projectNavigationState(context.projectPath)
      context.state = this.withContextSessionActivity(context, {
        ...context.state,
        runtime: toKernelRuntime('ready', runtime.getState()),
        session: toKernelSession(
          stateResult.state,
          this.state.session.resumeAvailable,
          this.state.session.usage,
          this.state.session.openAiFastMode
        ),
        conversation: settleConversationRun(this.state.conversation)
      })
      this.publishContextState(context, navigationBefore, 'snapshot')
    }
  }

  async stop(): Promise<void> {
    this.previews.cancelActive()
    this.sessionTranscriptPreparations?.clear()
    this.previews.clearLeases()
    if (this.pendingProjectTrust !== null) {
      this.stopAllRequested = true
      this.cancelPendingProjectTrust('Runtime start cancelled.')
    }
    if (this.activeContext?.launchCommitting) await this.waitForLaunchToSettle()
    const pendingCommits = [...this.contexts]
      .map((context) => context.provisionalCommit)
      .filter((commit): commit is Promise<void> => commit !== null)
    await Promise.all(pendingCommits)
    this.stopAllRequested = true
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
        advisor: { ...UNAVAILABLE_ADVISOR_STATE },
        runtime: toKernelRuntime('stopped', INITIAL_HOST_STATE)
      }
      this.emitState()
    }
    this.stopAllRequested = false
    if (firstError !== null) throw firstError
  }

  private async stopContext(context: RuntimeContext, hibernating = false): Promise<void> {
    await this.collaboration.stopContext(context, hibernating)
  }

  private retireContext(context: RuntimeContext, wasActive: boolean, navigationBeforeRemoval: ProjectNavigationState): void {
    this.contexts.delete(context)
    this.contextByRuntime.delete(context.runtime)
    for (const [key, candidate] of this.contextBySessionKey) {
      if (candidate === context) this.contextBySessionKey.delete(key)
    }
    if (wasActive) {
      this.activeContext = null
      this.state = projectRuntimeSessionState(this.state, context.state)
      this.clearUnregisteredActiveSessionKey()
      if (this.state.activeProjectKey === context.projectPath) {
        this.state = { ...this.state, sessions: this.toSessionSummaries() }
      }
      this.emitState()
    } else {
      // Context is gone; project-map navigation only (no inactive Conversation).
      this.publishProjectNavigationChange(context.projectPath, navigationBeforeRemoval)
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
      !this.stopAllRequested &&
      !this.activeContext?.stopRequested &&
      this.state.runtime.status !== 'stopping' &&
      this.state.runtime.status !== 'stopped' &&
      this.state.runtime.status !== 'crashed'
    )
  }

  private requireRuntime(status: RuntimeStatus): RuntimeHost {
    if (this.shutdownRequested) throw new Error('Runtime shutdown is in progress.')
    if (this.state.runtime.status !== status) {
      throw new Error(`Runtime must be ${status}; current status is ${this.state.runtime.status}.`)
    }
    if (this.runtime === null) throw new Error('Runtime is unavailable.')
    return this.runtime
  }

  private async applyOpenAiFastMode(runtime: RuntimeHost, enabled: boolean): Promise<void> {
    const result = await runtime.send({
      type: 'invoke_extension_command',
      name: OPENAI_FAST_MODE_COMMAND_NAME,
      args: buildOpenAiFastModeCommandArgs(enabled)
    })
    if (result.type !== 'accepted') {
      throw new Error('Runtime did not accept the OpenAI Fast mode update.')
    }
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
        this.state.session.usage,
        this.state.session.openAiFastMode
      )
    }
    this.emitState()
  }

  private requestSessionUsageRefresh(runtime: RuntimeHost): void {
    const context = this.contextByRuntime.get(runtime)
    if (context === undefined) return
    context.sessionUsageRefreshRequested = true
    if (context.sessionUsageRefreshInFlight) return
    context.sessionUsageRefreshInFlight = true
    void this.drainSessionUsageRefreshes(context)
  }

  private async drainSessionUsageRefreshes(context: RuntimeContext): Promise<void> {
    try {
      while (this.contexts.has(context) && context.sessionUsageRefreshRequested) {
        context.sessionUsageRefreshRequested = false
        await this.refreshSessionUsage(context)
      }
    } finally {
      context.sessionUsageRefreshInFlight = false
    }
  }

  private async refreshSessionUsage(context: RuntimeContext): Promise<void> {
    try {
      const result = await context.runtime.send({ type: 'get_session_stats' })
      if (result.type !== 'session-statistics') return
      if (
        !this.contexts.has(context) ||
        this.contextByRuntime.get(context.runtime) !== context
      ) return
      const contextState = context.state
      const sessionKey = contextState.activeSessionKey
      const sessionId = contextState.session.id
      if (
        sessionKey === null ||
        sessionId === null ||
        result.statistics.sessionId !== sessionId ||
        (
          result.statistics.sessionFile !== undefined &&
          result.statistics.sessionFile !== sessionKey
        )
      ) return
      const usage = toKernelSessionUsage(
        result.statistics,
        contextState.session.model?.contextWindow ?? undefined
      )
      const statistics = toKernelSessionStatistics(result.statistics)
      const currentStatisticsByKey =
        this.sessionStatisticsByProject.get(context.projectPath) ?? new Map()
      const usageChanged = !sameSessionUsage(contextState.session.usage, usage)
      const statisticsChanged = !sameSessionStatistics(
        currentStatisticsByKey.get(sessionKey) ?? null,
        statistics
      )
      if (!usageChanged && !statisticsChanged) return

      const navigationBefore = this.projectNavigationState(context.projectPath)
      if (statisticsChanged) {
        const statisticsByKey = new Map(currentStatisticsByKey)
        statisticsByKey.set(sessionKey, statistics)
        this.sessionStatisticsByProject.set(context.projectPath, statisticsByKey)
        if (this.state.activeProjectKey === context.projectPath) {
          this.sessionStatisticsByKey = statisticsByKey
        }
      }
      if (usageChanged) {
        context.state = { ...context.state, session: { ...context.state.session, usage } }
      }
      this.publishContextState(context, navigationBefore, 'snapshot')
    } catch {
      // Usage is supplementary telemetry; keep the conversation usable if it is unavailable.
    }
  }

  private async refreshRenamedSession(runtime: RuntimeHost): Promise<void> {
    const result = await runtime.send({ type: 'get_state' })
    if (result.type !== 'state') throw new Error('Runtime did not return session state.')
    const context = this.activeContext
    if (context === null || context.runtime !== runtime) return

    const session = toKernelSession(
      result.state,
      this.state.session.resumeAvailable,
      this.state.session.usage,
      this.state.session.openAiFastMode
    )
    const sessionFile = stringValue(result.state.sessionFile)
    if (session.id === null || sessionFile === null || !isAbsolute(sessionFile)) {
      throw new Error('Runtime did not return a valid session identity.')
    }
    const provisional = context.provisionalSession?.runtime === runtime
      ? context.provisionalSession
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
      if (context.provisionalSession !== provisional || this.runtime !== runtime) return
    }
    await this.persistSession(pointer)
    if (this.runtime !== runtime || (provisional !== null && context.provisionalSession !== provisional)) {
      return
    }

    this.sessionPointers = upsertSessionPointer(this.sessionPointers, pointer)
    await this.captureSessionMetadata(pointer)
    if (this.runtime !== runtime) return
    if (provisional !== null) {
      context.provisionalSession = null
      context.provisionalSettled = false
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
    if (this.shutdownRequested) throw new Error('Runtime shutdown is in progress.')
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

  private emitKernelEvent(event: KernelEvent): void {
    this.notifyListeners(event)
  }

  private beginContextProvisionalCommit(context: RuntimeContext): void {
    const provisional = context.provisionalSession
    if (
      !this.contexts.has(context) ||
      provisional === null ||
      provisional.runtime !== context.runtime ||
      context.provisionalCommit !== null
    ) {
      return
    }
    if (this.activeContext === context) this.captureActiveContext()
    const commit = this.commitContextProvisional(context, provisional)
    context.provisionalCommit = commit
    void commit.finally(() => {
      if (context.provisionalCommit === commit) context.provisionalCommit = null
    })
  }

  private async commitContextProvisional(
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
      // Metadata is fallible, so read it before the durable index write. Once
      // persistSession succeeds there are no remaining awaits before registry
      // reconciliation; durable and in-memory pointers cannot diverge.
      const { activityAt, statistics } = await this.readSessionMetadataForPointer(pointer)
      if (!this.contexts.has(context) || context.provisionalSession !== provisional) return
      await this.persistSession(pointer)

      const navigationBefore = this.projectNavigationState(context.projectPath)
      const pointers = upsertSessionPointer(
        this.sessionPointersByProject.get(context.projectPath) ?? [],
        pointer
      )
      const activities = new Map(
        this.sessionActivityByProject.get(context.projectPath) ?? []
      )
      const statisticsByKey = new Map(
        this.sessionStatisticsByProject.get(context.projectPath) ?? []
      )
      activities.set(pointer.sessionFile, activityAt)
      statisticsByKey.set(pointer.sessionFile, statistics)
      this.sessionPointersByProject.set(context.projectPath, pointers)
      this.sessionActivityByProject.set(context.projectPath, activities)
      this.sessionStatisticsByProject.set(context.projectPath, statisticsByKey)

      const stillOwned =
        this.contexts.has(context) && context.provisionalSession === provisional
      if (stillOwned) {
        const currentState = context.state
        const previousSessionKey = currentState.activeSessionKey
        if (
          typeof previousSessionKey === 'string' &&
          previousSessionKey !== pointer.sessionFile
        ) {
          this.toolImages.clearForSession(previousSessionKey)
        }
        for (const [key, candidate] of this.contextBySessionKey) {
          if (candidate === context) this.contextBySessionKey.delete(key)
        }
        this.contextBySessionKey.set(contextKey(context.projectPath, pointer.sessionFile), context)
        context.provisionalSession = null
        const settleDeferred = context.provisionalSettled
        let nextState: RuntimeSessionState = {
          ...currentState,
          activeSessionKey: pointer.sessionFile,
          session: {
            ...currentState.session,
            resumeAvailable: true,
            settled: settleDeferred ? true : currentState.session.settled,
            ...(settleDeferred
              ? {
                  pendingMessageCount: 0,
                  pendingSteeringMessages: [],
                  pendingFollowUpMessages: []
                }
              : {})
          },
          runtime: settleDeferred
            ? toKernelRuntime('ready', context.runtime.getState())
            : currentState.runtime,
          conversation: settleDeferred
            ? settleConversationRun(currentState.conversation)
            : currentState.conversation
        }
        if (settleDeferred) {
          nextState = this.withContextSessionActivity(context, nextState)
        }
        context.state = nextState
        context.provisionalSettled = false
        if (pointer.sessionName === null && provisional.initialPrompt !== null) {
          const existingPending = context.pendingSessionName
          if (
            existingPending !== null &&
            existingPending.runtime === context.runtime &&
            existingPending.sessionId === pointer.sessionId
          ) {
            existingPending.sessionFile = pointer.sessionFile
          } else if (!provisional.sessionNameAttempted) {
            provisional.sessionNameAttempted = true
            const pending = {
              runtime: context.runtime,
              sessionFile: pointer.sessionFile,
              sessionId: pointer.sessionId,
              userMessage: provisional.initialPrompt
            }
            context.pendingSessionName = pending
            if (
              context.state.runtime.status === 'ready' ||
              context.state.runtime.status === 'running'
            ) {
              this.naming.begin(context)
            }
          }
        }
      }
      if (this.state.activeProjectKey === context.projectPath) {
        this.sessionPointers = pointers
        this.sessionActivityAtByKey = activities
        this.sessionStatisticsByKey = statisticsByKey
      }
      if (stillOwned) {
        this.publishContextState(context, navigationBefore, 'snapshot')
        if (context.state.session.settled && context.state.session.id !== null) this.collaboration.ready(context.state.session.id)
      }
      else this.publishProjectNavigationChange(context.projectPath, navigationBefore)
    } catch (error) {
      if (!this.contexts.has(context) || context.provisionalSession !== provisional) return
      if (isEnoent(error)) {
        // File may not exist yet at message_end. If agent_settled already ran while this
        // commit was in flight, retry after the owning Context commit slot is cleared.
        if (context.provisionalSettled) {
          setTimeout(() => {
            if (
              !this.contexts.has(context) ||
              context.provisionalSession !== provisional ||
              context.provisionalCommit !== null
            ) return
            this.beginContextProvisionalCommit(context)
          }, 0)
        } else if (this.activeContext === context) {
          this.emitState()
        }
        return
      }
      const navigationBefore = this.projectNavigationState(context.projectPath)
      const currentState = context.state
      context.provisionalSession = null
      context.provisionalSettled = false
      let nextState = currentState
      if (
        nextState.activeSessionKey !== null &&
        !(this.sessionPointersByProject.get(context.projectPath) ?? []).some(
          (pointer) => pointer.sessionFile === nextState.activeSessionKey
        )
      ) {
        nextState = { ...nextState, activeSessionKey: null }
      }
      nextState = {
        ...nextState,
        runtime: toKernelRuntime('crashed', context.runtime.getState(), errorMessage(error))
      }
      context.state = nextState
      this.publishContextState(context, navigationBefore, 'snapshot')
    }
  }


  private cacheToolImagesFromEvent(
    context: RuntimeContext,
    state: RuntimeSessionState,
    event: PiRpcEvent
  ): void {
    if (event.type !== 'tool_execution_end') return
    const sessionKey = state.activeSessionKey
    const sessionId = state.session.id
    if (sessionKey === null || sessionId === null || !isAbsolute(sessionKey)) return
    if (
      !this.contexts.has(context) ||
      this.contextByRuntime.get(context.runtime) !== context
    ) return
    const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : null
    if (toolCallId === null || toolCallId.length === 0 || toolCallId.length > 256) return
    const toolName = typeof event.toolName === 'string' ? event.toolName : ''

    // A terminal event atomically replaces every cached partial/result image for the tool.
    const owner = { projectPath: context.projectPath, sessionId, sessionKey, toolCallId }
    this.toolImages.clearForTool(owner)
    if (isSubagentToolName(toolName)) return
    const tool = state.conversation.entries.find(
      (entry): entry is KernelToolEntry =>
        entry.kind === 'tool' && entry.toolCallId === toolCallId
    )
    if (
      tool === undefined ||
      (tool.status !== 'success' && tool.status !== 'error') ||
      isSubagentToolName(tool.name)
    ) return

    const content = typeof event.result === 'object' && event.result !== null && !Array.isArray(event.result)
      ? (event.result as { content?: unknown }).content
      : undefined
    const images = collectValidatedToolImages(content)
    if (images.length === 0) return

    this.toolImages.store(owner, context.runtime, images)
  }

  private readCachedToolImage(
    projectPath: string,
    context: RuntimeContext,
    sessionId: string | null,
    sessionKey: string,
    toolCallId: string,
    contentIndex: number
  ): KernelMessageImage {
    const now = this.now()
    this.toolImages.prune(now)
    if (
      sessionId === null ||
      this.state.activeProjectKey !== projectPath ||
      this.state.activeSessionKey !== sessionKey ||
      this.activeContext !== context ||
      !this.contexts.has(context) ||
      this.contextByRuntime.get(context.runtime) !== context ||
      this.contextBySessionKey.get(contextKey(projectPath, sessionKey)) !== context ||
      context.projectPath !== projectPath ||
      this.state.session.id !== sessionId ||
      !hasProjectedToolImage(this.state, sessionKey, toolCallId, contentIndex)
    ) {
      throw new Error('Tool image cache is no longer owned by the displayed Runtime session.')
    }
    const image = this.toolImages.read({ projectPath, sessionId, sessionKey, toolCallId }, contentIndex, context.runtime, now)
    if (image === null) throw new ToolResultMessageNotFoundError(toolCallId)
    return image
  }

  private deleteCachedToolImage(
    projectPath: string,
    sessionId: string | null,
    sessionKey: string,
    toolCallId: string,
    contentIndex: number
  ): void {
    if (sessionId === null) return
    this.toolImages.delete({ projectPath, sessionId, sessionKey, toolCallId }, contentIndex)
  }

  private findSessionPointerInRegistry(
    projectPath: string,
    sessionKey: string,
    sessionRegistry?: ProjectSessionRegistry
  ): SessionPointer | undefined {
    if (sessionRegistry === undefined) return undefined
    return matchingSessionRegistry({ path: projectPath }, sessionRegistry).sessions.find(
      (pointer) => pointer.sessionFile === sessionKey
    )
  }

  private async loadMessagesForImageLookup(
    projectPath: string,
    sessionKey: string
  ): Promise<unknown[]> {
    const context = this.contextBySessionKey.get(contextKey(projectPath, sessionKey)) ?? null
    if (context !== null) {
      const status = (this.activeContext === context ? this.state : context.state).runtime.status
      if (status === 'ready' || status === 'running') {
        const messagesResult = await context.runtime.send({ type: 'get_messages' })
        if (messagesResult.type !== 'messages') {
          throw new Error('Runtime did not return session messages for image lookup.')
        }
        if (
          this.contextBySessionKey.get(contextKey(projectPath, sessionKey)) !== context ||
          this.state.activeProjectKey !== projectPath
        ) {
          throw new Error('Message image lookup cancelled because the session changed.')
        }
        return messagesResult.messages
      }
    }

    if (typeof this.validateSession !== 'function' || typeof this.readSessionMessages !== 'function') {
      throw new Error('Message image lookup is unavailable.')
    }
    const storedPointer = this.sessionPointers.find((pointer) =>
      pointer.projectPath === projectPath && pointer.sessionFile === sessionKey
    )
    if (storedPointer === undefined) {
      throw new Error(`Session is not registered for the active project: ${sessionKey}`)
    }
    const pointer = await this.validateSession(storedPointer)
    const messages = await this.readSessionMessages(pointer)
    if (
      this.state.activeProjectKey !== projectPath ||
      !this.sessionPointers.some((candidate) =>
        candidate.projectPath === pointer.projectPath &&
        candidate.sessionFile === pointer.sessionFile &&
        candidate.sessionId === pointer.sessionId
      )
    ) {
      throw new Error('Message image lookup cancelled because the session changed.')
    }
    return messages
  }

  private async loadSessionActivities(
    pointers: SessionPointer[]
  ): Promise<Map<string, number | null>> {
    const entries = new Map<string, number | null>()
    for (const pointer of pointers) entries.set(pointer.sessionFile, await this.readSessionActivityAt(pointer))
    return entries
  }

  private async loadSessionMetadata(
    pointers: SessionPointer[]
  ): Promise<{
    activityAtByKey: Map<string, number | null>
    statisticsByKey: Map<string, KernelSessionStatistics | null>
  }> {
    const entries: Array<readonly [string, SessionMetadata]> = []
    for (const pointer of pointers) entries.push([pointer.sessionFile, await this.readSessionMetadataForPointer(pointer)])
    return {
      activityAtByKey: new Map(entries.map(([sessionFile, metadata]) => [
        sessionFile,
        metadata.activityAt
      ])),
      statisticsByKey: new Map(entries.map(([sessionFile, metadata]) => [
        sessionFile,
        metadata.statistics
      ]))
    }
  }

  private async readSessionMetadataForPointer(pointer: SessionPointer): Promise<SessionMetadata> {
    if (this.readSessionMetadata !== undefined) return this.readSessionMetadata(pointer)
    const [activityAt, statistics] = await Promise.all([
      this.readSessionActivityAt(pointer),
      this.readSessionStatistics(pointer)
    ])
    return { activityAt, statistics }
  }

  private async captureSessionMetadata(
    pointer: SessionPointer,
    knownStatistics?: KernelSessionStatistics
  ): Promise<void> {
    const metadata = knownStatistics === undefined
      ? await this.readSessionMetadataForPointer(pointer)
      : {
          activityAt: await this.readSessionActivityAt(pointer),
          statistics: knownStatistics
        }
    this.sessionActivityAtByKey.set(pointer.sessionFile, metadata.activityAt)
    this.sessionStatisticsByKey.set(pointer.sessionFile, metadata.statistics)
    this.sessionActivityByProject.set(pointer.projectPath, this.sessionActivityAtByKey)
    this.sessionStatisticsByProject.set(pointer.projectPath, this.sessionStatisticsByKey)
  }

  private toSessionSummaries(): KernelSessionSummary[] {
    const projectPath = this.state.activeProjectKey
    if (projectPath === null) return []
    return this.toSessionSummariesForProject(projectPath)
  }

  private projectNavigationState(projectPath: string): ProjectNavigationState {
    let busySessionCount = 0
    for (const context of this.contexts) {
      if (context.projectPath !== projectPath) continue
      const provisional = context.provisionalSession
      if (provisional?.runtime === context.runtime && provisional.initialPrompt === null) continue
      const status = this.activeContext === context
        ? this.state.runtime.status
        : context.state.runtime.status
      if (status === 'running' || status === 'stopping') busySessionCount += 1
    }
    return {
      busySessionCount,
      sessions: this.toSessionSummariesForProject(projectPath, false)
    }
  }

  private toSessionSummariesForProject(
    projectPath: string,
    includeEmptyProvisional = true
  ): KernelSessionSummary[] {
    const isActive = this.state.activeProjectKey === projectPath
    const pointers = isActive
      ? this.sessionPointers
      : this.sessionPointersByProject.get(projectPath) ?? []
    const activityAtByKey = isActive
      ? this.sessionActivityAtByKey
      : this.sessionActivityByProject.get(projectPath) ?? new Map<string, number | null>()
    const statisticsByKey = isActive
      ? this.sessionStatisticsByKey
      : this.sessionStatisticsByProject.get(projectPath) ??
        new Map<string, KernelSessionStatistics | null>()
    const registered = toKernelSessionSummaries(
      pointers,
      activityAtByKey,
      statisticsByKey,
      (sessionKey) => {
        const managed = this.contextBySessionKey.get(contextKey(projectPath, sessionKey))
        if (managed === undefined) return 'stopped'
        return this.activeContext === managed
          ? this.state.runtime.status
          : managed.state.runtime.status
      },
      (sessionKey) => this.sessionReloadRequired.has(contextKey(projectPath, sessionKey)),
      (sessionKey) => {
        const managed = this.contextBySessionKey.get(contextKey(projectPath, sessionKey))
        return managed !== undefined && (
          managed.askInteraction !== null ||
          (managed.state.extensionDialog !== null && managed.state.extensionDialog !== undefined)
        )
      }
    )
    return mergeProvisionalSessionSummaries(
      registered,
      this.provisionalSummariesForProject(
        projectPath,
        new Set(pointers.map((pointer) => pointer.sessionFile)),
        includeEmptyProvisional
      )
    )
  }

  private provisionalSummariesForProject(
    projectPath: string,
    registeredKeys: ReadonlySet<string>,
    includeEmpty: boolean
  ): KernelSessionSummary[] {
    const summaries: KernelSessionSummary[] = []
    for (const context of this.contexts) {
      if (context.projectPath !== projectPath) continue
      const provisional = context.provisionalSession
      if (provisional === null || (!includeEmpty && provisional.initialPrompt === null)) continue
      const sessionFile = provisional.pointer.sessionFile
      if (registeredKeys.has(sessionFile)) continue
      const runtimeStatus = this.activeContext === context
        ? this.state.runtime.status
        : context.state.runtime.status
      summaries.push({
        key: sessionFile,
        id: provisional.pointer.sessionId,
        name: provisional.pointer.sessionName,
        lastActivityAt: provisional.activityAt,
        runtimeStatus,
        awaitingUserInput: context.askInteraction !== null ||
          (context.state.extensionDialog !== null && context.state.extensionDialog !== undefined),
        provisional: true,
        statistics: null
      })
    }
    return summaries
  }

  private activeEmptyProvisionalContext(): RuntimeContext | null {
    const context = this.activeContext
    const provisional = context?.provisionalSession ?? null
    if (
      context === null ||
      provisional === null ||
      provisional.runtime !== context.runtime ||
      provisional.initialPrompt !== null ||
      context.provisionalCommit !== null
    ) return null
    return context
  }

  private async discardActiveEmptyProvisionalContext(): Promise<void> {
    const context = this.activeEmptyProvisionalContext()
    if (context !== null) await this.stopContext(context)
  }

  private clearUnregisteredActiveSessionKey(): void {
    const sessionKey = this.state.activeSessionKey
    if (sessionKey === null) return
    if (this.sessionPointers.some((pointer) => pointer.sessionFile === sessionKey)) return
    this.state = { ...this.state, activeSessionKey: null }
  }

  /** Opaque process-lifetime runtime id; no Session/Project/path encoding. */
  private allocateRuntimeId(): string {
    const id = `rt-${this.nextRuntimeId}`
    this.nextRuntimeId += 1
    return id
  }

  /** Monotonic Runtime generation bound into generation-fenced hibernate leases. */
  private allocateRuntimeGeneration(): number {
    const generation = this.nextRuntimeGeneration
    this.nextRuntimeGeneration += 1
    return generation
  }

  private touchWarmUse(context: RuntimeContext): void {
    context.lastWarmUseAt = this.now()
  }

  private async restartProjectTrust(
    workspace: KernelProjectState
  ): Promise<boolean | undefined | null> {
    if (workspaceKind(workspace) === 'task') return true
    const inspection = await this.projectTrust.inspect(workspace.path)
    return inspection.requiresDecision && inspection.decision === null ? null : undefined
  }

  private loadRestartRecoveryWorkspace(
    workspace: KernelProjectState,
    pointer: SessionPointer
  ): void {
    const shared = this.state
    this.captureActiveContext()
    this.activeContext = null
    this.sessionPointers = this.sessionPointersByProject.get(workspace.path) ?? []
    this.sessionActivityAtByKey =
      this.sessionActivityByProject.get(workspace.path) ?? new Map<string, number | null>()
    this.sessionStatisticsByKey =
      this.sessionStatisticsByProject.get(workspace.path) ??
      new Map<string, KernelSessionStatistics | null>()
    this.sessionActivityByProject.set(workspace.path, this.sessionActivityAtByKey)
    this.sessionStatisticsByProject.set(workspace.path, this.sessionStatisticsByKey)
    this.state = {
      ...initialKernelState(
        { projects: shared.projects, activeProjectKey: workspace.path },
        { sessions: this.sessionPointers, activeSessionKey: pointer.sessionFile },
        this.sessionActivityAtByKey,
        this.sessionStatisticsByKey,
        shared.sessionNaming,
        shared.appearance,
        shared.general,
        shared.subagent,
        shared.shortcuts,
        shared.extensions
      ),
      navigatorKind: workspaceKind(workspace)
    }
  }

  private restoreRestartRecoverySelection(selection: RestartRecoverySelection): void {
    const shared = this.state
    this.captureActiveContext()
    const managed = selection.activeProjectKey === null || selection.activeSessionKey === null
      ? null
      : this.contextBySessionKey.get(
          contextKey(selection.activeProjectKey, selection.activeSessionKey)
        ) ?? null
    if (managed !== null) {
      this.loadContext(managed)
      this.state = { ...this.state, navigatorKind: selection.navigatorKind }
      return
    }

    this.activeContext = null
    const workspace = selection.activeProjectKey === null
      ? null
      : shared.projects.find(({ path }) => path === selection.activeProjectKey) ?? null
    this.sessionPointers = workspace === null
      ? []
      : this.sessionPointersByProject.get(workspace.path) ?? []
    this.sessionActivityAtByKey = workspace === null
      ? new Map()
      : this.sessionActivityByProject.get(workspace.path) ?? new Map()
    this.sessionStatisticsByKey = workspace === null
      ? new Map()
      : this.sessionStatisticsByProject.get(workspace.path) ?? new Map()
    const activeSessionKey = selection.activeSessionKey !== null &&
      this.sessionPointers.some(({ sessionFile }) => sessionFile === selection.activeSessionKey)
      ? selection.activeSessionKey
      : null
    this.state = {
      ...initialKernelState(
        { projects: shared.projects, activeProjectKey: workspace?.path ?? null },
        { sessions: this.sessionPointers, activeSessionKey },
        this.sessionActivityAtByKey,
        this.sessionStatisticsByKey,
        shared.sessionNaming,
        shared.appearance,
        shared.general,
        shared.subagent,
        shared.shortcuts,
        shared.extensions
      ),
      navigatorKind: selection.navigatorKind
    }
  }

  private async discardRestartContinuation(
    candidate: RestartContinuationCandidate
  ): Promise<void> {
    try {
      await this.completeRestartContinuation(candidate.id)
      this.restartContinuations.delete(candidate.id)
    } catch {
      // A stale record is harmless; keep it pending if durable cleanup failed.
    }
  }

  private captureActiveContext(): void {
    const context = this.activeContext
    if (context === null) return
    context.state = runtimeSessionState(this.state)
    this.sessionPointersByProject.set(context.projectPath, this.sessionPointers)
    this.sessionActivityByProject.set(context.projectPath, this.sessionActivityAtByKey)
    this.sessionStatisticsByProject.set(context.projectPath, this.sessionStatisticsByKey)
  }

  private loadContext(context: RuntimeContext): void {
    this.activeContext = context
    this.sessionPointers = this.sessionPointersByProject.get(context.projectPath) ?? []
    this.sessionActivityAtByKey = this.sessionActivityByProject.get(context.projectPath) ?? new Map()
    this.sessionStatisticsByKey =
      this.sessionStatisticsByProject.get(context.projectPath) ?? new Map()
    this.state = {
      ...projectRuntimeSessionState(this.state, context.state),
      activeProjectKey: context.projectPath,
      sessions: []
    }
    this.state = { ...this.state, sessions: this.toSessionSummaries() }
  }

  private handleContextEvent(context: RuntimeContext, event: RuntimeHostEvent): void {
    if (!this.contexts.has(context)) return
    if (context.deferredEvents !== null) {
      context.deferredEvents.push(event)
      return
    }
    this.deliverContextEvent(context, event)
  }

  private deliverContextEvent(context: RuntimeContext, event: RuntimeHostEvent): void {
    if (!this.contexts.has(context)) return
    if (event.type === 'agent-collaboration-request') {
      this.collaboration.handleRequest(context, event)
      return
    }
    if (event.type === 'diagnostic' && event.kind !== 'stderr' && context.collaborationRunStartIndex !== undefined) context.collaborationRunError = event.message
    const previous = context.state
    const stopping = this.stopAllRequested || context.stopRequested || previous.runtime.status === 'stopping'
    if (event.type === 'pi-event') {
      if (!stopping && previous.runtime.status !== 'crashed') {
        this.handleContextPiEvent(context, event.event)
      }
      return
    }
    if (event.type === 'activity-started' || event.type === 'activity-settled') {
      if (stopping) return
      if (event.type === 'activity-started') {
        if (previous.runtime.status !== 'ready') return
        this.touchWarmUse(context)
      } else {
        if (previous.runtime.status !== 'running') return
        if (context.provisionalCommit !== null) {
          context.provisionalSettled = true
          return
        }
      }
    }

    const navigationBefore = event.type === 'diagnostic' && event.kind === 'stderr'
      ? null
      : this.projectNavigationState(context.projectPath)
    context.state = reduceRuntimeSessionEvent(previous, event, context.runtime.getState())
    if (event.type === 'activity-settled') {
      context.state = this.withContextSessionActivity(context, context.state)
      if (context.state.session.id !== null) this.collaboration.ready(context.state.session.id)
    }
    if (
      (event.type === 'process-exit' || (event.type === 'diagnostic' && event.kind === 'process')) &&
      !stopping && previous.runtime.status !== 'stopped'
    ) {
      const message = event.type === 'process-exit'
        ? formatExitError(event.code, event.signal)
        : event.message
      if (context.state.session.id !== null) this.collaboration.interrupted(context.state.session.id, message || 'Runtime terminated.')
      this.compaction.fail(context, message || 'Runtime process terminated during compaction.')
      this.naming.cancel(context.runtime)
      context.extensionCommandInvocation = null
      context.extensionDialogInteraction = null
      context.state = {
        ...context.state,
        extensionDialog: null,
        runtime: { ...context.state.runtime, status: 'crashed', lastError: message }
      }
    }
    this.publishContextState(context, navigationBefore)
  }

  private handleContextPiEvent(context: RuntimeContext, event: PiRpcEvent): void {
    if (event.type === 'extension_ui_request') {
      if (this.interactions.handleAskUiRequest(context, event)) return
      if (this.interactions.handleExtensionDialogRequest(context, event)) return
      this.interactions.cancelUnsupportedExtensionUiRequest(context, event)
    }
    const askNavigationBefore = this.interactions.clearAskInteractionForEvent(context, event)
    if (event.type === 'compaction_start') {
      this.compaction.started(context, event)
      return
    }
    if (event.type === 'compaction_end') {
      this.compaction.ended(context, event)
      return
    }
    if (event.type === 'agent_settled' && context.provisionalSession !== null) {
      this.collaboration.settled(context)
      context.provisionalSettled = true
      this.beginContextProvisionalCommit(context)
      return
    }

    // Ordinary streaming needs no navigation scan. Only bounded summary changes
    // can publish background state; foreground Conversation patches stay incremental.
    const namingInFlight = context.sessionNameOperation !== null
    const navigationBefore = askNavigationBefore ?? (
      event.type === 'agent_start' || event.type === 'agent_settled' ||
      (event.type === 'session_info_changed' && typeof event.name === 'string' && !namingInFlight)
        ? this.projectNavigationState(context.projectPath)
        : null
    )
    const previous = context.state
    const host = event.type === 'agent_start' || event.type === 'agent_settled'
      ? context.runtime.getState()
      : previous.runtime
    let next = reduceRuntimeSessionEvent(previous, { type: 'pi-event', event }, host)
    if (event.type === 'agent_settled') {
      next = this.withContextSessionActivity(context, next)
    } else if (event.type === 'session_info_changed' && typeof event.name === 'string') {
      const sessionName = event.name
      const provisional = context.provisionalSession
      if (provisional !== null) {
        provisional.pointer = { ...provisional.pointer, sessionName }
      } else if (!namingInFlight) {
        // Generated names update the durable index before publishing navigation.
        const pointers = this.sessionPointersByProject.get(context.projectPath) ?? []
        const updated = pointers.map((pointer) => pointer.sessionFile === next.activeSessionKey
          ? { ...pointer, sessionName }
          : pointer)
        this.sessionPointersByProject.set(context.projectPath, updated)
        if (this.state.activeProjectKey === context.projectPath) this.sessionPointers = updated
      }
    }
    this.cacheToolImagesFromEvent(context, next, event)
    context.state = next
    if (next !== previous || askNavigationBefore !== null) {
      this.publishContextState(context, navigationBefore)
    }
    if (hasAssistantUsage(event)) this.requestSessionUsageRefresh(context.runtime)
    if (isAssistantMessageEnd(event) && context.provisionalSession !== null) {
      this.beginContextProvisionalCommit(context)
    }
    if (event.type === 'agent_settled') {
      this.collaboration.settled(context)
      this.naming.ensureQueued(context)
      this.naming.begin(context)
    }
  }

  private withContextSessionActivity(
    context: RuntimeContext,
    state: RuntimeSessionState
  ): RuntimeSessionState {
    if (state.activeSessionKey === null) return state
    const activityAt = this.now()
    const activities =
      this.sessionActivityByProject.get(context.projectPath) ??
      (this.state.activeProjectKey === context.projectPath
        ? this.sessionActivityAtByKey
        : new Map<string, number | null>())
    activities.set(state.activeSessionKey, activityAt)
    this.sessionActivityByProject.set(context.projectPath, activities)
    if (this.state.activeProjectKey === context.projectPath) {
      this.sessionActivityAtByKey = activities
    }
    if (
      context.provisionalSession?.runtime === context.runtime &&
      context.provisionalSession.pointer.sessionFile === state.activeSessionKey
    ) {
      context.provisionalSession.activityAt = activityAt
    }
    return state
  }

  /** Publish the selected Session or bounded background navigation, never swap selection. */
  private publishContextState(
    context: RuntimeContext,
    navigationBefore: ProjectNavigationState | null,
    publication: 'patch' | 'snapshot' = 'patch'
  ): void {
    if (!this.contexts.has(context) || this.contextByRuntime.get(context.runtime) !== context) return
    if (this.activeContext !== context) {
      if (navigationBefore !== null) this.publishProjectNavigationChange(context.projectPath, navigationBefore)
      return
    }
    const previous = this.state
    this.state = projectRuntimeSessionState(previous, context.state)
    if (navigationBefore !== null) this.state = { ...this.state, sessions: this.toSessionSummaries() }
    const patch = publication === 'snapshot' || previous.runtime.status !== this.state.runtime.status
      ? null
      : createStatePatch(previous, this.state)
    if (patch === null) this.emitState()
    else this.emitPatch(patch)
  }

  private publishProjectNavigationChange(
    projectPath: string,
    navigationBefore: ProjectNavigationState
  ): void {
    const navigationAfter = this.projectNavigationState(projectPath)
    if (sameProjectNavigationState(navigationBefore, navigationAfter)) return
    if (this.state.activeProjectKey === projectPath) {
      this.sessionPointers = this.sessionPointersByProject.get(projectPath) ?? []
      this.sessionActivityAtByKey =
        this.sessionActivityByProject.get(projectPath) ?? new Map()
      this.sessionStatisticsByKey =
        this.sessionStatisticsByProject.get(projectPath) ?? new Map()
      this.state = { ...this.state, sessions: navigationAfter.sessions }
    }
    this.emitState()
  }

  private async preflightProjectTrust(projectPath: string): Promise<boolean | undefined> {
    const workspace = this.state.projects.find(({ path }) => path === projectPath)
    if (workspace !== undefined && workspaceKind(workspace) === 'task') return true
    const inspection = await this.projectTrust.inspect(projectPath)
    this.assertLaunchActive()
    if (!inspection.requiresDecision || inspection.decision !== null) return undefined
    if (this.pendingProjectTrust !== null) {
      throw new Error('A project trust request is already pending.')
    }
    const id = randomUUID()
    return new Promise<boolean | undefined>((resolveTrust, rejectTrust) => {
      this.pendingProjectTrust = {
        id,
        projectPath,
        resolve: resolveTrust,
        reject: rejectTrust,
        persistenceInFlight: false
      }
      this.state = {
        ...this.state,
        projectTrustRequest: { id, projectPath }
      }
      this.emitState()
    })
  }

  private finishProjectTrustRequest(
    pending: NonNullable<WorkbenchKernel['pendingProjectTrust']>
  ): void {
    if (this.pendingProjectTrust !== pending) {
      throw new Error('Project trust request is stale.')
    }
    this.pendingProjectTrust = null
    this.state = { ...this.state, projectTrustRequest: null }
    this.emitState()
  }

  private cancelPendingProjectTrust(message: string): void {
    const pending = this.pendingProjectTrust
    if (pending === null) return
    this.finishProjectTrustRequest(pending)
    pending.reject(new Error(message))
  }

  private notifyListeners(event: KernelEvent): void {
    // Renderer/subscriber faults are outside the Kernel state machine. Isolate
    // each callback so one observer cannot interrupt a commit, cleanup, or the
    // delivery of the same event to other subscribers.
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch {
        // Listener ownership ends at this boundary; Kernel invariants must win.
      }
    }
  }

  private emitState(): void {
    this.captureActiveContext()
    this.stateRevision += 1
    this.notifyListeners({
      type: 'kernel.state-changed',
      revision: this.stateRevision,
      state: this.getPublishedState()
    })
  }

  private emitPatch(patch: KernelStatePatch): void {
    this.captureActiveContext()
    this.stateRevision += 1
    this.notifyListeners({
      type: 'kernel.state-patched',
      revision: this.stateRevision,
      patch: copyPatch(patch)
    })
  }
}
