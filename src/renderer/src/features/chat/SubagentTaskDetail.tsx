import { createContext, type Ref } from 'react'

import type {
  AppearanceSettings,
  KernelSubagentNoticeEntry,
  KernelSubagentOutputReference,
  KernelSubagentParticipant,
  KernelToolEntry
} from '../../../../shared/kernel-contract'
import { Icon } from '../../components/Icon'
import { formatUsd } from '../../format-usd'
import { formatTokenCount } from '../../usage-formatters'
import { MarkdownMessage } from './MarkdownMessage'
import {
  formatSubagentDuration,
  subagentParticipantLabel,
  subagentParticipantStatusLabel,
  subagentTaskTriggerData,
  type SubagentTaskSelection,
  type SubagentTaskTarget
} from './subagent-task-detail-model'

export const SUBAGENT_TASK_DETAIL_ID = 'subagent-task-detail'

export type SubagentTaskInteraction = {
  selection: SubagentTaskSelection | null
  onOpen: (
    target: SubagentTaskTarget,
    trigger: HTMLButtonElement
  ) => void
}

export const SubagentTaskInteractionContext =
  createContext<SubagentTaskInteraction | null>(null)

export function SubagentTaskCapsule({
  target,
  participant,
  selected,
  onClick
}: {
  target: SubagentTaskTarget
  participant: KernelSubagentParticipant
  selected: boolean
  onClick: (trigger: HTMLButtonElement) => void
}): React.JSX.Element {
  const label = target.kind === 'notice'
    ? participant.agent.trim() || subagentParticipantLabel(participant)
    : subagentParticipantLabel(participant)
  const triggerData = subagentTaskTriggerData(target)
  return (
    <button
      className={`subagent-run-chip ${participant.status}${selected ? ' selected' : ''}`}
      type="button"
      aria-label={`查看子任务：${label}`}
      aria-pressed={selected}
      aria-controls={selected ? SUBAGENT_TASK_DETAIL_ID : undefined}
      data-selected={selected ? 'true' : undefined}
      data-subagent-task-kind={triggerData.kind}
      data-subagent-tool-call-id={triggerData.toolCallId}
      data-subagent-participant-index={triggerData.participantIndex}
      data-subagent-notice-id={triggerData.noticeId}
      data-tooltip={`${participant.agent}${participant.task ? ` · ${participant.task}` : ''}`}
      onClick={(event) => onClick(event.currentTarget)}
    >
      <span className="subagent-run-chip-icon">
        <Icon name="subagents" size="sm" />
      </span>
      <span className="subagent-run-chip-kind">Agent</span>
      <span className="subagent-run-chip-label">{label}</span>
    </button>
  )
}

