import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, chmod, symlink, unlink, copyFile, readdir, rename } from 'node:fs/promises'
import { spawnSync, spawn } from 'node:child_process'
import { watch, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { join, dirname, resolve, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { createBuildIdentity } from '../build-identity.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../../shared/desktop-host-contract.ts'
import { configureDesktopHost, inspectDesktopHost, startDesktopHost } from './desktop-host-launch.ts'
import { deployDesktopHost, resolveInstalledDesktopHost, rollbackDesktopHost } from './desktop-host-deployment.ts'
import { inspectDesktopHostBundle, installDesktopHostBundle, packDesktopHost } from './desktop-host-bundle.ts'
import { openDesktopDeviceStore } from './desktop-device-store.ts'

const linux = { skip: process.platform !== 'linux' }
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const pairedDevice = JSON.stringify({ version: 1, credentialHash: 'a'.repeat(64), pairedAt: 1, expiresAt: Number.MAX_SAFE_INTEGER })

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const temp = await mkdtemp(join(tmpdir(), 'pi-host-launch-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const directory = join(temp, '配置 with spaces')
  const build = join(temp, 'Linux build')
  const write = async (path: string, value: string) => {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, value)
  }
  for (const folder of ['src', 'extensions', 'scripts']) await mkdir(join(build, folder), { recursive: true })
  for (const file of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'electron.vite.config.ts', 'vite.remote.config.ts', 'out/preload/index.cjs', 'out/renderer/index.html']) await write(join(build, file), 'fixture\n')
  await write(join(build, 'package.json'), JSON.stringify({ name: 'pi-gui-next', version: '0.0.1', type: 'module', main: './out/main/index.js',
    engines: { node: process.versions.node }, build: { extraResources: [] },
    dependencies: { '@earendil-works/pi-coding-agent': '0.83.0' }, devDependencies: { electron: '43.1.1' } }))
  await write(join(build, 'node_modules/electron/package.json'), JSON.stringify({ version: '43.1.1' }))
  await write(join(build, 'node_modules/@earendil-works/pi-coding-agent/package.json'), JSON.stringify({ version: '0.83.0' }))
  await write(join(build, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'), '// fixture\n')
  await mkdir(join(build, 'node_modules/electron/dist'), { recursive: true })
  // A real Linux child process and HTTP server, explicitly substituting for Electron.
  await symlink(process.execPath, join(build, 'node_modules/electron/dist/electron'))
  await write(join(build, 'out/main/index.js'), `
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const build = JSON.parse(readFileSync('out/main/build-identity.json'));
writeFileSync('launch-observed.json', JSON.stringify({ cwd: process.cwd(), pid: process.pid,
  enabled: process.env.PI_GUI_DESKTOP_HOST_ENABLED, tokenFile: process.env.PI_GUI_DESKTOP_HOST_TOKEN_FILE,
  pi: process.env.PI_GUI_PI_EXECUTABLE, managed: process.env.PI_GUI_DESKTOP_HOST_MANAGED,
  nodeVersion: execFileSync('node', ['-p', 'process.versions.node'], {encoding:'utf8'}).trim(),
  leaked: ['PI_GUI_WSL_HOST','PI_GUI_WSL_DISTRO','PI_GUI_PROBE_ONLY','ELECTRON_RUN_AS_NODE','NODE_OPTIONS','ELECTRON_RENDERER_URL'].filter(key => process.env[key] !== undefined) }));
if (process.env.PI_GUI_LAUNCH_FIXTURE === 'early-exit') process.exit(0);
const server = createServer((req, res) => {
  if (req.url !== '/api/desktop-host/session' || req.headers.authorization) { res.writeHead(400); res.end(); return; }
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ protocolVersion: ${DESKTOP_HOST_PROTOCOL_VERSION}, productVersion: '0.0.1',
    buildCommit: process.env.PI_GUI_LAUNCH_FIXTURE === 'mismatch' ? 'wrong' : build.sourceDigest,
    authenticated: false, pairingKnown: null, capabilities: { kernelCommandTypes: [] } }));
});
server.listen(Number(process.env.PI_GUI_DESKTOP_HOST_PORT), '127.0.0.1');
process.on('SIGTERM', () => { writeFileSync('stopped', 'SIGTERM'); server.close(() => process.exit(0)); });
`)
  await write(join(build, 'out/main/build-identity.json'), JSON.stringify(createBuildIdentity(build, 'a'.repeat(40))))
  return { temp, directory, build }
}

async function freePort() {
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

function environment(t: { after: (fn: () => void) => void }, changes: Record<string, string | undefined>) {
  const before = Object.fromEntries(Object.keys(changes).map(key => [key, process.env[key]]))
  const apply = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
  apply(changes); t.after(() => apply(before))
}

test('configure creates private files, reuses a legacy token and preserves pairing across port changes', linux, async t => {
  const f = await fixture(t)
  await mkdir(f.directory, { mode: 0o700 })
  const token = 'original-private-token-'.repeat(3)
  await writeFile(join(f.directory, 'desktop-host.token'), token, { mode: 0o600 })
  await writeFile(join(f.directory, 'desktop-host.token.desktop-device'), pairedDevice, { mode: 0o600 })
  assert.deepEqual(await configureDesktopHost(f.directory, 18788), { directory: f.directory, port: 18788 })
  await configureDesktopHost(f.directory, 18789)
  assert.equal(await readFile(join(f.directory, 'desktop-host.token'), 'utf8'), token)
  assert.equal(await readFile(join(f.directory, 'desktop-host.token.desktop-device'), 'utf8'), pairedDevice)
  assert.deepEqual(JSON.parse(await readFile(join(f.directory, 'desktop-host.json'), 'utf8')), { schemaVersion: 1, port: 18789 })
  assert.equal((await stat(join(f.directory, 'desktop-host.json'))).mode & 0o777, 0o600)
  assert.equal((await stat(f.directory)).mode & 0o777, 0o700)
})

test('configure generates a strong token once and refuses to recreate missing configured credentials', linux, async t => {
  const f = await fixture(t)
  await configureDesktopHost(f.directory, 18788)
  const token = await readFile(join(f.directory, 'desktop-host.token'), 'utf8')
  assert.match(token, /^[a-f0-9]{64}\n$/u)
  assert.equal((await stat(join(f.directory, 'desktop-host.token'))).mode & 0o777, 0o600)
  await configureDesktopHost(f.directory, 18788)
  assert.equal(await readFile(join(f.directory, 'desktop-host.token'), 'utf8'), token)
  await unlink(join(f.directory, 'desktop-host.token'))
  await assert.rejects(configureDesktopHost(f.directory, 18788), /token is missing/)
  await assert.rejects(stat(join(f.directory, 'desktop-host.token')), { code: 'ENOENT' })
})

test('first-install configuration preserves a custom port and never recreates missing configured credentials', linux, async t => {
  const f = await fixture(t)
  assert.equal((await configureDesktopHost(f.directory)).port, 18788)
  await configureDesktopHost(f.directory, 19876)
  const settings = await readFile(join(f.directory, 'desktop-host.json'))
  assert.equal((await configureDesktopHost(f.directory, undefined, { preserveExisting: true })).port, 19876)
  await assert.rejects(configureDesktopHost(f.directory, 19877, { preserveExisting: true }), /another port/)
  assert.deepEqual(await readFile(join(f.directory, 'desktop-host.json')), settings)
  await unlink(join(f.directory, 'desktop-host.token'))
  await assert.rejects(configureDesktopHost(f.directory, undefined, { preserveExisting: true }), { code: 'ENOENT' })
  await assert.rejects(stat(join(f.directory, 'desktop-host.token')), { code: 'ENOENT' })
})

test('offline bundle extracts and installs independently, preserves existing configuration and rejects tampered inputs before configuration', { ...linux, timeout: 90_000 }, async t => {
  const f = await deploymentFixture(t)
  const output = join(f.temp, 'host.tar.gz')
  const bundle = await packDesktopHost({ buildRoot: f.build, output })
  assert.equal(bundle.packageCount, 2)
  const checksum = spawnSync('sha256sum', ['--check', basename(output) + '.sha256'], { cwd: f.temp, encoding: 'utf8' })
  assert.equal(checksum.status, 0, checksum.stderr)
  const unpack = spawnSync('tar', ['-xzf', output, '-C', f.temp], { encoding: 'utf8' })
  assert.equal(unpack.status, 0, unpack.stderr)
  const extracted = join(f.temp, 'pi-gui-host')
  await rename(f.build, `${f.build}.unavailable`)
  assert.equal((await inspectDesktopHostBundle(extracted)).manifest.payloadDigest, bundle.payloadDigest)
  const installer = spawnSync(join(extracted, 'install.sh'), ['--port', '19876'], { env: { ...process.env, PATH: '/usr/bin:/bin' }, encoding: 'utf8' })
  assert.equal(installer.status, 0, installer.stderr)
  // This fixture's bundled CLI records arguments; real CLI/native validation is separate.
  assert.deepEqual(JSON.parse(installer.stdout).args, ['install', '--build-root', extracted, '--port', '19876'])
  const configuration = await readFile(join(f.directory, 'desktop-host.json'))
  const token = await readFile(join(f.directory, 'desktop-host.token'))
  const result = await installDesktopHostBundle({ buildRoot: extracted, directory: f.directory, installDirectory: f.installDirectory })
  assert.deepEqual(await readFile(join(f.directory, 'desktop-host.json')), configuration)
  assert.deepEqual(await readFile(join(f.directory, 'desktop-host.token')), token)
  const installedRecord = await f.record()
  const dependency = join(extracted, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js')
  const dependencyBytes = await readFile(dependency)
  await assert.rejects(installDesktopHostBundle({ buildRoot: extracted, directory: f.directory, installDirectory: f.installDirectory,
    onProgress: stage => { if (stage === 'checking-source') writeFileSync(dependency, 'changed after bundle validation') } }), /Candidate differs from the verified Host bundle/)
  assert.equal(await f.record(), installedRecord)
  await writeFile(dependency, dependencyBytes)
  await rm(extracted, { recursive: true })
  const launched = spawnSync(result.nodeExecutable, [result.launcher, 'check'], { encoding: 'utf8' })
  assert.equal(launched.status, 0, launched.stderr)
  assert.equal(JSON.parse(launched.stdout).delegated, true)
  assert.equal(await resolveInstalledDesktopHost(f.directory, f.installDirectory), dirname(dirname(result.nodeExecutable)))
  // Re-extract and corrupt metadata, installer, and dependency content in turn.
  assert.equal(spawnSync('tar', ['-xzf', output, '-C', f.temp]).status, 0)
  const fresh = join(f.temp, 'not-configured')
  for (const path of ['host-bundle.json', 'install.sh', 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js']) {
    const absolute = join(extracted, path), original = await readFile(absolute)
    await writeFile(absolute, 'corrupt')
    await assert.rejects(installDesktopHostBundle({ buildRoot: extracted, directory: fresh, installDirectory: f.installDirectory }))
    await assert.rejects(stat(fresh), { code: 'ENOENT' })
    await writeFile(absolute, original)
  }
  const manifestPath = join(extracted, 'host-bundle.json'), originalManifest = await readFile(manifestPath)
  for (const invalid of [JSON.stringify({ ...JSON.parse(originalManifest.toString()), arch: 'other' }), 'x'.repeat(65_537)]) {
    await writeFile(manifestPath, invalid)
    await assert.rejects(installDesktopHostBundle({ buildRoot: extracted, directory: fresh, installDirectory: f.installDirectory }))
    await assert.rejects(stat(fresh), { code: 'ENOENT' })
  }
  await writeFile(manifestPath, originalManifest)
  const installedFresh = await installDesktopHostBundle({ buildRoot: extracted, directory: fresh, installDirectory: join(f.temp, 'first-install') })
  assert.equal(JSON.parse(await readFile(join(fresh, 'desktop-host.json'), 'utf8')).port, 18788)
  assert.equal(installedFresh.installed, true)
  const bytes = await readFile(output)
  await assert.rejects(packDesktopHost({ buildRoot: extracted, output }), /already exists/)
  assert.deepEqual(await readFile(output), bytes)
})

test('orphan device, unsafe directory, token symlink and token permissions are explicit failures', linux, async t => {
  const f = await fixture(t)
  await mkdir(f.directory, { mode: 0o700 })
  await writeFile(join(f.directory, 'desktop-host.token.desktop-device'), 'device')
  await assert.rejects(configureDesktopHost(f.directory, 18788), /paired-device record/)
  await unlink(join(f.directory, 'desktop-host.token.desktop-device'))
  await chmod(f.directory, 0o755)
  await assert.rejects(configureDesktopHost(f.directory, 18788), /0700/)
  await chmod(f.directory, 0o700)
  await symlink(f.directory, join(f.temp, 'linked'))
  await assert.rejects(configureDesktopHost(join(f.temp, 'linked'), 18788), /non-symlink/)
  await writeFile(join(f.temp, 'external-token'), 's'.repeat(64), { mode: 0o600 })
  await symlink(join(f.temp, 'external-token'), join(f.directory, 'desktop-host.token'))
  await assert.rejects(configureDesktopHost(f.directory, 18788), /regular non-symlink/)
  await unlink(join(f.directory, 'desktop-host.token'))
  await configureDesktopHost(f.directory, 18788)
  await chmod(join(f.directory, 'desktop-host.token'), 0o644)
  await assert.rejects(configureDesktopHost(f.directory, 18788), /0600/)
})

test('invalid, oversized and non-JSON settings never reset existing state or echo file contents', linux, async t => {
  const f = await fixture(t)
  await configureDesktopHost(f.directory, 18788)
  const settings = join(f.directory, 'desktop-host.json')
  for (const invalid of ['private-secret-not-json', JSON.stringify({ schemaVersion: 1, port: 0 }),
    JSON.stringify({ schemaVersion: 1, port: 80, extra: true }), 'x'.repeat(4097)]) {
    await writeFile(settings, invalid)
    await assert.rejects(configureDesktopHost(f.directory, 18788), error => {
      assert.ok(error instanceof Error)
      assert.ok(!error.message.includes('private-secret-not-json'))
      return true
    })
    assert.equal(await readFile(settings, 'utf8'), invalid)
  }
  await assert.rejects(configureDesktopHost(f.directory, 65536), /Invalid/)
})

test('inspection validates actual artifacts, pinned dependencies and Linux runtime without exposing tokens', linux, async t => {
  const f = await fixture(t)
  await configureDesktopHost(f.directory, 18788)
  const result = await inspectDesktopHost(f.directory, f.build)
  assert.equal(result.port, 18788)
  assert.equal(result.root, f.build)
  assert.ok(!JSON.stringify(result).includes((await readFile(join(f.directory, 'desktop-host.token'), 'utf8')).trim()))
  await writeFile(join(f.build, 'node_modules/electron/package.json'), JSON.stringify({ version: 'wrong' }))
  await assert.rejects(inspectDesktopHost(f.directory, f.build), /Installed electron does not match/)
  await writeFile(join(f.build, 'node_modules/electron/package.json'), JSON.stringify({ version: '43.1.1' }))
  await unlink(join(f.build, 'node_modules/electron/dist/electron'))
  await assert.rejects(inspectDesktopHost(f.directory, f.build), /Linux Electron binary is missing/)
  await writeFile(join(f.build, 'node_modules/electron/dist/electron'), 'MZ-windows-runtime', { mode: 0o700 })
  await assert.rejects(inspectDesktopHost(f.directory, f.build), /Linux ELF/)
  await writeFile(join(f.build, 'out/main/index.js'), 'corrupted')
  await assert.rejects(inspectDesktopHost(f.directory, f.build), /Build artifact changed/)
})

test('foreground launch waits for compatible HTTP, holds a real flock, and drains its child on cancellation', { ...linux, timeout: 20_000 }, async t => {
  const f = await fixture(t)
  const port = await freePort()
  await configureDesktopHost(f.directory, port)
  environment(t, { DISPLAY: ':fixture', PATH: '/usr/bin:/bin', PI_GUI_WSL_HOST: '1', PI_GUI_WSL_DISTRO: 'wrong', PI_GUI_PROBE_ONLY: '1',
    ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--this-option-must-not-reach-child', ELECTRON_RENDERER_URL: 'http://invalid' })
  const controller = new AbortController()
  t.after(() => controller.abort(new Error('test cleanup')))
  let ready!: () => void
  const readyPromise = new Promise<void>(resolve => { ready = resolve })
  const running = startDesktopHost({ directory: f.directory, buildRoot: f.build, signal: controller.signal, onReady: ready })
  const rejected = assert.rejects(running, /test stop/)
  await Promise.race([readyPromise, running])
  const observed = JSON.parse(await readFile(join(f.build, 'launch-observed.json'), 'utf8'))
  assert.equal(observed.enabled, '1'); assert.equal(observed.managed, '1')
  assert.deepEqual(observed.leaked, [])
  assert.equal(observed.cwd, f.build)
  assert.equal(observed.nodeVersion, process.versions.node)
  assert.equal(observed.tokenFile, join(f.directory, 'desktop-host.token'))
  await assert.rejects(configureDesktopHost(f.directory, port + 1), /launcher is busy/)
  await assert.rejects(startDesktopHost({ directory: f.directory, buildRoot: f.build, signal: controller.signal, onReady: () => assert.fail('duplicate launch') }), /launcher is busy/)
  controller.abort(new Error('test stop'))
  await rejected
  assert.equal(await readFile(join(f.build, 'stopped'), 'utf8'), 'SIGTERM')
  assert.throws(() => process.kill(observed.pid, 0), { code: 'ESRCH' })
  await configureDesktopHost(f.directory, port)
})

test('missing display, occupied port and pre-cancelled start do not launch a child', linux, async t => {
  const f = await fixture(t)
  const port = await freePort()
  await configureDesktopHost(f.directory, port)
  environment(t, { DISPLAY: undefined, WAYLAND_DISPLAY: undefined })
  const start = (signal = new AbortController().signal) => startDesktopHost({ directory: f.directory, buildRoot: f.build, signal, onReady: () => assert.fail('must not become ready') })
  await assert.rejects(start(), /graphical session/)
  process.env.DISPLAY = ':fixture'
  const occupied = createServer()
  await new Promise<void>(resolve => occupied.listen(port, '127.0.0.1', resolve))
  try { await assert.rejects(start(), { code: 'EADDRINUSE' }) }
  finally { await new Promise<void>(resolve => occupied.close(() => resolve())) }
  await assert.rejects(start(AbortSignal.abort(new Error('cancelled before start'))), /cancelled before start/)
  await assert.rejects(stat(join(f.build, 'launch-observed.json')), { code: 'ENOENT' })
})

for (const mode of ['early-exit', 'mismatch']) {
  test(`startup ${mode} is a failure and releases the child and launch lock`, { ...linux, timeout: 10_000 }, async t => {
    const f = await fixture(t)
    await configureDesktopHost(f.directory, await freePort())
    environment(t, { DISPLAY: ':fixture', PI_GUI_LAUNCH_FIXTURE: mode })
    await assert.rejects(startDesktopHost({ directory: f.directory, buildRoot: f.build,
      signal: new AbortController().signal, onReady: () => assert.fail('must not become ready') }), mode === 'early-exit' ? /exited before ready/ : /mismatch/)
    const observed = JSON.parse(await readFile(join(f.build, 'launch-observed.json'), 'utf8'))
    assert.throws(() => process.kill(observed.pid, 0), { code: 'ESRCH' })
    await configureDesktopHost(f.directory, 18788)
  })
}

test('CLI rejects unknown/duplicate options and prints only sanitized configuration metadata', linux, async t => {
  const f = await fixture(t)
  const cli = (...args: string[]) => spawnSync(process.execPath, [join(root, 'scripts/desktop-host.mjs'), ...args], { cwd: root, encoding: 'utf8', timeout: 10_000 })
  for (const args of [['configure', '--port', '018788'], ['configure', '--port', '80', '--port', '81'], ['start', '--shell', 'bad']]) {
    assert.equal(cli(...args).status, 1)
  }
  const configured = cli('configure', '--config-dir', f.directory)
  assert.equal(configured.status, 0, configured.stderr)
  assert.equal(JSON.parse(configured.stdout).configured, true)
  assert.ok(!configured.stdout.includes((await readFile(join(f.directory, 'desktop-host.token'), 'utf8')).trim()))
  const checked = cli('check', '--config-dir', f.directory, '--build-root', f.build)
  assert.equal(checked.status, 0, checked.stderr)
  assert.equal(JSON.parse(checked.stdout).prepared, true)
})

async function deploymentFixture(t: { after: (fn: () => Promise<void>) => void }) {
  const f = await fixture(t)
  await unlink(join(f.build, 'node_modules/electron/dist/electron'))
  await copyFile(process.execPath, join(f.build, 'node_modules/electron/dist/electron'))
  await writeFile(join(f.build, 'out/main/desktop-host-cli.js'), 'console.log(JSON.stringify({ delegated: true, args: process.argv.slice(2) }))\n')
  const refresh = async (revision: string) => {
    await writeFile(join(f.build, 'src/revision.ts'), revision)
    await writeFile(join(f.build, 'out/main/build-identity.json'), JSON.stringify(createBuildIdentity(f.build, 'a'.repeat(40))))
  }
  await refresh('first')
  await configureDesktopHost(f.directory, await freePort())
  const installDirectory = join(f.temp, '安装 with spaces')
  const deploy = () => deployDesktopHost({ directory: f.directory, installDirectory, buildRoot: f.build })
  const record = () => readFile(join(installDirectory, 'installation.json'), 'utf8')
  const declareDeviceVersions = async (versions: number[]) => {
    const path = join(f.build, 'package.json'), pkg = JSON.parse(await readFile(path, 'utf8'))
    pkg.desktopHost = { deviceStoreVersions: versions }
    await writeFile(path, JSON.stringify(pkg))
    await refresh(`device readers: ${versions.join(',')}`)
  }
  return { ...f, installDirectory, deploy, refresh, record, declareDeviceVersions }
}

test('migrated pairing data rejects incompatible rollback, deployment and launch without altering selection or credentials', { ...linux, timeout: 90_000 }, async t => {
  const f = await deploymentFixture(t)
  const devicePath = join(f.directory, 'desktop-host.token.desktop-device')
  await writeFile(devicePath, pairedDevice, { mode: 0o600 })
  const first = await f.deploy()
  await f.declareDeviceVersions([1, 2])
  const second = await f.deploy()
  // The future-reader fixture advertises v1/v2; real store migration simulates
  // its first start. This test verifies selection, not a v2 production Gateway.
  await openDesktopDeviceStore({ path: devicePath, uid: process.getuid!() })
  const before = await f.record(), devices = await readFile(devicePath), token = await readFile(join(f.directory, 'desktop-host.token'))
  await assert.rejects(rollbackDesktopHost(f.directory, f.installDirectory), /cannot read device store format 2/)
  assert.equal(await f.record(), before)
  const oldRoot = join(f.installDirectory, 'releases', first.release.id)
  await assert.rejects(startDesktopHost({ directory: f.directory, buildRoot: oldRoot,
    signal: new AbortController().signal, onReady: () => assert.fail('incompatible release became ready') }), /cannot read device store format 2/)
  await assert.rejects(stat(join(oldRoot, 'launch-observed.json')), { code: 'ENOENT' })
  assert.equal(await resolveInstalledDesktopHost(f.directory, f.installDirectory), join(f.installDirectory, 'releases', second.release.id))
  assert.equal((await f.deploy()).reused, true)
  await f.declareDeviceVersions([1])
  await assert.rejects(f.deploy(), /cannot read device store format 2/)
  assert.equal(await f.record(), before)
  assert.deepEqual(await readFile(devicePath), devices)
  assert.deepEqual(await readFile(join(f.directory, 'desktop-host.token')), token)
  assert.equal((await readdir(join(f.installDirectory, 'releases'))).length, 2)
})

test('a compatible forward upgrade can repair an intact current release that cannot read the current data', { ...linux, timeout: 60_000 }, async t => {
  const f = await deploymentFixture(t), first = await f.deploy()
  const devicePath = join(f.directory, 'desktop-host.token.desktop-device')
  await writeFile(devicePath, pairedDevice, { mode: 0o600 })
  await openDesktopDeviceStore({ path: devicePath, uid: process.getuid!() })
  const devices = await readFile(devicePath)
  await assert.rejects(resolveInstalledDesktopHost(f.directory, f.installDirectory), /cannot read device store format 2/)
  await f.declareDeviceVersions([1, 2])
  const next = await f.deploy()
  assert.equal(next.previous?.id, first.release.id)
  assert.equal(await resolveInstalledDesktopHost(f.directory, f.installDirectory), join(f.installDirectory, 'releases', next.release.id))
  assert.deepEqual(await readFile(devicePath), devices)
})

test('pairing data is checked again immediately before candidate activation', { ...linux, timeout: 60_000 }, async t => {
  const f = await deploymentFixture(t), first = await f.deploy(), before = await f.record()
  await f.refresh('another legacy build')
  const devicePath = join(f.directory, 'desktop-host.token.desktop-device')
  const document = JSON.stringify({ version: 2, devices: [] })
  await assert.rejects(deployDesktopHost({ directory: f.directory, installDirectory: f.installDirectory, buildRoot: f.build,
    onProgress: stage => { if (stage === 'activating') writeFileSync(devicePath, document, { mode: 0o600 }) }
  }), /cannot read device store format 2/)
  assert.equal(await f.record(), before)
  assert.deepEqual(await readdir(join(f.installDirectory, 'releases')), [first.release.id])
  assert.equal(await readFile(devicePath, 'utf8'), document)
})

test('deployment copies a complete release, preserves credentials and boots its own Node/CLI after the source is removed', { ...linux, timeout: 30_000 }, async t => {
  const f = await deploymentFixture(t)
  const token = await readFile(join(f.directory, 'desktop-host.token'))
  await writeFile(join(f.directory, 'desktop-host.token.desktop-device'), pairedDevice, { mode: 0o600 })
  const installed = await f.deploy()
  await rename(f.build, `${f.build}.unavailable`)
  const current = await resolveInstalledDesktopHost(f.directory, f.installDirectory)
  assert.equal(current, join(f.installDirectory, 'releases', installed.release.id))
  assert.deepEqual(await readFile(join(f.directory, 'desktop-host.token')), token)
  assert.equal(await readFile(join(f.directory, 'desktop-host.token.desktop-device'), 'utf8'), pairedDevice)
  const result = spawnSync(process.execPath, [installed.launcher, 'check'], { encoding: 'utf8', timeout: 10_000 })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { delegated: true, args: ['check', '--config-dir', f.directory, '--install-dir', f.installDirectory] })
  assert.notEqual((await stat(join(current, 'runtime/node'))).ino, (await stat(process.execPath)).ino)
})

test('upgrade atomically selects the new release, rollback verifies and swaps the prior release, and dependency damage blocks start', { ...linux, timeout: 30_000 }, async t => {
  const f = await deploymentFixture(t)
  const first = await f.deploy()
  await f.refresh('second')
  const second = await f.deploy()
  assert.equal(second.previous?.id, first.release.id)
  assert.notEqual(second.release.sourceDigest, first.release.sourceDigest)
  const beforeReuse = await f.record()
  const repeated = await f.deploy()
  assert.equal(repeated.reused, true)
  assert.equal(repeated.release.id, second.release.id)
  assert.equal(repeated.previous?.id, first.release.id)
  assert.equal(await f.record(), beforeReuse)
  const active = await resolveInstalledDesktopHost(f.directory, f.installDirectory)
  await writeFile(join(active, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'), 'changed dependency')
  await assert.rejects(resolveInstalledDesktopHost(f.directory, f.installDirectory), /payload changed/)
  const rolledBack = await rollbackDesktopHost(f.directory, f.installDirectory)
  assert.equal(rolledBack.release.id, first.release.id)
  assert.equal(rolledBack.previous?.id, second.release.id)
  assert.equal(await resolveInstalledDesktopHost(f.directory, f.installDirectory), join(f.installDirectory, 'releases', first.release.id))
  const before = await f.record()
  await assert.rejects(rollbackDesktopHost(f.directory, f.installDirectory), /payload changed/)
  assert.equal(await f.record(), before)
})

test('bad candidates, foreign dependency links and overlapping paths leave the selected release intact', { ...linux, timeout: 30_000 }, async t => {
  const f = await deploymentFixture(t)
  const first = await f.deploy()
  const before = await f.record()
  await symlink(process.execPath, join(f.build, 'node_modules/foreign-node'))
  await assert.rejects(f.deploy(), /link escapes/)
  assert.equal(await f.record(), before)
  assert.deepEqual(await readdir(join(f.installDirectory, 'releases')), [first.release.id])
  await unlink(join(f.build, 'node_modules/foreign-node'))
  await assert.rejects(deployDesktopHost({ directory: f.directory, installDirectory: join(f.build, 'node_modules/recursive'), buildRoot: f.build }), /must not overlap/)
  await assert.rejects(stat(join(f.build, 'node_modules/recursive')), { code: 'ENOENT' })
  await writeFile(join(f.build, 'out/main/index.js'), 'corrupt')
  await assert.rejects(f.deploy(), /Build artifact changed/)
  assert.equal(await f.record(), before)
  assert.equal(await resolveInstalledDesktopHost(f.directory, f.installDirectory), join(f.installDirectory, 'releases', first.release.id))
})

test('running an installed Host rejects upgrade and rollback until its owned process exits', { ...linux, timeout: 30_000 }, async t => {
  const f = await deploymentFixture(t)
  const first = await f.deploy()
  environment(t, { DISPLAY: ':fixture' })
  const controller = new AbortController()
  t.after(() => controller.abort(new Error('test cleanup')))
  let ready!: () => void
  const readyPromise = new Promise<void>(resolve => { ready = resolve })
  const running = startDesktopHost({ directory: f.directory, buildRoot: () => resolveInstalledDesktopHost(f.directory, f.installDirectory), signal: controller.signal, onReady: ready })
  const stopped = assert.rejects(running, /deployment test stop/)
  await Promise.race([readyPromise, running])
  await assert.rejects(f.deploy(), /launcher is busy/)
  await assert.rejects(rollbackDesktopHost(f.directory, f.installDirectory), /launcher is busy/)
  controller.abort(new Error('deployment test stop'))
  await stopped
  assert.equal(await resolveInstalledDesktopHost(f.directory, f.installDirectory), join(f.installDirectory, 'releases', first.release.id))
})

test('installation ownership, corrupted records and missing rollback targets fail without resetting selection', { ...linux, timeout: 30_000 }, async t => {
  const f = await deploymentFixture(t)
  await f.deploy()
  await assert.rejects(rollbackDesktopHost(f.directory, f.installDirectory), /No previous/)
  const other = join(f.temp, 'other-config')
  await configureDesktopHost(other, 18788)
  await assert.rejects(deployDesktopHost({ directory: other, installDirectory: f.installDirectory, buildRoot: f.build }), /does not own/)
  const record = await f.record()
  await writeFile(join(f.installDirectory, 'installation.json'), '{private-invalid')
  await assert.rejects(f.deploy(), /not valid UTF-8 JSON/)
  assert.equal(await f.record(), '{private-invalid')
  const malformed = spawnSync(process.execPath, [join(f.installDirectory, 'host.mjs'), 'check'], { encoding: 'utf8', timeout: 10_000 })
  assert.equal(malformed.status, 1)
  assert.ok(!malformed.stderr.includes('private-invalid'))
  await writeFile(join(f.installDirectory, 'installation.json'), 'x'.repeat(16_385))
  const oversized = spawnSync(process.execPath, [join(f.installDirectory, 'host.mjs'), 'check'], { encoding: 'utf8', timeout: 10_000 })
  assert.equal(oversized.status, 1)
  assert.match(oversized.stderr, /Cannot read Desktop Host installation/)
  await writeFile(join(f.installDirectory, 'installation.json'), record)
  await f.refresh('second')
  const second = await f.deploy()
  await rename(join(f.installDirectory, 'releases', second.previous!.id), join(f.installDirectory, 'retained-outside'))
  const before = await f.record()
  await assert.rejects(rollbackDesktopHost(f.directory, f.installDirectory), { code: 'ENOENT' })
  assert.equal(await f.record(), before)
})

test('SIGKILL during candidate copying preserves the current release and the next deploy removes the incomplete candidate', { ...linux, timeout: 30_000 }, async t => {
  const f = await deploymentFixture(t)
  const first = await f.deploy()
  await f.refresh('interrupted update')
  const before = await f.record()
  const releaseRoot = join(f.installDirectory, 'releases')
  let candidateWatcher: ReturnType<typeof watch> | undefined
  let copied!: () => void
  const copying = new Promise<void>(resolve => { copied = resolve })
  const watcher = watch(releaseRoot, (_, name) => {
    if (!name?.startsWith('.candidate-') || candidateWatcher) return
    candidateWatcher = watch(join(releaseRoot, name), (_, childName) => {
      if (childName === 'node_modules') copied()
    })
  })
  const child = spawn(process.execPath, [join(root, 'scripts/desktop-host.mjs'), 'deploy', '--build-root', f.build,
    '--config-dir', f.directory, '--install-dir', f.installDirectory], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }))
  })
  try {
    await Promise.race([copying, closed.then(() => { throw new Error(`Deploy exited before interruption: ${output}`) }),
      delay(10_000, undefined, { ref: false }).then(() => { throw new Error('Candidate copy was not observed') })])
    child.kill('SIGKILL')
    assert.equal((await closed).signal, 'SIGKILL')
  } finally {
    watcher.close(); candidateWatcher?.close()
    child.kill('SIGKILL'); await closed
  }
  assert.equal(await f.record(), before)
  assert.ok((await readdir(releaseRoot)).some(name => name.startsWith('.candidate-')))
  assert.equal(await resolveInstalledDesktopHost(f.directory, f.installDirectory), join(releaseRoot, first.release.id))
  const updated = await f.deploy()
  assert.equal(updated.previous?.id, first.release.id)
  assert.ok((await readdir(releaseRoot)).every(name => !name.startsWith('.candidate-')))
})
