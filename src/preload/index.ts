import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

import {
  KERNEL_COMMAND_CHANNEL,
  KERNEL_EVENT_CHANNEL,
  OPEN_EXTERNAL_CHANNEL,
  type KernelApi,
  type KernelCommand,
  type KernelEvent,
  type KernelState
} from '../shared/kernel-contract'

const kernelApi: KernelApi = {
  getState: () => {
    const command: KernelCommand = { type: 'kernel.get-state' }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelState>
  },
  selectProject: () => {
    const command: KernelCommand = { type: 'kernel.select-project' }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelState>
  },
  startProject: () => {
    const command: KernelCommand = { type: 'kernel.start-project' }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelState>
  },
  resumeSession: () => {
    const command: KernelCommand = { type: 'kernel.resume-session' }

    return ipcRenderer.invoke(KERNEL_COMMAND_CHANNEL, command) as Promise<KernelState>
  },
  prompt: (message) => {
    const command: KernelCommand = { type: 'kernel.prompt', message }

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
