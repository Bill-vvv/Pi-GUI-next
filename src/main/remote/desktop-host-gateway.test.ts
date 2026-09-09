import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DESKTOP_HOST_API_PATHS,
  DESKTOP_HOST_CONTROLLER_HEADER,
  DESKTOP_HOST_KERNEL_COMMAND_TYPES,
  DESKTOP_HOST_PROTOCOL_VERSION
} from '../../shared/desktop-host-contract.ts'
import type { DesktopHostEnabledConfig } from './desktop-host-config.ts'
import {
  hashRemoteDeviceCredential,
  openRemoteDeviceStore,
  type RemoteDeviceStore
} from './remote-device-store.ts'
import { startDesktopHostGateway } from './desktop-host-gateway.ts'

const uid = process.getuid!()
const CONTROLLER_ID = '00000000-0000-4000-8000-000000000001'
const OTHER_CONTROLLER_ID = '00000000-0000-4000-8000-000000000002'
const MACHINE_SECRET = 'h'.repeat(32)
const DEVICE_CREDENTIAL = 'c'.repeat(43)
const CONTROL_IDENTITY = {
  projectKey: '/tmp/desktop-host-project',
  sessionKey: '/tmp/desktop-host-session.jsonl'
} as const

async function listenPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('Failed to allocate ephemeral port.')
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
  return address.port
}

async function withGateway(
  run: (input: {
    baseUrl: string
    gateway: Awaited<ReturnType<typeof startDesktopHostGateway>>
    deviceStore: RemoteDeviceStore
    dispatches: string[]
    setControlIdentity: (identity: { projectKey: string | null, sessionKey: string | null }) => void
  }) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'pi-gui-desktop-host-gateway-'))
  const port = await listenPort()
  const config: DesktopHostEnabledConfig = {
    enabled: true,
    bindHost: '127.0.0.1',
    port,
    token: MACHINE_SECRET,
    tokenFile: join(directory, 'desktop.token'),
    deviceStorePath: join(directory, 'desktop.token.desktop-device')
  }
  const deviceStore = await openRemoteDeviceStore({ path: config.deviceStorePath, uid })
  const dispatches: string[] = []
  let controlIdentity: { projectKey: string | null, sessionKey: string | null } = CONTROL_IDENTITY
  const gateway = await startDesktopHostGateway({
    config,
    productVersion: '0.0.1',
    buildCommit: 'abcdef1',
    deviceStore,
    randomPairingCode: () => '123456',
    randomDeviceCredential: () => DEVICE_CREDENTIAL,
    handlers: {
      getControlIdentity: () => ({ ...controlIdentity }),
      assertCommandPolicy: async () => undefined,
      dispatchCommand: async (command, assertCurrentBoundary) => {
        await assertCurrentBoundary?.()
        dispatches.push(command.type)
        if (command.type === 'kernel.get-state') return { revision: 7, state: { revision: 7 } }
        if (command.type === 'kernel.activate-project') {
          controlIdentity = { projectKey: command.projectKey, sessionKey: null }
        }
        return { revision: 8 }
      }
    }
  })
  try {
    await run({
      baseUrl: `http://127.0.0.1:${port}`,
      gateway,
      deviceStore,
      dispatches,
      setControlIdentity: (identity) => { controlIdentity = identity }
    })
  } finally {
    await gateway.stop()
    await rm(directory, { recursive: true, force: true })
  }
}

async function jsonRequest(
  baseUrl: string,
  path: string,
  init: RequestInit = {}
): Promise<{ status: number, headers: Headers, value: unknown, text: string }> {
  const response = await fetch(`${baseUrl}${path}`, init)
  const text = await response.text()
  let value: unknown = null
  if (text.length > 0 && response.headers.get('content-type')?.startsWith('application/json')) {
    value = JSON.parse(text) as unknown
  }
  return { status: response.status, headers: response.headers, value, text }
}

async function pair(
  baseUrl: string,
  gateway: Awaited<ReturnType<typeof startDesktopHostGateway>>
): Promise<string> {
  const pairing = gateway.createPairingCode()
  const response = await jsonRequest(baseUrl, DESKTOP_HOST_API_PATHS.pair, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
      productVersion: '0.0.1',
      buildCommit: 'abcdef1',
      code: pairing.code
    })
  })
  assert.equal(response.status, 200, response.text)
  const value = response.value as {
    protocolVersion: number
    productVersion: string
    buildCommit: string | null
    credential: string
    capabilities: { kernelCommandTypes: string[] }
  }
  assert.equal(value.protocolVersion, DESKTOP_HOST_PROTOCOL_VERSION)
  assert.equal(value.productVersion, '0.0.1')
  assert.equal(value.buildCommit, 'abcdef1')
  assert.deepEqual(value.capabilities.kernelCommandTypes, DESKTOP_HOST_KERNEL_COMMAND_TYPES)
  return value.credential
}

