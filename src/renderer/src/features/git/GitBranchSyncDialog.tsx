import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { Select, type SelectOptionGroup } from '../../components/Select'
import { useModalDialog } from '../../components/useModalDialog'
import {
  gitBranchSyncActionDescription,
  gitBranchSyncActionDisabled,
  gitBranchSyncActionTitle,
  gitBranchSyncBuildConfirmPayload,
  gitBranchSyncConfirmLabel,
  gitBranchSyncOverallLabel,
  gitBranchSyncResultTone,
  gitBranchSyncShouldShowPostView,
  gitBranchSyncStepLabel,
  isGitBranchNameSubmittable,
  type GitBranchSyncConfirmPayload,
  type GitBranchSyncDialogPreview,
  type GitBranchSyncDialogResult,
  type GitBranchSyncStepResult,
  type GitBranchSyncStepStatus
} from './git-branches-model'
import './git-changes.css'

export type GitBranchSyncDialogProps = {
  preview: GitBranchSyncDialogPreview
  busy: boolean
  result?: GitBranchSyncDialogResult | null
  onCancel: () => void
  onConfirm: (payload: GitBranchSyncConfirmPayload) => void
}

export function GitBranchSyncDialog({
  preview,
  busy,
  result = null,
  onCancel,
  onConfirm
}: GitBranchSyncDialogProps): React.JSX.Element {
  const generatedId = useId().replace(/[^a-zA-Z0-9_-]/g, '') || 'git-branch-sync'
  const titleId = `${generatedId}-title`
  const descriptionId = `${generatedId}-description`
  const nameId = `${generatedId}-name`
  const branchSelectId = `${generatedId}-branch-select`
  const remoteSelectId = `${generatedId}-remote-select`
  const resultId = `${generatedId}-result`
  const dialogRef = useRef<HTMLElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const previousSuggestionRef = useRef(preview.suggestedBranchName)
  const previousBranchIdRef = useRef(preview.selectedBranchId)
  const previousRemoteIdRef = useRef(preview.selectedRemoteId)

  const [branchName, setBranchName] = useState(preview.suggestedBranchName)
  const [selectedBranchId, setSelectedBranchId] = useState(preview.selectedBranchId)
  const [selectedRemoteId, setSelectedRemoteId] = useState(preview.selectedRemoteId)

  useEffect(() => {
    setBranchName((current) => current === previousSuggestionRef.current
      ? preview.suggestedBranchName
      : current)
    previousSuggestionRef.current = preview.suggestedBranchName
  }, [preview.suggestedBranchName])

  useEffect(() => {
    if (previousBranchIdRef.current !== preview.selectedBranchId) {
      setSelectedBranchId(preview.selectedBranchId)
      previousBranchIdRef.current = preview.selectedBranchId
    }
  }, [preview.selectedBranchId])

  useEffect(() => {
    if (previousRemoteIdRef.current !== preview.selectedRemoteId) {
      setSelectedRemoteId(preview.selectedRemoteId)
      previousRemoteIdRef.current = preview.selectedRemoteId
    }
  }, [preview.selectedRemoteId])

  useModalDialog({
    open: true,
    dialogRef,
    initialFocus: () => {
      if (preview.action === 'create') return nameRef.current ?? cancelRef.current
      return cancelRef.current
    },
    dismissDisabled: busy,
    onDismiss: onCancel
  })

  const operationSettled = result !== null
  const nameSubmittable = isGitBranchNameSubmittable(branchName)
  const confirmDisabled = gitBranchSyncActionDisabled(preview.action, {
    busy,
    blockedReason: preview.blockedReason,
    branchName,
    selectedBranchId,
    selectedRemoteId,
    operationSettled
  })
  const describedBy = result === null ? descriptionId : `${descriptionId} ${resultId}`

  useEffect(() => {
    if (result !== null) cancelRef.current?.focus()
  }, [result])

  const submit = (): void => {
    if (confirmDisabled) return
    const payload = gitBranchSyncBuildConfirmPayload(preview.action, {
      branchName,
      selectedBranchId,
      selectedRemoteId
    })
    if (payload === null) return
    onConfirm(payload)
  }

  const branchGroups: SelectOptionGroup[] = [{
    options: preview.localBranchOptions.map((option) => ({
      value: option.id,
      label: option.label,
      detail: option.detail,
      disabled: option.disabled
    }))
  }]
  const remoteGroups: SelectOptionGroup[] = [{
    options: preview.remoteOptions.map((option) => ({
      value: option.id,
      label: option.label,
      detail: option.detail,
      disabled: option.disabled
    }))
  }]

  return createPortal(
    <div
      className="git-branch-sync-dialog-backdrop"
      onPointerDown={(event) => {
        event.stopPropagation()
        if (busy || event.target !== event.currentTarget) return
        onCancel()
      }}
    >
      <section
        ref={dialogRef}
        className="git-branch-sync-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        aria-busy={busy}
        tabIndex={-1}
      >
        <header className="git-branch-sync-dialog-header">
          <h2 id={titleId}>{gitBranchSyncActionTitle(preview.action)}</h2>
          <p id={descriptionId}>{gitBranchSyncActionDescription(preview.action)}</p>
        </header>

        <dl className="git-branch-sync-dialog-summary">
          <div>
            <dt>当前</dt>
            <dd title={preview.currentBranchLabel}>{preview.currentBranchLabel}</dd>
          </div>
          {preview.action === 'pull' || preview.action === 'push' ? (
            <div>
              <dt>目标</dt>
              <dd
                className={preview.upstreamLabel === null ? 'unavailable' : undefined}
                title={preview.upstreamLabel ?? '不可用（无上游）'}
              >
                {preview.upstreamLabel ?? '不可用（无上游）'}
              </dd>
            </div>
          ) : null}
        </dl>

        {preview.action === 'create' ? (
          <label className="git-branch-sync-dialog-field" htmlFor={nameId}>
            <span>新分支名称</span>
            <input
              ref={nameRef}
              id={nameId}
              type="text"
              value={branchName}
              spellCheck={false}
              autoComplete="off"
              disabled={busy || operationSettled}
              aria-invalid={!nameSubmittable}
              onChange={(event) => setBranchName(event.target.value)}
            />
          </label>
        ) : null}

        {preview.action === 'switch' ? (
          <div className="git-branch-sync-dialog-field">
            <label htmlFor={branchSelectId}>目标本地分支</label>
            <Select
              id={branchSelectId}
              value={selectedBranchId ?? ''}
              groups={branchGroups}
              disabled={busy || operationSettled || preview.localBranchOptions.length === 0}
              onValueChange={setSelectedBranchId}
            />
          </div>
        ) : null}

        {preview.action === 'fetch' ? (
          <div className="git-branch-sync-dialog-field">
            <label htmlFor={remoteSelectId}>Remote</label>
            <Select
              id={remoteSelectId}
              value={selectedRemoteId ?? ''}
              groups={remoteGroups}
              disabled={busy || operationSettled || preview.remoteOptions.length === 0}
              onValueChange={setSelectedRemoteId}
            />
          </div>
        ) : null}

        {preview.blockedReason === null ? null : (
          <p className="git-branch-sync-dialog-blocked" role="status">
            {preview.blockedReason}
          </p>
        )}

        {result === null ? null : (
          <div
            id={resultId}
            className="git-branch-sync-dialog-result"
            role="status"
            aria-live="polite"
          >
            <p className={`git-branch-sync-dialog-result-row ${gitBranchSyncResultTone(result.overall)}`}>
              {gitBranchSyncOverallLabel(result.overall)}
            </p>
            <GitBranchSyncResultRow kind="branch" step={result.branch} />
            <GitBranchSyncResultRow kind="fetch" step={result.fetch} />
            <GitBranchSyncResultRow kind="fast-forward" step={result.fastForward} />
            <GitBranchSyncResultRow kind="push" step={result.push} />
            {gitBranchSyncShouldShowPostView(result.postView)
              ? <GitBranchSyncResultRow kind="post-view" step={result.postView} />
              : null}
          </div>
        )}

        <footer className="git-branch-sync-dialog-footer">
          <button
            ref={cancelRef}
            type="button"
            disabled={busy}
            onClick={onCancel}
          >
            {result === null ? '取消' : '关闭'}
          </button>
          <button
            type="button"
            className="primary"
            disabled={confirmDisabled}
            onClick={submit}
          >
            {busy ? '执行中…' : gitBranchSyncConfirmLabel(preview.action)}
          </button>
        </footer>
      </section>
    </div>,
    document.body
  )
}

function GitBranchSyncResultRow({
  kind,
  step
}: {
  kind: 'branch' | 'fetch' | 'fast-forward' | 'push' | 'post-view'
  step?: GitBranchSyncStepResult | null
}): React.JSX.Element | null {
  if (step == null || step.status === 'skipped') return null
  const status: GitBranchSyncStepStatus = step.status
  const tone = gitBranchSyncResultTone(status)
  const label = gitBranchSyncStepLabel(kind, status)
  const text = step.detail == null || step.detail.trim().length === 0
    ? label
    : `${label}：${step.detail}`
  return (
    <p className={`git-branch-sync-dialog-result-row ${tone}`}>
      {text}
    </p>
  )
}
