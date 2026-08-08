import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test, { type TestContext } from 'node:test'

import {
  CAPABILITY_INVENTORY_DIAGNOSTIC_MESSAGES,
  CAPABILITY_INVENTORY_DIAGNOSTIC_POLICIES,
  CAPABILITY_INVENTORY_LIMITS,
  type CapabilityInventoryDiagnosticCode,
  type CapabilityInventoryScope,
  type CapabilityInventorySnapshot
} from '../../shared/capability-inventory-contract.ts'
import { createCapabilityInventorySnapshot } from './pi-capability-inventory-core.ts'
import { PiCapabilityInventoryService, type PiCapabilityInventoryInput } from './pi-capability-inventory-service.ts'

const SOURCE_WORKER_PATH = fileURLToPath(new URL('./pi-capability-inventory-worker.ts', import.meta.url))
const BUILT_WORKER_PATH = resolve('out/main/pi-capability-inventory-worker.js')
const REAL_PI_ROOT =
  process.env.PI_GUI_TEST_PI_PACKAGE_ROOT ??
  '/home/vvv/.local/lib/node_modules/@earendil-works/pi-coding-agent'
const SENTINEL = 'UNLABELED-INVENTORY-SENTINEL-9f4c2b'

type FakeData = {
  globalSettings?: unknown
  projectSettings?: unknown
  settingsErrors?: unknown
  configuredPackages?: unknown
  resolved?: unknown
  loadedSkills?: unknown
  loadedPrompts?: unknown
  loadedThemes?: unknown
  throwList?: unknown
  throwResolve?: unknown
  throwLoader?: unknown
}

async function tempRoot(t: TestContext, prefix = 'pi-gui-capability-inventory-'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value), 'utf8')
}

function metadata(
  source: string,
  scope: 'user' | 'project',
  origin: 'package' | 'top-level',
  baseDir?: string
): Record<string, unknown> {
  return { source, scope, origin, ...(baseDir === undefined ? {} : { baseDir }) }
}

function fakeRoot(data: FakeData): unknown {
  class FakeSettingsManager {
    static create(_cwd: string, _agentDir: string, options: { projectTrusted: boolean }): FakeSettingsManager {
      return new FakeSettingsManager(options.projectTrusted)
    }
    private errors = data.settingsErrors ?? []
    private readonly trusted: boolean
    constructor(trusted: boolean) { this.trusted = trusted }
    getGlobalSettings(): unknown { return structuredClone(data.globalSettings ?? {}) }
    getProjectSettings(): unknown { return this.trusted ? structuredClone(data.projectSettings ?? {}) : {} }
    isProjectTrusted(): boolean { return this.trusted }
    async reload(): Promise<void> {}
    drainErrors(): unknown {
      const value = this.errors
      this.errors = []
      return structuredClone(value)
    }
    getNpmCommand(): string[] | undefined { return ['/must-not-run'] }
  }

  class FakePackageManager {
    private readonly options: { settingsManager: FakeSettingsManager }
    constructor(options: { settingsManager: FakeSettingsManager }) { this.options = options }
    listConfiguredPackages(): unknown {
      if (data.throwList !== undefined) throw data.throwList
      return structuredClone(data.configuredPackages ?? [])
    }
    async resolve(onMissing?: (source: string) => Promise<'install' | 'skip' | 'error'>): Promise<unknown> {
      if (data.throwResolve !== undefined) throw data.throwResolve
      if (onMissing !== undefined && Array.isArray(data.configuredPackages)) {
        for (const item of data.configuredPackages) {
          if (typeof item === 'object' && item !== null && !('installedPath' in item) &&
            typeof (item as { source?: unknown }).source === 'string') {
            await onMissing((item as { source: string }).source)
          }
        }
      }
      void this.options
      return structuredClone(data.resolved ?? { extensions: [], skills: [], prompts: [], themes: [] })
    }
  }

  class FakeResourceLoader {
    private readonly options: {
      settingsManager: FakeSettingsManager
      noExtensions: true
      noContextFiles: true
      systemPrompt: ''
      appendSystemPrompt: []
    }
    constructor(options: {
      settingsManager: FakeSettingsManager
      noExtensions: true
      noContextFiles: true
      systemPrompt: ''
      appendSystemPrompt: []
    }) { this.options = options }
    async reload(): Promise<void> {
      assert.equal(this.options.noExtensions, true)
      assert.equal(this.options.noContextFiles, true)
      assert.equal(this.options.systemPrompt, '')
      assert.deepEqual(this.options.appendSystemPrompt, [])
      if (data.throwLoader !== undefined) throw data.throwLoader
      await this.options.settingsManager.reload()
    }
    getSkills(): unknown {
      return structuredClone(data.loadedSkills === undefined ? { skills: [], diagnostics: [] } : data.loadedSkills)
    }
    getPrompts(): unknown {
      return structuredClone(data.loadedPrompts === undefined ? { prompts: [], diagnostics: [] } : data.loadedPrompts)
    }
    getThemes(): unknown {
      return structuredClone(data.loadedThemes === undefined ? { themes: [], diagnostics: [] } : data.loadedThemes)
    }
  }

  return {
    SettingsManager: FakeSettingsManager,
    DefaultPackageManager: FakePackageManager,
    DefaultResourceLoader: FakeResourceLoader
  }
}

async function coreSnapshot(
  t: TestContext,
  data: FakeData,
  request: Partial<PiCapabilityInventoryInput> = {}
): Promise<{ snapshot: CapabilityInventorySnapshot, root: string, cwd: string, agentDir: string }> {
  const root = await tempRoot(t)
  const cwd = join(root, 'project')
  const agentDir = join(root, 'agent')
  await mkdir(join(cwd, '.pi'), { recursive: true })
  await mkdir(agentDir, { recursive: true })
  const input: PiCapabilityInventoryInput = {
    cwd,
    agentDir,
    projectTrusted: request.projectTrusted ?? true,
    scope: request.scope ?? 'effective'
  }
  return {
    snapshot: await createCapabilityInventorySnapshot(fakeRoot(data), input),
    root,
    cwd,
    agentDir
  }
}

function assertClosedReferences(snapshot: CapabilityInventorySnapshot): void {
  const packageIds = new Set(snapshot.packages.map((pkg) => pkg.id))
  const resourceIds = new Set(snapshot.resources.map((resource) => resource.id))
  const diagnosticIds = new Set(snapshot.diagnostics.map((diagnostic) => diagnostic.id))
  assert.equal(new Set([...packageIds, ...resourceIds, ...diagnosticIds]).size,
    packageIds.size + resourceIds.size + diagnosticIds.size)
  for (const resource of snapshot.resources) {
    if (resource.ownerPackageId !== null) assert.ok(packageIds.has(resource.ownerPackageId))
    assert.equal(new Set(resource.diagnosticIds).size, resource.diagnosticIds.length)
    assert.ok(resource.diagnosticIds.every((id) => diagnosticIds.has(id)))
  }
  for (const pkg of snapshot.packages) {
    assert.equal(new Set(pkg.diagnosticIds).size, pkg.diagnosticIds.length)
    assert.ok(pkg.diagnosticIds.every((id) => diagnosticIds.has(id)))
  }
  for (const diagnostic of snapshot.diagnostics) {
    if (diagnostic.resourceId !== null) assert.ok(resourceIds.has(diagnostic.resourceId))
    if (diagnostic.collision !== null) {
      if (diagnostic.collision.winnerResourceId !== null) assert.ok(resourceIds.has(diagnostic.collision.winnerResourceId))
      if (diagnostic.collision.loserResourceId !== null) assert.ok(resourceIds.has(diagnostic.collision.loserResourceId))
    }
  }
}

