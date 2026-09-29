import type { AppearanceSettings as AppearanceSettingsValue } from '../../../../shared/kernel-contract'
import { FontSelect } from '../../components/FontSelect'
import { Select, type SelectOptionGroup } from '../../components/Select'
import { type ToolDisplayDensity } from '../../tool-display-density'
import { SettingsPageHeading } from './SettingsPageHeading'
import { SettingsSegmented } from './SettingsSegmented'
import { SettingsRowError, useSettingsRowSave } from './useSettingsRowSave'

const TEXT_SIZE_OPTIONS: ReadonlyArray<{ value: AppearanceSettingsValue['textSize']; label: string }> = [
  { value: 'small', label: '小' },
  { value: 'default', label: '默认' },
  { value: 'large', label: '大' }
]
const ACCENT_COLOR_OPTION_GROUPS: SelectOptionGroup[] = [{
  options: [
    { value: 'amber', label: '琥珀色' },
    { value: 'blue', label: '蓝色' },
    { value: 'green', label: '绿色' },
    { value: 'purple', label: '紫色' },
    { value: 'rose', label: '玫红色' }
  ]
}]
const TRANSPARENCY_OPTION_GROUPS: SelectOptionGroup[] = [{
  options: [0, 10, 20, 30, 40].map((value) => ({
    value: String(value),
    label: `${value}%`
  }))
}]
const TOKEN_COUNT_FORMAT_OPTIONS: ReadonlyArray<{
  value: AppearanceSettingsValue['tokenCountFormat']
  label: string
}> = [
  { value: 'full', label: '65,600' },
  { value: 'compact', label: '65.6k' }
]

export function AppearanceSettings({
  appearance,
  busy,
  systemFonts,
  systemFontsError,
  toolDisplayDensity,
  onSetAppearance,
  onSetToolDisplayDensity
}: {
  appearance: AppearanceSettingsValue
  busy: boolean
  systemFonts: string[] | null
  systemFontsError: string | null
  toolDisplayDensity: ToolDisplayDensity
  onSetAppearance: (settings: AppearanceSettingsValue) => Promise<void>
  onSetToolDisplayDensity: (density: ToolDisplayDensity) => void
}): React.JSX.Element {
  const { save, errorFor } = useSettingsRowSave()
  const saveAppearance = (
    rowId: string,
    patch: Partial<AppearanceSettingsValue>
  ): void => {
    save(rowId, () => onSetAppearance({ ...appearance, ...patch }))
  }

  return (
    <>
      <SettingsPageHeading title="外观" />

      <section
        className="settings-group settings-group-inline settings-prefs"
        aria-labelledby="appearance-theme-heading"
      >
        <h3 id="appearance-theme-heading" className="settings-group-heading">主题</h3>
        <div className="settings-group-card">
          <div className="settings-theme-cubes" role="group" aria-label="界面主题">
            {THEME_CUBES.map((cube) => (
              <button
                key={cube.value}
                type="button"
                className="settings-theme-cube"
                aria-pressed={appearance.theme === cube.value}
                disabled={busy}
                onClick={() => saveAppearance('theme', { theme: cube.value })}
              >
                <ThemeCubeIcon theme={cube.value} />
                {cube.label}
              </button>
            ))}
          </div>
          <p className="settings-theme-caption">{appearanceThemeDescription(appearance.theme)}</p>
          <SettingsRowError message={errorFor('theme')} />
        </div>
      </section>

      <section
        className="settings-group settings-group-inline settings-prefs"
        aria-labelledby="appearance-emphasis-heading"
      >
        <h3 id="appearance-emphasis-heading" className="settings-group-heading">界面强调</h3>
        <div className="settings-group-card">
          <div className="settings-row">
            <div className="settings-row-copy">
              <h4>强调色</h4>
              <p>用于链接、选中状态与重点提示</p>
              <SettingsRowError message={errorFor('accent')} />
            </div>
            <div className="settings-row-control settings-theme-control">
              <Select
                id="appearance-accent-color"
                value={appearance.accentColor}
                groups={ACCENT_COLOR_OPTION_GROUPS}
                disabled={busy}
                onValueChange={(value) => {
                  if (!isAppearanceAccentColor(value)) return
                  saveAppearance('accent', { accentColor: value })
                }}
              />
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-copy">
              <h4>面板透明度</h4>
              <p>调整侧栏、复合面板与 Composer 面板的通透程度</p>
              <SettingsRowError message={errorFor('transparency')} />
            </div>
            <div className="settings-row-control settings-theme-control">
              <Select
                id="appearance-surface-transparency"
                value={String(appearance.surfaceTransparency)}
                groups={TRANSPARENCY_OPTION_GROUPS}
                disabled={busy}
                onValueChange={(value) => {
                  const surfaceTransparency = Number(value)
                  if (!isSurfaceTransparency(surfaceTransparency)) return
                  saveAppearance('transparency', { surfaceTransparency })
                }}
              />
            </div>
          </div>
        </div>
      </section>

      <section
        className="settings-group settings-group-inline settings-prefs"
        aria-labelledby="appearance-conversation-heading"
      >
        <h3 id="appearance-conversation-heading" className="settings-group-heading">对话</h3>
        <div className="settings-group-card">
          <div className="settings-row">
            <div className="settings-row-copy">
              <h4 id="appearance-token-count-format-label">Token 数量</h4>
              <p>选择完整数字，或使用 k、m、b 单位缩写</p>
              <SettingsRowError message={errorFor('token-format')} />
            </div>
            <div className="settings-row-control settings-segmented-control">
              <SettingsSegmented
                labelledBy="appearance-token-count-format-label"
                value={appearance.tokenCountFormat}
                options={TOKEN_COUNT_FORMAT_OPTIONS}
                disabled={busy}
                onValueChange={(tokenCountFormat) => saveAppearance('token-format', { tokenCountFormat })}
              />
            </div>
          </div>
          <div className="settings-density-block">
            <div className="settings-row-copy">
              <h4>工作过程密度</h4>
              <p>调整思考与操作在对话中的显示程度</p>
            </div>
            <div className="settings-density-examples" role="group" aria-label="工作过程密度">
              <DensityExample
                density="compact"
                selected={toolDisplayDensity === 'compact'}
                title="紧凑"
                description="只显示一行状态"
                onSelect={onSetToolDisplayDensity}
              />
              <DensityExample
                density="standard"
                selected={toolDisplayDensity === 'standard'}
                title="标准"
                description="过程正文与工具分组"
                onSelect={onSetToolDisplayDensity}
              />
              <DensityExample
                density="detailed"
                selected={toolDisplayDensity === 'detailed'}
                title="详细"
                description="显示完整工作过程"
                onSelect={onSetToolDisplayDensity}
              />
            </div>
          </div>
        </div>
      </section>

      <section
        className="settings-group settings-group-inline settings-prefs"
        aria-labelledby="appearance-typography-heading"
      >
        <h3 id="appearance-typography-heading" className="settings-group-heading">字体</h3>
        <div className="settings-group-card">
          <div className="settings-row">
            <div className="settings-row-copy">
              <h4 id="appearance-text-size-label">界面字号</h4>
              <p>调整界面与对话文字的大小</p>
              <SettingsRowError message={errorFor('text-size')} />
            </div>
            <div className="settings-row-control settings-segmented-control">
              <SettingsSegmented
                labelledBy="appearance-text-size-label"
                value={appearance.textSize}
                options={TEXT_SIZE_OPTIONS}
                disabled={busy}
                onValueChange={(textSize) => saveAppearance('text-size', { textSize })}
              />
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-row-copy">
              <h4>界面字体</h4>
              <p>用于界面与对话文字</p>
              <SettingsRowError message={errorFor('ui-font')} />
            </div>
            <div className="settings-row-control settings-font-control">
              <FontSelect
                id="appearance-ui-font"
                family={appearance.uiFontFamily}
                systemFonts={systemFonts ?? []}
                defaultLabel="系统字体"
                previewKind="ui"
                disabled={busy || systemFonts === null}
                onValueChange={(family) => saveAppearance('ui-font', { uiFontFamily: family })}
              />
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-row-copy">
              <h4>代码字体</h4>
              <p>用于代码、命令与文件路径</p>
              <SettingsRowError message={errorFor('code-font')} />
            </div>
            <div className="settings-row-control settings-font-control">
              <FontSelect
                id="appearance-code-font"
                family={appearance.codeFontFamily}
                systemFonts={systemFonts ?? []}
                defaultLabel="系统等宽字体"
                previewKind="code"
                disabled={busy || systemFonts === null}
                onValueChange={(family) => saveAppearance('code-font', { codeFontFamily: family })}
              />
            </div>
          </div>
        </div>

        {systemFontsError !== null ? (
          <p className="settings-feedback settings-feedback-error" role="alert">
            无法读取系统字体：{systemFontsError}
          </p>
        ) : systemFonts === null ? (
          <p className="settings-feedback" role="status">正在读取系统字体…</p>
        ) : null}
      </section>
    </>
  )
}

