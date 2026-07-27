import {
  createContext,
  memo,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import { createPortal } from 'react-dom'

import type {
  KernelAdvisorEntry,
  KernelCommandEntry,
  KernelConversationEntry,
  KernelErrorEntry,
  KernelExtensionStatusEntry,
  KernelMessageAttachment,
  KernelMessageEntry,
  KernelMessageImage,
  KernelSubagentNoticeEntry,
  KernelSubagentRun,
  KernelThinkingEntry,
  KernelToolEntry,
  KernelToolImageAttachment
} from '../../../../shared/kernel-contract'
import { Icon } from '../../components/Icon'
import { unknownErrorMessage } from '../../unknown-error-message'
import { MarkdownMessage } from './MarkdownMessage'
import {
  SubagentTaskCapsule,
  SubagentTaskInteractionContext
} from './SubagentTaskDetail'
import type { ToolDisplayDensity } from '../../tool-display-density'
import {
  sameToolImageRequest,
  type ToolImageRequestIdentity
} from './tool-image-request'
import {
  matchesSubagentTaskTarget,
  subagentParticipantStatusLabel
} from './subagent-task-detail-model'
import {
  subagentCoordinationNoticePresentation,
  subagentCoordinationToolPresentation,
  type SubagentCoordinationToolPresentation
} from './subagent-coordination-presentation'

export const TimelineSessionKeyContext = createContext<string | null>(null)

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
type PromotedLiveEntry = NarrativeEntry | KernelToolEntry

type ContentEntry =
  | KernelMessageEntry
  | KernelAdvisorEntry
  | KernelErrorEntry
  | KernelExtensionStatusEntry
  | KernelSubagentNoticeEntry
  | KernelCommandEntry

type LiveChunk =
  | { id: string; kind: 'process'; entries: ProcessEntry[] }
  | {
      id: string
      kind: 'entry'
      entry: ContentEntry
    }

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
  const commandOnly = soleCommandEntry(turn)
  if (commandOnly !== null) {
    return (
      <section className="conversation-run command" data-conversation-turn-id={turn.id}>
        <CommandEntry entry={commandOnly} />
      </section>
    )
  }

  const { user, responseEntries } = splitTurn(turn)
  const processEntries = responseEntries.filter(isProcessEntry)
  const answerEntries = responseEntries.filter(
    (entry): entry is ContentEntry =>
      (entry.kind === 'message' && entry.phase !== 'commentary') ||
      entry.kind === 'advisor' ||
      entry.kind === 'error' ||
      entry.kind === 'extension-status' ||
      entry.kind === 'subagent-notice' ||
      entry.kind === 'command'
  )

  return (
    <section className="conversation-run completed" data-conversation-turn-id={turn.id}>
      {user ? <MessageEntry entry={user} /> : null}
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
  const commandOnly = soleCommandEntry(turn)
  if (commandOnly !== null) {
    return (
      <section className="conversation-run command" data-conversation-turn-id={turn.id}>
        <CommandEntry entry={commandOnly} />
      </section>
    )
  }

  const { user, responseEntries } = splitTurn(turn)
  const chunks = buildLiveChunks(responseEntries)

  return (
    <section className="conversation-run active" data-conversation-turn-id={turn.id}>
      {user ? <MessageEntry entry={user} /> : null}
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
  const interaction = useContext(SubagentTaskInteractionContext)
  const selection = interaction?.selection ?? null
  const [expanded, setExpanded] = useState(false)
  const selectedSubagentInProcess = selection?.kind === 'tool' && entries.some((entry) =>
    entry.kind === 'tool' &&
    entry.toolCallId === selection.toolCallId &&
    entry.subagent?.participants.some(
      (participant) => participant.index === selection.participantIndex
    ) === true
  )
  const processExpanded = expanded || selectedSubagentInProcess

  useEffect(() => {
    if (selectedSubagentInProcess) setExpanded(true)
  }, [selectedSubagentInProcess])

  return (
    <details
      className="completed-process"
      open={processExpanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="completed-process-summary">
        <span className="completed-process-title">
          已处理{runElapsedMs === null ? '' : ` ${formatDuration(runElapsedMs)}`}
        </span>
        <span className="completed-process-expand" aria-hidden="true" />
      </summary>
      {processExpanded ? (
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

  const promotedEntries = entries.filter((entry): entry is PromotedLiveEntry => {
    if (entry.kind === 'tool') return entry.subagent !== null
    if (toolDisplayDensity !== 'standard') return false
    return entry.kind === 'message' || (entry.kind === 'thinking' && !entry.summary)
  })
  const promotedIds = new Set(promotedEntries.map((entry) => entry.id))
  const detailEntries = entries.filter((entry) => !promotedIds.has(entry.id))
  const promotedEntryIsCurrent = activeEntry !== undefined && promotedIds.has(activeEntry.id)

  return (
    <ol
      className={`process-step-list live-process-condensed tool-density-${toolDisplayDensity}`}
      aria-label="当前工作过程"
    >
      {promotedEntries.map((entry) => {
        if (entry.kind === 'thinking') {
          return (
            <ThinkingStep
              active={entry.id === activeEntry?.id}
              entry={entry}
              elapsedMs={thinkingElapsedByEntryId.get(entry.id) ?? null}
              key={entry.id}
              pinned
            />
          )
        }
        if (entry.kind === 'message') {
          return <CommentaryStep entry={entry} key={entry.id} />
        }
        return <ToolStep entry={entry} detailed={false} key={entry.id} />
      })}
      {!promotedEntryIsCurrent ? (
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
  if (entry.subagent !== null) {
    return (
      <SubagentToolStep
        detailed={detailed}
        entry={entry}
        run={entry.subagent}
      />
    )
  }
  const coordination = subagentCoordinationToolPresentation(entry)
  if (coordination !== null) {
    return (
      <SubagentCoordinationToolStep
        detailed={detailed}
        entry={entry}
        presentation={coordination}
      />
    )
  }
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

function SubagentCoordinationToolStep({
  detailed,
  entry,
  presentation
}: {
  detailed: boolean
  entry: KernelToolEntry
  presentation: SubagentCoordinationToolPresentation
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const status = activityStatus(entry)
  const detail = entry.output || entry.details
  return (
    <li className={`process-step tool subagent-coordination ${detailed ? 'detailed' : 'standard'} ${status}`}>
      <details
        className={detailed ? 'process-tool-details' : 'process-standard-tool'}
        open={expanded}
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary className={`process-step-summary${detailed ? '' : ' tool-standard-summary standard-tool-summary'}`}>
          {detailed ? <span className="process-step-tool">subagent</span> : null}
          <span className="process-step-text">{presentation.text}</span>
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

function SubagentToolStep({
  detailed,
  entry,
  run
}: {
  detailed: boolean
  entry: KernelToolEntry
  run: KernelSubagentRun
}): React.JSX.Element {
  const interaction = useContext(SubagentTaskInteractionContext)
  const status = activityStatus(entry)
  const title = subagentRunTitle(run)
  const meta = subagentRunStatus(run, entry)
  return (
    <li className={`process-step tool subagent ${detailed ? 'detailed' : 'standard'} ${status}`}>
      <div className={`process-step-summary subagent-run-summary${detailed ? '' : ' tool-standard-summary standard-tool-summary'}`}>
        {detailed ? <span className="process-step-tool">subagent</span> : null}
        <span className="subagent-run-chips" aria-label={title}>
          {run.participants.length > 0 ? run.participants.map((participant) => {
            const target = {
              kind: 'tool' as const,
              toolCallId: entry.toolCallId,
              participantIndex: participant.index
            }
            const selected = matchesSubagentTaskTarget(interaction?.selection ?? null, target)
            return interaction === null ? null : (
              <SubagentTaskCapsule
                key={participant.index}
                target={target}
                participant={participant}
                selected={selected}
                onClick={(trigger) => interaction.onOpen(target, trigger)}
              />
            )
          }) : (
            <span className="subagent-run-chip pending">
              <span className="subagent-run-chip-icon">
                <Icon name="subagents" size="sm" />
              </span>
              <span className="subagent-run-chip-label">Subagent</span>
            </span>
          )}
        </span>
        <span className="process-step-meta">{meta}</span>
      </div>
    </li>
  )
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
  const attachments = compactToolName(entry.name) === 'subagent'
    ? []
    : entry.attachments ?? []
  const hasOutput = detail.length > 0 || attachments.length > 0
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
      ) : null}
      {attachments.length > 0 ? (
        <ToolResultAttachments
          attachments={attachments}
          toolCallId={entry.toolCallId}
        />
      ) : null}
      {!hasOutput ? <p>等待工具输出</p> : null}
      {entry.truncated ? <small>输出已截断</small> : null}
    </div>
  )
}

function ToolResultAttachments({
  attachments,
  toolCallId
}: {
  attachments: KernelToolImageAttachment[]
  toolCallId: string
}): React.JSX.Element {
  const sessionKey = useContext(TimelineSessionKeyContext)
  const titleId = useId()
  const attachmentIdentity = attachments
    .map((attachment) => `${attachment.contentIndex}:${attachment.mimeType}:${attachment.byteLength}`)
    .join('|')
  const requestSequenceRef = useRef(0)
  const [viewer, setViewer] = useState<{
    request: ToolImageRequestIdentity
    name: string
    status: 'loading' | 'ready' | 'error'
    image: KernelMessageImage | null
    error: string | null
  } | null>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  useLayoutEffect(() => {
    requestSequenceRef.current += 1
    setViewer(null)
  }, [sessionKey, toolCallId, attachmentIdentity])

  useEffect(() => {
    if (viewer === null) return
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    closeButtonRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        requestSequenceRef.current += 1
        setViewer(null)
        return
      }
      if (event.key !== 'Tab') return

      const dialog = dialogRef.current
      const focusable = dialog === null
        ? []
        : Array.from(dialog.querySelectorAll<HTMLElement>(
            'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
          ))
      if (focusable.length === 0) {
        event.preventDefault()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (
        !dialog?.contains(active) ||
        (event.shiftKey && active === first) ||
        (!event.shiftKey && active === last)
      ) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true)
      const previousFocus = previousFocusRef.current
      if (previousFocus !== null && previousFocus.isConnected) previousFocus.focus()
    }
  }, [viewer !== null])

  async function openToolImage(contentIndex: number, name: string): Promise<void> {
    const request: ToolImageRequestIdentity = {
      requestId: requestSequenceRef.current += 1,
      sessionKey,
      toolCallId,
      contentIndex
    }
    if (sessionKey === null) {
      setViewer({
        request,
        name,
        status: 'error',
        image: null,
        error: '当前没有可读取的会话来源。'
      })
      return
    }
    setViewer({
      request,
      name,
      status: 'loading',
      image: null,
      error: null
    })
    try {
      const image = await window.piGui.getToolImage(sessionKey, toolCallId, contentIndex)
      setViewer((current) => {
        if (current === null || !sameToolImageRequest(current.request, request)) return current
        return {
          ...current,
          status: 'ready',
          image,
          error: null
        }
      })
    } catch (error) {
      setViewer((current) => {
        if (current === null || !sameToolImageRequest(current.request, request)) return current
        return {
          ...current,
          status: 'error',
          image: null,
          error: unknownErrorMessage(error)
        }
      })
    }
  }

  return (
    <>
      <ul className="message-attachment-list tool" aria-label="工具图片附件">
        {attachments.map((attachment) => (
          <li
            className="message-attachment image"
            key={`tool-image:${toolCallId}:${attachment.contentIndex}`}
            data-tool-image-content-index={attachment.contentIndex}
          >
            <button
              className="message-attachment-open"
              type="button"
              aria-label={`查看工具图片 ${attachment.name}`}
              data-tool-image-open="true"
              onClick={() => {
                void openToolImage(attachment.contentIndex, attachment.name)
              }}
            >
              <span className="message-attachment-kind">图片</span>
              <span className="message-attachment-name">{attachment.name}</span>
            </button>
          </li>
        ))}
      </ul>
      {viewer === null ? null : createPortal(
        <div
          className="message-image-viewer-backdrop"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) {
              requestSequenceRef.current += 1
              setViewer(null)
            }
          }}
        >
          <section
            ref={dialogRef}
            className="message-image-viewer"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-busy={viewer.status === 'loading' ? true : undefined}
            data-tool-image-viewer="true"
          >
            <header className="message-image-viewer-header">
              <div className="message-image-viewer-copy">
                <h2 id={titleId}>{viewer.name}</h2>
              </div>
              <button
                ref={closeButtonRef}
                className="message-image-viewer-close"
                type="button"
                onClick={() => {
                  requestSequenceRef.current += 1
                  setViewer(null)
                }}
              >
                关闭
              </button>
            </header>
            <div className="message-image-viewer-body">
              {viewer.status === 'loading' ? (
                <p className="message-image-viewer-state" role="status">正在读取图片…</p>
              ) : viewer.status === 'error' ? (
                <p className="message-image-viewer-state error" role="alert">
                  {viewer.error ?? '无法打开图片。'}
                </p>
              ) : viewer.image === null ? null : (
                <img
                  className="message-image-viewer-image"
                  src={`data:${viewer.image.mimeType};base64,${viewer.image.data}`}
                  alt={viewer.name}
                />
              )}
            </div>
          </section>
        </div>,
        document.body
      )}
    </>
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
  entry: ContentEntry
}): React.JSX.Element | null {
  if (entry.kind === 'message') return <MessageEntry entry={entry} />
  if (entry.kind === 'advisor') return <AdvisorEntry entry={entry} />
  if (entry.kind === 'extension-status') return <ExtensionStatusEntry entry={entry} />
  if (entry.kind === 'command') return <CommandEntry entry={entry} />
  if (entry.kind === 'subagent-notice') {
    if (entry.noticeType === 'completion') {
      return entry.completion === undefined
        ? null
        : <SubagentCompletionNotice entry={entry} completion={entry.completion} />
    }
    const coordination = subagentCoordinationNoticePresentation(entry)
    if (coordination !== null) {
      return (
        <article
          className={`subagent-notice coordination ${coordination.tone} ${entry.coordination?.status ?? 'pending'}`}
          role={coordination.role}
        >
          <header className="subagent-notice-heading">
            <span className="subagent-notice-icon" aria-hidden="true">
              <Icon name="subagents" size="sm" />
            </span>
            <strong>{coordination.title}</strong>
            <span className="subagent-notice-meta">{coordination.meta}</span>
          </header>
          <p className="subagent-notice-summary">{entry.text}</p>
        </article>
      )
    }
    const role = entry.noticeType === 'watchdog-blocker' ? 'alert' : 'status'
    return (
      <article className={`subagent-notice ${entry.noticeType}`} role={role}>
        <strong>{subagentNoticeTitle(entry.noticeType)}</strong>
        <MarkdownMessage text={entry.text} streaming={false} />
      </article>
    )
  }
  return (
    <article className="chat-message error" role="alert">
      <pre>{entry.title}: {entry.message}</pre>
    </article>
  )
}

function ExtensionStatusEntry({
  entry
}: {
  entry: KernelExtensionStatusEntry
}): React.JSX.Element {
  return (
    <article
      className={`extension-status ${entry.level}`}
      role={entry.level === 'warning' || entry.level === 'error' ? 'alert' : 'status'}
    >
      <header className="extension-status-heading">
        <strong>{entry.title}</strong>
      </header>
      <MarkdownMessage text={entry.text} streaming={false} />
    </article>
  )
}

function AdvisorEntry({ entry }: { entry: KernelAdvisorEntry }): React.JSX.Element {
  return (
    <article
      className={`advisor-review ${entry.severity}`}
      role="note"
      aria-label={`${entry.advisorName} 的 ${advisorSeverityLabel(entry.severity)}审查`}
    >
      <header className="advisor-review-heading">
        <h3>{entry.advisorName}</h3>
        <span>{advisorSeverityLabel(entry.severity)}</span>
      </header>
      <p className="advisor-review-content">{entry.content}</p>
      {entry.guidance.trim().length === 0 ? null : (
        <section className="advisor-review-guidance" aria-label="处理建议">
          <h4>处理建议</h4>
          <p>{entry.guidance}</p>
        </section>
      )}
    </article>
  )
}

function advisorSeverityLabel(severity: KernelAdvisorEntry['severity']): string {
  if (severity === 'blocker') return '阻断'
  if (severity === 'concern') return '关注'
  return '建议'
}

function CommandEntry({ entry }: { entry: KernelCommandEntry }): React.JSX.Element {
  return (
    <article className="command-echo" role="status" aria-label={`命令 ${entry.text}`}>
      <span className="command-echo-label">命令</span>
      <code className="command-echo-text">{entry.text}</code>
    </article>
  )
}

function MessageEntry({
  entry
}: {
  entry: KernelMessageEntry
}): React.JSX.Element | null {
  const hasText = entry.text.trim().length > 0
  const attachments = entry.attachments ?? []
  const aborted = entry.stopReason === 'aborted'
  if (!hasText && attachments.length === 0 && !entry.error && !entry.streaming && !aborted) return null

  return (
    <div className="conversation-turn">
      <MessageAttachments
        attachments={attachments}
        role={entry.role}
        messageId={entry.id}
      />
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
  messageId,
  label = '消息附件'
}: {
  attachments: KernelMessageAttachment[]
  role: KernelMessageEntry['role']
  messageId: string
  label?: string
}): React.JSX.Element | null {
  const sessionKey = useContext(TimelineSessionKeyContext)
  const [viewer, setViewer] = useState<{
    attachmentIndex: number
    name: string
    path: string
    status: 'loading' | 'ready' | 'error'
    image: KernelMessageImage | null
    error: string | null
  } | null>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (viewer === null) return
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    closeButtonRef.current?.focus()
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setViewer(null)
        return
      }
      if (event.key !== 'Tab') return

      const dialog = dialogRef.current
      const focusable = dialog === null
        ? []
        : Array.from(dialog.querySelectorAll<HTMLElement>(
            'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
          ))
      if (focusable.length === 0) {
        event.preventDefault()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (
        !dialog?.contains(active) ||
        (event.shiftKey && active === first) ||
        (!event.shiftKey && active === last)
      ) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      }
    }
    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true)
      const previousFocus = previousFocusRef.current
      if (previousFocus !== null && previousFocus.isConnected) previousFocus.focus()
    }
  }, [viewer !== null])

  if (attachments.length === 0) return null

  async function openImageAttachment(attachmentIndex: number): Promise<void> {
    const attachment = attachments[attachmentIndex]
    if (attachment === undefined || attachment.type !== 'image') return
    if (sessionKey === null) {
      setViewer({
        attachmentIndex,
        name: attachment.name,
        path: attachment.path,
        status: 'error',
        image: null,
        error: '当前没有可读取的会话来源。'
      })
      return
    }
    setViewer({
      attachmentIndex,
      name: attachment.name,
      path: attachment.path,
      status: 'loading',
      image: null,
      error: null
    })
    try {
      const image = await window.piGui.getMessageImage(sessionKey, messageId, attachmentIndex)
      setViewer((current) => {
        if (current === null || current.attachmentIndex !== attachmentIndex) return current
        return {
          ...current,
          status: 'ready',
          image,
          error: null
        }
      })
    } catch (error) {
      setViewer((current) => {
        if (current === null || current.attachmentIndex !== attachmentIndex) return current
        return {
          ...current,
          status: 'error',
          image: null,
          error: unknownErrorMessage(error)
        }
      })
    }
  }

  return (
    <>
      <ul className={`message-attachment-list ${role}`} aria-label={label}>
        {attachments.map((attachment, index) => (
          <li
            className={`message-attachment ${attachment.type}`}
            data-tooltip={attachment.path || undefined}
            data-tooltip-variant={attachment.path ? 'mono' : undefined}
            key={`${attachment.type}:${attachment.path}:${index}`}
          >
            {attachment.type === 'image' ? (
              <button
                className="message-attachment-open"
                type="button"
                aria-label={`查看图片 ${attachment.name}`}
                onClick={() => {
                  void openImageAttachment(index)
                }}
              >
                <span className="message-attachment-kind">图片</span>
                <span className="message-attachment-name">{attachment.name}</span>
              </button>
            ) : (
              <>
                <span className="message-attachment-kind">文件</span>
                <span className="message-attachment-name">{attachment.name}</span>
              </>
            )}
          </li>
        ))}
      </ul>
      {viewer === null ? null : createPortal(
        <div
          className="message-image-viewer-backdrop"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setViewer(null)
          }}
        >
          <section
            ref={dialogRef}
            className="message-image-viewer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="message-image-viewer-title"
            aria-busy={viewer.status === 'loading' ? true : undefined}
          >
            <header className="message-image-viewer-header">
              <div className="message-image-viewer-copy">
                <h2 id="message-image-viewer-title">{viewer.name}</h2>
                {viewer.path ? (
                  <p className="message-image-viewer-path" data-tooltip={viewer.path} data-tooltip-variant="mono">
                    {viewer.path}
                  </p>
                ) : null}
              </div>
              <button
                ref={closeButtonRef}
                className="message-image-viewer-close"
                type="button"
                onClick={() => setViewer(null)}
              >
                关闭
              </button>
            </header>
            <div className="message-image-viewer-body">
              {viewer.status === 'loading' ? (
                <p className="message-image-viewer-state" role="status">正在读取图片…</p>
              ) : viewer.status === 'error' ? (
                <p className="message-image-viewer-state error" role="alert">
                  {viewer.error ?? '无法打开图片。'}
                </p>
              ) : viewer.image === null ? null : (
                <img
                  className="message-image-viewer-image"
                  src={`data:${viewer.image.mimeType};base64,${viewer.image.data}`}
                  alt={viewer.name}
                />
              )}
            </div>
          </section>
        </div>,
        document.body
      )}
    </>
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
    if (entry.kind === 'command') {
      if (current !== null) turns.push(current)
      turns.push({ id: entry.id, entries: [entry] })
      current = null
      continue
    }
    if (current === null) current = { id: `turn:${entry.id}`, entries: [] }
    current.entries.push(entry)
  }
  if (current !== null) turns.push(current)
  return turns
}

