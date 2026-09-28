import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import {
  QUIESCENCE_COMMAND_NAME,
  buildQuiescencePrompt,
  interpretHibernateLeaseStatusText,
  interpretQuiescenceStatusText,
  isInternalQuiescenceCommandName,
  isMutatingRuntimeCommandType,
  normalizeQuiescenceTimeoutMs,
  resolveRuntimeExtensionPaths,
  resolveRuntimeQuiescenceExtensionPath
} from './runtime-quiescence.ts'
import { createCommandCatalog } from '../kernel/command-catalog.ts'

test('P3 tree and extension mutations remain behind the hibernate fence', () => {
  assert.equal(isMutatingRuntimeCommandType('get_tree'), false)
  assert.equal(isMutatingRuntimeCommandType('navigate_tree'), true)
  assert.equal(isMutatingRuntimeCommandType('invoke_extension_command'), true)
  assert.equal(isMutatingRuntimeCommandType('subscribe_extension_events'), true)
})

test('buildQuiescencePrompt and command filter stay aligned', () => {
  assert.equal(buildQuiescencePrompt('abc-123'), `/${QUIESCENCE_COMMAND_NAME} abc-123`)
  assert.throws(() => buildQuiescencePrompt('has space'), /nonce/u)
  assert.equal(isInternalQuiescenceCommandName(QUIESCENCE_COMMAND_NAME), true)
  const catalog = createCommandCatalog([
    {
      name: QUIESCENCE_COMMAND_NAME,
      description: 'internal',
      source: 'extension',
      sourceInfo: { source: 'quiescence', scope: 'temporary', origin: 'top-level' }
    },
    {
      name: 'todos',
      description: 'visible',
      source: 'extension',
      sourceInfo: { source: 'npm:@cortexkit/pi-magic-context', scope: 'user', origin: 'package' }
    }
  ])
  assert.equal(catalog.some((command) => command.name === QUIESCENCE_COMMAND_NAME), false)
  assert.equal(catalog.some((command) => command.name === 'todos'), true)
})

test('resolveRuntimeQuiescenceExtensionPath finds the source extension', () => {
  const path = resolveRuntimeQuiescenceExtensionPath()
  assert.match(path, /pi-gui-runtime-quiescence\/src\/index\.ts$/u)
})

test('resolveRuntimeExtensionPaths includes all app-owned extensions in stable order', () => {
  const paths = resolveRuntimeExtensionPaths()
  assert.equal(paths.length, 5)
  assert.match(paths[0]!, /pi-gui-runtime-quiescence\/src\/index\.ts$/u)
  assert.match(paths[1]!, /pi-gui-task-notify\/src\/index\.ts$/u)
  assert.match(paths[2]!, /pi-gui-ask\/src\/index\.ts$/u)
  assert.match(paths[3]!, /pi-gui-openai-fast-mode\/src\/index\.ts$/u)
  assert.match(paths[4]!, /pi-gui-history-navigation\/src\/index\.ts$/u)
})

test('electron-builder packages every app-owned extension under resources/extensions', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../../../package.json', import.meta.url), 'utf8')
  ) as {
    build?: { extraResources?: Array<{ from?: string, to?: string }> }
  }
  const resources = packageJson.build?.extraResources ?? []
  for (const name of [
    'pi-gui-runtime-quiescence',
    'pi-gui-task-notify',
    'pi-gui-ask',
    'pi-gui-openai-fast-mode',
    'pi-gui-history-navigation'
  ]) {
    assert.equal(resources.some((entry) =>
      entry.from === `extensions/${name}` && entry.to === `extensions/${name}`
    ), true)
  }
})

test('resolveRuntimeExtensionPaths matches packaged extraResources layout', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-gui-quiescence-packaged-'))
  t.after(async () => rm(root, { recursive: true, force: true }))
  const { mkdir } = await import('node:fs/promises')
  const names = [
    'pi-gui-runtime-quiescence',
    'pi-gui-task-notify',
    'pi-gui-ask',
    'pi-gui-openai-fast-mode',
    'pi-gui-history-navigation'
  ]
  const packaged = names.map((name) => join(root, `extensions/${name}/src/index.ts`))
  for (const path of packaged) {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, 'export default () => {}\n')
  }
  const paths = resolveRuntimeExtensionPaths({
    isPackaged: true,
    resourcesPath: root
  })
  assert.deepEqual(paths, packaged)
})

test('interpretQuiescenceStatusText correlates nonce and rejects malformed payloads', () => {
  const good = {
    version: 1,
    kind: 'pi-gui.runtime-quiescence/query-result',
    nonce: 'n-9',
    core: { idle: true, pendingMessages: false },
    providers: [],
    quiescent: true
  }
  assert.deepEqual(interpretQuiescenceStatusText(JSON.stringify(good), 'n-9'), {
    ok: true,
    result: good
  })
  const mismatched = interpretQuiescenceStatusText(JSON.stringify(good), 'other')
  assert.equal(mismatched.ok, false)
  if (!mismatched.ok) assert.equal(mismatched.reason, 'nonce-mismatch')
  const malformed = interpretQuiescenceStatusText('not-json', 'n-9')
  assert.equal(malformed.ok, false)
  if (!malformed.ok) assert.equal(malformed.reason, 'malformed')
  const cleared = interpretQuiescenceStatusText(undefined, 'n-9')
  assert.equal(cleared.ok, false)
  if (!cleared.ok) assert.equal(cleared.reason, 'malformed')
})

test('interpretHibernateLeaseStatusText preserves redacted provider blockers', () => {
  const result = interpretHibernateLeaseStatusText(JSON.stringify({
    version: 1,
    kind: 'pi-gui.runtime-hibernate-lease/result',
    action: 'prepare',
    nonce: 'lease-nonce',
    sessionId: 'session-1',
    generation: 1,
    attemptId: 'attempt-1',
    ok: false,
    reason: 'provider-prepare-failed',
    blockers: [
      { id: 'magic-context', reason: 'operation-active' },
      { id: 'pi-mcp-adapter', reason: 'oauth-active' }
    ]
  }), 'lease-nonce', 'prepare')
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'lease-rejected')
  assert.equal(result.leaseReason, 'provider-prepare-failed')
  assert.deepEqual(result.blockers, [
    { id: 'magic-context', reason: 'operation-active' },
    { id: 'pi-mcp-adapter', reason: 'oauth-active' }
  ])
})

test('normalizeQuiescenceTimeoutMs rejects non-integer and out-of-bounds values', () => {
  assert.equal(normalizeQuiescenceTimeoutMs(undefined).ok, true)
  assert.equal(normalizeQuiescenceTimeoutMs(10).ok, true)
  assert.equal(normalizeQuiescenceTimeoutMs(1.25).ok, false)
  assert.equal(normalizeQuiescenceTimeoutMs(Number.NaN).ok, false)
  assert.equal(normalizeQuiescenceTimeoutMs(0).ok, false)
})
