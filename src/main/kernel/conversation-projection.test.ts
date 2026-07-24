import assert from 'node:assert/strict'
import test from 'node:test'
import { materializePrompt } from '../prompt/prompt-attachments.ts'
import { projectMessages, projectPiEvent } from './conversation-projection.ts'

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
