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
  assert.equal(parseSlashCommandToken('/'), '')
  assert.equal(parseSlashCommandToken('/mo'), 'mo')
  assert.equal(parseSlashCommandToken('/model '), null)
  assert.equal(parseSlashCommandToken('/model arg'), null)
  assert.equal(parseSlashCommandToken('/model\n'), null)
  assert.equal(parseSlashCommandToken('plain'), null)
})

test('filters commands by name, description, and source without case sensitivity', () => {
  assert.deepEqual(filterSlashCommands(commands, 'MOD').map(({ id }) => id), ['model'])
  assert.deepEqual(filterSlashCommands(commands, 'inspect').map(({ id }) => id), ['review'])
  assert.deepEqual(filterSlashCommands(commands, 'PI-RPC').map(({ id }) => id), ['model'])
})

test('resolves exact slash commands and trims their remaining argument', () => {
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
  assert.deepEqual(resolveSlashCommand('ordinary prompt', commands), { kind: 'prompt' })
})
