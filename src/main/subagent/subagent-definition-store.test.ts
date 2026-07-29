import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { KernelSubagentDefinitionInput } from '../../shared/kernel-contract.ts'
import { SubagentDefinitionStore } from './subagent-definition-store.ts'

test('lists builtin, user, and project definitions and preserves unmanaged frontmatter', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-gui-subagents-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const agentDir = join(root, 'agent')
  const userHome = join(root, 'home')
  const projectPath = join(root, 'project')
  const builtinDir = join(agentDir, 'npm', 'node_modules', 'pi-subagents', 'agents')
  await Promise.all([
    mkdir(builtinDir, { recursive: true }),
    mkdir(join(userHome, '.agents'), { recursive: true }),
    mkdir(join(projectPath, '.pi', 'agents'), { recursive: true })
  ])
  await Promise.all([
    writeFile(join(builtinDir, 'scout.md'), agentFile('scout', 'Find code', 'Scout.'), 'utf8'),
    writeFile(
      join(userHome, '.agents', 'review.md'),
      `---\nname: review\ndescription: Review code\npermission:\n  bash: deny\n---\n\nReview carefully.\n`,
      'utf8'
    ),
    writeFile(
      join(projectPath, '.pi', 'agents', 'worker.md'),
      agentFile('worker', 'Implement tasks', 'Implement.'),
      'utf8'
    )
  ])
  const store = new SubagentDefinitionStore({ agentDir, userHome })

  const definitions = await store.list(projectPath)
  assert.deepEqual(
    definitions.map(({ scope, name, editable }) => ({ scope, name, editable })),
    [
      { scope: 'builtin', name: 'scout', editable: false },
      { scope: 'user', name: 'review', editable: true },
      { scope: 'project', name: 'worker', editable: true }
    ]
  )

  const review = definitions.find(({ name }) => name === 'review')
  assert.ok(review)
  await store.save(projectPath, {
    ...definitionInput(review),
    description: 'Review correctness and security'
  })
  const saved = await readFile(join(userHome, '.agents', 'review.md'), 'utf8')
  assert.match(saved, /description: Review correctness and security/u)
  assert.match(saved, /permission:\n  bash: deny/u)
})

test('creates, renames, and deletes editable definitions without modifying builtins', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-gui-subagents-crud-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const agentDir = join(root, 'agent')
  const userHome = join(root, 'home')
  const projectPath = join(root, 'project')
  const builtinDir = join(agentDir, 'npm', 'node_modules', 'pi-subagents', 'agents')
  await mkdir(builtinDir, { recursive: true })
  await mkdir(projectPath, { recursive: true })
  await writeFile(
    join(builtinDir, 'reviewer.md'),
    agentFile('reviewer', 'Review code', 'Review.'),
    'utf8'
  )
  const store = new SubagentDefinitionStore({ agentDir, userHome })
  const builtin = (await store.list(projectPath))[0]
  assert.ok(builtin)

  const created = await store.save(projectPath, {
    ...definitionInput(builtin),
    scope: 'project',
    name: 'security-reviewer',
    description: 'Review security',
    systemPrompt: 'Review authentication and input validation.',
    tools: ['read', 'grep'],
    maxTurns: 12,
    maxSubagentDepth: 0
  })
  const projectDefinition = created.find(({ name }) => name === 'security-reviewer')
  assert.ok(projectDefinition)
  assert.equal(projectDefinition.scope, 'project')
  assert.equal(projectDefinition.editable, true)

  const renamed = await store.save(projectPath, {
    ...definitionInput(projectDefinition),
    name: 'appsec-reviewer'
  })
  assert.equal(renamed.some(({ name }) => name === 'security-reviewer'), false)
  const renamedDefinition = renamed.find(({ name }) => name === 'appsec-reviewer')
  assert.ok(renamedDefinition)
  const removed = await store.remove(projectPath, renamedDefinition.id)
  assert.equal(removed.some(({ name }) => name === 'appsec-reviewer'), false)
  await assert.rejects(() => store.remove(projectPath, builtin.id), /Only user or project/u)
})

