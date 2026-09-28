import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconButton } from '../../components/IconButton'
import { useModalDialog } from '../../components/useModalDialog'
import { unknownErrorMessage } from '../../unknown-error-message'
import './host-connection-actions.css'

export function HostConnectionActions({ hostAlias, onDisconnect, onRevokePairing }: {
  hostAlias: string
  onDisconnect: () => Promise<void>
  onRevokePairing?: () => Promise<void>
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = useRef(false)
  const mounted = useRef(false)
  const dialogRef = useRef<HTMLElement>(null)
  const headingId = useId()
  const descriptionId = useId()
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useModalDialog({ open, dialogRef, dismissDisabled: busy, onDismiss: () => setOpen(false) })

  async function perform(action: () => Promise<void>): Promise<void> {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError(null)
    try {
      await action()
      if (mounted.current) setOpen(false)
    } catch (cause) {
      if (mounted.current) setError(unknownErrorMessage(cause))
    } finally {
      pending.current = false
      if (mounted.current) setBusy(false)
    }
  }

  return <>
    <IconButton className="sidebar-disconnect-host" icon="remote" iconSize="lg" label="管理 Host 连接"
      aria-haspopup="dialog" aria-expanded={open} onClick={() => { setError(null); setOpen(true) }} />
    {open ? createPortal(<div className="host-connection-backdrop" onClick={(event) => {
      if (!pending.current && event.target === event.currentTarget) setOpen(false)
    }}>
      <section ref={dialogRef} className="host-connection-dialog" role="dialog" aria-modal="true"
        aria-labelledby={headingId} aria-describedby={descriptionId} aria-busy={busy} tabIndex={-1}>
        <header><h2 id={headingId}>Host 连接</h2><button type="button" disabled={busy} onClick={() => setOpen(false)}>关闭</button></header>
        <p id={descriptionId}>当前主机：{hostAlias}</p>
        <div><button type="button" disabled={busy} onClick={() => { void perform(onDisconnect) }}>断开连接</button>
          <p>保留配对，下次可以直接连接。Host 上的任务继续运行。</p></div>
        {onRevokePairing === undefined ? null : <div>
          <button type="button" disabled={busy} onClick={() => { void perform(onRevokePairing) }}>取消配对</button>
          <p>撤销此桌面设备的访问并删除本机凭证。再次连接需要在 Host 生成新的配对码。</p>
        </div>}
        {busy ? <p role="status">正在处理，请等待连接释放…</p> : null}
        {error === null ? null : <p className="host-connection-error" role="alert">{error}</p>}
      </section>
    </div>, document.body) : null}
  </>
}
