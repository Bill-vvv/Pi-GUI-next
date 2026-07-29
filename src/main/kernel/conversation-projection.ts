import type {
  KernelAdvisorEntry,
  KernelAskToolState,
  KernelConversationEntry,
  KernelExtensionStatusEntry,
  KernelMessageEntry,
  KernelMessagePhase,
  KernelThinkingEntry,
  KernelTodoItem,
  KernelToolEntry,
  KernelToolImageAttachment
} from '../../shared/kernel-contract.ts'
import type { PiRpcEvent, PiRpcSessionEntry } from '../pi-rpc/pi-rpc-client.ts'
import { projectPromptDisplay } from '../prompt/prompt-attachments.ts'
import { isRecord } from '../utils/guards.ts'
import {
  isSubagentToolName,
  projectSubagentCustomMessage,
  projectSubagentRun,
  resolveSubagentSupervisorRequest
} from './subagent-projection.ts'
import {
  mergeToolImageAttachments,
  projectToolResultContent
} from './tool-result-images.ts'

const MAX_DISPLAY_CHARS = 30_000
const MAX_ADVISOR_SLUG_CHARS = 128
const MAX_ADVISOR_NAME_CHARS = 256
const MAX_ADVISOR_TEXT_CHARS = 30_000
const MAX_CUSTOM_ID_CHARS = 256
const MAX_TODO_ITEMS = 100
const MAX_TODO_CONTENT_CHARS = 1_000
const MAX_TODO_ID_CHARS = 256
const ADVISORY_TYPE = 'pi-gui.multi-advisor/advisory'
const MAGIC_CONTEXT_ENTRY_TYPE = 'ctx-status'
const MAGIC_CONTEXT_STATUS_ID = 'extension-status:magic-context'
const ADVISORY_DETAIL_KEYS = [
  'protocolVersion',
  'advisorSlug',
  'advisorName',
  'severity',
  'guidance',
  'note',
  'delivery',
  'timestamp'
] as const

export function projectMessages(messages: unknown[]): KernelConversationEntry[] {
  let entries: KernelConversationEntry[] = []
  for (const [messageIndex, message] of messages.entries()) {
    entries = projectMessage(entries, message, false, `history:${messageIndex}`)
  }
  // History loads an idle session snapshot. Any tool still missing a result was
  // interrupted mid-run (abort/crash/kill) and must not stay pending/running.
  return settleInterruptedHistoricalTools(entries)
}

export function projectSessionEntries(
  activePath: readonly PiRpcSessionEntry[]
): KernelConversationEntry[] {
  let entries: KernelConversationEntry[] = []
  for (const entry of activePath) {
    if (entry.type !== 'custom' || entry.customType !== MAGIC_CONTEXT_ENTRY_TYPE) continue
    const timestamp = timestampValue(entry.timestamp)
    if (timestamp === null) continue
    const projected = projectMagicContextEntry(
      entry.data,
      `magic-context:entry:${entry.id}`,
      timestamp
    )
    if (projected !== null) entries = upsert(entries, projected)
  }
  return entries
}

