import assert from 'node:assert/strict'
import test from 'node:test'

import { sessionLifecycleLabel } from './features/project/session-lifecycle-presentation.ts'

test('opening a session does not present Runtime startup as active processing', () => {
  assert.equal(sessionLifecycleLabel('starting'), null)
  assert.equal(sessionLifecycleLabel('ready'), null)
  assert.equal(sessionLifecycleLabel('stopped'), null)
  assert.equal(sessionLifecycleLabel('crashed'), null)
})

test('session lifecycle animation is reserved for active processing and shutdown', () => {
  assert.equal(sessionLifecycleLabel('running'), '正在处理')
  assert.equal(sessionLifecycleLabel('stopping'), '正在收尾')
})
