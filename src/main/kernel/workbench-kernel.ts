import type {
  AppearanceSettings,
  GeneralSettings,
  KernelArchiveReceipt,
  KernelCommandDescriptor,
  KernelCommandEntry,
  KernelConversationEntry,
  KernelConversationEntryPatch,
  KernelConversationState,
  KernelExtensionStatusEntry,
  KernelCompactionReason,
  KernelEvent,
  KernelExtensionDescriptor,
  KernelForkCandidate,
  KernelMessageAttachment,
  KernelMessageImage,
  KernelModelState,
  KernelMutationAck,
  KernelSnapshot,
  KernelProjectState,
  KernelPromptAttachment,
  KernelProjectTrustChoice,
  KernelSessionSummary,
  KernelSessionPreview,
  KernelSessionState,
  KernelSessionStatistics,
  KernelSessionUsage,
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
  RELOAD_SESSION_COMMAND_ID,
  SET_MODEL_COMMAND_ID,
  SET_SESSION_NAME_COMMAND_ID,
  SET_THINKING_COMMAND_ID
} from './command-catalog.ts'
import {
  projectMessages,
  projectPiEvent,
  projectSessionEntries
} from './conversation-projection.ts'
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
  messageCount: 0,
  pendingMessageCount: 0,
  pendingSteeringMessages: [],
  pendingFollowUpMessages: [],
  compaction: null,
  settled: true
}

const AUTOMATIC_SESSION_NAME_MODEL_IDS = [
  'gpt-5.4-nano',
  'gpt-5.4-mini',
  'gpt-5.3-codex-spark',
  'gpt-5.6-luna'
] as const

const ARCHIVE_UNDO_DURATION_MS = 5_000
const TOOL_IMAGE_CACHE_TTL_MS = 60_000
const MAX_TOOL_IMAGE_CACHE_ENTRIES = 8
const MAX_TOOL_IMAGE_CACHE_BASE64_CHARS = 24 * 1024 * 1024

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

export type WorkbenchKernelOptions = {
  sessionRegistry: ProjectSessionRegistry
  /** 全部已登记 Project 的 Session 索引；用于 Navigator 多 Project 同时展开。 */
  sessionRegistriesByProject?: ReadonlyMap<string, ProjectSessionRegistry>
  extensions?: readonly KernelExtensionDescriptor[]
  persistProject: (project: KernelProjectState) => Promise<void>
  persistActiveProject: (projectKey: string) => Promise<void>
  persistSession: (pointer: SessionPointer) => Promise<void>
  persistArchivedSession: (projectPath: string, sessionKey: string) => Promise<void>
  restoreArchivedSession?: (
    projectPath: string,
    sessionKey: string
  ) => Promise<ProjectSessionRegistry>
  validateSession: (pointer: SessionPointer) => Promise<SessionPointer>
  readSessionActivityAt?: (pointer: SessionPointer) => Promise<number | null>
  readSessionStatistics?: (pointer: SessionPointer) => Promise<KernelSessionStatistics>
  readSessionMessages?: (pointer: SessionPointer) => Promise<unknown[]>
  persistProjectOrder?: (projectKeys: string[]) => Promise<void>
  sessionNaming?: SessionNamingSettings
  persistSessionNaming?: (settings: SessionNamingSettings) => Promise<void>
  appearance?: AppearanceSettings
  persistAppearance?: (settings: AppearanceSettings) => Promise<void>
  general?: GeneralSettings
  persistGeneral?: (settings: GeneralSettings) => Promise<void>
  subagent?: SubagentSettings
  persistSubagent?: (settings: SubagentSettings) => Promise<void>
  shortcuts?: ShortcutSettings
  persistShortcuts?: (settings: ShortcutSettings) => Promise<void>
  generateSessionName?: SessionNameGenerator
  projectTrust?: ProjectTrustController
  /** Unix epoch milliseconds; used for persisted activity timestamps and bounded TTLs. */
  now?: () => number
}

