import assert from 'node:assert/strict'
import test from 'node:test'

import extension from '../src/index.ts'
import {
  EXTENSION_INVENTORY_ACCESSOR,
  EXTENSION_TOOL_INVOKE_ACCESSOR,
  LEASE_STATUS_KEY,
  MAX_REASON_LENGTH,
  PROVIDER_ID_MAGIC_CONTEXT,
  PROVIDER_ID_MULTI_ADVISOR,
  PROVIDER_ID_SUBAGENTS,
  PROVIDER_LEASE_COMMIT_EVENT,
  PROVIDER_LEASE_PREPARE_EVENT,
  PROVIDER_LEASE_RELEASE_EVENT,
  PROVIDER_LEASE_REPLY_EVENT_PREFIX,
  PROVIDER_QUERY_EVENT,
  PROVIDER_REGISTER_EVENT,
  PROVIDER_REPLY_EVENT_PREFIX,
  QUIESCENCE_COMMAND_NAME,
  QUIESCENCE_STATUS_KEY,
  SENTINEL_ID_COMMAND_DISCOVERY,
  SENTINEL_ID_EVENT_BUS,
  SENTINEL_ID_TOOL_DISCOVERY,
  SENTINEL_ID_UNREGISTERED_EXTENSION,
  SUBAGENT_FLEET_IDLE_TEXT,
  SUBAGENT_RPC_REQUEST_EVENT,
  SUBAGENT_SCHEDULE_IDLE_TEXT,
  buildProviderRegister,
  buildProviderReply
} from '../src/protocol.mjs'

test('tool API throw emits blocking tool-discovery sentinel', async () => {
  const { command, statuses } = installExtension({
    getAllTools() {
      throw new Error('ENOENT: /home/secret/extensions/tools.ts')
    },
    getCommands() {
      return []
    }
  })
  await command.handler('nonce-tools', commandContext())
  const payload = lastStatusPayload(statuses)
  assert.equal(payload.quiescent, false)
  assert.ok(
    payload.providers.some(
      (provider) =>
        provider.id === SENTINEL_ID_TOOL_DISCOVERY &&
        provider.state === 'unknown' &&
        provider.reason === 'tool-api-throw'
    )
  )
  assert.ok(!JSON.stringify(payload).includes('/home/secret'))
})

test('command API throw emits a fixed token without leaking Windows paths', async () => {
  const { command, statuses } = installExtension({
    getAllTools: () => [],
    getCommands() {
      throw new Error('ENOENT: C:\\Users\\secret\\extension.ts')
    }
  })
  await command.handler('nonce-command-throw', commandContext())
  const payload = lastStatusPayload(statuses)
  assert.deepEqual(
    payload.providers.find((provider) => provider.id === SENTINEL_ID_COMMAND_DISCOVERY),
    { id: SENTINEL_ID_COMMAND_DISCOVERY, state: 'unknown', reason: 'command-api-throw' }
  )
  assert.ok(!JSON.stringify(payload).includes('Users'))
})

test('missing command API emits blocking command-discovery sentinel', async () => {
  const { command, statuses } = installExtension({
    getAllTools: () => [],
    getCommands: undefined
  })
  await command.handler('nonce-cmd-missing', commandContext())
  const payload = lastStatusPayload(statuses)
  assert.equal(payload.quiescent, false)
  assert.ok(
    payload.providers.some(
      (provider) =>
        provider.id === SENTINEL_ID_COMMAND_DISCOVERY &&
        provider.state === 'unknown' &&
        provider.reason === 'command-api-missing'
    )
  )
})

