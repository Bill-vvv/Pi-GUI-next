import type { RemoteKernelCommand } from '../../shared/remote-contract.ts'
import { isRemoteKernelCommand } from '../../shared/remote-contract.ts'
import type { DesktopHostKernelCommand } from '../../shared/desktop-host-contract.ts'
import type { WorkbenchKernel } from '../kernel/workbench-kernel.ts'
import { assertAdaptedExtensionCommandArgument } from '../kernel/command-catalog.ts'

export class RemoteCommandPolicyError extends Error {
  readonly code = 'forbidden' as const

  constructor(message: string) {
    super(message)
    this.name = 'RemoteCommandPolicyError'
  }
}

export type RemoteCommandPolicyContext = {
  kernel: WorkbenchKernel
}

/** Desktop-only project discovery/registration does not widen the Web Remote surface. */
export async function assertDesktopHostKernelCommandPolicy(
  command: DesktopHostKernelCommand,
  context: RemoteCommandPolicyContext
): Promise<void> {
  if (isRemoteKernelCommand(command)) return assertRemoteKernelCommandPolicy(command, context)
  if (command.type === 'kernel.invoke-command') {
    const state = context.kernel.getState()
    const project = state.projects.find((entry) => entry.path === state.activeProjectKey)
    const descriptor = state.commands.find((entry) => entry.id === command.commandId)
    if (project === undefined || project.workspaceKind === 'task' ||
      descriptor?.source !== 'extension' || descriptor.sourceInfo === null) {
      throw new RemoteCommandPolicyError('Desktop command invocation requires a registered Project and an adapted Extension command.')
    }
    if (command.commandId.length > 4_096 || command.argument.length > 16_000 || command.argument.includes('\0')) {
      throw new RemoteCommandPolicyError('Desktop Extension command argument exceeds its bounds.')
    }
    assertAdaptedExtensionCommandArgument(descriptor, command.argument)
    return
  }
  if (command.type === 'kernel.list-project-directories') return
  if (command.type === 'kernel.add-project') {
    if (command.projectPath === undefined) throw new RemoteCommandPolicyError('Desktop project selection requires an explicit Linux directory.')
    return
  }
  if (command.type === 'kernel.resolve-project-trust') {
    const state = context.kernel.getState()
    const request = state.projectTrustRequest
    if (request === null || request.id !== command.requestId ||
      !state.projects.some((project) => project.path === request.projectPath && project.workspaceKind !== 'task')) {
      throw new RemoteCommandPolicyError('Desktop project trust request is stale or not for a registered Project.')
    }
    return
  }
  const exhaustive: never = command
  throw new RemoteCommandPolicyError(`Unsupported desktop command: ${JSON.stringify(exhaustive)}`)
}

/**
 * Remote-only restrictions on top of isKernelCommand + isRemoteKernelCommand.
 * Local IPC does not apply these. The check is deliberately state-only and has
 * no internal await so Main can repeat it immediately before remote dispatch.
 */
export async function assertRemoteKernelCommandPolicy(
  command: RemoteKernelCommand,
  context: RemoteCommandPolicyContext
): Promise<void> {
  if (command.type === 'kernel.prompt') {
    if (
      typeof command.expectedSessionKey !== 'string' ||
      command.expectedSessionKey.length === 0
    ) {
      throw new RemoteCommandPolicyError('Remote prompt requires expectedSessionKey.')
    }
    if (command.attachments !== undefined) {
      throw new RemoteCommandPolicyError('Remote prompt does not allow attachments.')
    }
  }

  if (command.type === 'kernel.steer' || command.type === 'kernel.follow-up') {
    if (command.attachments !== undefined) {
      throw new RemoteCommandPolicyError(
        `Remote ${command.type.slice('kernel.'.length)} does not allow attachments.`
      )
    }
  }

  if (command.type === 'kernel.get-state') return

  const state = context.kernel.getState()
  if (command.type === 'kernel.activate-project') {
    const target = state.projects.find((project) => project.path === command.projectKey)
    if (target?.workspaceKind === 'task') {
      throw new RemoteCommandPolicyError('Remote activate-project rejects task workspaces.')
    }
    return
  }

  const active = state.activeProjectKey === null
    ? null
    : state.projects.find((project) => project.path === state.activeProjectKey) ?? null
  if (active?.workspaceKind === 'task') {
    throw new RemoteCommandPolicyError('Remote commands do not operate task workspaces.')
  }
}
