import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { lstat, open, readlink, realpath, type FileHandle } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { simpleGit } from 'simple-git'

import {
  GIT_BRANCH_LIST_MAX,
  GIT_BRANCH_SYNC_NETWORK_TIMEOUT_MS,
  GIT_HISTORY_MAX_CHANGED_FILES,
  GIT_HISTORY_MESSAGE_MAX_UTF8_BYTES,
  GIT_HISTORY_PAGE_SIZE,
  GIT_REMOTE_LIST_MAX,
  GIT_REMOTE_TRACKING_LIST_MAX,
  GIT_REPOSITORY_RELATIVE_PATH_MAX_UTF8_BYTES
} from '../../shared/git-contract.ts'
import type {
  GitBranchEntry,
  GitBranchMutationWarning,
  GitBranchStep,
  GitBranchSyncActions,
  GitBranchSyncCurrent,
  GitBranchSyncExecutionRequest,
  GitBranchSyncExecutionResult,
  GitBranchSyncPrepareResult,
  GitBranchSyncPushStep,
  GitBranchSyncSnapshot,
  GitChangeKind,
  GitCommitExecutionRequest,
  GitCommitExecutionResult,
  GitCommitPreview,
  GitCommitPreviewResult,
  GitCommitSnapshot,
  GitCommitWarning,
  GitDiffFile,
  GitDiffHunk,
  GitDiffKind,
  GitDiffLine,
  GitDiffRequest,
  GitDiffResult,
  GitErrorCode,
  GitErrorDto,
  GitFastForwardStep,
  GitFileChange,
  GitFileMutationRequest,
  GitHistoryCommitDetail,
  GitHistoryCommitSummary,
  GitHistoryDetailRequest,
  GitHistoryDetailResult,
  GitHistoryFileChange,
  GitHistoryFileDiffRequest,
  GitHistoryFileDiffResult,
  GitHistoryFileEntry,
  GitHistoryListRequest,
  GitHistoryListResult,
  GitHistorySnapshot,
  GitMutationResult,
  GitNetworkRemoteStep,
  GitPushTarget,
  GitRefreshResult,
  GitRemoteEntry,
  GitRepositoryState
} from '../../shared/git-contract.ts'
import { isGitRefName } from './git-command-validation.ts'

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_STATUS_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_STATUS_FILES = 2_000
const DEFAULT_MAX_DIFF_BYTES = 1024 * 1024
const DEFAULT_MAX_DIFF_FILES = 25
const DEFAULT_MAX_DIFF_HUNKS = 200
const DEFAULT_MAX_DIFF_LINES = 5_000
const DEFAULT_MAX_AUTOMATIC_FINGERPRINT_BYTES = 1024 * 1024
const CONTENT_HASH_WORKERS = 4
const MAX_ERROR_MESSAGE_CHARACTERS = 512
const MAX_ERROR_STDERR_CHARACTERS = 2 * 1024 * 1024
const GIT_HISTORY_READ_ENV = { GIT_GRAFT_FILE: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1' } as const
const GIT_BRANCH_SYNC_READ_ENV = { GIT_GRAFT_FILE: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1' } as const
const GIT_NETWORK_ENV = { GIT_TERMINAL_PROMPT: '0' } as const
const GIT_HISTORY_STREAM_STDERR_MAX_BYTES = 64 * 1024
const GIT_REMOTE_TRACKING_SCAN_PAGE_SIZE = 64
const GIT_REMOTE_TRACKING_SCAN_MAX_PAGES = 8

export type GitServiceOptions = {
  gitBinary?: string
  timeoutMs?: number
  maxStatusBytes?: number
  maxStatusFiles?: number
  maxDiffBytes?: number
  maxDiffFiles?: number
  maxDiffHunks?: number
  maxDiffLines?: number
  /** Maximum regular-file bytes read per file during automatic refresh and exact-rename coalescing. */
  maxAutomaticFingerprintBytes?: number
  /** Exact canonical repository root authorized by Main when the Project is inside an ancestor repository. */
  authorizedRepositoryRoot?: string
}

/** @internal Deterministic filesystem-race injection used only by the focused Main tests. */
type GitServiceTestHooks = {
  beforeNoFollowOpen?: (absolutePath: string) => Promise<void>
}

type ResolvedOptions = Required<Omit<GitServiceOptions, 'authorizedRepositoryRoot'>> & Pick<GitServiceOptions, 'authorizedRepositoryRoot'>

type StatusRecord = {
  path: string
  originalPath: string | null
  indexCode: string
  worktreeCode: string
  conflicted: boolean
  untracked: boolean
}

type RunOptions = {
  signal?: AbortSignal
  maxOutputBytes: number
  timeoutMs?: number
  env?: Record<string, string>
  stdin?: string
}

type HistoryNameStatusRecord = readonly [status: string, path: string] | readonly [status: string, originalPath: string, path: string]

type FileIdentity = {
  dev: string
  ino: string
  mode: string
  size: string
  mtime: string
  ctime: string
}

type MutationContentFence = {
  rawOid: string | null
}

type CommitInspection = {
  oid: string
  parentMatched: boolean
  snapshotMatched: boolean
}

type ExactWorktreeContent = {
  kind: 'regular' | 'symlink'
  mode: string
  rawOid: string
  filteredOid: string
}

type HashChild = {
  process: ChildProcessWithoutNullStreams
  stdout: Buffer[]
  stderr: Buffer[]
  outputBytes: number
  result: Promise<{ code: number | null; error: Error | null }>
}

type IndexEntry = {
  mode: string
  oid: string
}

class GitRunError extends Error {
  readonly dto: GitErrorDto

  constructor(dto: GitErrorDto) {
    super(dto.message)
    this.name = 'GitRunError'
    this.dto = dto
  }
}

class SerialQueue {
  private tail: Promise<void> = Promise.resolve()

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
}

const repositoryQueues = new Map<string, SerialQueue>()

export class GitService {
  private readonly projectRoot: string
  private readonly options: ResolvedOptions
  private readonly testHooks: GitServiceTestHooks
  private readonly branchCapabilitySecret = randomBytes(32)

  constructor(projectRoot: string, options: GitServiceOptions = {}, testHooks: GitServiceTestHooks = {}) {
    if (!isAbsolute(projectRoot)) throw new Error('Git project root must be absolute.')
    if (options.authorizedRepositoryRoot !== undefined && !isAbsolute(options.authorizedRepositoryRoot)) {
      throw new Error('Authorized Git repository root must be absolute.')
    }
    this.projectRoot = projectRoot
    this.options = {
      gitBinary: options.gitBinary ?? 'git',
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxStatusBytes: options.maxStatusBytes ?? DEFAULT_MAX_STATUS_BYTES,
      maxStatusFiles: options.maxStatusFiles ?? DEFAULT_MAX_STATUS_FILES,
      maxDiffBytes: options.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES,
      maxDiffFiles: options.maxDiffFiles ?? DEFAULT_MAX_DIFF_FILES,
      maxDiffHunks: options.maxDiffHunks ?? DEFAULT_MAX_DIFF_HUNKS,
      maxDiffLines: options.maxDiffLines ?? DEFAULT_MAX_DIFF_LINES,
      maxAutomaticFingerprintBytes: options.maxAutomaticFingerprintBytes ?? DEFAULT_MAX_AUTOMATIC_FINGERPRINT_BYTES,
      authorizedRepositoryRoot: options.authorizedRepositoryRoot
    }
    this.testHooks = testHooks
    assertPositiveOptions(this.options)
  }

  async refreshSafe(signal?: AbortSignal): Promise<GitRefreshResult> {
    try {
      return { ok: true, state: await this.refresh(signal) }
    } catch (error) {
      return { ok: false, error: toPublicErrorDto(error) }
    }
  }

  async refresh(signal?: AbortSignal): Promise<GitRepositoryState> {
    const projectRoot = await realpath(this.projectRoot)
    let repositoryRoot: string
    try {
      repositoryRoot = await realpath((await this.runRaw(
        projectRoot,
        ['rev-parse', '--show-toplevel'],
        { signal, maxOutputBytes: 16 * 1024 }
      )).trim())
    } catch (error) {
      if (isActualNotRepositoryError(error)) return notRepositoryState(projectRoot)
      throw error
    }

    if (repositoryRoot !== projectRoot) {
      const authorizedRoot = this.options.authorizedRepositoryRoot === undefined
        ? null
        : await realpath(this.options.authorizedRepositoryRoot)
      if (authorizedRoot !== repositoryRoot) return trustRequiredState(projectRoot, repositoryRoot)
    }

    const [headText, branchText, statusText, indexText] = await Promise.all([
      this.runRaw(repositoryRoot, ['rev-parse', '--verify', '--quiet', 'HEAD'], {
        signal,
        maxOutputBytes: 64 * 1024
      }),
      this.runRaw(repositoryRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
        signal,
        maxOutputBytes: 64 * 1024
      }),
      this.runRaw(repositoryRoot, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--find-renames'], {
        signal,
        maxOutputBytes: this.options.maxStatusBytes
      }),
      this.runRaw(repositoryRoot, ['ls-files', '--stage', '-z'], {
        signal,
        maxOutputBytes: this.options.maxStatusBytes
      })
    ])
    const headOid = trimNullable(headText)
    const branch = trimNullable(branchText)
    const records = parseStatus(statusText)
    const truncated = records.length > this.options.maxStatusFiles
    const visibleRecords = await this.coalesceExactWorktreeRenames(
      repositoryRoot,
      records.slice(0, this.options.maxStatusFiles),
      indexText,
      signal
    )
    const indexTreeOid = records.some((record) => record.conflicted)
      ? null
      : trimNullable(await this.runRaw(repositoryRoot, ['write-tree'], {
          signal,
          maxOutputBytes: 64 * 1024
        }))
    const upstream = headOid === null || branch === null
      ? null
      : trimNullable(await this.runRaw(
          repositoryRoot,
          ['for-each-ref', '--format=%(upstream:short)', `refs/heads/${branch}`],
          { signal, maxOutputBytes: 64 * 1024 }
        ))
    const [ahead, behind] = headOid !== null && upstream !== null
      ? await this.readAheadBehind(repositoryRoot, signal)
      : [0, 0]
    const files = await mapWithConcurrency(
      visibleRecords,
      CONTENT_HASH_WORKERS,
      (record) => this.mapStatusFile(repositoryRoot, record, signal)
    )
    const indexFingerprint = digest(indexText)
    const worktreeFingerprint = digest([
      statusText,
      truncated ? `truncated:${records.length}` : 'complete',
      ...files.map((file) => `${file.path}\0${file.fingerprint}`)
    ].join('\0'))
    const statusRevision = digest([
      repositoryRoot,
      headOid ?? 'unborn',
      indexTreeOid ?? 'unmerged-index',
      indexFingerprint,
      worktreeFingerprint
    ].join('\0'))

    return {
      kind: 'repository',
      projectRoot,
      repositoryRoot,
      headOid,
      branch,
      detached: headOid !== null && branch === null,
      upstream,
      ahead,
      behind,
      indexTreeOid,
      indexFingerprint,
      worktreeFingerprint,
      statusRevision,
      files,
      truncated,
      refreshedAt: Date.now(),
      lastError: null
    }
  }

  async getDiff(request: GitDiffRequest, signal?: AbortSignal): Promise<GitDiffResult> {
    let state: GitRepositoryState | null = null
    try {
      state = await this.refresh(signal)
      if (state.kind === 'not-repository' || state.repositoryRoot === null) {
        return emptyDiff(request, 'not-repository', state, errorDto('not-repository', 'Project is not a Git repository.'))
      }
      if (state.kind === 'trust-required') {
        return emptyDiff(request, 'trust-required', state, trustRequiredError())
      }
      const path = validateRepositoryPath(request.path, state.repositoryRoot)
      const statusFile = state.files.find((file) => file.path === path)
      if (statusFile === undefined) {
        return emptyDiffFromPath(
          request.kind,
          path,
          'error',
          state,
          errorDto('stale', 'Requested path is not present in the current bounded Git status projection.')
        )
      }
      const stale = staleError(request, state)
      if (stale !== null) return emptyDiff(request, 'error', state, stale)
      if (statusFile.conflicted) {
        return emptyDiffFromPath(request.kind, path, 'conflict', state, errorDto('conflict', 'Conflicted files require an explicit conflict workflow.'))
      }

      let result: GitDiffResult
      if (statusFile?.state === 'untracked') {
        result = request.kind === 'working'
          ? await this.readUntrackedDiff(path, state, signal)
          : {
              ...emptyDiffFromPath(request.kind, path, 'ready', state, null),
              revision: diffRevision(request.kind, state, path, ''),
              byteCount: 0
            }
      } else {
        const pathspecs = validatedPathspecsForStatusFile(path, statusFile, state.repositoryRoot)
        const baseArgs = request.kind === 'working'
          ? ['diff', '--no-ext-diff', '--binary', '--find-renames', '--full-index']
          : ['diff', '--cached', '--no-ext-diff', '--binary', '--find-renames', '--full-index', await this.diffBase(state, signal)]
        const patch = await this.runRaw(state.repositoryRoot, [...baseArgs, '--', ...pathspecs], {
          signal,
          maxOutputBytes: this.options.maxDiffBytes
        })
        result = patch.length === 0
          ? {
              ...emptyDiffFromPath(request.kind, path, 'ready', state, null),
              revision: diffRevision(request.kind, state, path, patch),
              byteCount: 0
            }
          : this.parseSingleFileDiff(request.kind, path, patch, state, statusFile)
      }

      assertNotAborted(signal)
      const settled = await this.refresh(signal)
      if (!sameRepositoryIdentity(state, settled)) {
        return emptyDiffFromPath(request.kind, path, 'error', settled, errorDto('stale', 'Repository identity changed while the diff was read.'))
      }
      return result
    } catch (error) {
      const dto = toErrorDto(error)
      const fallback = dto.code === 'aborted' || dto.code === 'timeout'
        ? state
        : await this.safeRefresh()
      const resultState = dto.code === 'output-limit'
        ? 'oversized'
        : dto.code === 'unsupported'
          ? 'unsupported'
          : dto.code === 'trust-required'
            ? 'trust-required'
            : dto.code === 'conflict'
              ? 'conflict'
              : 'error'
      return emptyDiff(request, resultState, fallback, toPublicErrorDto(error))
    }
  }

  async listHistory(request: GitHistoryListRequest, signal?: AbortSignal): Promise<GitHistoryListResult> {
    let state: GitRepositoryState | null = null
    try {
      state = await this.refresh(signal)
      const admission = admitHistoryState(state, request.snapshot)
      if (admission.kind === 'failure') return admission.result
      if (admission.state.headOid === null) {
        return {
          ok: true,
          snapshot: request.snapshot,
          commits: [],
          offset: request.offset,
          pageSize: GIT_HISTORY_PAGE_SIZE,
          hasMore: false
        }
      }

      const logText = await this.runRaw(
        admission.state.repositoryRoot,
        [
          '-c', 'core.quotepath=false',
          'log',
          `--max-count=${GIT_HISTORY_PAGE_SIZE + 1}`,
          `--skip=${request.offset}`,
          '--format=%H%x00%h%x00%s%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%P',
          admission.state.headOid,
          '--'
        ],
        { signal, maxOutputBytes: 2 * 1024 * 1024, env: GIT_HISTORY_READ_ENV }
      )
      const parsed = parseHistorySummaries(logText)
      const hasMore = parsed.length > GIT_HISTORY_PAGE_SIZE
      const commits = parsed.slice(0, GIT_HISTORY_PAGE_SIZE)

      assertNotAborted(signal)
      const settled = await this.refresh(signal)
      const settledAdmission = admitHistoryState(settled, request.snapshot)
      if (settledAdmission.kind === 'failure') return settledAdmission.result

      return {
        ok: true,
        snapshot: request.snapshot,
        commits,
        offset: request.offset,
        pageSize: GIT_HISTORY_PAGE_SIZE,
        hasMore
      }
    } catch (error) {
      return historyListFailure(toPublicErrorDto(error), request.snapshot, await this.currentHistorySnapshot(state, signal))
    }
  }

  async getHistoryDetail(
    request: GitHistoryDetailRequest,
    signal?: AbortSignal
  ): Promise<GitHistoryDetailResult> {
    let state: GitRepositoryState | null = null
    try {
      state = await this.refresh(signal)
      const admission = admitHistoryState(state, request.snapshot)
      if (admission.kind === 'failure') return admission.result
      if (admission.state.headOid === null) {
        return historyDetailFailure(
          errorDto('stale', 'Requested commit is not reachable from the confirmed HEAD.'),
          request.snapshot,
          historySnapshotFromState(admission.state)
        )
      }

      await this.assertHistoryOidReachable(
        admission.state.repositoryRoot,
        request.oid,
        admission.state.headOid,
        signal
      )
      const summaryText = await this.runRaw(
        admission.state.repositoryRoot,
        [
          '-c', 'core.quotepath=false',
          'log',
          '-n', '1',
          '--format=%H%x00%h%x00%s%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%P',
          request.oid,
          '--'
        ],
        { signal, maxOutputBytes: 256 * 1024, env: GIT_HISTORY_READ_ENV }
      )
      const summaries = parseHistorySummaries(summaryText)
      if (summaries.length !== 1 || summaries[0]!.oid !== request.oid) {
        throw new GitRunError(errorDto('git-error', 'Git returned an invalid history detail identity.'))
      }
      const { message, messageTruncated } = await this.readHistoryMessage(
        admission.state.repositoryRoot,
        request.oid,
        signal
      )
      const changedFiles = await this.readHistoryChangedFiles(
        admission.state.repositoryRoot,
        request.oid,
        summaries[0]!.parentOids,
        signal
      )
      const filesTruncated = changedFiles.truncated
      const files = changedFiles.files
      const commit: GitHistoryCommitDetail = {
        ...summaries[0]!,
        message,
        messageTruncated
      }

      assertNotAborted(signal)
      const settled = await this.refresh(signal)
      const settledAdmission = admitHistoryState(settled, request.snapshot)
      if (settledAdmission.kind === 'failure') return settledAdmission.result

      return {
        ok: true,
        snapshot: request.snapshot,
        commit,
        files,
        filesTruncated
      }
    } catch (error) {
      return historyDetailFailure(toPublicErrorDto(error), request.snapshot, await this.currentHistorySnapshot(state, signal))
    }
  }

  async getHistoryFileDiff(
    request: GitHistoryFileDiffRequest,
    signal?: AbortSignal
  ): Promise<GitHistoryFileDiffResult> {
    let state: GitRepositoryState | null = null
    try {
      state = await this.refresh(signal)
      const admission = admitHistoryState(state, request.snapshot)
      if (admission.kind === 'failure') {
        return emptyHistoryFileDiff(
          request,
          admission.result.error.code === 'trust-required'
            ? 'trust-required'
            : admission.result.error.code === 'not-repository'
              ? 'not-repository'
              : 'error',
          admission.result.current,
          admission.result.error
        )
      }
      if (admission.state.headOid === null) {
        return emptyHistoryFileDiff(
          request,
          'error',
          historySnapshotFromState(admission.state),
          errorDto('stale', 'Requested commit is not reachable from the confirmed HEAD.')
        )
      }

      await this.assertHistoryOidReachable(
        admission.state.repositoryRoot,
        request.oid,
        admission.state.headOid,
        signal
      )
      const summaryText = await this.runRaw(
        admission.state.repositoryRoot,
        [
          '-c', 'core.quotepath=false',
          'log',
          '-n', '1',
          '--format=%H%x00%h%x00%s%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%P',
          request.oid,
          '--'
        ],
        { signal, maxOutputBytes: 256 * 1024, env: GIT_HISTORY_READ_ENV }
      )
      const summaries = parseHistorySummaries(summaryText)
      if (summaries.length !== 1 || summaries[0]!.oid !== request.oid) {
        throw new GitRunError(errorDto('git-error', 'Git returned an invalid history detail identity.'))
      }
      const files = (await this.readHistoryChangedFiles(
        admission.state.repositoryRoot,
        request.oid,
        summaries[0]!.parentOids,
        signal
      )).files
      const file = files.find((entry) => entry.fileId === request.fileId)
      if (file === undefined) {
        return emptyHistoryFileDiff(
          request,
          'error',
          historySnapshotFromState(admission.state),
          errorDto('stale', 'Requested history file identity is missing from the bounded commit file list.')
        )
      }

      const path = validateRepositoryPath(file.path, admission.state.repositoryRoot)
      const pathspecs = file.originalPath === null
        ? [path]
        : [
            validateRepositoryPath(file.originalPath, admission.state.repositoryRoot),
            path
          ]
      const patch = await this.readHistoryFilePatch(
        admission.state.repositoryRoot,
        request.oid,
        summaries[0]!.parentOids,
        pathspecs,
        signal
      )
      const result = this.parseHistoryFileDiff(request, file, patch)

      assertNotAborted(signal)
      const settled = await this.refresh(signal)
      const settledAdmission = admitHistoryState(settled, request.snapshot)
      if (settledAdmission.kind === 'failure') {
        return emptyHistoryFileDiff(
          request,
          settledAdmission.result.error.code === 'trust-required'
            ? 'trust-required'
            : settledAdmission.result.error.code === 'not-repository'
              ? 'not-repository'
              : 'error',
          settledAdmission.result.current,
          settledAdmission.result.error
        )
      }
      return result
    } catch (error) {
      const dto = toPublicErrorDto(error)
      const resultState = dto.code === 'output-limit'
        ? 'oversized'
        : dto.code === 'unsupported'
          ? 'unsupported'
          : dto.code === 'trust-required'
            ? 'trust-required'
            : dto.code === 'not-repository'
              ? 'not-repository'
              : 'error'
      return emptyHistoryFileDiff(
        request,
        resultState,
        await this.currentHistorySnapshot(state, signal),
        dto
      )
    }
  }

  async mutateFile(request: GitFileMutationRequest, signal?: AbortSignal): Promise<GitMutationResult> {
    let discovered: GitRepositoryState
    try {
      discovered = await this.refresh(signal)
    } catch (error) {
      return {
        ok: false,
        action: request.action,
        path: request.path,
        error: toPublicErrorDto(error),
        state: null
      }
    }
    if (discovered.kind !== 'repository' || discovered.repositoryRoot === null) {
      return {
        ok: false,
        action: request.action,
        path: request.path,
        error: discovered.kind === 'trust-required' ? trustRequiredError() : errorDto('not-repository', 'Project is not a Git repository.'),
        state: discovered
      }
    }
    try {
      const path = validateRepositoryPath(request.path, discovered.repositoryRoot)
      const stale = staleMutationError(request, discovered, path)
      if (stale !== null) throw new GitRunError(stale)
    } catch (error) {
      return {
        ok: false,
        action: request.action,
        path: request.path,
        error: toPublicErrorDto(error),
        state: discovered
      }
    }
    return this.resolveQueue(discovered.repositoryRoot).run(async () => {
      let latest: GitRepositoryState | null = null
      try {
        latest = await this.refresh(signal)
        if (latest.kind !== 'repository' || latest.repositoryRoot === null) {
          throw new GitRunError(latest.kind === 'trust-required' ? trustRequiredError() : errorDto('not-repository', 'Project is not a Git repository.'))
        }
        const path = validateRepositoryPath(request.path, latest.repositoryRoot)
        const stale = staleMutationError(request, latest, path)
        if (stale !== null) throw new GitRunError(stale)
        const statusFile = latest.files.find((file) => file.path === path)!
        const pathspecs = validatedPathspecsForStatusFile(path, statusFile, latest.repositoryRoot)
        const before = await this.assertImmediateMutationIdentity(request, latest.repositoryRoot, path, signal)
        assertNotAborted(signal)
        if (request.action === 'stage') {
          // A pure worktree rename still has the old path in the index, so both validated sides
          // must be updated atomically. A staged rename with later working edits only refreshes
          // the new path and preserves the rename already recorded in the index.
          const args = statusFile.worktreeChange === 'renamed'
            ? ['add', '-A', '--', ...pathspecs]
            : ['add', '--', path]
          await this.runRaw(latest.repositoryRoot, args, {
            signal,
            maxOutputBytes: 64 * 1024
          })
        } else if (latest.headOid === null) {
          await this.runRaw(latest.repositoryRoot, ['rm', '--cached', '--force', '--', ...pathspecs], {
            signal,
            maxOutputBytes: 64 * 1024
          })
        } else {
          await this.runRaw(latest.repositoryRoot, ['reset', '--quiet', 'HEAD', '--', ...pathspecs], {
            signal,
            maxOutputBytes: 64 * 1024
          })
        }
        const settled = await this.refresh(signal)
        await this.assertPostMutationIdentity(request, latest, settled, path, before, signal)
        return { ok: true, action: request.action, path, state: settled }
      } catch (error) {
        const dto = toErrorDto(error)
        const settled = dto.code === 'aborted' || dto.code === 'timeout'
          ? latest
          : await this.safeRefresh()
        return {
          ok: false,
          action: request.action,
          path: request.path,
          error: toPublicErrorDto(error),
          state: settled ?? latest
        }
      }
    })
  }

  async prepareCommit(signal?: AbortSignal): Promise<GitCommitPreviewResult> {
    let discovered: GitRepositoryState
    try {
      discovered = await this.refresh(signal)
    } catch (error) {
      return { ok: false, error: toPublicErrorDto(error), state: null }
    }
    if (discovered.kind !== 'repository' || discovered.repositoryRoot === null) {
      return {
        ok: false,
        error: discovered.kind === 'trust-required'
          ? trustRequiredErrorPublic()
          : errorDto('not-repository', 'Project is not a Git repository.'),
        state: discovered
      }
    }
    return this.resolveQueue(discovered.repositoryRoot).run(async () => {
      let latest: GitRepositoryState | null = null
      try {
        latest = await this.refresh(signal)
        const preview = await this.buildCommitPreview(latest, signal)
        return { ok: true, preview }
      } catch (error) {
        const dto = toErrorDto(error)
        const settled = dto.code === 'aborted' || dto.code === 'timeout'
          ? latest
          : await this.safeRefresh()
        return {
          ok: false,
          error: toPublicErrorDto(error),
          state: settled ?? latest
        }
      }
    })
  }

  async prepareBranchSync(signal?: AbortSignal): Promise<GitBranchSyncPrepareResult> {
    let discovered: GitRepositoryState
    try {
      discovered = await this.refresh(signal)
    } catch (error) {
      return { ok: false, error: toPublicErrorDto(error), state: null }
    }
    if (discovered.kind !== 'repository' || discovered.repositoryRoot === null) {
      return {
        ok: false,
        error: discovered.kind === 'trust-required'
          ? trustRequiredErrorPublic()
          : errorDto('not-repository', 'Project is not a Git repository.'),
        state: discovered
      }
    }
    return this.resolveQueue(discovered.repositoryRoot).run(async () => {
      let latest: GitRepositoryState | null = null
      try {
        latest = await this.refresh(signal)
        return await this.buildBranchSyncView(latest, signal)
      } catch (error) {
        const dto = toErrorDto(error)
        const settled = dto.code === 'aborted' || dto.code === 'timeout'
          ? latest
          : await this.safeRefresh()
        return {
          ok: false,
          error: toPublicErrorDto(error),
          state: settled ?? latest
        }
      }
    })
  }

  async executeBranchSync(
    request: GitBranchSyncExecutionRequest
  ): Promise<GitBranchSyncExecutionResult> {
    const action = request.action
    let discovered: GitRepositoryState
    try {
      discovered = await this.refresh()
    } catch (error) {
      const publicError = toPublicErrorDto(error)
      return failedBranchSyncExecution(action, publicError, {
        ok: false,
        error: publicError,
        state: null
      })
    }
    if (discovered.kind !== 'repository' || discovered.repositoryRoot === null) {
      const error = discovered.kind === 'trust-required'
        ? trustRequiredErrorPublic()
        : errorDto('not-repository', 'Project is not a Git repository.')
      return failedBranchSyncExecution(action, error, {
        ok: false,
        error,
        state: discovered
      })
    }
    return this.resolveQueue(discovered.repositoryRoot).run(async () => {
      try {
        switch (request.action) {
          case 'create-and-switch':
            return await this.executeCreateAndSwitch(request)
          case 'switch':
            return await this.executeSwitchBranch(request)
          case 'fetch':
            return await this.executeFetchRemote(request)
          case 'pull':
            return await this.executePullUpstream(request)
          case 'push':
            return await this.executePushUpstream(request)
        }
      } catch (error) {
        return failedBranchSyncExecution(action, toPublicErrorDto(error), await this.safeBranchSyncView())
      }
    })
  }

  async executeCommit(
    request: GitCommitExecutionRequest,
    signal?: AbortSignal
  ): Promise<GitCommitExecutionResult> {
    const mode = request.mode
    let discovered: GitRepositoryState
    try {
      discovered = await this.refresh(signal)
    } catch (error) {
      const publicError = toPublicErrorDto(error)
      return failedCommitExecution(mode, publicError, { ok: false, error: publicError })
    }
    if (discovered.kind !== 'repository' || discovered.repositoryRoot === null) {
      const error = discovered.kind === 'trust-required'
        ? trustRequiredErrorPublic()
        : errorDto('not-repository', 'Project is not a Git repository.')
      return failedCommitExecution(mode, error, { ok: true, state: discovered })
    }
    return this.resolveQueue(discovered.repositoryRoot).run(async () => {
      let latest: GitRepositoryState | null = null
      let confirmed: GitCommitSnapshot
      let message: string
      let pushTarget: GitPushTarget | null
      try {
        latest = await this.refresh(signal)
        assertCommitAdmission(latest, request)
        message = validateCommitMessage(request.message)
        pushTarget = await this.readPushTarget(latest.repositoryRoot!, latest.branch!, signal)
        assertPushTargetFence(mode, request.expectedPushTarget, pushTarget)
        await this.assertCommitIdentity(latest.repositoryRoot!, signal)
        const stagedPaths = await this.readStagedPaths(latest.repositoryRoot!, signal)
        if (stagedPaths.length === 0) {
          throw new GitRunError(errorDto('unsupported', 'There are no staged changes to commit.'))
        }
        assertNotAborted(signal)
        confirmed = snapshotFromState(latest)
      } catch (error) {
        return failedCommitExecution(mode, toPublicErrorDto(error), await this.refreshSafe())
      }

      let commandError: unknown = null
      try {
        await this.runCommit(confirmed.repositoryRoot, mode === 'amend', message, signal)
      } catch (error) {
        commandError = error
      }

      let inspection: CommitInspection | null = null
      let inspectionUnavailable = false
      try {
        inspection = await this.inspectCommitAttempt(confirmed.repositoryRoot, mode, confirmed)
      } catch {
        inspectionUnavailable = true
      }
      if (commandError !== null && (inspection === null || !inspection.parentMatched)) {
        return failedCommitExecution(mode, toPublicErrorDto(commandError), await this.refreshSafe())
      }

      const warnings: GitCommitWarning[] = []
      if (commandError !== null) warnings.push('command-error-after-landing')
      if (inspectionUnavailable || inspection === null) {
        warnings.push('verification-unavailable')
      } else if (!inspection.snapshotMatched) {
        warnings.push('confirmed-snapshot-diverged')
      }
      const commitStep = {
        status: 'succeeded' as const,
        oid: inspection?.oid ?? null,
        warnings
      }
      if (mode !== 'commit-and-push') {
        return {
          mode,
          commit: commitStep,
          push: null,
          postState: await this.refreshSafe()
        }
      }

      const activeTarget = pushTarget!
      try {
        assertNotAborted(signal)
        const afterCommit = await this.refresh(signal)
        if (
          afterCommit.kind !== 'repository' ||
          afterCommit.repositoryRoot !== confirmed.repositoryRoot ||
          afterCommit.branch !== confirmed.branch
        ) {
          throw new GitRunError(errorDto('stale', 'Repository identity changed after the commit and before push.'))
        }
        const liveTarget = await this.readPushTarget(afterCommit.repositoryRoot!, afterCommit.branch!, signal)
        assertPushTargetFence(mode, request.expectedPushTarget, liveTarget)
        assertNotAborted(signal)
        await this.runPush(afterCommit.repositoryRoot!, liveTarget!, signal)
        return {
          mode,
          commit: commitStep,
          push: { status: 'succeeded', remote: liveTarget!.remote, branch: liveTarget!.branch },
          postState: await this.refreshSafe()
        }
      } catch (error) {
        return {
          mode,
          commit: commitStep,
          push: {
            status: 'failed',
            remote: activeTarget.remote,
            branch: activeTarget.branch,
            error: toPublicErrorDto(error)
          },
          postState: await this.refreshSafe()
        }
      }
    })
  }

  private async buildCommitPreview(
    state: GitRepositoryState,
    signal?: AbortSignal
  ): Promise<GitCommitPreview> {
    if (state.kind !== 'repository' || state.repositoryRoot === null) {
      throw new GitRunError(
        state.kind === 'trust-required'
          ? trustRequiredError()
          : errorDto('not-repository', 'Project is not a Git repository.')
      )
    }
    if (state.detached || state.branch === null) {
      throw new GitRunError(errorDto('unsupported', 'Commit requires a named branch; detached HEAD is unsupported.'))
    }
    if (state.indexTreeOid === null || state.files.some((file) => file.conflicted)) {
      throw new GitRunError(errorDto('conflict', 'Git repository has unresolved conflicts.'))
    }
    if (state.truncated) {
      throw new GitRunError(errorDto('unsupported', 'Git status is truncated; commit is blocked until status is complete.'))
    }
    await this.assertCommitIdentity(state.repositoryRoot, signal)
    const stagedPaths = await this.readStagedPaths(state.repositoryRoot, signal)
    if (stagedPaths.length === 0) {
      throw new GitRunError(errorDto('unsupported', 'There are no staged changes to commit.'))
    }
    const pushTarget = await this.readPushTarget(state.repositoryRoot, state.branch, signal)
    return {
      snapshot: snapshotFromState(state),
      stagedFileCount: stagedPaths.length,
      pushTarget,
      amendAvailable: state.headOid !== null,
      suggestedMessage: suggestCommitMessage(stagedPaths)
    }
  }

  private async readStagedPaths(repositoryRoot: string, signal?: AbortSignal): Promise<string[]> {
    const text = await this.runRaw(repositoryRoot, ['diff', '--cached', '--name-only', '-z'], {
      signal,
      maxOutputBytes: this.options.maxStatusBytes
    })
    const paths: string[] = []
    for (const record of text.split('\0')) {
      if (record.length === 0) continue
      paths.push(validateRepositoryPath(record, repositoryRoot))
    }
    return paths
  }

  private async readPushTarget(
    repositoryRoot: string,
    branch: string,
    signal?: AbortSignal
  ): Promise<GitPushTarget | null> {
    const text = await this.runRaw(
      repositoryRoot,
      ['for-each-ref', '--format=%(upstream:remotename)%00%(upstream:remoteref)', `refs/heads/${branch}`],
      { signal, maxOutputBytes: 64 * 1024 }
    )
    const trimmed = text.replace(/\n+$/u, '')
    if (trimmed.length === 0) return null
    const parts = trimmed.split('\0')
    if (parts.length < 2) return null
    const remote = parts[0]!.trim()
    const remoteref = parts[1]!.trim()
    if (remote.length === 0 || remoteref.length === 0) return null
    if (!isGitRefName(remote)) {
      throw new GitRunError(errorDto('unsupported', 'Upstream remote name is unsafe for push.'))
    }
    if (!remoteref.startsWith('refs/heads/')) {
      throw new GitRunError(errorDto('unsupported', 'Upstream is not a branch ref and cannot be used for push.'))
    }
    const upstreamBranch = remoteref.slice('refs/heads/'.length)
    if (!isGitRefName(upstreamBranch)) {
      throw new GitRunError(errorDto('unsupported', 'Upstream branch ref is invalid.'))
    }
    return { remote, branch: upstreamBranch }
  }

  private async readUpstreamTrackingRef(
    repositoryRoot: string,
    branch: string,
    signal?: AbortSignal
  ): Promise<string> {
    const text = await this.runRaw(
      repositoryRoot,
      ['for-each-ref', '--format=%(upstream)', `refs/heads/${branch}`],
      { signal, maxOutputBytes: 64 * 1024, env: { ...GIT_BRANCH_SYNC_READ_ENV } }
    )
    const upstreamRef = trimNullable(text)
    if (
      upstreamRef === null ||
      !upstreamRef.startsWith('refs/remotes/') ||
      !isGitRefName(upstreamRef)
    ) {
      throw new GitRunError(errorDto(
        'unsupported',
        'Configured upstream does not resolve to a safe remote-tracking ref.'
      ))
    }
    return upstreamRef
  }

  private async assertCommitIdentity(repositoryRoot: string, signal?: AbortSignal): Promise<void> {
    try {
      const author = trimNullable(await this.runRaw(repositoryRoot, ['var', 'GIT_AUTHOR_IDENT'], {
        signal,
        maxOutputBytes: 16 * 1024
      }))
      const committer = trimNullable(await this.runRaw(repositoryRoot, ['var', 'GIT_COMMITTER_IDENT'], {
        signal,
        maxOutputBytes: 16 * 1024
      }))
      if (author === null || committer === null) {
        throw new GitRunError(errorDto('unsupported', 'Git author or committer identity is unavailable.'))
      }
    } catch (error) {
      if (error instanceof GitRunError && error.dto.code === 'unsupported') throw error
      throw new GitRunError(errorDto(
        'unsupported',
        'Git author or committer identity is unavailable.',
        stderrLength(error)
      ))
    }
  }

  private async runCommit(
    repositoryRoot: string,
    amend: boolean,
    message: string,
    signal?: AbortSignal
  ): Promise<void> {
    const args = amend
      ? ['commit', '--amend', '--file=-', '--cleanup=verbatim']
      : ['commit', '--file=-', '--cleanup=verbatim']
    await this.runRaw(repositoryRoot, args, {
      signal,
      maxOutputBytes: 1024 * 1024,
      stdin: message.endsWith('\n') ? message : `${message}\n`
    })
  }

  private async runPush(
    repositoryRoot: string,
    target: GitPushTarget,
    signal?: AbortSignal
  ): Promise<void> {
    await this.runRaw(
      repositoryRoot,
      ['push', '--porcelain', '--', target.remote, `HEAD:refs/heads/${target.branch}`],
      {
        signal,
        maxOutputBytes: 1024 * 1024,
        env: { ...GIT_NETWORK_ENV }
      }
    )
  }

  private async buildBranchSyncView(
    state: GitRepositoryState,
    signal?: AbortSignal
  ): Promise<GitBranchSyncPrepareResult> {
    if (state.kind !== 'repository' || state.repositoryRoot === null) {
      return {
        ok: false,
        error: state.kind === 'trust-required'
          ? trustRequiredErrorPublic()
          : errorDto('not-repository', 'Project is not a Git repository.'),
        state
      }
    }
    const repositoryRoot = state.repositoryRoot
    const [localBranchesRaw, remoteTrackingRaw, remotesRaw, pushTarget] = await Promise.all([
      this.listLocalBranches(repositoryRoot, signal),
      this.listRemoteTrackingBranches(repositoryRoot, signal),
      this.listConfiguredRemotes(repositoryRoot, signal),
      state.branch === null || state.headOid === null
        ? Promise.resolve(null)
        : this.readPushTarget(repositoryRoot, state.branch, signal)
    ])
    const localBranchesTruncated = localBranchesRaw.length > GIT_BRANCH_LIST_MAX
    const remoteTrackingBranchesTruncated = remoteTrackingRaw.truncated
    const remotesTruncated = remotesRaw.length > GIT_REMOTE_LIST_MAX
    const conflicted = state.files.some((file) => file.conflicted) || state.indexTreeOid === null
    const clean = state.files.length === 0 && !conflicted && !state.truncated
    const namedNonUnborn = state.branch !== null && state.headOid !== null && !state.detached
    const mutationReady = namedNonUnborn && clean && !conflicted && !state.truncated
    const hasUpstream = pushTarget !== null
    const snapshot: GitBranchSyncSnapshot = {
      repositoryRoot,
      headOid: state.headOid,
      branch: state.branch,
      indexTreeOid: state.indexTreeOid,
      indexFingerprint: state.indexFingerprint,
      worktreeFingerprint: state.worktreeFingerprint,
      statusRevision: state.statusRevision,
      upstreamRemote: pushTarget?.remote ?? null,
      upstreamBranch: pushTarget?.branch ?? null
    }
    const localBranches = localBranchesRaw.slice(0, GIT_BRANCH_LIST_MAX).map((entry) => ({
      branchId: this.branchCapabilityId('local', snapshot, entry.name, entry.headOid),
      kind: 'local' as const,
      name: entry.name,
      headOid: entry.headOid,
      isCurrent: state.branch !== null && entry.name === state.branch
    }))
    const remoteTrackingBranches = remoteTrackingRaw.entries.slice(0, GIT_REMOTE_TRACKING_LIST_MAX).map((entry) => ({
      branchId: this.branchCapabilityId('remote-tracking', snapshot, entry.name, entry.headOid),
      kind: 'remote-tracking' as const,
      name: entry.name,
      headOid: entry.headOid,
      isCurrent: false
    }))
    const remotes = remotesRaw.slice(0, GIT_REMOTE_LIST_MAX).map((name) => ({
      remoteId: this.branchCapabilityId('remote', snapshot, name, null),
      name
    }))
    const current: GitBranchSyncCurrent = {
      branch: state.branch,
      headOid: state.headOid,
      detached: state.detached,
      unborn: state.headOid === null,
      upstream: state.upstream,
      upstreamRemote: pushTarget?.remote ?? null,
      upstreamBranch: pushTarget?.branch ?? null,
      ahead: state.ahead,
      behind: state.behind,
      clean,
      conflicted,
      truncated: state.truncated
    }
    const actions: GitBranchSyncActions = {
      canCreate: mutationReady,
      canSwitch: mutationReady,
      canFetch: remotes.length > 0,
      canPull: mutationReady && hasUpstream,
      canPush: namedNonUnborn && hasUpstream && !conflicted && !state.truncated
    }
    return {
      ok: true,
      snapshot,
      current,
      localBranches,
      localBranchesTruncated,
      remoteTrackingBranches,
      remoteTrackingBranchesTruncated,
      remotes,
      remotesTruncated,
      actions
    }
  }

  private async safeBranchSyncView(): Promise<GitBranchSyncPrepareResult> {
    try {
      const state = await this.refresh()
      return await this.buildBranchSyncView(state)
    } catch (error) {
      return { ok: false, error: toPublicErrorDto(error), state: null }
    }
  }

  private async listLocalBranches(
    repositoryRoot: string,
    signal?: AbortSignal
  ): Promise<Array<{ name: string; headOid: string | null }>> {
    const text = await this.runRaw(
      repositoryRoot,
      [
        'for-each-ref',
        `--count=${GIT_BRANCH_LIST_MAX + 1}`,
        '--format=%(refname:short)%00%(objectname)',
        'refs/heads/'
      ],
      {
        signal,
        maxOutputBytes: 2 * 1024 * 1024,
        env: { ...GIT_BRANCH_SYNC_READ_ENV }
      }
    )
    const entries: Array<{ name: string; headOid: string | null }> = []
    for (const line of splitNonEmptyLines(text)) {
      const parts = line.split('\0')
      if (parts.length !== 2) {
        throw new GitRunError(errorDto('git-error', 'Git returned an invalid local branch record.'))
      }
      const name = parts[0]!
      const headOid = parts[1]!.trim()
      if (!isGitRefName(name)) {
        throw new GitRunError(errorDto('unsupported', 'Local branch name is unsafe.'))
      }
      if (headOid.length > 0 && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(headOid)) {
        throw new GitRunError(errorDto('git-error', 'Git returned an invalid local branch identity.'))
      }
      entries.push({ name, headOid: headOid.length === 0 ? null : headOid })
    }
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
    return entries
  }

  private async listRemoteTrackingBranches(
    repositoryRoot: string,
    signal?: AbortSignal
  ): Promise<{
    entries: Array<{ name: string; headOid: string | null }>
    truncated: boolean
  }> {
    const entries: Array<{ name: string; headOid: string | null }> = []
    let startAfter = 'refs/remotes/'
    let exhausted = false

    for (
      let page = 0;
      page < GIT_REMOTE_TRACKING_SCAN_MAX_PAGES && entries.length <= GIT_REMOTE_TRACKING_LIST_MAX;
      page += 1
    ) {
      const text = await this.runRaw(
        repositoryRoot,
        [
          'for-each-ref',
          `--count=${GIT_REMOTE_TRACKING_SCAN_PAGE_SIZE}`,
          `--start-after=${startAfter}`,
          '--format=%(refname)%00%(refname:short)%00%(objectname)%00%(symref)'
        ],
        {
          signal,
          maxOutputBytes: 512 * 1024,
          env: { ...GIT_BRANCH_SYNC_READ_ENV }
        }
      )
      const records = splitNonEmptyLines(text)
      if (records.length === 0) {
        exhausted = true
        break
      }
      for (const line of records) {
        const parts = line.split('\0')
        if (parts.length !== 4) {
          throw new GitRunError(errorDto('git-error', 'Git returned an invalid remote-tracking branch record.'))
        }
        const refname = parts[0]!
        const name = parts[1]!
        const headOid = parts[2]!.trim()
        const symref = parts[3]!.trim()
        if (!refname.startsWith('refs/remotes/')) {
          exhausted = true
          break
        }
        if (!isGitRefName(refname)) {
          throw new GitRunError(errorDto('unsupported', 'Remote-tracking ref name is unsafe.'))
        }
        startAfter = refname
        if (symref.length > 0) continue
        if (!isGitRefName(name)) {
          throw new GitRunError(errorDto('unsupported', 'Remote-tracking branch name is unsafe.'))
        }
        if (headOid.length > 0 && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(headOid)) {
          throw new GitRunError(errorDto('git-error', 'Git returned an invalid remote-tracking branch identity.'))
        }
        entries.push({ name, headOid: headOid.length === 0 ? null : headOid })
        if (entries.length > GIT_REMOTE_TRACKING_LIST_MAX) break
      }
      if (exhausted || records.length < GIT_REMOTE_TRACKING_SCAN_PAGE_SIZE) {
        exhausted = true
        break
      }
    }

    return {
      entries,
      truncated: entries.length > GIT_REMOTE_TRACKING_LIST_MAX || !exhausted
    }
  }

  private async listConfiguredRemotes(
    repositoryRoot: string,
    signal?: AbortSignal
  ): Promise<string[]> {
    const text = await this.runRaw(repositoryRoot, ['remote'], {
      signal,
      maxOutputBytes: 64 * 1024,
      env: { ...GIT_BRANCH_SYNC_READ_ENV }
    })
    const names: string[] = []
    for (const line of splitNonEmptyLines(text)) {
      const name = line.trim()
      if (name.length === 0) continue
      if (!isGitRefName(name)) {
        throw new GitRunError(errorDto('unsupported', 'Configured remote name is unsafe.'))
      }
      names.push(name)
    }
    names.sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    return names
  }

  private async executeCreateAndSwitch(
    request: Extract<GitBranchSyncExecutionRequest, { action: 'create-and-switch' }>
  ): Promise<GitBranchSyncExecutionResult> {
    let latest: GitRepositoryState
    try {
      latest = await this.refresh()
      assertBranchMutationAdmission(latest, request.snapshot)
      const name = await this.validateNewBranchName(latest.repositoryRoot!, request.name)
      const existing = await this.listLocalBranches(latest.repositoryRoot!)
      if (existing.some((entry) => entry.name === name)) {
        throw new GitRunError(errorDto('unsupported', 'A local branch with that name already exists.'))
      }
      let commandError: unknown = null
      try {
        await this.runRaw(
          latest.repositoryRoot!,
          ['switch', '--no-guess', '-c', name],
          { maxOutputBytes: 1024 * 1024 }
        )
      } catch (error) {
        commandError = error
      }
      const inspection = await this.inspectBranchLanding(latest.repositoryRoot!, name, latest.headOid!)
      if (commandError !== null && inspection === null) {
        return {
          action: 'create-and-switch',
          branch: { status: 'failed', error: toPublicErrorDto(commandError) },
          fetch: null,
          fastForward: null,
          push: null,
          postView: await this.safeBranchSyncView()
        }
      }
      const warnings: GitBranchMutationWarning[] = []
      if (commandError !== null) warnings.push('command-error-after-landing')
      if (inspection === null) warnings.push('verification-unavailable')
      return {
        action: 'create-and-switch',
        branch: {
          status: 'succeeded',
          branch: name,
          headOid: inspection?.headOid ?? latest.headOid!,
          warnings
        },
        fetch: null,
        fastForward: null,
        push: null,
        postView: await this.safeBranchSyncView()
      }
    } catch (error) {
      return failedBranchSyncExecution('create-and-switch', toPublicErrorDto(error), await this.safeBranchSyncView())
    }
  }

  private async executeSwitchBranch(
    request: Extract<GitBranchSyncExecutionRequest, { action: 'switch' }>
  ): Promise<GitBranchSyncExecutionResult> {
    try {
      const latest = await this.refresh()
      assertBranchMutationAdmission(latest, request.snapshot)
      const target = await this.resolveLocalBranchId(latest.repositoryRoot!, request.snapshot, request.branchId)
      if (latest.branch === target.name) {
        return {
          action: 'switch',
          branch: {
            status: 'succeeded',
            branch: target.name,
            headOid: target.headOid ?? latest.headOid!,
            warnings: []
          },
          fetch: null,
          fastForward: null,
          push: null,
          postView: await this.safeBranchSyncView()
        }
      }
      if (target.headOid === null) {
        throw new GitRunError(errorDto('unsupported', 'Target local branch has no commit identity.'))
      }
      let commandError: unknown = null
      try {
        await this.runRaw(
          latest.repositoryRoot!,
          ['switch', '--no-guess', '--', target.name],
          { maxOutputBytes: 1024 * 1024 }
        )
      } catch (error) {
        commandError = error
      }
      const inspection = await this.inspectBranchLanding(latest.repositoryRoot!, target.name, target.headOid)
      if (commandError !== null && inspection === null) {
        return {
          action: 'switch',
          branch: { status: 'failed', error: toPublicErrorDto(commandError) },
          fetch: null,
          fastForward: null,
          push: null,
          postView: await this.safeBranchSyncView()
        }
      }
      const warnings: GitBranchMutationWarning[] = []
      if (commandError !== null) warnings.push('command-error-after-landing')
      if (inspection === null) warnings.push('verification-unavailable')
      return {
        action: 'switch',
        branch: {
          status: 'succeeded',
          branch: target.name,
          headOid: inspection?.headOid ?? target.headOid,
          warnings
        },
        fetch: null,
        fastForward: null,
        push: null,
        postView: await this.safeBranchSyncView()
      }
    } catch (error) {
      return failedBranchSyncExecution('switch', toPublicErrorDto(error), await this.safeBranchSyncView())
    }
  }

  private async executeFetchRemote(
    request: Extract<GitBranchSyncExecutionRequest, { action: 'fetch' }>
  ): Promise<GitBranchSyncExecutionResult> {
    try {
      const latest = await this.refresh()
      assertRepositoryRootFence(latest, request.snapshot.repositoryRoot)
      const remote = await this.resolveRemoteId(latest.repositoryRoot!, request.snapshot, request.remoteId)
      const fetchStep = await this.runNetworkFetch(latest.repositoryRoot!, remote)
      return {
        action: 'fetch',
        branch: null,
        fetch: fetchStep,
        fastForward: null,
        push: null,
        postView: await this.safeBranchSyncView()
      }
    } catch (error) {
      return failedBranchSyncExecution('fetch', toPublicErrorDto(error), await this.safeBranchSyncView())
    }
  }

  private async executePullUpstream(
    request: Extract<GitBranchSyncExecutionRequest, { action: 'pull' }>
  ): Promise<GitBranchSyncExecutionResult> {
    try {
      const latest = await this.refresh()
      assertBranchMutationAdmission(latest, request.snapshot)
      assertUpstreamFence(latest, request.snapshot)
      const target = await this.readPushTarget(latest.repositoryRoot!, latest.branch!)
      if (target === null) {
        throw new GitRunError(errorDto('unsupported', 'Pull requires a configured upstream branch.'))
      }
      if (
        target.remote !== request.snapshot.upstreamRemote ||
        target.branch !== request.snapshot.upstreamBranch
      ) {
        throw new GitRunError(errorDto('stale', 'Upstream changed before pull.'))
      }
      const fromOid = latest.headOid!
      const fetchStep = await this.runNetworkFetch(latest.repositoryRoot!, target.remote)
      if (fetchStep.status !== 'succeeded') {
        return {
          action: 'pull',
          branch: null,
          fetch: fetchStep,
          fastForward: null,
          push: null,
          postView: await this.safeBranchSyncView()
        }
      }

      let fastForward: GitFastForwardStep
      try {
        const afterFetch = await this.refresh()
        assertCleanNamedBranchState(afterFetch)
        if (
          afterFetch.repositoryRoot !== request.snapshot.repositoryRoot ||
          afterFetch.branch !== request.snapshot.branch ||
          afterFetch.headOid !== request.snapshot.headOid ||
          afterFetch.indexTreeOid !== request.snapshot.indexTreeOid ||
          afterFetch.indexFingerprint !== request.snapshot.indexFingerprint ||
          afterFetch.worktreeFingerprint !== request.snapshot.worktreeFingerprint
        ) {
          throw new GitRunError(errorDto('stale', 'Repository identity changed during pull fetch.'))
        }
        const liveTarget = await this.readPushTarget(afterFetch.repositoryRoot!, afterFetch.branch!)
        if (
          liveTarget === null ||
          liveTarget.remote !== target.remote ||
          liveTarget.branch !== target.branch
        ) {
          throw new GitRunError(errorDto('stale', 'Upstream changed during pull.'))
        }
        const upstreamRef = await this.readUpstreamTrackingRef(
          afterFetch.repositoryRoot!,
          afterFetch.branch!
        )
        const upstreamOid = trimNullable(await this.runRaw(
          afterFetch.repositoryRoot!,
          ['rev-parse', '--verify', '--quiet', upstreamRef],
          {
            maxOutputBytes: 64 * 1024,
            env: { ...GIT_BRANCH_SYNC_READ_ENV }
          }
        ))
        if (upstreamOid === null) {
          throw new GitRunError(errorDto('unsupported', 'Upstream remote-tracking ref is missing after fetch.'))
        }
        if (upstreamOid === fromOid) {
          fastForward = {
            status: 'succeeded',
            branch: afterFetch.branch!,
            fromOid,
            toOid: fromOid,
            alreadyUpToDate: true,
            warnings: []
          }
        } else {
          let mergeError: unknown = null
          try {
            await this.runRaw(
              afterFetch.repositoryRoot!,
              ['merge', '--ff-only', upstreamOid],
              { maxOutputBytes: 1024 * 1024 }
            )
          } catch (error) {
            mergeError = error
          }
          if (mergeError !== null) {
            const landed = await this.inspectBranchLanding(
              afterFetch.repositoryRoot!,
              afterFetch.branch!,
              upstreamOid
            )
            if (landed === null) throw mergeError
            fastForward = {
              status: 'succeeded',
              branch: landed.branch,
              fromOid,
              toOid: landed.headOid,
              alreadyUpToDate: false,
              warnings: ['command-error-after-landing']
            }
          } else {
            const toOid = trimNullable(await this.runRaw(
              afterFetch.repositoryRoot!,
              ['rev-parse', 'HEAD'],
              { maxOutputBytes: 64 * 1024 }
            ))
            if (toOid !== upstreamOid) {
              throw new GitRunError(errorDto('git-error', 'Fast-forward did not land on the upstream commit.'))
            }
            fastForward = {
              status: 'succeeded',
              branch: afterFetch.branch!,
              fromOid,
              toOid: toOid!,
              alreadyUpToDate: false,
              warnings: []
            }
          }
        }
      } catch (error) {
        fastForward = {
          status: 'failed',
          branch: latest.branch!,
          error: toPublicErrorDto(error)
        }
      }
      return {
        action: 'pull',
        branch: null,
        fetch: fetchStep,
        fastForward,
        push: null,
        postView: await this.safeBranchSyncView()
      }
    } catch (error) {
      return failedBranchSyncExecution('pull', toPublicErrorDto(error), await this.safeBranchSyncView())
    }
  }

  private async executePushUpstream(
    request: Extract<GitBranchSyncExecutionRequest, { action: 'push' }>
  ): Promise<GitBranchSyncExecutionResult> {
    try {
      const latest = await this.refresh()
      assertPushBranchAdmission(latest, request.snapshot)
      const target = await this.readPushTarget(latest.repositoryRoot!, latest.branch!)
      if (target === null) {
        throw new GitRunError(errorDto('unsupported', 'Push requires a configured upstream branch.'))
      }
      if (
        target.remote !== request.snapshot.upstreamRemote ||
        target.branch !== request.snapshot.upstreamBranch
      ) {
        throw new GitRunError(errorDto('stale', 'Upstream changed before push.'))
      }
      const beforePush = await this.refresh()
      assertPushBranchAdmission(beforePush, request.snapshot)
      const confirmedTarget = await this.readPushTarget(beforePush.repositoryRoot!, beforePush.branch!)
      if (
        confirmedTarget === null ||
        confirmedTarget.remote !== target.remote ||
        confirmedTarget.branch !== target.branch
      ) {
        throw new GitRunError(errorDto('stale', 'Upstream changed immediately before push.'))
      }
      if (request.snapshot.headOid === null) {
        throw new GitRunError(errorDto('stale', 'Confirmed push commit is unavailable.'))
      }
      const pushStep = await this.runNetworkPush(
        beforePush.repositoryRoot!,
        confirmedTarget,
        request.snapshot.headOid
      )
      return {
        action: 'push',
        branch: null,
        fetch: null,
        fastForward: null,
        push: pushStep,
        postView: await this.safeBranchSyncView()
      }
    } catch (error) {
      return failedBranchSyncExecution('push', toPublicErrorDto(error), await this.safeBranchSyncView())
    }
  }

  private async validateNewBranchName(repositoryRoot: string, name: string): Promise<string> {
    if (!isGitRefName(name)) {
      throw new GitRunError(errorDto('unsupported', 'Branch name is invalid.'))
    }
    try {
      await this.runRaw(
        repositoryRoot,
        ['check-ref-format', '--branch', name],
        { maxOutputBytes: 16 * 1024 }
      )
    } catch (error) {
      throw new GitRunError(errorDto(
        'unsupported',
        'Branch name failed Git ref-format validation.',
        stderrLength(error)
      ))
    }
    return name
  }

  private async resolveLocalBranchId(
    repositoryRoot: string,
    snapshot: GitBranchSyncSnapshot,
    branchId: string
  ): Promise<{ name: string; headOid: string | null }> {
    const branches = (await this.listLocalBranches(repositoryRoot)).slice(0, GIT_BRANCH_LIST_MAX)
    const match = branches.find((entry) => (
      this.branchCapabilityId('local', snapshot, entry.name, entry.headOid) === branchId
    ))
    if (match === undefined) {
      throw new GitRunError(errorDto('stale', 'Local branch identity is no longer available.'))
    }
    return match
  }

  private async resolveRemoteId(
    repositoryRoot: string,
    snapshot: GitBranchSyncSnapshot,
    remoteId: string
  ): Promise<string> {
    const remotes = (await this.listConfiguredRemotes(repositoryRoot)).slice(0, GIT_REMOTE_LIST_MAX)
    const match = remotes.find((name) => (
      this.branchCapabilityId('remote', snapshot, name, null) === remoteId
    ))
    if (match === undefined) {
      throw new GitRunError(errorDto('stale', 'Remote identity is no longer available.'))
    }
    return match
  }

  private async inspectBranchLanding(
    repositoryRoot: string,
    expectedBranch: string,
    expectedHeadOid: string
  ): Promise<{ branch: string; headOid: string } | null> {
    try {
      const branch = trimNullable(await this.runRaw(
        repositoryRoot,
        ['symbolic-ref', '--quiet', '--short', 'HEAD'],
        { maxOutputBytes: 64 * 1024 }
      ))
      const headOid = trimNullable(await this.runRaw(
        repositoryRoot,
        ['rev-parse', '--verify', '--quiet', 'HEAD'],
        { maxOutputBytes: 64 * 1024 }
      ))
      if (branch !== expectedBranch || headOid !== expectedHeadOid) return null
      return { branch, headOid }
    } catch {
      return null
    }
  }

  private networkTimeoutMs(): number {
    // Production default keeps the 120s network gate. Focused tests may lower timeoutMs.
    return this.options.timeoutMs < DEFAULT_TIMEOUT_MS
      ? this.options.timeoutMs
      : GIT_BRANCH_SYNC_NETWORK_TIMEOUT_MS
  }

  private async runNetworkFetch(
    repositoryRoot: string,
    remote: string
  ): Promise<GitNetworkRemoteStep> {
    try {
      await this.runRaw(
        repositoryRoot,
        ['fetch', '--', remote],
        {
          maxOutputBytes: 8 * 1024 * 1024,
          timeoutMs: this.networkTimeoutMs(),
          env: { ...GIT_NETWORK_ENV }
        }
      )
      return { status: 'succeeded', remote }
    } catch (error) {
      const publicError = toPublicErrorDto(error)
      if (isNetworkOutcomeUnknown(publicError)) {
        return { status: 'unknown', remote, error: publicError }
      }
      return { status: 'failed', remote, error: publicError }
    }
  }

  private async runNetworkPush(
    repositoryRoot: string,
    target: GitPushTarget,
    sourceOid: string
  ): Promise<GitBranchSyncPushStep> {
    try {
      await this.runRaw(
        repositoryRoot,
        ['push', '--porcelain', '--', target.remote, `${sourceOid}:refs/heads/${target.branch}`],
        {
          maxOutputBytes: 1024 * 1024,
          timeoutMs: this.networkTimeoutMs(),
          env: { ...GIT_NETWORK_ENV }
        }
      )
      return { status: 'succeeded', remote: target.remote, branch: target.branch }
    } catch (error) {
      const publicError = toPublicErrorDto(error)
      if (isNetworkOutcomeUnknown(publicError)) {
        return { status: 'unknown', remote: target.remote, branch: target.branch, error: publicError }
      }
      return { status: 'failed', remote: target.remote, branch: target.branch, error: publicError }
    }
  }

  private async inspectCommitAttempt(
    repositoryRoot: string,
    mode: GitCommitExecutionRequest['mode'],
    confirmed: GitCommitSnapshot
  ): Promise<CommitInspection | null> {
    const newOid = trimNullable(await this.runRaw(repositoryRoot, ['rev-parse', 'HEAD'], {
      maxOutputBytes: 64 * 1024
    }))
    if (newOid === null || newOid === confirmed.headOid) return null
    const treeOid = trimNullable(await this.runRaw(repositoryRoot, ['rev-parse', 'HEAD^{tree}'], {
      maxOutputBytes: 64 * 1024
    }))
    const parentsText = await this.runRaw(repositoryRoot, ['rev-list', '--parents', '-n1', 'HEAD'], {
      maxOutputBytes: 64 * 1024
    })
    const tokens = parentsText.trim().split(/\s+/u).filter((token) => token.length > 0)
    const parents = tokens[0] === newOid ? tokens.slice(1) : []
    let parentMatched = false
    if (mode === 'amend' && confirmed.headOid !== null) {
      const oldParentsText = await this.runRaw(
        repositoryRoot,
        ['rev-list', '--parents', '-n1', confirmed.headOid],
        { maxOutputBytes: 64 * 1024 }
      )
      const oldTokens = oldParentsText.trim().split(/\s+/u).filter((token) => token.length > 0)
      const oldParents = oldTokens.slice(1)
      parentMatched = parents.length === oldParents.length &&
        parents.every((parent, index) => parent === oldParents[index])
    } else if (confirmed.headOid === null) {
      parentMatched = parents.length === 0
    } else {
      parentMatched = parents.length === 1 && parents[0] === confirmed.headOid
    }
    return {
      oid: newOid,
      parentMatched,
      snapshotMatched: parentMatched && treeOid === confirmed.indexTreeOid
    }
  }

  private branchCapabilityId(
    kind: 'local' | 'remote-tracking' | 'remote',
    snapshot: GitBranchSyncSnapshot,
    name: string,
    headOid: string | null
  ): string {
    return createHmac('sha256', this.branchCapabilitySecret)
      .update([
        kind,
        snapshot.repositoryRoot,
        snapshot.statusRevision,
        snapshot.headOid ?? '',
        snapshot.branch ?? '',
        name,
        headOid ?? ''
      ].join('\0'))
      .digest('hex')
      .slice(0, 32)
  }

  private resolveQueue(repositoryRoot: string): SerialQueue {
    let queue = repositoryQueues.get(repositoryRoot)
    if (queue === undefined) {
      queue = new SerialQueue()
      repositoryQueues.set(repositoryRoot, queue)
    }
    return queue
  }

  private async assertImmediateMutationIdentity(
    request: GitFileMutationRequest,
    repositoryRoot: string,
    path: string,
    signal?: AbortSignal
  ): Promise<MutationContentFence> {
    const immediate = await this.refresh(signal)
    if (immediate.kind !== 'repository' || immediate.repositoryRoot !== repositoryRoot) {
      throw new GitRunError(errorDto('stale', 'Repository identity changed immediately before the Git mutation.'))
    }
    const validatedPath = validateRepositoryPath(path, immediate.repositoryRoot)
    const stale = staleMutationError(request, immediate, validatedPath)
    if (stale !== null) throw new GitRunError(errorDto('stale', 'Repository or file identity changed immediately before the Git mutation.'))
    return {
      rawOid: (await this.readExactWorktreeContent(repositoryRoot, path, false, signal))?.rawOid ?? null
    }
  }

  private async assertPostMutationIdentity(
    request: GitFileMutationRequest,
    beforeState: GitRepositoryState,
    settled: GitRepositoryState,
    path: string,
    before: MutationContentFence,
    signal?: AbortSignal
  ): Promise<void> {
    if (
      settled.kind !== 'repository' ||
      settled.repositoryRoot !== beforeState.repositoryRoot ||
      settled.headOid !== beforeState.headOid
    ) {
      throw new GitRunError(errorDto('stale', 'Repository identity diverged during the Git mutation.'))
    }
    const after = await this.readExactWorktreeContent(
      settled.repositoryRoot!,
      path,
      request.action === 'stage',
      signal
    )
    const rawOid = after?.rawOid ?? null
    if (rawOid !== before.rawOid) {
      throw new GitRunError(errorDto('stale', 'File content diverged during the Git mutation.'))
    }
    if (request.action === 'stage') {
      const expectedIndexOid = after?.filteredOid ?? null
      const actualIndexOid = await this.readIndexOid(settled.repositoryRoot!, path, signal)
      if (expectedIndexOid !== actualIndexOid) {
        throw new GitRunError(errorDto('stale', 'The staged content diverged from the confirmed working content.'))
      }
    }
    const [rootText, headText] = await Promise.all([
      this.runRaw(settled.repositoryRoot!, ['rev-parse', '--show-toplevel'], { signal, maxOutputBytes: 16 * 1024 }),
      this.runRaw(settled.repositoryRoot!, ['rev-parse', '--verify', '--quiet', 'HEAD'], { signal, maxOutputBytes: 64 * 1024 })
    ])
    if (await realpath(rootText.trim()) !== settled.repositoryRoot || trimNullable(headText) !== settled.headOid) {
      throw new GitRunError(errorDto('stale', 'Repository identity diverged after the Git mutation.'))
    }
  }

  private async safeRefresh(): Promise<GitRepositoryState | null> {
    try {
      return await this.refresh()
    } catch {
      return null
    }
  }

  private async currentHistorySnapshot(
    state: GitRepositoryState | null,
    signal?: AbortSignal
  ): Promise<GitHistorySnapshot | null> {
    if (state !== null && state.kind === 'repository' && state.repositoryRoot !== null) {
      return historySnapshotFromState(state)
    }
    const refreshed = signal === undefined ? await this.safeRefresh() : await this.safeRefreshWithSignal(signal)
    if (refreshed === null || refreshed.kind !== 'repository' || refreshed.repositoryRoot === null) return null
    return historySnapshotFromState(refreshed)
  }

  private async safeRefreshWithSignal(signal: AbortSignal): Promise<GitRepositoryState | null> {
    try {
      return await this.refresh(signal)
    } catch {
      return null
    }
  }

  private async assertHistoryOidReachable(
    repositoryRoot: string,
    oid: string,
    confirmedHeadOid: string,
    signal?: AbortSignal
  ): Promise<void> {
    try {
      await this.runRaw(repositoryRoot, ['merge-base', '--is-ancestor', oid, confirmedHeadOid], {
        signal,
        maxOutputBytes: 1024,
        env: GIT_HISTORY_READ_ENV
      })
    } catch (error) {
      if (error instanceof GitRunError && error.dto.code === 'git-error') {
        throw new GitRunError(errorDto('stale', 'Requested commit is not reachable from the confirmed HEAD.'))
      }
      throw error
    }
  }

  private async readHistoryMessage(
    repositoryRoot: string,
    oid: string,
    signal?: AbortSignal
  ): Promise<{ message: string; messageTruncated: boolean }> {
    const prefix = await this.runRawPrefix(
      repositoryRoot,
      ['log', '-n', '1', '--format=%B', oid, '--'],
      GIT_HISTORY_MESSAGE_MAX_UTF8_BYTES,
      signal
    )
    const bounded = boundHistoryMessage(prefix.text)
    return {
      message: bounded.message,
      messageTruncated: prefix.truncated || bounded.messageTruncated
    }
  }

  private async readHistoryChangedFiles(
    repositoryRoot: string,
    oid: string,
    parentOids: string[],
    signal?: AbortSignal
  ): Promise<{ files: GitHistoryFileEntry[]; truncated: boolean }> {
    const args = parentOids.length === 0
      ? [
          '-c', 'core.quotepath=false',
          'diff-tree',
          '--no-commit-id',
          '--root',
          '-r',
          '--find-renames',
          '-z',
          '--name-status',
          oid,
          '--'
        ]
      : [
          '-c', 'core.quotepath=false',
          'diff',
          '--find-renames',
          '-z',
          '--name-status',
          parentOids[0]!,
          oid,
          '--'
        ]
    const result = await this.runHistoryNameStatusRecords(repositoryRoot, args, signal)
    return {
      files: parseHistoryNameStatusRecords(result.records, oid, repositoryRoot),
      truncated: result.truncated
    }
  }

  private async runRawPrefix(
    cwd: string,
    args: string[],
    maxPrefixBytes: number,
    signal?: AbortSignal
  ): Promise<{ text: string; truncated: boolean }> {
    assertNotAborted(signal)
    const timeoutMs = this.options.timeoutMs
    return await new Promise((resolve, reject) => {
      let settled = false
      let timedOut = false
      let truncated = false
      let stdoutBytes = 0
      let retainedBytes = 0
      let stderrBytes = 0
      let streamFailure: GitRunError | null = null
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      const child = spawn(this.options.gitBinary, args, {
        cwd,
        detached: true,
        env: { ...process.env, LC_ALL: 'C', LANG: 'C', ...GIT_HISTORY_READ_ENV },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      const stop = (): void => {
        if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch (error) {
          if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH')) {
            streamFailure = new GitRunError(toErrorDto(error))
          }
        }
      }
      const onAbort = (): void => stop()
      const timer = setTimeout(() => {
        timedOut = true
        stop()
      }, timeoutMs)
      const finish = (error: Error | null, code: number | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        const stderrText = Buffer.concat(stderr).toString('utf8')
        if (streamFailure !== null) {
          reject(streamFailure)
          return
        }
        if (signal?.aborted) {
          reject(new GitRunError(errorDto('aborted', 'Git operation was aborted.', stderrBytes)))
          return
        }
        if (timedOut) {
          reject(new GitRunError(errorDto('timeout', 'Git operation timed out.', stderrBytes)))
          return
        }
        if (truncated) {
          resolve({ text: Buffer.concat(stdout).toString('utf8'), truncated: true })
          return
        }
        if (error !== null || code !== 0) {
          reject(new GitRunError(errorDto(
            'git-error',
            boundedGitMessage(error ?? new Error(stderrText || `Git exited ${code ?? 'without a status'}.`)),
            stderrBytes
          )))
          return
        }
        resolve({ text: Buffer.concat(stdout).toString('utf8'), truncated: false })
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength
        const retainedLimit = maxPrefixBytes + 4
        const remaining = retainedLimit - retainedBytes
        if (remaining > 0) {
          const retained = chunk.subarray(0, remaining)
          stdout.push(retained)
          retainedBytes += retained.byteLength
        }
        if (stdoutBytes > maxPrefixBytes && !truncated) {
          truncated = true
          stop()
        }
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.byteLength
        if (stderrBytes <= GIT_HISTORY_STREAM_STDERR_MAX_BYTES) stderr.push(chunk)
        if (stderrBytes > GIT_HISTORY_STREAM_STDERR_MAX_BYTES && streamFailure === null) {
          streamFailure = new GitRunError(errorDto(
            'output-limit',
            'Git stderr exceeded the configured byte budget.',
            stderrBytes
          ))
          stop()
        }
      })
      child.once('error', (error) => finish(error, null))
      child.once('close', (code) => finish(null, code))
    })
  }

  private async runHistoryNameStatusRecords(
    cwd: string,
    args: string[],
    signal?: AbortSignal
  ): Promise<{ records: HistoryNameStatusRecord[]; truncated: boolean }> {
    assertNotAborted(signal)
    const timeoutMs = this.options.timeoutMs
    return await new Promise((resolve, reject) => {
      let settled = false
      let timedOut = false
      let truncated = false
      let stderrBytes = 0
      let streamFailure: GitRunError | null = null
      let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0)
      let current: string[] | null = null
      let remainingPaths = 0
      const records: HistoryNameStatusRecord[] = []
      const stderr: Buffer[] = []
      const child = spawn(this.options.gitBinary, args, {
        cwd,
        detached: true,
        env: { ...process.env, LC_ALL: 'C', LANG: 'C', ...GIT_HISTORY_READ_ENV },
        stdio: ['ignore', 'pipe', 'pipe']
      })
      const stop = (): void => {
        if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch (error) {
          if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH')) {
            streamFailure = new GitRunError(toErrorDto(error))
          }
        }
      }
      const failStream = (error: GitRunError): void => {
        if (streamFailure === null) streamFailure = error
        stop()
      }
      const consumeToken = (tokenBytes: Buffer): void => {
        if (tokenBytes.byteLength > GIT_REPOSITORY_RELATIVE_PATH_MAX_UTF8_BYTES) {
          failStream(new GitRunError(errorDto(
            'output-limit',
            'Git history path exceeded the configured byte budget.'
          )))
          return
        }
        const token = tokenBytes.toString('utf8')
        if (current === null) {
          if (!/^[A-Z?][0-9]*$/.test(token)) {
            failStream(new GitRunError(errorDto('git-error', 'Git returned an invalid history file status.')))
            return
          }
          current = [token]
          remainingPaths = token[0] === 'R' || token[0] === 'C' ? 2 : 1
          return
        }
        if (token.length === 0) {
          failStream(new GitRunError(errorDto('git-error', 'Git returned an empty history file path.')))
          return
        }
        current.push(token)
        remainingPaths -= 1
        if (remainingPaths !== 0) return
        records.push(current as unknown as HistoryNameStatusRecord)
        current = null
        if (records.length > GIT_HISTORY_MAX_CHANGED_FILES) {
          truncated = true
          stop()
        }
      }
      const onAbort = (): void => stop()
      const timer = setTimeout(() => {
        timedOut = true
        stop()
      }, timeoutMs)
      const finish = (error: Error | null, code: number | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        const stderrText = Buffer.concat(stderr).toString('utf8')
        if (streamFailure !== null) {
          reject(streamFailure)
          return
        }
        if (signal?.aborted) {
          reject(new GitRunError(errorDto('aborted', 'Git operation was aborted.', stderrBytes)))
          return
        }
        if (timedOut) {
          reject(new GitRunError(errorDto('timeout', 'Git operation timed out.', stderrBytes)))
          return
        }
        if (truncated) {
          resolve({ records: records.slice(0, GIT_HISTORY_MAX_CHANGED_FILES), truncated: true })
          return
        }
        if (error !== null || code !== 0) {
          reject(new GitRunError(errorDto(
            'git-error',
            boundedGitMessage(error ?? new Error(stderrText || `Git exited ${code ?? 'without a status'}.`)),
            stderrBytes
          )))
          return
        }
        if (pending.byteLength !== 0 || current !== null) {
          reject(new GitRunError(errorDto('git-error', 'Git returned an incomplete history file record.')))
          return
        }
        resolve({ records, truncated: false })
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      child.stdout.on('data', (chunk: Buffer) => {
        if (truncated || streamFailure !== null) return
        pending = pending.byteLength === 0 ? chunk : Buffer.concat([pending, chunk])
        let separator = pending.indexOf(0)
        while (separator >= 0 && !truncated && streamFailure === null) {
          const token = pending.subarray(0, separator)
          pending = pending.subarray(separator + 1)
          consumeToken(token)
          separator = pending.indexOf(0)
        }
        if (
          pending.byteLength > GIT_REPOSITORY_RELATIVE_PATH_MAX_UTF8_BYTES &&
          streamFailure === null
        ) {
          failStream(new GitRunError(errorDto(
            'output-limit',
            'Git history token exceeded the configured byte budget.'
          )))
        }
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBytes += chunk.byteLength
        if (stderrBytes <= GIT_HISTORY_STREAM_STDERR_MAX_BYTES) stderr.push(chunk)
        if (stderrBytes > GIT_HISTORY_STREAM_STDERR_MAX_BYTES && streamFailure === null) {
          failStream(new GitRunError(errorDto(
            'output-limit',
            'Git stderr exceeded the configured byte budget.',
            stderrBytes
          )))
        }
      })
      child.once('error', (error) => finish(error, null))
      child.once('close', (code) => finish(null, code))
    })
  }

  private async readHistoryFilePatch(
    repositoryRoot: string,
    oid: string,
    parentOids: string[],
    pathspecs: string[],
    signal?: AbortSignal
  ): Promise<string> {
    const args = parentOids.length === 0
      ? [
          '-c', 'core.quotepath=false',
          'diff-tree',
          '--no-commit-id',
          '--root',
          '-p',
          '--binary',
          '--find-renames',
          '--full-index',
          oid,
          '--',
          ...pathspecs
        ]
      : [
          '-c', 'core.quotepath=false',
          'diff',
          '--no-ext-diff',
          '--binary',
          '--find-renames',
          '--full-index',
          parentOids[0]!,
          oid,
          '--',
          ...pathspecs
        ]
    return await this.runRaw(repositoryRoot, args, {
      signal,
      maxOutputBytes: this.options.maxDiffBytes,
      env: GIT_HISTORY_READ_ENV
    })
  }

  private parseHistoryFileDiff(
    request: GitHistoryFileDiffRequest,
    file: GitHistoryFileEntry,
    patch: string
  ): GitHistoryFileDiffResult {
    const byteCount = Buffer.byteLength(patch)
    const current = request.snapshot
    if (/(?:^|\n)(?:GIT binary patch|Binary files )/.test(patch)) {
      return {
        ...emptyHistoryFileDiff(request, 'binary', current, errorDto('unsupported', 'Binary diffs are not rendered.')),
        path: file.path,
        originalPath: file.originalPath,
        status: file.status,
        byteCount,
        snapshot: request.snapshot
      }
    }
    if (patch.length === 0) {
      return {
        oid: request.oid,
        fileId: request.fileId,
        path: file.path,
        originalPath: file.originalPath,
        status: file.status,
        state: 'ready',
        snapshot: request.snapshot,
        current: null,
        files: [{
          id: file.fileId,
          path: file.path,
          originalPath: file.originalPath,
          change: historyStatusToDiffChange(file.status),
          hunks: []
        }],
        byteCount: 0,
        hunkCount: 0,
        lineCount: 0,
        error: null
      }
    }
    let parsed: { hunks: GitDiffHunk[]; hasRenameHeader: boolean; hasModeOnlyChange: boolean }
    try {
      parsed = parseSingleFilePatch('staged', file.path, patch, this.options.maxDiffHunks, this.options.maxDiffLines)
    } catch (error) {
      const dto = toErrorDto(error)
      return {
        ...emptyHistoryFileDiff(
          request,
          dto.code === 'output-limit' ? 'oversized' : 'unsupported',
          current,
          dto
        ),
        path: file.path,
        originalPath: file.originalPath,
        status: file.status,
        byteCount,
        snapshot: request.snapshot
      }
    }
    const lineCount = parsed.hunks.reduce((total, hunk) => total + hunk.lines.length, 0)
    if (
      parsed.hunks.length > this.options.maxDiffHunks ||
      lineCount > this.options.maxDiffLines
    ) {
      return {
        ...emptyHistoryFileDiff(
          request,
          'oversized',
          current,
          errorDto('output-limit', 'Diff exceeds the configured structural budget.')
        ),
        path: file.path,
        originalPath: file.originalPath,
        status: file.status,
        byteCount,
        hunkCount: parsed.hunks.length,
        lineCount,
        snapshot: request.snapshot
      }
    }
    const change = historyStatusToDiffChange(file.status)
    const hunks = parsed.hunks.map((hunk) => ({
      ...hunk,
      id: digest([file.fileId, hunk.header, hunk.lines.map((line) => `${line.kind}:${line.content}`).join('\n')].join('\0')).slice(0, 24)
    }))
    return {
      oid: request.oid,
      fileId: request.fileId,
      path: file.path,
      originalPath: file.originalPath,
      status: file.status,
      state: 'ready',
      snapshot: request.snapshot,
      current: null,
      files: [{
        id: file.fileId,
        path: file.path,
        originalPath: file.originalPath,
        change,
        hunks
      }],
      byteCount,
      hunkCount: hunks.length,
      lineCount,
      error: null
    }
  }

  private async mapStatusFile(repositoryRoot: string, record: StatusRecord, signal?: AbortSignal): Promise<GitFileChange> {
    const path = validateRepositoryPath(record.path, repositoryRoot)
    const originalPath = record.originalPath === null
      ? null
      : validateRepositoryPath(record.originalPath, repositoryRoot)
    const indexChange = record.untracked ? 'unmodified' : mapStatusCode(record.indexCode)
    const worktreeChange = record.untracked ? 'untracked' : mapStatusCode(record.worktreeCode)
    const contentIdentity = worktreeChange === 'deleted'
      ? 'missing'
      : await this.readAutomaticWorktreeIdentity(repositoryRoot, path, signal)
    const fingerprint = digest([
      path,
      originalPath ?? '',
      record.indexCode,
      record.worktreeCode,
      contentIdentity
    ].join('\0'))
    return {
      id: digest(`${originalPath ?? ''}\0${path}`).slice(0, 24),
      path,
      originalPath,
      state: record.conflicted
        ? 'conflicted'
        : record.untracked
          ? 'untracked'
          : record.indexCode !== '.' && record.worktreeCode !== '.'
            ? 'mixed'
            : record.indexCode !== '.'
              ? 'staged'
              : 'unstaged',
      indexChange,
      worktreeChange,
      conflicted: record.conflicted,
      fingerprint
    }
  }

  private async readAutomaticWorktreeIdentity(
    repositoryRoot: string,
    path: string,
    signal?: AbortSignal
  ): Promise<string> {
    assertSafeNoFollowPlatform()
    const absolutePath = resolve(repositoryRoot, path)
    let before
    try {
      before = await lstat(absolutePath, { bigint: true })
    } catch (error) {
      if (isFileNotFoundError(error)) return 'missing'
      throw error
    }
    const beforeIdentity = toFileIdentity(before)
    if (before.isSymbolicLink()) {
      const linkBytes = await readStableSymbolicLink(absolutePath, beforeIdentity)
      const oid = await this.hashBytesFromStdin(repositoryRoot, ['hash-object', '--no-filters', '--stdin'], linkBytes, signal)
      return `symlink\0${serializeFileIdentity(beforeIdentity)}\0${oid}`
    }
    if (!before.isFile()) {
      await assertPathIdentityUnchanged(absolutePath, beforeIdentity)
      return `unsupported:${worktreeFileKind(before)}\0${serializeFileIdentity(beforeIdentity)}`
    }
    if (before.size > BigInt(this.options.maxAutomaticFingerprintBytes)) {
      await assertPathIdentityUnchanged(absolutePath, beforeIdentity)
      return `regular:stat\0${serializeFileIdentity(beforeIdentity)}`
    }
    const exact = await this.readOpenedRegularFile(
      repositoryRoot,
      path,
      absolutePath,
      beforeIdentity,
      Number(before.size),
      false,
      signal
    )
    return `regular:exact\0${serializeFileIdentity(beforeIdentity)}\0${exact.rawOid}`
  }

  private async readExactWorktreeContent(
    repositoryRoot: string,
    path: string,
    includeFilteredOid: boolean,
    signal?: AbortSignal,
    maxBytes?: number
  ): Promise<ExactWorktreeContent | null> {
    assertSafeNoFollowPlatform()
    const absolutePath = resolve(repositoryRoot, path)
    let before
    try {
      before = await lstat(absolutePath, { bigint: true })
    } catch (error) {
      if (isFileNotFoundError(error)) return null
      throw error
    }
    const beforeIdentity = toFileIdentity(before)
    if (before.isSymbolicLink()) {
      const linkBytes = await readStableSymbolicLink(absolutePath, beforeIdentity)
      const rawOid = await this.hashBytesFromStdin(
        repositoryRoot,
        ['hash-object', '--no-filters', '--stdin'],
        linkBytes,
        signal
      )
      return { kind: 'symlink', mode: '120000', rawOid, filteredOid: rawOid }
    }
    if (!before.isFile()) {
      throw new GitRunError(errorDto('unsupported', `Git worktree entry type ${worktreeFileKind(before)} is not supported.`))
    }
    if (maxBytes !== undefined && before.size > BigInt(maxBytes)) {
      await assertPathIdentityUnchanged(absolutePath, beforeIdentity)
      return null
    }
    if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new GitRunError(errorDto('output-limit', 'Git worktree file exceeds the safe exact-hash size limit.'))
    }
    return await this.readOpenedRegularFile(
      repositoryRoot,
      path,
      absolutePath,
      beforeIdentity,
      Number(before.size),
      includeFilteredOid,
      signal
    )
  }

  private async readOpenedRegularFile(
    repositoryRoot: string,
    path: string,
    absolutePath: string,
    expectedIdentity: FileIdentity,
    expectedSize: number,
    includeFilteredOid: boolean,
    signal?: AbortSignal
  ): Promise<ExactWorktreeContent> {
    await this.testHooks.beforeNoFollowOpen?.(absolutePath)
    let handle: FileHandle
    try {
      handle = await open(absolutePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    } catch (error) {
      if (isNoFollowRaceError(error)) {
        throw new GitRunError(errorDto('stale', 'Git worktree file identity changed before its no-follow open.'))
      }
      throw error
    }
    try {
      const opened = await handle.stat({ bigint: true })
      if (!opened.isFile() || !sameFileIdentity(expectedIdentity, toFileIdentity(opened))) {
        throw new GitRunError(errorDto('stale', 'Git worktree file identity changed before it was opened.'))
      }
      const hashes = await this.hashOpenedRegularFile(
        repositoryRoot,
        path,
        handle,
        expectedSize,
        includeFilteredOid,
        signal
      )
      const after = await handle.stat({ bigint: true })
      if (!after.isFile() || !sameFileIdentity(expectedIdentity, toFileIdentity(after))) {
        throw new GitRunError(errorDto('stale', 'Git worktree file identity changed while it was hashed.'))
      }
      await assertPathIdentityUnchanged(absolutePath, expectedIdentity)
      return {
        kind: 'regular',
        mode: (Number(opened.mode) & 0o111) === 0 ? '100644' : '100755',
        rawOid: hashes.rawOid,
        filteredOid: hashes.filteredOid
      }
    } finally {
      await handle.close()
    }
  }

  private async readIndexOid(repositoryRoot: string, path: string, signal?: AbortSignal): Promise<string | null> {
    const output = await this.runRaw(repositoryRoot, ['ls-files', '--stage', '-z', '--', path], {
      signal,
      maxOutputBytes: 64 * 1024
    })
    if (output.length === 0) return null
    const records = output.split('\0').filter((record) => record.length > 0)
    if (records.length !== 1) return null
    const match = /^\d+ ((?:[0-9a-f]{40}|[0-9a-f]{64})) 0\t/s.exec(records[0]!)
    return match?.[1] ?? null
  }

  private async coalesceExactWorktreeRenames(
    repositoryRoot: string,
    records: StatusRecord[],
    indexText: string,
    signal?: AbortSignal
  ): Promise<StatusRecord[]> {
    const deletions = records.filter((record) =>
      !record.conflicted && !record.untracked && record.indexCode === '.' && record.worktreeCode === 'D'
    )
    const additions = records.filter((record) => record.untracked)
    if (deletions.length === 0 || additions.length === 0) return records

    const indexEntries = parseIndexEntries(indexText)
    const deletionsByIdentity = new Map<string, StatusRecord[]>()
    for (const record of deletions) {
      const path = validateRepositoryPath(record.path, repositoryRoot)
      const entry = indexEntries.get(path)
      if (entry === undefined) continue
      const identity = `${entry.mode}\0${entry.oid}`
      const candidates = deletionsByIdentity.get(identity) ?? []
      candidates.push(record)
      deletionsByIdentity.set(identity, candidates)
    }
    const additionsWithIdentity = await mapWithConcurrency(additions, CONTENT_HASH_WORKERS, async (record) => {
      const path = validateRepositoryPath(record.path, repositoryRoot)
      const exact = await this.readExactWorktreeContent(
        repositoryRoot,
        path,
        true,
        signal,
        this.options.maxAutomaticFingerprintBytes
      )
      return { record, identity: exact === null ? null : `${exact.mode}\0${exact.filteredOid}` }
    })
    const additionsByIdentity = new Map<string, StatusRecord[]>()
    for (const candidate of additionsWithIdentity) {
      if (candidate.identity === null) continue
      const matches = additionsByIdentity.get(candidate.identity) ?? []
      matches.push(candidate.record)
      additionsByIdentity.set(candidate.identity, matches)
    }

    const renamesByOldPath = new Map<string, StatusRecord>()
    const renamedNewPaths = new Set<string>()
    for (const [identity, oldCandidates] of deletionsByIdentity) {
      const newCandidates = additionsByIdentity.get(identity)
      if (oldCandidates.length !== 1 || newCandidates?.length !== 1) continue
      const oldRecord = oldCandidates[0]!
      const newRecord = newCandidates[0]!
      renamesByOldPath.set(oldRecord.path, {
        path: newRecord.path,
        originalPath: oldRecord.path,
        indexCode: '.',
        worktreeCode: 'R',
        conflicted: false,
        untracked: false
      })
      renamedNewPaths.add(newRecord.path)
    }
    if (renamesByOldPath.size === 0) return records

    const result: StatusRecord[] = []
    for (const record of records) {
      const rename = renamesByOldPath.get(record.path)
      if (rename !== undefined) result.push(rename)
      else if (!renamedNewPaths.has(record.path)) result.push(record)
    }
    return result
  }

  private async readAheadBehind(repositoryRoot: string, signal?: AbortSignal): Promise<[number, number]> {
    const output = await this.runRaw(
      repositoryRoot,
      ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'],
      { signal, maxOutputBytes: 64 * 1024 }
    )
    const match = /^(\d+)\s+(\d+)\s*$/.exec(output)
    if (match === null) throw new GitRunError(errorDto('git-error', 'Git returned an invalid ahead/behind count.'))
    return [Number(match[1]), Number(match[2])]
  }

  private async diffBase(state: GitRepositoryState, signal?: AbortSignal): Promise<string> {
    if (state.headOid !== null) return state.headOid
    const emptyTree = await this.runRaw(
      state.repositoryRoot!,
      ['hash-object', '-t', 'tree', '/dev/null'],
      { signal, maxOutputBytes: 1024 }
    )
    return emptyTree.trim()
  }

  private async readUntrackedDiff(
    path: string,
    state: GitRepositoryState,
    signal?: AbortSignal
  ): Promise<GitDiffResult> {
    const repositoryRoot = state.repositoryRoot!
    const absolutePath = resolve(repositoryRoot, path)
    assertNotAborted(signal)
    assertSafeNoFollowPlatform()
    const before = await lstat(absolutePath, { bigint: true })
    if (!before.isFile()) {
      return emptyDiffFromPath('working', path, 'unsupported', state, errorDto('unsupported', 'Only regular untracked files can be rendered.'))
    }
    let handle: FileHandle
    try {
      handle = await open(absolutePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    } catch (error) {
      if (isNoFollowRaceError(error)) {
        throw new GitRunError(errorDto('stale', 'Untracked file identity changed before its no-follow open.'))
      }
      throw error
    }
    try {
      const opened = await handle.stat({ bigint: true })
      if (!opened.isFile() || !sameFileIdentity(toFileIdentity(before), toFileIdentity(opened))) {
        throw new GitRunError(errorDto('stale', 'Untracked file identity changed before it was read.'))
      }
      const bytes = await readBounded(handle, this.options.maxDiffBytes, signal)
      const after = await handle.stat({ bigint: true })
      if (!sameFileIdentity(toFileIdentity(opened), toFileIdentity(after))) {
        throw new GitRunError(errorDto('stale', 'Untracked file identity changed while it was read.'))
      }
      await assertPathIdentityUnchanged(absolutePath, toFileIdentity(opened))
      if (bytes === null) {
        return emptyDiffFromPath('working', path, 'oversized', state, errorDto('output-limit', 'Untracked file exceeds the configured diff byte budget.'))
      }
      if (bytes.includes(0)) {
        return emptyDiffFromPath('working', path, 'binary', state, errorDto('unsupported', 'Binary diffs are not rendered.'))
      }
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        return emptyDiffFromPath('working', path, 'binary', state, errorDto('unsupported', 'Non-UTF-8 diffs are not rendered.'))
      }
      return this.buildUntrackedTextDiff(path, text, state)
    } finally {
      await handle.close()
    }
  }

  private buildUntrackedTextDiff(path: string, text: string, state: GitRepositoryState): GitDiffResult {
    const hasFinalNewline = text.endsWith('\n')
    const contentLines = text.length === 0
      ? []
      : (hasFinalNewline ? text.slice(0, -1) : text).split('\n')
    if (contentLines.length + (text.length > 0 && !hasFinalNewline ? 1 : 0) > this.options.maxDiffLines) {
      return emptyDiffFromPath('working', path, 'oversized', state, errorDto('output-limit', 'Diff exceeds the configured line budget.'))
    }
    const lines: GitDiffLine[] = contentLines.map((content, index) => ({
      kind: 'add',
      oldLine: null,
      newLine: index + 1,
      content
    }))
    if (text.length > 0 && !hasFinalNewline) {
      lines.push({ kind: 'meta', oldLine: null, newLine: null, content: 'No newline at end of file' })
    }
    const hunkHeader = `@@ -0,0 +1,${contentLines.length} @@`
    const fileId = digest(`working\0\0${path}`).slice(0, 24)
    const hunks: GitDiffHunk[] = contentLines.length === 0
      ? []
      : [{
          id: digest(`${fileId}\0${hunkHeader}\0${lines.map((line) => `${line.kind}:${line.content}`).join('\n')}`).slice(0, 24),
          header: hunkHeader,
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: contentLines.length,
          lines
        }]
    const patch = [
      `diff --git /dev/null ${JSON.stringify(path)}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ ${JSON.stringify(path)}`,
      ...(hunks.length === 0
        ? []
        : [hunkHeader, ...contentLines.map((line) => `+${line}`), ...(hasFinalNewline ? [] : ['\\ No newline at end of file'])])
    ].join('\n')
    const byteCount = Buffer.byteLength(patch)
    const lineCount = lines.length
    if (
      byteCount > this.options.maxDiffBytes ||
      1 > this.options.maxDiffFiles ||
      hunks.length > this.options.maxDiffHunks ||
      lineCount > this.options.maxDiffLines
    ) {
      return {
        ...emptyDiffFromPath('working', path, 'oversized', state, errorDto('output-limit', 'Diff exceeds the configured structural budget.')),
        revision: diffRevision('working', state, path, patch),
        byteCount,
        fileCount: 1,
        hunkCount: hunks.length,
        lineCount
      }
    }
    const file: GitDiffFile = { id: fileId, path, originalPath: null, change: 'added', hunks }
    return {
      kind: 'working',
      path,
      state: 'ready',
      revision: diffRevision('working', state, path, patch),
      headOid: state.headOid,
      indexTreeOid: state.indexTreeOid,
      worktreeFingerprint: state.worktreeFingerprint,
      files: [file],
      byteCount,
      fileCount: 1,
      hunkCount: hunks.length,
      lineCount,
      error: null
    }
  }

  private parseSingleFileDiff(
    kind: GitDiffKind,
    path: string,
    patch: string,
    state: GitRepositoryState,
    statusFile: GitFileChange | undefined
  ): GitDiffResult {
    const byteCount = Buffer.byteLength(patch)
    if (/(?:^|\n)(?:GIT binary patch|Binary files )/.test(patch)) {
      return {
        ...emptyDiffFromPath(kind, path, 'binary', state, errorDto('unsupported', 'Binary diffs are not rendered.')),
        revision: diffRevision(kind, state, path, patch),
        byteCount,
        fileCount: 1
      }
    }
    let parsed: { hunks: GitDiffHunk[]; hasRenameHeader: boolean; hasModeOnlyChange: boolean }
    try {
      parsed = parseSingleFilePatch(kind, path, patch, this.options.maxDiffHunks, this.options.maxDiffLines)
    } catch (error) {
      const dto = toErrorDto(error)
      return {
        ...emptyDiffFromPath(kind, path, dto.code === 'output-limit' ? 'oversized' : 'unsupported', state, dto),
        revision: diffRevision(kind, state, path, patch),
        byteCount
      }
    }
    const change = diffChangeForStatus(kind, statusFile, parsed.hasRenameHeader)
    if (change === null || (parsed.hasModeOnlyChange && parsed.hunks.length === 0 && change !== 'renamed' && change !== 'added' && change !== 'deleted')) {
      return {
        ...emptyDiffFromPath(kind, path, 'unsupported', state, errorDto('unsupported', 'This diff shape is not supported.')),
        revision: diffRevision(kind, state, path, patch),
        byteCount,
        fileCount: 1
      }
    }
    const originalPath = change === 'renamed' ? statusFile?.originalPath ?? null : null
    if (change === 'renamed' && originalPath === null) {
      return {
        ...emptyDiffFromPath(kind, path, 'unsupported', state, errorDto('unsupported', 'Rename identity is unavailable.')),
        revision: diffRevision(kind, state, path, patch),
        byteCount,
        fileCount: 1
      }
    }
    const lineCount = parsed.hunks.reduce((total, hunk) => total + hunk.lines.length, 0)
    if (
      1 > this.options.maxDiffFiles ||
      parsed.hunks.length > this.options.maxDiffHunks ||
      lineCount > this.options.maxDiffLines
    ) {
      return {
        ...emptyDiffFromPath(kind, path, 'oversized', state, errorDto('output-limit', 'Diff exceeds the configured structural budget.')),
        revision: diffRevision(kind, state, path, patch),
        byteCount,
        fileCount: 1,
        hunkCount: parsed.hunks.length,
        lineCount
      }
    }
    const fileId = digest(`${kind}\0${originalPath ?? ''}\0${path}`).slice(0, 24)
    const hunks = parsed.hunks.map((hunk) => ({
      ...hunk,
      id: digest(`${fileId}\0${hunk.header}\0${hunk.lines.map((line) => `${line.kind}:${line.content}`).join('\n')}`).slice(0, 24)
    }))
    return {
      kind,
      path,
      state: 'ready',
      revision: diffRevision(kind, state, path, patch),
      headOid: state.headOid,
      indexTreeOid: state.indexTreeOid,
      worktreeFingerprint: state.worktreeFingerprint,
      files: [{ id: fileId, path, originalPath, change, hunks }],
      byteCount,
      fileCount: 1,
      hunkCount: hunks.length,
      lineCount,
      error: null
    }
  }

  private async hashOpenedRegularFile(
    repositoryRoot: string,
    path: string,
    handle: FileHandle,
    expectedSize: number,
    includeFilteredOid: boolean,
    signal?: AbortSignal
  ): Promise<{ rawOid: string; filteredOid: string }> {
    const outputs = await this.runHashChildren(
      repositoryRoot,
      includeFilteredOid
        ? [
            ['hash-object', '--no-filters', '--stdin'],
            ['hash-object', `--path=${path}`, '--stdin']
          ]
        : [['hash-object', '--no-filters', '--stdin']],
      async (writeChunk) => {
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(expectedSize, 1)))
        let offset = 0
        while (offset < expectedSize) {
          assertNotAborted(signal)
          const length = Math.min(buffer.length, expectedSize - offset)
          const { bytesRead } = await handle.read(buffer, 0, length, offset)
          if (bytesRead === 0) {
            throw new GitRunError(errorDto('stale', 'Git worktree file became shorter while it was hashed.'))
          }
          offset += bytesRead
          await writeChunk(buffer.subarray(0, bytesRead))
        }
      },
      signal
    )
    return { rawOid: outputs[0]!, filteredOid: outputs[1] ?? outputs[0]! }
  }

  private async hashBytesFromStdin(
    repositoryRoot: string,
    args: string[],
    bytes: Uint8Array,
    signal?: AbortSignal
  ): Promise<string> {
    const outputs = await this.runHashChildren(
      repositoryRoot,
      [args],
      async (writeChunk) => writeChunk(bytes),
      signal
    )
    return outputs[0]!
  }

  private async runHashChildren(
    cwd: string,
    argsList: string[][],
    produceInput: (writeChunk: (chunk: Uint8Array) => Promise<void>) => Promise<void>,
    signal?: AbortSignal
  ): Promise<string[]> {
    assertSafeNoFollowPlatform()
    assertNotAborted(signal)
    const children: HashChild[] = []
    let failure: GitRunError | null = null
    const stop = (error: GitRunError): void => {
      if (failure !== null) return
      failure = error
      for (const child of children) killHashChild(child.process)
    }
    const onAbort = (): void => stop(new GitRunError(errorDto('aborted', 'Git hashing was aborted.')))
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      stop(new GitRunError(errorDto('timeout', 'Git hashing timed out.')))
    }, this.options.timeoutMs)
    try {
      for (const args of argsList) {
        const childProcess = spawn(this.options.gitBinary, args, {
          cwd,
          detached: true,
          env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
          stdio: ['pipe', 'pipe', 'pipe']
        })
        const child: HashChild = {
          process: childProcess,
          stdout: [],
          stderr: [],
          outputBytes: 0,
          result: Promise.resolve({ code: null, error: null })
        }
        children.push(child)
        const countOutput = (target: Buffer[], chunk: Buffer): void => {
          child.outputBytes += chunk.byteLength
          if (child.outputBytes > 64 * 1024) {
            stop(new GitRunError(errorDto('output-limit', 'Git hash output exceeded the configured byte budget.')))
            return
          }
          target.push(chunk)
        }
        childProcess.stdout.on('data', (chunk: Buffer) => countOutput(child.stdout, chunk))
        childProcess.stderr.on('data', (chunk: Buffer) => countOutput(child.stderr, chunk))
        child.result = new Promise((resolveResult) => {
          let spawnError: Error | null = null
          childProcess.once('error', (error) => {
            spawnError = error
          })
          childProcess.once('close', (code) => {
            if (failure === null && (spawnError !== null || code !== 0)) {
              const stderr = Buffer.concat(child.stderr).toString('utf8')
              stop(new GitRunError(errorDto(
                'git-error',
                boundedGitMessage(spawnError ?? new Error(stderr || `Git hashing exited ${code ?? 'without a status'}.`)),
                stderr.length
              )))
            }
            resolveResult({ code, error: spawnError })
          })
        })
      }

      await produceInput(async (chunk) => {
        if (failure !== null) throw failure
        await Promise.all(children.map((child) => writeHashChunk(child.process, chunk)))
        if (failure !== null) throw failure
      })
      if (failure !== null) throw failure
      await Promise.all(children.map((child) => endHashInput(child.process)))
      await Promise.all(children.map((child) => child.result))
      if (failure !== null) throw failure
      return children.map((child) => {
        const oid = Buffer.concat(child.stdout).toString('utf8').trim()
        if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) {
          throw new GitRunError(errorDto('git-error', 'Git returned an invalid worktree object identity.'))
        }
        return oid
      })
    } catch (error) {
      if (failure === null) stop(error instanceof GitRunError ? error : new GitRunError(toErrorDto(error)))
      await Promise.all(children.map((child) => child.result))
      throw failure
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  private async runRaw(cwd: string, args: string[], options: RunOptions): Promise<string> {
    assertNotAborted(options.signal)
    if (options.stdin !== undefined) {
      return await this.runRawWithStdin(cwd, args, options)
    }
    const controller = new AbortController()
    let exceededOutput = false
    let timedOut = false
    let outputBytes = 0
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs
    const onAbort = (): void => controller.abort()
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const git = simpleGit({
      baseDir: cwd,
      binary: this.options.gitBinary,
      maxConcurrentProcesses: 1,
      abort: controller.signal,
      timeout: { block: timeoutMs, stdOut: true, stdErr: true },
      trimmed: false
    })
    git.env('LC_ALL', 'C')
    git.env('LANG', 'C')
    if (options.env !== undefined) {
      for (const [name, value] of Object.entries(options.env)) {
        git.env(name, value)
      }
    }
    git.outputHandler((_command, stdout, stderr) => {
      const count = (chunk: unknown): void => {
        outputBytes += Buffer.isBuffer(chunk) ? chunk.byteLength : Buffer.byteLength(String(chunk))
        if (outputBytes > options.maxOutputBytes && !controller.signal.aborted) {
          exceededOutput = true
          controller.abort()
        }
      }
      stdout.on('data', count)
      stderr.on('data', count)
    })
    try {
      return await git.raw(args)
    } catch (error) {
      if (exceededOutput) throw new GitRunError(errorDto('output-limit', 'Git output exceeded the configured byte budget.', stderrLength(error)))
      if (options.signal?.aborted) throw new GitRunError(errorDto('aborted', 'Git operation was aborted.', stderrLength(error)))
      if (timedOut || /timeout/i.test(errorMessage(error))) {
        throw new GitRunError(errorDto('timeout', 'Git operation timed out.', stderrLength(error)))
      }
      throw new GitRunError(errorDto('git-error', boundedGitMessage(error), stderrLength(error)))
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
    }
  }

  private async runRawWithStdin(cwd: string, args: string[], options: RunOptions): Promise<string> {
    assertNotAborted(options.signal)
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs
    const stdin = options.stdin ?? ''
    return await new Promise<string>((resolve, reject) => {
      let settled = false
      let exceededOutput = false
      let timedOut = false
      let outputBytes = 0
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      const env = {
        ...process.env,
        LC_ALL: 'C',
        LANG: 'C',
        ...(options.env ?? {})
      }
      const child = spawn(this.options.gitBinary, args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true
      })
      const finish = (error: Error | null, code: number | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        const stderrText = Buffer.concat(stderr).toString('utf8')
        if (exceededOutput) {
          reject(new GitRunError(errorDto('output-limit', 'Git output exceeded the configured byte budget.', stderrText.length)))
          return
        }
        if (options.signal?.aborted) {
          reject(new GitRunError(errorDto('aborted', 'Git operation was aborted.', stderrText.length)))
          return
        }
        if (timedOut) {
          reject(new GitRunError(errorDto('timeout', 'Git operation timed out.', stderrText.length)))
          return
        }
        if (error !== null || code !== 0) {
          reject(new GitRunError(errorDto(
            'git-error',
            boundedGitMessage(error ?? new Error(stderrText || `Git exited ${code ?? 'without a status'}.`)),
            stderrText.length
          )))
          return
        }
        resolve(Buffer.concat(stdout).toString('utf8'))
      }
      const stop = (): void => {
        if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch (error) {
          if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH')) {
            finish(error instanceof Error ? error : new Error(String(error)), null)
          }
        }
      }
      const onAbort = (): void => {
        stop()
      }
      const timer = setTimeout(() => {
        timedOut = true
        stop()
      }, timeoutMs)
      options.signal?.addEventListener('abort', onAbort, { once: true })
      child.stdout.on('data', (chunk: Buffer) => {
        stdout.push(chunk)
        outputBytes += chunk.byteLength
        if (outputBytes > options.maxOutputBytes) {
          exceededOutput = true
          stop()
        }
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr.push(chunk)
        outputBytes += chunk.byteLength
        if (outputBytes > options.maxOutputBytes) {
          exceededOutput = true
          stop()
        }
      })
      child.once('error', (error) => finish(error, null))
      child.once('close', (code) => finish(null, code))
      child.stdin.end(stdin, 'utf8')
    })
  }
}

