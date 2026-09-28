import { DesktopAttachmentStore, DesktopAttachmentError } from './remote/desktop-attachment-store.ts'
import { WindowsAttachmentUploader } from './remote/windows-attachment-uploader.ts'
import { DESKTOP_ATTACHMENT_CHANNEL, isDesktopAttachmentClientCommand, DESKTOP_ATTACHMENT_COMMAND_TYPES } from '../shared/desktop-attachment-contract.ts'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  Notification,
  shell,
  type IpcMainInvokeEvent,
  type OpenDialogOptions
} from 'electron'
import { randomUUID } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  KERNEL_COMMAND_CHANNEL,
  KERNEL_EVENT_CHANNEL,
  MAGIC_CONTEXT_PACKAGE_NAME,
  OPEN_EXTERNAL_CHANNEL,
  PROVIDER_AUTH_EVENT_CHANNEL,
  WINDOW_FULLSCREEN_CHANGED_CHANNEL,
  WINDOW_IS_FULLSCREEN_CHANNEL,
  WINDOW_IS_MAXIMIZED_CHANNEL,
  WINDOW_MAXIMIZED_CHANGED_CHANNEL,
  WINDOW_CHROME_HEIGHT,
  WINDOW_SET_CHROME_CHANNEL,
  WINDOW_TOGGLE_FULLSCREEN_CHANNEL,
  WINDOW_TOGGLE_MAXIMIZE_CHANNEL,
  SUBAGENT_PACKAGE_NAME,
  type KernelCommand,
  type KernelEvent,
  type KernelExtensionSelectionKind,
  type KernelPiPackageInstallJob,
  type KernelProviderAuthEvent
} from '../shared/kernel-contract.ts'
import { GIT_COMMAND_CHANNEL } from '../shared/git-contract.ts'
import { isDesktopHostKernelCommand, type DesktopHostControlIdentity } from '../shared/desktop-host-contract.ts'
import {
  DESKTOP_CLIENT_COMMAND_CHANNEL,
  DESKTOP_CLIENT_STATUS_CHANNEL,
  isDesktopClientCommand,
  type DesktopClientStatus
} from '../shared/desktop-client-contract.ts'
import {
  REMOTE_ADMIN_COMMAND_CHANNEL,
  isRemoteAdminCommand,
  type DesktopHostAccessStatus,
  type RemoteAccessStatus,
  type RemoteAdminCommand,
  type RemotePairingCode,
  type TailscaleRemoteMode,
  type TailscaleRemoteStatus
} from '../shared/remote-admin-contract.ts'
import {
  isRemoteKernelCommand,
  type RemoteKernelCommand
} from '../shared/remote-contract.ts'
import { normalizeOpenTarget } from '../shared/external-url.ts'
import { PiExtensionStore } from './extension/pi-extension-store.ts'
import { PiDevPackageService } from './extension/pi-dev-package-service.ts'
import { resolveRuntimeExtensionPaths } from './runtime/runtime-quiescence.ts'
import { createSessionExportHtml } from './export/session-export-html.ts'
import {
  createDesktopNotificationBroker,
  type DesktopNotificationBroker
} from './notification/desktop-notification-broker.ts'
import { activateDesktopNotificationTarget } from './notification/desktop-notification-target.ts'
import { createActiveRegisteredGitProjectResolver } from './git/git-active-project-resolver.ts'
import { GitCapabilityController } from './git/git-capability-controller.ts'
import { isGitCommand } from './git/git-command-validation.ts'
import { isKernelCommand } from './kernel/kernel-command-validation.ts'
import { createKernelEventForwarder } from './kernel/kernel-event-forwarder.ts'
import { dispatchTerminalKernelCommand } from './kernel/terminal-kernel-command-dispatcher.ts'
import {
  AUTO_HIBERNATE_SWEEP_INTERVAL_MS,
  WorkbenchKernel
} from './kernel/workbench-kernel.ts'
import { assertRemoteKernelCommandPolicy, assertDesktopHostKernelCommandPolicy } from './remote/remote-command-policy.ts'
import { loadDesktopHostConfig } from './remote/desktop-host-config.ts'
import {
  startDesktopHostGateway,
  type DesktopHostGateway
} from './remote/desktop-host-gateway.ts'
import {
  loadRemoteConfig,
  readRemoteTokenFile,
  type RemoteEnabledConfig
} from './remote/remote-config.ts'
import {
  openRemoteDeviceStore,
  type RemoteDeviceStore
} from './remote/remote-device-store.ts'
import {
  startRemoteGateway,
  type RemoteGateway,
  type RemoteGatewayHandlers
} from './remote/remote-gateway.ts'
import {
  createTailscaleRemoteGatewayConfig,
  openTailscaleRemoteManager,
  type TailscaleRemoteManager
} from './remote/tailscale-remote.ts'
import { readPromptAttachments } from './prompt/prompt-attachment-selection.ts'
import { PiProviderStore } from './provider/pi-provider-store.ts'
import { PiProviderAuth } from './provider/pi-provider-auth.ts'
import { fetchLiteLlmModelPricing } from './provider/litellm-model-pricing.ts'
import { testProviderConnection } from './provider/provider-connection-test.ts'
import { ProjectStore } from './project/project-store.ts'
import { searchProjectPaths } from './project/project-path-search.ts'
import { readSessionMetadata, readSessionStatistics } from './project/session-statistics.ts'
import {
  readSessionMessagesTailFirst,
  readSessionTranscriptGeneration
} from './project/session-transcript-tail.ts'
import { readSessionActivityAt, readSessionMessages } from './project/session-transcript.ts'
import { probePiRpc } from './runtime/linux-local-runtime.ts'
import { resolvePiExecutable } from './runtime/pi-executable.ts'
import { SharedPiHost } from './runtime/shared-pi-host.ts'
import { generateSessionNameWithPi } from './runtime/session-name-generator.ts'
import { errorMessage } from './utils/errors.ts'
import { WslPipe, WSL_COMMAND_CHANNELS, wslBuildFingerprint } from './remote/wsl-pipe.ts'
import { WSL_DESKTOP_CHANNEL, createWslDesktopClient, createWslNotificationPresenter } from './remote/wsl-desktop.ts'
import { listSystemFonts } from './desktop/system-fonts.ts'
import { createElectronNotifications } from './desktop/electron-notifications.ts'
import { createDesktopSettingsStore } from './desktop/desktop-settings-store.ts'
import { isDesktopEnvironment, type DesktopEnvironment } from '../shared/desktop-settings-contract.ts'
import {
  startWslBackend,
  linuxFileUrlToWindowsPath,
  mapWslAttachments,
  resolveWslFilePath,
  resolveInstalledWslLauncher
} from './remote/wsl-backend.ts'
import { createFileDesktopClientHostConfigStore } from './remote/desktop-client-host-config-store.ts'
import { discoverSystemSshHosts } from './remote/ssh-host-discovery.ts'
import { createWindowsCredentialManagerStore, desktopHostProfileCredentialTarget } from './remote/desktop-device-credential-store.ts'
import { createFileDesktopHostProfileStore } from './remote/desktop-host-profile-store.ts'
import { createWindowsRemoteHostManager, type WindowsRemoteHostManager } from './remote/windows-remote-host-manager.ts'
import { PiProjectTrust } from './security/pi-project-trust.ts'
import {
  BUILD_IDENTITY_FILE_NAME,
  resolveBuildCommit
} from './build-identity.ts'
import { SubagentDefinitionStore } from './subagent/subagent-definition-store.ts'
import {
  isAllowedRendererUrl,
  resolveRendererTarget,
  type RendererTarget
} from './security/renderer-security.ts'

