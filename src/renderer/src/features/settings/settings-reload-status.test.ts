import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { createSsrTestServer } from '../../test-support/create-ssr-test-server.ts'
import { PLUGIN_RELOAD_PENDING_STATUS } from './plugin-reload-status.ts'

const vite = await createSsrTestServer()
const { PackageSettings } = await vite.ssrLoadModule(
  '/src/renderer/src/features/settings/PackageSettings.tsx'
) as typeof import('./PackageSettings.tsx')
const { ExtensionSettings } = await vite.ssrLoadModule(
  '/src/renderer/src/features/settings/ExtensionSettings.tsx'
) as typeof import('./ExtensionSettings.tsx')

const read = (file: string): Promise<string> => readFile(new URL(`./${file}`, import.meta.url), 'utf8')
const never = (): Promise<never> => new Promise(() => undefined)

const common = {
  busy: false,
  pendingAction: null,
  packageInstallJobs: [],
  packageRevision: 0,
  onPackagesChanged: () => undefined,
  onListPiPackages: never,
  onInstallPiDevPackage: never,
  onRemovePiPackage: never,
  onOpenExternal: never
}

const renderPackages = (reloadPending: boolean): string => renderToStaticMarkup(createElement(PackageSettings, {
  ...common,
  reloadPending,
  onSearchPiDevPackages: never,
  onUpdatePiPackage: never,
  onUpdatePiPackages: never
}))

const renderExtensions = (reloadPending: boolean): string => renderToStaticMarkup(createElement(ExtensionSettings, {
  ...common,
  reloadPending,
  extensions: [],
  extensionActionError: null,
  onInstallExtension: never,
  onRemoveExtension: never,
  onSearchPiDevExtensions: never,
  onSetMagicContextEnabled: never
}))

test('the pending-reload status names scope, source and activation without claiming the Runtime loaded it', () => {
  assert.match(PLUGIN_RELOAD_PENDING_STATUS, /Pi 用户配置/u)
  assert.match(PLUGIN_RELOAD_PENDING_STATUS, /所有项目/u)
  assert.match(PLUGIN_RELOAD_PENDING_STATUS, /不会自动重载/u)
  assert.match(PLUGIN_RELOAD_PENDING_STATUS, /新建或重新载入对话后生效/u)
  assert.doesNotMatch(PLUGIN_RELOAD_PENDING_STATUS, /已加载|已生效|已验证|健康/u)
})

test('plugin and extension pages show the status only after a change on this visit', () => {
  for (const render of [renderPackages, renderExtensions]) {
    assert.doesNotMatch(render(false), /settings-section-heading-status/u)
    const html = render(true)
    assert.match(html, /<p class="settings-section-heading-status" role="status">/u)
    assert.ok(html.includes(PLUGIN_RELOAD_PENDING_STATUS))
  }
})

test('SettingsPanel marks only real package and extension changes made on this visit', async () => {
  const [panel, subagent, heading, styles] = await Promise.all([
    read('SettingsPanel.tsx'), read('SubagentSettings.tsx'), read('SettingsPageHeading.tsx'), read('settings.css')
  ])
  // Wrapped actions mark after they succeed, never before or on failure.
  assert.match(panel, /async \(\.\.\.args: Args\): Promise<void> => \{\s*await action\(\.\.\.args\)\s*setReloadPending\(true\)/u)
  for (const action of [
    'onRemovePiPackage', 'onUpdatePiPackage', 'onUpdatePiPackages',
    'onSetMagicContextEnabled'
  ]) {
    assert.match(panel, new RegExp(`${action}=\\{markReloadPending\\(${action}\\)\\}`, 'u'), action)
  }
  // Installs count once their background job, seen running on this visit, succeeds.
  assert.match(panel, /job\.status === 'succeeded' && activePackageInstallJobs\.current\.has\(job\.id\)\) setReloadPending\(true\)/u)
  assert.doesNotMatch(panel, /onInstallPiDevPackage=\{markReloadPending/u)
  // Local extensions are Kernel state; any change after opening settings counts.
  assert.match(panel, /if \(state\.extensions !== initialExtensions\.current\) setReloadPending\(true\)/u)
  assert.equal([...panel.matchAll(/reloadPending=\{reloadPending\}/gu)].length, 2)
  assert.doesNotMatch(subagent, /reloadPending|PLUGIN_RELOAD_PENDING_STATUS|onSetSubagentEnabled/u)
  assert.match(heading, /<p className="settings-section-heading-status" role="status">\{status\}<\/p>/u)
  assert.match(styles, /p\.settings-section-heading-status \{\s*color: var\(--color-status-warning\);/u)
})
