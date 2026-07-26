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
  type KernelArchiveResult,
  type KernelCommand,
  type KernelEvent,
  type KernelInstalledPackage,
  type KernelModelPricingFetchResult,
  type KernelForkCandidate,
  type KernelForkResult,
  type KernelPiDevCatalog,
  type KernelPromptAttachment,
  type KernelProjectPathSearchResult,
  type KernelProviderConfig,
  type KernelProviderCredential,
  type KernelProviderAuthEvent,
  type KernelProviderTestResult,
  type KernelSessionExportResult,
  type KernelSessionPreview,
  type KernelState
} from '../shared/kernel-contract'

const kernelApi: KernelApi = {
  getPathForFile: (file) => webUtils.getPathForFile(file),
  getState: () => {
    const command: KernelCommand = { type: 'kernel.get-state' }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelState>
  },
  listSystemFonts: () => {
    const command: KernelCommand = { type: 'kernel.list-system-fonts' }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<string[]>
  },
  addProject: () => {
    const command: KernelCommand = { type: 'kernel.add-project' }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelState>
  },
  activateProject: (projectKey) => {
    const command: KernelCommand = { type: 'kernel.activate-project', projectKey }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelState>
  },
  startSession: () => {
    const command: KernelCommand = { type: 'kernel.start-session' }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelState>
  },
  reloadSession: () => {
    const command: KernelCommand = { type: 'kernel.reload-session' }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelState>
  },
  resolveProjectTrust: (requestId, choice) => {
    const command: KernelCommand = { type: 'kernel.resolve-project-trust', requestId, choice }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelState>
  },
  activateSession: (sessionKey) => {
    const command: KernelCommand = { type: 'kernel.activate-session', sessionKey }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelState>
  },
  archiveSession: (sessionKey) => {
    const command: KernelCommand = { type: 'kernel.archive-session', sessionKey }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelArchiveResult>
  },
  undoArchiveSession: (token) => {
    const command: KernelCommand = { type: 'kernel.undo-archive-session', token }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelState>
  },
  previewSession: (sessionKey) => {
    const command: KernelCommand = { type: 'kernel.preview-session', sessionKey }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelSessionPreview>
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
  exportSession: () => {
    const command: KernelCommand = { type: 'kernel.export-session' }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelSessionExportResult>
  },
  searchProjectPaths: (query) => {
    const command: KernelCommand = { type: 'kernel.search-project-paths', query }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelProjectPathSearchResult>
  },
  reorderProjects: (projectKeys) => {
    const command: KernelCommand = { type: 'kernel.reorder-projects', projectKeys }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelState>
  },
  installExtension: (kind) => {
    const command: KernelCommand = { type: 'kernel.install-extension', kind }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelState>
  },
  removeExtension: (path) => {
    const command: KernelCommand = { type: 'kernel.remove-extension', path }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelState>
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
  installPiDevPackage: (name) => {
    const command: KernelCommand = { type: 'kernel.install-pi-dev-package', name }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelState>
  },
  removePiPackage: (source) => {
    const command: KernelCommand = { type: 'kernel.remove-pi-package', source }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelState>
  },
  updatePiPackage: (source) => {
    const command: KernelCommand = { type: 'kernel.update-pi-package', source }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelState>
  },
  updatePiPackages: () => {
    const command: KernelCommand = { type: 'kernel.update-pi-packages' }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelState>
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
  prompt: (message, attachments) => {
    const command: KernelCommand = {
      type: 'kernel.prompt',
      message,
      ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {})
    }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelState>
  },
  steer: (message, attachments) => {
    const command: KernelCommand = {
      type: 'kernel.steer',
      message,
      ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {})
    }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelState>
  },
  followUp: (message, attachments) => {
    const command: KernelCommand = {
      type: 'kernel.follow-up',
      message,
      ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {})
    }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelState>
  },
  abort: () => {
    const command: KernelCommand = { type: 'kernel.abort' }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelState>
  },
  setModel: (provider, modelId) => {
    const command: KernelCommand = { type: 'kernel.set-model', provider, modelId }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelState>
  },
  setThinkingLevel: (level) => {
    const command: KernelCommand = { type: 'kernel.set-thinking-level', level }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelState>
  },
  setSessionNaming: (settings) => {
    const command: KernelCommand = { type: 'kernel.set-session-naming', settings }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelState>
  },
  setAppearance: (settings) => {
    const command: KernelCommand = { type: 'kernel.set-appearance', settings }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelState>
  },
  setGeneral: (settings) => {
    const command: KernelCommand = { type: 'kernel.set-general', settings }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelState>
  },
  setShortcuts: (settings) => {
    const command: KernelCommand = { type: 'kernel.set-shortcuts', settings }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelState>
  },
  invokeCommand: (commandId, argument) => {
    const command: KernelCommand = { type: 'kernel.invoke-command', commandId, argument }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelState>
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
