import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { posix, win32 } from 'node:path'

import {
  queryWindowsDriveType,
  WINDOWS_DRIVE_TYPE_FIXED,
  type WindowsDriveTypeQuery
} from './windows-drive-type.ts'

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u

export function normalizeProjectPathForPlatform(
  path: string,
  platform: NodeJS.Platform = process.platform
): string {
  if (platform === 'linux') {
    if (typeof path !== 'string' || !posix.isAbsolute(path)) {
      throw new Error(`Project path must be an absolute path: ${String(path)}`)
    }
    return path
  }
  if (platform === 'win32') return normalizeWindowsDriveLetterPath(path, 'Project path')
  throw new Error(`Project path validation is not implemented for ${platform}.`)
}

export function normalizeWindowsDriveLetterPath(path: unknown, label: string): string {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    path.trim() !== path ||
    CONTROL_CHARACTER.test(path)
  ) {
    throw new Error(`${label} must be an exact absolute Windows drive-letter path.`)
  }
  const normalizedPath = win32.normalize(path)
  if (
    !win32.isAbsolute(normalizedPath) ||
    !/^[A-Za-z]:\\$/u.test(win32.parse(normalizedPath).root)
  ) {
    throw new Error(`${label} must be an exact absolute Windows drive-letter path.`)
  }
  return `${normalizedPath[0]!.toUpperCase()}${normalizedPath.slice(1)}`
}

export const WINDOWS_FIXED_DRIVE_REQUIRED_CODE = 'E_WINDOWS_FIXED_DRIVE_REQUIRED'
export const WINDOWS_STORAGE_ALIAS_UNSUPPORTED_CODE = 'E_WINDOWS_STORAGE_ALIAS_UNSUPPORTED'

export async function assertWindowsFixedDrivePath(
  path: string,
  options: {
    platform?: NodeJS.Platform
    queryDriveType?: WindowsDriveTypeQuery
  } = {}
): Promise<void> {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return

  const normalizedPath = normalizeWindowsDriveLetterPath(path, 'Windows filesystem path')
  const root = win32.parse(normalizedPath).root
  const driveType = await (options.queryDriveType ?? queryWindowsDriveType)(root)
  if (driveType === WINDOWS_DRIVE_TYPE_FIXED) return

  const error: NodeJS.ErrnoException = new Error(
    `Windows filesystem path must be on a fixed local drive: ${root}`
  )
  error.code = WINDOWS_FIXED_DRIVE_REQUIRED_CODE
  throw error
}

export function sameWindowsPathIdentity(left: string, right: string): boolean {
  return win32.normalize(left).toLocaleLowerCase('en-US') ===
    win32.normalize(right).toLocaleLowerCase('en-US')
}

export async function validateWindowsFixedStorageDirectory(path: string): Promise<string> {
  const normalizedPath = normalizeWindowsDriveLetterPath(path, 'ProjectStore directory')
  await assertWindowsFixedDrivePath(normalizedPath)

  const resolvedPath = await realpath(normalizedPath)
  const canonicalPath = normalizeWindowsDriveLetterPath(resolvedPath, 'ProjectStore directory')
  if (win32.parse(canonicalPath).root !== win32.parse(normalizedPath).root) {
    await assertWindowsFixedDrivePath(canonicalPath)
  }
  if (!sameWindowsPathIdentity(normalizedPath, canonicalPath)) {
    const error: NodeJS.ErrnoException = new Error(
      `ProjectStore directory must not resolve through a filesystem alias: ${normalizedPath}`
    )
    error.code = WINDOWS_STORAGE_ALIAS_UNSUPPORTED_CODE
    throw error
  }

  const directoryStat = await stat(resolvedPath)
  if (!directoryStat.isDirectory()) {
    throw new Error(`ProjectStore path is not a directory: ${canonicalPath}`)
  }
  await access(resolvedPath, constants.R_OK | constants.X_OK)
  return canonicalPath
}

export async function validateProjectDirectory(
  path: string,
  options: {
    platform?: NodeJS.Platform
    queryDriveType?: WindowsDriveTypeQuery
  } = {}
): Promise<string> {
  const platform = options.platform ?? process.platform
  const normalizedPath = normalizeProjectPathForPlatform(path, platform)
  if (platform === 'win32') {
    await assertWindowsFixedDrivePath(normalizedPath, {
      platform,
      queryDriveType: options.queryDriveType
    })
  }

  const resolvedPath = await realpath(normalizedPath)
  const canonicalPath = normalizeProjectPathForPlatform(resolvedPath, platform)
  if (
    platform === 'win32' &&
    win32.parse(canonicalPath).root !== win32.parse(normalizedPath).root
  ) {
    await assertWindowsFixedDrivePath(canonicalPath, {
      platform,
      queryDriveType: options.queryDriveType
    })
  }

  const projectStat = await stat(resolvedPath)
  if (!projectStat.isDirectory()) throw new Error(`Project path is not a directory: ${canonicalPath}`)
  await access(resolvedPath, constants.R_OK | constants.X_OK)
  return canonicalPath
}
