import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  PiDevPackageService,
  type PiDevCommandOptions
} from './pi-dev-package-service.ts'

const CATALOG_HTML = `<!doctype html>
<html><body>
  <div>1-2 / 42</div>
  <article data-package-card="true">
    <h3><a href="/packages/example-one">example-one</a></h3>
    <p>First &amp; useful extension.</p>
    <span>12.5K/mo</span>
  </article>
  <article class="card" data-package-card='true' data-package-name="@scope/example-two" data-package-downloads="950">
    <h3><a href="/packages/@scope/example-two">@scope/example-two</a></h3>
    <p>Second extension.</p>
    <span data-downloads="950/mo">downloads</span>
  </article>
</body></html>`

test('parses package cards and marks versioned npm settings entries installed', async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), 'pi-gui-dev-catalog-'))
  t.after(() => rm(agentDir, { recursive: true, force: true }))
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
    packages: ['npm:example-one@latest', { source: 'npm:@scope/example-two@1.2.3' }, 'git:example.test/repo']
  }), 'utf8')

  let requestedUrl = ''
  const service = new PiDevPackageService({
    agentDir,
    fetch: async (input) => {
      requestedUrl = String(input)
      return new Response(CATALOG_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    }
  })

  assert.deepEqual(await service.catalog('example', 'extension'), {
    packages: [
      {
        name: 'example-one',
        description: 'First & useful extension.',
        downloads: '12.5K/mo',
        detailUrl: 'https://pi.dev/packages/example-one',
        installed: true
      },
      {
        name: '@scope/example-two',
        description: 'Second extension.',
        downloads: '950/mo',
        detailUrl: 'https://pi.dev/packages/@scope/example-two',
        installed: true
      }
    ],
    total: 42
  })
  const url = new URL(requestedUrl)
  assert.equal(url.origin + url.pathname, 'https://pi.dev/packages')
  assert.equal(url.search, '?name=example&type=extension')
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    name: 'example',
    type: 'extension'
  })
})

test('requests the complete Package directory without the Extension filter', async () => {
  let requestedUrl = ''
  const service = new PiDevPackageService({
    fetch: async (input) => {
      requestedUrl = String(input)
      return new Response(CATALOG_HTML, { headers: { 'content-type': 'text/html' } })
    }
  })

  await service.catalog('example')

  const url = new URL(requestedUrl)
  assert.deepEqual(Object.fromEntries(url.searchParams), { name: 'example' })
})

test('uses strict Pi command arguments and rejects invalid package names before execution', async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), 'pi-gui-dev-command-'))
  t.after(() => rm(agentDir, { recursive: true, force: true }))
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
    packages: ['npm:good-name@1.2.3', { source: 'git:github.com/example/tools', extensions: [] }]
  }), 'utf8')
  const calls: Array<{ executable: string, args: readonly string[], options: PiDevCommandOptions }> = []
  const service = new PiDevPackageService({
    agentDir,
    piExecutablePath: process.execPath,
    commandRunner: async (executable, args, options) => { calls.push({ executable, args, options }) }
  })

  await service.install('@scope/good-name')
  assert.deepEqual(await service.list(), [
    { source: 'npm:good-name@1.2.3', filtered: false },
    { source: 'git:github.com/example/tools', filtered: true }
  ])
  await service.remove('npm:good-name')
  await service.update('git:github.com/example/tools')
  await service.update()
  assert.equal(calls[0]?.executable, process.execPath)
  assert.deepEqual(calls.map((call) => call.args), [
    ['install', 'npm:@scope/good-name', '--no-approve'],
    ['remove', 'npm:good-name@1.2.3', '--no-approve'],
    ['update', '--extension', 'git:github.com/example/tools', '--no-approve'],
    ['update', '--extensions', '--no-approve']
  ])
  assert.equal(calls[0]?.options.shell, false)
  assert.equal(calls[0]?.options.cwd, agentDir)
  assert.equal(calls[0]?.options.env.GIT_TERMINAL_PROMPT, '0')
  assert.equal(calls[0]?.options.env.PI_CODING_AGENT_DIR, agentDir)
  assert.equal(calls[0]?.options.timeoutMs, 180_000)

  for (const invalid of ['good-name@1.0.0', '../escape', 'UPPER', 'name with space', 'npm:double-prefix']) {
    await assert.rejects(service.install(invalid), /Invalid npm package name/u)
  }
  await assert.rejects(service.remove('npm:not-installed'), /not present in user settings/u)
  await assert.rejects(service.update('git:github.com/example/missing'), /not present in user settings/u)
  assert.equal(calls.length, 4)
})

test('fails fast when the catalog no longer contains package cards', async () => {
  const emptyService = new PiDevPackageService({
    fetch: async () => new Response(
      '<span class="packages-count">0 / 5388</span><p class="packages-empty">No packages match this filter.</p>',
      { headers: { 'content-type': 'text/html' } }
    )
  })
  assert.deepEqual(await emptyService.catalog('missing'), { packages: [], total: 0 })

  const service = new PiDevPackageService({
    fetch: async () => new Response('<html><body><div>changed</div></body></html>', {
      headers: { 'content-type': 'text/html' }
    })
  })

  await assert.rejects(service.catalog(), /structure changed: no package cards/u)
})
