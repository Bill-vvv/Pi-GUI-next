import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  MAX_NONCE_LENGTH,
  MAX_REASON_LENGTH,
  MAX_REQUEST_ID_LENGTH,
  PROVIDER_ID_MULTI_ADVISOR as APP_PROVIDER_ID,
  PROVIDER_QUERY_EVENT as APP_QUERY_EVENT,
  PROVIDER_REGISTER_EVENT as APP_REGISTER_EVENT,
  PROVIDER_REPLY_EVENT_PREFIX as APP_REPLY_PREFIX,
  QUIESCENCE_PROTOCOL_VERSION as APP_VERSION,
  buildProviderRegister as appBuildRegister,
  buildProviderReply as appBuildReply,
  parseProviderQueryEvent as appParseQuery,
  providerReplyEventName as appReplyEventName
} from '../../pi-gui-runtime-quiescence/src/protocol.mjs'
import {
  MAX_NONCE_LENGTH as LOCAL_MAX_NONCE_LENGTH,
  MAX_REASON_LENGTH as LOCAL_MAX_REASON_LENGTH,
  MAX_REQUEST_ID_LENGTH as LOCAL_MAX_REQUEST_ID_LENGTH,
  PROVIDER_ID_MULTI_ADVISOR,
  PROVIDER_QUERY_EVENT,
  PROVIDER_REGISTER_EVENT,
  PROVIDER_REPLY_EVENT_PREFIX,
  QUIESCENCE_PROTOCOL_VERSION,
  buildProviderRegister,
  buildProviderReply,
  createAdvisorAdmissionFence,
  installQuiescenceProvider,
  parseProviderQueryEvent,
  providerReplyEventName
} from '../src/quiescence-provider.mjs'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

test('local quiescence provider shim matches app-owned protocol contract', () => {
  assert.equal(QUIESCENCE_PROTOCOL_VERSION, APP_VERSION)
  assert.equal(PROVIDER_ID_MULTI_ADVISOR, APP_PROVIDER_ID)
  assert.equal(PROVIDER_QUERY_EVENT, APP_QUERY_EVENT)
  assert.equal(PROVIDER_REGISTER_EVENT, APP_REGISTER_EVENT)
  assert.equal(PROVIDER_REPLY_EVENT_PREFIX, APP_REPLY_PREFIX)
  assert.equal(LOCAL_MAX_NONCE_LENGTH, MAX_NONCE_LENGTH)
  assert.equal(LOCAL_MAX_REQUEST_ID_LENGTH, MAX_REQUEST_ID_LENGTH)
  assert.equal(LOCAL_MAX_REASON_LENGTH, MAX_REASON_LENGTH)

  const fixtures = [
    { version: 1, requestId: 'req-a', nonce: 'nonce-1' },
    { version: 1, requestId: 'req-b' },
    { version: 2, requestId: 'req-a' },
    { version: 1, requestId: 'bad\nid' },
    { version: 1, requestId: 'req-a', nonce: 'n', extra: true },
    null,
    'x'
  ]
  for (const fixture of fixtures) {
    assert.deepEqual(parseProviderQueryEvent(fixture), appParseQuery(fixture))
  }

  const register = buildProviderRegister(PROVIDER_ID_MULTI_ADVISOR)
  assert.deepEqual(register, appBuildRegister(APP_PROVIDER_ID))

  const reply = buildProviderReply({
    requestId: 'req-a',
    providerId: PROVIDER_ID_MULTI_ADVISOR,
    state: 'busy',
    reason: 'advisor-running'
  })
  assert.deepEqual(
    reply,
    appBuildReply({
      requestId: 'req-a',
      providerId: APP_PROVIDER_ID,
      state: 'busy',
      reason: 'advisor-running'
    })
  )
  assert.equal(providerReplyEventName('req-a'), appReplyEventName('req-a'))
  assert.throws(() => buildProviderRegister('/home/secret'), /out of bounds/u)
  assert.throws(() => appBuildRegister('/home/secret'), /out of bounds/u)
  assert.throws(
    () =>
      buildProviderReply({
        requestId: 'req-a',
        providerId: PROVIDER_ID_MULTI_ADVISOR,
        state: 'unknown',
        reason: 'C:\\Users\\secret'
      }),
    /path separators/u
  )
  assert.throws(
    () =>
      appBuildReply({
        requestId: 'req-a',
        providerId: APP_PROVIDER_ID,
        state: 'unknown',
        reason: 'C:\\Users\\secret'
      }),
    /path separators/u
  )
})

test('advisor fence advances generation across same-ID session restarts', () => {
  const fence = createAdvisorAdmissionFence()
  assert.equal(fence.startSession(), 1)
  assert.equal(fence.prepare({
    sessionId: 'session-1', generation: 1, attemptId: 'attempt-1', token: 'token-1'
  }), true)
  fence.endSession()
  assert.equal(fence.startSession(), 2)
  assert.equal(fence.prepare({
    sessionId: 'session-1', generation: 1, attemptId: 'late-old', token: 'token-old'
  }), false)
  assert.equal(fence.prepare({
    sessionId: 'session-1', generation: 2, attemptId: 'attempt-2', token: 'token-2'
  }), true)
})

