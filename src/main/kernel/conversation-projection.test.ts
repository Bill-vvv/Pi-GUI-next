import assert from 'node:assert/strict'
import test from 'node:test'
import {
  extractProjectedMessageImage,
  findUserMessageForImageLookup,
  materializePrompt
} from '../prompt/prompt-attachments.ts'
import {
  projectMessages,
  projectPiEvent,
  projectSessionEntries,
  projectTranscriptMessages
} from './conversation-projection.ts'

test('historical messages with matching roles and timestamps retain unique identities and order', () => {
  const entries = projectMessages([
    { role: 'user', content: 'First user', timestamp: 42 },
    { role: 'assistant', content: [{ type: 'text', text: 'First assistant' }], timestamp: 42 },
    { role: 'user', content: 'Second user', timestamp: 42 },
    { role: 'assistant', content: [{ type: 'text', text: 'Second assistant' }], timestamp: 42 }
  ])

  assert.equal(entries.length, 4)
  assert.equal(new Set(entries.map((entry) => entry.id)).size, 4)
  assert.deepEqual(
    entries.map((entry) => entry.kind === 'message' ? `${entry.role}:${entry.text}` : entry.kind),
    [
      'user:First user',
      'assistant:First assistant',
      'user:Second user',
      'assistant:Second assistant'
    ]
  )
})

test('transcript tail and full phases derive stable identities from canonical entry IDs', () => {
  const tailRecords = [
    { entryId: 'u2', message: { role: 'user', content: 'second', timestamp: 3 } },
    {
      entryId: 'a2',
      message: { role: 'assistant', content: [{ type: 'text', text: 'second reply' }], timestamp: 4 }
    }
  ]
  const tail = projectTranscriptMessages(tailRecords)
  const full = projectTranscriptMessages([
    { entryId: 'u1', message: { role: 'user', content: 'first', timestamp: 1 } },
    {
      entryId: 'a1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'first reply' }], timestamp: 2 }
    },
    ...tailRecords
  ])

  assert.deepEqual(tail.map(({ id }) => id), [
    'message:transcript:u2:user',
    'message:transcript:a2:assistant'
  ])
  assert.deepEqual(full.slice(-tail.length).map(({ id }) => id), tail.map(({ id }) => id))
})

test('historical mutable projection remains equivalent to immutable message projection', () => {
  const messages = [
    { role: 'user', content: 'Inspect and update.', timestamp: 100 },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Inspecting.' },
        { type: 'text', text: 'I will inspect the file.' },
        { type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: '/tmp/a' } }
      ],
      stopReason: 'toolUse',
      timestamp: 101
    },
    {
      role: 'toolResult',
      toolCallId: 'read-1',
      toolName: 'read',
      content: [{ type: 'text', text: 'file contents' }],
      timestamp: 102
    },
    {
      role: 'assistant',
      content: [{
        type: 'toolCall',
        id: 'todo-1',
        name: 'todowrite',
        arguments: { todos: [{ content: 'Update file', status: 'completed' }] }
      }],
      stopReason: 'toolUse',
      timestamp: 103
    },
    {
      role: 'toolResult',
      toolCallId: 'todo-1',
      toolName: 'todowrite',
      content: [{ type: 'text', text: 'Updated.' }],
      timestamp: 104
    },
    {
      role: 'custom',
      customType: 'subagent-notify',
      content: 'Background task completed: **reviewer**\n\nReview complete.',
      display: true,
      timestamp: 105
    },
    {
      role: 'custom',
      customType: 'pi-gui.multi-advisor/advisory',
      content: 'not projected',
      display: true,
      details: {
        protocolVersion: 2,
        advisorSlug: 'reviewer',
        advisorName: 'Reviewer',
        severity: 'concern',
        guidance: 'Check ordering.',
        note: 'Ordering is stable.',
        delivery: 'aside',
        timestamp: 106
      },
      timestamp: 106
    }
  ]

  const historical = projectMessages(messages)
  let immutable = [] as ReturnType<typeof projectMessages>
  for (const message of messages) {
    immutable = projectPiEvent(immutable, { type: 'message_end', message })
  }
  const withoutIdentity = (entries: ReturnType<typeof projectMessages>): unknown[] =>
    entries.map(({ id: _id, ...entry }) => entry)

  assert.deepEqual(withoutIdentity(historical), withoutIdentity(immutable))
})

test('historical tool updates retain first-seen positions across interleaved calls and results', () => {
  const entries = projectMessages([
    {
      role: 'assistant',
      content: [
        { type: 'toolCall', id: 'tool-a', name: 'read', arguments: { path: '/tmp/a' } },
        { type: 'text', text: 'Reading both files.' },
        { type: 'toolCall', id: 'tool-b', name: 'read', arguments: { path: '/tmp/b' } }
      ],
      timestamp: 200
    },
    {
      role: 'toolResult',
      toolCallId: 'tool-a',
      toolName: 'read',
      content: [{ type: 'text', text: 'A' }],
      timestamp: 201
    },
    {
      role: 'assistant',
      content: [
        { type: 'toolCall', id: 'tool-a', name: 'read', arguments: { path: '/tmp/a' } }
      ],
      timestamp: 202
    },
    {
      role: 'toolResult',
      toolCallId: 'tool-b',
      toolName: 'read',
      content: [{ type: 'text', text: 'B' }],
      timestamp: 203
    }
  ])

  assert.deepEqual(entries.map((entry) => entry.id), [
    'tool:tool-a',
    'message:history:0:assistant',
    'tool:tool-b'
  ])
  assert.deepEqual(
    entries.filter((entry) => entry.kind === 'tool').map(({ toolCallId, status, output }) => ({
      toolCallId,
      status,
      output
    })),
    [
      { toolCallId: 'tool-a', status: 'success', output: 'A' },
      { toolCallId: 'tool-b', status: 'success', output: 'B' }
    ]
  )
})

test('historical projection builders do not share arrays or entries across calls', () => {
  const messages = [{ role: 'user', content: 'Stable history', timestamp: 300 }]
  const first = projectMessages(messages)
  const firstSnapshot = structuredClone(first)
  const second = projectMessages(messages)

  assert.notEqual(first, second)
  assert.notEqual(first[0], second[0])
  second.pop()
  assert.deepEqual(first, firstSnapshot)
})

