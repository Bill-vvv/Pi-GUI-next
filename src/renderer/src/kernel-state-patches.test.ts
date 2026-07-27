import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  KernelConversationEntry,
  KernelState,
  KernelStatePatch,
  KernelToolEntryPatchMetadata
} from '../../shared/kernel-contract.ts'
import {
  appendProjectedText,
  applyStatePatches
} from './kernel/kernel-state-patches.ts'

test('state patches apply matching suffixes and preserve untouched entry identity', () => {
  const first = messageEntry('first', 'hello')
  const untouched = messageEntry('second', 'stable')
  const state = kernelState([first, untouched])
  const patch: KernelStatePatch = {
    projectKey: state.activeProjectKey,
    sessionKey: state.activeSessionKey,
    conversation: {
      entries: [{
        type: 'append-message-text',
        index: 0,
        from: 5,
        text: ' world',
        streaming: true,
        stopReason: null,
        error: null
      }]
    }
  }

  const next = applyStatePatches(state, [patch])

  assert.equal(next.conversation.entries[0]?.kind, 'message')
  assert.equal(
    next.conversation.entries[0]?.kind === 'message'
      ? next.conversation.entries[0].text
      : null,
    'hello world'
  )
  assert.equal(next.conversation.entries[1], untouched)
})

test('patches for another projection identity are ignored', () => {
  const state = kernelState([messageEntry('first', 'hello')])
  const next = applyStatePatches(state, [{
    projectKey: '/tmp/another-project',
    sessionKey: state.activeSessionKey,
    conversation: {
      entries: [{
        type: 'append-message-text',
        index: 0,
        from: 5,
        text: ' ignored',
        streaming: true,
        stopReason: null,
        error: null
      }]
    }
  }])

  assert.equal(next.conversation, state.conversation)
})

test('duplicate suffix delivery is idempotent but non-prefix append fails fast', () => {
  assert.equal(appendProjectedText('hello world', 5, ' world'), null)
  assert.equal(appendProjectedText('hello world', 11, ''), null)
  assert.throws(
    () => appendProjectedText('hello', 2, ' world'),
    /expected 2 characters; received 5/
  )
})

test('settled message and thinking snapshots ignore older empty-suffix metadata patches', () => {
  const message = {
    ...messageEntry('message', 'complete'),
    streaming: false,
    stopReason: 'stop'
  }
  const thinking: KernelConversationEntry = {
    id: 'thinking',
    kind: 'thinking',
    text: 'complete reasoning',
    summary: false,
    timestamp: 1,
    streaming: false
  }
  const state = kernelState([message, thinking])
  const next = applyStatePatches(state, [{
    projectKey: state.activeProjectKey,
    sessionKey: state.activeSessionKey,
    conversation: {
      entries: [
        {
          type: 'append-message-text',
          index: 0,
          from: message.text.length,
          text: '',
          streaming: true,
          stopReason: null,
          error: null
        },
        {
          type: 'append-thinking-text',
          index: 1,
          from: thinking.text.length,
          text: '',
          streaming: true
        }
      ]
    }
  }])

  assert.equal(next.conversation.entries[0], message)
  assert.equal(next.conversation.entries[1], thinking)
  assert.equal(message.streaming, false)
  assert.equal(message.stopReason, 'stop')
  assert.equal(thinking.streaming, false)
})

