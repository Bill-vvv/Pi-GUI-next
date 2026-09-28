import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type {
  GitCommitExecutionResult, GitCommitMode, GitCommitPreview, GitCommitWarning,
  GitDiffKind, GitDiffRequest, GitDiffResult, GitFileChange, GitFileMutationInput,
  GitMutationResult, GitRepositoryState
} from '../../../../shared/git-contract'
import {
  buildGitDiffRequest, buildGitMutationInput, gitDiffKindsForFile, gitDiffKindsForScope,
  gitDiffResultInvalidatesSnapshot, gitErrorText, gitMutationOperationKey, isCurrentGitResponse, isDisplayedGitSnapshot,
  type GitChangeScope, type GitFileAction
} from './git-changes-model'
import {
  GIT_DIFF_MAX_EXPANDED_FILES, GitDiffLruCache, GitDiffRequestPool, GitMutationGate,
  gitDiffCacheKey, gitRepositorySnapshotKey, isCacheableGitDiffResult, setBoundedGitDiffEntry
} from './git-diff-cache'
import type { GitCommitDialogResult } from './GitCommitDialog'
import {
  RENDERER_GIT_INVOCATION_ERROR, type GitRepositoryReader, type GitRepositoryController
} from './use-git-repository'

const GIT_DIFF_PREFETCH_DELAY_MS = 80
const gitMutationGate = new GitMutationGate()
type GitDiffBridgeResponse = Awaited<ReturnType<typeof window.piGit.getDiff>>

export type ExpandedDiff = {
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

function gitCommitWarningsText(warnings: readonly GitCommitWarning[]): string | null {
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

function gitCommitInvocationFailure(mode: GitCommitMode): GitCommitDialogResult {
  return {
    commit: { status: 'unknown', detail: '未收到提交结果，提交可能已经完成。请关闭此窗口，刷新并检查提交历史后再操作。' },
    push: mode === 'commit-and-push'
      ? { status: 'unknown', detail: '推送结果也未确认，请检查远程分支。' }
      : { status: 'skipped', detail: '本次没有请求推送。' },
    refresh: { status: 'failed', detail: '未能读取最新 Git 状态。' }
  }
}

export function useGitChanges({
  projectKey, generationRef, stateRef, refreshState, setNotice, replaceDisplayedState
}: GitRepositoryReader & Pick<GitRepositoryController, 'setNotice' | 'replaceDisplayedState'>,
  state: GitRepositoryState | null
) {
  const commitTokenRef = useRef(0)
  const diffEpochRef = useRef(0)
  const diffRequestTokenRef = useRef(0)
  const diffCacheRef = useRef(new GitDiffLruCache())
  const diffRequestsRef = useRef(new GitDiffRequestPool<GitDiffBridgeResponse>())
  const invalidationRefreshesRef = useRef(new GitDiffRequestPool<string | null>())
  const scheduledPrefetchRef = useRef<{ key: string; timer: number } | null>(null)
  const activePrefetchKeyRef = useRef<string | null>(null)
  const [scope, setScope] = useState<GitChangeScope>('all')
  const [expandedDiffs, setExpandedDiffs] = useState<ReadonlyMap<string, ExpandedDiff>>(() => new Map())
  const [pendingMutations, setPendingMutations] = useState<ReadonlySet<string>>(() => new Set())
  const [commitPreparing, setCommitPreparing] = useState(false)
  const [commitDialog, setCommitDialog] = useState<CommitDialogState | null>(null)

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

  useLayoutEffect(() => {
    cancelScheduledPrefetch()
    clearExpandedDiffs()
  }, [cancelScheduledPrefetch, clearExpandedDiffs, state])

  useLayoutEffect(() => () => {
    cancelScheduledPrefetch()
    diffCacheRef.current.clear()
    diffRequestsRef.current.clear()
    invalidationRefreshesRef.current.clear()
    activePrefetchKeyRef.current = null
    diffEpochRef.current += 1
    commitTokenRef.current += 1
  }, [cancelScheduledPrefetch])

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
            ? '未能确认操作结果，请检查刷新后的暂存区再决定是否重试。'
            : '未能确认操作结果，刷新也未完成。请重新连接并检查暂存区后再操作。'
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
    if (active === null || active.busy || active.result?.commit.status === 'succeeded' || active.result?.commit.status === 'unknown') return
    const gateKey = `${projectKey}\u0000commit`
    if (!gitMutationGate.tryAcquire(gateKey)) return
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
          ? { ...current, busy: false, result: gitCommitInvocationFailure(mode) }
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
          ? { ...current, busy: false, result: gitCommitInvocationFailure(mode) }
          : current)
      }
    } finally {
      gitMutationGate.release(gateKey)
    }
  }

  const closeCommitDialog = (): void => {
    if (commitDialog?.busy) return
    commitTokenRef.current += 1
    setCommitDialog(null)
  }

  return {
    scope, setScope, expandedDiffs, pendingMutations, commitPreparing, commitDialog,
    clearExpandedDiffs, toggleFile, scheduleDiffPrefetch, cancelDiffPrefetch, mutateFile,
    prepareCommit, submitCommit, closeCommitDialog
  }
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