test('reads and writes reversible user and project enabled overrides', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-gui-subagent-enabled-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const agentDir = join(root, 'agent')
  const userHome = join(root, 'home')
  const projectPath = join(root, 'project')
  const builtinDir = join(agentDir, 'npm', 'node_modules', 'pi-subagents', 'agents')
  await Promise.all([
    mkdir(builtinDir, { recursive: true }),
    mkdir(join(userHome, '.agents'), { recursive: true }),
    mkdir(join(projectPath, '.pi'), { recursive: true })
  ])
  await Promise.all([
    writeFile(
      join(builtinDir, 'reviewer.md'),
      agentFile('reviewer', 'Review code', 'Review.'),
      'utf8'
    ),
    writeFile(
      join(userHome, '.agents', 'writer.md'),
      agentFile('writer', 'Write code', 'Write.'),
      'utf8'
    ),
    writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({
        theme: 'dark',
        subagents: {
          agentOverrides: {
            reviewer: { disabled: true },
            writer: { disabled: true }
          }
        }
      }),
      'utf8'
    ),
    writeFile(
      join(projectPath, '.pi', 'settings.json'),
      JSON.stringify({
        subagents: {
          agentOverrides: {
            reviewer: { disabled: false, model: 'provider/model' }
          }
        }
      }),
      'utf8'
    )
  ])
  const store = new SubagentDefinitionStore({ agentDir, userHome })
  const listed = await store.list(projectPath)
  const reviewer = listed.find(({ name }) => name === 'reviewer')
  const writer = listed.find(({ name }) => name === 'writer')
  assert.ok(reviewer)
  assert.ok(writer)
  assert.equal(reviewer.enabled, true)
  assert.equal(writer.enabled, false)

  const disabled = await store.setEnabled(projectPath, reviewer.id, 'project', false)
  assert.equal(disabled.find(({ name }) => name === 'reviewer')?.enabled, false)
  const disabledSettings = JSON.parse(
    await readFile(join(projectPath, '.pi', 'settings.json'), 'utf8')
  ) as {
    subagents: { agentOverrides: { reviewer: { disabled?: boolean; model: string } } }
  }
  assert.equal(disabledSettings.subagents.agentOverrides.reviewer.disabled, true)
  assert.equal(disabledSettings.subagents.agentOverrides.reviewer.model, 'provider/model')

  const enabled = await store.setEnabled(projectPath, reviewer.id, 'project', true)
  assert.equal(enabled.find(({ name }) => name === 'reviewer')?.enabled, true)
  const enabledSettings = JSON.parse(
    await readFile(join(projectPath, '.pi', 'settings.json'), 'utf8')
  ) as {
    subagents: { agentOverrides: { reviewer: { disabled?: boolean; model: string } } }
  }
  assert.equal(enabledSettings.subagents.agentOverrides.reviewer.disabled, undefined)
  assert.equal(enabledSettings.subagents.agentOverrides.reviewer.model, 'provider/model')

  const writerEnabled = await store.setEnabled(projectPath, writer.id, 'user', true)
  assert.equal(writerEnabled.find(({ name }) => name === 'writer')?.enabled, true)
  const userSettings = JSON.parse(
    await readFile(join(agentDir, 'settings.json'), 'utf8')
  ) as { theme: string }
  assert.equal(userSettings.theme, 'dark')
})

test('excludes legacy Skill markdown from Agent discovery', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-gui-subagent-skills-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const agentDir = join(root, 'agent')
  const userHome = join(root, 'home')
  const projectPath = join(root, 'project')
  await Promise.all([
    mkdir(join(userHome, '.agents', 'skills', 'brandkit'), { recursive: true }),
    mkdir(join(userHome, '.agents', 'team'), { recursive: true }),
    mkdir(join(projectPath, '.agents', 'skills', 'frontend'), { recursive: true }),
    mkdir(join(projectPath, '.agents', 'team'), { recursive: true })
  ])
  await Promise.all([
    writeFile(
      join(userHome, '.agents', 'skills', 'brandkit', 'SKILL.md'),
      agentFile('brandkit', 'Brand skill', 'Skill instructions.'),
      'utf8'
    ),
    writeFile(
      join(userHome, '.agents', 'team', 'explorer.md'),
      agentFile('explorer', 'Explore code', 'Explore.'),
      'utf8'
    ),
    writeFile(
      join(projectPath, '.agents', 'skills', 'frontend', 'SKILL.md'),
      agentFile('frontend', 'Frontend skill', 'Skill instructions.'),
      'utf8'
    ),
    writeFile(
      join(projectPath, '.agents', 'team', 'worker.md'),
      agentFile('worker', 'Implement code', 'Implement.'),
      'utf8'
    )
  ])

  const store = new SubagentDefinitionStore({ agentDir, userHome })
  const definitions = await store.list(projectPath)

  assert.deepEqual(
    definitions.map(({ scope, name }) => ({ scope, name })),
    [
      { scope: 'user', name: 'explorer' },
      { scope: 'project', name: 'worker' }
    ]
  )
})

