import { useEffect, useMemo, useRef, useState } from 'react'

import {
  SUBAGENT_PACKAGE_NAME,
  type KernelInstalledPackage,
  type KernelState,
  type KernelSubagentDefinition,
  type KernelSubagentEditableScope,
  type KernelSubagentDefinitionInput,
  type SubagentSettings as SubagentSettingsValue
} from '../../../../shared/kernel-contract'
import { IconButton } from '../../components/IconButton'
import { Select } from '../../components/Select'
import { hasUnsavedSettingsDraft } from './settings-workspace'
import {
  isThinkingLevel,
  localizedThinkingLevelLabel,
  THINKING_LEVELS
} from '../../thinking-level'
import { unknownErrorMessage as errorMessage } from '../../unknown-error-message'
import { SettingsField } from './SettingsField'

const SUBAGENT_PACKAGE_SOURCE = `npm:${SUBAGENT_PACKAGE_NAME}`
const SUBAGENT_PAGE_SIZE = 6

type SubagentPackageState = 'loading' | 'not-installed' | 'enabled' | 'disabled' | 'error'
type SubagentScopeFilter = 'all' | KernelSubagentDefinition['scope']
type SubagentEnabledFilter = 'all' | 'enabled' | 'disabled'
type SubagentBatchField =
  | 'scope'
  | 'enabled'
  | 'model'
  | 'thinking'
  | 'inheritProjectContext'
  | 'inheritSkills'
  | 'defaultAsync'
  | 'maxSubagentDepth'

type SubagentSettingsProps = {
  settings: SubagentSettingsValue
  activeProjectKey: string | null
  availableModels: KernelState['availableModels']
  busy: boolean
  onListPiPackages: () => Promise<KernelInstalledPackage[]>
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
  onDirtyChange: (dirty: boolean) => void
}

