import assert from 'node:assert/strict'
import test from 'node:test'
import type { DesktopClientStatus } from '../shared/desktop-client-contract.ts'
import { createDesktopConnectionObservation } from './desktop-connection-observation.ts'

function status(id: string, phase: 'connected' | 'disconnected' = 'connected'): DesktopClientStatus {
  return { mode: 'windows-remote', phase, hostConnectionId: phase === 'connected' ? id : null, hasStoredCredential: true,
    lastHost: null, capabilities: null, error: null, failureKind: null, recovery: null }
}

test('connection observation invalidates old Host requests and never exposes its mutable status owner', async () => {
  const observer = createDesktopConnectionObservation()
  const original = status('first')
  observer.apply(original)
  const captured = observer.connectionId()
  if (original.mode === 'windows-remote') original.hostConnectionId = 'mutated'
  assert.equal(observer.connectionId(), 'first')
  observer.apply(status('first', 'disconnected'))
  assert.equal(observer.connectionId(), null)
  observer.apply(status('second'))
  assert.equal(captured, 'first')
  assert.equal(observer.connectionId(), 'second')
  observer.apply({ mode: 'wsl' })
  assert.equal(observer.connectionId(), null)
})

test('a late get-status response cannot restore the previous connection after a status event', async () => {
  const observer = createDesktopConnectionObservation()
  let resolve!: (value: DesktopClientStatus) => void
  const reading = observer.read(() => new Promise((done) => { resolve = done }))
  observer.apply(status('new-connection'))
  resolve(status('old-connection'))
  assert.deepEqual(await reading, status('new-connection'))
  assert.equal(observer.connectionId(), 'new-connection')
})

test('out-of-order status reads retain the newer accepted read', async () => {
  const observer = createDesktopConnectionObservation()
  let resolve!: (value: DesktopClientStatus) => void
  const first = observer.read(() => new Promise((done) => { resolve = done }))
  await observer.read(async () => status('second-read'))
  resolve(status('first-read'))
  assert.deepEqual(await first, status('second-read'))
})

test('production IPC routes capture the connection ID for Kernel, Git, attachments and revocation', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('./index.ts', import.meta.url), 'utf8')
  const main = await readFile(new URL('../main/index.ts', import.meta.url), 'utf8')
  assert.match(source, /invoke\(KERNEL_COMMAND_CHANNEL, command, identity, desktopConnection\.connectionId\(\)\)/u)
  const git = source.slice(source.indexOf('const gitApi:'), source.indexOf('const desktopConnection ='))
  assert.equal(git.match(/desktopConnection\.connectionId\(\)/gu)?.length, 13)
  const attachments = source.slice(source.indexOf('selectAttachments:'), source.indexOf('getEnvironment:'))
  assert.equal(attachments.match(/desktopConnection\.connectionId\(\)/gu)?.length, 5)
  assert.match(source, /revokePairing:.*desktopConnection\.connectionId\(\)/u)
  assert.match(main, /const send = session\.captureDispatch\(connectionId\)/u)
  assert.match(main, /command\.files, send\)/u)
  assert.match(main, /\}, send\)/u)
  assert.equal(main.match(/session\.dispatch\(command, identity, connectionId\)/gu)?.length, 2)
})
