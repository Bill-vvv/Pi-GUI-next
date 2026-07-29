import assert from 'node:assert/strict'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import {
  PI_RPC_EXTENSION_EVENT_MAX_RECORD_BYTES,
  PI_RPC_TREE_MAX_DEPTH,
  PI_RPC_TREE_MAX_LABEL_CHARS,
  PI_RPC_TREE_MAX_LABEL_TIMESTAMP_CHARS,
  PI_RPC_TREE_MAX_NODES,
  PiRpcClient,
  type PiRpcDiagnostic
} from './pi-rpc-client.ts'

type FakeProcess = {
  child: ChildProcessWithoutNullStreams
  events: EventEmitter
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
}

function createFakeProcess(): FakeProcess {
  const events = new EventEmitter()
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const child = Object.assign(events, {
    stdin,
    stdout,
    stderr,
    pid: 1234,
    connected: false,
    exitCode: null,
    signalCode: null,
    killed: false,
    spawnfile: 'pi',
    spawnargs: ['pi', '--mode', 'rpc'],
    kill: () => true,
    ref: () => undefined,
    unref: () => undefined,
    disconnect: () => undefined,
    send: () => false
  }) as unknown as ChildProcessWithoutNullStreams
  return { child, events, stdin, stdout, stderr }
}

function readRequests(stdin: PassThrough): Array<{ id: string; type: string }> {
  const text: string = stdin.read(stdin.readableLength)?.toString('utf8') ?? ''
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { id: string; type: string })
}

function respondSuccess(
  fake: FakeProcess,
  request: { id: string; type: string },
  data?: unknown,
  command = request.type
): void {
  fake.stdout.write(`${JSON.stringify({
    type: 'response',
    id: request.id,
    command,
    success: true,
    ...(data === undefined ? {} : { data })
  })}\n`)
}

function treeEntry(
  id: string,
  parentId: string | null,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    parentId,
    type: 'message',
    timestamp: '2026-07-29T00:00:00.000Z',
    message: { role: 'assistant', content: 'private assistant payload' },
    ...overrides
  }
}

function deepTree(depth: number): Record<string, unknown> {
  let node: Record<string, unknown> | null = null
  for (let index = depth - 1; index >= 0; index--) {
    const id = `entry-${index}`
    node = {
      entry: treeEntry(id, index === 0 ? null : `entry-${index - 1}`),
      children: node === null ? [] : [node]
    }
  }
  return node!
}

test('serializes get_state as JSON followed by exactly one LF', () => {
  const fake = createFakeProcess()
  const client = new PiRpcClient(fake.child, { createRequestId: () => 'request-1' })

  void client.getState()

  assert.equal(fake.stdin.read()?.toString('utf8'), '{"id":"request-1","type":"get_state"}\n')
})

test('serializes extension UI responses without creating an RPC request', async () => {
  const fake = createFakeProcess()
  const client = new PiRpcClient(fake.child)

  await client.respondExtensionUi({ id: 'ui-1', value: 'Selected' })
  await client.respondExtensionUi({ id: 'ui-2', cancelled: true })

  assert.equal(
    fake.stdin.read(fake.stdin.readableLength)?.toString('utf8'),
    '{"type":"extension_ui_response","id":"ui-1","value":"Selected"}\n' +
      '{"type":"extension_ui_response","id":"ui-2","cancelled":true}\n'
  )
})

test('serializes get_extensions exactly and returns a canonical copied inventory', async () => {
  const fake = createFakeProcess()
  const client = new PiRpcClient(fake.child, { createRequestId: () => 'inventory-1' })
  const inventory = client.getExtensions()

  assert.equal(fake.stdin.read()?.toString('utf8'), '{"id":"inventory-1","type":"get_extensions"}\n')
  fake.stdout.write(`${JSON.stringify({
    type: 'response',
    id: 'inventory-1',
    success: true,
    data: {
      protocolVersion: 1,
      complete: true,
      loading: 'eager_complete',
      extensions: [
        { id: 'zeta@1', capabilities: ['tool', 'event'] },
        { id: 'alpha.extension', capabilities: ['shortcut', 'command'] }
      ],
      loadErrorCount: 0
    }
  })}\n`)

  assert.deepEqual(await inventory, {
    protocolVersion: 1,
    complete: true,
    loading: 'eager_complete',
    extensions: [
      { id: 'alpha.extension', capabilities: ['command', 'shortcut'] },
      { id: 'zeta@1', capabilities: ['event', 'tool'] }
    ],
    loadErrorCount: 0
  })
})

test('accepts exact inventory bounds, eager load errors, and lazy partial loading', async () => {
  const exactId = 'a'.repeat(128)
  const inventories = [
    {
      protocolVersion: 1,
      complete: false,
      loading: 'eager_complete',
      extensions: [
        { id: exactId, capabilities: ['entry_renderer'] },
        ...Array.from({ length: 255 }, (_, index) => ({
          id: `ext-${index}`,
          capabilities: [] as string[]
        }))
      ],
      loadErrorCount: 256
    },
    {
      protocolVersion: 1,
      complete: false,
      loading: 'lazy_partial',
      extensions: [],
      loadErrorCount: 0
    }
  ]

  for (const data of inventories) {
    const fake = createFakeProcess()
    const client = new PiRpcClient(fake.child)
    const inventory = client.getExtensions()
    const [request] = readRequests(fake.stdin)
    fake.stdout.write(`${JSON.stringify({ type: 'response', id: request?.id, success: true, data })}\n`)
    assert.deepEqual(await inventory, {
      ...data,
      extensions: [...data.extensions].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    })
  }
})

test('rejects unknown get_extensions properties and path-like extension IDs', async () => {
  const invalidData = [
    {
      protocolVersion: 1,
      complete: true,
      loading: 'eager_complete',
      extensions: [],
      loadErrorCount: 0,
      path: '/private/extensions'
    },
    {
      protocolVersion: 1,
      complete: false,
      loading: 'lazy_partial',
      extensions: [{ id: 'safe-id', capabilities: [], name: 'Private name' }],
      loadErrorCount: 0
    },
    {
      protocolVersion: 1,
      complete: false,
      loading: 'lazy_partial',
      extensions: [{ id: '../extension', capabilities: [] }],
      loadErrorCount: 0
    },
    {
      protocolVersion: 1,
      complete: false,
      loading: 'lazy_partial',
      extensions: [{ id: 'folder\\extension', capabilities: [] }],
      loadErrorCount: 0
    }
  ]

  for (const data of invalidData) {
    const fake = createFakeProcess()
    const client = new PiRpcClient(fake.child)
    const inventory = client.getExtensions()
    const [request] = readRequests(fake.stdin)
    fake.stdout.write(`${JSON.stringify({ type: 'response', id: request?.id, success: true, data })}\n`)
    await assert.rejects(inventory, /Invalid Pi RPC get_extensions response/)
  }
})

