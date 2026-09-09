import type { IconName } from '../../components/Icon'
import { Icon } from '../../components/Icon'
import { IconButton } from '../../components/IconButton'

export type SettingsSection =
  | 'general'
  | 'models'
  | 'credentials'
  | 'remote'
  | 'shortcuts'
  | 'appearance'
  | 'packages'
  | 'extensions'
  | 'subagent'
  | 'skills'

const SETTINGS_NAV_GROUPS: ReadonlyArray<{
  id: string
  label: string
  items: ReadonlyArray<{
    section: SettingsSection
    label: string
    icon: IconName
  }>
}> = [
  {
    id: 'app',
    label: '应用',
    items: [
      { section: 'general', label: '常规', icon: 'settings' },
      { section: 'appearance', label: '外观', icon: 'appearance' },
      { section: 'shortcuts', label: '快捷键', icon: 'shortcuts' }
    ]
  },
  {
    id: 'models',
    label: '模型',
    items: [
      { section: 'models', label: '模型', icon: 'model' },
      { section: 'credentials', label: '凭证', icon: 'credentials' }
    ]
  },
  {
    id: 'remote',
    label: '远程访问',
    items: [
      { section: 'remote', label: '远程访问', icon: 'remote' }
    ]
  },
  {
    id: 'agent',
    label: 'Agent',
    items: [
      { section: 'subagent', label: 'Subagent', icon: 'subagents' }
    ]
  },
  {
    id: 'ecosystem',
    label: '生态',
    items: [
      { section: 'packages', label: 'Package', icon: 'packages' },
      { section: 'extensions', label: '拓展', icon: 'extensions' },
      { section: 'skills', label: '技能', icon: 'skills' }
    ]
  }
]

export function SettingsNavigation({
  section,
  onSectionChange,
  onBack
}: {
  section: SettingsSection
  onSectionChange: (section: SettingsSection) => void
  onBack: () => void
}): React.JSX.Element {
  return (
    <>
      <IconButton
        className="settings-back"
        icon="arrow-left"
        label="返回对话"
        onClick={onBack}
      />
      <nav className="settings-nav" aria-label="设置分类">
        {SETTINGS_NAV_GROUPS.map((group) => {
          const headingId = `settings-nav-${group.id}`
          return (
            <div
              className="settings-nav-group"
              role="group"
              aria-labelledby={headingId}
              key={group.id}
            >
              <div id={headingId} className="settings-nav-group-label">{group.label}</div>
              {group.items.map((item) => (
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
