import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, existsSync, readFileSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { workspaceSuffix, canReuseBuild } from './workspace-cache.mjs'
import { createBuildIdentity } from '../src/main/build-identity.ts'

test('running app and validation never acquire the same workspace lock', () => {
  for (const run of ['dev', 'start', 'wsl', 'build']) {
    for (const check of ['typecheck', 'test', 'test-platform']) assert.notEqual(workspaceSuffix(run), workspaceSuffix(check))
  }
})

test('build reuse verifies artifacts and rebuilds when source or build scripts change', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-gui-build-reuse-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const write = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text) }
  for (const path of ['src/main.ts', 'scripts/build.mjs', 'extensions/x.ts', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'electron.vite.config.ts', 'vite.remote.config.ts', 'out/main/index.js', 'out/preload/index.cjs', 'out/renderer/index.html']) write(path, 'fixture\n')
  write('package.json', JSON.stringify({ build: { extraResources: [] } }))
  assert.equal(canReuseBuild(root), false)
  write('out/main/build-identity.json', JSON.stringify(createBuildIdentity(root, 'a'.repeat(40))))
  assert.equal(canReuseBuild(root), true)
  for (const file of ['src/main.ts', 'scripts/build.mjs']) {
    write(file, 'changed\n')
    assert.equal(canReuseBuild(root), false)
    write(file, 'fixture\n')
  }
  write('out/main/index.js', 'broken\n')
  assert.throws(() => canReuseBuild(root), /Build artifact changed/)
})

test('validation completes while dev stays alive and synchronizes edits and executable bits', { skip: process.platform !== 'linux', timeout: 20_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-gui-workspace-parallel-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, 'source')
  const bin = join(root, 'bin')
  mkdirSync(bin)
  mkdirSync(join(source, 'scripts'), { recursive: true })
  mkdirSync(join(source, 'src/main'), { recursive: true })
  const project = dirname(dirname(fileURLToPath(import.meta.url)))
  for (const path of ['scripts/workspace.mjs', 'scripts/workspace-cache.mjs', 'src/main/build-identity.ts']) cpSync(join(project, path), join(source, path))
  writeFileSync(join(source, 'package.json'), JSON.stringify({ type: 'module', engines: { node: process.versions.node } }))
  for (const file of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) writeFileSync(join(source, file), '')
  writeFileSync(join(source, 'sample.sh'), 'first\n')
  execFileSync('git', ['init', '-q', source])
  execFileSync('git', ['-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'])
  // The long-lived dev process stands in for electron-vite; source sync and locks are real.
  writeFileSync(join(bin, 'pnpm'), `#!${process.execPath}\nconst fs = require('node:fs');\nif (process.argv[2] === 'install') fs.mkdirSync('node_modules', { recursive: true });\nelse if (process.argv[3] === 'dev') { fs.writeFileSync(${JSON.stringify(join(root, 'dev-path'))}, process.cwd()); setInterval(() => {}, 1000); process.on('SIGINT', () => process.exit(0)); }\nelse { process.stdout.write(fs.readFileSync('sample.sh')); }\n`)
  chmodSync(join(bin, 'pnpm'), 0o755)
  const env = { ...process.env, XDG_CACHE_HOME: join(root, 'cache'), PATH: `${bin}:${process.env.PATH}` }
  const dev = spawn(process.execPath, [join(source, 'scripts/workspace.mjs'), 'dev'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  dev.stdout.on('data', (chunk) => { output += chunk })
  dev.stderr.on('data', (chunk) => { output += chunk })
  const closed = new Promise((resolve) => dev.once('close', resolve))
  t.after(async () => { if (dev.exitCode === null) dev.kill('SIGTERM'); await closed })
  const until = async (condition) => {
    const deadline = Date.now() + 8000
    while (!condition()) {
      assert.equal(dev.exitCode, null, output)
      assert.ok(Date.now() < deadline, output)
      await delay(50)
    }
  }
  await until(() => existsSync(join(root, 'dev-path')))
  const devPath = readFileSync(join(root, 'dev-path'), 'utf8')
  const result = execFileSync(process.execPath, [join(source, 'scripts/workspace.mjs'), 'typecheck'], { env, encoding: 'utf8', timeout: 8000 })
  assert.match(result, /-checks/)
  assert.match(result, /first/)
  assert.ok(existsSync(join(devPath, '.workspace-lock')))
  writeFileSync(join(source, 'sample.sh'), 'second\n')
  chmodSync(join(source, 'sample.sh'), 0o755)
  await until(() => readFileSync(join(devPath, 'sample.sh'), 'utf8') === 'second\n')
  assert.match(output, /Source synchronization:/)
  chmodSync(join(source, 'sample.sh'), 0o644)
  const { statSync } = await import('node:fs')
  await until(() => (statSync(join(devPath, 'sample.sh')).mode & 0o777) === 0o644)
  dev.kill('SIGTERM')
  assert.equal(await closed, 0, output)
  assert.equal(existsSync(join(devPath, '.workspace-lock')), false)
})
