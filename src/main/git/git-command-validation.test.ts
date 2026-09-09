import assert from 'node:assert/strict'
import test from 'node:test'

import {
  GIT_COMMIT_MESSAGE_MAX_UTF8_BYTES,
  GIT_HISTORY_MAX_OFFSET,
  GIT_REPOSITORY_RELATIVE_PATH_MAX_UTF8_BYTES
} from '../../shared/git-contract.ts'
import {
  isGitBranchSyncExecutionRequest,
  isGitCommand,
  isGitCommitExecutionRequest,
  isGitDiffRequest,
  isGitFileMutationRequest,
  isGitHistoryDetailRequest,
  isGitHistoryFileDiffRequest,
  isGitHistoryListRequest
} from './git-command-validation.ts'

const HASH = 'a'.repeat(64)
const OID = 'b'.repeat(40)
const PROJECT = '/tmp/pi-gui-project'
const REPOSITORY = '/tmp/pi-gui-repository'

const diffRequest = {
  kind: 'working' as const,
  path: 'src/file.ts',
  expectedRepositoryRoot: REPOSITORY,
  expectedHeadOid: OID,
  expectedIndexTreeOid: HASH,
  expectedStatusRevision: HASH
}

const mutationRequest = {
  action: 'stage' as const,
  path: 'src/file.ts',
  expectedRepositoryRoot: REPOSITORY,
  expectedHeadOid: OID,
  expectedIndexTreeOid: HASH,
  expectedIndexFingerprint: HASH,
  expectedFileFingerprint: HASH,
  expectedWorktreeFingerprint: HASH,
  expectedStatusRevision: HASH
}

const commitRequest = {
  mode: 'commit' as const,
  message: 'Update src/file.ts',
  snapshot: {
    repositoryRoot: REPOSITORY,
    headOid: OID,
    branch: 'main',
    indexTreeOid: HASH,
    indexFingerprint: HASH
  },
  expectedPushTarget: null
}

const historySnapshot = {
  repositoryRoot: REPOSITORY,
  headOid: OID,
  branch: 'main'
}

const historyListRequest = {
  snapshot: historySnapshot,
  offset: 0
}

const historyDetailRequest = {
  snapshot: historySnapshot,
  oid: OID
}

const historyFileDiffRequest = {
  snapshot: historySnapshot,
  oid: OID,
  fileId: 'c'.repeat(32)
}

const branchSyncSnapshot = {
  repositoryRoot: REPOSITORY,
  headOid: OID,
  branch: 'main',
  indexTreeOid: HASH,
  indexFingerprint: HASH,
  worktreeFingerprint: HASH,
  statusRevision: HASH,
  upstreamRemote: 'origin',
  upstreamBranch: 'main'
}

const branchSyncCreateRequest = {
  action: 'create-and-switch' as const,
  snapshot: branchSyncSnapshot,
  name: 'feature/one'
}

test('accepts only the exact Git command union shapes', () => {
  assert.equal(isGitCommand({ type: 'git.refresh', projectKey: PROJECT }), true)
  assert.equal(isGitCommand({ type: 'git.refresh' }), false)
  assert.equal(isGitCommand({ type: 'git.refresh', projectKey: PROJECT, cwd: '/tmp/other' }), false)
  assert.equal(isGitCommand({
    type: 'git.authorize-ancestor-repository',
    projectKey: PROJECT,
    repositoryRoot: REPOSITORY,
    expectedStatusRevision: HASH
  }), true)
  assert.equal(isGitCommand({
    type: 'git.authorize-ancestor-repository',
    projectKey: PROJECT,
    repositoryRoot: REPOSITORY,
    expectedStatusRevision: HASH,
    persist: true
  }), false)
  assert.equal(isGitCommand({ type: 'git.get-diff', projectKey: PROJECT, request: diffRequest }), true)
  assert.equal(isGitCommand({ type: 'git.mutate-file', projectKey: PROJECT, request: mutationRequest }), true)
  assert.equal(isGitCommand({ type: 'git.prepare-commit', projectKey: PROJECT }), true)
  assert.equal(isGitCommand({ type: 'git.prepare-commit', projectKey: PROJECT, cwd: '/tmp' }), false)
  assert.equal(isGitCommand({ type: 'git.execute-commit', projectKey: PROJECT, request: commitRequest }), true)
  assert.equal(isGitCommand({ type: 'git.list-history', projectKey: PROJECT, request: historyListRequest }), true)
  assert.equal(isGitCommand({ type: 'git.get-history-detail', projectKey: PROJECT, request: historyDetailRequest }), true)
  assert.equal(isGitCommand({ type: 'git.get-history-file-diff', projectKey: PROJECT, request: historyFileDiffRequest }), true)
  assert.equal(isGitCommand({ type: 'git.prepare-branch-sync', projectKey: PROJECT }), true)
  assert.equal(isGitCommand({
    type: 'git.execute-branch-sync',
    projectKey: PROJECT,
    request: branchSyncCreateRequest
  }), true)
  assert.equal(isGitCommand({ type: 'git.raw', projectKey: PROJECT, args: ['status'] }), false)
  assert.equal(isGitCommand({
    type: 'git.list-history',
    projectKey: PROJECT,
    request: historyListRequest,
    cwd: '/tmp'
  }), false)
})

