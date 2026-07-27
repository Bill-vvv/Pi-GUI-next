import { createContext, type Ref } from 'react'

import type {
  KernelSubagentNoticeEntry,
  KernelSubagentParticipant,
  KernelToolEntry
} from '../../../../shared/kernel-contract'
import { Icon } from '../../components/Icon'
import { MarkdownMessage } from './MarkdownMessage'
import {
  formatSubagentCount,
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
      aria-label={`查看 Subagent 任务：${label}`}
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
  panelRef,
  onClose
}: {
  entry: KernelToolEntry | KernelSubagentNoticeEntry
  participant: KernelSubagentParticipant
  panelRef?: Ref<HTMLElement>
  onClose: () => void
}): React.JSX.Element {
  const task = participant.task.trim() || '未提供任务说明'
  const status = subagentParticipantStatusLabel(participant.status)
  const hasActivity = participant.currentTool !== null || participant.currentPath !== null
  const hasError = participant.error !== null && participant.error.trim().length > 0
  const hasFinalOutput = participant.finalOutput !== null &&
    participant.finalOutput.trim().length > 0

  return (
    <aside
      className={`subagent-task-detail ${participant.status}`}
      id={SUBAGENT_TASK_DETAIL_ID}
      ref={panelRef}
      tabIndex={-1}
      aria-labelledby="subagent-task-detail-title"
    >
      <header className="subagent-task-detail-header">
        <button
          className="subagent-task-detail-back"
          type="button"
          onClick={onClose}
        >
          返回对话
        </button>
        <div className="subagent-task-detail-heading">
          <span className="subagent-task-detail-kicker">Subagent 任务</span>
          <h2 id="subagent-task-detail-title">{task}</h2>
          <p>
            <strong>{participant.agent}</strong>
            <span className={`subagent-task-detail-status ${participant.status}`}>{status}</span>
          </p>
        </div>
        <button
          className="subagent-task-detail-close"
          type="button"
          aria-label="关闭 Subagent 任务详情"
          onClick={onClose}
        >
          关闭
        </button>
      </header>

      <div className="subagent-task-detail-body stealth-scroll">
        <section className="subagent-task-detail-section" aria-labelledby="subagent-task-activity-title">
          <h3 id="subagent-task-activity-title">当前活动</h3>
          {hasActivity ? (
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
          ) : (
            <p className="subagent-task-detail-empty">
              {participant.status === 'pending'
                ? '正在等待任务开始。'
                : participant.status === 'running'
                  ? '当前没有工具或路径信息。'
                  : `任务状态：${status}。`}
            </p>
          )}
        </section>

        {entry.kind === 'tool' ? (
          <section className="subagent-task-detail-section" aria-labelledby="subagent-task-metrics-title">
            <h3 id="subagent-task-metrics-title">用量</h3>
            <dl className="subagent-task-metrics">
              <div><dt>轮次</dt><dd>{participant.turnCount}</dd></div>
              <div><dt>工具</dt><dd>{participant.toolCount}</dd></div>
              <div><dt>Token</dt><dd>{formatSubagentCount(participant.tokens)}</dd></div>
              <div><dt>耗时</dt><dd>{formatSubagentDuration(participant.durationMs)}</dd></div>
            </dl>
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
        ) : (
          <section className="subagent-task-detail-section" aria-labelledby="subagent-task-output-title">
            <h3 id="subagent-task-output-title">最终输出</h3>
            {hasFinalOutput ? (
              <div className="subagent-task-final-output">
                <MarkdownMessage text={participant.finalOutput!} streaming={false} />
              </div>
            ) : (
              <p className="subagent-task-detail-empty">
                {participant.status === 'running' || participant.status === 'pending'
                  ? '任务尚未产生最终输出。'
                  : '任务没有提供最终输出。'}
              </p>
            )}
          </section>
        )}

        {entry.kind === 'tool' && entry.truncated ? (
          <p className="subagent-task-detail-truncated">工具输出已截断。</p>
        ) : null}
      </div>
    </aside>
  )
}
