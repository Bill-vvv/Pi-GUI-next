export type GitBranchesListStatus =
  | 'loading'
  | 'ready'
  | 'error'
  | 'stale'
  | 'not-repository'
  | 'trust-required'

export type GitBranchesHeadKind = 'named' | 'detached' | 'unborn'

export type GitBranchesLocalBranch = {
  branchId: string
  name: string
  isCurrent: boolean
  upstreamText: string | null
}

export type GitBranchesRemoteTrackingBranch = {
  branchId: string
  name: string
}

export type GitBranchesRemoteGroup = {
  remoteId: string
  name: string
  branches: readonly GitBranchesRemoteTrackingBranch[]
  truncated: boolean
}

export type GitBranchesRemote = {
  remoteId: string
  name: string
}

export type GitBranchesActionGate = {
  enabled: boolean
  reason: string | null
}

export type GitBranchesActionGates = {
  create: GitBranchesActionGate
  switch: GitBranchesActionGate
  fetch: GitBranchesActionGate
  pull: GitBranchesActionGate
  push: GitBranchesActionGate
}

export type GitBranchesDraftViewModel = {
  listStatus: GitBranchesListStatus
  listError: string | null
  headKind: GitBranchesHeadKind
  currentBranchLabel: string
  upstreamText: string | null
  ahead: number | null
  behind: number | null
  localBranches: readonly GitBranchesLocalBranch[]
  localTruncated: boolean
  remoteGroups: readonly GitBranchesRemoteGroup[]
  trackingTruncated: boolean
  remotes: readonly GitBranchesRemote[]
  remotesTruncated: boolean
  actions: GitBranchesActionGates
  selectedLocalBranchId: string | null
  selectedRemoteId: string | null
}

export type GitBranchSyncAction = 'create' | 'switch' | 'fetch' | 'pull' | 'push'

export type GitBranchSyncDialogOption = {
  id: string
  label: string
  detail?: string
  disabled?: boolean
}

export type GitBranchSyncDialogPreview = {
  action: GitBranchSyncAction
  currentBranchLabel: string
  suggestedBranchName: string
  localBranchOptions: readonly GitBranchSyncDialogOption[]
  selectedBranchId: string | null
  remoteOptions: readonly GitBranchSyncDialogOption[]
  selectedRemoteId: string | null
  upstreamLabel: string | null
  blockedReason: string | null
}

export type GitBranchSyncStepStatus = 'succeeded' | 'failed' | 'unknown' | 'skipped'

export type GitBranchSyncStepResult = {
  status: GitBranchSyncStepStatus
  detail?: string | null
}

export type GitBranchSyncOverallStatus = 'success' | 'failed' | 'unknown' | 'partial'

export type GitBranchSyncDialogResult = {
  overall: GitBranchSyncOverallStatus
  branch?: GitBranchSyncStepResult | null
  fetch?: GitBranchSyncStepResult | null
  fastForward?: GitBranchSyncStepResult | null
  push?: GitBranchSyncStepResult | null
  postView?: GitBranchSyncStepResult | null
}

export type GitBranchSyncConfirmPayload =
  | { action: 'create'; branchName: string }
  | { action: 'switch'; branchId: string }
  | { action: 'fetch'; remoteId: string }
  | { action: 'pull' }
  | { action: 'push' }

export type GitBranchSyncDialogState = {
  preview: GitBranchSyncDialogPreview
  busy: boolean
  result: GitBranchSyncDialogResult | null
}

export function createEmptyGitBranchesDraft(): GitBranchesDraftViewModel {
  return {
    listStatus: 'loading',
    listError: null,
    headKind: 'unborn',
    currentBranchLabel: '尚无分支',
    upstreamText: null,
    ahead: null,
    behind: null,
    localBranches: [],
    localTruncated: false,
    remoteGroups: [],
    trackingTruncated: false,
    remotes: [],
    remotesTruncated: false,
    actions: {
      create: { enabled: false, reason: null },
      switch: { enabled: false, reason: null },
      fetch: { enabled: false, reason: null },
      pull: { enabled: false, reason: null },
      push: { enabled: false, reason: null }
    },
    selectedLocalBranchId: null,
    selectedRemoteId: null
  }
}

