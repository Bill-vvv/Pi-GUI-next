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
import { createWriteStream, existsSync } from 'node:fs'
import {
  mkdir
} from 'node:fs/promises'
import {
  dirname,
  join
} from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  KERNEL_EVENT_CHANNEL,
  KERNEL_COMMAND_CHANNEL,
  OPEN_EXTERNAL_CHANNEL,
  WINDOW_FULLSCREEN_CHANGED_CHANNEL,
  WINDOW_IS_FULLSCREEN_CHANNEL,
  WINDOW_IS_MAXIMIZED_CHANNEL,
  WINDOW_MAXIMIZED_CHANGED_CHANNEL,
  WINDOW_CHROME_HEIGHT,
  WINDOW_SET_CHROME_CHANNEL,
  WINDOW_TOGGLE_FULLSCREEN_CHANNEL,
  WINDOW_TOGGLE_MAXIMIZE_CHANNEL,
  type KernelCommand,
  type KernelEvent,
  type KernelExtensionSelectionKind
} from '../shared/kernel-contract.ts'
import { GIT_COMMAND_CHANNEL } from '../shared/git-contract.ts'
import {
  DESKTOP_CLIENT_COMMAND_CHANNEL,
  DESKTOP_CLIENT_STATUS_CHANNEL,
  isDesktopClientCommand,
  type DesktopClientStatus
} from '../shared/desktop-client-contract.ts'
import {
  REMOTE_ADMIN_COMMAND_CHANNEL,
  isRemoteAdminCommand
} from '../shared/remote-admin-contract.ts'
import { normalizeOpenTarget } from '../shared/external-url.ts'
import { resolveRuntimeExtensionPaths } from './runtime/runtime-quiescence.ts'
import { isGitCommand } from './git/git-command-validation.ts'
import { isKernelCommand } from './kernel/kernel-command-validation.ts'
import { createKernelEventForwarder } from './kernel/kernel-event-forwarder.ts'
import { startHostApplication, type HostApplication, type RendererLifecycle } from './host/host-application.ts'
import { resolvePiExecutable } from './runtime/pi-executable.ts'
import { probePiRuntimeProcess } from './runtime/pi-runtime-probe.ts'
import { errorMessage } from './utils/errors.ts'
import {
  WSL_COMMAND_CHANNELS,
  wslBuildFingerprint
} from './remote/wsl-pipe.ts'
import {
  WSL_DESKTOP_CHANNEL,
  createWslDesktopClient
} from './remote/wsl-desktop.ts'
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
import {
  BUILD_IDENTITY_FILE_NAME,
  resolveBuildCommit
} from './build-identity.ts'
import {
  isAllowedRendererUrl,
  resolveRendererTarget,
  type RendererTarget
} from './security/renderer-security.ts'

const mainBundleDirectory = dirname(fileURLToPath(import.meta.url))
const piRuntimeEntryPath = join(mainBundleDirectory, 'pi-runtime-host.js')
let wslDistribution = process.env.PI_GUI_WSL_DISTRO
let currentDesktopEnvironment: DesktopEnvironment | null = null
let switchingEnvironment = false
const desktopSettings = createDesktopSettingsStore(join(app.getPath('appData'), 'pi-gui-next-desktop', 'settings.json'))
if (process.env.PI_GUI_WSL_HOST === '1') {
  // The WSL backend runs the Node Host (out/main/pi-host.js wsl, D-095), never the Electron shell.
  throw new Error('The WSL backend runs under Node. Start it with the installed start-host.sh.')
}
if (wslDistribution !== undefined) {
  if (process.platform !== 'win32') throw new Error('WSL Client requires Windows.')
  app.setPath('userData', join(app.getPath('appData'), 'pi-gui-next-wsl-client'))
}
let wslBackend: Awaited<ReturnType<typeof startWslBackend>> | null = null
let windowsRemoteSession: WindowsRemoteHostManager | null = null
let clientNotifications: ReturnType<typeof createElectronNotifications> | null = null
let mainWindow: BrowserWindow | null = null
let host: HostApplication | null = null
// Windows client mode forwards remote Kernel events to the local window; the Host assembly owns its own.
const kernelEventForwarder = createKernelEventForwarder({
  send: (event) => {
    const window = mainWindow
    if (window !== null && !window.isDestroyed()) window.webContents.send(KERNEL_EVENT_CHANNEL, event)
  }
})

