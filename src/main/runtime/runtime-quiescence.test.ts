import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  LEASE_STATUS_KEY,
  QUIESCENCE_COMMAND_NAME,
  QUIESCENCE_STATUS_KEY,
  buildQuiescencePrompt,
  interpretHibernateLeaseStatusText,
  interpretQuiescenceStatusText,
  isInternalQuiescenceCommandName,
  isMutatingRuntimeCommandType,
  isQuiescenceStatusEvent,
  normalizeQuiescenceTimeoutMs,
  resolveRuntimeExtensionPaths,
  resolveRuntimeQuiescenceExtensionPath
} from './runtime-quiescence.ts'
import { buildPiRpcArguments, LinuxLocalRuntime } from './linux-local-runtime.ts'
import { createCommandCatalog } from '../kernel/command-catalog.ts'

test('P3 tree and extension mutations remain behind the hibernate fence', () => {
  assert.equal(isMutatingRuntimeCommandType('get_tree'), false)
  assert.equal(isMutatingRuntimeCommandType('navigate_tree'), true)
  assert.equal(isMutatingRuntimeCommandType('invoke_extension_command'), true)
  assert.equal(isMutatingRuntimeCommandType('subscribe_extension_events'), true)
})

test('buildQuiescencePrompt and command filter stay aligned', () => {
  assert.equal(buildQuiescencePrompt('abc-123'), `/${QUIESCENCE_COMMAND_NAME} abc-123`)
  assert.throws(() => buildQuiescencePrompt('has space'), /nonce/u)
  assert.equal(isInternalQuiescenceCommandName(QUIESCENCE_COMMAND_NAME), true)
  const catalog = createCommandCatalog([
    {
      name: QUIESCENCE_COMMAND_NAME,
      description: 'internal',
      source: 'extension',
      sourceInfo: { source: 'quiescence', scope: 'temporary', origin: 'top-level' }
    },
    {
      name: 'advisor',
      description: 'visible',
      source: 'extension',
      sourceInfo: { source: 'advisor', scope: 'user', origin: 'package' }
    }
  ])
  assert.equal(catalog.some((command) => command.name === QUIESCENCE_COMMAND_NAME), false)
  assert.equal(catalog.some((command) => command.name === 'advisor'), true)
})

test('resolveRuntimeQuiescenceExtensionPath finds the source extension', () => {
  const path = resolveRuntimeQuiescenceExtensionPath()
  assert.match(path, /pi-gui-runtime-quiescence\/src\/index\.ts$/u)
})

test('resolveRuntimeExtensionPaths includes quiescence, task-notify, and ask in stable order', () => {
  const paths = resolveRuntimeExtensionPaths()
  assert.equal(paths.length, 3)
  assert.match(paths[0]!, /pi-gui-runtime-quiescence\/src\/index\.ts$/u)
  assert.match(paths[1]!, /pi-gui-task-notify\/src\/index\.ts$/u)
  assert.match(paths[2]!, /pi-gui-ask\/src\/index\.ts$/u)
})

test('resolveRuntimeQuiescenceExtensionPath prefers packaged resources when present', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-gui-quiescence-packaged-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  const { mkdir } = await import('node:fs/promises')
  const packaged = join(root, 'pi-extensions/pi-gui-runtime-quiescence/src/index.ts')
  await mkdir(join(root, 'pi-extensions/pi-gui-runtime-quiescence/src'), { recursive: true })
  await writeFile(packaged, 'export default () => {}\n')
  const path = resolveRuntimeQuiescenceExtensionPath({
    isPackaged: true,
    resourcesPath: root
  })
  assert.equal(path, packaged)
})

test('interpretQuiescenceStatusText correlates nonce and rejects malformed payloads', () => {
  const good = {
    version: 1,
    kind: 'pi-gui.runtime-quiescence/query-result',
    nonce: 'n-9',
    core: { idle: true, pendingMessages: false },
    providers: [],
    quiescent: true
  }
  assert.deepEqual(interpretQuiescenceStatusText(JSON.stringify(good), 'n-9'), {
    ok: true,
    result: good
  })
  const mismatched = interpretQuiescenceStatusText(JSON.stringify(good), 'other')
  assert.equal(mismatched.ok, false)
  if (!mismatched.ok) assert.equal(mismatched.reason, 'nonce-mismatch')
  const malformed = interpretQuiescenceStatusText('not-json', 'n-9')
  assert.equal(malformed.ok, false)
  if (!malformed.ok) assert.equal(malformed.reason, 'malformed')
  const cleared = interpretQuiescenceStatusText(undefined, 'n-9')
  assert.equal(cleared.ok, false)
  if (!cleared.ok) assert.equal(cleared.reason, 'malformed')
})