test('core projects fixed diagnostics, redacted malformed sources, and no bodies or external basenames', async (t) => {
  const externalLocal = `/outside/${SENTINEL}`
  const npmUrlVersion = `npm:safe@https://alice:${SENTINEL}@example.test/a.tgz?token=${SENTINEL}#x`
  const npmUrlName = `npm:https://alice:${SENTINEL}@example.test/a.tgz`
  const gitCredential = `git:https://alice:${SENTINEL}@example.test/org/repo?token=x#frag`
  const gitScpCredential = `git:alice@github.com:org/repo@${SENTINEL}/bad`
  const packageRoot = '/cache/safe-kit'
  const { snapshot } = await coreSnapshot(t, {
    globalSettings: { packages: [npmUrlVersion, npmUrlName, gitCredential, gitScpCredential, externalLocal, 'npm:safe-kit'] },
    configuredPackages: [
      { source: npmUrlVersion, scope: 'user', filtered: false, installedPath: '/cache/a' },
      { source: npmUrlName, scope: 'user', filtered: false, installedPath: '/cache/b' },
      { source: gitCredential, scope: 'user', filtered: false, installedPath: '/cache/c' },
      { source: gitScpCredential, scope: 'user', filtered: false, installedPath: '/cache/d' },
      { source: externalLocal, scope: 'user', filtered: false, installedPath: externalLocal },
      { source: 'npm:safe-kit', scope: 'user', filtered: false, installedPath: packageRoot }
    ],
    resolved: {
      extensions: [
        { path: `/unrelated/${SENTINEL}.mjs`, enabled: true, metadata: metadata('auto', 'user', 'top-level') }
      ],
      skills: [{ path: `${packageRoot}/skills`, enabled: true, metadata: metadata('npm:safe-kit', 'user', 'package', packageRoot) }],
      prompts: [{ path: `${packageRoot}/prompts`, enabled: true, metadata: metadata('npm:safe-kit', 'user', 'package', packageRoot) }],
      themes: [{ path: `${packageRoot}/themes`, enabled: true, metadata: metadata('npm:safe-kit', 'user', 'package', packageRoot) }]
    },
    loadedSkills: {
      skills: [{
        name: 'safe-skill', description: 'ignored', content: `SKILL-BODY-${SENTINEL}`,
        filePath: `${packageRoot}/skills/SKILL.md`, disableModelInvocation: false,
        sourceInfo: { path: `${packageRoot}/skills/SKILL.md`, ...metadata('npm:safe-kit', 'user', 'package', packageRoot) }
      }],
      diagnostics: [{
        type: 'error', message: `yaml excerpt ${SENTINEL}`, path: `${packageRoot}/skills/SKILL.md`,
        cause: { stack: `STACK-${SENTINEL}` }
      }]
    },
    loadedPrompts: {
      prompts: [{
        name: 'same', description: 'ignored', content: `PROMPT-BODY-${SENTINEL}`,
        filePath: `${packageRoot}/prompts/winner.md`,
        sourceInfo: { path: `${packageRoot}/prompts/winner.md`, ...metadata('npm:safe-kit', 'user', 'package', packageRoot) }
      }],
      diagnostics: [{
        type: 'collision', message: `collision ${SENTINEL}`, path: `${packageRoot}/prompts/loser.md`,
        collision: {
          resourceType: 'prompt', name: SENTINEL,
          winnerPath: `${packageRoot}/prompts/winner.md`, loserPath: `${packageRoot}/prompts/loser.md`
        }
      }]
    },
    loadedThemes: {
      themes: [{
        name: 'safe-theme', sourcePath: `${packageRoot}/themes/night.json`,
        colors: { secret: `THEME-DATA-${SENTINEL}` },
        sourceInfo: { path: `${packageRoot}/themes/night.json`, ...metadata('npm:safe-kit', 'user', 'package', packageRoot) }
      }],
      diagnostics: [{ type: 'error', message: `invalid color ${SENTINEL}`, path: `${packageRoot}/themes/night.json` }]
    }
  })

  assert.equal(snapshot.resolvedComplete, false)
  assert.equal(snapshot.resolvedUnavailableReason, 'sdk-error')
  const malformed = snapshot.packages.filter((pkg) => pkg.sourceKind === 'unknown')
  assert.equal(malformed.length, 4)
  assert.ok(malformed.every((pkg) => pkg.source === '[redacted-source]' &&
    pkg.packageName === null && pkg.requestedVersionOrRef === null))
  assert.equal(snapshot.packages.find((pkg) => pkg.sourceKind === 'local')?.source, '[local:user]/[external]')
  const externalResource = snapshot.resources.find((resource) => resource.kind === 'extension')
  assert.equal(externalResource?.displayPath, '[user]/[external]')
  assert.equal(externalResource?.name, 'extension')
  assert.ok(snapshot.diagnostics.every((diagnostic) =>
    diagnostic.message === CAPABILITY_INVENTORY_DIAGNOSTIC_MESSAGES[diagnostic.code]))
  const serialized = JSON.stringify(snapshot)
  for (const forbidden of [
    SENTINEL, 'alice', 'token=', 'SKILL-BODY-', 'PROMPT-BODY-', 'THEME-DATA-', 'STACK-'
  ]) assert.equal(serialized.includes(forbidden), false, `leaked ${forbidden}`)
  assertClosedReferences(snapshot)
})

test('core preserves inheritance, normal project override, autoload false delta, filters, and disabled state', async (t) => {
  const { snapshot } = await coreSnapshot(t, {
    globalSettings: {
      packages: ['npm:base-only', 'npm:override@1', 'npm:delta@1']
    },
    projectSettings: {
      packages: [
        { source: 'npm:override@2', extensions: [] },
        { source: 'npm:delta@2', autoload: false, skills: [] }
      ]
    },
    configuredPackages: [
      { source: 'npm:base-only', scope: 'user', filtered: false, installedPath: '/cache/base' },
      { source: 'npm:override@1', scope: 'user', filtered: false, installedPath: '/cache/override1' },
      { source: 'npm:delta@1', scope: 'user', filtered: false, installedPath: '/cache/delta1' },
      { source: 'npm:override@2', scope: 'project', filtered: true, installedPath: '/cache/override2' },
      { source: 'npm:delta@2', scope: 'project', filtered: true, installedPath: '/cache/delta1' }
    ],
    resolved: {
      extensions: [
        { path: '/cache/base/index.mjs', enabled: true, metadata: metadata('npm:base-only', 'user', 'package', '/cache/base') },
        { path: '/cache/override2/index.mjs', enabled: false, metadata: metadata('npm:override@2', 'project', 'package', '/cache/override2') }
      ],
      skills: [
        { path: '/cache/delta1/skills/one', enabled: false, metadata: metadata('npm:delta@2', 'project', 'package', '/cache/delta1') }
      ],
      prompts: [], themes: []
    }
  })
  const bySource = new Map(snapshot.packages.map((pkg) => [pkg.source, pkg]))
  assert.deepEqual(
    { state: bySource.get('npm:base-only')?.state, effective: bySource.get('npm:base-only')?.effective },
    { state: 'inherited', effective: true }
  )
  assert.deepEqual(
    { state: bySource.get('npm:override@1')?.state, effective: bySource.get('npm:override@1')?.effective },
    { state: 'declared', effective: false }
  )
  assert.deepEqual(
    { state: bySource.get('npm:override@2')?.state, effective: bySource.get('npm:override@2')?.effective },
    { state: 'project-override', effective: true }
  )
  assert.deepEqual(
    { state: bySource.get('npm:delta@1')?.state, effective: bySource.get('npm:delta@1')?.effective },
    { state: 'inherited', effective: true }
  )
  assert.deepEqual(
    { state: bySource.get('npm:delta@2')?.state, effective: bySource.get('npm:delta@2')?.effective },
    { state: 'project-delta', effective: true }
  )
  assert.ok(snapshot.resources.some((resource) => resource.source === 'npm:override@2' && resource.state === 'disabled'))
  assert.ok(snapshot.resources.some((resource) => resource.source === 'npm:delta@2' && resource.state === 'disabled'))
  assertClosedReferences(snapshot)
})

