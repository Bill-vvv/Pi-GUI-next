import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  REMOTE_API_PATHS,
  REMOTE_PROTOCOL_VERSION,
  REMOTE_SESSION_COOKIE_NAME
} from '../../shared/remote-contract.ts'
import { RemoteCommandPolicyError } from './remote-command-policy.ts'
import type { RemoteEnabledConfig } from './remote-config.ts'
import {
  openRemoteDeviceStore,
  type RemoteDeviceRecord,
  type RemoteDeviceStore
} from './remote-device-store.ts'
import {
  normalizePeerAddress,
  REMOTE_DEVICE_ABSOLUTE_TTL_MS,
  REMOTE_PAIRING_CODE_TTL_MS,
  startRemoteGateway,
  timingSafeEqualString
} from './remote-gateway.ts'

const MACHINE_SECRET = 'm'.repeat(32)
const PUBLIC_ORIGIN = 'https://pi-gui.example.com'
const PUBLIC_HOST = 'pi-gui.example.com'
const PROXY_IP = '127.0.0.1'
const uid = process.getuid!()

async function listenPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('Failed to allocate ephemeral port.')
  }
  const { port } = address
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
  return port
}

async function withGateway(
  handlers: {
    assertCommandPolicy?: (command: { type: string }) => Promise<void>
    dispatchCommand?: (command: { type: string }) => Promise<unknown>
    now?: () => number
    randomDeviceCredential?: () => string
    randomPairingCode?: () => string
    deviceStorePath?: string
    existingDeviceStore?: RemoteDeviceStore
  },
  run: (input: {
    baseUrl: string
    config: RemoteEnabledConfig
    gateway: Awaited<ReturnType<typeof startRemoteGateway>>
    staticRoot: string
    deviceStore: RemoteDeviceStore
    deviceStorePath: string
  }) => Promise<void>
): Promise<void> {
  const staticRoot = await mkdtemp(join(tmpdir(), 'pi-gui-remote-static-'))
  const storeDir = await mkdtemp(join(tmpdir(), 'pi-gui-remote-store-'))
  const port = await listenPort()
  const deviceStorePath = handlers.deviceStorePath ?? join(storeDir, 'remote.token.device')
  const config: RemoteEnabledConfig = {
    enabled: true,
    bindHost: '127.0.0.1',
    port,
    publicOrigin: PUBLIC_ORIGIN,
    publicHost: PUBLIC_HOST,
    trustedProxyIp: PROXY_IP,
    token: MACHINE_SECRET,
    tokenFile: join(storeDir, 'remote.token'),
    deviceStorePath
  }
  await writeFile(join(staticRoot, 'index.html'), '<!doctype html><title>remote</title>', 'utf8')
  await writeFile(join(staticRoot, 'app.js'), 'console.log(1)', 'utf8')
  const deviceStore = handlers.existingDeviceStore ??
    await openRemoteDeviceStore({ path: deviceStorePath, uid })
  const gateway = await startRemoteGateway({
    config,
    staticRoot,
    deviceStore,
    now: handlers.now,
    randomDeviceCredential: handlers.randomDeviceCredential,
    randomPairingCode: handlers.randomPairingCode,
    handlers: {
      assertCommandPolicy: async (command) => {
        await handlers.assertCommandPolicy?.(command)
      },
      dispatchCommand: async (command) => {
        if (handlers.dispatchCommand !== undefined) {
          return handlers.dispatchCommand(command)
        }
        return { ok: true, type: command.type }
      }
    }
  })
  try {
    await run({
      baseUrl: `http://127.0.0.1:${port}`,
      config,
      gateway,
      staticRoot,
      deviceStore,
      deviceStorePath
    })
  } finally {
    await gateway.stop()
    await rm(staticRoot, { recursive: true, force: true })
    await rm(storeDir, { recursive: true, force: true })
  }
}

function proxyHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'X-Forwarded-Proto': 'https',
    'X-Forwarded-Host': PUBLIC_HOST,
    ...extra
  }
}

async function request(
  baseUrl: string,
  path: string,
  init: {
    method?: string
    headers?: Record<string, string>
    body?: string
  } = {}
): Promise<{ status: number, headers: Headers, text: string }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: init.headers,
    body: init.body
  })
  return {
    status: response.status,
    headers: response.headers,
    text: await response.text()
  }
}

