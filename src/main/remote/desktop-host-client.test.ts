import assert from 'node:assert/strict'
import { desktopPairingId } from './desktop-device-binding.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type {
  KernelEvent,
  KernelSnapshot
} from '../../shared/kernel-contract.ts'
import {
  DESKTOP_HOST_API_PATHS,
  DESKTOP_HOST_KERNEL_COMMAND_TYPES,
  DESKTOP_HOST_PROTOCOL_VERSION
} from '../../shared/desktop-host-contract.ts'
import {
  assertDesktopHostCompatibility,
  DesktopHostClient,
  DesktopHostClientError,
  desktopHostControlIdentity
} from './desktop-host-client.ts'
import type { DesktopHostEnabledConfig } from './desktop-host-config.ts'
import { startDesktopHostGateway } from './desktop-host-gateway.ts'
import { openRemoteDeviceStore } from './remote-device-store.ts'
import { createWindowsRemoteSession } from './windows-remote-session.ts'
import { createMemoryDesktopDeviceCredentialStore } from './desktop-device-credential-store.ts'
import type { SystemSshTunnel } from './system-ssh-tunnel.ts'

const CONTROLLER_ID = '11111111-1111-4111-8111-111111111111'
const REQUEST_ID = '22222222-2222-4222-8222-222222222222'

const snapshot = {
  revision: 7,
  state: {
    activeProjectKey: '/project',
    activeSessionKey: 'session-1'
  }
} as KernelSnapshot

