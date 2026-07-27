import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildPiRpcArguments, LinuxLocalRuntime } from './linux-local-runtime.ts'

test('runtime leaves project resource trust to Pi defaults', () => {
  const arguments_ = buildPiRpcArguments()

  assert.deepEqual(arguments_.slice(0, 3), ['--mode', 'rpc', '--offline'])
  assert.equal(arguments_[3], '--append-system-prompt')
  assert.match(arguments_[4] ?? '', /commentary/)
  assert.match(arguments_[4] ?? '', /final_answer/)
  assert.equal(arguments_.includes('--approve'), false)
  assert.equal(arguments_.includes('--no-approve'), false)
})

test('runtime forwards all three project trust states as argv entries', () => {
  assert.equal(buildPiRpcArguments(undefined, false, undefined).includes('--approve'), false)
  assert.equal(buildPiRpcArguments(undefined, false, undefined).includes('--no-approve'), false)
  assert.equal(buildPiRpcArguments(undefined, false, true).at(-1), '--approve')
  assert.equal(buildPiRpcArguments(undefined, false, false).at(-1), '--no-approve')
})

test('runtime does not add legacy subagent arguments', () => {
  const arguments_ = buildPiRpcArguments()
  assert.equal(arguments_.includes('--subagent-max-depth'), false)
  assert.equal(arguments_.includes('--subagent-prevent-cycles'), false)
  assert.equal(arguments_.includes('--no-subagent-prevent-cycles'), false)
  assert.throws(
    () => new LinuxLocalRuntime({ cwd: '/tmp', subagent: { maxDepth: 4 as 1 } }),
    /Invalid subagent settings/u
  )
})

