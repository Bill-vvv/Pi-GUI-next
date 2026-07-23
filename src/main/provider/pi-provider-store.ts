import { randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { lock } from 'proper-lockfile'

import {
  KERNEL_PROVIDER_APIS,
  type KernelProviderApi,
  type KernelProviderCatalogModel,
  type KernelProviderConfig,
  type KernelProviderInput,
  type KernelProviderModelConfig
} from '../../shared/kernel-contract.ts'
import { resolvePiAgentDir } from '../extension/pi-extension-store.ts'
import { SUPPORTED_PI_VERSION } from '../runtime/pi-executable.ts'

type JsonObject = Record<string, unknown>

const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const RESERVED_PROPERTY_NAMES = new Set(['__proto__', 'constructor', 'prototype'])
const CATALOG_TIMEOUT_MS = 10_000

export class PiProviderStore {
  private readonly modelsPath: string
  private readonly authPath: string

  constructor(agentDir = resolvePiAgentDir()) {
    this.modelsPath = join(agentDir, 'models.json')
    this.authPath = join(agentDir, 'auth.json')
  }

  async list(): Promise<KernelProviderConfig[]> {
    const providers = await this.withModelsLock((root) => Promise.resolve(describeProviders(readProviders(root))))
    return hydrateProviderCatalogs(providers, this.authPath)
  }

  async save(provider: KernelProviderInput): Promise<KernelProviderConfig[]> {
    const input = validateProviderInput(provider)

    const providers = await this.withModelsLock(async (root) => {
      const providers = readProviders(root)
      const originalId = input.originalId
      const existing = originalId === null ? undefined : providers[originalId]

      if (originalId !== null && !isRecord(existing)) {
        throw new Error('要编辑的 Provider 不存在。')
      }
      if (input.id !== originalId && Object.hasOwn(providers, input.id)) {
        throw new Error('已存在同名 Provider，不能覆盖。')
      }

      const nextProvider: JsonObject = isRecord(existing) ? { ...existing } : {}
      nextProvider.baseUrl = input.baseUrl
      nextProvider.api = input.api
      nextProvider.authHeader = input.authHeader
      nextProvider.models = mergeModels(isRecord(existing) ? existing.models : undefined, input.models)

      if (input.removeApiKey) {
        delete nextProvider.apiKey
      } else if (input.apiKey !== null) {
        nextProvider.apiKey = input.apiKey
      } else if (originalId === null) {
        delete nextProvider.apiKey
      }

      const nextProviders: JsonObject = { ...providers }
      if (originalId !== null && originalId !== input.id) delete nextProviders[originalId]
      nextProviders[input.id] = nextProvider
      root.providers = nextProviders
      await writeModelsFile(this.modelsPath, root)
      return describeProviders(nextProviders)
    })
    return hydrateProviderCatalogs(providers, this.authPath)
  }

  async remove(providerId: string): Promise<KernelProviderConfig[]> {
    const id = validateProviderId(providerId)

    const providers = await this.withModelsLock(async (root) => {
      const providers = readProviders(root)
      if (!Object.hasOwn(providers, id)) return describeProviders(providers)

      const nextProviders: JsonObject = { ...providers }
      delete nextProviders[id]
      root.providers = nextProviders
      await writeModelsFile(this.modelsPath, root)
      return describeProviders(nextProviders)
    })
    return hydrateProviderCatalogs(providers, this.authPath)
  }

  private async withModelsLock<T>(operation: (root: JsonObject) => Promise<T>): Promise<T> {
    await mkdir(dirname(this.modelsPath), { recursive: true, mode: 0o700 })
    const release = await lock(this.modelsPath, {
      realpath: false,
      retries: {
        retries: 9,
        factor: 1,
        minTimeout: 20,
        maxTimeout: 20
      }
    })

    try {
      return await operation(await readModelsFile(this.modelsPath))
    } finally {
      await release()
    }
  }
}

function validateProviderInput(provider: KernelProviderInput): KernelProviderInput {
  if (!isRecord(provider)) throw new Error('Provider 配置无效。')
  const id = validateProviderId(provider.id)
  const originalId = provider.originalId === null ? null : validateProviderId(provider.originalId)
  const baseUrl = validateBaseUrl(provider.baseUrl)
  const api = validateApi(provider.api)
  if (provider.apiKey !== null && typeof provider.apiKey !== 'string') {
    throw new Error('Provider API Key 无效。')
  }
  if (typeof provider.removeApiKey !== 'boolean') throw new Error('Provider removeApiKey 必须是布尔值。')
  if (provider.removeApiKey && provider.apiKey !== null) {
    throw new Error('移除 Provider API Key 时不能同时提供新值。')
  }
  if (typeof provider.authHeader !== 'boolean') throw new Error('Provider authHeader 必须是布尔值。')
  if (!Array.isArray(provider.models) || provider.models.length === 0) {
    throw new Error('Provider 至少需要一个模型。')
  }

  const models = provider.models.map(validateModelInput)
  assertUniqueModelIds(models)
  return {
    originalId,
    id,
    baseUrl,
    api,
    apiKey: provider.apiKey,
    removeApiKey: provider.removeApiKey,
    authHeader: provider.authHeader,
    models
  }
}

function validateProviderId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !PROVIDER_ID_PATTERN.test(value) ||
    RESERVED_PROPERTY_NAMES.has(value)
  ) {
    throw new Error('Provider ID 只能包含字母、数字、点、下划线和连字符，并须以字母或数字开头。')
  }
  return value
}

function validateBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim() !== value) throw new Error('Provider baseUrl 无效。')
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('Provider baseUrl 必须是有效的 HTTP 或 HTTPS URL。')
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.hostname.length === 0) {
    throw new Error('Provider baseUrl 必须是有效的 HTTP 或 HTTPS URL。')
  }
  return value
}

function validateApi(value: unknown): KernelProviderApi {
  if (typeof value !== 'string' || !(KERNEL_PROVIDER_APIS as readonly string[]).includes(value)) {
    throw new Error('Provider API 类型不受支持。')
  }
  return value as KernelProviderApi
}

function validateModelInput(value: unknown): KernelProviderModelConfig {
  if (!isRecord(value)) throw new Error('Provider 模型配置无效。')
  const id = validateModelId(value.id)
  if (value.name !== null && (typeof value.name !== 'string' || value.name.trim().length === 0)) {
    throw new Error(`模型 ${id} 的名称不能为空。`)
  }
  if (value.reasoning !== null && typeof value.reasoning !== 'boolean') {
    throw new Error(`模型 ${id} 的 reasoning 必须是布尔值。`)
  }
  const input = value.input === null ? null : validateInput(value.input, id)
  const contextWindow = value.contextWindow === null
    ? null
    : validatePositiveInteger(value.contextWindow, 'contextWindow', id)
  const maxTokens = value.maxTokens === null
    ? null
    : validatePositiveInteger(value.maxTokens, 'maxTokens', id)
  return { id, name: value.name, reasoning: value.reasoning, input, contextWindow, maxTokens }
}

function validateModelId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new Error('模型 ID 无效。')
  }
  return value
}

function validateInput(value: unknown, modelId: string): Array<'text' | 'image'> {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 2 ||
    value[0] !== 'text' ||
    (value.length === 2 && value[1] !== 'image')
  ) {
    throw new Error(`模型 ${modelId} 的 input 必须是 ["text"] 或 ["text", "image"]。`)
  }
  return value.length === 1 ? ['text'] : ['text', 'image']
}

function validatePositiveInteger(value: unknown, field: string, modelId: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`模型 ${modelId} 的 ${field} 必须是正整数。`)
  }
  return value
}

function assertUniqueModelIds(models: readonly KernelProviderModelConfig[]): void {
  const ids = new Set<string>()
  for (const model of models) {
    if (ids.has(model.id)) throw new Error(`模型 ID 重复：${model.id}`)
    ids.add(model.id)
  }
}