test('Desktop Host client rejects protocol, product, and known build mismatches', async () => {
  const client = new DesktopHostClient({
    localPort: 18788,
    compatibility: { productVersion: '1.0.0', buildCommit: 'host-build' },
    fetchImpl: async () => new Response(JSON.stringify({
      protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION + 1,
      productVersion: '1.0.0',
      buildCommit: 'host-build',
      authenticated: false, pairingId: desktopPairingId('d'.repeat(43)),
      capabilities: { kernelCommandTypes: DESKTOP_HOST_KERNEL_COMMAND_TYPES }
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  })
  await assert.rejects(() => client.verifyCompatibility(), /Unsupported Desktop Host protocol version/)

  const status = {
    protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
    productVersion: '1.0.0',
    buildCommit: 'host-build',
    authenticated: false, pairingId: desktopPairingId('d'.repeat(43)),
    capabilities: { kernelCommandTypes: DESKTOP_HOST_KERNEL_COMMAND_TYPES }
  } as const
  assert.throws(
    () => assertDesktopHostCompatibility(status, { productVersion: '2.0.0', buildCommit: 'host-build' }),
    /product version mismatch/
  )
  assert.throws(
    () => assertDesktopHostCompatibility(status, { productVersion: '1.0.0', buildCommit: 'client-build' }),
    /build commit mismatch/
  )
})

test('Desktop Host client requires an unauthenticated exact-build handshake before credentials or pairing', async () => {
  let authorization: string | null = null
  const client = new DesktopHostClient({
    localPort: 18788,
    compatibility: { productVersion: '1.0.0', buildCommit: 'host-build' },
    fetchImpl: async (_url, init) => {
      authorization = new Headers(init?.headers).get('authorization')
      return new Response(JSON.stringify({
        protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
        productVersion: '1.0.0',
        buildCommit: 'host-build',
        authenticated: false, pairingId: desktopPairingId('d'.repeat(43)),
        capabilities: { kernelCommandTypes: DESKTOP_HOST_KERNEL_COMMAND_TYPES }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }
  })

  assert.throws(() => client.setCredential('d'.repeat(43)), /compatibility must be verified/)
  await assert.rejects(() => client.pair('123456'), /compatibility must be verified/)
  await client.verifyCompatibility()
  assert.equal(authorization, null)
  client.setCredential('d'.repeat(43))
  await client.getSession()
  assert.equal(authorization, `Bearer ${'d'.repeat(43)}`)

  await client.verifyCompatibility()
  assert.equal(authorization, null)
  await assert.rejects(
    () => client.getState(CONTROLLER_ID),
    (error: unknown) => error instanceof DesktopHostClientError && error.code === 'unauthorized'
  )
})

const linuxHostFixture = { skip: process.platform !== 'linux' && 'The real Host fixture requires Linux file ownership and permissions.' }

test('saved credentials cannot cross two real Hosts with the same version and build after a tunnel target changes', linuxHostFixture, async () => {
  const first = await createGatewayFixture('c'.repeat(43))
  const second = await createGatewayFixture('e'.repeat(43))
  let target = first
  const sent: { port: number; authorization: string | null; path: string }[] = []
  const client = new DesktopHostClient({ localPort: 18788, compatibility: { productVersion: '1.0.0', buildCommit: 'test-build' },
    fetchImpl: async (input, init) => {
      const path = new URL(String(input)).pathname
      sent.push({ port: target.port, path, authorization: new Headers(init?.headers).get('authorization') })
      return fetch(`http://127.0.0.1:${target.port}${path}`, init)
    }
  })
  try {
    await client.verifyCompatibility()
    const paired = await client.pair('123456')
    const secondClient = new DesktopHostClient({ localPort: second.port, compatibility: { productVersion: '1.0.0', buildCommit: 'test-build' } })
    await secondClient.verifyCompatibility()
    await secondClient.pair('123456')
    target = second
    const handshake = await client.verifyCompatibility()
    assert.equal(handshake.pairingId, desktopPairingId('e'.repeat(43)))
    assert.throws(() => client.setCredential(paired.credential), (error) => error instanceof DesktopHostClientError && error.code === 'credential-target')
    await assert.rejects(client.getState(CONTROLLER_ID), (error) => error instanceof DesktopHostClientError && error.code === 'unauthorized')
    assert.deepEqual(sent.filter((request) => request.port === second.port), [{ port: second.port, path: '/api/desktop-host/session', authorization: null }])
    target = first
    await client.verifyCompatibility()
    client.setCredential(paired.credential)
    assert.equal((await client.getSession()).authenticated, true)
    assert.equal(sent.at(-1)!.authorization, `Bearer ${paired.credential}`)
  } finally {
    await first.close()
    await second.close()
  }
})

test('missing, malformed or inconsistent pairing identities fail the protocol boundary', async () => {
  for (const pairingId of [undefined, 'short', 'X'.repeat(64), 12, [], {}]) {
    const client = new DesktopHostClient({ localPort: 18788, compatibility: { productVersion: '1.0.0', buildCommit: 'test-build' },
      fetchImpl: async () => Response.json({ protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION, productVersion: '1.0.0', buildCommit: 'test-build',
        authenticated: false, pairingId, capabilities: { kernelCommandTypes: DESKTOP_HOST_KERNEL_COMMAND_TYPES } }) })
    await assert.rejects(client.verifyCompatibility(), DesktopHostClientError)
    assert.throws(() => client.setCredential('d'.repeat(43)), /compatibility/u)
  }
  const client = new DesktopHostClient({ localPort: 18788, compatibility: { productVersion: '1.0.0', buildCommit: 'test-build' },
    fetchImpl: async () => Response.json({ protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION, productVersion: '1.0.0', buildCommit: 'test-build',
      authenticated: true, pairingId: null, capabilities: { kernelCommandTypes: DESKTOP_HOST_KERNEL_COMMAND_TYPES } }) })
  await assert.rejects(client.verifyCompatibility(), /missing its pairing identity/u)
})

test('Desktop Host client pairs, owns one event controller, reads state, commands, and logs out', linuxHostFixture, async () => {
  const fixture = await createGatewayFixture()
  try {
    const client = new DesktopHostClient({
      localPort: fixture.port,
      compatibility: { productVersion: '1.0.0', buildCommit: 'test-build' }
    })
    const initial = await client.verifyCompatibility()
    assert.equal(initial.authenticated, false)
    assertDesktopHostCompatibility(initial, {
      productVersion: '1.0.0',
      buildCommit: 'test-build'
    })

    await assert.rejects(
      () => client.getState(CONTROLLER_ID),
      (error: unknown) => error instanceof DesktopHostClientError && error.code === 'unauthorized'
    )

    const paired = await client.pair('123456')
    assert.equal(paired.credential, 'c'.repeat(43))
    assert.equal((await client.getSession()).authenticated, true)

    let resolveEvent!: (event: KernelEvent) => void
    const eventReceived = new Promise<KernelEvent>((resolve) => {
      resolveEvent = resolve
    })
    const stream = await client.openEventStream(CONTROLLER_ID, resolveEvent)
    assert.deepEqual(await client.getState(CONTROLLER_ID), snapshot)
    assert.deepEqual(desktopHostControlIdentity(snapshot), {
      projectKey: '/project',
      sessionKey: 'session-1'
    })

    const value = await client.command(
      CONTROLLER_ID,
      desktopHostControlIdentity(snapshot),
      {
        type: 'kernel.prompt',
        message: 'hello',
        expectedSessionKey: 'session-1'
      },
      REQUEST_ID
    )
    assert.deepEqual(value, { revision: 8 })
    assert.equal(fixture.dispatched.length, 2)

    const event = {
      type: 'kernel.state-changed',
      revision: 8,
      state: snapshot.state
    } as KernelEvent
    fixture.gateway.publish(event)
    assert.deepEqual(await eventReceived, event)

    const streamClosed = assert.rejects(
      stream.closed,
      /disconnected|terminated|fetch failed/iu
    )
    const loggedOut = await client.logout()
    assert.equal(loggedOut.authenticated, false)
    await streamClosed
    assert.equal((await client.getSession()).authenticated, false)
  } finally {
    await fixture.close()
  }
})

test('Desktop Host client surfaces typed stale identity conflict', linuxHostFixture, async () => {
  const fixture = await createGatewayFixture()
  try {
    const client = new DesktopHostClient({
      localPort: fixture.port,
      compatibility: { productVersion: '1.0.0', buildCommit: 'test-build' }
    })
    await client.verifyCompatibility()
    await client.pair('123456')
    const stream = await client.openEventStream(CONTROLLER_ID, () => undefined)
    await assert.rejects(
      () => client.command(
        CONTROLLER_ID,
        { projectKey: '/stale', sessionKey: 'session-1' },
        { type: 'kernel.abort' },
        REQUEST_ID
      ),
      (error: unknown) => error instanceof DesktopHostClientError &&
        error.code === 'conflict' &&
        error.status === 409
    )
    assert.equal(fixture.dispatched.length, 0)
    await stream.close()
  } finally {
    await fixture.close()
  }

})

test('Desktop Host client never retries a failed mutation', async () => {
  let attempts = 0
  const offline = new DesktopHostClient({
    localPort: 18788,
    compatibility: { productVersion: '1.0.0', buildCommit: 'test-build' },
    fetchImpl: async () => {
      attempts += 1
      if (attempts === 1) {
        return new Response(JSON.stringify({
          protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
          productVersion: '1.0.0',
          buildCommit: 'test-build',
          authenticated: false, pairingId: desktopPairingId('d'.repeat(43)),
          capabilities: { kernelCommandTypes: DESKTOP_HOST_KERNEL_COMMAND_TYPES }
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      throw new Error('offline')
    }
  })
  await offline.verifyCompatibility()
  offline.setCredential('d'.repeat(43))
  await assert.rejects(
    () => offline.command(
      CONTROLLER_ID,
      { projectKey: '/project', sessionKey: 'session-1' },
      { type: 'kernel.abort' },
      REQUEST_ID
    ),
    (error: unknown) => error instanceof DesktopHostClientError && error.code === 'network'
  )
  assert.equal(attempts, 2)
})

test('Desktop Host client bounds JSON requests and SSE heartbeat silence', async () => {
  const stalledRequest = new DesktopHostClient({
    localPort: 18788,
    compatibility: { productVersion: '1.0.0', buildCommit: 'test-build' },
    requestTimeoutMs: 10,
    fetchImpl: async (_url, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
  })
  await assert.rejects(() => stalledRequest.verifyCompatibility(), /timed out/)

  let requestCount = 0
  const stalledEvents = new DesktopHostClient({
    localPort: 18788,
    compatibility: { productVersion: '1.0.0', buildCommit: 'test-build' },
    eventIdleTimeoutMs: 10,
    fetchImpl: async (_url, init) => {
      requestCount += 1
      if (requestCount === 1) {
        return new Response(JSON.stringify({
          protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
          productVersion: '1.0.0',
          buildCommit: 'test-build',
          authenticated: false, pairingId: desktopPairingId('d'.repeat(43)),
          capabilities: { kernelCommandTypes: DESKTOP_HOST_KERNEL_COMMAND_TYPES }
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(': connected\n\n'))
          init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')), {
            once: true
          })
        }
      }), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8' }
      })
    }
  })
  await stalledEvents.verifyCompatibility()
  stalledEvents.setCredential('d'.repeat(43))
  const stream = await stalledEvents.openEventStream(CONTROLLER_ID, () => undefined)
  await assert.rejects(stream.closed, /idle for 10 milliseconds/)
  await stream.close()
})

test('real HTTP/SSE reconnects after Host restart, then stops without resending or erasing credentials when pairing disappears', {
  ...linuxHostFixture, timeout: 5_000
}, async () => {
  const fixture = await createGatewayFixture()
  const credentialStore = createMemoryDesktopDeviceCredentialStore()
  const sent: (string | null)[] = []
  let connections = 0
  let resolveDisconnected!: () => void
  const disconnected = new Promise<void>((resolve) => { resolveDisconnected = resolve })
  let resolveReconnected!: () => void
  const reconnected = new Promise<void>((resolve) => { resolveReconnected = resolve })
  const session = createWindowsRemoteSession({
    productVersion: '1.0.0', buildCommit: 'test-build', onEvent: () => {},
    credentialStore,
    createClient: (options) => new DesktopHostClient({ ...options, fetchImpl: async (input, init) => {
      sent.push(new Headers(init?.headers).get('authorization'))
      return fetch(input, init)
    } }),
    onStatus: (status) => {
      if (status.phase === 'disconnected') resolveDisconnected()
      if (status.phase === 'connected' && connections > 1) resolveReconnected()
    },
    startTunnel: async ({ verifyUnauthenticatedDesktopHost }) => {
      connections += 1
      const controller = new AbortController()
      let end!: (result: Awaited<SystemSshTunnel['termination']>) => void
      const termination = new Promise<Awaited<SystemSshTunnel['termination']>>((resolve) => { end = resolve })
      await verifyUnauthenticatedDesktopHost(controller.signal)
      return {
        connectionSignal: controller.signal, termination,
        async stop() {
          controller.abort()
          end({ expected: true, code: 0, signal: null, error: null, stderr: '' })
        }
      }
    }
  })
  try {
    await session.connect({ sshHostAlias: 'fixture', localPort: fixture.port, desktopHostPort: fixture.port, pairingCode: '123456' })
    assert.equal(session.status().phase, 'connected')
    await fixture.restart()
    await reconnected
    assert.equal(session.status().hasStoredCredential, true)
    assert.equal(session.status().phase, 'connected')
    const connectionsBeforeRevoke = connections
    const requestsBeforeRevoke = sent.length
    await fixture.gateway.revokeDevice()
    await disconnected
    assert.equal(connections, connectionsBeforeRevoke + 1)
    assert.equal(session.status().failureKind, 'credential-target')
    assert.equal(session.status().hasStoredCredential, true)
    assert.equal(await credentialStore.load(), 'c'.repeat(43))
    assert.deepEqual(sent.slice(requestsBeforeRevoke), [null])
    assert.deepEqual(fixture.dispatched, ['kernel.get-state', 'kernel.get-state'])
  } finally {
    await session.close()
    await fixture.close()
  }
})

async function createGatewayFixture(deviceCredential = 'c'.repeat(43)): Promise<{
  port: number
  gateway: Awaited<ReturnType<typeof startDesktopHostGateway>>
  dispatched: string[]
  restart(): Promise<void>
  close(): Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), 'pi-gui-desktop-client-'))
  const port = await reservePort()
  const tokenFile = join(root, 'desktop-host.token')
  const config: DesktopHostEnabledConfig = {
    enabled: true,
    bindHost: '127.0.0.1',
    port,
    tokenFile,
    token: 'machine-secret-token-machine-secret-token',
    deviceStorePath: `${tokenFile}.desktop-device`
  }
  const dispatched: string[] = []
  const start = async () => startDesktopHostGateway({
    config,
    productVersion: '1.0.0',
    buildCommit: 'test-build',
    deviceStore: await openRemoteDeviceStore({
      path: config.deviceStorePath,
      uid: process.getuid?.() ?? 0
    }),
    randomPairingCode: () => '123456',
    randomDeviceCredential: () => deviceCredential,
    handlers: {
      getControlIdentity: () => ({
        projectKey: '/project',
        sessionKey: 'session-1'
      }),
      assertCommandPolicy: async () => undefined,
      dispatchCommand: async (command) => {
        dispatched.push(command.type)
        return command.type === 'kernel.get-state' ? snapshot : { revision: 8 }
      }
    }
  })
  let gateway = await start()
  gateway.createPairingCode()
  return {
    port,
    get gateway() { return gateway },
    dispatched,
    async restart() {
      await gateway.stop()
      gateway = await start()
    },
    async close() {
      await gateway.stop()
      await rm(root, { recursive: true, force: true })
    }
  }
}

async function reservePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('Failed to reserve a loopback port.')
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
  return address.port
}

test('Desktop Host Git capability parsing rejects unknown, duplicate or cross-domain commands', async () => {
  for (const gitCommandTypes of [['git.prepare-branch-sync'], ['git.refresh', 'git.refresh'], ['kernel.abort'], 'git.refresh', null]) {
    const client = new DesktopHostClient({
      localPort: 18788, compatibility: { productVersion: '1.0.0', buildCommit: 'fixture' },
      fetchImpl: async () => new Response(JSON.stringify({ protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION, productVersion: '1.0.0',
        buildCommit: 'fixture', authenticated: false, pairingId: desktopPairingId('d'.repeat(43)),
        capabilities: { kernelCommandTypes: DESKTOP_HOST_KERNEL_COMMAND_TYPES, gitCommandTypes }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    await assert.rejects(client.verifyCompatibility(), /Git capabilities are invalid/)
  }
})

test('Desktop Host attachment capability parsing rejects unknown, duplicate and cross-domain commands', async () => {
  for (const attachmentCommandTypes of [['attachment.raw'], ['attachment.begin', 'attachment.begin'], ['git.refresh'], 'attachment.begin', null]) {
    const client = new DesktopHostClient({
      localPort: 18788, compatibility: { productVersion: '1.0.0', buildCommit: 'fixture' },
      fetchImpl: async () => new Response(JSON.stringify({ protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION, productVersion: '1.0.0',
        buildCommit: 'fixture', authenticated: false, pairingId: desktopPairingId('d'.repeat(43)),
        capabilities: { kernelCommandTypes: DESKTOP_HOST_KERNEL_COMMAND_TYPES, attachmentCommandTypes }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    await assert.rejects(client.verifyCompatibility(), /attachment capabilities are invalid/)
  }
})

test('real Host pairing survives normal disconnect and restart, and explicit revoke removes both credentials', linuxHostFixture, async () => {
  const fixture = await createGatewayFixture()
  const credentials = createMemoryDesktopDeviceCredentialStore()
  const sent: { path: string; authorization: string | null }[] = []
  const config = { sshHostAlias: 'fixture', localPort: fixture.port, desktopHostPort: fixture.port }
  const session = createWindowsRemoteSession({ productVersion: '1.0.0', buildCommit: 'test-build', onEvent: () => {},
    credentialStore: credentials,
    createClient: (options) => new DesktopHostClient({ ...options, fetchImpl: async (input, init) => {
      sent.push({ path: new URL(String(input)).pathname, authorization: new Headers(init?.headers).get('authorization') })
      return fetch(input, init)
    } }),
    startTunnel: async ({ verifyUnauthenticatedDesktopHost }) => {
      const controller = new AbortController()
      let end!: (value: Awaited<SystemSshTunnel['termination']>) => void
      const termination = new Promise<Awaited<SystemSshTunnel['termination']>>((resolve) => { end = resolve })
      await verifyUnauthenticatedDesktopHost(controller.signal)
      return { connectionSignal: controller.signal, termination, async stop() {
        controller.abort()
        end({ expected: true, code: 0, signal: null, error: null, stderr: '' })
      } }
    }
  })
  try {
    await session.connect({ ...config, pairingCode: '123456' })
    const credential = await credentials.load()
    assert.equal(credential, 'c'.repeat(43))
    await session.disconnect()
    assert.equal(await credentials.load(), credential)
    assert.equal(sent.filter((entry) => entry.path === DESKTOP_HOST_API_PATHS.logout).length, 0)
    await fixture.restart()
    await session.connect(config)
    assert.equal(session.status().phase, 'connected')
    assert.equal(sent.filter((entry) => entry.path === DESKTOP_HOST_API_PATHS.pair).length, 1)
    await session.revokePairing(config)
    assert.equal(session.status().phase, 'disconnected')
    assert.equal(await credentials.load(), null)
    assert.equal(sent.filter((entry) => entry.path === DESKTOP_HOST_API_PATHS.logout).length, 1)
    const response = await fetch(`http://127.0.0.1:${fixture.port}${DESKTOP_HOST_API_PATHS.session}`, {
      headers: { Authorization: `Bearer ${credential}` }
    })
    const status = await response.json() as { authenticated: boolean; pairingId: string | null }
    assert.equal(status.authenticated, false)
    assert.equal(status.pairingId, null)
  } finally { await session.close(); await fixture.close() }
})

test('logout must receive explicit compatible unpaired status before clearing its credential', async () => {
  const credential = 'd'.repeat(43)
  const requests: (string | null)[] = []
  let logout = false
  const client = new DesktopHostClient({ localPort: 18788, compatibility: { productVersion: '1.0.0', buildCommit: 'test-build' },
    fetchImpl: async (_input, init) => {
      requests.push(new Headers(init?.headers).get('authorization'))
      logout = init?.method === 'POST'
      return Response.json({ protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION, productVersion: '1.0.0', buildCommit: 'test-build',
        authenticated: false, pairingId: desktopPairingId(credential), capabilities: { kernelCommandTypes: [...DESKTOP_HOST_KERNEL_COMMAND_TYPES] } })
    }
  })
  await client.verifyCompatibility()
  client.setCredential(credential)
  await assert.rejects(client.logout(), /did not confirm pairing revocation/)
  assert.equal(logout, true)
  await client.getSession()
  assert.deepEqual(requests, [null, `Bearer ${credential}`, `Bearer ${credential}`])
})