test('runtime controls fast extension loading and merges it with subagent depth', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-runtime-subagent-env-'))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  const executable = join(directory, 'pi')
  const environmentLog = join(directory, 'environment.jsonl')
  await writeFile(
    executable,
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
if (process.argv[2] === '--version') {
  process.stdout.write('0.80.10\\n')
  process.exit(0)
}
appendFileSync(${JSON.stringify(environmentLog)}, JSON.stringify({
  depth: process.env.PI_SUBAGENT_MAX_DEPTH,
  parallel: process.env.PI_PARALLEL_EXTENSION_IMPORTS,
  nativeCompiled: process.env.PI_NATIVE_COMPILED_EXTENSION_IMPORTS,
  jitiTryNative: process.env.JITI_TRY_NATIVE,
  nodeOptions: process.env.NODE_OPTIONS,
  argv: process.argv.slice(2)
}) + '\\n')
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
  let newline
  while ((newline = input.indexOf('\\n')) >= 0) {
    const request = JSON.parse(input.slice(0, newline))
    input = input.slice(newline + 1)
    process.stdout.write(JSON.stringify({
      type: 'response',
      id: request.id,
      success: true,
      ...(request.type === 'get_state' ? { data: {} } : {})
    }) + '\\n')
  }
})
`,
    { mode: 0o755 }
  )
  const inheritedDepth = process.env.PI_SUBAGENT_MAX_DEPTH
  const inheritedParallelImports = process.env.PI_PARALLEL_EXTENSION_IMPORTS
  const inheritedNativeCompiledImports = process.env.PI_NATIVE_COMPILED_EXTENSION_IMPORTS
  const inheritedJitiTryNative = process.env.JITI_TRY_NATIVE
  process.env.PI_SUBAGENT_MAX_DEPTH = '9'
  process.env.PI_PARALLEL_EXTENSION_IMPORTS = '1'
  process.env.PI_NATIVE_COMPILED_EXTENSION_IMPORTS = '1'
  process.env.JITI_TRY_NATIVE = '0'
  t.after(() => {
    if (inheritedDepth === undefined) delete process.env.PI_SUBAGENT_MAX_DEPTH
    else process.env.PI_SUBAGENT_MAX_DEPTH = inheritedDepth
    if (inheritedParallelImports === undefined) delete process.env.PI_PARALLEL_EXTENSION_IMPORTS
    else process.env.PI_PARALLEL_EXTENSION_IMPORTS = inheritedParallelImports
    if (inheritedNativeCompiledImports === undefined) {
      delete process.env.PI_NATIVE_COMPILED_EXTENSION_IMPORTS
    } else {
      process.env.PI_NATIVE_COMPILED_EXTENSION_IMPORTS = inheritedNativeCompiledImports
    }
    if (inheritedJitiTryNative === undefined) delete process.env.JITI_TRY_NATIVE
    else process.env.JITI_TRY_NATIVE = inheritedJitiTryNative
  })

  const inheritedRuntime = new LinuxLocalRuntime({
    cwd: directory,
    explicitExecutable: executable
  })
  await inheritedRuntime.start()
  await inheritedRuntime.stop()
  const configuredRuntime = new LinuxLocalRuntime({
    cwd: directory,
    explicitExecutable: executable,
    subagent: { maxDepth: 2 },
    fastExtensionLoading: true
  })
  await configuredRuntime.start()
  await configuredRuntime.stop()

  const launches = (await readFile(environmentLog, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as {
      depth: string
      parallel?: string
      nativeCompiled?: string
      jitiTryNative?: string
      nodeOptions?: string
      argv: string[]
    })
  assert.deepEqual(launches.map(({ depth }) => depth), ['9', '2'])
  assert.deepEqual(launches.map(({ parallel }) => parallel), [undefined, '1'])
  assert.deepEqual(launches.map(({ nativeCompiled }) => nativeCompiled), [undefined, '1'])
  assert.deepEqual(launches.map(({ jitiTryNative }) => jitiTryNative), [undefined, '1'])
  assert.equal(launches[1]?.nodeOptions?.includes('--import=data:text/javascript,'), true)
  assert.equal(launches.some(({ argv }) => argv.some((argument) => argument.includes('subagent'))), false)
})

test('runtime resumes an absolute session file', () => {
  const sessionFile = '/tmp/pi-session.jsonl'

  assert.deepEqual(buildPiRpcArguments(sessionFile), [
    '--mode',
    'rpc',
    '--offline',
    '--append-system-prompt',
    buildPiRpcArguments()[4]!,
    '--session',
    sessionFile
  ])
  assert.throws(
    () => new LinuxLocalRuntime({ cwd: '/tmp', sessionFile: 'relative-session.jsonl' }),
    /Session file must be an absolute path/
  )
})

test('runtime supports stateless probes and rejects conflicting session modes', () => {
  assert.deepEqual(buildPiRpcArguments(undefined, true), [
    '--mode',
    'rpc',
    '--offline',
    '--append-system-prompt',
    buildPiRpcArguments()[4]!,
    '--no-session'
  ])
  assert.throws(
    () => buildPiRpcArguments('/tmp/pi-session.jsonl', true),
    /cannot be used together/
  )
  assert.throws(
    () => new LinuxLocalRuntime({ cwd: '/tmp', sessionFile: '/tmp/pi-session.jsonl', noSession: true }),
    /cannot be used together/
  )
})

test('runtime forwards native images for prompt, steer, and follow-up', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-runtime-images-'))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  const executable = join(directory, 'pi')
  const requestLog = join(directory, 'requests.jsonl')
  await writeFile(
    executable,
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
if (process.argv[2] === '--version') {
  process.stdout.write('0.80.10\\n')
  process.exit(0)
}
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
  let newline
  while ((newline = input.indexOf('\\n')) >= 0) {
    const request = JSON.parse(input.slice(0, newline))
    input = input.slice(newline + 1)
    appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify(request) + '\\n')
    process.stdout.write(JSON.stringify({
      type: 'response',
      id: request.id,
      success: true,
      ...(request.type === 'get_state' ? { data: {} } : {})
    }) + '\\n')
  }
})
`,
    { mode: 0o755 }
  )
  const runtime = new LinuxLocalRuntime({ cwd: directory, explicitExecutable: executable })
  const image = { type: 'image' as const, mimeType: 'image/png', data: 'aGVsbG8=' }

  await runtime.start()
  await runtime.send({ type: 'prompt', message: 'Prompt', images: [image] })
  await runtime.send({ type: 'steer', message: 'Steer', images: [image] })
  await runtime.send({ type: 'follow_up', message: 'Follow up', images: [image] })
  await runtime.stop()

  const requests = (await readFile(requestLog, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .map(({ id: _id, ...request }) => request)
  assert.deepEqual(requests.slice(-3), [
    { type: 'prompt', message: 'Prompt', images: [image] },
    { type: 'steer', message: 'Steer', images: [image] },
    { type: 'follow_up', message: 'Follow up', images: [image] }
  ])
})

