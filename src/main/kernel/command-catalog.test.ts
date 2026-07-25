import assert from 'node:assert/strict'
import test from 'node:test'

import {
  COPY_LAST_ANSWER_COMMAND_ID,
  EXPORT_SESSION_COMMAND_ID,
  FORK_SESSION_COMMAND_ID
} from '../../shared/kernel-contract.ts'
import {
  COMPACT_COMMAND_ID,
  createCommandCatalog,
  NEW_SESSION_COMMAND_ID,
  RELOAD_SESSION_COMMAND_ID,
  SET_MODEL_COMMAND_ID,
  SET_SESSION_NAME_COMMAND_ID,
  SET_THINKING_COMMAND_ID
} from './command-catalog.ts'

test('builds the typed GUI and Pi RPC command catalog', () => {
  const catalog = createCommandCatalog()

  assert.deepEqual(catalog.map(({ id, name, source }) => ({ id, name, source })), [
    { id: NEW_SESSION_COMMAND_ID, name: 'new', source: 'gui' },
    { id: FORK_SESSION_COMMAND_ID, name: 'fork', source: 'gui' },
    { id: EXPORT_SESSION_COMMAND_ID, name: 'export', source: 'gui' },
    { id: COPY_LAST_ANSWER_COMMAND_ID, name: 'copy', source: 'gui' },
    { id: SET_MODEL_COMMAND_ID, name: 'model', source: 'pi-rpc' },
    { id: SET_THINKING_COMMAND_ID, name: 'thinking', source: 'pi-rpc' },
    { id: COMPACT_COMMAND_ID, name: 'compact', source: 'pi-rpc' },
    { id: SET_SESSION_NAME_COMMAND_ID, name: 'name', source: 'pi-rpc' }
  ])
})

test('adds reload only when a persisted ready session makes it available', () => {
  assert.equal(createCommandCatalog().some(({ id }) => id === RELOAD_SESSION_COMMAND_ID), false)
  assert.deepEqual(
    createCommandCatalog([], true).find(({ id }) => id === RELOAD_SESSION_COMMAND_ID),
    {
      id: RELOAD_SESSION_COMMAND_ID,
      name: 'reload',
      description: '重新加载当前已持久化 Session',
      source: 'gui',
      argumentHint: null
    }
  )
})

test('normalizes dynamic commands and keeps typed names authoritative', () => {
  const catalog = createCommandCatalog([
    { name: 'review', description: 'Review changes', source: 'extension' },
    { name: 'review', description: 'Prompt collision', source: 'prompt' },
    { name: 'MODEL', description: 'Builtin collision', source: 'skill' },
    { name: 'skill:deploy', source: 'skill' }
  ])

  assert.deepEqual(catalog.slice(8), [
    {
      id: 'pi-command:extension:review',
      name: 'review',
      description: 'Review changes',
      source: 'extension',
      argumentHint: '[arguments]'
    },
    {
      id: 'pi-command:skill:skill:deploy',
      name: 'skill:deploy',
      description: 'Pi Skill',
      source: 'skill',
      argumentHint: '[arguments]'
    }
  ])
})
