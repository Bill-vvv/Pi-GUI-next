import type {
  KernelSubagentNoticeEntry,
  KernelToolEntry
} from '../../../../shared/kernel-contract'

export type SubagentCoordinationNoticePresentation = {
  title: string
  meta: string
  tone: 'quiet' | 'attention' | 'error'
  role: 'status' | 'alert'
}

export type SubagentCoordinationToolPresentation = {
  text: string
  groupLabel: string
}

export function subagentCoordinationNoticePresentation(
  entry: KernelSubagentNoticeEntry
): SubagentCoordinationNoticePresentation | null {
  const coordination = entry.coordination
  if (coordination === undefined || entry.noticeType === 'request') return null
  const agent = coordination.agent.trim() || 'Subagent'

  if (coordination.status === 'handled') {
    return {
      title: `${agent} 已获得所需信息`,
      meta: '已处理',
      tone: 'quiet',
      role: 'status'
    }
  }

  if (coordination.reason === 'completion_guard') {
    return {
      title: `${agent} 无法继续`,
      meta: '需要处理',
      tone: 'error',
      role: 'alert'
    }
  }

  if (coordination.reason === 'active_long_running') {
    return {
      title: `${agent} 仍在运行`,
      meta: '耗时较长',
      tone: 'quiet',
      role: 'status'
    }
  }

  if (coordination.reason === 'supervisor_request') {
    return {
      title: `${agent} 等待主代理`,
      meta: '等待请求',
      tone: 'attention',
      role: 'status'
    }
  }

  return {
    title: `${agent} 需要主代理关注`,
    meta: '待处理',
    tone: 'attention',
    role: 'status'
  }
}

export function isInternalSubagentCoordinationTool(entry: KernelToolEntry): boolean {
  const name = toolLeafName(entry.name)
  const args = parseToolArgs(entry.args)
  if (name === 'subagent_wait' || name === 'tasklist' || name === 'taskwait') return true
  if (name === 'sessiontask') {
    const action = stringValue(args?.action)
    return action === 'list' || action === 'status' || action === 'result'
  }
  if (name === 'subagent') {
    const action = stringValue(args?.action)
    return action === 'list' || action === 'status'
  }
  if (name !== 'subagent_supervisor' && name !== 'intercom') return false
  const action = stringValue(args?.action)
  return action === 'pending' || action === 'status' || action === 'list'
}

export function subagentCoordinationToolPresentation(
  entry: KernelToolEntry
): SubagentCoordinationToolPresentation | null {
  if (isInternalSubagentCoordinationTool(entry)) return null
  const name = toolLeafName(entry.name)
  const args = parseToolArgs(entry.args)

  if (name === 'sessiontask') {
    const action = stringValue(args?.action)
    const labels = action === 'send'
      ? ['正在向其他对话发送消息', '已向其他对话发送消息', '发送对话消息失败', '发送对话消息']
      : action === 'spawn'
        ? ['正在创建后台对话任务', '已创建后台对话任务', '创建后台对话任务失败', '创建后台对话任务']
        : action === 'cancel'
          ? ['正在取消对话投递', '已取消对话投递', '取消对话投递失败', '取消对话投递']
          : null
    if (labels === null) return null
    return {
      text: statusText(entry, { running: labels[0]!, success: labels[1]!, error: labels[2]! }),
      groupLabel: labels[3]!
    }
  }

  if (name === 'subagent_supervisor' || name === 'intercom') {
    const action = stringValue(args?.action)
    if (action === 'reply') {
      return {
        text: statusText(entry, {
          running: '正在回复 Subagent 请求',
          success: '已回复 Subagent 请求',
          error: '回复 Subagent 请求失败'
        }),
        groupLabel: '回复 Subagent 请求'
      }
    }
    return {
      text: statusText(entry, {
        running: '正在处理 Subagent 协作',
        success: '已处理 Subagent 协作',
        error: '处理 Subagent 协作失败'
      }),
      groupLabel: '协调 Subagent'
    }
  }

  if (name !== 'subagent' && name !== 'taskstop') return null
  const action = name === 'taskstop' ? 'stop' : stringValue(args?.action)
  const labels = action === 'steer'
    ? ['正在调整子任务', '已调整子任务', '调整子任务失败', '调整子任务']
    : action === 'resume'
      ? ['正在继续子任务', '已继续子任务', '继续子任务失败', '继续子任务']
        : action === 'interrupt'
          ? ['正在暂停子任务', '已暂停子任务', '暂停子任务失败', '暂停子任务']
          : action === 'stop'
            ? ['正在停止子任务', '已停止子任务', '停止子任务失败', '停止子任务']
            : null
  if (labels === null) return null
  return {
    text: statusText(entry, {
      running: labels[0]!,
      success: labels[1]!,
      error: labels[2]!
    }),
    groupLabel: labels[3]!
  }
}

function statusText(
  entry: KernelToolEntry,
  labels: { running: string; success: string; error: string }
): string {
  if (entry.status === 'error') return labels.error
  if (entry.status === 'success') return labels.success
  return labels.running
}

function toolLeafName(value: string): string {
  return value.trim().toLowerCase().split(/[.:/]/u).at(-1) ?? ''
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

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function subagentNoticeTitle(noticeType: KernelSubagentNoticeEntry['noticeType']): string {
  if (noticeType === 'agent-message') return '其他对话消息'
  if (noticeType === 'completion') return 'Subagent 完成通知'
  if (noticeType === 'control') return 'Subagent 需要关注'
  if (noticeType === 'steering') return 'Subagent 调整通知'
  if (noticeType === 'request') return 'Subagent 请求'
  if (noticeType === 'admin') return 'Subagent 管理'
  if (noticeType === 'command') return 'Subagent 命令'
  if (noticeType === 'watchdog-blocker') return 'Subagent Watchdog · 阻断'
  return 'Subagent Watchdog · 关注'
}
