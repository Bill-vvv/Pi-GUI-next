import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAGIC_CONTEXT_TOOL_NAMES,
  MAX_NONCE_LENGTH,
  MAX_PROVIDER_COUNT,
  MAX_REASON_LENGTH,
  MAX_STATUS_TEXT_LENGTH,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  PROVIDER_ID_MAGIC_CONTEXT,
  PROVIDER_ID_MULTI_ADVISOR,
  PROVIDER_ID_SUBAGENTS,
  PROVIDER_REGISTER_EVENT,
  QUIESCENCE_COMMAND_NAME,
  QUIESCENCE_RESULT_KIND,
  QUIESCENCE_STATUS_KEY,
  SENTINEL_ID_COMMAND_DISCOVERY,
  SENTINEL_ID_EVENT_BUS,
  SENTINEL_ID_TOOL_DISCOVERY,
  SENTINEL_ID_UNREGISTERED_EXTENSION,
  SUBAGENT_FLEET_IDLE_TEXT,
  buildMagicContextUnknownReport,
  buildProviderRegister,
  buildProviderReply,
  buildQuiescenceResultPayload,
  buildUnregisteredExtensionReport,
  classifyCommandEntries,
  classifyExactExtensionInventory,
  classifyToolEntries,
  detectLoadedToolSets,
  isInternalQuiescenceCommandName,
  isValidNonce,
  normalizeDiscoveredCommandEntries,
  normalizeQuiescenceTimeoutMs,
  parseProviderQueryEvent,
  parseProviderRegisterEvent,
  parseProviderReplyEvent,
  parseQuiescenceStatusPayload,
  parseSubagentFleetStatusText,
  parseSubagentRpcStatusReply,
  providerReplyEventName,
  resolveRegisteredProviderReports
} from '../src/protocol.mjs'

test('filters the internal quiescence command name exactly', () => {
  assert.equal(isInternalQuiescenceCommandName(QUIESCENCE_COMMAND_NAME), true)
  assert.equal(isInternalQuiescenceCommandName('advisor'), false)
  assert.equal(QUIESCENCE_STATUS_KEY, 'pi-gui.runtime-quiescence')
  assert.equal(QUIESCENCE_RESULT_KIND, 'pi-gui.runtime-quiescence/query-result')
  assert.equal(PROVIDER_REGISTER_EVENT, 'pi-gui.runtime-quiescence/provider-register/v1')
  assert.equal(SENTINEL_ID_TOOL_DISCOVERY, 'tool-discovery')
  assert.equal(SENTINEL_ID_COMMAND_DISCOVERY, 'command-discovery')
  assert.equal(SENTINEL_ID_EVENT_BUS, 'event-bus')
  assert.equal(SENTINEL_ID_UNREGISTERED_EXTENSION, 'unregistered-extension')
})

test('accepts only the exact bounded full-fleet idle string', () => {
  assert.deepEqual(parseSubagentFleetStatusText(SUBAGENT_FLEET_IDLE_TEXT), { state: 'idle' })
  assert.deepEqual(
    parseSubagentFleetStatusText(`Spawn budget: unlimited\n${SUBAGENT_FLEET_IDLE_TEXT}`),
    { state: 'idle' }
  )
  assert.deepEqual(
    parseSubagentFleetStatusText('Spawn budget: unlimited\nNo active async runs.'),
    { state: 'unknown', reason: 'fleet-view-unsupported' }
  )
  assert.deepEqual(
    parseSubagentFleetStatusText('Spawn budget: maybe\nNo active async runs.'),
    { state: 'unknown', reason: 'invalid-spawn-budget-prefix' }
  )
  assert.equal(
    parseSubagentFleetStatusText(`${SUBAGENT_FLEET_IDLE_TEXT} `).state,
    'unknown'
  )
  assert.equal(parseSubagentFleetStatusText('No active subagent fleet.').state, 'unknown')
  assert.deepEqual(parseSubagentFleetStatusText('x'.repeat(MAX_STATUS_TEXT_LENGTH + 1)), {
    state: 'unknown',
    reason: 'status-length'
  })
})