test('live assistant updates keep a stable identity and update in place', () => {
  const started = projectPiEvent([], {
    type: 'message_start',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Working' },
        { type: 'text', text: 'Hel' }
      ],
      timestamp: 7
    }
  })
  const startedSnapshot = structuredClone(started)
  const updated = projectPiEvent(started, {
    type: 'message_update',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Working' },
        { type: 'text', text: 'Hello' }
      ],
      timestamp: 7
    }
  })

  assert.equal(updated.length, 2)
  assert.notEqual(updated, started)
  assert.deepEqual(started, startedSnapshot)
  assert.deepEqual(updated.map((entry) => entry.id), started.map((entry) => entry.id))
  assert.equal(updated[0]?.kind === 'thinking' ? updated[0].text : null, 'Working')
  assert.equal(updated[0]?.kind === 'thinking' ? updated[0].summary : null, false)
  assert.equal(updated[1]?.kind === 'message' ? updated[1].text : null, 'Hello')
})

test('thinking signatures distinguish reasoning summaries from full thinking content', () => {
  const entries = projectMessages([
    {
      role: 'assistant',
      content: [
        {
          type: 'thinking',
          thinking: '**Planning the implementation**',
          thinkingSignature: JSON.stringify({
            type: 'reasoning',
            summary: [{ type: 'summary_text', text: 'Planning the implementation' }]
          })
        },
        { type: 'thinking', thinking: 'A full reasoning paragraph without a summary signature.' }
      ],
      timestamp: 8
    }
  ])

  const thinking = entries.filter((entry) => entry.kind === 'thinking')
  assert.deepEqual(thinking.map((entry) => entry.summary), [true, false])
})

test('assistant text phases are decoded and separate text blocks retain stable identities', () => {
  const signature = (id: string, phase: 'commentary' | 'final_answer'): string =>
    JSON.stringify({ v: 1, id, phase })
  const started = projectPiEvent([], {
    type: 'message_start',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'I will inspect the relevant files.',
          textSignature: signature('msg_commentary', 'commentary')
        },
        { type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: '/tmp/a' } },
        {
          type: 'text',
          text: 'The change is complete.',
          textSignature: signature('msg_final', 'final_answer')
        }
      ],
      timestamp: 9
    }
  })
  const updated = projectPiEvent(started, {
    type: 'message_update',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'I inspected the relevant files.',
          textSignature: signature('msg_commentary', 'commentary')
        },
        { type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: '/tmp/a' } },
        {
          type: 'text',
          text: 'The change is complete.',
          textSignature: signature('msg_final', 'final_answer')
        }
      ],
      timestamp: 9
    }
  })

  const messages = updated.filter((entry) => entry.kind === 'message')
  assert.deepEqual(messages.map(({ text, phase }) => ({ text, phase })), [
    { text: 'I inspected the relevant files.', phase: 'commentary' },
    { text: 'The change is complete.', phase: 'final_answer' }
  ])
  assert.deepEqual(updated.map((entry) => entry.id), started.map((entry) => entry.id))
})

test('user and unsigned assistant messages remain compatible without a phase', () => {
  const entries = projectMessages([
    { role: 'user', content: 'Question', timestamp: 11 },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Plain answer' },
        { type: 'text', text: 'Legacy answer', textSignature: 'legacy-response-id' }
      ],
      timestamp: 12
    }
  ])

  const messages = entries.filter((entry) => entry.kind === 'message')
  assert.deepEqual(messages.map(({ role, text, phase }) => ({ role, text, phase })), [
    { role: 'user', text: 'Question', phase: null },
    { role: 'assistant', text: 'Plain answer', phase: null },
    { role: 'assistant', text: 'Legacy answer', phase: null }
  ])
})

test('projects strict todowrite arguments for history and live tool events', () => {
  const input = {
    todos: [
      {
        id: 'inspect',
        content: ' Inspect the current Composer ',
        status: 'completed',
        priority: 'high',
        private: 'not projected'
      },
      {
        content: 'Implement the Todo panel',
        status: 'in_progress'
      }
    ],
    unrelated: 'not projected'
  }
  const historical = projectMessages([
    { role: 'user', content: 'Add a Todo panel.', timestamp: 17 },
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'todo-history', name: 'todowrite', arguments: input }],
      timestamp: 18
    },
    {
      role: 'toolResult',
      toolCallId: 'todo-history',
      toolName: 'todowrite',
      content: [{ type: 'text', text: 'Updated task list.' }],
      timestamp: 19
    }
  ])
  const historicalTool = historical.find((entry) => entry.kind === 'tool')
  assert.deepEqual(historicalTool?.kind === 'tool' ? historicalTool.todos : null, [
    {
      id: 'inspect',
      content: 'Inspect the current Composer',
      status: 'completed',
      priority: 'high'
    },
    {
      id: null,
      content: 'Implement the Todo panel',
      status: 'in_progress',
      priority: null
    }
  ])
  assert.equal(JSON.stringify(historicalTool).includes('private'), false)
  assert.equal(JSON.stringify(historicalTool).includes('unrelated'), false)

  const live = projectPiEvent([], {
    type: 'tool_execution_start',
    toolCallId: 'todo-live',
    toolName: 'functions.todowrite',
    args: input
  }, 20)
  const liveTool = live.find((entry) => entry.kind === 'tool')
  assert.deepEqual(
    liveTool?.kind === 'tool' ? liveTool.todos : null,
    historicalTool?.kind === 'tool' ? historicalTool.todos : null
  )

  for (const [index, toolName] of [
    'functions:todowrite',
    'functions/todowrite'
  ].entries()) {
    const namespaced = projectPiEvent([], {
      type: 'tool_execution_start',
      toolCallId: `todo-namespaced-${index}`,
      toolName,
      args: input
    }, 21 + index)
    const namespacedTool = namespaced.find((entry) => entry.kind === 'tool')
    assert.deepEqual(
      namespacedTool?.kind === 'tool' ? namespacedTool.todos : null,
      historicalTool?.kind === 'tool' ? historicalTool.todos : null
    )
  }
})

