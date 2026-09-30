import type { ReactNode } from 'react'
import type { PromptDraftAttachment } from '../../../shared/desktop-attachment-contract'
import type {
  AppearanceSettings,
  GeneralSettings,
  KernelAskAnswer,
  KernelExtensionDialogRequest,
  KernelExtensionSelectionKind,
  KernelForkCandidate,
  KernelInstalledPackage,
  KernelModelPricingFetchResult,
  KernelPiPackageInstallJob,
  KernelPiDevCatalog,
  KernelProjectTrustChoice,
  KernelProjectPathSearchResult,
  KernelProviderAuthEvent,
  KernelProviderAuthType,
  KernelProviderConfig,
  KernelProviderCredential,
  KernelProviderInput,
  KernelProviderTestResult,
  KernelSessionPreview,
  KernelState,
  KernelSubagentDefinition,
  KernelSubagentTranscript,
  KernelSubagentEditableScope,
  KernelSubagentDefinitionInput,
  SessionNamingSettings,
  SubagentSettings,
  ShortcutSettings,
  ThinkingLevel
} from '../../../shared/kernel-contract'
import type {
  DesktopHostAccessStatus,
  RemoteAccessStatus,
  RemotePairingCode,
  TailscaleRemoteStatus
} from '../../../shared/remote-admin-contract'
import type { ComposerDraftRequest } from '../features/composer/Composer'
import type { WorkbenchClientSurface } from '../features/desktop-client/workbench-client-surface'
import type { WorkbenchActionFailure, WorkbenchActionOrigin, WorkbenchCompletedAction, WorkbenchOperation } from '../workbench-actions'