test('accepts only the exact busy fleet header and rejects drift', () => {
  assert.deepEqual(parseSubagentFleetStatusText('Subagent fleet: 2 tracked\n\nForeground runs:'), {
    state: 'busy',
    reason: 'fleet-tracked:2'
  })
  assert.deepEqual(
    parseSubagentFleetStatusText('Spawn budget: 1/8 used, 7 remaining (configured 8; granted 0; grant allowance 8)\nSubagent fleet: 2 tracked\n\nForeground runs:'),
    { state: 'busy', reason: 'fleet-tracked:2' }
  )
  assert.equal(parseSubagentFleetStatusText('Subagent fleet: 0 tracked').state, 'unknown')
  assert.equal(parseSubagentFleetStatusText('Subagent fleet: two tracked').state, 'unknown')
  assert.equal(parseSubagentFleetStatusText('Active async runs\n- x').state, 'unknown')
})

test('oversized busy fleet count reason stays within MAX_REASON_LENGTH and builds payload', () => {
  const huge = '9'.repeat(300)
  const parsed = parseSubagentFleetStatusText(`Subagent fleet: ${huge} tracked\n`)
  assert.equal(parsed.state, 'busy')
  assert.equal(parsed.reason?.length, MAX_REASON_LENGTH)
  assert.ok(parsed.reason?.startsWith('fleet-tracked:'))
  const payload = buildQuiescenceResultPayload({
    nonce: 'n-busy',
    core: { idle: true, pendingMessages: false },
    providers: [{ id: PROVIDER_ID_SUBAGENTS, state: 'busy', reason: parsed.reason }]
  })
  assert.equal(payload.quiescent, false)
  assert.equal(payload.providers[0]?.reason?.length, MAX_REASON_LENGTH)
})

test('subagent RPC reply parsing fails closed on errors and malformed envelopes', () => {
  const requestId = 'req-1'
  assert.deepEqual(
    parseSubagentRpcStatusReply(
      {
        version: 1,
        requestId,
        method: 'status',
        success: true,
        data: { text: SUBAGENT_FLEET_IDLE_TEXT }
      },
      requestId
    ),
    { state: 'idle' }
  )
  assert.equal(
    parseSubagentRpcStatusReply(
      { version: 1, requestId, success: false, error: { code: 'no_active_session', message: 'x' } },
      requestId
    ).reason,
    'rpc-error:no_active_session'
  )
  assert.equal(
    parseSubagentRpcStatusReply(
      { version: 1, requestId, success: false, error: { code: '/home/secret/error-code' } },
      requestId
    ).reason,
    'rpc-error:invalid-code'
  )
  assert.equal(
    parseSubagentRpcStatusReply(
      { version: 2, requestId, success: true, data: { text: SUBAGENT_FLEET_IDLE_TEXT } },
      requestId
    ).state,
    'unknown'
  )
  assert.equal(
    parseSubagentRpcStatusReply(
      { version: 1, requestId: 'other', success: true, data: { text: SUBAGENT_FLEET_IDLE_TEXT } },
      requestId
    ).state,
    'unknown'
  )
  assert.equal(
    parseSubagentRpcStatusReply(
      {
        version: 1,
        requestId,
        method: 'spawn',
        success: true,
        data: { text: SUBAGENT_FLEET_IDLE_TEXT }
      },
      requestId
    ).reason,
    'unexpected-method'
  )
  assert.equal(
    parseSubagentRpcStatusReply({ version: 1, requestId, success: true, data: {} }, requestId).state,
    'unknown'
  )
  assert.equal(
    parseSubagentRpcStatusReply(
      {
        version: 1,
        requestId,
        success: true,
        data: { text: SUBAGENT_FLEET_IDLE_TEXT },
        extra: true
      },
      requestId
    ).reason,
    'unknown-properties'
  )
})