export function createDisabledGitBranchesActions(
  reason: string | null = null
): GitBranchesActionGates {
  return {
    create: { enabled: false, reason },
    switch: { enabled: false, reason },
    fetch: { enabled: false, reason },
    pull: { enabled: false, reason },
    push: { enabled: false, reason }
  }
}

export function gitBranchesListStatusText(
  status: GitBranchesListStatus,
  errorText: string | null
): string {
  switch (status) {
    case 'loading':
      return '正在读取分支与同步状态…'
    case 'ready':
      return ''
    case 'error':
      return errorText ?? '无法读取分支与同步状态。'
    case 'stale':
      return 'Repository 或 HEAD 已变化，请重新加载分支状态。'
    case 'not-repository':
      return '当前 Project 不再属于 Git repository。'
    case 'trust-required':
      return 'Repository 授权已经失效，请切换到 Changes 并重新允许。'
  }
}

export function gitBranchesAheadBehindText(
  ahead: number | null,
  behind: number | null
): string {
  if (ahead === null || behind === null) return '领先/落后不可用'
  if (ahead === 0 && behind === 0) return '已同步'
  return `领先 ${ahead} · 落后 ${behind}`
}

export function gitBranchesUpstreamSummary(
  upstreamText: string | null,
  ahead: number | null,
  behind: number | null
): string {
  if (upstreamText === null) return '未设置 upstream'
  return `${upstreamText} · ${gitBranchesAheadBehindText(ahead, behind)}`
}

export function gitBranchesLocalAccessibleName(branch: GitBranchesLocalBranch): string {
  const current = branch.isCurrent ? '，当前分支' : ''
  const upstream = branch.upstreamText === null ? '，无 upstream' : `，upstream ${branch.upstreamText}`
  return `${branch.name}${current}${upstream}`
}

export function gitBranchSyncActionTitle(action: GitBranchSyncAction): string {
  switch (action) {
    case 'create':
      return '创建并切换分支'
    case 'switch':
      return '切换分支'
    case 'fetch':
      return 'Fetch'
    case 'pull':
      return 'Pull'
    case 'push':
      return 'Push'
  }
}

export function gitBranchSyncActionDescription(action: GitBranchSyncAction): string {
  switch (action) {
    case 'create':
      return '将从确认时的当前 HEAD 创建新的本地分支并立即切换。工作区必须干净，且不会自动建立 remote tracking。'
    case 'switch':
      return '将切换到已存在的本地分支。工作区必须干净，且不会自动 stash、force checkout 或恢复。'
    case 'fetch':
      return '将只从你选择的一个 remote 拉取 remote-tracking 更新，不会修改 HEAD、index 或 worktree。'
    case 'pull':
      return '将先 fetch 当前 upstream remote，再尝试把当前分支 fast-forward 到重新解析后的 upstream。不会 merge、rebase 或 autostash。'
    case 'push':
      return '将只推送当前分支到已配置的精确 upstream，不会 set-upstream、force 或自动 pull。'
  }
}

export function gitBranchSyncConfirmLabel(action: GitBranchSyncAction): string {
  switch (action) {
    case 'create':
      return '创建并切换'
    case 'switch':
      return '切换'
    case 'fetch':
      return 'Fetch'
    case 'pull':
      return 'Pull'
    case 'push':
      return 'Push'
  }
}

export function isGitBranchNameSubmittable(name: string): boolean {
  return name.trim().length > 0
}

export function gitBranchSyncActionDisabled(
  action: GitBranchSyncAction,
  {
    busy,
    blockedReason,
    branchName,
    selectedBranchId,
    selectedRemoteId,
    operationSettled
  }: {
    busy: boolean
    blockedReason: string | null
    branchName: string
    selectedBranchId: string | null
    selectedRemoteId: string | null
    operationSettled: boolean
  }
): boolean {
  if (busy || operationSettled || blockedReason !== null) return true
  if (action === 'create') return !isGitBranchNameSubmittable(branchName)
  if (action === 'switch') return selectedBranchId === null || selectedBranchId.length === 0
  if (action === 'fetch') return selectedRemoteId === null || selectedRemoteId.length === 0
  return false
}

