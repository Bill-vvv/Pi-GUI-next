import { useMemo, useState } from 'react'

import type { IconName } from '../../components/Icon'
import { Icon } from '../../components/Icon'
import { IconButton } from '../../components/IconButton'
import { searchSettings, type SettingsSearchEntry } from './settings-search'

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
const SEARCH_RESULTS_ID = 'settings-search-results'

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

const SECTION_LABELS = new Map(
  SETTINGS_NAV_GROUPS.flatMap((group) => group.items.map((item) => [item.section, item.label] as const))
)

export function SettingsNavigation({
  section,
  clientOnly = false,
  searchAvailable = true,
  onSectionChange,
  onSearchSelect,
  onBack
}: {
  section: SettingsSection
  clientOnly?: boolean
  /** False while the navigation is an icon rail. */
  searchAvailable?: boolean
  onSectionChange: (section: SettingsSection) => void
  /** Returns false when the jump was refused (for example an unsaved draft was kept). */
  onSearchSelect: (entry: SettingsSearchEntry) => boolean
  onBack: () => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const searching = searchAvailable && query.trim() !== ''
  const results = useMemo(
    () => searching ? searchSettings(query, { clientOnly }) : [],
    [clientOnly, query, searching]
  )
  const activeResult = results.length === 0 ? -1 : Math.min(activeIndex, results.length - 1)
  const select = (entry: SettingsSearchEntry): void => {
    if (onSearchSelect(entry)) setQuery('')
  }

  return (
    <>
      <IconButton
        className="settings-back"
        icon="arrow-left"
        label="返回应用"
        onClick={onBack}
      />
      {searchAvailable ? (
        <div className="settings-search">
          <Icon name="search" size="sm" />
          <input
            type="search"
            role="combobox"
            aria-label="搜索设置"
            aria-autocomplete="list"
            aria-expanded={searching}
            aria-controls={SEARCH_RESULTS_ID}
            aria-activedescendant={activeResult < 0 ? undefined : `${SEARCH_RESULTS_ID}-${activeResult}`}
            placeholder="搜索设置"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setActiveIndex(0)
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              if (event.key === 'Escape' && query !== '') {
                event.preventDefault()
                event.stopPropagation()
                setQuery('')
                return
              }
              if (results.length === 0) return
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                const step = event.key === 'ArrowDown' ? 1 : -1
                setActiveIndex((activeResult + step + results.length) % results.length)
              } else if (event.key === 'Enter') {
                event.preventDefault()
                select(results[activeResult])
              }
            }}
          />
        </div>
      ) : null}
      {searching ? (
        <div className="settings-search-results">
          <div id={SEARCH_RESULTS_ID} role="listbox" aria-label="设置搜索结果" data-inline-listbox="">
            {results.map((entry, index) => {
              const page = SECTION_LABELS.get(entry.section) ?? ''
              return (
                <div
                  id={`${SEARCH_RESULTS_ID}-${index}`}
                  role="option"
                  aria-selected={index === activeResult}
                  className={index === activeResult ? 'active' : undefined}
                  key={entry.target}
                  // Keep focus in the search field; the click selects.
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseMove={() => setActiveIndex(index)}
                  onClick={() => select(entry)}
                >
                  <span>{entry.label}</span>
                  <small>{entry.group === entry.label ? page : `${page} · ${entry.group}`}</small>
                </div>
              )
            })}
          </div>
          {results.length === 0 ? (
            <p className="settings-feedback" role="status">没有匹配的设置</p>
          ) : null}
        </div>
      ) : null}
      <nav id={SETTINGS_NAV_ID} className="settings-nav" aria-label="设置分类" hidden={searching}>
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
