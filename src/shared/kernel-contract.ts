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

export type KernelProjectState = {
  path: string
  sessionCount?: number
  unreadCount?: number
  busySessionCount?: number
  /** Navigator 摘要；每个 Project 自己的 Session 列表，供多 Project 同时展开。 */
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
  requiresReload?: boolean
  statistics: KernelSessionStatistics | null
}

export type KernelCommandSource = 'gui' | 'pi-rpc' | 'extension' | 'prompt' | 'skill'

export type KernelCommandDescriptor = {
  id: string
  name: string
  description: string
  source: KernelCommandSource
  argumentHint: string | null
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
  filtered: boolean
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
  uiFontFamily: string | null
  codeFontFamily: string | null
}

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  theme: 'system',
  accentColor: 'amber',
  surfaceTransparency: 20,
  textSize: 'default',
  uiFontFamily: null,
  codeFontFamily: null
}

export type GeneralSettings = {
  startupWorkspaceRestore: 'restore' | 'none'
  /** Double-click window border toggles maximize/restore. Exclusive fullscreen uses F11. */
  doubleClickBorderMaximize: boolean
}

export const DEFAULT_GENERAL_SETTINGS: GeneralSettings = {
  startupWorkspaceRestore: 'restore',
  doubleClickBorderMaximize: true
}

export type KernelSessionState = {
  id: string | null
  name: string | null
  resumeAvailable: boolean
  model: KernelModelState | null
  usage: KernelSessionUsage | null
  thinkingLevel: ThinkingLevel | null
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
}

export type KernelErrorEntry = {
  id: string
  kind: 'error'
  title: string
  message: string
  source: 'agent' | 'extension'
  timestamp: number
}

export type KernelConversationEntry =
  | KernelMessageEntry
  | KernelThinkingEntry
  | KernelToolEntry
  | KernelErrorEntry

export type KernelConversationState = {
  entries: KernelConversationEntry[]
  activeRunStartIndex: number | null
}

export type KernelSessionPreview = {
  projectKey: string
  sessionKey: string
  sessionId: string
  sessionName: string | null
  conversation: KernelConversationState
}

export type KernelForkCandidate = {
  entryId: string
  text: string
  timestamp: string
}

