import { DESKTOP_ATTACHMENT_COMMAND_TYPES } from '../../shared/desktop-attachment-contract.ts'
import assert from 'node:assert/strict'
import test from 'node:test'

import type { KernelSnapshot } from '../../shared/kernel-contract.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION, DESKTOP_HOST_KERNEL_COMMAND_TYPES, DESKTOP_HOST_GIT_COMMAND_TYPES } from '../../shared/desktop-host-contract.ts'
import { DesktopHostClient, DesktopHostClientError } from './desktop-host-client.ts'
import { desktopPairingId } from './desktop-device-binding.ts'
import { SystemSshTunnelError } from './system-ssh-tunnel.ts'
import { createMemoryDesktopDeviceCredentialStore } from './desktop-device-credential-store.ts'
import type { SystemSshTunnel } from './system-ssh-tunnel.ts'
import {
  createWindowsRemoteSession,
  parseWindowsRemoteConnectRequest,
  type CreateWindowsRemoteSessionOptions
} from './windows-remote-session.ts'

const snapshot = {
  revision: 7,
  state: {
    activeProjectKey: '/project',
    activeSessionKey: 'session-1'
  }
} as KernelSnapshot

const STORED_CREDENTIAL = 'A'.repeat(32)
const HOST = {
  sshHostAlias: 'pi-linux',
  localPort: 18788,
  desktopHostPort: 18788
} as const

test('a different Host pairing identity never receives or deletes the cached credential', async () => {
  const store = createMemoryDesktopDeviceCredentialStore(STORED_CREDENTIAL)
  const authorizations: (string | null)[] = []
  const session = createWindowsRemoteSession({ productVersion: '1.0.0', buildCommit: 'fixture', credentialStore: store,
    initialLastHost: HOST, initialHasStoredCredential: true, initialCachedCredential: STORED_CREDENTIAL, onEvent: () => assert.fail('must not publish state'),
    createClient: (options) => new DesktopHostClient({ ...options, fetchImpl: async (_input, init) => {
      authorizations.push(new Headers(init?.headers).get('authorization'))
      return Response.json({ protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION, productVersion: '1.0.0', buildCommit: 'fixture',
        authenticated: false, pairingId: desktopPairingId('B'.repeat(32)), capabilities: { kernelCommandTypes: DESKTOP_HOST_KERNEL_COMMAND_TYPES } })
    } }),
    startTunnel: async (options) => { const owned = createFakeTunnel(); await options.verifyUnauthenticatedDesktopHost(owned.connectionSignal); return owned }
  })
  await assert.rejects(session.connect(HOST), (error) => error instanceof DesktopHostClientError && error.code === 'credential-target')
  assert.deepEqual(authorizations, [null])
  assert.equal(session.status().phase, 'disconnected')
  assert.equal(session.status().failureKind, 'credential-target')
  assert.equal(session.status().hasStoredCredential, true)
  assert.equal(await store.load(), STORED_CREDENTIAL)
  await session.close()
})

test('Windows remote connect request is a strict alias, ports, and optional 6-digit pairing code', () => {
  assert.deepEqual(parseWindowsRemoteConnectRequest({
    ...HOST,
    pairingCode: '123456'
  }), {
    ...HOST,
    pairingCode: '123456'
  })
  assert.deepEqual(parseWindowsRemoteConnectRequest({ ...HOST }), { ...HOST })
  assert.throws(() => parseWindowsRemoteConnectRequest({
    ...HOST,
    pairingCode: '123456',
    credential: 'must-not-enter'
  }), /optional pairingCode/)
  assert.throws(() => parseWindowsRemoteConnectRequest({
    sshHostAlias: '-oBatchMode=no',
    localPort: 18788,
    desktopHostPort: 18788,
    pairingCode: '123456'
  }), /SSH host alias/)
  assert.throws(() => parseWindowsRemoteConnectRequest({
    ...HOST,
    pairingCode: '12 456'
  }), /6 digits/)
})

