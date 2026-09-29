import type { ChildProcessWithoutNullStreams } from 'node:child_process'

/* Limits, environments and internal record types of GitService (moved unchanged, D-098). */

export const DEFAULT_TIMEOUT_MS = 15_000

export const DEFAULT_MAX_STATUS_BYTES = 2 * 1024 * 1024

export const DEFAULT_MAX_STATUS_FILES = 2_000

export const DEFAULT_MAX_DIFF_BYTES = 1024 * 1024

export const DEFAULT_MAX_DIFF_FILES = 25

export const DEFAULT_MAX_DIFF_HUNKS = 200

export const DEFAULT_MAX_DIFF_LINES = 5_000

export const DEFAULT_MAX_AUTOMATIC_FINGERPRINT_BYTES = 1024 * 1024

export const CONTENT_HASH_WORKERS = 4

export const MAX_ERROR_MESSAGE_CHARACTERS = 512

export const MAX_ERROR_STDERR_CHARACTERS = 2 * 1024 * 1024

export const GIT_HISTORY_READ_ENV = { GIT_GRAFT_FILE: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1' } as const

export const GIT_BRANCH_SYNC_READ_ENV = { GIT_GRAFT_FILE: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1' } as const

export const GIT_NETWORK_ENV = { GIT_TERMINAL_PROMPT: '0' } as const

export const GIT_HISTORY_STREAM_STDERR_MAX_BYTES = 64 * 1024

export const GIT_REMOTE_TRACKING_SCAN_MAX = 512

export type StatusRecord = {
  path: string
  originalPath: string | null
  indexCode: string
  worktreeCode: string
  conflicted: boolean
  untracked: boolean
}

export type RunOptions = {
  signal?: AbortSignal
  maxOutputBytes: number
  timeoutMs?: number
  env?: Record<string, string>
  stdin?: string
}

export type HistoryNameStatusRecord = readonly [status: string, path: string] | readonly [status: string, originalPath: string, path: string]

export type FileIdentity = {
  dev: string
  ino: string
  mode: string
  size: string
  mtime: string
  ctime: string
}

export type MutationContentFence = {
  rawOid: string | null
}

export type CommitInspection = {
  oid: string
  parentMatched: boolean
  snapshotMatched: boolean
}

export type ExactWorktreeContent = {
  kind: 'regular' | 'symlink'
  mode: string
  rawOid: string
  filteredOid: string
}

export type HashChild = {
  process: ChildProcessWithoutNullStreams
  stdout: Buffer[]
  stderr: Buffer[]
  outputBytes: number
  inputError: Error | null
  result: Promise<{ code: number | null; error: Error | null }>
}

export type IndexEntry = {
  mode: string
  oid: string
}