async function openEvents(
  baseUrl: string,
  credential: string,
  controllerId = CONTROLLER_ID
): Promise<{ response: Response, abort: () => void, reader: ReadableStreamDefaultReader<Uint8Array> }> {
  const controller = new AbortController()
  const response = await fetch(`${baseUrl}${DESKTOP_HOST_API_PATHS.events}`, {
    headers: {
      Authorization: `Bearer ${credential}`,
      [DESKTOP_HOST_CONTROLLER_HEADER]: controllerId
    },
    signal: controller.signal
  })
  const reader = response.body!.getReader()
  const first = await reader.read()
  assert.equal(new TextDecoder().decode(first.value), ': connected\n\n')
  return { response, abort: () => controller.abort(), reader }
}

test('Desktop Host exposes a loopback handshake and one-time bearer pairing without browser cookies', async () => {
  await withGateway(async ({ baseUrl, gateway, deviceStore }) => {
    const session = await jsonRequest(baseUrl, DESKTOP_HOST_API_PATHS.session)
    assert.equal(session.status, 200)
    assert.deepEqual(session.value, {
      protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
      productVersion: '0.0.1',
      buildCommit: 'abcdef1',
      authenticated: false,
      capabilities: { kernelCommandTypes: DESKTOP_HOST_KERNEL_COMMAND_TYPES }
    })

    const credential = await pair(baseUrl, gateway)
    assert.equal(credential, DEVICE_CREDENTIAL)
    assert.equal(session.headers.get('set-cookie'), null)
    assert.equal(
      deviceStore.getDevice()?.credentialHash,
      hashRemoteDeviceCredential(DEVICE_CREDENTIAL)
    )

    const authenticated = await jsonRequest(baseUrl, DESKTOP_HOST_API_PATHS.session, {
      headers: { Authorization: `Bearer ${credential}` }
    })
    assert.equal(authenticated.status, 200)
    assert.equal((authenticated.value as { authenticated: boolean }).authenticated, true)

    const staticResponse = await jsonRequest(baseUrl, '/')
    assert.equal(staticResponse.status, 404)
  })
})

test('Desktop Host rate-limits pairing attempts across code regeneration', async () => {
  await withGateway(async ({ baseUrl, gateway }) => {
    gateway.createPairingCode()
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const unsupported = await jsonRequest(baseUrl, DESKTOP_HOST_API_PATHS.pair, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: 'not-json'
      })
      assert.equal(unsupported.status, 415)
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await jsonRequest(baseUrl, DESKTOP_HOST_API_PATHS.pair, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
          productVersion: '0.0.1',
          buildCommit: 'abcdef1',
          code: '000000'
        })
      })
      assert.equal(response.status, 401)
    }
    gateway.createPairingCode()
    const limited = await jsonRequest(baseUrl, DESKTOP_HOST_API_PATHS.pair, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
        productVersion: '0.0.1',
        buildCommit: 'abcdef1',
        code: '123456'
      })
    })
    assert.equal(limited.status, 429)
  })
})

test('Desktop Host rejects incompatible pairing before replacing the remembered device', async () => {
  await withGateway(async ({ baseUrl, gateway, deviceStore }) => {
    const pairing = gateway.createPairingCode()
    const incompatible = await jsonRequest(baseUrl, DESKTOP_HOST_API_PATHS.pair, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
        productVersion: '0.0.1',
        buildCommit: 'different-build',
        code: pairing.code
      })
    })
    assert.equal(incompatible.status, 409)
    assert.equal(deviceStore.getDevice(), null)

    const compatible = await jsonRequest(baseUrl, DESKTOP_HOST_API_PATHS.pair, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
        productVersion: '0.0.1',
        buildCommit: 'abcdef1',
        code: pairing.code
      })
    })
    assert.equal(compatible.status, 200, compatible.text)
    assert.equal(deviceStore.getDevice()?.credentialHash, hashRemoteDeviceCredential(DEVICE_CREDENTIAL))
  })
})

