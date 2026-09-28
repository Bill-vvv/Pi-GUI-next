import test from 'node:test'
import { runBrowserChecks } from './test-support/run-browser-checks.ts'

test('Session workflows preserve receipts, selection and acknowledged fork results across React lifecycles', {
  skip: !process.env.PI_GUI_TEST_BROWSER,
  timeout: 60_000
}, async (t) => {
  await runBrowserChecks(t, {
    fixture: 'src/renderer/src/features/session/session-workflow.fixture.tsx',
    exportName: 'runSessionWorkflowChecks',
    expectedChecks: 12
  })
})