test('interpretHibernateLeaseStatusText preserves redacted provider blockers', () => {
  const result = interpretHibernateLeaseStatusText(JSON.stringify({
    version: 1,
    kind: 'pi-gui.runtime-hibernate-lease/result',
    action: 'prepare',
    nonce: 'lease-nonce',
    sessionId: 'session-1',
    generation: 1,
    attemptId: 'attempt-1',
    ok: false,
    reason: 'provider-prepare-failed',
    blockers: [
      { id: 'magic-context', reason: 'operation-active' },
      { id: 'pi-mcp-adapter', reason: 'oauth-active' }
    ]
  }), 'lease-nonce', 'prepare')
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'lease-rejected')
  assert.equal(result.leaseReason, 'provider-prepare-failed')
  assert.deepEqual(result.blockers, [
    { id: 'magic-context', reason: 'operation-active' },
    { id: 'pi-mcp-adapter', reason: 'oauth-active' }
  ])
})

test('buildPiRpcArguments loads absolute quiescence extension paths with -e', () => {
  const extension = '/opt/pi-gui/extensions/pi-gui-runtime-quiescence/src/index.ts'
  const args = buildPiRpcArguments(undefined, true, undefined, [extension])
  assert.deepEqual(args.slice(-2), ['-e', extension])
  assert.throws(
    () => buildPiRpcArguments(undefined, true, undefined, ['relative/path.ts']),
    /absolute/u
  )
})

test('LinuxLocalRuntime.queryQuiescence correlates setStatus nonce and swallows the event', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-gui-quiescence-runtime-'))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  const extensionPath = join(directory, 'quiescence.ts')
  await writeFile(extensionPath, 'export default () => {}\n')
  const executable = join(directory, 'pi')
  await writeFile(
    executable,
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
const logPath = ${JSON.stringify(join(directory, 'rpc.jsonl'))}
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
    const line = input.slice(0, newline)
    input = input.slice(newline + 1)
    const request = JSON.parse(line)
    appendFileSync(logPath, JSON.stringify(request) + '\\n')
    if (request.type === 'get_state') {
      process.stdout.write(JSON.stringify({
        type: 'response',
        id: request.id,
        success: true,
        data: {
          thinkingLevel: 'off',
          isStreaming: false,
          isCompacting: false,
          steeringMode: 'all',
          followUpMode: 'all',
          sessionId: 's1',
          autoCompactionEnabled: true,
          messageCount: 0,
          pendingMessageCount: 0
        }
      }) + '\\n')
      continue
    }
    if (request.type === 'prompt') {
      process.stdout.write(JSON.stringify({
        type: 'response',
        id: request.id,
        success: true
      }) + '\\n')
      const message = String(request.message || '')
      const nonce = message.split(' ').slice(1).join(' ').trim()
      const payload = {
        version: 1,
        kind: 'pi-gui.runtime-quiescence/query-result',
        nonce,
        core: { idle: true, pendingMessages: false },
        providers: [],
        quiescent: true
      }
      process.stdout.write(JSON.stringify({
        type: 'extension_ui_request',
        id: 'status-1',
        method: 'setStatus',
        statusKey: ${JSON.stringify(QUIESCENCE_STATUS_KEY)},
        statusText: JSON.stringify(payload)
      }) + '\\n')
      process.stdout.write(JSON.stringify({
        type: 'extension_ui_request',
        id: 'status-2',
        method: 'setStatus',
        statusKey: ${JSON.stringify(QUIESCENCE_STATUS_KEY)},
        statusText: undefined
      }) + '\\n')
      continue
    }
    process.stdout.write(JSON.stringify({
      type: 'response',
      id: request.id,
      success: true
    }) + '\\n')
  }
})
`,
    { mode: 0o755 }
  )

  const runtime = new LinuxLocalRuntime({
    cwd: directory,
    explicitExecutable: executable,
    noSession: true,
    quiescenceExtensionPath: extensionPath
  })
  const leaked: unknown[] = []
  runtime.subscribe((event) => {
    if (event.type === 'pi-event') leaked.push(event.event)
  })
  await runtime.start()
  const result = await runtime.queryQuiescence({ timeoutMs: 2_000 })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.result.quiescent, true)
    assert.equal(result.result.core.idle, true)
  }
  assert.equal(
    leaked.some(
      (event) =>
        isQuiescenceStatusEvent(event as { type?: unknown; method?: unknown; statusKey?: unknown })
    ),
    false,
    'internal quiescence setStatus must not leak as pi-events'
  )
  const rpcLog = await (await import('node:fs/promises')).readFile(join(directory, 'rpc.jsonl'), 'utf8')
  assert.match(rpcLog, new RegExp(`/${QUIESCENCE_COMMAND_NAME} `))
  // Extension commands must not be accompanied by get_messages / session mutation side channels here.
  assert.equal(rpcLog.includes('"type":"get_messages"'), false)
  await runtime.stop()
})

test('LinuxLocalRuntime.queryQuiescence fails closed on timeout and malformed nonce payload', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-gui-quiescence-fail-'))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  const extensionPath = join(directory, 'quiescence.ts')
  await writeFile(extensionPath, 'export default () => {}\n')
  const executable = join(directory, 'pi')
  await writeFile(
    executable,
    `#!/usr/bin/env node
