import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import { testProviderConnection } from './provider-connection-test.ts'

function temporaryDirectory(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), 'pi-gui-provider-test-'))
  t.after(() => rmSync(directory, { force: true, recursive: true }))
  return directory
}

test('provider connection uses the resolved Pi command and preserves strict arguments', async (t) => {
  const directory = temporaryDirectory(t)
  const executable = join(directory, 'pi')
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const args = process.argv.slice(2)
const expected = ['--print', '--no-session', '--no-tools', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve', '--provider', 'provider-id', '--model', 'model-id', '--thinking', 'off', '.']
if (JSON.stringify(args) !== JSON.stringify(expected)) process.exit(7)
process.stdout.write('ok\\n')
`,
    { mode: 0o755 }
  )

  const result = await testProviderConnection({
    executablePath: executable,
    providerId: 'provider-id',
    modelId: 'model-id',
    cwd: directory
  })

  assert.equal(result.provider, 'provider-id')
  assert.equal(result.modelId, 'model-id')
  assert.ok(result.durationMs >= 0)
})