test('Windows remote session handshakes, pairs, stores the credential, and refuses attachments', async () => {
  const events: string[] = []
  const statuses: string[] = []
  const calls: string[] = []
  const credentialStore = createMemoryDesktopDeviceCredentialStore()
  const session = createWindowsRemoteSession({
    productVersion: '1.0.0',
    buildCommit: 'test-build',
    credentialStore,
    onEvent: (event) => events.push(event.type),
    onStatus: (status) => statuses.push(status.phase),
    startTunnel: async ({ verifyUnauthenticatedDesktopHost }) => {
      const tunnel = createFakeTunnel()
      await verifyUnauthenticatedDesktopHost(tunnel.connectionSignal)
      return tunnel
    },
    createClient: () => createFakeHostClient(calls)
  })
  assert.deepEqual(session.status(), {
    mode: 'windows-remote',
    phase: 'disconnected',
    hasStoredCredential: false,
    lastHost: null,
    capabilities: null,
    error: null,
    failureKind: null,
    recovery: null
  })
  await session.connect({
    ...HOST,
    pairingCode: '123456'
  })
  assert.equal(session.status().phase, 'connected')
  assert.equal(session.status().hasStoredCredential, true)
  assert.deepEqual(session.status().lastHost, HOST)
  assert.equal(await credentialStore.load(), STORED_CREDENTIAL)
  assert.deepEqual(calls.slice(0, 4), ['verify', 'pair:123456', 'sse', 'state'])
  assert.deepEqual(await session.dispatch({ type: 'kernel.get-state' }), snapshot)
  await session.dispatch({ type: 'kernel.abort' }, { projectKey: '/project', sessionKey: 'session-1' })
  assert.ok(calls.includes('kernel.abort'))
  await assert.rejects(
    () => session.dispatch({
      type: 'kernel.prompt',
      message: 'hello',
      expectedSessionKey: 'session-1',
      attachments: [{ type: 'file', name: 'secret.txt', path: 'C\\\\temp\\\\secret.txt' }]
    }),
    /does not send local file attachments/
  )
  await assert.rejects(
    () => session.dispatch({ type: 'kernel.create-task' }),
    /not available on the Windows remote-only client/
  )
  assert.equal(calls.includes('kernel.prompt'), false)
  await session.disconnect()
  assert.equal(session.status().phase, 'disconnected')
  assert.equal(session.status().hasStoredCredential, true)
  assert.equal(await credentialStore.load(), STORED_CREDENTIAL)
  assert.deepEqual(statuses, ['connecting', 'connected', 'disconnecting', 'disconnected'])
  assert.ok(events.includes('kernel.state-changed'))
  assert.equal(calls.includes('logout'), false)
})

test('Windows remote session resumes a stored credential without pairing and does not replay mutations', async () => {
  const calls: string[] = []
  const credentialStore = createMemoryDesktopDeviceCredentialStore(STORED_CREDENTIAL)
  const session = createWindowsRemoteSession({
    productVersion: '1.0.0',
    buildCommit: 'test-build',
    credentialStore,
    initialHasStoredCredential: true,
    initialLastHost: HOST,
    onEvent: () => undefined,
    startTunnel: async ({ verifyUnauthenticatedDesktopHost }) => {
      const tunnel = createFakeTunnel()
      await verifyUnauthenticatedDesktopHost(tunnel.connectionSignal)
      return tunnel
    },
    createClient: () => createFakeHostClient(calls)
  })
  await session.connect({ ...HOST })
  assert.equal(session.status().phase, 'connected')
  assert.deepEqual(calls.filter((call) => call.startsWith('pair')), [])
  assert.ok(calls.includes(`setCredential:${STORED_CREDENTIAL}`))
  assert.equal(calls.includes('kernel.prompt'), false)
})

