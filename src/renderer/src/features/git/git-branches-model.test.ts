import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createDisabledGitBranchesActions,
  createEmptyGitBranchesDraft,
  gitBranchesAheadBehindText,
  gitBranchesListStatusText,
  gitBranchesLocalAccessibleName,
  gitBranchesPanelActionDisabled,
  gitBranchesSelectLocalBranch,
  gitBranchesSelectRemote,
  gitBranchesUpstreamSummary,
  gitBranchSyncActionDisabled,
  gitBranchSyncBuildConfirmPayload,
  gitBranchSyncOverallLabel,
  gitBranchSyncResultTone,
  gitBranchSyncShouldShowPostView,
  gitBranchSyncStepLabel,
  isGitBranchNameSubmittable
} from './git-branches-model.ts'

test('empty draft starts loading with all actions disabled', () => {
  const draft = createEmptyGitBranchesDraft()
  assert.equal(draft.listStatus, 'loading')
  assert.equal(draft.localBranches.length, 0)
  assert.equal(draft.remoteGroups.length, 0)
  assert.equal(draft.actions.create.enabled, false)
  assert.equal(draft.actions.push.enabled, false)
  assert.deepEqual(
    createDisabledGitBranchesActions('blocked'),
    {
      create: { enabled: false, reason: 'blocked' },
      switch: { enabled: false, reason: 'blocked' },
      fetch: { enabled: false, reason: 'blocked' },
      pull: { enabled: false, reason: 'blocked' },
      push: { enabled: false, reason: 'blocked' }
    }
  )
})

test('status, summary and selection helpers stay UI-facing', () => {
  assert.equal(gitBranchesListStatusText('loading', null), '正在读取分支与同步状态…')
  assert.equal(gitBranchesListStatusText('error', 'boom'), 'boom')
  assert.equal(gitBranchesListStatusText('stale', null), 'Repository 或 HEAD 已变化，请重新加载分支状态。')
  assert.equal(gitBranchesListStatusText('trust-required', null), 'Repository 授权已经失效，请切换到 Changes 并重新允许。')

  assert.equal(gitBranchesAheadBehindText(0, 0), '已同步')
  assert.equal(gitBranchesAheadBehindText(2, 1), '领先 2 · 落后 1')
  assert.equal(gitBranchesAheadBehindText(null, 0), '领先/落后不可用')
  assert.equal(
    gitBranchesUpstreamSummary('origin/main', 1, 0),
    'origin/main · 领先 1 · 落后 0'
  )
  assert.equal(gitBranchesUpstreamSummary(null, 0, 0), '未设置 upstream')

  const branch = {
    branchId: 'b1',
    name: 'feature',
    isCurrent: true,
    upstreamText: 'origin/feature'
  }
  assert.equal(
    gitBranchesLocalAccessibleName(branch),
    'feature，当前分支，upstream origin/feature'
  )
  assert.equal(
    gitBranchesLocalAccessibleName({ ...branch, isCurrent: false, upstreamText: null }),
    'feature，无 upstream'
  )

  let draft = createEmptyGitBranchesDraft()
  draft = { ...draft, listStatus: 'ready' }
  draft = gitBranchesSelectLocalBranch(draft, 'local-1')
  assert.equal(draft.selectedLocalBranchId, 'local-1')
  assert.equal(gitBranchesSelectLocalBranch(draft, 'local-1'), draft)
  draft = gitBranchesSelectRemote(draft, 'remote-1')
  assert.equal(draft.selectedRemoteId, 'remote-1')
  assert.equal(gitBranchesPanelActionDisabled({ enabled: true, reason: null }, true), true)
  assert.equal(gitBranchesPanelActionDisabled({ enabled: false, reason: 'x' }, false), true)
  assert.equal(gitBranchesPanelActionDisabled({ enabled: true, reason: null }, false), false)
})