function forwardKernelEvent(event: KernelEvent): void {
  kernelEventForwarder.forward(event)
}
let shutdownPromise: Promise<void> | null = null
let allowQuit = false

const STARTUP_READY_NONCE_PATTERN = /^[0-9a-f]{32}$/


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
    const extensionPaths = resolveRuntimeExtensionPaths({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath
    })
    const result = await probePiRuntimeProcess({
      entryPath: piRuntimeEntryPath,
      extensionPaths,
      quiescenceExtensionPath: extensionPaths[0]!,
      piExecutable: resolvePiExecutable({ explicitPath: process.env.PI_GUI_PI_EXECUTABLE })
    })
    console.info(
      `[Pi GUI] Pi Runtime process ready: version=${result.version} ` +
      `commands=${result.commandCount} pid=${result.pid}`
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
  const activeHost = await startHostApplication({
    wslHostMode: false,
    mainBundleDirectory,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    userDataDirectory: app.getPath('userData'),
    logDirectory: app.getPath('logs'),
    productVersion: app.getVersion(),
    fetch: (input, init) => net.fetch(input instanceof URL ? input.toString() : input, init),
    resolveBuildCommit: () => resolveBuildCommit({
      identityFilePath: join(mainBundleDirectory, BUILD_IDENTITY_FILE_NAME),
      ...(!app.isPackaged && process.env.NODE_ENV_ELECTRON_VITE === 'development' ? { developmentRoot: join(mainBundleDirectory, '../..') } : {}),
      ...(app.isPackaged ? { resourcesRoot: process.resourcesPath } : {})
    }),
    registerIpcHandler: (channel, handler) => {
      ipcMain.handle(channel, (event, value: unknown) => {
        assertTrustedIpcSender(event, rendererTarget)
        return handler({ sender: event.sender as unknown as RendererLifecycle }, value)
      })
    },
    publishToRenderer: (channel, value) => {
      const window = mainWindow
      if (window !== null && !window.isDestroyed()) window.webContents.send(channel, value)
    },
    desktop: {
      pickOpenDirectory,
      pickSaveHtmlPath,
      pickExtensionPath,
      pickAttachmentFiles,
      openPath: (path) => shell.openPath(path),
      openExternal: (url) => shell.openExternal(url),
      focusWindow: focusMainWindow
    },
    onWslPipeClosed: () => { if (!allowQuit) app.quit() }
  })
  host = activeHost
  registerDesktopClientHandlers(rendererTarget)
  registerWindowHandlers(rendererTarget)
  await createMainWindow(rendererTarget)
  await activeHost.refreshSessionActivities()
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

function sendDesktopClientStatus(status: DesktopClientStatus): void {
  const window = mainWindow
  if (window !== null && !window.isDestroyed()) {
    window.webContents.send(DESKTOP_CLIENT_STATUS_CHANNEL, status)
  }
}

function focusMainWindow(): void {
  const window = mainWindow
  if (window === null || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
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
  kernelEventForwarder.dispose()
  const activeHost = host
  host = null
  await activeHost?.stop()
}

async function pickAttachmentFiles(): Promise<string[] | null> {
  const options: OpenDialogOptions = {
    title: '选择附件',
    properties: ['openFile', 'multiSelections']
  }
  const selection = mainWindow === null
    ? await dialog.showOpenDialog(options)
    : await dialog.showOpenDialog(mainWindow, options)
  return selection.canceled ? null : selection.filePaths
}

async function pickOpenDirectory(): Promise<string | null> {
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
