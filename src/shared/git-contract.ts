export const GIT_COMMAND_CHANNEL = 'pi-gui:git-command'
export const GIT_REPOSITORY_RELATIVE_PATH_MAX_UTF8_BYTES = 4_096

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

export type GitProjectResult<T> = {
  projectKey: string
  result: T
}

export type GitRefreshResponse = GitProjectResult<GitRefreshResult>
export type GitDiffResponse = GitProjectResult<GitDiffResult>
export type GitMutationResponse = GitProjectResult<GitMutationResult>
export type GitCommandResponse = GitRefreshResponse | GitDiffResponse | GitMutationResponse

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
}
