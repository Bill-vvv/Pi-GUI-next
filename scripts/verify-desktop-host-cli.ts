// End-to-end check of the headless Desktop Host (D-095/D-099) in an isolated HOME without a display:
// launcher start -> CLI devices/pair -> real client pairing -> CLI revoke -> data-directory lock ->
// interrupted launcher stops the Host and releases its control socket.
// Usage (from a checks workspace): node scripts/verify-desktop-host-cli.ts <build-root>
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DesktopHostClient } from '../src/main/remote/desktop-host-client.ts'

const [buildRoot] = process.argv.slice(2)
assert.ok(buildRoot !== undefined, 'usage: verify-desktop-host-cli.ts <build-root>')
const log = (value: Record<string, unknown>): void => console.log(JSON.stringify(value))
const home = await mkdtemp(join(tmpdir(), 'pi-desktop-host-cli-'))
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: home,
  XDG_CONFIG_HOME: join(home, 'config'),
  XDG_STATE_HOME: join(home, 'state'),
  XDG_DATA_HOME: join(home, 'data'),
  XDG_CACHE_HOME: join(home, 'cache'),
  XDG_RUNTIME_DIR: join(home, 'runtime'),
  PI_CODING_AGENT_DIR: join(home, 'agent'),
  PI_OFFLINE: '1',
  PI_SKIP_VERSION_CHECK: '1'
}
await mkdir(env.XDG_RUNTIME_DIR!, { mode: 0o700 })
const cliPath = join(buildRoot, 'out/main/desktop-host-cli.js')
const cli = (...args: string[]) => {
  const result = spawnSync(process.execPath, [cliPath, ...args], { env, encoding: 'utf8', timeout: 60_000 })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}
const port = await new Promise<number>((resolve) => {
  const server = createServer().listen(0, '127.0.0.1', () => {
    const address = server.address() as { port: number }
    server.close(() => resolve(address.port))
  })
})
const identity = JSON.parse(await readFile(join(buildRoot, 'out/main/build-identity.json'), 'utf8')) as { sourceDigest: string }
const productVersion = (JSON.parse(await readFile(join(buildRoot, 'package.json'), 'utf8')) as { version: string }).version
const dataDirectory = join(env.XDG_CONFIG_HOME!, 'pi-gui-next')

let launcher: ReturnType<typeof spawn> | null = null
try {
  const configured = cli('configure', '--port', String(port))
  assert.equal(configured.status, 0, configured.stderr)

  const started = Date.now()
  launcher = spawn(process.execPath, [cliPath, 'start', '--build-root', buildRoot], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  let diagnostics = ''
  launcher.stderr!.on('data', (chunk: Buffer) => { diagnostics += chunk.toString('utf8') })
  const launcherExit = new Promise<number | null>((resolve) => launcher!.once('exit', (code) => resolve(code)))
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Host not ready: ${diagnostics.slice(-2000)}`)), 120_000)
    launcher!.stdout!.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
      if (output.includes('"ready": true')) { clearTimeout(timer); resolve() }
    })
    void launcherExit.then((code) => { clearTimeout(timer); reject(new Error(`Launcher exited (${code}): ${diagnostics.slice(-2000)}`)) })
  })
  log({ stage: 'ready-without-display', durationMs: Date.now() - started })

  const listed = cli('devices')
  assert.equal(listed.status, 0, listed.stderr)
  assert.deepEqual(JSON.parse(listed.stdout).devices, [])
  const paired = cli('pair')
  assert.equal(paired.status, 0, paired.stderr)
  const code = JSON.parse(paired.stdout).code as string
  assert.match(code, /^\d{6}$/u)
  log({ stage: 'cli-pair-code' })

  const client = new DesktopHostClient({ localPort: port, compatibility: { productVersion, buildCommit: identity.sourceDigest } })
  await client.verifyCompatibility()
  await client.pair(code, 'CLI check PC')
  const after = JSON.parse(cli('devices').stdout).devices as Array<{ deviceId: string, label: string | null }>
  assert.deepEqual(after.map(({ label }) => label), ['CLI check PC'])
  log({ stage: 'client-paired-and-listed', devices: after.length })

  const revoked = cli('revoke', '--device', after[0]!.deviceId)
  assert.equal(revoked.status, 0, revoked.stderr)
  assert.deepEqual(JSON.parse(revoked.stdout).devices, [])
  const again = cli('revoke', '--device', after[0]!.deviceId)
  assert.notEqual(again.status, 0)
  assert.match(again.stderr, /设备不存在或已撤销/u)
  assert.notEqual(cli('revoke', '--device', 'not-an-id').status, 0)
  log({ stage: 'cli-revoke' })

  const second = spawnSync(process.execPath, ['--use-env-proxy', join(buildRoot, 'out/main/pi-host.js'), 'wsl'], {
    cwd: buildRoot, env, encoding: 'utf8', timeout: 60_000, input: ''
  })
  assert.notEqual(second.status, 0)
  assert.match(second.stderr, /Another Pi GUI Host is already using/u)
  log({ stage: 'second-host-refused' })

  launcher.kill('SIGTERM')
  const exitCode = await launcherExit
  launcher = null
  await assert.rejects(stat(join(dataDirectory, 'host.sock')), { code: 'ENOENT' })
  assert.notEqual(cli('devices').status, 0)
  log({ stage: 'stopped-and-released', launcherExitCode: exitCode })
} finally {
  launcher?.kill('SIGKILL')
  await rm(home, { recursive: true, force: true })
}
