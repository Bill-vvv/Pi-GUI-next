import {
  KERNEL_PROVIDER_APIS,
  ADVISOR_TOOL_NAMES,
  type AppearanceSettings,
  type GeneralSettings,
  type KernelCommand,
  type KernelAdvisorDefinitionInput,
  type KernelPromptAttachment,
  type KernelProjectTrustChoice,
  type KernelProviderInput,
  type KernelSubagentDefinitionInput,
  type SessionNamingSettings,
  type SubagentSettings,
  type ThinkingLevel
} from '../../shared/kernel-contract.ts'
import { isShortcutSettings } from '../../shared/shortcut-settings.ts'
import { isRecord } from '../utils/guards.ts'

const MAX_PROMPT_IMAGE_BASE64_CHARS = 4.5 * 1024 * 1024

export function isKernelCommand(value: unknown): value is KernelCommand {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  if (
    value.type === 'kernel.get-state' ||
    value.type === 'kernel.list-system-fonts' ||
    value.type === 'kernel.add-project' ||
    value.type === 'kernel.start-session' ||
    value.type === 'kernel.reload-session' ||
    value.type === 'kernel.list-fork-candidates' ||
    value.type === 'kernel.export-session' ||
    value.type === 'kernel.select-prompt-attachments' ||
    value.type === 'kernel.abort' ||
    value.type === 'kernel.list-providers' ||
    value.type === 'kernel.list-provider-credentials' ||
    value.type === 'kernel.list-pi-packages' ||
    value.type === 'kernel.list-advisor-definitions' ||
    value.type === 'kernel.list-subagent-definitions' ||
    value.type === 'kernel.update-pi-packages'
  ) {
    return Object.keys(value).length === 1
  }
  if (value.type === 'kernel.activate-project') {
    return typeof value.projectKey === 'string' && Object.keys(value).length === 2
  }
  if (value.type === 'kernel.resolve-project-trust') {
    return typeof value.requestId === 'string' &&
      isProjectTrustChoice(value.choice) &&
      Object.keys(value).length === 3
  }
  if (
    value.type === 'kernel.activate-session' ||
    value.type === 'kernel.archive-session' ||
    value.type === 'kernel.preview-session'
  ) {
    return typeof value.sessionKey === 'string' && Object.keys(value).length === 2
  }
  if (
    value.type === 'kernel.undo-archive-session' ||
    value.type === 'kernel.preview-archived-session'
  ) {
    return typeof value.token === 'string' && Object.keys(value).length === 2
  }
  if (value.type === 'kernel.fork-session') {
    return typeof value.entryId === 'string' && Object.keys(value).length === 2
  }
  if (value.type === 'kernel.get-message-image') {
    return typeof value.sessionKey === 'string' &&
      typeof value.messageId === 'string' &&
      value.messageId.length > 0 &&
      value.messageId.length <= 256 &&
      typeof value.attachmentIndex === 'number' &&
      Number.isInteger(value.attachmentIndex) &&
      value.attachmentIndex >= 0 &&
      value.attachmentIndex < 64 &&
      Object.keys(value).length === 4
  }
  if (value.type === 'kernel.get-tool-image') {
    return typeof value.sessionKey === 'string' &&
      typeof value.toolCallId === 'string' &&
      value.toolCallId.length > 0 &&
      value.toolCallId.length <= 256 &&
      typeof value.contentIndex === 'number' &&
      Number.isInteger(value.contentIndex) &&
      value.contentIndex >= 0 &&
      value.contentIndex < 64 &&
      Object.keys(value).length === 4
  }
  if (value.type === 'kernel.search-project-paths') {
    return isProjectPathQuery(value.query) && Object.keys(value).length === 2
  }
  if (value.type === 'kernel.reorder-projects') {
    return isStringArray(value.projectKeys) && Object.keys(value).length === 2
  }
  if (value.type === 'kernel.install-extension') {
    return (value.kind === 'file' || value.kind === 'directory') && Object.keys(value).length === 2
  }
  if (value.type === 'kernel.remove-extension') {
    return typeof value.path === 'string' && Object.keys(value).length === 2
  }
  if (
    value.type === 'kernel.search-pi-dev-extensions' ||
    value.type === 'kernel.search-pi-dev-packages'
  ) {
    return typeof value.query === 'string' && Object.keys(value).length === 2
  }
  if (value.type === 'kernel.install-pi-dev-package') {
    return typeof value.name === 'string' && Object.keys(value).length === 2
  }
  if (value.type === 'kernel.remove-pi-package' || value.type === 'kernel.update-pi-package') {
    return typeof value.source === 'string' && Object.keys(value).length === 2
  }
  if (
    value.type === 'kernel.set-subagent-enabled' ||
    value.type === 'kernel.set-magic-context-enabled' ||
    value.type === 'kernel.set-advisor-system-enabled' ||
    value.type === 'kernel.set-advisor-extension-enabled'
  ) {
    return typeof value.enabled === 'boolean' && Object.keys(value).length === 2
  }
  if (value.type === 'kernel.save-subagent-definition') {
    return isSubagentDefinitionInput(value.definition) && Object.keys(value).length === 2
  }
  if (value.type === 'kernel.save-advisor-definition') {
    return isAdvisorDefinitionInput(value.definition) && Object.keys(value).length === 2
  }
  if (value.type === 'kernel.remove-advisor-definition') {
    return isAdvisorSlug(value.slug) &&
      (value.scope === 'user' || value.scope === 'project') &&
      Object.keys(value).length === 3
  }
  if (value.type === 'kernel.set-subagent-definition-enabled') {
    return isSubagentDefinitionId(value.id) &&
      (value.scope === 'user' || value.scope === 'project') &&
      typeof value.enabled === 'boolean' &&
      Object.keys(value).length === 4
  }
  if (value.type === 'kernel.remove-subagent-definition') {
    return isSubagentDefinitionId(value.id) && Object.keys(value).length === 2
  }
  if (value.type === 'kernel.save-provider') {
    return isProviderInput(value.provider) && Object.keys(value).length === 2
  }
  if (value.type === 'kernel.remove-provider') {
    return typeof value.providerId === 'string' && Object.keys(value).length === 2
  }
  if (value.type === 'kernel.test-provider') {
    return (
      typeof value.providerId === 'string' &&
      typeof value.modelId === 'string' &&
      Object.keys(value).length === 3
    )
  }
  if (value.type === 'kernel.fetch-model-pricing') {
    return (
      isProviderId(value.providerId) &&
      Array.isArray(value.modelIds) &&
      value.modelIds.length > 0 &&
      value.modelIds.length <= 256 &&
      value.modelIds.every(isProviderModelId) &&
      new Set(value.modelIds).size === value.modelIds.length &&
      Object.keys(value).length === 3
    )
  }
  if (value.type === 'kernel.login-provider') {
    return isProviderId(value.providerId) &&
      (value.authType === 'api_key' || value.authType === 'oauth') &&
      Object.keys(value).length === 3
  }
  if (value.type === 'kernel.submit-provider-auth-prompt') {
    return isProviderAuthId(value.operationId) &&
      isProviderAuthId(value.promptId) &&
      typeof value.value === 'string' &&
      value.value.length <= 65_536 &&
      !value.value.includes('\0') &&
      Object.keys(value).length === 4
  }
  if (value.type === 'kernel.cancel-provider-login') {
    return isProviderAuthId(value.operationId) && Object.keys(value).length === 2
  }
  if (value.type === 'kernel.logout-provider') {
    return isProviderId(value.providerId) && Object.keys(value).length === 2
  }
  if (
    value.type === 'kernel.prompt' ||
    value.type === 'kernel.steer' ||
    value.type === 'kernel.follow-up'
  ) {
    return typeof value.message === 'string' &&
      (
        Object.keys(value).length === 2 ||
        (
          Object.keys(value).length === 3 &&
          Array.isArray(value.attachments) &&
          value.attachments.length > 0 &&
          value.attachments.every(isPromptAttachment)
        )
      )
  }
  if (value.type === 'kernel.set-model') {
    return (
      typeof value.provider === 'string' &&
      typeof value.modelId === 'string' &&
      Object.keys(value).length === 3
    )
  }
  if (value.type === 'kernel.invoke-command') {
    return (
      typeof value.commandId === 'string' &&
      typeof value.argument === 'string' &&
      Object.keys(value).length === 3
    )
  }
  if (value.type === 'kernel.set-session-naming') {
    return isSessionNamingSettings(value.settings) && Object.keys(value).length === 2
  }
  if (value.type === 'kernel.set-appearance') {
    return isAppearanceSettings(value.settings) && Object.keys(value).length === 2
  }
  if (value.type === 'kernel.set-general') {
    return isGeneralSettings(value.settings) && Object.keys(value).length === 2
  }
  if (value.type === 'kernel.set-subagent') {
    return isSubagentSettings(value.settings) && Object.keys(value).length === 2
  }
  if (value.type === 'kernel.set-shortcuts') {
    return isShortcutSettings(value.settings) && Object.keys(value).length === 2
  }
  return (
    value.type === 'kernel.set-thinking-level' &&
    isThinkingLevel(value.level) &&
    Object.keys(value).length === 2
  )
}

