import assert from 'node:assert/strict'
import test from 'node:test'

import { shouldAbortComposerFromEscape } from './composer-escape.ts'

const enabledEscape = {
  enabled: true,
  running: true,
  key: 'Escape',
  defaultPrevented: false,
  isComposing: false,
  keyCode: 27
}

test('Composer global Escape abort requires an enabled running context', () => {
  assert.equal(shouldAbortComposerFromEscape(enabledEscape), true)
  assert.equal(shouldAbortComposerFromEscape({ ...enabledEscape, enabled: false }), false)
  assert.equal(shouldAbortComposerFromEscape({ ...enabledEscape, running: false }), false)
  assert.equal(shouldAbortComposerFromEscape({ ...enabledEscape, key: 'Enter' }), false)
})

test('Composer global Escape abort yields to handled and composing surfaces', () => {
  assert.equal(shouldAbortComposerFromEscape({ ...enabledEscape, defaultPrevented: true }), false)
  assert.equal(shouldAbortComposerFromEscape({ ...enabledEscape, isComposing: true }), false)
  assert.equal(shouldAbortComposerFromEscape({ ...enabledEscape, keyCode: 229 }), false)
})
