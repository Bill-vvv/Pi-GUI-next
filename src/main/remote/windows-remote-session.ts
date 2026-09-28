import { randomUUID } from 'node:crypto'
import { isDesktopAttachmentCommand, type DesktopAttachmentCommand } from '../../shared/desktop-attachment-contract.ts'
import { setTimeout as waitForTimeout } from 'node:timers/promises'

import type { GitCommand } from '../../shared/git-contract.ts'
import type { DesktopHostCapabilities } from '../../shared/desktop-host-contract.ts'
import { isDesktopHostKernelCommand, isDesktopHostGitCommand, isDesktopHostControlIdentity, type DesktopHostKernelCommand } from '../../shared/desktop-host-contract.ts'
import type { DesktopClientStatus, DesktopConnectionFailureKind, DesktopHostCheckResult } from '../../shared/desktop-client-contract.ts'
import { runDesktopHostCheck } from './desktop-host-preflight.ts'
import type {
  KernelCommand,
  KernelEvent,
  KernelSnapshot
} from '../../shared/kernel-contract.ts'
import { REMOTE_PAIRING_CODE_LENGTH } from '../../shared/remote-contract.ts'
import {
  DesktopHostClient,
  DesktopHostClientError,
  type DesktopHostClientOptions,
  type DesktopHostEventStream
} from './desktop-host-client.ts'
import {
  createMemoryDesktopDeviceCredentialStore,
  type DesktopDeviceCredentialStore
} from './desktop-device-credential-store.ts'
import {
  createMemoryDesktopClientHostConfigStore,
  type DesktopClientHostConfigStore
} from './desktop-client-host-config-store.ts'
import {
  startSystemSshTunnel,
  SystemSshTunnelError,
  SystemSshStartupCleanupError,
  type StartSystemSshTunnelOptions,
  type SystemSshTunnel
} from './system-ssh-tunnel.ts'
import {
  parseWindowsRemoteHostConfig,
  type WindowsRemoteHostConfig
} from './windows-remote-host-config.ts'

const PAIRING_CODE_PATTERN = new RegExp(`^\\d{${REMOTE_PAIRING_CODE_LENGTH}}$`, 'u')
const RECONNECT_DELAYS_MS = [0, 1_000, 2_000, 4_000, 8_000] as const

export type WindowsRemoteConnectRequest = WindowsRemoteHostConfig & {
  pairingCode?: string
}

export type WindowsRemoteSession = {
  checkHost(operationId: string, config: WindowsRemoteHostConfig): Promise<DesktopHostCheckResult>
  cancelHostCheck(operationId: string): Promise<void>
  status(): Extract<DesktopClientStatus, { mode: 'windows-remote' }>
  connect(request: WindowsRemoteConnectRequest): Promise<KernelSnapshot>
  disconnect(): Promise<void>
  revokePairing(config: WindowsRemoteHostConfig): Promise<void>
  close(): Promise<void>
  dispatch(command: KernelCommand | GitCommand | DesktopAttachmentCommand, expectedIdentity?: unknown): Promise<unknown>
}

export type CreateWindowsRemoteSessionOptions = {
  productVersion: string
  buildCommit: string
  onEvent(event: KernelEvent): void
  onStatus?(status: Extract<DesktopClientStatus, { mode: 'windows-remote' }>): void
  startTunnel?: (options: StartSystemSshTunnelOptions) => Promise<SystemSshTunnel>
  createClient?: (options: DesktopHostClientOptions) => DesktopHostClient
  checkLocalPort?: (port: number, signal: AbortSignal) => Promise<void>
  credentialStore?: DesktopDeviceCredentialStore
  hostConfigStore?: DesktopClientHostConfigStore
  initialLastHost?: WindowsRemoteHostConfig | null
  initialHasStoredCredential?: boolean
  initialCachedCredential?: string | null
  waitForRetry?: (delayMs: number, signal: AbortSignal) => Promise<void>
}

