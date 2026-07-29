import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  KernelMessageEntry,
  KernelThinkingEntry,
  KernelToolEntry
} from '../../../../shared/kernel-contract.ts'
import {
  groupAdjacentThinking,
  standardProcessItems,
  standardToolSummaryParts,
  thinkingGroupDetailText,
  thinkingGroupElapsedMs,
  type ProcessEntry
} from './timeline-process-model.ts'

function thinking(
  id: string,
  text: string,
  streaming = false,
  summary = true
): KernelThinkingEntry {
  return {
    id,
    kind: 'thinking',
    text,
    summary,
    timestamp: 1,
    streaming
  }
}

function commentary(id: string, text: string): KernelMessageEntry & {
  role: 'assistant'
  phase: 'commentary'
} {
  return {
    id,
    kind: 'message',
    role: 'assistant',
    phase: 'commentary',
    text,
    timestamp: 1,
    streaming: false,
    stopReason: null,
    error: null
  }
}

function tool(
  id: string,
  name: string,
  status: KernelToolEntry['status'],
  args: Record<string, unknown> = {},
  extras: Partial<KernelToolEntry> = {}
): KernelToolEntry {
  return {
    id,
    kind: 'tool',
    toolCallId: id,
    name,
    status,
    args: JSON.stringify(args),
    output: extras.output ?? '',
    details: extras.details ?? '',
    truncated: extras.truncated ?? false,
    timestamp: 1,
    durationMs: extras.durationMs ?? null,
    subagent: extras.subagent ?? null,
    ask: extras.ask,
    todos: extras.todos,
    attachments: extras.attachments
  }
}

test('groups contiguous thinking entries and seals on any non-thinking process item', () => {
  const entries: ProcessEntry[] = [
    thinking('t1', '**First**'),
    thinking('t2', '**Second**'),
    commentary('c1', 'boundary'),
    thinking('t3', '**Third**'),
    tool('read-1', 'read', 'success', { path: '/tmp/a.ts' }),
    thinking('t4', '**Fourth**')
  ]

  assert.deepEqual(
    groupAdjacentThinking(entries).map((item) =>
      item.type === 'thinking-group'
        ? { type: item.type, ids: item.entries.map((entry) => entry.id) }
        : { type: item.type, id: item.entry.id }
    ),
    [
      { type: 'thinking-group', ids: ['t1', 't2'] },
      { type: 'entry', id: 'c1' },
      { type: 'thinking-group', ids: ['t3'] },
      { type: 'entry', id: 'read-1' },
      { type: 'thinking-group', ids: ['t4'] }
    ]
  )
})

test('hidden thinking does not break tool grouping while hidden tools flush boundaries', () => {
  const entries: ProcessEntry[] = [
    commentary('before', 'before'),
    tool('read-a', 'read', 'success', { path: '/tmp/a.ts' }),
    thinking('hidden-summary', '**Hidden stage**'),
    tool('edit-b', 'edit', 'success', { path: '/tmp/b.ts', edits: [{}] }),
    tool('ask-hidden', 'ask', 'running', {}, {
      ask: {
        questions: [],
        status: 'waiting',
        error: null
      }
    }),
    tool('bash-1', 'bash', 'running', { command: 'pnpm test' })
  ]
  const items = standardProcessItems(entries, new Set(['hidden-summary', 'ask-hidden']))

  assert.deepEqual(
    items.map((item) => {
      if (item.type === 'tool-group') {
        return { type: item.type, ids: item.entries.map((entry) => entry.id) }
      }
      if (item.type === 'thinking-group') {
        return { type: item.type, ids: item.entries.map((entry) => entry.id) }
      }
      return { type: item.type, id: item.entry.id }
    }),
    [
      { type: 'entry', id: 'before' },
      { type: 'tool-group', ids: ['read-a', 'edit-b'] },
      { type: 'tool-group', ids: ['bash-1'] }
    ]
  )
})

