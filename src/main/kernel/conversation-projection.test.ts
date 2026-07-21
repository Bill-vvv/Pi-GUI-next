import assert from 'node:assert/strict'
import test from 'node:test'
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
  assert.equal(updated[1]?.kind === 'message' ? updated[1].text : null, 'Hello')
})
