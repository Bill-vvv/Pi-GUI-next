import { createDesktopConnectionObservation } from './desktop-connection-observation'
import { DESKTOP_ATTACHMENT_CHANNEL } from '../shared/desktop-attachment-contract'
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { createKernelCommandBridge } from './kernel-command-bridge.ts'
import type { ProjectDirectoryListing } from '../shared/project-directory-contract.ts'

import {
  KERNEL_COMMAND_CHANNEL,
  KERNEL_EVENT_CHANNEL,
  OPEN_EXTERNAL_CHANNEL,
  PROVIDER_AUTH_EVENT_CHANNEL,
  WINDOW_FULLSCREEN_CHANGED_CHANNEL,
  WINDOW_IS_FULLSCREEN_CHANNEL,
  WINDOW_IS_MAXIMIZED_CHANNEL,
  WINDOW_MAXIMIZED_CHANGED_CHANNEL,
  WINDOW_SET_CHROME_CHANNEL,
  WINDOW_TOGGLE_FULLSCREEN_CHANNEL,
  WINDOW_TOGGLE_MAXIMIZE_CHANNEL,
  type KernelApi,
  type KernelAskAnswer,
  type KernelArchiveResult,
  type KernelAssistantFinalAnswer,
  type KernelCommand,
  type KernelConversationPage,
  type KernelConversationPageRequest,
  type KernelEvent,
  type KernelInstalledPackage,
  type KernelPiPackageInstallJob,
  type KernelModelPricingFetchResult,
  type KernelForkCandidate,
  type KernelForkResult,
  type KernelPiDevCatalog,
  type KernelMessageImage,
  type KernelMutationAck,
  type KernelNavigatorKind,
  type KernelSnapshot,
  type KernelRuntimeMemoryDiagnostics,
  type KernelPromptAttachment,
  type KernelProjectPathSearchResult,
  type KernelProviderConfig,
  type KernelProviderCredential,
  type KernelProviderAuthEvent,
  type KernelProviderTestResult,
  type KernelSessionExportResult,
  type KernelSessionPreview,
  type KernelSessionPreviewPageRequest,
  type KernelSubagentDefinition
} from '../shared/kernel-contract'
import {
  GIT_COMMAND_CHANNEL,
  type GitApi,
  type GitFileReadResponse,
  type GitBranchSyncExecutionResponse,
  type GitBranchSyncPrepareResponse,
  type GitCommand,
  type GitCommitExecutionResponse,
  type GitCommitPreviewResponse,
  type GitDiffResponse,
  type GitHistoryDetailResponse,
  type GitHistoryFileDiffResponse,
  type GitHistoryListResponse,
  type GitMutationResponse,
  type GitRefreshResponse
} from '../shared/git-contract'
import {
  REMOTE_ADMIN_COMMAND_CHANNEL,
  type DesktopHostAccessStatus,
  type RemoteAccessStatus,
  type RemoteAdminApi,
  type RemoteAdminCommand,
  type RemotePairingCode,
  type TailscaleRemoteStatus
} from '../shared/remote-admin-contract'
import {
  DESKTOP_CLIENT_COMMAND_CHANNEL,
  DESKTOP_CLIENT_STATUS_CHANNEL,
  type DesktopClientApi,
  type DesktopClientCommand,
  type DesktopClientConnectRequest,
  type DesktopClientStatus
} from '../shared/desktop-client-contract'