const mainBundleDirectory = dirname(fileURLToPath(import.meta.url))
const wslHostMode = process.env.PI_GUI_WSL_HOST === '1'
let wslDistribution = process.env.PI_GUI_WSL_DISTRO
let currentDesktopEnvironment: DesktopEnvironment | null = null
let switchingEnvironment = false
const desktopSettings = createDesktopSettingsStore(join(app.getPath('appData'), 'pi-gui-next-desktop', 'settings.json'))
if (wslHostMode) {
  if (process.platform !== 'linux' || wslDistribution !== undefined) throw new Error('WSL Host requires Linux and cannot also be a client.')
  // Stdout is exclusively the private parent pipe in Host mode.
  console.log = console.error
  console.info = console.error
}
if (wslDistribution !== undefined) {
  if (process.platform !== 'win32') throw new Error('WSL Client requires Windows.')
  app.setPath('userData', join(app.getPath('appData'), 'pi-gui-next-wsl-client'))
}
let wslHostPipe: WslPipe | null = null
let wslBackend: Awaited<ReturnType<typeof startWslBackend>> | null = null
let windowsRemoteSession: WindowsRemoteHostManager | null = null
let clientNotifications: ReturnType<typeof createElectronNotifications> | null = null
const wslNotificationPresenter = wslHostMode ? createWslNotificationPresenter((command) => {
  if (wslHostPipe === null) throw new Error('WSL desktop is not connected.')
  return wslHostPipe.request(WSL_DESKTOP_CHANNEL, command)
}) : null
const backendHandlers = new Map<string, (value: unknown) => unknown | Promise<unknown>>()
let activeBackendRequests = 0

function registerBackendHandler(
  channel: string,
  rendererTarget: RendererTarget,
  handler: (event: IpcMainInvokeEvent | null, value: unknown) => unknown | Promise<unknown>
): void {
  // Both local IPC and the owned WSL pipe enter the same business handler.
  ipcMain.handle(channel, (event, value: unknown) => {
    assertTrustedIpcSender(event, rendererTarget)
    return handler(event, value)
  })
  backendHandlers.set(channel, async (value) => {
    if (switchingEnvironment) throw new Error('Desktop environment is restarting.')
    activeBackendRequests += 1
    try { return await handler(null, value) } finally { activeBackendRequests -= 1 }
  })
}

let mainWindow: BrowserWindow | null = null
let kernel: WorkbenchKernel | null = null
let projectStoreForShutdown: ProjectStore | null = null
let providerAuth: PiProviderAuth | null = null
let desktopNotificationBroker: DesktopNotificationBroker | null = null
let sharedPiHost: SharedPiHost | null = null
let remoteGateway: RemoteGateway | null = null
let remoteGatewaySource: 'manual' | 'tailscale' | null = null
let remoteGatewayCleanupError: Error | null = null
let remoteGatewayHandlers: RemoteGatewayHandlers | null = null
let tailscaleRemoteManager: TailscaleRemoteManager | null = null
let desktopHostGateway: DesktopHostGateway | null = null
let desktopAttachmentStore: DesktopAttachmentStore | null = null
let remoteDeviceStore: RemoteDeviceStore | null = null
let shutdownPromise: Promise<void> | null = null
let autoHibernateTimer: ReturnType<typeof setInterval> | null = null
let allowQuit = false
let packageInstallDrain: Promise<void> = Promise.resolve()
let tailscaleRemoteMutationDrain: Promise<void> = Promise.resolve()

const MAX_PACKAGE_INSTALL_JOBS = 32
const STARTUP_READY_NONCE_PATTERN = /^[0-9a-f]{32}$/

const kernelEventForwarder = createKernelEventForwarder({ send: sendKernelEvent })

