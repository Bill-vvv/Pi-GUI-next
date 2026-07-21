import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import type {
  KernelState,
  ThinkingLevel
} from '../../../../shared/kernel-contract'
import { Icon } from '../../components/Icon'

type ComposerProps = {
  state: KernelState
  busy: boolean
  onStartSession: () => Promise<void>
  onActivateSession: (sessionKey: string) => Promise<void>
  onPrompt: (message: string) => Promise<void>
  onAbort: () => Promise<void>
  onSetThinkingLevel: (level: ThinkingLevel) => Promise<void>
}

const THINKING_LEVELS: ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]

export function Composer({
  state,
  busy,
  onStartSession,
  onActivateSession,
  onPrompt,
  onAbort,
  onSetThinkingLevel
}: ComposerProps): React.JSX.Element {
  const [prompt, setPrompt] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const composerRef = useRef<HTMLFormElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const { activeProjectKey, activeSessionKey, runtime, session } = state
  const running = runtime.status === 'running'
  const ready = runtime.status === 'ready'
  const canStart =
    (runtime.status === 'stopped' || runtime.status === 'crashed') &&
    activeProjectKey !== null &&
    !busy
  const canResume =
    (runtime.status === 'stopped' || runtime.status === 'crashed') &&
    activeProjectKey !== null &&
    activeSessionKey !== null &&
    session.resumeAvailable &&
    !busy

  useLayoutEffect(() => {
    const composer = composerRef.current
    const mainChat = composer?.closest<HTMLElement>('.main-chat')
    if (!composer || !mainChat) return
    let scrollFrame: number | null = null

    const updateClearance = (): void => {
      const conversation = mainChat.querySelector<HTMLElement>('.conversation-surface')
      const followsOutput = conversation !== null &&
        conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 120
      const height = Math.ceil(composer.getBoundingClientRect().height)
      mainChat.style.setProperty('--composer-measured-clearance', `${height}px`)
      if (followsOutput && conversation !== null) {
        if (scrollFrame !== null) cancelAnimationFrame(scrollFrame)
        scrollFrame = requestAnimationFrame(() => {
          conversation.scrollTop = conversation.scrollHeight
          scrollFrame = null
        })
      }
    }

    updateClearance()
    const resizeObserver = new ResizeObserver(updateClearance)
    resizeObserver.observe(composer)

    return () => {
      resizeObserver.disconnect()
      if (scrollFrame !== null) cancelAnimationFrame(scrollFrame)
      mainChat.style.removeProperty('--composer-measured-clearance')
    }
  }, [])

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
      if (textareaRef.current) textareaRef.current.style.height = ''
    } catch {
      return
    } finally {
      setSubmitting(false)
      textareaRef.current?.focus()
    }
  }

  return (
    <form
      ref={composerRef}
      className="composer"
      onSubmit={(event) => {
        event.preventDefault()
        void submitPrompt()
      }}
    >
      <div className="composer-input-row">
        <div className="composer-editor-column">
          <textarea
            ref={textareaRef}
            value={prompt}
            rows={1}
            disabled={!ready || busy || submitting}
            aria-label="发送给 Pi 的任务"
            placeholder={composerPlaceholder(state)}
            onChange={(event) => {
              setPrompt(event.target.value)
              event.currentTarget.style.height = 'auto'
              event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 180)}px`
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                void submitPrompt()
              }
            }}
          />
        </div>

        <div className="composer-input-actions">
          <div className="composer-submit-actions">
            {running ? (
              <button
                className="send-action abort-action"
                type="button"
                title="中止本轮输出"
                aria-label="中止本轮输出"
                disabled={busy}
                onClick={() => void onAbort().catch(() => undefined)}
              >
                <Icon name="stop" />
              </button>
            ) : (
              <button
                className="send-action"
                type="submit"
                title="发送"
                aria-label="发送"
                disabled={!ready || busy || submitting || prompt.trim().length === 0}
              >
                <Icon name="enter" />
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="composer-meta-row">
        <div className="composer-runtime-controls">
          {canResume ? (
            <>
              <button
                className="composer-start-action"
                type="button"
                disabled={!canStart}
                onClick={() => void onStartSession().catch(() => undefined)}
              >
                <span>新建对话</span>
              </button>
              <button
                className="composer-start-action"
                type="button"
                disabled={busy}
                onClick={() => {
                  if (activeSessionKey !== null) {
                    void onActivateSession(activeSessionKey).catch(() => undefined)
                  }
                }}
              >
                <span>{runtime.status === 'crashed' ? '重启并恢复' : '恢复对话'}</span>
                <Icon name="arrow-right" />
              </button>
            </>
          ) : runtime.status === 'stopped' || runtime.status === 'crashed' ? (
            <button
              className="composer-start-action"
              type="button"
              disabled={!canStart}
              onClick={() => void onStartSession().catch(() => undefined)}
            >
              <span>{runtime.status === 'crashed' ? '重新启动 Pi' : '启动 Pi'}</span>
              <Icon name="arrow-right" />
            </button>
          ) : runtime.status === 'starting' || runtime.status === 'stopping' ? (
            <span className="composer-runtime-state">
              {runtime.status === 'starting' ? '正在启动' : '正在停止'}
            </span>
          ) : (
            <details className="composer-model-controls">
              <summary className="model-picker-button" aria-label="选择思考强度">
                <span className="model-summary-label">
                  {session.model?.name ?? session.model?.id ?? '选择模型'}
                </span>
                {session.thinkingLevel ? (
                  <span className="model-summary-meta">{thinkingLabel(session.thinkingLevel)}</span>
                ) : null}
              </summary>
              <section className="model-picker-popover" aria-label="思考设置">
                <div className="model-picker-main-panel">
                  <div className="model-picker-section model-picker-thinking-section">
                    <header className="model-picker-column-heading">
                      <span>思考强度</span>
                    </header>
                    <div className="thinking-grid" role="listbox" aria-label="思考强度">
                      {THINKING_LEVELS.map((level) => (
                        <button
                          className={`picker-option model-picker-item${session.thinkingLevel === level ? ' selected' : ''}`}
                          type="button"
                          key={level}
                          role="option"
                          aria-selected={session.thinkingLevel === level}
                          disabled={busy || runtime.status !== 'ready' || session.model?.reasoning === false}
                          onClick={() => void onSetThinkingLevel(level).catch(() => undefined)}
                        >
                          <span>{thinkingLabel(level)}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </section>
            </details>
          )}

          <span className="context-indicator unknown" title="当前未提供 token 使用量">
            <span className="context-ring" aria-hidden="true" />
          </span>
        </div>
      </div>
    </form>
  )
}

function composerPlaceholder(state: KernelState): string {
  if (state.activeProjectKey === null) return '先选择项目文件夹'
  if (state.runtime.status === 'stopped') return '启动 Pi 后开始对话'
  if (state.runtime.status === 'starting') return '正在启动 Pi…'
  if (state.runtime.status === 'running') return 'Pi 正在执行当前任务…'
  if (state.runtime.status === 'crashed') return 'Pi Runtime 已退出'
  return ''
}

function thinkingLabel(level: ThinkingLevel): string {
  return {
    off: '关闭',
    minimal: '极低',
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '很高',
    max: '最高'
  }[level]
}
