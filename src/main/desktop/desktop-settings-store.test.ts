import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDesktopSettingsStore } from './desktop-settings-store.ts'
import { DEFAULT_APPEARANCE_SETTINGS } from '../../shared/kernel-contract.ts'
import { DEFAULT_SHORTCUT_SETTINGS } from '../../shared/shortcut-settings.ts'
import { isDesktopEnvironment, withDesktopPreferences } from '../../shared/desktop-settings-contract.ts'
import type { KernelState } from '../../shared/kernel-contract.ts'
import { isDesktopClientCommand } from '../../shared/desktop-client-contract.ts'

test('device preferences migrate once, survive environment changes and serialize independent updates', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-gui-desktop-settings-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const file = join(directory, 'settings.json')
  const store = createDesktopSettingsStore(file)
  assert.equal((await store.load()).preferences, null)
  const seed = { appearance: DEFAULT_APPEARANCE_SETTINGS, shortcuts: DEFAULT_SHORTCUT_SETTINGS, doubleClickBorderMaximize: true }
  await store.initializePreferences(seed)
  await Promise.all([
    store.setEnvironment({ mode: 'wsl', distribution: 'Ubuntu-24.04' }),
    store.updatePreferences({ appearance: { ...DEFAULT_APPEARANCE_SETTINGS, uiFontFamily: 'Windows Font' } }),
    store.updatePreferences({ doubleClickBorderMaximize: false })
  ])
  const again = createDesktopSettingsStore(file)
  const preferences = await again.initializePreferences(seed)
  assert.equal(preferences.appearance.uiFontFamily, 'Windows Font')
  assert.equal(preferences.doubleClickBorderMaximize, false)
  await again.setEnvironment({ mode: 'ssh' })
  assert.deepEqual((await again.load()).preferences, preferences)
  const host = { appearance: seed.appearance, shortcuts: seed.shortcuts, general: { doubleClickBorderMaximize: true, startupWorkspaceRestore: 'restore' }, activeSessionKey: 'session-a' } as KernelState
  const view = withDesktopPreferences(host, preferences)
  assert.equal(host.appearance.uiFontFamily, null)
  assert.equal(host.general.doubleClickBorderMaximize, true)
  assert.equal(view.activeSessionKey, host.activeSessionKey)
  assert.equal(view.general.startupWorkspaceRestore, 'restore')
  assert.equal(view.appearance.uiFontFamily, 'Windows Font')
  await writeFile(file, '{"version":999}')
  await assert.rejects(again.load(), /Invalid desktop settings/)
})

test('environment selection rejects raw commands, extra fields and invalid distro names', () => {
  assert.equal(isDesktopClientCommand({ type: 'desktop-client.get-preferences' }), true)
  assert.equal(isDesktopClientCommand({ type: 'desktop-client.get-preferences', seed: null }), false)
  assert.equal(isDesktopClientCommand({ type: 'desktop-client.get-preferences', extra: true }), false)
  assert.equal(isDesktopEnvironment({ mode: 'wsl', distribution: 'Ubuntu-24.04' }), true)
  for (const value of [{ mode: 'wsl', distribution: '-exec' }, { mode: 'wsl', distribution: 'Ubuntu; exit' }, { mode: 'ssh', command: 'anything' }]) assert.equal(isDesktopEnvironment(value), false)
})
