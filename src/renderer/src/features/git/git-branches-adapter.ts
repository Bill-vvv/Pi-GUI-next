import type {
  GitBranchMutationWarning,
  GitBranchSyncExecutionRequest,
  GitBranchSyncExecutionResult,
  GitBranchSyncPrepareResult,
  GitBranchSyncPushStep,
  GitBranchSyncSnapshot,
  GitNetworkRemoteStep,
  GitRepositoryState
} from '../../../../shared/git-contract.ts'
import { gitErrorText } from './git-changes-model.ts'
import {
  createDisabledGitBranchesActions,
  createEmptyGitBranchesDraft,
  type GitBranchSyncAction,
  type GitBranchSyncConfirmPayload,
  type GitBranchSyncDialogPreview,
  type GitBranchSyncDialogResult,
  type GitBranchSyncStepResult,
  type GitBranchesActionGate,
  type GitBranchesDraftViewModel,
  type GitBranchesListStatus,
  type GitBranchesRemoteGroup
} from './git-branches-model.ts'

export function gitBranchSyncSnapshotMatchesState(
  snapshot: GitBranchSyncSnapshot | null,
  state: GitRepositoryState | null
): boolean {
  return snapshot !== null &&
    state !== null &&
    state.kind === 'repository' &&
    state.repositoryRoot === snapshot.repositoryRoot &&
    state.headOid === snapshot.headOid &&
    state.branch === snapshot.branch &&
    state.indexTreeOid === snapshot.indexTreeOid &&
    state.indexFingerprint === snapshot.indexFingerprint &&
    state.worktreeFingerprint === snapshot.worktreeFingerprint &&
    state.statusRevision === snapshot.statusRevision
}

export function gitBranchesStatusForFailure(code: string): GitBranchesListStatus {
  if (code === 'stale') return 'stale'
  if (code === 'not-repository') return 'not-repository'
  if (code === 'trust-required') return 'trust-required'
  return 'error'
}

export function mapGitBranchSyncPrepareResult(
  result: GitBranchSyncPrepareResult
): { snapshot: GitBranchSyncSnapshot | null; view: GitBranchesDraftViewModel } {
  if (!result.ok) {
    return {
      snapshot: null,
      view: {
        ...createEmptyGitBranchesDraft(),
        listStatus: gitBranchesStatusForFailure(result.error.code),
        listError: gitErrorText(result.error),
        actions: createDisabledGitBranchesActions(gitErrorText(result.error))
      }
    }
  }

  const currentBranchLabel = result.current.detached
    ? `Detached @ ${shortOid(result.current.headOid)}`
    : result.current.branch ?? '尚无分支'
  const upstreamText = result.current.upstream ?? (
    result.current.upstreamRemote === null || result.current.upstreamBranch === null
      ? null
      : `${result.current.upstreamRemote}/${result.current.upstreamBranch}`
  )
  const localBranches = result.localBranches.map((branch) => ({
    branchId: branch.branchId,
    name: branch.name,
    isCurrent: branch.isCurrent,
    upstreamText: branch.isCurrent ? upstreamText : null
  }))
  const remotesByLongestName = [...result.remotes].sort((left, right) => right.name.length - left.name.length)
  const grouped = new Map<string, Array<{ branchId: string; name: string }>>()
  const unmatched: Array<{ branchId: string; name: string }> = []
  for (const branch of result.remoteTrackingBranches) {
    const remote = remotesByLongestName.find((candidate) => branch.name.startsWith(`${candidate.name}/`))
    if (remote === undefined) {
      unmatched.push({ branchId: branch.branchId, name: branch.name })
      continue
    }
    const branches = grouped.get(remote.remoteId) ?? []
    branches.push({ branchId: branch.branchId, name: branch.name.slice(remote.name.length + 1) })
    grouped.set(remote.remoteId, branches)
  }
  const remoteGroups: GitBranchesRemoteGroup[] = result.remotes.map((remote) => ({
    remoteId: remote.remoteId,
    name: remote.name,
    branches: grouped.get(remote.remoteId) ?? [],
    truncated: false
  }))
  if (unmatched.length > 0) {
    remoteGroups.push({
      remoteId: 'unmatched-remote-tracking',
      name: '其他 tracking refs',
      branches: unmatched,
      truncated: false
    })
  }

  const actionReason = branchActionReason(result)
  const actionGate = (enabled: boolean, action: GitBranchSyncAction): GitBranchesActionGate => ({
    enabled,
    reason: enabled ? null : actionReason(action)
  })
  const selectedLocalBranchId = localBranches.find((branch) => !branch.isCurrent)?.branchId ?? null
  const selectedRemoteId = result.remotes[0]?.remoteId ?? null
  return {
    snapshot: result.snapshot,
    view: {
      listStatus: 'ready',
      listError: null,
      headKind: result.current.detached
        ? 'detached'
        : result.current.unborn
          ? 'unborn'
          : 'named',
      currentBranchLabel,
      upstreamText,
      ahead: result.current.ahead,
      behind: result.current.behind,
      localBranches,
      localTruncated: result.localBranchesTruncated,
      remoteGroups,
      trackingTruncated: result.remoteTrackingBranchesTruncated,
      remotes: result.remotes.map((remote) => ({ remoteId: remote.remoteId, name: remote.name })),
      remotesTruncated: result.remotesTruncated,
      actions: {
        create: actionGate(result.actions.canCreate, 'create'),
        switch: actionGate(result.actions.canSwitch && selectedLocalBranchId !== null, 'switch'),
        fetch: actionGate(result.actions.canFetch && selectedRemoteId !== null, 'fetch'),
        pull: actionGate(result.actions.canPull, 'pull'),
        push: actionGate(result.actions.canPush, 'push')
      },
      selectedLocalBranchId,
      selectedRemoteId
    }
  }
}