test('detects subagent and magic-context tools; source preferred over ambiguous name fallback', () => {
  assert.deepEqual(detectLoadedToolSets(['read', 'bash']), {
    ok: true,
    subagentLoaded: false,
    magicContextLoaded: false,
    magicContextTools: [],
    magicContextDetection: 'none',
    unregisteredToolSources: 0,
    unregisteredNameOnlyTools: 2
  })
  assert.equal(detectLoadedToolSets(['subagent', 'read']).subagentLoaded, true)
  assert.equal(detectLoadedToolSets(['subagent_wait']).subagentLoaded, true)

  const byName = detectLoadedToolSets(['ctx_memory', 'todowrite', 'read'])
  assert.equal(byName.ok, true)
  assert.equal(byName.magicContextLoaded, true)
  assert.equal(byName.magicContextDetection, 'name-fallback-ambiguous')
  assert.deepEqual(byName.magicContextTools, ['ctx_memory', 'todowrite'])
  assert.ok(MAGIC_CONTEXT_TOOL_NAMES.includes('ctx_reduce'))

  const bySource = detectLoadedToolSets([
    { name: 'ctx_memory', sourceInfo: { source: '@cortexkit/pi-magic-context' } },
    { name: 'read', sourceInfo: { source: 'builtin' } }
  ])
  assert.equal(bySource.ok, true)
  assert.equal(bySource.magicContextLoaded, true)
  assert.equal(bySource.magicContextDetection, 'source')
  assert.equal(bySource.magicContextSource, 'pi-magic-context')

  assert.equal(detectLoadedToolSets(null).ok, false)
  assert.equal(detectLoadedToolSets([{ name: 1 }]).ok, false)
})

test('arbitrary unregistered tool source becomes one generic count-only report', () => {
  const classified = classifyToolEntries([
    {
      name: 'shadow',
      source: 'local',
      path: '/home/secret/evil-extension/index.ts'
    },
    { name: 'read', source: 'builtin', path: '<builtin:read>' },
    { name: 'llama', source: 'inline', path: '<inline:llama.cpp>' }
  ])
  assert.equal(classified.unregisteredToolSources, 1)
  assert.equal(classified.unregisteredNameOnlyTools, 0)
  const report = buildUnregisteredExtensionReport(classified)
  assert.deepEqual(report, {
    id: SENTINEL_ID_UNREGISTERED_EXTENSION,
    state: 'unknown',
    reason: 'discovered:tool-sources=1;tool-name-only=0;command-sources=0;command-name-only=0'
  })
  assert.ok(!report.reason.includes('/home/secret'))
  assert.ok(!report.reason.includes('evil-extension'))
  assert.ok(!report.reason.includes('shadow'))
})

test('SDK and name-only custom tools fail closed without promoting names to provider ids', () => {
  const sdkClassified = classifyToolEntries([{ name: 'sdk_background', source: 'sdk' }])
  assert.equal(sdkClassified.unregisteredToolSources, 1)

  const classified = classifyToolEntries([{ name: 'custom_tool' }])
  assert.equal(classified.unregisteredNameOnlyTools, 1)
  const report = buildUnregisteredExtensionReport(classified)
  assert.equal(report?.id, SENTINEL_ID_UNREGISTERED_EXTENSION)
  assert.match(report.reason, /tool-name-only=1/u)
  assert.ok(!report.reason.includes('custom_tool'))
})

test('registered provider suppression requires exact source or complete path segment', () => {
  const registered = new Set(['foo'])
  const classified = classifyToolEntries(
    [
      { name: 'exact', source: 'foo' },
      { name: 'segment', source: 'local', path: '/tmp/extensions/foo/index.ts' },
      { name: 'substring', source: 'local', path: '/tmp/extensions/foobar/index.ts' }
    ],
    registered
  )
  assert.equal(classified.unregisteredToolSources, 1)
})