test('projects effective defaults and Agent overrides with runtime precedence', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-gui-subagent-overrides-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const agentDir = join(root, 'agent')
  const userHome = join(root, 'home')
  const projectPath = join(root, 'project')
  const builtinDir = join(agentDir, 'npm', 'node_modules', 'pi-subagents', 'agents')
  const userAgentDir = join(agentDir, 'agents')
  await Promise.all([
    mkdir(builtinDir, { recursive: true }),
    mkdir(userAgentDir, { recursive: true }),
    mkdir(join(projectPath, '.pi'), { recursive: true })
  ])
  await Promise.all([
    writeFile(
      join(builtinDir, 'reviewer.md'),
      agentFile('reviewer', 'Review code', 'Review.'),
      'utf8'
    ),
    writeFile(
      join(builtinDir, 'worker.md'),
      agentFile('worker', 'Implement code', 'Implement.'),
      'utf8'
    ),
    writeFile(
      join(userAgentDir, 'explorer.md'),
      agentFile('explorer', 'Explore code', 'Explore.'),
      'utf8'
    ),
    writeFile(
      join(userAgentDir, 'fixed.md'),
      `---\nname: fixed\ndescription: Fixed model\nmodel: provider/fixed\n---\n\nFixed.\n`,
      'utf8'
    ),
    writeFile(
      join(agentDir, 'settings.json'),
      JSON.stringify({
        subagents: {
          defaultModel: 'provider/default',
          defaultThinking: 'minimal',
          agentOverrides: {
            reviewer: {
              model: 'provider/user-reviewer',
              thinking: 'medium',
              disabled: true
            },
            worker: {
              model: 'provider/user-worker',
              thinking: 'high',
              defaultContext: 'fresh'
            },
            explorer: {
              model: 'provider/user-explorer',
              thinking: 'low',
              defaultContext: 'fresh'
            },
            fixed: {
              model: 'provider/ignored',
              thinking: 'high'
            }
          }
        }
      }),
      'utf8'
    ),
    writeFile(
      join(projectPath, '.pi', 'settings.json'),
      JSON.stringify({
        subagents: {
          agentOverrides: {
            reviewer: {
              model: 'provider/project-reviewer',
              disabled: false
            }
          }
        }
      }),
      'utf8'
    )
  ])

  const store = new SubagentDefinitionStore({ agentDir, userHome })
  const definitions = await store.list(projectPath)
  const reviewer = definitions.find(({ scope, name }) => scope === 'builtin' && name === 'reviewer')
  const worker = definitions.find(({ scope, name }) => scope === 'builtin' && name === 'worker')
  const explorer = definitions.find(({ scope, name }) => scope === 'user' && name === 'explorer')
  const fixed = definitions.find(({ scope, name }) => scope === 'user' && name === 'fixed')

  assert.ok(reviewer)
  assert.equal(reviewer.enabled, true)
  assert.equal(reviewer.model, 'provider/project-reviewer')
  assert.equal(reviewer.thinking, 'minimal')
  assert.ok(worker)
  assert.equal(worker.model, 'provider/user-worker')
  assert.equal(worker.thinking, 'high')
  assert.equal(worker.defaultContext, 'fresh')
  assert.ok(explorer)
  assert.equal(explorer.model, 'provider/user-explorer')
  assert.equal(explorer.thinking, 'low')
  assert.equal(explorer.defaultContext, 'fresh')
  assert.ok(fixed)
  assert.equal(fixed.model, 'provider/fixed')
  assert.equal(fixed.thinking, 'high')
})

function agentFile(name: string, description: string, prompt: string): string {
  return `---\nname: ${name}\ndescription: ${description}\ninheritProjectContext: true\n---\n\n${prompt}\n`
}

function definitionInput(
  definition: Awaited<ReturnType<SubagentDefinitionStore['list']>>[number]
): KernelSubagentDefinitionInput {
  return {
    originalId: definition.id,
    scope: definition.scope === 'project' ? 'project' : 'user',
    name: definition.name,
    description: definition.description,
    systemPrompt: definition.systemPrompt,
    model: definition.model,
    fallbackModels: definition.fallbackModels,
    thinking: definition.thinking,
    systemPromptMode: definition.systemPromptMode,
    inheritProjectContext: definition.inheritProjectContext,
    inheritSkills: definition.inheritSkills,
    defaultContext: definition.defaultContext,
    tools: definition.tools,
    skills: definition.skills,
    defaultAsync: definition.defaultAsync,
    timeoutMs: definition.timeoutMs,
    maxTurns: definition.maxTurns,
    maxSubagentDepth: definition.maxSubagentDepth
  }
}
