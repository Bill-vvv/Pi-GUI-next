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

  // Codex-aligned navigation (D-102): 个人 / 集成 / 编码.
  const groups = [...nav.matchAll(/id:\s*'([a-z]+)',\s*label:\s*'([^']+)'/gu)].map(([, id, label]) => `${id}:${label}`)
  assert.deepEqual(groups, ['personal:个人', 'integrations:集成', 'coding:编码'])
  const items = [...nav.matchAll(/section:\s*'([a-z]+)',\s*label:\s*'([^']+)'/gu)].map(([, section, label]) => `${section}:${label}`)
  assert.deepEqual(items, [
    'general:常规', 'appearance:外观', 'shortcuts:键盘快捷键', 'models:模型',
    'packages:插件', 'extensions:扩展', 'skills:技能', 'subagent:子智能体',
    'remote:连接'
  ])
  const clientItems = [...nav.matchAll(/section:\s*'([a-z]+)'[^}]*client:\s*true/gu)].map(([, section]) => section)
  assert.deepEqual(clientItems, ['general', 'appearance', 'shortcuts'])
  assert.match(nav, /role="group"/u)
  assert.match(nav, /label="返回应用"/u)
  assert.doesNotMatch(nav, /'credentials'/u)
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

test('provider credentials live on the models page as an inline group (D-102)', async () => {
  const [models, credentials, panel] = await Promise.all([
    readFile(new URL('./ModelSettings.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./CredentialsPanel.tsx', import.meta.url), 'utf8'),
    readFile(PANEL_PATH, 'utf8')
  ])
  assert.match(models, /\{credentials\}/u)
  assert.doesNotMatch(credentials, /SettingsPageHeading/u)
  assert.match(credentials, /settings-group settings-group-inline credentials-panel/u)
  assert.match(panel, /credentials=\{\(\s*<CredentialsPanel/u)
  assert.doesNotMatch(panel, /section === 'credentials'/u)
})

test('settings copy follows the Codex zh-CN wording', async () => {
  const read = (file: string): Promise<string> => readFile(new URL(`./${file}`, import.meta.url), 'utf8')
  const [general, appearance, shortcuts, packages, extensions, subagent] = await Promise.all([
    read('GeneralSettings.tsx'), read('AppearanceSettings.tsx'), read('ShortcutSettingsPanel.tsx'),
    read('PackageSettings.tsx'), read('ExtensionSettings.tsx'), read('SubagentSettings.tsx')
  ])
  assert.match(general, />实验性功能</u)
  assert.doesNotMatch(general, /（实验性）|（调试）/u)
  assert.match(appearance, /label: '系统'/u)
  assert.match(appearance, /界面字号/u)
  assert.match(shortcuts, /恢复默认快捷键/u)
  assert.match(packages, /title="插件"/u)
  assert.match(packages, /即 Pi Package/u)
  assert.match(extensions, /title="扩展"/u)
  for (const source of [general, extensions, subagent]) assert.doesNotMatch(source, /拓展/u)
  assert.match(subagent, /title="子智能体"/u)
  assert.doesNotMatch(subagent, /(['`>"]|[\u4e00-\u9fff] )Agent\b/u)
})