function cookieFrom(headers: Headers): string | null {
  const raw = headers.getSetCookie?.() ?? []
  for (const entry of raw) {
    const match = entry.match(new RegExp(`(?:^|,\\s*)${REMOTE_SESSION_COOKIE_NAME}=([^;]+)`))
    if (match) return match[1] ?? null
  }
  const single = headers.get('set-cookie')
  if (single === null) return null
  const match = single.match(new RegExp(`${REMOTE_SESSION_COOKIE_NAME}=([^;]+)`))
  return match?.[1] ?? null
}

function setCookieHeader(headers: Headers): string {
  const many = headers.getSetCookie?.() ?? []
  if (many.length > 0) return many.join('\n')
  return headers.get('set-cookie') ?? ''
}

function deferred(): {
  promise: Promise<void>
  resolve: () => void
} {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function pair(
  baseUrl: string,
  gateway: Awaited<ReturnType<typeof startRemoteGateway>>,
  code?: string
): Promise<string> {
  const pairing = code === undefined
    ? gateway.createPairingCode()
    : { code }
  const response = await request(baseUrl, REMOTE_API_PATHS.pair, {
    method: 'POST',
    headers: {
      ...proxyHeaders({
        Origin: PUBLIC_ORIGIN,
        'Content-Type': 'application/json'
      })
    },
    body: JSON.stringify({ code: pairing.code })
  })
  assert.equal(response.status, 200, response.text)
  const cookie = cookieFrom(response.headers)
  assert.ok(cookie)
  assert.ok(cookie.length >= 32)
  const header = setCookieHeader(response.headers)
  assert.match(header, /Secure/i)
  assert.match(header, /HttpOnly/i)
  assert.match(header, /SameSite=Strict/i)
  assert.match(header, /Path=\//i)
  assert.match(header, /Max-Age=/i)
  assert.match(header, /Expires=/i)
  return cookie
}

test('normalizePeerAddress strips IPv4-mapped IPv6 prefixes', () => {
  assert.equal(normalizePeerAddress('::ffff:192.168.6.1'), '192.168.6.1')
  assert.equal(normalizePeerAddress('127.0.0.1'), '127.0.0.1')
})

test('timingSafeEqualString compares by digest', () => {
  assert.equal(timingSafeEqualString('same-value', 'same-value'), true)
  assert.equal(timingSafeEqualString('same-value', 'other-value'), false)
})

test('gateway rejects non-proxy peers and bad forwarded headers', async () => {
  await withGateway({}, async ({ baseUrl }) => {
    const badProto = await request(baseUrl, '/', {
      headers: {
        'X-Forwarded-Proto': 'http',
        'X-Forwarded-Host': PUBLIC_HOST
      }
    })
    assert.equal(badProto.status, 400)

    const badHost = await request(baseUrl, '/', {
      headers: {
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-Host': 'evil.example'
      }
    })
    assert.equal(badHost.status, 400)
  })
})

test('legacy /api/session/login is rejected', async () => {
  await withGateway({}, async ({ baseUrl }) => {
    const response = await request(baseUrl, '/api/session/login', {
      method: 'POST',
      headers: proxyHeaders({
        Origin: PUBLIC_ORIGIN,
        'Content-Type': 'application/json'
      }),
      body: JSON.stringify({ token: MACHINE_SECRET })
    })
    assert.equal(response.status, 404)
  })
})

test('createPairingCode shape and regeneration invalidates the prior code', async () => {
  let clock = 1_000_000
  let nextCode = 100000
  await withGateway({
    now: () => clock,
    randomPairingCode: () => String(nextCode++).padStart(6, '0')
  }, async ({ baseUrl, gateway }) => {
    const first = gateway.createPairingCode()
    assert.match(first.code, /^[0-9]{6}$/u)
    assert.equal(first.expiresAt, clock + REMOTE_PAIRING_CODE_TTL_MS)

    const second = gateway.createPairingCode()
    assert.notEqual(second.code, first.code)

    const stale = await request(baseUrl, REMOTE_API_PATHS.pair, {
      method: 'POST',
      headers: proxyHeaders({
        Origin: PUBLIC_ORIGIN,
        'Content-Type': 'application/json'
      }),
      body: JSON.stringify({ code: first.code })
    })
    assert.equal(stale.status, 401)

    const cookie = await pair(baseUrl, gateway, second.code)
    const reuse = await request(baseUrl, REMOTE_API_PATHS.pair, {
      method: 'POST',
      headers: proxyHeaders({
        Origin: PUBLIC_ORIGIN,
        'Content-Type': 'application/json'
      }),
      body: JSON.stringify({ code: second.code })
    })
    assert.equal(reuse.status, 401)

    const session = await request(baseUrl, REMOTE_API_PATHS.session, {
      headers: proxyHeaders({
        Cookie: `${REMOTE_SESSION_COOKIE_NAME}=${cookie}`
      })
    })
    assert.deepEqual(JSON.parse(session.text), {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      authenticated: true
    })
  })
})

test('concurrent correct pairing requests consume the code exactly once', async () => {
  await withGateway({
    randomPairingCode: () => '345678'
  }, async ({ baseUrl, gateway }) => {
    const pairing = gateway.createPairingCode()
    const makeRequest = () => request(baseUrl, REMOTE_API_PATHS.pair, {
      method: 'POST',
      headers: proxyHeaders({
        Origin: PUBLIC_ORIGIN,
        'Content-Type': 'application/json'
      }),
      body: JSON.stringify({ code: pairing.code })
    })

    const responses = await Promise.all([makeRequest(), makeRequest()])
    assert.deepEqual(
      responses.map((response) => response.status).sort((left, right) => left - right),
      [200, 401]
    )
    const successful = responses.find((response) => response.status === 200)
    assert.ok(successful)
    const cookie = cookieFrom(successful.headers)
    assert.ok(cookie)

    const session = await request(baseUrl, REMOTE_API_PATHS.session, {
      headers: proxyHeaders({
        Cookie: `${REMOTE_SESSION_COOKIE_NAME}=${cookie}`
      })
    })
    assert.deepEqual(JSON.parse(session.text), {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      authenticated: true
    })
  })
})

test('pairing code expires after five minutes and after five failed attempts', async () => {
  let clock = 2_000_000
  let nextCode = 200000
  await withGateway({
    now: () => clock,
    randomPairingCode: () => String(nextCode++).padStart(6, '0')
  }, async ({ baseUrl, gateway }) => {
    const limited = gateway.createPairingCode()
    for (let i = 0; i < 5; i += 1) {
      const wrong = await request(baseUrl, REMOTE_API_PATHS.pair, {
        method: 'POST',
        headers: proxyHeaders({
          Origin: PUBLIC_ORIGIN,
          'Content-Type': 'application/json'
        }),
        body: JSON.stringify({ code: '000000' })
      })
      assert.equal(wrong.status, 401)
    }
    // Move fully past proxy-peer rate-limit window; code attempts are already consumed.
    clock += 60_001
    const afterLimit = await request(baseUrl, REMOTE_API_PATHS.pair, {
      method: 'POST',
      headers: proxyHeaders({
        Origin: PUBLIC_ORIGIN,
        'Content-Type': 'application/json'
      }),
      body: JSON.stringify({ code: limited.code })
    })
    assert.equal(afterLimit.status, 401)

    clock += 60_001
    const expiring = gateway.createPairingCode()
    clock += REMOTE_PAIRING_CODE_TTL_MS
    const expired = await request(baseUrl, REMOTE_API_PATHS.pair, {
      method: 'POST',
      headers: proxyHeaders({
        Origin: PUBLIC_ORIGIN,
        'Content-Type': 'application/json'
      }),
      body: JSON.stringify({ code: expiring.code })
    })
    assert.equal(expired.status, 401)
  })
})

test('pair requires exact Origin and JSON, replaces prior device, and invalidates old cookie/SSE', async () => {
  let credentialCounter = 0
  await withGateway({
    randomDeviceCredential: () => `device-credential-value-${String(++credentialCounter).padStart(8, '0')}-xxxx`
  }, async ({ baseUrl, gateway }) => {
    const missingOrigin = await request(baseUrl, REMOTE_API_PATHS.pair, {
      method: 'POST',
      headers: proxyHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ code: '123456' })
    })
    assert.equal(missingOrigin.status, 403)

    const wrongContentType = await request(baseUrl, REMOTE_API_PATHS.pair, {
      method: 'POST',
      headers: proxyHeaders({
        Origin: PUBLIC_ORIGIN,
        'Content-Type': 'text/plain'
      }),
      body: JSON.stringify({ code: '123456' })
    })
    assert.equal(wrongContentType.status, 415)

    const firstCookie = await pair(baseUrl, gateway)
    const response = await fetch(`${baseUrl}${REMOTE_API_PATHS.events}`, {
      headers: proxyHeaders({
        Cookie: `${REMOTE_SESSION_COOKIE_NAME}=${firstCookie}`,
        Accept: 'text/event-stream'
      })
    })
    assert.equal(response.status, 200)
    const reader = response.body!.getReader()
    const firstChunk = await reader.read()
    assert.equal(firstChunk.done, false)

    const secondCookie = await pair(baseUrl, gateway)
    assert.notEqual(firstCookie, secondCookie)

    const closed = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Invalidated SSE did not close.')), 2_000)
      })
    ])
    assert.equal(closed.done, true)

    const stale = await request(baseUrl, REMOTE_API_PATHS.command, {
      method: 'POST',
      headers: proxyHeaders({
        Origin: PUBLIC_ORIGIN,
        'Content-Type': 'application/json',
        Cookie: `${REMOTE_SESSION_COOKIE_NAME}=${firstCookie}`
      }),
      body: JSON.stringify({
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        requestId: 'r1',
        command: { type: 'kernel.get-state' }
      })
    })
    assert.equal(stale.status, 401)

    const fresh = await request(baseUrl, REMOTE_API_PATHS.command, {
      method: 'POST',
      headers: proxyHeaders({
        Origin: PUBLIC_ORIGIN,
        'Content-Type': 'application/json',
        Cookie: `${REMOTE_SESSION_COOKIE_NAME}=${secondCookie}`
      }),
      body: JSON.stringify({
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        requestId: 'r2',
        command: { type: 'kernel.get-state' }
      })
    })
    assert.equal(fresh.status, 200)
  })
})