test('command-only extension source is counted without leaking paths', () => {
  const normalized = normalizeDiscoveredCommandEntries([
    {
      name: 'background',
      source: 'extension',
      sourceInfo: {
        source: 'local',
        path: '/tmp/secret-cmd-extension/index.ts'
      }
    },
    {
      name: QUIESCENCE_COMMAND_NAME,
      source: 'extension',
      sourceInfo: {
        source: 'local',
        path: '/opt/pi-gui/extensions/pi-gui-runtime-quiescence/src/index.ts'
      }
    },
    {
      name: 'pi-gui-history-navigation',
      source: 'extension',
      sourceInfo: { source: 'cli', scope: 'temporary', origin: 'top-level' }
    },
    {
      name: 'llama',
      source: 'extension',
      sourceInfo: {
        source: 'inline',
        path: '<inline:llama.cpp>',
        scope: 'temporary',
        origin: 'top-level'
      }
    },
    {
      name: 'review',
      source: 'prompt',
      sourceInfo: { source: 'review', path: '/tmp/prompts/review.md' }
    }
  ])
  assert.equal(normalized.ok, true)
  const classified = classifyCommandEntries(normalized.entries)
  assert.equal(classified.unregisteredCommandSources, 1)
  assert.equal(classified.unregisteredNameOnlyCommands, 0)
  const report = buildUnregisteredExtensionReport(classified)
  assert.match(report.reason, /command-sources=1/u)
  assert.ok(!report.reason.includes('/tmp/secret'))
})

test('magic-context path-like source is redacted in unknown report reason', () => {
  const report = buildMagicContextUnknownReport({
    magicContextTools: ['ctx_memory'],
    magicContextDetection: 'source',
    magicContextSource: '/home/vvv/.pi/agent/npm/node_modules/@cortexkit/pi-magic-context/index.ts'
  })
  assert.equal(report.id, PROVIDER_ID_MAGIC_CONTEXT)
  assert.equal(report.reason, 'provider-not-adopted:source:pi-magic-context')
  assert.ok(!report.reason.includes('/home/'))
})

test('Magic Context unknown report uses source metadata when available', () => {
  assert.deepEqual(
    buildMagicContextUnknownReport({
      magicContextTools: ['ctx_memory'],
      magicContextDetection: 'source',
      magicContextSource: '@cortexkit/pi-magic-context'
    }),
    {
      id: PROVIDER_ID_MAGIC_CONTEXT,
      state: 'unknown',
      reason: 'provider-not-adopted:source:pi-magic-context'
    }
  )
  assert.deepEqual(
    buildMagicContextUnknownReport({
      magicContextTools: ['ctx_note', 'todowrite'],
      magicContextDetection: 'name-fallback-ambiguous'
    }),
    {
      id: PROVIDER_ID_MAGIC_CONTEXT,
      state: 'unknown',
      reason: 'provider-not-adopted:name-fallback-ambiguous:ctx_note,todowrite'
    }
  )
})

test('builds and re-parses versioned quiescence payloads with nonce correlation', () => {
  const payload = buildQuiescenceResultPayload({
    nonce: 'n-1',
    core: { idle: true, pendingMessages: false },
    providers: [
      { id: PROVIDER_ID_SUBAGENTS, state: 'idle' },
      {
        id: PROVIDER_ID_MAGIC_CONTEXT,
        state: 'unknown',
        reason: 'provider-not-adopted:name-fallback-ambiguous:ctx_memory'
      }
    ]
  })
  assert.equal(payload.quiescent, false)
  assert.deepEqual(parseQuiescenceStatusPayload(JSON.stringify(payload), 'n-1'), {
    ok: true,
    result: payload
  })
})

