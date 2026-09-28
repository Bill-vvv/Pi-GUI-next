import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import {
  GIT_HISTORY_MAX_OFFSET, GIT_HISTORY_PAGE_SIZE,
  type GitRepositoryState, type GitHistorySnapshot,
  type GitHistoryCommitSummary as GitHistoryCommitSummaryDto
} from '../../../../shared/git-contract'
import { gitErrorText, isCurrentGitResponse } from './git-changes-model'
import {
  createEmptyGitHistoryDraft, gitHistoryClearSelection, gitHistorySelectCommit,
  gitHistoryToggleExpandedFile, type GitHistoryCommitDetail as GitHistoryCommitDetailView,
  type GitHistoryCommitSummary as GitHistoryCommitSummaryView,
  type GitHistoryDraftViewModel, type GitHistoryListStatus
} from './git-history-model'
import type { GitDiffViewerResult } from './GitDiffViewer'
import { RENDERER_GIT_INVOCATION_ERROR, type GitRepositoryReader } from './use-git-repository'

function gitHistorySnapshotFromRepositoryState(
  state: GitRepositoryState | null
): GitHistorySnapshot | null {
  if (state === null || state.kind !== 'repository' || state.repositoryRoot === null) return null
  return {
    repositoryRoot: state.repositoryRoot,
    headOid: state.headOid,
    branch: state.branch
  }
}

function gitHistorySnapshotsEqual(
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

export function useGitHistory(
  { projectKey, generationRef, stateRef, refreshState }: GitRepositoryReader,
  state: GitRepositoryState | null,
  active: boolean
) {
  const historyListTokenRef = useRef(0)
  const historyDetailTokenRef = useRef(0)
  const historyDiffTokenRef = useRef(0)
  const historySnapshotRef = useRef<GitHistorySnapshot | null>(null)
  const [historyDraft, setHistoryDraft] = useState<GitHistoryDraftViewModel>(() => createEmptyGitHistoryDraft())

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
        requestGeneration !== generationRef.current ||
        !gitHistorySnapshotsEqual(snapshot, gitHistorySnapshotFromRepositoryState(stateRef.current))
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
        requestGeneration !== generationRef.current ||
        !gitHistorySnapshotsEqual(snapshot, gitHistorySnapshotFromRepositoryState(stateRef.current))
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

  useLayoutEffect(() => {
    const snapshot = gitHistorySnapshotFromRepositoryState(state)
    if (!gitHistorySnapshotsEqual(historySnapshotRef.current, snapshot)) resetHistoryReadState(state)
    if (active && snapshot !== null && historySnapshotRef.current === null) activateHistory(false)
  }, [active, activateHistory, resetHistoryReadState, state])

  useLayoutEffect(() => () => {
    historyListTokenRef.current += 1
    historyDetailTokenRef.current += 1
    historyDiffTokenRef.current += 1
    historySnapshotRef.current = null
  }, [])

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
        requestGeneration !== generationRef.current ||
        !gitHistorySnapshotsEqual(snapshot, gitHistorySnapshotFromRepositoryState(stateRef.current))
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
        requestGeneration !== generationRef.current ||
        !gitHistorySnapshotsEqual(snapshot, gitHistorySnapshotFromRepositoryState(stateRef.current))
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

  return {
    historyDraft, activateHistory, selectHistoryCommit, loadMoreHistory,
    toggleHistoryFile, closeHistoryDetail
  }
}