test('session and state GETs report auth without creating a second state path', async () => {
  const seen: string[] = []
  await withGateway({
    dispatchCommand: async (command) => {
      seen.push(command.type)
      return { revision: 7, state: { projects: [] } }
    }
  }, async ({ baseUrl, gateway }) => {
    const before = await request(baseUrl, REMOTE_API_PATHS.session, {
      headers: proxyHeaders()
    })
    assert.equal(before.status, 200)
    assert.deepEqual(JSON.parse(before.text), {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      authenticated: false
    })

    const deniedState = await request(baseUrl, REMOTE_API_PATHS.state, {
      headers: proxyHeaders()
    })
    assert.equal(deniedState.status, 401)

    const cookie = await pair(baseUrl, gateway)
    const after = await request(baseUrl, REMOTE_API_PATHS.session, {
      headers: proxyHeaders({
        Cookie: `${REMOTE_SESSION_COOKIE_NAME}=${cookie}`
      })
    })
    assert.deepEqual(JSON.parse(after.text), {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      authenticated: true
    })

    const state = await request(baseUrl, REMOTE_API_PATHS.state, {
      headers: proxyHeaders({
        Cookie: `${REMOTE_SESSION_COOKIE_NAME}=${cookie}`
      })
    })
    assert.equal(state.status, 200)
    assert.deepEqual(JSON.parse(state.text), { revision: 7, state: { projects: [] } })
    assert.deepEqual(seen, ['kernel.get-state'])
  })
})