test('rejects malformed todowrite lists without exposing a partial projection', () => {
  const entries = projectPiEvent([], {
    type: 'tool_execution_start',
    toolCallId: 'todo-invalid',
    toolName: 'todowrite',
    args: {
      todos: [
        { content: 'Valid item', status: 'pending' },
        { content: 'Invalid item', status: 'unknown' }
      ]
    }
  })
  const tool = entries.find((entry) => entry.kind === 'tool')
  assert.equal(tool?.kind === 'tool' ? tool.todos : undefined, undefined)
})

test('historical tools without results settle as interrupted errors', () => {
  const entries = projectMessages([
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Running a command.' },
        { type: 'toolCall', id: 'call_abort', name: 'bash', arguments: { command: 'sleep 60' } }
      ],
      stopReason: 'toolUse',
      timestamp: 21
    }
  ])

  const tool = entries.find((entry) => entry.kind === 'tool')
  assert.equal(tool?.kind === 'tool' ? tool.status : null, 'error')
  assert.equal(tool?.kind === 'tool' ? tool.output : null, '已中止')
})

test('historical subagent participants settle as interrupted failures', () => {
  const entries = projectMessages([
    {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'subagent_abort',
          name: 'subagent',
          arguments: { agent: 'researcher', task: 'Inspect the protocol.' }
        }
      ],
      stopReason: 'toolUse',
      timestamp: 22
    }
  ])

  const tool = entries.find((entry) => entry.kind === 'tool')
  assert.equal(tool?.kind === 'tool' ? tool.subagent?.participants[0]?.status : null, 'failed')
  assert.equal(tool?.kind === 'tool' ? tool.subagent?.participants[0]?.error : null, '已中止')
})

test('projects structured subagent progress without exposing child transcripts', () => {
  const started = projectPiEvent([], {
    type: 'tool_execution_start',
    toolCallId: 'subagent-1',
    toolName: 'subagent',
    args: {
      tasks: [
        { agent: 'researcher', task: 'Inspect the protocol.' },
        { agent: 'reviewer', task: 'Review the UI boundary.' }
      ]
    }
  }, 100)
  const updated = projectPiEvent(started, {
    type: 'tool_execution_update',
    toolCallId: 'subagent-1',
    toolName: 'subagent',
    partialResult: {
      content: [{ type: 'text', text: '(running...)' }],
      details: {
        mode: 'parallel',
        runId: 'run-1',
        progress: [
          {
            index: 0,
            agent: 'researcher',
            status: 'running',
            task: 'Inspect the protocol.',
            currentTool: 'read',
            currentPath: '/tmp/protocol.ts',
            toolCount: 2,
            turnCount: 1,
            tokens: 1200,
            durationMs: 1500,
            recentOutput: ['private child transcript']
          },
          {
            index: 1,
            agent: 'reviewer',
            status: 'pending',
            task: 'Review the UI boundary.',
            toolCount: 0,
            tokens: 0,
            durationMs: 0
          }
        ],
        results: [
          {
            agent: 'researcher',
            model: 'vvqq-cpa/gpt-5.6-luna',
            usage: {
              input: 900,
              output: 300,
              cacheRead: 400,
              cacheWrite: 20,
              cost: 0.012,
              turns: 1
            },
            finalOutput: 'Protocol notes ready.'
          },
          {
            agent: 'reviewer',
            model: 'vvqq-cpa/gpt-5.6-sol',
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              cost: 0,
              turns: 0
            },
            finalOutput: 'UI review ready.'
          }
        ]
      }
    }
  }, 200)

  const tool = updated.find((entry) => entry.kind === 'tool')
  assert.equal(tool?.kind === 'tool' ? tool.subagent?.mode : null, 'parallel')
  assert.equal(tool?.kind === 'tool' ? tool.subagent?.runId : null, 'run-1')
  assert.deepEqual(tool?.kind === 'tool' ? tool.subagent?.participants : null, [
    {
      index: 0,
      agent: 'researcher',
      status: 'running',
      task: 'Inspect the protocol.',
      model: 'vvqq-cpa/gpt-5.6-luna',
      usage: {
        inputTokens: 900,
        outputTokens: 300,
        cacheReadTokens: 400,
        cacheWriteTokens: 20,
        costUsd: 0.012
      },
      currentTool: 'read',
      currentPath: '/tmp/protocol.ts',
      toolCount: 2,
      turnCount: 1,
      tokens: 1200,
      durationMs: 1500,
      error: null,
      finalOutput: 'Protocol notes ready.',
      outputReferences: []
    },
    {
      index: 1,
      agent: 'reviewer',
      status: 'pending',
      task: 'Review the UI boundary.',
      model: 'vvqq-cpa/gpt-5.6-sol',
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0
      },
      currentTool: null,
      currentPath: null,
      toolCount: 0,
      turnCount: 0,
      tokens: 0,
      durationMs: 0,
      error: null,
      finalOutput: 'UI review ready.',
      outputReferences: []
    }
  ])
  assert.equal(JSON.stringify(tool).includes('private child transcript'), false)
})

test('projects visible pi-subagents custom messages as dedicated notices', () => {
  const entries = projectMessages([
    {
      role: 'custom',
      customType: 'subagent-notify',
      content: 'Background task completed: **researcher**\n\nUI review ready.',
      display: true,
      timestamp: 200
    },
    {
      role: 'custom',
      customType: 'unrelated-extension',
      content: 'Do not project this custom message.',
      display: true,
      timestamp: 201
    },
    {
      role: 'custom',
      customType: 'subagent_control_notice',
      content: 'Reviewer needs attention.',
      display: true,
      timestamp: 202
    }
  ])

  assert.deepEqual(entries.map((entry) => entry.kind === 'subagent-notice'
    ? { kind: entry.kind, noticeType: entry.noticeType, text: entry.text }
    : entry.kind), [
    {
      kind: 'subagent-notice',
      noticeType: 'completion',
      text: 'UI review ready.'
    },
    {
      kind: 'subagent-notice',
      noticeType: 'control',
      text: 'Reviewer needs attention.'
    }
  ])
  const completion = entries.find((entry) =>
    entry.kind === 'subagent-notice' && entry.noticeType === 'completion'
  )
  assert.deepEqual(completion?.kind === 'subagent-notice' ? completion.completion : null, {
    index: 0,
    agent: 'researcher',
    status: 'completed',
    task: '后台任务',
    model: null,
    usage: null,
    currentTool: null,
    currentPath: null,
    toolCount: 0,
    turnCount: 0,
    tokens: 0,
    durationMs: 0,
    error: null,
    finalOutput: 'UI review ready.',
    outputReferences: []
  })
})

