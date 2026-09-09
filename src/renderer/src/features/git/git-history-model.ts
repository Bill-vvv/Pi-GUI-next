import type { GitDiffViewerResult } from './GitDiffViewer'

export type GitPanelSubview = 'changes' | 'history' | 'branches'

export type GitHistoryListStatus =
  | 'loading'
  | 'empty'
  | 'ready'
  | 'error'
  | 'stale'
  | 'not-repository'
  | 'trust-required'

export type GitHistoryCommitSummary = {
  oid: string
  shortOid: string
  subject: string
  authorName: string
  authorEmail: string | null
  authoredAt: number
  committerName: string
  committerEmail: string | null
  committedAt: number
  parentOids: readonly string[]
}

export type GitHistoryFileChangeKind =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'type-changed'
  | 'unknown'

export type GitHistoryChangedFile = {
  fileId: string
  path: string
  originalPath: string | null
  change: GitHistoryFileChangeKind
}

export type GitHistoryCommitDetail = {
  commit: GitHistoryCommitSummary
  message: string
  messageTruncated: boolean
  files: readonly GitHistoryChangedFile[]
  filesTruncated: boolean
}

export type GitHistoryExpandedDiff = {
  fileId: string
  loading: boolean
  result: GitDiffViewerResult | null
  error: string | null
}

export type GitHistoryDraftViewModel = {
  listStatus: GitHistoryListStatus
  listError: string | null
  commits: readonly GitHistoryCommitSummary[]
  nextOffset: number
  hasMore: boolean
  loadingMore: boolean
  listTruncated: boolean
  selectedOid: string | null
  detail: GitHistoryCommitDetail | null
  detailLoading: boolean
  detailError: string | null
  expandedDiff: GitHistoryExpandedDiff | null
}

export const GIT_HISTORY_SUBVIEWS = ['changes', 'history', 'branches'] as const

export function createEmptyGitHistoryDraft(): GitHistoryDraftViewModel {
  return {
    listStatus: 'empty',
    listError: null,
    commits: [],
    nextOffset: 0,
    hasMore: false,
    loadingMore: false,
    listTruncated: false,
    selectedOid: null,
    detail: null,
    detailLoading: false,
    detailError: null,
    expandedDiff: null
  }
}

export function gitPanelSubviewFromKey(
  subviews: readonly GitPanelSubview[],
  currentIndex: number,
  key: string
): GitPanelSubview | null {
  if (subviews.length === 0) return null
  if (!Number.isSafeInteger(currentIndex) || currentIndex < 0 || currentIndex >= subviews.length) {
    return null
  }
  const nextIndex = key === 'ArrowLeft'
    ? (currentIndex - 1 + subviews.length) % subviews.length
    : key === 'ArrowRight'
      ? (currentIndex + 1) % subviews.length
      : key === 'Home'
        ? 0
        : key === 'End'
          ? subviews.length - 1
          : null
  return nextIndex === null ? null : subviews[nextIndex] ?? null
}

export function gitHistoryCommitAccessibleName(commit: GitHistoryCommitSummary): string {
  return `${commit.shortOid} ${commit.subject}`
}

export function gitHistoryFileDisplayPath(file: GitHistoryChangedFile): string {
  if (file.originalPath === null || file.originalPath === file.path) return file.path
  return `${file.originalPath} → ${file.path}`
}

export function gitHistoryFileChangeLabel(change: GitHistoryFileChangeKind): string {
  switch (change) {
    case 'added': return '新增'
    case 'modified': return '修改'
    case 'deleted': return '删除'
    case 'renamed': return '重命名'
    case 'type-changed': return '类型变更'
    case 'unknown': return '变更'
  }
}

export function gitHistoryListStatusText(
  status: GitHistoryListStatus,
  errorText: string | null
): string {
  switch (status) {
    case 'loading': return '正在读取提交历史…'
    case 'empty': return '当前 HEAD 没有可显示的提交。'
    case 'ready': return ''
    case 'error': return errorText ?? '无法读取提交历史。'
    case 'stale': return 'Repository 或 HEAD 已变化，请重新加载历史。'
    case 'not-repository': return '当前 Project 不再属于 Git repository。'
    case 'trust-required': return 'Repository 授权已经失效，请切换到 Changes 并重新允许。'
  }
}

export function gitHistoryFormatTimestamp(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return '未知时间'
  try {
    return new Date(epochMs).toLocaleString()
  } catch {
    return '未知时间'
  }
}

export function gitHistorySelectCommit(
  current: GitHistoryDraftViewModel,
  oid: string
): GitHistoryDraftViewModel {
  if (current.selectedOid === oid) return current
  return {
    ...current,
    selectedOid: oid,
    detail: null,
    detailLoading: true,
    detailError: null,
    expandedDiff: null
  }
}

export function gitHistoryClearSelection(
  current: GitHistoryDraftViewModel
): GitHistoryDraftViewModel {
  if (
    current.selectedOid === null &&
    current.detail === null &&
    !current.detailLoading &&
    current.detailError === null &&
    current.expandedDiff === null
  ) {
    return current
  }
  return {
    ...current,
    selectedOid: null,
    detail: null,
    detailLoading: false,
    detailError: null,
    expandedDiff: null
  }
}

export function gitHistoryToggleExpandedFile(
  current: GitHistoryDraftViewModel,
  fileId: string
): GitHistoryDraftViewModel {
  if (current.expandedDiff?.fileId === fileId) {
    return { ...current, expandedDiff: null }
  }
  return {
    ...current,
    expandedDiff: {
      fileId,
      loading: true,
      result: null,
      error: null
    }
  }
}

export function gitHistoryShowsDetail(view: GitHistoryDraftViewModel): boolean {
  return view.selectedOid !== null
}

export function gitHistoryHasMutationControls(source: string): boolean {
  return /\b(stageFile|unstageFile|prepareCommit|executeCommit|Stage|Unstage|Commit & Push)\b/.test(source)
}
