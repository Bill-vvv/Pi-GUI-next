// Drive a built Node Host (D-095) over its private WSL stdio pipe the way the Windows client does,
// in an isolated HOME and without a display. Usage (from a checks workspace):
//   node scripts/verify-host-pipe.ts <build-root>
//   node scripts/verify-host-pipe.ts <installed-release> --launcher <start-host.sh> --data-home <XDG_DATA_HOME>
// The second form starts an installed WSL backend exactly as the Windows client does (the
// launcher alone, its isolated Node from <data-home>/pi-gui-next-wsl).
// Prints one JSON line per stage; exits non-zero on the first failure.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { KERNEL_COMMAND_CHANNEL } from '../src/shared/kernel-contract.ts'
import { REMOTE_ADMIN_COMMAND_CHANNEL } from '../src/shared/remote-admin-contract.ts'
import { WslPipe } from '../src/main/remote/wsl-pipe.ts'

const [buildRoot, ...options] = process.argv.slice(2)
const option = (name: string): string | undefined => {
  const index = options.indexOf(name)
  return index >= 0 ? options[index + 1] : undefined
}
const launcher = option('--launcher')
const dataHome = option('--data-home')
assert.ok(
  buildRoot !== undefined && (launcher === undefined) === (dataHome === undefined) && options.length === (launcher === undefined ? 0 : 4),
  'usage: verify-host-pipe.ts <build-root> [--launcher <start-host.sh> --data-home <XDG_DATA_HOME>]'
)
const log = (value: Record<string, unknown>): void => console.log(JSON.stringify(value))

const identity = JSON.parse(await readFile(join(buildRoot, 'out/main/build-identity.json'), 'utf8')) as { artifactDigest: string }
const home = await mkdtemp(join(tmpdir(), 'pi-host-pipe-'))
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  HOME: home,
  XDG_CONFIG_HOME: join(home, 'config'),
  XDG_STATE_HOME: join(home, 'state'),
  XDG_DATA_HOME: dataHome ?? join(home, 'data'),
  XDG_CACHE_HOME: join(home, 'cache'),
  XDG_RUNTIME_DIR: join(home, 'runtime'),
  PI_CODING_AGENT_DIR: join(home, 'agent'),
  PI_OFFLINE: '1',
  PI_SKIP_VERSION_CHECK: '1'
}
await mkdir(env.XDG_RUNTIME_DIR!, { mode: 0o700 })

const started = Date.now()
const child = launcher === undefined
  ? spawn(process.execPath, ['--use-env-proxy', 'out/main/pi-host.js', 'wsl'], { cwd: buildRoot, env, stdio: ['pipe', 'pipe', 'pipe'] })
  : spawn(launcher, [], { cwd: home, env: { ...env, PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] })
let diagnostics = ''
child.stderr.on('data', (chunk: Buffer) => { diagnostics += chunk.toString('utf8') })
const exited = new Promise<{ code: number | null, signal: NodeJS.Signals | null }>((resolve) => {
  child.once('exit', (code, signal) => resolve({ code, signal }))
})

try {
  const pipe = new WslPipe({
    input: child.stdout,
    output: child.stdin,
    fingerprint: identity.artifactDigest,
    expectedPlatform: 'linux',
    platform: 'win32',
    readyTimeoutMs: 120_000
  })
  const peer = await pipe.ready
  log({ stage: 'handshake', peerPlatform: peer.platform, durationMs: Date.now() - started })

  const snapshot = await pipe.request(KERNEL_COMMAND_CHANNEL, { type: 'kernel.get-state' }) as {
    revision: number
    state: { runtime: { status: string }, projects: unknown[] }
  }
  assert.equal(typeof snapshot.revision, 'number')
  assert.equal(typeof snapshot.state.runtime.status, 'string')
  assert.deepEqual(snapshot.state.projects, [])
  log({ stage: 'kernel.get-state', revision: snapshot.revision, runtimeStatus: snapshot.state.runtime.status })

  const remote = await pipe.request(REMOTE_ADMIN_COMMAND_CHANNEL, { type: 'remote-admin.get-status' })
  assert.deepEqual(remote, { enabled: false })
  const desktopHost = await pipe.request(REMOTE_ADMIN_COMMAND_CHANNEL, { type: 'remote-admin.get-desktop-host-status' })
  assert.deepEqual(desktopHost, { enabled: false })
  log({ stage: 'remote-admin', remote, desktopHost })

  await assert.rejects(pipe.request('not-a-channel', null), /Unsupported WSL/u)
  log({ stage: 'unknown-channel-rejected' })

  pipe.close()
  const exit = await Promise.race([exited, new Promise<null>((resolve) => setTimeout(() => resolve(null), 30_000))])
  assert.ok(exit !== null, 'Host did not exit after the pipe closed')
  log({ stage: 'exit-after-pipe-close', ...exit, totalMs: Date.now() - started })
} catch (error) {
  child.kill('SIGKILL')
  console.error(diagnostics.split('\n').slice(-40).join('\n'))
  throw error
} finally {
  await rm(home, { recursive: true, force: true })
}
