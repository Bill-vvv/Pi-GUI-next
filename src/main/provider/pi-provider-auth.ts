import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'

import type {
  KernelProviderAuthEvent,
  KernelProviderAuthType,
  KernelProviderCredential
} from '../../shared/kernel-contract.ts'
import { resolvePiAgentDir } from '../extension/pi-extension-store.ts'
import { importVerifiedPiPackageRoot } from '../runtime/pi-package-root.ts'

type RuntimeProvider = {
  id: string
  name: string
  auth: {
    apiKey?: { name: string, login?: unknown }
    oauth?: { name: string, loginLabel?: string, login: unknown }
  }
}

type RuntimeAuthStatus = {
  configured: boolean
  source?: unknown
}

type RuntimeCredentialInfo = {
  providerId: string
  type: string
}

type RuntimeAuthInteraction = {
  signal: AbortSignal
  prompt: (prompt: unknown) => Promise<string>
  notify: (event: unknown) => void
}

type PublicPrompt = Extract<
  KernelProviderAuthEvent,
  { type: 'provider-auth.prompt' }
>['prompt']

type ModelRuntime = {
  getProviders: () => readonly RuntimeProvider[]
  getProviderAuthStatus: (providerId: string) => RuntimeAuthStatus
  listCredentials: () => Promise<readonly RuntimeCredentialInfo[]>
  login: (
    providerId: string,
    authType: KernelProviderAuthType,
    interaction: RuntimeAuthInteraction
  ) => Promise<unknown>
  logout: (providerId: string) => Promise<void>
}

type ModelRuntimeConstructor = {
  create: (options: {
    authPath: string
    modelsPath: string
    modelsStorePath: string
    allowModelNetwork: false
  }) => Promise<ModelRuntime>
}

export type PiProviderAuthOptions = {
  agentDir?: string
  cwd?: string
  explicitExecutable?: string
  path?: string
  rootExports?: Record<string, unknown>
}

type PromptResolution = {
  operationId: string
  promptId: string
  type: 'text' | 'secret' | 'select' | 'manual_code'
  optionIds: ReadonlySet<string> | null
  resolve: (value: string) => void
  reject: (error: Error) => void
  cleanup: () => void
}

type LoginOperation = {
  id: string
  providerId: string
  controller: AbortController
  pending: PromptResolution | null
  redactions: Set<string>
  done: Promise<void>
}

const AUTH_SOURCES = new Set([
  'stored',
  'runtime',
  'environment',
  'fallback',
  'models_json_key',
  'models_json_command'
])
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,254}[A-Za-z0-9])?$/
const MAX_VALUE_LENGTH = 65_536
const MAX_TEXT_LENGTH = 4_096
const MAX_SHORT_TEXT_LENGTH = 512
const MAX_OPTIONS = 100
const MAX_LINKS = 32

class LoginCancelled extends Error {}

export class PiProviderAuth {
  readonly #options: PiProviderAuthOptions
  readonly #listeners = new Set<(event: KernelProviderAuthEvent) => void>()
  #runtime: Promise<ModelRuntime> | null = null
  #active: LoginOperation | null = null
  #shutDown = false

  constructor(options: PiProviderAuthOptions = {}) {
    this.#options = options
  }