test('arbitrary unregistered tool source emits one generic sentinel without leaking paths', async () => {
  const bus = createBus()
  const { command, statuses } = installExtension({
    events: bus,
    getAllTools: () => [
      {
        name: 'shadow-work',
        sourceInfo: {
          source: 'local',
          path: '/home/secret/Projects/evil-ext/index.ts'
        }
      },
      {
        name: 'read',
        sourceInfo: { source: 'builtin', path: '<builtin:read>' }
      }
    ],
    getCommands: () => [
      {
        name: QUIESCENCE_COMMAND_NAME,
        source: 'extension',
        sourceInfo: {
          source: 'local',
          path: '/opt/pi-gui/extensions/pi-gui-runtime-quiescence/src/index.ts'
        }
      }
    ]
  })
  await command.handler('nonce-unreg-tool', commandContext())
  const payload = lastStatusPayload(statuses)
  assert.equal(payload.quiescent, false)
  const unregistered = payload.providers.filter(
    (provider) => provider.id === SENTINEL_ID_UNREGISTERED_EXTENSION
  )
  assert.equal(unregistered.length, 1)
  assert.equal(unregistered[0].state, 'unknown')
  assert.match(unregistered[0].reason, /tool-sources=1/u)
  assert.ok(!JSON.stringify(payload).includes('/home/secret'))
  assert.ok(!payload.providers.some((provider) => provider.id === 'local'))
  assert.ok(!payload.providers.some((provider) => provider.id === 'shadow-work'))
  assert.ok(!payload.providers.some((provider) => provider.id.includes('evil-ext')))
})

test('arbitrary command-only extension source emits one generic sentinel', async () => {
  const bus = createBus()
  const { command, statuses } = installExtension({
    events: bus,
    getAllTools: () => [{ name: 'bash', sourceInfo: { source: 'builtin' } }],
    getCommands: () => [
      {
        name: 'do-background',
        source: 'extension',
        sourceInfo: {
          source: 'weird-extension',
          path: '/var/lib/pi/extensions/weird-extension/index.ts'
        }
      }
    ]
  })
  await command.handler('nonce-unreg-cmd', commandContext())
  const payload = lastStatusPayload(statuses)
  assert.equal(payload.quiescent, false)
  const unregistered = payload.providers.find(
    (provider) => provider.id === SENTINEL_ID_UNREGISTERED_EXTENSION
  )
  assert.deepEqual(unregistered, {
    id: SENTINEL_ID_UNREGISTERED_EXTENSION,
    state: 'unknown',
    reason:
      'discovered:tool-sources=0;tool-name-only=0;command-sources=1;command-name-only=0'
  })
  assert.ok(!JSON.stringify(payload).includes('/var/lib/pi'))
  assert.ok(!payload.providers.some((provider) => provider.id === 'weird-extension'))
})

test('registered multi-advisor and builtins stay quiescent without unregistered sentinel', async () => {
  const bus = createBus()
  const { command, statuses } = installExtension({
    events: bus,
    getAllTools: () => [{ name: 'read', sourceInfo: { source: 'builtin' } }],
    getCommands: () => [
      {
        name: 'advisor',
        source: 'extension',
        sourceInfo: {
          source: 'pi-gui-multi-advisor',
          path: '/opt/ext/pi-gui-multi-advisor/src/index.ts'
        }
      },
      {
        name: QUIESCENCE_COMMAND_NAME,
        source: 'extension',
        sourceInfo: {
          source: 'local',
          path: '/opt/pi-gui/extensions/pi-gui-runtime-quiescence/src/index.ts'
        }
      }
    ]
  })
  bus.emit(PROVIDER_REGISTER_EVENT, buildProviderRegister(PROVIDER_ID_MULTI_ADVISOR))
  bus.on(PROVIDER_QUERY_EVENT, (raw) => {
    bus.emit(
      `${PROVIDER_REPLY_EVENT_PREFIX}${raw.requestId}`,
      buildProviderReply({
        requestId: raw.requestId,
        providerId: PROVIDER_ID_MULTI_ADVISOR,
        state: 'idle'
      })
    )
  })
  await command.handler('nonce-known', commandContext({ idle: true, pending: false }))
  const payload = lastStatusPayload(statuses)
  assert.equal(
    payload.providers.some((provider) => provider.id === SENTINEL_ID_UNREGISTERED_EXTENSION),
    false
  )
  assert.equal(payload.quiescent, true)
})

test('event-bus absence emits blocking event-bus sentinel', async () => {
  const { command, statuses } = installExtension({
    events: null,
    getAllTools: () => [],
    getCommands: () => []
  })
  await command.handler('nonce-bus', commandContext())
  const payload = lastStatusPayload(statuses)
  assert.equal(payload.quiescent, false)
  assert.ok(
    payload.providers.some(
      (provider) => provider.id === SENTINEL_ID_EVENT_BUS && provider.state === 'unknown'
    )
  )
})

