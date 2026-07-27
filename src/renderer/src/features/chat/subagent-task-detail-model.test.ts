import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  KernelSubagentNoticeEntry,
  KernelSubagentParticipant,
  KernelToolEntry
} from '../../../../shared/kernel-contract.ts'
import {
  matchesSubagentTaskTrigger,
  reconcileSubagentTaskSelection,
  resolveSubagentTaskSelection,
  subagentTaskTriggerData,
  workbenchConversationIdentity,
  type SubagentTaskSelection
} from './subagent-task-detail-model.ts'

const conversationIdentity = workbenchConversationIdentity({
  activeProjectKey: '/tmp/project-a',
  displayedSessionKey: '/tmp/session-a.jsonl',
  viewingNewSession: false,
  archivedSessionKey: null
})

test('stable locator selects three participants and distinguishes repeated agent names by index', () => {
  const entries = [subagentTool([
    participant(0, 'reviewer', 'Inspect protocol'),
    participant(1, 'reviewer', 'Review UI'),
    participant(2, 'tester', 'Run checks')
  ])]

  for (const participantIndex of [0, 1, 2]) {
    const selection: SubagentTaskSelection = {
      conversationIdentity,
      kind: 'tool',
      toolCallId: 'subagent-call',
      participantIndex
    }
    const resolved = resolveSubagentTaskSelection(entries, conversationIdentity, selection)
    assert.equal(resolved?.participant.index, participantIndex)
  }

  assert.equal(
    resolveSubagentTaskSelection(entries, conversationIdentity, {
      conversationIdentity,
      kind: 'tool',
      toolCallId: 'subagent-call',
      participantIndex: 0
    })?.participant.task,
    'Inspect protocol'
  )
  assert.equal(
    resolveSubagentTaskSelection(entries, conversationIdentity, {
      conversationIdentity,
      kind: 'tool',
      toolCallId: 'subagent-call',
      participantIndex: 1
    })?.participant.task,
    'Review UI'
  )
})

test('trigger identity data matches only the same tool call and participant index', () => {
  const selection: SubagentTaskSelection = {
    conversationIdentity,
    kind: 'tool',
    toolCallId: 'subagent-call',
    participantIndex: 2
  }
  assert.deepEqual(subagentTaskTriggerData(selection), {
    kind: 'tool',
    toolCallId: 'subagent-call',
    participantIndex: '2'
  })
  assert.equal(matchesSubagentTaskTrigger(selection, {
    kind: 'tool',
    toolCallId: 'subagent-call',
    participantIndex: '2',
    noticeId: null
  }), true)
  assert.equal(matchesSubagentTaskTrigger(selection, {
    kind: 'tool',
    toolCallId: 'older-call',
    participantIndex: '2',
    noticeId: null
  }), false)
  assert.equal(matchesSubagentTaskTrigger(selection, {
    kind: 'tool',
    toolCallId: 'subagent-call',
    participantIndex: '1',
    noticeId: null
  }), false)
  assert.equal(matchesSubagentTaskTrigger(selection, {
    kind: null,
    toolCallId: null,
    participantIndex: null,
    noticeId: null
  }), false)
})