export function SubagentTaskDetail({
  entry,
  participant,
  tokenCountFormat = 'full',
  panelRef
}: {
  entry: KernelToolEntry | KernelSubagentNoticeEntry
  participant: KernelSubagentParticipant
  tokenCountFormat?: AppearanceSettings['tokenCountFormat']
  panelRef?: Ref<HTMLElement>
}): React.JSX.Element {
  const task = participant.task.trim() || '未提供子任务说明'
  const status = subagentParticipantStatusLabel(participant.status)
  const agentLabel = entry.kind === 'subagent-notice'
    ? formatCompletionAgentLabel(participant.agent)
    : participant.agent
  const isActive = participant.status === 'pending' ||
    participant.status === 'running' ||
    participant.status === 'detached'
  const hasActivity = participant.currentTool !== null || participant.currentPath !== null
  const hasError = participant.error !== null && participant.error.trim().length > 0
  const hasFinalOutput = participant.finalOutput !== null &&
    participant.finalOutput.trim().length > 0
  const hasOutputReferences = participant.outputReferences.length > 0
  const shouldShowResult = !isActive && !hasError
  const outputTitle = hasOutputReferences && !hasFinalOutput
    ? '输出文件'
    : participant.status === 'paused'
      ? '已有输出'
      : '结果'
  const rawAgentIsTechnical = agentLabel !== participant.agent
  const hasRunSummary = entry.kind === 'tool' ||
    participant.model !== null ||
    participant.usage !== null ||
    participant.tokens > 0 ||
    participant.turnCount > 0 ||
    participant.toolCount > 0 ||
    participant.durationMs > 0

  return (
    <section
      className={`subagent-task-detail ${participant.status}`}
      id={SUBAGENT_TASK_DETAIL_ID}
      ref={panelRef}
      tabIndex={-1}
      aria-labelledby="subagent-task-detail-title"
    >
      <header className="subagent-task-detail-header">
        <div className="subagent-task-detail-heading">
          <span className="subagent-task-detail-kicker">
            {entry.kind === 'subagent-notice' ? '后台子任务' : '子任务'}
          </span>
          <h2 id="subagent-task-detail-title">{task}</h2>
          <p>
            <strong>{agentLabel}</strong>
            <span className={`subagent-task-detail-status ${participant.status}`}>{status}</span>
          </p>
        </div>
      </header>

      <div className="subagent-task-detail-body stealth-scroll">
        {isActive ? (
          <section className="subagent-task-detail-section" aria-labelledby="subagent-task-activity-title">
            <h3 id="subagent-task-activity-title">当前活动</h3>
            {hasActivity ? (
              <SubagentActivity participant={participant} />
            ) : (
              <p className="subagent-task-detail-empty">
                {participant.status === 'pending'
                  ? '正在等待子任务开始。'
                  : participant.status === 'detached'
                    ? '子任务已在后台运行，尚无活动详情。'
                    : '当前没有工具或路径信息。'}
              </p>
            )}
          </section>
        ) : null}

        {hasError ? (
          <section
            className="subagent-task-detail-section subagent-task-detail-error"
            aria-labelledby="subagent-task-error-title"
            role="alert"
          >
            <h3 id="subagent-task-error-title">错误</h3>
            <MarkdownMessage text={participant.error!} streaming={false} />
          </section>
        ) : null}

        {shouldShowResult ? (
          <section className="subagent-task-detail-section subagent-task-result" aria-labelledby="subagent-task-output-title">
            <h3 id="subagent-task-output-title">{outputTitle}</h3>
            {hasFinalOutput ? (
              <div className="subagent-task-final-output">
                <MarkdownMessage text={participant.finalOutput!} streaming={false} />
              </div>
            ) : null}
            {hasOutputReferences ? (
              <ul className="subagent-output-reference-list">
                {participant.outputReferences.map((reference, index) => (
                  <SubagentOutputReference
                    key={`${reference.agent ?? ''}:${reference.path}:${index}`}
                    reference={reference}
                  />
                ))}
              </ul>
            ) : null}
            {!hasFinalOutput && !hasOutputReferences ? (
              <p className="subagent-task-detail-empty">
                {participant.status === 'paused'
                  ? '子任务暂停前没有提供可读结果。'
                  : '子任务没有提供可读结果。'}
              </p>
            ) : null}
          </section>
        ) : null}

        {!isActive && hasActivity ? (
          <section className="subagent-task-detail-section" aria-labelledby="subagent-task-last-activity-title">
            <h3 id="subagent-task-last-activity-title">最后活动</h3>
            <SubagentActivity participant={participant} />
          </section>
        ) : null}

        {hasRunSummary ? (
          <section className="subagent-task-detail-section" aria-labelledby="subagent-task-summary-title">
            <h3 id="subagent-task-summary-title">运行摘要</h3>
            <dl className="subagent-task-summary">
              <div className="subagent-task-summary-model">
                <dt>模型</dt>
                <dd><code>{participant.model ?? '尚未报告'}</code></dd>
              </div>
              {participant.usage === null ? (
                <div>
                  <dt>消耗</dt>
                  <dd>
                    {participant.tokens > 0
                      ? `${formatTokenCount(participant.tokens, tokenCountFormat)} Token（费用未报告）`
                      : '尚未报告'}
                  </dd>
                </div>
              ) : (
                <>
                  <div><dt>输入 Token</dt><dd>{formatTokenCount(participant.usage.inputTokens, tokenCountFormat)}</dd></div>
                  <div><dt>输出 Token</dt><dd>{formatTokenCount(participant.usage.outputTokens, tokenCountFormat)}</dd></div>
                  <div><dt>缓存读取</dt><dd>{formatTokenCount(participant.usage.cacheReadTokens, tokenCountFormat)}</dd></div>
                  <div><dt>缓存写入</dt><dd>{formatTokenCount(participant.usage.cacheWriteTokens, tokenCountFormat)}</dd></div>
                  <div><dt>费用</dt><dd>{formatUsd(participant.usage.costUsd)}</dd></div>
                </>
              )}
              <div><dt>轮次</dt><dd>{participant.turnCount}</dd></div>
              <div><dt>工具</dt><dd>{participant.toolCount}</dd></div>
              <div><dt>耗时</dt><dd>{formatSubagentDuration(participant.durationMs)}</dd></div>
            </dl>
          </section>
        ) : null}

        {rawAgentIsTechnical ? (
          <details className="subagent-task-technical">
            <summary>技术信息</summary>
            <dl>
              <div>
                <dt>原始子任务标识</dt>
                <dd><code>{participant.agent}</code></dd>
              </div>
            </dl>
          </details>
        ) : null}

        {entry.kind === 'tool' && entry.truncated ? (
          <p className="subagent-task-detail-truncated">工具输出已截断。</p>
        ) : null}
      </div>
    </section>
  )
}

