import { useEffect, useRef, useState } from 'react'

import type {
  KernelState,
  SessionNamingSettings,
  ThinkingLevel
} from '../../../../shared/kernel-contract'
import { Icon } from '../../components/Icon'
import { IconButton } from '../../components/IconButton'
import { canChangeRuntimeContext } from '../../runtime-state'
import { Composer } from '../composer/Composer'
import { Timeline } from './Timeline'

type ChatWorkbenchProps = {
  state: KernelState
  pendingAction: string | null
  completedAction: { action: string; succeeded: boolean } | null
  actionError: string | null
  onAddProject: () => Promise<void>
  onActivateProject: (projectKey: string) => Promise<void>
  onStartSession: () => Promise<void>
  onActivateSession: (sessionKey: string) => Promise<void>
  onPrompt: (message: string) => Promise<void>
  onInvokeCommand: (commandId: string, argument: string) => Promise<void>
  onAbort: () => Promise<void>
  onSetModel: (provider: string, modelId: string) => Promise<void>
  onSetThinkingLevel: (level: ThinkingLevel) => Promise<void>
  onSetSessionNaming: (settings: SessionNamingSettings) => Promise<void>
}

export function ChatWorkbench({
  state,
  pendingAction,
  completedAction,
  actionError,
  onAddProject,
  onActivateProject,
  onStartSession,
  onActivateSession,
  onPrompt,
  onInvokeCommand,
  onAbort,
  onSetModel,
  onSetThinkingLevel,
  onSetSessionNaming
}: ChatWorkbenchProps): React.JSX.Element {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [activityClock, setActivityClock] = useState(() => Date.now())
  const [expandedProjectKey, setExpandedProjectKey] = useState<string | null>(
    () => state.activeProjectKey
  )
  const {
    projects,
    activeProjectKey,
    sessions,
    activeSessionKey,
    runtime,
    conversation
  } = state
  const previousActiveProjectKeyRef = useRef(activeProjectKey)
  useEffect(() => {
    const interval = window.setInterval(() => setActivityClock(Date.now()), 60_000)
    return () => window.clearInterval(interval)
  }, [])
  // 仅在切换到另一个 Project 时自动展开；当前 Project 的展开/收起由点击切换，不被强制回写。
  useEffect(() => {
    if (previousActiveProjectKeyRef.current === activeProjectKey) return
    previousActiveProjectKeyRef.current = activeProjectKey
    setExpandedProjectKey(activeProjectKey)
  }, [activeProjectKey])
  const activeProject = activeProjectKey === null
    ? null
    : projects.find((project) => project.path === activeProjectKey) ?? null
  const activeSession = activeSessionKey === null
    ? null
    : sessions.find((summary) => summary.key === activeSessionKey) ?? null
  const projectName = basename(activeProject?.path ?? null) ?? '未选择项目'
  const busy = pendingAction !== null
  const canChangeProjectOrSession = !busy && canChangeRuntimeContext(runtime.status)
  const canStartSession =
    canChangeProjectOrSession &&
    activeProject !== null
  const contextActionStatus = runtimeContextActionStatus(pendingAction)
  const namingValue = sessionNamingValue(state.sessionNaming)
  const selectedNamingModel = state.sessionNaming.mode === 'model' ? state.sessionNaming : null
  const selectedNamingModelAvailable = selectedNamingModel === null || state.availableModels.some(
    (model) => model.provider === selectedNamingModel.provider && model.id === selectedNamingModel.modelId
  )

  return (
    <main className={`app-shell${sidebarCollapsed ? ' left-sidebar-collapsed' : ''}`}>
      <aside className="left-sidebar" aria-label="项目与对话">
        <div className="sidebar-content">
          <section
            className="sidebar-section project-list-section"
            aria-label="项目"
            aria-busy={contextActionStatus !== null}
          >
            {projects.length === 0 ? (
              <p className="empty-project-state muted" role="status">
                暂无项目。请使用侧边栏底部的“添加项目”。
              </p>
            ) : (
              projects.map((project) => {
                const selected = project.path === activeProjectKey
                const expanded = selected && project.path === expandedProjectKey
                const projectLabel = basename(project.path) ?? project.path
                return (
                  <article
                    className={`project-session-group${selected ? ' selected' : ''}${expanded ? ' expanded' : ''}`}
                    key={project.path}
                  >
                    <div className="project-row">
                      <button
                        className="project-select"
                        type="button"
                        title={project.path}
                        aria-current={selected ? 'true' : undefined}
                        aria-expanded={selected ? expanded : undefined}
                        disabled={!selected && !canChangeProjectOrSession}
                        onClick={() => {
                          if (selected) {
                            setExpandedProjectKey(expanded ? null : project.path)
                            return
                          }
                          if (!canChangeProjectOrSession) return
                          void onActivateProject(project.path)
                            .then(() => setExpandedProjectKey(project.path))
                            .catch(() => undefined)
                        }}
                      >
                        <span className="project-icon" aria-hidden="true">
                          <Icon name={expanded ? 'folder-open' : 'folder'} />
                        </span>
                        <span className="project-name">{projectLabel}</span>
                        <span className="project-initial" aria-hidden="true">
                          {projectLabel.slice(0, 1).toLocaleUpperCase()}
                        </span>
                      </button>
                      {selected ? (
                        <IconButton
                          className="project-new-chat"
                          icon="plus"
                          label="在此项目中启动对话"
                          aria-busy={pendingAction === 'start-session' ? true : undefined}
                          disabled={!canStartSession}
                          onClick={() => void onStartSession().catch(() => undefined)}
                        />
                      ) : null}
                    </div>

                    {expanded ? (
                      <div className="session-list">
                        {sessions.length === 0 ? (
                          <p className="empty-session-state muted">暂无对话。</p>
                        ) : sessions.map((summary) => {
                          const active = summary.key === activeSessionKey
                          const canActivate = canChangeProjectOrSession && (runtime.status !== 'ready' || !active)
                          const running = active && runtime.status === 'running'
                          const activityLabel = formatActivityAge(summary.lastActivityAt, activityClock)
                          return (
                            <div
                              className={`session-row${active ? ' selected' : ''}`}
                              key={summary.key}
                            >
                              <button
                                className="session-item"
                                type="button"
                                title={summary.key}
                                aria-current={active ? 'true' : undefined}
                                disabled={!canActivate}
                                onClick={() => {
                                  if (canActivate) {
                                    void onActivateSession(summary.key).catch(() => undefined)
                                  }
                                }}
                              >
                                <span className="session-title">{sessionTitle(summary)}</span>
                              </button>
                              <div className="session-action-slot">
                                {running ? (
                                  <span
                                    className="session-running-indicator"
                                    role="status"
                                    aria-label="正在运行"
                                    title="正在运行"
                                  />
                                ) : activityLabel === null ? null : (
                                  <time
                                    className="session-last-active"
                                    dateTime={new Date(summary.lastActivityAt ?? 0).toISOString()}
                                  >
                                    {activityLabel}
                                  </time>
                                )}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    ) : null}
                  </article>
                )
              })
            )}
          </section>
        </div>

        <footer className="sidebar-footer">
          <IconButton
            className="sidebar-collapse-toggle"
            icon="left-sidebar-close"
            label="收起侧边栏"
            onClick={() => setSidebarCollapsed(true)}
          />
          <IconButton
            className="add-project-entry"
            icon="plus"
            label="添加项目"
            aria-busy={pendingAction === 'add-project' ? true : undefined}
            disabled={!canChangeProjectOrSession}
            onClick={() => void onAddProject().catch(() => undefined)}
          />
          <div className="sidebar-settings-entry">
            <IconButton
              className="sidebar-settings-toggle"
              icon="settings"
              label="设置"
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen((open) => !open)}
            />
            {settingsOpen ? (
              <section className="session-naming-settings" aria-label="对话命名设置">
                <label htmlFor="session-naming-mode">自动对话命名</label>
                <select
                  id="session-naming-mode"
                  value={namingValue}
                  disabled={busy}
                  onChange={(event) => {
                    const value = event.currentTarget.value
                    const settings: SessionNamingSettings | null = value === 'auto'
                      ? { mode: 'auto' }
                      : value === 'off'
                        ? { mode: 'off' }
                        : state.availableModels
                            .filter((model) => sessionNamingModelValue(model.provider, model.id) === value)
                            .map((model) => ({
                              mode: 'model' as const,
                              provider: model.provider,
                              modelId: model.id
                            }))[0] ?? null
                    if (settings === null) return
                    void onSetSessionNaming(settings)
                      .then(() => setSettingsOpen(false))
                      .catch(() => undefined)
                  }}
                >
                  <option value="auto">自动选择低成本模型（推荐）</option>
                  <option value="off">关闭</option>
                  <optgroup label="指定已授权模型">
                    {!selectedNamingModelAvailable && selectedNamingModel !== null ? (
                      <option value={namingValue} disabled>
                        {selectedNamingModel.provider}/{selectedNamingModel.modelId}（当前不可用）
                      </option>
                    ) : null}
                    {state.availableModels.map((model) => (
                      <option
                        key={`${model.provider}/${model.id}`}
                        value={sessionNamingModelValue(model.provider, model.id)}
                      >
                        {model.provider}/{model.name}
                      </option>
                    ))}
                  </optgroup>
                </select>
                <p>OAuth 与 API 认证继续由 Pi 管理；自动模式只使用当前已授权 Provider 中的低成本模型。</p>
              </section>
            ) : null}
          </div>
        </footer>
      </aside>

      <section className="main-chat" aria-label={`${projectName} 对话工作区`}>
        {sidebarCollapsed ? (
          <div className="left-sidebar-bottom-triggers">
            <IconButton
              className="left-sidebar-trigger"
              icon="left-sidebar-open"
              label="展开侧边栏"
              onClick={() => setSidebarCollapsed(false)}
            />
          </div>
        ) : null}

        <header className="workbench-session-header">
          <strong className="workbench-session-title">
            {activeSession === null ? '尚未选择对话' : sessionTitle(activeSession)}
          </strong>
          {contextActionStatus !== null ? (
            <span className="runtime-context-status" role="status" aria-live="polite">
              {contextActionStatus}
            </span>
          ) : null}
        </header>

        <Timeline
          key={`${activeProjectKey ?? 'no-project'}:${activeSessionKey ?? 'new-session'}`}
          entries={conversation.entries}
          activeRunStartIndex={conversation.activeRunStartIndex}
          runtimeStatus={runtime.status}
          warning={
            actionError ??
            (runtime.status === 'crashed'
              ? runtime.lastError ?? 'Pi Runtime 意外退出，未提供错误详情。'
              : null)
          }
        />

        <Composer
          state={state}
          busy={busy}
          pendingAction={pendingAction}
          completedAction={completedAction}
          onStartSession={onStartSession}
          onActivateSession={onActivateSession}
          onPrompt={onPrompt}
          onInvokeCommand={onInvokeCommand}
          onAbort={onAbort}
          onSetModel={onSetModel}
          onSetThinkingLevel={onSetThinkingLevel}
        />
      </section>
    </main>
  )
}

function basename(path: string | null): string | null {
  if (path === null) return null
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? path
}

function sessionTitle(session: KernelState['sessions'][number]): string {
  if (session.name !== null && session.name.trim().length > 0) return session.name
  return `对话 ${session.id.slice(0, 8)}`
}

function formatActivityAge(timestamp: number | null, now: number): string | null {
  if (timestamp === null) return null
  const elapsedMinutes = Math.max(0, Math.floor((now - timestamp) / 60_000))
  if (elapsedMinutes < 1) return '刚刚'
  if (elapsedMinutes < 60) return `${elapsedMinutes} 分钟`
  const elapsedHours = Math.floor(elapsedMinutes / 60)
  if (elapsedHours < 24) return `${elapsedHours} 小时`
  return `${Math.floor(elapsedHours / 24)} 天`
}

function runtimeContextActionStatus(action: string | null): string | null {
  if (action === 'add-project') return '正在添加项目…'
  if (action === 'activate-project') return '正在切换项目…'
  if (action === 'activate-session') return '正在切换对话…'
  if (action === 'start-session') return '正在启动对话…'
  return null
}

function sessionNamingValue(settings: SessionNamingSettings): string {
  return settings.mode === 'model'
    ? sessionNamingModelValue(settings.provider, settings.modelId)
    : settings.mode
}

function sessionNamingModelValue(provider: string, modelId: string): string {
  return `model:${encodeURIComponent(provider)}:${encodeURIComponent(modelId)}`
}
