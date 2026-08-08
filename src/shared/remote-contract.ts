import type {
  KernelCommand,
  KernelEvent
} from './kernel-contract.ts'

export const REMOTE_PROTOCOL_VERSION = 2 as const

export const REMOTE_SESSION_COOKIE_NAME = '__Host-pi-gui-remote' as const
export const REMOTE_PAIRING_CODE_LENGTH = 6 as const

export const REMOTE_API_PATHS = {
  session: '/api/session',
  pair: '/api/session/pair',
  logout: '/api/session/logout',
  state: '/api/state',
  command: '/api/command',
  events: '/api/events'
} as const

export const REMOTE_KERNEL_COMMAND_TYPES = [
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

export type RemoteKernelCommandType = typeof REMOTE_KERNEL_COMMAND_TYPES[number]
export type RemoteKernelCommand = Extract<KernelCommand, { type: RemoteKernelCommandType }>

const REMOTE_KERNEL_COMMAND_TYPE_SET = new Set<string>(REMOTE_KERNEL_COMMAND_TYPES)

export function isRemoteKernelCommand(command: KernelCommand): command is RemoteKernelCommand {
  return REMOTE_KERNEL_COMMAND_TYPE_SET.has(command.type)
}

export type RemoteSessionStatus = {
  protocolVersion: typeof REMOTE_PROTOCOL_VERSION
  authenticated: boolean
}

export type RemotePairRequest = {
  code: string
}

export type RemoteCommandRequest = {
  protocolVersion: typeof REMOTE_PROTOCOL_VERSION
  requestId: string
  command: RemoteKernelCommand
}

export type RemoteCommandErrorCode =
  | 'bad-request'
  | 'unauthorized'
  | 'forbidden'
  | 'conflict'
  | 'unavailable'
  | 'internal'

export type RemoteCommandResponse =
  | {
      protocolVersion: typeof REMOTE_PROTOCOL_VERSION
      requestId: string
      ok: true
      value: unknown
    }
  | {
      protocolVersion: typeof REMOTE_PROTOCOL_VERSION
      requestId: string
      ok: false
      error: {
        code: RemoteCommandErrorCode
        message: string
      }
    }

export type RemoteEventEnvelope = {
  protocolVersion: typeof REMOTE_PROTOCOL_VERSION
  event: KernelEvent
}
