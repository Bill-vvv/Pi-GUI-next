import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

import { errorMessage } from '../utils/errors.ts'

export const SUPPORTED_PI_VERSION = '0.83.0'

const DEFAULT_VERSION_TIMEOUT_MS = 5_000
const MAX_STDERR_BYTES = 4_096
const MAX_STDOUT_BYTES = 4_096

export interface ResolvePiExecutableOptions {
  explicitPath?: string
  path?: string
  homeDir?: string
}

export interface CheckPiVersionOptions {
  executable: string
  cwd: string
  timeoutMs?: number
}

export function resolvePiExecutable(options: ResolvePiExecutableOptions = {}): string {
  if (options.explicitPath !== undefined) {
    if (options.explicitPath.trim().length === 0) {
      throw new Error('The explicit Pi executable path is empty. Choose the Pi executable file and try again.')
    }

    const executable = resolve(options.explicitPath)
    assertExplicitExecutable(executable)
    return executable
  }

  const pathValue = options.path ?? process.env.PATH ?? ''

  for (const directory of pathValue.split(delimiter)) {
    if (directory.length === 0) {
      continue
    }

    const candidate = resolve(join(directory, 'pi'))
    if (isExecutableFile(candidate)) {
      return candidate
    }
  }

  const userLocalExecutable = resolve(options.homeDir ?? homedir(), '.local/bin/pi')
  if (isExecutableFile(userLocalExecutable)) {
    return userLocalExecutable
  }

  throw new Error('Pi was not found in the current PATH or ~/.local/bin. Provide the path to the Pi executable and try again.')
}

export async function checkPiVersion(options: CheckPiVersionOptions): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_VERSION_TIMEOUT_MS

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Pi version check timeout must be a positive number of milliseconds.')
  }

  return new Promise<string>((resolveVersion, rejectVersion) => {
    let child: ReturnType<typeof spawn>

    try {
      child = spawn(options.executable, ['--version'], {
        cwd: options.cwd,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      rejectVersion(new Error(`Unable to start Pi for version check: ${errorMessage(error)}`))
      return
    }

    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    let stderrTruncated = false
    let stdoutExceeded = false
    let timedOut = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    const rejectOnce = (error: Error): void => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(timer)
      rejectVersion(error)
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length >= MAX_STDOUT_BYTES) {
        return
      }

      const remaining = MAX_STDOUT_BYTES - stdout.length
      stdout = Buffer.concat([stdout, chunk.subarray(0, remaining)])

      if (chunk.length > remaining) {
        stdoutExceeded = true
        child.kill('SIGKILL')
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length >= MAX_STDERR_BYTES) {
        stderrTruncated = true
        return
      }

      const remaining = MAX_STDERR_BYTES - stderr.length
      stderr = Buffer.concat([stderr, chunk.subarray(0, remaining)])
      stderrTruncated ||= chunk.length > remaining
    })

    child.once('error', (error) => {
      rejectOnce(new Error(`Unable to start Pi for version check: ${error.message}`))
    })

    child.once('close', (code, signal) => {
      if (settled) {
        return
      }

      clearTimeout(timer)

      if (timedOut) {
        rejectOnce(new Error(`Pi version check timed out after ${timeoutMs} ms.`))
        return
      }

      if (stdoutExceeded) {
        rejectOnce(new Error(`Pi version check produced more than ${MAX_STDOUT_BYTES} bytes of stdout.`))
        return
      }

      if (code !== 0) {
        const exitDescription = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`
        rejectOnce(new Error(`Pi version check failed with ${exitDescription}; ${stderrDiagnostic(stderr, stderrTruncated)}`))
        return
      }

      const actualVersion = stdout.toString('utf8').trim()
      if (actualVersion !== SUPPORTED_PI_VERSION) {
        rejectOnce(
            new Error(`Unsupported Pi version ${formatVersion(actualVersion)}. Expected exactly ${SUPPORTED_PI_VERSION}.`)
        )
        return
      }

      settled = true
      resolveVersion(actualVersion)
    })
  })
}

function assertExplicitExecutable(executable: string): void {
  let stats

  try {
    stats = statSync(executable)
  } catch (error) {
    throw new Error(`The explicit Pi executable does not exist or cannot be accessed: ${executable}. ${errorMessage(error)}`)
  }

  if (!stats.isFile()) {
    throw new Error(`The explicit Pi executable is not a file: ${executable}. Choose the Pi executable file.`)
  }

  try {
    accessSync(executable, constants.X_OK)
  } catch {
    throw new Error(`The explicit Pi executable is not executable: ${executable}. Grant execute permission or choose another file.`)
  }
}

function isExecutableFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile() && (accessSync(candidate, constants.X_OK), true)
  } catch {
    return false
  }
}

function stderrDiagnostic(stderr: Buffer, truncated: boolean): string {
  if (stderr.length === 0) {
    return 'stderr was empty.'
  }

  return `stderr captured ${stderr.length} bytes${truncated ? ' [truncated]' : ''}.`
}

function formatVersion(version: string): string {
  return /^\d+\.\d+\.\d+$/.test(version) ? JSON.stringify(version) : '[unrecognized output]'
}