export function SubagentSettings({
  settings,
  activeProjectKey,
  availableModels,
  busy,
  onListPiPackages,
  onListSubagentDefinitions,
  onSaveSubagentDefinition,
  onSetSubagentDefinitionEnabled,
  onRemoveSubagentDefinition,
  onSetSubagent,
  onDirtyChange
}: SubagentSettingsProps): React.JSX.Element {
  const [packageState, setPackageState] = useState<SubagentPackageState>('loading')
  const [definitions, setDefinitions] = useState<KernelSubagentDefinition[]>([])
  const [definitionsLoading, setDefinitionsLoading] = useState(true)
  const [definitionsError, setDefinitionsError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<KernelSubagentDefinitionInput | null>(null)
  const [baseline, setBaseline] = useState<KernelSubagentDefinitionInput | null>(null)
  const [editorState, setEditorState] = useState<'edit' | 'create' | 'override'>('edit')
  const [editorMode, setEditorMode] = useState<'basic' | 'advanced'>('basic')
  const [editorRevealed, setEditorRevealed] = useState(false)
  const [query, setQuery] = useState('')
  const [scopeFilter, setScopeFilter] = useState<SubagentScopeFilter>('all')
  const [enabledFilter, setEnabledFilter] = useState<SubagentEnabledFilter>('all')
  const [page, setPage] = useState(0)
  const [multiSelect, setMultiSelect] = useState(false)
  const [batchSelectedIds, setBatchSelectedIds] = useState<Set<string>>(() => new Set())
  const [batchField, setBatchField] = useState<SubagentBatchField>('model')
  const [batchValue, setBatchValue] = useState('inherit')
  const [batchStatus, setBatchStatus] = useState<string | null>(null)
  const [acting, setActing] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const packageRequestRevision = useRef(0)
  const definitionRequestRevision = useRef(0)
  const editorBackRef = useRef<HTMLButtonElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const listPiPackagesRef = useRef(onListPiPackages)
  const listSubagentDefinitionsRef = useRef(onListSubagentDefinitions)
  const settingsDisabled = busy || packageState !== 'enabled'
  const managerDisabled = packageState === 'loading' ||
    packageState === 'not-installed' ||
    packageState === 'error'
  const effectiveDefinitions = useMemo(
    () => effectiveSubagentDefinitions(definitions),
    [definitions]
  )
  const selectedDefinition = selectedId === null
    ? null
    : definitions.find(({ id }) => id === selectedId) ?? null
  const hasBuiltinDefault = selectedDefinition !== null &&
    selectedDefinition.editable &&
    definitions.some((definition) =>
      definition.scope === 'builtin' && definition.name === selectedDefinition.name
    )
  const dirty = hasUnsavedSettingsDraft(draft, baseline)
  const filteredDefinitions = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    return effectiveDefinitions.filter((definition) =>
      (scopeFilter === 'all' || definition.scope === scopeFilter) &&
      (enabledFilter === 'all' || definition.enabled === (enabledFilter === 'enabled')) &&
      (
        normalizedQuery.length === 0 ||
        definition.name.toLocaleLowerCase().includes(normalizedQuery)
      )
    )
  }, [effectiveDefinitions, enabledFilter, query, scopeFilter])
  const batchSelectedDefinitions = effectiveDefinitions.filter(
    ({ id }) => batchSelectedIds.has(id)
  )
  const allFilteredSelected = filteredDefinitions.length > 0 &&
    filteredDefinitions.every(({ id }) => batchSelectedIds.has(id))
  const pageCount = Math.max(1, Math.ceil(filteredDefinitions.length / SUBAGENT_PAGE_SIZE))
  const visibleDefinitions = filteredDefinitions.slice(
    page * SUBAGENT_PAGE_SIZE,
    (page + 1) * SUBAGENT_PAGE_SIZE
  )
  useEffect(() => {
    const revision = packageRequestRevision.current + 1
    packageRequestRevision.current = revision
    setPackageState('loading')
    void listPiPackagesRef.current().then(
      (packages) => {
        if (packageRequestRevision.current !== revision) return
        const pkg = packages.find(({ source }) => isSubagentPackageSource(source)) ?? null
        setPackageState(
          pkg === null ? 'not-installed' : pkg.extensionEnabled ? 'enabled' : 'disabled'
        )
      },
      () => {
        if (packageRequestRevision.current === revision) setPackageState('error')
      }
    )
    return () => {
      packageRequestRevision.current += 1
    }
  }, [])

  useEffect(() => {
    setEditorRevealed(false)
    setMultiSelect(false)
    setBatchSelectedIds(new Set())
    setBatchStatus(null)
    void loadDefinitions()
    return () => {
      definitionRequestRevision.current += 1
    }
  }, [activeProjectKey])

  useEffect(() => {
    if (page < pageCount) return
    setPage(pageCount - 1)
  }, [page, pageCount])

  useEffect(() => {
    if (!editorRevealed || !window.matchMedia('(max-width: 1100px)').matches) return
    editorBackRef.current?.focus()
  }, [editorRevealed])

  useEffect(() => {
    onDirtyChange(dirty)
    return () => onDirtyChange(false)
  }, [dirty, onDirtyChange])

  async function loadDefinitions(): Promise<void> {
    const revision = definitionRequestRevision.current + 1
    definitionRequestRevision.current = revision
    setDefinitionsLoading(true)
    setDefinitionsError(null)
    try {
      const nextDefinitions = await listSubagentDefinitionsRef.current()
      if (definitionRequestRevision.current !== revision) return
      setDefinitions(nextDefinitions)
      const nextEffectiveDefinitions = effectiveSubagentDefinitions(nextDefinitions)
      const nextSelected = nextEffectiveDefinitions.find(({ id }) => id === selectedId) ??
        nextEffectiveDefinitions[0] ??
        null
      selectDefinitionImmediately(nextSelected)
    } catch (loadError) {
      if (definitionRequestRevision.current !== revision) return
      setDefinitions([])
      setDefinitionsError(`读取 Agent 失败：${errorMessage(loadError)}`)
      selectDefinitionImmediately(null)
    } finally {
      if (definitionRequestRevision.current === revision) setDefinitionsLoading(false)
    }
  }

  function selectDefinitionImmediately(definition: KernelSubagentDefinition | null): void {
    setSelectedId(definition?.id ?? null)
    setEditorMode('basic')
    setActionError(null)
    if (definition === null) {
      setEditorRevealed(false)
      setDraft(null)
      setBaseline(null)
      setEditorState('edit')
      return
    }
    const nextDraft = definitionToInput(definition, activeProjectKey)
    setDraft(nextDraft)
    setBaseline(nextDraft)
    setEditorState(definition.editable ? 'edit' : 'override')
  }

  function selectDefinition(definition: KernelSubagentDefinition): void {
    if (dirty && !window.confirm('放弃尚未保存的 Agent 修改？')) return
    selectDefinitionImmediately(definition)
    setEditorRevealed(true)
  }

  function startCreate(): void {
    if (dirty && !window.confirm('放弃尚未保存的 Agent 修改？')) return
    setMultiSelect(false)
    setBatchSelectedIds(new Set())
    setBatchStatus(null)
    const nextDraft = emptyDefinitionInput(activeProjectKey)
    setSelectedId(null)
    setDraft(nextDraft)
    setBaseline(nextDraft)
    setEditorState('create')
    setEditorMode('basic')
    setEditorRevealed(true)
    setActionError(null)
  }

  function returnToBrowser(): void {
    setEditorRevealed(false)
    if (!window.matchMedia('(max-width: 1100px)').matches) return
    window.requestAnimationFrame(() => searchInputRef.current?.focus())
  }

  function closeEditor(): void {
    if (!multiSelect && dirty && !window.confirm('放弃尚未保存的 Agent 修改？')) return
    if (!multiSelect) {
      if (editorState === 'create') {
        selectDefinitionImmediately(effectiveDefinitions[0] ?? null)
      } else if (selectedDefinition !== null) {
        selectDefinitionImmediately(selectedDefinition)
      }
    }
    returnToBrowser()
  }

  function cancelEdit(): void {
    if (editorState === 'create') {
      selectDefinitionImmediately(effectiveDefinitions[0] ?? null)
    } else if (selectedDefinition !== null) {
      selectDefinitionImmediately(selectedDefinition)
    }
    returnToBrowser()
  }

  function toggleMultiSelectMode(): void {
    if (!multiSelect && dirty) {
      if (!window.confirm('放弃尚未保存的 Agent 修改并进入多选？')) return
      if (selectedDefinition !== null) selectDefinitionImmediately(selectedDefinition)
    }
    setMultiSelect(!multiSelect)
    setBatchSelectedIds(new Set())
    setBatchStatus(null)
    setActionError(null)
    setEditorRevealed(false)
  }

  function toggleBatchDefinition(id: string, selected: boolean): void {
    setBatchSelectedIds((current) => {
      const next = new Set(current)
      if (selected) next.add(id)
      else next.delete(id)
      return next
    })
    setBatchStatus(null)
    setActionError(null)
  }

  function toggleFilteredDefinitions(): void {
    setBatchSelectedIds((current) => {
      const next = new Set(current)
      for (const definition of filteredDefinitions) {
        if (allFilteredSelected) next.delete(definition.id)
        else next.add(definition.id)
      }
      return next
    })
    setBatchStatus(null)
    setActionError(null)
  }

  async function saveDefinition(): Promise<void> {
    if (draft === null) return
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(draft.name)) {
      setActionError('名称只能包含小写字母、数字和连字符，并且必须以字母或数字开头。')
      return
    }
    if (draft.description.trim().length === 0) {
      setActionError('请填写 Agent 用途。')
      return
    }
    setActing(true)
    setActionError(null)
    try {
      const nextDefinitions = await onSaveSubagentDefinition({
        ...draft,
        description: draft.description.trim()
      })
      setDefinitions(nextDefinitions)
      const saved = nextDefinitions.find((definition) =>
        definition.editable &&
        definition.scope === draft.scope &&
        definition.name === draft.name
      ) ?? null
      selectDefinitionImmediately(saved)
    } catch (saveError) {
      setActionError(`保存失败：${errorMessage(saveError)}`)
    } finally {
      setActing(false)
    }
  }

  async function setDefinitionEnabled(enabled: boolean): Promise<void> {
    if (selectedDefinition === null || draft === null) return
    if (dirty && !window.confirm('启停会立即保存。放弃当前尚未保存的 Agent 修改？')) return
    setActing(true)
    setActionError(null)
    try {
      const nextDefinitions = await onSetSubagentDefinitionEnabled(
        selectedDefinition.id,
        draft.scope,
        enabled
      )
      setDefinitions(nextDefinitions)
      const nextSelected = effectiveSubagentDefinitions(nextDefinitions)
        .find(({ name }) => name === selectedDefinition.name) ?? null
      selectDefinitionImmediately(nextSelected)
      if (nextSelected !== null && nextSelected.enabled !== enabled) {
        setActionError(
          enabled
            ? '该 Agent 仍被另一个作用域关闭。'
            : '该 Agent 仍被更高优先级的作用域开启。'
        )
      }
    } catch (enabledError) {
      setActionError(`启停失败：${errorMessage(enabledError)}`)
    } finally {
      setActing(false)
    }
  }

  async function removeDefinition(): Promise<void> {
    if (selectedDefinition === null || !selectedDefinition.editable) return
    if (!window.confirm(`删除 Subagent「${selectedDefinition.name}」？此操作会删除对应定义文件。`)) {
      return
    }
    setActing(true)
    setActionError(null)
    try {
      if (activeProjectKey !== null) {
        await onSetSubagentDefinitionEnabled(selectedDefinition.id, 'project', true)
      }
      await onSetSubagentDefinitionEnabled(selectedDefinition.id, 'user', true)
      const nextDefinitions = await onRemoveSubagentDefinition(selectedDefinition.id)
      setDefinitions(nextDefinitions)
      selectDefinitionImmediately(effectiveSubagentDefinitions(nextDefinitions)[0] ?? null)
    } catch (removeError) {
      setActionError(`删除失败：${errorMessage(removeError)}`)
    } finally {
      setActing(false)
    }
  }

  async function restoreBuiltinDefinition(): Promise<void> {
    if (selectedDefinition === null || !hasBuiltinDefault) return
    if (!window.confirm(
      `恢复 Subagent「${selectedDefinition.name}」的默认设置？所有同名用户级和项目级覆盖都会被删除。`
    )) {
      return
    }
    setActing(true)
    setActionError(null)
    try {
      const overrideIds = definitions
        .filter((definition) =>
          definition.editable && definition.name === selectedDefinition.name
        )
        .map(({ id }) => id)
      let nextDefinitions = definitions
      if (activeProjectKey !== null) {
        nextDefinitions = await onSetSubagentDefinitionEnabled(
          selectedDefinition.id,
          'project',
          true
        )
      }
      nextDefinitions = await onSetSubagentDefinitionEnabled(
        selectedDefinition.id,
        'user',
        true
      )
      for (const id of overrideIds) {
        nextDefinitions = await onRemoveSubagentDefinition(id)
      }
      setDefinitions(nextDefinitions)
      const restored = effectiveSubagentDefinitions(nextDefinitions)
        .find(({ name }) => name === selectedDefinition.name) ?? null
      selectDefinitionImmediately(restored)
    } catch (restoreError) {
      setActionError(`恢复默认失败：${errorMessage(restoreError)}`)
    } finally {
      setActing(false)
    }
  }

  async function applyBatchUpdate(): Promise<void> {
    if (batchSelectedDefinitions.length === 0) return
    const requestedEnabled = batchField === 'enabled'
      ? batchValue === 'enabled'
        ? true
        : batchValue === 'disabled' ? false : null
      : null
    const patch: Partial<KernelSubagentDefinitionInput> | null = batchField === 'enabled'
      ? {}
      : subagentBatchPatch(batchField, batchValue)
    if (patch === null || (batchField === 'enabled' && requestedEnabled === null)) {
      setActionError('批量设置值无效。')
      return
    }
    if (patch.scope === 'project' && activeProjectKey === null) {
      setActionError('选择 Project 后才能批量改为项目级。')
      return
    }
    if (patch.scope !== undefined) {
      const selectedIds = new Set(batchSelectedDefinitions.map(({ id }) => id))
      const conflict = batchSelectedDefinitions.find((definition) =>
        definitions.some((candidate) =>
          candidate.editable &&
          candidate.scope === patch.scope &&
          candidate.name === definition.name &&
          candidate.id !== definition.id &&
          !selectedIds.has(candidate.id)
        )
      )
      if (conflict !== undefined) {
        setActionError(`“${conflict.name}”在目标作用域中已经存在。`)
        return
      }
    }

    setActing(true)
    setActionError(null)
    setBatchStatus(null)
    const selectedNames = batchSelectedDefinitions.map(({ name }) => name)
    let nextDefinitions = definitions
    let updatedCount = 0
    try {
      for (const definition of batchSelectedDefinitions) {
        if (requestedEnabled !== null) {
          if (definition.enabled === requestedEnabled) continue
          const scope = definition.scope === 'builtin'
            ? activeProjectKey === null ? 'user' : 'project'
            : definition.scope
          nextDefinitions = await onSetSubagentDefinitionEnabled(
            definition.id,
            scope,
            requestedEnabled
          )
          updatedCount += 1
          continue
        }
        const currentInput = definitionToInput(definition, activeProjectKey)
        const nextInput = { ...currentInput, ...patch }
        if (JSON.stringify(nextInput) === JSON.stringify(currentInput)) continue
        nextDefinitions = await onSaveSubagentDefinition(nextInput)
        updatedCount += 1
      }
      setDefinitions(nextDefinitions)
      const nextEffectiveDefinitions = effectiveSubagentDefinitions(nextDefinitions)
      setBatchSelectedIds(new Set(
        nextEffectiveDefinitions
          .filter(({ name }) => selectedNames.includes(name))
          .map(({ id }) => id)
      ))
      const unresolvedCount = requestedEnabled === null
        ? 0
        : nextEffectiveDefinitions.filter((definition) =>
            selectedNames.includes(definition.name) &&
            definition.enabled !== requestedEnabled
          ).length
      if (unresolvedCount > 0) {
        setActionError(`${unresolvedCount} 个 Agent 仍受其他作用域的启停设置影响。`)
      } else {
        setBatchStatus(
          updatedCount === 0
            ? '所选 Agent 已经是这个设置。'
            : `已更新 ${updatedCount} 个 Agent。`
        )
      }
    } catch (batchError) {
      setDefinitions(nextDefinitions)
      const nextEffectiveDefinitions = effectiveSubagentDefinitions(nextDefinitions)
      setBatchSelectedIds(new Set(
        nextEffectiveDefinitions
          .filter(({ name }) => selectedNames.includes(name))
          .map(({ id }) => id)
      ))
      setActionError(
        updatedCount === 0
          ? `批量修改失败：${errorMessage(batchError)}`
          : `已更新 ${updatedCount} 个 Agent，随后失败：${errorMessage(batchError)}`
      )
    } finally {
      setActing(false)
    }
  }

  function updateDraft(patch: Partial<KernelSubagentDefinitionInput>): void {
    setDraft((current) => current === null ? null : { ...current, ...patch })
  }

  const formDisabled = busy || acting
  const modelOptions = [
    { value: 'inherit', label: '继承父 Session' },
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
    modelOptions.splice(1, 0, { value: draft.model, label: `${draft.model}（当前不可用）` })
  }
  const batchFieldOptions = [
    { value: 'scope', label: '作用域' },
    { value: 'enabled', label: '启用状态' },
    { value: 'model', label: '模型' },
    { value: 'thinking', label: '思考强度' },
    { value: 'inheritProjectContext', label: '继承项目指令' },
    { value: 'inheritSkills', label: '继承 Skills' },
    { value: 'defaultAsync', label: '默认执行方式' },
    { value: 'maxSubagentDepth', label: '单 Agent 嵌套上限' }
  ]
  const batchValueOptions = batchField === 'scope'
    ? [
        { value: 'user', label: '用户级' },
        { value: 'project', label: '当前 Project', disabled: activeProjectKey === null }
      ]
    : batchField === 'enabled'
      ? [
          { value: 'enabled', label: '已启用' },
          { value: 'disabled', label: '已停用' }
        ]
      : batchField === 'model'
        ? modelOptions
        : batchField === 'thinking'
        ? [
            { value: 'inherit', label: '继承默认值' },
            ...THINKING_LEVELS.map((value) => ({
              value,
              label: localizedThinkingLevelLabel(value)
            }))
            ]
          : batchField === 'inheritProjectContext' || batchField === 'inheritSkills'
            ? [
                { value: 'enabled', label: '开启' },
                { value: 'disabled', label: '关闭' }
              ]
            : batchField === 'defaultAsync'
              ? [
                  { value: 'unset', label: '调用时决定' },
                  { value: 'foreground', label: '前台执行' },
                  { value: 'background', label: '后台执行' }
                ]
              : [
                  { value: 'unset', label: '使用全局上限' },
                  { value: '0', label: '禁止继续委派' },
                  { value: '1', label: '最多 1 层' },
                  { value: '2', label: '最多 2 层' },
                  { value: '3', label: '最多 3 层' }
                ]

  return (
    <>
      <div className="settings-section-heading settings-section-heading-with-action settings-subagent-heading">
        <h2>Subagent</h2>
        <span className="settings-subagent-status" data-state={packageState}>
          {packageState === 'enabled'
            ? '拓展已开启'
            : packageState === 'disabled'
              ? '拓展已关闭'
              : packageState === 'not-installed'
                ? '尚未安装'
                : packageState === 'loading'
                  ? '读取中'
                  : '状态异常'}
        </span>
      </div>

      <section className="settings-group" aria-labelledby="settings-subagent-agents-heading">
        <div className="settings-group-heading-row">
          <h3 id="settings-subagent-agents-heading" className="settings-group-heading">
            Agent 管理
          </h3>
          <div className="settings-subagent-heading-actions">
            <button
              type="button"
              className="settings-link-button"
              aria-pressed={multiSelect}
              disabled={busy || acting || managerDisabled}
              onClick={toggleMultiSelectMode}
            >
              {multiSelect ? '退出多选' : '多选'}
            </button>
            <button
              type="button"
              className="settings-extension-remove"
              disabled={busy || acting || managerDisabled}
              onClick={startCreate}
            >
              新增 Agent
            </button>
          </div>
        </div>
        <div
          className="settings-group-card settings-subagent-manager"
          data-editor-revealed={editorRevealed}
        >
          <aside className="settings-subagent-browser" aria-label="Subagent 列表">
            <div className="settings-subagent-browser-header">
              <input
                ref={searchInputRef}
                type="search"
                aria-label="搜索 Subagent"
                placeholder="搜索 Agent"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value)
                  setPage(0)
                }}
              />
              <div className="settings-subagent-filter">
                <label htmlFor="settings-subagent-scope-filter">作用域</label>
                <Select
                  id="settings-subagent-scope-filter"
                  value={scopeFilter}
                  groups={[{
                    options: [
                      { value: 'all', label: '全部' },
                      { value: 'builtin', label: '内置' },
                      { value: 'user', label: '用户级' },
                      { value: 'project', label: '项目级' }
                    ]
                  }]}
                  onValueChange={(value) => {
                    if (
                      value === 'all' ||
                      value === 'builtin' ||
                      value === 'user' ||
                      value === 'project'
                    ) {
                      setScopeFilter(value)
                      setPage(0)
                    }
                  }}
                />
              </div>
              <div className="settings-subagent-filter">
                <label htmlFor="settings-subagent-enabled-filter">状态</label>
                <Select
                  id="settings-subagent-enabled-filter"
                  value={enabledFilter}
                  groups={[{
                    options: [
                      { value: 'all', label: '全部' },
                      { value: 'enabled', label: '已启用' },
                      { value: 'disabled', label: '已停用' }
                    ]
                  }]}
                  onValueChange={(value) => {
                    if (value === 'all' || value === 'enabled' || value === 'disabled') {
                      setEnabledFilter(value)
                      setPage(0)
                    }
                  }}
                />
              </div>
              {multiSelect ? (
                <div className="settings-subagent-selection-bar">
                  <button
                    type="button"
                    disabled={filteredDefinitions.length === 0}
                    onClick={toggleFilteredDefinitions}
                  >
                    {allFilteredSelected ? '取消全选' : '全选结果'}
                  </button>
                  <span>{batchSelectedDefinitions.length} 个已选</span>
                  <button
                    type="button"
                    className="settings-subagent-batch-open"
                    disabled={batchSelectedDefinitions.length === 0}
                    onClick={() => setEditorRevealed(true)}
                  >
                    批量修改
                  </button>
                </div>
              ) : null}
            </div>
            {definitionsLoading ? (
              <p className="settings-subagent-list-status" role="status">正在读取 Agent…</p>
            ) : definitionsError !== null ? (
              <div className="settings-subagent-list-status">
                <p role="alert">{definitionsError}</p>
                <button type="button" onClick={() => void loadDefinitions()}>重试</button>
              </div>
            ) : visibleDefinitions.length === 0 ? (
              <p className="settings-subagent-list-status">没有匹配的 Agent。</p>
            ) : (
              <div className="settings-subagent-list">
                {visibleDefinitions.map((definition) => multiSelect ? (
                  <label
                    key={definition.id}
                    className="settings-subagent-list-item"
                    data-multi="true"
                    data-selected={batchSelectedIds.has(definition.id)}
                  >
                    <input
                      type="checkbox"
                      checked={batchSelectedIds.has(definition.id)}
                      onChange={(event) => {
                        toggleBatchDefinition(definition.id, event.target.checked)
                      }}
                    />
                    <strong>{definition.name}</strong>
                  </label>
                ) : (
                  <button
                    type="button"
                    key={definition.id}
                    className="settings-subagent-list-item"
                    data-selected={definition.id === selectedId}
                    aria-pressed={definition.id === selectedId}
                    onClick={() => selectDefinition(definition)}
                  >
                    <strong>{definition.name}</strong>
                  </button>
                ))}
              </div>
            )}
            {!definitionsLoading && definitionsError === null && filteredDefinitions.length > 0 ? (
              <nav className="settings-subagent-pagination" aria-label="Subagent 分页">
                <IconButton
                  className="settings-subagent-page-button"
                  icon="chevron-left"
                  iconSize="sm"
                  label="上一页"
                  disabled={page === 0}
                  onClick={() => setPage((current) => Math.max(0, current - 1))}
                />
                <span>共 {filteredDefinitions.length} 个 · {page + 1} / {pageCount}</span>
                <IconButton
                  className="settings-subagent-page-button"
                  icon="chevron-right"
                  iconSize="sm"
                  label="下一页"
                  disabled={page >= pageCount - 1}
                  onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
                />
              </nav>
            ) : null}
          </aside>

          <div className="settings-subagent-editor">
            {multiSelect ? (
              batchSelectedDefinitions.length === 0 ? (
                <div className="settings-subagent-editor-empty">
                  <h4>选择 Agent</h4>
                </div>
              ) : (
                <>
                  <div className="settings-subagent-editor-header">
                    <IconButton
                      ref={editorBackRef}
                      className="settings-subagent-editor-back"
                      icon="arrow-left"
                      label="返回 Agent 列表"
                      onClick={closeEditor}
                    />
                    <h4>批量修改 · {batchSelectedDefinitions.length} 个 Agent</h4>
                  </div>
                  <div className="settings-subagent-editor-body">
                    <div className="settings-subagent-field-grid">
                      <SettingsField label="修改项" htmlFor="settings-subagent-batch-field">
                        <Select
                          id="settings-subagent-batch-field"
                          value={batchField}
                          disabled={formDisabled}
                          groups={[{ options: batchFieldOptions }]}
                          onValueChange={(value) => {
                            if (!isSubagentBatchField(value)) return
                            setBatchField(value)
                            setBatchValue(defaultSubagentBatchValue(value))
                            setBatchStatus(null)
                            setActionError(null)
                          }}
                        />
                      </SettingsField>
                      <SettingsField label="统一设置为" htmlFor="settings-subagent-batch-value">
                        <Select
                          id="settings-subagent-batch-value"
                          value={batchValue}
                          disabled={formDisabled}
                          groups={[{ options: batchValueOptions }]}
                          onValueChange={(value) => {
                            setBatchValue(value)
                            setBatchStatus(null)
                            setActionError(null)
                          }}
                        />
                      </SettingsField>
                    </div>
                  </div>
                  {actionError === null ? null : (
                    <p className="settings-subagent-editor-error" role="alert">{actionError}</p>
                  )}
                  <div className="settings-subagent-editor-actions">
                    <div>
                      {batchStatus === null ? null : (
                        <p className="settings-subagent-batch-status" role="status">
                          {batchStatus}
                        </p>
                      )}
                    </div>
                    <div>
                      <button
                        type="button"
                        className="settings-extension-remove"
                        disabled={busy || acting}
                        onClick={() => void applyBatchUpdate()}
                      >
                        {acting ? '应用中…' : `应用到 ${batchSelectedDefinitions.length} 个 Agent`}
                      </button>
                    </div>
                  </div>
                </>
              )
            ) : draft === null ? (
              <div className="settings-subagent-editor-empty">
                <h4>选择一个 Agent</h4>
              </div>
            ) : (
              <>
                <div className="settings-subagent-editor-header">
                  <IconButton
                    ref={editorBackRef}
                    className="settings-subagent-editor-back"
                    icon="arrow-left"
                    label="返回 Agent 列表"
                    onClick={closeEditor}
                  />
                  <h4>{editorState === 'create' ? '新增 Agent' : draft.name}</h4>
                </div>

                <div
                  className="settings-subagent-editor-tabs"
                  role="group"
                  aria-label="Agent 设置层级"
                >
                  <button
                    type="button"
                    aria-pressed={editorMode === 'basic'}
                    onClick={() => setEditorMode('basic')}
                  >
                    基础设置
                  </button>
                  <button
                    type="button"
                    aria-pressed={editorMode === 'advanced'}
                    onClick={() => setEditorMode('advanced')}
                  >
                    高级设置
                  </button>
                </div>

                <div className="settings-subagent-editor-body">
                  {editorMode === 'basic' ? (
                    <>
                      <div className={
                        editorState === 'create'
                          ? 'settings-subagent-field-grid'
                          : 'settings-subagent-field-grid settings-subagent-identity-grid'
                      }>
                        <SettingsField label="名称" htmlFor="settings-subagent-name">
                          <input
                            id="settings-subagent-name"
                            value={draft.name}
                            disabled={formDisabled}
                            placeholder="例如 security-reviewer"
                            onChange={(event) => updateDraft({ name: event.target.value })}
                          />
                        </SettingsField>
                        <SettingsField label="作用域" htmlFor="settings-subagent-scope">
                          <Select
                            id="settings-subagent-scope"
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
                              if (value === 'user' || value === 'project') {
                                updateDraft({ scope: value })
                              }
                            }}
                          />
                        </SettingsField>
                        {editorState === 'create' || selectedDefinition === null ? null : (
                          <SettingsField
                            label="启用状态"
                            htmlFor="settings-subagent-definition-enabled"
                          >
                            <Select
                              id="settings-subagent-definition-enabled"
                              value={selectedDefinition.enabled ? 'enabled' : 'disabled'}
                              disabled={formDisabled}
                              groups={[{
                                options: [
                                  { value: 'enabled', label: '已启用' },
                                  { value: 'disabled', label: '已停用' }
                                ]
                              }]}
                              onValueChange={(value) => {
                                if (value === 'enabled' || value === 'disabled') {
                                  void setDefinitionEnabled(value === 'enabled')
                                }
                              }}
                            />
                          </SettingsField>
                        )}
                      </div>
                      <SettingsField label="用途" htmlFor="settings-subagent-description">
                        <input
                          id="settings-subagent-description"
                          value={draft.description}
                          disabled={formDisabled}
                          placeholder="告诉主 Agent 什么时候应该委派给它"
                          onChange={(event) => updateDraft({ description: event.target.value })}
                        />
                      </SettingsField>
                      <SettingsField label="角色提示词" htmlFor="settings-subagent-system-prompt">
                        <textarea
                          id="settings-subagent-system-prompt"
                          rows={9}
                          value={draft.systemPrompt}
                          disabled={formDisabled}
                          onChange={(event) => updateDraft({ systemPrompt: event.target.value })}
                        />
                      </SettingsField>
                      <div className="settings-subagent-field-grid">
                        <SettingsField label="模型" htmlFor="settings-subagent-model">
                          <Select
                            id="settings-subagent-model"
                            value={draft.model ?? 'inherit'}
                            disabled={formDisabled}
                            groups={[{ options: modelOptions }]}
                            onValueChange={(value) => updateDraft({
                              model: value === 'inherit' ? null : value
                            })}
                          />
                        </SettingsField>
                        <SettingsField label="思考强度" htmlFor="settings-subagent-thinking">
                          <Select
                            id="settings-subagent-thinking"
                            value={draft.thinking ?? 'inherit'}
                            disabled={formDisabled}
                            groups={[{
                              options: [
                                { value: 'inherit', label: '继承默认值' },
                                ...THINKING_LEVELS.map((value) => ({
                                  value,
                                  label: localizedThinkingLevelLabel(value)
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
                    </>
                  ) : (
                    <>
                      <div className="settings-subagent-field-grid">
                        <SettingsField label="提示词模式" htmlFor="settings-subagent-prompt-mode">
                          <Select
                            id="settings-subagent-prompt-mode"
                            value={draft.systemPromptMode}
                            disabled={formDisabled}
                            groups={[{
                              options: [
                                { value: 'replace', label: '独立提示词' },
                                { value: 'append', label: '追加到 Pi 基础提示词' }
                              ]
                            }]}
                            onValueChange={(value) => {
                              if (value === 'replace' || value === 'append') {
                                updateDraft({ systemPromptMode: value })
                              }
                            }}
                          />
                        </SettingsField>
                        <SettingsField label="默认上下文" htmlFor="settings-subagent-context">
                          <Select
                            id="settings-subagent-context"
                            value={draft.defaultContext ?? 'unset'}
                            disabled={formDisabled}
                            groups={[{
                              options: [
                                { value: 'unset', label: '调用时决定' },
                                { value: 'fresh', label: '全新上下文' },
                                { value: 'fork', label: '继承当前 Session' }
                              ]
                            }]}
                            onValueChange={(value) => updateDraft({
                              defaultContext: value === 'fresh' || value === 'fork' ? value : null
                            })}
                          />
                        </SettingsField>
                      </div>
                      <div className="settings-subagent-checks">
                        <label>
                          <input
                            type="checkbox"
                            checked={draft.inheritProjectContext}
                            disabled={formDisabled}
                            onChange={(event) => updateDraft({
                              inheritProjectContext: event.target.checked
                            })}
                          />
                          <strong>继承项目指令</strong>
                        </label>
                        <label>
                          <input
                            type="checkbox"
                            checked={draft.inheritSkills}
                            disabled={formDisabled}
                            onChange={(event) => updateDraft({
                              inheritSkills: event.target.checked
                            })}
                          />
                          <strong>继承 Skills</strong>
                        </label>
                      </div>
                      <div className="settings-subagent-field-grid">
                        <SettingsField label="工具" htmlFor="settings-subagent-tools">
                          <CommaListInput
                            id="settings-subagent-tools"
                            value={listValue(draft.tools)}
                            disabled={formDisabled}
                            placeholder="read, grep, bash"
                            onCommit={(value) => updateDraft({
                              tools: parseListValue(value)
                            })}
                          />
                        </SettingsField>
                        <SettingsField label="Skills" htmlFor="settings-subagent-skills">
                          <CommaListInput
                            id="settings-subagent-skills"
                            value={listValue(draft.skills)}
                            disabled={formDisabled}
                            placeholder="code-review, security"
                            onCommit={(value) => updateDraft({
                              skills: parseListValue(value)
                            })}
                          />
                        </SettingsField>
                      </div>
                      <div className="settings-subagent-field-grid">
                        <SettingsField label="默认执行方式" htmlFor="settings-subagent-async">
                          <Select
                            id="settings-subagent-async"
                            value={draft.defaultAsync === null
                              ? 'unset'
                              : draft.defaultAsync ? 'background' : 'foreground'}
                            disabled={formDisabled}
                            groups={[{
                              options: [
                                { value: 'unset', label: '调用时决定' },
                                { value: 'foreground', label: '前台执行' },
                                { value: 'background', label: '后台执行' }
                              ]
                            }]}
                            onValueChange={(value) => updateDraft({
                              defaultAsync: value === 'unset' ? null : value === 'background'
                            })}
                          />
                        </SettingsField>
                        <SettingsField label="单 Agent 嵌套上限" htmlFor="settings-subagent-agent-depth">
                          <Select
                            id="settings-subagent-agent-depth"
                            value={draft.maxSubagentDepth === null
                              ? 'unset'
                              : String(draft.maxSubagentDepth)}
                            disabled={formDisabled}
                            groups={[{
                              options: [
                                { value: 'unset', label: '使用全局上限' },
                                { value: '0', label: '禁止继续委派' },
                                { value: '1', label: '最多 1 层' },
                                { value: '2', label: '最多 2 层' },
                                { value: '3', label: '最多 3 层' }
                              ]
                            }]}
                            onValueChange={(value) => updateDraft({
                              maxSubagentDepth: value === 'unset' ? null : Number(value)
                            })}
                          />
                        </SettingsField>
                      </div>
                      <div className="settings-subagent-field-grid">
                        <SettingsField label="超时（秒）" htmlFor="settings-subagent-timeout">
                          <input
                            id="settings-subagent-timeout"
                            type="number"
                            min={1}
                            max={86400}
                            value={draft.timeoutMs === null ? '' : draft.timeoutMs / 1000}
                            disabled={formDisabled}
                            onChange={(event) => updateDraft({
                              timeoutMs: event.target.value === ''
                                ? null
                                : Math.round(Number(event.target.value) * 1000)
                            })}
                          />
                        </SettingsField>
                        <SettingsField label="最大轮次" htmlFor="settings-subagent-turns">
                          <input
                            id="settings-subagent-turns"
                            type="number"
                            min={1}
                            max={1000}
                            value={draft.maxTurns ?? ''}
                            disabled={formDisabled}
                            onChange={(event) => updateDraft({
                              maxTurns: event.target.value === ''
                                ? null
                                : Number(event.target.value)
                            })}
                          />
                        </SettingsField>
                      </div>
                      <SettingsField label="回退模型" htmlFor="settings-subagent-fallback-models">
                        <CommaListInput
                          id="settings-subagent-fallback-models"
                          value={listValue(draft.fallbackModels)}
                          disabled={formDisabled}
                          placeholder="provider/model-a, provider/model-b"
                          onCommit={(value) => updateDraft({
                            fallbackModels: parseListValue(value)
                          })}
                        />
                      </SettingsField>
                    </>
                  )}
                </div>

                {actionError === null ? null : (
                  <p className="settings-subagent-editor-error" role="alert">{actionError}</p>
                )}
                <div className="settings-subagent-editor-actions">
                  <div>
                    {selectedDefinition?.editable === true && editorState === 'edit' ? (
                      hasBuiltinDefault ? (
                        <button
                          type="button"
                          className="settings-link-button"
                          disabled={busy || acting}
                          onClick={() => void restoreBuiltinDefinition()}
                        >
                          恢复默认
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="settings-subagent-delete"
                          disabled={busy || acting}
                          onClick={() => void removeDefinition()}
                        >
                          删除
                        </button>
                      )
                    ) : null}
                  </div>
                  <div>
                    <button
                      type="button"
                      className="settings-link-button"
                      disabled={busy || acting}
                      onClick={cancelEdit}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="settings-extension-remove"
                      disabled={busy || acting || !dirty}
                      onClick={() => void saveDefinition()}
                    >
                      {acting ? '保存中…' : '保存 Agent'}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </section>

      <section
        className="settings-group settings-group-inline"
        aria-labelledby="settings-subagent-runtime-heading"
      >
        <h3 id="settings-subagent-runtime-heading" className="settings-group-heading">运行设置</h3>
        <div className="settings-group-card">
          <div className="settings-row">
            <div className="settings-row-copy">
              <h4>最大嵌套层数</h4>
            </div>
            <div className="settings-row-control settings-theme-control">
              <Select
                id="settings-subagent-max-depth"
                value={String(settings.maxDepth)}
                groups={[{
                  options: [1, 2, 3].map((value) => ({
                    value: String(value),
                    label: String(value)
                  }))
                }]}
                disabled={settingsDisabled}
                onValueChange={(value) => {
                  const maxDepth = Number(value)
                  if (maxDepth !== 1 && maxDepth !== 2 && maxDepth !== 3) return
                  void onSetSubagent({ maxDepth }).catch(() => undefined)
                }}
              />
            </div>
          </div>
        </div>
        {packageState === 'enabled' || packageState === 'loading' ? null : (
          <p
            className="settings-subagent-notice"
            role={packageState === 'error' ? 'alert' : undefined}
          >
            {packageState === 'not-installed'
              ? '请先在“拓展”的“已适配拓展”区域安装 pi-subagents。'
              : packageState === 'disabled'
                ? 'pi-subagents 已关闭，请先在“拓展”的“已适配拓展”区域开启。'
                : '无法读取 pi-subagents 状态，请前往“拓展”页重试。'}
          </p>
        )}
      </section>
    </>
  )
}

function CommaListInput({
  id,
  value,
  disabled,
  placeholder,
  onCommit
}: {
  id: string
  value: string
  disabled: boolean
  placeholder: string
  onCommit: (value: string) => void
}): React.JSX.Element {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  return (
    <input
      id={id}
      value={text}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => onCommit(text)}
    />
  )
}

function definitionToInput(
  definition: KernelSubagentDefinition,
  activeProjectKey: string | null
): KernelSubagentDefinitionInput {
  return {
    originalId: definition.id,
    scope: definition.scope === 'builtin'
      ? activeProjectKey === null ? 'user' : 'project'
      : definition.scope,
    name: definition.name,
    description: definition.description,
    systemPrompt: definition.systemPrompt,
    model: definition.model,
    fallbackModels: definition.fallbackModels,
    thinking: definition.thinking,
    systemPromptMode: definition.systemPromptMode,
    inheritProjectContext: definition.inheritProjectContext,
    inheritSkills: definition.inheritSkills,
    defaultContext: definition.defaultContext,
    tools: definition.tools,
    skills: definition.skills,
    defaultAsync: definition.defaultAsync,
    timeoutMs: definition.timeoutMs,
    maxTurns: definition.maxTurns,
    maxSubagentDepth: definition.maxSubagentDepth
  }
}

function emptyDefinitionInput(activeProjectKey: string | null): KernelSubagentDefinitionInput {
  return {
    originalId: null,
    scope: activeProjectKey === null ? 'user' : 'project',
    name: '',
    description: '',
    systemPrompt: '',
    model: null,
    fallbackModels: null,
    thinking: null,
    systemPromptMode: 'replace',
    inheritProjectContext: true,
    inheritSkills: false,
    defaultContext: 'fresh',
    tools: null,
    skills: null,
    defaultAsync: null,
    timeoutMs: null,
    maxTurns: null,
    maxSubagentDepth: null
  }
}

function isSubagentBatchField(value: string): value is SubagentBatchField {
  return [
    'scope',
    'enabled',
    'model',
    'thinking',
    'inheritProjectContext',
    'inheritSkills',
    'defaultAsync',
    'maxSubagentDepth'
  ].includes(value)
}

function defaultSubagentBatchValue(field: SubagentBatchField): string {
  if (field === 'scope') return 'user'
  if (field === 'enabled') return 'enabled'
  if (field === 'inheritProjectContext' || field === 'inheritSkills') return 'enabled'
  if (field === 'defaultAsync' || field === 'maxSubagentDepth') return 'unset'
  return 'inherit'
}

function subagentBatchPatch(
  field: SubagentBatchField,
  value: string
): Partial<KernelSubagentDefinitionInput> | null {
  if (field === 'scope') {
    return value === 'user' || value === 'project' ? { scope: value } : null
  }
  if (field === 'enabled') return null
  if (field === 'model') return { model: value === 'inherit' ? null : value }
  if (field === 'thinking') {
    if (value === 'inherit') return { thinking: null }
    if (!isThinkingLevel(value)) return null
    return { thinking: value }
  }
  if (field === 'inheritProjectContext') {
    if (value !== 'enabled' && value !== 'disabled') return null
    return { inheritProjectContext: value === 'enabled' }
  }
  if (field === 'inheritSkills') {
    if (value !== 'enabled' && value !== 'disabled') return null
    return { inheritSkills: value === 'enabled' }
  }
  if (field === 'defaultAsync') {
    if (value === 'unset') return { defaultAsync: null }
    if (value !== 'foreground' && value !== 'background') return null
    return { defaultAsync: value === 'background' }
  }
  if (value === 'unset') return { maxSubagentDepth: null }
  const maxSubagentDepth = Number(value)
  return Number.isInteger(maxSubagentDepth) &&
    maxSubagentDepth >= 0 &&
    maxSubagentDepth <= 3
    ? { maxSubagentDepth }
    : null
}

function effectiveSubagentDefinitions(
  definitions: KernelSubagentDefinition[]
): KernelSubagentDefinition[] {
  const definitionsByName = new Map<string, KernelSubagentDefinition>()
  for (const definition of definitions) definitionsByName.set(definition.name, definition)
  return [...definitionsByName.values()].sort((left, right) =>
    left.name.localeCompare(right.name)
  )
}

function listValue(value: string[] | null): string {
  return value?.join(', ') ?? ''
}

function parseListValue(value: string): string[] | null {
  const items = value.split(',').map((item) => item.trim()).filter(Boolean)
  return items.length === 0 ? null : items
}

function isSubagentPackageSource(source: string): boolean {
  return source === SUBAGENT_PACKAGE_SOURCE || source.startsWith(`${SUBAGENT_PACKAGE_SOURCE}@`)
}
