import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import type { KernelForkCandidate } from '../../../../shared/kernel-contract'
import { useModalDialog } from '../../components/useModalDialog'
import './session-operations.css'

type SessionForkDialogProps = {
  candidates: KernelForkCandidate[]
  loading: boolean
  error: string | null
  submitting: boolean
  preferredUserText?: string | null
  onCancel: () => void
  onRetry: () => void
  onSubmit: (entryId: string) => Promise<void>
}

export function SessionForkDialog({
  candidates,
  loading,
  error,
  submitting,
  preferredUserText = null,
  onCancel,
  onRetry,
  onSubmit
}: SessionForkDialogProps): React.JSX.Element {
  const dialogRef = useRef<HTMLElement>(null)
  const firstCandidateRef = useRef<HTMLInputElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null)

  useEffect(() => {
    if (candidates.length === 0) {
      setSelectedEntryId(null)
      return
    }
    setSelectedEntryId((current) => {
      if (current !== null && candidates.some(({ entryId }) => entryId === current)) {
        return current
      }
      const preferred = preferredUserText?.trim() ?? ''
      if (preferred.length > 0) {
        const match = candidates.find((candidate) => candidate.text === preferred)
        if (match !== undefined) return match.entryId
      }
      return candidates[0]!.entryId
    })
  }, [candidates, preferredUserText])

  useModalDialog({
    open: true,
    dialogRef,
    initialFocus: () => firstCandidateRef.current ?? closeRef.current,
    dismissDisabled: submitting,
    onDismiss: onCancel
  })

  return createPortal(
    <div className="session-fork-dialog-backdrop" onPointerDown={(event) => event.stopPropagation()}>
      <section
        ref={dialogRef}
        className="session-fork-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="session-fork-dialog-title"
        aria-describedby="session-fork-dialog-description"
        aria-busy={loading || submitting}
        tabIndex={-1}
      >
        <header className="session-fork-dialog-header">
          <h2 id="session-fork-dialog-title">分叉会话</h2>
          <p id="session-fork-dialog-description">
            选择当前活动路径中的一条用户消息。新会话会从该位置分叉，原消息将回填到输入框供你修改。
          </p>
        </header>

        <div className="session-fork-dialog-body">
          {loading ? (
            <p className="session-fork-dialog-state" role="status">正在读取可分叉消息…</p>
          ) : error !== null ? (
            <div className="session-fork-dialog-state error" role="alert">
              <span>{error}</span>
              <button type="button" disabled={submitting} onClick={onRetry}>重试</button>
            </div>
          ) : candidates.length === 0 ? (
            <p className="session-fork-dialog-state" role="status">
              当前活动路径中没有可分叉的用户消息。
            </p>
          ) : (
            <fieldset className="session-fork-candidates" disabled={submitting}>
              <legend>选择分叉位置</legend>
              {candidates.map((candidate, index) => (
                <label
                  className={`session-fork-candidate${selectedEntryId === candidate.entryId ? ' selected' : ''}`}
                  key={candidate.entryId}
                >
                  <input
                    ref={
                      (selectedEntryId === null ? index === 0 : candidate.entryId === selectedEntryId)
                        ? firstCandidateRef
                        : undefined
                    }
                    type="radio"
                    name="session-fork-candidate"
                    value={candidate.entryId}
                    checked={selectedEntryId === candidate.entryId}
                    onChange={() => setSelectedEntryId(candidate.entryId)}
                  />
                  <span className="session-fork-candidate-copy">{candidate.text}</span>
                  <time dateTime={candidate.timestamp}>{formatCandidateTime(candidate.timestamp)}</time>
                </label>
              ))}
            </fieldset>
          )}
        </div>

        <footer className="session-fork-dialog-footer">
          <button ref={closeRef} type="button" disabled={submitting} onClick={onCancel}>
            取消
          </button>
          <button
            className="primary"
            type="button"
            disabled={loading || submitting || error !== null || selectedEntryId === null}
            onClick={() => {
              if (selectedEntryId !== null) void onSubmit(selectedEntryId).catch(() => undefined)
            }}
          >
            {submitting ? '正在分叉…' : '分叉并编辑'}
          </button>
        </footer>
      </section>
    </div>,
    document.body
  )
}

function formatCandidateTime(timestamp: string): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return timestamp
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}