test('rejects duplicate, oversized, invalid capability, count, and consistency inventories', async () => {
  const base = {
    protocolVersion: 1,
    complete: false,
    loading: 'lazy_partial',
    extensions: [] as Array<{ id: string; capabilities: string[] }>,
    loadErrorCount: 0
  }
  const invalidData = [
    { ...base, extensions: [{ id: 'same', capabilities: [] }, { id: 'same', capabilities: [] }] },
    { ...base, extensions: [{ id: 'one', capabilities: ['event', 'event'] }] },
    { ...base, extensions: [{ id: 'one', capabilities: ['renderer'] }] },
    { ...base, extensions: [{ id: `a${'b'.repeat(128)}`, capabilities: [] }] },
    { ...base, extensions: Array.from({ length: 257 }, (_, index) => ({ id: `ext-${index}`, capabilities: [] })) },
    { ...base, loadErrorCount: 257 },
    { ...base, loadErrorCount: -1 },
    { ...base, loadErrorCount: 0.5 },
    { ...base, loadErrorCount: Number.MAX_SAFE_INTEGER + 1 },
    { ...base, complete: true },
    { ...base, loading: 'eager_complete' },
    { ...base, complete: true, loading: 'eager_complete', loadErrorCount: 1 },
    { ...base, protocolVersion: 2 }
  ]

  for (const data of invalidData) {
    const fake = createFakeProcess()
    const client = new PiRpcClient(fake.child)
    const inventory = client.getExtensions()
    const [request] = readRequests(fake.stdin)
    fake.stdout.write(`${JSON.stringify({ type: 'response', id: request?.id, success: true, data })}\n`)
    await assert.rejects(inventory, /Invalid Pi RPC get_extensions response/)
  }
})

test('get_extensions RPC failure rejects without fallback discovery', async () => {
  const fake = createFakeProcess()
  const client = new PiRpcClient(fake.child)
  const inventory = client.getExtensions()
  const [request] = readRequests(fake.stdin)

  fake.stdout.write(`${JSON.stringify({
    type: 'response',
    id: request?.id,
    success: false,
    error: 'Unknown command: get_extensions'
  })}\n`)

  await assert.rejects(inventory, /Pi RPC get_extensions failed: Unknown command: get_extensions/)
  assert.deepEqual(readRequests(fake.stdin), [])
})

test('uses unique IDs and correlates only matching response records', async () => {
  const fake = createFakeProcess()
  const client = new PiRpcClient(fake.child)
  const first = client.getState()
  const second = client.getState()
  const requests = readRequests(fake.stdin)

  assert.equal(requests.length, 2)
  assert.notEqual(requests[0]?.id, requests[1]?.id)

  fake.stdout.write(`${JSON.stringify({ type: 'event', id: requests[0]?.id, success: true, data: { ignored: true } })}\n`)
  fake.stdout.write(`${JSON.stringify({ type: 'response', id: requests[1]?.id, success: true, data: { sessionId: 'second' } })}\n`)
  fake.stdout.write(`${JSON.stringify({ type: 'response', id: requests[0]?.id, success: true, data: { sessionId: 'first' } })}\n`)

  assert.deepEqual(await second, { sessionId: 'second' })
  assert.deepEqual(await first, { sessionId: 'first' })
})

test('rejects a matching failure response', async () => {
  const fake = createFakeProcess()
  const client = new PiRpcClient(fake.child)
  const state = client.getState()
  const [request] = readRequests(fake.stdin)

  fake.stdout.write(`${JSON.stringify({ type: 'response', id: request?.id, success: false, error: 'offline' })}\n`)

  await assert.rejects(state, /Pi RPC get_state failed: offline/)
})

test('rejects and cleans up a timed out request', async () => {
  const fake = createFakeProcess()
  const client = new PiRpcClient(fake.child, { requestTimeoutMs: 10 })

  await assert.rejects(client.getState(), /Timed out waiting for Pi RPC response: get_state/)

  const [request] = readRequests(fake.stdin)
  fake.stdout.write(`${JSON.stringify({ type: 'response', id: request?.id, success: true, data: {} })}\n`)
})

test('keeps stderr out of JSON framing and reports it diagnostically', async () => {
  const fake = createFakeProcess()
  const diagnostics: PiRpcDiagnostic[] = []
  const client = new PiRpcClient(fake.child, { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) })
  const state = client.getState()
  const [request] = readRequests(fake.stdin)

  fake.stderr.write('{"type":"response","success":true}\n')
  fake.stdout.write(`${JSON.stringify({ type: 'response', id: request?.id, success: true, data: { sessionFile: '/tmp/session.jsonl' } })}\n`)

  assert.deepEqual(await state, { sessionFile: '/tmp/session.jsonl' })
  assert.deepEqual(diagnostics, [{ type: 'stderr', chunk: '{"type":"response","success":true}\n' }])
})

test('reports stdout parser errors and continues to a valid response', async () => {
  const fake = createFakeProcess()
  const diagnostics: PiRpcDiagnostic[] = []
  const client = new PiRpcClient(fake.child, { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) })
  const state = client.getState()
  const [request] = readRequests(fake.stdin)

  fake.stdout.write(`invalid\n${JSON.stringify({ type: 'response', id: request?.id, success: true, data: {} })}\n`)

  assert.deepEqual(await state, {})
  assert.equal(diagnostics[0]?.type, 'stdout-parse-error')
})

test('rejects all pending requests and reports process exit details', async () => {
  const fake = createFakeProcess()
  const diagnostics: PiRpcDiagnostic[] = []
  const client = new PiRpcClient(fake.child, { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) })
  const first = client.getState()
  const second = client.getState()

  fake.events.emit('exit', 7, null)

  await assert.rejects(first, /exited before responding with code 7/)
  await assert.rejects(second, /exited before responding with code 7/)
  assert.deepEqual(diagnostics, [{ type: 'process-exit', code: 7, signal: null }])
})

test('forwards asynchronous Pi events without confusing response correlation', async () => {
  const fake = createFakeProcess()
  const events: Array<Record<string, unknown>> = []
  const client = new PiRpcClient(fake.child, { onEvent: (event) => events.push(event) })
  const prompt = client.prompt('hello')
  const [request] = readRequests(fake.stdin)

  fake.stdout.write(`${JSON.stringify({ type: 'agent_start' })}\n`)
  fake.stdout.write(`${JSON.stringify({ type: 'response', id: request?.id, command: 'prompt', success: true })}\n`)

  await prompt
  assert.deepEqual(events, [{ type: 'agent_start' }])
})

test('maps the S5 command set and validates data-bearing responses', async () => {
  const fake = createFakeProcess()
  const client = new PiRpcClient(fake.child)
  const prompt = client.prompt('show status')
  const abort = client.abort()
  const messages = client.getMessages()
  const model = client.setModel('openai', 'gpt-test')
  const thinking = client.setThinkingLevel('high')
  const requests = readRequests(fake.stdin)

  for (const request of requests) {
    const data = request.type === 'get_messages'
      ? { messages: [{ role: 'user', content: 'hello', timestamp: 1 }] }
      : request.type === 'set_model'
        ? {
            id: 'gpt-test',
            provider: 'openai',
            name: 'GPT Test',
            thinkingLevelMap: {
              off: 'none',
              minimal: 'minimal',
              low: null,
              unknown: 'unknown'
            }
          }
        : undefined
    fake.stdout.write(`${JSON.stringify({
      type: 'response',
      id: request.id,
      command: request.type,
      success: true,
      ...(data === undefined ? {} : { data })
    })}\n`)
  }

  await Promise.all([prompt, abort, thinking])
  assert.deepEqual(await messages, [{ role: 'user', content: 'hello', timestamp: 1 }])
  assert.deepEqual(await model, {
    id: 'gpt-test',
    provider: 'openai',
    name: 'GPT Test',
    thinkingLevelMap: {
      off: 'none',
      minimal: 'minimal',
      low: null
    }
  })
  assert.deepEqual(requests.map((request) => request.type), [
    'prompt',
    'abort',
    'get_messages',
    'set_model',
    'set_thinking_level'
  ])
})