  subscribe(listener: (event: KernelProviderAuthEvent) => void): () => void {
    if (typeof listener !== 'function') {
      throw new TypeError('Provider auth listener must be a function.')
    }
    this.#assertRunning()
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  async list(): Promise<KernelProviderCredential[]> {
    this.#assertRunning()
    try {
      const runtime = await this.#getRuntime()
      const providers = runtime.getProviders()
      const stored = await runtime.listCredentials()
      const storedTypes = new Map<string, KernelProviderAuthType>()

      for (const info of stored) {
        if (
          isRecord(info) &&
          typeof info.providerId === 'string' &&
          (info.type === 'api_key' || info.type === 'oauth')
        ) {
          storedTypes.set(info.providerId, info.type)
        }
      }

      return providers.flatMap((provider) => {
        if (!isRuntimeProvider(provider)) return []
        const status = runtime.getProviderAuthStatus(provider.id)
        const source = AUTH_SOURCES.has(String(status?.source))
          ? status.source as KernelProviderCredential['source']
          : null
        const methods: KernelProviderCredential['methods'] = []
        if (provider.auth.apiKey && typeof provider.auth.apiKey.login === 'function') {
          methods.push({
            type: 'api_key',
            name: cleanText(provider.auth.apiKey.name, MAX_SHORT_TEXT_LENGTH),
            label: null
          })
        }
        if (provider.auth.oauth && typeof provider.auth.oauth.login === 'function') {
          methods.push({
            type: 'oauth',
            name: cleanText(provider.auth.oauth.name, MAX_SHORT_TEXT_LENGTH),
            label: optionalCleanText(provider.auth.oauth.loginLabel, MAX_SHORT_TEXT_LENGTH)
          })
        }
        return [{
          providerId: provider.id,
          providerName: cleanText(provider.name, MAX_SHORT_TEXT_LENGTH),
          configured: status?.configured === true,
          source,
          storedCredentialType: storedTypes.get(provider.id) ?? null,
          methods
        }]
      })
    } catch {
      throw new Error('Provider credential listing failed.')
    }
  }

  login(
    providerId: string,
    authType: KernelProviderAuthType
  ): Promise<KernelProviderCredential[]> {
    this.#assertRunning()
    validateProviderId(providerId)
    validateAuthType(authType)
    if (this.#active) {
      throw new Error('Provider login is already in progress.')
    }

    const operation: LoginOperation = {
      id: randomUUID(),
      providerId,
      controller: new AbortController(),
      pending: null,
      redactions: new Set(),
      done: Promise.resolve()
    }
    this.#active = operation
    this.#emit({
      type: 'provider-auth.started',
      operationId: operation.id,
      providerId,
      authType
    })
    const result = this.#runLogin(operation, authType)
    operation.done = result.then(() => undefined, () => undefined)
    return result
  }

  async submitPrompt(operationId: string, promptId: string, value: string): Promise<void> {
    validateUuid(operationId, 'operation')
    validateUuid(promptId, 'prompt')
    validatePromptValue(value)
    const operation = this.#active
    const pending = operation?.pending
    if (
      !operation ||
      operation.id !== operationId ||
      !pending ||
      pending.operationId !== operationId ||
      pending.promptId !== promptId
    ) {
      throw new Error('Provider login prompt is no longer active.')
    }
    if (pending.optionIds && !pending.optionIds.has(value)) {
      throw new Error('Provider login selection is invalid.')
    }

    operation.pending = null
    pending.cleanup()
    if (value.length > 0) operation.redactions.add(value)
    pending.resolve(value)
  }

  async cancel(operationId: string): Promise<void> {
    validateUuid(operationId, 'operation')
    const operation = this.#active
    if (!operation || operation.id !== operationId) {
      throw new Error('Provider login operation is no longer active.')
    }
    this.#abortOperation(operation)
  }

  async logout(providerId: string): Promise<KernelProviderCredential[]> {
    this.#assertRunning()
    validateProviderId(providerId)
    if (this.#active) throw new Error('Provider login is already in progress.')
    try {
      const runtime = await this.#getRuntime()
      await runtime.logout(providerId)
      return await this.list()
    } catch {
      throw new Error('Provider logout failed.')
    }
  }

  async shutdown(): Promise<void> {
    if (this.#shutDown) return
    this.#shutDown = true
    const operation = this.#active
    if (operation) {
      this.#abortOperation(operation)
      await operation.done
    }
    this.#listeners.clear()
  }

  async #runLogin(
    operation: LoginOperation,
    authType: KernelProviderAuthType
  ): Promise<KernelProviderCredential[]> {
    try {
      const runtime = await this.#getRuntime()
      if (operation.controller.signal.aborted) throw new LoginCancelled()
      const provider = runtime.getProviders().find((candidate) =>
        isRuntimeProvider(candidate) && candidate.id === operation.providerId
      )
      if (!provider || !supportsLogin(provider, authType)) {
        throw new Error('Unsupported provider login.')
      }
      if (operation.controller.signal.aborted) throw new LoginCancelled()
      await runtime.login(operation.providerId, authType, {
        signal: operation.controller.signal,
        prompt: (prompt) => this.#requestPrompt(operation, prompt),
        notify: (event) => this.#notify(operation, event)
      })
      if (operation.controller.signal.aborted) throw new LoginCancelled()
      return await this.list()
    } catch (error) {
      if (error instanceof LoginCancelled || operation.controller.signal.aborted) {
        throw new Error('Provider login cancelled.')
      }
      throw new Error('Provider login failed.')
    } finally {
      if (operation.pending) {
        const pending = operation.pending
        operation.pending = null
        pending.cleanup()
        pending.reject(new LoginCancelled())
      }
      operation.redactions.clear()
      if (this.#active === operation) this.#active = null
    }
  }

  #requestPrompt(operation: LoginOperation, value: unknown): Promise<string> {
    if (this.#active !== operation || operation.controller.signal.aborted) {
      return Promise.reject(new LoginCancelled())
    }
    if (operation.pending) {
      return Promise.reject(new Error('Only one provider login prompt may be active.'))
    }

    const parsed = parsePrompt(value, operation.redactions)
    const promptId = randomUUID()
    return new Promise<string>((resolvePrompt, rejectPrompt) => {
      let settled = false
      const settle = (callback: () => void) => {
        if (settled) return
        settled = true
        callback()
      }
      const abort = () => {
        if (operation.pending?.promptId === promptId) operation.pending = null
        settle(() => rejectPrompt(new LoginCancelled()))
      }
      const signals = [operation.controller.signal, parsed.signal].filter(
        (signal): signal is AbortSignal => signal instanceof AbortSignal
      )
      const cleanup = () => {
        for (const signal of signals) signal.removeEventListener('abort', abort)
      }
      const pending: PromptResolution = {
        operationId: operation.id,
        promptId,
        type: parsed.prompt.type,
        optionIds: parsed.optionIds,
        resolve: (submitted) => settle(() => resolvePrompt(submitted)),
        reject: (error) => settle(() => rejectPrompt(error)),
        cleanup
      }
      operation.pending = pending
      for (const signal of signals) {
        if (signal.aborted) {
          operation.pending = null
          cleanup()
          rejectPrompt(new LoginCancelled())
          return
        }
        signal.addEventListener('abort', abort, { once: true })
      }
      this.#emit({
        type: 'provider-auth.prompt',
        operationId: operation.id,
        promptId,
        providerId: operation.providerId,
        prompt: parsed.prompt
      })
    })
  }

  #notify(operation: LoginOperation, value: unknown): void {
    if (this.#active !== operation || operation.controller.signal.aborted) return
    const notice = parseNotice(value, operation.redactions)
    if (!notice) return
    this.#emit({
      type: 'provider-auth.notice',
      operationId: operation.id,
      providerId: operation.providerId,
      notice
    })
  }

  #abortOperation(operation: LoginOperation): void {
    operation.controller.abort()
    const pending = operation.pending
    if (pending) {
      operation.pending = null
      pending.cleanup()
      pending.reject(new LoginCancelled())
    }
  }

  #emit(event: KernelProviderAuthEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event)
      } catch {
        // Listener failures cannot affect credential storage or login state.
      }
    }
  }

  #assertRunning(): void {
    if (this.#shutDown) {
      throw new Error('Provider auth service is shut down.')
    }
  }

  #getRuntime(): Promise<ModelRuntime> {
    if (!this.#runtime) this.#runtime = this.#createRuntime()
    return this.#runtime
  }

  async #createRuntime(): Promise<ModelRuntime> {
    const cwd = this.#options.cwd ?? process.cwd()
    const root = this.#options.rootExports ?? await importVerifiedPiPackageRoot(cwd, {
      explicitExecutable: this.#options.explicitExecutable,
      path: this.#options.path
    })
    const candidate = root.ModelRuntime
    if (
      (typeof candidate !== 'function' && !isRecord(candidate)) ||
      typeof (candidate as unknown as ModelRuntimeConstructor).create !== 'function'
    ) {
      throw new Error('Pi package root does not export ModelRuntime.')
    }
    const agentDir = resolve(this.#options.agentDir ?? resolvePiAgentDir())
    const runtime = await (candidate as unknown as ModelRuntimeConstructor).create({
      authPath: resolve(agentDir, 'auth.json'),
      modelsPath: resolve(agentDir, 'models.json'),
      modelsStorePath: resolve(agentDir, 'models-cache.json'),
      allowModelNetwork: false
    })
    if (!isModelRuntime(runtime)) {
      throw new Error('Pi ModelRuntime export is invalid.')
    }
    return runtime
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRuntimeProvider(value: unknown): value is RuntimeProvider {
  return isRecord(value) &&
    typeof value.id === 'string' &&
    PROVIDER_ID_PATTERN.test(value.id) &&
    typeof value.name === 'string' &&
    isRecord(value.auth)
}

function isModelRuntime(value: unknown): value is ModelRuntime {
  return isRecord(value) &&
    typeof value.getProviders === 'function' &&
    typeof value.getProviderAuthStatus === 'function' &&
    typeof value.listCredentials === 'function' &&
    typeof value.login === 'function' &&
    typeof value.logout === 'function'
}

function supportsLogin(provider: RuntimeProvider, type: KernelProviderAuthType): boolean {
  if (type === 'api_key') return typeof provider.auth.apiKey?.login === 'function'
  return typeof provider.auth.oauth?.login === 'function'
}

function validateProviderId(value: string): void {
  if (typeof value !== 'string' || !PROVIDER_ID_PATTERN.test(value)) {
    throw new TypeError('Provider id is invalid.')
  }
}

function validateAuthType(value: KernelProviderAuthType): void {
  if (value !== 'api_key' && value !== 'oauth') {
    throw new TypeError('Provider auth type is invalid.')
  }
}

function validateUuid(value: string, kind: 'operation' | 'prompt'): void {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new TypeError(`Provider login ${kind} id is invalid.`)
  }
}

