import { useEffect, useState } from 'react'

import {
  KERNEL_PROVIDER_APIS,
  type KernelProviderApi,
  type KernelProviderCatalogModel,
  type KernelProviderConfig,
  type KernelProviderInput,
  type KernelProviderModelConfig,
  type KernelProviderTestResult
} from '../../../../shared/kernel-contract'
import { Select } from '../../components/Select'
import './provider-settings.css'

type ProviderSettingsProps = {
  busy: boolean
  onListProviders: () => Promise<KernelProviderConfig[]>
  onSaveProvider: (provider: KernelProviderInput) => Promise<KernelProviderConfig[]>
  onRemoveProvider: (providerId: string) => Promise<KernelProviderConfig[]>
  onTestProvider: (providerId: string, modelId: string) => Promise<KernelProviderTestResult>
}

type ProviderDraft = {
  originalId: string | null
  id: string
  baseUrl: string
  api: KernelProviderApi
  apiKey: string
  apiKeyConfigured: boolean
  removeApiKey: boolean
  authHeader: boolean
  models: ModelDraft[]
}

type ModelDraft = {
  id: string
  name: string
  contextWindow: string
  maxTokens: string
  reasoning: ModelCapabilityDraft
  imageInput: ModelCapabilityDraft
}

type ModelCapabilityDraft = 'unset' | 'supported' | 'unsupported'
type FormSubmitMode = 'save' | 'save-and-test'

const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const RESERVED_PROVIDER_IDS = new Set(['__proto__', 'constructor', 'prototype'])
const API_OPTIONS = [{
  options: KERNEL_PROVIDER_APIS.map((api) => ({ value: api, label: api }))
}]
const MODEL_CAPABILITY_OPTIONS = [{
  options: [
    { value: 'unset', label: '未配置' },
    { value: 'supported', label: '支持' },
    { value: 'unsupported', label: '不支持' }
  ]
}]

