import type {
  KernelConversationEntry,
  KernelSubagentCoordination,
  KernelSubagentNoticeEntry,
  KernelSubagentOutputReference,
  KernelSubagentParticipant,
  KernelSubagentRun,
  KernelSubagentStatus,
  KernelSubagentUsage
} from '../../shared/kernel-contract.ts'
import { isRecord } from '../utils/guards.ts'

const MAX_DISPLAY_CHARS = 30_000
const MAX_SUBAGENT_TEXT_CHARS = 6_000
const MAX_AGENT_NAME_CHARS = 256
const MAX_REASON_CHARS = 128
const MAX_CUSTOM_ID_CHARS = 256

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

export function isSubagentToolName(name: string): boolean {
  return name.trim().toLowerCase().split(/[.:/]/u).at(-1) === 'subagent'
}

export function projectSubagentRun(
  argsValue: unknown,
  detailsValue: unknown
): KernelSubagentRun | null {
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

/**
 * Project subagent-owned custom messages.
 * Returns updated entries when the custom type is subagent-owned; null otherwise.
 */
export function projectSubagentCustomMessage(
  entries: KernelConversationEntry[],
  args: {
    customType: string | null
    content: unknown
    details: unknown
    display: unknown
    timestamp: number
    historicalIdentity?: string
  }
): KernelConversationEntry[] | null {
  const { customType, content, details, display, timestamp, historicalIdentity } = args

  if (customType === SUBAGENT_SLASH_RESULT_TYPE) {
    const requestId = slashRequestId(details)
    const text = limitText(textFromContent(content)).text
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

  // Non-display customs are not claimed here so the caller can apply the shared
  // display gate before advisor / other projections.
  if (display !== true) return null

  if (customType === SUBAGENT_WATCHDOG_TYPE) {
    const warning = projectWatchdogWarning(details)
    if (warning === null) return entries
    const entry: KernelSubagentNoticeEntry = {
      id: historicalIdentity === undefined
        ? `subagent-notice:watchdog:${timestamp}`
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

  if (customType === null || !(customType in SUBAGENT_NOTICE_TYPES)) return null

  const text = limitText(textFromContent(content)).text
  if (text.trim().length === 0) return entries
  const noticeType = SUBAGENT_NOTICE_TYPES[customType as keyof typeof SUBAGENT_NOTICE_TYPES]
  const projectedCoordination = projectSubagentCoordination(
    noticeType,
    details,
    text
  )
  const completion = noticeType === 'completion'
    ? projectSubagentCompletion(text)
    : undefined
  const entry: KernelSubagentNoticeEntry = {
    id: projectedCoordination?.id ?? (historicalIdentity === undefined
      ? `subagent-notice:${customType}:${timestamp}`
      : `subagent-notice:${historicalIdentity}`),
    kind: 'subagent-notice',
    noticeType,
    text: projectedCoordination?.text ?? (
      completion === undefined
        ? text
        : completion.error ?? completion.finalOutput ?? ''
    ),
    timestamp,
    ...(completion === undefined ? {} : { completion }),
    ...(projectedCoordination === null
      ? {}
      : { coordination: projectedCoordination.coordination })
  }
  return upsertSubagentNotice(entries, entry)
}

export function resolveSubagentSupervisorRequest(
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
    const agent = boundedStringValue(details.agent, MAX_AGENT_NAME_CHARS)
    const participantIndex = integerValue(details.childIndex)
    if (requestId === null || runId === null || agent === null || participantIndex === null) {
      return null
    }
    const reason = boundedStringValue(details.reason, MAX_REASON_CHARS)
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
  const agent = boundedStringValue(event.agent, MAX_AGENT_NAME_CHARS)
  if (runId === null || agent === null) return null
  const participantIndex = event.index === undefined ? null : integerValue(event.index)
  if (event.index !== undefined && participantIndex === null) return null
  const reason = boundedStringValue(event.reason, MAX_REASON_CHARS)
  const message = boundedStringValue(event.message, MAX_SUBAGENT_TEXT_CHARS)
  const recentFailure = boundedStringValue(event.recentFailureSummary, MAX_SUBAGENT_TEXT_CHARS)
  const text = [message, recentFailure].filter((value): value is string => value !== null).join('\n') ||
    `${agent} 需要主代理关注。`
  const eventType = boundedStringValue(event.type, MAX_REASON_CHARS) ?? 'needs_attention'
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
    : grouped !== null
      ? '后台任务批次'
      : agent.startsWith('parallel:')
        ? '并行后台任务'
        : agent.startsWith('chain:')
          ? '链式后台任务'
          : '后台任务'
  const taskInfo = single?.[4] ?? ''
  const result = projectSubagentResultText(text.split('\n').slice(1).join('\n'))
  const resultText = result.text === null || result.text === '(no output)'
    ? null
    : result.text

  return {
    index: 0,
    agent: limitedSubagentText(agent),
    status,
    task: limitedSubagentText(`${taskKind}${taskInfo}`),
    model: null,
    usage: null,
    currentTool: null,
    currentPath: null,
    toolCount: 0,
    turnCount: 0,
    tokens: 0,
    durationMs: 0,
    error: status === 'failed' ? nullableLimitedSubagentText(resultText) : null,
    finalOutput: status === 'failed' ? null : nullableLimitedSubagentText(resultText),
    outputReferences: result.outputReferences
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
    const usage = projectSubagentUsage(result?.usage)
    const resultText = projectSubagentResultText(stringValue(result?.finalOutput) ?? '')
    const structuredOutputReference = projectStructuredOutputReference(
      result?.outputReference,
      stringValue(progress?.agent) ?? stringValue(result?.agent)
    )
    return {
      index,
      agent: stringValue(progress?.agent) ?? stringValue(result?.agent) ?? 'subagent',
      status,
      task: limitedSubagentText(stringValue(progress?.task) ?? stringValue(result?.task) ?? ''),
      model: nullableLimitedSubagentText(nonEmptyStringValue(result?.model)),
      usage,
      currentTool: stringValue(progress?.currentTool),
      currentPath: stringValue(progress?.currentPath),
      toolCount: nonNegativeNumber(progress?.toolCount) ?? nonNegativeNumber(result?.progressSummary, 'toolCount') ?? 0,
      turnCount: nonNegativeNumber(progress?.turnCount) ?? nonNegativeNumber(result?.usage, 'turns') ?? 0,
      tokens: nonNegativeNumber(progress?.tokens) ??
        (usage === null ? 0 : usage.inputTokens + usage.outputTokens),
      durationMs: nonNegativeNumber(progress?.durationMs) ??
        nonNegativeNumber(result?.progressSummary, 'durationMs') ?? 0,
      error: nullableLimitedSubagentText(stringValue(progress?.error) ?? stringValue(result?.error)),
      finalOutput: nullableLimitedSubagentText(resultText.text),
      outputReferences: mergeSubagentOutputReferences(
        structuredOutputReference === null ? [] : [structuredOutputReference],
        resultText.outputReferences
      )
    }
  })
}

function projectSubagentUsage(value: unknown): KernelSubagentUsage | null {
  const usage = parseRecordValue(value)
  if (usage === null) return null
  const inputTokens = nonNegativeSafeInteger(usage.input)
  const outputTokens = nonNegativeSafeInteger(usage.output)
  const cacheReadTokens = nonNegativeSafeInteger(usage.cacheRead)
  const cacheWriteTokens = nonNegativeSafeInteger(usage.cacheWrite)
  const costUsd = nonNegativeNumber(usage.cost)
  if (
    inputTokens === null ||
    outputTokens === null ||
    cacheReadTokens === null ||
    cacheWriteTokens === null ||
    costUsd === null
  ) return null
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd
  }
}

function projectSubagentResultText(value: string): {
  text: string | null
  outputReferences: KernelSubagentOutputReference[]
} {
  const outputReferences: KernelSubagentOutputReference[] = []
  const contentLines: string[] = []
  for (const line of value.split('\n')) {
    const trimmed = line.trim()
    if (/^(Session|Session file|Session share error):\s+/.test(trimmed)) continue
    const reference = projectTextOutputReference(trimmed)
    if (reference !== null) {
      outputReferences.push(reference)
      continue
    }
    contentLines.push(line)
  }
  const text = contentLines.join('\n').trim()
  return {
    text: text.length === 0 ? null : text,
    outputReferences: mergeSubagentOutputReferences([], outputReferences)
  }
}

function projectTextOutputReference(value: string): KernelSubagentOutputReference | null {
  const match = value.match(
    /^(?:(.+?):\s+)?Output saved to:\s+(.+)\s+\((\d+(?:\.\d+)?\s+(?:B|KB|MB|GB|TB)),\s+(\d+)\s+lines?\)\.\s+Read this file if needed\.$/
  )
  const path = match?.[2]
  if (
    match === null ||
    !isBoundedString(path, MAX_SUBAGENT_TEXT_CHARS, true) ||
    !path.startsWith('/')
  ) return null
  const lines = Number(match[4])
  if (!Number.isSafeInteger(lines) || lines < 0) return null
  return {
    agent: nullableLimitedSubagentText(nonEmptyStringValue(match[1])),
    path,
    sizeLabel: match[3]!,
    lines
  }
}

function projectStructuredOutputReference(
  value: unknown,
  agent: string | null
): KernelSubagentOutputReference | null {
  const reference = parseRecordValue(value)
  if (reference === null) return null
  const path = reference.path
  const bytes = nonNegativeSafeInteger(reference.bytes)
  const lines = nonNegativeSafeInteger(reference.lines)
  if (
    !isBoundedString(path, MAX_SUBAGENT_TEXT_CHARS, true) ||
    !path.startsWith('/') ||
    bytes === null ||
    lines === null
  ) return null
  return {
    agent: nullableLimitedSubagentText(nonEmptyStringValue(agent)),
    path,
    sizeLabel: formatSubagentByteSize(bytes),
    lines
  }
}

function formatSubagentByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB'] as const
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`
}

function mergeSubagentOutputReferences(
  first: KernelSubagentOutputReference[],
  second: KernelSubagentOutputReference[]
): KernelSubagentOutputReference[] {
  const merged: KernelSubagentOutputReference[] = []
  const identities = new Set<string>()
  for (const reference of [...first, ...second]) {
    const identity = JSON.stringify([reference.agent, reference.path])
    if (identities.has(identity)) continue
    identities.add(identity)
    merged.push(reference)
  }
  return merged
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
    model: null,
    usage: null,
    currentTool: null,
    currentPath: null,
    toolCount: 0,
    turnCount: 0,
    tokens: 0,
    durationMs: 0,
    error: null,
    finalOutput: null,
    outputReferences: []
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

function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .filter((item) => isRecord(item) && item.type === 'text')
    .map((item) => stringValue(item.text) ?? '')
    .join('\n')
}

function limitText(value: string): { text: string; truncated: boolean } {
  if (value.length <= MAX_DISPLAY_CHARS) return { text: value, truncated: false }
  return {
    text: `${value.slice(0, MAX_DISPLAY_CHARS)}\n… output truncated for display`,
    truncated: true
  }
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

function boundedStringValue(value: unknown, maxChars: number): string | null {
  return isBoundedString(value, maxChars, true) ? value : null
}

function nonNegativeNumber(value: unknown, key?: string): number | null {
  const target = key === undefined ? value : isRecord(value) ? value[key] : undefined
  return typeof target === 'number' && Number.isFinite(target) && target >= 0 ? target : null
}

function nonNegativeSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
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

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function nonEmptyStringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
