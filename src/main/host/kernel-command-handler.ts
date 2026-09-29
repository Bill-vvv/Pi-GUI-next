import { writeFile } from 'node:fs/promises'

import { MAGIC_CONTEXT_PACKAGE_NAME, SUBAGENT_PACKAGE_NAME } from '../../shared/kernel-contract.ts'
import { isDesktopHostKernelCommand } from '../../shared/desktop-host-contract.ts'
import { isRemoteKernelCommand } from '../../shared/remote-contract.ts'
import { PiExtensionStore } from '../extension/pi-extension-store.ts'
import { PiDevPackageService } from '../extension/pi-dev-package-service.ts'
import { createSessionExportHtml } from '../export/session-export-html.ts'
import { isKernelCommand } from '../kernel/kernel-command-validation.ts'
import { dispatchTerminalKernelCommand } from '../kernel/terminal-kernel-command-dispatcher.ts'
import { WorkbenchKernel } from '../kernel/workbench-kernel.ts'
import { readPromptAttachments } from '../prompt/prompt-attachment-selection.ts'
import { PiProviderStore } from '../provider/pi-provider-store.ts'
import { PiProviderAuth } from '../provider/pi-provider-auth.ts'
import { fetchLiteLlmModelPricing } from '../provider/litellm-model-pricing.ts'
import { testProviderConnection } from '../provider/provider-connection-test.ts'
import { ProjectStore } from '../project/project-store.ts'
import { searchProjectPaths } from '../project/project-path-search.ts'
import { listSystemFonts } from '../desktop/system-fonts.ts'
import { SubagentDefinitionStore } from '../subagent/subagent-definition-store.ts'


import type { KernelPiPackageInstallJob } from '../../shared/kernel-contract.ts'
import type { HostEnvironment, HostRequestEvent, RendererLifecycle } from './host-application.ts'

export type KernelCommandHandlerDependencies = {
  environment: Pick<HostEnvironment, 'desktop' | 'fetch' | 'userDataDirectory'>
  kernel: () => WorkbenchKernel | null
  projectStore: ProjectStore
  providerStore: PiProviderStore
  extensionStore: PiExtensionStore
  piDevPackageService: PiDevPackageService
  subagentDefinitionStore: SubagentDefinitionStore
  requireProviderAuth: () => PiProviderAuth
  startPackageInstall: (name: string) => void
  listPackageInstallJobs: () => KernelPiPackageInstallJob[]
  refreshSubagentPackageEnabled: () => Promise<void>
  setSubagentPackageEnabled: (enabled: boolean) => void
  pickOpenDirectory: () => Promise<string | null>
}

/**
 * The business handler of the Kernel command channel shared by local IPC and the WSL pipe
 * (moved unchanged from the Host assembly, D-095/D-098).
 */