test('Desktop Host requires an active controller stream before state or command dispatch', async () => {
  await withGateway(async ({ baseUrl, gateway, dispatches }) => {
    const credential = await pair(baseUrl, gateway)
    const authHeaders = {
      Authorization: `Bearer ${credential}`,
      [DESKTOP_HOST_CONTROLLER_HEADER]: CONTROLLER_ID
    }

    const beforeEvents = await jsonRequest(baseUrl, DESKTOP_HOST_API_PATHS.state, {
      headers: authHeaders
    })
    assert.equal(beforeEvents.status, 409)
    const commandBeforeEvents = await jsonRequest(baseUrl, DESKTOP_HOST_API_PATHS.command, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
        requestId: 'request-before-events',
        expectedIdentity: CONTROL_IDENTITY,
        command: { type: 'kernel.abort' }
      })
    })
    assert.equal(commandBeforeEvents.status, 409)
    assert.deepEqual(commandBeforeEvents.value, {
      protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
      requestId: null,
      ok: false,
      error: {
        code: 'conflict',
        message: 'Controller event stream is not active.'
      }
    })
    assert.deepEqual(dispatches, [])

    const events = await openEvents(baseUrl, credential)
    assert.equal(events.response.status, 200)
    try {
      const state = await jsonRequest(baseUrl, DESKTOP_HOST_API_PATHS.state, {
        headers: authHeaders
      })
      assert.equal(state.status, 200)
      assert.deepEqual(state.value, { revision: 7, state: { revision: 7 } })

      const command = await jsonRequest(baseUrl, DESKTOP_HOST_API_PATHS.command, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
          requestId: 'request-1',
          expectedIdentity: CONTROL_IDENTITY,
          command: { type: 'kernel.abort' }
        })
      })
      assert.equal(command.status, 200, command.text)
      assert.deepEqual(command.value, {
        protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
        requestId: 'request-1',
        ok: true,
        value: { revision: 8 }
      })
      assert.deepEqual(dispatches, ['kernel.get-state', 'kernel.abort'])

      const conflicting = await fetch(`${baseUrl}${DESKTOP_HOST_API_PATHS.events}`, {
        headers: {
          Authorization: `Bearer ${credential}`,
          [DESKTOP_HOST_CONTROLLER_HEADER]: OTHER_CONTROLLER_ID
        }
      })
      assert.equal(conflicting.status, 409)
      await conflicting.body?.cancel()
    } finally {
      events.abort()
      await events.reader.cancel().catch(() => undefined)
    }
  })
})

test('Desktop Host permits a command to publish its own new control identity', async () => {
  await withGateway(async ({ baseUrl, gateway, dispatches }) => {
    const credential = await pair(baseUrl, gateway)
    const events = await openEvents(baseUrl, credential)
    try {
      const activated = await jsonRequest(baseUrl, DESKTOP_HOST_API_PATHS.command, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credential}`,
          [DESKTOP_HOST_CONTROLLER_HEADER]: CONTROLLER_ID,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
          requestId: 'request-activate-project',
          expectedIdentity: CONTROL_IDENTITY,
          command: { type: 'kernel.activate-project', projectKey: '/tmp/next-project' }
        })
      })
      assert.equal(activated.status, 200, activated.text)
      assert.deepEqual(activated.value, {
        protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
        requestId: 'request-activate-project',
        ok: true,
        value: { revision: 8 }
      })
      assert.deepEqual(dispatches, ['kernel.activate-project'])
    } finally {
      events.abort()
      await events.reader.cancel().catch(() => undefined)
    }
  })
})

test('Desktop Host rejects stale control identity before remote mutation dispatch', async () => {
  await withGateway(async ({ baseUrl, gateway, dispatches, setControlIdentity }) => {
    const credential = await pair(baseUrl, gateway)
    const events = await openEvents(baseUrl, credential)
    try {
      setControlIdentity({
        projectKey: '/tmp/other-project',
        sessionKey: '/tmp/other-session.jsonl'
      })
      const stale = await jsonRequest(baseUrl, DESKTOP_HOST_API_PATHS.command, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credential}`,
          [DESKTOP_HOST_CONTROLLER_HEADER]: CONTROLLER_ID,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
          requestId: 'request-stale',
          expectedIdentity: CONTROL_IDENTITY,
          command: { type: 'kernel.steer', message: 'do not cross sessions' }
        })
      })
      assert.equal(stale.status, 409)
      assert.deepEqual(stale.value, {
        protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
        requestId: 'request-stale',
        ok: false,
        error: {
          code: 'conflict',
          message: 'Desktop Host state changed; resync before sending another command.'
        }
      })
      assert.deepEqual(dispatches, [])
    } finally {
      events.abort()
      await events.reader.cancel().catch(() => undefined)
    }
  })
})

