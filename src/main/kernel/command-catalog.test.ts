import assert from 'node:assert/strict'
import test from 'node:test'

import {
  COPY_LAST_ANSWER_COMMAND_ID,
  EXPORT_SESSION_COMMAND_ID,
  FORK_SESSION_COMMAND_ID
} from '../../shared/kernel-contract.ts'
import {
  adaptedExtensionCommandAllowsBlockingUi,
  assertAdaptedExtensionCommandArgument,
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
  const runSourceInfo = {
    source: 'npm:pi-subagents@0.37.2',
    scope: 'project',
    origin: 'package'
  } as const
  const catalog = createCommandCatalog([
    {
      name: 'run',
      description: 'Run a subagent',
      source: 'extension',
      sourceInfo: runSourceInfo
    },
    {
      name: 'review',
      description: 'Unsupported Extension command',
      source: 'extension',
      sourceInfo: { source: 'review-extension', scope: 'project', origin: 'top-level' }
    },
    {
      name: 'review',
      description: 'Prompt remains available',
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
      id: 'pi-command:extension:run',
      name: 'run',
      description: 'Run a subagent',
      source: 'extension',
      argumentHint: '<agent> [task] [--bg] [--fork]',
      sourceInfo: runSourceInfo
    },
    {
      id: 'pi-command:prompt:review',
      name: 'review',
      description: 'Prompt remains available',
      source: 'prompt',
      argumentHint: '[arguments]',
      sourceInfo: { source: 'review', scope: 'user', origin: 'package' }
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
  assert.notStrictEqual(catalog[8]?.sourceInfo, runSourceInfo)
})

test('only exposes provenance-checked GUI-compatible Extension commands', () => {
  const catalog = createCommandCatalog([
    {
      name: 'run',
      description: 'Spoofed command',
      source: 'extension',
      sourceInfo: { source: 'local', scope: 'user', origin: 'top-level' }
    },
    {
      name: 'subagents-fleet',
      description: 'TUI-only command',
      source: 'extension',
      sourceInfo: { source: 'npm:pi-subagents@0.37.2', scope: 'user', origin: 'package' }
    },
    {
      name: 'ctx-aug',
      description: 'Augment prompt',
      source: 'extension',
      sourceInfo: {
        source: 'npm:@cortexkit/pi-magic-context@1.2.3',
        scope: 'project',
        origin: 'package'
      }
    },
    {
      name: 'subagent-cost',
      description: 'Show cost',
      source: 'extension',
      sourceInfo: {
        source: 'npm:pi-subagents@0.37.2',
        scope: 'user',
        origin: 'package'
      }
    }
  ])

  assert.deepEqual(catalog.slice(8), [
    {
      id: 'pi-command:extension:ctx-aug',
      name: 'ctx-aug',
      description: 'Augment prompt',
      source: 'extension',
      argumentHint: '<prompt>',
      sourceInfo: {
        source: 'npm:@cortexkit/pi-magic-context@1.2.3',
        scope: 'project',
        origin: 'package'
      }
    },
    {
      id: 'pi-command:extension:subagent-cost',
      name: 'subagent-cost',
      description: 'Show cost',
      source: 'extension',
      argumentHint: null,
      sourceInfo: {
        source: 'npm:pi-subagents@0.37.2',
        scope: 'user',
        origin: 'package'
      }
    }
  ])
})

test('publishes exact argument hints for every adapted Extension command', () => {
  const expectedHints = {
    'subagents-watchdog': '[status|on|off|session on|session off|recommend-model|check|model <provider/model[:thinking]|recommended|inherit>|thinking <level|inherit>|session model <provider/model[:thinking]|recommended|inherit>|test <concern|blocker> <text>]',
    run: '<agent> [task] [--bg] [--fork]',
    chain: '<agent/task chain> [--bg] [--fork]',
    'run-chain': '<chain> -- <task> [--bg] [--fork]',
    parallel: '<agent/task entries> [--bg] [--fork]',
    'subagent-cost': null,
    'subagents-doctor': null,
    'subagents-stop': '<run-id>',
    'prompt-workflow': '[name] [arguments]',
    'chain-prompts': '[prompt-chain] [-- arguments]',
    'subagents-models': '[builtin-agent]',
    'subagents-profiles': null,
    'subagents-refresh-provider-models': '<provider> [--force]',
    'subagents-generate-profiles': '<provider>',
    'subagents-check-profile': '<profile>',
    'ctx-aug': '<prompt>',
    'ctx-flush': null,
    'ctx-recomp': '[<start>-<end>|--upgrade]',
    'ctx-wrapup': '[messages-to-keep]',
    'ctx-session-upgrade': null,
    'ctx-dream': '[task]',
    'ctx-embed': '[start|pause]',
    todos: null
  } as const
  const catalog = createCommandCatalog(Object.keys(expectedHints).map((name) => ({
    name,
    source: 'extension' as const,
    sourceInfo: {
      source: name.startsWith('ctx-') || name === 'todos'
        ? 'npm:@cortexkit/pi-magic-context'
        : 'npm:pi-subagents@0.37.2',
      scope: 'user' as const,
      origin: 'package' as const
    }
  })))

  assert.deepEqual(
    catalog.slice(8).map(({ name, argumentHint }) => ({ name, argumentHint })),
    Object.entries(expectedHints).map(([name, argumentHint]) => ({ name, argumentHint }))
  )
})

test('enforces exact argument policies for adapted Extension commands', () => {
  const catalog = createCommandCatalog([
    {
      name: 'todos',
      source: 'extension',
      sourceInfo: {
        source: 'npm:@cortexkit/pi-magic-context',
        scope: 'user',
        origin: 'package'
      }
    },
    {
      name: 'subagents-stop',
      source: 'extension',
      sourceInfo: {
        source: 'npm:pi-subagents@0.37.2',
        scope: 'user',
        origin: 'package'
      }
    }
  ])
  const todos = catalog.find(({ name }) => name === 'todos')
  const stop = catalog.find(({ name }) => name === 'subagents-stop')
  assert.ok(todos)
  assert.ok(stop)

  assert.doesNotThrow(() => assertAdaptedExtensionCommandArgument(todos, ''))
  assert.throws(() => assertAdaptedExtensionCommandArgument(todos, 'now'), /不接受参数/u)
  assert.doesNotThrow(() => assertAdaptedExtensionCommandArgument(stop, 'run-123'))
  assert.throws(() => assertAdaptedExtensionCommandArgument(stop, ''), /<run-id>/u)
})

test('grants blocking UI only to the exact reviewed command capability', () => {
  const catalog = createCommandCatalog([
    {
      name: 'run',
      source: 'extension',
      sourceInfo: { source: 'npm:pi-subagents@0.37.2', scope: 'user', origin: 'package' }
    },
    {
      name: 'todos',
      source: 'extension',
      sourceInfo: {
        source: 'npm:@cortexkit/pi-magic-context',
        scope: 'user',
        origin: 'package'
      }
    }
  ])
  const run = catalog.find(({ name }) => name === 'run')
  const todos = catalog.find(({ name }) => name === 'todos')
  assert.ok(run)
  assert.ok(todos)

  for (const method of ['select', 'confirm', 'input', 'editor'] as const) {
    assert.equal(adaptedExtensionCommandAllowsBlockingUi(run, method), true)
    assert.equal(adaptedExtensionCommandAllowsBlockingUi(todos, method), false)
  }
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
