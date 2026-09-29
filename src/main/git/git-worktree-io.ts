import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { lstat, readlink, type FileHandle } from 'node:fs/promises'
import { GitRunError, assertNotAborted, errorDto, isFileNotFoundError } from './git-admission.ts'
import type { FileIdentity } from './git-service-types.ts'

/* Bounded, no-follow worktree file reads and content hashing helpers (moved unchanged from git-service.ts, D-098). */

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let nextIndex = 0
  let stopped = false
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (!stopped) {
      const index = nextIndex
      nextIndex += 1
      if (index >= values.length) return
      try {
        results[index] = await mapper(values[index]!)
      } catch (error) {
        stopped = true
        throw error
      }
    }
  })
  await Promise.all(workers)
  return results
}

export async function readBounded(handle: FileHandle, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array | null> {
  const buffer = Buffer.allocUnsafe(maxBytes + 1)
  let offset = 0
  while (offset < buffer.length) {
    assertNotAborted(signal)
    const length = Math.min(64 * 1024, buffer.length - offset)
    const { bytesRead } = await handle.read(buffer, offset, length, offset)
    if (bytesRead === 0) break
    offset += bytesRead
  }
  assertNotAborted(signal)
  return offset > maxBytes ? null : buffer.subarray(0, offset)
}

export function toFileIdentity(stat: {
  dev: number | bigint
  ino: number | bigint
  mode: number | bigint
  size: number | bigint
  mtimeMs?: number | bigint
  ctimeMs?: number | bigint
  mtimeNs?: bigint
  ctimeNs?: bigint
}): FileIdentity {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    size: String(stat.size),
    mtime: stat.mtimeNs === undefined ? String(stat.mtimeMs) : String(stat.mtimeNs),
    ctime: stat.ctimeNs === undefined ? String(stat.ctimeMs) : String(stat.ctimeNs)
  }
}

export function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtime === right.mtime &&
    left.ctime === right.ctime
}

export function serializeFileIdentity(identity: FileIdentity): string {
  return [identity.dev, identity.ino, identity.mode, identity.size, identity.mtime, identity.ctime].join(':')
}

export function assertSafeNoFollowPlatform(): void {
  if (process.platform !== 'linux' || !Number.isSafeInteger(fsConstants.O_NOFOLLOW) || fsConstants.O_NOFOLLOW === 0) {
    throw new GitRunError(errorDto('unsupported', 'Safe no-follow Git worktree reads require Linux O_NOFOLLOW support.'))
  }
}

export async function readStableSymbolicLink(absolutePath: string, expectedIdentity: FileIdentity): Promise<Buffer> {
  let bytes: Buffer
  try {
    bytes = await readlink(absolutePath, { encoding: 'buffer' })
  } catch (error) {
    if (isNoFollowRaceError(error) || isInvalidFileTypeError(error)) {
      throw new GitRunError(errorDto('stale', 'Git symbolic-link identity changed while its link text was read.'))
    }
    throw error
  }
  await assertPathIdentityUnchanged(absolutePath, expectedIdentity)
  return bytes
}

export async function assertPathIdentityUnchanged(absolutePath: string, expectedIdentity: FileIdentity): Promise<void> {
  let after
  try {
    after = await lstat(absolutePath, { bigint: true })
  } catch (error) {
    if (isFileNotFoundError(error)) {
      throw new GitRunError(errorDto('stale', 'Git worktree path disappeared while it was read.'))
    }
    throw error
  }
  if (!sameFileIdentity(expectedIdentity, toFileIdentity(after))) {
    throw new GitRunError(errorDto('stale', 'Git worktree path identity changed while it was read.'))
  }
}

export function worktreeFileKind(stat: {
  isBlockDevice(): boolean
  isCharacterDevice(): boolean
  isDirectory(): boolean
  isFIFO(): boolean
  isSocket(): boolean
}): string {
  if (stat.isDirectory()) return 'directory'
  if (stat.isFIFO()) return 'fifo'
  if (stat.isSocket()) return 'socket'
  if (stat.isBlockDevice()) return 'block-device'
  if (stat.isCharacterDevice()) return 'character-device'
  return 'unknown'
}

export function isNoFollowRaceError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error.code === 'ELOOP' || error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

export function isInvalidFileTypeError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EINVAL'
}

export async function writeHashChunk(child: ChildProcessWithoutNullStreams, chunk: Uint8Array): Promise<void> {
  await new Promise<void>((resolveWrite, rejectWrite) => {
    child.stdin.write(chunk, (error) => error === null || error === undefined ? resolveWrite() : rejectWrite(error))
  })
}

export async function endHashInput(child: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolveEnd, rejectEnd) => {
    child.stdin.end((error?: Error | null) => error === null || error === undefined ? resolveEnd() : rejectEnd(error))
  })
}

export function killHashChild(child: ChildProcessWithoutNullStreams): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch (error) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH')) throw error
  }
}
