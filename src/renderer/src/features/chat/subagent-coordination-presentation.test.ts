import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  KernelSubagentNoticeEntry,
  KernelToolEntry
} from '../../../../shared/kernel-contract.ts'
import {
  isInternalSubagentCoordinationTool,
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

test('omits structured supervisor request lifecycles from the Timeline', () => {
  assert.equal(subagentCoordinationNoticePresentation(requestNotice('pending')), null)
  assert.equal(subagentCoordinationNoticePresentation(requestNotice('handled')), null)
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

test('identifies internal Subagent polling that should not occupy the Timeline', () => {
  assert.equal(isInternalSubagentCoordinationTool(tool('subagent_wait', 'success')), true)
  assert.equal(isInternalSubagentCoordinationTool(tool('subagent', 'success', {
    action: 'list'
  })), true)
  assert.equal(isInternalSubagentCoordinationTool(tool('subagent', 'success', {
    action: 'status',
    id: 'run-1'
  })), true)
  assert.equal(isInternalSubagentCoordinationTool(tool('intercom', 'success', {
    action: 'pending'
  })), true)
  assert.equal(isInternalSubagentCoordinationTool(tool('subagent', 'success', {
    action: 'stop',
    id: 'run-1'
  })), false)
  assert.equal(isInternalSubagentCoordinationTool(tool('subagent_supervisor', 'success', {
    action: 'reply',
    replyTo: 'request-1',
    message: '状态已提供。'
  })), false)
})

test('only presents meaningful Subagent coordination tools', () => {
  assert.equal(
    subagentCoordinationToolPresentation(tool('subagent_wait', 'running', { all: true })),
    null
  )
  assert.equal(
    subagentCoordinationToolPresentation(tool('subagent', 'success', { action: 'list' })),
    null
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
      action: 'stop',
      id: 'run-1'
    })),
    { text: '已停止子任务', groupLabel: '停止子任务' }
  )
  assert.equal(subagentCoordinationToolPresentation(tool('read', 'success')), null)
})
