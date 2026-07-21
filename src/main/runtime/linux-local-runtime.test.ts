import assert from 'node:assert/strict'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildPiRpcArguments, LinuxLocalRuntime } from './linux-local-runtime.ts'

test('runtime leaves project resource trust to Pi defaults', () => {
  const arguments_ = buildPiRpcArguments()

  assert.deepEqual(arguments_, ['--mode', 'rpc', '--offline'])
  assert.equal(arguments_.includes('--approve'), false)
  assert.equal(arguments_.includes('--no-approve'), false)
})

test('runtime resumes an absolute session file', () => {
  const sessionFile = '/tmp/pi-session.jsonl'

  assert.deepEqual(buildPiRpcArguments(sessionFile), [
    '--mode',
    'rpc',
    '--offline',
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