async function publishStartupReady(window: BrowserWindow): Promise<void> {
  const nonce = process.env.PI_GUI_STARTUP_READY_NONCE
  if (nonce === undefined) return
  if (!STARTUP_READY_NONCE_PATTERN.test(nonce)) {
    throw new Error('PI_GUI_STARTUP_READY_NONCE must be 32 lowercase hexadecimal characters.')
  }

  const probe: unknown = await window.webContents.executeJavaScript(`
    (async () => {
      const root = document.getElementById('root')
      const api = window.piGui
      if (document.readyState !== 'complete') return { ready: false, reason: 'document' }
      if (root === null || root.childElementCount === 0) return { ready: false, reason: 'root' }
      if (api === undefined || typeof api.getState !== 'function') return { ready: false, reason: 'preload' }
      const state = await api.getState()
      if (state === null || typeof state !== 'object' || !Number.isSafeInteger(state.revision)) {
        return { ready: false, reason: 'kernel' }
      }
      return { ready: true, reason: null }
    })()
  `, true)
  if (
    probe === null ||
    typeof probe !== 'object' ||
    !('ready' in probe) ||
    probe.ready !== true
  ) {
    const reason = probe !== null && typeof probe === 'object' && 'reason' in probe
      ? String(probe.reason)
      : 'unknown'
    throw new Error(`Renderer startup readiness failed: ${reason}`)
  }
  console.info(`[Pi GUI] STARTUP_READY nonce=${nonce} pid=${process.pid}`)
}

async function createMainWindow(rendererTarget: RendererTarget): Promise<void> {
  if (mainWindow !== null) {
    return
  }

  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 720,
    minHeight: 560,
    autoHideMenuBar: true,
    backgroundColor: '#1b1b1a',
    ...(process.platform === 'win32'
      ? {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: {
            color: '#1b1b1a',
            symbolColor: '#f1eee8',
            height: WINDOW_CHROME_HEIGHT
          }
        }
      : {}),
    webPreferences: {
      preload: join(mainBundleDirectory, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  mainWindow = window
  if (wslDistribution !== undefined) {
    const title = `Pi GUI — WSL: ${wslDistribution}`
    window.setTitle(title)
    window.on('page-title-updated', (event) => { event.preventDefault(); window.setTitle(title) })
  }

  const publishFullscreenState = (): void => {
    if (window.isDestroyed()) return
    window.webContents.send(WINDOW_FULLSCREEN_CHANGED_CHANNEL, window.isFullScreen())
  }
  window.on('enter-full-screen', publishFullscreenState)
  window.on('leave-full-screen', publishFullscreenState)

  const publishMaximizedState = (): void => {
    if (window.isDestroyed()) return
    window.webContents.send(WINDOW_MAXIMIZED_CHANGED_CHANNEL, window.isMaximized())
  }
  window.on('maximize', publishMaximizedState)
  window.on('unmaximize', publishMaximizedState)

  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.key !== 'F11' || input.control || input.alt || input.meta || input.shift) {
      return
    }
    event.preventDefault()
    if (window.isDestroyed()) return
    window.setFullScreen(!window.isFullScreen())
  })

  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
  })

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedRendererUrl(rendererTarget, url)) event.preventDefault()
  })
  window.webContents.on('will-redirect', (event, url) => {
    if (!isAllowedRendererUrl(rendererTarget, url)) event.preventDefault()
  })

  await window.loadURL(rendererTarget.url)
  await publishStartupReady(window)
}