test('maps prompt, steer, and follow_up with optional native image payloads', async () => {
  const fake = createFakeProcess()
  const client = new PiRpcClient(fake.child)
  const image = { type: 'image' as const, mimeType: 'image/png', data: 'aGVsbG8=' }
  const prompt = client.prompt('Inspect the image', [image])
  const steer = client.steer('Change direction now', [image])
  const followUp = client.followUp('Summarize when finished', [image])
  const requests = readRequests(fake.stdin) as Array<Record<string, unknown> & {
    id: string
    type: string
  }>

  assert.deepEqual(requests.map(({ id: _id, ...request }) => request), [
    { type: 'prompt', message: 'Inspect the image', images: [image] },
    { type: 'steer', message: 'Change direction now', images: [image] },
    { type: 'follow_up', message: 'Summarize when finished', images: [image] }
  ])

  for (const request of requests) {
    fake.stdout.write(`${JSON.stringify({
      type: 'response',
      id: request.id,
      command: request.type,
      success: true
    })}\n`)
  }

  await Promise.all([prompt, steer, followUp])
})

test('keeps the legacy prompt payload unchanged without images', () => {
  const fake = createFakeProcess()
  const client = new PiRpcClient(fake.child, { createRequestId: () => 'request-prompt' })

  void client.prompt('Plain prompt')

  assert.equal(
    fake.stdin.read()?.toString('utf8'),
    '{"id":"request-prompt","type":"prompt","message":"Plain prompt"}\n'
  )
})

test('maps the S11 command set with exact payloads and retains safe command sourceInfo', async () => {
  const fake = createFakeProcess()
  const client = new PiRpcClient(fake.child)
  const commands = client.getCommands()
  const compact = client.compact('Preserve decisions')
  const compactWithoutInstructions = client.compact()
  const setSessionName = client.setSessionName('Release planning')
  const requests = readRequests(fake.stdin) as Array<Record<string, unknown> & { id: string; type: string }>

  assert.deepEqual(requests.map(({ id: _id, ...request }) => request), [
    { type: 'get_commands' },
    { type: 'compact', customInstructions: 'Preserve decisions' },
    { type: 'compact' },
    { type: 'set_session_name', name: 'Release planning' }
  ])

  for (const request of requests) {
    fake.stdout.write(`${JSON.stringify({
      type: 'response',
      id: request.id,
      success: true,
      ...(request.type === 'get_commands'
        ? {
            data: {
              commands: [
                {
                  name: 'review',
                  description: 'Review changes',
                  source: 'extension',
                  sourceInfo: {
                    path: '/private/extension.ts',
                    source: 'review-extension',
                    scope: 'project',
                    origin: 'top-level',
                    baseDir: '/private'
                  }
                },
                {
                  name: 'summarize',
                  source: 'skill',
                  sourceInfo: {
                    path: '/private/summarize/SKILL.md',
                    source: 'summarize',
                    scope: 'user',
                    origin: 'package',
                    baseDir: '/private/summarize'
                  }
                },
                {
                  name: 'skill:CTF•AI/ML 攻防',
                  description: 'AI/ML challenge skill',
                  source: 'skill',
                  sourceInfo: {
                    path: '/private/skill/SKILL.md',
                    source: 'CTF•AI/ML 攻防',
                    scope: 'temporary',
                    origin: 'top-level',
                    baseDir: '/private/skill'
                  }
                }
              ]
            }
          }
        : {})
    })}\n`)
  }

  assert.deepEqual(await commands, [
    {
      name: 'review',
      description: 'Review changes',
      source: 'extension',
      sourceInfo: { source: 'review-extension', scope: 'project', origin: 'top-level' }
    },
    {
      name: 'summarize',
      source: 'skill',
      sourceInfo: { source: 'summarize', scope: 'user', origin: 'package' }
    },
    {
      name: 'skill:CTF•AI/ML 攻防',
      description: 'AI/ML challenge skill',
      source: 'skill',
      sourceInfo: { source: 'CTF•AI/ML 攻防', scope: 'temporary', origin: 'top-level' }
    }
  ])
  await Promise.all([compact, compactWithoutInstructions, setSessionName])
})

test('rejects malformed get_commands responses', async () => {
  const validSourceInfo = { source: 'review', scope: 'project', origin: 'top-level' }
  const invalidData = [
    {},
    { commands: 'review' },
    { commands: [null] },
    { commands: [{ name: '', source: 'prompt', sourceInfo: validSourceInfo }] },
    { commands: [{ name: '/review', source: 'prompt', sourceInfo: validSourceInfo }] },
    {
      commands: [{
        name: 'review',
        description: 1,
        source: 'prompt',
        sourceInfo: validSourceInfo
      }]
    },
    { commands: [{ name: 'review', source: 'builtin', sourceInfo: validSourceInfo }] },
    {
      commands: [{
        name: 'review',
        source: 'prompt',
        sourceInfo: { source: 'review', scope: 'workspace', origin: 'top-level' }
      }]
    }
  ]

  for (const data of invalidData) {
    const fake = createFakeProcess()
    const client = new PiRpcClient(fake.child)
    const commands = client.getCommands()
    const [request] = readRequests(fake.stdin)
    fake.stdout.write(`${JSON.stringify({
      type: 'response',
      id: request?.id,
      success: true,
      data
    })}\n`)

    await assert.rejects(commands, /Invalid Pi RPC get_commands response/)
  }
})

test('gets available models and strips provider internals', async () => {
  const fake = createFakeProcess()
  const client = new PiRpcClient(fake.child)
  const models = client.getAvailableModels()
  const [request] = readRequests(fake.stdin)

  assert.equal(request?.type, 'get_available_models')
  fake.stdout.write(`${JSON.stringify({
    type: 'response',
    id: request?.id,
    success: true,
    data: {
      models: [{
        id: 'gpt-test',
        provider: 'openai',
        name: 'GPT Test',
        reasoning: true,
        thinkingLevelMap: {
          off: 'none',
          minimal: 'minimal',
          low: 'low',
          medium: 'medium',
          high: 'high',
          xhigh: null,
          max: null,
          unknown: 'unknown'
        },
        contextWindow: 128000,
        baseUrl: 'https://private.example',
        api: 'responses',
        cost: {
          input: 1,
          output: 4,
          cacheRead: 0.1,
          cacheWrite: 1.25,
          tiers: [{
            inputTokensAbove: 200000,
            input: 2,
            output: 8,
            cacheRead: 0.2,
            cacheWrite: 2.5,
            credential: 'tier-secret'
          }],
          currency: 'USD'
        },
        credential: 'secret'
      }]
    }
  })}\n`)

  assert.deepEqual(await models, [{
    id: 'gpt-test',
    provider: 'openai',
    name: 'GPT Test',
    reasoning: true,
    thinkingLevelMap: {
      off: 'none',
      minimal: 'minimal',
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: null,
      max: null
    },
    contextWindow: 128000,
    cost: {
      input: 1,
      output: 4,
      cacheRead: 0.1,
      cacheWrite: 1.25,
      tiers: [{
        inputTokensAbove: 200000,
        input: 2,
        output: 8,
        cacheRead: 0.2,
        cacheWrite: 2.5
      }]
    }
  }])
})

