import type { KernelState } from '../../../../shared/kernel-contract'

type ProjectStartupProps = {
  state: KernelState
  pendingAction: string | null
  error: string | null
  onAddProject: () => Promise<void>
  onStart: () => Promise<void>
}

export function ProjectStartup({
  state,
  pendingAction,
  error,
  onAddProject,
  onStart
}: ProjectStartupProps): React.JSX.Element {
  const { projects, activeProjectKey, runtime } = state
  const activeProject = activeProjectKey === null
    ? null
    : projects.find((project) => project.path === activeProjectKey) ?? null
  const busy = pendingAction !== null || runtime.status === 'starting'
  const canStart = !busy && activeProject !== null

  return (
    <main className="startup-shell">
      <section className="startup-intro" aria-labelledby="startup-title">
        <div className="startup-brand" aria-hidden="true">π</div>
        <p className="eyebrow">PI CODING AGENT</p>
        <h1 id="startup-title">让本地 Agent<br />进入工作状态。</h1>
        <p className="startup-copy">
          选择项目，然后进入一条可观察、可中止的本地执行链路。
        </p>
        <div className="startup-proof">
          <span className="proof-dot" />
          <span>Linux local · Pi {runtime.version ?? '0.80.10'}</span>
        </div>
      </section>

      <section className="startup-panel" aria-labelledby="project-title">
        <div className="startup-panel-heading">
          <div>
            <p className="eyebrow">PROJECT</p>
            <h2 id="project-title">启动工作区</h2>
          </div>
          <span className="step-label">01 / 01</span>
        </div>

        <div className="project-path-block">
          <span className="field-label">项目目录</span>
          <div className="project-path-row">
            <span className="project-path mono" title={activeProject?.path}>
              {activeProject?.path ?? '尚未选择目录'}
            </span>
            <button
              className="secondary-action"
              type="button"
              disabled={busy || runtime.status !== 'stopped'}
              onClick={() => void onAddProject().catch(() => undefined)}
            >
              {pendingAction === 'add-project' ? '选择中…' : '添加目录'}
            </button>
          </div>
        </div>

        {error && (
          <div className="inline-error" role="alert">
            <strong>无法启动工作区</strong>
            <span>{error}</span>
          </div>
        )}

        <button
          className="primary-action"
          type="button"
          disabled={!canStart}
          onClick={() => void onStart().catch(() => undefined)}
        >
          <span>{busy ? '正在连接 Pi…' : '进入工作区'}</span>
          <span aria-hidden="true">→</span>
        </button>
      </section>
    </main>
  )
}
