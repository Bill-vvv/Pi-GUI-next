import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { Notification } from 'electron'
import { createElectronNotifications } from './electron-notifications.ts'
import { DESKTOP_NOTIFICATION_ACTION_LIFETIME_MS } from '../notification/desktop-notification-broker.ts'
import { createWslDesktopClient, createWslNotificationPresenter } from '../remote/wsl-desktop.ts'

function notifications() {
  const instances: FakeNotification[] = []
  class FakeNotification extends EventEmitter {
    static isSupported() { return true }
    closed = 0
    constructor() { super(); instances.push(this) }
    show() { this.emit('show', {}) }
    close() { this.closed++; this.emit('close', { reason: 'applicationHidden' }) }
  }
  const presenter = createElectronNotifications(FakeNotification as unknown as typeof Notification)
  return { presenter, instances }
}

test('Windows banner timeout preserves its WSL conversation action beyond twelve seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { presenter, instances } = notifications()
  let activated = 0
  const errors: unknown[] = []
  const host = createWslNotificationPresenter(async (command) => client(command))
  const client = createWslDesktopClient({
    present: presenter.present,
    send: async (command) => host.dispatch(command),
    focusWindow() {},
    onError: (error) => errors.push(error)
  })
  t.after(() => { presenter.close(); host.close() })
  await host.present({ title: 'Complete', body: 'Return to the conversation' }, () => activated++)
  const toast = instances[0]!
  toast.emit('close', { reason: 'timedOut' })
  t.mock.timers.tick(30_000)
  assert.equal(toast.closed, 0)
  toast.emit('click', {})
  toast.emit('click', {})
  await Promise.resolve()
  assert.equal(activated, 1)
  assert.equal(toast.closed, 1)
  assert.deepEqual(errors, [])
})

test('dismissal and action expiry release notification callbacks exactly once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { presenter, instances } = notifications()
  let activated = 0, dismissed = 0
  t.after(() => presenter.close())
  for (let i = 0; i < 2; i++) {
    await presenter.present({ title: 'Done', body: '' }, () => activated++, () => dismissed++)
  }
  instances[0]!.emit('close', { reason: 'timedOut' })
  instances[0]!.emit('close', { reason: 'userCanceled' })
  assert.equal(dismissed, 1)
  instances[1]!.emit('close', { reason: 'timedOut' })
  t.mock.timers.tick(DESKTOP_NOTIFICATION_ACTION_LIFETIME_MS)
  assert.equal(dismissed, 2)
  for (const toast of instances) {
    toast.emit('click', {})
    assert.equal(toast.closed, 1)
    assert.equal(toast.eventNames().length, 0)
  }
  presenter.close()
  assert.equal(activated, 0)
  assert.equal(dismissed, 2)
})

test('client shutdown removes retained notifications without sending to the closing Host', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { presenter, instances } = notifications()
  let dismissed = 0
  await presenter.present({ title: 'Done', body: '' }, () => assert.fail('closed client activated'), () => dismissed++)
  instances[0]!.emit('close', { reason: 'timedOut' })
  presenter.close()
  instances[0]!.emit('click', {})
  t.mock.timers.tick(DESKTOP_NOTIFICATION_ACTION_LIFETIME_MS)
  assert.equal(instances[0]!.closed, 1)
  assert.equal(dismissed, 0)
})
