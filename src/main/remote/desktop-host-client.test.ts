import assert from 'node:assert/strict'
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
      protocolVersion: 2,
      productVersion: '1.0.0',
      buildCommit: 'host-build',
      authenticated: false,
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
    authenticated: false,
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
        authenticated: false,
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

test('Desktop Host client pairs, owns one event controller, reads state, commands, and logs out', async () => {
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

test('Desktop Host client surfaces typed stale identity conflict and never retries a mutation', async () => {
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
          authenticated: false,
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
          authenticated: false,
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
})

async function createGatewayFixture(): Promise<{
  port: number
  gateway: Awaited<ReturnType<typeof startDesktopHostGateway>>
  dispatched: string[]
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
  const deviceStore = await openRemoteDeviceStore({
    path: config.deviceStorePath,
    uid: process.getuid?.() ?? 0
  })
  const dispatched: string[] = []
  const gateway = await startDesktopHostGateway({
    config,
    productVersion: '1.0.0',
    buildCommit: 'test-build',
    deviceStore,
    randomPairingCode: () => '123456',
    randomDeviceCredential: () => 'c'.repeat(43),
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
  gateway.createPairingCode()
  return {
    port,
    gateway,
    dispatched,
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
