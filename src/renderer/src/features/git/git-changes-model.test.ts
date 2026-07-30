import assert from 'node:assert/strict'
import test from 'node:test'

import type { GitDiffHunk, GitDiffResult, GitFileChange, GitRepositoryState } from '../../../../shared/git-contract.ts'
import {
  buildGitDiffRenderRows,
  buildGitDiffRequest,
  buildGitMutationInput,
  gitActionsForFile,
  gitActionsForScope,
  gitBranchLabel,
  gitChangeScopeCount,
  gitDiffKindsForFile,
  gitDiffKindsForScope,
  gitDiffRenderRowsMaxColumns,
  gitDiffRenderRowsText,
  gitDiffResultInvalidatesSnapshot,
  gitErrorText,
  gitFileDisplayPath,
  gitFileMatchesScope,
  gitUnmodifiedLinesBeforeHunk,
  gitUpstreamLabel,
  isCurrentGitResponse,
  isDisplayedGitSnapshot,
  shouldCancelGitDiffPrefetch,
  type GitDiffRenderRow
} from './git-changes-model.ts'

const mixedFile: GitFileChange = {
  id: 'file-1',
  path: 'src/new-name.ts',
  originalPath: 'src/old-name.ts',
  state: 'mixed',
  indexChange: 'renamed',
  worktreeChange: 'modified',
  conflicted: false,
  fingerprint: 'file-fingerprint'
}

const repositoryState: GitRepositoryState = {
  kind: 'repository',
  projectRoot: '/project',
  repositoryRoot: '/repository',
  headOid: '1234567890abcdef',
  branch: 'main',
  detached: false,
  upstream: 'origin/main',
  ahead: 2,
  behind: 1,
  indexTreeOid: 'index-tree',
  indexFingerprint: 'index-fingerprint',
  worktreeFingerprint: 'worktree-fingerprint',
  statusRevision: 'status-revision',
  files: [mixedFile],
  truncated: false,
  refreshedAt: 100,
  lastError: null
}

test('mixed files expose one row with Working first and both file-level mutations', () => {
  assert.deepEqual(gitDiffKindsForFile(mixedFile), ['working', 'staged'])
  assert.deepEqual(gitActionsForFile(mixedFile), ['stage', 'unstage'])
  assert.equal(gitFileDisplayPath(mixedFile), 'src/old-name.ts → src/new-name.ts')

  assert.deepEqual(gitDiffKindsForFile({ ...mixedFile, state: 'untracked', originalPath: null }), ['working'])
  assert.deepEqual(gitDiffKindsForFile({ ...mixedFile, state: 'staged' }), ['staged'])
  assert.deepEqual(gitActionsForFile({ ...mixedFile, state: 'unstaged' }), ['stage'])
  assert.deepEqual(gitActionsForFile({ ...mixedFile, state: 'staged' }), ['unstage'])
})

test('Cursor-style scopes keep mixed files in both projections with scoped diff and mutation actions', () => {
  const unstaged = { ...mixedFile, id: 'unstaged', state: 'unstaged', originalPath: null } as const
  const staged = { ...mixedFile, id: 'staged', state: 'staged', originalPath: null } as const
  const untracked = { ...mixedFile, id: 'untracked', state: 'untracked', originalPath: null } as const
  const conflict = { ...mixedFile, id: 'conflict', state: 'conflicted', conflicted: true } as const
  const files = [mixedFile, unstaged, staged, untracked, conflict]

  assert.equal(gitChangeScopeCount(files, 'all'), 5)
  assert.equal(gitChangeScopeCount(files, 'unstaged'), 4)
  assert.equal(gitChangeScopeCount(files, 'staged'), 2)
  assert.equal(gitFileMatchesScope(mixedFile, 'unstaged'), true)
  assert.equal(gitFileMatchesScope(mixedFile, 'staged'), true)
  assert.equal(gitFileMatchesScope(conflict, 'unstaged'), true)
  assert.equal(gitFileMatchesScope(conflict, 'staged'), false)
  assert.deepEqual(gitDiffKindsForScope(mixedFile, 'all'), ['working', 'staged'])
  assert.deepEqual(gitDiffKindsForScope(mixedFile, 'unstaged'), ['working'])
  assert.deepEqual(gitDiffKindsForScope(mixedFile, 'staged'), ['staged'])
  assert.deepEqual(gitActionsForScope(mixedFile, 'all'), ['stage', 'unstage'])
  assert.deepEqual(gitActionsForScope(mixedFile, 'unstaged'), ['stage'])
  assert.deepEqual(gitActionsForScope(mixedFile, 'staged'), ['unstage'])
})

