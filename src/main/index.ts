import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'

import {
  KERNEL_COMMAND_CHANNEL,
  KERNEL_EVENT_CHANNEL,
  OPEN_EXTERNAL_CHANNEL,
  type KernelCommand,
  type KernelEvent,
  type SessionNamingSettings,
  type ThinkingLevel
} from '../shared/kernel-contract.ts'
import { normalizeExternalUrl } from '../shared/external-url.ts'
import { WorkbenchKernel } from './kernel/workbench-kernel.ts'
import { ProjectStore } from './project/project-store.ts'
import { LinuxLocalRuntime, probePiRpc } from './runtime/linux-local-runtime.ts'
import { generateSessionNameWithPi } from './runtime/session-name-generator.ts'
import { errorMessage } from './utils/errors.ts'
import { isRecord } from './utils/guards.ts'
import {
  isAllowedRendererUrl,
  resolveRendererTarget,
  type RendererTarget
} from './security/renderer-security.ts'

let mainWindow: BrowserWindow | null = null
let kernel: WorkbenchKernel | null = null
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
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  mainWindow = window

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
    rendererFilePath: join(__dirname, '../renderer/index.html')
  })
  const projectStore = new ProjectStore()
  const storedProjects = await projectStore.loadProjects()
  const sessionNaming = await projectStore.loadSessionNaming()
  const sessionRegistry = storedProjects.activeProjectKey === null
    ? { sessions: [], activeSessionKey: null }
    : await projectStore.loadSessionRegistry(storedProjects.activeProjectKey)
  kernel = new WorkbenchKernel(
    (project, launchOptions) =>
      new LinuxLocalRuntime({
        cwd: project.path,
        explicitExecutable: process.env.PI_GUI_PI_EXECUTABLE,
        sessionFile: launchOptions.sessionFile
      }),
    storedProjects,
    {
      sessionRegistry,
      persistProject: async (project) => {
        await projectStore.addProject(project)
      },
      persistActiveProject: async (projectKey) => {
        await projectStore.activateProject(projectKey)
      },
      persistSession: (pointer) => projectStore.saveSession(pointer),
      validateSession: (pointer) => projectStore.validateSession(pointer),
      readSessionActivityAt: (pointer) => projectStore.sessionActivityAt(pointer.sessionFile),
      sessionNaming,
      persistSessionNaming: (settings) => projectStore.saveSessionNaming(settings),
      generateSessionName: generateSessionNameWithPi
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
        return kernel.getState()
      case 'kernel.add-project': {
        const selection = mainWindow === null
          ? await dialog.showOpenDialog({ properties: ['openDirectory'] })
          : await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
        const selectedPath = selection.filePaths[0]
        if (selection.canceled || selectedPath === undefined) return kernel.getState()
        const projectPath = await projectStore.validateProjectPath(selectedPath)
        await kernel.addProject(projectPath, await projectStore.loadSessionRegistry(projectPath))
        return kernel.getState()
      }
      case 'kernel.activate-project': {
        const projectPath = await projectStore.validateProjectPath(command.projectKey)
        if (projectPath !== command.projectKey) {
          throw new Error(`Registered project path no longer resolves canonically: ${command.projectKey}`)
        }
        await kernel.activateProject(projectPath, await projectStore.loadSessionRegistry(projectPath))
        return kernel.getState()
      }
      case 'kernel.start-session': {
        const project = configuredProject(kernel.getState())
        const canonicalPath = await projectStore.validateProjectPath(project.path)
        if (canonicalPath !== project.path) {
          throw new Error(`Active project path no longer resolves canonically: ${project.path}`)
        }
        await kernel.start()
        return kernel.getState()
      }
      case 'kernel.activate-session': {
        const project = configuredProject(kernel.getState())
        const canonicalPath = await projectStore.validateProjectPath(project.path)
        if (canonicalPath !== project.path) {
          throw new Error(`Active project path no longer resolves canonically: ${project.path}`)
        }
        await kernel.activateSession(command.sessionKey)
        return kernel.getState()
      }
      case 'kernel.prompt':
        await kernel.prompt(command.message)
        return kernel.getState()
      case 'kernel.abort':
        await kernel.abort()
        return kernel.getState()
      case 'kernel.set-model':
        await kernel.setModel(command.provider, command.modelId)
        return kernel.getState()
      case 'kernel.set-thinking-level':
        await kernel.setThinkingLevel(command.level)
        return kernel.getState()
      case 'kernel.set-session-naming':
        await kernel.setSessionNaming(command.settings)
        return kernel.getState()
      case 'kernel.invoke-command':
        await kernel.invokeCommand(command.commandId, command.argument)
        return kernel.getState()
    }
  })
  ipcMain.handle(OPEN_EXTERNAL_CHANNEL, async (event, value: unknown) => {
    assertTrustedIpcSender(event, rendererTarget)
    if (typeof value !== 'string') throw new Error('External link must be a URL string.')
    const url = normalizeExternalUrl(value)
    if (url === null) throw new Error('External link protocol is not allowed.')
    await shell.openExternal(url)
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

function isKernelCommand(value: unknown): value is KernelCommand {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  if (
    value.type === 'kernel.get-state' ||
    value.type === 'kernel.add-project' ||
    value.type === 'kernel.start-session' ||
    value.type === 'kernel.abort'
  ) {
    return Object.keys(value).length === 1
  }
  if (value.type === 'kernel.activate-project') {
    return typeof value.projectKey === 'string' && Object.keys(value).length === 2
  }
  if (value.type === 'kernel.activate-session') {
    return typeof value.sessionKey === 'string' && Object.keys(value).length === 2
  }
  if (value.type === 'kernel.prompt') {
    return typeof value.message === 'string' && Object.keys(value).length === 2
  }
  if (value.type === 'kernel.set-model') {
    return (
      typeof value.provider === 'string' &&
      typeof value.modelId === 'string' &&
      Object.keys(value).length === 3
    )
  }
  if (value.type === 'kernel.invoke-command') {
    return (
      typeof value.commandId === 'string' &&
      typeof value.argument === 'string' &&
      Object.keys(value).length === 3
    )
  }
  if (value.type === 'kernel.set-session-naming') {
    return isSessionNamingSettings(value.settings) && Object.keys(value).length === 2
  }
  return (
    value.type === 'kernel.set-thinking-level' &&
    isThinkingLevel(value.level) &&
    Object.keys(value).length === 2
  )
}

function isSessionNamingSettings(value: unknown): value is SessionNamingSettings {
  if (!isRecord(value) || typeof value.mode !== 'string') return false
  if (value.mode === 'auto' || value.mode === 'off') {
    return Object.keys(value).length === 1
  }
  return value.mode === 'model' &&
    Object.keys(value).length === 3 &&
    typeof value.provider === 'string' &&
    value.provider.trim().length > 0 &&
    typeof value.modelId === 'string' &&
    value.modelId.trim().length > 0
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return (
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max'
  )
}

async function stopKernel(): Promise<void> {
  if (kernel === null) {
    return
  }
  await kernel.stop()
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