function parseIndexEntries(text: string): Map<string, IndexEntry> {
  const entries = new Map<string, IndexEntry>()
  for (const record of text.split('\0')) {
    if (record.length === 0) continue
    const match = /^(\d+) ((?:[0-9a-f]{40}|[0-9a-f]{64})) ([0-3])\t(.*)$/s.exec(record)
    if (match === null) throw new GitRunError(errorDto('git-error', 'Git returned an invalid index entry.'))
    if (match[3] === '0') entries.set(match[4]!, { mode: match[1]!, oid: match[2]! })
  }
  return entries
}

function parseStatus(text: string): StatusRecord[] {
  const records = text.split('\0')
  const result: StatusRecord[] = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record.length === 0) continue
    if (record.startsWith('? ')) {
      result.push({ path: record.slice(2), originalPath: null, indexCode: '.', worktreeCode: '?', conflicted: false, untracked: true })
      continue
    }
    if (record.startsWith('! ')) continue
    const ordinary = /^1 (..) \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/s.exec(record)
    if (ordinary !== null) {
      result.push(statusRecord(ordinary[2]!, null, ordinary[1]!))
      continue
    }
    const renamed = /^2 (..) \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/s.exec(record)
    if (renamed !== null) {
      const originalPath = records[index + 1]
      if (originalPath === undefined) throw new GitRunError(errorDto('git-error', 'Git returned an incomplete rename status record.'))
      index += 1
      result.push(statusRecord(renamed[2]!, originalPath, renamed[1]!))
      continue
    }
    const unmerged = /^u (..) \S+ \S+ \S+ \S+ \S+ \S+ \S+ \S+ (.*)$/s.exec(record)
    if (unmerged !== null) {
      result.push({ ...statusRecord(unmerged[2]!, null, unmerged[1]!), conflicted: true })
      continue
    }
    throw new GitRunError(errorDto('git-error', 'Git returned an unsupported status record.'))
  }
  return result
}

