import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createGzip } from 'node:zlib'

import type { PiRpcEvent } from '../pi-rpc/pi-rpc-data.ts'
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
    // Disposing ModelRuntime closes idle CONNECT sockets with a reset in Undici 8.
    // Request failures are still checked by the model fixture and transcript assertions.
    const disconnect = (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ECONNRESET') serverErrors.push(error)
      socket.destroy()
      upstream.destroy()
    }
    upstream.on('error', disconnect)
    socket.on('error', disconnect)
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
    assert.ok(events.some((event) => event.type === 'message_update' &&
      (event.message as { role?: string } | undefined)?.role === 'assistant'))
    const transcript = await messages(runtimes[index]!)
    assert.deepEqual(transcript.map((message) => (message as { role: string }).role), ['system', 'user', 'assistant', 'toolResult', 'assistant'])
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
  assert.deepEqual((await messages(first)).map((message) => (message as { role: string }).role), ['system'])
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

test('native Task executes SDK tools in a background child, continues and stops with durable history', { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-native-task-'))
  const agentDir = join(root, 'agent')
  const project = join(root, 'project')
  const legacyExecutor = join(root, 'pi-subagents')
  const projectConfig = join(project, '.pi')
  const provider = 'pi-native-local-acceptance'
  const modelId = 'fixture-model'
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  const proxyKeys = ['http_proxy', 'https_proxy', 'no_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'] as const
  const previousProxy = Object.fromEntries(proxyKeys.map((key) => [key, process.env[key]]))
  let host!: SharedPiHost
  let releaseChild!: () => void
  const childGate = new Promise<void>((resolve) => { releaseChild = resolve })
  let markChildHeld!: () => void
  const childHeld = new Promise<void>((resolve) => { markChildHeld = resolve })
  let releaseHeld!: () => void
  const heldGate = new Promise<void>((resolve) => { releaseHeld = resolve })
  const serverErrors: unknown[] = []
  let parentReports = 0
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        messages: { role: string; content: string | { text: string }[]; tool_call_id?: string }[]
        tools: { function: { name: string } }[]
      }
      const last = body.messages.at(-1)!
      const text = (message: typeof last) => typeof message.content === 'string' ? message.content : message.content.map(({ text }) => text).join('')
      const user = body.messages.findLast(({ role }) => role === 'user')!
      const prompt = text(user)
      let tool: { name: string; arguments: string } | null = null
      let answer = 'parent-started'
      if (last.role !== 'tool' && prompt === 'delegate') {
        assert.ok(body.tools.some(({ function: fn }) => fn.name === 'Task'))
        tool = { name: 'Task', arguments: JSON.stringify({ task: 'child-read', agent: 'worker' }) }
      } else if (last.role !== 'tool' && prompt === 'collaborate') {
        assert.ok(body.tools.some(({ function: fn }) => fn.name === 'SessionTask'))
        tool = { name: 'SessionTask', arguments: JSON.stringify({ action: 'list' }) }
      } else if (last.role === 'tool' && last.tool_call_id === 'native_session_task') {
        assert.deepEqual(JSON.parse(text(last)), { kind: 'sessions', sessions: [] })
        answer = 'session-list-received'
      } else if (last.role !== 'tool' && prompt.startsWith('child-read')) {
        assert.ok(body.tools.some(({ function: fn }) => fn.name === 'read'))
        if (prompt === 'child-read') await childGate
        tool = { name: 'read', arguments: JSON.stringify({ path: 'probe.txt' }) }
      } else if (last.role !== 'tool' && prompt === 'child-nested') {
        tool = { name: 'Task', arguments: JSON.stringify({ task: 'child-read-grandchild', agent: 'worker' }) }
      } else if (prompt === 'child-hold') {
        markChildHeld()
        response.on('close', releaseHeld)
        await heldGate
        if (response.destroyed) return
        answer = 'held-task-finished'
      } else if (last.role === 'tool' && last.tool_call_id === 'native_read') {
        assert.equal(text(last), 'native-child-project')
        answer = `child-report:${prompt}`
      } else if (prompt.includes('Background task')) {
        parentReports += 1
        answer = body.messages.some((message) => message.role === 'user' && text(message) === 'child-nested') ? 'nested-final-report' : 'parent-received-child-report'
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const emit = (delta: unknown, finishReason: string | null = null) => response.write(`data: ${JSON.stringify({
        id: 'native-fixture', object: 'chat.completion.chunk', created: 1, model: modelId,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
        ...(finishReason === null ? {} : { usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })
      })}\n\n`)
      emit({ role: 'assistant', content: '' })
      if (tool !== null) {
        emit({ tool_calls: [{ index: 0, id: tool.name === 'read' ? 'native_read' : tool.name === 'SessionTask' ? 'native_session_task' : 'native_task', type: 'function', function: tool }] })
        emit({}, 'tool_calls')
      } else { emit({ content: answer }); emit({}, 'stop') }
      response.end('data: [DONE]\n\n')
    } catch (error) {
      serverErrors.push(error)
      if (!response.headersSent) response.writeHead(500)
      response.end(JSON.stringify({ error: { message: 'Native acceptance fixture rejected request.' } }))
    }
  })
  t.after(async () => {
    releaseChild()
    releaseHeld()
    try { await host?.dispose() } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
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
  await Promise.all([agentDir, project, legacyExecutor, projectConfig].map((path) => mkdir(path, { recursive: true })))
  const settingsBytes = JSON.stringify({ defaultProvider: provider, defaultModel: modelId,
    compaction: { enabled: false }, retry: { enabled: false },
    packages: [legacyExecutor], extensions: [join(legacyExecutor, 'index.ts')] })
  const projectSettingsBytes = JSON.stringify({ packages: [legacyExecutor], extensions: [join(legacyExecutor, 'index.ts')] })
  await Promise.all([
    writeFile(join(legacyExecutor, 'package.json'), JSON.stringify({ name: 'pi-subagents', version: '0.0.0', pi: { extensions: ['./index.ts'] } })),
    writeFile(join(legacyExecutor, 'index.ts'), "throw new Error('Legacy pi-subagents executor was imported'); export default function () {}\n"),
    writeFile(join(projectConfig, 'settings.json'), projectSettingsBytes),
    writeFile(join(project, 'probe.txt'), 'native-child-project'),
    writeFile(join(agentDir, 'settings.json'), settingsBytes),
    writeFile(join(agentDir, 'models.json'), JSON.stringify({ providers: { [provider]: {
      baseUrl: `http://127.0.0.1:${address.port}/v1`, api: 'openai-completions', apiKey: 'local-fixture-only',
      models: [{ id: modelId, reasoning: false, input: ['text'], contextWindow: 32_000, maxTokens: 1_024, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }]
    } } }))
  ])
  process.env.PI_CODING_AGENT_DIR = agentDir
  for (const key of proxyKeys) delete process.env[key]
  host = new SharedPiHost()
  let runtime = host.createRuntime({ cwd: project, extensionPaths: [], subagent: { maxDepth: 2 } })
  await runtime.start()
  await runtime.send({ type: 'set_model', provider, modelId })
  await promptAndDrain(runtime, 'delegate')
  const parentState = await sessionState(runtime)
  const records = (await readFile(parentState.sessionFile!, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { type: string; customType?: string; data?: { id: string } }).filter(({ type, customType }) => type === 'custom' && customType === 'pi-gui-native-task')
  const taskId = records.at(-1)!.data!.id
  assert.equal(typeof taskId, 'string')
  const busy = await runtime.queryQuiescence()
  assert.ok(busy.ok && !busy.result.quiescent)
  const waitCompleted = async () => {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { unsubscribe(); reject(new Error('Child completion did not arrive.')) }, 15_000)
      const unsubscribe = runtime.subscribe((event) => {
        if (event.type !== 'pi-event' || event.event.type !== 'message_end') return
        const message = event.event.message as { customType?: string; details?: { runId?: string } }
        if (message.customType !== 'subagent-notify' || message.details?.runId !== taskId) return
        clearTimeout(timeout); unsubscribe(); resolve()
      })
    })
  }
  const completed = waitCompleted()
  releaseChild()
  await completed
  const transcript = await runtime.send({ type: 'get_subagent_transcript', taskId })
  assert.equal(transcript.type, 'subagent-transcript')
  if (transcript.type !== 'subagent-transcript') throw new Error('Expected child transcript.')
  assert.equal(transcript.status, 'completed')
  assert.ok(transcript.messages.some((message) => (message as { role: string }).role === 'toolResult'))
  assert.ok(JSON.stringify(transcript.messages).includes('native-child-project'))
  assert.ok(JSON.stringify(transcript.messages).includes('child-report:child-read'))
  const other = host.createRuntime({ cwd: project, extensionPaths: [] })
  await other.start()
  await assert.rejects(other.send({ type: 'get_subagent_transcript', taskId }), /not found/u)
  const continued = waitCompleted()
  await runtime.send({ type: 'control_subagent', taskId, action: 'continue', message: 'child-read-next' })
  await continued
  const next = await runtime.send({ type: 'get_subagent_transcript', taskId })
  assert.equal(next.type, 'subagent-transcript')
  if (next.type !== 'subagent-transcript') throw new Error('Expected child transcript.')
  assert.ok(next.messages.length > transcript.messages.length)
  assert.ok(JSON.stringify(next.messages).includes('child-report:child-read-next'))
  const nestedCompleted = waitCompleted()
  await runtime.send({ type: 'control_subagent', taskId, action: 'continue', message: 'child-nested' })
  await nestedCompleted
  const nested = await runtime.send({ type: 'get_subagent_transcript', taskId })
  assert.ok(nested.type === 'subagent-transcript' && nested.status === 'completed')
  assert.ok(JSON.stringify(nested).includes('child-report:child-read-grandchild'))
  assert.ok(JSON.stringify(nested).includes('nested-final-report'))
  // The outer report must include the answer after its nested child reports back.
  const parentHistory = await messages(runtime)
  const outerReport = parentHistory.findLast((message) => (message as { customType?: string }).customType === 'subagent-notify')
  assert.ok(JSON.stringify(outerReport).includes('nested-final-report'))
  await runtime.send({ type: 'control_subagent', taskId, action: 'continue', message: 'child-hold' })
  await childHeld
  await runtime.send({ type: 'control_subagent', taskId, action: 'stop' })
  const paused = await runtime.send({ type: 'get_subagent_transcript', taskId })
  assert.ok(paused.type === 'subagent-transcript' && paused.status === 'paused')
  const state = await sessionState(runtime)
  await host.dispose()
  host = new SharedPiHost()
  runtime = host.createRuntime({ cwd: project, sessionFile: state.sessionFile!, extensionPaths: [], subagent: { maxDepth: 2 } })
  await runtime.start()
  const restored = await runtime.send({ type: 'get_subagent_transcript', taskId })
  assert.ok(restored.type === 'subagent-transcript' && restored.status === 'paused')
  assert.ok(JSON.stringify(restored).includes('child-report:child-read-next'))
  let collaborationRequests = 0
  const unsubscribeCollaboration = runtime.subscribe((event) => {
    if (event.type !== 'agent-collaboration-request') return
    collaborationRequests += 1
    assert.deepEqual(event.operation, { action: 'list' })
    void runtime.send({ type: 'agent_collaboration_response', response: {
      requestId: event.requestId, ok: true, result: { kind: 'sessions', sessions: [] }
    } }).catch((error: unknown) => serverErrors.push(error))
  })
  await promptAndDrain(runtime, 'collaborate')
  unsubscribeCollaboration()
  assert.equal(collaborationRequests, 1)
  assert.ok(JSON.stringify(await messages(runtime)).includes('session-list-received'))
  assert.deepEqual(serverErrors, [])
  assert.equal(await readFile(join(agentDir, 'settings.json'), 'utf8'), settingsBytes)
  assert.equal(await readFile(join(projectConfig, 'settings.json'), 'utf8'), projectSettingsBytes)
  assert.ok(parentReports >= 1)
  t.diagnostic(JSON.stringify({ nativeTaskId: taskId, childToolExecutions: 3, nestedFinalReport: true, collaborationRequests, continuedSameTask: true, stopStatus: 'paused', restoredNativeHistory: true }))
})
