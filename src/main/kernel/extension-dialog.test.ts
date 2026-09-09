import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertExtensionDialogResponse,
  normalizeExtensionDialogRequest
} from './extension-dialog.ts'

test('normalizes bounded Extension command dialog requests', () => {
  assert.deepEqual(normalizeExtensionDialogRequest({
    type: 'extension_ui_request',
    id: 'select-1',
    commandInvocationId: 'invoke-1',
    commandName: 'search',
    method: 'select',
    title: 'Choose',
    options: ['One', 'Two']
  }), {
    requestId: 'select-1',
    commandInvocationId: 'invoke-1',
    commandName: 'search',
    method: 'select',
    title: 'Choose',
    message: null,
    options: ['One', 'Two'],
    placeholder: null,
    prefill: null
  })

  assert.deepEqual(normalizeExtensionDialogRequest({
    type: 'extension_ui_request',
    id: 'confirm-1',
    commandInvocationId: 'invoke-2',
    commandName: 'goal',
    method: 'confirm',
    title: '',
    message: 'Replace the active goal?'
  }), {
    requestId: 'confirm-1',
    commandInvocationId: 'invoke-2',
    commandName: 'goal',
    method: 'confirm',
    title: '',
    message: 'Replace the active goal?',
    options: [],
    placeholder: null,
    prefill: null
  })

  assert.equal(normalizeExtensionDialogRequest({
    type: 'extension_ui_request',
    id: 'tool-request',
    method: 'input',
    title: 'Unknown owner'
  }), null)
  assert.equal(normalizeExtensionDialogRequest({
    type: 'extension_ui_request',
    id: 'duplicate-options',
    commandInvocationId: 'invoke-3',
    commandName: 'search',
    method: 'select',
    title: 'Choose',
    options: ['Same', 'Same']
  }), null)
})

test('validates responses against the exact dialog method', () => {
  assert.doesNotThrow(() => assertExtensionDialogResponse({
    method: 'select',
    options: ['One', 'Two']
  }, 'Two'))
  assert.throws(() => assertExtensionDialogResponse({
    method: 'select',
    options: ['One', 'Two']
  }, 'Three'), /not one of the offered options/u)

  assert.doesNotThrow(() => assertExtensionDialogResponse({
    method: 'confirm',
    options: []
  }, 'false'))
  assert.throws(() => assertExtensionDialogResponse({
    method: 'confirm',
    options: []
  }, 'yes'), /must be true or false/u)

  assert.doesNotThrow(() => assertExtensionDialogResponse({
    method: 'editor',
    options: []
  }, ''))
  assert.throws(() => assertExtensionDialogResponse({
    method: 'input',
    options: []
  }, '\0'), /malformed/u)
})