function statusRecord(path: string, originalPath: string | null, xy: string): StatusRecord {
  const indexCode = xy[0] ?? '.'
  const worktreeCode = xy[1] ?? '.'
  return {
    path,
    originalPath,
    indexCode,
    worktreeCode,
    conflicted: indexCode === 'U' || worktreeCode === 'U' || xy === 'AA' || xy === 'DD',
    untracked: false
  }
}

function mapStatusCode(code: string): GitChangeKind {
  switch (code) {
    case '.': return 'unmodified'
    case 'A': return 'added'
    case 'M': return 'modified'
    case 'D': return 'deleted'
    case 'R': return 'renamed'
    // Git copy detection is intentionally projected as an added file until the product needs copy identity.
    case 'C': return 'added'
    case 'T': return 'type-changed'
    case 'U': return 'unmerged'
    case '?': return 'untracked'
    case '!': return 'ignored'
    default: return 'unknown'
  }
}

function diffChangeForStatus(
  kind: GitDiffKind,
  statusFile: GitFileChange | undefined,
  hasRenameHeader: boolean
): GitDiffFile['change'] | null {
  if (statusFile === undefined) return null
  const change = kind === 'working' ? statusFile.worktreeChange : statusFile.indexChange
  switch (change) {
    case 'added': return 'added'
    case 'deleted': return 'deleted'
    case 'renamed': return 'renamed'
    case 'type-changed': return 'type-changed'
    case 'modified': return hasRenameHeader ? 'renamed' : 'modified'
    default: return null
  }
}

