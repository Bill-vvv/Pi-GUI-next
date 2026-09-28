import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertDesktopHostDeviceStoreCompatible, desktopHostDeviceStoreVersions } from './desktop-host-data-compatibility.ts'

const linux = { skip: process.platform !== 'linux' }
const device = { credentialHash: 'a'.repeat(64), pairedAt: 1, expiresAt: 1000 }
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-device-compatibility-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return join(directory, 'host.token.desktop-device')
}

test('legacy builds have the legacy reader, while malformed or unknown explicit declarations fail', () => {
  assert.deepEqual(desktopHostDeviceStoreVersions({}), [1])
  assert.deepEqual(desktopHostDeviceStoreVersions({ desktopHost: { deviceStoreVersions: [1, 2] } }), [1, 2])
  for (const declaration of [undefined, null, [], {}, { deviceStoreVersions: [] }, { deviceStoreVersions: [1, 1] },
    { deviceStoreVersions: [2, 1] }, { deviceStoreVersions: [3] }, { deviceStoreVersions: ['1'] }, { deviceStoreVersions: [1], extra: true }]) {
    assert.throws(() => desktopHostDeviceStoreVersions({ desktopHost: declaration }), /compatibility declaration/)
  }
})

test('compatibility inspection never creates or migrates a device document', linux, async t => {
  const path = await fixture(t)
  await assertDesktopHostDeviceStoreCompatible(path, [1, 2])
  await assert.rejects(lstat(path), { code: 'ENOENT' })
  const original = JSON.stringify({ version: 1, ...device })
  await writeFile(path, original, { mode: 0o600 })
  await assertDesktopHostDeviceStoreCompatible(path, [1])
  await assertDesktopHostDeviceStoreCompatible(path, [1, 2])
  assert.equal(await readFile(path, 'utf8'), original)
})

test('new data blocks an old reader even when every device was revoked', linux, async t => {
  const path = await fixture(t)
  for (const devices of [[], [{ ...device, label: null }]]) {
    const original = JSON.stringify({ version: 2, devices })
    await writeFile(path, original, { mode: 0o600 })
    await assert.rejects(assertDesktopHostDeviceStoreCompatible(path, [1]), /cannot read device store format 2/)
    await assertDesktopHostDeviceStoreCompatible(path, [1, 2])
    assert.equal(await readFile(path, 'utf8'), original)
  }
})

test('the selected reader limit and full document schema are checked without resetting invalid data', linux, async t => {
  const path = await fixture(t)
  const padded = JSON.stringify({ version: 1, ...device }).padEnd(4097, ' ')
  await writeFile(path, padded, { mode: 0o600 })
  await assert.rejects(assertDesktopHostDeviceStoreCompatible(path, [1]), /bounded size/)
  await assertDesktopHostDeviceStoreCompatible(path, [1, 2])
  assert.equal(await readFile(path, 'utf8'), padded)
  for (const value of [null, { version: 3, devices: [] }, { version: 2, devices: [{ ...device, label: null }, { ...device, label: null }] }]) {
    const original = JSON.stringify(value)
    await writeFile(path, original)
    await assert.rejects(assertDesktopHostDeviceStoreCompatible(path, [1, 2]))
    assert.equal(await readFile(path, 'utf8'), original)
  }
})
