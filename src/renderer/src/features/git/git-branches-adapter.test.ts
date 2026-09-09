import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  GitBranchSyncExecutionResult,
  GitBranchSyncPrepareResult,
  GitBranchSyncSnapshot,
  GitRepositoryState
} from '../../../../shared/git-contract.ts'
import {
  buildGitBranchSyncDialogPreview,
  buildGitBranchSyncExecutionRequest,
  gitBranchSyncExecutionMatchesPreview,
  gitBranchSyncSnapshotMatchesState,
  mapGitBranchSyncExecutionResult,
  mapGitBranchSyncPrepareResult
} from './git-branches-adapter.ts'

const snapshot: GitBranchSyncSnapshot = {
  repositoryRoot: '/repo',
  headOid: 'a'.repeat(40),
  branch: 'main',
  indexTreeOid: 'b'.repeat(40),
  indexFingerprint: 'index',
  worktreeFingerprint: 'worktree',
  statusRevision: 'revision',
  upstreamRemote: 'company/prod',
  upstreamBranch: 'main'
}

function prepared(): Extract<GitBranchSyncPrepareResult, { ok: true }> {
  return {
    ok: true,
    snapshot,
    current: {
      branch: 'main',
      headOid: snapshot.headOid,
      detached: false,
      unborn: false,
      upstream: 'company/prod/main',
      upstreamRemote: 'company/prod',
      upstreamBranch: 'main',
      ahead: 1,
      behind: 2,
      clean: true,
      conflicted: false,
      truncated: false
    },
    localBranches: [
      { branchId: 'l1', kind: 'local', name: 'main', headOid: snapshot.headOid, isCurrent: true },
      { branchId: 'l2', kind: 'local', name: 'feature', headOid: 'c'.repeat(40), isCurrent: false }
    ],
    localBranchesTruncated: false,
    remoteTrackingBranches: [
      { branchId: 't1', kind: 'remote-tracking', name: 'company/prod/main', headOid: snapshot.headOid, isCurrent: false },
      { branchId: 't2', kind: 'remote-tracking', name: 'company/legacy', headOid: 'd'.repeat(40), isCurrent: false }
    ],
    remoteTrackingBranchesTruncated: false,
    remotes: [
      { remoteId: 'r1', name: 'company' },
      { remoteId: 'r2', name: 'company/prod' }
    ],
    remotesTruncated: false,
    actions: {
      canCreate: true,
      canSwitch: true,
      canFetch: true,
      canPull: true,
      canPush: true
    }
  }
}

test('snapshot matching fences repository, HEAD, index, worktree and revision', () => {
  const state: GitRepositoryState = {
    kind: 'repository',
    projectRoot: '/repo',
    repositoryRoot: snapshot.repositoryRoot,
    branch: snapshot.branch,
    headOid: snapshot.headOid,
    detached: false,
    upstream: 'company/prod/main',
    ahead: 1,
    behind: 2,
    indexTreeOid: snapshot.indexTreeOid,
    indexFingerprint: snapshot.indexFingerprint,
    worktreeFingerprint: snapshot.worktreeFingerprint,
    statusRevision: snapshot.statusRevision,
    files: [],
    truncated: false,
    refreshedAt: 1,
    lastError: null
  }
  assert.equal(gitBranchSyncSnapshotMatchesState(snapshot, state), true)
  assert.equal(gitBranchSyncSnapshotMatchesState({ ...snapshot, headOid: 'e'.repeat(40) }, state), false)
  assert.equal(gitBranchSyncSnapshotMatchesState(snapshot, { ...state, statusRevision: 'changed' }), false)
})

test('prepare mapping groups slash remote names by the longest configured prefix', () => {
  const mapped = mapGitBranchSyncPrepareResult(prepared())
  assert.equal(mapped.snapshot, snapshot)
  assert.equal(mapped.view.currentBranchLabel, 'main')
  assert.equal(mapped.view.selectedLocalBranchId, 'l2')
  assert.equal(mapped.view.remoteGroups[0]?.branches[0]?.name, 'legacy')
  assert.equal(mapped.view.remoteGroups[1]?.branches[0]?.name, 'main')
  assert.equal(mapped.view.actions.pull.enabled, true)
})

test('execution requests carry only snapshot plus opaque ids or validated create input', () => {
  assert.deepEqual(buildGitBranchSyncExecutionRequest({ action: 'switch', branchId: 'l2' }, snapshot), {
    action: 'switch',
    snapshot,
    branchId: 'l2'
  })
  assert.deepEqual(buildGitBranchSyncExecutionRequest({ action: 'fetch', remoteId: 'r2' }, snapshot), {
    action: 'fetch',
    snapshot,
    remoteId: 'r2'
  })
  assert.deepEqual(buildGitBranchSyncExecutionRequest({ action: 'create', branchName: 'topic' }, snapshot), {
    action: 'create-and-switch',
    snapshot,
    name: 'topic'
  })
})