test('gets session token and context usage statistics', async () => {
  const fake = createFakeProcess()
  const client = new PiRpcClient(fake.child)
  const stats = client.getSessionStats()
  const [request] = readRequests(fake.stdin)

  assert.equal(request?.type, 'get_session_stats')
  fake.stdout.write(`${JSON.stringify({
    type: 'response',
    id: request?.id,
    success: true,
    data: {
      sessionFile: '/tmp/session.jsonl',
      sessionId: 'session-1',
      userMessages: 3,
      assistantMessages: 4,
      toolCalls: 5,
      toolResults: 5,
      totalMessages: 12,
      tokens: {
        input: 42000,
        output: 3600,
        cacheRead: 18000,
        cacheWrite: 2000,
        total: 65600
      },
      cost: 0.42,
      contextUsage: {
        tokens: 56000,
        contextWindow: 200000,
        percent: 28
      }
    }
  })}\n`)

  assert.deepEqual(await stats, {
    sessionFile: '/tmp/session.jsonl',
    sessionId: 'session-1',
    userMessages: 3,
    assistantMessages: 4,
    toolCalls: 5,
    toolResults: 5,
    totalMessages: 12,
    tokens: {
      input: 42000,
      output: 3600,
      cacheRead: 18000,
      cacheWrite: 2000,
      total: 65600
    },
    cost: 0.42,
    contextUsage: {
      tokens: 56000,
      contextWindow: 200000,
      percent: 28
    }
  })
})

test('rejects malformed get_session_stats responses', async () => {
  const valid = {
    sessionId: 'session-1',
    userMessages: 3,
    assistantMessages: 4,
    toolCalls: 5,
    toolResults: 5,
    totalMessages: 12,
    tokens: {
      input: 42000,
      output: 3600,
      cacheRead: 18000,
      cacheWrite: 2000,
      total: 65600
    },
    cost: 0.42,
    contextUsage: {
      tokens: 56000,
      contextWindow: 200000,
      percent: 28
    }
  }
  const invalidData = [
    { ...valid, userMessages: 1.5 },
    { ...valid, cost: -0.01 },
    { ...valid, tokens: { ...valid.tokens, input: Number.MAX_SAFE_INTEGER + 1 } },
    { ...valid, contextUsage: { ...valid.contextUsage, tokens: 1.5 } },
    { ...valid, contextUsage: { ...valid.contextUsage, contextWindow: 1.5 } },
    { ...valid, contextUsage: { ...valid.contextUsage, percent: -0.001 } }
  ]

  for (const data of invalidData) {
    const fake = createFakeProcess()
    const client = new PiRpcClient(fake.child)
    const stats = client.getSessionStats()
    const [request] = readRequests(fake.stdin)
    fake.stdout.write(`${JSON.stringify({ type: 'response', id: request?.id, success: true, data })}\n`)

    await assert.rejects(stats, /Invalid Pi RPC get_session_stats response/)
  }
})

test('accepts finite non-negative context percentages above 100', async () => {
  const fake = createFakeProcess()
  const client = new PiRpcClient(fake.child)
  const stats = client.getSessionStats()
  const [request] = readRequests(fake.stdin)

  fake.stdout.write(`${JSON.stringify({
    type: 'response',
    id: request?.id,
    success: true,
    data: {
      sessionId: 'session-1',
      userMessages: 1,
      assistantMessages: 1,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 2,
      tokens: { input: 120, output: 20, cacheRead: 0, cacheWrite: 0, total: 140 },
      cost: 0.01,
      contextUsage: { tokens: 128000, contextWindow: 100000, percent: 128 }
    }
  })}\n`)

  assert.equal((await stats).contextUsage?.percent, 128)
})

test('rejects malformed get_available_models responses', async () => {
  const invalidData = [
    {},
    { models: 'gpt-test' },
    { models: [null] },
    { models: [{ id: '', provider: 'openai' }] },
    { models: [{ id: 'gpt-test', provider: '' }] },
    { models: [{ id: ' ', provider: 'openai' }] },
    { models: [{ id: 'gpt-test', provider: ' ' }] },
    { models: [{ id: 'gpt-test', provider: 'openai', reasoning: 'yes' }] },
    { models: [{ id: 'gpt-test', provider: 'openai', thinkingLevelMap: { low: 1 } }] },
    { models: [{ id: 'gpt-test', provider: 'openai', contextWindow: 0 }] },
    { models: [{ id: 'gpt-test', provider: 'openai', contextWindow: 1.5 }] },
    { models: [{ id: 'gpt-test', provider: 'openai', contextWindow: Number.MAX_SAFE_INTEGER + 1 }] },
    { models: [{ id: 'gpt-test', provider: 'openai', cost: { input: 1 } }] },
    {
      models: [{
        id: 'gpt-test',
        provider: 'openai',
        cost: { input: -1, output: 1, cacheRead: 0, cacheWrite: 0 }
      }]
    },
    {
      models: [{
        id: 'gpt-test',
        provider: 'openai',
        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, tiers: {} }
      }]
    },
    {
      models: [{
        id: 'gpt-test',
        provider: 'openai',
        cost: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          tiers: [{
            inputTokensAbove: 1.5,
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0
          }]
        }
      }]
    },
    {
      models: [{
        id: 'gpt-test',
        provider: 'openai',
        cost: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          tiers: [{
            inputTokensAbove: 1,
            input: 1,
            output: Number.POSITIVE_INFINITY,
            cacheRead: 0,
            cacheWrite: 0
          }]
        }
      }]
    }
  ]

  for (const data of invalidData) {
    const fake = createFakeProcess()
    const client = new PiRpcClient(fake.child)
    const models = client.getAvailableModels()
    const [request] = readRequests(fake.stdin)
    fake.stdout.write(`${JSON.stringify({ type: 'response', id: request?.id, success: true, data })}\n`)

    await assert.rejects(models, /Invalid Pi RPC get_available_models response/)
  }
})

test('gets normalized entries without retaining image or non-user payloads', async () => {
  const fake = createFakeProcess()
  const client = new PiRpcClient(fake.child, { createRequestId: () => 'request-entries' })
  const entries = client.getEntries()

  assert.equal(
    fake.stdin.read()?.toString('utf8'),
    '{"id":"request-entries","type":"get_entries"}\n'
  )
  fake.stdout.write(`${JSON.stringify({
    type: 'response',
    id: 'request-entries',
    success: true,
    data: {
      leafId: 'assistant-1',
      entries: [
        {
          id: 'user-1',
          parentId: null,
          type: 'message',
          timestamp: '2026-07-24T01:00:00.000Z',
          message: {
            role: 'user',
            content: [
              { type: 'text', text: 'Inspect ' },
              { type: 'image', mimeType: 'image/png', data: 'large-private-payload' },
              { type: 'text', text: 'this' }
            ]
          }
        },
        {
          id: 'assistant-1',
          parentId: 'user-1',
          type: 'message',
          timestamp: '2026-07-24T01:00:01.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'private response' }] }
        },
        {
          id: 'branch-1',
          parentId: 'assistant-1',
          type: 'branch',
          timestamp: '2026-07-24T01:00:02.000Z',
          summary: 'private branch payload'
        },
        {
          id: 'advisor-capability-1',
          parentId: 'branch-1',
          type: 'custom',
          timestamp: '2026-07-24T01:00:03.000Z',
          customType: 'pi-gui.multi-advisor/capabilities',
          data: {
            protocolVersion: 1,
            identity: 'pi-gui-multi-advisor',
            enabled: true
          }
        },
        {
          id: 'unrelated-custom-1',
          parentId: 'advisor-capability-1',
          type: 'custom',
          timestamp: '2026-07-24T01:00:04.000Z',
          customType: 'third-party/private',
          data: { secret: 'do-not-retain' }
        },
        {
          id: 'magic-context-status-1',
          parentId: 'unrelated-custom-1',
          type: 'custom',
          timestamp: '2026-07-24T01:00:05.000Z',
          customType: 'ctx-status',
          data: {
            title: 'Dream complete',
            text: 'Embedded 4 memories.',
            level: 'success',
            details: { retainedForStrictProjection: true }
          }
        }
      ]
    }
  })}\n`)

  assert.deepEqual(await entries, {
    leafId: 'assistant-1',
    entries: [
      {
        id: 'user-1',
        parentId: null,
        type: 'message',
        timestamp: '2026-07-24T01:00:00.000Z',
        message: {
          role: 'user',
          content: { text: 'Inspect this', hasImage: true }
        }
      },
      {
        id: 'assistant-1',
        parentId: 'user-1',
        type: 'message',
        timestamp: '2026-07-24T01:00:01.000Z',
        message: { role: 'assistant' }
      },
      {
        id: 'branch-1',
        parentId: 'assistant-1',
        type: 'branch',
        timestamp: '2026-07-24T01:00:02.000Z'
      },
      {
        id: 'advisor-capability-1',
        parentId: 'branch-1',
        type: 'custom',
        timestamp: '2026-07-24T01:00:03.000Z',
        customType: 'pi-gui.multi-advisor/capabilities',
        data: {
          protocolVersion: 1,
          identity: 'pi-gui-multi-advisor',
          enabled: true
        }
      },
      {
        id: 'unrelated-custom-1',
        parentId: 'advisor-capability-1',
        type: 'custom',
        timestamp: '2026-07-24T01:00:04.000Z'
      },
      {
        id: 'magic-context-status-1',
        parentId: 'unrelated-custom-1',
        type: 'custom',
        timestamp: '2026-07-24T01:00:05.000Z',
        customType: 'ctx-status',
        data: {
          title: 'Dream complete',
          text: 'Embedded 4 memories.',
          level: 'success'
        }
      }
    ]
  })
  assert.equal(JSON.stringify(await Promise.resolve(entries)).includes('large-private-payload'), false)
  assert.equal(JSON.stringify(await Promise.resolve(entries)).includes('do-not-retain'), false)
  assert.equal(JSON.stringify(await Promise.resolve(entries)).includes('retainedForStrictProjection'), false)
})

