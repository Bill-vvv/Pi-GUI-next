import type {
  KernelAdvisorEntry,
  KernelConversationEntry,
  KernelExtensionStatusEntry,
  KernelMessageEntry,
  KernelMessagePhase,
  KernelSubagentCoordination,
  KernelSubagentNoticeEntry,
  KernelSubagentParticipant,
  KernelSubagentRun,
  KernelSubagentStatus,
  KernelThinkingEntry,
  KernelTodoItem,
  KernelToolEntry,
  KernelToolImageAttachment
} from '../../shared/kernel-contract.ts'
import type { PiRpcEvent, PiRpcSessionEntry } from '../pi-rpc/pi-rpc-client.ts'
import { projectPromptDisplay } from '../prompt/prompt-attachments.ts'
import { isRecord } from '../utils/guards.ts'
import {
  mergeToolImageAttachments,
  projectToolResultContent
} from './tool-result-images.ts'

const MAX_DISPLAY_CHARS = 30_000
const MAX_SUBAGENT_TEXT_CHARS = 6_000
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

const SUBAGENT_NOTICE_TYPES = {
  'subagent-notify': 'completion',
  subagent_control_notice: 'control',
  subagent_steering_notice: 'steering',
  subagent_supervisor_request: 'request',
  'subagents-admin': 'admin',
  'subagent-slash-text-result': 'command'
} as const
const SUBAGENT_SLASH_RESULT_TYPE = 'subagent-slash-result'
const SUBAGENT_WATCHDOG_TYPE = 'subagent_watchdog_warning'

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
    if (customType === SUBAGENT_SLASH_RESULT_TYPE) {
      const requestId = slashRequestId(value.details)
      const text = limitText(textFromContent(value.content)).text
      if (requestId === null || text.trim().length === 0) return entries
      const entry: KernelSubagentNoticeEntry = {
        id: `subagent-notice:slash:${requestId}`,
        kind: 'subagent-notice',
        noticeType: 'command',
        text,
        timestamp
      }
      return upsert(entries, entry)
    }
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
    if (customType === SUBAGENT_WATCHDOG_TYPE) {
      const warning = projectWatchdogWarning(value.details)
      if (warning === null) return entries
      const entry: KernelSubagentNoticeEntry = {
        id: historicalIdentity === undefined
          ? `subagent-notice:watchdog:${timestamp}:${entries.length}`
          : `subagent-notice:${historicalIdentity}`,
        kind: 'subagent-notice',
        noticeType: warning.severity === 'blocker'
          ? 'watchdog-blocker'
          : 'watchdog-concern',
        text: [
          warning.summary,
          `**证据：** ${warning.evidence}`,
          `**建议：** ${warning.recommendedAction}`
        ].join('\n\n'),
        timestamp
      }
      return upsert(entries, entry)
    }
    if (customType === null || !(customType in SUBAGENT_NOTICE_TYPES)) return entries
    const text = limitText(textFromContent(value.content)).text
    if (text.trim().length === 0) return entries
    const noticeType = SUBAGENT_NOTICE_TYPES[customType as keyof typeof SUBAGENT_NOTICE_TYPES]
    const projectedCoordination = projectSubagentCoordination(
      noticeType,
      value.details,
      text
    )
    const entry: KernelSubagentNoticeEntry = {
      id: projectedCoordination?.id ?? (historicalIdentity === undefined
        ? `subagent-notice:${customType}:${timestamp}:${entries.length}`
        : `subagent-notice:${historicalIdentity}`),
      kind: 'subagent-notice',
      noticeType,
      text: projectedCoordination?.text ?? text,
      timestamp,
      ...(noticeType === 'completion'
        ? { completion: projectSubagentCompletion(text) }
        : {}),
      ...(projectedCoordination === null
        ? {}
        : { coordination: projectedCoordination.coordination })
    }
    return upsertSubagentNotice(entries, entry)
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

function slashRequestId(value: unknown): string | null {
  if (!isRecord(value) || !isBoundedString(value.requestId, MAX_CUSTOM_ID_CHARS, true)) return null
  return value.requestId
}

