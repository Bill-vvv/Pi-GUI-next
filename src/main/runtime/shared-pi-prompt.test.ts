import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createGzip } from 'node:zlib'

import type { PiRpcEvent } from '../pi-rpc/pi-rpc-client.ts'
import type { RuntimeHost } from './runtime-host.ts'
import { SharedPiHost } from './shared-pi-host.ts'

async function promptAndDrain(runtime: RuntimeHost, message: string): Promise<PiRpcEvent[]> {
  const events: PiRpcEvent[] = []
  let resolveEnded!: () => void
  let rejectEnded!: (error: Error) => void
  const ended = new Promise<void>((resolve, reject) => {
    resolveEnded = resolve
    rejectEnded = reject
  })
  const timeout = setTimeout(() => rejectEnded(new Error('SDK prompt did not finish.')), 15_000)
  const unsubscribe = runtime.subscribe((event) => {
    if (event.type !== 'pi-event') return
    events.push(event.event)
    if (event.event.type === 'agent_end') resolveEnded()
  })
  try {
    const [result] = await Promise.all([
      runtime.send({ type: 'prompt', message }),
      ended
    ])
    assert.deepEqual(result, { type: 'accepted' })
    return events
  } finally {
    clearTimeout(timeout)
    unsubscribe()
  }
}

async function sessionState(runtime: RuntimeHost) {
  const result = await runtime.send({ type: 'get_state' })
  assert.equal(result.type, 'state')
  if (result.type !== 'state') throw new Error('Expected SDK Session state.')
  assert.equal(typeof result.state.sessionFile, 'string')
  assert.equal(typeof result.state.sessionId, 'string')
  return result.state
}

async function messages(runtime: RuntimeHost) {
  const result = await runtime.send({ type: 'get_messages' })
  assert.equal(result.type, 'messages')
  if (result.type !== 'messages') throw new Error('Expected SDK messages.')
  // Compare persisted JSON content; JSONL omits optional undefined properties.
  return JSON.parse(JSON.stringify(result.messages)) as unknown[]
}