function isProjectPathQuery(value: unknown): value is string {
  return typeof value === 'string' &&
    Array.from(value).length <= 256 &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
}

function isPromptAttachment(value: unknown): value is KernelPromptAttachment {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  if (value.type === 'file') {
    return Object.keys(value).length === 3 &&
      isNonEmptyString(value.name) &&
      isNonEmptyString(value.path)
  }
  return value.type === 'image' &&
    Object.keys(value).length === 5 &&
    isNonEmptyString(value.name) &&
    isNonEmptyString(value.path) &&
    Array.isArray(value.hints) &&
    value.hints.every((hint) => typeof hint === 'string') &&
    isPromptImage(value.image)
}

function isPromptImage(value: unknown): boolean {
  return isRecord(value) &&
    Object.keys(value).length === 3 &&
    value.type === 'image' &&
    (
      value.mimeType === 'image/jpeg' ||
      value.mimeType === 'image/png' ||
      value.mimeType === 'image/gif' ||
      value.mimeType === 'image/webp'
    ) &&
    typeof value.data === 'string' &&
    value.data.length < MAX_PROMPT_IMAGE_BASE64_CHARS &&
    isBase64(value.data)
}

function isBase64(value: string): boolean {
  return value.length > 0 &&
    value.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isAppearanceSettings(value: unknown): value is AppearanceSettings {
  return isRecord(value) &&
    Object.keys(value).length === 6 &&
    isAppearanceTheme(value.theme) &&
    isAppearanceAccentColor(value.accentColor) &&
    isSurfaceTransparency(value.surfaceTransparency) &&
    isTextSize(value.textSize) &&
    isOptionalFontFamily(value.uiFontFamily) &&
    isOptionalFontFamily(value.codeFontFamily)
}

function isProviderInput(value: unknown): value is KernelProviderInput {
  return isRecord(value) &&
    Object.keys(value).length === 8 &&
    (value.originalId === null || isProviderId(value.originalId)) &&
    isProviderId(value.id) &&
    isHttpUrl(value.baseUrl) &&
    typeof value.api === 'string' &&
    (KERNEL_PROVIDER_APIS as readonly string[]).includes(value.api) &&
    (value.apiKey === null || typeof value.apiKey === 'string') &&
    typeof value.removeApiKey === 'boolean' &&
    !(value.removeApiKey && value.apiKey !== null) &&
    typeof value.authHeader === 'boolean' &&
    Array.isArray(value.models) &&
    value.models.length > 0 &&
    value.models.every(isProviderModelInput) &&
    new Set(value.models.map((model) => isRecord(model) ? model.id : null)).size === value.models.length
}

function isProviderModelInput(value: unknown): boolean {
  return isRecord(value) &&
    Object.keys(value).length === 7 &&
    isProviderModelId(value.id) &&
    (value.name === null || (typeof value.name === 'string' && value.name.trim().length > 0)) &&
    (value.reasoning === null || typeof value.reasoning === 'boolean') &&
    (
      value.input === null ||
      (
        Array.isArray(value.input) &&
        (value.input.length === 1 || value.input.length === 2) &&
        value.input[0] === 'text' &&
        (value.input.length === 1 || value.input[1] === 'image')
      )
    ) &&
    (value.contextWindow === null || isPositiveSafeInteger(value.contextWindow)) &&
    (value.maxTokens === null || isPositiveSafeInteger(value.maxTokens)) &&
    (value.cost === null || isModelPricing(value.cost))
}

function isModelPricing(value: unknown): boolean {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  return (keys.length === 4 || (keys.length === 5 && Array.isArray(value.tiers))) &&
    isNonNegativeFiniteNumber(value.input) &&
    isNonNegativeFiniteNumber(value.output) &&
    isNonNegativeFiniteNumber(value.cacheRead) &&
    isNonNegativeFiniteNumber(value.cacheWrite) &&
    (
      value.tiers === undefined ||
      (
        Array.isArray(value.tiers) &&
        value.tiers.every((tier) => (
          isRecord(tier) &&
          Object.keys(tier).length === 5 &&
          isNonNegativeSafeInteger(tier.inputTokensAbove) &&
          isNonNegativeFiniteNumber(tier.input) &&
          isNonNegativeFiniteNumber(tier.output) &&
          isNonNegativeFiniteNumber(tier.cacheRead) &&
          isNonNegativeFiniteNumber(tier.cacheWrite)
        ))
      )
    )
}

function isProviderModelId(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.trim() === value &&
    !/[\0\r\n]/u.test(value)
}

function isProviderId(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value) &&
    value !== '__proto__' &&
    value !== 'constructor' &&
    value !== 'prototype'
}

