import { constants } from 'node:fs'
import { open, realpath, type FileHandle } from 'node:fs/promises'
import { resolve } from 'node:path'
import { GIT_FILE_READ_MAX_BYTES, type GitErrorCode, type GitErrorDto, type GitFileReadResult } from '../../shared/git-contract.ts'
import { isCanonicalAbsolutePath, isRepositoryRelativePath } from './git-command-validation.ts'

export class GitFileReadError extends Error {
  readonly code: GitErrorCode

  constructor(code: GitErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

export function gitFileReadFailure(path: string, error: GitErrorDto): GitFileReadResult {
  const state = error.code === 'output-limit' ? 'oversized'
    : error.code === 'trust-required' ? 'trust-required'
    : error.code === 'not-repository' ? 'not-repository'
    : error.code === 'unsupported' ? 'unsupported' : 'error'
  return { path, state, text: null, byteCount: 0, statusRevision: null, error }
}

/** Walk from a pinned Linux directory handle; no path component may follow a symlink. */
export async function readRepositoryFile(root: string, path: string): Promise<Uint8Array> {
  if (process.platform !== 'linux') throw new GitFileReadError('unsupported', 'Safe file reading requires the Linux Host.')
  if (!isCanonicalAbsolutePath(root) || !isRepositoryRelativePath(path)) {
    throw new GitFileReadError('invalid-path', 'File reading requires a repository-relative path.')
  }
  const handles: FileHandle[] = []
  try {
    const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    const base = await open(root, directoryFlags)
    handles.push(base)
    if (await realpath(`/proc/self/fd/${base.fd}`) !== root) throw new GitFileReadError('stale', 'Repository directory changed before reading.')
    const segments = path.split('/')
    for (const name of segments.slice(0, -1)) {
      handles.push(await open(`/proc/self/fd/${handles.at(-1)!.fd}/${name}`, directoryFlags))
    }
    const file = await open(`/proc/self/fd/${handles.at(-1)!.fd}/${segments.at(-1)!}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    handles.push(file)
    const before = await file.stat({ bigint: true })
    if (!before.isFile()) throw new GitFileReadError('unsupported', 'Only regular files can be read.')
    if (before.size > BigInt(GIT_FILE_READ_MAX_BYTES)) throw new GitFileReadError('output-limit', 'File exceeds the 256 KiB reading limit.')
    const buffer = Buffer.alloc(GIT_FILE_READ_MAX_BYTES + 1)
    let size = 0
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size)
      if (bytesRead === 0) break
      size += bytesRead
    }
    if (size > GIT_FILE_READ_MAX_BYTES) throw new GitFileReadError('output-limit', 'File exceeds the 256 KiB reading limit.')
    const after = await file.stat({ bigint: true })
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
      before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode ||
      await realpath(`/proc/self/fd/${file.fd}`) !== resolve(root, path)) {
      throw new GitFileReadError('stale', 'File identity changed while reading.')
    }
    return buffer.subarray(0, size)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ELOOP' || code === 'ENOTDIR') throw new GitFileReadError('unsupported', 'Symbolic links and non-directory path components cannot be read.')
    if (code === 'ENOENT') throw new GitFileReadError('stale', 'File was removed or its path changed. Refresh the changes list.')
    if (code === 'EACCES' || code === 'EPERM') throw new GitFileReadError('git-error', 'The Linux user cannot read this file.')
    throw error
  } finally {
    await Promise.all(handles.map((handle) => handle.close()))
  }
}