function SubagentActivity({
  participant
}: {
  participant: KernelSubagentParticipant
}): React.JSX.Element {
  return (
    <dl className="subagent-task-activity">
      {participant.currentTool === null ? null : (
        <div>
          <dt>工具</dt>
          <dd><code>{participant.currentTool}</code></dd>
        </div>
      )}
      {participant.currentPath === null ? null : (
        <div>
          <dt>路径</dt>
          <dd><code>{participant.currentPath}</code></dd>
        </div>
      )}
    </dl>
  )
}

function SubagentOutputReference({
  reference
}: {
  reference: KernelSubagentOutputReference
}): React.JSX.Element {
  const name = outputReferenceName(reference.path)
  const metadata = [
    reference.sizeLabel,
    reference.lines === null ? null : `${reference.lines} 行`
  ].filter((value): value is string => value !== null)
  return (
    <li>
      <div className="subagent-output-reference-copy">
        {reference.agent === null ? null : <span>{reference.agent}</span>}
        <code data-tooltip={reference.path}>{name}</code>
        {metadata.length === 0 ? null : <small>{metadata.join(' · ')}</small>}
      </div>
      <button
        type="button"
        aria-label={`打开输出文件：${name}`}
        onClick={() => openOutputReference(reference.path)}
      >
        打开
      </button>
    </li>
  )
}

function outputReferenceName(path: string): string {
  const slashIndex = path.lastIndexOf('/')
  return slashIndex >= 0 && slashIndex < path.length - 1
    ? path.slice(slashIndex + 1)
    : path
}

function openOutputReference(path: string): void {
  void window.piGui.openExternal(path).catch((error: unknown) => {
    console.error('Failed to open Subagent output reference.', error)
  })
}

function formatCompletionAgentLabel(agent: string): string {
  const parallel = agent.match(/^parallel:(.+)$/)
  if (parallel === null) return agent
  const agents = parallel[1]!.split('+').map((value) => value.trim()).filter(Boolean)
  if (agents.length === 0) return agent
  const counts = new Map<string, number>()
  for (const value of agents) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts.entries()]
    .map(([value, count]) => count === 1 ? value : `${value} ×${count}`)
    .join('、')
}