test('project-only scope excludes unrelated user diagnostics, counts, and limit flags before selection', async (t) => {
  const userPackages = Array.from({ length: CAPABILITY_INVENTORY_LIMITS.packages + 20 }, (_, index) =>
    `npm:user-${String(index).padStart(4, '0')}`)
  const userExtensions = Array.from({ length: CAPABILITY_INVENTORY_LIMITS.resources + 10 }, (_, index) => ({
    path: `/user/resources/${String(index).padStart(5, '0')}.mjs`, enabled: true,
    metadata: metadata('npm:user-0000', 'user', 'package', '/user/resources')
  }))
  const projectRoot = '/project/only'
  const { snapshot } = await coreSnapshot(t, {
    globalSettings: { packages: userPackages },
    projectSettings: { packages: ['npm:project-only'] },
    configuredPackages: [
      ...userPackages.map((source) => ({ source, scope: 'user', filtered: false, installedPath: `/cache/${source}` })),
      { source: 'npm:project-only', scope: 'project', filtered: false, installedPath: projectRoot }
    ],
    resolved: {
      extensions: [
        ...userExtensions,
        { path: `${projectRoot}/index.mjs`, enabled: true, metadata: metadata('npm:project-only', 'project', 'package', projectRoot) }
      ],
      skills: [
        { path: '/user/bad', enabled: true, metadata: metadata('auto', 'user', 'top-level') },
        { path: `${projectRoot}/skills`, enabled: true, metadata: metadata('npm:project-only', 'project', 'package', projectRoot) }
      ],
      prompts: [], themes: []
    },
    loadedSkills: {
      skills: [{
        name: 'project-skill', filePath: `${projectRoot}/skills/SKILL.md`, disableModelInvocation: false,
        sourceInfo: { path: `${projectRoot}/skills/SKILL.md`, ...metadata('npm:project-only', 'project', 'package', projectRoot) }
      }],
      diagnostics: [{ type: 'error', message: SENTINEL, path: '/user/bad/SKILL.md' }]
    }
  }, { scope: 'project', projectTrusted: true })

  assert.deepEqual(snapshot.packages.map((pkg) => pkg.source), ['npm:project-only'])
  assert.ok(snapshot.resources.every((resource) => resource.scope === 'project'))
  assert.deepEqual(snapshot.truncated, {
    packages: false, resources: false, diagnostics: false, canonicalEffectiveResources: false
  })
  assert.equal(snapshot.resolvedComplete, true)
  assert.equal(JSON.stringify(snapshot).includes(SENTINEL), false)
})

test('independent malformed settings, resolved paths, entries, and loaded collections are incomplete with deterministic priority', async (t) => {
  const cases: Array<{ name: string, data: FakeData }> = [
    { name: 'settings diagnostics collection', data: { settingsErrors: { bad: true } } },
    { name: 'resolved collection', data: { resolved: { extensions: 'bad', skills: [], prompts: [], themes: [] } } },
    { name: 'resolved entry', data: { resolved: { extensions: [{ nope: true }], skills: [], prompts: [], themes: [] } } },
    { name: 'skill collection', data: { loadedSkills: { skills: 'bad', diagnostics: [] } } },
    { name: 'prompt collection', data: { loadedPrompts: null } },
    { name: 'theme collection', data: { loadedThemes: { themes: [], diagnostics: 'bad' } } }
  ]
  for (const fixture of cases) {
    await t.test(fixture.name, async (subtest) => {
      const { snapshot } = await coreSnapshot(subtest, fixture.data)
      assert.equal(snapshot.resolvedComplete, false)
      assert.equal(snapshot.resolvedUnavailableReason, 'sdk-error')
      assert.ok(snapshot.diagnostics.some((diagnostic) => diagnostic.code === 'SDK_RESULT_INVALID'))
    })
  }

  const { snapshot: priority } = await coreSnapshot(t, {
    globalSettings: { packages: ['npm:missing'] },
    configuredPackages: [{ source: 'npm:missing', scope: 'user', filtered: false }],
    resolved: {
      extensions: 'bad',
      skills: [{ path: '/bad', enabled: true, metadata: metadata('auto', 'user', 'top-level') }],
      prompts: [], themes: []
    },
    loadedSkills: {
      skills: [],
      diagnostics: Array.from({ length: CAPABILITY_INVENTORY_LIMITS.diagnostics * 2 + 1 }, () => ({
        type: 'error', path: '/bad', message: SENTINEL
      }))
    }
  })
  assert.equal(priority.resolvedUnavailableReason, 'limit')
  assert.equal(priority.resolvedComplete, false)
})

test('thrown SDK errors never reflect unlabeled messages or causes', async (t) => {
  const { snapshot } = await coreSnapshot(t, {
    throwResolve: Object.assign(new Error(SENTINEL), { cause: { stack: `STACK-${SENTINEL}` } })
  })
  assert.equal(snapshot.resolvedComplete, false)
  assert.equal(snapshot.resolvedUnavailableReason, 'sdk-error')
  assert.ok(snapshot.diagnostics.some((diagnostic) => diagnostic.code === 'PACKAGE_RESOLVE_FAILED'))
  assert.equal(JSON.stringify(snapshot).includes(SENTINEL), false)
})

test('non-ASCII resource names use canonical ordinal order rather than locale collation', async (t) => {
  const root = '/cache/non-ascii'
  const names = ['中', 'é', 'ä']
  const { snapshot } = await coreSnapshot(t, {
    resolved: {
      extensions: [],
      skills: [{ path: root, enabled: true, metadata: metadata('auto', 'user', 'top-level') }],
      prompts: [], themes: []
    },
    loadedSkills: {
      skills: [...names].reverse().map((name, index) => ({
        name,
        filePath: `${root}/${index}/SKILL.md`,
        disableModelInvocation: false,
        sourceInfo: { path: `${root}/${index}/SKILL.md`, ...metadata('auto', 'user', 'top-level') }
      })),
      diagnostics: []
    }
  })
  assert.deepEqual(snapshot.resources.filter((resource) => resource.kind === 'skill').map((resource) => resource.name),
    [...names].sort())
})

test('package selection precedes package-owned resources and serialized producer output stays within budget', async (t) => {
  const packageSources = Array.from({ length: CAPABILITY_INVENTORY_LIMITS.packages + 1 }, (_, index) =>
    `npm:pkg-${String(index).padStart(4, '0')}`)
  const longLeaf = `${'x'.repeat(1400)}.mjs`
  const extensions = [
    { path: `/cache/pkg-0000/${longLeaf}`, enabled: true, metadata: metadata('npm:pkg-0000', 'user', 'package', '/cache/pkg-0000') },
    { path: `/cache/pkg-0512/${longLeaf}`, enabled: true, metadata: metadata('npm:pkg-0512', 'user', 'package', '/cache/pkg-0512') },
    ...Array.from({ length: CAPABILITY_INVENTORY_LIMITS.resources }, (_, index) => ({
      path: `/bulk/${String(index).padStart(5, '0')}-${longLeaf}`,
      enabled: true,
      metadata: metadata('auto', 'user', 'top-level')
    }))
  ]
  const { snapshot } = await coreSnapshot(t, {
    globalSettings: { packages: packageSources },
    configuredPackages: packageSources.map((source, index) => ({
      source, scope: 'user', filtered: false, installedPath: `/cache/pkg-${String(index).padStart(4, '0')}`
    })),
    resolved: { extensions, skills: [], prompts: [], themes: [] }
  })
  assert.equal(snapshot.resolvedUnavailableReason, 'limit')
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot), 'utf8') <= CAPABILITY_INVENTORY_LIMITS.serializedSnapshotBytes)
  assertClosedReferences(snapshot)
  assert.equal(snapshot.resources.some((resource) => resource.ownerPackageId !== null &&
    !snapshot.packages.some((pkg) => pkg.id === resource.ownerPackageId)), false)
  const resourceOrder = snapshot.resources.map((resource) => `${resource.kind}\0${resource.name}\0${resource.scope}\0${resource.id}`)
  assert.deepEqual(resourceOrder, [...resourceOrder].sort())
})