const remoteAdminApi: RemoteAdminApi = {
  getStatus: () => {
    const command: RemoteAdminCommand = { type: 'remote-admin.get-status' }
    return ipcRenderer.invoke(REMOTE_ADMIN_COMMAND_CHANNEL, command) as Promise<RemoteAccessStatus>
  },
  createPairingCode: () => {
    const command: RemoteAdminCommand = { type: 'remote-admin.create-pairing-code' }
    return ipcRenderer.invoke(REMOTE_ADMIN_COMMAND_CHANNEL, command) as Promise<RemotePairingCode>
  },
  revokeDevice: () => {
    const command: RemoteAdminCommand = { type: 'remote-admin.revoke-device' }
    return ipcRenderer.invoke(REMOTE_ADMIN_COMMAND_CHANNEL, command) as Promise<RemoteAccessStatus>
  },
  getTailscaleStatus: () => {
    const command: RemoteAdminCommand = { type: 'remote-admin.get-tailscale-status' }
    return ipcRenderer.invoke(REMOTE_ADMIN_COMMAND_CHANNEL, command) as Promise<TailscaleRemoteStatus>
  },
  enableTailscaleFunnel: () => {
    const command: RemoteAdminCommand = { type: 'remote-admin.enable-tailscale-funnel' }
    return ipcRenderer.invoke(REMOTE_ADMIN_COMMAND_CHANNEL, command) as Promise<TailscaleRemoteStatus>
  },
  enableTailscaleServe: () => {
    const command: RemoteAdminCommand = { type: 'remote-admin.enable-tailscale-serve' }
    return ipcRenderer.invoke(REMOTE_ADMIN_COMMAND_CHANNEL, command) as Promise<TailscaleRemoteStatus>
  },
  disableTailscale: () => {
    const command: RemoteAdminCommand = { type: 'remote-admin.disable-tailscale' }
    return ipcRenderer.invoke(REMOTE_ADMIN_COMMAND_CHANNEL, command) as Promise<TailscaleRemoteStatus>
  },
  getDesktopHostStatus: () => {
    const command: RemoteAdminCommand = { type: 'remote-admin.get-desktop-host-status' }
    return ipcRenderer.invoke(REMOTE_ADMIN_COMMAND_CHANNEL, command) as Promise<DesktopHostAccessStatus>
  },
  createDesktopHostPairingCode: () => {
    const command: RemoteAdminCommand = { type: 'remote-admin.create-desktop-host-pairing-code' }
    return ipcRenderer.invoke(REMOTE_ADMIN_COMMAND_CHANNEL, command) as Promise<RemotePairingCode>
  },
  revokeDesktopHostDevice: () => {
    const command: RemoteAdminCommand = { type: 'remote-admin.revoke-desktop-host-device' }
    return ipcRenderer.invoke(REMOTE_ADMIN_COMMAND_CHANNEL, command) as Promise<DesktopHostAccessStatus>
  }
}

const gitApi: GitApi = {
  readFile: (projectKey, request) => ipcRenderer.invoke(GIT_COMMAND_CHANNEL,
    { type: 'git.read-file', projectKey, request }, kernelBridge.getControlIdentity(), desktopConnection.connectionId()) as Promise<GitFileReadResponse>,
  refresh: (projectKey) => {
    const command: GitCommand = { type: 'git.refresh', projectKey }
    return ipcRenderer.invoke(GIT_COMMAND_CHANNEL, command, kernelBridge.getControlIdentity(), desktopConnection.connectionId()) as Promise<GitRefreshResponse>
  },
  authorizeAncestorRepository: (projectKey, repositoryRoot, expectedStatusRevision) => {
    const command: GitCommand = {
      type: 'git.authorize-ancestor-repository',
      projectKey,
      repositoryRoot,
      expectedStatusRevision
    }
    return ipcRenderer.invoke(GIT_COMMAND_CHANNEL, command, kernelBridge.getControlIdentity(), desktopConnection.connectionId()) as Promise<GitRefreshResponse>
  },
  getDiff: (projectKey, request) => {
    const command: GitCommand = { type: 'git.get-diff', projectKey, request }
    return ipcRenderer.invoke(GIT_COMMAND_CHANNEL, command, kernelBridge.getControlIdentity(), desktopConnection.connectionId()) as Promise<GitDiffResponse>
  },
  stageFile: (projectKey, request) => {
    const command: GitCommand = {
      type: 'git.mutate-file',
      projectKey,
      request: { ...request, action: 'stage' }
    }
    return ipcRenderer.invoke(GIT_COMMAND_CHANNEL, command, kernelBridge.getControlIdentity(), desktopConnection.connectionId()) as Promise<GitMutationResponse>
  },
  unstageFile: (projectKey, request) => {
    const command: GitCommand = {
      type: 'git.mutate-file',
      projectKey,
      request: { ...request, action: 'unstage' }
    }
    return ipcRenderer.invoke(GIT_COMMAND_CHANNEL, command, kernelBridge.getControlIdentity(), desktopConnection.connectionId()) as Promise<GitMutationResponse>
  },
  prepareCommit: (projectKey) => {
    const command: GitCommand = { type: 'git.prepare-commit', projectKey }
    return ipcRenderer.invoke(GIT_COMMAND_CHANNEL, command, kernelBridge.getControlIdentity(), desktopConnection.connectionId()) as Promise<GitCommitPreviewResponse>
  },
  executeCommit: (projectKey, request) => {
    const command: GitCommand = { type: 'git.execute-commit', projectKey, request }
    return ipcRenderer.invoke(GIT_COMMAND_CHANNEL, command, kernelBridge.getControlIdentity(), desktopConnection.connectionId()) as Promise<GitCommitExecutionResponse>
  },
  listHistory: (projectKey, request) => {
    const command: GitCommand = { type: 'git.list-history', projectKey, request }
    return ipcRenderer.invoke(GIT_COMMAND_CHANNEL, command, kernelBridge.getControlIdentity(), desktopConnection.connectionId()) as Promise<GitHistoryListResponse>
  },
  getHistoryDetail: (projectKey, request) => {
    const command: GitCommand = { type: 'git.get-history-detail', projectKey, request }
    return ipcRenderer.invoke(GIT_COMMAND_CHANNEL, command, kernelBridge.getControlIdentity(), desktopConnection.connectionId()) as Promise<GitHistoryDetailResponse>
  },
  getHistoryFileDiff: (projectKey, request) => {
    const command: GitCommand = { type: 'git.get-history-file-diff', projectKey, request }
    return ipcRenderer.invoke(GIT_COMMAND_CHANNEL, command, kernelBridge.getControlIdentity(), desktopConnection.connectionId()) as Promise<GitHistoryFileDiffResponse>
  },
  prepareBranchSync: (projectKey) => {
    const command: GitCommand = { type: 'git.prepare-branch-sync', projectKey }
    return ipcRenderer.invoke(GIT_COMMAND_CHANNEL, command, kernelBridge.getControlIdentity(), desktopConnection.connectionId()) as Promise<GitBranchSyncPrepareResponse>
  },
  executeBranchSync: (projectKey, request) => {
    const command: GitCommand = { type: 'git.execute-branch-sync', projectKey, request }
    return ipcRenderer.invoke(GIT_COMMAND_CHANNEL, command, kernelBridge.getControlIdentity(), desktopConnection.connectionId()) as Promise<GitBranchSyncExecutionResponse>
  }
}

