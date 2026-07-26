import { memo, useLayoutEffect, useRef, useState } from 'react'

import type {
  KernelConversationEntry,
  KernelErrorEntry,
  KernelMessageAttachment,
  KernelMessageEntry,
  KernelThinkingEntry,
  KernelToolEntry
} from '../../../../shared/kernel-contract'
import { MarkdownMessage } from './MarkdownMessage'
import type { ToolDisplayDensity } from '../../tool-display-density'

export type ConversationTurn = {
  id: string
  entries: KernelConversationEntry[]
}

type CommentaryEntry = KernelMessageEntry & {
  role: 'assistant'
  phase: 'commentary'
}

type ProcessEntry = KernelThinkingEntry | KernelToolEntry | CommentaryEntry
type NarrativeEntry = KernelThinkingEntry | CommentaryEntry

type LiveChunk =
  | { id: string; kind: 'process'; entries: ProcessEntry[] }
  | { id: string; kind: 'entry'; entry: KernelMessageEntry | KernelErrorEntry }

type ToolFileOperation = 'read' | 'modify'

type ToolFileInfo = {
  operation: ToolFileOperation
  path: string
  detail: string | null
}

type ToolFileReference = ToolFileInfo & {
  entry: KernelToolEntry
}

export const CompletedTurn = memo(function CompletedTurn({
  turn,
  toolDisplayDensity,
  runElapsedMs,
  thinkingElapsedByEntryId
}: {
  turn: ConversationTurn
  toolDisplayDensity: ToolDisplayDensity
  runElapsedMs: number | null
  thinkingElapsedByEntryId: ReadonlyMap<string, number>
}): React.JSX.Element {
  const { user, responseEntries } = splitTurn(turn)
  const processEntries = responseEntries.filter(isProcessEntry)
  const answerEntries = responseEntries.filter(
    (entry): entry is KernelMessageEntry | KernelErrorEntry =>
      (entry.kind === 'message' && entry.phase !== 'commentary') || entry.kind === 'error'
  )

  return (
    <section className="conversation-run completed" data-conversation-turn-id={turn.id}>
      {user ? <MessageEntry entry={user} promptAnchor /> : null}
      <div className="assistant-run">
        {processEntries.length > 0 ? (
          <CompletedProcess
            entries={processEntries}
            toolDisplayDensity={toolDisplayDensity}
            runElapsedMs={runElapsedMs}
            thinkingElapsedByEntryId={thinkingElapsedByEntryId}
          />
        ) : null}
        {answerEntries.map((entry) => (
          <TimelineContentEntry entry={entry} key={entry.id} />
        ))}
      </div>
    </section>
  )
}, sameTurnEntries)

export const LiveTurn = memo(function LiveTurn({
  turn,
  toolDisplayDensity,
  thinkingElapsedByEntryId
}: {
  turn: ConversationTurn
  toolDisplayDensity: ToolDisplayDensity
  thinkingElapsedByEntryId: ReadonlyMap<string, number>
}): React.JSX.Element {
  const { user, responseEntries } = splitTurn(turn)
  const chunks = buildLiveChunks(responseEntries)

  return (
    <section className="conversation-run active" data-conversation-turn-id={turn.id}>
      {user ? <MessageEntry entry={user} promptAnchor /> : null}
      <div className="assistant-run live">
        {chunks.map((chunk) =>
          chunk.kind === 'process' ? (
            <LiveProcess
              entries={chunk.entries}
              toolDisplayDensity={toolDisplayDensity}
              thinkingElapsedByEntryId={thinkingElapsedByEntryId}
              key={chunk.id}
            />
          ) : (
            <TimelineContentEntry entry={chunk.entry} key={chunk.id} />
          )
        )}
      </div>
    </section>
  )
}, sameTurnEntries)

