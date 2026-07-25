import type { KernelSessionStatistics } from '../../shared/kernel-contract.ts'
import type { SessionPointer } from './session-pointer.ts'
import { readSessionTranscript } from './session-transcript.ts'

export async function readSessionStatistics(pointer: SessionPointer): Promise<KernelSessionStatistics> {
  const statistics: KernelSessionStatistics = {
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    cost: 0
  }

  for (const entry of await readSessionTranscript(pointer)) {
    if (entry.type !== 'message') continue
    statistics.totalMessages = addSafeInteger(statistics.totalMessages, 1)

    if (!isObject(entry.message)) {
      throw new Error('Invalid message in Pi session transcript entry.')
    }
    if (entry.message.role === 'user') {
      statistics.userMessages = addSafeInteger(statistics.userMessages, 1)
      continue
    }
    if (entry.message.role === 'toolResult') {
      statistics.toolResults = addSafeInteger(statistics.toolResults, 1)
      continue
    }
    if (entry.message.role !== 'assistant') continue

    statistics.assistantMessages = addSafeInteger(statistics.assistantMessages, 1)
    const content = entry.message.content
    if (
      !Array.isArray(content) ||
      !content.every((item) => isObject(item) && typeof item.type === 'string')
    ) {
      throw new Error('Invalid assistant content in Pi session transcript entry.')
    }
    for (const item of content) {
      if (item.type === 'toolCall') {
        statistics.toolCalls = addSafeInteger(statistics.toolCalls, 1)
      }
    }

    const usage = entry.message.usage
    if (!isObject(usage) || !isObject(usage.cost)) {
      throw new Error('Invalid assistant usage in Pi session transcript entry.')
    }
    const input = readTokenCount(usage.input)
    const output = readTokenCount(usage.output)
    const cacheRead = readTokenCount(usage.cacheRead)
    const cacheWrite = readTokenCount(usage.cacheWrite)
    const cost = usage.cost.total
    if (!isNonNegativeFiniteNumber(cost)) {
      throw new Error('Invalid assistant usage in Pi session transcript entry.')
    }

    statistics.inputTokens = addSafeInteger(statistics.inputTokens, input)
    statistics.outputTokens = addSafeInteger(statistics.outputTokens, output)
    statistics.cacheReadTokens = addSafeInteger(statistics.cacheReadTokens, cacheRead)
    statistics.cacheWriteTokens = addSafeInteger(statistics.cacheWriteTokens, cacheWrite)
    statistics.cost += cost
    if (!Number.isFinite(statistics.cost)) {
      throw new Error('Invalid assistant usage in Pi session transcript entry.')
    }
  }

  statistics.totalTokens = addSafeInteger(
    addSafeInteger(statistics.inputTokens, statistics.outputTokens),
    addSafeInteger(statistics.cacheReadTokens, statistics.cacheWriteTokens)
  )
  return statistics
}

function readTokenCount(value: unknown): number {
  if (!isNonNegativeFiniteNumber(value) || !Number.isSafeInteger(value)) {
    throw new Error('Invalid assistant usage in Pi session transcript entry.')
  }
  return value
}

function addSafeInteger(left: number, right: number): number {
  const total = left + right
  if (!Number.isSafeInteger(total)) {
    throw new Error('Pi session transcript statistics exceed the safe integer range.')
  }
  return total
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