test('rejects malformed get_entries responses and unknown user content blocks', async () => {
  const invalidData = [
    { entries: [], leafId: 1 },
    {
      entries: [{ id: '', parentId: null, type: 'message', timestamp: 'now', message: { role: 'user', content: '' } }],
      leafId: null
    },
    {
      entries: [{ id: 'entry-1', parentId: null, type: 'message', timestamp: 'now', message: {} }],
      leafId: null
    },
    {
      entries: [{
        id: 'entry-1',
        parentId: null,
        type: 'message',
        timestamp: 'now',
        message: { role: 'user', content: [{ type: 'audio', data: 'payload' }] }
      }],
      leafId: null
    },
    {
      entries: [{
        id: 'entry-1',
        parentId: null,
        type: 'message',
        timestamp: 'now',
        message: { role: 'user', content: [{ type: 'image', mimeType: 'image/png' }] }
      }],
      leafId: null
    }
  ]

  for (const data of invalidData) {
    const fake = createFakeProcess()
    const client = new PiRpcClient(fake.child)
    const entries = client.getEntries()
    const [request] = readRequests(fake.stdin)
    fake.stdout.write(`${JSON.stringify({ type: 'response', id: request?.id, success: true, data })}\n`)

    await assert.rejects(entries, /Invalid Pi RPC get_entries response/)
  }
})

test('forks an exact entry ID and validates the fork response', async () => {
  const fake = createFakeProcess()
  const client = new PiRpcClient(fake.child, { createRequestId: () => 'request-fork' })
  const fork = client.fork('entry-1')

  assert.equal(
    fake.stdin.read()?.toString('utf8'),
    '{"id":"request-fork","type":"fork","entryId":"entry-1"}\n'
  )
  fake.stdout.write(`${JSON.stringify({
    type: 'response',
    id: 'request-fork',
    success: true,
    data: { text: 'Original prompt', cancelled: false }
  })}\n`)
  assert.deepEqual(await fork, { text: 'Original prompt', cancelled: false })

  await assert.rejects(client.fork('  '), /entry ID must not be empty/)

  const malformed = client.fork('entry-2')
  const [request] = readRequests(fake.stdin)
  fake.stdout.write(`${JSON.stringify({
    type: 'response',
    id: request?.id,
    success: true,
    data: { text: 'Original prompt', cancelled: 'no' }
  })}\n`)
  await assert.rejects(malformed, /Invalid Pi RPC fork response/)
})

test('maps the P3 tree and extension commands with exact wire payloads and projected results', async () => {
  const fake = createFakeProcess()
  const client = new PiRpcClient(fake.child)

  const tree = client.getTree()
  const navigate = client.navigateTree('树/leaf•')
  const invoke = client.invokeExtensionCommand('扩展/status', 'alpha beta')
  const invokeWithoutArgs = client.invokeExtensionCommand('status')
  const subscribe = client.subscribeExtensionEvents(['频道/status', '频道/status', 'other'])
  const requests = readRequests(fake.stdin) as Array<Record<string, unknown> & {
    id: string
    type: string
  }>

  assert.deepEqual(requests.map(({ id: _id, ...request }) => request), [
    { type: 'get_tree' },
    { type: 'navigate_tree', targetEntryId: '树/leaf•' },
    { type: 'invoke_extension_command', name: '扩展/status', args: 'alpha beta' },
    { type: 'invoke_extension_command', name: 'status' },
    { type: 'subscribe_extension_events', channels: ['频道/status', 'other'] }
  ])

  respondSuccess(fake, requests[0]!, {
    tree: [{
      entry: treeEntry('root', null, {
        role: 'ignored',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'Inspect ' },
            { type: 'image', mimeType: 'image/png', data: 'private-base64' },
            { type: 'text', text: 'this' }
          ]
        }
      }),
      children: [{
        entry: treeEntry('provider-change', 'root', {
          type: 'model_change',
          provider: { id: 'private-provider', credential: 'secret' },
          modelId: 'private-model'
        }),
        children: [{
          entry: treeEntry('advisor', 'provider-change', {
            type: 'custom',
            customType: 'pi-gui.multi-advisor/capabilities',
            data: { image: { data: 'another-private-base64' }, provider: { credential: 'secret' } }
          }),
          children: []
        }]
      }],
      label: 'Pinned',
      labelTimestamp: '2026-07-29T00:00:01.000Z'
    }],
    leafId: 'advisor'
  })
  respondSuccess(fake, requests[1]!, {
    targetEntryId: '树/leaf•',
    cancelled: false,
    leafId: 'root',
    editorText: 'restored draft'
  })
  respondSuccess(fake, requests[2]!)
  respondSuccess(fake, requests[3]!)
  respondSuccess(fake, requests[4]!, { channels: ['频道/status', 'other'] })

  const treeResult = await tree
  assert.deepEqual(treeResult, {
    tree: [{
      entry: {
        id: 'root',
        parentId: null,
        type: 'message',
        timestamp: '2026-07-29T00:00:00.000Z',
        message: { role: 'user', content: { text: 'Inspect this', hasImage: true } }
      },
      children: [{
        entry: {
          id: 'provider-change',
          parentId: 'root',
          type: 'model_change',
          timestamp: '2026-07-29T00:00:00.000Z'
        },
        children: [{
          entry: {
            id: 'advisor',
            parentId: 'provider-change',
            type: 'custom',
            timestamp: '2026-07-29T00:00:00.000Z',
            customType: 'pi-gui.multi-advisor/capabilities'
          },
          children: []
        }]
      }],
      label: 'Pinned',
      labelTimestamp: '2026-07-29T00:00:01.000Z'
    }],
    leafId: 'advisor'
  })
  assert.equal(JSON.stringify(treeResult).includes('private-base64'), false)
  assert.equal(JSON.stringify(treeResult).includes('private-provider'), false)
  assert.equal(JSON.stringify(treeResult).includes('credential'), false)
  assert.deepEqual(await navigate, {
    targetEntryId: '树/leaf•',
    cancelled: false,
    leafId: 'root',
    editorText: 'restored draft'
  })
  await Promise.all([invoke, invokeWithoutArgs])
  assert.deepEqual(await subscribe, ['频道/status', 'other'])
})