export type WorkbenchProps = {
  state: KernelState
  clientSurface: WorkbenchClientSurface
  sessionPreview: KernelSessionPreview | null
  archivedSessionPreview: KernelSessionPreview | null
  composerDraftRequest: ComposerDraftRequest | null
  viewedSessionKey: string | null
  viewingNewSession: boolean
  newSessionPrepared: boolean
  sessionPreviewPending: boolean
  pendingAction: WorkbenchOperation | null
  completedAction: WorkbenchCompletedAction | null
  actionFailure: WorkbenchActionFailure | null
  operationNotifications: ReactNode
  systemFonts: string[] | null
  systemFontsError: string | null
  packageInstallJobs: KernelPiPackageInstallJob[]
  forkDialogOpen: boolean
  forkCandidates: KernelForkCandidate[]
  forkCandidatesLoading: boolean
  forkError: string | null
  forkSubmitting: boolean
  forkPreferredUserText: string | null
  onDisconnectHost?: () => Promise<void>
  onRevokeHostPairing?: () => Promise<void>
  connectedHostAlias?: string
  onAddProject: (projectPath?: string) => Promise<void>
  onActivateProject: (projectKey: string) => Promise<void>
  onCreateTask: () => Promise<void>
  onActivateTask: (taskKey: string, sessionKey: string) => Promise<void>
  onStartSession: () => Promise<void>
  onReloadSession: () => Promise<void>
  onWaitForSessionStart: () => Promise<void>
  onResolveProjectTrust: (
    requestId: string,
    choice: KernelProjectTrustChoice
  ) => Promise<void>
  onActivateSession: (sessionKey: string) => Promise<void>
  onEnsureSessionRuntime: (
    sessionKey: string,
    mode?: 'immediate' | 'settled'
  ) => Promise<void>
  onSelectSession: (sessionKey: string) => Promise<void>
  onClearSessionPreview: () => void
  onClearArchivedSessionPreview: () => void
  onOpenForkDialog: (preferredUserText?: string) => Promise<void>
  onCloseForkDialog: () => void
  onRetryForkCandidates: () => void
  onForkSession: (entryId: string) => Promise<void>
  onExportSession: () => Promise<void>
  onLoadEarlierConversation: () => Promise<void>
  onCopyAnswer: (text: string) => Promise<void>
  onCopyLastAnswer: () => Promise<void>
  onArchiveSession: (sessionKey: string) => Promise<void>
  onReorderProjects: (projectKeys: string[]) => Promise<void>
  onInstallExtension: (kind: KernelExtensionSelectionKind) => Promise<void>
  onRemoveExtension: (path: string) => Promise<void>
  onSearchPiDevExtensions: (query: string) => Promise<KernelPiDevCatalog>
  onSearchPiDevPackages: (query: string) => Promise<KernelPiDevCatalog>
  onListPiPackages: () => Promise<KernelInstalledPackage[]>
  onInstallPiDevPackage: (name: string) => Promise<void>
  onRemovePiPackage: (source: string) => Promise<void>
  onUpdatePiPackage: (source: string) => Promise<void>
  onUpdatePiPackages: () => Promise<void>
  onOpenExternal: (url: string) => Promise<void>
  onListProviders: () => Promise<KernelProviderConfig[]>
  onSaveProvider: (provider: KernelProviderInput) => Promise<KernelProviderConfig[]>
  onRemoveProvider: (providerId: string) => Promise<KernelProviderConfig[]>
  onTestProvider: (providerId: string, modelId: string) => Promise<KernelProviderTestResult>
  onFetchModelPricing: (
    providerId: string,
    modelIds: string[]
  ) => Promise<KernelModelPricingFetchResult>
  onListProviderCredentials: () => Promise<KernelProviderCredential[]>
  onLoginProvider: (
    providerId: string,
    authType: KernelProviderAuthType
  ) => Promise<KernelProviderCredential[]>
  onSubmitProviderAuthPrompt: (
    operationId: string,
    promptId: string,
    value: string
  ) => Promise<void>
  onCancelProviderLogin: (operationId: string) => Promise<void>
  onLogoutProvider: (providerId: string) => Promise<KernelProviderCredential[]>
  onSubscribeProviderAuth: (
    listener: (event: KernelProviderAuthEvent) => void
  ) => () => void
  onGetRemoteAccessStatus: () => Promise<RemoteAccessStatus>
  onCreateRemotePairingCode: () => Promise<RemotePairingCode>
  onRevokeRemoteDevice: () => Promise<RemoteAccessStatus>
  onGetTailscaleStatus: () => Promise<TailscaleRemoteStatus>
  onEnableTailscaleFunnel: () => Promise<TailscaleRemoteStatus>
  onEnableTailscaleServe: () => Promise<TailscaleRemoteStatus>
  onDisableTailscale: () => Promise<TailscaleRemoteStatus>
  onGetDesktopHostStatus: () => Promise<DesktopHostAccessStatus>
  onCreateDesktopHostPairingCode: () => Promise<RemotePairingCode>
  onRevokeDesktopHostDevice: (deviceId: string) => Promise<DesktopHostAccessStatus>
  onSelectPromptAttachments: () => Promise<PromptDraftAttachment[]>
  onSearchProjectPaths: (query: string) => Promise<KernelProjectPathSearchResult>
  onSubmitAsk: (
    sessionKey: string,
    toolCallId: string,
    answers: KernelAskAnswer[]
  ) => Promise<void>
  onCancelAsk: (sessionKey: string, toolCallId: string) => Promise<void>
  onRespondExtensionDialog: (
    request: KernelExtensionDialogRequest,
    value: string
  ) => Promise<void>
  onCancelExtensionDialog: (request: KernelExtensionDialogRequest) => Promise<void>
  onPrompt: (
    message: string,
    attachments?: PromptDraftAttachment[],
    expectedSessionKey?: string
  ) => Promise<void>
  onNavigateHistoryPrompt: (sessionKey: string, messageId: string) => Promise<void>
  onSteer: (message: string, attachments?: PromptDraftAttachment[]) => Promise<void>
  onFollowUp: (message: string, attachments?: PromptDraftAttachment[]) => Promise<void>
  onInvokeCommand: (commandId: string, argument: string) => Promise<void>
  onAbort: () => Promise<void>
  onSetModel: (
    provider: string,
    modelId: string,
    origin: WorkbenchActionOrigin
  ) => Promise<void>
  onSetThinkingLevel: (level: ThinkingLevel) => Promise<void>
  onSetOpenAiFastMode: (enabled: boolean) => Promise<void>
  onSetSessionNaming: (settings: SessionNamingSettings) => Promise<void>
  onSetGeneral: (settings: GeneralSettings) => Promise<void>
  onSetMagicContextEnabled: (enabled: boolean) => Promise<void>
  onGetSubagentTranscript?: (taskId: string, sessionKey: string) => Promise<KernelSubagentTranscript>
  onControlSubagent?: (taskId: string, sessionKey: string, action: 'stop' | 'continue', message?: string) => Promise<void>
  onListSubagentDefinitions: () => Promise<KernelSubagentDefinition[]>
  onSaveSubagentDefinition: (
    definition: KernelSubagentDefinitionInput
  ) => Promise<KernelSubagentDefinition[]>
  onSetSubagentDefinitionEnabled: (
    id: string,
    scope: KernelSubagentEditableScope,
    enabled: boolean
  ) => Promise<KernelSubagentDefinition[]>
  onRemoveSubagentDefinition: (id: string) => Promise<KernelSubagentDefinition[]>
  onSetSubagent: (settings: SubagentSettings) => Promise<void>
  onSetAppearance: (settings: AppearanceSettings) => Promise<void>
  onSetShortcuts: (settings: ShortcutSettings) => Promise<void>
}
