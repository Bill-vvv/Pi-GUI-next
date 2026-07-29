import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

const APP_NAME = 'Pi'
const ACTION_ID = 'default'
const ACTION_LABEL = '打开对话'
const EXPIRE_TIME_MS = 12_000
const NOTIFY_SEND_GRACE_MS = 5_000
const NOTIFICATION_ACCEPT_TIMEOUT_MS = 1_500
const SOCKET_TIMEOUT_MS = 2_000
const MAX_REQUEST_BYTES = 16 * 1024
const MAX_TITLE_LENGTH = 256
const MAX_BODY_LENGTH = 2_048
const MAX_PATH_LENGTH = 4_096
const MAX_SOCKET_PATH_BYTES = 100

export type DesktopNotificationTarget = {
  projectPath: string
  sessionKey: string
}

export type DesktopNotification = {
  title: string
  body: string
}

type DesktopNotificationRequest = DesktopNotification & DesktopNotificationTarget & {
  version: 1
  token: string
}

type DesktopNotificationResponse = {
  version: 1
  ok: boolean
  error?: 'invalid-request' | 'unavailable'
}

export type DesktopNotificationPresenter = {
  present(
    notification: DesktopNotification,
    onActivate: () => void
  ): Promise<void>
  close(): void
}

export type DesktopNotificationBrokerOptions = {
  iconPath: string
  activateTarget(target: DesktopNotificationTarget): Promise<void>
  socketPath?: string
  token?: string
  presenter?: DesktopNotificationPresenter
  onError?(message: string): void
}

export type DesktopNotificationBroker = {
  readonly socketPath: string
  readonly token: string
  start(): Promise<void>
  close(): Promise<void>
}

export function resolveDesktopNotificationSocketPath(
  environment: NodeJS.ProcessEnv = process.env,
  uid = typeof process.getuid === 'function' ? process.getuid() : 0
): string {
  const configuredRuntimeDirectory = environment.XDG_RUNTIME_DIR
  const runtimeDirectory = configuredRuntimeDirectory !== undefined &&
    isAbsolute(configuredRuntimeDirectory)
    ? configuredRuntimeDirectory
    : join(tmpdir(), `pi-gui-next-${uid}`)
  return join(runtimeDirectory, 'pi-gui-next', 'desktop-notification.sock')
}

