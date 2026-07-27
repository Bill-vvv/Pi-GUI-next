import { useEffect, useMemo, useRef, useState } from 'react'

import {
  ADVISOR_TOOL_NAMES,
  type KernelAdvisorConfiguration,
  type KernelAdvisorDefinition,
  type KernelAdvisorDefinitionInput,
  type KernelAdvisorEditableScope,
  type KernelAdvisorState,
  type KernelAdvisorToolName,
  type KernelState,
  type RuntimeStatus
} from '../../../../shared/kernel-contract'
import { Select } from '../../components/Select'
import {
  isThinkingLevel,
  technicalThinkingLevelLabel,
  THINKING_LEVELS
} from '../../thinking-level'
import { unknownErrorMessage as errorMessage } from '../../unknown-error-message'
import { SettingsField } from './SettingsField'

type AdvisorSettingsProps = {
  advisor: KernelAdvisorState
  runtimeStatus: RuntimeStatus
  activeProjectKey: string | null
  availableModels: KernelState['availableModels']
  busy: boolean
  onSetSystemEnabled: (enabled: boolean) => Promise<void>
  onListDefinitions: () => Promise<KernelAdvisorConfiguration>
  onSaveDefinition: (
    definition: KernelAdvisorDefinitionInput
  ) => Promise<KernelAdvisorConfiguration>
  onRemoveDefinition: (
    slug: string,
    scope: KernelAdvisorEditableScope
  ) => Promise<KernelAdvisorConfiguration>
}