test('runtime forwards get_entries and fork through the Pi RPC client', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-runtime-fork-'))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  const executable = join(directory, 'pi')
  const requestLog = join(directory, 'requests.jsonl')
  await writeFile(
    executable,
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
if (process.argv[2] === '--version') {
  process.stdout.write('0.80.10\\n')
  process.exit(0)
}
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
  let newline
  while ((newline = input.indexOf('\\n')) >= 0) {
    const request = JSON.parse(input.slice(0, newline))
    input = input.slice(newline + 1)
    appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify(request) + '\\n')
    const data = request.type === 'get_state'
      ? {}
      : request.type === 'get_entries'
        ? {
            entries: [{
              id: 'entry-1',
              parentId: null,
              type: 'message',
              timestamp: '2026-07-24T01:00:00.000Z',
              message: { role: 'user', content: 'Original prompt' }
            }],
            leafId: 'entry-1'
          }
        : request.type === 'fork'
          ? { text: 'Original prompt', cancelled: false }
          : undefined
    process.stdout.write(JSON.stringify({
      type: 'response',
      id: request.id,
      success: true,
      ...(data === undefined ? {} : { data })
    }) + '\\n')
  }
})
`,
    { mode: 0o755 }
  )
  const runtime = new LinuxLocalRuntime({ cwd: directory, explicitExecutable: executable })

  await runtime.start()
  const entries = await runtime.send({ type: 'get_entries' })
  const fork = await runtime.send({ type: 'fork', entryId: 'entry-1' })
  await runtime.stop()

  assert.deepEqual(entries, {
    type: 'entries',
    entries: [{
      id: 'entry-1',
      parentId: null,
      type: 'message',
      timestamp: '2026-07-24T01:00:00.000Z',
      message: {
        role: 'user',
        content: { text: 'Original prompt', hasImage: false }
      }
    }],
    leafId: 'entry-1'
  })
  assert.deepEqual(fork, { type: 'forked', text: 'Original prompt', cancelled: false })

  const requests = (await readFile(requestLog, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .map(({ id: _id, ...request }) => request)
  assert.deepEqual(requests.slice(-2), [
    { type: 'get_entries' },
    { type: 'fork', entryId: 'entry-1' }
  ])
})

test('runtime forwards get_session_stats through the Pi RPC client', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-runtime-stats-'))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  const executable = join(directory, 'pi')
  const requestLog = join(directory, 'requests.jsonl')
  const statistics = {
    sessionFile: '/tmp/session.jsonl',
    sessionId: 'session-1',
    userMessages: 2,
    assistantMessages: 1,
    toolCalls: 3,
    toolResults: 3,
    totalMessages: 6,
    tokens: {
      input: 100,
      output: 50,
      cacheRead: 25,
      cacheWrite: 10,
      total: 185
    },
    cost: 0.0125,
    contextUsage: {
      tokens: 185,
      contextWindow: 200_000,
      percent: 0.0925
    }
  }
  await writeFile(
    executable,
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
if (process.argv[2] === '--version') {
  process.stdout.write('0.80.10\\n')
  process.exit(0)
}
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
  let newline
  while ((newline = input.indexOf('\\n')) >= 0) {
    const request = JSON.parse(input.slice(0, newline))
    input = input.slice(newline + 1)
    appendFileSync(${JSON.stringify(requestLog)}, JSON.stringify(request) + '\\n')
    const data = request.type === 'get_state'
      ? {}
      : request.type === 'get_session_stats'
        ? ${JSON.stringify(statistics)}
        : undefined
    process.stdout.write(JSON.stringify({
      type: 'response',
      id: request.id,
      success: true,
      ...(data === undefined ? {} : { data })
    }) + '\\n')
  }
})
`,
    { mode: 0o755 }
  )
  const runtime = new LinuxLocalRuntime({ cwd: directory, explicitExecutable: executable })

  await runtime.start()
  const result = await runtime.send({ type: 'get_session_stats' })
  await runtime.stop()

  assert.deepEqual(result, {
    type: 'session-statistics',
    statistics
  })
  const requests = (await readFile(requestLog, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .map(({ id: _id, ...request }) => request)
  assert.deepEqual(requests.at(-1), { type: 'get_session_stats' })
})

