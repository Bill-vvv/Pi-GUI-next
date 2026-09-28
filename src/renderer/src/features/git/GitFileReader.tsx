import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { GIT_FILE_READ_MAX_BYTES, type GitFileChange, type GitFileReadRequest, type GitRepositoryState } from '../../../../shared/git-contract'
import { useModalDialog } from '../../components/useModalDialog'
import { unknownErrorMessage } from '../../unknown-error-message'
import { gitErrorText } from './git-changes-model'

type FileView = { text: string; byteCount: number } | { error: string } | null

export function useGitFileReader(state: GitRepositoryState | null): {
  request: GitFileReadRequest | null
  openFile: (file: GitFileChange) => void
  closeFile: () => void
} {
  const [request, setRequest] = useState<GitFileReadRequest | null>(null)
  useEffect(() => {
    setRequest((current) => current?.expectedStatusRevision === state?.statusRevision ? current : null)
  }, [state?.statusRevision])
  return {
    // Do not wait for effect cleanup to hide a response for the previous snapshot.
    request: state?.kind === 'repository' && request?.expectedStatusRevision === state.statusRevision ? request : null,
    openFile: (file) => {
      if (state?.kind !== 'repository' || state.repositoryRoot === null) return
      setRequest({ path: file.path, expectedRepositoryRoot: state.repositoryRoot,
        expectedHeadOid: state.headOid, expectedIndexTreeOid: state.indexTreeOid,
        expectedStatusRevision: state.statusRevision })
    },
    closeFile: () => setRequest(null)
  }
}

export function GitFileReader({ projectKey, request, onClose }: {
  projectKey: string
  request: GitFileReadRequest
  onClose: () => void
}): React.JSX.Element {
  const titleId = useId()
  const descriptionId = useId()
  const dialogRef = useRef<HTMLElement>(null)
  const [view, setView] = useState<FileView>(null)
  const [attempt, setAttempt] = useState(0)
  // Reads are always dismissible; cleanup discards their response, including in StrictMode.
  useModalDialog({ open: true, dialogRef, onDismiss: onClose })
  useEffect(() => {
    let current = true
    setView(null)
    void (async () => {
      try {
        const response = await window.piGit.readFile(projectKey, request)
        if (!current) return
        const result = response.result
        if (response.projectKey !== projectKey || result.path !== request.path) {
          throw new Error('文件响应目标已变化，请关闭后重新打开。')
        }
        if (result.state !== 'ready') {
          setView({ error: result.state === 'binary' ? '此文件不是可显示的 UTF-8 文本。'
            : result.state === 'oversized' ? '文件超过 256 KiB 阅读上限。'
            : result.error ? gitErrorText(result.error) : '文件暂不可读取，请刷新变更列表。' })
          return
        }
        if (result.statusRevision !== request.expectedStatusRevision || typeof result.text !== 'string' ||
          result.error !== null || !Number.isInteger(result.byteCount) || result.byteCount < 0 ||
          result.byteCount > GIT_FILE_READ_MAX_BYTES ||
          new TextEncoder().encode(result.text).byteLength > GIT_FILE_READ_MAX_BYTES) {
          throw new Error('文件响应与当前仓库状态或阅读限制不符，请刷新变更列表。')
        }
        setView({ text: result.text, byteCount: result.byteCount })
      } catch (error) {
        if (current) setView({ error: unknownErrorMessage(error) })
      }
    })()
    return () => { current = false }
  }, [projectKey, request, attempt])

  return createPortal(
    <div className="git-file-reader-backdrop" onClick={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section className="git-file-reader" ref={dialogRef} role="dialog" aria-modal="true"
        aria-labelledby={titleId} aria-describedby={descriptionId} aria-busy={view === null} tabIndex={-1}>
        <header className="git-file-reader-header">
          <h2 id={titleId}>当前工作区文件</h2>
          <button type="button" onClick={onClose} aria-label="关闭文件阅读">关闭</button>
        </header>
        <p id={descriptionId} className="git-file-reader-path">{request.path}</p>
        <p className="git-file-reader-meta">显示当前工作区全文，最多 256 KiB；暂存版本请查看 staged diff。</p>
        {view === null ? <p role="status">正在读取文件…</p> : 'error' in view ? (
          <div><p role="alert">{view.error}</p><button type="button" onClick={() => {
            setView(null)
            setAttempt((value) => value + 1)
          }}>重试读取</button></div>
        ) : <>
          <p className="git-file-reader-meta">{view.byteCount} 字节{view.text.length === 0 ? ' · 空文件' : ''}</p>
          <pre className="git-file-reader-text" tabIndex={0} aria-label="文件全文">{view.text}</pre>
        </>}
      </section>
    </div>, document.body
  )
}