if (process.argv[2] === '--version') {
  process.stdout.write('0.80.10\\n')
  process.exit(0)
}
let mode = process.env.PI_GUI_TEST_MODE || 'timeout'
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
  let newline
  while ((newline = input.indexOf('\\n')) >= 0) {
    const request = JSON.parse(input.slice(0, newline))
    input = input.slice(newline + 1)
    if (request.type === 'get_state') {
      process.stdout.write(JSON.stringify({
        type: 'response',
        id: request.id,
        success: true,
        data: {
          thinkingLevel: 'off',
          isStreaming: false,
          isCompacting: false,
          steeringMode: 'all',
          followUpMode: 'all',
          sessionId: 's1',
          autoCompactionEnabled: true,
          messageCount: 0,
          pendingMessageCount: 0
        }
      }) + '\\n')
      continue
    }
    if (request.type === 'prompt') {
      process.stdout.write(JSON.stringify({ type: 'response', id: request.id, success: true }) + '\\n')
      if (mode === 'malformed') {
        process.stdout.write(JSON.stringify({
          type: 'extension_ui_request',
          id: 'status-bad',
          method: 'setStatus',
          statusKey: ${JSON.stringify(QUIESCENCE_STATUS_KEY)},
          statusText: JSON.stringify({
            version: 1,
            kind: 'pi-gui.runtime-quiescence/query-result',
            nonce: 'wrong-nonce',
            core: { idle: true, pendingMessages: false },
            providers: [],
            quiescent: true
          })
        }) + '\\n')
      }
      // timeout mode: never emit matching status
      continue
    }
    process.stdout.write(JSON.stringify({ type: 'response', id: request.id, success: true }) + '\\n')
  }
})
`,
    { mode: 0o755 }
  )

  const timeoutRuntime = new LinuxLocalRuntime({
    cwd: directory,
    explicitExecutable: executable,
    noSession: true,
    quiescenceExtensionPath: extensionPath
  })
  await timeoutRuntime.start()
  const timedOut = await timeoutRuntime.queryQuiescence({ timeoutMs: 80 })
  assert.equal(timedOut.ok, false)
  if (!timedOut.ok) assert.equal(timedOut.reason, 'timeout')
  await timeoutRuntime.stop()

  process.env.PI_GUI_TEST_MODE = 'malformed'
  t.after(() => {
    delete process.env.PI_GUI_TEST_MODE
  })
  const malformedRuntime = new LinuxLocalRuntime({
    cwd: directory,
    explicitExecutable: executable,
    noSession: true,
    quiescenceExtensionPath: extensionPath
  })
  await malformedRuntime.start()
  const mismatched = await malformedRuntime.queryQuiescence({ timeoutMs: 120 })
  // Wrong-nonce events are ignored; waiter fails closed via timeout.
  assert.equal(mismatched.ok, false)
  if (!mismatched.ok) assert.equal(mismatched.reason, 'timeout')
  await malformedRuntime.stop()
})

test('queryQuiescence fails closed when runtime is not running', async () => {
  const runtime = new LinuxLocalRuntime({
    cwd: '/tmp',
    quiescenceExtensionPath: '/tmp/missing-extension.ts'
  })
  const result = await runtime.queryQuiescence()
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason, 'runtime-not-running')
})


test('normalizeQuiescenceTimeoutMs rejects non-integer and out-of-bounds values', () => {
  assert.equal(normalizeQuiescenceTimeoutMs(undefined).ok, true)
  assert.equal(normalizeQuiescenceTimeoutMs(10).ok, true)
  assert.equal(normalizeQuiescenceTimeoutMs(1.25).ok, false)
  assert.equal(normalizeQuiescenceTimeoutMs(Number.NaN).ok, false)
  assert.equal(normalizeQuiescenceTimeoutMs(0).ok, false)
})

test('queryQuiescence rejects new queries once stop starts and settles in-flight waiters', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-gui-quiescence-stop-'))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  const extensionPath = join(directory, 'quiescence.ts')
  await writeFile(extensionPath, 'export default () => {}\n')
  const executable = join(directory, 'pi')
  await writeFile(
    executable,
    `#!/usr/bin/env node
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
    if (request.type === 'get_state') {
      process.stdout.write(JSON.stringify({
        type: 'response',
        id: request.id,
        success: true,
        data: {
          thinkingLevel: 'off',
          isStreaming: false,
          isCompacting: false,
          steeringMode: 'all',
          followUpMode: 'all',
          sessionId: 's1',
          autoCompactionEnabled: true,
          messageCount: 0,
          pendingMessageCount: 0
        }
      }) + '\\n')
      continue
    }
    if (request.type === 'prompt') {
      process.stdout.write(JSON.stringify({ type: 'response', id: request.id, success: true }) + '\\n')
      // Never emit quiescence status; stop should settle the waiter first.
      continue
    }
    process.stdout.write(JSON.stringify({ type: 'response', id: request.id, success: true }) + '\\n')
  }
})
`,
    { mode: 0o755 }
  )

  const runtime = new LinuxLocalRuntime({
    cwd: directory,
    explicitExecutable: executable,
    noSession: true,
    quiescenceExtensionPath: extensionPath
  })
  await runtime.start()
  const pending = runtime.queryQuiescence({ timeoutMs: 2_000 })
  const stopPromise = runtime.stop()
  const settled = await pending
  assert.equal(settled.ok, false)
  if (!settled.ok) assert.equal(settled.reason, 'stopping')
  const rejected = await runtime.queryQuiescence({ timeoutMs: 50 })
  assert.equal(rejected.ok, false)
  if (!rejected.ok) assert.equal(rejected.reason, 'stopping')
  await stopPromise
})

test('queryQuiescence isolates two concurrent nonces with interleaved replies', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-gui-quiescence-concurrent-'))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  const extensionPath = join(directory, 'quiescence.ts')
  await writeFile(extensionPath, 'export default () => {}\n')
  const executable = join(directory, 'pi')
  await writeFile(
    executable,
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
const logPath = ${JSON.stringify(join(directory, 'prompts.jsonl'))}
if (process.argv[2] === '--version') {
  process.stdout.write('0.80.10\\n')
  process.exit(0)
}
let input = ''
const pending = []
function maybeFlush() {
  if (pending.length < 2) return
  // Interleave replies: second prompt first, then first prompt.
  const ordered = [pending[1], pending[0]]
  for (const { id, nonce } of ordered) {
    process.stdout.write(JSON.stringify({ type: 'response', id, success: true }) + '\\n')
    const payload = {
      version: 1,
      kind: 'pi-gui.runtime-quiescence/query-result',
      nonce,
      core: { idle: true, pendingMessages: false },
      providers: [],
      quiescent: true
    }
    process.stdout.write(JSON.stringify({
      type: 'extension_ui_request',
      id: 'status-' + nonce,
      method: 'setStatus',
      statusKey: ${JSON.stringify(QUIESCENCE_STATUS_KEY)},
      statusText: JSON.stringify(payload)
    }) + '\\n')
  }
  pending.length = 0
}
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
  let newline
  while ((newline = input.indexOf('\\n')) >= 0) {
    const request = JSON.parse(input.slice(0, newline))
    input = input.slice(newline + 1)
    if (request.type === 'get_state') {
      process.stdout.write(JSON.stringify({
        type: 'response',
        id: request.id,
        success: true,
        data: {
          thinkingLevel: 'off',
          isStreaming: false,
          isCompacting: false,
          steeringMode: 'all',
          followUpMode: 'all',
          sessionId: 's1',
          autoCompactionEnabled: true,
          messageCount: 0,
          pendingMessageCount: 0
        }
      }) + '\\n')
      continue
    }
    if (request.type === 'prompt') {
      const message = String(request.message || '')
      const nonce = message.split(' ').slice(1).join(' ').trim()
      appendFileSync(logPath, nonce + '\\n')
      pending.push({ id: request.id, nonce })
      maybeFlush()
      continue
    }
    process.stdout.write(JSON.stringify({ type: 'response', id: request.id, success: true }) + '\\n')
  }
})
`,
    { mode: 0o755 }
  )

  const runtime = new LinuxLocalRuntime({
    cwd: directory,
    explicitExecutable: executable,
    noSession: true,
    quiescenceExtensionPath: extensionPath
  })
  await runtime.start()
  const first = runtime.queryQuiescence({ timeoutMs: 2_000 })
  const second = runtime.queryQuiescence({ timeoutMs: 2_000 })
  const [a, b] = await Promise.all([first, second])
  assert.equal(a.ok, true)
  assert.equal(b.ok, true)
  if (a.ok && b.ok) {
    assert.notEqual(a.result.nonce, b.result.nonce)
    // Each result correlates to its own nonce only once.
    assert.equal(a.result.quiescent, true)
    assert.equal(b.result.quiescent, true)
  }
  // Settled waiters must not double-resolve; a late stop stays clean.
  await runtime.stop()
  const afterStop = await runtime.queryQuiescence({ timeoutMs: 50 })
  assert.equal(afterStop.ok, false)
  if (!afterStop.ok) assert.equal(afterStop.reason, 'stopping')
})

