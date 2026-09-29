import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import test from 'node:test'

import { runBrowserChecks } from '../../test-support/run-browser-checks.ts'
import { SETTINGS_SEARCH_ENTRIES, searchSettings } from './settings-search.ts'

const labels = (query: string, clientOnly = false): string[] =>
  searchSettings(query, { clientOnly }).map((entry) => entry.label)

test('settings search matches names, groups and synonyms with label matches first', () => {
  assert.deepEqual(labels(''), [])
  assert.deepEqual(labels('   '), [])
  assert.equal(labels('深色')[0], '主题')
  assert.equal(labels('DARK')[0], '主题')
  assert.deepEqual(labels('字体').slice(0, 2), ['界面字体', '代码字体'])
  assert.ok(labels('字体').includes('界面字号'), 'a synonym still matches after label matches')
  assert.deepEqual(labels('实验'), ['扩展启动加速', '自动继续中断的任务'])
  assert.deepEqual(labels('嵌套 深度'), ['最大嵌套层数'], 'every term must match')
  assert.deepEqual(labels('tailscale'), ['一键联网'])
  assert.ok(labels('快捷键').length >= 10, 'every shortcut action is indexed')
})

test('the SSH client only finds settings it renders', () => {
  const clientSections = new Set(['general', 'appearance', 'shortcuts'])
  for (const query of ['模型', '窗口', '主题', '凭证', '插件', '远程', '快捷键']) {
    for (const entry of searchSettings(query, { clientOnly: true })) {
      assert.equal(entry.client, true, `${query}: ${entry.label}`)
      assert.ok(clientSections.has(entry.section), `${query}: ${entry.section}`)
    }
  }
  assert.deepEqual(labels('凭证', true), [])
  assert.deepEqual(labels('命名', true), [], 'session naming is hidden in the SSH client')
  assert.deepEqual(labels('窗口', true), ['双击边框最大化'])
})

test('every search target is an id that its settings page renders', async () => {
  const directory = new URL('./', import.meta.url)
  const files = (await readdir(directory)).filter((name) => name.endsWith('.tsx') && !name.includes('.fixture.'))
  const sources = await Promise.all(files.map((name) => readFile(new URL(name, directory), 'utf8')))
  const ids = new Set<string>()
  for (const source of sources) {
    for (const [, id] of source.matchAll(/\bid="([^"]+)"/gu)) ids.add(id)
    for (const [, prefix] of source.matchAll(/\bidPrefix="([^"]+)"/gu)) ids.add(`${prefix}-heading`)
    for (const [, kind] of source.matchAll(/\bkind="(package|extension)"/gu)) ids.add(`settings-pi-dev-${kind}-heading`)
  }
  const shortcutPanel = sources[files.indexOf('ShortcutSettingsPanel.tsx')]
  assert.match(shortcutPanel, /<h4 id=\{shortcutLabelId\(actionId\)\}>/u)
  const pageSources = new Map(files.map((name, index) => [name, sources[index]]))
  assert.match(pageSources.get('AdaptedExtensionPackageControl.tsx')!, /const headingId = `\$\{idPrefix\}-heading`/u)
  assert.match(pageSources.get('PiDevCatalog.tsx')!, /const headingId = `settings-pi-dev-\$\{kind\}-heading`/u)

  const targets = new Set<string>()
  for (const entry of SETTINGS_SEARCH_ENTRIES) {
    assert.ok(!targets.has(entry.target), `duplicate target ${entry.target}`)
    targets.add(entry.target)
    if (entry.section === 'shortcuts') {
      assert.match(entry.target, /^shortcut-[a-z-]+-label$/u)
      continue
    }
    assert.ok(ids.has(entry.target), `${entry.label}: #${entry.target} is not rendered by any settings page`)
  }
})

test('the index holds fixed names only, never credentials, endpoints, prompts or logs', () => {
  for (const entry of SETTINGS_SEARCH_ENTRIES) {
    const text = [entry.label, entry.group, ...entry.keywords].join(' ').toLowerCase()
    assert.doesNotMatch(text, /endpoint|base ?url|https?:|提示词|prompt|日志|\blogs?\b|password|密码|secret/u, entry.label)
  }
})

test('settings search, keyboard, Escape and jump behave in a real browser', {
  skip: !process.env.PI_GUI_TEST_BROWSER, timeout: 60_000
}, async (t) => {
  await runBrowserChecks(t, {
    fixture: 'src/renderer/src/features/settings/settings-search.fixture.tsx',
    exportName: 'runSettingsSearchChecks',
    expectedChecks: 22
  })
})