test('event-bus registration listener failure remains blocking', async () => {
  const { command, statuses } = installExtension({
    events: {
      on() {
        throw new Error('listener-registration-failed')
      },
      emit() {}
    },
    getAllTools: () => [],
    getCommands: () => []
  })
  await command.handler('nonce-bus-listener', commandContext())
  const payload = lastStatusPayload(statuses)
  assert.equal(payload.quiescent, false)
  assert.ok(
    payload.providers.some(
      (provider) => provider.id === SENTINEL_ID_EVENT_BUS && provider.state === 'unknown'
    )
  )
})

test('registered providers missing or late become unknown; valid multi-advisor reply accepted', async () => {
  const bus = createBus()
  const { command, statuses } = installExtension({
    events: bus,
    getAllTools: () => [],
    getCommands: () => []
  })

  bus.emit(PROVIDER_REGISTER_EVENT, buildProviderRegister(PROVIDER_ID_MULTI_ADVISOR))
  bus.emit(PROVIDER_REGISTER_EVENT, buildProviderRegister('late-provider'))

  bus.on(PROVIDER_QUERY_EVENT, (raw) => {
    const requestId = raw.requestId
    bus.emit(
      `${PROVIDER_REPLY_EVENT_PREFIX}${requestId}`,
      buildProviderReply({
        requestId,
        providerId: PROVIDER_ID_MULTI_ADVISOR,
        state: 'idle'
      })
    )
    // late-provider intentionally silent
  })

  await command.handler('nonce-roster', commandContext())
  const payload = lastStatusPayload(statuses)
  const advisor = payload.providers.find((provider) => provider.id === PROVIDER_ID_MULTI_ADVISOR)
  const late = payload.providers.find((provider) => provider.id === 'late-provider')
  assert.deepEqual(advisor, { id: PROVIDER_ID_MULTI_ADVISOR, state: 'idle' })
  assert.deepEqual(late, {
    id: 'late-provider',
    state: 'unknown',
    reason: 'missing-or-late'
  })
  assert.equal(payload.quiescent, false)
})

test('invalid registered provider reply becomes unknown', async () => {
  const bus = createBus()
  const { command, statuses } = installExtension({
    events: bus,
    getAllTools: () => [],
    getCommands: () => []
  })
  bus.emit(PROVIDER_REGISTER_EVENT, buildProviderRegister('bad-provider'))
  bus.on(PROVIDER_QUERY_EVENT, (raw) => {
    bus.emit(`${PROVIDER_REPLY_EVENT_PREFIX}${raw.requestId}`, {
      version: 1,
      requestId: raw.requestId,
      providerId: 'bad-provider',
      state: 'idle',
      extra: true
    })
  })
  await command.handler('nonce-invalid', commandContext())
  const payload = lastStatusPayload(statuses)
  assert.deepEqual(
    payload.providers.find((provider) => provider.id === 'bad-provider'),
    { id: 'bad-provider', state: 'unknown', reason: 'invalid-reply' }
  )
})

test('registered provider path-like reason is rejected without leaking it', async () => {
  const bus = createBus()
  const { command, statuses } = installExtension({
    events: bus,
    getAllTools: () => [],
    getCommands: () => []
  })
  bus.emit(PROVIDER_REGISTER_EVENT, buildProviderRegister('private-provider'))
  bus.on(PROVIDER_QUERY_EVENT, (raw) => {
    bus.emit(`${PROVIDER_REPLY_EVENT_PREFIX}${raw.requestId}`, {
      version: 1,
      requestId: raw.requestId,
      providerId: 'private-provider',
      state: 'busy',
      reason: '/home/secret/background-task'
    })
  })
  await command.handler('nonce-private-reason', commandContext())
  const payload = lastStatusPayload(statuses)
  assert.deepEqual(
    payload.providers.find((provider) => provider.id === 'private-provider'),
    { id: 'private-provider', state: 'unknown', reason: 'invalid-reply' }
  )
  assert.ok(!JSON.stringify(payload).includes('/home/secret'))
})

