import assert from 'node:assert/strict'
import test from 'node:test'

import {
  filterSlashCommands,
  parseSlashCommandToken,
  resolveSlashCommand,
  type SlashCommandLike
} from './slash-command-input.ts'

const commands: SlashCommandLike[] = [
  {
    id: 'model',
    name: 'model',
    description: 'Select a model',
    source: 'pi-rpc',
    argumentHint: '<provider/model>'
  },
  {
    id: 'review',
    name: 'review',
    description: 'Inspect the current changes',
    source: 'prompt',
    argumentHint: null
  }
]

test('parses only a single unfinished slash token', () => {
  const pathShapedCommand = { ...commands[1], id: 'tools/review', name: 'tools/review' }
  assert.equal(parseSlashCommandToken('/', commands), '')
  assert.equal(parseSlashCommandToken('/mo', commands), 'mo')
  assert.equal(parseSlashCommandToken('/model ', commands), null)
  assert.equal(parseSlashCommandToken('/model arg', commands), null)
  assert.equal(parseSlashCommandToken('/model\n', commands), null)
  assert.equal(parseSlashCommandToken('plain', commands), null)
  assert.equal(parseSlashCommandToken('/home/user', commands), null)
  assert.equal(parseSlashCommandToken('/tools/rev', [...commands, pathShapedCommand]), 'tools/rev')
})

test('filters commands by name, description, and source without case sensitivity', () => {
  assert.deepEqual(filterSlashCommands(commands, 'MOD').map(({ id }) => id), ['model'])
  assert.deepEqual(filterSlashCommands(commands, 'inspect').map(({ id }) => id), ['review'])
  assert.deepEqual(filterSlashCommands(commands, 'PI-RPC').map(({ id }) => id), ['model'])
})

test('resolves exact slash commands and trims their remaining argument', () => {
  const pathShapedCommand = { ...commands[1], id: 'tools/review', name: 'tools/review' }
  assert.deepEqual(resolveSlashCommand('/MODEL   openai/gpt  ', commands), {
    kind: 'command',
    command: commands[0],
    argument: 'openai/gpt'
  })
  assert.deepEqual(resolveSlashCommand('/review', commands), {
    kind: 'command',
    command: commands[1],
    argument: ''
  })
  assert.deepEqual(resolveSlashCommand('/missing value', commands), {
    kind: 'unknown',
    name: 'missing'
  })
  assert.deepEqual(resolveSlashCommand('/home/user/project/file.ts', commands), {
    kind: 'prompt'
  })
  assert.deepEqual(resolveSlashCommand('/tools/review staged', [...commands, pathShapedCommand]), {
    kind: 'command',
    command: pathShapedCommand,
    argument: 'staged'
  })
  assert.deepEqual(resolveSlashCommand('ordinary prompt', commands), { kind: 'prompt' })
})
