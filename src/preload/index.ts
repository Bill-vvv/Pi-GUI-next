import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

import {
  KERNEL_COMMAND_CHANNEL,
  KERNEL_EVENT_CHANNEL,
  OPEN_EXTERNAL_CHANNEL,
  type KernelApi,
  type KernelCommand,
  type KernelEvent,
  type KernelInstalledPackage,
  type KernelPiDevCatalog,
  type KernelPromptAttachment,
  type KernelProviderConfig,
  type KernelProviderTestResult,
  type KernelSessionPreview,
  type KernelState
} from '../shared/kernel-contract'

const kernelApi: KernelApi = {
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
  activateSession: (sessionKey) => {
    const command: KernelCommand = { type: 'kernel.activate-session', sessionKey }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelState>
  },
  archiveSession: (sessionKey) => {
    const command: KernelCommand = { type: 'kernel.archive-session', sessionKey }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelState>
  },
  previewSession: (sessionKey) => {
    const command: KernelCommand = { type: 'kernel.preview-session', sessionKey }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelSessionPreview>
  },
  reorderProjects: (projectKeys) => {
    const command: KernelCommand = { type: 'kernel.reorder-projects', projectKeys }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelState>
  },
  reorderSessions: (sessionKeys) => {
    const command: KernelCommand = { type: 'kernel.reorder-sessions', sessionKeys }

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
  invokeCommand: (commandId, argument) => {
    const command: KernelCommand = { type: 'kernel.invoke-command', commandId, argument }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelState>
  },
  openExternal: (url) => ipcRenderer.invoke(OPEN_EXTERNAL_CHANNEL, url) as Promise<void>,
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
