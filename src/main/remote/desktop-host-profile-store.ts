import { randomUUID } from 'node:crypto'
import { open, rename, unlink } from 'node:fs/promises'
import {
  DESKTOP_HOST_PROFILE_LIMIT, isDesktopHostProfileId, isDesktopHostProfileName, parseDesktopClientHostConfig,
  type DesktopHostProfile
} from '../../shared/desktop-client-contract.ts'

export type StoredDesktopHostProfile = DesktopHostProfile & { credentialKey: string }
export type DesktopHostProfileState = {
  schemaVersion: 1
  revision: number
  selectedId: string | null
  profiles: StoredDesktopHostProfile[]
  pendingCredentialDeletes: string[]
  legacyCredentialKey: string | null
}
export type DesktopHostProfileStore = {
  load(): Promise<DesktopHostProfileState | null>
  save(state: DesktopHostProfileState): Promise<void>
}

export function parseDesktopHostProfileState(value: unknown): DesktopHostProfileState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Host profile state.')
  const state = value as DesktopHostProfileState
  if (Object.keys(state).length !== 6 || state.schemaVersion !== 1 || !Number.isSafeInteger(state.revision) || state.revision < 0 ||
    !(state.selectedId === null || isDesktopHostProfileId(state.selectedId)) || !Array.isArray(state.profiles) || state.profiles.length > DESKTOP_HOST_PROFILE_LIMIT ||
    !Array.isArray(state.pendingCredentialDeletes) || state.pendingCredentialDeletes.length > 64 ||
    !(state.legacyCredentialKey === null || isDesktopHostProfileId(state.legacyCredentialKey))) throw new Error('Invalid Host profile state.')
  const ids = new Set<string>()
  const keys = new Set<string>()
  const endpoints = new Set<string>()
  const profiles = state.profiles.map((profile) => {
    if (profile === null || typeof profile !== 'object' || Array.isArray(profile) || Object.keys(profile).length !== 4 ||
      !isDesktopHostProfileId(profile.id) || !isDesktopHostProfileId(profile.credentialKey) || !isDesktopHostProfileName(profile.name)) throw new Error('Invalid Host profile.')
    const config = parseDesktopClientHostConfig(profile.config)
    const endpoint = JSON.stringify([config.sshHostAlias, config.desktopHostPort])
    if (ids.has(profile.id) || keys.has(profile.credentialKey) || endpoints.has(endpoint)) throw new Error('Duplicate Host profile identity, credential slot or endpoint.')
    ids.add(profile.id); keys.add(profile.credentialKey); endpoints.add(endpoint)
    return { id: profile.id, name: profile.name, config, credentialKey: profile.credentialKey }
  })
  if (state.selectedId !== null && !ids.has(state.selectedId)) throw new Error('Selected Host profile is missing.')
  if (state.legacyCredentialKey !== null && !keys.has(state.legacyCredentialKey)) throw new Error('Legacy credential migration target is missing.')
  const deleted = new Set<string>()
  for (const key of state.pendingCredentialDeletes) {
    if (!isDesktopHostProfileId(key) || keys.has(key) || deleted.has(key)) throw new Error('Invalid pending Host credential deletion.')
    deleted.add(key)
  }
  return { schemaVersion: 1, revision: state.revision, selectedId: state.selectedId, profiles,
    pendingCredentialDeletes: [...deleted], legacyCredentialKey: state.legacyCredentialKey }
}

export function createFileDesktopHostProfileStore(path: string): DesktopHostProfileStore {
  return {
    async load() {
      let file
      try { file = await open(path, 'r') } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
        throw error
      }
      try {
        const stats = await file.stat()
        if (!stats.isFile() || stats.size > 128 * 1024) throw new Error('Host profile file must be a regular file of at most 128 KiB.')
        const bytes = Buffer.alloc(128 * 1024 + 1)
        let length = 0
        while (length < bytes.length) {
          const { bytesRead } = await file.read(bytes, length, bytes.length - length, length)
          if (bytesRead === 0) break
          length += bytesRead
        }
        if (length > 128 * 1024) throw new Error('Host profile file exceeds 128 KiB.')
        let parsed: unknown
        try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))) }
        catch { throw new Error('Host profile file is not valid UTF-8 JSON.') }
        return parseDesktopHostProfileState(parsed)
      } finally { await file.close() }
    },
    async save(value) {
      const state = parseDesktopHostProfileState(value)
      const temporary = `${path}.${randomUUID()}.tmp`
      const file = await open(temporary, 'wx', 0o600)
      let failure: unknown = null
      try {
        await file.writeFile(`${JSON.stringify(state)}\n`, 'utf8')
        await file.sync()
      } catch (error) { failure = error }
      try { await file.close() } catch (error) { failure = failure === null ? error : new AggregateError([failure, error], 'Host profile write and close failed.') }
      if (failure === null) {
        try { await rename(temporary, path) } catch (error) { failure = error }
      }
      if (failure !== null) {
        try { await unlink(temporary) } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw new AggregateError([failure, error], 'Host profile write and temporary file cleanup failed.')
        }
        throw failure
      }
    }
  }
}
