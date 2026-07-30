import assert from 'node:assert/strict'
import test from 'node:test'

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

import openAiFastModeExtension, {
  applyOpenAiFastMode,
  openAiFastModeFromSessionBranch,
  supportsOpenAiFastMode
} from '../src/index.ts'
import {
  OPENAI_FAST_MODE_COMMAND_NAME,
  OPENAI_FAST_MODE_ENTRY_TYPE
} from '../src/protocol.mjs'

test('OpenAI Fast mode applies Priority processing without mutating the payload', () => {
  const payload = { model: 'gpt-5.6', service_tier: 'auto' }

  assert.deepEqual(applyOpenAiFastMode(payload, 'openai', 'gpt-5.6', true), {
    model: 'gpt-5.6',
    service_tier: 'priority'
  })
  assert.deepEqual(applyOpenAiFastMode(payload, 'openai-codex', 'gpt-5.6', true), {
    model: 'gpt-5.6',
    service_tier: 'priority'
  })
  assert.deepEqual(applyOpenAiFastMode(payload, 'vvqq-cpa', 'gpt-5.6-sol', true), {
    model: 'gpt-5.6',
    service_tier: 'priority'
  })
  assert.deepEqual(payload, { model: 'gpt-5.6', service_tier: 'auto' })
})

test('OpenAI Fast mode leaves disabled, non-GPT CPA, custom-provider, and malformed payloads unchanged', () => {
  const payload = { model: 'gpt-5.6' }
  const malformed = ['not', 'a', 'provider', 'payload']

  assert.equal(applyOpenAiFastMode(payload, 'openai', 'gpt-5.6', false), payload)
  assert.equal(applyOpenAiFastMode(payload, 'vvqq-cpa', 'grok-4.5', true), payload)
  assert.equal(applyOpenAiFastMode(payload, 'custom-openai', 'gpt-5.6', true), payload)
  assert.equal(applyOpenAiFastMode(malformed, 'openai-codex', 'gpt-5.6', true), malformed)
  assert.equal(supportsOpenAiFastMode('vvqq-cpa', 'gpt-sol-max'), true)
  assert.equal(supportsOpenAiFastMode('vvqq-cpa', 'grok-4.5-latest'), false)
})

test('Fast mode restores from the active Session branch and commands append persistent state', async () => {
  type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>
  const eventHandlers = new Map<string, EventHandler>()
  let commandHandler: ((args: string, ctx: ExtensionContext) => unknown | Promise<unknown>) | null = null
  const appended: Array<{ customType: string; data: unknown }> = []
  const pi = {
    on: (event: string, handler: EventHandler) => {
      eventHandlers.set(event, handler)
    },
    registerCommand: (
      name: string,
      command: { handler: (args: string, ctx: ExtensionContext) => unknown | Promise<unknown> }
    ) => {
      assert.equal(name, OPENAI_FAST_MODE_COMMAND_NAME)
      commandHandler = command.handler
    },
    appendEntry: (customType: string, data: unknown) => {
      appended.push({ customType, data })
    }
  } as unknown as ExtensionAPI
  const branch: unknown[] = [
    { type: 'custom', customType: OPENAI_FAST_MODE_ENTRY_TYPE, data: { enabled: true } }
  ]
  const context = {
    sessionManager: { getBranch: () => branch },
    model: { provider: 'vvqq-cpa', id: 'gpt-5.6-sol' }
  } as unknown as ExtensionContext

  openAiFastModeExtension(pi)
  const sessionStartHandler = eventHandlers.get('session_start')
  const sessionTreeHandler = eventHandlers.get('session_tree')
  const providerRequestHandler = eventHandlers.get('before_provider_request')
  assert.ok(sessionStartHandler)
  assert.ok(sessionTreeHandler)
  assert.ok(providerRequestHandler)
  assert.notEqual(commandHandler, null)

  await sessionStartHandler({}, context)
  const payload = { model: 'gpt-5.6-sol' }
  assert.deepEqual(await providerRequestHandler({ payload }, context), {
    model: 'gpt-5.6-sol',
    service_tier: 'priority'
  })

  await commandHandler!('off', context)
  assert.deepEqual(appended, [{
    customType: OPENAI_FAST_MODE_ENTRY_TYPE,
    data: { enabled: false }
  }])
  assert.equal(await providerRequestHandler({ payload }, context), payload)

  branch.push({ type: 'custom', customType: OPENAI_FAST_MODE_ENTRY_TYPE, data: { enabled: true } })
  await sessionTreeHandler({}, context)
  assert.deepEqual(await providerRequestHandler({ payload }, context), {
    model: 'gpt-5.6-sol',
    service_tier: 'priority'
  })
})

test('active branch projection uses the newest valid Fast mode entry and defaults off', () => {
  const context = (branch: unknown[]) => ({
    sessionManager: { getBranch: () => branch }
  }) as unknown as ExtensionContext

  assert.equal(openAiFastModeFromSessionBranch(context([])), false)
  assert.equal(openAiFastModeFromSessionBranch(context([
    { type: 'custom', customType: OPENAI_FAST_MODE_ENTRY_TYPE, data: { enabled: true } },
    { type: 'custom', customType: 'other-state', data: { enabled: false } }
  ])), true)
  assert.equal(openAiFastModeFromSessionBranch(context([
    { type: 'custom', customType: OPENAI_FAST_MODE_ENTRY_TYPE, data: { enabled: true } },
    { type: 'custom', customType: OPENAI_FAST_MODE_ENTRY_TYPE, data: { enabled: false } }
  ])), false)
  assert.equal(openAiFastModeFromSessionBranch(context([
    { type: 'custom', customType: OPENAI_FAST_MODE_ENTRY_TYPE, data: { enabled: 'yes' } }
  ])), false)
})