const desktopConnection = createDesktopConnectionObservation()

const kernelBridge = createKernelCommandBridge((command, identity) =>
  ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command, identity, desktopConnection.connectionId())
)

const desktopClientApi: DesktopClientApi = {
  manageHostProfiles: (command) => ipcRenderer.invoke(DESKTOP_CLIENT_COMMAND_CHANNEL, command),
  checkHost: (operationId, config) => ipcRenderer.invoke(DESKTOP_CLIENT_COMMAND_CHANNEL, { type: 'desktop-client.check-host', operationId, config }),
  cancelHostCheck: (operationId) => ipcRenderer.invoke(DESKTOP_CLIENT_COMMAND_CHANNEL, { type: 'desktop-client.cancel-host-check', operationId }),
  listSshHosts: () => ipcRenderer.invoke(DESKTOP_CLIENT_COMMAND_CHANNEL, { type: 'desktop-client.list-ssh-hosts' }),
  selectAttachments: (operationId) => ipcRenderer.invoke(DESKTOP_ATTACHMENT_CHANNEL,
    { type: 'attachment.select-local', operationId }, kernelBridge.getControlIdentity(), desktopConnection.connectionId()),
  uploadAttachments: (operationId, files) => ipcRenderer.invoke(DESKTOP_ATTACHMENT_CHANNEL,
    { type: 'attachment.upload-data', operationId, files }, kernelBridge.getControlIdentity(), desktopConnection.connectionId()),
  cancelAttachmentUpload: (operationId) => ipcRenderer.invoke(DESKTOP_ATTACHMENT_CHANNEL,
    { type: 'attachment.cancel-local', operationId }, kernelBridge.getControlIdentity(), desktopConnection.connectionId()),
  discardAttachments: (uploadIds) => ipcRenderer.invoke(DESKTOP_ATTACHMENT_CHANNEL,
    { type: 'attachment.discard', uploadIds }, kernelBridge.getControlIdentity(), desktopConnection.connectionId()),
  submitAttachments: (mode, message, uploadIds, expectedSessionKey) => {
    const identity = kernelBridge.getControlIdentity()
    if (expectedSessionKey !== undefined && expectedSessionKey !== identity?.sessionKey) {
      return Promise.reject(new Error('附件目标会话已变化，请重新选择附件。'))
    }
    return ipcRenderer.invoke(DESKTOP_ATTACHMENT_CHANNEL, { type: 'attachment.submit', mode, message, uploadIds }, identity, desktopConnection.connectionId())
  },
  getEnvironment: () => ipcRenderer.invoke(DESKTOP_CLIENT_COMMAND_CHANNEL, { type: 'desktop-client.get-environment' }),
  switchEnvironment: (environment) => ipcRenderer.invoke(DESKTOP_CLIENT_COMMAND_CHANNEL, { type: 'desktop-client.switch-environment', environment }),
  getPreferences: (seed) => ipcRenderer.invoke(DESKTOP_CLIENT_COMMAND_CHANNEL, { type: 'desktop-client.get-preferences', ...(seed === undefined ? {} : { seed }) }),
  setPreferences: (patch) => ipcRenderer.invoke(DESKTOP_CLIENT_COMMAND_CHANNEL, { type: 'desktop-client.set-preferences', patch }),
  setControlIdentity: kernelBridge.setControlIdentity,
  getStatus: () => {
    const command: DesktopClientCommand = { type: 'desktop-client.get-status' }
    return desktopConnection.read(() => ipcRenderer.invoke(DESKTOP_CLIENT_COMMAND_CHANNEL, command) as Promise<DesktopClientStatus>)
  },
  connect: (request: DesktopClientConnectRequest) => {
    const command: DesktopClientCommand = { type: 'desktop-client.connect', ...request }
    return ipcRenderer.invoke(DESKTOP_CLIENT_COMMAND_CHANNEL, command) as Promise<void>
  },
  disconnect: () => {
    const command: DesktopClientCommand = { type: 'desktop-client.disconnect' }
    return ipcRenderer.invoke(DESKTOP_CLIENT_COMMAND_CHANNEL, command) as Promise<void>
  },
  revokePairing: (config) => ipcRenderer.invoke(DESKTOP_CLIENT_COMMAND_CHANNEL, { type: 'desktop-client.revoke-pairing', config }, desktopConnection.connectionId()),
  subscribeStatus: (listener) => {
    const handleStatus = (_event: IpcRendererEvent, status: DesktopClientStatus): void => {
      desktopConnection.apply(status)
      if (status.mode === 'windows-remote' && status.phase !== 'connected') kernelBridge.setControlIdentity(null)
      listener(status)
    }
    ipcRenderer.on(DESKTOP_CLIENT_STATUS_CHANNEL, handleStatus)
    return () => {
      ipcRenderer.removeListener(DESKTOP_CLIENT_STATUS_CHANNEL, handleStatus)
    }
  }
}

