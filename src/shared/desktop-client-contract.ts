export const DESKTOP_CLIENT_COMMAND_CHANNEL = 'pi-gui:desktop-client.command'
export const DESKTOP_CLIENT_STATUS_CHANNEL = 'pi-gui:desktop-client.status'
export const DESKTOP_CLIENT_DEFAULT_PORT = 18788

export type DesktopClientStatus =
  | { mode: 'local' }
  | { mode: 'wsl' }
  | {
      mode: 'windows-remote'
      phase: 'disconnected' | 'connecting' | 'connected'
    }

export type DesktopClientConnectRequest = {
  sshHostAlias: string
  localPort: number
  desktopHostPort: number
  pairingCode: string
}

export type DesktopClientCommand =
  | { type: 'desktop-client.get-status' }
  | ({ type: 'desktop-client.connect' } & DesktopClientConnectRequest)
  | { type: 'desktop-client.disconnect' }

export type DesktopClientApi = {
  getStatus: () => Promise<DesktopClientStatus>
  connect: (request: DesktopClientConnectRequest) => Promise<void>
  disconnect: () => Promise<void>
  subscribeStatus: (listener: (status: DesktopClientStatus) => void) => () => void
}

export function isDesktopClientCommand(value: unknown): value is DesktopClientCommand {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  if (value.type === 'desktop-client.get-status' || value.type === 'desktop-client.disconnect') {
    return Object.keys(value).length === 1
  }
  return value.type === 'desktop-client.connect' && Object.keys(value).length === 5
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
