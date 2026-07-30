import { useVirtualizer } from '@tanstack/react-virtual'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'

import { Icon } from '../../components/Icon'
import { IconButton } from '../../components/IconButton'
import { Select } from '../../components/Select'
import type {
  GitDiffKind,
  GitDiffRequest,
  GitDiffResult,
  GitFileChange,
  GitFileMutationInput,
  GitMutationResult,
  GitRepositoryState
} from '../../../../shared/git-contract'
import {
  buildGitDiffRenderRows,
  buildGitDiffRequest,
  buildGitMutationInput,
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
  gitFileStateLabel,
  gitUpstreamLabel,
  isCurrentGitResponse,
  isDisplayedGitSnapshot,
  shouldCancelGitDiffPrefetch,
  type GitChangeScope,
  type GitDiffRenderRow,
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
import './git-changes.css'

const RENDERER_GIT_INVOCATION_ERROR = 'Renderer 无法调用 Git 服务。请检查文件路径后重试。'
const GIT_DIFF_PREFETCH_DELAY_MS = 80
const GIT_DIFF_VIRTUALIZE_AFTER_ROWS = 300
const GIT_DIFF_ROW_HEIGHT = 32
const GIT_DIFF_OVERSCAN = 12
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

export function GitChangesPanel({
  projectKey
}: {
  projectKey: string
}): React.JSX.Element {
  const generatedId = useId().replace(/[^a-zA-Z0-9_-]/g, '') || 'git'
  const generationRef = useRef(0)
  const refreshTokenRef = useRef(0)
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
    stateRef.current = nextState
    setState(nextState)
    setStateProjectKey(projectKey)
    setInitialError(null)
    setInitialErrorProjectKey(null)
  }, [cancelScheduledPrefetch, clearExpandedDiffs, projectKey])

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
    void refreshState(generation, false)
    return () => {
      cancelScheduledPrefetch()
      diffCacheRef.current.clear()
      diffRequestsRef.current.clear()
      invalidationRefreshesRef.current.clear()
      activePrefetchKeyRef.current = null
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
          disabled={refreshing || pendingMutations.size > 0}
          aria-label="刷新 Git 状态"
          onClick={() => void refreshState(generationRef.current, true).then((failure) => {
            if (failure !== null && generationRef.current > 0) {
              setNotice({ projectKey, tone: 'error', text: failure })
            }
          })}
        >
          {refreshing ? '刷新中' : '刷新'}
        </button>
      </header>

      {notice === null || notice.projectKey !== projectKey ? null : (
        <p className={`git-panel-notice ${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
          {notice.text}
        </p>
      )}

      {visibleState === null ? (
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
  onAuthorize,
  onDeclineTrust,
  onScopeChange,
  onCollapseAll,
  onToggleFile,
  onPrefetchFile,
  onCancelPrefetch,
  onMutate
}: {
  state: GitRepositoryState
  generatedId: string
  refreshing: boolean
  authorizing: boolean
  scope: GitChangeScope
  expandedDiffs: ReadonlyMap<string, ExpandedDiff>
  pendingMutations: ReadonlySet<string>
  onAuthorize: () => void
  onDeclineTrust: () => void
  onScopeChange: (scope: GitChangeScope) => void
  onCollapseAll: () => void
  onToggleFile: (file: GitFileChange, kind?: GitDiffKind) => void
  onPrefetchFile: (file: GitFileChange, kind: GitDiffKind) => void
  onCancelPrefetch: (file: GitFileChange, kind: GitDiffKind) => void
  onMutate: (file: GitFileChange, action: GitFileAction) => void
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
      {expanded.result === null || expanded.loading ? null : <GitDiffView result={expanded.result} />}
    </div>
  )
}

function GitDiffView({ result }: { result: GitDiffResult }): React.JSX.Element {
  if (result.state !== 'ready') {
    return <p className={`git-diff-state ${result.state}`}>{gitDiffStateText(result)}</p>
  }
  if (result.files.length === 0) {
    return <p className="git-diff-state">此快照没有可显示的 diff。</p>
  }
  return <GitReadyDiffView result={result} />
}

function GitReadyDiffView({ result }: { result: GitDiffResult }): React.JSX.Element {
  const rows = useMemo(() => buildGitDiffRenderRows(result.files), [result.files])
  if (rows.length > GIT_DIFF_VIRTUALIZE_AFTER_ROWS) {
    return <VirtualGitDiffRows path={result.path} rows={rows} />
  }
  return (
    <div
      className="git-diff-scroll"
      data-virtualized="false"
      tabIndex={0}
      aria-label={`${result.path} diff`}
    >
      <div className="git-diff-file">
        {rows.map((row) => <GitDiffRow key={row.id} row={row} />)}
      </div>
    </div>
  )
}

function VirtualGitDiffRows({
  path,
  rows
}: {
  path: string
  rows: readonly GitDiffRenderRow[]
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [textMode, setTextMode] = useState(false)
  const [copyNotice, setCopyNotice] = useState<{ tone: 'info' | 'error'; text: string } | null>(null)
  const fullText = useMemo(() => gitDiffRenderRowsText(rows), [rows])
  const maximumColumns = useMemo(() => gitDiffRenderRowsMaxColumns(rows), [rows])
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => GIT_DIFF_ROW_HEIGHT,
    getItemKey: (index) => rows[index]?.id ?? index,
    overscan: GIT_DIFF_OVERSCAN
  })

  useEffect(() => setCopyNotice(null), [fullText])

  const copyFullDiff = async (): Promise<void> => {
    try {
      if (navigator.clipboard === undefined) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(fullText)
      setCopyNotice({ tone: 'info', text: '完整 diff 已复制。' })
    } catch {
      setCopyNotice({ tone: 'error', text: '无法复制完整 diff，请切换到完整文本后手动复制。' })
    }
  }

  return (
    <div className="git-diff-large-view">
      <div className="git-diff-large-toolbar">
        <span>大型 diff · {rows.length} 行</span>
        <div className="git-diff-large-actions">
          <button
            type="button"
            aria-pressed={textMode}
            onClick={() => {
              setCopyNotice(null)
              setTextMode((current) => !current)
            }}
          >
            {textMode ? '返回虚拟视图' : '查看完整文本'}
          </button>
          <button type="button" onClick={() => void copyFullDiff()}>复制全部</button>
        </div>
      </div>
      {textMode ? (
        <textarea
          className="git-diff-full-text"
          aria-label={`${path} 完整 diff 文本`}
          readOnly
          spellCheck={false}
          wrap="off"
          value={fullText}
        />
      ) : (
        <div
          ref={scrollRef}
          className="git-diff-scroll virtualized"
          data-virtualized="true"
          style={{ height: `${Math.min(rows.length * GIT_DIFF_ROW_HEIGHT, 430)}px` }}
          tabIndex={0}
          aria-label={`${path} diff，共 ${rows.length} 行；可切换到完整文本连续阅读`}
        >
          <div
            className="git-diff-virtual-space"
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: `max(100%, calc(${maximumColumns}ch + 8.5em))`
            }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index]
              if (row === undefined) return null
              return (
                <div
                  className="git-diff-virtual-row"
                  key={virtualRow.key}
                  style={{
                    height: `${virtualRow.size}px`,
                    transform: `translateY(${virtualRow.start}px)`
                  }}
                >
                  <GitDiffRow row={row} />
                </div>
              )
            })}
          </div>
        </div>
      )}
      {copyNotice === null ? null : (
        <p className={`git-diff-copy-notice ${copyNotice.tone}`} role={copyNotice.tone === 'error' ? 'alert' : 'status'}>
          {copyNotice.text}
        </p>
      )}
    </div>
  )
}

function GitDiffRow({ row }: { row: GitDiffRenderRow }): React.JSX.Element {
  if (row.kind === 'fold') {
    return (
      <div className="git-diff-fold" aria-label={`${row.unmodifiedLines} 行未修改内容已折叠`}>
        <span className="git-diff-fold-rail" aria-hidden="true" />
        <span>{row.unmodifiedLines} unmodified lines</span>
      </div>
    )
  }
  const line = row.line
  return (
    <div className={`git-diff-line ${line.kind}`}>
      <span className="git-diff-line-number">{line.oldLine ?? ''}</span>
      <span className="git-diff-line-number">{line.newLine ?? ''}</span>
      <span className="git-diff-line-marker">{line.kind === 'add' ? '+' : line.kind === 'remove' ? '−' : ' '}</span>
      <span className="git-diff-line-content">{line.content}</span>
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

function gitDiffStateText(result: GitDiffResult): string {
  switch (result.state) {
    case 'binary': return '此文件是 binary 或非 UTF-8 内容，无法显示文本 diff。'
    case 'oversized': return '此 diff 超过安全显示上限。'
    case 'unsupported': return '当前 diff 形状不受支持。'
    case 'conflict': return '冲突文件不提供 diff。'
    case 'trust-required': return 'Repository 授权已经失效，请刷新并重新允许。'
    case 'not-repository': return '当前 Project 不再属于 Git repository。'
    case 'error': return result.error === null ? '无法读取 diff。' : gitErrorText(result.error)
    case 'ready': return ''
  }
}