async function createRealHarness(t: TestContext, options: { timeoutMs?: number, workerPath?: string } = {}): Promise<{
  root: string
  cwd: string
  agentDir: string
  service: PiCapabilityInventoryService
}> {
  assert.ok(existsSync(REAL_PI_ROOT), 'real Pi 0.83.0 package root is required')
  const root = await tempRoot(t, 'pi-gui-capability-real-')
  const cwd = join(root, 'project')
  const agentDir = join(root, 'agent')
  await mkdir(join(cwd, '.pi'), { recursive: true })
  await mkdir(agentDir, { recursive: true })
  await writeJson(join(agentDir, 'settings.json'), {})
  await writeJson(join(cwd, '.pi', 'settings.json'), {})
  return {
    root,
    cwd,
    agentDir,
    service: new PiCapabilityInventoryService({
      piPackage: { explicitExecutable: join(REAL_PI_ROOT, 'dist', 'cli.js') },
      workerPath: options.workerPath ?? SOURCE_WORKER_PATH,
      runtimeExecutable: process.execPath,
      timeoutMs: options.timeoutMs
    })
  }
}

function inventoryInput(
  harness: { cwd: string, agentDir: string },
  overrides: Partial<PiCapabilityInventoryInput> = {}
): PiCapabilityInventoryInput {
  return {
    cwd: overrides.cwd ?? harness.cwd,
    agentDir: overrides.agentDir ?? harness.agentDir,
    projectTrusted: overrides.projectTrusted ?? true,
    scope: overrides.scope ?? 'effective'
  }
}