export function gitBranchSyncResultTone(
  status: GitBranchSyncStepStatus | GitBranchSyncOverallStatus
): 'success' | 'error' | 'warning' | 'muted' {
  switch (status) {
    case 'succeeded':
    case 'success':
      return 'success'
    case 'failed':
      return 'error'
    case 'unknown':
    case 'partial':
      return 'warning'
    case 'skipped':
      return 'muted'
  }
}

export function gitBranchSyncStepLabel(
  kind: 'branch' | 'fetch' | 'fast-forward' | 'push' | 'post-view',
  status: GitBranchSyncStepStatus
): string {
  if (kind === 'branch') {
    if (status === 'succeeded') return '分支操作成功'
    if (status === 'failed') return '分支操作失败'
    if (status === 'unknown') return '分支操作结果未知'
    return '已跳过分支操作'
  }
  if (kind === 'fetch') {
    if (status === 'succeeded') return 'Fetch 成功'
    if (status === 'failed') return 'Fetch 失败'
    if (status === 'unknown') return 'Fetch 结果未知'
    return '已跳过 Fetch'
  }
  if (kind === 'fast-forward') {
    if (status === 'succeeded') return 'Fast-forward 成功'
    if (status === 'failed') return 'Fast-forward 失败'
    if (status === 'unknown') return 'Fast-forward 结果未知'
    return '已跳过 Fast-forward'
  }
  if (kind === 'push') {
    if (status === 'succeeded') return 'Push 成功'
    if (status === 'failed') return 'Push 失败'
    if (status === 'unknown') return 'Push 结果未知'
    return '已跳过 Push'
  }
  if (status === 'succeeded') return '状态已刷新'
  if (status === 'failed') return '状态刷新失败'
  if (status === 'unknown') return '状态刷新结果未知'
  return '已跳过状态刷新'
}

export function gitBranchSyncOverallLabel(status: GitBranchSyncOverallStatus): string {
  switch (status) {
    case 'success':
      return '操作成功'
    case 'failed':
      return '操作失败'
    case 'unknown':
      return '结果未知'
    case 'partial':
      return '部分成功'
  }
}

export function gitBranchSyncShouldShowPostView(
  postView: GitBranchSyncStepResult | null | undefined
): boolean {
  return postView != null && postView.status !== 'skipped'
}

export function gitBranchSyncBuildConfirmPayload(
  action: GitBranchSyncAction,
  {
    branchName,
    selectedBranchId,
    selectedRemoteId
  }: {
    branchName: string
    selectedBranchId: string | null
    selectedRemoteId: string | null
  }
): GitBranchSyncConfirmPayload | null {
  if (action === 'create') {
    const trimmed = branchName.trim()
    if (trimmed.length === 0) return null
    return { action: 'create', branchName: trimmed }
  }
  if (action === 'switch') {
    if (selectedBranchId === null || selectedBranchId.length === 0) return null
    return { action: 'switch', branchId: selectedBranchId }
  }
  if (action === 'fetch') {
    if (selectedRemoteId === null || selectedRemoteId.length === 0) return null
    return { action: 'fetch', remoteId: selectedRemoteId }
  }
  if (action === 'pull') return { action: 'pull' }
  return { action: 'push' }
}

export function gitBranchesSelectLocalBranch(
  current: GitBranchesDraftViewModel,
  branchId: string
): GitBranchesDraftViewModel {
  if (current.selectedLocalBranchId === branchId) return current
  return { ...current, selectedLocalBranchId: branchId }
}

export function gitBranchesSelectRemote(
  current: GitBranchesDraftViewModel,
  remoteId: string
): GitBranchesDraftViewModel {
  if (current.selectedRemoteId === remoteId) return current
  return { ...current, selectedRemoteId: remoteId }
}

export function gitBranchesPanelActionDisabled(
  gate: GitBranchesActionGate,
  busy: boolean
): boolean {
  return busy || !gate.enabled
}
