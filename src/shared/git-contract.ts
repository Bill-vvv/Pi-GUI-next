export const GIT_COMMAND_CHANNEL = 'pi-gui:git-command'
export const GIT_REPOSITORY_RELATIVE_PATH_MAX_UTF8_BYTES = 4_096
export const GIT_COMMIT_MESSAGE_MAX_UTF8_BYTES = 64 * 1024
export const GIT_REF_NAME_MAX_UTF8_BYTES = 1_024
export const GIT_HISTORY_PAGE_SIZE = 50
export const GIT_HISTORY_MAX_OFFSET = 500
export const GIT_HISTORY_MAX_CHANGED_FILES = 200
export const GIT_HISTORY_MESSAGE_MAX_UTF8_BYTES = 64 * 1024
export const GIT_HISTORY_FILE_ID_MAX_UTF8_BYTES = 128
export const GIT_BRANCH_LIST_MAX = 200
export const GIT_REMOTE_TRACKING_LIST_MAX = 200
export const GIT_REMOTE_LIST_MAX = 32
export const GIT_BRANCH_SYNC_NETWORK_TIMEOUT_MS = 120_000
export const GIT_BRANCH_ID_MAX_UTF8_BYTES = 128
export const GIT_REMOTE_ID_MAX_UTF8_BYTES = 128
export const GIT_BRANCH_NAME_MAX_UTF8_BYTES = GIT_REF_NAME_MAX_UTF8_BYTES

// Copy detection is intentionally outside the current contract; copied content projects as added.
export type GitChangeKind =
  | 'unmodified'
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'type-changed'
  | 'unmerged'
  | 'untracked'
  | 'ignored'
  | 'unknown'

export type GitFileState = 'staged' | 'unstaged' | 'mixed' | 'untracked' | 'conflicted'

export type GitFileChange = {
  id: string
  path: string
  originalPath: string | null
  state: GitFileState
  indexChange: GitChangeKind
  worktreeChange: GitChangeKind
  conflicted: boolean
  fingerprint: string
}

export type GitErrorCode =
  | 'not-repository'
  | 'trust-required'
  | 'invalid-path'
  | 'stale'
  | 'conflict'
  | 'aborted'
  | 'timeout'
  | 'output-limit'
  | 'unsupported'
  | 'git-error'

export type GitErrorDto = {
  code: GitErrorCode
  message: string
  stderrCharacters: number
}

export type GitRepositoryState = {
  kind: 'not-repository' | 'trust-required' | 'repository'
  projectRoot: string
  repositoryRoot: string | null
  headOid: string | null
  branch: string | null
  detached: boolean
  upstream: string | null
  ahead: number
  behind: number
  indexTreeOid: string | null
  indexFingerprint: string
  worktreeFingerprint: string
  statusRevision: string
  files: GitFileChange[]
  truncated: boolean
  refreshedAt: number
  lastError: GitErrorDto | null
}

export type GitRefreshResult =
  | { ok: true; state: GitRepositoryState }
  | { ok: false; error: GitErrorDto }

export type GitDiffKind = 'working' | 'staged'
export type GitDiffState =
  | 'ready'
  | 'binary'
  | 'oversized'
  | 'unsupported'
  | 'conflict'
  | 'trust-required'
  | 'not-repository'
  | 'error'

export type GitDiffLine = {
  kind: 'context' | 'add' | 'remove' | 'meta'
  oldLine: number | null
  newLine: number | null
  content: string
}

export type GitDiffHunk = {
  id: string
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: GitDiffLine[]
}

export type GitDiffFile = {
  id: string
  path: string
  originalPath: string | null
  change: Exclude<GitChangeKind, 'unmodified' | 'unmerged' | 'untracked' | 'ignored'>
  hunks: GitDiffHunk[]
}

export type GitDiffRequest = {
  kind: GitDiffKind
  path: string
  expectedRepositoryRoot: string
  expectedHeadOid: string | null
  expectedIndexTreeOid: string | null
  expectedStatusRevision: string
}