test('command admission revalidates authentication after async policy checks', async () => {
  const policyStarted = deferred()
  const releasePolicy = deferred()
  let dispatchCount = 0
  await withGateway({
    assertCommandPolicy: async (command) => {
      if (command.type !== 'kernel.abort') return
      policyStarted.resolve()
      await releasePolicy.promise
    },
    dispatchCommand: async () => {
      dispatchCount += 1
      return { ok: true }
    }
  }, async ({ baseUrl, gateway }) => {
    const cookie = await pair(baseUrl, gateway)
    const responsePromise = request(baseUrl, REMOTE_API_PATHS.command, {
      method: 'POST',
      headers: proxyHeaders({
        Origin: PUBLIC_ORIGIN,
        'Content-Type': 'application/json',
        Cookie: `${REMOTE_SESSION_COOKIE_NAME}=${cookie}`
      }),
      body: JSON.stringify({
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        requestId: 'r-revoked-during-policy',
        command: { type: 'kernel.abort' }
      })
    })

    await policyStarted.promise
    try {
      await gateway.revokeDevice()
    } finally {
      releasePolicy.resolve()
    }
    const response = await responsePromise
    assert.equal(response.status, 401)
    assert.equal(JSON.parse(response.text).error.code, 'unauthorized')
    assert.equal(dispatchCount, 0)
  })
})

