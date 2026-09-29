import type {
  AppearanceSettings,
  GeneralSettings,
  KernelCommandDescriptor,
  KernelConversationEntry,
  KernelConversationPageRequest,
  KernelCompactionReason,
  KernelExtensionDescriptor,
  KernelModelState,
  KernelProjectState,
  KernelSessionSummary,
  KernelSessionStatistics,
  KernelSessionUsage,
  KernelState,
  RuntimeStatus,
  SessionNamingSettings,
  ShortcutSettings,
  SubagentSettings,
  ThinkingLevel
} from '../../shared/kernel-contract.ts'
import {
  copySessionNamingSettings,
  copyAppearanceSettings,
  copyGeneralSettings,
  copySubagentSettings
} from '../../shared/workbench-settings.ts'
import {
  copyShortcutSettings
} from '../../shared/shortcut-settings.ts'
import type {
  PiRpcEvent,
  PiRpcSessionStats
} from '../pi-rpc/pi-rpc-data.ts'
import {
  isAbsolute
} from 'node:path'
import type {
  ProjectSessionRegistry,
  SessionPointer
} from '../project/session-pointer.ts'
import {
  createCommandCatalog
} from './command-catalog.ts'
import {
  toKernelRuntime
} from './runtime-session-state.ts'
import {
  UNAVAILABLE_ADVISOR_STATE
} from './advisor-projection.ts'
import {
  INITIAL_HOST_STATE,
  INITIAL_SESSION_STATE,
  AUTOMATIC_SESSION_NAME_MODEL_IDS,
  type CompactionLifecycle,
  type ProjectNavigationState
} from './workbench-kernel-types.ts'

/* Pure WorkbenchKernel helpers (moved unchanged, D-098). */

export function metadataCacheForPointers<T>(
  pointers: SessionPointer[],
  cached: ReadonlyMap<string, T | null> | undefined
): Map<string, T | null> {
  return new Map(pointers.map((pointer) => [
    pointer.sessionFile,
    cached?.get(pointer.sessionFile) ?? null
  ]))
}

