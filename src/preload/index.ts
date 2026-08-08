import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'

import {
  KERNEL_COMMAND_CHANNEL,
  KERNEL_EVENT_CHANNEL,
  OPEN_EXTERNAL_CHANNEL,
  PROVIDER_AUTH_EVENT_CHANNEL,
  WINDOW_FULLSCREEN_CHANGED_CHANNEL,
  WINDOW_IS_FULLSCREEN_CHANNEL,
  WINDOW_IS_MAXIMIZED_CHANNEL,
  WINDOW_MAXIMIZED_CHANGED_CHANNEL,
  WINDOW_TOGGLE_FULLSCREEN_CHANNEL,
  WINDOW_TOGGLE_MAXIMIZE_CHANNEL,
  type KernelApi,
  type KernelAdvisorConfiguration,
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
  type KernelSubagentDefinition
} from '../shared/kernel-contract'
import {
  GIT_COMMAND_CHANNEL,
  type GitApi,
  type GitCommand,
  type GitDiffResponse,
  type GitMutationResponse,
  type GitRefreshResponse
} from '../shared/git-contract'

const gitApi: GitApi = {
  refresh: (projectKey) => {
    const command: GitCommand = { type: 'git.refresh', projectKey }
    return ipcRenderer.invoke(GIT_COMMAND_CHANNEL, command) as Promise<GitRefreshResponse>
  },
  authorizeAncestorRepository: (projectKey, repositoryRoot, expectedStatusRevision) => {
    const command: GitCommand = {
      type: 'git.authorize-ancestor-repository',
      projectKey,
      repositoryRoot,
      expectedStatusRevision
    }
    return ipcRenderer.invoke(GIT_COMMAND_CHANNEL, command) as Promise<GitRefreshResponse>
  },
  getDiff: (projectKey, request) => {
    const command: GitCommand = { type: 'git.get-diff', projectKey, request }
    return ipcRenderer.invoke(GIT_COMMAND_CHANNEL, command) as Promise<GitDiffResponse>
  },
  stageFile: (projectKey, request) => {
    const command: GitCommand = {
      type: 'git.mutate-file',
      projectKey,
      request: { ...request, action: 'stage' }
    }
    return ipcRenderer.invoke(GIT_COMMAND_CHANNEL, command) as Promise<GitMutationResponse>
  },
  unstageFile: (projectKey, request) => {
    const command: GitCommand = {
      type: 'git.mutate-file',
      projectKey,
      request: { ...request, action: 'unstage' }
    }
    return ipcRenderer.invoke(GIT_COMMAND_CHANNEL, command) as Promise<GitMutationResponse>
  }
}

