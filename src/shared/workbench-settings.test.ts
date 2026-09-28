import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_APPEARANCE_SETTINGS,
  DEFAULT_GENERAL_SETTINGS,
  DEFAULT_SESSION_NAMING_SETTINGS,
  DEFAULT_SUBAGENT_SETTINGS
} from './kernel-contract.ts'
import {
  isAppearanceSettings,
  isGeneralSettings,
  isGeneralSettingsUpdate,
  isSessionNamingSettings,
  isSubagentSettings
} from './workbench-settings.ts'

test('current settings require exact schemas at every submission boundary', () => {
  for (const [validate, valid] of [
    [isAppearanceSettings, DEFAULT_APPEARANCE_SETTINGS],
    [isGeneralSettingsUpdate, DEFAULT_GENERAL_SETTINGS],
    [isSessionNamingSettings, DEFAULT_SESSION_NAMING_SETTINGS],
    [isSubagentSettings, DEFAULT_SUBAGENT_SETTINGS]
  ] as const) {
    assert.equal(validate(valid), true)
    for (const invalid of [null, [], 'settings', {}, { ...valid, retired: true }]) {
      assert.equal(validate(invalid), false)
    }
  }
  assert.equal(isAppearanceSettings({ ...DEFAULT_APPEARANCE_SETTINGS, theme: 'unknown' }), false)
  assert.equal(isAppearanceSettings({ ...DEFAULT_APPEARANCE_SETTINGS, uiFontFamily: ' ' }), false)
  assert.equal(isSubagentSettings({ maxDepth: 4 }), false)
  assert.equal(isSessionNamingSettings({ mode: 'model', provider: ' ', modelId: 'model' }), false)
  assert.equal(isSessionNamingSettings({ mode: 'model', provider: 'provider', modelId: 'model' }), true)
})

test('auto-continue requires workspace restore for new submissions, while stored preferences remain readable', () => {
  const dormant = {
    ...DEFAULT_GENERAL_SETTINGS,
    startupWorkspaceRestore: 'none',
    autoContinueInterruptedTasks: true
  }
  assert.equal(isGeneralSettings(dormant), true)
  assert.equal(isGeneralSettingsUpdate(dormant), false)
  assert.equal(isGeneralSettingsUpdate({ ...dormant, startupWorkspaceRestore: 'restore' }), true)
  assert.equal(isGeneralSettingsUpdate({ ...dormant, autoContinueInterruptedTasks: false }), true)
})
