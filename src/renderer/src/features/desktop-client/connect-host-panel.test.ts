import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runBrowserChecks } from '../../test-support/run-browser-checks.ts'

const PANEL_PATH = new URL('./ConnectHostPanel.tsx', import.meta.url)
const APP_PATH = new URL('../../App.tsx', import.meta.url)
const PRELOAD_PATH = new URL('../../../../preload/index.ts', import.meta.url)

for (const width of [1280, 360]) {
  test(`Host preflight owns cancellation, target identity and diagnostic layout at ${width}px`, {
    skip: !process.env.PI_GUI_TEST_BROWSER, timeout: 60_000
  }, async (t) => {
    await runBrowserChecks(t, {
      fixture: 'src/renderer/src/features/desktop-client/connect-host-panel.fixture.tsx',
      exportName: 'runHostPreflightChecks', expectedChecks: 12, viewport: { width, height: 1000 }
    })
  })
  test(`SSH host discovery preserves manual input, request lifetime and keyboard layout at ${width}px`, {
    skip: !process.env.PI_GUI_TEST_BROWSER, timeout: 60_000
  }, async (t) => {
    await runBrowserChecks(t, {
      fixture: 'src/renderer/src/features/desktop-client/connect-host-panel.fixture.tsx',
      exportName: 'runSshDiscoveryChecks', expectedChecks: 11, viewport: { width, height: 900 }
    })
  })
}

test('connection recovery controls reflect real status and enforce disabled submission', {
  skip: !process.env.PI_GUI_TEST_BROWSER,
  timeout: 60_000
}, async (t) => {
  await runBrowserChecks(t, {
    fixture: 'src/renderer/src/features/desktop-client/connect-host-panel.fixture.tsx',
    exportName: 'runConnectionChecks', expectedChecks: 10
  })
})

test('ConnectHostPanel can resume a stored Desktop Host credential without writing secrets', async () => {
  const source = await readFile(PANEL_PATH, 'utf8')
  assert.match(source, /onConnect:\s*\(request: DesktopClientConnectRequest\)\s*=>\s*Promise<void>/u)
  assert.match(source, /连接 Linux Host/u)
  assert.match(source, /SSH Host alias/u)
  assert.match(source, /Windows Credential Manager/u)
  assert.match(source, /pairingRequired \? '6 位配对码' : '6 位配对码（可选）'/u)
  assert.match(source, /DESKTOP_CLIENT_DEFAULT_PORT/u)
  assert.match(source, /status\.phase === 'reconnecting'/u)
  assert.doesNotMatch(source, /localStorage|sessionStorage|password/u)
  assert.doesNotMatch(source, /ipcRenderer|electron/iu)
})

test('App shows the Windows remote connection screen before Kernel snapshot', async () => {
  const [app, preload] = await Promise.all([
    readFile(APP_PATH, 'utf8'),
    readFile(PRELOAD_PATH, 'utf8')
  ])
  assert.match(app, /<ConnectHostPanel/u)
  assert.match(app, /window\.piDesktopClient/u)
  assert.match(preload, /exposeInMainWorld\('piDesktopClient', desktopClientApi\)/u)
  assert.doesNotMatch(preload, /exposeInMainWorld\('piDesktopClient',\s*(?:ipcRenderer|webUtils|process|Buffer)/u)
})
