import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import type {
  RemoteAccessStatus,
  RemotePairingCode
} from '../../../../shared/remote-admin-contract'
import { REMOTE_PAIRING_CODE_LENGTH } from '../../../../shared/remote-contract'
import { useModalDialog } from '../../components/useModalDialog'
import { unknownErrorMessage } from '../../unknown-error-message'
import './remote-access-panel.css'

type RemoteAccessPanelProps = {
  busy: boolean
  onGetStatus: () => Promise<RemoteAccessStatus>
  onCreatePairingCode: () => Promise<RemotePairingCode>
  onRevokeDevice: () => Promise<RemoteAccessStatus>
}

function formatTimestamp(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value))
}

export function RemoteAccessPanel({
  busy,
  onGetStatus,
  onCreatePairingCode,
  onRevokeDevice
}: RemoteAccessPanelProps): React.JSX.Element {
  const [status, setStatus] = useState<RemoteAccessStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [action, setAction] = useState<'create' | 'revoke' | null>(null)
  const [pairingCode, setPairingCode] = useState<RemotePairingCode | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revokeOpen, setRevokeOpen] = useState(false)
  const mountedRef = useRef(true)
  const actionRef = useRef<'create' | 'revoke' | null>(null)

  const refreshStatus = useCallback(async (): Promise<void> => {
    const next = await onGetStatus()
    if (!mountedRef.current) return
    setStatus(next)
  }, [onGetStatus])

  useEffect(() => {
    mountedRef.current = true
    setLoading(true)
    setError(null)
    void refreshStatus()
      .catch((reason: unknown) => {
        if (!mountedRef.current) return
        setError(unknownErrorMessage(reason))
        setStatus(null)
      })
      .finally(() => {
        if (mountedRef.current) setLoading(false)
      })
    return () => {
      mountedRef.current = false
      setPairingCode(null)
    }
  }, [refreshStatus])

  useEffect(() => {
    if (pairingCode === null) return
    const remainingMs = pairingCode.expiresAt - Date.now()
    if (remainingMs <= 0) {
      setPairingCode(null)
      return
    }
    const handle = window.setTimeout(() => {
      setPairingCode(null)
    }, remainingMs)
    return () => {
      window.clearTimeout(handle)
    }
  }, [pairingCode])

  async function createPairingCode(): Promise<void> {
    if (busy || actionRef.current !== null) return
    actionRef.current = 'create'
    setAction('create')
    setError(null)
    try {
      const next = await onCreatePairingCode()
      if (!mountedRef.current) return
      if (
        typeof next.code !== 'string' ||
        next.code.length !== REMOTE_PAIRING_CODE_LENGTH ||
        !/^\d+$/u.test(next.code)
      ) {
        throw new Error('Main returned an invalid pairing code.')
      }
      setPairingCode(next)
      await refreshStatus()
    } catch (reason) {
      if (!mountedRef.current) return
      setError(unknownErrorMessage(reason))
    } finally {
      actionRef.current = null
      if (mountedRef.current) setAction(null)
    }
  }

  async function confirmRevoke(): Promise<void> {
    if (busy || actionRef.current !== null) return
    actionRef.current = 'revoke'
    setAction('revoke')
    setError(null)
    try {
      const next = await onRevokeDevice()
      if (!mountedRef.current) return
      setStatus(next)
      setPairingCode(null)
      setRevokeOpen(false)
    } catch (reason) {
      if (!mountedRef.current) return
      setError(unknownErrorMessage(reason))
    } finally {
      actionRef.current = null
      if (mountedRef.current) setAction(null)
    }
  }

  const controlsDisabled = busy || loading || action !== null
  const hasPairedDevice = status?.enabled === true && status.device !== null

  return (
    <div className="remote-access-panel">
      {error === null ? null : (
        <p className="remote-access-error" role="alert">{error}</p>
      )}

      <section
        className="settings-group settings-group-inline"
        aria-labelledby="settings-remote-status"
      >
        <h3 id="settings-remote-status" className="settings-group-heading">状态</h3>
        <div className="settings-group-card">
          <div className="settings-row">
            <div className="settings-row-copy">
              <h4>远程访问</h4>
              <p>仅在 Main 启用远程端点时可用；不会显示令牌或文件路径。</p>
            </div>
            <div className="settings-row-control">
              <span className="settings-value-chip" role="status">
                {loading
                  ? '检查中…'
                  : status === null
                    ? '未知'
                    : status.enabled
                      ? '已启用'
                      : '未启用'}
              </span>
            </div>
          </div>
          {status?.enabled === true ? (
            <div className="settings-row">
              <div className="settings-row-copy">
                <h4>公开地址</h4>
                <p>手机浏览器应打开的精确 HTTPS origin。</p>
              </div>
              <div className="settings-row-control">
                <code className="remote-access-origin">{status.publicOrigin}</code>
              </div>
            </div>
          ) : null}
        </div>
      </section>

      <section
        className="settings-group settings-group-inline"
        aria-labelledby="settings-remote-pairing"
      >
        <h3 id="settings-remote-pairing" className="settings-group-heading">配对</h3>
        <div className="settings-group-card">
          <div className="settings-row">
            <div className="settings-row-copy">
              <h4>配对码</h4>
              <p>生成 6 位一次性配对码，供手机在 5 分钟内使用。</p>
            </div>
            <div className="settings-row-control remote-access-actions">
              <button
                type="button"
                className="remote-access-action"
                disabled={controlsDisabled || status?.enabled !== true}
                onClick={() => {
                  void createPairingCode()
                }}
              >
                {action === 'create' ? '生成中…' : '生成配对码'}
              </button>
            </div>
          </div>

          <div
            className="remote-access-code-status"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {pairingCode === null ? (
              <p className="remote-access-code-empty">尚未生成配对码。</p>
            ) : (
              <>
                <p className="remote-access-code-digits">{pairingCode.code}</p>
                <p className="remote-access-code-hint">5 分钟内一次有效</p>
              </>
            )}
          </div>

          <div className="settings-row">
            <div className="settings-row-copy">
              <h4>已配对手机</h4>
              {hasPairedDevice && status.enabled ? (
                <p>
                  配对于 {formatTimestamp(status.device!.pairedAt)}
                  ，有效至 {formatTimestamp(status.device!.expiresAt)}
                </p>
              ) : (
                <p>当前没有已记住的手机。</p>
              )}
            </div>
            <div className="settings-row-control remote-access-actions">
              <button
                type="button"
                className="remote-access-action remote-access-action-danger"
                disabled={controlsDisabled || !hasPairedDevice}
                onClick={() => setRevokeOpen(true)}
              >
                撤销已配对手机
              </button>
            </div>
          </div>
        </div>
      </section>

      {revokeOpen ? (
        <RevokeDeviceDialog
          busy={action === 'revoke'}
          onCancel={() => {
            if (action === 'revoke') return
            setRevokeOpen(false)
          }}
          onConfirm={() => {
            void confirmRevoke()
          }}
        />
      ) : null}
    </div>
  )
}

function RevokeDeviceDialog({
  busy,
  onCancel,
  onConfirm
}: {
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  const dialogRef = useRef<HTMLElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  useModalDialog({
    open: true,
    dialogRef,
    initialFocus: () => cancelRef.current,
    dismissDisabled: busy,
    onDismiss: onCancel
  })

  return createPortal(
    <div
      className="remote-access-dialog-backdrop"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <section
        ref={dialogRef}
        className="remote-access-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="remote-access-revoke-title"
        aria-describedby="remote-access-revoke-description"
        aria-busy={busy}
        tabIndex={-1}
      >
        <h2 id="remote-access-revoke-title">撤销已配对手机？</h2>
        <p id="remote-access-revoke-description">
          撤销后，该手机会立即失去远程访问权限，需要重新生成配对码才能再次连接。
        </p>
        <div className="remote-access-dialog-actions">
          <button ref={cancelRef} type="button" disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="remote-access-action-danger"
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? '撤销中…' : '确认撤销'}
          </button>
        </div>
      </section>
    </div>,
    document.body
  )
}
