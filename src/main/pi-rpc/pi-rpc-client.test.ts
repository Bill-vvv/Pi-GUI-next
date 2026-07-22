import assert from 'node:assert/strict'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { PiRpcClient, type PiRpcDiagnostic } from './pi-rpc-client.ts'

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

test('serializes get_state as JSON followed by exactly one LF', () => {
  const fake = createFakeProcess()
  const client = new PiRpcClient(fake.child, { createRequestId: () => 'request-1' })

  void client.getState()

  assert.equal(fake.stdin.read()?.toString('utf8'), '{"id":"request-1","type":"get_state"}\n')
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
        ? { id: 'gpt-test', provider: 'openai', name: 'GPT Test' }
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
  assert.deepEqual(await model, { id: 'gpt-test', provider: 'openai', name: 'GPT Test' })
  assert.deepEqual(requests.map((request) => request.type), [
    'prompt',
    'abort',
    'get_messages',
    'set_model',
    'set_thinking_level'
  ])
})

test('maps the S11 command set with exact payloads and strips command sourceInfo', async () => {
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
                  sourceInfo: { path: '/private/extension.ts' }
                },
                { name: 'summarize', source: 'skill' }
              ]
            }
          }
        : {})
    })}\n`)
  }

  assert.deepEqual(await commands, [
    { name: 'review', description: 'Review changes', source: 'extension' },
    { name: 'summarize', source: 'skill' }
  ])
  await Promise.all([compact, compactWithoutInstructions, setSessionName])
})

test('rejects malformed get_commands responses', async () => {
  const invalidData = [
    {},
    { commands: 'review' },
    { commands: [null] },
    { commands: [{ name: '', source: 'prompt' }] },
    { commands: [{ name: '/review', source: 'prompt' }] },
    { commands: [{ name: 'code review', source: 'prompt' }] },
    { commands: [{ name: 'review', description: 1, source: 'prompt' }] },
    { commands: [{ name: 'review', source: 'builtin' }] }
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
          max: null
        },
        contextWindow: 128000,
        baseUrl: 'https://private.example',
        api: 'responses',
        cost: { input: 1 },
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
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: null,
      max: null
    },
    contextWindow: 128000
  }])
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
    { models: [{ id: 'gpt-test', provider: 'openai', thinkingLevelMap: { low: 1 } }] }
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