test('real Pi child blocks configured npm command, installs, Extension execution, and raw YAML/theme diagnostics', async (t) => {
  const harness = await createRealHarness(t)
  const npmMarker = join(harness.root, 'npm-command-executed')
  const extensionMarker = join(harness.root, 'extension-executed')
  const npmCommand = join(harness.root, 'malicious-npm.sh')
  const extensionPath = join(harness.agentDir, 'extensions', 'malicious.mjs')
  const skillDir = join(harness.agentDir, 'skills', 'broken')
  const themePath = join(harness.agentDir, 'themes', 'broken.json')
  await mkdir(dirname(extensionPath), { recursive: true })
  await mkdir(skillDir, { recursive: true })
  await mkdir(dirname(themePath), { recursive: true })
  await writeFile(npmCommand, `#!/bin/sh\nprintf executed > ${JSON.stringify(npmMarker)}\n`, 'utf8')
  await chmod(npmCommand, 0o700)
  await writeFile(extensionPath, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(extensionMarker)}, 'executed')\n`, 'utf8')
  await writeFile(join(skillDir, 'SKILL.md'), `---\nname: broken\ndescription: [${SENTINEL}\n---\nSKILL-BODY-${SENTINEL}\n`, 'utf8')
  await writeFile(themePath, `{ "name": "broken", "colors": { "text": "${SENTINEL}" }`, 'utf8')
  await writeJson(join(harness.agentDir, 'settings.json'), {
    npmCommand: [npmCommand],
    packages: ['npm:inventory-definitely-missing-9f4c2b', 'git:github.com/example/inventory-missing-9f4c2b@v1'],
    extensions: [extensionPath],
    skills: [skillDir],
    themes: [themePath]
  })

  const originalOffline = process.env.PI_OFFLINE
  const originalPath = process.env.PATH
  const snapshot = await harness.service.read(inventoryInput(harness))
  assert.equal(existsSync(npmMarker), false)
  assert.equal(existsSync(extensionMarker), false)
  assert.equal(existsSync(join(harness.agentDir, 'npm', 'node_modules', 'inventory-definitely-missing-9f4c2b')), false)
  assert.equal(existsSync(join(harness.agentDir, 'git', 'github.com', 'example', 'inventory-missing-9f4c2b')), false)
  assert.equal(process.env.PI_OFFLINE, originalOffline)
  assert.equal(process.env.PATH, originalPath)
  assert.ok(snapshot.diagnostics.some((diagnostic) => diagnostic.code === 'PACKAGE_MISSING_OFFLINE'))
  assert.ok(snapshot.diagnostics.some((diagnostic) => diagnostic.code === 'RESOURCE_VALIDATION'))
  assert.equal(snapshot.resolvedComplete, false)
  assert.equal(snapshot.resolvedUnavailableReason, 'sdk-error')
  const serialized = JSON.stringify(snapshot)
  assert.equal(serialized.includes(SENTINEL), false)
  assert.equal(serialized.includes('SKILL-BODY-'), false)
  assertClosedReferences(snapshot)
})

test('real Pi child preserves package filter, override, autoload delta, project-only, and trust semantics', async (t) => {
  const harness = await createRealHarness(t)
  const packageRoot = join(harness.root, 'local-package')
  const extensionPath = join(packageRoot, 'extensions', 'main.mjs')
  const allowedSkill = join(packageRoot, 'skills', 'allowed', 'SKILL.md')
  const blockedSkill = join(packageRoot, 'skills', 'blocked', 'SKILL.md')
  await mkdir(dirname(extensionPath), { recursive: true })
  await mkdir(dirname(allowedSkill), { recursive: true })
  await mkdir(dirname(blockedSkill), { recursive: true })
  await writeJson(join(packageRoot, 'package.json'), {
    name: 'inventory-local-package',
    pi: {
      extensions: ['extensions/*.mjs'],
      skills: ['skills/*']
    }
  })
  await writeFile(extensionPath, 'export default function () { throw new Error("must not execute") }\n', 'utf8')
  await writeFile(allowedSkill, '---\nname: allowed\ndescription: allowed\n---\nAllowed body\n', 'utf8')
  await writeFile(blockedSkill, '---\nname: blocked\ndescription: blocked\n---\nBlocked body\n', 'utf8')

  await writeJson(join(harness.agentDir, 'settings.json'), {
    packages: [{ source: packageRoot, extensions: [], skills: ['skills/allowed'] }]
  })
  let snapshot = await harness.service.read(inventoryInput(harness, { scope: 'user' }))
  assert.equal(snapshot.packages[0]?.filtered, true)
  assert.ok(snapshot.resources.some((resource) => resource.kind === 'extension' && resource.state === 'disabled'))
  assert.ok(snapshot.resources.some((resource) => resource.kind === 'skill' && resource.name === 'allowed' && resource.declaredEnabled))
  assert.ok(snapshot.resources.some((resource) => resource.kind === 'skill' && resource.state === 'disabled'))

  await writeJson(join(harness.cwd, '.pi', 'settings.json'), {
    packages: [{ source: packageRoot, extensions: ['extensions/main.mjs'], skills: [] }]
  })
  snapshot = await harness.service.read(inventoryInput(harness))
  const userOverride = snapshot.packages.find((pkg) => pkg.scope === 'user')
  const projectOverride = snapshot.packages.find((pkg) => pkg.scope === 'project')
  assert.deepEqual({ state: userOverride?.state, effective: userOverride?.effective }, { state: 'declared', effective: false })
  assert.deepEqual({ state: projectOverride?.state, effective: projectOverride?.effective }, { state: 'project-override', effective: true })
  assert.ok(snapshot.resources.some((resource) => resource.scope === 'project' && resource.kind === 'extension'))

  await writeJson(join(harness.cwd, '.pi', 'settings.json'), {
    packages: [{ source: packageRoot, autoload: false, extensions: [], skills: [] }]
  })
  snapshot = await harness.service.read(inventoryInput(harness))
  assert.equal(snapshot.packages.find((pkg) => pkg.scope === 'project')?.state, 'project-delta')
  assert.equal(snapshot.packages.find((pkg) => pkg.scope === 'user')?.effective, true)

  const userBadSkill = join(harness.agentDir, 'skills', 'user-bad')
  const projectGoodSkill = join(harness.cwd, '.pi', 'skills', 'project-good')
  await mkdir(userBadSkill, { recursive: true })
  await mkdir(projectGoodSkill, { recursive: true })
  await writeFile(join(userBadSkill, 'SKILL.md'), `---\nname: bad\ndescription: [${SENTINEL}\n---\n`, 'utf8')
  await writeFile(join(projectGoodSkill, 'SKILL.md'), '---\nname: project-good\ndescription: good\n---\nGood\n', 'utf8')
  await writeJson(join(harness.agentDir, 'settings.json'), { skills: [userBadSkill] })
  await writeJson(join(harness.cwd, '.pi', 'settings.json'), { skills: [projectGoodSkill] })

  snapshot = await harness.service.read(inventoryInput(harness, { scope: 'project', projectTrusted: true }))
  assert.ok(snapshot.resources.length > 0)
  assert.ok(snapshot.resources.every((resource) => resource.scope === 'project'))
  assert.equal(JSON.stringify(snapshot).includes(SENTINEL), false)
  assert.equal(snapshot.diagnostics.some((diagnostic) => diagnostic.code === 'RESOURCE_VALIDATION'), false)

  snapshot = await harness.service.read(inventoryInput(harness, { scope: 'effective', projectTrusted: false }))
  assert.ok(snapshot.resources.every((resource) => resource.scope === 'user'))
  assert.ok(snapshot.diagnostics.some((diagnostic) => diagnostic.code === 'PROJECT_SCOPE_EXCLUDED'))
  assert.equal(JSON.stringify(snapshot).includes('project-good'), false)

  snapshot = await harness.service.read(inventoryInput(harness, { scope: 'project', projectTrusted: false }))
  assert.deepEqual(snapshot.packages, [])
  assert.deepEqual(snapshot.resources, [])
  assert.ok(snapshot.diagnostics.some((diagnostic) => diagnostic.code === 'PROJECT_SCOPE_EXCLUDED'))
})

async function writeSnapshotWorker(t: TestContext, root: string, snapshot: unknown): Promise<string> {
  const path = join(root, `worker-${Math.random().toString(16).slice(2)}.mjs`)
  await writeFile(path, `for await (const _chunk of process.stdin) {}\nprocess.stdout.write(${JSON.stringify(`${JSON.stringify({ ok: true, snapshot })}\n`)})\n`, 'utf8')
  return path
}

function baseSnapshot(scope: PiCapabilityInventoryInput['scope'] = 'effective', trusted = true): CapabilityInventorySnapshot {
  return {
    schemaVersion: 1,
    inventoryKind: 'static-resolved-not-runtime-effective',
    requestedScope: scope,
    projectTrusted: trusted,
    resolvedComplete: true,
    resolvedUnavailableReason: null,
    packages: [], resources: [], diagnostics: [],
    truncated: { packages: false, resources: false, diagnostics: false, canonicalEffectiveResources: false }
  }
}

function packageDto(id: string, source: string, scope: CapabilityInventoryScope = 'user') {
  return {
    id,
    inventoryState: 'static-declaration' as const,
    scope,
    source,
    sourceKind: 'npm' as const,
    packageName: source.slice(4),
    requestedVersionOrRef: null,
    installedVersion: null,
    installed: true,
    filtered: false,
    autoload: null,
    state: 'inherited' as const,
    effective: true,
    resourceCounts: { extensions: 0, skills: 0, prompts: 0, themes: 0 },
    resourceCountsTruncated: false,
    diagnosticIds: [] as string[]
  }
}

function resourceDto(
  id: string,
  ownerPackageId: string | null = null,
  scope: CapabilityInventoryScope = 'user'
) {
  return {
    id,
    inventoryState: 'static-resolved' as const,
    runtimeEffectiveState: 'not-observed' as const,
    kind: 'extension' as const,
    name: 'extension',
    scope,
    origin: ownerPackageId === null ? 'top-level' as const : 'package' as const,
    ownerPackageId,
    source: ownerPackageId === null ? `[local:${scope}]` : 'npm:a',
    displayPath: `[${scope}]/extension.mjs`,
    declaredEnabled: true,
    state: 'inherited' as const,
    modelInvocation: 'unknown' as const,
    diagnosticIds: [] as string[]
  }
}

const SDK_ERROR_DIAGNOSTIC_CODES = new Set<CapabilityInventoryDiagnosticCode>([
  'INVENTORY_WORKER_FAILED', 'INVENTORY_WORKER_TIMEOUT', 'INVENTORY_WORKER_ABORTED',
  'PI_ROOT_IMPORT_FAILED', 'PI_SDK_SHAPE_INVALID', 'SETTINGS_CREATE_FAILED',
  'SETTINGS_LOAD_FAILED', 'PACKAGE_LIST_FAILED', 'PACKAGE_RESOLVE_FAILED',
  'RESOURCE_LOADER_FAILED', 'SDK_RESULT_INVALID', 'RESOURCE_VALIDATION', 'FIELD_INVALID'
])

function diagnosticDto(code: CapabilityInventoryDiagnosticCode, id = `diag_${code.toLowerCase()}`) {
  const policy = CAPABILITY_INVENTORY_DIAGNOSTIC_POLICIES[code]
  return {
    id,
    code,
    severity: policy.severity,
    kind: policy.kind,
    resourceId: null,
    message: CAPABILITY_INVENTORY_DIAGNOSTIC_MESSAGES[code],
    collision: policy.collision === 'required'
      ? { resourceKind: 'extension' as const, name: 'extension', winnerResourceId: null, loserResourceId: null }
      : null
  }
}

function snapshotWithDiagnostics(
  scope: PiCapabilityInventoryInput['scope'],
  trusted: boolean,
  codes: CapabilityInventoryDiagnosticCode[]
): CapabilityInventorySnapshot {
  const snapshot = baseSnapshot(scope, trusted)
  snapshot.diagnostics = codes.map((code, index) => diagnosticDto(code, `diag_${String(index).padStart(3, '0')}`))
    .sort((a, b) => a.code < b.code ? -1 : a.code > b.code ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  if (codes.includes('LIMIT_EXCEEDED')) snapshot.truncated.diagnostics = true
  snapshot.resolvedUnavailableReason = codes.includes('LIMIT_EXCEEDED')
    ? 'limit'
    : codes.some((code) => SDK_ERROR_DIAGNOSTIC_CODES.has(code))
      ? 'sdk-error'
      : codes.includes('PACKAGE_MISSING_OFFLINE')
        ? 'offline-missing-package'
        : null
  snapshot.resolvedComplete = snapshot.resolvedUnavailableReason === null
  return snapshot
}

async function readCustomWorkerSnapshot(
  t: TestContext,
  harness: { root: string, cwd: string, agentDir: string },
  snapshot: unknown,
  overrides: Partial<PiCapabilityInventoryInput> = {}
): Promise<CapabilityInventorySnapshot> {
  const workerPath = await writeSnapshotWorker(t, harness.root, snapshot)
  const service = new PiCapabilityInventoryService({
    piPackage: { explicitExecutable: join(REAL_PI_ROOT, 'dist', 'cli.js') },
    workerPath,
    runtimeExecutable: process.execPath
  })
  return service.read(inventoryInput(harness, overrides))
}

test('Main semantic validator rejects unknown fields, duplicates, dangling refs, mismatch, order, reason, and lone surrogates', async (t) => {
  const harness = await createRealHarness(t)
  const cases: Array<{ name: string, mutate: (snapshot: any) => void }> = [
    { name: 'unknown field', mutate: (snapshot) => { snapshot.unknown = true } },
    { name: 'mismatched request scope', mutate: (snapshot) => { snapshot.requestedScope = 'user' } },
    { name: 'duplicate IDs', mutate: (snapshot) => {
      snapshot.packages = [packageDto('same', 'npm:a')]
      snapshot.resources = [resourceDto('same')]
    } },
    { name: 'dangling owner', mutate: (snapshot) => { snapshot.resources = [resourceDto('res_a', 'pkg_missing')] } },
    { name: 'noncanonical order', mutate: (snapshot) => {
      snapshot.packages = [packageDto('pkg_b', 'npm:b'), packageDto('pkg_a', 'npm:a')]
    } },
    { name: 'lone surrogate', mutate: (snapshot) => { snapshot.resources = [{ ...resourceDto('res_a'), name: '\ud800' }] } },
    { name: 'reason mismatch', mutate: (snapshot) => {
      snapshot.resolvedComplete = false
      snapshot.resolvedUnavailableReason = 'sdk-error'
    } },
    { name: 'duplicate diagnostic IDs', mutate: (snapshot) => {
      snapshot.packages = [{ ...packageDto('pkg_a', 'npm:a'), diagnosticIds: ['diag_x', 'diag_x'] }]
      snapshot.diagnostics = [{
        id: 'diag_x', code: 'RESOURCE_COLLISION', severity: 'warning', kind: 'collision', resourceId: null,
        message: CAPABILITY_INVENTORY_DIAGNOSTIC_MESSAGES.RESOURCE_COLLISION,
        collision: { resourceKind: 'extension', name: 'x', winnerResourceId: null, loserResourceId: null }
      }]
    } },
    { name: 'dangling collision ref', mutate: (snapshot) => {
      snapshot.diagnostics = [{
        id: 'diag_x', code: 'RESOURCE_COLLISION', severity: 'warning', kind: 'collision', resourceId: null,
        message: CAPABILITY_INVENTORY_DIAGNOSTIC_MESSAGES.RESOURCE_COLLISION,
        collision: { resourceKind: 'extension', name: 'x', winnerResourceId: 'res_missing', loserResourceId: null }
      }]
    } },
    { name: 'raw diagnostic reflection', mutate: (snapshot) => {
      snapshot.diagnostics = [{
        id: 'diag_x', code: 'RESOURCE_COLLISION', severity: 'warning', kind: 'collision', resourceId: null,
        message: SENTINEL,
        collision: { resourceKind: 'extension', name: 'x', winnerResourceId: null, loserResourceId: null }
      }]
    } }
  ]

  for (const fixture of cases) {
    await t.test(fixture.name, async (subtest) => {
      const snapshot: any = structuredClone(baseSnapshot())
      fixture.mutate(snapshot)
      const workerPath = await writeSnapshotWorker(subtest, harness.root, snapshot)
      const service = new PiCapabilityInventoryService({
        piPackage: { explicitExecutable: join(REAL_PI_ROOT, 'dist', 'cli.js') },
        workerPath,
        runtimeExecutable: process.execPath
      })
      const result = await service.read(inventoryInput(harness))
      assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ['INVENTORY_WORKER_FAILED'])
    })
  }
})

test('Main derives allowed package and resource scopes from requested scope and trust', async (t) => {
  const harness = await createRealHarness(t)
  const rejectedCases: Array<{
    name: string
    scope: PiCapabilityInventoryInput['scope']
    trusted: boolean
    mutate: (snapshot: CapabilityInventorySnapshot) => void
  }> = [
    { name: 'user request with project package', scope: 'user', trusted: true, mutate: (snapshot) => {
      snapshot.packages = [packageDto('pkg_project', 'npm:project', 'project')]
    } },
    { name: 'untrusted user request with project resource', scope: 'user', trusted: false, mutate: (snapshot) => {
      snapshot.resources = [resourceDto('res_project', null, 'project')]
    } },
    { name: 'trusted project request with user package', scope: 'project', trusted: true, mutate: (snapshot) => {
      snapshot.packages = [packageDto('pkg_user', 'npm:user')]
    } },
    { name: 'trusted project request with user resource', scope: 'project', trusted: true, mutate: (snapshot) => {
      snapshot.resources = [resourceDto('res_user')]
    } },
    { name: 'untrusted project request with user package', scope: 'project', trusted: false, mutate: (snapshot) => {
      snapshot.packages = [packageDto('pkg_user', 'npm:user')]
    } },
    { name: 'untrusted project request with project resource', scope: 'project', trusted: false, mutate: (snapshot) => {
      snapshot.resources = [resourceDto('res_project', null, 'project')]
    } },
    { name: 'untrusted effective request with project package', scope: 'effective', trusted: false, mutate: (snapshot) => {
      snapshot.packages = [packageDto('pkg_project', 'npm:project', 'project')]
    } },
    { name: 'untrusted effective request with project resource', scope: 'effective', trusted: false, mutate: (snapshot) => {
      snapshot.resources = [resourceDto('res_project', null, 'project')]
    } }
  ]

  for (const fixture of rejectedCases) {
    await t.test(fixture.name, async (subtest) => {
      const codes: CapabilityInventoryDiagnosticCode[] = fixture.scope !== 'user' && !fixture.trusted
        ? ['PROJECT_SCOPE_EXCLUDED']
        : []
      const snapshot = snapshotWithDiagnostics(fixture.scope, fixture.trusted, codes)
      fixture.mutate(snapshot)
      const result = await readCustomWorkerSnapshot(subtest, harness, snapshot, {
        scope: fixture.scope,
        projectTrusted: fixture.trusted
      })
      assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ['INVENTORY_WORKER_FAILED'])
    })
  }

  const acceptedCases: Array<{
    name: string
    scope: PiCapabilityInventoryInput['scope']
    trusted: boolean
    packages: ReturnType<typeof packageDto>[]
    resources: ReturnType<typeof resourceDto>[]
  }> = [
    {
      name: 'untrusted user request keeps user records without exclusion diagnostic',
      scope: 'user', trusted: false,
      packages: [packageDto('pkg_user', 'npm:user')],
      resources: [resourceDto('res_user')]
    },
    {
      name: 'trusted project request keeps project records',
      scope: 'project', trusted: true,
      packages: [packageDto('pkg_project', 'npm:project', 'project')],
      resources: [resourceDto('res_project', null, 'project')]
    },
    {
      name: 'trusted effective request keeps user and project records',
      scope: 'effective', trusted: true,
      packages: [packageDto('pkg_user', 'npm:user'), packageDto('pkg_project', 'npm:project', 'project')],
      resources: [resourceDto('res_user'), resourceDto('res_project', null, 'project')]
    },
    {
      name: 'untrusted project request keeps no records and reports exclusion',
      scope: 'project', trusted: false,
      packages: [], resources: []
    },
    {
      name: 'untrusted effective request keeps user records and reports exclusion',
      scope: 'effective', trusted: false,
      packages: [packageDto('pkg_user', 'npm:user')],
      resources: [resourceDto('res_user')]
    }
  ]

  for (const fixture of acceptedCases) {
    await t.test(fixture.name, async (subtest) => {
      const codes: CapabilityInventoryDiagnosticCode[] = fixture.scope !== 'user' && !fixture.trusted
        ? ['PROJECT_SCOPE_EXCLUDED']
        : []
      const snapshot = snapshotWithDiagnostics(fixture.scope, fixture.trusted, codes)
      snapshot.packages = fixture.packages
      snapshot.resources = fixture.resources
      const result = await readCustomWorkerSnapshot(subtest, harness, snapshot, {
        scope: fixture.scope,
        projectTrusted: fixture.trusted
      })
      assert.notDeepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ['INVENTORY_WORKER_FAILED'])
      assert.deepEqual(result.packages.map((pkg) => pkg.scope), fixture.packages.map((pkg) => pkg.scope))
      assert.deepEqual(result.resources.map((resource) => resource.scope), fixture.resources.map((resource) => resource.scope))
    })
  }
})

test('Main enforces PROJECT_SCOPE_EXCLUDED presence and absence for successful snapshots', async (t) => {
  const harness = await createRealHarness(t)
  const cases: Array<{
    name: string
    scope: PiCapabilityInventoryInput['scope']
    trusted: boolean
    codes: CapabilityInventoryDiagnosticCode[]
  }> = [
    { name: 'missing from untrusted project', scope: 'project', trusted: false, codes: [] },
    { name: 'missing from untrusted effective', scope: 'effective', trusted: false, codes: [] },
    { name: 'present in trusted user', scope: 'user', trusted: true, codes: ['PROJECT_SCOPE_EXCLUDED'] },
    { name: 'present in untrusted user', scope: 'user', trusted: false, codes: ['PROJECT_SCOPE_EXCLUDED'] },
    { name: 'present in trusted project', scope: 'project', trusted: true, codes: ['PROJECT_SCOPE_EXCLUDED'] },
    { name: 'present in trusted effective', scope: 'effective', trusted: true, codes: ['PROJECT_SCOPE_EXCLUDED'] },
    {
      name: 'duplicated in untrusted effective', scope: 'effective', trusted: false,
      codes: ['PROJECT_SCOPE_EXCLUDED', 'PROJECT_SCOPE_EXCLUDED']
    }
  ]

  for (const fixture of cases) {
    await t.test(fixture.name, async (subtest) => {
      const snapshot = snapshotWithDiagnostics(fixture.scope, fixture.trusted, fixture.codes)
      const result = await readCustomWorkerSnapshot(subtest, harness, snapshot, {
        scope: fixture.scope,
        projectTrusted: fixture.trusted
      })
      assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ['INVENTORY_WORKER_FAILED'])
    })
  }
})

test('Main pins canonical severity and kind for every diagnostic code', async (t) => {
  const harness = await createRealHarness(t)
  const codes = Object.keys(CAPABILITY_INVENTORY_DIAGNOSTIC_POLICIES) as CapabilityInventoryDiagnosticCode[]
  for (const code of codes) {
    await t.test(code, async (subtest) => {
      const scope = code === 'PROJECT_SCOPE_EXCLUDED' ? 'effective' : 'effective'
      const trusted = code !== 'PROJECT_SCOPE_EXCLUDED'
      const snapshot = snapshotWithDiagnostics(scope, trusted, [code])
      const diagnostic = snapshot.diagnostics[0]!
      diagnostic.severity = diagnostic.severity === 'error' ? 'warning' : 'error'
      diagnostic.kind = diagnostic.kind === 'inventory' ? 'validation' : 'inventory'
      const result = await readCustomWorkerSnapshot(subtest, harness, snapshot, {
        scope,
        projectTrusted: trusted
      })
      assert.deepEqual(result.diagnostics.map((item) => item.code), ['INVENTORY_WORKER_FAILED'])
    })
  }
})

test('Main preserves fixed collision semantics independently of diagnostic text and metadata', async (t) => {
  const harness = await createRealHarness(t)
  const cases: Array<{ name: string, snapshot: CapabilityInventorySnapshot }> = []

  const collisionMissing = snapshotWithDiagnostics('effective', true, ['RESOURCE_COLLISION'])
  collisionMissing.diagnostics[0]!.collision = null
  cases.push({ name: 'collision code without collision', snapshot: collisionMissing })

  const collisionForbidden = snapshotWithDiagnostics('effective', true, ['PACKAGE_MISSING_OFFLINE'])
  collisionForbidden.diagnostics[0]!.collision = {
    resourceKind: 'extension', name: 'extension', winnerResourceId: null, loserResourceId: null
  }
  cases.push({ name: 'non-collision code with collision', snapshot: collisionForbidden })

  for (const fixture of cases) {
    await t.test(fixture.name, async (subtest) => {
      const result = await readCustomWorkerSnapshot(subtest, harness, fixture.snapshot)
      assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ['INVENTORY_WORKER_FAILED'])
    })
  }
})

test('service enforces request bytes before spawn', async (t) => {
  const harness = await createRealHarness(t)
  const marker = join(harness.root, 'spawned')
  const worker = join(harness.root, 'marker-worker.mjs')
  await writeFile(worker, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'yes')\n`, 'utf8')
  const service = new PiCapabilityInventoryService({ piPackage: { explicitExecutable: join(REAL_PI_ROOT, 'dist', 'cli.js') }, workerPath: worker })
  await assert.rejects(() => service.read(inventoryInput(harness, {
    cwd: `/${'c'.repeat(16_300)}`,
    agentDir: `/${'a'.repeat(16_300)}`
  })), /transport limit/u)
  assert.equal(existsSync(marker), false)
})

test('Main-generated worker failures remain coherent for untrusted non-user requests', async (t) => {
  const harness = await createRealHarness(t)
  const controller = new AbortController()
  controller.abort()
  const result = await harness.service.read(inventoryInput(harness, {
    scope: 'project',
    projectTrusted: false
  }), { signal: controller.signal })
  assert.deepEqual(result.packages, [])
  assert.deepEqual(result.resources, [])
  assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ['INVENTORY_WORKER_ABORTED'])
  assert.equal(result.resolvedComplete, false)
  assert.equal(result.resolvedUnavailableReason, 'sdk-error')
})