test('Magic Context source metadata remains blocking unknown until external adoption', async () => {
  const bus = createBus()
  const { command, statuses } = installExtension({
    events: bus,
    getAllTools: () => [
      {
        name: 'ctx_memory',
        sourceInfo: { source: '@cortexkit/pi-magic-context' }
      }
    ],
    getCommands: () => []
  })
  await command.handler('nonce-mc', commandContext())
  const payload = lastStatusPayload(statuses)
  assert.deepEqual(
    payload.providers.find((provider) => provider.id === PROVIDER_ID_MAGIC_CONTEXT),
    {
      id: PROVIDER_ID_MAGIC_CONTEXT,
      state: 'unknown',
      reason: 'provider-not-adopted:source:pi-magic-context'
    }
  )
})

test('adopted Magic Context and subagents use registered providers without stale compatibility blockers', async () => {
  const bus = createBus()
  let legacySubagentRequests = 0
  const { command, statuses } = installExtension({
    events: bus,
    getAllTools: () => [
      { name: 'ctx_memory', sourceInfo: { source: '@cortexkit/pi-magic-context' } },
      { name: 'subagent', sourceInfo: { source: 'pi-subagents' } }
    ],
    getCommands: () => []
  })
  bus.emit(PROVIDER_REGISTER_EVENT, buildProviderRegister(PROVIDER_ID_MAGIC_CONTEXT))
  bus.emit(PROVIDER_REGISTER_EVENT, buildProviderRegister(PROVIDER_ID_SUBAGENTS))
  bus.on(SUBAGENT_RPC_REQUEST_EVENT, () => {
    legacySubagentRequests += 1
  })
  bus.on(PROVIDER_QUERY_EVENT, (raw) => {
    for (const providerId of [PROVIDER_ID_MAGIC_CONTEXT, PROVIDER_ID_SUBAGENTS]) {
      bus.emit(
        `${PROVIDER_REPLY_EVENT_PREFIX}${raw.requestId}`,
        buildProviderReply({ requestId: raw.requestId, providerId, state: 'idle' })
      )
    }
  })

  await command.handler('nonce-adopted', commandContext({ idle: true, pending: false }))
  const payload = lastStatusPayload(statuses)
  assert.deepEqual(
    payload.providers.find((provider) => provider.id === PROVIDER_ID_MAGIC_CONTEXT),
    { id: PROVIDER_ID_MAGIC_CONTEXT, state: 'idle' }
  )
  assert.deepEqual(
    payload.providers.find((provider) => provider.id === PROVIDER_ID_SUBAGENTS),
    { id: PROVIDER_ID_SUBAGENTS, state: 'idle' }
  )
  assert.equal(legacySubagentRequests, 0)
  assert.equal(payload.quiescent, true)
})

test('subagent idle RPC keeps provider idle when fleet text matches exactly', async () => {
  const bus = createBus()
  const { command, statuses } = installExtension({
    events: bus,
    getAllTools: () => [{ name: 'subagent', sourceInfo: { source: 'pi-subagents' } }],
    getCommands: () => []
  })
  bus.on(SUBAGENT_RPC_REQUEST_EVENT, (raw) => {
    bus.emit(`subagents:rpc:v1:reply:${raw.requestId}`, {
      version: 1,
      requestId: raw.requestId,
      success: true,
      data: { text: SUBAGENT_FLEET_IDLE_TEXT }
    })
  })
  await command.handler('nonce-sub', commandContext({ idle: true, pending: false }))
  const payload = lastStatusPayload(statuses)
  assert.deepEqual(
    payload.providers.find((provider) => provider.id === PROVIDER_ID_SUBAGENTS),
    { id: PROVIDER_ID_SUBAGENTS, state: 'idle' }
  )
  assert.equal(payload.quiescent, true)
})

