import { useEffect, useRef, useState } from 'react'

import type { RuntimeStatus } from '../../../../shared/kernel-contract'

type ComposerProps = {
  runtimeStatus: RuntimeStatus
  busy: boolean
  onPrompt: (message: string) => Promise<void>
  onAbort: () => Promise<void>
}

export function Composer({
  runtimeStatus,
  busy,
  onPrompt,
  onAbort
}: ComposerProps): React.JSX.Element {
  const [prompt, setPrompt] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const running = runtimeStatus === 'running'
  const ready = runtimeStatus === 'ready'

  useEffect(() => {
    if (!running) return
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      void onAbort().catch(() => undefined)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onAbort, running])

  async function submitPrompt(): Promise<void> {
    const message = prompt.trim()
    if (!ready || submitting || busy || message.length === 0) return

    setSubmitting(true)
    try {
      await onPrompt(message)
      setPrompt('')
    } catch {
      return
    } finally {
      setSubmitting(false)
      textareaRef.current?.focus()
    }
  }

  return (
    <div className="composer-region">
      <div className="composer-shell" data-running={running}>
        <textarea
          ref={textareaRef}
          value={prompt}
          rows={1}
          disabled={!ready || busy || submitting}
          aria-label="发送给 Pi 的任务"
          placeholder={running ? 'Pi 正在执行当前任务…' : '向 Pi 描述一个任务…'}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void submitPrompt()
            }
          }}
        />
        <div className="composer-controls">
          <span className="composer-hint">
            {running ? 'Esc 中止当前执行' : 'Enter 发送 · Shift+Enter 换行'}
          </span>
          {running ? (
            <button
              className="abort-button"
              type="button"
              disabled={busy}
              onClick={() => void onAbort().catch(() => undefined)}
            >
              <span className="stop-icon" aria-hidden="true" />
              中止
            </button>
          ) : (
            <button
              className="send-button"
              type="button"
              disabled={!ready || busy || submitting || prompt.trim().length === 0}
              onClick={() => void submitPrompt()}
            >
              {submitting ? '发送中…' : '发送'}
              <span aria-hidden="true">↑</span>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