export function parseWindowsRemoteConnectRequest(value: unknown): WindowsRemoteConnectRequest {
  if (!isRecord(value)) {
    throw new Error(
      'Desktop client connect request must contain sshHostAlias, localPort, desktopHostPort, and optional pairingCode.'
    )
  }
  const hasPairingCode = Object.hasOwn(value, 'pairingCode')
  if (hasPairingCode ? Object.keys(value).length !== 4 : Object.keys(value).length !== 3) {
    throw new Error(
      'Desktop client connect request must contain sshHostAlias, localPort, desktopHostPort, and optional pairingCode.'
    )
  }
  const config = parseWindowsRemoteHostConfig({
    sshHostAlias: value.sshHostAlias,
    localPort: value.localPort,
    desktopHostPort: value.desktopHostPort
  })
  if (!hasPairingCode) return config
  if (typeof value.pairingCode !== 'string' || !PAIRING_CODE_PATTERN.test(value.pairingCode)) {
    throw new Error(`Desktop Host pairing code must contain exactly ${REMOTE_PAIRING_CODE_LENGTH} digits.`)
  }
  return {
    ...config,
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
  const credentialStore = options.credentialStore ?? createMemoryDesktopDeviceCredentialStore()
  const hostConfigStore = options.hostConfigStore ?? createMemoryDesktopClientHostConfigStore()
  const waitForRetry = options.waitForRetry ?? ((delayMs, signal) => waitForTimeout(delayMs, undefined, { signal }))
  let phase: Extract<DesktopClientStatus, { mode: 'windows-remote' }>['phase'] = 'disconnected'
  let generation = 0
  let tunnel: SystemSshTunnel | null = null
  let client: DesktopHostClient | null = null
  let stream: DesktopHostEventStream | null = null
  let controllerId: string | null = null
  let lastHost: WindowsRemoteHostConfig | null = options.initialLastHost ?? null
  let hasStoredCredential = options.initialHasStoredCredential === true
  let cachedCredential: string | null = options.initialCachedCredential ?? null
  let capabilities: DesktopHostCapabilities | null = null
  let error: string | null = null
  let failureKind: DesktopConnectionFailureKind | null = null
  let recovery: Extract<DesktopClientStatus, { mode: 'windows-remote' }>['recovery'] = null
  let recoveryController: AbortController | null = null
  let autoResumeArmed = false
  let hostCheck: { operationId: string; controller: AbortController; done: Promise<DesktopHostCheckResult> } | null = null
  let ending: Promise<void> | null = null
  let establishment: Promise<KernelSnapshot> | null = null
  let connectionCleanup: Promise<void> | null = null
  let recoveryWork: Promise<void> | null = null

  const currentStatus = (): Extract<DesktopClientStatus, { mode: 'windows-remote' }> => ({
    mode: 'windows-remote',
    phase,
    hasStoredCredential,
    lastHost,
    capabilities,
    error,
    failureKind,
    recovery
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
    if (activeClient !== null) activeClient.clearCredential()
    const results = await Promise.allSettled([
      activeStream?.close(),
      activeTunnel?.stop()
    ])
    if (results[1]?.status === 'rejected') tunnel = activeTunnel
    const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason)
    if (errors.length > 0) throw new AggregateError(errors, 'Desktop Host connection cleanup failed.')
  }

  const establishConnection = async (
    config: WindowsRemoteHostConfig,
    pairingCode: string | null,
    ownedGeneration: number
  ): Promise<KernelSnapshot> => {
    const nextClient = createClient({
      localPort: config.localPort,
      compatibility: {
        productVersion: options.productVersion,
        buildCommit: options.buildCommit
      }
    })
    let nextTunnel: SystemSshTunnel | null = null
    let nextStream: DesktopHostEventStream | null = null
    let attemptActive = true
    let streamFailure: unknown = null
    let handshakeCapabilities: DesktopHostCapabilities | null = null
    let nextCapabilities: DesktopHostCapabilities | null = null
    try {
      nextTunnel = await startTunnel({
        config,
        verifyUnauthenticatedDesktopHost: async (signal) => {
          if (signal.aborted) {
            throw new Error('OpenSSH terminated before the Desktop Host handshake.')
          }
          handshakeCapabilities = (await nextClient.verifyCompatibility(signal)).capabilities
        }
      })
      if (ownedGeneration !== generation) {
        throw new Error('Desktop Host connection was cancelled.')
      }
      if (handshakeCapabilities === null) {
        throw new Error('Desktop Host handshake did not advertise capabilities.')
      }
      if (pairingCode !== null) {
        const paired = await nextClient.pair(pairingCode)
        if (ownedGeneration !== generation) throw new Error('Desktop Host connection was cancelled.')
        cachedCredential = paired.credential
        await credentialStore.save(paired.credential)
        hasStoredCredential = true
        nextCapabilities = paired.capabilities
      } else {
        const stored = cachedCredential ?? await credentialStore.load()
        if (ownedGeneration !== generation) throw new Error('Desktop Host connection was cancelled.')
        if (stored === null) {
          throw new Error('No stored Desktop Host credential is available. Generate a new pairing code on Linux.')
        }
        cachedCredential = stored
        nextClient.setCredential(stored)
        nextCapabilities = handshakeCapabilities
      }
      if (ownedGeneration !== generation) {
        throw new Error('Desktop Host connection was cancelled.')
      }
      const nextControllerId = randomUUID()
      nextStream = await nextClient.openEventStream(nextControllerId, (event) => {
        if (!attemptActive || ownedGeneration !== generation) return
        options.onEvent(event)
      })
      const streamClosed = (caught: unknown): void => {
        streamFailure = caught
        if (client === nextClient) recover(ownedGeneration, caught)
      }
      void nextStream.closed.then(
        () => streamClosed(new DesktopHostClientError('Desktop Host event stream closed.', 'network')),
        streamClosed
      )
      const nextSnapshot = await nextClient.getState(nextControllerId)
      if (ownedGeneration !== generation) {
        throw new Error('Desktop Host connection was cancelled.')
      }
      if (streamFailure !== null) throw streamFailure
      if (nextTunnel.connectionSignal.aborted) throw new DesktopHostClientError('SSH connection closed during synchronization.', 'network')
      await hostConfigStore.save(config)
      if (ownedGeneration !== generation) throw new Error('Desktop Host connection was cancelled.')
      if (streamFailure !== null) throw streamFailure
      if (nextTunnel.connectionSignal.aborted) throw new DesktopHostClientError('SSH connection closed during synchronization.', 'network')
      lastHost = config
      tunnel = nextTunnel
      client = nextClient
      stream = nextStream
      capabilities = nextCapabilities
      controllerId = nextControllerId
      error = null
      failureKind = null
      recovery = null
      phase = 'connected'
      autoResumeArmed = true
      publishStatus()
      void nextTunnel.termination.then((termination) => {
        if (termination.expected) return
        recover(ownedGeneration, new DesktopHostClientError(
          termination.error ?? 'SSH connection was interrupted.', 'network'
        ))
      })
      options.onEvent({
        type: 'kernel.state-changed',
        revision: nextSnapshot.revision,
        state: nextSnapshot.state
      })
      return nextSnapshot
    } catch (caught) {
      if (caught instanceof SystemSshStartupCleanupError) nextTunnel = caught.tunnel
      attemptActive = false
      nextClient.clearCredential()
      if (ownedGeneration === generation && isUnauthorizedDesktopHostError(caught)) {
        cachedCredential = null
        hasStoredCredential = false
      }
      const results = await Promise.allSettled([
        nextStream !== stream ? nextStream?.close() : undefined,
        nextTunnel !== tunnel ? nextTunnel?.stop() : undefined,
        ownedGeneration === generation && isUnauthorizedDesktopHostError(caught) ? credentialStore.clear() : undefined
      ])
      if (results[1]?.status === 'rejected') tunnel = nextTunnel
      const cleanupErrors = results.filter((result) => result.status === 'rejected').map((result) => result.reason)
      if (cleanupErrors.length > 0) throw new AggregateError([caught, ...cleanupErrors], 'Desktop Host connection failed and cleanup was incomplete.')
      throw caught
    }
  }

  const establish = (config: WindowsRemoteHostConfig, pairingCode: string | null, ownedGeneration: number): Promise<KernelSnapshot> => {
    const pending = establishConnection(config, pairingCode, ownedGeneration)
    establishment = pending
    const settled = (): void => { if (establishment === pending) establishment = null }
    void pending.then(settled, settled)
    return pending
  }

  const failClosed = async (ownedGeneration: number, cause: unknown): Promise<void> => {
    if (ownedGeneration !== generation || phase !== 'connected') return
    const resumeGeneration = ++generation
    const resumeHost = autoResumeArmed && hasStoredCredential ? lastHost : null
    autoResumeArmed = false
    const cancellation = new AbortController()
    recoveryController = cancellation
    capabilities = null
    phase = 'reconnecting'
    error = unknownErrorMessage(cause)
    failureKind = connectionFailureKind(cause)
    publishStatus()
    try {
      await cleanup()
      if (resumeGeneration !== generation) return
      if (resumeHost === null || failureKind !== 'network') throw cause
      for (const [index, delayMs] of RECONNECT_DELAYS_MS.entries()) {
        recovery = { attempt: index + 1, maxAttempts: RECONNECT_DELAYS_MS.length, delayMs }
        publishStatus()
        if (delayMs > 0) await waitForRetry(delayMs, cancellation.signal)
        if (resumeGeneration !== generation) return
        if (delayMs > 0) {
          recovery = { ...recovery, delayMs: 0 }
          publishStatus()
        }
        try {
          await establish(resumeHost, null, resumeGeneration)
          return
        } catch (caught) {
          if (resumeGeneration !== generation) return
          error = unknownErrorMessage(caught)
          failureKind = connectionFailureKind(caught)
          // Unknown, auth, protocol and cleanup failures require user action.
          if (failureKind !== 'network' || index === RECONNECT_DELAYS_MS.length - 1) throw caught
        }
      }
    } catch (caught) {
      if (resumeGeneration !== generation) return
      phase = 'disconnected'
      error = unknownErrorMessage(caught)
      failureKind = connectionFailureKind(caught)
      capabilities = null
      publishStatus()
    } finally {
      if (recoveryController === cancellation) recoveryController = null
    }
  }

  const recover = (ownedGeneration: number, cause: unknown): void => {
    if (ownedGeneration !== generation || phase !== 'connected') return
    const pending = failClosed(ownedGeneration, cause)
    recoveryWork = pending
    void pending.then(() => { if (recoveryWork === pending) recoveryWork = null })
  }

  const endConnection = (revoke: boolean, expectedHost?: WindowsRemoteHostConfig): Promise<void> => {
    if (ending !== null) return revoke ? Promise.reject(new Error('Host 连接操作正在收尾，请等待完成。')) : ending
    if (revoke && (phase !== 'connected' || client === null || lastHost === null ||
      expectedHost?.sshHostAlias !== lastHost.sshHostAlias || expectedHost.localPort !== lastHost.localPort ||
      expectedHost.desktopHostPort !== lastHost.desktopHostPort)) {
      return Promise.reject(new Error('请连接并核对目标 Host 后再取消配对。'))
    }
    generation += 1
    const pendingCheck = hostCheck
    pendingCheck?.controller.abort()
    recoveryController?.abort()
    autoResumeArmed = false
    const activeClient = client
    phase = revoke ? 'revoking' : 'disconnecting'
    capabilities = null
    error = null
    failureKind = null
    recovery = null
    publishStatus()
    const pending = (async () => {
      const failures: unknown[] = []
      // Cancelled attempts still own their temporary resources until they settle.
      // Their connection errors go to their original callers; final cleanup below
      // retries retained resources and determines whether termination succeeded.
      await Promise.allSettled([pendingCheck?.done, establishment, connectionCleanup, recoveryWork])
      if (revoke) {
        let revoked = false
        try {
          await activeClient!.logout()
          revoked = true
        } catch (cause) {
          failures.push(new Error('取消配对的结果未确认，本地凭证已保留。请在目标 Host 检查配对状态。', { cause }))
        }
        if (revoked) {
          cachedCredential = null
          try {
            await credentialStore.clear()
            hasStoredCredential = false
          } catch (cause) {
            failures.push(new Error('Host 已取消配对，但 Windows 中的凭证删除失败。请处理凭证存储错误。', { cause }))
          }
        }
      }
      try { await cleanup() } catch (cause) { failures.push(cause) }
      phase = 'disconnected'
      if (failures.length > 0) {
        error = failures.map(unknownErrorMessage).join('\n')
        failureKind = 'unknown'
      }
      publishStatus()
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, error!)
    })()
    ending = pending
    const settled = (): void => { if (ending === pending) ending = null }
    void pending.then(settled, settled)
    return pending
  }

  return {
    status: currentStatus,
    async checkHost(operationId, request) {
      if (!/^[A-Za-z0-9_-]{1,128}$/u.test(operationId)) throw new Error('Invalid Host check operation ID.')
      if (phase !== 'disconnected' || hostCheck !== null || ending !== null) throw new Error('请先结束当前连接或检查。')
      if (tunnel !== null) throw new Error('上次 SSH 进程尚未释放，请先关闭连接再检查。')
      const config = parseWindowsRemoteHostConfig(request)
      const ownedGeneration = ++generation
      const controller = new AbortController()
      phase = 'checking'
      error = null
      failureKind = null
      recovery = null
      publishStatus()
      const done = runDesktopHostCheck({
        config, compatibility: { productVersion: options.productVersion, buildCommit: options.buildCommit },
        signal: controller.signal, startTunnel, createClient, checkPort: options.checkLocalPort
      }).then(({ result, retainedTunnel }) => {
        tunnel = retainedTunnel
        return result
      }).finally(() => {
        if (hostCheck?.controller === controller) hostCheck = null
        if (ownedGeneration === generation) {
          phase = 'disconnected'
          publishStatus()
        }
      })
      hostCheck = { operationId, controller, done }
      return done
    },
    async cancelHostCheck(operationId) {
      if (hostCheck?.operationId !== operationId) return
      const active = hostCheck
      active.controller.abort()
      await active.done
    },
    close: () => endConnection(false),
    async connect(request) {
      if (phase === 'checking' || phase === 'connecting' || phase === 'reconnecting' || phase === 'disconnecting' || phase === 'revoking' || hostCheck !== null || ending !== null) {
        throw new Error('A Desktop Host connection is already in progress.')
      }
      if (phase === 'connected') {
        throw new Error('Disconnect before connecting to another Desktop Host.')
      }
      const parsed = parseWindowsRemoteConnectRequest(request)
      const pairingCode = parsed.pairingCode ?? null
      if (pairingCode === null && !hasStoredCredential) {
        throw new Error('A 6-digit Desktop Host pairing code is required when no credential is stored.')
      }
      const config = {
        sshHostAlias: parsed.sshHostAlias,
        localPort: parsed.localPort,
        desktopHostPort: parsed.desktopHostPort
      }
      phase = 'connecting'
      error = null
      failureKind = null
      recovery = null
      publishStatus()
      const ownedGeneration = ++generation
      try {
        if (tunnel !== null) {
          const pending = cleanup()
          connectionCleanup = pending
          try { await pending } finally { if (connectionCleanup === pending) connectionCleanup = null }
        }
        if (ownedGeneration !== generation) throw new Error('Desktop Host connection was cancelled.')
        return await establish(config, pairingCode, ownedGeneration)
      } catch (caught) {
        if (ownedGeneration === generation) {
          phase = 'disconnected'
          error = unknownErrorMessage(caught)
          failureKind = connectionFailureKind(caught)
          capabilities = null
          await cleanup()
          publishStatus()
        }
        throw caught
      }
    },
    disconnect: () => endConnection(false),
    revokePairing: (config) => endConnection(true, parseWindowsRemoteHostConfig(config)),
    async dispatch(command, expectedIdentity) {
      if (phase !== 'connected' || client === null || controllerId === null) {
        throw new Error('Desktop Host is not connected.')
      }
      if (!isDesktopHostKernelCommand(command) && !isDesktopHostGitCommand(command) && !isDesktopAttachmentCommand(command)) {
        throw new Error('This command is not available on the Windows remote-only client.')
      }
      if (isDesktopHostGitCommand(command) && !capabilities?.gitCommandTypes?.includes(command.type)) {
        throw new Error('Desktop Host does not advertise this Git command.')
      }
      if (isDesktopAttachmentCommand(command) && !capabilities?.attachmentCommandTypes?.includes(command.type)) {
        throw new Error('Desktop Host does not advertise this attachment command.')
      }
      if (isDesktopHostKernelCommand(command) && commandHasLocalAttachments(command)) {
        throw new Error('Windows remote-only client does not send local file attachments.')
      }
      if (command.type === 'kernel.get-state') {
        const ownedGeneration = generation
        const current = await client.getState(controllerId)
        if (generation !== ownedGeneration) throw new Error('Desktop Host connection changed while reading state.')
        return current
      }
      if (!isDesktopHostControlIdentity(expectedIdentity)) {
        throw new Error('Desktop command requires the session identity observed by the Renderer.')
      }
      const ownedGeneration = generation
      const value = await client.command(controllerId, expectedIdentity, command)
      if (generation !== ownedGeneration) throw new Error('Desktop Host connection changed while executing the command.')
      return value
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

function isUnauthorizedDesktopHostError(error: unknown): boolean {
  return error instanceof DesktopHostClientError &&
    (error.code === 'unauthorized' || error.status === 401)
}

function connectionFailureKind(error: unknown): DesktopConnectionFailureKind {
  if (error instanceof SystemSshTunnelError) return error.kind === 'authentication' ? 'ssh-authentication' : error.kind
  if (error instanceof DesktopHostClientError) {
    if (error.code === 'credential-target') return 'credential-target'
    if (error.code === 'unauthorized' || error.status === 401) return 'authentication'
    if (error.code === 'protocol') return 'protocol'
    if (error.code === 'network' || error.code === 'unavailable' ||
      (error.code === 'http' && error.status !== null && [502, 503, 504].includes(error.status))) return 'network'
  }
  return 'unknown'
}

function unknownErrorMessage(error: unknown): string {
  if (error instanceof AggregateError) {
    return `${error.message} ${error.errors.map(unknownErrorMessage).join(' ')}`.slice(0, 8_192)
  }
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
