import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test, { type TestContext } from 'node:test'
import { KERNEL_COMMAND_CHANNEL, KERNEL_EVENT_CHANNEL } from '../../shared/kernel-contract.ts'
import { WslPipe } from './wsl-pipe.ts'

const fingerprint = 'a'.repeat(64)

function pair(t: TestContext, dispatch: (channel: string, value: unknown) => unknown | Promise<unknown>, options: {
  hostFingerprint?: string
  timeoutMs?: number
  onEvent?(channel: string, value: unknown): void
} = {}) {
  const toHost = new PassThrough()
  const toClient = new PassThrough()
  const client = new WslPipe({
    input: toClient, output: toHost, fingerprint, platform: 'win32', expectedPlatform: 'linux',
    onEvent: options.onEvent, requestTimeoutMs: options.timeoutMs
  })
  const host = new WslPipe({
    input: toHost, output: toClient, fingerprint: options.hostFingerprint ?? fingerprint,
    platform: 'linux', expectedPlatform: 'win32', dispatch
  })
  t.after(() => { client.close(); host.close() })
  return { client, host, toHost, toClient }
}

test('WSL pipe carries Linux paths and events without translating or executing them on Windows', async (t) => {
  const events: unknown[] = []
  const { client, host } = pair(t, (channel, value) => ({ channel, value }), {
    onEvent: (channel, value) => events.push({ channel, value })
  })
  await Promise.all([client.ready, host.ready])
  const command = { type: 'kernel.activate-project', projectKey: '/home/vvv/中文项目 & files' }
  assert.deepEqual(await client.request(KERNEL_COMMAND_CHANNEL, command), { channel: KERNEL_COMMAND_CHANNEL, value: command })
  host.publish(KERNEL_EVENT_CHANNEL, { type: 'kernel.state-changed', revision: 3 })
  assert.deepEqual(events, [{ channel: KERNEL_EVENT_CHANNEL, value: { type: 'kernel.state-changed', revision: 3 } }])
})

test('WSL pipe refuses a different backend build before any command is dispatched', async (t) => {
  let dispatched = 0
  const { client } = pair(t, () => { dispatched++ }, { hostFingerprint: 'b'.repeat(64) })
  await assert.rejects(client.ready, /mismatch/)
  await assert.rejects(client.request(KERNEL_COMMAND_CHANNEL, {}), /mismatch/)
  assert.equal(dispatched, 0)
})

test('WSL command errors are reported without losing a healthy connection', async (t) => {
  const { client } = pair(t, (_channel, value) => {
    if (value === 'fail') throw new Error('Project no longer exists.')
    return 42
  })
  await assert.rejects(client.request(KERNEL_COMMAND_CHANNEL, 'fail'), /Project no longer exists/)
  assert.equal(await client.request(KERNEL_COMMAND_CHANNEL, 'next'), 42)
  await assert.rejects(client.request('arbitrary-shell', {}), /Unsupported/)
})

test('disconnect rejects in-flight commands and never replays them', async (t) => {
  let dispatched = 0
  let signalDispatch!: () => void
  const started = new Promise<void>((resolve) => { signalDispatch = resolve })
  const { client, host } = pair(t, () => {
    dispatched++
    signalDispatch()
    return new Promise(() => {})
  })
  const request = client.request(KERNEL_COMMAND_CHANNEL, { type: 'kernel.prompt' })
  await started
  host.close()
  await assert.rejects(request, /closed/)
  await assert.rejects(client.request(KERNEL_COMMAND_CHANNEL, {}), /disconnected/)
  assert.equal(dispatched, 1)
})

test('timeout closes the connection instead of silently retrying a mutation', async (t) => {
  let dispatched = 0
  const { client } = pair(t, () => { dispatched++; return new Promise(() => {}) }, { timeoutMs: 25 })
  await assert.rejects(client.request(KERNEL_COMMAND_CHANNEL, {}), /outcome is unknown/)
  assert.equal(dispatched, 1)
  assert.ok(await client.closed)
})

test('malformed protocol input closes the connection', async (t) => {
  const { client, host, toClient } = pair(t, () => null)
  await Promise.all([client.ready, host.ready])
  toClient.write('@pi-gui-wsl@{"version":99,"kind":"event"}\n')
  assert.match((await client.closed)!.message, /version mismatch/)
})

test('UTF-8 split across pipe chunks remains intact', async (t) => {
  const events: unknown[] = []
  const { client, host, toClient } = pair(t, () => null, { onEvent: (_channel, value) => events.push(value) })
  await Promise.all([client.ready, host.ready])
  const bytes = Buffer.from(`@pi-gui-wsl@${JSON.stringify({ version: 1, kind: 'event', channel: KERNEL_EVENT_CHANNEL, value: '中文🚀' })}\n`)
  for (const byte of bytes) toClient.write(Buffer.from([byte]))
  assert.deepEqual(events, ['中文🚀'])
})
