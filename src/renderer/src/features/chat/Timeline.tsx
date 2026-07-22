import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type {
  KernelConversationEntry,
  KernelErrorEntry,
  KernelMessageEntry,
  KernelThinkingEntry,
  KernelToolEntry,
  RuntimeStatus
} from '../../../../shared/kernel-contract'
import { MarkdownMessage } from './MarkdownMessage'

type TimelineProps = {
  entries: KernelConversationEntry[]
  activeRunStartIndex: number | null
  runtimeStatus: RuntimeStatus
  title?: string
  warning: string | null
}

type ConversationTurn = {
  id: string
  entries: KernelConversationEntry[]
}

type ProcessEntry = KernelThinkingEntry | KernelToolEntry

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

const COMPLETED_TURN_WINDOW_SIZE = 60

export function Timeline({
  entries,
  activeRunStartIndex,
  runtimeStatus,
  title,
  warning
}: TimelineProps): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null)
  const followOutputRef = useRef(true)
  const revealScrollHeightRef = useRef<number | null>(null)
  const [completedTurnWindow, setCompletedTurnWindow] = useState(COMPLETED_TURN_WINDOW_SIZE)
  const {
    completedTurns,
    activeEntries,
    activeTurns,
    hasRunningStep,
    hasVisibleContent
  } = useMemo(() => {
    const boundary = activeRunStartIndex === null
      ? entries.length
      : Math.max(0, Math.min(activeRunStartIndex, entries.length))
    const nextActiveEntries = activeRunStartIndex === null ? [] : entries.slice(boundary)
    return {
      completedTurns: groupConversationTurns(entries.slice(0, boundary)),
      activeEntries: nextActiveEntries,
      activeTurns: groupConversationTurns(nextActiveEntries),
      hasRunningStep: nextActiveEntries.some(isRunningEntry),
      hasVisibleContent: entries.some(isVisibleEntry)
    }
  }, [activeRunStartIndex, entries])
  const visibleCompletedTurns = useMemo(
    () => completedTurns.slice(Math.max(0, completedTurns.length - completedTurnWindow)),
    [completedTurnWindow, completedTurns]
  )
  const hiddenCompletedTurnCount = completedTurns.length - visibleCompletedTurns.length

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (viewport && followOutputRef.current) viewport.scrollTop = viewport.scrollHeight
  }, [entries, activeRunStartIndex])

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const previousScrollHeight = revealScrollHeightRef.current
    if (!viewport || previousScrollHeight === null) return
    viewport.scrollTop += viewport.scrollHeight - previousScrollHeight
    revealScrollHeightRef.current = null
  }, [completedTurnWindow])

  return (
    <div className="conversation-shell">
      {title || warning ? (
        <div className="conversation-header">
          {title ? <strong title={title}>{title}</strong> : null}
          {warning ? <small className="connection-status-warning">{warning}</small> : null}
        </div>
      ) : null}

      <div
        className="conversation-surface stealth-scroll mode-compact"
        ref={viewportRef}
        tabIndex={0}
        onScroll={(event) => {
          const target = event.currentTarget
          followOutputRef.current =
            target.scrollHeight - target.scrollTop - target.clientHeight < 120
        }}
      >
        {hasVisibleContent || runtimeStatus === 'running' ? (
          <div
            className="message-list"
            aria-live={runtimeStatus === 'running' ? 'polite' : 'off'}
            aria-label="对话时间线"
          >
            {hiddenCompletedTurnCount > 0 ? (
              <button
                className="conversation-history-reveal"
                type="button"
                onClick={() => {
                  const viewport = viewportRef.current
                  if (viewport) revealScrollHeightRef.current = viewport.scrollHeight
                  setCompletedTurnWindow((count) => count + COMPLETED_TURN_WINDOW_SIZE)
                }}
              >
                显示更早的 {Math.min(COMPLETED_TURN_WINDOW_SIZE, hiddenCompletedTurnCount)} 轮
              </button>
            ) : null}
            {visibleCompletedTurns.map((turn) => (
              <div className="conversation-virtual-row" key={turn.id}>
                <CompletedTurn turn={turn} />
              </div>
            ))}
            {activeTurns.map((turn) => (
              <div className="conversation-virtual-row" key={`active:${turn.id}`}>
                <LiveTurn turn={turn} />
              </div>
            ))}
            {runtimeStatus === 'running' && !hasRunningStep ? (
              <div className="conversation-virtual-row active-wait-row">
                <article className="chat-message assistant streaming thinking-placeholder">
                  <ThinkingStatus label={activeEntries.length === 0 ? '正在开始' : '正在继续'} />
                </article>
              </div>
            ) : null}
            <div className="conversation-bottom-sentinel" />
          </div>
        ) : (
          <p className="conversation-empty-state" role="status">
            尚无对话内容。
          </p>
        )}
      </div>
    </div>
  )
}

