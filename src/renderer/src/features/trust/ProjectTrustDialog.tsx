import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import type {
  KernelProjectTrustChoice,
  KernelProjectTrustRequest
} from '../../../../shared/kernel-contract'
import { useModalDialog } from '../../components/useModalDialog'
import { unknownErrorMessage } from '../../unknown-error-message'
import './project-trust-dialog.css'

type ProjectTrustDialogProps = {
  request: KernelProjectTrustRequest
  onResolve: (requestId: string, choice: KernelProjectTrustChoice) => Promise<void>
}

const decisions: ReadonlyArray<{
  choice: Exclude<KernelProjectTrustChoice, 'cancel'>
  label: string
}> = [
  { choice: 'persist-trusted', label: '信任并记住此 Project' },
  { choice: 'persist-untrusted', label: '不信任并记住此 Project' },
  { choice: 'once-trusted', label: '仅本次信任' },
  { choice: 'once-untrusted', label: '仅本次不信任' }
]

export function ProjectTrustDialog({
  request,
  onResolve
}: ProjectTrustDialogProps): React.JSX.Element {
  const dialogRef = useRef<HTMLElement>(null)
  const firstDecisionRef = useRef<HTMLButtonElement>(null)
  const pendingRef = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const resolve = async (choice: KernelProjectTrustChoice): Promise<void> => {
    if (pendingRef.current) return
    pendingRef.current = true
    setPending(true)
    setError(null)
    try {
      await onResolve(request.id, choice)
    } catch (reason) {
      setError(unknownErrorMessage(reason))
      pendingRef.current = false
      setPending(false)
    }
  }

  useModalDialog({
    open: true,
    dialogRef,
    initialFocus: () => firstDecisionRef.current,
    dismissDisabled: pending,
    onDismiss: () => void resolve('cancel')
  })

  return createPortal(
    <div
      className="project-trust-dialog-backdrop"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <section
        ref={dialogRef}
        className="project-trust-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-trust-dialog-title"
        aria-describedby="project-trust-dialog-description"
        aria-busy={pending}
        tabIndex={-1}
      >
        <header className="project-trust-dialog-header">
          <h2 id="project-trust-dialog-title">加载此 Project 的项目资源？</h2>
          <p id="project-trust-dialog-description">
            此决定只控制来自该 Project 的 <code>.pi</code>、<code>.agents/skills</code> 等项目资源是否加载。
            它不是文件访问、Shell 或工具执行权限。
          </p>
        </header>

        <div className="project-trust-dialog-path">
          <span>当前 Project</span>
          <code>{request.projectPath}</code>
        </div>

        {error === null ? null : (
          <p className="project-trust-dialog-error" role="alert">
            {error}
          </p>
        )}

        <div className="project-trust-dialog-decisions">
          {decisions.map(({ choice, label }, index) => (
            <button
              ref={index === 0 ? firstDecisionRef : undefined}
              key={choice}
              type="button"
              disabled={pending}
              onClick={() => void resolve(choice)}
            >
              {label}
            </button>
          ))}
        </div>

        <footer className="project-trust-dialog-footer">
          <button
            className="project-trust-dialog-cancel"
            type="button"
            disabled={pending}
            onClick={() => void resolve('cancel')}
          >
            取消
          </button>
        </footer>
      </section>
    </div>,
    document.body
  )
}
