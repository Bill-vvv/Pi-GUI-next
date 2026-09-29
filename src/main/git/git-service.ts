import type { GitServiceCore } from './git-service-core.ts'
import { GitHistory } from './git-history.ts'
import { GitCommits } from './git-commits.ts'
import { GitWorktreeContent } from './git-worktree-content.ts'
import {
  readRepositoryFile,
  GitFileReadError,
  gitFileReadFailure
} from './git-file-reader.ts'
import {
  spawn
} from 'node:child_process'
import {
  createHmac,
  randomBytes
} from 'node:crypto'
import {
  constants as fsConstants
} from 'node:fs'
import {
  lstat,
  open,
  realpath,
  type FileHandle
} from 'node:fs/promises'
import {
  isAbsolute,
  resolve
} from 'node:path'
import {
  simpleGit
} from 'simple-git'
import {
  GIT_BRANCH_LIST_MAX,
  GIT_BRANCH_SYNC_NETWORK_TIMEOUT_MS,
  GIT_REMOTE_LIST_MAX,
  GIT_REMOTE_TRACKING_LIST_MAX
} from '../../shared/git-contract.ts'
import type {
  GitBranchMutationWarning,
  GitBranchSyncActions,
  GitBranchSyncCurrent,
  GitBranchSyncExecutionRequest,
  GitBranchSyncExecutionResult,
  GitBranchSyncPrepareResult,
  GitBranchSyncPushStep,
  GitBranchSyncSnapshot,
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
  GitFastForwardStep,
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
  isGitRefName
} from './git-command-validation.ts'
import {
  GitRunError,
  assertBranchMutationAdmission,
  assertCleanNamedBranchState,
  assertNotAborted,
  assertPositiveOptions,
  assertPushBranchAdmission,
  assertRepositoryRootFence,
  assertUpstreamFence,
  boundedGitMessage,
  digest,
  errorDto,
  errorMessage,
  failedBranchSyncExecution,
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
  trustRequiredErrorPublic,
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
  splitNonEmptyLines,
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
  GIT_BRANCH_SYNC_READ_ENV,
  GIT_NETWORK_ENV,
  GIT_REMOTE_TRACKING_SCAN_MAX,
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
      readUpstreamTrackingRef: (repositoryRoot, branch, signal) => this.commits.readUpstreamTrackingRef(repositoryRoot, branch, signal)
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
    signal?: AbortSignal,
    assertCurrentBoundary?: () => Promise<void>
  ): Promise<GitCommitExecutionResult> {
    return this.commits.executeCommit(request, signal, assertCurrentBoundary)
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
        : this.commits.readPushTarget(repositoryRoot, state.branch, signal)
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
    // A bounded prefix works on Git 2.43 as well as newer hosts. One extra raw
    // record proves scan truncation even when symbolic refs consume the budget.
    const text = await this.runRaw(repositoryRoot, [
      'for-each-ref',
      `--count=${GIT_REMOTE_TRACKING_SCAN_MAX + 1}`,
      '--format=%(refname)%00%(refname:short)%00%(objectname)%00%(symref)',
      'refs/remotes/'
    ], { signal, maxOutputBytes: 4 * 1024 * 1024, env: { ...GIT_BRANCH_SYNC_READ_ENV } })
    const records = splitNonEmptyLines(text)
    const entries: Array<{ name: string; headOid: string | null }> = []
    for (const line of records.slice(0, GIT_REMOTE_TRACKING_SCAN_MAX)) {
      const parts = line.split('\0')
      if (parts.length !== 4) throw new GitRunError(errorDto('git-error', 'Git returned an invalid remote-tracking branch record.'))
      const [refname, name, headOid, symref] = parts as [string, string, string, string]
      if (!refname.startsWith('refs/remotes/') || !isGitRefName(refname)) {
        throw new GitRunError(errorDto('unsupported', 'Remote-tracking ref name is unsafe.'))
      }
      if (symref.length > 0) continue
      if (!isGitRefName(name)) throw new GitRunError(errorDto('unsupported', 'Remote-tracking branch name is unsafe.'))
      if (headOid.length > 0 && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(headOid)) {
        throw new GitRunError(errorDto('git-error', 'Git returned an invalid remote-tracking branch identity.'))
      }
      entries.push({ name, headOid: headOid.length === 0 ? null : headOid })
      if (entries.length > GIT_REMOTE_TRACKING_LIST_MAX) break
    }
    return {
      entries,
      truncated: entries.length > GIT_REMOTE_TRACKING_LIST_MAX || records.length > GIT_REMOTE_TRACKING_SCAN_MAX
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
      const target = await this.commits.readPushTarget(latest.repositoryRoot!, latest.branch!)
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
        const liveTarget = await this.commits.readPushTarget(afterFetch.repositoryRoot!, afterFetch.branch!)
        if (
          liveTarget === null ||
          liveTarget.remote !== target.remote ||
          liveTarget.branch !== target.branch
        ) {
          throw new GitRunError(errorDto('stale', 'Upstream changed during pull.'))
        }
        const upstreamRef = await this.commits.readUpstreamTrackingRef(
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
      const target = await this.commits.readPushTarget(latest.repositoryRoot!, latest.branch!)
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
      const confirmedTarget = await this.commits.readPushTarget(beforePush.repositoryRoot!, beforePush.branch!)
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