test('accepts exact Pi identity, command args, and channel bounds and rejects the next value', async () => {
  const fake = createFakeProcess()
  const client = new PiRpcClient(fake.child)
  const target = `树${'x'.repeat(511)}`
  const commandName = `命${'x'.repeat(255)}`
  const args = 'a'.repeat(65_536)
  const channel = `频${'x'.repeat(255)}`
  const channels = [channel, ...Array.from({ length: 31 }, (_, index) => `channel-${index}`)]

  const navigate = client.navigateTree(target)
  const [navigateRequest] = readRequests(fake.stdin) as Array<Record<string, unknown> & {
    id: string
    type: string
  }>
  assert.equal((navigateRequest?.targetEntryId as string).length, 512)
  respondSuccess(fake, navigateRequest!, {
    targetEntryId: target,
    cancelled: true,
    leafId: null
  })
  await navigate

  const invoke = client.invokeExtensionCommand(commandName, args)
  const [invokeRequest] = readRequests(fake.stdin) as Array<Record<string, unknown> & {
    id: string
    type: string
  }>
  assert.equal((invokeRequest?.name as string).length, 256)
  assert.equal((invokeRequest?.args as string).length, 65_536)
  respondSuccess(fake, invokeRequest!)
  await invoke

  const subscribe = client.subscribeExtensionEvents(channels)
  const [subscribeRequest] = readRequests(fake.stdin) as Array<Record<string, unknown> & {
    id: string
    type: string
  }>
  assert.equal((subscribeRequest?.channels as string[]).length, 32)
  assert.equal((subscribeRequest?.channels as string[])[0]?.length, 256)
  respondSuccess(fake, subscribeRequest!, { channels })
  await subscribe

  const invalidIdentifiers = ['', ' bad ', 'bad\tname', 'x'.repeat(513)]
  for (const value of invalidIdentifiers) {
    await assert.rejects(client.navigateTree(value), /tree target entry ID/u)
  }
  const invalidNames = ['', ' bad ', 'bad\u007fname', 'x'.repeat(257)]
  for (const value of invalidNames) {
    await assert.rejects(client.invokeExtensionCommand(value), /extension command name/u)
  }
  await assert.rejects(
    client.invokeExtensionCommand('valid', 'x'.repeat(65_537)),
    /args exceed maximum length/u
  )
  await assert.rejects(
    client.subscribeExtensionEvents(Array.from({ length: 33 }, (_, index) => `channel-${index}`)),
    /channel count exceeds maximum/u
  )
  for (const value of ['', ' bad ', 'bad\nchannel', 'x'.repeat(257)]) {
    await assert.rejects(client.subscribeExtensionEvents([value]), /extension event channel/u)
  }
  assert.deepEqual(readRequests(fake.stdin), [])
})

test('strictly validates P3 response command identities and result shapes', async () => {
  const cases: Array<{
    start: (client: PiRpcClient) => Promise<unknown>
    response: (request: { id: string; type: string }) => Record<string, unknown>
    error: RegExp
  }> = [
    {
      start: (client) => client.getTree(),
      response: (request) => ({
        type: 'response', id: request.id, command: 'get_entries', success: true,
        data: { tree: [], leafId: null }
      }),
      error: /Invalid Pi RPC get_tree response/u
    },
    {
      start: (client) => client.getTree(),
      response: (request) => ({
        type: 'response', id: request.id, command: 'get_tree', success: true,
        data: { tree: [], leafId: null, entries: [] }
      }),
      error: /Invalid Pi RPC get_tree response/u
    },
    {
      start: (client) => client.navigateTree('target'),
      response: (request) => ({
        type: 'response', id: request.id, command: 'navigate_tree', success: true,
        data: { targetEntryId: 'other', cancelled: false, leafId: null }
      }),
      error: /Invalid Pi RPC navigate_tree response/u
    },
    {
      start: (client) => client.invokeExtensionCommand('status'),
      response: (request) => ({
        type: 'response', id: request.id, command: 'invoke_extension_command', success: true,
        data: {}
      }),
      error: /Invalid Pi RPC invoke_extension_command response/u
    },
    {
      start: (client) => client.subscribeExtensionEvents(['status']),
      response: (request) => ({
        type: 'response', id: request.id, command: 'subscribe_extension_events', success: true,
        data: { channels: ['status', 'status'] }
      }),
      error: /Invalid Pi RPC subscribe_extension_events response/u
    },
    {
      start: (client) => client.subscribeExtensionEvents(['status']),
      response: (request) => ({
        type: 'response', id: request.id, command: 'subscribe_extension_events', success: true,
        data: { channels: ['other'] }
      }),
      error: /Invalid Pi RPC subscribe_extension_events response/u
    }
  ]

  for (const item of cases) {
    const fake = createFakeProcess()
    const client = new PiRpcClient(fake.child)
    const result = item.start(client)
    const [request] = readRequests(fake.stdin)
    fake.stdout.write(`${JSON.stringify(item.response(request!))}\n`)
    await assert.rejects(result, item.error)
  }
})

test('projects tree depth, node count, label, and timestamp exact bounds iteratively', async () => {
  const exactDepthFake = createFakeProcess()
  const exactDepthClient = new PiRpcClient(exactDepthFake.child)
  const exactDepth = exactDepthClient.getTree()
  const [exactDepthRequest] = readRequests(exactDepthFake.stdin)
  respondSuccess(exactDepthFake, exactDepthRequest!, {
    tree: [deepTree(PI_RPC_TREE_MAX_DEPTH)],
    leafId: `entry-${PI_RPC_TREE_MAX_DEPTH - 1}`
  })
  let visited = 0
  const depthStack = [...(await exactDepth).tree]
  while (depthStack.length > 0) {
    const node = depthStack.pop()!
    visited += 1
    depthStack.push(...node.children)
  }
  assert.equal(visited, PI_RPC_TREE_MAX_DEPTH)

  const exactCountFake = createFakeProcess()
  const exactCountClient = new PiRpcClient(exactCountFake.child)
  const exactCount = exactCountClient.getTree()
  const [exactCountRequest] = readRequests(exactCountFake.stdin)
  const exactRoot: Record<string, unknown> = {
    entry: treeEntry('flat-0', null),
    children: Array.from({ length: PI_RPC_TREE_MAX_NODES - 1 }, (_, index) => ({
      entry: treeEntry(`flat-${index + 1}`, 'flat-0'),
      children: []
    })),
    label: 'l'.repeat(PI_RPC_TREE_MAX_LABEL_CHARS),
    labelTimestamp: 't'.repeat(PI_RPC_TREE_MAX_LABEL_TIMESTAMP_CHARS)
  }
  respondSuccess(exactCountFake, exactCountRequest!, {
    tree: [exactRoot],
    leafId: `flat-${PI_RPC_TREE_MAX_NODES - 1}`
  })
  const exactCountResult = await exactCount
  assert.equal(1 + exactCountResult.tree[0]!.children.length, PI_RPC_TREE_MAX_NODES)
  assert.equal(exactCountResult.tree[0]?.label?.length, PI_RPC_TREE_MAX_LABEL_CHARS)
  assert.equal(
    exactCountResult.tree[0]?.labelTimestamp?.length,
    PI_RPC_TREE_MAX_LABEL_TIMESTAMP_CHARS
  )

  const rejectedTrees = [
    { tree: [deepTree(PI_RPC_TREE_MAX_DEPTH + 1)], leafId: null },
    {
      tree: [{
        entry: treeEntry('over-0', null),
        children: Array.from({ length: PI_RPC_TREE_MAX_NODES }, (_, index) => ({
          entry: treeEntry(`over-${index + 1}`, 'over-0'),
          children: []
        }))
      }],
      leafId: null
    },
    {
      tree: [{
        entry: treeEntry('root', null), children: [],
        label: 'l'.repeat(PI_RPC_TREE_MAX_LABEL_CHARS + 1)
      }],
      leafId: 'root'
    },
    {
      tree: [{
        entry: treeEntry('root', null), children: [],
        labelTimestamp: 't'.repeat(PI_RPC_TREE_MAX_LABEL_TIMESTAMP_CHARS + 1)
      }],
      leafId: 'root'
    }
  ]
  for (const data of rejectedTrees) {
    const fake = createFakeProcess()
    const client = new PiRpcClient(fake.child)
    const result = client.getTree()
    const [request] = readRequests(fake.stdin)
    respondSuccess(fake, request!, data)
    await assert.rejects(result, /Invalid Pi RPC get_tree response/u)
  }
})