const CompletedTurn = memo(function CompletedTurn({
  turn
}: {
  turn: ConversationTurn
}): React.JSX.Element {
  const { user, responseEntries } = splitTurn(turn)
  const processEntries = responseEntries.filter(isProcessEntry)
  const answerEntries = responseEntries.filter(
    (entry): entry is KernelMessageEntry | KernelErrorEntry =>
      entry.kind === 'message' || entry.kind === 'error'
  )

  return (
    <section className="conversation-run completed">
      {user ? <MessageEntry entry={user} /> : null}
      <div className="assistant-run">
        {processEntries.length > 0 ? <CompletedProcess entries={processEntries} /> : null}
        {answerEntries.map((entry) => (
          <TimelineContentEntry entry={entry} key={entry.id} />
        ))}
      </div>
    </section>
  )
}, sameTurnEntries)

const LiveTurn = memo(function LiveTurn({ turn }: { turn: ConversationTurn }): React.JSX.Element {
  const { user, responseEntries } = splitTurn(turn)
  const chunks = buildLiveChunks(responseEntries)

  return (
    <section className="conversation-run active">
      {user ? <MessageEntry entry={user} /> : null}
      <div className="assistant-run live">
        {chunks.map((chunk) =>
          chunk.kind === 'process' ? (
            <ProcessSequence entries={chunk.entries} key={chunk.id} />
          ) : (
            <TimelineContentEntry entry={chunk.entry} key={chunk.id} />
          )
        )}
      </div>
    </section>
  )
}, sameTurnEntries)

function CompletedProcess({ entries }: { entries: ProcessEntry[] }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const thinkingCount = entries.filter((entry) => entry.kind === 'thinking').length
  const tools = entries.filter((entry): entry is KernelToolEntry => entry.kind === 'tool')
  const files = uniqueToolFiles(tools)
  const readCount = files.filter((file) => file.operation === 'read').length
  const modifiedCount = files.filter((file) => file.operation === 'modify').length
  const summary = [
    thinkingCount > 0 ? `${thinkingCount} 次思考` : null,
    tools.length > 0 ? `${tools.length} 次工具` : null,
    readCount > 0 ? `读取 ${readCount} 个文件` : null,
    modifiedCount > 0 ? `修改 ${modifiedCount} 个文件` : null
  ].filter((part): part is string => part !== null).join(' · ')

  return (
    <details
      className="completed-process"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="completed-process-summary">
        <span className="completed-process-mark" aria-hidden="true" />
        <span className="completed-process-title">工作过程</span>
        <span className="completed-process-meta">{summary}</span>
        <span className="completed-process-expand" aria-hidden="true" />
      </summary>
      {expanded ? (
        <div className="completed-process-body">
          {files.length > 0 ? <ProcessFileOverview files={files} /> : null}
          <ProcessSequence entries={entries} />
        </div>
      ) : null}
    </details>
  )
}

