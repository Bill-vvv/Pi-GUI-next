import type {
  KernelConversationEntry,
  KernelMessageEntry,
  KernelThinkingEntry,
  KernelToolEntry
} from '../../shared/kernel-contract.ts'
import type { PiRpcEvent } from '../pi-rpc/pi-rpc-client.ts'
import { isRecord } from '../utils/guards.ts'

const MAX_DISPLAY_CHARS = 30_000

export function projectMessages(messages: unknown[]): KernelConversationEntry[] {
  let entries: KernelConversationEntry[] = []
  for (const [messageIndex, message] of messages.entries()) {
    entries = projectMessage(entries, message, false, `history:${messageIndex}`)
  }
  return entries
}

export function projectPiEvent(
  entries: KernelConversationEntry[],
  event: PiRpcEvent,
  now = Date.now()
): KernelConversationEntry[] {
  if (
    event.type === 'message_start' ||
    event.type === 'message_update' ||
    event.type === 'message_end'
  ) {
    return projectMessage(entries, event.message, event.type === 'message_update')
  }

  if (event.type === 'tool_execution_start') {
    const toolCallId = stringValue(event.toolCallId)
    if (toolCallId === null) return entries
    const existing = findTool(entries, toolCallId)
    return upsert(entries, {
      id: `tool:${toolCallId}`,
      kind: 'tool',
      toolCallId,
      name: stringValue(event.toolName) ?? existing?.name ?? 'tool',
      status: 'running',
      args: formatValue(event.args),
      output: existing?.output ?? '',
      details: existing?.details ?? '',
      truncated: existing?.truncated ?? false,
      timestamp: now,
      durationMs: null
    })
  }

  if (event.type === 'tool_execution_update') {
    const toolCallId = stringValue(event.toolCallId)
    if (toolCallId === null) return entries
    const existing = findTool(entries, toolCallId)
    const partialResult = isRecord(event.partialResult) ? event.partialResult : {}
    const output = textFromContent(partialResult.content)
    const limited = limitText(output)
    return upsert(entries, {
      id: `tool:${toolCallId}`,
      kind: 'tool',
      toolCallId,
      name: stringValue(event.toolName) ?? existing?.name ?? 'tool',
      status: 'running',
      args: formatValue(event.args ?? existing?.args ?? ''),
      output: limited.text,
      details: formatValue(partialResult.details),
      truncated: limited.truncated || hasTruncation(partialResult.details),
      timestamp: existing?.timestamp ?? now,
      durationMs: null
    })
  }

  if (event.type === 'tool_execution_end') {
    const toolCallId = stringValue(event.toolCallId)
    if (toolCallId === null) return entries
    const existing = findTool(entries, toolCallId)
    const result = isRecord(event.result) ? event.result : {}
    const limited = limitText(textFromContent(result.content))
    const timestamp = existing?.timestamp ?? now
    return upsert(entries, {
      id: `tool:${toolCallId}`,
      kind: 'tool',
      toolCallId,
      name: stringValue(event.toolName) ?? existing?.name ?? 'tool',
      status: event.isError === true ? 'error' : 'success',
      args: existing?.args ?? '',
      output: limited.text,
      details: formatValue(result.details),
      truncated: limited.truncated || hasTruncation(result.details),
      timestamp,
      durationMs: Math.max(0, now - timestamp)
    })
  }

  if (event.type === 'extension_error') {
    const message = stringValue(event.error)
    if (message === null) return entries
    return upsert(entries, {
      id: `error:extension:${now}:${entries.length}`,
      kind: 'error',
      title: 'Extension error',
      message,
      source: 'extension',
      timestamp: now
    })
  }

  return entries
}

