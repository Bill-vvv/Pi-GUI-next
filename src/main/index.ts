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
import { join } from 'node:path'

import {
  KERNEL_COMMAND_CHANNEL,
  KERNEL_EVENT_CHANNEL,
  KERNEL_PROVIDER_APIS,
  OPEN_EXTERNAL_CHANNEL,
  type AppearanceSettings,
  type GeneralSettings,
  type KernelCommand,
  type KernelEvent,
  type KernelPromptAttachment,
  type KernelProviderInput,
  type SessionNamingSettings,
  type ThinkingLevel
} from '../shared/kernel-contract.ts'
import { normalizeExternalUrl } from '../shared/external-url.ts'
import { PiExtensionStore } from './extension/pi-extension-store.ts'
import { PiDevPackageService } from './extension/pi-dev-package-service.ts'
import { WorkbenchKernel } from './kernel/workbench-kernel.ts'
import { readPromptAttachments } from './prompt/prompt-attachment-selection.ts'
import { PiProviderStore } from './provider/pi-provider-store.ts'
import { testProviderConnection } from './provider/provider-connection-test.ts'
import { ProjectStore } from './project/project-store.ts'
import { readSessionMessages } from './project/session-transcript.ts'
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
const MAX_PROMPT_IMAGE_BASE64_CHARS = 4.5 * 1024 * 1024

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
  const general = await projectStore.loadGeneral()
  const storedProjects = await projectStore.loadProjects()
  const sessionNaming = await projectStore.loadSessionNaming()
  const appearance = await projectStore.loadAppearance()
  const extensionStore = new PiExtensionStore()
  const providerStore = new PiProviderStore()
  const piDevPackageService = new PiDevPackageService({
    piExecutablePath: process.env.PI_GUI_PI_EXECUTABLE,
    fetch: (input, init) => net.fetch(input instanceof URL ? input.toString() : input, init)
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
        sessionFile: launchOptions.sessionFile
      }),
    projectRegistry,
    {
      sessionRegistry,
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
      validateSession: (pointer) => projectStore.validateSession(pointer),
      readSessionActivityAt: (pointer) => projectStore.sessionActivityAt(pointer.sessionFile),
      readSessionMessages,
      persistProjectOrder: (projectKeys) => projectStore.reorderProjects(projectKeys),
      persistSessionOrder: (projectPath, sessionKeys) =>
        projectStore.reorderSessions(projectPath, sessionKeys),
      sessionNaming,
      persistSessionNaming: (settings) => projectStore.saveSessionNaming(settings),
      appearance,
      persistAppearance: (settings) => projectStore.saveAppearance(settings),
      general,
      persistGeneral: (settings) => projectStore.saveGeneral(settings),
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
      case 'kernel.list-system-fonts':
        return listSystemFonts()
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
      case 'kernel.archive-session':
        await kernel.archiveSession(command.sessionKey)
        return kernel.getState()
      case 'kernel.preview-session':
        return kernel.previewSession(command.sessionKey)
      case 'kernel.reorder-projects':
        await kernel.reorderProjects(command.projectKeys)
        return kernel.getState()
      case 'kernel.reorder-sessions':
        await kernel.reorderSessions(command.sessionKeys)
        return kernel.getState()
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
        if (selection.canceled || selectedPath === undefined) return kernel.getState()
        kernel.setExtensions(await extensionStore.install(selectedPath))
        return kernel.getState()
      }
      case 'kernel.remove-extension':
        kernel.setExtensions(await extensionStore.remove(command.path))
        return kernel.getState()
      case 'kernel.search-pi-dev-extensions':
        return piDevPackageService.catalog(command.query, 'extension')
      case 'kernel.search-pi-dev-packages':
        return piDevPackageService.catalog(command.query)
      case 'kernel.list-pi-packages':
        return piDevPackageService.list()
      case 'kernel.install-pi-dev-package':
        await piDevPackageService.install(command.name)
        return kernel.getState()
      case 'kernel.remove-pi-package':
        await piDevPackageService.remove(command.source)
        return kernel.getState()
      case 'kernel.update-pi-package':
        await piDevPackageService.update(command.source)
        return kernel.getState()
      case 'kernel.update-pi-packages':
        await piDevPackageService.update()
        return kernel.getState()
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
        return kernel.getState()
      case 'kernel.steer':
        await kernel.steer(command.message, command.attachments)
        return kernel.getState()
      case 'kernel.follow-up':
        await kernel.followUp(command.message, command.attachments)
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
      case 'kernel.set-appearance':
        await kernel.setAppearance(command.settings)
        return kernel.getState()
      case 'kernel.set-general':
        await kernel.setGeneral(command.settings)
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
    value.type === 'kernel.list-system-fonts' ||
    value.type === 'kernel.add-project' ||
    value.type === 'kernel.start-session' ||
    value.type === 'kernel.select-prompt-attachments' ||
    value.type === 'kernel.abort' ||
    value.type === 'kernel.list-providers' ||
    value.type === 'kernel.list-pi-packages' ||
    value.type === 'kernel.update-pi-packages'
  ) {
    return Object.keys(value).length === 1
  }
  if (value.type === 'kernel.activate-project') {
    return typeof value.projectKey === 'string' && Object.keys(value).length === 2
  }
  if (
    value.type === 'kernel.activate-session' ||
    value.type === 'kernel.archive-session' ||
    value.type === 'kernel.preview-session'
  ) {
    return typeof value.sessionKey === 'string' && Object.keys(value).length === 2
  }
  if (value.type === 'kernel.reorder-projects') {
    return isStringArray(value.projectKeys) && Object.keys(value).length === 2
  }
  if (value.type === 'kernel.reorder-sessions') {
    return isStringArray(value.sessionKeys) && Object.keys(value).length === 2
  }
  if (value.type === 'kernel.install-extension') {
    return (value.kind === 'file' || value.kind === 'directory') && Object.keys(value).length === 2
  }
  if (value.type === 'kernel.remove-extension') {
    return typeof value.path === 'string' && Object.keys(value).length === 2
  }
  if (
    value.type === 'kernel.search-pi-dev-extensions' ||
    value.type === 'kernel.search-pi-dev-packages'
  ) {
    return typeof value.query === 'string' && Object.keys(value).length === 2
  }
  if (value.type === 'kernel.install-pi-dev-package') {
    return typeof value.name === 'string' && Object.keys(value).length === 2
  }
  if (value.type === 'kernel.remove-pi-package' || value.type === 'kernel.update-pi-package') {
    return typeof value.source === 'string' && Object.keys(value).length === 2
  }
  if (value.type === 'kernel.save-provider') {
    return isProviderInput(value.provider) && Object.keys(value).length === 2
  }
  if (value.type === 'kernel.remove-provider') {
    return typeof value.providerId === 'string' && Object.keys(value).length === 2
  }
  if (value.type === 'kernel.test-provider') {
    return (
      typeof value.providerId === 'string' &&
      typeof value.modelId === 'string' &&
      Object.keys(value).length === 3
    )
  }
  if (
    value.type === 'kernel.prompt' ||
    value.type === 'kernel.steer' ||
    value.type === 'kernel.follow-up'
  ) {
    return typeof value.message === 'string' &&
      (
        Object.keys(value).length === 2 ||
        (
          Object.keys(value).length === 3 &&
          Array.isArray(value.attachments) &&
          value.attachments.length > 0 &&
          value.attachments.every(isPromptAttachment)
        )
      )
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
  if (value.type === 'kernel.set-appearance') {
    return isAppearanceSettings(value.settings) && Object.keys(value).length === 2
  }
  if (value.type === 'kernel.set-general') {
    return isGeneralSettings(value.settings) && Object.keys(value).length === 2
  }
  return (
    value.type === 'kernel.set-thinking-level' &&
    isThinkingLevel(value.level) &&
    Object.keys(value).length === 2
  )
}

