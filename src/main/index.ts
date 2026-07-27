import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  shell,
  type IpcMainInvokeEvent,
  type OpenDialogOptions
} from 'electron'
import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
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
  WINDOW_TOGGLE_FULLSCREEN_CHANNEL,
  WINDOW_TOGGLE_MAXIMIZE_CHANNEL,
  SUBAGENT_PACKAGE_NAME,
  type KernelEvent,
  type KernelProviderAuthEvent
} from '../shared/kernel-contract.ts'
import { normalizeExternalUrl } from '../shared/external-url.ts'
import { AdvisorDefinitionStore } from './advisor/advisor-definition-store.ts'
import { PiExtensionStore } from './extension/pi-extension-store.ts'
import { PiDevPackageService } from './extension/pi-dev-package-service.ts'
import { createSessionExportHtml } from './export/session-export-html.ts'
import { isKernelCommand } from './kernel/kernel-command-validation.ts'
import { WorkbenchKernel } from './kernel/workbench-kernel.ts'
import { readPromptAttachments } from './prompt/prompt-attachment-selection.ts'
import { PiProviderStore } from './provider/pi-provider-store.ts'
import { PiProviderAuth } from './provider/pi-provider-auth.ts'
import { fetchLiteLlmModelPricing } from './provider/litellm-model-pricing.ts'
import { testProviderConnection } from './provider/provider-connection-test.ts'
import { ProjectStore } from './project/project-store.ts'
import { searchProjectPaths } from './project/project-path-search.ts'
import { readSessionStatistics } from './project/session-statistics.ts'
import { readSessionActivityAt, readSessionMessages } from './project/session-transcript.ts'
import { LinuxLocalRuntime, probePiRpc } from './runtime/linux-local-runtime.ts'
import { generateSessionNameWithPi } from './runtime/session-name-generator.ts'
import { errorMessage } from './utils/errors.ts'
import { PiProjectTrust } from './security/pi-project-trust.ts'
import { SubagentDefinitionStore } from './subagent/subagent-definition-store.ts'
import {
  isAllowedRendererUrl,
  resolveRendererTarget,
  type RendererTarget
} from './security/renderer-security.ts'

const mainBundleDirectory = dirname(fileURLToPath(import.meta.url))