export function AdvisorSettings({
  advisor,
  runtimeStatus,
  activeProjectKey,
  availableModels,
  busy,
  onSetSystemEnabled,
  onListDefinitions,
  onSaveDefinition,
  onRemoveDefinition
}: AdvisorSettingsProps): React.JSX.Element {
  const [configuration, setConfiguration] = useState<KernelAdvisorConfiguration | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null)
  const [draft, setDraft] = useState<KernelAdvisorDefinitionInput | null>(null)
  const [baseline, setBaseline] = useState<KernelAdvisorDefinitionInput | null>(null)
  const [creating, setCreating] = useState(false)
  const [acting, setActing] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const requestRevision = useRef(0)
  const listDefinitionsRef = useRef(onListDefinitions)
  listDefinitionsRef.current = onListDefinitions

  const effectiveDefinitions = useMemo(
    () => effectiveAdvisorDefinitions(configuration?.definitions ?? []),
    [configuration]
  )
  const selectedDefinition = selectedSlug === null
    ? null
    : effectiveDefinitions.find(({ slug }) => slug === selectedSlug) ?? null
  const dirty = draft !== null &&
    baseline !== null &&
    JSON.stringify(draft) !== JSON.stringify(baseline)
  const compatibilityReady = advisor.compatibility === 'ready'
  const canToggleSystem = runtimeStatus === 'ready' &&
    compatibilityReady &&
    advisor.liveToggle &&
    advisor.systemEnabled !== null
  const formDisabled = busy || acting
  const modelOptions = [
    { value: 'primary', label: 'Primary（跟随主模型）' },
    ...availableModels.map((model) => ({
      value: `${model.provider}/${model.id}`,
      label: `${model.provider}/${model.name}`
    }))
  ]
  if (
    draft?.model !== null &&
    draft?.model !== undefined &&
    !modelOptions.some(({ value }) => value === draft.model)
  ) {
    modelOptions.splice(1, 0, {
      value: draft.model,
      label: `${draft.model}（当前不可用）`
    })
  }

  useEffect(() => {
    void loadConfiguration()
    return () => {
      requestRevision.current += 1
    }
  }, [activeProjectKey])

  async function loadConfiguration(): Promise<void> {
    const revision = requestRevision.current + 1
    requestRevision.current = revision
    setLoading(true)
    setLoadError(null)
    setConfiguration(null)
    setSelectedSlug(null)
    setDraft(null)
    setBaseline(null)
    setCreating(false)
    setActionError(null)
    try {
      const nextConfiguration = await listDefinitionsRef.current()
      if (requestRevision.current !== revision) return
      applyConfiguration(nextConfiguration, null)
    } catch (error) {
      if (requestRevision.current !== revision) return
      setConfiguration(null)
      setSelectedSlug(null)
      setDraft(null)
      setBaseline(null)
      setLoadError(`读取 Advisor 配置失败：${errorMessage(error)}`)
    } finally {
      if (requestRevision.current === revision) setLoading(false)
    }
  }

  function applyConfiguration(
    nextConfiguration: KernelAdvisorConfiguration,
    preferredSlug: string | null
  ): void {
    setConfiguration(nextConfiguration)
    const nextEffective = effectiveAdvisorDefinitions(nextConfiguration.definitions)
    const selected = preferredSlug === null
      ? nextEffective[0] ?? null
      : nextEffective.find(({ slug }) => slug === preferredSlug) ?? nextEffective[0] ?? null
    selectImmediately(selected)
  }

  function selectImmediately(definition: KernelAdvisorDefinition | null): void {
    setSelectedSlug(definition?.slug ?? null)
    setCreating(false)
    setActionError(null)
    if (definition === null) {
      setDraft(null)
      setBaseline(null)
      return
    }
    const nextDraft = definitionToInput(definition, activeProjectKey)
    setDraft(nextDraft)
    setBaseline(nextDraft)
  }

  function selectDefinition(definition: KernelAdvisorDefinition): void {
    if (dirty && !window.confirm('放弃尚未保存的 Advisor 修改？')) return
    selectImmediately(definition)
  }

  function startCreate(): void {
    if (dirty && !window.confirm('放弃尚未保存的 Advisor 修改？')) return
    const nextDraft = emptyDefinitionInput(activeProjectKey)
    setSelectedSlug(null)
    setCreating(true)
    setDraft(nextDraft)
    setBaseline(nextDraft)
    setActionError(null)
  }

  function cancelEdit(): void {
    if (creating) {
      selectImmediately(effectiveDefinitions[0] ?? null)
      return
    }
    selectImmediately(selectedDefinition)
  }

  function updateDraft(patch: Partial<KernelAdvisorDefinitionInput>): void {
    setDraft((current) => current === null ? null : { ...current, ...patch })
  }

  async function saveDefinition(): Promise<void> {
    if (draft === null) return
    const name = draft.name.trim()
    if (name.length === 0 || /[\r\n]/u.test(name)) {
      setActionError('名称必须是非空单行文本。')
      return
    }
    if (draft.scope === 'project' && activeProjectKey === null) {
      setActionError('选择 Project 后才能保存项目级 Advisor。')
      return
    }
    setActing(true)
    setActionError(null)
    try {
      const nextConfiguration = await onSaveDefinition({ ...draft, name })
      applyConfiguration(nextConfiguration, slugifyAdvisorName(name))
    } catch (error) {
      setActionError(`保存失败：${errorMessage(error)}`)
    } finally {
      setActing(false)
    }
  }

  async function removeDefinition(): Promise<void> {
    if (
      selectedDefinition === null ||
      !selectedDefinition.editable ||
      (selectedDefinition.scope !== 'user' && selectedDefinition.scope !== 'project')
    ) return
    const restoringDefault = (configuration?.definitions ?? []).some((definition) =>
      definition.slug === selectedDefinition.slug && definition.scope === 'builtin'
    )
    const confirmMessage = restoringDefault
      ? `恢复 Advisor「${selectedDefinition.name}」的默认设置？当前 ${scopeLabel(selectedDefinition.scope)} 修改将被删除。`
      : `删除 Advisor「${selectedDefinition.name}」的${scopeLabel(selectedDefinition.scope)}定义？`
    if (!window.confirm(confirmMessage)) {
      return
    }
    setActing(true)
    setActionError(null)
    try {
      const nextConfiguration = await onRemoveDefinition(
        selectedDefinition.slug,
        selectedDefinition.scope
      )
      applyConfiguration(nextConfiguration, selectedDefinition.slug)
    } catch (error) {
      setActionError(
        `${restoringDefault ? '恢复默认' : '删除'}失败：${errorMessage(error)}`
      )
    } finally {
      setActing(false)
    }
  }

  const directWriteToolsSelected = draft?.tools.some(
    (tool) => tool === 'edit' || tool === 'write'
  ) === true
  const hasBuiltinDefault = selectedDefinition !== null &&
    (configuration?.definitions ?? []).some((definition) =>
      definition.slug === selectedDefinition.slug && definition.scope === 'builtin'
    )

  return (
    <>
      <div className="settings-section-heading">
        <h2>Advisor</h2>
      </div>

      <section
        className="settings-group settings-group-inline"
        aria-labelledby="settings-advisor-status-heading"
      >
        <h3 id="settings-advisor-status-heading" className="settings-group-heading">
          运行状态
        </h3>
        <dl className="settings-advisor-facts">
          <div>
            <dt>协议兼容性</dt>
            <dd data-state={advisor.compatibility}>
              {compatibilityLabel(advisor.compatibility)}
            </dd>
          </div>
          <div>
            <dt>扩展版本</dt>
            <dd>{advisor.extensionVersion ?? '未报告'}</dd>
          </div>
          <div>
            <dt>系统状态</dt>
            <dd>
              {advisor.systemEnabled === null
                ? '不可用'
                : advisor.systemEnabled ? '已开启' : '已关闭'}
            </dd>
          </div>
          <div>
            <dt>多 Advisor 协议</dt>
            <dd>{advisor.multiAdvisor ? '支持' : '不支持'}</dd>
          </div>
          <div>
            <dt>Roster 配置</dt>
            <dd>{advisor.roster ? '支持' : '不支持'}</dd>
          </div>
        </dl>
        {advisor.error === null ? null : (
          <p className="settings-advisor-error" role="alert">{advisor.error}</p>
        )}
      </section>

      <section
        className="settings-group settings-group-inline"
        aria-labelledby="settings-advisor-system-heading"
      >
        <h3 id="settings-advisor-system-heading" className="settings-group-heading">
          实时控制
        </h3>
        <div className="settings-group-card">
          <div className="settings-row">
            <div className="settings-row-copy">
              <h4>
                <label htmlFor="settings-advisor-system-enabled">Advisor 系统</label>
              </h4>
              <p>{systemToggleDescription(advisor, runtimeStatus)}</p>
            </div>
            <div className="settings-row-control settings-theme-control">
              <Select
                id="settings-advisor-system-enabled"
                value={advisor.systemEnabled === null
                  ? 'unavailable'
                  : advisor.systemEnabled ? 'enabled' : 'disabled'}
                groups={[{
                  options: [
                    ...(advisor.systemEnabled === null
                      ? [{ value: 'unavailable', label: '不可用', disabled: true }]
                      : []),
                    { value: 'enabled', label: '开启' },
                    { value: 'disabled', label: '关闭' }
                  ]
                }]}
                disabled={busy || !canToggleSystem}
                onValueChange={(value) => {
                  if (value === 'enabled' || value === 'disabled') {
                    void onSetSystemEnabled(value === 'enabled').catch(() => undefined)
                  }
                }}
              />
            </div>
          </div>
        </div>
      </section>

      <section className="settings-group" aria-labelledby="settings-advisor-roster-heading">
        <div className="settings-group-heading-row">
          <h3 id="settings-advisor-roster-heading" className="settings-group-heading">
            Effective roster
          </h3>
          <button
            type="button"
            className="settings-extension-remove"
            disabled={busy || acting || loading}
            onClick={startCreate}
          >
            新增 Advisor
          </button>
        </div>
        <p className="settings-advisor-notice">
          Roster 配置在新建或显式重载 Session 后生效。
        </p>
        {loading ? (
          <p className="settings-advisor-roster-status" role="status">正在读取 Advisor roster…</p>
        ) : loadError !== null ? (
          <div className="settings-advisor-roster-status">
            <p role="alert">{loadError}</p>
            <button type="button" onClick={() => void loadConfiguration()}>重试</button>
          </div>
        ) : effectiveDefinitions.length === 0 ? (
          <p className="settings-advisor-roster-status">Roster 中没有 Advisor。</p>
        ) : (
          <div className="settings-advisor-roster-list">
            {effectiveDefinitions.map((definition) => (
              <button
                type="button"
                key={definition.slug}
                className="settings-advisor-roster-item"
                aria-pressed={!creating && definition.slug === selectedSlug}
                onClick={() => selectDefinition(definition)}
              >
                <span className="settings-advisor-roster-title">
                  <strong>{definition.name}</strong>
                  <span data-enabled={definition.enabled}>
                    {definition.enabled ? '已启用' : '已停用'}
                  </span>
                </span>
                <span>来源：{definitionSource(definition)}</span>
                <span>模型：{definition.model ?? 'Primary（跟随主模型）'}</span>
                <span>思考：{definition.thinking === null ? '继承' : technicalThinkingLevelLabel(definition.thinking)}</span>
                <span>工具：{definition.tools.length === 0 ? '无' : definition.tools.join(', ')}</span>
                <span>Instructions：{textSummary(definition.instructions)}</span>
              </button>
            ))}
          </div>
        )}

        {draft === null ? null : (
          <form
            className="settings-advisor-editor"
            onSubmit={(event) => {
              event.preventDefault()
              void saveDefinition()
            }}
          >
            <div className="settings-advisor-editor-heading">
              <h4>{creating ? '新增 Advisor' : '编辑 Advisor'}</h4>
              {!creating && selectedDefinition !== null ? (
                <span>{definitionSource(selectedDefinition)}</span>
              ) : null}
            </div>

            <fieldset disabled={formDisabled}>
              <legend>定义</legend>
              <div className="settings-advisor-field-grid">
                <SettingsField label="作用域" htmlFor="settings-advisor-scope">
                  <Select
                    id="settings-advisor-scope"
                    value={draft.scope}
                    disabled={formDisabled}
                    groups={[{
                      options: [
                        { value: 'user', label: '用户级' },
                        {
                          value: 'project',
                          label: '当前 Project',
                          disabled: activeProjectKey === null
                        }
                      ]
                    }]}
                    onValueChange={(value) => {
                      if (value !== 'user' && value !== 'project') return
                      updateDraft({
                        scope: value,
                        originalSlug: selectedDefinition?.editable === true &&
                          selectedDefinition.scope === value
                          ? selectedDefinition.slug
                          : null
                      })
                    }}
                  />
                </SettingsField>
                <SettingsField label="名称" htmlFor="settings-advisor-name">
                  <input
                    id="settings-advisor-name"
                    type="text"
                    value={draft.name}
                    maxLength={128}
                    required
                    onChange={(event) => updateDraft({ name: event.currentTarget.value })}
                  />
                </SettingsField>
                <SettingsField label="模型" htmlFor="settings-advisor-model">
                  <Select
                    id="settings-advisor-model"
                    value={draft.model ?? 'primary'}
                    disabled={formDisabled}
                    groups={[{ options: modelOptions }]}
                    onValueChange={(value) => updateDraft({
                      model: value === 'primary' ? null : value
                    })}
                  />
                </SettingsField>
                <SettingsField label="思考强度" htmlFor="settings-advisor-thinking">
                  <Select
                    id="settings-advisor-thinking"
                    value={draft.thinking ?? 'inherit'}
                    disabled={formDisabled}
                    groups={[{
                      options: [
                        { value: 'inherit', label: '继承' },
                        ...THINKING_LEVELS.map((level) => ({
                          value: level,
                          label: technicalThinkingLevelLabel(level)
                        }))
                      ]
                    }]}
                    onValueChange={(value) => {
                      if (value === 'inherit') updateDraft({ thinking: null })
                      else if (isThinkingLevel(value)) updateDraft({ thinking: value })
                    }}
                  />
                </SettingsField>
              </div>
              <label className="settings-advisor-enabled">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(event) => updateDraft({ enabled: event.currentTarget.checked })}
                />
                <span>启用这个 Advisor</span>
              </label>
            </fieldset>

            <fieldset className="settings-advisor-tools" disabled={formDisabled}>
              <legend>工具</legend>
              <div>
                {ADVISOR_TOOL_NAMES.map((tool) => (
                  <label key={tool}>
                    <input
                      type="checkbox"
                      checked={draft.tools.includes(tool)}
                      onChange={(event) => updateDraft({
                        tools: updateTools(draft.tools, tool, event.currentTarget.checked)
                      })}
                    />
                    <span>{tool}</span>
                  </label>
                ))}
              </div>
              <p className="settings-advisor-notice">仅提供以上六项固定工具；不提供 bash。</p>
            </fieldset>
            {directWriteToolsSelected ? (
              <p className="settings-advisor-tool-warning" role="alert">
                edit / write 由独立 Advisor 直接执行，不经过主 Agent 审批。
              </p>
            ) : null}

            <SettingsField label="Instructions" htmlFor="settings-advisor-instructions">
              <textarea
                id="settings-advisor-instructions"
                rows={7}
                value={draft.instructions}
                disabled={formDisabled}
                onChange={(event) => updateDraft({ instructions: event.currentTarget.value })}
              />
            </SettingsField>

            {actionError === null ? null : (
              <p className="settings-advisor-editor-error" role="alert">{actionError}</p>
            )}
            <div className="settings-advisor-editor-actions">
              <div>
                {!creating && selectedDefinition?.editable === true ? (
                  <button
                    type="button"
                    className="settings-advisor-delete"
                    disabled={formDisabled}
                    onClick={() => void removeDefinition()}
                  >
                    {hasBuiltinDefault ? '恢复默认' : '删除'}
                  </button>
                ) : null}
              </div>
              <div>
                <button type="button" disabled={formDisabled || !dirty} onClick={cancelEdit}>
                  取消
                </button>
                <button type="submit" disabled={formDisabled || (!creating && !dirty)}>
                  {acting ? '保存中…' : '保存'}
                </button>
              </div>
            </div>
          </form>
        )}
      </section>

      <section className="settings-group" aria-labelledby="settings-advisor-sources-heading">
        <h3 id="settings-advisor-sources-heading" className="settings-group-heading">
          Shared instructions 来源
        </h3>
        {configuration === null || configuration.sources.length === 0 ? (
          <p className="settings-advisor-roster-status">没有配置来源。</p>
        ) : (
          <dl className="settings-advisor-sources">
            {[...configuration.sources]
              .sort((left, right) => left.sourceOrder - right.sourceOrder)
              .map((source) => (
                <div key={source.id}>
                  <dt>{scopeLabel(source.scope)} · {source.path ?? '内置'}</dt>
                  <dd>{textSummary(source.instructions)}</dd>
                </div>
              ))}
          </dl>
        )}
      </section>

      {configuration === null || configuration.diagnostics.length === 0 ? null : (
        <section className="settings-group" aria-labelledby="settings-advisor-diagnostics-heading">
          <h3 id="settings-advisor-diagnostics-heading" className="settings-group-heading">
            诊断
          </h3>
          <div className="settings-advisor-diagnostics">
            {configuration.diagnostics.map((diagnostic) => (
              <p key={`${diagnostic.sourcePath}:${diagnostic.message}`} role="alert">
                <code>{diagnostic.sourcePath}</code>
                <span>{diagnostic.message}</span>
              </p>
            ))}
          </div>
        </section>
      )}
    </>
  )
}