test('hibernate prepare uses the adopted subagent provider fence without redundant legacy adapter calls', async () => {
  const bus = createBus()
  const order = []
  const { commands, statuses } = installExtension({
    events: bus,
    getAllTools: () => [{ name: 'subagent', sourceInfo: { source: 'pi-subagents' } }],
    getCommands: () => []
  })
  // Simulate a globally loaded provider whose one-shot registration happened
  // before the app-owned coordinator installed its listener.
  const acceptProviderLease = (action) => (raw) => {
    order.push(`provider-${action}`)
    bus.emit(`${PROVIDER_LEASE_REPLY_EVENT_PREFIX}${raw.requestId}`, {
      version: 1,
      requestId: raw.requestId,
      providerId: PROVIDER_ID_SUBAGENTS,
      ok: true
    })
  }
  bus.on(PROVIDER_LEASE_PREPARE_EVENT, acceptProviderLease('prepare'))
  bus.on(PROVIDER_LEASE_COMMIT_EVENT, acceptProviderLease('commit'))
  bus.on(PROVIDER_LEASE_RELEASE_EVENT, acceptProviderLease('release'))
  const context = commandContext({
    sessionId: 'session-1',
    extensionPaths: [
      '/opt/pi-gui/pi-gui-runtime-quiescence/src/index.ts',
      '/home/user/.pi/agent/npm/node_modules/pi-subagents/index.ts'
    ],
    invokeTool() {
      throw new Error('legacy adapter must not run after the owner provider accepts prepare')
    }
  })
  await commands.get('pi-gui-runtime-hibernate-lease').handler(
    JSON.stringify({
      version: 1,
      action: 'prepare',
      nonce: 'nonce-lease-order',
      sessionId: 'session-1',
      generation: 1,
      attemptId: 'attempt-lease-order'
    }),
    context
  )
  assert.deepEqual(order, ['provider-prepare'])
  const delivered = statuses.filter(
    (entry) => entry.key === LEASE_STATUS_KEY && typeof entry.value === 'string'
  )
  assert.ok(delivered.length >= 1)
  const payload = JSON.parse(delivered.at(-1).value)
  assert.equal(payload.ok, true, JSON.stringify(payload))
  assert.deepEqual(payload.preparedProviders, [PROVIDER_ID_SUBAGENTS])

  const identity = {
    version: 1,
    nonce: 'nonce-lease-order-commit',
    sessionId: 'session-1',
    generation: 1,
    attemptId: 'attempt-lease-order',
    token: payload.token
  }
  await commands.get('pi-gui-runtime-hibernate-lease').handler(
    JSON.stringify({ ...identity, action: 'commit' }),
    context
  )
  await commands.get('pi-gui-runtime-hibernate-lease').handler(
    JSON.stringify({ ...identity, nonce: 'nonce-lease-order-release', action: 'release' }),
    context
  )
  assert.ok(order.includes('provider-commit'))
  assert.ok(order.includes('provider-release'))
})

