import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  KERNEL_COMMAND_CHANNEL,
  KERNEL_EVENT_CHANNEL,
  OPEN_EXTERNAL_CHANNEL,
  PROVIDER_AUTH_EVENT_CHANNEL,
  SUBAGENT_PACKAGE_NAME,
  type KernelEvent,
  type KernelExtensionSelectionKind,
  type KernelPiPackageInstallJob,
  type KernelProviderAuthEvent
} from '../../shared/kernel-contract.ts'
import { GIT_COMMAND_CHANNEL } from '../../shared/git-contract.ts'
import {
  REMOTE_ADMIN_COMMAND_CHANNEL,
  isRemoteAdminCommand,
  type DesktopHostAccessStatus,
  type RemoteAccessStatus,
  type RemotePairingCode,
  type TailscaleRemoteStatus
} from '../../shared/remote-admin-contract.ts'
import { normalizeOpenTarget } from '../../shared/external-url.ts'
import { PiExtensionStore } from '../extension/pi-extension-store.ts'
import { PiDevPackageService } from '../extension/pi-dev-package-service.ts'
import { resolveRuntimeExtensionPaths } from '../runtime/runtime-quiescence.ts'
import {
  createDesktopNotificationBroker,
  type DesktopNotificationBroker
} from '../notification/desktop-notification-broker.ts'
import { activateDesktopNotificationTarget } from '../notification/desktop-notification-target.ts'
import { createActiveRegisteredGitProjectResolver } from '../git/git-active-project-resolver.ts'
import { GitCapabilityController } from '../git/git-capability-controller.ts'
import { isGitCommand } from '../git/git-command-validation.ts'
import { createKernelEventForwarder } from '../kernel/kernel-event-forwarder.ts'
import { AUTO_HIBERNATE_SWEEP_INTERVAL_MS, WorkbenchKernel } from '../kernel/workbench-kernel.ts'
import type { DesktopHostGateway } from '../remote/desktop-host-gateway.ts'
import { createKernelCommandHandler, isSubagentPackageEnabled } from './kernel-command-handler.ts'
import { openHostControl } from './host-control.ts'
import { startRemoteAccess, type RemoteAccess } from './remote-access.ts'
import { PiProviderStore } from '../provider/pi-provider-store.ts'
import { PiProviderAuth } from '../provider/pi-provider-auth.ts'
import { ProjectStore } from '../project/project-store.ts'
import { readSessionMetadata, readSessionStatistics } from '../project/session-statistics.ts'
import { readSessionMessagesTailFirst, readSessionTranscriptGeneration } from '../project/session-transcript-tail.ts'
import { readSessionActivityAt, readSessionMessages } from '../project/session-transcript.ts'
import { resolvePiExecutable } from '../runtime/pi-executable.ts'
import { PiRuntimeProcessHost } from '../runtime/pi-runtime-process-host.ts'
import { createJsonlLogger } from '../utils/jsonl-log.ts'
import { generateSessionNameWithPi } from '../runtime/session-name-generator.ts'
import { errorMessage } from '../utils/errors.ts'
import { WslPipe, wslBuildFingerprint } from '../remote/wsl-pipe.ts'
import { WSL_DESKTOP_CHANNEL, createWslNotificationPresenter } from '../remote/wsl-desktop.ts'
import { PiProjectTrust } from '../security/pi-project-trust.ts'
import { resolveBuildCommit } from '../build-identity.ts'
import { SubagentDefinitionStore } from '../subagent/subagent-definition-store.ts'


/** The lifecycle of the local renderer that issued a request; absent for pipe and gateway callers. */
export type RendererLifecycle = {
  once(event: 'destroyed' | 'render-process-gone' | 'did-start-navigation', listener: () => void): unknown
  removeListener(event: 'destroyed' | 'render-process-gone' | 'did-start-navigation', listener: () => void): unknown
  isDestroyed(): boolean
}

export type HostRequestEvent = { sender: RendererLifecycle } | null

