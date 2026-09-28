import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createServer } from 'node:net'
import test, { type TestContext } from 'node:test'
import { isDesktopClientCommand, type DesktopClientHostConfig } from '../../shared/desktop-client-contract.ts'
import { DESKTOP_HOST_KERNEL_COMMAND_TYPES } from '../../shared/desktop-host-contract.ts'
import type { KernelSnapshot } from '../../shared/kernel-contract.ts'
import { DesktopHostClient } from './desktop-host-client.ts'
import { startDesktopHostGateway } from './desktop-host-gateway.ts'
import { openRemoteDeviceStore } from './remote-device-store.ts'
import { createFileDesktopHostProfileStore, parseDesktopHostProfileState, type DesktopHostProfileState, type DesktopHostProfileStore } from './desktop-host-profile-store.ts'
import { createMemoryDesktopClientHostConfigStore, createFileDesktopClientHostConfigStore } from './desktop-client-host-config-store.ts'
import { createMemoryDesktopDeviceCredentialStore, desktopHostProfileCredentialTarget, createWindowsCredentialManagerStore, type DesktopDeviceCredentialStore } from './desktop-device-credential-store.ts'
import { createWindowsRemoteHostManager, type WindowsRemoteHostManager } from './windows-remote-host-manager.ts'

const A = { sshHostAlias: 'host-a', localPort: 18001, desktopHostPort: 18788 }
const B = { sshHostAlias: 'host-b', localPort: 18002, desktopHostPort: 18788 }
const TOKEN_A = 'A'.repeat(32)
const TOKEN_B = 'B'.repeat(32)

async function fixture(t: TestContext, legacy: DesktopClientHostConfig | null = null) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-gui-host-profiles-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'hosts.json')
  const fileStore = createFileDesktopHostProfileStore(path)
  const store: DesktopHostProfileStore = { ...fileStore }
  const legacyHostStore = createMemoryDesktopClientHostConfigStore(legacy)
  const legacyCredentialStore = createMemoryDesktopDeviceCredentialStore(legacy === null ? null : TOKEN_A)
  const slots = new Map<string, DesktopDeviceCredentialStore>()
  const tokens = new Map([[A.localPort, TOKEN_A], [B.localPort, TOKEN_B]])
  const calls: string[] = []
  const credentials = (key: string): DesktopDeviceCredentialStore => {
    if (!slots.has(key)) slots.set(key, createMemoryDesktopDeviceCredentialStore())
    return slots.get(key)!
  }
  const options: Parameters<typeof createWindowsRemoteHostManager>[0] = { profileStore: store, legacyHostStore, legacyCredentialStore,
    credentialStoreForKey: credentials,
    session: { productVersion: '1.0.0', buildCommit: 'test-build', onEvent: () => {},
      startTunnel: async ({ config, verifyUnauthenticatedDesktopHost }) => {
        calls.push(`tunnel:${config.sshHostAlias}`)
        const controller = new AbortController()
        let end!: (value: { expected: boolean; code: number; signal: null; error: null; stderr: string }) => void
        const termination = new Promise<Parameters<typeof end>[0]>((resolve) => { end = resolve })
        await verifyUnauthenticatedDesktopHost(controller.signal)
        return { connectionSignal: controller.signal, termination, stop: async () => { controller.abort(); end({ expected: true, code: 0, signal: null, error: null, stderr: '' }) } }
      },
      createClient: ({ localPort }) => {
        const token = tokens.get(localPort)
        if (token === undefined) throw new Error('Unknown test Host port')
        const capabilities = { kernelCommandTypes: [...DESKTOP_HOST_KERNEL_COMMAND_TYPES] }
        return {
          verifyCompatibility: async () => ({ capabilities }),
          pair: async () => { calls.push(`pair:${localPort}`); return { credential: token, capabilities } },
          setCredential: (credential: string) => { assert.equal(credential, token, 'credential belongs to the target Host'); calls.push(`resume:${localPort}`) },
          clearCredential: () => {},
          openEventStream: async () => {
            let end!: () => void
            return { closed: new Promise<void>((resolve) => { end = resolve }), close: async () => { end() } }
          },
          getState: async () => ({ revision: 1, state: { activeProjectKey: '/project', activeSessionKey: 'session' } } as KernelSnapshot),
          logout: async () => { calls.push('logout') }
        } as unknown as DesktopHostClient
      }
    }
  }
  const managers: WindowsRemoteHostManager[] = []
  const start = async () => { const manager = await createWindowsRemoteHostManager(options); managers.push(manager); return manager }
  t.after(async () => { for (const manager of managers) await manager.close() })
  return { path, store, fileStore, legacyHostStore, legacyCredentialStore, slots, credentials, tokens, calls, options, start }
}
function view(manager: WindowsRemoteHostManager) { return manager.status().hostProfiles! }
async function save(manager: WindowsRemoteHostManager, config: DesktopClientHostConfig, name = config.sshHostAlias, id: string | null = null) {
  await manager.manageProfiles({ type: 'desktop-client.host-profiles.save', expectedRevision: view(manager).revision, id, name, config })
  return view(manager).selectedId!
}
async function select(manager: WindowsRemoteHostManager, id: string | null) {
  await manager.manageProfiles({ type: 'desktop-client.host-profiles.select', expectedRevision: view(manager).revision, id })
}
async function connect(manager: WindowsRemoteHostManager, config: DesktopClientHostConfig, pair = false) {
  return manager.connect({ ...config, profile: { id: view(manager).selectedId, revision: view(manager).revision }, ...(pair ? { pairingCode: '123456' } : {}) })
}

