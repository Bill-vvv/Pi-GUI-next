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