test('normalizes parallel background output references without exposing the completion envelope', () => {
  const content = [
    'Background task completed: **parallel:reviewer+reviewer+reviewer**',
    '',
    'reviewer: Output saved to: /tmp/s26-runtime-safety-review.md (4.5 KB, 11 lines). Read this file if needed.',
    '',
    'reviewer: Output saved to: /tmp/s26-ack-review.md (9.6 KB, 49 lines). Read this file if needed.',
    '',
    'reviewer: Output saved to: /tmp/s26-hibernate-ui-review.md (7.9 KB, 23 lines). Read this file if needed.',
    '',
    'Session file: /tmp/private-child-session/session.jsonl'
  ].join('\n')
  const entries = projectMessages([{
    role: 'custom',
    customType: 'subagent-notify',
    content,
    display: true,
    timestamp: 202.5
  }])
  const completion = entries[0]

  assert.equal(completion?.kind, 'subagent-notice')
  if (completion?.kind !== 'subagent-notice') return
  assert.equal(completion.text, '')
  assert.deepEqual(completion.completion, {
    index: 0,
    agent: 'parallel:reviewer+reviewer+reviewer',
    status: 'completed',
    task: '并行后台任务',
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
    outputReferences: [
      {
        agent: 'reviewer',
        path: '/tmp/s26-runtime-safety-review.md',
        sizeLabel: '4.5 KB',
        lines: 11
      },
      {
        agent: 'reviewer',
        path: '/tmp/s26-ack-review.md',
        sizeLabel: '9.6 KB',
        lines: 49
      },
      {
        agent: 'reviewer',
        path: '/tmp/s26-hibernate-ui-review.md',
        sizeLabel: '7.9 KB',
        lines: 23
      }
    ]
  })
  assert.equal(JSON.stringify(completion).includes('private-child-session'), false)
  assert.equal(JSON.stringify(completion).includes('Background task completed'), false)
})

test('coalesces repeated live Subagent completion lifecycle events by stable message identity', () => {
  const message = {
    role: 'custom',
    customType: 'subagent-notify',
    content: 'Background task completed: **parallel:explorer+reviewer**\n\nReview complete.',
    display: true,
    timestamp: 203
  }

  const started = projectPiEvent([], { type: 'message_start', message })
  const ended = projectPiEvent(started, { type: 'message_end', message })

  assert.equal(started.length, 1)
  assert.equal(ended.length, 1)
  assert.deepEqual(ended, [{
    id: 'subagent-notice:subagent-notify:203',
    kind: 'subagent-notice',
    noticeType: 'completion',
    text: 'Review complete.',
    timestamp: 203,
    completion: {
      index: 0,
      agent: 'parallel:explorer+reviewer',
      status: 'completed',
      task: '并行后台任务',
      model: null,
      usage: null,
      currentTool: null,
      currentPath: null,
      toolCount: 0,
      turnCount: 0,
      tokens: 0,
      durationMs: 0,
      error: null,
      finalOutput: 'Review complete.',
      outputReferences: []
    }
  }])
})

test('keeps separate historical Subagent notices even when timestamps match', () => {
  const message = {
    role: 'custom',
    customType: 'subagent-notify',
    content: 'Background task completed: **researcher**\n\nDone.',
    display: true,
    timestamp: 204
  }

  const entries = projectMessages([message, message])

  assert.deepEqual(entries.map((entry) => entry.id), [
    'subagent-notice:history:0',
    'subagent-notice:history:1'
  ])
})

test('coalesces structured Subagent attention into one supervisor request without protocol commands', () => {
  const control = {
    role: 'custom',
    customType: 'subagent_control_notice',
    content: [
      'Subagent needs attention: explorer',
      'Run: run-1 step 1',
      'Status: subagent({ action: "status", id: "run-1" })'
    ].join('\n'),
    display: true,
    details: {
      event: {
        type: 'needs_attention',
        runId: 'run-1',
        agent: 'explorer',
        index: 0,
        reason: 'supervisor_request',
        message: 'explorer is waiting for a supervisor reply'
      },
      privateField: 'must not be retained'
    },
    timestamp: 206
  }
  const request = {
    role: 'custom',
    customType: 'subagent_supervisor_request',
    content: [
      '请提供当前 git status --short。',
      '',
      'Reply with: subagent_supervisor({ action: "reply", replyTo: "request-1", message: "..." })'
    ].join('\n'),
    display: true,
    details: {
      id: 'request-1',
      reason: 'need_decision',
      expectsReply: true,
      runId: 'run-1',
      agent: 'explorer',
      childIndex: 0,
      privateField: 'must not be retained'
    },
    timestamp: 207
  }

  const entries = projectMessages([control, control, request, request])
  const notices = entries.filter((entry) => entry.kind === 'subagent-notice')
  assert.deepEqual(notices, [{
    id: 'subagent-notice:request:request-1',
    kind: 'subagent-notice',
    noticeType: 'request',
    text: '请提供当前 git status --short。',
    timestamp: 207,
    coordination: {
      runId: 'run-1',
      agent: 'explorer',
      participantIndex: 0,
      requestId: 'request-1',
      reason: 'need_decision',
      requiresReply: true,
      status: 'pending',
      resolvedAt: null
    }
  }])
  assert.equal(JSON.stringify(entries).includes('subagent({ action:'), false)
  assert.equal(JSON.stringify(entries).includes('privateField'), false)
})

