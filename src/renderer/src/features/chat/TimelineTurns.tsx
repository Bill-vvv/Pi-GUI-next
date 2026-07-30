import {
  createContext,
  Fragment,
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
import { IconButton } from '../../components/IconButton'
import { useModalDialog } from '../../components/useModalDialog'
import { formatDuration } from '../../format-duration.ts'
import { unknownErrorMessage } from '../../unknown-error-message'
import { MarkdownMessage } from './MarkdownMessage'
import { AskToolCard, AskToolInteractionContext } from './AskToolCard'
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
  isInternalSubagentCoordinationTool,
  subagentCoordinationNoticePresentation,
  subagentCoordinationToolPresentation,
  type SubagentCoordinationToolPresentation
} from './subagent-coordination-presentation'
import {
  compactToolName,
  fileBasename,
  groupAdjacentThinking,
  latestThinkingSummaryLabel,
  parseToolArgs,
  standardProcessItems,
  standardToolSummaryParts,
  stringArgument,
  summarizeTools,
  thinkingGroupDetailText,
  thinkingGroupElapsedMs,
  thinkingSummaryEntryLabel,
  toolFileInfo,
  type CommentaryEntry,
  type ProcessEntry,
  type ToolFileInfo
} from './timeline-process-model'

export const TimelineSessionKeyContext = createContext<string | null>(null)

export type ConversationTurn = {
  id: string
  entries: KernelConversationEntry[]
}

