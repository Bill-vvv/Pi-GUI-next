import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import type {
  RemoteAccessStatus,
  RemotePairingCode,
  TailscaleRemoteMode,
  TailscaleRemoteStatus
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
  onGetTailscaleStatus: () => Promise<TailscaleRemoteStatus>
  onEnableTailscaleFunnel: () => Promise<TailscaleRemoteStatus>
  onEnableTailscaleServe: () => Promise<TailscaleRemoteStatus>
  onDisableTailscale: () => Promise<TailscaleRemoteStatus>
  onOpenExternal: (url: string) => Promise<void>
}

type RemoteAccessAction =
  | 'create'
  | 'revoke'
  | 'enable-funnel'
  | 'enable-serve'
  | 'disable-tailscale'

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
  onRevokeDevice,
  onGetTailscaleStatus,
  onEnableTailscaleFunnel,
  onEnableTailscaleServe,
  onDisableTailscale,
  onOpenExternal
}: RemoteAccessPanelProps): React.JSX.Element {
  const [status, setStatus] = useState<RemoteAccessStatus | null>(null)
  const [tailscaleStatus, setTailscaleStatus] = useState<TailscaleRemoteStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [action, setAction] = useState<RemoteAccessAction | null>(null)
  const [pairingCode, setPairingCode] = useState<RemotePairingCode | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revokeOpen, setRevokeOpen] = useState(false)
  const mountedRef = useRef(true)
  const actionRef = useRef<RemoteAccessAction | null>(null)

  const refreshStatus = useCallback(async (): Promise<void> => {
    const [next, nextTailscale] = await Promise.all([
      onGetStatus(),
      onGetTailscaleStatus()
    ])
    if (!mountedRef.current) return
    setStatus(next)
    setTailscaleStatus(nextTailscale)
  }, [onGetStatus, onGetTailscaleStatus])

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

  async function changeTailscale(mode: Exclude<TailscaleRemoteMode, 'off'> | 'off'): Promise<void> {
    if (busy || actionRef.current !== null) return
    const nextAction: RemoteAccessAction = mode === 'off'
      ? 'disable-tailscale'
      : mode === 'funnel'
        ? 'enable-funnel'
        : 'enable-serve'
    actionRef.current = nextAction
    setAction(nextAction)
    setError(null)
    try {
      const next = mode === 'off'
        ? await onDisableTailscale()
        : mode === 'funnel'
          ? await onEnableTailscaleFunnel()
          : await onEnableTailscaleServe()
      if (!mountedRef.current) return
      setTailscaleStatus(next)
      if (mode === 'off') setPairingCode(null)
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
  const tailscaleMode = tailscaleStatus?.managedMode ?? 'off'
  const tailscaleReady = tailscaleStatus?.installed === true &&
    tailscaleStatus.backendState === 'Running' &&
    tailscaleStatus.routeState !== 'conflict'
  const manualRemoteActive = status?.enabled === true && tailscaleMode === 'off'

  return (
    <div className="remote-access-panel">
      {error === null ? null : (
        <p className="remote-access-error" role="alert">{error}</p>
      )}

      <section
        className="settings-group settings-group-inline settings-prefs"
        aria-labelledby="settings-tailscale-remote"
      >
        <h3 id="settings-tailscale-remote" className="settings-group-heading">一键联网</h3>
        <div className="settings-group-card">
          <div className="settings-row">
            <div className="settings-row-copy">
              <h4>任意浏览器 <span className="remote-access-default-label">默认</span></h4>
              <p>使用 Tailscale Funnel 创建公网 HTTPS 地址，不需要公网 IP、路由器映射或 Lucky。</p>
            </div>
            <div className="settings-row-control remote-access-actions">
              <button
                type="button"
                className="remote-access-action remote-access-action-primary"
                disabled={controlsDisabled || !tailscaleReady || manualRemoteActive || tailscaleMode === 'funnel'}
                onClick={() => {
                  void changeTailscale('funnel')
                }}
              >
                {action === 'enable-funnel'
                  ? '开启中…'
                  : tailscaleMode === 'funnel'
                    ? '公网已开启'
                    : '一键开启'}
              </button>
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-row-copy">
              <h4>仅我的设备</h4>
              <p>使用 Tailscale Serve，仅允许同一 Tailnet 中获准的设备访问。</p>
            </div>
            <div className="settings-row-control remote-access-actions">
              <button
                type="button"
                className="remote-access-action"
                disabled={controlsDisabled || !tailscaleReady || manualRemoteActive || tailscaleMode === 'serve'}
                onClick={() => {
                  void changeTailscale('serve')
                }}
              >
                {action === 'enable-serve'
                  ? '开启中…'
                  : tailscaleMode === 'serve'
                    ? '私有访问已开启'
                    : '仅我的设备'}
              </button>
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-row-copy">
              <h4>Tailscale 状态</h4>
              <p>{tailscaleStatusDescription(tailscaleStatus, manualRemoteActive)}</p>
              {tailscaleStatus?.publicOrigin ? (
                <code className="remote-access-origin">{tailscaleStatus.publicOrigin}</code>
              ) : null}
            </div>
            <div className="settings-row-control remote-access-actions">
              {tailscaleStatus?.authUrl ? (
                <button
                  type="button"
                  className="remote-access-action"
                  disabled={controlsDisabled}
                  onClick={() => {
                    void onOpenExternal(tailscaleStatus.authUrl!).catch((reason) => {
                      setError(unknownErrorMessage(reason))
                    })
                  }}
                >
                  登录 Tailscale
                </button>
              ) : null}
              {tailscaleMode !== 'off' ? (
                <button
                  type="button"
                  className="remote-access-action remote-access-action-danger"
                  disabled={controlsDisabled}
                  onClick={() => {
                    void changeTailscale('off')
                  }}
                >
                  {action === 'disable-tailscale' ? '停用中…' : '停用一键访问'}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      <section
        className="settings-group settings-group-inline settings-prefs"
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
        className="settings-group settings-group-inline settings-prefs"
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

function tailscaleStatusDescription(
  status: TailscaleRemoteStatus | null,
  manualRemoteActive: boolean
): string {
  if (manualRemoteActive) return '当前 Remote 由手动反向代理配置启用；一键模式不会接管。'
  if (status === null) return '正在检查 Tailscale…'
  if (!status.installed) return '未检测到 Tailscale，请先安装并登录。'
  if (status.backendState !== 'Running') {
    return `Tailscale 尚未就绪（${status.backendState ?? 'Unknown'}）。`
  }
  if (status.routeState === 'conflict') {
    return 'HTTPS 443 已有其他 Serve/Funnel 配置，Pi GUI 不会覆盖。'
  }
  if (status.managedMode === 'funnel' && status.routeState === 'active') {
    return '任意浏览器公网入口已开启。'
  }
  if (status.managedMode === 'serve' && status.routeState === 'active') {
    return '仅 Tailnet 设备可访问。'
  }
  if (status.managedMode !== 'off' && status.routeState === 'unavailable') {
    return '本机 Remote 已配置，但 Tailscale 路由需要重新启用。'
  }
  return 'Tailscale 已就绪，可以一键开启远程访问。'
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