test('projects large coordination-heavy history with stable order and resolved requests', () => {
  const runCount = 1_000
  const messages: unknown[] = []
  for (let index = 0; index < runCount; index += 1) {
    const runId = `run-large-${index}`
    const requestId = `request-large-${index}`
    const baseTimestamp = 10_000 + index * 6
    messages.push(
      {
        role: 'custom',
        customType: 'subagent_control_notice',
        content: `Generic notice ${index}`,
        display: true,
        details: {
          event: {
            type: 'needs_attention',
            runId,
            agent: 'explorer',
            index: 0,
            reason: 'completion_guard',
            message: `Generic notice ${index}`
          }
        },
        timestamp: baseTimestamp
      },
      {
        role: 'custom',
        customType: 'subagent_control_notice',
        content: `Supervisor notice ${index}`,
        display: true,
        details: {
          event: {
            type: 'needs_attention',
            runId,
            agent: 'explorer',
            index: 0,
            reason: 'supervisor_request',
            message: `Supervisor notice ${index}`
          }
        },
        timestamp: baseTimestamp + 1
      },
      {
        role: 'custom',
        customType: 'subagent_supervisor_request',
        content: `Request ${index}`,
        display: true,
        details: {
          id: requestId,
          reason: 'need_decision',
          expectsReply: true,
          runId,
          agent: 'explorer',
          childIndex: 0
        },
        timestamp: baseTimestamp + 2
      },
      {
        role: 'custom',
        customType: 'subagent_control_notice',
        content: `Late supervisor notice ${index}`,
        display: true,
        details: {
          event: {
            type: 'needs_attention',
            runId,
            agent: 'explorer',
            index: 0,
            reason: 'supervisor_request',
            message: `Late supervisor notice ${index}`
          }
        },
        timestamp: baseTimestamp + 3
      },
      {
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: `reply-large-${index}`,
          name: 'subagent_supervisor',
          arguments: {
            action: 'reply',
            replyTo: requestId,
            message: `Reply ${index}`
          }
        }],
        timestamp: baseTimestamp + 4
      },
      {
        role: 'toolResult',
        toolCallId: `reply-large-${index}`,
        toolName: 'subagent_supervisor',
        content: [{ type: 'text', text: 'Replied.' }],
        isError: false,
        timestamp: baseTimestamp + 5
      }
    )
  }

  const entries = projectMessages(messages)

  assert.equal(entries.length, runCount * 3)
  assert.deepEqual(entries.slice(0, 3).map((entry) => entry.id), [
    'subagent-notice:control:run-large-0:0:needs_attention:completion_guard',
    'subagent-notice:request:request-large-0',
    'tool:reply-large-0'
  ])
  assert.deepEqual(entries.slice(-3).map((entry) => entry.id), [
    `subagent-notice:control:run-large-${runCount - 1}:0:needs_attention:completion_guard`,
    `subagent-notice:request:request-large-${runCount - 1}`,
    `tool:reply-large-${runCount - 1}`
  ])
  const notices = entries.filter((entry) => entry.kind === 'subagent-notice')
  assert.equal(notices.some((entry) => entry.coordination?.reason === 'supervisor_request'), false)
  const requests = notices.filter((entry) => entry.noticeType === 'request')
  assert.equal(requests.length, runCount)
  assert.equal(requests.every((entry) => entry.coordination?.status === 'handled'), true)
  assert.equal(requests[0]?.coordination?.resolvedAt, 10_005)
  assert.equal(requests.at(-1)?.coordination?.resolvedAt, 10_005 + (runCount - 1) * 6)
})

test('marks a structured supervisor request handled after a successful reply tool result', () => {
  const entries = projectMessages([
    {
      role: 'custom',
      customType: 'subagent_supervisor_request',
      content: '请提供当前 Git 状态。',
      display: true,
      details: {
        id: 'request-2',
        reason: 'need_decision',
        expectsReply: true,
        runId: 'run-2',
        agent: 'explorer',
        childIndex: 0
      },
      timestamp: 208
    },
    {
      role: 'assistant',
      content: [{
        type: 'toolCall',
        id: 'reply-tool-1',
        name: 'subagent_supervisor',
        arguments: {
          action: 'reply',
          replyTo: 'request-2',
          message: '工作区状态已提供。'
        }
      }],
      timestamp: 209
    },
    {
      role: 'toolResult',
      toolCallId: 'reply-tool-1',
      toolName: 'subagent_supervisor',
      content: [{ type: 'text', text: 'Replied.' }],
      isError: false,
      timestamp: 210
    }
  ])
  const request = entries.find((entry) =>
    entry.kind === 'subagent-notice' && entry.noticeType === 'request'
  )
  assert.equal(request?.kind === 'subagent-notice' ? request.coordination?.status : null, 'handled')
  assert.equal(request?.kind === 'subagent-notice' ? request.coordination?.resolvedAt : null, 210)
})

test('keeps a structured supervisor request pending when the reply tool fails', () => {
  const entries = projectMessages([
    {
      role: 'custom',
      customType: 'subagent_supervisor_request',
      content: '请提供当前 Git 状态。',
      display: true,
      details: {
        id: 'request-3',
        reason: 'need_decision',
        expectsReply: true,
        runId: 'run-3',
        agent: 'explorer',
        childIndex: 0
      },
      timestamp: 211
    },
    {
      role: 'assistant',
      content: [{
        type: 'toolCall',
        id: 'reply-tool-2',
        name: 'subagent_supervisor',
        arguments: { action: 'reply', replyTo: 'request-3', message: '状态。' }
      }],
      timestamp: 212
    },
    {
      role: 'toolResult',
      toolCallId: 'reply-tool-2',
      toolName: 'subagent_supervisor',
      content: [{ type: 'text', text: 'Reply failed.' }],
      isError: true,
      timestamp: 213
    }
  ])
  const request = entries.find((entry) =>
    entry.kind === 'subagent-notice' && entry.noticeType === 'request'
  )
  assert.equal(request?.kind === 'subagent-notice' ? request.coordination?.status : null, 'pending')
  assert.equal(request?.kind === 'subagent-notice' ? request.coordination?.resolvedAt : undefined, null)
})

test('grouped Subagent completion preserves every original Agent name', () => {
  const entries = projectMessages([{
    role: 'custom',
    customType: 'subagent-notify',
    content: [
      'Background tasks completed (2): **researcher**, **reviewer** (2/2)',
      '',
      '1. researcher',
      'Research complete.',
      '',
      '2. reviewer (2/2)',
      'Review complete.'
    ].join('\n'),
    display: true,
    timestamp: 205
  }])
  const completion = entries.find((entry) =>
    entry.kind === 'subagent-notice' && entry.noticeType === 'completion'
  )

  assert.equal(
    completion?.kind === 'subagent-notice' ? completion.completion?.agent : null,
    'researcher、reviewer'
  )
})