function parseSingleFilePatch(
  kind: GitDiffKind,
  path: string,
  patch: string,
  maxHunks: number,
  maxLines: number
): { hunks: GitDiffHunk[]; hasRenameHeader: boolean; hasModeOnlyChange: boolean } {
  const lines = patch.split('\n')
  const fileHeaders = lines.filter((line) => line.startsWith('diff --git ')).length
  if (fileHeaders !== 1 || !lines[0]?.startsWith('diff --git ')) {
    throw new GitRunError(errorDto('unsupported', 'Git diff must contain exactly one expected file.'))
  }
  let hasRenameHeader = false
  let hasModeHeader = false
  let totalParsedLines = 0
  const hunks: GitDiffHunk[] = []
  let index = 1
  while (index < lines.length) {
    const line = lines[index]!
    if (line.startsWith('@@ ')) break
    if (line.startsWith('diff --git ')) throw new GitRunError(errorDto('unsupported', 'Git diff contains more than one file.'))
    if (line.startsWith('rename from ') || line.startsWith('rename to ')) hasRenameHeader = true
    if (line.startsWith('old mode ') || line.startsWith('new mode ')) hasModeHeader = true
    index += 1
  }
  while (index < lines.length) {
    if (index === lines.length - 1 && lines[index] === '') break
    const header = lines[index]!
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(header)
    if (match === null) throw new GitRunError(errorDto('unsupported', 'Git diff contains an invalid hunk header.'))
    const oldStart = Number(match[1])
    const oldLines = match[2] === undefined ? 1 : Number(match[2])
    const newStart = Number(match[3])
    const newLines = match[4] === undefined ? 1 : Number(match[4])
    for (const value of [oldStart, oldLines, newStart, newLines]) {
      if (!Number.isSafeInteger(value) || value < 0) throw new GitRunError(errorDto('unsupported', 'Git diff contains an invalid hunk range.'))
    }
    const normalizedHeader = `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@${match[5] ?? ''}`
    index += 1
    let oldLine = oldStart
    let newLine = newStart
    let consumedOld = 0
    let consumedNew = 0
    const changes: GitDiffLine[] = []
    if (hunks.length >= maxHunks) throw new GitRunError(errorDto('output-limit', 'Diff exceeds the configured hunk budget.'))
    while (index < lines.length) {
      const line = lines[index]!
      if (line.startsWith('@@ ')) break
      if (index === lines.length - 1 && line === '') {
        index += 1
        break
      }
      const prefix = line[0]
      if (prefix === '+') {
        changes.push({ kind: 'add', oldLine: null, newLine, content: line.slice(1) })
        newLine += 1
        consumedNew += 1
      } else if (prefix === '-') {
        changes.push({ kind: 'remove', oldLine, newLine: null, content: line.slice(1) })
        oldLine += 1
        consumedOld += 1
      } else if (prefix === ' ') {
        changes.push({ kind: 'context', oldLine, newLine, content: line.slice(1) })
        oldLine += 1
        newLine += 1
        consumedOld += 1
        consumedNew += 1
      } else if (prefix === '\\') {
        changes.push({ kind: 'meta', oldLine: null, newLine: null, content: line.slice(1).trim() })
      } else {
        throw new GitRunError(errorDto('unsupported', 'Git diff contains an invalid hunk line.'))
      }
      index += 1
      totalParsedLines += 1
      if (totalParsedLines > maxLines) {
        throw new GitRunError(errorDto('output-limit', 'Diff exceeds the configured line budget.'))
      }
    }
    if (consumedOld !== oldLines || consumedNew !== newLines) {
      throw new GitRunError(errorDto('unsupported', 'Git diff hunk counts do not match its content.'))
    }
    hunks.push({
      id: digest(`${kind}\0${path}\0${normalizedHeader}\0${hunks.length}`).slice(0, 24),
      header: normalizedHeader,
      oldStart,
      oldLines,
      newStart,
      newLines,
      lines: changes
    })
  }
  return { hunks, hasRenameHeader, hasModeOnlyChange: hasModeHeader }
}

