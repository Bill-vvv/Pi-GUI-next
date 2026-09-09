import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'

import { Icon } from '../../components/Icon'
import { IconButton } from '../../components/IconButton'
import { Select } from '../../components/Select'
import {
  GIT_HISTORY_MAX_OFFSET,
  GIT_HISTORY_PAGE_SIZE,
  type GitBranchSyncExecutionRequest,
  type GitBranchSyncSnapshot,
  type GitCommitExecutionResult,
  type GitCommitMode,
  type GitCommitPreview,
  type GitCommitWarning,
  type GitDiffKind,
  type GitDiffRequest,
  type GitDiffResult,
  type GitFileChange,
  type GitFileMutationInput,
  type GitHistoryCommitSummary as GitHistoryCommitSummaryDto,
  type GitHistorySnapshot,
  type GitMutationResult,
  type GitRepositoryState
} from '../../../../shared/git-contract'
import {
  buildGitDiffRequest,
  buildGitMutationInput,
  gitActionsForScope,
  gitBranchLabel,
  gitChangeScopeCount,
  gitDiffKindsForFile,
  gitDiffKindsForScope,
  gitDiffResultInvalidatesSnapshot,
  gitErrorText,
  gitFileDisplayPath,
  gitFileMatchesScope,
  gitFileStateLabel,
  gitUpstreamLabel,
  isCurrentGitResponse,
  isDisplayedGitSnapshot,
  shouldCancelGitDiffPrefetch,
  type GitChangeScope,
  type GitFileAction
} from './git-changes-model'
import {
  GIT_DIFF_MAX_EXPANDED_FILES,
  GitDiffLruCache,
  GitDiffRequestPool,
  GitMutationGate,
  gitDiffCacheKey,
  gitRepositorySnapshotKey,
  isCacheableGitDiffResult,
  setBoundedGitDiffEntry
} from './git-diff-cache'
import {
  createEmptyGitHistoryDraft,
  gitHistoryClearSelection,
  gitHistorySelectCommit,
  gitHistoryToggleExpandedFile,
  gitPanelSubviewFromKey,
  GIT_HISTORY_SUBVIEWS,
  type GitHistoryCommitDetail as GitHistoryCommitDetailView,
  type GitHistoryCommitSummary as GitHistoryCommitSummaryView,
  type GitHistoryDraftViewModel,
  type GitHistoryListStatus,
  type GitPanelSubview
} from './git-history-model'
import {
  buildGitBranchSyncDialogPreview,
  buildGitBranchSyncExecutionRequest,
  gitBranchSyncExecutionMatchesPreview,
  gitBranchSyncInvocationFailure,
  gitBranchSyncSnapshotMatchesState,
  mapGitBranchSyncExecutionResult,
  mapGitBranchSyncPrepareResult
} from './git-branches-adapter'
import {
  createEmptyGitBranchesDraft,
  gitBranchesSelectLocalBranch,
  type GitBranchesDraftViewModel,
  type GitBranchSyncAction,
  type GitBranchSyncConfirmPayload,
  type GitBranchSyncDialogState
} from './git-branches-model'
import {
  GitCommitDialog,
  type GitCommitDialogResult
} from './GitCommitDialog'
import { GitBranchesPanel } from './GitBranchesPanel'
import { GitDiffViewer, type GitDiffViewerResult } from './GitDiffViewer'
import { GitHistoryPanel } from './GitHistoryPanel'
import './git-changes.css'

const RENDERER_GIT_INVOCATION_ERROR = 'Renderer 无法调用 Git 服务。请检查文件路径后重试。'
const GIT_DIFF_PREFETCH_DELAY_MS = 80
const gitMutationGate = new GitMutationGate()

type GitDiffBridgeResponse = Awaited<ReturnType<typeof window.piGit.getDiff>>

type PanelNotice = {
  projectKey: string
  tone: 'info' | 'error'
  text: string
}

type ExpandedDiff = {
  fileId: string
  kind: GitDiffKind
  requestToken: number
  loading: boolean
  result: GitDiffResult | null
  error: string | null
}

type CommitDialogState = {
  preview: GitCommitPreview
  busy: boolean
  result: GitCommitDialogResult | null
}

export function gitHistorySnapshotFromRepositoryState(
  state: GitRepositoryState | null
): GitHistorySnapshot | null {
  if (state === null || state.kind !== 'repository' || state.repositoryRoot === null) return null
  return {
    repositoryRoot: state.repositoryRoot,
    headOid: state.headOid,
    branch: state.branch
  }
}

export function gitHistorySnapshotsEqual(
  left: GitHistorySnapshot | null,
  right: GitHistorySnapshot | null
): boolean {
  return left === right || (
    left !== null &&
    right !== null &&
    left.repositoryRoot === right.repositoryRoot &&
    left.headOid === right.headOid &&
    left.branch === right.branch
  )
}

function gitHistoryStatusForFailure(code: string): GitHistoryListStatus {
  if (code === 'stale') return 'stale'
  if (code === 'not-repository') return 'not-repository'
  if (code === 'trust-required') return 'trust-required'
  return 'error'
}

function gitHistoryStatusForRepositoryState(state: GitRepositoryState | null): GitHistoryListStatus {
  if (state === null) return 'loading'
  if (state.kind === 'not-repository') return 'not-repository'
  if (state.kind === 'trust-required') return 'trust-required'
  return 'empty'
}

function mapGitHistoryCommitSummary(
  commit: GitHistoryCommitSummaryDto
): GitHistoryCommitSummaryView {
  return {
    oid: commit.oid,
    shortOid: commit.shortOid,
    subject: commit.subject,
    authorName: commit.authorName,
    authorEmail: commit.authorEmail.length === 0 ? null : commit.authorEmail,
    authoredAt: commit.authorAt,
    committerName: commit.committerName,
    committerEmail: commit.committerEmail.length === 0 ? null : commit.committerEmail,
    committedAt: commit.committerAt,
    parentOids: commit.parentOids
  }
}

export function gitCommitWarningsText(warnings: readonly GitCommitWarning[]): string | null {
  if (warnings.length === 0) return null
  const labels = warnings.map((warning) => {
    switch (warning) {
      case 'command-error-after-landing':
        return 'Git 命令报告异常，但已确认 commit 落地；不会重复提交'
      case 'confirmed-snapshot-diverged':
        return 'Hook 改变了最终 commit 内容，请复核该 commit'
      case 'verification-unavailable':
        return 'Commit 已落地，但结果核验未完成'
    }
  })
  return labels.join('；')
}

export function buildGitCommitDialogResult(
  result: GitCommitExecutionResult
): GitCommitDialogResult {
  const commit = result.commit.status === 'succeeded'
    ? {
        status: 'succeeded' as const,
        detail: [
          result.commit.oid === null ? null : `commit ${result.commit.oid.slice(0, 8)}`,
          gitCommitWarningsText(result.commit.warnings)
        ].filter((value): value is string => value !== null).join('；') || null
      }
    : {
        status: 'failed' as const,
        detail: gitErrorText(result.commit.error)
      }
  const push = result.push === null
    ? {
        status: 'skipped' as const,
        detail: result.commit.status === 'succeeded'
          ? '本次未请求推送。'
          : 'Commit 未完成，未执行 push。'
      }
    : result.push.status === 'succeeded'
      ? {
          status: 'succeeded' as const,
          detail: `${result.push.remote}/${result.push.branch}`
        }
      : {
          status: 'failed' as const,
          detail: gitErrorText(result.push.error)
        }
  return {
    commit,
    push,
    refresh: result.postState.ok
      ? { status: 'ok' }
      : { status: 'failed', detail: gitErrorText(result.postState.error) }
  }
}

function gitCommitInvocationFailure(): GitCommitDialogResult {
  return {
    commit: { status: 'failed', detail: RENDERER_GIT_INVOCATION_ERROR },
    push: { status: 'skipped', detail: 'Commit 未完成，未执行 push。' },
    refresh: { status: 'failed', detail: '未能读取最新 Git 状态。' }
  }
}

