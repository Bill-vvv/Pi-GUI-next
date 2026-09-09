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

export type TailscaleRemoteMode = 'off' | 'serve' | 'funnel'

export type TailscaleRemoteStatus = {
  installed: boolean
  backendState: string | null
  dnsName: string | null
  authUrl: string | null
  managedMode: TailscaleRemoteMode
  routeState: 'off' | 'active' | 'conflict' | 'unavailable'
  publicOrigin: string | null
}

export type DesktopHostAccessStatus =
  | {
      enabled: false
    }
  | {
      enabled: true
      endpoint: string
      device: RemotePairedDevice | null
    }

export type RemoteAdminCommand =
  | { type: 'remote-admin.get-status' }
  | { type: 'remote-admin.create-pairing-code' }
  | { type: 'remote-admin.revoke-device' }
  | { type: 'remote-admin.get-tailscale-status' }
  | { type: 'remote-admin.enable-tailscale-funnel' }
  | { type: 'remote-admin.enable-tailscale-serve' }
  | { type: 'remote-admin.disable-tailscale' }
  | { type: 'remote-admin.get-desktop-host-status' }
  | { type: 'remote-admin.create-desktop-host-pairing-code' }
  | { type: 'remote-admin.revoke-desktop-host-device' }

export type RemoteAdminApi = {
  getStatus(): Promise<RemoteAccessStatus>
  createPairingCode(): Promise<RemotePairingCode>
  revokeDevice(): Promise<RemoteAccessStatus>
  getTailscaleStatus(): Promise<TailscaleRemoteStatus>
  enableTailscaleFunnel(): Promise<TailscaleRemoteStatus>
  enableTailscaleServe(): Promise<TailscaleRemoteStatus>
  disableTailscale(): Promise<TailscaleRemoteStatus>
  getDesktopHostStatus(): Promise<DesktopHostAccessStatus>
  createDesktopHostPairingCode(): Promise<RemotePairingCode>
  revokeDesktopHostDevice(): Promise<DesktopHostAccessStatus>
}

const REMOTE_ADMIN_COMMAND_TYPES = new Set<RemoteAdminCommand['type']>([
  'remote-admin.get-status',
  'remote-admin.create-pairing-code',
  'remote-admin.revoke-device',
  'remote-admin.get-tailscale-status',
  'remote-admin.enable-tailscale-funnel',
  'remote-admin.enable-tailscale-serve',
  'remote-admin.disable-tailscale',
  'remote-admin.get-desktop-host-status',
  'remote-admin.create-desktop-host-pairing-code',
  'remote-admin.revoke-desktop-host-device'
])

export function isRemoteAdminCommand(value: unknown): value is RemoteAdminCommand {
  return typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as { type?: unknown }).type === 'string' &&
    REMOTE_ADMIN_COMMAND_TYPES.has((value as { type: RemoteAdminCommand['type'] }).type)
}