test('stale get_state snapshots cannot revive a settled activity', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-runtime-stale-state-'))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  const executable = join(directory, 'pi')
  await writeFile(
    executable,
    `#!/usr/bin/env node
if (process.argv[2] === '--version') {
  process.stdout.write('0.80.10\\n')
  process.exit(0)
}
let input = ''
let stateRequests = 0
const respond = (request, data) => {
  process.stdout.write(JSON.stringify({ type: 'response', id: request.id, success: true, data }) + '\\n')
}
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
  let newline
  while ((newline = input.indexOf('\\n')) >= 0) {
    const request = JSON.parse(input.slice(0, newline))
    input = input.slice(newline + 1)
    if (request.type === 'get_state') {
      stateRequests += 1
      if (stateRequests === 1) {
        respond(request, { isStreaming: false })
      } else {
        process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n')
        setTimeout(() => respond(request, { isStreaming: true }), 20)
      }
      continue
    }
    if (request.type === 'prompt') {
      process.stdout.write(JSON.stringify({ type: 'agent_start' }) + '\\n')
      respond(request)
      continue
    }
    respond(request, {})
  }
})
`,
    { mode: 0o755 }
  )
  const runtime = new LinuxLocalRuntime({ cwd: directory, explicitExecutable: executable })
  const events: string[] = []
  runtime.subscribe((event) => events.push(event.type))

  await runtime.start()
  await runtime.send({ type: 'prompt', message: 'Run once' })
  await runtime.send({ type: 'get_state' })
  await runtime.stop()

  assert.deepEqual(events.filter((type) => type.startsWith('activity-')), [])
  assert.deepEqual(events.filter((type) => type === 'pi-event'), ['pi-event', 'pi-event'])
})

test('runtime state summarizes stderr without retaining secret text', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-runtime-stderr-'))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  const executable = join(directory, 'pi')
  const secret = 'SECRET token=super-sensitive-value'
  await writeFile(
    executable,
    `#!/usr/bin/env node
if (process.argv[2] === '--version') {
  process.stdout.write('0.80.10\\n')
  process.exit(0)
}
process.stderr.write(${JSON.stringify(secret)})
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
  let newline
  while ((newline = input.indexOf('\\n')) >= 0) {
    const request = JSON.parse(input.slice(0, newline))
    input = input.slice(newline + 1)
    process.stdout.write(JSON.stringify({ type: 'response', id: request.id, success: true, data: {} }) + '\\n')
  }
})
`,
    { mode: 0o755 }
  )
  const runtime = new LinuxLocalRuntime({ cwd: directory, explicitExecutable: executable })

  await runtime.start()
  const state = runtime.getState()
  await runtime.stop()

  assert.equal(state.stderrChars, secret.length)
  assert.equal(state.stderrSummary, `Pi stderr captured ${secret.length} characters.`)
  assert.equal(JSON.stringify(state).includes('SECRET'), false)
  assert.equal(JSON.stringify(state).includes('super-sensitive-value'), false)
})

test('stop during the version check cancels start before spawning RPC', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-runtime-stop-'))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  const executable = join(directory, 'pi')
  const rpcMarker = join(directory, 'rpc-started')
  await writeFile(
    executable,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then\n  sleep 0.1\n  printf "0.80.10\\n"\n  exit 0\nfi\nprintf "started" > rpc-started\n',
    { mode: 0o755 }
  )
  const runtime = new LinuxLocalRuntime({
    cwd: directory,
    explicitExecutable: executable,
    versionTimeoutMs: 1_000
  })

  const startPromise = runtime.start()
  const stopPromise = runtime.stop()

  await assert.rejects(startPromise, /cancelled/i)
  await stopPromise
  await assert.rejects(access(rpcMarker))
})
