import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, symlinkSync, readlinkSync, existsSync, rmSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createBuildIdentity } from '../src/main/build-identity.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
test('WSL deployment retains the working release on failure and removes deleted files on success', { skip: process.platform !== 'linux' }, (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'pi-gui-wsl-deploy-'))
  t.after(() => rmSync(temp, { recursive: true, force: true }))
  const data = join(temp, 'data')
  const base = join(data, 'pi-gui-next-wsl')
  const write = (path, text, mode) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text, { mode }) }
  mkdirSync(join(base, 'node/bin'), { recursive: true })
  symlinkSync(process.execPath, join(base, 'node/bin/node'))
  write(join(base, 'tooling/node_modules/.bin/pnpm'), '#!/bin/sh\nset -eu\n[ "${PI_GUI_TEST_FAIL:-0}" != 1 ]\n', 0o700)
  const candidate = join(temp, 'source')
  for (const path of ['src/main/build-identity.ts', 'scripts/verify-build.mjs', 'scripts/start-wsl-host.sh']) {
    mkdirSync(dirname(join(candidate, path)), { recursive: true })
    cpSync(join(root, path), join(candidate, path))
  }
  mkdirSync(join(candidate, 'extensions'), { recursive: true })
  for (const path of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'electron.vite.config.ts', 'vite.remote.config.ts', 'out/main/index.js', 'out/main/pi-host.js', 'out/preload/index.cjs', 'out/renderer/index.html']) write(join(candidate, path), 'fixture\n')
  write(join(candidate, 'package.json'), JSON.stringify({ build: { extraResources: [] } }))
  write(join(candidate, 'out/removed.js'), 'old\n')
  const archive = join(temp, 'app.tar')
  const pack = () => {
    const identity = createBuildIdentity(candidate, 'a'.repeat(40))
    write(join(candidate, 'out/main/build-identity.json'), JSON.stringify(identity))
    execFileSync('tar', ['-cf', archive, '-C', candidate, '.'])
  }
  const deploy = (fail) => spawnSync('sh', [join(root, 'scripts/setup-wsl-host.sh'), archive], {
    encoding: 'utf8', env: { ...process.env, XDG_DATA_HOME: data, PI_GUI_TEST_FAIL: fail ? '1' : '0' }
  })
  pack()
  let result = deploy(false)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const first = readlinkSync(join(base, 'current'))
  result = deploy(true)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /Reusing verified WSL backend/)
  assert.equal(readlinkSync(join(base, 'current')), first)
  rmSync(join(candidate, 'out/removed.js'))
  write(join(candidate, 'out/main/index.js'), 'new\n')
  pack()
  result = deploy(true)
  assert.notEqual(result.status, 0)
  assert.equal(readlinkSync(join(base, 'current')), first)
  assert.equal(readFileSync(join(first, 'out/main/index.js'), 'utf8'), 'fixture\n')
  result = deploy(false)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.notEqual(readlinkSync(join(base, 'current')), first)
  assert.equal(readlinkSync(join(base, 'previous')), first)
  assert.equal(existsSync(join(base, 'current/out/removed.js')), false)
  assert.equal(readFileSync(join(base, 'current/out/main/index.js'), 'utf8'), 'new\n')
  write(join(base, 'current/out/main/index.js'), 'corrupt\n')
  result = deploy(false)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Build artifact changed/)
})
