import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { PiExtensionStore, resolvePiAgentDir } from './pi-extension-store.ts'

test('uses Pi user settings extensions and preserves unrelated fields', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-gui-extension-store-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const settingsPath = join(directory, 'settings.json')
  const extensionPath = join(directory, 'sample.ts')
  await writeFile(extensionPath, 'export default () => {}\n', 'utf8')
  await writeFile(settingsPath, JSON.stringify({ defaultModel: 'model-a', extensions: [] }), 'utf8')

  const store = new PiExtensionStore(directory)
  assert.deepEqual(await store.install(extensionPath), [{ path: extensionPath, name: 'sample' }])
  assert.deepEqual(await store.install(extensionPath), [{ path: extensionPath, name: 'sample' }])

  const installedSettings = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>
  assert.equal(installedSettings.defaultModel, 'model-a')
  assert.deepEqual(installedSettings.extensions, [extensionPath])

  assert.deepEqual(await store.remove(extensionPath), [])
  assert.equal((await stat(extensionPath)).isFile(), true)
  const removedSettings = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>
  assert.equal(removedSettings.defaultModel, 'model-a')
  assert.deepEqual(removedSettings.extensions, [])
})

test('accepts a directory as a configured Pi Extension path', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-gui-extension-dir-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const extensionDirectory = join(directory, 'my-extension')
  await mkdir(extensionDirectory)

  const store = new PiExtensionStore(directory)
  assert.deepEqual(await store.install(extensionDirectory), [{
    path: extensionDirectory,
    name: 'my-extension'
  }])
})

test('lists configured paths without treating them as packages', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-gui-extension-list-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, 'settings.json'), JSON.stringify({
    extensions: ['/opt/pi/one.ts', '~/extensions/two.js', './extensions/three']
  }), 'utf8')

  assert.deepEqual(await new PiExtensionStore(directory).list(), [
    { path: '/opt/pi/one.ts', name: 'one' },
    { path: '~/extensions/two.js', name: 'two' },
    { path: './extensions/three', name: 'three' }
  ])
})

test('rejects files Pi does not load as Extension modules', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-gui-extension-invalid-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const textPath = join(directory, 'notes.txt')
  await writeFile(textPath, 'not an extension\n', 'utf8')

  await assert.rejects(
    new PiExtensionStore(directory).install(textPath),
    /必须是 \.ts\/\.js 文件或目录/u
  )
})

test('fails fast when Pi settings extensions has the wrong shape', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-gui-extension-settings-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ extensions: 'sample.ts' }), 'utf8')

  await assert.rejects(new PiExtensionStore(directory).list(), /extensions 必须是字符串数组/u)
})

test('resolves the same Pi user agent directory convention', () => {
  assert.equal(resolvePiAgentDir(undefined, '/home/tester'), '/home/tester/.pi/agent')
  assert.equal(resolvePiAgentDir('~/custom-pi', '/home/tester'), '/home/tester/custom-pi')
})
