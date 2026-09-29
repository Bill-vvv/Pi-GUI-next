import { DesktopAttachmentStore, DesktopAttachmentError } from '../remote/desktop-attachment-store.ts'
import { join } from 'node:path'

import { type KernelEvent } from '../../shared/kernel-contract.ts'
import { type DesktopHostControlIdentity } from '../../shared/desktop-host-contract.ts'
import {
  type DesktopHostAccessStatus,
  type RemoteAccessStatus,
  type RemoteAdminCommand,
  type RemotePairingCode,
  type TailscaleRemoteMode,
  type TailscaleRemoteStatus
} from '../../shared/remote-admin-contract.ts'
import { isRemoteKernelCommand, type RemoteKernelCommand } from '../../shared/remote-contract.ts'
import { GitCapabilityController } from '../git/git-capability-controller.ts'
import { isKernelCommand } from '../kernel/kernel-command-validation.ts'
import { dispatchTerminalKernelCommand } from '../kernel/terminal-kernel-command-dispatcher.ts'
import { WorkbenchKernel } from '../kernel/workbench-kernel.ts'
import { assertRemoteKernelCommandPolicy, assertDesktopHostKernelCommandPolicy } from '../remote/remote-command-policy.ts'
import { loadDesktopHostConfig } from '../remote/desktop-host-config.ts'
import { startDesktopHostGateway, type DesktopHostGateway } from '../remote/desktop-host-gateway.ts'
import { loadRemoteConfig, readRemoteTokenFile, type RemoteEnabledConfig } from '../remote/remote-config.ts'
import { openRemoteDeviceStore, type RemoteDeviceStore } from '../remote/remote-device-store.ts'
import { openDesktopDeviceStore } from '../remote/desktop-device-store.ts'
import { startRemoteGateway, type RemoteGateway, type RemoteGatewayHandlers } from '../remote/remote-gateway.ts'
import {
  createTailscaleRemoteGatewayConfig,
  openTailscaleRemoteManager,
  type TailscaleRemoteManager
} from '../remote/tailscale-remote.ts'
import { readPromptAttachments } from '../prompt/prompt-attachment-selection.ts'
import { ProjectStore } from '../project/project-store.ts'
import { errorMessage } from '../utils/errors.ts'
import type { JsonlLogger } from '../utils/jsonl-log.ts'


export type RemoteAccessOptions = {
  kernel: WorkbenchKernel
  projectStore: ProjectStore
  gitController: GitCapabilityController
  /** Private per-user data directory (Electron userData on the desktop). */
  userDataDirectory: string
  /** Built Web Remote static files. */
  remoteStaticRoot: string
  productVersion: string
  resolveBuildCommit: () => string | null
  logger: JsonlLogger
}

export type RemoteAccess = {
  publish(event: KernelEvent): void
  dispatchRemoteAdminCommand(
    command: RemoteAdminCommand
  ): Promise<RemoteAccessStatus | DesktopHostAccessStatus | RemotePairingCode | TailscaleRemoteStatus>
  /** The Desktop Host gateway when enabled; its device functions serve the Settings page and the Host CLI (D-095). */
  desktopHost(): DesktopHostGateway | null
  stop(): Promise<void>
}

/**
 * Web Remote, Tailscale one-click Remote and the Desktop Host gateway with its attachment store
 * (moved from main/index.ts so the Host assembly does not depend on Electron, D-095).
 */