test('two saved Hosts keep separate credentials across selection, disconnect and manager restart', async (t) => {
  const f = await fixture(t)
  let manager = await f.start()
  const a = await save(manager, A, '开发主机')
  await connect(manager, A, true)
  await assert.rejects(save(manager, B), /先断开/)
  await manager.disconnect()
  const b = await save(manager, B, '测试主机')
  assert.equal(manager.status().hasStoredCredential, false)
  await connect(manager, B, true)
  await manager.disconnect()
  await select(manager, a)
  assert.equal(manager.status().hasStoredCredential, true)
  await connect(manager, A)
  await manager.close()
  manager = await f.start()
  assert.equal(view(manager).selectedId, a)
  await connect(manager, A)
  await manager.disconnect()
  await select(manager, b)
  await connect(manager, B)
  const state = (await f.store.load())!
  assert.notEqual(state.profiles[0]!.credentialKey, state.profiles[1]!.credentialKey)
  assert.equal(f.calls.filter((call) => call.startsWith('pair:')).length, 2)
  assert.equal(f.calls.filter((call) => call.startsWith('resume:')).length, 3)
  const json = await readFile(f.path, 'utf8')
  assert.equal(json.includes(TOKEN_A) || json.includes(TOKEN_B), false)
  assert.equal(JSON.stringify(manager.status()).includes('credentialKey'), false)
  await manager.revokePairing(B, manager.status().hostConnectionId)
  assert.equal(await f.credentials(state.profiles.find((profile) => profile.id === a)!.credentialKey).load(), TOKEN_A)
  assert.equal(await f.credentials(state.profiles.find((profile) => profile.id === b)!.credentialKey).load(), null)
})

test('renaming or changing the local port keeps pairing; changing the endpoint replaces its credential slot', async (t) => {
  const f = await fixture(t)
  const manager = await f.start()
  const id = await save(manager, A)
  await connect(manager, A, true); await manager.disconnect()
  const original = (await f.store.load())!.profiles[0]!.credentialKey
  await save(manager, { ...A, localPort: 18100 }, '新名称', id)
  assert.equal((await f.store.load())!.profiles[0]!.credentialKey, original)
  assert.equal(manager.status().hasStoredCredential, true)
  await save(manager, { ...A, desktopHostPort: 19000 }, '新端口', id)
  assert.notEqual((await f.store.load())!.profiles[0]!.credentialKey, original)
  assert.equal(await f.credentials(original).load(), null)
  assert.equal(manager.status().hasStoredCredential, false)
})

test('stale revisions, missing selection and unsaved target edits never start a connection', async (t) => {
  const f = await fixture(t)
  const manager = await f.start()
  const id = await save(manager, A)
  const revision = view(manager).revision
  await select(manager, null)
  await assert.rejects(manager.manageProfiles({ type: 'desktop-client.host-profiles.remove', id, expectedRevision: revision }), /已变化/)
  await assert.rejects(manager.connect({ ...A, pairingCode: '123456' }), /选择已变化/)
  await assert.rejects(manager.connect({ ...A, profile: { id, revision }, pairingCode: '123456' }), /选择已变化/)
  await assert.rejects(connect(manager, A, true), /先保存/)
  await select(manager, id)
  await assert.rejects(connect(manager, B, true), /先保存配置/)
  assert.deepEqual(f.calls, [])
  assert.equal(view(manager).profiles.length, 1)
})