test('omitted unchanged ranges are derived exactly from canonical hunk coordinates', () => {
  const hunk = (
    id: string,
    oldStart: number,
    oldLines: number,
    newStart: number,
    newLines: number
  ): GitDiffHunk => ({
    id,
    header: `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`,
    oldStart,
    oldLines,
    newStart,
    newLines,
    lines: []
  })
  const hunks = [
    hunk('first', 731, 5, 731, 5),
    hunk('second', 860, 6, 860, 7),
    hunk('third', 900, 4, 901, 4)
  ]

  assert.equal(gitUnmodifiedLinesBeforeHunk(hunks, 0), 730)
  assert.equal(gitUnmodifiedLinesBeforeHunk(hunks, 1), 124)
  assert.equal(gitUnmodifiedLinesBeforeHunk(hunks, 2), 34)
  assert.equal(gitUnmodifiedLinesBeforeHunk([hunk('new', 0, 0, 1, 8)], 0), 0)
  assert.equal(gitUnmodifiedLinesBeforeHunk(hunks, 99), 0)
})

test('diff render rows preserve fold and line order for direct and virtual rendering', () => {
  const rows = buildGitDiffRenderRows([{
    id: 'diff-file',
    path: 'src/file.ts',
    originalPath: null,
    change: 'modified',
    hunks: [
      {
        id: 'hunk-a',
        header: '@@ -4,1 +4,1 @@',
        oldStart: 4,
        oldLines: 1,
        newStart: 4,
        newLines: 1,
        lines: [{ kind: 'context', oldLine: 4, newLine: 4, content: 'same' }]
      },
      {
        id: 'hunk-b',
        header: '@@ -10,1 +10,1 @@',
        oldStart: 10,
        oldLines: 1,
        newStart: 10,
        newLines: 1,
        lines: [{ kind: 'add', oldLine: null, newLine: 10, content: 'added' }]
      }
    ]
  }])

  assert.deepEqual(rows.map((row) => row.kind), ['fold', 'line', 'fold', 'line'])
  assert.equal(rows[0]?.kind === 'fold' ? rows[0].unmodifiedLines : null, 3)
  assert.equal(rows[2]?.kind === 'fold' ? rows[2].unmodifiedLines : null, 5)
  assert.equal(rows[3]?.kind === 'line' ? rows[3].line.content : null, 'added')
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length)
})

test('displayed snapshot ownership rejects a replacement object even when every field is equal', () => {
  assert.equal(isDisplayedGitSnapshot(repositoryState, repositoryState), true)
  assert.equal(isDisplayedGitSnapshot({ ...repositoryState }, repositoryState), false)
  assert.equal(isDisplayedGitSnapshot(null, repositoryState), false)
})

test('snapshot invalidation includes null-revision trust loss and repository loss', () => {
  const result: GitDiffResult = {
    kind: 'working',
    path: mixedFile.path,
    state: 'ready',
    revision: 'diff-revision',
    headOid: repositoryState.headOid,
    indexTreeOid: repositoryState.indexTreeOid,
    worktreeFingerprint: repositoryState.worktreeFingerprint,
    files: [],
    byteCount: 0,
    fileCount: 0,
    hunkCount: 0,
    lineCount: 0,
    error: null
  }

  assert.equal(gitDiffResultInvalidatesSnapshot(result, repositoryState), false)
  assert.equal(gitDiffResultInvalidatesSnapshot({ ...result, headOid: 'new-head' }, repositoryState), true)
  assert.equal(gitDiffResultInvalidatesSnapshot({
    ...result,
    state: 'trust-required',
    revision: null,
    headOid: null,
    indexTreeOid: null,
    worktreeFingerprint: ''
  }, repositoryState), true)
  assert.equal(gitDiffResultInvalidatesSnapshot({
    ...result,
    state: 'not-repository',
    revision: null,
    headOid: null,
    indexTreeOid: null,
    worktreeFingerprint: ''
  }, repositoryState), true)
  assert.equal(gitDiffResultInvalidatesSnapshot({
    ...result,
    state: 'error',
    revision: null,
    error: { code: 'trust-required', message: 'Trust changed.', stderrCharacters: 0 }
  }, repositoryState), true)
  assert.equal(gitDiffResultInvalidatesSnapshot({
    ...result,
    state: 'error',
    revision: null,
    error: { code: 'timeout', message: 'Timed out.', stderrCharacters: 0 }
  }, repositoryState), false)
  assert.equal(gitDiffResultInvalidatesSnapshot({
    ...result,
    state: 'error',
    revision: null,
    worktreeFingerprint: 'new-worktree',
    error: { code: 'timeout', message: 'Timed out after state changed.', stderrCharacters: 0 }
  }, repositoryState), true)
  assert.equal(gitDiffResultInvalidatesSnapshot({
    ...result,
    state: 'error',
    revision: null,
    headOid: 'new-head',
    indexTreeOid: null,
    worktreeFingerprint: '',
    error: { code: 'timeout', message: 'Head changed.', stderrCharacters: 0 }
  }, repositoryState), true)
  assert.equal(gitDiffResultInvalidatesSnapshot({
    ...result,
    state: 'error',
    revision: null,
    headOid: null,
    indexTreeOid: 'new-index',
    worktreeFingerprint: '',
    error: { code: 'timeout', message: 'Index changed.', stderrCharacters: 0 }
  }, repositoryState), true)
})

