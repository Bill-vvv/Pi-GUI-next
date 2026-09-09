import {
  execFile,
  spawn,
  type ChildProcess,
  type SpawnOptions
} from 'node:child_process'

import type { WindowsRemoteHostConfig } from './windows-remote-host-config.ts'

export type SystemSshTunnelTermination = {
  expected: boolean
  code: number | null
  signal: NodeJS.Signals | null
  error: string | null
  stderr: string
}

export type SystemSshTunnel = {
  readonly connectionSignal: AbortSignal
  readonly termination: Promise<SystemSshTunnelTermination>
  stop(): Promise<void>
}

type SpawnSsh = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcess

type InspectSsh = (sshHostAlias: string) => Promise<string>
type VerifyUnauthenticatedDesktopHost = (connectionSignal: AbortSignal) => Promise<void>

export type StartSystemSshTunnelOptions = {
  config: WindowsRemoteHostConfig
  verifyUnauthenticatedDesktopHost: VerifyUnauthenticatedDesktopHost
  inspectSsh?: InspectSsh
  spawnSsh?: SpawnSsh
  startupTimeoutMs?: number
  stopTimeoutMs?: number
}

const MAX_SSH_STDERR_CHARS = 8 * 1024
const MAX_SSH_CONFIG_BYTES = 1 * 1024 * 1024
const DEFAULT_SSH_STARTUP_TIMEOUT_MS = 30_000
const DEFAULT_SSH_STOP_TIMEOUT_MS = 5_000

export function buildSystemSshTunnelArgs(config: WindowsRemoteHostConfig): string[] {
  return [
    '-v',
    '-N',
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ConnectionAttempts=1',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    '-o',
    'PermitLocalCommand=no',
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
    '-o',
    'ForkAfterAuthentication=no',
    '-o',
    'Tunnel=no',
    '-o',
    'ClearAllForwardings=no',
    '-L',
    `127.0.0.1:${config.localPort}:127.0.0.1:${config.desktopHostPort}`,
    config.sshHostAlias
  ]
}

export async function startSystemSshTunnel(
  options: StartSystemSshTunnelOptions
): Promise<SystemSshTunnel> {
  const inspectSsh = options.inspectSsh ?? inspectSystemSshConfiguration
  const resolvedConfig = await inspectSsh(options.config.sshHostAlias)
  assertNoConfiguredForwardings(resolvedConfig)

  const startupTimeoutMs = parseTimeout(
    options.startupTimeoutMs ?? DEFAULT_SSH_STARTUP_TIMEOUT_MS,
    'SSH startup timeout',
    120_000
  )
  const stopTimeoutMs = parseTimeout(
    options.stopTimeoutMs ?? DEFAULT_SSH_STOP_TIMEOUT_MS,
    'SSH stop timeout',
    60_000
  )

  const spawnSsh = options.spawnSsh ?? spawn
  const child = spawnSsh('ssh', buildSystemSshTunnelArgs(options.config), {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe']
  })
  const connectionController = new AbortController()
  const processErrorListeners = new Set<(error: Error) => void>()
  const startupDeadline = Date.now() + startupTimeoutMs
  const forwardingMarker = `Local forwarding listening on 127.0.0.1 port ${options.config.localPort}.`
  let stopRequested = false
  let settled = false
  let spawnSeen = false
  let startupSettled = false
  let authenticated = false
  let forwardingBound = false
  let lifecycleError: Error | null = null
  let stderr = ''

  let resolveStartup!: () => void
  let rejectStartup!: (error: Error) => void
  const startupReady = new Promise<void>((resolve, reject) => {
    resolveStartup = resolve
    rejectStartup = reject
  })
  const failStartup = (error: Error): void => {
    if (startupSettled) return
    startupSettled = true
    rejectStartup(error)
  }
  const maybeResolveStartup = (): void => {
    if (startupSettled || !spawnSeen || !authenticated || !forwardingBound) return
    startupSettled = true
    resolveStartup()
  }

  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string | Buffer) => {
    stderr = appendBounded(stderr, typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
    authenticated ||= hasAuthenticationSuccessMarker(stderr)
    forwardingBound ||= stderr.includes(forwardingMarker)
    maybeResolveStartup()
  })

  let resolveTermination!: (value: SystemSshTunnelTermination) => void
  const termination = new Promise<SystemSshTunnelTermination>((resolve) => {
    resolveTermination = resolve
  })
  const finish = (
    code: number | null,
    signal: NodeJS.Signals | null,
    error: string | null
  ): void => {
    if (settled) return
    settled = true
    connectionController.abort()
    if (!startupSettled) {
      failStartup(new Error(
        error === null
          ? `OpenSSH terminated before tunnel readiness (code ${String(code)}, signal ${String(signal)}).`
          : `OpenSSH could not start: ${error}`
      ))
    }
    resolveTermination({
      expected: stopRequested,
      code,
      signal,
      error: error ?? lifecycleError?.message ?? null,
      stderr: stderr.trim()
    })
  }

  child.once('spawn', () => {
    spawnSeen = true
    maybeResolveStartup()
  })
  child.on('error', (error) => {
    if (!spawnSeen) {
      finish(null, null, error.message)
      return
    }
    lifecycleError = error
    failStartup(new Error(`OpenSSH process failed during tunnel startup: ${error.message}`))
    for (const listener of processErrorListeners) listener(error)
  })
  child.once('exit', (code, signal) => finish(code, signal, null))

  try {
    await waitForStartupReadiness(startupReady, startupDeadline, () => stderr)
    await waitForStartupReadiness(
      options.verifyUnauthenticatedDesktopHost(connectionController.signal),
      startupDeadline,
      () => stderr
    )
    if (settled || connectionController.signal.aborted) {
      throw new Error('OpenSSH terminated before the unauthenticated Desktop Host readiness probe completed.')
    }
  } catch (error) {
    connectionController.abort()
    await terminateFailedStartup(child, termination, settled, stopTimeoutMs)
    throw error
  }

  return {
    connectionSignal: connectionController.signal,
    termination,
    async stop() {
      if (settled) return
      stopRequested = true
      connectionController.abort()
      await stopOwnedProcess(
        child,
        termination,
        processErrorListeners,
        lifecycleError,
        stopTimeoutMs
      )
    }
  }
}

