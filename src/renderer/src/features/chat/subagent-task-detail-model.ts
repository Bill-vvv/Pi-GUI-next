import { formatDuration } from '../../format-duration.ts'
import type {
  KernelConversationEntry,
  KernelSubagentNoticeEntry,
  KernelSubagentParticipant,
  KernelSubagentRun,
  KernelSubagentStatus,
  KernelToolEntry
} from '../../../../shared/kernel-contract'

export type SubagentTaskTarget =
  | {
      kind: 'tool'
      toolCallId: string
      participantIndex: number
    }
  | {
      kind: 'notice'
      noticeId: string
    }

export type SubagentTaskSelection = SubagentTaskTarget & {
  conversationIdentity: string
}

export const SUBAGENT_TASK_TRIGGER_SELECTOR = '[data-subagent-task-kind]'

export type SubagentTaskTriggerData = {
  kind: string | null
  toolCallId: string | null
  participantIndex: string | null
  noticeId: string | null
}

export function subagentTaskTriggerData(target: SubagentTaskTarget): {
  kind: SubagentTaskTarget['kind']
  toolCallId?: string
  participantIndex?: string
  noticeId?: string
} {
  return target.kind === 'tool'
    ? {
        kind: 'tool',
        toolCallId: target.toolCallId,
        participantIndex: String(target.participantIndex)
      }
    : { kind: 'notice', noticeId: target.noticeId }
}

export function matchesSubagentTaskTrigger(
  selection: SubagentTaskSelection,
  candidate: SubagentTaskTriggerData
): boolean {
  if (selection.kind !== candidate.kind) return false
  return selection.kind === 'tool'
    ? candidate.toolCallId === selection.toolCallId &&
      candidate.participantIndex === String(selection.participantIndex)
    : candidate.noticeId === selection.noticeId
}

export function matchesSubagentTaskTarget(
  selection: SubagentTaskSelection | null,
  target: SubagentTaskTarget
): boolean {
  if (selection === null || selection.kind !== target.kind) return false
  return target.kind === 'tool'
    ? selection.kind === 'tool' &&
      selection.toolCallId === target.toolCallId &&
      selection.participantIndex === target.participantIndex
    : selection.kind === 'notice' && selection.noticeId === target.noticeId
}

export type ResolvedSubagentTask = {
  entry: KernelToolEntry | KernelSubagentNoticeEntry
  run: KernelSubagentRun | null
  participant: KernelSubagentParticipant
}

export type WorkbenchConversationIdentityInput = {
  activeProjectKey: string | null
  displayedSessionKey: string | null
  viewingNewSession: boolean
  archivedSessionKey: string | null
}

export function workbenchConversationIdentity({
  activeProjectKey,
  displayedSessionKey,
  viewingNewSession,
  archivedSessionKey
}: WorkbenchConversationIdentityInput): string {
  const view = archivedSessionKey !== null
    ? `archived:${archivedSessionKey}`
    : viewingNewSession
      ? 'new-session'
      : `session:${displayedSessionKey ?? 'none'}`
  return JSON.stringify([activeProjectKey ?? 'no-project', view])
}

export function subagentTaskSelectionKey(selection: SubagentTaskSelection): string {
  return selection.kind === 'tool'
    ? JSON.stringify([
        selection.conversationIdentity,
        selection.kind,
        selection.toolCallId,
        selection.participantIndex
      ])
    : JSON.stringify([
        selection.conversationIdentity,
        selection.kind,
        selection.noticeId
      ])
}

export function resolveSubagentTaskSelection(
  entries: KernelConversationEntry[],
  displayedConversationIdentity: string,
  selection: SubagentTaskSelection | null
): ResolvedSubagentTask | null {
  if (
    selection === null ||
    selection.conversationIdentity !== displayedConversationIdentity
  ) return null

  if (selection.kind === 'notice') {
    const entry = entries.find((candidate): candidate is KernelSubagentNoticeEntry =>
      candidate.kind === 'subagent-notice' && candidate.id === selection.noticeId
    )
    return entry?.completion === undefined
      ? null
      : { entry, run: null, participant: entry.completion }
  }

  const entry = entries.find((candidate): candidate is KernelToolEntry =>
    candidate.kind === 'tool' && candidate.toolCallId === selection.toolCallId
  )
  const run = entry?.subagent ?? null
  if (entry === undefined || run === null) return null
  const participant = run.participants.find(
    (candidate) => candidate.index === selection.participantIndex
  )
  return participant === undefined ? null : { entry, run, participant }
}

export function reconcileSubagentTaskSelection(
  entries: KernelConversationEntry[],
  displayedConversationIdentity: string,
  selection: SubagentTaskSelection | null
): SubagentTaskSelection | null {
  return resolveSubagentTaskSelection(
    entries,
    displayedConversationIdentity,
    selection
  ) === null
    ? null
    : selection
}

export function subagentParticipantStatusLabel(status: KernelSubagentStatus): string {
  if (status === 'completed') return '完成'
  if (status === 'failed') return '失败'
  if (status === 'paused') return '已暂停'
  if (status === 'detached') return '后台运行'
  if (status === 'running') return '运行中'
  return '等待中'
}

export function subagentParticipantActivity(
  participant: KernelSubagentParticipant
): string | null {
  if (participant.currentTool && participant.currentPath) {
    return `${participant.currentTool} · ${participant.currentPath}`
  }
  if (participant.currentTool) return `正在调用 ${participant.currentTool}`
  if (participant.currentPath) return participant.currentPath
  return null
}

export function subagentParticipantLabel(participant: KernelSubagentParticipant): string {
  return participant.task.trim() || participant.agent
}

export function formatSubagentDuration(durationMs: number): string {
  return formatDuration(durationMs)
}