function validatedPathspecsForStatusFile(
  path: string,
  statusFile: GitFileChange | undefined,
  repositoryRoot: string
): string[] {
  if (
    statusFile?.originalPath !== null &&
    statusFile?.originalPath !== undefined &&
    (statusFile.indexChange === 'renamed' || statusFile.worktreeChange === 'renamed')
  ) {
    return [
      validateRepositoryPath(statusFile.originalPath, repositoryRoot),
      validateRepositoryPath(path, repositoryRoot)
    ]
  }
  return [validateRepositoryPath(path, repositoryRoot)]
}

function validateRepositoryPath(path: string, repositoryRoot: string | null): string {
  if (repositoryRoot === null) throw new GitRunError(errorDto('not-repository', 'Project is not a Git repository.'))
  if (path.length === 0 || path.includes('\0') || isAbsolute(path)) {
    throw new GitRunError(errorDto('invalid-path', 'Git path must be a non-empty repository-relative path.'))
  }
  if (Buffer.byteLength(path, 'utf8') > GIT_REPOSITORY_RELATIVE_PATH_MAX_UTF8_BYTES) {
    throw new GitRunError(errorDto(
      'invalid-path',
      `Git path exceeds the ${GIT_REPOSITORY_RELATIVE_PATH_MAX_UTF8_BYTES}-byte repository-relative limit.`
    ))
  }
  const segments = path.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new GitRunError(errorDto('invalid-path', 'Git path contains an invalid traversal segment.'))
  }
  const absolute = resolve(repositoryRoot, path)
  const relativePath = relative(repositoryRoot, absolute)
  if (relativePath.startsWith(`..${sep}`) || relativePath === '..' || isAbsolute(relativePath)) {
    throw new GitRunError(errorDto('invalid-path', 'Git path resolves outside the repository.'))
  }
  return path
}

