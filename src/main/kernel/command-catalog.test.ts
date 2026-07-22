import assert from 'node:assert/strict'
import test from 'node:test'

import {
  COMPACT_COMMAND_ID,
  createCommandCatalog,
  NEW_SESSION_COMMAND_ID,
  SET_MODEL_COMMAND_ID,
  SET_SESSION_NAME_COMMAND_ID,
  SET_THINKING_COMMAND_ID
} from './command-catalog.ts'

test('builds the typed GUI and Pi RPC command catalog', () => {
  const catalog = createCommandCatalog()

  assert.deepEqual(catalog.map(({ id, name, source }) => ({ id, name, source })), [
    { id: NEW_SESSION_COMMAND_ID, name: 'new', source: 'gui' },
    { id: SET_MODEL_COMMAND_ID, name: 'model', source: 'pi-rpc' },
    { id: SET_THINKING_COMMAND_ID, name: 'thinking', source: 'pi-rpc' },
    { id: COMPACT_COMMAND_ID, name: 'compact', source: 'pi-rpc' },
    { id: SET_SESSION_NAME_COMMAND_ID, name: 'name', source: 'pi-rpc' }
  ])
})

test('normalizes dynamic commands and keeps typed names authoritative', () => {
  const catalog = createCommandCatalog([
    { name: 'review', description: 'Review changes', source: 'extension' },
    { name: 'review', description: 'Prompt collision', source: 'prompt' },
    { name: 'MODEL', description: 'Builtin collision', source: 'skill' },
    { name: 'skill:deploy', source: 'skill' }
  ])

  assert.deepEqual(catalog.slice(5), [
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
