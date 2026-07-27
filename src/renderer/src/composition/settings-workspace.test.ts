import assert from 'node:assert/strict'
import test from 'node:test'

import {
  canLeaveSettingsPage,
  hasUnsavedSettingsDraft,
  settingsLeaveConfirmation
} from '../features/settings/settings-workspace.ts'

test('Subagent draft requires confirmation before leaving settings', () => {
  const dirty = hasUnsavedSettingsDraft(
    { name: 'reviewer', systemPrompt: 'Review the change.' },
    { name: 'reviewer', systemPrompt: 'Review the code.' }
  )
  const confirmations: string[] = []

  assert.equal(dirty, true)
  assert.equal(canLeaveSettingsPage(
    { dirty, activeOperation: false },
    (message) => {
      confirmations.push(message)
      return false
    }
  ), false)
  assert.deepEqual(confirmations, ['放弃尚未保存的设置修改？'])
})

test('unchanged Provider draft can leave without confirmation', () => {
  const draft = { id: 'provider', baseUrl: 'https://example.com', models: [{ id: 'model' }] }
  let confirmations = 0

  assert.equal(hasUnsavedSettingsDraft(draft, { ...draft }), false)
  assert.equal(canLeaveSettingsPage(
    { dirty: false, activeOperation: false },
    () => {
      confirmations += 1
      return false
    }
  ), true)
  assert.equal(confirmations, 0)
})

test('changed Provider draft is protected on section change or settings close', () => {
  const dirty = hasUnsavedSettingsDraft(
    { id: 'provider', baseUrl: 'https://new.example.com' },
    { id: 'provider', baseUrl: 'https://example.com' }
  )

  assert.equal(dirty, true)
  assert.equal(canLeaveSettingsPage(
    { dirty, activeOperation: false },
    () => true
  ), true)
})

test('active credential operation warns that leaving cancels login', () => {
  const lifecycle = { dirty: false, activeOperation: true }
  const message = settingsLeaveConfirmation(lifecycle)

  assert.equal(message, '登录仍在进行。离开设置会取消登录，是否继续？')
  assert.equal(canLeaveSettingsPage(lifecycle, () => false), false)
  assert.equal(canLeaveSettingsPage(lifecycle, () => true), true)
})

test('dirty credentials page with active login uses one combined confirmation', () => {
  assert.equal(
    settingsLeaveConfirmation({ dirty: true, activeOperation: true }),
    '当前设置有尚未保存的修改，且登录仍在进行。离开将放弃修改并取消登录，是否继续？'
  )
})