type ToolTargetPresentation = {
  text: string
  code: boolean
}

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
  const displayedRunElapsedMs = runElapsedMs ?? transcriptTurnElapsedMs(user, responseEntries)
  const processEntries = responseEntries.filter(
    (entry): entry is ProcessEntry => isProcessEntry(entry) && isVisibleProcessEntry(entry)
  )
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
            runElapsedMs={displayedRunElapsedMs}
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
        <span className="completed-process-title">已处理</span>
        {runElapsedMs === null ? null : (
          <span className="completed-process-duration">{formatDuration(runElapsedMs)}</span>
        )}
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
  const askInteraction = useContext(AskToolInteractionContext)
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

  if (toolDisplayDensity === 'standard') {
    const hiddenEntryIds = new Set(entries.flatMap((entry) => {
      if (entry.kind === 'thinking' && thinkingSummaryEntryLabel(entry) !== null) return [entry.id]
      if (
        entry.kind === 'tool' &&
        entry.ask !== undefined &&
        (askInteraction?.sessionKey === null || askInteraction?.sessionKey === undefined)
      ) return [entry.id]
      return []
    }))
    const detailEntries = entries.filter((entry) => hiddenEntryIds.has(entry.id))
    const activeEntryVisible = activeEntry !== undefined && !hiddenEntryIds.has(activeEntry.id)

    return (
      <ol
        className="process-step-list live-process-condensed tool-density-standard"
        aria-label="当前工作过程"
      >
        <StandardProcessEntries
          activeEntryId={activeEntry?.id ?? null}
          entries={entries}
          hiddenEntryIds={hiddenEntryIds}
          thinkingElapsedByEntryId={thinkingElapsedByEntryId}
          pinThinking
        />
        {!activeEntryVisible ? (
          <LiveProcessStatus
            activeEntryId={activeEntry?.id ?? null}
            detailEntries={detailEntries}
            entries={entries}
            toolDisplayDensity="standard"
            thinkingElapsedByEntryId={thinkingElapsedByEntryId}
          />
        ) : null}
      </ol>
    )
  }

  const promotedEntries = entries.filter((entry): entry is KernelToolEntry => (
    entry.kind === 'tool' && (
      entry.subagent !== null || (
        entry.ask !== undefined &&
        askInteraction?.sessionKey !== null &&
        askInteraction?.sessionKey !== undefined
      )
    )
  ))
  const promotedIds = new Set(promotedEntries.map((entry) => entry.id))
  const detailEntries = entries.filter((entry) => !promotedIds.has(entry.id))
  const promotedEntryIsCurrent = activeEntry !== undefined && promotedIds.has(activeEntry.id)

  return (
    <ol
      className="process-step-list live-process-condensed tool-density-compact"
      aria-label="当前工作过程"
    >
      {promotedEntries.map((entry) => (
        <ToolStep entry={entry} detailed={false} key={entry.id} />
      ))}
      {!promotedEntryIsCurrent ? (
        <LiveProcessStatus
          activeEntryId={activeEntry?.id ?? null}
          detailEntries={detailEntries}
          entries={entries}
          toolDisplayDensity="compact"
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
  const items = groupAdjacentThinking(entries)
  return (
    <ol className={`process-step-list tool-density-${toolDisplayDensity}`} aria-label="工作过程">
      {toolDisplayDensity === 'standard' ? (
        <StandardProcessEntries
          activeEntryId={activeEntryId}
          entries={entries}
          thinkingElapsedByEntryId={thinkingElapsedByEntryId}
          pinThinking={pinThinking}
        />
      ) : items.map((item) => {
        if (item.type === 'thinking-group') {
          return (
            <ThinkingGroup
              activeEntryId={activeEntryId}
              entries={item.entries}
              thinkingElapsedByEntryId={thinkingElapsedByEntryId}
              pinned={pinThinking}
              key={item.entries[0]!.id}
            />
          )
        }
        const { entry } = item
        if (entry.kind === 'message') {
          return <CommentaryStep entry={entry} key={entry.id} />
        }
        if (toolDisplayDensity === 'compact') {
          return entry.id === firstToolId
            ? <ToolGroupSummary entries={tools} key={`tools:${entry.id}`} />
            : null
        }
        return <ToolStep entry={entry} detailed key={entry.id} />
      })}
    </ol>
  )
}

function StandardProcessEntries({
  activeEntryId,
  entries,
  thinkingElapsedByEntryId,
  hiddenEntryIds,
  pinThinking = false
}: {
  activeEntryId: string | null
  entries: ProcessEntry[]
  thinkingElapsedByEntryId: ReadonlyMap<string, number>
  hiddenEntryIds?: ReadonlySet<string>
  pinThinking?: boolean
}): React.JSX.Element {
  const items = standardProcessItems(entries, hiddenEntryIds)

  return (
    <>
      {items.map((item) => {
        if (item.type === 'tool-group') {
          return (
            <ToolGroupSummary
              entries={item.entries}
              key={`standard-tools:${item.entries[0]!.id}`}
              variant="standard"
            />
          )
        }
        if (item.type === 'thinking-group') {
          return (
            <ThinkingGroup
              activeEntryId={activeEntryId}
              entries={item.entries}
              thinkingElapsedByEntryId={thinkingElapsedByEntryId}
              key={item.entries[0]!.id}
              pinned={pinThinking}
            />
          )
        }
        const { entry } = item
        if (entry.kind === 'message') return <CommentaryStep entry={entry} key={entry.id} />
        return <ToolStep entry={entry} detailed={false} key={entry.id} />
      })}
    </>
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
  const presentation = liveProcessStatusPresentation(entries)
  const status = <ThinkingStatus label={presentation.label} target={presentation.target} />
  const thinkingEntries = detailEntries.every(
    (entry): entry is KernelThinkingEntry => entry.kind === 'thinking'
  ) ? detailEntries : null
  const thinkingDetailText = thinkingEntries === null
    ? null
    : thinkingGroupDetailText(thinkingEntries, latestThinkingSummaryLabel(thinkingEntries))
  if (detailEntries.length === 0 || thinkingDetailText === '') {
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
            {thinkingEntries === null || thinkingDetailText === null ? (
              <ProcessSequence
                activeEntryId={activeEntryId}
                entries={detailEntries}
                toolDisplayDensity={toolDisplayDensity}
                thinkingElapsedByEntryId={thinkingElapsedByEntryId}
              />
            ) : (
              <div className="process-thinking-detail">
                <MarkdownMessage
                  text={thinkingDetailText}
                  streaming={thinkingEntries.some((entry) => entry.streaming)}
                />
              </div>
            )}
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

function ToolGroupSummary({
  entries,
  variant = 'compact'
}: {
  entries: KernelToolEntry[]
  variant?: 'compact' | 'standard'
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const running = entries.some((entry) => entry.status === 'pending' || entry.status === 'running')
  const failureCount = entries.filter((entry) => entry.status === 'error').length
  const failed = failureCount > 0
  const singleEntry = entries.length === 1 ? entries[0]! : null
  const expandable = singleEntry === null || hasToolDetailContent(singleEntry)
  const meta = variant === 'standard'
    ? failureCount > 0 ? `${failureCount} 项失败` : null
    : running ? '进行中' : failed ? '部分失败' : '完成'
  const className = `tool-group-summary${variant === 'standard' ? ' standard' : ''}${running ? ' running' : ''}${failed ? ' failed' : ''}`
  const content = (
    <>
      <span className={`process-step-text${running ? ' activity-text-shimmer' : ''}`}>
        {variant === 'standard' ? (
          <StandardToolSummary entries={entries} />
        ) : summarizeTools(entries)}
      </span>
      {meta === null ? null : <span className="process-step-meta">{meta}</span>}
    </>
  )
  if (!expandable) {
    return (
      <li className={className}>
        <div className="tool-group-summary-row static">{content}</div>
      </li>
    )
  }
  return (
    <li className={className}>
      <details
        className="tool-group-details"
        open={expanded}
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary className="tool-group-summary-row">
          {content}
          <span className="process-step-expand" aria-hidden="true" />
        </summary>
        {expanded ? <ToolGroupExpandedContent entries={entries} /> : null}
      </details>
    </li>
  )
}

export function ToolGroupExpandedContent({
  entries
}: {
  entries: KernelToolEntry[]
}): React.JSX.Element | null {
  const singleEntry = entries.length === 1 ? entries[0]! : null
  if (singleEntry !== null) {
    return (
      <div className="tool-group-single-detail">
        <ToolDetailContent
          entry={singleEntry}
          detail={singleEntry.output || singleEntry.details}
        />
      </div>
    )
  }
  if (entries.length === 0) return null
  return (
    <ol className="tool-group-entries" aria-label="工具调用">
      {entries.map((entry) => (
        <ToolStep entry={entry} detailed={false} key={entry.id} />
      ))}
    </ol>
  )
}

function StandardToolSummary({
  entries
}: {
  entries: KernelToolEntry[]
}): React.JSX.Element {
  const parts = standardToolSummaryParts(entries)
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={`${part.action}:${part.detail}:${index}`}>
          {index === 0 ? null : <span className="standard-tool-summary-separator">，</span>}
          <span className="standard-tool-summary-action">{part.action}</span>{' '}
          <span className={`standard-tool-summary-detail ${part.detailKind}`}>{part.detail}</span>
        </Fragment>
      ))}
    </>
  )
}

function ThinkingGroup({
  activeEntryId,
  entries,
  thinkingElapsedByEntryId,
  pinned = false
}: {
  activeEntryId: string | null
  entries: KernelThinkingEntry[]
  thinkingElapsedByEntryId: ReadonlyMap<string, number>
  pinned?: boolean
}): React.JSX.Element {
  const active = entries.some((entry) => entry.id === activeEntryId)
  const status = active ? 'running' : 'completed'
  const activeSummaryLabel = active ? latestThinkingSummaryLabel(entries) : null
  const detailText = thinkingGroupDetailText(entries, activeSummaryLabel)
  const showDetail = detailText.length > 0
  const elapsedMs = thinkingGroupElapsedMs(entries, thinkingElapsedByEntryId)
  const narrative = entries.some((entry) => (
    !entry.summary && thinkingSummaryEntryLabel(entry) === null
  ))
  const title = active
    ? <ThinkingStatus label={activeSummaryLabel ?? '正在思考'} />
    : elapsedMs === null ? '思考' : `思考了 ${formatDuration(elapsedMs)}`
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
  const showShortDetail = !active && showDetail && isSingleLineThinkingDetail(detailText)
  return (
    <li className={`process-step thinking ${narrative ? 'narrative' : 'summary'} ${status}`}>
      {showShortDetail ? (
        <div className="process-thinking short">
          <div className="process-thinking-detail">
            <MarkdownMessage
              text={detailText}
              streaming={entries.some((entry) => entry.streaming)}
            />
          </div>
          {elapsedMs === null ? null : (
            <span className="process-step-meta">{formatDuration(elapsedMs)}</span>
          )}
        </div>
      ) : showDetail ? (
        <details
          className="process-thinking"
          open={expanded}
          onToggle={(event) => setExpanded(event.currentTarget.open)}
        >
          <summary className="process-thinking-summary">
            <span className="process-thinking-title">{title}</span>
            <span className="process-thinking-expand" aria-hidden="true" />
          </summary>
          {expanded ? (
            <div className="process-thinking-detail">
              <MarkdownMessage
                text={detailText}
                streaming={entries.some((entry) => entry.streaming)}
              />
            </div>
          ) : null}
        </details>
      ) : (
        <div className="process-thinking">
          <div className="process-thinking-summary static">
            <span className="process-thinking-title">{title}</span>
          </div>
        </div>
      )}
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
  const askInteraction = useContext(AskToolInteractionContext)
  if (entry.ask !== undefined) {
    return (
      <li className="process-step tool ask running">
        <AskToolCard ask={entry.ask} entry={entry} interaction={askInteraction} />
      </li>
    )
  }
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
  const target = toolTarget(entry)
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
                <span className="process-step-code-target">{compactTarget(command)}</span>
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
              {file ? (
                <FileReference file={{ ...file, entry }} basenameOnly />
              ) : target.code ? (
                <span className="process-step-code-target">{target.text}</span>
              ) : target.text}
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
  target: ToolTargetPresentation
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
            {file ? (
              <FileReference file={{ ...file, entry }} basenameOnly />
            ) : target.code ? (
              <span className="process-step-code-target">{target.text}</span>
            ) : target.text}
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

function hasToolDetailContent(entry: KernelToolEntry): boolean {
  return entry.args.trim().length > 0 ||
    entry.output.trim().length > 0 ||
    entry.details.trim().length > 0 ||
    (entry.attachments?.length ?? 0) > 0 ||
    entry.truncated
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

  function closeViewer(): void {
    requestSequenceRef.current += 1
    setViewer(null)
  }

  useModalDialog({
    open: viewer !== null,
    dialogRef,
    initialFocus: () => closeButtonRef.current,
    onDismiss: closeViewer
  })

  useLayoutEffect(() => {
    requestSequenceRef.current += 1
    setViewer(null)
  }, [sessionKey, toolCallId, attachmentIdentity])

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
            if (event.target === event.currentTarget) closeViewer()
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
            tabIndex={-1}
          >
            <header className="message-image-viewer-header">
              <div className="message-image-viewer-copy">
                <h2 id={titleId}>{viewer.name}</h2>
              </div>
              <IconButton
                ref={closeButtonRef}
                className="message-image-viewer-close"
                icon="close"
                label="关闭图像预览"
                onClick={closeViewer}
              />
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
  file: ToolFileInfo & { entry: KernelToolEntry }
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

  function closeViewer(): void {
    setViewer(null)
  }

  useModalDialog({
    open: viewer !== null && attachments.length > 0,
    dialogRef,
    initialFocus: () => closeButtonRef.current,
    onDismiss: closeViewer
  })

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
            if (event.target === event.currentTarget) closeViewer()
          }}
        >
          <section
            ref={dialogRef}
            className="message-image-viewer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="message-image-viewer-title"
            aria-busy={viewer.status === 'loading' ? true : undefined}
            tabIndex={-1}
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
              <IconButton
                ref={closeButtonRef}
                className="message-image-viewer-close"
                icon="close"
                label="关闭图像预览"
                onClick={closeViewer}
              />
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

export function ThinkingStatus({
  label,
  target = null
}: {
  label: string
  target?: { prefix: string; value: string } | null
}): React.JSX.Element {
  return (
    <span className="thinking-status" aria-label={`Pi ${label}`} role="status">
      <span className="thinking-status-label activity-text-shimmer">
        {target === null ? label : (
          <>{target.prefix} <span className="thinking-status-code">{target.value}</span></>
        )}
      </span>
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

function transcriptTurnElapsedMs(
  user: KernelMessageEntry | null,
  responseEntries: KernelConversationEntry[]
): number | null {
  if (user === null) return null
  const finalAssistant = responseEntries.findLast((entry) =>
    entry.kind === 'message' &&
    entry.role === 'assistant' &&
    entry.phase !== 'commentary'
  )
  const terminalEntry = finalAssistant ?? responseEntries.at(-1)
  return terminalEntry === undefined ? null : Math.max(0, terminalEntry.timestamp - user.timestamp)
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

export type TurnHistoryPrompt = {
  turnId: string
  messageId: string
  text: string
}

export function turnHistoryPrompt(turn: ConversationTurn): TurnHistoryPrompt | null {
  const { user } = splitTurn(turn)
  if (user === null || user.text.trim().length === 0) return null
  if (user.attachments?.some((attachment) => attachment.type === 'image')) return null
  return { turnId: turn.id, messageId: user.id, text: user.text }
}

export function turnForkUserText(turn: ConversationTurn): string | null {
  return turnHistoryPrompt(turn)?.text ?? null
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
      if (isVisibleProcessEntry(entry)) processEntries.push(entry)
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

  const latestThinkingChunkIndex = chunks.findLastIndex(
    (chunk) => chunk.kind === 'process' && chunk.entries.some((entry) => entry.kind === 'thinking')
  )
  if (latestThinkingChunkIndex <= 0) return chunks
  return chunks.flatMap((chunk, chunkIndex) => {
    if (chunk.kind !== 'process' || chunkIndex >= latestThinkingChunkIndex) return [chunk]
    const visibleEntries = chunk.entries.filter((entry) => entry.kind !== 'thinking')
    return visibleEntries.length === 0 ? [] : [{ ...chunk, entries: visibleEntries }]
  })
}

export function isProcessEntry(entry: KernelConversationEntry): entry is ProcessEntry {
  return entry.kind === 'thinking' ||
    entry.kind === 'tool' ||
    (entry.kind === 'message' && entry.role === 'assistant' && entry.phase === 'commentary')
}

function isVisibleProcessEntry(entry: ProcessEntry): boolean {
  return entry.kind !== 'tool' || !isInternalSubagentCoordinationTool(entry)
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

function liveProcessStatusPresentation(entries: readonly KernelConversationEntry[]): {
  label: string
  target: { prefix: string; value: string } | null
} {
  const activeEntry = currentRunningEntry(entries)
  if (activeEntry?.kind === 'thinking') {
    return {
      label: latestThinkingSummaryLabel([activeEntry]) ?? '正在思考',
      target: null
    }
  }
  if (activeEntry?.kind === 'message') return { label: '正在继续', target: null }
  if (activeEntry?.kind === 'tool') {
    const file = toolFileInfo(activeEntry)
    if (file?.operation === 'read' || file?.operation === 'modify') {
      const prefix = file.operation === 'read' ? '正在阅读' : '正在修改'
      const value = fileBasename(file.path)
      return { label: `${prefix} ${value}`, target: { prefix, value } }
    }
    const coordination = subagentCoordinationToolPresentation(activeEntry)
    if (coordination !== null) return { label: coordination.text, target: null }
    if (compactToolName(activeEntry.name) === 'bash') {
      return { label: '正在运行命令', target: null }
    }
    const value = compactToolName(activeEntry.name)
    return {
      label: `正在调用 ${value}`,
      target: { prefix: '正在调用', value }
    }
  }
  return { label: latestThinkingSummaryLabel(entries) ?? '正在继续', target: null }
}

function isSingleLineThinkingDetail(text: string): boolean {
  return text.split(/\r?\n/u).filter((line) => line.trim().length > 0).length === 1
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

function toolTarget(entry: KernelToolEntry): ToolTargetPresentation {
  const args = parseToolArgs(entry.args)
  if (args !== null) {
    const target = stringArgument(args, ['command', 'path', 'file_path', 'query', 'url'])
    if (target !== null) return { text: compactTarget(target), code: true }
  }
  const first = entry.args.split('\n', 1)[0]?.trim()
  if (first && first !== '{' && first !== '[') {
    return { text: compactTarget(first), code: true }
  }
  return {
    text: compactToolName(entry.name) === 'bash' ? '命令' : '相关内容',
    code: false
  }
}

function compactTarget(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  if (normalized.length <= 96) return normalized
  return `${normalized.slice(0, 95)}…`
}