export type GitDiffResult = {
  kind: GitDiffKind
  path: string
  state: GitDiffState
  revision: string | null
  headOid: string | null
  indexTreeOid: string | null
  worktreeFingerprint: string
  files: GitDiffFile[]
  byteCount: number
  fileCount: number
  hunkCount: number
  lineCount: number
  error: GitErrorDto | null
}

export type GitFileMutationRequest = {
  action: 'stage' | 'unstage'
  path: string
  expectedRepositoryRoot: string
  expectedHeadOid: string | null
  expectedIndexTreeOid: string | null
  expectedIndexFingerprint: string
  expectedFileFingerprint: string
  expectedWorktreeFingerprint: string
  expectedStatusRevision: string
}

export type GitMutationResult =
  | { ok: true; action: 'stage' | 'unstage'; path: string; state: GitRepositoryState }
  | { ok: false; action: 'stage' | 'unstage'; path: string; error: GitErrorDto; state: GitRepositoryState | null }

export type GitFileMutationInput = Omit<GitFileMutationRequest, 'action'>

export type GitCommitMode = 'commit' | 'commit-and-push' | 'amend'

export type GitCommitSnapshot = {
  repositoryRoot: string
  headOid: string | null
  branch: string
  indexTreeOid: string
  indexFingerprint: string
}

export type GitPushTarget = {
  remote: string
  branch: string
}

export type GitCommitPreview = {
  snapshot: GitCommitSnapshot
  stagedFileCount: number
  pushTarget: GitPushTarget | null
  amendAvailable: boolean
  suggestedMessage: string
}

export type GitCommitPreviewResult =
  | { ok: true; preview: GitCommitPreview }
  | { ok: false; error: GitErrorDto; state: GitRepositoryState | null }

export type GitCommitExecutionRequest = {
  mode: GitCommitMode
  message: string
  snapshot: GitCommitSnapshot
  expectedPushTarget: GitPushTarget | null
}

export type GitCommitWarning =
  | 'command-error-after-landing'
  | 'confirmed-snapshot-diverged'
  | 'verification-unavailable'

export type GitCommitStep =
  | { status: 'succeeded'; oid: string | null; warnings: GitCommitWarning[] }
  | { status: 'failed'; error: GitErrorDto }

export type GitPushStep =
  | { status: 'succeeded'; remote: string; branch: string }
  | { status: 'failed'; remote: string; branch: string; error: GitErrorDto }

export type GitCommitExecutionResult = {
  mode: GitCommitMode
  commit: GitCommitStep
  // null = push was not requested, or commit failed before push could start.
  push: GitPushStep | null
  postState: GitRefreshResult
}

export type GitHistorySnapshot = {
  repositoryRoot: string
  headOid: string | null
  branch: string | null
}

export type GitHistoryListRequest = {
  snapshot: GitHistorySnapshot
  offset: number
}

export type GitHistoryCommitSummary = {
  oid: string
  shortOid: string
  subject: string
  authorName: string
  authorEmail: string
  authorAt: number
  committerName: string
  committerEmail: string
  committerAt: number
  parentOids: string[]
}

export type GitHistoryListResult =
  | {
      ok: true
      snapshot: GitHistorySnapshot
      commits: GitHistoryCommitSummary[]
      offset: number
      pageSize: typeof GIT_HISTORY_PAGE_SIZE
      hasMore: boolean
    }
  | {
      ok: false
      error: GitErrorDto
      snapshot: GitHistorySnapshot | null
      current: GitHistorySnapshot | null
    }

export type GitHistoryDetailRequest = {
  snapshot: GitHistorySnapshot
  oid: string
}

export type GitHistoryFileChange =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'type-changed'
  | 'unknown'

export type GitHistoryFileEntry = {
  fileId: string
  path: string
  originalPath: string | null
  status: GitHistoryFileChange
}

export type GitHistoryCommitDetail = GitHistoryCommitSummary & {
  message: string
  messageTruncated: boolean
}

export type GitHistoryDetailResult =
  | {
      ok: true
      snapshot: GitHistorySnapshot
      commit: GitHistoryCommitDetail
      files: GitHistoryFileEntry[]
      filesTruncated: boolean
    }
  | {
      ok: false
      error: GitErrorDto
      snapshot: GitHistorySnapshot | null
      current: GitHistorySnapshot | null
    }