function settleInterruptedHistoricalTools(
  entries: KernelConversationEntry[]
): KernelConversationEntry[] {
  let changed = false
  const next = entries.map((entry) => {
    if (
      entry.kind !== 'tool' ||
      (entry.status !== 'pending' && entry.status !== 'running')
    ) return entry
    changed = true
    return {
      ...entry,
      status: 'error' as const,
      output: entry.output.length > 0 ? entry.output : '已中止',
      subagent: entry.subagent === null
        ? null
        : {
            ...entry.subagent,
            participants: entry.subagent.participants.map((participant) => (
              participant.status === 'pending' || participant.status === 'running'
                ? {
                    ...participant,
                    status: 'failed' as const,
                    error: participant.error ?? '已中止'
                  }
                : participant
            ))
          }
    }
  })
  return changed ? next : entries
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
    if (existing?.status === 'success' || existing?.status === 'error') return entries
    const name = stringValue(event.toolName) ?? existing?.name ?? 'tool'
    return upsert(entries, {
      id: `tool:${toolCallId}`,
      kind: 'tool',
      toolCallId,
      name,
      status: 'running',
      args: isTodoWriteToolName(name) ? '' : formatValue(event.args),
      output: existing?.output ?? '',
      details: isSubagentToolName(name) || isTodoWriteToolName(name)
        ? ''
        : existing?.details ?? '',
      truncated: existing?.truncated ?? false,
      timestamp: now,
      durationMs: null,
      subagent: isSubagentToolName(name) ? projectSubagentRun(event.args, undefined) : null,
      ...askToolStateField(existing?.ask),
      ...todoItemsField(name, event.args, existing),
      ...toolAttachmentsField(undefined, isSubagentToolName(name) ? undefined : existing?.attachments)
    })
  }

  if (event.type === 'tool_execution_update') {
    const toolCallId = stringValue(event.toolCallId)
    if (toolCallId === null) return entries
    const existing = findTool(entries, toolCallId)
    if (existing?.status === 'success' || existing?.status === 'error') return entries
    const partialResult = isRecord(event.partialResult) ? event.partialResult : {}
    const name = stringValue(event.toolName) ?? existing?.name ?? 'tool'
    const projected = projectToolResultContent(partialResult.content)
    const limited = limitText(projected.text)
    const attachments = isSubagentToolName(name)
      ? undefined
      : mergeToolImageAttachments(existing?.attachments, projected.attachments)
    return upsert(entries, {
      id: `tool:${toolCallId}`,
      kind: 'tool',
      toolCallId,
      name,
      status: 'running',
      args: isTodoWriteToolName(name)
        ? ''
        : formatValue(event.args ?? existing?.args ?? ''),
      output: limited.text,
      details: isSubagentToolName(name) || isTodoWriteToolName(name)
        ? ''
        : formatValue(partialResult.details),
      truncated: limited.truncated || hasTruncation(partialResult.details),
      timestamp: existing?.timestamp ?? now,
      durationMs: null,
      subagent: isSubagentToolName(name)
        ? projectSubagentRun(event.args, partialResult.details) ?? existing?.subagent ?? null
        : null,
      ...askToolStateField(existing?.ask),
      ...todoItemsField(name, event.args, existing),
      ...toolAttachmentsField(undefined, attachments)
    })
  }

  if (event.type === 'tool_execution_end') {
    const toolCallId = stringValue(event.toolCallId)
    if (toolCallId === null) return entries
    const existing = findTool(entries, toolCallId)
    const result = isRecord(event.result) ? event.result : {}
    const name = stringValue(event.toolName) ?? existing?.name ?? 'tool'
    const projected = projectToolResultContent(result.content)
    const limited = limitText(projected.text)
    const timestamp = existing?.timestamp ?? now
    // Terminal end may clear attachments only when content is present and has none;
    // missing content keeps prior metadata so empty partials never erase images.
    const attachments = isSubagentToolName(name)
      ? undefined
      : 'content' in result
        ? (projected.attachments.length > 0 ? projected.attachments : undefined)
        : mergeToolImageAttachments(existing?.attachments, projected.attachments)
    const nextEntries = upsert(entries, {
      id: `tool:${toolCallId}`,
      kind: 'tool',
      toolCallId,
      name,
      status: event.isError === true ? 'error' : 'success',
      args: existing?.args ?? '',
      output: limited.text,
      details: isSubagentToolName(name) || isTodoWriteToolName(name)
        ? ''
        : formatValue(result.details),
      truncated: limited.truncated || hasTruncation(result.details),
      timestamp,
      durationMs: Math.max(0, now - timestamp),
      subagent: isSubagentToolName(name)
        ? projectSubagentRun(existing?.args, result.details) ?? existing?.subagent ?? null
        : null,
      ...todoItemsField(name, existing?.args, existing),
      ...toolAttachmentsField(undefined, attachments)
    })
    return event.isError === true
      ? nextEntries
      : resolveSubagentSupervisorRequest(nextEntries, name, existing?.args, now)
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

  if (event.type === 'entry_appended') {
    const entry = isRecord(event.entry) ? event.entry : null
    if (
      entry === null ||
      entry.type !== 'custom' ||
      entry.customType !== MAGIC_CONTEXT_ENTRY_TYPE ||
      !isBoundedString(entry.id, MAX_CUSTOM_ID_CHARS, true)
    ) return entries
    const projected = projectMagicContextEntry(
      entry.data,
      `magic-context:entry:${entry.id}`,
      timestampValue(entry.timestamp) ?? now
    )
    return projected === null ? entries : upsert(entries, projected)
  }

  if (
    event.type === 'extension_ui_request' &&
    event.method === 'setStatus' &&
    event.statusKey === 'magic-context'
  ) {
    if (event.statusText === undefined) return removeById(entries, MAGIC_CONTEXT_STATUS_ID)
    if (!isBoundedString(event.statusText, MAX_DISPLAY_CHARS, true)) return entries
    return upsert(entries, {
      id: MAGIC_CONTEXT_STATUS_ID,
      kind: 'extension-status',
      source: 'magic-context',
      title: 'Magic Context',
      text: event.statusText,
      level: event.statusText.includes('⚠') ? 'warning' : 'info',
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
    const display = projectPromptDisplay(value.content)
    const messageId = historicalIdentity === undefined
      ? `message:user:${timestamp}`
      : `message:${historicalIdentity}:user`
    const entry: KernelMessageEntry = {
      id: messageId,
      kind: 'message',
      role: 'user',
      phase: null,
      text: display.text,
      timestamp,
      streaming: false,
      stopReason: null,
      error: null,
      ...(display.attachments.length === 0 ? {} : { attachments: display.attachments })
    }
    return upsert(entries, entry)
  }

  if (value.role === 'assistant') {
    const content = Array.isArray(value.content) ? value.content : []
    const hasToolCall = content.some((item) => isRecord(item) && item.type === 'toolCall')
    const messageId = historicalIdentity === undefined
      ? `message:assistant:${timestamp}`
      : `message:${historicalIdentity}:assistant`
    const lastTextIndex = content.findLastIndex((item) => isRecord(item) && item.type === 'text')
    let nextEntries = entries
    let messageProjected = false
    for (const [contentIndex, item] of content.entries()) {
      if (!isRecord(item)) continue
      if (item.type === 'thinking') {
        const thinkingEntry: KernelThinkingEntry = {
          id: `${messageId}:thinking:${contentIndex}`,
          kind: 'thinking',
          text: stringValue(item.thinking) ?? '',
          summary: isThinkingSummary(item.thinkingSignature),
          timestamp,
          streaming
        }
        nextEntries = upsert(nextEntries, thinkingEntry)
        continue
      }
      if (item.type === 'text') {
        const messageEntry: KernelMessageEntry = {
          id: messageProjected ? `${messageId}:text:${contentIndex}` : messageId,
          kind: 'message',
          role: 'assistant',
          phase: phaseFromTextSignature(item.textSignature) ?? (hasToolCall ? 'commentary' : null),
          text: stringValue(item.text) ?? '',
          timestamp,
          streaming,
          stopReason: contentIndex === lastTextIndex ? stringValue(value.stopReason) : null,
          error: contentIndex === lastTextIndex ? stringValue(value.errorMessage) : null
        }
        nextEntries = upsert(nextEntries, messageEntry)
        messageProjected = true
        continue
      }
      if (item.type !== 'toolCall') continue
      const toolCallId = stringValue(item.id)
      if (toolCallId === null) continue
      const existing = findTool(nextEntries, toolCallId)
      const name = stringValue(item.name) ?? existing?.name ?? 'tool'
      nextEntries = upsert(nextEntries, {
        id: `tool:${toolCallId}`,
        kind: 'tool',
        toolCallId,
        name,
        status: existing?.status ?? 'pending',
        args: isTodoWriteToolName(name) ? '' : formatValue(item.arguments),
        output: existing?.output ?? '',
        details: isSubagentToolName(name) || isTodoWriteToolName(name)
          ? ''
          : existing?.details ?? '',
        truncated: existing?.truncated ?? false,
        timestamp: existing?.timestamp ?? timestamp,
        durationMs: existing?.durationMs ?? null,
        subagent: isSubagentToolName(name)
          ? projectSubagentRun(item.arguments, undefined) ?? existing?.subagent ?? null
          : null,
        ...askToolStateField(existing?.ask),
        ...todoItemsField(name, item.arguments, existing),
        ...toolAttachmentsField(undefined, isSubagentToolName(name) ? undefined : existing?.attachments)
      })
    }
    const error = stringValue(value.errorMessage)
    if (!messageProjected && error !== null) {
      nextEntries = upsert(nextEntries, {
        id: messageId,
        kind: 'message',
        role: 'assistant',
        phase: null,
        text: '',
        timestamp,
        streaming,
        stopReason: stringValue(value.stopReason),
        error
      })
    }
    return nextEntries
  }

  if (value.role === 'toolResult') {
    const toolCallId = stringValue(value.toolCallId)
    if (toolCallId === null) return entries
    const existing = findTool(entries, toolCallId)
    const projected = projectToolResultContent(value.content)
    const limited = limitText(projected.text)
    const name = stringValue(value.toolName) ?? existing?.name ?? 'tool'
    const attachments = isSubagentToolName(name)
      ? undefined
      : projected.attachments.length > 0 ? projected.attachments : undefined
    const nextEntries = upsert(entries, {
      id: `tool:${toolCallId}`,
      kind: 'tool',
      toolCallId,
      name,
      status: value.isError === true ? 'error' : 'success',
      args: existing?.args ?? '',
      output: limited.text,
      details: isSubagentToolName(name) || isTodoWriteToolName(name)
        ? ''
        : formatValue(value.details),
      truncated: limited.truncated || hasTruncation(value.details),
      timestamp: existing?.timestamp ?? timestamp,
      durationMs: existing?.durationMs ?? null,
      subagent: isSubagentToolName(name)
        ? projectSubagentRun(existing?.args, value.details) ?? existing?.subagent ?? null
        : null,
      ...todoItemsField(name, existing?.args, existing),
      ...toolAttachmentsField(undefined, attachments)
    })
    return value.isError === true
      ? nextEntries
      : resolveSubagentSupervisorRequest(nextEntries, name, existing?.args, timestamp)
  }

  if (value.role === 'custom') {
    const customType = stringValue(value.customType)
    const subagentProjected = projectSubagentCustomMessage(entries, {
      customType,
      content: value.content,
      details: value.details,
      display: value.display,
      timestamp,
      historicalIdentity
    })
    if (subagentProjected !== null) return subagentProjected
    if (value.display !== true) return entries
    if (customType === ADVISORY_TYPE) {
      const details = projectAdvisoryDetails(value.details)
      if (details === null) return entries
      const entry: KernelAdvisorEntry = {
        id: historicalIdentity === undefined
          ? `advisor:${details.advisorSlug}:${details.timestamp}`
          : `advisor:${historicalIdentity}`,
        kind: 'advisor',
        advisorSlug: details.advisorSlug,
        advisorName: details.advisorName,
        severity: details.severity,
        guidance: details.guidance,
        content: details.note,
        delivery: details.delivery,
        timestamp: details.timestamp
      }
      return upsert(entries, entry)
    }
    return entries
  }

  return entries
}

function projectMagicContextEntry(
  value: unknown,
  id: string,
  timestamp: number
): KernelExtensionStatusEntry | null {
  if (
    !isRecord(value) ||
    !isBoundedString(value.title, MAX_ADVISOR_NAME_CHARS, true) ||
    !isBoundedString(value.text, MAX_DISPLAY_CHARS, true)
  ) return null
  const level = value.level === undefined ? 'info' : magicContextLevel(value.level)
  if (level === null) return null
  return {
    id,
    kind: 'extension-status',
    source: 'magic-context',
    title: value.title,
    text: value.text,
    level,
    timestamp
  }
}

function magicContextLevel(value: unknown): KernelExtensionStatusEntry['level'] | null {
  return value === 'info' || value === 'success' || value === 'warning' || value === 'error'
    ? value
    : null
}

function projectAdvisoryDetails(value: unknown): {
  advisorSlug: string
  advisorName: string
  severity: KernelAdvisorEntry['severity']
  guidance: string
  note: string
  delivery: KernelAdvisorEntry['delivery']
  timestamp: number
} | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ADVISORY_DETAIL_KEYS) ||
    (value.protocolVersion !== 1 && value.protocolVersion !== 2) ||
    !isBoundedAdvisorString(value.advisorSlug, MAX_ADVISOR_SLUG_CHARS) ||
    !isBoundedAdvisorString(value.advisorName, MAX_ADVISOR_NAME_CHARS) ||
    !isBoundedAdvisorString(value.guidance, MAX_ADVISOR_TEXT_CHARS) ||
    !isBoundedAdvisorString(value.note, MAX_ADVISOR_TEXT_CHARS) ||
    (value.severity !== 'nit' && value.severity !== 'concern' && value.severity !== 'blocker') ||
    (value.delivery !== 'aside' && value.delivery !== 'steer') ||
    typeof value.timestamp !== 'number' ||
    !Number.isFinite(value.timestamp)
  ) return null
  return {
    advisorSlug: value.advisorSlug,
    advisorName: value.advisorName,
    severity: value.severity,
    guidance: value.guidance,
    note: value.note,
    delivery: value.delivery,
    timestamp: value.timestamp
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every((key) => keys.includes(key))
}