export function createKernelCommandHandler(
  dependencies: KernelCommandHandlerDependencies
): (event: HostRequestEvent, command: unknown) => Promise<unknown> {
  const {
    environment,
    projectStore,
    providerStore,
    extensionStore,
    piDevPackageService,
    subagentDefinitionStore,
    requireProviderAuth,
    startPackageInstall,
    listPackageInstallJobs,
    refreshSubagentPackageEnabled,
    setSubagentPackageEnabled,
    pickOpenDirectory
  } = dependencies
  type StaticSessionPreviewOwner = {
    requestId: string
    sender: RendererLifecycle | null
    onInvalidated: () => void
  }
  let staticSessionPreviewOwner: StaticSessionPreviewOwner | null = null
  const releaseStaticSessionPreviewOwner = (
    owner: StaticSessionPreviewOwner,
    cancel: boolean
  ): void => {
    if (staticSessionPreviewOwner !== owner) return
    staticSessionPreviewOwner = null
    owner.sender?.removeListener('destroyed', owner.onInvalidated)
    owner.sender?.removeListener('render-process-gone', owner.onInvalidated)
    owner.sender?.removeListener('did-start-navigation', owner.onInvalidated)
    if (cancel) dependencies.kernel()?.cancelSessionPreview(owner.requestId)
  }
  const claimStaticSessionPreviewOwner = (
    requestId: string,
    sender: RendererLifecycle | null
  ): StaticSessionPreviewOwner => {
    const previous = staticSessionPreviewOwner
    if (previous !== null) releaseStaticSessionPreviewOwner(previous, false)
    const owner: StaticSessionPreviewOwner = {
      requestId,
      sender,
      onInvalidated: () => releaseStaticSessionPreviewOwner(owner, true)
    }
    staticSessionPreviewOwner = owner
    sender?.once('destroyed', owner.onInvalidated)
    sender?.once('render-process-gone', owner.onInvalidated)
    sender?.once('did-start-navigation', owner.onInvalidated)
    return owner
  }

  return async (event, command: unknown) => {
    const kernel = dependencies.kernel()
      if (!isKernelCommand(command)) {
        throw new Error('Unsupported kernel command.')
      }
      if (kernel === null) {
        throw new Error('Workbench kernel is unavailable.')
      }
      if (isRemoteKernelCommand(command) || isDesktopHostKernelCommand(command)) {
        return await dispatchTerminalKernelCommand(command, { kernel, projectStore, pickProjectDirectory: pickOpenDirectory })
      }
      switch (command.type) {
        case 'kernel.get-runtime-memory-diagnostics':
          return kernel.getRuntimeMemoryDiagnostics()
        case 'kernel.list-system-fonts':
          return listSystemFonts()
        case 'kernel.refresh-workspace-metadata':
          await kernel.refreshWorkspaceMetadata(command.workspaceKey)
          return kernel.acknowledge()
        case 'kernel.select-navigator': {
          if (command.kind === 'project') {
            const registry = await projectStore.loadProjects()
            if (registry.activeProjectKey === null) {
              await projectStore.selectNavigator('project')
              await kernel.selectEmptyNavigator('project')
            } else {
              await kernel.activateProject(
                registry.activeProjectKey,
                await projectStore.loadSessionRegistry(registry.activeProjectKey)
              )
            }
          } else {
            const registry = await projectStore.loadTasks()
            const task = registry.activeTaskKey === null
              ? null
              : registry.tasks.find(({ key }) => key === registry.activeTaskKey) ?? null
            const sessions = task === null
              ? null
              : await projectStore.loadSessionRegistry(task.path)
            if (task === null || sessions === null || sessions.activeSessionKey === null) {
              await projectStore.selectNavigator('task')
              await kernel.selectEmptyNavigator('task')
            } else {
              await kernel.activateTask(task.key, sessions)
            }
          }
          return kernel.acknowledge()
        }
        case 'kernel.create-task': {
          const state = kernel.getState()
          const activeWorkspace = state.activeProjectKey === null
            ? null
            : state.projects.find(({ path }) => path === state.activeProjectKey) ?? null
          const activeSession = state.activeSessionKey === null
            ? null
            : state.sessions.find(({ key }) => key === state.activeSessionKey) ?? null
          const emptyProvisionalTask = activeWorkspace?.workspaceKind === 'task' &&
            activeSession?.provisional === true &&
            !(activeWorkspace.sessions ?? []).some(({ key }) => key === activeSession.key)
          if (!emptyProvisionalTask) {
            const task = await projectStore.createTask()
            await kernel.addTask(
              { path: task.path, taskKey: task.key },
              await projectStore.loadSessionRegistry(task.path)
            )
          }
          return kernel.acknowledge()
        }
        case 'kernel.activate-task': {
          const registry = await projectStore.loadTasks()
          const task = registry.tasks.find(({ key }) => key === command.taskKey)
          if (task === undefined) throw new Error(`Task is not registered: ${command.taskKey}`)
          const canonicalPath = await projectStore.validateProjectPath(task.path)
          if (canonicalPath !== task.path) {
            throw new Error(`Task workspace path no longer resolves canonically: ${task.path}`)
          }
          await kernel.activateTask(task.key, await projectStore.loadSessionRegistry(task.path))
          return kernel.acknowledge()
        }
        case 'kernel.get-last-assistant-final-answer':
          return kernel.getLastAssistantFinalAnswer()
        case 'kernel.archive-session': {
          const project = configuredProject(kernel.getState())
          const receipt = await kernel.archiveSession(
            command.sessionKey,
            await projectStore.loadSessionRegistry(project.path)
          )
          return { ...kernel.acknowledge(), receipt }
        }
        case 'kernel.undo-archive-session':
          await kernel.undoArchiveSession(command.token)
          return kernel.acknowledge()
        case 'kernel.preview-session': {
          const owner = claimStaticSessionPreviewOwner(command.requestId, event?.sender ?? null)
          try {
            const projectPath = kernel.getActiveProjectPath()
            return await kernel.previewSession(
              command.sessionKey,
              command.requestId,
              () => projectStore.loadSessionRegistry(projectPath)
            )
          } catch (error) {
            releaseStaticSessionPreviewOwner(owner, true)
            throw error
          }
        }
        case 'kernel.complete-session-preview': {
          const owner = staticSessionPreviewOwner?.requestId === command.requestId
            ? staticSessionPreviewOwner
            : null
          try {
            return await kernel.completeSessionPreview(command.requestId)
          } finally {
            if (owner !== null) releaseStaticSessionPreviewOwner(owner, false)
          }
        }
        case 'kernel.cancel-session-preview': {
          const owner = staticSessionPreviewOwner?.requestId === command.requestId
            ? staticSessionPreviewOwner
            : null
          kernel.cancelSessionPreview(command.requestId)
          if (owner !== null) releaseStaticSessionPreviewOwner(owner, false)
          return
        }
        case 'kernel.load-earlier-session-preview': {
          const projectPath = kernel.getActiveProjectPath()
          return kernel.loadEarlierSessionPreview(
            command.request,
            () => projectStore.loadSessionRegistry(projectPath)
          )
        }
        case 'kernel.preview-archived-session':
          return kernel.previewArchivedSession(command.token)
        case 'kernel.list-fork-candidates':
          return kernel.listForkCandidates()
        case 'kernel.fork-session': {
          const result = await kernel.forkSession(command.entryId)
          return { ...kernel.acknowledge(), ...result }
        }
        case 'kernel.export-session': {
          if (command.filePath === undefined && environment.desktop === null) return { saved: false }
          const preparation = await kernel.prepareSessionExport()
          const targetPath = command.filePath ?? await environment.desktop!.pickSaveHtmlPath(preparation.title)
          if (targetPath === null) return { saved: false }
          const confirmed = await kernel.prepareSessionExport()
          if (!sameSessionExportIdentity(preparation, confirmed)) {
            throw new Error('Session export cancelled because the active session changed.')
          }
          await writeFile(
            targetPath,
            createSessionExportHtml({ title: confirmed.title, messages: confirmed.messages }),
            'utf8'
          )
          return { saved: true }
        }
        case 'kernel.search-project-paths': {
          const project = configuredUserProject(kernel.getState())
          const canonicalPath = await projectStore.validateProjectPath(project.path)
          if (canonicalPath !== project.path) {
            throw new Error(`Active project path no longer resolves canonically: ${project.path}`)
          }
          const matches = await searchProjectPaths({
            projectPath: canonicalPath,
            query: command.query
          })
          const confirmedPath = await projectStore.validateProjectPath(project.path)
          if (confirmedPath !== project.path) {
            throw new Error(`Active project path no longer resolves canonically: ${project.path}`)
          }
          if (kernel.getState().activeProjectKey !== project.path) {
            throw new Error('Project path search cancelled because the active project changed.')
          }
          return { projectKey: project.path, query: command.query, matches }
        }
        case 'kernel.reorder-projects':
          await kernel.reorderProjects(command.projectKeys)
          return kernel.acknowledge()
        case 'kernel.install-extension': {
          const selectedPath = command.path ?? await (environment.desktop?.pickExtensionPath(command.kind) ?? null)
          if (selectedPath === null) return kernel.acknowledge()
          kernel.setExtensions(await extensionStore.install(selectedPath))
          return kernel.acknowledge()
        }
        case 'kernel.remove-extension':
          kernel.setExtensions(await extensionStore.remove(command.path))
          return kernel.acknowledge()
        case 'kernel.search-pi-dev-extensions':
          return piDevPackageService.catalog(command.query, 'extension')
        case 'kernel.search-pi-dev-packages':
          return piDevPackageService.catalog(command.query)
        case 'kernel.list-pi-packages':
          return piDevPackageService.list()
        case 'kernel.list-pi-package-install-jobs':
          return listPackageInstallJobs()
        case 'kernel.install-pi-dev-package':
          startPackageInstall(command.name)
          return kernel.acknowledge()
        case 'kernel.remove-pi-package':
          await piDevPackageService.remove(command.source)
          await refreshSubagentPackageEnabled()
          return kernel.acknowledge()
        case 'kernel.set-subagent-enabled': {
          const packages = await piDevPackageService.setPackageExtensionEnabled(
            SUBAGENT_PACKAGE_NAME,
            command.enabled
          )
          setSubagentPackageEnabled(isSubagentPackageEnabled(packages))
          return packages
        }
        case 'kernel.set-magic-context-enabled':
          return piDevPackageService.setPackageExtensionEnabled(
            MAGIC_CONTEXT_PACKAGE_NAME,
            command.enabled
          )
        case 'kernel.list-subagent-definitions': {
          const projectPath = await activeProjectPath(kernel, projectStore)
          return subagentDefinitionStore.list(projectPath)
        }
        case 'kernel.save-subagent-definition': {
          const projectPath = await activeProjectPath(kernel, projectStore)
          return subagentDefinitionStore.save(projectPath, command.definition)
        }
        case 'kernel.set-subagent-definition-enabled': {
          const projectPath = await activeProjectPath(kernel, projectStore)
          return subagentDefinitionStore.setEnabled(
            projectPath,
            command.id,
            command.scope,
            command.enabled
          )
        }
        case 'kernel.remove-subagent-definition': {
          const projectPath = await activeProjectPath(kernel, projectStore)
          return subagentDefinitionStore.remove(projectPath, command.id)
        }
        case 'kernel.update-pi-package':
          await piDevPackageService.update(command.source)
          return kernel.acknowledge()
        case 'kernel.update-pi-packages':
          await piDevPackageService.update()
          return kernel.acknowledge()
        case 'kernel.list-providers':
          return providerStore.list()
        case 'kernel.save-provider':
          return providerStore.save(command.provider)
        case 'kernel.remove-provider':
          return providerStore.remove(command.providerId)
        case 'kernel.test-provider':
          if (!(await providerStore.list()).some((provider) =>
            provider.id === command.providerId &&
            provider.models.some((model) => model.id === command.modelId)
          )) {
            throw new Error(`Provider 模型未配置：${command.providerId}/${command.modelId}`)
          }
          return testProviderConnection({
            executablePath: process.env.PI_GUI_PI_EXECUTABLE,
            providerId: command.providerId,
            modelId: command.modelId,
            cwd: environment.userDataDirectory
          })
        case 'kernel.fetch-model-pricing':
          return fetchLiteLlmModelPricing(
            command.providerId,
            command.modelIds,
            (input, init) => environment.fetch(input, init)
          )
        case 'kernel.list-provider-credentials':
          return requireProviderAuth().list()
        case 'kernel.login-provider': {
          const credentials = await requireProviderAuth().login(
            command.providerId,
            command.authType
          )
          kernel.markProviderSessionsForReload(command.providerId)
          try {
            await providerStore.synchronize()
          } catch {
            throw new Error('Provider login succeeded, but model catalog refresh failed.')
          }
          return credentials
        }
        case 'kernel.submit-provider-auth-prompt':
          await requireProviderAuth().submitPrompt(
            command.operationId,
            command.promptId,
            command.value
          )
          return
        case 'kernel.cancel-provider-login':
          await requireProviderAuth().cancel(command.operationId)
          return
        case 'kernel.logout-provider': {
          const credentials = await requireProviderAuth().logout(command.providerId)
          kernel.markProviderSessionsForReload(command.providerId)
          try {
            await providerStore.synchronize()
          } catch {
            throw new Error('Provider logout succeeded, but model catalog refresh failed.')
          }
          return credentials
        }
        case 'kernel.select-prompt-attachments': {
          if (command.filePaths !== undefined) return readPromptAttachments(command.filePaths)
          const selection = environment.desktop === null ? null : await environment.desktop.pickAttachmentFiles()
          if (selection === null) return []
          return readPromptAttachments(selection)
        }
        case 'kernel.navigate-history-prompt':
          await kernel.navigateHistoryPrompt(command.sessionKey, command.messageId)
          return kernel.acknowledge()
        case 'kernel.set-session-naming':
          await kernel.setSessionNaming(command.settings)
          return kernel.acknowledge()
        case 'kernel.set-appearance':
          await kernel.setAppearance(command.settings)
          return kernel.acknowledge()
        case 'kernel.set-general':
          await kernel.setGeneral(command.settings)
          return kernel.acknowledge()
        case 'kernel.set-subagent':
          await kernel.setSubagent(command.settings)
          return kernel.acknowledge()
        case 'kernel.set-shortcuts':
          await kernel.setShortcuts(command.settings)
          return kernel.acknowledge()
      }
  }
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

function configuredUserProject(state: {
  projects: Array<{
    path: string
    workspaceKind?: 'project' | 'task'
    taskKey?: string
    sessions?: Array<{ key: string }>
  }>
  activeProjectKey: string | null
}): { path: string } {
  const project = configuredProject(state)
  if (project.workspaceKind === 'task') {
    throw new Error('Project path search is unavailable for Tasks.')
  }
  return project
}

async function activeProjectPath(
  activeKernel: WorkbenchKernel,
  projectStore: ProjectStore
): Promise<string | null> {
  const state = activeKernel.getState()
  if (state.activeProjectKey === null) return null
  const project = configuredProject(state)
  if (project.workspaceKind === 'task') return null
  const canonicalPath = await projectStore.validateProjectPath(project.path)
  if (canonicalPath !== project.path) {
    throw new Error(`Active project path no longer resolves canonically: ${project.path}`)
  }
  return canonicalPath
}

function sameSessionExportIdentity(
  first: { projectKey: string, sessionKey: string, sessionId: string },
  second: { projectKey: string, sessionKey: string, sessionId: string }
): boolean {
  return first.projectKey === second.projectKey &&
    first.sessionKey === second.sessionKey &&
    first.sessionId === second.sessionId
}

export function isSubagentPackageEnabled(
  packages: readonly { packageName: string | null, extensionEnabled: boolean }[]
): boolean {
  return packages.some((pkg) =>
    pkg.packageName === SUBAGENT_PACKAGE_NAME && pkg.extensionEnabled
  )
}
