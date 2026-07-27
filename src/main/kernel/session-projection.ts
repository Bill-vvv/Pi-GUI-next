import type {
  KernelConversationEntry,
  KernelModelState,
  KernelSessionState,
  KernelSessionStatistics,
  KernelSessionUsage,
  ThinkingLevel
} from '../../shared/kernel-contract.ts'
import type {
  PiRpcAvailableModel,
  PiRpcSessionState,
  PiRpcSessionStats
} from '../pi-rpc/pi-rpc-client.ts'

export function toKernelSession(
  state: PiRpcSessionState,
  resumeAvailable: boolean,
  usageFallback: KernelSessionUsage | null = null
): KernelSessionState {
  return {
    id: stringValue(state.sessionId),
    name: stringValue(state.sessionName),
    resumeAvailable,
    model: toKernelModel(state.model),
    usage: usageFallback,
    thinkingLevel: thinkingLevel(state.thinkingLevel),
    messageCount: integerValue(state.messageCount),
    pendingMessageCount: integerValue(state.pendingMessageCount),
    pendingSteeringMessages: [],
    pendingFollowUpMessages: [],
    compaction: null,
    settled: state.isStreaming !== true
  }
}

export function toKernelSessionUsage(
  stats: PiRpcSessionStats,
  modelContextWindow?: number
): KernelSessionUsage {
  return {
    inputTokens: stats.tokens.input,
    outputTokens: stats.tokens.output,
    cacheReadTokens: stats.tokens.cacheRead,
    cacheWriteTokens: stats.tokens.cacheWrite,
    totalTokens: stats.tokens.total,
    contextTokens: stats.contextUsage?.tokens ?? null,
    contextWindow: stats.contextUsage?.contextWindow ?? (
      typeof modelContextWindow === 'number' ? modelContextWindow : null
    ),
    contextPercent: stats.contextUsage?.percent ?? null,
    cost: stats.cost
  }
}

export function toKernelSessionStatistics(stats: PiRpcSessionStats): KernelSessionStatistics {
  return {
    userMessages: stats.userMessages,
    assistantMessages: stats.assistantMessages,
    toolCalls: stats.toolCalls,
    toolResults: stats.toolResults,
    totalMessages: stats.totalMessages,
    inputTokens: stats.tokens.input,
    outputTokens: stats.tokens.output,
    cacheReadTokens: stats.tokens.cacheRead,
    cacheWriteTokens: stats.tokens.cacheWrite,
    totalTokens: stats.tokens.total,
    cost: stats.cost
  }
}

export function toKernelModel(value: PiRpcSessionState['model']): KernelModelState | null {
  if (value === null || value === undefined) return null
  if (typeof value.id !== 'string' || typeof value.provider !== 'string') return null
  return {
    provider: value.provider,
    id: value.id,
    name: typeof value.name === 'string' ? value.name : value.id,
    reasoning: value.reasoning === true,
    thinkingLevelMap: { ...(value.thinkingLevelMap ?? {}) },
    contextWindow: typeof value.contextWindow === 'number' ? value.contextWindow : null
  }
}

export function toAvailableKernelModel(value: PiRpcAvailableModel): KernelModelState {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('id' in value) ||
    typeof value.id !== 'string' ||
    value.id.trim().length === 0 ||
    !('provider' in value) ||
    typeof value.provider !== 'string' ||
    value.provider.trim().length === 0
  ) {
    throw new Error('Runtime returned an invalid model catalog.')
  }
  return {
    id: value.id,
    provider: value.provider,
    name: 'name' in value && typeof value.name === 'string' ? value.name : value.id,
    reasoning: 'reasoning' in value && value.reasoning === true,
    thinkingLevelMap: {
      ...('thinkingLevelMap' in value && typeof value.thinkingLevelMap === 'object'
        ? value.thinkingLevelMap
        : {})
    },
    contextWindow: 'contextWindow' in value && typeof value.contextWindow === 'number'
      ? value.contextWindow
      : null,
    ...(value.cost === undefined
      ? {}
      : {
          pricing: {
            input: value.cost.input,
            output: value.cost.output,
            cacheRead: value.cost.cacheRead,
            cacheWrite: value.cost.cacheWrite,
            ...(value.cost.tiers === undefined
              ? {}
              : {
                  tiers: value.cost.tiers.map((tier) => ({
                    inputTokensAbove: tier.inputTokensAbove,
                    input: tier.input,
                    output: tier.output,
                    cacheRead: tier.cacheRead,
                    cacheWrite: tier.cacheWrite
                  }))
                })
          }
        })
  }
}

export function mergeConversationEntries(
  projected: KernelConversationEntry[],
  additions: readonly KernelConversationEntry[]
): KernelConversationEntry[] {
  if (additions.length === 0) return projected
  const result = projected.slice()
  for (const addition of additions) {
    const existingIndex = result.findIndex((entry) => entry.id === addition.id)
    if (existingIndex !== -1) {
      result[existingIndex] = addition
      continue
    }
    const insertionIndex = result.findIndex((entry) => entry.timestamp > addition.timestamp)
    if (insertionIndex === -1) result.push(addition)
    else result.splice(insertionIndex, 0, addition)
  }
  return result
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function integerValue(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

function thinkingLevel(value: unknown): ThinkingLevel | null {
  return value === 'off' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max'
    ? value
    : null
}
