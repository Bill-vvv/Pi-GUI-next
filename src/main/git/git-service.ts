import type { GitServiceCore } from './git-service-core.ts'
import { GitBranchSync } from './git-branch-sync.ts'
import { GitHistory } from './git-history.ts'
import { GitCommits } from './git-commits.ts'
import { GitWorktreeContent } from './git-worktree-content.ts'
import { readRepositoryFile, GitFileReadError, gitFileReadFailure } from './git-file-reader.ts'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { simpleGit } from 'simple-git'
import { GIT_BRANCH_SYNC_NETWORK_TIMEOUT_MS } from '../../shared/git-contract.ts'
import type {
  GitBranchSyncExecutionRequest,
  GitBranchSyncExecutionResult,
  GitBranchSyncPrepareResult,
  GitBranchSyncPushStep,
  GitCommitExecutionRequest,
  GitCommitExecutionResult,
  GitCommitPreviewResult,
  GitDiffFile,
  GitDiffHunk,
  GitDiffKind,
  GitDiffLine,
  GitDiffRequest,
  GitDiffResult,
  GitFileReadRequest,
  GitFileReadResult,
  GitErrorDto,
  GitFileChange,
  GitFileMutationRequest,
  GitHistoryDetailRequest,
  GitHistoryDetailResult,
  GitHistoryFileDiffRequest,
  GitHistoryFileDiffResult,
  GitHistoryListRequest,
  GitHistoryListResult,
  GitMutationResult,
  GitNetworkRemoteStep,
  GitPushTarget,
  GitRefreshResult,
  GitRepositoryState
} from '../../shared/git-contract.ts'
import {
  GitRunError,
  assertNotAborted,
  assertPositiveOptions,
  boundedGitMessage,
  digest,
  errorDto,
  errorMessage,
  isActualNotRepositoryError,
  isNetworkOutcomeUnknown,
  notRepositoryState,
  sameRepositoryIdentity,
  staleError,
  staleMutationError,
  stderrLength,
  toErrorDto,
  toPublicErrorDto,
  trustRequiredError,
  trustRequiredState
} from './git-admission.ts'
import {
  diffChangeForStatus,
  diffRevision,
  emptyDiff,
  emptyDiffFromPath,
  mapStatusCode,
  parseSingleFilePatch,
  parseStatus,
  trimNullable,
  validateRepositoryPath,
  validatedPathspecsForStatusFile
} from './git-parsing.ts'
import {
  CONTENT_HASH_WORKERS,
  DEFAULT_MAX_AUTOMATIC_FINGERPRINT_BYTES,
  DEFAULT_MAX_DIFF_BYTES,
  DEFAULT_MAX_DIFF_FILES,
  DEFAULT_MAX_DIFF_HUNKS,
  DEFAULT_MAX_DIFF_LINES,
  DEFAULT_MAX_STATUS_BYTES,
  DEFAULT_MAX_STATUS_FILES,
  DEFAULT_TIMEOUT_MS,
  GIT_NETWORK_ENV,
  type MutationContentFence,
  type RunOptions,
  type StatusRecord
} from './git-service-types.ts'
import {
  assertPathIdentityUnchanged,
  assertSafeNoFollowPlatform,
  isNoFollowRaceError,
  mapWithConcurrency,
  readBounded,
  sameFileIdentity,
  toFileIdentity
} from './git-worktree-io.ts'

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
export type GitServiceTestHooks = {
  beforeNoFollowOpen?: (absolutePath: string) => Promise<void>
}

export type ResolvedOptions = Required<Omit<GitServiceOptions, 'authorizedRepositoryRoot'>> & Pick<GitServiceOptions, 'authorizedRepositoryRoot'>