test('validates exact bounded history list, detail, and file-diff requests', () => {
  assert.equal(isGitHistoryListRequest(historyListRequest), true)
  assert.equal(isGitHistoryDetailRequest(historyDetailRequest), true)
  assert.equal(isGitHistoryFileDiffRequest(historyFileDiffRequest), true)
  assert.equal(isGitHistoryListRequest({ ...historyListRequest, extra: true }), false)
  assert.equal(isGitHistoryDetailRequest({ ...historyDetailRequest, path: 'src/file.ts' }), false)
  assert.equal(isGitHistoryFileDiffRequest({ ...historyFileDiffRequest, revision: 'HEAD' }), false)
  assert.equal(isGitHistoryListRequest({ snapshot: historySnapshot, offset: -1 }), false)
  assert.equal(isGitHistoryListRequest({ snapshot: historySnapshot, offset: GIT_HISTORY_MAX_OFFSET + 1 }), false)
  assert.equal(isGitHistoryListRequest({ snapshot: historySnapshot, offset: 1.5 }), false)
  assert.equal(isGitHistoryDetailRequest({ snapshot: historySnapshot, oid: 'HEAD' }), false)
  assert.equal(isGitHistoryDetailRequest({ snapshot: historySnapshot, oid: 'b'.repeat(39) }), false)
  assert.equal(isGitHistoryFileDiffRequest({ ...historyFileDiffRequest, fileId: '' }), false)
  assert.equal(isGitHistoryFileDiffRequest({ ...historyFileDiffRequest, fileId: 'not-hex!' }), false)
  assert.equal(isGitHistoryListRequest({
    snapshot: { ...historySnapshot, branch: 'bad\nbranch' },
    offset: 0
  }), false)
  assert.equal(isGitHistoryListRequest({
    snapshot: { repositoryRoot: REPOSITORY, headOid: null, branch: 'main' },
    offset: 0
  }), true)
  assert.equal(isGitHistoryListRequest({
    snapshot: { repositoryRoot: REPOSITORY, headOid: OID, branch: null },
    offset: 0
  }), true)
})

test('rejects unsafe and noncanonical Project and authorization roots', () => {
  for (const projectKey of ['', '   ', 'relative', '/tmp/../etc', '/tmp/project/', '/tmp/control\npath']) {
    assert.equal(isGitCommand({ type: 'git.refresh', projectKey }), false, projectKey)
  }
  for (const repositoryRoot of ['', 'relative', '/tmp/repository/', '/tmp/repository\0other']) {
    assert.equal(isGitCommand({
      type: 'git.authorize-ancestor-repository',
      projectKey: PROJECT,
      repositoryRoot,
      expectedStatusRevision: HASH
    }), false, repositoryRoot)
  }
  assert.equal(isGitCommand({
    type: 'git.authorize-ancestor-repository',
    projectKey: PROJECT,
    repositoryRoot: REPOSITORY,
    expectedStatusRevision: 'stale'
  }), false)
})

test('validates exact bounded diff and file mutation requests', () => {
  assert.equal(isGitDiffRequest(diffRequest), true)
  assert.equal(isGitFileMutationRequest(mutationRequest), true)
  assert.equal(isGitDiffRequest({ ...diffRequest, extra: true }), false)
  const { expectedStatusRevision: _missingDiff, ...missingDiff } = diffRequest
  assert.equal(isGitDiffRequest(missingDiff), false)
  assert.equal(isGitFileMutationRequest({ ...mutationRequest, args: ['--all'] }), false)
  const { expectedFileFingerprint: _missingMutation, ...missingMutation } = mutationRequest
  assert.equal(isGitFileMutationRequest(missingMutation), false)

  for (const path of ['', '   ', '/etc/passwd', '../outside', 'src/../outside', './file', 'dir//file', 'bad\nfile']) {
    assert.equal(isGitDiffRequest({ ...diffRequest, path }), false, path)
    assert.equal(isGitFileMutationRequest({ ...mutationRequest, path }), false, path)
  }
  const overlong = '界'.repeat(Math.floor(GIT_REPOSITORY_RELATIVE_PATH_MAX_UTF8_BYTES / 3) + 1)
  assert.equal(isGitDiffRequest({ ...diffRequest, path: overlong }), false)
  assert.equal(isGitFileMutationRequest({ ...mutationRequest, path: overlong }), false)

  assert.equal(isGitDiffRequest({ ...diffRequest, expectedRepositoryRoot: '/tmp/repository/' }), false)
  assert.equal(isGitDiffRequest({ ...diffRequest, expectedHeadOid: 'HEAD' }), false)
  assert.equal(isGitFileMutationRequest({ ...mutationRequest, action: 'commit' }), false)
  assert.equal(isGitFileMutationRequest({ ...mutationRequest, expectedIndexFingerprint: 'x'.repeat(64) }), false)
})