function staleError(request: GitDiffRequest, state: GitRepositoryState): GitErrorDto | null {
  if (
    state.repositoryRoot !== request.expectedRepositoryRoot ||
    state.headOid !== request.expectedHeadOid ||
    state.indexTreeOid !== request.expectedIndexTreeOid ||
    state.statusRevision !== request.expectedStatusRevision
  ) {
    return errorDto('stale', 'Repository state changed before the diff was read.')
  }
  return null
}

function staleMutationError(
  request: GitFileMutationRequest,
  state: GitRepositoryState,
  path: string
): GitErrorDto | null {
  const statusFile = state.files.find((file) => file.path === path)
  if (statusFile === undefined || statusFile.fingerprint !== request.expectedFileFingerprint) {
    return errorDto('stale', 'Requested file is missing or changed in the current bounded Git status projection.')
  }
  if (
    state.repositoryRoot !== request.expectedRepositoryRoot ||
    state.headOid !== request.expectedHeadOid ||
    state.indexTreeOid !== request.expectedIndexTreeOid ||
    state.indexFingerprint !== request.expectedIndexFingerprint ||
    state.worktreeFingerprint !== request.expectedWorktreeFingerprint ||
    state.statusRevision !== request.expectedStatusRevision
  ) {
    return errorDto('stale', 'Repository state changed before the Git mutation.')
  }
  return null
}