export class SerialQueue {
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
  private readonly branchSync: GitBranchSync
  private readonly history: GitHistory
  private readonly commits: GitCommits
  private readonly content: GitWorktreeContent

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
    const core = this.createCore()
    this.branchSync = new GitBranchSync(core)
    this.history = new GitHistory(core)
    this.commits = new GitCommits(core)
    this.content = new GitWorktreeContent(core)
  }

  private createCore(): GitServiceCore {
    return {
      options: this.options,
      testHooks: this.testHooks,
      branchCapabilitySecret: this.branchCapabilitySecret,
      runRaw: (cwd, args, options) => this.runRaw(cwd, args, options),
      refresh: (signal) => this.refresh(signal),
      refreshSafe: (signal) => this.refreshSafe(signal),
      safeRefresh: () => this.safeRefresh(),
      resolveQueue: (repositoryRoot) => this.resolveQueue(repositoryRoot),
      readPushTarget: (repositoryRoot, branch, signal) => this.commits.readPushTarget(repositoryRoot, branch, signal),
      readUpstreamTrackingRef: (repositoryRoot, branch, signal) => this.commits.readUpstreamTrackingRef(repositoryRoot, branch, signal),
      runNetworkFetch: (repositoryRoot, remote) => this.runNetworkFetch(repositoryRoot, remote),
      runNetworkPush: (repositoryRoot, target, sourceOid) => this.runNetworkPush(repositoryRoot, target, sourceOid)
    }
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
    const visibleRecords = await this.content.coalesceExactWorktreeRenames(
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

  async readFile(request: GitFileReadRequest): Promise<GitFileReadResult> {
    const failure = (error: GitErrorDto): GitFileReadResult => gitFileReadFailure(request.path, error)
    try {
      const before = await this.refresh()
      if (before.kind === 'trust-required') return failure(trustRequiredError())
      if (before.kind !== 'repository' || before.repositoryRoot === null) return failure(errorDto('not-repository', 'Project is not a Git repository.'))
      const path = validateRepositoryPath(request.path, before.repositoryRoot)
      const stale = staleError({ ...request, kind: 'working' }, before)
      if (stale) return failure(stale)
      if (!before.files.some((file) => file.path === path)) return failure(errorDto('stale', 'File is absent from the current bounded changes list.'))
      const bytes = await readRepositoryFile(before.repositoryRoot, path)
      let text: string
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch {
        return { ...failure(errorDto('unsupported', 'Non-UTF-8 files cannot be displayed.')), state: 'binary' }
      }
      if (bytes.includes(0)) return { ...failure(errorDto('unsupported', 'Binary files cannot be displayed.')), state: 'binary' }
      const after = await this.refresh()
      if (!sameRepositoryIdentity(before, after)) return failure(errorDto('stale', 'Repository changed while reading the file.'))
      return { path, state: 'ready', text, byteCount: bytes.byteLength, statusRevision: before.statusRevision, error: null }
    } catch (error) {
      return failure(error instanceof GitFileReadError ? errorDto(error.code, error.message) : toErrorDto(error))
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
    return this.history.listHistory(request, signal)
  }

  async getHistoryDetail(
    request: GitHistoryDetailRequest,
    signal?: AbortSignal
  ): Promise<GitHistoryDetailResult> {
    return this.history.getHistoryDetail(request, signal)
  }

  async getHistoryFileDiff(
    request: GitHistoryFileDiffRequest,
    signal?: AbortSignal
  ): Promise<GitHistoryFileDiffResult> {
    return this.history.getHistoryFileDiff(request, signal)
  }

  async mutateFile(request: GitFileMutationRequest, signal?: AbortSignal, assertCurrentBoundary?: () => Promise<void>): Promise<GitMutationResult> {
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
        await assertCurrentBoundary?.()
        const before = await this.assertImmediateMutationIdentity(request, latest.repositoryRoot, path, signal)
        await assertCurrentBoundary?.()
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
    return this.commits.prepareCommit(signal)
  }

  async prepareBranchSync(signal?: AbortSignal): Promise<GitBranchSyncPrepareResult> {
    return this.branchSync.prepareBranchSync(signal)
  }

  async executeBranchSync(
    request: GitBranchSyncExecutionRequest
  ): Promise<GitBranchSyncExecutionResult> {
    return this.branchSync.executeBranchSync(request)
  }

  async executeCommit(
    request: GitCommitExecutionRequest,
    signal?: AbortSignal,
    assertCurrentBoundary?: () => Promise<void>
  ): Promise<GitCommitExecutionResult> {
    return this.commits.executeCommit(request, signal, assertCurrentBoundary)
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
      rawOid: (await this.content.readExactWorktreeContent(repositoryRoot, path, false, signal))?.rawOid ?? null
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
    const after = await this.content.readExactWorktreeContent(
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
      const actualIndexOid = await this.content.readIndexOid(settled.repositoryRoot!, path, signal)
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

  private async mapStatusFile(repositoryRoot: string, record: StatusRecord, signal?: AbortSignal): Promise<GitFileChange> {
    const path = validateRepositoryPath(record.path, repositoryRoot)
    const originalPath = record.originalPath === null
      ? null
      : validateRepositoryPath(record.originalPath, repositoryRoot)
    const indexChange = record.untracked ? 'unmodified' : mapStatusCode(record.indexCode)
    const worktreeChange = record.untracked ? 'untracked' : mapStatusCode(record.worktreeCode)
    const contentIdentity = worktreeChange === 'deleted'
      ? 'missing'
      : await this.content.readAutomaticWorktreeIdentity(repositoryRoot, path, signal)
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