export type KernelForkResult = {
  state: KernelState
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

export type KernelArchiveResult = {
  state: KernelState
  receipt: KernelArchiveReceipt
}

export type KernelSessionExportResult = {
  saved: boolean
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

export type KernelState = {
  projects: KernelProjectState[]
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
  shortcuts: ShortcutSettings
  runtime: KernelRuntimeState
  session: KernelSessionState
  conversation: KernelConversationState
}

export type KernelConversationEntryPatch =
  | { type: 'insert'; index: number; entry: KernelConversationEntry }
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
      from: number
      output: string
      status: KernelToolEntry['status']
      details: string
      truncated: boolean
      durationMs: number | null
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
  | { type: 'kernel.list-system-fonts' }
  | { type: 'kernel.add-project' }
  | { type: 'kernel.activate-project'; projectKey: string }
  | { type: 'kernel.start-session' }
  | { type: 'kernel.reload-session' }
  | {
      type: 'kernel.resolve-project-trust'
      requestId: string
      choice: KernelProjectTrustChoice
    }
  | { type: 'kernel.activate-session'; sessionKey: string }
  | { type: 'kernel.archive-session'; sessionKey: string }
  | { type: 'kernel.undo-archive-session'; token: string }
  | { type: 'kernel.preview-session'; sessionKey: string }
  | { type: 'kernel.preview-archived-session'; token: string }
  | { type: 'kernel.list-fork-candidates' }
  | { type: 'kernel.fork-session'; entryId: string }
  | { type: 'kernel.export-session' }
  | { type: 'kernel.search-project-paths'; query: string }
  | { type: 'kernel.reorder-projects'; projectKeys: string[] }
  | { type: 'kernel.install-extension'; kind: KernelExtensionSelectionKind }
  | { type: 'kernel.remove-extension'; path: string }
  | { type: 'kernel.search-pi-dev-extensions'; query: string }
  | { type: 'kernel.search-pi-dev-packages'; query: string }
  | { type: 'kernel.list-pi-packages' }
  | { type: 'kernel.install-pi-dev-package'; name: string }
  | { type: 'kernel.remove-pi-package'; source: string }
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
  | { type: 'kernel.prompt'; message: string; attachments?: KernelPromptAttachment[] }
  | { type: 'kernel.steer'; message: string; attachments?: KernelPromptAttachment[] }
  | { type: 'kernel.follow-up'; message: string; attachments?: KernelPromptAttachment[] }
  | { type: 'kernel.abort' }
  | { type: 'kernel.set-model'; provider: string; modelId: string }
  | { type: 'kernel.set-thinking-level'; level: ThinkingLevel }
  | { type: 'kernel.set-session-naming'; settings: SessionNamingSettings }
  | { type: 'kernel.set-appearance'; settings: AppearanceSettings }
  | { type: 'kernel.set-general'; settings: GeneralSettings }
  | { type: 'kernel.set-shortcuts'; settings: ShortcutSettings }
  | { type: 'kernel.invoke-command'; commandId: string; argument: string }

export type KernelEvent =
  | {
      type: 'kernel.state-changed'
      state: KernelState
    }
  | {
      type: 'kernel.state-patched'
      patch: KernelStatePatch
    }
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
  getState: () => Promise<KernelState>
  listSystemFonts: () => Promise<string[]>
  addProject: () => Promise<KernelState>
  activateProject: (projectKey: string) => Promise<KernelState>
  startSession: () => Promise<KernelState>
  reloadSession: () => Promise<KernelState>
  resolveProjectTrust: (
    requestId: string,
    choice: KernelProjectTrustChoice
  ) => Promise<KernelState>
  activateSession: (sessionKey: string) => Promise<KernelState>
  archiveSession: (sessionKey: string) => Promise<KernelArchiveResult>
  undoArchiveSession: (token: string) => Promise<KernelState>
  previewSession: (sessionKey: string) => Promise<KernelSessionPreview>
  previewArchivedSession: (token: string) => Promise<KernelSessionPreview>
  listForkCandidates: () => Promise<KernelForkCandidate[]>
  forkSession: (entryId: string) => Promise<KernelForkResult>
  exportSession: () => Promise<KernelSessionExportResult>
  searchProjectPaths: (query: string) => Promise<KernelProjectPathSearchResult>
  reorderProjects: (projectKeys: string[]) => Promise<KernelState>
  installExtension: (kind: KernelExtensionSelectionKind) => Promise<KernelState>
  removeExtension: (path: string) => Promise<KernelState>
  searchPiDevExtensions: (query: string) => Promise<KernelPiDevCatalog>
  searchPiDevPackages: (query: string) => Promise<KernelPiDevCatalog>
  listPiPackages: () => Promise<KernelInstalledPackage[]>
  installPiDevPackage: (name: string) => Promise<KernelState>
  removePiPackage: (source: string) => Promise<KernelState>
  updatePiPackage: (source: string) => Promise<KernelState>
  updatePiPackages: () => Promise<KernelState>
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
  prompt: (message: string, attachments?: KernelPromptAttachment[]) => Promise<KernelState>
  steer: (message: string, attachments?: KernelPromptAttachment[]) => Promise<KernelState>
  followUp: (message: string, attachments?: KernelPromptAttachment[]) => Promise<KernelState>
  abort: () => Promise<KernelState>
  setModel: (provider: string, modelId: string) => Promise<KernelState>
  setThinkingLevel: (level: ThinkingLevel) => Promise<KernelState>
  setSessionNaming: (settings: SessionNamingSettings) => Promise<KernelState>
  setAppearance: (settings: AppearanceSettings) => Promise<KernelState>
  setGeneral: (settings: GeneralSettings) => Promise<KernelState>
  setShortcuts: (settings: ShortcutSettings) => Promise<KernelState>
  invokeCommand: (commandId: string, argument: string) => Promise<KernelState>
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