/** Dialogs and shell actions only the local desktop window provides. */
export type HostDesktopCapabilities = {
  pickOpenDirectory(): Promise<string | null>
  pickSaveHtmlPath(title: string | null): Promise<string | null>
  pickExtensionPath(kind: KernelExtensionSelectionKind): Promise<string | null>
  /** Null when the user cancels. */
  pickAttachmentFiles(): Promise<string[] | null>
  /** Resolves to an error message, empty on success (Electron shell.openPath semantics). */
  openPath(path: string): Promise<string>
  openExternal(url: string): Promise<void>
  focusWindow(): void
}

/**
 * Everything the Host assembly needs from its process. The Electron desktop provides all of it;
 * the Node Host (D-095) provides no renderer and no desktop capabilities.
 */
export type HostEnvironment = {
  wslHostMode: boolean
  /** Directory of the built Main bundle (out/main). */
  mainBundleDirectory: string
  isPackaged: boolean
  resourcesPath: string
  userDataDirectory: string
  logDirectory: string
  /** JSON Lines log name in logDirectory: main (Electron desktop) or host (Node Host), D-099. */
  logName: 'main' | 'host'
  productVersion: string
  fetch: typeof fetch
  resolveBuildCommit: () => string | null
  registerIpcHandler?: (channel: string, handler: (event: HostRequestEvent, value: unknown) => unknown) => void
  publishToRenderer?: (channel: string, value: unknown) => void
  desktop: HostDesktopCapabilities | null
  onWslPipeClosed: () => void
}

export type HostApplication = {
  /** Serve the owned WSL stdio pipe (WSL Host mode only) and wait until the client is connected. */
  serveWslPipe(): Promise<void>
  refreshSessionActivities(): Promise<void>
  /** The Desktop Host gateway when enabled; its device functions serve the Host CLI (D-095). */
  desktopHost(): DesktopHostGateway | null
  stop(): Promise<void>
}

/**
 * The Host assembly: projects, Kernel, Pi Runtime process, Git, packages, remote access,
 * notifications and the WSL pipe (moved from main/index.ts so it runs without Electron, D-095).
 */
