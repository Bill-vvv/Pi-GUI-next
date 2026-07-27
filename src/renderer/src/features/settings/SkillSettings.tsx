import { useMemo, useState } from 'react'

import type { KernelCommandDescriptor, KernelState } from '../../../../shared/kernel-contract'
import { Select } from '../../components/Select'

type SkillScopeFilter = 'all' | 'user' | 'project' | 'temporary'
type SkillOriginFilter = 'all' | 'package' | 'top-level'

type SkillSettingsProps = {
  active: boolean
  commands: KernelCommandDescriptor[]
  activeProjectKey: string | null
  runtimeStatus: KernelState['runtime']['status']
  busy: boolean
  onCreateSkill: (prompt: string) => Promise<void>
}

export function SkillSettings({
  active,
  commands,
  activeProjectKey,
  runtimeStatus,
  busy,
  onCreateSkill
}: SkillSettingsProps): React.JSX.Element | null {
  const [skillCreatorOpen, setSkillCreatorOpen] = useState(false)
  const [skillName, setSkillName] = useState('')
  const [skillPurpose, setSkillPurpose] = useState('')
  const [skillScope, setSkillScope] = useState<'user' | 'project'>('user')
  const [skillCreatorError, setSkillCreatorError] = useState<string | null>(null)
  const [skillQuery, setSkillQuery] = useState('')
  const [skillScopeFilter, setSkillScopeFilter] = useState<SkillScopeFilter>('all')
  const [skillOriginFilter, setSkillOriginFilter] = useState<SkillOriginFilter>('all')
  const skillCommands = useMemo(
    () => commands
      .filter((command) => command.source === 'skill')
      .sort((left, right) => left.name.localeCompare(right.name, 'en', { sensitivity: 'base' })),
    [commands]
  )

  if (!active) return null

  return (
    <>
      <div className="settings-section-heading settings-section-heading-with-action">
        <h2>技能</h2>
        <button
          className="settings-skill-create-toggle"
          type="button"
          disabled={busy || activeProjectKey === null || runtimeStatus !== 'ready'}
          data-tooltip={
            activeProjectKey === null
              ? '请先添加并选择一个项目。'
              : runtimeStatus !== 'ready' ? '请等待 Pi Runtime 就绪。' : undefined
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
            if (skillScope === 'project' && activeProjectKey === null) {
              setSkillCreatorError('当前项目已不可用，请重新选择项目。')
              return
            }
            const target = skillScope === 'project'
              ? `${activeProjectKey}/.pi/skills/${name}/SKILL.md`
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
        <SkillCommandCatalog
          commands={skillCommands}
          query={skillQuery}
          scopeFilter={skillScopeFilter}
          originFilter={skillOriginFilter}
          onQueryChange={setSkillQuery}
          onScopeFilterChange={setSkillScopeFilter}
          onOriginFilterChange={setSkillOriginFilter}
        />
      )}
    </>
  )
}

function SkillCommandCatalog({
  commands,
  query,
  scopeFilter,
  originFilter,
  onQueryChange,
  onScopeFilterChange,
  onOriginFilterChange
}: {
  commands: KernelCommandDescriptor[]
  query: string
  scopeFilter: SkillScopeFilter
  originFilter: SkillOriginFilter
  onQueryChange: (query: string) => void
  onScopeFilterChange: (filter: SkillScopeFilter) => void
  onOriginFilterChange: (filter: SkillOriginFilter) => void
}): React.JSX.Element {
  const normalizedTerms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean)
  const filteredCommands = commands.filter((command) => {
    if (scopeFilter !== 'all' && command.sourceInfo?.scope !== scopeFilter) return false
    if (originFilter !== 'all' && command.sourceInfo?.origin !== originFilter) return false
    if (normalizedTerms.length === 0) return true

    const searchableText = [
      command.name,
      command.description
    ].join(' ').toLocaleLowerCase()
    return normalizedTerms.every((term) => searchableText.includes(term))
  })
  const hasActiveFilters = scopeFilter !== 'all' || originFilter !== 'all'
  const hasActiveCriteria = normalizedTerms.length > 0 || hasActiveFilters

  return (
    <section className="settings-skill-catalog" aria-label="已发现的技能">
      <div className="settings-skill-catalog-toolbar">
        <input
          type="search"
          value={query}
          aria-label="搜索技能"
          placeholder="按名称或用途搜索"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onQueryChange(event.currentTarget.value)}
        />
        <span aria-live="polite">
          {hasActiveCriteria
            ? `${filteredCommands.length} / ${commands.length}`
            : `${commands.length} 个技能`}
        </span>
      </div>

      <div className="settings-skill-filter-row" role="group" aria-label="筛选技能">
        <div className="settings-skill-filter-control">
          <label htmlFor="settings-skill-scope-filter">作用域</label>
          <Select
            id="settings-skill-scope-filter"
            value={scopeFilter}
            groups={[{
              options: [
                { value: 'all', label: '全部作用域' },
                { value: 'project', label: '当前项目' },
                { value: 'user', label: '用户级' },
                { value: 'temporary', label: '临时' }
              ]
            }]}
            onValueChange={(value) => {
              if (
                value === 'all' ||
                value === 'user' ||
                value === 'project' ||
                value === 'temporary'
              ) {
                onScopeFilterChange(value)
              }
            }}
          />
        </div>
        <div className="settings-skill-filter-control">
          <label htmlFor="settings-skill-origin-filter">来源</label>
          <Select
            id="settings-skill-origin-filter"
            value={originFilter}
            groups={[{
              options: [
                { value: 'all', label: '全部来源' },
                { value: 'top-level', label: '独立 Skill' },
                { value: 'package', label: 'Package' }
              ]
            }]}
            onValueChange={(value) => {
              if (value === 'all' || value === 'package' || value === 'top-level') {
                onOriginFilterChange(value)
              }
            }}
          />
        </div>
        {hasActiveFilters ? (
          <button
            className="settings-link-button"
            type="button"
            onClick={() => {
              onScopeFilterChange('all')
              onOriginFilterChange('all')
            }}
          >
            重置筛选
          </button>
        ) : null}
      </div>

      {filteredCommands.length === 0 ? (
        <div className="settings-skill-no-results" role="status">
          <h3>没有匹配的技能</h3>
          <p>调整关键词或筛选条件后再试。</p>
        </div>
      ) : (
        <div className="settings-skill-list">
          {filteredCommands.map((command) => (
            <article className="settings-skill-item" key={command.id}>
              <div className="settings-skill-item-copy">
                <h3>/{command.name}</h3>
                <p>{command.description || '该技能未提供说明。'}</p>
              </div>
              {command.sourceInfo === null ? null : (
                <div className="settings-skill-item-meta">
                  <span>{skillScopeLabel(command.sourceInfo.scope)}</span>
                  <span>{command.sourceInfo.origin === 'package' ? 'Package' : '独立'}</span>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  )
}

function skillScopeLabel(
  scope: NonNullable<KernelCommandDescriptor['sourceInfo']>['scope']
): string {
  if (scope === 'project') return '当前项目'
  if (scope === 'user') return '用户级'
  return '临时'
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
