import type { RemoteKernelCommand } from '../../shared/remote-contract.ts'
import type { WorkbenchKernel } from '../kernel/workbench-kernel.ts'

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
