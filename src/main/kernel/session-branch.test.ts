import assert from 'node:assert/strict'
import test from 'node:test'

import type { PiRpcSessionEntry } from '../pi-rpc/pi-rpc-client.ts'
import {
  forkCandidatesOnActivePath,
  sessionEntriesOnActivePath
} from './session-branch.ts'

function entry(
  id: string,
  parentId: string | null,
  overrides: Partial<PiRpcSessionEntry> = {}
): PiRpcSessionEntry {
  return {
    id,
    parentId,
    type: 'message',
    timestamp: `2026-01-01T00:00:0${id.length}.000Z`,
    message: {
      role: 'user',
      content: { text: id, hasImage: false }
    },
    ...overrides
  }
}

test('returns the exact root-to-leaf active branch', () => {
  const root = entry('root', null)
  const active = entry('active', 'root')
  const leaf = entry('leaf', 'active')
  const abandoned = entry('abandoned', 'root')

  assert.deepEqual(
    sessionEntriesOnActivePath([abandoned, leaf, root, active], 'leaf'),
    [root, active, leaf]
  )
})

test('returns no active entries for a null leaf', () => {
  assert.deepEqual(sessionEntriesOnActivePath([entry('root', null)], null), [])
  assert.deepEqual(forkCandidatesOnActivePath([entry('root', null)], null), [])
})

test('fork candidates exclude abandoned branches, non-user messages, and images', () => {
  const root = entry('root', null)
  const assistant = entry('assistant', 'root', {
    message: {
      role: 'assistant',
      content: { text: 'answer', hasImage: false }
    }
  })
  const image = entry('image', 'assistant', {
    message: {
      role: 'user',
      content: { text: 'image prompt', hasImage: true }
    }
  })
  const eligible = entry('eligible', 'image', {
    timestamp: '2026-01-01T00:00:04.000Z',
    message: {
      role: 'user',
      content: { text: 'fork here', hasImage: false }
    }
  })
  const abandoned = entry('abandoned', 'root')

  assert.deepEqual(
    forkCandidatesOnActivePath([root, abandoned, assistant, image, eligible], 'eligible'),
    [
      {
        entryId: 'root',
        text: 'root',
        timestamp: root.timestamp
      },
      {
        entryId: 'eligible',
        text: 'fork here',
        timestamp: '2026-01-01T00:00:04.000Z'
      }
    ]
  )
})

test('rejects duplicate entry IDs', () => {
  assert.throws(
    () => sessionEntriesOnActivePath([entry('same', null), entry('same', null)], 'same'),
    /Runtime returned duplicate session entry ID: same/
  )
})

test('rejects a cycle on the active path', () => {
  assert.throws(
    () => sessionEntriesOnActivePath([entry('first', 'second'), entry('second', 'first')], 'first'),
    /Runtime returned a cyclic session entry path at: first/
  )
})

test('rejects a missing parent on the active path', () => {
  assert.throws(
    () => sessionEntriesOnActivePath([entry('leaf', 'missing')], 'leaf'),
    /Runtime active session path references a missing entry: missing/
  )
})
