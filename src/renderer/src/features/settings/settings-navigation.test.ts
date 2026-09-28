import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const NAV_PATH = new URL('./SettingsNavigation.tsx', import.meta.url)
const PANEL_PATH = new URL('./SettingsPanel.tsx', import.meta.url)
const GENERAL_PATH = new URL('./GeneralSettings.tsx', import.meta.url)
const APPEARANCE_PATH = new URL('./AppearanceSettings.tsx', import.meta.url)
const EXTENSIONS_PATH = new URL('./ExtensionSettings.tsx', import.meta.url)

test('settings navigation groups current pages and drops leftover preferences', async () => {
  const [nav, panel, general] = await Promise.all([
    readFile(NAV_PATH, 'utf8'),
    readFile(PANEL_PATH, 'utf8'),
    readFile(GENERAL_PATH, 'utf8')
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
  assert.match(general, /htmlFor="session-naming-mode"/u)
  assert.match(general, /id="settings-session-naming"/u)
  assert.doesNotMatch(panel, /section === 'preferences'/u)
  assert.doesNotMatch(panel, />偏好</u)
})

test('settings resource pages share one row template', async () => {
  const [extensions, credentials, packages, catalog, skills] = await Promise.all([
    readFile(EXTENSIONS_PATH, 'utf8'),
    readFile(new URL('./CredentialsPanel.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./InstalledPackages.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./PiDevCatalog.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./SkillSettings.tsx', import.meta.url), 'utf8')
  ])

  for (const source of [extensions, credentials, packages, catalog, skills]) {
    assert.match(source, /settings-resource-row/u)
  }
  assert.doesNotMatch(credentials, /credential-card|credential-details/u)
  assert.doesNotMatch(packages, /settings-package-item/u)
  assert.doesNotMatch(catalog, /settings-pi-dev-item/u)
  assert.doesNotMatch(skills, /settings-skill-item/u)
  assert.doesNotMatch(extensions, /settings-extension-list/u)
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
  const panel = await readFile(APPEARANCE_PATH, 'utf8')
  assert.match(panel, /settings-theme-cubes/u)
  assert.match(panel, /settings-theme-cube/u)
  assert.match(panel, /aria-pressed=\{appearance\.theme === cube\.value\}/u)
  assert.doesNotMatch(panel, /id="appearance-theme"/u)
  assert.match(panel, /settings-density-block/u)
  assert.match(panel, /onSelect=\{onSetToolDisplayDensity\}/u)
  assert.doesNotMatch(panel, /settings-density-slider/u)
})

test('settings panel only routes sections and every page owns one shared heading', async () => {
  const panel = await readFile(PANEL_PATH, 'utf8')
  assert.doesNotMatch(panel, /<h2/u)
  assert.doesNotMatch(panel, /settings-section-heading/u)
  const pages = [
    'GeneralSettings.tsx',
    'AppearanceSettings.tsx',
    'ShortcutSettingsPanel.tsx',
    'ModelSettings.tsx',
    'CredentialsPanel.tsx',
    'RemoteSettings.tsx',
    'SubagentSettings.tsx',
    'PackageSettings.tsx',
    'ExtensionSettings.tsx',
    'SkillSettings.tsx'
  ]
  for (const page of pages) {
    const source = await readFile(new URL(`./${page}`, import.meta.url), 'utf8')
    assert.match(source, /<SettingsPageHeading/u, page)
    assert.doesNotMatch(source, /className="settings-section-heading/u, page)
  }
})

test('settings keep required facts visible instead of tooltip-only', async () => {
  const sources = await Promise.all(
    ['GeneralSettings.tsx', 'PackageSettings.tsx', 'ExtensionSettings.tsx', 'SkillSettings.tsx']
      .map((page) => readFile(new URL(`./${page}`, import.meta.url), 'utf8'))
  )
  for (const source of sources) {
    assert.doesNotMatch(source, /<h[1-4][^>]*data-tooltip/u)
    assert.doesNotMatch(source, /<label[^>]*data-tooltip/u)
    assert.doesNotMatch(source, /settings-empty-state"[^>]*\n?[^>]*data-tooltip/u)
  }
})

test('settings pages share one feedback text style instead of per-page error classes', async () => {
  const { readdir } = await import('node:fs/promises')
  const directory = new URL('./', import.meta.url)
  const files = (await readdir(directory)).filter((name) => name.endsWith('.tsx'))
  for (const file of files) {
    const source = await readFile(new URL(file, directory), 'utf8')
    for (const [, className] of source.matchAll(/className="([^"]*)"/gu)) {
      for (const token of className.split(/\s+/u)) {
        if (token.startsWith('settings-feedback')) continue
        assert.doesNotMatch(
          token,
          /^(settings|credentials|provider-settings|remote-access)(-[a-z-]+)?-(error|notice)$/u,
          `${file} uses ${token}; use settings-feedback with a tone modifier`
        )
      }
    }
  }
})

test('settings pages confirm through the in-app dialog, not window.confirm', async () => {
  const { readdir } = await import('node:fs/promises')
  const directory = new URL('./', import.meta.url)
  const files = (await readdir(directory)).filter((name) => name.endsWith('.tsx'))
  for (const file of files) {
    const source = await readFile(new URL(file, directory), 'utf8')
    assert.doesNotMatch(source, /window\.confirm\(/u, file)
  }
  const dialog = await readFile(new URL('./SettingsConfirmDialog.tsx', directory), 'utf8')
  assert.match(dialog, /useModalDialog\(\{/u)
  assert.match(dialog, /aria-modal="true"/u)
  assert.match(dialog, /dismissDisabled: busy/u)
})

test('immediate on/off settings use the switch control', async () => {
  const [general, models, adapted, control] = await Promise.all([
    readFile(new URL('./GeneralSettings.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./ModelSettings.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./AdaptedExtensionPackageControl.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./SettingsSwitch.tsx', import.meta.url), 'utf8')
  ])
  assert.match(control, /role="switch"/u)
  assert.match(control, /type="checkbox"/u)
  assert.equal([...general.matchAll(/<SettingsSwitch/gu)].length, 3)
  assert.match(models, /<SettingsSwitch/u)
  assert.match(adapted, /<SettingsSwitch/u)
  for (const source of [general, models, adapted]) {
    assert.doesNotMatch(source, /value: 'on'|value: 'enabled'/u)
    assert.doesNotMatch(source, /type="checkbox"/u)
  }
})

test('pi-subagents install and enablement live on the Subagent page (D-100)', async () => {
  const [subagent, extensions] = await Promise.all([
    readFile(new URL('./SubagentSettings.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./ExtensionSettings.tsx', import.meta.url), 'utf8')
  ])
  assert.match(subagent, /<AdaptedExtensionPackageControl[\s\S]*?packageName=\{SUBAGENT_PACKAGE_NAME\}/u)
  assert.match(subagent, /onStateChange=\{setPackageState\}/u)
  assert.doesNotMatch(subagent, /findUniqueInstalledPackage/u)
  assert.doesNotMatch(subagent, /“拓展”/u)
  assert.doesNotMatch(extensions, /SUBAGENT_PACKAGE_NAME|onSetSubagentEnabled/u)
  assert.match(extensions, /MAGIC_CONTEXT_PACKAGE_NAME/u)
})
