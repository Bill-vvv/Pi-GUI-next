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
import { HISTORY_NAVIGATION_COMMAND_NAME } from '../runtime/history-navigation.ts'
import { OPENAI_FAST_MODE_COMMAND_NAME } from '../runtime/openai-fast-mode.ts'
import { QUIESCENCE_COMMAND_NAME } from '../runtime/runtime-quiescence.ts'

test('builds the typed GUI and Pi RPC command catalog', () => {
  const catalog = createCommandCatalog()

  assert.deepEqual(
    catalog.map(({ id, name, source, sourceInfo }) => ({ id, name, source, sourceInfo })),
    [
      { id: NEW_SESSION_COMMAND_ID, name: 'new', source: 'gui', sourceInfo: null },
      { id: FORK_SESSION_COMMAND_ID, name: 'fork', source: 'gui', sourceInfo: null },
      { id: EXPORT_SESSION_COMMAND_ID, name: 'export', source: 'gui', sourceInfo: null },
      { id: COPY_LAST_ANSWER_COMMAND_ID, name: 'copy', source: 'gui', sourceInfo: null },
      { id: SET_MODEL_COMMAND_ID, name: 'model', source: 'pi-rpc', sourceInfo: null },
      { id: SET_THINKING_COMMAND_ID, name: 'thinking', source: 'pi-rpc', sourceInfo: null },
      { id: COMPACT_COMMAND_ID, name: 'compact', source: 'pi-rpc', sourceInfo: null },
      { id: SET_SESSION_NAME_COMMAND_ID, name: 'name', source: 'pi-rpc', sourceInfo: null }
    ]
  )
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
      argumentHint: null,
      sourceInfo: null
    }
  )
})

test('normalizes dynamic commands and keeps typed names authoritative', () => {
  const reviewSourceInfo = { source: 'review-extension', scope: 'project', origin: 'top-level' } as const
  const catalog = createCommandCatalog([
    {
      name: 'review',
      description: 'Review changes',
      source: 'extension',
      sourceInfo: reviewSourceInfo
    },
    {
      name: 'review',
      description: 'Prompt collision',
      source: 'prompt',
      sourceInfo: { source: 'review', scope: 'user', origin: 'package' }
    },
    {
      name: 'MODEL',
      description: 'Builtin collision',
      source: 'skill',
      sourceInfo: { source: 'model', scope: 'temporary', origin: 'top-level' }
    },
    {
      name: 'skill:deploy',
      source: 'skill',
      sourceInfo: { source: 'deploy', scope: 'user', origin: 'package' }
    }
  ])

  assert.deepEqual(catalog.slice(8), [
    {
      id: 'pi-command:extension:review',
      name: 'review',
      description: 'Review changes',
      source: 'extension',
      argumentHint: '[arguments]',
      sourceInfo: reviewSourceInfo
    },
    {
      id: 'pi-command:skill:skill:deploy',
      name: 'skill:deploy',
      description: 'Pi Skill',
      source: 'skill',
      argumentHint: '[arguments]',
      sourceInfo: { source: 'deploy', scope: 'user', origin: 'package' }
    }
  ])
  assert.notStrictEqual(catalog[8]?.sourceInfo, reviewSourceInfo)
})

test('filters app-owned internal runtime commands from the user catalog', () => {
  const catalog = createCommandCatalog([
    {
      name: QUIESCENCE_COMMAND_NAME,
      description: 'Internal only',
      source: 'extension',
      sourceInfo: { source: 'pi-gui-runtime-quiescence', scope: 'temporary', origin: 'top-level' }
    },
    {
      name: OPENAI_FAST_MODE_COMMAND_NAME,
      description: 'Internal only',
      source: 'extension',
      sourceInfo: { source: 'pi-gui-openai-fast-mode', scope: 'temporary', origin: 'top-level' }
    },
    {
      name: HISTORY_NAVIGATION_COMMAND_NAME,
      description: 'Internal only',
      source: 'extension',
      sourceInfo: { source: 'pi-gui-history-navigation', scope: 'temporary', origin: 'top-level' }
    }
  ])
  assert.equal(catalog.some(({ name }) => name === QUIESCENCE_COMMAND_NAME), false)
  assert.equal(catalog.some(({ name }) => name === OPENAI_FAST_MODE_COMMAND_NAME), false)
  assert.equal(catalog.some(({ name }) => name === HISTORY_NAVIGATION_COMMAND_NAME), false)
})
