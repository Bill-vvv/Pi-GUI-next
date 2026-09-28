import assert from 'node:assert/strict'
import test from 'node:test'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDesktopDeviceStore, DESKTOP_DEVICE_LIMIT, type DesktopDeviceRecord } from './desktop-device-store.ts'
import { hashRemoteDeviceCredential, openRemoteDeviceStore } from './remote-device-store.ts'

const linux = { skip: process.platform !== 'linux' }
const uid = process.getuid?.() ?? -1
const record = (name: string, expiresAt = 10_000): DesktopDeviceRecord => ({
  credentialHash: hashRemoteDeviceCredential(`private-credential-${name}`), pairedAt: 100, expiresAt, label: name
})
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-desktop-devices-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = join(directory, 'host.token.desktop-device')
  let time = 1000
  const options = { path, uid, now: () => time }
  const load = () => openDesktopDeviceStore(options)
  return { directory, path, options, load, setTime: (next: number) => { time = next } }
}

test('Desktop stores independent devices across restart without changing the separate Web pairing', linux, async t => {
  const f = await fixture(t), desktop = await f.load()
  assert.deepEqual(desktop.getDevices(), [])
  const webPath = join(f.directory, 'host.token.device')
  const web = await openRemoteDeviceStore({ path: webPath, uid })
  const { label: _label, ...webRecord } = record('web')
  await web.replaceDevice(webRecord)
  const webBytes = await readFile(webPath)
  await desktop.addDevice(record('工作机'))
  await desktop.addDevice(record('Laptop'))
  assert.deepEqual((await f.load()).getDevices(), [record('工作机'), record('Laptop')])
  await desktop.revokeDevice(record('工作机').credentialHash)
  assert.deepEqual((await f.load()).getDevices(), [record('Laptop')])
  assert.deepEqual(await readFile(webPath), webBytes)
  assert.deepEqual((await openRemoteDeviceStore({ path: webPath, uid })).getDevice(), webRecord)
  assert.equal((await lstat(f.path)).mode & 0o777, 0o600)
  assert.ok(!(await readFile(f.path, 'utf8')).includes('private-credential-'))
})

test('legacy migration preserves the original credential hash and validity, and is idempotent', linux, async t => {
  const f = await fixture(t)
  const { label: _label, ...old } = record('previous', 500)
  const legacy = await openRemoteDeviceStore({ path: f.path, uid })
  await legacy.replaceDevice(old)
  const desktop = await f.load()
  assert.deepEqual(desktop.getDevices(), [{ ...old, label: null }])
  const migrated = await readFile(f.path)
  assert.deepEqual(JSON.parse(migrated.toString()), { version: 2, devices: [{ ...old, label: null }] })
  assert.deepEqual((await f.load()).getDevices(), desktop.getDevices())
  assert.deepEqual(await readFile(f.path), migrated)
  // An expired migrated device stays expired and is removed on the next pairing.
  await desktop.addDevice(record('new'))
  assert.deepEqual((await f.load()).getDevices(), [record('new')])
  await assert.rejects(openRemoteDeviceStore({ path: f.path, uid }), /schema|version/)
})

test('concurrent pairing enforces the device limit without replacing existing credentials', linux, async t => {
  const f = await fixture(t), store = await f.load()
  const results = await Promise.allSettled(Array.from({ length: DESKTOP_DEVICE_LIMIT + 1 }, (_, index) => store.addDevice(record(`device-${index}`))))
  assert.equal(results.filter(result => result.status === 'fulfilled').length, DESKTOP_DEVICE_LIMIT)
  assert.equal(results.at(-1)?.status, 'rejected')
  assert.deepEqual((await f.load()).getDevices(), Array.from({ length: DESKTOP_DEVICE_LIMIT }, (_, index) => record(`device-${index}`)))
  const before = await readFile(f.path)
  await assert.rejects(store.addDevice(record('device-0')), /already exists/)
  assert.deepEqual(await readFile(f.path), before)
  await store.revokeDevice(record('device-3').credentialHash)
  await store.addDevice(record('replacement'))
  assert.equal(store.getDevices().length, DESKTOP_DEVICE_LIMIT)
  assert.equal(store.getDevices()[0].credentialHash, record('device-0').credentialHash)
})

test('revocation fails closed for just that device and retry persists the pending removal', linux, async t => {
  const f = await fixture(t), store = await f.load()
  await store.addDevice(record('first')); await store.addDevice(record('second'))
  const before = await readFile(f.path)
  await chmod(f.directory, 0o500)
  try {
    await assert.rejects(store.revokeDevice(record('first').credentialHash), /EACCES|permission denied/i)
    assert.deepEqual(store.getDevices(), [record('second')])
    assert.deepEqual(await readFile(f.path), before)
    await assert.rejects(store.addDevice(record('third')), /EACCES|permission denied/i)
    assert.deepEqual(store.getDevices(), [record('second')])
  } finally { await chmod(f.directory, 0o700) }
  await store.revokeDevice(record('first').credentialHash)
  assert.deepEqual((await f.load()).getDevices(), [record('second')])
  await store.revokeDevice(record('second').credentialHash)
  assert.deepEqual((await f.load()).getDevices(), [])
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')), { version: 2, devices: [] })
})

