import type {
  KernelCommand,
  KernelEvent
} from './kernel-contract.ts'

export const DESKTOP_HOST_PROTOCOL_VERSION = 1 as const
export const DESKTOP_HOST_CONTROLLER_HEADER = 'x-pi-gui-controller-id' as const
export const DESKTOP_HOST_CONTROLLER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

export const DESKTOP_HOST_API_PATHS = {
  session: '/api/desktop-host/session',
  pair: '/api/desktop-host/pair',
  logout: '/api/desktop-host/logout',
  state: '/api/desktop-host/state',
  command: '/api/desktop-host/command',
  events: '/api/desktop-host/events'
} as const

export const DESKTOP_HOST_KERNEL_COMMAND_TYPES = [
  'kernel.get-state',
  'kernel.activate-project',
  'kernel.start-session',
  'kernel.reload-session',
  'kernel.activate-session',
  'kernel.load-earlier-conversation',
  'kernel.get-message-image',
  'kernel.get-tool-image',
  'kernel.submit-ask',
  'kernel.cancel-ask',
  'kernel.prompt',
  'kernel.steer',
  'kernel.follow-up',
  'kernel.abort',
  'kernel.set-model',
  'kernel.set-thinking-level',
  'kernel.set-openai-fast-mode'
] as const

export type DesktopHostKernelCommandType = typeof DESKTOP_HOST_KERNEL_COMMAND_TYPES[number]
export type DesktopHostKernelCommand = Extract<KernelCommand, { type: DesktopHostKernelCommandType }>

const DESKTOP_HOST_KERNEL_COMMAND_TYPE_SET = new Set<string>(DESKTOP_HOST_KERNEL_COMMAND_TYPES)

export function isDesktopHostKernelCommand(
  command: KernelCommand
): command is DesktopHostKernelCommand {
  return DESKTOP_HOST_KERNEL_COMMAND_TYPE_SET.has(command.type)
}

export type DesktopHostCapabilities = {
  kernelCommandTypes: readonly DesktopHostKernelCommandType[]
}

export type DesktopHostSessionStatus = {
  protocolVersion: typeof DESKTOP_HOST_PROTOCOL_VERSION
  productVersion: string
  buildCommit: string | null
  authenticated: boolean
  capabilities: DesktopHostCapabilities
}

export type DesktopHostPairRequest = {
  protocolVersion: typeof DESKTOP_HOST_PROTOCOL_VERSION
  productVersion: string
  buildCommit: string
  code: string
}

export type DesktopHostPairResponse = {
  protocolVersion: typeof DESKTOP_HOST_PROTOCOL_VERSION
  productVersion: string
  buildCommit: string | null
  credential: string
  expiresAt: number
  capabilities: DesktopHostCapabilities
}

export type DesktopHostControlIdentity = {
  projectKey: string | null
  sessionKey: string | null
}

export type DesktopHostCommandRequest = {
  protocolVersion: typeof DESKTOP_HOST_PROTOCOL_VERSION
  requestId: string
  expectedIdentity: DesktopHostControlIdentity
  command: DesktopHostKernelCommand
}

export type DesktopHostCommandErrorCode =
  | 'bad-request'
  | 'unauthorized'
  | 'forbidden'
  | 'conflict'
  | 'unavailable'
  | 'internal'

export type DesktopHostCommandResponse =
  | {
      protocolVersion: typeof DESKTOP_HOST_PROTOCOL_VERSION
      requestId: string
      ok: true
      value: unknown
    }
  | {
      protocolVersion: typeof DESKTOP_HOST_PROTOCOL_VERSION
      requestId: string | null
      ok: false
      error: {
        code: DesktopHostCommandErrorCode
        message: string
      }
    }

export type DesktopHostEventEnvelope = {
  protocolVersion: typeof DESKTOP_HOST_PROTOCOL_VERSION
  event: KernelEvent
}