test('Windows remote session fail-closes when compatibility handshake fails', async () => {
  let started = false
  const session = createWindowsRemoteSession({
    productVersion: '1.0.0',
    buildCommit: 'test-build',
    onEvent: () => undefined,
    startTunnel: async ({ verifyUnauthenticatedDesktopHost }) => {
      started = true
      const tunnel = createFakeTunnel()
      await verifyUnauthenticatedDesktopHost(tunnel.connectionSignal)
      return tunnel
    },
    createClient: (clientOptions) => new DesktopHostClient({
      ...clientOptions,
      fetchImpl: async () => new Response(JSON.stringify({
        protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
        productVersion: '9.9.9',
        buildCommit: 'other-build',
        authenticated: false,
        pairingId: null,
        capabilities: { kernelCommandTypes: DESKTOP_HOST_KERNEL_COMMAND_TYPES }
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    })
  })
  await assert.rejects(
    () => session.connect({
      ...HOST,
      pairingCode: '123456'
    }),
    /product version mismatch/
  )
  assert.equal(started, true)
  assert.equal(session.status().phase, 'disconnected')
})

test('Windows remote session rebuilds the tunnel and snapshot once after an unexpected drop', async () => {
  const statuses: string[] = []
  const calls: string[] = []
  const tunnels: Array<SystemSshTunnel & { endUnexpected(): void }> = []
  let resolveReconnected: (() => void) | null = null
  const reconnected = new Promise<void>((resolve) => {
    resolveReconnected = resolve
  })
  const session = createWindowsRemoteSession({
    productVersion: '1.0.0',
    buildCommit: 'test-build',
    credentialStore: createMemoryDesktopDeviceCredentialStore(),
    onEvent: () => undefined,
    onStatus: (status) => {
      statuses.push(status.phase)
      if (status.phase === 'connected' && statuses.includes('reconnecting')) {
        resolveReconnected?.()
      }
    },
    startTunnel: async ({ verifyUnauthenticatedDesktopHost }) => {
      const tunnel = createFakeTunnel()
      tunnels.push(tunnel)
      await verifyUnauthenticatedDesktopHost(tunnel.connectionSignal)
      return tunnel
    },
    createClient: () => createFakeHostClient(calls)
  })
  await session.connect({
    ...HOST,
    pairingCode: '123456'
  })
  const commandCallsBeforeDrop = calls.filter((call) => call.startsWith('kernel.')).length
  tunnels[0]?.endUnexpected()
  await reconnected
  assert.equal(session.status().phase, 'connected')
  assert.equal(tunnels.length, 2)
  assert.deepEqual(statuses, ['connecting', 'connected', 'reconnecting', 'reconnecting', 'connected'])
  assert.equal(calls.filter((call) => call.startsWith('pair:')).length, 1)
  assert.ok(calls.includes(`setCredential:${STORED_CREDENTIAL}`))
  assert.equal(calls.filter((call) => call.startsWith('kernel.')).length, commandCallsBeforeDrop)
})

test('stale Renderer identity is sent unchanged and rejected after Host navigation', async () => {
  const calls: string[] = []
  const client = createFakeHostClient(calls)
  let activeSession = 'session-1'
  client.getState = async () => ({
    revision: 8,
    state: { ...snapshot.state, activeSessionKey: activeSession }
  })
  client.command = async (_controller, identity) => {
    calls.push(`target:${identity.sessionKey}`)
    if (identity.sessionKey !== activeSession) throw new Error('409 stale control identity')
    return { revision: 8 }
  }
  const session = createWindowsRemoteSession({
    productVersion: '1.0.0', buildCommit: 'test-build', onEvent: () => {},
    startTunnel: async ({ verifyUnauthenticatedDesktopHost }) => {
      const tunnel = createFakeTunnel()
      await verifyUnauthenticatedDesktopHost(tunnel.connectionSignal)
      return tunnel
    },
    createClient: () => client
  })
  await session.connect({ ...HOST, pairingCode: '123456' })
  activeSession = 'session-2'
  for (const command of [
    { type: 'kernel.abort' } as const,
    { type: 'kernel.steer', message: 'stop editing' } as const,
    { type: 'kernel.follow-up', message: 'continue' } as const
  ]) {
    await assert.rejects(session.dispatch(command, { projectKey: '/project', sessionKey: 'session-1' }), /409/)
  }
  assert.deepEqual(calls.filter((call) => call.startsWith('target:')), Array(3).fill('target:session-1'))
  await assert.rejects(session.dispatch({ type: 'kernel.abort' }), /observed by the Renderer/)
  await session.dispatch({ type: 'kernel.abort' }, { projectKey: '/project', sessionKey: 'session-2' })
  await session.close()
})

test('closing a connected client preserves pairing for the next launch', async () => {
  const calls: string[] = []
  const credentials = createMemoryDesktopDeviceCredentialStore()
  const create = (stored: boolean) => createWindowsRemoteSession({
    productVersion: '1.0.0', buildCommit: 'test-build', credentialStore: credentials,
    initialHasStoredCredential: stored, onEvent: () => {},
    startTunnel: async ({ verifyUnauthenticatedDesktopHost }) => {
      const tunnel = createFakeTunnel()
      await verifyUnauthenticatedDesktopHost(tunnel.connectionSignal)
      return tunnel
    },
    createClient: () => createFakeHostClient(calls)
  })
  const first = create(false)
  await first.connect({ ...HOST, pairingCode: '123456' })
  await first.close()
  assert.equal(await credentials.load(), STORED_CREDENTIAL)
  assert.equal(calls.includes('logout'), false)
  const second = create(true)
  await second.connect(HOST)
  assert.equal(calls.filter((call) => call.startsWith('pair:')).length, 1)
  await second.revokePairing(HOST)
  assert.equal(await credentials.load(), null)
  assert.equal(calls.includes('logout'), true)
})

test('close reports cleanup failures, retains the credential, and can retry its owned tunnel', async () => {
  const calls: string[] = []
  const credentials = createMemoryDesktopDeviceCredentialStore()
  const tunnel = createFakeTunnel()
  const stop = tunnel.stop.bind(tunnel)
  let attempts = 0
  tunnel.stop = async () => {
    if (++attempts === 1) throw new Error('tunnel still running')
    await stop()
  }
  const session = createWindowsRemoteSession({
    productVersion: '1.0.0', buildCommit: 'test-build', credentialStore: credentials,
    onEvent: () => {},
    startTunnel: async ({ verifyUnauthenticatedDesktopHost }) => {
      await verifyUnauthenticatedDesktopHost(tunnel.connectionSignal)
      return tunnel
    },
    createClient: () => createFakeHostClient(calls)
  })
  await session.connect({ ...HOST, pairingCode: '123456' })
  await assert.rejects(session.close(), (error: unknown) => error instanceof AggregateError && error.errors[0]?.message === 'tunnel still running')
  assert.equal(await credentials.load(), STORED_CREDENTIAL)
  assert.equal(calls.includes('logout'), false)
  await session.close()
  assert.equal(attempts, 2)
  assert.equal(tunnel.connectionSignal.aborted, true)
})

test('recovery backs off through a temporary outage without replaying a failed mutation', async (t) => {
  const fixture = createRecoveryFixture({
    startError: (attempt) => attempt === 2 || attempt === 3
      ? new SystemSshTunnelError('Connection refused', 'network') : null
  })
  t.after(() => fixture.session.close())
  await fixture.session.connect({ ...HOST, pairingCode: '123456' })
  fixture.clients[0]!.command = async () => {
    fixture.calls.push('uncertain-prompt')
    throw new DesktopHostClientError('Response lost', 'network')
  }
  await assert.rejects(fixture.session.dispatch({ type: 'kernel.prompt', message: 'edit', expectedSessionKey: 'session-1' },
    { projectKey: '/project', sessionKey: 'session-1' }), /Response lost/)
  fixture.tunnels[0]!.endUnexpected()
  await fixture.until(() => fixture.attempts() === 4 && fixture.session.status().phase === 'connected')
  assert.deepEqual(fixture.delays, [1_000, 2_000])
  assert.equal(fixture.calls.filter((call) => call === 'uncertain-prompt').length, 1)
  assert.equal(fixture.calls.filter((call) => call.startsWith('pair:')).length, 1)
  assert.equal(fixture.session.status().recovery, null)
  assert.equal(fixture.session.status().error, null)
})

test('recovery stops after five attempts and permits an explicit retry with the saved credential', async (t) => {
  let unavailable = true
  const fixture = createRecoveryFixture({
    startError: (attempt) => attempt > 1 && unavailable
      ? new SystemSshTunnelError('Connection timed out', 'network') : null
  })
  t.after(() => fixture.session.close())
  await fixture.session.connect({ ...HOST, pairingCode: '123456' })
  fixture.tunnels[0]!.endUnexpected()
  await fixture.until(() => fixture.session.status().phase === 'disconnected')
  assert.equal(fixture.attempts(), 6)
  assert.deepEqual(fixture.delays, [1_000, 2_000, 4_000, 8_000])
  assert.deepEqual(fixture.session.status().recovery, { attempt: 5, maxAttempts: 5, delayMs: 0 })
  assert.equal(fixture.session.status().failureKind, 'network')
  assert.match(fixture.session.status().error ?? '', /Connection timed out/)
  assert.equal(await fixture.credentials.load(), STORED_CREDENTIAL)
  unavailable = false
  await fixture.session.connect(HOST)
  assert.equal(fixture.session.status().phase, 'connected')
  assert.equal(fixture.calls.filter((call) => call.startsWith('pair:')).length, 1)
})

for (const failure of [
  new DesktopHostClientError('Device revoked', 'unauthorized', 401),
  new DesktopHostClientError('Build mismatch', 'protocol'),
  new SystemSshTunnelError('Permission denied', 'authentication'),
  new SystemSshTunnelError('Host key verification failed', 'host-key'),
  new SystemSshTunnelError('Address already in use', 'configuration'),
  new Error('Unexpected local failure')
]) {
  test(`recovery stops on ${failure.message} instead of repeating a permanent failure`, async (t) => {
    const fixture = createRecoveryFixture({
      configureClient: (client, attempt) => {
        if (attempt > 1) client.openEventStream = async () => { throw failure }
      }
    })
    t.after(() => fixture.session.close())
    await fixture.session.connect({ ...HOST, pairingCode: '123456' })
    fixture.tunnels[0]!.endUnexpected()
    await fixture.until(() => fixture.session.status().phase === 'disconnected')
    assert.equal(fixture.attempts(), 2)
    assert.deepEqual(fixture.delays, [])
    assert.match(fixture.session.status().error ?? '', new RegExp(failure.message))
    assert.notEqual(fixture.session.status().failureKind, 'network')
    assert.equal(await fixture.credentials.load(), failure instanceof DesktopHostClientError && failure.status === 401
      ? null : STORED_CREDENTIAL)
    assert.equal(fixture.tunnels[1]!.connectionSignal.aborted, true)
  })
}

test('recovery handshake failure never loads the saved credential into the new client', async (t) => {
  const fixture = createRecoveryFixture({
    configureClient: (client, attempt) => {
      if (attempt > 1) client.verifyCompatibility = async () => { throw new DesktopHostClientError('Build changed') }
    }
  })
  t.after(() => fixture.session.close())
  await fixture.session.connect({ ...HOST, pairingCode: '123456' })
  fixture.tunnels[0]!.endUnexpected()
  await fixture.until(() => fixture.session.status().phase === 'disconnected')
  assert.equal(fixture.calls.some((call) => call.startsWith('setCredential:')), false)
  assert.equal(fixture.session.status().failureKind, 'protocol')
})

test('closing during backoff cancels the timer and keeps the pairing', async (t) => {
  let retrySignal: AbortSignal | null = null
  const fixture = createRecoveryFixture({
    startError: (attempt) => attempt > 1 ? new SystemSshTunnelError('Connection refused', 'network') : null,
    waitForRetry: async (_delay, signal) => {
      retrySignal = signal
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    }
  })
  t.after(() => fixture.session.close())
  await fixture.session.connect({ ...HOST, pairingCode: '123456' })
  fixture.tunnels[0]!.endUnexpected()
  await fixture.until(() => retrySignal !== null)
  await fixture.session.close()
  assert.equal((retrySignal as unknown as AbortSignal).aborted, true)
  assert.equal(fixture.attempts(), 2)
  assert.equal(fixture.session.status().phase, 'disconnected')
  assert.equal(fixture.session.status().recovery, null)
  assert.equal(fixture.session.status().error, null)
  assert.equal(await fixture.credentials.load(), STORED_CREDENTIAL)
})

test('commands remain blocked while the recovered snapshot is pending; late snapshot cannot reopen a closed client', async (t) => {
  let resolveSnapshot: ((value: KernelSnapshot) => void) | null = null
  const fixture = createRecoveryFixture({
    configureClient: (client, attempt) => {
      if (attempt > 1) client.getState = async () => await new Promise<KernelSnapshot>((resolve) => { resolveSnapshot = resolve })
    }
  })
  t.after(() => fixture.session.close())
  await fixture.session.connect({ ...HOST, pairingCode: '123456' })
  fixture.tunnels[0]!.endUnexpected()
  await fixture.until(() => resolveSnapshot !== null)
  assert.equal(fixture.session.status().phase, 'reconnecting')
  await assert.rejects(fixture.session.dispatch({ type: 'kernel.abort' },
    { projectKey: '/project', sessionKey: 'session-1' }), /not connected/)
  const closing = fixture.session.close()
  assert.equal(fixture.session.status().phase, 'disconnecting')
  await assert.rejects(fixture.session.connect(HOST), /already in progress/)
  ;(resolveSnapshot as unknown as (value: KernelSnapshot) => void)(snapshot)
  await closing
  await fixture.until(() => fixture.tunnels[1]!.connectionSignal.aborted)
  assert.equal(fixture.session.status().phase, 'disconnected')
  assert.equal(fixture.calls.includes('kernel.abort'), false)
})

test('simultaneous tunnel and event-stream loss trigger one recovery', async (t) => {
  let endStream: (() => void) | null = null
  const fixture = createRecoveryFixture({
    configureClient: (client, attempt) => {
      if (attempt === 1) client.openEventStream = async () => ({
        closed: new Promise<void>((resolve) => { endStream = resolve }),
        close: async () => { endStream?.() }
      })
    }
  })
  t.after(() => fixture.session.close())
  await fixture.session.connect({ ...HOST, pairingCode: '123456' })
  fixture.tunnels[0]!.endUnexpected()
  ;(endStream as unknown as () => void)()
  await fixture.until(() => fixture.attempts() === 2 && fixture.session.status().phase === 'connected')
  assert.equal(fixture.attempts(), 2)
})

test('cleanup failure stops recovery and retains ownership for an explicit close', async () => {
  const fixture = createRecoveryFixture()
  await fixture.session.connect({ ...HOST, pairingCode: '123456' })
  const tunnel = fixture.tunnels[0]!
  const stop = tunnel.stop
  tunnel.stop = async () => { throw new Error('Cannot stop SSH process') }
  tunnel.endUnexpected()
  await fixture.until(() => fixture.session.status().phase === 'disconnected')
  assert.equal(fixture.attempts(), 1)
  assert.match(fixture.session.status().error ?? '', /Cannot stop SSH process/)
  tunnel.stop = stop
  await fixture.session.close()
})

function createRecoveryFixture(options: {
  startError?: (attempt: number) => unknown
  configureClient?: (client: DesktopHostClient, attempt: number) => void
  waitForRetry?: CreateWindowsRemoteSessionOptions['waitForRetry']
} = {}) {
  const calls: string[] = []
  const delays: number[] = []
  const clients: DesktopHostClient[] = []
  const tunnels: ReturnType<typeof createFakeTunnel>[] = []
  const credentials = createMemoryDesktopDeviceCredentialStore()
  let attempts = 0
  const session = createWindowsRemoteSession({
    productVersion: '1.0.0', buildCommit: 'test-build', credentialStore: credentials,
    onEvent: () => {},
    waitForRetry: options.waitForRetry ?? (async (delay) => { delays.push(delay) }),
    createClient: () => {
      const client = createFakeHostClient(calls)
      options.configureClient?.(client, clients.length + 1)
      clients.push(client)
      return client
    },
    startTunnel: async ({ verifyUnauthenticatedDesktopHost }) => {
      attempts += 1
      const failure = options.startError?.(attempts)
      if (failure) throw failure
      const tunnel = createFakeTunnel()
      tunnels.push(tunnel)
      try {
        await verifyUnauthenticatedDesktopHost(tunnel.connectionSignal)
        return tunnel
      } catch (error) {
        await tunnel.stop()
        throw error
      }
    }
  })
  return {
    session, calls, delays, clients, tunnels, credentials, attempts: () => attempts,
    async until(predicate: () => boolean) {
      const deadline = Date.now() + 2_000
      while (!predicate()) {
        if (Date.now() >= deadline) assert.fail(`Timed out waiting for recovery: ${JSON.stringify(session.status())}`)
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }
  }
}

function createFakeTunnel(): SystemSshTunnel & { endUnexpected(): void } {
  const controller = new AbortController()
  let resolveTermination!: (value: Awaited<SystemSshTunnel['termination']>) => void
  const termination = new Promise<Awaited<SystemSshTunnel['termination']>>((resolve) => {
    resolveTermination = resolve
  })
  return {
    connectionSignal: controller.signal,
    termination,
    async stop() {
      controller.abort()
      resolveTermination({
        expected: true,
        code: null,
        signal: 'SIGTERM',
        error: null,
        stderr: ''
      })
    },
    endUnexpected() {
      controller.abort()
      resolveTermination({
        expected: false,
        code: 255,
        signal: null,
        error: null,
        stderr: ''
      })
    }
  }
}

function createFakeHostClient(calls: string[], gitEnabled = false, attachmentsEnabled = false): DesktopHostClient {
  return {
    async verifyCompatibility() {
      calls.push('verify')
      return {
        capabilities: { kernelCommandTypes: [...DESKTOP_HOST_KERNEL_COMMAND_TYPES], ...(gitEnabled ? { gitCommandTypes: DESKTOP_HOST_GIT_COMMAND_TYPES } : {}), ...(attachmentsEnabled ? { attachmentCommandTypes: DESKTOP_ATTACHMENT_COMMAND_TYPES } : {}) }
      }
    },
    async pair(code: string) {
      calls.push(`pair:${code}`)
      return {
        credential: STORED_CREDENTIAL,
        capabilities: { kernelCommandTypes: [...DESKTOP_HOST_KERNEL_COMMAND_TYPES], ...(gitEnabled ? { gitCommandTypes: DESKTOP_HOST_GIT_COMMAND_TYPES } : {}), ...(attachmentsEnabled ? { attachmentCommandTypes: DESKTOP_ATTACHMENT_COMMAND_TYPES } : {}) }
      }
    },
    setCredential(credential: string) {
      calls.push(`setCredential:${credential}`)
    },
    async openEventStream() {
      calls.push('sse')
      let resolveClosed!: () => void
      return {
        closed: new Promise<void>((resolve) => {
          resolveClosed = resolve
        }),
        async close() {
          resolveClosed()
        }
      }
    },
    async getState() {
      calls.push('state')
      return snapshot
    },
    async command(_controllerId: string, _identity: unknown, command: { type: string }) {
      calls.push(command.type)
      return { revision: 8 }
    },
    async logout() {
      calls.push('logout')
    },
    clearCredential() {
      calls.push('clear')
    }
  } as unknown as DesktopHostClient
}

test('Windows Extension responses preserve owner fields and reject a result after connection loss', async () => {
  const client = createFakeHostClient([])
  const sent: unknown[] = []
  client.command = async (_controller, identity, command) => { sent.push({ identity, command }); return { revision: 1 } }
  const session = createWindowsRemoteSession({
    productVersion: '1.0.0', buildCommit: 'test-build', onEvent: () => {},
    startTunnel: async ({ verifyUnauthenticatedDesktopHost }) => {
      const tunnel = createFakeTunnel()
      await verifyUnauthenticatedDesktopHost(tunnel.connectionSignal)
      return tunnel
    }, createClient: () => client
  })
  await session.connect({ ...HOST, pairingCode: '123456' })
  const identity = { projectKey: '/project', sessionKey: 'session-1' }
  const owner = { ...identity, sessionId: 'session-id', requestId: 'request', commandInvocationId: 'invocation' }
  const response = { type: 'kernel.respond-extension-dialog' as const, ...owner, value: '中文回答' }
  await assert.rejects(session.dispatch(response), /identity observed/)
  await session.dispatch(response, identity)
  assert.deepEqual(sent, [{ identity, command: response }])
  let finish!: (value: unknown) => void
  let started!: () => void
  const called = new Promise<void>((resolve) => { started = resolve })
  client.command = async () => { started(); return new Promise((resolve) => { finish = resolve }) }
  const operation = session.dispatch({ type: 'kernel.cancel-extension-dialog', ...owner }, identity)
  const rejected = assert.rejects(operation, /connection changed/)
  await called
  await session.close()
  finish({ revision: 2 })
  await rejected
})

test('Windows Git dispatch requires advertised read capability and preserves the Renderer identity', async () => {
  const calls: string[] = []
  const client = createFakeHostClient(calls, true)
  const sent: unknown[] = []
  client.command = async (_controller, identity, command) => { sent.push({ identity, command }); return { result: 'read' } }
  const session = createWindowsRemoteSession({
    productVersion: '1.0.0', buildCommit: 'test-build', onEvent: () => {},
    startTunnel: async ({ verifyUnauthenticatedDesktopHost }) => {
      const tunnel = createFakeTunnel()
      await verifyUnauthenticatedDesktopHost(tunnel.connectionSignal)
      return tunnel
    }, createClient: () => client
  })
  await session.connect({ ...HOST, pairingCode: '123456' })
  try {
    await assert.rejects(session.dispatch({ type: 'git.refresh', projectKey: '/project' }), /identity observed/)
    const identity = { projectKey: '/project', sessionKey: 'renderer-session' }
    await session.dispatch({ type: 'git.refresh', projectKey: '/project' }, identity)
    assert.deepEqual(sent, [{ identity, command: { type: 'git.refresh', projectKey: '/project' } }])
    const fileCommand = { type: 'git.read-file' as const, projectKey: '/project', request: {
      path: '中文 file.txt', expectedRepositoryRoot: '/project', expectedHeadOid: null,
      expectedIndexTreeOid: null, expectedStatusRevision: 'a'.repeat(64)
    } }
    await session.dispatch(fileCommand, identity)
    assert.deepEqual(sent[1], { identity, command: fileCommand })
    await assert.rejects(session.dispatch({ type: 'git.prepare-branch-sync', projectKey: '/project' }, identity), /not available/)
  } finally { await session.close() }
})

test('Windows Git cannot use an unadvertised command or publish a read from a closed connection', async () => {
  for (const type of ['git.refresh', 'git.read-file'] as const) for (const enabled of [false, true]) {
    const client = createFakeHostClient([], enabled)
    let finish!: (value: unknown) => void
    let started!: () => void
    const called = new Promise<void>((resolve) => { started = resolve })
    client.command = async () => { started(); return new Promise((resolve) => { finish = resolve }) }
    const session = createWindowsRemoteSession({
      productVersion: '1.0.0', buildCommit: 'test-build', onEvent: () => {},
      startTunnel: async ({ verifyUnauthenticatedDesktopHost }) => {
        const tunnel = createFakeTunnel()
        await verifyUnauthenticatedDesktopHost(tunnel.connectionSignal)
        return tunnel
      }, createClient: () => client
    })
    await session.connect({ ...HOST, pairingCode: '123456' })
    const command = type === 'git.refresh' ? { type, projectKey: '/project' } : { type, projectKey: '/project', request: {
      path: 'file.txt', expectedRepositoryRoot: '/project', expectedHeadOid: null,
      expectedIndexTreeOid: null, expectedStatusRevision: 'a'.repeat(64)
    } }
    const operation = session.dispatch(command, { projectKey: '/project', sessionKey: 'session-1' })
    const rejected = assert.rejects(operation, enabled ? /connection changed/ : /does not advertise/)
    if (enabled) await called
    await session.close()
    if (enabled) finish({ result: 'old host' })
    await rejected
  }
})


test('Windows uploads require advertised attachment capability and reject results after connection loss', async () => {
  for (const enabled of [false, true]) {
    const client = createFakeHostClient([], false, enabled)
    let finish!: (value: unknown) => void
    let started!: () => void
    let count = 0
    const called = new Promise<void>((resolve) => { started = resolve })
    client.command = async (_controller, identity, command) => {
      count++
      assert.deepEqual(identity, { projectKey: '/project', sessionKey: 'observed' })
      assert.equal(command.type, 'attachment.begin')
      started()
      return new Promise((resolve) => { finish = resolve })
    }
    const session = createWindowsRemoteSession({
      productVersion: '1.0.0', buildCommit: 'test-build', onEvent: () => {},
      startTunnel: async ({ verifyUnauthenticatedDesktopHost }) => {
        const tunnel = createFakeTunnel()
        await verifyUnauthenticatedDesktopHost(tunnel.connectionSignal)
        return tunnel
      }, createClient: () => client
    })
    await session.connect({ ...HOST, pairingCode: '123456' })
    const operation = session.dispatch({ type: 'attachment.begin', name: '中文 file.txt', byteCount: 0 }, { projectKey: '/project', sessionKey: 'observed' })
    const rejected = assert.rejects(operation, enabled ? /connection changed/ : /does not advertise/)
    if (enabled) await called
    await session.close()
    if (enabled) finish({ uploadId: 'late' })
    await rejected
    assert.equal(count, enabled ? 1 : 0)
  }
})

test('disconnect drains its owned tunnel, blocks all new work and retains pairing for reconnect', async () => {
  const calls: string[] = []
  const credentials = createMemoryDesktopDeviceCredentialStore()
  const tunnel = createFakeTunnel()
  const stop = tunnel.stop.bind(tunnel)
  let release!: () => void
  const waiting = new Promise<void>((resolve) => { release = resolve })
  let stops = 0
  tunnel.stop = async () => { stops++; await waiting; await stop() }
  const session = createWindowsRemoteSession({ productVersion: '1.0.0', buildCommit: 'test-build', onEvent: () => {},
    credentialStore: credentials, createClient: () => createFakeHostClient(calls),
    startTunnel: async ({ verifyUnauthenticatedDesktopHost }) => { await verifyUnauthenticatedDesktopHost(tunnel.connectionSignal); return tunnel }
  })
  await session.connect({ ...HOST, pairingCode: '123456' })
  const first = session.disconnect()
  const second = session.disconnect()
  assert.equal(session.status().phase, 'disconnecting')
  await assert.rejects(session.connect(HOST), /already in progress/)
  await assert.rejects(session.checkHost('other', HOST), /结束当前/)
  await assert.rejects(session.revokePairing(HOST), /正在收尾/)
  await assert.rejects(session.dispatch({ type: 'kernel.get-state' }), /not connected/)
  release()
  await Promise.all([first, second])
  assert.equal(stops, 1)
  assert.equal(await credentials.load(), STORED_CREDENTIAL)
  assert.equal(calls.includes('logout'), false)
  assert.equal(session.status().phase, 'disconnected')
})

for (const failure of ['logout', 'credential-clear', 'tunnel-stop'] as const) {
  test(`revocation reports ${failure} failures and preserves accurate credential and cleanup state`, async () => {
    const calls: string[] = []
    const credentials = createMemoryDesktopDeviceCredentialStore()
    let clears = 0
    const store = { ...credentials, clear: async () => {
      clears++
      if (failure === 'credential-clear') throw new Error('Credential Manager unavailable')
      await credentials.clear()
    } }
    const tunnel = createFakeTunnel()
    const stop = tunnel.stop.bind(tunnel)
    let stops = 0
    tunnel.stop = async () => { if (++stops === 1 && failure === 'tunnel-stop') throw new Error('still running'); await stop() }
    const fakeClient = createFakeHostClient(calls)
    if (failure === 'logout') fakeClient.logout = async () => { calls.push('logout'); throw new Error('connection lost after request') }
    const session = createWindowsRemoteSession({ productVersion: '1.0.0', buildCommit: 'test-build', onEvent: () => {},
      credentialStore: store, createClient: () => fakeClient,
      startTunnel: async ({ verifyUnauthenticatedDesktopHost }) => { await verifyUnauthenticatedDesktopHost(tunnel.connectionSignal); return tunnel }
    })
    await session.connect({ ...HOST, pairingCode: '123456' })
    await assert.rejects(session.revokePairing({ ...HOST, sshHostAlias: 'other' }), /核对目标/)
    assert.equal(calls.includes('logout'), false)
    assert.equal(session.status().phase, 'connected')
    await assert.rejects(session.revokePairing(HOST), failure === 'logout' ? /结果未确认/ : failure === 'credential-clear' ? /凭证删除失败/ : /cleanup failed/)
    assert.equal(session.status().phase, 'disconnected')
    assert.equal(session.status().hasStoredCredential, failure !== 'tunnel-stop')
    assert.equal(await credentials.load(), failure === 'tunnel-stop' ? null : STORED_CREDENTIAL)
    assert.equal(clears, failure === 'logout' ? 0 : 1)
    assert.ok(session.status().error)
    await assert.rejects(session.revokePairing(HOST), /连接并核对/)
    assert.equal(calls.filter((call) => call === 'logout').length, 1)
    await session.close()
    assert.equal(tunnel.connectionSignal.aborted, true)
  })
}

test('revocation locks the active target, blocks duplicate logout, and clears only after Host acknowledgement', async () => {
  const calls: string[] = []
  const credentials = createMemoryDesktopDeviceCredentialStore()
  let acknowledge!: () => void
  const waiting = new Promise<void>((resolve) => { acknowledge = resolve })
  const fakeClient = createFakeHostClient(calls)
  fakeClient.logout = async () => { calls.push('logout'); await waiting; return { authenticated: false } as never }
  const session = createWindowsRemoteSession({ productVersion: '1.0.0', buildCommit: 'test-build', onEvent: () => {},
    credentialStore: credentials, createClient: () => fakeClient,
    startTunnel: async ({ verifyUnauthenticatedDesktopHost }) => { const tunnel = createFakeTunnel(); await verifyUnauthenticatedDesktopHost(tunnel.connectionSignal); return tunnel }
  })
  await session.connect({ ...HOST, pairingCode: '123456' })
  const revoking = session.revokePairing(HOST)
  const closing = session.close()
  assert.equal(session.status().phase, 'revoking')
  assert.equal(await credentials.load(), STORED_CREDENTIAL)
  await assert.rejects(session.revokePairing(HOST), /正在收尾/)
  await assert.rejects(session.connect(HOST), /already in progress/)
  acknowledge()
  await Promise.all([revoking, closing])
  assert.equal(calls.filter((call) => call === 'logout').length, 1)
  assert.equal(await credentials.load(), null)
  assert.equal(session.status().hasStoredCredential, false)
  assert.deepEqual(session.status().lastHost, HOST)
})

test('a new transport loss during recovery completion still starts the next recovery', async () => {
  const tunnels: ReturnType<typeof createFakeTunnel>[] = []
  let connected = 0
  let ready!: () => void
  const recovered = new Promise<void>((resolve) => { ready = resolve })
  const session = createWindowsRemoteSession({ productVersion: '1.0.0', buildCommit: 'test-build', onEvent: () => {},
    onStatus: (status) => {
      if (status.phase !== 'connected') return
      connected++
      if (connected === 2) tunnels[1]!.endUnexpected()
      if (connected === 3) ready()
    },
    createClient: () => createFakeHostClient([]),
    startTunnel: async ({ verifyUnauthenticatedDesktopHost }) => {
      const tunnel = createFakeTunnel()
      tunnels.push(tunnel)
      await verifyUnauthenticatedDesktopHost(tunnel.connectionSignal)
      return tunnel
    }
  })
  try {
    await session.connect({ ...HOST, pairingCode: '123456' })
    tunnels[0]!.endUnexpected()
    await recovered
    assert.equal(tunnels.length, 3)
    assert.equal(session.status().phase, 'connected')
  } finally { await session.close() }
})

test('disconnect also drains retained-tunnel cleanup at the start of a new connection', async () => {
  const tunnel = createFakeTunnel()
  const stop = tunnel.stop.bind(tunnel)
  let release!: () => void
  const waiting = new Promise<void>((resolve) => { release = resolve })
  let attempts = 0
  let starts = 0
  tunnel.stop = async () => {
    if (++attempts === 1) throw new Error('retained tunnel')
    await waiting
    await stop()
  }
  const session = createWindowsRemoteSession({ productVersion: '1.0.0', buildCommit: 'test-build', onEvent: () => {},
    createClient: () => createFakeHostClient([]),
    startTunnel: async ({ verifyUnauthenticatedDesktopHost }) => { starts++; await verifyUnauthenticatedDesktopHost(tunnel.connectionSignal); return tunnel }
  })
  await session.connect({ ...HOST, pairingCode: '123456' })
  await assert.rejects(session.close(), /cleanup failed/)
  const connecting = session.connect(HOST)
  const cancelled = assert.rejects(connecting, /cancelled/)
  const disconnecting = session.disconnect()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(session.status().phase, 'disconnecting')
  await assert.rejects(session.connect(HOST), /already in progress/)
  assert.equal(attempts, 2)
  release()
  await Promise.all([cancelled, disconnecting])
  assert.equal(starts, 1)
  assert.equal(session.status().phase, 'disconnected')
  assert.equal(tunnel.connectionSignal.aborted, true)
})