export function createDesktopNotificationBroker(
  options: DesktopNotificationBrokerOptions
): DesktopNotificationBroker {
  const socketPath = options.socketPath ?? resolveDesktopNotificationSocketPath()
  const token = options.token ?? randomBytes(32).toString('base64url')
  const presenter = options.presenter ?? createNotifySendPresenter(options.iconPath)
  const sockets = new Set<Socket>()
  let server: Server | null = null
  let prepared = false
  let started = false
  let closed = false
  let activationQueue = Promise.resolve()

  if (!isAbsolute(socketPath)) {
    throw new Error(`Desktop notification socket path must be absolute: ${socketPath}`)
  }
  if (Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES) {
    throw new Error('Desktop notification socket path is too long.')
  }
  if (token.length < 32 || token.length > 256) {
    throw new Error('Desktop notification broker token is invalid.')
  }

  const reportError = (message: string): void => {
    options.onError?.(message)
  }

  const enqueueActivation = (target: DesktopNotificationTarget): void => {
    if (closed) return
    activationQueue = activationQueue
      .catch(() => undefined)
      .then(async () => {
        if (closed) return
        await options.activateTarget(target)
      })
      .catch(() => {
        reportError('Desktop notification activation failed.')
      })
  }

  const handleRequest = async (
    socket: Socket,
    request: DesktopNotificationRequest
  ): Promise<void> => {
    try {
      if (closed) {
        writeResponse(socket, { version: 1, ok: false, error: 'unavailable' })
        return
      }
      const target = {
        projectPath: request.projectPath,
        sessionKey: request.sessionKey
      }
      await presenter.present(
        { title: request.title, body: request.body },
        () => enqueueActivation(target)
      )
      writeResponse(socket, { version: 1, ok: true })
    } catch {
      writeResponse(socket, { version: 1, ok: false, error: 'unavailable' })
    }
  }

  const acceptConnection = (socket: Socket): void => {
    if (closed) {
      socket.destroy()
      return
    }
    sockets.add(socket)
    socket.setEncoding('utf8')
    socket.setTimeout(SOCKET_TIMEOUT_MS)
    let input = ''
    let receivedBytes = 0
    let handled = false

    const finish = (): void => {
      sockets.delete(socket)
    }
    socket.once('close', finish)
    socket.once('error', finish)
    socket.once('timeout', () => socket.destroy())
    socket.on('data', (chunk: string) => {
      if (handled) return
      receivedBytes += Buffer.byteLength(chunk)
      if (receivedBytes > MAX_REQUEST_BYTES) {
        handled = true
        writeResponse(socket, { version: 1, ok: false, error: 'invalid-request' })
        return
      }
      input += chunk
      const newlineIndex = input.indexOf('\n')
      if (newlineIndex < 0) return
      handled = true
      const trailing = input.slice(newlineIndex + 1)
      if (trailing.trim().length > 0) {
        writeResponse(socket, { version: 1, ok: false, error: 'invalid-request' })
        return
      }
      const request = parseRequest(input.slice(0, newlineIndex), token)
      if (request === null) {
        writeResponse(socket, { version: 1, ok: false, error: 'invalid-request' })
        return
      }
      socket.pause()
      void handleRequest(socket, request)
    })
  }

  return {
    socketPath,
    token,
    async start(): Promise<void> {
      if (started) return
      if (closed) throw new Error('Desktop notification broker is closed.')
      await prepareSocketDirectory(socketPath)
      prepared = true
      await removeStaleSocket(socketPath)
      const nextServer = createServer(acceptConnection)
      server = nextServer
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          nextServer.off('listening', onListening)
          reject(error)
        }
        const onListening = (): void => {
          nextServer.off('error', onError)
          resolve()
        }
        nextServer.once('error', onError)
        nextServer.once('listening', onListening)
        nextServer.listen(socketPath)
      })
      nextServer.on('error', () => {
        reportError('Desktop notification broker socket failed.')
      })
      started = true
      await chmod(socketPath, 0o600)
    },
    async close(): Promise<void> {
      if (closed) return
      closed = true
      presenter.close()
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      const activeServer = server
      server = null
      if (activeServer !== null && started) {
        await new Promise<void>((resolve) => activeServer.close(() => resolve()))
      }
      await activationQueue.catch(() => undefined)
      if (prepared) {
        await unlink(socketPath).catch((error: unknown) => {
          if (!isNodeError(error) || error.code !== 'ENOENT') throw error
        })
      }
    }
  }
}

export function buildNotifySendArguments(
  notification: DesktopNotification,
  iconPath: string
): string[] {
  return [
    '--app-name',
    APP_NAME,
    '--icon',
    iconPath,
    '--app-icon',
    iconPath,
    '--category',
    'transfer.complete',
    '--urgency',
    'normal',
    '--expire-time',
    String(EXPIRE_TIME_MS),
    '--action',
    `${ACTION_ID}=${ACTION_LABEL}`,
    '--wait',
    '--print-id',
    notification.title,
    notification.body
  ]
}

