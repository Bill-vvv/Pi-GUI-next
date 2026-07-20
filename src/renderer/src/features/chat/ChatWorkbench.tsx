import type {
  KernelState,
  RuntimeStatus,
  ThinkingLevel
} from '../../../../shared/kernel-contract'
import { Composer } from '../composer/Composer'
import { Timeline } from './Timeline'

type ChatWorkbenchProps = {
  state: KernelState
  pendingAction: string | null
  actionError: string | null
  onPrompt: (message: string) => Promise<void>
  onAbort: () => Promise<void>
  onSetThinkingLevel: (level: ThinkingLevel) => Promise<void>
}

const STATUS_LABELS: Record<RuntimeStatus, string> = {
  stopped: '已停止',
  starting: '启动中',
  ready: '就绪',
  running: '执行中',
  stopping: '停止中',
  crashed: '已崩溃'
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

export function ChatWorkbench({
  state,
  pendingAction,
  actionError,
  onPrompt,
  onAbort,
  onSetThinkingLevel
}: ChatWorkbenchProps): React.JSX.Element {
  const { project, runtime, session, conversation } = state
  const projectName = basename(project.path) ?? 'Project'
  const messageCount = conversation.entries.filter((entry) => entry.kind === 'message').length
  const toolCount = conversation.entries.filter((entry) => entry.kind === 'tool').length
  const busy = pendingAction !== null

  return (
    <main className="workbench-shell">
      <aside className="workbench-sidebar" aria-label="项目与会话">
        <div className="sidebar-brand">
          <span className="sidebar-mark" aria-hidden="true">π</span>
          <div>
            <strong>Pi GUI</strong>
            <small>LOCAL WORKBENCH</small>
          </div>
        </div>

        <nav className="sidebar-nav">
          <section>
            <p className="sidebar-section-label">PROJECT</p>
            <div className="sidebar-item is-active">
              <span className="sidebar-item-icon" aria-hidden="true">P</span>
              <span className="sidebar-item-copy">
                <strong>{projectName}</strong>
                <small className="mono" title={project.path ?? undefined}>{project.path}</small>
              </span>
              <span className="sidebar-state-dot" data-status={runtime.status} />
            </div>
          </section>

          <section>
            <p className="sidebar-section-label">SESSION</p>
            <div className="sidebar-item">
              <span className="sidebar-item-icon" aria-hidden="true">S</span>
              <span className="sidebar-item-copy">
                <strong>{session.name ?? 'Current session'}</strong>
                <small>{messageCount} 条消息 · {toolCount} 次工具</small>
              </span>
            </div>
          </section>
        </nav>

        <div className="sidebar-runtime">
          <details>
            <summary>运行诊断</summary>
            <dl>
              <div><dt>Pi</dt><dd>{runtime.version ?? '—'}</dd></div>
              <div><dt>Trust</dt><dd>{project.trust ?? '—'}</dd></div>
              <div><dt>stderr</dt><dd>{runtime.stderrChars}</dd></div>
              <div><dt>Exit</dt><dd>{runtime.exitCode ?? runtime.exitSignal ?? '—'}</dd></div>
            </dl>
          </details>
        </div>
      </aside>

      <section className="session-workspace" aria-label={`${projectName} 对话工作区`}>
        <header className="session-header">
          <div className="session-title">
            <div>
              <h1>{projectName}</h1>
              <span className="session-identity mono">
                {session.id ? `session ${shortId(session.id)}` : 'ephemeral session'}
              </span>
            </div>
          </div>

          <div className="session-controls">
            <span className="model-chip" title={session.model ? `${session.model.provider}/${session.model.id}` : undefined}>
              <span>MODEL</span>
              <strong>{session.model?.name ?? session.model?.id ?? 'Unavailable'}</strong>
            </span>
            <label className="thinking-control">
              <span>THINKING</span>
              <select
                value={session.thinkingLevel ?? ''}
                disabled={
                  busy ||
                  runtime.status !== 'ready' ||
                  session.thinkingLevel === null ||
                  session.model?.reasoning === false
                }
                onChange={(event) => {
                  void onSetThinkingLevel(event.target.value as ThinkingLevel).catch(() => undefined)
                }}
              >
                {session.thinkingLevel === null && <option value="">Unavailable</option>}
                {THINKING_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
              </select>
            </label>
            <span className="runtime-pill" data-status={runtime.status}>
              <span className="runtime-pill-dot" aria-hidden="true" />
              {STATUS_LABELS[runtime.status]}
            </span>
          </div>
        </header>

        {(actionError || runtime.status === 'crashed') && (
          <div className="workbench-error" role="alert">
            <strong>{runtime.status === 'crashed' ? 'Pi Runtime 已退出' : '操作失败'}</strong>
            <span>{actionError ?? runtime.lastError ?? 'Runtime crashed unexpectedly.'}</span>
          </div>
        )}

        <Timeline entries={conversation.entries} runtimeStatus={runtime.status} />

        <Composer
          runtimeStatus={runtime.status}
          busy={busy}
          onPrompt={onPrompt}
          onAbort={onAbort}
        />

        <footer className="status-bar">
          <span className="status-path mono" title={project.path ?? undefined}>{project.path}</span>
          <span className="status-spacer" />
          <span>{messageCount} messages</span>
          <span>{toolCount} tools</span>
          <span>{session.thinkingLevel ? `think:${session.thinkingLevel}` : 'think:—'}</span>
          <span className="status-runtime" data-status={runtime.status}>{STATUS_LABELS[runtime.status]}</span>
        </footer>
      </section>
    </main>
  )
}

function basename(path: string | null): string | null {
  if (path === null) return null
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? path
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id
}
