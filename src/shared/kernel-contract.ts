export const KERNEL_COMMAND_CHANNEL = 'pi-gui:kernel-command'
export const KERNEL_EVENT_CHANNEL = 'pi-gui:kernel-event'
export const PROVIDER_AUTH_EVENT_CHANNEL = 'pi-gui:provider-auth-event'
export const OPEN_EXTERNAL_CHANNEL = 'pi-gui:open-external'
export const WINDOW_TOGGLE_FULLSCREEN_CHANNEL = 'pi-gui:window.toggle-fullscreen'
export const WINDOW_IS_FULLSCREEN_CHANNEL = 'pi-gui:window.is-fullscreen'
export const WINDOW_FULLSCREEN_CHANGED_CHANNEL = 'pi-gui:window.fullscreen-changed'
export const WINDOW_TOGGLE_MAXIMIZE_CHANNEL = 'pi-gui:window.toggle-maximize'
export const WINDOW_IS_MAXIMIZED_CHANNEL = 'pi-gui:window.is-maximized'
export const WINDOW_MAXIMIZED_CHANGED_CHANNEL = 'pi-gui:window.maximized-changed'

import type { ShortcutSettings } from './shortcut-settings'
export type { ShortcutActionId, ShortcutBinding, ShortcutSettings } from './shortcut-settings'

export type RuntimeStatus =
  | 'stopped'
  | 'starting'
  | 'ready'
  | 'running'
  | 'stopping'
  | 'crashed'

export type ThinkingLevel =
  | 'off'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'

export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>

export type KernelRuntimeState = {
  status: RuntimeStatus
  executable: string | null
  version: string | null
  stderrChars: number
  stderrSummary: string | null
  lastError: string | null
  exitCode: number | null
  exitSignal: string | null
}

/**
 * Exact unavailable reasons for on-demand Runtime memory diagnostics.
 * Consumers must not invent alternate spellings or free-form strings.
 */
export type KernelRuntimeMemoryUnavailableReason =
  | 'platform-unsupported'
  | 'invalid-pid'
  | 'process-gone'
  | 'smaps-unreadable'
  | 'pid-unavailable'
  | 'stale'
  | 'ownership-changed'

/**
 * On-demand memory sample for one managed RuntimeContext.
 * Root Pi RPC process only; descendants are not aggregated.
 * Never enters Conversation/Timeline or periodic KernelState.
 * Must not carry Session identity, project path, names, prompt/output, or filesystem paths.
 */
export type KernelRuntimeMemorySample = {
  /** Opaque process-lifetime id owned by RuntimeContext; encodes no Session/Project identity. */
  runtimeId: string
  active: boolean
  runtimeStatus: RuntimeStatus
  /** Root Pi RPC PID, or null when the process is not running / unavailable. */
  rootPid: number | null
  /** Canonical RSS bytes from `/proc/<pid>/smaps_rollup`, or null when unavailable. */
  rssBytes: number | null
  /** Canonical PSS bytes from `/proc/<pid>/smaps_rollup`, or null when unavailable. */
  pssBytes: number | null
  /** Unix epoch milliseconds when this sample was taken. */
  sampledAt: number
  /** Null when RSS/PSS are available; otherwise an exact unavailable-reason literal. */
  unavailableReason: KernelRuntimeMemoryUnavailableReason | null
}

/** Bounded on-demand snapshot across every managed RuntimeContext. */
export type KernelRuntimeMemoryDiagnostics = {
  /** Unix epoch milliseconds for the overall request. */
  sampledAt: number
  runtimes: KernelRuntimeMemorySample[]
}

export type KernelNavigatorKind = 'project' | 'task'

export type KernelProjectState = {
  path: string
  /** Internal Runtime workspace kind. Task paths are never rendered as Projects. */
  workspaceKind?: KernelNavigatorKind
  /** Stable user-facing Task identity; present only for task workspaces. */
  taskKey?: string
  sessionCount?: number
  busySessionCount?: number
  /** Navigator 摘要；每个 Runtime workspace 自己的 Session 列表。 */
  sessions?: KernelSessionSummary[]
}

export type KernelProjectTrustChoice =
  | 'persist-trusted'
  | 'persist-untrusted'
  | 'once-trusted'
  | 'once-untrusted'
  | 'cancel'

export type KernelProjectTrustRequest = {
  id: string
  projectPath: string
}

export type KernelSessionSummary = {
  key: string
  id: string
  name: string | null
  lastActivityAt: number | null
  runtimeStatus: RuntimeStatus
  awaitingUserInput: boolean
  requiresReload?: boolean
  /** In-memory new Session before Pi JSONL materializes; not present in XDG index. */
  provisional?: true
  statistics: KernelSessionStatistics | null
}

export type KernelCommandSource = 'gui' | 'pi-rpc' | 'extension' | 'prompt' | 'skill'

export type KernelCommandSourceInfo = {
  source: string
  scope: 'user' | 'project' | 'temporary'
  origin: 'package' | 'top-level'
}

