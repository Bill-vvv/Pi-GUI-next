import { createHash } from 'node:crypto'
import type {
  GitBranchSyncExecutionRequest,
  GitBranchSyncExecutionResult,
  GitBranchSyncPrepareResult,
  GitBranchSyncSnapshot,
  GitCommitExecutionRequest,
  GitCommitExecutionResult,
  GitCommitSnapshot,
  GitDiffRequest,
  GitErrorCode,
  GitErrorDto,
  GitFileMutationRequest,
  GitHistoryDetailResult,
  GitHistoryListResult,
  GitHistorySnapshot,
  GitPushTarget,
  GitRefreshResult,
  GitRepositoryState
} from '../../shared/git-contract.ts'
import { MAX_ERROR_MESSAGE_CHARACTERS, MAX_ERROR_STDERR_CHARACTERS } from './git-service-types.ts'
import type { ResolvedOptions } from './git-service.ts'

/* Repository state snapshots, mutation admission fences and Git error mapping (moved unchanged from git-service.ts, D-098). */

export class GitRunError extends Error {
  readonly dto: GitErrorDto

  constructor(dto: GitErrorDto) {
    super(dto.message)
    this.name = 'GitRunError'
    this.dto = dto
  }
}

export function staleError(request: GitDiffRequest, state: GitRepositoryState): GitErrorDto | null {
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

export function staleMutationError(
  request: GitFileMutationRequest,
  state: GitRepositoryState,
  path: string
): GitErrorDto | null {
  const statusFile = state.files.find((file) => file.path === path)
  if (statusFile === undefined || statusFile.fingerprint !== request.expectedFileFingerprint) {
    return errorDto('stale', 'Requested file is missing or changed in the current bounded Git status projection.')
  }
  if (statusFile.conflicted || statusFile.state === 'conflicted') {
    return errorDto('unsupported', 'Resolve merge conflicts before staging or unstaging this file.')
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

export function sameRepositoryIdentity(before: GitRepositoryState, after: GitRepositoryState): boolean {
  return before.kind === 'repository' &&
    after.kind === 'repository' &&
    before.repositoryRoot === after.repositoryRoot &&
    before.headOid === after.headOid &&
    before.indexTreeOid === after.indexTreeOid &&
    before.indexFingerprint === after.indexFingerprint &&
    before.worktreeFingerprint === after.worktreeFingerprint &&
    before.statusRevision === after.statusRevision
}

export function historySnapshotFromState(state: GitRepositoryState): GitHistorySnapshot {
  if (state.repositoryRoot === null) {
    throw new GitRunError(errorDto('not-repository', 'Project is not a Git repository.'))
  }
  return {
    repositoryRoot: state.repositoryRoot,
    headOid: state.headOid,
    branch: state.branch
  }
}

export type HistoryAdmission =
  | { kind: 'ready'; state: GitRepositoryState & { kind: 'repository'; repositoryRoot: string } }
  | { kind: 'failure'; result: Extract<GitHistoryListResult, { ok: false }> }

export function admitHistoryState(
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

export function historyListFailure(
  error: GitErrorDto,
  snapshot: GitHistorySnapshot | null,
  current: GitHistorySnapshot | null
): Extract<GitHistoryListResult, { ok: false }> {
  return { ok: false, error, snapshot, current }
}

export function historyDetailFailure(
  error: GitErrorDto,
  snapshot: GitHistorySnapshot | null,
  current: GitHistorySnapshot | null
): Extract<GitHistoryDetailResult, { ok: false }> {
  return { ok: false, error, snapshot, current }
}

export function notRepositoryState(projectRoot: string): GitRepositoryState {
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

export function trustRequiredState(projectRoot: string, repositoryRoot: string): GitRepositoryState {
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

export function trustRequiredError(): GitErrorDto {
  return errorDto('trust-required', 'The Project is inside a different repository root and requires exact Main authorization.')
}

export function trustRequiredErrorPublic(): GitErrorDto {
  return errorDto('trust-required', 'Git repository authorization is required.')
}

export function snapshotFromState(state: GitRepositoryState): GitCommitSnapshot {
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

export function assertCommitAdmission(state: GitRepositoryState, request: GitCommitExecutionRequest): void {
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

export function assertPushTargetFence(
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

export function validateCommitMessage(message: string): string {
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

export function failedCommitExecution(
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

export function failedBranchSyncExecution(
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

export function isNetworkOutcomeUnknown(error: GitErrorDto): boolean {
  return error.code === 'timeout' || error.code === 'aborted'
}

export function assertRepositoryRootFence(state: GitRepositoryState, repositoryRoot: string): asserts state is GitRepositoryState & {
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

export function assertCleanNamedBranchState(state: GitRepositoryState): asserts state is GitRepositoryState & {
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

export function assertBranchMutationAdmission(
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

export function assertUpstreamFence(
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

export function assertPushBranchAdmission(
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

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function errorDto(code: GitErrorCode, message: string, stderrCharacters = 0): GitErrorDto {
  return {
    code,
    message: Array.from(message).slice(0, MAX_ERROR_MESSAGE_CHARACTERS).join(''),
    stderrCharacters: Number.isFinite(stderrCharacters)
      ? Math.max(0, Math.min(MAX_ERROR_STDERR_CHARACTERS, Math.trunc(stderrCharacters)))
      : 0
  }
}

export function toErrorDto(error: unknown): GitErrorDto {
  if (error instanceof GitRunError) return error.dto
  return errorDto('git-error', 'Git service failed.', stderrLength(error))
}

export function toPublicErrorDto(error: unknown): GitErrorDto {
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

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function boundedGitMessage(error: unknown): string {
  const message = errorMessage(error).replace(/[\r\n]+/g, ' ').trim()
  return message.length === 0 ? 'Git command failed.' : message
}

export function stderrLength(error: unknown): number {
  if (typeof error !== 'object' || error === null) return 0
  if ('stderr' in error) {
    const stderr = error.stderr
    if (typeof stderr === 'string') return stderr.length
    if (stderr instanceof Uint8Array) return stderr.byteLength
  }
  return errorMessage(error).length
}

export function isActualNotRepositoryError(error: unknown): boolean {
  return error instanceof GitRunError &&
    error.dto.code === 'git-error' &&
    /(?:^|\b)not a git repository(?:\b|$)/i.test(error.message)
}

export function isFileNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

export function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new GitRunError(errorDto('aborted', 'Git operation was aborted.'))
}

export function assertPositiveOptions(options: ResolvedOptions): void {
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