test('failed migration and rejected additions retain the prior document and do not leave temporary files', linux, async t => {
  const f = await fixture(t)
  const { label: _label, ...old } = record('previous')
  await writeFile(f.path, JSON.stringify({ version: 1, ...old }), { mode: 0o600 })
  const original = await readFile(f.path)
  await chmod(f.directory, 0o500)
  try { await assert.rejects(f.load(), /EACCES|permission denied/i); assert.deepEqual(await readFile(f.path), original) }
  finally { await chmod(f.directory, 0o700) }
  const store = await f.load(), migrated = await readFile(f.path)
  for (const value of [{ ...record('invalid'), label: ' '.repeat(5) }, { ...record('invalid'), label: 'bad\nlabel' },
    { ...record('invalid'), label: 'x'.repeat(81) }, { ...record('invalid'), expiresAt: 1000 },
    { ...record('invalid'), pairedAt: 1001 }, { ...record('invalid'), credentialHash: 'not a hash' }]) {
    await assert.rejects(store.addDevice(value))
    assert.deepEqual(await readFile(f.path), migrated)
  }
  await assert.rejects(store.revokeDevice('bad hash'), /hash/)
  assert.deepEqual(await readdir(f.directory), ['host.token.desktop-device'])
})

test('queued writes capture their inputs and returned snapshots cannot change authorization or the storage path', linux, async t => {
  const f = await fixture(t), store = await f.load(), value = record('original')
  const adding = store.addDevice(value)
  value.credentialHash = record('changed').credentialHash; value.label = 'changed'
  f.options.path = join(f.directory, 'unexpected-store')
  await adding
  const snapshot = store.getDevices()
  snapshot[0].credentialHash = record('changed').credentialHash; snapshot.pop()
  assert.deepEqual(store.getDevices(), [record('original')])
  assert.deepEqual((await openDesktopDeviceStore({ path: f.path, uid, now: () => 1000 })).getDevices(), [record('original')])
  await assert.rejects(lstat(f.options.path), { code: 'ENOENT' })
})

test('failed atomic replacement removes its candidate and never grants the new credential', linux, async t => {
  const f = await fixture(t), store = await f.load()
  await store.addDevice(record('existing'))
  await rm(f.path)
  await mkdir(f.path, { mode: 0o700 })
  await writeFile(join(f.path, 'obstruction'), 'retain this file')
  await assert.rejects(store.addDevice(record('new')), /EISDIR|ENOTEMPTY/)
  assert.deepEqual(store.getDevices(), [record('existing')])
  assert.equal(await readFile(join(f.path, 'obstruction'), 'utf8'), 'retain this file')
  assert.deepEqual(await readdir(f.directory), ['host.token.desktop-device'])
})

test('expired capacity is reclaimed at pairing, while invalid clocks cannot change the document', linux, async t => {
  const f = await fixture(t), store = await f.load()
  for (let index = 0; index < DESKTOP_DEVICE_LIMIT; index++) await store.addDevice(record(`device-${index}`, 2000))
  f.setTime(2000)
  await store.addDevice({ ...record('next', 5000), pairedAt: 2000 })
  assert.equal(store.getDevices().length, 1)
  const before = await readFile(f.path)
  f.setTime(Number.NaN)
  await assert.rejects(store.addDevice(record('invalid clock')), /clock/)
  assert.deepEqual(await readFile(f.path), before)
})

test('malformed collections, invalid UTF-8, oversize, wrong ownership and unsafe files are rejected without resets', linux, async t => {
  const f = await fixture(t)
  for (const document of [null, [], { version: 3, devices: [] }, { version: 2, devices: [], extra: true },
    { version: 2, devices: [record('same'), record('same')] }, { version: 2, devices: Array.from({ length: 9 }, (_, i) => record(String(i))) },
    { version: 2, devices: [{ ...record('extra'), unknown: true }] }, { version: 2, devices: [{ ...record('date'), pairedAt: 0.5 }] }]) {
    const bytes = JSON.stringify(document)
    await writeFile(f.path, bytes, { mode: 0o600 })
    await assert.rejects(f.load()); assert.equal(await readFile(f.path, 'utf8'), bytes)
  }
  const encoded = JSON.stringify({ version: 2, devices: [record('UTF8_MARKER')] }).split('UTF8_MARKER')
  const invalidUtf8Label = Buffer.concat([Buffer.from(encoded[0]), Buffer.from([0xc0, 0xaf]), Buffer.from(encoded[1])])
  for (const bytes of [Buffer.from('private-invalid-json'), invalidUtf8Label, Buffer.alloc(16 * 1024 + 1, 0x20)]) {
    await writeFile(f.path, bytes)
    await assert.rejects(f.load(), error => error instanceof Error && !error.message.includes('private-invalid-json'))
    assert.deepEqual(await readFile(f.path), bytes)
  }
  await writeFile(f.path, '{"version":2,"devices":[]}')
  await assert.rejects(openDesktopDeviceStore({ path: f.path, uid: uid + 1 }), /owned/)
  await chmod(f.path, 0o644); await assert.rejects(f.load(), /0600/)
  await rm(f.path); await symlink(join(f.directory, 'elsewhere'), f.path)
  await assert.rejects(f.load(), /non-symlink/)
  await rm(f.path); await mkdir(f.path, { mode: 0o700 }); await assert.rejects(f.load(), /regular file/)
  await rm(f.path, { recursive: true })
  assert.equal(spawnSync('mkfifo', ['-m', '600', f.path]).status, 0)
  // A bounded child ensures a regression cannot hang the whole test runner.
  const program = `import {openDesktopDeviceStore} from ${JSON.stringify(new URL('./desktop-device-store.ts', import.meta.url).href)};
    try { await openDesktopDeviceStore({path:process.argv[1],uid:process.getuid()}); process.exitCode=2; }
    catch(error) { if(!error.message.includes('regular file')) throw error; }`
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', program, f.path], { encoding: 'utf8', timeout: 3000 })
  assert.equal(child.status, 0, child.stderr || child.error?.message || 'FIFO check did not exit successfully')
})