test('accepts only exact lowercase SHA-1 or SHA-256 Git object identity widths', () => {
  for (const length of [40, 64]) {
    const oid = 'b'.repeat(length)
    assert.equal(isGitDiffRequest({ ...diffRequest, expectedHeadOid: oid }), true, String(length))
    assert.equal(isGitDiffRequest({ ...diffRequest, expectedIndexTreeOid: oid }), true, String(length))
  }
  for (const length of [39, 41, 63, 65]) {
    const oid = 'b'.repeat(length)
    assert.equal(isGitDiffRequest({ ...diffRequest, expectedHeadOid: oid }), false, String(length))
    assert.equal(isGitDiffRequest({ ...diffRequest, expectedIndexTreeOid: oid }), false, String(length))
  }
  assert.equal(isGitDiffRequest({ ...diffRequest, expectedHeadOid: 'B'.repeat(40) }), false)
})

test('validates exact commit execution requests and message bounds', () => {
  assert.equal(isGitCommitExecutionRequest(commitRequest), true)
  assert.equal(isGitCommitExecutionRequest({
    ...commitRequest,
    mode: 'commit-and-push',
    expectedPushTarget: { remote: 'origin', branch: 'main' }
  }), true)
  assert.equal(isGitCommitExecutionRequest({ ...commitRequest, mode: 'amend' }), true)
  assert.equal(isGitCommitExecutionRequest({ ...commitRequest, mode: 'commit-and-push', expectedPushTarget: null }), false)
  assert.equal(isGitCommitExecutionRequest({ ...commitRequest, mode: 'push' }), false)
  assert.equal(isGitCommitExecutionRequest({ ...commitRequest, force: true }), false)
  assert.equal(isGitCommitExecutionRequest({ ...commitRequest, noVerify: true }), false)
  assert.equal(isGitCommitExecutionRequest({ ...commitRequest, all: true }), false)
  assert.equal(isGitCommitExecutionRequest({ ...commitRequest, setUpstream: true }), false)
  assert.equal(isGitCommitExecutionRequest({ ...commitRequest, args: ['--allow-empty'] }), false)
  assert.equal(isGitCommitExecutionRequest({ ...commitRequest, message: '   ' }), false)
  assert.equal(isGitCommitExecutionRequest({ ...commitRequest, message: 'has\0nul' }), false)
  assert.equal(isGitCommitExecutionRequest({
    ...commitRequest,
    message: '界'.repeat(Math.floor(GIT_COMMIT_MESSAGE_MAX_UTF8_BYTES / 3) + 1)
  }), false)
  assert.equal(isGitCommitExecutionRequest({
    ...commitRequest,
    message: 'x'.repeat(GIT_COMMIT_MESSAGE_MAX_UTF8_BYTES)
  }), true)
  assert.equal(isGitCommitExecutionRequest({
    ...commitRequest,
    message: 'line1\nline2\nunicode-提交'
  }), true)
  assert.equal(isGitCommitExecutionRequest({
    ...commitRequest,
    snapshot: { ...commitRequest.snapshot, branch: 'feature/name' }
  }), true)
  assert.equal(isGitCommitExecutionRequest({
    ...commitRequest,
    snapshot: { ...commitRequest.snapshot, branch: 'bad\nbranch' }
  }), false)
  assert.equal(isGitCommitExecutionRequest({
    ...commitRequest,
    snapshot: { ...commitRequest.snapshot, repositoryRoot: 'relative' }
  }), false)
  assert.equal(isGitCommitExecutionRequest({
    ...commitRequest,
    snapshot: { ...commitRequest.snapshot, indexFingerprint: 'not-a-hash' }
  }), false)
  assert.equal(isGitCommitExecutionRequest({
    ...commitRequest,
    expectedPushTarget: { remote: 'company/prod', branch: 'main', url: 'https://example.invalid' }
  }), false)
  assert.equal(isGitCommitExecutionRequest({
    ...commitRequest,
    mode: 'commit-and-push',
    expectedPushTarget: { remote: 'company/prod', branch: 'release/1.0' }
  }), true)
  assert.equal(isGitCommand({
    type: 'git.execute-commit',
    projectKey: PROJECT,
    request: {
      ...commitRequest,
      mode: 'commit-and-push',
      expectedPushTarget: { remote: 'origin', branch: 'main' }
    }
  }), true)
  for (const invalidName of [
    '-u',
    '--receive-pack=touch /tmp/pwned',
    'bad name',
    'bad..name',
    'bad@{name',
    'bad~name',
    'bad^name',
    'bad:name',
    'bad?name',
    'bad*name',
    'bad[name',
    'bad\\name',
    'bad//name',
    'trailing.',
    'trailing.lock'
  ]) {
    assert.equal(isGitCommitExecutionRequest({
      ...commitRequest,
      mode: 'commit-and-push',
      expectedPushTarget: { remote: invalidName, branch: 'main' }
    }), false, invalidName)
    assert.equal(isGitCommitExecutionRequest({
      ...commitRequest,
      mode: 'commit-and-push',
      expectedPushTarget: { remote: 'origin', branch: invalidName }
    }), false, invalidName)
  }
})