test('state response is suppressed when its device is revoked in flight', async () => {
  const dispatchStarted = deferred()
  const releaseDispatch = deferred()
  await withGateway({
    dispatchCommand: async () => {
      dispatchStarted.resolve()
      await releaseDispatch.promise
      return { revision: 9, state: { privatePath: '/home/example/private' } }
    }
  }, async ({ baseUrl, gateway }) => {
    const cookie = await pair(baseUrl, gateway)
    const responsePromise = request(baseUrl, REMOTE_API_PATHS.state, {
      headers: proxyHeaders({
        Cookie: `${REMOTE_SESSION_COOKIE_NAME}=${cookie}`
      })
    })

    await dispatchStarted.promise
    try {
      await gateway.revokeDevice()
    } finally {
      releaseDispatch.resolve()
    }
    const response = await responsePromise
    assert.equal(response.status, 401)
    assert.equal(response.text.includes('/home/example/private'), false)
  })
})

test('command path enforces auth, JSON content type, origin, allowlist, and policy', async () => {
  const seen: string[] = []
  await withGateway({
    assertCommandPolicy: async (command) => {
      if (command.type === 'kernel.prompt') {
        throw new RemoteCommandPolicyError('Remote prompt requires expectedSessionKey.')
      }
    },
    dispatchCommand: async (command) => {
      seen.push(command.type)
      return { type: command.type }
    }
  }, async ({ baseUrl, gateway }) => {
    const cookie = await pair(baseUrl, gateway)

    const noAuth = await request(baseUrl, REMOTE_API_PATHS.command, {
      method: 'POST',
      headers: proxyHeaders({
        Origin: PUBLIC_ORIGIN,
        'Content-Type': 'application/json'
      }),
      body: JSON.stringify({
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        requestId: 'r0',
        command: { type: 'kernel.get-state' }
      })
    })
    assert.equal(noAuth.status, 401)

    const wrongContentType = await request(baseUrl, REMOTE_API_PATHS.command, {
      method: 'POST',
      headers: proxyHeaders({
        Origin: PUBLIC_ORIGIN,
        Cookie: `${REMOTE_SESSION_COOKIE_NAME}=${cookie}`
      }),
      body: JSON.stringify({
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        requestId: 'r-content-type',
        command: { type: 'kernel.abort' }
      })
    })
    assert.equal(wrongContentType.status, 415)

    const denied = await request(baseUrl, REMOTE_API_PATHS.command, {
      method: 'POST',
      headers: proxyHeaders({
        Origin: PUBLIC_ORIGIN,
        'Content-Type': 'application/json',
        Cookie: `${REMOTE_SESSION_COOKIE_NAME}=${cookie}`
      }),
      body: JSON.stringify({
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        requestId: 'r-deny',
        command: { type: 'kernel.add-project' }
      })
    })
    assert.equal(denied.status, 403)
    assert.equal(JSON.parse(denied.text).error.code, 'forbidden')

    const policy = await request(baseUrl, REMOTE_API_PATHS.command, {
      method: 'POST',
      headers: proxyHeaders({
        Origin: PUBLIC_ORIGIN,
        'Content-Type': 'application/json',
        Cookie: `${REMOTE_SESSION_COOKIE_NAME}=${cookie}`
      }),
      body: JSON.stringify({
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        requestId: 'r-policy',
        command: { type: 'kernel.prompt', message: 'hi' }
      })
    })
    assert.equal(policy.status, 403)

    const allowed = await request(baseUrl, REMOTE_API_PATHS.command, {
      method: 'POST',
      headers: proxyHeaders({
        Origin: PUBLIC_ORIGIN,
        'Content-Type': 'application/json',
        Cookie: `${REMOTE_SESSION_COOKIE_NAME}=${cookie}`
      }),
      body: JSON.stringify({
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        requestId: 'r-ok',
        command: { type: 'kernel.abort' }
      })
    })
    assert.equal(allowed.status, 200)
    assert.deepEqual(seen, ['kernel.abort'])
  })
})