test('legacy migration resumes after interruption without replacing a newer destination credential', async (t) => {
  const f = await fixture(t, A)
  const clear = f.legacyCredentialStore.clear
  f.legacyCredentialStore.clear = async () => { throw new Error('legacy deletion interrupted') }
  const first = await f.start()
  assert.equal(view(first).ready, false)
  const pending = (await f.store.load())!
  assert.ok(pending.legacyCredentialKey)
  assert.equal(await f.credentials(pending.legacyCredentialKey!).load(), TOKEN_A)
  await f.credentials(pending.legacyCredentialKey!).save(TOKEN_B)
  await first.close()
  f.legacyCredentialStore.clear = clear
  const second = await f.start()
  assert.equal(view(second).ready, true)
  assert.equal(await f.credentials(pending.legacyCredentialKey!).load(), TOKEN_B)
  assert.equal(await f.legacyCredentialStore.load(), null)
  assert.equal(await f.legacyHostStore.load(), null)
  assert.equal((await f.store.load())!.legacyCredentialKey, null)
  assert.equal(view(second).profiles.length, 1)
})

test('an orphan legacy credential is never assigned to a newly saved Host', async (t) => {
  const f = await fixture(t)
  await f.legacyCredentialStore.save(TOKEN_A)
  const manager = await f.start()
  await save(manager, B)
  assert.equal(manager.status().hasStoredCredential, false)
  assert.equal(await f.legacyCredentialStore.load(), TOKEN_A)
  assert.equal(await f.credentials((await f.store.load())!.profiles[0]!.credentialKey).load(), null)
})

test('failed metadata writes keep the old slot and can restore selection without deleting its credential', async (t) => {
  const f = await fixture(t)
  const manager = await f.start()
  const id = await save(manager, A)
  await connect(manager, A, true); await manager.disconnect()
  const before = (await f.store.load())!
  f.store.save = async () => { throw new Error('disk unavailable') }
  await assert.rejects(save(manager, B, 'changed', id), /disk unavailable/)
  assert.equal(await f.credentials(before.profiles[0]!.credentialKey).load(), TOKEN_A)
  assert.deepEqual(await f.fileStore.load(), before)
  assert.equal(view(manager).ready, false)
  f.store.save = f.fileStore.save
  await manager.manageProfiles({ type: 'desktop-client.host-profiles.retry', expectedRevision: view(manager).revision })
  assert.equal(view(manager).ready, true)
  await connect(manager, A)
})

for (const action of ['remove', 'forget'] as const) {
  test(`${action} persists deletion intent and retries only its own credential slot after restart`, async (t) => {
    const f = await fixture(t)
    const manager = await f.start()
    const a = await save(manager, A); await connect(manager, A, true); await manager.disconnect()
    const b = await save(manager, B); await connect(manager, B, true); await manager.disconnect()
    await select(manager, a)
    const before = (await f.store.load())!
    const aKey = before.profiles.find((profile) => profile.id === a)!.credentialKey
    const bKey = before.profiles.find((profile) => profile.id === b)!.credentialKey
    const slot = f.credentials(aKey)
    const clear = slot.clear
    slot.clear = async () => { throw new Error('credential delete unavailable') }
    await assert.rejects(manager.manageProfiles({ type: `desktop-client.host-profiles.${action}`, expectedRevision: view(manager).revision, id: a }), /delete unavailable/)
    assert.equal(view(manager).ready, false)
    assert.deepEqual((await f.store.load())!.pendingCredentialDeletes, [aKey])
    await assert.rejects(connect(manager, A), /重试未完成/)
    await manager.close()
    slot.clear = clear
    const restored = await f.start()
    assert.equal(view(restored).ready, true)
    assert.equal(await slot.load(), null)
    assert.equal(await f.credentials(bKey).load(), TOKEN_B)
    assert.deepEqual((await f.store.load())!.pendingCredentialDeletes, [])
    assert.equal(view(restored).profiles.length, action === 'remove' ? 1 : 2)
    assert.equal(f.calls.includes('logout'), false)
  })
}

