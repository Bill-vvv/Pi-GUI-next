import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ProjectDirectoryListing } from '../../../../shared/project-directory-contract'
import { useModalDialog } from '../../components/useModalDialog'
import { unknownErrorMessage } from '../../unknown-error-message'
import './remote-project-picker.css'

type RemoteProjectPickerProps = {
  onClose: () => void
  onSelect: (projectPath: string) => Promise<void>
}

export function RemoteProjectPicker({ onClose, onSelect }: RemoteProjectPickerProps): React.JSX.Element {
  const titleId = useId()
  const dialogRef = useRef<HTMLElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const sequence = useRef(0)
  const mounted = useRef(false)
  const selecting = useRef(false)
  const [path, setPath] = useState('')
  const [listing, setListing] = useState<Extract<ProjectDirectoryListing, { ok: true }> | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function browse(directoryPath?: string): Promise<void> {
    if (selecting.current) return
    const request = ++sequence.current
    setLoading(true)
    setListing(null)
    setError(null)
    if (directoryPath !== undefined) setPath(directoryPath)
    try {
      const result = await window.piGui.listProjectDirectories(directoryPath)
      if (!mounted.current || sequence.current !== request) return
      if (!result.ok) { setError(result.message); return }
      setListing(result)
      setPath(result.path)
    } catch (reason) {
      if (mounted.current && sequence.current === request) setError(unknownErrorMessage(reason))
    } finally {
      if (mounted.current && sequence.current === request) setLoading(false)
    }
  }

  useEffect(() => {
    mounted.current = true
    void browse()
    return () => { mounted.current = false; sequence.current += 1 }
  }, [])

  useModalDialog({
    open: true, dialogRef, initialFocus: () => inputRef.current,
    dismissDisabled: submitting, onDismiss: onClose
  })

  async function select(): Promise<void> {
    if (selecting.current || loading || listing === null || path !== listing.path) return
    selecting.current = true
    setSubmitting(true)
    setError(null)
    try {
      await onSelect(listing.path)
      if (mounted.current) onClose()
    } catch (reason) {
      if (mounted.current) setError(unknownErrorMessage(reason))
    } finally {
      selecting.current = false
      if (mounted.current) setSubmitting(false)
    }
  }

  return createPortal(
    <div className="remote-project-picker-backdrop" onPointerDown={(event) => event.stopPropagation()}>
      <section ref={dialogRef} className="remote-project-picker" role="dialog" aria-modal="true"
        aria-labelledby={titleId} aria-busy={loading || submitting} tabIndex={-1}>
        <header>
          <h2 id={titleId}>选择 Linux 项目目录</h2>
          <p>目录位于当前连接的 Linux 主机。</p>
        </header>
        <form onSubmit={(event) => {
          event.preventDefault()
          if (!submitting && path.length > 0) void browse(path)
        }}>
          <label htmlFor={`${titleId}-path`}>Linux 绝对路径</label>
          <div className="remote-project-picker-path">
            <input id={`${titleId}-path`} ref={inputRef} value={path} autoComplete="off" spellCheck={false}
              disabled={submitting} maxLength={4096} placeholder="/home/…"
              onChange={(event) => {
                sequence.current += 1
                setLoading(false)
                setPath(event.target.value)
                setListing(null)
                setError(null)
              }} />
            <button type="submit" disabled={submitting || path.length === 0}>打开</button>
          </div>
        </form>
        <nav aria-label="目录导航">
          <button type="button" disabled={submitting} onClick={() => void browse()}>主目录</button>
          <button type="button" disabled={loading || submitting || listing?.parentPath == null}
            onClick={() => { if (listing?.parentPath) void browse(listing.parentPath) }}>上一级</button>
        </nav>
        {loading ? <p role="status">正在读取目录…</p> : null}
        {error === null ? null : <p className="remote-project-picker-error" role="alert">{error}</p>}
        {listing === null ? null : <>
          <p className="remote-project-picker-current">当前目录：<code>{listing.path}</code></p>
          {listing.entries.length === 0 ? <p>没有可显示的子目录，可选择当前目录或输入其他路径。</p> : null}
          <ul aria-label="子目录">
            {listing.entries.map((entry) => <li key={entry.path}>
              <button type="button" disabled={submitting} onClick={() => void browse(entry.path)}>
                <span>{entry.name}</span>{entry.symbolicLink ? <small>目录链接</small> : null}
              </button>
            </li>)}
          </ul>
          {listing.truncated ? <p role="status">条目较多或包含不支持的路径，当前只显示部分结果。可输入完整子目录路径继续。</p> : null}
          {listing.inaccessibleLinks > 0 ? <p role="status">有 {listing.inaccessibleLinks} 个链接无法访问。</p> : null}
        </>}
        <footer>
          <button type="button" disabled={submitting} onClick={onClose}>取消</button>
          <button type="button" disabled={loading || submitting || listing === null || path !== listing.path}
            onClick={() => void select()}>{submitting ? '正在添加…' : '选择当前目录'}</button>
        </footer>
      </section>
    </div>, document.body
  )
}
