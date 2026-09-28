import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isDesktopEnvironment, isDesktopPreferences, isDesktopPreferencesUpdate, type DesktopEnvironment, type DesktopPreferences, type DesktopPreferencesUpdate } from '../../shared/desktop-settings-contract.ts'

type Settings = { version: 1; environment: DesktopEnvironment | null; preferences: DesktopPreferences | null }
export function createDesktopSettingsStore(file: string) {
  let tail = Promise.resolve()
  const load = async (): Promise<Settings> => {
    let text: string
    try { text = await readFile(file, 'utf8') } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { version: 1, environment: null, preferences: null }
      throw error
    }
    const value = JSON.parse(text) as Settings
    if (!value || Object.keys(value).length !== 3 || value.version !== 1 ||
      (value.environment !== null && !isDesktopEnvironment(value.environment)) ||
      (value.preferences !== null && !isDesktopPreferences(value.preferences))) throw new Error('Invalid desktop settings file.')
    return value
  }
  const update = (change: (settings: Settings) => void): Promise<Settings> => {
    const next = tail.then(async () => {
      const settings = await load()
      change(settings)
      await mkdir(dirname(file), { recursive: true })
      const temporary = `${file}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify(settings) + '\n', { mode: 0o600, flag: 'wx' })
        await rename(temporary, file)
      } finally { await rm(temporary, { force: true }) }
      return settings
    })
    // Serialize future writes; each caller still receives its own rejection.
    tail = next.then(() => undefined, () => undefined)
    return next
  }
  return {
    load: async () => { await tail; return load() },
    setEnvironment: (environment: DesktopEnvironment) => {
      if (!isDesktopEnvironment(environment)) throw new Error('Invalid desktop environment.')
      return update((settings) => { settings.environment = structuredClone(environment) })
    },
    initializePreferences: async (seed: DesktopPreferences) => {
      if (!isDesktopPreferences(seed)) throw new Error('Invalid desktop preference seed.')
      await tail
      const existing = await load()
      if (existing.preferences !== null) return existing.preferences
      return (await update((settings) => { settings.preferences ??= structuredClone(seed) })).preferences!
    },
    updatePreferences: async (patch: DesktopPreferencesUpdate) => {
      if (!isDesktopPreferencesUpdate(patch)) throw new Error('Invalid desktop preference update.')
      return (await update((settings) => {
        if (settings.preferences === null) throw new Error('Desktop preferences have not been initialized.')
        settings.preferences = { ...settings.preferences, ...structuredClone(patch) }
      })).preferences!
    }
  }
}
