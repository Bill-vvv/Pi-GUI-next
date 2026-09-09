import type {
  AppearanceSettings,
  GeneralSettings,
  KernelArchiveReceipt,
  KernelAssistantFinalAnswer,
  KernelAskAnswer,
  KernelAskQuestion,
  KernelCommandDescriptor,
  KernelCommandEntry,
  KernelConversationEntry,
  KernelConversationEntryPatch,
  KernelConversationPage,
  KernelConversationPageRequest,
  KernelConversationState,
  KernelExtensionStatusEntry,
  KernelCompactionReason,
  KernelEvent,
  KernelExtensionDescriptor,
  KernelExtensionDialogRequest,
  KernelForkCandidate,
  KernelMessageAttachment,
  KernelMessageImage,
  KernelModelState,
  KernelMutationAck,
  KernelSnapshot,
  KernelProjectState,
  KernelPromptAttachment,
  KernelProjectTrustChoice,
  KernelRuntimeMemoryDiagnostics,
  KernelRuntimeMemorySample,
  KernelRuntimeMemoryUnavailableReason,
  KernelSessionSummary,
  KernelSessionPreview,
  KernelSessionPreviewPageRequest,
  KernelSessionState,
  KernelSessionStatistics,
  KernelSessionUsage,
  KernelSubagentParticipant,
  KernelSubagentRun,
  KernelToolEntry,
  KernelToolEntryPatchMetadata,
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
  KERNEL_CONVERSATION_PAGE_TURN_COUNT,
  conversationTurnWindowStartIndex
} from '../../shared/conversation-window.ts'
import {
  copyShortcutSettings,
  DEFAULT_SHORTCUT_SETTINGS,
  isShortcutSettings
} from '../../shared/shortcut-settings.ts'
import type {
  PiRpcEvent,
  PiRpcSessionStats
} from '../pi-rpc/pi-rpc-client.ts'
import {
  extractProjectedMessageImage,
  findUserMessageForImageLookup,
  materializePrompt,
  stripPromptFileBlocks
} from '../prompt/prompt-attachments.ts'
import { isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { RestartContinuationCandidate } from '../project/restart-continuation.ts'
import {
  SessionTranscriptPreparationCache,
  type SessionTranscriptPreparationHandle
} from '../project/session-transcript-preparation-cache.ts'
import type {
  ReadSessionMessagesTailFirstOptions,
  SessionTranscriptGeneration,
  SessionTranscriptMessagePhase
} from '../project/session-transcript-tail.ts'
import {
  upsertSessionPointer,
  type ProjectSessionRegistry,
  type SessionPointer
} from '../project/session-pointer.ts'
import type { RuntimeHost, RuntimeHostEvent, RuntimeHostState } from '../runtime/runtime-host.ts'
import {
  OPENAI_FAST_MODE_COMMAND_NAME,
  buildOpenAiFastModeCommandArgs,
  openAiFastModeFromSessionEntries
} from '../runtime/openai-fast-mode.ts'
import {
  readLinuxProcessMemoryBytes,
  type LinuxProcessMemoryReadResult
} from '../runtime/linux-process-memory.ts'
import type { SessionNameGenerator } from '../runtime/session-name-generator.ts'
import { errorMessage } from '../utils/errors.ts'
import {
  adaptedExtensionCommandAllowsBlockingUi,
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
  projectPiEvent,
  projectSessionEntries,
  projectTranscriptMessages
} from './conversation-projection.ts'
import {
  askUiRequestMatchesStep,
  createAskResponsePlan,
  createInitialAskResponseStep,
  isAskToolName,
  normalizeAskUiRequest,
  projectAskQuestions,
  type AskResponseStep,
  type AskUiRequest
} from './ask-tool.ts'
import {
  assertExtensionDialogResponse,
  normalizeExtensionDialogRequest
} from './extension-dialog.ts'
import {
  collectValidatedToolImages,
  copyToolImageAttachments,
  extractToolResultImage,
  findToolResultMessage,
  sameToolImageAttachments,
  ToolResultMessageNotFoundError
} from './tool-result-images.ts'
import { projectAdvisorState, UNAVAILABLE_ADVISOR_STATE } from './advisor-projection.ts'
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
  openAiFastMode: false,
  messageCount: 0,
  pendingMessageCount: 0,
  pendingSteeringMessages: [],
  pendingFollowUpMessages: [],
  compaction: null,
  settled: true
}

const AUTOMATIC_SESSION_NAME_MODEL_IDS = [
  'gpt-5.6-luna',
  'gpt-5.4-mini',
  'gpt-5.3-codex-spark'
] as const

const ARCHIVE_UNDO_DURATION_MS = 5_000
const TOOL_IMAGE_CACHE_TTL_MS = 60_000
const MAX_TOOL_IMAGE_CACHE_ENTRIES = 8
const MAX_TOOL_IMAGE_CACHE_BASE64_CHARS = 24 * 1024 * 1024
const RESTART_CONTINUATION_PROMPT =
  '请继续完成因 GUI 重启而中断的上一项任务。先根据当前会话记录核对已完成步骤和工具结果，不要重复已经完成的有副作用操作；如果无法安全判断下一步，请先说明风险并等待确认。'

export type RuntimeFactory = (
  project: { path: string },
  launchOptions: {
    sessionFile?: string
    projectTrust?: boolean
    subagent: SubagentSettings
    fastExtensionLoading: boolean
  }
) => RuntimeHost

export type ProjectTrustController = {
  inspect: (projectPath: string) => Promise<{
    requiresDecision: boolean
    decision: boolean | null
  }>
  persist: (projectPath: string, decision: boolean) => Promise<void>
}

type SessionMetadata = {
  activityAt: number | null
  statistics: KernelSessionStatistics | null
}

export type WorkbenchKernelOptions = {
  sessionRegistry: ProjectSessionRegistry
  /** 全部已登记 Project 的 Session 索引；用于 Navigator 多 Project 同时展开。 */
  sessionRegistriesByProject?: ReadonlyMap<string, ProjectSessionRegistry>
  extensions?: readonly KernelExtensionDescriptor[]
  persistProject: (project: KernelProjectState) => Promise<void>
  persistActiveProject: (projectKey: string) => Promise<void>
  persistActiveTask?: (taskKey: string) => Promise<void>
  persistNavigatorKind?: (kind: 'project' | 'task') => Promise<void>
  navigatorKind?: 'project' | 'task'
  persistSession: (pointer: SessionPointer) => Promise<void>
  persistActiveSession: (
    projectPath: string,
    sessionKey: string,
    sessionId: string
  ) => Promise<void>
  persistArchivedSession: (projectPath: string, sessionKey: string) => Promise<void>
  restoreArchivedSession?: (
    projectPath: string,
    sessionKey: string
  ) => Promise<ProjectSessionRegistry>
  validateSession: (pointer: SessionPointer) => Promise<SessionPointer>
  readSessionActivityAt?: (pointer: SessionPointer) => Promise<number | null>
  readSessionStatistics?: (pointer: SessionPointer) => Promise<KernelSessionStatistics>
  readSessionMetadata?: (pointer: SessionPointer) => Promise<SessionMetadata>
  readSessionMessages?: (pointer: SessionPointer) => Promise<unknown[]>
  readSessionMessagesTailFirst?: (
    pointer: SessionPointer,
    options: ReadSessionMessagesTailFirstOptions
  ) => Promise<SessionTranscriptMessagePhase>
  readSessionTranscriptGeneration?: (
    pointer: SessionPointer
  ) => Promise<SessionTranscriptGeneration>
  persistProjectOrder?: (projectKeys: string[]) => Promise<void>
  sessionNaming?: SessionNamingSettings
  persistSessionNaming?: (settings: SessionNamingSettings) => Promise<void>
  appearance?: AppearanceSettings
  persistAppearance?: (settings: AppearanceSettings) => Promise<void>
  general?: GeneralSettings
  persistGeneral?: (settings: GeneralSettings) => Promise<void>
  restartContinuations?: readonly RestartContinuationCandidate[]
  claimRestartContinuation?: (id: string) => Promise<void>
  completeRestartContinuation?: (id: string) => Promise<void>
  subagent?: SubagentSettings
  persistSubagent?: (settings: SubagentSettings) => Promise<void>
  shortcuts?: ShortcutSettings
  persistShortcuts?: (settings: ShortcutSettings) => Promise<void>
  generateSessionName?: SessionNameGenerator
  projectTrust?: ProjectTrustController
  /** Unix epoch milliseconds; used for persisted activity timestamps and bounded TTLs. */
  now?: () => number
  /**
   * Optional process-memory reader for on-demand Runtime diagnostics.
   * Defaults to Linux `/proc/<pid>/smaps_rollup` root-only sampling.
   */
  readProcessMemory?: (pid: number) => Promise<LinuxProcessMemoryReadResult>
}

type ProvisionalSession = {
  runtime: RuntimeHost
  pointer: SessionPointer
  initialPrompt: string | null
  sessionNameAttempted: boolean
  activityAt: number
}

type ToolImageCacheEntry = {
  projectPath: string
  sessionKey: string
  sessionId: string
  runtime: RuntimeHost
  cachedAt: number
  base64Chars: number
  image: KernelMessageImage
}

type AskInteraction = {
  toolCallId: string
  questions: KernelAskQuestion[]
  pendingRequest: AskUiRequest | null
  responsePlan: AskResponseStep[] | null
  nextResponseIndex: number
  cancelling: boolean
}

type SessionPreviewRegistrySource =
  | ProjectSessionRegistry
  | (() => Promise<ProjectSessionRegistry>)

type PendingStaticSessionPreviewRequest = {
  requestId: string
  controller: AbortController
}

type StaticSessionPreviewOperation = {
  requestId: string
  previewId: string
  projectPath: string
  pointer: SessionPointer
  registrySource: SessionPreviewRegistrySource
  controller: AbortController
  preparation: SessionTranscriptPreparationHandle
  tail: Promise<KernelSessionPreview>
  resolveTail: (preview: KernelSessionPreview) => void
  rejectTail: (error: unknown) => void
  completion: Promise<KernelSessionPreview>
}

type DetachedHistoryLease = {
  previewId: string
  pointer: SessionPointer
  archivedExpiresAt: number | null
}

type ConversationIdentity = {
  projectKey: string
  sessionKey: string
  sessionId: string
}

type ExtensionCommandInvocation = {
  id: string
  name: string
  active: boolean
}

type ExtensionDialogInteraction = {
  request: KernelExtensionDialogRequest
}

type RuntimeContext = {
  /**
   * Opaque process-lifetime id for diagnostics correlation.
   * Assigned once at context creation; encodes no Session/Project identity.
   */
  runtimeId: string
  /**
   * Monotonic host Runtime generation for this context. Bound into generation-fenced
   * prepare/commit/release leases. Assigned once at context creation.
   */
  runtimeGeneration: number
  /**
   * Unix epoch ms of last warm use (activation, launch, prompt/steer/follow-up, or
   * observed activity). Used only by the automatic hibernation grace/warm-set policy.
   */
  lastWarmUseAt: number
  projectPath: string
  runtime: RuntimeHost
  state: KernelState
  /** Local Timeline echoes for typed slash commands; never written to Pi session. */
  commandEntries: KernelCommandEntry[]
  unsubscribeRuntime: (() => void) | null
  stopRequested: boolean
  launchCommitting: boolean
  provisionalSession: ProvisionalSession | null
  provisionalCommit: Promise<void> | null
  provisionalSettled: boolean
  sessionUsageRefreshInFlight: boolean
  sessionUsageRefreshRequested: boolean
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
  compactionRevision: number
  compactionLifecycle: CompactionLifecycle | null
  askInteraction: AskInteraction | null
  extensionCommandInvocation: ExtensionCommandInvocation | null
  extensionDialogInteraction: ExtensionDialogInteraction | null
  /** Runtime events buffered only across an atomic persisted identity commit (fork). */
  deferredEvents: RuntimeHostEvent[] | null
}

/** Default automatic hibernation grace: 5 minutes of inactivity. */
export const AUTO_HIBERNATE_GRACE_MS = 5 * 60 * 1000
/** Production Main schedules one non-overlapping sweep on this interval. */
export const AUTO_HIBERNATE_SWEEP_INTERVAL_MS = 60_000
/** Host command generation for one fresh Runtime process; the in-process bridge advances provider lifecycle generations. */
const HIBERNATE_HOST_COMMAND_GENERATION = 1

type CompactionLifecycle = {
  revision: number
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
  settled: boolean
}

type ProjectNavigationState = {
  busySessionCount: number
  sessions: KernelSessionSummary[]
}

type ArchiveUndoRecord = {
  receipt: KernelArchiveReceipt
  pointer: SessionPointer
  activityAt: number | null
  statistics: KernelSessionStatistics | null
  expiresAt: number
}

type ForkTarget = {
  projectPath: string
  pointer: SessionPointer
  runtime: RuntimeHost
  context: RuntimeContext
}

type RestartRecoverySelection = {
  activeProjectKey: string | null
  activeSessionKey: string | null
  navigatorKind: 'project' | 'task'
}

export class WorkbenchKernel {
  private readonly createRuntime: RuntimeFactory
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
  private autoHibernateSweepInFlight: Promise<void> | null = null
  private readonly sessionPointersByProject = new Map<string, SessionPointer[]>()
  private readonly sessionActivityByProject = new Map<string, Map<string, number | null>>()
  private readonly sessionStatisticsByProject =
    new Map<string, Map<string, KernelSessionStatistics | null>>()
  private readonly workspaceMetadataRefreshGeneration = new Map<string, number>()
  private readonly archiveUndoByToken = new Map<string, ArchiveUndoRecord>()
  private readonly detachedHistoryLeases = new Map<string, DetachedHistoryLease>()
  private readonly sessionReloadRequired = new Set<string>()
  private readonly restartContinuations = new Map<string, RestartContinuationCandidate>()
  /**
   * Bounded Main-only cache for tool result images that completed but may not yet
   * be readable from the Pi transcript. Never enters KernelState / patches / logs.
   */
  private readonly toolImageCache = new Map<string, ToolImageCacheEntry>()
  private activeContext: RuntimeContext | null = null
  private runtime: RuntimeHost | null = null
  private unsubscribeRuntime: (() => void) | null = null
  private sessionPointers: SessionPointer[]
  private state: KernelState
  /** Monotonic revision bumped on every published state-changed/state-patched event. */
  private stateRevision = 0
  private stopRequested = false
  private shutdownRequested = false
  private launchOperation: Promise<void> | null = null
  private projectChangeOperation: Promise<void> | null = null
  private launchCommitting = false
  private provisionalSession: ProvisionalSession | null = null
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
  private pendingProjectTrust: {
    id: string
    projectPath: string
    resolve: (projectTrust: boolean | undefined) => void
    reject: (error: Error) => void
    persistenceInFlight: boolean
  } | null = null
  private pendingStaticSessionPreview: PendingStaticSessionPreviewRequest | null = null
  private staticSessionPreview: StaticSessionPreviewOperation | null = null
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