function CompletedProcess({
  entries,
  toolDisplayDensity,
  runElapsedMs,
  thinkingElapsedByEntryId
}: {
  entries: ProcessEntry[]
  toolDisplayDensity: ToolDisplayDensity
  runElapsedMs: number | null
  thinkingElapsedByEntryId: ReadonlyMap<string, number>
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)

  return (
    <details
      className="completed-process"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="completed-process-summary">
        <span className="completed-process-title">
          已处理{runElapsedMs === null ? '' : ` ${formatDuration(runElapsedMs)}`}
        </span>
        <span className="completed-process-expand" aria-hidden="true" />
      </summary>
      {expanded ? (
        <div className="completed-process-body">
          <ProcessSequence
            entries={entries}
            toolDisplayDensity={toolDisplayDensity}
            thinkingElapsedByEntryId={thinkingElapsedByEntryId}
          />
        </div>
      ) : null}
    </details>
  )
}

function LiveProcess({
  entries,
  toolDisplayDensity,
  thinkingElapsedByEntryId
}: {
  entries: ProcessEntry[]
  toolDisplayDensity: ToolDisplayDensity
  thinkingElapsedByEntryId: ReadonlyMap<string, number>
}): React.JSX.Element {
  const activeEntry = currentRunningEntry(entries)
  if (toolDisplayDensity === 'detailed') {
    return (
      <ProcessSequence
        activeEntryId={activeEntry?.id ?? null}
        entries={entries}
        toolDisplayDensity={toolDisplayDensity}
        thinkingElapsedByEntryId={thinkingElapsedByEntryId}
        pinThinking
      />
    )
  }

  const narrativeEntries = toolDisplayDensity === 'standard'
    ? entries.filter(
        (entry): entry is NarrativeEntry =>
          entry.kind === 'message' || (entry.kind === 'thinking' && !entry.summary)
      )
    : []
  const narrativeIds = new Set(narrativeEntries.map((entry) => entry.id))
  const detailEntries = entries.filter((entry) => !narrativeIds.has(entry.id))
  const narrativeIsCurrent = activeEntry !== undefined && narrativeIds.has(activeEntry.id)

  return (
    <ol
      className={`process-step-list live-process-condensed tool-density-${toolDisplayDensity}`}
      aria-label="当前工作过程"
    >
      {narrativeEntries.map((entry) =>
        entry.kind === 'thinking' ? (
          <ThinkingStep
            active={entry.id === activeEntry?.id}
            entry={entry}
            elapsedMs={thinkingElapsedByEntryId.get(entry.id) ?? null}
            key={entry.id}
            pinned
          />
        ) : (
          <CommentaryStep entry={entry} key={entry.id} />
        )
      )}
      {!narrativeIsCurrent ? (
        <LiveProcessStatus
          activeEntryId={activeEntry?.id ?? null}
          detailEntries={detailEntries}
          entries={entries}
          toolDisplayDensity={toolDisplayDensity}
          thinkingElapsedByEntryId={thinkingElapsedByEntryId}
        />
      ) : null}
    </ol>
  )
}

function ProcessSequence({
  activeEntryId = null,
  entries,
  toolDisplayDensity,
  thinkingElapsedByEntryId,
  pinThinking = false
}: {
  activeEntryId?: string | null
  entries: ProcessEntry[]
  toolDisplayDensity: ToolDisplayDensity
  thinkingElapsedByEntryId: ReadonlyMap<string, number>
  pinThinking?: boolean
}): React.JSX.Element {
  const tools = entries.filter((entry): entry is KernelToolEntry => entry.kind === 'tool')
  const firstToolId = tools[0]?.id ?? null
  return (
    <ol className={`process-step-list tool-density-${toolDisplayDensity}`} aria-label="工作过程">
      {entries.map((entry) => {
        if (entry.kind === 'thinking') {
          return (
            <ThinkingStep
              active={entry.id === activeEntryId}
              entry={entry}
              elapsedMs={thinkingElapsedByEntryId.get(entry.id) ?? null}
              pinned={pinThinking}
              key={entry.id}
            />
          )
        }
        if (entry.kind === 'message') {
          return <CommentaryStep entry={entry} key={entry.id} />
        }
        if (toolDisplayDensity === 'compact') {
          return entry.id === firstToolId
            ? <ToolGroupSummary entries={tools} key={`tools:${entry.id}`} />
            : null
        }
        return (
          <ToolStep
            entry={entry}
            detailed={toolDisplayDensity === 'detailed'}
            key={entry.id}
          />
        )
      })}
    </ol>
  )
}