test('queryQuiescence settles runtime-not-running on natural exit after prompt ack', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-gui-quiescence-natural-exit-'))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  const extensionPath = join(directory, 'quiescence.ts')
  await writeFile(extensionPath, 'export default () => {}\n')
  const executable = join(directory, 'pi')
  await writeFile(
    executable,
    `#!/usr/bin/env node
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
    if (request.type === 'get_state') {
      process.stdout.write(JSON.stringify({
        type: 'response',
        id: request.id,
        success: true,
        data: {
          thinkingLevel: 'off',
          isStreaming: false,
          isCompacting: false,
          steeringMode: 'all',
          followUpMode: 'all',
          sessionId: 's1',
          autoCompactionEnabled: true,
          messageCount: 0,
          pendingMessageCount: 0
        }
      }) + '\\n')
      continue
    }
    if (request.type === 'prompt') {
      // Acknowledge the internal QUERY prompt, then die before setStatus.
      process.stdout.write(JSON.stringify({ type: 'response', id: request.id, success: true }) + '\\n')
      setTimeout(() => process.exit(0), 20)
      continue
    }
    process.stdout.write(JSON.stringify({ type: 'response', id: request.id, success: true }) + '\\n')
  }
})
`,
    { mode: 0o755 }
  )

  const runtime = new LinuxLocalRuntime({
    cwd: directory,
    explicitExecutable: executable,
    noSession: true,
    quiescenceExtensionPath: extensionPath
  })
  await runtime.start()
  const startedAt = Date.now()
  const result = await runtime.queryQuiescence({ timeoutMs: 2_000 })
  const elapsed = Date.now() - startedAt
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason, 'runtime-not-running')
  // Must settle from process-exit, not the 2s timeout backstop.
  assert.ok(elapsed < 1_000, `expected fast natural-exit settle, took ${elapsed}ms`)
  // Explicit stop after natural exit keeps the stopping rejection for new queries
  // once stop() is requested; natural-exit path itself used runtime-not-running.
  await runtime.stop()
})