    return { sampledAt, runtimes }
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
      const contextState = this.activeContext === context ? this.state : context.state
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
    const metadataByProject = await Promise.all(snapshots.map(async ({ projectPath, pointers }) => {
      if (projectPath === activeProjectAtStart) {
        return { projectPath, pointers, ...await this.loadSessionMetadata(pointers) }
      }
      return {
        projectPath,
        pointers,
        activityAtByKey: await this.loadSessionActivities(pointers),
        statisticsByKey: undefined
      }
    }))
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
    const currentProvisional = this.provisionalSession
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
    const context = this.requireActiveAskContext(sessionKey, toolCallId)
    const interaction = context.askInteraction!
    if (interaction.cancelling) throw new Error('Ask cancellation is already in progress.')
    if (interaction.responsePlan !== null) throw new Error('Ask answers are already being submitted.')
    const responsePlan = createAskResponsePlan(interaction.questions, answers)
    const pendingRequest = interaction.pendingRequest
    const firstStep = responsePlan[0]
    if (
      pendingRequest === null ||
      firstStep === undefined ||
      !askUiRequestMatchesStep(pendingRequest, firstStep)
    ) {
      throw new Error('Ask request is stale or mismatched.')
    }
    interaction.responsePlan = responsePlan
    interaction.nextResponseIndex = 0
    this.updateAskToolState(context, interaction, 'submitting', null)
    await this.deliverPendingAskResponse(context, interaction)
  }

  async cancelAsk(sessionKey: string, toolCallId: string): Promise<void> {
    const context = this.requireActiveAskContext(sessionKey, toolCallId)
    const interaction = context.askInteraction!
    interaction.cancelling = true
    this.updateAskToolState(context, interaction, 'submitting', null)
    if (interaction.pendingRequest !== null) {
      await this.deliverPendingAskResponse(context, interaction)
    }
  }

  async respondExtensionDialog(
    projectKey: string,
    sessionKey: string,
    sessionId: string,
    requestId: string,
    commandInvocationId: string,
    value: string
  ): Promise<void> {
    const { context, interaction } = this.requireActiveExtensionDialog(
      projectKey,
      sessionKey,
      sessionId,
      requestId,
      commandInvocationId
    )
    assertExtensionDialogResponse(interaction.request, value)
    await this.deliverExtensionDialogResponse(context, interaction, { value })
  }

  async cancelExtensionDialog(
    projectKey: string,
    sessionKey: string,
    sessionId: string,
    requestId: string,
    commandInvocationId: string
  ): Promise<void> {
    const { context, interaction } = this.requireActiveExtensionDialog(
      projectKey,
      sessionKey,
      sessionId,
      requestId,
      commandInvocationId
    )
    await this.deliverExtensionDialogResponse(context, interaction, { cancelled: true })
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
    const provisional = this.provisionalSession
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
    const stopRequested = active ? this.stopRequested : managed.stopRequested
    const launchCommitting = active ? this.launchCommitting : managed.launchCommitting
    const provisionalSession = active ? this.provisionalSession : managed.provisionalSession
    const provisionalCommit = active ? this.provisionalCommit : managed.provisionalCommit
    if (
      stopRequested ||
      launchCommitting ||
      provisionalSession !== null ||
      provisionalCommit !== null
    ) {
      return undefined
    }
    const state = active ? this.state : managed.state
    if (state.runtime.status !== 'ready' && state.runtime.status !== 'running') return undefined
    if (
      state.activeProjectKey !== projectPath ||
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
    if (!isAbsolute(sessionKey)) throw new Error(`Session key must be absolute: ${sessionKey}`)
    assertSessionPreviewRequestId(requestId)
    const pending = this.pendingStaticSessionPreview
    if (pending !== null) {
      this.pendingStaticSessionPreview = null
      pending.controller.abort()
    }

    const request: PendingStaticSessionPreviewRequest = {
      requestId,
      controller: new AbortController()
    }
    this.pendingStaticSessionPreview = request
    let operation: StaticSessionPreviewOperation | null = null
    try {
      operation = await this.prepareStaticSessionPreview(sessionKey, sessionRegistry, request)
      return await operation.tail
    } catch (error) {
      const stillOwnsPendingRequest = this.pendingStaticSessionPreview === request
      if (stillOwnsPendingRequest) this.pendingStaticSessionPreview = null
      if (operation !== null && this.staticSessionPreview === operation) {
        this.staticSessionPreview = null
      }
      request.controller.abort()
      if (operation === null && stillOwnsPendingRequest) this.cancelActiveStaticSessionPreview()
      throw error
    }
  }

  private async prepareStaticSessionPreview(
    sessionKey: string,
    sessionRegistry: SessionPreviewRegistrySource | undefined,
    request: PendingStaticSessionPreviewRequest
  ): Promise<StaticSessionPreviewOperation> {
    const project = configuredProject(this.state)
    const registrySource = sessionRegistry ?? (async () => ({
      sessions: this.sessionPointers,
      activeSessionKey: this.state.activeSessionKey
    }))
    const registry = await this.resolveSessionPreviewRegistry(registrySource)
    this.assertPendingStaticSessionPreview(request)
    if (this.state.activeProjectKey !== project.path) {
      throw new Error('Session preview cancelled because the active project changed.')
    }
    const cachedPointer = this.sessionPointers.find(
      (pointer) => pointer.projectPath === project.path && pointer.sessionFile === sessionKey
    )
    const storedPointer = cachedPointer ?? this.findSessionPointerInRegistry(
      project.path,
      sessionKey,
      registry
    )
    if (storedPointer === undefined) {
      throw new Error(`Session is not registered for the active project: ${sessionKey}`)
    }
    if (typeof this.validateSession !== 'function') {
      throw new Error('Session validation is unavailable.')
    }
    const preparations = this.sessionTranscriptPreparations
    if (preparations === null) throw new Error('Session preview is unavailable.')

    const pointer = await this.validateSession(storedPointer)
    this.assertPendingStaticSessionPreview(request)
    await this.assertStaticSessionPreviewIdentity(project.path, pointer, registrySource)
    this.assertPendingStaticSessionPreview(request)
    const preparation = await preparations.acquire(pointer)
    this.assertPendingStaticSessionPreview(request)

    let resolveTail!: (preview: KernelSessionPreview) => void
    let rejectTail!: (error: unknown) => void
    const tail = new Promise<KernelSessionPreview>((resolve, reject) => {
      resolveTail = resolve
      rejectTail = reject
    })
    const operation: StaticSessionPreviewOperation = {
      requestId: request.requestId,
      previewId: randomUUID(),
      projectPath: project.path,
      pointer,
      registrySource,
      controller: request.controller,
      preparation,
      tail,
      resolveTail,
      rejectTail,
      completion: Promise.resolve(null as unknown as KernelSessionPreview)
    }
    const previous = this.staticSessionPreview
    this.pendingStaticSessionPreview = null
    this.staticSessionPreview = operation
    this.rememberDetachedHistoryLease(operation.previewId, pointer, null)
    if (previous !== null) this.cancelStaticSessionPreviewOperation(previous)
    operation.completion = this.runStaticSessionPreview(operation)
    void operation.completion.catch(() => undefined)
    return operation
  }

  private assertPendingStaticSessionPreview(request: PendingStaticSessionPreviewRequest): void {
    if (this.pendingStaticSessionPreview !== request || request.controller.signal.aborted) {
      throw sessionPreviewAbortError()
    }
  }

  async completeSessionPreview(requestId: string): Promise<KernelSessionPreview> {
    assertSessionPreviewRequestId(requestId)
    const operation = this.staticSessionPreview
    if (operation === null || operation.requestId !== requestId) {
      throw new Error('Session preview request is not active.')
    }
    try {
      return await operation.completion
    } finally {
      if (this.staticSessionPreview === operation) this.staticSessionPreview = null
    }
  }

  cancelSessionPreview(requestId: string): void {
    assertSessionPreviewRequestId(requestId)
    const pending = this.pendingStaticSessionPreview
    if (pending !== null && pending.requestId === requestId) {
      this.pendingStaticSessionPreview = null
      pending.controller.abort()
      return
    }
    const operation = this.staticSessionPreview
    if (operation === null || operation.requestId !== requestId) return
    this.staticSessionPreview = null
    this.cancelStaticSessionPreviewOperation(operation)
  }

  async loadEarlierSessionPreview(
    request: KernelSessionPreviewPageRequest,
    sessionRegistry?: SessionPreviewRegistrySource
  ): Promise<KernelConversationPage> {
    const lease = this.detachedHistoryLeases.get(request.previewId)
    if (
      lease === undefined ||
      lease.pointer.projectPath !== request.projectKey ||
      lease.pointer.sessionFile !== request.sessionKey ||
      lease.pointer.sessionId !== request.sessionId
    ) {
      throw new Error('Session preview page identity is stale.')
    }
    if (lease.archivedExpiresAt !== null) {
      if (this.now() >= lease.archivedExpiresAt) {
        this.detachedHistoryLeases.delete(request.previewId)
        throw new Error('Archived Session preview has expired.')
      }
    } else {
      const registrySource = sessionRegistry ?? (async () => ({
        sessions: this.sessionPointers,
        activeSessionKey: this.state.activeSessionKey
      }))
      await this.assertStaticSessionPreviewIdentity(request.projectKey, lease.pointer, registrySource)
    }
    const preparations = this.sessionTranscriptPreparations
    if (preparations === null) throw new Error('Session preview is unavailable.')
    const handle = await preparations.acquire(lease.pointer)
    try {
      const phase = await handle.completion
      const entries = projectTranscriptMessages(phase.messages)
      assertConversationPageRequest(request, entries)
      const startIndex = conversationTurnWindowStartIndex(
        entries,
        request.beforeIndex,
        KERNEL_CONVERSATION_PAGE_TURN_COUNT
      )
      if (startIndex >= request.beforeIndex) {
        throw new Error('Session preview has no earlier Conversation page.')
      }
      return {
        projectKey: request.projectKey,
        sessionKey: request.sessionKey,
        sessionId: request.sessionId,
        beforeIndex: request.beforeIndex,
        beforeEntryId: request.beforeEntryId,
        startIndex,
        entries: entries.slice(startIndex, request.beforeIndex)
      }
    } finally {
      handle.release()
    }
  }

  private async runStaticSessionPreview(
    operation: StaticSessionPreviewOperation
  ): Promise<KernelSessionPreview> {
    try {
      const tail = await operation.preparation.tail
      await this.assertStaticSessionPreviewBoundary(operation)
      operation.resolveTail(this.projectStaticSessionPreview(operation, tail, false))
      const full = await operation.preparation.completion
      await this.assertStaticSessionPreviewBoundary(operation)
      return this.projectStaticSessionPreview(operation, full, true)
    } catch (error) {
      operation.rejectTail(error)
      throw error
    } finally {
      operation.preparation.release()
    }
  }

  private projectStaticSessionPreview(
    operation: StaticSessionPreviewOperation,
    phase: SessionTranscriptMessagePhase,
    boundCompletedPreview: boolean
  ): KernelSessionPreview {
    const entries = projectTranscriptMessages(phase.messages)
    const startIndex = boundCompletedPreview
      ? conversationTurnWindowStartIndex(entries, entries.length, KERNEL_CONVERSATION_PAGE_TURN_COUNT)
      : 0
    return {
      previewId: operation.previewId,
      projectKey: operation.projectPath,
      sessionKey: operation.pointer.sessionFile,
      sessionId: operation.pointer.sessionId,
      sessionName: operation.pointer.sessionName,
      conversation: {
        entries: entries.slice(startIndex),
        startIndex,
        activeRunStartIndex: null
      }
    }
  }

  private async assertStaticSessionPreviewBoundary(
    operation: StaticSessionPreviewOperation
  ): Promise<void> {
    if (
      this.staticSessionPreview !== operation ||
      operation.controller.signal.aborted
    ) {
      throw sessionPreviewAbortError()
    }
    await this.assertStaticSessionPreviewIdentity(
      operation.projectPath,
      operation.pointer,
      operation.registrySource
    )
    if (
      this.staticSessionPreview !== operation ||
      operation.controller.signal.aborted
    ) {
      throw sessionPreviewAbortError()
    }
  }

  private async assertStaticSessionPreviewIdentity(
    projectPath: string,
    pointer: SessionPointer,
    registrySource: SessionPreviewRegistrySource
  ): Promise<void> {
    if (this.state.activeProjectKey !== projectPath) {
      throw new Error('Session preview cancelled because the active project changed.')
    }
    const registry = await this.resolveSessionPreviewRegistry(registrySource)
    if (
      this.state.activeProjectKey !== projectPath ||
      !registry.sessions.some((candidate) =>
        candidate.projectPath === projectPath &&
        candidate.sessionFile === pointer.sessionFile &&
        candidate.sessionId === pointer.sessionId
      )
    ) {
      throw new Error('Session preview cancelled because the Session identity changed.')
    }
  }

  private resolveSessionPreviewRegistry(
    source: SessionPreviewRegistrySource
  ): Promise<ProjectSessionRegistry> {
    return typeof source === 'function' ? source() : Promise.resolve(source)
  }

  private cancelActiveStaticSessionPreview(): void {
    const pending = this.pendingStaticSessionPreview
    if (pending !== null) {
      this.pendingStaticSessionPreview = null
      pending.controller.abort()
    }
    const operation = this.staticSessionPreview
    if (operation !== null) {
      this.staticSessionPreview = null
      this.cancelStaticSessionPreviewOperation(operation)
    }
  }

  private cancelStaticSessionPreviewOperation(operation: StaticSessionPreviewOperation): void {
    operation.controller.abort()
    operation.preparation.release()
    operation.rejectTail(sessionPreviewAbortError())
  }

  private rememberDetachedHistoryLease(
    previewId: string,
    pointer: SessionPointer,
    archivedExpiresAt: number | null
  ): void {
    this.detachedHistoryLeases.set(previewId, { previewId, pointer, archivedExpiresAt })
    while (this.detachedHistoryLeases.size > 16) {
      const oldest = this.detachedHistoryLeases.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.detachedHistoryLeases.delete(oldest)
    }
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
      const navigatedState: KernelState = {
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
      this.state = navigatedState
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

        this.cancelSessionNameGeneration(target.runtime)
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
        const commands = createCommandCatalog(commandsResult.commands, true)
        const advisor = projectAdvisorState(capabilitiesResult.entries)
        const availableModels = modelsResult.models.map(toAvailableKernelModel)
        if (typeof this.validateSession !== 'function') {
          throw new Error('Session validation is unavailable.')
        }
        const pointer = await this.validateSession({
          projectPath: target.projectPath,
          sessionFile,
          sessionId,
          sessionName: session.name
        })
        this.assertForkTarget(target)
        if (
          pointer.projectPath !== target.projectPath ||
          pointer.sessionFile === target.pointer.sessionFile ||
          pointer.sessionId !== sessionId ||
          pointer.sessionId === target.pointer.sessionId
        ) {
          throw new Error('Forked session validation returned a mismatched identity.')
        }
        const activityAt = await this.readSessionActivityAt(pointer)
        this.assertForkTarget(target)
        const statistics = toKernelSessionStatistics(statisticsResult.statistics)

        if (target.context.deferredEvents !== null) {
          throw new Error('Fork identity commit is already buffering runtime events.')
        }
        this.launchCommitting = true
        target.context.deferredEvents = []
        try {
          await this.persistSession(pointer)
          // No Runtime event can mutate the old identity during this await: events
          // are buffered on the owning Context until the new durable identity and
          // in-memory projection are committed together.
          this.assertForkTarget(target)
          this.sessionPointers = upsertSessionPointer(this.sessionPointers, pointer)
          this.sessionActivityAtByKey.set(pointer.sessionFile, activityAt)
          this.sessionStatisticsByKey.set(pointer.sessionFile, statistics)
          this.sessionPointersByProject.set(target.projectPath, this.sessionPointers)
          this.sessionActivityByProject.set(target.projectPath, this.sessionActivityAtByKey)
          this.sessionStatisticsByProject.set(target.projectPath, this.sessionStatisticsByKey)
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
            session,
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
          this.launchCommitting = false
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
      await this.stopContext(targetContext)
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
    if (this.autoHibernateSweepInFlight !== null) {
      await this.autoHibernateSweepInFlight
      return { attempted: 0, hibernatedCount: 0, skippedCount: 0, failedCount: 0 }
    }

    const summary = {
      attempted: 0,
      hibernatedCount: 0,
      skippedCount: 0,
      failedCount: 0
    }
    const run = this.runAutomaticHibernationSweep(options, summary)
    this.autoHibernateSweepInFlight = run.then(
      () => undefined,
      () => undefined
    )
    try {
      await run
      return summary
    } finally {
      this.autoHibernateSweepInFlight = null
    }
  }

  private async runAutomaticHibernationSweep(
    options: { graceMs?: number; nowMs?: number } | undefined,
    summary: {
      attempted: number
      hibernatedCount: number
      skippedCount: number
      failedCount: number
    }
  ): Promise<void> {
    const graceMs =
      typeof options?.graceMs === 'number' &&
      Number.isFinite(options.graceMs) &&
      options.graceMs >= 0
        ? options.graceMs
        : AUTO_HIBERNATE_GRACE_MS
    const nowMs =
      typeof options?.nowMs === 'number' && Number.isFinite(options.nowMs)
        ? options.nowMs
        : this.now()

    const backgroundReady: RuntimeContext[] = []
    for (const context of this.contexts) {
      if (this.activeContext === context) continue
      if (context.state.runtime.status !== 'ready') continue
      backgroundReady.push(context)
    }

    if (backgroundReady.length <= 1) {
      // Keep the single warm background Runtime (or none).
      summary.skippedCount += backgroundReady.length
      return
    }

    // Keep the most-recent background ready Runtime warm.
    let warmContext = backgroundReady[0]!
    for (const context of backgroundReady) {
      if (context.lastWarmUseAt > warmContext.lastWarmUseAt) {
        warmContext = context
      }
    }

    const candidates = backgroundReady
      .filter((context) => context !== warmContext)
      .filter((context) => nowMs - context.lastWarmUseAt >= graceMs)
      .sort((left, right) => left.lastWarmUseAt - right.lastWarmUseAt)

    // Count the intentionally retained warm Runtime plus ready Runtimes that
    // have not yet aged past the grace period. Non-ready contexts are outside
    // the automatic-idle candidate set rather than misleading "skips".
    summary.skippedCount += backgroundReady.length - candidates.length

    for (const context of candidates) {
      const outcome = await this.tryAutomaticHibernateContext(context)
      summary.attempted += 1
      if (outcome === 'hibernated') summary.hibernatedCount += 1
      else if (outcome === 'failed') summary.failedCount += 1
      else summary.skippedCount += 1
    }
  }

  private async tryAutomaticHibernateContext(
    context: RuntimeContext
  ): Promise<'hibernated' | 'skipped' | 'failed'> {
    if (!this.contexts.has(context)) return 'skipped'
    if (this.activeContext === context) return 'skipped'

    const sessionKey = context.state.activeSessionKey
    if (sessionKey === null) return 'skipped'
    const sessionId = context.state.session.id
    if (typeof sessionId !== 'string' || sessionId.length === 0) return 'skipped'

    // Kernel busy gate remains a necessary outer condition.
    if (this.hibernateBlockReason(context.projectPath, sessionKey, context) !== null) {
      return 'skipped'
    }

    // RuntimeContext generation protects Kernel identity across replacement. The host
    // command generation is process-local; the in-process bridge separately advances
    // owner/provider generations on every Pi session_start.
    const runtimeGeneration = context.runtimeGeneration
    const providerGeneration = HIBERNATE_HOST_COMMAND_GENERATION
    const attemptId = randomUUID()
    let token: string | null = null
    const release = async (): Promise<void> => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await context.runtime.releaseHibernation({
          sessionId,
          generation: providerGeneration,
          attemptId,
          token: token!
        })
        if (result.ok) return
      }
      throw new Error('Runtime hibernation lease release failed.')
    }

    try {
      const prepared = await context.runtime.prepareHibernation({
        sessionId,
        generation: providerGeneration,
        attemptId
      })
      if (!prepared.ok || typeof prepared.token !== 'string') {
        return 'skipped'
      }
      token = prepared.token

      // Recheck exact Kernel context identity after provider prepare/drain.
      if (
        !this.contexts.has(context) ||
        this.activeContext === context ||
        context.runtimeGeneration !== runtimeGeneration ||
        this.hibernateBlockReason(context.projectPath, sessionKey, context) !== null ||
        context.state.session.id !== sessionId
      ) {
        await release()
        return 'skipped'
      }

      const committed = await context.runtime.commitHibernation({
        sessionId,
        generation: providerGeneration,
        attemptId,
        token
      })
      if (!committed.ok) {
        await release()
        return 'skipped'
      }

      // Serialize the final check + stop with activate/reload/start. Once this
      // gate is acquired, a foreground activation cannot attach to a Context
      // that stopContext is about to remove.
      let stopEntered = false
      try {
        await this.beginLaunch(async () => {
          if (
            !this.contexts.has(context) ||
            this.activeContext === context ||
            context.runtimeGeneration !== runtimeGeneration ||
            this.hibernateBlockReason(context.projectPath, sessionKey, context) !== null ||
            context.state.session.id !== sessionId
          ) {
            return
          }
          stopEntered = true
          await this.stopContext(context)
        })
        if (!stopEntered) {
          await release()
          return 'skipped'
        }
        return 'hibernated'
      } catch {
        // A competing launch rejected the automatic stop, or stop itself failed.
        // If the process may remain owned, roll back the exact provider token.
        if (this.contexts.has(context) && context.runtimeGeneration === runtimeGeneration) {
          try {
            await release()
          } catch {
            // Ownership retention is handled by stopContext; a later sweep retries.
          }
        }
        return stopEntered ? 'failed' : 'skipped'
      }
    } catch {
      if (token !== null && this.contexts.has(context)) {
        try {
          await release()
        } catch {
          // Best-effort release.
        }
      }
      return 'skipped'
    }
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
      this.clearToolImageCacheForSession(sessionKey)
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
      this.rememberDetachedHistoryLease(previewId, pointer, record.expiresAt)
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
    const blocker = this.hibernateBlockReason(projectPath, sessionKey, context)
    if (blocker !== null) throw new Error(blocker)
  }

  private hibernateBlockReason(
    projectPath: string,
    sessionKey: string,
    context: RuntimeContext
  ): string | null {
    if (context.projectPath !== projectPath) {
      return 'Cannot hibernate a session that is not owned by the requested project.'
    }
    if (!(this.sessionPointersByProject.get(projectPath) ?? []).some((pointer) =>
      pointer.sessionFile === sessionKey
    )) {
      return 'Cannot hibernate a session without a persisted pointer.'
    }
    if (this.activeContext === context || this.state.activeSessionKey === sessionKey) {
      return 'Cannot hibernate the active foreground session.'
    }
    if (
      context.provisionalSession !== null ||
      context.provisionalCommit !== null ||
      context.state.activeSessionKey === null ||
      context.state.sessions.some((summary) =>
        summary.key === sessionKey && summary.provisional === true
      )
    ) {
      return 'Cannot hibernate a provisional session.'
    }
    const runtimeStatus = context.state.runtime.status
    if (
      runtimeStatus === 'starting' ||
      runtimeStatus === 'running' ||
      runtimeStatus === 'stopping'
    ) {
      return `Cannot hibernate a session while runtime is ${runtimeStatus}.`
    }
    if (!context.state.session.settled) {
      return 'Cannot hibernate a session that is not settled.'
    }
    if (
      context.state.session.compaction !== null ||
      (context.compactionLifecycle !== null && !context.compactionLifecycle.settled)
    ) {
      return 'Hibernate is unavailable while compaction is in progress.'
    }
    if (context.launchCommitting) {
      return 'Cannot hibernate a session while launch is committing.'
    }
    if (context.deferredEvents !== null) {
      return 'Cannot hibernate a session while a deferred identity commit is in progress.'
    }
    if (context.sessionNameOperation !== null || context.pendingSessionName !== null) {
      return 'Cannot hibernate a session while session naming is in progress.'
    }
    if (context.stopRequested) {
      return 'Cannot hibernate a session while stop is in progress.'
    }
    if (context.sessionUsageRefreshInFlight || context.sessionUsageRefreshRequested) {
      return 'Cannot hibernate a session while session usage refresh is in progress.'
    }
    if (
      context.askInteraction !== null ||
      (context.state.extensionDialog !== null && context.state.extensionDialog !== undefined)
    ) {
      return 'Cannot hibernate a session while waiting for a user reply.'
    }
    const session = context.state.session
    if (
      session.pendingMessageCount > 0 ||
      session.pendingSteeringMessages.length > 0 ||
      session.pendingFollowUpMessages.length > 0
    ) {
      return 'Cannot hibernate a session while messages are queued.'
    }
    return null
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
    this.runtime = null
    this.unsubscribeRuntime = null
    this.provisionalSession = null
    this.provisionalCommit = null
    this.provisionalSettled = false
    this.pendingSessionName = null
    this.sessionNameOperation = null
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
    if (this.stopRequested) throw new Error('Runtime start cancelled.')
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
    this.runtime = runtime
    const context: RuntimeContext = {
      runtimeId: this.allocateRuntimeId(),
      runtimeGeneration: this.allocateRuntimeGeneration(),
      lastWarmUseAt: this.now(),
      projectPath: project.path,
      runtime,
      state: copyState(this.state),
      commandEntries: [],
      unsubscribeRuntime: null,
      stopRequested: false,
      launchCommitting: false,
      provisionalSession: null,
      provisionalCommit: null,
      provisionalSettled: false,
      sessionUsageRefreshInFlight: false,
      sessionUsageRefreshRequested: false,
      pendingSessionName: null,
      sessionNameOperation: null,
      compactionRevision: 0,
      compactionLifecycle: null,
      askInteraction: null,
      extensionCommandInvocation: null,
      extensionDialogInteraction: null,
      deferredEvents: null
    }
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
    this.transition('starting')
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
      context.state = copyState(this.state)
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
        this.provisionalSession = {
          runtime,
          pointer,
          initialPrompt: null,
          sessionNameAttempted: false,
          activityAt: this.now()
        }
        context.provisionalSession = this.provisionalSession
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
      this.launchCommitting = true
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
        this.queueSessionNameGeneration(
          runtime,
          canonicalPointer,
          firstUserMessage(projectedMessages)
        )
        this.emitState()
        this.beginSessionNameGeneration()
        if (claimedRestartContinuation !== null) {
          await this.prompt(RESTART_CONTINUATION_PROMPT, [], canonicalPointer.sessionFile)
        }
      } finally {
        this.launchCommitting = false
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
          this.runtime = retained.runtime
          this.unsubscribeRuntime = retained.unsubscribeRuntime
          this.stopRequested = retained.stopRequested
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
      if (this.runtime === runtime) this.stopRequested = false
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
    if (this.runtime === runtime) {
      this.runtime = null
      this.unsubscribeRuntime = null
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
    this.publishContextNavigationChange(context, navigationBefore)
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
    if (this.activeContext !== null) this.touchWarmUse(this.activeContext)
    if (message.trim().length === 0 && attachments.length === 0) {
      throw new Error('Prompt must not be empty.')
    }
    const materialized = materializePrompt(message, attachments)
    const provisional = this.provisionalSession?.runtime === runtime &&
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
      if (
        provisional !== null &&
        this.provisionalSession === provisional &&
        provisional.initialPrompt !== null &&
        !provisional.sessionNameAttempted
      ) {
        provisional.sessionNameAttempted = true
        this.queueSessionNameGeneration(runtime, provisional.pointer, provisional.initialPrompt)
      }
      this.beginSessionNameGeneration()
    } catch (error) {
      if (provisional !== null && this.provisionalSession === provisional) {
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

  async setAdvisorSystemEnabled(enabled: boolean): Promise<void> {
    const runtime = this.requireRuntime('ready')
    if (
      this.state.advisor.compatibility !== 'ready' ||
      !this.state.advisor.liveToggle
    ) {
      throw new Error('Advisor live toggle is unavailable.')
    }
    const context = this.activeContext
    if (context === null || context.runtime !== runtime) {
      throw new Error('Active runtime context is unavailable.')
    }

    const toggleResult = await runtime.send({
      type: 'invoke_extension_command',
      name: 'advisor',
      args: enabled ? 'on' : 'off'
    })
    if (toggleResult.type !== 'accepted') {
      throw new Error('Runtime did not accept the Advisor toggle command.')
    }
    if (this.activeContext !== context || this.runtime !== runtime) {
      throw new Error('Advisor toggle cancelled because the active session changed.')
    }
    const entriesResult = await runtime.send({ type: 'get_entries' })
    if (this.activeContext !== context || this.runtime !== runtime) {
      throw new Error('Advisor toggle cancelled because the active session changed.')
    }
    if (entriesResult.type !== 'entries') {
      throw new Error('Runtime did not return advisor capabilities.')
    }
    const advisor = projectAdvisorState(entriesResult.entries)
    if (advisor.compatibility !== 'ready' || advisor.systemEnabled !== enabled) {
      throw new Error('Advisor extension did not confirm the requested system state.')
    }
    this.state = { ...this.state, advisor }
    this.emitState()
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

  async setSubagent(settings: SubagentSettings): Promise<void> {
    assertSubagentSettings(settings)
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
      this.cancelSessionNameGeneration(runtime)
      await runtime.send({ type: 'set_session_name', name })
      await this.refreshRenamedSession(runtime)
      this.appendCommandEcho(command, argument)
      return
    }

    if (command.source === 'extension') {
      assertAdaptedExtensionCommandArgument(command, argument)
    }
    await this.invokePiCommand(command, argument)
    if (command.source === 'extension') this.appendCommandEcho(command, argument)
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
    if (this.activeContext === context) {
      this.appendLocalConversationEntry(entry)
      return
    }
    context.state = {
      ...context.state,
      conversation: {
        ...context.state.conversation,
        entries: [...context.state.conversation.entries, entry]
      }
    }
  }

  private appendLocalConversationEntry(entry: KernelConversationEntry): void {
    const context = this.activeContext
    if (context === null) return
    if (this.state.runtime.status !== 'ready' && this.state.runtime.status !== 'running') return
    this.state = {
      ...this.state,
      conversation: {
        ...this.state.conversation,
        entries: [...this.state.conversation.entries, entry]
      }
    }
    // emitState retains the active RuntimeContext by immutable reference.
    this.emitState()
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
      this.state = this.withActiveSessionActivity({
        ...this.state,
        runtime: toKernelRuntime('ready', runtime.getState()),
        session: toKernelSession(
          stateResult.state,
          this.state.session.resumeAvailable,
          this.state.session.usage,
          this.state.session.openAiFastMode
        ),
        conversation: settleConversationRun(this.state.conversation)
      })
      this.emitState()
    }
  }

  async stop(): Promise<void> {
    this.cancelActiveStaticSessionPreview()
    this.sessionTranscriptPreparations?.clear()
    this.detachedHistoryLeases.clear()
    if (this.pendingProjectTrust !== null) {
      this.stopRequested = true
      this.cancelPendingProjectTrust('Runtime start cancelled.')
    }
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
        advisor: { ...UNAVAILABLE_ADVISOR_STATE },
        runtime: toKernelRuntime('stopped', INITIAL_HOST_STATE)
      }
      this.emitState()
    }
    this.stopRequested = false
    if (firstError !== null) throw firstError
  }

  private async stopContext(context: RuntimeContext): Promise<void> {
    if (!this.contexts.has(context)) return
    // A successful provisional persistence is the durable commit point. Keep the
    // owning Context alive until its continuation synchronously reconciles the
    // project registries, then stop/remove it.
    const provisionalCommit = context.provisionalCommit
    if (provisionalCommit !== null) await provisionalCommit
    if (!this.contexts.has(context)) return
    this.cancelContextCompaction(context)
    context.askInteraction = null
    context.extensionCommandInvocation = null
    context.extensionDialogInteraction = null
    context.state = { ...context.state, extensionDialog: null }
    if (typeof context.state.activeSessionKey === 'string') {
      this.clearToolImageCacheForSession(context.state.activeSessionKey)
    }
    const wasActive = this.activeContext === context
    const navigationBeforeStopping = this.projectNavigationState(context.projectPath)
    context.stopRequested = true
    context.sessionNameOperation?.controller.abort()
    context.pendingSessionName = null
    context.sessionNameOperation = null
    context.state = {
      ...context.state,
      runtime: toKernelRuntime('stopping', context.runtime.getState())
    }
    if (wasActive) {
      this.state = context.state
      this.emitState()
    } else {
      // Inactive stop: only the stopping navigation transition is visible.
      this.publishContextNavigationChange(context, navigationBeforeStopping)
    }
    try {
      await context.runtime.stop()
    } catch (error) {
      // Retain ownership when stop fails so a potentially live process stays tracked.
      // Publish crashed navigation, clear the in-progress stop flag for retry, and throw.
      const navigationBeforeCrash = this.projectNavigationState(context.projectPath)
      context.stopRequested = false
      context.state = {
        ...context.state,
        extensionDialog: null,
        runtime: toKernelRuntime('crashed', context.runtime.getState(), errorMessage(error))
      }
      if (wasActive) {
        this.state = context.state
        this.emitState()
      } else {
        this.publishContextNavigationChange(context, navigationBeforeCrash)
      }
      throw error
    }
    context.unsubscribeRuntime?.()
    context.unsubscribeRuntime = null
    // Capture while still `stopping` so the stopping→stopped/removed transition is visible.
    const navigationBeforeRemoval = this.projectNavigationState(context.projectPath)
    context.state = {
      ...context.state,
      commands: createCommandCatalog(),
      advisor: { ...UNAVAILABLE_ADVISOR_STATE },
      runtime: toKernelRuntime('stopped', context.runtime.getState())
    }
    this.contexts.delete(context)
    this.contextByRuntime.delete(context.runtime)
    for (const [key, candidate] of this.contextBySessionKey) {
      if (candidate === context) this.contextBySessionKey.delete(key)
    }
    if (wasActive) {
      this.activeContext = null
      this.runtime = null
      this.unsubscribeRuntime = null
      this.provisionalSession = null
      this.provisionalCommit = null
      this.provisionalSettled = false
      this.pendingSessionName = null
      this.sessionNameOperation = null
      this.state = context.state
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
      !this.stopRequested &&
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
      const contextState = this.activeContext === context ? this.state : context.state
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
      if (this.activeContext !== context) {
        if (usageChanged) {
          context.state = {
            ...context.state,
            session: { ...context.state.session, usage }
          }
        }
        this.publishContextNavigationChange(context, navigationBefore)
        return
      }
      const navigationAfter = this.projectNavigationState(context.projectPath)
      this.state = {
        ...this.state,
        session: usageChanged ? { ...this.state.session, usage } : this.state.session,
        sessions: navigationAfter.sessions
      }
      this.emitState()
    } catch {
      // Usage is supplementary telemetry; keep the conversation usable if it is unavailable.
    }
  }

  private async refreshRenamedSession(runtime: RuntimeHost): Promise<void> {
    const result = await runtime.send({ type: 'get_state' })
    if (result.type !== 'state') throw new Error('Runtime did not return session state.')
    if (this.runtime !== runtime) return

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
    await this.captureSessionMetadata(pointer)
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

  private requireActiveAskContext(sessionKey: string, toolCallId: string): RuntimeContext {
    const context = this.activeContext
    if (
      context === null ||
      context.runtime !== this.runtime ||
      this.state.activeSessionKey !== sessionKey ||
      context.state.activeSessionKey !== sessionKey
    ) {
      throw new Error('Ask request is stale or belongs to another Session.')
    }
    if (context.askInteraction?.toolCallId !== toolCallId) {
      throw new Error('Ask request is stale or mismatched.')
    }
    return context
  }

  private requireActiveExtensionDialog(
    projectKey: string,
    sessionKey: string,
    sessionId: string,
    requestId: string,
    commandInvocationId: string
  ): { context: RuntimeContext, interaction: ExtensionDialogInteraction } {
    const context = this.activeContext
    if (
      context === null ||
      context.runtime !== this.runtime ||
      context.projectPath !== projectKey ||
      this.state.activeProjectKey !== projectKey ||
      this.state.activeSessionKey !== sessionKey ||
      this.state.session.id !== sessionId
    ) {
      throw new Error('Extension dialog is stale or belongs to another Session.')
    }
    const interaction = context.extensionDialogInteraction
    if (
      interaction?.request.requestId !== requestId ||
      interaction.request.commandInvocationId !== commandInvocationId
    ) {
      throw new Error('Extension dialog is stale or mismatched.')
    }
    if (
      context.extensionCommandInvocation?.id !== commandInvocationId ||
      context.extensionCommandInvocation.name !== interaction.request.commandName
    ) {
      throw new Error('Extension dialog command invocation is no longer active.')
    }
    if (interaction.request.status !== 'waiting') {
      throw new Error('Extension dialog response is already being submitted.')
    }
    return { context, interaction }
  }

  private handleExtensionDialogRequest(context: RuntimeContext, event: PiRpcEvent): boolean {
    const normalized = normalizeExtensionDialogRequest(event)
    if (normalized === null) return false
    const invocation = context.extensionCommandInvocation
    if (
      invocation === null ||
      !invocation.active ||
      invocation.id !== normalized.commandInvocationId ||
      invocation.name !== normalized.commandName
    ) return false
    const command = context.state.commands.find((candidate) =>
      candidate.source === 'extension' && candidate.name === normalized.commandName
    )
    if (
      command === undefined ||
      !adaptedExtensionCommandAllowsBlockingUi(command, normalized.method)
    ) return false

    const sessionKey = context.state.activeSessionKey
    const sessionId = context.state.session.id
    if (sessionKey === null || sessionId === null) return false
    const existing = context.extensionDialogInteraction
    if (existing !== null) {
      return existing.request.requestId === normalized.requestId &&
        existing.request.commandInvocationId === normalized.commandInvocationId
    }

    const request: KernelExtensionDialogRequest = {
      ...normalized,
      projectKey: context.projectPath,
      sessionKey,
      sessionId,
      status: 'waiting',
      error: null
    }
    const interaction = { request }
    context.extensionDialogInteraction = interaction
    this.updateExtensionDialogState(context, interaction, 'waiting', null)
    return true
  }

  private async deliverExtensionDialogResponse(
    context: RuntimeContext,
    interaction: ExtensionDialogInteraction,
    response: { value: string } | { cancelled: true }
  ): Promise<void> {
    this.updateExtensionDialogState(context, interaction, 'submitting', null)
    context.extensionDialogInteraction = null
    try {
      await context.runtime.send(
        'value' in response
          ? {
              type: 'extension_ui_response',
              id: interaction.request.requestId,
              value: response.value
            }
          : {
              type: 'extension_ui_response',
              id: interaction.request.requestId,
              cancelled: true
            }
      )
    } catch (error) {
      if (
        context.extensionDialogInteraction === null &&
        context.state.extensionDialog?.requestId === interaction.request.requestId
      ) {
        context.extensionDialogInteraction = interaction
        this.updateExtensionDialogState(
          context,
          interaction,
          'waiting',
          `提交失败：${errorMessage(error)}`
        )
      }
      throw error
    }
    if (
      context.extensionDialogInteraction === null &&
      context.state.extensionDialog?.requestId === interaction.request.requestId
    ) {
      this.clearExtensionDialogState(context)
    }
  }

  private updateExtensionDialogState(
    context: RuntimeContext,
    interaction: ExtensionDialogInteraction,
    status: KernelExtensionDialogRequest['status'],
    error: string | null
  ): void {
    const navigationBefore = this.projectNavigationState(context.projectPath)
    interaction.request = { ...interaction.request, status, error }
    context.state = {
      ...context.state,
      extensionDialog: {
        ...interaction.request,
        options: [...interaction.request.options]
      }
    }
    this.publishExtensionDialogState(context, navigationBefore)
  }

  private clearExtensionDialogState(context: RuntimeContext): void {
    const navigationBefore = this.projectNavigationState(context.projectPath)
    context.extensionDialogInteraction = null
    context.state = { ...context.state, extensionDialog: null }
    this.publishExtensionDialogState(context, navigationBefore)
  }

  private publishExtensionDialogState(
    context: RuntimeContext,
    navigationBefore: ProjectNavigationState
  ): void {
    if (this.activeContext === context) {
      this.state = {
        ...context.state,
        sessions: this.toSessionSummariesForProject(context.projectPath)
      }
      context.state = this.state
      this.emitState()
      return
    }
    this.publishProjectNavigationChange(context.projectPath, navigationBefore)
  }

  private handleAskUiRequest(context: RuntimeContext, event: PiRpcEvent): boolean {
    const request = normalizeAskUiRequest(event)
    if (request === null) return false

    const interaction = context.askInteraction
    if (interaction === null) {
      const candidates = context.state.conversation.entries.flatMap((entry) => {
        if (
          entry.kind !== 'tool' ||
          entry.status !== 'running' ||
          !isAskToolName(entry.name)
        ) return []
        const questions = projectAskQuestions(entry.args)
        if (questions === null) return []
        const firstQuestion = questions[0]
        if (firstQuestion === undefined) return []
        const firstStep = createInitialAskResponseStep(firstQuestion)
        return askUiRequestMatchesStep(request, firstStep)
          ? [{ toolCallId: entry.toolCallId, questions }]
          : []
      })
      if (candidates.length !== 1) return false
      const candidate = candidates[0]!
      const nextInteraction: AskInteraction = {
        toolCallId: candidate.toolCallId,
        questions: candidate.questions,
        pendingRequest: request,
        responsePlan: null,
        nextResponseIndex: 0,
        cancelling: false
      }
      const navigationBefore = this.projectNavigationState(context.projectPath)
      context.askInteraction = nextInteraction
      this.updateAskToolState(context, nextInteraction, 'waiting', null, navigationBefore)
      return true
    }

    const step = interaction.responsePlan?.[interaction.nextResponseIndex]
    if (step === undefined || !askUiRequestMatchesStep(request, step)) return false
    interaction.pendingRequest = request
    void this.deliverPendingAskResponse(context, interaction).catch(() => undefined)
    return true
  }

  private cancelUnsupportedExtensionUiRequest(context: RuntimeContext, event: PiRpcEvent): void {
    const request = unsupportedBlockingExtensionUiRequest(event)
    if (request === null) return
    void context.runtime.send({
      type: 'extension_ui_response',
      id: request.id,
      cancelled: true
    }).catch((error: unknown) => {
      const message = `Could not cancel unsupported Extension ${request.method} UI: ${errorMessage(error)}`
      const entries = projectPiEvent(context.state.conversation.entries, {
        type: 'extension_error',
        error: message
      })
      if (entries === context.state.conversation.entries) return
      const navigationBefore = this.projectNavigationState(context.projectPath)
      context.state = {
        ...context.state,
        conversation: { ...context.state.conversation, entries }
      }
      if (this.activeContext === context) {
        this.state = context.state
        this.emitState()
      } else {
        this.publishProjectNavigationChange(context.projectPath, navigationBefore)
      }
    })
  }

  private async deliverPendingAskResponse(
    context: RuntimeContext,
    interaction: AskInteraction
  ): Promise<void> {
    if (context.askInteraction !== interaction) throw new Error('Ask request became stale.')
    const pendingRequest = interaction.pendingRequest
    if (pendingRequest === null) return

    const cancelling = interaction.cancelling
    const responseIndex = interaction.nextResponseIndex
    const step = cancelling ? undefined : interaction.responsePlan?.[responseIndex]
    if (!cancelling && (step === undefined || !askUiRequestMatchesStep(pendingRequest, step))) {
      throw new Error('Ask response sequence is stale or mismatched.')
    }

    interaction.pendingRequest = null
    if (!cancelling) interaction.nextResponseIndex += 1
    try {
      await context.runtime.send(
        cancelling
          ? { type: 'extension_ui_response', id: pendingRequest.id, cancelled: true }
          : { type: 'extension_ui_response', id: pendingRequest.id, value: step!.value }
      )
    } catch (error) {
      if (context.askInteraction === interaction) {
        interaction.pendingRequest = pendingRequest
        if (!cancelling) interaction.nextResponseIndex = responseIndex
        this.updateAskToolState(
          context,
          interaction,
          'submitting',
          `回答提交失败：${errorMessage(error)}`
        )
      }
      throw error
    }
  }

  private updateAskToolState(
    context: RuntimeContext,
    interaction: AskInteraction,
    status: 'waiting' | 'submitting',
    error: string | null,
    navigationBefore = this.projectNavigationState(context.projectPath)
  ): void {
    let changed = false
    const entries = context.state.conversation.entries.map((entry) => {
      if (
        entry.kind !== 'tool' ||
        entry.toolCallId !== interaction.toolCallId ||
        entry.status !== 'running'
      ) return entry
      changed = true
      return {
        ...entry,
        ask: {
          status,
          error,
          questions: interaction.questions.map((question) => ({
            ...question,
            options: question.options.map((option) => ({ ...option }))
          }))
        }
      }
    })
    if (!changed) throw new Error('Ask tool entry is unavailable.')
    context.state = {
      ...context.state,
      conversation: { ...context.state.conversation, entries }
    }
    if (this.activeContext === context) {
      this.state = {
        ...context.state,
        sessions: this.toSessionSummariesForProject(context.projectPath)
      }
      context.state = this.state
      this.emitState()
      return
    }
    this.publishProjectNavigationChange(context.projectPath, navigationBefore)
  }

  private clearAskInteractionForEvent(
    context: RuntimeContext,
    event: PiRpcEvent
  ): ProjectNavigationState | null {
    const interaction = context.askInteraction
    if (
      interaction === null ||
      event.type !== 'tool_execution_end' ||
      event.toolCallId !== interaction.toolCallId
    ) return null
    const navigationBefore = this.projectNavigationState(context.projectPath)
    context.askInteraction = null
    return navigationBefore
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
      if (this.activeContext !== null) this.touchWarmUse(this.activeContext)
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
      if (event.kind === 'stderr') {
        this.emitPatch({
          projectKey: this.state.activeProjectKey,
          sessionKey: this.state.activeSessionKey,
          runtime: this.state.runtime
        })
      } else {
        this.emitState()
      }
      if (
        event.kind === 'process' &&
        !this.stopRequested &&
        this.state.runtime.status !== 'stopped' &&
        this.state.runtime.status !== 'stopping'
      ) {
        if (this.activeContext !== null) {
          this.failContextCompaction(
            this.activeContext,
            event.message.length > 0
              ? event.message
              : 'Runtime process terminated during compaction.'
          )
        }
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
      const exitMessage = formatExitError(event.code, event.signal)
      if (this.activeContext !== null) {
        this.failContextCompaction(this.activeContext, exitMessage)
      }
      this.transition('crashed', exitMessage)
    }
  }

  private handlePiEvent(event: PiRpcEvent): void {
    if (
      this.runtime === null ||
      this.stopRequested ||
      this.state.runtime.status === 'stopping' ||
      this.state.runtime.status === 'crashed'
    ) return

    const context = this.contextByRuntime.get(this.runtime)
    if (context === undefined) return
    if (event.type === 'extension_ui_request') {
      if (this.handleAskUiRequest(context, event)) return
      if (this.handleExtensionDialogRequest(context, event)) return
      this.cancelUnsupportedExtensionUiRequest(context, event)
    }
    const askNavigationBefore = this.clearAskInteractionForEvent(context, event)
    if (event.type === 'compaction_start') {
      this.handleCompactionStarted(context, event)
      return
    }
    if (event.type === 'compaction_end') {
      this.handleCompactionEnded(context, event)
      return
    }

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
        context.provisionalSettled = true
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
      // When automatic naming owns the in-flight set_session_name, pointer/index updates
      // are applied after persist in beginContextSessionNameGeneration so Stage 1 emits a
      // single post-persist navigation snapshot instead of a pre-persist intermediate one.
      const namingInFlight = context.sessionNameOperation !== null
      if (provisional !== null) {
        provisional.pointer = { ...provisional.pointer, sessionName }
        if (this.activeContext !== null) {
          this.activeContext.provisionalSession = provisional
        }
        if (!namingInFlight) {
          nextState = {
            ...nextState,
            sessions: this.toSessionSummaries()
          }
        }
      } else if (!namingInFlight) {
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
    if (askNavigationBefore !== null) {
      nextState = {
        ...nextState,
        sessions: this.toSessionSummariesForProject(context.projectPath)
      }
    }
    this.cacheToolImagesFromEvent(context, nextState, event)

    if (nextState !== previousState) {
      this.state = nextState
      const runtimeLifecycleChanged = nextState.runtime.status !== previousState.runtime.status
      const patch = runtimeLifecycleChanged ? null : createStatePatch(previousState, nextState)
      if (patch === null) this.emitState()
      else this.emitPatch(patch)
    }
    if (hasAssistantUsage(event)) this.requestSessionUsageRefresh(this.runtime)
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
    if (event.type === 'agent_settled') {
      this.ensureSessionNameGenerationQueued()
      this.beginSessionNameGeneration()
    }
  }

  private handleCompactionStarted(context: RuntimeContext, event: PiRpcEvent): void {
    const reason = compactionReason(event.reason)
    const projectKey = context.projectPath
    const sessionKey = context.state.activeSessionKey
    const sessionId = context.state.session.id
    if (reason === null || sessionKey === null || sessionId === null) return

    const existingLifecycle = context.compactionLifecycle
    if (existingLifecycle !== null && !existingLifecycle.settled) {
      const currentReason = context.state.session.compaction?.reason ?? null
      if (currentReason === reason) return
      if (currentReason !== null) {
        this.rejectCompactionLifecycle(
          context,
          existingLifecycle,
          { projectKey, sessionKey, sessionId, reason: currentReason },
          'failed',
          false,
          'Runtime emitted a conflicting compaction start before the previous lifecycle settled.'
        )
      } else {
        existingLifecycle.settled = true
        existingLifecycle.reject(new Error(
          'Runtime emitted a compaction start while an invalid lifecycle was still pending.'
        ))
      }
      return
    }
    context.compactionRevision += 1
    context.compactionLifecycle = createCompactionLifecycle(context.compactionRevision)
    const navigationBefore = this.projectNavigationState(projectKey)
    const nextState: KernelState = {
      ...context.state,
      session: { ...context.state.session, compaction: { reason } }
    }
    context.state = nextState
    if (this.activeContext === context) this.state = nextState
    // Inactive start: lifecycle only unless navigation truly changes.
    // Active start: always publishes (active branch of publishContextNavigationChange).
    this.publishContextNavigationChange(context, navigationBefore)
    this.emitKernelEvent({
      type: 'kernel.compaction-started',
      projectKey,
      sessionKey,
      reason
    })
  }

  private handleCompactionEnded(context: RuntimeContext, event: PiRpcEvent): void {
    const compaction = context.state.session.compaction
    const sessionKey = context.state.activeSessionKey
    const sessionId = context.state.session.id
    const lifecycle = context.compactionLifecycle
    if (
      compaction === null ||
      sessionKey === null ||
      sessionId === null ||
      lifecycle === null ||
      lifecycle.settled
    ) return
    const identity = {
      projectKey: context.projectPath,
      sessionKey,
      sessionId,
      reason: compaction.reason
    }
    if (
      compactionReason(event.reason) !== compaction.reason ||
      typeof event.willRetry !== 'boolean' ||
      typeof event.aborted !== 'boolean' ||
      !isOptionalCompactionResult(event.result)
    ) {
      this.rejectCompactionLifecycle(
        context,
        lifecycle,
        identity,
        'failed',
        false,
        'Runtime emitted an invalid compaction lifecycle.'
      )
      return
    }
    if (isCompactionResult(event.result)) {
      void this.completeCompaction(context, lifecycle, identity, event.willRetry)
      return
    }
    if (event.willRetry) {
      this.emitKernelEvent({
        type: 'kernel.compaction-ended',
        projectKey: identity.projectKey,
        sessionKey,
        reason: identity.reason,
        outcome: 'retrying',
        willRetry: true
      })
      return
    }

    const outcome = event.aborted ? 'cancelled' : 'failed'
    this.rejectCompactionLifecycle(
      context,
      lifecycle,
      identity,
      outcome,
      false,
      outcome === 'cancelled' ? 'Compaction was cancelled.' : 'Compaction failed.'
    )
  }

  private async completeCompaction(
    context: RuntimeContext,
    lifecycle: CompactionLifecycle,
    identity: {
      projectKey: string
      sessionKey: string
      sessionId: string
      reason: KernelCompactionReason
    },
    willRetry: boolean
  ): Promise<void> {
    try {
      const stateResult = await context.runtime.send({ type: 'get_state' })
      this.assertCompactionIdentity(context, lifecycle, identity)
      if (stateResult.type !== 'state') throw new Error('Runtime did not return session state.')
      const projectedSession = toKernelSession(
        stateResult.state,
        context.state.session.resumeAvailable,
        null,
        context.state.session.openAiFastMode
      )
      const sessionFile = stringValue(stateResult.state.sessionFile)
      if (projectedSession.id !== identity.sessionId || sessionFile !== identity.sessionKey) {
        throw new Error('Runtime returned compacted state for a different session.')
      }

      const messagesResult = await context.runtime.send({ type: 'get_messages' })
      this.assertCompactionIdentity(context, lifecycle, identity)
      if (messagesResult.type !== 'messages') {
        throw new Error('Runtime did not return conversation messages.')
      }

      const statisticsResult = await context.runtime.send({ type: 'get_session_stats' })
      this.assertCompactionIdentity(context, lifecycle, identity)
      if (statisticsResult.type !== 'session-statistics') {
        throw new Error('Runtime did not return session statistics.')
      }
      assertSessionStatisticsIdentity(
        statisticsResult.statistics,
        identity.sessionKey,
        identity.sessionId
      )
      const usage = toKernelSessionUsage(
        statisticsResult.statistics,
        stateResult.state.model?.contextWindow
      )
      const statistics = toKernelSessionStatistics(statisticsResult.statistics)
      // Compaction changes the model context, not the visible active-branch transcript.
      // Rebuilding from get_messages would discard pre-compaction history, so retain the
      // complete canonical Conversation already owned by this RuntimeContext.
      const entries = context.state.conversation.entries
      const nextContextState: KernelState = {
        ...context.state,
        session: {
          ...toKernelSession(
            stateResult.state,
            context.state.session.resumeAvailable,
            usage,
            context.state.session.openAiFastMode
          ),
          compaction: null
        },
        conversation: {
          entries,
          startIndex: 0,
          activeRunStartIndex: stateResult.state.isStreaming === true ? entries.length : null
        }
      }
      this.assertCompactionIdentity(context, lifecycle, identity)

      const navigationBefore = this.projectNavigationState(identity.projectKey)
      const statisticsByKey = new Map(
        this.sessionStatisticsByProject.get(identity.projectKey) ?? []
      )
      statisticsByKey.set(identity.sessionKey, statistics)
      this.sessionStatisticsByProject.set(identity.projectKey, statisticsByKey)
      context.state = nextContextState
      if (this.activeContext === context) {
        this.state = nextContextState
        if (this.state.activeProjectKey === identity.projectKey) {
          this.sessionStatisticsByKey = statisticsByKey
          this.state = { ...this.state, sessions: this.toSessionSummaries() }
        }
      } else if (this.state.activeProjectKey === identity.projectKey) {
        this.sessionStatisticsByKey = statisticsByKey
      }
      // Terminal ownership and Promise settlement are committed before synchronous
      // listener callbacks so reentrancy receives a fresh lifecycle and listener
      // failures cannot strand the completed command.
      lifecycle.settled = true
      lifecycle.resolve()
      this.publishContextNavigationChange(context, navigationBefore)
      this.emitKernelEvent({
        type: 'kernel.compaction-ended',
        projectKey: identity.projectKey,
        sessionKey: identity.sessionKey,
        reason: identity.reason,
        outcome: 'completed',
        willRetry
      })
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(errorMessage(error))
      if (lifecycle.settled) return
      if (!this.contexts.has(context) || context.compactionLifecycle !== lifecycle) {
        lifecycle.settled = true
        lifecycle.reject(failure)
        return
      }
      this.rejectCompactionLifecycle(
        context,
        lifecycle,
        identity,
        'failed',
        willRetry,
        failure.message
      )
    }
  }

  private cancelContextCompaction(context: RuntimeContext): void {
    this.settleContextCompaction(
      context,
      'cancelled',
      'Compaction was cancelled because the runtime stopped.'
    )
  }

  private failContextCompaction(context: RuntimeContext, message: string): void {
    this.settleContextCompaction(
      context,
      'failed',
      message.length > 0 ? message : 'Runtime process terminated during compaction.'
    )
  }

  private settleContextCompaction(
    context: RuntimeContext,
    outcome: 'cancelled' | 'failed',
    message: string
  ): void {
    const lifecycle = context.compactionLifecycle
    const compaction = context.state.session.compaction
    const sessionKey = context.state.activeSessionKey
    const sessionId = context.state.session.id
    if (
      lifecycle === null ||
      lifecycle.settled ||
      compaction === null ||
      sessionKey === null ||
      sessionId === null
    ) return
    this.rejectCompactionLifecycle(
      context,
      lifecycle,
      {
        projectKey: context.projectPath,
        sessionKey,
        sessionId,
        reason: compaction.reason
      },
      outcome,
      false,
      message
    )
  }

  private rejectCompactionLifecycle(
    context: RuntimeContext,
    lifecycle: CompactionLifecycle,
    identity: {
      projectKey: string
      sessionKey: string
      sessionId: string
      reason: KernelCompactionReason
    },
    outcome: 'cancelled' | 'failed',
    willRetry: boolean,
    message: string
  ): void {
    if (lifecycle.settled) return
    const navigationBefore = this.projectNavigationState(identity.projectKey)
    const failedState = {
      ...context.state,
      session: { ...context.state.session, compaction: null }
    }
    context.state = failedState
    if (this.activeContext === context) this.state = failedState
    // Mark terminal and reject before synchronous publication callbacks can reenter;
    // listener failures must not strand the originating command.
    lifecycle.settled = true
    lifecycle.reject(new Error(message))
    this.publishContextNavigationChange(context, navigationBefore)
    this.emitKernelEvent({
      type: 'kernel.compaction-ended',
      projectKey: identity.projectKey,
      sessionKey: identity.sessionKey,
      reason: identity.reason,
      outcome,
      willRetry
    })
  }

  private assertCompactionIdentity(
    context: RuntimeContext,
    lifecycle: CompactionLifecycle,
    identity: { projectKey: string, sessionKey: string, sessionId: string }
  ): void {
    if (
      lifecycle.settled ||
      !this.contexts.has(context) ||
      context.compactionLifecycle !== lifecycle ||
      context.projectPath !== identity.projectKey ||
      context.state.activeSessionKey !== identity.sessionKey ||
      context.state.session.id !== identity.sessionId
    ) {
      throw new Error('Compaction projection cancelled because the session changed.')
    }
  }

  private emitKernelEvent(event: KernelEvent): void {
    this.notifyListeners(event)
  }

  private beginProvisionalCommit(): void {
    const context = this.activeContext
    const provisional = this.provisionalSession
    if (
      context === null ||
      context.runtime !== this.runtime ||
      provisional === null ||
      provisional.runtime !== context.runtime
    ) {
      return
    }
    this.captureActiveContext()
    this.beginContextProvisionalCommit(context, provisional)
  }

  private beginBackgroundProvisionalCommit(context: RuntimeContext): void {
    const provisional = context.provisionalSession
    if (provisional === null || provisional.runtime !== context.runtime) return
    this.beginContextProvisionalCommit(context, provisional)
  }

  private beginContextProvisionalCommit(
    context: RuntimeContext,
    provisional: NonNullable<RuntimeContext['provisionalSession']>
  ): void {
    if (
      !this.contexts.has(context) ||
      context.provisionalSession !== provisional ||
      context.provisionalCommit !== null
    ) {
      return
    }
    const commit = this.commitContextProvisional(context, provisional)
    context.provisionalCommit = commit
    if (this.activeContext === context) this.provisionalCommit = commit
    void commit.finally(() => {
      if (context.provisionalCommit === commit) context.provisionalCommit = null
      if (this.activeContext === context && this.provisionalCommit === commit) {
        this.provisionalCommit = null
      }
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
        const active = this.activeContext === context
        const currentState = active ? this.state : context.state
        const previousSessionKey = currentState.activeSessionKey
        if (
          typeof previousSessionKey === 'string' &&
          previousSessionKey !== pointer.sessionFile
        ) {
          this.clearToolImageCacheForSession(previousSessionKey)
        }
        for (const [key, candidate] of this.contextBySessionKey) {
          if (candidate === context) this.contextBySessionKey.delete(key)
        }
        this.contextBySessionKey.set(contextKey(context.projectPath, pointer.sessionFile), context)
        context.provisionalSession = null
        const settleDeferred = active
          ? this.provisionalSettled
          : context.provisionalSettled
        let nextState: KernelState = {
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
        if (active) {
          this.provisionalSession = null
          this.provisionalSettled = false
          this.state = nextState
        }
        if (pointer.sessionName === null && provisional.initialPrompt !== null) {
          const existingPending = context.pendingSessionName
          if (
            existingPending !== null &&
            existingPending.runtime === context.runtime &&
            existingPending.sessionId === pointer.sessionId
          ) {
            existingPending.sessionFile = pointer.sessionFile
            if (active) this.pendingSessionName = existingPending
          } else if (!provisional.sessionNameAttempted) {
            provisional.sessionNameAttempted = true
            const pending = {
              runtime: context.runtime,
              sessionFile: pointer.sessionFile,
              sessionId: pointer.sessionId,
              userMessage: provisional.initialPrompt
            }
            context.pendingSessionName = pending
            if (active) this.pendingSessionName = pending
            if (
              context.state.runtime.status === 'ready' ||
              context.state.runtime.status === 'running'
            ) {
              this.beginBackgroundSessionNameGeneration(context, pending)
            }
          }
        }
      }
      if (this.state.activeProjectKey === context.projectPath) {
        this.sessionPointers = pointers
        this.sessionActivityAtByKey = activities
        this.sessionStatisticsByKey = statisticsByKey
      }
      if (stillOwned) this.publishContextNavigationChange(context, navigationBefore)
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
            this.beginContextProvisionalCommit(context, provisional)
          }, 0)
        } else if (this.activeContext === context) {
          this.emitState()
        }
        return
      }
      const navigationBefore = this.projectNavigationState(context.projectPath)
      const active = this.activeContext === context
      const currentState = active ? this.state : context.state
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
      if (active) {
        this.provisionalSession = null
        this.provisionalSettled = false
        this.state = nextState
      }
      this.publishContextNavigationChange(context, navigationBefore)
    }
  }

  private ensureSessionNameGenerationQueued(): void {
    if (this.runtime === null || this.state.session.name !== null) return
    if (this.pendingSessionName !== null) return
    if (this.provisionalSession?.runtime === this.runtime) return
    const sessionFile = this.state.activeSessionKey
    if (sessionFile === null) return
    const pointer = this.sessionPointers.find((candidate) => candidate.sessionFile === sessionFile)
    if (pointer === undefined || pointer.sessionName !== null) return
    this.queueSessionNameGeneration(
      this.runtime,
      pointer,
      firstUserMessage(this.state.conversation.entries)
    )
  }

  private beginSessionNameGeneration(): void {
    const pending = this.pendingSessionName
    if (pending === null) return
    const context = this.contextByRuntime.get(pending.runtime)
    if (context === undefined) {
      this.pendingSessionName = null
      return
    }
    // Naming is owned by the runtime context so switching away cannot drop the result.
    context.pendingSessionName = pending
    this.beginContextSessionNameGeneration(context, pending)
  }

  private beginBackgroundSessionNameGeneration(
    context: RuntimeContext,
    pending: NonNullable<RuntimeContext['pendingSessionName']>
  ): void {
    this.beginContextSessionNameGeneration(context, pending)
  }

  private beginContextSessionNameGeneration(
    context: RuntimeContext,
    pending: NonNullable<RuntimeContext['pendingSessionName']>
  ): void {
    if (context.sessionNameOperation !== null) return
    if (this.generateSessionName === undefined) {
      this.clearSessionNamePending(context, pending)
      return
    }
    if (
      context.state.runtime.status !== 'ready' &&
      context.state.runtime.status !== 'running'
    ) return
    if (context.state.session.name !== null) {
      this.clearSessionNamePending(context, pending)
      return
    }

    const model = selectSessionNameModel(
      this.state.sessionNaming,
      context.state.availableModels,
      context.state.session.model?.provider ?? null
    )
    const executable = context.runtime.getState().executable
    if (model === null || executable === null) {
      this.clearSessionNamePending(context, pending)
      return
    }

    const controller = new AbortController()
    const operation = { runtime: context.runtime, controller }
    context.sessionNameOperation = operation
    context.pendingSessionName = pending
    if (this.activeContext === context) {
      this.sessionNameOperation = operation
      this.pendingSessionName = pending
    }

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
        !this.contexts.has(context) ||
        (
          context.state.runtime.status !== 'ready' &&
          context.state.runtime.status !== 'running'
        ) ||
        context.state.session.name !== null
      ) return

      await context.runtime.send({ type: 'set_session_name', name })
      if (
        controller.signal.aborted ||
        context.sessionNameOperation !== operation ||
        context.pendingSessionName !== pending ||
        !this.contexts.has(context)
      ) return

      const pointersForProject = this.sessionPointersByProject.get(context.projectPath) ?? (
        this.state.activeProjectKey === context.projectPath ? this.sessionPointers : []
      )
      const pointer = pointersForProject.find(({ sessionFile }) => sessionFile === pending.sessionFile)
      if (pointer === undefined || controller.signal.aborted) return

      const renamed = { ...pointer, sessionName: name }
      await this.persistSession(renamed)
      if (
        controller.signal.aborted ||
        context.sessionNameOperation !== operation ||
        !this.contexts.has(context)
      ) return

      const navigationBefore = this.projectNavigationState(context.projectPath)
      const pointers = upsertSessionPointer(
        this.sessionPointersByProject.get(context.projectPath) ?? pointersForProject,
        renamed
      )
      this.sessionPointersByProject.set(context.projectPath, pointers)
      context.state = {
        ...context.state,
        session: { ...context.state.session, name }
      }

      if (this.activeContext === context) {
        this.sessionPointers = pointers
        this.state = {
          ...this.state,
          sessions: this.toSessionSummaries(),
          session: { ...this.state.session, name }
        }
        this.emitState()
        return
      }

      if (this.state.activeProjectKey === context.projectPath) {
        this.sessionPointers = pointers
      }
      // Emit only after the name is persisted so navigation and durable index stay aligned.
      this.publishContextNavigationChange(context, navigationBefore)
    }).catch(() => {
      // Automatic naming remains best-effort metadata enrichment.
    }).finally(() => {
      if (context.sessionNameOperation === operation) context.sessionNameOperation = null
      if (context.pendingSessionName === pending) context.pendingSessionName = null
      if (this.sessionNameOperation === operation) this.sessionNameOperation = null
      if (this.pendingSessionName === pending) this.pendingSessionName = null
    })
  }

  private queueSessionNameGeneration(
    runtime: RuntimeHost,
    pointer: SessionPointer,
    userMessage: string | null
  ): void {
    const pending = pointer.sessionName === null && userMessage !== null
      ? {
          runtime,
          sessionFile: pointer.sessionFile,
          sessionId: pointer.sessionId,
          userMessage
        }
      : null
    this.pendingSessionName = pending
    const context = this.contextByRuntime.get(runtime)
    if (context !== undefined) context.pendingSessionName = pending
  }

  private clearSessionNamePending(
    context: RuntimeContext,
    pending: NonNullable<RuntimeContext['pendingSessionName']>
  ): void {
    if (context.pendingSessionName === pending) context.pendingSessionName = null
    if (this.pendingSessionName === pending) this.pendingSessionName = null
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
    for (const context of this.contexts) {
      if (runtime !== undefined && context.runtime !== runtime) continue
      if (context.pendingSessionName !== null) context.pendingSessionName = null
      if (context.sessionNameOperation !== null) {
        const operation = context.sessionNameOperation
        context.sessionNameOperation = null
        operation.controller.abort()
      }
    }
  }

  private cacheToolImagesFromEvent(
    context: RuntimeContext,
    state: KernelState,
    event: PiRpcEvent
  ): void {
    if (event.type !== 'tool_execution_end') return
    const sessionKey = state.activeSessionKey
    const sessionId = state.session.id
    if (sessionKey === null || sessionId === null || !isAbsolute(sessionKey)) return
    if (
      !this.contexts.has(context) ||
      this.contextByRuntime.get(context.runtime) !== context ||
      context.projectPath !== state.activeProjectKey
    ) return
    const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : null
    if (toolCallId === null || toolCallId.length === 0 || toolCallId.length > 256) return
    const toolName = typeof event.toolName === 'string' ? event.toolName : ''

    // A terminal event atomically replaces every cached partial/result image for the tool.
    this.clearToolImageCacheForTool(context.projectPath, sessionId, sessionKey, toolCallId)
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

    const cachedAt = this.now()
    this.pruneToolImageCache(cachedAt)
    for (const image of images) {
      const key = toolImageCacheKey(
        context.projectPath,
        sessionId,
        sessionKey,
        toolCallId,
        image.contentIndex
      )
      this.toolImageCache.set(key, {
        projectPath: context.projectPath,
        sessionKey,
        sessionId,
        runtime: context.runtime,
        cachedAt,
        base64Chars: image.data.length,
        image: {
          mimeType: image.mimeType,
          data: image.data,
          name: image.name.length > 0 ? image.name : `image-${image.contentIndex + 1}`,
          path: ''
        }
      })
    }
    this.pruneToolImageCache(cachedAt)
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
    this.pruneToolImageCache(now)
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
    const key = toolImageCacheKey(projectPath, sessionId, sessionKey, toolCallId, contentIndex)
    const cached = this.toolImageCache.get(key)
    if (
      cached === undefined ||
      cached.runtime !== context.runtime ||
      cached.cachedAt + TOOL_IMAGE_CACHE_TTL_MS <= now
    ) {
      throw new ToolResultMessageNotFoundError(toolCallId)
    }
    return { ...cached.image }
  }

  private deleteCachedToolImage(
    projectPath: string,
    sessionId: string | null,
    sessionKey: string,
    toolCallId: string,
    contentIndex: number
  ): void {
    if (sessionId === null) return
    this.toolImageCache.delete(
      toolImageCacheKey(projectPath, sessionId, sessionKey, toolCallId, contentIndex)
    )
  }

  private clearToolImageCacheForSession(sessionKey: string): void {
    for (const [key, cached] of this.toolImageCache) {
      if (cached.sessionKey === sessionKey) this.toolImageCache.delete(key)
    }
  }

  private clearToolImageCacheForTool(
    projectPath: string,
    sessionId: string,
    sessionKey: string,
    toolCallId: string
  ): void {
    const prefix = `${projectPath}\0${sessionId}\0${sessionKey}\0${toolCallId}\0`
    for (const key of this.toolImageCache.keys()) {
      if (key.startsWith(prefix)) this.toolImageCache.delete(key)
    }
  }

  private pruneToolImageCache(now = this.now()): void {
    for (const [key, cached] of this.toolImageCache) {
      if (cached.cachedAt + TOOL_IMAGE_CACHE_TTL_MS <= now) this.toolImageCache.delete(key)
    }
    let totalBase64Chars = 0
    for (const cached of this.toolImageCache.values()) totalBase64Chars += cached.base64Chars
    for (const [key, cached] of this.toolImageCache) {
      if (
        this.toolImageCache.size <= MAX_TOOL_IMAGE_CACHE_ENTRIES &&
        totalBase64Chars <= MAX_TOOL_IMAGE_CACHE_BASE64_CHARS
      ) break
      this.toolImageCache.delete(key)
      totalBase64Chars -= cached.base64Chars
    }
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
    const entries = await Promise.all(pointers.map(async (pointer) => [
      pointer.sessionFile,
      await this.readSessionActivityAt(pointer)
    ] as const))
    return new Map(entries)
  }

  private async loadSessionMetadata(
    pointers: SessionPointer[]
  ): Promise<{
    activityAtByKey: Map<string, number | null>
    statisticsByKey: Map<string, KernelSessionStatistics | null>
  }> {
    const entries = await Promise.all(pointers.map(async (pointer) => [
      pointer.sessionFile,
      await this.readSessionMetadataForPointer(pointer)
    ] as const))
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

  private withActiveSessionActivity(state: KernelState): KernelState {
    if (state.activeSessionKey === null) return state
    const activityAt = this.now()
    this.sessionActivityAtByKey.set(state.activeSessionKey, activityAt)
    if (
      this.provisionalSession?.runtime === this.runtime &&
      this.provisionalSession.pointer.sessionFile === state.activeSessionKey
    ) {
      this.provisionalSession.activityAt = activityAt
      if (this.activeContext !== null) {
        this.activeContext.provisionalSession = this.provisionalSession
      }
    }
    return {
      ...state,
      sessions: this.toSessionSummaries()
    }
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
      const provisional = this.activeContext === context
        ? this.provisionalSession
        : context.provisionalSession
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
      const provisional = this.activeContext === context
        ? this.provisionalSession
        : context.provisionalSession
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
    const provisional = this.provisionalSession
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

  private clearProvisionalSession(runtime: RuntimeHost): void {
    if (this.provisionalSession?.runtime !== runtime) return
    this.provisionalSession = null
    this.provisionalSettled = false
    if (this.activeContext !== null) this.activeContext.provisionalSession = null
    this.clearUnregisteredActiveSessionKey()
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
    this.clearActiveRuntimeProjection()
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

    this.clearActiveRuntimeProjection()
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

  private clearActiveRuntimeProjection(): void {
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
    // Kernel state transitions are immutable. RuntimeContext retains the current object
    // graph by reference; defensive full-state copies remain only at external snapshot
    // boundaries such as getState()/IPC delivery.
    this.captureActiveContextWithState(this.state)
  }

  private captureActiveContextWithState(state: KernelState): void {
    const context = this.activeContext
    if (context === null || this.runtime !== context.runtime) return
    context.state = state
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
    this.sessionStatisticsByProject.set(context.projectPath, this.sessionStatisticsByKey)
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
    this.sessionStatisticsByKey =
      this.sessionStatisticsByProject.get(context.projectPath) ?? new Map()
    this.state = {
      ...context.state,
      projects: shared.projects,
      activeProjectKey: context.projectPath,
      sessions: [],
      sessionNaming: shared.sessionNaming,
      appearance: shared.appearance,
      general: shared.general,
      subagent: shared.subagent,
      shortcuts: shared.shortcuts,
      extensions: shared.extensions
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
    if (this.activeContext === context) {
      this.handleRuntimeEvent(event)
      return
    }

    // Stage 2B: every inactive RuntimeHostEvent is Context-local. Workspace
    // selection remains only for explicit activation/launch restoration.
    this.handleInactiveRuntimeEvent(context, event)
  }

  /**
   * Stage 2B inactive host/lifecycle/metadata/compaction dispatch. Mutates only
   * the owning context and project maps. Never swaps the active workspace.
   */
  private handleInactiveRuntimeEvent(context: RuntimeContext, event: RuntimeHostEvent): void {
    if (
      (context.stopRequested || context.state.runtime.status === 'stopping') &&
      (
        event.type === 'activity-started' ||
        event.type === 'activity-settled' ||
        event.type === 'pi-event'
      )
    ) {
      return
    }

    if (event.type === 'activity-started') {
      this.handleInactiveActivityStarted(context)
      return
    }
    if (event.type === 'activity-settled') {
      this.handleInactiveActivitySettled(context)
      return
    }
    if (event.type === 'pi-event') {
      this.handleInactivePiEvent(context, event.event)
      return
    }
    if (event.type === 'diagnostic') {
      this.handleInactiveDiagnostic(context, event)
      return
    }
    this.handleInactiveProcessExit(context, event)
  }

  private handleInactiveActivityStarted(context: RuntimeContext): void {
    if (context.state.runtime.status !== 'ready') return
    this.touchWarmUse(context)
    const navigationBefore = this.projectNavigationState(context.projectPath)
    context.state = {
      ...context.state,
      runtime: toKernelRuntime('running', context.runtime.getState()),
      session: { ...context.state.session, settled: false },
      conversation: beginConversationRun(context.state.conversation)
    }
    this.publishContextNavigationChange(context, navigationBefore)
  }

  private handleInactiveActivitySettled(context: RuntimeContext): void {
    if (context.state.runtime.status !== 'running') return
    const navigationBefore = this.projectNavigationState(context.projectPath)
    if (context.provisionalCommit !== null) {
      context.provisionalSettled = true
      return
    }
    context.state = this.withContextSessionActivity(context, {
      ...context.state,
      runtime: toKernelRuntime('ready', context.runtime.getState()),
      session: { ...context.state.session, settled: true },
      conversation: settleConversationRun(context.state.conversation)
    })
    this.publishContextNavigationChange(context, navigationBefore)
  }

  private handleInactivePiEvent(context: RuntimeContext, event: PiRpcEvent): void {
    if (
      context.stopRequested ||
      context.state.runtime.status === 'stopping' ||
      context.state.runtime.status === 'crashed'
    ) {
      return
    }

    if (event.type === 'extension_ui_request') {
      if (this.handleAskUiRequest(context, event)) return
      if (this.handleExtensionDialogRequest(context, event)) return
      this.cancelUnsupportedExtensionUiRequest(context, event)
    }
    const askNavigationBefore = this.clearAskInteractionForEvent(context, event)
    if (event.type === 'compaction_start') {
      this.handleCompactionStarted(context, event)
      return
    }
    if (event.type === 'compaction_end') {
      this.handleCompactionEnded(context, event)
      return
    }
    if (event.type === 'agent_start') {
      this.handleInactiveAgentStart(context)
      return
    }
    if (event.type === 'agent_settled') {
      this.handleInactiveAgentSettled(context)
      return
    }
    if (event.type === 'queue_update') {
      this.handleInactiveQueueUpdate(context, event)
      return
    }
    if (event.type === 'session_info_changed' && typeof event.name === 'string') {
      this.handleInactiveSessionInfoChanged(context, event.name)
      return
    }

    // Ordinary Stage 2A streaming plus unknown/custom Pi events stay Conversation-local.
    this.handleInactiveOrdinaryPiEvent(context, event)
    if (askNavigationBefore !== null) {
      this.publishProjectNavigationChange(context.projectPath, askNavigationBefore)
    }
  }

  private handleInactiveAgentStart(context: RuntimeContext): void {
    const navigationBefore = this.projectNavigationState(context.projectPath)
    context.state = {
      ...context.state,
      runtime: toKernelRuntime('running', context.runtime.getState()),
      session: { ...context.state.session, settled: false },
      conversation: beginConversationRun(context.state.conversation)
    }
    this.publishContextNavigationChange(context, navigationBefore)
  }

  private handleInactiveAgentSettled(context: RuntimeContext): void {
    const navigationBefore = this.projectNavigationState(context.projectPath)
    if (context.provisionalSession?.runtime === context.runtime) {
      context.provisionalSettled = true
      this.beginBackgroundProvisionalCommit(context)
      return
    }

    context.state = this.withContextSessionActivity(context, {
      ...context.state,
      runtime: toKernelRuntime('ready', context.runtime.getState()),
      session: {
        ...context.state.session,
        settled: true,
        pendingMessageCount: 0,
        pendingSteeringMessages: [],
        pendingFollowUpMessages: []
      },
      conversation: settleConversationRun(context.state.conversation)
    })
    this.publishContextNavigationChange(context, navigationBefore)
    this.ensureContextSessionNameGenerationQueued(context)
    if (context.pendingSessionName !== null) {
      this.beginBackgroundSessionNameGeneration(context, context.pendingSessionName)
    }
  }

  private handleInactiveQueueUpdate(context: RuntimeContext, event: PiRpcEvent): void {
    const { steering, followUp } = event
    if (
      !Array.isArray(steering) ||
      !steering.every((message): message is string => typeof message === 'string') ||
      !Array.isArray(followUp) ||
      !followUp.every((message): message is string => typeof message === 'string')
    ) {
      return
    }
    const pendingSteeringMessages = steering.map(stripPromptFileBlocks)
    const pendingFollowUpMessages = followUp.map(stripPromptFileBlocks)
    context.state = {
      ...context.state,
      session: {
        ...context.state.session,
        pendingMessageCount: pendingSteeringMessages.length + pendingFollowUpMessages.length,
        pendingSteeringMessages,
        pendingFollowUpMessages
      }
    }
  }

  private handleInactiveSessionInfoChanged(context: RuntimeContext, sessionName: string): void {
    const navigationBefore = this.projectNavigationState(context.projectPath)
    const namingInFlight = context.sessionNameOperation !== null
    const provisional = context.provisionalSession

    if (provisional !== null) {
      provisional.pointer = { ...provisional.pointer, sessionName }
    } else if (!namingInFlight) {
      const sessionKey = context.state.activeSessionKey
      if (sessionKey !== null) {
        const pointers =
          this.sessionPointersByProject.get(context.projectPath) ??
          (this.state.activeProjectKey === context.projectPath ? this.sessionPointers : [])
        const pointerIndex = pointers.findIndex((pointer) => pointer.sessionFile === sessionKey)
        if (pointerIndex !== -1) {
          const nextPointers = pointers.map((pointer, index) =>
            index === pointerIndex ? { ...pointer, sessionName } : pointer
          )
          this.sessionPointersByProject.set(context.projectPath, nextPointers)
          if (this.state.activeProjectKey === context.projectPath) {
            this.sessionPointers = nextPointers
          }
        }
      }
    }

    context.state = {
      ...context.state,
      session: { ...context.state.session, name: sessionName }
    }

    // Automatic naming owns the single post-persist navigation snapshot.
    if (!namingInFlight) {
      this.publishContextNavigationChange(context, navigationBefore)
    }
  }

  private handleInactiveDiagnostic(
    context: RuntimeContext,
    event: Extract<RuntimeHostEvent, { type: 'diagnostic' }>
  ): void {
    const navigationBefore = this.projectNavigationState(context.projectPath)
    const hostState = context.runtime.getState()
    context.state = {
      ...context.state,
      runtime: toKernelRuntime(
        context.state.runtime.status,
        hostState,
        event.kind === 'stderr' ? undefined : event.message
      )
    }
    if (
      event.kind === 'process' &&
      !context.stopRequested &&
      context.state.runtime.status !== 'stopped' &&
      context.state.runtime.status !== 'stopping'
    ) {
      this.failContextCompaction(
        context,
        event.message.length > 0
          ? event.message
          : 'Runtime process terminated during compaction.'
      )
      this.transitionContext(context, 'crashed', event.message)
    }
    this.publishContextNavigationChange(context, navigationBefore)
  }

  private handleInactiveProcessExit(
    context: RuntimeContext,
    event: Extract<RuntimeHostEvent, { type: 'process-exit' }>
  ): void {
    const navigationBefore = this.projectNavigationState(context.projectPath)
    const hostState = context.runtime.getState()
    context.state = {
      ...context.state,
      runtime: toKernelRuntime(context.state.runtime.status, {
        ...hostState,
        exitCode: event.code,
        exitSignal: event.signal
      })
    }
    if (
      !context.stopRequested &&
      context.state.runtime.status !== 'stopped' &&
      context.state.runtime.status !== 'stopping'
    ) {
      const exitMessage = formatExitError(event.code, event.signal)
      this.failContextCompaction(context, exitMessage)
      this.transitionContext(context, 'crashed', exitMessage)
    }
    this.publishContextNavigationChange(context, navigationBefore)
  }

  private transitionContext(
    context: RuntimeContext,
    status: RuntimeStatus,
    lastError?: string
  ): void {
    if (status === 'crashed') {
      this.cancelSessionNameGeneration(context.runtime)
      context.extensionCommandInvocation = null
      context.extensionDialogInteraction = null
    }
    context.state = {
      ...context.state,
      ...(status === 'crashed' ? { extensionDialog: null } : {}),
      runtime: toKernelRuntime(status, context.runtime.getState(), lastError)
    }
  }

  private withContextSessionActivity(
    context: RuntimeContext,
    state: KernelState
  ): KernelState {
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

  private ensureContextSessionNameGenerationQueued(context: RuntimeContext): void {
    if (context.state.session.name !== null) return
    if (context.pendingSessionName !== null) return
    if (context.provisionalSession?.runtime === context.runtime) return
    const sessionFile = context.state.activeSessionKey
    if (sessionFile === null) return
    const pointers =
      this.sessionPointersByProject.get(context.projectPath) ??
      (this.state.activeProjectKey === context.projectPath ? this.sessionPointers : [])
    const pointer = pointers.find((candidate) => candidate.sessionFile === sessionFile)
    if (pointer === undefined || pointer.sessionName !== null) return
    const userMessage = firstUserMessage(context.state.conversation.entries)
    const pending = userMessage !== null
      ? {
          runtime: context.runtime,
          sessionFile: pointer.sessionFile,
          sessionId: pointer.sessionId,
          userMessage
        }
      : null
    context.pendingSessionName = pending
    if (this.activeContext === context) {
      this.pendingSessionName = pending
    }
  }

  /**
   * Stage 2A/2B inactive ordinary streaming and unknown/custom Pi events: mutate
   * only `context.state` / use `context.runtime`. Never assign the active execution
   * workspace (`this.state`/`this.runtime`/`activeContext`/provisional-name mirrors).
   */
  private handleInactiveOrdinaryPiEvent(context: RuntimeContext, event: PiRpcEvent): void {
    const previousState = context.state
    let nextState = previousState

    if (event.type === 'message_end') {
      nextState = {
        ...nextState,
        session: {
          ...nextState.session,
          messageCount: nextState.session.messageCount + 1
        }
      }
    }

    const entries = projectPiEvent(nextState.conversation.entries, event)
    if (entries !== nextState.conversation.entries) {
      nextState = {
        ...nextState,
        conversation: { ...nextState.conversation, entries }
      }
    }
    this.cacheToolImagesFromEvent(context, nextState, event)

    if (nextState !== previousState) {
      context.state = nextState
    }

    // This synchronous subset changes only Conversation/messageCount. Usage and
    // provisional materialization publish their own bounded navigation effects.
    if (hasAssistantUsage(event)) {
      this.requestSessionUsageRefresh(context.runtime)
    }

    if (
      event.type === 'message_end' &&
      typeof event.message === 'object' &&
      event.message !== null &&
      'role' in event.message &&
      event.message.role === 'assistant' &&
      context.provisionalSession?.runtime === context.runtime
    ) {
      this.beginBackgroundProvisionalCommit(context)
    }
  }

  /**
   * Stage 1 inactive-context publication: after mutating `sourceContext`, emit at most one
   * full-state snapshot when the bounded project navigation projection changed. Active
   * contexts publish normally. Never temporarily projects an inactive Conversation.
   */
  private publishContextNavigationChange(
    sourceContext: RuntimeContext,
    navigationBefore: ProjectNavigationState
  ): void {
    if (!this.contexts.has(sourceContext)) return
    if (this.contextByRuntime.get(sourceContext.runtime) !== sourceContext) return
    if (this.activeContext === sourceContext) {
      this.emitState()
      return
    }
    this.publishProjectNavigationChange(sourceContext.projectPath, navigationBefore)
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

  private transition(status: RuntimeStatus, lastError?: string): void {
    if (status === 'crashed') {
      this.cancelSessionNameGeneration(this.runtime ?? undefined)
      if (this.activeContext !== null) {
        this.activeContext.extensionCommandInvocation = null
        this.activeContext.extensionDialogInteraction = null
      }
    }
    this.state = {
      ...this.state,
      ...(status === 'crashed' ? { extensionDialog: null } : {}),
      runtime: toKernelRuntime(status, this.runtime?.getState() ?? INITIAL_HOST_STATE, lastError)
    }
    if (status === 'crashed' && this.activeContext !== null) {
      this.activeContext.state = this.state
      this.state = { ...this.state, sessions: this.toSessionSummaries() }
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

function metadataCacheForPointers<T>(
  pointers: SessionPointer[],
  cached: ReadonlyMap<string, T | null> | undefined
): Map<string, T | null> {
  return new Map(pointers.map((pointer) => [
    pointer.sessionFile,
    cached?.get(pointer.sessionFile) ?? null
  ]))
}

function mergeRefreshedMetadata<T>(
  pointers: SessionPointer[],
  refreshed: ReadonlyMap<string, T | null>,
  current: ReadonlyMap<string, T | null>,
  baseline: ReadonlyMap<string, T | null>
): Map<string, T | null> {
  return new Map(pointers.map((pointer) => {
    const sessionFile = pointer.sessionFile
    const currentHasValue = current.has(sessionFile)
    const changedDuringRefresh =
      currentHasValue !== baseline.has(sessionFile) ||
      !Object.is(current.get(sessionFile), baseline.get(sessionFile))
    const value = changedDuringRefresh
      ? (currentHasValue ? current.get(sessionFile) ?? null : null)
      : refreshed.get(sessionFile) ?? null
    return [sessionFile, value] as const
  }))
}

function configuredProject(state: Pick<KernelState, 'projects' | 'activeProjectKey'>): { path: string } {
  const project = activeProject(state)
  if (project === null) throw new Error('Select a project directory before starting.')
  return project
}

function isSessionExportRuntimeStatusAllowed(status: RuntimeStatus): boolean {
  return status !== 'starting' && status !== 'running' && status !== 'stopping'
}

function initialKernelState(
  projectRegistry: Pick<KernelState, 'projects' | 'activeProjectKey'>,
  sessionRegistry: ProjectSessionRegistry,
  sessionActivityAtByKey: ReadonlyMap<string, number | null>,
  sessionStatisticsByKey: ReadonlyMap<string, KernelSessionStatistics | null>,
  sessionNaming: SessionNamingSettings,
  appearance: AppearanceSettings,
  general: GeneralSettings,
  subagent: SubagentSettings,
  shortcuts: ShortcutSettings,
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
    navigatorKind: workspaceKind(project),
    activeProjectKey: projectRegistry.activeProjectKey,
    sessions: toKernelSessionSummaries(
      matchingRegistry.sessions,
      sessionActivityAtByKey,
      sessionStatisticsByKey
    ),
    activeSessionKey: matchingRegistry.activeSessionKey,
    projectTrustRequest: null,
    extensionDialog: null,
    commands: createCommandCatalog(),
    extensions: extensions.map((extension) => ({ ...extension })),
    availableModels: [],
    sessionNaming: copySessionNamingSettings(sessionNaming),
    appearance: copyAppearanceSettings(appearance),
    general: copyGeneralSettings(general),
    subagent: copySubagentSettings(subagent),
    shortcuts: copyShortcutSettings(shortcuts),
    advisor: { ...UNAVAILABLE_ADVISOR_STATE },
    runtime: toKernelRuntime('stopped', INITIAL_HOST_STATE),
    session: activePointer === null
      ? { ...INITIAL_SESSION_STATE }
      : {
          ...INITIAL_SESSION_STATE,
          id: activePointer.sessionId,
          name: activePointer.sessionName,
          resumeAvailable: true
        },
    conversation: { entries: [], startIndex: 0, activeRunStartIndex: null }
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

function assertSessionStatisticsIdentity(
  statistics: PiRpcSessionStats,
  sessionFile: string,
  sessionId: string
): void {
  if (
    statistics.sessionId !== sessionId ||
    (statistics.sessionFile !== undefined && statistics.sessionFile !== sessionFile)
  ) {
    throw new Error('Runtime returned statistics for a different session.')
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
  sessionStatisticsByKey: ReadonlyMap<string, KernelSessionStatistics | null>,
  runtimeStatus: (sessionKey: string) => RuntimeStatus = () => 'stopped',
  requiresReload: (sessionKey: string) => boolean = () => false,
  awaitingUserInput: (sessionKey: string) => boolean = () => false
): KernelSessionSummary[] {
  const summaries = pointers.map((pointer) => ({
    key: pointer.sessionFile,
    id: pointer.sessionId,
    name: pointer.sessionName,
    lastActivityAt: sessionActivityAtByKey.get(pointer.sessionFile) ?? null,
    runtimeStatus: runtimeStatus(pointer.sessionFile),
    awaitingUserInput: awaitingUserInput(pointer.sessionFile),
    ...(requiresReload(pointer.sessionFile) ? { requiresReload: true } : {}),
    statistics: sessionStatisticsByKey.get(pointer.sessionFile) ?? null
  }))
  return sortSessionSummaries(summaries)
}

function mergeProvisionalSessionSummaries(
  registered: KernelSessionSummary[],
  provisional: KernelSessionSummary[]
): KernelSessionSummary[] {
  if (provisional.length === 0) return registered
  const registeredKeys = new Set(registered.map((summary) => summary.key))
  const extras = provisional.filter((summary) => !registeredKeys.has(summary.key))
  if (extras.length === 0) return registered
  return sortSessionSummaries([...extras, ...registered])
}

function sortSessionSummaries(summaries: KernelSessionSummary[]): KernelSessionSummary[] {
  return summaries
    .map((summary, index) => ({ summary, index }))
    .sort((left, right) => {
      const leftRunning = left.summary.runtimeStatus === 'running'
      const rightRunning = right.summary.runtimeStatus === 'running'
      if (leftRunning !== rightRunning) return leftRunning ? -1 : 1
      const leftActivity = left.summary.lastActivityAt
      const rightActivity = right.summary.lastActivityAt
      if (leftActivity === rightActivity) return left.index - right.index
      if (leftActivity === null) return 1
      if (rightActivity === null) return -1
      return rightActivity - leftActivity
    })
    .map(({ summary }) => summary)
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

function sameProjectNavigationState(
  current: ProjectNavigationState,
  next: ProjectNavigationState
): boolean {
  return current.busySessionCount === next.busySessionCount &&
    current.sessions.length === next.sessions.length &&
    current.sessions.every((session, index) => {
      const other = next.sessions[index]
      return other !== undefined &&
        session.key === other.key &&
        session.id === other.id &&
        session.name === other.name &&
        session.lastActivityAt === other.lastActivityAt &&
        session.runtimeStatus === other.runtimeStatus &&
        session.awaitingUserInput === other.awaitingUserInput &&
        session.requiresReload === other.requiresReload &&
        session.provisional === other.provisional &&
        sameSessionStatistics(session.statistics, other.statistics)
    })
}

function sameSessionStatistics(
  current: KernelSessionStatistics | null,
  next: KernelSessionStatistics | null
): boolean {
  if (current === next) return true
  if (current === null || next === null) return false
  return current.userMessages === next.userMessages &&
    current.assistantMessages === next.assistantMessages &&
    current.toolCalls === next.toolCalls &&
    current.toolResults === next.toolResults &&
    current.totalMessages === next.totalMessages &&
    current.inputTokens === next.inputTokens &&
    current.outputTokens === next.outputTokens &&
    current.cacheReadTokens === next.cacheReadTokens &&
    current.cacheWriteTokens === next.cacheWriteTokens &&
    current.totalTokens === next.totalTokens &&
    current.cost === next.cost
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

function workspaceKind(project: KernelProjectState | null): 'project' | 'task' {
  return project?.workspaceKind === 'task' ? 'task' : 'project'
}

function assertProjectRegistry(
  registry: Pick<KernelState, 'projects' | 'activeProjectKey'>
): void {
  if (
    registry.projects.some((project) =>
      !isAbsolute(project.path) ||
      (workspaceKind(project) === 'task'
        ? typeof project.taskKey !== 'string' || project.taskKey.trim().length === 0
        : project.taskKey !== undefined)
    ) ||
    new Set(registry.projects.map((project) => project.path)).size !== registry.projects.length ||
    new Set(
      registry.projects
        .filter((project) => workspaceKind(project) === 'task')
        .map((project) => project.taskKey)
    ).size !== registry.projects.filter((project) => workspaceKind(project) === 'task').length ||
    (registry.activeProjectKey !== null && activeProject(registry) === null)
  ) {
    throw new Error('Invalid Workbench project registry.')
  }
}

function copySessionSummary(session: KernelSessionSummary): KernelSessionSummary {
  return {
    ...session,
    ...(session.provisional === true ? { provisional: true as const } : {}),
    statistics: session.statistics === null ? null : { ...session.statistics }
  }
}

function copyState(
  state: KernelState,
  conversation: KernelConversationState = state.conversation
): KernelState {
  return {
    projects: state.projects.map((project) => ({
      ...project,
      ...(project.sessions === undefined
        ? {}
        : { sessions: project.sessions.map(copySessionSummary) })
    })),
    navigatorKind: state.navigatorKind,
    activeProjectKey: state.activeProjectKey,
    sessions: state.sessions.map(copySessionSummary),
    activeSessionKey: state.activeSessionKey,
    projectTrustRequest: state.projectTrustRequest === null
      ? null
      : { ...state.projectTrustRequest },
    extensionDialog: state.extensionDialog === null || state.extensionDialog === undefined
      ? null
      : {
          ...state.extensionDialog,
          options: [...state.extensionDialog.options]
        },
    commands: state.commands.map((command) => ({
      ...command,
      sourceInfo: command.sourceInfo === null ? null : { ...command.sourceInfo }
    })),
    extensions: state.extensions.map((extension) => ({ ...extension })),
    availableModels: state.availableModels.map((model) => ({
      ...model,
      thinkingLevelMap: { ...model.thinkingLevelMap },
      ...(model.pricing === undefined ? {} : { pricing: copyModelPricing(model.pricing) })
    })),
    sessionNaming: copySessionNamingSettings(state.sessionNaming),
    appearance: copyAppearanceSettings(state.appearance),
    general: copyGeneralSettings(state.general),
    subagent: copySubagentSettings(state.subagent),
    shortcuts: copyShortcutSettings(state.shortcuts),
    advisor: { ...state.advisor },
    runtime: { ...state.runtime },
    session: {
      ...state.session,
      pendingSteeringMessages: [...state.session.pendingSteeringMessages],
      pendingFollowUpMessages: [...state.session.pendingFollowUpMessages],
      compaction: state.session.compaction === null ? null : { ...state.session.compaction },
      usage: state.session.usage === null ? null : { ...state.session.usage },
      model: state.session.model === null
        ? null
        : {
            ...state.session.model,
            thinkingLevelMap: { ...state.session.model.thinkingLevelMap },
            ...(state.session.model.pricing === undefined
              ? {}
              : { pricing: copyModelPricing(state.session.model.pricing) })
          }
    },
    conversation: {
      entries: conversation.entries.map(copyConversationEntry),
      startIndex: conversation.startIndex,
      activeRunStartIndex: conversation.activeRunStartIndex
    }
  }
}

function copyModelPricing(
  pricing: NonNullable<KernelModelState['pricing']>
): NonNullable<KernelModelState['pricing']> {
  return {
    ...pricing,
    ...(pricing.tiers === undefined
      ? {}
      : { tiers: pricing.tiers.map((tier) => ({ ...tier })) })
  }
}

function createStatePatch(previous: KernelState, next: KernelState): KernelStatePatch | null {
  if (
    next.projects !== previous.projects ||
    next.navigatorKind !== previous.navigatorKind ||
    next.sessions !== previous.sessions ||
    next.activeProjectKey !== previous.activeProjectKey ||
    next.activeSessionKey !== previous.activeSessionKey ||
    next.projectTrustRequest !== previous.projectTrustRequest ||
    next.sessionNaming !== previous.sessionNaming ||
    next.appearance !== previous.appearance ||
    next.general !== previous.general ||
    next.subagent !== previous.subagent ||
    next.shortcuts !== previous.shortcuts ||
    next.advisor !== previous.advisor
  ) {
    return null
  }
  const patch: KernelStatePatch = {
    projectKey: next.activeProjectKey,
    sessionKey: next.activeSessionKey
  }
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
        entries.push(createConversationEntryPatch(previousEntry, entry, index))
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
    projectKey: patch.projectKey,
    sessionKey: patch.sessionKey,
    ...(patch.runtime === undefined ? {} : { runtime: { ...patch.runtime } }),
    ...(patch.session === undefined
      ? {}
      : {
          session: {
            ...patch.session,
            pendingSteeringMessages: [...patch.session.pendingSteeringMessages],
            pendingFollowUpMessages: [...patch.session.pendingFollowUpMessages],
            compaction: patch.session.compaction === null ? null : { ...patch.session.compaction },
            usage: patch.session.usage === null ? null : { ...patch.session.usage },
            model: patch.session.model === null
              ? null
              : {
                  ...patch.session.model,
                  thinkingLevelMap: { ...patch.session.model.thinkingLevelMap },
                  ...(patch.session.model.pricing === undefined
                    ? {}
                    : { pricing: copyModelPricing(patch.session.model.pricing) })
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
                  entries: patch.conversation.entries.map((entryPatch) => {
                    if (
                      entryPatch.type === 'insert' ||
                      entryPatch.type === 'replace-entry'
                    ) {
                      return { ...entryPatch, entry: copyConversationEntry(entryPatch.entry) }
                    }
                    if (entryPatch.type === 'append-tool-output') {
                      return {
                        ...entryPatch,
                        subagent: copySubagentRun(entryPatch.subagent)
                      }
                    }
                    if (entryPatch.type === 'replace-tool-metadata') {
                      return {
                        ...entryPatch,
                        expected: copyToolEntryPatchMetadata(entryPatch.expected),
                        metadata: copyToolEntryPatchMetadata(entryPatch.metadata)
                      }
                    }
                    return { ...entryPatch }
                  })
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
): KernelConversationEntryPatch {
  if (
    previous.kind === 'message' &&
    next.kind === 'message' &&
    previous.role === next.role &&
    previous.timestamp === next.timestamp &&
    sameMessageAttachments(previous.attachments, next.attachments) &&
    next.text.startsWith(previous.text) &&
    next.text.length > previous.text.length
  ) {
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

  if (
    previous.kind === 'thinking' &&
    next.kind === 'thinking' &&
    previous.timestamp === next.timestamp &&
    next.text.startsWith(previous.text) &&
    next.text.length > previous.text.length
  ) {
    return {
      type: 'append-thinking-text',
      index,
      from: previous.text.length,
      text: next.text.slice(previous.text.length),
      streaming: next.streaming
    }
  }

  if (
    previous.kind === 'tool' &&
    next.kind === 'tool' &&
    previous.toolCallId === next.toolCallId &&
    previous.name === next.name &&
    previous.args === next.args &&
    previous.timestamp === next.timestamp &&
    sameAskToolState(previous.ask, next.ask) &&
    next.output.startsWith(previous.output)
  ) {
    if (
      next.output.length > previous.output.length &&
      sameTodoItems(previous.todos, next.todos) &&
      sameToolImageAttachments(previous.attachments, next.attachments)
    ) {
      return {
        type: 'append-tool-output',
        index,
        toolCallId: next.toolCallId,
        from: previous.output.length,
        output: next.output.slice(previous.output.length),
        status: next.status,
        details: next.details,
        truncated: next.truncated,
        durationMs: next.durationMs,
        subagent: next.subagent
      }
    }
    if (next.output.length === previous.output.length) {
      return {
        type: 'replace-tool-metadata',
        index,
        toolCallId: next.toolCallId,
        expectedOutputLength: previous.output.length,
        expected: toolEntryPatchMetadata(previous),
        metadata: toolEntryPatchMetadata(next)
      }
    }
  }

  return {
    type: 'replace-entry',
    index,
    expectedId: previous.id,
    entry: next
  }
}

function copyConversationEntry(entry: KernelConversationEntry): KernelConversationEntry {
  if (entry.kind === 'tool') {
    const attachments = copyToolImageAttachments(entry.attachments)
    return {
      ...entry,
      subagent: copySubagentRun(entry.subagent),
      ...(entry.ask === undefined
        ? {}
        : {
            ask: {
              status: entry.ask.status,
              error: entry.ask.error,
              questions: entry.ask.questions.map((question) => ({
                ...question,
                options: question.options.map((option) => ({ ...option }))
              }))
            }
          }),
      ...(entry.todos === undefined
        ? {}
        : { todos: entry.todos.map((todo) => ({ ...todo })) }),
      ...(attachments === undefined ? {} : { attachments })
    }
  }
  if (entry.kind === 'subagent-notice') {
    return {
      ...entry,
      ...(entry.completion === undefined
        ? {}
        : { completion: copySubagentParticipant(entry.completion) }),
      ...(entry.coordination === undefined
        ? {}
        : { coordination: { ...entry.coordination } })
    }
  }
  if (entry.kind !== 'message' || entry.attachments === undefined) return { ...entry }
  return {
    ...entry,
    attachments: entry.attachments.map((attachment) => attachment.type === 'image'
      ? { ...attachment, hints: [...attachment.hints] }
      : { ...attachment })
  }
}

function toolEntryPatchMetadata(entry: KernelToolEntry): KernelToolEntryPatchMetadata {
  return {
    status: entry.status,
    details: entry.details,
    truncated: entry.truncated,
    durationMs: entry.durationMs,
    subagent: entry.subagent,
    todos: entry.todos,
    attachments: entry.attachments
  }
}

function copyToolEntryPatchMetadata(
  metadata: KernelToolEntryPatchMetadata
): KernelToolEntryPatchMetadata {
  return {
    ...metadata,
    subagent: copySubagentRun(metadata.subagent),
    todos: metadata.todos?.map((todo) => ({ ...todo })),
    attachments: copyToolImageAttachments(metadata.attachments)
  }
}

function sameAskToolState(
  left: KernelToolEntry['ask'],
  right: KernelToolEntry['ask']
): boolean {
  if (left === right) return true
  if (
    left === undefined ||
    right === undefined ||
    left.status !== right.status ||
    left.error !== right.error ||
    left.questions.length !== right.questions.length
  ) return false
  return left.questions.every((question, index) => {
    const candidate = right.questions[index]
    return candidate !== undefined &&
      question.id === candidate.id &&
      question.prompt === candidate.prompt &&
      question.type === candidate.type &&
      question.placeholder === candidate.placeholder &&
      question.options.length === candidate.options.length &&
      question.options.every((option, optionIndex) => {
        const other = candidate.options[optionIndex]
        return other !== undefined &&
          option.value === other.value &&
          option.label === other.label &&
          option.description === other.description
      })
  })
}

function sameTodoItems(
  left: KernelToolEntry['todos'],
  right: KernelToolEntry['todos']
): boolean {
  if (left === right) return true
  if (left === undefined || right === undefined || left.length !== right.length) return false
  return left.every((todo, index) => {
    const candidate = right[index]
    return candidate !== undefined &&
      todo.id === candidate.id &&
      todo.content === candidate.content &&
      todo.status === candidate.status &&
      todo.priority === candidate.priority
  })
}

function copySubagentRun(subagent: KernelSubagentRun | null): KernelSubagentRun | null {
  return subagent === null
    ? null
    : {
        ...subagent,
        participants: subagent.participants.map(copySubagentParticipant)
      }
}

function copySubagentParticipant(
  participant: KernelSubagentParticipant
): KernelSubagentParticipant {
  return {
    ...participant,
    usage: participant.usage === null ? null : { ...participant.usage },
    outputReferences: participant.outputReferences.map((reference) => ({ ...reference }))
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
    first.contextPercent === second.contextPercent &&
    first.cost === second.cost
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
  return { entries, startIndex: 0, activeRunStartIndex: null }
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
    tokenCountFormat: settings.tokenCountFormat,
    uiFontFamily: settings.uiFontFamily,
    codeFontFamily: settings.codeFontFamily
  }
}

function sameAppearanceSettings(first: AppearanceSettings, second: AppearanceSettings): boolean {
  return first.theme === second.theme &&
    first.accentColor === second.accentColor &&
    first.surfaceTransparency === second.surfaceTransparency &&
    first.textSize === second.textSize &&
    first.tokenCountFormat === second.tokenCountFormat &&
    first.uiFontFamily === second.uiFontFamily &&
    first.codeFontFamily === second.codeFontFamily
}

function copyGeneralSettings(settings: GeneralSettings): GeneralSettings {
  return {
    startupWorkspaceRestore: settings.startupWorkspaceRestore,
    doubleClickBorderMaximize: settings.doubleClickBorderMaximize,
    fastExtensionLoading: settings.fastExtensionLoading,
    autoContinueInterruptedTasks: settings.autoContinueInterruptedTasks
  }
}

function sameGeneralSettings(first: GeneralSettings, second: GeneralSettings): boolean {
  return first.startupWorkspaceRestore === second.startupWorkspaceRestore &&
    first.doubleClickBorderMaximize === second.doubleClickBorderMaximize &&
    first.fastExtensionLoading === second.fastExtensionLoading &&
    first.autoContinueInterruptedTasks === second.autoContinueInterruptedTasks
}

function copySubagentSettings(settings: SubagentSettings): SubagentSettings {
  return {
    maxDepth: settings.maxDepth
  }
}

function sameSubagentSettings(first: SubagentSettings, second: SubagentSettings): boolean {
  return first.maxDepth === second.maxDepth
}

function assertSubagentSettings(value: SubagentSettings): void {
  if (value.maxDepth !== 1 && value.maxDepth !== 2 && value.maxDepth !== 3) {
    throw new Error('Invalid subagent settings.')
  }
}

function sameShortcutSettings(first: ShortcutSettings, second: ShortcutSettings): boolean {
  return Object.keys(first).every((actionId) =>
    first[actionId as keyof ShortcutSettings] === second[actionId as keyof ShortcutSettings]
  )
}

function createCompactionLifecycle(revision: number): CompactionLifecycle {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  void promise.catch(() => {})
  return { revision, promise, resolve, reject, settled: false }
}

function compactionReason(value: unknown): KernelCompactionReason | null {
  return value === 'manual' || value === 'threshold' || value === 'overflow' ? value : null
}

function isCompactionResult(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'summary' in value &&
    typeof value.summary === 'string' &&
    'firstKeptEntryId' in value &&
    typeof value.firstKeptEntryId === 'string' &&
    value.firstKeptEntryId.length > 0 &&
    'tokensBefore' in value &&
    typeof value.tokensBefore === 'number' &&
    Number.isFinite(value.tokensBefore) &&
    value.tokensBefore >= 0 &&
    (
      !('estimatedTokensAfter' in value) ||
      (
        typeof value.estimatedTokensAfter === 'number' &&
        Number.isFinite(value.estimatedTokensAfter) &&
        value.estimatedTokensAfter >= 0
      )
    )
}

function isOptionalCompactionResult(value: unknown): boolean {
  return value === undefined || value === null || isCompactionResult(value)
}

function assertGeneralSettings(value: GeneralSettings): void {
  if (
    (value.startupWorkspaceRestore !== 'restore' && value.startupWorkspaceRestore !== 'none') ||
    typeof value.doubleClickBorderMaximize !== 'boolean' ||
    typeof value.fastExtensionLoading !== 'boolean' ||
    typeof value.autoContinueInterruptedTasks !== 'boolean'
  ) {
    throw new Error('Invalid general settings.')
  }
}

function assertAppearanceSettings(value: AppearanceSettings): void {
  if (
    !isAppearanceTheme(value.theme) ||
    !isAppearanceAccentColor(value.accentColor) ||
    !isSurfaceTransparency(value.surfaceTransparency) ||
    !isTextSize(value.textSize) ||
    !isTokenCountFormat(value.tokenCountFormat) ||
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

function isTokenCountFormat(value: unknown): value is AppearanceSettings['tokenCountFormat'] {
  return value === 'full' || value === 'compact'
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

function lastAssistantFinalAnswer(entries: KernelConversationEntry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (
      entry?.kind === 'message' &&
      entry.role === 'assistant' &&
      !entry.streaming &&
      (entry.phase === 'final_answer' || entry.phase == null) &&
      entry.text.trim().length > 0
    ) {
      return entry.text
    }
  }
  return null
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

function unsupportedBlockingExtensionUiRequest(
  event: PiRpcEvent
): { id: string, method: 'select' | 'confirm' | 'input' | 'editor' } | null {
  if (event.type !== 'extension_ui_request' || typeof event.id !== 'string') return null
  const method = event.method
  if (method !== 'select' && method !== 'confirm' && method !== 'input' && method !== 'editor') {
    return null
  }
  return { id: event.id, method }
}

function assertSessionPreviewRequestId(requestId: string): void {
  if (
    requestId.length === 0 ||
    requestId.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/u.test(requestId)
  ) {
    throw new Error('Session preview request ID is invalid.')
  }
}

function assertConversationPageRequest(
  request: KernelConversationPageRequest,
  entries: KernelConversationEntry[]
): void {
  const boundaryEntry = entries[request.beforeIndex]
  if (
    !Number.isSafeInteger(request.beforeIndex) ||
    request.beforeIndex <= 0 ||
    boundaryEntry === undefined ||
    boundaryEntry.id !== request.beforeEntryId
  ) {
    throw new Error('Conversation page request is stale or does not match its boundary identity.')
  }
}

function sessionPreviewAbortError(): Error {
  const error = new Error('Session preview was cancelled.')
  error.name = 'AbortError'
  return error
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

function hasProjectedToolImage(
  state: KernelState,
  sessionKey: string,
  toolCallId: string,
  contentIndex: number
): boolean {
  if (state.activeSessionKey !== sessionKey) return false
  return state.conversation.entries.some((entry) =>
    entry.kind === 'tool' &&
    entry.toolCallId === toolCallId &&
    entry.attachments?.some((attachment) => attachment.contentIndex === contentIndex) === true
  )
}

function isSubagentToolName(value: string): boolean {
  return value.trim().toLowerCase().split(/[.:/]/u).at(-1) === 'subagent'
}

function toolImageCacheKey(
  projectPath: string,
  sessionId: string,
  sessionKey: string,
  toolCallId: string,
  contentIndex: number
): string {
  return `${projectPath}\0${sessionId}\0${sessionKey}\0${toolCallId}\0${contentIndex}`
}
