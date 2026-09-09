import assert from 'node:assert/strict'
import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import {
  buildSystemSshTunnelArgs,
  startSystemSshTunnel
} from './system-ssh-tunnel.ts'
import type { WindowsRemoteHostConfig } from './windows-remote-host-config.ts'

const config: WindowsRemoteHostConfig = {
  sshHostAlias: 'pi-linux',
  localPort: 18789,
  desktopHostPort: 18788
}

async function verifyUnauthenticatedDesktopHost(
  _connectionSignal: AbortSignal
): Promise<void> {}

test('system SSH tunnel uses only OpenSSH forwarding and fail-fast options', () => {
  assert.deepEqual(buildSystemSshTunnelArgs(config), [
    '-v',
    '-N',
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ConnectionAttempts=1',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=3',
    '-o',
    'PermitLocalCommand=no',
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
    '-o',
    'ForkAfterAuthentication=no',
    '-o',
    'Tunnel=no',
    '-o',
    'ClearAllForwardings=no',
    '-L',
    '127.0.0.1:18789:127.0.0.1:18788',
    'pi-linux'
  ])
  assert.doesNotMatch(buildSystemSshTunnelArgs(config).join(' '), /StrictHostKeyChecking|UserKnownHostsFile|password/iu)
})

test('system SSH tunnel reports bounded unexpected termination and explicit stop ownership', async () => {
  let executable = ''
  let args: readonly string[] = []
  let spawnOptions: unknown
  const first = createFakeChild()
  const tunnel = await startSystemSshTunnel({
    config,
    verifyUnauthenticatedDesktopHost,
    inspectSsh: async () => 'hostname pi-linux\n',
    spawnSsh(command, commandArgs, options) {
      executable = command
      args = commandArgs
      spawnOptions = options
      return first.child
    }
  })
  assert.equal(executable, 'ssh')
  assert.deepEqual(args, buildSystemSshTunnelArgs(config))
  assert.deepEqual(spawnOptions, {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe']
  })
  first.stderr.write('x'.repeat(9_000))
  first.emitter.emit('exit', 255, null)
  const unexpected = await tunnel.termination
  assert.equal(unexpected.expected, false)
  assert.equal(unexpected.code, 255)
  assert.equal(unexpected.stderr.length, 8 * 1024)

  const second = createFakeChild()
  const stoppedTunnel = await startSystemSshTunnel({
    config,
    verifyUnauthenticatedDesktopHost,
    inspectSsh: async () => 'hostname pi-linux\n',
    spawnSsh: () => second.child
  })
  await stoppedTunnel.stop()
  const stopped = await stoppedTunnel.termination
  assert.equal(second.killCount, 1)
  assert.equal(stopped.expected, true)
})

test('system SSH tunnel rejects forwarding rules inherited from the user alias', async () => {
  let spawned = false
  await assert.rejects(
    () => startSystemSshTunnel({
      config,
      verifyUnauthenticatedDesktopHost,
      inspectSsh: async () => [
        'hostname pi-linux',
        'proxyjump jump-host',
        'localforward [127.0.0.1]:9999 [127.0.0.1]:9999'
      ].join('\n'),
      spawnSsh: () => {
        spawned = true
        return createFakeChild().child
      }
    }),
    /must not define LocalForward/
  )
  assert.equal(spawned, false)
})

test('system SSH tunnel rejects process spawn failure instead of returning a dead owner', async () => {
  const failed = createFakeChild({ autoSpawn: false })
  setImmediate(() => failed.emitter.emit('error', new Error('ssh executable missing')))
  await assert.rejects(
    () => startSystemSshTunnel({
      config,
      verifyUnauthenticatedDesktopHost,
      inspectSsh: async () => 'hostname pi-linux\n',
      spawnSsh: () => failed.child
    }),
    /OpenSSH could not start: ssh executable missing/
  )
})

test('system SSH tunnel stop fails within its explicit bound when the process remains owned', async () => {
  const hanging = createFakeChild({ exitOnKill: false })
  const tunnel = await startSystemSshTunnel({
    config,
    verifyUnauthenticatedDesktopHost,
    inspectSsh: async () => 'hostname pi-linux\n',
    spawnSsh: () => hanging.child,
    stopTimeoutMs: 10
  })
  await assert.rejects(() => tunnel.stop(), /did not terminate within 10 milliseconds/)
  assert.equal(hanging.killCount, 1)
  hanging.emitter.emit('exit', null, 'SIGTERM')
  await tunnel.termination
})

function createFakeChild(options: {
  autoSpawn?: boolean
  exitOnKill?: boolean
} = {}): {
  child: ChildProcess
  emitter: EventEmitter
  stderr: PassThrough
  readonly killCount: number
} {
  const emitter = new EventEmitter()
  const stderr = new PassThrough()
  const autoSpawn = options.autoSpawn ?? true
  const exitOnKill = options.exitOnKill ?? true
  let killCount = 0
  const child = emitter as ChildProcess
  Object.assign(child, {
    stderr,
    kill() {
      killCount += 1
      if (exitOnKill) queueMicrotask(() => emitter.emit('exit', null, 'SIGTERM'))
      return true
    }
  })
  if (autoSpawn) {
    setImmediate(() => {
      emitter.emit('spawn')
      stderr.write([
        'debug1: Authenticated to pi-linux ([127.0.0.1]:22) using "publickey".',
        `debug1: Local forwarding listening on 127.0.0.1 port ${config.localPort}.`
      ].join('\n'))
    })
  }
  return {
    child,
    emitter,
    stderr,
    get killCount() {
      return killCount
    }
  }
}
