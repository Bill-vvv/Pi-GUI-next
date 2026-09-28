import { useCallback, useEffect, useRef, useState } from 'react'

import type {
  DesktopHostAccessStatus,
  RemotePairingCode
} from '../../../../shared/remote-admin-contract'
import { REMOTE_PAIRING_CODE_LENGTH } from '../../../../shared/remote-contract'
import { unknownErrorMessage } from '../../unknown-error-message'
import { SettingsConfirmDialog } from './SettingsConfirmDialog'
import './remote-access-panel.css'

export type DesktopHostAccessPanelProps = {
  busy: boolean
  onGetStatus: () => Promise<DesktopHostAccessStatus>
  onCreatePairingCode: () => Promise<RemotePairingCode>
  onRevokeDevice: () => Promise<DesktopHostAccessStatus>
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

export function DesktopHostAccessPanel({
  busy,
  onGetStatus,
  onCreatePairingCode,
  onRevokeDevice
}: DesktopHostAccessPanelProps): React.JSX.Element {
  const [status, setStatus] = useState<DesktopHostAccessStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [action, setAction] = useState<'create' | 'revoke' | null>(null)
  const [pairingCode, setPairingCode] = useState<RemotePairingCode | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revokeOpen, setRevokeOpen] = useState(false)
  const mountedRef = useRef(true)
  const actionRef = useRef<'create' | 'revoke' | null>(null)

  const refreshStatus = useCallback(async (): Promise<void> => {
    const next = await onGetStatus()
    if (mountedRef.current) setStatus(next)
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
    const handle = window.setTimeout(() => setPairingCode(null), remainingMs)
    return () => window.clearTimeout(handle)
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
        throw new Error('Main returned an invalid Desktop Host pairing code.')
      }
      setPairingCode(next)
      await refreshStatus()
    } catch (reason) {
      if (mountedRef.current) setError(unknownErrorMessage(reason))
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
      if (mountedRef.current) setError(unknownErrorMessage(reason))
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
        <p className="settings-feedback settings-feedback-error settings-feedback-inset" role="alert">{error}</p>
      )}

      <section
        className="settings-group settings-group-inline settings-prefs"
        aria-labelledby="settings-desktop-host-status"
      >
        <h3 id="settings-desktop-host-status" className="settings-group-heading">
          Desktop Host（SSH）
        </h3>
        <div className="settings-group-card">
          <div className="settings-row">
            <div className="settings-row-copy">
              <h4>桌面远程客户端</h4>
              <p>只监听 Linux loopback，供 Windows Pi GUI 通过 SSH 隧道连接。</p>
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
                <h4>Linux loopback 端点</h4>
                <p>该地址不得直接映射到 LAN 或公网。</p>
              </div>
              <div className="settings-row-control">
                <code className="remote-access-origin">{status.endpoint}</code>
              </div>
            </div>
          ) : null}
        </div>
      </section>

      <section
        className="settings-group settings-group-inline settings-prefs"
        aria-labelledby="settings-desktop-host-pairing"
      >
        <h3 id="settings-desktop-host-pairing" className="settings-group-heading">
          Windows 桌面配对
        </h3>
        <div className="settings-group-card">
          <div className="settings-row">
            <div className="settings-row-copy">
              <h4>一次性配对码</h4>
              <p>供 Windows Pi GUI 在 SSH 隧道建立后于 5 分钟内使用。</p>
            </div>
            <div className="settings-row-control remote-access-actions">
              <button
                type="button"
                className="remote-access-action"
                disabled={controlsDisabled || status?.enabled !== true}
                onClick={() => { void createPairingCode() }}
              >
                {action === 'create' ? '生成中…' : '生成桌面配对码'}
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
              <p className="settings-feedback">尚未生成桌面配对码。</p>
            ) : (
              <>
                <p className="remote-access-code-digits">{pairingCode.code}</p>
                <p className="remote-access-code-hint">5 分钟内一次有效</p>
              </>
            )}
          </div>

          <div className="settings-row">
            <div className="settings-row-copy">
              <h4>已配对 Windows 客户端</h4>
              {hasPairedDevice && status.enabled ? (
                <p>
                  配对于 {formatTimestamp(status.device!.pairedAt)}，有效至{' '}
                  {formatTimestamp(status.device!.expiresAt)}
                </p>
              ) : (
                <p>当前没有已记住的 Windows 客户端。</p>
              )}
            </div>
            <div className="settings-row-control remote-access-actions">
              <button
                type="button"
                className="remote-access-action remote-access-action-danger"
                disabled={controlsDisabled || !hasPairedDevice}
                onClick={() => setRevokeOpen(true)}
              >
                撤销 Windows 客户端
              </button>
            </div>
          </div>
        </div>
      </section>

      {revokeOpen ? (
        <SettingsConfirmDialog
          request={{
            title: '撤销 Windows 客户端？',
            description: '该设备凭证和活动事件连接会立即失效。',
            confirmLabel: '确认撤销',
            danger: true
          }}
          busy={action === 'revoke'}
          busyLabel="撤销中…"
          onCancel={() => {
            if (action !== 'revoke') setRevokeOpen(false)
          }}
          onConfirm={() => { void confirmRevoke() }}
        />
      ) : null}
    </div>
  )
}