function sameRepositoryIdentity(before: GitRepositoryState, after: GitRepositoryState): boolean {
  return before.kind === 'repository' &&
    after.kind === 'repository' &&
    before.repositoryRoot === after.repositoryRoot &&
    before.headOid === after.headOid &&
    before.indexTreeOid === after.indexTreeOid &&
    before.indexFingerprint === after.indexFingerprint &&
    before.worktreeFingerprint === after.worktreeFingerprint &&
    before.statusRevision === after.statusRevision
}

function historySnapshotFromState(state: GitRepositoryState): GitHistorySnapshot {
  if (state.repositoryRoot === null) {
    throw new GitRunError(errorDto('not-repository', 'Project is not a Git repository.'))
  }
  return {
    repositoryRoot: state.repositoryRoot,
    headOid: state.headOid,
    branch: state.branch
  }
}

type HistoryAdmission =
  | { kind: 'ready'; state: GitRepositoryState & { kind: 'repository'; repositoryRoot: string } }
  | { kind: 'failure'; result: Extract<GitHistoryListResult, { ok: false }> }

function admitHistoryState(
  state: GitRepositoryState,
  snapshot: GitHistorySnapshot
): HistoryAdmission {
  if (state.kind === 'not-repository' || state.repositoryRoot === null && state.kind !== 'trust-required') {
    return {
      kind: 'failure',
      result: historyListFailure(
        errorDto('not-repository', 'Project is not a Git repository.'),
        snapshot,
        null
      )
    }
  }
  if (state.kind === 'trust-required') {
    return {
      kind: 'failure',
      result: historyListFailure(trustRequiredError(), snapshot, null)
    }
  }
  if (
    state.repositoryRoot !== snapshot.repositoryRoot ||
    state.headOid !== snapshot.headOid ||
    state.branch !== snapshot.branch
  ) {
    return {
      kind: 'failure',
      result: historyListFailure(
        errorDto('stale', 'Repository HEAD identity changed before the history read.'),
        snapshot,
        historySnapshotFromState(state)
      )
    }
  }
  return {
    kind: 'ready',
    state: state as GitRepositoryState & { kind: 'repository'; repositoryRoot: string }
  }
}

function historyListFailure(
  error: GitErrorDto,
  snapshot: GitHistorySnapshot | null,
  current: GitHistorySnapshot | null
): Extract<GitHistoryListResult, { ok: false }> {
  return { ok: false, error, snapshot, current }
}

function historyDetailFailure(
  error: GitErrorDto,
  snapshot: GitHistorySnapshot | null,
  current: GitHistorySnapshot | null
): Extract<GitHistoryDetailResult, { ok: false }> {
  return { ok: false, error, snapshot, current }
}

function emptyHistoryFileDiff(
  request: GitHistoryFileDiffRequest,
  state: GitHistoryFileDiffResult['state'],
  current: GitHistorySnapshot | null,
  error: GitErrorDto | null
): GitHistoryFileDiffResult {
  return {
    oid: request.oid,
    fileId: request.fileId,
    path: null,
    originalPath: null,
    status: null,
    state,
    snapshot: null,
    current,
    files: [],
    byteCount: 0,
    hunkCount: 0,
    lineCount: 0,
    error
  }
}

function parseHistorySummaries(text: string): GitHistoryCommitSummary[] {
  if (text.length === 0) return []
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
  const commits: GitHistoryCommitSummary[] = []
  for (const line of lines) {
    if (line.length === 0) continue
    const parts = line.split('\0')
    if (parts.length !== 10) {
      throw new GitRunError(errorDto('git-error', 'Git returned an invalid history log record.'))
    }
    const [
      oid,
      shortOid,
      subject,
      authorName,
      authorEmail,
      authorAtText,
      committerName,
      committerEmail,
      committerAtText,
      parentsText
    ] = parts as [string, string, string, string, string, string, string, string, string, string]
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(oid) || shortOid.length === 0) {
      throw new GitRunError(errorDto('git-error', 'Git returned an invalid history commit identity.'))
    }
    const authorAt = Number(authorAtText)
    const committerAt = Number(committerAtText)
    const authorAtMs = authorAt * 1000
    const committerAtMs = committerAt * 1000
    if (
      !Number.isSafeInteger(authorAt) ||
      !Number.isSafeInteger(committerAt) ||
      authorAt < 0 ||
      committerAt < 0 ||
      !Number.isSafeInteger(authorAtMs) ||
      !Number.isSafeInteger(committerAtMs)
    ) {
      throw new GitRunError(errorDto('git-error', 'Git returned an invalid history commit timestamp.'))
    }
    const parentOids = parentsText.length === 0
      ? []
      : parentsText.split(' ').filter((parent) => parent.length > 0)
    for (const parent of parentOids) {
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(parent)) {
        throw new GitRunError(errorDto('git-error', 'Git returned an invalid history parent identity.'))
      }
    }
    commits.push({
      oid,
      shortOid,
      subject,
      authorName,
      authorEmail,
      authorAt: authorAtMs,
      committerName,
      committerEmail,
      committerAt: committerAtMs,
      parentOids
    })
  }
  return commits
}

function parseHistoryNameStatusRecords(
  records: readonly HistoryNameStatusRecord[],
  commitOid: string,
  repositoryRoot: string
): GitHistoryFileEntry[] {
  return records.map((record) => {
    const statusCode = record[0][0]!
    if (statusCode === 'R' || statusCode === 'C') {
      if (record.length !== 3) {
        throw new GitRunError(errorDto('git-error', 'Git returned an invalid rename/copy history file record.'))
      }
      const originalPath = validateRepositoryPath(record[1], repositoryRoot)
      const path = validateRepositoryPath(record[2], repositoryRoot)
      const status: GitHistoryFileChange = statusCode === 'R' ? 'renamed' : 'added'
      return {
        fileId: historyFileId(commitOid, status, originalPath, path),
        path,
        originalPath: statusCode === 'R' ? originalPath : null,
        status
      }
    }
    if (record.length !== 2) {
      throw new GitRunError(errorDto('git-error', 'Git returned an invalid history file record.'))
    }
    const path = validateRepositoryPath(record[1], repositoryRoot)
    const status = mapHistoryStatusCode(statusCode)
    return {
      fileId: historyFileId(commitOid, status, null, path),
      path,
      originalPath: null,
      status
    }
  })
}