test('Main enforces the serialized snapshot budget after copy and semantic validation', async (t) => {
  const harness = await createRealHarness(t)
  const snapshot = baseSnapshot()
  snapshot.resources = Array.from({ length: CAPABILITY_INVENTORY_LIMITS.resources }, (_, index) => ({
    ...resourceDto(`res_${String(index).padStart(4, '0')}`),
    displayPath: 'x'
  }))
  const baseBytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8')
  const paddingBytes = Math.floor(
    (CAPABILITY_INVENTORY_LIMITS.serializedSnapshotBytes - baseBytes) / CAPABILITY_INVENTORY_LIMITS.resources
  ) + 2
  assert.ok(paddingBytes > 0 && paddingBytes <= CAPABILITY_INVENTORY_LIMITS.displayPathBytes)
  for (const resource of snapshot.resources) resource.displayPath = 'x'.repeat(paddingBytes)
  const serializedBytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8')
  assert.ok(serializedBytes > CAPABILITY_INVENTORY_LIMITS.serializedSnapshotBytes)
  assert.ok(serializedBytes < CAPABILITY_INVENTORY_LIMITS.workerResponseBytes - 1024)

  const result = await readCustomWorkerSnapshot(t, harness, snapshot)
  assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ['INVENTORY_WORKER_FAILED'])
})

