import { useEffect, useState } from 'react'

import type {
  AppearanceSettings,
  GeneralSettings,
  KernelCommandDescriptor,
  KernelExtensionSelectionKind,
  KernelInstalledPackage,
  KernelPiDevCatalog,
  KernelProviderConfig,
  KernelProviderInput,
  KernelProviderTestResult,
  KernelState,
  SessionNamingSettings
} from '../../../../shared/kernel-contract'
import { FontSelect } from '../../components/FontSelect'
import { Select, type SelectOptionGroup } from '../../components/Select'
import { InstalledPackages } from './InstalledPackages'
import { PiDevCatalog } from './PiDevCatalog'
import { ProviderSettings } from './ProviderSettings'
import {
  TOOL_DISPLAY_DENSITIES,
  type ToolDisplayDensity
} from '../../tool-display-density'

export type SettingsSection =
  | 'general'
  | 'models'
  | 'appearance'
  | 'packages'
  | 'extensions'
  | 'skills'
  | 'preferences'

type SettingsPanelProps = {
  state: KernelState
  busy: boolean
  section: SettingsSection
  pendingAction: string | null
  extensionActionError: string | null
  actionError: string | null
  systemFonts: string[] | null
  systemFontsError: string | null
  onInstallExtension: (kind: KernelExtensionSelectionKind) => Promise<void>
  onRemoveExtension: (path: string) => Promise<void>
  onSearchPiDevExtensions: (query: string) => Promise<KernelPiDevCatalog>
  onSearchPiDevPackages: (query: string) => Promise<KernelPiDevCatalog>
  onListPiPackages: () => Promise<KernelInstalledPackage[]>
  onInstallPiDevPackage: (name: string) => Promise<void>
  onRemovePiPackage: (source: string) => Promise<void>
  onUpdatePiPackage: (source: string) => Promise<void>
  onUpdatePiPackages: () => Promise<void>
  onOpenExternal: (url: string) => Promise<void>
  onCreateSkill: (prompt: string) => Promise<void>
  onListProviders: () => Promise<KernelProviderConfig[]>
  onSaveProvider: (provider: KernelProviderInput) => Promise<KernelProviderConfig[]>
  onRemoveProvider: (providerId: string) => Promise<KernelProviderConfig[]>
  onTestProvider: (providerId: string, modelId: string) => Promise<KernelProviderTestResult>
  onSetModel: (provider: string, modelId: string) => Promise<void>
  onSetSessionNaming: (settings: SessionNamingSettings) => Promise<void>
  onSetGeneral: (settings: GeneralSettings) => Promise<void>
  onSetAppearance: (settings: AppearanceSettings) => Promise<void>
  toolDisplayDensity: ToolDisplayDensity
  onSetToolDisplayDensity: (density: ToolDisplayDensity) => void
}

