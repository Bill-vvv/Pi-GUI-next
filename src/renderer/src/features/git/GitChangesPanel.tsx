import { useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Icon } from '../../components/Icon'
import { IconButton } from '../../components/IconButton'
import { Select } from '../../components/Select'
import type { GitDiffKind, GitFileChange, GitRepositoryState } from '../../../../shared/git-contract'
import {
  gitActionsForScope, gitBranchLabel, gitChangeScopeCount, gitDiffKindsForScope,
  gitErrorText, gitFileDisplayPath, gitFileMatchesScope, gitFileStateLabel, gitUpstreamLabel,
  gitMutationOperationKey,
  shouldCancelGitDiffPrefetch, type GitChangeScope, type GitFileAction
} from './git-changes-model'
import { GIT_DIFF_MAX_EXPANDED_FILES } from './git-diff-cache'
import { gitPanelSubviewFromKey, GIT_HISTORY_SUBVIEWS, type GitPanelSubview } from './git-history-model'
import { GitCommitDialog } from './GitCommitDialog'
import { GitBranchesPanel } from './GitBranchesPanel'
import { GitDiffViewer } from './GitDiffViewer'
import { GitFileReader, useGitFileReader } from './GitFileReader'
import { GitHistoryPanel } from './GitHistoryPanel'
import { useGitRepository } from './use-git-repository'
import { useGitChanges, type ExpandedDiff } from './use-git-changes'
import { useGitHistory } from './use-git-history'
import { useGitBranches } from './use-git-branches'
import './git-changes.css'

type GitChangesPanelProps = { projectKey: string; readOnly?: boolean; remote?: boolean }

export function GitChangesPanel({ projectKey, readOnly = false, remote = false }: GitChangesPanelProps): React.JSX.Element {
  // Project changes replace the entire local workflow, including open dialogs and caches.
  return <GitProjectPanel key={`${projectKey}:${readOnly}:${remote}`} projectKey={projectKey} readOnly={readOnly} remote={remote} />
}

function GitProjectPanel({ projectKey, readOnly, remote }: Required<GitChangesPanelProps>): React.JSX.Element {
  const subviews = readOnly || remote ? GIT_HISTORY_SUBVIEWS.filter((view) => view !== 'branches') : GIT_HISTORY_SUBVIEWS
  const generatedId = useId().replace(/[^a-zA-Z0-9_-]/g, '') || 'git'
  const [subview, setSubview] = useState<GitPanelSubview>('changes')
  const subviewTabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const repository = useGitRepository(projectKey)
  const {
    generationRef, state: visibleState, initialError: visibleInitialError,
    refreshing, authorizing, notice, setNotice, refreshState, authorizeAncestorRepository
  } = repository
  const { request: fileRequest, openFile, closeFile } = useGitFileReader(visibleState)
  const {
    scope, setScope, expandedDiffs, pendingMutations, commitPreparing, commitDialog,
    clearExpandedDiffs, toggleFile, scheduleDiffPrefetch, cancelDiffPrefetch, mutateFile,
    prepareCommit, submitCommit, closeCommitDialog
  } = useGitChanges(repository, visibleState)
  const {
    historyDraft, activateHistory, selectHistoryCommit, loadMoreHistory,
    toggleHistoryFile, closeHistoryDetail
  } = useGitHistory(repository, visibleState, subview === 'history')
  const {
    branchesDraft, branchPreparing, branchDialog, activateBranches, selectLocalBranch,
    openBranchDialog, closeBranchDialog, submitBranchSync
  } = useGitBranches(repository)

  const selectSubview = (next: GitPanelSubview): void => {
    if ((readOnly || remote) && next === 'branches') return
    closeFile()
    setSubview(next)
    if (next === 'history') activateHistory(false)
    if (next === 'branches') activateBranches(false)
  }

  const refreshPanel = async (): Promise<void> => {
    closeFile()
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
    const next = gitPanelSubviewFromKey(subviews, index, event.key)
    if (next === null) return
    event.preventDefault()
    const nextIndex = subviews.findIndex((candidate) => candidate === next)
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
          <span className="git-changes-kicker">{readOnly ? '只读审阅' : 'Repository'}</span>
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
        {subviews.map((candidate, index) => {
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
            readOnly={readOnly}
            commitOnly={remote}
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
            onReadFile={openFile}
            onPrefetchFile={(file, kind) => scheduleDiffPrefetch(visibleState, file, kind)}
            onCancelPrefetch={(file, kind) => cancelDiffPrefetch(visibleState, file, kind)}
            onMutate={(file, action) => { if (!readOnly) void mutateFile(visibleState, file, action) }}
            onPrepareCommit={() => { if (!readOnly) void prepareCommit(visibleState) }}
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

      {readOnly || remote ? null : <div
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
            onSelectLocalBranch={selectLocalBranch}
            onOpenCreate={() => openBranchDialog('create')}
            onOpenSwitch={() => openBranchDialog('switch')}
            onOpenFetch={() => openBranchDialog('fetch')}
            onOpenPull={() => openBranchDialog('pull')}
            onOpenPush={() => openBranchDialog('push')}
            onDialogCancel={closeBranchDialog}
            onDialogConfirm={(payload) => void submitBranchSync(payload)}
          />
        )}
      </div>}

      {fileRequest === null ? null : (
        <GitFileReader key={`${fileRequest.expectedStatusRevision}:${fileRequest.path}`}
          projectKey={projectKey} request={fileRequest} onClose={closeFile} />
      )}

      {readOnly || commitDialog === null ? null : (
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
          commitOnly={remote}
          result={commitDialog.result}
          onCancel={closeCommitDialog}
          onSubmit={(mode, message) => { if (!remote || mode === 'commit') void submitCommit(mode, message) }}
        />
      )}
    </section>
  )
}

function GitRepositoryContent({
  readOnly,
  commitOnly,
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
  onReadFile,
  onPrefetchFile,
  onCancelPrefetch,
  onMutate,
  onPrepareCommit
}: {
  readOnly: boolean
  commitOnly: boolean
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
  onReadFile: (file: GitFileChange) => void
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

      {readOnly ? null : <section className="git-repository-commit" aria-label="提交已暂存变更">
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
          {commitPreparing ? '准备中…' : commitOnly ? '提交' : 'Commit & Push'}
        </button>
        <span>
          {stagedFileCount === 0
            ? '请先暂存至少一个文件。'
            : `将确认 ${stagedFileCount} 个已暂存文件；不会自动暂存。`}
        </span>
      </section>}

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
              const actions = readOnly ? [] : gitActionsForScope(file, scope)
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
                    <button type="button" className="git-file-read-button"
                      disabled={refreshing || fileMutationPending}
                      aria-label={`查看当前文件：${file.path}`} onClick={() => onReadFile(file)}>
                      全文
                    </button>
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