test('rejects malformed payload, wrong nonce, bounds, duplicates, and unknown properties', () => {
  const base = buildQuiescenceResultPayload({
    nonce: 'n-2',
    core: { idle: true, pendingMessages: false },
    providers: []
  })
  assert.equal(parseQuiescenceStatusPayload('{', 'n-2').ok, false)
  assert.equal(parseQuiescenceStatusPayload({ ...base, nonce: 'other' }, 'n-2').reason, 'nonce-mismatch')
  assert.equal(parseQuiescenceStatusPayload({ ...base, version: 2 }, 'n-2').ok, false)
  assert.equal(
    parseQuiescenceStatusPayload({ ...base, quiescent: false }, 'n-2').reason,
    'inconsistent-quiescent'
  )
  assert.equal(
    parseQuiescenceStatusPayload({ ...base, providers: [{ id: 'x', state: 'sleeping' }] }, 'n-2').ok,
    false
  )
  assert.equal(
    parseQuiescenceStatusPayload({ ...base, unexpected: true }, 'n-2').reason,
    'unknown-properties'
  )
  assert.equal(
    parseQuiescenceStatusPayload(
      {
        ...base,
        providers: [
          { id: 'dup', state: 'idle' },
          { id: 'dup', state: 'busy' }
        ]
      },
      'n-2'
    ).reason,
    'duplicate-provider-id'
  )
  assert.equal(
    parseQuiescenceStatusPayload('x'.repeat(MAX_STATUS_TEXT_LENGTH + 1), 'n-2').reason,
    'status-length'
  )
  assert.equal(
    parseQuiescenceStatusPayload(
      {
        ...base,
        providers: Array.from({ length: MAX_PROVIDER_COUNT + 1 }, (_, index) => ({
          id: `p${index}`,
          state: 'idle'
        }))
      },
      'n-2'
    ).reason,
    'provider-count'
  )
  assert.equal(
    parseQuiescenceStatusPayload(
      {
        ...base,
        providers: [{ id: 'x', state: 'unknown', reason: 'r'.repeat(MAX_REASON_LENGTH + 1) }]
      },
      'n-2'
    ).ok,
    false
  )
  assert.equal(
    parseQuiescenceStatusPayload(
      {
        ...base,
        providers: [{ id: 'private-provider', state: 'unknown', reason: '/home/secret/task' }],
        quiescent: false
      },
      'n-2'
    ).reason,
    'malformed-providers'
  )
  assert.equal(isValidNonce('n'.repeat(MAX_NONCE_LENGTH)), true)
  assert.equal(isValidNonce('n'.repeat(MAX_NONCE_LENGTH + 1)), false)
  assert.throws(
    () =>
      buildQuiescenceResultPayload({
        nonce: 'n',
        core: { idle: true, pendingMessages: false },
        providers: [
          { id: 'a', state: 'idle' },
          { id: 'a', state: 'busy' }
        ]
      }),
    /Duplicate/u
  )
  const clamped = buildQuiescenceResultPayload({
    nonce: 'n-clamp',
    core: { idle: true, pendingMessages: false },
    providers: [{ id: 'x', state: 'unknown', reason: 'r'.repeat(MAX_REASON_LENGTH + 40) }]
  })
  assert.equal(clamped.providers[0]?.reason?.length, MAX_REASON_LENGTH)
  const redacted = buildQuiescenceResultPayload({
    nonce: 'n-redact',
    core: { idle: true, pendingMessages: false },
    providers: [{ id: 'private-provider', state: 'unknown', reason: '/home/secret/task' }]
  })
  assert.equal(redacted.providers[0]?.reason, 'provider-detail-redacted')
  assert.ok(!JSON.stringify(redacted).includes('/home/secret'))
})

