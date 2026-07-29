import assert from 'node:assert/strict'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  buildNotifySendArguments,
  createDesktopNotificationBroker,
  createNotifySendPresenter,
  resolveDesktopNotificationSocketPath,
  type DesktopNotificationPresenter
} from './desktop-notification-broker.ts'

const TOKEN = 'test-token-that-is-at-least-thirty-two-characters'

function requestBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    token: TOKEN,
    title: 'Pi · Session · 已完成',
    body: '<b>✓ 任务已完成</b>',
    projectPath: '/tmp/project',
    sessionKey: '/tmp/session.jsonl',
    ...overrides
  }
}

test('desktop notification broker validates, presents, and activates an exact target', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-gui-notification-broker-'))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  const socketPath = join(directory, 'runtime', 'notification.sock')
  const activations: Array<() => void> = []
  const activated: Array<{ projectPath: string, sessionKey: string }> = []
  const presenter: DesktopNotificationPresenter = {
    async present(notification, onActivate) {
      assert.equal(notification.title, 'Pi · Session · 已完成')
      assert.equal(notification.body, '<b>✓ 任务已完成</b>')
      activations.push(onActivate)
    },
    close() {}
  }
  const broker = createDesktopNotificationBroker({
    socketPath,
    token: TOKEN,
    iconPath: '/tmp/pi.png',
    presenter,
    async activateTarget(target) {
      activated.push(target)
    }
  })
  await broker.start()

  assert.deepEqual(await sendRequest(socketPath, requestBody()), { version: 1, ok: true })
  assert.equal(activations.length, 1)
  activations[0]!()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(activated, [{
    projectPath: '/tmp/project',
    sessionKey: '/tmp/session.jsonl'
  }])

  await broker.close()
  await broker.close()
  await assert.rejects(access(socketPath))
})

test('desktop notification broker rejects invalid credentials and schema before presentation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-gui-notification-reject-'))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  const socketPath = join(directory, 'notification.sock')
  let presentationCount = 0
  const broker = createDesktopNotificationBroker({
    socketPath,
    token: TOKEN,
    iconPath: '/tmp/pi.png',
    presenter: {
      async present() {
        presentationCount += 1
      },
      close() {}
    },
    async activateTarget() {}
  })
  await broker.start()
  t.after(() => broker.close())

  assert.deepEqual(
    await sendRequest(socketPath, requestBody({ token: 'wrong-token-that-is-still-long-enough' })),
    { version: 1, ok: false, error: 'invalid-request' }
  )
  assert.deepEqual(
    await sendRequest(socketPath, requestBody({ projectPath: 'relative/project' })),
    { version: 1, ok: false, error: 'invalid-request' }
  )
  assert.deepEqual(
    await sendRequest(socketPath, { ...requestBody(), extra: true }),
    { version: 1, ok: false, error: 'invalid-request' }
  )
  assert.equal(presentationCount, 0)
})

test('notify-send arguments use a default action without shell interpolation', () => {
  const arguments_ = buildNotifySendArguments(
    { title: 'Pi · 已完成', body: '<b>✓ 完成</b>' },
    '/tmp/pi-notify.png'
  )
  assert.deepEqual(arguments_.slice(-6), [
    '--action',
    'default=打开对话',
    '--wait',
    '--print-id',
    'Pi · 已完成',
    '<b>✓ 完成</b>'
  ])
  assert.equal(arguments_.includes('--action'), true)
  assert.equal(arguments_.includes('default=打开对话'), true)
  assert.equal(arguments_.includes('/tmp/pi-notify.png'), true)
})

test('notify-send presenter waits for server acknowledgement and reports the default action', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-gui-notify-send-'))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  const acceptedExecutable = join(directory, 'accepted-notify-send')
  const rejectedExecutable = join(directory, 'rejected-notify-send')
  await writeFile(
    acceptedExecutable,
    `#!/usr/bin/env node\nprocess.stdout.write('42\\n')\nsetTimeout(() => { process.stdout.write('default\\n'); process.exit(0) }, 20)\n`,
    { mode: 0o755 }
  )
  await writeFile(
    rejectedExecutable,
    `#!/usr/bin/env node\nprocess.exit(3)\n`,
    { mode: 0o755 }
  )

  let activationCount = 0
  const acceptedPresenter = createNotifySendPresenter('/tmp/pi.png', acceptedExecutable)
  await acceptedPresenter.present(
    { title: 'Pi · 已完成', body: '完成' },
    () => { activationCount += 1 }
  )
  await new Promise<void>((resolve) => setTimeout(resolve, 50))
  assert.equal(activationCount, 1)
  acceptedPresenter.close()

  const rejectedPresenter = createNotifySendPresenter('/tmp/pi.png', rejectedExecutable)
  await assert.rejects(
    rejectedPresenter.present({ title: 'Pi · 已完成', body: '完成' }, () => {}),
    /before acknowledgement/u
  )
  rejectedPresenter.close()
})

test('broker close waits for an activation already in progress', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-gui-notification-drain-'))
  t.after(async () => rm(directory, { recursive: true, force: true }))
  const socketPath = join(directory, 'notification.sock')
  const activations: Array<() => void> = []
  let releaseActivation: (() => void) | undefined
  let markActivationStarted: (() => void) | undefined
  const activationStarted = new Promise<void>((resolve) => { markActivationStarted = resolve })
  const activationReleased = new Promise<void>((resolve) => { releaseActivation = resolve })
  const broker = createDesktopNotificationBroker({
    socketPath,
    token: TOKEN,
    iconPath: '/tmp/pi.png',
    presenter: {
      async present(_notification, onActivate) {
        activations.push(onActivate)
      },
      close() {}
    },
    async activateTarget() {
      markActivationStarted?.()
      await activationReleased
    }
  })
  await broker.start()
  assert.deepEqual(await sendRequest(socketPath, requestBody()), { version: 1, ok: true })
  activations[0]!()
  await activationStarted

  let closed = false
  const closing = broker.close().then(() => { closed = true })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(closed, false)
  releaseActivation?.()
  await closing
  assert.equal(closed, true)
})

test('notification socket path uses the private XDG runtime directory with a safe fallback', () => {
  assert.equal(
    resolveDesktopNotificationSocketPath({ XDG_RUNTIME_DIR: '/run/user/1234' }, 1234),
    '/run/user/1234/pi-gui-next/desktop-notification.sock'
  )
  assert.equal(
    resolveDesktopNotificationSocketPath({ XDG_RUNTIME_DIR: 'relative' }, 1234),
    join(tmpdir(), 'pi-gui-next-1234', 'pi-gui-next', 'desktop-notification.sock')
  )
})

function sendRequest(
  socketPath: string,
  request: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    socket.setEncoding('utf8')
    let output = ''
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`))
    socket.on('data', (chunk: string) => {
      output += chunk
    })
    socket.on('end', () => {
      try {
        resolve(JSON.parse(output.trim()) as Record<string, unknown>)
      } catch (error) {
        reject(error)
      }
    })
    socket.on('error', reject)
  })
}
