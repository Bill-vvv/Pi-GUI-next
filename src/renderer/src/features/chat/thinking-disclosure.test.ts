import test from 'node:test'
import { runBrowserChecks } from '../../test-support/run-browser-checks.ts'

test('thinking disclosure respects explicit choices across stage and run completion', {
  skip: !process.env.PI_GUI_TEST_BROWSER,
  timeout: 60_000
}, async (t) => {
  await runBrowserChecks(t, {
    fixture: 'src/renderer/src/features/chat/thinking-disclosure.fixture.tsx',
    exportName: 'runThinkingDisclosureChecks',
    expectedChecks: 10
  })
})
