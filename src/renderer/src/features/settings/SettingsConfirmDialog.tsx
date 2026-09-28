import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { useModalDialog } from '../../components/useModalDialog'

export type SettingsConfirmRequest = {
  title: string
  description: React.ReactNode
  confirmLabel: string
  /** Destructive or irreversible actions use the error tone on the confirm button. */
  danger?: boolean
}

/**
 * In-app confirmation shared by settings pages. The caller owns any async work:
 * pass `busy` to keep the dialog open, block dismissal and show `busyLabel`
 * while the confirmed operation runs. The backdrop never dismisses.
 */
export function SettingsConfirmDialog({
  request,
  busy = false,
  busyLabel,
  onCancel,
  onConfirm
}: {
  request: SettingsConfirmRequest
  busy?: boolean
  busyLabel?: string
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  const dialogRef = useRef<HTMLElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  useModalDialog({
    open: true,
    dialogRef,
    initialFocus: () => cancelRef.current,
    dismissDisabled: busy,
    onDismiss: onCancel
  })

  return createPortal(
    <div
      className="settings-dialog-backdrop"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <section
        ref={dialogRef}
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy}
        tabIndex={-1}
      >
        <h2 id={titleId}>{request.title}</h2>
        <p id={descriptionId}>{request.description}</p>
        <div className="settings-dialog-actions">
          <button ref={cancelRef} type="button" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className={request.danger === true ? 'settings-dialog-danger' : undefined}
            disabled={busy}
            onClick={onConfirm}
          >
            {busy && busyLabel !== undefined ? busyLabel : request.confirmLabel}
          </button>
        </div>
      </section>
    </div>,
    document.body
  )
}

type PendingConfirmation = {
  request: SettingsConfirmRequest
  resolve: (confirmed: boolean) => void
}

/**
 * Promise-based replacement for `window.confirm` inside settings pages.
 * Render `confirmDialog` once in the page; `confirm` resolves `false` when the
 * user cancels, a newer request replaces it, or the page unmounts.
 */
export function useSettingsConfirm(): {
  confirm: (request: SettingsConfirmRequest) => Promise<boolean>
  confirmDialog: React.ReactNode
} {
  const [pending, setPending] = useState<PendingConfirmation | null>(null)
  const pendingRef = useRef<PendingConfirmation | null>(null)

  const settle = useCallback((confirmed: boolean) => {
    const current = pendingRef.current
    if (current === null) return
    pendingRef.current = null
    setPending(null)
    current.resolve(confirmed)
  }, [])

  const confirm = useCallback((request: SettingsConfirmRequest): Promise<boolean> => {
    pendingRef.current?.resolve(false)
    return new Promise<boolean>((resolve) => {
      const next = { request, resolve }
      pendingRef.current = next
      setPending(next)
    })
  }, [])

  useEffect(() => () => {
    pendingRef.current?.resolve(false)
    pendingRef.current = null
  }, [])

  return {
    confirm,
    confirmDialog: pending === null ? null : (
      <SettingsConfirmDialog
        request={pending.request}
        onCancel={() => settle(false)}
        onConfirm={() => settle(true)}
      />
    )
  }
}
