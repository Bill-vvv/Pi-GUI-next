import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import type {
  KernelState,
  ThinkingLevel
} from '../shared/kernel-contract.ts'
import { Icon } from '../renderer/src/components/Icon.tsx'
import { IconButton } from '../renderer/src/components/IconButton.tsx'
import {
  localizedThinkingLevelLabel,
  THINKING_LEVELS
} from '../renderer/src/thinking-level.ts'
import { unknownErrorMessage } from '../renderer/src/unknown-error-message.ts'

type RemoteComposerProps = {
  state: KernelState
  workspaceAvailable: boolean
  connected: boolean
  busy: boolean
  onPrompt: (message: string) => Promise<void>
  onSteer: (message: string) => Promise<void>
  onFollowUp: (message: string) => Promise<void>
  onAbort: () => Promise<void>
  onSetModel: (provider: string, modelId: string) => Promise<void>
  onSetThinkingLevel: (level: ThinkingLevel) => Promise<void>
  onSetOpenAiFastMode: (enabled: boolean) => Promise<void>
  onMeasuredHeightChange: (height: number) => void
}

export function RemoteComposer({
  state,
  workspaceAvailable,
  connected,
  busy,
  onPrompt,
  onSteer,
  onFollowUp,
  onAbort,
  onSetModel,
  onSetThinkingLevel,
  onSetOpenAiFastMode,
  onMeasuredHeightChange
}: RemoteComposerProps): React.JSX.Element {
  const [prompt, setPrompt] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const { runtime, session, availableModels, activeSessionKey, activeProjectKey } = state
  const running = runtime.status === 'running'
  const ready = runtime.status === 'ready'
  const starting = runtime.status === 'starting'
  const canCompose =
    connected &&
    workspaceAvailable &&
    activeProjectKey !== null &&
    activeSessionKey !== null
  const canSubmitText =
    canCompose &&
    !busy &&
    !submitting &&
    prompt.trim().length > 0 &&
    (ready || running)
  const openAiFastModeAvailable = session.model !== null && (
    session.model.provider === 'openai' ||
    session.model.provider === 'openai-codex' ||
    (session.model.provider === 'vvqq-cpa' && session.model.id.startsWith('gpt-'))
  )
  const thinkingLevelMap = session.model?.thinkingLevelMap ?? {}
  const availableThinkingLevels = session.model?.reasoning === true
    ? THINKING_LEVELS.filter((level) => isThinkingLevelAvailable(level, thinkingLevelMap))
    : []
  const selectedModelKey = session.model === null
    ? ''
    : modelKey(session.model.provider, session.model.id)
  const controlsDisabled =
    !connected ||
    !workspaceAvailable ||
    busy ||
    submitting ||
    runtime.status !== 'ready'

  useLayoutEffect(() => {
    const form = formRef.current
    if (form === null) return
    let measuredHeight = -1
    const update = (): void => {
      const height = Math.ceil(form.getBoundingClientRect().height)
      if (height === measuredHeight) return
      measuredHeight = height
      onMeasuredHeightChange(height)
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(form)
    return () => {
      observer.disconnect()
      onMeasuredHeightChange(0)
    }
  }, [onMeasuredHeightChange])

  useEffect(() => {
    const textarea = textareaRef.current
    if (textarea === null) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`
  }, [prompt])

  async function submit(behavior: 'prompt' | 'steer' | 'follow-up'): Promise<void> {
    const message = prompt.trim()
    if (!canSubmitText) return
    const previous = prompt
    setSubmitting(true)
    setError(null)
    setPrompt('')
    try {
      if (behavior === 'steer') await onSteer(message)
      else if (behavior === 'follow-up') await onFollowUp(message)
      else await onPrompt(message)
    } catch (cause) {
      setPrompt(previous)
      setError(unknownErrorMessage(cause))
    } finally {
      setSubmitting(false)
      requestAnimationFrame(() => textareaRef.current?.focus())
    }
  }

  return (
    <form
      ref={formRef}
      className="remote-composer"
      onSubmit={(event) => {
        event.preventDefault()
        void submit(running ? 'follow-up' : 'prompt')
      }}
    >
      {running && (session.pendingSteeringMessages.length > 0 || session.pendingFollowUpMessages.length > 0) ? (
        <section className="remote-composer-queue" aria-label="已排队消息" aria-live="polite">
          {session.pendingSteeringMessages.map((message, index) => (
            <p className="remote-composer-queue-item" key={`steer-${index}`}>
              <span>引导</span>
              {message}
            </p>
          ))}
          {session.pendingFollowUpMessages.map((message, index) => (
            <p className="remote-composer-queue-item" key={`follow-up-${index}`}>
              <span>排队</span>
              {message}
            </p>
          ))}
        </section>
      ) : null}

      {error !== null ? (
        <p className="remote-composer-error" role="alert">{error}</p>
      ) : null}

      <div className="remote-composer-controls">
        <label className="remote-composer-field">
          <span className="remote-composer-field-label">模型</span>
          <select
            aria-label="选择模型"
            disabled={controlsDisabled || availableModels.length === 0}
            value={selectedModelKey}
            onChange={(event) => {
              const [provider, ...rest] = event.target.value.split('\u0000')
              const modelId = rest.join('\u0000')
              if (!provider || !modelId) return
              void onSetModel(provider, modelId).catch((cause) => {
                setError(unknownErrorMessage(cause))
              })
            }}
          >
            {session.model === null ? <option value="">未选择模型</option> : null}
            {availableModels.map((model) => {
              const key = modelKey(model.provider, model.id)
              return (
                <option key={key} value={key}>
                  {model.provider}/{model.id}
                </option>
              )
            })}
          </select>
        </label>

        {availableThinkingLevels.length > 0 ? (
          <label className="remote-composer-field">
            <span className="remote-composer-field-label">思考</span>
            <select
              aria-label="选择思考强度"
              disabled={controlsDisabled}
              value={session.thinkingLevel ?? ''}
              onChange={(event) => {
                const level = event.target.value as ThinkingLevel
                if (!level) return
                void onSetThinkingLevel(level).catch((cause) => {
                  setError(unknownErrorMessage(cause))
                })
              }}
            >
              {availableThinkingLevels.map((level) => (
                <option key={level} value={level}>
                  {localizedThinkingLevelLabel(level)}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {openAiFastModeAvailable ? (
          <button
            className={`remote-composer-fast${session.openAiFastMode ? ' active' : ''}`}
            type="button"
            disabled={controlsDisabled}
            aria-pressed={session.openAiFastMode}
            onClick={() => {
              void onSetOpenAiFastMode(!session.openAiFastMode).catch((cause) => {
                setError(unknownErrorMessage(cause))
              })
            }}
          >
            <Icon name="bolt" size="sm" />
            Fast
          </button>
        ) : null}
      </div>

      <div className="remote-composer-input-row">
        <textarea
          ref={textareaRef}
          className="remote-composer-input"
          rows={1}
          enterKeyHint="send"
          placeholder={
            !canCompose
              ? '请先选择项目与会话'
              : running
                ? '发送后续消息…'
                : starting
                  ? '会话启动中，可先输入…'
                  : '输入消息…'
          }
          value={prompt}
          disabled={!connected || !canCompose || submitting}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
            event.preventDefault()
            void submit(running ? 'follow-up' : 'prompt')
          }}
        />
        {running ? (
          <IconButton
            className="remote-composer-abort"
            icon="stop"
            label="中止当前运行"
            disabled={!connected || busy || submitting}
            onClick={() => {
              void onAbort().catch((cause) => setError(unknownErrorMessage(cause)))
            }}
          />
        ) : null}
        {running ? (
          <button
            className="remote-composer-steer"
            type="button"
            disabled={!canSubmitText}
            onClick={() => {
              void submit('steer')
            }}
          >
            引导
          </button>
        ) : null}
        <button
          className="remote-composer-send"
          type="submit"
          disabled={!canSubmitText}
          aria-label={running ? '排队发送' : '发送'}
        >
          <Icon name="enter" size="control" />
        </button>
      </div>
    </form>
  )
}

function modelKey(provider: string, modelId: string): string {
  return `${provider}\u0000${modelId}`
}

function isThinkingLevelAvailable(
  level: ThinkingLevel,
  thinkingLevelMap: Partial<Record<ThinkingLevel, string | null>>
): boolean {
  const mappedLevel = thinkingLevelMap[level]
  if (mappedLevel === null) return false
  if (level === 'xhigh' || level === 'max') return mappedLevel !== undefined
  return true
}