export type KernelCommandDescriptor = {
  id: string
  name: string
  description: string
  source: KernelCommandSource
  argumentHint: string | null
  sourceInfo: KernelCommandSourceInfo | null
}

export type KernelExtensionDescriptor = {
  path: string
  name: string
}

export type KernelExtensionSelectionKind = 'file' | 'directory'

export type KernelPiDevPackage = {
  name: string
  description: string
  downloads: string
  detailUrl: string
  installed: boolean
}

export type KernelPiDevCatalog = {
  packages: KernelPiDevPackage[]
  total: number
}

export type KernelInstalledPackage = {
  source: string
  packageName: string | null
  filtered: boolean
  extensionEnabled: boolean
}

export type KernelPiPackageInstallStatus = 'queued' | 'running' | 'succeeded' | 'failed'

export type KernelPiPackageInstallJob = {
  id: string
  name: string
  status: KernelPiPackageInstallStatus
  error: string | null
}

export type KernelModelPricingTier = {
  /** This tier applies when the model input exceeds this token count. */
  inputTokensAbove: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type KernelModelPricing = {
  /** Rates are USD per one million tokens. */
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  tiers?: KernelModelPricingTier[]
}

export type KernelModelState = {
  provider: string
  id: string
  name: string
  reasoning: boolean
  thinkingLevelMap: ThinkingLevelMap
  contextWindow: number | null
  pricing?: KernelModelPricing
}

export type KernelSessionUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  contextTokens: number | null
  contextWindow: number | null
  contextPercent: number | null
  cost: number
}

export type KernelSessionStatistics = {
  userMessages: number
  assistantMessages: number
  toolCalls: number
  toolResults: number
  totalMessages: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  cost: number
}

export type KernelCompactionReason = 'manual' | 'threshold' | 'overflow'

export type KernelCompactionState = {
  reason: KernelCompactionReason
}

export type KernelCompactionOutcome = 'completed' | 'retrying' | 'cancelled' | 'failed'

export const KERNEL_PROVIDER_APIS = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai'
] as const

export type KernelProviderApi = typeof KERNEL_PROVIDER_APIS[number]

export type KernelProviderModelConfig = {
  id: string
  name: string | null
  reasoning: boolean | null
  input: Array<'text' | 'image'> | null
  contextWindow: number | null
  maxTokens: number | null
  cost: KernelModelPricing | null
}

export type KernelProviderCatalogModel = {
  id: string
  name: string | null
  reasoning: boolean | null
  input: Array<'text' | 'image'> | null
  contextWindow: number | null
  maxTokens: number | null
}

export type KernelProviderConfig = {
  id: string
  baseUrl: string
  api: KernelProviderApi
  apiKeyConfigured: boolean
  authHeader: boolean
  models: KernelProviderModelConfig[]
  catalogModels: KernelProviderCatalogModel[]
}

export type KernelProviderInput = {
  originalId: string | null
  id: string
  baseUrl: string
  api: KernelProviderApi
  apiKey: string | null
  removeApiKey: boolean
  authHeader: boolean
  models: KernelProviderModelConfig[]
}

export type KernelProviderTestResult = {
  provider: string
  modelId: string
  durationMs: number
}

export type KernelModelPricingFetchResult = {
  source: 'litellm'
  matches: Array<{
    modelId: string
    modelKey: string
    pricing: KernelModelPricing
  }>
  missingModelIds: string[]
}

export type KernelProviderAuthType = 'api_key' | 'oauth'

export type KernelProviderAuthSource =
  | 'stored'
  | 'runtime'
  | 'environment'
  | 'fallback'
  | 'models_json_key'
  | 'models_json_command'

export type KernelProviderAuthMethod = {
  type: KernelProviderAuthType
  name: string
  label: string | null
}

export type KernelProviderCredential = {
  providerId: string
  providerName: string
  configured: boolean
  source: KernelProviderAuthSource | null
  storedCredentialType: KernelProviderAuthType | null
  methods: KernelProviderAuthMethod[]
}

export type KernelProviderAuthPrompt =
  | {
      type: 'text' | 'secret' | 'manual_code'
      message: string
      placeholder: string | null
    }
  | {
      type: 'select'
      message: string
      options: Array<{
        id: string
        label: string
        description: string | null
      }>
    }

export type KernelProviderAuthNotice =
  | {
      type: 'info'
      message: string
      links: Array<{ url: string, label: string | null }>
    }
  | {
      type: 'auth_url'
      url: string
      instructions: string | null
    }
  | {
      type: 'device_code'
      userCode: string
      verificationUri: string
      intervalSeconds: number | null
      expiresInSeconds: number | null
    }
  | {
      type: 'progress'
      message: string
    }

export type KernelProviderAuthEvent =
  | {
      type: 'provider-auth.started'
      operationId: string
      providerId: string
      authType: KernelProviderAuthType
    }
  | {
      type: 'provider-auth.prompt'
      operationId: string
      promptId: string
      providerId: string
      prompt: KernelProviderAuthPrompt
    }
  | {
      type: 'provider-auth.notice'
      operationId: string
      providerId: string
      notice: KernelProviderAuthNotice
    }

