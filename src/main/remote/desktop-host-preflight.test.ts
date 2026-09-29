import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { createServer as createTcpServer } from 'node:net'
import test from 'node:test'

import { isDesktopClientCommand } from '../../shared/desktop-client-contract.ts'
import { DESKTOP_HOST_API_PATHS, DESKTOP_HOST_PROTOCOL_VERSION, DESKTOP_HOST_KERNEL_COMMAND_TYPES } from '../../shared/desktop-host-contract.ts'
import { DesktopHostClient } from './desktop-host-client.ts'
import { runDesktopHostCheck, checkLocalPort } from './desktop-host-preflight.ts'
import { createWindowsRemoteSession } from './windows-remote-session.ts'
import { startSystemSshTunnel, type StartSystemSshTunnelOptions, type SystemSshTunnel } from './system-ssh-tunnel.ts'

const CONFIG = { sshHostAlias: 'fixture', localPort: 18788, desktopHostPort: 18788 }
const COMPATIBILITY = { productVersion: '1.0.0', buildCommit: 'fixture-build' }
const HANDSHAKE = { ...COMPATIBILITY, protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION, authenticated: false, pairingKnown: null,
  capabilities: { kernelCommandTypes: DESKTOP_HOST_KERNEL_COMMAND_TYPES } }

function fakeTunnel(stop?: () => Promise<void>): SystemSshTunnel {
  const controller = new AbortController()
  let finish!: (value: Awaited<SystemSshTunnel['termination']>) => void
  return {
    connectionSignal: controller.signal,
    termination: new Promise((resolve) => { finish = resolve }),
    stop: async () => { await stop?.(); controller.abort(); finish({ expected: true, code: 0, signal: null, error: null, stderr: '' }) }
  }
}

async function reservePort(): Promise<number> {
  const server = createTcpServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
}

function transportStages(options: StartSystemSshTunnelOptions): void {
  options.onStage?.('ssh-executable')
  options.onStage?.('ssh-configuration')
  options.onStage?.('ssh-tunnel')
}

test('preflight uses actual HTTP handshake without pairing, credentials, events, persistence or tasks, then releases the port', { timeout: 10_000 }, async () => {
  const port = await reservePort()
  const requests: { method: string; url: string; authorization: string | undefined }[] = []
  let stopped = false
  const statuses: string[] = []
  const session = createWindowsRemoteSession({
    ...COMPATIBILITY, initialLastHost: CONFIG, initialHasStoredCredential: true, initialCachedCredential: 'A'.repeat(32),
    credentialStore: { load: async () => assert.fail('load credential'), save: async () => assert.fail('save credential'), clear: async () => assert.fail('clear credential') },
    hostConfigStore: { load: async () => assert.fail('load config'), save: async () => assert.fail('save config'), clear: async () => assert.fail('clear config') },
    onEvent: () => assert.fail('Kernel event'), onStatus: (status) => statuses.push(status.phase),
    startTunnel: async (options) => {
      transportStages(options)
      const server = createServer((request, response) => {
        requests.push({ method: request.method!, url: request.url!, authorization: request.headers.authorization })
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(HANDSHAKE))
      })
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
      const owned = fakeTunnel(async () => { stopped = true; await closeServer(server) })
      try { await options.verifyUnauthenticatedDesktopHost(owned.connectionSignal); return owned } catch (error) { await owned.stop(); throw error }
    }
  })
  const result = await session.checkHost('check-1', { ...CONFIG, localPort: port })
  assert.equal(result.outcome, 'passed')
  assert.ok(result.steps.every((step) => step.status === 'passed'))
  assert.equal(result.cleanupError, null)
  assert.equal(stopped, true)
  assert.deepEqual(requests, [{ method: 'GET', url: DESKTOP_HOST_API_PATHS.session, authorization: undefined }])
  assert.deepEqual(statuses, ['checking', 'disconnected'])
  assert.equal(session.status().hasStoredCredential, true)
  assert.deepEqual(session.status().lastHost, CONFIG)
  await checkLocalPort(port, new AbortController().signal)
  await session.close()
})