test('hibernate lease retries pi-subagents with its legacy persisted-session identity', async () => {
  const bus = createBus()
  const requests = []
  const ownerSessionFile = '/home/user/.pi/agent/sessions/project/session-1.jsonl'
  let fence = null
  const { commands, statuses } = installExtension({
    events: bus,
    sessionId: 'session-1',
    sessionFile: ownerSessionFile,
    getAllTools: () => [{ name: 'subagent', sourceInfo: { source: 'pi-subagents' } }],
    getCommands: () => []
  })
  const reply = (raw, ok, reason) => {
    bus.emit(`${PROVIDER_LEASE_REPLY_EVENT_PREFIX}${raw.requestId}`, {
      version: 1,
      requestId: raw.requestId,
      providerId: PROVIDER_ID_SUBAGENTS,
      ok,
      ...(ok ? {} : { reason })
    })
  }
  bus.on(PROVIDER_LEASE_PREPARE_EVENT, (raw) => {
    requests.push({ action: 'prepare', sessionId: raw.sessionId })
    const sameFence = fence !== null &&
      fence.sessionId === raw.sessionId &&
      fence.generation === raw.generation &&
      fence.attemptId === raw.attemptId &&
      fence.token === raw.token
    const ok = raw.sessionId === ownerSessionFile && (fence === null || sameFence)
    if (ok && fence === null) fence = { ...raw }
    reply(raw, ok, 'operation-active-or-fenced')
  })
  bus.on(PROVIDER_LEASE_COMMIT_EVENT, (raw) => {
    requests.push({ action: 'commit', sessionId: raw.sessionId })
    const ok = fence !== null && fence.sessionId === raw.sessionId && fence.token === raw.token
    reply(raw, ok, 'lease-identity-mismatch')
  })
  bus.on(PROVIDER_LEASE_RELEASE_EVENT, (raw) => {
    requests.push({ action: 'release', sessionId: raw.sessionId })
    const ok = fence !== null && fence.sessionId === raw.sessionId && fence.token === raw.token
    if (ok) fence = null
    reply(raw, ok, 'lease-identity-mismatch')
  })

  const context = commandContext({
    sessionId: 'session-1',
    sessionFile: ownerSessionFile,
    extensionPaths: [
      '/opt/pi-gui/pi-gui-runtime-quiescence/src/index.ts',
      '/home/user/.pi/agent/npm/node_modules/pi-subagents/index.ts'
    ]
  })
  await commands.get('pi-gui-runtime-hibernate-lease').handler(JSON.stringify({
    version: 1,
    action: 'prepare',
    nonce: 'nonce-legacy-subagent-prepare',
    sessionId: 'session-1',
    generation: 1,
    attemptId: 'attempt-legacy-subagent'
  }), context)
  const prepared = lastLeaseStatusPayload(statuses)
  assert.equal(prepared.ok, true, JSON.stringify(prepared))
  assert.deepEqual(requests, [
    { action: 'prepare', sessionId: 'session-1' },
    { action: 'prepare', sessionId: ownerSessionFile }
  ])

  const identity = {
    version: 1,
    sessionId: 'session-1',
    generation: 1,
    attemptId: 'attempt-legacy-subagent',
    token: prepared.token
  }
  await commands.get('pi-gui-runtime-hibernate-lease').handler(JSON.stringify({
    ...identity,
    action: 'commit',
    nonce: 'nonce-legacy-subagent-commit'
  }), context)
  assert.equal(lastLeaseStatusPayload(statuses).ok, true)
  await commands.get('pi-gui-runtime-hibernate-lease').handler(JSON.stringify({
    ...identity,
    action: 'release',
    nonce: 'nonce-legacy-subagent-release'
  }), context)
  assert.equal(lastLeaseStatusPayload(statuses).ok, true)
  assert.deepEqual(requests.slice(2), [
    { action: 'commit', sessionId: ownerSessionFile },
    { action: 'release', sessionId: ownerSessionFile }
  ])
  assert.equal(fence, null)
})

test('synchronous provider listener failure preserves earlier prepare acknowledgements for rollback', async () => {
  const bus = createBus()
  let releaseObserved = false
  const { commands, statuses } = installExtension({
    events: bus,
    sessionId: 'session-listener-throw',
    getAllTools: () => [{ name: 'subagent', sourceInfo: { source: 'pi-subagents' } }],
    getCommands: () => []
  })
  const reply = (raw, providerId, ok, reason) => {
    bus.emit(`${PROVIDER_LEASE_REPLY_EVENT_PREFIX}${raw.requestId}`, {
      version: 1,
      requestId: raw.requestId,
      providerId,
      ok,
      ...(ok ? {} : { reason })
    })
  }
  bus.on(PROVIDER_LEASE_PREPARE_EVENT, (raw) => {
    reply(raw, PROVIDER_ID_SUBAGENTS, true)
  })
  bus.on(PROVIDER_LEASE_PREPARE_EVENT, () => {
    throw new Error('later provider listener failed')
  })
  bus.on(PROVIDER_LEASE_RELEASE_EVENT, (raw) => {
    releaseObserved = true
    reply(raw, PROVIDER_ID_SUBAGENTS, true)
  })
  const context = commandContext({
    sessionId: 'session-listener-throw',
    extensionPaths: [
      '/opt/pi-gui/pi-gui-runtime-quiescence/src/index.ts',
      '/home/user/.pi/agent/npm/node_modules/pi-subagents/index.ts',
      '/opt/pi-gui/pi-gui-multi-advisor/src/index.ts'
    ],
    invokeTool() {
      throw new Error('adapter must not run after provider prepare failure')
    }
  })
  await commands.get('pi-gui-runtime-hibernate-lease').handler(JSON.stringify({
    version: 1,
    action: 'prepare',
    nonce: 'nonce-listener-throw',
    sessionId: 'session-listener-throw',
    generation: 1,
    attemptId: 'attempt-listener-throw'
  }), context)
  const result = lastLeaseStatusPayload(statuses)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'provider-prepare-failed')
  assert.equal(releaseObserved, true)
})

