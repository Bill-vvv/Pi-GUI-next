import test from 'node:test'
import { runBrowserChecks } from '../../test-support/run-browser-checks.ts'

for (const width of [1280, 360]) test(`remote attachment lifecycle at ${width}px`, {
  skip: !process.env.PI_GUI_TEST_BROWSER, timeout: 60_000
}, async (t) => {
  await runBrowserChecks(t, { fixture: 'src/renderer/src/features/composer/remote-attachments.fixture.tsx',
    exportName: 'runRemoteAttachmentChecks', expectedChecks: 8, viewport: { width, height: 800 } })
})
