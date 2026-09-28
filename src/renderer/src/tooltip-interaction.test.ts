import test from 'node:test'
import { runBrowserChecks } from './test-support/run-browser-checks.ts'

test('tooltip hover exploration preserves delay, dismissal and focus contracts', {
  skip: !process.env.PI_GUI_TEST_BROWSER, timeout: 60_000
}, async (t) => {
  await runBrowserChecks(t, {
    fixture: 'src/renderer/src/components/tooltip-interaction.fixture.tsx',
    exportName: 'runTooltipInteractionChecks', expectedChecks: 17
  })
})
