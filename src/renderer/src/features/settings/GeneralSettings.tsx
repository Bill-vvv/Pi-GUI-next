import type {
  GeneralSettings as GeneralSettingsValue,
  KernelModelState,
  SessionNamingSettings
} from '../../../../shared/kernel-contract'
import { Select, type SelectOptionGroup } from '../../components/Select'
import { SettingsPageHeading } from './SettingsPageHeading'

export function GeneralSettings({
  general,
  sessionNaming,
  availableModels,
  clientOnly,
  environmentPanel,
  busy,
  onSetGeneral,
  onSetSessionNaming
}: {
  general: GeneralSettingsValue
  sessionNaming: SessionNamingSettings
  availableModels: KernelModelState[]
  clientOnly: boolean
  environmentPanel?: React.ReactNode
  busy: boolean
  onSetGeneral: (settings: GeneralSettingsValue) => Promise<void>
  onSetSessionNaming: (settings: SessionNamingSettings) => Promise<void>
}): React.JSX.Element {
  const namingValue = sessionNamingValue(sessionNaming)
  const selectedNamingModel = sessionNaming.mode === 'model' ? sessionNaming : null
  const selectedNamingModelAvailable = selectedNamingModel === null || availableModels.some(
    (model) => model.provider === selectedNamingModel.provider && model.id === selectedNamingModel.modelId
  )
  const namingOptionGroups: SelectOptionGroup[] = [
    {
      options: [
        { value: 'auto', label: '自动选择低成本模型（推荐）' },
        { value: 'off', label: '关闭' }
      ]
    },
    {
      label: '指定已授权模型',
      options: [
        ...(!selectedNamingModelAvailable && selectedNamingModel !== null
          ? [{
              value: namingValue,
              label: `${selectedNamingModel.provider}/${selectedNamingModel.modelId}（当前不可用）`,
              disabled: true
            }]
          : []),
        ...availableModels.map((model) => ({
          value: sessionNamingModelValue(model.provider, model.id),
          label: `${model.provider}/${model.name}`
        }))
      ]
    }
  ]

  return (
    <>
      <SettingsPageHeading title="常规" />
      {environmentPanel}

      {!clientOnly ? <>
      <section
        className="settings-group settings-group-inline settings-prefs"
        aria-labelledby="settings-general-startup"
      >
        <h3 id="settings-general-startup" className="settings-group-heading">启动</h3>
        <div className="settings-group-card">
          <div className="settings-row">
            <div className="settings-row-copy">
              <h4>启动后显示</h4>
              <p>打开应用时，是否自动回到上次使用的项目和对话</p>
            </div>
            <div className="settings-row-control">
              <Select
                id="general-startup-workspace-restore"
                value={general.startupWorkspaceRestore}
                groups={[{
                  options: [
                    { value: 'restore', label: '继续上次使用' },
                    { value: 'none', label: '不自动打开项目' }
                  ]
                }]}
                disabled={busy}
                onValueChange={(startupWorkspaceRestore) => {
                  if (startupWorkspaceRestore !== 'restore' && startupWorkspaceRestore !== 'none') return
                  void onSetGeneral({
                    ...general,
                    startupWorkspaceRestore
                  }).catch(() => undefined)
                }}
              />
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-copy">
              <label htmlFor="general-auto-continue-interrupted-tasks">
                自动继续重启中断的任务（调试）
              </label>
              <p>
                正常退出时精确记录所有仍在运行的已保存对话，下次启动在后台逐个恢复并发送一次继续指令，且不改变前台选择。
                默认关闭；可能重新触发模型和工具，不适用于崩溃或强制结束进程。
              </p>
            </div>
            <div className="settings-row-control settings-checkbox-control">
              <input
                id="general-auto-continue-interrupted-tasks"
                type="checkbox"
                checked={general.autoContinueInterruptedTasks}
                disabled={busy}
                onChange={(event) => {
                  void onSetGeneral({
                    ...general,
                    autoContinueInterruptedTasks: event.currentTarget.checked
                  }).catch(() => undefined)
                }}
              />
            </div>
          </div>
        </div>
      </section>

      <section
        className="settings-group settings-group-inline settings-prefs"
        aria-labelledby="settings-session-naming"
      >
        <h3 id="settings-session-naming" className="settings-group-heading">对话</h3>
        <div className="settings-group-card">
          <div className="settings-row">
            <div className="settings-row-copy">
              <label htmlFor="session-naming-mode">自动对话命名</label>
              <p>认证由 Pi 管理；自动模式只使用当前已授权 Provider 中的低成本模型</p>
            </div>
            <div className="settings-row-control">
              <Select
                id="session-naming-mode"
                value={namingValue}
                groups={namingOptionGroups}
                disabled={busy}
                onValueChange={(value) => {
                  const settings = resolveSessionNaming(value, availableModels)
                  if (settings !== null) void onSetSessionNaming(settings).catch(() => undefined)
                }}
              />
            </div>
          </div>
        </div>
      </section>

      </> : null}

      <section
        className="settings-group settings-group-inline settings-prefs"
        aria-labelledby="settings-general-window"
      >
        <h3 id="settings-general-window" className="settings-group-heading">窗口</h3>
        <div className="settings-group-card">
          <div className="settings-row">
            <div className="settings-row-copy">
              <h4>双击边框最大化</h4>
              <p>双击窗口四周边框时切换最大化。独占全屏请用 F11</p>
            </div>
            <div className="settings-row-control">
              <Select
                id="general-double-click-border-maximize"
                value={general.doubleClickBorderMaximize === false ? 'off' : 'on'}
                groups={[{
                  options: [
                    { value: 'on', label: '开启' },
                    { value: 'off', label: '关闭' }
                  ]
                }]}
                disabled={busy}
                onValueChange={(value) => {
                  if (value !== 'on' && value !== 'off') return
                  void onSetGeneral({
                    ...general,
                    doubleClickBorderMaximize: value === 'on'
                  }).catch(() => undefined)
                }}
              />
            </div>
          </div>
        </div>
      </section>

      {!clientOnly ? (
      <section
        className="settings-group settings-group-inline settings-prefs"
        aria-labelledby="settings-general-extensions"
      >
        <h3 id="settings-general-extensions" className="settings-group-heading">拓展</h3>
        <div className="settings-group-card">
          <div className="settings-row">
            <div className="settings-row-copy">
              <label htmlFor="general-fast-extension-loading">
                拓展启动加速（实验性）
              </label>
              <p>
                已编译 JS 优先使用原生导入，多个拓展并行导入；factory
                仍按原顺序执行。仅影响新建或显式重载的会话。
              </p>
            </div>
            <div className="settings-row-control settings-checkbox-control">
              <input
                id="general-fast-extension-loading"
                type="checkbox"
                checked={general.fastExtensionLoading}
                disabled={busy}
                onChange={(event) => {
                  void onSetGeneral({
                    ...general,
                    fastExtensionLoading: event.currentTarget.checked
                  }).catch(() => undefined)
                }}
              />
            </div>
          </div>
        </div>
      </section>
      ) : null}
    </>
  )
}

function resolveSessionNaming(
  value: string,
  availableModels: readonly KernelModelState[]
): SessionNamingSettings | null {
  if (value === 'auto') return { mode: 'auto' }
  if (value === 'off') return { mode: 'off' }
  const model = availableModels.find(
    (candidate) => sessionNamingModelValue(candidate.provider, candidate.id) === value
  )
  return model === undefined
    ? null
    : { mode: 'model', provider: model.provider, modelId: model.id }
}

function sessionNamingValue(settings: SessionNamingSettings): string {
  return settings.mode === 'model'
    ? sessionNamingModelValue(settings.provider, settings.modelId)
    : settings.mode
}

function sessionNamingModelValue(provider: string, modelId: string): string {
  return `model:${encodeURIComponent(provider)}:${encodeURIComponent(modelId)}`
}