export function GitChangesPanel({
  projectKey
}: {
  projectKey: string
}): React.JSX.Element {
  const generatedId = useId().replace(/[^a-zA-Z0-9_-]/g, '') || 'git'
  const generationRef = useRef(0)
  const refreshTokenRef = useRef(0)
  const commitTokenRef = useRef(0)
  const historyListTokenRef = useRef(0)
  const historyDetailTokenRef = useRef(0)
  const historyDiffTokenRef = useRef(0)
  const historySnapshotRef = useRef<GitHistorySnapshot | null>(null)
  const branchPrepareTokenRef = useRef(0)
  const branchExecuteTokenRef = useRef(0)
  const branchSnapshotRef = useRef<GitBranchSyncSnapshot | null>(null)
  const diffEpochRef = useRef(0)
  const diffRequestTokenRef = useRef(0)
  const diffCacheRef = useRef(new GitDiffLruCache())
  const diffRequestsRef = useRef(new GitDiffRequestPool<GitDiffBridgeResponse>())
  const invalidationRefreshesRef = useRef(new GitDiffRequestPool<string | null>())
  const scheduledPrefetchRef = useRef<{ key: string; timer: number } | null>(null)
  const activePrefetchKeyRef = useRef<string | null>(null)
  const stateRef = useRef<GitRepositoryState | null>(null)
  const [state, setState] = useState<GitRepositoryState | null>(null)
  const [stateProjectKey, setStateProjectKey] = useState<string | null>(null)
  const visibleState = stateProjectKey === projectKey ? state : null
  const [initialError, setInitialError] = useState<string | null>(null)
  const [initialErrorProjectKey, setInitialErrorProjectKey] = useState<string | null>(null)
  const visibleInitialError = initialErrorProjectKey === projectKey ? initialError : null
  const [refreshing, setRefreshing] = useState(false)
  const [authorizing, setAuthorizing] = useState(false)
  const [scope, setScope] = useState<GitChangeScope>('all')
  const [expandedDiffs, setExpandedDiffs] = useState<ReadonlyMap<string, ExpandedDiff>>(() => new Map())
  const [pendingMutations, setPendingMutations] = useState<ReadonlySet<string>>(() => new Set())
  const [notice, setNotice] = useState<PanelNotice | null>(null)
  const [commitPreparing, setCommitPreparing] = useState(false)
  const [commitDialog, setCommitDialog] = useState<CommitDialogState | null>(null)
  const [subview, setSubview] = useState<GitPanelSubview>('changes')
  const [historyDraft, setHistoryDraft] = useState<GitHistoryDraftViewModel>(() => createEmptyGitHistoryDraft())
  const [branchesDraft, setBranchesDraft] = useState<GitBranchesDraftViewModel>(() => createEmptyGitBranchesDraft())
  const [branchPreparing, setBranchPreparing] = useState(false)
  const [branchDialog, setBranchDialog] = useState<GitBranchSyncDialogState | null>(null)
  const subviewTabRefs = useRef<Array<HTMLButtonElement | null>>([])

  const resetHistoryReadState = useCallback((nextState: GitRepositoryState | null): void => {
    historyListTokenRef.current += 1
    historyDetailTokenRef.current += 1
    historyDiffTokenRef.current += 1
    historySnapshotRef.current = null
    setHistoryDraft({
      ...createEmptyGitHistoryDraft(),
      listStatus: gitHistoryStatusForRepositoryState(nextState)
    })
  }, [])

  const cancelScheduledPrefetch = useCallback((key?: string): void => {
    const scheduled = scheduledPrefetchRef.current
    if (scheduled === null || (key !== undefined && scheduled.key !== key)) return
    window.clearTimeout(scheduled.timer)
    scheduledPrefetchRef.current = null
  }, [])

  const clearExpandedDiffs = useCallback((): void => {
    diffEpochRef.current += 1
    setExpandedDiffs(new Map())
  }, [])

  const replaceDisplayedState = useCallback((nextState: GitRepositoryState): void => {
    cancelScheduledPrefetch()
    clearExpandedDiffs()
    const activeHistorySnapshot = historySnapshotRef.current
    const nextHistorySnapshot = gitHistorySnapshotFromRepositoryState(nextState)
    if (
      activeHistorySnapshot !== null &&
      !gitHistorySnapshotsEqual(activeHistorySnapshot, nextHistorySnapshot)
    ) {
      resetHistoryReadState(nextState)
    }
    stateRef.current = nextState
    setState(nextState)
    setStateProjectKey(projectKey)
    setInitialError(null)
    setInitialErrorProjectKey(null)
  }, [cancelScheduledPrefetch, clearExpandedDiffs, projectKey, resetHistoryReadState])

  const resetProjectDiffData = useCallback((): void => {
    cancelScheduledPrefetch()
    clearExpandedDiffs()
    diffCacheRef.current.clear()
    diffRequestsRef.current.clear()
    invalidationRefreshesRef.current.clear()
    activePrefetchKeyRef.current = null
  }, [cancelScheduledPrefetch, clearExpandedDiffs])

  const refreshState = useCallback(async (
    requestGeneration: number,
    clearNotice: boolean
  ): Promise<string | null> => {
    const requestProjectKey = projectKey
    const requestToken = ++refreshTokenRef.current
    if (clearNotice) setNotice(null)
    setRefreshing(true)
    try {
      const response = await window.piGit.refresh(requestProjectKey)
      if (
        requestToken !== refreshTokenRef.current ||
        requestProjectKey !== projectKey ||
        requestGeneration !== generationRef.current
      ) return null
      if (!isCurrentGitResponse(
        projectKey,
        generationRef.current,
        requestProjectKey,
        requestGeneration,
        response.projectKey
      )) {
        if (stateRef.current === null) {
          setInitialError(RENDERER_GIT_INVOCATION_ERROR)
          setInitialErrorProjectKey(requestProjectKey)
        }
        return RENDERER_GIT_INVOCATION_ERROR
      }
      if (!response.result.ok) {
        const text = gitErrorText(response.result.error)
        if (stateRef.current === null) {
          setInitialError(text)
          setInitialErrorProjectKey(requestProjectKey)
        }
        return text
      }
      replaceDisplayedState(response.result.state)
      return null
    } catch {
      if (
        requestToken !== refreshTokenRef.current ||
        requestGeneration !== generationRef.current
      ) return null
      if (stateRef.current === null) {
        setInitialError(RENDERER_GIT_INVOCATION_ERROR)
        setInitialErrorProjectKey(requestProjectKey)
      }
      return RENDERER_GIT_INVOCATION_ERROR
    } finally {
      if (
        requestToken === refreshTokenRef.current &&
        requestGeneration === generationRef.current
      ) setRefreshing(false)
    }
  }, [projectKey, replaceDisplayedState])

  const loadHistory = useCallback(async (
    snapshot: GitHistorySnapshot,
    offset: number,
    append: boolean
  ): Promise<void> => {
    const requestGeneration = generationRef.current
    const requestProjectKey = projectKey
    const requestToken = ++historyListTokenRef.current
    historySnapshotRef.current = snapshot
    historyDetailTokenRef.current += 1
    historyDiffTokenRef.current += 1
    if (append) {
      setHistoryDraft((current) => ({
        ...current,
        loadingMore: true,
        listError: null
      }))
    } else {
      setHistoryDraft({
        ...createEmptyGitHistoryDraft(),
        listStatus: 'loading'
      })
    }
    try {
      const response = await window.piGit.listHistory(requestProjectKey, { snapshot, offset })
      if (
        requestToken !== historyListTokenRef.current ||
        requestProjectKey !== projectKey ||
        requestGeneration !== generationRef.current
      ) return
      if (!isCurrentGitResponse(
        projectKey,
        generationRef.current,
        requestProjectKey,
        requestGeneration,
        response.projectKey
      )) {
        historySnapshotRef.current = null
        setHistoryDraft({
          ...createEmptyGitHistoryDraft(),
          listStatus: 'error',
          listError: RENDERER_GIT_INVOCATION_ERROR
        })
        return
      }
      if (!response.result.ok) {
        historySnapshotRef.current = null
        const failure = gitErrorText(response.result.error)
        setHistoryDraft({
          ...createEmptyGitHistoryDraft(),
          listStatus: gitHistoryStatusForFailure(response.result.error.code),
          listError: failure
        })
        if (response.result.error.code === 'stale') {
          await refreshState(requestGeneration, false)
        }
        return
      }
      if (!gitHistorySnapshotsEqual(snapshot, response.result.snapshot)) {
        historySnapshotRef.current = null
        setHistoryDraft({
          ...createEmptyGitHistoryDraft(),
          listStatus: 'stale',
          listError: 'Git history snapshot 与当前请求不一致。'
        })
        return
      }
      const result = response.result
      if (
        result.offset !== offset ||
        result.pageSize !== GIT_HISTORY_PAGE_SIZE ||
        result.commits.length > GIT_HISTORY_PAGE_SIZE ||
        (result.hasMore && result.commits.length !== GIT_HISTORY_PAGE_SIZE)
      ) {
        historySnapshotRef.current = null
        setHistoryDraft({
          ...createEmptyGitHistoryDraft(),
          listStatus: 'error',
          listError: 'Git history 分页响应与当前请求不一致。'
        })
        return
      }
      historySnapshotRef.current = result.snapshot
      const mapped = result.commits.map(mapGitHistoryCommitSummary)
      setHistoryDraft((current) => {
        const seenOids = new Set(append ? current.commits.map((commit) => commit.oid) : [])
        const pageCommits = mapped.filter((commit) => {
          if (seenOids.has(commit.oid)) return false
          seenOids.add(commit.oid)
          return true
        })
        const commits = append ? [...current.commits, ...pageCommits] : pageCommits
        const nextOffset = result.offset + result.commits.length
        const hasMore = result.hasMore && nextOffset <= GIT_HISTORY_MAX_OFFSET
        return {
          ...createEmptyGitHistoryDraft(),
          listStatus: commits.length === 0 ? 'empty' : 'ready',
          commits,
          nextOffset,
          hasMore,
          loadingMore: false,
          listTruncated: result.hasMore && !hasMore
        }
      })
    } catch {
      if (
        requestToken !== historyListTokenRef.current ||
        requestGeneration !== generationRef.current
      ) return
      historySnapshotRef.current = null
      setHistoryDraft({
        ...createEmptyGitHistoryDraft(),
        listStatus: 'error',
        listError: RENDERER_GIT_INVOCATION_ERROR
      })
    }
  }, [projectKey, refreshState])

  const activateHistory = useCallback((force: boolean): void => {
    const snapshot = gitHistorySnapshotFromRepositoryState(stateRef.current)
    if (snapshot === null) {
      resetHistoryReadState(stateRef.current)
      return
    }
    if (!force && gitHistorySnapshotsEqual(historySnapshotRef.current, snapshot)) return
    void loadHistory(snapshot, 0, false)
  }, [loadHistory, resetHistoryReadState])

  useEffect(() => {
    if (subview !== 'history' || historySnapshotRef.current !== null) return
    const snapshot = gitHistorySnapshotFromRepositoryState(stateRef.current)
    if (snapshot !== null) activateHistory(false)
  }, [activateHistory, state, subview])

  const loadBranches = useCallback(async (): Promise<void> => {
    const requestGeneration = generationRef.current
    const requestProjectKey = projectKey
    const requestToken = ++branchPrepareTokenRef.current
    setBranchPreparing(true)
    if (branchSnapshotRef.current === null) {
      setBranchesDraft(createEmptyGitBranchesDraft())
    }
    try {
      const response = await window.piGit.prepareBranchSync(requestProjectKey)
      if (
        requestToken !== branchPrepareTokenRef.current ||
        requestProjectKey !== projectKey ||
        requestGeneration !== generationRef.current
      ) return
      if (!isCurrentGitResponse(
        projectKey,
        generationRef.current,
        requestProjectKey,
        requestGeneration,
        response.projectKey
      )) {
        branchSnapshotRef.current = null
        setBranchesDraft({
          ...createEmptyGitBranchesDraft(),
          listStatus: 'error',
          listError: RENDERER_GIT_INVOCATION_ERROR
        })
        return
      }
      const mapped = mapGitBranchSyncPrepareResult(response.result)
      branchSnapshotRef.current = mapped.snapshot
      setBranchesDraft(mapped.view)
    } catch {
      if (
        requestToken !== branchPrepareTokenRef.current ||
        requestGeneration !== generationRef.current
      ) return
      branchSnapshotRef.current = null
      setBranchesDraft({
        ...createEmptyGitBranchesDraft(),
        listStatus: 'error',
        listError: RENDERER_GIT_INVOCATION_ERROR
      })
    } finally {
      if (
        requestToken === branchPrepareTokenRef.current &&
        requestGeneration === generationRef.current
      ) setBranchPreparing(false)
    }
  }, [projectKey])

  const activateBranches = useCallback((force: boolean): void => {
    if (
      !force &&
      gitBranchSyncSnapshotMatchesState(branchSnapshotRef.current, stateRef.current)
    ) return
    void loadBranches()
  }, [loadBranches])

  const refreshInvalidatedSnapshot = useCallback((
    snapshot: GitRepositoryState,
    requestGeneration: number
  ): Promise<string | null> => {
    const key = gitRepositorySnapshotKey(projectKey, snapshot)
    return invalidationRefreshesRef.current.getOrCreate(
      key,
      () => refreshState(requestGeneration, false)
    )
  }, [projectKey, refreshState])

  useEffect(() => {
    const generation = ++generationRef.current
    refreshTokenRef.current += 1
    commitTokenRef.current += 1
    historyListTokenRef.current += 1
    historyDetailTokenRef.current += 1
    historyDiffTokenRef.current += 1
    historySnapshotRef.current = null
    branchPrepareTokenRef.current += 1
    branchExecuteTokenRef.current += 1
    branchSnapshotRef.current = null
    resetProjectDiffData()
    stateRef.current = null
    setState(null)
    setStateProjectKey(null)
    setInitialError(null)
    setInitialErrorProjectKey(null)
    setRefreshing(false)
    setAuthorizing(false)
    setScope('all')
    setPendingMutations(new Set())
    setNotice(null)
    setCommitPreparing(false)
    setCommitDialog(null)
    setSubview('changes')
    setHistoryDraft(createEmptyGitHistoryDraft())
    setBranchesDraft(createEmptyGitBranchesDraft())
    setBranchPreparing(false)
    setBranchDialog(null)
    void refreshState(generation, false)
    return () => {
      cancelScheduledPrefetch()
      diffCacheRef.current.clear()
      diffRequestsRef.current.clear()
      invalidationRefreshesRef.current.clear()
      activePrefetchKeyRef.current = null
      commitTokenRef.current += 1
      historyListTokenRef.current += 1
      historyDetailTokenRef.current += 1
      historyDiffTokenRef.current += 1
      historySnapshotRef.current = null
      branchPrepareTokenRef.current += 1
      branchExecuteTokenRef.current += 1
      branchSnapshotRef.current = null
      if (generationRef.current === generation) generationRef.current += 1
    }
  }, [cancelScheduledPrefetch, projectKey, refreshState, resetProjectDiffData])

  const authorizeAncestorRepository = async (snapshot: GitRepositoryState): Promise<void> => {
    if (
      snapshot.kind !== 'trust-required' ||
      snapshot.repositoryRoot === null ||
      !isDisplayedGitSnapshot(stateRef.current, snapshot)
    ) return
    const requestGeneration = generationRef.current
    const requestProjectKey = projectKey
    setAuthorizing(true)
    setNotice(null)
    try {
      const response = await window.piGit.authorizeAncestorRepository(
        requestProjectKey,
        snapshot.repositoryRoot,
        snapshot.statusRevision
      )
      if (
        requestProjectKey !== projectKey ||
        requestGeneration !== generationRef.current
      ) return
      if (!isCurrentGitResponse(
        projectKey,
        generationRef.current,
        requestProjectKey,
        requestGeneration,
        response.projectKey
      )) {
        setNotice({ projectKey, tone: 'error', text: RENDERER_GIT_INVOCATION_ERROR })
        return
      }
      if (!response.result.ok) {
        const failure = gitErrorText(response.result.error)
        if (response.result.error.code !== 'stale') {
          setNotice({ projectKey, tone: 'error', text: failure })
          return
        }
        const refreshFailure = await refreshState(requestGeneration, false)
        if (requestGeneration === generationRef.current) {
          setNotice({
            projectKey,
            tone: refreshFailure === null ? 'info' : 'error',
            text: refreshFailure === null
              ? 'Repository 授权状态已变化。列表已刷新，请重新确认授权范围。'
              : `${failure} 刷新失败：${refreshFailure}`
          })
        }
        return
      }
      replaceDisplayedState(response.result.state)
    } catch {
      if (requestGeneration === generationRef.current) {
        setNotice({ projectKey, tone: 'error', text: RENDERER_GIT_INVOCATION_ERROR })
      }
    } finally {
      if (requestGeneration === generationRef.current) setAuthorizing(false)
    }
  }

  const prefetchDiff = async (
    snapshot: GitRepositoryState,
    fileSnapshot: GitFileChange,
    kind: GitDiffKind,
    key: string
  ): Promise<void> => {
    if (!isDisplayedGitSnapshot(stateRef.current, snapshot)) return
    if (activePrefetchKeyRef.current !== null && activePrefetchKeyRef.current !== key) return
    activePrefetchKeyRef.current = key
    const requestGeneration = generationRef.current
    const requestProjectKey = projectKey
    let request: GitDiffRequest
    try {
      request = buildGitDiffRequest(snapshot, fileSnapshot, kind)
    } catch {
      if (activePrefetchKeyRef.current === key) activePrefetchKeyRef.current = null
      return
    }
    try {
      const response = await diffRequestsRef.current.getOrCreate(
        key,
        () => window.piGit.getDiff(requestProjectKey, request)
      )
      if (
        requestProjectKey !== projectKey ||
        requestGeneration !== generationRef.current ||
        !isDisplayedGitSnapshot(stateRef.current, snapshot) ||
        !isCurrentGitResponse(
          projectKey,
          generationRef.current,
          requestProjectKey,
          requestGeneration,
          response.projectKey
        )
      ) return
      const result = response.result
      if (result.path !== fileSnapshot.path || result.kind !== kind) return
      if (gitDiffResultInvalidatesSnapshot(result, snapshot)) {
        clearExpandedDiffs()
        const refreshFailure = await refreshInvalidatedSnapshot(snapshot, requestGeneration)
        if (refreshFailure !== null && requestGeneration === generationRef.current) {
          setNotice({
            projectKey,
            tone: 'error',
            text: `Git 状态已失效；自动刷新失败。${refreshFailure}`
          })
        }
        return
      }
      diffCacheRef.current.set(key, result)
    } catch {
      // Intent prefetch is best-effort and never surfaces errors or changes repository state.
    } finally {
      if (activePrefetchKeyRef.current === key) activePrefetchKeyRef.current = null
    }
  }

  const scheduleDiffPrefetch = (
    snapshot: GitRepositoryState,
    fileSnapshot: GitFileChange,
    kind: GitDiffKind
  ): void => {
    if (!isDisplayedGitSnapshot(stateRef.current, snapshot)) return
    const key = gitDiffCacheKey(projectKey, snapshot, fileSnapshot, kind)
    if (
      diffCacheRef.current.get(key) !== null ||
      diffRequestsRef.current.has(key) ||
      scheduledPrefetchRef.current?.key === key
    ) return
    cancelScheduledPrefetch()
    const timer = window.setTimeout(() => {
      if (scheduledPrefetchRef.current?.key !== key) return
      scheduledPrefetchRef.current = null
      void prefetchDiff(snapshot, fileSnapshot, kind, key)
    }, GIT_DIFF_PREFETCH_DELAY_MS)
    scheduledPrefetchRef.current = { key, timer }
  }

  const cancelDiffPrefetch = (
    snapshot: GitRepositoryState,
    fileSnapshot: GitFileChange,
    kind: GitDiffKind
  ): void => {
    cancelScheduledPrefetch(gitDiffCacheKey(projectKey, snapshot, fileSnapshot, kind))
  }

  const requestDiff = async (
    snapshot: GitRepositoryState,
    fileSnapshot: GitFileChange,
    kind: GitDiffKind
  ): Promise<void> => {
    if (!isDisplayedGitSnapshot(stateRef.current, snapshot)) return
    const requestGeneration = generationRef.current
    const requestProjectKey = projectKey
    const requestEpoch = diffEpochRef.current
    const requestToken = ++diffRequestTokenRef.current
    const key = gitDiffCacheKey(projectKey, snapshot, fileSnapshot, kind)
    cancelScheduledPrefetch(key)
    let request: GitDiffRequest
    try {
      request = buildGitDiffRequest(snapshot, fileSnapshot, kind)
    } catch {
      setNotice({ projectKey, tone: 'error', text: '当前文件状态不支持此 diff。请先刷新。' })
      return
    }
    setNotice(null)
    const cached = diffCacheRef.current.get(key)
    if (cached !== null) {
      setExpandedDiffs((current) => setBoundedGitDiffEntry(current, fileSnapshot.id, {
        fileId: fileSnapshot.id,
        kind,
        requestToken,
        loading: false,
        result: cached,
        error: null
      }))
      return
    }
    setExpandedDiffs((current) => setBoundedGitDiffEntry(current, fileSnapshot.id, {
      fileId: fileSnapshot.id,
      kind,
      requestToken,
      loading: true,
      result: null,
      error: null
    }))
    try {
      const response = await diffRequestsRef.current.getOrCreate(
        key,
        () => window.piGit.getDiff(requestProjectKey, request)
      )
      if (
        requestProjectKey !== projectKey ||
        requestGeneration !== generationRef.current ||
        requestEpoch !== diffEpochRef.current ||
        !isDisplayedGitSnapshot(stateRef.current, snapshot)
      ) return
      if (!isCurrentGitResponse(
        projectKey,
        generationRef.current,
        requestProjectKey,
        requestGeneration,
        response.projectKey
      )) {
        if (requestEpoch !== diffEpochRef.current) return
        setExpandedDiffs((current) => updateExpandedDiff(
          current,
          fileSnapshot.id,
          requestToken,
          (active) => ({ ...active, loading: false, error: RENDERER_GIT_INVOCATION_ERROR })
        ))
        return
      }
      const result = response.result
      if (result.path !== fileSnapshot.path || result.kind !== kind) {
        if (requestEpoch !== diffEpochRef.current) return
        setExpandedDiffs((current) => updateExpandedDiff(
          current,
          fileSnapshot.id,
          requestToken,
          (active) => ({ ...active, loading: false, error: 'Git 返回了不匹配的文件结果。请刷新后重试。' })
        ))
        return
      }
      const snapshotInvalidated = gitDiffResultInvalidatesSnapshot(result, snapshot)
      if (!snapshotInvalidated && isDisplayedGitSnapshot(stateRef.current, snapshot) && isCacheableGitDiffResult(result)) {
        diffCacheRef.current.set(key, result)
      }
      if (requestEpoch !== diffEpochRef.current) return
      if (snapshotInvalidated) {
        clearExpandedDiffs()
        const refreshFailure = await refreshInvalidatedSnapshot(snapshot, requestGeneration)
        if (requestGeneration === generationRef.current) {
          setNotice({
            projectKey,
            tone: 'info',
            text: refreshFailure === null
              ? 'Git 状态已变化。列表已刷新，请重新展开文件。'
              : `Git 状态已变化；自动刷新失败。${refreshFailure}`
          })
        }
        return
      }
      setExpandedDiffs((current) => updateExpandedDiff(
        current,
        fileSnapshot.id,
        requestToken,
        (active) => ({ ...active, loading: false, result, error: null })
      ))
    } catch {
      if (
        requestEpoch === diffEpochRef.current &&
        requestGeneration === generationRef.current &&
        isDisplayedGitSnapshot(stateRef.current, snapshot)
      ) {
        setExpandedDiffs((current) => updateExpandedDiff(
          current,
          fileSnapshot.id,
          requestToken,
          (active) => ({ ...active, loading: false, error: RENDERER_GIT_INVOCATION_ERROR })
        ))
      }
    }
  }

  const toggleFile = (
    snapshot: GitRepositoryState,
    fileSnapshot: GitFileChange,
    kind?: GitDiffKind
  ): void => {
    if (!isDisplayedGitSnapshot(stateRef.current, snapshot)) return
    const availableKinds = gitDiffKindsForFile(fileSnapshot)
    if (availableKinds.length === 0) return
    const nextKind = kind ?? availableKinds[0]!
    const active = expandedDiffs.get(fileSnapshot.id)
    if (active?.kind === nextKind) {
      setExpandedDiffs((current) => {
        const currentEntry = current.get(fileSnapshot.id)
        if (currentEntry?.kind !== nextKind) return current
        const next = new Map(current)
        next.delete(fileSnapshot.id)
        return next
      })
      return
    }
    if (active === undefined && expandedDiffs.size >= GIT_DIFF_MAX_EXPANDED_FILES) {
      setNotice({
        projectKey,
        tone: 'info',
        text: `为保持流畅，最多同时展开 ${GIT_DIFF_MAX_EXPANDED_FILES} 个文件 diff。请先折叠一个文件。`
      })
      return
    }
    void requestDiff(snapshot, fileSnapshot, nextKind)
  }

  const mutateFile = async (
    snapshot: GitRepositoryState,
    fileSnapshot: GitFileChange,
    action: GitFileAction
  ): Promise<void> => {
    if (!isDisplayedGitSnapshot(stateRef.current, snapshot)) return
    const operationKey = gitMutationOperationKey(fileSnapshot.path, action)
    const requestGeneration = generationRef.current
    const requestProjectKey = projectKey
    let input: GitFileMutationInput
    try {
      input = buildGitMutationInput(snapshot, fileSnapshot, action)
    } catch {
      setNotice({ projectKey, tone: 'error', text: '当前文件状态不支持此操作。请先刷新。' })
      return
    }
    const gateKey = `${requestProjectKey}\u0000${operationKey}`
    if (!gitMutationGate.tryAcquire(gateKey)) return
    setPendingMutations((current) => new Set(current).add(operationKey))
    setNotice(null)
    try {
      let mutationResult: GitMutationResult | null = null
      let invocationFailed = false
      try {
        const response = action === 'stage'
          ? await window.piGit.stageFile(requestProjectKey, input)
          : await window.piGit.unstageFile(requestProjectKey, input)
        if (!isCurrentGitResponse(
          projectKey,
          generationRef.current,
          requestProjectKey,
          requestGeneration,
          response.projectKey
        )) {
          if (requestGeneration !== generationRef.current) return
          invocationFailed = true
        } else if (
          response.result.action !== action ||
          response.result.path !== fileSnapshot.path
        ) {
          invocationFailed = true
        } else {
          mutationResult = response.result
          if (response.result.ok) {
            replaceDisplayedState(response.result.state)
          } else if (response.result.state !== null) {
            replaceDisplayedState(response.result.state)
          }
        }
      } catch {
        if (requestGeneration !== generationRef.current) return
        invocationFailed = true
      }

      if (requestGeneration !== generationRef.current) return
      const refreshFailure = await refreshState(requestGeneration, false)
      if (requestGeneration !== generationRef.current) return

      if (invocationFailed) {
        setNotice({
          projectKey,
          tone: 'error',
          text: refreshFailure === null
            ? RENDERER_GIT_INVOCATION_ERROR
            : `${RENDERER_GIT_INVOCATION_ERROR} 刷新也未完成。`
        })
        return
      }
      if (mutationResult === null) return
      if (mutationResult.ok) {
        setNotice({
          projectKey,
          tone: refreshFailure === null ? 'info' : 'error',
          text: refreshFailure === null
            ? `${action === 'stage' ? '暂存' : '取消暂存'}完成，列表已刷新。`
            : `${action === 'stage' ? '暂存' : '取消暂存'}完成，但刷新失败。${refreshFailure}`
        })
        return
      }
      const mutationError = mutationResult.error.code === 'stale'
        ? 'Git 状态已经变化，请根据刷新后的列表再次操作。'
        : gitErrorText(mutationResult.error)
      setNotice({
        projectKey,
        tone: 'error',
        text: refreshFailure === null ? mutationError : `${mutationError} 刷新失败：${refreshFailure}`
      })
    } finally {
      gitMutationGate.release(gateKey)
      if (
        requestProjectKey === projectKey &&
        requestGeneration === generationRef.current
      ) {
        setPendingMutations((current) => {
          const next = new Set(current)
          next.delete(operationKey)
          return next
        })
      }
    }
  }

  const prepareCommit = async (snapshot: GitRepositoryState): Promise<void> => {
    if (
      snapshot.kind !== 'repository' ||
      !isDisplayedGitSnapshot(stateRef.current, snapshot) ||
      commitPreparing ||
      commitDialog !== null
    ) return
    const requestGeneration = generationRef.current
    const requestProjectKey = projectKey
    const requestToken = ++commitTokenRef.current
    setCommitPreparing(true)
    setNotice(null)
    try {
      const response = await window.piGit.prepareCommit(requestProjectKey)
      if (
        requestToken !== commitTokenRef.current ||
        requestProjectKey !== projectKey ||
        requestGeneration !== generationRef.current
      ) return
      if (!isCurrentGitResponse(
        projectKey,
        generationRef.current,
        requestProjectKey,
        requestGeneration,
        response.projectKey
      )) {
        setNotice({ projectKey, tone: 'error', text: RENDERER_GIT_INVOCATION_ERROR })
        return
      }
      if (!response.result.ok) {
        if (response.result.state !== null) replaceDisplayedState(response.result.state)
        setNotice({ projectKey, tone: 'error', text: gitErrorText(response.result.error) })
        return
      }
      setCommitDialog({ preview: response.result.preview, busy: false, result: null })
    } catch {
      if (
        requestToken === commitTokenRef.current &&
        requestGeneration === generationRef.current
      ) {
        setNotice({ projectKey, tone: 'error', text: RENDERER_GIT_INVOCATION_ERROR })
      }
    } finally {
      if (
        requestToken === commitTokenRef.current &&
        requestGeneration === generationRef.current
      ) setCommitPreparing(false)
    }
  }

  const submitCommit = async (mode: GitCommitMode, message: string): Promise<void> => {
    const active = commitDialog
    if (active === null || active.busy || active.result?.commit.status === 'succeeded') return
    const requestGeneration = generationRef.current
    const requestProjectKey = projectKey
    const requestToken = ++commitTokenRef.current
    setCommitDialog({ ...active, busy: true, result: null })
    try {
      const response = await window.piGit.executeCommit(requestProjectKey, {
        mode,
        message,
        snapshot: active.preview.snapshot,
        expectedPushTarget: active.preview.pushTarget
      })
      if (
        requestToken !== commitTokenRef.current ||
        requestProjectKey !== projectKey ||
        requestGeneration !== generationRef.current
      ) return
      if (!isCurrentGitResponse(
        projectKey,
        generationRef.current,
        requestProjectKey,
        requestGeneration,
        response.projectKey
      )) {
        setCommitDialog((current) => current?.preview === active.preview
          ? { ...current, busy: false, result: gitCommitInvocationFailure() }
          : current)
        return
      }
      if (response.result.postState.ok) replaceDisplayedState(response.result.postState.state)
      const dialogResult = buildGitCommitDialogResult(response.result)
      setCommitDialog((current) => current?.preview === active.preview
        ? { ...current, busy: false, result: dialogResult }
        : current)
    } catch {
      if (
        requestToken === commitTokenRef.current &&
        requestGeneration === generationRef.current
      ) {
        setCommitDialog((current) => current?.preview === active.preview
          ? { ...current, busy: false, result: gitCommitInvocationFailure() }
          : current)
      }
    }
  }

  const closeCommitDialog = (): void => {
    if (commitDialog?.busy) return
    commitTokenRef.current += 1
    setCommitDialog(null)
  }

  const selectHistoryCommit = async (oid: string): Promise<void> => {
    const snapshot = historySnapshotRef.current
    if (snapshot === null) return
    const requestGeneration = generationRef.current
    const requestProjectKey = projectKey
    const requestToken = ++historyDetailTokenRef.current
    historyDiffTokenRef.current += 1
    setHistoryDraft((current) => gitHistorySelectCommit(current, oid))
    try {
      const response = await window.piGit.getHistoryDetail(requestProjectKey, { snapshot, oid })
      if (
        requestToken !== historyDetailTokenRef.current ||
        requestProjectKey !== projectKey ||
        requestGeneration !== generationRef.current
      ) return
      if (!isCurrentGitResponse(
        projectKey,
        generationRef.current,
        requestProjectKey,
        requestGeneration,
        response.projectKey
      )) {
        setHistoryDraft((current) => current.selectedOid === oid
          ? { ...current, detailLoading: false, detailError: RENDERER_GIT_INVOCATION_ERROR }
          : current)
        return
      }
      if (!response.result.ok) {
        const failure = gitErrorText(response.result.error)
        const status = gitHistoryStatusForFailure(response.result.error.code)
        if (status !== 'error') {
          historySnapshotRef.current = null
          setHistoryDraft({
            ...createEmptyGitHistoryDraft(),
            listStatus: status,
            listError: failure
          })
          if (response.result.error.code === 'stale') {
            await refreshState(requestGeneration, false)
          }
          return
        }
        setHistoryDraft((current) => current.selectedOid === oid
          ? { ...current, detailLoading: false, detailError: failure }
          : current)
        return
      }
      if (
        response.result.commit.oid !== oid ||
        !gitHistorySnapshotsEqual(snapshot, response.result.snapshot)
      ) {
        setHistoryDraft((current) => current.selectedOid === oid
          ? { ...current, detailLoading: false, detailError: 'Git commit 详情与当前请求不一致。' }
          : current)
        return
      }
      const detail: GitHistoryCommitDetailView = {
        commit: mapGitHistoryCommitSummary(response.result.commit),
        message: response.result.commit.message,
        messageTruncated: response.result.commit.messageTruncated,
        files: response.result.files.map((file) => ({
          fileId: file.fileId,
          path: file.path,
          originalPath: file.originalPath,
          change: file.status
        })),
        filesTruncated: response.result.filesTruncated
      }
      setHistoryDraft((current) => current.selectedOid === oid
        ? {
            ...current,
            detail,
            detailLoading: false,
            detailError: null,
            expandedDiff: null
          }
        : current)
    } catch {
      if (
        requestToken === historyDetailTokenRef.current &&
        requestGeneration === generationRef.current
      ) {
        setHistoryDraft((current) => current.selectedOid === oid
          ? { ...current, detailLoading: false, detailError: RENDERER_GIT_INVOCATION_ERROR }
          : current)
      }
    }
  }

  const loadMoreHistory = (): void => {
    const snapshot = historySnapshotRef.current
    if (
      snapshot === null ||
      historyDraft.loadingMore ||
      !historyDraft.hasMore ||
      historyDraft.nextOffset > GIT_HISTORY_MAX_OFFSET
    ) return
    void loadHistory(snapshot, historyDraft.nextOffset, true)
  }

  const toggleHistoryFile = async (fileId: string): Promise<void> => {
    if (historyDraft.expandedDiff?.fileId === fileId) {
      historyDiffTokenRef.current += 1
      setHistoryDraft((current) => gitHistoryToggleExpandedFile(current, fileId))
      return
    }
    const snapshot = historySnapshotRef.current
    const oid = historyDraft.selectedOid
    const file = historyDraft.detail?.files.find((entry) => entry.fileId === fileId)
    if (snapshot === null || oid === null || file === undefined) return
    const requestGeneration = generationRef.current
    const requestProjectKey = projectKey
    const requestToken = ++historyDiffTokenRef.current
    setHistoryDraft((current) => gitHistoryToggleExpandedFile(current, fileId))
    try {
      const response = await window.piGit.getHistoryFileDiff(requestProjectKey, {
        snapshot,
        oid,
        fileId
      })
      if (
        requestToken !== historyDiffTokenRef.current ||
        requestProjectKey !== projectKey ||
        requestGeneration !== generationRef.current
      ) return
      if (!isCurrentGitResponse(
        projectKey,
        generationRef.current,
        requestProjectKey,
        requestGeneration,
        response.projectKey
      )) {
        setHistoryDraft((current) => current.expandedDiff?.fileId === fileId
          ? {
              ...current,
              expandedDiff: { ...current.expandedDiff, loading: false, error: RENDERER_GIT_INVOCATION_ERROR }
            }
          : current)
        return
      }
      const failureCode = response.result.error?.code ?? null
      if (
        failureCode === 'stale' ||
        response.result.state === 'trust-required' ||
        response.result.state === 'not-repository' ||
        (response.result.snapshot !== null && !gitHistorySnapshotsEqual(snapshot, response.result.snapshot))
      ) {
        historySnapshotRef.current = null
        const status = response.result.state === 'trust-required'
          ? 'trust-required'
          : response.result.state === 'not-repository'
            ? 'not-repository'
            : 'stale'
        setHistoryDraft({
          ...createEmptyGitHistoryDraft(),
          listStatus: status,
          listError: response.result.error === null ? null : gitErrorText(response.result.error)
        })
        if (failureCode === 'stale') await refreshState(requestGeneration, false)
        return
      }
      const hasExactFileIdentity =
        response.result.snapshot !== null &&
        gitHistorySnapshotsEqual(snapshot, response.result.snapshot) &&
        response.result.path === file.path &&
        response.result.originalPath === file.originalPath &&
        response.result.status === file.change
      const hasCompatibleErrorIdentity =
        response.result.state === 'error' &&
        (response.result.snapshot === null || gitHistorySnapshotsEqual(snapshot, response.result.snapshot)) &&
        (response.result.path === null || response.result.path === file.path) &&
        (response.result.originalPath === null || response.result.originalPath === file.originalPath) &&
        (response.result.status === null || response.result.status === file.change)
      if (
        response.result.oid !== oid ||
        response.result.fileId !== fileId ||
        (!hasExactFileIdentity && !hasCompatibleErrorIdentity)
      ) {
        setHistoryDraft((current) => current.expandedDiff?.fileId === fileId
          ? {
              ...current,
              expandedDiff: {
                ...current.expandedDiff,
                loading: false,
                error: 'Git 文件差异响应与当前请求不一致。'
              }
            }
          : current)
        return
      }
      const viewerResult: GitDiffViewerResult = {
        path: response.result.path ?? file.path,
        state: response.result.state,
        files: response.result.files,
        error: response.result.error
      }
      setHistoryDraft((current) => (
        current.selectedOid === oid && current.expandedDiff?.fileId === fileId
          ? {
              ...current,
              expandedDiff: {
                fileId,
                loading: false,
                result: viewerResult,
                error: null
              }
            }
          : current
      ))
    } catch {
      if (
        requestToken === historyDiffTokenRef.current &&
        requestGeneration === generationRef.current
      ) {
        setHistoryDraft((current) => current.expandedDiff?.fileId === fileId
          ? {
              ...current,
              expandedDiff: { ...current.expandedDiff, loading: false, error: RENDERER_GIT_INVOCATION_ERROR }
            }
          : current)
      }
    }
  }

  const closeHistoryDetail = (): void => {
    historyDetailTokenRef.current += 1
    historyDiffTokenRef.current += 1
    setHistoryDraft((current) => gitHistoryClearSelection(current))
  }

  const openBranchDialog = (action: GitBranchSyncAction): void => {
    if (
      branchesDraft.listStatus !== 'ready' ||
      branchSnapshotRef.current === null ||
      !branchesDraft.actions[action].enabled ||
      branchDialog !== null
    ) return
    if (!gitBranchSyncSnapshotMatchesState(branchSnapshotRef.current, stateRef.current)) {
      setNotice({ projectKey, tone: 'info', text: 'Git 状态已变化，正在重新准备分支操作。' })
      activateBranches(true)
      return
    }
    setBranchDialog({
      preview: buildGitBranchSyncDialogPreview(action, branchesDraft),
      busy: false,
      result: null
    })
  }

  const closeBranchDialog = (): void => {
    if (branchDialog?.busy === true) return
    branchExecuteTokenRef.current += 1
    setBranchDialog(null)
    if (!gitBranchSyncSnapshotMatchesState(branchSnapshotRef.current, stateRef.current)) {
      activateBranches(true)
    }
  }

  const submitBranchSync = async (payload: GitBranchSyncConfirmPayload): Promise<void> => {
    const snapshot = branchSnapshotRef.current
    const dialog = branchDialog
    if (snapshot === null || dialog === null || dialog.busy || dialog.result !== null) return
    const request: GitBranchSyncExecutionRequest = buildGitBranchSyncExecutionRequest(payload, snapshot)
    const expectedAction = request.action
    const requestGeneration = generationRef.current
    const requestProjectKey = projectKey
    const requestToken = ++branchExecuteTokenRef.current
    setBranchDialog((current) => current === null ? null : { ...current, busy: true })
    setNotice(null)
    try {
      const response = await window.piGit.executeBranchSync(requestProjectKey, request)
      if (
        requestToken !== branchExecuteTokenRef.current ||
        requestProjectKey !== projectKey ||
        requestGeneration !== generationRef.current
      ) return
      if (
        !isCurrentGitResponse(
          projectKey,
          generationRef.current,
          requestProjectKey,
          requestGeneration,
          response.projectKey
        ) ||
        response.result.action !== expectedAction ||
        !gitBranchSyncExecutionMatchesPreview(response.result, dialog.preview, payload, snapshot)
      ) {
        setBranchDialog((current) => current === null
          ? null
          : { ...current, busy: false, result: gitBranchSyncInvocationFailure(dialog.preview.action) })
        return
      }

      const mappedPostView = mapGitBranchSyncPrepareResult(response.result.postView)
      branchSnapshotRef.current = mappedPostView.snapshot
      setBranchesDraft(mappedPostView.view)
      const refreshError = await refreshState(requestGeneration, false)
      if (
        requestToken !== branchExecuteTokenRef.current ||
        requestGeneration !== generationRef.current
      ) return
      const result = mapGitBranchSyncExecutionResult(response.result, refreshError)
      setBranchDialog((current) => current === null
        ? null
        : { ...current, busy: false, result })
    } catch {
      if (
        requestToken !== branchExecuteTokenRef.current ||
        requestGeneration !== generationRef.current
      ) return
      setBranchDialog((current) => current === null
        ? null
        : {
            ...current,
            busy: false,
            result: gitBranchSyncInvocationFailure(dialog.preview.action)
          })
    }
  }

  const selectSubview = (next: GitPanelSubview): void => {
    setSubview(next)
    if (next === 'history') activateHistory(false)
    if (next === 'branches') activateBranches(false)
  }

  const refreshPanel = async (): Promise<void> => {
    const requestGeneration = generationRef.current
    const failure = await refreshState(requestGeneration, true)
    if (failure !== null && requestGeneration === generationRef.current) {
      setNotice({ projectKey, tone: 'error', text: failure })
      return
    }
    if (subview === 'branches' && requestGeneration === generationRef.current) {
      activateBranches(true)
    }
  }

  const selectSubviewFromKeyboard = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    index: number
  ): void => {
    const next = gitPanelSubviewFromKey(GIT_HISTORY_SUBVIEWS, index, event.key)
    if (next === null) return
    event.preventDefault()
    const nextIndex = GIT_HISTORY_SUBVIEWS.indexOf(next)
    subviewTabRefs.current[nextIndex]?.focus()
    if (next !== subview) selectSubview(next)
  }

  const historyBusy = subview === 'history' && (
    historyDraft.listStatus === 'loading' ||
    historyDraft.loadingMore ||
    historyDraft.detailLoading ||
    historyDraft.expandedDiff?.loading === true
  )
  const branchBusy = subview === 'branches' && (
    branchPreparing || branchDialog?.busy === true
  )

  return (
    <section className="git-changes-panel" aria-labelledby={`${generatedId}-title`}>
      <header className="git-changes-header">
        <div>
          <span className="git-changes-kicker">Repository</span>
          <h2 id={`${generatedId}-title`}>Git Changes</h2>
        </div>
        <button
          className="git-refresh-button"
          type="button"
          disabled={
            refreshing ||
            historyBusy ||
            branchPreparing ||
            branchDialog !== null ||
            pendingMutations.size > 0 ||
            commitPreparing ||
            commitDialog?.busy === true
          }
          aria-label="刷新 Git 状态"
          onClick={() => void refreshPanel()}
        >
          {refreshing || historyBusy || branchPreparing ? '刷新中' : '刷新'}
        </button>
      </header>

      <div
        className="git-subview-tabs"
        role="tablist"
        aria-label="Git 子视图"
      >
        {GIT_HISTORY_SUBVIEWS.map((candidate, index) => {
          const selected = candidate === subview
          const tabId = `${generatedId}-subview-tab-${candidate}`
          const panelId = `${generatedId}-subview-panel-${candidate}`
          return (
            <button
              ref={(element) => {
                subviewTabRefs.current[index] = element
              }}
              className="git-subview-tab"
              id={tabId}
              key={candidate}
              type="button"
              role="tab"
              aria-controls={panelId}
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              onKeyDown={(event) => selectSubviewFromKeyboard(event, index)}
              onClick={() => selectSubview(candidate)}
            >
              {candidate === 'changes' ? 'Changes' : candidate === 'history' ? 'History' : 'Branches'}
            </button>
          )
        })}
      </div>

      {notice === null || notice.projectKey !== projectKey ? null : (
        <p className={`git-panel-notice ${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
          {notice.text}
        </p>
      )}

      <div
        className="git-subview-panel"
        id={`${generatedId}-subview-panel-changes`}
        role="tabpanel"
        aria-labelledby={`${generatedId}-subview-tab-changes`}
        hidden={subview !== 'changes'}
      >
        {subview !== 'changes' ? null : visibleState === null ? (
          <div className={`git-panel-state${visibleInitialError === null ? '' : ' error'}`} role={visibleInitialError === null ? 'status' : 'alert'}>
            {visibleInitialError ?? '正在刷新 Git 状态…'}
          </div>
        ) : (
          <GitRepositoryContent
            state={visibleState}
            generatedId={generatedId}
            refreshing={refreshing}
            authorizing={authorizing}
            scope={scope}
            expandedDiffs={expandedDiffs}
            pendingMutations={pendingMutations}
            commitPreparing={commitPreparing}
            onAuthorize={() => void authorizeAncestorRepository(visibleState)}
            onDeclineTrust={() => setNotice({ projectKey, tone: 'info', text: '未允许使用上级目录中的 repository。' })}
            onScopeChange={(nextScope) => {
              clearExpandedDiffs()
              setScope(nextScope)
            }}
            onCollapseAll={clearExpandedDiffs}
            onToggleFile={(file, kind) => toggleFile(visibleState, file, kind)}
            onPrefetchFile={(file, kind) => scheduleDiffPrefetch(visibleState, file, kind)}
            onCancelPrefetch={(file, kind) => cancelDiffPrefetch(visibleState, file, kind)}
            onMutate={(file, action) => void mutateFile(visibleState, file, action)}
            onPrepareCommit={() => void prepareCommit(visibleState)}
          />
        )}
      </div>

      <div
        className="git-subview-panel"
        id={`${generatedId}-subview-panel-history`}
        role="tabpanel"
        aria-labelledby={`${generatedId}-subview-tab-history`}
        hidden={subview !== 'history'}
      >
        {subview !== 'history' ? null : (
          <GitHistoryPanel
            view={historyDraft}
            onSelectCommit={(oid) => void selectHistoryCommit(oid)}
            onLoadMore={loadMoreHistory}
            onBack={closeHistoryDetail}
            onToggleFile={(fileId) => void toggleHistoryFile(fileId)}
          />
        )}
      </div>

      <div
        className="git-subview-panel"
        id={`${generatedId}-subview-panel-branches`}
        role="tabpanel"
        aria-labelledby={`${generatedId}-subview-tab-branches`}
        hidden={subview !== 'branches'}
      >
        {subview !== 'branches' ? null : (
          <GitBranchesPanel
            view={branchesDraft}
            busy={branchBusy}
            dialog={branchDialog}
            onSelectLocalBranch={(branchId) => {
              setBranchesDraft((current) => gitBranchesSelectLocalBranch(current, branchId))
            }}
            onOpenCreate={() => openBranchDialog('create')}
            onOpenSwitch={() => openBranchDialog('switch')}
            onOpenFetch={() => openBranchDialog('fetch')}
            onOpenPull={() => openBranchDialog('pull')}
            onOpenPush={() => openBranchDialog('push')}
            onDialogCancel={closeBranchDialog}
            onDialogConfirm={(payload) => void submitBranchSync(payload)}
          />
        )}
      </div>

      {commitDialog === null ? null : (
        <GitCommitDialog
          key={`${projectKey}:${commitDialog.preview.snapshot.repositoryRoot}:${commitDialog.preview.snapshot.indexFingerprint}`}
          preview={{
            stagedFileCount: commitDialog.preview.stagedFileCount,
            branch: commitDialog.preview.snapshot.branch,
            upstream: commitDialog.preview.pushTarget,
            suggestedMessage: commitDialog.preview.suggestedMessage,
            canAmend: commitDialog.preview.amendAvailable
          }}
          busy={commitDialog.busy}
          result={commitDialog.result}
          onCancel={closeCommitDialog}
          onSubmit={(mode, message) => void submitCommit(mode, message)}
        />
      )}
    </section>
  )
}

function GitRepositoryContent({
  state,
  generatedId,
  refreshing,
  authorizing,
  scope,
  expandedDiffs,
  pendingMutations,
  commitPreparing,
  onAuthorize,
  onDeclineTrust,
  onScopeChange,
  onCollapseAll,
  onToggleFile,
  onPrefetchFile,
  onCancelPrefetch,
  onMutate,
  onPrepareCommit
}: {
  state: GitRepositoryState
  generatedId: string
  refreshing: boolean
  authorizing: boolean
  scope: GitChangeScope
  expandedDiffs: ReadonlyMap<string, ExpandedDiff>
  pendingMutations: ReadonlySet<string>
  commitPreparing: boolean
  onAuthorize: () => void
  onDeclineTrust: () => void
  onScopeChange: (scope: GitChangeScope) => void
  onCollapseAll: () => void
  onToggleFile: (file: GitFileChange, kind?: GitDiffKind) => void
  onPrefetchFile: (file: GitFileChange, kind: GitDiffKind) => void
  onCancelPrefetch: (file: GitFileChange, kind: GitDiffKind) => void
  onMutate: (file: GitFileChange, action: GitFileAction) => void
  onPrepareCommit: () => void
}): React.JSX.Element {
  if (state.kind === 'not-repository') {
    return (
      <div className="git-panel-state">
        <strong>不是 Git repository</strong>
        <span>当前 Project 没有可读取的 Git repository。此处不会自动初始化。</span>
      </div>
    )
  }
  if (state.kind === 'trust-required') {
    return (
      <div className="git-trust-challenge">
        <strong>上级目录中存在 Git repository</strong>
        <p>当前 Project 位于以下 repository 内。仅在你明确允许后，本次应用进程才会使用它。</p>
        <code>{state.repositoryRoot ?? 'repository root 不可用'}</code>
        <div className="git-trust-actions">
          <button type="button" disabled={authorizing} onClick={onAuthorize}>
            {authorizing ? '正在允许…' : '允许本次使用'}
          </button>
          <button type="button" disabled={authorizing} onClick={onDeclineTrust}>暂不允许</button>
        </div>
      </div>
    )
  }

  const visibleFiles = state.files.filter((file) => gitFileMatchesScope(file, scope))
  const stagedFileCount = gitChangeScopeCount(state.files, 'staged')
  const scopeOptions = (['all', 'unstaged', 'staged'] as const).map((candidate) => ({
    value: candidate,
    label: gitChangeScopeLabel(candidate, gitChangeScopeCount(state.files, candidate))
  }))

  return (
    <div className="git-repository-content" aria-busy={refreshing}>
      <section className="git-repository-summary" aria-label="Repository 摘要">
        <strong>{gitBranchLabel(state)}</strong>
        <span>{gitUpstreamLabel(state)}</span>
      </section>

      <section className="git-repository-commit" aria-label="提交已暂存变更">
        <button
          type="button"
          disabled={
            refreshing ||
            pendingMutations.size > 0 ||
            commitPreparing ||
            stagedFileCount === 0
          }
          onClick={onPrepareCommit}
        >
          {commitPreparing ? '准备中…' : 'Commit & Push'}
        </button>
        <span>
          {stagedFileCount === 0
            ? '请先暂存至少一个文件。'
            : `将确认 ${stagedFileCount} 个已暂存文件；不会自动暂存。`}
        </span>
      </section>

      {state.lastError === null ? null : (
        <p className="git-state-warning" role="alert">{gitErrorText(state.lastError)}</p>
      )}
      {state.truncated ? (
        <p className="git-state-warning" role="status">变更列表已达到安全上限，仅显示有界结果。</p>
      ) : null}

      <section className="git-change-list-section" aria-label="Git 变更列表">
        <div className="git-change-list-heading">
          <div className="git-change-scope-control">
            <Select
              id={`${generatedId}-change-scope`}
              value={scope}
              groups={[{ options: scopeOptions }]}
              disabled={refreshing}
              onValueChange={(value) => onScopeChange(value as GitChangeScope)}
            />
          </div>
          <IconButton
            className="git-collapse-all"
            icon="collapse-all"
            iconSize="sm"
            label="折叠全部文件 diff"
            disabled={expandedDiffs.size === 0}
            onClick={onCollapseAll}
          />
        </div>
        {state.files.length === 0 ? (
          <p className="git-clean-state">工作区没有未提交变更。</p>
        ) : visibleFiles.length === 0 ? (
          <p className="git-clean-state">{gitChangeScopeEmptyText(scope)}</p>
        ) : (
          <ul className="git-change-list">
            {visibleFiles.map((file, index) => {
              const diffKinds = gitDiffKindsForScope(file, scope)
              const actions = gitActionsForScope(file, scope)
              const expanded = expandedDiffs.get(file.id) ?? null
              const isExpanded = expanded !== null
              const detailsId = `${generatedId}-change-${index}`
              const displayPath = gitFileDisplayPath(file)
              const stateLabel = gitFileStateLabel(file)
              const fileMutationPending = actions.some((action) =>
                pendingMutations.has(gitMutationOperationKey(file.path, action))
              )
              return (
                <li className={`git-change-item ${file.state}`} key={file.id}>
                  <div className="git-change-row">
                    {diffKinds.length === 0 ? (
                      <div className="git-change-disclosure static">
                        <span className="git-change-disclosure-icon" aria-hidden="true" />
                        <span className="git-change-path" title={displayPath}>{displayPath}</span>
                        <span
                          className="git-change-state"
                          title={file.conflicted || file.state === 'conflicted'
                            ? '此文件存在合并冲突。P3-1 不提供 diff、暂存或冲突解决。'
                            : stateLabel}
                        >
                          {stateLabel}
                        </span>
                      </div>
                    ) : (
                      <button
                        className="git-change-disclosure"
                        type="button"
                        aria-expanded={isExpanded}
                        aria-controls={detailsId}
                        onPointerEnter={() => {
                          if (!fileMutationPending) onPrefetchFile(file, diffKinds[0]!)
                        }}
                        onPointerLeave={(event) => {
                          if (shouldCancelGitDiffPrefetch(
                            false,
                            document.activeElement === event.currentTarget
                          )) onCancelPrefetch(file, diffKinds[0]!)
                        }}
                        onPointerCancel={(event) => {
                          if (shouldCancelGitDiffPrefetch(
                            false,
                            document.activeElement === event.currentTarget
                          )) onCancelPrefetch(file, diffKinds[0]!)
                        }}
                        onFocus={() => {
                          if (!fileMutationPending) onPrefetchFile(file, diffKinds[0]!)
                        }}
                        onBlur={(event) => {
                          if (shouldCancelGitDiffPrefetch(
                            event.currentTarget.matches(':hover'),
                            false
                          )) onCancelPrefetch(file, diffKinds[0]!)
                        }}
                        onClick={() => onToggleFile(file, diffKinds[0])}
                      >
                        <span className="git-change-disclosure-icon" aria-hidden="true">
                          <Icon name={isExpanded ? 'chevron-down' : 'chevron-right'} size="sm" />
                        </span>
                        <span className="git-change-path" title={displayPath}>{displayPath}</span>
                        <span className="git-change-state">{stateLabel}</span>
                      </button>
                    )}
                    {actions.length === 0 ? null : (
                      <div className="git-change-actions" aria-label={`${file.path} 操作`}>
                        {actions.map((action) => {
                          const actionLabel = gitFileActionLabel(file, action)
                          return (
                            <IconButton
                              className="git-change-action"
                              icon={action === 'stage' ? 'plus' : 'undo'}
                              iconSize="sm"
                              label={`${actionLabel}：${displayPath}`}
                              title={actionLabel}
                              key={action}
                              disabled={fileMutationPending}
                              onClick={() => onMutate(file, action)}
                            />
                          )
                        })}
                      </div>
                    )}
                  </div>
                  {isExpanded ? (
                    <GitExpandedDiff
                      id={detailsId}
                      file={file}
                      availableKinds={diffKinds}
                      expanded={expanded!}
                      onKindChange={(kind) => onToggleFile(file, kind)}
                      onPrefetchKind={(kind) => onPrefetchFile(file, kind)}
                      onCancelPrefetchKind={(kind) => onCancelPrefetch(file, kind)}
                    />
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}

function GitExpandedDiff({
  id,
  file,
  availableKinds,
  expanded,
  onKindChange,
  onPrefetchKind,
  onCancelPrefetchKind
}: {
  id: string
  file: GitFileChange
  availableKinds: readonly GitDiffKind[]
  expanded: ExpandedDiff
  onKindChange: (kind: GitDiffKind) => void
  onPrefetchKind: (kind: GitDiffKind) => void
  onCancelPrefetchKind: (kind: GitDiffKind) => void
}): React.JSX.Element {
  return (
    <div className="git-expanded-diff" id={id}>
      {availableKinds.length > 1 ? (
        <div className="git-diff-kind-selector" role="group" aria-label={`${file.path} diff 类型`}>
          {availableKinds.map((kind) => (
            <button
              type="button"
              key={kind}
              aria-pressed={expanded.kind === kind}
              disabled={expanded.loading && expanded.kind === kind}
              onPointerEnter={() => onPrefetchKind(kind)}
              onPointerLeave={(event) => {
                if (shouldCancelGitDiffPrefetch(
                  false,
                  document.activeElement === event.currentTarget
                )) onCancelPrefetchKind(kind)
              }}
              onPointerCancel={(event) => {
                if (shouldCancelGitDiffPrefetch(
                  false,
                  document.activeElement === event.currentTarget
                )) onCancelPrefetchKind(kind)
              }}
              onFocus={() => onPrefetchKind(kind)}
              onBlur={(event) => {
                if (shouldCancelGitDiffPrefetch(
                  event.currentTarget.matches(':hover'),
                  false
                )) onCancelPrefetchKind(kind)
              }}
              onClick={() => {
                if (expanded.kind !== kind) onKindChange(kind)
              }}
            >
              {kind === 'working' ? 'Working' : 'Staged'}
            </button>
          ))}
        </div>
      ) : null}
      {expanded.loading ? <p className="git-diff-state" role="status">正在读取 diff…</p> : null}
      {expanded.error === null ? null : <p className="git-diff-state error" role="alert">{expanded.error}</p>}
      {expanded.result === null || expanded.loading ? null : <GitDiffViewer result={expanded.result} />}
    </div>
  )
}

function updateExpandedDiff(
  current: ReadonlyMap<string, ExpandedDiff>,
  fileId: string,
  requestToken: number,
  update: (active: ExpandedDiff) => ExpandedDiff
): ReadonlyMap<string, ExpandedDiff> {
  const active = current.get(fileId)
  if (active?.requestToken !== requestToken) return current
  const next = new Map(current)
  next.set(fileId, update(active))
  return next
}

function gitChangeScopeLabel(scope: GitChangeScope, count: number): string {
  const noun = count === 1 ? 'Change' : 'Changes'
  switch (scope) {
    case 'all': return `${count} Uncommitted ${noun}`
    case 'unstaged': return `${count} Unstaged ${noun}`
    case 'staged': return `${count} Staged ${noun}`
  }
}

function gitChangeScopeEmptyText(scope: GitChangeScope): string {
  switch (scope) {
    case 'all': return '工作区没有未提交变更。'
    case 'unstaged': return '没有未暂存变更。'
    case 'staged': return '没有已暂存变更。'
  }
}

function gitFileActionLabel(file: GitFileChange, action: GitFileAction): string {
  if (file.state === 'mixed') return action === 'stage' ? '暂存剩余变更' : '取消已暂存变更'
  return action === 'stage' ? '暂存变更' : '取消暂存'
}

function gitMutationOperationKey(path: string, action: GitFileAction): string {
  return `${action}\u0000${path}`
}