function projectMessage(
  entries: KernelConversationEntry[],
  value: unknown,
  streaming: boolean,
  historicalIdentity?: string
): KernelConversationEntry[] {
  if (!isRecord(value) || typeof value.role !== 'string') return entries
  const timestamp = numberValue(value.timestamp) ?? Date.now()

  if (value.role === 'user') {
    const text = textFromContent(value.content)
    const messageId = historicalIdentity === undefined
      ? `message:user:${timestamp}`
      : `message:${historicalIdentity}:user`
    const entry: KernelMessageEntry = {
      id: messageId,
      kind: 'message',
      role: 'user',
      text,
      timestamp,
      streaming: false,
      stopReason: null,
      error: null
    }
    return upsert(entries, entry)
  }

  if (value.role === 'assistant') {
    const content = Array.isArray(value.content) ? value.content : []
    const messageId = historicalIdentity === undefined
      ? `message:assistant:${timestamp}`
      : `message:${historicalIdentity}:assistant`
    const messageEntry: KernelMessageEntry = {
      id: messageId,
      kind: 'message',
      role: 'assistant',
      text: content
        .filter((item) => isRecord(item) && item.type === 'text')
        .map((item) => stringValue(item.text) ?? '')
        .join(''),
      timestamp,
      streaming,
      stopReason: stringValue(value.stopReason),
      error: stringValue(value.errorMessage)
    }
    let nextEntries = entries
    let messageProjected = false
    for (const [contentIndex, item] of content.entries()) {
      if (!isRecord(item)) continue
      if (item.type === 'thinking') {
        const thinkingEntry: KernelThinkingEntry = {
          id: `${messageId}:thinking:${contentIndex}`,
          kind: 'thinking',
          text: stringValue(item.thinking) ?? '',
          timestamp,
          streaming
        }
        nextEntries = upsert(nextEntries, thinkingEntry)
        continue
      }
      if (item.type === 'text') {
        if (!messageProjected) {
          nextEntries = upsert(nextEntries, messageEntry)
          messageProjected = true
        }
        continue
      }
      if (item.type !== 'toolCall') continue
      const toolCallId = stringValue(item.id)
      if (toolCallId === null) continue
      const existing = findTool(nextEntries, toolCallId)
      nextEntries = upsert(nextEntries, {
        id: `tool:${toolCallId}`,
        kind: 'tool',
        toolCallId,
        name: stringValue(item.name) ?? existing?.name ?? 'tool',
        status: existing?.status ?? 'pending',
        args: formatValue(item.arguments),
        output: existing?.output ?? '',
        details: existing?.details ?? '',
        truncated: existing?.truncated ?? false,
        timestamp: existing?.timestamp ?? timestamp,
        durationMs: existing?.durationMs ?? null
      })
    }
    if (!messageProjected && messageEntry.error !== null) {
      nextEntries = upsert(nextEntries, messageEntry)
    }
    return nextEntries
  }

  if (value.role === 'toolResult') {
    const toolCallId = stringValue(value.toolCallId)
    if (toolCallId === null) return entries
    const existing = findTool(entries, toolCallId)
    const limited = limitText(textFromContent(value.content))
    return upsert(entries, {
      id: `tool:${toolCallId}`,
      kind: 'tool',
      toolCallId,
      name: stringValue(value.toolName) ?? existing?.name ?? 'tool',
      status: value.isError === true ? 'error' : 'success',
      args: existing?.args ?? '',
      output: limited.text,
      details: formatValue(value.details),
      truncated: limited.truncated || hasTruncation(value.details),
      timestamp: existing?.timestamp ?? timestamp,
      durationMs: existing?.durationMs ?? null
    })
  }

  return entries
}

function upsert(
  entries: KernelConversationEntry[],
  entry: KernelConversationEntry
): KernelConversationEntry[] {
  const index = entries.findIndex((candidate) => candidate.id === entry.id)
  if (index === -1) return [...entries, entry]
  const nextEntries = entries.slice()
  nextEntries[index] = entry
  return nextEntries
}

function findTool(entries: KernelConversationEntry[], toolCallId: string): KernelToolEntry | undefined {
  const entry = entries.find(
    (candidate): candidate is KernelToolEntry =>
      candidate.kind === 'tool' && candidate.toolCallId === toolCallId
  )
  return entry
}

function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .filter((item) => isRecord(item) && item.type === 'text')
    .map((item) => stringValue(item.text) ?? '')
    .join('\n')
}

function hasTruncation(value: unknown): boolean {
  return isRecord(value) && value.truncation !== null && value.truncation !== undefined
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value === 'string') return limitText(value).text
  try {
    return limitText(JSON.stringify(value, null, 2)).text
  } catch {
    return limitText(String(value)).text
  }
}

function limitText(value: string): { text: string; truncated: boolean } {
  if (value.length <= MAX_DISPLAY_CHARS) return { text: value, truncated: false }
  return {
    text: `${value.slice(0, MAX_DISPLAY_CHARS)}\n… output truncated for display`,
    truncated: true
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