export function mergeRefreshedMetadata<T>(
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

export function configuredProject(state: Pick<KernelState, 'projects' | 'activeProjectKey'>): { path: string } {
  const project = activeProject(state)
  if (project === null) throw new Error('Select a project directory before starting.')
  return project
}

export function isSessionExportRuntimeStatusAllowed(status: RuntimeStatus): boolean {
  return status !== 'starting' && status !== 'running' && status !== 'stopping'
}

export function initialKernelState(
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

export function assertSessionStatisticsIdentity(
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

export function matchingSessionRegistry(
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

export function toKernelSessionSummaries(
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

export function mergeProvisionalSessionSummaries(
  registered: KernelSessionSummary[],
  provisional: KernelSessionSummary[]
): KernelSessionSummary[] {
  if (provisional.length === 0) return registered
  const registeredKeys = new Set(registered.map((summary) => summary.key))
  const extras = provisional.filter((summary) => !registeredKeys.has(summary.key))
  if (extras.length === 0) return registered
  return sortSessionSummaries([...extras, ...registered])
}

export function sortSessionSummaries(summaries: KernelSessionSummary[]): KernelSessionSummary[] {
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

export function assertStrictPermutation(current: string[], next: string[], label: string): void {
  if (
    current.length !== next.length ||
    new Set(next).size !== next.length ||
    next.some((key) => !current.includes(key))
  ) {
    throw new Error(`Invalid ${label} order.`)
  }
}

export function sameSessionPointers(current: SessionPointer[], snapshot: SessionPointer[]): boolean {
  return current.length === snapshot.length && current.every((pointer, index) => {
    const other = snapshot[index]
    return other !== undefined &&
      pointer.projectPath === other.projectPath &&
      pointer.sessionFile === other.sessionFile &&
      pointer.sessionId === other.sessionId &&
      pointer.sessionName === other.sessionName
  })
}

export function sameProjectNavigationState(
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

export function sameSessionStatistics(
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

export function sameExtensions(
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

export function activeProject(
  state: Pick<KernelState, 'projects' | 'activeProjectKey'>
): KernelProjectState | null {
  if (state.activeProjectKey === null) return null
  return state.projects.find((project) => project.path === state.activeProjectKey) ?? null
}

export function workspaceKind(project: KernelProjectState | null): 'project' | 'task' {
  return project?.workspaceKind === 'task' ? 'task' : 'project'
}

export function assertProjectRegistry(
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

export function sameSessionUsage(
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

export function selectSessionNameModel(
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

export function sameSessionNamingSettings(
  first: SessionNamingSettings,
  second: SessionNamingSettings
): boolean {
  if (first.mode !== second.mode) return false
  if (first.mode !== 'model' || second.mode !== 'model') return true
  return first.provider === second.provider && first.modelId === second.modelId
}

export function sameAppearanceSettings(first: AppearanceSettings, second: AppearanceSettings): boolean {
  return first.theme === second.theme &&
    first.accentColor === second.accentColor &&
    first.surfaceTransparency === second.surfaceTransparency &&
    first.textSize === second.textSize &&
    first.tokenCountFormat === second.tokenCountFormat &&
    first.uiFontFamily === second.uiFontFamily &&
    first.codeFontFamily === second.codeFontFamily
}

export function sameGeneralSettings(first: GeneralSettings, second: GeneralSettings): boolean {
  return first.startupWorkspaceRestore === second.startupWorkspaceRestore &&
    first.doubleClickBorderMaximize === second.doubleClickBorderMaximize &&
    first.fastExtensionLoading === second.fastExtensionLoading &&
    first.autoContinueInterruptedTasks === second.autoContinueInterruptedTasks
}

export function sameSubagentSettings(first: SubagentSettings, second: SubagentSettings): boolean {
  return first.maxDepth === second.maxDepth
}

export function sameShortcutSettings(first: ShortcutSettings, second: ShortcutSettings): boolean {
  return Object.keys(first).every((actionId) =>
    first[actionId as keyof ShortcutSettings] === second[actionId as keyof ShortcutSettings]
  )
}

export function createCompactionLifecycle(revision: number): CompactionLifecycle {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  void promise.catch(() => {})
  return { revision, promise, resolve, reject, settled: false }
}

export function compactionReason(value: unknown): KernelCompactionReason | null {
  return value === 'manual' || value === 'threshold' || value === 'overflow' ? value : null
}

export function isCompactionResult(value: unknown): value is Record<string, unknown> {
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

export function isOptionalCompactionResult(value: unknown): boolean {
  return value === undefined || value === null || isCompactionResult(value)
}

export function normalizeGeneratedSessionName(value: string): string | null {
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

export function firstUserMessage(entries: KernelConversationEntry[]): string | null {
  const entry = entries.find((candidate) =>
    candidate.kind === 'message' &&
    candidate.role === 'user' &&
    candidate.text.trim().length > 0
  )
  return entry?.kind === 'message' ? entry.text : null
}

export function lastAssistantMessage(entries: KernelConversationEntry[]): string | null {
  const entry = [...entries].reverse().find((candidate) =>
    candidate.kind === 'message' &&
    candidate.role === 'assistant' &&
    candidate.text.trim().length > 0
  )
  return entry?.kind === 'message' ? entry.text : null
}

export function lastAssistantFinalAnswer(entries: KernelConversationEntry[]): string | null {
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

export function thinkingLevel(value: unknown): ThinkingLevel | null {
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

export function assertNoCommandArgument(command: KernelCommandDescriptor, argument: string): void {
  if (argument.trim().length > 0) throw new Error(`/${command.name} does not accept arguments.`)
}

export function parseModelArgument(argument: string): { provider: string, modelId: string } {
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

export function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function unsupportedBlockingExtensionUiRequest(
  event: PiRpcEvent
): { id: string, method: 'select' | 'confirm' | 'input' | 'editor' } | null {
  if (event.type !== 'extension_ui_request' || typeof event.id !== 'string') return null
  const method = event.method
  if (method !== 'select' && method !== 'confirm' && method !== 'input' && method !== 'editor') {
    return null
  }
  return { id: event.id, method }
}

export function assertSessionPreviewRequestId(requestId: string): void {
  if (
    requestId.length === 0 ||
    requestId.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/u.test(requestId)
  ) {
    throw new Error('Session preview request ID is invalid.')
  }
}

export function assertConversationPageRequest(
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

export function sessionPreviewAbortError(): Error {
  const error = new Error('Session preview was cancelled.')
  error.name = 'AbortError'
  return error
}

export function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

export function formatExitError(code: number | null, signal: string | null): string {
  return code !== null
    ? `Pi RPC process exited with code ${code}.`
    : `Pi RPC process exited from signal ${signal ?? 'unknown'}.`
}

export function contextKey(projectPath: string, sessionKey: string): string {
  return `${projectPath}\u0000${sessionKey}`
}

export function hasProjectedToolImage(
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

export function isSubagentToolName(value: string): boolean {
  return value.trim().toLowerCase().split(/[.:/]/u).at(-1) === 'subagent'
}

export function toolImageCacheKey(
  projectPath: string,
  sessionId: string,
  sessionKey: string,
  toolCallId: string,
  contentIndex: number
): string {
  return `${projectPath}\0${sessionId}\0${sessionKey}\0${toolCallId}\0${contentIndex}`
}
