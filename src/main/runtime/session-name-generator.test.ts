import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { tmpdir } from 'node:os'

import { generateSessionNameWithPi } from './session-name-generator.ts'

test('generates a title through an isolated Pi print request with the selected low-cost model', async (t) => {
  const executable = await createExecutable(t, `
const args = process.argv.slice(2)
const required = [
  '--print', '--no-session', '--no-tools', '--no-extensions', '--no-skills',
  '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-approve'
]
if (required.some((flag) => !args.includes(flag))) process.exit(2)
if (args[args.indexOf('--provider') + 1] !== 'openai') process.exit(3)
if (args[args.indexOf('--model') + 1] !== 'gpt-5.4-mini') process.exit(4)
if (args[args.indexOf('--thinking') + 1] !== 'off') process.exit(5)
const prompt = args.at(-1) ?? ''
if (!prompt.includes('修复自动命名') || !prompt.includes('已经完成修复')) process.exit(6)
process.stdin.resume()
process.stdin.once('end', () => process.stdout.write('修复会话语义命名\\n'))
`)
  const cwd = await mkdtemp(join(tmpdir(), 'pi-gui-title-cwd-'))
  t.after(async () => rm(cwd, { recursive: true, force: true }))

  const title = await generateSessionNameWithPi({
    executable,
    cwd,
    provider: 'openai',
    modelId: 'gpt-5.4-mini',
    userMessage: '请修复自动命名，让名称体现对话目的。',
    assistantMessage: '已经完成修复。',
    signal: new AbortController().signal
  })

  assert.equal(title, '修复会话语义命名\n')
})

test('does not expose title-process stderr when generation fails', async (t) => {
  const executable = await createExecutable(t, `
process.stderr.write('secret-provider-diagnostic')
process.exit(7)
`)
  const cwd = await mkdtemp(join(tmpdir(), 'pi-gui-title-failure-cwd-'))
  t.after(async () => rm(cwd, { recursive: true, force: true }))

  await assert.rejects(
    generateSessionNameWithPi({
      executable,
      cwd,
      provider: 'openai',
      modelId: 'gpt-purpose',
      userMessage: 'Generate a purpose title.',
      assistantMessage: null,
      signal: new AbortController().signal
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /Pi session title generation failed/)
      assert.doesNotMatch(error.message, /secret-provider-diagnostic/)
      return true
    }
  )
})

async function createExecutable(t: TestContext, body: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pi-gui-title-executable-'))
  const executable = join(directory, 'fake-pi')
  await writeFile(executable, `#!/usr/bin/env node\n${body.trim()}\n`, 'utf8')
  await chmod(executable, 0o700)
  t.after(async () => rm(directory, { recursive: true, force: true }))
  return executable
}