test('Desktop Host publishes typed events and revocation closes the controller and credential', async () => {
  await withGateway(async ({ baseUrl, gateway }) => {
    const credential = await pair(baseUrl, gateway)
    const events = await openEvents(baseUrl, credential)
    try {
      gateway.publish({
        type: 'kernel.pi-package-install',
        job: { id: 'job-1', name: 'example', status: 'queued', error: null }
      })
      const eventChunk = await events.reader.read()
      const text = new TextDecoder().decode(eventChunk.value)
      assert.match(text, /^data: /u)
      const envelope = JSON.parse(text.slice(6).trim()) as {
        protocolVersion: number
        event: { type: string }
      }
      assert.equal(envelope.protocolVersion, DESKTOP_HOST_PROTOCOL_VERSION)
      assert.equal(envelope.event.type, 'kernel.pi-package-install')

      const revoked = await gateway.revokeDevice()
      assert.equal(revoked.enabled, true)
      if (revoked.enabled) assert.equal(revoked.device, null)

      const session = await jsonRequest(baseUrl, DESKTOP_HOST_API_PATHS.session, {
        headers: { Authorization: `Bearer ${credential}` }
      })
      assert.equal((session.value as { authenticated: boolean }).authenticated, false)
    } finally {
      events.abort()
      await events.reader.cancel().catch(() => undefined)
    }
  })
})

test('Desktop Host rejects protocol mismatch, disallowed commands, bad credentials, and missing controller identity', async () => {
  await withGateway(async ({ baseUrl, gateway }) => {
    const credential = await pair(baseUrl, gateway)
    const events = await openEvents(baseUrl, credential)
    try {
      const unsupportedCommandType = await jsonRequest(
        baseUrl,
        DESKTOP_HOST_API_PATHS.command,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${credential}`,
            [DESKTOP_HOST_CONTROLLER_HEADER]: CONTROLLER_ID,
            'Content-Type': 'text/plain'
          },
          body: '{}'
        }
      )
      assert.equal(unsupportedCommandType.status, 415)
      assert.deepEqual(unsupportedCommandType.value, {
        protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
        requestId: null,
        ok: false,
        error: {
          code: 'bad-request',
          message: 'Content-Type application/json is required.'
        }
      })

      const missingController = await jsonRequest(baseUrl, DESKTOP_HOST_API_PATHS.state, {
        headers: { Authorization: `Bearer ${credential}` }
      })
      assert.equal(missingController.status, 400)

      const missingCommandController = await jsonRequest(
        baseUrl,
        DESKTOP_HOST_API_PATHS.command,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${credential}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
            requestId: 'request-missing-controller',
            expectedIdentity: CONTROL_IDENTITY,
            command: { type: 'kernel.abort' }
          })
        }
      )
      assert.equal(missingCommandController.status, 400)
      assert.deepEqual(missingCommandController.value, {
        protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
        requestId: null,
        ok: false,
        error: {
          code: 'bad-request',
          message: 'A valid desktop controller identity is required.'
        }
      })

      const conflictingCommandController = await jsonRequest(
        baseUrl,
        DESKTOP_HOST_API_PATHS.command,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${credential}`,
            [DESKTOP_HOST_CONTROLLER_HEADER]: OTHER_CONTROLLER_ID,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
            requestId: 'request-conflicting-controller',
            expectedIdentity: CONTROL_IDENTITY,
            command: { type: 'kernel.abort' }
          })
        }
      )
      assert.equal(conflictingCommandController.status, 409)
      assert.deepEqual(conflictingCommandController.value, {
        protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
        requestId: null,
        ok: false,
        error: {
          code: 'conflict',
          message: 'Controller event stream is not active.'
        }
      })

      const badCredential = await jsonRequest(baseUrl, DESKTOP_HOST_API_PATHS.state, {
        headers: {
          Authorization: `Bearer ${'x'.repeat(43)}`,
          [DESKTOP_HOST_CONTROLLER_HEADER]: CONTROLLER_ID
        }
      })
      assert.equal(badCredential.status, 401)

      const missingIdentity = await jsonRequest(baseUrl, DESKTOP_HOST_API_PATHS.command, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credential}`,
          [DESKTOP_HOST_CONTROLLER_HEADER]: CONTROLLER_ID,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
          requestId: 'request-missing-identity',
          command: { type: 'kernel.abort' }
        })
      })
      assert.equal(missingIdentity.status, 400)

      const mismatch = await jsonRequest(baseUrl, DESKTOP_HOST_API_PATHS.command, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credential}`,
          [DESKTOP_HOST_CONTROLLER_HEADER]: CONTROLLER_ID,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION + 1,
          requestId: 'request-mismatch',
          expectedIdentity: CONTROL_IDENTITY,
          command: { type: 'kernel.abort' }
        })
      })
      assert.equal(mismatch.status, 400)

      const forbidden = await jsonRequest(baseUrl, DESKTOP_HOST_API_PATHS.command, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${credential}`,
          [DESKTOP_HOST_CONTROLLER_HEADER]: CONTROLLER_ID,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
          requestId: 'request-forbidden',
          expectedIdentity: CONTROL_IDENTITY,
          command: { type: 'kernel.add-project' }
        })
      })
      assert.equal(forbidden.status, 403)
    } finally {
      events.abort()
      await events.reader.cancel().catch(() => undefined)
    }
  })
})
