import { useId, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'

import type { KernelExtensionDialogRequest } from '../../../../shared/kernel-contract'
import { useModalDialog } from '../../components/useModalDialog'
import { unknownErrorMessage } from '../../unknown-error-message'
import './extension-dialog.css'

const MAX_RESPONSE_CHARS = 16_000

type ExtensionDialogProps = {
  request: KernelExtensionDialogRequest
  onRespond: (request: KernelExtensionDialogRequest, value: string) => Promise<void>
  onCancel: (request: KernelExtensionDialogRequest) => Promise<void>
}

export function ExtensionDialog({
  request,
  onRespond,
  onCancel
}: ExtensionDialogProps): React.JSX.Element {
  const generatedId = useId().replace(/[^a-zA-Z0-9_-]/g, '') || 'extension-dialog'
  const titleId = `${generatedId}-title`
  const descriptionId = `${generatedId}-description`
  const dialogRef = useRef<HTMLElement>(null)
  const selectRef = useRef<HTMLSelectElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const pendingRef = useRef(false)
  const [value, setValue] = useState(() => initialExtensionDialogValue(request))
  const [pending, setPending] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const busy = pending || request.status === 'submitting'

  const respond = async (response: string): Promise<void> => {
    if (pendingRef.current || request.status === 'submitting') return
    pendingRef.current = true
    setPending(true)
    setLocalError(null)
    try {
      await onRespond(request, response)
    } catch (error) {
      pendingRef.current = false
      setPending(false)
      setLocalError(unknownErrorMessage(error))
    }
  }

  const cancel = async (): Promise<void> => {
    if (pendingRef.current || request.status === 'submitting') return
    pendingRef.current = true
    setPending(true)
    setLocalError(null)
    try {
      await onCancel(request)
    } catch (error) {
      pendingRef.current = false
      setPending(false)
      setLocalError(unknownErrorMessage(error))
    }
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (request.method === 'confirm') {
      void respond('true')
      return
    }
    void respond(value)
  }

  useModalDialog({
    open: true,
    dialogRef,
    initialFocus: () => {
      if (request.method === 'select') return selectRef.current
      if (request.method === 'input') return inputRef.current
      if (request.method === 'editor') return editorRef.current
      return confirmRef.current
    },
    dismissDisabled: busy,
    onDismiss: () => void cancel()
  })

  const error = localError ?? request.error

  return createPortal(
    <div
      className="extension-dialog-backdrop"
      onPointerDown={(event) => {
        event.stopPropagation()
        if (event.target === event.currentTarget && !busy) void cancel()
      }}
    >
      <section
        ref={dialogRef}
        className="extension-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        aria-busy={busy}
        tabIndex={-1}
      >
        <header className="extension-dialog-header">
          <span>Extension 命令 /{request.commandName}</span>
          <h2 id={titleId}>{request.title || '需要你的输入'}</h2>
          <p id={descriptionId}>
            {request.method === 'confirm'
              ? request.message
              : extensionDialogInstruction(request.method)}
          </p>
        </header>

        <form onSubmit={submit}>
          {request.method === 'select' ? (
            <label className="extension-dialog-field">
              <span>选择一项</span>
              <select
                ref={selectRef}
                value={value}
                disabled={busy}
                onChange={(event) => setValue(event.target.value)}
              >
                {request.options.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </label>
          ) : null}

          {request.method === 'input' ? (
            <label className="extension-dialog-field">
              <span>输入</span>
              <input
                ref={inputRef}
                type="text"
                value={value}
                placeholder={request.placeholder ?? undefined}
                maxLength={MAX_RESPONSE_CHARS}
                disabled={busy}
                onChange={(event) => setValue(event.target.value)}
              />
            </label>
          ) : null}

          {request.method === 'editor' ? (
            <label className="extension-dialog-field">
              <span>内容</span>
              <textarea
                ref={editorRef}
                value={value}
                maxLength={MAX_RESPONSE_CHARS}
                disabled={busy}
                rows={10}
                onChange={(event) => setValue(event.target.value)}
              />
            </label>
          ) : null}

          {error === null ? null : (
            <p className="extension-dialog-error" role="alert">{error}</p>
          )}

          <footer className="extension-dialog-actions">
            <button type="button" disabled={busy} onClick={() => void cancel()}>
              取消
            </button>
            <button
              ref={confirmRef}
              className="extension-dialog-primary"
              type="submit"
              disabled={busy}
            >
              {busy ? '正在提交…' : request.method === 'confirm' ? '确认' : '提交'}
            </button>
          </footer>
        </form>
      </section>
    </div>,
    document.body
  )
}

function initialExtensionDialogValue(request: KernelExtensionDialogRequest): string {
  if (request.method === 'select') return request.options[0] ?? ''
  if (request.method === 'editor') return request.prefill ?? ''
  return ''
}

function extensionDialogInstruction(method: KernelExtensionDialogRequest['method']): string {
  if (method === 'select') return '请选择 Extension 提供的一个选项。'
  if (method === 'editor') return '检查或修改内容，然后提交给 Extension。'
  return '输入内容，然后提交给 Extension。'
}
