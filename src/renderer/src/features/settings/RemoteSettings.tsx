import type {
  DesktopHostAccessStatus,
  RemoteAccessStatus,
  RemotePairingCode,
  TailscaleRemoteStatus
} from '../../../../shared/remote-admin-contract'
import { DesktopHostAccessPanel } from './DesktopHostAccessPanel'
import { RemoteAccessPanel } from './RemoteAccessPanel'
import { SettingsPageHeading } from './SettingsPageHeading'

export function RemoteSettings({
  busy,
  onGetRemoteAccessStatus,
  onCreateRemotePairingCode,
  onRevokeRemoteDevice,
  onGetTailscaleStatus,
  onEnableTailscaleFunnel,
  onEnableTailscaleServe,
  onDisableTailscale,
  onGetDesktopHostStatus,
  onCreateDesktopHostPairingCode,
  onRevokeDesktopHostDevice,
  onOpenExternal
}: {
  busy: boolean
  onGetRemoteAccessStatus: () => Promise<RemoteAccessStatus>
  onCreateRemotePairingCode: () => Promise<RemotePairingCode>
  onRevokeRemoteDevice: () => Promise<RemoteAccessStatus>
  onGetTailscaleStatus: () => Promise<TailscaleRemoteStatus>
  onEnableTailscaleFunnel: () => Promise<TailscaleRemoteStatus>
  onEnableTailscaleServe: () => Promise<TailscaleRemoteStatus>
  onDisableTailscale: () => Promise<TailscaleRemoteStatus>
  onGetDesktopHostStatus: () => Promise<DesktopHostAccessStatus>
  onCreateDesktopHostPairingCode: () => Promise<RemotePairingCode>
  onRevokeDesktopHostDevice: () => Promise<DesktopHostAccessStatus>
  onOpenExternal: (url: string) => Promise<void>
}): React.JSX.Element {
  return (
    <>
      <SettingsPageHeading title="远程访问" />
      <RemoteAccessPanel
        busy={busy}
        onGetStatus={onGetRemoteAccessStatus}
        onCreatePairingCode={onCreateRemotePairingCode}
        onRevokeDevice={onRevokeRemoteDevice}
        onGetTailscaleStatus={onGetTailscaleStatus}
        onEnableTailscaleFunnel={onEnableTailscaleFunnel}
        onEnableTailscaleServe={onEnableTailscaleServe}
        onDisableTailscale={onDisableTailscale}
        onOpenExternal={onOpenExternal}
      />
      <DesktopHostAccessPanel
        busy={busy}
        onGetStatus={onGetDesktopHostStatus}
        onCreatePairingCode={onCreateDesktopHostPairingCode}
        onRevokeDevice={onRevokeDesktopHostDevice}
      />
    </>
  )
}
