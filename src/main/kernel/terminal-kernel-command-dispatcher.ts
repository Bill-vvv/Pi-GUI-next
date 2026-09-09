import type { ProjectStore } from '../project/project-store.ts'
import type { RemoteKernelCommand } from '../../shared/remote-contract.ts'
import type { WorkbenchKernel } from './workbench-kernel.ts'

export type TerminalKernelCommandContext = {
  kernel: WorkbenchKernel
  projectStore: ProjectStore
  assertCurrentPolicy?: () => Promise<void>
}

/**
 * Shared Main dispatcher for the remote-allowlisted terminal command subset.
 * Local IPC and the remote gateway both invoke this for those command types.
 */
export async function dispatchTerminalKernelCommand(
  command: RemoteKernelCommand,
  context: TerminalKernelCommandContext
): Promise<unknown> {
  const { kernel, projectStore } = context
  await context.assertCurrentPolicy?.()
  switch (command.type) {
    case 'kernel.get-state':
      return kernel.getSnapshot()
    case 'kernel.activate-project': {
      const projectPath = await projectStore.validateProjectPath(command.projectKey)
      if (projectPath !== command.projectKey) {
        throw new Error(`Registered project path no longer resolves canonically: ${command.projectKey}`)
      }
      await context.assertCurrentPolicy?.()
      await kernel.activateProject(projectPath, await projectStore.loadSessionRegistry(projectPath))
      return kernel.acknowledge()
    }
    case 'kernel.start-session': {
      const state = kernel.getState()
      const project = configuredProject(state)
      const canonicalPath = await projectStore.validateProjectPath(project.path)
      if (canonicalPath !== project.path) {
        throw new Error(`Active Runtime workspace path no longer resolves canonically: ${project.path}`)
      }
      await context.assertCurrentPolicy?.()
      if (
        context.assertCurrentPolicy !== undefined &&
        kernel.getState().activeProjectKey !== project.path
      ) {
        throw new Error('Active Project changed while the remote Session start was being prepared.')
      }
      if (project.workspaceKind === 'task') {
        const activeSummary = state.activeSessionKey === null
          ? null
          : state.sessions.find(({ key }) => key === state.activeSessionKey) ?? null
        const emptyProvisional = activeSummary?.provisional === true &&
          !(project.sessions ?? []).some(({ key }) => key === activeSummary.key)
        if (!emptyProvisional && (
          state.activeSessionKey !== null ||
          await projectStore.taskOwnsSession(project.path)
        )) {
          throw new Error('A Task already owns its Session; create another Task instead.')
        }
      }
      await kernel.start()
      return kernel.acknowledge()
    }
    case 'kernel.reload-session':
      await kernel.reloadSession()
      return kernel.acknowledge()
    case 'kernel.activate-session': {
      const projectPath = kernel.getActiveProjectPath()
      const canonicalPath = await projectStore.validateProjectPath(projectPath)
      if (canonicalPath !== projectPath) {
        throw new Error(`Active project path no longer resolves canonically: ${projectPath}`)
      }
      await context.assertCurrentPolicy?.()
      if (
        context.assertCurrentPolicy !== undefined &&
        kernel.getActiveProjectPath() !== projectPath
      ) {
        throw new Error('Active Project changed while the remote Session activation was being prepared.')
      }
      await kernel.activateSession(
        command.sessionKey,
        () => projectStore.loadSessionRegistry(projectPath)
      )
      return kernel.acknowledge()
    }
    case 'kernel.load-earlier-conversation':
      return kernel.loadEarlierConversation(command.request)
    case 'kernel.get-message-image':
      return kernel.getMessageImage(
        command.sessionKey,
        command.messageId,
        command.attachmentIndex
      )
    case 'kernel.get-tool-image':
      return kernel.getToolImage(
        command.sessionKey,
        command.toolCallId,
        command.contentIndex
      )
    case 'kernel.submit-ask':
      await kernel.submitAsk(command.sessionKey, command.toolCallId, command.answers)
      return kernel.acknowledge()
    case 'kernel.cancel-ask':
      await kernel.cancelAsk(command.sessionKey, command.toolCallId)
      return kernel.acknowledge()
    case 'kernel.respond-extension-dialog':
      await kernel.respondExtensionDialog(
        command.projectKey,
        command.sessionKey,
        command.sessionId,
        command.requestId,
        command.commandInvocationId,
        command.value
      )
      return kernel.acknowledge()
    case 'kernel.cancel-extension-dialog':
      await kernel.cancelExtensionDialog(
        command.projectKey,
        command.sessionKey,
        command.sessionId,
        command.requestId,
        command.commandInvocationId
      )
      return kernel.acknowledge()
    case 'kernel.prompt':
      await kernel.prompt(command.message, command.attachments, command.expectedSessionKey)
      return kernel.acknowledge()
    case 'kernel.steer':
      await kernel.steer(command.message, command.attachments)
      return kernel.acknowledge()
    case 'kernel.follow-up':
      await kernel.followUp(command.message, command.attachments)
      return kernel.acknowledge()
    case 'kernel.abort':
      await kernel.abort()
      return kernel.acknowledge()
    case 'kernel.set-model':
      await kernel.setModel(command.provider, command.modelId)
      return kernel.acknowledge()
    case 'kernel.set-thinking-level':
      await kernel.setThinkingLevel(command.level)
      return kernel.acknowledge()
    case 'kernel.set-openai-fast-mode':
      await kernel.setOpenAiFastMode(command.enabled)
      return kernel.acknowledge()
  }
  const exhaustive: never = command
  throw new Error(`Unsupported terminal Kernel command: ${JSON.stringify(exhaustive)}`)
}

function configuredProject(state: {
  projects: Array<{
    path: string
    workspaceKind?: 'project' | 'task'
    taskKey?: string
    sessions?: Array<{ key: string }>
  }>
  activeProjectKey: string | null
}): {
  path: string
  workspaceKind?: 'project' | 'task'
  taskKey?: string
  sessions?: Array<{ key: string }>
} {
  if (state.activeProjectKey === null) throw new Error('Select a Project or Task before starting.')
  const project = state.projects.find(({ path }) => path === state.activeProjectKey)
  if (project === undefined) throw new Error('Active Runtime workspace is not registered.')
  return project
}