function projectWatchdogWarning(value: unknown): {
  severity: 'concern' | 'blocker'
  summary: string
  evidence: string
  recommendedAction: string
} | null {
  if (
    !isRecord(value) ||
    (value.severity !== 'concern' && value.severity !== 'blocker') ||
    !isBoundedString(value.summary, MAX_SUBAGENT_TEXT_CHARS, true) ||
    !isBoundedString(value.evidence, MAX_SUBAGENT_TEXT_CHARS, true) ||
    !isBoundedString(value.recommendedAction, MAX_SUBAGENT_TEXT_CHARS, true)
  ) return null
  return {
    severity: value.severity,
    summary: value.summary,
    evidence: value.evidence,
    recommendedAction: value.recommendedAction
  }
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

type ProjectedSubagentCoordination = {
  id: string
  text: string
  coordination: KernelSubagentCoordination
}

function projectSubagentCoordination(
  noticeType: KernelSubagentNoticeEntry['noticeType'],
  detailsValue: unknown,
  fallbackText: string
): ProjectedSubagentCoordination | null {
  const details = isRecord(detailsValue) ? detailsValue : null
  if (details === null) return null

  if (noticeType === 'request') {
    const requestId = boundedStringValue(details.id, MAX_CUSTOM_ID_CHARS)
    const runId = boundedStringValue(details.runId, MAX_CUSTOM_ID_CHARS)
    const agent = boundedStringValue(details.agent, MAX_ADVISOR_NAME_CHARS)
    const participantIndex = integerValue(details.childIndex)
    if (requestId === null || runId === null || agent === null || participantIndex === null) {
      return null
    }
    const reason = boundedStringValue(details.reason, MAX_ADVISOR_SLUG_CHARS)
    const requiresReply = details.expectsReply === true
    const text = cleanSupervisorRequestText(fallbackText) || `${agent} 请求主代理协助。`
    return {
      id: `subagent-notice:request:${requestId}`,
      text,
      coordination: {
        runId,
        agent,
        participantIndex,
        requestId,
        reason,
        requiresReply,
        status: 'pending',
        resolvedAt: null
      }
    }
  }

  if (noticeType !== 'control') return null
  const event = isRecord(details.event) ? details.event : null
  if (event === null) return null
  const runId = boundedStringValue(event.runId, MAX_CUSTOM_ID_CHARS)
  const agent = boundedStringValue(event.agent, MAX_ADVISOR_NAME_CHARS)
  if (runId === null || agent === null) return null
  const participantIndex = event.index === undefined ? null : integerValue(event.index)
  if (event.index !== undefined && participantIndex === null) return null
  const reason = boundedStringValue(event.reason, MAX_ADVISOR_SLUG_CHARS)
  const message = boundedStringValue(event.message, MAX_SUBAGENT_TEXT_CHARS)
  const recentFailure = boundedStringValue(event.recentFailureSummary, MAX_SUBAGENT_TEXT_CHARS)
  const text = [message, recentFailure].filter((value): value is string => value !== null).join('\n') ||
    `${agent} 需要主代理关注。`
  const eventType = boundedStringValue(event.type, MAX_ADVISOR_SLUG_CHARS) ?? 'needs_attention'
  return {
    id: `subagent-notice:control:${runId}:${participantIndex ?? 'run'}:${eventType}:${reason ?? 'unknown'}`,
    text,
    coordination: {
      runId,
      agent,
      participantIndex,
      requestId: null,
      reason,
      requiresReply: reason === 'supervisor_request',
      status: 'pending',
      resolvedAt: null
    }
  }
}

function cleanSupervisorRequestText(value: string): string {
  const replyHintIndex = value.indexOf('\n\nReply with:')
  return (replyHintIndex === -1 ? value : value.slice(0, replyHintIndex)).trim()
}

function boundedStringValue(value: unknown, maxChars: number): string | null {
  return isBoundedString(value, maxChars, true) ? value : null
}

function upsertSubagentNotice(
  entries: KernelConversationEntry[],
  entry: KernelSubagentNoticeEntry
): KernelConversationEntry[] {
  const coordination = entry.coordination
  if (coordination === undefined) return upsert(entries, entry)

  let nextEntries = entries
  if (entry.noticeType === 'request') {
    nextEntries = entries.filter((candidate) =>
      candidate.kind !== 'subagent-notice' ||
      candidate.noticeType !== 'control' ||
      candidate.coordination?.reason !== 'supervisor_request' ||
      !sameSubagentCoordinationTarget(candidate.coordination, coordination)
    )
  } else if (
    entry.noticeType === 'control' &&
    coordination.reason === 'supervisor_request' &&
    entries.some((candidate) =>
      candidate.kind === 'subagent-notice' &&
      candidate.noticeType === 'request' &&
      candidate.coordination !== undefined &&
      sameSubagentCoordinationTarget(candidate.coordination, coordination)
    )
  ) {
    return entries
  }

  const existing = nextEntries.find((candidate): candidate is KernelSubagentNoticeEntry =>
    candidate.kind === 'subagent-notice' && candidate.id === entry.id
  )
  if (existing?.coordination?.status === 'handled' && coordination.status === 'pending') {
    return upsert(nextEntries, {
      ...entry,
      coordination: {
        ...coordination,
        status: 'handled',
        resolvedAt: existing.coordination.resolvedAt
      }
    })
  }
  return upsert(nextEntries, entry)
}

function sameSubagentCoordinationTarget(
  left: KernelSubagentCoordination,
  right: KernelSubagentCoordination
): boolean {
  return left.runId === right.runId && left.participantIndex === right.participantIndex
}

function resolveSubagentSupervisorRequest(
  entries: KernelConversationEntry[],
  toolName: string,
  argsValue: unknown,
  resolvedAt: number
): KernelConversationEntry[] {
  const name = toolName.trim().toLowerCase().split(/[.:/]/u).at(-1)
  if (name !== 'subagent_supervisor' && name !== 'intercom') return entries
  const args = parseRecordValue(argsValue)
  if (args?.action !== 'reply') return entries
  const requestId = boundedStringValue(args.replyTo, MAX_CUSTOM_ID_CHARS)
  if (requestId === null) return entries

  let changed = false
  const nextEntries = entries.map((entry) => {
    if (
      entry.kind !== 'subagent-notice' ||
      entry.noticeType !== 'request' ||
      entry.coordination?.requestId !== requestId ||
      entry.coordination.status === 'handled'
    ) return entry
    changed = true
    return {
      ...entry,
      coordination: {
        ...entry.coordination,
        status: 'handled' as const,
        resolvedAt
      }
    }
  })
  return changed ? nextEntries : entries
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

function isSubagentToolName(name: string): boolean {
  return name.trim().toLowerCase().split(/[.:/]/u).at(-1) === 'subagent'
}

function isTodoWriteToolName(name: string): boolean {
  return name.trim().toLowerCase().split('.').at(-1) === 'todowrite'
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

function projectSubagentCompletion(text: string): KernelSubagentParticipant {
  const firstLine = text.split('\n', 1)[0] ?? ''
  const single = firstLine.match(
    /^(Background task|Detached foreground task) (completed|failed|paused): \*\*(.+?)\*\*(?:\s+(\([^)]*\)))?$/
  )
  const grouped = firstLine.match(/^Background tasks completed \((\d+)\):\s*(.*)$/)
  const groupedAgents = grouped === null
    ? []
    : [...grouped[2].matchAll(/\*\*(.+?)\*\*/g)].map((match) => match[1]!)
  const status: KernelSubagentStatus = single?.[2] === 'failed'
    ? 'failed'
    : single?.[2] === 'paused'
      ? 'paused'
      : 'completed'
  const agent = single?.[3] ?? (
    grouped === null
      ? 'Subagent'
      : groupedAgents.length > 0 ? groupedAgents.join('、') : `${grouped[1]} 个 Subagent`
  )
  const taskKind = single?.[1] === 'Detached foreground task'
    ? '已分离的前台任务'
    : grouped === null
      ? '后台任务结果'
      : '后台任务完成'
  const taskInfo = single?.[4] ?? ''

  return {
    index: 0,
    agent: limitedSubagentText(agent),
    status,
    task: limitedSubagentText(`${taskKind}${taskInfo}`),
    currentTool: null,
    currentPath: null,
    toolCount: 0,
    turnCount: 0,
    tokens: 0,
    durationMs: 0,
    error: null,
    finalOutput: nullableLimitedSubagentText(text)
  }
}

function projectSubagentRun(argsValue: unknown, detailsValue: unknown): KernelSubagentRun | null {
  const args = parseRecordValue(argsValue)
  if (args !== null && typeof args.action === 'string') return null
  const details = parseRecordValue(detailsValue)
  const isSubagent = details !== null && (
    details.mode === 'single' ||
    details.mode === 'parallel' ||
    details.mode === 'chain' ||
    details.mode === 'management'
  )
  const hasSubagentArgs = args !== null && (
    typeof args.agent === 'string' ||
    Array.isArray(args.tasks) ||
    Array.isArray(args.chain)
  )
  if (!isSubagent && !hasSubagentArgs) return null
  if (details?.mode === 'management') return null

  const mode = details?.mode === 'parallel' || details?.mode === 'chain' || details?.mode === 'single'
    ? details.mode
    : Array.isArray(args?.tasks) ? 'parallel' : Array.isArray(args?.chain) ? 'chain' : 'single'
  const asyncId = stringValue(details?.asyncId)
  const fallbackStatus: KernelSubagentStatus = asyncId === null ? 'pending' : 'detached'
  const participants = mergeSubagentParticipants(
    participantsFromArgs(args, fallbackStatus),
    participantsFromDetails(details)
  )

  return {
    mode,
    runId: stringValue(details?.runId),
    asyncId,
    participants
  }
}

function participantsFromArgs(
  args: Record<string, unknown> | null,
  status: KernelSubagentStatus
): KernelSubagentParticipant[] {
  if (args === null) return []
  if (Array.isArray(args.tasks)) {
    const participants: KernelSubagentParticipant[] = []
    for (const value of args.tasks) {
      const task = parseRecordValue(value)
      if (task === null) continue
      const count = integerValue(task.count) ?? 1
      for (let repeatIndex = 0; repeatIndex < Math.min(count, 32); repeatIndex += 1) {
        participants.push(emptySubagentParticipant(
          participants.length,
          stringValue(task.agent) ?? 'subagent',
          stringValue(task.task) ?? '',
          status
        ))
      }
    }
    return participants
  }
  if (Array.isArray(args.chain)) {
    return args.chain.flatMap((value, index) => {
      const step = parseRecordValue(value)
      return step === null ? [] : [
        emptySubagentParticipant(
          index,
          stringValue(step.agent) ?? 'subagent',
          stringValue(step.task) ?? stringValue(step.prompt) ?? '',
          status
        )
      ]
    })
  }
  if (typeof args.agent === 'string') {
    return [emptySubagentParticipant(0, args.agent, stringValue(args.task) ?? '', status)]
  }
  return []
}

function participantsFromDetails(
  details: Record<string, unknown> | null
): KernelSubagentParticipant[] {
  if (details === null) return []
  const progressValues = Array.isArray(details.progress) ? details.progress : []
  const resultValues = Array.isArray(details.results) ? details.results : []
  const indexes = new Set<number>()
  for (const [arrayIndex, value] of progressValues.entries()) {
    const item = parseRecordValue(value)
    if (item !== null) indexes.add(integerValue(item.index) ?? arrayIndex)
  }
  for (const [arrayIndex, value] of resultValues.entries()) {
    const item = parseRecordValue(value)
    if (item !== null) indexes.add(integerValue(item.index) ?? arrayIndex)
  }

  return [...indexes].sort((left, right) => left - right).map((index) => {
    const progress = progressValues
      .map(parseRecordValue)
      .find((item, arrayIndex) => item !== null && (integerValue(item.index) ?? arrayIndex) === index) ?? null
    const result = resultValues
      .map(parseRecordValue)
      .find((item, arrayIndex) => item !== null && (integerValue(item.index) ?? arrayIndex) === index) ?? null
    const status = subagentStatus(progress, result)
    return {
      index,
      agent: stringValue(progress?.agent) ?? stringValue(result?.agent) ?? 'subagent',
      status,
      task: limitedSubagentText(stringValue(progress?.task) ?? stringValue(result?.task) ?? ''),
      currentTool: stringValue(progress?.currentTool),
      currentPath: stringValue(progress?.currentPath),
      toolCount: nonNegativeNumber(progress?.toolCount) ?? nonNegativeNumber(result?.progressSummary, 'toolCount') ?? 0,
      turnCount: nonNegativeNumber(progress?.turnCount) ?? nonNegativeNumber(result?.usage, 'turns') ?? 0,
      tokens: nonNegativeNumber(progress?.tokens) ??
        ((nonNegativeNumber(result?.usage, 'input') ?? 0) + (nonNegativeNumber(result?.usage, 'output') ?? 0)),
      durationMs: nonNegativeNumber(progress?.durationMs) ??
        nonNegativeNumber(result?.progressSummary, 'durationMs') ?? 0,
      error: nullableLimitedSubagentText(stringValue(progress?.error) ?? stringValue(result?.error)),
      finalOutput: nullableLimitedSubagentText(stringValue(result?.finalOutput))
    }
  })
}

function mergeSubagentParticipants(
  fallback: KernelSubagentParticipant[],
  projected: KernelSubagentParticipant[]
): KernelSubagentParticipant[] {
  if (projected.length === 0) return fallback
  const projectedByIndex = new Map(projected.map((participant) => [participant.index, participant]))
  const merged = fallback.map((participant) => {
    const current = projectedByIndex.get(participant.index)
    if (current === undefined) return participant
    projectedByIndex.delete(participant.index)
    return {
      ...participant,
      ...current,
      task: current.task || participant.task,
      agent: current.agent === 'subagent' ? participant.agent : current.agent
    }
  })
  return [...merged, ...projectedByIndex.values()].sort((left, right) => left.index - right.index)
}

function emptySubagentParticipant(
  index: number,
  agent: string,
  task: string,
  status: KernelSubagentStatus
): KernelSubagentParticipant {
  return {
    index,
    agent: limitedSubagentText(agent),
    status,
    task: limitedSubagentText(task),
    currentTool: null,
    currentPath: null,
    toolCount: 0,
    turnCount: 0,
    tokens: 0,
    durationMs: 0,
    error: null,
    finalOutput: null
  }
}

function subagentStatus(
  progress: Record<string, unknown> | null,
  result: Record<string, unknown> | null
): KernelSubagentStatus {
  const progressStatus = stringValue(progress?.status)
  if (
    progressStatus === 'pending' ||
    progressStatus === 'running' ||
    progressStatus === 'completed' ||
    progressStatus === 'failed' ||
    progressStatus === 'paused' ||
    progressStatus === 'detached'
  ) return progressStatus
  if (result?.detached === true) return 'detached'
  if (stringValue(result?.error) !== null) return 'failed'
  const exitCode = numberValue(result?.exitCode)
  if (exitCode !== null) return exitCode === 0 ? 'completed' : 'failed'
  return 'pending'
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

function nonNegativeNumber(value: unknown, key?: string): number | null {
  const target = key === undefined ? value : isRecord(value) ? value[key] : undefined
  return typeof target === 'number' && Number.isFinite(target) && target >= 0 ? target : null
}

function integerValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

function limitedSubagentText(value: string): string {
  return value.length <= MAX_SUBAGENT_TEXT_CHARS
    ? value
    : `${value.slice(0, MAX_SUBAGENT_TEXT_CHARS)}…`
}

function nullableLimitedSubagentText(value: string | null): string | null {
  return value === null ? null : limitedSubagentText(value)
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