export type SessionNamingSettings =
  | { mode: 'auto' }
  | { mode: 'off' }
  | { mode: 'model'; provider: string; modelId: string }

export const DEFAULT_SESSION_NAMING_SETTINGS: SessionNamingSettings = { mode: 'auto' }

export type AppearanceSettings = {
  theme: 'system' | 'dark' | 'light'
  accentColor: 'amber' | 'blue' | 'green' | 'purple' | 'rose'
  surfaceTransparency: 0 | 10 | 20 | 30 | 40
  textSize: 'small' | 'default' | 'large'
  tokenCountFormat: 'full' | 'compact'
  uiFontFamily: string | null
  codeFontFamily: string | null
}

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  theme: 'system',
  accentColor: 'amber',
  surfaceTransparency: 20,
  textSize: 'default',
  tokenCountFormat: 'full',
  uiFontFamily: null,
  codeFontFamily: null
}

export type GeneralSettings = {
  startupWorkspaceRestore: 'restore' | 'none'
  /** Double-click window border toggles maximize/restore. Exclusive fullscreen uses F11. */
  doubleClickBorderMaximize: boolean
  fastExtensionLoading: boolean
  /** Opt-in orderly-shutdown snapshot and one-shot continuation on next startup. */
  autoContinueInterruptedTasks: boolean
}

export const DEFAULT_GENERAL_SETTINGS: GeneralSettings = {
  startupWorkspaceRestore: 'restore',
  doubleClickBorderMaximize: true,
  fastExtensionLoading: false,
  autoContinueInterruptedTasks: false
}

export const SUBAGENT_PACKAGE_NAME = 'pi-subagents'
export const MAGIC_CONTEXT_PACKAGE_NAME = '@cortexkit/pi-magic-context'

export type SubagentSettings = {
  maxDepth: 1 | 2 | 3
}

export const DEFAULT_SUBAGENT_SETTINGS: SubagentSettings = {
  maxDepth: 3
}

export type KernelSubagentDefinitionScope = 'builtin' | 'user' | 'project'
export type KernelSubagentEditableScope = Exclude<KernelSubagentDefinitionScope, 'builtin'>

export type KernelSubagentDefinition = {
  id: string
  scope: KernelSubagentDefinitionScope
  editable: boolean
  enabled: boolean
  name: string
  description: string
  systemPrompt: string
  model: string | null
  fallbackModels: string[] | null
  thinking: ThinkingLevel | null
  systemPromptMode: 'replace' | 'append'
  inheritProjectContext: boolean
  inheritSkills: boolean
  defaultContext: 'fresh' | 'fork' | null
  tools: string[] | null
  skills: string[] | null
  defaultAsync: boolean | null
  timeoutMs: number | null
  maxTurns: number | null
  maxSubagentDepth: number | null
}

export type KernelSubagentDefinitionInput = Omit<
  KernelSubagentDefinition,
  'id' | 'editable' | 'enabled' | 'scope'
> & {
  originalId: string | null
  scope: KernelSubagentEditableScope
}

export type KernelSessionState = {
  id: string | null
  name: string | null
  resumeAvailable: boolean
  model: KernelModelState | null
  usage: KernelSessionUsage | null
  thinkingLevel: ThinkingLevel | null
  openAiFastMode: boolean
  messageCount: number
  pendingMessageCount: number
  pendingSteeringMessages: string[]
  pendingFollowUpMessages: string[]
  compaction: KernelCompactionState | null
  settled: boolean
}

export type KernelMessagePhase = 'commentary' | 'final_answer'

export type KernelPromptImage = {
  type: 'image'
  mimeType: string
  data: string
}

export type KernelPromptAttachment =
  | {
      type: 'file'
      name: string
      path: string
    }
  | {
      type: 'image'
      name: string
      path: string
      image: KernelPromptImage
      hints: string[]
    }

export type KernelMessageAttachment =
  | {
      type: 'file'
      name: string
      path: string
    }
  | {
      type: 'image'
      name: string
      path: string
      hints: string[]
    }

export type KernelMessageEntry = {
  id: string
  kind: 'message'
  role: 'user' | 'assistant'
  phase?: KernelMessagePhase | null
  text: string
  timestamp: number
  streaming: boolean
  stopReason: string | null
  error: string | null
  attachments?: KernelMessageAttachment[]
}

export type KernelThinkingEntry = {
  id: string
  kind: 'thinking'
  text: string
  summary: boolean
  timestamp: number
  streaming: boolean
}

export type KernelAdvisorEntry = {
  id: string
  kind: 'advisor'
  advisorSlug: string
  advisorName: string
  severity: 'nit' | 'concern' | 'blocker'
  guidance: string
  content: string
  delivery: 'aside' | 'steer'
  timestamp: number
}

export type KernelSubagentStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'paused'
  | 'detached'

export type KernelSubagentUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
}

export type KernelSubagentOutputReference = {
  agent: string | null
  path: string
  sizeLabel: string | null
  lines: number | null
}