test('occupied loopback port fails before SSH starts, while later stages remain untested', async (t) => {
  const server = createTcpServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const port = (server.address() as { port: number }).port
  const { result } = await runDesktopHostCheck({ config: { ...CONFIG, localPort: port }, compatibility: COMPATIBILITY,
    signal: new AbortController().signal, startTunnel: async () => assert.fail('SSH must not start') })
  assert.equal(result.outcome, 'failed')
  assert.equal(result.steps[0]!.status, 'failed')
  assert.match(result.steps[0]!.detail!, /EADDRINUSE/u)
  assert.ok(result.steps.slice(1).every((step) => step.status === 'skipped'))
})

test('real SSH configuration policy stops configured forwarding and reports its exact stage', async () => {
  const { result } = await runDesktopHostCheck({ config: CONFIG, compatibility: COMPATIBILITY, signal: new AbortController().signal,
    checkPort: async () => {}, startTunnel: (options) => startSystemSshTunnel({ ...options, sshExecutable: 'ssh',
      inspectSsh: async () => 'localforward 8080 localhost:8080\n', spawnSsh: () => assert.fail('must not spawn') }) })
  assert.deepEqual(result.steps.map((step) => step.status), ['passed', 'passed', 'failed', 'skipped', 'skipped'])
  assert.match(result.steps[2]!.detail!, /must not define LocalForward/u)
})

for (const [name, body, status] of [
  ['wrong build', JSON.stringify({ ...HANDSHAKE, buildCommit: 'other-build' }), 200],
  ['invalid response', '{bad json', 200],
  ['unavailable service', '{}', 503]
] as const) {
  test(`preflight rejects ${name} without reporting a successful Host check`, async () => {
    let stopped = 0
    const { result } = await runDesktopHostCheck({ config: CONFIG, compatibility: COMPATIBILITY, signal: new AbortController().signal,
      checkPort: async () => {}, createClient: (options) => new DesktopHostClient({ ...options,
        fetchImpl: async () => new Response(body, { status, headers: { 'content-type': 'application/json' } }) }),
      startTunnel: async (options) => {
        transportStages(options)
        const tunnel = fakeTunnel(async () => { stopped++ })
        try { await options.verifyUnauthenticatedDesktopHost(tunnel.connectionSignal); return tunnel } catch (error) { await tunnel.stop(); throw error }
      }
    })
    assert.equal(result.outcome, 'failed')
    assert.deepEqual(result.steps.map((step) => step.status), ['passed', 'passed', 'passed', 'passed', 'failed'])
    assert.equal(stopped, 1)
  })
}

test('check cancellation aborts HTTP, blocks connect and duplicate checks, and preserves stored pairing', { timeout: 10_000 }, async () => {
  const port = await reservePort()
  let started!: () => void
  const ready = new Promise<void>((resolve) => { started = resolve })
  let aborted = false
  let responseClosed!: () => void
  const closed = new Promise<void>((resolve) => { responseClosed = resolve })
  let stopped = 0
  const session = createWindowsRemoteSession({ ...COMPATIBILITY, initialHasStoredCredential: true,
    onEvent: () => assert.fail('Kernel event'),
    startTunnel: async (options) => {
      transportStages(options)
      const server = createServer((_request, response) => {
        response.once('close', () => { aborted = true; responseClosed() })
        started()
      })
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
      const owned = fakeTunnel(async () => { stopped++; await closeServer(server) })
      try { await options.verifyUnauthenticatedDesktopHost(owned.connectionSignal); return owned } catch (error) { await owned.stop(); throw error }
    }
  })
  const pending = session.checkHost('current', { ...CONFIG, localPort: port })
  await ready
  await assert.rejects(session.checkHost('duplicate', CONFIG), /结束当前/u)
  await assert.rejects(session.connect(CONFIG), /already in progress/u)
  await session.cancelHostCheck('older')
  assert.equal(aborted, false)
  await session.cancelHostCheck('current')
  await closed
  assert.equal((await pending).outcome, 'cancelled')
  assert.equal(aborted, true)
  assert.equal(stopped, 1)
  assert.equal(session.status().hasStoredCredential, true)
  assert.equal(session.status().phase, 'disconnected')
})