test('action-specific response validation rejects mismatched branch, remote, push and post-view identities', () => {
  const view = mapGitBranchSyncPrepareResult(prepared()).view
  const succeededPostView = prepared()
  const switchResult: GitBranchSyncExecutionResult = {
    action: 'switch',
    branch: { status: 'succeeded', branch: 'feature', headOid: 'c'.repeat(40), warnings: [] },
    fetch: null,
    fastForward: null,
    push: null,
    postView: {
      ...succeededPostView,
      snapshot: { ...snapshot, branch: 'feature', headOid: 'c'.repeat(40) },
      current: { ...succeededPostView.current, branch: 'feature', headOid: 'c'.repeat(40) }
    }
  }
  assert.equal(gitBranchSyncExecutionMatchesPreview(
    switchResult,
    buildGitBranchSyncDialogPreview('switch', view),
    { action: 'switch', branchId: 'l2' },
    snapshot
  ), true)
  assert.equal(gitBranchSyncExecutionMatchesPreview(
    {
      ...switchResult,
      branch: { status: 'succeeded', branch: 'other', headOid: 'c'.repeat(40), warnings: [] }
    },
    buildGitBranchSyncDialogPreview('switch', view),
    { action: 'switch', branchId: 'l2' },
    snapshot
  ), false)
  assert.equal(gitBranchSyncExecutionMatchesPreview(
    {
      ...switchResult,
      postView: {
        ...succeededPostView,
        snapshot: { ...snapshot, branch: 'other', headOid: 'c'.repeat(40) },
        current: { ...succeededPostView.current, branch: 'feature', headOid: 'c'.repeat(40) }
      }
    },
    buildGitBranchSyncDialogPreview('switch', view),
    { action: 'switch', branchId: 'l2' },
    snapshot
  ), false)

  const fetchResult: GitBranchSyncExecutionResult = {
    action: 'fetch',
    branch: null,
    fetch: { status: 'succeeded', remote: 'company/prod' },
    fastForward: null,
    push: null,
    postView: succeededPostView
  }
  const fetchPreview = buildGitBranchSyncDialogPreview('fetch', view)
  assert.equal(gitBranchSyncExecutionMatchesPreview(
    fetchResult,
    fetchPreview,
    { action: 'fetch', remoteId: 'r2' },
    snapshot
  ), true)
  assert.equal(gitBranchSyncExecutionMatchesPreview(
    { ...fetchResult, fetch: { status: 'succeeded', remote: '' } },
    fetchPreview,
    { action: 'fetch', remoteId: 'r2' },
    snapshot
  ), false)
  assert.equal(gitBranchSyncExecutionMatchesPreview(
    {
      ...fetchResult,
      postView: {
        ...succeededPostView,
        snapshot: { ...snapshot, indexFingerprint: 'contradictory-index' }
      }
    },
    fetchPreview,
    { action: 'fetch', remoteId: 'r2' },
    snapshot
  ), false)

  const pullHead = 'e'.repeat(40)
  const pullResult: GitBranchSyncExecutionResult = {
    action: 'pull',
    branch: null,
    fetch: { status: 'succeeded', remote: 'company/prod' },
    fastForward: {
      status: 'succeeded',
      branch: 'main',
      fromOid: snapshot.headOid!,
      toOid: pullHead,
      alreadyUpToDate: false,
      warnings: []
    },
    push: null,
    postView: {
      ...succeededPostView,
      snapshot: { ...snapshot, headOid: pullHead },
      current: { ...succeededPostView.current, headOid: pullHead }
    }
  }
  assert.equal(gitBranchSyncExecutionMatchesPreview(
    pullResult,
    buildGitBranchSyncDialogPreview('pull', view),
    { action: 'pull' },
    snapshot
  ), true)
  assert.equal(gitBranchSyncExecutionMatchesPreview(
    { ...pullResult, fetch: { status: 'succeeded', remote: 'company' } },
    buildGitBranchSyncDialogPreview('pull', view),
    { action: 'pull' },
    snapshot
  ), false)
  assert.equal(gitBranchSyncExecutionMatchesPreview(
    {
      ...pullResult,
      postView: {
        ...succeededPostView,
        snapshot: { ...snapshot, branch: 'other', headOid: pullHead },
        current: { ...succeededPostView.current, branch: 'other', headOid: pullHead }
      }
    },
    buildGitBranchSyncDialogPreview('pull', view),
    { action: 'pull' },
    snapshot
  ), false)

  const pushResult: GitBranchSyncExecutionResult = {
    action: 'push',
    branch: null,
    fetch: null,
    fastForward: null,
    push: { status: 'succeeded', remote: 'company/prod', branch: 'main' },
    postView: succeededPostView
  }
  assert.equal(gitBranchSyncExecutionMatchesPreview(
    pushResult,
    buildGitBranchSyncDialogPreview('push', view),
    { action: 'push' },
    snapshot
  ), true)
  assert.equal(gitBranchSyncExecutionMatchesPreview(
    { ...pushResult, push: { status: 'succeeded', remote: '', branch: '' } },
    buildGitBranchSyncDialogPreview('push', view),
    { action: 'push' },
    snapshot
  ), false)
  assert.equal(gitBranchSyncExecutionMatchesPreview(
    { ...pushResult, postView: { ...succeededPostView, snapshot: { ...snapshot, repositoryRoot: '/other' } } },
    buildGitBranchSyncDialogPreview('push', view),
    { action: 'push' },
    snapshot
  ), false)
})

test('execution result keeps fetch success separate from ff-only failure and post-view', () => {
  const mapped = mapGitBranchSyncExecutionResult({
    action: 'pull',
    branch: null,
    fetch: { status: 'succeeded', remote: 'origin' },
    fastForward: {
      status: 'failed',
      branch: 'main',
      error: { code: 'git-error', message: 'Not possible to fast-forward.', stderrCharacters: 0 }
    },
    push: null,
    postView: prepared()
  }, null)
  assert.equal(mapped.overall, 'partial')
  assert.equal(mapped.fetch?.status, 'succeeded')
  assert.equal(mapped.fastForward?.status, 'failed')
  assert.equal(mapped.postView?.status, 'succeeded')
})