function validatePromptValue(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length > MAX_VALUE_LENGTH ||
    value.includes('\0')
  ) {
    throw new TypeError('Provider login prompt value is invalid.')
  }
}

function cleanText(value: unknown, limit: number, redactions: ReadonlySet<string> = new Set()): string {
  let result = typeof value === 'string' ? value : ''
  for (const secret of redactions) {
    if (secret) result = result.split(secret).join('[REDACTED]')
  }
  return result
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .slice(0, limit)
}

function optionalCleanText(
  value: unknown,
  limit: number,
  redactions: ReadonlySet<string> = new Set()
): string | null {
  return typeof value === 'string' ? cleanText(value, limit, redactions) : null
}

function safeUrl(value: unknown, redactions: ReadonlySet<string>): string | null {
  if (typeof value !== 'string' || value.length > MAX_TEXT_LENGTH) return null
  for (const secret of redactions) {
    if (
      secret &&
      (value.includes(secret) || value.includes(encodeURIComponent(secret)))
    ) return null
  }
  try {
    const url = new URL(value)
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username ||
      url.password
    ) return null
    return url.href
  } catch {
    return null
  }
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null
}

function parsePrompt(
  value: unknown,
  redactions: ReadonlySet<string>
): {
  prompt: PublicPrompt
  signal?: AbortSignal
  optionIds: ReadonlySet<string> | null
} {
  if (!isRecord(value)) throw new Error('Invalid provider login prompt.')
  const signal = value.signal instanceof AbortSignal ? value.signal : undefined
  const message = cleanText(value.message, MAX_TEXT_LENGTH, redactions)
  if (value.type === 'select') {
    if (!Array.isArray(value.options) || value.options.length > MAX_OPTIONS) {
      throw new Error('Invalid provider login prompt.')
    }
    const ids = new Set<string>()
    const options = value.options.map((option) => {
      if (
        !isRecord(option) ||
        typeof option.id !== 'string' ||
        option.id.length === 0 ||
        option.id.length > MAX_SHORT_TEXT_LENGTH ||
        option.id.includes('\0') ||
        ids.has(option.id)
      ) {
        throw new Error('Invalid provider login prompt.')
      }
      ids.add(option.id)
      return {
        id: option.id,
        label: cleanText(option.label, MAX_SHORT_TEXT_LENGTH, redactions),
        description: optionalCleanText(option.description, MAX_TEXT_LENGTH, redactions)
      }
    })
    return {
      prompt: { type: 'select', message, options },
      signal,
      optionIds: ids
    }
  }
  if (value.type === 'text' || value.type === 'secret' || value.type === 'manual_code') {
    return {
      prompt: {
        type: value.type,
        message,
        placeholder: optionalCleanText(value.placeholder, MAX_SHORT_TEXT_LENGTH, redactions)
      },
      signal,
      optionIds: null
    }
  }
  throw new Error('Invalid provider login prompt.')
}