test('selection survives fresh participant snapshots and resolves the latest patched data', () => {
  const selection: SubagentTaskSelection = {
    conversationIdentity,
    kind: 'tool',
    toolCallId: 'subagent-call',
    participantIndex: 1
  }
  const initialParticipant = participant(1, 'reviewer', 'Review UI')
  const initialEntries = [subagentTool([
    participant(0, 'researcher', 'Inspect protocol'),
    initialParticipant
  ])]
  assert.equal(
    resolveSubagentTaskSelection(initialEntries, conversationIdentity, selection)?.participant,
    initialParticipant
  )

  const completedParticipant: KernelSubagentParticipant = {
    ...participant(1, 'reviewer', 'Review UI'),
    status: 'completed',
    currentTool: 'read',
    currentPath: '/tmp/project-a/src/App.tsx',
    turnCount: 3,
    toolCount: 4,
    tokens: 1250,
    durationMs: 2300,
    finalOutput: '**Review complete.**'
  }
  const patchedEntries = [subagentTool([
    completedParticipant,
    { ...participant(0, 'researcher', 'Inspect protocol'), status: 'completed' }
  ], 'run-after-patch')]

  assert.equal(
    reconcileSubagentTaskSelection(patchedEntries, conversationIdentity, selection),
    selection
  )
  const resolved = resolveSubagentTaskSelection(
    patchedEntries,
    conversationIdentity,
    selection
  )
  assert.equal(resolved?.participant, completedParticipant)
  assert.equal(resolved?.participant.status, 'completed')
  assert.equal(resolved?.participant.turnCount, 3)
  assert.equal(resolved?.participant.toolCount, 4)
  assert.equal(resolved?.participant.finalOutput, '**Review complete.**')
  assert.equal(resolved?.run?.runId, 'run-after-patch')
})

test('a completion notice resolves to a clickable detail without exposing its body inline', () => {
  const completion = participant(0, 'researcher', '后台任务结果')
  completion.status = 'completed'
  completion.finalOutput = 'Background task completed: **researcher**\n\nPrivate result.'
  const notice: KernelSubagentNoticeEntry = {
    id: 'subagent-notice:completion',
    kind: 'subagent-notice',
    noticeType: 'completion',
    text: completion.finalOutput,
    timestamp: 2,
    completion
  }
  const selection: SubagentTaskSelection = {
    conversationIdentity,
    kind: 'notice',
    noticeId: notice.id
  }

  const resolved = resolveSubagentTaskSelection([notice], conversationIdentity, selection)
  assert.equal(resolved?.entry, notice)
  assert.equal(resolved?.run, null)
  assert.equal(resolved?.participant, completion)
  assert.deepEqual(subagentTaskTriggerData(selection), {
    kind: 'notice',
    noticeId: notice.id
  })
  assert.equal(matchesSubagentTaskTrigger(selection, {
    kind: 'notice',
    toolCallId: null,
    participantIndex: null,
    noticeId: notice.id
  }), true)
})

test('conversation identity changes or a missing target clear the locator', () => {
  const entries = [subagentTool([participant(0, 'reviewer', 'Review UI')])]
  const selection: SubagentTaskSelection = {
    conversationIdentity,
    kind: 'tool',
    toolCallId: 'subagent-call',
    participantIndex: 0
  }
  const otherIdentity = workbenchConversationIdentity({
    activeProjectKey: '/tmp/project-a',
    displayedSessionKey: '/tmp/session-b.jsonl',
    viewingNewSession: false,
    archivedSessionKey: null
  })

  assert.equal(
    reconcileSubagentTaskSelection(entries, conversationIdentity, selection),
    selection
  )
  assert.equal(reconcileSubagentTaskSelection(entries, otherIdentity, selection), null)
  assert.equal(reconcileSubagentTaskSelection([], conversationIdentity, selection), null)
  assert.equal(
    reconcileSubagentTaskSelection(
      [subagentTool([participant(1, 'reviewer', 'Another task')])],
      conversationIdentity,
      selection
    ),
    null
  )
})

function subagentTool(
  participants: KernelSubagentParticipant[],
  runId: string | null = null
): KernelToolEntry {
  return {
    id: 'tool-entry:subagent-call',
    kind: 'tool',
    toolCallId: 'subagent-call',
    name: 'subagent',
    status: 'running',
    args: '',
    output: '',
    details: '',
    truncated: false,
    timestamp: 1,
    durationMs: null,
    subagent: {
      mode: 'parallel',
      runId,
      asyncId: null,
      participants
    }
  }
}

function participant(
  index: number,
  agent: string,
  task: string
): KernelSubagentParticipant {
  return {
    index,
    agent,
    status: 'running',
    task,
    currentTool: null,
    currentPath: null,
    toolCount: 0,
    turnCount: 0,
    tokens: 0,
    durationMs: 0,
    error: null,
    finalOutput: null
  }
}
