import { useLayoutEffect, useRef } from 'react'

import type {
  KernelConversationEntry,
  KernelMessageEntry,
  KernelToolEntry,
  RuntimeStatus
} from '../../../../shared/kernel-contract'

type TimelineProps = {
  entries: KernelConversationEntry[]
  runtimeStatus: RuntimeStatus
}

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit'
})

export function Timeline({ entries, runtimeStatus }: TimelineProps): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null)
  const followOutputRef = useRef(true)

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (viewport && followOutputRef.current) {
      viewport.scrollTop = viewport.scrollHeight
    }
  }, [entries])

  return (
    <div
      className="timeline-viewport"
      ref={viewportRef}
      onScroll={(event) => {
        const target = event.currentTarget
        followOutputRef.current = target.scrollHeight - target.scrollTop - target.clientHeight < 120
      }}
    >
      <div className="timeline" aria-live="polite" aria-label="对话时间线">
        {entries.length === 0 ? (
          <div className="timeline-empty">
            <span className="empty-mark" aria-hidden="true">π</span>
            <h2>{runtimeStatus === 'running' ? 'Pi 正在准备回应' : '工作区已就绪'}</h2>
            <p>在下方输入任务，消息、思考与工具执行会按发生顺序出现在这里。</p>
          </div>
        ) : (
          entries.map((entry) => <TimelineEntry key={entry.id} entry={entry} />)
        )}
      </div>
    </div>
  )
}

function TimelineEntry({ entry }: { entry: KernelConversationEntry }): React.JSX.Element | null {
  if (entry.kind === 'message') return <MessageEntry entry={entry} />
  if (entry.kind === 'tool') return <ToolEntry entry={entry} />
  return (
    <article className="timeline-error-card" role="alert">
      <div className="entry-heading">
        <span className="entry-label">{entry.source === 'extension' ? 'EXTENSION' : 'AGENT'}</span>
        <time>{formatTime(entry.timestamp)}</time>
      </div>
      <strong>{entry.title}</strong>
      <p>{entry.message}</p>
    </article>
  )
}

function MessageEntry({ entry }: { entry: KernelMessageEntry }): React.JSX.Element | null {
  const hasContent = entry.text.length > 0 || entry.thinking.length > 0 || entry.error !== null
  if (!hasContent && !entry.streaming) return null

  return (
    <article className="timeline-message" data-role={entry.role}>
      <div className="entry-heading">
        <span className="entry-label">{entry.role === 'user' ? 'YOU' : 'PI'}</span>
        <time>{formatTime(entry.timestamp)}</time>
      </div>

      {entry.text.length > 0 ? (
        <div className="message-copy">{entry.text}</div>
      ) : entry.streaming ? (
        <div className="streaming-placeholder">
          <span />
          <span />
          <span />
          <span className="sr-only">Pi 正在生成内容</span>
        </div>
      ) : null}

      {entry.thinking.length > 0 && (
        <details className="thinking-block">
          <summary>思考过程</summary>
          <div>{entry.thinking}</div>
        </details>
      )}

      {entry.error && <p className="message-error">{entry.error}</p>}
      {entry.streaming && entry.text.length > 0 && <span className="streaming-caret" aria-hidden="true" />}
    </article>
  )
}

function ToolEntry({ entry }: { entry: KernelToolEntry }): React.JSX.Element {
  const preview = toolPreview(entry)
  const statusLabel = {
    pending: '等待',
    running: '运行中',
    success: '完成',
    error: '失败'
  }[entry.status]

  return (
    <details
      className="tool-card"
      data-status={entry.status}
      open={entry.status === 'running' || entry.status === 'error'}
    >
      <summary>
        <span className="tool-status-dot" aria-hidden="true" />
        <span className="tool-name mono">{entry.name}</span>
        <span className="tool-preview">{preview}</span>
        <span className="tool-state">{statusLabel}</span>
        {entry.durationMs !== null && <span className="tool-duration">{formatDuration(entry.durationMs)}</span>}
        <span className="tool-chevron" aria-hidden="true">⌄</span>
      </summary>
      <div className="tool-details">
        {entry.args && (
          <section>
            <span className="tool-section-label">INPUT</span>
            <pre>{entry.args}</pre>
          </section>
        )}
        {entry.output && (
          <section>
            <span className="tool-section-label">OUTPUT</span>
            <pre>{entry.output}</pre>
          </section>
        )}
        {entry.details && (
          <details className="tool-raw-details">
            <summary>Result details</summary>
            <pre>{entry.details}</pre>
          </details>
        )}
        {entry.truncated && <span className="truncated-badge">输出已截断</span>}
      </div>
    </details>
  )
}

function firstLine(value: string): string {
  const line = value.split('\n', 1)[0]?.trim() ?? ''
  return line.length > 90 ? `${line.slice(0, 90)}…` : line
}

function toolPreview(entry: KernelToolEntry): string {
  if (entry.args) {
    try {
      const args: unknown = JSON.parse(entry.args)
      if (typeof args === 'object' && args !== null) {
        const record = args as Record<string, unknown>
        for (const key of ['command', 'path', 'file_path', 'query', 'url']) {
          if (typeof record[key] === 'string') return firstLine(record[key])
        }
        const firstString = Object.values(record).find((value) => typeof value === 'string')
        if (typeof firstString === 'string') return firstLine(firstString)
      }
    } catch {
      const line = firstLine(entry.args)
      if (line !== '{' && line !== '[') return line
    }
  }
  return firstLine(entry.output) || '等待工具输出'
}

function formatTime(timestamp: number): string {
  return Number.isFinite(timestamp) ? timeFormatter.format(timestamp) : ''
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs}ms`
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`
}
