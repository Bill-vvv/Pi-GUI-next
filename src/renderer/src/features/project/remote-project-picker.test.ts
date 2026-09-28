import test from 'node:test'
import { runBrowserChecks } from '../../test-support/run-browser-checks.ts'

test('remote project selection preserves directory, request and App connection identity', {
  skip: !process.env.PI_GUI_TEST_BROWSER, timeout: 60_000
}, async (t) => {
  await runBrowserChecks(t, {
    fixture: 'src/renderer/src/features/project/remote-project-picker.fixture.tsx',
    exportName: 'runRemoteProjectPickerChecks', expectedChecks: 13
  })
})