test('provider register/query/reply protocol accepts only exact versioned envelopes', () => {
  assert.deepEqual(parseProviderRegisterEvent({ version: 1, providerId: PROVIDER_ID_MULTI_ADVISOR }), {
    version: 1,
    providerId: PROVIDER_ID_MULTI_ADVISOR
  })
  assert.equal(parseProviderRegisterEvent({ version: 1, providerId: 'x', extra: 1 }), null)
  assert.equal(parseProviderRegisterEvent({ version: 1, providerId: '/home/secret' }), null)
  assert.throws(() => buildProviderRegister('C:\\secret'), /out of bounds/u)
  assert.deepEqual(buildProviderRegister(PROVIDER_ID_MULTI_ADVISOR), {
    version: 1,
    providerId: PROVIDER_ID_MULTI_ADVISOR
  })
  assert.deepEqual(parseProviderQueryEvent({ version: 1, requestId: 'r1', nonce: 'n' }), {
    version: 1,
    requestId: 'r1',
    nonce: 'n'
  })
  assert.equal(parseProviderQueryEvent({ version: 1, requestId: 'bad\nid' }), null)
  assert.equal(parseProviderQueryEvent({ version: 1, requestId: 'r1', nonce: 'n', extra: true }), null)
  const reply = buildProviderReply({
    requestId: 'r1',
    providerId: PROVIDER_ID_MULTI_ADVISOR,
    state: 'busy',
    reason: 'advisor-running'
  })
  assert.deepEqual(parseProviderReplyEvent(reply, 'r1'), {
    id: PROVIDER_ID_MULTI_ADVISOR,
    state: 'busy',
    reason: 'advisor-running'
  })
  assert.equal(parseProviderReplyEvent(reply, 'other'), null)
  assert.equal(parseProviderReplyEvent({ ...reply, extra: true }, 'r1'), null)
  assert.equal(parseProviderReplyEvent({ ...reply, reason: '/home/secret' }, 'r1'), null)
  assert.throws(
    () => buildProviderReply({ ...reply, reason: 'C:\\Users\\secret' }),
    /path separators/u
  )
  assert.equal(providerReplyEventName('r1'), 'pi-gui.runtime-quiescence/provider-reply/v1:r1')
})

test('registered provider roster marks missing, late, and invalid replies unknown', () => {
  const validReplies = new Map([
    [PROVIDER_ID_MULTI_ADVISOR, { id: PROVIDER_ID_MULTI_ADVISOR, state: 'idle' }]
  ])
  const reports = resolveRegisteredProviderReports({
    registeredIds: [PROVIDER_ID_MULTI_ADVISOR, 'late-provider', 'bad-provider'],
    validReplies,
    invalidReplyIds: new Set(['bad-provider'])
  })
  assert.deepEqual(reports, [
    { id: PROVIDER_ID_MULTI_ADVISOR, state: 'idle' },
    { id: 'late-provider', state: 'unknown', reason: 'missing-or-late' },
    { id: 'bad-provider', state: 'unknown', reason: 'invalid-reply' }
  ])
})

test('exact inventory requires provider fences for task-notify, ask, MCP, and CPA', () => {
  const inventory = classifyExactExtensionInventory([
    '/opt/pi-gui/pi-gui-runtime-quiescence/src/index.ts',
    '/opt/pi-gui/pi-gui-history-navigation/src/index.ts',
    '/opt/pi-gui/pi-gui-task-notify/src/index.ts',
    '/opt/pi-gui/pi-gui-ask/src/index.ts',
    '/home/user/.pi/agent/extensions/pi-mcp-adapter/index.ts',
    '/home/user/.pi/agent/extensions/pi-cpa-responses-ws/index.ts'
  ])
  assert.equal(inventory.ok, true)
  assert.deepEqual(inventory.expectedProviderIds, [
    'pi-cpa-responses-ws',
    'pi-gui-ask',
    'pi-gui-task-notify',
    'pi-mcp-adapter'
  ])
  assert.equal(inventory.requiresSubagentsAdapter, false)
  assert.match(inventory.fingerprint, /providers=pi-cpa-responses-ws,pi-gui-ask,pi-gui-task-notify,pi-mcp-adapter/u)
})

test('exact inventory requires both the subagent owner fence and stable adapter snapshot', () => {
  const inventory = classifyExactExtensionInventory([
    '/opt/pi-gui/pi-gui-runtime-quiescence/src/index.ts',
    '/home/user/.pi/agent/npm/node_modules/pi-subagents/index.ts'
  ])
  assert.equal(inventory.ok, true)
  assert.deepEqual(inventory.expectedProviderIds, [PROVIDER_ID_SUBAGENTS])
  assert.equal(inventory.requiresSubagentsAdapter, true)
  assert.match(inventory.fingerprint, /providers=pi-subagents;subagents=1/u)
})