export function ProviderSettings({
  busy,
  onListProviders,
  onSaveProvider,
  onRemoveProvider,
  onTestProvider
}: ProviderSettingsProps): React.JSX.Element {
  const [providers, setProviders] = useState<KernelProviderConfig[]>([])
  const [draft, setDraft] = useState<ProviderDraft | null>(null)
  const [action, setAction] = useState<string | null>('loading')
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expandedModelKey, setExpandedModelKey] = useState<string | null>(null)
  const controlsDisabled = busy || action !== null

  useEffect(() => {
    let active = true
    setAction('loading')
    setError(null)
    void onListProviders()
      .then((nextProviders) => {
        if (active) setProviders(nextProviders)
      })
      .catch((reason: unknown) => {
        if (active) setError(errorMessage(reason, '无法读取 Provider 配置。'))
      })
      .finally(() => {
        if (active) setAction(null)
      })
    return () => {
      active = false
    }
  }, [onListProviders])

  function startCreate(): void {
    setDraft(emptyProviderDraft())
    setMessage(null)
    setError(null)
  }

  function startEdit(provider: KernelProviderConfig): void {
    setDraft(providerDraft(provider))
    setMessage(null)
    setError(null)
  }

  function handleSubmit(mode: FormSubmitMode): void {
    if (draft === null || controlsDisabled) return
    let input: KernelProviderInput
    try {
      input = providerInput(draft)
    } catch (reason) {
      setError(errorMessage(reason, 'Provider 配置无效。'))
      setMessage(null)
      return
    }

    let saved = false
    setAction(mode)
    setError(null)
    setMessage(mode === 'save' ? '正在保存 Provider…' : '正在保存 Provider，随后测试第一个模型…')
    void onSaveProvider(input)
      .then(async (nextProviders) => {
        saved = true
        setProviders(nextProviders)
        setDraft(null)
        if (mode === 'save-and-test') {
          const result = await onTestProvider(input.id, input.models[0].id)
          setMessage(testSuccessMessage(result, true))
        } else {
          setMessage('Provider 已保存。')
        }
      })
      .catch((reason: unknown) => {
        const detail = errorMessage(reason, mode === 'save' ? '保存 Provider 失败。' : '连接测试失败。')
        setError(saved ? `Provider 已保存，但连接测试失败：${detail}` : detail)
        setMessage(null)
      })
      .finally(() => setAction(null))
  }

  function handleRemove(provider: KernelProviderConfig): void {
    if (controlsDisabled || !window.confirm(`删除 Provider「${provider.id}」？`)) return
    setAction(`remove:${provider.id}`)
    setError(null)
    setMessage(`正在删除 Provider「${provider.id}」…`)
    void onRemoveProvider(provider.id)
      .then((nextProviders) => {
        setProviders(nextProviders)
        if (draft?.originalId === provider.id) setDraft(null)
        setMessage('Provider 已删除。')
      })
      .catch((reason: unknown) => {
        setError(errorMessage(reason, '删除 Provider 失败。'))
        setMessage(null)
      })
      .finally(() => setAction(null))
  }

  function handleTest(providerId: string, modelId: string): void {
    if (controlsDisabled) return
    setAction(`test:${providerId}:${modelId}`)
    setError(null)
    setMessage(`正在测试 ${providerId}/${modelId}…`)
    void onTestProvider(providerId, modelId)
      .then((result) => setMessage(testSuccessMessage(result, false)))
      .catch((reason: unknown) => {
        setError(errorMessage(reason, `测试 ${providerId}/${modelId} 失败。`))
        setMessage(null)
      })
      .finally(() => setAction(null))
  }

  return (
    <section className="provider-settings" aria-label="Provider 管理">
      <div className="provider-settings-heading">
        <div>
          <h3>自定义 Provider</h3>
          <p>管理写入 Pi 用户模型配置的自定义 Provider。</p>
        </div>
        <button type="button" disabled={controlsDisabled || draft !== null} onClick={startCreate}>
          新增 Provider
        </button>
      </div>

      {message === null ? null : (
        <p className="provider-settings-status" role="status" aria-live="polite">{message}</p>
      )}
      {error === null ? null : (
        <p className="provider-settings-error" role="alert">{error}</p>
      )}

      {draft === null ? null : (
        <ProviderForm
          draft={draft}
          disabled={controlsDisabled}
          mode={draft.originalId === null ? 'create' : 'edit'}
          onChange={setDraft}
          onCancel={() => {
            setDraft(null)
            setError(null)
          }}
          onSubmit={handleSubmit}
        />
      )}

      {action === 'loading' ? (
        <div className="settings-empty-state provider-settings-empty" role="status">正在读取 Provider…</div>
      ) : providers.length === 0 ? (
        <div className="settings-empty-state provider-settings-empty" role="status">
          <h3>暂无自定义 Provider</h3>
          <p>添加 Provider 后，可以为其配置一个或多个模型。</p>
        </div>
      ) : (
        <div className="provider-settings-list">
          {providers.map((provider) => {
            const editingDraft = draft?.originalId === provider.id ? draft : null
            const credentialStatus = editingDraft?.removeApiKey
              ? '待移除'
              : editingDraft !== null && editingDraft.apiKey.length > 0
                ? '待保存'
                : provider.apiKeyConfigured
                  ? '已保存'
                  : '未设置'
            const authHeaderStatus = editingDraft !== null && editingDraft.authHeader !== provider.authHeader
              ? `${editingDraft.authHeader ? '启用' : '关闭'}（待保存）`
              : provider.authHeader
                ? '启用'
                : '关闭'

            return (
              <article className="settings-card settings-card-stacked provider-card" key={provider.id}>
                <div className="provider-card-heading">
                  <div className="provider-card-title">
                    <h3>{provider.id}</h3>
                    <span className="settings-value-chip">{provider.api}</span>
                  </div>
                  <div className="provider-card-actions">
                    <button type="button" disabled={controlsDisabled || draft !== null} onClick={() => startEdit(provider)}>
                      编辑
                    </button>
                    <button type="button" disabled={controlsDisabled || draft !== null} onClick={() => handleRemove(provider)}>
                      {action === `remove:${provider.id}` ? '删除中…' : '删除'}
                    </button>
                  </div>
                </div>
                <dl className="provider-card-details">
                  <div><dt>Base URL</dt><dd><code>{provider.baseUrl}</code></dd></div>
                  <div><dt>凭据</dt><dd>{credentialStatus}</dd></div>
                  <div><dt>Authorization Header</dt><dd>{authHeaderStatus}</dd></div>
                </dl>
                <div className="provider-model-list">
                  {provider.models.map((model) => {
                    const modelKey = `${provider.id}:${model.id}`
                    const expanded = expandedModelKey === modelKey
                    const catalogModel = provider.catalogModels.find((candidate) => candidate.id === model.id)
                    return (
                      <div className="provider-model-item" key={model.id}>
                        <div className="provider-model-row">
                          <button
                            className="provider-model-disclosure"
                            type="button"
                            aria-expanded={expanded}
                            onClick={() => setExpandedModelKey(expanded ? null : modelKey)}
                          >
                            <span className="provider-model-name">
                              <strong>{model.name ?? model.id}</strong>
                              {model.name === null || model.name === model.id ? null : <code>{model.id}</code>}
                            </span>
                            <span className="provider-model-chevron" aria-hidden="true">›</span>
                          </button>
                          <button
                            className="provider-model-test"
                            type="button"
                            disabled={controlsDisabled}
                            onClick={() => handleTest(provider.id, model.id)}
                          >
                            {action === `test:${provider.id}:${model.id}` ? '测试中…' : '测试'}
                          </button>
                        </div>
                        {expanded ? (
                          <>
                            <div className="provider-model-info-block">
                              <div className="provider-model-info-heading">已保存配置</div>
                              <dl className="provider-model-details">
                                <div>
                                  <dt>上下文窗口</dt>
                                  <dd>{model.contextWindow === null ? '未配置' : model.contextWindow.toLocaleString()}</dd>
                                </div>
                                <div>
                                  <dt>最大输出</dt>
                                  <dd>{model.maxTokens === null ? '未配置' : model.maxTokens.toLocaleString()}</dd>
                                </div>
                                <div>
                                  <dt>推理</dt>
                                  <dd>{model.reasoning === null ? '未配置' : model.reasoning ? '支持' : '不支持'}</dd>
                                </div>
                                <div>
                                  <dt>输入</dt>
                                  <dd>{model.input === null ? '未配置' : model.input.includes('image') ? '文本、图片' : '文本'}</dd>
                                </div>
                              </dl>
                            </div>
                            {catalogModel === undefined ? null : (
                              <div className="provider-model-info-block provider-model-catalog">
                                <div className="provider-model-info-heading">
                                  <span>Provider 目录信息</span>
                                  <small>自动发现，仅供参考</small>
                                </div>
                                <dl className="provider-model-details">
                                  <div>
                                    <dt>目录名称</dt>
                                    <dd>{catalogModel.name ?? '未提供'}</dd>
                                  </div>
                                  <div>
                                    <dt>上下文窗口</dt>
                                    <dd>{catalogModel.contextWindow === null ? '未提供' : catalogModel.contextWindow.toLocaleString()}</dd>
                                  </div>
                                  <div>
                                    <dt>最大输出</dt>
                                    <dd>{catalogModel.maxTokens === null ? '未提供' : catalogModel.maxTokens.toLocaleString()}</dd>
                                  </div>
                                  <div>
                                    <dt>推理 / 输入</dt>
                                    <dd>{catalogCapabilityLabel(catalogModel)}</dd>
                                  </div>
                                </dl>
                              </div>
                            )}
                          </>
                        ) : null}
                      </div>
                    )
                  })}
                </div>
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}

function ProviderForm({
  draft,
  disabled,
  mode,
  onChange,
  onCancel,
  onSubmit
}: {
  draft: ProviderDraft
  disabled: boolean
  mode: 'create' | 'edit'
  onChange: (draft: ProviderDraft) => void
  onCancel: () => void
  onSubmit: (mode: FormSubmitMode) => void
}): React.JSX.Element {
  function updateModel(index: number, patch: Partial<ModelDraft>): void {
    onChange({
      ...draft,
      models: draft.models.map((model, modelIndex) => modelIndex === index ? { ...model, ...patch } : model)
    })
  }

  return (
    <form
      className="settings-card settings-card-stacked provider-form"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit('save')
      }}
    >
      <h3>{mode === 'create' ? '新增 Provider' : `编辑 ${draft.originalId}`}</h3>
      <div className="provider-form-grid">
        <label>
          <span>Provider ID</span>
          <input
            value={draft.id}
            autoComplete="off"
            disabled={disabled}
            placeholder="例如 my-provider"
            onChange={(event) => onChange({ ...draft, id: event.currentTarget.value })}
          />
        </label>
        <label>
          <span>Base URL</span>
          <input
            type="url"
            value={draft.baseUrl}
            autoComplete="url"
            disabled={disabled}
            placeholder="https://api.example.com/v1"
            onChange={(event) => onChange({ ...draft, baseUrl: event.currentTarget.value })}
          />
        </label>
        <label>
          <span>API 类型</span>
          <Select
            id="provider-api-type"
            value={draft.api}
            groups={API_OPTIONS}
            disabled={disabled}
            onValueChange={(value) => {
              if (isProviderApi(value)) onChange({ ...draft, api: value })
            }}
          />
        </label>
        <label>
          <span>API Key 或凭据引用</span>
          <input
            type="password"
            value={draft.apiKey}
            autoComplete="new-password"
            disabled={disabled || draft.removeApiKey}
            placeholder={mode === 'edit' ? '留空保留现有凭据' : 'API Key、$ENV_VAR 或 !command'}
            onChange={(event) => onChange({
              ...draft,
              apiKey: event.currentTarget.value,
              removeApiKey: false
            })}
          />
        </label>
      </div>
      {mode === 'edit' && draft.apiKeyConfigured ? (
        <label className="provider-checkbox">
          <input
            type="checkbox"
            checked={draft.removeApiKey}
            disabled={disabled}
            onChange={(event) => onChange({
              ...draft,
              apiKey: '',
              removeApiKey: event.currentTarget.checked
            })}
          />
          <span>移除已保存的 API Key 或凭据引用</span>
        </label>
      ) : null}
      <label className="provider-checkbox">
        <input
          type="checkbox"
          checked={draft.authHeader}
          disabled={disabled}
          onChange={(event) => onChange({ ...draft, authHeader: event.currentTarget.checked })}
        />
        <span>通过 Authorization Header 发送上方凭据（仅改变发送方式）</span>
      </label>

      <div className="provider-model-editor-heading">
        <h4>模型</h4>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange({ ...draft, models: [...draft.models, emptyModelDraft()] })}
        >
          添加模型
        </button>
      </div>
      <div className="provider-model-editors">
        {draft.models.map((model, index) => (
          <fieldset className="provider-model-editor" disabled={disabled} key={index}>
            <div className="provider-model-editor-title">
              <legend>模型 {index + 1}</legend>
              <button
                type="button"
                disabled={disabled || draft.models.length === 1}
                onClick={() => onChange({ ...draft, models: draft.models.filter((_, modelIndex) => modelIndex !== index) })}
              >
                删除模型
              </button>
            </div>
            <div className="provider-form-grid provider-model-fields">
              <label>
                <span>ID</span>
                <input value={model.id} onChange={(event) => updateModel(index, { id: event.currentTarget.value })} />
              </label>
              <label>
                <span>名称</span>
                <input value={model.name} onChange={(event) => updateModel(index, { name: event.currentTarget.value })} />
              </label>
              <label>
                <span>Context Window</span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={model.contextWindow}
                  onChange={(event) => updateModel(index, { contextWindow: event.currentTarget.value })}
                />
              </label>
              <label>
                <span>Max Tokens</span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={model.maxTokens}
                  onChange={(event) => updateModel(index, { maxTokens: event.currentTarget.value })}
                />
              </label>
            </div>
            <div className="provider-model-flags">
              <label className="provider-model-option">
                <span>Reasoning</span>
                <Select
                  id={`provider-model-${index}-reasoning`}
                  value={model.reasoning}
                  groups={MODEL_CAPABILITY_OPTIONS}
                  disabled={disabled}
                  onValueChange={(value) => {
                    if (isModelCapabilityDraft(value)) updateModel(index, { reasoning: value })
                  }}
                />
              </label>
              <label className="provider-model-option">
                <span>Image input</span>
                <Select
                  id={`provider-model-${index}-image-input`}
                  value={model.imageInput}
                  groups={MODEL_CAPABILITY_OPTIONS}
                  disabled={disabled}
                  onValueChange={(value) => {
                    if (isModelCapabilityDraft(value)) updateModel(index, { imageInput: value })
                  }}
                />
              </label>
            </div>
          </fieldset>
        ))}
      </div>

      <div className="provider-form-actions">
        <button type="button" disabled={disabled} onClick={onCancel}>取消</button>
        <button type="submit" disabled={disabled}>保存</button>
        <button type="button" disabled={disabled} onClick={() => onSubmit('save-and-test')}>
          保存并测试第一个模型
        </button>
      </div>
    </form>
  )
}

function emptyProviderDraft(): ProviderDraft {
  return {
    originalId: null,
    id: '',
    baseUrl: '',
    api: KERNEL_PROVIDER_APIS[0],
    apiKey: '',
    apiKeyConfigured: false,
    removeApiKey: false,
    authHeader: false,
    models: [emptyModelDraft()]
  }
}

function emptyModelDraft(): ModelDraft {
  return {
    id: '',
    name: '',
    contextWindow: '',
    maxTokens: '',
    reasoning: 'unset',
    imageInput: 'unset'
  }
}

function providerDraft(provider: KernelProviderConfig): ProviderDraft {
  return {
    originalId: provider.id,
    id: provider.id,
    baseUrl: provider.baseUrl,
    api: provider.api,
    apiKey: '',
    apiKeyConfigured: provider.apiKeyConfigured,
    removeApiKey: false,
    authHeader: provider.authHeader,
    models: provider.models.map((model) => ({
      id: model.id,
      name: model.name ?? '',
      contextWindow: model.contextWindow === null ? '' : String(model.contextWindow),
      maxTokens: model.maxTokens === null ? '' : String(model.maxTokens),
      reasoning: model.reasoning === null ? 'unset' : model.reasoning ? 'supported' : 'unsupported',
      imageInput: model.input === null ? 'unset' : model.input.includes('image') ? 'supported' : 'unsupported'
    }))
  }
}

function providerInput(draft: ProviderDraft): KernelProviderInput {
  if (!PROVIDER_ID_PATTERN.test(draft.id) || RESERVED_PROVIDER_IDS.has(draft.id)) {
    throw new Error('Provider ID 只能包含字母、数字、点、下划线和连字符，并须以字母或数字开头。')
  }
  if (!isHttpUrl(draft.baseUrl)) {
    throw new Error('Base URL 必须是有效的 HTTP 或 HTTPS URL，且不能包含首尾空格。')
  }
  if (draft.models.length === 0) throw new Error('Provider 至少需要一个模型。')

  const ids = new Set<string>()
  const models: KernelProviderModelConfig[] = draft.models.map((model, index) => {
    if (model.id.length === 0 || model.id.trim() !== model.id || /[\0\r\n]/u.test(model.id)) {
      throw new Error(`模型 ${index + 1} 的 ID 不能为空或包含首尾空格。`)
    }
    if (ids.has(model.id)) throw new Error(`模型 ID 重复：${model.id}`)
    ids.add(model.id)
    const contextWindow = optionalPositiveInteger(model.contextWindow, 'Context Window', model.id)
    const maxTokens = optionalPositiveInteger(model.maxTokens, 'Max Tokens', model.id)
    return {
      id: model.id,
      name: model.name.trim().length === 0 ? null : model.name,
      reasoning: capabilityBoolean(model.reasoning),
      input: model.imageInput === 'unset'
        ? null
        : model.imageInput === 'supported'
          ? ['text', 'image']
          : ['text'],
      contextWindow,
      maxTokens
    }
  })

  return {
    originalId: draft.originalId,
    id: draft.id,
    baseUrl: draft.baseUrl,
    api: draft.api,
    apiKey: draft.apiKey.length === 0 ? null : draft.apiKey,
    removeApiKey: draft.removeApiKey,
    authHeader: draft.authHeader,
    models
  }
}

function optionalPositiveInteger(value: string, label: string, modelId: string): number | null {
  if (value.length === 0) return null
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`模型 ${modelId} 的 ${label} 必须是正整数。`)
  }
  return number
}

function capabilityBoolean(value: ModelCapabilityDraft): boolean | null {
  if (value === 'unset') return null
  return value === 'supported'
}

function isModelCapabilityDraft(value: string): value is ModelCapabilityDraft {
  return value === 'unset' || value === 'supported' || value === 'unsupported'
}

function catalogCapabilityLabel(model: KernelProviderCatalogModel): string {
  const reasoning = model.reasoning === null ? '推理未提供' : model.reasoning ? '支持推理' : '不支持推理'
  const input = model.input === null
    ? '输入未提供'
    : model.input.includes('image') ? '文本、图片' : '文本'
  return `${reasoning} · ${input}`
}

function isHttpUrl(value: string): boolean {
  if (value.trim() !== value) return false
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0
  } catch {
    return false
  }
}

function isProviderApi(value: string): value is KernelProviderApi {
  return (KERNEL_PROVIDER_APIS as readonly string[]).includes(value)
}

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message.length > 0 ? reason.message : fallback
}

function testSuccessMessage(result: KernelProviderTestResult, afterSave: boolean): string {
  const prefix = afterSave ? 'Provider 已保存，连接测试成功' : '连接测试成功'
  return `${prefix}：${result.provider}/${result.modelId}（${result.durationMs} ms）。`
}
