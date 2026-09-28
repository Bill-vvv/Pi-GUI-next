import test from 'node:test'
import { runBrowserChecks } from '../../test-support/run-browser-checks.ts'

for (const width of [1280, 360]) test(`remote Git write lifecycle at ${width}px`, {
  skip: !process.env.PI_GUI_TEST_BROWSER, timeout: 60_000
}, async (t) => {
  await runBrowserChecks(t, { fixture: 'src/renderer/src/features/git/remote-git-write.fixture.tsx',
    exportName: 'runRemoteGitWriteChecks', expectedChecks: 7, viewport: { width, height: 800 } })
})