test('rejects duplicate, cyclic, inconsistent, malformed, and missing-leaf tree data', async () => {
  const invalidTrees = [
    {
      tree: [
        { entry: treeEntry('same', null), children: [] },
        { entry: treeEntry('same', null), children: [] }
      ],
      leafId: 'same'
    },
    {
      tree: [{
        entry: treeEntry('root', null),
        children: [{ entry: treeEntry('child', 'other-parent'), children: [] }]
      }],
      leafId: 'child'
    },
    {
      tree: [
        { entry: treeEntry('a', 'b'), children: [] },
        { entry: treeEntry('b', 'a'), children: [] }
      ],
      leafId: 'a'
    },
    {
      tree: [{ entry: treeEntry('self', 'self'), children: [] }],
      leafId: 'self'
    },
    {
      tree: [{ entry: treeEntry('root', null), children: [] }],
      leafId: 'missing'
    },
    {
      tree: [{ entry: treeEntry('root', null), children: [], raw: 'unexpected' }],
      leafId: 'root'
    },
    {
      tree: [{ entry: treeEntry(' bad ', null), children: [] }],
      leafId: null
    }
  ]

  for (const data of invalidTrees) {
    const fake = createFakeProcess()
    const client = new PiRpcClient(fake.child)
    const result = client.getTree()
    const [request] = readRequests(fake.stdin)
    respondSuccess(fake, request!, data)
    await assert.rejects(result, /Invalid Pi RPC get_tree response/u)
  }
})

test('accepts multiple canonical roots produced by branching from a root user entry', async () => {
  const fake = createFakeProcess()
  const client = new PiRpcClient(fake.child)
  const result = client.getTree()
  const [request] = readRequests(fake.stdin)
  respondSuccess(fake, request!, {
    tree: [
      { entry: treeEntry('old-root', null), children: [] },
      { entry: treeEntry('continued-root', null), children: [] }
    ],
    leafId: 'continued-root'
  })
  assert.deepEqual((await result).tree.map(({ entry }) => entry.id), [
    'old-root',
    'continued-root'
  ])
})

test('accepts documented orphan entries only as roots with a missing parent', async () => {
  const fake = createFakeProcess()
  const client = new PiRpcClient(fake.child)
  const result = client.getTree()
  const [request] = readRequests(fake.stdin)
  respondSuccess(fake, request!, {
    tree: [
      { entry: treeEntry('root', null), children: [] },
      { entry: treeEntry('orphan', 'missing-parent'), children: [] }
    ],
    leafId: 'orphan'
  })

  assert.deepEqual(await result, {
    tree: [
      {
        entry: {
          id: 'root', parentId: null, type: 'message',
          timestamp: '2026-07-29T00:00:00.000Z',
          message: { role: 'assistant' }
        },
        children: []
      },
      {
        entry: {
          id: 'orphan', parentId: 'missing-parent', type: 'message',
          timestamp: '2026-07-29T00:00:00.000Z',
          message: { role: 'assistant' }
        },
        children: []
      }
    ],
    leafId: 'orphan'
  })
})

test('drops pre-subscription extension spoofing while ordinary events remain separate', () => {
  const fake = createFakeProcess()
  const ordinaryEvents: Array<Record<string, unknown>> = []
  const extensionEvents: Array<Record<string, unknown>> = []
  const diagnostics: PiRpcDiagnostic[] = []
  new PiRpcClient(fake.child, {
    onEvent: (event) => ordinaryEvents.push(event),
    onExtensionEvent: (event) => extensionEvents.push(event),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
  })

  fake.stdout.write(
    `${JSON.stringify({ type: 'agent_start' })}\n` +
    `${JSON.stringify({ type: 'extension_event', channel: 'status', data: { spoofed: true } })}\n` +
    `${JSON.stringify({ type: 'extension_event_diagnostic', reason: 'queue_overflow' })}\n`
  )

  assert.deepEqual(ordinaryEvents, [{ type: 'agent_start' }])
  assert.deepEqual(extensionEvents, [])
  assert.deepEqual(diagnostics, [{
    type: 'extension-event-protocol-error',
    recordType: 'extension_event'
  }])
})

test('installs exact subscriptions in record order and enforces replacement and reset', async () => {
  const fake = createFakeProcess()
  const extensionEvents: Array<Record<string, unknown>> = []
  const diagnostics: PiRpcDiagnostic[] = []
  const client = new PiRpcClient(fake.child, {
    onExtensionEvent: (event) => extensionEvents.push(event),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
  })

  const first = client.subscribeExtensionEvents(['old'])
  const [firstRequest] = readRequests(fake.stdin)
  fake.stdout.write(
    `${JSON.stringify({
      type: 'response', id: firstRequest?.id, command: 'subscribe_extension_events',
      success: true, data: { channels: ['old'] }
    })}\n` +
    `${JSON.stringify({ type: 'extension_event', channel: 'old', data: { order: 1 } })}\n` +
    `${JSON.stringify({ type: 'extension_event', channel: 'other', data: { spoofed: true } })}\n`
  )
  assert.deepEqual(await first, ['old'])

  const replacement = client.subscribeExtensionEvents(['new'])
  const [replacementRequest] = readRequests(fake.stdin)
  fake.stdout.write(`${JSON.stringify({
    type: 'extension_event', channel: 'old', data: { duringReplacement: true }
  })}\n`)
  await assert.rejects(
    client.subscribeExtensionEvents(['concurrent']),
    /replacement is already in progress/u
  )
  fake.stdout.write(
    `${JSON.stringify({
      type: 'response', id: replacementRequest?.id, command: 'subscribe_extension_events',
      success: true, data: { channels: ['new'] }
    })}\n` +
    `${JSON.stringify({ type: 'extension_event', channel: 'old', data: { stale: true } })}\n` +
    `${JSON.stringify({ type: 'extension_event', channel: 'new', data: { order: 2 } })}\n` +
    `${JSON.stringify({ type: 'extension_event_diagnostic', reason: 'queue_overflow' })}\n`
  )
  assert.deepEqual(await replacement, ['new'])

  const reset = client.subscribeExtensionEvents([])
  const [resetRequest] = readRequests(fake.stdin)
  fake.stdout.write(
    `${JSON.stringify({
      type: 'response', id: resetRequest?.id, command: 'subscribe_extension_events',
      success: true, data: { channels: [] }
    })}\n` +
    `${JSON.stringify({ type: 'extension_event', channel: 'new', data: { afterReset: true } })}\n` +
    `${JSON.stringify({ type: 'extension_event_diagnostic', reason: 'record_too_large' })}\n`
  )
  assert.deepEqual(await reset, [])

  assert.deepEqual(extensionEvents, [
    { type: 'extension_event', channel: 'old', data: { order: 1 } },
    { type: 'extension_event', channel: 'new', data: { order: 2 } },
    { type: 'extension_event_diagnostic', reason: 'queue_overflow' }
  ])
  assert.equal(
    diagnostics.every((diagnostic) => diagnostic.type === 'extension-event-protocol-error'),
    true
  )
})

