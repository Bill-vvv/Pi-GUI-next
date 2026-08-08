import { useEffect, useRef, useState } from 'react'

import {
  MAGIC_CONTEXT_PACKAGE_NAME,
  SUBAGENT_PACKAGE_NAME
} from '../../../../shared/kernel-contract'
import type {
  AppearanceSettings,
  GeneralSettings,
  KernelExtensionSelectionKind,
  KernelInstalledPackage,
  KernelModelPricingFetchResult,
  KernelPiPackageInstallJob,
  KernelPiDevCatalog,
  KernelProviderAuthEvent,
  KernelProviderAuthType,
  KernelProviderConfig,
  KernelProviderCredential,
  KernelProviderInput,
  KernelProviderTestResult,
  KernelState,
  KernelSubagentDefinition,
  KernelSubagentEditableScope,
  KernelSubagentDefinitionInput,
  SessionNamingSettings,
  SubagentSettings as SubagentSettingsValue,
  ShortcutSettings
} from '../../../../shared/kernel-contract'
import type {
  RemoteAccessStatus,
  RemotePairingCode
} from '../../../../shared/remote-admin-contract'
import { FontSelect } from '../../components/FontSelect'
import { Select, type SelectOptionGroup } from '../../components/Select'
import { InstalledPackages } from './InstalledPackages'
import { PiDevCatalog } from './PiDevCatalog'
import { CredentialsPanel } from './CredentialsPanel'
import { ModelSettings } from './ModelSettings'
import { RemoteAccessPanel } from './RemoteAccessPanel'
import { ShortcutSettingsPanel } from './ShortcutSettingsPanel'
import { AdaptedExtensionPackageControl } from './AdaptedExtensionPackageControl'
import { SubagentSettings } from './SubagentSettings'
import { SkillSettings } from './SkillSettings'
import type { SettingsSection } from './SettingsNavigation'
import {
  TOOL_DISPLAY_DENSITIES,
  type ToolDisplayDensity
} from '../../tool-display-density'
import {
  isWorkbenchAction,
  type WorkbenchOperation
} from '../../workbench-actions'