function mergeModels(existingValue: unknown, models: readonly KernelProviderModelConfig[]): JsonObject[] {
  const existingById = new Map<string, JsonObject>()
  if (Array.isArray(existingValue)) {
    for (const model of existingValue) {
      if (isRecord(model) && typeof model.id === 'string') existingById.set(model.id, model)
    }
  }

  return models.map((model) => {
    const nextModel: JsonObject = { ...existingById.get(model.id), id: model.id }
    setOptionalModelProperty(nextModel, 'name', model.name)
    setOptionalModelProperty(nextModel, 'reasoning', model.reasoning)
    setOptionalModelProperty(nextModel, 'input', model.input === null ? null : [...model.input])
    setOptionalModelProperty(nextModel, 'contextWindow', model.contextWindow)
    setOptionalModelProperty(nextModel, 'maxTokens', model.maxTokens)
    return nextModel
  })
}

function setOptionalModelProperty(model: JsonObject, property: string, value: unknown): void {
  if (value === null) delete model[property]
  else model[property] = value
}

function describeProviders(providers: JsonObject): KernelProviderConfig[] {
  const descriptions: KernelProviderConfig[] = []
  for (const [id, value] of Object.entries(providers)) {
    if (!isRecord(value) || value.models === undefined) continue
    descriptions.push(describeProvider(id, value))
  }
  return descriptions
}

function describeProvider(idValue: string, provider: JsonObject): KernelProviderConfig {
  const id = validateProviderId(idValue)
  const baseUrl = validateBaseUrl(provider.baseUrl)
  const api = validateApi(provider.api)
  if (provider.authHeader !== undefined && typeof provider.authHeader !== 'boolean') {
    throw new Error(`Provider ${id} 的 authHeader 必须是布尔值。`)
  }
  if (!Array.isArray(provider.models) || provider.models.length === 0) {
    throw new Error(`Provider ${id} 至少需要一个模型。`)
  }
  if (provider.apiKey !== undefined && typeof provider.apiKey !== 'string') {
    throw new Error(`Provider ${id} 的 apiKey 必须是字符串。`)
  }

  const models = provider.models.map((model) => describeModel(model, id))
  assertUniqueModelIds(models)
  return {
    id,
    baseUrl,
    api,
    apiKeyConfigured: typeof provider.apiKey === 'string' && provider.apiKey.length > 0,
    authHeader: provider.authHeader ?? false,
    models,
    catalogModels: []
  }
}

async function hydrateProviderCatalogs(
  providers: readonly KernelProviderConfig[],
  authPath: string
): Promise<KernelProviderConfig[]> {
  const credentials = await readProviderCredentials(authPath)
  return Promise.all(providers.map(async (provider) => {
    const credential = credentials.get(provider.id)
    return {
      ...provider,
      apiKeyConfigured: provider.apiKeyConfigured || credential !== undefined,
      catalogModels: await fetchProviderCatalog(provider, credential)
    }
  }))
}

async function readProviderCredentials(path: string): Promise<Map<string, string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!isRecord(parsed)) return new Map()
    const credentials = new Map<string, string>()
    for (const [providerId, value] of Object.entries(parsed)) {
      if (
        isRecord(value) &&
        value.type === 'api_key' &&
        typeof value.key === 'string' &&
        value.key.length > 0
      ) {
        credentials.set(providerId, value.key)
      }
    }
    return credentials
  } catch {
    return new Map()
  }
}

async function fetchProviderCatalog(
  provider: KernelProviderConfig,
  credential: string | undefined
): Promise<KernelProviderCatalogModel[]> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS)
  try {
    const headers = credential === undefined ? undefined : { Authorization: `Bearer ${credential}` }
    const response = await fetch(
      `${provider.baseUrl.replace(/\/+$/u, '')}/models?client_version=${encodeURIComponent(SUPPORTED_PI_VERSION)}`,
      { headers, signal: controller.signal }
    )
    if (!response.ok) return []
    return parseProviderCatalog(
      await response.json(),
      new Set(provider.models.map((model) => model.id))
    )
  } catch {
    return []
  } finally {
    clearTimeout(timeout)
  }
}