test('a credential read failure after selection cannot leave the previous Host client active', async (t) => {
  const f = await fixture(t)
  const manager = await f.start()
  const a = await save(manager, A); await connect(manager, A, true); await manager.disconnect()
  const b = await save(manager, B)
  const bKey = (await f.store.load())!.profiles.find((profile) => profile.id === b)!.credentialKey
  await select(manager, a)
  const slot = f.credentials(bKey)
  const load = slot.load
  slot.load = async () => { throw new Error('credential read unavailable') }
  await assert.rejects(select(manager, b), /read unavailable/)
  assert.equal(view(manager).selectedId, b)
  assert.equal(view(manager).ready, false)
  await assert.rejects(connect(manager, B, true), /重试未完成/)
  slot.load = load
  await manager.manageProfiles({ type: 'desktop-client.host-profiles.retry', expectedRevision: view(manager).revision })
  assert.equal(manager.status().hasStoredCredential, false)
  await connect(manager, B, true)
})

test('profile writes exclude competing mutations, connects and checks, while shutdown drains the writer', async (t) => {
  const f = await fixture(t)
  const manager = await f.start()
  let release!: () => void
  const waiting = new Promise<void>((resolve) => { release = resolve })
  let entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  f.store.save = async (value) => { entered(); await waiting; await f.fileStore.save(value) }
  const pending = save(manager, A)
  await started
  assert.equal(manager.status().phase, 'configuring')
  await assert.rejects(save(manager, B), /先断开/)
  await assert.rejects(connect(manager, A, true), /正在进行/)
  await assert.rejects(manager.checkHost('check', A), /正在进行/)
  let stopped = false
  const closing = manager.close().then(() => { stopped = true })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(stopped, false)
  release()
  await Promise.all([pending, closing])
  assert.equal((await f.store.load())!.profiles.length, 1)
  assert.equal(view(manager).ready, false)
  await assert.rejects(save(manager, B), /先断开/)
})

test('strict Host state rejects secret fields, duplicate slots/endpoints, active deletions and oversized files', async (t) => {
  const f = await fixture(t)
  const manager = await f.start()
  const id = await save(manager, A)
  const state = (await f.store.load())!
  assert.equal(parseDesktopHostProfileState(state).profiles[0]!.id, id)
  const cases = [
    { ...state, token: TOKEN_A },
    { ...state, revision: -1 },
    { ...state, selectedId: randomUUID() },
    { ...state, profiles: [{ ...state.profiles[0], credential: TOKEN_A }] },
    { ...state, profiles: [...state.profiles, { ...state.profiles[0], id: randomUUID() }] },
    { ...state, pendingCredentialDeletes: [state.profiles[0]!.credentialKey] },
    { ...state, legacyCredentialKey: randomUUID() },
    { ...state, profiles: Array.from({ length: 33 }, (_, index) => ({ id: randomUUID(), name: `host ${index}`, credentialKey: randomUUID(), config: { ...A, sshHostAlias: `host-${index}` } })) }
  ]
  for (const value of cases) assert.throws(() => parseDesktopHostProfileState(value))
  const revision = view(manager).revision
  await assert.rejects(save(manager, A, 'duplicate'), /Duplicate/)
  assert.equal(view(manager).revision, revision)
  await writeFile(f.path, ' '.repeat(128 * 1024 + 1))
  await assert.rejects(f.store.load(), /128 KiB/)
})

test('profile commands and connect selection are strictly validated at the shared IPC boundary', () => {
  const id = randomUUID()
  assert.equal(isDesktopClientCommand({ type: 'desktop-client.host-profiles.save', expectedRevision: 0, id: null, name: 'Host', config: A }), true)
  for (const command of [
    { type: 'desktop-client.host-profiles.save', expectedRevision: 0, id, name: '', config: A },
    { type: 'desktop-client.host-profiles.select', expectedRevision: 0, id: 'bad' },
    { type: 'desktop-client.host-profiles.retry', expectedRevision: 0, token: TOKEN_A },
    { type: 'desktop-client.host-profiles.remove', expectedRevision: -1, id },
    { type: 'desktop-client.connect', ...A, profile: { id, revision: 1, token: TOKEN_A } }
  ]) assert.equal(isDesktopClientCommand(command), false)
  assert.equal(isDesktopClientCommand({ type: 'desktop-client.connect', ...A, profile: { id, revision: 1 } }), true)
})

