import type { IconName } from '../../components/Icon'
import { Icon } from '../../components/Icon'
import { IconButton } from '../../components/IconButton'

export type SettingsSection =
  | 'general'
  | 'appearance'
  | 'shortcuts'
  | 'models'
  | 'packages'
  | 'extensions'
  | 'skills'
  | 'subagent'
  | 'remote'

export const SETTINGS_NAV_ID = 'settings-navigation'

/**
 * Groups and labels follow the Codex desktop settings navigation
 * (个人 / 集成 / 编码). `client` marks pages that stay available in the SSH
 * client, which has no Host-owned settings.
 */
const SETTINGS_NAV_GROUPS: ReadonlyArray<{
  id: string
  label: string
  items: ReadonlyArray<{
    section: SettingsSection
    label: string
    icon: IconName
    client?: true
  }>
}> = [
  {
    id: 'personal',
    label: '个人',
    items: [
      { section: 'general', label: '常规', icon: 'settings', client: true },
      { section: 'appearance', label: '外观', icon: 'appearance', client: true },
      { section: 'shortcuts', label: '键盘快捷键', icon: 'shortcuts', client: true },
      { section: 'models', label: '模型', icon: 'model' }
    ]
  },
  {
    id: 'integrations',
    label: '集成',
    items: [
      { section: 'packages', label: '插件', icon: 'packages' },
      { section: 'extensions', label: '扩展', icon: 'extensions' },
      { section: 'skills', label: '技能', icon: 'skills' },
      { section: 'subagent', label: '子智能体', icon: 'subagents' }
    ]
  },
  {
    id: 'coding',
    label: '编码',
    items: [
      { section: 'remote', label: '连接', icon: 'remote' }
    ]
  }
]

export function SettingsNavigation({
  section,
  clientOnly = false,
  onSectionChange,
  onBack
}: {
  section: SettingsSection
  clientOnly?: boolean
  onSectionChange: (section: SettingsSection) => void
  onBack: () => void
}): React.JSX.Element {
  return (
    <>
      <IconButton
        className="settings-back"
        icon="arrow-left"
        label="返回应用"
        onClick={onBack}
      />
      <nav id={SETTINGS_NAV_ID} className="settings-nav" aria-label="设置分类">
        {SETTINGS_NAV_GROUPS.map((group) => {
          const items = group.items.filter((item) => !clientOnly || item.client === true)
          if (items.length === 0) return null
          const headingId = `settings-nav-${group.id}`
          return (
            <div
              className="settings-nav-group"
              role="group"
              aria-labelledby={headingId}
              key={group.id}
            >
              <div id={headingId} className="settings-nav-group-label">{group.label}</div>
              {items.map((item) => (
                <button
                  type="button"
                  className={section === item.section ? 'selected' : ''}
                  aria-label={item.label}
                  aria-current={section === item.section ? 'page' : undefined}
                  data-tooltip={item.label}
                  onClick={() => onSectionChange(item.section)}
                  key={item.section}
                >
                  <Icon name={item.icon} />
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          )
        })}
      </nav>
    </>
  )
}
