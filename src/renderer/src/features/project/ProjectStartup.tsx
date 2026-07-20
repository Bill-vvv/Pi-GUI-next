import type {
  KernelState,
  ProjectTrust
} from '../../../../shared/kernel-contract'

type ProjectStartupProps = {
  state: KernelState
  pendingAction: string | null
  error: string | null
  onSelectProject: () => Promise<void>
  onSetTrust: (trust: ProjectTrust) => Promise<void>
  onStart: () => Promise<void>
}

export function ProjectStartup({
  state,
  pendingAction,
  error,
  onSelectProject,
  onSetTrust,
  onStart
}: ProjectStartupProps): React.JSX.Element {
  const { project, runtime } = state
  const busy = pendingAction !== null || runtime.status === 'starting'
  const canStart = !busy && project.path !== null && project.trust !== null

  return (
    <main className="startup-shell">
      <section className="startup-intro" aria-labelledby="startup-title">
        <div className="startup-brand" aria-hidden="true">π</div>
        <p className="eyebrow">PI CODING AGENT</p>
        <h1 id="startup-title">让本地 Agent<br />进入工作状态。</h1>
        <p className="startup-copy">
          选择项目、确认信任边界，然后进入一条可观察、可中止的本地执行链路。
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
            <span className="project-path mono" title={project.path ?? undefined}>
              {project.path ?? '尚未选择目录'}
            </span>
            <button
              className="secondary-action"
              type="button"
              disabled={busy || runtime.status !== 'stopped'}
              onClick={() => void onSelectProject().catch(() => undefined)}
            >
              {pendingAction === 'select-project' ? '选择中…' : '选择目录'}
            </button>
          </div>
        </div>

        <fieldset
          className="trust-fieldset"
          disabled={busy || project.path === null || runtime.status !== 'stopped'}
        >
          <legend className="field-label">项目信任</legend>
          <div className="trust-grid">
            <TrustOption
              value="trusted"
              selected={project.trust === 'trusted'}
              title="可信项目"
              description="Pi 可以执行工具，无需逐次批准。"
              onSelect={onSetTrust}
            />
            <TrustOption
              value="untrusted"
              selected={project.trust === 'untrusted'}
              title="受限项目"
              description="Pi 以 no-approve 模式运行。"
              onSelect={onSetTrust}
            />
          </div>
        </fieldset>

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

type TrustOptionProps = {
  value: ProjectTrust
  selected: boolean
  title: string
  description: string
  onSelect: (trust: ProjectTrust) => Promise<void>
}

function TrustOption({
  value,
  selected,
  title,
  description,
  onSelect
}: TrustOptionProps): React.JSX.Element {
  return (
    <label className="trust-option" data-selected={selected}>
      <input
        type="radio"
        name="project-trust"
        value={value}
        checked={selected}
        onChange={() => void onSelect(value).catch(() => undefined)}
      />
      <span className="trust-radio" aria-hidden="true" />
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
    </label>
  )
}
