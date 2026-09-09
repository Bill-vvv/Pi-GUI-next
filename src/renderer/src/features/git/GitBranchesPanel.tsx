import { useId } from 'react'

import {
  gitBranchesListStatusText,
  gitBranchesLocalAccessibleName,
  gitBranchesPanelActionDisabled,
  gitBranchesUpstreamSummary,
  type GitBranchSyncConfirmPayload,
  type GitBranchSyncDialogState,
  type GitBranchesDraftViewModel,
  type GitBranchesLocalBranch,
  type GitBranchesRemoteGroup
} from './git-branches-model'
import { GitBranchSyncDialog } from './GitBranchSyncDialog'
import './git-changes.css'

export type GitBranchesPanelProps = {
  view: GitBranchesDraftViewModel
  busy?: boolean
  dialog?: GitBranchSyncDialogState | null
  onSelectLocalBranch: (branchId: string) => void
  onOpenCreate: () => void
  onOpenSwitch: () => void
  onOpenFetch: () => void
  onOpenPull: () => void
  onOpenPush: () => void
  onDialogCancel: () => void
  onDialogConfirm: (payload: GitBranchSyncConfirmPayload) => void
}

export function GitBranchesPanel({
  view,
  busy = false,
  dialog = null,
  onSelectLocalBranch,
  onOpenCreate,
  onOpenSwitch,
  onOpenFetch,
  onOpenPull,
  onOpenPush,
  onDialogCancel,
  onDialogConfirm
}: GitBranchesPanelProps): React.JSX.Element {
  const generatedId = useId().replace(/[^a-zA-Z0-9_-]/g, '') || 'git-branches'

  if (view.listStatus !== 'ready') {
    const text = gitBranchesListStatusText(view.listStatus, view.listError)
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

  const dialogBusy = dialog?.busy === true
  const controlsBusy = busy || dialogBusy
  const disabledReasons = [
    { action: 'create', label: 'Create', reason: view.actions.create.reason },
    { action: 'switch', label: 'Switch', reason: view.actions.switch.reason },
    { action: 'fetch', label: 'Fetch', reason: view.actions.fetch.reason },
    { action: 'pull', label: 'Pull', reason: view.actions.pull.reason },
    { action: 'push', label: 'Push', reason: view.actions.push.reason }
  ].filter((entry): entry is { action: string; label: string; reason: string } => entry.reason !== null)

  return (
    <section className="git-branches-panel" aria-label="分支与同步">
      <header className="git-branches-summary" aria-label="当前分支摘要">
        <div className="git-branches-summary-row">
          <span className="git-branches-summary-label">当前分支</span>
          <strong
            className="git-branches-summary-value"
            title={view.currentBranchLabel}
          >
            {view.currentBranchLabel}
          </strong>
        </div>
        <div className="git-branches-summary-row">
          <span className="git-branches-summary-label">Upstream</span>
          <span
            className={`git-branches-summary-value${view.upstreamText === null ? ' muted' : ''}`}
            title={gitBranchesUpstreamSummary(view.upstreamText, view.ahead, view.behind)}
          >
            {gitBranchesUpstreamSummary(view.upstreamText, view.ahead, view.behind)}
          </span>
        </div>
      </header>

      <div className="git-branches-actions" role="group" aria-label="分支与同步动作">
        <button
          type="button"
          className="git-branches-action"
          disabled={gitBranchesPanelActionDisabled(view.actions.create, controlsBusy)}
          title={view.actions.create.reason ?? undefined}
          aria-describedby={view.actions.create.reason === null ? undefined : `${generatedId}-create-reason`}
          onClick={onOpenCreate}
        >
          Create
        </button>
        <button
          type="button"
          className="git-branches-action"
          disabled={gitBranchesPanelActionDisabled(view.actions.switch, controlsBusy)}
          title={view.actions.switch.reason ?? undefined}
          aria-describedby={view.actions.switch.reason === null ? undefined : `${generatedId}-switch-reason`}
          onClick={onOpenSwitch}
        >
          Switch
        </button>
        <button
          type="button"
          className="git-branches-action"
          disabled={gitBranchesPanelActionDisabled(view.actions.fetch, controlsBusy)}
          title={view.actions.fetch.reason ?? undefined}
          aria-describedby={view.actions.fetch.reason === null ? undefined : `${generatedId}-fetch-reason`}
          onClick={onOpenFetch}
        >
          Fetch
        </button>
        <button
          type="button"
          className="git-branches-action"
          disabled={gitBranchesPanelActionDisabled(view.actions.pull, controlsBusy)}
          title={view.actions.pull.reason ?? undefined}
          aria-describedby={view.actions.pull.reason === null ? undefined : `${generatedId}-pull-reason`}
          onClick={onOpenPull}
        >
          Pull
        </button>
        <button
          type="button"
          className="git-branches-action primary"
          disabled={gitBranchesPanelActionDisabled(view.actions.push, controlsBusy)}
          title={view.actions.push.reason ?? undefined}
          aria-describedby={view.actions.push.reason === null ? undefined : `${generatedId}-push-reason`}
          onClick={onOpenPush}
        >
          Push
        </button>
      </div>
      {disabledReasons.length > 0 ? (
        <ul className="git-branches-action-reasons" aria-label="不可用动作说明">
          {disabledReasons.map((entry) => (
            <li key={entry.action} id={`${generatedId}-${entry.action}-reason`}>
              <strong>{entry.label}</strong>：{entry.reason}
            </li>
          ))}
        </ul>
      ) : null}

      <section className="git-branches-section" aria-label="本地分支">
        <div className="git-change-list-heading">
          <strong>本地分支</strong>
          <span className="git-branches-count">{view.localBranches.length}</span>
        </div>
        {view.localTruncated ? (
          <p className="git-state-warning" role="status">
            本地分支列表已达到安全上限，仅显示有界结果。
          </p>
        ) : null}
        {view.localBranches.length === 0 ? (
          <p className="git-clean-state">没有可显示的本地分支。</p>
        ) : (
          <ul className="git-branches-list" aria-label="本地分支列表">
            {view.localBranches.map((branch) => (
              <GitBranchesLocalRow
                key={branch.branchId}
                generatedId={generatedId}
                branch={branch}
                selected={view.selectedLocalBranchId === branch.branchId}
                disabled={controlsBusy}
                onSelect={() => onSelectLocalBranch(branch.branchId)}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="git-branches-section" aria-label="Remote-tracking 分支">
        <div className="git-change-list-heading">
          <strong>Remote-tracking</strong>
          <span className="git-branches-count">
            {view.remoteGroups.reduce((count, group) => count + group.branches.length, 0)}
          </span>
        </div>
        {view.trackingTruncated ? (
          <p className="git-state-warning" role="status">
            Remote-tracking 列表已达到安全上限，仅显示有界结果。
          </p>
        ) : null}
        {view.remotesTruncated ? (
          <p className="git-state-warning" role="status">
            配置 remote 列表已达到安全上限，仅显示有界结果。
          </p>
        ) : null}
        {view.remoteGroups.length === 0 ? (
          <p className="git-clean-state">没有可显示的 remote-tracking 分支。</p>
        ) : (
          view.remoteGroups.map((group) => (
            <GitBranchesRemoteGroupBlock
              key={group.remoteId}
              group={group}
            />
          ))
        )}
      </section>

      {dialog === null ? null : (
        <GitBranchSyncDialog
          preview={dialog.preview}
          busy={dialog.busy}
          result={dialog.result}
          onCancel={onDialogCancel}
          onConfirm={onDialogConfirm}
        />
      )}
    </section>
  )
}

function GitBranchesLocalRow({
  generatedId,
  branch,
  selected,
  disabled,
  onSelect
}: {
  generatedId: string
  branch: GitBranchesLocalBranch
  selected: boolean
  disabled: boolean
  onSelect: () => void
}): React.JSX.Element {
  const content = (
    <>
      <span className="git-branches-item-name" title={branch.name}>
        {branch.name}
      </span>
      {branch.isCurrent ? (
        <span className="git-branches-item-badge" aria-hidden="true">当前</span>
      ) : null}
      <span
        className={`git-branches-item-upstream${branch.upstreamText === null ? ' muted' : ''}`}
        title={branch.upstreamText ?? '无 upstream'}
      >
        {branch.upstreamText ?? '无 upstream'}
      </span>
    </>
  )
  return (
    <li className="git-branches-item">
      {branch.isCurrent ? (
        <div
          className="git-branches-item-button current"
          id={`${generatedId}-local-${branch.branchId}`}
          aria-current="true"
          aria-label={gitBranchesLocalAccessibleName(branch)}
        >
          {content}
        </div>
      ) : (
        <button
          className="git-branches-item-button"
          type="button"
          id={`${generatedId}-local-${branch.branchId}`}
          aria-pressed={selected}
          aria-label={gitBranchesLocalAccessibleName(branch)}
          disabled={disabled}
          onClick={onSelect}
        >
          {content}
        </button>
      )}
    </li>
  )
}

function GitBranchesRemoteGroupBlock({
  group
}: {
  group: GitBranchesRemoteGroup
}): React.JSX.Element {
  return (
    <div className="git-branches-remote-group" aria-label={`Remote ${group.name}`}>
      <div className="git-branches-remote-heading">
        <strong title={group.name}>{group.name}</strong>
        <span className="git-branches-count">{group.branches.length}</span>
      </div>
      {group.truncated ? (
        <p className="git-state-warning" role="status">
          Remote {group.name} 的 tracking 分支已截断。
        </p>
      ) : null}
      {group.branches.length === 0 ? (
        <p className="git-clean-state">该 remote 没有可显示的 tracking 分支。</p>
      ) : (
        <ul className="git-branches-list git-branches-remote-list" aria-label={`${group.name} tracking 分支`}>
          {group.branches.map((branch) => (
            <li className="git-branches-item" key={branch.branchId}>
              <div
                className="git-branches-item-static"
                title={branch.name}
              >
                <span className="git-branches-item-name">{branch.name}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