export type GitHistoryFileDiffRequest = {
  snapshot: GitHistorySnapshot
  oid: string
  fileId: string
}

export type GitHistoryFileDiffResult = {
  oid: string
  fileId: string
  path: string | null
  originalPath: string | null
  status: GitHistoryFileChange | null
  state: Exclude<GitDiffState, 'conflict'>
  snapshot: GitHistorySnapshot | null
  current: GitHistorySnapshot | null
  files: GitDiffFile[]
  byteCount: number
  hunkCount: number
  lineCount: number
  error: GitErrorDto | null
}

export type GitBranchKind = 'local' | 'remote-tracking'

export type GitBranchEntry = {
  branchId: string
  kind: GitBranchKind
  name: string
  headOid: string | null
  isCurrent: boolean
}

export type GitRemoteEntry = {
  remoteId: string
  name: string
}

export type GitBranchSyncSnapshot = {
  repositoryRoot: string
  headOid: string | null
  branch: string | null
  indexTreeOid: string | null
  indexFingerprint: string
  worktreeFingerprint: string
  statusRevision: string
  upstreamRemote: string | null
  upstreamBranch: string | null
}

export type GitBranchSyncCurrent = {
  branch: string | null
  headOid: string | null
  detached: boolean
  unborn: boolean
  upstream: string | null
  upstreamRemote: string | null
  upstreamBranch: string | null
  ahead: number
  behind: number
  clean: boolean
  conflicted: boolean
  truncated: boolean
}

export type GitBranchSyncActions = {
  canCreate: boolean
  canSwitch: boolean
  canFetch: boolean
  canPull: boolean
  canPush: boolean
}

export type GitBranchSyncPrepareResult =
  | {
      ok: true
      snapshot: GitBranchSyncSnapshot
      current: GitBranchSyncCurrent
      localBranches: GitBranchEntry[]
      localBranchesTruncated: boolean
      remoteTrackingBranches: GitBranchEntry[]
      remoteTrackingBranchesTruncated: boolean
      remotes: GitRemoteEntry[]
      remotesTruncated: boolean
      actions: GitBranchSyncActions
    }
  | {
      ok: false
      error: GitErrorDto
      state: GitRepositoryState | null
    }

export type GitBranchSyncExecutionRequest =
  | {
      action: 'create-and-switch'
      snapshot: GitBranchSyncSnapshot
      name: string
    }
  | {
      action: 'switch'
      snapshot: GitBranchSyncSnapshot
      branchId: string
    }
  | {
      action: 'fetch'
      snapshot: GitBranchSyncSnapshot
      remoteId: string
    }
  | {
      action: 'pull'
      snapshot: GitBranchSyncSnapshot
    }
  | {
      action: 'push'
      snapshot: GitBranchSyncSnapshot
    }

export type GitBranchMutationWarning =
  | 'command-error-after-landing'
  | 'verification-unavailable'

export type GitBranchStep =
  | {
      status: 'succeeded'
      branch: string
      headOid: string
      warnings: GitBranchMutationWarning[]
    }
  | { status: 'failed'; error: GitErrorDto }

export type GitNetworkRemoteStep =
  | { status: 'succeeded'; remote: string }
  | { status: 'failed'; remote: string; error: GitErrorDto }
  | { status: 'unknown'; remote: string; error: GitErrorDto }

export type GitFastForwardStep =
  | {
      status: 'succeeded'
      branch: string
      fromOid: string
      toOid: string
      alreadyUpToDate: boolean
      warnings: GitBranchMutationWarning[]
    }
  | { status: 'failed'; branch: string; error: GitErrorDto }

export type GitBranchSyncPushStep =
  | { status: 'succeeded'; remote: string; branch: string }
  | { status: 'failed'; remote: string; branch: string; error: GitErrorDto }
  | { status: 'unknown'; remote: string; branch: string; error: GitErrorDto }

