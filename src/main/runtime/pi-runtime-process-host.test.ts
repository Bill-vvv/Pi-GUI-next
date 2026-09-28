import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import { createJsonlLogger } from '../utils/jsonl-log.ts'
import { PI_RUNTIME_EXIT_OUTPUT_BACKLOG } from './pi-runtime-protocol.ts'
import { PiRuntimeProcessHost, type PiRuntimeProcessHostOptions } from './pi-runtime-process-host.ts'
import type { RuntimeHost, RuntimeHostEvent } from './runtime-host.ts'

const FIXTURE_ENTRY = fileURLToPath(new URL('./pi-runtime-host-fixture.ts', import.meta.url))

function createHost(
  t: TestContext,
  fixture: string,
  options: Partial<PiRuntimeProcessHostOptions> = {}
): { host: PiRuntimeProcessHost, output: Buffer[] } {
  const output: Buffer[] = []
  const host = new PiRuntimeProcessHost({
    entryPath: FIXTURE_ENTRY,
    env: { ...process.env, PI_RUNTIME_FIXTURE: fixture },
    forwardOutput: (chunk) => output.push(chunk),
    readyTimeoutMs: 20_000,
    ...options
  })
  t.after(async () => { await host.dispose().catch(() => undefined) })
  return { host, output }
}

function runtimeOptions(name: string) {
  return {
    cwd: tmpdir(),
    sessionFile: `/tmp/pi-runtime-process-host-${process.pid}-${name}.jsonl`,
    // The fixture Session answers the quiescence command itself; no Extension is loaded.
    quiescenceExtensionPath: '/fixture/pi-gui-runtime-quiescence',
    extensionPaths: []
  }
}