function ProcessFileOverview({ files }: { files: ToolFileReference[] }): React.JSX.Element {
  const readFiles = files.filter((file) => file.operation === 'read')
  const modifiedFiles = files.filter((file) => file.operation === 'modify')
  return (
    <div className="process-file-overview" aria-label="本轮文件操作">
      {readFiles.length > 0 ? (
        <div className="process-file-group">
          <span className="process-file-group-label">读取</span>
          <div className="process-file-list">
            {readFiles.map((file) => (
              <FileReference file={file} key={`read:${file.path}`} />
            ))}
          </div>
        </div>
      ) : null}
      {modifiedFiles.length > 0 ? (
        <div className="process-file-group">
          <span className="process-file-group-label">修改</span>
          <div className="process-file-list">
            {modifiedFiles.map((file) => (
              <FileReference file={file} key={`modify:${file.path}`} />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

function ProcessSequence({ entries }: { entries: ProcessEntry[] }): React.JSX.Element {
  return (
    <ol className="process-step-list" aria-label="工作过程">
      {entries.map((entry) =>
        entry.kind === 'thinking' ? (
          <ThinkingStep entry={entry} key={entry.id} />
        ) : (
          <ToolStep entry={entry} key={entry.id} />
        )
      )}
    </ol>
  )
}

function ThinkingStep({ entry }: { entry: KernelThinkingEntry }): React.JSX.Element {
  const status = entry.streaming ? 'running' : 'completed'
  const hasText = entry.text.trim().length > 0
  return (
    <li className={`process-step thinking ${status}`}>
      <div className="process-step-summary process-step-summary-static">
        <span className="process-step-tool">think</span>
        <span className="process-step-text">{entry.streaming ? '正在思考' : '思考'}</span>
        <span className="process-step-meta">{entry.streaming ? '进行中' : '完成'}</span>
      </div>
      {hasText ? (
        <div className="process-thinking-detail">
          <MarkdownMessage text={entry.text} streaming={entry.streaming} />
        </div>
      ) : null}
    </li>
  )
}

function ToolStep({ entry }: { entry: KernelToolEntry }): React.JSX.Element {
  const status = activityStatus(entry)
  const file = toolFileInfo(entry)
  const target = file?.path ?? toolTarget(entry)
  const detail = entry.output || entry.details
  return (
    <li className={`process-step tool ${status}`}>
      <details className="process-tool-details">
        <summary className="process-step-summary">
          <span className="process-step-tool">{compactToolName(entry.name)}</span>
          <span className="process-step-text">
            {toolActivityPrefix(entry, file)}{' '}
            {file ? <FileReference file={{ ...file, entry }} /> : target}
          </span>
          <span className="process-step-meta">
            {entry.durationMs === null ? toolStatusLabel(entry) : formatDuration(entry.durationMs)}
          </span>
          <span className="process-step-expand" aria-hidden="true" />
        </summary>
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
      </details>
    </li>
  )
}

function FileReference({ file }: { file: ToolFileReference }): React.JSX.Element {
  const operation = file.operation === 'read' ? '读取' : '修改'
  const status = toolStatusLabel(file.entry)
  const duration = file.entry.durationMs === null ? null : formatDuration(file.entry.durationMs)
  return (
    <span
      className={`tool-file-reference ${file.operation}`}
      tabIndex={0}
      aria-label={`${operation}文件 ${file.path}`}
    >
      <span className="tool-file-reference-label">{compactTarget(file.path)}</span>
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

function MessageEntry({ entry }: { entry: KernelMessageEntry }): React.JSX.Element | null {
  const hasText = entry.text.trim().length > 0
  const aborted = entry.stopReason === 'aborted'
  if (!hasText && !entry.error && !entry.streaming && !aborted) return null

  return (
    <div className="conversation-turn">
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

function ThinkingStatus({ label }: { label: string }): React.JSX.Element {
  return (
    <span className="thinking-status" aria-label={`Pi ${label}`} role="status">
      <span className="thinking-visual" aria-hidden="true">
        <span className="thinking-core" />
      </span>
      <span>{label}</span>
    </span>
  )
}

function groupConversationTurns(entries: KernelConversationEntry[]): ConversationTurn[] {
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
  previous: { turn: ConversationTurn },
  next: { turn: ConversationTurn }
): boolean {
  if (previous.turn.entries.length !== next.turn.entries.length) return false
  return previous.turn.entries.every((entry, index) => entry === next.turn.entries[index])
}

function abortedMessage(error: string | null): string {
  const message = error?.trim()
  if (!message || /^Request was aborted\.?$/i.test(message)) return '已中止'
  return `已中止：${message}`
}

function splitTurn(turn: ConversationTurn): {
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

function isProcessEntry(entry: KernelConversationEntry): entry is ProcessEntry {
  return entry.kind === 'thinking' || entry.kind === 'tool'
}

function isVisibleEntry(entry: KernelConversationEntry): boolean {
  if (entry.kind === 'message') return Boolean(entry.text.trim() || entry.error || entry.streaming)
  if (entry.kind === 'thinking') return Boolean(entry.text.trim() || entry.streaming)
  return true
}

function isRunningEntry(entry: KernelConversationEntry): boolean {
  if (entry.kind === 'message' || entry.kind === 'thinking') return entry.streaming
  if (entry.kind === 'tool') return entry.status === 'pending' || entry.status === 'running'
  return false
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
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`
}
