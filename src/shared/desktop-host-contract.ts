import type {
  KernelCommand,
  KernelEvent
} from './kernel-contract.ts'
import type { GitCommand } from './git-contract.ts'
import type { DesktopAttachmentCommand } from './desktop-attachment-contract.ts'

export const DESKTOP_HOST_PROTOCOL_VERSION = 3 as const
export const DESKTOP_HOST_PAIRING_ID_PATTERN = /^[0-9a-f]{64}$/u
/** Credential-free identity check: the client's own public pairing identity (R12). */
export const DESKTOP_HOST_PAIRING_ID_HEADER = 'x-pi-gui-pairing-id' as const
export const DESKTOP_HOST_DEVICE_LABEL_LIMIT = 80
/** 409 body of the event stream when another paired device holds the control connection. */
export const DESKTOP_HOST_OCCUPIED_MESSAGE = 'Another desktop device is controlling this Host.'
export const DESKTOP_HOST_JSON_RESPONSE_BYTE_LIMIT = 2 * 1024 * 1024
export const DESKTOP_HOST_CONTROLLER_HEADER = 'x-pi-gui-controller-id' as const
export const DESKTOP_HOST_CONTROLLER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
export const DESKTOP_HOST_CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{32,256}$/u

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
  'kernel.list-project-directories',
  'kernel.add-project',
  'kernel.resolve-project-trust',
  'kernel.activate-project',
  'kernel.start-session',
  'kernel.reload-session',
  'kernel.activate-session',
  'kernel.load-earlier-conversation',
  'kernel.get-message-image',
  'kernel.get-tool-image',
  'kernel.submit-ask',
  'kernel.cancel-ask',
  'kernel.respond-extension-dialog',
  'kernel.cancel-extension-dialog',
  'kernel.invoke-command',
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

export const DESKTOP_HOST_GIT_READ_COMMAND_TYPES = [
  'git.refresh', 'git.authorize-ancestor-repository', 'git.get-diff', 'git.read-file',
  'git.list-history', 'git.get-history-detail', 'git.get-history-file-diff'
] as const
// Only staged-file changes and an ordinary commit are exposed; the Gateway
// restricts execute-commit modes independently of this command-type capability.
export const DESKTOP_HOST_GIT_WRITE_COMMAND_TYPES = [
  'git.mutate-file', 'git.prepare-commit', 'git.execute-commit'
] as const
export const DESKTOP_HOST_GIT_COMMAND_TYPES = [
  ...DESKTOP_HOST_GIT_READ_COMMAND_TYPES, ...DESKTOP_HOST_GIT_WRITE_COMMAND_TYPES
] as const
export type DesktopHostGitCommandType = typeof DESKTOP_HOST_GIT_COMMAND_TYPES[number]
export type DesktopHostGitCommand = Extract<GitCommand, { type: DesktopHostGitCommandType }>
export type DesktopHostCommand = DesktopHostKernelCommand | DesktopHostGitCommand | DesktopAttachmentCommand
const DESKTOP_HOST_GIT_COMMAND_TYPE_SET = new Set<string>(DESKTOP_HOST_GIT_COMMAND_TYPES)
export function isDesktopHostGitCommand(command: KernelCommand | GitCommand | DesktopAttachmentCommand): command is DesktopHostGitCommand {
  return DESKTOP_HOST_GIT_COMMAND_TYPE_SET.has(command.type)
}

const DESKTOP_HOST_KERNEL_COMMAND_TYPE_SET = new Set<string>(DESKTOP_HOST_KERNEL_COMMAND_TYPES)

export function isDesktopHostKernelCommand(
  command: KernelCommand | GitCommand | DesktopAttachmentCommand
): command is DesktopHostKernelCommand {
  return DESKTOP_HOST_KERNEL_COMMAND_TYPE_SET.has(command.type)
}

export type DesktopHostCapabilities = {
  kernelCommandTypes: readonly DesktopHostKernelCommandType[]
  /** Absent when the Host has no Git handler. */
  gitCommandTypes?: readonly DesktopHostGitCommandType[]
  attachmentCommandTypes?: readonly DesktopAttachmentCommand['type'][]
}

export type DesktopHostSessionStatus = {
  protocolVersion: typeof DESKTOP_HOST_PROTOCOL_VERSION
  productVersion: string
  buildCommit: string | null
  authenticated: boolean
  /** Null when no pairing identity was sent; otherwise whether it is a currently valid pairing. */
  pairingKnown: boolean | null
  capabilities: DesktopHostCapabilities
}

export type DesktopHostPairRequest = {
  protocolVersion: typeof DESKTOP_HOST_PROTOCOL_VERSION
  productVersion: string
  buildCommit: string
  code: string
  /** Optional device name shown in the Host device list. */
  label?: string
}

/**
 * Shared device-name rule: strip control characters, trim and bound the length.
 * An empty result means "no name"; a name never causes pairing to fail.
 */
export function normalizeDesktopDeviceLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const label = value.replace(/[\u0000-\u001f\u007f]/gu, '').trim().slice(0, DESKTOP_HOST_DEVICE_LABEL_LIMIT).trim()
  return label.length === 0 ? null : label
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

export function isDesktopHostControlIdentity(value: unknown): value is DesktopHostControlIdentity {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (Object.keys(record).length !== 2 || !Object.hasOwn(record, 'projectKey') || !Object.hasOwn(record, 'sessionKey')) return false
  return [record.projectKey, record.sessionKey].every((key) =>
    key === null || (typeof key === 'string' && key.length > 0 && key.length <= 4_096 && !key.includes('\0'))
  )
}

export type DesktopHostCommandRequest = {
  protocolVersion: typeof DESKTOP_HOST_PROTOCOL_VERSION
  requestId: string
  expectedIdentity: DesktopHostControlIdentity
  command: DesktopHostCommand
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
