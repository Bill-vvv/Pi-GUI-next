export const REMOTE_ADMIN_COMMAND_CHANNEL = 'remote-admin:command' as const

export type RemotePairedDevice = {
  pairedAt: number
  expiresAt: number
}

export type RemoteAccessStatus =
  | {
      enabled: false
    }
  | {
      enabled: true
      publicOrigin: string
      device: RemotePairedDevice | null
    }

export type RemotePairingCode = {
  code: string
  expiresAt: number
}

export type RemoteAdminCommand =
  | { type: 'remote-admin.get-status' }
  | { type: 'remote-admin.create-pairing-code' }
  | { type: 'remote-admin.revoke-device' }

export type RemoteAdminApi = {
  getStatus(): Promise<RemoteAccessStatus>
  createPairingCode(): Promise<RemotePairingCode>
  revokeDevice(): Promise<RemoteAccessStatus>
}

const REMOTE_ADMIN_COMMAND_TYPES = new Set<RemoteAdminCommand['type']>([
  'remote-admin.get-status',
  'remote-admin.create-pairing-code',
  'remote-admin.revoke-device'
])

export function isRemoteAdminCommand(value: unknown): value is RemoteAdminCommand {
  return typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as { type?: unknown }).type === 'string' &&
    REMOTE_ADMIN_COMMAND_TYPES.has((value as { type: RemoteAdminCommand['type'] }).type)
}