export function buildGitBranchSyncDialogPreview(
  action: GitBranchSyncAction,
  view: GitBranchesDraftViewModel
): GitBranchSyncDialogPreview {
  return {
    action,
    currentBranchLabel: view.currentBranchLabel,
    suggestedBranchName: '',
    localBranchOptions: view.localBranches
      .filter((branch) => !branch.isCurrent)
      .map((branch) => ({
        id: branch.branchId,
        label: branch.name,
        detail: branch.upstreamText ?? undefined
      })),
    selectedBranchId: view.selectedLocalBranchId,
    remoteOptions: view.remotes.map((remote) => ({ id: remote.remoteId, label: remote.name })),
    selectedRemoteId: view.selectedRemoteId,
    upstreamLabel: view.upstreamText,
    blockedReason: view.actions[action].reason
  }
}

export function buildGitBranchSyncExecutionRequest(
  payload: GitBranchSyncConfirmPayload,
  snapshot: GitBranchSyncSnapshot
): GitBranchSyncExecutionRequest {
  switch (payload.action) {
    case 'create':
      return { action: 'create-and-switch', snapshot, name: payload.branchName }
    case 'switch':
      return { action: 'switch', snapshot, branchId: payload.branchId }
    case 'fetch':
      return { action: 'fetch', snapshot, remoteId: payload.remoteId }
    case 'pull':
      return { action: 'pull', snapshot }
    case 'push':
      return { action: 'push', snapshot }
  }
}

function successfulPostViewIsInternallyConsistent(
  postView: GitBranchSyncExecutionResult['postView'],
  snapshot: GitBranchSyncSnapshot
): boolean {
  if (!postView.ok) return true
  return postView.snapshot.repositoryRoot === snapshot.repositoryRoot &&
    postView.current.branch === postView.snapshot.branch &&
    postView.current.headOid === postView.snapshot.headOid &&
    postView.current.upstreamRemote === postView.snapshot.upstreamRemote &&
    postView.current.upstreamBranch === postView.snapshot.upstreamBranch
}

function successfulPostViewKeepsLocalSnapshot(
  postView: GitBranchSyncExecutionResult['postView'],
  snapshot: GitBranchSyncSnapshot
): boolean {
  if (!postView.ok) return true
  return postView.snapshot.headOid === snapshot.headOid &&
    postView.snapshot.branch === snapshot.branch &&
    postView.snapshot.indexTreeOid === snapshot.indexTreeOid &&
    postView.snapshot.indexFingerprint === snapshot.indexFingerprint &&
    postView.snapshot.worktreeFingerprint === snapshot.worktreeFingerprint &&
    postView.snapshot.upstreamRemote === snapshot.upstreamRemote &&
    postView.snapshot.upstreamBranch === snapshot.upstreamBranch
}