function soleCommandEntry(turn: ConversationTurn): KernelCommandEntry | null {
  const entry = turn.entries[0]
  return turn.entries.length === 1 && entry?.kind === 'command' ? entry : null
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

export function turnFinalAnswerText(turn: ConversationTurn): string | null {
  const parts: string[] = []
  for (const entry of turn.entries) {
    if (
      entry.kind === 'message' &&
      entry.role === 'assistant' &&
      !entry.streaming &&
      (entry.phase === 'final_answer' || entry.phase == null)
    ) {
      const text = entry.text.trim()
      if (text.length > 0) parts.push(entry.text)
    }
  }
  return parts.length === 0 ? null : parts.join('\n\n')
}

export function turnForkUserText(turn: ConversationTurn): string | null {
  const { user } = splitTurn(turn)
  if (user === null || user.text.trim().length === 0) return null
  if (user.attachments?.some((attachment) => attachment.type === 'image')) return null
  return user.text
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
    if (
      entry.kind === 'message' ||
      entry.kind === 'advisor' ||
      entry.kind === 'error' ||
      entry.kind === 'extension-status' ||
      entry.kind === 'subagent-notice' ||
      entry.kind === 'command'
    ) {
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

function liveProcessStatusLabel(entries: readonly KernelConversationEntry[]): string {
  const activeEntry = currentRunningEntry(entries)
  if (activeEntry?.kind === 'thinking') {
    return latestThinkingSummaryLabel([activeEntry]) ?? '正在思考'
  }
  if (activeEntry?.kind === 'message') return '正在继续'
  if (activeEntry?.kind === 'tool') {
    const file = toolFileInfo(activeEntry)
    if (file?.operation === 'read') return `正在阅读 ${fileBasename(file.path)}`
    if (file?.operation === 'modify') return `正在修改 ${fileBasename(file.path)}`
    const coordination = subagentCoordinationToolPresentation(activeEntry)
    if (coordination !== null) return coordination.text
    return compactToolName(activeEntry.name) === 'bash'
      ? '正在运行命令'
      : `正在调用 ${compactToolName(activeEntry.name)}`
  }
  return latestThinkingSummaryLabel(entries) ?? '正在继续'
}

export function latestThinkingSummaryLabel(
  entries: readonly KernelConversationEntry[]
): string | null {
  for (let entryIndex = entries.length - 1; entryIndex >= 0; entryIndex -= 1) {
    const entry = entries[entryIndex]
    if (entry?.kind !== 'thinking' || !entry.summary) continue
    const lines = entry.text.split(/\r?\n/u)
    for (let lineIndex = lines.length - 1; lineIndex >= 0; lineIndex -= 1) {
      const label = thinkingSummaryLineLabel(lines[lineIndex] ?? '')
      if (label !== null) return label
    }
  }
  return null
}

function thinkingSummaryLineLabel(line: string): string | null {
  let label = line.trim()
  if (label.length === 0) return null
  label = label
    .replace(/^#{1,6}\s+/u, '')
    .replace(/^[-+]\s+/u, '')
    .trim()
  for (const wrapper of [
    /^(\*\*)(.+)\1$/u,
    /^(__)(.+)\1$/u,
    /^(\*)(.+)\1$/u,
    /^(_)(.+)\1$/u,
    /^(`)(.+)\1$/u
  ]) {
    const match = wrapper.exec(label)
    if (match?.[2] !== undefined) {
      label = match[2].trim()
      break
    }
  }
  return label.length === 0 ? null : label
}

function currentRunningEntry<T extends KernelConversationEntry>(
  entries: readonly T[]
): T | undefined {
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
  const coordinationTools = tools.filter((entry) =>
    !fileToolIds.has(entry.id) && subagentCoordinationToolPresentation(entry) !== null
  )
  const coordinationIds = new Set(coordinationTools.map((entry) => entry.id))
  const otherToolCount = tools.filter((entry) =>
    !fileToolIds.has(entry.id) &&
    compactToolName(entry.name) !== 'bash' &&
    !coordinationIds.has(entry.id)
  ).length
  const coordinationLabel = coordinationTools.length === 1
    ? subagentCoordinationToolPresentation(coordinationTools[0]!)?.groupLabel ?? null
    : coordinationTools.length > 1 ? `处理 ${coordinationTools.length} 次 Subagent 协作` : null
  return [
    readCount > 0 ? `读取 ${readCount} 个文件` : null,
    modifiedCount > 0 ? `修改 ${modifiedCount} 个文件` : null,
    commandCount > 0 ? `运行 ${commandCount} 条命令` : null,
    coordinationLabel,
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

function subagentRunTitle(run: KernelSubagentRun): string {
  const agents = [...new Set(run.participants.map(({ agent }) => agent).filter(Boolean))]
  if (run.mode === 'parallel') {
    return `并行委派 ${run.participants.length || agents.length || 1} 个 Subagent`
  }
  if (run.mode === 'chain') {
    return `按链路委派 ${run.participants.length || agents.length || 1} 个 Subagent`
  }
  return agents[0] ? `委派给 ${agents[0]}` : '委派给 Subagent'
}

function subagentRunStatus(run: KernelSubagentRun, entry: KernelToolEntry): string {
  if (entry.status === 'error' || run.participants.some(({ status }) => status === 'failed')) return '失败'
  if (run.participants.some(({ status }) => status === 'paused')) return '已暂停'
  if (run.asyncId || run.participants.some(({ status }) => status === 'detached')) return '后台运行'
  if (
    entry.status === 'pending' &&
    run.participants.every(({ status }) => status === 'pending')
  ) return '正在唤起'
  if (entry.status === 'pending' || entry.status === 'running' ||
      run.participants.some(({ status }) => status === 'pending' || status === 'running')) return '运行中'
  return '已完成'
}

function SubagentCompletionNotice({
  entry,
  completion
}: {
  entry: KernelSubagentNoticeEntry
  completion: NonNullable<KernelSubagentNoticeEntry['completion']>
}): React.JSX.Element | null {
  const interaction = useContext(SubagentTaskInteractionContext)
  if (interaction === null) return null
  const target = { kind: 'notice' as const, noticeId: entry.id }
  const selected = matchesSubagentTaskTarget(interaction.selection, target)
  return (
    <div className="subagent-completion-entry">
      <SubagentTaskCapsule
        target={target}
        participant={completion}
        selected={selected}
        onClick={(trigger) => interaction.onOpen(target, trigger)}
      />
      <span className={`subagent-completion-status ${completion.status}`}>
        {subagentParticipantStatusLabel(completion.status)}
      </span>
    </div>
  )
}

function subagentNoticeTitle(noticeType: KernelSubagentNoticeEntry['noticeType']): string {
  if (noticeType === 'completion') return 'Subagent 完成通知'
  if (noticeType === 'control') return 'Subagent 需要关注'
  if (noticeType === 'steering') return 'Subagent 调整通知'
  if (noticeType === 'request') return 'Subagent 请求'
  if (noticeType === 'admin') return 'Subagent 管理'
  if (noticeType === 'command') return 'Subagent 命令'
  if (noticeType === 'watchdog-blocker') return 'Subagent Watchdog · 阻断'
  return 'Subagent Watchdog · 关注'
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
  return normalized.split(/[.:/]/u).at(-1) || normalized || 'tool'
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