async function inspectSystemSshConfiguration(sshHostAlias: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile('ssh', ['-G', sshHostAlias], {
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: MAX_SSH_CONFIG_BYTES,
      timeout: 10_000
    }, (error, stdout, stderr) => {
      if (error !== null) {
        const detail = appendBounded('', stderr || error.message).trim()
        reject(new Error(`OpenSSH could not resolve host alias configuration${detail.length > 0 ? `: ${detail}` : '.'}`))
        return
      }
      resolve(stdout)
    })
  })
}

function assertNoConfiguredForwardings(resolvedConfig: string): void {
  if (Buffer.byteLength(resolvedConfig, 'utf8') > MAX_SSH_CONFIG_BYTES) {
    throw new Error('Resolved OpenSSH configuration exceeds its size limit.')
  }
  for (const line of resolvedConfig.split(/\r?\n/u)) {
    if (/^(?:localforward|remoteforward|dynamicforward)\s+/iu.test(line.trim())) {
      throw new Error('SSH host alias must not define LocalForward, RemoteForward, or DynamicForward; Pi GUI owns the single loopback Desktop Host forwarding rule.')
    }
  }
}

function hasAuthenticationSuccessMarker(value: string): boolean {
  return /(?:^|\n)(?:debug1: )?(?:Authenticated to .+ using ".+"\.|Authentication succeeded \(.+\)\.)/u.test(value)
}

async function waitForStartupReadiness(
  readiness: Promise<void>,
  deadline: number,
  readStderr: () => string
): Promise<void> {
  const remainingMs = deadline - Date.now()
  if (remainingMs < 1) throw startupTimeoutError(readStderr())
  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    await Promise.race([
      readiness,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(startupTimeoutError(readStderr())), remainingMs)
        timeout.unref?.()
      })
    ])
  } finally {
    if (timeout !== null) clearTimeout(timeout)
  }
}

function startupTimeoutError(stderr: string): Error {
  const detail = stderr.trim()
  return new Error(
    `OpenSSH tunnel readiness timed out${detail.length > 0 ? `: ${detail}` : '.'}`
  )
}

async function terminateFailedStartup(
  child: ChildProcess,
  termination: Promise<SystemSshTunnelTermination>,
  settled: boolean,
  timeoutMs: number
): Promise<void> {
  if (settled) return
  try {
    child.kill()
  } catch {
    return
  }
  try {
    await waitForTermination(termination, timeoutMs)
  } catch {
    // Preserve the original startup/readiness error.
  }
}

async function stopOwnedProcess(
  child: ChildProcess,
  termination: Promise<SystemSshTunnelTermination>,
  processErrorListeners: Set<(error: Error) => void>,
  existingError: Error | null,
  timeoutMs: number
): Promise<void> {
  if (existingError !== null) throw existingError
  let rejectProcessError!: (error: Error) => void
  const processError = new Promise<never>((_resolve, reject) => {
    rejectProcessError = reject
  })
  processErrorListeners.add(rejectProcessError)
  try {
    if (!child.kill()) {
      throw new Error('OpenSSH did not accept the termination signal.')
    }
    await Promise.race([
      waitForTermination(termination, timeoutMs),
      processError
    ])
  } finally {
    processErrorListeners.delete(rejectProcessError)
  }
}

async function waitForTermination(
  termination: Promise<SystemSshTunnelTermination>,
  timeoutMs: number
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | null = null
  try {
    await Promise.race([
      termination.then(() => undefined),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`OpenSSH did not terminate within ${timeoutMs} milliseconds.`))
        }, timeoutMs)
        timeout.unref?.()
      })
    ])
  } finally {
    if (timeout !== null) clearTimeout(timeout)
  }
}

function parseTimeout(value: number, label: string, maximum: number): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be an integer between 1 and ${maximum} milliseconds.`)
  }
  return value
}

function appendBounded(current: string, chunk: string): string {
  const combined = current + chunk
  return combined.length <= MAX_SSH_STDERR_CHARS
    ? combined
    : combined.slice(combined.length - MAX_SSH_STDERR_CHARS)
}
