import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createFileDesktopClientHostConfigStore,
  createMemoryDesktopClientHostConfigStore
} from './desktop-client-host-config-store.ts'
import {
  assertDesktopHostCredential,
  createMemoryDesktopDeviceCredentialStore,
  createWindowsCredentialManagerStore
} from './desktop-device-credential-store.ts'

const HOST = {
  sshHostAlias: 'pi-linux',
  localPort: 18788,
  desktopHostPort: 18788
} as const
const CREDENTIAL = 'B'.repeat(32)

test('Desktop Host credential persistence rejects secrets that are not the Host token alphabet', () => {
  assert.throws(() => assertDesktopHostCredential('short'), /32 to 256/)
  assert.throws(() => assertDesktopHostCredential(`${'A'.repeat(32)}/`), /32 to 256/)
})

test('memory credential store round-trips a single Desktop Host device secret', async () => {
  const store = createMemoryDesktopDeviceCredentialStore()
  assert.equal(await store.load(), null)
  await store.save(CREDENTIAL)
  assert.equal(await store.load(), CREDENTIAL)
  await store.clear()
  assert.equal(await store.load(), null)
})

test('host config store writes alias and ports without a credential field', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-gui-host-config-'))
  const filePath = join(directory, 'desktop-client-host.json')
  try {
    const store = createFileDesktopClientHostConfigStore(filePath)
    await store.save(HOST)
    const saved = await readFile(filePath, 'utf8')
    assert.equal(saved.includes('credential'), false)
    assert.deepEqual(await store.load(), HOST)
    await store.clear()
    assert.equal(await store.load(), null)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('memory host config store is independent from the credential store', async () => {
  const hostStore = createMemoryDesktopClientHostConfigStore()
  const credentialStore = createMemoryDesktopDeviceCredentialStore()
  await hostStore.save(HOST)
  await credentialStore.save(CREDENTIAL)
  await hostStore.clear()
  assert.equal(await credentialStore.load(), CREDENTIAL)
  assert.equal(await hostStore.load(), null)
})

test('Windows Credential Manager stores and clears a generic Desktop Host secret', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows Credential Manager is only available on Windows.')
    return
  }
  const store = createWindowsCredentialManagerStore({
    target: `PiGUI/DesktopHost.Test.${randomUUID()}`
  })
  t.after(() => store.clear())
  await store.clear()
  assert.equal(await store.load(), null)
  await store.save(CREDENTIAL)
  assert.equal(await store.load(), CREDENTIAL)
  await store.clear()
  assert.equal(await store.load(), null)
})
