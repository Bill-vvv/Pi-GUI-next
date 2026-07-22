import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import type {
  KernelCommandDescriptor,
  KernelState,
  ThinkingLevel
} from '../../../../shared/kernel-contract'
import { Icon } from '../../components/Icon'
import { IconButton } from '../../components/IconButton'
import { canStartRuntime } from '../../runtime-state'
import {
  filterSlashCommands,
  parseSlashCommandToken,
  resolveSlashCommand
} from './slash-command-input'

type ComposerProps = {
  state: KernelState
  busy: boolean
  pendingAction: string | null
  completedAction: { action: string; succeeded: boolean } | null
  onStartSession: () => Promise<void>
  onActivateSession: (sessionKey: string) => Promise<void>
  onPrompt: (message: string) => Promise<void>
  onInvokeCommand: (commandId: string, argument: string) => Promise<void>
  onAbort: () => Promise<void>
  onSetModel: (provider: string, modelId: string) => Promise<void>
  onSetThinkingLevel: (level: ThinkingLevel) => Promise<void>
}

type ModelPickerPanel = 'model' | 'thinking'

const THINKING_LEVELS: ThinkingLevel[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]

export function Composer({
  state,
  busy,
  pendingAction,
  completedAction,
  onStartSession,
  onActivateSession,
  onPrompt,
  onInvokeCommand,
  onAbort,
  onSetModel,
  onSetThinkingLevel
}: ComposerProps): React.JSX.Element {
  const [prompt, setPrompt] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [selectedCommandId, setSelectedCommandId] = useState<string | null>(null)
  const [dismissedMenuPrompt, setDismissedMenuPrompt] = useState<string | null>(null)
  const [commandError, setCommandError] = useState<string | null>(null)
  const [activeModelPickerPanel, setActiveModelPickerPanel] = useState<ModelPickerPanel>('model')
  const composerRef = useRef<HTMLFormElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const selectedCommandOptionRef = useRef<HTMLButtonElement>(null)
  const restoreFocusRef = useRef(false)
  const previousCompletedActionRef = useRef(completedAction)
  const { activeProjectKey, activeSessionKey, runtime, session } = state
  const commands = state.commands ?? []
  const availableModels = state.availableModels ?? []
  const thinkingLevelMap = session.model?.thinkingLevelMap ?? {}
  const running = runtime.status === 'running'
  const ready = runtime.status === 'ready'
  const editable = ready && !busy && !submitting
  const slashQuery = parseSlashCommandToken(prompt)
  const matchingCommands = slashQuery === null
    ? []
    : filterSlashCommands(commands, slashQuery)
  const showSlashCommandSurface =
    editable && slashQuery !== null && dismissedMenuPrompt !== prompt
  const selectedCommand =
    matchingCommands.find((command) => command.id === selectedCommandId) ??
    matchingCommands[0] ??
    null
  const activeCommandId = selectedCommand?.id ?? null
  const selectedCommandIndex = matchingCommands.findIndex(
    (command) => command.id === activeCommandId
  )
  const canStart =
    canStartRuntime(runtime.status) &&
    activeProjectKey !== null &&
    !busy
  const canResume =
    canStartRuntime(runtime.status) &&
    activeProjectKey !== null &&
    activeSessionKey !== null &&
    session.resumeAvailable &&
    !busy
  const availableThinkingLevels = session.model?.reasoning === true
    ? THINKING_LEVELS.filter((level) => thinkingLevelMap[level] != null)
    : []

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

  useEffect(() => {
    setSelectedCommandId(null)
    setDismissedMenuPrompt(null)
    setCommandError(null)
  }, [activeProjectKey, activeSessionKey])

  useEffect(() => {
    if (previousCompletedActionRef.current === completedAction) return
    previousCompletedActionRef.current = completedAction
    if (
      completedAction !== null &&
      completedAction.succeeded &&
      isRuntimeContextAction(completedAction.action)
    ) {
      restoreFocusRef.current = true
    }
  }, [completedAction])

  useEffect(() => {
    if (!editable || !restoreFocusRef.current) return
    const focusFrame = requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (textarea === null || textarea.disabled) return
      restoreFocusRef.current = false
      textarea.focus()
    })
    return () => cancelAnimationFrame(focusFrame)
  }, [editable])

  useLayoutEffect(() => {
    if (!showSlashCommandSurface || selectedCommand === null) return
    selectedCommandOptionRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeCommandId, selectedCommandIndex, showSlashCommandSurface])

  async function invokeCommand(command: KernelCommandDescriptor, argument: string): Promise<void> {
    if (!ready || submitting || busy) return
    setSubmitting(true)
    setCommandError(null)
    try {
      await onInvokeCommand(command.id, argument)
      setPrompt('')
      if (textareaRef.current) textareaRef.current.style.height = ''
    } catch (error) {
      setCommandError(errorMessage(error))
      return
    } finally {
      restoreFocusRef.current = true
      setSubmitting(false)
    }
  }

  function selectCommand(command: KernelCommandDescriptor): void {
    if (command.argumentHint !== null) {
      setPrompt(`/${command.name} `)
      setDismissedMenuPrompt(null)
      setCommandError(null)
      requestAnimationFrame(() => textareaRef.current?.focus())
      return
    }
    void invokeCommand(command, '')
  }

  async function submitPrompt(): Promise<void> {
    const message = prompt.trim()
    if (!ready || submitting || busy || message.length === 0) return

    const resolution = resolveSlashCommand(message, commands)
    if (resolution.kind === 'unknown') {
      setCommandError(`未知命令：/${resolution.name}`)
      return
    }
    if (resolution.kind === 'command') {
      await invokeCommand(resolution.command, resolution.argument)
      return
    }

    setSubmitting(true)
    setCommandError(null)
    try {
      await onPrompt(message)
      setPrompt('')
      if (textareaRef.current) textareaRef.current.style.height = ''
    } catch {
      return
    } finally {
      restoreFocusRef.current = true
      setSubmitting(false)
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
      {showSlashCommandSurface ? (
        <section className="slash-command-surface" aria-label="Slash 命令">
          <div id="slash-command-listbox" className="slash-command-list" role="listbox">
            {matchingCommands.length > 0 ? (
              matchingCommands.map((command) => (
                <button
                  ref={command.id === activeCommandId ? selectedCommandOptionRef : undefined}
                  id={`slash-command-${command.id}`}
                  className={`slash-command-option${command.id === activeCommandId ? ' selected' : ''}`}
                  type="button"
                  role="option"
                  aria-selected={command.id === activeCommandId}
                  key={command.id}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => selectCommand(command)}
                >
                  <span className="slash-command-name">
                    /{command.name}
                    {command.argumentHint !== null ? (
                      <span className="slash-command-argument-hint"> {command.argumentHint}</span>
                    ) : null}
                  </span>
                  <span className="slash-command-description">{command.description}</span>
                  <span className="slash-command-source">{commandSourceLabel(command.source)}</span>
                </button>
              ))
            ) : (
              <p id="slash-command-empty-state" role="status">没有匹配的命令</p>
            )}
          </div>
        </section>
      ) : null}

      {commandError !== null ? (
        <p className="composer-command-error" role="alert">{commandError}</p>
      ) : null}

      <div className="composer-input-row">
        <div className="composer-editor-column">
          <textarea
            ref={textareaRef}
            value={prompt}
            rows={1}
            disabled={!editable}
            role="combobox"
            aria-label="发送给 Pi 的任务"
            aria-autocomplete="list"
            aria-expanded={showSlashCommandSurface}
            aria-haspopup="listbox"
            aria-controls={
              showSlashCommandSurface
                ? 'slash-command-listbox'
                : undefined
            }
            aria-activedescendant={
              showSlashCommandSurface && selectedCommand !== null
                ? `slash-command-${selectedCommand.id}`
                : undefined
            }
            placeholder={composerPlaceholder(state)}
            onChange={(event) => {
              setPrompt(event.target.value)
              setSelectedCommandId(null)
              setDismissedMenuPrompt(null)
              setCommandError(null)
              event.currentTarget.style.height = 'auto'
              event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 180)}px`
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              if (showSlashCommandSurface && event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                setDismissedMenuPrompt(prompt)
                return
              }
              if (showSlashCommandSurface && matchingCommands.length > 0) {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault()
                  const direction = event.key === 'ArrowDown' ? 1 : -1
                  const currentIndex = matchingCommands.findIndex(
                    (command) => command.id === activeCommandId
                  )
                  const nextIndex = currentIndex === -1
                    ? direction === 1 ? 0 : matchingCommands.length - 1
                    : (currentIndex + direction + matchingCommands.length) % matchingCommands.length
                  setSelectedCommandId(matchingCommands[nextIndex].id)
                  return
                }
                if (
                  (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) &&
                  selectedCommand !== null
                ) {
                  event.preventDefault()
                  selectCommand(selectedCommand)
                  return
                }
              }
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
              <IconButton
                className="send-action abort-action"
                icon="stop"
                label="中止本轮输出"
                type="button"
                disabled={busy}
                onClick={() => void onAbort().catch(() => undefined)}
              />
            ) : (
              <IconButton
                className="send-action"
                icon="enter"
                label="发送"
                type="submit"
                disabled={!ready || busy || submitting || prompt.trim().length === 0}
              />
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
                aria-busy={pendingAction === 'start-session' ? true : undefined}
                onClick={() => void onStartSession().catch(() => undefined)}
              >
                <span>新建对话</span>
              </button>
              <button
                className="composer-start-action"
                type="button"
                disabled={busy}
                aria-busy={pendingAction === 'activate-session' ? true : undefined}
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
          ) : canStartRuntime(runtime.status) ? (
            <button
              className="composer-start-action"
              type="button"
              disabled={!canStart}
              aria-busy={pendingAction === 'start-session' ? true : undefined}
              onClick={() => void onStartSession().catch(() => undefined)}
            >
              <span>{runtime.status === 'crashed' ? '重新启动 Pi' : '启动 Pi'}</span>
              <Icon name="arrow-right" />
            </button>
          ) : runtime.status === 'starting' || runtime.status === 'stopping' ? (
            <span className="composer-runtime-state" role="status" aria-live="polite">
              {runtime.status === 'starting' ? '正在启动' : '正在停止'}
            </span>
          ) : (
            <details className="composer-model-controls">
              <summary className="model-picker-button" aria-label="选择模型和思考强度">
                <span className="model-summary-label">
                  {session.model?.name ?? session.model?.id ?? '选择模型'}
                </span>
                {session.thinkingLevel && availableThinkingLevels.includes(session.thinkingLevel) ? (
                  <span className="model-summary-meta">{thinkingLabel(session.thinkingLevel)}</span>
                ) : null}
              </summary>
              <section className="model-picker-popover" aria-label="模型和思考强度设置">
                <div className="model-picker-main-panel">
                  <nav className="model-picker-navigation" aria-label="设置分类">
                    <button
                      className={`model-picker-category${activeModelPickerPanel === 'model' ? ' active' : ''}`}
                      type="button"
                      aria-pressed={activeModelPickerPanel === 'model'}
                      onClick={() => setActiveModelPickerPanel('model')}
                    >
                      <span className="model-picker-category-copy">
                        <span className="model-picker-category-label">模型</span>
                        <span className="model-picker-category-value">
                          {session.model?.name ?? session.model?.id ?? '未选择'}
                        </span>
                      </span>
                      <Icon name="arrow-right" />
                    </button>
                    <button
                      className={`model-picker-category${activeModelPickerPanel === 'thinking' ? ' active' : ''}`}
                      type="button"
                      aria-pressed={activeModelPickerPanel === 'thinking'}
                      onClick={() => setActiveModelPickerPanel('thinking')}
                    >
                      <span className="model-picker-category-copy">
                        <span className="model-picker-category-label">思考强度</span>
                        <span className="model-picker-category-value">
                          {session.model === null
                            ? '未选择模型'
                            : session.model.reasoning === false
                            ? '当前模型不支持'
                            : session.thinkingLevel && availableThinkingLevels.includes(session.thinkingLevel)
                              ? thinkingLabel(session.thinkingLevel)
                              : '未设置'}
                        </span>
                      </span>
                      <Icon name="arrow-right" />
                    </button>
                  </nav>

                  <section
                    className="model-picker-option-panel"
                    aria-label={activeModelPickerPanel === 'model' ? '模型选项' : '思考强度选项'}
                  >
                    <header className="model-picker-column-heading">
                      <span>{activeModelPickerPanel === 'model' ? '模型' : '思考强度'}</span>
                    </header>
                    {activeModelPickerPanel === 'model' ? (
                      availableModels.length > 0 ? (
                        <div className="model-picker-option-list" aria-label="模型">
                          {availableModels.map((model) => {
                            const selected =
                              session.model?.provider === model.provider && session.model.id === model.id
                            return (
                              <button
                                className={`picker-option model-picker-item${selected ? ' selected' : ''}`}
                                type="button"
                                key={`${model.provider}:${model.id}`}
                                aria-pressed={selected}
                                disabled={busy || runtime.status !== 'ready'}
                                onClick={() => {
                                  if (!selected) {
                                    void onSetModel(model.provider, model.id).catch(() => undefined)
                                  }
                                }}
                              >
                                <span className="model-picker-option-copy">
                                  <span className="model-picker-option-label">
                                    {model.name.trim() || model.id}
                                  </span>
                                  <span className="model-picker-option-meta">
                                    {model.provider}/{model.id}
                                  </span>
                                </span>
                                {selected ? <span className="model-picker-selected">当前</span> : null}
                              </button>
                            )
                          })}
                        </div>
                      ) : (
                        <p className="model-picker-empty" role="status">暂无可用模型</p>
                      )
                    ) : session.model === null ? (
                      <p className="model-picker-empty" role="status">尚未选择模型</p>
                    ) : session.model.reasoning === false ? (
                      <p className="model-picker-empty" role="status">当前模型不支持思考强度</p>
                    ) : availableThinkingLevels.length === 0 ? (
                      <p className="model-picker-empty" role="status">当前模型没有可用的思考强度</p>
                    ) : (
                      <div className="model-picker-option-list" aria-label="思考强度">
                        {availableThinkingLevels.map((level) => {
                          const selected = session.thinkingLevel === level
                          return (
                            <button
                              className={`picker-option model-picker-item${selected ? ' selected' : ''}`}
                              type="button"
                              key={level}
                              aria-pressed={selected}
                              disabled={busy || runtime.status !== 'ready'}
                              onClick={() => void onSetThinkingLevel(level).catch(() => undefined)}
                            >
                              <span className="model-picker-option-copy">
                                <span className="model-picker-option-label">{thinkingLabel(level)}</span>
                                <span className="model-picker-option-meta">{level}</span>
                              </span>
                              {selected ? <span className="model-picker-selected">当前</span> : null}
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </section>
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
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '极高',
    max: '最高'
  }[level]
}

function commandSourceLabel(source: KernelCommandDescriptor['source']): string {
  return {
    gui: 'GUI',
    'pi-rpc': 'Pi RPC',
    extension: 'Extension',
    prompt: 'Prompt',
    skill: 'Skill'
  }[source]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRuntimeContextAction(action: string): boolean {
  return action === 'add-project' ||
    action === 'activate-project' ||
    action === 'activate-session' ||
    action === 'start-session'
}
