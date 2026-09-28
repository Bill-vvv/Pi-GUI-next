import assert from 'node:assert/strict'
import test from 'node:test'
import { createWslDesktopClient, createWslNotificationPresenter } from './wsl-desktop.ts'

test('WSL notification click invokes its Linux callback once and focus is handled on Windows', async () => {
  let click!: () => void
  let dismiss!: () => void
  let activated = 0, focused = 0
  const errors: unknown[] = []
  const host = createWslNotificationPresenter(async (command) => client(command))
  const client = createWslDesktopClient({
    send: async (command) => host.dispatch(command),
    present: async (notification, onClick, onDismiss) => {
      assert.deepEqual(notification, { title: 'Done', body: 'Task finished' })
      click = onClick; dismiss = onDismiss
    },
    focusWindow: () => focused++, onError: (error) => errors.push(error)
  })
  await host.present({ title: 'Done', body: 'Task finished' }, () => activated++)
  click(); click(); dismiss()
  await client({ type: 'window.focus' })
  assert.equal(activated, 1)
  assert.equal(focused, 1)
  assert.deepEqual(errors, [])
  host.close()
})

test('a stale or forged notification cannot activate a Session or expose an arbitrary command', async () => {
  let request: unknown
  let activated = 0
  const host = createWslNotificationPresenter(async (command) => { request = command })
  await host.present({ title: 'Done', body: '' }, () => activated++)
  const id = (request as { id: string }).id
  host.close()
  assert.throws(() => host.dispatch({ type: 'notification.activate', id }), /no longer active/)
  assert.throws(() => host.dispatch({ type: 'kernel.abort', id }), /Invalid WSL notification/)
  assert.equal(activated, 0)
})
