import { access, opendir, realpath, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  PROJECT_DIRECTORY_ENTRY_LIMIT,
  PROJECT_DIRECTORY_SCAN_LIMIT,
  PROJECT_DIRECTORY_RESPONSE_BYTE_LIMIT,
  type ProjectDirectoryListing
} from '../../shared/project-directory-contract.ts'

/** List directory metadata for an explicitly paired desktop user's project picker. */
export async function listProjectDirectories(directoryPath = homedir()): Promise<ProjectDirectoryListing> {
  if (!directoryPath.startsWith('/') || directoryPath.length > 4_096 || /[\r\n\0]/u.test(directoryPath)) {
    return { ok: false, code: 'invalid-path', message: '请输入 Linux 主机上的绝对目录路径。' }
  }
  try {
    const path = await realpath(directoryPath)
    if (path.length > 4_096 || /[\r\n\0]/u.test(path)) {
      return { ok: false, code: 'invalid-path', message: '目录的实际路径过长或含有不支持的控制字符。' }
    }
    if (!(await stat(path)).isDirectory()) {
      return { ok: false, code: 'not-directory', message: '所选路径不是目录。' }
    }
    await access(path, constants.R_OK | constants.X_OK)
    const entries: Extract<ProjectDirectoryListing, { ok: true }>['entries'] = []
    let scanned = 0
    let truncated = false
    let inaccessibleLinks = 0
    let responseBytes = Buffer.byteLength(path) * 2 + 512
    const directory = await opendir(path)
    for await (const entry of directory) {
      if (++scanned > PROJECT_DIRECTORY_SCAN_LIMIT) { truncated = true; break }
      const entryPath = join(path, entry.name)
      if (entryPath.length > 4_096 || /[\r\n\0]/u.test(entryPath)) { truncated = true; continue }
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      if (entry.isSymbolicLink()) {
        try {
          if (!(await stat(entryPath)).isDirectory()) continue
        } catch (error) {
          if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
            inaccessibleLinks += 1
            continue
          }
          throw error
        }
      }
      if (entries.length === PROJECT_DIRECTORY_ENTRY_LIMIT) { truncated = true; break }
      const item = { name: entry.name, path: entryPath, symbolicLink: entry.isSymbolicLink() }
      responseBytes += Buffer.byteLength(JSON.stringify(item)) + 1
      if (responseBytes > PROJECT_DIRECTORY_RESPONSE_BYTE_LIMIT) { truncated = true; break }
      entries.push(item)
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    // Return canonical paths so selecting a symlink does not persist its alias.
    return { ok: true, path, parentPath: dirname(path) === path ? null : dirname(path), entries, truncated, inaccessibleLinks }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { ok: false, code: 'not-found', message: '目录不存在，可能已被移动或删除。' }
    if (code === 'ENOTDIR') return { ok: false, code: 'not-directory', message: '所选路径不是目录。' }
    if (code === 'EACCES' || code === 'EPERM') return { ok: false, code: 'access-denied', message: 'Linux 登录用户没有读取此目录的权限。' }
    if (code === 'ELOOP' || code === 'ENAMETOOLONG') return { ok: false, code: 'invalid-path', message: '目录路径过长或包含循环链接。' }
    throw error
  }
}