const kernelApi: KernelApi = {
  getPathForFile: (file) => webUtils.getPathForFile(file),
  getState: () => {
    const command: KernelCommand = { type: 'kernel.get-state' }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelSnapshot>
  },
  getRuntimeMemoryDiagnostics: () => {
    const command: KernelCommand = { type: 'kernel.get-runtime-memory-diagnostics' }

    return ipcRenderer.invoke(
      KERNEL_COMMAND_CHANNEL,
      command
    ) as Promise<KernelRuntimeMemoryDiagnostics>
  },
  listSystemFonts: () => {
    const command: KernelCommand = { type: 'kernel.list-system-fonts' }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<string[]>
  },
  addProject: () => {
    const command: KernelCommand = { type: 'kernel.add-project' }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelMutationAck>
  },
  activateProject: (projectKey) => {
    const command: KernelCommand = { type: 'kernel.activate-project', projectKey }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelMutationAck>
  },
  refreshWorkspaceMetadata: (workspaceKey) => {
    const command: KernelCommand = { type: 'kernel.refresh-workspace-metadata', workspaceKey }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelMutationAck>
  },
  selectNavigator: (kind: KernelNavigatorKind) => {
    const command: KernelCommand = { type: 'kernel.select-navigator', kind }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelMutationAck>
  },
  createTask: () => {
    const command: KernelCommand = { type: 'kernel.create-task' }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelMutationAck>
  },
  activateTask: (taskKey) => {
    const command: KernelCommand = { type: 'kernel.activate-task', taskKey }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelMutationAck>
  },
  startSession: () => {
    const command: KernelCommand = { type: 'kernel.start-session' }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelMutationAck>
  },
  reloadSession: () => {
    const command: KernelCommand = { type: 'kernel.reload-session' }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelMutationAck>
  },
  resolveProjectTrust: (requestId, choice) => {
    const command: KernelCommand = { type: 'kernel.resolve-project-trust', requestId, choice }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelMutationAck>
  },
  activateSession: (sessionKey) => {
    const command: KernelCommand = { type: 'kernel.activate-session', sessionKey }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelMutationAck>
  },
  loadEarlierConversation: (request: KernelConversationPageRequest) => {
    const command: KernelCommand = { type: 'kernel.load-earlier-conversation', request }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelConversationPage>
  },
  getLastAssistantFinalAnswer: () => {
    const command: KernelCommand = { type: 'kernel.get-last-assistant-final-answer' }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelAssistantFinalAnswer>
  },
  archiveSession: (sessionKey) => {
    const command: KernelCommand = { type: 'kernel.archive-session', sessionKey }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelArchiveResult>
  },
  undoArchiveSession: (token) => {
    const command: KernelCommand = { type: 'kernel.undo-archive-session', token }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelMutationAck>
  },
  previewSession: (sessionKey, requestId) => {
    const command: KernelCommand = { type: 'kernel.preview-session', sessionKey, requestId }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelSessionPreview>
  },
  completeSessionPreview: (requestId) => {
    const command: KernelCommand = { type: 'kernel.complete-session-preview', requestId }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelSessionPreview>
  },
  cancelSessionPreview: (requestId) => {
    const command: KernelCommand = { type: 'kernel.cancel-session-preview', requestId }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<void>
  },
  previewArchivedSession: (token) => {
    const command: KernelCommand = { type: 'kernel.preview-archived-session', token }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelSessionPreview>
  },
  listForkCandidates: () => {
    const command: KernelCommand = { type: 'kernel.list-fork-candidates' }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelForkCandidate[]>
  },
  forkSession: (entryId) => {
    const command: KernelCommand = { type: 'kernel.fork-session', entryId }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelForkResult>
  },
  navigateHistoryPrompt: (sessionKey, messageId) => {
    const command: KernelCommand = {
      type: 'kernel.navigate-history-prompt',
      sessionKey,
      messageId
    }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelMutationAck>
  },
  exportSession: () => {
    const command: KernelCommand = { type: 'kernel.export-session' }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelSessionExportResult>
  },
  getMessageImage: (sessionKey, messageId, attachmentIndex) => {
    const command: KernelCommand = {
      type: 'kernel.get-message-image',
      sessionKey,
      messageId,
      attachmentIndex
    }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelMessageImage>
  },
  getToolImage: (sessionKey, toolCallId, contentIndex) => {
    const command: KernelCommand = {
      type: 'kernel.get-tool-image',
      sessionKey,
      toolCallId,
      contentIndex
    }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelMessageImage>
  },
  searchProjectPaths: (query) => {
    const command: KernelCommand = { type: 'kernel.search-project-paths', query }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelProjectPathSearchResult>
  },
  reorderProjects: (projectKeys) => {
    const command: KernelCommand = { type: 'kernel.reorder-projects', projectKeys }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelMutationAck>
  },
  installExtension: (kind) => {
    const command: KernelCommand = { type: 'kernel.install-extension', kind }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelMutationAck>
  },
  removeExtension: (path) => {
    const command: KernelCommand = { type: 'kernel.remove-extension', path }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelMutationAck>
  },
  searchPiDevExtensions: (query) => {
    const command: KernelCommand = { type: 'kernel.search-pi-dev-extensions', query }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelPiDevCatalog>
  },
  searchPiDevPackages: (query) => {
    const command: KernelCommand = { type: 'kernel.search-pi-dev-packages', query }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelPiDevCatalog>
  },
  listPiPackages: () => {
    const command: KernelCommand = { type: 'kernel.list-pi-packages' }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelInstalledPackage[]>
  },
  listPiPackageInstallJobs: () => {
    const command: KernelCommand = { type: 'kernel.list-pi-package-install-jobs' }

    return ipcRenderer.invoke(
      KERNEL_COMMAND_CHANNEL,
      command
    ) as Promise<KernelPiPackageInstallJob[]>
  },
  installPiDevPackage: (name) => {
    const command: KernelCommand = { type: 'kernel.install-pi-dev-package', name }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelMutationAck>
  },
  removePiPackage: (source) => {
    const command: KernelCommand = { type: 'kernel.remove-pi-package', source }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelMutationAck>
  },
  setSubagentEnabled: (enabled) => {
    const command: KernelCommand = {
      type: 'kernel.set-subagent-enabled',
      enabled
    }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelInstalledPackage[]>
  },
  setMagicContextEnabled: (enabled) => {
    const command: KernelCommand = {
      type: 'kernel.set-magic-context-enabled',
      enabled
    }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelInstalledPackage[]>
  },
  setAdvisorSystemEnabled: (enabled) => {
    const command: KernelCommand = {
      type: 'kernel.set-advisor-system-enabled',
      enabled
    }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelMutationAck>
  },
  setAdvisorExtensionEnabled: (enabled) => {
    const command: KernelCommand = {
      type: 'kernel.set-advisor-extension-enabled',
      enabled
    }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelInstalledPackage[]>
  },
  listAdvisorDefinitions: () => {
    const command: KernelCommand = { type: 'kernel.list-advisor-definitions' }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelAdvisorConfiguration>
  },
  saveAdvisorDefinition: (definition) => {
    const command: KernelCommand = { type: 'kernel.save-advisor-definition', definition }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelAdvisorConfiguration>
  },
  removeAdvisorDefinition: (slug, scope) => {
    const command: KernelCommand = { type: 'kernel.remove-advisor-definition', slug, scope }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelAdvisorConfiguration>
  },
  listSubagentDefinitions: () => {
    const command: KernelCommand = { type: 'kernel.list-subagent-definitions' }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelSubagentDefinition[]>
  },
  saveSubagentDefinition: (definition) => {
    const command: KernelCommand = { type: 'kernel.save-subagent-definition', definition }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelSubagentDefinition[]>
  },
  setSubagentDefinitionEnabled: (id, scope, enabled) => {
    const command: KernelCommand = {
      type: 'kernel.set-subagent-definition-enabled',
      id,
      scope,
      enabled
    }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelSubagentDefinition[]>
  },
  removeSubagentDefinition: (id) => {
    const command: KernelCommand = { type: 'kernel.remove-subagent-definition', id }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelSubagentDefinition[]>
  },
  updatePiPackage: (source) => {
    const command: KernelCommand = { type: 'kernel.update-pi-package', source }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelMutationAck>
  },
  updatePiPackages: () => {
    const command: KernelCommand = { type: 'kernel.update-pi-packages' }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelMutationAck>
  },
  listProviders: () => {
    const command: KernelCommand = { type: 'kernel.list-providers' }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelProviderConfig[]>
  },
  saveProvider: (provider) => {
    const command: KernelCommand = { type: 'kernel.save-provider', provider }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelProviderConfig[]>
  },
  removeProvider: (providerId) => {
    const command: KernelCommand = { type: 'kernel.remove-provider', providerId }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelProviderConfig[]>
  },
  testProvider: (providerId, modelId) => {
    const command: KernelCommand = { type: 'kernel.test-provider', providerId, modelId }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelProviderTestResult>
  },
  fetchModelPricing: (providerId, modelIds) => {
    const command: KernelCommand = { type: 'kernel.fetch-model-pricing', providerId, modelIds }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelModelPricingFetchResult>
  },
  listProviderCredentials: () => {
    const command: KernelCommand = { type: 'kernel.list-provider-credentials' }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelProviderCredential[]>
  },
  loginProvider: (providerId, authType) => {
    const command: KernelCommand = { type: 'kernel.login-provider', providerId, authType }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelProviderCredential[]>
  },
  submitProviderAuthPrompt: (operationId, promptId, value) => {
    const command: KernelCommand = {
      type: 'kernel.submit-provider-auth-prompt',
      operationId,
      promptId,
      value
    }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<void>
  },
  cancelProviderLogin: (operationId) => {
    const command: KernelCommand = { type: 'kernel.cancel-provider-login', operationId }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<void>
  },
  logoutProvider: (providerId) => {
    const command: KernelCommand = { type: 'kernel.logout-provider', providerId }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelProviderCredential[]>
  },
  selectPromptAttachments: () => {
    const command: KernelCommand = { type: 'kernel.select-prompt-attachments' }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelPromptAttachment[]>
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

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelMutationAck>
  },
  cancelAsk: (sessionKey, toolCallId) => {
    const command: KernelCommand = { type: 'kernel.cancel-ask', sessionKey, toolCallId }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelMutationAck>
  },
  prompt: (message, attachments, expectedSessionKey) => {
    const command: KernelCommand = {
      type: 'kernel.prompt',
      message,
      ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
      ...(expectedSessionKey === undefined ? {} : { expectedSessionKey })
    }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelMutationAck>
  },
  steer: (message, attachments) => {
    const command: KernelCommand = {
      type: 'kernel.steer',
      message,
      ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {})
    }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelMutationAck>
  },
  followUp: (message, attachments) => {
    const command: KernelCommand = {
      type: 'kernel.follow-up',
      message,
      ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {})
    }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelMutationAck>
  },
  abort: () => {
    const command: KernelCommand = { type: 'kernel.abort' }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelMutationAck>
  },
  setModel: (provider, modelId) => {
    const command: KernelCommand = { type: 'kernel.set-model', provider, modelId }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelMutationAck>
  },
  setThinkingLevel: (level) => {
    const command: KernelCommand = { type: 'kernel.set-thinking-level', level }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelMutationAck>
  },
  setOpenAiFastMode: (enabled) => {
    const command: KernelCommand = { type: 'kernel.set-openai-fast-mode', enabled }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelMutationAck>
  },
  setSessionNaming: (settings) => {
    const command: KernelCommand = { type: 'kernel.set-session-naming', settings }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelMutationAck>
  },
  setAppearance: (settings) => {
    const command: KernelCommand = { type: 'kernel.set-appearance', settings }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelMutationAck>
  },
  setGeneral: (settings) => {
    const command: KernelCommand = { type: 'kernel.set-general', settings }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelMutationAck>
  },
  setSubagent: (settings) => {
    const command: KernelCommand = { type: 'kernel.set-subagent', settings }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelMutationAck>
  },
  setShortcuts: (settings) => {
    const command: KernelCommand = { type: 'kernel.set-shortcuts', settings }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelMutationAck>
  },
  invokeCommand: (commandId, argument) => {
    const command: KernelCommand = { type: 'kernel.invoke-command', commandId, argument }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelMutationAck>
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
