import { randomUUID } from 'node:crypto'
import {
  isDesktopHostProfileCommand, isDesktopHostProfileSelection, parseDesktopClientHostConfig,
  type DesktopClientConnectRequest, type DesktopClientStatus, type DesktopHostProfileCommand
} from '../../shared/desktop-client-contract.ts'
import { createMemoryDesktopClientHostConfigStore, type DesktopClientHostConfigStore } from './desktop-client-host-config-store.ts'
import { createMemoryDesktopDeviceCredentialStore, type DesktopDeviceCredentialStore } from './desktop-device-credential-store.ts'
import { parseDesktopHostProfileState, type DesktopHostProfileState, type DesktopHostProfileStore } from './desktop-host-profile-store.ts'
import { createWindowsRemoteSession, parseWindowsRemoteConnectRequest, type CreateWindowsRemoteSessionOptions, type WindowsRemoteSession } from './windows-remote-session.ts'

type RemoteStatus = Extract<DesktopClientStatus, { mode: 'windows-remote' }>
export type WindowsRemoteHostManager = Omit<WindowsRemoteSession, 'connect' | 'dispatch' | 'revokePairing'> & {
  connect(request: DesktopClientConnectRequest): ReturnType<WindowsRemoteSession['connect']>
  manageProfiles(command: DesktopHostProfileCommand): Promise<void>
  captureDispatch(connectionId: unknown): WindowsRemoteSession['dispatch']
  dispatch(command: Parameters<WindowsRemoteSession['dispatch']>[0], identity: unknown, connectionId: unknown): Promise<unknown>
  revokePairing(config: Parameters<WindowsRemoteSession['revokePairing']>[0], connectionId: unknown): Promise<void>
}