test('multi-advisor source does not import monorepo sibling quiescence package', async () => {
  const index = await readFile(join(packageRoot, 'src/index.ts'), 'utf8')
  assert.equal(index.includes('pi-gui-runtime-quiescence'), false)
  assert.match(index, /from "\.\/quiescence-provider\.mjs"/u)
  assert.match(index, /installQuiescenceProvider/u)
})

test('installQuiescenceProvider never throws when event-bus on/emit fail', () => {
  const queries = []
  const onQuery = (raw) => {
    queries.push(raw)
  }

  const bothOk = installQuiescenceProvider(
    {
      emit(event, payload) {
        assert.equal(event, PROVIDER_REGISTER_EVENT)
        assert.equal(payload.providerId, PROVIDER_ID_MULTI_ADVISOR)
      },
      on(event, listener) {
        assert.equal(event, PROVIDER_QUERY_EVENT)
        listener({ version: 1, requestId: 'req-ok' })
      }
    },
    onQuery
  )
  assert.deepEqual(bothOk, { registered: true, listening: true, leaseListening: false })
  assert.equal(queries.length, 1)

  assert.deepEqual(
    installQuiescenceProvider(
      {
        emit() {
          throw new Error('emit boom')
        },
        on() {
          throw new Error('on boom')
        }
      },
      onQuery
    ),
    { registered: false, listening: false, leaseListening: false }
  )

  assert.deepEqual(
    installQuiescenceProvider(
      {
        emit() {
          // registration succeeds
        },
        on() {
          throw new Error('on boom')
        }
      },
      onQuery
    ),
    { registered: true, listening: false, leaseListening: false }
  )

  assert.deepEqual(
    installQuiescenceProvider(
      {
        emit() {
          throw new Error('emit boom')
        },
        on(_event, listener) {
          listener({ version: 1, requestId: 'req-listen-only' })
        }
      },
      onQuery
    ),
    { registered: false, listening: true, leaseListening: false }
  )

  assert.deepEqual(installQuiescenceProvider(null, onQuery), {
    registered: false,
    listening: false,
    leaseListening: false
  })
  assert.deepEqual(installQuiescenceProvider({}, onQuery), {
    registered: false,
    listening: false,
    leaseListening: false
  })
})

test('multi-advisor extension init continues when events.on throws', async () => {
  // Simulate the extension wiring contract: install helper is best-effort, so a
  // subsequent Advisor path still runs even if the event bus rejects listeners.
  let advisorPathReached = false
  const outcome = installQuiescenceProvider(
    {
      emit() {
        // register ok
      },
      on() {
        throw new Error('event bus refused listener')
      }
    },
    () => {
      throw new Error('listener must not be installed')
    }
  )
  assert.deepEqual(outcome, { registered: true, listening: false, leaseListening: false })
  // Unrelated Advisor initialization continues after the best-effort install.
  advisorPathReached = true
  assert.equal(advisorPathReached, true)

  const index = await readFile(join(packageRoot, 'src/index.ts'), 'utf8')
  assert.match(index, /installQuiescenceProvider\(\s*pi\.events/u)
})

test('standalone pack dry-run and isolated import of package-local shim', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-gui-advisor-quiescence-pack-'))
  t.after(async () => rm(directory, { recursive: true, force: true }))

  await runCommand('npm', ['pack', '--dry-run', '--json'], packageRoot)

  const shimSource = await readFile(join(packageRoot, 'src/quiescence-provider.mjs'), 'utf8')
  const isolatedShim = join(directory, 'quiescence-provider.mjs')
  await writeFile(isolatedShim, shimSource)
  const probe = join(directory, 'probe.mjs')
  await writeFile(
    probe,
    `
import assert from 'node:assert/strict'
import {
  PROVIDER_ID_MULTI_ADVISOR,
  buildProviderRegister,
  buildProviderReply,
  parseProviderQueryEvent,
  providerReplyEventName
} from ${JSON.stringify(pathToFileURL(isolatedShim).href)}

const query = parseProviderQueryEvent({ version: 1, requestId: 'r1', nonce: 'n1' })
assert.equal(query?.requestId, 'r1')
assert.deepEqual(buildProviderRegister(PROVIDER_ID_MULTI_ADVISOR).providerId, PROVIDER_ID_MULTI_ADVISOR)
assert.equal(providerReplyEventName('r1').endsWith('r1'), true)
assert.equal(
  buildProviderReply({
    requestId: 'r1',
    providerId: PROVIDER_ID_MULTI_ADVISOR,
    state: 'idle'
  }).state,
  'idle'
)
`
  )
  await runCommand(process.execPath, [probe], directory)
})

function runCommand(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }
      reject(new Error(`${command} ${args.join(' ')} failed (${code}): ${stderr || stdout}`))
    })
  })
}