type SettingsPanelProps = {
  state: KernelState
  busy: boolean
  section: SettingsSection
  pendingAction: WorkbenchOperation | null
  extensionActionError: string | null
  actionError: string | null
  systemFonts: string[] | null
  systemFontsError: string | null
  onInstallExtension: (kind: KernelExtensionSelectionKind) => Promise<void>
  onRemoveExtension: (path: string) => Promise<void>
  onSearchPiDevExtensions: (query: string) => Promise<KernelPiDevCatalog>
  onSearchPiDevPackages: (query: string) => Promise<KernelPiDevCatalog>
  onListPiPackages: () => Promise<KernelInstalledPackage[]>
  packageInstallJobs: KernelPiPackageInstallJob[]
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
  onFetchModelPricing: (
    providerId: string,
    modelIds: string[]
  ) => Promise<KernelModelPricingFetchResult>
  onListProviderCredentials: () => Promise<KernelProviderCredential[]>
  onLoginProvider: (
    providerId: string,
    authType: KernelProviderAuthType
  ) => Promise<KernelProviderCredential[]>
  onSubmitProviderAuthPrompt: (
    operationId: string,
    promptId: string,
    value: string
  ) => Promise<void>
  onCancelProviderLogin: (operationId: string) => Promise<void>
  onLogoutProvider: (providerId: string) => Promise<KernelProviderCredential[]>
  onSubscribeProviderAuth: (
    listener: (event: KernelProviderAuthEvent) => void
  ) => () => void
  onGetRemoteAccessStatus: () => Promise<RemoteAccessStatus>
  onCreateRemotePairingCode: () => Promise<RemotePairingCode>
  onRevokeRemoteDevice: () => Promise<RemoteAccessStatus>
  onSetModel: (provider: string, modelId: string) => Promise<void>
  onSetSessionNaming: (settings: SessionNamingSettings) => Promise<void>
  onSetGeneral: (settings: GeneralSettings) => Promise<void>
  onSetSubagentEnabled: (enabled: boolean) => Promise<void>
  onSetMagicContextEnabled: (enabled: boolean) => Promise<void>
  onListSubagentDefinitions: () => Promise<KernelSubagentDefinition[]>
  onSaveSubagentDefinition: (
    definition: KernelSubagentDefinitionInput
  ) => Promise<KernelSubagentDefinition[]>
  onSetSubagentDefinitionEnabled: (
    id: string,
    scope: KernelSubagentEditableScope,
    enabled: boolean
  ) => Promise<KernelSubagentDefinition[]>
  onRemoveSubagentDefinition: (id: string) => Promise<KernelSubagentDefinition[]>
  onSetSubagent: (settings: SubagentSettingsValue) => Promise<void>
  onSetAppearance: (settings: AppearanceSettings) => Promise<void>
  onSetShortcuts: (settings: ShortcutSettings) => Promise<void>
  onShortcutRecordingChange: (recording: boolean) => void
  toolDisplayDensity: ToolDisplayDensity
  onSetToolDisplayDensity: (density: ToolDisplayDensity) => void
  onDirtyChange: (dirty: boolean) => void
  onActiveOperationChange: (active: boolean) => void
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
  packageInstallJobs,
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
  onFetchModelPricing,
  onListProviderCredentials,
  onLoginProvider,
  onSubmitProviderAuthPrompt,
  onCancelProviderLogin,
  onLogoutProvider,
  onSubscribeProviderAuth,
  onGetRemoteAccessStatus,
  onCreateRemotePairingCode,
  onRevokeRemoteDevice,
  onSetModel,
  onSetSessionNaming,
  onSetGeneral,
  onSetSubagentEnabled,
  onSetMagicContextEnabled,
  onListSubagentDefinitions,
  onSaveSubagentDefinition,
  onSetSubagentDefinitionEnabled,
  onRemoveSubagentDefinition,
  onSetSubagent,
  onSetAppearance,
  onSetShortcuts,
  onShortcutRecordingChange,
  toolDisplayDensity,
  onSetToolDisplayDensity,
  onDirtyChange,
  onActiveOperationChange
}: SettingsPanelProps): React.JSX.Element {
  const [removingExtensionPath, setRemovingExtensionPath] = useState<string | null>(null)
  const [packageRevision, setPackageRevision] = useState(0)
  const handledPackageInstallJobs = useRef(new Set<string>())
  const namingValue = sessionNamingValue(state.sessionNaming)
  const selectedNamingModel = state.sessionNaming.mode === 'model' ? state.sessionNaming : null
  const selectedNamingModelAvailable = selectedNamingModel === null || state.availableModels.some(
    (model) => model.provider === selectedNamingModel.provider && model.id === selectedNamingModel.modelId
  )
  const packageInstallActive = packageInstallJobs.some((job) =>
    job.status === 'queued' || job.status === 'running'
  )

  useEffect(() => {
    for (const job of packageInstallJobs) {
      if (job.status !== 'succeeded' && job.status !== 'failed') continue
      if (handledPackageInstallJobs.current.has(job.id)) continue
      handledPackageInstallJobs.current.add(job.id)
      setPackageRevision((revision) => revision + 1)
    }
  }, [packageInstallJobs])
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
  const tokenCountFormatOptionGroups: SelectOptionGroup[] = [{
    options: [
      { value: 'full', label: '完整数字（65,600）' },
      { value: 'compact', label: 'k / m / b 缩写（65.6k）' }
    ]
  }]
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

            <section
              className="settings-group settings-group-inline"
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
                      checked={state.general.autoContinueInterruptedTasks}
                      disabled={busy}
                      onChange={(event) => {
                        void onSetGeneral({
                          ...state.general,
                          autoContinueInterruptedTasks: event.currentTarget.checked
                        }).catch(() => undefined)
                      }}
                    />
                  </div>
                </div>
              </div>
            </section>

            <section
              className="settings-group settings-group-inline"
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

            <section
              className="settings-group settings-group-inline"
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
                      checked={state.general.fastExtensionLoading}
                      disabled={busy}
                      onChange={(event) => {
                        void onSetGeneral({
                          ...state.general,
                          fastExtensionLoading: event.currentTarget.checked
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

            <section
              className="settings-group settings-group-inline"
              aria-labelledby="appearance-theme-heading"
            >
              <h3 id="appearance-theme-heading" className="settings-group-heading">主题</h3>
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

            <section
              className="settings-group settings-group-inline"
              aria-labelledby="appearance-emphasis-heading"
            >
              <h3 id="appearance-emphasis-heading" className="settings-group-heading">界面强调</h3>
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
                    <p>调整侧栏、复合面板与 Composer 面板的通透程度</p>
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

            <section
              className="settings-group settings-group-inline"
              aria-labelledby="appearance-conversation-heading"
            >
              <h3 id="appearance-conversation-heading" className="settings-group-heading">Agent 对话</h3>
              <div className="settings-group-card">
                <div className="settings-row">
                  <div className="settings-row-copy">
                    <h4>Token 数量</h4>
                    <p>选择完整数字，或使用 k、m、b 单位缩写</p>
                  </div>
                  <div className="settings-row-control settings-theme-control">
                    <Select
                      id="appearance-token-count-format"
                      value={state.appearance.tokenCountFormat}
                      groups={tokenCountFormatOptionGroups}
                      disabled={busy}
                      onValueChange={(value) => {
                        if (!isTokenCountFormat(value)) return
                        void onSetAppearance({
                          ...state.appearance,
                          tokenCountFormat: value
                        }).catch(() => undefined)
                      }}
                    />
                  </div>
                </div>
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
                    description="过程正文与工具分组"
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

            <section
              className="settings-group settings-group-inline"
              aria-labelledby="appearance-typography-heading"
            >
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
              busy={busy || packageInstallActive}
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
              busy={busy || packageInstallActive}
              pendingAction={pendingAction}
              packageInstallJobs={packageInstallJobs}
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
            <AdaptedExtensionPackageControl
              heading="已适配拓展"
              idPrefix="settings-extensions-subagent"
              packageName={SUBAGENT_PACKAGE_NAME}
              detailUrl="https://pi.dev/packages/pi-subagents"
              description="为 Pi 提供可委派的 Subagent Extension"
              notice="安装与启停会在新建或显式重载 Session 后生效。"
              busy={busy || packageInstallActive}
              packageInstallJobs={packageInstallJobs}
              onListPiPackages={onListPiPackages}
              onInstallPiDevPackage={async (name) => {
                await onInstallPiDevPackage(name)
                setPackageRevision((revision) => revision + 1)
              }}
              onSetEnabled={onSetSubagentEnabled}
              onOpenExternal={onOpenExternal}
            />
            <AdaptedExtensionPackageControl
              heading="Magic Context"
              idPrefix="settings-extensions-magic-context"
              packageName={MAGIC_CONTEXT_PACKAGE_NAME}
              detailUrl="https://github.com/cortexkit/magic-context"
              description="提供后台上下文压缩与跨会话记忆"
              notice={(
                <>
                  拓展显示“已开启”只表示拓展已启用，不代表配置或健康状态已验证。
                  安装后仍需手动运行 <code>npx @cortexkit/magic-context@latest setup --harness pi</code>；
                  新建或显式重载 Session 后生效。运行态可用 <code>/ctx-status</code>，
                  健康检查请运行 <code>npx @cortexkit/magic-context@latest doctor --harness pi</code>。
                </>
              )}
              busy={busy || packageInstallActive}
              packageInstallJobs={packageInstallJobs}
              onListPiPackages={onListPiPackages}
              onInstallPiDevPackage={async (name) => {
                await onInstallPiDevPackage(name)
                setPackageRevision((revision) => revision + 1)
              }}
              onSetEnabled={onSetMagicContextEnabled}
              onOpenExternal={onOpenExternal}
            />
            <PiDevCatalog
              kind="extension"
              busy={busy || packageInstallActive}
              pendingAction={pendingAction}
              packageInstallJobs={packageInstallJobs}
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
              {isWorkbenchAction(pendingAction, 'install-extension') ||
              isWorkbenchAction(pendingAction, 'remove-extension') ? (
                <p className="settings-extension-status" role="status" aria-live="polite">
                  {isWorkbenchAction(pendingAction, 'install-extension') ? '正在安装…' : '正在卸载…'}
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

        {section === 'subagent' ? (
          <SubagentSettings
            settings={state.subagent}
            activeProjectKey={state.activeProjectKey}
            availableModels={state.availableModels}
            busy={busy}
            onListPiPackages={onListPiPackages}
            onListSubagentDefinitions={onListSubagentDefinitions}
            onSaveSubagentDefinition={onSaveSubagentDefinition}
            onSetSubagentDefinitionEnabled={onSetSubagentDefinitionEnabled}
            onRemoveSubagentDefinition={onRemoveSubagentDefinition}
            onSetSubagent={onSetSubagent}
            onDirtyChange={onDirtyChange}
          />
        ) : null}

        <SkillSettings
          active={section === 'skills'}
          commands={state.commands}
          activeProjectKey={state.activeProjectKey}
          runtimeStatus={state.runtime.status}
          busy={busy}
          onCreateSkill={onCreateSkill}
        />

        <ModelSettings
          active={section === 'models'}
          availableModels={state.availableModels}
          currentModel={state.session.model}
          runtimeStatus={state.runtime.status}
          busy={busy}
          onSetModel={onSetModel}
        />

        {section === 'credentials' ? (
          <>
            <div className="settings-section-heading">
              <h2>凭证</h2>
            </div>
            <CredentialsPanel
              busy={busy}
              tokenCountFormat={state.appearance.tokenCountFormat}
              onListProviderCredentials={onListProviderCredentials}
              onLoginProvider={onLoginProvider}
              onSubmitProviderAuthPrompt={onSubmitProviderAuthPrompt}
              onCancelProviderLogin={onCancelProviderLogin}
              onLogoutProvider={onLogoutProvider}
              onSubscribeProviderAuth={onSubscribeProviderAuth}
              onOpenExternal={onOpenExternal}
              onListProviders={onListProviders}
              onSaveProvider={onSaveProvider}
              onRemoveProvider={onRemoveProvider}
              onTestProvider={onTestProvider}
              onFetchModelPricing={onFetchModelPricing}
              onDirtyChange={onDirtyChange}
              onActiveOperationChange={onActiveOperationChange}
            />
          </>
        ) : null}

        {section === 'remote' ? (
          <>
            <div className="settings-section-heading">
              <h2>远程访问</h2>
            </div>
            <RemoteAccessPanel
              busy={busy}
              onGetStatus={onGetRemoteAccessStatus}
              onCreatePairingCode={onCreateRemotePairingCode}
              onRevokeDevice={onRevokeRemoteDevice}
            />
          </>
        ) : null}

        {section === 'shortcuts' ? (
          <ShortcutSettingsPanel
            settings={state.shortcuts}
            onSave={onSetShortcuts}
            onRecordingChange={onShortcutRecordingChange}
          />
        ) : null}

        {section === 'preferences' ? (
          <>
            <div className="settings-section-heading">
              <h2>偏好</h2>
            </div>

            <section
              className="settings-group settings-group-inline"
              aria-labelledby="settings-session-naming"
            >
              <h3 id="settings-session-naming" className="settings-group-heading">对话管理</h3>
              <div className="settings-group-card">
                <div className="settings-row">
                  <div className="settings-row-copy">
                    <label
                      htmlFor="session-naming-mode"
                      data-tooltip="认证由 Pi 管理；自动模式只使用当前已授权 Provider 中的低成本模型。"
                    >
                      自动对话命名
                    </label>
                  </div>
                  <div className="settings-row-control">
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
                  </div>
                </div>
              </div>
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

function isTokenCountFormat(value: string): value is AppearanceSettings['tokenCountFormat'] {
  return value === 'full' || value === 'compact'
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
