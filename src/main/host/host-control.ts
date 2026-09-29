import { chmod, mkdir, unlink } from 'node:fs/promises'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'

import { isRemoteAdminCommand, type RemoteAdminCommand } from '../../shared/remote-admin-contract.ts'
import { errorMessage } from '../utils/errors.ts'

/**
 * One private Unix socket in the Host data directory (D-095/D-099):
 * - exclusive ownership: a second Host for the same data directory fails instead of sharing it;
 * - local control: the Host CLI reaches the same Desktop Host device functions as Settings.
 * The kernel releases the socket when the process ends; a leftover file refuses connections
 * and is replaced. Only the owning user can reach it (0700 directory, 0600 socket).
 */

export const HOST_CONTROL_COMMAND_TYPES = [
  'remote-admin.get-desktop-host-status',
  'remote-admin.create-desktop-host-pairing-code',
  'remote-admin.revoke-desktop-host-device'
] as const

export type HostControlCommand = Extract<RemoteAdminCommand, { type: typeof HOST_CONTROL_COMMAND_TYPES[number] }>

type HostControlResponse = { ok: true, value: unknown } | { ok: false, message: string }

const MAX_MESSAGE_BYTES = 4 * 1024
const MAX_SOCKET_PATH_BYTES = 107
const REQUEST_TIMEOUT_MS = 10_000

export class HostDataDirectoryInUseError extends Error {
  constructor(directory: string) {
    super(`Another Pi GUI Host is already using ${directory}. Close it (desktop, WSL backend or Desktop Host) before starting this one.`)
    this.name = 'HostDataDirectoryInUseError'
  }
}

export function hostControlSocketPath(userDataDirectory: string): string {
  const path = join(userDataDirectory, 'host.sock')
  if (Buffer.byteLength(path) > MAX_SOCKET_PATH_BYTES) {
    throw new Error(`The Pi GUI data directory path is too long for its control socket: ${userDataDirectory}`)
  }
  return path
}

export function isHostControlCommand(value: unknown): value is HostControlCommand {
  return isRemoteAdminCommand(value) &&
    (HOST_CONTROL_COMMAND_TYPES as readonly string[]).includes(value.type)
}

export type HostControl = { close(): Promise<void> }

/** Take exclusive ownership of the data directory and serve local control requests. */
export async function openHostControl(options: {
  userDataDirectory: string
  dispatch: (command: HostControlCommand) => Promise<unknown>
}): Promise<HostControl> {
  await mkdir(options.userDataDirectory, { recursive: true, mode: 0o700 })
  const path = hostControlSocketPath(options.userDataDirectory)
  const server = createServer({ allowHalfOpen: true }, (socket) => serve(socket, options.dispatch))
  try {
    await listen(server, path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
    if (await isAlive(path)) throw new HostDataDirectoryInUseError(options.userDataDirectory)
    // A previous Host ended without removing its socket; nothing is listening on it.
    await unlink(path).catch((unlinkError: NodeJS.ErrnoException) => {
      if (unlinkError.code !== 'ENOENT') throw unlinkError
    })
    await listen(server, path)
  }
  await chmod(path, 0o600)
  let closed = false
  return {
    async close() {
      if (closed) return
      closed = true
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await unlink(path).catch(() => undefined)
    }
  }
}

/** Send one control command to the running Host that owns this data directory. */
export async function requestHostControl(
  userDataDirectory: string,
  command: HostControlCommand,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<unknown> {
  const path = hostControlSocketPath(userDataDirectory)
  const response = await new Promise<string>((resolve, reject) => {
    const socket = createConnection(path)
    let text = ''
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('The Pi GUI Host did not answer.')))
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      text += chunk
      if (Buffer.byteLength(text) > MAX_MESSAGE_BYTES * 4) socket.destroy(new Error('Host control response is too large.'))
    })
    socket.once('end', () => resolve(text))
    socket.once('error', (error: NodeJS.ErrnoException) => {
      reject(error.code === 'ENOENT' || error.code === 'ECONNREFUSED'
        ? new Error('No running Pi GUI Host owns this data directory. Start the Desktop Host first.')
        : error)
    })
    socket.end(`${JSON.stringify(command)}\n`)
  })
  let parsed: HostControlResponse
  try {
    parsed = JSON.parse(response) as HostControlResponse
  } catch {
    throw new Error('Host control response is invalid.')
  }
  if (parsed.ok !== true) throw new Error(typeof parsed.message === 'string' ? parsed.message : 'Host control request failed.')
  return parsed.value
}

function serve(socket: Socket, dispatch: (command: HostControlCommand) => Promise<unknown>): void {
  let text = ''
  let answered = false
  const answer = (response: HostControlResponse): void => {
    if (answered) return
    answered = true
    socket.end(`${JSON.stringify(response)}\n`)
  }
  socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy())
  socket.setEncoding('utf8')
  socket.on('error', () => undefined)
  socket.on('data', (chunk: string) => {
    text += chunk
    if (Buffer.byteLength(text) > MAX_MESSAGE_BYTES) answer({ ok: false, message: 'Host control request is too large.' })
  })
  socket.once('end', () => {
    if (answered) return
    let command: unknown
    try {
      command = JSON.parse(text)
    } catch {
      answer({ ok: false, message: 'Host control request is invalid.' })
      return
    }
    if (!isHostControlCommand(command)) {
      answer({ ok: false, message: 'Unsupported Host control command.' })
      return
    }
    dispatch(command).then(
      (value) => answer({ ok: true, value: value ?? null }),
      (error: unknown) => answer({ ok: false, message: errorMessage(error) })
    )
  })
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(path)
  })
}

function isAlive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(path)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}
