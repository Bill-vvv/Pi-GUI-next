import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  KernelSubagentNoticeEntry,
  KernelToolEntry
} from '../../../../shared/kernel-contract.ts'
import {
  subagentCoordinationNoticePresentation,
  subagentCoordinationToolPresentation
} from './subagent-coordination-presentation.ts'

function requestNotice(status: 'pending' | 'handled'): KernelSubagentNoticeEntry {
  return {
    id: 'request-1',
    kind: 'subagent-notice',
    noticeType: 'request',
    text: '请提供 Git 状态。',
    timestamp: 1,
    coordination: {
      runId: 'run-1',
      agent: 'explorer',
      participantIndex: 0,
      requestId: 'request-1',
      reason: 'need_decision',
      requiresReply: true,
      status,
      resolvedAt: status === 'handled' ? 2 : null
    }
  }
}

function tool(
  name: string,
  status: KernelToolEntry['status'],
  args: Record<string, unknown> = {}
): KernelToolEntry {
  return {
    id: `tool:${name}`,
    kind: 'tool',
    toolCallId: name,
    name,
    status,
    args: JSON.stringify(args),
    output: '',
    details: '',
    truncated: false,
    timestamp: 1,
    durationMs: null,
    subagent: null
  }
}

test('presents supervisor requests as internal coordination rather than user alerts', () => {
  assert.deepEqual(subagentCoordinationNoticePresentation(requestNotice('pending')), {
    title: 'explorer 等待主代理',
    meta: '等待回复',
    tone: 'attention',
    role: 'status'
  })
  assert.deepEqual(subagentCoordinationNoticePresentation(requestNotice('handled')), {
    title: 'explorer 已获得所需信息',
    meta: '已处理',
    tone: 'quiet',
    role: 'status'
  })
})

test('reserves alert semantics for structured completion guards', () => {
  const notice = requestNotice('pending')
  notice.noticeType = 'control'
  notice.coordination = {
    ...notice.coordination!,
    requestId: null,
    reason: 'completion_guard',
    requiresReply: false
  }
  assert.deepEqual(subagentCoordinationNoticePresentation(notice), {
    title: 'explorer 无法继续',
    meta: '需要处理',
    tone: 'error',
    role: 'alert'
  })
})

test('uses concise labels for Subagent coordination tools', () => {
  assert.deepEqual(
    subagentCoordinationToolPresentation(tool('subagent_wait', 'running', { all: true })),
    { text: '正在等待 Subagent', groupLabel: '等待 Subagent' }
  )
  assert.deepEqual(
    subagentCoordinationToolPresentation(tool('subagent_supervisor', 'success', {
      action: 'reply',
      replyTo: 'request-1',
      message: '状态已提供。'
    })),
    { text: '已回复 Subagent 请求', groupLabel: '回复 Subagent 请求' }
  )
  assert.deepEqual(
    subagentCoordinationToolPresentation(tool('subagent', 'success', {
      action: 'status',
      id: 'run-1'
    })),
    { text: '已检查 Subagent 状态', groupLabel: '检查 Subagent 状态' }
  )
  assert.equal(subagentCoordinationToolPresentation(tool('read', 'success')), null)
})
