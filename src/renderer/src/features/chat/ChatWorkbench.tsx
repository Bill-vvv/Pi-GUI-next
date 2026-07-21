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
  onSelectProject: () => Promise<void>
  onStart: () => Promise<void>
  onResume: () => Promise<void>
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
  onSelectProject,
  onStart,
  onResume,
  onPrompt,
  onAbort,
  onSetThinkingLevel
}: ChatWorkbenchProps): React.JSX.Element {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const { project, runtime, session, conversation } = state
  const projectName = basename(project.path) ?? '未选择项目'
  const messageCount = conversation.entries.filter((entry) => entry.kind === 'message').length
  const busy = pendingAction !== null
  const canStart =
    (runtime.status === 'stopped' || runtime.status === 'crashed') &&
    project.path !== null &&
    !busy
  const canResume =
    (runtime.status === 'stopped' || runtime.status === 'crashed') &&
    project.path !== null &&
    session.resumeAvailable &&
    !busy

  return (
    <main className={`app-shell${sidebarCollapsed ? ' left-sidebar-collapsed' : ''}`}>
      <aside className="left-sidebar" aria-label="项目与对话">
        <div className="sidebar-content">
          <section className="sidebar-section project-list-section" aria-label="项目">
            {project.path === null ? (
              <div className="empty-project-actions">
                <p className="muted">暂无项目。</p>
                <SidebarIconButton
                  className="empty-project-add"
                  icon="plus"
                  label="添加项目"
                  disabled={busy || runtime.status !== 'stopped'}
                  onClick={() => void onSelectProject().catch(() => undefined)}
                />
              </div>
            ) : (
              <article className="project-session-group selected">
                <div className="project-row">
                  <button
                    className="project-select"
                    type="button"
                    title={runtime.status === 'stopped' ? '更换项目' : project.path}
                    onClick={() => {
                      if (runtime.status === 'stopped' && !busy) {
                        void onSelectProject().catch(() => undefined)
                      }
                    }}
                  >
                    <strong>{projectName}</strong>
                    <small>{project.path}</small>
                  </button>
                  <SidebarIconButton
                    className="project-new-chat"
                    icon="plus"
                    label="在此项目中启动对话"
                    disabled={!canStart}
                    onClick={() => void onStart().catch(() => undefined)}
                  />
                </div>

                <div className="session-list">
                  <div className="session-row selected">
                    <button
                      className="session-item"
                      type="button"
                      onClick={() => {
                        if (canResume) {
                          void onResume().catch(() => undefined)
                        } else if (canStart) {
                          void onStart().catch(() => undefined)
                        }
                      }}
                    >
                      <span className={`status-dot ${runtimeStatusClass(runtime.status)}`} aria-hidden="true" />
                      <span className="session-text">
                        <span className="session-title">{session.name ?? '当前对话'}</span>
                        <span className="session-detail">
                          {runtime.status === 'ready' || runtime.status === 'running'
                            ? `${messageCount} 条消息`
                            : canResume
                              ? runtime.status === 'crashed' ? '已崩溃 · 可恢复' : '可恢复'
                              : STATUS_LABELS[runtime.status]}
                        </span>
                      </span>
                    </button>
                    <div className="session-action-slot" aria-hidden="true">
                      <span className="session-side-meta">
                        <span className="session-recency">{session.settled ? '现在' : '进行中'}</span>
                      </span>
                    </div>
                  </div>
                </div>
              </article>
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
            disabled={busy || runtime.status !== 'stopped'}
            onClick={() => void onSelectProject().catch(() => undefined)}
          />
          <SidebarIconButton
            className="archive-entry"
            icon="archive"
            label="P1 暂无历史对话"
            disabled
          />
          <SidebarIconButton
            className="settings-entry"
            icon="settings"
            label="运行诊断"
            onClick={() => setDiagnosticsOpen((open) => !open)}
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

        <details
          className="runtime-diagnostics"
          open={diagnosticsOpen}
          onToggle={(event) => setDiagnosticsOpen(event.currentTarget.open)}
        >
          <summary className="main-chat-diagnostics-trigger" aria-label="运行诊断" title="运行诊断">
            <Icon name="right-sidebar" />
          </summary>
          <div className="runtime-diagnostics-popover">
            <strong>运行诊断</strong>
            <dl>
              <div><dt>状态</dt><dd>{STATUS_LABELS[runtime.status]}</dd></div>
              <div><dt>Pi</dt><dd>{runtime.version ?? '—'}</dd></div>
              <div><dt>stderr</dt><dd>{runtime.stderrChars}</dd></div>
              <div><dt>stderr 摘要</dt><dd>{runtime.stderrSummary ?? '—'}</dd></div>
              <div><dt>Exit</dt><dd>{runtime.exitCode ?? runtime.exitSignal ?? '—'}</dd></div>
            </dl>
          </div>
        </details>

        <Timeline
          key={`${project.path ?? 'no-project'}:${session.id ?? 'new-session'}`}
          entries={conversation.entries}
          activeRunStartIndex={conversation.activeRunStartIndex}
          runtimeStatus={runtime.status}
          title={project.path === null ? undefined : session.name ?? '当前对话'}
          warning={actionError ?? (runtime.status === 'crashed' ? runtime.lastError : null)}
        />

        <Composer
          state={state}
          busy={busy}
          onSelectProject={onSelectProject}
          onStart={onStart}
          onResume={onResume}
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