const THEME_CUBES: ReadonlyArray<{
  value: AppearanceSettingsValue['theme']
  label: string
}> = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '系统' }
]

function ThemeCubeIcon({ theme }: { theme: AppearanceSettingsValue['theme'] }): React.JSX.Element {
  const common = {
    width: 18,
    height: 18,
    viewBox: '0 0 24 24',
    fill: 'none',
    'aria-hidden': true
  } as const
  if (theme === 'light') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="3.5" stroke="currentColor" strokeWidth="1.8" />
        <path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M18 6l-1.4 1.4M7.4 16.6 6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    )
  }
  if (theme === 'dark') {
    return (
      <svg {...common}>
        <path d="M15.2 4.4A7.8 7.8 0 1 0 19.6 16.2 6.2 6.2 0 0 1 15.2 4.4Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      </svg>
    )
  }
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="8.25" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 3.75v16.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 3.75a8.25 8.25 0 0 0 0 16.5" fill="currentColor" />
    </svg>
  )
}

function DensityExample({
  density,
  selected,
  title,
  description,
  onSelect
}: {
  density: ToolDisplayDensity
  selected: boolean
  title: string
  description: string
  onSelect: (density: ToolDisplayDensity) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="settings-density-example"
      aria-pressed={selected}
      onClick={() => onSelect(density)}
    >
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
    </button>
  )
}

function isAppearanceAccentColor(value: string): value is AppearanceSettingsValue['accentColor'] {
  return value === 'amber' ||
    value === 'blue' ||
    value === 'green' ||
    value === 'purple' ||
    value === 'rose'
}

function isSurfaceTransparency(value: number): value is AppearanceSettingsValue['surfaceTransparency'] {
  return value === 0 || value === 10 || value === 20 || value === 30 || value === 40
}

function appearanceThemeDescription(theme: AppearanceSettingsValue['theme']): string {
  if (theme === 'system') return '根据系统外观自动切换深色或浅色'
  return theme === 'dark' ? '始终使用深色主题' : '始终使用浅色主题'
}