test('authenticated command failures do not expose internal paths', async () => {
  const secretPath = '/home/example/private-project'
  const logged: unknown[][] = []
  const originalConsoleError = console.error
  console.error = (...args: unknown[]) => {
    logged.push(args)
  }
  try {
    await withGateway({
      dispatchCommand: async () => {
        throw new Error(`Project is not registered: ${secretPath}`)
      }
    }, async ({ baseUrl, gateway }) => {
      const cookie = await pair(baseUrl, gateway)
      const response = await request(baseUrl, REMOTE_API_PATHS.command, {
        method: 'POST',
        headers: proxyHeaders({
          Origin: PUBLIC_ORIGIN,
          'Content-Type': 'application/json',
          Cookie: `${REMOTE_SESSION_COOKIE_NAME}=${cookie}`
        }),
        body: JSON.stringify({
          protocolVersion: REMOTE_PROTOCOL_VERSION,
          requestId: 'r-internal-error',
          command: { type: 'kernel.abort' }
        })
      })
      assert.equal(response.status, 400)
      const body = JSON.parse(response.text)
      assert.equal(body.error.message, 'Remote command was rejected by the active desktop state.')
      assert.equal(response.text.includes(secretPath), false)
    })
  } finally {
    console.error = originalConsoleError
  }
  assert.equal(logged.length, 1)
  assert.equal(String(logged[0]?.[1]).includes(secretPath), true)
})

test('logout and revoke durably clear the device and close access', async () => {
  await withGateway({}, async ({ baseUrl, gateway, deviceStorePath }) => {
    const cookie = await pair(baseUrl, gateway)
    const statusBefore = gateway.getStatus()
    assert.equal(statusBefore.enabled, true)
    if (!statusBefore.enabled) return
    assert.ok(statusBefore.device)

    const logout = await request(baseUrl, REMOTE_API_PATHS.logout, {
      method: 'POST',
      headers: proxyHeaders({
        Origin: PUBLIC_ORIGIN,
        Cookie: `${REMOTE_SESSION_COOKIE_NAME}=${cookie}`
      })
    })
    assert.equal(logout.status, 200)
    const afterLogout = await request(baseUrl, REMOTE_API_PATHS.command, {
      method: 'POST',
      headers: proxyHeaders({
        Origin: PUBLIC_ORIGIN,
        'Content-Type': 'application/json',
        Cookie: `${REMOTE_SESSION_COOKIE_NAME}=${cookie}`
      }),
      body: JSON.stringify({
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        requestId: 'after-logout',
        command: { type: 'kernel.get-state' }
      })
    })
    assert.equal(afterLogout.status, 401)
    const statusAfterLogout = gateway.getStatus()
    assert.equal(statusAfterLogout.enabled, true)
    if (statusAfterLogout.enabled) {
      assert.equal(statusAfterLogout.device, null)
    }

    const cookie2 = await pair(baseUrl, gateway)
    const sse = await fetch(`${baseUrl}${REMOTE_API_PATHS.events}`, {
      headers: proxyHeaders({
        Cookie: `${REMOTE_SESSION_COOKIE_NAME}=${cookie2}`,
        Accept: 'text/event-stream'
      })
    })
    assert.equal(sse.status, 200)
    const reader = sse.body!.getReader()
    await reader.read()

    const revoked = await gateway.revokeDevice()
    assert.equal(revoked.enabled, true)
    if (revoked.enabled) {
      assert.equal(revoked.device, null)
    }
    const reopened = await openRemoteDeviceStore({ path: deviceStorePath, uid })
    assert.equal(reopened.getDevice(), null)

    const closed = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Revoked SSE did not close.')), 2_000)
      })
    ])
    assert.equal(closed.done, true)

    const afterRevoke = await request(baseUrl, REMOTE_API_PATHS.session, {
      headers: proxyHeaders({
        Cookie: `${REMOTE_SESSION_COOKIE_NAME}=${cookie2}`
      })
    })
    assert.deepEqual(JSON.parse(afterRevoke.text), {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      authenticated: false
    })
  })
})