test('failed or unsupported subscription replacement stays fail-closed', async () => {
  const fake = createFakeProcess()
  const extensionEvents: Array<Record<string, unknown>> = []
  const diagnostics: PiRpcDiagnostic[] = []
  const client = new PiRpcClient(fake.child, {
    onExtensionEvent: (event) => extensionEvents.push(event),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
  })

  const initial = client.subscribeExtensionEvents(['old'])
  const [initialRequest] = readRequests(fake.stdin)
  respondSuccess(fake, initialRequest!, { channels: ['old'] })
  await initial

  const replacement = client.subscribeExtensionEvents(['new'])
  const [replacementRequest] = readRequests(fake.stdin)
  fake.stdout.write(`${JSON.stringify({
    type: 'response', id: replacementRequest?.id, command: 'subscribe_extension_events',
    success: false, error: 'Unknown command: subscribe_extension_events'
  })}\n`)
  await assert.rejects(replacement, /Unknown command: subscribe_extension_events/u)

  fake.stdout.write(
    `${JSON.stringify({ type: 'extension_event', channel: 'old', data: { stale: true } })}\n` +
    `${JSON.stringify({ type: 'extension_event', channel: 'new', data: { spoofed: true } })}\n` +
    `${JSON.stringify({ type: 'extension_event_diagnostic', reason: 'queue_overflow' })}\n`
  )

  const malformedReplacement = client.subscribeExtensionEvents(['another'])
  const [malformedRequest] = readRequests(fake.stdin)
  respondSuccess(fake, malformedRequest!, { channels: ['wrong'] })
  await assert.rejects(malformedReplacement, /Invalid Pi RPC subscribe_extension_events response/u)
  fake.stdout.write(`${JSON.stringify({
    type: 'extension_event', channel: 'wrong', data: { afterMalformedResponse: true }
  })}\n`)

  assert.deepEqual(extensionEvents, [])
  assert.deepEqual(diagnostics, [
    { type: 'extension-event-protocol-error', recordType: 'extension_event' },
    { type: 'extension-event-protocol-error', recordType: 'extension_event' }
  ])
})

test('strictly validates active extension envelopes without echoing malformed data', async () => {
  const fake = createFakeProcess()
  const ordinaryEvents: Array<Record<string, unknown>> = []
  const extensionEvents: Array<Record<string, unknown>> = []
  const diagnostics: PiRpcDiagnostic[] = []
  const client = new PiRpcClient(fake.child, {
    onEvent: (event) => ordinaryEvents.push(event),
    onExtensionEvent: (event) => extensionEvents.push(event),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
  })
  const subscription = client.subscribeExtensionEvents(['状态/v1'])
  const [request] = readRequests(fake.stdin)
  respondSuccess(fake, request!, { channels: ['状态/v1'] })
  await subscription
  const secret = 'secret-extension-payload-that-must-not-be-diagnosed'

  fake.stdout.write(`${JSON.stringify({ type: 'agent_start' })}\n`)
  fake.stdout.write(`${JSON.stringify({
    type: 'extension_event', channel: '状态/v1',
    data: { nested: [true, null, { secret }] }
  })}\n`)
  const malformed = [
    { type: 'extension_event', channel: '状态/v1' },
    { type: 'extension_event', channel: ' bad ', data: { secret } },
    { type: 'extension_event', channel: '状态/v1', data: { secret }, extra: true },
    { type: 'extension_event_diagnostic', reason: 'other', data: { secret } }
  ]
  for (const event of malformed) fake.stdout.write(`${JSON.stringify(event)}\n`)

  assert.deepEqual(ordinaryEvents, [{ type: 'agent_start' }])
  assert.deepEqual(extensionEvents, [{
    type: 'extension_event',
    channel: '状态/v1',
    data: { nested: [true, null, { secret }] }
  }])
  assert.deepEqual(diagnostics, [{
    type: 'extension-event-protocol-error',
    recordType: 'extension_event'
  }])
  assert.equal(JSON.stringify(diagnostics).includes(secret), false)
  assert.equal(JSON.stringify(ordinaryEvents).includes(secret), false)
})

test('accepts the exact 256 KiB raw extension record edge and rejects the next byte', async () => {
  const fake = createFakeProcess()
  const extensionEvents: Array<Record<string, unknown>> = []
  const diagnostics: PiRpcDiagnostic[] = []
  const client = new PiRpcClient(fake.child, {
    onExtensionEvent: (event) => extensionEvents.push(event),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
  })
  const subscribe = async (): Promise<void> => {
    const result = client.subscribeExtensionEvents(['status'])
    const [request] = readRequests(fake.stdin)
    respondSuccess(fake, request!, { channels: ['status'] })
    await result
  }
  const paddedRecord = (value: Record<string, unknown>, byteLength: number): string => {
    const json = JSON.stringify(value)
    const padding = byteLength - Buffer.byteLength(`${json}\n`)
    assert.ok(padding >= 0)
    return `${json}${' '.repeat(padding)}\n`
  }

  await subscribe()
  fake.stdout.write(paddedRecord({
    type: 'extension_event', channel: 'status', data: { edge: true }
  }, PI_RPC_EXTENSION_EVENT_MAX_RECORD_BYTES))
  fake.stdout.write(paddedRecord({
    type: 'extension_event', channel: 'status', data: { over: true }
  }, PI_RPC_EXTENSION_EVENT_MAX_RECORD_BYTES + 1))

  await subscribe()
  fake.stdout.write(paddedRecord({
    type: 'extension_event_diagnostic', reason: 'queue_overflow'
  }, PI_RPC_EXTENSION_EVENT_MAX_RECORD_BYTES))
  fake.stdout.write(paddedRecord({
    type: 'extension_event_diagnostic', reason: 'record_too_large'
  }, PI_RPC_EXTENSION_EVENT_MAX_RECORD_BYTES + 1))

  assert.deepEqual(extensionEvents, [
    { type: 'extension_event', channel: 'status', data: { edge: true } },
    { type: 'extension_event_diagnostic', reason: 'queue_overflow' }
  ])
  assert.deepEqual(diagnostics, [
    { type: 'extension-event-protocol-error', recordType: 'extension_event' },
    { type: 'extension-event-protocol-error', recordType: 'extension_event_diagnostic' }
  ])
})

test('drops buffered extension stdout after process exit', async () => {
  const fake = createFakeProcess()
  const extensionEvents: Array<Record<string, unknown>> = []
  const client = new PiRpcClient(fake.child, {
    onExtensionEvent: (event) => extensionEvents.push(event)
  })
  const subscription = client.subscribeExtensionEvents(['status'])
  const [request] = readRequests(fake.stdin)
  respondSuccess(fake, request!, { channels: ['status'] })
  await subscription

  fake.events.emit('exit', 0, null)
  fake.stdout.write(`${JSON.stringify({
    type: 'extension_event', channel: 'status', data: { buffered: true }
  })}\n`)

  assert.deepEqual(extensionEvents, [])
})
