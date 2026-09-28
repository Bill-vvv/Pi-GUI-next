import test from 'node:test'
import { runBrowserChecks } from '../../test-support/run-browser-checks.ts'

// PI_GUI_TEST_BROWSER selects an explicit local Chromium binary; otherwise this suite skips.
test('Git workflows preserve identity, cancellation and confirmation across React lifecycles', {
  skip: !process.env.PI_GUI_TEST_BROWSER,
  timeout: 60_000
}, async (t) => {
  await runBrowserChecks(t, {
    fixture: 'src/renderer/src/features/git/git-workflow.fixture.tsx',
    exportName: 'runGitWorkflowChecks',
    expectedChecks: 11
  })
})

for (const width of [1280, 360]) test(`remote Git review respects navigation, disconnect and file reading at ${width}px`, {
  skip: !process.env.PI_GUI_TEST_BROWSER, timeout: 60_000
}, async (t) => {
  await runBrowserChecks(t, {
    fixture: 'src/renderer/src/features/git/remote-git-review.fixture.tsx',
    exportName: 'runRemoteGitReviewChecks', expectedChecks: 12,
    viewport: { width, height: 800 }
  })
})