function parseNotice(
  value: unknown,
  redactions: ReadonlySet<string>
): Extract<KernelProviderAuthEvent, { type: 'provider-auth.notice' }>['notice'] | null {
  if (!isRecord(value)) return null
  if (value.type === 'info') {
    const links = Array.isArray(value.links)
      ? value.links.slice(0, MAX_LINKS).flatMap((link) => {
        if (!isRecord(link)) return []
        const url = safeUrl(link.url, redactions)
        return url
          ? [{ url, label: optionalCleanText(link.label, MAX_SHORT_TEXT_LENGTH, redactions) }]
          : []
      })
      : []
    return {
      type: 'info',
      message: cleanText(value.message, MAX_TEXT_LENGTH, redactions),
      links
    }
  }
  if (value.type === 'auth_url') {
    const url = safeUrl(value.url, redactions)
    return url ? {
      type: 'auth_url',
      url,
      instructions: optionalCleanText(value.instructions, MAX_TEXT_LENGTH, redactions)
    } : null
  }
  if (value.type === 'device_code') {
    const verificationUri = safeUrl(value.verificationUri, redactions)
    if (!verificationUri) return null
    return {
      type: 'device_code',
      userCode: cleanText(value.userCode, MAX_SHORT_TEXT_LENGTH, redactions),
      verificationUri,
      intervalSeconds: finiteNonNegative(value.intervalSeconds),
      expiresInSeconds: finiteNonNegative(value.expiresInSeconds)
    }
  }
  if (value.type === 'progress') {
    return {
      type: 'progress',
      message: cleanText(value.message, MAX_TEXT_LENGTH, redactions)
    }
  }
  return null
}