test('tool output growth updates metadata atomically and preserves entry identity fields', () => {
  const tool = subagentTool('running', 'partial')
  const untouched = messageEntry('second', 'stable')
  const state = kernelState([tool, untouched])
  const next = applyStatePatches(state, [{
    projectKey: state.activeProjectKey,
    sessionKey: state.activeSessionKey,
    conversation: {
      entries: [{
        type: 'append-tool-output',
        index: 0,
        toolCallId: tool.toolCallId,
        from: tool.output.length,
        output: ' output',
        status: 'success',
        details: '',
        truncated: false,
        durationMs: 2300,
        subagent: {
          ...tool.subagent!,
          participants: [{
            ...tool.subagent!.participants[0]!,
            status: 'completed',
            turnCount: 3,
            toolCount: 4,
            tokens: 1250,
            durationMs: 2300,
            finalOutput: '**Review complete.**'
          }]
        }
      }]
    }
  }])

  const patched = next.conversation.entries[0]
  assert.equal(patched?.kind, 'tool')
  if (patched?.kind === 'tool') {
    assert.equal(patched.id, tool.id)
    assert.equal(patched.toolCallId, tool.toolCallId)
    assert.equal(patched.output, 'partial output')
    assert.equal(patched.status, 'success')
    assert.equal(patched.subagent?.participants[0]?.status, 'completed')
    assert.equal(patched.subagent?.participants[0]?.finalOutput, '**Review complete.**')
  }
  assert.equal(next.conversation.entries[1], untouched)
})

test('tool metadata replacement applies only to its expected snapshot', () => {
  const running = subagentTool('running', 'stable output')
  const expected = toolMetadata(running)
  const participant = running.subagent!.participants[0]!
  const completed: KernelToolEntryPatchMetadata = {
    ...expected,
    status: 'success',
    durationMs: 2300,
    subagent: {
      ...running.subagent!,
      participants: [{
        ...participant,
        status: 'completed',
        currentTool: null,
        turnCount: 3,
        toolCount: 4,
        tokens: 1250,
        durationMs: 2300,
        finalOutput: 'Done.'
      }]
    }
  }
  const state = kernelState([running])
  const next = applyStatePatches(state, [{
    projectKey: state.activeProjectKey,
    sessionKey: state.activeSessionKey,
    conversation: {
      entries: [{
        type: 'replace-tool-metadata',
        index: 0,
        toolCallId: running.toolCallId,
        expectedOutputLength: running.output.length,
        expected,
        metadata: completed
      }]
    }
  }])

  const patched = next.conversation.entries[0]
  assert.equal(patched?.kind === 'tool' ? patched.output : null, 'stable output')
  assert.equal(patched?.kind === 'tool' ? patched.status : null, 'success')
  assert.equal(patched?.kind === 'tool' ? patched.subagent?.participants[0]?.status : null, 'completed')

  const staleRunning: KernelToolEntryPatchMetadata = {
    ...expected,
    subagent: {
      ...running.subagent!,
      participants: [{ ...participant, currentTool: 'grep', tokens: 250 }]
    }
  }
  const afterStale = applyStatePatches(next, [{
    projectKey: state.activeProjectKey,
    sessionKey: state.activeSessionKey,
    conversation: {
      entries: [{
        type: 'replace-tool-metadata',
        index: 0,
        toolCallId: running.toolCallId,
        expectedOutputLength: running.output.length,
        expected,
        metadata: staleRunning
      }]
    }
  }])

  assert.equal(afterStale.conversation.entries[0], patched)
  assert.equal(patched?.kind === 'tool' ? patched.status : null, 'success')
  assert.equal(patched?.kind === 'tool' ? patched.subagent?.participants[0]?.finalOutput : null, 'Done.')
})

test('a completed tool snapshot ignores an older duplicate running patch', () => {
  const completed = subagentTool('success', 'complete output')
  const completedParticipant = completed.subagent!.participants[0]!
  completed.subagent = {
    ...completed.subagent!,
    participants: [{
      ...completedParticipant,
      status: 'completed',
      finalOutput: 'Done.'
    }]
  }
  const state = kernelState([completed])
  const next = applyStatePatches(state, [{
    projectKey: state.activeProjectKey,
    sessionKey: state.activeSessionKey,
    conversation: {
      entries: [{
        type: 'append-tool-output',
        index: 0,
        toolCallId: completed.toolCallId,
        from: 0,
        output: 'complete output',
        status: 'running',
        details: '',
        truncated: false,
        durationMs: null,
        subagent: {
          ...completed.subagent!,
          participants: [{
            ...completedParticipant,
            status: 'running',
            finalOutput: null
          }]
        }
      }]
    }
  }])

  assert.equal(next.conversation.entries[0], completed)
  assert.equal(completed.status, 'success')
  assert.equal(completed.subagent?.participants[0]?.status, 'completed')
  assert.equal(completed.subagent?.participants[0]?.finalOutput, 'Done.')
})

