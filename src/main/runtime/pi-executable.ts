import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, extname, join, resolve } from 'node:path'
import { errorMessage } from '../utils/errors.ts'
import { spawnPiCommand } from './pi-spawn.ts'

export const SUPPORTED_PI_VERSION = '0.83.0'

const DEFAULT_VERSION_TIMEOUT_MS = 5_000
const MAX_STDERR_BYTES = 4_096
const MAX_STDOUT_BYTES = 4_096
const WINDOWS_RUNNABLE_EXTENSIONS = new Set(['.com', '.exe', '.bat', '.cmd'])

export interface ResolvePiExecutableOptions {
  explicitPath?: string
  path?: string
  homeDir?: string
  platform?: NodeJS.Platform
  pathExt?: string
}

export interface CheckPiVersionOptions {
  executable: string
  cwd: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
}

export function resolvePiExecutable(options: ResolvePiExecutableOptions = {}): string {
  const platform = options.platform ?? process.platform

  if (options.explicitPath !== undefined) {
    if (options.explicitPath.trim().length === 0) {
      throw new Error('The explicit Pi executable path is empty. Choose the Pi executable file and try again.')
    }

    const executable = resolve(options.explicitPath)
    assertExplicitExecutable(executable, platform)
    return executable
  }

  const pathValue = options.path ?? process.env.PATH ?? ''
  const executableNames =
    platform === 'win32' ? windowsPiExecutableNames(options.pathExt ?? process.env.PATHEXT) : ['pi']
  const pathDelimiter = platform === 'win32' ? ';' : delimiter

  for (const directory of pathValue.split(pathDelimiter)) {
    if (directory.length === 0) {
      continue
    }

    for (const executableName of executableNames) {
      const candidate = resolve(join(directory, executableName))
      if (isRunnableFile(candidate, platform)) {
        return candidate
      }
    }
  }

  if (platform !== 'win32') {
    const userLocalExecutable = resolve(options.homeDir ?? homedir(), '.local/bin/pi')
    if (isRunnableFile(userLocalExecutable, platform)) {
      return userLocalExecutable
    }
  }

  const searchedLocations = platform === 'win32' ? 'the current PATH using PATHEXT' : 'the current PATH or ~/.local/bin'
  throw new Error(`Pi was not found in ${searchedLocations}. Provide the path to the Pi executable and try again.`)
}

export async function checkPiVersion(options: CheckPiVersionOptions): Promise<string> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_VERSION_TIMEOUT_MS

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Pi version check timeout must be a positive number of milliseconds.')
  }

  return new Promise<string>((resolveVersion, rejectVersion) => {
    let child: ReturnType<typeof spawnPiCommand>

    try {
      child = spawnPiCommand(options.executable, ['--version'], {
        cwd: options.cwd,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: options.env
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

function assertExplicitExecutable(executable: string, platform: NodeJS.Platform): void {
  let stats

  try {
    stats = statSync(executable)
  } catch (error) {
    throw new Error(`The explicit Pi executable does not exist or cannot be accessed: ${executable}. ${errorMessage(error)}`)
  }

  if (!stats.isFile()) {
    throw new Error(`The explicit Pi executable is not a file: ${executable}. Choose the Pi executable file.`)
  }

  if (platform === 'win32') {
    if (!WINDOWS_RUNNABLE_EXTENSIONS.has(extname(executable).toLowerCase())) {
      throw new Error(
        `The explicit Pi executable is not a supported Windows command file: ${executable}. Choose a .exe, .com, .bat, or .cmd file.`
      )
    }
    return
  }

  try {
    accessSync(executable, constants.X_OK)
  } catch {
    throw new Error(`The explicit Pi executable is not executable: ${executable}. Grant execute permission or choose another file.`)
  }
}

function isRunnableFile(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(candidate).isFile()) {
      return false
    }

    if (platform === 'win32') {
      return WINDOWS_RUNNABLE_EXTENSIONS.has(extname(candidate).toLowerCase())
    }

    accessSync(candidate, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function windowsPiExecutableNames(pathExt: string | undefined): string[] {
  const extensions = pathExt
    ?.split(';')
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension, index, values) => WINDOWS_RUNNABLE_EXTENSIONS.has(extension) && values.indexOf(extension) === index)

  if (extensions === undefined || extensions.length === 0) {
    throw new Error('Windows PATHEXT does not contain a supported executable extension for Pi (.exe, .com, .bat, or .cmd).')
  }

  return extensions.map((extension) => `pi${extension}`)
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
