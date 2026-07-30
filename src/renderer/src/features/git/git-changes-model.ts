import type {
  GitDiffFile,
  GitDiffHunk,
  GitDiffKind,
  GitDiffLine,
  GitDiffRequest,
  GitDiffResult,
  GitErrorDto,
  GitFileChange,
  GitFileMutationInput,
  GitRepositoryState
} from '../../../../shared/git-contract'

export type GitFileAction = 'stage' | 'unstage'
export type GitChangeScope = 'all' | 'unstaged' | 'staged'
export type GitDiffRenderRow =
  | {
      id: string
      kind: 'fold'
      fileId: string
      unmodifiedLines: number
    }
  | {
      id: string
      kind: 'line'
      fileId: string
      line: GitDiffLine
    }

export function gitFileMatchesScope(
  file: GitFileChange,
  scope: GitChangeScope
): boolean {
  if (scope === 'all') return true
  if (scope === 'staged') return file.state === 'staged' || file.state === 'mixed'
  return file.state === 'unstaged' ||
    file.state === 'untracked' ||
    file.state === 'mixed' ||
    file.state === 'conflicted' ||
    file.conflicted
}

export function gitDiffKindsForScope(
  file: GitFileChange,
  scope: GitChangeScope
): readonly GitDiffKind[] {
  const kinds = gitDiffKindsForFile(file)
  if (scope === 'all') return kinds
  return kinds.filter((kind) => kind === (scope === 'staged' ? 'staged' : 'working'))
}

export function gitActionsForScope(
  file: GitFileChange,
  scope: GitChangeScope
): readonly GitFileAction[] {
  const actions = gitActionsForFile(file)
  if (scope === 'all') return actions
  return actions.filter((action) => action === (scope === 'staged' ? 'unstage' : 'stage'))
}

export function gitChangeScopeCount(
  files: readonly GitFileChange[],
  scope: GitChangeScope
): number {
  return files.reduce((count, file) => count + (gitFileMatchesScope(file, scope) ? 1 : 0), 0)
}

export function gitUnmodifiedLinesBeforeHunk(
  hunks: readonly GitDiffHunk[],
  index: number
): number {
  const hunk = hunks[index]
  if (hunk === undefined) return 0
  if (index === 0) {
    if (hunk.oldStart === 0 || hunk.newStart === 0) return 0
    return Math.max(0, Math.min(hunk.oldStart, hunk.newStart) - 1)
  }
  const previous = hunks[index - 1]
  if (previous === undefined) return 0
  const oldGap = hunk.oldStart - (previous.oldStart + previous.oldLines)
  const newGap = hunk.newStart - (previous.newStart + previous.newLines)
  return Math.max(0, Math.min(oldGap, newGap))
}

export function buildGitDiffRenderRows(files: readonly GitDiffFile[]): GitDiffRenderRow[] {
  const rows: GitDiffRenderRow[] = []
  for (const file of files) {
    file.hunks.forEach((hunk, hunkIndex) => {
      const unmodifiedLines = gitUnmodifiedLinesBeforeHunk(file.hunks, hunkIndex)
      if (unmodifiedLines > 0) {
        rows.push({
          id: `fold:${file.id}:${hunk.id}`,
          kind: 'fold',
          fileId: file.id,
          unmodifiedLines
        })
      }
      hunk.lines.forEach((line, lineIndex) => {
        rows.push({
          id: `line:${file.id}:${hunk.id}:${lineIndex}`,
          kind: 'line',
          fileId: file.id,
          line
        })
      })
    })
  }
  return rows
}

export function isDisplayedGitSnapshot(
  current: GitRepositoryState | null,
  snapshot: GitRepositoryState
): boolean {
  return current === snapshot
}

export function gitDiffResultInvalidatesSnapshot(
  result: GitDiffResult,
  snapshot: GitRepositoryState
): boolean {
  if (
    result.state === 'trust-required' ||
    result.state === 'not-repository' ||
    result.error?.code === 'trust-required' ||
    result.error?.code === 'not-repository' ||
    result.error?.code === 'stale'
  ) return true
  const carriesRepositoryIdentity = result.revision !== null ||
    result.headOid !== null ||
    result.indexTreeOid !== null ||
    result.worktreeFingerprint.length > 0
  return carriesRepositoryIdentity && (
    result.headOid !== snapshot.headOid ||
    result.indexTreeOid !== snapshot.indexTreeOid ||
    result.worktreeFingerprint !== snapshot.worktreeFingerprint
  )
}

export function shouldCancelGitDiffPrefetch(
  pointerInside: boolean,
  focusInside: boolean
): boolean {
  return !pointerInside && !focusInside
}

export function gitDiffRenderRowsMaxColumns(rows: readonly GitDiffRenderRow[]): number {
  let maximum = 20
  for (const row of rows) {
    if (row.kind === 'fold') continue
    maximum = Math.max(maximum, gitTextDisplayColumns(row.line.content))
  }
  return maximum
}

export function gitDiffRenderRowsText(rows: readonly GitDiffRenderRow[]): string {
  return rows.map((row) => {
    if (row.kind === 'fold') return `… ${row.unmodifiedLines} unmodified lines …`
    const line = row.line
    const marker = line.kind === 'add' ? '+' : line.kind === 'remove' ? '-' : ' '
    return `${line.oldLine ?? ''}\t${line.newLine ?? ''}\t${marker}${line.content}`
  }).join('\n')
}