test('failed temporary cleanup retains its tunnel and blocks another check until explicit close succeeds', async () => {
  let stopCalls = 0
  const session = createWindowsRemoteSession({ ...COMPATIBILITY, onEvent: () => {}, checkLocalPort: async () => {},
    createClient: (options) => new DesktopHostClient({ ...options, fetchImpl: async () => Response.json(HANDSHAKE) }),
    startTunnel: async (options) => {
      transportStages(options)
      const owned = fakeTunnel(async () => { if (++stopCalls === 1) throw new Error('Cannot stop SSH process') })
      await options.verifyUnauthenticatedDesktopHost(owned.connectionSignal)
      return owned
    }
  })
  const result = await session.checkHost('first', CONFIG)
  assert.equal(result.outcome, 'failed')
  assert.match(result.cleanupError!, /Cannot stop SSH/u)
  await assert.rejects(session.checkHost('second', CONFIG), /尚未释放/u)
  await session.close()
  assert.equal(stopCalls, 2)
  assert.equal((await session.checkHost('third', CONFIG)).outcome, 'passed')
})

test('check cancelled while releasing a successful tunnel is never returned as passed', async () => {
  const controller = new AbortController()
  const { result } = await runDesktopHostCheck({ config: CONFIG, compatibility: COMPATIBILITY, signal: controller.signal,
    checkPort: async () => {}, createClient: (options) => new DesktopHostClient({ ...options, fetchImpl: async () => Response.json(HANDSHAKE) }),
    startTunnel: async (options) => {
      transportStages(options)
      const owned = fakeTunnel(async () => controller.abort())
      await options.verifyUnauthenticatedDesktopHost(owned.connectionSignal)
      return owned
    }
  })
  assert.equal(result.outcome, 'cancelled')
})

test('check IPC validates exact fields, operation identity and config at the shared boundary', () => {
  assert.equal(isDesktopClientCommand({ type: 'desktop-client.check-host', operationId: 'test', config: CONFIG }), true)
  for (const config of [{ ...CONFIG, localPort: 0 }, { ...CONFIG, desktopHostPort: '22' }, { ...CONFIG, sshHostAlias: '-Fbad' }, { ...CONFIG, pairingCode: '123456' }]) {
    assert.equal(isDesktopClientCommand({ type: 'desktop-client.check-host', operationId: 'test', config }), false)
  }
  assert.equal(isDesktopClientCommand({ type: 'desktop-client.cancel-host-check', operationId: '' }), false)
  assert.equal(isDesktopClientCommand({ type: 'desktop-client.cancel-host-check', operationId: 'test', extra: true }), false)
})

test('closing during a configuration check drains cancellation and forbids late SSH spawn while preserving pairing', async () => {
  let started!: () => void
  const ready = new Promise<void>((resolve) => { started = resolve })
  let resolveConfig!: (value: string) => void
  const session = createWindowsRemoteSession({ ...COMPATIBILITY, initialHasStoredCredential: true,
    onEvent: () => assert.fail('Kernel event'), checkLocalPort: async () => {},
    startTunnel: (options) => startSystemSshTunnel({ ...options, sshExecutable: 'ssh',
      inspectSsh: async () => { started(); return new Promise<string>((resolve) => { resolveConfig = resolve }) },
      spawnSsh: () => assert.fail('late SSH spawn') })
  })
  const pending = session.checkHost('closing', CONFIG)
  await ready
  await session.close()
  assert.equal((await pending).outcome, 'cancelled')
  resolveConfig('hostname fixture\n')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(session.status().phase, 'disconnected')
  assert.equal(session.status().hasStoredCredential, true)
})