test('projects additional pi-subagents command and watchdog messages without raw payloads', () => {
  const entries = projectMessages([
    {
      role: 'custom',
      customType: 'subagents-admin',
      content: 'Updated reviewer.',
      display: true,
      timestamp: 210
    },
    {
      role: 'custom',
      customType: 'subagent_watchdog_warning',
      content: '<subagent_watchdog>raw protocol text</subagent_watchdog>',
      display: true,
      details: {
        severity: 'blocker',
        summary: 'A required check is missing.',
        evidence: 'The build command was not run.',
        recommendedAction: 'Run the build before shipping.',
        privateField: 'must not be retained'
      },
      timestamp: 211
    },
    {
      role: 'custom',
      customType: 'subagent-slash-result',
      content: 'Running subagent...',
      display: true,
      details: { requestId: 'request-1', result: { isError: false } },
      timestamp: 212
    },
    {
      role: 'custom',
      customType: 'subagent-slash-result',
      content: '## Subagent result\n\nReview complete.',
      display: false,
      details: { requestId: 'request-1', result: { isError: false } },
      timestamp: 213
    }
  ])

  assert.deepEqual(entries.map((entry) => entry.kind === 'subagent-notice'
    ? { noticeType: entry.noticeType, text: entry.text }
    : entry.kind), [
    { noticeType: 'admin', text: 'Updated reviewer.' },
    {
      noticeType: 'watchdog-blocker',
      text: [
        'A required check is missing.',
        '**证据：** The build command was not run.',
        '**建议：** Run the build before shipping.'
      ].join('\n\n')
    },
    { noticeType: 'command', text: '## Subagent result\n\nReview complete.' }
  ])
  assert.equal(JSON.stringify(entries).includes('privateField'), false)
  assert.equal(JSON.stringify(entries).includes('raw protocol text'), false)
})

test('projects Magic Context status entries and public RPC status updates', () => {
  const appended = projectPiEvent([], {
    type: 'entry_appended',
    entry: {
      id: 'ctx-entry-1',
      parentId: null,
      type: 'custom',
      customType: 'ctx-status',
      timestamp: '2026-07-26T01:02:03.000Z',
      data: {
        title: 'Dream complete',
        text: 'Embedded 4 memories.',
        level: 'success',
        details: { private: 'not projected' }
      }
    }
  }, 10)
  const withStatus = projectPiEvent(appended, {
    type: 'extension_ui_request',
    method: 'setStatus',
    statusKey: 'magic-context',
    statusText: 'mc: 12.4k (19%) · idle'
  }, 20)

  assert.deepEqual(withStatus, [
    {
      id: 'magic-context:entry:ctx-entry-1',
      kind: 'extension-status',
      source: 'magic-context',
      title: 'Dream complete',
      text: 'Embedded 4 memories.',
      level: 'success',
      timestamp: Date.parse('2026-07-26T01:02:03.000Z')
    },
    {
      id: 'extension-status:magic-context',
      kind: 'extension-status',
      source: 'magic-context',
      title: 'Magic Context',
      text: 'mc: 12.4k (19%) · idle',
      level: 'info',
      timestamp: 20
    }
  ])
  assert.equal(JSON.stringify(withStatus).includes('private'), false)

  const cleared = projectPiEvent(withStatus, {
    type: 'extension_ui_request',
    method: 'setStatus',
    statusKey: 'magic-context'
  }, 30)
  assert.deepEqual(cleared, [withStatus[0]])
})

test('projects bounded Extension notifications and unsupported dialog requests', () => {
  const info = projectPiEvent([], {
    type: 'extension_ui_request',
    id: 'notify-info',
    method: 'notify',
    message: 'No todos yet.'
  }, 10)
  const warning = projectPiEvent(info, {
    type: 'extension_ui_request',
    id: 'notify-warning',
    method: 'notify',
    message: 'Profile is stale.',
    notifyType: 'warning'
  }, 20)
  const unsupported = projectPiEvent(warning, {
    type: 'extension_ui_request',
    id: 'dialog-confirm',
    method: 'confirm',
    title: 'Continue?',
    message: 'This requires a dialog.'
  }, 30)

  assert.deepEqual(unsupported, [
    {
      id: 'extension-notify:notify-info',
      kind: 'extension-status',
      source: 'extension',
      title: 'Extension 通知',
      text: 'No todos yet.',
      level: 'info',
      timestamp: 10
    },
    {
      id: 'extension-notify:notify-warning',
      kind: 'extension-status',
      source: 'extension',
      title: 'Extension 警告',
      text: 'Profile is stale.',
      level: 'warning',
      timestamp: 20
    },
    {
      id: 'error:extension-ui:dialog-confirm',
      kind: 'error',
      title: 'Extension UI 不受支持',
      message: 'Pi GUI 不支持 Extension 的 confirm 交互；请求已取消。',
      source: 'extension',
      timestamp: 30
    }
  ])

  assert.strictEqual(projectPiEvent(unsupported, {
    type: 'extension_ui_request',
    id: 'invalid-notify',
    method: 'notify',
    message: 'Hidden',
    notifyType: 'success'
  }, 40), unsupported)
})

test('projects only strict Magic Context custom entries from the active session path', () => {
  const projected = projectSessionEntries([
    {
      id: 'ctx-entry-1',
      parentId: null,
      type: 'custom',
      customType: 'ctx-status',
      timestamp: '2026-07-26T01:02:03.000Z',
      data: { title: 'Context flush', text: 'Flush complete.', level: 'info' }
    },
    {
      id: 'ctx-entry-2',
      parentId: 'ctx-entry-1',
      type: 'custom',
      customType: 'ctx-status',
      timestamp: 'invalid',
      data: { title: 'Invalid level', text: 'Must be dropped.', level: 'loud' }
    },
    {
      id: 'private-entry',
      parentId: 'ctx-entry-2',
      type: 'custom',
      timestamp: '2026-07-26T01:02:04.000Z'
    }
  ])

  assert.deepEqual(projected, [{
    id: 'magic-context:entry:ctx-entry-1',
    kind: 'extension-status',
    source: 'magic-context',
    title: 'Context flush',
    text: 'Flush complete.',
    level: 'info',
    timestamp: Date.parse('2026-07-26T01:02:03.000Z')
  }])
})