function isProviderAuthId(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() !== value) return false
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.length > 0
  } catch {
    return false
  }
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isGeneralSettings(value: unknown): value is GeneralSettings {
  return isRecord(value) &&
    Object.keys(value).length === 3 &&
    (value.startupWorkspaceRestore === 'restore' || value.startupWorkspaceRestore === 'none') &&
    typeof value.doubleClickBorderMaximize === 'boolean' &&
    typeof value.fastExtensionLoading === 'boolean'
}

function isSubagentSettings(value: unknown): value is SubagentSettings {
  return isRecord(value) &&
    Object.keys(value).length === 1 &&
    (value.maxDepth === 1 || value.maxDepth === 2 || value.maxDepth === 3)
}

function isSubagentDefinitionInput(value: unknown): value is KernelSubagentDefinitionInput {
  return isRecord(value) &&
    Object.keys(value).length === 18 &&
    (value.originalId === null || isSubagentDefinitionId(value.originalId)) &&
    (value.scope === 'user' || value.scope === 'project') &&
    typeof value.name === 'string' &&
    /^[a-z0-9][a-z0-9-]{0,63}$/u.test(value.name) &&
    isSingleLineText(value.description, 500, false) &&
    typeof value.systemPrompt === 'string' &&
    value.systemPrompt.length <= 100_000 &&
    !value.systemPrompt.includes('\0') &&
    (value.model === null || isSingleLineText(value.model, 256, false)) &&
    isOptionalStringList(value.fallbackModels) &&
    (value.thinking === null || isThinkingLevel(value.thinking)) &&
    (value.systemPromptMode === 'replace' || value.systemPromptMode === 'append') &&
    typeof value.inheritProjectContext === 'boolean' &&
    typeof value.inheritSkills === 'boolean' &&
    (
      value.defaultContext === null ||
      value.defaultContext === 'fresh' ||
      value.defaultContext === 'fork'
    ) &&
    isOptionalStringList(value.tools) &&
    isOptionalStringList(value.skills) &&
    (value.defaultAsync === null || typeof value.defaultAsync === 'boolean') &&
    (value.timeoutMs === null || isBoundedPositiveInteger(value.timeoutMs, 86_400_000)) &&
    (value.maxTurns === null || isBoundedPositiveInteger(value.maxTurns, 1_000)) &&
    (
      value.maxSubagentDepth === null ||
      isBoundedNonNegativeInteger(value.maxSubagentDepth, 3)
    )
}

