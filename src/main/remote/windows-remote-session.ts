import { randomUUID } from 'node:crypto'

import {
  isDesktopHostKernelCommand,
  type DesktopHostKernelCommand
} from '../../shared/desktop-host-contract.ts'
import type { DesktopClientStatus } from '../../shared/desktop-client-contract.ts'
import type {
  KernelCommand,
  KernelEvent,
  KernelSnapshot
} from '../../shared/kernel-contract.ts'
import { REMOTE_PAIRING_CODE_LENGTH } from '../../shared/remote-contract.ts'
import {
  DesktopHostClient,
  desktopHostControlIdentity,
  type DesktopHostClientOptions,
  type DesktopHostEventStream
} from './desktop-host-client.ts'
import {
  startSystemSshTunnel,
  type StartSystemSshTunnelOptions,
  type SystemSshTunnel
} from './system-ssh-tunnel.ts'
import {
  parseWindowsRemoteHostConfig,
  type WindowsRemoteHostConfig
} from './windows-remote-host-config.ts'

const PAIRING_CODE_PATTERN = new RegExp(`^\\d{${REMOTE_PAIRING_CODE_LENGTH}}$`, 'u')

export type WindowsRemoteSession = {
  status(): Extract<DesktopClientStatus, { mode: 'windows-remote' }>
  connect(request: WindowsRemoteHostConfig & { pairingCode: string }): Promise<KernelSnapshot>
  disconnect(): Promise<void>
  dispatch(command: KernelCommand): Promise<unknown>
}

export type CreateWindowsRemoteSessionOptions = {
  productVersion: string
  buildCommit: string
  onEvent(event: KernelEvent): void
  onStatus?(status: Extract<DesktopClientStatus, { mode: 'windows-remote' }>): void
  startTunnel?: (options: StartSystemSshTunnelOptions) => Promise<SystemSshTunnel>
  createClient?: (options: DesktopHostClientOptions) => DesktopHostClient
}

export function parseWindowsRemoteConnectRequest(
  value: unknown
): WindowsRemoteHostConfig & { pairingCode: string } {
  if (!isRecord(value) || Object.keys(value).length !== 4) {
    throw new Error(
      'Desktop client connect request must contain exactly sshHostAlias, localPort, desktopHostPort, and pairingCode.'
    )
  }
  if (typeof value.pairingCode !== 'string' || !PAIRING_CODE_PATTERN.test(value.pairingCode)) {
    throw new Error(`Desktop Host pairing code must contain exactly ${REMOTE_PAIRING_CODE_LENGTH} digits.`)
  }
  return {
    ...parseWindowsRemoteHostConfig({
      sshHostAlias: value.sshHostAlias,
      localPort: value.localPort,
      desktopHostPort: value.desktopHostPort
    }),
    pairingCode: value.pairingCode
  }
}