test('native Windows credential slots isolate two profiles and deleting one preserves the other', { skip: process.platform !== 'win32' }, async (t) => {
  const a = createWindowsCredentialManagerStore({ target: desktopHostProfileCredentialTarget(randomUUID()) })
  const b = createWindowsCredentialManagerStore({ target: desktopHostProfileCredentialTarget(randomUUID()) })
  t.after(async () => { await a.clear(); await b.clear() })
  await a.save(TOKEN_A); await b.save(TOKEN_B)
  assert.equal(await a.load(), TOKEN_A)
  assert.equal(await b.load(), TOKEN_B)
  await a.clear()
  assert.equal(await a.load(), null)
  assert.equal(await b.load(), TOKEN_B)
})

test('real HTTP Hosts preserve per-profile pairing through switching, detect a redirected alias, and revoke only the selected Host', {
  skip: process.platform !== 'linux', timeout: 15_000
}, async (t) => {
  const f = await fixture(t)
  const hosts: { port: number; token: string; key: string; gateway: Awaited<ReturnType<typeof startDesktopHostGateway>> }[] = []
  for (const [key, token] of [['host-a', TOKEN_A], ['host-b', TOKEN_B]]) {
    const probe = createServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const address = probe.address()
    assert.ok(address !== null && typeof address !== 'string')
    const port = address.port
    await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()))
    const path = join(dirname(f.path), `${key}.device`)
    const gateway = await startDesktopHostGateway({
      config: { enabled: true, bindHost: '127.0.0.1', port, tokenFile: `${path}.token`, token: 'machine-secret-token-machine-secret-token', deviceStorePath: path },
      productVersion: '1.0.0', buildCommit: 'test-build', deviceStore: await openRemoteDeviceStore({ path, uid: process.getuid!() }),
      randomPairingCode: () => '123456', randomDeviceCredential: () => token!,
      handlers: { getControlIdentity: () => ({ projectKey: `/${key}`, sessionKey: 'session' }), assertCommandPolicy: async () => {},
        dispatchCommand: async () => ({ revision: 1, state: { activeProjectKey: `/${key}`, activeSessionKey: 'session' } } as KernelSnapshot) }
    })
    gateway.createPairingCode()
    hosts.push({ port, token: token!, key: key!, gateway })
    t.after(() => gateway.stop())
  }
  const routes = new Map<number, number>()
  const requests: { port: number; authorization: string | null; path: string }[] = []
  f.options.session.createClient = (options) => new DesktopHostClient({ ...options, fetchImpl: async (input, init) => {
    const url = new URL(String(input))
    url.port = String(routes.get(Number(url.port)) ?? Number(url.port))
    requests.push({ port: Number(url.port), authorization: new Headers(init?.headers).get('authorization'), path: url.pathname })
    return fetch(url, init)
  } })
  const manager = await f.start()
  const aConfig = { ...A, localPort: hosts[0]!.port, desktopHostPort: hosts[0]!.port }
  const bConfig = { ...B, localPort: hosts[1]!.port, desktopHostPort: hosts[1]!.port }
  const a = await save(manager, aConfig)
  assert.equal((await connect(manager, aConfig, true)).state.activeProjectKey, '/host-a')
  await manager.disconnect()
  const b = await save(manager, bConfig)
  assert.equal((await connect(manager, bConfig, true)).state.activeProjectKey, '/host-b')
  await manager.disconnect()
  await select(manager, a)
  const beforeRedirect = requests.length
  routes.set(aConfig.localPort, bConfig.localPort)
  await assert.rejects(connect(manager, aConfig), /配对身份不一致/)
  assert.deepEqual(requests.slice(beforeRedirect).map((request) => [request.port, request.authorization]), [[bConfig.localPort, null]])
  assert.equal(manager.status().hasStoredCredential, true)
  routes.delete(aConfig.localPort)
  assert.equal((await connect(manager, aConfig)).state.activeProjectKey, '/host-a')
  await manager.revokePairing(aConfig, manager.status().hostConnectionId)
  await select(manager, b)
  assert.equal((await connect(manager, bConfig)).state.activeProjectKey, '/host-b')
  await manager.disconnect()
  await manager.manageProfiles({ type: 'desktop-client.host-profiles.remove', expectedRevision: view(manager).revision, id: b })
  const aStatus = await (await fetch(`http://127.0.0.1:${aConfig.localPort}/api/desktop-host/session`, { headers: { Authorization: `Bearer ${TOKEN_A}` } })).json() as { authenticated: boolean }
  const bStatus = await (await fetch(`http://127.0.0.1:${bConfig.localPort}/api/desktop-host/session`, { headers: { Authorization: `Bearer ${TOKEN_B}` } })).json() as { authenticated: boolean }
  assert.equal(aStatus.authenticated, false)
  assert.equal(bStatus.authenticated, true)
  assert.equal(requests.filter((request) => request.path.endsWith('/logout')).length, 1)
})