function isAdvisorDefinitionInput(value: unknown): value is KernelAdvisorDefinitionInput {
  return isRecord(value) &&
    Object.keys(value).length === 8 &&
    (value.originalSlug === null || isAdvisorSlug(value.originalSlug)) &&
    (value.scope === 'user' || value.scope === 'project') &&
    isSingleLineText(value.name, 128, false) &&
    value.name.trim() === value.name &&
    typeof value.enabled === 'boolean' &&
    (value.model === null || (
      isSingleLineText(value.model, 256, false) &&
      value.model.trim() === value.model
    )) &&
    (value.thinking === null || isThinkingLevel(value.thinking)) &&
    Array.isArray(value.tools) &&
    value.tools.every((tool) =>
      typeof tool === 'string' && (ADVISOR_TOOL_NAMES as readonly string[]).includes(tool)
    ) &&
    new Set(value.tools).size === value.tools.length &&
    typeof value.instructions === 'string' &&
    value.instructions.length <= 100_000 &&
    !value.instructions.includes('\0')
}

function isAdvisorSlug(value: unknown): value is string {
  return typeof value === 'string' &&
    value.length <= 128 &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)
}

function isSubagentDefinitionId(value: unknown): value is string {
  return typeof value === 'string' &&
    /^(?:builtin|user|project):[A-Za-z0-9_-]+$/u.test(value)
}