test('partial provider release retries only the remaining failed roster', async () => {
  const bus = createBus()
  let releaseRound = 0
  const { commands, statuses } = installExtension({
    events: bus,
    sessionId: 'session-release-retry',
    getAllTools: () => [{ name: 'subagent', sourceInfo: { source: 'pi-subagents' } }],
    getCommands: () => []
  })
  const reply = (raw, providerId, ok, reason) => {
    bus.emit(`${PROVIDER_LEASE_REPLY_EVENT_PREFIX}${raw.requestId}`, {
      version: 1,
      requestId: raw.requestId,
      providerId,
      ok,
      ...(ok ? {} : { reason })
    })
  }
  const acceptBoth = (raw) => {
    reply(raw, PROVIDER_ID_SUBAGENTS, true)
    reply(raw, PROVIDER_ID_MULTI_ADVISOR, true)
  }
  bus.on(PROVIDER_LEASE_PREPARE_EVENT, acceptBoth)
  bus.on(PROVIDER_LEASE_COMMIT_EVENT, acceptBoth)
  bus.on(PROVIDER_LEASE_RELEASE_EVENT, (raw) => {
    releaseRound += 1
    // The first round releases subagents but the advisor restore fails. The
    // second event is still broadcast process-wide; the coordinator must ignore
    // the already-released subagent reply and wait only for the retained advisor.
    reply(raw, PROVIDER_ID_SUBAGENTS, releaseRound === 1, 'no-fence')
    reply(raw, PROVIDER_ID_MULTI_ADVISOR, releaseRound > 1, 'restore-failed')
  })
  const context = commandContext({
    sessionId: 'session-release-retry',
    extensionPaths: [
      '/opt/pi-gui/pi-gui-runtime-quiescence/src/index.ts',
      '/home/user/.pi/agent/npm/node_modules/pi-subagents/index.ts',
      '/opt/pi-gui/pi-gui-multi-advisor/src/index.ts'
    ],
    invokeTool(_name, params) {
      const text = params.action === 'schedule-list'
        ? SUBAGENT_SCHEDULE_IDLE_TEXT
        : SUBAGENT_FLEET_IDLE_TEXT
      return { content: [{ type: 'text', text }] }
    }
  })
  const command = commands.get('pi-gui-runtime-hibernate-lease')
  await command.handler(JSON.stringify({
    version: 1,
    action: 'prepare',
    nonce: 'nonce-release-retry-prepare',
    sessionId: 'session-release-retry',
    generation: 1,
    attemptId: 'attempt-release-retry'
  }), context)
  const prepared = lastLeaseStatusPayload(statuses)
  assert.equal(prepared.ok, true)
  const identity = {
    version: 1,
    sessionId: 'session-release-retry',
    generation: 1,
    attemptId: 'attempt-release-retry',
    token: prepared.token
  }
  await command.handler(JSON.stringify({
    ...identity,
    action: 'commit',
    nonce: 'nonce-release-retry-commit'
  }), context)
  assert.equal(lastLeaseStatusPayload(statuses).ok, true)
  await command.handler(JSON.stringify({
    ...identity,
    action: 'release',
    nonce: 'nonce-release-retry-first'
  }), context)
  assert.equal(lastLeaseStatusPayload(statuses).ok, false)
  await command.handler(JSON.stringify({
    ...identity,
    action: 'release',
    nonce: 'nonce-release-retry-second'
  }), context)
  assert.equal(lastLeaseStatusPayload(statuses).ok, true)
  assert.equal(releaseRound, 2)
})