test('connection IDs reject queued commands, stale revocation and a late native picker across matching Host session identities', async (t) => {
  const { WindowsAttachmentUploader } = await import('./windows-attachment-uploader.ts')
  const f = await fixture(t)
  const manager = await f.start()
  const a = await save(manager, A)
  await connect(manager, A, true)
  const oldId = manager.status().hostConnectionId
  const oldSend = manager.captureDispatch(oldId)
  let selectFiles!: (files: { name: string; data: Uint8Array }[]) => void
  const uploader = new WindowsAttachmentUploader()
  const upload = uploader.upload(randomUUID(), { projectKey: '/project', sessionKey: 'session' },
    async () => new Promise((resolve) => { selectFiles = resolve }), oldSend)
  const rejectedUpload = assert.rejects(upload, /Host 连接已变化/)
  await manager.disconnect()
  await save(manager, B)
  await connect(manager, B, true)
  const newId = manager.status().hostConnectionId
  assert.notEqual(oldId, newId)
  await assert.rejects(manager.dispatch({ type: 'kernel.get-state' }, null, oldId), /Host 连接已变化/)
  await assert.rejects(oldSend({ type: 'kernel.get-state' }), /Host 连接已变化/)
  await assert.rejects(manager.revokePairing(B, oldId), /Host 连接已变化/)
  selectFiles([{ name: 'old-host-only.txt', data: new Uint8Array([1, 2, 3]) }])
  await rejectedUpload
  assert.equal(f.calls.includes('logout'), false)
  assert.equal((await manager.dispatch({ type: 'kernel.get-state' }, null, newId) as KernelSnapshot).state.activeProjectKey, '/project')
  await manager.disconnect()
  await select(manager, a)
  await connect(manager, A)
  assert.notEqual(manager.status().hostConnectionId, oldId)
  await assert.rejects(manager.dispatch({ type: 'kernel.get-state' }, null, oldId), /Host 连接已变化/)
})

test('native Windows migration moves a legacy credential into its persisted profile slot and resumes after restart', { skip: process.platform !== 'win32' }, async (t) => {
  const f = await fixture(t)
  const legacy = createWindowsCredentialManagerStore({ target: `PiGUI/DesktopHost.Migration.${randomUUID()}` })
  const oldHost = createFileDesktopClientHostConfigStore(join(dirname(f.path), 'old-host.json'))
  const slots = new Map<string, DesktopDeviceCredentialStore>()
  f.options.legacyHostStore = oldHost
  f.options.legacyCredentialStore = legacy
  f.options.credentialStoreForKey = (key) => {
    if (!slots.has(key)) slots.set(key, createWindowsCredentialManagerStore({ target: desktopHostProfileCredentialTarget(key) }))
    return slots.get(key)!
  }
  t.after(async () => { for (const slot of slots.values()) await slot.clear(); await legacy.clear() })
  await legacy.save(TOKEN_A)
  await oldHost.save(A)
  const first = await f.start()
  assert.equal(view(first).ready, true)
  assert.equal(first.status().hasStoredCredential, true)
  assert.equal(await legacy.load(), null)
  assert.equal(await oldHost.load(), null)
  const state = (await f.fileStore.load())!
  assert.equal(state.legacyCredentialKey, null)
  assert.equal(await slots.get(state.profiles[0]!.credentialKey)!.load(), TOKEN_A)
  await connect(first, A)
  await first.close()
  const second = await f.start()
  assert.equal(view(second).selectedId, state.selectedId)
  await connect(second, A)
  assert.equal(f.calls.filter((call) => call.startsWith('resume:')).length, 2)
  assert.equal(f.calls.some((call) => call.startsWith('pair:')), false)
})