function isBoundedAdvisorString(value: unknown, maxChars: number): value is string {
  return isBoundedString(value, maxChars)
}

function isBoundedString(
  value: unknown,
  maxChars: number,
  nonEmpty = false
): value is string {
  return typeof value === 'string' &&
    (!nonEmpty || value.trim().length > 0) &&
    value.length <= maxChars &&
    !value.includes('\0')
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

function removeById(entries: KernelConversationEntry[], id: string): KernelConversationEntry[] {
  const nextEntries = entries.filter((entry) => entry.id !== id)
  return nextEntries.length === entries.length ? entries : nextEntries
}

function findTool(entries: KernelConversationEntry[], toolCallId: string): KernelToolEntry | undefined {
  const entry = entries.find(
    (candidate): candidate is KernelToolEntry =>
      candidate.kind === 'tool' && candidate.toolCallId === toolCallId
  )
  return entry
}

function hasTruncation(value: unknown): boolean {
  return isRecord(value) && value.truncation !== null && value.truncation !== undefined
}

function isTodoWriteToolName(name: string): boolean {
  return name.trim().toLowerCase().split(/[.:/]/u).at(-1) === 'todowrite'
}

function todoItemsField(
  name: string,
  argsValue: unknown,
  existing: KernelToolEntry | undefined
): Pick<KernelToolEntry, 'todos'> | Record<never, never> {
  if (!isTodoWriteToolName(name)) return {}
  const todos = projectTodoItems(argsValue)
  if (todos !== null) return { todos }
  return existing?.todos === undefined ? {} : { todos: existing.todos }
}

function askToolStateField(
  ask: KernelAskToolState | undefined
): Pick<KernelToolEntry, 'ask'> | Record<never, never> {
  if (ask === undefined) return {}
  return {
    ask: {
      status: ask.status,
      error: ask.error,
      questions: ask.questions.map((question) => ({
        ...question,
        options: question.options.map((option) => ({ ...option }))
      }))
    }
  }
}

function toolAttachmentsField(
  _existing: readonly KernelToolImageAttachment[] | undefined,
  attachments: readonly KernelToolImageAttachment[] | undefined
): Pick<KernelToolEntry, 'attachments'> | Record<never, never> {
  if (attachments === undefined || attachments.length === 0) return {}
  return { attachments: attachments.map((attachment) => ({ ...attachment })) }
}

function projectTodoItems(value: unknown): KernelTodoItem[] | null {
  const args = parseRecordValue(value)
  if (
    args === null ||
    !Array.isArray(args.todos) ||
    args.todos.length > MAX_TODO_ITEMS
  ) return null

  const todos: KernelTodoItem[] = []
  for (const value of args.todos) {
    const item = parseRecordValue(value)
    if (item === null) return null
    if (!isBoundedString(item.content, MAX_TODO_CONTENT_CHARS, true)) return null
    if (
      item.status !== 'pending' &&
      item.status !== 'in_progress' &&
      item.status !== 'completed' &&
      item.status !== 'cancelled'
    ) return null
    if (
      item.priority !== undefined &&
      item.priority !== 'high' &&
      item.priority !== 'medium' &&
      item.priority !== 'low'
    ) return null
    if (
      item.id !== undefined &&
      !isBoundedString(item.id, MAX_TODO_ID_CHARS, true)
    ) return null
    todos.push({
      id: typeof item.id === 'string' ? item.id : null,
      content: item.content.trim(),
      status: item.status,
      priority: item.priority === 'high' || item.priority === 'medium' || item.priority === 'low'
        ? item.priority
        : null
    })
  }
  return todos
}

function parseRecordValue(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value
  if (typeof value !== 'string' || !value.trim().startsWith('{')) return null
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
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

function phaseFromTextSignature(value: unknown): KernelMessagePhase | null {
  if (typeof value !== 'string' || !value.startsWith('{')) return null
  try {
    const signature: unknown = JSON.parse(value)
    if (!isRecord(signature) || signature.v !== 1 || typeof signature.id !== 'string') return null
    return signature.phase === 'commentary' || signature.phase === 'final_answer'
      ? signature.phase
      : null
  } catch {
    return null
  }
}

function isThinkingSummary(value: unknown): boolean {
  if (typeof value !== 'string' || !value.startsWith('{')) return false
  try {
    const signature: unknown = JSON.parse(value)
    if (!isRecord(signature) || !Array.isArray(signature.summary)) return false
    return signature.summary.some(
      (item) => isRecord(item) && item.type === 'summary_text' && typeof item.text === 'string'
    )
  } catch {
    return false
  }
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function timestampValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}