function collect(runtime: RuntimeHost): RuntimeHostEvent[] {
  const events: RuntimeHostEvent[] = []
  runtime.subscribe((event) => events.push(event))
  return events
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition.')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

test('relays commands, ordered events, extension events and quiescence across the process boundary', async (t) => {
  const logDirectory = await mkdtemp(join(tmpdir(), 'pi-runtime-child-log-'))
  t.after(() => rm(logDirectory, { recursive: true, force: true }))
  const { host } = createHost(t, '', { logDirectory })
  const runtime = host.createRuntime(runtimeOptions('relay'))
  const events = collect(runtime)
  const extensionEvents: unknown[] = []
  runtime.subscribeExtensionEvents?.((event) => extensionEvents.push(event))

  assert.equal(host.getPid(), null, 'the process starts only when a Runtime needs it')
  await runtime.start()
  const pid = host.getPid()
  assert.ok(pid !== null && pid !== process.pid && isAlive(pid))
  assert.equal(runtime.getRpcPid(), null, 'the shared process is not reported as a per-Session PID')
  assert.equal(runtime.getState().executable, '@earendil-works/pi-coding-agent')
  assert.equal(typeof runtime.getState().version, 'string')

  assert.deepEqual(await runtime.send({ type: 'prompt', message: 'hello' }), { type: 'accepted' })
  assert.deepEqual(
    events.map((event) => event.type === 'pi-event' ? event.event.type : event.type),
    ['agent_start', 'message_update', 'agent_settled']
  )
  assert.deepEqual(extensionEvents, [{ type: 'extension_event', channel: 'fixture', data: { ok: true } }])
  assert.deepEqual(await runtime.send({ type: 'get_commands' }), { type: 'commands', commands: [] })
  const state = await runtime.send({ type: 'get_state' })
  assert.ok(state.type === 'state')
  assert.deepEqual(state.state.launchEnvironment, [null, null], 'launch-only variables do not reach Sessions and tools')
  assert.equal((await runtime.getLoadedExtensions()).complete, true)
  const quiescence = await runtime.queryQuiescence({ timeoutMs: 2_000 })
  assert.equal(quiescence.ok, true)

  await runtime.stop()
  await assert.rejects(runtime.send({ type: 'get_state' }), /not running/u)
  await host.dispose()
  assert.equal(host.getPid(), null)
  await waitFor(() => !isAlive(pid))
  const childLog = (await readFile(join(logDirectory, 'pi-runtime.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(childLog.map((record) => record.event), ['ready', 'exit'])
  assert.equal(childLog[0].pid, pid)
})

test('Extension stdout is forwarded as output and cannot corrupt the protocol', async (t) => {
  const { host, output } = createHost(t, 'noisy')
  const runtime = host.createRuntime(runtimeOptions('noisy'))
  await runtime.start()
  assert.deepEqual(await runtime.send({ type: 'prompt', message: 'hi' }), { type: 'accepted' })
  assert.deepEqual(await runtime.send({ type: 'get_commands' }), { type: 'commands', commands: [] })
  await waitFor(() => Buffer.concat(output).toString('utf8').includes('extension output on stdout'))
})

test('a process exit crashes its Runtimes once, never replays, and the next start uses a new process', async (t) => {
  const { host } = createHost(t, 'exit-on-prompt')
  const first = host.createRuntime(runtimeOptions('crash-a'))
  const bystander = host.createRuntime(runtimeOptions('crash-b'))
  const firstEvents = collect(first)
  const bystanderEvents = collect(bystander)
  await first.start()
  await bystander.start()
  const firstPid = host.getPid()

  await assert.rejects(first.send({ type: 'prompt', message: 'boom' }), /process exited \(9\)/u)
  for (const events of [firstEvents, bystanderEvents]) {
    assert.deepEqual(events.filter((event) => event.type === 'process-exit'), [{ type: 'process-exit', code: 9, signal: null }])
  }
  assert.equal(first.getState().exitCode, 9)
  assert.match(bystander.getState().lastError ?? '', /process exited/u)
  assert.equal(host.getPid(), null, 'no background restart')
  await assert.rejects(bystander.send({ type: 'get_state' }), /not running/u)
  const quiescence = await bystander.queryQuiescence()
  assert.equal(quiescence.ok, false)
  await first.stop()
  await bystander.stop()

  const next = host.createRuntime(runtimeOptions('crash-a'))
  await next.start()
  assert.notEqual(host.getPid(), firstPid)
  assert.deepEqual(await next.send({ type: 'get_commands' }), { type: 'commands', commands: [] })
})

test('process starts are limited within the window and resume after it', async (t) => {
  let now = 1_000_000
  const { host } = createHost(t, 'exit-on-prompt', { maxStartsPerWindow: 2, restartWindowMs: 60_000, now: () => now })
  for (const name of ['limit-a', 'limit-b']) {
    const runtime = host.createRuntime(runtimeOptions(name))
    await runtime.start()
    await assert.rejects(runtime.send({ type: 'prompt', message: 'boom' }))
    await runtime.stop()
  }
  const blocked = host.createRuntime(runtimeOptions('limit-c'))
  const blockedEvents = collect(blocked)
  await assert.rejects(blocked.start(), /automatic start is paused/u)
  assert.deepEqual(blockedEvents, [{ type: 'process-exit', code: null, signal: null }])
  assert.match(blocked.getState().lastError ?? '', /automatic start is paused/u)

  now += 60_001
  const resumed = host.createRuntime(runtimeOptions('limit-d'))
  await resumed.start()
  assert.notEqual(host.getPid(), null)
})

test('a failed Session start is reported by the child once and leaves the shared process running', async (t) => {
  const { host } = createHost(t, 'fail-start')
  const runtime = host.createRuntime(runtimeOptions('fail-start'))
  const events = collect(runtime)
  await assert.rejects(runtime.start(), /fixture start failure/u)
  assert.deepEqual(events, [{ type: 'process-exit', code: null, signal: null }])
  assert.match(runtime.getState().lastError ?? '', /fixture start failure/u)
  const pid = host.getPid()
  assert.ok(pid !== null && isAlive(pid))
  await runtime.stop()
})

test('disposal that does not finish is escalated to termination and reported', async (t) => {
  const { host } = createHost(t, 'hang-dispose', { disposeTimeoutMs: 300, killGraceMs: 300 })
  const runtime = host.createRuntime(runtimeOptions('hang'))
  await runtime.start()
  const pid = host.getPid()!
  await assert.rejects(host.dispose(), /did not stop within 0.3 seconds and was terminated/u)
  await waitFor(() => !isAlive(pid))
  assert.throws(() => host.createRuntime(runtimeOptions('after-dispose')), /not accepting/u)
})

test('an unread event backlog beyond the limit ends the process as a Runtime failure', async (t) => {
  const { host } = createHost(t, 'flood')
  const runtime = host.createRuntime(runtimeOptions('flood'))
  const events = collect(runtime)
  await runtime.start()
  await assert.rejects(runtime.send({ type: 'prompt', message: 'flood' }), /process exited/u)
  assert.deepEqual(events.filter((event) => event.type === 'process-exit'), [
    { type: 'process-exit', code: PI_RUNTIME_EXIT_OUTPUT_BACKLOG, signal: null }
  ])
})

test('too many unanswered requests are treated as a process failure and logged', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-runtime-log-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const logger = createJsonlLogger({ directory, name: 'main' })
  const { host } = createHost(t, '', { maxPendingRequests: 1, logger })
  const runtime = host.createRuntime(runtimeOptions('pending'))
  const events = collect(runtime)
  await runtime.start()
  const first = runtime.send({ type: 'get_state' })
  await assert.rejects(runtime.send({ type: 'get_state' }), /stopped responding/u)
  await assert.rejects(first, /process exited/u)
  assert.equal(events.filter((event) => event.type === 'process-exit').length, 1)
  const records = (await readFile(join(directory, 'main.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(records.map((record) => record.event), ['spawn', 'ready', 'pending-request-limit', 'exit'])
  assert.equal(JSON.stringify(records).includes('pi-runtime-process-host-'), false, 'no session paths in the log')
})