export async function createWindowsRemoteHostManager(options: {
  profileStore: DesktopHostProfileStore
  legacyHostStore: DesktopClientHostConfigStore
  legacyCredentialStore: DesktopDeviceCredentialStore
  credentialStoreForKey(key: string): DesktopDeviceCredentialStore
  session: Omit<CreateWindowsRemoteSessionOptions, 'credentialStore' | 'hostConfigStore' | 'initialLastHost' | 'initialHasStoredCredential' | 'initialCachedCredential'>
}): Promise<WindowsRemoteHostManager> {
  const loaded = await options.profileStore.load()
  let state: DesktopHostProfileState
  if (loaded !== null) state = parseDesktopHostProfileState(loaded)
  else {
    const legacy = await options.legacyHostStore.load()
    const profile = legacy === null ? null : { id: randomUUID(), name: legacy.sshHostAlias.slice(0, 80),
      config: parseDesktopClientHostConfig(legacy), credentialKey: randomUUID() }
    state = { schemaVersion: 1, revision: 0, profiles: profile === null ? [] : [profile], selectedId: profile?.id ?? null,
      pendingCredentialDeletes: [], legacyCredentialKey: profile?.credentialKey ?? null }
    await options.profileStore.save(state)
  }
  let active: WindowsRemoteSession | null = null
  let busy = false
  let configurationWork: Promise<void> | null = null
  let configurationError: string | null = null
  let closed = false
  let connectionId: string | null = null
  const isReady = (): boolean => !closed && active !== null && configurationError === null && state.legacyCredentialKey === null && state.pendingCredentialDeletes.length === 0
  const selected = () => state.profiles.find((profile) => profile.id === state.selectedId) ?? null
  const status = (): RemoteStatus => ({
    ...(active?.status() ?? { mode: 'windows-remote', phase: 'disconnected', hasStoredCredential: false,
      lastHost: selected()?.config ?? null, capabilities: null, error: null, failureKind: null, recovery: null }),
    ...(busy ? { phase: 'configuring' } : {}),
    ...(configurationError === null ? {} : { error: configurationError, failureKind: 'configuration' }),
    hostConnectionId: connectionId,
    hostProfiles: { revision: state.revision, selectedId: state.selectedId,
      profiles: state.profiles.map(({ id, name, config }) => ({ id, name, config: { ...config } })),
      ready: isReady() }
  })
  const publish = (): void => { options.session.onStatus?.(status()) }
  const persist = async (next: DesktopHostProfileState): Promise<void> => {
    const validated = parseDesktopHostProfileState({ ...next, revision: state.revision + 1 })
    await options.profileStore.save(validated)
    state = validated
  }

  const prepareSelection = async (): Promise<void> => {
    // The migration target is durable before any credential is copied/deleted.
    // An existing destination wins on restart; never overwrite a newer pairing.
    if (state.legacyCredentialKey !== null) {
      const destination = options.credentialStoreForKey(state.legacyCredentialKey)
      if (await destination.load() === null) {
        const credential = await options.legacyCredentialStore.load()
        if (credential !== null) await destination.save(credential)
      }
      await options.legacyCredentialStore.clear()
      await options.legacyHostStore.clear()
      await persist({ ...state, legacyCredentialKey: null })
    }
    for (const key of [...state.pendingCredentialDeletes]) {
      await options.credentialStoreForKey(key).clear()
      await persist({ ...state, pendingCredentialDeletes: state.pendingCredentialDeletes.filter((pending) => pending !== key) })
    }
    const profile = selected()
    const credentials = profile === null ? createMemoryDesktopDeviceCredentialStore() : options.credentialStoreForKey(profile.credentialKey)
    const credential = await credentials.load()
    const session = createWindowsRemoteSession({ ...options.session, credentialStore: credentials,
      hostConfigStore: createMemoryDesktopClientHostConfigStore(profile?.config ?? null),
      initialLastHost: profile?.config ?? null, initialHasStoredCredential: credential !== null, initialCachedCredential: credential,
      onEvent: (event) => { if (active === session && !busy && !closed) options.session.onEvent(event) },
      onStatus: () => {
        if (active !== session) return
        connectionId = session.status().phase === 'connected' ? connectionId ?? randomUUID() : null
        publish()
      }
    })
    active = session
  }
  try { await prepareSelection() } catch (error) {
    configurationError = `主机配置或凭证操作未完成，请重试：${error instanceof Error ? error.message : String(error)}`
  }

  const readySession = (): WindowsRemoteSession => {
    if (busy) throw new Error('主机配置操作正在进行，请等待完成。')
    if (active === null || !isReady()) throw new Error('请先重试未完成的主机配置或凭证操作。')
    return active
  }
  const captureDispatch = (expectedConnectionId: unknown): WindowsRemoteSession['dispatch'] => {
    const session = readySession()
    if (session.status().phase !== 'connected' || connectionId === null || expectedConnectionId !== connectionId) {
      throw new Error('Host 连接已变化，请在当前连接中重新操作。')
    }
    const ownerId = connectionId
    return async (command, identity) => {
      if (closed || busy || active !== session || connectionId !== ownerId) throw new Error('Host 连接已变化，旧连接的请求已失效。')
      return session.dispatch(command, identity)
    }
  }
  return {
    status,
    captureDispatch,
    async manageProfiles(command) {
      if (!isDesktopHostProfileCommand(command)) throw new Error('Invalid Host profile command.')
      if (closed || busy || (active !== null && active.status().phase !== 'disconnected')) throw new Error('请先断开 Host 并结束当前操作，再管理主机配置。')
      if (command.expectedRevision !== state.revision) throw new Error('主机配置已变化，请使用最新列表重试。')
      if (command.type !== 'desktop-client.host-profiles.retry' && !isReady()) throw new Error('请先重试未完成的主机配置或凭证操作。')
      let next = structuredClone(state)
      if (command.type === 'desktop-client.host-profiles.select') next.selectedId = command.id
      if (command.type === 'desktop-client.host-profiles.save') {
        const previous = command.id === null ? null : next.profiles.find((profile) => profile.id === command.id)
        if (previous === undefined) throw new Error('要修改的主机配置已不存在。')
        const config = parseDesktopClientHostConfig(command.config)
        const rotate = previous !== null && (previous.config.sshHostAlias !== config.sshHostAlias || previous.config.desktopHostPort !== config.desktopHostPort)
        const profile = { id: previous?.id ?? randomUUID(), name: command.name, config,
          credentialKey: previous === null || rotate ? randomUUID() : previous.credentialKey }
        if (previous === null) next.profiles.push(profile)
        else next.profiles = next.profiles.map((entry) => entry.id === previous.id ? profile : entry)
        if (rotate) next.pendingCredentialDeletes.push(previous!.credentialKey)
        next.selectedId = profile.id
      }
      if (command.type === 'desktop-client.host-profiles.remove' || command.type === 'desktop-client.host-profiles.forget') {
        const profile = next.profiles.find((entry) => entry.id === command.id)
        if (profile === undefined) throw new Error('主机配置已不存在。')
        next.pendingCredentialDeletes.push(profile.credentialKey)
        if (command.type === 'desktop-client.host-profiles.remove') {
          next.profiles = next.profiles.filter((entry) => entry.id !== profile.id)
          if (next.selectedId === profile.id) next.selectedId = null
        } else profile.credentialKey = randomUUID()
      }
      next = parseDesktopHostProfileState(next)
      busy = true
      configurationError = null
      const work = Promise.resolve().then(async () => {
        publish()
        try {
          await active?.close()
          active = null
          if (command.type !== 'desktop-client.host-profiles.retry') await persist(next)
          await prepareSelection()
        } catch (error) {
          configurationError = `主机配置或凭证操作未完成，请重试：${error instanceof Error ? error.message : String(error)}`
          throw error
        } finally { busy = false; publish() }
      })
      configurationWork = work
      const settled = (): void => { if (configurationWork === work) configurationWork = null }
      void work.then(settled, settled)
      return work
    },
    async connect(request) {
      const session = readySession()
      if (!isDesktopHostProfileSelection(request.profile) || request.profile.revision !== state.revision || request.profile.id !== state.selectedId) {
        throw new Error('主机选择已变化，请使用当前配置连接。')
      }
      const profile = selected()
      if (profile === null) throw new Error('请先保存主机配置后连接。')
      const { profile: _selection, ...connection } = request
      const parsed = parseWindowsRemoteConnectRequest(connection)
      if (parsed.sshHostAlias !== profile.config.sshHostAlias || parsed.localPort !== profile.config.localPort || parsed.desktopHostPort !== profile.config.desktopHostPort) {
        throw new Error('连接参数已修改，请先保存配置。')
      }
      return session.connect(parsed)
    },
    async checkHost(id, config) { return readySession().checkHost(id, config) },
    async cancelHostCheck(id) { return active?.cancelHostCheck(id) },
    async disconnect() { return readySession().disconnect() },
    async revokePairing(config, observedConnectionId) {
      captureDispatch(observedConnectionId)
      return readySession().revokePairing(config)
    },
    async dispatch(command, identity, observedConnectionId) { return captureDispatch(observedConnectionId)(command, identity) },
    async close() {
      closed = true
      // Configuration failures are delivered to their caller and status; shutdown
      // still drains the current resource owner after that operation settles.
      await Promise.allSettled([configurationWork])
      await active?.close()
    }
  }
}