test('revoke closes authorization and SSE even when device persistence reports failure', async () => {
  let record: RemoteDeviceRecord | null = null
  const failingStore: RemoteDeviceStore = {
    getDevice: () => record === null ? null : { ...record },
    async replaceDevice(next) {
      record = { ...next }
    },
    async clearDevice() {
      record = null
      throw new Error('simulated directory fsync failure')
    }
  }

  await withGateway({ existingDeviceStore: failingStore }, async ({ baseUrl, gateway }) => {
    const cookie = await pair(baseUrl, gateway)
    const sse = await fetch(`${baseUrl}${REMOTE_API_PATHS.events}`, {
      headers: proxyHeaders({
        Cookie: `${REMOTE_SESSION_COOKIE_NAME}=${cookie}`,
        Accept: 'text/event-stream'
      })
    })
    assert.equal(sse.status, 200)
    const reader = sse.body!.getReader()
    await reader.read()

    await assert.rejects(() => gateway.revokeDevice(), /simulated directory fsync failure/)
    const closed = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Failed revoke did not close SSE.')), 2_000)
      })
    ])
    assert.equal(closed.done, true)

    const session = await request(baseUrl, REMOTE_API_PATHS.session, {
      headers: proxyHeaders({
        Cookie: `${REMOTE_SESSION_COOKIE_NAME}=${cookie}`
      })
    })
    assert.deepEqual(JSON.parse(session.text), {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      authenticated: false
    })
  })
})

test('paired device cookie survives gateway restart for absolute 30-day TTL', async () => {
  let clock = 5_000
  const storeDir = await mkdtemp(join(tmpdir(), 'pi-gui-remote-persist-'))
  const deviceStorePath = join(storeDir, 'remote.token.device')
  const staticRoot = await mkdtemp(join(tmpdir(), 'pi-gui-remote-static-persist-'))
  await writeFile(join(staticRoot, 'index.html'), '<!doctype html><title>remote</title>', 'utf8')
  try {
    const firstPort = await listenPort()
    const firstConfig: RemoteEnabledConfig = {
      enabled: true,
      bindHost: '127.0.0.1',
      port: firstPort,
      publicOrigin: PUBLIC_ORIGIN,
      publicHost: PUBLIC_HOST,
      trustedProxyIp: PROXY_IP,
      token: MACHINE_SECRET,
      tokenFile: join(storeDir, 'remote.token'),
      deviceStorePath
    }
    const firstStore = await openRemoteDeviceStore({ path: deviceStorePath, uid })
    const firstGateway = await startRemoteGateway({
      config: firstConfig,
      staticRoot,
      deviceStore: firstStore,
      now: () => clock,
      randomDeviceCredential: () => 'persistent-device-credential-value-32b',
      handlers: {
        assertCommandPolicy: async () => undefined,
        dispatchCommand: async (command) => ({ ok: true, type: command.type })
      }
    })
    const baseUrl1 = `http://127.0.0.1:${firstPort}`
    const cookie = await pair(baseUrl1, firstGateway)
    const status = firstGateway.getStatus()
    assert.equal(status.enabled, true)
    if (status.enabled) {
      assert.equal(status.device?.pairedAt, clock)
      assert.equal(status.device?.expiresAt, clock + REMOTE_DEVICE_ABSOLUTE_TTL_MS)
    }
    await firstGateway.stop()

    const secondPort = await listenPort()
    const secondConfig: RemoteEnabledConfig = {
      ...firstConfig,
      port: secondPort
    }
    const secondStore = await openRemoteDeviceStore({ path: deviceStorePath, uid })
    const secondGateway = await startRemoteGateway({
      config: secondConfig,
      staticRoot,
      deviceStore: secondStore,
      now: () => clock,
      handlers: {
        assertCommandPolicy: async () => undefined,
        dispatchCommand: async (command) => ({ ok: true, type: command.type })
      }
    })
    try {
      const baseUrl2 = `http://127.0.0.1:${secondPort}`
      const session = await request(baseUrl2, REMOTE_API_PATHS.session, {
        headers: proxyHeaders({
          Cookie: `${REMOTE_SESSION_COOKIE_NAME}=${cookie}`
        })
      })
      assert.deepEqual(JSON.parse(session.text), {
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        authenticated: true
      })

      clock += REMOTE_DEVICE_ABSOLUTE_TTL_MS
      const expired = await request(baseUrl2, REMOTE_API_PATHS.session, {
        headers: proxyHeaders({
          Cookie: `${REMOTE_SESSION_COOKIE_NAME}=${cookie}`
        })
      })
      assert.deepEqual(JSON.parse(expired.text), {
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        authenticated: false
      })
    } finally {
      await secondGateway.stop()
    }
  } finally {
    await rm(staticRoot, { recursive: true, force: true })
    await rm(storeDir, { recursive: true, force: true })
  }
})