test('projects strict advisor advisories from history and live messages', () => {
  const advisory = {
    role: 'custom',
    customType: 'pi-gui.multi-advisor/advisory',
    content: '<advisor>must not be parsed</advisor>',
    display: true,
    details: {
      protocolVersion: 2,
      advisorSlug: 'security',
      advisorName: 'Security Advisor',
      severity: 'blocker',
      guidance: 'Resolve before shipping.',
      note: 'A credential is exposed.',
      delivery: 'steer',
      timestamp: 123
    },
    timestamp: 999
  }
  const historical = projectMessages([advisory])
  const live = projectPiEvent([], { type: 'message_end', message: advisory })

  assert.deepEqual(historical, [{
    id: 'advisor:history:0',
    kind: 'advisor',
    advisorSlug: 'security',
    advisorName: 'Security Advisor',
    severity: 'blocker',
    guidance: 'Resolve before shipping.',
    content: 'A credential is exposed.',
    delivery: 'steer',
    timestamp: 123
  }])
  assert.deepEqual(
    live.map(({ id: _id, ...entry }) => entry),
    historical.map(({ id: _id, ...entry }) => entry)
  )
})

test('ignores malformed advisor advisories and unknown custom messages', () => {
  const base = {
    role: 'custom',
    customType: 'pi-gui.multi-advisor/advisory',
    display: true,
    content: 'untrusted content',
    details: {
      protocolVersion: 1,
      advisorSlug: 'reviewer',
      advisorName: 'Reviewer',
      severity: 'concern',
      guidance: 'Check this.',
      note: 'Potential issue.',
      delivery: 'aside',
      timestamp: 42
    }
  }
  assert.deepEqual(projectMessages([
    { ...base, details: { ...base.details, timestamp: Number.NaN } },
    { ...base, details: { ...base.details, extra: 'unknown' } },
    { ...base, display: false },
    { ...base, customType: 'unknown-custom' }
  ]), [])
})

test('unsigned assistant text accompanying tool calls is projected as commentary', () => {
  const entries = projectMessages([
    {
      role: 'assistant',
      content: [
        {
          type: 'thinking',
          thinking: 'Inspect the project.',
          thinkingSignature: JSON.stringify({
            type: 'reasoning',
            summary: [{ type: 'summary_text', text: 'Inspect the project.' }]
          })
        },
        {
          type: 'text',
          text: '先查看项目入口。',
          textSignature: JSON.stringify({ v: 1, id: 'msg_tool_intro' })
        },
        { type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: '/tmp/a' } }
      ],
      stopReason: 'toolUse',
      timestamp: 13
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: '检查完成。',
          textSignature: JSON.stringify({ v: 1, id: 'msg_answer' })
        }
      ],
      stopReason: 'stop',
      timestamp: 14
    }
  ])

  const messages = entries.filter((entry) => entry.kind === 'message')
  assert.deepEqual(messages.map(({ text, phase }) => ({ text, phase })), [
    { text: '先查看项目入口。', phase: 'commentary' },
    { text: '检查完成。', phase: null }
  ])
})

test('materializes file path references without content and projects safe attachment summaries', () => {
  const image = { type: 'image' as const, mimeType: 'image/png', data: 'aGVsbG8=' }
  const file = {
    type: 'file' as const,
    name: 'notes.txt',
    path: '/tmp/project notes.txt'
  }
  const materialized = materializePrompt('Review these.', [
    file,
    {
      type: 'image',
      name: 'diagram.png',
      path: '/tmp/diagram.png',
      image,
      hints: ['[Image: original 4000x2000, displayed at 2000x1000.]']
    }
  ])

  assert.equal(
    materialized.message,
    '@"/tmp/project notes.txt"\n' +
      '<file name="/tmp/diagram.png">[Image: original 4000x2000, displayed at 2000x1000.]</file>\n' +
      'Review these.'
  )
  assert.deepEqual(materialized.images, [image])

  const [entry] = projectMessages([{
    role: 'user',
    content: [
      { type: 'text', text: materialized.message },
      image
    ],
    timestamp: 50
  }])
  assert.equal(entry?.kind === 'message' ? entry.text : null, 'Review these.')
  assert.deepEqual(entry?.kind === 'message' ? entry.attachments : null, [
    { type: 'file', name: 'project notes.txt', path: '/tmp/project notes.txt' },
    {
      type: 'image',
      name: 'diagram.png',
      path: '/tmp/diagram.png',
      hints: ['[Image: original 4000x2000, displayed at 2000x1000.]']
    }
  ])
  assert.equal(JSON.stringify(entry).includes('aGVsbG8='), false)
})

test('keeps ordinary file-like text and projects attachment-only image messages', () => {
  const ordinary = projectMessages([{
    role: 'user',
    content: 'Explain this:\n<file name="/tmp/example">ordinary prose</file>\n',
    timestamp: 60
  }])
  assert.equal(
    ordinary[0]?.kind === 'message' ? ordinary[0].text : null,
    'Explain this:\n<file name="/tmp/example">ordinary prose</file>\n'
  )

  const imageOnly = projectMessages([{
    role: 'user',
    content: [
      { type: 'text', text: '<file name="/tmp/photo.png"></file>\n' },
      { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }
    ],
    timestamp: 61
  }])
  assert.equal(imageOnly.length, 1)
  assert.equal(imageOnly[0]?.kind === 'message' ? imageOnly[0].text : null, '')
  assert.deepEqual(imageOnly[0]?.kind === 'message' ? imageOnly[0].attachments : null, [
    { type: 'image', name: 'photo.png', path: '/tmp/photo.png', hints: [] }
  ])
})

test('loads projected message images on demand without embedding base64 in history entries', () => {
  const image = { type: 'image' as const, mimeType: 'image/png', data: 'aGVsbG8=' }
  const messages = [{
    role: 'user',
    content: [
      {
        type: 'text',
        text: '<file name="/tmp/diagram.png">[Image: original 100x50, displayed at 50x25.]</file>\nReview'
      },
      image
    ],
    timestamp: 77
  }]
  const [entry] = projectMessages(messages)
  assert.equal(entry?.kind === 'message' ? entry.id : null, 'message:history:0:user')
  assert.equal(JSON.stringify(entry).includes('aGVsbG8='), false)

  const historical = findUserMessageForImageLookup(messages, 'message:history:0:user')
  assert.deepEqual(
    extractProjectedMessageImage(historical, 0),
    {
      mimeType: 'image/png',
      data: 'aGVsbG8=',
      name: 'diagram.png',
      path: '/tmp/diagram.png'
    }
  )

  const live = findUserMessageForImageLookup(messages, 'message:user:77')
  assert.equal(live, messages[0])
  assert.equal(extractProjectedMessageImage(live, 0).name, 'diagram.png')
})