test('RuntimeHost hibernate fence blocks mutations and stale release stays fail-closed', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-gui-hibernate-fence-'))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  const extensionPath = join(directory, 'quiescence.ts')
  await writeFile(extensionPath, 'export default () => {}\n')
  const executable = join(directory, 'pi')
  await writeFile(
    executable,
    `#!/usr/bin/env node
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
    if (request.type === 'get_state') {
      process.stdout.write(JSON.stringify({
        type: 'response', id: request.id, success: true,
        data: {
          thinkingLevel: 'off', isStreaming: false, isCompacting: false,
          steeringMode: 'all', followUpMode: 'all', sessionId: 'session-1',
          autoCompactionEnabled: true, messageCount: 0, pendingMessageCount: 0
        }
      }) + '\\n')
      continue
    }
    if (request.type === 'prompt') {
      process.stdout.write(JSON.stringify({ type: 'response', id: request.id, success: true }) + '\\n')
      const message = String(request.message || '')
      const raw = JSON.parse(message.slice(message.indexOf(' ') + 1))
      const token = raw.token || 'host-token-1234'
      const payload = {
        version: 1,
        kind: 'pi-gui.runtime-hibernate-lease/result',
        action: raw.action,
        nonce: raw.nonce,
        sessionId: raw.sessionId,
        generation: raw.generation,
        attemptId: raw.attemptId,
        ok: true,
        token,
        ...(raw.action === 'prepare' ? {
          inventoryFingerprint: 'v1;providers=-;subagents=0',
          preparedProviders: []
        } : {})
      }
      process.stdout.write(JSON.stringify({
        type: 'extension_ui_request', id: 'lease-' + raw.action,
        method: 'setStatus', statusKey: ${JSON.stringify(LEASE_STATUS_KEY)},
        statusText: JSON.stringify(payload)
      }) + '\\n')
      continue
    }
    process.stdout.write(JSON.stringify({ type: 'response', id: request.id, success: true }) + '\\n')
  }
})
`,
    { mode: 0o755 }
  )

  const runtime = new LinuxLocalRuntime({
    cwd: directory,
    explicitExecutable: executable,
    noSession: true,
    quiescenceExtensionPath: extensionPath
  })
  await runtime.start()
  t.after(async () => {
    await runtime.stop().catch(() => undefined)
  })
  const prepared = await runtime.prepareHibernation({
    sessionId: 'session-1', generation: 1, attemptId: 'attempt-1', timeoutMs: 2_000
  })
  assert.equal(prepared.ok, true)
  assert.equal(prepared.ok ? prepared.token : undefined, 'host-token-1234')
  await assert.rejects(
    runtime.send({ type: 'set_thinking_level', level: 'high' }),
    /hibernate lease is active/u
  )
  assert.equal((await runtime.send({ type: 'get_state' })).type, 'state')

  const stale = await runtime.releaseHibernation({
    sessionId: 'session-1', generation: 1, attemptId: 'attempt-1', token: 'stale-token'
  })
  assert.equal(stale.ok, false)
  await assert.rejects(
    runtime.send({ type: 'set_thinking_level', level: 'high' }),
    /hibernate lease is active/u
  )

  const committed = await runtime.commitHibernation({
    sessionId: 'session-1', generation: 1, attemptId: 'attempt-1', token: 'host-token-1234'
  })
  assert.equal(committed.ok, true)
  // Model a stop attempt that failed while the child and RPC transport remain
  // alive. Release must still reach providers rather than clearing only Main's fence.
  ;(runtime as unknown as { stopRequested: boolean }).stopRequested = true
  const released = await runtime.releaseHibernation({
    sessionId: 'session-1', generation: 1, attemptId: 'attempt-1', token: 'host-token-1234'
  })
  assert.equal(released.ok, true)
  assert.equal((runtime as unknown as { stopRequested: boolean }).stopRequested, false)
  await runtime.send({ type: 'set_thinking_level', level: 'high' })
  await runtime.stop()
})

