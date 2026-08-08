import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  REMOTE_API_PATHS,
  REMOTE_PROTOCOL_VERSION
} from '../shared/remote-contract.ts'
import {
  createRequestId,
  parseKernelConversationPage,
  parseKernelMessageImage,
  parseKernelMutationAck,
  parseKernelSnapshotResponse,
  parseRemoteCommandResponse,
  parseRemoteEventEnvelope,
  parseRemoteSessionStatus,
  RemoteClient,
  RemoteTransportError
} from './transport.ts'

test('parseRemoteSessionStatus accepts protocol v2 envelopes', () => {
  assert.deepEqual(
    parseRemoteSessionStatus({
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      authenticated: true
    }),
    { protocolVersion: REMOTE_PROTOCOL_VERSION, authenticated: true }
  )
})

test('parseRemoteSessionStatus fails fast on bad protocol or shape', () => {
  assert.throws(
    () => parseRemoteSessionStatus({ protocolVersion: 1, authenticated: true }),
    RemoteTransportError
  )
  assert.throws(
    () => parseRemoteSessionStatus({ protocolVersion: REMOTE_PROTOCOL_VERSION }),
    RemoteTransportError
  )
})

test('parseRemoteCommandResponse matches requestId and surfaces typed errors', () => {
  assert.deepEqual(
    parseRemoteCommandResponse({
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      requestId: 'req-1',
      ok: true,
      value: { revision: 3 }
    }, 'req-1'),
    { revision: 3 }
  )
  assert.throws(
    () => parseRemoteCommandResponse({
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      requestId: 'other',
      ok: true,
      value: null
    }, 'req-1'),
    /requestId mismatch/
  )
  assert.throws(
    () => parseRemoteCommandResponse({
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      requestId: 'req-1',
      ok: false,
      error: { code: 'forbidden', message: 'not allowed' }
    }, 'req-1'),
    (error: unknown) =>
      error instanceof RemoteTransportError &&
      error.code === 'forbidden' &&
      error.message === 'not allowed'
  )
})

test('parseRemoteEventEnvelope requires protocol v2 KernelEvent', () => {
  const event = parseRemoteEventEnvelope({
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    event: { type: 'kernel.state-changed', revision: 1, state: { projects: [] } }
  })
  assert.equal(event.type, 'kernel.state-changed')
  assert.throws(
    () => parseRemoteEventEnvelope({ protocolVersion: 1, event: null }),
    RemoteTransportError
  )
})

test('parseKernelConversationPage validates identity and ranges', () => {
  const page = {
    projectKey: '/tmp/project',
    sessionKey: '/tmp/session.jsonl',
    sessionId: 'session-1',
    beforeIndex: 3,
    beforeEntryId: 'entry-3',
    startIndex: 1,
    entries: [{ id: 'entry-1' }, { id: 'entry-2' }]
  }
  assert.deepEqual(parseKernelConversationPage(page), page)
  assert.throws(
    () => parseKernelConversationPage({ ...page, entries: [] }),
    RemoteTransportError
  )
  assert.throws(
    () => parseKernelConversationPage({ ...page, beforeIndex: 4 }),
    RemoteTransportError
  )
})

test('parseKernelSnapshotResponse and image/ack helpers fail fast', () => {
  assert.deepEqual(
    parseKernelSnapshotResponse({ revision: 4, state: { projects: [] } }),
    { revision: 4, state: { projects: [] } }
  )
  assert.throws(() => parseKernelSnapshotResponse({ revision: 4 }), RemoteTransportError)
  assert.deepEqual(
    parseKernelMutationAck({ revision: 9 }),
    { revision: 9 }
  )
  assert.throws(() => parseKernelMutationAck({ revision: -1 }), RemoteTransportError)
  assert.deepEqual(
    parseKernelMessageImage({
      mimeType: 'image/png',
      data: 'abc',
      name: 'a.png',
      path: '/tmp/a.png'
    }),
    {
      mimeType: 'image/png',
      data: 'abc',
      name: 'a.png',
      path: '/tmp/a.png'
    }
  )
  assert.throws(
    () => parseKernelMessageImage({ mimeType: 'image/png', data: 'abc' }),
    RemoteTransportError
  )
})

test('createRequestId returns UUID-shaped ids', () => {
  const id = createRequestId()
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
})

test('RemoteClient uses the shared session/pair/state paths', async () => {
  const requests: Array<{ path: string, method: string, body: string | null }> = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    const method = init?.method ?? 'GET'
    requests.push({
      path,
      method,
      body: typeof init?.body === 'string' ? init.body : null
    })
    if (path === REMOTE_API_PATHS.state) {
      return new Response(JSON.stringify({ revision: 1, state: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }
    return new Response(JSON.stringify({
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      authenticated: path !== REMOTE_API_PATHS.logout
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }) as typeof fetch
  const client = new RemoteClient({ fetchImpl })

  await client.getSession()
  await client.pair('123456')
  await client.getState()
  await client.logout()

  assert.deepEqual(
    requests.map(({ path, method }) => ({ path, method })),
    [
      { path: REMOTE_API_PATHS.session, method: 'GET' },
      { path: REMOTE_API_PATHS.pair, method: 'POST' },
      { path: REMOTE_API_PATHS.state, method: 'GET' },
      { path: REMOTE_API_PATHS.logout, method: 'POST' }
    ]
  )
  assert.equal(requests[1]?.body, JSON.stringify({ code: '123456' }))
})

test('RemoteClient preserves HTTP status and reports expired sessions', async () => {
  const client = new RemoteClient({
    fetchImpl: (async () => new Response('Unauthorized', { status: 401 })) as typeof fetch
  })
  const reported: RemoteTransportError[] = []
  const unsubscribe = client.onUnauthorized((error) => {
    reported.push(error)
  })
  await assert.rejects(
    () => client.getState(),
    (error: unknown) =>
      error instanceof RemoteTransportError &&
      error.code === 'http' &&
      error.status === 401
  )
  assert.equal(reported[0]?.status, 401)
  unsubscribe()
})

test('RemoteClient pair 401 stays inline and does not report unauthorized', async () => {
  const client = new RemoteClient({
    fetchImpl: (async () => new Response(JSON.stringify({
      message: 'Invalid pairing code.'
    }), { status: 401, headers: { 'Content-Type': 'application/json' } })) as typeof fetch
  })
  const reported: RemoteTransportError[] = []
  client.onUnauthorized((error) => {
    reported.push(error)
  })
  await assert.rejects(
    () => client.pair('000000'),
    (error: unknown) =>
      error instanceof RemoteTransportError &&
      error.status === 401 &&
      error.code === 'unauthorized' &&
      error.message === '配对码无效、已过期或已失效。'
  )
  assert.equal(reported.length, 0)
})

test('RemoteClient maps pair throttling to a user-facing retry message', async () => {
  const client = new RemoteClient({
    fetchImpl: (async () => new Response('Too Many Requests', { status: 429 })) as typeof fetch
  })
  await assert.rejects(
    () => client.pair('000000'),
    (error: unknown) =>
      error instanceof RemoteTransportError &&
      error.status === 429 &&
      error.message === '尝试次数过多，请稍后再试。'
  )
})
