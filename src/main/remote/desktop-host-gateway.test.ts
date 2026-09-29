import assert from 'node:assert/strict'
import { desktopPairingId } from './desktop-device-binding.ts'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DESKTOP_HOST_API_PATHS,
  DESKTOP_HOST_CONTROLLER_HEADER,
  DESKTOP_HOST_KERNEL_COMMAND_TYPES,
  DESKTOP_HOST_OCCUPIED_MESSAGE,
  DESKTOP_HOST_PAIRING_ID_HEADER,
  DESKTOP_HOST_PROTOCOL_VERSION
} from '../../shared/desktop-host-contract.ts'
import type { DesktopHostEnabledConfig } from './desktop-host-config.ts'
import { hashRemoteDeviceCredential } from './remote-device-store.ts'
import { DESKTOP_DEVICE_LIMIT, openDesktopDeviceStore, type DesktopDeviceStore } from './desktop-device-store.ts'
import { startDesktopHostGateway } from './desktop-host-gateway.ts'

const uid = process.getuid!()
const CONTROLLER_ID = '00000000-0000-4000-8000-000000000001'
const OTHER_CONTROLLER_ID = '00000000-0000-4000-8000-000000000002'
const MACHINE_SECRET = 'h'.repeat(32)
const DEVICE_CREDENTIAL = 'c'.repeat(43)
// Each pairing receives the next credential, so several devices can coexist.
const DEVICE_CREDENTIALS = ['c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'].map((letter) => letter.repeat(43))
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
    deviceStore: DesktopDeviceStore
    dispatches: string[]
    setControlIdentity: (identity: { projectKey: string | null, sessionKey: string | null }) => void
    advanceClock: (milliseconds: number) => void
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
  let clock = Date.now()
  const now = (): number => clock
  const deviceStore = await openDesktopDeviceStore({ path: config.deviceStorePath, uid, now })
  let credentialIndex = 0
  const dispatches: string[] = []
  let controlIdentity: { projectKey: string | null, sessionKey: string | null } = CONTROL_IDENTITY
  const gateway = await startDesktopHostGateway({
    config,
    productVersion: '0.0.1',
    buildCommit: 'abcdef1',
    deviceStore,
    now,
    randomPairingCode: () => '123456',
    randomDeviceCredential: () => DEVICE_CREDENTIALS[credentialIndex++]!,
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
      setControlIdentity: (identity) => { controlIdentity = identity },
      advanceClock: (milliseconds) => { clock += milliseconds }
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
  gateway: Awaited<ReturnType<typeof startDesktopHostGateway>>,
  label?: unknown
): Promise<string> {
  const pairing = gateway.createPairingCode()
  const response = await jsonRequest(baseUrl, DESKTOP_HOST_API_PATHS.pair, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
      productVersion: '0.0.1',
      buildCommit: 'abcdef1',
      code: pairing.code,
      ...(label === undefined ? {} : { label })
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
      authenticated: false, pairingKnown: null,
      capabilities: { kernelCommandTypes: DESKTOP_HOST_KERNEL_COMMAND_TYPES }
    })

    const credential = await pair(baseUrl, gateway)
    assert.equal(credential, DEVICE_CREDENTIAL)
    assert.equal(session.headers.get('set-cookie'), null)
    assert.equal(
      deviceStore.getDevices()[0]?.credentialHash,
      hashRemoteDeviceCredential(DEVICE_CREDENTIAL)
    )

    const authenticated = await jsonRequest(baseUrl, DESKTOP_HOST_API_PATHS.session, {
      headers: { Authorization: `Bearer ${credential}` }
    })
    assert.equal(authenticated.status, 200)
    assert.equal((authenticated.value as { authenticated: boolean }).authenticated, true)
    assert.equal((authenticated.value as { pairingKnown: boolean | null }).pairingKnown, null)
    const publicIdentity = gateway.listDevices()[0]!.deviceId
    assert.equal(publicIdentity, desktopPairingId(credential))
    assert.notEqual(publicIdentity, hashRemoteDeviceCredential(credential))
    assert.equal(JSON.stringify(authenticated.value).includes(credential), false)
    assert.equal(JSON.stringify(authenticated.value).includes(MACHINE_SECRET), false)

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
    assert.deepEqual(deviceStore.getDevices(), [])

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
    assert.equal(deviceStore.getDevices()[0]?.credentialHash, hashRemoteDeviceCredential(DEVICE_CREDENTIAL))
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

      const revoked = await gateway.revokeDevice(desktopPairingId(credential))
      assert.equal(revoked.enabled, true)
      if (revoked.enabled) assert.deepEqual(revoked.devices, [])
      assert.equal((await events.reader.read()).done, true, 'revoking the controlling device closes its stream')

      const session = await jsonRequest(baseUrl, DESKTOP_HOST_API_PATHS.session, {
        headers: { Authorization: `Bearer ${credential}`, [DESKTOP_HOST_PAIRING_ID_HEADER]: desktopPairingId(credential) }
      })
      assert.equal((session.value as { authenticated: boolean }).authenticated, false)
      assert.equal((session.value as { pairingKnown: boolean | null }).pairingKnown, false)
      await assert.rejects(gateway.revokeDevice(desktopPairingId(credential)), /设备不存在或已撤销/u)
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
          command: { type: 'kernel.create-task' }
        })
      })
      assert.equal(forbidden.status, 403)
    } finally {
      events.abort()
      await events.reader.cancel().catch(() => undefined)
    }
  })
})

