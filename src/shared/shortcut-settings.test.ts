import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_SHORTCUT_SETTINGS,
  copyShortcutSettings,
  findShortcutSettingsIssue,
  shortcutBindingFromKeyboardInput
} from './shortcut-settings.ts'

test('defaults match the fixed S15 application shortcut table', () => {
  assert.deepEqual(DEFAULT_SHORTCUT_SETTINGS, {
    'new-session': 'Ctrl+N',
    'focus-composer': 'Ctrl+L',
    'open-settings': 'Ctrl+,',
    'open-model-selector': null,
    'reload-session': null,
    'previous-project': null,
    'next-project': null,
    'previous-session': 'Ctrl+PageUp',
    'next-session': 'Ctrl+PageDown',
    'archive-session': null,
    'copy-last-answer': null
  })
  assert.equal(findShortcutSettingsIssue(DEFAULT_SHORTCUT_SETTINGS), null)
})

test('normalizes supported key input and ignores composing, editing, and Meta input', () => {
  assert.equal(shortcutBindingFromKeyboardInput({
    key: ',',
    code: 'Comma',
    ctrlKey: true,
    altKey: false,
    shiftKey: false,
    metaKey: false
  }), 'Ctrl+,')
  assert.equal(shortcutBindingFromKeyboardInput({
    key: 'PageDown',
    ctrlKey: true,
    altKey: false,
    shiftKey: false,
    metaKey: false
  }), 'Ctrl+PageDown')
  assert.equal(shortcutBindingFromKeyboardInput({
    key: 'Enter',
    ctrlKey: true,
    altKey: false,
    shiftKey: false,
    metaKey: false
  }), null)
  assert.equal(shortcutBindingFromKeyboardInput({
    key: 'n',
    code: 'KeyN',
    ctrlKey: true,
    altKey: false,
    shiftKey: false,
    metaKey: true
  }), null)
  assert.equal(shortcutBindingFromKeyboardInput({
    key: 'n',
    code: 'KeyN',
    ctrlKey: true,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    isComposing: true
  }), null)
})

test('rejects reserved, duplicate, malformed, and incomplete settings', () => {
  const reserved = copyShortcutSettings(DEFAULT_SHORTCUT_SETTINGS)
  reserved['new-session'] = 'Ctrl+R'
  assert.deepEqual(findShortcutSettingsIssue(reserved), {
    type: 'reserved-binding',
    actionId: 'new-session',
    binding: 'Ctrl+R'
  })

  const duplicate = copyShortcutSettings(DEFAULT_SHORTCUT_SETTINGS)
  duplicate['open-model-selector'] = 'Ctrl+N'
  assert.deepEqual(findShortcutSettingsIssue(duplicate), {
    type: 'duplicate-binding',
    actionId: 'open-model-selector',
    conflictingActionId: 'new-session',
    binding: 'Ctrl+N'
  })

  const malformed = copyShortcutSettings(DEFAULT_SHORTCUT_SETTINGS)
  malformed['new-session'] = 'ctrl+n'
  assert.equal(findShortcutSettingsIssue(malformed)?.type, 'invalid-binding')
  assert.equal(findShortcutSettingsIssue({})?.type, 'invalid-shape')
})
