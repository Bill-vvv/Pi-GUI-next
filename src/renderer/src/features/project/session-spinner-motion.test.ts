import test from 'node:test'
import { runBrowserChecks } from '../../test-support/run-browser-checks.ts'

test('Session spinner respects hidden state before and after mount', {
  skip: !process.env.PI_GUI_TEST_BROWSER, timeout: 60_000
}, async (t) => {
  await runBrowserChecks(t, {
    fixture: 'src/renderer/src/features/project/session-spinner-motion.fixture.tsx',
    exportName: 'runSessionSpinnerMotionChecks', expectedChecks: 4
  })
})
