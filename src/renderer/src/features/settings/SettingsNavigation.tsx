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
  | 'preferences'

const SETTINGS_SECTIONS: ReadonlyArray<{
  section: SettingsSection
  label: string
  icon: IconName
}> = [
  { section: 'general', label: '常规', icon: 'settings' },
  { section: 'models', label: '模型', icon: 'model' },
  { section: 'credentials', label: '凭证', icon: 'preferences' },
  { section: 'remote', label: '远程访问', icon: 'remote' },
  { section: 'shortcuts', label: '快捷键', icon: 'preferences' },
  { section: 'appearance', label: '外观', icon: 'appearance' },
  { section: 'packages', label: 'Package', icon: 'packages' },
  { section: 'extensions', label: '拓展', icon: 'extensions' },
  { section: 'subagent', label: 'Subagent', icon: 'subagents' },
  { section: 'skills', label: '技能', icon: 'skills' },
  { section: 'preferences', label: '偏好', icon: 'preferences' }
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
        {SETTINGS_SECTIONS.map((item) => (
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
      </nav>
    </>
  )
}