export function createWindowsRemoteSession(
  options: CreateWindowsRemoteSessionOptions
): WindowsRemoteSession {
  if (
    options.productVersion.length === 0 ||
    options.productVersion.length > 128 ||
    /[\r\n\0]/u.test(options.productVersion)
  ) {
    throw new Error('Windows remote client requires a valid product version.')
  }
  if (
    options.buildCommit.length === 0 ||
    options.buildCommit.length > 128 ||
    /[\r\n\0]/u.test(options.buildCommit)
  ) {
    throw new Error('Windows remote client requires a known non-null build commit.')
  }

  const startTunnel = options.startTunnel ?? startSystemSshTunnel
  const createClient = options.createClient ?? ((clientOptions) => new DesktopHostClient(clientOptions))
  let phase: 'disconnected' | 'connecting' | 'connected' = 'disconnected'
  let generation = 0
  let tunnel: SystemSshTunnel | null = null
  let client: DesktopHostClient | null = null
  let stream: DesktopHostEventStream | null = null
  let controllerId: string | null = null
  let snapshot: KernelSnapshot | null = null

  const currentStatus = (): Extract<DesktopClientStatus, { mode: 'windows-remote' }> => ({
    mode: 'windows-remote',
    phase
  })

  const publishStatus = (): void => {
    options.onStatus?.(currentStatus())
  }

  const cleanup = async (): Promise<void> => {
    const activeStream = stream
    const activeTunnel = tunnel
    const activeClient = client
    stream = null
    tunnel = null
    client = null
    controllerId = null
    snapshot = null
    if (activeStream !== null) await activeStream.close().catch(() => undefined)
    if (activeClient !== null) activeClient.clearCredential()
    if (activeTunnel !== null) await activeTunnel.stop().catch(() => undefined)
  }

  const failClosed = async (ownedGeneration: number): Promise<void> => {
    if (ownedGeneration !== generation || phase === 'disconnected') return
    generation += 1
    phase = 'disconnected'
    await cleanup()
    publishStatus()
  }

  return {
    status: currentStatus,
    async connect(request) {
      if (phase === 'connecting') {
        throw new Error('A Desktop Host connection is already in progress.')
      }
      if (phase === 'connected') {
        throw new Error('Disconnect before connecting to another Desktop Host.')
      }
      const parsed = parseWindowsRemoteConnectRequest(request)
      phase = 'connecting'
      publishStatus()
      const ownedGeneration = ++generation
      const nextClient = createClient({
        localPort: parsed.localPort,
        compatibility: {
          productVersion: options.productVersion,
          buildCommit: options.buildCommit
        }
      })
      let nextTunnel: SystemSshTunnel | null = null
      let nextStream: DesktopHostEventStream | null = null
      try {
        nextTunnel = await startTunnel({
          config: {
            sshHostAlias: parsed.sshHostAlias,
            localPort: parsed.localPort,
            desktopHostPort: parsed.desktopHostPort
          },
          verifyUnauthenticatedDesktopHost: async (signal) => {
            if (signal.aborted) {
              throw new Error('OpenSSH terminated before the Desktop Host handshake.')
            }
            await nextClient.verifyCompatibility()
          }
        })
        if (ownedGeneration !== generation) {
          throw new Error('Desktop Host connection was cancelled.')
        }
        await nextClient.pair(parsed.pairingCode)
        const nextControllerId = randomUUID()
        nextStream = await nextClient.openEventStream(nextControllerId, (event) => {
          if (ownedGeneration !== generation) return
          options.onEvent(event)
        })
        const nextSnapshot = await nextClient.getState(nextControllerId)
        if (ownedGeneration !== generation) {
          throw new Error('Desktop Host connection was cancelled.')
        }
        tunnel = nextTunnel
        client = nextClient
        stream = nextStream
        controllerId = nextControllerId
        snapshot = nextSnapshot
        phase = 'connected'
        publishStatus()
        void nextTunnel.termination.then((termination) => {
          if (termination.expected) return
          void failClosed(ownedGeneration)
        })
        void nextStream.closed.then(
          () => {
            void failClosed(ownedGeneration)
          },
          () => {
            void failClosed(ownedGeneration)
          }
        )
        options.onEvent({
          type: 'kernel.state-changed',
          revision: nextSnapshot.revision,
          state: nextSnapshot.state
        })
        return nextSnapshot
      } catch (error) {
        if (ownedGeneration === generation) {
          phase = 'disconnected'
          await cleanup()
          if (nextStream !== null && nextStream !== stream) {
            await nextStream.close().catch(() => undefined)
          }
          if (nextTunnel !== null && nextTunnel !== tunnel) {
            await nextTunnel.stop().catch(() => undefined)
          }
          publishStatus()
        }
        throw error
      }
    },
    async disconnect() {
      generation += 1
      const activeClient = client
      phase = 'disconnected'
      try {
        if (activeClient !== null) await activeClient.logout()
      } finally {
        await cleanup()
        publishStatus()
      }
    },
    async dispatch(command) {
      if (phase !== 'connected' || client === null || controllerId === null) {
        throw new Error('Desktop Host is not connected.')
      }
      if (!isDesktopHostKernelCommand(command)) {
        throw new Error('This command is not available on the Windows remote-only client.')
      }
      if (commandHasLocalAttachments(command)) {
        throw new Error('Windows remote-only client does not send local file attachments.')
      }
      const current = await client.getState(controllerId)
      snapshot = current
      if (command.type === 'kernel.get-state') return current
      return await client.command(
        controllerId,
        desktopHostControlIdentity(current),
        command
      )
    }
  }
}

function commandHasLocalAttachments(command: DesktopHostKernelCommand): boolean {
  return (
    (command.type === 'kernel.prompt' ||
      command.type === 'kernel.steer' ||
      command.type === 'kernel.follow-up') &&
    command.attachments !== undefined
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
