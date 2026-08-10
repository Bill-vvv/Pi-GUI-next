import { execFile } from 'node:child_process'
import { win32 } from 'node:path'

const DRIVE_TYPE_PROBE_TIMEOUT_MS = 5_000
const DRIVE_TYPE_PROBE_MAX_BYTES = 1_024
const WINDOWS_DRIVE_TYPE_MIN = 0
const WINDOWS_DRIVE_TYPE_MAX = 6
const DRIVE_TYPE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$drive = [System.IO.DriveInfo]::new($env:PI_GUI_WINDOWS_DRIVE_ROOT)',
  '[Console]::Out.Write([int]$drive.DriveType)'
].join('; ')

export const WINDOWS_DRIVE_TYPE_FIXED = 3
export const WINDOWS_DRIVE_TYPE_PROBE_FAILED_CODE = 'E_WINDOWS_DRIVE_TYPE_PROBE_FAILED'

export type WindowsDriveTypeQuery = (root: string) => Promise<number>

export async function queryWindowsDriveType(root: string): Promise<number> {
  if (!/^[A-Z]:\\$/u.test(root)) {
    throw codedError(
      WINDOWS_DRIVE_TYPE_PROBE_FAILED_CODE,
      `Windows drive type probe requires a normalized drive root: ${root}`
    )
  }
  const systemRoot = normalizeSystemRoot(
    process.env.SystemRoot ?? process.env.SYSTEMROOT ?? process.env.WINDIR
  )
  const executable = win32.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  const stdout = await runDriveTypeProbe(executable, root, systemRoot)
  return parseWindowsDriveTypeOutput(stdout, root)
}

function runDriveTypeProbe(executable: string, root: string, systemRoot: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', DRIVE_TYPE_SCRIPT],
      {
        encoding: 'utf8',
        env: driveTypeProbeEnvironment(root, systemRoot),
        maxBuffer: DRIVE_TYPE_PROBE_MAX_BYTES,
        timeout: DRIVE_TYPE_PROBE_TIMEOUT_MS,
        windowsHide: true
      },
      (error, stdout) => {
        if (error !== null) {
          reject(codedError(
            WINDOWS_DRIVE_TYPE_PROBE_FAILED_CODE,
            `Windows drive type probe failed for ${root}.`
          ))
          return
        }
        resolve(stdout)
      }
    )
  })
}

export function parseWindowsDriveTypeOutput(stdout: string, root: string): number {
  const value = stdout.trim()
  if (!/^\d$/u.test(value)) {
    throw codedError(
      WINDOWS_DRIVE_TYPE_PROBE_FAILED_CODE,
      `Windows drive type probe returned an invalid result for ${root}.`
    )
  }
  const driveType = Number(value)
  if (driveType < WINDOWS_DRIVE_TYPE_MIN || driveType > WINDOWS_DRIVE_TYPE_MAX) {
    throw codedError(
      WINDOWS_DRIVE_TYPE_PROBE_FAILED_CODE,
      `Windows drive type probe returned an unsupported result for ${root}.`
    )
  }
  return driveType
}

function driveTypeProbeEnvironment(root: string, systemRoot: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    PI_GUI_WINDOWS_DRIVE_ROOT: root
  }
  for (const name of ['TEMP', 'TMP'] as const) {
    const value = process.env[name]
    if (value !== undefined) environment[name] = value
  }
  return environment
}

function normalizeSystemRoot(value: string | undefined): string {
  if (value === undefined || value.trim() !== value || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw codedError(
      WINDOWS_DRIVE_TYPE_PROBE_FAILED_CODE,
      'SystemRoot is unavailable for the Windows drive type probe.'
    )
  }
  const normalized = win32.normalize(value)
  if (!win32.isAbsolute(normalized) || !/^[A-Za-z]:\\$/u.test(win32.parse(normalized).root)) {
    throw codedError(
      WINDOWS_DRIVE_TYPE_PROBE_FAILED_CODE,
      'SystemRoot is invalid for the Windows drive type probe.'
    )
  }
  return `${normalized[0]!.toUpperCase()}${normalized.slice(1)}`
}

function codedError(code: string, message: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(message)
  error.code = code
  return error
}
