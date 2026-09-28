import type {
  AppearanceSettings,
  GeneralSettings,
  SessionNamingSettings,
  SubagentSettings
} from './kernel-contract.ts'

// Current setting schemas and defensive copies are shared by IPC, Kernel and storage.
// Stored general settings may contain a dormant auto-continue preference from older
// versions. Read it losslessly; new submissions must pass isGeneralSettingsUpdate.
export function copySessionNamingSettings(settings: SessionNamingSettings): SessionNamingSettings {
  return settings.mode === 'model'
    ? { mode: 'model', provider: settings.provider, modelId: settings.modelId }
    : { mode: settings.mode }
}

export function copyAppearanceSettings(settings: AppearanceSettings): AppearanceSettings {
  return {
    theme: settings.theme,
    accentColor: settings.accentColor,
    surfaceTransparency: settings.surfaceTransparency,
    textSize: settings.textSize,
    tokenCountFormat: settings.tokenCountFormat,
    uiFontFamily: settings.uiFontFamily,
    codeFontFamily: settings.codeFontFamily
  }
}

export function copyGeneralSettings(settings: GeneralSettings): GeneralSettings {
  return {
    startupWorkspaceRestore: settings.startupWorkspaceRestore,
    doubleClickBorderMaximize: settings.doubleClickBorderMaximize,
    fastExtensionLoading: settings.fastExtensionLoading,
    autoContinueInterruptedTasks: settings.autoContinueInterruptedTasks
  }
}

export function copySubagentSettings(settings: SubagentSettings): SubagentSettings {
  return {
    maxDepth: settings.maxDepth
  }
}

export function isAppearanceSettings(value: unknown): value is AppearanceSettings {
  return isRecord(value) &&
    Object.keys(value).length === 7 &&
    isAppearanceTheme(value.theme) &&
    isAppearanceAccentColor(value.accentColor) &&
    isSurfaceTransparency(value.surfaceTransparency) &&
    isTextSize(value.textSize) &&
    isTokenCountFormat(value.tokenCountFormat) &&
    isOptionalFontFamily(value.uiFontFamily) &&
    isOptionalFontFamily(value.codeFontFamily)
}

export function isSubagentSettings(value: unknown): value is SubagentSettings {
  return isRecord(value) &&
    Object.keys(value).length === 1 &&
    (value.maxDepth === 1 || value.maxDepth === 2 || value.maxDepth === 3)
}

export function isSessionNamingSettings(value: unknown): value is SessionNamingSettings {
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

export function isGeneralSettings(value: unknown): value is GeneralSettings {
  return isRecord(value) &&
    Object.keys(value).length === 4 &&
    (value.startupWorkspaceRestore === 'restore' || value.startupWorkspaceRestore === 'none') &&
    typeof value.doubleClickBorderMaximize === 'boolean' &&
    typeof value.fastExtensionLoading === 'boolean' &&
    typeof value.autoContinueInterruptedTasks === 'boolean'
}

export function isGeneralSettingsUpdate(value: unknown): value is GeneralSettings {
  return isGeneralSettings(value) &&
    (!value.autoContinueInterruptedTasks || value.startupWorkspaceRestore === 'restore')
}

export function isAppearanceTheme(value: unknown): value is AppearanceSettings['theme'] {
  return value === 'system' || value === 'dark' || value === 'light'
}

export function isAppearanceAccentColor(value: unknown): value is AppearanceSettings['accentColor'] {
  return value === 'amber' ||
    value === 'blue' ||
    value === 'green' ||
    value === 'purple' ||
    value === 'rose'
}

export function isSurfaceTransparency(value: unknown): value is AppearanceSettings['surfaceTransparency'] {
  return value === 0 || value === 10 || value === 20 || value === 30 || value === 40
}

export function isTextSize(value: unknown): value is AppearanceSettings['textSize'] {
  return value === 'small' || value === 'default' || value === 'large'
}

function isTokenCountFormat(value: unknown): value is AppearanceSettings['tokenCountFormat'] {
  return value === 'full' || value === 'compact'
}

export function isOptionalFontFamily(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.trim().length > 0)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