async function startApplication(): Promise<void> {
  if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? 'io.pi-gui.next' : process.execPath)
  if (process.platform === 'win32' && process.env.PI_GUI_PROBE_ONLY !== '1') {
    const argument = process.argv.find((value) => value.startsWith('--pi-gui-environment='))
    const selected: unknown = argument !== undefined
      ? JSON.parse(decodeURIComponent(argument.slice('--pi-gui-environment='.length)))
      : wslDistribution !== undefined ? { mode: 'wsl', distribution: wslDistribution }
      : (await desktopSettings.load()).environment ?? (
        app.isPackaged && existsSync(join(process.resourcesPath, 'wsl/backend.tar'))
          ? { mode: 'wsl', distribution: 'Ubuntu-24.04' } : { mode: 'ssh' }
      )
    if (!isDesktopEnvironment(selected)) throw new Error('Invalid desktop environment selection.')
    currentDesktopEnvironment = selected
    wslDistribution = selected.mode === 'wsl' ? selected.distribution : undefined
    if (selected.mode === 'wsl') {
      app.setPath('userData', join(app.getPath('appData'), 'pi-gui-next-wsl-client'))
      process.env.PI_GUI_WSL_LAUNCHER ??= await resolveInstalledWslLauncher(selected.distribution)
      await startWslApplication(selected.distribution)
    } else await startWindowsRemoteApplication()
    await desktopSettings.setEnvironment(selected)
    return
  }
  if (process.env.PI_GUI_PROBE_ONLY === '1') {
    const result = await probePiRpc({
      cwd: process.cwd(),
      explicitExecutable: process.env.PI_GUI_PI_EXECUTABLE,
      noSession: true
    })
    console.info(
      `[Pi GUI] Pi RPC runtime ready: version=${result.version} ` +
      `commands=${result.commandCount} session-name-event=${result.sessionNameEventObserved}`
    )
    allowQuit = true
    app.quit()
    return
  }

  const rendererTarget = resolveRendererTarget({
    isPackaged: app.isPackaged,
    electronViteMode: process.env.NODE_ENV_ELECTRON_VITE,
    rendererUrl: process.env.ELECTRON_RENDERER_URL,
    rendererFilePath: join(mainBundleDirectory, '../renderer/index.html')
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
    fetch: (input, init) => net.fetch(input instanceof URL ? input.toString() : input, init)
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
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath
  })
  const quiescenceExtensionPath = runtimeExtensionPaths[0]!
  const runtimeHost = new SharedPiHost()
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
        ...(subagentPackageEnabled ? { subagent: launchOptions.subagent } : {}),
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
    if (activeKernel === null || shutdownPromise !== null) return
    void activeKernel.sweepAutomaticHibernation().catch(() => {
      // Automatic reclaim is opportunistic and fail-closed; the next sweep retries.
    })
  }, AUTO_HIBERNATE_SWEEP_INTERVAL_MS)
  autoHibernateTimer.unref()

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
      configPath: join(app.getPath('userData'), 'tailscale-remote.json'),
      tokenFile: join(app.getPath('userData'), 'tailscale-remote.token'),
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

  const gitController = new GitCapabilityController(
    createActiveRegisteredGitProjectResolver(kernel, projectStore)
  )

  const desktopHostConfig = await loadDesktopHostConfig(process.env)
  if (desktopHostConfig.enabled) {
    const uid = process.getuid?.()
    if (uid === undefined) {
      throw new Error(
        'Desktop Host device store ownership can only be verified when process.getuid is available.'
      )
    }
    const desktopHostDeviceStore = await openRemoteDeviceStore({
      path: desktopHostConfig.deviceStorePath,
      uid
    })
    const attachmentStore = new DesktopAttachmentStore({
      root: join(app.getPath('userData'), 'desktop-attachments'),
      materialize: (path) => readPromptAttachments([path])
    })
    await attachmentStore.start()
    desktopAttachmentStore = attachmentStore
    desktopHostGateway = await startDesktopHostGateway({
      config: desktopHostConfig,
      productVersion: app.getVersion(),
      buildCommit: await resolveBuildCommit({
        identityFilePath: join(mainBundleDirectory, BUILD_IDENTITY_FILE_NAME),
        ...(!app.isPackaged && process.env.NODE_ENV_ELECTRON_VITE === 'development' ? { developmentRoot: join(mainBundleDirectory, '../..') } : {}),
        ...(app.isPackaged ? { resourcesRoot: process.resourcesPath } : {})
      }),
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



  type StaticSessionPreviewOwner = {
    requestId: string
    sender: IpcMainInvokeEvent['sender'] | null
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
    if (cancel) kernel?.cancelSessionPreview(owner.requestId)
  }
  const claimStaticSessionPreviewOwner = (
    requestId: string,
    sender: IpcMainInvokeEvent['sender'] | null
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

  registerBackendHandler(GIT_COMMAND_CHANNEL, rendererTarget, async (event, command: unknown) => {
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
    rendererTarget,
    async (
      event,
      command: unknown
    ): Promise<RemoteAccessStatus | DesktopHostAccessStatus | RemotePairingCode | TailscaleRemoteStatus> => {
      if (!isRemoteAdminCommand(command)) {
        throw new Error('Unsupported remote admin command.')
      }
      return await dispatchRemoteAdminCommand(command)
    }
  )

  registerBackendHandler(KERNEL_COMMAND_CHANNEL, rendererTarget, async (event, command: unknown) => {
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
        if (command.filePath === undefined && wslHostMode) return { saved: false }
        const preparation = await kernel.prepareSessionExport()
        const targetPath = command.filePath ?? await pickSaveHtmlPath(preparation.title)
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
        const selectedPath = command.path ?? await pickExtensionPath(command.kind)
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
        return [...packageInstallJobs.values()]
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
        subagentPackageEnabled = isSubagentPackageEnabled(packages)
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
          cwd: app.getPath('userData')
        })
      case 'kernel.fetch-model-pricing':
        return fetchLiteLlmModelPricing(
          command.providerId,
          command.modelIds,
          (input, init) => net.fetch(input, init)
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
        if (wslHostMode) return []
        const options: OpenDialogOptions = {
          title: '选择附件',
          properties: ['openFile', 'multiSelections']
        }
        const selection = mainWindow === null
          ? await dialog.showOpenDialog(options)
          : await dialog.showOpenDialog(mainWindow, options)
        if (selection.canceled) return []
        return readPromptAttachments(selection.filePaths)
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
  })
  registerBackendHandler(OPEN_EXTERNAL_CHANNEL, rendererTarget, async (_event, value: unknown) => {
    if (typeof value !== 'string') throw new Error('External link must be a URL string.')
    const url = normalizeOpenTarget(value)
    if (url === null) throw new Error('Link target is not allowed.')
    if (url.startsWith('file:')) {
      const error = await shell.openPath(fileURLToPath(url))
      if (error.length > 0) throw new Error(error)
      return
    }
    await shell.openExternal(url)
  })
  registerDesktopClientHandlers(rendererTarget)
  registerWindowHandlers(rendererTarget)
  await startDesktopNotificationBroker(projectStore)
  if (wslHostMode) {
    wslHostPipe = new WslPipe({
      input: process.stdin,
      output: process.stdout,
      fingerprint: wslBuildFingerprint(fileURLToPath(import.meta.url), app.isPackaged ? process.resourcesPath : undefined),
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
    void wslHostPipe.closed.then(() => { if (!allowQuit) app.quit() })
    await wslHostPipe.ready
  } else {
    await createMainWindow(rendererTarget)
  }
  await kernel.refreshSessionActivities()
}

function registerWindowHandlers(rendererTarget: RendererTarget): void {
  ipcMain.handle(WINDOW_TOGGLE_FULLSCREEN_CHANNEL, (event) => {
    assertTrustedIpcSender(event, rendererTarget)
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window === null || window.isDestroyed()) return false
    const next = !window.isFullScreen()
    window.setFullScreen(next)
    return next
  })
  ipcMain.handle(WINDOW_IS_FULLSCREEN_CHANNEL, (event) => {
    assertTrustedIpcSender(event, rendererTarget)
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window === null || window.isDestroyed()) return false
    return window.isFullScreen()
  })
  ipcMain.handle(WINDOW_TOGGLE_MAXIMIZE_CHANNEL, (event) => {
    assertTrustedIpcSender(event, rendererTarget)
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window === null || window.isDestroyed()) return false
    if (window.isFullScreen()) {
      // Leave exclusive fullscreen first so maximize is visible as a normal state.
      window.setFullScreen(false)
    }
    if (window.isMaximized()) {
      window.unmaximize()
      // Some Wayland compositors report maximized asynchronously; force a clear return.
      return false
    }
    window.maximize()
    return true
  })
  ipcMain.handle(WINDOW_IS_MAXIMIZED_CHANNEL, (event) => {
    assertTrustedIpcSender(event, rendererTarget)
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window === null || window.isDestroyed()) return false
    return window.isMaximized()
  })
  ipcMain.handle(WINDOW_SET_CHROME_CHANNEL, (event, value: unknown) => {
    assertTrustedIpcSender(event, rendererTarget)
    if (
      value === null ||
      typeof value !== 'object' ||
      !('color' in value) ||
      !('symbolColor' in value) ||
      typeof value.color !== 'string' ||
      typeof value.symbolColor !== 'string' ||
      !/^#[0-9a-f]{6}$/iu.test(value.color) ||
      !/^#[0-9a-f]{6}$/iu.test(value.symbolColor)
    ) {
      throw new Error('Window chrome colors must be #RRGGBB.')
    }
    const window = BrowserWindow.fromWebContents(event.sender)
    if (window === null || window.isDestroyed()) return
    window.setBackgroundColor(value.color)
    if (process.platform === 'win32') {
      window.setTitleBarOverlay({
        color: value.color,
        symbolColor: value.symbolColor,
        height: WINDOW_CHROME_HEIGHT
      })
    }
  })
}

async function startWslApplication(distribution: string): Promise<void> {
  const launcherPath = process.env.PI_GUI_WSL_LAUNCHER
  if (launcherPath === undefined) throw new Error('PI_GUI_WSL_LAUNCHER is required. Run scripts/start-wsl.ps1.')
  const rendererTarget = resolveRendererTarget({
    isPackaged: app.isPackaged,
    electronViteMode: process.env.NODE_ENV_ELECTRON_VITE,
    rendererUrl: process.env.ELECTRON_RENDERER_URL,
    rendererFilePath: join(mainBundleDirectory, '../renderer/index.html')
  })
  await mkdir(app.getPath('logs'), { recursive: true })
  const log = createWriteStream(join(app.getPath('logs'), 'wsl-backend.log'), { flags: 'w', mode: 0o600 })
  log.on('error', (error) => console.error(`[Pi GUI] WSL log failed: ${error.message}`))
  clientNotifications = createElectronNotifications(Notification)
  const desktopDispatch = createWslDesktopClient({
    present: clientNotifications.present,
    focusWindow: focusMainWindow,
    onError: (error) => console.error(`[Pi GUI] WSL desktop failed: ${errorMessage(error)}`),
    send: (command) => {
      if (wslBackend === null) throw new Error('WSL backend is not connected.')
      return wslBackend.pipe.request(WSL_DESKTOP_CHANNEL, command)
    }
  })
  try {
    wslBackend = await startWslBackend({
      dispatch: (channel, value) => {
        if (channel !== WSL_DESKTOP_CHANNEL) throw new Error('Unsupported WSL client command.')
        return desktopDispatch(value)
      },
      distribution,
      launcherPath,
      fingerprint: wslBuildFingerprint(fileURLToPath(import.meta.url), app.isPackaged ? process.resourcesPath : undefined),
      onDiagnostic: (chunk) => { log.write(chunk) },
      onEvent: (channel, value) => {
        if (mainWindow !== null && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, value)
      }
    })
  } catch (error) {
    log.end()
    throw new Error(`${errorMessage(error)} See ${join(app.getPath('logs'), 'wsl-backend.log')}`)
  }
  const backend = wslBackend
  void backend.pipe.closed.then((error) => {
    log.end()
    if (allowQuit || shutdownPromise !== null) return
    dialog.showErrorBox('WSL 后端连接已断开', `${error?.message ?? '连接已关闭'}\n请重新启动 WSL 客户端。未自动重发任何命令。`)
    app.quit()
  })
  for (const channel of WSL_COMMAND_CHANNELS) {
    ipcMain.handle(channel, async (event, value: unknown) => {
      assertTrustedIpcSender(event, rendererTarget)
      if (channel === KERNEL_COMMAND_CHANNEL && !isKernelCommand(value)) throw new Error('Unsupported kernel command.')
      if (channel === GIT_COMMAND_CHANNEL && !isGitCommand(value)) throw new Error('Unsupported Git command.')
      if (channel === REMOTE_ADMIN_COMMAND_CHANNEL && !isRemoteAdminCommand(value)) throw new Error('Unsupported remote admin command.')
      if (channel === OPEN_EXTERNAL_CHANNEL) {
        if (typeof value !== 'string') throw new Error('External link must be a URL string.')
        const url = normalizeOpenTarget(value)
        if (url === null) throw new Error('Link target is not allowed.')
        if (!url.startsWith('file:')) { await shell.openExternal(url); return }
        const error = await shell.openPath(linuxFileUrlToWindowsPath(distribution, url))
        if (error.length > 0) throw new Error(error)
        return
      }
      if (channel === KERNEL_COMMAND_CHANNEL && isKernelCommand(value) && value.type === 'kernel.list-system-fonts') return listSystemFonts()
      const command = channel === KERNEL_COMMAND_CHANNEL && isKernelCommand(value)
        ? await mapWslAttachments(
          await bindWslClientDialogCommand(distribution, value),
          (path) => resolveWslFilePath(distribution, path)
        )
        : value
      return backend.pipe.request(channel, command)
    })
  }
  registerWindowHandlers(rendererTarget)
  registerDesktopClientHandlers(rendererTarget)
  await createMainWindow(rendererTarget)
  console.info(`[Pi GUI] WSL backend connected: ${distribution}`)
}

async function startWindowsRemoteApplication(): Promise<void> {
  const buildCommit = await resolveBuildCommit({
    identityFilePath: join(mainBundleDirectory, BUILD_IDENTITY_FILE_NAME),
    ...(!app.isPackaged && process.env.NODE_ENV_ELECTRON_VITE === 'development' ? { developmentRoot: join(mainBundleDirectory, '../..') } : {}),
    ...(app.isPackaged ? { resourcesRoot: process.resourcesPath } : {})
  })
  if (buildCommit === null) {
    throw new Error(
      'Windows remote-only client needs a verified build manifest. Run pnpm build; the source must match the Linux Host.'
    )
  }
  const rendererTarget = resolveRendererTarget({
    isPackaged: app.isPackaged,
    electronViteMode: process.env.NODE_ENV_ELECTRON_VITE,
    rendererUrl: process.env.ELECTRON_RENDERER_URL,
    rendererFilePath: join(mainBundleDirectory, '../renderer/index.html')
  })
  const hostConfigStore = createFileDesktopClientHostConfigStore(
    join(app.getPath('userData'), 'desktop-client-host.json')
  )
  const session = await createWindowsRemoteHostManager({
    profileStore: createFileDesktopHostProfileStore(join(app.getPath('userData'), 'desktop-client-hosts.json')),
    legacyHostStore: hostConfigStore,
    legacyCredentialStore: createWindowsCredentialManagerStore(),
    credentialStoreForKey: (key) => createWindowsCredentialManagerStore({ target: desktopHostProfileCredentialTarget(key) }),
    session: { productVersion: app.getVersion(), buildCommit, onEvent: forwardKernelEvent, onStatus: sendDesktopClientStatus }
  })
  windowsRemoteSession = session
  const attachmentUploader = new WindowsAttachmentUploader()
  ipcMain.handle(DESKTOP_ATTACHMENT_CHANNEL, async (event, command: unknown, identity: unknown, connectionId: unknown) => {
    assertTrustedIpcSender(event, rendererTarget)
    if (!isDesktopAttachmentClientCommand(command)) throw new Error('Invalid desktop attachment request.')
    if (command.type === 'attachment.cancel-local') { attachmentUploader.cancel(command.operationId); return null }
    const send = session.captureDispatch(connectionId)
    const capabilities = session.status().capabilities
    if (!DESKTOP_ATTACHMENT_COMMAND_TYPES.every((type) => capabilities?.attachmentCommandTypes?.includes(type))) {
      throw new Error('Desktop Host does not advertise the complete attachment workflow.')
    }
    if (command.type === 'attachment.select-local') {
      return attachmentUploader.upload(command.operationId, identity, async () => {
        const options: OpenDialogOptions = { title: '选择上传到远程任务的附件', properties: ['openFile', 'multiSelections'] }
        const selection = mainWindow === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(mainWindow, options)
        return selection.canceled ? [] : selection.filePaths
      }, send)
    }
    if (command.type === 'attachment.upload-data') return attachmentUploader.upload(command.operationId, identity, async () => command.files, send)
    return send(command, identity)
  })

  registerDesktopClientHandlers(rendererTarget)
  ipcMain.handle(KERNEL_COMMAND_CHANNEL, async (event, command: unknown, identity: unknown, connectionId: unknown) => {
    assertTrustedIpcSender(event, rendererTarget)
    if (!isKernelCommand(command)) throw new Error('Unsupported kernel command.')
    if (command.type === 'kernel.list-system-fonts') return listSystemFonts()
    return session.dispatch(command, identity, connectionId)
  })
  ipcMain.handle(GIT_COMMAND_CHANNEL, (event, command: unknown, identity: unknown, connectionId: unknown) => {
    assertTrustedIpcSender(event, rendererTarget)
    if (!isGitCommand(command)) throw new Error('Unsupported Git command.')
    return session.dispatch(command, identity, connectionId)
  })
  ipcMain.handle(REMOTE_ADMIN_COMMAND_CHANNEL, (event) => {
    assertTrustedIpcSender(event, rendererTarget)
    throw new Error('Desktop Host pairing and Web Remote are managed on the Linux Host.')
  })
  ipcMain.handle(OPEN_EXTERNAL_CHANNEL, async (_event, value: unknown) => {
    assertTrustedIpcSender(_event, rendererTarget)
    if (typeof value !== 'string') throw new Error('External link must be a URL string.')
    const url = normalizeOpenTarget(value)
    if (url === null) throw new Error('Link target is not allowed.')
    if (url.startsWith('file:')) {
      throw new Error('Windows remote-only client cannot open Linux file paths locally.')
    }
    await shell.openExternal(url)
  })
  registerWindowHandlers(rendererTarget)
  await createMainWindow(rendererTarget)
}

function registerDesktopClientHandlers(rendererTarget: RendererTarget): void {
  ipcMain.handle(DESKTOP_CLIENT_COMMAND_CHANNEL, async (event, command: unknown, connectionId: unknown) => {
    assertTrustedIpcSender(event, rendererTarget)
    if (!isDesktopClientCommand(command)) throw new Error('Unsupported desktop client command.')
    const session = windowsRemoteSession
    switch (command.type) {
      case 'desktop-client.host-profiles.save':
      case 'desktop-client.host-profiles.select':
      case 'desktop-client.host-profiles.remove':
      case 'desktop-client.host-profiles.forget':
      case 'desktop-client.host-profiles.retry': {
        if (session === null) throw new Error('No SSH client is available.')
        return session.manageProfiles(command)
      }
      case 'desktop-client.check-host': {
        if (session === null) throw new Error('No SSH client is available.')
        return session.checkHost(command.operationId, command.config)
      }
      case 'desktop-client.cancel-host-check': {
        if (session === null) throw new Error('No SSH client is available.')
        return session.cancelHostCheck(command.operationId)
      }
      case 'desktop-client.list-ssh-hosts': {
        if (session === null) throw new Error('No SSH client is available.')
        return discoverSystemSshHosts()
      }
      case 'desktop-client.get-status': return session?.status() ?? { mode: wslDistribution === undefined ? 'local' : 'wsl' }
      case 'desktop-client.get-environment': return { current: currentDesktopEnvironment, canSwitch: process.platform === 'win32' && process.env.NODE_ENV_ELECTRON_VITE !== 'development' }
      case 'desktop-client.get-preferences': return command.seed === undefined ? (await desktopSettings.load()).preferences : desktopSettings.initializePreferences(command.seed)
      case 'desktop-client.set-preferences': return desktopSettings.updatePreferences(command.patch)
      case 'desktop-client.disconnect': {
        if (session === null) throw new Error('No SSH client is available.')
        await session.disconnect()
        mainWindow?.setTitle('Pi GUI — SSH')
        return
      }
      case 'desktop-client.revoke-pairing': {
        if (session === null) throw new Error('No SSH client is available.')
        await session.revokePairing(command.config, connectionId)
        mainWindow?.setTitle('Pi GUI — SSH')
        return
      }
      case 'desktop-client.connect': {
        if (session === null) throw new Error('No SSH client is available.')
        const { type: _type, ...request } = command
        await session.connect(request)
        mainWindow?.setTitle(`Pi GUI — SSH: ${request.sshHostAlias}`)
        return
      }
      case 'desktop-client.switch-environment': {
        if (process.platform !== 'win32' || process.env.NODE_ENV_ELECTRON_VITE === 'development') throw new Error('请通过 workspace start 或 wsl 启动生产构建后切换环境。')
        if (session !== null && session.status().phase !== 'disconnected') throw new Error('请先断开当前 SSH Host，再切换运行环境。')
        // Reserve this operation before its first await; a second IPC cannot race the dialog.
        switchingEnvironment = true
        let prepared = false
        try {
          if (command.environment.mode === 'wsl') {
            await resolveInstalledWslLauncher(command.environment.distribution, wslBuildFingerprint(fileURLToPath(import.meta.url), app.isPackaged ? process.resourcesPath : undefined))
          }
          const confirmation = await dialog.showMessageBox({ type: 'question', message: '重启并切换运行环境？', detail: '未发送的草稿不会迁移。项目和会话继续保存在各自的 Host。', buttons: ['取消', '重启并切换'], defaultId: 0, cancelId: 0 })
          if (confirmation.response !== 1) return
          if (wslBackend !== null) await wslBackend.pipe.request(WSL_DESKTOP_CHANNEL, { type: 'environment.prepare-restart' })
          prepared = true
          shutdownPromise = stopKernel()
          await shutdownPromise
          delete process.env.PI_GUI_WSL_DISTRO
          delete process.env.PI_GUI_WSL_LAUNCHER
          const args = process.argv.slice(1).filter((value) => !value.startsWith('--pi-gui-environment='))
          args.push(`--pi-gui-environment=${encodeURIComponent(JSON.stringify(command.environment))}`)
          app.relaunch({ args })
          allowQuit = true
          app.quit()
        } catch (error) {
          if (prepared) {
            console.error(`[Pi GUI] Environment switch shutdown failed: ${errorMessage(error)}`)
            dialog.showErrorBox('运行环境切换失败', errorMessage(error))
            app.exit(1)
          }
          throw error
        } finally {
          if (!prepared) switchingEnvironment = false
        }
      }
    }
  })
}

const probeOnly = process.env.PI_GUI_PROBE_ONLY === '1'
const canStartApplication = probeOnly || app.requestSingleInstanceLock()

if (process.platform === 'linux' && process.env.PI_GUI_DESKTOP_HOST_MANAGED === '1' && process.env.PI_GUI_DESKTOP_HOST_ENABLED === '1') {
  // The foreground Host launcher uses the existing before-quit drain on interruption.
  process.on('SIGINT', () => app.quit())
  process.on('SIGTERM', () => app.quit())
}

if (!canStartApplication) {
  allowQuit = true
  app.exit(0)
} else {
  if (!probeOnly) {
    app.on('second-instance', () => {
      if (allowQuit || shutdownPromise !== null) return
      const window = mainWindow
      if (window === null || window.isDestroyed()) return
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
    })
  }

  void app.whenReady().then(startApplication).catch((error: unknown) => {
    const message = errorMessage(error)
    console.error(`[Pi GUI] Startup failed: ${message}`)
    app.exit(1)
  })

  app.on('window-all-closed', () => {
    if (!wslHostMode) app.quit()
  })

  app.on('before-quit', (event) => {
    if (allowQuit) {
      return
    }

    event.preventDefault()
    shutdownPromise ??= stopKernel()
      .then(() => {
        allowQuit = true
        app.quit()
      })
      .catch((error: unknown) => {
        const message = errorMessage(error)
        console.error(`[Pi GUI] Shutdown failed: ${message}`)
        app.exit(1)
      })
  })
}

function forwardKernelEvent(event: KernelEvent): void {
  kernelEventForwarder.forward(event)
}

function sendKernelEvent(event: KernelEvent): void {
  wslHostPipe?.publish(KERNEL_EVENT_CHANNEL, event)
  const window = mainWindow
  if (window !== null && !window.isDestroyed()) {
    window.webContents.send(KERNEL_EVENT_CHANNEL, event)
  }
  remoteGateway?.publish(event)
  desktopHostGateway?.publish(event)
}

function sendDesktopClientStatus(status: DesktopClientStatus): void {
  const window = mainWindow
  if (window !== null && !window.isDestroyed()) {
    window.webContents.send(DESKTOP_CLIENT_STATUS_CHANNEL, status)
  }
}

function forwardProviderAuthEvent(event: KernelProviderAuthEvent): void {
  wslHostPipe?.publish(PROVIDER_AUTH_EVENT_CHANNEL, event)
  if (mainWindow === null || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(PROVIDER_AUTH_EVENT_CHANNEL, event)
}

async function startDesktopNotificationBroker(projectStore: ProjectStore): Promise<void> {
  let candidate: DesktopNotificationBroker | null = null
  try {
    candidate = createDesktopNotificationBroker({
      ...(wslNotificationPresenter === null ? {} : { presenter: wslNotificationPresenter }),
      iconPath: app.isPackaged
        ? join(process.resourcesPath, 'pi-notify.png')
        : join(mainBundleDirectory, '../../extensions/pi-gui-task-notify/assets/pi-notify.png'),
      activateTarget: async (target) => {
        const activeKernel = kernel
        if (activeKernel === null) throw new Error('Workbench kernel is unavailable.')
        await activateDesktopNotificationTarget(target, {
          projectStore,
          kernel: activeKernel,
          isAvailable: () =>
            !allowQuit && shutdownPromise === null && kernel === activeKernel,
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

function focusMainWindow(): void {
  if (wslHostMode) {
    if (wslHostPipe === null) throw new Error('WSL desktop is not connected.')
    void wslHostPipe.request(WSL_DESKTOP_CHANNEL, { type: 'window.focus' }).catch((error) => {
      console.error(`[Pi GUI] WSL window focus failed: ${errorMessage(error)}`)
    })
    return
  }
  const window = mainWindow
  if (window === null || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
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
    staticRoot: join(mainBundleDirectory, '../remote'),
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
      return await gateway.revokeDevice()
    }
    default: {
      const exhaustive: never = command
      throw new Error(`Unsupported remote admin command: ${JSON.stringify(exhaustive)}`)
    }
  }
}

async function stopKernel(): Promise<void> {
  const remoteSession = windowsRemoteSession
  windowsRemoteSession = null
  if (remoteSession !== null) await remoteSession.close()
  clientNotifications?.close()
  clientNotifications = null
  const backend = wslBackend
  wslBackend = null
  if (backend !== null) await backend.close()
  wslHostPipe?.close()
  await packageInstallDrain
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
  if (kernelStopError !== null) throw kernelStopError
  const sharedPiHostStopError = await activeSharedPiHost?.dispose().then(
    () => null,
    (error: unknown) => error
  ) ?? null
  if (sharedPiHostStopError !== null) throw sharedPiHostStopError
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
}

function requireProviderAuth(): PiProviderAuth {
  if (providerAuth === null) throw new Error('Provider authentication is unavailable.')
  return providerAuth
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

async function pickOpenDirectory(): Promise<string | null> {
  if (wslHostMode) return null
  const selection = mainWindow === null
    ? await dialog.showOpenDialog({ properties: ['openDirectory'] })
    : await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
  const selectedPath = selection.filePaths[0]
  if (selection.canceled || selectedPath === undefined) return null
  return selectedPath
}

async function bindWslClientDialogCommand(
  distribution: string,
  command: KernelCommand
): Promise<KernelCommand> {
  if (command.type === 'kernel.add-project' && command.projectPath === undefined) {
    const selectedPath = await pickOpenDirectory()
    if (selectedPath === null) return command
    return {
      type: 'kernel.add-project',
      projectPath: await resolveWslFilePath(distribution, selectedPath)
    }
  }
  if (command.type === 'kernel.select-prompt-attachments' && command.filePaths === undefined) {
    const options: OpenDialogOptions = {
      title: '选择附件',
      properties: ['openFile', 'multiSelections']
    }
    const selection = mainWindow === null
      ? await dialog.showOpenDialog(options)
      : await dialog.showOpenDialog(mainWindow, options)
    if (selection.canceled || selection.filePaths.length === 0) return command
    return {
      type: 'kernel.select-prompt-attachments',
      filePaths: await Promise.all(
        selection.filePaths.map((path) => resolveWslFilePath(distribution, path))
      )
    }
  }
  if (command.type === 'kernel.export-session' && command.filePath === undefined) {
    const selectedPath = await pickSaveHtmlPath(null)
    if (selectedPath === null) return command
    return {
      type: 'kernel.export-session',
      filePath: await resolveWslFilePath(distribution, selectedPath)
    }
  }
  if (command.type === 'kernel.install-extension' && command.path === undefined) {
    const selectedPath = await pickExtensionPath(command.kind)
    if (selectedPath === null) return command
    return {
      type: 'kernel.install-extension',
      kind: command.kind,
      path: await resolveWslFilePath(distribution, selectedPath)
    }
  }
  return command
}

async function pickExtensionPath(kind: KernelExtensionSelectionKind): Promise<string | null> {
  if (wslHostMode) return null
  const options: OpenDialogOptions = kind === 'file'
    ? {
        title: '选择 Pi Extension 文件',
        properties: ['openFile'],
        filters: [{ name: 'Pi Extension', extensions: ['ts', 'js'] }]
      }
    : {
        title: '选择 Pi Extension 目录',
        properties: ['openDirectory']
      }
  const selection = mainWindow === null
    ? await dialog.showOpenDialog(options)
    : await dialog.showOpenDialog(mainWindow, options)
  const selectedPath = selection.filePaths[0]
  if (selection.canceled || selectedPath === undefined) return null
  return selectedPath
}

async function pickSaveHtmlPath(title: string | null): Promise<string | null> {
  const options = {
    title: '导出会话为 HTML',
    defaultPath: sessionExportFileName(title),
    filters: [{ name: 'HTML', extensions: ['html'] }]
  }
  const selection = mainWindow === null
    ? await dialog.showSaveDialog(options)
    : await dialog.showSaveDialog(mainWindow, options)
  if (selection.canceled || selection.filePath === undefined) return null
  return selection.filePath
}

function sessionExportFileName(title: string | null): string {
  const base = (title ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 80)
  return `${base.length === 0 ? 'pi-session' : base}.html`
}

function sameSessionExportIdentity(
  first: { projectKey: string, sessionKey: string, sessionId: string },
  second: { projectKey: string, sessionKey: string, sessionId: string }
): boolean {
  return first.projectKey === second.projectKey &&
    first.sessionKey === second.sessionKey &&
    first.sessionId === second.sessionId
}

function assertTrustedIpcSender(event: IpcMainInvokeEvent, rendererTarget: RendererTarget): void {
  if (switchingEnvironment) throw new Error('Desktop environment is restarting.')
  if (
    mainWindow === null ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame ||
    !isAllowedRendererUrl(rendererTarget, event.senderFrame.url)
  ) {
    throw new Error('Kernel commands are only accepted from the Pi GUI renderer.')
  }
}

function isSubagentPackageEnabled(
  packages: readonly { packageName: string | null, extensionEnabled: boolean }[]
): boolean {
  return packages.some((pkg) =>
    pkg.packageName === SUBAGENT_PACKAGE_NAME && pkg.extensionEnabled
  )
}