function effectiveAdvisorDefinitions(
  definitions: KernelAdvisorDefinition[]
): KernelAdvisorDefinition[] {
  const effective = new Map<string, KernelAdvisorDefinition>()
  for (const definition of definitions) {
    const current = effective.get(definition.slug)
    if (current === undefined || definition.sourceOrder > current.sourceOrder) {
      effective.set(definition.slug, definition)
    }
  }
  return [...effective.values()]
}

function definitionToInput(
  definition: KernelAdvisorDefinition,
  activeProjectKey: string | null
): KernelAdvisorDefinitionInput {
  const scope: KernelAdvisorEditableScope =
    definition.scope === 'user' || definition.scope === 'project'
      ? definition.scope
      : activeProjectKey === null ? 'user' : 'project'
  return {
    originalSlug: definition.editable ? definition.slug : null,
    scope,
    name: definition.name,
    enabled: definition.enabled,
    model: definition.model,
    thinking: definition.thinking,
    tools: [...definition.tools],
    instructions: definition.instructions
  }
}

function emptyDefinitionInput(
  activeProjectKey: string | null
): KernelAdvisorDefinitionInput {
  return {
    originalSlug: null,
    scope: activeProjectKey === null ? 'user' : 'project',
    name: '',
    enabled: true,
    model: null,
    thinking: null,
    tools: ['read', 'grep', 'find', 'ls'],
    instructions: ''
  }
}

