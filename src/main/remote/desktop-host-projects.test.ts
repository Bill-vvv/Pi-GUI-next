import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { ProjectDirectoryListing } from '../../shared/project-directory-contract.ts'
import type { KernelProjectTrustRequest } from '../../shared/kernel-contract.ts'
import { WorkbenchKernel } from '../kernel/workbench-kernel.ts'
import { dispatchTerminalKernelCommand } from '../kernel/terminal-kernel-command-dispatcher.ts'
import { ProjectStore } from '../project/project-store.ts'
import { startDesktopHostGateway } from './desktop-host-gateway.ts'
import { DesktopHostClient, desktopHostControlIdentity } from './desktop-host-client.ts'
import { openRemoteDeviceStore } from './remote-device-store.ts'
import { assertDesktopHostKernelCommandPolicy } from './remote-command-policy.ts'

test('paired Desktop Host lists and registers projects through the real Kernel, fences stale writes and answers trust', {
  skip: process.platform !== 'linux', timeout: 10_000
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-desktop-projects-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, '中文 项目')
  const second = join(root, 'second')
  await mkdir(project)
  await mkdir(second)
  const store = new ProjectStore({ configHome: join(root, 'config'), stateHome: join(root, 'state') })
  let runtimeCreated = false
  const kernel = new WorkbenchKernel(() => { runtimeCreated = true; throw new Error('Fixture must cancel before Runtime creation.') }, {
    projects: [], activeProjectKey: null
  }, {
    sessionRegistry: { sessions: [], activeSessionKey: null },
    persistProject: async (value) => { await store.addProject(value) },
    persistActiveProject: async (path) => { await store.activateProject(path) },
    persistSession: (pointer) => store.saveSession(pointer),
    persistActiveSession: (path, key, id) => store.setActiveSession(path, key, id),
    persistArchivedSession: (path, key) => store.archiveSession(path, key),
    validateSession: async (pointer) => pointer,
    projectTrust: { inspect: async () => ({ requiresDecision: true, decision: null }), persist: async () => {} }
  })
  const reserve = createServer()
  await new Promise<void>((resolve) => reserve.listen(0, '127.0.0.1', resolve))
  const port = (reserve.address() as { port: number }).port
  await new Promise<void>((resolve, reject) => reserve.close((error) => error ? reject(error) : resolve()))
  const gateway = await startDesktopHostGateway({
    config: { enabled: true, bindHost: '127.0.0.1', port, token: 'm'.repeat(32), tokenFile: join(root, 'token'), deviceStorePath: join(root, 'device') },
    productVersion: '1.0.0', buildCommit: 'fixture',
    deviceStore: await openRemoteDeviceStore({ path: join(root, 'device'), uid: process.getuid!() }),
    randomPairingCode: () => '123456', randomDeviceCredential: () => 'c'.repeat(43),
    handlers: {
      getControlIdentity: () => desktopHostControlIdentity(kernel.getSnapshot()),
      assertCommandPolicy: (command) => assertDesktopHostKernelCommandPolicy(command, { kernel }),
      dispatchCommand: (command, boundary) => dispatchTerminalKernelCommand(command, {
        kernel, projectStore: store, assertCurrentPolicy: async () => {
          await boundary?.()
          await assertDesktopHostKernelCommandPolicy(command, { kernel })
        }
      })
    }
  })
  t.after(() => gateway.stop())
  const unsubscribe = kernel.subscribe((event) => gateway.publish(event))
  t.after(unsubscribe)
  const client = new DesktopHostClient({ localPort: port, compatibility: { productVersion: '1.0.0', buildCommit: 'fixture' } })
  await client.verifyCompatibility()
  gateway.createPairingCode()
  await client.pair('123456')
  const controller = '11111111-1111-4111-8111-111111111111'
  let receiveTrust!: (request: KernelProjectTrustRequest) => void
  const trustShown = new Promise<KernelProjectTrustRequest>((resolve) => { receiveTrust = resolve })
  const stream = await client.openEventStream(controller, (event) => {
    const events = event.type === 'kernel.state-batch' ? event.events : [event]
    for (const update of events) {
      if (update.type === 'kernel.state-changed' && update.state.projectTrustRequest) receiveTrust(update.state.projectTrustRequest)
    }
  })
  t.after(() => stream.close())
  const initial = desktopHostControlIdentity(await client.getState(controller))
  const listing = await client.command(controller, initial, { type: 'kernel.list-project-directories', directoryPath: root }) as ProjectDirectoryListing
  assert.ok(listing.ok)
  assert.ok(listing.entries.some((entry) => entry.path === project))
  await assert.rejects(client.command(controller, initial, { type: 'kernel.add-project' }), /explicit Linux directory/)
  await client.command(controller, initial, { type: 'kernel.add-project', projectPath: project })
  assert.equal(kernel.getState().activeProjectKey, project)
  assert.deepEqual((await store.loadProjects()).projects, [{ path: project }])
  await assert.rejects(client.command(controller, initial, { type: 'kernel.add-project', projectPath: second }), /state changed/)
  const current = desktopHostControlIdentity(await client.getState(controller))
  await client.command(controller, current, { type: 'kernel.add-project', projectPath: project })
  assert.equal(kernel.getState().projects.length, 1)
  await symlink(second, join(root, 'changed-link'))
  await assert.rejects(client.command(controller, current, { type: 'kernel.add-project', projectPath: join(root, 'changed-link') }))
  assert.equal(kernel.getState().projects.length, 1)

  const cancelledStart = assert.rejects(client.command(controller, current, { type: 'kernel.start-session' }))
  const trust = await trustShown
  assert.equal(trust.projectPath, project)
  assert.equal(runtimeCreated, false)
  await assert.rejects(client.command(controller, current, { type: 'kernel.resolve-project-trust', requestId: 'stale', choice: 'once-trusted' }), /stale/)
  await client.command(controller, current, { type: 'kernel.resolve-project-trust', requestId: trust.id, choice: 'cancel' })
  await cancelledStart
  assert.equal(kernel.getState().projectTrustRequest, null)
  assert.equal(runtimeCreated, false)
  await stream.close()
})

test('project registration rechecks navigation after asynchronous registry loading', async () => {
  let registered = false
  let stale = false
  await assert.rejects(dispatchTerminalKernelCommand({ type: 'kernel.add-project', projectPath: '/project' }, {
    kernel: { addProject: async () => { registered = true } } as unknown as WorkbenchKernel,
    projectStore: {
      validateProjectPath: async (path: string) => path,
      loadSessionRegistry: async () => { stale = true; return { sessions: [], activeSessionKey: null } }
    } as unknown as ProjectStore,
    assertCurrentPolicy: async () => { if (stale) throw new Error('Controller navigated away') }
  }), /navigated away/)
  assert.equal(registered, false)
})