test('worker environment uses a fixed locale and does not inherit TMPDIR', async (t) => {
  const harness = await createRealHarness(t)
  const workerPath = join(harness.root, 'environment-worker.mjs')
  const snapshot = baseSnapshot()
  await writeFile(workerPath, `
for await (const _chunk of process.stdin) {}
const valid = process.env.LANG === 'C.UTF-8' && process.env.LC_ALL === 'C.UTF-8' && process.env.TMPDIR === undefined
process.stdout.write(JSON.stringify(valid ? ${JSON.stringify({ ok: true, snapshot })} : { ok: false }) + '\\n')
`, 'utf8')
  const previous = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, TMPDIR: process.env.TMPDIR }
  process.env.LANG = 'inherited-locale-must-not-pass'
  process.env.LC_ALL = 'inherited-locale-must-not-pass'
  process.env.TMPDIR = join(harness.root, 'inherited-tmpdir-must-not-pass')
  try {
    const service = new PiCapabilityInventoryService({
      piPackage: { explicitExecutable: join(REAL_PI_ROOT, 'dist', 'cli.js') },
      workerPath,
      runtimeExecutable: process.execPath
    })
    const result = await service.read(inventoryInput(harness))
    assert.deepEqual(result.diagnostics, [])
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

async function waitForFile(path: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return
    await delay(20)
  }
  throw new Error(`Timed out waiting for ${path}`)
}

async function descendantWorker(
  root: string,
  mode: 'timeout' | 'abort' | 'overflow',
  marker: string,
  ready: string
): Promise<string> {
  const path = join(root, `descendant-${mode}.mjs`)
  const descendant = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 800)`
  await writeFile(path, `
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
for await (const _chunk of process.stdin) {}
spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' })
writeFileSync(${JSON.stringify(ready)}, 'ready')
${mode === 'overflow'
    ? `process.stdout.write(Buffer.alloc(${CAPABILITY_INVENTORY_LIMITS.workerResponseBytes + 1024}, 120)); await new Promise(() => {})`
    : 'await new Promise(() => {})'}
`, 'utf8')
  return path
}

test('timeout, abort, and stdout overflow terminate the detached Linux process group after bounded grace', async (t) => {
  const harness = await createRealHarness(t)
  for (const mode of ['timeout', 'abort', 'overflow'] as const) {
    await t.test(mode, async (subtest) => {
      const marker = join(harness.root, `${mode}-descendant-survived`)
      const ready = join(harness.root, `${mode}-ready`)
      const workerPath = await descendantWorker(harness.root, mode, marker, ready)
      const service = new PiCapabilityInventoryService({
        piPackage: { explicitExecutable: join(REAL_PI_ROOT, 'dist', 'cli.js') },
        workerPath,
        runtimeExecutable: process.execPath,
        timeoutMs: mode === 'timeout' ? 350 : 5_000
      })
      const controller = new AbortController()
      const resultPromise = service.read(inventoryInput(harness), { signal: controller.signal })
      await waitForFile(ready)
      if (mode === 'abort') controller.abort()
      const result = await resultPromise
      const expected = mode === 'timeout'
        ? 'INVENTORY_WORKER_TIMEOUT'
        : mode === 'abort'
          ? 'INVENTORY_WORKER_ABORTED'
          : 'INVENTORY_WORKER_FAILED'
      assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), [expected])
      await delay(1_000)
      assert.equal(existsSync(marker), false)
    })
  }
})

test('successful worker exit kills remaining ordinary descendants before settlement', async (t) => {
  const harness = await createRealHarness(t)
  const marker = join(harness.root, 'successful-descendant-survived')
  const workerPath = join(harness.root, 'successful-descendant-worker.mjs')
  const descendant = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'survived'), 800)`
  const response = `${JSON.stringify({ ok: true, snapshot: baseSnapshot() })}\n`
  await writeFile(workerPath, `
import { spawn } from 'node:child_process'
for await (const _chunk of process.stdin) {}
const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {
  stdio: ['ignore', 'inherit', 'inherit']
})
child.unref()
process.stdout.write(${JSON.stringify(response)})
`, 'utf8')

  const service = new PiCapabilityInventoryService({
    piPackage: { explicitExecutable: join(REAL_PI_ROOT, 'dist', 'cli.js') },
    workerPath,
    runtimeExecutable: process.execPath
  })
  const result = await service.read(inventoryInput(harness))
  assert.deepEqual(result.diagnostics, [])
  await delay(1_000)
  assert.equal(existsSync(marker), false)
})

