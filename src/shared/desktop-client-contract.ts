import type { DesktopHostCapabilities, DesktopHostControlIdentity } from './desktop-host-contract.ts'
import type { DesktopAttachmentData, DesktopUploadedAttachment } from './desktop-attachment-contract.ts'
import type { KernelMutationAck } from './kernel-contract.ts'
import { isDesktopEnvironment, isDesktopPreferences, isDesktopPreferencesUpdate, type DesktopEnvironment, type DesktopEnvironmentStatus, type DesktopPreferences, type DesktopPreferencesUpdate } from './desktop-settings-contract.ts'

export const DESKTOP_CLIENT_COMMAND_CHANNEL = 'pi-gui:desktop-client.command'
export const DESKTOP_CLIENT_STATUS_CHANNEL = 'pi-gui:desktop-client.status'
export const DESKTOP_CLIENT_DEFAULT_PORT = 18788

export function isDesktopSshHostAlias(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)
}

export type DesktopSshHostListing = {
  hosts: { alias: string; filePath: string; line: number }[]
  searchedFiles: string[]
  warnings: string[]
}

export type DesktopClientHostConfig = {
  sshHostAlias: string
  localPort: number
  desktopHostPort: number
}

function hostConfigError(value: unknown): string | null {
  if (!isRecord(value) || Object.keys(value).length !== 3) return 'Windows remote host config must contain exactly sshHostAlias, localPort, and desktopHostPort.'
  if (!isDesktopSshHostAlias(value.sshHostAlias)) return 'SSH host alias must be 1 to 128 ASCII letters, digits, dots, underscores, or hyphens and must not begin with an option prefix.'
  for (const field of ['localPort', 'desktopHostPort']) {
    if (!Number.isInteger(value[field]) || Number(value[field]) < 1 || Number(value[field]) > 65535) return `${field} must be an integer between 1 and 65535.`
  }
  return null
}

export function parseDesktopClientHostConfig(value: unknown): DesktopClientHostConfig {
  const error = hostConfigError(value)
  if (error !== null) throw new Error(error)
  const config = value as DesktopClientHostConfig
  return { sshHostAlias: config.sshHostAlias, localPort: config.localPort, desktopHostPort: config.desktopHostPort }
}

export type DesktopHostProfile = { id: string; name: string; config: DesktopClientHostConfig }
export type DesktopHostProfileSelection = { id: string | null; revision: number }
export type DesktopHostProfilesView = {
  revision: number
  selectedId: string | null
  profiles: DesktopHostProfile[]
  ready: boolean
}
export const DESKTOP_HOST_PROFILE_LIMIT = 32
export function isDesktopHostProfileId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
}
export function isDesktopHostProfileName(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 80 && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
}
export function isDesktopHostProfileSelection(value: unknown): value is DesktopHostProfileSelection {
  return isRecord(value) && Object.keys(value).length === 2 && (value.id === null || isDesktopHostProfileId(value.id)) &&
    Number.isSafeInteger(value.revision) && Number(value.revision) >= 0
}
export type DesktopHostProfileCommand =
  | { type: 'desktop-client.host-profiles.save'; expectedRevision: number; id: string | null; name: string; config: DesktopClientHostConfig }
  | { type: 'desktop-client.host-profiles.select'; expectedRevision: number; id: string | null }
  | { type: 'desktop-client.host-profiles.remove' | 'desktop-client.host-profiles.forget'; expectedRevision: number; id: string }
  | { type: 'desktop-client.host-profiles.retry'; expectedRevision: number }

export function isDesktopHostProfileCommand(value: unknown): value is DesktopHostProfileCommand {
  if (!isRecord(value) || !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0) return false
  if (value.type === 'desktop-client.host-profiles.retry') return Object.keys(value).length === 2
  if (value.type === 'desktop-client.host-profiles.save') return Object.keys(value).length === 5 &&
    (value.id === null || isDesktopHostProfileId(value.id)) && isDesktopHostProfileName(value.name) && hostConfigError(value.config) === null
  if (value.type === 'desktop-client.host-profiles.select') return Object.keys(value).length === 3 && (value.id === null || isDesktopHostProfileId(value.id))
  return (value.type === 'desktop-client.host-profiles.remove' || value.type === 'desktop-client.host-profiles.forget') &&
    Object.keys(value).length === 3 && isDesktopHostProfileId(value.id)
}

export type DesktopConnectionFailureKind =
  | 'network'
  | 'authentication'
  | 'credential-target'
  | 'ssh-authentication'
  | 'host-key'
  | 'protocol'
  | 'configuration'
  | 'unknown'

export const DESKTOP_HOST_CHECK_STAGES = ['local-port', 'ssh-executable', 'ssh-configuration', 'ssh-tunnel', 'host'] as const
export type DesktopHostCheckStage = typeof DESKTOP_HOST_CHECK_STAGES[number]
export type DesktopHostCheckResult = {
  config: DesktopClientHostConfig
  checkedAt: string
  outcome: 'passed' | 'failed' | 'cancelled'
  steps: { stage: DesktopHostCheckStage; status: 'passed' | 'failed' | 'skipped'; detail: string | null }[]
  cleanupError: string | null
}