function mapHistoryStatusCode(code: string): GitHistoryFileChange {
  switch (code) {
    case 'A':
      return 'added'
    case 'M':
      return 'modified'
    case 'D':
      return 'deleted'
    case 'T':
      return 'type-changed'
    default:
      return 'unknown'
  }
}

function historyFileId(
  commitOid: string,
  status: GitHistoryFileChange,
  originalPath: string | null,
  path: string
): string {
  return digest(['history', commitOid, status, originalPath ?? '', path].join('\0')).slice(0, 32)
}

function historyStatusToDiffChange(
  status: GitHistoryFileChange
): Exclude<GitChangeKind, 'unmodified' | 'unmerged' | 'untracked' | 'ignored'> {
  return status
}

function boundHistoryMessage(text: string): { message: string; messageTruncated: boolean } {
  const normalized = text.endsWith('\n') ? text.slice(0, -1) : text
  if (Buffer.byteLength(normalized, 'utf8') <= GIT_HISTORY_MESSAGE_MAX_UTF8_BYTES) {
    return { message: normalized, messageTruncated: false }
  }
  let end = normalized.length
  while (end > 0 && Buffer.byteLength(normalized.slice(0, end), 'utf8') > GIT_HISTORY_MESSAGE_MAX_UTF8_BYTES) {
    end -= 1
  }
  return { message: normalized.slice(0, end), messageTruncated: true }
}

function emptyDiff(
  request: GitDiffRequest,
  stateValue: GitDiffResult['state'],
  state: GitRepositoryState | null,
  error: GitErrorDto | null
): GitDiffResult {
  return emptyDiffFromPath(request.kind, request.path, stateValue, state, error)
}

function emptyDiffFromPath(
  kind: GitDiffKind,
  path: string,
  stateValue: GitDiffResult['state'],
  state: GitRepositoryState | null,
  error: GitErrorDto | null
): GitDiffResult {
  return {
    kind,
    path,
    state: stateValue,
    revision: null,
    headOid: state?.headOid ?? null,
    indexTreeOid: state?.indexTreeOid ?? null,
    worktreeFingerprint: state?.worktreeFingerprint ?? '',
    files: [],
    byteCount: 0,
    fileCount: 0,
    hunkCount: 0,
    lineCount: 0,
    error
  }
}

function notRepositoryState(projectRoot: string): GitRepositoryState {
  return {
    kind: 'not-repository',
    projectRoot,
    repositoryRoot: null,
    headOid: null,
    branch: null,
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    indexTreeOid: null,
    indexFingerprint: digest('not-repository'),
    worktreeFingerprint: digest('not-repository'),
    statusRevision: digest(`not-repository\0${projectRoot}`),
    files: [],
    truncated: false,
    refreshedAt: Date.now(),
    lastError: null
  }
}

function trustRequiredState(projectRoot: string, repositoryRoot: string): GitRepositoryState {
  const error = trustRequiredError()
  return {
    kind: 'trust-required',
    projectRoot,
    repositoryRoot,
    headOid: null,
    branch: null,
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    indexTreeOid: null,
    indexFingerprint: digest(`trust-required\0${projectRoot}\0${repositoryRoot}`),
    worktreeFingerprint: digest(`trust-required\0${projectRoot}\0${repositoryRoot}`),
    statusRevision: digest(`trust-required\0${projectRoot}\0${repositoryRoot}`),
    files: [],
    truncated: false,
    refreshedAt: Date.now(),
    lastError: error
  }
}

function trustRequiredError(): GitErrorDto {
  return errorDto('trust-required', 'The Project is inside a different repository root and requires exact Main authorization.')
}

function trustRequiredErrorPublic(): GitErrorDto {
  return errorDto('trust-required', 'Git repository authorization is required.')
}

function snapshotFromState(state: GitRepositoryState): GitCommitSnapshot {
  if (state.kind !== 'repository' || state.repositoryRoot === null || state.branch === null || state.indexTreeOid === null) {
    throw new GitRunError(errorDto('unsupported', 'Repository is not ready for commit.'))
  }
  return {
    repositoryRoot: state.repositoryRoot,
    headOid: state.headOid,
    branch: state.branch,
    indexTreeOid: state.indexTreeOid,
    indexFingerprint: state.indexFingerprint
  }
}

function assertCommitAdmission(state: GitRepositoryState, request: GitCommitExecutionRequest): void {
  if (state.kind !== 'repository' || state.repositoryRoot === null) {
    throw new GitRunError(
      state.kind === 'trust-required'
        ? trustRequiredError()
        : errorDto('not-repository', 'Project is not a Git repository.')
    )
  }
  if (state.detached || state.branch === null) {
    throw new GitRunError(errorDto('unsupported', 'Commit requires a named branch; detached HEAD is unsupported.'))
  }
  if (state.indexTreeOid === null || state.files.some((file) => file.conflicted)) {
    throw new GitRunError(errorDto('conflict', 'Git repository has unresolved conflicts.'))
  }
  if (state.truncated) {
    throw new GitRunError(errorDto('unsupported', 'Git status is truncated; commit is blocked until status is complete.'))
  }
  if (request.mode === 'amend' && state.headOid === null) {
    throw new GitRunError(errorDto('unsupported', 'Amend requires an existing HEAD commit.'))
  }
  if (
    state.repositoryRoot !== request.snapshot.repositoryRoot ||
    state.branch !== request.snapshot.branch ||
    state.headOid !== request.snapshot.headOid ||
    state.indexTreeOid !== request.snapshot.indexTreeOid ||
    state.indexFingerprint !== request.snapshot.indexFingerprint
  ) {
    throw new GitRunError(errorDto('stale', 'Repository state changed before the commit.'))
  }
}

function assertPushTargetFence(
  mode: GitCommitExecutionRequest['mode'],
  expected: GitPushTarget | null,
  actual: GitPushTarget | null
): void {
  if (mode === 'commit-and-push' && actual === null) {
    throw new GitRunError(errorDto('unsupported', 'Commit and push requires a configured upstream branch.'))
  }
  if (
    expected?.remote !== actual?.remote ||
    expected?.branch !== actual?.branch ||
    (expected === null) !== (actual === null)
  ) {
    throw new GitRunError(errorDto('stale', 'Upstream push target changed before the commit.'))
  }
}

function validateCommitMessage(message: string): string {
  if (message.includes('\0')) {
    throw new GitRunError(errorDto('unsupported', 'Commit message must not contain NUL bytes.'))
  }
  if (message.trim().length === 0) {
    throw new GitRunError(errorDto('unsupported', 'Commit message must contain non-whitespace content.'))
  }
  if (Buffer.byteLength(message, 'utf8') > 64 * 1024) {
    throw new GitRunError(errorDto('unsupported', 'Commit message exceeds the configured byte limit.'))
  }
  return message
}

function suggestCommitMessage(paths: string[]): string {
  const sorted = [...paths].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
  if (sorted.length === 1) return `Update ${sorted[0]}`
  if (sorted.length <= 5) return `Update ${sorted.join(', ')}`
  return `Update ${sorted.length} files`
}

function failedCommitExecution(
  mode: GitCommitExecutionRequest['mode'],
  error: GitErrorDto,
  postState: GitRefreshResult
): GitCommitExecutionResult {
  return {
    mode,
    commit: { status: 'failed', error },
    push: null,
    postState
  }
}

function failedBranchSyncExecution(
  action: GitBranchSyncExecutionRequest['action'],
  error: GitErrorDto,
  postView: GitBranchSyncPrepareResult
): GitBranchSyncExecutionResult {
  if (action === 'create-and-switch' || action === 'switch') {
    return {
      action,
      branch: { status: 'failed', error },
      fetch: null,
      fastForward: null,
      push: null,
      postView
    }
  }
  if (action === 'fetch') {
    return {
      action,
      branch: null,
      fetch: { status: 'failed', remote: '', error },
      fastForward: null,
      push: null,
      postView
    }
  }
  if (action === 'pull') {
    return {
      action,
      branch: null,
      fetch: { status: 'failed', remote: '', error },
      fastForward: null,
      push: null,
      postView
    }
  }
  return {
    action,
    branch: null,
    fetch: null,
    fastForward: null,
    push: { status: 'failed', remote: '', branch: '', error },
    postView
  }
}

function splitNonEmptyLines(text: string): string[] {
  if (text.length === 0) return []
  const normalized = text.endsWith('\n') ? text.slice(0, -1) : text
  if (normalized.length === 0) return []
  return normalized.split('\n').filter((line) => line.length > 0)
}

function isNetworkOutcomeUnknown(error: GitErrorDto): boolean {
  return error.code === 'timeout' || error.code === 'aborted'
}

function assertRepositoryRootFence(state: GitRepositoryState, repositoryRoot: string): asserts state is GitRepositoryState & {
  kind: 'repository'
  repositoryRoot: string
} {
  if (state.kind === 'trust-required') {
    throw new GitRunError(trustRequiredError())
  }
  if (state.kind !== 'repository' || state.repositoryRoot === null) {
    throw new GitRunError(errorDto('not-repository', 'Project is not a Git repository.'))
  }
  if (state.repositoryRoot !== repositoryRoot) {
    throw new GitRunError(errorDto('stale', 'Repository identity changed before the Git operation.'))
  }
}

function assertCleanNamedBranchState(state: GitRepositoryState): asserts state is GitRepositoryState & {
  kind: 'repository'
  repositoryRoot: string
  branch: string
  headOid: string
} {
  if (state.kind === 'trust-required') {
    throw new GitRunError(trustRequiredError())
  }
  if (state.kind !== 'repository' || state.repositoryRoot === null) {
    throw new GitRunError(errorDto('not-repository', 'Project is not a Git repository.'))
  }
  if (state.detached || state.branch === null || state.headOid === null) {
    throw new GitRunError(errorDto(
      'unsupported',
      'Branch mutation requires a named non-unborn branch; detached or unborn HEAD is unsupported.'
    ))
  }
  if (state.files.some((file) => file.conflicted) || state.indexTreeOid === null) {
    throw new GitRunError(errorDto('conflict', 'Git repository has unresolved conflicts.'))
  }
  if (state.truncated) {
    throw new GitRunError(errorDto('unsupported', 'Git status is truncated; branch mutation is blocked until status is complete.'))
  }
  if (state.files.length > 0) {
    throw new GitRunError(errorDto('unsupported', 'Branch mutation requires a clean index and worktree.'))
  }
}

function assertBranchMutationAdmission(
  state: GitRepositoryState,
  snapshot: GitBranchSyncSnapshot
): asserts state is GitRepositoryState & {
  kind: 'repository'
  repositoryRoot: string
  branch: string
  headOid: string
} {
  assertCleanNamedBranchState(state)
  if (
    state.repositoryRoot !== snapshot.repositoryRoot ||
    state.headOid !== snapshot.headOid ||
    state.branch !== snapshot.branch ||
    state.indexTreeOid !== snapshot.indexTreeOid ||
    state.indexFingerprint !== snapshot.indexFingerprint ||
    state.worktreeFingerprint !== snapshot.worktreeFingerprint ||
    state.statusRevision !== snapshot.statusRevision
  ) {
    throw new GitRunError(errorDto('stale', 'Repository identity changed before the branch mutation.'))
  }
}

function assertUpstreamFence(
  state: GitRepositoryState & { branch: string; headOid: string; repositoryRoot: string },
  snapshot: GitBranchSyncSnapshot
): void {
  if (snapshot.upstreamRemote === null || snapshot.upstreamBranch === null) {
    throw new GitRunError(errorDto('unsupported', 'Configured upstream is required.'))
  }
  if (
    state.repositoryRoot !== snapshot.repositoryRoot ||
    state.branch !== snapshot.branch ||
    state.headOid !== snapshot.headOid
  ) {
    throw new GitRunError(errorDto('stale', 'Repository identity changed before the upstream operation.'))
  }
}

function assertPushBranchAdmission(
  state: GitRepositoryState,
  snapshot: GitBranchSyncSnapshot
): asserts state is GitRepositoryState & {
  kind: 'repository'
  repositoryRoot: string
  branch: string
  headOid: string
} {
  if (state.kind === 'trust-required') {
    throw new GitRunError(trustRequiredError())
  }
  if (state.kind !== 'repository' || state.repositoryRoot === null) {
    throw new GitRunError(errorDto('not-repository', 'Project is not a Git repository.'))
  }
  if (state.detached || state.branch === null || state.headOid === null) {
    throw new GitRunError(errorDto(
      'unsupported',
      'Push requires a named non-unborn branch; detached or unborn HEAD is unsupported.'
    ))
  }
  if (state.files.some((file) => file.conflicted) || state.indexTreeOid === null) {
    throw new GitRunError(errorDto('conflict', 'Git repository has unresolved conflicts.'))
  }
  if (state.truncated) {
    throw new GitRunError(errorDto('unsupported', 'Git status is truncated; push is blocked until status is complete.'))
  }
  if (snapshot.upstreamRemote === null || snapshot.upstreamBranch === null) {
    throw new GitRunError(errorDto('unsupported', 'Push requires a configured upstream branch.'))
  }
  if (
    state.repositoryRoot !== snapshot.repositoryRoot ||
    state.headOid !== snapshot.headOid ||
    state.branch !== snapshot.branch
  ) {
    throw new GitRunError(errorDto('stale', 'Repository identity changed before push.'))
  }
}

function diffRevision(kind: GitDiffKind, state: GitRepositoryState, path: string, patch: string): string {
  return digest([kind, state.headOid ?? 'unborn', state.indexTreeOid ?? 'unmerged-index', state.worktreeFingerprint, path, patch].join('\0'))
}

function trimNullable(value: string | null): string | null {
  if (value === null) return null
  const trimmed = value.trim()
  return trimmed.length === 0 ? null : trimmed
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function errorDto(code: GitErrorCode, message: string, stderrCharacters = 0): GitErrorDto {
  return {
    code,
    message: Array.from(message).slice(0, MAX_ERROR_MESSAGE_CHARACTERS).join(''),
    stderrCharacters: Number.isFinite(stderrCharacters)
      ? Math.max(0, Math.min(MAX_ERROR_STDERR_CHARACTERS, Math.trunc(stderrCharacters)))
      : 0
  }
}

function toErrorDto(error: unknown): GitErrorDto {
  if (error instanceof GitRunError) return error.dto
  return errorDto('git-error', 'Git service failed.', stderrLength(error))
}

function toPublicErrorDto(error: unknown): GitErrorDto {
  const dto = toErrorDto(error)
  const message: Record<GitErrorCode, string> = {
    'not-repository': 'Project is not a Git repository.',
    'trust-required': 'Git repository authorization is required.',
    'invalid-path': 'Git path validation failed.',
    stale: 'Git repository state changed.',
    conflict: 'Git repository has unresolved conflicts.',
    aborted: 'Git operation was aborted.',
    timeout: 'Git operation timed out.',
    'output-limit': 'Git output exceeded the configured limit.',
    unsupported: 'Git operation is unsupported.',
    'git-error': 'Git operation failed.'
  }
  return errorDto(dto.code, message[dto.code], dto.stderrCharacters)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function boundedGitMessage(error: unknown): string {
  const message = errorMessage(error).replace(/[\r\n]+/g, ' ').trim()
  return message.length === 0 ? 'Git command failed.' : message
}

function stderrLength(error: unknown): number {
  if (typeof error !== 'object' || error === null) return 0
  if ('stderr' in error) {
    const stderr = error.stderr
    if (typeof stderr === 'string') return stderr.length
    if (stderr instanceof Uint8Array) return stderr.byteLength
  }
  return errorMessage(error).length
}

function isActualNotRepositoryError(error: unknown): boolean {
  return error instanceof GitRunError &&
    error.dto.code === 'git-error' &&
    /(?:^|\b)not a git repository(?:\b|$)/i.test(error.message)
}

function isFileNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new GitRunError(errorDto('aborted', 'Git operation was aborted.'))
}

function assertPositiveOptions(options: ResolvedOptions): void {
  for (const [name, value] of Object.entries(options)) {
    if (name === 'gitBinary' || name === 'authorizedRepositoryRoot') {
      if (value !== undefined && (typeof value !== 'string' || value.length === 0)) throw new Error(`${name} must not be empty.`)
      continue
    }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive safe integer.`)
    }
  }
}

async function mapWithConcurrency<T, R>(
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

async function readBounded(handle: FileHandle, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array | null> {
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

function toFileIdentity(stat: {
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

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtime === right.mtime &&
    left.ctime === right.ctime
}

function serializeFileIdentity(identity: FileIdentity): string {
  return [identity.dev, identity.ino, identity.mode, identity.size, identity.mtime, identity.ctime].join(':')
}

function assertSafeNoFollowPlatform(): void {
  if (process.platform !== 'linux' || !Number.isSafeInteger(fsConstants.O_NOFOLLOW) || fsConstants.O_NOFOLLOW === 0) {
    throw new GitRunError(errorDto('unsupported', 'Safe no-follow Git worktree reads require Linux O_NOFOLLOW support.'))
  }
}

async function readStableSymbolicLink(absolutePath: string, expectedIdentity: FileIdentity): Promise<Buffer> {
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

async function assertPathIdentityUnchanged(absolutePath: string, expectedIdentity: FileIdentity): Promise<void> {
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

function worktreeFileKind(stat: {
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

function isNoFollowRaceError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error.code === 'ELOOP' || error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

function isInvalidFileTypeError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EINVAL'
}

async function writeHashChunk(child: ChildProcessWithoutNullStreams, chunk: Uint8Array): Promise<void> {
  await new Promise<void>((resolveWrite, rejectWrite) => {
    child.stdin.write(chunk, (error) => error === null || error === undefined ? resolveWrite() : rejectWrite(error))
  })
}

async function endHashInput(child: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolveEnd, rejectEnd) => {
    child.stdin.end((error?: Error | null) => error === null || error === undefined ? resolveEnd() : rejectEnd(error))
  })
}

function killHashChild(child: ChildProcessWithoutNullStreams): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch (error) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH')) throw error
  }
}
