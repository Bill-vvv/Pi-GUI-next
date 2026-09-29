import test from 'node:test'

import { runBrowserChecks } from '../../test-support/run-browser-checks.ts'

for (const width of [1280, 360]) {
  test(`settings rows, switches and confirmation dialog behave in a real browser at ${width}px`, {
    skip: !process.env.PI_GUI_TEST_BROWSER, timeout: 60_000
  }, async (t) => {
    await runBrowserChecks(t, {
      fixture: 'src/renderer/src/features/settings/settings-interactions.fixture.tsx',
      exportName: 'runSettingsInteractionChecks',
      expectedChecks: 19,
      viewport: { width, height: 900 }
    })
  })
}