test('exact Pi 0.83 inline llama surface is certified as built-in without replacing self', () => {
  const inventory = classifyExactExtensionInventory([
    '/opt/pi-gui/pi-gui-runtime-quiescence/src/index.ts',
    '<inline:llama.cpp>'
  ])
  assert.equal(inventory.ok, true)
  assert.deepEqual(inventory.expectedProviderIds, [])
  assert.deepEqual(inventory.certifiedCoreMarkers, ['inline:llama.cpp'])
  assert.match(inventory.fingerprint, /core=inline:llama\.cpp/u)

  assert.deepEqual(classifyExactExtensionInventory(['<inline:llama.cpp>']), {
    ok: false,
    reason: 'inventory-missing-self'
  })
  assert.deepEqual(
    classifyExactExtensionInventory([
      '/opt/pi-gui/pi-gui-runtime-quiescence/src/index.ts',
      '<inline:llama.cpp>:unexpected'
    ]),
    { ok: false, reason: 'inventory-unknown-paths:1' }
  )
})

test('exact inventory fails closed for unknown paths and never certifies required providers as core-idle', () => {
  assert.deepEqual(
    classifyExactExtensionInventory([
      '/opt/pi-gui/pi-gui-runtime-quiescence/src/index.ts',
      '/opt/pi-gui/unknown-background-extension/index.ts'
    ]),
    { ok: false, reason: 'inventory-unknown-paths:1' }
  )
  const taskNotify = classifyExactExtensionInventory([
    '/opt/pi-gui/pi-gui-runtime-quiescence/src/index.ts',
    '/opt/pi-gui/pi-gui-task-notify/src/index.ts'
  ])
  assert.equal(taskNotify.ok, true)
  assert.deepEqual(taskNotify.expectedProviderIds, ['pi-gui-task-notify'])
})

test('timeout bounds require a finite integer within range', () => {
  assert.deepEqual(normalizeQuiescenceTimeoutMs(undefined).ok, true)
  assert.equal(normalizeQuiescenceTimeoutMs(MIN_TIMEOUT_MS).timeoutMs, MIN_TIMEOUT_MS)
  assert.equal(normalizeQuiescenceTimeoutMs(MAX_TIMEOUT_MS).timeoutMs, MAX_TIMEOUT_MS)
  assert.equal(normalizeQuiescenceTimeoutMs(1.5).ok, false)
  assert.equal(normalizeQuiescenceTimeoutMs(Number.POSITIVE_INFINITY).ok, false)
  assert.equal(normalizeQuiescenceTimeoutMs(0).ok, false)
  assert.equal(normalizeQuiescenceTimeoutMs(MAX_TIMEOUT_MS + 1).ok, false)
  assert.equal(normalizeQuiescenceTimeoutMs('100').ok, false)
})

test('core pending messages or non-idle core make the aggregate non-quiescent', () => {
  assert.equal(
    buildQuiescenceResultPayload({
      nonce: 'n',
      core: { idle: false, pendingMessages: false },
      providers: []
    }).quiescent,
    false
  )
  assert.equal(
    buildQuiescenceResultPayload({
      nonce: 'n',
      core: { idle: true, pendingMessages: true },
      providers: []
    }).quiescent,
    false
  )
  assert.equal(
    buildQuiescenceResultPayload({
      nonce: 'n',
      core: { idle: true, pendingMessages: false },
      providers: [{ id: 'x', state: 'idle' }]
    }).quiescent,
    true
  )
})

test('concurrent interleaving keeps first valid reply and still flags missing roster members', () => {
  const validReplies = new Map()
  // Simulate two providers racing; first wins.
  validReplies.set('alpha', { id: 'alpha', state: 'busy', reason: 'first' })
  // Second alpha reply would be ignored by collector; map already has first.
  const reports = resolveRegisteredProviderReports({
    registeredIds: ['alpha', 'beta'],
    validReplies
  })
  assert.deepEqual(reports, [
    { id: 'alpha', state: 'busy', reason: 'first' },
    { id: 'beta', state: 'unknown', reason: 'missing-or-late' }
  ])
})