test('prefetch remains scheduled while either pointer or keyboard focus still owns intent', () => {
  assert.equal(shouldCancelGitDiffPrefetch(false, false), true)
  assert.equal(shouldCancelGitDiffPrefetch(true, false), false)
  assert.equal(shouldCancelGitDiffPrefetch(false, true), false)
  assert.equal(shouldCancelGitDiffPrefetch(true, true), false)
})

test('large diff text and width models cover every render row without mounting every row', () => {
  const rows: GitDiffRenderRow[] = [
    { id: 'fold', kind: 'fold', fileId: 'file', unmodifiedLines: 42 },
    {
      id: 'line-a',
      kind: 'line',
      fileId: 'file',
      line: { kind: 'context', oldLine: 1, newLine: 1, content: '123456789012345678901' }
    },
    {
      id: 'line-b',
      kind: 'line',
      fileId: 'file',
      line: { kind: 'add', oldLine: null, newLine: 2, content: '中文中文中文中文中文中文' }
    }
  ]

  assert.equal(gitDiffRenderRowsMaxColumns(rows), 24)
  assert.equal(
    gitDiffRenderRowsText(rows),
    '… 42 unmodified lines …\n1\t1\t 123456789012345678901\n\t2\t+中文中文中文中文中文中文'
  )
})

test('conflicts expose neither diff nor stage and unstage actions', () => {
  const conflict = { ...mixedFile, state: 'conflicted', conflicted: true } as const
  assert.deepEqual(gitDiffKindsForFile(conflict), [])
  assert.deepEqual(gitActionsForFile(conflict), [])
})

test('diff and mutation requests copy the exact displayed repository and file snapshot', () => {
  assert.deepEqual(buildGitDiffRequest(repositoryState, mixedFile, 'working'), {
    kind: 'working',
    path: 'src/new-name.ts',
    expectedRepositoryRoot: '/repository',
    expectedHeadOid: '1234567890abcdef',
    expectedIndexTreeOid: 'index-tree',
    expectedStatusRevision: 'status-revision'
  })
  assert.deepEqual(buildGitMutationInput(repositoryState, mixedFile, 'stage'), {
    path: 'src/new-name.ts',
    expectedRepositoryRoot: '/repository',
    expectedHeadOid: '1234567890abcdef',
    expectedIndexTreeOid: 'index-tree',
    expectedIndexFingerprint: 'index-fingerprint',
    expectedFileFingerprint: 'file-fingerprint',
    expectedWorktreeFingerprint: 'worktree-fingerprint',
    expectedStatusRevision: 'status-revision'
  })

  assert.throws(
    () => buildGitDiffRequest(repositoryState, { ...mixedFile, state: 'staged' }, 'working'),
    /not available/
  )
  assert.throws(
    () => buildGitMutationInput(repositoryState, { ...mixedFile, state: 'staged' }, 'stage'),
    /not available/
  )
  assert.throws(
    () => buildGitMutationInput({ ...repositoryState, kind: 'trust-required' }, mixedFile, 'stage'),
    /displayed repository snapshot/
  )
})

test('response identity requires exact project and generation agreement', () => {
  assert.equal(isCurrentGitResponse('project-a', 4, 'project-a', 4, 'project-a'), true)
  assert.equal(isCurrentGitResponse('project-b', 5, 'project-a', 4, 'project-a'), false)
  assert.equal(isCurrentGitResponse('project-a', 5, 'project-a', 4, 'project-a'), false)
  assert.equal(isCurrentGitResponse('project-a', 4, 'project-a', 4, 'project-b'), false)
})

test('branch summaries cover normal, detached, unborn, upstream and divergence states', () => {
  assert.equal(gitBranchLabel(repositoryState), 'main')
  assert.equal(gitBranchLabel({ ...repositoryState, detached: true, branch: null }), '分离 HEAD · 12345678')
  assert.equal(gitBranchLabel({ ...repositoryState, headOid: null, branch: 'main' }), 'main · 尚无提交（unborn）')
  assert.equal(gitBranchLabel({ ...repositoryState, headOid: null, branch: null }), '尚无提交（unborn）')
  assert.equal(gitUpstreamLabel(repositoryState), 'origin/main · 领先 2 · 落后 1')
  assert.equal(gitUpstreamLabel({ ...repositoryState, upstream: null, ahead: 0, behind: 0 }), '未设置 upstream')
  assert.equal(gitUpstreamLabel({ ...repositoryState, ahead: 0, behind: 0 }), 'origin/main · 已同步')
})

test('bounded Git errors use only the public message and never stderr metadata', () => {
  const text = gitErrorText({ code: 'git-error', message: 'Public bounded failure.', stderrCharacters: 987 })
  assert.equal(text, 'Public bounded failure.')
  assert.doesNotMatch(text, /987|stderr/i)
  assert.equal(gitErrorText({ code: 'timeout', message: '', stderrCharacters: 50 }), 'Git 操作超时。')
})