function LiveProcessStatus({
  activeEntryId,
  detailEntries,
  entries,
  toolDisplayDensity,
  thinkingElapsedByEntryId
}: {
  activeEntryId: string | null
  detailEntries: ProcessEntry[]
  entries: ProcessEntry[]
  toolDisplayDensity: ToolDisplayDensity
  thinkingElapsedByEntryId: ReadonlyMap<string, number>
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const status = <ThinkingStatus label={liveProcessStatusLabel(entries)} />
  if (detailEntries.length === 0) {
    return <li className="live-process-status-row">{status}</li>
  }
  return (
    <li className="live-process-status-row">
      <details
        className="live-process-status"
        open={expanded}
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary className="live-process-status-summary">
          {status}
          <span className="process-step-expand" aria-hidden="true" />
        </summary>
        {expanded ? (
          <div className="live-process-status-detail">
            <ProcessSequence
              activeEntryId={activeEntryId}
              entries={detailEntries}
              toolDisplayDensity={toolDisplayDensity}
              thinkingElapsedByEntryId={thinkingElapsedByEntryId}
            />
          </div>
        ) : null}
      </details>
    </li>
  )
}

function CommentaryStep({ entry }: { entry: CommentaryEntry }): React.JSX.Element {
  return (
    <li className={`process-step commentary${entry.streaming ? ' running' : ' completed'}`}>
      <MessageEntry entry={entry} />
    </li>
  )
}

function ToolGroupSummary({ entries }: { entries: KernelToolEntry[] }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const running = entries.some((entry) => entry.status === 'pending' || entry.status === 'running')
  const failed = entries.some((entry) => entry.status === 'error')
  return (
    <li className={`tool-group-summary${running ? ' running' : ''}${failed ? ' failed' : ''}`}>
      <details
        className="tool-group-details"
        open={expanded}
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary className="tool-group-summary-row">
          <span className="process-step-text">{summarizeTools(entries)}</span>
          <span className="process-step-meta">
            {running ? '进行中' : failed ? '部分失败' : '完成'}
          </span>
          <span className="process-step-expand" aria-hidden="true" />
        </summary>
        {expanded ? (
          <ol className="tool-group-entries" aria-label="工具调用">
            {entries.map((entry) => (
              <ToolStep entry={entry} detailed={false} key={entry.id} />
            ))}
          </ol>
        ) : null}
      </details>
    </li>
  )
}

function ThinkingStep({
  active = false,
  entry,
  elapsedMs,
  pinned = false
}: {
  active?: boolean
  entry: KernelThinkingEntry
  elapsedMs: number | null
  pinned?: boolean
}): React.JSX.Element {
  const status = active ? 'running' : 'completed'
  const hasText = entry.text.trim().length > 0
  const [expanded, setExpanded] = useState(pinned || active)
  const previousActiveRef = useRef(active)
  useLayoutEffect(() => {
    const wasActive = previousActiveRef.current
    if (!pinned) {
      if (active && !wasActive) setExpanded(true)
      if (!active && wasActive) setExpanded(false)
    }
    previousActiveRef.current = active
  }, [active, pinned])
  return (
    <li className={`process-step thinking ${entry.summary ? 'summary' : 'narrative'} ${status}`}>
      <details
        className="process-thinking"
        open={expanded}
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary className="process-thinking-summary">
          <span className="process-thinking-title">
            {active
              ? <ThinkingStatus label="正在思考" />
              : elapsedMs === null ? '思考' : `思考了 ${formatDuration(elapsedMs)}`}
          </span>
          <span className="process-thinking-expand" aria-hidden="true" />
        </summary>
        {expanded && hasText ? (
          <div className="process-thinking-detail">
            <MarkdownMessage text={entry.text} streaming={active} />
          </div>
        ) : null}
      </details>
    </li>
  )
}

function ToolStep({
  entry,
  detailed
}: {
  entry: KernelToolEntry
  detailed: boolean
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const status = activityStatus(entry)
  const file = toolFileInfo(entry)
  const target = file?.path ?? toolTarget(entry)
  const detail = entry.output || entry.details
  if (!detailed) {
    const args = parseToolArgs(entry.args)
    const command = compactToolName(entry.name) === 'bash' && args !== null
      ? stringArgument(args, ['command'])
      : null
    if (command !== null) {
      return (
        <li className={`process-step tool standard ${status}`}>
          <details
            className="process-standard-tool"
            open={expanded}
            onToggle={(event) => setExpanded(event.currentTarget.open)}
          >
            <summary className="process-step-summary tool-standard-summary standard-tool-summary">
              <span className="process-step-text">
                {entry.status === 'error'
                  ? '运行失败'
                  : entry.status === 'success' ? '已运行' : '正在运行'}{' '}
                {compactTarget(command)}
              </span>
              {entry.status === 'success' ? null : (
                <span className="process-step-meta">{toolStatusLabel(entry)}</span>
              )}
              <span className="process-step-expand" aria-hidden="true" />
            </summary>
            {expanded ? (
              <div className="standard-tool-detail">
                <pre>{command}</pre>
              </div>
            ) : null}
          </details>
        </li>
      )
    }
    return (
      <li className={`process-step tool standard ${status}`}>
        <details
          className="process-standard-tool"
          open={expanded}
          onToggle={(event) => setExpanded(event.currentTarget.open)}
        >
          <summary className="process-step-summary tool-standard-summary standard-tool-summary">
            <span className="process-step-text">
              {toolActivityPrefix(entry, file)}{' '}
              {file ? <FileReference file={{ ...file, entry }} basenameOnly /> : target}
            </span>
            {entry.status === 'success' ? null : (
              <span className="process-step-meta">{toolStatusLabel(entry)}</span>
            )}
            <span className="process-step-expand" aria-hidden="true" />
          </summary>
          {expanded ? <ToolDetailContent entry={entry} detail={detail} /> : null}
        </details>
      </li>
    )
  }
  return <DetailedToolStep entry={entry} file={file} target={target} detail={detail} status={status} />
}

function DetailedToolStep({
  entry,
  file,
  target,
  detail,
  status
}: {
  entry: KernelToolEntry
  file: ToolFileInfo | null
  target: string
  detail: string
  status: ReturnType<typeof activityStatus>
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(true)
  return (
    <li className={`process-step tool detailed ${status}`}>
      <details
        className="process-tool-details"
        open={expanded}
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary className="process-step-summary">
          <span className="process-step-tool">{compactToolName(entry.name)}</span>
          <span className="process-step-text">
            {toolActivityPrefix(entry, file)}{' '}
            {file ? <FileReference file={{ ...file, entry }} basenameOnly /> : target}
          </span>
          <span className="process-step-meta">
            {entry.durationMs === null ? toolStatusLabel(entry) : formatDuration(entry.durationMs)}
          </span>
          <span className="process-step-expand" aria-hidden="true" />
        </summary>
        {expanded ? <ToolDetailContent entry={entry} detail={detail} /> : null}
      </details>
    </li>
  )
}

function ToolDetailContent({
  entry,
  detail
}: {
  entry: KernelToolEntry
  detail: string
}): React.JSX.Element {
  return (
    <div className="process-tool-detail">
      {entry.args ? (
        <section>
          <span>输入</span>
          <pre>{entry.args}</pre>
        </section>
      ) : null}
      {detail ? (
        <section>
          <span>{entry.output ? '输出' : '详情'}</span>
          <pre>{detail}</pre>
        </section>
      ) : <p>等待工具输出</p>}
      {entry.truncated ? <small>输出已截断</small> : null}
    </div>
  )
}

function FileReference({
  file,
  basenameOnly = false
}: {
  file: ToolFileReference
  basenameOnly?: boolean
}): React.JSX.Element {
  const operation = file.operation === 'read' ? '读取' : '修改'
  const status = toolStatusLabel(file.entry)
  const duration = file.entry.durationMs === null ? null : formatDuration(file.entry.durationMs)
  return (
    <span
      className={`tool-file-reference ${file.operation}`}
      aria-label={`${operation}文件 ${file.path}`}
    >
      <span className="tool-file-reference-label">
        {basenameOnly ? fileBasename(file.path) : compactTarget(file.path)}
      </span>
      <span className="tool-file-tooltip" role="tooltip">
        <strong>{fileBasename(file.path)}</strong>
        <code>{file.path}</code>
        <span>{operation}{file.detail ? ` · ${file.detail}` : ''}</span>
        <span>{status}{duration ? ` · ${duration}` : ''}</span>
      </span>
    </span>
  )
}

function TimelineContentEntry({
  entry
}: {
  entry: KernelMessageEntry | KernelErrorEntry
}): React.JSX.Element | null {
  if (entry.kind === 'message') return <MessageEntry entry={entry} />
  return (
    <article className="chat-message error" role="alert">
      <pre>{entry.title}: {entry.message}</pre>
    </article>
  )
}

function MessageEntry({
  entry,
  promptAnchor = false
}: {
  entry: KernelMessageEntry
  promptAnchor?: boolean
}): React.JSX.Element | null {
  const hasText = entry.text.trim().length > 0
  const attachments = entry.attachments ?? []
  const aborted = entry.stopReason === 'aborted'
  if (!hasText && attachments.length === 0 && !entry.error && !entry.streaming && !aborted) return null

  return (
    <div className="conversation-turn" data-user-prompt={promptAnchor ? 'true' : undefined}>
      <MessageAttachments attachments={attachments} role={entry.role} />
      {hasText ? (
        <article className={`chat-message ${entry.role}${entry.streaming ? ' streaming' : ''}`}>
          <MarkdownMessage text={entry.text} streaming={entry.streaming} />
        </article>
      ) : entry.streaming ? (
        <article className="chat-message assistant streaming thinking-placeholder">
          <ThinkingStatus label="正在生成回答" />
        </article>
      ) : null}
      {aborted ? (
        <article className="chat-message aborted" role="status">
          <span>{abortedMessage(entry.error)}</span>
        </article>
      ) : entry.error ? (
        <article className="chat-message error" role="alert">
          <pre>{entry.error}</pre>
        </article>
      ) : null}
    </div>
  )
}
export function MessageAttachments({
  attachments,
  role,
  label = '消息附件'
}: {
  attachments: KernelMessageAttachment[]
  role: KernelMessageEntry['role']
  label?: string
}): React.JSX.Element | null {
  if (attachments.length === 0) return null
  return (
    <ul className={`message-attachment-list ${role}`} aria-label={label}>
      {attachments.map((attachment, index) => (
        <li
          className={`message-attachment ${attachment.type}`}
          data-tooltip={attachment.path}
          data-tooltip-variant="mono"
          key={`${attachment.type}:${attachment.path}:${index}`}
        >
          <span className="message-attachment-kind">
            {attachment.type === 'image' ? '图片' : '文件'}
          </span>
          <span className="message-attachment-name">{attachment.name}</span>
        </li>
      ))}
    </ul>
  )
}

export function ThinkingStatus({ label }: { label: string }): React.JSX.Element {
  return (
    <span className="thinking-status" aria-label={`Pi ${label}`} role="status">
      <span className="thinking-visual" aria-hidden="true">
        <span className="thinking-core" />
      </span>
      <span>{label}</span>
    </span>
  )
}
export function groupConversationTurns(entries: KernelConversationEntry[]): ConversationTurn[] {
  const turns: ConversationTurn[] = []
  let current: ConversationTurn | null = null
  for (const entry of entries.filter(isVisibleEntry)) {
    if (entry.kind === 'message' && entry.role === 'user') {
      if (current !== null) turns.push(current)
      current = { id: entry.id, entries: [entry] }
      continue
    }
    if (current === null) current = { id: `turn:${entry.id}`, entries: [] }
    current.entries.push(entry)
  }
  if (current !== null) turns.push(current)
  return turns
}

function sameTurnEntries(
  previous: {
    turn: ConversationTurn
    toolDisplayDensity: ToolDisplayDensity
    thinkingElapsedByEntryId: ReadonlyMap<string, number>
    runElapsedMs?: number | null
  },
  next: {
    turn: ConversationTurn
    toolDisplayDensity: ToolDisplayDensity
    thinkingElapsedByEntryId: ReadonlyMap<string, number>
    runElapsedMs?: number | null
  }
): boolean {
  if (previous.toolDisplayDensity !== next.toolDisplayDensity) return false
  if (previous.thinkingElapsedByEntryId !== next.thinkingElapsedByEntryId) return false
  if (previous.runElapsedMs !== next.runElapsedMs) return false
  if (previous.turn.entries.length !== next.turn.entries.length) return false
  return previous.turn.entries.every((entry, index) => entry === next.turn.entries[index])
}
function abortedMessage(error: string | null): string {
  const message = error?.trim()
  if (!message || /^Request was aborted\.?$/i.test(message)) return '已中止'
  return `已中止：${message}`
}

export function splitTurn(turn: ConversationTurn): {
  user: KernelMessageEntry | null
  responseEntries: KernelConversationEntry[]
} {
  const first = turn.entries[0]
  if (first?.kind === 'message' && first.role === 'user') {
    return { user: first, responseEntries: turn.entries.slice(1) }
  }
  return { user: null, responseEntries: turn.entries }
}

function buildLiveChunks(entries: KernelConversationEntry[]): LiveChunk[] {
  const chunks: LiveChunk[] = []
  let processEntries: ProcessEntry[] = []
  const flushProcess = (): void => {
    if (processEntries.length === 0) return
    chunks.push({ id: `process:${processEntries[0]!.id}`, kind: 'process', entries: processEntries })
    processEntries = []
  }

  for (const entry of entries) {
    if (isProcessEntry(entry)) {
      processEntries.push(entry)
      continue
    }
    flushProcess()
    if (entry.kind === 'message' || entry.kind === 'error') {
      chunks.push({ id: entry.id, kind: 'entry', entry })
    }
  }
  flushProcess()
  return chunks
}

export function isProcessEntry(entry: KernelConversationEntry): entry is ProcessEntry {
  return entry.kind === 'thinking' ||
    entry.kind === 'tool' ||
    (entry.kind === 'message' && entry.role === 'assistant' && entry.phase === 'commentary')
}

export function hasCurrentRunningEntry(entries: KernelConversationEntry[]): boolean {
  return currentRunningEntry(entries) !== undefined
}

function isVisibleEntry(entry: KernelConversationEntry): boolean {
  if (entry.kind === 'message') {
    return Boolean(entry.text.trim() || entry.attachments?.length || entry.error || entry.streaming)
  }
  if (entry.kind === 'thinking') return Boolean(entry.text.trim() || entry.streaming)
  return true
}

function liveProcessStatusLabel(entries: ProcessEntry[]): string {
  const activeEntry = currentRunningEntry(entries)
  if (activeEntry?.kind === 'thinking') return '正在思考'
  if (activeEntry?.kind === 'message') return '正在继续'
  if (activeEntry?.kind === 'tool') {
    const file = toolFileInfo(activeEntry)
    if (file?.operation === 'read') return `正在阅读 ${fileBasename(file.path)}`
    if (file?.operation === 'modify') return `正在修改 ${fileBasename(file.path)}`
    return compactToolName(activeEntry.name) === 'bash'
      ? '正在运行命令'
      : `正在调用 ${compactToolName(activeEntry.name)}`
  }
  return '正在继续'
}

function currentRunningEntry<T extends KernelConversationEntry>(entries: T[]): T | undefined {
  const runningTool = entries.findLast(
    (entry) => entry.kind === 'tool' && (entry.status === 'pending' || entry.status === 'running')
  )
  if (runningTool !== undefined) return runningTool
  const lastEntry = entries.at(-1)
  return lastEntry !== undefined &&
    (lastEntry.kind === 'message' || lastEntry.kind === 'thinking') &&
    lastEntry.streaming
    ? lastEntry
    : undefined
}

function uniqueToolFiles(tools: KernelToolEntry[]): ToolFileReference[] {
  const files = new Map<string, ToolFileReference>()
  for (const entry of tools) {
    const file = toolFileInfo(entry)
    if (file === null) continue
    files.set(`${file.operation}:${file.path}`, { ...file, entry })
  }
  return [...files.values()]
}

function summarizeTools(tools: KernelToolEntry[]): string {
  const files = uniqueToolFiles(tools)
  const readCount = files.filter((file) => file.operation === 'read').length
  const modifiedCount = files.filter((file) => file.operation === 'modify').length
  const fileToolIds = new Set(
    tools.filter((entry) => toolFileInfo(entry) !== null).map((entry) => entry.id)
  )
  const commandCount = tools.filter(
    (entry) => !fileToolIds.has(entry.id) && compactToolName(entry.name) === 'bash'
  ).length
  const otherToolCount = tools.length - fileToolIds.size - commandCount
  return [
    readCount > 0 ? `读取 ${readCount} 个文件` : null,
    modifiedCount > 0 ? `修改 ${modifiedCount} 个文件` : null,
    commandCount > 0 ? `运行 ${commandCount} 条命令` : null,
    otherToolCount > 0 ? `调用 ${otherToolCount} 个工具` : null
  ].filter((part): part is string => part !== null).join('，') || '处理工具调用'
}

function toolFileInfo(entry: KernelToolEntry): ToolFileInfo | null {
  const name = compactToolName(entry.name)
  const args = parseToolArgs(entry.args)
  if (args === null) return null
  const path = stringArgument(args, ['path', 'file_path'])
  if (path === null) return null

  if (name === 'read' || name === 'read_file') {
    const offset = numericArgument(args.offset)
    const limit = numericArgument(args.limit)
    const start = offset ?? 1
    const detail = offset === null && limit === null
      ? null
      : limit === null ? `从第 ${start} 行开始` : `第 ${start}–${start + limit - 1} 行`
    return { operation: 'read', path, detail }
  }

  if (name === 'edit' || name === 'write' || name === 'write_file' || name === 'apply_patch') {
    let detail: string | null = null
    if (name === 'edit' && Array.isArray(args.edits)) detail = `${args.edits.length} 处修改`
    if ((name === 'write' || name === 'write_file') && typeof args.content === 'string') {
      detail = `${lineCount(args.content)} 行内容`
    }
    return { operation: 'modify', path, detail }
  }

  return null
}

function toolActivityPrefix(entry: KernelToolEntry, file: ToolFileInfo | null): string {
  if (file?.operation === 'read') {
    if (entry.status === 'error') return '阅读失败'
    return entry.status === 'success' ? '已阅读' : '正在阅读'
  }
  if (file?.operation === 'modify') {
    if (entry.status === 'error') return '修改失败'
    return entry.status === 'success' ? '已修改' : '正在修改'
  }
  const name = compactToolName(entry.name)
  if (entry.status === 'error') return `${name} 调用失败 ·`
  return entry.status === 'success' ? `已完成 ${name} ·` : `正在调用 ${name} ·`
}

function activityStatus(entry: KernelToolEntry): 'running' | 'completed' | 'failed' {
  if (entry.status === 'error') return 'failed'
  if (entry.status === 'success') return 'completed'
  return 'running'
}

function toolStatusLabel(entry: KernelToolEntry): string {
  if (entry.status === 'error') return '失败'
  if (entry.status === 'success') return '完成'
  return '运行中'
}

function toolTarget(entry: KernelToolEntry): string {
  const args = parseToolArgs(entry.args)
  if (args !== null) {
    const target = stringArgument(args, ['command', 'path', 'file_path', 'query', 'url'])
    if (target !== null) return compactTarget(target)
  }
  const first = entry.args.split('\n', 1)[0]?.trim()
  if (first && first !== '{' && first !== '[') return compactTarget(first)
  return compactToolName(entry.name) === 'bash' ? '命令' : '相关内容'
}

function parseToolArgs(value: string): Record<string, unknown> | null {
  if (value.trim().length === 0) return null
  try {
    const parsed: unknown = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function stringArgument(args: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    if (typeof args[key] === 'string' && args[key].trim().length > 0) return args[key]
  }
  return null
}

function numericArgument(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function compactTarget(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= 96) return normalized
  return `${normalized.slice(0, 95)}…`
}

function compactToolName(name: string): string {
  const normalized = name.trim().toLowerCase()
  return normalized.split('.').at(-1) || normalized || 'tool'
}

function fileBasename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? path
}

function lineCount(value: string): number {
  if (value.length === 0) return 0
  return value.split('\n').length
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs}ms`
  if (durationMs >= 60_000) {
    const totalSeconds = Math.round(durationMs / 1_000)
    return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`
  }
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`
}