function updateTools(
  tools: KernelAdvisorToolName[],
  tool: KernelAdvisorToolName,
  checked: boolean
): KernelAdvisorToolName[] {
  return checked
    ? ADVISOR_TOOL_NAMES.filter((candidate) => candidate === tool || tools.includes(candidate))
    : tools.filter((candidate) => candidate !== tool)
}

function definitionSource(definition: KernelAdvisorDefinition): string {
  const path = definition.sourcePath === null ? '内置' : definition.sourcePath
  return `${scopeLabel(definition.scope)} · ${path}`
}

function scopeLabel(scope: KernelAdvisorDefinition['scope']): string {
  if (scope === 'builtin') return '内置'
  if (scope === 'user') return '用户级'
  if (scope === 'inherited') return '继承'
  return '项目级'
}

function textSummary(value: string): string {
  const normalized = value.trim().replace(/\s+/gu, ' ')
  if (normalized.length === 0) return '无'
  return normalized.length > 160 ? `${normalized.slice(0, 157)}…` : normalized
}

function slugifyAdvisorName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '') || 'advisor'
}

function compatibilityLabel(compatibility: KernelAdvisorState['compatibility']): string {
  if (compatibility === 'ready') return '兼容'
  if (compatibility === 'incompatible') return '不兼容'
  return '不可用'
}

function systemToggleDescription(
  advisor: KernelAdvisorState,
  runtimeStatus: RuntimeStatus
): string {
  if (runtimeStatus !== 'ready') return 'Pi Runtime 就绪后才能实时切换'
  if (advisor.compatibility !== 'ready') return 'Advisor 协议尚未兼容，无法实时切换'
  if (!advisor.liveToggle) return '当前扩展版本不支持实时切换'
  if (advisor.systemEnabled === null) return '扩展未报告可控制的系统状态'
  return '立即控制当前 Session 的 Advisor 审查系统'
}