export async function startRemoteAccess(options: RemoteAccessOptions): Promise<RemoteAccess> {
  const { kernel, projectStore, gitController } = options
  let remoteGateway: RemoteGateway | null = null
  let remoteGatewaySource: 'manual' | 'tailscale' | null = null
  let remoteGatewayCleanupError: Error | null = null
  let remoteGatewayHandlers: RemoteGatewayHandlers | null = null
  let tailscaleRemoteManager: TailscaleRemoteManager | null = null
  let desktopHostGateway: DesktopHostGateway | null = null
  let desktopAttachmentStore: DesktopAttachmentStore | null = null
  let remoteDeviceStore: RemoteDeviceStore | null = null
  let tailscaleRemoteMutationDrain: Promise<void> = Promise.resolve()

  const assertRemoteCommandPolicy = async (command: RemoteKernelCommand): Promise<void> => {
    const activeKernel = kernel
    if (activeKernel === null) throw new Error('Workbench kernel is unavailable.')
    await assertRemoteKernelCommandPolicy(command, { kernel: activeKernel })
  }
  const dispatchRemoteCommand = async (
    command: RemoteKernelCommand,
    assertCurrentBoundary?: () => Promise<void>
  ): Promise<unknown> => {
    const activeKernel = kernel
    if (activeKernel === null) throw new Error('Workbench kernel is unavailable.')
    const result = await dispatchTerminalKernelCommand(command, {
      kernel: activeKernel,
      projectStore,
      assertCurrentPolicy: async () => {
        await assertCurrentBoundary?.()
        await assertRemoteKernelCommandPolicy(command, { kernel: activeKernel })
      }
    })
    if (command.type !== 'kernel.activate-project') return result
    await activeKernel.refreshWorkspaceMetadata(command.projectKey)
    return activeKernel.acknowledge()
  }

  remoteGatewayHandlers = {
    assertCommandPolicy: assertRemoteCommandPolicy,
    dispatchCommand: dispatchRemoteCommand
  }

  const uid = process.getuid?.()
  if (uid !== undefined) {
    tailscaleRemoteManager = await openTailscaleRemoteManager({
      configPath: join(options.userDataDirectory, 'tailscale-remote.json'),
      tokenFile: join(options.userDataDirectory, 'tailscale-remote.token'),
      uid
    })
  }

  const remoteConfig = await loadRemoteConfig(process.env)
  const managedTailscaleConfig = tailscaleRemoteManager?.getManagedConfig() ?? null
  if (remoteConfig.enabled && managedTailscaleConfig !== null) {
    throw new Error('Manual Remote and Tailscale one-click Remote cannot be enabled together.')
  }
  if (remoteConfig.enabled) {
    await startApplicationRemoteGateway(remoteConfig, 'manual')
  } else if (managedTailscaleConfig !== null) {
    if (uid === undefined || tailscaleRemoteManager === null) {
      throw new Error('Tailscale Remote ownership can only be verified when process.getuid is available.')
    }
    const prepared = await tailscaleRemoteManager.prepareEnable(managedTailscaleConfig.mode)
    const token = await readRemoteTokenFile(tailscaleRemoteManager.tokenFile, uid)
    await startApplicationRemoteGateway(
      createTailscaleRemoteGatewayConfig({
        publicOrigin: prepared.publicOrigin,
        port: managedTailscaleConfig.port,
        token,
        tokenFile: tailscaleRemoteManager.tokenFile
      }),
      'tailscale'
    )
    await tailscaleRemoteManager.activate(prepared, managedTailscaleConfig.port)
  }

  const desktopHostConfig = await loadDesktopHostConfig(process.env)
  if (desktopHostConfig.enabled) {
    const uid = process.getuid?.()
    if (uid === undefined) {
      throw new Error(
        'Desktop Host device store ownership can only be verified when process.getuid is available.'
      )
    }
    // R12: Desktop uses the bounded version-2 collection; a version-1 file is migrated atomically.
    const desktopHostDeviceStore = await openDesktopDeviceStore({
      path: desktopHostConfig.deviceStorePath,
      uid
    })
    const attachmentStore = new DesktopAttachmentStore({
      root: join(options.userDataDirectory, 'desktop-attachments'),
      materialize: (path) => readPromptAttachments([path])
    })
    await attachmentStore.start()
    desktopAttachmentStore = attachmentStore
    desktopHostGateway = await startDesktopHostGateway({
      config: desktopHostConfig,
      productVersion: options.productVersion,
      buildCommit: await options.resolveBuildCommit(),
      logger: options.logger,
      deviceStore: desktopHostDeviceStore,
      handlers: {
        getControlIdentity: (): DesktopHostControlIdentity => {
          const activeKernel = kernel
          if (activeKernel === null) throw new Error('Workbench kernel is unavailable.')
          const state = activeKernel.getState()
          return {
            projectKey: state.activeProjectKey,
            sessionKey: state.activeSessionKey
          }
        },
        dispatchGitCommand: (command, boundary) => gitController.dispatch(command, undefined, boundary),
        dispatchAttachmentCommand: async (command, owner, boundary) => {
          const activeKernel = kernel
          if (activeKernel === null) throw new Error('Workbench kernel is unavailable.')
          const assertAttachmentBoundary = async (): Promise<void> => {
            await boundary()
            const state = activeKernel.getState()
            if (!state.projects.some((project) => project.path === owner.projectKey && project.workspaceKind !== 'task')) {
              throw new DesktopAttachmentError('Attachments require an active registered Project.')
            }
            await assertDesktopHostKernelCommandPolicy({ type: 'kernel.steer', message: '' }, { kernel: activeKernel })
          }
          return attachmentStore.dispatch(command, owner, assertAttachmentBoundary, async (submission, assertCurrentBoundary) => {
            if (!isKernelCommand(submission) || (submission.type !== 'kernel.prompt' && submission.type !== 'kernel.steer' && submission.type !== 'kernel.follow-up')) {
              throw new DesktopAttachmentError('Invalid materialized attachment submission.')
            }
            const { attachments: _attachments, ...policyCommand } = submission
            return dispatchTerminalKernelCommand(submission, {
              kernel: activeKernel, projectStore,
              assertCurrentPolicy: async () => {
                await assertCurrentBoundary()
                await assertDesktopHostKernelCommandPolicy(policyCommand, { kernel: activeKernel })
              }
            })
          })
        },
        assertCommandPolicy: async (command) => {
          if (kernel === null) throw new Error('Workbench kernel is unavailable.')
          await assertDesktopHostKernelCommandPolicy(command, { kernel })
        },
        dispatchCommand: async (command, assertCurrentBoundary) => {
          if (isRemoteKernelCommand(command)) return dispatchRemoteCommand(command, assertCurrentBoundary)
          const activeKernel = kernel
          if (activeKernel === null) throw new Error('Workbench kernel is unavailable.')
          return dispatchTerminalKernelCommand(command, {
            kernel: activeKernel, projectStore,
            assertCurrentPolicy: async () => {
              await assertCurrentBoundary?.()
              await assertDesktopHostKernelCommandPolicy(command, { kernel: activeKernel })
            }
          })
        }
      }
    })
    console.info(
      `[Pi GUI] Desktop Host gateway listening on ` +
      `${desktopHostConfig.bindHost}:${desktopHostConfig.port}`
    )
  }

  async function startApplicationRemoteGateway(
    config: RemoteEnabledConfig,
    source: 'manual' | 'tailscale'
  ): Promise<void> {
    if (remoteGateway !== null) throw new Error('Remote gateway is already running.')
    const handlers = remoteGatewayHandlers
    if (handlers === null) throw new Error('Remote gateway handlers are unavailable.')
    const uid = process.getuid?.()
    if (uid === undefined) {
      throw new Error('Remote device store ownership can only be verified when process.getuid is available.')
    }
    const deviceStore = await openRemoteDeviceStore({
      path: config.deviceStorePath,
      uid
    })
    const gateway = await startRemoteGateway({
      config,
      staticRoot: options.remoteStaticRoot,
      logger: options.logger,
      deviceStore,
      handlers
    })
    remoteDeviceStore = deviceStore
    remoteGateway = gateway
    remoteGatewaySource = source
    remoteGatewayCleanupError = null
    console.info(
      `[Pi GUI] Remote gateway listening on ${gateway.bindHost}:${gateway.port}`
    )
  }

  async function runTailscaleRemoteMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = tailscaleRemoteMutationDrain.then(operation, operation)
    tailscaleRemoteMutationDrain = run.then(
      () => undefined,
      () => undefined
    )
    return await run
  }

  async function enableTailscaleRemote(
    mode: Exclude<TailscaleRemoteMode, 'off'>
  ): Promise<TailscaleRemoteStatus> {
    const manager = tailscaleRemoteManager
    if (manager === null) {
      throw new Error('Tailscale one-click Remote is unavailable on this platform.')
    }
    if (remoteGatewaySource === 'manual') {
      throw new Error('Manual Remote is already enabled; disable it before using Tailscale one-click Remote.')
    }
    if (remoteGatewayCleanupError !== null) {
      throw new Error(
        `A previous Remote gateway cleanup failed; restart Pi GUI before retrying: ${remoteGatewayCleanupError.message}`
      )
    }

    const prepared = await manager.prepareEnable(mode)
    if (remoteGateway === null) {
      const token = await manager.ensureToken()
      try {
        await startApplicationRemoteGateway(
          createTailscaleRemoteGatewayConfig({
            publicOrigin: prepared.publicOrigin,
            port: 0,
            token,
            tokenFile: manager.tokenFile
          }),
          'tailscale'
        )
      } catch (error) {
        await manager.discardTokenIfUnconfigured()
        throw error
      }
    }

    const gateway = remoteGateway
    if (gateway === null || remoteGatewaySource !== 'tailscale') {
      throw new Error('Tailscale Remote gateway did not start.')
    }
    try {
      return await manager.activate(prepared, gateway.port)
    } catch (error) {
      if (manager.getManagedConfig() === null) {
        const cleanupErrors: unknown[] = []
        try {
          await gateway.stop()
        } catch (cleanupError) {
          remoteGatewayCleanupError = cleanupError instanceof Error
            ? cleanupError
            : new Error(String(cleanupError))
          cleanupErrors.push(remoteGatewayCleanupError)
        }
        if (cleanupErrors.length === 0) {
          remoteGateway = null
          remoteGatewaySource = null
          remoteDeviceStore = null
          try {
            await manager.discardTokenIfUnconfigured()
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError)
          }
        }
        if (cleanupErrors.length > 0) {
          throw new AggregateError(
            [error, ...cleanupErrors],
            `Tailscale Remote activation failed: ${errorMessage(error)}; ` +
            `cleanup failed: ${cleanupErrors.map(errorMessage).join('; ')}`
          )
        }
      }
      throw error
    }
  }

  async function disableTailscaleRemote(): Promise<TailscaleRemoteStatus> {
    const manager = tailscaleRemoteManager
    if (manager === null) {
      throw new Error('Tailscale one-click Remote is unavailable on this platform.')
    }
    if (remoteGatewaySource === 'manual') {
      throw new Error('Manual Remote is not managed by the Tailscale one-click controls.')
    }
    if (remoteGatewayCleanupError !== null) {
      throw new Error(
        `A previous Remote gateway cleanup failed; restart Pi GUI before retrying: ${remoteGatewayCleanupError.message}`
      )
    }
    const managedConfig = manager.getManagedConfig()
    if (managedConfig === null) return await manager.getStatus()

    const gateway = remoteGateway
    if (gateway === null || remoteGatewaySource !== 'tailscale') {
      throw new Error('Managed Tailscale Remote gateway is unavailable.')
    }

    await gateway.revokeDevice()
    await manager.disableRoute()
    remoteGateway = null
    remoteGatewaySource = null
    remoteDeviceStore = null
    await gateway.stop()
    await manager.clearManagedFiles()
    return await manager.getStatus()
  }

  async function dispatchRemoteAdminCommand(
    command: RemoteAdminCommand
  ): Promise<RemoteAccessStatus | DesktopHostAccessStatus | RemotePairingCode | TailscaleRemoteStatus> {
    switch (command.type) {
      case 'remote-admin.get-status': {
        const gateway = remoteGateway
        if (gateway === null) {
          return { enabled: false }
        }
        return gateway.getStatus()
      }
      case 'remote-admin.create-pairing-code': {
        const gateway = remoteGateway
        if (gateway === null) {
          throw new Error('Remote access is disabled.')
        }
        return gateway.createPairingCode()
      }
      case 'remote-admin.revoke-device': {
        const gateway = remoteGateway
        if (gateway === null) {
          throw new Error('Remote access is disabled.')
        }
        return await gateway.revokeDevice()
      }
      case 'remote-admin.get-tailscale-status': {
        const manager = tailscaleRemoteManager
        if (manager === null) {
          return {
            installed: false,
            backendState: null,
            dnsName: null,
            authUrl: null,
            managedMode: 'off',
            routeState: 'unavailable',
            publicOrigin: null
          }
        }
        return await manager.getStatus()
      }
      case 'remote-admin.enable-tailscale-funnel':
        return await runTailscaleRemoteMutation(() => enableTailscaleRemote('funnel'))
      case 'remote-admin.enable-tailscale-serve':
        return await runTailscaleRemoteMutation(() => enableTailscaleRemote('serve'))
      case 'remote-admin.disable-tailscale':
        return await runTailscaleRemoteMutation(disableTailscaleRemote)
      case 'remote-admin.get-desktop-host-status': {
        const gateway = desktopHostGateway
        return gateway === null ? { enabled: false } : gateway.getStatus()
      }
      case 'remote-admin.create-desktop-host-pairing-code': {
        const gateway = desktopHostGateway
        if (gateway === null) throw new Error('Desktop Host is disabled.')
        return gateway.createPairingCode()
      }
      case 'remote-admin.revoke-desktop-host-device': {
        const gateway = desktopHostGateway
        if (gateway === null) throw new Error('Desktop Host is disabled.')
        return await gateway.revokeDevice(command.deviceId)
      }
      default: {
        const exhaustive: never = command
        throw new Error(`Unsupported remote admin command: ${JSON.stringify(exhaustive)}`)
      }
    }
  }

  return {
    publish(event) {
      remoteGateway?.publish(event)
      desktopHostGateway?.publish(event)
    },
    dispatchRemoteAdminCommand,
    desktopHost: () => desktopHostGateway,
    async stop() {
      await tailscaleRemoteMutationDrain
      const gateway = remoteGateway
      const desktopGateway = desktopHostGateway
      remoteGateway = null
      remoteGatewaySource = null
      remoteGatewayCleanupError = null
      remoteGatewayHandlers = null
      desktopHostGateway = null
      remoteDeviceStore = null
      if (gateway !== null) await gateway.stop()
      if (desktopGateway !== null) await desktopGateway.stop()
      const attachmentStore = desktopAttachmentStore
      desktopAttachmentStore = null
      if (attachmentStore !== null) await attachmentStore.close()
    }
  }
}
