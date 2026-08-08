import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  deriveRemoteDeviceStorePath,
  hashRemoteDeviceCredential,
  openRemoteDeviceStore,
  REMOTE_DEVICE_STORE_VERSION
} from './remote-device-store.ts'

const uid = process.getuid!()

async function withStoreDir(run: (directory: string, storePath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'pi-gui-remote-device-'))
  try {
    await run(directory, join(directory, 'remote.token.device'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('deriveRemoteDeviceStorePath is a deterministic sibling of the token file', () => {
  assert.equal(
    deriveRemoteDeviceStorePath('/var/lib/pi-gui/remote.token'),
    '/var/lib/pi-gui/remote.token.device'
  )
})

test('missing store means no device', async () => {
  await withStoreDir(async (_directory, storePath) => {
    const store = await openRemoteDeviceStore({ path: storePath, uid })
    assert.equal(store.getDevice(), null)
  })
})

test('replaceDevice persists only fixed-length hash and timestamps with mode 0600', async () => {
  await withStoreDir(async (_directory, storePath) => {
    const store = await openRemoteDeviceStore({ path: storePath, uid })
    const credential = 'c'.repeat(43)
    const credentialHash = hashRemoteDeviceCredential(credential)
    await store.replaceDevice({
      credentialHash,
      pairedAt: 1_000,
      expiresAt: 2_000
    })
    assert.deepEqual(store.getDevice(), {
      credentialHash,
      pairedAt: 1_000,
      expiresAt: 2_000
    })

    const raw = await readFile(storePath, 'utf8')
    assert.equal(raw.includes(credential), false)
    assert.equal(raw.includes('123456'), false)
    const parsed = JSON.parse(raw) as {
      version: number
      credentialHash: string
      pairedAt: number
      expiresAt: number
    }
    assert.deepEqual(parsed, {
      version: REMOTE_DEVICE_STORE_VERSION,
      credentialHash,
      pairedAt: 1_000,
      expiresAt: 2_000
    })
    assert.match(parsed.credentialHash, /^[0-9a-f]{64}$/u)

    const reopened = await openRemoteDeviceStore({ path: storePath, uid })
    assert.deepEqual(reopened.getDevice(), {
      credentialHash,
      pairedAt: 1_000,
      expiresAt: 2_000
    })
  })
})

test('clearDevice removes the store file', async () => {
  await withStoreDir(async (_directory, storePath) => {
    const store = await openRemoteDeviceStore({ path: storePath, uid })
    await store.replaceDevice({
      credentialHash: hashRemoteDeviceCredential('d'.repeat(40)),
      pairedAt: 10,
      expiresAt: 20
    })
    await store.clearDevice()
    assert.equal(store.getDevice(), null)
    await assert.rejects(() => readFile(storePath), /ENOENT/)
  })
})

test('clearDevice closes in-memory authorization even when persistence fails', async () => {
  await withStoreDir(async (directory, storePath) => {
    const store = await openRemoteDeviceStore({ path: storePath, uid })
    await store.replaceDevice({
      credentialHash: hashRemoteDeviceCredential('e'.repeat(40)),
      pairedAt: 10,
      expiresAt: 20
    })

    await chmod(directory, 0o500)
    try {
      await assert.rejects(() => store.clearDevice(), /EACCES|permission denied/i)
      assert.equal(store.getDevice(), null)
    } finally {
      await chmod(directory, 0o700)
    }
  })
})

test('insecure mode, symlink, and invalid schema fail startup', async () => {
  await withStoreDir(async (directory, storePath) => {
    await writeFile(storePath, JSON.stringify({
      version: 1,
      credentialHash: 'a'.repeat(64),
      pairedAt: 1,
      expiresAt: 2
    }), { mode: 0o644 })
    await chmod(storePath, 0o644)
    await assert.rejects(() => openRemoteDeviceStore({ path: storePath, uid }), /mode 0600/)

    await rm(storePath)
    const target = join(directory, 'target')
    await writeFile(target, JSON.stringify({
      version: 1,
      credentialHash: 'b'.repeat(64),
      pairedAt: 1,
      expiresAt: 2
    }), { mode: 0o600 })
    await chmod(target, 0o600)
    await symlink(target, storePath)
    await assert.rejects(() => openRemoteDeviceStore({ path: storePath, uid }), /non-symlink|ELOOP|EINVAL/)

    await rm(storePath)
    await writeFile(storePath, JSON.stringify({
      version: 1,
      credentialHash: 'not-hex',
      pairedAt: 1,
      expiresAt: 2
    }), { mode: 0o600 })
    await chmod(storePath, 0o600)
    await assert.rejects(() => openRemoteDeviceStore({ path: storePath, uid }), /credential hash/)

    await writeFile(storePath, JSON.stringify({
      version: 1,
      credentialHash: 'c'.repeat(64),
      pairedAt: 5,
      expiresAt: 5,
      extra: true
    }), { mode: 0o600 })
    await chmod(storePath, 0o600)
    await assert.rejects(() => openRemoteDeviceStore({ path: storePath, uid }), /schema/)
  })
})

test('serialized replaceDevice keeps the last write', async () => {
  await withStoreDir(async (_directory, storePath) => {
    const store = await openRemoteDeviceStore({ path: storePath, uid })
    await Promise.all([
      store.replaceDevice({
        credentialHash: hashRemoteDeviceCredential('first-credential-value-xxxxxx'),
        pairedAt: 1,
        expiresAt: 10
      }),
      store.replaceDevice({
        credentialHash: hashRemoteDeviceCredential('second-credential-value-xxxxx'),
        pairedAt: 2,
        expiresAt: 20
      })
    ])
    const device = store.getDevice()
    assert.deepEqual(device, {
      credentialHash: hashRemoteDeviceCredential('second-credential-value-xxxxx'),
      pairedAt: 2,
      expiresAt: 20
    })
    const reopened = await openRemoteDeviceStore({ path: storePath, uid })
    assert.deepEqual(reopened.getDevice(), device)
  })
})