test('SSE requires auth and delivers published events', async () => {
  await withGateway({}, async ({ baseUrl, gateway }) => {
    const unauth = await request(baseUrl, REMOTE_API_PATHS.events, {
      headers: proxyHeaders()
    })
    assert.equal(unauth.status, 401)

    const cookie = await pair(baseUrl, gateway)
    const controller = new AbortController()
    const response = await fetch(`${baseUrl}${REMOTE_API_PATHS.events}`, {
      headers: proxyHeaders({
        Cookie: `${REMOTE_SESSION_COOKIE_NAME}=${cookie}`,
        Accept: 'text/event-stream'
      }),
      signal: controller.signal
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
    assert.equal(response.headers.get('cache-control'), 'no-cache, no-transform')

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    gateway.publish({
      type: 'kernel.state-changed',
      revision: 1,
      state: {} as never
    })

    const deadline = Date.now() + 2_000
    while (Date.now() < deadline && !buffer.includes('data:')) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
    }
    controller.abort()
    assert.match(buffer, /"protocolVersion":2/)
    assert.match(buffer, /kernel\.state-changed/)
  })
})

test('static assets are served with realpath containment and security headers', async () => {
  await withGateway({}, async ({ baseUrl, staticRoot }) => {
    const index = await request(baseUrl, '/', {
      headers: proxyHeaders()
    })
    assert.equal(index.status, 200)
    assert.match(index.text, /remote/)
    assert.equal(index.headers.get('cache-control'), 'no-store')
    const csp = index.headers.get('content-security-policy') ?? ''
    assert.match(csp, /default-src 'self'/)
    assert.match(csp, /style-src 'self' 'unsafe-inline'/)

    const asset = await request(baseUrl, '/app.js', {
      headers: proxyHeaders()
    })
    assert.equal(asset.status, 200)
    assert.equal(asset.text, 'console.log(1)')

    const escape = await request(baseUrl, '/../package.json', {
      headers: proxyHeaders()
    })
    assert.ok(escape.status === 403 || escape.status === 404)

    const outside = await mkdtemp(join(tmpdir(), 'pi-gui-remote-outside-'))
    try {
      await writeFile(join(outside, 'secret.txt'), 'not public', 'utf8')
      await symlink(outside, join(staticRoot, 'leak'), 'dir')
      const symlinkEscape = await request(baseUrl, '/leak/secret.txt', {
        headers: proxyHeaders()
      })
      assert.equal(symlinkEscape.status, 403)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })
})

test('pair rate limit fails closed after repeated attempts from proxy peer', async () => {
  await withGateway({}, async ({ baseUrl }) => {
    let lastStatus = 0
    for (let i = 0; i < 6; i += 1) {
      const response = await request(baseUrl, REMOTE_API_PATHS.pair, {
        method: 'POST',
        headers: proxyHeaders({
          Origin: PUBLIC_ORIGIN,
          'Content-Type': 'application/json',
          'X-Forwarded-For': `203.0.113.${10 + i}`
        }),
        body: JSON.stringify({ code: '999999' })
      })
      lastStatus = response.status
    }
    assert.equal(lastStatus, 429)
  })
})

test('machine secret token is never accepted from the phone body', async () => {
  await withGateway({}, async ({ baseUrl, gateway }) => {
    gateway.createPairingCode()
    const asToken = await request(baseUrl, REMOTE_API_PATHS.pair, {
      method: 'POST',
      headers: proxyHeaders({
        Origin: PUBLIC_ORIGIN,
        'Content-Type': 'application/json'
      }),
      body: JSON.stringify({ token: MACHINE_SECRET })
    })
    assert.equal(asToken.status, 401)

    const asCode = await request(baseUrl, REMOTE_API_PATHS.pair, {
      method: 'POST',
      headers: proxyHeaders({
        Origin: PUBLIC_ORIGIN,
        'Content-Type': 'application/json'
      }),
      body: JSON.stringify({ code: MACHINE_SECRET })
    })
    assert.equal(asCode.status, 401)
  })
})
