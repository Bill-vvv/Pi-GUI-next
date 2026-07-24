export const KERNEL_COMMAND_CHANNEL = 'pi-gui:kernel-command'
export const KERNEL_EVENT_CHANNEL = 'pi-gui:kernel-event'
export const OPEN_EXTERNAL_CHANNEL = 'pi-gui:open-external'

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
}

export type KernelSessionSummary = {
  key: string
  id: string
  name: string | null
  lastActivityAt: number | null
  runtimeStatus: RuntimeStatus
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

export type KernelModelState = {
  provider: string
  id: string
  name: string
  reasoning: boolean
  thinkingLevelMap: ThinkingLevelMap
  contextWindow: number | null
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
}

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
}

export const DEFAULT_GENERAL_SETTINGS: GeneralSettings = {
  startupWorkspaceRestore: 'restore'
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

export type KernelState = {
  projects: KernelProjectState[]
  activeProjectKey: string | null
  sessions: KernelSessionSummary[]
  activeSessionKey: string | null
  commands: KernelCommandDescriptor[]
  extensions: KernelExtensionDescriptor[]
  availableModels: KernelModelState[]
  sessionNaming: SessionNamingSettings
  appearance: AppearanceSettings
  general: GeneralSettings
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
  | { type: 'kernel.activate-session'; sessionKey: string }
  | { type: 'kernel.archive-session'; sessionKey: string }
  | { type: 'kernel.preview-session'; sessionKey: string }
  | { type: 'kernel.reorder-projects'; projectKeys: string[] }
  | { type: 'kernel.reorder-sessions'; sessionKeys: string[] }
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

export type KernelApi = {
  getPathForFile: (file: File) => string
  getState: () => Promise<KernelState>
  listSystemFonts: () => Promise<string[]>
  addProject: () => Promise<KernelState>
  activateProject: (projectKey: string) => Promise<KernelState>
  startSession: () => Promise<KernelState>
  activateSession: (sessionKey: string) => Promise<KernelState>
  archiveSession: (sessionKey: string) => Promise<KernelState>
  previewSession: (sessionKey: string) => Promise<KernelSessionPreview>
  reorderProjects: (projectKeys: string[]) => Promise<KernelState>
  reorderSessions: (sessionKeys: string[]) => Promise<KernelState>
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
  invokeCommand: (commandId: string, argument: string) => Promise<KernelState>
  openExternal: (url: string) => Promise<void>
  subscribe: (listener: (event: KernelEvent) => void) => () => void
}