export type DesktopClientStatus =
  | { mode: 'local' }
  | { mode: 'wsl' }
  | {
      mode: 'windows-remote'
      phase: 'disconnected' | 'checking' | 'connecting' | 'reconnecting' | 'connected' | 'disconnecting' | 'revoking' | 'configuring'
      hasStoredCredential: boolean
      lastHost: DesktopClientHostConfig | null
      capabilities: DesktopHostCapabilities | null
      error: string | null
      failureKind: DesktopConnectionFailureKind | null
      recovery: { attempt: number; maxAttempts: number; delayMs: number } | null
      hostProfiles?: DesktopHostProfilesView
      hostConnectionId?: string | null
    }

export type DesktopClientConnectRequest = DesktopClientHostConfig & {
  pairingCode?: string
  profile?: DesktopHostProfileSelection
}

export type DesktopClientCommand =
  | DesktopHostProfileCommand
  | { type: 'desktop-client.get-environment' }
  | { type: 'desktop-client.switch-environment'; environment: DesktopEnvironment }
  | { type: 'desktop-client.get-preferences'; seed?: DesktopPreferences }
  | { type: 'desktop-client.set-preferences'; patch: DesktopPreferencesUpdate }
  | { type: 'desktop-client.get-status' }
  | { type: 'desktop-client.list-ssh-hosts' }
  | { type: 'desktop-client.check-host'; operationId: string; config: DesktopClientHostConfig }
  | { type: 'desktop-client.cancel-host-check'; operationId: string }
  | ({ type: 'desktop-client.connect' } & DesktopClientConnectRequest)
  | { type: 'desktop-client.disconnect' }
  | { type: 'desktop-client.revoke-pairing'; config: DesktopClientHostConfig }

export type DesktopClientApi = {
  manageHostProfiles: (command: DesktopHostProfileCommand) => Promise<void>
  checkHost: (operationId: string, config: DesktopClientHostConfig) => Promise<DesktopHostCheckResult>
  cancelHostCheck: (operationId: string) => Promise<void>
  listSshHosts: () => Promise<DesktopSshHostListing>
  selectAttachments: (operationId: string) => Promise<DesktopUploadedAttachment[]>
  uploadAttachments: (operationId: string, files: DesktopAttachmentData[]) => Promise<DesktopUploadedAttachment[]>
  cancelAttachmentUpload: (operationId: string) => Promise<void>
  discardAttachments: (uploadIds: string[]) => Promise<void>
  submitAttachments: (mode: 'prompt' | 'steer' | 'follow-up', message: string, uploadIds: string[], expectedSessionKey?: string) => Promise<KernelMutationAck>
  getEnvironment: () => Promise<DesktopEnvironmentStatus>
  switchEnvironment: (environment: DesktopEnvironment) => Promise<void>
  getPreferences: (seed?: DesktopPreferences) => Promise<DesktopPreferences | null>
  setPreferences: (patch: DesktopPreferencesUpdate) => Promise<DesktopPreferences>
  setControlIdentity: (identity: DesktopHostControlIdentity | null) => void
  getStatus: () => Promise<DesktopClientStatus>
  connect: (request: DesktopClientConnectRequest) => Promise<void>
  disconnect: () => Promise<void>
  revokePairing: (config: DesktopClientHostConfig) => Promise<void>
  subscribeStatus: (listener: (status: DesktopClientStatus) => void) => () => void
}

export function isDesktopClientCommand(value: unknown): value is DesktopClientCommand {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  if (value.type.startsWith('desktop-client.host-profiles.')) return isDesktopHostProfileCommand(value)
  if (value.type === 'desktop-client.revoke-pairing') return Object.keys(value).length === 2 && hostConfigError(value.config) === null
  if (value.type === 'desktop-client.check-host' || value.type === 'desktop-client.cancel-host-check') {
    if (typeof value.operationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(value.operationId)) return false
    if (value.type === 'desktop-client.cancel-host-check') return Object.keys(value).length === 2
    return Object.keys(value).length === 3 && hostConfigError(value.config) === null
  }
  if (value.type === 'desktop-client.get-environment') return Object.keys(value).length === 1
  if (value.type === 'desktop-client.switch-environment') return Object.keys(value).length === 2 && isDesktopEnvironment(value.environment)
  if (value.type === 'desktop-client.get-preferences') return Object.keys(value).length === 1 || (Object.keys(value).length === 2 && isDesktopPreferences(value.seed))
  if (value.type === 'desktop-client.set-preferences') return Object.keys(value).length === 2 && isDesktopPreferencesUpdate(value.patch)
  if (value.type === 'desktop-client.get-status' || value.type === 'desktop-client.disconnect' || value.type === 'desktop-client.list-ssh-hosts') {
    return Object.keys(value).length === 1
  }
  if (value.type !== 'desktop-client.connect') return false
  const keys = Object.keys(value).filter((key) => key !== 'profile')
  if (Object.hasOwn(value, 'profile') && !isDesktopHostProfileSelection(value.profile)) return false
  if (
    typeof value.sshHostAlias !== 'string' ||
    typeof value.localPort !== 'number' ||
    typeof value.desktopHostPort !== 'number'
  ) {
    return false
  }
  if (keys.length === 4) return !('pairingCode' in value)
  return keys.length === 5 && typeof value.pairingCode === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
