import test from 'node:test'
import { runBrowserChecks } from '../../test-support/run-browser-checks.ts'

for (const width of [1280, 360]) {
  test(`saved Host profiles preserve selection, credential boundaries and asynchronous ownership at ${width}px`, {
    skip: !process.env.PI_GUI_TEST_BROWSER, timeout: 60_000
  }, async (t) => {
    await runBrowserChecks(t, { fixture: 'src/renderer/src/features/desktop-client/host-profiles.fixture.tsx',
      exportName: 'runHostProfileChecks', expectedChecks: 16, viewport: { width, height: 1000 } })
  })
}