test('oversized busy fleet count stays bounded and does not abort status delivery', async () => {
  const bus = createBus()
  const huge = '9'.repeat(300)
  const { command, statuses } = installExtension({
    events: bus,
    getAllTools: () => [{ name: 'subagent', sourceInfo: { source: 'pi-subagents' } }],
    getCommands: () => []
  })
  bus.on(SUBAGENT_RPC_REQUEST_EVENT, (raw) => {
    bus.emit(`subagents:rpc:v1:reply:${raw.requestId}`, {
      version: 1,
      requestId: raw.requestId,
      success: true,
      data: { text: `Subagent fleet: ${huge} tracked\n` }
    })
  })
  await command.handler('nonce-busy-bound', commandContext())
  const payload = lastStatusPayload(statuses)
  const sub = payload.providers.find((provider) => provider.id === PROVIDER_ID_SUBAGENTS)
  assert.equal(sub?.state, 'busy')
  assert.ok(typeof sub?.reason === 'string')
  assert.ok(sub.reason.length <= MAX_REASON_LENGTH)
  assert.equal(payload.quiescent, false)
})

function installExtension(options) {
  /** @type {Map<string, { name: string, handler: Function }>} */
  const commands = new Map()
  const statuses = []
  const events = options.events === null ? undefined : options.events ?? createBus()
  const lifecycle = new Map()
  /** @type {Record<string, unknown>} */
  const pi = {
    events,
    on(name, handler) {
      lifecycle.set(name, handler)
    },
    registerCommand(name, definition) {
      commands.set(name, { name, handler: wrapHandler(definition.handler, statuses) })
    },
    getAllTools: options.getAllTools ?? (() => [])
  }
  if (Object.hasOwn(options, 'getCommands')) {
    if (options.getCommands !== undefined) {
      pi.getCommands = options.getCommands
    }
  } else {
    pi.getCommands = () => []
  }
  extension(pi)
  const sessionId = options.sessionId ?? 'session-1'
  const sessionFile = options.sessionFile ?? null
  lifecycle.get('session_start')?.(
    { reason: 'startup' },
    {
      sessionManager: {
        getSessionId: () => sessionId,
        getSessionFile: () => sessionFile
      }
    }
  )
  const command = commands.get(QUIESCENCE_COMMAND_NAME)
  assert.equal(command?.name, QUIESCENCE_COMMAND_NAME)
  assert.ok(commands.has('pi-gui-runtime-hibernate-lease'))
  return { command, commands, statuses, events, lifecycle, sessionId }
}

function wrapHandler(handler, statuses) {
  return async (args, ctx) => {
    const wrappedCtx = Object.assign(Object.create(ctx), {
      ui: {
        setStatus(key, value) {
          statuses.push({ key, value })
        }
      }
    })
    await handler(args, wrappedCtx)
  }
}

function commandContext(options = {}) {
  const ctx = {
    isIdle: () => options.idle !== false,
    hasPendingMessages: () => options.pending === true,
    sessionManager: {
      getSessionId: () => options.sessionId ?? 'session-1',
      getSessionFile: () => options.sessionFile ?? null
    },
    ui: {
      setStatus() {}
    }
  }
  if (Array.isArray(options.extensionPaths)) {
    Object.defineProperty(ctx, EXTENSION_INVENTORY_ACCESSOR, {
      value: () => [...options.extensionPaths]
    })
  }
  if (typeof options.invokeTool === 'function') {
    Object.defineProperty(ctx, EXTENSION_TOOL_INVOKE_ACCESSOR, {
      value: options.invokeTool
    })
  }
  return ctx
}

function lastStatusPayload(statuses) {
  const delivered = statuses.filter(
    (entry) => entry.key === QUIESCENCE_STATUS_KEY && typeof entry.value === 'string'
  )
  assert.ok(delivered.length >= 1, 'expected quiescence status delivery')
  return JSON.parse(delivered.at(-1).value)
}

function lastLeaseStatusPayload(statuses) {
  const delivered = statuses.filter(
    (entry) => entry.key === LEASE_STATUS_KEY && typeof entry.value === 'string'
  )
  assert.ok(delivered.length >= 1, 'expected hibernate lease status delivery')
  return JSON.parse(delivered.at(-1).value)
}

function createBus() {
  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map()
  return {
    on(event, handler) {
      let set = listeners.get(event)
      if (set === undefined) {
        set = new Set()
        listeners.set(event, set)
      }
      set.add(handler)
      return () => set.delete(handler)
    },
    emit(event, data) {
      const set = listeners.get(event)
      if (set === undefined) return
      for (const handler of [...set]) handler(data)
    }
  }
}
