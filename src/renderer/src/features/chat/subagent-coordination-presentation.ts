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
  if (coordination === undefined) return null
  const agent = coordination.agent.trim() || 'Subagent'

  if (coordination.status === 'handled') {
    return {
      title: `${agent} 已获得所需信息`,
      meta: '已处理',
      tone: 'quiet',
      role: 'status'
    }
  }

  if (entry.noticeType === 'request') {
    if (!coordination.requiresReply && coordination.reason === 'progress_update') {
      return {
        title: `${agent} 更新了协作进度`,
        meta: '进度',
        tone: 'quiet',
        role: 'status'
      }
    }
    return {
      title: `${agent} 等待主代理`,
      meta: '等待回复',
      tone: 'attention',
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

export function subagentCoordinationToolPresentation(
  entry: KernelToolEntry
): SubagentCoordinationToolPresentation | null {
  const name = toolLeafName(entry.name)
  const args = parseToolArgs(entry.args)

  if (name === 'subagent_wait') {
    return {
      text: statusText(entry, {
        running: '正在等待 Subagent',
        success: 'Subagent 等待已结束',
        error: '等待 Subagent 失败'
      }),
      groupLabel: '等待 Subagent'
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
    if (action === 'pending' || action === 'status' || action === 'list') {
      return {
        text: statusText(entry, {
          running: '正在检查 Subagent 请求',
          success: '已检查 Subagent 请求',
          error: '检查 Subagent 请求失败'
        }),
        groupLabel: '检查 Subagent 请求'
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

  if (name !== 'subagent') return null
  const action = stringValue(args?.action)
  const labels = action === 'status'
    ? ['正在检查 Subagent 状态', '已检查 Subagent 状态', '检查 Subagent 状态失败', '检查 Subagent 状态']
    : action === 'steer'
      ? ['正在调整 Subagent 任务', '已调整 Subagent 任务', '调整 Subagent 任务失败', '调整 Subagent 任务']
      : action === 'resume'
        ? ['正在继续 Subagent 任务', '已继续 Subagent 任务', '继续 Subagent 任务失败', '继续 Subagent 任务']
        : action === 'interrupt'
          ? ['正在暂停 Subagent 任务', '已暂停 Subagent 任务', '暂停 Subagent 任务失败', '暂停 Subagent 任务']
          : action === 'stop'
            ? ['正在停止 Subagent 任务', '已停止 Subagent 任务', '停止 Subagent 任务失败', '停止 Subagent 任务']
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