function isOptionalStringList(value: unknown): value is string[] | null {
  return value === null || (
    Array.isArray(value) &&
    value.length <= 64 &&
    value.every((item) => isSingleLineText(item, 512, false))
  )
}

function isSingleLineText(value: unknown, maxLength: number, allowEmpty: boolean): value is string {
  return typeof value === 'string' &&
    (allowEmpty || value.trim().length > 0) &&
    value.length <= maxLength &&
    !/[\0\r\n]/u.test(value)
}

function isBoundedPositiveInteger(value: unknown, max: number): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= max
}

function isBoundedNonNegativeInteger(value: unknown, max: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max
}

function isAppearanceTheme(value: unknown): value is AppearanceSettings['theme'] {
  return value === 'system' || value === 'dark' || value === 'light'
}

function isAppearanceAccentColor(value: unknown): value is AppearanceSettings['accentColor'] {
  return value === 'amber' ||
    value === 'blue' ||
    value === 'green' ||
    value === 'purple' ||
    value === 'rose'
}

function isSurfaceTransparency(value: unknown): value is AppearanceSettings['surfaceTransparency'] {
  return value === 0 || value === 10 || value === 20 || value === 30 || value === 40
}

function isTextSize(value: unknown): value is AppearanceSettings['textSize'] {
  return value === 'small' || value === 'default' || value === 'large'
}

function isOptionalFontFamily(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.trim().length > 0)
}

function isSessionNamingSettings(value: unknown): value is SessionNamingSettings {
  if (!isRecord(value) || typeof value.mode !== 'string') return false
  if (value.mode === 'auto' || value.mode === 'off') {
    return Object.keys(value).length === 1
  }
  return value.mode === 'model' &&
    Object.keys(value).length === 3 &&
    typeof value.provider === 'string' &&
    value.provider.trim().length > 0 &&
    typeof value.modelId === 'string' &&
    value.modelId.trim().length > 0
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return (
    value === 'off' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max'
  )
}

function isProjectTrustChoice(value: unknown): value is KernelProjectTrustChoice {
  return value === 'persist-trusted' ||
    value === 'persist-untrusted' ||
    value === 'once-trusted' ||
    value === 'once-untrusted' ||
    value === 'cancel'
}
