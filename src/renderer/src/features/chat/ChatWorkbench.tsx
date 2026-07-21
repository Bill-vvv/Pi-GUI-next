import { useState } from 'react'

import type {
  KernelState,
  RuntimeStatus,
  ThinkingLevel
} from '../../../../shared/kernel-contract'
import { Icon, type IconName } from '../../components/Icon'
import { Composer } from '../composer/Composer'
import { Timeline } from './Timeline'

type ChatWorkbenchProps = {
  state: KernelState
  pendingAction: string | null
  actionError: string | null
  onAddProject: () => Promise<void>
  onActivateProject: (projectKey: string) => Promise<void>
  onStartSession: () => Promise<void>
  onActivateSession: (sessionKey: string) => Promise<void>
  onPrompt: (message: string) => Promise<void>
  onAbort: () => Promise<void>
  onSetThinkingLevel: (level: ThinkingLevel) => Promise<void>
}

const STATUS_LABELS: Record<RuntimeStatus, string> = {
  stopped: '未启动',
  starting: '启动中',
  ready: '就绪',
  running: '执行中',
  stopping: '停止中',
  crashed: '已崩溃'
}

export function ChatWorkbench({
  state,
  pendingAction,
  actionError,
  onAddProject,
  onActivateProject,
  onStartSession,
  onActivateSession,
  onPrompt,
  onAbort,
  onSetThinkingLevel
}: ChatWorkbenchProps): React.JSX.Element {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const {
    projects,
    activeProjectKey,
    sessions,
    activeSessionKey,
    runtime,
    session,
    conversation
  } = state
  const activeProject = activeProjectKey === null
    ? null
    : projects.find((project) => project.path === activeProjectKey) ?? null
  const activeSession = activeSessionKey === null
    ? null
    : sessions.find((summary) => summary.key === activeSessionKey) ?? null
  const projectName = basename(activeProject?.path ?? null) ?? '未选择项目'
  const messageCount = conversation.entries.filter((entry) => entry.kind === 'message').length
  const busy = pendingAction !== null
  const canChangeProject =
    !busy &&
    (runtime.status === 'stopped' || runtime.status === 'ready' || runtime.status === 'crashed')
  const canChangeSession =
    !busy &&
    (runtime.status === 'stopped' || runtime.status === 'ready' || runtime.status === 'crashed')
  const canStartSession =
    canChangeSession &&
    activeProject !== null

  return (
    <main className={`app-shell${sidebarCollapsed ? ' left-sidebar-collapsed' : ''}`}>
      <aside className="left-sidebar" aria-label="项目与对话">
        <div className="sidebar-content">
          <section className="sidebar-section project-list-section" aria-label="项目">
            {projects.length === 0 ? (
              <p className="empty-project-state muted" role="status">
                暂无项目。请使用侧边栏底部的“添加项目”。
              </p>
            ) : (
              projects.map((project) => {
                const selected = project.path === activeProjectKey
                return (
                  <article
                    className={`project-session-group${selected ? ' selected' : ''}`}
                    key={project.path}
                  >
                    <div className="project-row">
                      <button
                        className="project-select"
                        type="button"
                        title={project.path}
                        aria-current={selected ? 'true' : undefined}
                        disabled={!selected && !canChangeProject}
                        onClick={() => {
                          if (!selected && canChangeProject) {
                            void onActivateProject(project.path).catch(() => undefined)
                          }
                        }}
                      >
                        <strong>{basename(project.path) ?? project.path}</strong>
                        <small>{project.path}</small>
                      </button>
                      {selected ? (
                        <SidebarIconButton
                          className="project-new-chat"
                          icon="plus"
                          label="在此项目中启动对话"
                          disabled={!canStartSession}
                          onClick={() => void onStartSession().catch(() => undefined)}
                        />
                      ) : null}
                    </div>

                    {selected ? (
                      <div className="session-list">
                        {sessions.length === 0 ? (
                          <p className="empty-session-state muted">暂无对话。</p>
                        ) : sessions.map((summary) => {
                          const active = summary.key === activeSessionKey
                          const canActivate = canChangeSession && (runtime.status !== 'ready' || !active)
                          const summaryStatus = active ? runtime.status : 'stopped'
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
                                <span
                                  className={`status-dot ${runtimeStatusClass(summaryStatus)}`}
                                  aria-hidden="true"
                                />
                                <span className="session-text">
                                  <span className="session-title">{sessionTitle(summary)}</span>
                                  <span className="session-detail">
                                    {sessionDetail(active, runtime.status, messageCount)}
                                  </span>
                                </span>
                              </button>
                              <div className="session-action-slot" aria-hidden="true">
                                {active ? (
                                  <span className="session-side-meta">
                                    <span className="session-recency">
                                      {session.settled ? '当前' : '进行中'}
                                    </span>
                                  </span>
                                ) : null}
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
          <SidebarIconButton
            className="sidebar-collapse-toggle"
            icon="left-sidebar-close"
            label="收起侧边栏"
            onClick={() => setSidebarCollapsed(true)}
          />
          <SidebarIconButton
            className="add-project-entry"
            icon="plus"
            label="添加项目"
            disabled={!canChangeProject}
            onClick={() => void onAddProject().catch(() => undefined)}
          />
        </footer>
      </aside>

      <section className="main-chat" aria-label={`${projectName} 对话工作区`}>
        {sidebarCollapsed ? (
          <div className="left-sidebar-bottom-triggers">
            <SidebarIconButton
              className="left-sidebar-trigger"
              icon="left-sidebar-open"
              label="展开侧边栏"
              onClick={() => setSidebarCollapsed(false)}
            />
          </div>
        ) : null}

        <header className="workbench-session-header">
          <div className="workbench-session-heading">
            <div className="workbench-header-project">
              <span className="workbench-header-label">Project</span>
              <strong title={activeProject?.path}>{projectName}</strong>
            </div>
            <div className="workbench-header-session">
              <span className="workbench-header-label">Session</span>
              <strong>{activeSession === null ? '尚未选择' : sessionTitle(activeSession)}</strong>
              <small>{session.id === null ? '尚未创建' : `${messageCount} 条消息`}</small>
            </div>
            <div className="workbench-header-runtime">
              <span className={`status-dot ${runtimeStatusClass(runtime.status)}`} aria-hidden="true" />
              <span>
                <span className="workbench-header-label">Runtime</span>
                <strong>{STATUS_LABELS[runtime.status]}</strong>
                <small>{runtime.version ? `Pi ${runtime.version}` : 'Pi 未启动'}</small>
              </span>
            </div>
          </div>

          <details className="runtime-diagnostics">
            <summary className="main-chat-diagnostics-trigger">
              <Icon name="right-sidebar" />
              <span>运行诊断</span>
            </summary>
            <div className="runtime-diagnostics-panel">
              <dl>
                <div><dt>状态</dt><dd>{STATUS_LABELS[runtime.status]}</dd></div>
                <div><dt>Pi</dt><dd>{runtime.version ?? '—'}</dd></div>
                <div><dt>stderr</dt><dd>{runtime.stderrChars}</dd></div>
                <div><dt>stderr 摘要</dt><dd>{runtime.stderrSummary ?? '—'}</dd></div>
                <div><dt>Exit</dt><dd>{runtime.exitCode ?? runtime.exitSignal ?? '—'}</dd></div>
              </dl>
            </div>
          </details>
        </header>

        <Timeline
          key={`${activeProjectKey ?? 'no-project'}:${activeSessionKey ?? 'new-session'}`}
          entries={conversation.entries}
          activeRunStartIndex={conversation.activeRunStartIndex}
          runtimeStatus={runtime.status}
          warning={actionError ?? (runtime.status === 'crashed' ? runtime.lastError : null)}
        />

        <Composer
          state={state}
          busy={busy}
          onStartSession={onStartSession}
          onActivateSession={onActivateSession}
          onPrompt={onPrompt}
          onAbort={onAbort}
          onSetThinkingLevel={onSetThinkingLevel}
        />
      </section>
    </main>
  )
}

type SidebarIconButtonProps = {
  className: string
  icon: IconName
  label: string
  disabled?: boolean
  onClick?: () => void
}

function SidebarIconButton({
  className,
  icon,
  label,
  disabled = false,
  onClick
}: SidebarIconButtonProps): React.JSX.Element {
  return (
    <button
      className={className}
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} />
    </button>
  )
}

function runtimeStatusClass(status: RuntimeStatus): string {
  if (status === 'ready') return 'task-idle'
  if (status === 'running') return 'task-busy'
  return status
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

function sessionDetail(active: boolean, status: RuntimeStatus, messageCount: number): string {
  if (!active) return '可恢复'
  if (status === 'ready' || status === 'running') return `${messageCount} 条消息`
  if (status === 'crashed') return '已崩溃 · 可恢复'
  if (status === 'stopped') return '可恢复'
  return STATUS_LABELS[status]
}