export type KernelSubagentParticipant = {
  index: number
  agent: string
  status: KernelSubagentStatus
  task: string
  model: string | null
  usage: KernelSubagentUsage | null
  currentTool: string | null
  currentPath: string | null
  toolCount: number
  turnCount: number
  tokens: number
  durationMs: number
  error: string | null
  finalOutput: string | null
  outputReferences: KernelSubagentOutputReference[]
}

export type KernelSubagentRun = {
  mode: 'single' | 'parallel' | 'chain'
  runId: string | null
  asyncId: string | null
  participants: KernelSubagentParticipant[]
}

export type KernelTodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'
export type KernelTodoPriority = 'high' | 'medium' | 'low'

export type KernelTodoItem = {
  id: string | null
  content: string
  status: KernelTodoStatus
  priority: KernelTodoPriority | null
}

/** Metadata-only tool result image; base64 stays in Pi transcript / on-demand IPC. */
export type KernelToolImageAttachment = {
  type: 'image'
  name: string
  mimeType: string
  byteLength: number
  /** Stable index into the original Pi toolResult content array. */
  contentIndex: number
}

export type KernelAskOption = {
  value: string
  label: string
  description: string | null
}

export type KernelAskQuestion = {
  id: string
  prompt: string
  type: 'single' | 'multiple' | 'text'
  options: KernelAskOption[]
  placeholder: string | null
}

export type KernelAskAnswer = {
  questionId: string
  value: string | string[]
  customValue?: string
}

export type KernelAskToolState = {
  questions: KernelAskQuestion[]
  status: 'waiting' | 'submitting'
  error: string | null
}

export type KernelToolEntry = {
  id: string
  kind: 'tool'
  toolCallId: string
  name: string
  status: 'pending' | 'running' | 'success' | 'error'
  args: string
  output: string
  details: string
  truncated: boolean
  timestamp: number
  durationMs: number | null
  subagent: KernelSubagentRun | null
  ask?: KernelAskToolState
  todos?: KernelTodoItem[]
  /** Metadata-only image attachments from toolResult content; never includes base64. */
  attachments?: KernelToolImageAttachment[]
}

export type KernelToolEntryPatchMetadata = {
  status: KernelToolEntry['status']
  details: string
  truncated: boolean
  durationMs: number | null
  subagent: KernelSubagentRun | null
  todos: KernelTodoItem[] | undefined
  attachments: KernelToolImageAttachment[] | undefined
}

export type KernelSubagentCoordination = {
  runId: string
  agent: string
  participantIndex: number | null
  requestId: string | null
  reason: string | null
  requiresReply: boolean
  status: 'pending' | 'handled'
  resolvedAt: number | null
}

export type KernelSubagentNoticeEntry = {
  id: string
  kind: 'subagent-notice'
  noticeType:
    | 'completion'
    | 'control'
    | 'steering'
    | 'request'
    | 'admin'
    | 'command'
    | 'watchdog-concern'
    | 'watchdog-blocker'
  text: string
  timestamp: number
  completion?: KernelSubagentParticipant
  coordination?: KernelSubagentCoordination
}

export type KernelExtensionStatusEntry = {
  id: string
  kind: 'extension-status'
  source: 'magic-context'
  title: string
  text: string
  level: 'info' | 'success' | 'warning' | 'error'
  timestamp: number
}

export type KernelErrorEntry = {
  id: string
  kind: 'error'
  title: string
  message: string
  source: 'agent' | 'extension'
  timestamp: number
}

/** Local GUI projection only; never written into the Pi session file. */
export type KernelCommandEntry = {
  id: string
  kind: 'command'
  commandId: string
  name: string
  argument: string
  source: KernelCommandSource
  text: string
  timestamp: number
}

export type KernelConversationEntry =
  | KernelMessageEntry
  | KernelThinkingEntry
  | KernelAdvisorEntry
  | KernelToolEntry
  | KernelSubagentNoticeEntry
  | KernelExtensionStatusEntry
  | KernelCommandEntry
  | KernelErrorEntry

export type KernelConversationPreviewState = {
  entries: KernelConversationEntry[]
  /** Preview-local index; previews are read-only and are never patched. */
  activeRunStartIndex: number | null
}

export type KernelConversationState = {
  entries: KernelConversationEntry[]
  /** Absolute index of entries[0] in Main's complete active Conversation. */
  startIndex: number
  /** Absolute index in Main's complete active Conversation. */
  activeRunStartIndex: number | null
}

export type KernelSessionPreview = {
  projectKey: string
  sessionKey: string
  sessionId: string
  sessionName: string | null
  conversation: KernelConversationPreviewState
}

export type KernelConversationPageRequest = {
  projectKey: string
  sessionKey: string
  sessionId: string
  beforeIndex: number
  beforeEntryId: string
}

export type KernelConversationPage = KernelConversationPageRequest & {
  startIndex: number
  entries: KernelConversationEntry[]
}

export type KernelAssistantFinalAnswer = {
  projectKey: string
  sessionKey: string
  sessionId: string
  text: string | null
}

export type KernelForkCandidate = {
  entryId: string
  text: string
  timestamp: string
}