export function gitBranchSyncExecutionMatchesPreview(
  result: GitBranchSyncExecutionResult,
  preview: GitBranchSyncDialogPreview,
  payload: GitBranchSyncConfirmPayload,
  snapshot: GitBranchSyncSnapshot
): boolean {
  const expectedAction = payload.action === 'create' ? 'create-and-switch' : payload.action
  if (result.action !== expectedAction) return false
  if (!successfulPostViewIsInternallyConsistent(result.postView, snapshot)) return false

  if (payload.action === 'create' || payload.action === 'switch') {
    if (result.branch === null || result.fetch !== null || result.fastForward !== null || result.push !== null) return false
    const expectedBranch = payload.action === 'create'
      ? payload.branchName.trim()
      : preview.localBranchOptions.find((branch) => branch.id === payload.branchId)?.label ?? null
    if (expectedBranch === null || expectedBranch.length === 0) return false
    if (result.branch.status === 'succeeded' && result.branch.branch !== expectedBranch) return false
    if (
      result.branch.status === 'succeeded' &&
      result.postView.ok &&
      (result.postView.snapshot.branch !== expectedBranch || result.postView.snapshot.headOid !== result.branch.headOid)
    ) return false
    if (result.branch.status === 'failed' && !successfulPostViewKeepsLocalSnapshot(result.postView, snapshot)) return false
    return true
  }

  if (payload.action === 'fetch') {
    if (result.branch !== null || result.fetch === null || result.fastForward !== null || result.push !== null) return false
    const expectedRemote = preview.remoteOptions.find((remote) => remote.id === payload.remoteId)?.label ?? null
    if (expectedRemote === null || !remoteStepMatches(result.fetch, expectedRemote)) return false
    return successfulPostViewKeepsLocalSnapshot(result.postView, snapshot)
  }

  if (payload.action === 'pull') {
    if (result.branch !== null || result.fetch === null || result.push !== null) return false
    if (snapshot.branch === null || snapshot.upstreamRemote === null) return false
    if (!remoteStepMatches(result.fetch, snapshot.upstreamRemote)) return false
    if (result.fetch.status === 'succeeded') {
      if (result.fastForward === null || result.fastForward.branch !== snapshot.branch) return false
    } else if (result.fastForward !== null) {
      return false
    }
    if (
      result.fastForward?.status === 'succeeded' &&
      result.postView.ok &&
      (result.postView.snapshot.branch !== snapshot.branch || result.postView.snapshot.headOid !== result.fastForward.toOid)
    ) return false
    if (result.fastForward?.status !== 'succeeded' && !successfulPostViewKeepsLocalSnapshot(result.postView, snapshot)) return false
    return true
  }

  if (result.branch !== null || result.fetch !== null || result.fastForward !== null || result.push === null) return false
  if (snapshot.upstreamRemote === null || snapshot.upstreamBranch === null) return false
  if (!pushStepMatches(result.push, snapshot.upstreamRemote, snapshot.upstreamBranch)) return false
  return successfulPostViewKeepsLocalSnapshot(result.postView, snapshot)
}

