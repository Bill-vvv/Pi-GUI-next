import type { AppearanceSettings, ShortcutSettings, KernelState } from './kernel-contract.ts'
import { isAppearanceSettings } from './workbench-settings.ts'
import { isShortcutSettings } from './shortcut-settings.ts'

export type DesktopEnvironment = { mode: 'ssh' } | { mode: 'wsl'; distribution: string }
export type DesktopPreferences = {
  appearance: AppearanceSettings
  shortcuts: ShortcutSettings
  doubleClickBorderMaximize: boolean
}
export type DesktopPreferencesUpdate =
  | { appearance: AppearanceSettings }
  | { shortcuts: ShortcutSettings }
  | { doubleClickBorderMaximize: boolean }
export type DesktopEnvironmentStatus = { current: DesktopEnvironment | null; canSwitch: boolean }

export function isDesktopEnvironment(value: unknown): value is DesktopEnvironment {
  if (!record(value)) return false
  return (value.mode === 'ssh' && Object.keys(value).length === 1) ||
    (value.mode === 'wsl' && Object.keys(value).length === 2 && typeof value.distribution === 'string' && /^[\p{L}\p{N}][\p{L}\p{N}._ -]{0,127}$/u.test(value.distribution))
}
export function isDesktopPreferences(value: unknown): value is DesktopPreferences {
  return record(value) && Object.keys(value).length === 3 && isAppearanceSettings(value.appearance) && isShortcutSettings(value.shortcuts) && typeof value.doubleClickBorderMaximize === 'boolean'
}
export function isDesktopPreferencesUpdate(value: unknown): value is DesktopPreferencesUpdate {
  return record(value) && Object.keys(value).length === 1 && (
    (Object.hasOwn(value, 'appearance') && isAppearanceSettings(value.appearance)) ||
    (Object.hasOwn(value, 'shortcuts') && isShortcutSettings(value.shortcuts)) ||
    typeof value.doubleClickBorderMaximize === 'boolean'
  )
}
/** Local presentation only. Never feed this projection into Kernel revision/control state. */
export function withDesktopPreferences(state: KernelState, preferences: DesktopPreferences): KernelState {
  return { ...state, appearance: preferences.appearance, shortcuts: preferences.shortcuts, general: { ...state.general, doubleClickBorderMaximize: preferences.doubleClickBorderMaximize } }
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