const kernelApi: KernelApi = {
  getPathForFile: (file) => webUtils.getPathForFile(file),
  getState: () => {
    const command: KernelCommand = { type: 'kernel.get-state' }

    return kernelBridge.invoke(command) as Promise<KernelSnapshot>
  },
  getRuntimeMemoryDiagnostics: () => {
    const command: KernelCommand = { type: 'kernel.get-runtime-memory-diagnostics' }

    return kernelBridge.invoke(command) as Promise<KernelRuntimeMemoryDiagnostics>
  },
  listSystemFonts: () => {
    const command: KernelCommand = { type: 'kernel.list-system-fonts' }

    return kernelBridge.invoke(command) as Promise<string[]>
  },
  listProjectDirectories: (directoryPath) => kernelBridge.invoke({
    type: 'kernel.list-project-directories', ...(directoryPath === undefined ? {} : { directoryPath })
  }) as Promise<ProjectDirectoryListing>,
  addProject: (projectPath) => {
    const command: KernelCommand = { type: 'kernel.add-project', ...(projectPath === undefined ? {} : { projectPath }) }

    return kernelBridge.invoke(command) as Promise<KernelMutationAck>
  },
  activateProject: (projectKey) => {
    const command: KernelCommand = { type: 'kernel.activate-project', projectKey }

    return kernelBridge.invoke(command) as Promise<KernelMutationAck>
  },
  refreshWorkspaceMetadata: (workspaceKey) => {
    const command: KernelCommand = { type: 'kernel.refresh-workspace-metadata', workspaceKey }

    return kernelBridge.invoke(command) as Promise<KernelMutationAck>
  },
  selectNavigator: (kind: KernelNavigatorKind) => {
    const command: KernelCommand = { type: 'kernel.select-navigator', kind }

    return kernelBridge.invoke(command) as Promise<KernelMutationAck>
  },
  createTask: () => {
    const command: KernelCommand = { type: 'kernel.create-task' }

    return kernelBridge.invoke(command) as Promise<KernelMutationAck>
  },
  activateTask: (taskKey) => {
    const command: KernelCommand = { type: 'kernel.activate-task', taskKey }

    return kernelBridge.invoke(command) as Promise<KernelMutationAck>
  },
  startSession: () => {
    const command: KernelCommand = { type: 'kernel.start-session' }

    return kernelBridge.invoke(command) as Promise<KernelMutationAck>
  },
  reloadSession: () => {
    const command: KernelCommand = { type: 'kernel.reload-session' }

    return kernelBridge.invoke(command) as Promise<KernelMutationAck>
  },
  resolveProjectTrust: (requestId, choice) => {
    const command: KernelCommand = { type: 'kernel.resolve-project-trust', requestId, choice }

    return kernelBridge.invoke(command) as Promise<KernelMutationAck>
  },
  activateSession: (sessionKey) => {
    const command: KernelCommand = { type: 'kernel.activate-session', sessionKey }

    return kernelBridge.invoke(command) as Promise<KernelMutationAck>
  },
  loadEarlierConversation: (request: KernelConversationPageRequest) => {
    const command: KernelCommand = { type: 'kernel.load-earlier-conversation', request }

    return kernelBridge.invoke(command) as Promise<KernelConversationPage>
  },
  getLastAssistantFinalAnswer: () => {
    const command: KernelCommand = { type: 'kernel.get-last-assistant-final-answer' }

    return kernelBridge.invoke(command) as Promise<KernelAssistantFinalAnswer>
  },
  archiveSession: (sessionKey) => {
    const command: KernelCommand = { type: 'kernel.archive-session', sessionKey }

    return kernelBridge.invoke(command) as Promise<KernelArchiveResult>
  },
  undoArchiveSession: (token) => {
    const command: KernelCommand = { type: 'kernel.undo-archive-session', token }

    return kernelBridge.invoke(command) as Promise<KernelMutationAck>
  },
  previewSession: (sessionKey, requestId) => {
    const command: KernelCommand = { type: 'kernel.preview-session', sessionKey, requestId }

    return kernelBridge.invoke(command) as Promise<KernelSessionPreview>
  },
  completeSessionPreview: (requestId) => {
    const command: KernelCommand = { type: 'kernel.complete-session-preview', requestId }

    return kernelBridge.invoke(command) as Promise<KernelSessionPreview>
  },
  cancelSessionPreview: (requestId) => {
    const command: KernelCommand = { type: 'kernel.cancel-session-preview', requestId }

    return kernelBridge.invoke(command) as Promise<void>
  },
  loadEarlierSessionPreview: (request: KernelSessionPreviewPageRequest) => {
    const command: KernelCommand = { type: 'kernel.load-earlier-session-preview', request }

    return kernelBridge.invoke(command) as Promise<KernelConversationPage>
  },
  previewArchivedSession: (token) => {
    const command: KernelCommand = { type: 'kernel.preview-archived-session', token }

    return kernelBridge.invoke(command) as Promise<KernelSessionPreview>
  },
  listForkCandidates: () => {
    const command: KernelCommand = { type: 'kernel.list-fork-candidates' }

    return kernelBridge.invoke(command) as Promise<KernelForkCandidate[]>
  },
  forkSession: (entryId) => {
    const command: KernelCommand = { type: 'kernel.fork-session', entryId }

    return kernelBridge.invoke(command) as Promise<KernelForkResult>
  },
  navigateHistoryPrompt: (sessionKey, messageId) => {
    const command: KernelCommand = {
      type: 'kernel.navigate-history-prompt',
      sessionKey,
      messageId
    }

    return kernelBridge.invoke(command) as Promise<KernelMutationAck>
  },
  exportSession: () => {
    const command: KernelCommand = { type: 'kernel.export-session' }

    return kernelBridge.invoke(command) as Promise<KernelSessionExportResult>
  },
  getMessageImage: (sessionKey, messageId, attachmentIndex) => {
    const command: KernelCommand = {
      type: 'kernel.get-message-image',
      sessionKey,
      messageId,
      attachmentIndex
    }

    return kernelBridge.invoke(command) as Promise<KernelMessageImage>
  },
  getToolImage: (sessionKey, toolCallId, contentIndex) => {
    const command: KernelCommand = {
      type: 'kernel.get-tool-image',
      sessionKey,
      toolCallId,
      contentIndex
    }

    return kernelBridge.invoke(command) as Promise<KernelMessageImage>
  },
  searchProjectPaths: (query) => {
    const command: KernelCommand = { type: 'kernel.search-project-paths', query }

    return kernelBridge.invoke(command) as Promise<KernelProjectPathSearchResult>
  },
  reorderProjects: (projectKeys) => {
    const command: KernelCommand = { type: 'kernel.reorder-projects', projectKeys }

    return kernelBridge.invoke(command) as Promise<KernelMutationAck>
  },
  installExtension: (kind) => {
    const command: KernelCommand = { type: 'kernel.install-extension', kind }

    return kernelBridge.invoke(command) as Promise<KernelMutationAck>
  },
  removeExtension: (path) => {
    const command: KernelCommand = { type: 'kernel.remove-extension', path }

    return kernelBridge.invoke(command) as Promise<KernelMutationAck>
  },
  searchPiDevExtensions: (query) => {
    const command: KernelCommand = { type: 'kernel.search-pi-dev-extensions', query }

    return kernelBridge.invoke(command) as Promise<KernelPiDevCatalog>
  },
  searchPiDevPackages: (query) => {
    const command: KernelCommand = { type: 'kernel.search-pi-dev-packages', query }

    return kernelBridge.invoke(command) as Promise<KernelPiDevCatalog>
  },
  listPiPackages: () => {
    const command: KernelCommand = { type: 'kernel.list-pi-packages' }

    return kernelBridge.invoke(command) as Promise<KernelInstalledPackage[]>
  },
  listPiPackageInstallJobs: () => {
    const command: KernelCommand = { type: 'kernel.list-pi-package-install-jobs' }

    return kernelBridge.invoke(command) as Promise<KernelPiPackageInstallJob[]>
  },
  installPiDevPackage: (name) => {
    const command: KernelCommand = { type: 'kernel.install-pi-dev-package', name }

    return kernelBridge.invoke(command) as Promise<KernelMutationAck>
  },
  removePiPackage: (source) => {
    const command: KernelCommand = { type: 'kernel.remove-pi-package', source }

    return kernelBridge.invoke(command) as Promise<KernelMutationAck>
  },
  setSubagentEnabled: (enabled) => {
    const command: KernelCommand = {
      type: 'kernel.set-subagent-enabled',
      enabled
    }

    return kernelBridge.invoke(command) as Promise<KernelInstalledPackage[]>
  },
  setMagicContextEnabled: (enabled) => {
    const command: KernelCommand = {
      type: 'kernel.set-magic-context-enabled',
      enabled
    }

    return kernelBridge.invoke(command) as Promise<KernelInstalledPackage[]>
  },
  listSubagentDefinitions: () => {
    const command: KernelCommand = { type: 'kernel.list-subagent-definitions' }

    return kernelBridge.invoke(command) as Promise<KernelSubagentDefinition[]>
  },
  saveSubagentDefinition: (definition) => {
    const command: KernelCommand = { type: 'kernel.save-subagent-definition', definition }

    return kernelBridge.invoke(command) as Promise<KernelSubagentDefinition[]>
  },
  setSubagentDefinitionEnabled: (id, scope, enabled) => {
    const command: KernelCommand = {
      type: 'kernel.set-subagent-definition-enabled',
      id,
      scope,
      enabled
    }

    return kernelBridge.invoke(command) as Promise<KernelSubagentDefinition[]>
  },
  removeSubagentDefinition: (id) => {
    const command: KernelCommand = { type: 'kernel.remove-subagent-definition', id }

    return kernelBridge.invoke(command) as Promise<KernelSubagentDefinition[]>
  },
  updatePiPackage: (source) => {
    const command: KernelCommand = { type: 'kernel.update-pi-package', source }

    return kernelBridge.invoke(command) as Promise<KernelMutationAck>
  },
  updatePiPackages: () => {
    const command: KernelCommand = { type: 'kernel.update-pi-packages' }

    return kernelBridge.invoke(command) as Promise<KernelMutationAck>
  },
  listProviders: () => {
    const command: KernelCommand = { type: 'kernel.list-providers' }

    return kernelBridge.invoke(command) as Promise<KernelProviderConfig[]>
  },
  saveProvider: (provider) => {
    const command: KernelCommand = { type: 'kernel.save-provider', provider }

    return kernelBridge.invoke(command) as Promise<KernelProviderConfig[]>
  },
  removeProvider: (providerId) => {
    const command: KernelCommand = { type: 'kernel.remove-provider', providerId }

    return kernelBridge.invoke(command) as Promise<KernelProviderConfig[]>
  },
  testProvider: (providerId, modelId) => {
    const command: KernelCommand = { type: 'kernel.test-provider', providerId, modelId }

    return kernelBridge.invoke(command) as Promise<KernelProviderTestResult>
  },
  fetchModelPricing: (providerId, modelIds) => {
    const command: KernelCommand = { type: 'kernel.fetch-model-pricing', providerId, modelIds }

    return kernelBridge.invoke(command) as Promise<KernelModelPricingFetchResult>
  },
  listProviderCredentials: () => {
    const command: KernelCommand = { type: 'kernel.list-provider-credentials' }

    return kernelBridge.invoke(command) as Promise<KernelProviderCredential[]>
  },
  loginProvider: (providerId, authType) => {
    const command: KernelCommand = { type: 'kernel.login-provider', providerId, authType }

    return kernelBridge.invoke(command) as Promise<KernelProviderCredential[]>
  },
  submitProviderAuthPrompt: (operationId, promptId, value) => {
    const command: KernelCommand = {
      type: 'kernel.submit-provider-auth-prompt',
      operationId,
      promptId,
      value
    }

    return kernelBridge.invoke(command) as Promise<void>
  },
  cancelProviderLogin: (operationId) => {
    const command: KernelCommand = { type: 'kernel.cancel-provider-login', operationId }

    return kernelBridge.invoke(command) as Promise<void>
  },
  logoutProvider: (providerId) => {
    const command: KernelCommand = { type: 'kernel.logout-provider', providerId }

    return kernelBridge.invoke(command) as Promise<KernelProviderCredential[]>
  },
  selectPromptAttachments: () => {
    const command: KernelCommand = { type: 'kernel.select-prompt-attachments' }

    return kernelBridge.invoke(command) as Promise<KernelPromptAttachment[]>
  },
  submitAsk: (sessionKey, toolCallId, answers) => {
    const command: KernelCommand = {
      type: 'kernel.submit-ask',
      sessionKey,
      toolCallId,
      answers: answers.map((answer: KernelAskAnswer) => ({
        questionId: answer.questionId,
        value: Array.isArray(answer.value) ? [...answer.value] : answer.value,
        ...(answer.customValue === undefined ? {} : { customValue: answer.customValue })
      }))
    }

    return kernelBridge.invoke(command) as Promise<KernelMutationAck>
  },
  cancelAsk: (sessionKey, toolCallId) => {
    const command: KernelCommand = { type: 'kernel.cancel-ask', sessionKey, toolCallId }

    return kernelBridge.invoke(command) as Promise<KernelMutationAck>
  },
  respondExtensionDialog: (
    projectKey,
    sessionKey,
    sessionId,
    requestId,
    commandInvocationId,
    value
  ) => {
    const command: KernelCommand = {
      type: 'kernel.respond-extension-dialog',
      projectKey,
      sessionKey,
      sessionId,
      requestId,
      commandInvocationId,
      value
    }

    return kernelBridge.invoke(command) as Promise<KernelMutationAck>
  },
  cancelExtensionDialog: (
    projectKey,
    sessionKey,
    sessionId,
    requestId,
    commandInvocationId
  ) => {
    const command: KernelCommand = {
      type: 'kernel.cancel-extension-dialog',
      projectKey,
      sessionKey,
      sessionId,
      requestId,
      commandInvocationId
    }

    return kernelBridge.invoke(command) as Promise<KernelMutationAck>
  },
  prompt: (message, attachments, expectedSessionKey) => {
    const command: KernelCommand = {
      type: 'kernel.prompt',
      message,
      ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
      ...(expectedSessionKey === undefined ? {} : { expectedSessionKey })
    }

    return kernelBridge.invoke(command) as Promise<KernelMutationAck>
  },
  steer: (message, attachments) => {
    const command: KernelCommand = {
      type: 'kernel.steer',
      message,
      ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {})
    }

    return kernelBridge.invoke(command) as Promise<KernelMutationAck>
  },
  followUp: (message, attachments) => {
    const command: KernelCommand = {
      type: 'kernel.follow-up',
      message,
      ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {})
    }

    return kernelBridge.invoke(command) as Promise<KernelMutationAck>
  },
  abort: () => {
    const command: KernelCommand = { type: 'kernel.abort' }

    return kernelBridge.invoke(command) as Promise<KernelMutationAck>
  },
  setModel: (provider, modelId) => {
    const command: KernelCommand = { type: 'kernel.set-model', provider, modelId }

    return kernelBridge.invoke(command) as Promise<KernelMutationAck>
  },
  setThinkingLevel: (level) => {
    const command: KernelCommand = { type: 'kernel.set-thinking-level', level }

    return kernelBridge.invoke(command) as Promise<KernelMutationAck>
  },
  setOpenAiFastMode: (enabled) => {
    const command: KernelCommand = { type: 'kernel.set-openai-fast-mode', enabled }

    return kernelBridge.invoke(command) as Promise<KernelMutationAck>
  },
  setSessionNaming: (settings) => {
    const command: KernelCommand = { type: 'kernel.set-session-naming', settings }

    return kernelBridge.invoke(command) as Promise<KernelMutationAck>
  },
  setAppearance: (settings) => {
    const command: KernelCommand = { type: 'kernel.set-appearance', settings }

    return kernelBridge.invoke(command) as Promise<KernelMutationAck>
  },
  setGeneral: (settings) => {
    const command: KernelCommand = { type: 'kernel.set-general', settings }

    return kernelBridge.invoke(command) as Promise<KernelMutationAck>
  },
  setSubagent: (settings) => {
    const command: KernelCommand = { type: 'kernel.set-subagent', settings }

    return kernelBridge.invoke(command) as Promise<KernelMutationAck>
  },
  setShortcuts: (settings) => {
    const command: KernelCommand = { type: 'kernel.set-shortcuts', settings }

    return kernelBridge.invoke(command) as Promise<KernelMutationAck>
  },
  invokeCommand: (commandId, argument) => {
    const command: KernelCommand = { type: 'kernel.invoke-command', commandId, argument }

    return kernelBridge.invoke(command) as Promise<KernelMutationAck>
  },
  openExternal: (url) => ipcRenderer.invoke(OPEN_EXTERNAL_CHANNEL, url) as Promise<void>,
  toggleFullscreen: () => ipcRenderer.invoke(WINDOW_TOGGLE_FULLSCREEN_CHANNEL) as Promise<boolean>,
  isFullscreen: () => ipcRenderer.invoke(WINDOW_IS_FULLSCREEN_CHANNEL) as Promise<boolean>,
  subscribeFullscreen: (listener) => {
    const handleFullscreenChange = (_event: IpcRendererEvent, fullscreen: boolean): void => {
      listener(fullscreen)
    }

    ipcRenderer.on(WINDOW_FULLSCREEN_CHANGED_CHANNEL, handleFullscreenChange)

    return () => {
      ipcRenderer.removeListener(WINDOW_FULLSCREEN_CHANGED_CHANNEL, handleFullscreenChange)
    }
  },
  toggleMaximize: () => ipcRenderer.invoke(WINDOW_TOGGLE_MAXIMIZE_CHANNEL) as Promise<boolean>,
  isMaximized: () => ipcRenderer.invoke(WINDOW_IS_MAXIMIZED_CHANNEL) as Promise<boolean>,
  setWindowChrome: (chrome) => ipcRenderer.invoke(WINDOW_SET_CHROME_CHANNEL, chrome) as Promise<void>,
  subscribeMaximized: (listener) => {
    const handleMaximizedChange = (_event: IpcRendererEvent, maximized: boolean): void => {
      listener(maximized)
    }

    ipcRenderer.on(WINDOW_MAXIMIZED_CHANGED_CHANNEL, handleMaximizedChange)

    return () => {
      ipcRenderer.removeListener(WINDOW_MAXIMIZED_CHANGED_CHANNEL, handleMaximizedChange)
    }
  },
  subscribeProviderAuth: (listener) => {
    const handleProviderAuthEvent = (
      _event: IpcRendererEvent,
      event: KernelProviderAuthEvent
    ): void => {
      listener(event)
    }

    ipcRenderer.on(PROVIDER_AUTH_EVENT_CHANNEL, handleProviderAuthEvent)

    return () => {
      ipcRenderer.removeListener(PROVIDER_AUTH_EVENT_CHANNEL, handleProviderAuthEvent)
    }
  },
  subscribe: (listener) => {
    const handleKernelEvent = (_event: IpcRendererEvent, event: KernelEvent): void => {
      listener(event)
    }

    ipcRenderer.on(KERNEL_EVENT_CHANNEL, handleKernelEvent)

    return () => {
      ipcRenderer.removeListener(KERNEL_EVENT_CHANNEL, handleKernelEvent)
    }
  }
}

contextBridge.exposeInMainWorld('piGui', kernelApi)
contextBridge.exposeInMainWorld('piGit', gitApi)
contextBridge.exposeInMainWorld('piRemote', remoteAdminApi)
contextBridge.exposeInMainWorld('piDesktopClient', desktopClientApi)
