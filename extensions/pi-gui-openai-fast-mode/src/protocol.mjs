/** Shared internal command protocol for the app-owned OpenAI Fast mode extension. */

export const OPENAI_FAST_MODE_COMMAND_NAME = 'pi-gui-openai-fast-mode-control'
export const OPENAI_FAST_MODE_ENTRY_TYPE = 'pi-gui-openai-fast-mode/state'

export function buildOpenAiFastModeCommandArgs(enabled) {
  return enabled ? 'on' : 'off'
}

export function buildOpenAiFastModeEntryData(enabled) {
  return { enabled }
}

export function parseOpenAiFastModeEntryData(data) {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
  if (Object.keys(data).length !== 1 || typeof data.enabled !== 'boolean') return null
  return data.enabled
}

export function parseOpenAiFastModeCommandArgs(args) {
  const value = typeof args === 'string' ? args.trim() : ''
  if (value === 'on') return true
  if (value === 'off') return false
  return null
}

export function isInternalOpenAiFastModeCommandName(name) {
  if (typeof name !== 'string') return false
  if (name === OPENAI_FAST_MODE_COMMAND_NAME) return true
  const prefix = `${OPENAI_FAST_MODE_COMMAND_NAME}:`
  return name.startsWith(prefix) && /^\d+$/u.test(name.slice(prefix.length))
}