export function gitDiffKindsForFile(file: GitFileChange): readonly GitDiffKind[] {
  if (file.conflicted || file.state === 'conflicted') return []
  switch (file.state) {
    case 'mixed':
      return ['working', 'staged']
    case 'staged':
      return ['staged']
    case 'unstaged':
    case 'untracked':
      return ['working']
  }
}

export function gitActionsForFile(file: GitFileChange): readonly GitFileAction[] {
  if (file.conflicted || file.state === 'conflicted') return []
  switch (file.state) {
    case 'mixed':
      return ['stage', 'unstage']
    case 'staged':
      return ['unstage']
    case 'unstaged':
    case 'untracked':
      return ['stage']
  }
}

export function buildGitDiffRequest(
  state: GitRepositoryState,
  file: GitFileChange,
  kind: GitDiffKind
): GitDiffRequest {
  const repositoryRoot = requireRepositoryRoot(state)
  if (!gitDiffKindsForFile(file).includes(kind)) {
    throw new Error(`Git diff kind ${kind} is not available for the displayed file snapshot.`)
  }
  return {
    kind,
    path: file.path,
    expectedRepositoryRoot: repositoryRoot,
    expectedHeadOid: state.headOid,
    expectedIndexTreeOid: state.indexTreeOid,
    expectedStatusRevision: state.statusRevision
  }
}

export function buildGitMutationInput(
  state: GitRepositoryState,
  file: GitFileChange,
  action: GitFileAction
): GitFileMutationInput {
  const repositoryRoot = requireRepositoryRoot(state)
  if (!gitActionsForFile(file).includes(action)) {
    throw new Error(`Git action ${action} is not available for the displayed file snapshot.`)
  }
  return {
    path: file.path,
    expectedRepositoryRoot: repositoryRoot,
    expectedHeadOid: state.headOid,
    expectedIndexTreeOid: state.indexTreeOid,
    expectedIndexFingerprint: state.indexFingerprint,
    expectedFileFingerprint: file.fingerprint,
    expectedWorktreeFingerprint: state.worktreeFingerprint,
    expectedStatusRevision: state.statusRevision
  }
}

export function isCurrentGitResponse(
  currentProjectKey: string,
  currentGeneration: number,
  requestProjectKey: string,
  requestGeneration: number,
  responseProjectKey: string
): boolean {
  return requestProjectKey === currentProjectKey &&
    requestGeneration === currentGeneration &&
    responseProjectKey === currentProjectKey
}

export function gitFileStateLabel(file: GitFileChange): string {
  if (file.conflicted || file.state === 'conflicted') return '冲突'
  switch (file.state) {
    case 'staged': return '已暂存'
    case 'unstaged': return '未暂存'
    case 'mixed': return '部分暂存'
    case 'untracked': return '未跟踪'
  }
}

export function gitFileDisplayPath(file: GitFileChange): string {
  return file.originalPath === null ? file.path : `${file.originalPath} → ${file.path}`
}

export function gitBranchLabel(state: GitRepositoryState): string {
  if (state.detached) {
    return state.headOid === null ? '分离 HEAD' : `分离 HEAD · ${state.headOid.slice(0, 8)}`
  }
  if (state.headOid === null) {
    return state.branch === null ? '尚无提交（unborn）' : `${state.branch} · 尚无提交（unborn）`
  }
  return state.branch ?? '分支不可用'
}

export function gitUpstreamLabel(state: GitRepositoryState): string {
  if (state.upstream === null) return '未设置 upstream'
  if (state.ahead === 0 && state.behind === 0) return `${state.upstream} · 已同步`
  return `${state.upstream} · 领先 ${state.ahead} · 落后 ${state.behind}`
}

export function gitErrorText(error: GitErrorDto): string {
  const message = error.message.trim()
  if (message.length > 0) return message
  switch (error.code) {
    case 'not-repository': return '当前项目不是 Git repository。'
    case 'trust-required': return '需要先允许使用上级目录中的 Git repository。'
    case 'invalid-path': return '文件路径不受支持。'
    case 'stale': return 'Git 状态已经变化，请根据刷新后的列表再次操作。'
    case 'conflict': return '冲突文件不支持此操作。'
    case 'aborted': return 'Git 操作已取消。'
    case 'timeout': return 'Git 操作超时。'
    case 'output-limit': return 'Git 输出超过安全限制。'
    case 'unsupported': return '当前 Git 状态不受支持。'
    case 'git-error': return 'Git 操作失败。'
  }
}

function gitTextDisplayColumns(text: string): number {
  let columns = 0
  for (const character of text) {
    if (character === '\t') {
      columns += 4 - (columns % 4)
      continue
    }
    const codePoint = character.codePointAt(0) ?? 0
    columns += codePoint <= 0x7f ? 1 : 2
  }
  return columns
}

function requireRepositoryRoot(state: GitRepositoryState): string {
  if (state.kind !== 'repository' || state.repositoryRoot === null) {
    throw new Error('A displayed repository snapshot is required for this Git operation.')
  }
  return state.repositoryRoot
}
