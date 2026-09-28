import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { isDesktopClientCommand } from '../../../../shared/desktop-client-contract.ts'
import { runBrowserChecks } from '../../test-support/run-browser-checks.ts'

for (const width of [1280, 360]) {
  test(`Host connection actions separate disconnect and revoke with modal lifetime at ${width}px`, {
    skip: !process.env.PI_GUI_TEST_BROWSER, timeout: 60_000
  }, async (t) => {
    await runBrowserChecks(t, { fixture: 'src/renderer/src/features/desktop-client/host-connection-actions.fixture.tsx',
      exportName: 'runHostConnectionActionChecks', expectedChecks: 10, viewport: { width, height: 900 } })
  })
}

test('revoke IPC requires the exact Host configuration and has a distinct App to Main route', async () => {
  const config = { sshHostAlias: 'host', localPort: 18788, desktopHostPort: 18788 }
  assert.equal(isDesktopClientCommand({ type: 'desktop-client.revoke-pairing', config }), true)
  for (const invalid of [undefined, null, {}, { ...config, sshHostAlias: '-bad' }, { ...config, localPort: 0 }, { ...config, token: 'forbidden' }]) {
    assert.equal(isDesktopClientCommand({ type: 'desktop-client.revoke-pairing', config: invalid }), false)
  }
  assert.equal(isDesktopClientCommand({ type: 'desktop-client.revoke-pairing', config, extra: true }), false)
  const [app, main, preload, workbench] = await Promise.all([
    readFile(new URL('../../App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../../../main/index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../../../preload/index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../composition/Workbench.tsx', import.meta.url), 'utf8')
  ])
  assert.match(app, /desktop\.revokePairing\(desktopClientStatus\.lastHost!/u)
  assert.match(main, /session\.revokePairing\(command\.config, connectionId\)/u)
  assert.match(preload, /revokePairing:.*desktop-client\.revoke-pairing/u)
  assert.match(workbench, /onRevokePairing=\{onRevokeHostPairing\}/u)
})
