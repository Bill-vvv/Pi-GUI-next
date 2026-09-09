import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const NAV_PATH = new URL('./SettingsNavigation.tsx', import.meta.url)
const PANEL_PATH = new URL('./SettingsPanel.tsx', import.meta.url)

test('settings navigation groups current pages and drops leftover preferences', async () => {
  const [nav, panel] = await Promise.all([
    readFile(NAV_PATH, 'utf8'),
    readFile(PANEL_PATH, 'utf8')
  ])

  assert.match(nav, /id:\s*'app'[\s\S]*label:\s*'应用'/u)
  assert.match(nav, /id:\s*'models'[\s\S]*label:\s*'模型'/u)
  assert.match(nav, /id:\s*'remote'[\s\S]*label:\s*'远程访问'[\s\S]*section:\s*'remote'/u)
  assert.match(nav, /id:\s*'agent'[\s\S]*label:\s*'Agent'/u)
  assert.match(nav, /id:\s*'ecosystem'[\s\S]*label:\s*'生态'/u)
  assert.match(nav, /role="group"/u)
  assert.match(nav, /section:\s*'shortcuts'[\s\S]*icon:\s*'shortcuts'/u)
  assert.match(nav, /section:\s*'credentials'[\s\S]*icon:\s*'credentials'/u)
  assert.doesNotMatch(nav, /icon:\s*'preferences'/u)
  assert.doesNotMatch(nav, /section:\s*'preferences'/u)
  assert.doesNotMatch(nav, /label:\s*'偏好'/u)
  assert.doesNotMatch(nav, /Advisor/u)

  assert.match(panel, /section === 'general'/u)
  assert.match(panel, /htmlFor="session-naming-mode"/u)
  assert.match(panel, /id="settings-session-naming"/u)
  assert.doesNotMatch(panel, /section === 'preferences'/u)
  assert.doesNotMatch(panel, />偏好</u)
})

test('settings resource pages share one row template', async () => {
  const [panel, credentials, packages, catalog, skills] = await Promise.all([
    readFile(PANEL_PATH, 'utf8'),
    readFile(new URL('./CredentialsPanel.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./InstalledPackages.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./PiDevCatalog.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./SkillSettings.tsx', import.meta.url), 'utf8')
  ])

  for (const source of [panel, credentials, packages, catalog, skills]) {
    assert.match(source, /settings-resource-row/u)
  }
  assert.doesNotMatch(credentials, /credential-card|credential-details/u)
  assert.doesNotMatch(packages, /settings-package-item/u)
  assert.doesNotMatch(catalog, /settings-pi-dev-item/u)
  assert.doesNotMatch(skills, /settings-skill-item/u)
  assert.doesNotMatch(panel, /settings-extension-list/u)
})

test('shortcuts and remote access reuse the compact preference row rhythm', async () => {
  const [shortcuts, remote, desktop] = await Promise.all([
    readFile(new URL('./ShortcutSettingsPanel.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./RemoteAccessPanel.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./DesktopHostAccessPanel.tsx', import.meta.url), 'utf8')
  ])
  assert.match(shortcuts, /settings-prefs/u)
  assert.match(shortcuts, /className="settings-row"/u)
  assert.doesNotMatch(shortcuts, /shortcut-settings-list|shortcut-settings-row/u)
  assert.match(remote, /settings-prefs/u)
  assert.match(desktop, /settings-prefs/u)
})

test('appearance uses theme cubes and density tiles as the actual controls', async () => {
  const panel = await readFile(PANEL_PATH, 'utf8')
  assert.match(panel, /settings-theme-cubes/u)
  assert.match(panel, /settings-theme-cube/u)
  assert.match(panel, /aria-pressed=\{state\.appearance\.theme === cube\.value\}/u)
  assert.doesNotMatch(panel, /id="appearance-theme"/u)
  assert.match(panel, /settings-density-block/u)
  assert.match(panel, /onSelect=\{onSetToolDisplayDensity\}/u)
  assert.doesNotMatch(panel, /settings-density-slider/u)
})