test('standard tool groups flush on ask, subagent, and coordination tools', () => {
  const entries: ProcessEntry[] = [
    tool('read-a', 'read', 'success', { path: '/tmp/a.ts' }),
    tool('ask-1', 'askuser', 'running', {}, {
      ask: {
        questions: [{
          id: 'q1',
          prompt: 'Choose',
          type: 'single',
          options: [],
          placeholder: null
        }],
        status: 'waiting',
        error: null
      }
    }),
    tool('read-b', 'read', 'success', { path: '/tmp/b.ts' }),
    tool('subagent-1', 'subagent', 'running', {}, {
      subagent: {
        mode: 'single',
        runId: 'run-1',
        asyncId: null,
        participants: [{
          index: 0,
          agent: 'explorer',
          status: 'running',
          task: 'inspect',
          model: null,
          usage: null,
          currentTool: null,
          currentPath: null,
          toolCount: 0,
          turnCount: 0,
          tokens: 0,
          durationMs: 0,
          error: null,
          finalOutput: null,
          outputReferences: []
        }]
      }
    }),
    tool('read-c', 'read', 'success', { path: '/tmp/c.ts' }),
    tool('reply-1', 'intercom', 'success', {
      action: 'reply',
      replyTo: 'request-1',
      message: '状态已提供。'
    }),
    tool('bash-1', 'bash', 'success', { command: 'true' })
  ]

  assert.deepEqual(
    standardProcessItems(entries).map((item) => {
      if (item.type === 'tool-group') {
        return { type: item.type, ids: item.entries.map((entry) => entry.id) }
      }
      if (item.type === 'thinking-group') {
        return { type: item.type, ids: item.entries.map((entry) => entry.id) }
      }
      return { type: item.type, id: item.entry.id }
    }),
    [
      { type: 'tool-group', ids: ['read-a'] },
      { type: 'entry', id: 'ask-1' },
      { type: 'tool-group', ids: ['read-b'] },
      { type: 'entry', id: 'subagent-1' },
      { type: 'tool-group', ids: ['read-c'] },
      { type: 'entry', id: 'reply-1' },
      { type: 'tool-group', ids: ['bash-1'] }
    ]
  )
})

test('standard file summary lists unique basenames and falls back to counts', () => {
  assert.deepEqual(
    standardToolSummaryParts([
      tool('read-a', 'read', 'success', { path: '/tmp/a.ts' }),
      tool('read-b', 'read', 'success', { path: '/tmp/b.ts' })
    ]),
    [{ action: '读取', detail: 'a.ts、b.ts', detailKind: 'code' }]
  )

  assert.deepEqual(
    standardToolSummaryParts([
      tool('read-a', 'read', 'success', { path: '/tmp/dir-a/same.ts' }),
      tool('read-b', 'read', 'success', { path: '/tmp/dir-b/same.ts' })
    ]),
    [{ action: '读取', detail: '2 个文件', detailKind: 'meta' }]
  )

  assert.deepEqual(
    standardToolSummaryParts([
      tool('read-a', 'read', 'success', { path: '/tmp/a.ts' }),
      tool('read-b', 'read', 'success', { path: '/tmp/b.ts' }),
      tool('read-c', 'read', 'success', { path: '/tmp/c.ts' })
    ]),
    [{ action: '读取', detail: '3 个文件', detailKind: 'meta' }]
  )
})

test('active tool summary uses progressive action verbs', () => {
  assert.deepEqual(
    standardToolSummaryParts([
      tool('read-a', 'read', 'success', { path: '/tmp/a.ts' }),
      tool('read-b', 'read', 'running', { path: '/tmp/b.ts' })
    ]),
    [{ action: '正在读取', detail: 'a.ts、b.ts', detailKind: 'code' }]
  )
  assert.deepEqual(
    standardToolSummaryParts([
      tool('edit-a', 'edit', 'running', { path: '/tmp/a.ts', edits: [{}] })
    ]),
    [{ action: '正在修改', detail: 'a.ts', detailKind: 'code' }]
  )
  assert.deepEqual(
    standardToolSummaryParts([
      tool('bash-1', 'bash', 'running', { command: 'pnpm typecheck' })
    ]),
    [{ action: '正在运行', detail: '1 条命令', detailKind: 'meta' }]
  )
  assert.deepEqual(
    standardToolSummaryParts([
      tool('grep-1', 'grep', 'running', { pattern: 'foo' })
    ]),
    [{ action: '正在调用', detail: '1 个工具', detailKind: 'meta' }]
  )
})

test('thinking detail removes the active summary line and keeps earlier blocks', () => {
  const entries = [
    thinking('first', '**Inspecting registration**\n\nKeep this reasoning.'),
    thinking('active', '**Inspecting registration**\n\n**Preparing the loader fix**', true)
  ]

  assert.equal(
    thinkingGroupDetailText(entries, 'Preparing the loader fix'),
    '**Inspecting registration**\n\nKeep this reasoning.\n\n**Inspecting registration**'
  )
  assert.equal(
    thinkingGroupDetailText([thinking('only', '**Preparing the loader fix**', true)], 'Preparing the loader fix'),
    ''
  )
})

test('thinking group elapsed uses the longest complete observation span', () => {
  const entries = [
    thinking('a', '**A**'),
    thinking('b', '**B**')
  ]
  assert.equal(
    thinkingGroupElapsedMs(entries, new Map([
      ['a', 3_200],
      ['b', 2_000]
    ])),
    3_200
  )
  assert.equal(
    thinkingGroupElapsedMs(entries, new Map([['a', 1_200]])),
    null
  )
})