test('dialog pure helpers gate create/switch/fetch and keep step semantics independent', () => {
  assert.equal(isGitBranchNameSubmittable('  '), false)
  assert.equal(isGitBranchNameSubmittable('feature/x'), true)

  assert.equal(gitBranchSyncActionDisabled('create', {
    busy: false,
    blockedReason: null,
    branchName: '  ',
    selectedBranchId: null,
    selectedRemoteId: null,
    operationSettled: false
  }), true)
  assert.equal(gitBranchSyncActionDisabled('switch', {
    busy: false,
    blockedReason: null,
    branchName: '',
    selectedBranchId: null,
    selectedRemoteId: null,
    operationSettled: false
  }), true)
  assert.equal(gitBranchSyncActionDisabled('fetch', {
    busy: false,
    blockedReason: null,
    branchName: '',
    selectedBranchId: null,
    selectedRemoteId: 'r1',
    operationSettled: false
  }), false)
  assert.equal(gitBranchSyncActionDisabled('pull', {
    busy: false,
    blockedReason: 'dirty',
    branchName: '',
    selectedBranchId: null,
    selectedRemoteId: null,
    operationSettled: false
  }), true)
  assert.equal(gitBranchSyncActionDisabled('push', {
    busy: false,
    blockedReason: null,
    branchName: '',
    selectedBranchId: null,
    selectedRemoteId: null,
    operationSettled: true
  }), true)

  assert.deepEqual(
    gitBranchSyncBuildConfirmPayload('create', {
      branchName: '  feat  ',
      selectedBranchId: null,
      selectedRemoteId: null
    }),
    { action: 'create', branchName: 'feat' }
  )
  assert.deepEqual(
    gitBranchSyncBuildConfirmPayload('switch', {
      branchName: '',
      selectedBranchId: 'b1',
      selectedRemoteId: null
    }),
    { action: 'switch', branchId: 'b1' }
  )
  assert.deepEqual(
    gitBranchSyncBuildConfirmPayload('fetch', {
      branchName: '',
      selectedBranchId: null,
      selectedRemoteId: 'origin'
    }),
    { action: 'fetch', remoteId: 'origin' }
  )
  assert.deepEqual(
    gitBranchSyncBuildConfirmPayload('pull', {
      branchName: '',
      selectedBranchId: null,
      selectedRemoteId: null
    }),
    { action: 'pull' }
  )
  assert.deepEqual(
    gitBranchSyncBuildConfirmPayload('push', {
      branchName: '',
      selectedBranchId: null,
      selectedRemoteId: null
    }),
    { action: 'push' }
  )
  assert.equal(
    gitBranchSyncBuildConfirmPayload('create', {
      branchName: '   ',
      selectedBranchId: null,
      selectedRemoteId: null
    }),
    null
  )

  assert.equal(gitBranchSyncStepLabel('branch', 'succeeded'), '分支操作成功')
  assert.equal(gitBranchSyncStepLabel('fetch', 'unknown'), 'Fetch 结果未知')
  assert.equal(gitBranchSyncStepLabel('fast-forward', 'failed'), 'Fast-forward 失败')
  assert.equal(gitBranchSyncStepLabel('push', 'skipped'), '已跳过 Push')
  assert.equal(gitBranchSyncStepLabel('post-view', 'failed'), '状态刷新失败')
  assert.equal(gitBranchSyncOverallLabel('partial'), '部分成功')
  assert.equal(gitBranchSyncOverallLabel('unknown'), '结果未知')
  assert.equal(gitBranchSyncResultTone('succeeded'), 'success')
  assert.equal(gitBranchSyncResultTone('failed'), 'error')
  assert.equal(gitBranchSyncResultTone('unknown'), 'warning')
  assert.equal(gitBranchSyncResultTone('partial'), 'warning')
  assert.equal(gitBranchSyncResultTone('skipped'), 'muted')
  assert.notEqual(gitBranchSyncResultTone('succeeded'), gitBranchSyncResultTone('failed'))
  assert.equal(gitBranchSyncShouldShowPostView({ status: 'failed', detail: 'stale' }), true)
  assert.equal(gitBranchSyncShouldShowPostView({ status: 'succeeded' }), true)
  assert.equal(gitBranchSyncShouldShowPostView(null), false)
})
