import assert from 'node:assert/strict'
import test from 'node:test'

import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent'

import historyNavigationExtension from '../src/index.ts'
import { HISTORY_NAVIGATION_COMMAND_NAME } from '../src/protocol.mjs'

test('history navigation command selects the user prompt parent through native tree navigation', async () => {
  let commandHandler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | null = null
  const pi = {
    registerCommand: (
      name: string,
      command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }
    ) => {
      assert.equal(name, HISTORY_NAVIGATION_COMMAND_NAME)
      commandHandler = command.handler
    }
  } as unknown as ExtensionAPI
  historyNavigationExtension(pi)
  assert.notEqual(commandHandler, null)

  const entries = new Map([
    ['base', { id: 'base', parentId: null, type: 'model_change' }],
    ['prompt', {
      id: 'prompt',
      parentId: 'base',
      type: 'message',
      message: { role: 'user', content: [{ type: 'text', text: 'Original prompt' }] }
    }],
    ['answer', {
      id: 'answer',
      parentId: 'prompt',
      type: 'message',
      message: { role: 'assistant', content: [] }
    }]
  ])
  let leafId: string | null = 'answer'
  const calls: string[] = []
  const context = {
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: {
      getEntry: (entryId: string) => entries.get(entryId),
      getLeafId: () => leafId
    },
    navigateTree: async (entryId: string) => {
      calls.push(entryId)
      const entry = entries.get(entryId)
      leafId = entry?.type === 'message' && entry.message?.role === 'user'
        ? entry.parentId
        : entryId
      return { cancelled: false }
    }
  } as unknown as ExtensionCommandContext

  await commandHandler!('prompt', context)
  assert.deepEqual(calls, ['prompt'])
  assert.equal(leafId, 'base')
})

test('history navigation repositions first when the target user message is the active leaf', async () => {
  let commandHandler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | null = null
  const pi = {
    registerCommand: (
      _name: string,
      command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }
    ) => { commandHandler = command.handler }
  } as unknown as ExtensionAPI
  historyNavigationExtension(pi)

  const entries = new Map([
    ['base', { id: 'base', parentId: null, type: 'model_change' }],
    ['prompt', {
      id: 'prompt',
      parentId: 'base',
      type: 'message',
      message: { role: 'user', content: 'Original prompt' }
    }]
  ])
  let leafId: string | null = 'prompt'
  const calls: string[] = []
  const context = {
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: {
      getEntry: (entryId: string) => entries.get(entryId),
      getLeafId: () => leafId
    },
    navigateTree: async (entryId: string) => {
      calls.push(entryId)
      const entry = entries.get(entryId)
      leafId = entry?.type === 'message' && entry.message?.role === 'user'
        ? entry.parentId
        : entryId
      return { cancelled: false }
    }
  } as unknown as ExtensionCommandContext

  await commandHandler!('prompt', context)
  assert.deepEqual(calls, ['base', 'prompt'])
  assert.equal(leafId, 'base')
})

test('history navigation pivots through an abandoned custom entry for an active root prompt', async () => {
  let commandHandler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | null = null
  let appendEntry: (customType: string) => void = () => undefined
  const pi = {
    registerCommand: (
      _name: string,
      command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }
    ) => { commandHandler = command.handler },
    appendEntry: (customType: string) => appendEntry(customType)
  } as unknown as ExtensionAPI
  historyNavigationExtension(pi)

  const entries = new Map<string, {
    id: string
    parentId: string | null
    type: string
    message?: { role: string, content: string }
  }>([
    ['prompt', {
      id: 'prompt',
      parentId: null,
      type: 'message',
      message: { role: 'user', content: 'Original prompt' }
    }]
  ])
  let leafId: string | null = 'prompt'
  const calls: string[] = []
  appendEntry = (customType) => {
    calls.push(`append:${customType}`)
    entries.set('pivot', { id: 'pivot', parentId: leafId, type: 'custom' })
    leafId = 'pivot'
  }
  const context = {
    isIdle: () => true,
    hasPendingMessages: () => false,
    sessionManager: {
      getEntry: (entryId: string) => entries.get(entryId),
      getLeafId: () => leafId
    },
    navigateTree: async (entryId: string) => {
      calls.push(entryId)
      const entry = entries.get(entryId)
      leafId = entry?.type === 'message' && entry.message?.role === 'user'
        ? entry.parentId
        : entryId
      return { cancelled: false }
    }
  } as unknown as ExtensionCommandContext

  await commandHandler!('prompt', context)
  assert.deepEqual(calls, ['append:pi-gui.history-navigation-pivot/v1', 'prompt'])
  assert.equal(leafId, null)
})