test('tool patches reject a different toolCallId at the same index', () => {
  const tool = subagentTool('running', '')
  const state = kernelState([tool])
  assert.throws(
    () => applyStatePatches(state, [{
      projectKey: state.activeProjectKey,
      sessionKey: state.activeSessionKey,
      conversation: {
        entries: [{
          type: 'append-tool-output',
          index: 0,
          toolCallId: 'replacement-call',
          from: 0,
          output: 'new output',
          status: 'running',
          details: '',
          truncated: false,
          durationMs: null,
          subagent: null
        }]
      }
    }]),
    /tool patch identity mismatch/
  )
})

test('out-of-sequence inserts and entry-kind mismatches fail fast', () => {
  const state = kernelState([messageEntry('first', 'hello')])
  assert.throws(
    () => applyStatePatches(state, [{
      projectKey: state.activeProjectKey,
      sessionKey: state.activeSessionKey,
      conversation: {
        entries: [{
          type: 'insert',
          index: 0,
          entry: messageEntry('different', 'replacement')
        }]
      }
    }]),
    /insert index 0 is out of sequence/
  )
  assert.throws(
    () => applyStatePatches(state, [{
      projectKey: state.activeProjectKey,
      sessionKey: state.activeSessionKey,
      conversation: {
        entries: [{
          type: 'append-thinking-text',
          index: 0,
          from: 5,
          text: ' nope',
          streaming: true
        }]
      }
    }]),
    /thinking patch kind mismatch/
  )
})

function kernelState(entries: KernelConversationEntry[]): KernelState {
  return {
    activeProjectKey: '/tmp/project',
    activeSessionKey: '/tmp/session.jsonl',
    runtime: { status: 'running' },
    session: {},
    conversation: { entries, activeRunStartIndex: null }
  } as unknown as KernelState
}

function subagentTool(
  status: 'running' | 'success',
  output: string
): Extract<KernelConversationEntry, { kind: 'tool' }> {
  return {
    id: 'tool-entry:subagent-call',
    kind: 'tool',
    toolCallId: 'subagent-call',
    name: 'subagent',
    status,
    args: '',
    output,
    details: '',
    truncated: false,
    timestamp: 1,
    durationMs: status === 'success' ? 2300 : null,
    subagent: {
      mode: 'single',
      runId: 'run-1',
      asyncId: null,
      participants: [{
        index: 0,
        agent: 'reviewer',
        status: 'running',
        task: 'Review renderer',
        currentTool: 'read',
        currentPath: '/tmp/project/src/App.tsx',
        toolCount: 1,
        turnCount: 1,
        tokens: 100,
        durationMs: 1000,
        error: null,
        finalOutput: null
      }]
    }
  }
}

function toolMetadata(
  entry: Extract<KernelConversationEntry, { kind: 'tool' }>
): KernelToolEntryPatchMetadata {
  return {
    status: entry.status,
    details: entry.details,
    truncated: entry.truncated,
    durationMs: entry.durationMs,
    subagent: entry.subagent,
    todos: entry.todos,
    attachments: entry.attachments
  }
}

function messageEntry(
  id: string,
  text: string
): Extract<KernelConversationEntry, { kind: 'message' }> {
  return {
    id,
    kind: 'message',
    role: 'assistant',
    text,
    timestamp: 1,
    streaming: true,
    stopReason: null,
    error: null
  }
}