test('validates exact branch-sync prepare/execute requests and rejects hostile inputs', () => {
  assert.equal(isGitCommand({ type: 'git.prepare-branch-sync', projectKey: PROJECT }), true)
  assert.equal(isGitCommand({ type: 'git.prepare-branch-sync', projectKey: PROJECT, cwd: '/tmp' }), false)
  assert.equal(isGitBranchSyncExecutionRequest(branchSyncCreateRequest), true)
  assert.equal(isGitBranchSyncExecutionRequest({
    action: 'switch',
    snapshot: branchSyncSnapshot,
    branchId: 'd'.repeat(32)
  }), true)
  assert.equal(isGitBranchSyncExecutionRequest({
    action: 'fetch',
    snapshot: branchSyncSnapshot,
    remoteId: 'e'.repeat(32)
  }), true)
  assert.equal(isGitBranchSyncExecutionRequest({
    action: 'pull',
    snapshot: branchSyncSnapshot
  }), true)
  assert.equal(isGitBranchSyncExecutionRequest({
    action: 'push',
    snapshot: branchSyncSnapshot
  }), true)

  assert.equal(isGitBranchSyncExecutionRequest({
    ...branchSyncCreateRequest,
    refspec: 'refs/heads/*'
  }), false)
  assert.equal(isGitBranchSyncExecutionRequest({
    ...branchSyncCreateRequest,
    cwd: '/tmp'
  }), false)
  assert.equal(isGitBranchSyncExecutionRequest({
    action: 'switch',
    snapshot: branchSyncSnapshot,
    branchId: 'main'
  }), false)
  assert.equal(isGitBranchSyncExecutionRequest({
    action: 'fetch',
    snapshot: branchSyncSnapshot,
    remoteId: 'origin'
  }), false)
  assert.equal(isGitBranchSyncExecutionRequest({
    action: 'fetch',
    snapshot: branchSyncSnapshot,
    remoteId: 'e'.repeat(32),
    remote: 'origin'
  }), false)
  assert.equal(isGitBranchSyncExecutionRequest({
    action: 'create-and-switch',
    snapshot: branchSyncSnapshot,
    name: '-c'
  }), false)
  assert.equal(isGitBranchSyncExecutionRequest({
    action: 'create-and-switch',
    snapshot: branchSyncSnapshot,
    name: '--help'
  }), false)
  assert.equal(isGitBranchSyncExecutionRequest({
    action: 'create-and-switch',
    snapshot: branchSyncSnapshot,
    name: 'bad name'
  }), false)
  assert.equal(isGitBranchSyncExecutionRequest({
    action: 'create-and-switch',
    snapshot: branchSyncSnapshot,
    name: 'feature..bad'
  }), false)
  assert.equal(isGitBranchSyncExecutionRequest({
    action: 'push',
    snapshot: {
      ...branchSyncSnapshot,
      upstreamRemote: 'company/prod'
    }
  }), true)
  assert.equal(isGitBranchSyncExecutionRequest({
    action: 'push',
    snapshot: {
      ...branchSyncSnapshot,
      upstreamRemote: '-u'
    }
  }), false)
  assert.equal(isGitCommand({
    type: 'git.execute-branch-sync',
    projectKey: PROJECT,
    request: branchSyncCreateRequest,
    args: ['fetch', '--all']
  }), false)
})
