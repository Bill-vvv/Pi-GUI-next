import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { useModalDialog } from '../../components/useModalDialog'
import './git-changes.css'

export type GitCommitMode = 'commit' | 'commit-and-push' | 'amend'

export type GitCommitDialogUpstream = {
  remote: string
  branch: string
}

export type GitCommitDialogPreview = {
  stagedFileCount: number
  branch: string
  upstream: GitCommitDialogUpstream | null
  suggestedMessage: string
  canAmend: boolean
}

export type GitCommitDialogStepResult = {
  status: 'succeeded' | 'failed'
  detail?: string | null
}

export type GitCommitDialogPushResult = {
  status: 'succeeded' | 'failed' | 'skipped'
  detail?: string | null
}

export type GitCommitDialogRefreshResult = {
  status: 'ok' | 'warning' | 'failed'
  detail?: string | null
}

export type GitCommitDialogResult = {
  commit: GitCommitDialogStepResult
  push: GitCommitDialogPushResult
  refresh?: GitCommitDialogRefreshResult | null
}

export type GitCommitDialogProps = {
  preview: GitCommitDialogPreview
  busy: boolean
  result?: GitCommitDialogResult | null
  onCancel: () => void
  onSubmit: (mode: GitCommitMode, message: string) => void
}

export function isGitCommitMessageSubmittable(message: string): boolean {
  return message.trim().length > 0
}

export function gitCommitPushTargetLabel(upstream: GitCommitDialogUpstream | null): string {
  if (upstream === null) return '不可用（无上游）'
  return `${upstream.remote}/${upstream.branch}`
}

export function gitCommitActionDisabled(
  mode: GitCommitMode,
  {
    busy,
    canAmend,
    commitSucceeded,
    hasUpstream,
    message
  }: {
    busy: boolean
    canAmend: boolean
    commitSucceeded: boolean
    hasUpstream: boolean
    message: string
  }
): boolean {
  if (busy || commitSucceeded || !isGitCommitMessageSubmittable(message)) return true
  if (mode === 'commit-and-push' && !hasUpstream) return true
  if (mode === 'amend' && !canAmend) return true
  return false
}

export function gitCommitResultTone(
  status: 'succeeded' | 'failed' | 'skipped' | 'ok' | 'warning'
): 'success' | 'error' | 'warning' | 'muted' {
  switch (status) {
    case 'succeeded':
    case 'ok':
      return 'success'
    case 'failed':
      return 'error'
    case 'warning':
      return 'warning'
    case 'skipped':
      return 'muted'
  }
}

export function gitCommitResultLabel(
  kind: 'commit' | 'push' | 'refresh',
  status: 'succeeded' | 'failed' | 'skipped' | 'ok' | 'warning'
): string {
  if (kind === 'commit') {
    return status === 'succeeded' ? '提交成功' : '提交失败'
  }
  if (kind === 'push') {
    if (status === 'succeeded') return '推送成功'
    if (status === 'failed') return '推送失败'
    return '已跳过推送'
  }
  if (status === 'ok') return '状态已刷新'
  if (status === 'warning') return '刷新警告'
  return '刷新失败'
}

