import { DESKTOP_HOST_PROTOCOL_VERSION } from '../../shared/desktop-host-contract.ts'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DESKTOP_ATTACHMENT_COMMAND_TYPES, type DesktopAttachmentCommand } from '../../shared/desktop-attachment-contract.ts'
import type { DesktopHostControlIdentity } from '../../shared/desktop-host-contract.ts'
import type { KernelCommand } from '../../shared/kernel-contract.ts'
import type { WorkbenchKernel } from '../kernel/workbench-kernel.ts'
import { DesktopAttachmentStore } from './desktop-attachment-store.ts'
import { DesktopHostClient } from './desktop-host-client.ts'
import { startDesktopHostGateway } from './desktop-host-gateway.ts'
import { openDesktopDeviceStore } from './desktop-device-store.ts'
import { assertDesktopHostKernelCommandPolicy } from './remote-command-policy.ts'
import { WindowsAttachmentUploader } from './windows-attachment-uploader.ts'

test('real HTTP/SSE uploads bounded content and accepts only owned references, never arbitrary Host paths or replay', {
  skip: process.platform !== 'linux', timeout: 20_000
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-http-upload-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const project = join(root, 'project')
  await mkdir(project)
  let current: DesktopHostControlIdentity = { projectKey: project, sessionKey: 'session-A' }
  const submitted: KernelCommand[] = []
  const store = new DesktopAttachmentStore({ root: join(root, 'attachments'), materialize: async (path) => {
    await readFile(path)
    return [{ type: 'file', name: 'from-host', path }]
  } })
  await store.start()
  t.after(() => store.close())
  const reserve = createServer()
  await new Promise<void>((resolve) => reserve.listen(0, '127.0.0.1', resolve))
  const port = (reserve.address() as { port: number }).port
  await new Promise<void>((resolve, reject) => reserve.close((error) => error ? reject(error) : resolve()))
  const kernel = { getState: () => ({ activeProjectKey: project, projects: [{ path: project }] }) } as unknown as WorkbenchKernel
  const gateway = await startDesktopHostGateway({
    config: { enabled: true, bindHost: '127.0.0.1', port, token: 't'.repeat(32), tokenFile: join(root, 'token'), deviceStorePath: join(root, 'device') },
    productVersion: '1.0.0', buildCommit: 'fixture',
    deviceStore: await openDesktopDeviceStore({ path: join(root, 'device'), uid: process.getuid!() }),
    randomPairingCode: () => '123456', randomDeviceCredential: () => 'c'.repeat(43),
    handlers: {
      getControlIdentity: () => current,
      assertCommandPolicy: (command) => assertDesktopHostKernelCommandPolicy(command, { kernel }),
      dispatchCommand: async () => { throw new Error('Raw Kernel paths must not reach this handler') },
      dispatchAttachmentCommand: (command, owner, boundary) => store.dispatch(command, owner, boundary, async (canonical) => {
        submitted.push(canonical)
        return { revision: submitted.length }
      })
    }
  })
  t.after(() => gateway.stop())
  const client = new DesktopHostClient({ localPort: port, compatibility: { productVersion: '1.0.0', buildCommit: 'fixture' } })
  assert.deepEqual((await client.verifyCompatibility()).capabilities.attachmentCommandTypes, DESKTOP_ATTACHMENT_COMMAND_TYPES)
  gateway.createPairingCode()
  const paired = await client.pair('123456')
  const controllerId = randomUUID()
  const stream = await client.openEventStream(controllerId, () => {})
  const streamClosed = stream.closed.then(() => null, (error: unknown) => error)
  t.after(() => stream.close())
  const identity = { ...current }
  const send = (command: DesktopAttachmentCommand) => client.command(controllerId, identity, command)
  const uploader = new WindowsAttachmentUploader((command, observed) => client.command(controllerId, observed, command))
  const bytes = new Uint8Array(Buffer.from('完整内容\n'.repeat(90_000)))
  const refs = await uploader.upload(randomUUID(), identity, async () => [{ name: '中文 空格.txt', data: bytes }])
  assert.equal(refs[0]!.byteCount, bytes.length)
  const submit = { type: 'attachment.submit' as const, mode: 'prompt' as const, message: 'inspect', uploadIds: [refs[0]!.uploadId] }
  await send(submit)
  await assert.rejects(send(submit), /submitted/)
  assert.equal(submitted.length, 1)
  const canonical = submitted[0]!
  if (canonical.type !== 'kernel.prompt') assert.fail('Expected prompt')
  assert.deepEqual(await readFile(canonical.attachments![0]!.path), Buffer.from(bytes))
  assert.equal(canonical.expectedSessionKey, identity.sessionKey)
  await assert.rejects(client.command(controllerId, identity, { type: 'kernel.prompt', message: 'bad', expectedSessionKey: 'session-A',
    attachments: [{ type: 'file', name: 'private', path: '/etc/passwd' }] }), /does not allow attachments/)
  const malformed = await fetch(`http://127.0.0.1:${port}/api/desktop-host/command`, { method: 'POST', headers: {
    'Content-Type': 'application/json', Authorization: `Bearer ${paired.credential}`, 'X-Pi-Gui-Controller-Id': controllerId
  }, body: JSON.stringify({ protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION, requestId: randomUUID(), expectedIdentity: identity,
    command: { type: 'attachment.begin', name: 'file', byteCount: 1, path: '/etc/passwd' } }) })
  assert.equal(malformed.status, 400)
  const unfinished = await uploader.upload(randomUUID(), identity, async () => [{ name: 'draft', data: new Uint8Array([1]) }])
  current = { ...identity, sessionKey: 'session-B' }
  await assert.rejects(send({ ...submit, uploadIds: [unfinished[0]!.uploadId] }), /state changed/)
  await assert.rejects(client.command(controllerId, current, { ...submit, uploadIds: [unfinished[0]!.uploadId] }), /another controller or Session/)
  assert.equal(submitted.length, 1)
  await gateway.revokeDevice(gateway.listDevices()[0]!.deviceId)
  assert.ok(await streamClosed instanceof Error)
  await assert.rejects(send({ type: 'attachment.begin', name: 'revoked', byteCount: 0 }), /Authentication required/)
  await store.close()
  assert.deepEqual(await readdir(join(root, 'attachments', 'drafts')), [])
  assert.deepEqual(await readFile(canonical.attachments![0]!.path), Buffer.from(bytes))
})