const TOOL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test('projects live tool image metadata from update and end without base64', () => {
  let entries = projectPiEvent([], {
    type: 'tool_execution_start',
    toolCallId: 'img-1',
    toolName: 'generate_image',
    args: { prompt: 'cat' }
  }, 100)

  entries = projectPiEvent(entries, {
    type: 'tool_execution_update',
    toolCallId: 'img-1',
    toolName: 'generate_image',
    partialResult: {
      content: [
        { type: 'text', text: 'partial' },
        { type: 'image', mimeType: 'image/png', data: TOOL_PNG_BASE64 }
      ]
    }
  }, 110)

  const running = entries.find((entry) => entry.kind === 'tool')
  assert.equal(running?.kind, 'tool')
  if (running?.kind !== 'tool') return
  assert.equal(running.output, 'partial')
  assert.deepEqual(running.attachments, [{
    type: 'image',
    name: 'image-1',
    mimeType: 'image/png',
    byteLength: Buffer.from(TOOL_PNG_BASE64, 'base64').length,
    contentIndex: 1
  }])
  assert.equal(JSON.stringify(running).includes(TOOL_PNG_BASE64), false)

  // Empty partial must not erase image metadata.
  entries = projectPiEvent(entries, {
    type: 'tool_execution_update',
    toolCallId: 'img-1',
    toolName: 'generate_image',
    partialResult: { content: [{ type: 'text', text: 'partial more' }] }
  }, 115)
  const still = entries.find((entry) => entry.kind === 'tool')
  assert.equal(still?.kind === 'tool' ? still.attachments?.length : 0, 1)
  assert.equal(still?.kind === 'tool' ? still.output : null, 'partial more')

  entries = projectPiEvent(entries, {
    type: 'tool_execution_end',
    toolCallId: 'img-1',
    toolName: 'generate_image',
    isError: false,
    result: {
      content: [
        { type: 'text', text: 'final' },
        { type: 'image', mimeType: 'image/png', data: TOOL_PNG_BASE64 }
      ]
    }
  }, 120)

  const done = entries.find((entry) => entry.kind === 'tool')
  assert.equal(done?.kind === 'tool' ? done.status : null, 'success')
  assert.equal(done?.kind === 'tool' ? done.output : null, 'final')
  assert.equal(done?.kind === 'tool' ? done.attachments?.[0]?.contentIndex : null, 1)
  assert.equal(JSON.stringify(entries).includes(TOOL_PNG_BASE64), false)
})

test('terminal tool result ignores late start and update events', () => {
  let entries = projectPiEvent([], {
    type: 'tool_execution_end',
    toolCallId: 'late-img',
    toolName: 'generate_image',
    isError: false,
    result: {
      content: [
        { type: 'text', text: 'final' },
        { type: 'image', mimeType: 'image/png', data: TOOL_PNG_BASE64 }
      ]
    }
  }, 120)
  const terminal = entries

  entries = projectPiEvent(entries, {
    type: 'tool_execution_update',
    toolCallId: 'late-img',
    toolName: 'generate_image',
    partialResult: {
      content: [{ type: 'text', text: 'stale partial' }]
    }
  }, 130)
  assert.equal(entries, terminal)

  entries = projectPiEvent(entries, {
    type: 'tool_execution_start',
    toolCallId: 'late-img',
    toolName: 'generate_image',
    args: { prompt: 'stale' }
  }, 140)
  assert.equal(entries, terminal)
  const tool = entries.find((entry) => entry.kind === 'tool')
  assert.equal(tool?.kind === 'tool' ? tool.status : null, 'success')
  assert.equal(tool?.kind === 'tool' ? tool.output : null, 'final')
  assert.equal(tool?.kind === 'tool' ? tool.attachments?.[0]?.contentIndex : null, 1)
})

test('subagent tool results never project generic image attachments', () => {
  const entries = projectMessages([
    {
      role: 'assistant',
      content: [{
        type: 'toolCall',
        id: 'subagent-image',
        name: 'functions/subagent',
        arguments: { agent: 'worker' }
      }],
      timestamp: 10
    },
    {
      role: 'toolResult',
      toolCallId: 'subagent-image',
      toolName: 'functions/subagent',
      content: [{ type: 'image', mimeType: 'image/png', data: TOOL_PNG_BASE64 }],
      timestamp: 11
    }
  ])
  const tool = entries.find((entry) => entry.kind === 'tool')
  assert.equal(tool?.kind === 'tool' ? tool.attachments : null, undefined)
})

test('projects historical toolResult mixed content and ignores illegal images', () => {
  const entries = projectMessages([
    {
      role: 'assistant',
      content: [{
        type: 'toolCall',
        id: 'hist-img',
        name: 'generate_image',
        arguments: { prompt: 'dog' }
      }],
      timestamp: 10
    },
    {
      role: 'toolResult',
      toolCallId: 'hist-img',
      toolName: 'generate_image',
      content: [
        { type: 'text', text: 'ok' },
        { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
        { type: 'image', mimeType: 'image/png', data: TOOL_PNG_BASE64 }
      ],
      timestamp: 11
    }
  ])

  const tool = entries.find((entry) => entry.kind === 'tool')
  assert.equal(tool?.kind === 'tool' ? tool.toolCallId : null, 'hist-img')
  assert.equal(tool?.kind === 'tool' ? tool.output : null, 'ok')
  assert.equal(tool?.kind === 'tool' ? tool.attachments?.length : 0, 1)
  assert.equal(tool?.kind === 'tool' ? tool.attachments?.[0]?.contentIndex : null, 2)
  assert.equal(JSON.stringify(tool).includes(TOOL_PNG_BASE64), false)
  assert.equal(JSON.stringify(tool).includes('aGVsbG8='), false)
})