export function GitCommitDialog({
  preview,
  busy,
  result = null,
  onCancel,
  onSubmit
}: GitCommitDialogProps): React.JSX.Element {
  const generatedId = useId().replace(/[^a-zA-Z0-9_-]/g, '') || 'git-commit'
  const titleId = `${generatedId}-title`
  const descriptionId = `${generatedId}-description`
  const messageId = `${generatedId}-message`
  const resultId = `${generatedId}-result`
  const dialogRef = useRef<HTMLElement>(null)
  const messageRef = useRef<HTMLTextAreaElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const previousSuggestionRef = useRef(preview.suggestedMessage)
  const [message, setMessage] = useState(preview.suggestedMessage)

  useEffect(() => {
    setMessage((current) => current === previousSuggestionRef.current
      ? preview.suggestedMessage
      : current)
    previousSuggestionRef.current = preview.suggestedMessage
  }, [preview.suggestedMessage])

  useModalDialog({
    open: true,
    dialogRef,
    initialFocus: () => messageRef.current ?? cancelRef.current,
    dismissDisabled: busy,
    onDismiss: onCancel
  })

  const hasUpstream = preview.upstream !== null
  const commitSucceeded = result?.commit.status === 'succeeded'
  const messageSubmittable = isGitCommitMessageSubmittable(message)
  const describedBy = result === null ? descriptionId : `${descriptionId} ${resultId}`

  useEffect(() => {
    if (commitSucceeded) cancelRef.current?.focus()
  }, [commitSucceeded])

  const submit = (mode: GitCommitMode): void => {
    if (gitCommitActionDisabled(mode, {
      busy,
      canAmend: preview.canAmend,
      commitSucceeded,
      hasUpstream,
      message
    })) return
    onSubmit(mode, message)
  }

  return createPortal(
    <div
      className="git-commit-dialog-backdrop"
      onPointerDown={(event) => {
        event.stopPropagation()
        if (busy || event.target !== event.currentTarget) return
        onCancel()
      }}
    >
      <section
        ref={dialogRef}
        className="git-commit-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        aria-busy={busy}
        tabIndex={-1}
      >
        <header className="git-commit-dialog-header">
          <h2 id={titleId}>确认提交</h2>
          <p id={descriptionId}>
            将只提交当前已暂存内容，不会自动暂存其他变更。请确认目标分支、推送目标与提交说明。
          </p>
        </header>

        <dl className="git-commit-dialog-summary">
          <div>
            <dt>已暂存</dt>
            <dd>{preview.stagedFileCount === 1
              ? '1 个文件'
              : `${preview.stagedFileCount} 个文件`}
            </dd>
          </div>
          <div>
            <dt>分支</dt>
            <dd title={preview.branch}>{preview.branch}</dd>
          </div>
          <div>
            <dt>推送目标</dt>
            <dd
              className={hasUpstream ? undefined : 'unavailable'}
              title={gitCommitPushTargetLabel(preview.upstream)}
            >
              {gitCommitPushTargetLabel(preview.upstream)}
            </dd>
          </div>
          <div>
            <dt>Amend</dt>
            <dd className={preview.canAmend ? undefined : 'unavailable'}>
              {preview.canAmend ? '可用' : '不可用（没有可修改的现有提交）'}
            </dd>
          </div>
        </dl>

        <label className="git-commit-dialog-message" htmlFor={messageId}>
          <span>提交说明</span>
          <textarea
            ref={messageRef}
            id={messageId}
            value={message}
            rows={4}
            spellCheck={false}
            disabled={busy || commitSucceeded}
            aria-invalid={!messageSubmittable}
            onChange={(event) => setMessage(event.target.value)}
          />
        </label>

        {result === null ? null : (
          <div
            id={resultId}
            className="git-commit-dialog-result"
            role="status"
            aria-live="polite"
          >
            <GitCommitResultRow
              kind="commit"
              status={result.commit.status}
              detail={result.commit.detail}
            />
            <GitCommitResultRow
              kind="push"
              status={result.push.status}
              detail={result.push.detail}
            />
            {result.refresh == null || result.refresh.status === 'ok'
              ? null
              : (
                <GitCommitResultRow
                  kind="refresh"
                  status={result.refresh.status}
                  detail={result.refresh.detail}
                />
              )}
          </div>
        )}

        <footer className="git-commit-dialog-footer">
          <button
            ref={cancelRef}
            type="button"
            disabled={busy}
            onClick={onCancel}
          >
            {commitSucceeded ? '关闭' : '取消'}
          </button>
          <div className="git-commit-dialog-actions" role="group" aria-label="提交方式">
            <button
              type="button"
              disabled={gitCommitActionDisabled('commit', {
                busy,
                canAmend: preview.canAmend,
                commitSucceeded,
                hasUpstream,
                message
              })}
              onClick={() => submit('commit')}
            >
              {busy ? '提交中…' : 'Commit'}
            </button>
            <button
              type="button"
              className="primary"
              disabled={gitCommitActionDisabled('commit-and-push', {
                busy,
                canAmend: preview.canAmend,
                commitSucceeded,
                hasUpstream,
                message
              })}
              title={hasUpstream ? undefined : '当前分支没有上游，无法 Commit & Push'}
              onClick={() => submit('commit-and-push')}
            >
              {busy ? '提交中…' : 'Commit & Push'}
            </button>
            <button
              type="button"
              disabled={gitCommitActionDisabled('amend', {
                busy,
                canAmend: preview.canAmend,
                commitSucceeded,
                hasUpstream,
                message
              })}
              title={preview.canAmend ? undefined : '当前无法 Amend'}
              onClick={() => submit('amend')}
            >
              {busy ? '提交中…' : 'Amend'}
            </button>
          </div>
        </footer>
      </section>
    </div>,
    document.body
  )
}

function GitCommitResultRow({
  kind,
  status,
  detail
}: {
  kind: 'commit' | 'push' | 'refresh'
  status: 'succeeded' | 'failed' | 'skipped' | 'ok' | 'warning'
  detail?: string | null
}): React.JSX.Element {
  const tone = gitCommitResultTone(status)
  const label = gitCommitResultLabel(kind, status)
  const text = detail == null || detail.trim().length === 0 ? label : `${label}：${detail}`
  return (
    <p className={`git-commit-dialog-result-row ${tone}`}>
      {text}
    </p>
  )
}