test('wrong-name and escaped-root packages are rejected before their top-level module executes', async (t) => {
  const harness = await createRealHarness(t)
  const marker = join(harness.root, 'wrong-package-executed')
  const wrongRoot = join(harness.root, 'wrong-package')
  await mkdir(join(wrongRoot, 'dist'), { recursive: true })
  await writeFile(join(wrongRoot, 'dist', 'cli.js'), '#!/usr/bin/env node\nprocess.stdout.write("0.83.0\\n")\n', 'utf8')
  await chmod(join(wrongRoot, 'dist', 'cli.js'), 0o700)
  await writeJson(join(wrongRoot, 'package.json'), {
    name: '@wrong/pi-coding-agent', version: '0.83.0', type: 'module',
    exports: { '.': { import: './index.mjs' } }
  })
  await writeFile(join(wrongRoot, 'index.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'yes')\nexport const SettingsManager = {}\n`, 'utf8')
  const wrongService = new PiCapabilityInventoryService({
    piPackage: { explicitExecutable: join(wrongRoot, 'dist', 'cli.js') },
    workerPath: SOURCE_WORKER_PATH,
    runtimeExecutable: process.execPath
  })
  const wrong = await wrongService.read(inventoryInput(harness))
  assert.deepEqual(wrong.diagnostics.map((diagnostic) => diagnostic.code), ['PI_ROOT_IMPORT_FAILED'])
  assert.equal(existsSync(marker), false)

  const wrongVersionRoot = join(harness.root, 'wrong-version-package')
  await mkdir(join(wrongVersionRoot, 'dist'), { recursive: true })
  await writeFile(join(wrongVersionRoot, 'dist', 'cli.js'), '#!/usr/bin/env node\nprocess.stdout.write("0.83.0\\n")\n', 'utf8')
  await chmod(join(wrongVersionRoot, 'dist', 'cli.js'), 0o700)
  await writeJson(join(wrongVersionRoot, 'package.json'), {
    name: '@earendil-works/pi-coding-agent', version: '0.80.11', type: 'module',
    exports: { '.': { import: './index.mjs' } }
  })
  await writeFile(join(wrongVersionRoot, 'index.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'version')\n`, 'utf8')
  const wrongVersionService = new PiCapabilityInventoryService({
    piPackage: { explicitExecutable: join(wrongVersionRoot, 'dist', 'cli.js') },
    workerPath: SOURCE_WORKER_PATH,
    runtimeExecutable: process.execPath
  })
  const wrongVersion = await wrongVersionService.read(inventoryInput(harness))
  assert.deepEqual(wrongVersion.diagnostics.map((diagnostic) => diagnostic.code), ['PI_ROOT_IMPORT_FAILED'])
  assert.equal(existsSync(marker), false)

  const escapedRoot = join(harness.root, 'escaped-package')
  const outsideEntry = join(harness.root, 'outside.mjs')
  await mkdir(join(escapedRoot, 'dist'), { recursive: true })
  await writeFile(join(escapedRoot, 'dist', 'cli.js'), '#!/usr/bin/env node\nprocess.stdout.write("0.83.0\\n")\n', 'utf8')
  await chmod(join(escapedRoot, 'dist', 'cli.js'), 0o700)
  await writeJson(join(escapedRoot, 'package.json'), {
    name: '@earendil-works/pi-coding-agent', version: '0.83.0', type: 'module',
    exports: { '.': { import: './index.mjs' } }
  })
  await writeFile(outsideEntry, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'escaped')\n`, 'utf8')
  await symlink(outsideEntry, join(escapedRoot, 'index.mjs'))
  const escapedService = new PiCapabilityInventoryService({
    piPackage: { explicitExecutable: join(escapedRoot, 'dist', 'cli.js') },
    workerPath: SOURCE_WORKER_PATH,
    runtimeExecutable: process.execPath
  })
  const escaped = await escapedService.read(inventoryInput(harness))
  assert.deepEqual(escaped.diagnostics.map((diagnostic) => diagnostic.code), ['PI_ROOT_IMPORT_FAILED'])
  assert.equal(existsSync(marker), false)
})

test('built worker reads the real local Pi root when the build entry exists', {
  skip: !existsSync(BUILT_WORKER_PATH)
}, async (t) => {
  const harness = await createRealHarness(t, { workerPath: BUILT_WORKER_PATH })
  const snapshot = await harness.service.read(inventoryInput(harness))
  assert.equal(snapshot.requestedScope, 'effective')
  assert.equal(snapshot.projectTrusted, true)
  assert.notEqual(snapshot.diagnostics[0]?.code, 'INVENTORY_WORKER_FAILED')
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot), 'utf8') <= CAPABILITY_INVENTORY_LIMITS.serializedSnapshotBytes)
})