/** Narrow invoke acknowledgement for mutations that already publish state events. */
export type KernelMutationAck = {
  revision: number
}

/** Atomic initial/resync envelope: state paired with the Kernel publish revision. */
export type KernelSnapshot = {
  revision: number
  state: KernelState
}

export type KernelForkResult = KernelMutationAck & {
  draft: string
  cancelled: boolean
}

export type KernelArchiveReceipt = {
  token: string
  projectKey: string
  sessionKey: string
  sessionName: string | null
  durationMs: number
}

export type KernelArchiveResult = KernelMutationAck & {
  receipt: KernelArchiveReceipt
}

/** Fail-fast wire check for mutation invoke results (and fork/archive supersets). */
export function isKernelMutationAck(value: unknown): value is KernelMutationAck {
  if (!isPlainObject(value)) return false
  if (!isNonNegativeInteger(value.revision)) return false
  return true
}

/** Fail-fast wire check for snapshot envelopes from get-state / resync. */
export function isKernelSnapshot(value: unknown): value is KernelSnapshot {
  if (!isPlainObject(value)) return false
  if (!isNonNegativeInteger(value.revision)) return false
  if (!isPlainObject(value.state)) return false
  return true
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

export type KernelSessionExportResult = {
  saved: boolean
}

export type KernelMessageImage = {
  mimeType: string
  data: string
  name: string
  path: string
}

export type KernelProjectPathMatch = {
  path: string
  kind: 'file' | 'directory'
}

export type KernelProjectPathSearchResult = {
  projectKey: string
  query: string
  matches: KernelProjectPathMatch[]
}

export const FORK_SESSION_COMMAND_ID = 'builtin:fork'
export const EXPORT_SESSION_COMMAND_ID = 'builtin:export'
export const COPY_LAST_ANSWER_COMMAND_ID = 'builtin:copy'

export type KernelAdvisorState = {
  compatibility: 'unavailable' | 'ready' | 'incompatible'
  extensionVersion: string | null
  systemEnabled: boolean | null
  liveToggle: boolean
  multiAdvisor: boolean
  roster: boolean
  error: string | null
}

export const ADVISOR_TOOL_NAMES = [
  'read',
  'grep',
  'find',
  'ls',
  'edit',
  'write'
] as const

export type KernelAdvisorToolName = (typeof ADVISOR_TOOL_NAMES)[number]
export type KernelAdvisorDefinitionScope = 'builtin' | 'user' | 'inherited' | 'project'
export type KernelAdvisorEditableScope = Extract<
  KernelAdvisorDefinitionScope,
  'user' | 'project'
>

export type KernelAdvisorDefinition = {
  id: string
  slug: string
  scope: KernelAdvisorDefinitionScope
  sourcePath: string | null
  sourceOrder: number
  editable: boolean
  name: string
  enabled: boolean
  model: string | null
  thinking: ThinkingLevel | null
  tools: KernelAdvisorToolName[]
  instructions: string
}

export type KernelAdvisorSource = {
  id: string
  scope: KernelAdvisorDefinitionScope
  path: string | null
  sourceOrder: number
  editable: boolean
  instructions: string
}

export type KernelAdvisorDiagnostic = {
  sourcePath: string
  message: string
}

export type KernelAdvisorConfiguration = {
  definitions: KernelAdvisorDefinition[]
  sources: KernelAdvisorSource[]
  diagnostics: KernelAdvisorDiagnostic[]
}

export type KernelAdvisorDefinitionInput = {
  originalSlug: string | null
  scope: KernelAdvisorEditableScope
  name: string
  enabled: boolean
  model: string | null
  thinking: ThinkingLevel | null
  tools: KernelAdvisorToolName[]
  instructions: string
}

export type KernelState = {
  projects: KernelProjectState[]
  /** Selected top-level Navigator tab. Missing legacy fixtures default to project. */
  navigatorKind?: KernelNavigatorKind
  /** Active internal Runtime workspace path; task paths must not be rendered as Projects. */
  activeProjectKey: string | null
  sessions: KernelSessionSummary[]
  activeSessionKey: string | null
  projectTrustRequest: KernelProjectTrustRequest | null
  commands: KernelCommandDescriptor[]
  extensions: KernelExtensionDescriptor[]
  availableModels: KernelModelState[]
  sessionNaming: SessionNamingSettings
  appearance: AppearanceSettings
  general: GeneralSettings
  subagent: SubagentSettings
  shortcuts: ShortcutSettings
  advisor: KernelAdvisorState
  runtime: KernelRuntimeState
  session: KernelSessionState
  conversation: KernelConversationState
}

export type KernelConversationEntryPatch =
  | { type: 'insert'; index: number; entry: KernelConversationEntry }
  | {
      type: 'replace-entry'
      index: number
      expectedId: string
      entry: KernelConversationEntry
    }
  | {
      type: 'append-message-text'
      index: number
      from: number
      text: string
      streaming: boolean
      stopReason: string | null
      error: string | null
    }
  | {
      type: 'append-thinking-text'
      index: number
      from: number
      text: string
      streaming: boolean
    }
  | {
      type: 'append-tool-output'
      index: number
      toolCallId: string
      from: number
      output: string
      status: KernelToolEntry['status']
      details: string
      truncated: boolean
      durationMs: number | null
      subagent: KernelSubagentRun | null
    }
  | {
      type: 'replace-tool-metadata'
      index: number
      toolCallId: string
      expectedOutputLength: number
      expected: KernelToolEntryPatchMetadata
      metadata: KernelToolEntryPatchMetadata
    }

export type KernelConversationPatch = {
  entries?: KernelConversationEntryPatch[]
  activeRunStartIndex?: number | null
}

export type KernelStatePatch = {
  projectKey: string | null
  sessionKey: string | null
  runtime?: KernelRuntimeState
  session?: KernelSessionState
  conversation?: KernelConversationPatch
}

export type KernelCommand =
  | { type: 'kernel.get-state' }
  | { type: 'kernel.get-runtime-memory-diagnostics' }
  | { type: 'kernel.list-system-fonts' }
  | { type: 'kernel.add-project' }
  | { type: 'kernel.activate-project'; projectKey: string }
  | { type: 'kernel.refresh-workspace-metadata'; workspaceKey: string }
  | { type: 'kernel.select-navigator'; kind: KernelNavigatorKind }
  | { type: 'kernel.create-task' }
  | { type: 'kernel.activate-task'; taskKey: string }
  | { type: 'kernel.start-session' }
  | { type: 'kernel.reload-session' }
  | {
      type: 'kernel.resolve-project-trust'
      requestId: string
      choice: KernelProjectTrustChoice
    }
  | { type: 'kernel.activate-session'; sessionKey: string }
  | { type: 'kernel.load-earlier-conversation'; request: KernelConversationPageRequest }
  | { type: 'kernel.get-last-assistant-final-answer' }
  | { type: 'kernel.archive-session'; sessionKey: string }
  | { type: 'kernel.undo-archive-session'; token: string }
  | { type: 'kernel.preview-session'; sessionKey: string; requestId: string }
  | { type: 'kernel.complete-session-preview'; requestId: string }
  | { type: 'kernel.cancel-session-preview'; requestId: string }
  | { type: 'kernel.preview-archived-session'; token: string }
  | { type: 'kernel.list-fork-candidates' }
  | { type: 'kernel.fork-session'; entryId: string }
  | { type: 'kernel.navigate-history-prompt'; sessionKey: string; messageId: string }
  | { type: 'kernel.export-session' }
  | {
      type: 'kernel.get-message-image'
      sessionKey: string
      messageId: string
      attachmentIndex: number
    }
  | {
      type: 'kernel.get-tool-image'
      sessionKey: string
      toolCallId: string
      contentIndex: number
    }
  | { type: 'kernel.search-project-paths'; query: string }
  | { type: 'kernel.reorder-projects'; projectKeys: string[] }
  | { type: 'kernel.install-extension'; kind: KernelExtensionSelectionKind }
  | { type: 'kernel.remove-extension'; path: string }
  | { type: 'kernel.search-pi-dev-extensions'; query: string }
  | { type: 'kernel.search-pi-dev-packages'; query: string }
  | { type: 'kernel.list-pi-packages' }
  | { type: 'kernel.list-pi-package-install-jobs' }
  | { type: 'kernel.install-pi-dev-package'; name: string }
  | { type: 'kernel.remove-pi-package'; source: string }
  | { type: 'kernel.set-subagent-enabled'; enabled: boolean }
  | { type: 'kernel.set-magic-context-enabled'; enabled: boolean }
  | { type: 'kernel.set-advisor-system-enabled'; enabled: boolean }
  | { type: 'kernel.set-advisor-extension-enabled'; enabled: boolean }
  | { type: 'kernel.list-advisor-definitions' }
  | { type: 'kernel.save-advisor-definition'; definition: KernelAdvisorDefinitionInput }
  | {
      type: 'kernel.remove-advisor-definition'
      slug: string
      scope: KernelAdvisorEditableScope
    }
  | { type: 'kernel.list-subagent-definitions' }
  | { type: 'kernel.save-subagent-definition'; definition: KernelSubagentDefinitionInput }
  | {
      type: 'kernel.set-subagent-definition-enabled'
      id: string
      scope: KernelSubagentEditableScope
      enabled: boolean
    }
  | { type: 'kernel.remove-subagent-definition'; id: string }
  | { type: 'kernel.update-pi-package'; source: string }
  | { type: 'kernel.update-pi-packages' }
  | { type: 'kernel.list-providers' }
  | { type: 'kernel.save-provider'; provider: KernelProviderInput }
  | { type: 'kernel.remove-provider'; providerId: string }
  | { type: 'kernel.test-provider'; providerId: string; modelId: string }
  | { type: 'kernel.fetch-model-pricing'; providerId: string; modelIds: string[] }
  | { type: 'kernel.list-provider-credentials' }
  | {
      type: 'kernel.login-provider'
      providerId: string
      authType: KernelProviderAuthType
    }
  | {
      type: 'kernel.submit-provider-auth-prompt'
      operationId: string
      promptId: string
      value: string
    }
  | { type: 'kernel.cancel-provider-login'; operationId: string }
  | { type: 'kernel.logout-provider'; providerId: string }
  | { type: 'kernel.select-prompt-attachments' }
  | {
      type: 'kernel.submit-ask'
      sessionKey: string
      toolCallId: string
      answers: KernelAskAnswer[]
    }
  | { type: 'kernel.cancel-ask'; sessionKey: string; toolCallId: string }
  | {
      type: 'kernel.prompt'
      message: string
      attachments?: KernelPromptAttachment[]
      expectedSessionKey?: string
    }
  | { type: 'kernel.steer'; message: string; attachments?: KernelPromptAttachment[] }
  | { type: 'kernel.follow-up'; message: string; attachments?: KernelPromptAttachment[] }
  | { type: 'kernel.abort' }
  | { type: 'kernel.set-model'; provider: string; modelId: string }
  | { type: 'kernel.set-thinking-level'; level: ThinkingLevel }
  | { type: 'kernel.set-openai-fast-mode'; enabled: boolean }
  | { type: 'kernel.set-session-naming'; settings: SessionNamingSettings }
  | { type: 'kernel.set-appearance'; settings: AppearanceSettings }
  | { type: 'kernel.set-general'; settings: GeneralSettings }
  | { type: 'kernel.set-subagent'; settings: SubagentSettings }
  | { type: 'kernel.set-shortcuts'; settings: ShortcutSettings }
  | { type: 'kernel.invoke-command'; commandId: string; argument: string }

export type KernelStateEvent =
  | {
      type: 'kernel.state-changed'
      revision: number
      state: KernelState
    }
  | {
      type: 'kernel.state-patched'
      revision: number
      patch: KernelStatePatch
    }

export type KernelEvent =
  | KernelStateEvent
  | { type: 'kernel.state-batch'; events: KernelStateEvent[] }
  | { type: 'kernel.pi-package-install'; job: KernelPiPackageInstallJob }
  | {
      type: 'kernel.compaction-started'
      projectKey: string
      sessionKey: string
      reason: KernelCompactionReason
    }
  | {
      type: 'kernel.compaction-ended'
      projectKey: string
      sessionKey: string
      reason: KernelCompactionReason
      outcome: KernelCompactionOutcome
      willRetry: boolean
    }

export type KernelApi = {
  getPathForFile: (file: File) => string
  getState: () => Promise<KernelSnapshot>
  /**
   * On-demand read-only memory diagnostics for managed RuntimeContexts.
   * Does not mutate state, publish events, or touch Conversation/Timeline.
   */
  getRuntimeMemoryDiagnostics: () => Promise<KernelRuntimeMemoryDiagnostics>
  listSystemFonts: () => Promise<string[]>
  addProject: () => Promise<KernelMutationAck>
  activateProject: (projectKey: string) => Promise<KernelMutationAck>
  refreshWorkspaceMetadata: (workspaceKey: string) => Promise<KernelMutationAck>
  selectNavigator: (kind: KernelNavigatorKind) => Promise<KernelMutationAck>
  createTask: () => Promise<KernelMutationAck>
  activateTask: (taskKey: string) => Promise<KernelMutationAck>
  startSession: () => Promise<KernelMutationAck>
  reloadSession: () => Promise<KernelMutationAck>
  resolveProjectTrust: (
    requestId: string,
    choice: KernelProjectTrustChoice
  ) => Promise<KernelMutationAck>
  activateSession: (sessionKey: string) => Promise<KernelMutationAck>
  loadEarlierConversation: (
    request: KernelConversationPageRequest
  ) => Promise<KernelConversationPage>
  getLastAssistantFinalAnswer: () => Promise<KernelAssistantFinalAnswer>
  archiveSession: (sessionKey: string) => Promise<KernelArchiveResult>
  undoArchiveSession: (token: string) => Promise<KernelMutationAck>
  previewSession: (sessionKey: string, requestId: string) => Promise<KernelSessionPreview>
  completeSessionPreview: (requestId: string) => Promise<KernelSessionPreview>
  cancelSessionPreview: (requestId: string) => Promise<void>
  previewArchivedSession: (token: string) => Promise<KernelSessionPreview>
  listForkCandidates: () => Promise<KernelForkCandidate[]>
  forkSession: (entryId: string) => Promise<KernelForkResult>
  navigateHistoryPrompt: (sessionKey: string, messageId: string) => Promise<KernelMutationAck>
  exportSession: () => Promise<KernelSessionExportResult>
  getMessageImage: (
    sessionKey: string,
    messageId: string,
    attachmentIndex: number
  ) => Promise<KernelMessageImage>
  getToolImage: (
    sessionKey: string,
    toolCallId: string,
    contentIndex: number
  ) => Promise<KernelMessageImage>
  searchProjectPaths: (query: string) => Promise<KernelProjectPathSearchResult>
  reorderProjects: (projectKeys: string[]) => Promise<KernelMutationAck>
  installExtension: (kind: KernelExtensionSelectionKind) => Promise<KernelMutationAck>
  removeExtension: (path: string) => Promise<KernelMutationAck>
  searchPiDevExtensions: (query: string) => Promise<KernelPiDevCatalog>
  searchPiDevPackages: (query: string) => Promise<KernelPiDevCatalog>
  listPiPackages: () => Promise<KernelInstalledPackage[]>
  listPiPackageInstallJobs: () => Promise<KernelPiPackageInstallJob[]>
  installPiDevPackage: (name: string) => Promise<KernelMutationAck>
  removePiPackage: (source: string) => Promise<KernelMutationAck>
  setSubagentEnabled: (enabled: boolean) => Promise<KernelInstalledPackage[]>
  setMagicContextEnabled: (enabled: boolean) => Promise<KernelInstalledPackage[]>
  setAdvisorSystemEnabled: (enabled: boolean) => Promise<KernelMutationAck>
  setAdvisorExtensionEnabled: (enabled: boolean) => Promise<KernelInstalledPackage[]>
  listAdvisorDefinitions: () => Promise<KernelAdvisorConfiguration>
  saveAdvisorDefinition: (
    definition: KernelAdvisorDefinitionInput
  ) => Promise<KernelAdvisorConfiguration>
  removeAdvisorDefinition: (
    slug: string,
    scope: KernelAdvisorEditableScope
  ) => Promise<KernelAdvisorConfiguration>
  listSubagentDefinitions: () => Promise<KernelSubagentDefinition[]>
  saveSubagentDefinition: (
    definition: KernelSubagentDefinitionInput
  ) => Promise<KernelSubagentDefinition[]>
  setSubagentDefinitionEnabled: (
    id: string,
    scope: KernelSubagentEditableScope,
    enabled: boolean
  ) => Promise<KernelSubagentDefinition[]>
  removeSubagentDefinition: (id: string) => Promise<KernelSubagentDefinition[]>
  updatePiPackage: (source: string) => Promise<KernelMutationAck>
  updatePiPackages: () => Promise<KernelMutationAck>
  listProviders: () => Promise<KernelProviderConfig[]>
  saveProvider: (provider: KernelProviderInput) => Promise<KernelProviderConfig[]>
  removeProvider: (providerId: string) => Promise<KernelProviderConfig[]>
  testProvider: (providerId: string, modelId: string) => Promise<KernelProviderTestResult>
  fetchModelPricing: (
    providerId: string,
    modelIds: string[]
  ) => Promise<KernelModelPricingFetchResult>
  listProviderCredentials: () => Promise<KernelProviderCredential[]>
  loginProvider: (
    providerId: string,
    authType: KernelProviderAuthType
  ) => Promise<KernelProviderCredential[]>
  submitProviderAuthPrompt: (
    operationId: string,
    promptId: string,
    value: string
  ) => Promise<void>
  cancelProviderLogin: (operationId: string) => Promise<void>
  logoutProvider: (providerId: string) => Promise<KernelProviderCredential[]>
  selectPromptAttachments: () => Promise<KernelPromptAttachment[]>
  submitAsk: (
    sessionKey: string,
    toolCallId: string,
    answers: KernelAskAnswer[]
  ) => Promise<KernelMutationAck>
  cancelAsk: (sessionKey: string, toolCallId: string) => Promise<KernelMutationAck>
  prompt: (
    message: string,
    attachments?: KernelPromptAttachment[],
    expectedSessionKey?: string
  ) => Promise<KernelMutationAck>
  steer: (message: string, attachments?: KernelPromptAttachment[]) => Promise<KernelMutationAck>
  followUp: (message: string, attachments?: KernelPromptAttachment[]) => Promise<KernelMutationAck>
  abort: () => Promise<KernelMutationAck>
  setModel: (provider: string, modelId: string) => Promise<KernelMutationAck>
  setThinkingLevel: (level: ThinkingLevel) => Promise<KernelMutationAck>
  setOpenAiFastMode: (enabled: boolean) => Promise<KernelMutationAck>
  setSessionNaming: (settings: SessionNamingSettings) => Promise<KernelMutationAck>
  setAppearance: (settings: AppearanceSettings) => Promise<KernelMutationAck>
  setGeneral: (settings: GeneralSettings) => Promise<KernelMutationAck>
  setSubagent: (settings: SubagentSettings) => Promise<KernelMutationAck>
  setShortcuts: (settings: ShortcutSettings) => Promise<KernelMutationAck>
  invokeCommand: (commandId: string, argument: string) => Promise<KernelMutationAck>
  openExternal: (url: string) => Promise<void>
  toggleFullscreen: () => Promise<boolean>
  isFullscreen: () => Promise<boolean>
  subscribeFullscreen: (listener: (fullscreen: boolean) => void) => () => void
  toggleMaximize: () => Promise<boolean>
  isMaximized: () => Promise<boolean>
  subscribeMaximized: (listener: (maximized: boolean) => void) => () => void
  subscribeProviderAuth: (listener: (event: KernelProviderAuthEvent) => void) => () => void
  subscribe: (listener: (event: KernelEvent) => void) => () => void
}
