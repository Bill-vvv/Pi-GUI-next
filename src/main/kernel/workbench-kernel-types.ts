import type {
  AppearanceSettings,
  GeneralSettings,
  KernelArchiveReceipt,
  KernelAskQuestion,
  KernelCommandEntry,
  KernelExtensionDescriptor,
  KernelExtensionDialogRequest,
  KernelMessageImage,
  KernelProjectState,
  KernelSessionSummary,
  KernelSessionPreview,
  KernelSessionState,
  KernelSessionStatistics,
  SessionNamingSettings,
  ShortcutSettings,
  SubagentSettings
} from '../../shared/kernel-contract.ts'
import type {
  RestartContinuationCandidate
} from '../project/restart-continuation.ts'
import type {
  SessionTranscriptPreparationHandle
} from '../project/session-transcript-preparation-cache.ts'
import type {
  ReadSessionMessagesTailFirstOptions,
  SessionTranscriptGeneration,
  SessionTranscriptMessagePhase
} from '../project/session-transcript-tail.ts'
import type {
  ProjectSessionRegistry,
  SessionPointer
} from '../project/session-pointer.ts'
import type {
  RuntimeHost,
  RuntimeHostEvent,
  RuntimeHostState
} from '../runtime/runtime-host.ts'
import type {
  LinuxProcessMemoryReadResult
} from '../runtime/linux-process-memory.ts'
import type {
  SessionNameGenerator
} from '../runtime/session-name-generator.ts'
import type {
  AskResponseStep,
  AskUiRequest
} from './ask-tool.ts'
import type {
  RuntimeSessionState
} from './runtime-session-state.ts'

/* Constants and internal types shared by WorkbenchKernel and its helpers (moved unchanged, D-098). */

export const INITIAL_HOST_STATE: RuntimeHostState = {
  executable: null,
  version: null,
  stderrChars: 0,
  stderrSummary: null,
  lastError: null,
  exitCode: null,
  exitSignal: null
}

export const INITIAL_SESSION_STATE: KernelSessionState = {
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

export const AUTOMATIC_SESSION_NAME_MODEL_IDS = [
  'gpt-5.6-luna',
  'gpt-5.4-mini',
  'gpt-5.3-codex-spark'
] as const

export const ARCHIVE_UNDO_DURATION_MS = 5_000
export const TOOL_IMAGE_CACHE_TTL_MS = 60_000
export const MAX_TOOL_IMAGE_CACHE_ENTRIES = 8
export const MAX_TOOL_IMAGE_CACHE_BASE64_CHARS = 24 * 1024 * 1024
export const RESTART_CONTINUATION_PROMPT =
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

export type SessionMetadata = {
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
  /**
   * PID of the process shared by every Runtime (D-094). Sampled once as a shared record,
   * never attributed to a single Session.
   */
  readSharedRuntimeHostPid?: () => number | null
}

export type ProvisionalSession = {
  runtime: RuntimeHost
  pointer: SessionPointer
  initialPrompt: string | null
  sessionNameAttempted: boolean
  activityAt: number
}

export type ToolImageCacheEntry = {
  projectPath: string
  sessionKey: string
  sessionId: string
  runtime: RuntimeHost
  cachedAt: number
  base64Chars: number
  image: KernelMessageImage
}

export type AskInteraction = {
  toolCallId: string
  questions: KernelAskQuestion[]
  pendingRequest: AskUiRequest | null
  responsePlan: AskResponseStep[] | null
  nextResponseIndex: number
  cancelling: boolean
}

export type SessionPreviewRegistrySource =
  | ProjectSessionRegistry
  | (() => Promise<ProjectSessionRegistry>)

export type PendingStaticSessionPreviewRequest = {
  requestId: string
  controller: AbortController
}

export type StaticSessionPreviewOperation = {
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

export type DetachedHistoryLease = {
  previewId: string
  pointer: SessionPointer
  archivedExpiresAt: number | null
}

export type ConversationIdentity = {
  projectKey: string
  sessionKey: string
  sessionId: string
}

export type ExtensionCommandInvocation = {
  id: string
  name: string
  active: boolean
}

export type ExtensionDialogInteraction = {
  request: KernelExtensionDialogRequest
}

export type RuntimeContext = {
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
  state: RuntimeSessionState
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
export const HIBERNATE_HOST_COMMAND_GENERATION = 1

export type CompactionLifecycle = {
  revision: number
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
  settled: boolean
}

export type ProjectNavigationState = {
  busySessionCount: number
  sessions: KernelSessionSummary[]
}

export type ArchiveUndoRecord = {
  receipt: KernelArchiveReceipt
  pointer: SessionPointer
  activityAt: number | null
  statistics: KernelSessionStatistics | null
  expiresAt: number
}

export type ForkTarget = {
  projectPath: string
  pointer: SessionPointer
  runtime: RuntimeHost
  context: RuntimeContext
}

export type RestartRecoverySelection = {
  activeProjectKey: string | null
  activeSessionKey: string | null
  navigatorKind: 'project' | 'task'
}