let mainWindow: BrowserWindow | null = null
let kernel: WorkbenchKernel | null = null
let providerAuth: PiProviderAuth | null = null
let shutdownPromise: Promise<void> | null = null
let allowQuit = false

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
    webPreferences: {
      preload: join(mainBundleDirectory, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  mainWindow = window

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
}

async function startApplication(): Promise<void> {
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
  const general = await projectStore.loadGeneral()
  const storedProjects = await projectStore.loadProjects()
  const sessionNaming = await projectStore.loadSessionNaming()
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
  const subagentDefinitionStore = new SubagentDefinitionStore()
  const advisorDefinitionStore = new AdvisorDefinitionStore()
  let subagentPackageEnabled = isSubagentPackageEnabled(await piDevPackageService.list())
  const refreshSubagentPackageEnabled = async (): Promise<void> => {
    subagentPackageEnabled = isSubagentPackageEnabled(await piDevPackageService.list())
  }
  const projectTrust = new PiProjectTrust({
    explicitExecutable: process.env.PI_GUI_PI_EXECUTABLE
  })
  const extensions = await extensionStore.list()
  const sessionRegistries = new Map(await Promise.all(
    storedProjects.projects.map(async (project) => [
      project.path,
      await projectStore.loadSessionRegistry(project.path)
    ] as const)
  ))
  const projects = storedProjects.projects.map((project) => ({
    ...project,
    sessionCount: sessionRegistries.get(project.path)?.sessions.length ?? 0,
    unreadCount: 0
  }))
  const projectRegistry = general.startupWorkspaceRestore === 'restore'
    ? { projects, activeProjectKey: storedProjects.activeProjectKey }
    : { projects, activeProjectKey: null }
  const sessionRegistry = projectRegistry.activeProjectKey === null
    ? { sessions: [], activeSessionKey: null }
    : sessionRegistries.get(projectRegistry.activeProjectKey) ?? { sessions: [], activeSessionKey: null }
  kernel = new WorkbenchKernel(
    (project, launchOptions) =>
      new LinuxLocalRuntime({
        cwd: project.path,
        explicitExecutable: process.env.PI_GUI_PI_EXECUTABLE,
        sessionFile: launchOptions.sessionFile,
        projectTrust: launchOptions.projectTrust,
        fastExtensionLoading: launchOptions.fastExtensionLoading,
        ...(subagentPackageEnabled ? { subagent: launchOptions.subagent } : {})
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
      persistSession: (pointer) => projectStore.saveSession(pointer),
      persistArchivedSession: (projectPath, sessionKey) =>
        projectStore.archiveSession(projectPath, sessionKey),
      restoreArchivedSession: (projectPath, sessionKey) =>
        projectStore.restoreArchivedSession(projectPath, sessionKey),
      validateSession: (pointer) => projectStore.validateSession(pointer),
      readSessionActivityAt,
      readSessionStatistics,
      readSessionMessages,
      persistProjectOrder: (projectKeys) => projectStore.reorderProjects(projectKeys),
      sessionNaming,
      persistSessionNaming: (settings) => projectStore.saveSessionNaming(settings),
      appearance,
      persistAppearance: (settings) => projectStore.saveAppearance(settings),
      general,
      persistGeneral: (settings) => projectStore.saveGeneral(settings),
      subagent,
      persistSubagent: (settings) => projectStore.saveSubagent(settings),
      shortcuts,
      persistShortcuts: (settings) => projectStore.saveShortcuts(settings),
      generateSessionName: generateSessionNameWithPi,
      projectTrust
    }
  )
  await kernel.refreshSessionActivities()
  kernel.subscribe(forwardKernelEvent)
  ipcMain.handle(KERNEL_COMMAND_CHANNEL, async (event, command: unknown) => {
    assertTrustedIpcSender(event, rendererTarget)
    if (!isKernelCommand(command)) {
      throw new Error('Unsupported kernel command.')
    }
    if (kernel === null) {
      throw new Error('Workbench kernel is unavailable.')
    }
    switch (command.type) {
      case 'kernel.get-state':
        return kernel.getSnapshot()
      case 'kernel.list-system-fonts':
        return listSystemFonts()
      case 'kernel.add-project': {
        const selection = mainWindow === null
          ? await dialog.showOpenDialog({ properties: ['openDirectory'] })
          : await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
        const selectedPath = selection.filePaths[0]
        if (selection.canceled || selectedPath === undefined) return kernel.acknowledge()
        const projectPath = await projectStore.validateProjectPath(selectedPath)
        await kernel.addProject(projectPath, await projectStore.loadSessionRegistry(projectPath))
        return kernel.acknowledge()
      }
      case 'kernel.activate-project': {
        const projectPath = await projectStore.validateProjectPath(command.projectKey)
        if (projectPath !== command.projectKey) {
          throw new Error(`Registered project path no longer resolves canonically: ${command.projectKey}`)
        }
        await kernel.activateProject(projectPath, await projectStore.loadSessionRegistry(projectPath))
        return kernel.acknowledge()
      }
      case 'kernel.start-session': {
        const project = configuredProject(kernel.getState())
        const canonicalPath = await projectStore.validateProjectPath(project.path)
        if (canonicalPath !== project.path) {
          throw new Error(`Active project path no longer resolves canonically: ${project.path}`)
        }
        await kernel.start()
        return kernel.acknowledge()
      }
      case 'kernel.reload-session':
        await kernel.reloadSession()
        return kernel.acknowledge()
      case 'kernel.resolve-project-trust':
        await kernel.resolveProjectTrust(command.requestId, command.choice)
        return kernel.acknowledge()
      case 'kernel.activate-session': {
        const project = configuredProject(kernel.getState())
        const canonicalPath = await projectStore.validateProjectPath(project.path)
        if (canonicalPath !== project.path) {
          throw new Error(`Active project path no longer resolves canonically: ${project.path}`)
        }
        await kernel.activateSession(command.sessionKey)
        return kernel.acknowledge()
      }
      case 'kernel.archive-session': {
        const receipt = await kernel.archiveSession(command.sessionKey)
        return { ...kernel.acknowledge(), receipt }
      }
      case 'kernel.undo-archive-session':
        await kernel.undoArchiveSession(command.token)
        return kernel.acknowledge()
      case 'kernel.preview-session':
        return kernel.previewSession(command.sessionKey)
      case 'kernel.preview-archived-session':
        return kernel.previewArchivedSession(command.token)
      case 'kernel.list-fork-candidates':
        return kernel.listForkCandidates()
      case 'kernel.fork-session': {
        const result = await kernel.forkSession(command.entryId)
        return { ...kernel.acknowledge(), ...result }
      }
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
      case 'kernel.export-session': {
        const preparation = await kernel.prepareSessionExport()
        const options = {
          title: '导出会话为 HTML',
          defaultPath: sessionExportFileName(preparation.title),
          filters: [{ name: 'HTML', extensions: ['html'] }]
        }
        const selection = mainWindow === null
          ? await dialog.showSaveDialog(options)
          : await dialog.showSaveDialog(mainWindow, options)
        if (selection.canceled || selection.filePath === undefined) return { saved: false }
        const confirmed = await kernel.prepareSessionExport()
        if (!sameSessionExportIdentity(preparation, confirmed)) {
          throw new Error('Session export cancelled because the active session changed.')
        }
        await writeFile(
          selection.filePath,
          createSessionExportHtml({ title: confirmed.title, messages: confirmed.messages }),
          'utf8'
        )
        return { saved: true }
      }
      case 'kernel.search-project-paths': {
        const project = configuredProject(kernel.getState())
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
        const options: OpenDialogOptions = command.kind === 'file'
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
        if (selection.canceled || selectedPath === undefined) return kernel.acknowledge()
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
      case 'kernel.install-pi-dev-package':
        await piDevPackageService.install(command.name)
        if (command.name === SUBAGENT_PACKAGE_NAME) await refreshSubagentPackageEnabled()
        return kernel.acknowledge()
      case 'kernel.remove-pi-package':
        await piDevPackageService.remove(command.source)
        if (isSubagentPackageSource(command.source)) await refreshSubagentPackageEnabled()
        return kernel.acknowledge()
      case 'kernel.set-subagent-enabled': {
        const packages = await piDevPackageService.setExtensionEnabled(
          `npm:${SUBAGENT_PACKAGE_NAME}`,
          command.enabled
        )
        subagentPackageEnabled = isSubagentPackageEnabled(packages)
        return packages
      }
      case 'kernel.set-magic-context-enabled':
        return piDevPackageService.setExtensionEnabled(
          `npm:${MAGIC_CONTEXT_PACKAGE_NAME}`,
          command.enabled
        )
      case 'kernel.set-advisor-system-enabled':
        await kernel.setAdvisorSystemEnabled(command.enabled)
        return kernel.acknowledge()
      case 'kernel.set-advisor-extension-enabled': {
        const matches = (await piDevPackageService.list()).filter(({ source }) =>
          isAdvisorPackageSource(source)
        )
        if (matches.length !== 1) {
          throw new Error('Advisor package extension source must resolve uniquely.')
        }
        return piDevPackageService.setExtensionEnabled(matches[0]!.source, command.enabled)
      }
      case 'kernel.list-advisor-definitions': {
        const projectPath = await activeProjectPath(kernel, projectStore)
        return advisorDefinitionStore.list(projectPath)
      }
      case 'kernel.save-advisor-definition': {
        const projectPath = await activeProjectPath(kernel, projectStore)
        return advisorDefinitionStore.save(projectPath, command.definition)
      }
      case 'kernel.remove-advisor-definition': {
        const projectPath = await activeProjectPath(kernel, projectStore)
        return advisorDefinitionStore.remove(projectPath, command.slug, command.scope)
      }
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
      case 'kernel.prompt':
        await kernel.prompt(command.message, command.attachments)
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
      case 'kernel.invoke-command':
        await kernel.invokeCommand(command.commandId, command.argument)
        return kernel.acknowledge()
    }
  })
  ipcMain.handle(OPEN_EXTERNAL_CHANNEL, async (event, value: unknown) => {
    assertTrustedIpcSender(event, rendererTarget)
    if (typeof value !== 'string') throw new Error('External link must be a URL string.')
    const url = normalizeExternalUrl(value)
    if (url === null) throw new Error('External link protocol is not allowed.')
    await shell.openExternal(url)
  })
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

  await createMainWindow(rendererTarget)
}

const probeOnly = process.env.PI_GUI_PROBE_ONLY === '1'
const canStartApplication = probeOnly || app.requestSingleInstanceLock()

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
    app.quit()
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
  if (mainWindow === null || mainWindow.isDestroyed()) {
    return
  }
  mainWindow.webContents.send(KERNEL_EVENT_CHANNEL, event)
}

function forwardProviderAuthEvent(event: KernelProviderAuthEvent): void {
  if (mainWindow === null || mainWindow.isDestroyed()) return
  mainWindow.webContents.send(PROVIDER_AUTH_EVENT_CHANNEL, event)
}

async function listSystemFonts(): Promise<string[]> {
  if (process.platform !== 'linux') {
    throw new Error('System font discovery is only available on Linux.')
  }

  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      'fc-list',
      ['--format', '%{family[0]}\n'],
      { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
      (error, output) => {
        if (error !== null) {
          reject(new Error(`Failed to list system fonts: ${errorMessage(error)}`))
          return
        }
        resolve(output)
      }
    )
  })
  const fonts = [...new Set(
    stdout
      .split(/\r?\n/)
      .map((font) => font.trim())
      .filter((font) => font.length > 0)
  )].sort()

  if (fonts.length === 0) {
    throw new Error('System font discovery returned no fonts.')
  }
  return fonts
}