test('real SDK prompts honor Host proxy settings and preserve concurrent tools, forks and restart history', { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-shared-prompt-'))
  const agentDir = join(root, 'agent')
  const projects = [join(root, 'first'), join(root, 'second')]
  const contents = ['first-project-only', 'second-project-only']
  const provider = 'pi-gui-local-acceptance'
  const modelId = 'fixture-model'
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  const proxyKeys = ['http_proxy', 'https_proxy', 'no_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'] as const
  const previousProxy = Object.fromEntries(proxyKeys.map((key) => [key, process.env[key]]))
  let host!: SharedPiHost
  const requests: { prompt: string; phase: 'tool' | 'answer' }[] = []
  const serverErrors: unknown[] = []
  let releaseConcurrent!: () => void
  const concurrentPrompts = new Promise<void>((resolve) => { releaseConcurrent = resolve })
  let firstRequests = 0

  // Only the model endpoint is a fixture. Pi creates the request, consumes SSE,
  // executes its built-in read tool, and writes its real JSONL Session files.
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/health') {
        response.end('direct-local-request')
        return
      }
      assert.equal(request.method, 'POST')
      assert.equal(request.url, '/v1/chat/completions')
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        model: string
        stream: boolean
        messages: { role: string; content: string | { type: string; text: string }[]; tool_call_id?: string }[]
        tools: { function: { name: string } }[]
      }
      assert.equal(body.model, modelId)
      assert.equal(body.stream, true)
      assert.ok(body.tools.some((tool) => tool.function.name === 'read'))
      const last = body.messages.at(-1)!
      const userContent = body.messages.findLast((message) => message.role === 'user')!.content
      const prompt = typeof userContent === 'string' ? userContent : userContent.map((part) => part.text).join('')
      const phase = last.role === 'tool' ? 'answer' : 'tool'
      requests.push({ prompt, phase })
      if (phase === 'tool') {
        assert.equal(last.role, 'user')
        // Both Sessions must be in flight before either can receive a response.
        if (++firstRequests === 2) releaseConcurrent()
        await concurrentPrompts
      } else {
        assert.equal(typeof last.content, 'string')
        assert.ok(contents.includes(last.content as string))
        assert.equal(last.tool_call_id, 'read_fixture')
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Content-Encoding': 'gzip' })
      const stream = createGzip()
      stream.pipe(response)
      const emit = (delta: unknown, finishReason: string | null = null) => {
        stream.write(`data: ${JSON.stringify({
          id: 'local-fixture', object: 'chat.completion.chunk', created: 1, model: modelId,
          choices: [{ index: 0, delta, finish_reason: finishReason }]
        })}\n\n`)
      }
      emit({ role: 'assistant', content: '' })
      if (phase === 'tool') {
        emit({ tool_calls: [{ index: 0, id: 'read_fixture', type: 'function', function: { name: 'read', arguments: '{"path":' } }] })
        emit({ tool_calls: [{ index: 0, function: { arguments: '"probe.txt"}' } }] })
        emit({}, 'tool_calls')
      } else {
        emit({ content: 'verified:' })
        emit({ content: last.content })
        emit({}, 'stop')
      }
      stream.end('data: [DONE]\n\n')
    } catch (error) {
      serverErrors.push(error)
      response.writeHead(500, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'Local acceptance fixture rejected the request.' } }))
    }
  })
  const tunnels: string[] = []
  const proxy = createServer()
  const sockets = new Set<import('node:net').Socket>()
  proxy.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  proxy.on('connect', (request, socket, head) => {
    tunnels.push(request.url!)
    // .invalid cannot resolve directly; only this local proxy knows the fixture.
    if (request.url !== 'pi-gui-model.invalid:80') {
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
      return
    }
    const address = server.address()
    assert.ok(address !== null && typeof address === 'object')
    const upstream = connect(address.port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      socket.pipe(upstream).pipe(socket)
    })
    upstream.on('error', (error) => { serverErrors.push(error); socket.destroy() })
    socket.on('error', (error) => { serverErrors.push(error); upstream.destroy() })
    socket.on('close', () => upstream.destroy())
  })
  t.after(async () => {
    try {
      await host?.dispose()
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => proxy.close((error) => error ? reject(error) : resolve()))
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir
      for (const key of proxyKeys) {
        if (previousProxy[key] === undefined) delete process.env[key]
        else process.env[key] = previousProxy[key]
      }
      await rm(root, { recursive: true, force: true })
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address !== null && typeof address !== 'string')
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  const proxyAddress = proxy.address()
  assert.ok(proxyAddress !== null && typeof proxyAddress !== 'string')
  await Promise.all([agentDir, ...projects].map((directory) => mkdir(directory, { recursive: true })))
  await Promise.all([
    ...projects.map((project, index) => writeFile(join(project, 'probe.txt'), contents[index]!)),
    writeFile(join(agentDir, 'settings.json'), JSON.stringify({
      defaultProvider: provider, defaultModel: modelId,
      compaction: { enabled: false }, retry: { enabled: false }
    })),
    writeFile(join(agentDir, 'models.json'), JSON.stringify({
      providers: {
        [provider]: {
          baseUrl: 'http://pi-gui-model.invalid/v1', api: 'openai-completions', apiKey: 'local-fixture-only',
          models: [{ id: modelId, reasoning: false, input: ['text'], contextWindow: 32_000, maxTokens: 1_024 }]
        }
      }
    }))
  ])
  process.env.PI_CODING_AGENT_DIR = agentDir
  for (const key of proxyKeys) delete process.env[key]
  process.env.HTTP_PROXY = `http://127.0.0.1:${proxyAddress.port}`
  process.env.HTTPS_PROXY = process.env.HTTP_PROXY
  process.env.NO_PROXY = '127.0.0.1'
  host = new SharedPiHost()
  assert.equal(await (await fetch(`http://127.0.0.1:${address.port}/health`)).text(), 'direct-local-request')
  assert.deepEqual(tunnels, [])
  const runtimes = projects.map((cwd) => host.createRuntime({ cwd, projectTrust: true, extensionPaths: [] }))
  await Promise.all(runtimes.map(async (runtime) => {
    await runtime.start()
    const selected = await runtime.send({ type: 'set_model', provider, modelId })
    assert.equal(selected.type, 'model')
  }))
  const started = performance.now()
  const eventLists = await Promise.all(runtimes.map((runtime, index) => promptAndDrain(runtime, `initial-${index}`)))
  assert.deepEqual(serverErrors, [])
  assert.ok(tunnels.length > 0)
  assert.ok(tunnels.every((authority) => authority === 'pi-gui-model.invalid:80'))
  for (const [index, events] of eventLists.entries()) {
    assert.equal(events.filter((event) => event.type === 'agent_start').length, 1)
    assert.equal(events.filter((event) => event.type === 'agent_end').length, 1)
    const toolEnd = events.filter((event) => event.type === 'tool_execution_end')
    assert.equal(toolEnd.length, 1)
    assert.equal(toolEnd[0]!.isError, false)
    assert.deepEqual((toolEnd[0]!.result as { content: unknown }).content, [{ type: 'text', text: contents[index] }])
    assert.ok(events.some((event) => event.type === 'message_update'))
    const transcript = await messages(runtimes[index]!)
    assert.deepEqual(transcript.map((message) => (message as { role: string }).role), ['user', 'assistant', 'toolResult', 'assistant'])
    assert.deepEqual((transcript.at(-1) as { content: unknown }).content, [{ type: 'text', text: `verified:${contents[index]}` }])
  }
  const [first, second] = runtimes as [RuntimeHost, RuntimeHost]
  const [original, other] = await Promise.all(runtimes.map(sessionState))
  assert.equal(original!.isStreaming, false)
  assert.equal(other!.isStreaming, false)
  assert.notEqual(original!.sessionId, other!.sessionId)
  assert.notEqual(original!.sessionFile, other!.sessionFile)
  const originalHistory = await messages(first)
  const otherHistory = await messages(second)
  const originalFile = await readFile(original!.sessionFile!, 'utf8')
  const entries = await first.send({ type: 'get_entries' })
  assert.ok(entries.type === 'entries')
  const selected = entries.entries.find((entry) => entry.message?.role === 'user')!
  assert.ok(selected)
  assert.deepEqual(await first.send({ type: 'fork', entryId: selected.id }), { type: 'forked', text: 'initial-0', cancelled: false })
  const forked = await sessionState(first)
  assert.notEqual(forked.sessionId, original!.sessionId)
  assert.notEqual(forked.sessionFile, original!.sessionFile)
  assert.deepEqual(await messages(first), [])
  // The SDK intentionally leaves a first-message fork provisional until an answer.
  await assert.rejects(readFile(forked.sessionFile!, 'utf8'), { code: 'ENOENT' })
  await promptAndDrain(first, 'fork-0')
  const forkHistory = await messages(first)
  assert.equal(await readFile(original!.sessionFile!, 'utf8'), originalFile)
  assert.deepEqual(await messages(second), otherHistory)

  // Recreate the owner, so recovery must use files rather than live SDK objects.
  await host.dispose()
  host = new SharedPiHost()
  const restored = [original!, forked, other!].map((state, index) => host.createRuntime({
    cwd: projects[index === 2 ? 1 : 0]!, sessionFile: state.sessionFile!, projectTrust: true, extensionPaths: []
  }))
  await Promise.all(restored.map((runtime) => runtime.start()))
  assert.deepEqual(await Promise.all(restored.map(messages)), [originalHistory, forkHistory, otherHistory])
  assert.deepEqual((await Promise.all(restored.map(sessionState))).map((state) => state.sessionId), [original!.sessionId, forked.sessionId, other!.sessionId])
  await promptAndDrain(restored[1]!, 'restored-fork-0')
  assert.equal((await messages(restored[1]!)).length, forkHistory.length + 4)
  assert.deepEqual(await messages(restored[0]!), originalHistory)
  assert.deepEqual(await messages(restored[2]!), otherHistory)
  assert.deepEqual(serverErrors, [])
  assert.equal(requests.length, 8)
  for (const prompt of ['initial-0', 'initial-1', 'fork-0', 'restored-fork-0']) {
    assert.deepEqual(requests.filter((request) => request.prompt === prompt).map((request) => request.phase), ['tool', 'answer'])
  }
  t.diagnostic(JSON.stringify({ prompts: 4, modelRequests: requests.length, toolExecutions: 4, restoredSessions: 3, durationMs: Math.round(performance.now() - started) }))
})