export function mapGitBranchSyncExecutionResult(
  result: GitBranchSyncExecutionResult,
  refreshError: string | null
): GitBranchSyncDialogResult {
  const branch = result.branch === null
    ? null
    : result.branch.status === 'succeeded'
      ? {
          status: 'succeeded' as const,
          detail: [
            `${result.branch.branch} @ ${shortOid(result.branch.headOid)}`,
            branchWarningsText(result.branch.warnings)
          ].filter((value): value is string => value !== null).join('；')
        }
      : { status: 'failed' as const, detail: gitErrorText(result.branch.error) }
  const fetch = result.fetch === null
    ? null
    : {
        status: result.fetch.status,
        detail: result.fetch.status === 'succeeded'
          ? result.fetch.remote
          : `${result.fetch.remote || 'remote'}：${gitErrorText(result.fetch.error)}`
      }
  const fastForward = result.fastForward === null
    ? null
    : result.fastForward.status === 'succeeded'
      ? {
          status: 'succeeded' as const,
          detail: [
            result.fastForward.alreadyUpToDate
              ? `${result.fastForward.branch} 已是最新`
              : `${shortOid(result.fastForward.fromOid)} → ${shortOid(result.fastForward.toOid)}`,
            ...result.fastForward.warnings.map(gitBranchWarningText)
          ].join('；')
        }
      : { status: 'failed' as const, detail: gitErrorText(result.fastForward.error) }
  const push = result.push === null
    ? null
    : {
        status: result.push.status,
        detail: result.push.status === 'succeeded'
          ? `${result.push.remote}/${result.push.branch}`
          : `${result.push.remote && result.push.branch
              ? `${result.push.remote}/${result.push.branch}`
              : 'upstream'}：${gitErrorText(result.push.error)}`
      }
  const postView: GitBranchSyncStepResult = !result.postView.ok
    ? { status: 'failed', detail: gitErrorText(result.postView.error) }
    : refreshError === null
      ? { status: 'succeeded' }
      : { status: 'failed', detail: refreshError }
  const steps: GitBranchSyncStepResult[] = []
  if (branch !== null) steps.push(branch)
  if (fetch !== null) steps.push(fetch)
  if (fastForward !== null) steps.push(fastForward)
  if (push !== null) steps.push(push)
  const hasSucceeded = steps.some((step) => step.status === 'succeeded')
  const hasFailed = steps.some((step) => step.status === 'failed') || postView.status === 'failed'
  const hasUnknown = steps.some((step) => step.status === 'unknown')
  const overall = hasSucceeded && (hasFailed || hasUnknown)
    ? 'partial'
    : hasUnknown
      ? 'unknown'
      : hasFailed
        ? 'failed'
        : 'success'
  return { overall, branch, fetch, fastForward, push, postView }
}

export function gitBranchSyncInvocationFailure(action: GitBranchSyncAction): GitBranchSyncDialogResult {
  const failure: GitBranchSyncStepResult = { status: 'failed', detail: 'Renderer 无法调用 Git 服务。' }
  return {
    overall: 'failed',
    branch: action === 'create' || action === 'switch' ? failure : null,
    fetch: action === 'fetch' || action === 'pull' ? failure : null,
    fastForward: null,
    push: action === 'push' ? failure : null,
    postView: { status: 'failed', detail: '未能读取最新分支状态。' }
  }
}

function branchActionReason(result: Extract<GitBranchSyncPrepareResult, { ok: true }>): (action: GitBranchSyncAction) => string {
  return (action) => {
    if (action === 'fetch' && result.remotes.length === 0) return '没有可用的配置 remote。'
    if ((action === 'pull' || action === 'push') && result.current.upstreamRemote === null) {
      return '当前分支没有可用 upstream。'
    }
    if (result.current.detached) return 'Detached HEAD 不支持此操作。'
    if (result.current.unborn) return '尚无 commit，不能执行此操作。'
    if (result.current.conflicted) return '存在未解决冲突。'
    if (result.current.truncated) return 'Git 状态已截断，请先缩小变更范围。'
    if (!result.current.clean && action !== 'fetch' && action !== 'push') return '需要 clean index 与 worktree。'
    if (action === 'switch' && result.localBranches.filter((branch) => !branch.isCurrent).length === 0) {
      return '没有其他可切换的本地分支。'
    }
    return '当前 repository 状态不支持此操作。'
  }
}

function remoteStepMatches(step: GitNetworkRemoteStep, expectedRemote: string): boolean {
  return step.remote === expectedRemote || (step.status === 'failed' && step.remote.length === 0)
}

function pushStepMatches(
  step: GitBranchSyncPushStep,
  expectedRemote: string,
  expectedBranch: string
): boolean {
  return (step.remote === expectedRemote && step.branch === expectedBranch) ||
    (step.status === 'failed' && step.remote.length === 0 && step.branch.length === 0)
}

function shortOid(oid: string | null): string {
  return oid === null ? 'unknown' : oid.slice(0, 8)
}

function gitBranchWarningText(warning: GitBranchMutationWarning): string {
  return warning === 'command-error-after-landing'
    ? 'Git 命令报告异常，但已确认操作落地'
    : '操作已返回成功，但落地核验不可用'
}

function branchWarningsText(warnings: readonly GitBranchMutationWarning[]): string | null {
  if (warnings.length === 0) return null
  return warnings.map(gitBranchWarningText).join('；')
}
