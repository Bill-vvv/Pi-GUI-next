import { useEffect, useId, useRef } from 'react'

import { Icon } from '../../components/Icon'
import {
  gitHistoryCommitAccessibleName,
  gitHistoryFileChangeLabel,
  gitHistoryFileDisplayPath,
  gitHistoryFormatTimestamp,
  gitHistoryListStatusText,
  gitHistoryShowsDetail,
  type GitHistoryChangedFile,
  type GitHistoryCommitDetail,
  type GitHistoryCommitSummary,
  type GitHistoryDraftViewModel,
  type GitHistoryExpandedDiff
} from './git-history-model'
import { GitDiffViewer } from './GitDiffViewer'
import './git-changes.css'

export type GitHistoryPanelProps = {
  view: GitHistoryDraftViewModel
  onSelectCommit: (oid: string) => void
  onLoadMore: () => void
  onBack: () => void
  onToggleFile: (fileId: string) => void
}

export function GitHistoryPanel({
  view,
  onSelectCommit,
  onLoadMore,
  onBack,
  onToggleFile
}: GitHistoryPanelProps): React.JSX.Element {
  const generatedId = useId().replace(/[^a-zA-Z0-9_-]/g, '') || 'git-history'
  const commitButtonRefs = useRef(new Map<string, HTMLButtonElement>())
  const backButtonRef = useRef<HTMLButtonElement>(null)
  const focusOidAfterBackRef = useRef<string | null>(null)
  const previousShowsDetailRef = useRef(gitHistoryShowsDetail(view))

  useEffect(() => {
    const showsDetail = gitHistoryShowsDetail(view)
    if (showsDetail && !previousShowsDetailRef.current) {
      backButtonRef.current?.focus()
    }
    if (!showsDetail && previousShowsDetailRef.current) {
      const oid = focusOidAfterBackRef.current
      focusOidAfterBackRef.current = null
      if (oid !== null) {
        const target = commitButtonRefs.current.get(oid)
        target?.focus()
      }
    }
    previousShowsDetailRef.current = showsDetail
  }, [view])

  if (gitHistoryShowsDetail(view)) {
    return (
      <GitHistoryDetailView
        generatedId={generatedId}
        selectedOid={view.selectedOid!}
        detail={view.detail}
        detailLoading={view.detailLoading}
        detailError={view.detailError}
        expandedDiff={view.expandedDiff}
        backButtonRef={backButtonRef}
        onBack={() => {
          focusOidAfterBackRef.current = view.selectedOid
          onBack()
        }}
        onToggleFile={onToggleFile}
      />
    )
  }

  return (
    <GitHistoryListView
      generatedId={generatedId}
      view={view}
      commitButtonRefs={commitButtonRefs}
      onSelectCommit={onSelectCommit}
      onLoadMore={onLoadMore}
    />
  )
}