test('queryQuiescence rejects non-finite timeout before prompt', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-gui-quiescence-timeout-bounds-'))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  const extensionPath = join(directory, 'quiescence.ts')
  await writeFile(extensionPath, 'export default () => {}\n')
  const executable = join(directory, 'pi')
  await writeFile(
    executable,
    `#!/usr/bin/env node
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
    if (request.type === 'get_state') {
      process.stdout.write(JSON.stringify({
        type: 'response',
        id: request.id,
        success: true,
        data: {
          thinkingLevel: 'off',
          isStreaming: false,
          isCompacting: false,
          steeringMode: 'all',
          followUpMode: 'all',
          sessionId: 's1',
          autoCompactionEnabled: true,
          messageCount: 0,
          pendingMessageCount: 0
        }
      }) + '\\n')
      continue
    }
    process.stdout.write(JSON.stringify({ type: 'response', id: request.id, success: true }) + '\\n')
  }
})
`,
    { mode: 0o755 }
  )
  const runtime = new LinuxLocalRuntime({
    cwd: directory,
    explicitExecutable: executable,
    noSession: true,
    quiescenceExtensionPath: extensionPath
  })
  await runtime.start()
  const result = await runtime.queryQuiescence({ timeoutMs: Number.POSITIVE_INFINITY })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason, 'malformed')
  await runtime.stop()
})