function commandRequest(credential: string, controllerId: string, requestId: string): RequestInit {
  return {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${credential}`,
      [DESKTOP_HOST_CONTROLLER_HEADER]: controllerId,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      protocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
      requestId,
      expectedIdentity: CONTROL_IDENTITY,
      command: { type: 'kernel.abort' }
    })
  }
}

test('R12: a second device pairs beside the first without taking or borrowing its control connection', async () => {
  await withGateway(async ({ baseUrl, gateway, dispatches }) => {
    const first = await pair(baseUrl, gateway, 'Desk PC')
    const events = await openEvents(baseUrl, first)
    try {
      const second = await pair(baseUrl, gateway, 'Laptop')
      assert.notEqual(second, first)
      assert.deepEqual(gateway.listDevices().map(({ label, controlling }) => ({ label, controlling })), [
        { label: 'Desk PC', controlling: true },
        { label: 'Laptop', controlling: false }
      ])

      // Pairing did not close the first device's stream: it still receives events.
      gateway.publish({ type: 'kernel.pi-package-install', job: { id: 'job-1', name: 'example', status: 'queued', error: null } })
      assert.match(new TextDecoder().decode((await events.reader.read()).value), /^data: /u)

      const occupied = await fetch(`${baseUrl}${DESKTOP_HOST_API_PATHS.events}`, {
        headers: { Authorization: `Bearer ${second}`, [DESKTOP_HOST_CONTROLLER_HEADER]: OTHER_CONTROLLER_ID }
      })
      assert.equal(occupied.status, 409)
      assert.equal(await occupied.text(), DESKTOP_HOST_OCCUPIED_MESSAGE)
      const sameIdOtherDevice = await fetch(`${baseUrl}${DESKTOP_HOST_API_PATHS.events}`, {
        headers: { Authorization: `Bearer ${second}`, [DESKTOP_HOST_CONTROLLER_HEADER]: CONTROLLER_ID }
      })
      assert.equal(sameIdOtherDevice.status, 409, 'another device cannot take over by reusing the controller id')
      await sameIdOtherDevice.body?.cancel()

      const borrowedState = await jsonRequest(baseUrl, DESKTOP_HOST_API_PATHS.state, {
        headers: { Authorization: `Bearer ${second}`, [DESKTOP_HOST_CONTROLLER_HEADER]: CONTROLLER_ID }
      })
      assert.equal(borrowedState.status, 409)
      const borrowedCommand = await jsonRequest(baseUrl, DESKTOP_HOST_API_PATHS.command,
        commandRequest(second, CONTROLLER_ID, 'request-borrowed'))
      assert.equal(borrowedCommand.status, 409)
      assert.deepEqual(dispatches, [])

      // Revoking the other device leaves the controller untouched.
      await gateway.revokeDevice(desktopPairingId(second))
      const allowed = await jsonRequest(baseUrl, DESKTOP_HOST_API_PATHS.command,
        commandRequest(first, CONTROLLER_ID, 'request-allowed'))
      assert.equal(allowed.status, 200, allowed.text)
      assert.deepEqual(gateway.listDevices().map(({ label }) => label), ['Desk PC'])
    } finally {
      events.abort()
      await events.reader.cancel().catch(() => undefined)
    }
  })
})

test('R12: revoking the controlling device ends its stream and later commands', async () => {
  await withGateway(async ({ baseUrl, gateway }) => {
    const first = await pair(baseUrl, gateway)
    const second = await pair(baseUrl, gateway)
    const events = await openEvents(baseUrl, first)
    try {
      await gateway.revokeDevice(desktopPairingId(first))
      assert.equal((await events.reader.read()).done, true)
      const rejected = await jsonRequest(baseUrl, DESKTOP_HOST_API_PATHS.command,
        commandRequest(first, CONTROLLER_ID, 'request-after-revoke'))
      assert.equal(rejected.status, 401)
      // The control connection is free for the remaining device.
      const next = await openEvents(baseUrl, second, OTHER_CONTROLLER_ID)
      next.abort()
      await next.reader.cancel().catch(() => undefined)
    } finally {
      events.abort()
      await events.reader.cancel().catch(() => undefined)
    }
  })
})

test('R12: the credential-free check answers only for the claimed identity', async () => {
  await withGateway(async ({ baseUrl, gateway }) => {
    const credential = await pair(baseUrl, gateway)
    const check = async (value: string) => jsonRequest(baseUrl, DESKTOP_HOST_API_PATHS.session, {
      headers: { [DESKTOP_HOST_PAIRING_ID_HEADER]: value }
    })
    const known = await check(desktopPairingId(credential))
    assert.equal(known.status, 200)
    assert.equal((known.value as { pairingKnown: boolean }).pairingKnown, true)
    assert.equal((known.value as { authenticated: boolean }).authenticated, false)
    assert.equal(JSON.stringify(known.value).includes(desktopPairingId(credential)), false, 'identities are never listed')
    assert.equal(((await check('0'.repeat(64))).value as { pairingKnown: boolean }).pairingKnown, false)
    assert.equal((await check('not-an-identity')).status, 400)
  })
})

test('R12: logout revokes only the calling device', async () => {
  await withGateway(async ({ baseUrl, gateway }) => {
    const first = await pair(baseUrl, gateway)
    const second = await pair(baseUrl, gateway)
    const events = await openEvents(baseUrl, first)
    try {
      const logout = await jsonRequest(baseUrl, DESKTOP_HOST_API_PATHS.logout, {
        method: 'POST', headers: { Authorization: `Bearer ${second}` }
      })
      assert.equal(logout.status, 200)
      assert.equal((logout.value as { authenticated: boolean }).authenticated, false)
      assert.equal((logout.value as { pairingKnown: boolean }).pairingKnown, false)
      assert.deepEqual(gateway.listDevices().map(({ deviceId }) => deviceId), [desktopPairingId(first)])
      const stillControlling = await jsonRequest(baseUrl, DESKTOP_HOST_API_PATHS.command,
        commandRequest(first, CONTROLLER_ID, 'request-after-other-logout'))
      assert.equal(stillControlling.status, 200, stillControlling.text)
      const repeated = await jsonRequest(baseUrl, DESKTOP_HOST_API_PATHS.logout, {
        method: 'POST', headers: { Authorization: `Bearer ${second}` }
      })
      assert.equal(repeated.status, 401)
    } finally {
      events.abort()
      await events.reader.cancel().catch(() => undefined)
    }
  })
})

test('R12: device names are normalized and never reject pairing', async () => {
  await withGateway(async ({ baseUrl, gateway }) => {
    await pair(baseUrl, gateway, '  Win\u0007PC  ')
    await pair(baseUrl, gateway, 'x'.repeat(200))
    await pair(baseUrl, gateway, '\u0000\u0001')
    await pair(baseUrl, gateway)
    assert.deepEqual(gateway.listDevices().map(({ label }) => label), ['WinPC', 'x'.repeat(80), null, null])
  })
})

test('R12: the device limit stops new pairing codes and expired devices free their slots', async () => {
  await withGateway(async ({ baseUrl, gateway, advanceClock }) => {
    for (let index = 0; index < DESKTOP_DEVICE_LIMIT; index++) {
      // Stay under the pairing rate limit while filling every slot.
      if (index > 0 && index % 4 === 0) advanceClock(61_000)
      await pair(baseUrl, gateway)
    }
    assert.equal(gateway.listDevices().length, DESKTOP_DEVICE_LIMIT)
    assert.throws(() => gateway.createPairingCode(), /Host 已有 8 台配对设备/u)

    const first = DEVICE_CREDENTIALS[0]!
    const events = await openEvents(baseUrl, first)
    try {
      advanceClock(31 * 24 * 60 * 60 * 1000)
      assert.deepEqual(gateway.listDevices(), [])
      gateway.publish({ type: 'kernel.pi-package-install', job: { id: 'job-1', name: 'example', status: 'queued', error: null } })
      assert.equal((await events.reader.read()).done, true, 'an expired controlling device loses its stream')
      await pair(baseUrl, gateway)
      assert.equal(gateway.listDevices().length, 1)
    } finally {
      events.abort()
      await events.reader.cancel().catch(() => undefined)
    }
  })
})
