import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { shouldAbortComposerFromEscape } from './composer-escape.ts'

const composerSource = readFileSync(new URL('./Composer.tsx', import.meta.url), 'utf8')

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

test('Composer owns abort failures for both the button and global Escape path', () => {
  assert.match(composerSource, /const abortRuntime = useCallback/)
  assert.match(composerSource, /setCommandError\(errorMessage\(error\)\)/)
  assert.equal(composerSource.match(/void abortRuntime\(\)/g)?.length, 2)
  assert.doesNotMatch(composerSource, /onAbort\(\)\.catch\(\(\) => undefined\)/)
})