export function SettingsPanel({
  state,
  busy,
  section,
  pendingAction,
  extensionActionError,
  actionError,
  systemFonts,
  systemFontsError,
  onInstallExtension,
  onRemoveExtension,
  onSearchPiDevExtensions,
  onSearchPiDevPackages,
  onListPiPackages,
  onInstallPiDevPackage,
  onRemovePiPackage,
  onUpdatePiPackage,
  onUpdatePiPackages,
  onOpenExternal,
  onCreateSkill,
  onListProviders,
  onSaveProvider,
  onRemoveProvider,
  onTestProvider,
  onSetModel,
  onSetSessionNaming,
  onSetGeneral,
  onSetAppearance,
  toolDisplayDensity,
  onSetToolDisplayDensity
}: SettingsPanelProps): React.JSX.Element {
  const [removingExtensionPath, setRemovingExtensionPath] = useState<string | null>(null)
  const [packageRevision, setPackageRevision] = useState(0)
  const [skillCreatorOpen, setSkillCreatorOpen] = useState(false)
  const [skillName, setSkillName] = useState('')
  const [skillPurpose, setSkillPurpose] = useState('')
  const [skillScope, setSkillScope] = useState<'user' | 'project'>('user')
  const [skillCreatorError, setSkillCreatorError] = useState<string | null>(null)
  const [selectedProvider, setSelectedProvider] = useState(
    state.session.model?.provider ?? state.availableModels[0]?.provider ?? ''
  )
  const providers = [...new Set(state.availableModels.map((model) => model.provider))]
  const currentModel = state.session.model
  const currentProviderAvailable = currentModel === null || providers.includes(currentModel.provider)
  const providerValue = providers.includes(selectedProvider) ||
    currentModel?.provider === selectedProvider
    ? selectedProvider
    : providers[0] ?? ''
  const providerModels = state.availableModels.filter((model) => model.provider === providerValue)
  const selectedCurrentModel = currentModel?.provider === providerValue ? currentModel : null
  const selectedCurrentModelAvailable = selectedCurrentModel === null || providerModels.some(
    (model) => model.id === selectedCurrentModel.id
  )
  const activeModelValue = selectedCurrentModel !== null
    ? selectedCurrentModel.id
    : ''
  const canSetModel = !busy && state.runtime.status === 'ready' && providers.length > 0
  useEffect(() => {
    if (state.session.model !== null) setSelectedProvider(state.session.model.provider)
  }, [state.session.model?.provider])
  const namingValue = sessionNamingValue(state.sessionNaming)
  const selectedNamingModel = state.sessionNaming.mode === 'model' ? state.sessionNaming : null
  const selectedNamingModelAvailable = selectedNamingModel === null || state.availableModels.some(
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
        ...state.availableModels.map((model) => ({
          value: sessionNamingModelValue(model.provider, model.id),
          label: `${model.provider}/${model.name}`
        }))
      ]
    }
  ]
  const themeOptionGroups: SelectOptionGroup[] = [{
    options: [
      { value: 'system', label: '跟随系统' },
      { value: 'dark', label: '深色' },
      { value: 'light', label: '浅色' }
    ]
  }]
  const textSizeOptionGroups: SelectOptionGroup[] = [{
    options: [
      { value: 'small', label: '小' },
      { value: 'default', label: '默认' },
      { value: 'large', label: '大' }
    ]
  }]
  const accentColorOptionGroups: SelectOptionGroup[] = [{
    options: [
      { value: 'amber', label: '琥珀色' },
      { value: 'blue', label: '蓝色' },
      { value: 'green', label: '绿色' },
      { value: 'purple', label: '紫色' },
      { value: 'rose', label: '玫红色' }
    ]
  }]
  const transparencyOptionGroups: SelectOptionGroup[] = [{
    options: [0, 10, 20, 30, 40].map((value) => ({
      value: String(value),
      label: `${value}%`
    }))
  }]
  const skillCommands = state.commands.filter((command) => command.source === 'skill')
  return (
    <section className="settings-screen" aria-label="设置">
      <div className="settings-content">
        {actionError === null ? null : (
          <p className="settings-action-error" role="alert">{actionError}</p>
        )}
        {section === 'general' ? (
          <>
            <div className="settings-section-heading">
              <h2>常规</h2>
            </div>

            <section className="settings-group" aria-labelledby="settings-general-startup">
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
                      value={state.general.startupWorkspaceRestore}
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
                          ...state.general,
                          startupWorkspaceRestore
                        }).catch(() => undefined)
                      }}
                    />
                  </div>
                </div>
              </div>
            </section>

            <section className="settings-group" aria-labelledby="settings-general-window">
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
                      value={state.general.doubleClickBorderMaximize === false ? 'off' : 'on'}
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
                          ...state.general,
                          doubleClickBorderMaximize: value === 'on'
                        }).catch(() => undefined)
                      }}
                    />
                  </div>
                </div>
              </div>
            </section>

            <section className="settings-group" aria-label="界面强调">
              <div className="settings-group-card">
                <div className="settings-row">
                  <div className="settings-row-copy">
                    <h4>强调色</h4>
                    <p>用于链接、选中状态与重点提示</p>
                  </div>
                  <div className="settings-row-control settings-theme-control">
                    <Select
                      id="appearance-accent-color"
                      value={state.appearance.accentColor}
                      groups={accentColorOptionGroups}
                      disabled={busy}
                      onValueChange={(value) => {
                        if (!isAppearanceAccentColor(value)) return
                        void onSetAppearance({
                          ...state.appearance,
                          accentColor: value
                        }).catch(() => undefined)
                      }}
                    />
                  </div>
                </div>
                <div className="settings-row">
                  <div className="settings-row-copy">
                    <h4>面板透明度</h4>
                    <p>调整侧栏、卡片与 Composer 面板的通透程度</p>
                  </div>
                  <div className="settings-row-control settings-theme-control">
                    <Select
                      id="appearance-surface-transparency"
                      value={String(state.appearance.surfaceTransparency)}
                      groups={transparencyOptionGroups}
                      disabled={busy}
                      onValueChange={(value) => {
                        const surfaceTransparency = Number(value)
                        if (!isSurfaceTransparency(surfaceTransparency)) return
                        void onSetAppearance({
                          ...state.appearance,
                          surfaceTransparency
                        }).catch(() => undefined)
                      }}
                    />
                  </div>
                </div>
              </div>
            </section>
          </>
        ) : null}

        {section === 'appearance' ? (
          <>
            <div className="settings-section-heading">
              <h2>外观</h2>
            </div>

            <section className="settings-group" aria-label="主题">
              <div className="settings-group-card">
                <div className="settings-row">
                  <div className="settings-row-copy">
                    <h4>界面主题</h4>
                    <p>{appearanceThemeDescription(state.appearance.theme)}</p>
                  </div>
                  <div className="settings-row-control settings-theme-control">
                    <Select
                      id="appearance-theme"
                      value={state.appearance.theme}
                      groups={themeOptionGroups}
                      disabled={busy}
                      onValueChange={(value) => {
                        if (!isAppearanceTheme(value)) return
                        void onSetAppearance({
                          ...state.appearance,
                          theme: value
                        }).catch(() => undefined)
                      }}
                    />
                  </div>
                </div>
              </div>
            </section>

            <section className="settings-group" aria-labelledby="appearance-conversation-heading">
              <h3 id="appearance-conversation-heading" className="settings-group-heading">Agent 对话</h3>
              <div className="settings-group-card">
                <div className="settings-row settings-tool-density">
                  <div className="settings-row-copy">
                    <h4>工作过程密度</h4>
                    <p>调整思考与操作在对话中的显示程度</p>
                  </div>
                  <div className="settings-density-control">
                    <input
                      aria-label="工作过程详细程度"
                      className="settings-density-slider"
                      type="range"
                      min="0"
                      max={String(TOOL_DISPLAY_DENSITIES.length - 1)}
                      step="1"
                      value={String(TOOL_DISPLAY_DENSITIES.indexOf(toolDisplayDensity))}
                      onChange={(event) => {
                        const density = TOOL_DISPLAY_DENSITIES[Number(event.currentTarget.value)]
                        if (density !== undefined) onSetToolDisplayDensity(density)
                      }}
                    />
                    <div className="settings-density-labels" aria-hidden="true">
                      <span>紧凑</span>
                      <span>标准</span>
                      <span>详细</span>
                    </div>
                  </div>
                </div>
                <div className="settings-density-examples" aria-label="工作过程三档显示差异">
                  <DensityExample
                    density="compact"
                    selected={toolDisplayDensity === 'compact'}
                    title="紧凑"
                    description="只显示一行状态"
                  />
                  <DensityExample
                    density="standard"
                    selected={toolDisplayDensity === 'standard'}
                    title="标准"
                    description="过程正文与单行状态"
                  />
                  <DensityExample
                    density="detailed"
                    selected={toolDisplayDensity === 'detailed'}
                    title="详细"
                    description="显示完整工作过程"
                  />
                </div>
              </div>
            </section>

            <section className="settings-group" aria-labelledby="appearance-typography-heading">
              <h3 id="appearance-typography-heading" className="settings-group-heading">字体</h3>
              <div className="settings-group-card">
                <div className="settings-row">
                  <div className="settings-row-copy">
                    <h4>字号大小</h4>
                    <p>调整界面与对话文字的大小</p>
                  </div>
                  <div className="settings-row-control settings-theme-control">
                    <Select
                      id="appearance-text-size"
                      value={state.appearance.textSize}
                      groups={textSizeOptionGroups}
                      disabled={busy}
                      onValueChange={(value) => {
                        if (!isAppearanceTextSize(value)) return
                        void onSetAppearance({
                          ...state.appearance,
                          textSize: value
                        }).catch(() => undefined)
                      }}
                    />
                  </div>
                </div>

                <div className="settings-row">
                  <div className="settings-row-copy">
                    <h4>界面字体</h4>
                    <p>用于界面与对话文字</p>
                  </div>
                  <div className="settings-row-control settings-font-control">
                    <FontSelect
                      id="appearance-ui-font"
                      family={state.appearance.uiFontFamily}
                      systemFonts={systemFonts ?? []}
                      defaultLabel="系统字体"
                      previewKind="ui"
                      disabled={busy || systemFonts === null}
                      onValueChange={(family) => {
                        void onSetAppearance({
                          ...state.appearance,
                          uiFontFamily: family
                        }).catch(() => undefined)
                      }}
                    />
                  </div>
                </div>

                <div className="settings-row">
                  <div className="settings-row-copy">
                    <h4>代码字体</h4>
                    <p>用于代码、命令与文件路径</p>
                  </div>
                  <div className="settings-row-control settings-font-control">
                    <FontSelect
                      id="appearance-code-font"
                      family={state.appearance.codeFontFamily}
                      systemFonts={systemFonts ?? []}
                      defaultLabel="系统等宽字体"
                      previewKind="code"
                      disabled={busy || systemFonts === null}
                      onValueChange={(family) => {
                        void onSetAppearance({
                          ...state.appearance,
                          codeFontFamily: family
                        }).catch(() => undefined)
                      }}
                    />
                  </div>
                </div>
              </div>

              {systemFontsError !== null ? (
                <p className="settings-font-error" role="alert">
                  无法读取系统字体：{systemFontsError}
                </p>
              ) : systemFonts === null ? (
                <p className="settings-font-status" role="status">正在读取系统字体…</p>
              ) : null}
            </section>
          </>
        ) : null}

        {section === 'packages' ? (
          <>
            <div className="settings-section-heading">
              <h2 data-tooltip="Package 安装或卸载后，将在下一次新建或重新打开对话时生效。">
                Package
              </h2>
            </div>
            <InstalledPackages
              busy={busy}
              pendingAction={pendingAction}
              revision={packageRevision}
              onList={onListPiPackages}
              onRemove={async (source) => {
                await onRemovePiPackage(source)
                setPackageRevision((revision) => revision + 1)
              }}
              onUpdate={async (source) => {
                await onUpdatePiPackage(source)
                setPackageRevision((revision) => revision + 1)
              }}
              onUpdateAll={async () => {
                await onUpdatePiPackages()
                setPackageRevision((revision) => revision + 1)
              }}
            />
            <PiDevCatalog
              kind="package"
              busy={busy}
              pendingAction={pendingAction}
              revision={packageRevision}
              onSearch={onSearchPiDevPackages}
              onInstall={async (name) => {
                await onInstallPiDevPackage(name)
                setPackageRevision((revision) => revision + 1)
              }}
              onRemove={async (source) => {
                await onRemovePiPackage(source)
                setPackageRevision((revision) => revision + 1)
              }}
              onOpenExternal={onOpenExternal}
            />
          </>
        ) : null}

        {section === 'extensions' ? (
          <>
            <div className="settings-section-heading">
              <h2 data-tooltip="安装或卸载后，将在下一次新建或重新打开对话时生效。">拓展</h2>
            </div>
            <PiDevCatalog
              kind="extension"
              busy={busy}
              pendingAction={pendingAction}
              revision={packageRevision}
              onSearch={onSearchPiDevExtensions}
              onInstall={async (name) => {
                await onInstallPiDevPackage(name)
                setPackageRevision((revision) => revision + 1)
              }}
              onRemove={async (source) => {
                await onRemovePiPackage(source)
                setPackageRevision((revision) => revision + 1)
              }}
              onOpenExternal={onOpenExternal}
            />
            <section className="settings-group" aria-labelledby="settings-local-extensions-heading">
              <h3 id="settings-local-extensions-heading" className="settings-group-heading">本地路径</h3>
              <article className="settings-card settings-extension-installer">
                <h3 data-tooltip="第三方拓展拥有完整系统权限。选择后，其路径会写入 Pi 用户设置的 extensions。">
                  安装本地拓展
                </h3>
                <div className="settings-extension-install-actions">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void onInstallExtension('file').catch(() => undefined)}
                  >
                    选择文件
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void onInstallExtension('directory').catch(() => undefined)}
                  >
                    选择目录
                  </button>
                </div>
              </article>
              {pendingAction === 'install-extension' || pendingAction === 'remove-extension' ? (
                <p className="settings-extension-status" role="status" aria-live="polite">
                  {pendingAction === 'install-extension' ? '正在安装…' : '正在卸载…'}
                </p>
              ) : null}
              {extensionActionError === null ? null : (
                <p className="settings-extension-error" role="alert">{extensionActionError}</p>
              )}
              {state.extensions.length === 0 ? (
                <div className="settings-empty-state" role="status">
                  <h3>暂无本地拓展</h3>
                </div>
              ) : (
                <div className="settings-extension-list">
                  {state.extensions.map((extension) => (
                    <article className="settings-card" key={extension.path}>
                      <div className="settings-extension-details">
                        <h3>{extension.name}</h3>
                        <code>{extension.path}</code>
                      </div>
                      <button
                        className="settings-extension-remove"
                        type="button"
                        aria-label={`卸载拓展 ${extension.name}`}
                        data-tooltip="仅从 Pi 用户设置中移除此路径，不删除拓展源码。"
                        disabled={busy}
                        onClick={() => {
                          if (!window.confirm(`卸载「${extension.name}」？源码文件不会被删除。`)) return
                          setRemovingExtensionPath(extension.path)
                          void onRemoveExtension(extension.path)
                            .catch(() => undefined)
                            .finally(() => setRemovingExtensionPath(null))
                        }}
                      >
                        {removingExtensionPath === extension.path ? '卸载中…' : '卸载'}
                      </button>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </>
        ) : null}

        {section === 'skills' ? (
          <>
            <div className="settings-section-heading settings-section-heading-with-action">
              <h2>技能</h2>
              <button
                className="settings-skill-create-toggle"
                type="button"
                disabled={busy || state.activeProjectKey === null || state.runtime.status !== 'ready'}
                data-tooltip={
                  state.activeProjectKey === null
                    ? '请先添加并选择一个项目。'
                    : state.runtime.status !== 'ready' ? '请等待 Pi Runtime 就绪。' : undefined
                }
                onClick={() => {
                  setSkillCreatorError(null)
                  setSkillCreatorOpen((open) => !open)
                }}
              >
                {skillCreatorOpen ? '取消' : '新建技能'}
              </button>
            </div>

            {skillCreatorOpen ? (
              <form
                className="settings-card settings-card-stacked settings-skill-creator"
                onSubmit={(event) => {
                  event.preventDefault()
                  const name = skillName.trim()
                  const purpose = skillPurpose.trim()
                  if (!isValidSkillName(name)) {
                    setSkillCreatorError('名称须为 1–64 位小写字母、数字或连字符，且不能以连字符开头、结尾或连续使用。')
                    return
                  }
                  if (purpose.length === 0) {
                    setSkillCreatorError('请说明技能要解决的问题。')
                    return
                  }
                  if (skillScope === 'project' && state.activeProjectKey === null) {
                    setSkillCreatorError('当前项目已不可用，请重新选择项目。')
                    return
                  }
                  const target = skillScope === 'project'
                    ? `${state.activeProjectKey}/.pi/skills/${name}/SKILL.md`
                    : `~/.pi/agent/skills/${name}/SKILL.md`
                  setSkillCreatorError(null)
                  void onCreateSkill(buildSkillCreationPrompt(name, purpose, target))
                    .catch((error: unknown) => {
                      setSkillCreatorError(error instanceof Error ? error.message : '无法启动技能创建任务。')
                    })
                }}
              >
                <div className="settings-skill-field">
                  <label htmlFor="settings-skill-name">技能名称</label>
                  <input
                    id="settings-skill-name"
                    value={skillName}
                    maxLength={64}
                    placeholder="例如 code-review"
                    autoComplete="off"
                    required
                    onChange={(event) => setSkillName(event.currentTarget.value)}
                  />
                  <p>使用小写字母、数字和连字符。</p>
                </div>
                <div className="settings-skill-field">
                  <label htmlFor="settings-skill-purpose">用途</label>
                  <textarea
                    id="settings-skill-purpose"
                    value={skillPurpose}
                    maxLength={1024}
                    rows={4}
                    placeholder="说明这个技能要完成什么，以及应在什么情况下使用"
                    required
                    onChange={(event) => setSkillPurpose(event.currentTarget.value)}
                  />
                </div>
                <div className="settings-skill-field">
                  <label htmlFor="settings-skill-scope">作用范围</label>
                  <Select
                    id="settings-skill-scope"
                    value={skillScope}
                    groups={[{
                      options: [
                        { value: 'user', label: '所有项目（用户级）' },
                        { value: 'project', label: '仅当前项目' }
                      ]
                    }]}
                    disabled={busy}
                    onValueChange={(value) => {
                      if (value === 'user' || value === 'project') setSkillScope(value)
                    }}
                  />
                </div>
                {skillCreatorError === null ? null : (
                  <p className="settings-skill-error" role="alert">{skillCreatorError}</p>
                )}
                <div className="settings-skill-create-actions">
                  <p>Pi 会先展示拟创建的文件并等待你确认；技能可能包含可执行代码，请在写入前审查。</p>
                  <button type="submit" disabled={busy}>交给 Pi 创建</button>
                </div>
              </form>
            ) : null}

            {skillCommands.length === 0 ? (
              <div
                className="settings-empty-state"
                role="status"
                data-tooltip="技能由 Pi 管理；Workbench 会在 Runtime 提供命令后显示在这里。"
              >
                <h3>尚未发现技能命令</h3>
              </div>
            ) : (
              <RuntimeCommandList
                commands={skillCommands}
                badge="Skill"
                fallbackDescription="该技能未提供说明。"
              />
            )}
          </>
        ) : null}

        {section === 'models' ? (
          <>
            <div className="settings-section-heading">
              <h2>模型</h2>
            </div>

            <section className="settings-group" aria-labelledby="settings-conversation-model">
              <h3 id="settings-conversation-model" className="settings-group-heading">对话模型</h3>
              <div className="settings-group-card">
                <div className="settings-row">
                  <div className="settings-row-copy">
                    <h4>Provider</h4>
                  </div>
                  <div className="settings-row-control">
                    <Select
                      id="conversation-model-provider"
                      value={providerValue}
                      groups={[{
                        options: [
                          ...(!currentProviderAvailable && currentModel !== null
                            ? [{
                                value: currentModel.provider,
                                label: `${currentModel.provider}（当前不可用）`,
                                disabled: true
                              }]
                            : []),
                          ...providers.map((provider) => ({ value: provider, label: provider }))
                        ]
                      }]}
                      disabled={!canSetModel}
                      onValueChange={setSelectedProvider}
                    />
                  </div>
                </div>

                <div className="settings-row">
                  <div className="settings-row-copy">
                    <h4>Model</h4>
                  </div>
                  <div className="settings-row-control">
                    <Select
                      id="conversation-model"
                      value={activeModelValue}
                      groups={[{
                        options: [
                          ...(!selectedCurrentModelAvailable && selectedCurrentModel !== null
                            ? [{
                                value: selectedCurrentModel.id,
                                label: `${
                                  selectedCurrentModel.name === selectedCurrentModel.id
                                    ? selectedCurrentModel.name
                                    : `${selectedCurrentModel.name} · ${selectedCurrentModel.id}`
                                }（当前不可用）`,
                                disabled: true
                              }]
                            : []),
                          ...providerModels.map((model) => ({
                            value: model.id,
                            label: model.name === model.id ? model.name : `${model.name} · ${model.id}`
                          }))
                        ]
                      }]}
                      disabled={!canSetModel || providerModels.length === 0}
                      onValueChange={(modelId) => {
                        void onSetModel(providerValue, modelId).catch(() => undefined)
                      }}
                    />
                  </div>
                </div>
              </div>
            </section>

            <ProviderSettings
              busy={busy}
              onListProviders={onListProviders}
              onSaveProvider={onSaveProvider}
              onRemoveProvider={onRemoveProvider}
              onTestProvider={onTestProvider}
            />
          </>
        ) : null}

        {section === 'preferences' ? (
          <>
            <div className="settings-section-heading">
              <h2>偏好</h2>
            </div>

            <section className="settings-group" aria-labelledby="settings-session-naming">
              <h3 id="settings-session-naming" className="settings-group-heading">对话管理</h3>
              <article className="settings-card settings-card-stacked">
                <label
                  htmlFor="session-naming-mode"
                  data-tooltip="认证由 Pi 管理；自动模式只使用当前已授权 Provider 中的低成本模型。"
                >
                  自动对话命名
                </label>
                <Select
                  id="session-naming-mode"
                  value={namingValue}
                  groups={namingOptionGroups}
                  disabled={busy}
                  onValueChange={(value) => {
                    const settings = resolveSessionNaming(value, state)
                    if (settings !== null) void onSetSessionNaming(settings).catch(() => undefined)
                  }}
                />
              </article>
            </section>
          </>
        ) : null}
      </div>
    </section>
  )
}

function DensityExample({
  density,
  selected,
  title,
  description
}: {
  density: ToolDisplayDensity
  selected: boolean
  title: string
  description: string
}): React.JSX.Element {
  return (
    <div className="settings-density-example" data-selected={selected || undefined}>
      <div className={`settings-density-figure ${density}`} aria-hidden="true">
        {density === 'compact' ? (
          <div className="density-compact-row">
            <span className="density-dot" />
            <span className="density-line wide" />
            <span className="density-line short" />
          </div>
        ) : density === 'standard' ? (
          <>
            <div className="density-standard-row"><span /><i /></div>
            <div className="density-standard-row"><span /><i /></div>
            <div className="density-standard-row"><span /><i /></div>
          </>
        ) : (
          <>
            <div className="density-detail-card">
              <div><b /><span /><i /></div>
              <p><span /><span /></p>
            </div>
            <div className="density-detail-card compact-card">
              <div><b /><span /><i /></div>
            </div>
          </>
        )}
      </div>
      <strong>{title}</strong>
      <span>{description}</span>
    </div>
  )
}

function isAppearanceTheme(value: string): value is AppearanceSettings['theme'] {
  return value === 'system' || value === 'dark' || value === 'light'
}

function isAppearanceTextSize(value: string): value is AppearanceSettings['textSize'] {
  return value === 'small' || value === 'default' || value === 'large'
}

function isAppearanceAccentColor(value: string): value is AppearanceSettings['accentColor'] {
  return value === 'amber' ||
    value === 'blue' ||
    value === 'green' ||
    value === 'purple' ||
    value === 'rose'
}

function isSurfaceTransparency(value: number): value is AppearanceSettings['surfaceTransparency'] {
  return value === 0 || value === 10 || value === 20 || value === 30 || value === 40
}

function appearanceThemeDescription(theme: AppearanceSettings['theme']): string {
  if (theme === 'system') return '根据系统外观自动切换深色或浅色'
  return theme === 'dark' ? '始终使用深色主题' : '始终使用浅色主题'
}

function RuntimeCommandList({
  commands,
  badge,
  fallbackDescription
}: {
  commands: KernelCommandDescriptor[]
  badge: string
  fallbackDescription: string
}): React.JSX.Element {
  return (
    <div className="settings-command-list">
      {commands.map((command) => (
        <article className="settings-card settings-card-stacked" key={command.id}>
          <div className="settings-command-title">
            <h3>/{command.name}</h3>
            <span className="settings-value-chip">{badge}</span>
          </div>
          <p>{command.description || fallbackDescription}</p>
          {command.argumentHint === null ? null : <code>{command.argumentHint}</code>}
        </article>
      ))}
    </div>
  )
}

function resolveSessionNaming(value: string, state: KernelState): SessionNamingSettings | null {
  if (value === 'auto') return { mode: 'auto' }
  if (value === 'off') return { mode: 'off' }
  return state.availableModels
    .filter((model) => sessionNamingModelValue(model.provider, model.id) === value)
    .map((model) => ({
      mode: 'model' as const,
      provider: model.provider,
      modelId: model.id
    }))[0] ?? null
}

function sessionNamingValue(settings: SessionNamingSettings): string {
  return settings.mode === 'model'
    ? sessionNamingModelValue(settings.provider, settings.modelId)
    : settings.mode
}

function sessionNamingModelValue(provider: string, modelId: string): string {
  return `model:${encodeURIComponent(provider)}:${encodeURIComponent(modelId)}`
}

function isValidSkillName(name: string): boolean {
  return name.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)
}

function buildSkillCreationPrompt(name: string, purpose: string, target: string): string {
  return [
    '请创建一个 Pi Agent Skill。',
    '',
    `技能名称：${name}`,
    `用途：${purpose}`,
    `目标文件：${target}`,
    '',
    '请遵循以下约束：',
    '- 按 Pi Agent Skills 格式创建 SKILL.md，frontmatter 必须包含 name 和具体的 description。',
    '- 只创建完成该技能所必需的文件，不增加无关脚本、参考资料或资产。',
    '- 先检查目标路径是否已经存在；若存在，不要覆盖，先说明冲突。',
    '- 写入前先展示拟创建的文件、完整内容和必要理由，并等待我明确确认。',
    '- 在我确认之前不要调用任何写入工具。'
  ].join('\n')
}