export async function startHostApplication(environment: HostEnvironment): Promise<HostApplication> {
  let wslHostPipe: WslPipe | null = null
  let kernel: WorkbenchKernel | null = null
  let projectStoreForShutdown: ProjectStore | null = null
  let providerAuth: PiProviderAuth | null = null
  let desktopNotificationBroker: DesktopNotificationBroker | null = null
  let sharedPiHost: PiRuntimeProcessHost | null = null
  let remoteAccess: RemoteAccess | null = null
  let autoHibernateTimer: ReturnType<typeof setInterval> | null = null
  let packageInstallDrain: Promise<void> = Promise.resolve()
  const MAX_PACKAGE_INSTALL_JOBS = 32
  let switchingEnvironment = false
  let stopping = false

  const wslNotificationPresenter = environment.wslHostMode ? createWslNotificationPresenter((command) => {
    if (wslHostPipe === null) throw new Error('WSL desktop is not connected.')
    return wslHostPipe.request(WSL_DESKTOP_CHANNEL, command)
  }) : null
  const backendHandlers = new Map<string, (value: unknown) => unknown | Promise<unknown>>()
    let activeBackendRequests = 0

    function registerBackendHandler(
      channel: string,
      handler: (event: HostRequestEvent, value: unknown) => unknown | Promise<unknown>
    ): void {
      // Local IPC (desktop only) and the owned WSL pipe enter the same business handler.
      environment.registerIpcHandler?.(channel, handler)
      backendHandlers.set(channel, async (value) => {
        if (switchingEnvironment) throw new Error('Desktop environment is restarting.')
        activeBackendRequests += 1
        try { return await handler(null, value) } finally { activeBackendRequests -= 1 }
      })
    }
  const kernelEventForwarder = createKernelEventForwarder({ send: sendKernelEvent })

  function forwardKernelEvent(event: KernelEvent): void {
    kernelEventForwarder.forward(event)
  }

  function sendKernelEvent(event: KernelEvent): void {
    wslHostPipe?.publish(KERNEL_EVENT_CHANNEL, event)
    environment.publishToRenderer?.(KERNEL_EVENT_CHANNEL, event)
    remoteAccess?.publish(event)
  }

  function forwardProviderAuthEvent(event: KernelProviderAuthEvent): void {
    wslHostPipe?.publish(PROVIDER_AUTH_EVENT_CHANNEL, event)
    environment.publishToRenderer?.(PROVIDER_AUTH_EVENT_CHANNEL, event)
  }

  async function startDesktopNotificationBroker(projectStore: ProjectStore): Promise<void> {
    let candidate: DesktopNotificationBroker | null = null
    try {
      candidate = createDesktopNotificationBroker({
        ...(wslNotificationPresenter === null ? {} : { presenter: wslNotificationPresenter }),
        iconPath: environment.isPackaged
          ? join(environment.resourcesPath, 'pi-notify.png')
          : join(environment.mainBundleDirectory, '../../extensions/pi-gui-task-notify/assets/pi-notify.png'),
        activateTarget: async (target) => {
          const activeKernel = kernel
          if (activeKernel === null) throw new Error('Workbench kernel is unavailable.')
          await activateDesktopNotificationTarget(target, {
            projectStore,
            kernel: activeKernel,
            isAvailable: () =>
              !stopping && kernel === activeKernel,
            focusWindow: focusMainWindow
          })
        },
        onError: (message) => console.error(`[Pi GUI] ${message}`)
      })
      await candidate.start()
      desktopNotificationBroker = candidate
    } catch {
      console.error('[Pi GUI] Desktop notification broker is unavailable.')
      await candidate?.close().catch(() => undefined)
    }
  }

  async function stopKernel(): Promise<void> {
    stopping = true
    wslHostPipe?.close()
    await packageInstallDrain
    const access = remoteAccess
    remoteAccess = null
    await access?.stop()
    const activeKernel = kernel
    const activeSharedPiHost = sharedPiHost
    const projectStore = projectStoreForShutdown
    const restartContinuations = activeKernel?.prepareRestartContinuationShutdown() ?? []
    const kernelStopResult = activeKernel?.stop().then(
      () => null,
      (error: unknown) => error
    ) ?? Promise.resolve(null)
    kernelEventForwarder.dispose()
    if (autoHibernateTimer !== null) {
      clearInterval(autoHibernateTimer)
      autoHibernateTimer = null
    }
    const broker = desktopNotificationBroker
    desktopNotificationBroker = null
    await broker?.close()
    await providerAuth?.shutdown()
    const kernelStopError = await kernelStopResult
    if (kernelStopError !== null) {
      logger.write('error', 'host', 'stop-failed', { stage: 'kernel', message: errorMessage(kernelStopError) })
      throw kernelStopError
    }
    const sharedPiHostStopError = await activeSharedPiHost?.dispose().then(
      () => null,
      (error: unknown) => error
    ) ?? null
    if (sharedPiHostStopError !== null) {
      logger.write('error', 'host', 'stop-failed', { stage: 'pi-runtime', message: errorMessage(sharedPiHostStopError) })
      throw sharedPiHostStopError
    }
    if (projectStore !== null) {
      try {
        await projectStore.replaceRestartContinuations(restartContinuations)
      } catch (error) {
        console.error(
          `[Pi GUI] Restart continuation snapshot unavailable: ${errorMessage(error)}`
        )
      }
    }
    kernel = null
    sharedPiHost = null
    projectStoreForShutdown = null
    await control.close()
    logger.write('info', 'host', 'stopped')
  }

  function requireProviderAuth(): PiProviderAuth {
    if (providerAuth === null) throw new Error('Provider authentication is unavailable.')
    return providerAuth
  }





  function focusMainWindow(): void {
    if (environment.wslHostMode) {
      if (wslHostPipe === null) throw new Error('WSL desktop is not connected.')
      void wslHostPipe.request(WSL_DESKTOP_CHANNEL, { type: 'window.focus' }).catch((error) => {
        console.error(`[Pi GUI] WSL window focus failed: ${errorMessage(error)}`)
      })
      return
    }
    environment.desktop?.focusWindow()
  }
  const pickOpenDirectory = async (): Promise<string | null> =>
    environment.desktop === null ? null : await environment.desktop.pickOpenDirectory()

  function requireDesktop(): HostDesktopCapabilities {
    if (environment.desktop === null) throw new Error('This action needs the Pi GUI desktop window.')
    return environment.desktop
  }

  const logger = createJsonlLogger({ directory: environment.logDirectory, name: environment.logName })
  logger.write('info', 'host', 'start', { version: environment.productVersion, wsl: environment.wslHostMode })
  // One Host per data directory (D-099); the same private socket serves the Host CLI (D-095).
  const control = await openHostControl({
    userDataDirectory: environment.userDataDirectory,
    dispatch: async (command) => {
      if (remoteAccess === null) throw new Error('The Pi GUI Host is still starting.')
      return await remoteAccess.dispatchRemoteAdminCommand(command)
    }
  })
  const projectStore = new ProjectStore()
  projectStoreForShutdown = projectStore
  const general = await projectStore.loadGeneral()
  const restartContinuations = general.autoContinueInterruptedTasks
    ? await projectStore.loadRestartContinuations()
    : await projectStore.clearRestartContinuations().then(() => [])
  const storedProjects = await projectStore.loadProjects()
  const storedTasks = await projectStore.loadTasks()
  const sessionNaming = await projectStore.loadSessionNaming()
  const piExecutable = resolvePiExecutable({
    explicitPath: process.env.PI_GUI_PI_EXECUTABLE
  })
  const appearance = await projectStore.loadAppearance()
  const subagent = await projectStore.loadSubagent()
  const shortcuts = await projectStore.loadShortcuts()
  const extensionStore = new PiExtensionStore()
  const providerStore = new PiProviderStore()
  await providerStore.synchronize()
  providerAuth = new PiProviderAuth({
    explicitExecutable: process.env.PI_GUI_PI_EXECUTABLE
  })
  providerAuth.subscribe(forwardProviderAuthEvent)
  const piDevPackageService = new PiDevPackageService({
    piExecutablePath: process.env.PI_GUI_PI_EXECUTABLE,
    fetch: (input, init) => environment.fetch(input instanceof URL ? input.toString() : input, init)
  })
  let subagentPackageEnabled = isSubagentPackageEnabled(await piDevPackageService.list())
  const refreshSubagentPackageEnabled = async (): Promise<void> => {
    subagentPackageEnabled = isSubagentPackageEnabled(await piDevPackageService.list())
  }
  const packageInstallJobs = new Map<string, KernelPiPackageInstallJob>()
  const activePackageInstallIds = new Map<string, string>()
  let packageInstallQueue = Promise.resolve()
  const publishPackageInstallJob = (job: KernelPiPackageInstallJob): void => {
    packageInstallJobs.set(job.id, job)
    while (packageInstallJobs.size > MAX_PACKAGE_INSTALL_JOBS) {
      const oldest = packageInstallJobs.entries().next().value as [string, KernelPiPackageInstallJob] | undefined
      if (oldest === undefined) break
      if (oldest[1].status === 'queued' || oldest[1].status === 'running') break
      packageInstallJobs.delete(oldest[0])
    }
    forwardKernelEvent({ type: 'kernel.pi-package-install', job })
  }
  const startPackageInstall = (name: string): void => {
    piDevPackageService.validateInstallName(name)
    const existingId = activePackageInstallIds.get(name)
    if (existingId !== undefined) return

    const jobId = randomUUID()
    activePackageInstallIds.set(name, jobId)
    publishPackageInstallJob({ id: jobId, name, status: 'queued', error: null })
    const run = packageInstallQueue.then(async () => {
      publishPackageInstallJob({ id: jobId, name, status: 'running', error: null })
      try {
        await piDevPackageService.install(name)
        publishPackageInstallJob({ id: jobId, name, status: 'succeeded', error: null })
        if (name === SUBAGENT_PACKAGE_NAME) {
          try {
            await refreshSubagentPackageEnabled()
          } catch (error: unknown) {
            console.error(`[Pi GUI] Subagent package state refresh failed: ${errorMessage(error)}`)
          }
        }
      } catch (error: unknown) {
        publishPackageInstallJob({
          id: jobId,
          name,
          status: 'failed',
          error: errorMessage(error)
        })
      } finally {
        activePackageInstallIds.delete(name)
      }
    })
    packageInstallQueue = run.then(() => undefined, () => undefined)
    packageInstallDrain = packageInstallQueue
  }
  packageInstallDrain = packageInstallQueue
  const subagentDefinitionStore = new SubagentDefinitionStore()
  const projectTrust = new PiProjectTrust({
    explicitExecutable: process.env.PI_GUI_PI_EXECUTABLE
  })
  const extensions = await extensionStore.list()
  const runtimeWorkspaces = [
    ...storedProjects.projects,
    ...storedTasks.tasks.map((task) => ({
      path: task.path,
      workspaceKind: 'task' as const,
      taskKey: task.key
    }))
  ]
  const sessionRegistries = new Map(await Promise.all(
    runtimeWorkspaces.map(async (workspace) => [
      workspace.path,
      await projectStore.loadSessionRegistry(workspace.path)
    ] as const)
  ))
  const projects = runtimeWorkspaces.map((workspace) => ({
    ...workspace,
    sessionCount: sessionRegistries.get(workspace.path)?.sessions.length ?? 0
  }))
  const restoredTask = storedTasks.activeTaskKey === null
    ? null
    : storedTasks.tasks.find(({ key }) => key === storedTasks.activeTaskKey) ?? null
  const restoredTaskRegistry = restoredTask === null
    ? null
    : sessionRegistries.get(restoredTask.path) ?? null
  const restoreTask = general.startupWorkspaceRestore === 'restore' &&
    storedTasks.navigatorKind === 'task' &&
    restoredTask !== null &&
    restoredTaskRegistry !== null &&
    restoredTaskRegistry.activeSessionKey !== null
  const navigatorKind = general.startupWorkspaceRestore === 'restore'
    ? storedTasks.navigatorKind
    : 'project'
  const activeWorkspaceKey = restoreTask
    ? restoredTask!.path
    : navigatorKind === 'project' && general.startupWorkspaceRestore === 'restore'
      ? storedProjects.activeProjectKey
      : null
  const projectRegistry = { projects, activeProjectKey: activeWorkspaceKey }
  const sessionRegistry = activeWorkspaceKey === null
    ? { sessions: [], activeSessionKey: null }
    : sessionRegistries.get(activeWorkspaceKey) ?? { sessions: [], activeSessionKey: null }
  const runtimeExtensionPaths = resolveRuntimeExtensionPaths({
    isPackaged: environment.isPackaged,
    resourcesPath: environment.resourcesPath
  })
  const quiescenceExtensionPath = runtimeExtensionPaths[0]!
  const runtimeHost = new PiRuntimeProcessHost({
    entryPath: join(environment.mainBundleDirectory, 'pi-runtime-host.js'),
    logDirectory: environment.logDirectory,
    logger
  })
  sharedPiHost = runtimeHost
  kernel = new WorkbenchKernel(
    (project, launchOptions) =>
      runtimeHost.createRuntime({
        cwd: project.path,
        sessionFile: launchOptions.sessionFile,
        projectTrust: launchOptions.projectTrust,
        fastExtensionLoading: launchOptions.fastExtensionLoading,
        piExecutable,
        quiescenceExtensionPath,
        extensionPaths: runtimeExtensionPaths,
        subagent: launchOptions.subagent,
        ...(desktopNotificationBroker === null
          ? {}
          : {
              desktopNotification: {
                socketPath: desktopNotificationBroker.socketPath,
                token: desktopNotificationBroker.token
              }
            })
      }),
    projectRegistry,
    {
      sessionRegistry,
      sessionRegistriesByProject: sessionRegistries,
      extensions,
      persistProject: async (project) => {
        await projectStore.addProject(project)
      },
      persistActiveProject: async (projectKey) => {
        await projectStore.activateProject(projectKey)
      },
      persistActiveTask: async (taskKey) => {
        await projectStore.activateTask(taskKey)
      },
      persistNavigatorKind: async (kind) => {
        await projectStore.selectNavigator(kind)
      },
      navigatorKind,
      persistSession: (pointer) => projectStore.saveSession(pointer),
      persistActiveSession: (projectPath, sessionKey, sessionId) =>
        projectStore.setActiveSession(projectPath, sessionKey, sessionId),
      persistArchivedSession: (projectPath, sessionKey) =>
        projectStore.archiveSession(projectPath, sessionKey),
      restoreArchivedSession: (projectPath, sessionKey) =>
        projectStore.restoreArchivedSession(projectPath, sessionKey),
      validateSession: (pointer) => projectStore.validateSession(pointer),
      readSessionActivityAt,
      readSessionStatistics,
      readSessionMetadata,
      readSessionMessages,
      readSessionMessagesTailFirst,
      readSessionTranscriptGeneration,
      persistProjectOrder: (projectKeys) => projectStore.reorderProjects(projectKeys),
      sessionNaming,
      persistSessionNaming: (settings) => projectStore.saveSessionNaming(settings),
      appearance,
      persistAppearance: (settings) => projectStore.saveAppearance(settings),
      general,
      persistGeneral: (settings) => projectStore.saveGeneral(settings),
      restartContinuations,
      claimRestartContinuation: (id) => projectStore.claimRestartContinuation(id),
      completeRestartContinuation: (id) => projectStore.completeRestartContinuation(id),
      subagent,
      persistSubagent: (settings) => projectStore.saveSubagent(settings),
      shortcuts,
      persistShortcuts: (settings) => projectStore.saveShortcuts(settings),
      readSharedRuntimeHostPid: () => runtimeHost.getPid(),
      generateSessionName: async (request) => {
        try {
          return await generateSessionNameWithPi({ ...request, executable: piExecutable })
        } catch (error) {
          console.error(`[Pi GUI] Automatic session naming failed: ${errorMessage(error)}`)
          throw error
        }
      },
      projectTrust
    }
  )
  await kernel.resumeInterruptedSessions()
  kernel.subscribe(forwardKernelEvent)
  autoHibernateTimer = setInterval(() => {
    const activeKernel = kernel
    if (activeKernel === null || stopping) return
    void activeKernel.sweepAutomaticHibernation().catch(() => {
      // Automatic reclaim is opportunistic and fail-closed; the next sweep retries.
    })
  }, AUTO_HIBERNATE_SWEEP_INTERVAL_MS)
  autoHibernateTimer.unref()

  const gitController = new GitCapabilityController(
    createActiveRegisteredGitProjectResolver(kernel, projectStore)
  )

  remoteAccess = await startRemoteAccess({
    logger,
    kernel,
    projectStore,
    gitController,
    userDataDirectory: environment.userDataDirectory,
    remoteStaticRoot: join(environment.mainBundleDirectory, '../remote'),
    productVersion: environment.productVersion,
    resolveBuildCommit: environment.resolveBuildCommit
  })

  registerBackendHandler(GIT_COMMAND_CHANNEL, async (event, command: unknown) => {
    if (!isGitCommand(command)) throw new Error('Unsupported Git command.')
    // Read-only prepare/history may follow Renderer navigation abort.
    // Mutations (including branch-sync execute) stay bound only to their own timeout once queued.
    if (
      command.type !== 'git.list-history' &&
      command.type !== 'git.get-history-detail' &&
      command.type !== 'git.get-history-file-diff' &&
      command.type !== 'git.prepare-branch-sync'
    ) {
      return await gitController.dispatch(command)
    }
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    event?.sender.once('destroyed', abort)
    event?.sender.once('render-process-gone', abort)
    event?.sender.once('did-start-navigation', abort)
    if (event?.sender.isDestroyed()) controller.abort()
    try {
      return await gitController.dispatch(command, controller.signal)
    } finally {
      event?.sender.removeListener('destroyed', abort)
      event?.sender.removeListener('render-process-gone', abort)
      event?.sender.removeListener('did-start-navigation', abort)
    }
  })

  registerBackendHandler(
    REMOTE_ADMIN_COMMAND_CHANNEL,
    async (
      event,
      command: unknown
    ): Promise<RemoteAccessStatus | DesktopHostAccessStatus | RemotePairingCode | TailscaleRemoteStatus> => {
      if (!isRemoteAdminCommand(command)) {
        throw new Error('Unsupported remote admin command.')
      }
      if (remoteAccess === null) throw new Error('Remote access is unavailable.')
      return await remoteAccess.dispatchRemoteAdminCommand(command)
    }
  )

  registerBackendHandler(KERNEL_COMMAND_CHANNEL, createKernelCommandHandler({
    environment,
    kernel: () => kernel,
    projectStore,
    providerStore,
    extensionStore,
    piDevPackageService,
    subagentDefinitionStore,
    requireProviderAuth,
    startPackageInstall,
    listPackageInstallJobs: () => [...packageInstallJobs.values()],
    refreshSubagentPackageEnabled,
    setSubagentPackageEnabled: (enabled) => { subagentPackageEnabled = enabled },
    pickOpenDirectory
  }))
  registerBackendHandler(OPEN_EXTERNAL_CHANNEL, async (_event, value: unknown) => {
    if (typeof value !== 'string') throw new Error('External link must be a URL string.')
    const url = normalizeOpenTarget(value)
    if (url === null) throw new Error('Link target is not allowed.')
    if (url.startsWith('file:')) {
      const error = await requireDesktop().openPath(fileURLToPath(url))
      if (error.length > 0) throw new Error(error)
      return
    }
    await requireDesktop().openExternal(url)
  })
  await startDesktopNotificationBroker(projectStore)

  const activeKernel = kernel
  return {
    async serveWslPipe() {
      wslHostPipe = new WslPipe({
        input: process.stdin,
        output: process.stdout,
        fingerprint: wslBuildFingerprint(join(environment.mainBundleDirectory, 'index.js'), environment.isPackaged ? environment.resourcesPath : undefined),
        expectedPlatform: 'win32',
        dispatch: (channel, value) => {
          if (channel === WSL_DESKTOP_CHANNEL && wslNotificationPresenter !== null) {
            if (typeof value === 'object' && value !== null && 'type' in value && value.type === 'environment.prepare-restart' && Object.keys(value).length === 1) {
              if (activeBackendRequests > 0 || activePackageInstallIds.size > 0) throw new Error('Host 仍有操作或 Package 安装正在进行，请完成后再切换运行环境。')
              kernel!.prepareEnvironmentSwitch()
              switchingEnvironment = true
              return
            }
            return wslNotificationPresenter.dispatch(value)
          }
          const handler = backendHandlers.get(channel)
          if (handler === undefined) throw new Error('Unsupported WSL backend command.')
          return handler(value)
        }
      })
      void wslHostPipe.closed.then(() => { if (!stopping) environment.onWslPipeClosed() })
      await wslHostPipe.ready
    },
    refreshSessionActivities: () => activeKernel.refreshSessionActivities(),
    desktopHost: () => remoteAccess?.desktopHost() ?? null,
    stop: stopKernel
  }
}