function parseProviderCatalog(
  value: unknown,
  configuredModelIds: ReadonlySet<string>
): KernelProviderCatalogModel[] {
  if (!isRecord(value) || !Array.isArray(value.models)) throw new Error('Invalid provider catalog.')
  return value.models
    .filter((model) => (
      isRecord(model) &&
      typeof model.slug === 'string' &&
      configuredModelIds.has(model.slug)
    ))
    .map(parseProviderCatalogModel)
}

function parseProviderCatalogModel(value: unknown): KernelProviderCatalogModel {
  if (!isRecord(value)) throw new Error('Invalid provider catalog model.')
  const id = catalogNonEmptyString(value.slug)
  const name = value.display_name === undefined ? null : catalogNonEmptyString(value.display_name)
  const contextWindow = value.context_window === undefined
    ? null
    : catalogPositiveInteger(value.context_window)
  const input = value.input_modalities === undefined ? null : catalogInput(value.input_modalities)
  const reasoning = catalogReasoning(value.supported_reasoning_levels)
  const maxTokens = value.max_output_tokens === undefined
    ? null
    : catalogPositiveInteger(value.max_output_tokens)
  return { id, name, reasoning, input, contextWindow, maxTokens }
}

function catalogNonEmptyString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error('Invalid provider catalog string.')
  }
  return value
}

function catalogPositiveInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error('Invalid provider catalog integer.')
  }
  return value
}

function catalogInput(value: unknown): Array<'text' | 'image'> {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 2 ||
    value[0] !== 'text' ||
    (value.length === 2 && value[1] !== 'image')
  ) {
    throw new Error('Invalid provider catalog input modalities.')
  }
  return value.length === 1 ? ['text'] : ['text', 'image']
}

function catalogReasoning(value: unknown): boolean | null {
  if (value === undefined) return null
  if (
    !Array.isArray(value) ||
    value.some((level) => (
      typeof level === 'string'
        ? level.length === 0
        : !isRecord(level) || typeof level.effort !== 'string' || level.effort.length === 0
    ))
  ) {
    throw new Error('Invalid provider catalog reasoning levels.')
  }
  return value.length > 0
}

function describeModel(value: unknown, providerId: string): KernelProviderModelConfig {
  if (!isRecord(value)) throw new Error(`Provider ${providerId} 包含无效模型。`)
  const id = validateModelId(value.id)
  const name = value.name === undefined ? null : value.name
  if (name !== null && (typeof name !== 'string' || name.trim().length === 0)) {
    throw new Error(`模型 ${id} 的名称无效。`)
  }
  const reasoning = value.reasoning === undefined ? null : value.reasoning
  if (reasoning !== null && typeof reasoning !== 'boolean') {
    throw new Error(`模型 ${id} 的 reasoning 必须是布尔值。`)
  }
  const input = value.input === undefined ? null : validateInput(value.input, id)
  const contextWindow = value.contextWindow === undefined
    ? null
    : validatePositiveInteger(value.contextWindow, 'contextWindow', id)
  const maxTokens = value.maxTokens === undefined
    ? null
    : validatePositiveInteger(value.maxTokens, 'maxTokens', id)
  return { id, name, reasoning, input: input === null ? null : [...input], contextWindow, maxTokens }
}

function readProviders(root: JsonObject): JsonObject {
  if (root.providers === undefined) return {}
  if (!isRecord(root.providers)) throw new Error('Pi models.json 中的 providers 必须是 JSON 对象。')
  return root.providers
}

async function readModelsFile(path: string): Promise<JsonObject> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if (isMissingPathError(error)) return {}
    throw error
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`Pi 模型文件不是有效的 JSON：${path}`)
  }
  if (!isRecord(parsed)) throw new Error(`Pi 模型文件必须包含 JSON 对象：${path}`)
  return parsed
}

async function writeModelsFile(path: string, root: JsonObject): Promise<void> {
  const temporaryPath = `${path}.tmp-${randomUUID()}`
  try {
    await writeFile(temporaryPath, `${JSON.stringify(root, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await rename(temporaryPath, path)
    await chmod(path, 0o600)
  } finally {
    await unlink(temporaryPath).catch((error: unknown) => {
      if (!isMissingPathError(error)) throw error
    })
  }
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