type ProvisionalSession = {
  runtime: RuntimeHost
  pointer: SessionPointer
  initialPrompt: string | null
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

type RuntimeContext = {
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
  /** Runtime events buffered only across an atomic persisted identity commit (fork). */
  deferredEvents: RuntimeHostEvent[] | null
}

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

export class WorkbenchKernel {
  private readonly createRuntime: RuntimeFactory
  private readonly listeners = new Set<(event: KernelEvent) => void>()
  private sessionActivityAtByKey = new Map<string, number | null>()
  private sessionStatisticsByKey = new Map<string, KernelSessionStatistics | null>()
  private readonly contexts = new Set<RuntimeContext>()
  private readonly contextByRuntime = new Map<RuntimeHost, RuntimeContext>()
  private readonly contextBySessionKey = new Map<string, RuntimeContext>()
  private readonly sessionPointersByProject = new Map<string, SessionPointer[]>()
  private readonly sessionActivityByProject = new Map<string, Map<string, number | null>>()
  private readonly sessionStatisticsByProject =
    new Map<string, Map<string, KernelSessionStatistics | null>>()
  private readonly archiveUndoByToken = new Map<string, ArchiveUndoRecord>()
  private readonly sessionReloadRequired = new Set<string>()
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
    this.persistSession = options.persistSession
    this.persistArchivedSession = options.persistArchivedSession
    this.restoreArchivedSession = options.restoreArchivedSession ?? (async () => {
      throw new Error('Archived session restore is unavailable.')
    })
    this.validateSession = options.validateSession
    this.readSessionActivityAt = options.readSessionActivityAt ?? (async () => null)
    this.readSessionStatistics = options.readSessionStatistics ?? (async () => null)
    this.readSessionMessages = options.readSessionMessages
    this.persistProjectOrder = options.persistProjectOrder ?? (async () => {})
    this.persistSessionNaming = options.persistSessionNaming ?? (async () => {})
    this.persistAppearance = options.persistAppearance ?? (async () => {})
    this.persistGeneral = options.persistGeneral ?? (async () => {})
    this.persistSubagent = options.persistSubagent ?? (async () => {})
    this.persistShortcuts = options.persistShortcuts ?? (async () => {})
    this.generateSessionName = options.generateSessionName
    this.projectTrust = options.projectTrust ?? {
      inspect: async () => ({ requiresDecision: false, decision: null }),
      persist: async () => {}
    }
    this.now = options.now ?? Date.now
    this.state = initialKernelState(
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
    )
  }

  private readonly persistProject: (project: KernelProjectState) => Promise<void>
  private readonly persistActiveProject: (projectKey: string) => Promise<void>
  private readonly persistSession: (pointer: SessionPointer) => Promise<void>
  private readonly persistArchivedSession: (projectPath: string, sessionKey: string) => Promise<void>
  private readonly restoreArchivedSession: (
    projectPath: string,
    sessionKey: string
  ) => Promise<ProjectSessionRegistry>
  private readonly validateSession: ((pointer: SessionPointer) => Promise<SessionPointer>) | undefined
  private readonly readSessionActivityAt: (pointer: SessionPointer) => Promise<number | null>
  private readonly readSessionStatistics:
    (pointer: SessionPointer) => Promise<KernelSessionStatistics | null>
  private readonly readSessionMessages: ((pointer: SessionPointer) => Promise<unknown[]>) | undefined
  private readonly persistProjectOrder: (projectKeys: string[]) => Promise<void>
  private readonly persistSessionNaming: (settings: SessionNamingSettings) => Promise<void>
  private readonly persistAppearance: (settings: AppearanceSettings) => Promise<void>
  private readonly persistGeneral: (settings: GeneralSettings) => Promise<void>
  private readonly persistSubagent: (settings: SubagentSettings) => Promise<void>
  private readonly persistShortcuts: (settings: ShortcutSettings) => Promise<void>
  private readonly generateSessionName: SessionNameGenerator | undefined
  private readonly projectTrust: ProjectTrustController
  private readonly now: () => number

  getState(): KernelState {
    const state = copyState(this.state)
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

  /**
   * Atomic snapshot for Renderer initialization/resync. Pairs the deep-copied
   * KernelState with the current publish revision so clients never guess counters.
   */
  getSnapshot(): KernelSnapshot {
    return {
      revision: this.stateRevision,
      state: this.getState()
    }
  }

  /**
   * Narrow acknowledgement for mutating IPC. Carries the latest published revision
   * without deep-cloning KernelState for the invoke return path.
   */
  acknowledge(): KernelMutationAck {
    return { revision: this.stateRevision }
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
      const [activityAtByKey, statisticsByKey] = await Promise.all([
        this.loadSessionActivities(pointers),
        projectPath === activeProjectAtStart
          ? this.loadSessionStatistics(pointers)
          : Promise.resolve(undefined)
      ])
      return { projectPath, pointers, activityAtByKey, statisticsByKey }
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
    const matchingRegistry = matchingSessionRegistry({ path }, sessionRegistry)
    const sessionPointers = matchingRegistry.sessions
    const [activityAtByKey, statisticsByKey] = await Promise.all([
      this.loadSessionActivities(sessionPointers),
      this.loadSessionStatistics(sessionPointers)
    ])
    this.captureActiveContext()
    this.sessionPointers = sessionPointers
    this.sessionActivityAtByKey = activityAtByKey
    this.sessionStatisticsByKey = statisticsByKey
    this.sessionPointersByProject.set(path, this.sessionPointers)
    this.sessionActivityByProject.set(path, this.sessionActivityAtByKey)
    this.sessionStatisticsByProject.set(path, this.sessionStatisticsByKey)
    this.state = initialKernelState({
      projects: this.state.projects,
      activeProjectKey: path
    }, matchingRegistry, this.sessionActivityAtByKey, this.sessionStatisticsByKey, this.state.sessionNaming, this.state.appearance, this.state.general, this.state.subagent, this.state.shortcuts, this.state.extensions)
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

  async activateSession(sessionKey: string): Promise<void> {
    if (!isAbsolute(sessionKey)) throw new Error(`Session key must be absolute: ${sessionKey}`)
    await this.beginLaunch(async () => {
      const project = configuredProject(this.state)
      const managed = this.contextBySessionKey.get(contextKey(project.path, sessionKey))
      const storedPointer = this.sessionPointers.find(
        (pointer) => pointer.projectPath === project.path && pointer.sessionFile === sessionKey
      )
      // Any managed crashed context must retry cleanup/relaunch — including inactive
      // ones retained after a failed stop — rather than loading a crashed projection.
      const restartManaged = managed !== undefined &&
        managed.state.runtime.status === 'crashed'
      if (managed !== undefined && !restartManaged) {
        if (storedPointer !== undefined) {
          await this.persistSession(storedPointer)
          this.assertLaunchActive()
        }
        this.captureActiveContext()
        this.loadContext(managed)
        this.emitState()
        return
      }
      if (storedPointer === undefined) {
        throw new Error(`Session is not registered for the active project: ${sessionKey}`)
      }
      if (typeof this.validateSession !== 'function') {
        throw new Error('Session validation is unavailable.')
      }
      const pointer = await this.validateSession(storedPointer)
      this.assertLaunchActive()
      if (restartManaged) {
        await this.stopContext(managed)
        this.assertLaunchActive()
      }
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
        const session = toKernelSession(
          stateResult.state,
          true,
          toKernelSessionUsage(statisticsResult.statistics, stateResult.state.model?.contextWindow)
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
        assertSessionStatisticsIdentity(statisticsResult.statistics, sessionFile, session.id)

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
        const projectedMessages = mergeConversationEntries(
          projectMessages(messagesResult.messages),
          projectSessionEntries(
            sessionEntriesOnActivePath(capabilitiesResult.entries, capabilitiesResult.leafId)
          )
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
          sessionId: session.id,
          sessionName: session.name
        })
        this.assertForkTarget(target)
        if (
          pointer.projectPath !== target.projectPath ||
          pointer.sessionFile === target.pointer.sessionFile ||
          pointer.sessionId !== session.id ||
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
   * Explicit Runtime hibernation for a managed, persisted, inactive Session.
   * Stops and removes only that RuntimeContext while preserving the durable
   * Session pointer and navigation identity. Later activateSession relaunches
   * from the Pi transcript. Not-managed registered targets are idempotent.
   */
  async hibernateSession(sessionKey: string): Promise<void> {
    if (!isAbsolute(sessionKey)) throw new Error(`Session key must be absolute: ${sessionKey}`)
    const project = configuredProject(this.state)
    const pointer = this.sessionPointers.find((candidate) =>
      candidate.projectPath === project.path && candidate.sessionFile === sessionKey
    )
    if (pointer === undefined) {
      throw new Error(`Session is not registered for the active project: ${sessionKey}`)
    }

    // Serialize with activate/reload/start so a target cannot be loaded or replaced
    // while hibernation is stopping it. Registered-but-unmanaged targets are no-ops.
    await this.beginLaunch(async () => {
      const targetContext = this.contextBySessionKey.get(contextKey(project.path, sessionKey))
      if (targetContext === undefined) return

      this.assertHibernateTarget(project.path, sessionKey, targetContext)
      await this.stopContext(targetContext)
    })
  }

  async archiveSession(sessionKey: string): Promise<KernelArchiveReceipt> {
    if (!isAbsolute(sessionKey)) throw new Error(`Session key must be absolute: ${sessionKey}`)
    const project = configuredProject(this.state)
    const pointer = this.sessionPointers.find((candidate) =>
      candidate.projectPath === project.path && candidate.sessionFile === sessionKey
    )
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
            conversation: { entries: [], activeRunStartIndex: null }
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
    if (typeof this.readSessionMessages !== 'function') {
      throw new Error('Session preview is unavailable.')
    }
    const pointer = await this.validateSession(record.pointer)
    const messages = await this.readSessionMessages(pointer)
    if (this.requireArchiveUndoRecord(token) !== record) {
      throw new Error('Archive undo credential is stale.')
    }
    this.archiveUndoByToken.delete(token)
    return {
      projectKey: record.receipt.projectKey,
      sessionKey: pointer.sessionFile,
      sessionId: pointer.sessionId,
      sessionName: pointer.sessionName,
      conversation: {
        entries: projectMessages(messages),
        activeRunStartIndex: null
      }
    }
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

  private assertHibernateTarget(
    projectPath: string,
    sessionKey: string,
    context: RuntimeContext
  ): void {
    if (context.projectPath !== projectPath) {
      throw new Error('Cannot hibernate a session that is not owned by the active project.')
    }
    if (this.activeContext === context || this.state.activeSessionKey === sessionKey) {
      throw new Error('Cannot hibernate the active foreground session.')
    }
    if (
      context.provisionalSession !== null ||
      context.provisionalCommit !== null ||
      context.state.activeSessionKey === null ||
      context.state.sessions.some((summary) =>
        summary.key === sessionKey && summary.provisional === true
      )
    ) {
      throw new Error('Cannot hibernate a provisional session.')
    }
    const runtimeStatus = context.state.runtime.status
    if (
      runtimeStatus === 'starting' ||
      runtimeStatus === 'running' ||
      runtimeStatus === 'stopping'
    ) {
      throw new Error(`Cannot hibernate a session while runtime is ${runtimeStatus}.`)
    }
    if (!context.state.session.settled) {
      throw new Error('Cannot hibernate a session that is not settled.')
    }
    this.assertContextNotCompacting(context, 'Hibernate')
    if (context.launchCommitting) {
      throw new Error('Cannot hibernate a session while launch is committing.')
    }
    if (context.deferredEvents !== null) {
      throw new Error('Cannot hibernate a session while a deferred identity commit is in progress.')
    }
    if (context.sessionNameOperation !== null || context.pendingSessionName !== null) {
      throw new Error('Cannot hibernate a session while session naming is in progress.')
    }
    if (context.stopRequested) {
      throw new Error('Cannot hibernate a session while stop is in progress.')
    }
    if (context.sessionUsageRefreshInFlight || context.sessionUsageRefreshRequested) {
      throw new Error('Cannot hibernate a session while session usage refresh is in progress.')
    }
    const session = context.state.session
    if (
      session.pendingMessageCount > 0 ||
      session.pendingSteeringMessages.length > 0 ||
      session.pendingFollowUpMessages.length > 0
    ) {
      throw new Error('Cannot hibernate a session while messages are queued.')
    }
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
    projectTrustPreflighted = false
  ): Promise<void> {
    this.assertLaunchActive()
    const projectTrust = projectTrustPreflighted
      ? launchOptions.projectTrust
      : await this.preflightProjectTrust(project.path)
    this.assertLaunchActive()
    const resolvedLaunchOptions = projectTrust === undefined
      ? launchOptions
      : { ...launchOptions, projectTrust }
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
      deferredEvents: null
    }
    this.contexts.add(context)
    this.contextByRuntime.set(runtime, context)
    if (launchOptions.sessionFile !== undefined) {
      this.contextBySessionKey.set(contextKey(project.path, launchOptions.sessionFile), context)
    }
    this.activeContext = context
    this.unsubscribeRuntime = runtime.subscribe((event) => {
      this.handleContextEvent(context, event)
    })
    context.unsubscribeRuntime = this.unsubscribeRuntime

    this.state = {
      ...this.state,
      activeSessionKey: launchOptions.sessionFile === undefined ? null : this.state.activeSessionKey,
      commands: createCommandCatalog(),
      advisor: { ...UNAVAILABLE_ADVISOR_STATE },
      availableModels: [],
      ...(launchOptions.sessionFile === undefined
        ? {
            session: { ...INITIAL_SESSION_STATE },
            conversation: { entries: [], activeRunStartIndex: null }
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
      let session = toKernelSession(stateResult.state, true)
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
      projectedMessages = mergeConversationEntries(
        projectedMessages,
        projectSessionEntries(
          sessionEntriesOnActivePath(entriesResult.entries, entriesResult.leafId)
        )
      )
      projectedMessages = mergeConversationEntries(
        projectedMessages,
        this.state.conversation.entries.filter(
          (entry): entry is KernelExtensionStatusEntry =>
            entry.kind === 'extension-status' &&
            entry.id === 'extension-status:magic-context' &&
            entry.timestamp >= startupBeganAt
        )
      )
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
        toKernelSessionUsage(statisticsResult.statistics, stateResult.state.model?.contextWindow)
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
          activityAt: this.now()
        }
        context.provisionalSession = this.provisionalSession
        this.contextBySessionKey.set(contextKey(project.path, pointer.sessionFile), context)
        this.state = {
          ...this.state,
          // Navigation placeholder only: still not written to the XDG session index.
          activeSessionKey: pointer.sessionFile,
          commands: provisionalCommands,
          advisor,
          availableModels,
          runtime: toKernelRuntime('ready', runtime.getState()),
          session: { ...session, resumeAvailable: false },
          conversation: {
            entries: projectedMessages,
            activeRunStartIndex: null
          }
        }
        this.state = { ...this.state, sessions: this.toSessionSummaries() }
        this.emitState()
        return
      }
      this.assertStartActive(runtime)
      this.launchCommitting = true
      try {
        await this.persistSession(canonicalPointer)
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
      } finally {
        this.launchCommitting = false
      }
    } catch (error) {
      if (!this.isStartActive(runtime)) {
        throw new Error('Runtime start cancelled.')
      }
      const launchError = await this.cleanupFailedLaunch(runtime, error)
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

  async setAdvisorSystemEnabled(enabled: boolean): Promise<void> {
    const runtime = this.requireRuntime('ready')
    if (
      this.state.advisor.compatibility !== 'ready' ||
      !this.state.advisor.liveToggle
    ) {
      throw new Error('Advisor live toggle is unavailable.')
    }
    const commands = this.state.commands.filter((command) =>
      command.name === 'advisor' && command.source === 'extension'
    )
    if (commands.length !== 1) {
      throw new Error('Advisor extension command must resolve uniquely.')
    }
    const context = this.activeContext
    if (context === null || context.runtime !== runtime) {
      throw new Error('Active runtime context is unavailable.')
    }

    await this.invokePiCommand(commands[0]!, enabled ? 'on' : 'off')
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

    if (command.source === 'extension') this.appendCommandEcho(command, argument)
    await this.invokePiCommand(command, argument)
    if (isMagicContextStatusCommand(command)) {
      this.appendMagicContextStatusSnapshot()
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

  private appendMagicContextStatusSnapshot(): void {
    const current = this.state.conversation.entries.find(
      (entry): entry is KernelExtensionStatusEntry =>
        entry.kind === 'extension-status' && entry.id === 'extension-status:magic-context'
    )
    this.appendLocalConversationEntry({
      id: `extension-status:magic-context:snapshot:${randomUUID()}`,
      kind: 'extension-status',
      source: 'magic-context',
      title: current === undefined ? 'Magic Context 状态不可用' : 'Magic Context 状态',
      text: current?.text ??
        '当前 Pi RPC 不支持 Magic Context 的自定义状态对话框，且本任务尚未收到状态栏数据。请重载任务后再试。',
      level: current?.level ?? 'warning',
      timestamp: Date.now()
    })
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
      const projectedSession = toKernelSession(stateResult.state, context.state.session.resumeAvailable)
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
      const entries = mergeConversationEntries(
        mergeConversationEntries(
          projectMessages(messagesResult.messages),
          context.state.conversation.entries.filter(
            (entry): entry is KernelExtensionStatusEntry => entry.kind === 'extension-status'
          )
        ),
        context.commandEntries
      )
      const nextContextState: KernelState = {
        ...context.state,
        session: {
          ...toKernelSession(stateResult.state, context.state.session.resumeAvailable, usage),
          compaction: null
        },
        conversation: {
          entries,
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

  /**
   * Explicit background provisional materialization entry point.
   * Stores the Promise only on the owning context and does not touch active
   * provisional mirrors.
   */
  private beginBackgroundProvisionalCommit(context: RuntimeContext): void {
    const provisional = context.provisionalSession
    if (
      provisional === null ||
      provisional.runtime !== context.runtime ||
      context.provisionalCommit !== null
    ) {
      return
    }
    const commit = this.commitBackgroundProvisional(context, provisional)
    context.provisionalCommit = commit
    void commit.finally(() => {
      if (context.provisionalCommit === commit) context.provisionalCommit = null
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
      // Metadata is fallible, so read it before the durable index write. Once
      // persistSession succeeds there are no remaining awaits before registry
      // reconciliation; durable and in-memory pointers cannot diverge.
      const [activityAt, statistics] = await Promise.all([
        this.readSessionActivityAt(pointer),
        this.readSessionStatistics(pointer)
      ])
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
        const previousSessionKey = context.state.activeSessionKey
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
        const settleDeferred = context.provisionalSettled
        let nextState: KernelState = {
          ...context.state,
          activeSessionKey: pointer.sessionFile,
          session: {
            ...context.state.session,
            resumeAvailable: true,
            settled: settleDeferred ? true : context.state.session.settled,
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
            : context.state.runtime,
          conversation: settleDeferred
            ? settleConversationRun(context.state.conversation)
            : context.state.conversation
        }
        if (settleDeferred) {
          nextState = this.withContextSessionActivity(context, nextState)
        }
        context.state = nextState
        context.provisionalSettled = false
        if (pointer.sessionName === null && provisional.initialPrompt !== null) {
          const pending = {
            runtime: context.runtime,
            sessionFile: pointer.sessionFile,
            sessionId: pointer.sessionId,
            userMessage: provisional.initialPrompt
          }
          context.pendingSessionName = pending
          if (this.activeContext === context) {
            this.pendingSessionName = pending
          }
          if (context.state.runtime.status === 'ready') {
            this.beginBackgroundSessionNameGeneration(context, pending)
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
        // commit was in flight, retry after the commit slot is cleared (macrotask so the
        // beginBackgroundProvisionalCommit() finally handler runs first).
        if (context.provisionalSettled) {
          setTimeout(() => {
            if (
              !this.contexts.has(context) ||
              context.provisionalSession !== provisional ||
              context.provisionalCommit !== null
            ) return
            this.beginBackgroundProvisionalCommit(context)
          }, 0)
        }
        return
      }
      const navigationBefore = this.projectNavigationState(context.projectPath)
      context.provisionalSession = null
      context.provisionalSettled = false
      if (
        context.state.activeSessionKey !== null &&
        !(this.sessionPointersByProject.get(context.projectPath) ?? []).some(
          (pointer) => pointer.sessionFile === context.state.activeSessionKey
        )
      ) {
        context.state = { ...context.state, activeSessionKey: null }
      }
      context.state = {
        ...context.state,
        runtime: toKernelRuntime('crashed', context.runtime.getState(), errorMessage(error))
      }
      this.publishContextNavigationChange(context, navigationBefore)
    }
  }

  private async commitProvisionalSession(provisional: ProvisionalSession): Promise<void> {
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
      await this.captureSessionMetadata(canonicalPointer)
      if (this.provisionalSession !== provisional || this.runtime !== provisional.runtime) return
      this.queueSessionNameGeneration(provisional.runtime, canonicalPointer, provisional.initialPrompt)
      const materializedContext = this.contextByRuntime.get(provisional.runtime)
      if (materializedContext !== undefined) {
        const previousSessionKey = materializedContext.state.activeSessionKey
        if (
          typeof previousSessionKey === 'string' &&
          previousSessionKey !== canonicalPointer.sessionFile
        ) {
          this.clearToolImageCacheForSession(previousSessionKey)
        }
        for (const [key, candidate] of this.contextBySessionKey) {
          if (candidate === materializedContext) this.contextBySessionKey.delete(key)
        }
        this.contextBySessionKey.set(
          contextKey(canonicalPointer.projectPath, canonicalPointer.sessionFile),
          materializedContext
        )
        materializedContext.provisionalSession = null
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
        // File may not exist yet at message_end. If agent_settled already ran while this
        // commit was in flight, retry after the commit slot is cleared (macrotask so the
        // beginProvisionalCommit() finally handler runs first).
        if (this.provisionalSettled) {
          setTimeout(() => {
            if (
              this.provisionalSession !== provisional ||
              this.provisionalCommit !== null ||
              this.runtime !== provisional.runtime
            ) return
            this.beginProvisionalCommit()
          }, 0)
          return
        }
        this.emitState()
        return
      }
      this.provisionalSession = null
      this.provisionalSettled = false
      if (this.activeContext !== null) this.activeContext.provisionalSession = null
      this.clearUnregisteredActiveSessionKey()
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
    if (context.state.runtime.status !== 'ready') return
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
        context.state.runtime.status !== 'ready' ||
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

  private async loadSessionStatistics(
    pointers: SessionPointer[]
  ): Promise<Map<string, KernelSessionStatistics | null>> {
    const entries = await Promise.all(pointers.map(async (pointer) => [
      pointer.sessionFile,
      await this.readSessionStatistics(pointer)
    ] as const))
    return new Map(entries)
  }

  private async captureSessionMetadata(
    pointer: SessionPointer,
    knownStatistics?: KernelSessionStatistics
  ): Promise<void> {
    const [activityAt, statistics] = await Promise.all([
      this.readSessionActivityAt(pointer),
      knownStatistics === undefined
        ? this.readSessionStatistics(pointer)
        : Promise.resolve(knownStatistics)
    ])
    this.sessionActivityAtByKey.set(pointer.sessionFile, activityAt)
    this.sessionStatisticsByKey.set(pointer.sessionFile, statistics)
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
      const status = this.activeContext === context
        ? this.state.runtime.status
        : context.state.runtime.status
      if (status === 'running' || status === 'stopping') busySessionCount += 1
    }
    return {
      busySessionCount,
      sessions: this.toSessionSummariesForProject(projectPath)
    }
  }

  private toSessionSummariesForProject(projectPath: string): KernelSessionSummary[] {
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
      (sessionKey) => this.sessionReloadRequired.has(contextKey(projectPath, sessionKey))
    )
    return mergeProvisionalSessionSummaries(
      registered,
      this.provisionalSummariesForProject(projectPath, new Set(pointers.map((pointer) => pointer.sessionFile)))
    )
  }

  private provisionalSummariesForProject(
    projectPath: string,
    registeredKeys: ReadonlySet<string>
  ): KernelSessionSummary[] {
    const summaries: KernelSessionSummary[] = []
    for (const context of this.contexts) {
      if (context.projectPath !== projectPath) continue
      const provisional = this.activeContext === context
        ? this.provisionalSession
        : context.provisionalSession
      if (provisional === null) continue
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
        provisional: true,
        statistics: null
      })
    }
    return summaries
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
    if (context.provisionalCommit !== null) {
      context.provisionalSettled = true
      return
    }
    const navigationBefore = this.projectNavigationState(context.projectPath)
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
    if (context.provisionalSession?.runtime === context.runtime) {
      context.provisionalSettled = true
      this.beginBackgroundProvisionalCommit(context)
      return
    }

    const navigationBefore = this.projectNavigationState(context.projectPath)
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
    }
    context.state = {
      ...context.state,
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
    if (status === 'crashed') this.cancelSessionNameGeneration(this.runtime ?? undefined)
    this.state = {
      ...this.state,
      runtime: toKernelRuntime(status, this.runtime?.getState() ?? INITIAL_HOST_STATE, lastError)
    }
    this.emitState()
  }

  private async preflightProjectTrust(projectPath: string): Promise<boolean | undefined> {
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
      state: this.getState()
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
    activeProjectKey: projectRegistry.activeProjectKey,
    sessions: toKernelSessionSummaries(
      matchingRegistry.sessions,
      sessionActivityAtByKey,
      sessionStatisticsByKey
    ),
    activeSessionKey: matchingRegistry.activeSessionKey,
    projectTrustRequest: null,
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
  requiresReload: (sessionKey: string) => boolean = () => false
): KernelSessionSummary[] {
  const summaries = pointers.map((pointer) => ({
    key: pointer.sessionFile,
    id: pointer.sessionId,
    name: pointer.sessionName,
    lastActivityAt: sessionActivityAtByKey.get(pointer.sessionFile) ?? null,
    runtimeStatus: runtimeStatus(pointer.sessionFile),
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

function copySessionSummary(session: KernelSessionSummary): KernelSessionSummary {
  return {
    ...session,
    ...(session.provisional === true ? { provisional: true as const } : {}),
    statistics: session.statistics === null ? null : { ...session.statistics }
  }
}

function copyState(state: KernelState): KernelState {
  return {
    projects: state.projects.map((project) => ({
      ...project,
      ...(project.sessions === undefined
        ? {}
        : { sessions: project.sessions.map(copySessionSummary) })
    })),
    activeProjectKey: state.activeProjectKey,
    sessions: state.sessions.map(copySessionSummary),
    activeSessionKey: state.activeSessionKey,
    projectTrustRequest: state.projectTrustRequest === null
      ? null
      : { ...state.projectTrustRequest },
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
      entries: state.conversation.entries.map(copyConversationEntry),
      activeRunStartIndex: state.conversation.activeRunStartIndex
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
    next.sessions !== previous.sessions ||
    next.activeProjectKey !== previous.activeProjectKey ||
    next.activeSessionKey !== previous.activeSessionKey ||
    next.projectTrustRequest !== previous.projectTrustRequest ||
    next.sessionNaming !== previous.sessionNaming ||
    next.appearance !== previous.appearance ||
    next.general !== previous.general ||
    next.subagent !== previous.subagent ||
    next.shortcuts !== previous.shortcuts
    || next.advisor !== previous.advisor
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
                    if (entryPatch.type === 'insert') {
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
): KernelConversationEntryPatch | null {
  if (previous.kind !== next.kind) return null

  if (previous.kind === 'message' && next.kind === 'message') {
    if (
      previous.role !== next.role ||
      previous.timestamp !== next.timestamp ||
      !sameMessageAttachments(previous.attachments, next.attachments) ||
      !next.text.startsWith(previous.text) ||
      next.text.length === previous.text.length
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
    if (
      previous.timestamp !== next.timestamp ||
      !next.text.startsWith(previous.text) ||
      next.text.length === previous.text.length
    ) return null
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
    if (next.output.length > previous.output.length) {
      if (
        !sameTodoItems(previous.todos, next.todos) ||
        !sameToolImageAttachments(previous.attachments, next.attachments)
      ) return null
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
    return {
      type: 'replace-tool-metadata',
      index,
      toolCallId: next.toolCallId,
      expectedOutputLength: previous.output.length,
      expected: toolEntryPatchMetadata(previous),
      metadata: toolEntryPatchMetadata(next)
    }
  }

  return null
}

function copyConversationEntry(entry: KernelConversationEntry): KernelConversationEntry {
  if (entry.kind === 'tool') {
    const attachments = copyToolImageAttachments(entry.attachments)
    return {
      ...entry,
      subagent: copySubagentRun(entry.subagent),
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
        : { completion: { ...entry.completion } }),
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
        participants: subagent.participants.map((participant) => ({ ...participant }))
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
    fastExtensionLoading: settings.fastExtensionLoading
  }
}

function sameGeneralSettings(first: GeneralSettings, second: GeneralSettings): boolean {
  return first.startupWorkspaceRestore === second.startupWorkspaceRestore &&
    first.doubleClickBorderMaximize === second.doubleClickBorderMaximize &&
    first.fastExtensionLoading === second.fastExtensionLoading
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
    typeof value.fastExtensionLoading !== 'boolean'
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

function isMagicContextStatusCommand(command: KernelCommandDescriptor): boolean {
  return command.source === 'extension' &&
    command.name === 'ctx-status' &&
    command.sourceInfo?.source.includes('@cortexkit/pi-magic-context') === true
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