function GitHistoryListView({
  generatedId,
  view,
  commitButtonRefs,
  onSelectCommit,
  onLoadMore
}: {
  generatedId: string
  view: GitHistoryDraftViewModel
  commitButtonRefs: React.MutableRefObject<Map<string, HTMLButtonElement>>
  onSelectCommit: (oid: string) => void
  onLoadMore: () => void
}): React.JSX.Element {
  if (view.listStatus !== 'ready') {
    const text = gitHistoryListStatusText(view.listStatus, view.listError)
    const isError = view.listStatus === 'error' ||
      view.listStatus === 'stale' ||
      view.listStatus === 'not-repository' ||
      view.listStatus === 'trust-required'
    return (
      <div
        className={`git-panel-state${isError ? ' error' : ''}`}
        role={isError ? 'alert' : 'status'}
      >
        {text}
      </div>
    )
  }

  if (view.commits.length === 0) {
    return (
      <div className="git-panel-state" role="status">
        {gitHistoryListStatusText('empty', null)}
      </div>
    )
  }

  return (
    <section className="git-history-list-section" aria-label="提交历史">
      {view.listTruncated ? (
        <p className="git-state-warning" role="status">
          提交历史已达到安全上限，仅显示有界结果。
        </p>
      ) : null}
      <ul className="git-history-list" aria-label="提交列表">
        {view.commits.map((commit) => {
          const selected = view.selectedOid === commit.oid
          return (
            <li className="git-history-item" key={commit.oid}>
              <button
                ref={(element) => {
                  if (element === null) commitButtonRefs.current.delete(commit.oid)
                  else commitButtonRefs.current.set(commit.oid, element)
                }}
                className="git-history-commit-button"
                type="button"
                id={`${generatedId}-commit-${commit.oid}`}
                aria-current={selected ? 'true' : undefined}
                aria-label={gitHistoryCommitAccessibleName(commit)}
                onClick={() => onSelectCommit(commit.oid)}
              >
                <span className="git-history-commit-oid" title={commit.oid}>
                  {commit.shortOid}
                </span>
                <span className="git-history-commit-subject" title={commit.subject}>
                  {commit.subject}
                </span>
                <span className="git-history-commit-meta">
                  <span className="git-history-commit-author">{commit.authorName}</span>
                  <span className="git-history-commit-time">
                    {gitHistoryFormatTimestamp(commit.authoredAt)}
                  </span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      {view.hasMore ? (
        <button
          className="git-history-load-more"
          type="button"
          disabled={view.loadingMore}
          onClick={onLoadMore}
        >
          {view.loadingMore ? '正在加载…' : '加载更多'}
        </button>
      ) : null}
    </section>
  )
}

function GitHistoryDetailView({
  generatedId,
  selectedOid,
  detail,
  detailLoading,
  detailError,
  expandedDiff,
  backButtonRef,
  onBack,
  onToggleFile
}: {
  generatedId: string
  selectedOid: string
  detail: GitHistoryCommitDetail | null
  detailLoading: boolean
  detailError: string | null
  expandedDiff: GitHistoryExpandedDiff | null
  backButtonRef: React.RefObject<HTMLButtonElement | null>
  onBack: () => void
  onToggleFile: (fileId: string) => void
}): React.JSX.Element {
  return (
    <section className="git-history-detail" aria-label="提交详情">
      <div className="git-history-detail-toolbar">
        <button
          ref={backButtonRef}
          className="git-history-back"
          type="button"
          aria-label="返回提交列表"
          onClick={onBack}
        >
          <Icon name="arrow-left" size="sm" />
          <span>返回</span>
        </button>
      </div>

      {detailLoading && detail === null ? (
        <p className="git-diff-state" role="status">正在读取提交详情…</p>
      ) : null}
      {detailError === null ? null : (
        <p className="git-diff-state error" role="alert">{detailError}</p>
      )}
      {detail === null ? null : (
        <GitHistoryDetailContent
          generatedId={generatedId}
          selectedOid={selectedOid}
          detail={detail}
          expandedDiff={expandedDiff}
          onToggleFile={onToggleFile}
        />
      )}
    </section>
  )
}

function GitHistoryDetailContent({
  generatedId,
  selectedOid,
  detail,
  expandedDiff,
  onToggleFile
}: {
  generatedId: string
  selectedOid: string
  detail: GitHistoryCommitDetail
  expandedDiff: GitHistoryExpandedDiff | null
  onToggleFile: (fileId: string) => void
}): React.JSX.Element {
  const commit = detail.commit
  return (
    <div className="git-history-detail-content">
      <header className="git-history-detail-header">
        <div className="git-history-detail-identity">
          <code className="git-history-detail-oid" title={commit.oid}>
            {commit.oid}
          </code>
          <h3 className="git-history-detail-subject">{commit.subject}</h3>
        </div>
        <dl className="git-history-detail-meta">
          <div>
            <dt>作者</dt>
            <dd>
              {commit.authorName}
              {commit.authorEmail === null ? null : ` <${commit.authorEmail}>`}
            </dd>
          </div>
          <div>
            <dt>作者时间</dt>
            <dd>{gitHistoryFormatTimestamp(commit.authoredAt)}</dd>
          </div>
          <div>
            <dt>提交者</dt>
            <dd>
              {commit.committerName}
              {commit.committerEmail === null ? null : ` <${commit.committerEmail}>`}
            </dd>
          </div>
          <div>
            <dt>提交时间</dt>
            <dd>{gitHistoryFormatTimestamp(commit.committedAt)}</dd>
          </div>
          <div>
            <dt>Parents</dt>
            <dd>
              {commit.parentOids.length === 0
                ? 'root'
                : commit.parentOids.map((oid) => (
                    <code className="git-history-parent-oid" key={oid}>{oid}</code>
                  ))}
            </dd>
          </div>
        </dl>
        <pre className="git-history-detail-message" aria-label="完整提交说明">
          {detail.message}
        </pre>
        {detail.messageTruncated ? (
          <p className="git-state-warning" role="status">提交说明已截断。</p>
        ) : null}
      </header>

      <section className="git-history-file-section" aria-label="变更文件">
        <div className="git-change-list-heading">
          <strong>Changed files</strong>
          <span className="git-history-file-count">{detail.files.length}</span>
        </div>
        {detail.filesTruncated ? (
          <p className="git-state-warning" role="status">
            变更文件列表已达到安全上限，仅显示前 {detail.files.length} 项。
          </p>
        ) : null}
        {detail.files.length === 0 ? (
          <p className="git-clean-state">此提交没有可显示的变更文件。</p>
        ) : (
          <ul className="git-change-list git-history-file-list">
            {detail.files.map((file, index) => (
              <GitHistoryFileRow
                key={file.fileId}
                generatedId={generatedId}
                selectedOid={selectedOid}
                file={file}
                index={index}
                expanded={expandedDiff?.fileId === file.fileId ? expandedDiff : null}
                onToggle={() => onToggleFile(file.fileId)}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function GitHistoryFileRow({
  generatedId,
  selectedOid,
  file,
  index,
  expanded,
  onToggle
}: {
  generatedId: string
  selectedOid: string
  file: GitHistoryChangedFile
  index: number
  expanded: GitHistoryExpandedDiff | null
  onToggle: () => void
}): React.JSX.Element {
  const isExpanded = expanded !== null
  const detailsId = `${generatedId}-history-file-${selectedOid}-${index}`
  const displayPath = gitHistoryFileDisplayPath(file)
  const changeLabel = gitHistoryFileChangeLabel(file.change)

  return (
    <li className="git-change-item">
      <div className="git-change-row">
        <button
          className="git-change-disclosure"
          type="button"
          aria-expanded={isExpanded}
          aria-controls={detailsId}
          onClick={onToggle}
        >
          <span className="git-change-disclosure-icon" aria-hidden="true">
            <Icon name={isExpanded ? 'chevron-down' : 'chevron-right'} size="sm" />
          </span>
          <span className="git-change-path" title={displayPath}>{displayPath}</span>
          <span className="git-change-state">{changeLabel}</span>
        </button>
      </div>
      {isExpanded ? (
        <div className="git-expanded-diff" id={detailsId}>
          {expanded.loading ? <p className="git-diff-state" role="status">正在读取 diff…</p> : null}
          {expanded.error === null ? null : (
            <p className="git-diff-state error" role="alert">{expanded.error}</p>
          )}
          {expanded.result === null || expanded.loading
            ? null
            : <GitDiffViewer result={expanded.result} />}
        </div>
      ) : null}
    </li>
  )
}

export type { GitHistoryCommitSummary }
