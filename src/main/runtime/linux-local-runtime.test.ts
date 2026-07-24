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
