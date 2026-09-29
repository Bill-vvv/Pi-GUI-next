import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile, stat } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { copyHostRuntimePackages, hostRuntimePackageDigest, planHostRuntimePackages } from './desktop-host-runtime-package.ts'

const linux = { skip: process.platform !== 'linux' }
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const temp = await mkdtemp(join(tmpdir(), 'pi-host-packages-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const root = join(temp, 'build'), output = join(temp, 'output')
  const write = async (path: string, value: string) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, value) }
  const pkg = async (path: string, manifest: object, code = "module.exports = 'fixture'") => {
    await write(join(root, path, 'package.json'), JSON.stringify(manifest))
    await write(join(root, path, 'index.js'), code)
    return join(root, path)
  }
  const bind = async (path: string, target: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await symlink(relative(dirname(join(root, path)), join(root, target)), join(root, path))
  }
  await pkg('', { dependencies: { alpha: '1' }, devDependencies: { unused: '1', electron: '1' }, build: { extraResources: [{ from: 'extensions/shipped' }] } })
  await pkg('node_modules/electron', { name: 'electron' })
  await pkg('node_modules/unused', { name: 'unused' })
  await pkg('extensions/shipped', { dependencies: { alias: 'npm:leaf@1' }, peerDependencies: { peer: '1' } }, "module.exports = [require('alias'), require('peer')]")
  await pkg('extensions/unshipped', { dependencies: { absent: '1' } })
  await pkg('node_modules/.pnpm/alpha@1/node_modules/alpha', { name: 'alpha', dependencies: { leaf: '1' }, optionalDependencies: { absent: '1' } }, "module.exports = require('leaf')")
  await pkg('node_modules/.pnpm/leaf@1/node_modules/leaf', { name: 'leaf', dependencies: { alpha: '1' } }, "module.exports = 'leaf'")
  await pkg('node_modules/peer', { name: 'peer' }, "module.exports = 'peer'")
  await bind('node_modules/alpha', 'node_modules/.pnpm/alpha@1/node_modules/alpha')
  await bind('node_modules/.pnpm/alpha@1/node_modules/leaf', 'node_modules/.pnpm/leaf@1/node_modules/leaf')
  await bind('extensions/shipped/node_modules/alias', 'node_modules/.pnpm/leaf@1/node_modules/leaf')
  return { temp, root, output, pkg, bind, write }
}

test('runtime graph preserves cyclic pnpm bindings, aliases, extension peers and package assets after the source disappears', linux, async t => {
  const f = await fixture(t)
  await f.write(join(f.root, 'node_modules/.pnpm/leaf@1/node_modules/leaf/assets/template.md'), 'runtime asset')
  const plan = await planHostRuntimePackages(f.root)
  assert.equal(plan.packages.length, 3)
  assert.deepEqual(plan.extensions, ['extensions/shipped'])
  assert.deepEqual(plan.missingOptional, [{ from: 'node_modules/.pnpm/alpha@1/node_modules/alpha', name: 'absent' }])
  const digest = await hostRuntimePackageDigest(plan)
  await copyHostRuntimePackages(plan, f.output)
  assert.equal(await hostRuntimePackageDigest(plan, f.output), digest)
  await rm(f.root, { recursive: true })
  const require = createRequire(join(f.output, 'package.json'))
  assert.equal(require('alpha'), 'leaf')
  assert.deepEqual(require('./extensions/shipped'), ['leaf', 'peer'])
  assert.equal(await readFile(join(f.output, 'node_modules/.pnpm/leaf@1/node_modules/leaf/assets/template.md'), 'utf8'), 'runtime asset')
  await assert.rejects(stat(join(f.output, 'node_modules/unused')), { code: 'ENOENT' })
  // The Node Host bundle carries no Electron (D-095).
  await assert.rejects(stat(join(f.output, 'node_modules/electron')), { code: 'ENOENT' })
  await assert.rejects(stat(join(f.output, 'extensions/unshipped')), { code: 'ENOENT' })
})

test('nested npm dependencies survive and installed optional dependencies are retained', linux, async t => {
  const f = await fixture(t)
  await f.pkg('node_modules/.pnpm/alpha@1/node_modules/alpha/node_modules/leaf', { name: 'leaf' }, "module.exports = 'nested'")
  await f.pkg('node_modules/.pnpm/alpha@1/node_modules/alpha/node_modules/absent', { name: 'absent' })
  const plan = await planHostRuntimePackages(f.root)
  await copyHostRuntimePackages(plan, f.output)
  assert.equal(await hostRuntimePackageDigest(plan), await hostRuntimePackageDigest(plan, f.output))
  await rm(f.root, { recursive: true })
  assert.equal(createRequire(join(f.output, 'package.json'))('alpha'), 'nested')
  assert.equal(plan.missingOptional.length, 0)
})

test('missing required dependencies and peers fail instead of relying on the build machine', linux, async t => {
  const f = await fixture(t)
  await rm(join(f.root, 'node_modules/peer'), { recursive: true })
  await assert.rejects(planHostRuntimePackages(f.root), /Required runtime dependency is missing: peer/)
  await f.pkg('node_modules/peer', { name: 'peer' })
  await rm(join(f.root, 'node_modules/alpha'))
  await assert.rejects(planHostRuntimePackages(f.root), /Required runtime dependency is missing: alpha/)
})

test('foreign package links, escaping package assets and source-overlapping output are rejected', linux, async t => {
  const f = await fixture(t)
  const plan = await planHostRuntimePackages(f.root)
  await assert.rejects(copyHostRuntimePackages(plan, join(f.root, 'copy')), /separate from the source/)
  await symlink(f.root, join(f.temp, 'alias'))
  await assert.rejects(copyHostRuntimePackages(plan, join(f.temp, 'alias/copy')), /separate from the source/)
  await assert.rejects(stat(join(f.root, 'copy')), { code: 'ENOENT' })
  await f.write(join(f.temp, 'outside/package.json'), '{}')
  await symlink(join(f.temp, 'outside'), join(f.root, 'node_modules/peer/foreign'))
  await assert.rejects(hostRuntimePackageDigest(plan), /link escapes/)
  await rm(join(f.root, 'node_modules/peer'), { recursive: true })
  await symlink(join(f.temp, 'outside'), join(f.root, 'node_modules/peer'))
  await assert.rejects(planHostRuntimePackages(f.root), /leaves the build/)
})

test('extension resource paths cannot select the build root or escape it', linux, async t => {
  const f = await fixture(t)
  for (const from of ['extensions/..', 'extensions/../outside', 'extensions/./shipped', 'extensions/shipped/../other']) {
    await f.pkg('', { build: { extraResources: [{ from }] } })
    await assert.rejects(planHostRuntimePackages(f.root), /Unsupported Host runtime resource path/)
  }
})