export type GitBranchSyncExecutionResult = {
  action: GitBranchSyncExecutionRequest['action']
  branch: GitBranchStep | null
  fetch: GitNetworkRemoteStep | null
  fastForward: GitFastForwardStep | null
  push: GitBranchSyncPushStep | null
  postView: GitBranchSyncPrepareResult
}

export type GitCommand =
  | { type: 'git.refresh'; projectKey: string }
  | {
      type: 'git.authorize-ancestor-repository'
      projectKey: string
      repositoryRoot: string
      expectedStatusRevision: string
    }
  | { type: 'git.get-diff'; projectKey: string; request: GitDiffRequest }
  | { type: 'git.mutate-file'; projectKey: string; request: GitFileMutationRequest }
  | { type: 'git.prepare-commit'; projectKey: string }
  | { type: 'git.execute-commit'; projectKey: string; request: GitCommitExecutionRequest }
  | { type: 'git.list-history'; projectKey: string; request: GitHistoryListRequest }
  | { type: 'git.get-history-detail'; projectKey: string; request: GitHistoryDetailRequest }
  | { type: 'git.get-history-file-diff'; projectKey: string; request: GitHistoryFileDiffRequest }
  | { type: 'git.prepare-branch-sync'; projectKey: string }
  | { type: 'git.execute-branch-sync'; projectKey: string; request: GitBranchSyncExecutionRequest }

export type GitProjectResult<T> = {
  projectKey: string
  result: T
}

export type GitRefreshResponse = GitProjectResult<GitRefreshResult>
export type GitDiffResponse = GitProjectResult<GitDiffResult>
export type GitMutationResponse = GitProjectResult<GitMutationResult>
export type GitCommitPreviewResponse = GitProjectResult<GitCommitPreviewResult>
export type GitCommitExecutionResponse = GitProjectResult<GitCommitExecutionResult>
export type GitHistoryListResponse = GitProjectResult<GitHistoryListResult>
export type GitHistoryDetailResponse = GitProjectResult<GitHistoryDetailResult>
export type GitHistoryFileDiffResponse = GitProjectResult<GitHistoryFileDiffResult>
export type GitBranchSyncPrepareResponse = GitProjectResult<GitBranchSyncPrepareResult>
export type GitBranchSyncExecutionResponse = GitProjectResult<GitBranchSyncExecutionResult>
export type GitCommandResponse =
  | GitRefreshResponse
  | GitDiffResponse
  | GitMutationResponse
  | GitCommitPreviewResponse
  | GitCommitExecutionResponse
  | GitHistoryListResponse
  | GitHistoryDetailResponse
  | GitHistoryFileDiffResponse
  | GitBranchSyncPrepareResponse
  | GitBranchSyncExecutionResponse

export type GitApi = {
  refresh: (projectKey: string) => Promise<GitRefreshResponse>
  authorizeAncestorRepository: (
    projectKey: string,
    repositoryRoot: string,
    expectedStatusRevision: string
  ) => Promise<GitRefreshResponse>
  getDiff: (projectKey: string, request: GitDiffRequest) => Promise<GitDiffResponse>
  stageFile: (projectKey: string, request: GitFileMutationInput) => Promise<GitMutationResponse>
  unstageFile: (projectKey: string, request: GitFileMutationInput) => Promise<GitMutationResponse>
  prepareCommit: (projectKey: string) => Promise<GitCommitPreviewResponse>
  executeCommit: (
    projectKey: string,
    request: GitCommitExecutionRequest
  ) => Promise<GitCommitExecutionResponse>
  listHistory: (projectKey: string, request: GitHistoryListRequest) => Promise<GitHistoryListResponse>
  getHistoryDetail: (
    projectKey: string,
    request: GitHistoryDetailRequest
  ) => Promise<GitHistoryDetailResponse>
  getHistoryFileDiff: (
    projectKey: string,
    request: GitHistoryFileDiffRequest
  ) => Promise<GitHistoryFileDiffResponse>
  prepareBranchSync: (projectKey: string) => Promise<GitBranchSyncPrepareResponse>
  executeBranchSync: (
    projectKey: string,
    request: GitBranchSyncExecutionRequest
  ) => Promise<GitBranchSyncExecutionResponse>
}