async function stopKernel(): Promise<void> {
  await providerAuth?.shutdown()
  await kernel?.stop()
}

function requireProviderAuth(): PiProviderAuth {
  if (providerAuth === null) throw new Error('Provider authentication is unavailable.')
  return providerAuth
}

function configuredProject(state: {
  projects: Array<{ path: string }>
  activeProjectKey: string | null
}): { path: string } {
  if (state.activeProjectKey === null) throw new Error('Select a project directory before starting.')
  const project = state.projects.find(({ path }) => path === state.activeProjectKey)
  if (project === undefined) throw new Error('Active project is not registered.')
  return project
}

async function activeProjectPath(
  activeKernel: WorkbenchKernel,
  projectStore: ProjectStore
): Promise<string | null> {
  const state = activeKernel.getState()
  if (state.activeProjectKey === null) return null
  const project = configuredProject(state)
  const canonicalPath = await projectStore.validateProjectPath(project.path)
  if (canonicalPath !== project.path) {
    throw new Error(`Active project path no longer resolves canonically: ${project.path}`)
  }
  return canonicalPath
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
  packages: readonly { source: string, extensionEnabled: boolean }[]
): boolean {
  return packages.some((pkg) => isSubagentPackageSource(pkg.source) && pkg.extensionEnabled)
}

function isSubagentPackageSource(source: string): boolean {
  const base = `npm:${SUBAGENT_PACKAGE_NAME}`
  return source === base || source.startsWith(`${base}@`)
}

function isAdvisorPackageSource(source: string): boolean {
  if (source === 'pi-gui-multi-advisor') return true
  if (/^npm:pi-gui-multi-advisor(?:@[^/]+)?$/u.test(source)) return true
  if (!isLocalPackageSource(source)) return false
  const normalized = source.replace(/[\\/]+$/u, '')
  return normalized.length > 0 && basename(normalized) === 'pi-gui-multi-advisor'
}

function isLocalPackageSource(source: string): boolean {
  return source.startsWith('/') ||
    source.startsWith('./') ||
    source.startsWith('../') ||
    source.startsWith('~/') ||
    source.startsWith('\\\\') ||
    /^[a-z]:[\\/]/iu.test(source) ||
    (!/^[a-z][a-z0-9+.-]*:/iu.test(source) && /[\\/]/u.test(source))
}
