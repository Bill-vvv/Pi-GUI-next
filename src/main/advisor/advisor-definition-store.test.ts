import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { AdvisorDefinitionStore } from './advisor-definition-store.ts'

test('discovers user, inherited, and project advisor sources in precedence order', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-gui-advisors-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'home')
  const agentDir = join(home, '.omp', 'agent')
  const repo = join(home, 'repo')
  const project = join(repo, 'packages', 'app')
  await mkdir(agentDir, { recursive: true })
  await mkdir(join(repo, '.git'), { recursive: true })
  await mkdir(join(project, '.omp'), { recursive: true })

  await writeFile(join(agentDir, 'WATCHDOG.yml'), [
    'instructions: user shared',
    'advisors:',
    '  - name: Security',
    '    model: user/model',
    '    tools: [read]',
    ''
  ].join('\n'))
  await writeFile(join(repo, 'WATCHDOG.yml'), [
    'advisors:',
    '  - name: Security',
    '    model: ancestor/model',
    ''
  ].join('\n'))
  await writeFile(join(project, '.omp', 'WATCHDOG.md'), 'Inherited project guidance\n')
  await writeFile(join(project, 'WATCHDOG.yml'), [
    'keepMe: true',
    'advisors:',
    '  - name: Security',
    '    enabled: false',
    '    model: project/model',
    '    thinking: high',
    '    tools: [read, edit, write]',
    '    instructions: Project-specific',
    ''
  ].join('\n'))

  const configuration = await new AdvisorDefinitionStore({ agentDir, userHome: home }).list(project)
  const security = configuration.definitions.filter(({ slug }) => slug === 'security')
  assert.deepEqual(security.map(({ scope, sourceOrder, editable, model }) => ({
    scope,
    sourceOrder,
    editable,
    model
  })), [
    { scope: 'user', sourceOrder: 1, editable: true, model: 'user/model' },
    { scope: 'inherited', sourceOrder: 2, editable: false, model: 'ancestor/model' },
    { scope: 'project', sourceOrder: 3, editable: true, model: 'project/model' }
  ])
  assert.deepEqual(security.at(-1), {
    id: 'project:3:security',
    slug: 'security',
    scope: 'project',
    sourcePath: join(project, 'WATCHDOG.yml'),
    sourceOrder: 3,
    editable: true,
    name: 'Security',
    enabled: false,
    model: 'project/model',
    thinking: 'high',
    tools: ['read', 'edit', 'write'],
    instructions: 'Project-specific'
  })
  assert.equal(configuration.sources[4]?.instructions, 'Inherited project guidance\n')
  assert.deepEqual(configuration.diagnostics, [])
})

test('skips malformed discovery files with diagnostics and keeps the builtin advisor', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-gui-advisors-invalid-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const agentDir = join(root, 'agent')
  await mkdir(agentDir, { recursive: true })
  await writeFile(join(agentDir, 'WATCHDOG.yml'), 'advisors: [\n')

  const configuration = await new AdvisorDefinitionStore({
    agentDir,
    userHome: root
  }).list(null)
  assert.equal(configuration.definitions.length, 1)
  assert.equal(configuration.definitions[0]?.name, 'Default Advisor')
  assert.equal(configuration.diagnostics.length, 1)
})

test('drops unknown discovery tools with a diagnostic like the Extension runtime', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-gui-advisors-tools-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const agentDir = join(root, 'agent')
  await mkdir(agentDir, { recursive: true })
  await writeFile(join(agentDir, 'WATCHDOG.yml'), [
    'advisors:',
    '  - name: Verifier',
    '    tools: [read, bash]',
    ''
  ].join('\n'))

  const configuration = await new AdvisorDefinitionStore({
    agentDir,
    userHome: root
  }).list(null)
  assert.deepEqual(
    configuration.definitions.find(({ slug }) => slug === 'verifier')?.tools,
    ['read']
  )
  assert.match(configuration.diagnostics[0]?.message ?? '', /bash/u)
})

test('saves and removes through the canonical file while preserving comments and unknown fields', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-gui-advisors-edit-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const agentDir = join(root, 'agent')
  await mkdir(agentDir, { recursive: true })
  const filePath = join(agentDir, 'WATCHDOG.yml')
  await writeFile(filePath, [
    '# retained comment',
    'unknownTopLevel: keep',
    'advisors:',
    '  - name: Existing',
    '    unknownAdvisorField: keep-too',
    '    tools: [read]',
    ''
  ].join('\n'))
  const store = new AdvisorDefinitionStore({ agentDir, userHome: root })

  await store.save(null, {
    originalSlug: 'existing',
    scope: 'user',
    name: 'Renamed',
    enabled: true,
    model: 'provider/model',
    thinking: mediumThinking(),
    tools: ['read', 'grep', 'edit'],
    instructions: 'Review carefully.'
  })
  const saved = await readFile(filePath, 'utf8')
  assert.match(saved, /# retained comment/u)
  assert.match(saved, /unknownTopLevel: keep/u)
  assert.match(saved, /unknownAdvisorField: keep-too/u)
  assert.match(saved, /name: Renamed/u)
  assert.doesNotMatch(saved, /name: Existing/u)

  await store.remove(null, 'renamed', 'user')
  const removed = await readFile(filePath, 'utf8')
  assert.match(removed, /unknownTopLevel: keep/u)
  assert.doesNotMatch(removed, /advisors:/u)
})

test('fails fast when both canonical extensions or unsafe YAML aliases exist', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-gui-advisors-unsafe-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const agentDir = join(root, 'agent')
  await mkdir(agentDir, { recursive: true })
  const store = new AdvisorDefinitionStore({ agentDir, userHome: root })
  const definition = {
    originalSlug: null,
    scope: 'user' as const,
    name: 'Safety',
    enabled: true,
    model: null,
    thinking: null,
    tools: ['read'] as const,
    instructions: ''
  }

  await writeFile(join(agentDir, 'WATCHDOG.yml'), '{}\n')
  await writeFile(join(agentDir, 'WATCHDOG.yaml'), '{}\n')
  await assert.rejects(
    store.save(null, { ...definition, tools: [...definition.tools] }),
    /Both WATCHDOG\.yml and WATCHDOG\.yaml/u
  )
  await rm(join(agentDir, 'WATCHDOG.yaml'))
  await writeFile(join(agentDir, 'WATCHDOG.yml'), [
    'template: &advisor',
    '  name: Unsafe',
    'advisors:',
    '  - *advisor',
    ''
  ].join('\n'))
  await assert.rejects(
    store.save(null, { ...definition, tools: [...definition.tools] }),
    /Aliases are not safe to edit/u
  )
})

function mediumThinking(): 'medium' {
  return 'medium'
}
