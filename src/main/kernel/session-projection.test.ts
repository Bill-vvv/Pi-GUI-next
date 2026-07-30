import assert from 'node:assert/strict'
import test from 'node:test'

import type { KernelConversationEntry, KernelSessionUsage } from '../../shared/kernel-contract.ts'
import type {
  PiRpcAvailableModel,
  PiRpcSessionStats
} from '../pi-rpc/pi-rpc-client.ts'
import {
  mergeConversationEntries,
  toAvailableKernelModel,
  toKernelModel,
  toKernelSession,
  toKernelSessionStatistics,
  toKernelSessionUsage
} from './session-projection.ts'

const stats: PiRpcSessionStats = {
  sessionId: 'session-1',
  userMessages: 2,
  assistantMessages: 3,
  toolCalls: 4,
  toolResults: 5,
  totalMessages: 6,
  tokens: {
    input: 10,
    output: 20,
    cacheRead: 30,
    cacheWrite: 40,
    total: 100
  },
  cost: 1.25
}

test('projects nullable session values, integer fallbacks, and streaming state', () => {
  const usageFallback: KernelSessionUsage = {
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
    totalTokens: 10,
    contextTokens: null,
    contextWindow: null,
    contextPercent: null,
    cost: 0.5
  }

  assert.deepEqual(toKernelSession({
    sessionId: 42,
    sessionName: false,
    model: null,
    thinkingLevel: 'unsupported',
    messageCount: -1,
    pendingMessageCount: 1.5,
    isStreaming: true
  } as never, false, usageFallback, true), {
    id: null,
    name: null,
    resumeAvailable: false,
    model: null,
    usage: usageFallback,
    thinkingLevel: null,
    openAiFastMode: true,
    messageCount: 0,
    pendingMessageCount: 0,
    pendingSteeringMessages: [],
    pendingFollowUpMessages: [],
    compaction: null,
    settled: false
  })
})

test('projects session model fallbacks and validates available models', () => {
  assert.equal(toKernelModel(undefined), null)
  assert.equal(toKernelModel({ id: 1, provider: 'openai' } as never), null)
  assert.deepEqual(toKernelModel({
    id: 'model-1',
    provider: 'openai'
  }), {
    provider: 'openai',
    id: 'model-1',
    name: 'model-1',
    reasoning: false,
    thinkingLevelMap: {},
    contextWindow: null
  })
  assert.deepEqual(toAvailableKernelModel({
    id: 'model-2',
    provider: 'openai'
  }), {
    id: 'model-2',
    provider: 'openai',
    name: 'model-2',
    reasoning: false,
    thinkingLevelMap: {},
    contextWindow: null
  })
  assert.throws(
    () => toAvailableKernelModel({ id: ' ', provider: 'openai' } as PiRpcAvailableModel),
    /Runtime returned an invalid model catalog\./
  )
})

test('projects usage context fallbacks and runtime context values', () => {
  assert.deepEqual(toKernelSessionUsage(stats, 128_000), {
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 40,
    totalTokens: 100,
    contextTokens: null,
    contextWindow: 128_000,
    contextPercent: null,
    cost: 1.25
  })
  assert.deepEqual(toKernelSessionUsage({
    ...stats,
    contextUsage: {
      tokens: 64,
      contextWindow: 256,
      percent: 25
    }
  }, 128_000), {
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 40,
    totalTokens: 100,
    contextTokens: 64,
    contextWindow: 256,
    contextPercent: 25,
    cost: 1.25
  })
})

test('projects session statistics', () => {
  assert.deepEqual(toKernelSessionStatistics(stats), {
    userMessages: 2,
    assistantMessages: 3,
    toolCalls: 4,
    toolResults: 5,
    totalMessages: 6,
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 40,
    totalTokens: 100,
    cost: 1.25
  })
})

test('conversation merge replaces matching IDs and inserts by timestamp', () => {
  const message = (
    id: string,
    timestamp: number,
    text: string
  ): KernelConversationEntry => ({
    id,
    kind: 'message',
    role: 'user',
    text,
    timestamp,
    streaming: false,
    stopReason: null,
    error: null
  })
  const first = message('first', 10, 'first')
  const replaced = message('existing', 20, 'before')
  const last = message('last', 40, 'last')
  const replacement = message('existing', 35, 'after')
  const inserted = message('inserted', 30, 'inserted')

  assert.deepEqual(
    mergeConversationEntries([first, replaced, last], [replacement, inserted]),
    [first, inserted, replacement, last]
  )
})
