import { normalizeOpenTarget } from '../../shared/external-url'
import type { KernelMessageImage, KernelSubagentTranscript } from '../../shared/kernel-contract'

export type RendererHost = {
  normalizeOpenTarget(url: string): string | null
  openExternal(url: string): Promise<void>
  getMessageImage(
    sessionKey: string,
    messageId: string,
    attachmentIndex: number
  ): Promise<KernelMessageImage>
  getToolImage(
    sessionKey: string,
    toolCallId: string,
    contentIndex: number
  ): Promise<KernelMessageImage>
  getSubagentTranscript?: (taskId: string, expectedSessionKey: string) => Promise<KernelSubagentTranscript>
  controlSubagent?: (taskId: string, expectedSessionKey: string, action: 'stop' | 'continue', message?: string) => Promise<void>
}

let configuredHost: RendererHost | null = null

function createDesktopHost(): RendererHost {
  return {
    normalizeOpenTarget,
    openExternal: (url) => window.piGui.openExternal(url),
    getMessageImage: (sessionKey, messageId, attachmentIndex) =>
      window.piGui.getMessageImage(sessionKey, messageId, attachmentIndex),
    getToolImage: (sessionKey, toolCallId, contentIndex) =>
      window.piGui.getToolImage(sessionKey, toolCallId, contentIndex),
    getSubagentTranscript: (taskId, expectedSessionKey) => window.piGui.getSubagentTranscript(taskId, expectedSessionKey),
    controlSubagent: async (taskId, expectedSessionKey, action, message) => {
      await window.piGui.controlSubagent(taskId, expectedSessionKey, action, message)
    }
  }
}

/** Replace the renderer host. Remote boot configures browser-safe callbacks before mount. */
export function configureRendererHost(host: RendererHost): void {
  configuredHost = host
}

/** Desktop defaults to window.piGui; remote overrides via configureRendererHost. */
export function getRendererHost(): RendererHost {
  return configuredHost ?? createDesktopHost()
}
