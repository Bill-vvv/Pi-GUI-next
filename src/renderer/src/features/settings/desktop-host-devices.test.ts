import test from 'node:test'

import { runBrowserChecks } from '../../test-support/run-browser-checks.ts'

for (const width of [1280, 360]) {
  test(`Desktop Host device list binds each revoke to one device in a real browser at ${width}px`, {
    skip: !process.env.PI_GUI_TEST_BROWSER, timeout: 60_000
  }, async (t) => {
    await runBrowserChecks(t, {
      fixture: 'src/renderer/src/features/settings/desktop-host-devices.fixture.tsx',
      exportName: 'runDesktopHostDeviceChecks',
      expectedChecks: 15,
      viewport: { width, height: 900 }
    })
  })
}