function isPromptAttachment(value: unknown): value is KernelPromptAttachment {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  if (value.type === 'file') {
    return Object.keys(value).length === 3 &&
      isNonEmptyString(value.name) &&
      isNonEmptyString(value.path)
  }
  return value.type === 'image' &&
    Object.keys(value).length === 5 &&
    isNonEmptyString(value.name) &&
    isNonEmptyString(value.path) &&
    Array.isArray(value.hints) &&
    value.hints.every((hint) => typeof hint === 'string') &&
    isPromptImage(value.image)
}

function isPromptImage(value: unknown): boolean {
  return isRecord(value) &&
    Object.keys(value).length === 3 &&
    value.type === 'image' &&
    (
      value.mimeType === 'image/jpeg' ||
      value.mimeType === 'image/png' ||
      value.mimeType === 'image/gif' ||
      value.mimeType === 'image/webp'
    ) &&
    typeof value.data === 'string' &&
    value.data.length < MAX_PROMPT_IMAGE_BASE64_CHARS &&
    isBase64(value.data)
}

function isBase64(value: string): boolean {
  return value.length > 0 &&
    value.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isAppearanceSettings(value: unknown): value is AppearanceSettings {
  return isRecord(value) &&
    Object.keys(value).length === 6 &&
    isAppearanceTheme(value.theme) &&
    isAppearanceAccentColor(value.accentColor) &&
    isSurfaceTransparency(value.surfaceTransparency) &&
    isTextSize(value.textSize) &&
    isOptionalFontFamily(value.uiFontFamily) &&
    isOptionalFontFamily(value.codeFontFamily)
}

function isProviderInput(value: unknown): value is KernelProviderInput {
  return isRecord(value) &&
    Object.keys(value).length === 8 &&
    (value.originalId === null || isProviderId(value.originalId)) &&
    isProviderId(value.id) &&
    isHttpUrl(value.baseUrl) &&
    typeof value.api === 'string' &&
    (KERNEL_PROVIDER_APIS as readonly string[]).includes(value.api) &&
    (value.apiKey === null || typeof value.apiKey === 'string') &&
    typeof value.removeApiKey === 'boolean' &&
    !(value.removeApiKey && value.apiKey !== null) &&
    typeof value.authHeader === 'boolean' &&
    Array.isArray(value.models) &&
    value.models.length > 0 &&
    value.models.every(isProviderModelInput) &&
    new Set(value.models.map((model) => isRecord(model) ? model.id : null)).size === value.models.length
}

function isProviderModelInput(value: unknown): boolean {
  return isRecord(value) &&
    Object.keys(value).length === 6 &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' && value.name.trim().length > 0 &&
    typeof value.reasoning === 'boolean' &&
    Array.isArray(value.input) &&
    (value.input.length === 1 || value.input.length === 2) &&
    value.input[0] === 'text' &&
    (value.input.length === 1 || value.input[1] === 'image') &&
    isPositiveSafeInteger(value.contextWindow) &&
    isPositiveSafeInteger(value.maxTokens)
}

function isProviderId(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value) &&
    value !== '__proto__' &&
    value !== 'constructor' &&
    value !== 'prototype'
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() !== value) return false
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0
  } catch {
    return false
  }
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isGeneralSettings(value: unknown): value is GeneralSettings {
  return isRecord(value) &&
    Object.keys(value).length === 1 &&
    (value.startupWorkspaceRestore === 'restore' || value.startupWorkspaceRestore === 'none')
}

function isAppearanceTheme(value: unknown): value is AppearanceSettings['theme'] {
  return value === 'system' || value === 'dark' || value === 'light'
}

function isAppearanceAccentColor(value: unknown): value is AppearanceSettings['accentColor'] {
  return value === 'amber' ||
    value === 'blue' ||
    value === 'green' ||
    value === 'purple' ||
    value === 'rose'
}

function isSurfaceTransparency(value: unknown): value is AppearanceSettings['surfaceTransparency'] {
  return value === 0 || value === 10 || value === 20 || value === 30 || value === 40
}

function isTextSize(value: unknown): value is AppearanceSettings['textSize'] {
  return value === 'small' || value === 'default' || value === 'large'
}

function isOptionalFontFamily(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.trim().length > 0)
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

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return (
    value === 'off' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max'
  )
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