export function createNotifySendPresenter(
  iconPath: string,
  command = 'notify-send'
): DesktopNotificationPresenter {
  const children = new Map<ChildProcess, { lifetime: NodeJS.Timeout, acceptance: NodeJS.Timeout }>()
  return {
    present(notification, onActivate): Promise<void> {
      return new Promise((resolve, reject) => {
        const child = spawn(
          command,
          buildNotifySendArguments(notification, iconPath),
          {
            shell: false,
            stdio: ['ignore', 'pipe', 'ignore']
          }
        )
        let accepted = false
        let activated = false
        let settled = false
        let output = ''
        const lifetime = setTimeout(
          () => child.kill('SIGTERM'),
          EXPIRE_TIME_MS + NOTIFY_SEND_GRACE_MS
        )
        const acceptance = setTimeout(() => {
          if (accepted) return
          child.kill('SIGTERM')
          if (!settled) {
            settled = true
            reject(new Error('Desktop notification service did not acknowledge the notification.'))
          }
        }, NOTIFICATION_ACCEPT_TIMEOUT_MS)
        lifetime.unref()
        acceptance.unref()
        children.set(child, { lifetime, acceptance })
        const finishChild = (): void => {
          const timers = children.get(child)
          if (timers !== undefined) {
            clearTimeout(timers.lifetime)
            clearTimeout(timers.acceptance)
          }
          children.delete(child)
        }
        const processOutput = (): void => {
          let newlineIndex = output.indexOf('\n')
          while (newlineIndex >= 0) {
            const line = output.slice(0, newlineIndex).trim()
            output = output.slice(newlineIndex + 1)
            if (!accepted) {
              if (/^\d+$/u.test(line)) {
                accepted = true
                clearTimeout(acceptance)
                if (!settled) {
                  settled = true
                  resolve()
                }
              }
            } else if (line === ACTION_ID && !activated) {
              activated = true
              onActivate()
            }
            newlineIndex = output.indexOf('\n')
          }
        }
        child.stdout?.setEncoding('utf8')
        child.stdout?.on('data', (chunk: string) => {
          if (output.length >= 256) return
          output += chunk
          processOutput()
        })
        child.once('error', (error) => {
          finishChild()
          if (!settled) {
            settled = true
            reject(error)
          }
        })
        child.once('close', (code) => {
          processOutput()
          finishChild()
          if (!accepted && !settled) {
            settled = true
            reject(new Error(`Desktop notification process exited before acknowledgement: ${code ?? 'unknown'}`))
          }
        })
      })
    },
    close(): void {
      for (const [child, timers] of children) {
        clearTimeout(timers.lifetime)
        clearTimeout(timers.acceptance)
        child.kill('SIGTERM')
      }
      children.clear()
    }
  }
}

async function prepareSocketDirectory(socketPath: string): Promise<void> {
  const directory = dirname(socketPath)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const directoryStat = await lstat(directory)
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error('Desktop notification runtime path is not a private directory.')
  }
  if (typeof process.getuid === 'function' && directoryStat.uid !== process.getuid()) {
    throw new Error('Desktop notification runtime directory has the wrong owner.')
  }
  await chmod(directory, 0o700)
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  try {
    const socketStat = await lstat(socketPath)
    if (socketStat.isDirectory()) {
      throw new Error('Desktop notification socket path is a directory.')
    }
    await unlink(socketPath)
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error
  }
}

function parseRequest(text: string, expectedToken: string): DesktopNotificationRequest | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  const keys = Object.keys(value).sort()
  const expectedKeys = ['body', 'projectPath', 'sessionKey', 'title', 'token', 'version']
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    return null
  }
  if (
    value.version !== 1 ||
    value.token !== expectedToken ||
    !isBoundedString(value.title, 1, MAX_TITLE_LENGTH) ||
    !isBoundedString(value.body, 1, MAX_BODY_LENGTH) ||
    !isBoundedString(value.projectPath, 1, MAX_PATH_LENGTH) ||
    !isBoundedString(value.sessionKey, 1, MAX_PATH_LENGTH) ||
    !isAbsolute(value.projectPath) ||
    !isAbsolute(value.sessionKey)
  ) {
    return null
  }
  return {
    version: 1,
    token: value.token,
    title: value.title,
    body: value.body,
    projectPath: value.projectPath,
    sessionKey: value.sessionKey
  }
}

function writeResponse(socket: Socket, response: DesktopNotificationResponse): void {
  if (socket.destroyed) return
  socket.end(`${JSON.stringify(response)}\n`)
}

function isBoundedString(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === 'string' && value.length >= minimum && value.length <= maximum
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
