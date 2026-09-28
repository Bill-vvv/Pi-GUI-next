import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import {
  buildSystemSshTunnelArgs,
  resolveSystemSshExecutable,
  startSystemSshTunnel,
  SystemSshStartupCleanupError,
  SystemSshTunnelError
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

test('SSH startup cancellation during configuration cannot spawn a late tunnel', async () => {
  const controller = new AbortController()
  let resolveConfiguration!: (text: string) => void
  let configurationStarted!: () => void
  const started = new Promise<void>((resolve) => { configurationStarted = resolve })
  let spawned = false
  const pending = startSystemSshTunnel({
    config, sshExecutable: 'ssh', signal: controller.signal, verifyUnauthenticatedDesktopHost,
    inspectSsh: async () => { configurationStarted(); return new Promise<string>((resolve) => { resolveConfiguration = resolve }) },
    spawnSsh: () => { spawned = true; return createFakeChild().child }
  })
  await started
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  resolveConfiguration('hostname fixture\n')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(spawned, false)
})

test('SSH startup cancellation stops its process and aborts an in-flight Host handshake', async () => {
  const controller = new AbortController()
  const child = createFakeChild()
  const stages: string[] = []
  let handshakeStarted!: () => void
  const started = new Promise<void>((resolve) => { handshakeStarted = resolve })
  let handshakeSignal: AbortSignal | null = null
  const pending = startSystemSshTunnel({
    config, sshExecutable: 'ssh', signal: controller.signal, onStage: (stage) => stages.push(stage),
    inspectSsh: async () => 'hostname fixture\n', spawnSsh: () => child.child,
    verifyUnauthenticatedDesktopHost: (signal) => {
      handshakeSignal = signal
      handshakeStarted()
      return new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    }
  })
  await started
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  assert.equal(child.killCount, 1)
  assert.equal((handshakeSignal as AbortSignal | null)?.aborted, true)
  assert.deepEqual(stages, ['ssh-executable', 'ssh-configuration', 'ssh-tunnel'])
})

test('failed startup retains process ownership when cleanup fails and permits a later cleanup retry', async () => {
  const child = createFakeChild({ exitOnKill: false })
  let retained: SystemSshStartupCleanupError | null = null
  await assert.rejects(startSystemSshTunnel({
    config, sshExecutable: 'ssh', inspectSsh: async () => 'hostname fixture\n', spawnSsh: () => child.child,
    stopTimeoutMs: 10, verifyUnauthenticatedDesktopHost: async () => { throw new Error('Build mismatch') }
  }), (error) => {
    assert.ok(error instanceof SystemSshStartupCleanupError)
    assert.match(String(error.errors[0]), /Build mismatch/u)
    assert.match(String(error.errors[1]), /did not terminate/u)
    retained = error
    return true
  })
  assert.equal(child.killCount, 1)
  child.emitter.emit('exit', null, 'SIGTERM')
  assert.ok(retained)
  await (retained as SystemSshStartupCleanupError).tunnel.stop()
})

test('cancelling startup waits for an actual owned child process to exit', { timeout: 15_000 }, async () => {
  const controller = new AbortController()
  let child: ChildProcess | null = null
  const pending = startSystemSshTunnel({
    config, sshExecutable: 'ssh', signal: controller.signal, startupTimeoutMs: 10_000,
    inspectSsh: async () => 'hostname fixture\n',
    spawnSsh: () => {
      child = spawn(process.execPath, ['-e', `process.stderr.write('debug1: Authenticated to fixture using "publickey".\\ndebug1: Local forwarding listening on 127.0.0.1 port ${config.localPort}.\\n'); setInterval(() => {}, 1000)`],
        { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
      return child
    },
    verifyUnauthenticatedDesktopHost: async () => { controller.abort(); throw controller.signal.reason }
  })
  await assert.rejects(pending, { name: 'AbortError' })
  assert.ok(child)
  const owned = child as ChildProcess
  assert.ok(owned.exitCode !== null || owned.signalCode !== null)
  assert.throws(() => process.kill(owned.pid!, 0))
})

test('a startup process error does not prevent termination of the still-owned child', async () => {
  const child = createFakeChild({ autoSpawn: false })
  setImmediate(() => { child.emitter.emit('spawn'); child.emitter.emit('error', new Error('Startup I/O failure')) })
  await assert.rejects(startSystemSshTunnel({
    config, sshExecutable: 'ssh', inspectSsh: async () => 'hostname fixture\n', spawnSsh: () => child.child,
    verifyUnauthenticatedDesktopHost
  }), /Startup I\/O failure/u)
  assert.equal(child.killCount, 1)
})

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
    sshExecutable: 'ssh',
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
    sshExecutable: 'ssh',
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
      sshExecutable: 'ssh',
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
      sshExecutable: 'ssh',
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
    sshExecutable: 'ssh',
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

test('Windows SSH uses System32 OpenSSH and refuses PATH lookup', async () => {
  assert.equal(await resolveSystemSshExecutable('linux', {}), 'ssh')
  await assert.rejects(
    () => resolveSystemSshExecutable('win32', {}),
    /requires SystemRoot/
  )
  await assert.rejects(
    () => resolveSystemSshExecutable('win32', { SystemRoot: 'D:\\missing-windows' }),
    /System OpenSSH was not found/
  )
  const systemRoot = process.env.SystemRoot
  if (systemRoot === undefined) return
  try {
    const executable = await resolveSystemSshExecutable('win32', { SystemRoot: systemRoot })
    assert.match(executable.replaceAll('/', '\\'), /\\System32\\OpenSSH\\ssh\.exe$/u)
  } catch (error) {
    assert.match(error instanceof Error ? error.message : String(error), /System OpenSSH was not found/)
  }
})

for (const [stderr, kind] of [
  ['ssh: connect to host pi-linux port 22: Connection refused', 'network'],
  ['ssh: Could not resolve hostname pi-linux: Temporary failure in name resolution', 'network'],
  ['pi-linux: Permission denied (publickey).', 'authentication'],
  ['Host key verification failed.', 'host-key'],
  ['bind [127.0.0.1]:18789: Address already in use', 'configuration'],
  ['ssh: Could not resolve hostname pi-linux: Name or service not known', 'configuration'],
  ['Unexpected SSH failure', 'unknown']
] as const) {
  test(`SSH startup preserves diagnostics and classifies ${kind}: ${stderr}`, async () => {
    const failed = createFakeChild({ autoSpawn: false })
    setImmediate(() => {
      failed.emitter.emit('spawn')
      failed.stderr.write(stderr)
      failed.emitter.emit('exit', 255, null)
    })
    await assert.rejects(startSystemSshTunnel({
      config, sshExecutable: 'ssh', verifyUnauthenticatedDesktopHost,
      inspectSsh: async () => 'hostname pi-linux\n', spawnSsh: () => failed.child
    }), (error: unknown) => error instanceof SystemSshTunnelError && error.kind === kind && error.message.includes(stderr))
  })
}

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
